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
    // SPRINT-3C2.6 §2: `sector` descriptivo YA NO existe en el contrato
    // real del predio (buildNormalizedPredio siempre entrega null) --
    // solo sobrevive el código técnico crudo, bajo un nombre distinto,
    // usado exclusivamente para atributos_json (nunca snapshot.sector).
    sector: null,
    sectorCodigoTecnico: '01',
    veredaCodigoTecnico: null,
    areaCatastralM2: 50000,
    areaCatastralHa: 5,
    geometry: SQUARE_MULTIPOLYGON,
    fuente: 'catastrox_clean',
    // SPRINT-3C2.5 §5: el DTO real siempre entrega null aquí -- se deja
    // explícito en el fixture para no fingir un valor que el código de
    // producción nunca produciría.
    versionFuente: null,
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

  // SPRINT-3D9.2 (PRE-COMMIT FINAL ROUND, punto 3): por defecto el
  // listado excluye ARCHIVADO; incluirArchivados=true los incluye.
  test('SPRINT-3D9.2: listPredios excluye ARCHIVADO por defecto; incluirArchivados=true los incluye', async () => {
    const org = randomOrgId();
    const predioActivo = predioFixture({ nombrePredio: 'Finca Sprint3D92 activa' });
    const predioArchivado = predioFixture({ nombrePredio: 'Finca Sprint3D92 archivada' });

    const activoId = await repo.createCatastroxPredio(org, {
      nombreFinal: predioActivo.nombrePredio, predio: predioActivo, geometryJson: JSON.stringify(predioActivo.geometry),
    });
    const archivadoId = await repo.createCatastroxPredio(org, {
      nombreFinal: predioArchivado.nombrePredio, predio: predioArchivado, geometryJson: JSON.stringify(predioArchivado.geometry),
    });
    await adminPool.query(
      `update agx.predios set estado = 'ARCHIVADO', archivado_at = now(), motivo_archivado = 'test' where predio_id = $1`,
      [archivadoId],
    );

    const soloActivos = await repo.listPredios(org);
    assert.equal(soloActivos.length, 1);
    assert.equal(String(soloActivos[0].predio_id), String(activoId));

    const todos = await repo.listPredios(org, { incluirArchivados: true });
    assert.equal(todos.length, 2);
    assert.ok(todos.some((r) => String(r.predio_id) === String(archivadoId) && r.estado === 'ARCHIVADO'));

    await adminPool.query('delete from agx.predio_snapshots_catastrales where predio_id = any($1)', [[activoId, archivadoId]]);
    await adminPool.query('delete from agx.predios where predio_id = any($1)', [[activoId, archivadoId]]);
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
      areaDeclaradaHa: null,
      observaciones: null,
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

  // -----------------------------------------------------------------
  // SPRINT-3C2.5 §15 (items 6-7): snapshot.vereda nunca es un objeto de
  // presentación; snapshot.version_fuente siempre es null.
  // -----------------------------------------------------------------

  test('§15.6: snapshot.vereda es string cuando el predio tiene un nombre humano real, nunca el objeto veredaDisplay', async () => {
    const orgA = randomOrgId();
    const predio = predioFixture({ vereda: 'Florida Uno' });
    const geometryJson = JSON.stringify(predio.geometry);

    const predioId = await repo.createCatastroxPredio(orgA, { nombreFinal: predio.nombrePredio, predio, geometryJson });
    const detail = await repo.getPredioDetail(orgA, predioId);

    assert.equal(typeof detail.snapshotRow.vereda, 'string');
    assert.equal(detail.snapshotRow.vereda, 'Florida Uno');

    await adminPool.query('delete from agx.predio_snapshots_catastrales where predio_id = $1', [predioId]);
    await adminPool.query('delete from agx.predios where predio_id = $1', [predioId]);
  });

  test('§15.6: snapshot.vereda es null cuando el predio no tiene vereda humana (nunca un objeto ni el placeholder)', async () => {
    const orgA = randomOrgId();
    const predio = predioFixture({ vereda: null });
    const geometryJson = JSON.stringify(predio.geometry);

    const predioId = await repo.createCatastroxPredio(orgA, { nombreFinal: predio.nombrePredio, predio, geometryJson });
    const detail = await repo.getPredioDetail(orgA, predioId);

    assert.ok(
      detail.snapshotRow.vereda === null || typeof detail.snapshotRow.vereda === 'string',
      'vereda debe ser string o null, nunca un objeto serializado',
    );
    assert.equal(detail.snapshotRow.vereda, null);

    await adminPool.query('delete from agx.predio_snapshots_catastrales where predio_id = $1', [predioId]);
    await adminPool.query('delete from agx.predios where predio_id = $1', [predioId]);
  });

  test('§15.7: snapshot.version_fuente siempre es null, incluso si el candidate trae un versionFuente (defensa en profundidad)', async () => {
    const orgA = randomOrgId();
    // predioFixture() ya fija versionFuente:null (contrato real actual),
    // pero se fuerza aquí un valor no-null para confirmar que el
    // repositorio IGNORA cualquier valor entrante y siempre persiste null
    // -- nunca se deriva de CATASTROX_DATASET_VERSION ni de `fuente`
    // (SPRINT-3C2.5 §5/§11, decisión aprobada).
    const predio = predioFixture({ versionFuente: '2026-01' });
    const geometryJson = JSON.stringify(predio.geometry);

    const predioId = await repo.createCatastroxPredio(orgA, { nombreFinal: predio.nombrePredio, predio, geometryJson });
    const detail = await repo.getPredioDetail(orgA, predioId);

    assert.equal(detail.snapshotRow.version_fuente, null);

    await adminPool.query('delete from agx.predio_snapshots_catastrales where predio_id = $1', [predioId]);
    await adminPool.query('delete from agx.predios where predio_id = $1', [predioId]);
  });

  // -----------------------------------------------------------------
  // SPRINT-3C2.5 §16: escenarios de confirmación A-G del modelo final
  // de registro de predio (modo catastrox).
  // -----------------------------------------------------------------

  test('§16 A: nombrePersonalizado enviado -> se guarda como nombre_predio operativo (distinto del catastral)', async () => {
    const orgA = randomOrgId();
    const predio = predioFixture({ nombrePredio: 'Nombre Catastral Original' });
    const geometryJson = JSON.stringify(predio.geometry);
    const nombrePersonalizado = 'Mi Finca Personalizada';

    const predioId = await repo.createCatastroxPredio(orgA, { nombreFinal: nombrePersonalizado, predio, geometryJson });
    const detail = await repo.getPredioDetail(orgA, predioId);

    assert.equal(detail.predioRow.nombre_predio, nombrePersonalizado);
    assert.equal(
      detail.snapshotRow.nombre_predio_catastral,
      'Nombre Catastral Original',
      'el snapshot preserva el nombre catastral original, inmutable, sin importar el nombre operativo elegido',
    );

    await adminPool.query('delete from agx.predio_snapshots_catastrales where predio_id = $1', [predioId]);
    await adminPool.query('delete from agx.predios where predio_id = $1', [predioId]);
  });

  test('§16 B: sin nombrePersonalizado -> el nombreFinal recibido (fallback ya resuelto en el router) es el nombre catastral', async () => {
    const orgA = randomOrgId();
    const predio = predioFixture({ nombrePredio: 'Nombre Catastral Original' });
    const geometryJson = JSON.stringify(predio.geometry);

    // Replica el fallback nombreFinal = nombrePersonalizado ?? candidate.nombrePredio
    // ya implementado en el router -- este test cubre el repositorio, que
    // simplemente persiste lo que recibe como nombreFinal.
    const predioId = await repo.createCatastroxPredio(orgA, { nombreFinal: predio.nombrePredio, predio, geometryJson });
    const detail = await repo.getPredioDetail(orgA, predioId);

    assert.equal(detail.predioRow.nombre_predio, 'Nombre Catastral Original');

    await adminPool.query('delete from agx.predio_snapshots_catastrales where predio_id = $1', [predioId]);
    await adminPool.query('delete from agx.predios where predio_id = $1', [predioId]);
  });

  test('§16 C/D/F: areaDeclaradaHa enviada se guarda como operacional; sin enviarla queda null; areaCatastralHa vive solo en el snapshot', async () => {
    const orgA = randomOrgId();
    const predioConArea = predioFixture({ areaCatastralHa: 5, areaCatastralM2: 50000 });
    const geometryJsonConArea = JSON.stringify(predioConArea.geometry);

    // C: con areaDeclaradaHa explícita del cliente.
    const predioIdConArea = await repo.createCatastroxPredio(orgA, {
      nombreFinal: predioConArea.nombrePredio,
      predio: predioConArea,
      geometryJson: geometryJsonConArea,
      areaDeclaradaHa: 9.16,
    });
    const detailConArea = await repo.getPredioDetail(orgA, predioIdConArea);
    assert.equal(Number(detailConArea.predioRow.area_total_ha), 9.16, 'C: areaDeclaradaHa enviada por el cliente se guarda como el área operacional');
    // F: el área catastral oficial NUNCA se copia a agx.predios -- solo
    // vive en el snapshot, y es un valor distinto (5) al operacional
    // (9.16) enviado por el cliente -- prueba de que no se confunden ni
    // se auto-rellenan entre sí.
    assert.equal(Number(detailConArea.snapshotRow.area_ha), 5, 'F: el área catastral oficial vive únicamente en el snapshot');
    assert.notEqual(
      Number(detailConArea.predioRow.area_total_ha),
      Number(detailConArea.snapshotRow.area_ha),
      'F: operacional y catastral son valores independientes, nunca el mismo campo con dos nombres',
    );

    // D: sin areaDeclaradaHa (el llamador no la envía) -> queda null,
    // JAMÁS se auto-rellena con predio.areaCatastralHa aunque exista.
    const predioSinArea = predioFixture({ areaCatastralHa: 5, areaCatastralM2: 50000 });
    const geometryJsonSinArea = JSON.stringify(predioSinArea.geometry);
    const predioIdSinArea = await repo.createCatastroxPredio(orgA, {
      nombreFinal: predioSinArea.nombrePredio,
      predio: predioSinArea,
      geometryJson: geometryJsonSinArea,
    });
    const detailSinArea = await repo.getPredioDetail(orgA, predioIdSinArea);
    assert.equal(detailSinArea.predioRow.area_total_ha, null, 'D: sin areaDeclaradaHa del cliente, el área operacional queda null -- nunca se infiere del área catastral');

    await adminPool.query('delete from agx.predio_snapshots_catastrales where predio_id = any($1)', [[predioIdConArea, predioIdSinArea]]);
    await adminPool.query('delete from agx.predios where predio_id = any($1)', [[predioIdConArea, predioIdSinArea]]);
  });

  test('§16 E: observaciones enviada se guarda; sin enviarla queda null', async () => {
    const orgA = randomOrgId();
    const predioConObs = predioFixture();
    const geometryJsonConObs = JSON.stringify(predioConObs.geometry);
    const predioSinObs = predioFixture();
    const geometryJsonSinObs = JSON.stringify(predioSinObs.geometry);

    const predioIdConObs = await repo.createCatastroxPredio(orgA, {
      nombreFinal: predioConObs.nombrePredio,
      predio: predioConObs,
      geometryJson: geometryJsonConObs,
      observaciones: 'Acceso por la vía principal, cerca del río.',
    });
    const detailConObs = await repo.getPredioDetail(orgA, predioIdConObs);
    assert.equal(detailConObs.predioRow.observaciones, 'Acceso por la vía principal, cerca del río.');

    const predioIdSinObs = await repo.createCatastroxPredio(orgA, {
      nombreFinal: predioSinObs.nombrePredio,
      predio: predioSinObs,
      geometryJson: geometryJsonSinObs,
    });
    const detailSinObs = await repo.getPredioDetail(orgA, predioIdSinObs);
    assert.equal(detailSinObs.predioRow.observaciones, null);

    await adminPool.query('delete from agx.predio_snapshots_catastrales where predio_id = any($1)', [[predioIdConObs, predioIdSinObs]]);
    await adminPool.query('delete from agx.predios where predio_id = any($1)', [[predioIdConObs, predioIdSinObs]]);
  });

  test('§16 G: geometry persistida proviene exclusivamente del candidate/servidor, idéntica en predio y snapshot', async () => {
    const orgA = randomOrgId();
    const predio = predioFixture();
    const geometryJson = JSON.stringify(predio.geometry);

    const predioId = await repo.createCatastroxPredio(orgA, { nombreFinal: predio.nombrePredio, predio, geometryJson });
    const detail = await repo.getPredioDetail(orgA, predioId);

    assert.deepEqual(detail.predioRow.geometry, SQUARE_MULTIPOLYGON);
    assert.deepEqual(detail.snapshotRow.geometry, SQUARE_MULTIPOLYGON);

    await adminPool.query('delete from agx.predio_snapshots_catastrales where predio_id = $1', [predioId]);
    await adminPool.query('delete from agx.predios where predio_id = $1', [predioId]);
  });

  // -----------------------------------------------------------------
  // SPRINT-3C2.6 §2/§7/§8: sector descriptivo siempre null (defensa en
  // profundidad, incluso si predio.sector llegara poblado por error);
  // el código técnico crudo se preserva SOLO en atributos_json; nunca en
  // snapshot.sector; codigoPredial/codigoAnterior se conservan intactos.
  // -----------------------------------------------------------------

  test('§2/§7 (defensa en profundidad): aunque predio.sector llegue poblado por error, snapshot.sector queda null y el código técnico va SOLO a atributos_json', async () => {
    const orgA = randomOrgId();
    // Simula un candidate corrupto/desactualizado que todavía trajera un
    // código técnico en `sector` -- el repositorio debe ignorarlo por
    // completo, nunca confiar en el candidate para esta columna.
    const predio = predioFixture({ sector: '01', sectorCodigoTecnico: '01' });
    const geometryJson = JSON.stringify(predio.geometry);

    const predioId = await repo.createCatastroxPredio(orgA, { nombreFinal: predio.nombrePredio, predio, geometryJson });
    const detail = await repo.getPredioDetail(orgA, predioId);

    assert.equal(detail.snapshotRow.sector, null, 'snapshot.sector nunca debe recibir el código técnico, ni siquiera si predio.sector viene poblado');

    await adminPool.query('delete from agx.predio_snapshots_catastrales where predio_id = $1', [predioId]);
    await adminPool.query('delete from agx.predios where predio_id = $1', [predioId]);
  });

  test('§7: el código técnico de sector/vereda se preserva en atributos_json, nunca en una columna descriptiva', async () => {
    const orgA = randomOrgId();
    const predio = predioFixture({ sectorCodigoTecnico: '05', veredaCodigoTecnico: '123AB' });
    const geometryJson = JSON.stringify(predio.geometry);

    const predioId = await repo.createCatastroxPredio(orgA, { nombreFinal: predio.nombrePredio, predio, geometryJson });

    const snapshotResult = await adminPool.query(
      'select atributos_json from agx.predio_snapshots_catastrales where predio_id = $1',
      [predioId],
    );
    const atributos = snapshotResult.rows[0].atributos_json;
    assert.equal(atributos.sectorCodigoTecnico, '05');
    assert.equal(atributos.veredaCodigoTecnico, '123AB');

    await adminPool.query('delete from agx.predio_snapshots_catastrales where predio_id = $1', [predioId]);
    await adminPool.query('delete from agx.predios where predio_id = $1', [predioId]);
  });

  test('§8.8: codigoPredial y codigoAnterior se conservan intactos en el snapshot, sin transformación alguna', async () => {
    const orgA = randomOrgId();
    // codigo_anterior es varchar(20) en el esquema real.
    const predio = predioFixture({ codigoAnterior: '18600100000010001' });
    const geometryJson = JSON.stringify(predio.geometry);

    const predioId = await repo.createCatastroxPredio(orgA, { nombreFinal: predio.nombrePredio, predio, geometryJson });
    const detail = await repo.getPredioDetail(orgA, predioId);

    assert.equal(detail.snapshotRow.codigo_predial, predio.codigoPredial);
    assert.equal(detail.snapshotRow.codigo_anterior, '18600100000010001');
    assert.equal(detail.predioRow.codigo_predial, predio.codigoPredial);

    await adminPool.query('delete from agx.predio_snapshots_catastrales where predio_id = $1', [predioId]);
    await adminPool.query('delete from agx.predios where predio_id = $1', [predioId]);
  });
});
