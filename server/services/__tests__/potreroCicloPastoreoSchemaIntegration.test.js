// SPRINT-3D9.1 -- CICLO REAL DE PASTOREO: esquema real (0009) contra
// Postgres/PostGIS REAL. Cubre: CHECK exhaustivo por estado, unique
// parcial EN_CURSO, RLS ENABLE/FORCE, grants column-level, Guardrail 1
// (integridad predio-potrero), Guardrail 2 (idempotencia estructural
// ciclo_pastoreo_id en potrero_recomendaciones_descanso).
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
  const tableCheck = await adminPool.query("select to_regclass('agx.potrero_ciclos_pastoreo') as t");
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
  const pastura = await adminPool.query(`select pastura_id from agx.catalogo_pasturas where alcance='sistema' and nombre_comun='Brachiaria humidicola'`);
  const fichaResult = await adminPool.query(
    `insert into agx.potrero_fichas_productivas (organizacion_id, potrero_id, tipo_cobertura, nombre_principal, aforo_promedio_g_m2, fecha_aforo, biomasa_total_kg)
     values ($1, $2, 'pastura', 'Test', 500, current_date, 5000) returning ficha_id`,
    [orgId, potreroId],
  );
  const fichaId = fichaResult.rows[0].ficha_id;
  await adminPool.query(
    `insert into agx.potrero_ficha_pasturas (organizacion_id, ficha_id, pastura_id, porcentaje_estimado, orden) values ($1, $2, $3, 100, 0)`,
    [orgId, fichaId, pastura.rows[0].pastura_id],
  );
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
  return { fichaId, categoriaId, recomendacionId: recResult.rows[0].recomendacion_id };
}

describe('SPRINT-3D9.1: esquema real -- agx.potrero_ciclos_pastoreo / agx.potrero_ciclo_eventos', { skip: !dbAvailable }, () => {
  after(async () => {
    if (!adminPool) return;
    // GUARDRAIL 1/2: ciclos_pastoreo <-> recomendaciones_descanso tienen un
    // vínculo cíclico (plan y post-real, ambos nullable) -- hay que romperlo
    // antes de poder borrar cualquiera de las dos tablas sin violar FK.
    await adminPool.query(`update agx.potrero_recomendaciones_descanso set ciclo_pastoreo_id = null where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D9S%')`);
    await adminPool.query(`update agx.potrero_ciclos_pastoreo set recomendacion_descanso_plan_id = null where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D9S%')`);
    await adminPool.query(`delete from agx.potrero_ciclo_eventos where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D9S%')`);
    await adminPool.query(`delete from agx.potrero_ciclos_pastoreo where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D9S%')`);
    await adminPool.query(`delete from agx.potrero_recomendaciones_descanso where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D9S%')`);
    await adminPool.query(`delete from agx.potrero_recomendaciones_pastoreo where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D9S%')`);
    await adminPool.query(`delete from agx.potrero_ficha_pasturas where ficha_id in (select ficha_id from agx.potrero_fichas_productivas where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D9S%'))`);
    await adminPool.query(`delete from agx.potrero_fichas_productivas where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D9S%')`);
    await adminPool.query(`delete from agx.potreros where nombre like 'Potrero Sprint3D9S%'`);
    await adminPool.query(`delete from agx.predios where nombre_predio like 'Predio Sprint3D9S%'`);
    await adminPool.end();
  });

  test('RLS ENABLE/FORCE activo en ambas tablas', async () => {
    const result = await adminPool.query(
      `select relname, relrowsecurity, relforcerowsecurity from pg_class
        where relname in ('potrero_ciclos_pastoreo', 'potrero_ciclo_eventos') and relnamespace = 'agx'::regnamespace`,
    );
    assert.equal(result.rows.length, 2);
    for (const row of result.rows) {
      assert.equal(row.relrowsecurity, true, `${row.relname} debe tener RLS ENABLE`);
      assert.equal(row.relforcerowsecurity, true, `${row.relname} debe tener RLS FORCE`);
    }
  });

  test('grants: agx_app tiene SELECT/INSERT en potrero_ciclos_pastoreo, UPDATE SOLO en las columnas explícitamente ampliadas por 3D9.2/3D9.3, NUNCA DELETE', async () => {
    const result = await adminPool.query(
      `select privilege_type, column_name from information_schema.column_privileges
        where table_schema='agx' and table_name='potrero_ciclos_pastoreo' and grantee='agx_app' and privilege_type='UPDATE'
        order by column_name`,
    );
    const columnasConUpdate = result.rows.map((r) => r.column_name).sort();
    // SPRINT-3D9.2: amplía el grant original (estado/fecha_salida_real/
    // motivo_cancelacion) con las columnas de "corregir ciclo" -- cada una
    // justificada individualmente (ver 0011_potrero_ciclo_anulacion_correccion.sql).
    // SPRINT-3D9.3: agrega ingreso_real_at/salida_real_at (0014) --
    // necesarias para que FASE A/A' puedan fijar/sincronizar el timestamp
    // operacional junto con la fecha DATE derivada.
    assert.deepEqual(columnasConUpdate, [
      'categoria_id', 'estado', 'fecha_ingreso_real', 'fecha_salida_real',
      'ingreso_real_at', 'motivo_anulacion', 'motivo_cancelacion', 'numero_animales_real',
      'peso_promedio_real_kg', 'salida_real_at',
    ]);

    const tablePriv = await adminPool.query(
      `select privilege_type from information_schema.table_privileges
        where table_schema='agx' and table_name='potrero_ciclos_pastoreo' and grantee='agx_app'`,
    );
    const privs = tablePriv.rows.map((r) => r.privilege_type);
    assert.ok(privs.includes('SELECT'));
    assert.ok(privs.includes('INSERT'));
    assert.ok(!privs.includes('DELETE'), 'agx_app NUNCA debe poder DELETE');
  });

  test('grants: agx_app tiene EXCLUSIVAMENTE SELECT/INSERT en potrero_ciclo_eventos -- NUNCA UPDATE/DELETE', async () => {
    const result = await adminPool.query(
      `select privilege_type from information_schema.table_privileges
        where table_schema='agx' and table_name='potrero_ciclo_eventos' and grantee='agx_app'`,
    );
    const privs = result.rows.map((r) => r.privilege_type).sort();
    assert.deepEqual(privs, ['INSERT', 'SELECT']);
  });

  test('secuencias: agx_app tiene USAGE+SELECT sobre ambas secuencias bigserial (verificado, no asumido)', async () => {
    // NOTA: information_schema.role_usage_grants solo reporta el privilegio
    // USAGE para secuencias -- el privilegio SELECT sobre una secuencia se
    // verifica con has_sequence_privilege() (igual que para una tabla).
    for (const seq of ['potrero_ciclos_pastoreo_ciclo_id_seq', 'potrero_ciclo_eventos_evento_id_seq']) {
      const result = await adminPool.query(
        `select
           has_sequence_privilege('agx_app', $1::regclass, 'USAGE') as has_usage,
           has_sequence_privilege('agx_app', $1::regclass, 'SELECT') as has_select`,
        [`agx.${seq}`],
      );
      assert.equal(result.rows[0].has_usage, true, `${seq} debe tener USAGE para agx_app`);
      assert.equal(result.rows[0].has_select, true, `${seq} debe tener SELECT para agx_app`);
    }
  });

  test('CHECK exhaustivo: EN_CURSO con fecha_salida_real no nula es rechazado', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D9S CHECK1');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D9S CHECK1');
    const { categoriaId, recomendacionId } = await seedFichaYRecomendacion(org, predioId, potreroId);
    await assert.rejects(
      () => adminPool.query(
        `insert into agx.potrero_ciclos_pastoreo (organizacion_id, predio_id, potrero_id, recomendacion_pastoreo_id, categoria_id, numero_animales_real, peso_promedio_real_kg, fecha_ingreso_real, fecha_salida_real, estado)
         values ($1, $2, $3, $4, $5, 10, 420, '2026-08-26', '2026-08-31', 'EN_CURSO')`,
        [org, predioId, potreroId, recomendacionId, categoriaId],
      ),
      (error) => /potrero_ciclos_pastoreo_estado_consistency_check/.test(error.message),
    );
  });

  test('CHECK exhaustivo: FINALIZADO con motivo_cancelacion no nulo es rechazado', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D9S CHECK2');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D9S CHECK2');
    const { categoriaId, recomendacionId } = await seedFichaYRecomendacion(org, predioId, potreroId);
    await assert.rejects(
      () => adminPool.query(
        `insert into agx.potrero_ciclos_pastoreo (organizacion_id, predio_id, potrero_id, recomendacion_pastoreo_id, categoria_id, numero_animales_real, peso_promedio_real_kg, fecha_ingreso_real, fecha_salida_real, estado, motivo_cancelacion)
         values ($1, $2, $3, $4, $5, 10, 420, '2026-08-26', '2026-08-31', 'FINALIZADO', 'no debería tener motivo')`,
        [org, predioId, potreroId, recomendacionId, categoriaId],
      ),
      (error) => /potrero_ciclos_pastoreo_estado_consistency_check/.test(error.message),
    );
  });

  test('CHECK exhaustivo: CANCELADO con fecha_salida_real no nula es rechazado', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D9S CHECK3');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D9S CHECK3');
    const { categoriaId, recomendacionId } = await seedFichaYRecomendacion(org, predioId, potreroId);
    await assert.rejects(
      () => adminPool.query(
        `insert into agx.potrero_ciclos_pastoreo (organizacion_id, predio_id, potrero_id, recomendacion_pastoreo_id, categoria_id, numero_animales_real, peso_promedio_real_kg, fecha_ingreso_real, fecha_salida_real, estado, motivo_cancelacion)
         values ($1, $2, $3, $4, $5, 10, 420, '2026-08-26', '2026-08-31', 'CANCELADO', 'motivo')`,
        [org, predioId, potreroId, recomendacionId, categoriaId],
      ),
      (error) => /potrero_ciclos_pastoreo_estado_consistency_check/.test(error.message),
    );
  });

  test('CHECK exhaustivo: CANCELADO con motivo_cancelacion vacío/solo espacios es rechazado', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D9S CHECK4');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D9S CHECK4');
    const { categoriaId, recomendacionId } = await seedFichaYRecomendacion(org, predioId, potreroId);
    for (const motivoInvalido of ['', '   ']) {
      // eslint-disable-next-line no-await-in-loop
      await assert.rejects(
        () => adminPool.query(
          `insert into agx.potrero_ciclos_pastoreo (organizacion_id, predio_id, potrero_id, recomendacion_pastoreo_id, categoria_id, numero_animales_real, peso_promedio_real_kg, fecha_ingreso_real, estado, motivo_cancelacion)
           values ($1, $2, $3, $4, $5, 10, 420, '2026-08-26', 'CANCELADO', $6)`,
          [org, predioId, potreroId, recomendacionId, categoriaId, motivoInvalido],
        ),
        (error) => /potrero_ciclos_pastoreo_estado_consistency_check/.test(error.message),
      );
    }
  });

  test('unique parcial: máximo UN ciclo EN_CURSO por organización+potrero, garantizado por la DB', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D9S UNIQUE');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D9S UNIQUE');
    const { categoriaId, recomendacionId } = await seedFichaYRecomendacion(org, predioId, potreroId);
    await adminPool.query(
      `insert into agx.potrero_ciclos_pastoreo (organizacion_id, predio_id, potrero_id, recomendacion_pastoreo_id, categoria_id, numero_animales_real, peso_promedio_real_kg, fecha_ingreso_real, estado)
       values ($1, $2, $3, $4, $5, 10, 420, '2026-08-26', 'EN_CURSO')`,
      [org, predioId, potreroId, recomendacionId, categoriaId],
    );
    await assert.rejects(
      () => adminPool.query(
        `insert into agx.potrero_ciclos_pastoreo (organizacion_id, predio_id, potrero_id, recomendacion_pastoreo_id, categoria_id, numero_animales_real, peso_promedio_real_kg, fecha_ingreso_real, estado)
         values ($1, $2, $3, $4, $5, 10, 420, '2026-08-26', 'EN_CURSO')`,
        [org, predioId, potreroId, recomendacionId, categoriaId],
      ),
      (error) => error.code === '23505' && /potrero_ciclos_pastoreo_un_en_curso_idx/.test(error.message),
    );
  });

  test('GUARDRAIL 1: potreros tiene ahora la UNIQUE (potrero_id, predio_id, organizacion_id), y un ciclo con potrero de OTRO predio (mismo tenant) es rechazado por integridad referencial', async () => {
    const org = randomOrgId();
    const predioA = await seedPredio(org, 'Predio Sprint3D9S GUARDRAIL-A');
    const predioB = await seedPredio(org, 'Predio Sprint3D9S GUARDRAIL-B');
    const potreroId = await seedPotrero(org, predioA, 'Potrero Sprint3D9S GUARDRAIL');
    const { categoriaId, recomendacionId } = await seedFichaYRecomendacion(org, predioA, potreroId);

    const anchor = await adminPool.query(
      `select 1 from information_schema.table_constraints where constraint_name = 'potreros_id_predio_organizacion_unique' and table_schema='agx'`,
    );
    assert.equal(anchor.rows.length, 1, 'la UNIQUE de 3 columnas debe existir sobre agx.potreros');

    await assert.rejects(
      () => adminPool.query(
        `insert into agx.potrero_ciclos_pastoreo (organizacion_id, predio_id, potrero_id, recomendacion_pastoreo_id, categoria_id, numero_animales_real, peso_promedio_real_kg, fecha_ingreso_real, estado)
         values ($1, $2, $3, $4, $5, 10, 420, '2026-08-26', 'EN_CURSO')`,
        [org, predioB, potreroId, recomendacionId, categoriaId], // predioB es INCORRECTO -- potreroId realmente pertenece a predioA
      ),
      (error) => error.code === '23503' && /potrero_ciclos_pastoreo_potrero_predio_organizacion_fkey/.test(error.message),
    );
  });

  test('GUARDRAIL 2: idempotencia estructural -- máximo UN descanso por (ciclo_pastoreo_id, version) -- SPRINT-3D9.2 ver potreroArchivoAnulacionVersionSchemaIntegration.test.js para el versionado completo', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D9S GR2');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D9S GR2');
    const { fichaId, categoriaId, recomendacionId } = await seedFichaYRecomendacion(org, predioId, potreroId);

    const cicloResult = await adminPool.query(
      `insert into agx.potrero_ciclos_pastoreo (organizacion_id, predio_id, potrero_id, recomendacion_pastoreo_id, categoria_id, numero_animales_real, peso_promedio_real_kg, fecha_ingreso_real, fecha_salida_real, estado)
       values ($1, $2, $3, $4, $5, 10, 420, '2026-08-26', '2026-08-31', 'FINALIZADO') returning ciclo_id`,
      [org, predioId, potreroId, recomendacionId, categoriaId],
    );
    const cicloId = cicloResult.rows[0].ciclo_id;

    const insertDescanso = (motorVersion) => adminPool.query(
      `insert into agx.potrero_recomendaciones_descanso
         (organizacion_id, predio_id, potrero_id, ficha_id, recomendacion_pastoreo_id,
          fecha_inicio_pastoreo, fecha_salida_estimada, dias_descanso_min, dias_descanso_max, dias_descanso_recomendado,
          fecha_reingreso_min, fecha_reingreso_max, fecha_reingreso_recomendada, nivel_confianza, agroclimate_status,
          motor_version, ciclo_pastoreo_id)
       values ($1, $2, $3, $4, $5, '2026-08-26', '2026-08-31', 25, 35, 30, '2026-09-25', '2026-10-05', '2026-09-30', 'MEDIA', 'NORMAL', $6, $7)`,
      [org, predioId, potreroId, fichaId, recomendacionId, motorVersion, cicloId],
    );

    await insertDescanso('descanso-v1-a');
    await assert.rejects(
      () => insertDescanso('descanso-v1-b'),
      (error) => error.code === '23505' && /potrero_recomendaciones_descanso_un_ciclo_version_idx/.test(error.message),
    );
  });
});
