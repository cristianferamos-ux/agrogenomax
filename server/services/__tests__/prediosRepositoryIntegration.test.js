// SPRINT-3C1-MIS-PREDIOS-API §22/§24 + SPRINT-3C1.2 §2/§4: pruebas contra
// un Postgres/PostGIS REAL (Postgres-AGX-Business con RLS+FORCE ya
// aplicado) -- no mocks de aislamiento por organización.
//
// SPRINT-3C1.2 §2/§4: este archivo lee EXCLUSIVAMENTE
// `AGX_BUSINESS_DATABASE_URL_TEST` del ambiente para la conexión de
// aplicación -- NUNCA `AGX_BUSINESS_DATABASE_URL` (esa es la variable de
// producción/runtime real, la misma que server/db/agxBusinessPool.js lee
// en producción vía Railway). Un test local/CI jamás debe poder
// conectarse a producción por herencia accidental de entorno -- por eso
// la línea siguiente BORRA explícitamente cualquier `AGX_BUSINESS_DATABASE_URL`
// que ya existiera en el proceso ANTES de decidir si esta suite corre,
// y la única forma en que esa variable vuelve a existir en este proceso
// es como una asignación derivada 1:1 de `_TEST` (ver más abajo) -- nunca
// leída como fallback. Ningún hostname/contraseña/connection string real
// vive en este archivo -- todo viene del ambiente.
delete process.env.AGX_BUSINESS_DATABASE_URL;

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import pg from 'pg';

let dbAvailable = false;
let adminPool;
let repo;
let candidateStore;

try {
  const testConnectionString = process.env.AGX_BUSINESS_DATABASE_URL_TEST;
  // Distinta de AGX_BUSINESS_DATABASE_URL_TEST -- solo sirve para
  // sembrar/limpiar fixtures y para los escenarios de fallo transitorio
  // (revocar/restaurar el GRANT de agx_app), nunca para el código bajo
  // prueba. Nombre sin colisión con ninguna variable de producción real.
  const adminConnectionString = process.env.AGX_BUSINESS_INTEGRATION_ADMIN_DATABASE_URL;
  if (!testConnectionString || !adminConnectionString) {
    throw new Error('AGX_BUSINESS_DATABASE_URL_TEST/AGX_BUSINESS_INTEGRATION_ADMIN_DATABASE_URL no configuradas');
  }

  // Puente EXCLUSIVO de este proceso de test: server/db/agxBusinessPool.js
  // (código de producción, no modificado por este sprint) sigue leyendo
  // `AGX_BUSINESS_DATABASE_URL` internamente -- se la fijamos aquí,
  // derivada 1:1 de `_TEST`, nunca al revés.
  process.env.AGX_BUSINESS_DATABASE_URL = testConnectionString;

  const { getConfig } = await import('../../config/env.js');
  getConfig({ APP_ENV: 'development' }, {});

  adminPool = new pg.Pool({ connectionString: adminConnectionString, max: 2 });
  await adminPool.query('select 1');

  const tableCheck = await adminPool.query("select to_regclass('agx.predios') as t");
  dbAvailable = Boolean(tableCheck.rows[0]?.t);
} catch {
  dbAvailable = false;
}

if (dbAvailable) {
  repo = await import('../ganaderia/prediosRepository.js');
  candidateStore = await import('../ganaderia/prediosCandidateStore.js');
}

const SQUARE_RING = [
  [-75.5, 1.3],
  [-75.4, 1.3],
  [-75.4, 1.4],
  [-75.5, 1.4],
  [-75.5, 1.3],
];
const SQUARE_MULTIPOLYGON = { type: 'MultiPolygon', coordinates: [[SQUARE_RING]] };

function randomOrgId() {
  return crypto.randomUUID();
}

function predioFixture(overrides = {}) {
  return {
    codigoPredial: `18${crypto.randomInt(100000000, 999999999)}0000000000000000000`.slice(0, 30),
    codigoAnterior: null,
    nombrePredio: 'Finca Sprint3C1 Test',
    departamento: 'Caquetá',
    municipio: 'Florencia',
    vereda: 'El Recreo',
    sector: '01',
    areaM2: 50000,
    areaHa: 5,
    geometry: SQUARE_MULTIPOLYGON,
    fuente: 'catastrox_clean',
    versionFuente: '2026-01',
    fechaConsulta: new Date().toISOString(),
    ...overrides,
  };
}

describe('SPRINT-3C1-MIS-PREDIOS-API: prediosRepository contra Postgres-AGX-Business real', { skip: !dbAvailable }, () => {
  after(async () => {
    if (!adminPool) return;
    await adminPool.query(`delete from agx.predio_snapshots_catastrales where nombre_predio_catastral = 'Finca Sprint3C1 Test'`);
    await adminPool.query(`delete from agx.predios where nombre_predio = 'Finca Sprint3C1 Test'`);
    await adminPool.end();
  });

  test('§22 A: ORG A crea un predio, aparece en su propio listado', async () => {
    const orgA = randomOrgId();
    const predio = predioFixture();
    const geometryJson = JSON.stringify(predio.geometry);

    const predioId = await repo.createCatastroxPredio(orgA, { nombreFinal: predio.nombrePredio, predio, geometryJson });
    assert.ok(predioId);

    const listado = await repo.listPredios(orgA);
    assert.equal(listado.length, 1);
    assert.equal(String(listado[0].predio_id), String(predioId));
    assert.equal(listado[0].tiene_geometria, true);

    await adminPool.query('delete from agx.predio_snapshots_catastrales where predio_id = $1', [predioId]);
    await adminPool.query('delete from agx.predios where predio_id = $1', [predioId]);
  });

  test('§22 B: ORG B no ve el listado de ORG A (RLS real)', async () => {
    const orgA = randomOrgId();
    const orgB = randomOrgId();
    const predio = predioFixture();
    const geometryJson = JSON.stringify(predio.geometry);

    const predioId = await repo.createCatastroxPredio(orgA, { nombreFinal: predio.nombrePredio, predio, geometryJson });

    const listadoB = await repo.listPredios(orgB);
    assert.equal(listadoB.length, 0);

    const listadoA = await repo.listPredios(orgA);
    assert.equal(listadoA.length, 1);

    await adminPool.query('delete from agx.predio_snapshots_catastrales where predio_id = $1', [predioId]);
    await adminPool.query('delete from agx.predios where predio_id = $1', [predioId]);
  });

  test('§22 C: ORG B pide el detalle de un predio de ORG A -> null (equivalente a 404, nunca revela que existe)', async () => {
    const orgA = randomOrgId();
    const orgB = randomOrgId();
    const predio = predioFixture();
    const geometryJson = JSON.stringify(predio.geometry);

    const predioId = await repo.createCatastroxPredio(orgA, { nombreFinal: predio.nombrePredio, predio, geometryJson });

    const detailB = await repo.getPredioDetail(orgB, predioId);
    assert.equal(detailB, null);

    const detailA = await repo.getPredioDetail(orgA, predioId);
    assert.ok(detailA);
    assert.equal(String(detailA.predioRow.predio_id), String(predioId));
    assert.ok(detailA.snapshotRow, 'debe incluir el snapshot catastral más reciente');
    assert.equal(detailA.snapshotRow.codigo_predial, predio.codigoPredial);
    assert.deepEqual(detailA.predioRow.geometry, SQUARE_MULTIPOLYGON);

    await adminPool.query('delete from agx.predio_snapshots_catastrales where predio_id = $1', [predioId]);
    await adminPool.query('delete from agx.predios where predio_id = $1', [predioId]);
  });

  test('§17: mismo codigo_predial en la MISMA organización -> 409 DUPLICATE_CODIGO_PREDIAL', async () => {
    const orgA = randomOrgId();
    const predio = predioFixture();
    const geometryJson = JSON.stringify(predio.geometry);

    const predioId1 = await repo.createCatastroxPredio(orgA, { nombreFinal: predio.nombrePredio, predio, geometryJson });

    await assert.rejects(
      () => repo.createCatastroxPredio(orgA, { nombreFinal: predio.nombrePredio, predio, geometryJson }),
      (error) => error.status === 409 && error.code === 'DUPLICATE_CODIGO_PREDIAL',
    );

    await adminPool.query('delete from agx.predio_snapshots_catastrales where predio_id = $1', [predioId1]);
    await adminPool.query('delete from agx.predios where predio_id = $1', [predioId1]);
  });

  test('§17: mismo codigo_predial en OTRA organización -> permitido', async () => {
    const orgA = randomOrgId();
    const orgB = randomOrgId();
    const predio = predioFixture();
    const geometryJson = JSON.stringify(predio.geometry);

    const predioIdA = await repo.createCatastroxPredio(orgA, { nombreFinal: predio.nombrePredio, predio, geometryJson });
    const predioIdB = await repo.createCatastroxPredio(orgB, { nombreFinal: predio.nombrePredio, predio, geometryJson });

    assert.notEqual(String(predioIdA), String(predioIdB));

    await adminPool.query('delete from agx.predio_snapshots_catastrales where predio_id = any($1)', [[predioIdA, predioIdB]]);
    await adminPool.query('delete from agx.predios where predio_id = any($1)', [[predioIdA, predioIdB]]);
  });

  test('§18/§24: si el INSERT del snapshot falla, el predio NO queda creado (rollback real)', async () => {
    const orgA = randomOrgId();
    // fuente es NOT NULL en agx.predio_snapshots_catastrales -- forzar el
    // fallo real del INSERT del snapshot sin tocar código de producción.
    const predio = predioFixture({ fuente: null });
    const geometryJson = JSON.stringify(predio.geometry);

    const countAntes = (await adminPool.query('select count(*) from agx.predios')).rows[0].count;

    await assert.rejects(() => repo.createCatastroxPredio(orgA, { nombreFinal: predio.nombrePredio, predio, geometryJson }));

    const countDespues = (await adminPool.query('select count(*) from agx.predios')).rows[0].count;
    assert.equal(countDespues, countAntes, 'el INSERT de predios debe revertirse si el snapshot falla');

    const listado = await repo.listPredios(orgA);
    assert.equal(listado.length, 0);
  });

  test('registro manual: sin geometry, sin snapshot, codigo_predial null', async () => {
    const orgA = randomOrgId();
    const predioId = await repo.createManualPredio(orgA, {
      nombrePredio: 'Finca Sprint3C1 Test',
      departamento: 'Caquetá',
      municipio: 'Florencia',
      vereda: null,
      areaTotalHa: null,
      latitud: null,
      longitud: null,
    });

    const detail = await repo.getPredioDetail(orgA, predioId);
    assert.ok(detail);
    assert.equal(detail.predioRow.geometry, null);
    assert.equal(detail.predioRow.codigo_predial, null);
    assert.equal(detail.snapshotRow, null);

    await adminPool.query('delete from agx.predios where predio_id = $1', [predioId]);
  });

  // -----------------------------------------------------------------
  // SPRINT-3C1.1 §3: candidate state machine + retry/concurrencia
  // contra el repositorio y la transacción REALES (no mocks).
  // -----------------------------------------------------------------

  test('§3 A/B: reserve -> falla el INSERT del snapshot (permiso revocado transitoriamente) -> release -> reintento con el MISMO candidate -> éxito, CONSUMED', async () => {
    const orgA = randomOrgId();
    const predio = predioFixture();
    const geometryJson = JSON.stringify(predio.geometry);
    const candidateId = candidateStore.createPredioCandidate({ organizacionId: orgA, cuentaId: 'cuenta-a', predio });

    // Intento 1: reserve() pasa a PROCESSING, luego forzamos un fallo REAL
    // del INSERT del snapshot revocando el grant de agx_app -- transitorio
    // y externo al candidate (no a su contenido), exactamente el tipo de
    // fallo que debe permitir un reintento con el mismo candidateId.
    const reserved1 = candidateStore.reservePredioCandidate({ candidateId, organizacionId: orgA, cuentaId: 'cuenta-a' });
    assert.equal(reserved1.status, 'ok');

    await adminPool.query('revoke insert on agx.predio_snapshots_catastrales from agx_app');
    const countAntes = (await adminPool.query('select count(*) from agx.predios')).rows[0].count;

    let predioId1;
    try {
      await assert.rejects(() =>
        repo.createCatastroxPredio(orgA, { nombreFinal: predio.nombrePredio, predio, geometryJson }),
      );
    } finally {
      await adminPool.query('grant insert on agx.predio_snapshots_catastrales to agx_app');
    }

    const countDespues = (await adminPool.query('select count(*) from agx.predios')).rows[0].count;
    assert.equal(countDespues, countAntes, 'A: el INSERT de predios debe revertirse');

    candidateStore.releasePredioCandidate(candidateId);
    assert.equal(candidateStore.__getPredioCandidateStateForTests(candidateId), 'AVAILABLE', 'A: el candidate debe volver a AVAILABLE tras el fallo');

    // Intento 2 (B): mismo candidateId, ahora con el grant restaurado ->
    // debe reservarse y completarse con éxito.
    const reserved2 = candidateStore.reservePredioCandidate({ candidateId, organizacionId: orgA, cuentaId: 'cuenta-a' });
    assert.equal(reserved2.status, 'ok', 'B: el mismo candidate debe seguir siendo utilizable');

    predioId1 = await repo.createCatastroxPredio(orgA, { nombreFinal: predio.nombrePredio, predio, geometryJson });
    candidateStore.commitPredioCandidate(candidateId);

    assert.equal(candidateStore.__getPredioCandidateStateForTests(candidateId), 'CONSUMED', 'B: tras el éxito el candidate queda CONSUMED');

    const listado = await repo.listPredios(orgA);
    assert.equal(listado.length, 1, 'B: exactamente un predio creado, sin duplicados por el reintento');

    await adminPool.query('delete from agx.predio_snapshots_catastrales where predio_id = $1', [predioId1]);
    await adminPool.query('delete from agx.predios where predio_id = $1', [predioId1]);
  });

  test('§3 C: dos reservas concurrentes sobre el mismo candidate -> solo una procesa la transacción real, nunca se crean dos predios', async () => {
    const orgA = randomOrgId();
    const predio = predioFixture();
    const geometryJson = JSON.stringify(predio.geometry);
    const candidateId = candidateStore.createPredioCandidate({ organizacionId: orgA, cuentaId: 'cuenta-a', predio });

    // Simula dos solicitudes HTTP llegando "al mismo tiempo": ambas
    // ejecutan reservePredioCandidate() (síncrono, sin await) antes de que
    // ninguna alcance a abrir su transacción DB.
    const winner = candidateStore.reservePredioCandidate({ candidateId, organizacionId: orgA, cuentaId: 'cuenta-a' });
    const loser = candidateStore.reservePredioCandidate({ candidateId, organizacionId: orgA, cuentaId: 'cuenta-a' });

    assert.equal(winner.status, 'ok');
    assert.equal(loser.status, 'in_use', 'la segunda solicitud concurrente debe rechazarse, nunca procesar en paralelo');

    // Solo el ganador continúa hacia la transacción de negocio real.
    const predioId = await repo.createCatastroxPredio(orgA, { nombreFinal: predio.nombrePredio, predio, geometryJson });
    candidateStore.commitPredioCandidate(candidateId);

    const listado = await repo.listPredios(orgA);
    assert.equal(listado.length, 1, 'nunca se crean dos predios a partir de la misma reserva concurrente');

    await adminPool.query('delete from agx.predio_snapshots_catastrales where predio_id = $1', [predioId]);
    await adminPool.query('delete from agx.predios where predio_id = $1', [predioId]);
  });
});
