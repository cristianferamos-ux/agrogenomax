// SPRINT-3D9.3 -- REAL PRESSURE: snapshot versionado del lote real +
// pipeline de presión REAL (descanso gobernado por lo que REALMENTE
// pastoreó, no solo por el PLAN). Todas las funciones de este archivo son
// client-scoped (reciben una transacción ya abierta) -- ninguna abre su
// propia transacción, exactamente como insertEvento/invalidarDescansoVersion
// en potreroCicloPastoreoRepository.js/potreroDescansoRepository.js.
// Quien orquesta las transacciones (iniciar/finalizar/corregir en
// potreroCicloPastoreoRepository.js, o la FASE B en
// potreroDescansoRepository.js) decide el alcance atómico exacto.
//
// FUENTE ÚNICA DE VERDAD (SPRINT-3D9.3 FINAL IMPLEMENTATION GATE, punto
// 1): para un ciclo que tiene al menos una versión en
// agx.potrero_ciclo_lote_real_versiones, esa tabla es la fuente
// científica autoritativa de categoría/cantidad/peso/lactancia/ternero/
// ficha base/timestamps -- NUNCA las columnas equivalentes de
// agx.potrero_ciclos_pastoreo, que quedan como espejo de compatibilidad
// sincronizado como efecto atómico de la MISMA transacción que crea cada
// versión nueva (ver corregirCicloPastoreo). Nunca dos caminos de
// corrección.
import {
  computeRecomendacionPastoreo,
  computeConsumoYRemanenteReal,
} from './motorPastoreoAuto/recomendacionPastoreoFormulas.js';
import { resolvePastureClimateParams } from './motorPastoreoAuto/pastureClimateEngine.js';
import { resolveTipoPasturaBotanico } from './potreroRecomendacionPastoreoRepository.js';
import { fetchCategoriaById } from './categoriaProductivaRepository.js';
import { resolveFechaHoyNegocio } from './motorDescansoAuto/businessTimezone.js';
import { withOrganizacionTransaction } from '../../db/agxBusinessPool.js';

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

async function assertPotreroBelongsToPredio(client, predioId, potreroId) {
  const result = await client.query(
    'select potrero_id from agx.potreros where potrero_id = $1 and predio_id = $2',
    [potreroId, predioId],
  );
  if (result.rows.length === 0) {
    throw semanticError('POTRERO_NOT_FOUND', 404, 'El potrero no existe, no pertenece a este predio o no pertenece a tu organización.');
  }
}

// -----------------------------------------------------------------------
// SPRINT-3D9.3 FINAL IMPLEMENTATION GATE, punto 3 -- aforo base real:
// doble guardrail. fecha_aforo (afirmación del usuario, autoreportada) Y
// created_at (hecho de sistema, no manipulable) deben ser ambos
// anteriores/iguales al ingreso real -- ninguno solo basta.
// -----------------------------------------------------------------------
export async function resolveFichaIdBaseReal(client, { potreroId, ingresoRealAt }) {
  const fechaNegocioIngreso = resolveFechaHoyNegocio(ingresoRealAt);
  const result = await client.query(
    `select ficha_id
       from agx.potrero_fichas_productivas
      where potrero_id = $1
        and fecha_aforo is not null
        and fecha_aforo <= $2
        and created_at <= $3
      order by fecha_aforo desc, created_at desc
      limit 1`,
    [potreroId, fechaNegocioIngreso, ingresoRealAt],
  );
  return result.rows.length > 0 ? Number(result.rows[0].ficha_id) : null;
}

// -----------------------------------------------------------------------
// Snapshot versionado -- CRUD client-scoped, nunca UPDATE (append-only).
// -----------------------------------------------------------------------
const SNAPSHOT_SELECT = `snapshot_id, organizacion_id, predio_id, potrero_id, ciclo_id, version,
       categoria_id, numero_animales, peso_promedio_kg,
       produccion_leche_l_dia, dias_en_leche, grasa_leche_pct, ternero_al_pie,
       ficha_id_base_real,
       ingreso_real_at, salida_real_at, actor_cuenta_id, created_at`;

function serializeSnapshotRow(row) {
  return {
    snapshotId: String(row.snapshot_id),
    cicloId: String(row.ciclo_id),
    version: Number(row.version),
    categoriaId: String(row.categoria_id),
    numeroAnimales: Number(row.numero_animales),
    pesoPromedioKg: Number(row.peso_promedio_kg),
    produccionLecheLDia: row.produccion_leche_l_dia === null ? null : Number(row.produccion_leche_l_dia),
    diasEnLeche: row.dias_en_leche === null ? null : Number(row.dias_en_leche),
    grasaLechePct: row.grasa_leche_pct === null ? null : Number(row.grasa_leche_pct),
    terneroAlPie: row.ternero_al_pie === null ? null : Boolean(row.ternero_al_pie),
    fichaIdBaseReal: row.ficha_id_base_real === null ? null : String(row.ficha_id_base_real),
    ingresoRealAt: row.ingreso_real_at,
    salidaRealAt: row.salida_real_at,
    createdAt: row.created_at,
  };
}

/**
 * Inserta una versión nueva del snapshot -- SIEMPRE un snapshot completo
 * (nunca un diff parcial), tolerante a carrera (23505 sobre
 * unique(ciclo_id, version) -> relee la fila ganadora, mismo criterio que
 * insertDescansoPostCicloRealVersion).
 */
export async function crearSnapshotLoteReal(client, {
  organizacionId, predioId, potreroId, cicloId, version,
  categoriaId, numeroAnimales, pesoPromedioKg,
  produccionLecheLDia, diasEnLeche, grasaLechePct, terneroAlPie,
  fichaIdBaseReal, ingresoRealAt, salidaRealAt, actorCuentaId,
}) {
  await client.query('SAVEPOINT snapshot_lote_real_insert');
  try {
    const result = await client.query(
      `insert into agx.potrero_ciclo_lote_real_versiones
         (organizacion_id, predio_id, potrero_id, ciclo_id, version,
          categoria_id, numero_animales, peso_promedio_kg,
          produccion_leche_l_dia, dias_en_leche, grasa_leche_pct, ternero_al_pie,
          ficha_id_base_real, ingreso_real_at, salida_real_at, actor_cuenta_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       returning ${SNAPSHOT_SELECT}`,
      [
        organizacionId, predioId, potreroId, cicloId, version,
        categoriaId, numeroAnimales, pesoPromedioKg,
        produccionLecheLDia ?? null, diasEnLeche ?? null, grasaLechePct ?? null,
        terneroAlPie === undefined ? null : terneroAlPie,
        fichaIdBaseReal ?? null, ingresoRealAt, salidaRealAt ?? null, actorCuentaId ?? null,
      ],
    );
    return { snapshot: serializeSnapshotRow(result.rows[0]), yaExistia: false };
  } catch (error) {
    if (error.code === '23505') {
      await client.query('ROLLBACK TO SAVEPOINT snapshot_lote_real_insert');
      const ganadora = await client.query(
        `select ${SNAPSHOT_SELECT} from agx.potrero_ciclo_lote_real_versiones where ciclo_id = $1 and version = $2`,
        [cicloId, version],
      );
      return { snapshot: serializeSnapshotRow(ganadora.rows[0]), yaExistia: true };
    }
    throw error;
  }
}

/** Invalidación tolerante a reintento -- mismo criterio que invalidarDescansoVersion. */
export async function invalidarSnapshotLoteReal(client, {
  snapshotId, cicloId, potreroId, organizacionId, motivo, actorCuentaId,
}) {
  try {
    await client.query(
      `insert into agx.potrero_ciclo_lote_real_invalidaciones
         (organizacion_id, potrero_id, snapshot_id, ciclo_id, motivo, actor_cuenta_id)
       values ($1, $2, $3, $4, $5, $6)`,
      [organizacionId, potreroId, snapshotId, cicloId, motivo, actorCuentaId ?? null],
    );
  } catch (error) {
    if (error.code === '23505') return; // ya invalidada -- idempotente
    throw error;
  }
}

/** Versión vigente (mayor número sin invalidación) -- null si el ciclo nunca tuvo snapshot. */
export async function fetchSnapshotLoteRealVigente(client, cicloId) {
  const result = await client.query(
    `select ${SNAPSHOT_SELECT}
       from agx.potrero_ciclo_lote_real_versiones s
      where s.ciclo_id = $1
        and not exists (select 1 from agx.potrero_ciclo_lote_real_invalidaciones i where i.snapshot_id = s.snapshot_id)
      order by s.version desc
      limit 1`,
    [cicloId],
  );
  return result.rows.length > 0 ? serializeSnapshotRow(result.rows[0]) : null;
}

/**
 * SPRINT-3D9.3 FINAL IMPLEMENTATION GATE, punto 1 -- fuente única de
 * verdad. Si el ciclo tiene snapshot vigente, ESA es la fuente científica
 * -- nunca las columnas legacy de agx.potrero_ciclos_pastoreo (que para
 * un ciclo con snapshot solo son un espejo sincronizado). Si no tiene
 * snapshot (ciclo pre-3D9.3), cae a las columnas legacy del ciclo --
 * comportamiento 3D9.1/3D9.2 intacto.
 */
export async function resolveLoteCientificoCiclo(client, { cicloId, cicloRow }) {
  const vigente = await fetchSnapshotLoteRealVigente(client, cicloId);
  if (vigente) {
    return { fuente: 'SNAPSHOT', snapshot: vigente };
  }
  return {
    fuente: 'LEGACY',
    snapshot: null,
    legacy: {
      categoriaId: String(cicloRow.categoria_id),
      numeroAnimales: Number(cicloRow.numero_animales_real),
      pesoPromedioKg: Number(cicloRow.peso_promedio_real_kg),
    },
  };
}

// -----------------------------------------------------------------------
// Pipeline REAL pressure -- reutiliza computeRecomendacionPastoreo() sin
// cambios (mismas fórmulas/NRC que PLAN). Nunca persiste nada -- es
// cálculo puro sobre datos ya leídos; quien orquesta (potreroDescansoRepository.js)
// decide qué hacer con el resultado (fuentePresion REAL/PLAN_FALLBACK).
// -----------------------------------------------------------------------
export const REAL_PRESSURE_UNAVAILABLE = Object.freeze({
  FICHA_BASE_AUSENTE: 'FICHA_BASE_AUSENTE',
  TIMESTAMPS_INCOMPLETOS: 'TIMESTAMPS_INCOMPLETOS',
  DURACION_INVALIDA: 'DURACION_INVALIDA',
  INPUT_CIENTIFICO_REQUERIDO_AUSENTE: 'INPUT_CIENTIFICO_REQUERIDO_AUSENTE',
});

async function fetchFichaBaseReal(client, fichaId, potreroId) {
  const result = await client.query(
    `select ficha_id, biomasa_total_kg, tipo_cobertura
       from agx.potrero_fichas_productivas
      where ficha_id = $1 and potrero_id = $2`,
    [fichaId, potreroId],
  );
  return result.rows[0] ?? null;
}

// Mismo criterio de duplicación pequeña ya usado en este dominio
// (potreroRecomendacionPastoreoRepository.js y potreroDescansoRepository.js
// cada uno tienen su propia copia de esta misma consulta) -- clima MÁS
// RECIENTE del potrero, opcional, nunca bloquea el cálculo si falta.
async function fetchContextoMasReciente(client, potreroId) {
  const result = await client.query(
    `select contexto_id, precipitacion_7d_mm
       from agx.potrero_contextos_agroclimaticos
      where potrero_id = $1
      order by created_at desc
      limit 1`,
    [potreroId],
  );
  return result.rows[0] ?? null;
}

/**
 * Calcula demanda/permanencia/consumo/remanente REAL a partir del
 * snapshot vigente -- SIEMPRE devuelve `{ disponible: false, motivo }`
 * cuando la evidencia es insuficiente (nunca inventa/asume), nunca lanza
 * para estos casos (son un resultado válido del dominio: PLAN_FALLBACK).
 *
 * SPRINT-3D9.3 FINAL IMPLEMENTATION GATE, punto 2 -- duración: si
 * salida_real_at <= ingreso_real_at (incluye 0), NUNCA se calcula --
 * `disponible: false, motivo: DURACION_INVALIDA`. Nunca "0 horas = 0 kg
 * de consumo" como resultado calculado.
 */
export async function computeRealPressureCore(client, { potreroId, snapshot }) {
  if (!snapshot.fichaIdBaseReal) {
    return { disponible: false, motivo: REAL_PRESSURE_UNAVAILABLE.FICHA_BASE_AUSENTE };
  }
  if (!snapshot.ingresoRealAt || !snapshot.salidaRealAt) {
    return { disponible: false, motivo: REAL_PRESSURE_UNAVAILABLE.TIMESTAMPS_INCOMPLETOS };
  }
  const ingresoMs = new Date(snapshot.ingresoRealAt).getTime();
  const salidaMs = new Date(snapshot.salidaRealAt).getTime();
  if (!Number.isFinite(ingresoMs) || !Number.isFinite(salidaMs) || salidaMs <= ingresoMs) {
    return { disponible: false, motivo: REAL_PRESSURE_UNAVAILABLE.DURACION_INVALIDA };
  }

  const categoria = await fetchCategoriaById(client, snapshot.categoriaId);
  if (categoria.requiereProduccionLeche && (snapshot.produccionLecheLDia === null || snapshot.produccionLecheLDia === undefined)) {
    return { disponible: false, motivo: REAL_PRESSURE_UNAVAILABLE.INPUT_CIENTIFICO_REQUERIDO_AUSENTE };
  }
  if (categoria.requiereTerneroAlPie && (snapshot.terneroAlPie === null || snapshot.terneroAlPie === undefined)) {
    return { disponible: false, motivo: REAL_PRESSURE_UNAVAILABLE.INPUT_CIENTIFICO_REQUERIDO_AUSENTE };
  }

  const fichaRow = await fetchFichaBaseReal(client, snapshot.fichaIdBaseReal, potreroId);
  if (!fichaRow) {
    // Defensa en profundidad -- la FK tenant-safe de 0015 ya lo impide en
    // condiciones normales, pero nunca se asume sin verificar.
    return { disponible: false, motivo: REAL_PRESSURE_UNAVAILABLE.FICHA_BASE_AUSENTE };
  }
  const { tipo: tipoPasturaBotanico, nombreComun, nombreCientifico } = await resolveTipoPasturaBotanico(client, fichaRow);
  const contextoRow = await fetchContextoMasReciente(client, potreroId);
  const pastureClimate = resolvePastureClimateParams(
    tipoPasturaBotanico,
    { nombreComun, nombreCientifico },
    { precipitacion7dMm: contextoRow?.precipitacion_7d_mm ?? null },
    null,
  );

  const esCategoriaLeche = categoria.requiereProduccionLeche;
  const biomasaFrescaKg = Number(fichaRow.biomasa_total_kg);
  const resultado = computeRecomendacionPastoreo({
    biomasaFrescaKg,
    materiaSecaPct: pastureClimate.materiaSecaPct,
    utilizacionPct: pastureClimate.utilizacionPct,
    consumoPctPesoVivo: categoria.consumoMsPctPvTipico,
    pesoPromedioKg: snapshot.pesoPromedioKg,
    numeroAnimales: snapshot.numeroAnimales,
    esCategoriaLeche,
    litrosPromedioVacaDia: esCategoriaLeche ? snapshot.produccionLecheLDia : null,
    diasEnLeche: esCategoriaLeche ? snapshot.diasEnLeche : null,
    grasaLechePct: esCategoriaLeche ? snapshot.grasaLechePct : null,
    terneroAlPie: categoria.requiereTerneroAlPie ? snapshot.terneroAlPie : null,
  });

  // SPRINT-3D9.3 FINAL IMPLEMENTATION GATE, punto 2/3: fracción EXACTA,
  // sin floor -- computeConsumoYRemanenteReal (núcleo compartido con
  // PLAN, ver recomendacionPastoreoFormulas.js) nunca colapsa a 0.
  const permanenciaRealHoras = (salidaMs - ingresoMs) / MS_POR_HORA;
  const fraccionDiaReal = permanenciaRealHoras / 24;
  const remnantReal = computeConsumoYRemanenteReal({
    materiaSecaTotalKg: resultado.materiaSecaTotalKg,
    materiaSecaUtilizableKg: resultado.materiaSecaUtilizableKg,
    demandaDiariaLoteKgMs: resultado.demandaDiariaLoteKgMs,
    fraccionDiaReal,
  });

  return {
    disponible: true,
    categoriaNombre: categoria.nombre,
    fichaId: String(fichaRow.ficha_id),
    materiaSecaTotalKg: resultado.materiaSecaTotalKg,
    materiaSecaUtilizableKg: resultado.materiaSecaUtilizableKg,
    demandaDiariaLoteKgMs: resultado.demandaDiariaLoteKgMs,
    dmiModel: resultado.dmiModel,
    permanenciaRealHoras,
    fraccionDiaReal,
    consumoTotalRealEstimadoKg: remnantReal.consumoProyectadoKg,
    remanenteObjetivoRealKg: remnantReal.remanenteObjetivoKg,
    remanenteProyectadoRealKg: remnantReal.remanenteProyectadoKg,
  };
}

/**
 * SPRINT-3D9.3, diseño punto 12 (UX) -- muestra ANTES de confirmar
 * "Iniciar pastoreo" qué aforo se usaría como base real (mismo doble
 * guardrail que resolveFichaIdBaseReal, evaluado con "ahora" como
 * ingreso hipotético). Read-only, nunca persiste nada, nunca bloquea el
 * inicio -- el ciclo real se resuelve de nuevo (con el ingreso_real_at
 * EXACTO del momento real) cuando el usuario efectivamente confirma.
 */
export async function previewFichaBaseReal(organizacionId, predioId, potreroId, { now } = {}) {
  assertPredioIdFormat(predioId);
  assertPotreroIdFormat(potreroId);

  return withOrganizacionTransaction(organizacionId, async (client) => {
    await assertPotreroBelongsToPredio(client, predioId, potreroId);
    const ingresoRealAt = now ?? new Date();
    const fichaId = await resolveFichaIdBaseReal(client, { potreroId, ingresoRealAt });
    if (!fichaId) {
      return { fichaIdBaseReal: null, fechaAforo: null };
    }
    const result = await client.query(
      `select to_char(fecha_aforo, 'YYYY-MM-DD') as fecha_aforo from agx.potrero_fichas_productivas where ficha_id = $1`,
      [fichaId],
    );
    return { fichaIdBaseReal: String(fichaId), fechaAforo: result.rows[0]?.fecha_aforo ?? null };
  });
}
