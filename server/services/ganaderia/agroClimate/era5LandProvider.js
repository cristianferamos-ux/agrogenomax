// SPRINT-3D7.1-AGROCLIMA: proveedor ERA5-Land (fuente primaria, §2/§3 del
// sprint original).
//
// MECANISMO DE ENTREGA: Open-Meteo (https://open-meteo.com) republica los
// productos de reanálisis de Copernicus/ECMWF a través de su "Historical
// Weather API" (https://archive-api.open-meteo.com/v1/archive), sin API
// key para uso no comercial. El acceso directo al CDS de Copernicus
// requiere cuenta + colas asíncronas de minutos/horas -- inviable para
// una consulta síncrona por potrero.
//
// HARDENING SOURCE-INTEGRITY (revisión posterior al handoff inicial):
// la primera versión de este archivo NO fijaba el parámetro `models` --
// Open-Meteo usa por defecto "Best Match", que la propia documentación
// describe así: "The default Best Match combines IFS HRES, ERA5 and
// ERA5-Land seamlessly." Verificado en vivo: sin `models` explícito, el
// grid devuelto (1.2302284, -75.86423) NO corresponde a la resolución
// 0.1° de ERA5-Land, y `sourceObservedUntil` llegaba hasta el mismo día
// (contradice el rezago documentado de ERA5-Land) -- consistente con que
// Best Match estaba rellenando con IFS HRES casi en tiempo real. Con
// `models=era5_land` forzado explícitamente, el grid pasa a
// (1.2000046, -75.9) (snap real a 0.1°) y el rezago observado es de
// ~145h (~6 días), coherente con la documentación de ERA5-Land.
//
// HALLAZGO ADICIONAL (variable por variable, verificado en vivo con
// `models=era5_land` forzado): precipitation, shortwave_radiation y
// wind_speed_10m vienen SIEMPRE null bajo el modelo era5_land puro en
// esta API -- Open-Meteo no expone esas tres variables para ese modelo
// específico (solo temperature_2m/dew_point_2m/soil_moisture_*). Esas
// tres SÍ están disponibles bajo `models=era5` (ECMWF ERA5 global,
// 0.25°, mismo rezago ~145h verificado). Por tanto este proveedor hace
// DOS peticiones explícitas, cada una con su propio `models` fijo (nunca
// Best Match/default), y compone el resultado documentando la
// procedencia real por variable (`metadata.variableProvenance`) -- nunca
// se etiqueta todo como "ERA5-Land" de forma simplificada.
import { computeRelativeHumidityFromDewPoint } from '../agroClimateFormulas.js';
import { AGRO_CLIMATE_SOURCES, AGRO_CLIMATE_QUALITY, buildAgroClimateObservation } from './agroClimateObservation.js';

const DEFAULT_BASE_URL = 'https://archive-api.open-meteo.com/v1/archive';
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_RETRIES = 1; // máximo 2 intentos totales (§16 del sprint original).
const DEFAULT_RETRY_DELAY_MS = 300;
const REQUEST_WINDOW_DAYS = 33; // 30 días + margen de rezago/redondeo.

// Modelos EXPLÍCITOS -- nunca 'best_match'/default (ver cabecera).
const CORE_MODEL = 'era5_land'; // temperatura/dewpoint/suelo -- resolución 0.1°.
const SECONDARY_MODEL = 'era5'; // precipitación/radiación/viento -- resolución 0.25°.

const CORE_HOURLY_VARS = ['temperature_2m', 'dew_point_2m', 'soil_moisture_0_to_7cm', 'soil_moisture_7_to_28cm'];
const SECONDARY_HOURLY_VARS = ['precipitation', 'shortwave_radiation', 'wind_speed_10m'];

export class Era5LandProviderError extends Error {
  constructor(message, { code = 'ERA5_LAND_UNAVAILABLE', cause, transient = true } = {}) {
    super(message);
    this.name = 'Era5LandProviderError';
    this.code = code;
    this.transient = transient;
    if (cause) this.cause = cause;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

// Exportada (hardening territorial, SPRINT-3D8) -- resuelve la MISMA base
// URL allowlisted por env que el resto de este proveedor, reutilizada por
// era5HistoricalClimatologyProvider.js para no duplicar la política de
// allowlist (evita SSRF).
export function resolveBaseUrl() {
  // Lazy, allowlisted por env -- nunca una URL aportada por el
  // cliente/request (evita SSRF).
  return process.env.ERA5_LAND_BASE_URL || DEFAULT_BASE_URL;
}

function buildRequestUrl({ lat, lng, now, models, hourlyVars }) {
  const endDate = new Date(now);
  const startDate = new Date(now);
  startDate.setUTCDate(startDate.getUTCDate() - REQUEST_WINDOW_DAYS);

  const url = new URL(resolveBaseUrl());
  url.searchParams.set('latitude', String(lat));
  url.searchParams.set('longitude', String(lng));
  url.searchParams.set('start_date', formatDate(startDate));
  url.searchParams.set('end_date', formatDate(endDate));
  url.searchParams.set('hourly', hourlyVars.join(','));
  url.searchParams.set('timezone', 'UTC');
  url.searchParams.set('wind_speed_unit', 'ms');
  // Modelo EXPLÍCITO -- nunca omitido (ver cabecera: omitirlo activa
  // "Best Match", que mezcla IFS HRES/ERA5/ERA5-Land sin distinción).
  url.searchParams.set('models', models);
  // Opcional: solo necesario para el tier comercial de Open-Meteo -- nunca
  // exigido para arrancar la aplicación (§18/§19 del sprint original).
  if (process.env.ERA5_LAND_API_KEY) {
    url.searchParams.set('apikey', process.env.ERA5_LAND_API_KEY);
  }
  return url.toString();
}

async function fetchJsonWithTimeout(url, { timeoutMs, fetchImpl }) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) {
      const isClientError = response.status >= 400 && response.status < 500 && response.status !== 429;
      throw new Era5LandProviderError(`Open-Meteo respondió ${response.status}.`, {
        code: 'ERA5_LAND_HTTP_ERROR',
        transient: !isClientError,
      });
    }
    return await response.json();
  } catch (error) {
    if (error instanceof Era5LandProviderError) throw error;
    if (error?.name === 'AbortError') {
      throw new Era5LandProviderError(`Timeout (${timeoutMs}ms) al consultar Open-Meteo.`, { cause: error });
    }
    throw new Era5LandProviderError('Error de red al consultar Open-Meteo.', { cause: error });
  } finally {
    clearTimeout(timeoutId);
  }
}

// Exportada (hardening territorial, SPRINT-3D8) -- timeout/retry genérico
// reutilizado por era5HistoricalClimatologyProvider.js, nunca una segunda
// implementación divergente de la política de reintentos.
export async function fetchJsonWithRetry(url, { timeoutMs, retries, retryDelayMs, fetchImpl }) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fetchJsonWithTimeout(url, { timeoutMs, fetchImpl });
    } catch (error) {
      lastError = error;
      if (error?.transient === false || attempt === retries) throw error;
      await sleep(retryDelayMs * (attempt + 1));
    }
  }
  throw lastError;
}

function lastValidIndex(values) {
  for (let i = values.length - 1; i >= 0; i -= 1) {
    if (Number.isFinite(values[i])) return i;
  }
  return -1;
}

function sliceWindow(values, endIndexInclusive, windowSize) {
  const start = Math.max(0, endIndexInclusive - windowSize + 1);
  return values.slice(start, endIndexInclusive + 1);
}

// Exportadas (hardening territorial, SPRINT-3D8): reutilizadas por
// era5HistoricalClimatologyProvider.js para agregar horario->diario sobre
// un histórico de años -- mismo criterio de agregación, nunca una segunda
// implementación divergente de "sumar ignorando nulls".
export function sumIgnoringNulls(values) {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return null;
  return finite.reduce((acc, v) => acc + v, 0);
}

export function meanIgnoringNulls(values) {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return null;
  return finite.reduce((acc, v) => acc + v, 0) / finite.length;
}

function minIgnoringNulls(values) {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return null;
  return Math.min(...finite);
}

function maxIgnoringNulls(values) {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return null;
  return Math.max(...finite);
}

async function fetchModel(model, hourlyVars, { lat, lng, now, timeoutMs, retries, retryDelayMs, fetchImpl }) {
  const url = buildRequestUrl({ lat, lng, now, models: model, hourlyVars });
  const rawJson = await fetchJsonWithRetry(url, { timeoutMs, retries, retryDelayMs, fetchImpl });
  const hourly = rawJson?.hourly;
  if (!hourly || !Array.isArray(hourly.time) || hourly.time.length === 0) {
    throw new Era5LandProviderError(`Respuesta de Open-Meteo (modelo ${model}) sin serie horaria ("hourly").`, {
      code: 'ERA5_LAND_MALFORMED_RESPONSE',
      transient: false,
    });
  }
  return { rawJson, hourly };
}

/**
 * Núcleo ERA5-Land puro (temperatura/dewpoint/suelo, modelo era5_land
 * explícito, resolución 0.1°). Si falla, TODA la observación ERA5-Land
 * falla -- estas variables definen la identidad "ERA5-Land" del snapshot
 * (mismo criterio que agx.potrero_contextos_agroclimaticos.fuente_principal).
 */
function parseCoreWindow(hourly) {
  const temperature = hourly.temperature_2m || [];
  const dewPoint = hourly.dew_point_2m || [];
  const soilLayer1 = hourly.soil_moisture_0_to_7cm || [];
  const soilLayer2 = hourly.soil_moisture_7_to_28cm || [];

  const endIndex = lastValidIndex(temperature);
  if (endIndex === -1) {
    throw new Era5LandProviderError('ERA5-Land (modelo era5_land) no tiene ningún dato de temperatura disponible todavía para este punto.', {
      code: 'ERA5_LAND_NO_DATA',
      transient: false,
    });
  }

  const temp24h = sliceWindow(temperature, endIndex, 24);
  const dew24h = sliceWindow(dewPoint, endIndex, 24);
  const rhSeries24h = temp24h.map((t, i) => computeRelativeHumidityFromDewPoint(t, dew24h[i]));

  return {
    observedFrom: hourly.time[0],
    observedUntil: hourly.time[endIndex],
    temperaturaMediaC: meanIgnoringNulls(temp24h),
    temperaturaMinC: minIgnoringNulls(temp24h),
    temperaturaMaxC: maxIgnoringNulls(temp24h),
    humedadRelativaMediaPct: meanIgnoringNulls(rhSeries24h),
    humedadSueloSuperficial: meanIgnoringNulls(sliceWindow(soilLayer1, endIndex, 24)),
    humedadSueloSubsuperficial: meanIgnoringNulls(sliceWindow(soilLayer2, endIndex, 24)),
  };
}

/**
 * Secundario (precipitación/radiación/viento, modelo era5 explícito,
 * 0.25°) -- ver hallazgo de cabecera: ERA5-Land puro no expone estas
 * variables en esta API. Un fallo aquí NO invalida el núcleo -- se
 * documenta como fallo parcial en metadata, los campos quedan null
 * (§15 del sprint original: aislamiento de fallos, ahora también
 * intra-proveedor).
 */
function parseSecondaryWindow(hourly) {
  const precipitation = hourly.precipitation || [];
  const radiation = hourly.shortwave_radiation || [];
  const windSpeed = hourly.wind_speed_10m || [];

  const referenceSeries = precipitation.length > 0 ? precipitation : windSpeed;
  const endIndex = lastValidIndex(referenceSeries.length > 0 ? referenceSeries : radiation);
  if (endIndex === -1) {
    throw new Era5LandProviderError('ERA5 (modelo era5, secundario) no tiene datos de precipitación/radiación/viento disponibles todavía para este punto.', {
      code: 'ERA5_SECONDARY_NO_DATA',
      transient: false,
    });
  }

  return {
    observedFrom: hourly.time[0],
    observedUntil: hourly.time[endIndex],
    precipitacion24hMm: sumIgnoringNulls(sliceWindow(precipitation, endIndex, 24)),
    precipitacion7dMm: sumIgnoringNulls(sliceWindow(precipitation, endIndex, 24 * 7)),
    precipitacion15dMm: sumIgnoringNulls(sliceWindow(precipitation, endIndex, 24 * 15)),
    precipitacion30dMm: sumIgnoringNulls(sliceWindow(precipitation, endIndex, 24 * 30)),
    radiacionSolar: meanIgnoringNulls(sliceWindow(radiation, endIndex, 24)),
    vientoMedioMs: meanIgnoringNulls(sliceWindow(windSpeed, endIndex, 24)),
  };
}

/**
 * Punto de entrada del proveedor -- dos peticiones con modelo EXPLÍCITO
 * cada una (nunca Best Match), timeout/retry/abort independientes por
 * petición (§16 del sprint original). El núcleo (era5_land) es
 * obligatorio; el secundario (era5) es best-effort -- su fallo se
 * documenta, nunca invalida el núcleo.
 */
export async function fetchEra5LandObservation({
  lat,
  lng,
  now = new Date(),
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retries = DEFAULT_RETRIES,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
} = {}) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new Era5LandProviderError('lat/lng inválidos para consultar ERA5-Land.', {
      code: 'ERA5_LAND_INVALID_POINT',
      transient: false,
    });
  }

  const fetchOpts = { lat, lng, now, timeoutMs, retries, retryDelayMs, fetchImpl };

  const { rawJson: coreRaw, hourly: coreHourly } = await fetchModel(CORE_MODEL, CORE_HOURLY_VARS, fetchOpts);
  const core = parseCoreWindow(coreHourly);

  let secondary = null;
  let secondaryMeta = null;
  let secondaryError = null;
  try {
    const { rawJson: secondaryRaw, hourly: secondaryHourly } = await fetchModel(SECONDARY_MODEL, SECONDARY_HOURLY_VARS, fetchOpts);
    secondary = parseSecondaryWindow(secondaryHourly);
    secondaryMeta = {
      gridLat: secondaryRaw.latitude ?? lat,
      gridLng: secondaryRaw.longitude ?? lng,
      resolutionDeg: 0.25,
      observedUntil: secondary.observedUntil,
    };
  } catch (error) {
    secondaryError = { code: error?.code || 'UNKNOWN_ERROR', message: error?.message || 'Error desconocido.' };
  }

  const variableProvenance = {
    temperature_2m: 'ERA5_LAND', dew_point_2m: 'ERA5_LAND',
    soil_moisture_0_to_7cm: 'ERA5_LAND', soil_moisture_7_to_28cm: 'ERA5_LAND',
    precipitation: secondary ? 'ERA5' : null,
    shortwave_radiation: secondary ? 'ERA5' : null,
    wind_speed_10m: secondary ? 'ERA5' : null,
  };

  const observation = buildAgroClimateObservation({
    source: AGRO_CLIMATE_SOURCES.ERA5_LAND,
    observedFrom: core.observedFrom,
    observedUntil: core.observedUntil,
    lat,
    lng,
    precipitacion24hMm: secondary?.precipitacion24hMm ?? null,
    precipitacion7dMm: secondary?.precipitacion7dMm ?? null,
    precipitacion15dMm: secondary?.precipitacion15dMm ?? null,
    precipitacion30dMm: secondary?.precipitacion30dMm ?? null,
    temperaturaMediaC: core.temperaturaMediaC,
    temperaturaMinC: core.temperaturaMinC,
    temperaturaMaxC: core.temperaturaMaxC,
    humedadRelativaMediaPct: core.humedadRelativaMediaPct,
    humedadSueloSuperficial: core.humedadSueloSuperficial,
    humedadSueloSubsuperficial: core.humedadSueloSubsuperficial,
    radiacionSolar: secondary?.radiacionSolar ?? null,
    vientoMedioMs: secondary?.vientoMedioMs ?? null,
    quality: AGRO_CLIMATE_QUALITY.REANALYSIS,
    metadata: {
      provider: 'OPEN_METEO',
      dataset: 'ERA5_LAND',
      deliveryMechanism: 'open-meteo-historical-weather-api',
      model: CORE_MODEL,
      coreGridLat: coreRaw.latitude ?? lat,
      coreGridLng: coreRaw.longitude ?? lng,
      coreResolutionDeg: 0.1,
      coreObservedUntil: core.observedUntil,
      secondaryModel: secondary ? SECONDARY_MODEL : null,
      secondaryDataset: secondary ? 'ERA5' : null,
      secondaryGridLat: secondaryMeta?.gridLat ?? null,
      secondaryGridLng: secondaryMeta?.gridLng ?? null,
      secondaryResolutionDeg: secondaryMeta?.resolutionDeg ?? null,
      secondaryObservedUntil: secondaryMeta?.observedUntil ?? null,
      secondaryError,
      variableProvenance,
      soilMoistureUnit: 'm3/m3',
      radiationUnit: 'W/m2 (promedio horario)',
      windUnit: 'm/s',
    },
  });

  return observation;
}
