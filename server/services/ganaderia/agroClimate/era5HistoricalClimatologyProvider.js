// SPRINT-3D8-DESCANSO-REENTRADA (hardening territorial) §2/§3/§19: capa de
// obtención de series HISTÓRICAS diarias para climatología local -- MISMO
// mecanismo real ya verificado y en producción para el contexto actual
// (era5LandProvider.js: Open-Meteo Historical Weather API, modelo
// EXPLÍCITO era5_land/era5, nunca best_match), extendido a un rango de
// AÑOS en vez de una ventana de 33 días.
//
// PARTICIÓN POR AÑO (deliberada): una sola petición de 20-30 años a
// resolución horaria devolvería cientos de miles de puntos por variable
// -- payload/tiempo de respuesta poco confiables para una API pública sin
// SLA de bulk. Se pide un año calendario por petición (máx. 8784 horas)
// y se concatena -- mismo dato final, huella de red acotada y auditable
// por año (`yearsRequested`/`yearsFailed` en la metadata de salida).
//
// PERIODO (documentado, nunca hardcodeado sin razón, §3 del sprint
// original + auditoría empírica del hardening operacional §1): 1991-2020
// -- periodo climatológico normal ESTÁNDAR de la OMM/WMO (30 años).
//
// HARDENING OPERACIONAL §1 -- AUDITORÍA EMPÍRICA (2026-08-25): la primera
// versión de este archivo usaba una ventana MÁS CORTA (5 años) para
// humedad de suelo, alegando "limitación de payload". Verificado en vivo
// contra Open-Meteo (models=era5_land, hourly=soil_moisture_0_to_7cm,
// soil_moisture_7_to_28cm, temperature_2m) para 1991, 2000, 2010 y 2020 en
// el punto real de POTRERO 1 (lat 1.2499, lng -75.8848): las TRES
// variables devuelven 100% de horas con dato (72/72 en cada muestra de 3
// días, grid 1.2000046/-75.9) -- NO existe una limitación real de
// disponibilidad de la fuente. La ventana corta era una restricción
// autoimpuesta sin evidencia, ya corregida: humedad de suelo usa el MISMO
// periodo 1991-2020 que precipitación/temperatura. La partición por año
// (ver más abajo) ya mantenía cada petición pequeña -- extender el
// periodo solo duplica el número de peticiones (60 -> 120 en total), no
// el tamaño de cada una.
// HARDENING OPERACIONAL §5/§6/§11 -- CONCURRENCIA + DEADLINE (medido en
// vivo, 2026-08-25, contra el punto real de POTRERO 1): una petición real
// de un año toma ~1.5-6.5s (curl directo, era5_land/era5). 120 peticiones
// (4 variables x 30 años) SECUENCIALES tardarían 4-6+ minutos -- muy por
// encima de cualquier timeout razonable de una petición HTTP síncrona. Se
// paraleliza en LOTES pequeños (nunca 120 peticiones simultáneas -- riesgo
// real de rate-limiting de una API pública gratuita) y se aplica un
// PRESUPUESTO DE TIEMPO explícito por variable: al agotarse, se deja de
// iniciar lotes nuevos (los ya en vuelo terminan) -- los años restantes
// quedan documentados en `yearsFailed` con motivo explícito, NUNCA la
// petición completa queda colgada indefinidamente.
import { resolveBaseUrl, fetchJsonWithRetry, sumIgnoringNulls, meanIgnoringNulls } from './era5LandProvider.js';

export const WMO_CLIMATOLOGY_PERIOD = Object.freeze({ startYear: 1991, endYear: 2020 });

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_RETRIES = 1;
const DEFAULT_RETRY_DELAY_MS = 500;

// Tamaño de lote concurrente por variable -- conservador, evita ráfagas
// de decenas de peticiones simultáneas contra una API pública gratuita.
export const DEFAULT_YEAR_BATCH_CONCURRENCY = 6;
// Presupuesto de tiempo por variable (§6 del hardening: medido, no
// inventado -- ver cabecera). Con lotes de 6 y ~2-6s por petición, permite
// completar aproximadamente 3-5 lotes (18-30 años) en la mayoría de los
// casos reales antes de degradar honestamente.
export const DEFAULT_VARIABLE_DEADLINE_MS = 25000;

const CORE_MODEL = 'era5_land';
const SECONDARY_MODEL = 'era5';

export class Era5HistoricalClimatologyError extends Error {
  constructor(message, { code = 'ERA5_HISTORICAL_UNAVAILABLE', cause, transient = true } = {}) {
    super(message);
    this.name = 'Era5HistoricalClimatologyError';
    this.code = code;
    this.transient = transient;
    if (cause) this.cause = cause;
  }
}

function buildYearRequestUrl({ lat, lng, year, model, hourlyVars }) {
  const url = new URL(resolveBaseUrl());
  url.searchParams.set('latitude', String(lat));
  url.searchParams.set('longitude', String(lng));
  url.searchParams.set('start_date', `${year}-01-01`);
  url.searchParams.set('end_date', `${year}-12-31`);
  url.searchParams.set('hourly', hourlyVars.join(','));
  url.searchParams.set('timezone', 'UTC');
  url.searchParams.set('models', model);
  if (process.env.ERA5_LAND_API_KEY) {
    url.searchParams.set('apikey', process.env.ERA5_LAND_API_KEY);
  }
  return url.toString();
}

/**
 * Agrega una serie horaria (con timestamps ISO 'YYYY-MM-DDTHH:mm') a
 * valores DIARIOS -- suma para precipitación, media para el resto. Mismos
 * agregadores (`sumIgnoringNulls`/`meanIgnoringNulls`) que el snapshot
 * actual, nunca una segunda definición de "agregar ignorando nulls".
 */
function aggregateHourlyToDaily({ time, values, method }) {
  const porDia = new Map();
  for (let i = 0; i < time.length; i += 1) {
    const dia = String(time[i]).slice(0, 10);
    if (!porDia.has(dia)) porDia.set(dia, []);
    porDia.get(dia).push(values[i]);
  }
  const dates = [...porDia.keys()].sort();
  const dailyValues = dates.map((dia) => {
    const horas = porDia.get(dia);
    // Un día con menos de 24 horas reportadas (borde del rango
    // solicitado, o fuente con huecos) se descarta -- nunca se agrega un
    // día parcial silenciosamente como si fuera un día completo.
    if (horas.length < 24) return null;
    return method === 'sum' ? sumIgnoringNulls(horas) : meanIgnoringNulls(horas);
  });
  return { dates, dailyValues };
}

async function fetchYear({ lat, lng, year, model, variable, method, fetchImpl, timeoutMs, retries, retryDelayMs }) {
  const url = buildYearRequestUrl({ lat, lng, year, model, hourlyVars: [variable] });
  const rawJson = await fetchJsonWithRetry(url, { timeoutMs, retries, retryDelayMs, fetchImpl });
  const hourly = rawJson?.hourly;
  if (!hourly || !Array.isArray(hourly.time) || !Array.isArray(hourly[variable])) {
    throw new Era5HistoricalClimatologyError(`Año ${year}: respuesta sin serie horaria para "${variable}".`, {
      code: 'ERA5_HISTORICAL_MALFORMED_RESPONSE', transient: false,
    });
  }
  return aggregateHourlyToDaily({ time: hourly.time, values: hourly[variable], method });
}

/**
 * Obtiene una serie diaria histórica para UNA variable, particionada por
 * año calendario (ver cabecera) Y por LOTES concurrentes con presupuesto
 * de tiempo explícito (§5/§6/§11 del hardening operacional -- medido en
 * vivo, nunca una petición síncrona colgada indefinidamente). Años
 * individuales que fallan (incluidos los que quedan fuera del
 * presupuesto) se documentan en `yearsFailed` -- nunca invalidan los años
 * que sí respondieron (mismo criterio de aislamiento de fallos que
 * agroClimateOrchestrator.js).
 */
export async function fetchHistoricalDailySeries({
  lat, lng, startYear, endYear, model, variable, method,
  fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS, retries = DEFAULT_RETRIES, retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  batchConcurrency = DEFAULT_YEAR_BATCH_CONCURRENCY, deadlineMs = DEFAULT_VARIABLE_DEADLINE_MS,
}) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new Era5HistoricalClimatologyError('lat/lng inválidos para consultar climatología histórica.', {
      code: 'ERA5_HISTORICAL_INVALID_POINT', transient: false,
    });
  }

  const years = [];
  for (let year = startYear; year <= endYear; year += 1) years.push(year);

  const dates = [];
  const dailyValues = [];
  // §10 del hardening: `yearsRequested` es SIEMPRE el conjunto COMPLETO
  // solicitado (incluidos los años descartados por presupuesto de tiempo)
  // -- nunca se reduce artificialmente para inflar `coveragePct`.
  const yearsRequested = [...years];
  const yearsFailed = [];
  const startedAt = Date.now();

  for (let inicio = 0; inicio < years.length; inicio += batchConcurrency) {
    // Presupuesto de tiempo (§6 del hardening: medido, no inventado) --
    // al agotarse, NO se inician lotes nuevos. El lote en vuelo (si lo
    // hay) ya se resolvió antes de esta comprobación -- nunca se
    // interrumpe una petición a mitad de vuelo, solo se detiene el AVANCE.
    if (Date.now() - startedAt >= deadlineMs) {
      for (const year of years.slice(inicio)) {
        yearsFailed.push({ year, code: 'ERA5_HISTORICAL_TIMEOUT_BUDGET_EXCEEDED', message: `Presupuesto de tiempo (${deadlineMs}ms) agotado antes de solicitar el año ${year}.` });
      }
      break;
    }

    const lote = years.slice(inicio, inicio + batchConcurrency);
    const resultados = await Promise.allSettled(lote.map((year) => fetchYear({ lat, lng, year, model, variable, method, fetchImpl, timeoutMs, retries, retryDelayMs })));

    resultados.forEach((resultado, i) => {
      const year = lote[i];
      if (resultado.status === 'fulfilled') {
        dates.push(...resultado.value.dates);
        dailyValues.push(...resultado.value.dailyValues);
      } else {
        const error = resultado.reason;
        yearsFailed.push({ year, code: error?.code || 'UNKNOWN_ERROR', message: error?.message || 'Error desconocido.' });
      }
    });
  }

  if (dates.length === 0) {
    throw new Era5HistoricalClimatologyError(
      `No fue posible obtener ningún año de la ventana histórica solicitada (${startYear}-${endYear}) para "${variable}".`,
      { code: 'ERA5_HISTORICAL_NO_DATA', transient: yearsFailed.every((y) => y.code !== 'ERA5_HISTORICAL_MALFORMED_RESPONSE') },
    );
  }

  return { dates, dailyValues, yearsRequested, yearsFailed };
}

/**
 * Orquesta las series necesarias para climatología local completa (§2 del
 * hardening) -- precipitación/temperatura/humedad de suelo, TODAS con el
 * MISMO periodo climatológico (§1 del hardening operacional: auditoría
 * empírica confirmó que humedad de suelo tiene la misma disponibilidad
 * histórica real, ninguna variable usa una ventana más corta). Aísla
 * fallos por variable -- una variable sin datos suficientes no invalida
 * las demás (se refleja en `fuentes`, nunca silenciosamente).
 */
export async function fetchPotreroLocalClimatologySource({
  lat, lng,
  climatologyPeriod = WMO_CLIMATOLOGY_PERIOD,
  now = new Date(),
  fetchImpl = fetch,
  batchConcurrency = DEFAULT_YEAR_BATCH_CONCURRENCY,
  deadlineMs = DEFAULT_VARIABLE_DEADLINE_MS,
} = {}) {
  // HARDENING OPERACIONAL §5/§6: las 4 variables se piden EN PARALELO
  // (nunca 4 rondas secuenciales) -- el tiempo total de la orquestación
  // queda acotado por la variable más lenta, no por la suma de las 4.
  const especificaciones = [
    { nombre: 'precipitacionDiariaMm', model: SECONDARY_MODEL, variable: 'precipitation', method: 'sum' },
    { nombre: 'temperaturaMediaDiariaC', model: CORE_MODEL, variable: 'temperature_2m', method: 'mean' },
    { nombre: 'humedadSueloSuperficialDiaria', model: CORE_MODEL, variable: 'soil_moisture_0_to_7cm', method: 'mean' },
    { nombre: 'humedadSueloSubsuperficialDiaria', model: CORE_MODEL, variable: 'soil_moisture_7_to_28cm', method: 'mean' },
  ];

  const resultados = await Promise.all(especificaciones.map(async ({ nombre, model, variable, method }) => {
    try {
      const serie = await fetchHistoricalDailySeries({
        lat, lng, startYear: climatologyPeriod.startYear, endYear: climatologyPeriod.endYear,
        model, variable, method, fetchImpl, batchConcurrency, deadlineMs,
      });
      return { nombre, serie, fuente: { variable: nombre, disponible: true, yearsFailed: serie.yearsFailed } };
    } catch (error) {
      return { nombre, serie: null, fuente: { variable: nombre, disponible: false, error: { code: error?.code || 'UNKNOWN_ERROR', message: error?.message } } };
    }
  }));

  const porNombre = Object.fromEntries(resultados.map((r) => [r.nombre, r.serie]));
  const fuentes = resultados.map((r) => r.fuente);

  return {
    precipitacionDiariaMm: porNombre.precipitacionDiariaMm,
    temperaturaMediaDiariaC: porNombre.temperaturaMediaDiariaC,
    humedadSueloSuperficialDiaria: porNombre.humedadSueloSuperficialDiaria,
    humedadSueloSubsuperficialDiaria: porNombre.humedadSueloSubsuperficialDiaria,
    metadata: {
      provider: 'OPEN_METEO',
      climatologyPeriod,
      fuentes,
      generatedAt: now.toISOString(),
    },
  };
}
