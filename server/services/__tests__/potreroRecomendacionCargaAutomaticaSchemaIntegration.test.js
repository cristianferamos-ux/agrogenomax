// SPRINT-3D10.4 -- FASE 1 del motor de carga recomendada: pruebas de la
// migración aditiva 0020_potrero_recomendacion_carga_automatica.sql contra
// un Postgres/PostGIS REAL. Mismo patrón que
// potreroRecomendacionPastoreoSchemaIntegration.test.js (0007).
//
// Cubre: columnas nuevas nullable, CHECKs individuales, CHECK de
// consistencia biconditional AUTOMATICO/no-AUTOMATICO, y que modo_calculo
// nunca se infiere retroactivamente sobre histórico (NULL permanece NULL).
//
// Lee EXCLUSIVAMENTE AGX_BUSINESS_DATABASE_URL_TEST. Ver
// db/agx-business/migrations/README.md.
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

  const columnCheck = await adminPool.query(
    `select column_name from information_schema.columns
      where table_schema = 'agx' and table_name = 'potrero_recomendaciones_pastoreo' and column_name = 'modo_calculo'`,
  );
  dbAvailable = columnCheck.rows.length > 0;
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

async function seedPasturaPersonalizada(orgId, nombre) {
  const result = await adminPool.query(
    `insert into agx.catalogo_pasturas (organizacion_id, nombre_comun, tipo, alcance)
     values ($1, $2, 'graminea', 'personalizado') returning pastura_id`,
    [orgId, nombre],
  );
  return result.rows[0].pastura_id;
}

async function seedFicha(orgId, potreroId, pasturaId) {
  const fichaResult = await adminPool.query(
    `insert into agx.potrero_fichas_productivas
       (organizacion_id, potrero_id, tipo_cobertura, nombre_principal, aforo_promedio_g_m2, fecha_aforo, biomasa_total_kg)
     values ($1, $2, 'pastura', 'Pastura Test', 500, current_date, 5000)
     returning ficha_id`,
    [orgId, potreroId],
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

// modoCalculo=undefined -> columna omitida del INSERT (simula una fila
// pre-0020: NUNCA se le asigna modo_calculo). Cualquier otro valor
// (incluido null explícito) se persiste tal cual.
async function insertRecomendacion(org, predioId, potreroId, fichaId, categoriaId, overrides = {}) {
  const v = {
    materia_seca_pct_aplicada: 20, utilizacion_pct_aplicada: 50, consumo_pct_pv_aplicado: 2.4,
    materia_seca_total_kg: 1000, materia_seca_utilizable_kg: 500, demanda_diaria_lote_kg_ms: 100.8,
    dias_ocupacion_estimados: 4.96, nivel_confianza: 'MEDIA', motor_version: 'pastoreo-auto-v1',
    modo_calculo: undefined, fecha_ingreso_prevista: null, dias_permanencia_recomendada: null,
    motivo_duracion: null, occupation_policy_version: null,
    ...overrides,
  };
  const incluyeModo = v.modo_calculo !== undefined;
  const columnas = [
    'organizacion_id', 'predio_id', 'potrero_id', 'ficha_id', 'categoria_id', 'numero_animales', 'peso_promedio_kg',
    'materia_seca_pct_aplicada', 'utilizacion_pct_aplicada', 'consumo_pct_pv_aplicado',
    'materia_seca_total_kg', 'materia_seca_utilizable_kg', 'demanda_diaria_lote_kg_ms', 'dias_ocupacion_estimados',
    'nivel_confianza', 'motor_version',
    'fecha_ingreso_prevista', 'dias_permanencia_recomendada', 'motivo_duracion', 'occupation_policy_version',
  ];
  const valores = [
    org, predioId, potreroId, fichaId, categoriaId, 10, 420,
    v.materia_seca_pct_aplicada, v.utilizacion_pct_aplicada, v.consumo_pct_pv_aplicado,
    v.materia_seca_total_kg, v.materia_seca_utilizable_kg, v.demanda_diaria_lote_kg_ms, v.dias_ocupacion_estimados,
    v.nivel_confianza, v.motor_version,
    v.fecha_ingreso_prevista, v.dias_permanencia_recomendada, v.motivo_duracion, v.occupation_policy_version,
  ];
  if (incluyeModo) {
    columnas.push('modo_calculo');
    valores.push(v.modo_calculo);
  }
  const placeholders = columnas.map((_, i) => `$${i + 1}`).join(', ');
  const result = await adminPool.query(
    `insert into agx.potrero_recomendaciones_pastoreo (${columnas.join(', ')}) values (${placeholders}) returning recomendacion_id`,
    valores,
  );
  return result.rows[0].recomendacion_id;
}

describe('SPRINT-3D10.4: la migración 0020 es aditiva pura (sin DB)', () => {
  test('0020 no hace DROP/TRUNCATE/UPDATE, no toca tablas ajenas a potrero_recomendaciones_pastoreo', () => {
    const migrationPath = path.join(repoRoot, 'db', 'agx-business', 'migrations', '0020_potrero_recomendacion_carga_automatica.sql');
    const sql = fs.readFileSync(migrationPath, 'utf8');
    assert.doesNotMatch(sql, /\bdrop\s+table\b/i);
    assert.doesNotMatch(sql, /\btruncate\s+table\b/i);
    assert.doesNotMatch(sql, /\bupdate\s+agx\./i);
    assert.doesNotMatch(sql, /\bdefault\s+'manual'/i);
    assert.doesNotMatch(sql, /catastrox/i);
    assert.match(sql, /add column if not exists fecha_ingreso_prevista date/i);
    assert.match(sql, /add column if not exists modo_calculo varchar\(20\)/i);
  });

  test('el rollback de 0020 es un DROP directo, sin dependencia de datos', () => {
    const rollbackPath = path.join(repoRoot, 'db', 'agx-business', 'migrations', '0020_potrero_recomendacion_carga_automatica_rollback.sql');
    const sql = fs.readFileSync(rollbackPath, 'utf8');
    assert.match(sql, /drop column if exists modo_calculo/i);
    assert.match(sql, /drop column if exists fecha_ingreso_prevista/i);
  });
});

describe('SPRINT-3D10.4: esquema real -- columnas y CHECKs de 0020', { skip: !dbAvailable }, () => {
  after(async () => {
    if (!adminPool) return;
    await adminPool.query(`
      delete from agx.potrero_recomendaciones_pastoreo
       where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D104S%')
    `);
    await adminPool.query(`
      delete from agx.potrero_ficha_pasturas
       where ficha_id in (
         select ficha_id from agx.potrero_fichas_productivas
          where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D104S%')
       )
    `);
    await adminPool.query(`
      delete from agx.potrero_fichas_productivas
       where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D104S%')
    `);
    await adminPool.query(`delete from agx.catalogo_pasturas where nombre_comun like 'Pastura Sprint3D104S%'`);
    await adminPool.query(`delete from agx.potreros where nombre like 'Potrero Sprint3D104S%'`);
    await adminPool.query(`delete from agx.predios where nombre_predio like 'Predio Sprint3D104S%'`);
    if (businessDb) await businessDb.closeAgxBusinessPool();
    await adminPool.end();
  });

  test('fila sembrada SIN modo_calculo (simula histórico pre-0020) queda NULL en las 5 columnas nuevas', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D104S HIST');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D104S HIST');
    const pasturaId = await seedPasturaPersonalizada(org, 'Pastura Sprint3D104S HIST');
    const fichaId = await seedFicha(org, potreroId, pasturaId);
    const categoriaId = await fetchCategoriaId('novillo_ceba');

    const recomendacionId = await insertRecomendacion(org, predioId, potreroId, fichaId, categoriaId);
    const row = await adminPool.query(
      `select modo_calculo, fecha_ingreso_prevista, dias_permanencia_recomendada, motivo_duracion, occupation_policy_version
         from agx.potrero_recomendaciones_pastoreo where recomendacion_id = $1`,
      [recomendacionId],
    );
    assert.equal(row.rows[0].modo_calculo, null);
    assert.equal(row.rows[0].fecha_ingreso_prevista, null);
    assert.equal(row.rows[0].dias_permanencia_recomendada, null);
    assert.equal(row.rows[0].motivo_duracion, null);
    assert.equal(row.rows[0].occupation_policy_version, null);
  });

  test('insert manual válido con modo_calculo=MANUAL', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D104S MANUAL');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D104S MANUAL');
    const pasturaId = await seedPasturaPersonalizada(org, 'Pastura Sprint3D104S MANUAL');
    const fichaId = await seedFicha(org, potreroId, pasturaId);
    const categoriaId = await fetchCategoriaId('novillo_ceba');

    const recomendacionId = await insertRecomendacion(org, predioId, potreroId, fichaId, categoriaId, { modo_calculo: 'MANUAL' });
    const row = await adminPool.query('select modo_calculo from agx.potrero_recomendaciones_pastoreo where recomendacion_id = $1', [recomendacionId]);
    assert.equal(row.rows[0].modo_calculo, 'MANUAL');
  });

  test('insert AUTOMATICO válido requiere las 4 columnas del motor pobladas', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D104S AUTO-OK');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D104S AUTO-OK');
    const pasturaId = await seedPasturaPersonalizada(org, 'Pastura Sprint3D104S AUTO-OK');
    const fichaId = await seedFicha(org, potreroId, pasturaId);
    const categoriaId = await fetchCategoriaId('novillo_ceba');

    const recomendacionId = await insertRecomendacion(org, predioId, potreroId, fichaId, categoriaId, {
      modo_calculo: 'AUTOMATICO',
      fecha_ingreso_prevista: '2026-09-10',
      dias_permanencia_recomendada: 3,
      motivo_duracion: 'TARGET_3_DAYS',
      occupation_policy_version: 'occupation-policy-tropical-v1',
    });
    const row = await adminPool.query(
      `select modo_calculo, dias_permanencia_recomendada, motivo_duracion, occupation_policy_version
         from agx.potrero_recomendaciones_pastoreo where recomendacion_id = $1`,
      [recomendacionId],
    );
    assert.equal(row.rows[0].modo_calculo, 'AUTOMATICO');
    assert.equal(row.rows[0].dias_permanencia_recomendada, 3);
    assert.equal(row.rows[0].motivo_duracion, 'TARGET_3_DAYS');
  });

  test('AUTOMATICO sin fecha_ingreso_prevista -> viola el CHECK de consistencia (23514)', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D104S AUTO-NOFECHA');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D104S AUTO-NOFECHA');
    const pasturaId = await seedPasturaPersonalizada(org, 'Pastura Sprint3D104S AUTO-NOFECHA');
    const fichaId = await seedFicha(org, potreroId, pasturaId);
    const categoriaId = await fetchCategoriaId('novillo_ceba');

    await assert.rejects(
      () => insertRecomendacion(org, predioId, potreroId, fichaId, categoriaId, {
        modo_calculo: 'AUTOMATICO', fecha_ingreso_prevista: null,
        dias_permanencia_recomendada: 3, motivo_duracion: 'TARGET_3_DAYS', occupation_policy_version: 'occupation-policy-tropical-v1',
      }),
      (error) => error.code === '23514',
    );
  });

  test('AUTOMATICO sin dias_permanencia_recomendada -> viola el CHECK de consistencia (23514)', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D104S AUTO-NODIAS');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D104S AUTO-NODIAS');
    const pasturaId = await seedPasturaPersonalizada(org, 'Pastura Sprint3D104S AUTO-NODIAS');
    const fichaId = await seedFicha(org, potreroId, pasturaId);
    const categoriaId = await fetchCategoriaId('novillo_ceba');

    await assert.rejects(
      () => insertRecomendacion(org, predioId, potreroId, fichaId, categoriaId, {
        modo_calculo: 'AUTOMATICO', fecha_ingreso_prevista: '2026-09-10',
        dias_permanencia_recomendada: null, motivo_duracion: 'TARGET_3_DAYS', occupation_policy_version: 'occupation-policy-tropical-v1',
      }),
      (error) => error.code === '23514',
    );
  });

  test('motivo_duracion inválido (fuera del enum) -> rechazado (23514)', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D104S MOTIVO-INVALIDO');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D104S MOTIVO-INVALIDO');
    const pasturaId = await seedPasturaPersonalizada(org, 'Pastura Sprint3D104S MOTIVO-INVALIDO');
    const fichaId = await seedFicha(org, potreroId, pasturaId);
    const categoriaId = await fetchCategoriaId('novillo_ceba');

    await assert.rejects(
      () => insertRecomendacion(org, predioId, potreroId, fichaId, categoriaId, {
        modo_calculo: 'AUTOMATICO', fecha_ingreso_prevista: '2026-09-10',
        dias_permanencia_recomendada: 3, motivo_duracion: 'CUALQUIER_COSA', occupation_policy_version: 'occupation-policy-tropical-v1',
      }),
      (error) => error.code === '23514',
    );
  });

  test('dias_permanencia_recomendada=4 -> rechazado, el CHECK solo admite 2 o 3 (nunca maxDays como valor operativo)', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D104S DIAS4');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D104S DIAS4');
    const pasturaId = await seedPasturaPersonalizada(org, 'Pastura Sprint3D104S DIAS4');
    const fichaId = await seedFicha(org, potreroId, pasturaId);
    const categoriaId = await fetchCategoriaId('novillo_ceba');

    await assert.rejects(
      () => insertRecomendacion(org, predioId, potreroId, fichaId, categoriaId, {
        modo_calculo: 'AUTOMATICO', fecha_ingreso_prevista: '2026-09-10',
        dias_permanencia_recomendada: 4, motivo_duracion: 'TARGET_3_DAYS', occupation_policy_version: 'occupation-policy-tropical-v1',
      }),
      (error) => error.code === '23514',
    );
  });

  test('MANUAL con dias_permanencia_recomendada poblado -> rechazado (campos de AUTOMATICO nunca sobre una fila no-AUTOMATICO)', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D104S MANUAL-CONTAMINADO');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D104S MANUAL-CONTAMINADO');
    const pasturaId = await seedPasturaPersonalizada(org, 'Pastura Sprint3D104S MANUAL-CONTAMINADO');
    const fichaId = await seedFicha(org, potreroId, pasturaId);
    const categoriaId = await fetchCategoriaId('novillo_ceba');

    await assert.rejects(
      () => insertRecomendacion(org, predioId, potreroId, fichaId, categoriaId, {
        modo_calculo: 'MANUAL', dias_permanencia_recomendada: 3,
      }),
      (error) => error.code === '23514',
    );
  });

  test('modo_calculo fuera del enum (ni MANUAL ni AUTOMATICO) -> rechazado (23514)', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D104S MODO-INVALIDO');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D104S MODO-INVALIDO');
    const pasturaId = await seedPasturaPersonalizada(org, 'Pastura Sprint3D104S MODO-INVALIDO');
    const fichaId = await seedFicha(org, potreroId, pasturaId);
    const categoriaId = await fetchCategoriaId('novillo_ceba');

    await assert.rejects(
      () => insertRecomendacion(org, predioId, potreroId, fichaId, categoriaId, { modo_calculo: 'OTRO' }),
      (error) => error.code === '23514',
    );
  });

  test('histórico NULL sigue permitido después de la migración (no se fuerza NOT NULL)', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D104S NULL-OK');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D104S NULL-OK');
    const pasturaId = await seedPasturaPersonalizada(org, 'Pastura Sprint3D104S NULL-OK');
    const fichaId = await seedFicha(org, potreroId, pasturaId);
    const categoriaId = await fetchCategoriaId('novillo_ceba');

    const recomendacionId = await insertRecomendacion(org, predioId, potreroId, fichaId, categoriaId, { modo_calculo: null });
    const row = await adminPool.query('select modo_calculo from agx.potrero_recomendaciones_pastoreo where recomendacion_id = $1', [recomendacionId]);
    assert.equal(row.rows[0].modo_calculo, null);
  });
});
