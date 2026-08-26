// SPRINT-3D8-DESCANSO-REENTRADA (hardening territorial) §2/§4/§5/§6: capa
// PURA de estadística climatológica -- sin dependencias de DB/HTTP. Toma
// series diarias históricas (ya obtenidas por
// era5HistoricalClimatologyProvider.js) y deriva percentiles LOCALES por
// mes calendario -- NUNCA un umbral absoluto universal.
//
// Principio central del hardening territorial: la señal debe ser RELATIVA
// AL LUGAR (§1). El mismo valor absoluto (p.ej. 0.20 m3/m3 de humedad de
// suelo) puede ser un déficit severo en un potrero y completamente normal
// en otro -- depende de la distribución histórica local para esa época
// del año, no de un número fijo.

/**
 * Percentil por interpolación lineal (método estándar, R-7/Excel) --
 * ampliamente documentado, no un método inventado. `sortedValues` debe
 * venir YA ordenado ascendentemente.
 */
export function computePercentile(sortedValues, percentile) {
  if (!Array.isArray(sortedValues) || sortedValues.length === 0) return null;
  if (sortedValues.length === 1) return sortedValues[0];
  const rank = (percentile / 100) * (sortedValues.length - 1);
  const lowerIndex = Math.floor(rank);
  const upperIndex = Math.ceil(rank);
  if (lowerIndex === upperIndex) return sortedValues[lowerIndex];
  const weight = rank - lowerIndex;
  return sortedValues[lowerIndex] + weight * (sortedValues[upperIndex] - sortedValues[lowerIndex]);
}

/**
 * Breakpoints P10/P25/P50/P75/P90 de una muestra -- base para clasificar
 * cualquier valor actual contra el comportamiento histórico LOCAL de ese
 * mismo punto/época del año (§6 del hardening: "el punto crítico es
 * comparación LOCAL, no valor absoluto universal").
 */
export function computeBreakpoints(values) {
  const finite = (values || []).filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (finite.length === 0) return null;
  return {
    p10: computePercentile(finite, 10),
    p25: computePercentile(finite, 25),
    p50: computePercentile(finite, 50),
    p75: computePercentile(finite, 75),
    p90: computePercentile(finite, 90),
    sampleSize: finite.length,
  };
}

/**
 * Suma móvil de `windowDias` días -- usada para derivar la climatología de
 * precipitación 7d/15d/30d a partir de una serie diaria (mismo criterio
 * conceptual que la ventana de 24h/7d/30d ya usada en
 * era5LandProvider.js, extendido a un histórico de años en vez de un
 * único snapshot).
 */
export function computeTrailingSums(dailyValues, windowDias) {
  const resultados = [];
  for (let i = 0; i < dailyValues.length; i += 1) {
    const inicio = Math.max(0, i - windowDias + 1);
    const ventana = dailyValues.slice(inicio, i + 1);
    const finitos = ventana.filter((v) => typeof v === 'number' && Number.isFinite(v));
    resultados.push(finitos.length === ventana.length && ventana.length === windowDias ? finitos.reduce((a, b) => a + b, 0) : null);
  }
  return resultados;
}

/**
 * Agrupa una serie diaria (fechas ISO 'YYYY-MM-DD' + valores) por mes
 * calendario (1-12) -- §4 del hardening: "la climatología debe considerar
 * época del año", nunca una normal anual única.
 */
export function groupByCalendarMonth(dates, values) {
  const porMes = new Map();
  for (let i = 0; i < dates.length; i += 1) {
    const mes = Number(String(dates[i]).slice(5, 7));
    if (!Number.isFinite(mes) || mes < 1 || mes > 12) continue;
    const valor = values[i];
    if (typeof valor !== 'number' || !Number.isFinite(valor)) continue;
    if (!porMes.has(mes)) porMes.set(mes, []);
    porMes.get(mes).push(valor);
  }
  return porMes;
}

/**
 * Construye la climatología mensual completa de una variable (§4/§19 del
 * hardening) -- breakpoints por cada uno de los 12 meses calendario.
 */
export function buildMonthlyClimatology(dates, values) {
  const porMes = groupByCalendarMonth(dates, values);
  const resultado = {};
  for (let mes = 1; mes <= 12; mes += 1) {
    resultado[mes] = computeBreakpoints(porMes.get(mes) ?? []);
  }
  return resultado;
}

// HARDENING OPERACIONAL §5/§6: 5 NIVELES (no 4) -- distingue HIGH de
// VERY_HIGH (y LOW de VERY_LOW) usando P90/P10 como frontera adicional.
// Necesario para que "FAVORABLE" exija evidencia de nivel genuinamente
// ALTO/MUY ALTO (P75+), nunca una simple lectura NORMAL (P25-P75) mal
// etiquetada como favorable -- error real encontrado y corregido en esta
// ronda de hardening (ver agroClimateAssessment.js).
export const LEVEL = Object.freeze({
  VERY_LOW: 'VERY_LOW', // <= P10
  LOW: 'LOW', // P10 < x <= P25
  NORMAL: 'NORMAL', // P25 < x < P75
  HIGH: 'HIGH', // P75 <= x < P90
  VERY_HIGH: 'VERY_HIGH', // x >= P90
});

/**
 * Clasifica un valor ACTUAL contra los breakpoints LOCALES de su propio
 * mes/potrero (§5/§6 del hardening) -- nunca contra un umbral absoluto
 * universal.
 */
export function classifyLevel(value, breakpoints) {
  if (typeof value !== 'number' || !Number.isFinite(value) || !breakpoints) return null;
  if (value <= breakpoints.p10) return LEVEL.VERY_LOW;
  if (value <= breakpoints.p25) return LEVEL.LOW;
  if (value < breakpoints.p75) return LEVEL.NORMAL;
  if (value < breakpoints.p90) return LEVEL.HIGH;
  return LEVEL.VERY_HIGH;
}

/**
 * Anomalía respecto a la mediana histórica LOCAL de ese mes -- absoluta
 * siempre; porcentual SOLO cuando la mediana no está peligrosamente cerca
 * de cero (§5 del hardening: "evitar dividir por normales cercanas a
 * cero" -- relevante sobre todo en precipitación de época seca).
 */
const ANOMALY_PCT_EPSILON = 1e-6;

export function computeAnomaly(value, breakpoints) {
  if (typeof value !== 'number' || !Number.isFinite(value) || !breakpoints) {
    return { anomalyAbsolute: null, anomalyPct: null, level: null };
  }
  const anomalyAbsolute = value - breakpoints.p50;
  const anomalyPct = Math.abs(breakpoints.p50) > ANOMALY_PCT_EPSILON ? (anomalyAbsolute / breakpoints.p50) * 100 : null;
  return {
    anomalyAbsolute,
    anomalyPct,
    level: classifyLevel(value, breakpoints),
  };
}
