// SPRINT-3D9.4 -- RESIDUAL REAL POST-PASTOREO: pruebas de repositorio
// contra Postgres/PostGIS REAL. Cubre: captura del hecho físico sin
// ciencia disponible (NIVEL 0 nunca bloqueado), guardrails temporales
// (db_now autoritativo, nunca el reloj del cliente), comparativoEstado
// (precedencia INCOMPATIBLE_TEMPORAL > DESACTUALIZADO_POR_CORRECCION >
// PENDIENTE_MATERIA_SECA > PENDIENTE_ESTIMADO > COMPLETO), aplicar a
// descanso (contexto congelado -- sin fetch climático/NRC, único cambio
// el remanente), idempotencia, anulación en cascada, tenant isolation.
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
let cicloRepo;
let residualRepo;

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
  residualRepo = await import('../ganaderia/potreroCicloResidualRealRepository.js');
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

async function seedEscenarioCompleto(org, sufijo, { ingresoRealAt, sinFichaBase = false } = {}) {
  const predioId = await seedPredio(org, `Predio Sprint3D94 ${sufijo}`);
  const potreroId = await seedPotrero(org, predioId, `Potrero Sprint3D94 ${sufijo}`);
  const pasturaId = await fetchPasturaSistemaId('Brachiaria humidicola');
  const fichaId = sinFichaBase
    ? await seedFicha(org, potreroId, pasturaId, { fechaAforo: null, createdAt: null })
    : await seedFicha(org, potreroId, pasturaId, {
      fechaAforo: resolveFechaHoyNegocio(ingresoRealAt ?? new Date()),
      createdAt: ingresoRealAt ?? null,
    });
  const recomendacionId = await seedRecomendacionPastoreo(org, predioId, potreroId, fichaId);
  return { predioId, potreroId, fichaId, recomendacionId };
}

function horasDespues(fecha, horas) {
  return new Date(fecha.getTime() + horas * 60 * 60 * 1000);
}

async function crearCicloFinalizado(org, sufijo, { horasOcupacion = 48, sinFichaBase = false } = {}) {
  // ingresoAt se ancla en el PASADO (no `new Date()`) -- el guardrail
  // temporal de registrarResidualReal valida medicionRealAt contra el
  // db_now REAL de Postgres (nunca un `now` simulado), así que salidaAt
  // (ingresoAt + horasOcupacion) y cualquier medicionRealAt posterior
  // deben quedar antes del reloj real para no disparar
  // RESIDUAL_FUTURO_INVALIDO por accidente de fixture.
  const ingresoAt = new Date(Date.now() - (horasOcupacion + 24) * 60 * 60 * 1000);
  const { predioId, potreroId } = await seedEscenarioCompleto(org, sufijo, { ingresoRealAt: ingresoAt, sinFichaBase });
  const ciclo = await cicloRepo.iniciarCicloPastoreo(org, predioId, potreroId, { now: ingresoAt });
  const salidaAt = horasDespues(ingresoAt, horasOcupacion);
  const resultado = await cicloRepo.finalizarCicloPastoreo(org, predioId, potreroId, ciclo.cicloId, { now: salidaAt, climatologyFetchImpl: SIN_RED_FETCH_IMPL });
  return { predioId, potreroId, cicloId: ciclo.cicloId, salidaAt, descanso: resultado.descanso };
}

describe('SPRINT-3D9.4: potreroCicloResidualRealRepository', { skip: !dbAvailable }, () => {
  after(async () => {
    if (!adminPool) return;
    await adminPool.query(`update agx.potrero_recomendaciones_descanso set residual_real_version_id = null where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D94%')`);
    await adminPool.query(`delete from agx.potrero_ciclo_residual_real_invalidaciones where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D94%')`);
    await adminPool.query(`delete from agx.potrero_ciclo_residuales_reales_versiones where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D94%')`);
    await adminPool.query(`update agx.potrero_recomendaciones_descanso set lote_real_version_id = null where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D94%')`);
    await adminPool.query(`delete from agx.potrero_ciclo_lote_real_invalidaciones where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D94%')`);
    await adminPool.query(`delete from agx.potrero_ciclo_lote_real_versiones where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D94%')`);
    await adminPool.query(`delete from agx.potrero_descanso_invalidaciones where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D94%')`);
    await adminPool.query(`update agx.potrero_recomendaciones_descanso set ciclo_pastoreo_id = null where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D94%')`);
    await adminPool.query(`update agx.potrero_ciclos_pastoreo set recomendacion_descanso_plan_id = null where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D94%')`);
    await adminPool.query(`delete from agx.potrero_ciclo_eventos where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D94%')`);
    await adminPool.query(`delete from agx.potrero_ciclos_pastoreo where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D94%')`);
    await adminPool.query(`delete from agx.potrero_recomendaciones_descanso where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D94%')`);
    await adminPool.query(`delete from agx.potrero_recomendaciones_pastoreo where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D94%')`);
    await adminPool.query(`delete from agx.potrero_ficha_pasturas where ficha_id in (select ficha_id from agx.potrero_fichas_productivas where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D94%'))`);
    await adminPool.query(`delete from agx.potrero_fichas_productivas where potrero_id in (select potrero_id from agx.potreros where nombre like 'Potrero Sprint3D94%')`);
    await adminPool.query(`delete from agx.potreros where nombre like 'Potrero Sprint3D94%'`);
    await adminPool.query(`delete from agx.predios where nombre_predio like 'Predio Sprint3D94%'`);
  });

  // -----------------------------------------------------------------------
  // NIVEL 0 -- hecho físico SIEMPRE persistible.
  // -----------------------------------------------------------------------

  test('registrar residual SIN ficha base elegible -- NIVEL 0 se persiste, NIVEL 1/2 quedan NULL, comparativoEstado PENDIENTE_MATERIA_SECA', async () => {
    const org = randomOrgId();
    const { predioId, potreroId, cicloId, salidaAt } = await crearCicloFinalizado(org, 'S0-A', { sinFichaBase: true });
    const medicionAt = horasDespues(salidaAt, 3);

    const { residual } = await residualRepo.registrarResidualReal(org, predioId, potreroId, cicloId, {
      numeroMuestras: 8, aforoPromedioGM2: 250, medicionRealAt: medicionAt.toISOString(),
    });

    assert.equal(residual.materiaSecaPctAplicado, null);
    assert.equal(residual.remanenteMedidoKgMs, null);
    assert.equal(residual.descansoEstimadoOrigenId, null);
    assert.equal(residual.remanenteEstimadoKgMsCongelado, null);
    assert.ok(residual.biomasaFrescaTotalKg > 0, 'NIVEL 0 siempre calculable');
    assert.ok(Math.abs(residual.horasDesdeSalida - 3) < 0.01);

    const { actual } = await residualRepo.getResidualReal(org, predioId, potreroId, cicloId);
    assert.equal(actual.comparativoEstado, 'PENDIENTE_MATERIA_SECA');
  });

  // -----------------------------------------------------------------------
  // Guardrails temporales -- db_now autoritativo.
  // -----------------------------------------------------------------------

  test('medicionRealAt <= salida_real_at es rechazado', async () => {
    const org = randomOrgId();
    const { predioId, potreroId, cicloId, salidaAt } = await crearCicloFinalizado(org, 'TEMP-A');

    await assert.rejects(
      () => residualRepo.registrarResidualReal(org, predioId, potreroId, cicloId, {
        numeroMuestras: 8, aforoPromedioGM2: 250, medicionRealAt: salidaAt.toISOString(),
      }),
      (error) => error.code === 'RESIDUAL_ANTERIOR_O_IGUAL_A_SALIDA',
    );
  });

  test('medicionRealAt futuro (posterior a db_now) es rechazado -- el reloj del cliente nunca gobierna', async () => {
    const org = randomOrgId();
    const { predioId, potreroId, cicloId } = await crearCicloFinalizado(org, 'TEMP-B');
    const futuro = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await assert.rejects(
      () => residualRepo.registrarResidualReal(org, predioId, potreroId, cicloId, {
        numeroMuestras: 8, aforoPromedioGM2: 250, medicionRealAt: futuro.toISOString(),
      }),
      (error) => error.code === 'RESIDUAL_FUTURO_INVALIDO',
    );
  });

  test('medicionRealAt pocos minutos después de la salida es válida (sin umbral inventado)', async () => {
    const org = randomOrgId();
    const { predioId, potreroId, cicloId, salidaAt } = await crearCicloFinalizado(org, 'TEMP-C');
    const medicionAt = new Date(salidaAt.getTime() + 15 * 60 * 1000);

    const { residual } = await residualRepo.registrarResidualReal(org, predioId, potreroId, cicloId, {
      numeroMuestras: 8, aforoPromedioGM2: 250, medicionRealAt: medicionAt.toISOString(),
    });
    assert.ok(residual.residualId);
  });

  // -----------------------------------------------------------------------
  // Camino feliz: NIVEL 1 + NIVEL 2 disponibles -> COMPLETO -> aplicar a
  // descanso con contexto CONGELADO (sin fetch climático/NRC).
  // -----------------------------------------------------------------------

  test('COMPLETO cuando %MS y estimado REAL están disponibles; aplicar-a-descanso preserva pastura/agroClimate del origen y solo cambia el remanente', async () => {
    const org = randomOrgId();
    const { predioId, potreroId, cicloId, salidaAt, descanso: descansoOrigen } = await crearCicloFinalizado(org, 'HAPPY-A');
    assert.equal(descansoOrigen.fuentePresion, 'REAL', 'precondición del test: el ciclo debe finalizar con presión REAL disponible');

    const medicionAt = horasDespues(salidaAt, 4);
    const { residual } = await residualRepo.registrarResidualReal(org, predioId, potreroId, cicloId, {
      numeroMuestras: 8, aforoPromedioGM2: 250, medicionRealAt: medicionAt.toISOString(),
    });

    assert.ok(residual.materiaSecaPctAplicado > 0, 'NIVEL 1 debe resolverse (misma ficha/pastura que el ciclo)');
    assert.ok(residual.remanenteEstimadoKgMsCongelado !== null, 'NIVEL 2 debe resolverse (descanso REAL ya existe)');
    assert.notEqual(residual.remanenteMedidoKgMs, residual.remanenteEstimadoKgMsCongelado, 'ESTIMADO != MEDIDO -- nunca deben colapsarse en el mismo número');

    const { actual } = await residualRepo.getResidualReal(org, predioId, potreroId, cicloId);
    assert.equal(actual.comparativoEstado, 'COMPLETO');

    const { descanso: descansoMedido } = await residualRepo.aplicarResidualRealADescanso(org, predioId, potreroId, cicloId, {});
    assert.equal(descansoMedido.fuenteRemanente, 'MEDIDO');
    assert.equal(descansoMedido.residualRealVersionId, residual.residualId);
    assert.equal(descansoMedido.previousDescansoId, descansoOrigen.descansoId);

    // Contexto congelado: pastura/agroClimate deben ser BIT A BIT iguales
    // al origen -- solo disponibilidad/ajustePresion/fuenteRemanente cambian.
    assert.deepEqual(descansoMedido.parametrosFuente.pastura, descansoOrigen.parametrosFuente.pastura);
    assert.deepEqual(descansoMedido.parametrosFuente.agroClimate, descansoOrigen.parametrosFuente.agroClimate);
    assert.equal(descansoMedido.agroclimateStatus, descansoOrigen.agroclimateStatus);

    // El descanso ESTIMADO origen queda invalidado -- descansoMedido es la
    // única versión vigente.
    const vigente = await adminPool.query(
      `select descanso_id from agx.potrero_recomendaciones_descanso d
        where d.ciclo_pastoreo_id = $1
          and not exists (select 1 from agx.potrero_descanso_invalidaciones i where i.descanso_id = d.descanso_id)`,
      [cicloId],
    );
    assert.equal(vigente.rows.length, 1);
    assert.equal(String(vigente.rows[0].descanso_id), descansoMedido.descansoId);
  });

  test('retry de aplicar-a-descanso (mismo residual ya aplicado) es idempotente -- no crea nueva versión', async () => {
    const org = randomOrgId();
    const { predioId, potreroId, cicloId, salidaAt } = await crearCicloFinalizado(org, 'HAPPY-B');
    const medicionAt = horasDespues(salidaAt, 4);
    await residualRepo.registrarResidualReal(org, predioId, potreroId, cicloId, {
      numeroMuestras: 8, aforoPromedioGM2: 250, medicionRealAt: medicionAt.toISOString(),
    });

    const primero = await residualRepo.aplicarResidualRealADescanso(org, predioId, potreroId, cicloId, {});
    const segundo = await residualRepo.aplicarResidualRealADescanso(org, predioId, potreroId, cicloId, {});
    assert.equal(segundo.yaExistia, true);
    assert.equal(segundo.descanso.descansoId, primero.descanso.descansoId);

    const versiones = await adminPool.query('select count(*)::int as n from agx.potrero_recomendaciones_descanso where ciclo_pastoreo_id = $1', [cicloId]);
    assert.equal(versiones.rows[0].n, 2, 'ESTIMADO original + MEDIDO -- el retry nunca agrega una tercera fila');
  });

  test('aplicar-a-descanso es rechazado cuando comparativoEstado no es COMPLETO (PENDIENTE_MATERIA_SECA)', async () => {
    const org = randomOrgId();
    const { predioId, potreroId, cicloId, salidaAt } = await crearCicloFinalizado(org, 'GUARD-A', { sinFichaBase: true });
    const medicionAt = horasDespues(salidaAt, 4);
    await residualRepo.registrarResidualReal(org, predioId, potreroId, cicloId, {
      numeroMuestras: 8, aforoPromedioGM2: 250, medicionRealAt: medicionAt.toISOString(),
    });

    await assert.rejects(
      () => residualRepo.aplicarResidualRealADescanso(org, predioId, potreroId, cicloId, {}),
      (error) => error.code === 'COMPARATIVO_NO_COMPLETO',
    );
  });

  // -----------------------------------------------------------------------
  // Anulación en cascada.
  // -----------------------------------------------------------------------

  test('anular un residual que sustenta un descanso MEDIDO vigente invalida ese descanso -- el ciclo queda sin descanso vigente, nunca revierte a ESTIMADO automáticamente', async () => {
    const org = randomOrgId();
    const { predioId, potreroId, cicloId, salidaAt } = await crearCicloFinalizado(org, 'ANULAR-A');
    const medicionAt = horasDespues(salidaAt, 4);
    await residualRepo.registrarResidualReal(org, predioId, potreroId, cicloId, {
      numeroMuestras: 8, aforoPromedioGM2: 250, medicionRealAt: medicionAt.toISOString(),
    });
    await residualRepo.aplicarResidualRealADescanso(org, predioId, potreroId, cicloId, {});

    await residualRepo.anularResidualReal(org, predioId, potreroId, cicloId, { motivo: 'medición errónea' });

    const vigente = await adminPool.query(
      `select descanso_id from agx.potrero_recomendaciones_descanso d
        where d.ciclo_pastoreo_id = $1
          and not exists (select 1 from agx.potrero_descanso_invalidaciones i where i.descanso_id = d.descanso_id)`,
      [cicloId],
    );
    assert.equal(vigente.rows.length, 0, 'ningún descanso debe quedar vigente -- pendiente de acción explícita, nunca revertido solo');
  });

  // -----------------------------------------------------------------------
  // Tenant isolation.
  // -----------------------------------------------------------------------

  test('un residual no es accesible desde otra organización (cross-tenant rechazado)', async () => {
    const org = randomOrgId();
    const otraOrg = randomOrgId();
    const { predioId, potreroId, cicloId, salidaAt } = await crearCicloFinalizado(org, 'TENANT-A');
    const medicionAt = horasDespues(salidaAt, 4);

    await assert.rejects(
      () => residualRepo.registrarResidualReal(otraOrg, predioId, potreroId, cicloId, {
        numeroMuestras: 8, aforoPromedioGM2: 250, medicionRealAt: medicionAt.toISOString(),
      }),
      (error) => error.code === 'CICLO_NOT_FOUND',
    );
  });

  // -----------------------------------------------------------------------
  // Contexto congelado -- documentar EXACTAMENTE qué campos pueden diferir
  // entre el descanso ESTIMADO origen y el MEDIDO derivado.
  // -----------------------------------------------------------------------

  test('aplicar-a-descanso: solo disponibilidad/ajustePresion/fuenteRemanente/residualRealVersionId/descansoEstimadoOrigenId difieren -- pastura/agroClimate/lote/motorVersion/ids son IDÉNTICOS', async () => {
    const org = randomOrgId();
    const { predioId, potreroId, cicloId, salidaAt, descanso: descansoOrigen } = await crearCicloFinalizado(org, 'FROZEN-A');
    const medicionAt = horasDespues(salidaAt, 4);
    const { residual } = await residualRepo.registrarResidualReal(org, predioId, potreroId, cicloId, {
      numeroMuestras: 8, aforoPromedioGM2: 250, medicionRealAt: medicionAt.toISOString(),
    });
    const { descanso: descansoMedido } = await residualRepo.aplicarResidualRealADescanso(org, predioId, potreroId, cicloId, {});

    const clavesOrigen = new Set(Object.keys(descansoOrigen.parametrosFuente));
    const clavesMedido = new Set(Object.keys(descansoMedido.parametrosFuente));
    const clavesNuevas = [...clavesMedido].filter((k) => !clavesOrigen.has(k)).sort();
    assert.deepEqual(clavesNuevas, ['descansoEstimadoOrigenId', 'fuenteRemanente', 'residualRealVersionId'].sort(),
      'únicas claves NUEVAS que aplicar-a-descanso agrega al JSON -- nada más');

    for (const clave of ['climatologyGenerated', 'lote', 'pastura', 'agroClimate', 'recomendacionPastoreoId', 'recomendacionPastoreoEdadDias', 'fichaId', 'contextoId', 'motorVersion']) {
      assert.deepEqual(descansoMedido.parametrosFuente[clave], descansoOrigen.parametrosFuente[clave], `${clave} debe ser IDÉNTICO -- aplicar-a-descanso nunca lo recalcula`);
    }
    // disponibilidad/ajustePresion SÍ difieren (es la única rama que cambia).
    assert.notDeepEqual(descansoMedido.parametrosFuente.disponibilidad, descansoOrigen.parametrosFuente.disponibilidad);

    assert.equal(descansoMedido.fichaId, descansoOrigen.fichaId);
    assert.equal(descansoMedido.recomendacionPastoreoId, descansoOrigen.recomendacionPastoreoId);
    assert.equal(descansoMedido.nivelConfianza, descansoOrigen.nivelConfianza, 'frozen -- documentado como known debt, no recalculado');
  });

  // -----------------------------------------------------------------------
  // Corrección de ciclo -> DESACTUALIZADO_POR_CORRECCION -> recuperación.
  // -----------------------------------------------------------------------

  test('corregir el ciclo (cambio científico) invalida el descanso MEDIDO vigente y deja el residual DESACTUALIZADO_POR_CORRECCION; actualizar-comparativo recongela contra el nuevo snapshot/origen y vuelve COMPLETO', async () => {
    const org = randomOrgId();
    const { predioId, potreroId, cicloId, salidaAt } = await crearCicloFinalizado(org, 'STALE-A');
    const medicionAt = horasDespues(salidaAt, 4);
    const { residual: residualV1 } = await residualRepo.registrarResidualReal(org, predioId, potreroId, cicloId, {
      numeroMuestras: 8, aforoPromedioGM2: 250, medicionRealAt: medicionAt.toISOString(),
    });
    const { actual: actualCompleto } = await residualRepo.getResidualReal(org, predioId, potreroId, cicloId);
    assert.equal(actualCompleto.comparativoEstado, 'COMPLETO');

    const { descanso: descansoMedidoV1 } = await residualRepo.aplicarResidualRealADescanso(org, predioId, potreroId, cicloId, {});
    assert.equal(descansoMedidoV1.fuenteRemanente, 'MEDIDO');

    // Corrección científica del ciclo -- cambia el lote, dispara nueva
    // versión de snapshot (v3) e invalida el descanso vigente (mecanismo
    // GENÉRICO ya existente en corregirCicloPastoreo, sin código nuevo).
    await cicloRepo.corregirCicloPastoreo(org, predioId, potreroId, cicloId, {
      numeroAnimales: 15, motivo: 'ajuste numero animales post-conteo', climatologyFetchImpl: SIN_RED_FETCH_IMPL,
    });

    const { actual: actualStale } = await residualRepo.getResidualReal(org, predioId, potreroId, cicloId);
    assert.equal(actualStale.comparativoEstado, 'DESACTUALIZADO_POR_CORRECCION', 'la medición física sigue siendo válida, pero el snapshot ya cambió');
    assert.equal(actualStale.residualId, residualV1.residualId, 'sigue siendo la MISMA medición física -- no se creó ninguna versión nueva sola');

    // El descanso MEDIDO anterior queda invalidado -- ya no hay ningún
    // descanso vigente que dependa de un residual desactualizado.
    const medidoInvalidado = await adminPool.query('select descanso_id from agx.potrero_descanso_invalidaciones where descanso_id = $1', [descansoMedidoV1.descansoId]);
    assert.equal(medidoInvalidado.rows.length, 1);

    // Sin acción explícita, aplicar-a-descanso sigue rechazado.
    await assert.rejects(
      () => residualRepo.aplicarResidualRealADescanso(org, predioId, potreroId, cicloId, {}),
      (error) => error.code === 'COMPARATIVO_NO_COMPLETO',
    );

    // Acción explícita: actualizar-comparativo recongela contra el
    // snapshot/origen VIGENTES -- misma medición física, nueva versión.
    const { residual: residualV2 } = await residualRepo.actualizarComparativoResidualReal(org, predioId, potreroId, cicloId, {});
    assert.notEqual(residualV2.residualId, residualV1.residualId);
    assert.equal(residualV2.numeroMuestras, residualV1.numeroMuestras);
    assert.equal(residualV2.aforoPromedioGM2, residualV1.aforoPromedioGM2);
    assert.equal(new Date(residualV2.medicionRealAt).getTime(), new Date(residualV1.medicionRealAt).getTime(), 'misma medición física -- nunca se reinterpreta');
    assert.notEqual(residualV2.snapshotLoteRealId, residualV1.snapshotLoteRealId, 'debe anclar al NUEVO snapshot vigente');

    const { actual: actualRecuperado } = await residualRepo.getResidualReal(org, predioId, potreroId, cicloId);
    assert.equal(actualRecuperado.comparativoEstado, 'COMPLETO');

    // Aplicar de nuevo funciona, con el nuevo origen.
    const { descanso: descansoMedidoV2 } = await residualRepo.aplicarResidualRealADescanso(org, predioId, potreroId, cicloId, {});
    assert.equal(descansoMedidoV2.fuenteRemanente, 'MEDIDO');
    assert.equal(descansoMedidoV2.residualRealVersionId, residualV2.residualId);
  });

  // -----------------------------------------------------------------------
  // Corrección temporal -- INCOMPATIBLE_TEMPORAL es terminal.
  // -----------------------------------------------------------------------

  test('corregir fechaSalidaReal de forma que la medición ya NO sea posterior deja el residual INCOMPATIBLE_TEMPORAL; actualizar-comparativo NO puede repararlo', async () => {
    const org = randomOrgId();
    const { predioId, potreroId, cicloId, salidaAt } = await crearCicloFinalizado(org, 'INCOMP-A', { horasOcupacion: 24 });
    const medicionAt = horasDespues(salidaAt, 2);
    await residualRepo.registrarResidualReal(org, predioId, potreroId, cicloId, {
      numeroMuestras: 8, aforoPromedioGM2: 250, medicionRealAt: medicionAt.toISOString(),
    });
    const { actual: antes } = await residualRepo.getResidualReal(org, predioId, potreroId, cicloId);
    assert.equal(antes.comparativoEstado, 'COMPLETO');

    // Extiende fechaSalidaReal 3 días -- la medición (2h después de la
    // salida ORIGINAL) queda ANTES de la nueva salida.
    const nuevaFechaSalida = new Date(salidaAt.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    await cicloRepo.corregirCicloPastoreo(org, predioId, potreroId, cicloId, {
      fechaSalidaReal: nuevaFechaSalida, motivo: 'corrección de fecha de salida', climatologyFetchImpl: SIN_RED_FETCH_IMPL,
    });

    const { actual: incompatible } = await residualRepo.getResidualReal(org, predioId, potreroId, cicloId);
    assert.equal(incompatible.comparativoEstado, 'INCOMPATIBLE_TEMPORAL');

    await assert.rejects(
      () => residualRepo.aplicarResidualRealADescanso(org, predioId, potreroId, cicloId, {}),
      (error) => error.code === 'COMPARATIVO_NO_COMPLETO',
    );

    // actualizar-comparativo persiste una nueva versión auditable, pero
    // el estado NUNCA deja de ser INCOMPATIBLE_TEMPORAL -- es terminal,
    // ninguna re-resolución de ciencia lo repara.
    await residualRepo.actualizarComparativoResidualReal(org, predioId, potreroId, cicloId, {});
    const { actual: siguraIncompatible } = await residualRepo.getResidualReal(org, predioId, potreroId, cicloId);
    assert.equal(siguraIncompatible.comparativoEstado, 'INCOMPATIBLE_TEMPORAL');
  });

  // -----------------------------------------------------------------------
  // PENDIENTE_ESTIMADO alcanzable sin cambiar snapshot (NIVEL 1 disponible,
  // NIVEL 2 no -- duración inválida produce PLAN_FALLBACK sin afectar la
  // ficha base, que es lo único que NIVEL 1 necesita).
  // -----------------------------------------------------------------------

  test('PENDIENTE_ESTIMADO: NIVEL 1 disponible (ficha base elegible) y NIVEL 2 no (fuentePresion=PLAN_FALLBACK por duración inválida)', async () => {
    const org = randomOrgId();
    const { predioId, potreroId, cicloId, salidaAt, descanso } = await crearCicloFinalizado(org, 'PEND-EST-A', { horasOcupacion: 0 });
    assert.equal(descanso.fuentePresion, 'PLAN_FALLBACK', 'precondición del test: 0 horas de ocupación produce PLAN_FALLBACK (DURACION_INVALIDA)');

    const medicionAt = horasDespues(salidaAt, 2);
    const { residual } = await residualRepo.registrarResidualReal(org, predioId, potreroId, cicloId, {
      numeroMuestras: 8, aforoPromedioGM2: 250, medicionRealAt: medicionAt.toISOString(),
    });
    assert.ok(residual.materiaSecaPctAplicado > 0, 'NIVEL 1 no depende de la duración -- debe resolverse igual');
    assert.equal(residual.descansoEstimadoOrigenId, null, 'NIVEL 2 no disponible -- fuentePresion no es REAL');

    const { actual } = await residualRepo.getResidualReal(org, predioId, potreroId, cicloId);
    assert.equal(actual.comparativoEstado, 'PENDIENTE_ESTIMADO');
  });

  // -----------------------------------------------------------------------
  // Corrección de la medición física (numeroMuestras/aforo/medicionRealAt
  // mal digitados).
  // -----------------------------------------------------------------------

  test('corregirResidualReal: nueva versión completa, invalida la anterior, recalcula biomasa/%MS/remanente/comparativo; retry sin cambios es idempotente', async () => {
    const org = randomOrgId();
    const { predioId, potreroId, cicloId, salidaAt } = await crearCicloFinalizado(org, 'CORREGIR-A');
    const medicionAt = horasDespues(salidaAt, 4);
    const { residual: v1 } = await residualRepo.registrarResidualReal(org, predioId, potreroId, cicloId, {
      numeroMuestras: 8, aforoPromedioGM2: 250, medicionRealAt: medicionAt.toISOString(),
    });

    const { residual: v2, yaExistia: yaExistiaV2 } = await residualRepo.corregirResidualReal(org, predioId, potreroId, cicloId, {
      aforoPromedioGM2: 300,
    });
    assert.equal(yaExistiaV2, false);
    assert.notEqual(v2.residualId, v1.residualId);
    assert.equal(v2.aforoPromedioGM2, 300);
    assert.ok(v2.biomasaFrescaTotalKg > v1.biomasaFrescaTotalKg, 'biomasa recalculada server-side, nunca aportada por el cliente');
    assert.ok(v2.remanenteMedidoKgMs > v1.remanenteMedidoKgMs, 'remanente medido recalculado a partir de la nueva biomasa');

    const v1Invalidado = await adminPool.query('select residual_id from agx.potrero_ciclo_residual_real_invalidaciones where residual_id = $1', [v1.residualId]);
    assert.equal(v1Invalidado.rows.length, 1);

    // Retry sin cambios -- idempotente, no crea v3.
    const { yaExistia: retryYaExistia } = await residualRepo.corregirResidualReal(org, predioId, potreroId, cicloId, {
      aforoPromedioGM2: 300,
    });
    assert.equal(retryYaExistia, true);
    const versiones = await adminPool.query('select count(*)::int as n from agx.potrero_ciclo_residuales_reales_versiones where ciclo_id = $1', [cicloId]);
    assert.equal(versiones.rows[0].n, 2, 'retry sin cambios nunca crea una versión nueva');
  });

  test('corregirResidualReal exige al menos un campo', async () => {
    const org = randomOrgId();
    const { predioId, potreroId, cicloId, salidaAt } = await crearCicloFinalizado(org, 'CORREGIR-B');
    const medicionAt = horasDespues(salidaAt, 4);
    await residualRepo.registrarResidualReal(org, predioId, potreroId, cicloId, {
      numeroMuestras: 8, aforoPromedioGM2: 250, medicionRealAt: medicionAt.toISOString(),
    });
    await assert.rejects(
      () => residualRepo.corregirResidualReal(org, predioId, potreroId, cicloId, {}),
      (error) => error.code === 'SIN_CAMBIOS_SOLICITADOS',
    );
  });

  // -----------------------------------------------------------------------
  // SPRINT-3D10.6 -- idempotencia de registrar-residual frente a reintentos
  // manuales tras un resultado incierto (NETWORK_ERROR). Contrato:
  //   CASE A: sin residual vigente -> registro normal.
  //   CASE B: vigente con la MISMA medición -> misma fila, yaExistia true,
  //           sin versión/evento/invalidación nuevos.
  //   CASE C: vigente distinta -> 409 RESIDUAL_YA_REGISTRADO, nada escrito.
  // Invariante: a lo sumo UNA versión no invalidada por ciclo.
  // -----------------------------------------------------------------------

  async function contarVersiones(cicloId) {
    const result = await adminPool.query('select count(*)::int as n from agx.potrero_ciclo_residuales_reales_versiones where ciclo_id = $1', [cicloId]);
    return result.rows[0].n;
  }

  async function contarVigentes(cicloId) {
    const result = await adminPool.query(
      `select count(*)::int as n from agx.potrero_ciclo_residuales_reales_versiones r
        where r.ciclo_id = $1
          and not exists (select 1 from agx.potrero_ciclo_residual_real_invalidaciones i where i.residual_id = r.residual_id)`,
      [cicloId],
    );
    return result.rows[0].n;
  }

  async function contarEventos(cicloId, tipoEvento) {
    const result = await adminPool.query(
      'select count(*)::int as n from agx.potrero_ciclo_eventos where ciclo_id = $1 and tipo_evento = $2',
      [cicloId, tipoEvento],
    );
    return result.rows[0].n;
  }

  // Foto de TODO lo que registrar/corregir/anular/aplicar podrían escribir
  // para el ciclo -- usada para demostrar "DB sin cambios" tras un 409.
  async function fotoCiclo(cicloId) {
    const result = await adminPool.query(
      `select
         (select count(*)::int from agx.potrero_ciclo_residuales_reales_versiones where ciclo_id = $1) as versiones,
         (select coalesce(max(version), 0)::int from agx.potrero_ciclo_residuales_reales_versiones where ciclo_id = $1) as max_version,
         (select count(*)::int from agx.potrero_ciclo_residual_real_invalidaciones where ciclo_id = $1) as invalidaciones_residual,
         (select count(*)::int from agx.potrero_ciclo_eventos where ciclo_id = $1) as eventos,
         (select count(*)::int from agx.potrero_recomendaciones_descanso where ciclo_pastoreo_id = $1) as descansos,
         (select count(*)::int from agx.potrero_descanso_invalidaciones where ciclo_pastoreo_id = $1) as invalidaciones_descanso`,
      [cicloId],
    );
    return result.rows[0];
  }

  function esResidualYaRegistrado(error) {
    return error.code === 'RESIDUAL_YA_REGISTRADO' && error.status === 409;
  }

  test('3D10.6 CASE A/B: primer registro crea v1; el segundo idéntico devuelve la MISMA v1 (yaExistia true) -- 1 versión, 1 evento, 1 vigente', async () => {
    const org = randomOrgId();
    const { predioId, potreroId, cicloId, salidaAt } = await crearCicloFinalizado(org, 'IDEM-A');
    const payload = { numeroMuestras: 8, aforoPromedioGM2: 250.5, medicionRealAt: horasDespues(salidaAt, 4).toISOString(), observacion: 'lluvia previa' };

    const primero = await residualRepo.registrarResidualReal(org, predioId, potreroId, cicloId, payload);
    assert.equal(primero.yaExistia, false);
    assert.equal(primero.residual.version, 1);

    const segundo = await residualRepo.registrarResidualReal(org, predioId, potreroId, cicloId, payload);
    assert.equal(segundo.yaExistia, true);
    assert.equal(segundo.residual.residualId, primero.residual.residualId);
    assert.equal(segundo.residual.version, 1);

    assert.equal(await contarVersiones(cicloId), 1, 'el retry idéntico nunca crea una segunda versión');
    assert.equal(await contarEventos(cicloId, 'RESIDUAL_REAL_REGISTRADO'), 1, 'el retry idéntico nunca escribe un segundo evento');
    assert.equal(await contarVigentes(cicloId), 1);
  });

  test('3D10.6 CASE B: la misma medición expresada en otra zona horaria (mismo instante) sigue siendo idempotente', async () => {
    const org = randomOrgId();
    const { predioId, potreroId, cicloId, salidaAt } = await crearCicloFinalizado(org, 'IDEM-TZ');
    const medicionAt = horasDespues(salidaAt, 4);
    const primero = await residualRepo.registrarResidualReal(org, predioId, potreroId, cicloId, {
      numeroMuestras: 8, aforoPromedioGM2: 250, medicionRealAt: medicionAt.toISOString(),
    });
    const bogota = new Date(medicionAt.getTime() - 5 * 60 * 60 * 1000).toISOString().replace('Z', '-05:00');
    const segundo = await residualRepo.registrarResidualReal(org, predioId, potreroId, cicloId, {
      numeroMuestras: 8, aforoPromedioGM2: 250, medicionRealAt: bogota,
    });
    assert.equal(segundo.yaExistia, true);
    assert.equal(segundo.residual.residualId, primero.residual.residualId);
    assert.equal(await contarVersiones(cicloId), 1);
  });

  test('3D10.6 CASE C: segundo registro DISTINTO -> 409 RESIDUAL_YA_REGISTRADO y la DB queda exactamente igual', async () => {
    const org = randomOrgId();
    const { predioId, potreroId, cicloId, salidaAt } = await crearCicloFinalizado(org, 'IDEM-C');
    const medicionAt = horasDespues(salidaAt, 4);
    const { residual: v1 } = await residualRepo.registrarResidualReal(org, predioId, potreroId, cicloId, {
      numeroMuestras: 8, aforoPromedioGM2: 250, medicionRealAt: medicionAt.toISOString(),
    });
    await residualRepo.aplicarResidualRealADescanso(org, predioId, potreroId, cicloId, {});
    const antes = await fotoCiclo(cicloId);

    const variantes = [
      { numeroMuestras: 9, aforoPromedioGM2: 250, medicionRealAt: medicionAt.toISOString() },
      { numeroMuestras: 8, aforoPromedioGM2: 260, medicionRealAt: medicionAt.toISOString() },
      { numeroMuestras: 8, aforoPromedioGM2: 250, medicionRealAt: new Date(medicionAt.getTime() + 1).toISOString() },
      { numeroMuestras: 8, aforoPromedioGM2: 250, medicionRealAt: medicionAt.toISOString(), observacion: 'nota nueva' },
    ];
    for (const payload of variantes) {
      await assert.rejects(
        () => residualRepo.registrarResidualReal(org, predioId, potreroId, cicloId, payload),
        esResidualYaRegistrado,
      );
    }

    assert.deepEqual(await fotoCiclo(cicloId), antes, 'un 409 nunca escribe: ni versión, ni invalidación, ni evento, ni descanso');
    const { actual } = await residualRepo.getResidualReal(org, predioId, potreroId, cicloId);
    assert.equal(actual.residualId, v1.residualId, 'la vigente sigue siendo v1');
  });

  test('3D10.6 concurrencia: dos registrar-residual simultáneos IDÉNTICOS (retry de red) -- el lock del ciclo serializa: 1 versión, 1 evento, misma fila', async () => {
    const org = randomOrgId();
    const { predioId, potreroId, cicloId, salidaAt } = await crearCicloFinalizado(org, 'CONC-A2');
    const payload = { numeroMuestras: 8, aforoPromedioGM2: 250, medicionRealAt: horasDespues(salidaAt, 4).toISOString() };

    // La segunda transacción espera el FOR UPDATE del ciclo; al obtenerlo,
    // su lectura de la vigente (statement posterior, READ COMMITTED) ya ve
    // la v1 confirmada por la primera -> CASE B.
    const [r1, r2] = await Promise.all([
      residualRepo.registrarResidualReal(org, predioId, potreroId, cicloId, payload),
      residualRepo.registrarResidualReal(org, predioId, potreroId, cicloId, payload),
    ]);
    assert.equal(r1.residual.residualId, r2.residual.residualId);
    assert.deepEqual([r1.yaExistia, r2.yaExistia].sort(), [false, true]);
    assert.equal(await contarVersiones(cicloId), 1);
    assert.equal(await contarEventos(cicloId, 'RESIDUAL_REAL_REGISTRADO'), 1);
  });

  test('3D10.6 concurrencia: dos registrar-residual simultáneos DISTINTOS -- uno gana, el otro recibe 409; nunca una versión implícita', async () => {
    const org = randomOrgId();
    const { predioId, potreroId, cicloId, salidaAt } = await crearCicloFinalizado(org, 'CONC-A');
    const medicionAt = horasDespues(salidaAt, 4);
    const payloadA = { numeroMuestras: 8, aforoPromedioGM2: 250, medicionRealAt: medicionAt.toISOString() };
    const payloadB = { numeroMuestras: 9, aforoPromedioGM2: 260, medicionRealAt: medicionAt.toISOString() };

    const resultados = await Promise.allSettled([
      residualRepo.registrarResidualReal(org, predioId, potreroId, cicloId, payloadA),
      residualRepo.registrarResidualReal(org, predioId, potreroId, cicloId, payloadB),
    ]);
    const cumplidos = resultados.filter((r) => r.status === 'fulfilled');
    const rechazados = resultados.filter((r) => r.status === 'rejected');
    assert.equal(cumplidos.length, 1);
    assert.equal(rechazados.length, 1);
    assert.ok(esResidualYaRegistrado(rechazados[0].reason));
    assert.equal(cumplidos[0].value.yaExistia, false);

    assert.equal(await contarVersiones(cicloId), 1);
    assert.equal(await contarEventos(cicloId, 'RESIDUAL_REAL_REGISTRADO'), 1);
    const ganador = resultados[0].status === 'fulfilled' ? payloadA : payloadB;
    const { actual } = await residualRepo.getResidualReal(org, predioId, potreroId, cicloId);
    assert.equal(actual.numeroMuestras, ganador.numeroMuestras);
    assert.equal(actual.aforoPromedioGM2, ganador.aforoPromedioGM2);
  });

  test('3D10.6: tras un 409, Corregir sigue funcionando (v2, invalida v1, una sola vigente)', async () => {
    const org = randomOrgId();
    const { predioId, potreroId, cicloId, salidaAt } = await crearCicloFinalizado(org, 'IDEM-CORR');
    const medicionAt = horasDespues(salidaAt, 4);
    const payload = { numeroMuestras: 8, aforoPromedioGM2: 250, medicionRealAt: medicionAt.toISOString() };
    const { residual: v1 } = await residualRepo.registrarResidualReal(org, predioId, potreroId, cicloId, payload);
    await residualRepo.registrarResidualReal(org, predioId, potreroId, cicloId, payload);
    await assert.rejects(
      () => residualRepo.registrarResidualReal(org, predioId, potreroId, cicloId, { ...payload, aforoPromedioGM2: 300 }),
      esResidualYaRegistrado,
    );

    const { residual: v2, yaExistia } = await residualRepo.corregirResidualReal(org, predioId, potreroId, cicloId, { aforoPromedioGM2: 300 });
    assert.equal(yaExistia, false);
    assert.equal(v2.version, 2);
    assert.equal(v2.aforoPromedioGM2, 300);
    const v1Invalidado = await adminPool.query('select 1 from agx.potrero_ciclo_residual_real_invalidaciones where residual_id = $1', [v1.residualId]);
    assert.equal(v1Invalidado.rows.length, 1);
    assert.equal(await contarVigentes(cicloId), 1);
  });

  test('3D10.6: anular sigue funcionando y, tras anular, registrar entra por CASE A (nueva versión legítima)', async () => {
    const org = randomOrgId();
    const { predioId, potreroId, cicloId, salidaAt } = await crearCicloFinalizado(org, 'IDEM-ANUL');
    const medicionAt = horasDespues(salidaAt, 4);
    const payload = { numeroMuestras: 8, aforoPromedioGM2: 250, medicionRealAt: medicionAt.toISOString() };
    await residualRepo.registrarResidualReal(org, predioId, potreroId, cicloId, payload);
    await residualRepo.registrarResidualReal(org, predioId, potreroId, cicloId, payload);

    await residualRepo.anularResidualReal(org, predioId, potreroId, cicloId, { motivo: 'medición errónea' });
    assert.equal(await contarVigentes(cicloId), 0);
    const { actual: trasAnular } = await residualRepo.getResidualReal(org, predioId, potreroId, cicloId);
    assert.equal(trasAnular, null);

    // Reenviar la misma medición tras anular es una decisión explícita del
    // usuario -- CASE A: nueva versión, no un "retry" de la anulada.
    const { residual: nuevo, yaExistia } = await residualRepo.registrarResidualReal(org, predioId, potreroId, cicloId, payload);
    assert.equal(yaExistia, false);
    assert.equal(nuevo.version, 2);
    assert.equal(await contarVigentes(cicloId), 1);
  });

  test('3D10.6: aplicar-a-descanso sigue funcionando tras un retry idempotente de registrar (MEDIDO sobre v1; retry de aplicar sigue idempotente)', async () => {
    const org = randomOrgId();
    const { predioId, potreroId, cicloId, salidaAt } = await crearCicloFinalizado(org, 'IDEM-APLI');
    const payload = { numeroMuestras: 8, aforoPromedioGM2: 250, medicionRealAt: horasDespues(salidaAt, 4).toISOString() };
    const { residual: v1 } = await residualRepo.registrarResidualReal(org, predioId, potreroId, cicloId, payload);
    await residualRepo.registrarResidualReal(org, predioId, potreroId, cicloId, payload);

    const primero = await residualRepo.aplicarResidualRealADescanso(org, predioId, potreroId, cicloId, {});
    assert.equal(primero.descanso.fuenteRemanente, 'MEDIDO');
    assert.equal(primero.descanso.residualRealVersionId, v1.residualId);

    // Registrar idéntico DESPUÉS de aplicar: CASE B, nunca invalida el
    // descanso MEDIDO vigente.
    const reintento = await residualRepo.registrarResidualReal(org, predioId, potreroId, cicloId, payload);
    assert.equal(reintento.yaExistia, true);
    const segundo = await residualRepo.aplicarResidualRealADescanso(org, predioId, potreroId, cicloId, {});
    assert.equal(segundo.yaExistia, true);
    assert.equal(segundo.descanso.descansoId, primero.descanso.descansoId);
  });

  test('3D10.6: registrar A, intentar B (409), anular -> ninguna versión sombra reaparece', async () => {
    const org = randomOrgId();
    const { predioId, potreroId, cicloId, salidaAt } = await crearCicloFinalizado(org, 'IDEM-SOMBRA');
    const medicionAt = horasDespues(salidaAt, 4);
    await residualRepo.registrarResidualReal(org, predioId, potreroId, cicloId, {
      numeroMuestras: 8, aforoPromedioGM2: 250, medicionRealAt: medicionAt.toISOString(),
    });
    await assert.rejects(
      () => residualRepo.registrarResidualReal(org, predioId, potreroId, cicloId, {
        numeroMuestras: 9, aforoPromedioGM2: 260, medicionRealAt: medicionAt.toISOString(),
      }),
      esResidualYaRegistrado,
    );

    await residualRepo.anularResidualReal(org, predioId, potreroId, cicloId, { motivo: 'medición errónea' });

    const { actual } = await residualRepo.getResidualReal(org, predioId, potreroId, cicloId);
    assert.equal(actual, null, 'antes de 3D10.6 una v1 no invalidada reaparecía aquí como vigente');
    assert.equal(await contarVersiones(cicloId), 1);
    assert.equal(await contarVigentes(cicloId), 0);
  });

  test('3D10.6: registrar -> corregir la salida del ciclo -> reintento idéntico es CASE B (sin 400 temporal); uno distinto es 409', async () => {
    const org = randomOrgId();
    const { predioId, potreroId, cicloId, salidaAt } = await crearCicloFinalizado(org, 'IDEM-TEMP', { horasOcupacion: 24 });
    const medicionAt = horasDespues(salidaAt, 2);
    const payload = { numeroMuestras: 8, aforoPromedioGM2: 250, medicionRealAt: medicionAt.toISOString() };
    const { residual: v1 } = await residualRepo.registrarResidualReal(org, predioId, potreroId, cicloId, payload);

    // La nueva salida (+3 días) deja la medición ANTES de la salida -- un
    // registro nuevo sería RESIDUAL_ANTERIOR_O_IGUAL_A_SALIDA (400), pero
    // un reintento devuelve lo guardado, nunca se re-valida.
    const nuevaFechaSalida = new Date(salidaAt.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    await cicloRepo.corregirCicloPastoreo(org, predioId, potreroId, cicloId, {
      fechaSalidaReal: nuevaFechaSalida, motivo: 'corrección de fecha de salida', climatologyFetchImpl: SIN_RED_FETCH_IMPL,
    });

    const reintento = await residualRepo.registrarResidualReal(org, predioId, potreroId, cicloId, payload);
    assert.equal(reintento.yaExistia, true);
    assert.equal(reintento.residual.residualId, v1.residualId);

    await assert.rejects(
      () => residualRepo.registrarResidualReal(org, predioId, potreroId, cicloId, { ...payload, numeroMuestras: 9 }),
      esResidualYaRegistrado,
    );
    assert.equal(await contarVersiones(cicloId), 1);
  });

  // -----------------------------------------------------------------------
  // Concurrencia (resto de operaciones -- sin cambios en 3D10.6).
  // -----------------------------------------------------------------------

  test('concurrencia: dos actualizar-comparativo simultáneos -- nunca dos versiones vigentes', async () => {
    const org = randomOrgId();
    const { predioId, potreroId, cicloId, salidaAt } = await crearCicloFinalizado(org, 'CONC-B');
    const medicionAt = horasDespues(salidaAt, 4);
    await residualRepo.registrarResidualReal(org, predioId, potreroId, cicloId, {
      numeroMuestras: 8, aforoPromedioGM2: 250, medicionRealAt: medicionAt.toISOString(),
    });

    await Promise.all([
      residualRepo.actualizarComparativoResidualReal(org, predioId, potreroId, cicloId, {}),
      residualRepo.actualizarComparativoResidualReal(org, predioId, potreroId, cicloId, {}),
    ]);

    const vigentes = await adminPool.query(
      `select residual_id from agx.potrero_ciclo_residuales_reales_versiones r
        where r.ciclo_id = $1
          and not exists (select 1 from agx.potrero_ciclo_residual_real_invalidaciones i where i.residual_id = r.residual_id)`,
      [cicloId],
    );
    assert.equal(vigentes.rows.length, 1, 'el FOR UPDATE del ciclo serializa -- nunca dos versiones vigentes simultáneas');
  });

  test('concurrencia: dos aplicar-a-descanso simultáneos -- una sola versión MEDIDA', async () => {
    const org = randomOrgId();
    const { predioId, potreroId, cicloId, salidaAt } = await crearCicloFinalizado(org, 'CONC-C');
    const medicionAt = horasDespues(salidaAt, 4);
    await residualRepo.registrarResidualReal(org, predioId, potreroId, cicloId, {
      numeroMuestras: 8, aforoPromedioGM2: 250, medicionRealAt: medicionAt.toISOString(),
    });

    await Promise.all([
      residualRepo.aplicarResidualRealADescanso(org, predioId, potreroId, cicloId, {}),
      residualRepo.aplicarResidualRealADescanso(org, predioId, potreroId, cicloId, {}),
    ]);

    const medidos = await adminPool.query(
      `select descanso_id from agx.potrero_recomendaciones_descanso
        where ciclo_pastoreo_id = $1 and fuente_remanente = 'MEDIDO'`,
      [cicloId],
    );
    assert.equal(medidos.rows.length, 1, 'el FOR UPDATE del ciclo serializa -- nunca dos versiones MEDIDO');
  });

  test('concurrencia: dos corregirResidualReal simultáneos con el mismo cambio -- serialización coherente, sin versión duplicada', async () => {
    const org = randomOrgId();
    const { predioId, potreroId, cicloId, salidaAt } = await crearCicloFinalizado(org, 'CONC-D');
    const medicionAt = horasDespues(salidaAt, 4);
    await residualRepo.registrarResidualReal(org, predioId, potreroId, cicloId, {
      numeroMuestras: 8, aforoPromedioGM2: 250, medicionRealAt: medicionAt.toISOString(),
    });

    await Promise.all([
      residualRepo.corregirResidualReal(org, predioId, potreroId, cicloId, { aforoPromedioGM2: 300 }),
      residualRepo.corregirResidualReal(org, predioId, potreroId, cicloId, { aforoPromedioGM2: 300 }),
    ]);

    const versiones = await adminPool.query('select count(*)::int as n from agx.potrero_ciclo_residuales_reales_versiones where ciclo_id = $1', [cicloId]);
    assert.equal(versiones.rows[0].n, 2, 'el FOR UPDATE del ciclo serializa -- v1 original + una sola v2 corregida, nunca v3');
  });
});
