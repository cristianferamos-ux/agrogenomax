// SPRINT-3D9.3 -- REAL PRESSURE: pruebas de repositorio contra
// Postgres/PostGIS REAL. Cubre: ciclo de vida del snapshot versionado
// (v1 al iniciar, v2 al finalizar, invalidación), idempotencia/
// concurrencia de finalizar, doble guardrail temporal del aforo base
// real, pipeline REAL pressure (equivalencia PLAN=REAL, REAL mayor/menor
// presión, PLAN_FALLBACK por cada causa), corrección versionada,
// fuente única de verdad, tenant isolation.
//
// Lee EXCLUSIVAMENTE AGX_BUSINESS_DATABASE_URL_TEST. Ver
// db/agx-business/migrations/README.md.
delete process.env.AGX_BUSINESS_DATABASE_URL;

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import pg from 'pg';
import { resolveFechaHoyNegocio } from '../ganaderia/motorDescansoAuto/businessTimezone.js';

let dbAvailable = false;
let adminPool;
let repo;
let realPressureRepo;

try {
  const testConnectionString = process.env.AGX_BUSINESS_DATABASE_URL_TEST;
  const adminConnectionString = process.env.AGX_BUSINESS_INTEGRATION_ADMIN_DATABASE_URL;
  if (!testConnectionString || !adminConnectionString) {
    throw new Error('AGX_BUSINESS_DATABASE_URL_TEST/AGX_BUSINESS_INTEGRATION_ADMIN_DATABASE_URL no configuradas');
  }
  process.env.AGX_BUSINESS_DATABASE_URL = testConnectionString;

  const { getConfig } = await import('../../config/env.js');
  getConfig({ APP_ENV: 'development' }, {});

  adminPool = new pg.Pool({ connectionString: adminConnectionString, max: 4 });
  await adminPool.query('select 1');

  const tableCheck = await adminPool.query("select to_regclass('agx.potrero_ciclo_lote_real_versiones') as t");
  dbAvailable = Boolean(tableCheck.rows[0]?.t);
} catch {
  dbAvailable = false;
}

if (dbAvailable) {
  repo = await import('../ganaderia/potreroCicloPastoreoRepository.js');
  realPressureRepo = await import('../ganaderia/potreroCicloRealPressureRepository.js');
}

function randomOrgId() {
  return crypto.randomUUID();
}

const SIN_RED_FETCH_IMPL = async () => ({ ok: false, status: 503, json: async () => ({}) });
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

async function fetchPasturaSistemaId(nombreComun) {
  const result = await adminPool.query(`select pastura_id from agx.catalogo_pasturas where alcance = 'sistema' and nombre_comun = $1`, [nombreComun]);
  return result.rows[0]?.pastura_id;
}

async function seedPasturaPersonalizada(orgId, nombre) {
  const result = await adminPool.query(
    `insert into agx.catalogo_pasturas (organizacion_id, nombre_comun, tipo, alcance) values ($1, $2, 'graminea', 'personalizado') returning pastura_id`,
    [orgId, nombre],
  );
  return result.rows[0].pastura_id;
}

async function seedFicha(orgId, potreroId, pasturaId, { fechaAforo, createdAt } = {}) {
  const fichaResult = await adminPool.query(
    `insert into agx.potrero_fichas_productivas (organizacion_id, potrero_id, tipo_cobertura, nombre_principal, aforo_promedio_g_m2, fecha_aforo, biomasa_total_kg, created_at)
     values ($1, $2, 'pastura', 'Pastura Test', 500, $3, 5000, coalesce($4, now()))
     returning ficha_id`,
    [orgId, potreroId, fechaAforo === undefined ? null : fechaAforo, createdAt ?? null],
  );
  const fichaId = fichaResult.rows[0].ficha_id;
  await adminPool.query(
    `insert into agx.potrero_ficha_pasturas (organizacion_id, ficha_id, pastura_id, porcentaje_estimado, orden) values ($1, $2, $3, 100, 0)`,
    [orgId, fichaId, pasturaId],
  );
  return fichaId;
}

async function fetchCategoriaId(codigo) {
  const result = await adminPool.query('select categoria_id from agx.catalogo_categorias_productivas where codigo = $1', [codigo]);
  return result.rows[0]?.categoria_id;
}

async function seedRecomendacionPastoreo(org, predioId, potreroId, fichaId, {
  numeroAnimales = 10, pesoPromedioKg = 420, categoriaCodigo = 'novillo_ceba',
} = {}) {
  const categoriaId = await fetchCategoriaId(categoriaCodigo);
  const result = await adminPool.query(
    `insert into agx.potrero_recomendaciones_pastoreo
       (organizacion_id, predio_id, potrero_id, ficha_id, categoria_id, numero_animales, peso_promedio_kg,
        materia_seca_pct_aplicada, utilizacion_pct_aplicada, consumo_pct_pv_aplicado,
        materia_seca_total_kg, materia_seca_utilizable_kg, demanda_diaria_lote_kg_ms, dias_ocupacion_estimados,
        nivel_confianza, motor_version)
     values ($1, $2, $3, $4, $5, $6, $7, 20, 50, 2.4, 1000, 500, 100.8, 5, 'MEDIA', 'pastoreo-auto-v1')
     returning recomendacion_id`,
    [org, predioId, potreroId, fichaId, categoriaId, numeroAnimales, pesoPromedioKg],
  );
  return result.rows[0].recomendacion_id;
}

async function seedEscenarioCompleto(org, sufijo, { ingresoRealAt } = {}) {
  const predioId = await seedPredio(org, `Predio Sprint3D93 ${sufijo}`);
  const potreroId = await seedPotrero(org, predioId, `Potrero Sprint3D93 ${sufijo}`);
  const pasturaId = await fetchPasturaSistemaId('Brachiaria humidicola');
  const fichaId = await seedFicha(org, potreroId, pasturaId, {
    fechaAforo: resolveFechaHoyNegocio(ingresoRealAt ?? new Date()),
    createdAt: ingresoRealAt ?? null,
  });
  const recomendacionId = await seedRecomendacionPastoreo(org, predioId, potreroId, fichaId);
  return { predioId, potreroId, fichaId, recomendacionId };
}

function horasDespues(fecha, horas) {
  return new Date(fecha.getTime() + horas * 60 * 60 * 1000);
}

describe('SPRINT-3D9.3: potreroCicloRealPressureRepository -- snapshot lifecycle, aforo base real, REAL pressure pipeline', { skip: !dbAvailable }, () => {
  after(async () => {
    if (!adminPool) return;
    // Orden obligatorio -- lote_real_version_id de potrero_recomendaciones_descanso
    // referencia agx.potrero_ciclo_lote_real_versiones -- debe anularse
    // ANTES de poder borrar las versiones (mismo patrón ya recurrente en
    // esta suite: nunca borrar el lado referenciado de una FK circular
    // antes de anular la referencia).
    await adminPool.query(`update agx.potrero_recomendaciones_descanso set lote_real_version_id = null where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D93%')`);
    await adminPool.query(`delete from agx.potrero_ciclo_lote_real_invalidaciones where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D93%')`);
    await adminPool.query(`delete from agx.potrero_ciclo_lote_real_versiones where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D93%')`);
    await adminPool.query(`delete from agx.potrero_descanso_invalidaciones where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D93%')`);
    await adminPool.query(`update agx.potrero_recomendaciones_descanso set ciclo_pastoreo_id = null where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D93%')`);
    await adminPool.query(`update agx.potrero_ciclos_pastoreo set recomendacion_descanso_plan_id = null where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D93%')`);
    await adminPool.query(`delete from agx.potrero_ciclo_eventos where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D93%')`);
    await adminPool.query(`delete from agx.potrero_ciclos_pastoreo where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D93%')`);
    await adminPool.query(`delete from agx.potrero_recomendaciones_descanso where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D93%')`);
    await adminPool.query(`delete from agx.potrero_recomendaciones_pastoreo where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D93%')`);
    await adminPool.query(`delete from agx.potrero_ficha_pasturas where ficha_id in (select ficha_id from agx.potrero_fichas_productivas where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D93%'))`);
    await adminPool.query(`delete from agx.potrero_fichas_productivas where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D93%')`);
    await adminPool.query(`delete from agx.catalogo_pasturas where nombre_comun like 'Pastura Sprint3D93%'`);
    await adminPool.query(`delete from agx.potreros where nombre like 'Potrero Sprint3D93%'`);
    await adminPool.query(`delete from agx.predios where nombre_predio like 'Predio Sprint3D93%'`);
  });

  // -----------------------------------------------------------------------
  // Snapshot lifecycle: v1 al iniciar, v2 al finalizar, invalidación.
  // -----------------------------------------------------------------------

  test('iniciar crea snapshot v1 con salida_real_at NULL', async () => {
    const org = randomOrgId();
    const ingresoAt = new Date();
    const { predioId, potreroId } = await seedEscenarioCompleto(org, 'LIFECYCLE-A', { ingresoRealAt: ingresoAt });
    const ciclo = await repo.iniciarCicloPastoreo(org, predioId, potreroId, { now: ingresoAt });

    const row = await adminPool.query('select * from agx.potrero_ciclo_lote_real_versiones where ciclo_id = $1', [ciclo.cicloId]);
    assert.equal(row.rows.length, 1);
    assert.equal(row.rows[0].version, 1);
    assert.equal(row.rows[0].salida_real_at, null);
    assert.ok(row.rows[0].ficha_id_base_real, 'debe resolver la ficha creada antes del ingreso como base real');
  });

  test('finalizar crea v2 con salida_real_at non-null; v1 queda invalidada; v2 es la única vigente; descanso referencia v2', async () => {
    const org = randomOrgId();
    const ingresoAt = new Date();
    const { predioId, potreroId } = await seedEscenarioCompleto(org, 'LIFECYCLE-B', { ingresoRealAt: ingresoAt });
    const ciclo = await repo.iniciarCicloPastoreo(org, predioId, potreroId, { now: ingresoAt });
    const salidaAt = horasDespues(ingresoAt, 48);

    const resultado = await repo.finalizarCicloPastoreo(org, predioId, potreroId, ciclo.cicloId, { now: salidaAt, climatologyFetchImpl: SIN_RED_FETCH_IMPL });
    assert.equal(resultado.descansoEstado, 'GENERADO');

    const versiones = await adminPool.query('select version, salida_real_at, snapshot_id from agx.potrero_ciclo_lote_real_versiones where ciclo_id = $1 order by version', [ciclo.cicloId]);
    assert.equal(versiones.rows.length, 2);
    assert.equal(versiones.rows[0].version, 1);
    assert.equal(versiones.rows[1].version, 2);
    assert.notEqual(versiones.rows[1].salida_real_at, null);

    const invalidaciones = await adminPool.query('select snapshot_id from agx.potrero_ciclo_lote_real_invalidaciones where ciclo_id = $1', [ciclo.cicloId]);
    assert.equal(invalidaciones.rows.length, 1, 'exactamente v1 debe quedar invalidada');
    assert.equal(String(invalidaciones.rows[0].snapshot_id), String(versiones.rows[0].snapshot_id), 'la invalidada debe ser v1, nunca v2');

    const descansoRow = await adminPool.query('select lote_real_version_id from agx.potrero_recomendaciones_descanso where descanso_id = $1', [resultado.descanso.descansoId]);
    assert.equal(String(descansoRow.rows[0].lote_real_version_id), String(versiones.rows[1].snapshot_id), 'el descanso debe referenciar v2, la vigente');
  });

  test('retry de finalizar (ciclo ya FINALIZADO) NO crea v3', async () => {
    const org = randomOrgId();
    const ingresoAt = new Date();
    const { predioId, potreroId } = await seedEscenarioCompleto(org, 'LIFECYCLE-C', { ingresoRealAt: ingresoAt });
    const ciclo = await repo.iniciarCicloPastoreo(org, predioId, potreroId, { now: ingresoAt });
    const salidaAt = horasDespues(ingresoAt, 48);

    await repo.finalizarCicloPastoreo(org, predioId, potreroId, ciclo.cicloId, { now: salidaAt, climatologyFetchImpl: SIN_RED_FETCH_IMPL });
    // Retry -- mismo cicloId, ya FINALIZADO.
    const segundo = await repo.finalizarCicloPastoreo(org, predioId, potreroId, ciclo.cicloId, { now: salidaAt, climatologyFetchImpl: SIN_RED_FETCH_IMPL });
    assert.equal(segundo.descansoEstado, 'GENERADO');

    const versiones = await adminPool.query('select version from agx.potrero_ciclo_lote_real_versiones where ciclo_id = $1', [ciclo.cicloId]);
    assert.equal(versiones.rows.length, 2, 'nunca debe crear v3 en un retry idempotente');

    const descansos = await adminPool.query('select descanso_id from agx.potrero_recomendaciones_descanso where ciclo_pastoreo_id = $1', [ciclo.cicloId]);
    assert.equal(descansos.rows.length, 1, 'retry de FASE B nunca duplica el descanso');
  });

  test('doble finalizar CONCURRENTE (misma solicitud en paralelo) produce solo una v2', async () => {
    const org = randomOrgId();
    const ingresoAt = new Date();
    const { predioId, potreroId } = await seedEscenarioCompleto(org, 'LIFECYCLE-D', { ingresoRealAt: ingresoAt });
    const ciclo = await repo.iniciarCicloPastoreo(org, predioId, potreroId, { now: ingresoAt });
    const salidaAt = horasDespues(ingresoAt, 24);

    await Promise.all([
      repo.finalizarCicloPastoreo(org, predioId, potreroId, ciclo.cicloId, { now: salidaAt, climatologyFetchImpl: SIN_RED_FETCH_IMPL }),
      repo.finalizarCicloPastoreo(org, predioId, potreroId, ciclo.cicloId, { now: salidaAt, climatologyFetchImpl: SIN_RED_FETCH_IMPL }),
    ]);

    const versiones = await adminPool.query('select version from agx.potrero_ciclo_lote_real_versiones where ciclo_id = $1', [ciclo.cicloId]);
    assert.equal(versiones.rows.length, 2, 'el FOR UPDATE serializa -- solo una v2, nunca dos');
  });

  // NOTA: un fallo del PROVEEDOR climático (climatologyFetchImpl) degrada
  // graciosamente (getOrGenerateClimatologia atrapa el error y sigue en
  // modo degradado, comportamiento YA establecido en 3D8/3D9.1/3D9.2) --
  // NUNCA lanza. Para ejercitar genuinamente la rama PENDIENTE/ERROR_TECNICO
  // de FASE B se necesita un fallo que SÍ lance dentro de
  // computeDescansoPostCicloRealCore -- mismo mecanismo ya usado en
  // potreroCicloPastoreoSprint3D92RepositoryIntegration.test.js
  // ("descanso nunca resoluble"): una pastura personalizada sin perfil de
  // descanso -> NO_PASTURE_PROFILE.
  test('FASE B con error técnico real (NO_PASTURE_PROFILE): v2 permanece vigente, descanso queda ERROR_TECNICO, nunca se revierte a v1', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D93 LIFECYCLE-E');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D93 LIFECYCLE-E');
    const ingresoAt = new Date();
    const pasturaId = await seedPasturaPersonalizada(org, 'Pastura Sprint3D93 sin perfil');
    const fichaId = await seedFicha(org, potreroId, pasturaId, { fechaAforo: resolveFechaHoyNegocio(ingresoAt), createdAt: ingresoAt });
    await seedRecomendacionPastoreo(org, predioId, potreroId, fichaId);
    const ciclo = await repo.iniciarCicloPastoreo(org, predioId, potreroId, { now: ingresoAt });
    const salidaAt = horasDespues(ingresoAt, 24);

    const resultado = await repo.finalizarCicloPastoreo(org, predioId, potreroId, ciclo.cicloId, { now: salidaAt, climatologyFetchImpl: SIN_RED_FETCH_IMPL });
    assert.ok(['PENDIENTE', 'ERROR_TECNICO'].includes(resultado.descansoEstado));

    const versiones = await adminPool.query('select version from agx.potrero_ciclo_lote_real_versiones where ciclo_id = $1 order by version', [ciclo.cicloId]);
    assert.equal(versiones.rows.length, 2, 'FASE A ya comprometió v2 antes de que FASE B corriera -- nunca se revierte');
    const invalidaciones = await adminPool.query('select snapshot_id from agx.potrero_ciclo_lote_real_invalidaciones where ciclo_id = $1', [ciclo.cicloId]);
    assert.equal(invalidaciones.rows.length, 1);
  });

  // -----------------------------------------------------------------------
  // Aforo base real -- doble guardrail temporal.
  // -----------------------------------------------------------------------

  test('aforo creado ANTES del ingreso, mismo día calendario -> elegible', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D93 AFORO-A');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D93 AFORO-A');
    const pasturaId = await fetchPasturaSistemaId('Brachiaria humidicola');
    const ingresoAt = new Date();
    const fichaCreadaAntes = horasDespues(ingresoAt, -3);
    const fichaId = await seedFicha(org, potreroId, pasturaId, { fechaAforo: resolveFechaHoyNegocio(ingresoAt), createdAt: fichaCreadaAntes });
    await seedRecomendacionPastoreo(org, predioId, potreroId, fichaId);

    const ciclo = await repo.iniciarCicloPastoreo(org, predioId, potreroId, { now: ingresoAt });
    const row = await adminPool.query('select ficha_id_base_real from agx.potrero_ciclo_lote_real_versiones where ciclo_id = $1', [ciclo.cicloId]);
    assert.equal(String(row.rows[0].ficha_id_base_real), String(fichaId));
  });

  test('aforo creado DESPUÉS del ingreso, mismo día calendario -> NO elegible (guardrail created_at)', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D93 AFORO-B');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D93 AFORO-B');
    const pasturaId = await fetchPasturaSistemaId('Brachiaria humidicola');
    const ingresoAt = new Date();
    const fichaCreadaDespues = horasDespues(ingresoAt, 3);
    // fecha_aforo declarado como HOY (o incluso ayer) -- pero created_at
    // (hecho de sistema) es posterior al ingreso -> nunca elegible.
    const fichaId = await seedFicha(org, potreroId, pasturaId, { fechaAforo: resolveFechaHoyNegocio(ingresoAt), createdAt: fichaCreadaDespues });
    await seedRecomendacionPastoreo(org, predioId, potreroId, fichaId);

    const ciclo = await repo.iniciarCicloPastoreo(org, predioId, potreroId, { now: ingresoAt });
    const row = await adminPool.query('select ficha_id_base_real from agx.potrero_ciclo_lote_real_versiones where ciclo_id = $1', [ciclo.cicloId]);
    assert.equal(row.rows[0].ficha_id_base_real, null, 'un aforo registrado en el sistema DESPUÉS del ingreso nunca debe contaminar la base real, aunque declare una fecha_aforo anterior');
  });

  test('aforo de día calendario ANTERIOR -> elegible', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D93 AFORO-C');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D93 AFORO-C');
    const pasturaId = await fetchPasturaSistemaId('Brachiaria humidicola');
    const ingresoAt = new Date();
    const ayer = new Date(ingresoAt.getTime() - 24 * 60 * 60 * 1000);
    const fichaId = await seedFicha(org, potreroId, pasturaId, { fechaAforo: resolveFechaHoyNegocio(ayer), createdAt: ayer });
    await seedRecomendacionPastoreo(org, predioId, potreroId, fichaId);

    const ciclo = await repo.iniciarCicloPastoreo(org, predioId, potreroId, { now: ingresoAt });
    const row = await adminPool.query('select ficha_id_base_real from agx.potrero_ciclo_lote_real_versiones where ciclo_id = $1', [ciclo.cicloId]);
    assert.equal(String(row.rows[0].ficha_id_base_real), String(fichaId));
  });

  test('aforo de fecha POSTERIOR al ingreso -> nunca elegible (nunca contamina REAL pressure)', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D93 AFORO-D');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D93 AFORO-D');
    const pasturaId = await fetchPasturaSistemaId('Brachiaria humidicola');
    const ingresoAt = new Date();
    const manana = new Date(ingresoAt.getTime() + 24 * 60 * 60 * 1000);
    const fichaId = await seedFicha(org, potreroId, pasturaId, { fechaAforo: resolveFechaHoyNegocio(manana), createdAt: ingresoAt });
    await seedRecomendacionPastoreo(org, predioId, potreroId, fichaId);

    const ciclo = await repo.iniciarCicloPastoreo(org, predioId, potreroId, { now: ingresoAt });
    const row = await adminPool.query('select ficha_id_base_real from agx.potrero_ciclo_lote_real_versiones where ciclo_id = $1', [ciclo.cicloId]);
    assert.equal(row.rows[0].ficha_id_base_real, null);
  });

  test('ficha con fecha_aforo NULL -> nunca elegible', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D93 AFORO-E');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D93 AFORO-E');
    const pasturaId = await fetchPasturaSistemaId('Brachiaria humidicola');
    const ingresoAt = new Date();
    const fichaId = await seedFicha(org, potreroId, pasturaId, { fechaAforo: null, createdAt: horasDespues(ingresoAt, -3) });
    await seedRecomendacionPastoreo(org, predioId, potreroId, fichaId);

    const ciclo = await repo.iniciarCicloPastoreo(org, predioId, potreroId, { now: ingresoAt });
    const row = await adminPool.query('select ficha_id_base_real from agx.potrero_ciclo_lote_real_versiones where ciclo_id = $1', [ciclo.cicloId]);
    assert.equal(row.rows[0].ficha_id_base_real, null);
  });

  // -----------------------------------------------------------------------
  // Pipeline REAL pressure -- fuentePresion, duración, equivalencia.
  // -----------------------------------------------------------------------

  test('duración 0 (salida_real_at == ingreso_real_at) -> PLAN_FALLBACK, NUNCA 0 kg de consumo como base del descanso', async () => {
    const org = randomOrgId();
    const ingresoAt = new Date();
    const { predioId, potreroId } = await seedEscenarioCompleto(org, 'DURACION-A', { ingresoRealAt: ingresoAt });
    const ciclo = await repo.iniciarCicloPastoreo(org, predioId, potreroId, { now: ingresoAt });

    const resultado = await repo.finalizarCicloPastoreo(org, predioId, potreroId, ciclo.cicloId, { now: ingresoAt, climatologyFetchImpl: SIN_RED_FETCH_IMPL });
    assert.equal(resultado.descanso.fuentePresion, 'PLAN_FALLBACK');
    assert.equal(resultado.descanso.fuentePresionMotivo, 'DURACION_INVALIDA');
  });

  test('duración positiva (48h) -> fuentePresion REAL, planVsReal.real presente', async () => {
    const org = randomOrgId();
    const ingresoAt = new Date();
    const { predioId, potreroId } = await seedEscenarioCompleto(org, 'DURACION-B', { ingresoRealAt: ingresoAt });
    const ciclo = await repo.iniciarCicloPastoreo(org, predioId, potreroId, { now: ingresoAt });
    const salidaAt = horasDespues(ingresoAt, 48);

    const resultado = await repo.finalizarCicloPastoreo(org, predioId, potreroId, ciclo.cicloId, { now: salidaAt, climatologyFetchImpl: SIN_RED_FETCH_IMPL });
    assert.equal(resultado.descanso.fuentePresion, 'REAL');
    assert.ok(resultado.descanso.planVsReal.real);
    assert.equal(resultado.descanso.planVsReal.real.permanenciaHoras, 48);
  });

  test('sin ficha base real elegible -> PLAN_FALLBACK', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D93 SINFICHA');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D93 SINFICHA');
    const pasturaId = await fetchPasturaSistemaId('Brachiaria humidicola');
    const ingresoAt = new Date();
    // Ficha creada DESPUÉS del ingreso -> nunca elegible como base real.
    const fichaId = await seedFicha(org, potreroId, pasturaId, { fechaAforo: resolveFechaHoyNegocio(ingresoAt), createdAt: horasDespues(ingresoAt, 1) });
    await seedRecomendacionPastoreo(org, predioId, potreroId, fichaId);

    const ciclo = await repo.iniciarCicloPastoreo(org, predioId, potreroId, { now: ingresoAt });
    const salidaAt = horasDespues(ingresoAt, 48);
    const resultado = await repo.finalizarCicloPastoreo(org, predioId, potreroId, ciclo.cicloId, { now: salidaAt, climatologyFetchImpl: SIN_RED_FETCH_IMPL });
    assert.equal(resultado.descanso.fuentePresion, 'PLAN_FALLBACK');
    assert.equal(resultado.descanso.fuentePresionMotivo, 'FICHA_BASE_AUSENTE');
  });

  test('PLAN=REAL: mismo lote/categoría/peso y duración exactamente 5 días (120h) -> demanda/consumo REAL equivalentes al PLAN dentro de tolerancia', async () => {
    const org = randomOrgId();
    const ingresoAt = new Date();
    const { predioId, potreroId } = await seedEscenarioCompleto(org, 'EQUIV-A', { ingresoRealAt: ingresoAt });
    // PLAN seedeado: 10 animales, 420kg, dias_ocupacion_estimados=5 (exacto).
    const ciclo = await repo.iniciarCicloPastoreo(org, predioId, potreroId, { now: ingresoAt });
    const salidaAt = horasDespues(ingresoAt, 120); // exactamente 5 días

    const resultado = await repo.finalizarCicloPastoreo(org, predioId, potreroId, ciclo.cicloId, { now: salidaAt, climatologyFetchImpl: SIN_RED_FETCH_IMPL });
    const { plan, real } = resultado.descanso.planVsReal;
    assert.ok(real, 'REAL debe estar disponible (mismo lote que PLAN, duración exacta)');
    assert.equal(real.demandaDiariaLoteKgMs, plan.demandaDiariaLoteKgMs, 'mismo lote/categoría/peso -> misma demanda diaria');
    assert.ok(Math.abs(real.consumoTotalEstimadoKg - plan.consumoProyectadoKg) < 1e-6, 'consumo REAL == consumo PLAN cuando la duración real coincide exactamente con los días de ocupación recomendados');
  });

  test('REAL con lote MAYOR que PLAN (30 vs 10 animales) -> presión REAL mayor (más consumo, menor remanente)', async () => {
    const org = randomOrgId();
    const ingresoAt = new Date();
    const { predioId, potreroId, recomendacionId } = await seedEscenarioCompleto(org, 'PRESION-A', { ingresoRealAt: ingresoAt });
    void recomendacionId;
    const ciclo = await repo.iniciarCicloPastoreo(org, predioId, potreroId, { now: ingresoAt, numeroAnimales: 30, pesoPromedioKg: 420 });
    const salidaAt = horasDespues(ingresoAt, 120);

    const resultado = await repo.finalizarCicloPastoreo(org, predioId, potreroId, ciclo.cicloId, { now: salidaAt, climatologyFetchImpl: SIN_RED_FETCH_IMPL });
    const { plan, real } = resultado.descanso.planVsReal;
    assert.ok(real.demandaDiariaLoteKgMs > plan.demandaDiariaLoteKgMs, 'REAL (30 animales) debe demandar más que PLAN (10 animales)');
    assert.ok(real.remanenteEstimadoKg < plan.remanenteProyectadoKg, 'más consumo real -> menor remanente real');
  });

  test('REAL con lote MENOR que PLAN (5 vs 10 animales) -> presión REAL menor (menos consumo, mayor remanente)', async () => {
    const org = randomOrgId();
    const ingresoAt = new Date();
    const { predioId, potreroId } = await seedEscenarioCompleto(org, 'PRESION-B', { ingresoRealAt: ingresoAt });
    const ciclo = await repo.iniciarCicloPastoreo(org, predioId, potreroId, { now: ingresoAt, numeroAnimales: 5, pesoPromedioKg: 420 });
    const salidaAt = horasDespues(ingresoAt, 120);

    const resultado = await repo.finalizarCicloPastoreo(org, predioId, potreroId, ciclo.cicloId, { now: salidaAt, climatologyFetchImpl: SIN_RED_FETCH_IMPL });
    const { plan, real } = resultado.descanso.planVsReal;
    assert.ok(real.demandaDiariaLoteKgMs < plan.demandaDiariaLoteKgMs);
    assert.ok(real.remanenteEstimadoKg > plan.remanenteProyectadoKg);
  });

  test('categoría real distinta de la PLAN cambia la demanda REAL', async () => {
    const org = randomOrgId();
    const ingresoAt = new Date();
    const { predioId, potreroId } = await seedEscenarioCompleto(org, 'CATEGORIA-A', { ingresoRealAt: ingresoAt });
    // PLAN sembrado con novillo_ceba; ajuste real a ternera_levante (mayor
    // %PV típico -- ver 0007 seed) al iniciar.
    const ciclo = await repo.iniciarCicloPastoreo(org, predioId, potreroId, { now: ingresoAt, categoriaCodigo: 'ternera_levante' });
    const salidaAt = horasDespues(ingresoAt, 120);

    const resultado = await repo.finalizarCicloPastoreo(org, predioId, potreroId, ciclo.cicloId, { now: salidaAt, climatologyFetchImpl: SIN_RED_FETCH_IMPL });
    const { plan, real } = resultado.descanso.planVsReal;
    assert.notEqual(real.categoria, plan.categoria);
    assert.notEqual(real.demandaDiariaLoteKgMs, plan.demandaDiariaLoteKgMs);
  });

  // -----------------------------------------------------------------------
  // Corrección versionada del snapshot real.
  // -----------------------------------------------------------------------

  test('corrección de numeroAnimales real sobre ciclo FINALIZADO crea v3, invalida v2, regenera descanso', async () => {
    const org = randomOrgId();
    const ingresoAt = new Date();
    const { predioId, potreroId } = await seedEscenarioCompleto(org, 'CORREGIR-A', { ingresoRealAt: ingresoAt });
    const ciclo = await repo.iniciarCicloPastoreo(org, predioId, potreroId, { now: ingresoAt });
    const salidaAt = horasDespues(ingresoAt, 120);
    await repo.finalizarCicloPastoreo(org, predioId, potreroId, ciclo.cicloId, { now: salidaAt, climatologyFetchImpl: SIN_RED_FETCH_IMPL });

    const corregido = await repo.corregirCicloPastoreo(org, predioId, potreroId, ciclo.cicloId, {
      numeroAnimales: 25, motivo: 'conteo real corregido', climatologyFetchImpl: SIN_RED_FETCH_IMPL,
    });
    assert.equal(corregido.descansoEstado, 'GENERADO');

    const versiones = await adminPool.query('select version, numero_animales from agx.potrero_ciclo_lote_real_versiones where ciclo_id = $1 order by version', [ciclo.cicloId]);
    assert.equal(versiones.rows.length, 3);
    assert.equal(versiones.rows[2].numero_animales, 25);

    const invalidaciones = await adminPool.query('select snapshot_id from agx.potrero_ciclo_lote_real_invalidaciones where ciclo_id = $1', [ciclo.cicloId]);
    assert.equal(invalidaciones.rows.length, 2, 'v1 (al finalizar) y v2 (al corregir) deben quedar invalidadas');

    // Mirror legacy sincronizado -- fuente única de verdad, sin dos caminos.
    const cicloRow = await adminPool.query('select numero_animales_real from agx.potrero_ciclos_pastoreo where ciclo_id = $1', [ciclo.cicloId]);
    assert.equal(cicloRow.rows[0].numero_animales_real, 25);
  });

  test('corrección con el MISMO payload ya aplicado es idempotente -- no crea v4', async () => {
    const org = randomOrgId();
    const ingresoAt = new Date();
    const { predioId, potreroId } = await seedEscenarioCompleto(org, 'CORREGIR-B', { ingresoRealAt: ingresoAt });
    const ciclo = await repo.iniciarCicloPastoreo(org, predioId, potreroId, { now: ingresoAt });
    const salidaAt = horasDespues(ingresoAt, 120);
    await repo.finalizarCicloPastoreo(org, predioId, potreroId, ciclo.cicloId, { now: salidaAt, climatologyFetchImpl: SIN_RED_FETCH_IMPL });
    await repo.corregirCicloPastoreo(org, predioId, potreroId, ciclo.cicloId, { numeroAnimales: 25, motivo: 'primera corrección', climatologyFetchImpl: SIN_RED_FETCH_IMPL });

    await repo.corregirCicloPastoreo(org, predioId, potreroId, ciclo.cicloId, { numeroAnimales: 25, motivo: 'retry mismo valor', climatologyFetchImpl: SIN_RED_FETCH_IMPL });

    const versiones = await adminPool.query('select version from agx.potrero_ciclo_lote_real_versiones where ciclo_id = $1', [ciclo.cicloId]);
    assert.equal(versiones.rows.length, 3, 'retry con el mismo valor no debe crear v4');
  });

  // -----------------------------------------------------------------------
  // Fuente única de verdad + tenant isolation.
  // -----------------------------------------------------------------------

  test('resolveLoteCientificoCiclo: fuente SNAPSHOT cuando existe versión vigente', async () => {
    const org = randomOrgId();
    const ingresoAt = new Date();
    const { predioId, potreroId } = await seedEscenarioCompleto(org, 'FUENTE-A', { ingresoRealAt: ingresoAt });
    const ciclo = await repo.iniciarCicloPastoreo(org, predioId, potreroId, { now: ingresoAt });

    const client = await adminPool.connect();
    try {
      const resultado = await realPressureRepo.resolveLoteCientificoCiclo(client, { cicloId: ciclo.cicloId, cicloRow: { categoria_id: ciclo.categoriaId, numero_animales_real: ciclo.numeroAnimalesReal, peso_promedio_real_kg: ciclo.pesoPromedioRealKg } });
      assert.equal(resultado.fuente, 'SNAPSHOT');
    } finally {
      client.release();
    }
  });

  test('tenant isolation: snapshot de ORG A invisible para ORG B (RLS)', async () => {
    const orgA = randomOrgId();
    const orgB = randomOrgId();
    const ingresoAt = new Date();
    const { predioId, potreroId } = await seedEscenarioCompleto(orgA, 'TENANT-A', { ingresoRealAt: ingresoAt });
    const ciclo = await repo.iniciarCicloPastoreo(orgA, predioId, potreroId, { now: ingresoAt });

    await assert.rejects(
      () => repo.finalizarCicloPastoreo(orgB, predioId, potreroId, ciclo.cicloId, { climatologyFetchImpl: SIN_RED_FETCH_IMPL }),
      (error) => error.status === 404 && error.code === 'CICLO_NOT_FOUND',
    );
  });

  // -----------------------------------------------------------------------
  // SPRINT-3D9.3 PRE-COMMIT FIX ROUND, punto 1 -- tests dedicados de los
  // dos motivos de PLAN_FALLBACK que no tenían cobertura propia.
  // -----------------------------------------------------------------------

  test('A) computeRealPressureCore directo sobre v1 (ciclo aún EN_CURSO, sin salida_real_at) -> disponible:false, motivo TIMESTAMPS_INCOMPLETOS; PLAN sigue operativo una vez finaliza', async () => {
    const org = randomOrgId();
    const ingresoAt = new Date();
    const { predioId, potreroId } = await seedEscenarioCompleto(org, 'FALLBACK-A', { ingresoRealAt: ingresoAt });
    const ciclo = await repo.iniciarCicloPastoreo(org, predioId, potreroId, { now: ingresoAt });

    const client = await adminPool.connect();
    try {
      const v1 = await realPressureRepo.fetchSnapshotLoteRealVigente(client, ciclo.cicloId);
      assert.equal(v1.salidaRealAt, null, 'precondición real: v1 recién creado por Iniciar nunca tiene salida_real_at');
      const resultado = await realPressureRepo.computeRealPressureCore(client, { potreroId, snapshot: v1 });
      assert.equal(resultado.disponible, false);
      assert.equal(resultado.motivo, realPressureRepo.REAL_PRESSURE_UNAVAILABLE.TIMESTAMPS_INCOMPLETOS);
    } finally {
      client.release();
    }

    // No se calcula NADA de REAL con evidencia incompleta -- pero el
    // ciclo/descanso PLAN siguen operativos: al finalizar (v2 SÍ obtiene
    // salida_real_at), la presión REAL queda disponible con normalidad.
    const salidaAt = horasDespues(ingresoAt, 48);
    const resultadoFinal = await repo.finalizarCicloPastoreo(org, predioId, potreroId, ciclo.cicloId, { now: salidaAt, climatologyFetchImpl: SIN_RED_FETCH_IMPL });
    assert.equal(resultadoFinal.descansoEstado, 'GENERADO', 'el descanso PLAN/REAL se genera con normalidad -- el estado incompleto de v1 nunca bloquea nada');
    assert.equal(resultadoFinal.descanso.fuentePresion, 'REAL');
  });

  test('B) categoría lactante SIN produccionLecheLDia -> fuentePresion PLAN_FALLBACK, motivo INPUT_CIENTIFICO_REQUERIDO_AUSENTE, sin inferencia/default silencioso, sin cálculo REAL con evidencia incompleta', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D93 FALLBACK-B');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D93 FALLBACK-B');
    const pasturaId = await fetchPasturaSistemaId('Brachiaria humidicola');
    const ingresoAt = new Date();
    const fichaId = await seedFicha(org, potreroId, pasturaId, { fechaAforo: resolveFechaHoyNegocio(ingresoAt), createdAt: ingresoAt });
    // PLAN sembrado como categoría lactante (requiere produccionLecheLDia)
    // SIN ese dato -- simula un input condicional nunca capturado.
    await seedRecomendacionPastoreo(org, predioId, potreroId, fichaId, { categoriaCodigo: 'vaca_leche_produccion', numeroAnimales: 8, pesoPromedioKg: 480 });

    const ciclo = await repo.iniciarCicloPastoreo(org, predioId, potreroId, { now: ingresoAt });
    const snapshotRow = await adminPool.query('select produccion_leche_l_dia from agx.potrero_ciclo_lote_real_versiones where ciclo_id = $1', [ciclo.cicloId]);
    assert.equal(snapshotRow.rows[0].produccion_leche_l_dia, null, 'precondición: nunca se infiere/asume un valor por defecto para un input condicional ausente');

    const salidaAt = horasDespues(ingresoAt, 120);
    const resultado = await repo.finalizarCicloPastoreo(org, predioId, potreroId, ciclo.cicloId, { now: salidaAt, climatologyFetchImpl: SIN_RED_FETCH_IMPL });
    assert.equal(resultado.descansoEstado, 'GENERADO');
    assert.equal(resultado.descanso.fuentePresion, 'PLAN_FALLBACK');
    assert.equal(resultado.descanso.fuentePresionMotivo, realPressureRepo.REAL_PRESSURE_UNAVAILABLE.INPUT_CIENTIFICO_REQUERIDO_AUSENTE);
    assert.equal(resultado.descanso.planVsReal.real, null, 'nunca se calcula un resultado REAL cuando falta un input científico requerido por la categoría');
  });

  // -----------------------------------------------------------------------
  // SPRINT-3D9.3 PRE-COMMIT FIX ROUND, punto 2 -- semántica formal de
  // corrección temporal: nuevoTimestamp = timestampOriginal + deltaDias.
  // -----------------------------------------------------------------------

  test('C) corrección de fecha_ingreso_real: preserva la hora exacta, sincroniza ciclo<->snapshot, invalida la versión anterior, RE-RESUELVE ficha_id_base_real (puede volverse inelegible)', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D93 TEMPORAL-A');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D93 TEMPORAL-A');
    const pasturaId = await fetchPasturaSistemaId('Brachiaria humidicola');

    // Ingreso ORIGINAL: día D a las 13:37 UTC. Ficha creada el MISMO día D
    // a las 06:00 UTC (antes del ingreso original -> elegible). Al
    // corregir el ingreso a D-1, la ficha (que sigue fechada el día D)
    // pasa a ser POSTERIOR al nuevo ingreso -> debe volverse INELEGIBLE
    // (ficha_id_base_real -> null), demostrando que se re-resuelve de
    // verdad y no se copia a ciegas de la versión anterior.
    const ingresoOriginal = new Date('2026-08-28T13:37:00.000Z');
    const fichaCreatedAt = new Date('2026-08-28T06:00:00.000Z');
    const fichaId = await seedFicha(org, potreroId, pasturaId, { fechaAforo: resolveFechaHoyNegocio(fichaCreatedAt), createdAt: fichaCreatedAt });
    await seedRecomendacionPastoreo(org, predioId, potreroId, fichaId);

    const ciclo = await repo.iniciarCicloPastoreo(org, predioId, potreroId, { now: ingresoOriginal });
    const v1 = await adminPool.query('select ficha_id_base_real from agx.potrero_ciclo_lote_real_versiones where ciclo_id = $1 and version = 1', [ciclo.cicloId]);
    assert.equal(String(v1.rows[0].ficha_id_base_real), String(fichaId), 'precondición: elegible para el ingreso ORIGINAL');

    const salidaAt = horasDespues(ingresoOriginal, 120);
    await repo.finalizarCicloPastoreo(org, predioId, potreroId, ciclo.cicloId, { now: salidaAt, climatologyFetchImpl: SIN_RED_FETCH_IMPL });

    const fechaIngresoNuevaIso = resolveFechaHoyNegocio(new Date(ingresoOriginal.getTime() - 24 * 60 * 60 * 1000));

    const corregido = await repo.corregirCicloPastoreo(org, predioId, potreroId, ciclo.cicloId, {
      fechaIngresoReal: fechaIngresoNuevaIso, motivo: 'ingreso mal capturado', climatologyFetchImpl: SIN_RED_FETCH_IMPL,
    });
    assert.equal(corregido.descansoEstado, 'GENERADO');
    assert.equal(corregido.descanso.fuentePresion, 'PLAN_FALLBACK', 'sin ficha elegible tras la corrección, gobierna PLAN -- nunca se inventa evidencia');

    const cicloRow = await adminPool.query('select ingreso_real_at from agx.potrero_ciclos_pastoreo where ciclo_id = $1', [ciclo.cicloId]);
    const versiones = await adminPool.query('select version, ingreso_real_at, ficha_id_base_real from agx.potrero_ciclo_lote_real_versiones where ciclo_id = $1 order by version', [ciclo.cicloId]);
    assert.equal(versiones.rows.length, 3, 'v1 (iniciar) + v2 (finalizar) + v3 (corrección de ingreso)');
    const v3 = versiones.rows[2];

    // Sincronía EXACTA ciclo <-> snapshot vigente (nunca pueden divergir).
    assert.equal(new Date(cicloRow.rows[0].ingreso_real_at).getTime(), new Date(v3.ingreso_real_at).getTime());

    // Regla formal: nuevoTimestamp = timestampOriginal + deltaDias --
    // EXACTAMENTE 24h antes, ni más ni menos (la hora-del-día 13:37 se
    // preserva sin drift de timezone).
    assert.equal(new Date(v3.ingreso_real_at).getTime(), ingresoOriginal.getTime() - 24 * 60 * 60 * 1000);

    // Re-resolución real (no copia): la ficha, elegible para el ingreso
    // original, queda INELEGIBLE para el ingreso corregido (más temprano).
    assert.equal(v3.ficha_id_base_real, null);

    const invalidaciones = await adminPool.query('select snapshot_id from agx.potrero_ciclo_lote_real_invalidaciones where ciclo_id = $1', [ciclo.cicloId]);
    assert.equal(invalidaciones.rows.length, 2, 'v1 (al finalizar) y v2 (al corregir el ingreso) deben quedar invalidadas');
  });

  test('D) corrección de fecha_salida_real: preserva la hora exacta, sincroniza ciclo<->snapshot, NUNCA re-resuelve ficha_id_base_real (la base se fija al ingreso, no a la salida)', async () => {
    const org = randomOrgId();
    const ingresoAt = new Date('2026-08-20T10:15:00.000Z');
    const { predioId, potreroId } = await seedEscenarioCompleto(org, 'TEMPORAL-B', { ingresoRealAt: ingresoAt });
    const ciclo = await repo.iniciarCicloPastoreo(org, predioId, potreroId, { now: ingresoAt });
    const salidaOriginal = new Date('2026-08-25T18:22:00.000Z');
    await repo.finalizarCicloPastoreo(org, predioId, potreroId, ciclo.cicloId, { now: salidaOriginal, climatologyFetchImpl: SIN_RED_FETCH_IMPL });

    const v2 = await adminPool.query('select ficha_id_base_real from agx.potrero_ciclo_lote_real_versiones where ciclo_id = $1 and version = 2', [ciclo.cicloId]);
    const fichaIdBaseRealOriginal = v2.rows[0].ficha_id_base_real;
    assert.notEqual(fichaIdBaseRealOriginal, null);

    const fechaSalidaNuevaIso = resolveFechaHoyNegocio(new Date(salidaOriginal.getTime() + 24 * 60 * 60 * 1000));

    const corregido = await repo.corregirCicloPastoreo(org, predioId, potreroId, ciclo.cicloId, {
      fechaSalidaReal: fechaSalidaNuevaIso, motivo: 'salida mal capturada', climatologyFetchImpl: SIN_RED_FETCH_IMPL,
    });
    assert.equal(corregido.descansoEstado, 'GENERADO');

    const cicloRow = await adminPool.query('select salida_real_at from agx.potrero_ciclos_pastoreo where ciclo_id = $1', [ciclo.cicloId]);
    const v3 = await adminPool.query('select salida_real_at, ficha_id_base_real from agx.potrero_ciclo_lote_real_versiones where ciclo_id = $1 and version = 3', [ciclo.cicloId]);

    assert.equal(new Date(cicloRow.rows[0].salida_real_at).getTime(), new Date(v3.rows[0].salida_real_at).getTime());
    assert.equal(new Date(v3.rows[0].salida_real_at).getTime(), salidaOriginal.getTime() + 24 * 60 * 60 * 1000, 'EXACTAMENTE 24h después, hora-del-día 18:22 preservada');
    assert.equal(String(v3.rows[0].ficha_id_base_real), String(fichaIdBaseRealOriginal), 'corregir la SALIDA nunca re-resuelve la ficha base -- esa evidencia se fija al ingreso');
  });
});
