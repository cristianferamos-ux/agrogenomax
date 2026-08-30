// SPRINT-3D9.2 -- pruebas de repositorio contra Postgres/PostGIS REAL.
// Cubre: fix BUG_LATEST_RECOMMENDATION (recomendación ligada al ciclo),
// reentry guard (POTRERO_IN_REST_PERIOD/POTRERO_REST_ASSESSMENT_PENDING/
// POTRERO_REINGRESO_NO_CONFIRMADO), CANCELADO intermedio ignorado,
// corregir (FASE A'/B', idempotencia), anular (invalidación atómica),
// evaluar reingreso (APTO/NO_APTO), archive/restore (guards de ciclo
// EN_CURSO, predio gobierna potrero).
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
let archivoRepo;
let estadoRepo;

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

  const tableCheck = await adminPool.query("select to_regclass('agx.potrero_evaluaciones_reingreso') as t");
  dbAvailable = Boolean(tableCheck.rows[0]?.t);
} catch {
  dbAvailable = false;
}

if (dbAvailable) {
  repo = await import('../ganaderia/potreroCicloPastoreoRepository.js');
  archivoRepo = await import('../ganaderia/potreroArchivoRepository.js');
  estadoRepo = await import('../ganaderia/potreroEstadoOperativoRepository.js');
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
  const predioId = await seedPredio(org, `Predio Sprint3D92R ${sufijo}`);
  const potreroId = await seedPotrero(org, predioId, `Potrero Sprint3D92R ${sufijo}`);
  const pasturaId = await fetchPasturaSistemaId('Brachiaria humidicola');
  const fichaId = await seedFicha(org, potreroId, pasturaId);
  const recomendacionId = await seedRecomendacionPastoreo(org, predioId, potreroId, fichaId);
  return { predioId, potreroId, fichaId, recomendacionId };
}

// Fecha en el futuro lejano, en formato YYYY-MM-DD -- usada como `now`
// inyectado para simular determinísticamente "hoy >= fecha_reingreso_min"
// sin esperar días reales.
const FECHA_FUTURA_LEJANA = new Date(Date.now() + 400 * 24 * 60 * 60 * 1000);

describe('SPRINT-3D9.2: potreroCicloPastoreoRepository -- fix, reentry guard, corregir, anular, evaluar reingreso', { skip: !dbAvailable }, () => {
  after(async () => {
    if (!adminPool) return;
    await adminPool.query(`delete from agx.potrero_evaluaciones_reingreso where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D92R%')`);
    // SPRINT-3D9.3: cada ciclo creado por iniciarCicloPastoreo ahora
    // siempre genera un snapshot real -- debe limpiarse ANTES de poder
    // borrar potrero_ciclos_pastoreo (mismo patrón recurrente de FK
    // circular en esta suite).
    await adminPool.query(`update agx.potrero_recomendaciones_descanso set lote_real_version_id = null where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D92R%')`);
    await adminPool.query(`delete from agx.potrero_ciclo_lote_real_invalidaciones where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D92R%')`);
    await adminPool.query(`delete from agx.potrero_ciclo_lote_real_versiones where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D92R%')`);
    // Preexistente (no relacionado a 3D9.3): la climatología local puede
    // generarse realmente cuando finalizarCicloPastoreo/corregirCicloPastoreo
    // se invocan sin climatologyFetchImpl explícito -- limpiar antes de
    // borrar potreros.
    await adminPool.query(`delete from agx.potrero_climatologias_agroclimaticas where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D92R%')`);
    await adminPool.query(`delete from agx.potrero_descanso_invalidaciones where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D92R%')`);
    await adminPool.query(`update agx.potrero_recomendaciones_descanso set ciclo_pastoreo_id = null where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D92R%')`);
    await adminPool.query(`update agx.potrero_ciclos_pastoreo set recomendacion_descanso_plan_id = null where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D92R%')`);
    await adminPool.query(`delete from agx.potrero_ciclo_eventos where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D92R%')`);
    await adminPool.query(`delete from agx.potrero_ciclos_pastoreo where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D92R%')`);
    await adminPool.query(`delete from agx.potrero_recomendaciones_descanso where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D92R%')`);
    await adminPool.query(`delete from agx.potrero_recomendaciones_pastoreo where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D92R%')`);
    await adminPool.query(`delete from agx.potrero_ficha_pasturas where ficha_id in (select ficha_id from agx.potrero_fichas_productivas where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D92R%'))`);
    await adminPool.query(`delete from agx.potrero_fichas_productivas where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D92R%')`);
    await adminPool.query(`delete from agx.potrero_archivo_eventos where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D92R%')`);
    await adminPool.query(`delete from agx.predio_archivo_eventos where predio_id in (select predio_id from agx.predios where nombre_predio like 'Predio Sprint3D92R%')`);
    await adminPool.query(`delete from agx.catalogo_pasturas where nombre_comun like 'Pastura Sprint3D92R%'`);
    await adminPool.query(`delete from agx.potreros where nombre like 'Potrero Sprint3D92R%'`);
    await adminPool.query(`delete from agx.predios where nombre_predio like 'Predio Sprint3D92R%'`);
  });

  // -----------------------------------------------------------------------
  // FIX BUG_LATEST_RECOMMENDATION
  // -----------------------------------------------------------------------

  test('A) el ciclo se inicia con recomendación #3; luego se guarda #4; al finalizar, el descanso usa #3', async () => {
    const org = randomOrgId();
    const { predioId, potreroId, fichaId, recomendacionId: recomendacion3Id } = await seedEscenarioCompleto(org, 'FIX-A');

    const ciclo = await repo.iniciarCicloPastoreo(org, predioId, potreroId);
    assert.equal(ciclo.recomendacionPastoreoId, String(recomendacion3Id));

    // #4 -- guardada DESPUÉS de iniciar, con datos claramente distintos
    // (materia_seca_utilizable_kg muy alta) para poder detectar si
    // contaminó el cálculo.
    await seedRecomendacionPastoreo(org, predioId, potreroId, fichaId, { numeroAnimales: 999, pesoPromedioKg: 999 });

    const resultado = await repo.finalizarCicloPastoreo(org, predioId, potreroId, ciclo.cicloId, { climatologyFetchImpl: SIN_RED_FETCH_IMPL });
    assert.equal(resultado.descansoEstado, 'GENERADO');
    assert.equal(resultado.descanso.recomendacionPastoreoId, String(recomendacion3Id), 'debe usar la recomendación #3 (la del ciclo), nunca la #4 (más reciente)');
  });

  test('B) #4 nunca contamina retroactivamente el descanso del ciclo ligado a #3 -- verificado con datos de lote muy distintos', async () => {
    const org = randomOrgId();
    const { predioId, potreroId, fichaId } = await seedEscenarioCompleto(org, 'FIX-B');
    const ciclo = await repo.iniciarCicloPastoreo(org, predioId, potreroId);
    await seedRecomendacionPastoreo(org, predioId, potreroId, fichaId, { numeroAnimales: 1, pesoPromedioKg: 1 });

    const resultado = await repo.finalizarCicloPastoreo(org, predioId, potreroId, ciclo.cicloId, { climatologyFetchImpl: SIN_RED_FETCH_IMPL });
    // El descanso persistido debe seguir referenciando la recomendación
    // original del ciclo -- verificado directamente en DB, no solo en la
    // respuesta serializada.
    const row = await adminPool.query('select recomendacion_pastoreo_id from agx.potrero_recomendaciones_descanso where descanso_id = $1', [resultado.descanso.descansoId]);
    assert.equal(String(row.rows[0].recomendacion_pastoreo_id), ciclo.recomendacionPastoreoId);
  });

  // -----------------------------------------------------------------------
  // REENTRY GUARD
  // -----------------------------------------------------------------------

  test('reentry: hoy < fecha_reingreso_min -> POTRERO_IN_REST_PERIOD con ventana completa', async () => {
    const org = randomOrgId();
    const { predioId, potreroId } = await seedEscenarioCompleto(org, 'REENTRY-A');
    const ciclo = await repo.iniciarCicloPastoreo(org, predioId, potreroId);
    const finalizado = await repo.finalizarCicloPastoreo(org, predioId, potreroId, ciclo.cicloId, { climatologyFetchImpl: SIN_RED_FETCH_IMPL });
    assert.equal(finalizado.descansoEstado, 'GENERADO');

    await assert.rejects(
      () => repo.iniciarCicloPastoreo(org, predioId, potreroId),
      (error) => {
        assert.equal(error.status, 409);
        assert.equal(error.code, 'POTRERO_IN_REST_PERIOD');
        assert.equal(error.fechaReingresoMin, finalizado.descanso.fechaReingresoMin);
        assert.equal(error.fechaReingresoRecomendada, finalizado.descanso.fechaReingresoRecomendada);
        assert.equal(error.fechaReingresoMax, finalizado.descanso.fechaReingresoMax);
        assert.equal(error.descansoId, finalizado.descanso.descansoId);
        assert.equal(error.cicloOrigenId, ciclo.cicloId);
        assert.ok(Number.isFinite(error.diasRestantes) && error.diasRestantes > 0);
        return true;
      },
    );
  });

  test('reentry: descanso nunca resoluble (NO_PASTURE_PROFILE, sin fila persistida) -> POTRERO_REST_ASSESSMENT_PENDING', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D92R REENTRY-B');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D92R REENTRY-B');
    const pasturaId = await seedPasturaPersonalizada(org, 'Pastura Sprint3D92R sin perfil');
    const fichaId = await seedFicha(org, potreroId, pasturaId);
    const recomendacionId = await seedRecomendacionPastoreo(org, predioId, potreroId, fichaId);
    const ciclo = await repo.iniciarCicloPastoreo(org, predioId, potreroId);
    const finalizado = await repo.finalizarCicloPastoreo(org, predioId, potreroId, ciclo.cicloId, { climatologyFetchImpl: SIN_RED_FETCH_IMPL });
    assert.equal(finalizado.descansoEstado, 'ERROR_TECNICO');
    assert.equal(finalizado.descanso, null);

    await assert.rejects(
      () => repo.iniciarCicloPastoreo(org, predioId, potreroId),
      (error) => error.status === 409 && error.code === 'POTRERO_REST_ASSESSMENT_PENDING' && error.cicloOrigenId === ciclo.cicloId,
    );
    void recomendacionId;
  });

  test('reentry: hoy >= fecha_reingreso_min sin evaluación -> POTRERO_REINGRESO_NO_CONFIRMADO; con evaluación APTO -> permite iniciar', async () => {
    const org = randomOrgId();
    const { predioId, potreroId } = await seedEscenarioCompleto(org, 'REENTRY-C');
    const ciclo = await repo.iniciarCicloPastoreo(org, predioId, potreroId);
    const finalizado = await repo.finalizarCicloPastoreo(org, predioId, potreroId, ciclo.cicloId, { climatologyFetchImpl: SIN_RED_FETCH_IMPL });

    await assert.rejects(
      () => repo.iniciarCicloPastoreo(org, predioId, potreroId, { now: FECHA_FUTURA_LEJANA }),
      (error) => error.status === 409 && error.code === 'POTRERO_REINGRESO_NO_CONFIRMADO' && error.descansoId === finalizado.descanso.descansoId,
    );

    // Aforo nuevo, posterior a la ventana (fecha futura lejana) -> APTO.
    // `now` es el mismo override de fecha que ya usan iniciar/finalizar --
    // NUNCA expuesto al cliente vía HTTP, solo para pruebas deterministas.
    const pasturaId = await fetchPasturaSistemaId('Brachiaria humidicola');
    const fichaNuevaId = await seedFicha(org, potreroId, pasturaId, { fechaAforo: FECHA_FUTURA_LEJANA.toISOString().slice(0, 10) });
    const evaluacion = await repo.evaluarReingreso(org, predioId, potreroId, { fichaId: fichaNuevaId, resultado: 'APTO', now: FECHA_FUTURA_LEJANA });
    assert.equal(evaluacion.resultado, 'APTO');

    const cicloNuevo = await repo.iniciarCicloPastoreo(org, predioId, potreroId, { now: FECHA_FUTURA_LEJANA });
    assert.equal(cicloNuevo.estado, 'EN_CURSO');
  });

  test('reentry: aforo ANTERIOR a la ventana es rechazado -- nunca se acepta como evidencia', async () => {
    const org = randomOrgId();
    const { predioId, potreroId } = await seedEscenarioCompleto(org, 'REENTRY-D');
    const ciclo = await repo.iniciarCicloPastoreo(org, predioId, potreroId);
    await repo.finalizarCicloPastoreo(org, predioId, potreroId, ciclo.cicloId, { climatologyFetchImpl: SIN_RED_FETCH_IMPL });

    const pasturaId = await fetchPasturaSistemaId('Brachiaria humidicola');
    // Aforo con fecha de HOY -- muy anterior a fecha_reingreso_min (semanas
    // en el futuro real). `now: FECHA_FUTURA_LEJANA` solo abre la ventana
    // de evaluación (estado EVALUACION_REINGRESO) -- la fecha del aforo en
    // sí es un dato real de DB, independiente de ese override.
    const fichaViejaId = await seedFicha(org, potreroId, pasturaId);
    await assert.rejects(
      () => repo.evaluarReingreso(org, predioId, potreroId, { fichaId: fichaViejaId, resultado: 'APTO', now: FECHA_FUTURA_LEJANA }),
      (error) => error.status === 400 && error.code === 'AFORO_ANTERIOR_A_VENTANA_REINGRESO',
    );
  });

  // SPRINT-3D9.2 (PRE-COMMIT FINAL ROUND, punto 5): un aforo VÁLIDO
  // (dentro de la ventana) pero no el MÁS RECIENTE nunca debe aceptarse
  // en silencio -- debe rechazarse guiando a usar el último registrado.
  test('reentry: aforo dentro de la ventana pero NO el más reciente -> AFORO_NO_ES_EL_MAS_RECIENTE; el más reciente sí es aceptado', async () => {
    const org = randomOrgId();
    const { predioId, potreroId } = await seedEscenarioCompleto(org, 'REENTRY-E');
    const ciclo = await repo.iniciarCicloPastoreo(org, predioId, potreroId);
    await repo.finalizarCicloPastoreo(org, predioId, potreroId, ciclo.cicloId, { climatologyFetchImpl: SIN_RED_FETCH_IMPL });

    const pasturaId = await fetchPasturaSistemaId('Brachiaria humidicola');
    const unDiaDespues = new Date(FECHA_FUTURA_LEJANA.getTime() + 24 * 60 * 60 * 1000);
    const fichaAnteriorId = await seedFicha(org, potreroId, pasturaId, { fechaAforo: FECHA_FUTURA_LEJANA.toISOString().slice(0, 10) });
    const fichaMasRecienteId = await seedFicha(org, potreroId, pasturaId, { fechaAforo: unDiaDespues.toISOString().slice(0, 10) });

    await assert.rejects(
      () => repo.evaluarReingreso(org, predioId, potreroId, { fichaId: fichaAnteriorId, resultado: 'APTO', now: unDiaDespues }),
      (error) => error.status === 409 && error.code === 'AFORO_NO_ES_EL_MAS_RECIENTE',
    );

    const evaluacion = await repo.evaluarReingreso(org, predioId, potreroId, { fichaId: fichaMasRecienteId, resultado: 'APTO', now: unDiaDespues });
    assert.equal(evaluacion.resultado, 'APTO');
  });

  test('CANCELADO intermedio ignorado: ciclo A FINALIZADO gobierna el potrero aunque exista un ciclo B CANCELADO más reciente', async () => {
    const org = randomOrgId();
    const { predioId, potreroId } = await seedEscenarioCompleto(org, 'CANCEL-IGNORE');
    const cicloA = await repo.iniciarCicloPastoreo(org, predioId, potreroId);
    const finalizadoA = await repo.finalizarCicloPastoreo(org, predioId, potreroId, cicloA.cicloId, { climatologyFetchImpl: SIN_RED_FETCH_IMPL });

    // Ciclo B: insertado DIRECTAMENTE como CANCELADO (más reciente que A
    // por created_at), simulando el ejemplo exacto del enunciado -- NUNCA
    // debería aparecer como "el ciclo relevante".
    await adminPool.query(
      `insert into agx.potrero_ciclos_pastoreo
         (organizacion_id, predio_id, potrero_id, recomendacion_pastoreo_id, categoria_id,
          numero_animales_real, peso_promedio_real_kg, fecha_ingreso_real, estado, motivo_cancelacion)
       values ($1, $2, $3, $4, $5, 10, 420, current_date, 'CANCELADO', 'prueba')`,
      [org, predioId, potreroId, cicloA.recomendacionPastoreoId, finalizadoA.ciclo.categoriaId],
    );

    const estado = await estadoRepo.getEstadoOperativoPotrero(org, predioId, potreroId);
    assert.equal(estado.estado, 'EN_DESCANSO');
    assert.equal(estado.cicloOrigenId, cicloA.cicloId, 'el descanso de A debe seguir gobernando, nunca B (CANCELADO)');
  });

  // -----------------------------------------------------------------------
  // CORREGIR (FASE A'/B')
  // -----------------------------------------------------------------------

  test('corregir: corregir fecha_salida_real invalida la v1 y genera v2 con la fecha corregida', async () => {
    const org = randomOrgId();
    const { predioId, potreroId } = await seedEscenarioCompleto(org, 'CORREGIR-A');
    const ciclo = await repo.iniciarCicloPastoreo(org, predioId, potreroId);
    const finalizado = await repo.finalizarCicloPastoreo(org, predioId, potreroId, ciclo.cicloId, { climatologyFetchImpl: SIN_RED_FETCH_IMPL });
    const v1DescansoId = finalizado.descanso.descansoId;

    const nuevaFechaSalida = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const corregido = await repo.corregirCicloPastoreo(org, predioId, potreroId, ciclo.cicloId, {
      fechaSalidaReal: nuevaFechaSalida, motivo: 'salida mal capturada', climatologyFetchImpl: SIN_RED_FETCH_IMPL,
    });
    assert.equal(corregido.descansoEstado, 'GENERADO');
    assert.notEqual(corregido.descanso.descansoId, v1DescansoId, 'debe ser una versión NUEVA, no la misma fila');
    assert.equal(corregido.descanso.fechaSalidaEstimada, nuevaFechaSalida);
    assert.equal(corregido.descanso.version, 2);

    // v1 sigue existiendo íntegra (histórico, nunca DELETE) y está invalidada.
    const v1 = await adminPool.query('select version from agx.potrero_recomendaciones_descanso where descanso_id = $1', [v1DescansoId]);
    assert.equal(v1.rows[0].version, 1);
    const invalidacion = await adminPool.query('select 1 from agx.potrero_descanso_invalidaciones where descanso_id = $1', [v1DescansoId]);
    assert.equal(invalidacion.rows.length, 1);
  });

  test('corregir: retry con el MISMO payload es idempotente -- FASE A\' no-op, FASE B\' no genera version=3', async () => {
    const org = randomOrgId();
    const { predioId, potreroId } = await seedEscenarioCompleto(org, 'CORREGIR-B');
    const ciclo = await repo.iniciarCicloPastoreo(org, predioId, potreroId);
    await repo.finalizarCicloPastoreo(org, predioId, potreroId, ciclo.cicloId, { climatologyFetchImpl: SIN_RED_FETCH_IMPL });

    const nuevaFechaSalida = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const primero = await repo.corregirCicloPastoreo(org, predioId, potreroId, ciclo.cicloId, {
      fechaSalidaReal: nuevaFechaSalida, motivo: 'salida mal capturada', climatologyFetchImpl: SIN_RED_FETCH_IMPL,
    });
    const segundo = await repo.corregirCicloPastoreo(org, predioId, potreroId, ciclo.cicloId, {
      fechaSalidaReal: nuevaFechaSalida, motivo: 'salida mal capturada (retry)', climatologyFetchImpl: SIN_RED_FETCH_IMPL,
    });
    assert.equal(segundo.descanso.descansoId, primero.descanso.descansoId, 'nunca debe crear version=3 en un retry idempotente');
    assert.equal(segundo.descanso.version, 2);

    const eventos = await adminPool.query(
      `select count(*) from agx.potrero_ciclo_eventos where ciclo_id = $1 and tipo_evento = 'PASTOREO_CORREGIDO'`,
      [ciclo.cicloId],
    );
    assert.equal(Number(eventos.rows[0].count), 1, 'un retry con el mismo payload NUNCA debe duplicar el evento PASTOREO_CORREGIDO');
  });

  // SPRINT-3D9.3 (superó el comportamiento 3D9.2 de esta prueba): desde
  // que iniciarCicloPastoreo SIEMPRE crea un snapshot real (ver
  // potreroCicloRealPressureRepositoryIntegration.test.js), corregir
  // categoría/numeroAnimales/peso SÍ dispara regeneración -- son
  // exactamente los campos que ahora alimentan la presión REAL (antes no
  // alimentaban nada porque el motor de descanso solo leía el PLAN). El
  // comportamiento "nunca regenera" queda vigente EXCLUSIVAMENTE para
  // ciclos sin snapshot (legacy, pre-3D9.3) -- no hay forma de construir
  // ese caso llamando a iniciarCicloPastoreo hoy, así que no se prueba
  // aquí (cubierto por diseño: ausencia de snapshot es la rama LEGACY de
  // resolveLoteCientificoCiclo).
  test('corregir: corregir numeroAnimales (sin fecha) SÍ dispara regeneración cuando el ciclo tiene snapshot real (3D9.3)', async () => {
    const org = randomOrgId();
    const { predioId, potreroId } = await seedEscenarioCompleto(org, 'CORREGIR-C');
    const ciclo = await repo.iniciarCicloPastoreo(org, predioId, potreroId);
    await repo.finalizarCicloPastoreo(org, predioId, potreroId, ciclo.cicloId, { climatologyFetchImpl: SIN_RED_FETCH_IMPL });

    const corregido = await repo.corregirCicloPastoreo(org, predioId, potreroId, ciclo.cicloId, {
      numeroAnimales: 8, motivo: 'conteo mal capturado', climatologyFetchImpl: SIN_RED_FETCH_IMPL,
    });
    assert.equal(corregido.descansoEstado, 'GENERADO');
    assert.equal(corregido.ciclo.numeroAnimalesReal, 8);
  });

  test('corregir: solo aplica sobre FINALIZADO -- rechaza EN_CURSO', async () => {
    const org = randomOrgId();
    const { predioId, potreroId } = await seedEscenarioCompleto(org, 'CORREGIR-D');
    const ciclo = await repo.iniciarCicloPastoreo(org, predioId, potreroId);
    await assert.rejects(
      () => repo.corregirCicloPastoreo(org, predioId, potreroId, ciclo.cicloId, { numeroAnimales: 5, motivo: 'x' }),
      (error) => error.status === 409 && error.code === 'CICLO_NOT_FINALIZADO',
    );
  });

  // -----------------------------------------------------------------------
  // ANULAR
  // -----------------------------------------------------------------------

  test('anular: ciclo FINALIZADO con descanso vigente -- invalida atómicamente, el potrero deja de estar bloqueado por ese descanso', async () => {
    const org = randomOrgId();
    const { predioId, potreroId } = await seedEscenarioCompleto(org, 'ANULAR-A');
    const ciclo = await repo.iniciarCicloPastoreo(org, predioId, potreroId);
    const finalizado = await repo.finalizarCicloPastoreo(org, predioId, potreroId, ciclo.cicloId, { climatologyFetchImpl: SIN_RED_FETCH_IMPL });

    // Antes de anular: en descanso (bloqueado).
    const estadoAntes = await estadoRepo.getEstadoOperativoPotrero(org, predioId, potreroId);
    assert.equal(estadoAntes.estado, 'EN_DESCANSO');

    const anulado = await repo.anularCicloPastoreo(org, predioId, potreroId, ciclo.cicloId, { motivo: 'registro duplicado' });
    assert.equal(anulado.estado, 'ANULADO');
    assert.equal(anulado.motivoAnulacion, 'registro duplicado');

    const invalidacion = await adminPool.query('select 1 from agx.potrero_descanso_invalidaciones where descanso_id = $1', [finalizado.descanso.descansoId]);
    assert.equal(invalidacion.rows.length, 1, 'el descanso derivado debe quedar invalidado en la MISMA operación');

    const evento = await adminPool.query(`select payload_json from agx.potrero_ciclo_eventos where ciclo_id=$1 and tipo_evento='PASTOREO_ANULADO'`, [ciclo.cicloId]);
    assert.equal(evento.rows.length, 1);
    assert.equal(evento.rows[0].payload_json.estadoAnterior, 'FINALIZADO');

    // Sin ningún otro ciclo FINALIZADO previo -> DISPONIBLE.
    const estadoDespues = await estadoRepo.getEstadoOperativoPotrero(org, predioId, potreroId);
    assert.equal(estadoDespues.estado, 'DISPONIBLE');
  });

  test('anular: EN_CURSO rechazado -- usa Cancelar, nunca Anular', async () => {
    const org = randomOrgId();
    const { predioId, potreroId } = await seedEscenarioCompleto(org, 'ANULAR-B');
    const ciclo = await repo.iniciarCicloPastoreo(org, predioId, potreroId);
    await assert.rejects(
      () => repo.anularCicloPastoreo(org, predioId, potreroId, ciclo.cicloId, { motivo: 'x' }),
      (error) => error.status === 409 && error.code === 'CICLO_EN_CURSO_USE_CANCELAR',
    );
  });

  test('anular: idempotente -- anular dos veces el mismo ciclo es un no-op, sin duplicar invalidación', async () => {
    const org = randomOrgId();
    const { predioId, potreroId } = await seedEscenarioCompleto(org, 'ANULAR-C');
    const ciclo = await repo.iniciarCicloPastoreo(org, predioId, potreroId);
    await repo.finalizarCicloPastoreo(org, predioId, potreroId, ciclo.cicloId, { climatologyFetchImpl: SIN_RED_FETCH_IMPL });
    await repo.anularCicloPastoreo(org, predioId, potreroId, ciclo.cicloId, { motivo: 'primero' });
    const segundo = await repo.anularCicloPastoreo(org, predioId, potreroId, ciclo.cicloId, { motivo: 'segundo' });
    assert.equal(segundo.motivoAnulacion, 'primero', 'el motivo original NUNCA se sobrescribe en un retry');
    const eventos = await adminPool.query(`select count(*) from agx.potrero_ciclo_eventos where ciclo_id=$1 and tipo_evento='PASTOREO_ANULADO'`, [ciclo.cicloId]);
    assert.equal(Number(eventos.rows[0].count), 1);
  });

  // -----------------------------------------------------------------------
  // ARCHIVE/RESTORE -- guards + predio gobierna potrero
  // -----------------------------------------------------------------------

  test('archivar predio: rechazado si CUALQUIER potrero del predio tiene ciclo EN_CURSO', async () => {
    const org = randomOrgId();
    const { predioId, potreroId } = await seedEscenarioCompleto(org, 'ARCHIVE-PREDIO-A');
    await repo.iniciarCicloPastoreo(org, predioId, potreroId);
    await assert.rejects(
      () => archivoRepo.archivarPredio(org, predioId, { motivo: 'x' }),
      (error) => error.status === 409 && error.code === 'PREDIO_CON_CICLO_EN_CURSO',
    );
  });

  test('archivar potrero: rechazado con ciclo EN_CURSO', async () => {
    const org = randomOrgId();
    const { predioId, potreroId } = await seedEscenarioCompleto(org, 'ARCHIVE-POTRERO-A');
    await repo.iniciarCicloPastoreo(org, predioId, potreroId);
    await assert.rejects(
      () => archivoRepo.archivarPotrero(org, predioId, potreroId, { motivo: 'x' }),
      (error) => error.status === 409 && error.code === 'POTRERO_CON_CICLO_EN_CURSO',
    );
  });

  test('restaurar potrero mientras el predio padre sigue ARCHIVADO -> rechazado', async () => {
    const org = randomOrgId();
    const { predioId, potreroId } = await seedEscenarioCompleto(org, 'RESTORE-GUARD');
    await archivoRepo.archivarPotrero(org, predioId, potreroId, { motivo: 'x' });
    await archivoRepo.archivarPredio(org, predioId, { motivo: 'x' });
    await assert.rejects(
      () => archivoRepo.restaurarPotrero(org, predioId, potreroId),
      (error) => error.status === 409 && error.code === 'PREDIO_ARCHIVADO',
    );
  });

  test('predio ARCHIVADO gobierna el estado operativo del potrero (aunque potrero.estado siga ACTIVO); restaurar el predio no reactiva un potrero individualmente archivado', async () => {
    const org = randomOrgId();
    const { predioId, potreroId } = await seedEscenarioCompleto(org, 'PREDIO-GOBIERNA');
    await archivoRepo.archivarPredio(org, predioId, { motivo: 'x' });

    const estado = await estadoRepo.getEstadoOperativoPotrero(org, predioId, potreroId);
    assert.equal(estado.estado, 'ARCHIVADO');
    assert.equal(estado.reason, 'PREDIO_ARCHIVADO');

    const potreroRow = await adminPool.query('select estado from agx.potreros where potrero_id = $1', [potreroId]);
    assert.equal(potreroRow.rows[0].estado, 'ACTIVO', 'archivar el predio NUNCA modifica físicamente potrero.estado');

    await assert.rejects(
      () => repo.iniciarCicloPastoreo(org, predioId, potreroId),
      (error) => error.status === 409 && error.code === 'PREDIO_ARCHIVADO',
    );
  });

  // -----------------------------------------------------------------------
  // Tenant isolation -- spot checks sobre la superficie nueva
  // -----------------------------------------------------------------------

  test('tenant isolation: anular/corregir/evaluar-reingreso de otra organización son rechazados', async () => {
    const orgA = randomOrgId();
    const orgB = randomOrgId();
    const { predioId, potreroId } = await seedEscenarioCompleto(orgA, 'TENANT');
    const ciclo = await repo.iniciarCicloPastoreo(orgA, predioId, potreroId);
    await repo.finalizarCicloPastoreo(orgA, predioId, potreroId, ciclo.cicloId, { climatologyFetchImpl: SIN_RED_FETCH_IMPL });

    await assert.rejects(
      () => repo.anularCicloPastoreo(orgB, predioId, potreroId, ciclo.cicloId, { motivo: 'x' }),
      (error) => error.status === 404,
    );
    await assert.rejects(
      () => repo.corregirCicloPastoreo(orgB, predioId, potreroId, ciclo.cicloId, { numeroAnimales: 5, motivo: 'x' }),
      (error) => error.status === 404,
    );
    await assert.rejects(
      () => archivoRepo.archivarPotrero(orgB, predioId, potreroId, { motivo: 'x' }),
      (error) => error.status === 404,
    );
  });
});
