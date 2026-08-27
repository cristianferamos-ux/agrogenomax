// SPRINT-3D9.1 -- CICLO REAL DE PASTOREO: pruebas del repositorio
// (server/services/ganaderia/potreroCicloPastoreoRepository.js) contra
// Postgres/PostGIS REAL. Cubre: lifecycle completo (Iniciar/Finalizar/
// Cancelar), FASE A/FASE B desacopladas, idempotencia post-finalización,
// concurrencia (unique EN_CURSO + CAS), integridad predio-potrero
// (Guardrail 1), tenant isolation, integración con el descanso post-real
// (salida real ancla el nuevo descanso, previous_descanso_id, histórico
// intacto).
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
let repo;
let descansoRepo;
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

  adminPool = new pg.Pool({ connectionString: adminConnectionString, max: 4 });
  await adminPool.query('select 1');

  const tableCheck = await adminPool.query("select to_regclass('agx.potrero_ciclos_pastoreo') as t");
  dbAvailable = Boolean(tableCheck.rows[0]?.t);
} catch {
  dbAvailable = false;
}

if (dbAvailable) {
  repo = await import('../ganaderia/potreroCicloPastoreoRepository.js');
  descansoRepo = await import('../ganaderia/potreroDescansoRepository.js');
  businessDb = await import('../../db/agxBusinessPool.js');
}

function randomOrgId() {
  return crypto.randomUUID();
}

// FASE B nunca depende de la red real -- mismo patrón de todo el
// dominio: un fetchImpl inyectado que falla de inmediato. Per el diseño,
// esto NO impide que se genere un descanso (degrada a
// INSUFFICIENT_LOCAL_CLIMATOLOGY, guardrail absoluto) -- ver test
// dedicado "FASE B ... aunque el proveedor climático esté caído".
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

async function seedFicha(orgId, potreroId, pasturaId) {
  const fichaResult = await adminPool.query(
    `insert into agx.potrero_fichas_productivas (organizacion_id, potrero_id, tipo_cobertura, nombre_principal, aforo_promedio_g_m2, fecha_aforo, biomasa_total_kg)
     values ($1, $2, 'pastura', 'Pastura Test', 500, current_date, 5000) returning ficha_id`,
    [orgId, potreroId],
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

async function seedRecomendacionPastoreo(org, predioId, potreroId, fichaId, { numeroAnimales = 10, pesoPromedioKg = 420 } = {}) {
  const categoriaId = await fetchCategoriaId('novillo_ceba');
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

async function seedEscenarioCompleto(org, sufijo) {
  const predioId = await seedPredio(org, `Predio Sprint3D9R ${sufijo}`);
  const potreroId = await seedPotrero(org, predioId, `Potrero Sprint3D9R ${sufijo}`);
  const pasturaId = await fetchPasturaSistemaId('Brachiaria humidicola');
  const fichaId = await seedFicha(org, potreroId, pasturaId);
  const recomendacionId = await seedRecomendacionPastoreo(org, predioId, potreroId, fichaId);
  return { predioId, potreroId, fichaId, recomendacionId };
}

describe('SPRINT-3D9.1: potreroCicloPastoreoRepository contra Postgres-AGX-Business real', { skip: !dbAvailable }, () => {
  after(async () => {
    if (!adminPool) return;
    // GUARDRAIL 1/2: ciclos_pastoreo <-> recomendaciones_descanso tienen un
    // vínculo cíclico (plan y post-real, ambos nullable) -- hay que romperlo
    // antes de poder borrar cualquiera de las dos tablas sin violar FK.
    await adminPool.query(`update agx.potrero_recomendaciones_descanso set ciclo_pastoreo_id = null where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D9R%')`);
    await adminPool.query(`update agx.potrero_ciclos_pastoreo set recomendacion_descanso_plan_id = null where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D9R%')`);
    await adminPool.query(`delete from agx.potrero_ciclo_eventos where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D9R%')`);
    await adminPool.query(`delete from agx.potrero_ciclos_pastoreo where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D9R%')`);
    await adminPool.query(`delete from agx.potrero_recomendaciones_descanso where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D9R%')`);
    await adminPool.query(`delete from agx.potrero_recomendaciones_pastoreo where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D9R%')`);
    await adminPool.query(`delete from agx.potrero_ficha_pasturas where ficha_id in (select ficha_id from agx.potrero_fichas_productivas where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D9R%'))`);
    await adminPool.query(`delete from agx.potrero_fichas_productivas where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D9R%')`);
    await adminPool.query(`delete from agx.catalogo_pasturas where nombre_comun like 'Pastura Sprint3D9R%'`);
    await adminPool.query(`delete from agx.potreros where nombre like 'Potrero Sprint3D9R%'`);
    await adminPool.query(`delete from agx.predios where nombre_predio like 'Predio Sprint3D9R%'`);
    if (businessDb) await businessDb.closeAgxBusinessPool();
    await adminPool.end();
  });

  // -----------------------------------------------------------------------
  // INICIAR
  // -----------------------------------------------------------------------

  test('Iniciar: crea el ciclo EN_CURSO + evento PASTOREO_INICIADO, precargando el lote desde la recomendación de pastoreo', async () => {
    const org = randomOrgId();
    const { predioId, potreroId, recomendacionId } = await seedEscenarioCompleto(org, 'INICIAR');

    const ciclo = await repo.iniciarCicloPastoreo(org, predioId, potreroId);

    assert.equal(ciclo.estado, 'EN_CURSO');
    assert.equal(ciclo.recomendacionPastoreoId, String(recomendacionId));
    assert.equal(ciclo.numeroAnimalesReal, 10);
    assert.equal(ciclo.pesoPromedioRealKg, 420);
    assert.match(ciclo.fechaIngresoReal, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(ciclo.fechaSalidaReal, null);

    const eventos = await adminPool.query(`select tipo_evento, payload_json from agx.potrero_ciclo_eventos where ciclo_id = $1`, [ciclo.cicloId]);
    assert.equal(eventos.rows.length, 1);
    assert.equal(eventos.rows[0].tipo_evento, 'PASTOREO_INICIADO');
    assert.equal(eventos.rows[0].payload_json.numeroAnimalesReal, 10);
  });

  test('Iniciar: el lote REAL puede diferir del planificado sin modificar la recomendación de pastoreo original', async () => {
    const org = randomOrgId();
    const { predioId, potreroId, recomendacionId } = await seedEscenarioCompleto(org, 'AJUSTE-LOTE');

    const ciclo = await repo.iniciarCicloPastoreo(org, predioId, potreroId, { numeroAnimales: 9, pesoPromedioKg: 405 });
    assert.equal(ciclo.numeroAnimalesReal, 9);
    assert.equal(ciclo.pesoPromedioRealKg, 405);

    const recomendacionOriginal = await adminPool.query('select numero_animales, peso_promedio_kg from agx.potrero_recomendaciones_pastoreo where recomendacion_id = $1', [recomendacionId]);
    assert.equal(recomendacionOriginal.rows[0].numero_animales, 10, 'la recomendación de pastoreo original NUNCA se modifica');
    assert.equal(Number(recomendacionOriginal.rows[0].peso_promedio_kg), 420);
  });

  test('Iniciar: sin recomendación de pastoreo guardada -> NO_GRAZING_RECOMMENDATION', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D9R NOREC');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D9R NOREC');
    await assert.rejects(
      () => repo.iniciarCicloPastoreo(org, predioId, potreroId),
      (error) => error.status === 404 && error.code === 'NO_GRAZING_RECOMMENDATION',
    );
  });

  test('Iniciar: doble clic / dos requests concurrentes -> exactamente un EN_CURSO persiste, el otro recibe CICLO_ALREADY_IN_PROGRESS (garantía DB)', async () => {
    const org = randomOrgId();
    const { predioId, potreroId } = await seedEscenarioCompleto(org, 'DOBLE-INICIAR');

    const resultados = await Promise.allSettled([
      repo.iniciarCicloPastoreo(org, predioId, potreroId),
      repo.iniciarCicloPastoreo(org, predioId, potreroId),
    ]);
    const exitosos = resultados.filter((r) => r.status === 'fulfilled');
    const rechazados = resultados.filter((r) => r.status === 'rejected');
    assert.equal(exitosos.length, 1, 'exactamente una de las dos debe tener éxito');
    assert.equal(rechazados.length, 1);
    assert.equal(rechazados[0].reason.code, 'CICLO_ALREADY_IN_PROGRESS');
    assert.equal(rechazados[0].reason.status, 409);

    const conteo = await adminPool.query(`select count(*) from agx.potrero_ciclos_pastoreo where potrero_id = $1 and estado = 'EN_CURSO'`, [potreroId]);
    assert.equal(Number(conteo.rows[0].count), 1);
  });

  // -----------------------------------------------------------------------
  // FINALIZAR -- FASE A / FASE B
  // -----------------------------------------------------------------------

  test('Finalizar: FASE A transiciona a FINALIZADO + fecha_salida_real + evento PASTOREO_FINALIZADO; FASE B genera el descanso post-real en la MISMA respuesta', async () => {
    const org = randomOrgId();
    const { predioId, potreroId } = await seedEscenarioCompleto(org, 'FINALIZAR');
    const ciclo = await repo.iniciarCicloPastoreo(org, predioId, potreroId);

    const resultado = await repo.finalizarCicloPastoreo(org, predioId, potreroId, ciclo.cicloId, { climatologyFetchImpl: SIN_RED_FETCH_IMPL });

    assert.equal(resultado.ciclo.estado, 'FINALIZADO');
    assert.match(resultado.ciclo.fechaSalidaReal, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(resultado.ciclo.fechaSalidaReal >= resultado.ciclo.fechaIngresoReal);
    assert.equal(resultado.descansoEstado, 'GENERADO');
    assert.ok(resultado.descanso);
    assert.equal(resultado.descanso.cicloPastoreoId, ciclo.cicloId);

    const eventos = await adminPool.query(`select tipo_evento from agx.potrero_ciclo_eventos where ciclo_id = $1 order by ocurrido_en`, [ciclo.cicloId]);
    assert.deepEqual(eventos.rows.map((r) => r.tipo_evento), ['PASTOREO_INICIADO', 'PASTOREO_FINALIZADO']);
  });

  test('Finalizar: aunque el proveedor climático esté COMPLETAMENTE caído, el descanso se genera igual (degradado, guardrail absoluto) -- descansoEstado=GENERADO, NUNCA PENDIENTE por eso', async () => {
    const org = randomOrgId();
    const { predioId, potreroId } = await seedEscenarioCompleto(org, 'CLIMA-CAIDO');
    const ciclo = await repo.iniciarCicloPastoreo(org, predioId, potreroId);

    const resultado = await repo.finalizarCicloPastoreo(org, predioId, potreroId, ciclo.cicloId, { climatologyFetchImpl: SIN_RED_FETCH_IMPL });

    assert.equal(resultado.ciclo.estado, 'FINALIZADO', 'el hecho real se registra SIEMPRE, sin importar el clima');
    assert.equal(resultado.descansoEstado, 'GENERADO');
    assert.ok(resultado.descanso, 'el descanso se genera igual, en modo degradado (guardrail absoluto), nunca queda PENDIENTE por la ausencia de climatología');
    assert.equal(resultado.descanso.parametrosFuente.agroClimate.localClimatologyStatus, 'INSUFFICIENT_LOCAL_CLIMATOLOGY');
  });

  test('Finalizar: la salida REAL ancla el nuevo descanso -- fecha_inicio_pastoreo=fecha_ingreso_real, fecha_salida_estimada=fecha_salida_real, NUNCA recalculada desde días de ocupación', async () => {
    const org = randomOrgId();
    const { predioId, potreroId } = await seedEscenarioCompleto(org, 'ANCLA-REAL');
    const ciclo = await repo.iniciarCicloPastoreo(org, predioId, potreroId);

    // Forzamos una salida real distante en el tiempo (permanencia real
    // mucho más larga que los días de ocupación planificados) para
    // demostrar que el descanso NUNCA recalcula la salida por su cuenta.
    await adminPool.query(`update agx.potrero_ciclos_pastoreo set fecha_ingreso_real = '2026-08-01' where ciclo_id = $1`, [ciclo.cicloId]);

    const resultado = await repo.finalizarCicloPastoreo(org, predioId, potreroId, ciclo.cicloId, {
      now: new Date('2026-08-20T15:00:00Z'), climatologyFetchImpl: SIN_RED_FETCH_IMPL,
    });

    assert.equal(resultado.ciclo.fechaIngresoReal, '2026-08-01');
    assert.equal(resultado.ciclo.fechaSalidaReal, '2026-08-20');
    assert.equal(resultado.descanso.fechaInicioPastoreo, '2026-08-01');
    assert.equal(resultado.descanso.fechaSalidaEstimada, '2026-08-20', 'la "salida estimada" persistida es en realidad la REAL -- nunca recalculada desde días de ocupación (5 días habría dado 2026-08-06)');
  });

  test('Finalizar: previous_descanso_id de la nueva fila es la recomendación de descanso PLAN vigente al iniciar; la recomendación PLAN original queda intacta', async () => {
    const org = randomOrgId();
    const { predioId, potreroId, fichaId, recomendacionId } = await seedEscenarioCompleto(org, 'PLAN-INTACTO');

    const planResult = await adminPool.query(
      `insert into agx.potrero_recomendaciones_descanso
         (organizacion_id, predio_id, potrero_id, ficha_id, recomendacion_pastoreo_id,
          fecha_inicio_pastoreo, fecha_salida_estimada, dias_descanso_min, dias_descanso_max, dias_descanso_recomendado,
          fecha_reingreso_min, fecha_reingreso_max, fecha_reingreso_recomendada, nivel_confianza, agroclimate_status, motor_version)
       values ($1, $2, $3, $4, $5, '2026-08-26', '2026-08-31', 25, 35, 30, '2026-09-25', '2026-10-05', '2026-09-30', 'MEDIA', 'NORMAL', 'descanso-v1')
       returning descanso_id, applied_rules_json, condiciones_reentrada_json, parametros_fuente_json`,
      [org, predioId, potreroId, fichaId, recomendacionId],
    );
    const planDescansoId = planResult.rows[0].descanso_id;

    const ciclo = await repo.iniciarCicloPastoreo(org, predioId, potreroId);
    assert.equal(ciclo.recomendacionDescansoPlanId, String(planDescansoId), 'el ciclo captura el plan vigente al iniciar');

    const resultado = await repo.finalizarCicloPastoreo(org, predioId, potreroId, ciclo.cicloId, { climatologyFetchImpl: SIN_RED_FETCH_IMPL });
    assert.equal(resultado.descanso.previousDescansoId, String(planDescansoId));
    assert.notEqual(resultado.descanso.descansoId, String(planDescansoId), 'append-only: es una fila NUEVA, nunca la misma');

    const planIntacto = await adminPool.query('select fecha_inicio_pastoreo, dias_descanso_recomendado from agx.potrero_recomendaciones_descanso where descanso_id = $1', [planDescansoId]);
    assert.equal(planIntacto.rows[0].dias_descanso_recomendado, 30, 'la recomendación PLAN original nunca se modifica');
  });

  test('Finalizar: idempotente -- reintentar sobre el mismo cicloId NUNCA duplica la transición ni el evento ni el descanso', async () => {
    const org = randomOrgId();
    const { predioId, potreroId } = await seedEscenarioCompleto(org, 'RETRY');
    const ciclo = await repo.iniciarCicloPastoreo(org, predioId, potreroId);

    const primero = await repo.finalizarCicloPastoreo(org, predioId, potreroId, ciclo.cicloId, { climatologyFetchImpl: SIN_RED_FETCH_IMPL });
    const segundo = await repo.finalizarCicloPastoreo(org, predioId, potreroId, ciclo.cicloId, { climatologyFetchImpl: SIN_RED_FETCH_IMPL });
    const tercero = await repo.finalizarCicloPastoreo(org, predioId, potreroId, ciclo.cicloId, { climatologyFetchImpl: SIN_RED_FETCH_IMPL });

    assert.equal(segundo.descanso.descansoId, primero.descanso.descansoId);
    assert.equal(tercero.descanso.descansoId, primero.descanso.descansoId);

    const eventosFinalizado = await adminPool.query(`select count(*) from agx.potrero_ciclo_eventos where ciclo_id = $1 and tipo_evento = 'PASTOREO_FINALIZADO'`, [ciclo.cicloId]);
    assert.equal(Number(eventosFinalizado.rows[0].count), 1, 'NUNCA un segundo evento PASTOREO_FINALIZADO');

    const descansos = await adminPool.query(`select count(*) from agx.potrero_recomendaciones_descanso where ciclo_pastoreo_id = $1`, [ciclo.cicloId]);
    assert.equal(Number(descansos.rows[0].count), 1, 'NUNCA un segundo descanso para el mismo ciclo');
  });

  test('Finalizar: dos retries CONCURRENTES sobre el mismo ciclo -> exactamente un evento PASTOREO_FINALIZADO y exactamente un descanso', async () => {
    const org = randomOrgId();
    const { predioId, potreroId } = await seedEscenarioCompleto(org, 'RETRY-CONCURRENTE');
    const ciclo = await repo.iniciarCicloPastoreo(org, predioId, potreroId);

    const resultados = await Promise.all([
      repo.finalizarCicloPastoreo(org, predioId, potreroId, ciclo.cicloId, { climatologyFetchImpl: SIN_RED_FETCH_IMPL }),
      repo.finalizarCicloPastoreo(org, predioId, potreroId, ciclo.cicloId, { climatologyFetchImpl: SIN_RED_FETCH_IMPL }),
    ]);
    assert.equal(resultados[0].descanso.descansoId, resultados[1].descanso.descansoId, 'ambas respuestas deben converger al MISMO descanso');

    const eventos = await adminPool.query(`select count(*) from agx.potrero_ciclo_eventos where ciclo_id = $1 and tipo_evento = 'PASTOREO_FINALIZADO'`, [ciclo.cicloId]);
    assert.equal(Number(eventos.rows[0].count), 1);
    const descansos = await adminPool.query(`select count(*) from agx.potrero_recomendaciones_descanso where ciclo_pastoreo_id = $1`, [ciclo.cicloId]);
    assert.equal(Number(descansos.rows[0].count), 1);
  });

  test('Finalizar: pastura sin perfil regional -> ERROR_TECNICO en FASE B, pero el ciclo SIGUE FINALIZADO (FASE A nunca se revierte)', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D9R SINPASTURA');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D9R SINPASTURA');
    const pasturaId = await seedPasturaPersonalizada(org, 'Pastura Sprint3D9R SINPASTURA');
    const fichaId = await seedFicha(org, potreroId, pasturaId);
    await seedRecomendacionPastoreo(org, predioId, potreroId, fichaId);
    const ciclo = await repo.iniciarCicloPastoreo(org, predioId, potreroId);

    const resultado = await repo.finalizarCicloPastoreo(org, predioId, potreroId, ciclo.cicloId, { climatologyFetchImpl: SIN_RED_FETCH_IMPL });

    assert.equal(resultado.ciclo.estado, 'FINALIZADO', 'un fallo de FASE B NUNCA revierte la transición de FASE A ya comprometida');
    assert.equal(resultado.descansoEstado, 'ERROR_TECNICO');
    assert.equal(resultado.descanso, null);

    const reledio = await adminPool.query('select estado, fecha_salida_real from agx.potrero_ciclos_pastoreo where ciclo_id = $1', [ciclo.cicloId]);
    assert.equal(reledio.rows[0].estado, 'FINALIZADO', 'confirmado en DB, no solo en la respuesta en memoria');
    assert.ok(reledio.rows[0].fecha_salida_real);
  });

  test('Finalizar: un cicloId inexistente -> CICLO_NOT_FOUND', async () => {
    const org = randomOrgId();
    const { predioId, potreroId } = await seedEscenarioCompleto(org, 'NOTFOUND');
    await assert.rejects(
      () => repo.finalizarCicloPastoreo(org, predioId, potreroId, '999999999', { climatologyFetchImpl: SIN_RED_FETCH_IMPL }),
      (error) => error.status === 404 && error.code === 'CICLO_NOT_FOUND',
    );
  });

  test('Finalizar: un ciclo CANCELADO -> CICLO_CANCELADO (terminal, nunca puede finalizarse después)', async () => {
    const org = randomOrgId();
    const { predioId, potreroId } = await seedEscenarioCompleto(org, 'CANCELADO-LUEGO-FINALIZAR');
    const ciclo = await repo.iniciarCicloPastoreo(org, predioId, potreroId);
    await repo.cancelarCicloPastoreo(org, predioId, potreroId, ciclo.cicloId, { motivo: 'error de registro' });

    await assert.rejects(
      () => repo.finalizarCicloPastoreo(org, predioId, potreroId, ciclo.cicloId, { climatologyFetchImpl: SIN_RED_FETCH_IMPL }),
      (error) => error.status === 409 && error.code === 'CICLO_CANCELADO',
    );
  });

  // -----------------------------------------------------------------------
  // CANCELAR
  // -----------------------------------------------------------------------

  test('Cancelar: EN_CURSO -> CANCELADO, motivo persistido, evento PASTOREO_CANCELADO, nunca fecha_salida_real', async () => {
    const org = randomOrgId();
    const { predioId, potreroId } = await seedEscenarioCompleto(org, 'CANCELAR');
    const ciclo = await repo.iniciarCicloPastoreo(org, predioId, potreroId);

    const cancelado = await repo.cancelarCicloPastoreo(org, predioId, potreroId, ciclo.cicloId, { motivo: 'lote trasladado por error' });
    assert.equal(cancelado.estado, 'CANCELADO');
    assert.equal(cancelado.motivoCancelacion, 'lote trasladado por error');
    assert.equal(cancelado.fechaSalidaReal, null);

    const eventos = await adminPool.query(`select payload_json from agx.potrero_ciclo_eventos where ciclo_id = $1 and tipo_evento = 'PASTOREO_CANCELADO'`, [ciclo.cicloId]);
    assert.equal(eventos.rows.length, 1);
    assert.equal(eventos.rows[0].payload_json.motivo, 'lote trasladado por error');
  });

  test('Cancelar: motivo vacío o solo espacios -> INVALID_MOTIVO_CANCELACION, rechazado ANTES de tocar la DB', async () => {
    const org = randomOrgId();
    const { predioId, potreroId } = await seedEscenarioCompleto(org, 'MOTIVO-VACIO');
    const ciclo = await repo.iniciarCicloPastoreo(org, predioId, potreroId);

    for (const motivoInvalido of ['', '   ', undefined, null]) {
      // eslint-disable-next-line no-await-in-loop
      await assert.rejects(
        () => repo.cancelarCicloPastoreo(org, predioId, potreroId, ciclo.cicloId, { motivo: motivoInvalido }),
        (error) => error.status === 400 && error.code === 'INVALID_MOTIVO_CANCELACION',
      );
    }
    const releido = await adminPool.query('select estado from agx.potrero_ciclos_pastoreo where ciclo_id = $1', [ciclo.cicloId]);
    assert.equal(releido.rows[0].estado, 'EN_CURSO', 'ningún intento inválido debe haber cambiado el estado');
  });

  test('Cancelar: un ciclo ya FINALIZADO -> CICLO_NOT_IN_PROGRESS', async () => {
    const org = randomOrgId();
    const { predioId, potreroId } = await seedEscenarioCompleto(org, 'FINALIZADO-LUEGO-CANCELAR');
    const ciclo = await repo.iniciarCicloPastoreo(org, predioId, potreroId);
    await repo.finalizarCicloPastoreo(org, predioId, potreroId, ciclo.cicloId, { climatologyFetchImpl: SIN_RED_FETCH_IMPL });

    await assert.rejects(
      () => repo.cancelarCicloPastoreo(org, predioId, potreroId, ciclo.cicloId, { motivo: 'demasiado tarde' }),
      (error) => error.status === 409 && error.code === 'CICLO_NOT_IN_PROGRESS',
    );
  });

  test('Cancelar: idempotente -- cancelar dos veces el mismo ciclo es un no-op, nunca un segundo evento', async () => {
    const org = randomOrgId();
    const { predioId, potreroId } = await seedEscenarioCompleto(org, 'CANCELAR-RETRY');
    const ciclo = await repo.iniciarCicloPastoreo(org, predioId, potreroId);
    await repo.cancelarCicloPastoreo(org, predioId, potreroId, ciclo.cicloId, { motivo: 'primer motivo' });
    const segundo = await repo.cancelarCicloPastoreo(org, predioId, potreroId, ciclo.cicloId, { motivo: 'motivo distinto ignorado' });

    assert.equal(segundo.motivoCancelacion, 'primer motivo', 'el motivo original NUNCA se sobrescribe en un retry');
    const eventos = await adminPool.query(`select count(*) from agx.potrero_ciclo_eventos where ciclo_id = $1 and tipo_evento = 'PASTOREO_CANCELADO'`, [ciclo.cicloId]);
    assert.equal(Number(eventos.rows[0].count), 1);
  });

  // -----------------------------------------------------------------------
  // LECTURA (actual / historial) + TENANT ISOLATION
  // -----------------------------------------------------------------------

  test('getCicloActual/getCicloHistorial: sin ciclos -> actual null, historial vacío (nunca 404)', async () => {
    const org = randomOrgId();
    const { predioId, potreroId } = await seedEscenarioCompleto(org, 'LECTURA-VACIA');
    assert.equal(await repo.getCicloActual(org, predioId, potreroId), null);
    assert.deepEqual(await repo.getCicloHistorial(org, predioId, potreroId), []);
  });

  test('getCicloActual/getCicloHistorial: reflejan EN_CURSO vs. histórico correctamente', async () => {
    const org = randomOrgId();
    const { predioId, potreroId } = await seedEscenarioCompleto(org, 'LECTURA');
    const cicloUno = await repo.iniciarCicloPastoreo(org, predioId, potreroId);
    await repo.cancelarCicloPastoreo(org, predioId, potreroId, cicloUno.cicloId, { motivo: 'ajuste' });
    const cicloDos = await repo.iniciarCicloPastoreo(org, predioId, potreroId);

    const actual = await repo.getCicloActual(org, predioId, potreroId);
    assert.equal(actual.cicloId, cicloDos.cicloId);

    const historial = await repo.getCicloHistorial(org, predioId, potreroId);
    assert.equal(historial.length, 1);
    assert.equal(historial[0].cicloId, cicloUno.cicloId);
    assert.equal(historial[0].estado, 'CANCELADO');
  });

  test('tenant isolation: ciclo de ORG A invisible para ORG B (actual/historial y acciones)', async () => {
    const orgA = randomOrgId();
    const orgB = randomOrgId();
    const { predioId, potreroId } = await seedEscenarioCompleto(orgA, 'TENANT-A');
    const ciclo = await repo.iniciarCicloPastoreo(orgA, predioId, potreroId);

    // NOTA sobre los códigos de error (ambos 404, ambos tenant-safe, por
    // dos caminos distintos):
    // - getCicloActual/getCicloHistorial llaman assertPotreroBelongsToPredio
    //   (Guardrail 1) explícitamente ANTES de tocar el ciclo -- bajo RLS,
    //   orgB ni siquiera puede ver que ese predio/potrero existen ->
    //   POTRERO_NOT_FOUND.
    // - finalizarCicloPastoreo/cancelarCicloPastoreo NO llaman ese guard:
    //   dependen de que el WHERE ciclo_id+potrero_id+predio_id, bajo RLS,
    //   simplemente no devuelva filas para orgB -> CICLO_NOT_FOUND.
    await assert.rejects(
      () => repo.getCicloActual(orgB, predioId, potreroId),
      (error) => error.status === 404 && error.code === 'POTRERO_NOT_FOUND',
    );
    await assert.rejects(
      () => repo.getCicloHistorial(orgB, predioId, potreroId),
      (error) => error.status === 404 && error.code === 'POTRERO_NOT_FOUND',
    );
    await assert.rejects(
      () => repo.finalizarCicloPastoreo(orgB, predioId, potreroId, ciclo.cicloId, { climatologyFetchImpl: SIN_RED_FETCH_IMPL }),
      (error) => error.status === 404 && error.code === 'CICLO_NOT_FOUND',
    );
    await assert.rejects(
      () => repo.cancelarCicloPastoreo(orgB, predioId, potreroId, ciclo.cicloId, { motivo: 'intento cross-tenant' }),
      (error) => error.status === 404 && error.code === 'CICLO_NOT_FOUND',
    );
  });

  // -----------------------------------------------------------------------
  // GUARDRAIL 1 -- integridad predio/potrero a nivel de repositorio
  // -----------------------------------------------------------------------

  test('GUARDRAIL 1: iniciar un ciclo con un predioId que NO es el dueño real del potrero (mismo tenant) es rechazado', async () => {
    const org = randomOrgId();
    const predioA = await seedPredio(org, 'Predio Sprint3D9R GR1-A');
    const predioB = await seedPredio(org, 'Predio Sprint3D9R GR1-B');
    const potreroId = await seedPotrero(org, predioA, 'Potrero Sprint3D9R GR1');
    const pasturaId = await fetchPasturaSistemaId('Brachiaria humidicola');
    const fichaId = await seedFicha(org, potreroId, pasturaId);
    await seedRecomendacionPastoreo(org, predioA, potreroId, fichaId);

    await assert.rejects(
      () => repo.iniciarCicloPastoreo(org, predioB, potreroId),
      (error) => error.status === 404 && error.code === 'POTRERO_NOT_FOUND',
    );
  });
});
