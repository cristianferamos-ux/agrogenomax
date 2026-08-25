// SPRINT-3D7.1-AGROCLIMA: pruebas del repositorio
// (server/services/ganaderia/agroClimateContextRepository.js) contra un
// Postgres/PostGIS REAL -- mismo patrón que
// potreroCapacidadPastoreoRepositoryIntegration.test.js. Cubre: resolución
// de punto server-side desde geometry, aislamiento tenant (ORG A/ORG B,
// §29 del sprint), refresh con proveedores externos mockeados (fetchImpl
// inyectado -- sin red real en este archivo), y que UNAVAILABLE nunca
// persiste una fila.
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

  const tableCheck = await adminPool.query("select to_regclass('agx.potrero_contextos_agroclimaticos') as t");
  dbAvailable = Boolean(tableCheck.rows[0]?.t);
} catch {
  dbAvailable = false;
}

if (dbAvailable) {
  repo = await import('../ganaderia/agroClimateContextRepository.js');
  businessDb = await import('../../db/agxBusinessPool.js');
}

function randomOrgId() {
  return crypto.randomUUID();
}

const SQUARE_WKT = 'POLYGON((-75.5 1.3, -75.4 1.3, -75.4 1.4, -75.5 1.4, -75.5 1.3))';

async function seedPredio(orgId, nombre) {
  const result = await adminPool.query(
    'insert into agx.predios (organizacion_id, nombre_predio) values ($1, $2) returning predio_id',
    [orgId, nombre],
  );
  return result.rows[0].predio_id;
}

async function seedPotrero(orgId, predioId, nombre) {
  const result = await adminPool.query(
    `insert into agx.potreros (organizacion_id, predio_id, nombre, geometry, area_ha, metodo_delimitacion)
     values ($1, $2, $3, ST_GeomFromText($4, 4326), 1, 'coordenadas')
     returning potrero_id`,
    [orgId, predioId, nombre, SQUARE_WKT],
  );
  return result.rows[0].potrero_id;
}

function buildEra5OkFetch() {
  const hourly = { time: [], temperature_2m: [], dew_point_2m: [], precipitation: [], shortwave_radiation: [], soil_moisture_0_to_7cm: [], soil_moisture_7_to_28cm: [], wind_speed_10m: [] };
  for (let i = 0; i < 24; i += 1) {
    hourly.time.push(`2026-08-24T${String(i).padStart(2, '0')}:00`);
    hourly.temperature_2m.push(21);
    hourly.dew_point_2m.push(15);
    hourly.precipitation.push(0.2);
    hourly.shortwave_radiation.push(150);
    hourly.soil_moisture_0_to_7cm.push(0.27);
    hourly.soil_moisture_7_to_28cm.push(0.24);
    hourly.wind_speed_10m.push(1.8);
  }
  return async (url) => {
    const u = String(url);
    if (u.includes('archive-api.open-meteo.com')) {
      return { ok: true, status: 200, json: async () => ({ latitude: 1.35, longitude: -75.45, hourly }) };
    }
    // IDEAM: sin estaciones cercanas en este fixture -- ERA5 solo basta.
    return { ok: true, status: 200, json: async () => [] };
  };
}

function buildAllFailFetch() {
  return async () => ({ ok: false, status: 503, json: async () => ({}) });
}

describe('SPRINT-3D7.1: agroClimateContextRepository contra Postgres-AGX-Business real', { skip: !dbAvailable }, () => {
  after(async () => {
    if (!adminPool) return;
    await adminPool.query(`
      delete from agx.potrero_contextos_agroclimaticos
       where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D71R%')
    `);
    await adminPool.query(`delete from agx.potreros where nombre like 'Potrero Sprint3D71R%'`);
    await adminPool.query(`delete from agx.predios where nombre_predio like 'Predio Sprint3D71R%'`);
    if (businessDb) await businessDb.closeAgxBusinessPool();
    await adminPool.end();
  });

  test('GET sin snapshots previos -> { actual: null, historial: [] }, nunca 404', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D71R GET-EMPTY');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D71R GET-EMPTY');

    const result = await repo.getContextoAgroclimatico(org, predioId, potreroId);
    assert.deepEqual(result, { actual: null, historial: [] });
  });

  test('GET con potreroId inexistente -> POTRERO_NOT_FOUND (404)', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D71R GET-404');
    await assert.rejects(
      () => repo.getContextoAgroclimatico(org, predioId, 999999999),
      (error) => error.status === 404 && error.code === 'POTRERO_NOT_FOUND',
    );
  });

  test('refresh COMPLETE: resuelve punto desde geometry, persiste snapshot, GET lo refleja', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D71R REFRESH-OK');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D71R REFRESH-OK');

    const result = await repo.refreshContextoAgroclimatico(org, predioId, potreroId, { fetchImpl: buildEra5OkFetch() });
    assert.equal(result.status, 'COMPLETE');
    assert.ok(result.snapshot.contextoId);
    assert.equal(result.snapshot.fuentePrincipal, 'ERA5_LAND');
    assert.ok(Math.abs(result.snapshot.precipitacion24hMm - 4.8) < 0.01);

    const getResult = await repo.getContextoAgroclimatico(org, predioId, potreroId);
    assert.equal(getResult.actual.contextoId, result.snapshot.contextoId);
    assert.equal(getResult.historial.length, 0);
  });

  test('refresh UNAVAILABLE: ambos proveedores fallan -- NO persiste fila, GET sigue vacío', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D71R REFRESH-DOWN');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D71R REFRESH-DOWN');

    const result = await repo.refreshContextoAgroclimatico(org, predioId, potreroId, { fetchImpl: buildAllFailFetch() });
    assert.equal(result.status, 'UNAVAILABLE');
    assert.equal(result.snapshot, null);

    const getResult = await repo.getContextoAgroclimatico(org, predioId, potreroId);
    assert.equal(getResult.actual, null);
  });

  test('refresh con potreroId de OTRO predio -> POTRERO_NOT_FOUND', async () => {
    const org = randomOrgId();
    const predioA = await seedPredio(org, 'Predio Sprint3D71R WRONGP-A');
    const predioB = await seedPredio(org, 'Predio Sprint3D71R WRONGP-B');
    const potreroA = await seedPotrero(org, predioA, 'Potrero Sprint3D71R WRONGP-A');

    await assert.rejects(
      () => repo.refreshContextoAgroclimatico(org, predioB, potreroA, { fetchImpl: buildEra5OkFetch() }),
      (error) => error.status === 404 && error.code === 'POTRERO_NOT_FOUND',
    );
  });

  test('cross-tenant: ORG B no puede leer ni referenciar el potrero de ORG A (RLS + FK)', async () => {
    const orgA = randomOrgId();
    const orgB = randomOrgId();
    const predioA = await seedPredio(orgA, 'Predio Sprint3D71R CROSS-A');
    const potreroA = await seedPotrero(orgA, predioA, 'Potrero Sprint3D71R CROSS-A');
    await repo.refreshContextoAgroclimatico(orgA, predioA, potreroA, { fetchImpl: buildEra5OkFetch() });

    await assert.rejects(
      () => repo.getContextoAgroclimatico(orgB, predioA, potreroA),
      (error) => error.status === 404 && error.code === 'POTRERO_NOT_FOUND',
    );
  });

  test('sin app.current_org_id -> 0 filas visibles (defensa en profundidad RLS)', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D71R NOORG');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D71R NOORG');
    await repo.refreshContextoAgroclimatico(org, predioId, potreroId, { fetchImpl: buildEra5OkFetch() });

    const directPool = new pg.Pool({ connectionString: process.env.AGX_BUSINESS_DATABASE_URL_TEST, max: 1 });
    try {
      const result = await directPool.query('select count(*) from agx.potrero_contextos_agroclimaticos where potrero_id = $1', [potreroId]);
      assert.equal(Number(result.rows[0].count), 0);
    } finally {
      await directPool.end();
    }
  });

  test('histórico: múltiples refresh del mismo potrero -- actual es el más reciente, historial preserva los anteriores', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D71R HIST');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D71R HIST');

    const first = await repo.refreshContextoAgroclimatico(org, predioId, potreroId, { fetchImpl: buildEra5OkFetch() });
    const second = await repo.refreshContextoAgroclimatico(org, predioId, potreroId, { fetchImpl: buildEra5OkFetch() });

    const getResult = await repo.getContextoAgroclimatico(org, predioId, potreroId);
    assert.equal(getResult.actual.contextoId, second.snapshot.contextoId);
    assert.equal(getResult.historial.length, 1);
    assert.equal(getResult.historial[0].contextoId, first.snapshot.contextoId);
  });
});
