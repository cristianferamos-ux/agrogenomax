// SPRINT-3D7-CAPACIDAD-PASTOREO: pruebas de la fundación tenant-safe de
// agx.potrero_calculos_pastoreo (db/agx-business/migrations/0005_potrero_capacidad_pastoreo.sql)
// contra un Postgres/PostGIS REAL -- mismo patrón que
// potreroFichaProductivaSchemaIntegration.test.js (0004).
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

  const tableCheck = await adminPool.query("select to_regclass('agx.potrero_calculos_pastoreo') as t");
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

async function seedPotrero(orgId, predioId, nombre, areaHa = 1) {
  const result = await adminPool.query(
    `insert into agx.potreros (organizacion_id, predio_id, nombre, geometry, area_ha, metodo_delimitacion)
     values ($1, $2, $3, ST_GeomFromText($4, 4326), $5, 'coordenadas')
     returning potrero_id`,
    [orgId, predioId, nombre, SQUARE_WKT, areaHa],
  );
  return result.rows[0].potrero_id;
}

async function seedFicha(orgId, potreroId, nombre, biomasaTotalKg = 1000) {
  const result = await adminPool.query(
    `insert into agx.potrero_fichas_productivas
       (organizacion_id, potrero_id, tipo_cobertura, nombre_principal, aforo_promedio_g_m2, biomasa_total_kg)
     values ($1, $2, 'pastura', $3, 500, $4)
     returning ficha_id`,
    [orgId, potreroId, nombre, biomasaTotalKg],
  );
  return result.rows[0].ficha_id;
}

describe('SPRINT-3D7: legacy y sprints previos quedan intactos (sin DB)', () => {
  test('la migración 0005 es aditiva pura -- sin DROP/TRUNCATE, no toca datos de 0001/0002/0003/0004', () => {
    const migrationPath = path.join(repoRoot, 'db', 'agx-business', 'migrations', '0005_potrero_capacidad_pastoreo.sql');
    const sql = fs.readFileSync(migrationPath, 'utf8');
    assert.doesNotMatch(sql, /\bdrop\s+table\s+if\s+exists\s+agx\.(?!potrero_calculos_pastoreo)/i);
    assert.doesNotMatch(sql, /\btruncate\s+table\b/i);
    assert.doesNotMatch(sql, /alter\s+table\s+agx\.predios\b/i);
    assert.doesNotMatch(sql, /alter\s+table\s+agx\.potreros\b(?!\s+owner)/i);
    // El único ALTER permitido sobre potrero_fichas_productivas es la
    // UNIQUE ancla adicional -- nunca DROP COLUMN, DROP CONSTRAINT
    // (salvo el propio rollback, que vive en otro archivo) ni cambio de
    // tipo de columna existente. Verificado por texto (no por lookahead
    // regex) porque cada ALTER va seguido de comentarios/saltos de línea
    // de longitud variable antes de la palabra clave real.
    const alterMarker = 'alter table agx.potrero_fichas_productivas';
    let searchFrom = 0;
    let alterCount = 0;
    for (;;) {
      const idx = sql.indexOf(alterMarker, searchFrom);
      if (idx === -1) break;
      alterCount += 1;
      const after = sql.slice(idx + alterMarker.length).trimStart();
      assert.ok(
        after.startsWith('add constraint'),
        `ALTER TABLE agx.potrero_fichas_productivas debe ser únicamente "add constraint", encontrado: ${after.slice(0, 40)}`,
      );
      searchFrom = idx + alterMarker.length;
    }
    assert.equal(alterCount, 1, 'se esperaba exactamente un ALTER TABLE sobre potrero_fichas_productivas (la UNIQUE ancla)');
    assert.doesNotMatch(sql, /catastrox/i);
  });

  test('server/services/ganaderia/potreroCapacidadPastoreoRepository.js solo usa agxBusinessPool', () => {
    const repoPath = path.join(repoRoot, 'server', 'services', 'ganaderia', 'potreroCapacidadPastoreoRepository.js');
    const content = fs.readFileSync(repoPath, 'utf8');
    assert.match(content, /agxBusinessPool\.js/);
    assert.doesNotMatch(content, /from ['"].*\/db\.js['"]/);
    assert.doesNotMatch(content, /DATABASE_URL/);
  });
});

describe('SPRINT-3D7: esquema real -- capacidad de pastoreo', { skip: !dbAvailable }, () => {
  after(async () => {
    if (!adminPool) return;
    await adminPool.query(`
      delete from agx.potrero_calculos_pastoreo
       where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D7S%')
    `);
    await adminPool.query(`
      delete from agx.potrero_fichas_productivas
       where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D7S%')
    `);
    await adminPool.query(`delete from agx.potreros where nombre like 'Potrero Sprint3D7S%'`);
    await adminPool.query(`delete from agx.predios where nombre_predio like 'Predio Sprint3D7S%'`);
    if (businessDb) await businessDb.closeAgxBusinessPool();
    await adminPool.end();
  });

  test('RLS ENABLE/FORCE activo en agx.potrero_calculos_pastoreo', async () => {
    const result = await adminPool.query(
      `select relrowsecurity, relforcerowsecurity from pg_class
       where relname = 'potrero_calculos_pastoreo' and relnamespace = 'agx'::regnamespace`,
    );
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].relrowsecurity, true);
    assert.equal(result.rows[0].relforcerowsecurity, true);
  });

  test('UNIQUE ancla (ficha_id, potrero_id, organizacion_id) existe sobre potrero_fichas_productivas', async () => {
    const result = await adminPool.query(
      `select conname from pg_constraint
        where conname = 'potrero_fichas_id_potrero_organizacion_unique'
          and conrelid = 'agx.potrero_fichas_productivas'::regclass`,
    );
    assert.equal(result.rows.length, 1);
  });

  test('agx_app tiene EXCLUSIVAMENTE SELECT/INSERT -- histórico append-only (§3 del sprint)', async () => {
    const result = await adminPool.query(
      `select privilege_type from information_schema.role_table_grants
        where table_schema = 'agx' and table_name = 'potrero_calculos_pastoreo' and grantee = 'agx_app'
        order by privilege_type`,
    );
    assert.deepEqual(result.rows.map((r) => r.privilege_type).sort(), ['INSERT', 'SELECT']);
  });

  test('agx_app no puede UPDATE ni DELETE un cálculo -- corregir es registrar uno nuevo', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D7S APPEND');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D7S APPEND');
    const fichaId = await seedFicha(org, potreroId, 'Ficha Sprint3D7S APPEND');

    let calculoId;
    await businessDb.withOrganizacionTransaction(org, async (client) => {
      const result = await client.query(
        `insert into agx.potrero_calculos_pastoreo
           (organizacion_id, predio_id, potrero_id, ficha_id, modo, numero_animales, peso_vivo_promedio_kg,
            porcentaje_materia_seca, porcentaje_utilizacion, consumo_pct_peso_vivo,
            materia_seca_total_kg, materia_seca_utilizable_kg, demanda_diaria_lote_kg_ms, dias_ocupacion_estimados)
         values ($1, $2, $3, $4, 'dias_ocupacion', 20, 450, 25, 50, 2.5, 250, 125, 225, 0.55)
         returning calculo_id`,
        [org, predioId, potreroId, fichaId],
      );
      calculoId = result.rows[0].calculo_id;
    });

    await businessDb.withOrganizacionTransaction(org, async (client) => {
      await assert.rejects(
        () => client.query('update agx.potrero_calculos_pastoreo set observaciones = $1 where calculo_id = $2', ['x', calculoId]),
        (error) => error.code === '42501' || /permission denied/i.test(error.message),
      );
    });
    await businessDb.withOrganizacionTransaction(org, async (client) => {
      await assert.rejects(
        () => client.query('delete from agx.potrero_calculos_pastoreo where calculo_id = $1', [calculoId]),
        (error) => error.code === '42501' || /permission denied/i.test(error.message),
      );
    });
  });

  test('CHECK de consistencia modo/campos: modo=dias_ocupacion con periodo_objetivo_dias poblado -> rechazado', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D7S CHECKMODO');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D7S CHECKMODO');
    const fichaId = await seedFicha(org, potreroId, 'Ficha Sprint3D7S CHECKMODO');

    await businessDb.withOrganizacionTransaction(org, async (client) => {
      await assert.rejects(
        () => client.query(
          `insert into agx.potrero_calculos_pastoreo
             (organizacion_id, predio_id, potrero_id, ficha_id, modo, numero_animales, periodo_objetivo_dias,
              peso_vivo_promedio_kg, porcentaje_materia_seca, porcentaje_utilizacion, consumo_pct_peso_vivo,
              materia_seca_total_kg, materia_seca_utilizable_kg, demanda_diaria_lote_kg_ms, dias_ocupacion_estimados)
           values ($1, $2, $3, $4, 'dias_ocupacion', 20, 1, 450, 25, 50, 2.5, 250, 125, 225, 0.55)`,
          [org, predioId, potreroId, fichaId],
        ),
        (error) => error.code === '23514',
      );
    });
  });

  test('CHECK de guardrails: peso_vivo_promedio_kg > 2000, numero_animales > 100000, periodo_objetivo_dias > 365, consumo > 10', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D7S CHECKGUARD');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D7S CHECKGUARD');
    const fichaId = await seedFicha(org, potreroId, 'Ficha Sprint3D7S CHECKGUARD');

    async function expectCheckViolation(overrides) {
      await businessDb.withOrganizacionTransaction(org, async (client) => {
        const base = {
          numero_animales: 20, peso_vivo_promedio_kg: 450, porcentaje_materia_seca: 25,
          porcentaje_utilizacion: 50, consumo_pct_peso_vivo: 2.5, ...overrides,
        };
        await assert.rejects(
          () => client.query(
            `insert into agx.potrero_calculos_pastoreo
               (organizacion_id, predio_id, potrero_id, ficha_id, modo, numero_animales, peso_vivo_promedio_kg,
                porcentaje_materia_seca, porcentaje_utilizacion, consumo_pct_peso_vivo,
                materia_seca_total_kg, materia_seca_utilizable_kg, demanda_diaria_lote_kg_ms, dias_ocupacion_estimados)
             values ($1, $2, $3, $4, 'dias_ocupacion', $5, $6, $7, $8, $9, 250, 125, 225, 0.55)`,
            [org, predioId, potreroId, fichaId, base.numero_animales, base.peso_vivo_promedio_kg,
              base.porcentaje_materia_seca, base.porcentaje_utilizacion, base.consumo_pct_peso_vivo],
          ),
          (error) => error.code === '23514',
        );
      });
    }

    await expectCheckViolation({ peso_vivo_promedio_kg: 2001 });
    await expectCheckViolation({ numero_animales: 100001 });
    await expectCheckViolation({ consumo_pct_peso_vivo: 10.1 });
  });

  test('FK compuesta (ficha_id, potrero_id, organizacion_id) -- ficha de OTRO potrero de la MISMA organización rechazada', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D7S XFICHA');
    const potreroA = await seedPotrero(org, predioId, 'Potrero Sprint3D7S XFICHA-A');
    const potreroB = await seedPotrero(org, predioId, 'Potrero Sprint3D7S XFICHA-B');
    const fichaDePotreroB = await seedFicha(org, potreroB, 'Ficha Sprint3D7S XFICHA-B');

    await businessDb.withOrganizacionTransaction(org, async (client) => {
      await assert.rejects(
        () => client.query(
          `insert into agx.potrero_calculos_pastoreo
             (organizacion_id, predio_id, potrero_id, ficha_id, modo, numero_animales, peso_vivo_promedio_kg,
              porcentaje_materia_seca, porcentaje_utilizacion, consumo_pct_peso_vivo,
              materia_seca_total_kg, materia_seca_utilizable_kg, demanda_diaria_lote_kg_ms, dias_ocupacion_estimados)
           values ($1, $2, $3, $4, 'dias_ocupacion', 20, 450, 25, 50, 2.5, 250, 125, 225, 0.55)`,
          [org, predioId, potreroA, fichaDePotreroB],
        ),
        (error) => error.code === '23503',
      );
    });
  });

  test('FK compuesta (potrero_id, organizacion_id) -- potrero de OTRA organización rechazado por integridad referencial', async () => {
    const orgA = randomOrgId();
    const orgB = randomOrgId();
    const predioA = await seedPredio(orgA, 'Predio Sprint3D7S FK-A');
    const potreroA = await seedPotrero(orgA, predioA, 'Potrero Sprint3D7S FK-A');
    const fichaA = await seedFicha(orgA, potreroA, 'Ficha Sprint3D7S FK-A');

    await businessDb.withOrganizacionTransaction(orgB, async (client) => {
      await assert.rejects(
        () => client.query(
          `insert into agx.potrero_calculos_pastoreo
             (organizacion_id, predio_id, potrero_id, ficha_id, modo, numero_animales, peso_vivo_promedio_kg,
              porcentaje_materia_seca, porcentaje_utilizacion, consumo_pct_peso_vivo,
              materia_seca_total_kg, materia_seca_utilizable_kg, demanda_diaria_lote_kg_ms, dias_ocupacion_estimados)
           values ($1, $2, $3, $4, 'dias_ocupacion', 20, 450, 25, 50, 2.5, 250, 125, 225, 0.55)`,
          [orgB, predioA, potreroA, fichaA],
        ),
        (error) => error.code === '23503',
      );
    });
  });

  test('cross-tenant: cálculos de ORG A invisibles para ORG B (RLS)', async () => {
    const orgA = randomOrgId();
    const orgB = randomOrgId();
    const predioA = await seedPredio(orgA, 'Predio Sprint3D7S CROSS');
    const potreroA = await seedPotrero(orgA, predioA, 'Potrero Sprint3D7S CROSS');
    const fichaA = await seedFicha(orgA, potreroA, 'Ficha Sprint3D7S CROSS');

    await businessDb.withOrganizacionTransaction(orgA, async (client) => {
      await client.query(
        `insert into agx.potrero_calculos_pastoreo
           (organizacion_id, predio_id, potrero_id, ficha_id, modo, numero_animales, peso_vivo_promedio_kg,
            porcentaje_materia_seca, porcentaje_utilizacion, consumo_pct_peso_vivo,
            materia_seca_total_kg, materia_seca_utilizable_kg, demanda_diaria_lote_kg_ms, dias_ocupacion_estimados)
         values ($1, $2, $3, $4, 'dias_ocupacion', 20, 450, 25, 50, 2.5, 250, 125, 225, 0.55)`,
        [orgA, predioA, potreroA, fichaA],
      );
    });

    await businessDb.withOrganizacionTransaction(orgB, async (client) => {
      const result = await client.query('select count(*) from agx.potrero_calculos_pastoreo where potrero_id = $1', [potreroA]);
      assert.equal(Number(result.rows[0].count), 0);
    });
  });

  test('histórico: se pueden insertar varios cálculos para el mismo potrero (sin UNIQUE(potrero_id))', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D7S HIST');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D7S HIST');
    const fichaId = await seedFicha(org, potreroId, 'Ficha Sprint3D7S HIST');

    await businessDb.withOrganizacionTransaction(org, async (client) => {
      for (let i = 0; i < 2; i += 1) {
        await client.query(
          `insert into agx.potrero_calculos_pastoreo
             (organizacion_id, predio_id, potrero_id, ficha_id, modo, numero_animales, peso_vivo_promedio_kg,
              porcentaje_materia_seca, porcentaje_utilizacion, consumo_pct_peso_vivo,
              materia_seca_total_kg, materia_seca_utilizable_kg, demanda_diaria_lote_kg_ms, dias_ocupacion_estimados)
           values ($1, $2, $3, $4, 'dias_ocupacion', 20, 450, 25, 50, 2.5, 250, 125, 225, 0.55)`,
          [org, predioId, potreroId, fichaId],
        );
      }
      const result = await client.query('select count(*) from agx.potrero_calculos_pastoreo where potrero_id = $1', [potreroId]);
      assert.equal(Number(result.rows[0].count), 2);
    });
  });
});
