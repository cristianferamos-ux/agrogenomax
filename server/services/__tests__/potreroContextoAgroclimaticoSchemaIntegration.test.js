// SPRINT-3D7.1-AGROCLIMA: pruebas de la fundación tenant-safe de
// agx.potrero_contextos_agroclimaticos (db/agx-business/migrations/0006_potrero_contexto_agroclimatico.sql)
// contra un Postgres/PostGIS REAL -- mismo patrón que
// potreroCapacidadPastoreoSchemaIntegration.test.js (0005).
//
// Lee EXCLUSIVAMENTE AGX_BUSINESS_DATABASE_URL_TEST -- nunca la variable
// de producción/runtime real. Ver db/agx-business/migrations/README.md.
delete process.env.AGX_BUSINESS_DATABASE_URL;

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..', '..');

let dbAvailable = false;
let adminPool;
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

function baseSnapshotValues() {
  return {
    precipitacion_24h_mm: 5, precipitacion_7d_mm: 20, precipitacion_15d_mm: 40, precipitacion_30d_mm: 80,
    temperatura_media_c: 22, temperatura_min_c: 18, temperatura_max_c: 28,
    humedad_relativa_media_pct: 75, humedad_suelo_superficial: 0.3, humedad_suelo_subsuperficial: 0.28,
    radiacion_solar: 190, viento_medio_ms: 2.5,
    fuente_principal: 'ERA5_LAND', calidad: 'reanalysis',
  };
}

async function insertSnapshot(org, predioId, potreroId, overrides = {}) {
  const v = { ...baseSnapshotValues(), ...overrides };
  const result = await adminPool.query(
    `insert into agx.potrero_contextos_agroclimaticos
       (organizacion_id, predio_id, potrero_id, fecha_referencia,
        precipitacion_24h_mm, precipitacion_7d_mm, precipitacion_15d_mm, precipitacion_30d_mm,
        temperatura_media_c, temperatura_min_c, temperatura_max_c, humedad_relativa_media_pct,
        humedad_suelo_superficial, humedad_suelo_subsuperficial, radiacion_solar, viento_medio_ms,
        fuente_principal, calidad, fuentes_json)
     values ($1, $2, $3, current_date, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, '[]')
     returning contexto_id`,
    [org, predioId, potreroId, v.precipitacion_24h_mm, v.precipitacion_7d_mm, v.precipitacion_15d_mm, v.precipitacion_30d_mm,
      v.temperatura_media_c, v.temperatura_min_c, v.temperatura_max_c, v.humedad_relativa_media_pct,
      v.humedad_suelo_superficial, v.humedad_suelo_subsuperficial, v.radiacion_solar, v.viento_medio_ms,
      v.fuente_principal, v.calidad],
  );
  return result.rows[0].contexto_id;
}

describe('SPRINT-3D7.1: legacy y sprints previos quedan intactos (sin DB)', () => {
  test('la migración 0006 es aditiva pura -- sin DROP/TRUNCATE, no toca datos de 0001-0005', () => {
    const migrationPath = path.join(repoRoot, 'db', 'agx-business', 'migrations', '0006_potrero_contexto_agroclimatico.sql');
    const sql = fs.readFileSync(migrationPath, 'utf8');
    assert.doesNotMatch(sql, /\bdrop\s+table\s+if\s+exists\s+agx\.(?!potrero_contextos_agroclimaticos)/i);
    assert.doesNotMatch(sql, /\btruncate\s+table\b/i);
    assert.doesNotMatch(sql, /alter\s+table\s+agx\.predios\b/i);
    assert.doesNotMatch(sql, /alter\s+table\s+agx\.potreros\b/i);
    assert.doesNotMatch(sql, /alter\s+table\s+agx\.potrero_(fichas_productivas|calculos_pastoreo)\b/i);
    assert.doesNotMatch(sql, /catastrox/i);
  });

  test('server/services/ganaderia/agroClimateContextRepository.js solo usa agxBusinessPool', () => {
    const repoPath = path.join(repoRoot, 'server', 'services', 'ganaderia', 'agroClimateContextRepository.js');
    const content = fs.readFileSync(repoPath, 'utf8');
    assert.match(content, /agxBusinessPool\.js/);
    assert.doesNotMatch(content, /from ['"].*\/db\.js['"]/);
    assert.doesNotMatch(content, /DATABASE_URL/);
  });

  test('los proveedores nunca hardcodean secretos/API keys en el código versionado', () => {
    for (const file of ['era5LandProvider.js', 'ideamProvider.js']) {
      const content = fs.readFileSync(path.join(repoRoot, 'server', 'services', 'ganaderia', 'agroClimate', file), 'utf8');
      assert.doesNotMatch(content, /apikey\s*[:=]\s*['"][A-Za-z0-9]{10,}/i);
      assert.match(content, /process\.env\./);
    }
  });
});

describe('SPRINT-3D7.1: esquema real -- contexto agroclimático', { skip: !dbAvailable }, () => {
  after(async () => {
    if (!adminPool) return;
    await adminPool.query(`
      delete from agx.potrero_contextos_agroclimaticos
       where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D71S%')
    `);
    await adminPool.query(`delete from agx.potreros where nombre like 'Potrero Sprint3D71S%'`);
    await adminPool.query(`delete from agx.predios where nombre_predio like 'Predio Sprint3D71S%'`);
    if (businessDb) await businessDb.closeAgxBusinessPool();
    await adminPool.end();
  });

  test('RLS ENABLE/FORCE activo en agx.potrero_contextos_agroclimaticos', async () => {
    const result = await adminPool.query(
      `select relrowsecurity, relforcerowsecurity from pg_class
       where relname = 'potrero_contextos_agroclimaticos' and relnamespace = 'agx'::regnamespace`,
    );
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].relrowsecurity, true);
    assert.equal(result.rows[0].relforcerowsecurity, true);
  });

  test('agx_app tiene EXCLUSIVAMENTE SELECT/INSERT -- histórico append-only (§10 del sprint)', async () => {
    const result = await adminPool.query(
      `select privilege_type from information_schema.role_table_grants
        where table_schema = 'agx' and table_name = 'potrero_contextos_agroclimaticos' and grantee = 'agx_app'
        order by privilege_type`,
    );
    assert.deepEqual(result.rows.map((r) => r.privilege_type).sort(), ['INSERT', 'SELECT']);
  });

  test('agx_app no puede UPDATE ni DELETE un snapshot -- corregir es registrar uno nuevo', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D71S APPEND');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D71S APPEND');
    const contextoId = await insertSnapshot(org, predioId, potreroId);

    await businessDb.withOrganizacionTransaction(org, async (client) => {
      await assert.rejects(
        () => client.query('update agx.potrero_contextos_agroclimaticos set calidad = $1 where contexto_id = $2', ['x', contextoId]),
        (error) => error.code === '42501' || /permission denied/i.test(error.message),
      );
    });
    await businessDb.withOrganizacionTransaction(org, async (client) => {
      await assert.rejects(
        () => client.query('delete from agx.potrero_contextos_agroclimaticos where contexto_id = $1', [contextoId]),
        (error) => error.code === '42501' || /permission denied/i.test(error.message),
      );
    });
  });

  test('CHECK fuente_principal solo admite ERA5_LAND/IDEAM', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D71S CHECKFP');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D71S CHECKFP');
    await assert.rejects(
      () => insertSnapshot(org, predioId, potreroId, { fuente_principal: 'NASA_POWER' }),
      (error) => error.code === '23514',
    );
  });

  test('CHECK humedad_relativa_media_pct entre 0 y 100', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D71S CHECKRH');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D71S CHECKRH');
    await assert.rejects(
      () => insertSnapshot(org, predioId, potreroId, { humedad_relativa_media_pct: 101 }),
      (error) => error.code === '23514',
    );
  });

  test('FK compuesta (potrero_id, organizacion_id) -- potrero de OTRA organización rechazado', async () => {
    const orgA = randomOrgId();
    const orgB = randomOrgId();
    const predioA = await seedPredio(orgA, 'Predio Sprint3D71S FK-A');
    const potreroA = await seedPotrero(orgA, predioA, 'Potrero Sprint3D71S FK-A');

    await assert.rejects(
      () => insertSnapshot(orgB, predioA, potreroA),
      (error) => error.code === '23503',
    );
  });

  test('cross-tenant: snapshots de ORG A invisibles para ORG B (RLS)', async () => {
    const orgA = randomOrgId();
    const orgB = randomOrgId();
    const predioA = await seedPredio(orgA, 'Predio Sprint3D71S CROSS');
    const potreroA = await seedPotrero(orgA, predioA, 'Potrero Sprint3D71S CROSS');
    await insertSnapshot(orgA, predioA, potreroA);

    await businessDb.withOrganizacionTransaction(orgB, async (client) => {
      const result = await client.query('select count(*) from agx.potrero_contextos_agroclimaticos where potrero_id = $1', [potreroA]);
      assert.equal(Number(result.rows[0].count), 0);
    });
  });

  test('histórico: se pueden insertar varios snapshots para el mismo potrero (sin UNIQUE(potrero_id))', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D71S HIST');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D71S HIST');
    await insertSnapshot(org, predioId, potreroId);
    await insertSnapshot(org, predioId, potreroId);

    const result = await adminPool.query('select count(*) from agx.potrero_contextos_agroclimaticos where potrero_id = $1', [potreroId]);
    assert.equal(Number(result.rows[0].count), 2);
  });

  test('ST_PointOnSurface(geometry) del potrero cae dentro del polígono registrado', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D71S PTSURF');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D71S PTSURF');

    const result = await adminPool.query(
      `select ST_Y(ST_PointOnSurface(geometry)) as lat, ST_X(ST_PointOnSurface(geometry)) as lng,
              ST_Within(ST_PointOnSurface(geometry), geometry) as within
         from agx.potreros where potrero_id = $1`,
      [potreroId],
    );
    assert.equal(result.rows[0].within, true);
    assert.ok(result.rows[0].lat >= 1.3 && result.rows[0].lat <= 1.4);
    assert.ok(result.rows[0].lng >= -75.5 && result.rows[0].lng <= -75.4);
  });
});
