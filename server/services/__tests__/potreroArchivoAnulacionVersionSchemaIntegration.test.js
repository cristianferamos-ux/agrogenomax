// SPRINT-3D9.2 -- esquema real (0010-0013) contra Postgres/PostGIS REAL.
// Cubre: archivo de predio/potrero (estado/CHECK/revoke DELETE/eventos
// append-only), ANULADO + motivo_anulacion + grant columnar ampliado,
// versionado de descanso (unique ciclo_pastoreo_id+version, anchor de 4
// columnas), potrero_descanso_invalidaciones (append-only, FK fuerte,
// unique un-por-descanso), potrero_evaluaciones_reingreso (APTO/NO_APTO,
// partial unique, FK fuerte).
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
  const tableCheck = await adminPool.query("select to_regclass('agx.potrero_descanso_invalidaciones') as t");
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
  return { fichaId, categoriaId, recomendacionId: recResult.rows[0].recomendacion_id };
}

async function seedCicloFinalizado(orgId, predioId, potreroId, recomendacionId, categoriaId) {
  const result = await adminPool.query(
    `insert into agx.potrero_ciclos_pastoreo
       (organizacion_id, predio_id, potrero_id, recomendacion_pastoreo_id, categoria_id,
        numero_animales_real, peso_promedio_real_kg, fecha_ingreso_real, fecha_salida_real, estado)
     values ($1, $2, $3, $4, $5, 10, 420, current_date - 5, current_date, 'FINALIZADO')
     returning ciclo_id`,
    [orgId, predioId, potreroId, recomendacionId, categoriaId],
  );
  return result.rows[0].ciclo_id;
}

async function seedDescansoVersion(orgId, predioId, potreroId, recomendacionId, fichaId, cicloId, version) {
  const result = await adminPool.query(
    `insert into agx.potrero_recomendaciones_descanso
       (organizacion_id, predio_id, potrero_id, ficha_id, recomendacion_pastoreo_id,
        fecha_inicio_pastoreo, fecha_salida_estimada,
        dias_descanso_min, dias_descanso_max, dias_descanso_recomendado,
        fecha_reingreso_min, fecha_reingreso_max, fecha_reingreso_recomendada,
        nivel_confianza, agroclimate_status, motor_version, ciclo_pastoreo_id, version)
     values ($1, $2, $3, $4, $5, current_date - 5, current_date, 20, 40, 30,
             current_date + 20, current_date + 40, current_date + 30,
             'MEDIA', 'NORMAL', 'descanso-auto-v1', $6, $7)
     returning descanso_id`,
    [orgId, predioId, potreroId, fichaId, recomendacionId, cicloId, version],
  );
  return result.rows[0].descanso_id;
}

describe('SPRINT-3D9.2: esquema real -- 0010 archivo de predio/potrero', { skip: !dbAvailable }, () => {
  after(async () => {
    if (!adminPool) return;
    await adminPool.query(`delete from agx.predio_archivo_eventos where predio_id in (select predio_id from agx.predios where nombre_predio like 'Predio Sprint3D92S10%')`);
    await adminPool.query(`delete from agx.potrero_archivo_eventos where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D92S10%')`);
    await adminPool.query(`delete from agx.potreros where nombre like 'Potrero Sprint3D92S10%'`);
    await adminPool.query(`delete from agx.predios where nombre_predio like 'Predio Sprint3D92S10%'`);
  });

  test('predios/potreros: estado ACTIVO por default, agx_app YA NO tiene DELETE', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D92S10 estado default');
    const result = await adminPool.query('select estado, archivado_at, archivado_por, motivo_archivado from agx.predios where predio_id = $1', [predioId]);
    assert.equal(result.rows[0].estado, 'ACTIVO');
    assert.equal(result.rows[0].archivado_at, null);

    const deletePriv = await adminPool.query(`select has_table_privilege('agx_app', 'agx.predios', 'DELETE') as puede`);
    assert.equal(deletePriv.rows[0].puede, false, 'agx_app NUNCA debe poder DELETE en agx.predios');
    const deletePrivPotreros = await adminPool.query(`select has_table_privilege('agx_app', 'agx.potreros', 'DELETE') as puede`);
    assert.equal(deletePrivPotreros.rows[0].puede, false, 'agx_app NUNCA debe poder DELETE en agx.potreros');
  });

  test('CHECK exhaustivo: ARCHIVADO sin archivado_at/archivado_por/motivo_archivado es rechazado', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D92S10 CHECK1');
    await assert.rejects(
      () => adminPool.query(`update agx.predios set estado = 'ARCHIVADO' where predio_id = $1`, [predioId]),
      (error) => error.code === '23514',
    );
  });

  test('CHECK exhaustivo: ACTIVO con archivado_at no nulo es rechazado', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D92S10 CHECK2');
    await assert.rejects(
      () => adminPool.query(`update agx.predios set archivado_at = now() where predio_id = $1`, [predioId]),
      (error) => error.code === '23514',
    );
  });

  test('predio_archivo_eventos/potrero_archivo_eventos: RLS ENABLE/FORCE, grants SELECT+INSERT únicamente', async () => {
    for (const tabla of ['potrero_archivo_eventos', 'predio_archivo_eventos']) {
      const rls = await adminPool.query(
        `select relrowsecurity, relforcerowsecurity from pg_class where oid = $1::regclass`,
        [`agx.${tabla}`],
      );
      assert.equal(rls.rows[0].relrowsecurity, true, `${tabla} debe tener RLS ENABLE`);
      assert.equal(rls.rows[0].relforcerowsecurity, true, `${tabla} debe tener RLS FORCE`);

      const privs = await adminPool.query(
        `select privilege_type from information_schema.table_privileges where table_schema='agx' and table_name=$1 and grantee='agx_app'`,
        [tabla],
      );
      const privilegios = privs.rows.map((r) => r.privilege_type).sort();
      assert.deepEqual(privilegios, ['INSERT', 'SELECT'], `${tabla} debe ser SELECT/INSERT únicamente para agx_app`);
    }
  });

  test('predio_archivo_eventos: tipo_evento CHECK rechaza valores fuera de ARCHIVADO/RESTAURADO', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D92S10 evento check');
    await assert.rejects(
      () => adminPool.query(
        `insert into agx.predio_archivo_eventos (organizacion_id, predio_id, tipo_evento, motivo) values ($1,$2,'ELIMINADO','x')`,
        [org, predioId],
      ),
      (error) => error.code === '23514',
    );
  });

  test('predio_archivo_eventos: ARCHIVADO exige motivo, RESTAURADO no', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D92S10 evento motivo');
    await assert.rejects(
      () => adminPool.query(
        `insert into agx.predio_archivo_eventos (organizacion_id, predio_id, tipo_evento, motivo) values ($1,$2,'ARCHIVADO',null)`,
        [org, predioId],
      ),
      (error) => error.code === '23514',
    );
    await adminPool.query(
      `insert into agx.predio_archivo_eventos (organizacion_id, predio_id, tipo_evento, motivo) values ($1,$2,'RESTAURADO',null)`,
      [org, predioId],
    );
  });
});

describe('SPRINT-3D9.2: esquema real -- 0011 ANULADO + corrección', { skip: !dbAvailable }, () => {
  after(async () => {
    if (!adminPool) return;
    await adminPool.query(`update agx.potrero_recomendaciones_descanso set ciclo_pastoreo_id = null where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D92S11%')`);
    await adminPool.query(`update agx.potrero_ciclos_pastoreo set recomendacion_descanso_plan_id = null where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D92S11%')`);
    await adminPool.query(`delete from agx.potrero_ciclo_eventos where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D92S11%')`);
    await adminPool.query(`delete from agx.potrero_ciclos_pastoreo where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D92S11%')`);
    await adminPool.query(`delete from agx.potrero_recomendaciones_descanso where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D92S11%')`);
    await adminPool.query(`delete from agx.potrero_recomendaciones_pastoreo where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D92S11%')`);
    await adminPool.query(`delete from agx.potrero_fichas_productivas where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D92S11%')`);
    await adminPool.query(`delete from agx.potreros where nombre like 'Potrero Sprint3D92S11%'`);
    await adminPool.query(`delete from agx.predios where nombre_predio like 'Predio Sprint3D92S11%'`);
  });

  test('CHECK exhaustivo: ANULADO sin motivo_anulacion es rechazado', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D92S11 A');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D92S11 A');
    const { recomendacionId, categoriaId } = await seedFichaYRecomendacion(org, predioId, potreroId);
    const cicloId = await seedCicloFinalizado(org, predioId, potreroId, recomendacionId, categoriaId);
    await assert.rejects(
      () => adminPool.query(`update agx.potrero_ciclos_pastoreo set estado='ANULADO' where ciclo_id=$1`, [cicloId]),
      (error) => error.code === '23514',
    );
  });

  test('CHECK exhaustivo: FINALIZADO/CANCELADO con motivo_anulacion no nulo es rechazado (nunca "medio anulado")', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D92S11 B');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D92S11 B');
    const { recomendacionId, categoriaId } = await seedFichaYRecomendacion(org, predioId, potreroId);
    const cicloId = await seedCicloFinalizado(org, predioId, potreroId, recomendacionId, categoriaId);
    await assert.rejects(
      () => adminPool.query(`update agx.potrero_ciclos_pastoreo set motivo_anulacion='x' where ciclo_id=$1`, [cicloId]),
      (error) => error.code === '23514',
    );
  });

  test('ANULADO desde FINALIZADO (fecha_salida_real no nula, motivo_cancelacion nulo) es aceptado', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D92S11 C');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D92S11 C');
    const { recomendacionId, categoriaId } = await seedFichaYRecomendacion(org, predioId, potreroId);
    const cicloId = await seedCicloFinalizado(org, predioId, potreroId, recomendacionId, categoriaId);
    const result = await adminPool.query(
      `update agx.potrero_ciclos_pastoreo set estado='ANULADO', motivo_anulacion='registro duplicado' where ciclo_id=$1 returning estado`,
      [cicloId],
    );
    assert.equal(result.rows[0].estado, 'ANULADO');
  });

  test('grant columnar ampliado: agx_app puede corregir fecha_ingreso_real/categoria_id/numero_animales_real/peso_promedio_real_kg/motivo_anulacion', async () => {
    for (const columna of ['fecha_ingreso_real', 'categoria_id', 'numero_animales_real', 'peso_promedio_real_kg', 'motivo_anulacion', 'estado', 'fecha_salida_real', 'motivo_cancelacion']) {
      const priv = await adminPool.query(
        `select has_column_privilege('agx_app', 'agx.potrero_ciclos_pastoreo', $1, 'UPDATE') as puede`,
        [columna],
      );
      assert.equal(priv.rows[0].puede, true, `agx_app debe poder UPDATE la columna ${columna}`);
    }
    for (const columna of ['organizacion_id', 'potrero_id', 'predio_id', 'recomendacion_pastoreo_id', 'created_at']) {
      const priv = await adminPool.query(
        `select has_column_privilege('agx_app', 'agx.potrero_ciclos_pastoreo', $1, 'UPDATE') as puede`,
        [columna],
      );
      assert.equal(priv.rows[0].puede, false, `agx_app NUNCA debe poder UPDATE la columna ${columna}`);
    }
  });

  test('potrero_ciclo_eventos: tipo_evento acepta PASTOREO_ANULADO/PASTOREO_CORREGIDO, rechaza valores inválidos', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D92S11 D');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D92S11 D');
    const { recomendacionId, categoriaId } = await seedFichaYRecomendacion(org, predioId, potreroId);
    const cicloId = await seedCicloFinalizado(org, predioId, potreroId, recomendacionId, categoriaId);
    await adminPool.query(
      `insert into agx.potrero_ciclo_eventos (organizacion_id, potrero_id, ciclo_id, tipo_evento, payload_json) values ($1,$2,$3,'PASTOREO_ANULADO','{}')`,
      [org, potreroId, cicloId],
    );
    await adminPool.query(
      `insert into agx.potrero_ciclo_eventos (organizacion_id, potrero_id, ciclo_id, tipo_evento, payload_json) values ($1,$2,$3,'PASTOREO_CORREGIDO','{}')`,
      [org, potreroId, cicloId],
    );
    await assert.rejects(
      () => adminPool.query(
        `insert into agx.potrero_ciclo_eventos (organizacion_id, potrero_id, ciclo_id, tipo_evento, payload_json) values ($1,$2,$3,'PASTOREO_INVENTADO','{}')`,
        [org, potreroId, cicloId],
      ),
      (error) => error.code === '23514',
    );
  });
});

describe('SPRINT-3D9.2: esquema real -- 0012 versionado de descanso + invalidaciones', { skip: !dbAvailable }, () => {
  after(async () => {
    if (!adminPool) return;
    await adminPool.query(`delete from agx.potrero_descanso_invalidaciones where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D92S12%')`);
    await adminPool.query(`update agx.potrero_ciclos_pastoreo set recomendacion_descanso_plan_id = null where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D92S12%')`);
    await adminPool.query(`delete from agx.potrero_ciclo_eventos where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D92S12%')`);
    await adminPool.query(`delete from agx.potrero_recomendaciones_descanso where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D92S12%')`);
    await adminPool.query(`delete from agx.potrero_ciclos_pastoreo where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D92S12%')`);
    await adminPool.query(`delete from agx.potrero_recomendaciones_pastoreo where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D92S12%')`);
    await adminPool.query(`delete from agx.potrero_fichas_productivas where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D92S12%')`);
    await adminPool.query(`delete from agx.potreros where nombre like 'Potrero Sprint3D92S12%'`);
    await adminPool.query(`delete from agx.predios where nombre_predio like 'Predio Sprint3D92S12%'`);
  });

  test('version: default 1, unique(ciclo_pastoreo_id, version) permite version=2 para el MISMO ciclo (a diferencia del índice anterior de 0009)', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D92S12 A');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D92S12 A');
    const { recomendacionId, fichaId, categoriaId } = await seedFichaYRecomendacion(org, predioId, potreroId);
    const cicloId = await seedCicloFinalizado(org, predioId, potreroId, recomendacionId, categoriaId);

    const d1 = await adminPool.query('select version from agx.potrero_recomendaciones_descanso where descanso_id = $1', [await seedDescansoVersion(org, predioId, potreroId, recomendacionId, fichaId, cicloId, 1)]);
    assert.equal(d1.rows[0].version, 1);

    // A diferencia del índice de 0009 (un descanso por ciclo, para
    // siempre), version=2 para el MISMO ciclo_pastoreo_id debe aceptarse.
    const d2Id = await seedDescansoVersion(org, predioId, potreroId, recomendacionId, fichaId, cicloId, 2);
    assert.ok(d2Id);
  });

  test('unique(ciclo_pastoreo_id, version): duplicar la MISMA versión para el mismo ciclo es rechazado', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D92S12 B');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D92S12 B');
    const { recomendacionId, fichaId, categoriaId } = await seedFichaYRecomendacion(org, predioId, potreroId);
    const cicloId = await seedCicloFinalizado(org, predioId, potreroId, recomendacionId, categoriaId);
    await seedDescansoVersion(org, predioId, potreroId, recomendacionId, fichaId, cicloId, 1);
    await assert.rejects(
      () => seedDescansoVersion(org, predioId, potreroId, recomendacionId, fichaId, cicloId, 1),
      (error) => error.code === '23505' && /potrero_recomendaciones_descanso_un_ciclo_version_idx/.test(error.message),
    );
  });

  test('anchor 4 columnas: potrero_descanso_invalidaciones rechaza una combinación descanso_id/ciclo_pastoreo_id que no corresponde a la misma fila real (23503)', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D92S12 C');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D92S12 C');
    const { recomendacionId, fichaId, categoriaId } = await seedFichaYRecomendacion(org, predioId, potreroId);
    const cicloAId = await seedCicloFinalizado(org, predioId, potreroId, recomendacionId, categoriaId);
    const cicloBId = await seedCicloFinalizado(org, predioId, potreroId, recomendacionId, categoriaId);
    const descansoAId = await seedDescansoVersion(org, predioId, potreroId, recomendacionId, fichaId, cicloAId, 1);

    // descansoAId es real, pero pertenece a cicloAId -- inventar cicloBId
    // en su lugar debe ser rechazado por la FK de 4 columnas, no solo
    // aceptado porque cicloBId también existe de verdad.
    await assert.rejects(
      () => adminPool.query(
        `insert into agx.potrero_descanso_invalidaciones (organizacion_id, potrero_id, descanso_id, ciclo_pastoreo_id, motivo) values ($1,$2,$3,$4,'x')`,
        [org, potreroId, descansoAId, cicloBId],
      ),
      (error) => error.code === '23503',
    );

    // La combinación REAL sí es aceptada.
    await adminPool.query(
      `insert into agx.potrero_descanso_invalidaciones (organizacion_id, potrero_id, descanso_id, ciclo_pastoreo_id, motivo) values ($1,$2,$3,$4,'x')`,
      [org, potreroId, descansoAId, cicloAId],
    );
  });

  test('potrero_descanso_invalidaciones: unique(descanso_id) impide invalidar la misma versión dos veces', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D92S12 D');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D92S12 D');
    const { recomendacionId, fichaId, categoriaId } = await seedFichaYRecomendacion(org, predioId, potreroId);
    const cicloId = await seedCicloFinalizado(org, predioId, potreroId, recomendacionId, categoriaId);
    const descansoId = await seedDescansoVersion(org, predioId, potreroId, recomendacionId, fichaId, cicloId, 1);
    await adminPool.query(
      `insert into agx.potrero_descanso_invalidaciones (organizacion_id, potrero_id, descanso_id, ciclo_pastoreo_id, motivo) values ($1,$2,$3,$4,'x')`,
      [org, potreroId, descansoId, cicloId],
    );
    await assert.rejects(
      () => adminPool.query(
        `insert into agx.potrero_descanso_invalidaciones (organizacion_id, potrero_id, descanso_id, ciclo_pastoreo_id, motivo) values ($1,$2,$3,$4,'y')`,
        [org, potreroId, descansoId, cicloId],
      ),
      (error) => error.code === '23505',
    );
  });

  test('potrero_descanso_invalidaciones: RLS ENABLE/FORCE, grants SELECT+INSERT únicamente, NUNCA UPDATE/DELETE', async () => {
    const rls = await adminPool.query(`select relrowsecurity, relforcerowsecurity from pg_class where oid = 'agx.potrero_descanso_invalidaciones'::regclass`);
    assert.equal(rls.rows[0].relrowsecurity, true);
    assert.equal(rls.rows[0].relforcerowsecurity, true);
    const privs = await adminPool.query(
      `select privilege_type from information_schema.table_privileges where table_schema='agx' and table_name='potrero_descanso_invalidaciones' and grantee='agx_app'`,
    );
    assert.deepEqual(privs.rows.map((r) => r.privilege_type).sort(), ['INSERT', 'SELECT']);
  });
});

describe('SPRINT-3D9.2: esquema real -- 0013 evaluaciones de reingreso', { skip: !dbAvailable }, () => {
  after(async () => {
    if (!adminPool) return;
    await adminPool.query(`delete from agx.potrero_evaluaciones_reingreso where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D92S13%')`);
    await adminPool.query(`update agx.potrero_ciclos_pastoreo set recomendacion_descanso_plan_id = null where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D92S13%')`);
    await adminPool.query(`delete from agx.potrero_ciclo_eventos where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D92S13%')`);
    await adminPool.query(`delete from agx.potrero_recomendaciones_descanso where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D92S13%')`);
    await adminPool.query(`delete from agx.potrero_ciclos_pastoreo where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D92S13%')`);
    await adminPool.query(`delete from agx.potrero_recomendaciones_pastoreo where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D92S13%')`);
    await adminPool.query(`delete from agx.potrero_fichas_productivas where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D92S13%')`);
    await adminPool.query(`delete from agx.potreros where nombre like 'Potrero Sprint3D92S13%'`);
    await adminPool.query(`delete from agx.predios where nombre_predio like 'Predio Sprint3D92S13%'`);
  });

  async function seedEscenario(sufijo) {
    const org = randomOrgId();
    const predioId = await seedPredio(org, `Predio Sprint3D92S13 ${sufijo}`);
    const potreroId = await seedPotrero(org, predioId, `Potrero Sprint3D92S13 ${sufijo}`);
    const { recomendacionId, fichaId, categoriaId } = await seedFichaYRecomendacion(org, predioId, potreroId);
    const cicloId = await seedCicloFinalizado(org, predioId, potreroId, recomendacionId, categoriaId);
    const descansoId = await seedDescansoVersion(org, predioId, potreroId, recomendacionId, fichaId, cicloId, 1);
    return { org, predioId, potreroId, fichaId, cicloId, descansoId };
  }

  test('resultado CHECK: solo APTO/NO_APTO', async () => {
    const { org, potreroId, cicloId, descansoId, fichaId } = await seedEscenario('A');
    await assert.rejects(
      () => adminPool.query(
        `insert into agx.potrero_evaluaciones_reingreso (organizacion_id, potrero_id, ciclo_origen_id, descanso_id, ficha_id, resultado) values ($1,$2,$3,$4,$5,'QUIZAS')`,
        [org, potreroId, cicloId, descansoId, fichaId],
      ),
      (error) => error.code === '23514',
    );
  });

  test('NO_APTO exige observación no vacía; APTO no la exige', async () => {
    const { org, potreroId, cicloId, descansoId, fichaId } = await seedEscenario('B');
    await assert.rejects(
      () => adminPool.query(
        `insert into agx.potrero_evaluaciones_reingreso (organizacion_id, potrero_id, ciclo_origen_id, descanso_id, ficha_id, resultado, observacion) values ($1,$2,$3,$4,$5,'NO_APTO',null)`,
        [org, potreroId, cicloId, descansoId, fichaId],
      ),
      (error) => error.code === '23514',
    );
    await adminPool.query(
      `insert into agx.potrero_evaluaciones_reingreso (organizacion_id, potrero_id, ciclo_origen_id, descanso_id, ficha_id, resultado, observacion) values ($1,$2,$3,$4,$5,'NO_APTO','altura insuficiente')`,
      [org, potreroId, cicloId, descansoId, fichaId],
    );
  });

  test('múltiples NO_APTO permitidos; como máximo UN APTO por descanso (índice único parcial)', async () => {
    const { org, potreroId, cicloId, descansoId, fichaId } = await seedEscenario('C');
    await adminPool.query(
      `insert into agx.potrero_evaluaciones_reingreso (organizacion_id, potrero_id, ciclo_origen_id, descanso_id, ficha_id, resultado, observacion) values ($1,$2,$3,$4,$5,'NO_APTO','primero')`,
      [org, potreroId, cicloId, descansoId, fichaId],
    );
    await adminPool.query(
      `insert into agx.potrero_evaluaciones_reingreso (organizacion_id, potrero_id, ciclo_origen_id, descanso_id, ficha_id, resultado, observacion) values ($1,$2,$3,$4,$5,'NO_APTO','segundo')`,
      [org, potreroId, cicloId, descansoId, fichaId],
    );
    await adminPool.query(
      `insert into agx.potrero_evaluaciones_reingreso (organizacion_id, potrero_id, ciclo_origen_id, descanso_id, ficha_id, resultado) values ($1,$2,$3,$4,$5,'APTO')`,
      [org, potreroId, cicloId, descansoId, fichaId],
    );
    await assert.rejects(
      () => adminPool.query(
        `insert into agx.potrero_evaluaciones_reingreso (organizacion_id, potrero_id, ciclo_origen_id, descanso_id, ficha_id, resultado) values ($1,$2,$3,$4,$5,'APTO')`,
        [org, potreroId, cicloId, descansoId, fichaId],
      ),
      (error) => error.code === '23505' && /potrero_evaluaciones_reingreso_un_apto_idx/.test(error.message),
    );
  });

  test('FK compuesta: descanso_id/ciclo_origen_id que no corresponden a la misma fila real es rechazado (23503)', async () => {
    const escenarioA = await seedEscenario('D1');
    const escenarioB = await seedEscenario('D2');
    await assert.rejects(
      () => adminPool.query(
        `insert into agx.potrero_evaluaciones_reingreso (organizacion_id, potrero_id, ciclo_origen_id, descanso_id, ficha_id, resultado) values ($1,$2,$3,$4,$5,'APTO')`,
        [escenarioA.org, escenarioA.potreroId, escenarioB.cicloId, escenarioA.descansoId, escenarioA.fichaId],
      ),
      (error) => error.code === '23503',
    );
  });

  test('RLS ENABLE/FORCE, grants SELECT+INSERT únicamente', async () => {
    const rls = await adminPool.query(`select relrowsecurity, relforcerowsecurity from pg_class where oid = 'agx.potrero_evaluaciones_reingreso'::regclass`);
    assert.equal(rls.rows[0].relrowsecurity, true);
    assert.equal(rls.rows[0].relforcerowsecurity, true);
    const privs = await adminPool.query(
      `select privilege_type from information_schema.table_privileges where table_schema='agx' and table_name='potrero_evaluaciones_reingreso' and grantee='agx_app'`,
    );
    assert.deepEqual(privs.rows.map((r) => r.privilege_type).sort(), ['INSERT', 'SELECT']);
  });
});
