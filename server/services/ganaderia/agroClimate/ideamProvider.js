// SPRINT-3D7.1-AGROCLIMA: proveedor IDEAM (fuente observacional
// complementaria, §5/§6/§7 del sprint).
//
// HARDENING SOURCE-INTEGRITY (revisión posterior al handoff inicial):
// el dataset de LECTURAS (57sv-p2fu) NO es catálogo autoritativo de
// estaciones -- solo contiene estaciones que ya tienen lecturas recientes,
// nunca el universo real de estaciones IDEAM (activas, suspendidas,
// distintas categorías/tecnologías). Discovery y observación quedan
// SEPARADOS en dos datasets Socrata reales, auditados en vivo:
//
//   CATÁLOGO -- "Catálogo Nacional de Estaciones del IDEAM", dataset
//   hp9r-jxuu (https://www.datos.gov.co/resource/hp9r-jxuu.json). Campos
//   reales confirmados: codigo, nombre, categoria, tecnologia, estado,
//   departamento, municipio, ubicaci_n, altitud, longitud, latitud,
//   fecha_instalacion, area_operativa, area_hidrografica,
//   zona_hidrografica, subzona_hidrografica, entidad. `codigo` usa el
//   mismo formato/valores que `codigoestacion` del dataset de lecturas
//   (verificado cruzando estaciones conocidas de ambos datasets).
//
//   OBSERVACIONES -- "Datos de Estaciones de IDEAM y de Terceros",
//   dataset 57sv-p2fu (https://www.datos.gov.co/resource/57sv-p2fu.json).
//   Campos reales: codigoestacion, nombreestacion, latitud, longitud,
//   departamento, municipio, zonahidrografica, codigosensor,
//   descripcionsensor, unidadmedida, fechaobservacion, valorobservado,
//   entidad. Se consulta EXCLUSIVAMENTE por codigoestacion, después de
//   que discoverNearbyIdeamStations() ya resolvió candidatas desde el
//   catálogo (§6 del hardening).
//
// Códigos de sensor usados en 57sv-p2fu (confirmados por consulta $group
// real):
//   0068 Temperatura del aire a 2m (°C)      0069 Temperatura máxima (°C)
//   0070 Temperatura mínima (°C)             0027 Humedad relativa 2m (%)
//   0240 Precipitación acumulada 10min (mm)  0103 Velocidad del viento (m/s)
//   0246 Humedad relativa del suelo 30cm (%) 0247 Humedad relativa del suelo 50cm (%)
// 0246/0247 son % de humedad relativa del SUELO a una profundidad fija --
// NO la misma magnitud física que el contenido volumétrico m³/m³ de
// ERA5-Land (layer1/layer2, 0-7cm/7-28cm). Sin una conversión válida entre
// ambas, este proveedor las expone únicamente como dato IDEAM propio
// (metadata) -- nunca sustituyen a humedad_suelo_superficial/
// subsuperficial del snapshot (§22 del sprint original: no mezclar
// unidades sin conversión explícita).
//
// SEMÁNTICA TEMPORAL DE fechaobservacion (hardening §9): el metadata real
// de Socrata (GET /api/views/57sv-p2fu.json, campo `columns`) declara
// `fechaobservacion` como dataTypeName "calendar_date" -- un Floating
// Timestamp (SoQL), es decir: SIN zona horaria asociada. NO es texto
// plano (el error de la primera verificación real, "type-mismatch ...
// is text", venía de que el LITERAL de comparación llevaba sufijo `Z` +
// milisegundos, forma que SoQL no reconoce como floating_timestamp válido
// y por eso lo tipaba como texto -- la columna en sí siempre fue
// calendar_date). La corrección real es: los literales de comparación en
// $where deben expresarse en la MISMA forma floating (sin `Z`/offset),
// nunca que la columna sea texto. La conversión a UTC-5 que este módulo
// aplica para su propia aritmética de ventanas (24h/7d/...) es una
// ASUNCIÓN DE DOMINIO documentada (IDEAM es una entidad colombiana, sin
// horario de verano) -- Socrata NO confirma ni desmiente esa zona, por
// eso "floating": el dataset deliberadamente no la expresa. Nunca se
// envía ese offset asumido de vuelta en el texto del literal SoQL.
//
// CALIDAD (§7 del sprint original): IDEAM advierte que sus datos abiertos
// pueden ser crudos, no validados, con retrasos/inconsistencias -- toda
// lectura de este proveedor se marca quality='raw_observed'.
import { AGRO_CLIMATE_SOURCES, AGRO_CLIMATE_QUALITY, buildAgroClimateObservation } from './agroClimateObservation.js';

const CATALOG_DATASET_ID = 'hp9r-jxuu';
const OBSERVATION_DATASET_ID = '57sv-p2fu';
const DEFAULT_CATALOG_BASE_URL = `https://www.datos.gov.co/resource/${CATALOG_DATASET_ID}.json`;
const DEFAULT_OBSERVATION_BASE_URL = `https://www.datos.gov.co/resource/${OBSERVATION_DATASET_ID}.json`;
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_RETRIES = 1;
const DEFAULT_RETRY_DELAY_MS = 300;

const SENSOR = Object.freeze({
  TEMP_MEDIA: '0068',
  TEMP_MAX: '0069',
  TEMP_MIN: '0070',
  HUMEDAD_RELATIVA: '0027',
  PRECIPITACION: '0240',
  VIENTO: '0103',
  SUELO_30CM: '0246',
  SUELO_50CM: '0247',
});

const READING_SENSOR_CODES = Object.values(SENSOR);

export class IdeamProviderError extends Error {
  constructor(message, { code = 'IDEAM_UNAVAILABLE', cause, transient = true } = {}) {
    super(message);
    this.name = 'IdeamProviderError';
    this.code = code;
    this.transient = transient;
    if (cause) this.cause = cause;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveCatalogBaseUrl() {
  // Lazy, allowlisted por env -- nunca una URL del cliente/request (§17
  // del sprint original, defensa SSRF).
  return process.env.IDEAM_CATALOG_BASE_URL || DEFAULT_CATALOG_BASE_URL;
}

function resolveObservationBaseUrl() {
  return process.env.IDEAM_SOCRATA_BASE_URL || DEFAULT_OBSERVATION_BASE_URL;
}

function resolveAppToken() {
  // Opcional (§19 del sprint original): Socrata permite consumo público
  // sin token, el token solo mejora rate limits. Nunca exigido para
  // arrancar la aplicación.
  return process.env.IDEAM_SOCRATA_APP_TOKEN || null;
}

async function fetchJsonWithTimeout(url, { timeoutMs, fetchImpl, headers }) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal, headers });
    if (!response.ok) {
      const isClientError = response.status >= 400 && response.status < 500 && response.status !== 429;
      throw new IdeamProviderError(`IDEAM (Datos Abiertos) respondió ${response.status}.`, {
        code: 'IDEAM_HTTP_ERROR',
        transient: !isClientError,
      });
    }
    return await response.json();
  } catch (error) {
    if (error instanceof IdeamProviderError) throw error;
    if (error?.name === 'AbortError') {
      throw new IdeamProviderError(`Timeout (${timeoutMs}ms) al consultar IDEAM.`, { cause: error });
    }
    throw new IdeamProviderError('Error de red al consultar IDEAM.', { cause: error });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchJsonWithRetry(url, { timeoutMs, retries, retryDelayMs, fetchImpl, headers }) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fetchJsonWithTimeout(url, { timeoutMs, fetchImpl, headers });
    } catch (error) {
      lastError = error;
      if (error?.transient === false || attempt === retries) throw error;
      await sleep(retryDelayMs * (attempt + 1));
    }
  }
  throw lastError;
}

function buildHeaders() {
  const appToken = resolveAppToken();
  return appToken ? { 'X-App-Token': appToken } : undefined;
}

// Radio de la Tierra en km -- fórmula de Haversine estándar.
const EARTH_RADIUS_KM = 6371;

function haversineDistanceKm(lat1, lng1, lat2, lng2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const DEFAULT_RADIUS_KM = 100;
const DEFAULT_MAX_STATIONS = 8;
// ~1 grado de latitud ~ 111km -- caja amplia alrededor del punto, filtrada
// después por distancia real (Haversine), nunca solo por la caja.
function degreesForRadius(radiusKm) {
  return radiusKm / 111;
}

// Literal floating_timestamp para $where -- MISMA forma que ya usa la
// columna calendar_date del dataset (sin Z/offset, ver cabecera). La
// resta de 5h es la asunción de dominio (hora local Colombia) usada
// SOLO para nuestra propia aritmética de ventanas -- nunca se afirma que
// Socrata confirme esa zona. Exportada para prueba directa (§9/§10 del
// hardening).
export function formatIdeamFloatingTimestamp(date) {
  const localMs = date.getTime() - 5 * 3600 * 1000;
  return new Date(localMs).toISOString().slice(0, 23);
}

// §7 del hardening: evaluación explícita (no scoring) de si una estación
// del catálogo luce operativa -- nunca se asume que toda estación
// "cercana" sirve. estado real observado incluye valores como "Activa"/
// "Suspendida". Coincidencia por palabra clave, tolerante a variantes no
// vistas todavía (mejor sub-incluir que excluir de forma silenciosa).
function isLikelyOperational(estado) {
  const value = String(estado || '').toLowerCase();
  if (!value) return true; // sin dato de estado -- no descartar a ciegas.
  return !/(suspend|inactiv|cancelad|retirad|clausurad)/.test(value);
}

/**
 * Descubre estaciones del CATÁLOGO NACIONAL IDEAM (hp9r-jxuu) cerca de
 * (lat, lng), ordenadas por distancia real (Haversine) -- §5 del sprint
 * original + §6 del hardening: el catálogo, no las lecturas, es la
 * fuente autoritativa de qué estaciones existen. No filtra por
 * disponibilidad de observaciones -- eso se resuelve después, por
 * separado, contra 57sv-p2fu (ver selectIdeamStation).
 */
export async function discoverNearbyIdeamStations({
  lat,
  lng,
  radiusKm = DEFAULT_RADIUS_KM,
  maxStations = DEFAULT_MAX_STATIONS,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retries = DEFAULT_RETRIES,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
} = {}) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new IdeamProviderError('lat/lng inválidos para descubrir estaciones IDEAM.', {
      code: 'IDEAM_INVALID_POINT',
      transient: false,
    });
  }

  const delta = degreesForRadius(radiusKm);

  const url = new URL(resolveCatalogBaseUrl());
  url.searchParams.set(
    '$select',
    'codigo,nombre,categoria,tecnologia,estado,departamento,municipio,altitud,latitud,longitud',
  );
  url.searchParams.set(
    '$where',
    `latitud between ${lat - delta} and ${lat + delta} and longitud between ${lng - delta} and ${lng + delta}`,
  );
  url.searchParams.set('$limit', '500');

  const rows = await fetchJsonWithRetry(url.toString(), {
    timeoutMs, retries, retryDelayMs, fetchImpl, headers: buildHeaders(),
  });
  if (!Array.isArray(rows)) {
    throw new IdeamProviderError('Respuesta del catálogo de estaciones IDEAM malformada.', {
      code: 'IDEAM_MALFORMED_RESPONSE',
      transient: false,
    });
  }

  return rows
    .map((row) => {
      const stationLat = Number(row.latitud);
      const stationLng = Number(row.longitud);
      if (!Number.isFinite(stationLat) || !Number.isFinite(stationLng)) return null;
      return {
        stationCode: row.codigo,
        stationName: row.nombre,
        categoria: row.categoria ?? null,
        tecnologia: row.tecnologia ?? null,
        estado: row.estado ?? null,
        departamento: row.departamento ?? null,
        municipio: row.municipio ?? null,
        altitud: row.altitud !== undefined && row.altitud !== null && row.altitud !== '' ? Number(row.altitud) : null,
        lat: stationLat,
        lng: stationLng,
        distanceKm: haversineDistanceKm(lat, lng, stationLat, stationLng),
      };
    })
    .filter((station) => station && station.distanceKm <= radiusKm)
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, maxStations);
}

function meanOf(values) {
  if (values.length === 0) return null;
  return values.reduce((acc, v) => acc + v, 0) / values.length;
}

function sumOf(values) {
  if (values.length === 0) return null;
  return values.reduce((acc, v) => acc + v, 0);
}

/**
 * Lee y agrega las lecturas crudas de UNA estación ya identificada por el
 * catálogo (últimos 30 días, una sola consulta a 57sv-p2fu) y normaliza
 * al modelo común. Lanza IDEAM_NO_DATA (no transitorio) si la estación no
 * tiene ninguna lectura en la ventana -- selectIdeamStation() usa
 * exactamente esta señal para distinguir "estación sin datos recientes"
 * de "sin estaciones cercanas en el catálogo" (§6 del hardening).
 */
export async function fetchIdeamObservation({
  stationCode,
  stationName = null,
  categoria = null,
  tecnologia = null,
  estado = null,
  distanceKm = null,
  now = new Date(),
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retries = DEFAULT_RETRIES,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
} = {}) {
  // codigoestacion se interpola directamente en el $where de SoQL --
  // formato estricto (alfanumérico) como defensa en profundidad, aunque
  // hoy siempre llega desde discoverNearbyIdeamStations().
  if (!stationCode || !/^[A-Za-z0-9]+$/.test(String(stationCode))) {
    throw new IdeamProviderError('stationCode requerido/inválido para consultar IDEAM.', {
      code: 'IDEAM_INVALID_STATION',
      transient: false,
    });
  }

  const since = new Date(now);
  since.setUTCDate(since.getUTCDate() - 30);
  const sinceText = formatIdeamFloatingTimestamp(since);

  const url = new URL(resolveObservationBaseUrl());
  url.searchParams.set('$select', 'codigosensor,fechaobservacion,valorobservado');
  url.searchParams.set(
    '$where',
    `codigoestacion='${stationCode}' and fechaobservacion > '${sinceText}'`
    + ` and codigosensor in (${READING_SENSOR_CODES.map((c) => `'${c}'`).join(',')})`,
  );
  url.searchParams.set('$order', 'fechaobservacion');
  url.searchParams.set('$limit', '50000');

  const rows = await fetchJsonWithRetry(url.toString(), {
    timeoutMs, retries, retryDelayMs, fetchImpl, headers: buildHeaders(),
  });
  if (!Array.isArray(rows)) {
    throw new IdeamProviderError('Respuesta de lecturas IDEAM malformada.', {
      code: 'IDEAM_MALFORMED_RESPONSE',
      transient: false,
    });
  }
  if (rows.length === 0) {
    throw new IdeamProviderError(`La estación IDEAM ${stationCode} no tiene lecturas en los últimos 30 días.`, {
      code: 'IDEAM_NO_DATA',
      transient: false,
    });
  }

  const parsed = rows
    .map((row) => {
      // Ver cabecera del archivo -- calendar_date/Floating Timestamp,
      // asunción de dominio UTC-5 solo para nuestra aritmética interna.
      const raw = String(row.fechaobservacion || '');
      const withOffset = /[zZ]|[+-]\d{2}:?\d{2}$/.test(raw) ? raw : `${raw}-05:00`;
      return {
        sensor: row.codigosensor,
        timestamp: row.fechaobservacion,
        value: Number(row.valorobservado),
        time: Date.parse(withOffset),
      };
    })
    .filter((r) => Number.isFinite(r.value) && Number.isFinite(r.time));

  const nowMs = now.getTime();
  function windowValues(sensor, hoursBack) {
    const cutoff = nowMs - hoursBack * 3600 * 1000;
    return parsed.filter((r) => r.sensor === sensor && r.time >= cutoff).map((r) => r.value);
  }

  const latestTimestamp = parsed.reduce((max, r) => (r.time > max ? r.time : max), 0);

  const temp24h = windowValues(SENSOR.TEMP_MEDIA, 24);
  const tempMax24h = windowValues(SENSOR.TEMP_MAX, 24);
  const tempMin24h = windowValues(SENSOR.TEMP_MIN, 24);

  const variablesAvailable = Object.entries(SENSOR)
    .filter(([, code]) => parsed.some((r) => r.sensor === code))
    .map(([name]) => name);

  const observation = buildAgroClimateObservation({
    source: AGRO_CLIMATE_SOURCES.IDEAM,
    observedFrom: rows[0]?.fechaobservacion ?? null,
    observedUntil: latestTimestamp ? new Date(latestTimestamp).toISOString() : null,
    precipitacion24hMm: sumOf(windowValues(SENSOR.PRECIPITACION, 24)),
    precipitacion7dMm: sumOf(windowValues(SENSOR.PRECIPITACION, 24 * 7)),
    precipitacion15dMm: sumOf(windowValues(SENSOR.PRECIPITACION, 24 * 15)),
    precipitacion30dMm: sumOf(windowValues(SENSOR.PRECIPITACION, 24 * 30)),
    temperaturaMediaC: meanOf(temp24h),
    temperaturaMaxC: tempMax24h.length > 0 ? Math.max(...tempMax24h) : (temp24h.length > 0 ? Math.max(...temp24h) : null),
    temperaturaMinC: tempMin24h.length > 0 ? Math.min(...tempMin24h) : (temp24h.length > 0 ? Math.min(...temp24h) : null),
    humedadRelativaMediaPct: meanOf(windowValues(SENSOR.HUMEDAD_RELATIVA, 24)),
    vientoMedioMs: meanOf(windowValues(SENSOR.VIENTO, 24)),
    quality: AGRO_CLIMATE_QUALITY.RAW_OBSERVED,
    metadata: {
      provider: 'IDEAM_DATOS_ABIERTOS',
      catalogDataset: CATALOG_DATASET_ID,
      observationDataset: OBSERVATION_DATASET_ID,
      stationCode,
      stationName,
      categoria,
      tecnologia,
      estado,
      distanceKm,
      // % de humedad relativa del suelo a profundidad fija -- unidad
      // distinta de humedad_suelo_superficial/subsuperficial (m³/m³ ERA5,
      // ver cabecera). Solo trazabilidad, nunca mapeado al snapshot.
      humedadSuelo30cmPct: meanOf(windowValues(SENSOR.SUELO_30CM, 24)),
      humedadSuelo50cmPct: meanOf(windowValues(SENSOR.SUELO_50CM, 24)),
      readingCount: parsed.length,
      variablesAvailable,
    },
  });

  return observation;
}

const DEFAULT_MAX_CANDIDATES_TO_PROBE = 5;

/**
 * Orquestación IDEAM de dos etapas (§6/§7 del hardening): 1) catálogo
 * (discoverNearbyIdeamStations) 2) prueba de observaciones reales, en
 * orden de distancia (candidatas "no operativas" según estado quedan al
 * final, nunca excluidas de plano -- puede haber falsos negativos en el
 * campo `estado`). Devuelve un `outcome` explícito, nunca colapsa
 * "sin estaciones en el catálogo" con "estaciones sin datos recientes":
 *
 *   NO_STATION_NEARBY               -- catálogo vacío dentro del radio.
 *   STATION_FOUND_NO_RECENT_OBSERVATIONS -- había candidatas, ninguna
 *                                      probada tiene lecturas usables.
 *   STATION_FOUND                   -- estación + observación normalizada.
 */
export async function selectIdeamStation({
  lat,
  lng,
  radiusKm = DEFAULT_RADIUS_KM,
  maxStations = DEFAULT_MAX_STATIONS,
  maxCandidatesToProbe = DEFAULT_MAX_CANDIDATES_TO_PROBE,
  now = new Date(),
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retries = DEFAULT_RETRIES,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
} = {}) {
  const candidates = await discoverNearbyIdeamStations({
    lat, lng, radiusKm, maxStations, fetchImpl, timeoutMs, retries, retryDelayMs,
  });

  if (candidates.length === 0) {
    return { outcome: 'NO_STATION_NEARBY', candidatesFound: 0, candidatesProbed: [] };
  }

  // Estable: preserva el orden por distancia dentro de cada partición
  // (operativas primero, nunca excluye a las demás -- §7 del hardening).
  const ordered = candidates
    .map((station, index) => ({ station, index }))
    .sort((a, b) => {
      const opA = isLikelyOperational(a.station.estado) ? 0 : 1;
      const opB = isLikelyOperational(b.station.estado) ? 0 : 1;
      if (opA !== opB) return opA - opB;
      return a.index - b.index;
    })
    .map((entry) => entry.station);

  const probeList = ordered.slice(0, maxCandidatesToProbe);
  const candidatesProbed = [];

  for (const station of probeList) {
    try {
      const observation = await fetchIdeamObservation({
        stationCode: station.stationCode,
        stationName: station.stationName,
        categoria: station.categoria,
        tecnologia: station.tecnologia,
        estado: station.estado,
        distanceKm: station.distanceKm,
        now,
        fetchImpl,
        timeoutMs,
        retries,
        retryDelayMs,
      });
      return { outcome: 'STATION_FOUND', station, observation, candidatesProbed };
    } catch (error) {
      candidatesProbed.push({
        stationCode: station.stationCode,
        stationName: station.stationName,
        distanceKm: station.distanceKm,
        error: { code: error?.code || 'UNKNOWN_ERROR', message: error?.message || 'Error desconocido.' },
      });
    }
  }

  return { outcome: 'STATION_FOUND_NO_RECENT_OBSERVATIONS', candidatesFound: candidates.length, candidatesProbed };
}
