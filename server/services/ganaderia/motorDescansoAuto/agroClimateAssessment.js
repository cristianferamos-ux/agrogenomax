// SPRINT-3D8-DESCANSO-REENTRADA (hardening territorial + operacional)
// §1/§5/§6/§11/§12: clasificador agroclimático determinístico -- capa
// SEPARADA del baseline de pastura. Nunca IA generativa, nunca scoring
// opaco -- solo reglas explícitas, nombradas, auditables vía
// `appliedRules`.
//
// PRINCIPIO CENTRAL TERRITORIAL (§1): la señal debe ser RELATIVA AL
// LUGAR, nunca un umbral absoluto universal ("soilMoisture < 0.15 =>
// drought" NO es una ley territorial). Cuando existe climatología local
// (percentiles mensuales, ver climatologyStatistics.js), la clasificación
// de precipitación y humedad de suelo se hace SIEMPRE contra la
// distribución histórica de ESE potrero para ESA época del año.
//
// Los umbrales absolutos de la primera versión de este motor (10/40 mm,
// 0.15 m3/m3) se conservan ÚNICAMENTE como GUARDRAIL AUXILIAR (§21) para
// el caso en que un potrero todavía no tiene climatología local -- nunca
// como señal principal, y ese camino SIEMPRE degrada la confianza.
//
// HARDENING OPERACIONAL §5/§6 -- CORRECCIÓN: la primera versión de la
// rama territorial etiquetaba precipitación NORMAL (P25-P75, "banda 7d/30d
// ambas normales") como `FAVORABLE` -- una condición simplemente NORMAL
// nunca es evidencia de "favorable". Corregido: FAVORABLE ahora exige
// evidencia MULTIVARIABLE consistente -- al menos una variable
// genuinamente HIGH/VERY_HIGH (percentil >=P75) Y la otra variable no en
// conflicto (nunca ausente ni deficitaria). Una lectura NORMAL nunca basta
// por sí sola, tampoco una sola variable alta si la otra falta o es baja.
//
// Temperatura es la única excepción deliberada (§8/§14): distingue
// LOCAL_CLIMATE_ANOMALY (percentil, informativo) de
// SPECIES_PHYSIOLOGICAL_LIMIT (guardrail de ESPECIE, no territorial --
// legítimo incluso sin climatología local).
import { PRECIPITACION_7D_UMBRAL_DEFICIT_MM } from '../motorPastoreoAuto/pastureClimateEngine.js';
import { classifyLevel, computeAnomaly, LEVEL } from './climatologyStatistics.js';

// -----------------------------------------------------------------------
// GUARDRAIL AUXILIAR (absoluto) -- SOLO cuando no hay climatología local
// (§1/§21 del hardening). Nunca la verdad territorial universal.
// -----------------------------------------------------------------------
export const PRECIPITACION_15D_UMBRAL_DEFICIT_MM = 20;
export const PRECIPITACION_30D_UMBRAL_DEFICIT_MM = 40;
const PRECIPITACION_7D_UMBRAL_ALTA_MM = PRECIPITACION_7D_UMBRAL_DEFICIT_MM * 3;
export const HUMEDAD_SUELO_UMBRAL_BAJO_M3M3 = 0.15;

// SPECIES_PHYSIOLOGICAL_LIMIT -- guardrail de especie (§8/§14 del
// hardening), no territorial. Legítimo con o sin climatología local.
export const TEMPERATURA_MIN_COMPATIBLE_C = 15;
export const TEMPERATURA_MAX_COMPATIBLE_C = 35;

export const AGROCLIMATE_STATUS = Object.freeze({
  FAVORABLE: 'FAVORABLE',
  NORMAL: 'NORMAL',
  RESTRICTIVE: 'RESTRICTIVE',
  SEVERELY_RESTRICTIVE: 'SEVERELY_RESTRICTIVE',
  INSUFFICIENT_DATA: 'INSUFFICIENT_DATA',
});

export const LOCAL_CLIMATOLOGY_STATUS = Object.freeze({
  AVAILABLE: 'AVAILABLE',
  INSUFFICIENT_LOCAL_CLIMATOLOGY: 'INSUFFICIENT_LOCAL_CLIMATOLOGY',
});

function esFinito(valor) {
  return typeof valor === 'number' && Number.isFinite(valor);
}

const NIVELES_BAJOS = new Set([LEVEL.VERY_LOW, LEVEL.LOW]);
const NIVELES_ALTOS = new Set([LEVEL.HIGH, LEVEL.VERY_HIGH]);

// -----------------------------------------------------------------------
// PRECIPITACIÓN -- rama TERRITORIAL (climatología local disponible, §5).
// Devuelve { restrictive, severe, level, insufficientData, rules } --
// `level` (NORMAL/HIGH/VERY_HIGH) SOLO tiene sentido cuando
// `restrictive === false` y `insufficientData === false`; es la evidencia
// que el combinador de nivel superior usa para decidir FAVORABLE (nunca
// decidido aquí, §5/§6).
// -----------------------------------------------------------------------
function assessPrecipitacionTerritorial({
  precipitacion7dMm, precipitacion15dMm, precipitacion30dMm,
  climatologia7d, climatologia15d, climatologia30d,
}) {
  const nivel7d = climatologia7d ? classifyLevel(precipitacion7dMm, climatologia7d) : null;
  const nivel15d = climatologia15d ? classifyLevel(precipitacion15dMm, climatologia15d) : null;
  const nivel30d = climatologia30d ? classifyLevel(precipitacion30dMm, climatologia30d) : null;

  if (nivel7d === null && nivel15d === null && nivel30d === null) {
    return { restrictive: false, severe: false, level: null, insufficientData: true, rules: ['RULE_LOCAL_PRECIPITATION_INSUFFICIENT_DATA'], nivel7d, nivel15d, nivel30d };
  }

  // SPRINT 3D8 (semantic final fix) -- definición FORMAL de "persistente":
  // un déficit de 7d SOLO es "persistente" si se sostiene en al menos una
  // ventana MÁS LARGA (15d y/o 30d también bajas). Un déficit de 7d que
  // NO aparece todavía en 15d ni en 30d es "reciente" -- nunca
  // "persistente" (antes esta rama solo miraba 7d+30d, ignorando 15d por
  // completo pese a recibirlo como parámetro).
  if (NIVELES_BAJOS.has(nivel7d) && (NIVELES_BAJOS.has(nivel15d) || NIVELES_BAJOS.has(nivel30d))) {
    const severe = nivel7d === LEVEL.VERY_LOW && (nivel15d === LEVEL.VERY_LOW || nivel30d === LEVEL.VERY_LOW);
    return { restrictive: true, severe, level: null, insufficientData: false, rules: ['RULE_LOCAL_PERSISTENT_PRECIP_DEFICIT'], nivel7d, nivel15d, nivel30d };
  }

  // §5: "7d alta + 30d baja -> lluvia reciente tras sequía local" -- NUNCA
  // favorable directo (§13 consistencia multivariable): el 30d deprimido
  // sigue siendo la señal de recuperación real, no la lluvia puntual.
  if (NIVELES_ALTOS.has(nivel7d) && NIVELES_BAJOS.has(nivel30d)) {
    return { restrictive: false, severe: false, level: LEVEL.NORMAL, insufficientData: false, rules: ['RULE_RECENT_RAIN_AFTER_LOCAL_DROUGHT'], nivel7d, nivel15d, nivel30d };
  }

  // §5 (renombrada en el fix semántico): "7d baja, pero NI 15d NI 30d
  // bajas" -- déficit RECIENTE aislado, nunca persistente, nunca
  // restrictivo, tampoco evidencia favorable.
  if (NIVELES_BAJOS.has(nivel7d) && !NIVELES_BAJOS.has(nivel15d) && !NIVELES_BAJOS.has(nivel30d)) {
    return { restrictive: false, severe: false, level: LEVEL.NORMAL, insufficientData: false, rules: ['RULE_LOCAL_RECENT_PRECIP_DEFICIT'], nivel7d, nivel15d, nivel30d };
  }

  // Ni déficit ni recuperación-de-sequía -- el nivel representativo es
  // 30d (ventana más larga, más representativa de condición sostenida);
  // 7d como respaldo si 30d no está disponible. Regla PROPIA de
  // precipitación (nunca compartida con humedad de suelo -- antes ambas
  // ramas reusaban el mismo nombre `RULE_LOCAL_ABOVE_NORMAL_MOISTURE`,
  // generando un "por qué" de suelo aunque la señal alta fuera de lluvia).
  const nivelRepresentativo = nivel30d ?? nivel7d;
  const rules = NIVELES_ALTOS.has(nivelRepresentativo) ? ['RULE_LOCAL_ABOVE_NORMAL_PRECIP'] : ['RULE_LOCAL_PRECIPITATION_WITHIN_HISTORICAL_RANGE'];
  return { restrictive: false, severe: false, level: nivelRepresentativo, insufficientData: false, rules, nivel7d, nivel15d, nivel30d };
}

/**
 * §9 del hardening: PRIORIDAD ALTA -- rama TERRITORIAL. Percentil local,
 * nunca 0.15 m3/m3 absoluto. Misma forma de retorno que precipitación.
 */
function assessSueloTerritorial({ humedadSueloSuperficial, humedadSueloSubsuperficial, climatologiaSuperficial, climatologiaSubsuperficial }) {
  const nivelSuperficial = climatologiaSuperficial ? classifyLevel(humedadSueloSuperficial, climatologiaSuperficial) : null;
  const nivelSubsuperficial = climatologiaSubsuperficial ? classifyLevel(humedadSueloSubsuperficial, climatologiaSubsuperficial) : null;

  if (nivelSuperficial === null && nivelSubsuperficial === null) {
    return { restrictive: false, severe: false, level: null, insufficientData: true, rules: ['RULE_LOCAL_SOIL_MOISTURE_INSUFFICIENT_DATA'] };
  }

  const severa = nivelSuperficial === LEVEL.VERY_LOW || nivelSubsuperficial === LEVEL.VERY_LOW;
  const moderada = nivelSuperficial === LEVEL.LOW || nivelSubsuperficial === LEVEL.LOW;
  if (severa || moderada) {
    return { restrictive: true, severe: severa, level: null, insufficientData: false, rules: ['RULE_LOCAL_SOIL_MOISTURE_DEFICIT'] };
  }

  // Nivel representativo = el MÁS BAJO de las dos capas disponibles --
  // conservador: nunca reporta "alto" si una sola capa está alta y la
  // otra apenas normal (§13 consistencia multivariable, aplicada también
  // entre capas de la MISMA variable).
  const RANGO = { [LEVEL.NORMAL]: 0, [LEVEL.HIGH]: 1, [LEVEL.VERY_HIGH]: 2 };
  const niveles = [nivelSuperficial, nivelSubsuperficial].filter((n) => n !== null);
  const nivelRepresentativo = niveles.reduce((min, n) => (RANGO[n] < RANGO[min] ? n : min), niveles[0]);
  const rules = NIVELES_ALTOS.has(nivelRepresentativo) ? ['RULE_LOCAL_ABOVE_NORMAL_MOISTURE'] : ['RULE_LOCAL_SOIL_MOISTURE_WITHIN_HISTORICAL_RANGE'];
  return { restrictive: false, severe: false, level: nivelRepresentativo, insufficientData: false, rules };
}

// -----------------------------------------------------------------------
// GUARDRAIL AUXILIAR (absoluto) -- SOLO sin climatología local (§1/§21).
// -----------------------------------------------------------------------
function assessPrecipitacionGuardrailAbsoluto({ precipitacion7dMm, precipitacion30dMm }) {
  const disponible = esFinito(precipitacion7dMm) || esFinito(precipitacion30dMm);
  if (!disponible) return { signal: 'INSUFFICIENT_DATA', rules: ['RULE_ABSOLUTE_GUARDRAIL_PRECIPITATION_INSUFFICIENT_DATA'] };

  const d7 = esFinito(precipitacion7dMm) ? precipitacion7dMm < PRECIPITACION_7D_UMBRAL_DEFICIT_MM : null;
  const d30 = esFinito(precipitacion30dMm) ? precipitacion30dMm < PRECIPITACION_30D_UMBRAL_DEFICIT_MM : null;
  const altaReciente = esFinito(precipitacion7dMm) ? precipitacion7dMm >= PRECIPITACION_7D_UMBRAL_ALTA_MM : false;

  if (d7 === true && d30 === true) return { signal: 'RESTRICTIVE', rules: ['RULE_ABSOLUTE_GUARDRAIL_DROUGHT_PERSISTENT'] };
  if (altaReciente && d30 === true) return { signal: 'NORMAL', rules: ['RULE_ABSOLUTE_GUARDRAIL_RECENT_RAIN_AFTER_DRY_PERIOD'] };
  if (d7 === true && d30 !== true) return { signal: 'NORMAL', rules: ['RULE_ABSOLUTE_GUARDRAIL_RECENT_DRY_NOT_SEVERE'] };
  if (d7 === false && d30 === false) return { signal: 'FAVORABLE', rules: ['RULE_ABSOLUTE_GUARDRAIL_SUSTAINED_MOISTURE'] };
  return { signal: 'NORMAL', rules: ['RULE_ABSOLUTE_GUARDRAIL_PRECIPITATION_NORMAL'] };
}

function assessSueloGuardrailAbsoluto({ humedadSueloSuperficial, humedadSueloSubsuperficial }) {
  const disponible = esFinito(humedadSueloSuperficial) || esFinito(humedadSueloSubsuperficial);
  if (!disponible) return { signal: 'INSUFFICIENT_DATA', rules: ['RULE_ABSOLUTE_GUARDRAIL_SOIL_MOISTURE_INSUFFICIENT_DATA'], severa: false };

  const superficialBaja = esFinito(humedadSueloSuperficial) && humedadSueloSuperficial < HUMEDAD_SUELO_UMBRAL_BAJO_M3M3;
  const subsuperficialBaja = esFinito(humedadSueloSubsuperficial) && humedadSueloSubsuperficial < HUMEDAD_SUELO_UMBRAL_BAJO_M3M3;

  if (superficialBaja || subsuperficialBaja) {
    return { signal: 'RESTRICTIVE', rules: ['RULE_ABSOLUTE_GUARDRAIL_SOIL_MOISTURE_LOW'], severa: superficialBaja && subsuperficialBaja };
  }
  return { signal: 'FAVORABLE', rules: ['RULE_ABSOLUTE_GUARDRAIL_SOIL_MOISTURE_ADEQUATE'], severa: false };
}

// -----------------------------------------------------------------------
// TEMPERATURA -- SPECIES_PHYSIOLOGICAL_LIMIT (guardrail de especie,
// siempre activo) + LOCAL_CLIMATE_ANOMALY (percentil, solo informativo).
// -----------------------------------------------------------------------
function assessTemperaturaEspecie({ temperaturaMediaC, temperaturaMaxC }) {
  const referencia = esFinito(temperaturaMediaC) ? temperaturaMediaC : temperaturaMaxC;
  if (!esFinito(referencia)) return { signal: 'INSUFFICIENT_DATA', rules: ['RULE_SPECIES_TEMPERATURE_INSUFFICIENT_DATA'] };
  if (referencia > TEMPERATURA_MAX_COMPATIBLE_C) return { signal: 'RESTRICTIVE', rules: ['RULE_SPECIES_HIGH_HEAT'] };
  if (referencia < TEMPERATURA_MIN_COMPATIBLE_C) return { signal: 'RESTRICTIVE', rules: ['RULE_SPECIES_TEMPERATURE_BELOW_COMPATIBLE'] };
  return { signal: 'FAVORABLE', rules: ['RULE_SPECIES_TEMPERATURE_COMPATIBLE'] };
}

function assessTemperaturaLocal({ temperaturaMediaC, climatologiaTemperatura }) {
  if (!climatologiaTemperatura || !esFinito(temperaturaMediaC)) {
    return { rules: ['RULE_LOCAL_TEMPERATURE_INSUFFICIENT_DATA'], anomaly: null };
  }
  const anomaly = computeAnomaly(temperaturaMediaC, climatologiaTemperatura);
  return { rules: ['RULE_LOCAL_TEMPERATURE_ANOMALY_RECORDED'], anomaly };
}

// §11/§12 del hardening: capturados, nunca mueven el status.
function assessRadiacion({ radiacionSolar }) {
  return { available: esFinito(radiacionSolar), rules: esFinito(radiacionSolar) ? ['RULE_RADIATION_RECORDED'] : ['RULE_RADIATION_INSUFFICIENT_DATA'] };
}
function assessHumedadRelativa({ humedadRelativaMediaPct }) {
  return { available: esFinito(humedadRelativaMediaPct), rules: esFinito(humedadRelativaMediaPct) ? ['RULE_HUMIDITY_RECORDED'] : ['RULE_HUMIDITY_INSUFFICIENT_DATA'] };
}

/**
 * Clasificador principal -- determinístico, auditable.
 * `climatologiaMensual` (opcional): breakpoints P10/P25/P50/P75/P90 del
 * MES ACTUAL para precipitacion7dMm/30dMm/temperaturaMediaC/
 * humedadSueloSuperficial/humedadSueloSubsuperficial -- CADA variable
 * comparada SIEMPRE contra su distribución histórica de LA MISMA ventana
 * de agregación (§2 del hardening operacional: nunca 7d actual contra
 * distribución de 30d, ni viceversa -- ver
 * potreroClimatologiaRepository.js/climatologyStatistics.js, que
 * construyen una distribución independiente por variable). Sin
 * climatología, degrada a INSUFFICIENT_LOCAL_CLIMATOLOGY y usa el
 * guardrail absoluto (§21).
 */
export function assessAgroClimate({
  precipitacion7dMm, precipitacion15dMm, precipitacion30dMm,
  temperaturaMediaC, temperaturaMaxC,
  humedadSueloSuperficial, humedadSueloSubsuperficial,
  radiacionSolar, humedadRelativaMediaPct,
  climatologiaMensual = null,
}) {
  const tieneClimatologia = Boolean(climatologiaMensual);

  const precipitacion = tieneClimatologia
    ? assessPrecipitacionTerritorial({
      precipitacion7dMm, precipitacion15dMm, precipitacion30dMm,
      climatologia7d: climatologiaMensual.precipitacion7dMm,
      climatologia15d: climatologiaMensual.precipitacion15dMm,
      climatologia30d: climatologiaMensual.precipitacion30dMm,
    })
    : assessPrecipitacionGuardrailAbsoluto({ precipitacion7dMm, precipitacion30dMm });

  const suelo = tieneClimatologia
    ? assessSueloTerritorial({
      humedadSueloSuperficial, humedadSueloSubsuperficial,
      climatologiaSuperficial: climatologiaMensual.humedadSueloSuperficial, climatologiaSubsuperficial: climatologiaMensual.humedadSueloSubsuperficial,
    })
    : assessSueloGuardrailAbsoluto({ humedadSueloSuperficial, humedadSueloSubsuperficial });

  const temperaturaEspecie = assessTemperaturaEspecie({ temperaturaMediaC, temperaturaMaxC });
  const temperaturaLocal = tieneClimatologia
    ? assessTemperaturaLocal({ temperaturaMediaC, climatologiaTemperatura: climatologiaMensual.temperaturaMediaC })
    : { rules: ['RULE_LOCAL_TEMPERATURE_INSUFFICIENT_DATA'], anomaly: null };

  const radiacion = assessRadiacion({ radiacionSolar });
  const humedadRelativa = assessHumedadRelativa({ humedadRelativaMediaPct });

  const appliedRules = [
    ...(tieneClimatologia ? [] : ['RULE_INSUFFICIENT_LOCAL_CLIMATOLOGY']),
    ...precipitacion.rules,
    ...suelo.rules,
    ...temperaturaEspecie.rules,
    ...temperaturaLocal.rules,
    ...radiacion.rules,
    ...humedadRelativa.rules,
  ];

  let status;
  let precipitationSignal;
  let soilMoistureSignal;

  if (tieneClimatologia) {
    // Traducción a signal legible (RESTRICTIVE/FAVORABLE/NORMAL/
    // INSUFFICIENT_DATA) para el resto del sistema -- `level`/`restrictive`
    // internos son la fuente de verdad de la decisión, ver abajo.
    precipitationSignal = precipitacion.insufficientData ? 'INSUFFICIENT_DATA' : (precipitacion.restrictive ? 'RESTRICTIVE' : (NIVELES_ALTOS.has(precipitacion.level) ? 'FAVORABLE' : 'NORMAL'));
    soilMoistureSignal = suelo.insufficientData ? 'INSUFFICIENT_DATA' : (suelo.restrictive ? 'RESTRICTIVE' : (NIVELES_ALTOS.has(suelo.level) ? 'FAVORABLE' : 'NORMAL'));

    const sinDatosCriticos = precipitacion.insufficientData && suelo.insufficientData;

    if (precipitacion.restrictive && suelo.restrictive && suelo.severe) {
      status = AGROCLIMATE_STATUS.SEVERELY_RESTRICTIVE;
    } else if (precipitacion.restrictive || suelo.restrictive || temperaturaEspecie.signal === 'RESTRICTIVE') {
      status = AGROCLIMATE_STATUS.RESTRICTIVE;
    } else if (sinDatosCriticos) {
      status = AGROCLIMATE_STATUS.INSUFFICIENT_DATA;
    } else {
      // §5/§6 del hardening operacional: FAVORABLE exige evidencia
      // MULTIVARIABLE consistente -- al menos una variable genuinamente
      // HIGH/VERY_HIGH, Y la otra variable determinada (nunca ausente) y
      // nunca en conflicto. Una lectura NORMAL nunca es "favorable".
      const favorableEvidence = NIVELES_ALTOS.has(precipitacion.level) || NIVELES_ALTOS.has(suelo.level);
      const consistente = precipitacion.level !== null && suelo.level !== null;
      status = (favorableEvidence && consistente && temperaturaEspecie.signal !== 'RESTRICTIVE')
        ? AGROCLIMATE_STATUS.FAVORABLE
        : AGROCLIMATE_STATUS.NORMAL;
    }
  } else {
    precipitationSignal = precipitacion.signal;
    soilMoistureSignal = suelo.signal;
    const sinDatosCriticos = precipitacion.signal === 'INSUFFICIENT_DATA' && suelo.signal === 'INSUFFICIENT_DATA';

    if (precipitacion.signal === 'RESTRICTIVE' && suelo.signal === 'RESTRICTIVE' && suelo.severa) {
      status = AGROCLIMATE_STATUS.SEVERELY_RESTRICTIVE;
    } else if (precipitacion.signal === 'RESTRICTIVE' || suelo.signal === 'RESTRICTIVE' || temperaturaEspecie.signal === 'RESTRICTIVE') {
      status = AGROCLIMATE_STATUS.RESTRICTIVE;
    } else if (sinDatosCriticos) {
      status = AGROCLIMATE_STATUS.INSUFFICIENT_DATA;
    } else if (precipitacion.signal === 'FAVORABLE' && suelo.signal !== 'RESTRICTIVE' && temperaturaEspecie.signal !== 'RESTRICTIVE') {
      status = AGROCLIMATE_STATUS.FAVORABLE;
    } else {
      status = AGROCLIMATE_STATUS.NORMAL;
    }
  }

  // §21 del hardening: sin climatología local, la confianza NUNCA es
  // ALTA -- se degrada siempre, sin importar el status resultante.
  const esFavorableONormal = status === AGROCLIMATE_STATUS.FAVORABLE || status === AGROCLIMATE_STATUS.NORMAL;
  const confidenceImpact = (esFavorableONormal && tieneClimatologia) ? 'NONE' : 'DEGRADE';

  return {
    status,
    localClimatologyStatus: tieneClimatologia ? LOCAL_CLIMATOLOGY_STATUS.AVAILABLE : LOCAL_CLIMATOLOGY_STATUS.INSUFFICIENT_LOCAL_CLIMATOLOGY,
    precipitationSignal,
    soilMoistureSignal,
    temperatureSignal: temperaturaEspecie.signal,
    radiationSignal: radiacion.available ? 'RECORDED' : 'INSUFFICIENT_DATA',
    humiditySignal: humedadRelativa.available ? 'RECORDED' : 'INSUFFICIENT_DATA',
    localAnomalies: {
      precipitacion7dNivel: precipitacion.nivel7d ?? null,
      precipitacion15dNivel: precipitacion.nivel15d ?? null,
      precipitacion30dNivel: precipitacion.nivel30d ?? null,
      temperatura: temperaturaLocal.anomaly,
    },
    appliedRules,
    confidenceImpact,
  };
}
