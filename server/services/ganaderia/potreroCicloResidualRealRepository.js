// SPRINT-3D9.4 -- RESIDUAL REAL POST-PASTOREO
//
// Medición REAL de biomasa tomada DESPUÉS de la salida de un ciclo, para
// comparar el remanente ESTIMADO (3D9.3, computeRealPressureCore) contra
// el remanente MEDIDO en campo. ESTIMADO != MEDIDO -- nunca se presenta
// una estimación como observación real.
//
// Jerarquía de evidencia (ver 0017_potrero_ciclo_residuales_reales.sql):
// NIVEL 0 (hecho físico, SIEMPRE persistible) nunca depende de NIVEL 1
// (%MS/remanente medido), que nunca depende de NIVEL 2 (comparación
// contra el descanso REAL vigente). Ninguno se sustituye por PLAN.
//
// comparativoEstado se DERIVA en lectura (resolveComparativoEstado, única
// función central -- nunca duplicada en cada endpoint), nunca se
// persiste: es inequívocamente calculable cruzando las columnas del
// residual contra el estado vigente actual del ciclo.
import { withOrganizacionTransaction } from '../../db/agxBusinessPool.js';
import { computeBiomasaTotalKg, AFORO_MAX_G_M2 } from './potreroFichaProductivaRepository.js';
import { resolveTipoPasturaBotanico } from './potreroRecomendacionPastoreoRepository.js';
import { resolvePastureClimateParams } from './motorPastoreoAuto/pastureClimateEngine.js';
import { computeMateriaSecaTotalKg } from './capacidadPastoreoFormulas.js';
import { fetchSnapshotLoteRealVigente } from './potreroCicloRealPressureRepository.js';
import {
  fetchDescansoVigentePorCiclo,
  invalidarDescansoVersion,
  insertDescansoPostCicloRealVersion,
} from './potreroDescansoRepository.js';
import {
  computeAjustePresionDias,
  computeRangoDescansoDias,
  computeFechasReingreso,
  resolveCondicionesReentrada,
} from './motorDescansoAuto/descansoFormulas.js';

const MS_POR_HORA = 60 * 60 * 1000;

function semanticError(code, status, message) {
  return Object.assign(new Error(message || code), { status, code });
}

function assertPredioIdFormat(predioId) {
  if (!/^\d+$/.test(String(predioId))) {
    throw semanticError('INVALID_PREDIO_ID', 400, 'predioId inválido.');
  }
}

function assertPotreroIdFormat(potreroId) {
  if (!/^\d+$/.test(String(potreroId))) {
    throw semanticError('INVALID_POTRERO_ID', 400, 'potreroId inválido.');
  }
}

function assertCicloIdFormat(cicloId) {
  if (!/^\d+$/.test(String(cicloId))) {
    throw semanticError('INVALID_CICLO_ID', 400, 'cicloId inválido.');
  }
}

function assertNumeroMuestras(numeroMuestras) {
  if (!Number.isInteger(numeroMuestras) || numeroMuestras < 1) {
    throw semanticError('INVALID_NUMERO_MUESTRAS', 400, 'numeroMuestras debe ser un entero mayor o igual a 1.');
  }
}

function assertAforoPromedioGM2(aforoPromedioGM2) {
  if (!Number.isFinite(aforoPromedioGM2) || aforoPromedioGM2 < 0 || aforoPromedioGM2 > AFORO_MAX_G_M2) {
    throw semanticError('INVALID_AFORO_PROMEDIO', 400, `aforoPromedioGM2 debe ser un número entre 0 y ${AFORO_MAX_G_M2}.`);
  }
}

function parseMedicionRealAt(medicionRealAt) {
  const fecha = new Date(medicionRealAt);
  if (Number.isNaN(fecha.getTime())) {
    throw semanticError('INVALID_MEDICION_REAL_AT', 400, 'medicionRealAt debe ser una fecha/hora válida.');
  }
  return fecha;
}

// SELECT con lock -- misma consulta lee el reloj DE LA BASE (db_now) que
// gobierna toda validación temporal (nunca el reloj del cliente), en la
// MISMA transacción que valida y persiste (Design Revision residual §2).
async function fetchCicloParaResidual(client, { predioId, potreroId, cicloId }) {
  const result = await client.query(
    `select ciclo_id, estado,
            to_char(fecha_ingreso_real, 'YYYY-MM-DD') as fecha_ingreso_real,
            to_char(fecha_salida_real, 'YYYY-MM-DD') as fecha_salida_real,
            salida_real_at, now() as db_now
       from agx.potrero_ciclos_pastoreo
      where ciclo_id = $1 and potrero_id = $2 and predio_id = $3
      for update`,
    [cicloId, potreroId, predioId],
  );
  if (result.rows.length === 0) {
    throw semanticError('CICLO_NOT_FOUND', 404, 'El ciclo de pastoreo no existe o no pertenece a este potrero.');
  }
  const ciclo = result.rows[0];
  if (ciclo.estado !== 'FINALIZADO') {
    throw semanticError('CICLO_NO_FINALIZADO', 409, 'Solo un ciclo finalizado puede tener residual real.');
  }
  if (!ciclo.salida_real_at) {
    // Defensa en profundidad -- un ciclo FINALIZADO siempre tiene
    // salida_real_at (invariante de finalizarCicloPastoreo), pero nunca se
    // asume sin verificar.
    throw semanticError('CICLO_SIN_SALIDA_REAL', 409, 'El ciclo finalizado no tiene salida_real_at registrada.');
  }
  return ciclo;
}

async function fetchAreaHaPotrero(client, predioId, potreroId) {
  const result = await client.query(
    'select area_ha from agx.potreros where potrero_id = $1 and predio_id = $2',
    [potreroId, predioId],
  );
  if (result.rows.length === 0) {
    throw semanticError('POTRERO_NOT_FOUND', 404, 'El potrero no existe, no pertenece a este predio o no pertenece a tu organización.');
  }
  return Number(result.rows[0].area_ha);
}

// Mismo criterio de duplicación pequeña ya usado en este dominio
// (potreroCicloRealPressureRepository.js/potreroRecomendacionPastoreoRepository.js/
// potreroDescansoRepository.js cada uno tienen su propia copia de esta
// misma consulta) -- clima MÁS RECIENTE del potrero, opcional, nunca
// bloquea el cálculo si falta.
async function fetchContextoMasReciente(client, potreroId) {
  const result = await client.query(
    `select precipitacion_7d_mm
       from agx.potrero_contextos_agroclimaticos
      where potrero_id = $1
      order by created_at desc
      limit 1`,
    [potreroId],
  );
  return result.rows[0] ?? null;
}

async function fetchFichaBase(client, fichaId, potreroId) {
  const result = await client.query(
    `select ficha_id, tipo_cobertura from agx.potrero_fichas_productivas where ficha_id = $1 and potrero_id = $2`,
    [fichaId, potreroId],
  );
  return result.rows[0] ?? null;
}

/**
 * NIVEL 1 -- %MS resuelto vía la MISMA resolución de pastura/clima que
 * 3D9.3 (resolvePastureClimateParams), reutilizada sin cambios (nunca una
 * fórmula nueva, nunca un fetch climático adicional al ya existente).
 * Devuelve `{ disponible: false }` sin lanzar cuando la evidencia es
 * insuficiente -- es un resultado válido del dominio (PENDIENTE_MATERIA_SECA).
 */
async function resolverNivel1MateriaSeca(client, { potreroId, snapshotVigente }) {
  if (!snapshotVigente || !snapshotVigente.fichaIdBaseReal) {
    return { disponible: false };
  }
  const fichaRow = await fetchFichaBase(client, snapshotVigente.fichaIdBaseReal, potreroId);
  if (!fichaRow) {
    return { disponible: false };
  }
  const { tipo, nombreComun, nombreCientifico } = await resolveTipoPasturaBotanico(client, fichaRow);
  const contextoRow = await fetchContextoMasReciente(client, potreroId);
  const pastureClimate = resolvePastureClimateParams(
    tipo,
    { nombreComun, nombreCientifico },
    { precipitacion7dMm: contextoRow?.precipitacion_7d_mm ?? null },
    null,
  );
  return {
    disponible: true,
    materiaSecaPct: pastureClimate.materiaSecaPct,
    materiaSecaFuente: pastureClimate.dryMatterSource,
  };
}

/**
 * NIVEL 2 -- descanso REAL vigente del ciclo, cuyo remanente estimado se
 * congela para comparar. Independiente de NIVEL 1: puede estar disponible
 * aunque %MS no lo esté (o viceversa). Exige que el `loteRealVersionId`
 * congelado en el descanso coincida con el snapshot vigente pasado -- si
 * no coincide, ese descanso REAL ya no es representativo del snapshot
 * actual y no se usa como origen (evita anclar un origen inconsistente).
 */
async function resolverNivel2EstimadoOrigen(client, { cicloId, snapshotVigente }) {
  const descansoVigente = await fetchDescansoVigentePorCiclo(client, cicloId);
  if (!descansoVigente || descansoVigente.fuentePresion !== 'REAL') {
    return { disponible: false };
  }
  if (!snapshotVigente || descansoVigente.loteRealVersionId !== String(snapshotVigente.snapshotId)) {
    return { disponible: false };
  }
  const remanenteEstimadoKgMs = descansoVigente.planVsReal?.real?.remanenteEstimadoKg;
  if (typeof remanenteEstimadoKgMs !== 'number' || !Number.isFinite(remanenteEstimadoKgMs)) {
    return { disponible: false };
  }
  return {
    disponible: true,
    descansoEstimadoOrigenId: Number(descansoVigente.descansoId),
    remanenteEstimadoKgMs,
  };
}

function computeErrorComparativo(remanenteMedidoKgMs, remanenteEstimadoKgMs) {
  if (remanenteMedidoKgMs === null || remanenteEstimadoKgMs === null) {
    return { errorAbsolutoKg: null, errorPorcentual: null };
  }
  const errorAbsolutoKg = remanenteMedidoKgMs - remanenteEstimadoKgMs;
  // División por cero evitada explícitamente -- nunca 0 ni Infinity.
  const errorPorcentual = remanenteEstimadoKgMs > 0 ? errorAbsolutoKg / remanenteEstimadoKgMs : null;
  return { errorAbsolutoKg, errorPorcentual };
}

const RESIDUAL_SELECT = `residual_id, organizacion_id, predio_id, potrero_id, ciclo_id, version,
       numero_muestras, aforo_promedio_g_m2, biomasa_fresca_total_kg,
       medicion_real_at, horas_desde_salida,
       snapshot_lote_real_id, descanso_estimado_origen_id,
       materia_seca_pct_aplicado, materia_seca_fuente, materia_seca_pct_medida,
       remanente_medido_kg_ms, remanente_estimado_kg_ms_congelado,
       error_absoluto_kg, error_porcentual,
       observacion, actor_cuenta_id, created_at`;

function serializeResidualRow(row) {
  return {
    residualId: String(row.residual_id),
    cicloId: String(row.ciclo_id),
    version: Number(row.version),
    numeroMuestras: Number(row.numero_muestras),
    aforoPromedioGM2: Number(row.aforo_promedio_g_m2),
    biomasaFrescaTotalKg: Number(row.biomasa_fresca_total_kg),
    medicionRealAt: row.medicion_real_at,
    horasDesdeSalida: Number(row.horas_desde_salida),
    snapshotLoteRealId: row.snapshot_lote_real_id === null ? null : String(row.snapshot_lote_real_id),
    descansoEstimadoOrigenId: row.descanso_estimado_origen_id === null ? null : String(row.descanso_estimado_origen_id),
    materiaSecaPctAplicado: row.materia_seca_pct_aplicado === null ? null : Number(row.materia_seca_pct_aplicado),
    materiaSecaFuente: row.materia_seca_fuente ?? null,
    materiaSecaPctMedida: row.materia_seca_pct_medida === null ? null : Number(row.materia_seca_pct_medida),
    remanenteMedidoKgMs: row.remanente_medido_kg_ms === null ? null : Number(row.remanente_medido_kg_ms),
    remanenteEstimadoKgMsCongelado: row.remanente_estimado_kg_ms_congelado === null ? null : Number(row.remanente_estimado_kg_ms_congelado),
    errorAbsolutoKg: row.error_absoluto_kg === null ? null : Number(row.error_absoluto_kg),
    errorPorcentual: row.error_porcentual === null ? null : Number(row.error_porcentual),
    observacion: row.observacion ?? null,
    createdAt: row.created_at,
  };
}

/**
 * SPRINT-3D9.4, precedencia exacta (Final Gate Revision punto 2) --
 * ÚNICA función que decide comparativoEstado, reutilizada por GET y por
 * el guard de aplicar-a-descanso (nunca duplicada). Nunca persistido --
 * derivado cruzando el residual contra el estado VIGENTE actual del
 * ciclo (snapshotVigenteId/salidaRealAtVigente).
 */
export function resolveComparativoEstado(residual, { snapshotVigenteId, salidaRealAtVigente }) {
  const medicionMs = new Date(residual.medicionRealAt).getTime();
  const salidaMs = new Date(salidaRealAtVigente).getTime();
  if (medicionMs <= salidaMs) {
    return 'INCOMPATIBLE_TEMPORAL';
  }
  if (residual.snapshotLoteRealId !== null && residual.snapshotLoteRealId !== (snapshotVigenteId ?? null)) {
    return 'DESACTUALIZADO_POR_CORRECCION';
  }
  if (residual.materiaSecaPctAplicado === null || residual.remanenteMedidoKgMs === null) {
    return 'PENDIENTE_MATERIA_SECA';
  }
  if (residual.descansoEstimadoOrigenId === null || residual.remanenteEstimadoKgMsCongelado === null) {
    return 'PENDIENTE_ESTIMADO';
  }
  return 'COMPLETO';
}

/** Versión vigente (mayor número sin invalidación) -- null si el ciclo nunca tuvo residual. */
export async function fetchResidualRealVigente(client, cicloId) {
  const result = await client.query(
    `select ${RESIDUAL_SELECT}
       from agx.potrero_ciclo_residuales_reales_versiones r
      where r.ciclo_id = $1
        and not exists (select 1 from agx.potrero_ciclo_residual_real_invalidaciones i where i.residual_id = r.residual_id)
      order by r.version desc
      limit 1`,
    [cicloId],
  );
  return result.rows.length > 0 ? serializeResidualRow(result.rows[0]) : null;
}

async function insertarVersionResidual(client, {
  organizacionId, predioId, potreroId, cicloId, version,
  numeroMuestras, aforoPromedioGM2, biomasaFrescaTotalKg, medicionRealAt, horasDesdeSalida,
  snapshotLoteRealId, descansoEstimadoOrigenId,
  materiaSecaPctAplicado, materiaSecaFuente,
  remanenteMedidoKgMs, remanenteEstimadoKgMsCongelado, errorAbsolutoKg, errorPorcentual,
  observacion, actorCuentaId, createdAt,
}) {
  await client.query('SAVEPOINT residual_real_insert');
  try {
    const result = await client.query(
      `insert into agx.potrero_ciclo_residuales_reales_versiones
         (organizacion_id, predio_id, potrero_id, ciclo_id, version,
          numero_muestras, aforo_promedio_g_m2, biomasa_fresca_total_kg, medicion_real_at, horas_desde_salida,
          snapshot_lote_real_id, descanso_estimado_origen_id,
          materia_seca_pct_aplicado, materia_seca_fuente,
          remanente_medido_kg_ms, remanente_estimado_kg_ms_congelado, error_absoluto_kg, error_porcentual,
          observacion, actor_cuenta_id, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
       returning ${RESIDUAL_SELECT}`,
      [
        organizacionId, predioId, potreroId, cicloId, version,
        numeroMuestras, aforoPromedioGM2, biomasaFrescaTotalKg, medicionRealAt, horasDesdeSalida,
        snapshotLoteRealId, descansoEstimadoOrigenId,
        materiaSecaPctAplicado, materiaSecaFuente,
        remanenteMedidoKgMs, remanenteEstimadoKgMsCongelado, errorAbsolutoKg, errorPorcentual,
        observacion ?? null, actorCuentaId ?? null, createdAt,
      ],
    );
    return { residual: serializeResidualRow(result.rows[0]), yaExistia: false };
  } catch (error) {
    if (error.code === '23505') {
      await client.query('ROLLBACK TO SAVEPOINT residual_real_insert');
      const ganadora = await client.query(
        `select ${RESIDUAL_SELECT} from agx.potrero_ciclo_residuales_reales_versiones where ciclo_id = $1 and version = $2`,
        [cicloId, version],
      );
      return { residual: serializeResidualRow(ganadora.rows[0]), yaExistia: true };
    }
    throw error;
  }
}

async function insertEvento(client, { organizacionId, potreroId, cicloId, tipoEvento, actorCuentaId, payload, now }) {
  await client.query(
    `insert into agx.potrero_ciclo_eventos (organizacion_id, potrero_id, ciclo_id, tipo_evento, ocurrido_en, actor_cuenta_id, payload_json)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [organizacionId, potreroId, cicloId, tipoEvento, now ?? new Date(), actorCuentaId ?? null, JSON.stringify(payload ?? {})],
  );
}

async function siguienteVersion(client, cicloId) {
  const result = await client.query(
    'select coalesce(max(version), 0) as max_version from agx.potrero_ciclo_residuales_reales_versiones where ciclo_id = $1',
    [cicloId],
  );
  return Number(result.rows[0].max_version) + 1;
}

/**
 * Captura el hecho físico -- SIEMPRE persistible aunque falle el
 * proveedor climático, no exista descanso REAL, o %MS no pueda
 * resolverse (Final Gate Revision punto 1). NUNCA rechaza por falta de
 * ciencia -- solo por invalidez del propio hecho (temporalidad).
 */
export async function registrarResidualReal(organizacionId, predioId, potreroId, cicloId, {
  numeroMuestras, aforoPromedioGM2, medicionRealAt, observacion, actorCuentaId,
}) {
  assertPredioIdFormat(predioId);
  assertPotreroIdFormat(potreroId);
  assertCicloIdFormat(cicloId);
  assertNumeroMuestras(numeroMuestras);
  assertAforoPromedioGM2(aforoPromedioGM2);
  const medicionRealAtDate = parseMedicionRealAt(medicionRealAt);
  if (observacion !== undefined && observacion !== null && typeof observacion !== 'string') {
    throw semanticError('INVALID_OBSERVACION', 400, 'observacion debe ser texto.');
  }

  return withOrganizacionTransaction(organizacionId, async (client) => {
    const ciclo = await fetchCicloParaResidual(client, { predioId, potreroId, cicloId });
    const dbNow = new Date(ciclo.db_now);
    const salidaRealAt = new Date(ciclo.salida_real_at);

    if (medicionRealAtDate.getTime() <= salidaRealAt.getTime()) {
      throw semanticError('RESIDUAL_ANTERIOR_O_IGUAL_A_SALIDA', 400, 'medicionRealAt debe ser posterior a la salida real del ciclo.');
    }
    if (medicionRealAtDate.getTime() > dbNow.getTime()) {
      throw semanticError('RESIDUAL_FUTURO_INVALIDO', 400, 'medicionRealAt no puede ser posterior al momento del registro.');
    }
    const horasDesdeSalida = (medicionRealAtDate.getTime() - salidaRealAt.getTime()) / MS_POR_HORA;

    const areaHa = await fetchAreaHaPotrero(client, predioId, potreroId);
    const biomasaFrescaTotalKg = computeBiomasaTotalKg(areaHa, aforoPromedioGM2);

    const snapshotVigente = await fetchSnapshotLoteRealVigente(client, cicloId);
    const nivel1 = await resolverNivel1MateriaSeca(client, { potreroId, snapshotVigente });
    const remanenteMedidoKgMs = nivel1.disponible
      ? computeMateriaSecaTotalKg(biomasaFrescaTotalKg, nivel1.materiaSecaPct)
      : null;

    const nivel2 = await resolverNivel2EstimadoOrigen(client, { cicloId, snapshotVigente });
    const { errorAbsolutoKg, errorPorcentual } = computeErrorComparativo(
      remanenteMedidoKgMs,
      nivel2.disponible ? nivel2.remanenteEstimadoKgMs : null,
    );

    const version = await siguienteVersion(client, cicloId);
    const { residual, yaExistia } = await insertarVersionResidual(client, {
      organizacionId, predioId, potreroId, cicloId, version,
      numeroMuestras, aforoPromedioGM2, biomasaFrescaTotalKg,
      medicionRealAt: medicionRealAtDate, horasDesdeSalida,
      snapshotLoteRealId: snapshotVigente ? Number(snapshotVigente.snapshotId) : null,
      descansoEstimadoOrigenId: nivel2.disponible ? nivel2.descansoEstimadoOrigenId : null,
      materiaSecaPctAplicado: nivel1.disponible ? nivel1.materiaSecaPct : null,
      materiaSecaFuente: nivel1.disponible ? nivel1.materiaSecaFuente : null,
      remanenteMedidoKgMs,
      remanenteEstimadoKgMsCongelado: nivel2.disponible ? nivel2.remanenteEstimadoKgMs : null,
      errorAbsolutoKg, errorPorcentual,
      observacion, actorCuentaId, createdAt: dbNow,
    });

    if (!yaExistia) {
      await insertEvento(client, {
        organizacionId, potreroId, cicloId, tipoEvento: 'RESIDUAL_REAL_REGISTRADO', actorCuentaId, now: dbNow,
        payload: { residualId: residual.residualId, version },
      });
    }
    return { residual, yaExistia };
  });
}

/**
 * Núcleo compartido por actualizarComparativoResidualReal y
 * corregirResidualReal -- ambos crean una nueva versión append-only que
 * re-resuelve NIVEL 1/NIVEL 2 contra el estado vigente actual del ciclo;
 * la única diferencia es si el hecho físico (numeroMuestras/aforoPromedioGM2/
 * medicionRealAt/observacion) cambia o se conserva. Si la versión que se
 * invalida sustentaba un descanso MEDIDO vigente, ese descanso se invalida
 * en la MISMA transacción -- nunca se revierte automáticamente a
 * ESTIMADO (queda "pendiente de recálculo").
 */
async function crearSiguienteVersionResidual(client, {
  organizacionId, predioId, potreroId, cicloId, ciclo, vigente,
  numeroMuestras, aforoPromedioGM2, medicionRealAtDate, observacion, actorCuentaId, dbNow,
  motivoInvalidacion, tipoEvento, payloadEventoExtra,
}) {
  const salidaRealAt = new Date(ciclo.salida_real_at);
  const horasDesdeSalida = (medicionRealAtDate.getTime() - salidaRealAt.getTime()) / MS_POR_HORA;

  const areaHa = await fetchAreaHaPotrero(client, predioId, potreroId);
  const biomasaFrescaTotalKg = computeBiomasaTotalKg(areaHa, aforoPromedioGM2);

  const snapshotVigente = await fetchSnapshotLoteRealVigente(client, cicloId);
  const nivel1 = await resolverNivel1MateriaSeca(client, { potreroId, snapshotVigente });
  const remanenteMedidoKgMs = nivel1.disponible
    ? computeMateriaSecaTotalKg(biomasaFrescaTotalKg, nivel1.materiaSecaPct)
    : null;

  const nivel2 = await resolverNivel2EstimadoOrigen(client, { cicloId, snapshotVigente });
  const { errorAbsolutoKg, errorPorcentual } = computeErrorComparativo(
    remanenteMedidoKgMs,
    nivel2.disponible ? nivel2.remanenteEstimadoKgMs : null,
  );

  const version = await siguienteVersion(client, cicloId);
  const { residual } = await insertarVersionResidual(client, {
    organizacionId, predioId, potreroId, cicloId, version,
    numeroMuestras, aforoPromedioGM2, biomasaFrescaTotalKg,
    medicionRealAt: medicionRealAtDate, horasDesdeSalida,
    snapshotLoteRealId: snapshotVigente ? Number(snapshotVigente.snapshotId) : null,
    descansoEstimadoOrigenId: nivel2.disponible ? nivel2.descansoEstimadoOrigenId : null,
    materiaSecaPctAplicado: nivel1.disponible ? nivel1.materiaSecaPct : null,
    materiaSecaFuente: nivel1.disponible ? nivel1.materiaSecaFuente : null,
    remanenteMedidoKgMs,
    remanenteEstimadoKgMsCongelado: nivel2.disponible ? nivel2.remanenteEstimadoKgMs : null,
    errorAbsolutoKg, errorPorcentual,
    observacion, actorCuentaId, createdAt: dbNow,
  });

  try {
    await client.query(
      `insert into agx.potrero_ciclo_residual_real_invalidaciones
         (organizacion_id, potrero_id, residual_id, ciclo_id, motivo, actor_cuenta_id)
       values ($1, $2, $3, $4, $5, $6)`,
      [organizacionId, potreroId, vigente.residualId, cicloId, motivoInvalidacion, actorCuentaId ?? null],
    );
  } catch (error) {
    if (error.code !== '23505') throw error; // ya invalidada -- idempotente
  }

  // La medición anterior queda superada -- si sustentaba un descanso
  // MEDIDO vigente, ese descanso ya no refleja evidencia vigente. Se
  // invalida en la MISMA transacción; NUNCA se revierte solo a ESTIMADO.
  const descansoVigente = await fetchDescansoVigentePorCiclo(client, cicloId);
  if (descansoVigente && descansoVigente.fuenteRemanente === 'MEDIDO' && descansoVigente.residualRealVersionId === vigente.residualId) {
    await invalidarDescansoVersion(client, {
      descansoId: Number(descansoVigente.descansoId),
      cicloPastoreoId: cicloId,
      potreroId,
      organizacionId,
      motivo: motivoInvalidacion,
      actorCuentaId,
    });
  }

  await insertEvento(client, {
    organizacionId, potreroId, cicloId, tipoEvento, actorCuentaId, now: dbNow,
    payload: { residualId: residual.residualId, version, residualAnteriorId: vigente.residualId, ...payloadEventoExtra },
  });

  return { residual };
}

/**
 * Completa progresivamente lo que esté disponible AHORA (Final Gate
 * Revision punto 3/D) -- SIEMPRE nueva versión append-only, nunca UPDATE.
 * Conserva sin cambios el hecho físico (numeroMuestras/aforoPromedioGM2/
 * biomasaFrescaTotalKg/medicionRealAt); recalcula horasDesdeSalida contra
 * la salida VIGENTE y re-resuelve NIVEL 1/NIVEL 2 contra el estado
 * vigente actual del ciclo.
 */
export async function actualizarComparativoResidualReal(organizacionId, predioId, potreroId, cicloId, { actorCuentaId } = {}) {
  assertPredioIdFormat(predioId);
  assertPotreroIdFormat(potreroId);
  assertCicloIdFormat(cicloId);

  return withOrganizacionTransaction(organizacionId, async (client) => {
    const ciclo = await fetchCicloParaResidual(client, { predioId, potreroId, cicloId });
    const dbNow = new Date(ciclo.db_now);

    const vigente = await fetchResidualRealVigente(client, cicloId);
    if (!vigente) {
      throw semanticError('RESIDUAL_NOT_FOUND', 404, 'Este ciclo todavía no tiene un residual real registrado.');
    }

    return crearSiguienteVersionResidual(client, {
      organizacionId, predioId, potreroId, cicloId, ciclo, vigente,
      numeroMuestras: vigente.numeroMuestras,
      aforoPromedioGM2: vigente.aforoPromedioGM2,
      medicionRealAtDate: new Date(vigente.medicionRealAt),
      observacion: vigente.observacion,
      actorCuentaId, dbNow,
      motivoInvalidacion: 'actualizar_comparativo',
      tipoEvento: 'RESIDUAL_REAL_COMPARATIVO_ACTUALIZADO',
    });
  });
}

/**
 * Corrige el hecho físico de un residual ya registrado (numeroMuestras/
 * aforoPromedioGM2/medicionRealAt/observacion mal digitados). Nueva
 * versión completa (nunca UPDATE); recalcula server-side biomasa/horas/
 * %MS/remanente/comparativo. Retry idempotente si ningún campo cambia
 * respecto a la versión vigente.
 */
export async function corregirResidualReal(organizacionId, predioId, potreroId, cicloId, {
  numeroMuestras, aforoPromedioGM2, medicionRealAt, observacion, actorCuentaId,
} = {}) {
  assertPredioIdFormat(predioId);
  assertPotreroIdFormat(potreroId);
  assertCicloIdFormat(cicloId);
  if (numeroMuestras !== undefined) assertNumeroMuestras(numeroMuestras);
  if (aforoPromedioGM2 !== undefined) assertAforoPromedioGM2(aforoPromedioGM2);
  if (observacion !== undefined && observacion !== null && typeof observacion !== 'string') {
    throw semanticError('INVALID_OBSERVACION', 400, 'observacion debe ser texto.');
  }
  const algunCampo = [numeroMuestras, aforoPromedioGM2, medicionRealAt, observacion].some((v) => v !== undefined);
  if (!algunCampo) {
    throw semanticError('SIN_CAMBIOS_SOLICITADOS', 400, 'Debes indicar al menos un campo a corregir.');
  }

  return withOrganizacionTransaction(organizacionId, async (client) => {
    const ciclo = await fetchCicloParaResidual(client, { predioId, potreroId, cicloId });
    const dbNow = new Date(ciclo.db_now);
    const salidaRealAt = new Date(ciclo.salida_real_at);

    const vigente = await fetchResidualRealVigente(client, cicloId);
    if (!vigente) {
      throw semanticError('RESIDUAL_NOT_FOUND', 404, 'Este ciclo todavía no tiene un residual real registrado.');
    }

    const numeroMuestrasEfectivo = numeroMuestras !== undefined ? numeroMuestras : vigente.numeroMuestras;
    const aforoPromedioGM2Efectivo = aforoPromedioGM2 !== undefined ? aforoPromedioGM2 : vigente.aforoPromedioGM2;
    const medicionRealAtEfectivo = medicionRealAt !== undefined ? parseMedicionRealAt(medicionRealAt) : new Date(vigente.medicionRealAt);
    const observacionEfectiva = observacion !== undefined ? observacion : vigente.observacion;

    if (medicionRealAtEfectivo.getTime() <= salidaRealAt.getTime()) {
      throw semanticError('RESIDUAL_ANTERIOR_O_IGUAL_A_SALIDA', 400, 'medicionRealAt debe ser posterior a la salida real del ciclo.');
    }
    if (medicionRealAtEfectivo.getTime() > dbNow.getTime()) {
      throw semanticError('RESIDUAL_FUTURO_INVALIDO', 400, 'medicionRealAt no puede ser posterior al momento del registro.');
    }

    const huboCambios = (
      numeroMuestrasEfectivo !== vigente.numeroMuestras
      || aforoPromedioGM2Efectivo !== vigente.aforoPromedioGM2
      || medicionRealAtEfectivo.getTime() !== new Date(vigente.medicionRealAt).getTime()
      || (observacionEfectiva ?? null) !== (vigente.observacion ?? null)
    );
    if (!huboCambios) {
      // Idempotente: retry con el mismo payload ya aplicado.
      return { residual: vigente, yaExistia: true };
    }

    const { residual } = await crearSiguienteVersionResidual(client, {
      organizacionId, predioId, potreroId, cicloId, ciclo, vigente,
      numeroMuestras: numeroMuestrasEfectivo,
      aforoPromedioGM2: aforoPromedioGM2Efectivo,
      medicionRealAtDate: medicionRealAtEfectivo,
      observacion: observacionEfectiva,
      actorCuentaId, dbNow,
      motivoInvalidacion: 'correccion_medicion_fisica',
      tipoEvento: 'RESIDUAL_REAL_CORREGIDO',
    });
    return { residual, yaExistia: false };
  });
}

/**
 * SPRINT-3D9.4 -- aplica el remanente MEDIDO al descanso. Final Gate
 * Revision punto 1/4/10: SIN fetch climático, SIN NRC, SIN recompute del
 * baseline/estimado -- todo el contexto científico se reconstruye desde
 * `parametros_fuente_json` del descanso ORIGEN (descansoEstimadoOrigenId
 * del residual, ya anclado por FK, nunca "el vigente" como sustituto). La
 * única rama que cambia es remanente/ajustePresion/rango/fechasReingreso.
 */
export async function aplicarResidualRealADescanso(organizacionId, predioId, potreroId, cicloId, { actorCuentaId } = {}) {
  assertPredioIdFormat(predioId);
  assertPotreroIdFormat(potreroId);
  assertCicloIdFormat(cicloId);

  return withOrganizacionTransaction(organizacionId, async (client) => {
    const ciclo = await fetchCicloParaResidual(client, { predioId, potreroId, cicloId });

    const vigente = await fetchResidualRealVigente(client, cicloId);
    if (!vigente) {
      throw semanticError('RESIDUAL_NOT_FOUND', 404, 'Este ciclo todavía no tiene un residual real registrado.');
    }
    const snapshotVigente = await fetchSnapshotLoteRealVigente(client, cicloId);
    const estado = resolveComparativoEstado(vigente, {
      snapshotVigenteId: snapshotVigente ? String(snapshotVigente.snapshotId) : null,
      salidaRealAtVigente: ciclo.salida_real_at,
    });
    if (estado !== 'COMPLETO') {
      throw semanticError('COMPARATIVO_NO_COMPLETO', 409, `El comparativo debe estar COMPLETO para aplicar el residual al descanso (estado actual: ${estado}).`);
    }

    const descansoVigente = await fetchDescansoVigentePorCiclo(client, cicloId);
    if (descansoVigente && descansoVigente.fuenteRemanente === 'MEDIDO' && descansoVigente.residualRealVersionId === vigente.residualId) {
      // Idempotente: retry sobre el mismo residual ya aplicado -- sin
      // nueva versión, sin evento nuevo.
      return { descanso: descansoVigente, yaExistia: true };
    }

    const origenResult = await client.query(
      `select descanso_id, ficha_id, contexto_id, recomendacion_pastoreo_id, nivel_confianza,
              agroclimate_status, applied_rules_json, parametros_fuente_json, lote_real_version_id
         from agx.potrero_recomendaciones_descanso
        where descanso_id = $1 and ciclo_pastoreo_id = $2 and potrero_id = $3 and organizacion_id = $4`,
      [vigente.descansoEstimadoOrigenId, cicloId, potreroId, organizacionId],
    );
    if (origenResult.rows.length === 0) {
      // Defensa en profundidad -- la FK tenant-safe de 0017 ya lo impide.
      throw semanticError('DESCANSO_ORIGEN_NOT_FOUND', 409, 'El descanso estimado origen del comparativo ya no es accesible.');
    }
    const origen = origenResult.rows[0];
    const parametrosFuenteOrigen = origen.parametros_fuente_json;

    // Contexto CONGELADO reconstruido -- CERO fetch climático, CERO
    // resolvePasturaDescansoBaseline, CERO NRC.
    const baseline = {
      restDaysMinReference: parametrosFuenteOrigen.pastura.restDaysMinReference,
      restDaysMaxReference: parametrosFuenteOrigen.pastura.restDaysMaxReference,
      restDaysTypicalReference: parametrosFuenteOrigen.pastura.restDaysTypicalReference,
      referenceEntryHeightCm: parametrosFuenteOrigen.pastura.referenceEntryHeightCm,
    };
    const agroClimateStatus = parametrosFuenteOrigen.agroClimate.status;

    // Única rama que cambia: remanente ESTIMADO -> MEDIDO.
    const ajustePresion = computeAjustePresionDias({
      remanenteProyectadoKg: vigente.remanenteMedidoKgMs,
      remanenteObjetivoKg: parametrosFuenteOrigen.disponibilidad.remanenteObjetivoKg,
    });
    const rango = computeRangoDescansoDias({ baseline, agroClimateStatus, deltaPresionDias: ajustePresion.deltaDias });
    const fechasReingreso = computeFechasReingreso(ciclo.fecha_salida_real, rango);
    const condicionesReentrada = resolveCondicionesReentrada({ referenceEntryHeightCm: baseline.referenceEntryHeightCm });

    const parametrosFuenteJson = {
      ...parametrosFuenteOrigen,
      disponibilidad: {
        ...parametrosFuenteOrigen.disponibilidad,
        remanenteMedidoKgMs: vigente.remanenteMedidoKgMs,
        remanenteEstimadoKgMsCongelado: vigente.remanenteEstimadoKgMsCongelado,
      },
      ajustePresion: { deltaDias: ajustePresion.deltaDias, aplicado: ajustePresion.aplicado },
      fuenteRemanente: 'MEDIDO',
      residualRealVersionId: String(vigente.residualId),
      descansoEstimadoOrigenId: String(origen.descanso_id),
    };

    const core = {
      fichaRow: { ficha_id: origen.ficha_id },
      contextoRow: origen.contexto_id ? { contexto_id: origen.contexto_id } : null,
      recomendacionRow: { recomendacion_id: origen.recomendacion_pastoreo_id },
      rango,
      fechasReingreso,
      // Frozen -- nunca recomputado (mismo criterio ya usado en el
      // dominio: nivelConfianza refleja confianza en la EVIDENCIA
      // climática/de recomendación, no en la fuente del remanente; ver
      // Pre-Commit Report, known debt).
      nivelConfianza: origen.nivel_confianza,
      assessment: { status: agroClimateStatus, appliedRules: origen.applied_rules_json },
      condicionesReentrada,
      parametrosFuenteJson,
      loteRealVersionId: origen.lote_real_version_id,
    };

    const maxVersionResult = await client.query(
      'select coalesce(max(version), 0) as max_version from agx.potrero_recomendaciones_descanso where ciclo_pastoreo_id = $1',
      [cicloId],
    );
    const version = Number(maxVersionResult.rows[0].max_version) + 1;

    if (descansoVigente) {
      await invalidarDescansoVersion(client, {
        descansoId: Number(descansoVigente.descansoId),
        cicloPastoreoId: cicloId,
        potreroId,
        organizacionId,
        motivo: 'aplicar_residual_real',
        actorCuentaId,
      });
    }

    const { descanso } = await insertDescansoPostCicloRealVersion(client, organizacionId, {
      predioId,
      potreroId,
      cicloId,
      fechaIngresoReal: ciclo.fecha_ingreso_real,
      fechaSalidaReal: ciclo.fecha_salida_real,
      previousDescansoId: descansoVigente ? Number(descansoVigente.descansoId) : null,
      version,
      core,
      fuenteRemanente: 'MEDIDO',
      residualRealVersionId: Number(vigente.residualId),
    });

    await insertEvento(client, {
      organizacionId, potreroId, cicloId, tipoEvento: 'DESCANSO_ACTUALIZADO_CON_RESIDUAL_REAL', actorCuentaId,
      payload: { residualId: vigente.residualId, descansoEstimadoOrigenId: origen.descanso_id, descansoId: descanso.descansoId },
    });

    return { descanso, yaExistia: false };
  });
}

/**
 * Anula el residual vigente -- append-only, invalidación explícita con
 * motivo obligatorio. Si sustentaba un descanso MEDIDO vigente, ese
 * descanso se invalida en la MISMA transacción -- el ciclo queda
 * "pendiente de recálculo" (Final Gate Revision punto 13): NUNCA se
 * revierte automáticamente a ESTIMADO, requiere otra acción explícita.
 */
export async function anularResidualReal(organizacionId, predioId, potreroId, cicloId, { motivo, actorCuentaId } = {}) {
  assertPredioIdFormat(predioId);
  assertPotreroIdFormat(potreroId);
  assertCicloIdFormat(cicloId);
  if (typeof motivo !== 'string' || motivo.trim() === '') {
    throw semanticError('INVALID_MOTIVO_ANULACION', 400, 'motivo es obligatorio para anular un residual real.');
  }

  return withOrganizacionTransaction(organizacionId, async (client) => {
    await client.query('select ciclo_id from agx.potrero_ciclos_pastoreo where ciclo_id = $1 and potrero_id = $2 and predio_id = $3 for update', [cicloId, potreroId, predioId]);

    const vigente = await fetchResidualRealVigente(client, cicloId);
    if (!vigente) {
      throw semanticError('RESIDUAL_NOT_FOUND', 404, 'Este ciclo todavía no tiene un residual real registrado.');
    }

    try {
      await client.query(
        `insert into agx.potrero_ciclo_residual_real_invalidaciones
           (organizacion_id, potrero_id, residual_id, ciclo_id, motivo, actor_cuenta_id)
         values ($1, $2, $3, $4, $5, $6)`,
        [organizacionId, potreroId, vigente.residualId, cicloId, motivo.trim(), actorCuentaId ?? null],
      );
    } catch (error) {
      if (error.code !== '23505') throw error; // 23505: ya invalidada -- idempotente
    }

    const descansoVigente = await fetchDescansoVigentePorCiclo(client, cicloId);
    if (descansoVigente && descansoVigente.fuenteRemanente === 'MEDIDO' && descansoVigente.residualRealVersionId === vigente.residualId) {
      await invalidarDescansoVersion(client, {
        descansoId: Number(descansoVigente.descansoId),
        cicloPastoreoId: cicloId,
        potreroId,
        organizacionId,
        motivo: 'residual_real_anulado',
        actorCuentaId,
      });
    }

    await insertEvento(client, {
      organizacionId, potreroId, cicloId, tipoEvento: 'RESIDUAL_REAL_ANULADO', actorCuentaId,
      payload: { residualId: vigente.residualId, motivo: motivo.trim() },
    });

    return { residualId: vigente.residualId };
  });
}

/**
 * GET -- residual VIGENTE (respeta invalidaciones, null si nunca hubo o
 * el único que hubo fue anulado sin reemplazo) + historial completo
 * (incluye versiones invalidadas, cada una marcada `invalidado`). Cada
 * fila lleva `comparativoEstado` derivado contra el estado VIGENTE actual
 * del ciclo -- nunca calculado distinto entre actual/historial.
 */
export async function getResidualReal(organizacionId, predioId, potreroId, cicloId) {
  assertPredioIdFormat(predioId);
  assertPotreroIdFormat(potreroId);
  assertCicloIdFormat(cicloId);

  return withOrganizacionTransaction(organizacionId, async (client) => {
    const cicloResult = await client.query(
      `select ciclo_id, salida_real_at from agx.potrero_ciclos_pastoreo where ciclo_id = $1 and potrero_id = $2 and predio_id = $3`,
      [cicloId, potreroId, predioId],
    );
    if (cicloResult.rows.length === 0) {
      throw semanticError('CICLO_NOT_FOUND', 404, 'El ciclo de pastoreo no existe o no pertenece a este potrero.');
    }
    const salidaRealAtVigente = cicloResult.rows[0].salida_real_at;
    const snapshotVigente = await fetchSnapshotLoteRealVigente(client, cicloId);
    const snapshotVigenteId = snapshotVigente ? String(snapshotVigente.snapshotId) : null;

    const actualVigente = await fetchResidualRealVigente(client, cicloId);

    const historialResult = await client.query(
      `select r.*, (i.invalidacion_id is not null) as invalidado
         from agx.potrero_ciclo_residuales_reales_versiones r
         left join agx.potrero_ciclo_residual_real_invalidaciones i on i.residual_id = r.residual_id
        where r.ciclo_id = $1
        order by r.version desc`,
      [cicloId],
    );

    const conEstado = (residual) => ({
      ...residual,
      comparativoEstado: salidaRealAtVigente
        ? resolveComparativoEstado(residual, { snapshotVigenteId, salidaRealAtVigente })
        : null,
    });

    const historial = historialResult.rows.map((row) => ({
      ...conEstado(serializeResidualRow(row)),
      invalidado: Boolean(row.invalidado),
    }));

    return {
      actual: actualVigente ? conEstado(actualVigente) : null,
      historial,
    };
  });
}
