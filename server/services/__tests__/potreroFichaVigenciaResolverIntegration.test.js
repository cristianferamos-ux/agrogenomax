// SPRINT-3D10.4 -- AUTORIDAD UNICA DE VIGENCIA DE AFORO: pruebas de
// resolveFichaVigente (server/services/ganaderia/potreroFichaVigenciaResolver.js)
// contra un Postgres/PostGIS REAL. Mismo patrón que
// potreroCicloPastoreoRepositoryIntegration.test.js (reutiliza
// iniciarCicloPastoreo/finalizarCicloPastoreo/cancelarCicloPastoreo ya
// probados para sembrar ciclos reales -- nunca reinventa el ciclo de vida).
//
// Cubre 3D10.3.1 §C/§D/§E: fecha_aforo (DATE) es el único hecho físico;
// created_at nunca "rescata" una fecha_aforo anterior o igual a la
// frontera; el mismo día de la salida NO es válido; CANCELADO/EN_CURSO
// nunca establecen frontera.
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
let resolver;
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

  const tableCheck = await adminPool.query("select to_regclass('agx.potrero_ciclos_pastoreo') as t");
  dbAvailable = Boolean(tableCheck.rows[0]?.t);
} catch {
  dbAvailable = false;
}

if (dbAvailable) {
  resolver = await import('../ganaderia/potreroFichaVigenciaResolver.js');
  cicloRepo = await import('../ganaderia/potreroCicloPastoreoRepository.js');
  businessDb = await import('../../db/agxBusinessPool.js');
}

// FASE B de finalizar nunca depende de la red real en tests -- mismo patrón
// que potreroCicloPastoreoRepositoryIntegration.test.js. Un descanso
// PENDIENTE/ERROR_TECNICO no afecta a resolveFichaVigente (que solo lee
// fecha_salida_real de potrero_ciclos_pastoreo, nunca el descanso).
const SIN_RED_FETCH_IMPL = async () => ({ ok: false, status: 503, json: async () => ({}) });

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

async function fetchPasturaSistemaId(nombreComun) {
  const result = await adminPool.query(`select pastura_id from agx.catalogo_pasturas where alcance = 'sistema' and nombre_comun = $1`, [nombreComun]);
  return result.rows[0]?.pastura_id;
}

// fechaAforo === undefined -> current_date (comportamiento por defecto de
// los tests). fechaAforo === null -> ficha SIN fecha de aforo (casos I/J).
// Cualquier otro valor -> fecha explícita (string 'YYYY-MM-DD').
async function seedFicha(orgId, potreroId, pasturaId, { biomasaTotalKg = 5000, fechaAforo } = {}) {
  const usaDefault = fechaAforo === undefined;
  const fichaResult = await adminPool.query(
    usaDefault
      ? `insert into agx.potrero_fichas_productivas
           (organizacion_id, potrero_id, tipo_cobertura, nombre_principal, aforo_promedio_g_m2, fecha_aforo, biomasa_total_kg)
         values ($1, $2, 'pastura', 'Pastura Test', 500, current_date, $3)
         returning ficha_id`
      : `insert into agx.potrero_fichas_productivas
           (organizacion_id, potrero_id, tipo_cobertura, nombre_principal, aforo_promedio_g_m2, fecha_aforo, biomasa_total_kg)
         values ($1, $2, 'pastura', 'Pastura Test', 500, $3, $4)
         returning ficha_id`,
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

/** Ciclo FINALIZADO real (iniciar+finalizar ya probados) con fechas controladas. */
async function seedCicloFinalizado(org, predioId, potreroId, { ingresoAt, salidaAt }) {
  const ciclo = await cicloRepo.iniciarCicloPastoreo(org, predioId, potreroId, { now: ingresoAt });
  await cicloRepo.finalizarCicloPastoreo(org, predioId, potreroId, ciclo.cicloId, {
    now: salidaAt, climatologyFetchImpl: SIN_RED_FETCH_IMPL,
  });
  return ciclo.cicloId;
}

async function seedEscenarioBase(org, sufijo) {
  const predioId = await seedPredio(org, `Predio Sprint3D104R ${sufijo}`);
  const potreroId = await seedPotrero(org, predioId, `Potrero Sprint3D104R ${sufijo}`);
  const pasturaId = await fetchPasturaSistemaId('Brachiaria humidicola');
  return { predioId, potreroId, pasturaId };
}

describe('SPRINT-3D10.4: resolveFichaVigente contra Postgres-AGX-Business real', { skip: !dbAvailable }, () => {
  after(async () => {
    if (!adminPool) return;
    await adminPool.query(`update agx.potrero_recomendaciones_descanso set ciclo_pastoreo_id = null where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D104R%')`);
    await adminPool.query(`update agx.potrero_ciclos_pastoreo set recomendacion_descanso_plan_id = null where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D104R%')`);
    await adminPool.query(`update agx.potrero_recomendaciones_descanso set lote_real_version_id = null where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D104R%')`);
    await adminPool.query(`delete from agx.potrero_ciclo_lote_real_invalidaciones where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D104R%')`);
    await adminPool.query(`delete from agx.potrero_ciclo_lote_real_versiones where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D104R%')`);
    await adminPool.query(`delete from agx.potrero_ciclo_eventos where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D104R%')`);
    await adminPool.query(`delete from agx.potrero_ciclos_pastoreo where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D104R%')`);
    await adminPool.query(`delete from agx.potrero_recomendaciones_descanso where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D104R%')`);
    await adminPool.query(`delete from agx.potrero_recomendaciones_pastoreo where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D104R%')`);
    await adminPool.query(`delete from agx.potrero_ficha_pasturas where ficha_id in (select ficha_id from agx.potrero_fichas_productivas where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D104R%'))`);
    await adminPool.query(`delete from agx.potrero_fichas_productivas where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D104R%')`);
    await adminPool.query(`delete from agx.potreros where nombre like 'Potrero Sprint3D104R%'`);
    await adminPool.query(`delete from agx.predios where nombre_predio like 'Predio Sprint3D104R%'`);
    if (businessDb) await businessDb.closeAgxBusinessPool();
    await adminPool.end();
  });

  // -----------------------------------------------------------------------
  // A. Sin ciclos previos.
  // -----------------------------------------------------------------------

  test('A1. sin ciclos previos: elige la ficha con MAYOR fecha_aforo, no la más reciente por created_at', async () => {
    const org = randomOrgId();
    const { predioId, potreroId, pasturaId } = await seedEscenarioBase(org, 'A1');
    await seedFicha(org, potreroId, pasturaId, { fechaAforo: '2026-08-01' }); // insertada primero, fecha más vieja
    const fichaB = await seedFicha(org, potreroId, pasturaId, { fechaAforo: '2026-08-05' }); // insertada después, fecha más nueva

    const { ficha, motivo } = await resolver.resolveFichaVigente(adminPool, potreroId);
    assert.equal(motivo, null);
    assert.equal(ficha.ficha_id, fichaB);
  });

  test('A2. sin ciclos previos, misma fecha_aforo: desempata por created_at DESC (la registrada después)', async () => {
    const org = randomOrgId();
    const { predioId, potreroId, pasturaId } = await seedEscenarioBase(org, 'A2');
    await seedFicha(org, potreroId, pasturaId, { fechaAforo: '2026-08-10' });
    const fichaSegunda = await seedFicha(org, potreroId, pasturaId, { fechaAforo: '2026-08-10' });

    const { ficha, motivo } = await resolver.resolveFichaVigente(adminPool, potreroId);
    assert.equal(motivo, null);
    assert.equal(ficha.ficha_id, fichaSegunda);
  });

  // -----------------------------------------------------------------------
  // B/C/D/E. Autoridad temporal frente a un ciclo FINALIZADO.
  // -----------------------------------------------------------------------

  test('B. aforo con fecha_aforo ANTERIOR a la última salida real -> rechazado', async () => {
    const org = randomOrgId();
    const { predioId, potreroId, pasturaId } = await seedEscenarioBase(org, 'B');
    const fichaInicial = await seedFicha(org, potreroId, pasturaId, { fechaAforo: '2026-08-05' });
    await seedRecomendacionPastoreo(org, predioId, potreroId, fichaInicial);
    await seedCicloFinalizado(org, predioId, potreroId, {
      ingresoAt: new Date('2026-08-06T10:00:00Z'), salidaAt: new Date('2026-08-10T16:00:00Z'),
    });

    const { ficha, motivo } = await resolver.resolveFichaVigente(adminPool, potreroId);
    assert.equal(ficha, null);
    assert.equal(motivo, 'AFORO_ANTERIOR_AL_ULTIMO_PASTOREO');
  });

  test('C. aforo con fecha_aforo anterior pero created_at POSTERIOR a la salida -- created_at NUNCA rescata (sigue rechazado)', async () => {
    const org = randomOrgId();
    const { predioId, potreroId, pasturaId } = await seedEscenarioBase(org, 'C');
    const fichaInicial = await seedFicha(org, potreroId, pasturaId, { fechaAforo: '2026-08-01' });
    await seedRecomendacionPastoreo(org, predioId, potreroId, fichaInicial);
    await seedCicloFinalizado(org, predioId, potreroId, {
      ingresoAt: new Date('2026-08-02T10:00:00Z'), salidaAt: new Date('2026-08-04T16:00:00Z'),
    });
    // Ficha registrada DESPUÉS de finalizar (created_at real, posterior a la
    // salida) pero con fecha_aforo (hecho físico) todavía anterior a la
    // salida -- debe seguir rechazada.
    await seedFicha(org, potreroId, pasturaId, { fechaAforo: '2026-08-01' });

    const { ficha, motivo } = await resolver.resolveFichaVigente(adminPool, potreroId);
    assert.equal(ficha, null);
    assert.equal(motivo, 'AFORO_ANTERIOR_AL_ULTIMO_PASTOREO');
  });

  test('D. aforo el MISMO DÍA de la salida -> rechazado (política v1 conservadora, sin >=)', async () => {
    const org = randomOrgId();
    const { predioId, potreroId, pasturaId } = await seedEscenarioBase(org, 'D');
    const fichaInicial = await seedFicha(org, potreroId, pasturaId, { fechaAforo: '2026-08-01' });
    await seedRecomendacionPastoreo(org, predioId, potreroId, fichaInicial);
    await seedCicloFinalizado(org, predioId, potreroId, {
      ingresoAt: new Date('2026-08-02T10:00:00Z'), salidaAt: new Date('2026-08-10T16:00:00Z'),
    });
    await seedFicha(org, potreroId, pasturaId, { fechaAforo: '2026-08-10' }); // mismo día de la salida

    const { ficha, motivo } = await resolver.resolveFichaVigente(adminPool, potreroId);
    assert.equal(ficha, null);
    assert.equal(motivo, 'AFORO_ANTERIOR_AL_ULTIMO_PASTOREO');
  });

  test('E. aforo del DÍA SIGUIENTE a la salida -> aceptado', async () => {
    const org = randomOrgId();
    const { predioId, potreroId, pasturaId } = await seedEscenarioBase(org, 'E');
    const fichaInicial = await seedFicha(org, potreroId, pasturaId, { fechaAforo: '2026-08-01' });
    await seedRecomendacionPastoreo(org, predioId, potreroId, fichaInicial);
    await seedCicloFinalizado(org, predioId, potreroId, {
      ingresoAt: new Date('2026-08-02T10:00:00Z'), salidaAt: new Date('2026-08-10T16:00:00Z'),
    });
    const fichaValida = await seedFicha(org, potreroId, pasturaId, { fechaAforo: '2026-08-11' });

    const { ficha, motivo } = await resolver.resolveFichaVigente(adminPool, potreroId);
    assert.equal(motivo, null);
    assert.equal(ficha.ficha_id, fichaValida);
  });

  // -----------------------------------------------------------------------
  // F. Múltiples FINALIZADO -- usa la última fecha_salida_real.
  // -----------------------------------------------------------------------
  //
  // NOTA: el segundo ciclo se siembra con INSERT directo (no vía
  // iniciarCicloPastoreo) porque las reglas de negocio de reingreso
  // (assertPuedeIniciarCiclo) impedirían normalmente iniciar un segundo
  // ciclo real inmediatamente después de finalizar el primero sin pasar
  // por evaluarReingreso -- aquí se prueba únicamente la autoridad SQL de
  // resolveFichaVigente sobre el estado de la tabla, no el ciclo de vida
  // completo (ya cubierto por potreroCicloPastoreoRepositoryIntegration.test.js).
  // Revalidar este INSERT contra un Postgres/PostGIS real antes de confiar
  // ciegamente en él (no se pudo ejecutar en este entorno).
  test('F. dos ciclos FINALIZADO: la frontera es la ÚLTIMA fecha_salida_real, no la primera', async () => {
    const org = randomOrgId();
    const { predioId, potreroId, pasturaId } = await seedEscenarioBase(org, 'F');
    const fichaInicial = await seedFicha(org, potreroId, pasturaId, { fechaAforo: '2026-08-01' });
    const recomendacionId = await seedRecomendacionPastoreo(org, predioId, potreroId, fichaInicial);
    await seedCicloFinalizado(org, predioId, potreroId, {
      ingresoAt: new Date('2026-08-02T10:00:00Z'), salidaAt: new Date('2026-08-05T16:00:00Z'),
    });
    const categoriaId = await fetchCategoriaId('novillo_ceba');
    await adminPool.query(
      `insert into agx.potrero_ciclos_pastoreo
         (organizacion_id, predio_id, potrero_id, recomendacion_pastoreo_id, categoria_id,
          numero_animales_real, peso_promedio_real_kg, fecha_ingreso_real, fecha_salida_real, estado)
       values ($1, $2, $3, $4, $5, 8, 400, '2026-08-12', '2026-08-15', 'FINALIZADO')`,
      [org, predioId, potreroId, recomendacionId, categoriaId],
    );

    // Aforo posterior al PRIMER finalizado (08-05) pero anterior al SEGUNDO
    // (08-15) -- debe seguir rechazado, la frontera vigente es 08-15.
    await seedFicha(org, potreroId, pasturaId, { fechaAforo: '2026-08-10' });
    const rechazo = await resolver.resolveFichaVigente(adminPool, potreroId);
    assert.equal(rechazo.ficha, null);
    assert.equal(rechazo.motivo, 'AFORO_ANTERIOR_AL_ULTIMO_PASTOREO');

    const fichaValida = await seedFicha(org, potreroId, pasturaId, { fechaAforo: '2026-08-16' });
    const aceptado = await resolver.resolveFichaVigente(adminPool, potreroId);
    assert.equal(aceptado.motivo, null);
    assert.equal(aceptado.ficha.ficha_id, fichaValida);
  });

  // -----------------------------------------------------------------------
  // G/H. CANCELADO y EN_CURSO nunca establecen frontera.
  // -----------------------------------------------------------------------

  test('G. un ciclo CANCELADO en solitario no establece frontera -- se comporta como "sin ciclo previo"', async () => {
    const org = randomOrgId();
    const { predioId, potreroId, pasturaId } = await seedEscenarioBase(org, 'G');
    const fichaInicial = await seedFicha(org, potreroId, pasturaId, { fechaAforo: '2026-08-01' });
    await seedRecomendacionPastoreo(org, predioId, potreroId, fichaInicial);
    const ciclo = await cicloRepo.iniciarCicloPastoreo(org, predioId, potreroId, { now: new Date('2026-08-02T10:00:00Z') });
    await cicloRepo.cancelarCicloPastoreo(org, predioId, potreroId, ciclo.cicloId, { motivo: 'Registro erróneo -- test Sprint3D104R G' });

    // Sin ningún FINALIZADO, la ficha existente (anterior a la fecha del
    // ciclo cancelado) debe seguir siendo vigente -- CANCELADO no cuenta.
    const { ficha, motivo } = await resolver.resolveFichaVigente(adminPool, potreroId);
    assert.equal(motivo, null);
    assert.equal(ficha.ficha_id, fichaInicial);
  });

  test('H. un ciclo EN_CURSO en solitario no establece frontera -- se comporta como "sin ciclo previo"', async () => {
    const org = randomOrgId();
    const { predioId, potreroId, pasturaId } = await seedEscenarioBase(org, 'H');
    const fichaInicial = await seedFicha(org, potreroId, pasturaId, { fechaAforo: '2026-08-01' });
    await seedRecomendacionPastoreo(org, predioId, potreroId, fichaInicial);
    await cicloRepo.iniciarCicloPastoreo(org, predioId, potreroId, { now: new Date('2026-08-02T10:00:00Z') });
    // Ciclo queda EN_CURSO deliberadamente (nunca se finaliza en este test).

    const { ficha, motivo } = await resolver.resolveFichaVigente(adminPool, potreroId);
    assert.equal(motivo, null);
    assert.equal(ficha.ficha_id, fichaInicial);
  });

  // -----------------------------------------------------------------------
  // I/J. Ficha con fecha_aforo NULL.
  // -----------------------------------------------------------------------

  test('I. con frontera existente, una ficha con fecha_aforo NULL nunca sirve (no puede probar ser posterior)', async () => {
    const org = randomOrgId();
    const { predioId, potreroId, pasturaId } = await seedEscenarioBase(org, 'I');
    const fichaInicial = await seedFicha(org, potreroId, pasturaId, { fechaAforo: '2026-08-01' });
    await seedRecomendacionPastoreo(org, predioId, potreroId, fichaInicial);
    await seedCicloFinalizado(org, predioId, potreroId, {
      ingresoAt: new Date('2026-08-02T10:00:00Z'), salidaAt: new Date('2026-08-10T16:00:00Z'),
    });
    await seedFicha(org, potreroId, pasturaId, { fechaAforo: null }); // sin fecha, registrada después de la salida

    const { ficha, motivo } = await resolver.resolveFichaVigente(adminPool, potreroId);
    assert.equal(ficha, null);
    assert.equal(motivo, 'AFORO_ANTERIOR_AL_ULTIMO_PASTOREO');
  });

  test('J. sin ciclo previo, una ficha con fecha_aforo NULL queda relegada detrás de una con fecha válida (nunca excluida)', async () => {
    const org = randomOrgId();
    const { predioId, potreroId, pasturaId } = await seedEscenarioBase(org, 'J');
    await seedFicha(org, potreroId, pasturaId, { fechaAforo: null });
    const fichaConFecha = await seedFicha(org, potreroId, pasturaId, { fechaAforo: '2026-08-01' });

    const { ficha, motivo } = await resolver.resolveFichaVigente(adminPool, potreroId);
    assert.equal(motivo, null);
    assert.equal(ficha.ficha_id, fichaConFecha);
  });

  test('J2. sin ciclo previo y SOLO fichas con fecha_aforo NULL -- igual resuelve la más reciente por created_at (nunca excluye por NULL)', async () => {
    const org = randomOrgId();
    const { predioId, potreroId, pasturaId } = await seedEscenarioBase(org, 'J2');
    await seedFicha(org, potreroId, pasturaId, { fechaAforo: null });
    const fichaSegunda = await seedFicha(org, potreroId, pasturaId, { fechaAforo: null });

    const { ficha, motivo } = await resolver.resolveFichaVigente(adminPool, potreroId);
    assert.equal(motivo, null);
    assert.equal(ficha.ficha_id, fichaSegunda);
  });
});
