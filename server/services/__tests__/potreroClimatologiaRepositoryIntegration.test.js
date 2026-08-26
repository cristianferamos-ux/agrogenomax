// SPRINT-3D8-DESCANSO-REENTRADA (hardening territorial): pruebas del
// repositorio de climatología local
// (server/services/ganaderia/potreroClimatologiaRepository.js) contra un
// Postgres/PostGIS REAL. `refreshPotreroClimatologia` usa fetchImpl
// INYECTADO (mismo patrón que era5HistoricalClimatologyProvider.test.js)
// -- SIN red real, ni siquiera en integración con DB.
//
// Lee EXCLUSIVAMENTE AGX_BUSINESS_DATABASE_URL_TEST (nunca la variable de
// producción/runtime real). Ver db/agx-business/migrations/README.md.
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

  const tableCheck = await adminPool.query("select to_regclass('agx.potrero_climatologias_agroclimaticas') as t");
  dbAvailable = Boolean(tableCheck.rows[0]?.t);
} catch {
  dbAvailable = false;
}

if (dbAvailable) {
  repo = await import('../ganaderia/potreroClimatologiaRepository.js');
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

// fetchImpl mockeado -- construye una respuesta horaria mínima válida
// para CUALQUIER año/variable solicitada (mismo patrón de
// era5HistoricalClimatologyProvider.test.js), sin red real.
function buildMockFetchImpl({ precipValue = 5, tempValue = 25, soilValue = 0.3 } = {}) {
  return async (url) => {
    const u = String(url);
    const year = Number(u.match(/start_date=(\d{4})/)[1]);
    const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    const hoursInYear = (isLeap ? 366 : 365) * 24;
    const time = [];
    const base = Date.UTC(year, 0, 1, 0, 0, 0);
    for (let i = 0; i < hoursInYear; i += 1) time.push(new Date(base + i * 3600 * 1000).toISOString().slice(0, 16));

    if (u.includes('precipitation')) {
      return { ok: true, status: 200, json: async () => ({ hourly: { time, precipitation: time.map(() => precipValue / 24) } }) };
    }
    if (u.includes('temperature_2m')) {
      return { ok: true, status: 200, json: async () => ({ hourly: { time, temperature_2m: time.map(() => tempValue) } }) };
    }
    if (u.includes('soil_moisture_0_to_7cm')) {
      return { ok: true, status: 200, json: async () => ({ hourly: { time, soil_moisture_0_to_7cm: time.map(() => soilValue) } }) };
    }
    if (u.includes('soil_moisture_7_to_28cm')) {
      return { ok: true, status: 200, json: async () => ({ hourly: { time, soil_moisture_7_to_28cm: time.map(() => soilValue) } }) };
    }
    throw new Error(`URL inesperada: ${u}`);
  };
}

describe('SPRINT-3D8 (hardening territorial): potreroClimatologiaRepository contra Postgres-AGX-Business real', { skip: !dbAvailable }, () => {
  after(async () => {
    if (!adminPool) return;
    await adminPool.query(`
      delete from agx.potrero_climatologias_agroclimaticas
       where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D8C%')
    `);
    await adminPool.query(`delete from agx.potreros where nombre like 'Potrero Sprint3D8C%'`);
    await adminPool.query(`delete from agx.predios where nombre_predio like 'Predio Sprint3D8C%'`);
    if (businessDb) await businessDb.closeAgxBusinessPool();
    await adminPool.end();
  });

  test('getPotreroClimatologiaMasReciente sin climatología previa -> null, nunca inventa una', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D8C GET-EMPTY');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D8C GET-EMPTY');

    const result = await repo.getPotreroClimatologiaMasReciente(org, potreroId);
    assert.equal(result, null);
  });

  test('refreshPotreroClimatologia obtiene series históricas (mockeadas), calcula percentiles y persiste -- lectura posterior las recupera', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D8C REFRESH');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D8C REFRESH');

    const fetchImpl = buildMockFetchImpl({ precipValue: 5, tempValue: 24, soilValue: 0.28 });
    const persisted = await repo.refreshPotreroClimatologia(org, predioId, potreroId, { fetchImpl });

    assert.equal(persisted.method_version, 'climatology-v1');
    assert.equal(persisted.period_start_year, 1991);
    assert.equal(persisted.period_end_year, 2020);
    // HARDENING OPERACIONAL §1: humedad de suelo usa el MISMO periodo que
    // precipitación/temperatura -- nunca una ventana más corta.
    assert.equal(persisted.soil_period_start_year, 1991);
    assert.equal(persisted.soil_period_end_year, 2020);
    assert.ok(persisted.monthly_statistics_json.precipitacion7dMm);
    assert.ok(persisted.monthly_statistics_json.temperaturaMediaC);
    assert.ok(persisted.monthly_statistics_json.humedadSueloSuperficial);

    // Breakpoints de un mes cualquiera (todos los años tienen el mismo
    // valor constante inyectado -- la distribución completa colapsa al
    // mismo número, sample size = años solicitados).
    const eneroPrecip7d = persisted.monthly_statistics_json.precipitacion7dMm['1'];
    assert.ok(eneroPrecip7d);
    assert.equal(eneroPrecip7d.p50, 35); // 5mm/día * 7 días

    const leido = await repo.getPotreroClimatologiaMasReciente(org, potreroId);
    assert.equal(leido.climatologia_id, persisted.climatologia_id);
  });

  test('aislamiento tenant: climatología de ORG A invisible vía repositorio para ORG B', async () => {
    const orgA = randomOrgId();
    const orgB = randomOrgId();
    const predioA = await seedPredio(orgA, 'Predio Sprint3D8C TENANT');
    const potreroA = await seedPotrero(orgA, predioA, 'Potrero Sprint3D8C TENANT');
    await repo.refreshPotreroClimatologia(orgA, predioA, potreroA, { fetchImpl: buildMockFetchImpl() });

    const resultB = await repo.getPotreroClimatologiaMasReciente(orgB, potreroA);
    assert.equal(resultB, null);
  });

  test('refresh sucesivo -- append-only, la lectura siempre trae el más reciente', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D8C REFRESH2');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D8C REFRESH2');

    const primero = await repo.refreshPotreroClimatologia(org, predioId, potreroId, { fetchImpl: buildMockFetchImpl({ tempValue: 20 }) });
    const segundo = await repo.refreshPotreroClimatologia(org, predioId, potreroId, { fetchImpl: buildMockFetchImpl({ tempValue: 30 }) });
    assert.notEqual(primero.climatologia_id, segundo.climatologia_id);

    const leido = await repo.getPotreroClimatologiaMasReciente(org, potreroId);
    assert.equal(leido.climatologia_id, segundo.climatologia_id);

    const conteo = await adminPool.query('select count(*) from agx.potrero_climatologias_agroclimaticas where potrero_id = $1', [potreroId]);
    assert.equal(Number(conteo.rows[0].count), 2, 'append-only: el segundo refresh NUNCA sobrescribe el primero');
  });

  test('§8/§10 del hardening operacional: cobertura histórica insuficiente para UNA variable -> esa variable queda ausente, nunca un percentil fabricado con muestra insuficiente', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D8C COVERAGE');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D8C COVERAGE');

    // Temperatura falla en la MAYORÍA de los años solicitados (1991-2020,
    // 30 años) -- solo 3 años responden (~10% de cobertura, por debajo de
    // MIN_COVERAGE_PCT=0.7). Precipitación/suelo responden siempre.
    let intentosTemp = 0;
    const fetchImpl = async (url) => {
      const u = String(url);
      const year = Number(u.match(/start_date=(\d{4})/)[1]);
      const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
      const hoursInYear = (isLeap ? 366 : 365) * 24;
      const time = [];
      const base = Date.UTC(year, 0, 1, 0, 0, 0);
      for (let i = 0; i < hoursInYear; i += 1) time.push(new Date(base + i * 3600 * 1000).toISOString().slice(0, 16));

      if (u.includes('temperature_2m')) {
        intentosTemp += 1;
        if (intentosTemp > 3) return { ok: false, status: 503, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => ({ hourly: { time, temperature_2m: time.map(() => 24) } }) };
      }
      if (u.includes('precipitation')) return { ok: true, status: 200, json: async () => ({ hourly: { time, precipitation: time.map(() => 5 / 24) } }) };
      if (u.includes('soil_moisture_0_to_7cm')) return { ok: true, status: 200, json: async () => ({ hourly: { time, soil_moisture_0_to_7cm: time.map(() => 0.28) } }) };
      if (u.includes('soil_moisture_7_to_28cm')) return { ok: true, status: 200, json: async () => ({ hourly: { time, soil_moisture_7_to_28cm: time.map(() => 0.28) } }) };
      throw new Error(`URL inesperada: ${u}`);
    };

    const persisted = await repo.refreshPotreroClimatologia(org, predioId, potreroId, { fetchImpl });

    assert.equal(persisted.monthly_statistics_json.temperaturaMediaC, undefined, 'temperatura con cobertura insuficiente NUNCA se persiste como climatología utilizable');
    assert.ok(persisted.monthly_statistics_json.precipitacion7dMm, 'precipitación con cobertura completa sí se persiste');
    assert.ok(persisted.monthly_statistics_json.humedadSueloSuperficial);

    const fuenteTemp = persisted.fuentes_json.find((f) => f.variable === 'temperaturaMediaDiariaC');
    assert.ok(fuenteTemp.completeness.coveragePct < 0.7);
  });

  test('HARDENING OPERACIONAL §5/§11 (test G): cobertura CERO en las 4 variables -> lanza INSUFFICIENT_LOCAL_CLIMATOLOGY, NUNCA persiste una fila vacía', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D8C SINCOBERTURA');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D8C SINCOBERTURA');

    const fetchImpl = async () => ({ ok: false, status: 503, json: async () => ({}) });

    await assert.rejects(
      () => repo.refreshPotreroClimatologia(org, predioId, potreroId, { fetchImpl }),
      (error) => error.code === 'INSUFFICIENT_LOCAL_CLIMATOLOGY',
    );

    const conteo = await adminPool.query('select count(*) from agx.potrero_climatologias_agroclimaticas where potrero_id = $1', [potreroId]);
    assert.equal(Number(conteo.rows[0].count), 0, 'un fallo total del proveedor NUNCA persiste una climatología vacía');
  });
});
