// SPRINT-3D9.3 -- esquema real (0014-0016) contra Postgres/PostGIS REAL.
// Cubre: timestamps reales del ciclo + grant columnar ampliado,
// ternero_al_pie en PLAN (nullable, sin backfill), snapshot versionado
// (agx.potrero_ciclo_lote_real_versiones -- CHECK duración, unique
// ciclo+version, RLS FORCE, SELECT/INSERT únicamente),
// agx.potrero_ciclo_lote_real_invalidaciones (append-only, unique
// snapshot_id), y la FK de agx.potrero_recomendaciones_descanso hacia el
// snapshot vigente.
//
// Lee EXCLUSIVAMENTE AGX_BUSINESS_DATABASE_URL_TEST. Ver
// db/agx-business/migrations/README.md.
delete process.env.AGX_BUSINESS_DATABASE_URL;

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import pg from 'pg';

let dbAvailable = false;
let adminPool;

try {
  const testConnectionString = process.env.AGX_BUSINESS_DATABASE_URL_TEST;
  const adminConnectionString = process.env.AGX_BUSINESS_INTEGRATION_ADMIN_DATABASE_URL;
  if (!testConnectionString || !adminConnectionString) {
    throw new Error('AGX_BUSINESS_DATABASE_URL_TEST/AGX_BUSINESS_INTEGRATION_ADMIN_DATABASE_URL no configuradas');
  }
  adminPool = new pg.Pool({ connectionString: adminConnectionString, max: 2 });
  await adminPool.query('select 1');
  const tableCheck = await adminPool.query("select to_regclass('agx.potrero_ciclo_lote_real_versiones') as t");
  dbAvailable = Boolean(tableCheck.rows[0]?.t);
} catch {
  dbAvailable = false;
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

async function fetchCategoriaId(codigo) {
  const result = await adminPool.query('select categoria_id from agx.catalogo_categorias_productivas where codigo = $1', [codigo]);
  return result.rows[0]?.categoria_id;
}

async function seedFichaYRecomendacion(orgId, predioId, potreroId) {
  const fichaResult = await adminPool.query(
    `insert into agx.potrero_fichas_productivas (organizacion_id, potrero_id, tipo_cobertura, nombre_principal, aforo_promedio_g_m2, fecha_aforo, biomasa_total_kg)
     values ($1, $2, 'pastura', 'Test', 500, current_date, 5000) returning ficha_id`,
    [orgId, potreroId],
  );
  const fichaId = fichaResult.rows[0].ficha_id;
  const categoriaId = await fetchCategoriaId('novillo_ceba');
  const recResult = await adminPool.query(
    `insert into agx.potrero_recomendaciones_pastoreo
       (organizacion_id, predio_id, potrero_id, ficha_id, categoria_id, numero_animales, peso_promedio_kg,
        materia_seca_pct_aplicada, utilizacion_pct_aplicada, consumo_pct_pv_aplicado,
        materia_seca_total_kg, materia_seca_utilizable_kg, demanda_diaria_lote_kg_ms, dias_ocupacion_estimados,
        nivel_confianza, motor_version)
     values ($1, $2, $3, $4, $5, 10, 420, 20, 50, 2.4, 1000, 500, 100.8, 5, 'MEDIA', 'pastoreo-auto-v1')
     returning recomendacion_id`,
    [orgId, predioId, potreroId, fichaId, categoriaId],
  );
  return { fichaId, recomendacionId: recResult.rows[0].recomendacion_id };
}

async function seedCiclo(orgId, predioId, potreroId, recomendacionId) {
  const result = await adminPool.query(
    `insert into agx.potrero_ciclos_pastoreo
       (organizacion_id, predio_id, potrero_id, recomendacion_pastoreo_id, categoria_id, numero_animales_real, peso_promedio_real_kg, fecha_ingreso_real, ingreso_real_at, estado)
     values ($1, $2, $3, $4, (select categoria_id from agx.potrero_recomendaciones_pastoreo where recomendacion_id=$4), 10, 420, current_date, now(), 'EN_CURSO')
     returning ciclo_id`,
    [orgId, predioId, potreroId, recomendacionId],
  );
  return result.rows[0].ciclo_id;
}

describe('SPRINT-3D9.3: esquema real -- 0014 timestamps ciclo + ternero_al_pie PLAN', { skip: !dbAvailable }, () => {
  after(async () => {
    if (!adminPool) return;
    await adminPool.query(`delete from agx.potrero_recomendaciones_pastoreo where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D93S14%')`);
    await adminPool.query(`delete from agx.potrero_fichas_productivas where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D93S14%')`);
    await adminPool.query(`delete from agx.potreros where nombre like 'Potrero Sprint3D93S14%'`);
    await adminPool.query(`delete from agx.predios where nombre_predio like 'Predio Sprint3D93S14%'`);
  });

  test('agx.potrero_ciclos_pastoreo tiene ingreso_real_at/salida_real_at, ambas nullable', async () => {
    const cols = await adminPool.query(
      `select column_name, is_nullable from information_schema.columns
        where table_schema='agx' and table_name='potrero_ciclos_pastoreo' and column_name in ('ingreso_real_at','salida_real_at')`,
    );
    assert.equal(cols.rows.length, 2);
    for (const row of cols.rows) {
      assert.equal(row.is_nullable, 'YES');
    }
  });

  test('grant UPDATE columnar de potrero_ciclos_pastoreo incluye ingreso_real_at/salida_real_at, y conserva las columnas de 0011', async () => {
    const result = await adminPool.query(
      `select column_name from information_schema.column_privileges
        where table_schema='agx' and table_name='potrero_ciclos_pastoreo' and grantee='agx_app' and privilege_type='UPDATE'
        order by column_name`,
    );
    const columnas = result.rows.map((r) => r.column_name);
    for (const esperada of ['estado', 'fecha_salida_real', 'motivo_cancelacion', 'fecha_ingreso_real', 'categoria_id', 'numero_animales_real', 'peso_promedio_real_kg', 'motivo_anulacion', 'ingreso_real_at', 'salida_real_at']) {
      assert.ok(columnas.includes(esperada), `falta grant UPDATE sobre ${esperada}`);
    }
  });

  test('agx.potrero_recomendaciones_pastoreo tiene ternero_al_pie nullable, sin backfill (fila histórica sembrada sin el campo queda NULL)', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D93S14 A');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D93S14 A');
    const { recomendacionId } = await seedFichaYRecomendacion(org, predioId, potreroId);
    const row = await adminPool.query('select ternero_al_pie from agx.potrero_recomendaciones_pastoreo where recomendacion_id = $1', [recomendacionId]);
    assert.equal(row.rows[0].ternero_al_pie, null, 'nunca debe inferirse/backfillearse a false');
  });

  test('agx.potrero_recomendaciones_pastoreo sigue siendo append-only -- agx_app SELECT/INSERT únicamente, sin UPDATE/DELETE', async () => {
    const privs = await adminPool.query(
      `select privilege_type from information_schema.table_privileges where table_schema='agx' and table_name='potrero_recomendaciones_pastoreo' and grantee='agx_app'`,
    );
    assert.deepEqual(privs.rows.map((r) => r.privilege_type).sort(), ['INSERT', 'SELECT']);
  });
});

describe('SPRINT-3D9.3: esquema real -- 0015 snapshot versionado del lote real', { skip: !dbAvailable }, () => {
  after(async () => {
    if (!adminPool) return;
    await adminPool.query(`delete from agx.potrero_ciclo_lote_real_invalidaciones where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D93S15%')`);
    await adminPool.query(`delete from agx.potrero_ciclo_lote_real_versiones where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D93S15%')`);
    await adminPool.query(`delete from agx.potrero_ciclos_pastoreo where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D93S15%')`);
    await adminPool.query(`delete from agx.potrero_recomendaciones_pastoreo where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D93S15%')`);
    await adminPool.query(`delete from agx.potrero_fichas_productivas where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D93S15%')`);
    await adminPool.query(`delete from agx.potreros where nombre like 'Potrero Sprint3D93S15%'`);
    await adminPool.query(`delete from agx.predios where nombre_predio like 'Predio Sprint3D93S15%'`);
  });

  test('sin CHECK de duración a nivel de esquema -- una versión con salida_real_at <= ingreso_real_at SÍ puede persistirse (la capa de aplicación la clasifica como DURACION_INVALIDA -> PLAN_FALLBACK, nunca bloquea el INSERT de FASE A)', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D93S15 A');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D93S15 A');
    const { recomendacionId } = await seedFichaYRecomendacion(org, predioId, potreroId);
    const cicloId = await seedCiclo(org, predioId, potreroId, recomendacionId);
    const categoriaId = await fetchCategoriaId('novillo_ceba');
    const mismoInstante = new Date();

    const result = await adminPool.query(
      `insert into agx.potrero_ciclo_lote_real_versiones
         (organizacion_id, predio_id, potrero_id, ciclo_id, version, categoria_id, numero_animales, peso_promedio_kg, ingreso_real_at, salida_real_at)
       values ($1,$2,$3,$4,1,$5,10,420, $6, $6) returning snapshot_id`,
      [org, predioId, potreroId, cicloId, categoriaId, mismoInstante],
    );
    assert.ok(result.rows[0].snapshot_id);
  });

  test('unique(ciclo_id, version) -- duplicar la MISMA versión para el mismo ciclo es rechazado', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D93S15 B');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D93S15 B');
    const { recomendacionId } = await seedFichaYRecomendacion(org, predioId, potreroId);
    const cicloId = await seedCiclo(org, predioId, potreroId, recomendacionId);
    const categoriaId = await fetchCategoriaId('novillo_ceba');

    await adminPool.query(
      `insert into agx.potrero_ciclo_lote_real_versiones
         (organizacion_id, predio_id, potrero_id, ciclo_id, version, categoria_id, numero_animales, peso_promedio_kg, ingreso_real_at)
       values ($1,$2,$3,$4,1,$5,10,420, now())`,
      [org, predioId, potreroId, cicloId, categoriaId],
    );
    await assert.rejects(
      () => adminPool.query(
        `insert into agx.potrero_ciclo_lote_real_versiones
           (organizacion_id, predio_id, potrero_id, ciclo_id, version, categoria_id, numero_animales, peso_promedio_kg, ingreso_real_at)
         values ($1,$2,$3,$4,1,$5,12,430, now())`,
        [org, predioId, potreroId, cicloId, categoriaId],
      ),
      (error) => error.code === '23505',
    );
  });

  test('RLS ENABLE/FORCE activo, agx_app SELECT/INSERT únicamente -- NUNCA UPDATE/DELETE', async () => {
    const rls = await adminPool.query(
      `select relrowsecurity, relforcerowsecurity from pg_class where oid = 'agx.potrero_ciclo_lote_real_versiones'::regclass`,
    );
    assert.equal(rls.rows[0].relrowsecurity, true);
    assert.equal(rls.rows[0].relforcerowsecurity, true);

    const privs = await adminPool.query(
      `select privilege_type from information_schema.table_privileges where table_schema='agx' and table_name='potrero_ciclo_lote_real_versiones' and grantee='agx_app'`,
    );
    assert.deepEqual(privs.rows.map((r) => r.privilege_type).sort(), ['INSERT', 'SELECT']);
  });

  test('agx.potrero_ciclo_lote_real_invalidaciones: append-only, unique(snapshot_id), RLS FORCE', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D93S15 C');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D93S15 C');
    const { recomendacionId } = await seedFichaYRecomendacion(org, predioId, potreroId);
    const cicloId = await seedCiclo(org, predioId, potreroId, recomendacionId);
    const categoriaId = await fetchCategoriaId('novillo_ceba');
    const snapshotResult = await adminPool.query(
      `insert into agx.potrero_ciclo_lote_real_versiones
         (organizacion_id, predio_id, potrero_id, ciclo_id, version, categoria_id, numero_animales, peso_promedio_kg, ingreso_real_at)
       values ($1,$2,$3,$4,1,$5,10,420, now()) returning snapshot_id`,
      [org, predioId, potreroId, cicloId, categoriaId],
    );
    const snapshotId = snapshotResult.rows[0].snapshot_id;

    await adminPool.query(
      `insert into agx.potrero_ciclo_lote_real_invalidaciones (organizacion_id, potrero_id, snapshot_id, ciclo_id, motivo) values ($1,$2,$3,$4,'test')`,
      [org, potreroId, snapshotId, cicloId],
    );
    await assert.rejects(
      () => adminPool.query(
        `insert into agx.potrero_ciclo_lote_real_invalidaciones (organizacion_id, potrero_id, snapshot_id, ciclo_id, motivo) values ($1,$2,$3,$4,'dos veces')`,
        [org, potreroId, snapshotId, cicloId],
      ),
      (error) => error.code === '23505',
    );

    const rls = await adminPool.query(
      `select relrowsecurity, relforcerowsecurity from pg_class where oid = 'agx.potrero_ciclo_lote_real_invalidaciones'::regclass`,
    );
    assert.equal(rls.rows[0].relrowsecurity, true);
    assert.equal(rls.rows[0].relforcerowsecurity, true);

    const privs = await adminPool.query(
      `select privilege_type from information_schema.table_privileges where table_schema='agx' and table_name='potrero_ciclo_lote_real_invalidaciones' and grantee='agx_app'`,
    );
    assert.deepEqual(privs.rows.map((r) => r.privilege_type).sort(), ['INSERT', 'SELECT']);
  });
});

describe('SPRINT-3D9.3: esquema real -- 0016 FK descanso <-> snapshot real', { skip: !dbAvailable }, () => {
  test('agx.potrero_recomendaciones_descanso tiene lote_real_version_id nullable, FK hacia el snapshot', async () => {
    const cols = await adminPool.query(
      `select column_name, is_nullable from information_schema.columns
        where table_schema='agx' and table_name='potrero_recomendaciones_descanso' and column_name='lote_real_version_id'`,
    );
    assert.equal(cols.rows.length, 1);
    assert.equal(cols.rows[0].is_nullable, 'YES');

    const fk = await adminPool.query(
      `select conname from pg_constraint where conname = 'potrero_descansos_lote_real_version_fkey'`,
    );
    assert.equal(fk.rows.length, 1);
  });
});
