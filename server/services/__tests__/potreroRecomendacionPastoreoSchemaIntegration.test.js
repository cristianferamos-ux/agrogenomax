// SPRINT-3D7.2-RECOMENDACION-PASTOREO-AUTO: pruebas de la fundación
// tenant-safe de agx.catalogo_categorias_productivas y
// agx.potrero_recomendaciones_pastoreo
// (db/agx-business/migrations/0007_potrero_recomendacion_pastoreo.sql)
// contra un Postgres/PostGIS REAL -- mismo patrón que
// potreroContextoAgroclimaticoSchemaIntegration.test.js (0006).
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

  const tableCheck = await adminPool.query("select to_regclass('agx.potrero_recomendaciones_pastoreo') as t");
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

async function insertRecomendacion(org, predioId, potreroId, fichaId, categoriaId, overrides = {}) {
  const v = {
    dias_en_leche: null,
    grasa_leche_pct: null,
    materia_seca_pct_aplicada: 20, utilizacion_pct_aplicada: 50, consumo_pct_pv_aplicado: 2.4,
    materia_seca_total_kg: 1000, materia_seca_utilizable_kg: 500, demanda_diaria_lote_kg_ms: 100.8,
    dias_ocupacion_estimados: 4.96, nivel_confianza: 'MEDIA', motor_version: 'pastoreo-auto-v1',
    ...overrides,
  };
  const result = await adminPool.query(
    `insert into agx.potrero_recomendaciones_pastoreo
       (organizacion_id, predio_id, potrero_id, ficha_id, categoria_id, numero_animales, peso_promedio_kg,
        dias_en_leche, grasa_leche_pct, materia_seca_pct_aplicada, utilizacion_pct_aplicada, consumo_pct_pv_aplicado,
        materia_seca_total_kg, materia_seca_utilizable_kg, demanda_diaria_lote_kg_ms, dias_ocupacion_estimados,
        nivel_confianza, motor_version)
     values ($1, $2, $3, $4, $5, 10, 420, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     returning recomendacion_id`,
    [org, predioId, potreroId, fichaId, categoriaId, v.dias_en_leche, v.grasa_leche_pct, v.materia_seca_pct_aplicada, v.utilizacion_pct_aplicada,
      v.consumo_pct_pv_aplicado, v.materia_seca_total_kg, v.materia_seca_utilizable_kg, v.demanda_diaria_lote_kg_ms,
      v.dias_ocupacion_estimados, v.nivel_confianza, v.motor_version],
  );
  return result.rows[0].recomendacion_id;
}

describe('SPRINT-3D7.2: legacy y sprints previos quedan intactos (sin DB)', () => {
  test('la migración 0007 es aditiva pura -- sin DROP/TRUNCATE, no toca datos de 0001-0006', () => {
    const migrationPath = path.join(repoRoot, 'db', 'agx-business', 'migrations', '0007_potrero_recomendacion_pastoreo.sql');
    const sql = fs.readFileSync(migrationPath, 'utf8');
    assert.doesNotMatch(sql, /\bdrop\s+table\s+if\s+exists\s+agx\.(?!(potrero_recomendaciones_pastoreo|catalogo_categorias_productivas))/i);
    assert.doesNotMatch(sql, /\btruncate\s+table\b/i);
    assert.doesNotMatch(sql, /alter\s+table\s+agx\.predios\b/i);
    assert.doesNotMatch(sql, /alter\s+table\s+agx\.potreros\b/i);
    assert.doesNotMatch(sql, /alter\s+table\s+agx\.potrero_(fichas_productivas|calculos_pastoreo)\b/i);
    assert.doesNotMatch(sql, /catastrox/i);
  });

  test('server/services/ganaderia/potreroRecomendacionPastoreoRepository.js solo usa agxBusinessPool', () => {
    const repoPath = path.join(repoRoot, 'server', 'services', 'ganaderia', 'potreroRecomendacionPastoreoRepository.js');
    const content = fs.readFileSync(repoPath, 'utf8');
    assert.match(content, /agxBusinessPool\.js/);
    assert.doesNotMatch(content, /from ['"].*\/db\.js['"]/);
    assert.doesNotMatch(content, /DATABASE_URL/);
  });
});

describe('SPRINT-3D7.2: esquema real -- catálogo de categorías + recomendaciones', { skip: !dbAvailable }, () => {
  after(async () => {
    if (!adminPool) return;
    await adminPool.query(`
      delete from agx.potrero_recomendaciones_pastoreo
       where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D72S%')
    `);
    await adminPool.query(`
      delete from agx.potrero_ficha_pasturas
       where ficha_id in (
         select ficha_id from agx.potrero_fichas_productivas
          where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D72S%')
       )
    `);
    await adminPool.query(`
      delete from agx.potrero_fichas_productivas
       where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D72S%')
    `);
    await adminPool.query(`delete from agx.catalogo_pasturas where nombre_comun like 'Pastura Sprint3D72S%'`);
    await adminPool.query(`delete from agx.potreros where nombre like 'Potrero Sprint3D72S%'`);
    await adminPool.query(`delete from agx.predios where nombre_predio like 'Predio Sprint3D72S%'`);
    if (businessDb) await businessDb.closeAgxBusinessPool();
    await adminPool.end();
  });

  test('catálogo de categorías: seed de sistema tiene 13 filas activas, todas organizacion_id NULL', async () => {
    const result = await adminPool.query(
      `select count(*) from agx.catalogo_categorias_productivas where organizacion_id is null and activo = true`,
    );
    assert.equal(Number(result.rows[0].count), 13);
  });

  test('RLS ENABLE/FORCE activo en ambas tablas', async () => {
    const result = await adminPool.query(
      `select relname, relrowsecurity, relforcerowsecurity from pg_class
       where relname in ('catalogo_categorias_productivas', 'potrero_recomendaciones_pastoreo')
         and relnamespace = 'agx'::regnamespace`,
    );
    assert.equal(result.rows.length, 2);
    for (const row of result.rows) {
      assert.equal(row.relrowsecurity, true, `${row.relname} debía tener RLS ENABLE`);
      assert.equal(row.relforcerowsecurity, true, `${row.relname} debía tener RLS FORCE`);
    }
  });

  test('agx_app tiene SOLO SELECT en catalogo_categorias_productivas (v1 sin custom, §3 del sprint)', async () => {
    const result = await adminPool.query(
      `select privilege_type from information_schema.role_table_grants
        where table_schema = 'agx' and table_name = 'catalogo_categorias_productivas' and grantee = 'agx_app'
        order by privilege_type`,
    );
    assert.deepEqual(result.rows.map((r) => r.privilege_type).sort(), ['SELECT']);
  });

  test('agx_app tiene EXCLUSIVAMENTE SELECT/INSERT en potrero_recomendaciones_pastoreo -- append-only (§13 del sprint)', async () => {
    const result = await adminPool.query(
      `select privilege_type from information_schema.role_table_grants
        where table_schema = 'agx' and table_name = 'potrero_recomendaciones_pastoreo' and grantee = 'agx_app'
        order by privilege_type`,
    );
    assert.deepEqual(result.rows.map((r) => r.privilege_type).sort(), ['INSERT', 'SELECT']);
  });

  test('agx_app no puede UPDATE ni DELETE una recomendación -- corregir es registrar una nueva', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D72S APPEND');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D72S APPEND');
    const pasturaId = await seedPasturaPersonalizada(org, 'Pastura Sprint3D72S APPEND');
    const fichaId = await seedFicha(org, potreroId, pasturaId);
    const categoriaId = await fetchCategoriaId('novillo_ceba');
    const recomendacionId = await insertRecomendacion(org, predioId, potreroId, fichaId, categoriaId);

    await businessDb.withOrganizacionTransaction(org, async (client) => {
      await assert.rejects(
        () => client.query('update agx.potrero_recomendaciones_pastoreo set nivel_confianza = $1 where recomendacion_id = $2', ['ALTA', recomendacionId]),
        (error) => error.code === '42501' || /permission denied/i.test(error.message),
      );
    });
    await businessDb.withOrganizacionTransaction(org, async (client) => {
      await assert.rejects(
        () => client.query('delete from agx.potrero_recomendaciones_pastoreo where recomendacion_id = $1', [recomendacionId]),
        (error) => error.code === '42501' || /permission denied/i.test(error.message),
      );
    });
  });

  test('CHECK nivel_confianza solo admite ALTA/MEDIA/BAJA', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D72S CHECKNC');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D72S CHECKNC');
    const pasturaId = await seedPasturaPersonalizada(org, 'Pastura Sprint3D72S CHECKNC');
    const fichaId = await seedFicha(org, potreroId, pasturaId);
    const categoriaId = await fetchCategoriaId('novillo_ceba');

    await assert.rejects(
      () => insertRecomendacion(org, predioId, potreroId, fichaId, categoriaId, { nivel_confianza: 'MUY_ALTA' }),
      (error) => error.code === '23514',
    );
  });

  test('CHECK dias_en_leche entre 0 y 500 (hardening ronda 3 §1/§3 -- input de la ecuación NRC 2001)', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D72S CHECKDEL');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D72S CHECKDEL');
    const pasturaId = await seedPasturaPersonalizada(org, 'Pastura Sprint3D72S CHECKDEL');
    const fichaId = await seedFicha(org, potreroId, pasturaId);
    const categoriaId = await fetchCategoriaId('vaca_leche_produccion');

    await assert.rejects(
      () => insertRecomendacion(org, predioId, potreroId, fichaId, categoriaId, { dias_en_leche: -1 }),
      (error) => error.code === '23514',
    );
    await assert.rejects(
      () => insertRecomendacion(org, predioId, potreroId, fichaId, categoriaId, { dias_en_leche: 501 }),
      (error) => error.code === '23514',
    );
    const recomendacionId = await insertRecomendacion(org, predioId, potreroId, fichaId, categoriaId, { dias_en_leche: 90 });
    const check = await adminPool.query('select dias_en_leche from agx.potrero_recomendaciones_pastoreo where recomendacion_id = $1', [recomendacionId]);
    assert.equal(Number(check.rows[0].dias_en_leche), 90);
  });

  test('vaca_leche_produccion referencia NRC_2001_DAIRY_DMI (no un coeficiente inventado) -- fuente honesta en metadata_tecnica (hardening §1/§3)', async () => {
    const result = await adminPool.query(
      `select metadata_tecnica->>'fuente' as fuente, metadata_tecnica->>'fuente_tipo' as tipo
         from agx.catalogo_categorias_productivas where codigo = 'vaca_leche_produccion'`,
    );
    assert.equal(result.rows[0].fuente, 'NRC_2001_DAIRY_DMI');
    assert.equal(result.rows[0].tipo, 'ADAPTED');
  });

  test('CHECK grasa_leche_pct entre 0 (exclusivo) y 10 (hardening ronda 4 §4 -- input opcional)', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D72S CHECKGRASA');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D72S CHECKGRASA');
    const pasturaId = await seedPasturaPersonalizada(org, 'Pastura Sprint3D72S CHECKGRASA');
    const fichaId = await seedFicha(org, potreroId, pasturaId);
    const categoriaId = await fetchCategoriaId('vaca_leche_produccion');

    await assert.rejects(
      () => insertRecomendacion(org, predioId, potreroId, fichaId, categoriaId, { grasa_leche_pct: 0 }),
      (error) => error.code === '23514',
    );
    await assert.rejects(
      () => insertRecomendacion(org, predioId, potreroId, fichaId, categoriaId, { grasa_leche_pct: 10.1 }),
      (error) => error.code === '23514',
    );
    const recomendacionId = await insertRecomendacion(org, predioId, potreroId, fichaId, categoriaId, { grasa_leche_pct: 3.8 });
    const check = await adminPool.query('select grasa_leche_pct from agx.potrero_recomendaciones_pastoreo where recomendacion_id = $1', [recomendacionId]);
    assert.equal(Number(check.rows[0].grasa_leche_pct), 3.8);
  });

  test('FK compuesta (ficha_id, potrero_id, organizacion_id) -- ficha de OTRO potrero rechazada', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D72S FKFICHA');
    const potreroA = await seedPotrero(org, predioId, 'Potrero Sprint3D72S FKFICHA-A');
    const potreroB = await seedPotrero(org, predioId, 'Potrero Sprint3D72S FKFICHA-B');
    const pasturaId = await seedPasturaPersonalizada(org, 'Pastura Sprint3D72S FKFICHA');
    const fichaDeA = await seedFicha(org, potreroA, pasturaId);
    const categoriaId = await fetchCategoriaId('novillo_ceba');

    await assert.rejects(
      () => insertRecomendacion(org, predioId, potreroB, fichaDeA, categoriaId),
      (error) => error.code === '23503',
    );
  });

  test('FK categoria_id -- categoría inexistente rechazada', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D72S FKCAT');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D72S FKCAT');
    const pasturaId = await seedPasturaPersonalizada(org, 'Pastura Sprint3D72S FKCAT');
    const fichaId = await seedFicha(org, potreroId, pasturaId);

    await assert.rejects(
      () => insertRecomendacion(org, predioId, potreroId, fichaId, 999999999),
      (error) => error.code === '23503',
    );
  });

  test('cross-tenant: recomendaciones de ORG A invisibles para ORG B (RLS)', async () => {
    const orgA = randomOrgId();
    const orgB = randomOrgId();
    const predioA = await seedPredio(orgA, 'Predio Sprint3D72S CROSS');
    const potreroA = await seedPotrero(orgA, predioA, 'Potrero Sprint3D72S CROSS');
    const pasturaId = await seedPasturaPersonalizada(orgA, 'Pastura Sprint3D72S CROSS');
    const fichaId = await seedFicha(orgA, potreroA, pasturaId);
    const categoriaId = await fetchCategoriaId('novillo_ceba');
    await insertRecomendacion(orgA, predioA, potreroA, fichaId, categoriaId);

    await businessDb.withOrganizacionTransaction(orgB, async (client) => {
      const result = await client.query('select count(*) from agx.potrero_recomendaciones_pastoreo where potrero_id = $1', [potreroA]);
      assert.equal(Number(result.rows[0].count), 0);
    });
  });

  test('catálogo de categorías (sistema) SÍ es visible para cualquier organización (RLS de lectura)', async () => {
    const org = randomOrgId();
    await businessDb.withOrganizacionTransaction(org, async (client) => {
      const result = await client.query('select count(*) from agx.catalogo_categorias_productivas where codigo = $1', ['novillo_ceba']);
      assert.equal(Number(result.rows[0].count), 1);
    });
  });

  test('histórico: se pueden insertar varias recomendaciones para el mismo potrero (sin UNIQUE(potrero_id))', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D72S HIST');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D72S HIST');
    const pasturaId = await seedPasturaPersonalizada(org, 'Pastura Sprint3D72S HIST');
    const fichaId = await seedFicha(org, potreroId, pasturaId);
    const categoriaId = await fetchCategoriaId('novillo_ceba');
    await insertRecomendacion(org, predioId, potreroId, fichaId, categoriaId);
    await insertRecomendacion(org, predioId, potreroId, fichaId, categoriaId);

    const result = await adminPool.query('select count(*) from agx.potrero_recomendaciones_pastoreo where potrero_id = $1', [potreroId]);
    assert.equal(Number(result.rows[0].count), 2);
  });
});
