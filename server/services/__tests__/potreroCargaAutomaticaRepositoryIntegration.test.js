// SPRINT-3D10.4 FASE 3: pruebas del servicio/orquestador del motor
// automático (potreroCargaAutomaticaRepository.js) contra un Postgres/
// PostGIS REAL. Cubre: preview/escenario sin escritura, guardar append-only
// solo si estado=OK, protección stale-preview, aislamiento tenant,
// PLAN≠REAL, política de pastura, forraje insuficiente, y los dos motivos
// de duración (TARGET_3_DAYS/FALLBACK_MIN_2_DAYS).
//
// Lee EXCLUSIVAMENTE AGX_BUSINESS_DATABASE_URL_TEST. Ver
// db/agx-business/migrations/README.md.
delete process.env.AGX_BUSINESS_DATABASE_URL;

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import pg from 'pg';

let dbAvailable = false;
let adminPool;
let repo;
let cicloRepo;
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

  const columnCheck = await adminPool.query(
    `select column_name from information_schema.columns
      where table_schema = 'agx' and table_name = 'potrero_recomendaciones_pastoreo' and column_name = 'modo_calculo'`,
  );
  dbAvailable = columnCheck.rows.length > 0;
} catch {
  dbAvailable = false;
}

if (dbAvailable) {
  repo = await import('../ganaderia/potreroCargaAutomaticaRepository.js');
  cicloRepo = await import('../ganaderia/potreroCicloPastoreoRepository.js');
  businessDb = await import('../../db/agxBusinessPool.js');
}

const SIN_RED_FETCH_IMPL = async () => ({ ok: false, status: 503, json: async () => ({}) });

function randomOrgId() {
  return crypto.randomUUID();
}

const SQUARE_WKT = 'POLYGON((-75.5 1.3, -75.4 1.3, -75.4 1.4, -75.5 1.4, -75.5 1.3))';

async function seedPredio(orgId, nombre) {
  const result = await adminPool.query('insert into agx.predios (organizacion_id, nombre_predio) values ($1, $2) returning predio_id', [orgId, nombre]);
  return result.rows[0].predio_id;
}

async function seedPotrero(orgId, predioId, nombre) {
  const result = await adminPool.query(
    `insert into agx.potreros (organizacion_id, predio_id, nombre, geometry, area_ha, metodo_delimitacion)
     values ($1, $2, $3, ST_GeomFromText($4, 4326), 1, 'coordenadas') returning potrero_id`,
    [orgId, predioId, nombre, SQUARE_WKT],
  );
  return result.rows[0].potrero_id;
}

async function fetchPasturaSistemaId(nombreComun) {
  const result = await adminPool.query(`select pastura_id from agx.catalogo_pasturas where alcance = 'sistema' and nombre_comun = $1`, [nombreComun]);
  return result.rows[0]?.pastura_id;
}

async function seedPasturaPersonalizada(orgId, nombre, tipo = 'graminea') {
  const result = await adminPool.query(
    `insert into agx.catalogo_pasturas (organizacion_id, nombre_comun, tipo, alcance) values ($1, $2, $3, 'personalizado') returning pastura_id`,
    [orgId, nombre, tipo],
  );
  return result.rows[0].pastura_id;
}

async function seedFicha(orgId, potreroId, pasturaId, { biomasaTotalKg = 5000, fechaAforo } = {}) {
  const usaDefault = fechaAforo === undefined;
  const fichaResult = await adminPool.query(
    usaDefault
      ? `insert into agx.potrero_fichas_productivas (organizacion_id, potrero_id, tipo_cobertura, nombre_principal, aforo_promedio_g_m2, fecha_aforo, biomasa_total_kg)
         values ($1, $2, 'pastura', 'Pastura Test', 500, current_date, $3) returning ficha_id`
      : `insert into agx.potrero_fichas_productivas (organizacion_id, potrero_id, tipo_cobertura, nombre_principal, aforo_promedio_g_m2, fecha_aforo, biomasa_total_kg)
         values ($1, $2, 'pastura', 'Pastura Test', 500, $3, $4) returning ficha_id`,
    usaDefault ? [orgId, potreroId, biomasaTotalKg] : [orgId, potreroId, fechaAforo, biomasaTotalKg],
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

async function seedRecomendacionPastoreoRaw(org, predioId, potreroId, fichaId) {
  const categoriaId = await fetchCategoriaId('novillo_ceba');
  const result = await adminPool.query(
    `insert into agx.potrero_recomendaciones_pastoreo
       (organizacion_id, predio_id, potrero_id, ficha_id, categoria_id, numero_animales, peso_promedio_kg,
        materia_seca_pct_aplicada, utilizacion_pct_aplicada, consumo_pct_pv_aplicado,
        materia_seca_total_kg, materia_seca_utilizable_kg, demanda_diaria_lote_kg_ms, dias_ocupacion_estimados,
        nivel_confianza, motor_version)
     values ($1, $2, $3, $4, $5, 10, 420, 20, 50, 2.4, 1000, 500, 100.8, 5, 'MEDIA', 'pastoreo-auto-v1')
     returning recomendacion_id`,
    [org, predioId, potreroId, fichaId, categoriaId],
  );
  return result.rows[0].recomendacion_id;
}

async function seedCicloFinalizado(org, predioId, potreroId, { ingresoAt, salidaAt }) {
  const ciclo = await cicloRepo.iniciarCicloPastoreo(org, predioId, potreroId, { now: ingresoAt });
  await cicloRepo.finalizarCicloPastoreo(org, predioId, potreroId, ciclo.cicloId, { now: salidaAt, climatologyFetchImpl: SIN_RED_FETCH_IMPL });
  return ciclo.cicloId;
}

async function countRecomendaciones(potreroId) {
  const r = await adminPool.query('select count(*) from agx.potrero_recomendaciones_pastoreo where potrero_id = $1', [potreroId]);
  return Number(r.rows[0].count);
}

const INPUT_BASE = { categoriaCodigo: 'novillo_ceba', pesoPromedioKg: 420, fechaIngresoPrevista: '2026-09-10' };

async function seedEscenarioHumidicola(org, sufijo, { biomasaTotalKg = 5000 } = {}) {
  const predioId = await seedPredio(org, `Predio Sprint3D104P3 ${sufijo}`);
  const potreroId = await seedPotrero(org, predioId, `Potrero Sprint3D104P3 ${sufijo}`);
  const pasturaId = await fetchPasturaSistemaId('Brachiaria humidicola');
  const fichaId = await seedFicha(org, potreroId, pasturaId, { biomasaTotalKg });
  return { predioId, potreroId, pasturaId, fichaId };
}

describe('SPRINT-3D10.4 FASE 3: potreroCargaAutomaticaRepository contra Postgres-AGX-Business real', { skip: !dbAvailable }, () => {
  // Constantes de %MS/%utilización/DI aplicadas para humidicola + novillo_ceba
  // sin contexto agroclimático -- descubiertas dinámicamente (sección
  // `before`) en vez de asumidas a ciegas, para no depender de un valor
  // hardcodeado que pudiera no coincidir exactamente con el motor real.
  let msuPorKgBiomasa;
  let demandaIndividualKgMsDia;

  before(async () => {
    if (!dbAvailable) return;
    const org = randomOrgId();
    const { predioId, potreroId } = await seedEscenarioHumidicola(org, 'DESCUBRIMIENTO', { biomasaTotalKg: 5000 });
    const preview = await repo.previewCargaAutomatica(org, predioId, potreroId, INPUT_BASE);
    assert.equal(preview.estado, 'OK', 'la corrida de descubrimiento debía resolver OK');
    const { materiaSecaPctAplicada, utilizacionPctAplicada } = preview.detalleTecnico;
    msuPorKgBiomasa = (materiaSecaPctAplicada / 100) * (utilizacionPctAplicada / 100);
    demandaIndividualKgMsDia = preview.detalleTecnico.demandaIndividualKgMsDia;
  });

  after(async () => {
    if (!adminPool) return;
    await adminPool.query(`update agx.potrero_recomendaciones_descanso set ciclo_pastoreo_id = null where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D104P3%')`);
    await adminPool.query(`update agx.potrero_ciclos_pastoreo set recomendacion_descanso_plan_id = null where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D104P3%')`);
    await adminPool.query(`update agx.potrero_recomendaciones_descanso set lote_real_version_id = null where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D104P3%')`);
    await adminPool.query(`delete from agx.potrero_ciclo_lote_real_invalidaciones where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D104P3%')`);
    await adminPool.query(`delete from agx.potrero_ciclo_lote_real_versiones where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D104P3%')`);
    await adminPool.query(`delete from agx.potrero_ciclo_eventos where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D104P3%')`);
    await adminPool.query(`delete from agx.potrero_ciclos_pastoreo where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D104P3%')`);
    await adminPool.query(`delete from agx.potrero_recomendaciones_descanso where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D104P3%')`);
    await adminPool.query(`delete from agx.potrero_recomendaciones_pastoreo where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D104P3%')`);
    await adminPool.query(`delete from agx.potrero_ficha_pasturas where ficha_id in (select ficha_id from agx.potrero_fichas_productivas where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D104P3%'))`);
    await adminPool.query(`delete from agx.potrero_fichas_productivas where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D104P3%')`);
    await adminPool.query(`delete from agx.catalogo_pasturas where nombre_comun like 'Pastura Sprint3D104P3%'`);
    await adminPool.query(`delete from agx.potreros where nombre like 'Potrero Sprint3D104P3%'`);
    await adminPool.query(`delete from agx.predios where nombre_predio like 'Predio Sprint3D104P3%'`);
    if (businessDb) await businessDb.closeAgxBusinessPool();
    await adminPool.end();
  });

  // -----------------------------------------------------------------------
  // §21 -- pruebas de no-escritura / escritura exacta.
  // -----------------------------------------------------------------------

  test('§21: preview y escenario NUNCA persisten; guardar OK persiste exactamente 1 fila', async () => {
    const org = randomOrgId();
    const { predioId, potreroId } = await seedEscenarioHumidicola(org, 'NOWRITE-OK', { biomasaTotalKg: 5000 });

    const antes = await countRecomendaciones(potreroId);
    await repo.previewCargaAutomatica(org, predioId, potreroId, INPUT_BASE);
    assert.equal(await countRecomendaciones(potreroId), antes, 'preview no debe insertar');

    await repo.evaluarEscenarioCargaAutomatica(org, predioId, potreroId, { ...INPUT_BASE, numeroAnimalesUsuario: 15 });
    assert.equal(await countRecomendaciones(potreroId), antes, 'escenario no debe insertar');

    const guardado = await repo.guardarCargaAutomatica(org, predioId, potreroId, INPUT_BASE);
    assert.equal(guardado.estado, 'OK');
    assert.equal(await countRecomendaciones(potreroId), antes + 1, 'guardar OK debe insertar exactamente 1 fila');
  });

  test('§21: guardar con forraje insuficiente NO persiste (count sin cambio)', async () => {
    const org = randomOrgId();
    const { predioId, potreroId } = await seedEscenarioHumidicola(org, 'NOWRITE-INSUF', { biomasaTotalKg: 0.5 });

    const antes = await countRecomendaciones(potreroId);
    const guardado = await repo.guardarCargaAutomatica(org, predioId, potreroId, INPUT_BASE);
    assert.equal(guardado.estado, 'NO_RECOMMENDATION_INSUFFICIENT_FORAGE');
    assert.equal(await countRecomendaciones(potreroId), antes);
  });

  test('§21/§4: guardar sobre pastura sin política definida (leguminosa) -> 200 PASTURA_SIN_POLITICA_DEFINIDA, NO persiste', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D104P3 LEGUMINOSA');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D104P3 LEGUMINOSA');
    const pasturaId = await fetchPasturaSistemaId('Maní forrajero');
    await seedFicha(org, potreroId, pasturaId, { biomasaTotalKg: 5000 });

    const antes = await countRecomendaciones(potreroId);
    const preview = await repo.previewCargaAutomatica(org, predioId, potreroId, INPUT_BASE);
    assert.equal(preview.estado, 'PASTURA_SIN_POLITICA_DEFINIDA');
    const guardado = await repo.guardarCargaAutomatica(org, predioId, potreroId, INPUT_BASE);
    assert.equal(guardado.estado, 'PASTURA_SIN_POLITICA_DEFINIDA');
    assert.equal(await countRecomendaciones(potreroId), antes);
  });

  // -----------------------------------------------------------------------
  // §9 -- stale preview.
  // -----------------------------------------------------------------------

  test('§9: preview con ficha A, se registra ficha B, guardar persiste con ficha B (recálculo real, nunca el resultado del preview)', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D104P3 STALE');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D104P3 STALE');
    const pasturaId = await fetchPasturaSistemaId('Brachiaria humidicola');
    const fichaA = await seedFicha(org, potreroId, pasturaId, { biomasaTotalKg: 4000, fechaAforo: '2026-08-01' });

    const preview = await repo.previewCargaAutomatica(org, predioId, potreroId, INPUT_BASE);
    assert.equal(preview.estado, 'OK');
    assert.equal(preview.detalleTecnico.ficha.fichaId, String(fichaA));

    // Ficha B, posterior, biomasa DISTINTA -- simula que apareció después del preview.
    const fichaB = await seedFicha(org, potreroId, pasturaId, { biomasaTotalKg: 9000, fechaAforo: '2026-08-05' });

    const guardado = await repo.guardarCargaAutomatica(org, predioId, potreroId, INPUT_BASE);
    assert.equal(guardado.estado, 'OK');
    assert.equal(guardado.recomendacion.fichaId, String(fichaB), 'debe persistir con la ficha B, nunca con la A del preview');

    const fila = await adminPool.query('select ficha_id, materia_seca_total_kg from agx.potrero_recomendaciones_pastoreo where recomendacion_id = $1', [guardado.recomendacion.recomendacionId]);
    assert.equal(String(fila.rows[0].ficha_id), String(fichaB));
    // La biomasa persistida debe corresponder a B (9000), nunca a A (4000).
    assert.notEqual(Number(fila.rows[0].materia_seca_total_kg), 0);
  });

  // -----------------------------------------------------------------------
  // §22 -- aislamiento tenant.
  // -----------------------------------------------------------------------

  test('§22: ORG B no puede preview/escenario/guardar sobre potrero de ORG A', async () => {
    const orgA = randomOrgId();
    const orgB = randomOrgId();
    const { predioId, potreroId } = await seedEscenarioHumidicola(orgA, 'TENANT');

    await assert.rejects(
      () => repo.previewCargaAutomatica(orgB, predioId, potreroId, INPUT_BASE),
      (e) => e.status === 404 && e.code === 'POTRERO_NOT_FOUND',
    );
    await assert.rejects(
      () => repo.evaluarEscenarioCargaAutomatica(orgB, predioId, potreroId, { ...INPUT_BASE, numeroAnimalesUsuario: 10 }),
      (e) => e.status === 404 && e.code === 'POTRERO_NOT_FOUND',
    );
    await assert.rejects(
      () => repo.guardarCargaAutomatica(orgB, predioId, potreroId, INPUT_BASE),
      (e) => e.status === 404 && e.code === 'POTRERO_NOT_FOUND',
    );
  });

  // -----------------------------------------------------------------------
  // Precondición de aforo -- misma semántica HTTP aprobada (3D10.4 Fase 1).
  // -----------------------------------------------------------------------

  test('sin ficha productiva -> INSUFFICIENT_FORAGE_DATA (404)', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D104P3 NOFICHA');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D104P3 NOFICHA');

    await assert.rejects(
      () => repo.previewCargaAutomatica(org, predioId, potreroId, INPUT_BASE),
      (e) => e.status === 404 && e.code === 'INSUFFICIENT_FORAGE_DATA',
    );
  });

  test('aforo anterior al último pastoreo real -> INSUFFICIENT_FORAGE_DATA (404) -- usa resolveFichaVigente de Fase 1, sin SQL propio', async () => {
    const org = randomOrgId();
    const predioId = await seedPredio(org, 'Predio Sprint3D104P3 AFOROVIEJO');
    const potreroId = await seedPotrero(org, predioId, 'Potrero Sprint3D104P3 AFOROVIEJO');
    const pasturaId = await fetchPasturaSistemaId('Brachiaria humidicola');
    const fichaVieja = await seedFicha(org, potreroId, pasturaId, { fechaAforo: '2025-12-01' });
    await seedRecomendacionPastoreoRaw(org, predioId, potreroId, fichaVieja);
    await seedCicloFinalizado(org, predioId, potreroId, { ingresoAt: new Date('2026-01-02T10:00:00Z'), salidaAt: new Date('2026-01-20T16:00:00Z') });

    await assert.rejects(
      () => repo.previewCargaAutomatica(org, predioId, potreroId, INPUT_BASE),
      (e) => e.status === 404 && e.code === 'INSUFFICIENT_FORAGE_DATA',
    );
  });

  // -----------------------------------------------------------------------
  // Resultados OK -- TARGET_3_DAYS y FALLBACK_MIN_2_DAYS, construidos a
  // partir de las constantes descubiertas en `before`.
  // -----------------------------------------------------------------------

  test('OK, motivoDuracion=TARGET_3_DAYS: biomasa generosa -> 3 días, fechaSalidaEstimada = +3 días calendario', async () => {
    // N_raw_3d objetivo = 5 (bien dentro de la rama target).
    const msuObjetivo = 5 * demandaIndividualKgMsDia * 3;
    const biomasaTotalKg = msuObjetivo / msuPorKgBiomasa;
    const org = randomOrgId();
    const { predioId, potreroId } = await seedEscenarioHumidicola(org, 'TARGET3', { biomasaTotalKg });

    const preview = await repo.previewCargaAutomatica(org, predioId, potreroId, INPUT_BASE);
    assert.equal(preview.estado, 'OK');
    assert.equal(preview.diasPermanenciaRecomendada, 3);
    assert.equal(preview.detalleTecnico.motivoDuracion, 'TARGET_3_DAYS');
    assert.equal(preview.fechaSalidaEstimada, '2026-09-13');
    assert.ok(preview.numeroAnimalesRecomendado >= 1);

    const guardado = await repo.guardarCargaAutomatica(org, predioId, potreroId, INPUT_BASE);
    assert.equal(guardado.estado, 'OK');
    assert.equal(guardado.recomendacion.diasPermanenciaRecomendada, 3);
    assert.equal(guardado.recomendacion.motivoDuracion, 'TARGET_3_DAYS');
    assert.equal(guardado.recomendacion.fechaSalidaEstimada, '2026-09-13');
    // Regresión: fecha_ingreso_prevista debe volver como string 'YYYY-MM-DD'
    // puro, nunca un objeto Date del driver pg (evita drift de timezone).
    assert.equal(typeof guardado.recomendacion.fechaIngresoPrevista, 'string');
    assert.equal(guardado.recomendacion.fechaIngresoPrevista, '2026-09-10');

    const fila = await adminPool.query(
      `select modo_calculo, dias_permanencia_recomendada, motivo_duracion,
              to_char(fecha_ingreso_prevista, 'YYYY-MM-DD') as fecha_ingreso_prevista,
              occupation_policy_version, numero_animales
         from agx.potrero_recomendaciones_pastoreo where recomendacion_id = $1`,
      [guardado.recomendacion.recomendacionId],
    );
    assert.equal(fila.rows[0].modo_calculo, 'AUTOMATICO');
    assert.equal(fila.rows[0].dias_permanencia_recomendada, 3);
    assert.equal(fila.rows[0].motivo_duracion, 'TARGET_3_DAYS');
    assert.equal(fila.rows[0].fecha_ingreso_prevista, '2026-09-10');
    assert.equal(Number(fila.rows[0].numero_animales), guardado.recomendacion.numeroAnimalesRecomendado);
  });

  test('OK, motivoDuracion=FALLBACK_MIN_2_DAYS: biomasa escasa (target no alcanza, mínimo sí) -> 2 días', async () => {
    // N_raw_3d objetivo = 0.9 (target falla, floor(0.9)=0) pero N_raw_2d = 0.9*3/2=1.35 (fallback floor=1 alcanza).
    const msuObjetivo = 0.9 * demandaIndividualKgMsDia * 3;
    const biomasaTotalKg = msuObjetivo / msuPorKgBiomasa;
    const org = randomOrgId();
    const { predioId, potreroId } = await seedEscenarioHumidicola(org, 'FALLBACK2', { biomasaTotalKg });

    const preview = await repo.previewCargaAutomatica(org, predioId, potreroId, INPUT_BASE);
    assert.equal(preview.estado, 'OK', `esperaba OK/fallback -- detalle: ${JSON.stringify(preview)}`);
    assert.equal(preview.diasPermanenciaRecomendada, 2);
    assert.equal(preview.detalleTecnico.motivoDuracion, 'FALLBACK_MIN_2_DAYS');
    assert.equal(preview.numeroAnimalesRecomendado, 1);
    assert.equal(preview.fechaSalidaEstimada, '2026-09-12');

    const guardado = await repo.guardarCargaAutomatica(org, predioId, potreroId, INPUT_BASE);
    assert.equal(guardado.recomendacion.diasPermanenciaRecomendada, 2);
    assert.equal(guardado.recomendacion.motivoDuracion, 'FALLBACK_MIN_2_DAYS');
  });

  // -----------------------------------------------------------------------
  // Override (escenario) -- target/minimum/insufficient, vía HTTP-layer real.
  // -----------------------------------------------------------------------

  test('escenario TARGET_COMPATIBLE: pocos animales sobre biomasa generosa -> 3 días, confirmable', async () => {
    const org = randomOrgId();
    const { predioId, potreroId } = await seedEscenarioHumidicola(org, 'ESC-TARGET', { biomasaTotalKg: 5000 });

    const escenario = await repo.evaluarEscenarioCargaAutomatica(org, predioId, potreroId, { ...INPUT_BASE, numeroAnimalesUsuario: 5 });
    assert.equal(escenario.estado, 'TARGET_COMPATIBLE');
    assert.equal(escenario.diasPermanenciaEscenario, 3);
    assert.equal(escenario.confirmable, true);
    assert.equal(escenario.fechaSalidaEstimada, '2026-09-13');
  });

  test('escenario MINIMUM_COMPATIBLE: muchos animales -> 2 días, confirmable', async () => {
    // maximo objetivo = 2.5 -> N_usuario = MSU/(DI*2.5).
    const msuDisponible = 5000 * msuPorKgBiomasa;
    const nUsuario = Math.floor(msuDisponible / (demandaIndividualKgMsDia * 2.5));
    const org = randomOrgId();
    const { predioId, potreroId } = await seedEscenarioHumidicola(org, 'ESC-MIN', { biomasaTotalKg: 5000 });

    const escenario = await repo.evaluarEscenarioCargaAutomatica(org, predioId, potreroId, { ...INPUT_BASE, numeroAnimalesUsuario: nUsuario });
    assert.equal(escenario.estado, 'MINIMUM_COMPATIBLE');
    assert.equal(escenario.diasPermanenciaEscenario, 2);
    assert.equal(escenario.confirmable, true);
    assert.equal(escenario.fechaSalidaEstimada, '2026-09-12');
  });

  test('escenario INSUFFICIENT_FORAGE: animales excesivos -> no confirmable, sin fecha de salida', async () => {
    const org = randomOrgId();
    const { predioId, potreroId } = await seedEscenarioHumidicola(org, 'ESC-INSUF', { biomasaTotalKg: 100 });

    const escenario = await repo.evaluarEscenarioCargaAutomatica(org, predioId, potreroId, { ...INPUT_BASE, numeroAnimalesUsuario: 1000 });
    assert.equal(escenario.estado, 'INSUFFICIENT_FORAGE');
    assert.equal(escenario.diasPermanenciaEscenario, null);
    assert.equal(escenario.confirmable, false);
    assert.equal(escenario.fechaSalidaEstimada, null);
  });

  test('escenario con maximo=7.5 (biomasa/animal generosa) -> EXACTAMENTE 3 días, nunca 7 ni advertencia de ocupación prolongada', async () => {
    // Elegimos N_usuario tal que maximo ~ 7.5 (MSU/(DI*N)=7.5 -> N=MSU/(DI*7.5)).
    const msuDisponible = 5000 * msuPorKgBiomasa;
    const nUsuario = Math.max(1, Math.floor(msuDisponible / (demandaIndividualKgMsDia * 7.5)));
    const org = randomOrgId();
    const { predioId, potreroId } = await seedEscenarioHumidicola(org, 'ESC-75', { biomasaTotalKg: 5000 });

    const escenario = await repo.evaluarEscenarioCargaAutomatica(org, predioId, potreroId, { ...INPUT_BASE, numeroAnimalesUsuario: nUsuario });
    assert.equal(escenario.estado, 'TARGET_COMPATIBLE');
    assert.equal(escenario.diasPermanenciaEscenario, 3);
    assert.notEqual(escenario.diasPermanenciaEscenario, 7);
    assert.ok(!('advertencia' in escenario));
  });

  // -----------------------------------------------------------------------
  // §20 -- PLAN ≠ REAL.
  // -----------------------------------------------------------------------

  test('§20: guardar auto + iniciar SIN override -> numero_animales_real = N recomendado, recomendacion_pastoreo_id apunta a esa fila automática', async () => {
    const msuObjetivo = 5 * demandaIndividualKgMsDia * 3;
    const biomasaTotalKg = msuObjetivo / msuPorKgBiomasa;
    const org = randomOrgId();
    const { predioId, potreroId } = await seedEscenarioHumidicola(org, 'PLANREAL-SIN', { biomasaTotalKg });

    const guardado = await repo.guardarCargaAutomatica(org, predioId, potreroId, INPUT_BASE);
    assert.equal(guardado.estado, 'OK');
    const nRecomendado = guardado.recomendacion.numeroAnimalesRecomendado;

    const ciclo = await cicloRepo.iniciarCicloPastoreo(org, predioId, potreroId, {});
    assert.equal(ciclo.numeroAnimalesReal, nRecomendado);
    assert.equal(ciclo.recomendacionPastoreoId, guardado.recomendacion.recomendacionId);

    const filaModo = await adminPool.query('select modo_calculo from agx.potrero_recomendaciones_pastoreo where recomendacion_id = $1', [guardado.recomendacion.recomendacionId]);
    assert.equal(filaModo.rows[0].modo_calculo, 'AUTOMATICO');
  });

  test('§20: guardar auto (N=recomendado) + iniciar CON override (numeroAnimales distinto) -> numero_animales_real=override, recomendacion_pastoreo_id sigue apuntando a la automática original', async () => {
    const msuObjetivo = 5 * demandaIndividualKgMsDia * 3;
    const biomasaTotalKg = msuObjetivo / msuPorKgBiomasa;
    const org = randomOrgId();
    const { predioId, potreroId } = await seedEscenarioHumidicola(org, 'PLANREAL-CON', { biomasaTotalKg });

    const guardado = await repo.guardarCargaAutomatica(org, predioId, potreroId, INPUT_BASE);
    assert.equal(guardado.estado, 'OK');
    const nRecomendado = guardado.recomendacion.numeroAnimalesRecomendado;
    const nOverride = nRecomendado + 5; // deliberadamente distinto del recomendado

    const ciclo = await cicloRepo.iniciarCicloPastoreo(org, predioId, potreroId, { numeroAnimales: nOverride });
    assert.notEqual(nOverride, nRecomendado);
    assert.equal(ciclo.numeroAnimalesReal, nOverride, 'el hecho real debe reflejar el override, nunca el recomendado');
    assert.equal(ciclo.recomendacionPastoreoId, guardado.recomendacion.recomendacionId, 'el vínculo PLAN debe seguir apuntando a la recomendación automática original, sin fingir que el override fue lo recomendado');
  });
});
