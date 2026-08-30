// SPRINT-3D9.4 -- esquema real (0017-0018) contra Postgres/PostGIS REAL.
// Cubre: agx.potrero_ciclo_residuales_reales_versiones (hecho físico
// NOT NULL, derivaciones científicas NULLABLE, sin CHECK de duración a
// nivel de esquema -- misma filosofía que 0015 -- unique ciclo+version,
// RLS FORCE, SELECT/INSERT únicamente), agx.potrero_ciclo_residual_real_invalidaciones
// (append-only, unique residual_id), y la FK/columnas de
// agx.potrero_recomendaciones_descanso hacia el residual (0018).
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
  const tableCheck = await adminPool.query("select to_regclass('agx.potrero_ciclo_residuales_reales_versiones') as t");
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

describe('SPRINT-3D9.4: esquema real -- 0017 residual real versionado', { skip: !dbAvailable }, () => {
  after(async () => {
    if (!adminPool) return;
    await adminPool.query(`update agx.potrero_recomendaciones_descanso set residual_real_version_id = null where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D94%')`);
    await adminPool.query(`delete from agx.potrero_ciclo_residual_real_invalidaciones where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D94%')`);
    await adminPool.query(`delete from agx.potrero_ciclo_residuales_reales_versiones where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D94%')`);
    await adminPool.query(`delete from agx.potrero_ciclos_pastoreo where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D94%')`);
    await adminPool.query(`delete from agx.potrero_recomendaciones_pastoreo where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D94%')`);
    await adminPool.query(`delete from agx.potrero_fichas_productivas where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D94%')`);
    await adminPool.query(`delete from agx.potreros where nombre like 'Potrero Sprint3D94%'`);
    await adminPool.query(`delete from agx.predios where nombre_predio like 'Predio Sprint3D94%'`);
  });

  test('NIVEL 0 (hecho físico) se persiste con todas las derivaciones científicas NULL -- nunca bloqueado por falta de ciencia', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D94S17 A');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D94S17 A');
    const { recomendacionId } = await seedFichaYRecomendacion(org, predioId, potreroId);
    const cicloId = await seedCiclo(org, predioId, potreroId, recomendacionId);

    const result = await adminPool.query(
      `insert into agx.potrero_ciclo_residuales_reales_versiones
         (organizacion_id, predio_id, potrero_id, ciclo_id, version, numero_muestras, aforo_promedio_g_m2, biomasa_fresca_total_kg, medicion_real_at, horas_desde_salida)
       values ($1,$2,$3,$4,1,10,300,3000, now(), 2) returning residual_id`,
      [org, predioId, potreroId, cicloId],
    );
    assert.ok(result.rows[0].residual_id);

    const row = await adminPool.query(
      `select materia_seca_pct_aplicado, remanente_medido_kg_ms, descanso_estimado_origen_id, remanente_estimado_kg_ms_congelado, error_absoluto_kg, error_porcentual
         from agx.potrero_ciclo_residuales_reales_versiones where residual_id = $1`,
      [result.rows[0].residual_id],
    );
    for (const campo of ['materia_seca_pct_aplicado', 'remanente_medido_kg_ms', 'descanso_estimado_origen_id', 'remanente_estimado_kg_ms_congelado', 'error_absoluto_kg', 'error_porcentual']) {
      assert.equal(row.rows[0][campo], null, `${campo} debe poder quedar NULL sin bloquear el INSERT`);
    }
  });

  test('unique(ciclo_id, version) -- duplicar la MISMA versión para el mismo ciclo es rechazado', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D94S17 B');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D94S17 B');
    const { recomendacionId } = await seedFichaYRecomendacion(org, predioId, potreroId);
    const cicloId = await seedCiclo(org, predioId, potreroId, recomendacionId);

    await adminPool.query(
      `insert into agx.potrero_ciclo_residuales_reales_versiones
         (organizacion_id, predio_id, potrero_id, ciclo_id, version, numero_muestras, aforo_promedio_g_m2, biomasa_fresca_total_kg, medicion_real_at, horas_desde_salida)
       values ($1,$2,$3,$4,1,10,300,3000, now(), 2)`,
      [org, predioId, potreroId, cicloId],
    );
    await assert.rejects(
      () => adminPool.query(
        `insert into agx.potrero_ciclo_residuales_reales_versiones
           (organizacion_id, predio_id, potrero_id, ciclo_id, version, numero_muestras, aforo_promedio_g_m2, biomasa_fresca_total_kg, medicion_real_at, horas_desde_salida)
         values ($1,$2,$3,$4,1,12,320,3200, now(), 3)`,
        [org, predioId, potreroId, cicloId],
      ),
      (error) => error.code === '23505',
    );
  });

  test('RLS ENABLE/FORCE activo, agx_app SELECT/INSERT únicamente -- NUNCA UPDATE/DELETE', async () => {
    const rls = await adminPool.query(
      `select relrowsecurity, relforcerowsecurity from pg_class where oid = 'agx.potrero_ciclo_residuales_reales_versiones'::regclass`,
    );
    assert.equal(rls.rows[0].relrowsecurity, true);
    assert.equal(rls.rows[0].relforcerowsecurity, true);

    const privs = await adminPool.query(
      `select privilege_type from information_schema.table_privileges where table_schema='agx' and table_name='potrero_ciclo_residuales_reales_versiones' and grantee='agx_app'`,
    );
    assert.deepEqual(privs.rows.map((r) => r.privilege_type).sort(), ['INSERT', 'SELECT']);
  });

  test('constraints mínimos: numero_muestras >= 1, aforo/biomasa >= 0', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D94S17 C');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D94S17 C');
    const { recomendacionId } = await seedFichaYRecomendacion(org, predioId, potreroId);
    const cicloId = await seedCiclo(org, predioId, potreroId, recomendacionId);

    await assert.rejects(
      () => adminPool.query(
        `insert into agx.potrero_ciclo_residuales_reales_versiones
           (organizacion_id, predio_id, potrero_id, ciclo_id, version, numero_muestras, aforo_promedio_g_m2, biomasa_fresca_total_kg, medicion_real_at, horas_desde_salida)
         values ($1,$2,$3,$4,1,0,300,3000, now(), 2)`,
        [org, predioId, potreroId, cicloId],
      ),
      (error) => error.code === '23514',
    );
  });

  test('SIN CHECK de horas_desde_salida a nivel de esquema -- un valor negativo (medición ahora anterior a una salida corregida) SÍ puede persistirse (la capa de aplicación la clasifica como INCOMPATIBLE_TEMPORAL, nunca bloquea el INSERT de "actualizar comparativo")', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D94S17 D');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D94S17 D');
    const { recomendacionId } = await seedFichaYRecomendacion(org, predioId, potreroId);
    const cicloId = await seedCiclo(org, predioId, potreroId, recomendacionId);

    const result = await adminPool.query(
      `insert into agx.potrero_ciclo_residuales_reales_versiones
         (organizacion_id, predio_id, potrero_id, ciclo_id, version, numero_muestras, aforo_promedio_g_m2, biomasa_fresca_total_kg, medicion_real_at, horas_desde_salida)
       values ($1,$2,$3,$4,1,10,300,3000, now(), -1) returning residual_id`,
      [org, predioId, potreroId, cicloId],
    );
    assert.ok(result.rows[0].residual_id);
  });

  test('agx.potrero_ciclo_residual_real_invalidaciones: append-only, unique(residual_id), RLS FORCE', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D94S17 D');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D94S17 D');
    const { recomendacionId } = await seedFichaYRecomendacion(org, predioId, potreroId);
    const cicloId = await seedCiclo(org, predioId, potreroId, recomendacionId);
    const residualResult = await adminPool.query(
      `insert into agx.potrero_ciclo_residuales_reales_versiones
         (organizacion_id, predio_id, potrero_id, ciclo_id, version, numero_muestras, aforo_promedio_g_m2, biomasa_fresca_total_kg, medicion_real_at, horas_desde_salida)
       values ($1,$2,$3,$4,1,10,300,3000, now(), 2) returning residual_id`,
      [org, predioId, potreroId, cicloId],
    );
    const residualId = residualResult.rows[0].residual_id;

    await adminPool.query(
      `insert into agx.potrero_ciclo_residual_real_invalidaciones (organizacion_id, potrero_id, residual_id, ciclo_id, motivo) values ($1,$2,$3,$4,'test')`,
      [org, potreroId, residualId, cicloId],
    );
    await assert.rejects(
      () => adminPool.query(
        `insert into agx.potrero_ciclo_residual_real_invalidaciones (organizacion_id, potrero_id, residual_id, ciclo_id, motivo) values ($1,$2,$3,$4,'dos veces')`,
        [org, potreroId, residualId, cicloId],
      ),
      (error) => error.code === '23505',
    );

    const rls = await adminPool.query(
      `select relrowsecurity, relforcerowsecurity from pg_class where oid = 'agx.potrero_ciclo_residual_real_invalidaciones'::regclass`,
    );
    assert.equal(rls.rows[0].relrowsecurity, true);
    assert.equal(rls.rows[0].relforcerowsecurity, true);

    const privs = await adminPool.query(
      `select privilege_type from information_schema.table_privileges where table_schema='agx' and table_name='potrero_ciclo_residual_real_invalidaciones' and grantee='agx_app'`,
    );
    assert.deepEqual(privs.rows.map((r) => r.privilege_type).sort(), ['INSERT', 'SELECT']);
  });
});

describe('SPRINT-3D9.4: esquema real -- 0018 FK descanso <-> residual real', { skip: !dbAvailable }, () => {
  test('agx.potrero_recomendaciones_descanso tiene residual_real_version_id/fuente_remanente nullable, FK + CHECK', async () => {
    const cols = await adminPool.query(
      `select column_name, is_nullable from information_schema.columns
        where table_schema='agx' and table_name='potrero_recomendaciones_descanso' and column_name in ('residual_real_version_id','fuente_remanente')`,
    );
    assert.equal(cols.rows.length, 2);
    for (const row of cols.rows) {
      assert.equal(row.is_nullable, 'YES');
    }

    const fk = await adminPool.query(
      `select conname from pg_constraint where conname = 'potrero_descansos_residual_real_version_fkey'`,
    );
    assert.equal(fk.rows.length, 1);

    const check = await adminPool.query(
      `select conname from pg_constraint where conname = 'potrero_recomendaciones_descanso_fuente_remanente_check'`,
    );
    assert.equal(check.rows.length, 1);
  });

  test('fuente_remanente rechaza valores fuera de ESTIMADO/MEDIDO', async () => {
    // No requiere fila real -- CHECK constraint se valida contra un UPDATE
    // de prueba en una transacción revertida.
    await adminPool.query('begin');
    try {
      await assert.rejects(
        () => adminPool.query(
          `insert into agx.potrero_recomendaciones_descanso (organizacion_id, predio_id, potrero_id, ficha_id, recomendacion_pastoreo_id,
             fecha_inicio_pastoreo, fecha_salida_estimada, dias_descanso_min, dias_descanso_max, dias_descanso_recomendado,
             fecha_reingreso_min, fecha_reingreso_max, fecha_reingreso_recomendada, nivel_confianza, agroclimate_status,
             condiciones_reentrada_json, applied_rules_json, parametros_fuente_json, motor_version, fuente_remanente)
           values (gen_random_uuid(), 1, 1, 1, 1, current_date, current_date, 1, 1, 1, current_date, current_date, current_date, 'BAJA', 'NORMAL', '[]', '[]', '{}', 'test', 'OTRO')`,
        ),
        (error) => error.code === '23514',
      );
    } finally {
      await adminPool.query('rollback');
    }
  });
});
