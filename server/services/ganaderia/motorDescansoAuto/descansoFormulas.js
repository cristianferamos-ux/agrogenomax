// SPRINT-3D8-DESCANSO-REENTRADA (hardening dinámico): fórmulas puras del
// motor de descanso -- sin dependencias de DB/HTTP. Motor DETERMINÍSTICO
// (§20 del sprint original: "La IA explicativa puede venir después").
//
// §1 del hardening: el descanso NUNCA es un número fijo por especie
// ("Humidicola = 30 días") -- siempre:
//   PASTURE PHYSIOLOGICAL BASELINE + CURRENT/RECENT AGROCLIMATE CONDITIONS
//   + GRAZING PRESSURE = DYNAMIC REST WINDOW.
// El baseline (agroClimateAssessment.js/pasturaDescansoBaselineEngine.js)
// es un GUARDRAIL, no la respuesta final -- este módulo aplica el ajuste
// dinámico documentado sobre ese guardrail, siempre auditable vía
// `appliedRules`/`agroClimateStatus`.
import { AGROCLIMATE_STATUS } from './agroClimateAssessment.js';

// §14 del hardening: extensión del rango cuando el clima es restrictivo --
// desplaza el rango completo hacia arriba (nunca lo angosta). Valores
// conservadores propios (no atribuidos a una fuente externa), documentados
// y testeados -- nunca un ejemplo arbitrario de "+10/+20" sin regla.
const EXTENSION_RESTRICTIVE_DIAS = 5;
const EXTENSION_SEVERELY_RESTRICTIVE_DIAS = 10;
// §14: en FAVORABLE, el recomendado se orienta hacia la parte baja/media
// del rango -- NUNCA por debajo del mínimo técnico. Punto medio entre
// min y typical (nunca el mínimo exacto, que exigiría evidencia
// fisiológica específica no disponible en v1).
const FAVORABLE_RECOMENDADO_FACTOR = 0.5;

// Guardrail de presión de pastoreo (§6 del sprint original) -- arquitectura
// preparada, NUNCA debería activarse en v1 si el motor de pastoreo se
// respeta (remanenteProyectadoKg siempre >= remanenteObjetivoKg por
// construcción de computeRemnantDerivatives). Test dedicado fuerza la rama.
const AJUSTE_PRESION_REMANENTE_BAJO_DIAS = 5;

const MS_POR_DIA = 24 * 60 * 60 * 1000;

/**
 * Guardrail de presión de pastoreo (§6 del sprint original). En v1, con el
 * motor de pastoreo respetado, remanenteProyectadoKg siempre >=
 * remanenteObjetivoKg (floor de días de ocupación) -- esta rama documenta
 * y cubre con test el caso "remanente proyectado por debajo del objetivo
 * por una situación futura real", sin que hoy pueda dispararse desde el
 * flujo normal.
 */
export function computeAjustePresionDias({ remanenteProyectadoKg, remanenteObjetivoKg }) {
  const ambosFinitos = Number.isFinite(remanenteProyectadoKg) && Number.isFinite(remanenteObjetivoKg);
  if (!ambosFinitos || remanenteProyectadoKg >= remanenteObjetivoKg) {
    return { deltaDias: 0, aplicado: false };
  }
  return { deltaDias: AJUSTE_PRESION_REMANENTE_BAJO_DIAS, aplicado: true };
}

/**
 * §1/§8/§14 del hardening: compone el rango DINÁMICO de descanso a partir
 * del baseline fisiológico + el status agroclimático (assessAgroClimate) +
 * el guardrail de presión. NUNCA reduce por debajo del mínimo técnico
 * (baseline.restDaysMinReference) salvo el desplazamiento uniforme hacia
 * arriba en condiciones restrictivas (que sube min también, nunca lo baja).
 *
 * - NORMAL / INSUFFICIENT_DATA: mantiene el baseline (sin evidencia
 *   suficiente para desviarse en ningún sentido, §7/§14).
 * - FAVORABLE: min/max quedan en el baseline -- el recomendado se orienta
 *   hacia la parte baja/media del rango (§14), nunca por debajo del
 *   mínimo.
 * - RESTRICTIVE / SEVERELY_RESTRICTIVE: el rango completo (min/typical/max)
 *   se desplaza hacia arriba (§14: "extender rango"), nunca se angosta.
 */
export function computeRangoDescansoDias({ baseline, agroClimateStatus, deltaPresionDias = 0 }) {
  let extensionDias = 0;
  if (agroClimateStatus === AGROCLIMATE_STATUS.RESTRICTIVE) extensionDias = EXTENSION_RESTRICTIVE_DIAS;
  else if (agroClimateStatus === AGROCLIMATE_STATUS.SEVERELY_RESTRICTIVE) extensionDias = EXTENSION_SEVERELY_RESTRICTIVE_DIAS;

  const deltaTotal = extensionDias + deltaPresionDias;
  const min = baseline.restDaysMinReference + deltaTotal;
  const max = baseline.restDaysMaxReference + deltaTotal;
  let typical = baseline.restDaysTypicalReference + deltaTotal;

  if (agroClimateStatus === AGROCLIMATE_STATUS.FAVORABLE) {
    // Solo tiene sentido orientar hacia la parte baja si el clima
    // realmente es favorable Y no hubo ningún otro ajuste que ya haya
    // extendido el rango (deltaTotal === 0 en este caso, por diseño --
    // FAVORABLE nunca coexiste con una extensión restrictiva).
    typical = min + (typical - min) * FAVORABLE_RECOMENDADO_FACTOR;
  }

  return {
    diasDescansoMin: Math.round(min),
    diasDescansoMax: Math.round(max),
    diasDescansoRecomendado: Math.round(typical),
  };
}

// -----------------------------------------------------------------------
// Fechas (§20 del sprint original) -- aritmética de fechas puras en UTC
// sobre cadenas 'YYYY-MM-DD' (nunca objetos Date dependientes de zona
// horaria local).
// -----------------------------------------------------------------------

function parseFechaIso(fechaIso) {
  const [anio, mes, dia] = fechaIso.split('-').map(Number);
  return Date.UTC(anio, mes - 1, dia);
}

function formatFechaIso(timestampUtcMs) {
  const fecha = new Date(timestampUtcMs);
  const anio = fecha.getUTCFullYear();
  const mes = String(fecha.getUTCMonth() + 1).padStart(2, '0');
  const dia = String(fecha.getUTCDate()).padStart(2, '0');
  return `${anio}-${mes}-${dia}`;
}

function sumarDiasIso(fechaIso, dias) {
  return formatFechaIso(parseFechaIso(fechaIso) + dias * MS_POR_DIA);
}

/**
 * fecha_salida_estimada = fecha_inicio_pastoreo + dias_ocupacion_recomendados.
 */
export function computeFechaSalidaEstimada(fechaInicioPastoreoIso, diasOcupacionRecomendados) {
  return sumarDiasIso(fechaInicioPastoreoIso, Math.floor(diasOcupacionRecomendados));
}

/**
 * fecha_reingreso_{min,max,recomendada} = fecha_salida_estimada +
 * dias_descanso_{min,max,recomendado}. Siempre "estimada con las
 * condiciones disponibles a la fecha" (§20 del hardening) -- nunca
 * presentada como definitiva.
 */
export function computeFechasReingreso(fechaSalidaEstimadaIso, { diasDescansoMin, diasDescansoMax, diasDescansoRecomendado }) {
  return {
    fechaReingresoMin: sumarDiasIso(fechaSalidaEstimadaIso, diasDescansoMin),
    fechaReingresoMax: sumarDiasIso(fechaSalidaEstimadaIso, diasDescansoMax),
    fechaReingresoRecomendada: sumarDiasIso(fechaSalidaEstimadaIso, diasDescansoRecomendado),
  };
}

// -----------------------------------------------------------------------
// Condiciones de reentrada (§16 del hardening) -- referencia regional,
// nunca una exigencia exacta ("debe estar exactamente en 30 cm").
// -----------------------------------------------------------------------
export const CONDICION_REENTRADA = Object.freeze({
  CONFIRMAR_NUEVO_AFORO: 'CONFIRMAR_NUEVO_AFORO',
  ALTURA_ENTRADA_REFERENCIA: 'ALTURA_ENTRADA_REFERENCIA',
});

/**
 * Siempre incluye CONFIRMAR_NUEVO_AFORO. Agrega ALTURA_ENTRADA_REFERENCIA
 * solo cuando el baseline documenta una altura de entrada regional real --
 * nunca inventada, nunca presentada como umbral exacto obligatorio.
 */
export function resolveCondicionesReentrada({ referenceEntryHeightCm }) {
  const condiciones = [{ codigo: CONDICION_REENTRADA.CONFIRMAR_NUEVO_AFORO, detalle: null }];
  if (typeof referenceEntryHeightCm === 'number' && Number.isFinite(referenceEntryHeightCm) && referenceEntryHeightCm > 0) {
    condiciones.unshift({ codigo: CONDICION_REENTRADA.ALTURA_ENTRADA_REFERENCIA, detalle: { referenceEntryHeightCm } });
  }
  return condiciones;
}

// -----------------------------------------------------------------------
// Nivel de confianza (§23 del hardening) -- reglas explícitas, nunca
// scoring opaco. Se parte de ALTA y se degrada un nivel por cada condición
// que no se cumple, sin bajar de BAJA.
// -----------------------------------------------------------------------
const NIVELES = ['ALTA', 'MEDIA', 'BAJA'];
export const RECOMENDACION_PASTOREO_STALE_DIAS = 60;

function degradar(nivelActual) {
  const idx = NIVELES.indexOf(nivelActual);
  return NIVELES[Math.min(idx + 1, NIVELES.length - 1)];
}

/**
 * Reglas de confianza (§23 del hardening):
 * 1. Contexto agroclimático AGING o STALE, o ausente -> degrada (§23:
 *    "Sin contexto: NO ALTA").
 * 2. agroClimateStatus === INSUFFICIENT_DATA -> degrada (evidencia
 *    insuficiente para clasificar, o sin climatología local, §21 del
 *    hardening territorial: "confidence máxima MEDIA o BAJA, nunca ALTA"
 *    -- ver `agroClimateConfidenceImpact`, ya calculado por
 *    assessAgroClimate) -> degrada.
 * 3. La recomendación de pastoreo usada como base tiene más de
 *    RECOMENDACION_PASTOREO_STALE_DIAS de antigüedad -> degrada.
 * 4. Ajuste de presión de pastoreo aplicado (guardrail) -> degrada.
 * El piso es siempre BAJA.
 */
export function resolveNivelConfianzaDescanso({
  agroClimateFreshness, agroClimateConfidenceImpact, recomendacionEdadDias, ajustePresionAplicado,
}) {
  let nivel = 'ALTA';
  if (agroClimateFreshness !== 'AGROCLIMATE_FRESH') nivel = degradar(nivel);
  if (agroClimateConfidenceImpact === 'DEGRADE') nivel = degradar(nivel);
  if (typeof recomendacionEdadDias === 'number' && recomendacionEdadDias > RECOMENDACION_PASTOREO_STALE_DIAS) nivel = degradar(nivel);
  if (ajustePresionAplicado === true) nivel = degradar(nivel);
  return nivel;
}
