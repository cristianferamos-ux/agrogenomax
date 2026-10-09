// SPRINT-3D10.8.1 -- POTRERO REST ASSESSMENT RECOVERY. Integración real
// contra Postgres/PostGIS desechable (mismas variables y mismo patrón que
// potreroCicloPastoreoSprint3D92RepositoryIntegration.test.js). Cubre:
//   - FASE B corregida: reintento de "Finalizar" crea el descanso faltante
//     (v1) o la siguiente versión (todas invalidadas), sin duplicar salida;
//   - descanso DECLARADO POR EL PRODUCTOR solo para NO_PASTURE_PROFILE;
//   - idempotencia/concurrencia de la declaración;
//   - residual previo intacto;
//   - ACEPTACIÓN DEL BLOCKER: pastura sin perfil -> finalizar -> declarar
//     -> aforo -> APTO -> DISPONIBLE -> SEGUNDO ciclo real.
delete process.env.AGX_BUSINESS_DATABASE_URL;

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import pg from 'pg';

let dbAvailable = false;
let adminPool;
let cicloRepo;
let estadoRepo;
let residualRepo;
let withOrganizacionTransaction;

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

  const tableCheck = await adminPool.query("select to_regclass('agx.potrero_ciclo_residuales_reales_versiones') as t");
  dbAvailable = Boolean(tableCheck.rows[0]?.t);
} catch {
  dbAvailable = false;
}

if (dbAvailable) {
  cicloRepo = await import('../ganaderia/potreroCicloPastoreoRepository.js');
  estadoRepo = await import('../ganaderia/potreroEstadoOperativoRepository.js');
  residualRepo = await import('../ganaderia/potreroCicloResidualRealRepository.js');
  ({ withOrganizacionTransaction } = await import('../../db/agxBusinessPool.js'));
}

const PREFIJO_PREDIO = 'Predio S3D1081';
const PREFIJO_POTRERO = 'Potrero S3D1081';
const PREFIJO_PASTURA = 'Pastura S3D1081';

const SIN_RED_FETCH_IMPL = async () => ({ ok: false, status: 503, json: async () => ({}) });
const SQUARE_WKT = 'POLYGON((-75.5 1.3, -75.4 1.3, -75.4 1.4, -75.5 1.4, -75.5 1.3))';
const MS_POR_DIA = 24 * 60 * 60 * 1000;

function randomOrgId() {
  return crypto.randomUUID();
}

function sumarDiasIso(fechaIso, dias) {
  const [a, m, d] = fechaIso.split('-').map(Number);
  return new Date(Date.UTC(a, m - 1, d) + dias * MS_POR_DIA).toISOString().slice(0, 10);
}

async function seedPredio(orgId, sufijo) {
  const result = await adminPool.query(
    'insert into agx.predios (organizacion_id, nombre_predio) values ($1, $2) returning predio_id',
    [orgId, `${PREFIJO_PREDIO} ${sufijo}`],
  );
  return result.rows[0].predio_id;
}

async function seedPotrero(orgId, predioId, sufijo) {
  const result = await adminPool.query(
    `insert into agx.potreros (organizacion_id, predio_id, nombre, geometry, area_ha, metodo_delimitacion)
     values ($1, $2, $3, ST_GeomFromText($4, 4326), 1, 'coordenadas')
     returning potrero_id`,
    [orgId, predioId, `${PREFIJO_POTRERO} ${sufijo}`, SQUARE_WKT],
  );
  return result.rows[0].potrero_id;
}

async function fetchPasturaSistemaId(nombreComun) {
  const result = await adminPool.query(`select pastura_id from agx.catalogo_pasturas where alcance = 'sistema' and nombre_comun = $1`, [nombreComun]);
  return result.rows[0]?.pastura_id;
}

async function seedPasturaPersonalizada(orgId, sufijo) {
  const result = await adminPool.query(
    `insert into agx.catalogo_pasturas (organizacion_id, nombre_comun, tipo, alcance) values ($1, $2, 'graminea', 'personalizado') returning pastura_id`,
    [orgId, `${PREFIJO_PASTURA} ${sufijo}`],
  );
  return result.rows[0].pastura_id;
}

async function seedFicha(orgId, potreroId, pasturaId, { fechaAforo } = {}) {
  const fichaResult = await adminPool.query(
    `insert into agx.potrero_fichas_productivas (organizacion_id, potrero_id, tipo_cobertura, nombre_principal, aforo_promedio_g_m2, fecha_aforo, biomasa_total_kg)
     values ($1, $2, 'pastura', 'Pastura Test', 500, coalesce($3, current_date), 5000) returning ficha_id`,
    [orgId, potreroId, fechaAforo ?? null],
  );
  const fichaId = fichaResult.rows[0].ficha_id;
  await adminPool.query(
    `insert into agx.potrero_ficha_pasturas (organizacion_id, ficha_id, pastura_id, porcentaje_estimado, orden) values ($1, $2, $3, 100, 0)`,
    [orgId, fichaId, pasturaId],
  );
  return fichaId;
}

async function seedRecomendacionPastoreo(org, predioId, potreroId, fichaId) {
  const categoria = await adminPool.query(`select categoria_id from agx.catalogo_categorias_productivas where codigo = 'novillo_ceba'`);
  const result = await adminPool.query(
    `insert into agx.potrero_recomendaciones_pastoreo
       (organizacion_id, predio_id, potrero_id, ficha_id, categoria_id, numero_animales, peso_promedio_kg,
        materia_seca_pct_aplicada, utilizacion_pct_aplicada, consumo_pct_pv_aplicado,
        materia_seca_total_kg, materia_seca_utilizable_kg, demanda_diaria_lote_kg_ms, dias_ocupacion_estimados,
        nivel_confianza, motor_version)
     values ($1, $2, $3, $4, $5, 10, 420, 20, 50, 2.4, 1000, 500, 100.8, 5, 'MEDIA', 'pastoreo-auto-v1')
     returning recomendacion_id`,
    [org, predioId, potreroId, fichaId, categoria.rows[0].categoria_id],
  );
  return result.rows[0].recomendacion_id;
}

// conPerfil=true -> Brachiaria humidicola (única pastura con perfil técnico
// de descanso); false -> pastura personalizada sin perfil.
async function seedEscenario(org, sufijo, { conPerfil }) {
  const predioId = await seedPredio(org, sufijo);
  const potreroId = await seedPotrero(org, predioId, sufijo);
  const pasturaId = conPerfil
    ? await fetchPasturaSistemaId('Brachiaria humidicola')
    : await seedPasturaPersonalizada(org, sufijo);
  const fichaId = await seedFicha(org, potreroId, pasturaId);
  const recomendacionId = await seedRecomendacionPastoreo(org, predioId, potreroId, fichaId);
  return { predioId: String(predioId), potreroId: String(potreroId), pasturaId, fichaId, recomendacionId };
}

async function iniciarYFinalizar(org, { predioId, potreroId }, { finalizarNow } = {}) {
  const ciclo = await cicloRepo.iniciarCicloPastoreo(org, predioId, potreroId, finalizarNow ? { now: new Date(finalizarNow.getTime() - 60 * 60 * 1000) } : {});
  const finalizado = await cicloRepo.finalizarCicloPastoreo(org, predioId, potreroId, ciclo.cicloId, {
    climatologyFetchImpl: SIN_RED_FETCH_IMPL,
    ...(finalizarNow ? { now: finalizarNow } : {}),
  });
  return { ciclo, finalizado };
}

async function estadoOperativo(org, { predioId, potreroId }, now) {
  return withOrganizacionTransaction(org, (client) => estadoRepo.resolveEstadoOperativoPotrero(client, { predioId, potreroId, now }));
}

async function cicloRow(cicloId) {
  const result = await adminPool.query(
    `select estado, to_char(fecha_salida_real, 'YYYY-MM-DD') as fecha_salida_real, salida_real_at
       from agx.potrero_ciclos_pastoreo where ciclo_id = $1`,
    [cicloId],
  );
  return result.rows[0];
}

async function contarEventos(cicloId, tipo) {
  const result = await adminPool.query('select count(*)::int as n from agx.potrero_ciclo_eventos where ciclo_id = $1 and tipo_evento = $2', [cicloId, tipo]);
  return result.rows[0].n;
}

async function descansosDelCiclo(cicloId) {
  const result = await adminPool.query(
    `select d.descanso_id, d.version,
            exists (select 1 from agx.potrero_descanso_invalidaciones i where i.descanso_id = d.descanso_id) as invalidado
       from agx.potrero_recomendaciones_descanso d
      where d.ciclo_pastoreo_id = $1
      order by d.version`,
    [cicloId],
  );
  return result.rows;
}

function declarar(org, { predioId, potreroId }, cicloId, diasDescanso, extra = {}) {
  return estadoRepo.declararDescansoProductor(org, predioId, potreroId, cicloId, { diasDescanso, actorCuentaId: 'cuenta-test', ...extra });
}

describe('SPRINT-3D10.8.1: recuperación de EN_DESCANSO / ASSESSMENT_PENDING', { skip: !dbAvailable }, () => {
  after(async () => {
    if (!adminPool) return;
    const potreros = `(select potrero_id from agx.potreros where nombre like '${PREFIJO_POTRERO}%')`;
    await adminPool.query(`delete from agx.potrero_evaluaciones_reingreso where potrero_id in ${potreros}`);
    await adminPool.query(`update agx.potrero_recomendaciones_descanso set lote_real_version_id = null, residual_real_version_id = null where potrero_id in ${potreros}`);
    await adminPool.query(`delete from agx.potrero_ciclo_residual_real_invalidaciones where potrero_id in ${potreros}`);
    await adminPool.query(`delete from agx.potrero_ciclo_residuales_reales_versiones where potrero_id in ${potreros}`);
    await adminPool.query(`delete from agx.potrero_ciclo_lote_real_invalidaciones where potrero_id in ${potreros}`);
    await adminPool.query(`delete from agx.potrero_ciclo_lote_real_versiones where potrero_id in ${potreros}`);
    await adminPool.query(`delete from agx.potrero_climatologias_agroclimaticas where potrero_id in ${potreros}`);
    await adminPool.query(`delete from agx.potrero_descanso_invalidaciones where potrero_id in ${potreros}`);
    await adminPool.query(`update agx.potrero_recomendaciones_descanso set ciclo_pastoreo_id = null where potrero_id in ${potreros}`);
    await adminPool.query(`update agx.potrero_ciclos_pastoreo set recomendacion_descanso_plan_id = null where potrero_id in ${potreros}`);
    await adminPool.query(`delete from agx.potrero_ciclo_eventos where potrero_id in ${potreros}`);
    await adminPool.query(`delete from agx.potrero_ciclos_pastoreo where potrero_id in ${potreros}`);
    await adminPool.query(`delete from agx.potrero_recomendaciones_descanso where potrero_id in ${potreros}`);
    await adminPool.query(`delete from agx.potrero_recomendaciones_pastoreo where potrero_id in ${potreros}`);
    await adminPool.query(`delete from agx.potrero_ficha_pasturas where ficha_id in (select ficha_id from agx.potrero_fichas_productivas where potrero_id in ${potreros})`);
    await adminPool.query(`delete from agx.potrero_fichas_productivas where potrero_id in ${potreros}`);
    await adminPool.query(`delete from agx.catalogo_pasturas where nombre_comun like '${PREFIJO_PASTURA}%'`);
    await adminPool.query(`delete from agx.potreros where nombre like '${PREFIJO_POTRERO}%'`);
    await adminPool.query(`delete from agx.predios where nombre_predio like '${PREFIJO_PREDIO}%'`);
    await adminPool.end();
  });

  test('1) pastura CON perfil: el descanso calculado no cambia (v1 CALCULADO, motor descanso-v1)', async () => {
    const org = randomOrgId();
    const escenario = await seedEscenario(org, 'T1', { conPerfil: true });
    const { ciclo, finalizado } = await iniciarYFinalizar(org, escenario);
    assert.equal(finalizado.descansoEstado, 'GENERADO');
    assert.equal(finalizado.descanso.version, 1);
    assert.equal(finalizado.descanso.origenDescanso, 'CALCULADO');
    assert.equal(finalizado.descanso.motorVersion, 'descanso-v1');
    assert.notEqual(finalizado.descanso.agroclimateStatus, undefined);

    const estado = await estadoOperativo(org, escenario);
    assert.equal(estado.estado, 'EN_DESCANSO');
    assert.equal(estado.reason, 'ANTES_DE_VENTANA');
    assert.equal(estado.cicloOrigenId, ciclo.cicloId);
    assert.equal(estado.motivoDescansoPendiente, undefined);
  });

  test('2) pastura SIN perfil: finalizar deja ASSESSMENT_PENDING / NO_PASTURE_PROFILE + fechaSalidaReal', async () => {
    const org = randomOrgId();
    const escenario = await seedEscenario(org, 'T2', { conPerfil: false });
    const { ciclo, finalizado } = await iniciarYFinalizar(org, escenario);
    assert.equal(finalizado.descansoEstado, 'ERROR_TECNICO');
    assert.equal(finalizado.descanso, null);

    const estado = await estadoOperativo(org, escenario);
    assert.deepEqual(estado, {
      estado: 'EN_DESCANSO',
      reason: 'ASSESSMENT_PENDING',
      cicloOrigenId: ciclo.cicloId,
      motivoDescansoPendiente: 'NO_PASTURE_PROFILE',
      fechaSalidaReal: finalizado.ciclo.fechaSalidaReal,
    });
  });

  test('3) reintentar finalizar (sin perfil) NUNCA duplica la salida: mismo salida_real_at, un solo PASTOREO_FINALIZADO, sin descanso', async () => {
    const org = randomOrgId();
    const escenario = await seedEscenario(org, 'T3', { conPerfil: false });
    const { ciclo } = await iniciarYFinalizar(org, escenario);
    const antes = await cicloRow(ciclo.cicloId);

    for (let i = 0; i < 2; i += 1) {
      const retry = await cicloRepo.finalizarCicloPastoreo(org, escenario.predioId, escenario.potreroId, ciclo.cicloId, { climatologyFetchImpl: SIN_RED_FETCH_IMPL });
      assert.equal(retry.descansoEstado, 'ERROR_TECNICO');
    }

    const despues = await cicloRow(ciclo.cicloId);
    assert.equal(despues.estado, 'FINALIZADO');
    assert.equal(despues.fecha_salida_real, antes.fecha_salida_real);
    assert.equal(despues.salida_real_at.getTime(), antes.salida_real_at.getTime());
    assert.equal(await contarEventos(ciclo.cicloId, 'PASTOREO_FINALIZADO'), 1);
    assert.equal((await descansosDelCiclo(ciclo.cicloId)).length, 0);
    const ciclos = await adminPool.query('select count(*)::int as n from agx.potrero_ciclos_pastoreo where potrero_id = $1', [escenario.potreroId]);
    assert.equal(ciclos.rows[0].n, 1);
  });

  test('4) descanso faltante (FASE B nunca persistió): REINTENTABLE -> reintento de finalizar crea la v1 sin tocar la salida', async () => {
    const org = randomOrgId();
    const escenario = await seedEscenario(org, 'T4', { conPerfil: true });
    const { ciclo, finalizado } = await iniciarYFinalizar(org, escenario);
    // Simula que FASE B nunca llegó a persistir (p.ej. condición transitoria).
    await adminPool.query('delete from agx.potrero_recomendaciones_descanso where descanso_id = $1', [finalizado.descanso.descansoId]);
    const antes = await cicloRow(ciclo.cicloId);

    const pendiente = await estadoOperativo(org, escenario);
    assert.equal(pendiente.reason, 'ASSESSMENT_PENDING');
    assert.equal(pendiente.motivoDescansoPendiente, 'REINTENTABLE');

    const retry = await cicloRepo.finalizarCicloPastoreo(org, escenario.predioId, escenario.potreroId, ciclo.cicloId, { climatologyFetchImpl: SIN_RED_FETCH_IMPL });
    assert.equal(retry.descansoEstado, 'GENERADO');
    assert.equal(retry.descanso.version, 1);
    assert.equal(retry.descanso.origenDescanso, 'CALCULADO');

    const despues = await cicloRow(ciclo.cicloId);
    assert.equal(despues.salida_real_at.getTime(), antes.salida_real_at.getTime());
    assert.equal(await contarEventos(ciclo.cicloId, 'PASTOREO_FINALIZADO'), 1);
    assert.equal((await estadoOperativo(org, escenario)).reason, 'ANTES_DE_VENTANA');
  });

  test('5) todas las versiones invalidadas (corrección cuya FASE B\' falló): el reintento crea la v(N+1) VIGENTE, nunca devuelve la invalidada', async () => {
    const org = randomOrgId();
    const escenario = await seedEscenario(org, 'T5', { conPerfil: true });
    const { ciclo, finalizado } = await iniciarYFinalizar(org, escenario);
    await adminPool.query(
      `insert into agx.potrero_descanso_invalidaciones (organizacion_id, potrero_id, descanso_id, ciclo_pastoreo_id, motivo)
       values ($1, $2, $3, $4, 'correccion_lote_real')`,
      [org, escenario.potreroId, finalizado.descanso.descansoId, ciclo.cicloId],
    );
    assert.equal((await estadoOperativo(org, escenario)).reason, 'ASSESSMENT_PENDING');

    const retry = await cicloRepo.finalizarCicloPastoreo(org, escenario.predioId, escenario.potreroId, ciclo.cicloId, { climatologyFetchImpl: SIN_RED_FETCH_IMPL });
    assert.equal(retry.descansoEstado, 'GENERADO');
    assert.equal(retry.descanso.version, 2);
    assert.notEqual(retry.descanso.descansoId, finalizado.descanso.descansoId);

    const filas = await descansosDelCiclo(ciclo.cicloId);
    assert.deepEqual(filas.map((f) => [f.version, f.invalidado]), [[1, true], [2, false]]);
    assert.equal(await contarEventos(ciclo.cicloId, 'PASTOREO_FINALIZADO'), 1);

    // Un segundo reintento devuelve la v2 vigente -- nunca una v3.
    const retry2 = await cicloRepo.finalizarCicloPastoreo(org, escenario.predioId, escenario.potreroId, ciclo.cicloId, { climatologyFetchImpl: SIN_RED_FETCH_IMPL });
    assert.equal(retry2.descanso.descansoId, retry.descanso.descansoId);
    assert.equal((await descansosDelCiclo(ciclo.cicloId)).length, 2);
  });

  test('6) declarar descanso (sin perfil): fila válida con la metadata exacta; reintento idéntico -> yaExistia', async () => {
    const org = randomOrgId();
    const escenario = await seedEscenario(org, 'T6', { conPerfil: false });
    const { ciclo, finalizado } = await iniciarYFinalizar(org, escenario);

    const declarado = await declarar(org, escenario, ciclo.cicloId, 30);
    assert.equal(declarado.yaExistia, false);
    assert.equal(declarado.descanso.origenDescanso, 'DECLARADO_PRODUCTOR');

    const fechaSalida = finalizado.ciclo.fechaSalidaReal;
    const row = (await adminPool.query(
      `select ficha_id, contexto_id, recomendacion_pastoreo_id, ciclo_pastoreo_id, version,
              to_char(fecha_inicio_pastoreo, 'YYYY-MM-DD') as fecha_inicio_pastoreo,
              to_char(fecha_salida_estimada, 'YYYY-MM-DD') as fecha_salida_estimada,
              dias_descanso_min, dias_descanso_recomendado, dias_descanso_max,
              to_char(fecha_reingreso_min, 'YYYY-MM-DD') as fecha_reingreso_min,
              to_char(fecha_reingreso_recomendada, 'YYYY-MM-DD') as fecha_reingreso_recomendada,
              to_char(fecha_reingreso_max, 'YYYY-MM-DD') as fecha_reingreso_max,
              nivel_confianza, agroclimate_status, condiciones_reentrada_json, applied_rules_json,
              parametros_fuente_json, motor_version, lote_real_version_id, residual_real_version_id, fuente_remanente
         from agx.potrero_recomendaciones_descanso where descanso_id = $1`,
      [declarado.descanso.descansoId],
    )).rows[0];

    assert.equal(String(row.ficha_id), String(escenario.fichaId));
    assert.equal(String(row.recomendacion_pastoreo_id), String(escenario.recomendacionId));
    assert.equal(String(row.ciclo_pastoreo_id), ciclo.cicloId);
    assert.equal(row.version, 1);
    assert.equal(row.contexto_id, null);
    assert.equal(row.fecha_inicio_pastoreo, finalizado.ciclo.fechaIngresoReal);
    assert.equal(row.fecha_salida_estimada, fechaSalida);
    assert.deepEqual([row.dias_descanso_min, row.dias_descanso_recomendado, row.dias_descanso_max], [30, 30, 30]);
    const esperado = sumarDiasIso(fechaSalida, 30);
    assert.deepEqual([row.fecha_reingreso_min, row.fecha_reingreso_recomendada, row.fecha_reingreso_max], [esperado, esperado, esperado]);
    assert.equal(row.nivel_confianza, 'BAJA');
    assert.equal(row.agroclimate_status, 'INSUFFICIENT_DATA');
    assert.equal(row.motor_version, 'declarado-productor-v1');
    assert.deepEqual(row.applied_rules_json, []);
    assert.deepEqual(row.condiciones_reentrada_json, [{ codigo: 'CONFIRMAR_NUEVO_AFORO', detalle: null }]);
    assert.equal(row.lote_real_version_id, null);
    assert.equal(row.residual_real_version_id, null);
    assert.equal(row.fuente_remanente, null);

    const p = row.parametros_fuente_json;
    assert.equal(p.origenDescanso, 'DECLARADO_PRODUCTOR');
    assert.equal(p.origenCicloRealId, ciclo.cicloId);
    assert.equal(p.diasDeclarados, 30);
    assert.equal(p.motivoSinCalculo, 'NO_PASTURE_PROFILE');
    assert.equal(p.pastura.nombreComun, `${PREFIJO_PASTURA} T6`);
    assert.equal(p.pastura.sourceType, null);
    assert.equal(p.declaradoPorCuentaId, 'cuenta-test');
    assert.ok(!Number.isNaN(Date.parse(p.declaradoEn)));
    assert.equal(p.fuentePresion, undefined, 'nunca fabrica fuente de presión');
    assert.equal(p.planVsReal, undefined, 'nunca fabrica comparativo PLAN vs REAL');

    const estado = await estadoOperativo(org, escenario);
    assert.equal(estado.estado, 'EN_DESCANSO');
    assert.equal(estado.reason, 'ANTES_DE_VENTANA');
    assert.equal(estado.descanso.origenDescanso, 'DECLARADO_PRODUCTOR');
    assert.equal(estado.descanso.fechaReingresoMin, esperado);

    const reintento = await declarar(org, escenario, ciclo.cicloId, 30);
    assert.equal(reintento.yaExistia, true);
    assert.equal(reintento.descanso.descansoId, declarado.descanso.descansoId);
    assert.equal((await descansosDelCiclo(ciclo.cicloId)).length, 1);

    // Un reintento automático posterior devuelve el declarado -- nunca crea otro.
    const retryFinalizar = await cicloRepo.finalizarCicloPastoreo(org, escenario.predioId, escenario.potreroId, ciclo.cicloId, { climatologyFetchImpl: SIN_RED_FETCH_IMPL });
    assert.equal(retryFinalizar.descanso.descansoId, declarado.descanso.descansoId);
    assert.equal((await descansosDelCiclo(ciclo.cicloId)).length, 1);
  });

  test('7) dos declaraciones IDÉNTICAS concurrentes -> una crea, otra yaExistia; un solo descanso vigente', async () => {
    const org = randomOrgId();
    const escenario = await seedEscenario(org, 'T7', { conPerfil: false });
    const { ciclo } = await iniciarYFinalizar(org, escenario);

    const resultados = await Promise.all([
      declarar(org, escenario, ciclo.cicloId, 20),
      declarar(org, escenario, ciclo.cicloId, 20),
    ]);
    assert.deepEqual(resultados.map((r) => r.yaExistia).sort(), [false, true]);
    assert.equal(resultados[0].descanso.descansoId, resultados[1].descanso.descansoId);
    const filas = await descansosDelCiclo(ciclo.cicloId);
    assert.equal(filas.length, 1);
    assert.equal(filas[0].invalidado, false);
  });

  test('8) dos declaraciones concurrentes con DÍAS DISTINTOS -> una crea, otra 409 DESCANSO_YA_EXISTE', async () => {
    const org = randomOrgId();
    const escenario = await seedEscenario(org, 'T8', { conPerfil: false });
    const { ciclo } = await iniciarYFinalizar(org, escenario);

    const resultados = await Promise.allSettled([
      declarar(org, escenario, ciclo.cicloId, 20),
      declarar(org, escenario, ciclo.cicloId, 25),
    ]);
    const ok = resultados.filter((r) => r.status === 'fulfilled');
    const ko = resultados.filter((r) => r.status === 'rejected');
    assert.equal(ok.length, 1);
    assert.equal(ok[0].value.yaExistia, false);
    assert.equal(ko.length, 1);
    assert.equal(ko[0].reason.status, 409);
    assert.equal(ko[0].reason.code, 'DESCANSO_YA_EXISTE');
    assert.equal((await descansosDelCiclo(ciclo.cicloId)).length, 1);
  });

  test('9) ya existe un descanso CALCULADO -> 409 DESCANSO_YA_EXISTE (nunca un override)', async () => {
    const org = randomOrgId();
    const escenario = await seedEscenario(org, 'T9', { conPerfil: true });
    const { ciclo } = await iniciarYFinalizar(org, escenario);
    await assert.rejects(
      () => declarar(org, escenario, ciclo.cicloId, 30),
      (error) => error.status === 409 && error.code === 'DESCANSO_YA_EXISTE',
    );
    assert.equal((await descansosDelCiclo(ciclo.cicloId)).length, 1);
  });

  test('10) pastura CON perfil técnico y descanso pendiente -> 409 DESCANSO_DECLARADO_NO_APLICA (usar el reintento); EN_CURSO tampoco aplica', async () => {
    const org = randomOrgId();
    const escenario = await seedEscenario(org, 'T10', { conPerfil: true });
    const { ciclo, finalizado } = await iniciarYFinalizar(org, escenario);
    await adminPool.query('delete from agx.potrero_recomendaciones_descanso where descanso_id = $1', [finalizado.descanso.descansoId]);
    assert.equal((await estadoOperativo(org, escenario)).motivoDescansoPendiente, 'REINTENTABLE');

    await assert.rejects(
      () => declarar(org, escenario, ciclo.cicloId, 30),
      (error) => error.status === 409 && error.code === 'DESCANSO_DECLARADO_NO_APLICA',
    );
    assert.equal((await descansosDelCiclo(ciclo.cicloId)).length, 0);

    const otro = await seedEscenario(org, 'T10B', { conPerfil: false });
    const enCurso = await cicloRepo.iniciarCicloPastoreo(org, otro.predioId, otro.potreroId);
    await assert.rejects(
      () => declarar(org, otro, enCurso.cicloId, 30),
      (error) => error.status === 409 && error.code === 'DESCANSO_DECLARADO_NO_APLICA',
    );
  });

  test('11-15) ACEPTACIÓN DEL BLOCKER: sin perfil -> finalizar -> residual -> declarar -> aforo -> APTO -> DISPONIBLE -> SEGUNDO ciclo real', async () => {
    const org = randomOrgId();
    const escenario = await seedEscenario(org, 'T11', { conPerfil: false });
    const salidaAt = new Date(Date.now() - 60 * 60 * 1000);
    const { ciclo, finalizado } = await iniciarYFinalizar(org, escenario, { finalizarNow: salidaAt });
    assert.equal(finalizado.descansoEstado, 'ERROR_TECNICO');

    // Residual registrado ANTES de resolver el descanso.
    const residual = await residualRepo.registrarResidualReal(org, escenario.predioId, escenario.potreroId, ciclo.cicloId, {
      numeroMuestras: 5, aforoPromedioGM2: 180, medicionRealAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    });
    const residualAntes = (await adminPool.query(
      'select * from agx.potrero_ciclo_residuales_reales_versiones where ciclo_id = $1 order by version', [ciclo.cicloId],
    )).rows;
    assert.equal(residualAntes.length, 1);

    const declarado = await declarar(org, escenario, ciclo.cicloId, 30);
    assert.equal(declarado.yaExistia, false);

    // 11) residual intacto: misma fila, sin invalidaciones, comparativo honesto (sin estimado fabricado).
    const residualDespues = (await adminPool.query(
      'select * from agx.potrero_ciclo_residuales_reales_versiones where ciclo_id = $1 order by version', [ciclo.cicloId],
    )).rows;
    assert.deepEqual(residualDespues, residualAntes);
    const invalidacionesResidual = await adminPool.query('select count(*)::int as n from agx.potrero_ciclo_residual_real_invalidaciones where ciclo_id = $1', [ciclo.cicloId]);
    assert.equal(invalidacionesResidual.rows[0].n, 0);
    const residualLeido = await residualRepo.getResidualReal(org, escenario.predioId, escenario.potreroId, ciclo.cicloId);
    assert.equal(residualLeido.actual.residualId, residual.residual.residualId);
    // Nunca un comparativo fabricado contra un descanso declarado: sin
    // estimado de origen y nunca COMPLETO (aplicar-a-descanso queda bloqueado).
    assert.notEqual(residualLeido.actual.comparativoEstado, 'COMPLETO');
    assert.equal(residualLeido.actual.descansoEstimadoOrigenId, null);
    assert.equal(residualLeido.actual.remanenteEstimadoKgMsCongelado, null);
    await assert.rejects(
      () => residualRepo.aplicarResidualRealADescanso(org, escenario.predioId, escenario.potreroId, ciclo.cicloId),
      (error) => error.status === 409 && error.code === 'COMPARATIVO_NO_COMPLETO',
    );
    const salidaTrasDeclarar = await cicloRow(ciclo.cicloId);
    assert.equal(salidaTrasDeclarar.salida_real_at.getTime(), salidaAt.getTime());
    assert.equal(salidaTrasDeclarar.estado, 'FINALIZADO');

    // Antes de la fecha habilitante: en descanso.
    await assert.rejects(
      () => cicloRepo.iniciarCicloPastoreo(org, escenario.predioId, escenario.potreroId),
      (error) => error.status === 409 && error.code === 'POTRERO_IN_REST_PERIOD',
    );

    // Transcurre el descanso declarado: hoy = fecha_reingreso_min.
    const fechaReingresoMin = declarado.descanso.fechaReingresoMin;
    const hoyHabilitado = new Date(`${fechaReingresoMin}T17:00:00.000Z`);
    assert.equal((await estadoOperativo(org, escenario, hoyHabilitado)).estado, 'EVALUACION_REINGRESO');
    await assert.rejects(
      () => cicloRepo.iniciarCicloPastoreo(org, escenario.predioId, escenario.potreroId, { now: hoyHabilitado }),
      (error) => error.status === 409 && error.code === 'POTRERO_REINGRESO_NO_CONFIRMADO',
    );

    // 12) nuevo aforo en fecha válida (regla existente: fecha_aforo >= fecha_reingreso_min).
    const fichaNuevaId = await seedFicha(org, escenario.potreroId, escenario.pasturaId, { fechaAforo: fechaReingresoMin });

    // 13) evaluar APTO.
    const evaluacion = await cicloRepo.evaluarReingreso(org, escenario.predioId, escenario.potreroId, {
      fichaId: fichaNuevaId, resultado: 'APTO', now: hoyHabilitado,
    });
    assert.equal(evaluacion.resultado, 'APTO');
    assert.equal(evaluacion.descansoId, declarado.descanso.descansoId);

    // 14) DISPONIBLE.
    assert.deepEqual(await estadoOperativo(org, escenario, hoyHabilitado), { estado: 'DISPONIBLE' });

    // 15) nuevo plan + SEGUNDO ciclo real.
    const recomendacionNuevaId = await seedRecomendacionPastoreo(org, escenario.predioId, escenario.potreroId, fichaNuevaId);
    const ciclo2 = await cicloRepo.iniciarCicloPastoreo(org, escenario.predioId, escenario.potreroId, { now: hoyHabilitado });
    assert.equal(ciclo2.estado, 'EN_CURSO');
    assert.notEqual(ciclo2.cicloId, ciclo.cicloId);
    assert.equal(ciclo2.recomendacionPastoreoId, String(recomendacionNuevaId));
    assert.equal((await estadoOperativo(org, escenario, hoyHabilitado)).estado, 'EN_PASTOREO');

    const ciclos = await adminPool.query(
      'select ciclo_id, estado from agx.potrero_ciclos_pastoreo where potrero_id = $1 order by ciclo_id', [escenario.potreroId],
    );
    assert.deepEqual(ciclos.rows.map((r) => r.estado), ['FINALIZADO', 'EN_CURSO']);
    assert.equal((await cicloRow(ciclo.cicloId)).salida_real_at.getTime(), salidaAt.getTime(), 'el primer ciclo real permanece intacto');
  });

  test('16) declaración cross-tenant -> 404 CICLO_NOT_FOUND, sin escribir nada', async () => {
    const org = randomOrgId();
    const escenario = await seedEscenario(org, 'T16', { conPerfil: false });
    const { ciclo } = await iniciarYFinalizar(org, escenario);
    const otraOrg = randomOrgId();
    await assert.rejects(
      () => declarar(otraOrg, escenario, ciclo.cicloId, 30),
      (error) => error.status === 404 && error.code === 'CICLO_NOT_FOUND',
    );
    assert.equal((await descansosDelCiclo(ciclo.cicloId)).length, 0);
  });

  test('validación de dominio: diasDescanso fuera de 1..180 o no entero -> 400 antes de tocar la DB', async () => {
    const org = randomOrgId();
    for (const dias of [0, -1, 1.5, 181, Number.NaN, '30']) {
      await assert.rejects(
        () => declarar(org, { predioId: '1', potreroId: '1' }, '1', dias),
        (error) => error.status === 400 && error.code === 'INVALID_DIAS_DESCANSO_DECLARADO',
      );
    }
  });
});
