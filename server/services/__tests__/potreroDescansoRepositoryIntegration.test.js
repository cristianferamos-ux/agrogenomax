// SPRINT-3D8-DESCANSO-REENTRADA (hardening dinámico): pruebas del
// repositorio (server/services/ganaderia/potreroDescansoRepository.js)
// contra un Postgres/PostGIS REAL. Cubre: baseline PASTURE_SPECIFIC_REGIONAL
// (humidicola, fixture POTRERO 1) vs. NO_PASTURE_PROFILE (§4 del
// hardening: nunca un fallback universal), escenarios agroclimáticos
// dinámicos (A-F, §29/§30), test de no rigidez (mismo potrero/pastura,
// contexto distinto -> rango distinto), frescura del contexto, guardrail
// de presión, recálculo/histórico append-only con previous_descanso_id,
// aislamiento tenant y motor_version.
//
// Lee EXCLUSIVAMENTE AGX_BUSINESS_DATABASE_URL_TEST (nunca la variable de
// producción/runtime real). Ver db/agx-business/migrations/README.md.
delete process.env.AGX_BUSINESS_DATABASE_URL;

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import pg from 'pg';
import { computeBreakpoints } from '../ganaderia/motorDescansoAuto/climatologyStatistics.js';

let dbAvailable = false;
let adminPool;
let repo;
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

  const tableCheck = await adminPool.query("select to_regclass('agx.potrero_recomendaciones_descanso') as t");
  dbAvailable = Boolean(tableCheck.rows[0]?.t);
} catch {
  dbAvailable = false;
}

if (dbAvailable) {
  repo = await import('../ganaderia/potreroDescansoRepository.js');
  businessDb = await import('../../db/agxBusinessPool.js');
}

function randomOrgId() {
  return crypto.randomUUID();
}

// HARDENING OPERACIONAL (round 5): preview/create ahora auto-generan la
// climatología local dentro de la MISMA transacción cuando no hay caché
// válida (potreroDescansoRepository.js). Estos tests NO validan el
// proveedor histórico real (ver era5HistoricalClimatologyProvider.test.js
// / potreroClimatologiaRepositoryIntegration.test.js para eso) -- inyectan
// un fetchImpl que falla de inmediato, SIN red real, para que el motor
// degrade honestamente a "sin climatología" (mismo comportamiento que
// tenían estos tests antes de esta ronda, cuando ningún potrero tenía
// climatología cacheada). Los tests que SÍ necesitan climatología
// (§24/§21) la siembran directamente vía seedClimatologiaUniforme -- la
// caché válida hace que preview/create NUNCA lleguen a invocar
// climatologyFetchImpl, así que inyectarlo aquí también es inofensivo.
const SIN_RED_FETCH_IMPL = async () => ({ ok: false, status: 503, json: async () => ({}) });

function callPreview(...args) {
  return repo.previewDescansoReentrada(...args, { climatologyFetchImpl: SIN_RED_FETCH_IMPL });
}

function callCreate(...args) {
  return repo.createDescansoReentrada(...args, { climatologyFetchImpl: SIN_RED_FETCH_IMPL });
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

async function fetchPasturaSistemaId(nombreComun) {
  const result = await adminPool.query(
    `select pastura_id from agx.catalogo_pasturas where alcance = 'sistema' and nombre_comun = $1`,
    [nombreComun],
  );
  return result.rows[0]?.pastura_id;
}

async function seedPasturaPersonalizada(orgId, nombre, tipo = 'graminea') {
  const result = await adminPool.query(
    `insert into agx.catalogo_pasturas (organizacion_id, nombre_comun, tipo, alcance)
     values ($1, $2, $3, 'personalizado') returning pastura_id`,
    [orgId, nombre, tipo],
  );
  return result.rows[0].pastura_id;
}

async function seedFicha(orgId, potreroId, pasturaId, { biomasaTotalKg = 5000 } = {}) {
  const fichaResult = await adminPool.query(
    `insert into agx.potrero_fichas_productivas
       (organizacion_id, potrero_id, tipo_cobertura, nombre_principal, aforo_promedio_g_m2, fecha_aforo, biomasa_total_kg)
     values ($1, $2, 'pastura', 'Pastura Test', 500, current_date, $3)
     returning ficha_id`,
    [orgId, potreroId, biomasaTotalKg],
  );
  const fichaId = fichaResult.rows[0].ficha_id;
  await adminPool.query(
    `insert into agx.potrero_ficha_pasturas (organizacion_id, ficha_id, pastura_id, porcentaje_estimado, orden)
     values ($1, $2, $3, 100, 0)`,
    [orgId, fichaId, pasturaId],
  );
  return fichaId;
}

async function seedContexto(orgId, predioId, potreroId, overrides = {}) {
  const v = {
    precipitacion7dMm: 20, precipitacion15dMm: 40, precipitacion30dMm: 80,
    temperaturaMediaC: 25, humedadSueloSuperficial: 0.3, humedadSueloSubsuperficial: 0.3,
    sourceObservedUntil: new Date(),
    ...overrides,
  };
  const result = await adminPool.query(
    `insert into agx.potrero_contextos_agroclimaticos
       (organizacion_id, predio_id, potrero_id, fecha_referencia, precipitacion_7d_mm, precipitacion_15d_mm, precipitacion_30d_mm,
        temperatura_media_c, humedad_suelo_superficial, humedad_suelo_subsuperficial, source_observed_until,
        fuente_principal, fuentes_json)
     values ($1, $2, $3, current_date, $4, $5, $6, $7, $8, $9, $10, 'ERA5_LAND', '[]')
     returning contexto_id`,
    [orgId, predioId, potreroId, v.precipitacion7dMm, v.precipitacion15dMm, v.precipitacion30dMm,
      v.temperaturaMediaC, v.humedadSueloSuperficial, v.humedadSueloSubsuperficial, v.sourceObservedUntil],
  );
  return result.rows[0].contexto_id;
}

async function fetchCategoriaId(codigo) {
  const result = await adminPool.query(
    'select categoria_id from agx.catalogo_categorias_productivas where codigo = $1',
    [codigo],
  );
  return result.rows[0]?.categoria_id;
}

async function seedRecomendacionPastoreo(org, predioId, potreroId, fichaId, { diasOcupacionEstimados = 4.96 } = {}) {
  const categoriaId = await fetchCategoriaId('novillo_ceba');
  const result = await adminPool.query(
    `insert into agx.potrero_recomendaciones_pastoreo
       (organizacion_id, predio_id, potrero_id, ficha_id, categoria_id, numero_animales, peso_promedio_kg,
        materia_seca_pct_aplicada, utilizacion_pct_aplicada, consumo_pct_pv_aplicado,
        materia_seca_total_kg, materia_seca_utilizable_kg, demanda_diaria_lote_kg_ms, dias_ocupacion_estimados,
        nivel_confianza, motor_version)
     values ($1, $2, $3, $4, $5, 10, 420, 20, 50, 2.4, 1000, 500, 100.8, $6, 'MEDIA', 'pastoreo-auto-v1')
     returning recomendacion_id`,
    [org, predioId, potreroId, fichaId, categoriaId, diasOcupacionEstimados],
  );
  return result.rows[0].recomendacion_id;
}

describe('SPRINT-3D8 (hardening dinámico): potreroDescansoRepository contra Postgres-AGX-Business real', { skip: !dbAvailable }, () => {
  after(async () => {
    if (!adminPool) return;
    await adminPool.query(`
      delete from agx.potrero_climatologias_agroclimaticas
       where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D8R%')
    `);
    await adminPool.query(`
      delete from agx.potrero_recomendaciones_descanso
       where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D8R%')
    `);
    await adminPool.query(`
      delete from agx.potrero_recomendaciones_pastoreo
       where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D8R%')
    `);
    await adminPool.query(`
      delete from agx.potrero_contextos_agroclimaticos
       where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D8R%')
    `);
    await adminPool.query(`
      delete from agx.potrero_ficha_pasturas
       where ficha_id in (
         select ficha_id from agx.potrero_fichas_productivas
          where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D8R%')
       )
    `);
    await adminPool.query(`
      delete from agx.potrero_fichas_productivas
       where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D8R%')
    `);
    await adminPool.query(`delete from agx.catalogo_pasturas where nombre_comun like 'Pastura Sprint3D8R%'`);
    await adminPool.query(`delete from agx.potreros where nombre like 'Potrero Sprint3D8R%'`);
    await adminPool.query(`delete from agx.predios where nombre_predio like 'Predio Sprint3D8R%'`);
    if (businessDb) await businessDb.closeAgxBusinessPool();
    await adminPool.end();
  });

  test('GET sin descansos previos -> { actual: null, historial: [] }, nunca 404', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D8R GET-EMPTY');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D8R GET-EMPTY');

    const result = await repo.getDescansoReentradaByPotrero(org, predioId, potreroId);
    assert.deepEqual(result, { actual: null, historial: [] });
  });

  test('sin recomendación de pastoreo guardada -> NO_GRAZING_RECOMMENDATION (404), nunca calcula sin ella', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D8R NOREC');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D8R NOREC');

    await assert.rejects(
      () => callPreview(org, predioId, potreroId, { fechaInicioPastoreo: '2026-09-01' }),
      (error) => error.status === 404 && error.code === 'NO_GRAZING_RECOMMENDATION',
    );
  });

  test('§4 del hardening: pastura sin perfil regional específico -> NO_PASTURE_PROFILE, NUNCA un fallback inventado', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D8R NOPROFILE');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D8R NOPROFILE');
    const pasturaId = await seedPasturaPersonalizada(org, 'Pastura Sprint3D8R NOPROFILE', 'graminea');
    const fichaId = await seedFicha(org, potreroId, pasturaId);
    await seedContexto(org, predioId, potreroId);
    await seedRecomendacionPastoreo(org, predioId, potreroId, fichaId);

    await assert.rejects(
      () => callPreview(org, predioId, potreroId, { fechaInicioPastoreo: '2026-09-01' }),
      (error) => error.status === 404 && error.code === 'NO_PASTURE_PROFILE',
    );
  });

  test('POTRERO 1 (fixture real): Brachiaria humidicola (catálogo de sistema) resuelve baseline PASTURE_SPECIFIC_REGIONAL', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D8R HUMIDICOLA');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D8R HUMIDICOLA');
    const pasturaId = await fetchPasturaSistemaId('Brachiaria humidicola');
    assert.ok(pasturaId, 'el catálogo de sistema debe tener "Brachiaria humidicola" (0004)');
    const fichaId = await seedFicha(org, potreroId, pasturaId);
    // Escenario A (normal): sin señales restrictivas ni favorables sostenidas.
    // 7d por debajo del umbral (sequedad reciente) + 30d normal ->
    // RULE_RECENT_DRY_NOT_SEVERE -> NORMAL (§8: nunca RESTRICTIVE ni
    // FAVORABLE -- si 7d/15d/30d estuvieran TODAS por encima del umbral,
    // dispararía RULE_SUSTAINED_MOISTURE -> FAVORABLE).
    await seedContexto(org, predioId, potreroId, { precipitacion7dMm: 8, precipitacion15dMm: 25, precipitacion30dMm: 45 });
    await seedRecomendacionPastoreo(org, predioId, potreroId, fichaId);

    const preview = await callPreview(org, predioId, potreroId, { fechaInicioPastoreo: '2026-09-01' });
    assert.equal(preview.estado, 'READY');
    assert.equal(preview.provenance.pasturaSourceType, 'PASTURE_SPECIFIC_REGIONAL');
    assert.equal(preview.agroClimate.status, 'NORMAL');
    assert.equal(preview.resultado.diasDescansoMin, 25);
    assert.equal(preview.resultado.diasDescansoMax, 35);
    assert.equal(preview.resultado.diasDescansoRecomendado, 30);
    assert.ok(preview.condicionesReentrada.some((c) => c.codigo === 'ALTURA_ENTRADA_REFERENCIA'));
    assert.ok(preview.windowConditions.includes('REENTRY_WINDOW_ESTIMATED'));
  });

  // -----------------------------------------------------------------------
  // Test de NO RIGIDEZ (§31 del hardening): mismo potrero/pastura, contexto
  // DISTINTO -> rango DISTINTO. Nunca "if humidicola: return [25,35]" fijo.
  // -----------------------------------------------------------------------
  test('test de no rigidez: mismo potrero/pastura con contexto NORMAL vs DÉFICIT PERSISTENTE produce rangos distintos', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D8R NORIGIDEZ');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D8R NORIGIDEZ');
    const pasturaId = await fetchPasturaSistemaId('Brachiaria humidicola');
    const fichaId = await seedFicha(org, potreroId, pasturaId);
    await seedRecomendacionPastoreo(org, predioId, potreroId, fichaId);

    // 7d por debajo del umbral (sequedad reciente) + 30d normal ->
    // RULE_RECENT_DRY_NOT_SEVERE -> NORMAL (§8: nunca RESTRICTIVE ni
    // FAVORABLE -- si 7d/15d/30d estuvieran TODAS por encima del umbral,
    // dispararía RULE_SUSTAINED_MOISTURE -> FAVORABLE).
    await seedContexto(org, predioId, potreroId, { precipitacion7dMm: 8, precipitacion15dMm: 25, precipitacion30dMm: 45 });
    const previewNormal = await callPreview(org, predioId, potreroId, { fechaInicioPastoreo: '2026-09-01' });

    // Nuevo snapshot (más reciente) -- déficit persistente real.
    await seedContexto(org, predioId, potreroId, { precipitacion7dMm: 2, precipitacion15dMm: 5, precipitacion30dMm: 10 });
    const previewDeficit = await callPreview(org, predioId, potreroId, { fechaInicioPastoreo: '2026-09-01' });

    assert.equal(previewNormal.agroClimate.status, 'NORMAL');
    assert.equal(previewDeficit.agroClimate.status, 'RESTRICTIVE');
    assert.notEqual(previewNormal.resultado.diasDescansoMin, previewDeficit.resultado.diasDescansoMin);
    assert.ok(previewDeficit.resultado.diasDescansoMin > previewNormal.resultado.diasDescansoMin);
  });

  test('escenario D (lluvia reciente tras sequía de 30d): NUNCA clasifica favorable, nunca acorta el descanso', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D8R LLUVIATRASSEQUIA');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D8R LLUVIATRASSEQUIA');
    const pasturaId = await fetchPasturaSistemaId('Brachiaria humidicola');
    const fichaId = await seedFicha(org, potreroId, pasturaId);
    await seedContexto(org, predioId, potreroId, { precipitacion7dMm: 200, precipitacion15dMm: 200, precipitacion30dMm: 10 });
    await seedRecomendacionPastoreo(org, predioId, potreroId, fichaId);

    const preview = await callPreview(org, predioId, potreroId, { fechaInicioPastoreo: '2026-09-01' });
    assert.notEqual(preview.agroClimate.status, 'FAVORABLE');
    assert.equal(preview.resultado.diasDescansoMin, 25);
  });

  test('§9: lluvia sostenida alta PERO humedad de suelo baja -> nunca favorable (prioridad de humedad de suelo)', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D8R SUELOSECO');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D8R SUELOSECO');
    const pasturaId = await fetchPasturaSistemaId('Brachiaria humidicola');
    const fichaId = await seedFicha(org, potreroId, pasturaId);
    await seedContexto(org, predioId, potreroId, {
      precipitacion7dMm: 200, precipitacion15dMm: 200, precipitacion30dMm: 200,
      humedadSueloSuperficial: 0.05, humedadSueloSubsuperficial: 0.05,
    });
    await seedRecomendacionPastoreo(org, predioId, potreroId, fichaId);

    const preview = await callPreview(org, predioId, potreroId, { fechaInicioPastoreo: '2026-09-01' });
    assert.notEqual(preview.agroClimate.status, 'FAVORABLE');
    assert.equal(preview.agroClimate.soilMoistureSignal, 'RESTRICTIVE');
  });

  test('clima favorable (lluvia sostenida + suelo húmedo) NUNCA reduce min/max, solo orienta el recomendado hacia abajo', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D8R FAVORABLE');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D8R FAVORABLE');
    const pasturaId = await fetchPasturaSistemaId('Brachiaria humidicola');
    const fichaId = await seedFicha(org, potreroId, pasturaId);
    await seedContexto(org, predioId, potreroId, {
      precipitacion7dMm: 60, precipitacion15dMm: 90, precipitacion30dMm: 150,
      humedadSueloSuperficial: 0.35, humedadSueloSubsuperficial: 0.35, temperaturaMediaC: 26,
    });
    await seedRecomendacionPastoreo(org, predioId, potreroId, fichaId);

    const preview = await callPreview(org, predioId, potreroId, { fechaInicioPastoreo: '2026-09-01' });
    assert.equal(preview.agroClimate.status, 'FAVORABLE');
    assert.equal(preview.resultado.diasDescansoMin, 25);
    assert.equal(preview.resultado.diasDescansoMax, 35);
    assert.ok(preview.resultado.diasDescansoRecomendado < 30, 'debe orientarse hacia la parte baja del rango');
    assert.ok(preview.resultado.diasDescansoRecomendado >= preview.resultado.diasDescansoMin);
  });

  test('sin contexto agroclimático -> estado NO_AGROCLIMATE_CONTEXT (200, modo degradado, nunca crash)', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D8R NOCLIMA');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D8R NOCLIMA');
    const pasturaId = await fetchPasturaSistemaId('Brachiaria humidicola');
    const fichaId = await seedFicha(org, potreroId, pasturaId);
    await seedRecomendacionPastoreo(org, predioId, potreroId, fichaId);

    const preview = await callPreview(org, predioId, potreroId, { fechaInicioPastoreo: '2026-09-01' });
    assert.equal(preview.estado, 'NO_AGROCLIMATE_CONTEXT');
    assert.equal(preview.nivelConfianza, 'BAJA');
  });

  test('contexto STALE (>30 días) -> estado STALE_AGROCLIMATE_CONTEXT, confianza degradada', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D8R STALE');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D8R STALE');
    const pasturaId = await fetchPasturaSistemaId('Brachiaria humidicola');
    const fichaId = await seedFicha(org, potreroId, pasturaId);
    const fechaVieja = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
    await seedContexto(org, predioId, potreroId, { sourceObservedUntil: fechaVieja });
    await seedRecomendacionPastoreo(org, predioId, potreroId, fichaId);

    const preview = await callPreview(org, predioId, potreroId, { fechaInicioPastoreo: '2026-09-01' });
    assert.equal(preview.estado, 'STALE_AGROCLIMATE_CONTEXT');
    assert.notEqual(preview.nivelConfianza, 'ALTA');
  });

  test('contexto con precipitación/suelo/temperatura null (parcial) -> estado PARTIAL_CONTEXT', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D8R PARCIAL');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D8R PARCIAL');
    const pasturaId = await fetchPasturaSistemaId('Brachiaria humidicola');
    const fichaId = await seedFicha(org, potreroId, pasturaId);
    await seedContexto(org, predioId, potreroId, {
      precipitacion7dMm: null, precipitacion15dMm: null, precipitacion30dMm: null,
      humedadSueloSuperficial: null, humedadSueloSubsuperficial: null, temperaturaMediaC: null,
    });
    await seedRecomendacionPastoreo(org, predioId, potreroId, fichaId);

    const preview = await callPreview(org, predioId, potreroId, { fechaInicioPastoreo: '2026-09-01' });
    assert.equal(preview.estado, 'PARTIAL_CONTEXT');
    assert.equal(preview.agroClimate.status, 'INSUFFICIENT_DATA');
  });

  test('fecha_salida_estimada / fecha_reingreso se derivan de fechaInicioPastoreo + días de ocupación/descanso', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D8R FECHAS');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D8R FECHAS');
    const pasturaId = await fetchPasturaSistemaId('Brachiaria humidicola');
    const fichaId = await seedFicha(org, potreroId, pasturaId);
    // 7d por debajo del umbral (sequedad reciente) + 30d normal ->
    // RULE_RECENT_DRY_NOT_SEVERE -> NORMAL (§8: nunca RESTRICTIVE ni
    // FAVORABLE -- si 7d/15d/30d estuvieran TODAS por encima del umbral,
    // dispararía RULE_SUSTAINED_MOISTURE -> FAVORABLE).
    await seedContexto(org, predioId, potreroId, { precipitacion7dMm: 8, precipitacion15dMm: 25, precipitacion30dMm: 45 });
    // diasOcupacionEstimados por defecto (4.96) -> floor = 4.
    await seedRecomendacionPastoreo(org, predioId, potreroId, fichaId);

    const preview = await callPreview(org, predioId, potreroId, { fechaInicioPastoreo: '2026-09-01' });
    assert.equal(preview.fechaSalidaEstimada, '2026-09-05');
    assert.equal(preview.resultado.fechaReingresoMin, '2026-09-30');
    assert.equal(preview.resultado.fechaReingresoMax, '2026-10-10');
    assert.equal(preview.resultado.fechaReingresoRecomendada, '2026-10-05');
  });

  test('preview NUNCA persiste -- create sí, encadena previous_descanso_id (recálculo, append-only)', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D8R CREATE');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D8R CREATE');
    const pasturaId = await fetchPasturaSistemaId('Brachiaria humidicola');
    const fichaId = await seedFicha(org, potreroId, pasturaId);
    // 7d por debajo del umbral (sequedad reciente) + 30d normal ->
    // RULE_RECENT_DRY_NOT_SEVERE -> NORMAL (§8: nunca RESTRICTIVE ni
    // FAVORABLE -- si 7d/15d/30d estuvieran TODAS por encima del umbral,
    // dispararía RULE_SUSTAINED_MOISTURE -> FAVORABLE).
    await seedContexto(org, predioId, potreroId, { precipitacion7dMm: 8, precipitacion15dMm: 25, precipitacion30dMm: 45 });
    await seedRecomendacionPastoreo(org, predioId, potreroId, fichaId);

    await callPreview(org, predioId, potreroId, { fechaInicioPastoreo: '2026-09-01' });
    const antes = await adminPool.query('select count(*) from agx.potrero_recomendaciones_descanso where potrero_id = $1', [potreroId]);
    assert.equal(Number(antes.rows[0].count), 0);

    const primero = await callCreate(org, predioId, potreroId, { fechaInicioPastoreo: '2026-09-01' });
    assert.equal(primero.motorVersion, 'descanso-v1');
    assert.equal(primero.previousDescansoId, null, 'la primera recomendación de este potrero no tiene predecesora');

    // Nuevo contexto (déficit persistente) llega -> recálculo real.
    await seedContexto(org, predioId, potreroId, { precipitacion7dMm: 2, precipitacion15dMm: 5, precipitacion30dMm: 10 });
    const segundo = await callCreate(org, predioId, potreroId, { fechaInicioPastoreo: '2026-09-01' });
    assert.equal(segundo.previousDescansoId, primero.descansoId, '§19/§24: el recálculo encadena la fila anterior, nunca la edita');
    assert.notEqual(segundo.agroclimateStatus, primero.agroclimateStatus);

    const conteo = await adminPool.query('select count(*) from agx.potrero_recomendaciones_descanso where potrero_id = $1', [potreroId]);
    assert.equal(Number(conteo.rows[0].count), 2, 'append-only: el recálculo NUNCA sobrescribe la fila anterior');

    const listado = await repo.getDescansoReentradaByPotrero(org, predioId, potreroId);
    assert.equal(listado.actual.descansoId, segundo.descansoId);
    assert.equal(listado.historial.length, 1);
    assert.equal(listado.historial[0].descansoId, primero.descansoId);
  });

  test('§21/§28: preview detecta REASSESSMENT_RECOMMENDED cuando las condiciones cambiaron desde la última recomendación guardada', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D8R REASSESS');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D8R REASSESS');
    const pasturaId = await fetchPasturaSistemaId('Brachiaria humidicola');
    const fichaId = await seedFicha(org, potreroId, pasturaId);
    // 7d por debajo del umbral (sequedad reciente) + 30d normal ->
    // RULE_RECENT_DRY_NOT_SEVERE -> NORMAL (§8: nunca RESTRICTIVE ni
    // FAVORABLE -- si 7d/15d/30d estuvieran TODAS por encima del umbral,
    // dispararía RULE_SUSTAINED_MOISTURE -> FAVORABLE).
    await seedContexto(org, predioId, potreroId, { precipitacion7dMm: 8, precipitacion15dMm: 25, precipitacion30dMm: 45 });
    await seedRecomendacionPastoreo(org, predioId, potreroId, fichaId);
    await callCreate(org, predioId, potreroId, { fechaInicioPastoreo: '2026-09-01' });

    // Sin cambios -> no debería recomendar reevaluación.
    const previewSinCambios = await callPreview(org, predioId, potreroId, { fechaInicioPastoreo: '2026-09-01' });
    assert.ok(!previewSinCambios.windowConditions.includes('REASSESSMENT_RECOMMENDED'));

    // Llega un nuevo snapshot con déficit persistente -> las condiciones cambiaron.
    await seedContexto(org, predioId, potreroId, { precipitacion7dMm: 2, precipitacion15dMm: 5, precipitacion30dMm: 10 });
    const previewConCambios = await callPreview(org, predioId, potreroId, { fechaInicioPastoreo: '2026-09-01' });
    assert.ok(previewConCambios.windowConditions.includes('REASSESSMENT_RECOMMENDED'));
  });

  test('aislamiento tenant: descansos de ORG A invisibles vía repositorio para ORG B', async () => {
    const orgA = randomOrgId();
    const orgB = randomOrgId();
    const predioA = await seedPredio(orgA, 'Predio Sprint3D8R TENANT');
    const potreroA = await seedPotrero(orgA, predioA, 'Potrero Sprint3D8R TENANT');
    const pasturaId = await fetchPasturaSistemaId('Brachiaria humidicola');
    const fichaId = await seedFicha(orgA, potreroA, pasturaId);
    await seedContexto(orgA, predioA, potreroA);
    await seedRecomendacionPastoreo(orgA, predioA, potreroA, fichaId);
    await callCreate(orgA, predioA, potreroA, { fechaInicioPastoreo: '2026-09-01' });

    await assert.rejects(
      () => repo.getDescansoReentradaByPotrero(orgB, predioA, potreroA),
      (error) => error.status === 404 && error.code === 'POTRERO_NOT_FOUND',
    );
  });

  test('provenance: nunca oculta metadata/limitaciones del baseline regional', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D8R PROV');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D8R PROV');
    const pasturaId = await fetchPasturaSistemaId('Brachiaria humidicola');
    const fichaId = await seedFicha(org, potreroId, pasturaId);
    // 7d por debajo del umbral (sequedad reciente) + 30d normal ->
    // RULE_RECENT_DRY_NOT_SEVERE -> NORMAL (§8: nunca RESTRICTIVE ni
    // FAVORABLE -- si 7d/15d/30d estuvieran TODAS por encima del umbral,
    // dispararía RULE_SUSTAINED_MOISTURE -> FAVORABLE).
    await seedContexto(org, predioId, potreroId, { precipitacion7dMm: 8, precipitacion15dMm: 25, precipitacion30dMm: 45 });
    await seedRecomendacionPastoreo(org, predioId, potreroId, fichaId);

    const preview = await callPreview(org, predioId, potreroId, { fechaInicioPastoreo: '2026-09-01' });
    assert.equal(preview.provenance.pasturaSourceType, 'PASTURE_SPECIFIC_REGIONAL');
    assert.ok(Array.isArray(preview.provenance.pasturaMetadata.limitaciones));
    assert.ok(preview.provenance.pasturaMetadata.limitaciones.length > 0);
  });

  // -----------------------------------------------------------------------
  // HARDENING TERRITORIAL §24: mismo valor absoluto, climatología LOCAL
  // distinta -> clasificación distinta -- probado de punta a punta contra
  // la DB real (climatología cacheada -> repositorio de descanso).
  // -----------------------------------------------------------------------

  async function seedClimatologiaUniforme(org, predioId, potreroId, { soilValues, precip7dValues, precip30dValues }) {
    const bpSuelo = computeBreakpoints(soilValues);
    const bpPrecip7d = computeBreakpoints(precip7dValues);
    const bpPrecip30d = computeBreakpoints(precip30dValues);
    const paraTodosLosMeses = (bp) => Object.fromEntries(Array.from({ length: 12 }, (_, i) => [String(i + 1), bp]));
    const monthlyStatistics = {
      precipitacion7dMm: paraTodosLosMeses(bpPrecip7d),
      precipitacion15dMm: paraTodosLosMeses(bpPrecip7d),
      precipitacion30dMm: paraTodosLosMeses(bpPrecip30d),
      humedadSueloSuperficial: paraTodosLosMeses(bpSuelo),
      humedadSueloSubsuperficial: paraTodosLosMeses(bpSuelo),
      temperaturaMediaC: paraTodosLosMeses(computeBreakpoints([20, 22, 24, 26, 28, 30])),
    };
    await adminPool.query(
      `insert into agx.potrero_climatologias_agroclimaticas
         (organizacion_id, predio_id, potrero_id, period_start_year, period_end_year, method_version, monthly_statistics_json)
       values ($1, $2, $3, 1991, 2020, 'climatology-v1', $4)`,
      [org, predioId, potreroId, JSON.stringify(monthlyStatistics)],
    );
  }

  test('§24 territorialidad end-to-end: el MISMO valor absoluto de humedad de suelo produce descansos distintos según la climatología cacheada del potrero', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D8R TERRITORIAL');
    const potreroHumedo = await seedPotrero(org, predioId, 'Potrero Sprint3D8R TERRITORIAL-HUMEDO');
    const potreroSeco = await seedPotrero(org, predioId, 'Potrero Sprint3D8R TERRITORIAL-SECO');
    const pasturaId = await fetchPasturaSistemaId('Brachiaria humidicola');

    const fichaHumedo = await seedFicha(org, potreroHumedo, pasturaId);
    const fichaSeco = await seedFicha(org, potreroSeco, pasturaId);
    // MISMO valor absoluto de contexto actual en ambos potreros.
    await seedContexto(org, predioId, potreroHumedo, { precipitacion7dMm: 22, precipitacion15dMm: 44, precipitacion30dMm: 100, humedadSueloSuperficial: 0.20, humedadSueloSubsuperficial: 0.20 });
    await seedContexto(org, predioId, potreroSeco, { precipitacion7dMm: 22, precipitacion15dMm: 44, precipitacion30dMm: 100, humedadSueloSuperficial: 0.20, humedadSueloSubsuperficial: 0.20 });
    await seedRecomendacionPastoreo(org, predioId, potreroHumedo, fichaHumedo);
    await seedRecomendacionPastoreo(org, predioId, potreroSeco, fichaSeco);

    // Climatologías LOCALES distintas -- 0.20 es un déficit severo para el
    // potrero históricamente húmedo, y una condición favorable para el
    // potrero históricamente seco.
    await seedClimatologiaUniforme(org, predioId, potreroHumedo, {
      soilValues: [0.30, 0.32, 0.35, 0.38, 0.40, 0.42], precip7dValues: [15, 18, 20, 22, 25, 28], precip30dValues: [70, 80, 90, 100, 110, 120],
    });
    await seedClimatologiaUniforme(org, predioId, potreroSeco, {
      soilValues: [0.02, 0.05, 0.08, 0.10, 0.12, 0.16], precip7dValues: [15, 18, 20, 22, 25, 28], precip30dValues: [70, 80, 90, 100, 110, 120],
    });

    const previewHumedo = await callPreview(org, predioId, potreroHumedo, { fechaInicioPastoreo: '2026-09-01' });
    const previewSeco = await callPreview(org, predioId, potreroSeco, { fechaInicioPastoreo: '2026-09-01' });

    assert.equal(previewHumedo.agroClimate.localClimatologyStatus, 'AVAILABLE');
    assert.equal(previewHumedo.agroClimate.soilMoistureSignal, 'RESTRICTIVE');
    assert.equal(previewSeco.agroClimate.soilMoistureSignal, 'FAVORABLE');
    assert.notEqual(previewHumedo.resultado.diasDescansoMin, previewSeco.resultado.diasDescansoMin);
    assert.ok(previewHumedo.resultado.diasDescansoMin > previewSeco.resultado.diasDescansoMin);
  });

  test('§21 del hardening: sin climatología local cacheada, la confianza NUNCA es ALTA aunque el clima parezca favorable', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D8R SINCLIMATOLOGIA');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D8R SINCLIMATOLOGIA');
    const pasturaId = await fetchPasturaSistemaId('Brachiaria humidicola');
    const fichaId = await seedFicha(org, potreroId, pasturaId);
    // Condiciones que el guardrail absoluto clasifica como FAVORABLE.
    await seedContexto(org, predioId, potreroId, { precipitacion7dMm: 60, precipitacion15dMm: 90, precipitacion30dMm: 150 });
    await seedRecomendacionPastoreo(org, predioId, potreroId, fichaId);

    const preview = await callPreview(org, predioId, potreroId, { fechaInicioPastoreo: '2026-09-01' });
    assert.equal(preview.agroClimate.localClimatologyStatus, 'INSUFFICIENT_LOCAL_CLIMATOLOGY');
    assert.notEqual(preview.nivelConfianza, 'ALTA');
    // §11 test G: el motor SÍ intentó auto-generar (nunca omite el intento),
    // pero el proveedor histórico no respondió -- degrada honestamente,
    // nunca fabrica percentiles.
    assert.equal(preview.climatologyGenerated, false);
  });

  // -----------------------------------------------------------------------
  // HARDENING OPERACIONAL (round 5) §1-§8/§11: preview y create AUTOGENERAN
  // la climatología local dentro de la MISMA transacción cuando hace falta
  // -- el cliente nunca ejecuta un paso adicional. Tests A-H nombrados
  // exactamente como en el sprint. Nested DENTRO del describe exterior a
  // propósito -- comparte el mismo pool admin/negocio y su `after` de
  // cierre (adminPool.end()), que corre DESPUÉS de este bloque anidado.
  // -----------------------------------------------------------------------
  describeAutogenTests();
});

// fetchImpl mockeado que SIEMPRE responde con éxito (mismo patrón que
// potreroClimatologiaRepositoryIntegration.test.js) + contador de llamadas
// -- permite probar "nunca vuelve a llamar al proveedor" (tests B/D).
function buildAutoGenMockFetchImpl({ precipValue = 5, tempValue = 25, soilValue = 0.3 } = {}) {
  let llamadas = 0;
  const fetchImpl = async (url) => {
    llamadas += 1;
    const u = String(url);
    const year = Number(u.match(/start_date=(\d{4})/)[1]);
    const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    const hoursInYear = (isLeap ? 366 : 365) * 24;
    const time = [];
    const base = Date.UTC(year, 0, 1, 0, 0, 0);
    for (let i = 0; i < hoursInYear; i += 1) time.push(new Date(base + i * 3600 * 1000).toISOString().slice(0, 16));
    if (u.includes('precipitation')) return { ok: true, status: 200, json: async () => ({ hourly: { time, precipitation: time.map(() => precipValue / 24) } }) };
    if (u.includes('temperature_2m')) return { ok: true, status: 200, json: async () => ({ hourly: { time, temperature_2m: time.map(() => tempValue) } }) };
    if (u.includes('soil_moisture_0_to_7cm')) return { ok: true, status: 200, json: async () => ({ hourly: { time, soil_moisture_0_to_7cm: time.map(() => soilValue) } }) };
    if (u.includes('soil_moisture_7_to_28cm')) return { ok: true, status: 200, json: async () => ({ hourly: { time, soil_moisture_7_to_28cm: time.map(() => soilValue) } }) };
    throw new Error(`URL inesperada: ${u}`);
  };
  fetchImpl.contarLlamadas = () => llamadas;
  return fetchImpl;
}

function buildFallaSiSeLlamaFetchImpl() {
  return async (url) => {
    throw new Error(`NUNCA debía llamarse al proveedor histórico -- caché válida existente (url: ${url})`);
  };
}

async function seedEscenarioAutogen(org, sufijo) {
  const predioId = await seedPredio(org, `Predio Sprint3D8R AUTOGEN-${sufijo}`);
  const potreroId = await seedPotrero(org, predioId, `Potrero Sprint3D8R AUTOGEN-${sufijo}`);
  const pasturaId = await fetchPasturaSistemaId('Brachiaria humidicola');
  const fichaId = await seedFicha(org, potreroId, pasturaId);
  await seedContexto(org, predioId, potreroId, { precipitacion7dMm: 8, precipitacion15dMm: 25, precipitacion30dMm: 45 });
  await seedRecomendacionPastoreo(org, predioId, potreroId, fichaId);
  return { predioId, potreroId };
}

// Function DECLARATION (hoisted) -- invocada DENTRO del describe exterior
// (arriba) para que su cleanup corra antes de que ese describe cierre
// adminPool en su propio `after`. `describe`/`test` anidados se registran
// igual que si estuvieran escritos inline en ese punto del archivo.
function describeAutogenTests() {
describe('SPRINT-3D8 (hardening operacional final) §11: auto-generación de climatología en preview/create -- tests A-H', { skip: !dbAvailable }, () => {
  after(async () => {
    if (!adminPool) return;
    await adminPool.query(`delete from agx.potrero_climatologias_agroclimaticas where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D8R AUTOGEN-%')`);
    await adminPool.query(`delete from agx.potrero_recomendaciones_descanso where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D8R AUTOGEN-%')`);
    await adminPool.query(`delete from agx.potrero_recomendaciones_pastoreo where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D8R AUTOGEN-%')`);
    await adminPool.query(`delete from agx.potrero_contextos_agroclimaticos where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D8R AUTOGEN-%')`);
    await adminPool.query(`delete from agx.potrero_ficha_pasturas where ficha_id in (select ficha_id from agx.potrero_fichas_productivas where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D8R AUTOGEN-%'))`);
    await adminPool.query(`delete from agx.potrero_fichas_productivas where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D8R AUTOGEN-%')`);
    await adminPool.query(`delete from agx.potreros where nombre like 'Potrero Sprint3D8R AUTOGEN-%'`);
    await adminPool.query(`delete from agx.predios where nombre_predio like 'Predio Sprint3D8R AUTOGEN-%'`);
  });

  test('§7 concurrencia: dos previews SIMULTÁNEOS del mismo potrero sin caché -> NUNCA generan climatología duplicada (advisory lock transaccional)', async () => {
    const org = randomOrgId();
    const { predioId, potreroId } = await seedEscenarioAutogen(org, 'CONCURRENCIA');
    const fetchImplA = buildAutoGenMockFetchImpl();
    const fetchImplB = buildAutoGenMockFetchImpl();

    const [previewA, previewB] = await Promise.all([
      repo.previewDescansoReentrada(org, predioId, potreroId, { fechaInicioPastoreo: '2026-09-01' }, { climatologyFetchImpl: fetchImplA }),
      repo.previewDescansoReentrada(org, predioId, potreroId, { fechaInicioPastoreo: '2026-09-01' }, { climatologyFetchImpl: fetchImplB }),
    ]);

    assert.equal(previewA.agroClimate.localClimatologyStatus, 'AVAILABLE');
    assert.equal(previewB.agroClimate.localClimatologyStatus, 'AVAILABLE');
    // Exactamente UNA de las dos transacciones generó -- la otra esperó el
    // advisory lock y reutilizó la caché recién comprometida (double-check).
    assert.equal(
      [previewA.climatologyGenerated, previewB.climatologyGenerated].filter(Boolean).length,
      1,
      'exactamente una de las dos transacciones concurrentes debe haber generado la climatología',
    );
    const conteo = await adminPool.query('select count(*) from agx.potrero_climatologias_agroclimaticas where potrero_id = $1', [potreroId]);
    assert.equal(Number(conteo.rows[0].count), 1, 'nunca debe quedar una climatología duplicada por una carrera de escritura');
  });

  test('SPRINT 3D8 (semantic final fix) test A: climatología RECIÉN generada vs. la MISMA climatología leída de caché -> IDÉNTICO nivelConfianza (nunca depende de climatologyGenerated)', async () => {
    const org = randomOrgId();
    const { predioId, potreroId } = await seedEscenarioAutogen(org, 'CONFIDENCE-CACHE');
    const fetchImpl = buildAutoGenMockFetchImpl();

    const previewGenerada = await repo.previewDescansoReentrada(org, predioId, potreroId, { fechaInicioPastoreo: '2026-09-01' }, { climatologyFetchImpl: fetchImpl });
    assert.equal(previewGenerada.climatologyGenerated, true);

    const previewDesdeCache = await repo.previewDescansoReentrada(org, predioId, potreroId, { fechaInicioPastoreo: '2026-09-01' }, { climatologyFetchImpl: buildFallaSiSeLlamaFetchImpl() });
    assert.equal(previewDesdeCache.climatologyGenerated, false);

    assert.equal(
      previewDesdeCache.nivelConfianza,
      previewGenerada.nivelConfianza,
      'newlyGenerated=true vs. loadedFromCache=true deben producir el MISMO nivel_confianza -- climatologyGenerated es un estado operacional/UX, nunca evidencia',
    );
    // Misma climatología subyacente en ambos casos (segunda llamada
    // reutilizó la caché, no generó una nueva) -- doble verificación de
    // que la comparación es realmente "misma evidencia".
    assert.equal(previewDesdeCache.agroClimate.status, previewGenerada.agroClimate.status);
    assert.equal(previewDesdeCache.agroClimate.localClimatologyStatus, previewGenerada.agroClimate.localClimatologyStatus);
  });

  test('A: preview SIN caché -> autogenera, PERSISTE la climatología y calcula el descanso en la MISMA respuesta', async () => {
    const org = randomOrgId();
    const { predioId, potreroId } = await seedEscenarioAutogen(org, 'A');
    const fetchImpl = buildAutoGenMockFetchImpl();

    const preview = await repo.previewDescansoReentrada(org, predioId, potreroId, { fechaInicioPastoreo: '2026-09-01' }, { climatologyFetchImpl: fetchImpl });

    assert.equal(preview.climatologyGenerated, true);
    assert.equal(preview.estado, 'READY');
    assert.equal(preview.agroClimate.localClimatologyStatus, 'AVAILABLE');
    assert.ok(fetchImpl.contarLlamadas() > 0, 'debe haber invocado al proveedor histórico');

    const conteo = await adminPool.query('select count(*) from agx.potrero_climatologias_agroclimaticas where potrero_id = $1', [potreroId]);
    assert.equal(Number(conteo.rows[0].count), 1, 'preview persiste la climatología generada, aunque preview NUNCA persista el descanso mismo');
  });

  test('B: preview CON caché válida -> NUNCA vuelve a llamar al proveedor histórico', async () => {
    const org = randomOrgId();
    const { predioId, potreroId } = await seedEscenarioAutogen(org, 'B');

    await repo.previewDescansoReentrada(org, predioId, potreroId, { fechaInicioPastoreo: '2026-09-01' }, { climatologyFetchImpl: buildAutoGenMockFetchImpl() });

    const segundo = await repo.previewDescansoReentrada(org, predioId, potreroId, { fechaInicioPastoreo: '2026-09-01' }, { climatologyFetchImpl: buildFallaSiSeLlamaFetchImpl() });

    assert.equal(segundo.climatologyGenerated, false);
    assert.equal(segundo.agroClimate.localClimatologyStatus, 'AVAILABLE');
    const conteo = await adminPool.query('select count(*) from agx.potrero_climatologias_agroclimaticas where potrero_id = $1', [potreroId]);
    assert.equal(Number(conteo.rows[0].count), 1, 'no debe duplicar la climatología ya cacheada');
  });

  test('C: create SIN preview previo es AUTOSUFICIENTE -- genera su propia climatología', async () => {
    const org = randomOrgId();
    const { predioId, potreroId } = await seedEscenarioAutogen(org, 'C');
    const fetchImpl = buildAutoGenMockFetchImpl();

    const descanso = await repo.createDescansoReentrada(org, predioId, potreroId, { fechaInicioPastoreo: '2026-09-01' }, { climatologyFetchImpl: fetchImpl });

    assert.equal(descanso.parametrosFuente.climatologyGenerated, true);
    assert.ok(fetchImpl.contarLlamadas() > 0);
    const conteo = await adminPool.query('select count(*) from agx.potrero_climatologias_agroclimaticas where potrero_id = $1', [potreroId]);
    assert.equal(Number(conteo.rows[0].count), 1);
  });

  test('D: segundo preview/create reutiliza la caché -- el proveedor NUNCA se vuelve a invocar', async () => {
    const org = randomOrgId();
    const { predioId, potreroId } = await seedEscenarioAutogen(org, 'D');

    await repo.createDescansoReentrada(org, predioId, potreroId, { fechaInicioPastoreo: '2026-09-01' }, { climatologyFetchImpl: buildAutoGenMockFetchImpl() });

    const segundoPreview = await repo.previewDescansoReentrada(org, predioId, potreroId, { fechaInicioPastoreo: '2026-09-01' }, { climatologyFetchImpl: buildFallaSiSeLlamaFetchImpl() });
    const segundoCreate = await repo.createDescansoReentrada(org, predioId, potreroId, { fechaInicioPastoreo: '2026-09-01' }, { climatologyFetchImpl: buildFallaSiSeLlamaFetchImpl() });

    assert.equal(segundoPreview.climatologyGenerated, false);
    assert.equal(segundoCreate.parametrosFuente.climatologyGenerated, false);
    const conteo = await adminPool.query('select count(*) from agx.potrero_climatologias_agroclimaticas where potrero_id = $1', [potreroId]);
    assert.equal(Number(conteo.rows[0].count), 1);
  });

  test('E: cambio de method_version -> crea una fila NUEVA de climatología, la anterior queda INTACTA', async () => {
    const org = randomOrgId();
    const { predioId, potreroId } = await seedEscenarioAutogen(org, 'E');

    // Simula una climatología calculada con un método/version ANTERIOR --
    // debe invalidarse (isClimatologyCacheValid compara method_version).
    await adminPool.query(
      `insert into agx.potrero_climatologias_agroclimaticas
         (organizacion_id, predio_id, potrero_id, period_start_year, period_end_year, method_version, monthly_statistics_json)
       values ($1, $2, $3, 1991, 2020, 'climatology-v0-obsoleta', '{}')`,
      [org, predioId, potreroId],
    );

    const preview = await repo.previewDescansoReentrada(org, predioId, potreroId, { fechaInicioPastoreo: '2026-09-01' }, { climatologyFetchImpl: buildAutoGenMockFetchImpl() });
    assert.equal(preview.climatologyGenerated, true, 'method_version obsoleto invalida la caché -- debe regenerar');

    const filas = await adminPool.query(
      `select method_version from agx.potrero_climatologias_agroclimaticas where potrero_id = $1 order by created_at asc`,
      [potreroId],
    );
    assert.equal(filas.rows.length, 2, 'append-only: la fila obsoleta NUNCA se sobrescribe ni se borra');
    assert.equal(filas.rows[0].method_version, 'climatology-v0-obsoleta', 'la fila anterior queda intacta');
    assert.notEqual(filas.rows[1].method_version, 'climatology-v0-obsoleta', 'la fila nueva usa el method_version vigente');
  });

  test('F: fallo PARCIAL del proveedor (una variable insuficiente) con cobertura suficiente en las demás -> el descanso se calcula igual', async () => {
    const org = randomOrgId();
    const { predioId, potreroId } = await seedEscenarioAutogen(org, 'F');

    let intentosTemp = 0;
    const fetchImpl = async (url) => {
      const u = String(url);
      const year = Number(u.match(/start_date=(\d{4})/)[1]);
      const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
      const hoursInYear = (isLeap ? 366 : 365) * 24;
      const time = [];
      const base = Date.UTC(year, 0, 1, 0, 0, 0);
      for (let i = 0; i < hoursInYear; i += 1) time.push(new Date(base + i * 3600 * 1000).toISOString().slice(0, 16));
      if (u.includes('temperature_2m')) {
        intentosTemp += 1;
        if (intentosTemp > 3) return { ok: false, status: 503, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => ({ hourly: { time, temperature_2m: time.map(() => 24) } }) };
      }
      if (u.includes('precipitation')) return { ok: true, status: 200, json: async () => ({ hourly: { time, precipitation: time.map(() => 5 / 24) } }) };
      if (u.includes('soil_moisture_0_to_7cm')) return { ok: true, status: 200, json: async () => ({ hourly: { time, soil_moisture_0_to_7cm: time.map(() => 0.28) } }) };
      if (u.includes('soil_moisture_7_to_28cm')) return { ok: true, status: 200, json: async () => ({ hourly: { time, soil_moisture_7_to_28cm: time.map(() => 0.28) } }) };
      throw new Error(`URL inesperada: ${u}`);
    };

    const preview = await repo.previewDescansoReentrada(org, predioId, potreroId, { fechaInicioPastoreo: '2026-09-01' }, { climatologyFetchImpl: fetchImpl });

    assert.equal(preview.climatologyGenerated, true);
    assert.equal(preview.estado, 'READY');
    assert.equal(preview.agroClimate.localClimatologyStatus, 'AVAILABLE', 'precipitación/suelo con cobertura completa alcanzan para clasificar');
  });

  test('G: cobertura CERO en las 4 variables -> INSUFFICIENT_LOCAL_CLIMATOLOGY, NUNCA fabrica percentiles', async () => {
    const org = randomOrgId();
    const { predioId, potreroId } = await seedEscenarioAutogen(org, 'G');

    const preview = await repo.previewDescansoReentrada(org, predioId, potreroId, { fechaInicioPastoreo: '2026-09-01' }, { climatologyFetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }) });

    assert.equal(preview.climatologyGenerated, false, 'el intento se hizo, pero el proveedor no devolvió cobertura utilizable');
    assert.equal(preview.agroClimate.localClimatologyStatus, 'INSUFFICIENT_LOCAL_CLIMATOLOGY');
    const conteo = await adminPool.query('select count(*) from agx.potrero_climatologias_agroclimaticas where potrero_id = $1', [potreroId]);
    assert.equal(Number(conteo.rows[0].count), 0, 'un fallo total NUNCA persiste una climatología vacía');
  });

  test('H: GET (lectura de descanso) NUNCA dispara la obtención histórica -- sigue siendo estrictamente read-only', async () => {
    const org = randomOrgId();
    const { predioId, potreroId } = await seedEscenarioAutogen(org, 'H');

    const resultado = await repo.getDescansoReentradaByPotrero(org, predioId, potreroId);

    assert.deepEqual(resultado, { actual: null, historial: [] });
    const conteo = await adminPool.query('select count(*) from agx.potrero_climatologias_agroclimaticas where potrero_id = $1', [potreroId]);
    assert.equal(Number(conteo.rows[0].count), 0, 'GET jamás genera climatología -- getDescansoReentradaByPotrero no acepta climatologyFetchImpl ni invoca resolveDescanso');
  });
});
}
