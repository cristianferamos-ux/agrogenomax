// SPRINT-3D8-DESCANSO-REENTRADA: pruebas de la fundación tenant-safe de
// agx.potrero_recomendaciones_descanso
// (db/agx-business/migrations/0008_potrero_descanso_reentrada.sql) contra
// un Postgres/PostGIS REAL -- mismo patrón que
// potreroRecomendacionPastoreoSchemaIntegration.test.js (0007).
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

  const tableCheck = await adminPool.query("select to_regclass('agx.potrero_recomendaciones_descanso') as t");
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

async function seedPasturaPersonalizada(orgId, nombre, tipo = 'graminea') {
  const result = await adminPool.query(
    `insert into agx.catalogo_pasturas (organizacion_id, nombre_comun, tipo, alcance)
     values ($1, $2, $3, 'personalizado') returning pastura_id`,
    [orgId, nombre, tipo],
  );
  return result.rows[0].pastura_id;
}

async function seedFicha(orgId, potreroId, pasturaId, { biomasaTotalKg = 5000 } = {}) {
  const fichaResult = await adminPool.query(
    `insert into agx.potrero_fichas_productivas
       (organizacion_id, potrero_id, tipo_cobertura, nombre_principal, aforo_promedio_g_m2, fecha_aforo, biomasa_total_kg)
     values ($1, $2, 'pastura', 'Pastura Test', 500, current_date, $3)
     returning ficha_id`,
    [orgId, potreroId, biomasaTotalKg],
  );
  const fichaId = fichaResult.rows[0].ficha_id;
  await adminPool.query(
    `insert into agx.potrero_ficha_pasturas (organizacion_id, ficha_id, pastura_id, porcentaje_estimado, orden)
     values ($1, $2, $3, 100, 0)`,
    [orgId, fichaId, pasturaId],
  );
  return fichaId;
}

async function fetchCategoriaId(codigo) {
  const result = await adminPool.query(
    'select categoria_id from agx.catalogo_categorias_productivas where codigo = $1',
    [codigo],
  );
  return result.rows[0]?.categoria_id;
}

async function insertRecomendacionPastoreo(org, predioId, potreroId, fichaId, categoriaId) {
  const result = await adminPool.query(
    `insert into agx.potrero_recomendaciones_pastoreo
       (organizacion_id, predio_id, potrero_id, ficha_id, categoria_id, numero_animales, peso_promedio_kg,
        materia_seca_pct_aplicada, utilizacion_pct_aplicada, consumo_pct_pv_aplicado,
        materia_seca_total_kg, materia_seca_utilizable_kg, demanda_diaria_lote_kg_ms, dias_ocupacion_estimados,
        nivel_confianza, motor_version)
     values ($1, $2, $3, $4, $5, 10, 420, 20, 50, 2.4, 1000, 500, 100.8, 4.96, 'MEDIA', 'pastoreo-auto-v1')
     returning recomendacion_id`,
    [org, predioId, potreroId, fichaId, categoriaId],
  );
  return result.rows[0].recomendacion_id;
}

async function insertDescanso(org, predioId, potreroId, fichaId, recomendacionId, overrides = {}) {
  const v = {
    contexto_id: null,
    previous_descanso_id: null,
    fecha_inicio_pastoreo: '2026-09-01',
    fecha_salida_estimada: '2026-09-06',
    dias_descanso_min: 25, dias_descanso_max: 35, dias_descanso_recomendado: 30,
    fecha_reingreso_min: '2026-10-01', fecha_reingreso_max: '2026-10-11', fecha_reingreso_recomendada: '2026-10-06',
    nivel_confianza: 'MEDIA', agroclimate_status: 'NORMAL', applied_rules_json: '[]', motor_version: 'descanso-v1',
    ...overrides,
  };
  const result = await adminPool.query(
    `insert into agx.potrero_recomendaciones_descanso
       (organizacion_id, predio_id, potrero_id, ficha_id, contexto_id, recomendacion_pastoreo_id, previous_descanso_id,
        fecha_inicio_pastoreo, fecha_salida_estimada,
        dias_descanso_min, dias_descanso_max, dias_descanso_recomendado,
        fecha_reingreso_min, fecha_reingreso_max, fecha_reingreso_recomendada,
        nivel_confianza, agroclimate_status, applied_rules_json, motor_version)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
     returning descanso_id`,
    [org, predioId, potreroId, fichaId, v.contexto_id, recomendacionId, v.previous_descanso_id, v.fecha_inicio_pastoreo, v.fecha_salida_estimada,
      v.dias_descanso_min, v.dias_descanso_max, v.dias_descanso_recomendado,
      v.fecha_reingreso_min, v.fecha_reingreso_max, v.fecha_reingreso_recomendada, v.nivel_confianza,
      v.agroclimate_status, v.applied_rules_json, v.motor_version],
  );
  return result.rows[0].descanso_id;
}

describe('SPRINT-3D8: legacy y sprints previos quedan intactos (sin DB)', () => {
  test('la migración 0008 es aditiva pura -- sin DROP/TRUNCATE, no toca datos de 0001-0007', () => {
    const migrationPath = path.join(repoRoot, 'db', 'agx-business', 'migrations', '0008_potrero_descanso_reentrada.sql');
    const sql = fs.readFileSync(migrationPath, 'utf8');
    assert.doesNotMatch(sql, /\bdrop\s+table\s+if\s+exists\s+agx\.(?!potrero_recomendaciones_descanso)/i);
    assert.doesNotMatch(sql, /\btruncate\s+table\b/i);
    assert.doesNotMatch(sql, /alter\s+table\s+agx\.predios\b/i);
    assert.doesNotMatch(sql, /alter\s+table\s+agx\.potreros\b/i);
    assert.doesNotMatch(sql, /alter\s+table\s+agx\.potrero_(fichas_productivas|calculos_pastoreo|contextos_agroclimaticos)\b/i);
    assert.doesNotMatch(sql, /catastrox/i);
  });

  test('server/services/ganaderia/potreroDescansoRepository.js solo usa agxBusinessPool', () => {
    const repoPath = path.join(repoRoot, 'server', 'services', 'ganaderia', 'potreroDescansoRepository.js');
    const content = fs.readFileSync(repoPath, 'utf8');
    assert.match(content, /agxBusinessPool\.js/);
    assert.doesNotMatch(content, /from ['"].*\/db\.js['"]/);
    assert.doesNotMatch(content, /DATABASE_URL/);
  });
});

describe('SPRINT-3D8: esquema real -- agx.potrero_recomendaciones_descanso', { skip: !dbAvailable }, () => {
  after(async () => {
    if (!adminPool) return;
    await adminPool.query(`
      delete from agx.potrero_climatologias_agroclimaticas
       where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D8S%')
    `);
    await adminPool.query(`
      delete from agx.potrero_recomendaciones_descanso
       where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D8S%')
    `);
    await adminPool.query(`
      delete from agx.potrero_recomendaciones_pastoreo
       where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D8S%')
    `);
    await adminPool.query(`
      delete from agx.potrero_ficha_pasturas
       where ficha_id in (
         select ficha_id from agx.potrero_fichas_productivas
          where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D8S%')
       )
    `);
    await adminPool.query(`
      delete from agx.potrero_fichas_productivas
       where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D8S%')
    `);
    await adminPool.query(`delete from agx.catalogo_pasturas where nombre_comun like 'Pastura Sprint3D8S%'`);
    await adminPool.query(`delete from agx.potreros where nombre like 'Potrero Sprint3D8S%'`);
    await adminPool.query(`delete from agx.predios where nombre_predio like 'Predio Sprint3D8S%'`);
    if (businessDb) await businessDb.closeAgxBusinessPool();
    await adminPool.end();
  });

  test('RLS ENABLE/FORCE activo', async () => {
    const result = await adminPool.query(
      `select relrowsecurity, relforcerowsecurity from pg_class
       where relname = 'potrero_recomendaciones_descanso' and relnamespace = 'agx'::regnamespace`,
    );
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].relrowsecurity, true);
    assert.equal(result.rows[0].relforcerowsecurity, true);
  });

  test('agx_app tiene EXCLUSIVAMENTE SELECT/INSERT -- append-only (§13 del sprint)', async () => {
    const result = await adminPool.query(
      `select privilege_type from information_schema.role_table_grants
        where table_schema = 'agx' and table_name = 'potrero_recomendaciones_descanso' and grantee = 'agx_app'
        order by privilege_type`,
    );
    assert.deepEqual(result.rows.map((r) => r.privilege_type).sort(), ['INSERT', 'SELECT']);
  });

  test('agx_app no puede UPDATE ni DELETE una recomendación de descanso -- corregir es registrar una nueva', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D8S APPEND');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D8S APPEND');
    const pasturaId = await seedPasturaPersonalizada(org, 'Pastura Sprint3D8S APPEND');
    const fichaId = await seedFicha(org, potreroId, pasturaId);
    const categoriaId = await fetchCategoriaId('novillo_ceba');
    const recomendacionId = await insertRecomendacionPastoreo(org, predioId, potreroId, fichaId, categoriaId);
    const descansoId = await insertDescanso(org, predioId, potreroId, fichaId, recomendacionId);

    await businessDb.withOrganizacionTransaction(org, async (client) => {
      await assert.rejects(
        () => client.query('update agx.potrero_recomendaciones_descanso set nivel_confianza = $1 where descanso_id = $2', ['ALTA', descansoId]),
        (error) => error.code === '42501' || /permission denied/i.test(error.message),
      );
    });
    await businessDb.withOrganizacionTransaction(org, async (client) => {
      await assert.rejects(
        () => client.query('delete from agx.potrero_recomendaciones_descanso where descanso_id = $1', [descansoId]),
        (error) => error.code === '42501' || /permission denied/i.test(error.message),
      );
    });
  });

  test('CHECK nivel_confianza solo admite ALTA/MEDIA/BAJA', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D8S CHECKNC');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D8S CHECKNC');
    const pasturaId = await seedPasturaPersonalizada(org, 'Pastura Sprint3D8S CHECKNC');
    const fichaId = await seedFicha(org, potreroId, pasturaId);
    const categoriaId = await fetchCategoriaId('novillo_ceba');
    const recomendacionId = await insertRecomendacionPastoreo(org, predioId, potreroId, fichaId, categoriaId);

    await assert.rejects(
      () => insertDescanso(org, predioId, potreroId, fichaId, recomendacionId, { nivel_confianza: 'MUY_ALTA' }),
      (error) => error.code === '23514',
    );
  });

  test('CHECK agroclimate_status solo admite los 5 valores del clasificador determinístico', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D8S CHECKAC');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D8S CHECKAC');
    const pasturaId = await seedPasturaPersonalizada(org, 'Pastura Sprint3D8S CHECKAC');
    const fichaId = await seedFicha(org, potreroId, pasturaId);
    const categoriaId = await fetchCategoriaId('novillo_ceba');
    const recomendacionId = await insertRecomendacionPastoreo(org, predioId, potreroId, fichaId, categoriaId);

    await assert.rejects(
      () => insertDescanso(org, predioId, potreroId, fichaId, recomendacionId, { agroclimate_status: 'MUY_BUENO' }),
      (error) => error.code === '23514',
    );
    for (const status of ['FAVORABLE', 'NORMAL', 'RESTRICTIVE', 'SEVERELY_RESTRICTIVE', 'INSUFFICIENT_DATA']) {
      const id = await insertDescanso(org, predioId, potreroId, fichaId, recomendacionId, { agroclimate_status: status });
      assert.ok(id);
    }
  });

  test('FK compuesta de autorreferencia (previous_descanso_id, potrero_id, organizacion_id) -- predecesor de OTRO potrero rechazado', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D8S FKPREV');
    const potreroA = await seedPotrero(org, predioId, 'Potrero Sprint3D8S FKPREV-A');
    const potreroB = await seedPotrero(org, predioId, 'Potrero Sprint3D8S FKPREV-B');
    const pasturaId = await seedPasturaPersonalizada(org, 'Pastura Sprint3D8S FKPREV');
    const fichaA = await seedFicha(org, potreroA, pasturaId);
    const fichaB = await seedFicha(org, potreroB, pasturaId);
    const categoriaId = await fetchCategoriaId('novillo_ceba');
    const recomendacionA = await insertRecomendacionPastoreo(org, predioId, potreroA, fichaA, categoriaId);
    const recomendacionB = await insertRecomendacionPastoreo(org, predioId, potreroB, fichaB, categoriaId);
    const descansoDeA = await insertDescanso(org, predioId, potreroA, fichaA, recomendacionA);

    await assert.rejects(
      () => insertDescanso(org, predioId, potreroB, fichaB, recomendacionB, { previous_descanso_id: descansoDeA }),
      (error) => error.code === '23503',
    );

    // Mismo potrero -- válido, encadena el histórico.
    const descansoDeA2 = await insertDescanso(org, predioId, potreroA, fichaA, recomendacionA, { previous_descanso_id: descansoDeA });
    assert.ok(descansoDeA2);
  });

  test('CHECK dias_descanso_min <= dias_descanso_recomendado <= dias_descanso_max (nunca un rango invertido)', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D8S CHECKORDEN');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D8S CHECKORDEN');
    const pasturaId = await seedPasturaPersonalizada(org, 'Pastura Sprint3D8S CHECKORDEN');
    const fichaId = await seedFicha(org, potreroId, pasturaId);
    const categoriaId = await fetchCategoriaId('novillo_ceba');
    const recomendacionId = await insertRecomendacionPastoreo(org, predioId, potreroId, fichaId, categoriaId);

    await assert.rejects(
      () => insertDescanso(org, predioId, potreroId, fichaId, recomendacionId, { dias_descanso_min: 40, dias_descanso_recomendado: 30, dias_descanso_max: 35 }),
      (error) => error.code === '23514',
    );
  });

  test('CHECK fecha_reingreso_min <= fecha_reingreso_recomendada <= fecha_reingreso_max', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D8S CHECKFECHA');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D8S CHECKFECHA');
    const pasturaId = await seedPasturaPersonalizada(org, 'Pastura Sprint3D8S CHECKFECHA');
    const fichaId = await seedFicha(org, potreroId, pasturaId);
    const categoriaId = await fetchCategoriaId('novillo_ceba');
    const recomendacionId = await insertRecomendacionPastoreo(org, predioId, potreroId, fichaId, categoriaId);

    await assert.rejects(
      () => insertDescanso(org, predioId, potreroId, fichaId, recomendacionId, {
        fecha_reingreso_min: '2026-10-15', fecha_reingreso_recomendada: '2026-10-06', fecha_reingreso_max: '2026-10-11',
      }),
      (error) => error.code === '23514',
    );
  });

  test('CHECK fecha_salida_estimada >= fecha_inicio_pastoreo', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D8S CHECKSALIDA');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D8S CHECKSALIDA');
    const pasturaId = await seedPasturaPersonalizada(org, 'Pastura Sprint3D8S CHECKSALIDA');
    const fichaId = await seedFicha(org, potreroId, pasturaId);
    const categoriaId = await fetchCategoriaId('novillo_ceba');
    const recomendacionId = await insertRecomendacionPastoreo(org, predioId, potreroId, fichaId, categoriaId);

    await assert.rejects(
      () => insertDescanso(org, predioId, potreroId, fichaId, recomendacionId, {
        fecha_inicio_pastoreo: '2026-09-10', fecha_salida_estimada: '2026-09-06',
      }),
      (error) => error.code === '23514',
    );
  });

  test('FK compuesta (recomendacion_pastoreo_id, potrero_id, organizacion_id) -- recomendación de OTRO potrero rechazada', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D8S FKREC');
    const potreroA = await seedPotrero(org, predioId, 'Potrero Sprint3D8S FKREC-A');
    const potreroB = await seedPotrero(org, predioId, 'Potrero Sprint3D8S FKREC-B');
    const pasturaId = await seedPasturaPersonalizada(org, 'Pastura Sprint3D8S FKREC');
    const fichaDeA = await seedFicha(org, potreroA, pasturaId);
    const fichaDeB = await seedFicha(org, potreroB, pasturaId);
    const categoriaId = await fetchCategoriaId('novillo_ceba');
    const recomendacionDeA = await insertRecomendacionPastoreo(org, predioId, potreroA, fichaDeA, categoriaId);

    await assert.rejects(
      () => insertDescanso(org, predioId, potreroB, fichaDeB, recomendacionDeA),
      (error) => error.code === '23503',
    );
  });

  test('cross-tenant: descansos de ORG A invisibles para ORG B (RLS)', async () => {
    const orgA = randomOrgId();
    const orgB = randomOrgId();
    const predioA = await seedPredio(orgA, 'Predio Sprint3D8S CROSS');
    const potreroA = await seedPotrero(orgA, predioA, 'Potrero Sprint3D8S CROSS');
    const pasturaId = await seedPasturaPersonalizada(orgA, 'Pastura Sprint3D8S CROSS');
    const fichaId = await seedFicha(orgA, potreroA, pasturaId);
    const categoriaId = await fetchCategoriaId('novillo_ceba');
    const recomendacionId = await insertRecomendacionPastoreo(orgA, predioA, potreroA, fichaId, categoriaId);
    await insertDescanso(orgA, predioA, potreroA, fichaId, recomendacionId);

    await businessDb.withOrganizacionTransaction(orgB, async (client) => {
      const result = await client.query('select count(*) from agx.potrero_recomendaciones_descanso where potrero_id = $1', [potreroA]);
      assert.equal(Number(result.rows[0].count), 0);
    });
  });

  test('histórico: se pueden insertar varios descansos para el mismo potrero (sin UNIQUE(potrero_id), append-only)', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D8S HIST');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D8S HIST');
    const pasturaId = await seedPasturaPersonalizada(org, 'Pastura Sprint3D8S HIST');
    const fichaId = await seedFicha(org, potreroId, pasturaId);
    const categoriaId = await fetchCategoriaId('novillo_ceba');
    const recomendacionId = await insertRecomendacionPastoreo(org, predioId, potreroId, fichaId, categoriaId);
    await insertDescanso(org, predioId, potreroId, fichaId, recomendacionId);
    await insertDescanso(org, predioId, potreroId, fichaId, recomendacionId);

    const result = await adminPool.query('select count(*) from agx.potrero_recomendaciones_descanso where potrero_id = $1', [potreroId]);
    assert.equal(Number(result.rows[0].count), 2);
  });

  // ---------------------------------------------------------------------
  // HARDENING TERRITORIAL: agx.potrero_climatologias_agroclimaticas.
  // ---------------------------------------------------------------------

  async function insertClimatologia(org, predioId, potreroId, overrides = {}) {
    const v = {
      period_start_year: 1991, period_end_year: 2020,
      soil_period_start_year: 2021, soil_period_end_year: 2025,
      method_version: 'climatology-v1', monthly_statistics_json: '{}', fuentes_json: '[]',
      ...overrides,
    };
    const result = await adminPool.query(
      `insert into agx.potrero_climatologias_agroclimaticas
         (organizacion_id, predio_id, potrero_id, period_start_year, period_end_year,
          soil_period_start_year, soil_period_end_year, method_version, monthly_statistics_json, fuentes_json)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       returning climatologia_id`,
      [org, predioId, potreroId, v.period_start_year, v.period_end_year,
        v.soil_period_start_year, v.soil_period_end_year, v.method_version, v.monthly_statistics_json, v.fuentes_json],
    );
    return result.rows[0].climatologia_id;
  }

  test('climatología: RLS ENABLE/FORCE activo', async () => {
    const result = await adminPool.query(
      `select relrowsecurity, relforcerowsecurity from pg_class
       where relname = 'potrero_climatologias_agroclimaticas' and relnamespace = 'agx'::regnamespace`,
    );
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].relrowsecurity, true);
    assert.equal(result.rows[0].relforcerowsecurity, true);
  });

  test('climatología: agx_app tiene EXCLUSIVAMENTE SELECT/INSERT -- caché append-only', async () => {
    const result = await adminPool.query(
      `select privilege_type from information_schema.role_table_grants
        where table_schema = 'agx' and table_name = 'potrero_climatologias_agroclimaticas' and grantee = 'agx_app'
        order by privilege_type`,
    );
    assert.deepEqual(result.rows.map((r) => r.privilege_type).sort(), ['INSERT', 'SELECT']);
  });

  test('climatología: agx_app no puede UPDATE ni DELETE -- refrescar es insertar una fila nueva', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D8S CLIMAAPPEND');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D8S CLIMAAPPEND');
    const climatologiaId = await insertClimatologia(org, predioId, potreroId);

    await businessDb.withOrganizacionTransaction(org, async (client) => {
      await assert.rejects(
        () => client.query('update agx.potrero_climatologias_agroclimaticas set method_version = $1 where climatologia_id = $2', ['climatology-v2', climatologiaId]),
        (error) => error.code === '42501' || /permission denied/i.test(error.message),
      );
    });
    await businessDb.withOrganizacionTransaction(org, async (client) => {
      await assert.rejects(
        () => client.query('delete from agx.potrero_climatologias_agroclimaticas where climatologia_id = $1', [climatologiaId]),
        (error) => error.code === '42501' || /permission denied/i.test(error.message),
      );
    });
  });

  test('climatología: CHECK period_end_year >= period_start_year', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D8S CLIMAPERIOD');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D8S CLIMAPERIOD');

    await assert.rejects(
      () => insertClimatologia(org, predioId, potreroId, { period_start_year: 2020, period_end_year: 1991 }),
      (error) => error.code === '23514',
    );
  });

  test('climatología: cross-tenant -- ORG A invisible para ORG B (RLS)', async () => {
    const orgA = randomOrgId();
    const orgB = randomOrgId();
    const predioA = await seedPredio(orgA, 'Predio Sprint3D8S CLIMACROSS');
    const potreroA = await seedPotrero(orgA, predioA, 'Potrero Sprint3D8S CLIMACROSS');
    await insertClimatologia(orgA, predioA, potreroA);

    await businessDb.withOrganizacionTransaction(orgB, async (client) => {
      const result = await client.query('select count(*) from agx.potrero_climatologias_agroclimaticas where potrero_id = $1', [potreroA]);
      assert.equal(Number(result.rows[0].count), 0);
    });
  });

  test('climatología: histórico append-only -- se pueden insertar varios refrescos para el mismo potrero', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D8S CLIMAHIST');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D8S CLIMAHIST');
    await insertClimatologia(org, predioId, potreroId);
    await insertClimatologia(org, predioId, potreroId);

    const result = await adminPool.query('select count(*) from agx.potrero_climatologias_agroclimaticas where potrero_id = $1', [potreroId]);
    assert.equal(Number(result.rows[0].count), 2);
  });
});
