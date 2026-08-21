// SPRINT-3D7-CAPACIDAD-PASTOREO: pruebas del repositorio
// (server/services/ganaderia/potreroCapacidadPastoreoRepository.js)
// contra un Postgres/PostGIS REAL -- mismo patrón que
// potreroFichaProductivaRepositoryIntegration.test.js. Cubre: fórmulas
// exactas del sprint (§33), aislamiento tenant (§34), y que el
// repositorio ignora cualquier intento de spoof de biomasa/resultados
// (§35 -- la firma de las funciones ni siquiera acepta esos campos, la
// biomasa SIEMPRE se relee de la ficha real).
//
// Lee EXCLUSIVAMENTE AGX_BUSINESS_DATABASE_URL_TEST (nunca la variable
// de producción/runtime real). Ver db/agx-business/migrations/README.md.
delete process.env.AGX_BUSINESS_DATABASE_URL;

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import pg from 'pg';

let dbAvailable = false;
let adminPool;
let repo;
let businessDb;

try {
  const testConnectionString = process.env.AGX_BUSINESS_DATABASE_URL_TEST;
  const adminConnectionString = process.env.AGX_BUSINESS_INTEGRATION_ADMIN_DATABASE_URL;
  if (!testConnectionString || !adminConnectionString) {
    throw new Error('AGX_BUSINESS_DATABASE_URL_TEST/AGX_BUSINESS_INTEGRATION_ADMIN_DATABASE_URL no configuradas');
  }

  process.env.AGX_BUSINESS_DATABASE_URL = testConnectionString;

  const { getConfig } = await import('../../config/env.js');
  getConfig({ APP_ENV: 'development' }, {});

  adminPool = new pg.Pool({ connectionString: adminConnectionString, max: 2 });
  await adminPool.query('select 1');

  const tableCheck = await adminPool.query("select to_regclass('agx.potrero_calculos_pastoreo') as t");
  dbAvailable = Boolean(tableCheck.rows[0]?.t);
} catch {
  dbAvailable = false;
}

if (dbAvailable) {
  repo = await import('../ganaderia/potreroCapacidadPastoreoRepository.js');
  businessDb = await import('../../db/agxBusinessPool.js');
}

const SQUARE_WKT = 'POLYGON((-75.5 1.3, -75.4 1.3, -75.4 1.4, -75.5 1.4, -75.5 1.3))';

function randomOrgId() {
  return crypto.randomUUID();
}

async function seedPredio(orgId, nombre) {
  const result = await adminPool.query(
    'insert into agx.predios (organizacion_id, nombre_predio) values ($1, $2) returning predio_id',
    [orgId, nombre],
  );
  return result.rows[0].predio_id;
}

async function seedPotrero(orgId, predioId, nombre, areaHa = 1) {
  const result = await adminPool.query(
    `insert into agx.potreros (organizacion_id, predio_id, nombre, geometry, area_ha, metodo_delimitacion)
     values ($1, $2, $3, ST_GeomFromText($4, 4326), $5, 'coordenadas')
     returning potrero_id`,
    [orgId, predioId, nombre, SQUARE_WKT, areaHa],
  );
  return result.rows[0].potrero_id;
}

// biomasaTotalKg = 2828.69 kg -- mismo ejemplo canónico del informe del
// sprint (§33/§19). aforo_promedio_g_m2 es un valor de relleno
// consistente, no participa en las fórmulas de este sprint.
async function seedFicha(orgId, potreroId, nombre, biomasaTotalKg = 2828.69) {
  const result = await adminPool.query(
    `insert into agx.potrero_fichas_productivas
       (organizacion_id, potrero_id, tipo_cobertura, nombre_principal, aforo_promedio_g_m2, biomasa_total_kg)
     values ($1, $2, 'pastura', $3, 730, $4)
     returning ficha_id`,
    [orgId, potreroId, nombre, biomasaTotalKg],
  );
  return result.rows[0].ficha_id;
}

const PARAMS_DIAS = {
  modo: 'dias_ocupacion',
  numeroAnimales: 20,
  pesoVivoPromedioKg: 450,
  porcentajeMateriaSeca: 25,
  porcentajeUtilizacion: 50,
  consumoPctPesoVivo: 2.5,
};

const PARAMS_ANIMALES = {
  modo: 'capacidad_animales',
  periodoObjetivoDias: 1,
  pesoVivoPromedioKg: 450,
  porcentajeMateriaSeca: 25,
  porcentajeUtilizacion: 50,
  consumoPctPesoVivo: 2.5,
};

function closeTo(actual, expected, tolerance, message) {
  assert.ok(Math.abs(actual - expected) < tolerance, `${message}: esperado ~${expected}, obtenido ${actual}`);
}

describe('SPRINT-3D7: potreroCapacidadPastoreoRepository contra Postgres-AGX-Business real', { skip: !dbAvailable }, () => {
  after(async () => {
    if (!adminPool) return;
    await adminPool.query(`
      delete from agx.potrero_calculos_pastoreo
       where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D7R%')
    `);
    await adminPool.query(`
      delete from agx.potrero_fichas_productivas
       where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D7R%')
    `);
    await adminPool.query(`delete from agx.potreros where nombre like 'Potrero Sprint3D7R%'`);
    await adminPool.query(`delete from agx.predios where nombre_predio like 'Predio Sprint3D7R%'`);
  });

  // ---------------------------------------------------------------------
  // §33: fórmulas exactas del sprint, ejecutadas contra la ficha real.
  // ---------------------------------------------------------------------

  test('modo días de ocupación: reproduce el ejemplo canónico del sprint contra una ficha real', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D7R DIAS');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D7R DIAS');
    await seedFicha(org, potreroId, 'Ficha Sprint3D7R DIAS');

    const calculo = await repo.createCapacidadPastoreo(org, predioId, potreroId, PARAMS_DIAS);

    closeTo(calculo.materiaSecaTotalKg, 707.1725, 0.0001, 'MS total');
    closeTo(calculo.materiaSecaUtilizableKg, 353.58625, 0.0001, 'MS utilizable');
    assert.equal(calculo.demandaDiariaLoteKgMs, 225);
    closeTo(calculo.diasOcupacionEstimados, 1.57149, 0.0001, 'días de ocupación');
    assert.equal(calculo.capacidadAnimalesPeriodo, null);
    assert.equal(calculo.modo, 'dias_ocupacion');
  });

  test('modo capacidad de animales: 31 animales completos para 1 día (§33 del sprint)', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D7R ANIMALES');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D7R ANIMALES');
    await seedFicha(org, potreroId, 'Ficha Sprint3D7R ANIMALES');

    const calculo = await repo.createCapacidadPastoreo(org, predioId, potreroId, PARAMS_ANIMALES);

    assert.equal(calculo.capacidadAnimalesPeriodo, 31);
    assert.equal(calculo.diasOcupacionEstimados, null);
    assert.equal(calculo.demandaDiariaLoteKgMs, null);
  });

  test('preview: calcula igual que create pero NO persiste nada', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D7R PREVIEW');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D7R PREVIEW');
    await seedFicha(org, potreroId, 'Ficha Sprint3D7R PREVIEW');

    const preview = await repo.previewCapacidadPastoreo(org, predioId, potreroId, PARAMS_DIAS);
    closeTo(preview.resultado.diasOcupacionEstimados, 1.57149, 0.0001, 'días de ocupación (preview)');

    const { actual, historial } = await repo.getCapacidadPastoreoByPotrero(org, predioId, potreroId);
    assert.equal(actual, null);
    assert.deepEqual(historial, []);
  });

  // ---------------------------------------------------------------------
  // §26/§23: sin ficha productiva, no se permite el cálculo. Ficha más
  // reciente (nunca mezcla fichas distintas).
  // ---------------------------------------------------------------------

  test('sin ficha productiva -> FICHA_NOT_FOUND, tanto en preview como en create', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D7R SINFICHA');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D7R SINFICHA');

    await assert.rejects(
      () => repo.previewCapacidadPastoreo(org, predioId, potreroId, PARAMS_DIAS),
      (error) => error.status === 404 && error.code === 'FICHA_NOT_FOUND',
    );
    await assert.rejects(
      () => repo.createCapacidadPastoreo(org, predioId, potreroId, PARAMS_DIAS),
      (error) => error.status === 404 && error.code === 'FICHA_NOT_FOUND',
    );
  });

  test('usa siempre la ficha MÁS RECIENTE del potrero, nunca mezcla fichas distintas', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D7R FICHARECIENTE');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D7R FICHARECIENTE');
    await seedFicha(org, potreroId, 'Ficha Sprint3D7R Vieja', 1000);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const fichaReciente = await seedFicha(org, potreroId, 'Ficha Sprint3D7R Reciente', 2828.69);

    const calculo = await repo.createCapacidadPastoreo(org, predioId, potreroId, PARAMS_DIAS);
    assert.equal(calculo.fichaId, String(fichaReciente));
    closeTo(calculo.materiaSecaTotalKg, 707.1725, 0.0001, 'MS total debía usar la ficha reciente (2828.69 kg), no la vieja (1000 kg)');
  });

  // ---------------------------------------------------------------------
  // §35: spoofing -- la firma de las funciones no acepta biomasa/
  // resultados del cliente; cualquier propiedad extra en el objeto de
  // parámetros es ignorada, la biomasa SIEMPRE se relee de la ficha real.
  // ---------------------------------------------------------------------

  test('spoof: propiedades extra en el body (biomasaTotalKg, materiaSecaTotalKg, diasOcupacionEstimados, areaHa) son ignoradas -- el resultado depende solo de la ficha real', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D7R SPOOF');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D7R SPOOF');
    await seedFicha(org, potreroId, 'Ficha Sprint3D7R SPOOF');

    const spoofedParams = {
      ...PARAMS_DIAS,
      biomasaTotalKg: 999999,
      materiaSecaTotalKg: 999999,
      materiaSecaUtilizableKg: 999999,
      diasOcupacionEstimados: 999999,
      capacidadAnimalesPeriodo: 999999,
      areaHa: 999999,
    };

    const calculo = await repo.createCapacidadPastoreo(org, predioId, potreroId, spoofedParams);
    closeTo(calculo.materiaSecaTotalKg, 707.1725, 0.0001, 'MS total debía ignorar el spoof y usar la ficha real');
    closeTo(calculo.diasOcupacionEstimados, 1.57149, 0.0001, 'días de ocupación debía ignorar el spoof');
  });

  // ---------------------------------------------------------------------
  // §34: aislamiento tenant.
  // ---------------------------------------------------------------------

  test('cálculo de ORG A invisible para ORG B (RLS)', async () => {
    const orgA = randomOrgId();
    const orgB = randomOrgId();
    const predioA = await seedPredio(orgA, 'Predio Sprint3D7R CROSS-A');
    const potreroA = await seedPotrero(orgA, predioA, 'Potrero Sprint3D7R CROSS-A');
    await seedFicha(orgA, potreroA, 'Ficha Sprint3D7R CROSS-A');
    await repo.createCapacidadPastoreo(orgA, predioA, potreroA, PARAMS_DIAS);

    await assert.rejects(
      () => repo.getCapacidadPastoreoByPotrero(orgB, predioA, potreroA),
      (error) => error.status === 404 && error.code === 'POTRERO_NOT_FOUND',
    );
  });

  test('ORG B no puede usar una ficha de ORG A (potrero cross-tenant -> POTRERO_NOT_FOUND antes de resolver ficha)', async () => {
    const orgA = randomOrgId();
    const orgB = randomOrgId();
    const predioA = await seedPredio(orgA, 'Predio Sprint3D7R XORG-A');
    const potreroA = await seedPotrero(orgA, predioA, 'Potrero Sprint3D7R XORG-A');
    await seedFicha(orgA, potreroA, 'Ficha Sprint3D7R XORG-A');

    await assert.rejects(
      () => repo.createCapacidadPastoreo(orgB, predioA, potreroA, PARAMS_DIAS),
      (error) => error.status === 404 && error.code === 'POTRERO_NOT_FOUND',
    );
  });

  test('potrero de OTRO predio -> POTRERO_NOT_FOUND', async () => {
    const org = randomOrgId();
    const predioA = await seedPredio(org, 'Predio Sprint3D7R WRONGPREDIO-A');
    const predioB = await seedPredio(org, 'Predio Sprint3D7R WRONGPREDIO-B');
    const potreroA = await seedPotrero(org, predioA, 'Potrero Sprint3D7R WRONGPREDIO-A');
    await seedFicha(org, potreroA, 'Ficha Sprint3D7R WRONGPREDIO-A');

    await assert.rejects(
      () => repo.createCapacidadPastoreo(org, predioB, potreroA, PARAMS_DIAS),
      (error) => error.status === 404 && error.code === 'POTRERO_NOT_FOUND',
    );
  });

  test('historial aislado: getCapacidadPastoreoByPotrero de ORG B nunca ve el historial de ORG A', async () => {
    const orgA = randomOrgId();
    const orgB = randomOrgId();
    const predioA = await seedPredio(orgA, 'Predio Sprint3D7R HISTAISLADO-A');
    const potreroA = await seedPotrero(orgA, predioA, 'Potrero Sprint3D7R HISTAISLADO-A');
    await seedFicha(orgA, potreroA, 'Ficha Sprint3D7R HISTAISLADO-A');
    await repo.createCapacidadPastoreo(orgA, predioA, potreroA, PARAMS_DIAS);
    await repo.createCapacidadPastoreo(orgA, predioA, potreroA, PARAMS_ANIMALES);

    const { actual, historial } = await repo.getCapacidadPastoreoByPotrero(orgA, predioA, potreroA);
    assert.ok(actual);
    assert.equal(historial.length, 1);

    await assert.rejects(
      () => repo.getCapacidadPastoreoByPotrero(orgB, predioA, potreroA),
      (error) => error.status === 404 && error.code === 'POTRERO_NOT_FOUND',
    );
  });

  test('inserción cross-tenant directa (como agx_app de ORG A, ficha de ORG B) bloqueada por FK compuesta', async () => {
    const orgA = randomOrgId();
    const orgB = randomOrgId();
    const predioA = await seedPredio(orgA, 'Predio Sprint3D7R DIRECTXTENANT-A');
    const potreroA = await seedPotrero(orgA, predioA, 'Potrero Sprint3D7R DIRECTXTENANT-A');
    const predioB = await seedPredio(orgB, 'Predio Sprint3D7R DIRECTXTENANT-B');
    const potreroB = await seedPotrero(orgB, predioB, 'Potrero Sprint3D7R DIRECTXTENANT-B');
    const fichaB = await seedFicha(orgB, potreroB, 'Ficha Sprint3D7R DIRECTXTENANT-B');

    await businessDb.withOrganizacionTransaction(orgA, async (client) => {
      await assert.rejects(
        () => client.query(
          `insert into agx.potrero_calculos_pastoreo
             (organizacion_id, predio_id, potrero_id, ficha_id, modo, numero_animales, peso_vivo_promedio_kg,
              porcentaje_materia_seca, porcentaje_utilizacion, consumo_pct_peso_vivo,
              materia_seca_total_kg, materia_seca_utilizable_kg, demanda_diaria_lote_kg_ms, dias_ocupacion_estimados)
           values ($1, $2, $3, $4, 'dias_ocupacion', 20, 450, 25, 50, 2.5, 250, 125, 225, 0.55)`,
          [orgA, predioA, potreroA, fichaB],
        ),
        (error) => error.code === '23503',
      );
    });
  });

  // ---------------------------------------------------------------------
  // §27: historial resumido, más reciente como "actual".
  // ---------------------------------------------------------------------

  test('historial: getCapacidadPastoreoByPotrero devuelve el más reciente como actual y el resto como historial', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D7R HIST');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D7R HIST');
    await seedFicha(org, potreroId, 'Ficha Sprint3D7R HIST');

    await repo.createCapacidadPastoreo(org, predioId, potreroId, PARAMS_DIAS);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const segundo = await repo.createCapacidadPastoreo(org, predioId, potreroId, PARAMS_ANIMALES);

    const { actual, historial } = await repo.getCapacidadPastoreoByPotrero(org, predioId, potreroId);
    assert.equal(actual.calculoId, segundo.calculoId);
    assert.equal(actual.modo, 'capacidad_animales');
    assert.equal(historial.length, 1);
    assert.equal(historial[0].modo, 'dias_ocupacion');
  });

  test('potrero con ficha pero sin cálculos -> { actual: null, historial: [] } (nunca 404)', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D7R SINCALCULO');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D7R SINCALCULO');
    await seedFicha(org, potreroId, 'Ficha Sprint3D7R SINCALCULO');

    const result = await repo.getCapacidadPastoreoByPotrero(org, predioId, potreroId);
    assert.equal(result.actual, null);
    assert.deepEqual(result.historial, []);
  });

  // ---------------------------------------------------------------------
  // §30: resultado extremo -- nunca oculta el cálculo, señala la
  // advertencia neutral.
  // ---------------------------------------------------------------------

  test('resultado extremo: utilización mínima produce advertencia sin ocultar el cálculo', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D7R EXTREMO');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D7R EXTREMO');
    await seedFicha(org, potreroId, 'Ficha Sprint3D7R EXTREMO', 1);

    const calculo = await repo.createCapacidadPastoreo(org, predioId, potreroId, {
      ...PARAMS_ANIMALES,
      porcentajeUtilizacion: 1,
      porcentajeMateriaSeca: 1,
    });

    assert.equal(calculo.capacidadAnimalesPeriodo, 0);
    assert.equal(calculo.resultadoExtremo, true);
  });
});

after(async () => {
  if (!adminPool) return;
  if (businessDb) await businessDb.closeAgxBusinessPool();
  await adminPool.end();
});
