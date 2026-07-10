import { CATASTROX_STATUS } from '../data/catastroxMockData.js';
import { getCatastroxResultById, lookupPredioMock } from './catastroxMockService.js';

const CONFIGURED_API_BASE = import.meta.env.VITE_API_URL || import.meta.env.VITE_AGX_API_URL || '';
const LOCAL_API_BASE = '/api';
const LOCAL_DEV_API_BASES = ['http://127.0.0.1:3001/api', 'http://localhost:3001/api'];
const AUDIT_DOWNLOADS_ENABLED = String(import.meta.env.VITE_CATASTROX_AUDIT_DOWNLOADS || '').toLowerCase() === 'true';

export const CATASTROX_LOOKUP_STORAGE_KEY = 'catastrox_last_lookup';

export class CatastroxApiError extends Error {
  constructor(message, { code = 'API_ERROR', status = 0, url = '', payload = null } = {}) {
    super(message);
    this.name = 'CatastroxApiError';
    this.code = code;
    this.status = status;
    this.url = url;
    this.payload = payload;
  }
}

function isLookupNotFoundPayload(payload) {
  if (!payload || typeof payload !== 'object') return false;
  if (payload.found === false) return true;
  return typeof payload.status === 'string' && [
    'NO_PREDIO_INDIVIDUALIZADO',
    'SIN_COBERTURA_CATASTRAL',
    'PENDIENTE_VALIDACION',
  ].includes(payload.status);
}

function normalizeApiBase(value) {
  return String(value || '').trim().replace(/\/$/, '');
}

function buildApiUrl(apiBase, path) {
  const normalizedBase = normalizeApiBase(apiBase || LOCAL_API_BASE);
  return `${normalizedBase}${path}`;
}

function buildApiResourceUrl(apiBase, resourcePath, fallbackPath) {
  const resource = cleanText(resourcePath) || fallbackPath;
  if (/^https?:\/\//i.test(resource)) return resource;

  const normalizedBase = normalizeApiBase(apiBase || LOCAL_API_BASE);
  if (resource.startsWith('/api/')) {
    if (normalizedBase === LOCAL_API_BASE) return resource;
    return `${normalizedBase.replace(/\/api$/, '')}${resource}`;
  }

  if (resource.startsWith('/')) return `${normalizedBase}${resource}`;
  return `${normalizedBase}/${resource}`;
}

function isLocalHostname() {
  if (typeof window === 'undefined') return false;
  return ['localhost', '127.0.0.1'].includes(window.location.hostname);
}

function runtimeApiBaseFromQuery() {
  if (typeof window === 'undefined') return '';

  const params = new URLSearchParams(window.location.search);
  const urlParam = params.get('agx_api_url') || params.get('apiUrl');
  if (!urlParam) return '';

  const normalized = normalizeApiBase(urlParam);
  window.localStorage?.setItem('agx_api_url', normalized);
  return normalized;
}

function runtimeApiBaseFromStorage() {
  if (typeof window === 'undefined') return '';
  return normalizeApiBase(window.localStorage?.getItem('agx_api_url'));
}

function getApiBaseCandidates() {
  const configuredApiBase = normalizeApiBase(CONFIGURED_API_BASE);
  const queryApiBase = runtimeApiBaseFromQuery();
  const storageApiBase = runtimeApiBaseFromStorage();
  const candidates = [];

  if (queryApiBase) candidates.push(queryApiBase);
  if (configuredApiBase) candidates.push(configuredApiBase);
  if (storageApiBase && storageApiBase !== queryApiBase && storageApiBase !== configuredApiBase) {
    candidates.push(storageApiBase);
  }

  if (isLocalHostname()) {
    candidates.push(LOCAL_API_BASE);
    candidates.push(...LOCAL_DEV_API_BASES);
  } else if (!configuredApiBase) {
    candidates.push('/api');
  }

  return [...new Set(candidates.filter(Boolean))];
}

function parseCoordinate(value, label) {
  const parsed = Number.parseFloat(String(value ?? '').replace(',', '.'));
  if (!Number.isFinite(parsed)) {
    throw new CatastroxApiError(`La coordenada ${label} debe ser numérica.`, {
      code: 'INVALID_COORDINATE',
      status: 400,
    });
  }
  return parsed;
}

function geometryToFeature(geometry) {
  if (!geometry) return null;
  if (geometry.type === 'Feature') return geometry;
  return {
    type: 'Feature',
    properties: {},
    geometry,
  };
}

function firstRingFromGeometry(geometry) {
  const feature = geometryToFeature(geometry);
  const type = feature?.geometry?.type;
  const coordinates = feature?.geometry?.coordinates;

  if (type === 'Polygon') return coordinates?.[0] || [];
  if (type === 'MultiPolygon') return coordinates?.[0]?.[0] || [];
  return [];
}

function buildVerticesFromGeometry(geometry) {
  const ring = firstRingFromGeometry(geometry);
  return ring
    .slice(0, Math.max(ring.length - 1, 0))
    .slice(0, 8)
    .map(([lng, lat], index) => [
      `V${index + 1}`,
      Number(lat).toFixed(6),
      Number(lng).toFixed(6),
    ]);
}

function cleanText(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function normalizeQueryPoint(queryPoint, fallback) {
  const lat = Number.parseFloat(queryPoint?.lat ?? fallback?.lat);
  const lng = Number.parseFloat(queryPoint?.lng ?? fallback?.lng);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return fallback || null;
  }

  return { lat, lng };
}

function buildRealPredio(predio = {}, coords, queryPoint, apiBase, payload = {}) {
  const routeId =
    predio.routeId ||
    predio.lookup_id ||
    payload.routeId ||
    payload.lookup_id ||
    `lookup-${Date.now()}`;
  const resolvedQueryPoint = normalizeQueryPoint(queryPoint, coords);
  const previewPath = `/catastrox/lookups/${encodeURIComponent(routeId)}/preview-map`;
  const previewGeometryPath = `/catastrox/lookups/${encodeURIComponent(routeId)}/preview-geometry`;

  return {
    id: String(routeId),
    routeId,
    source: 'api',
    estado: CATASTROX_STATUS.IDENTIFICADO,
    estadoLabel: 'Predio identificado',
    municipio: cleanText(predio.municipio) || cleanText(payload.municipio) || null,
    departamento: cleanText(predio.departamento) || cleanText(payload.departamento) || null,
    gestor: cleanText(predio.gestor) || cleanText(payload.gestor) || null,
    estadoPredial:
      predio.estadoPredial ||
      'Predio identificado. Información detallada disponible únicamente al activar un paquete.',
    previewMapUrl: buildApiResourceUrl(apiBase, predio.previewMapUrl || payload.previewMapUrl, previewPath),
    previewGeometryUrl: buildApiResourceUrl(
      apiBase,
      predio.previewGeometryUrl || payload.previewGeometryUrl,
      previewGeometryPath,
    ),
    previewMessage:
      predio.previewMessage ||
      payload.previewMessage ||
      'Predio identificado sobre imagen satelital.',
    verificacionPoligono: 'Vista previa comercial del predio identificado.',
    recomendaciones: [
      'Verifique la información con la autoridad catastral competente antes de un acto jurídico.',
      'Active el Diagnóstico Predial si necesita revisar código, área y perímetro con mayor detalle.',
      'Solicite acompañamiento técnico si requiere regularización o validación adicional.',
    ],
    referencePoint: resolvedQueryPoint || coords,
    queryPoint: resolvedQueryPoint,
    safePreviewUnavailable: true,
  };
}

export function isCatastroxAuditDownloadsAvailable() {
  return AUDIT_DOWNLOADS_ENABLED && isLocalHostname();
}

function buildAuditLookup(payload, routeId) {
  const predio = payload?.predio || {};
  const storedLookup = getLastLookup();
  const storedPredio = storedLookup?.predio || {};
  const codigoPredial = cleanText(
    predio.codigoPredial ||
      predio.codigo ||
      predio.codigo_predial ||
      storedPredio.codigoPredial ||
      storedPredio.codigo ||
      storedPredio.codigo_predial,
  );
  const codigoAnterior = cleanText(predio.codigoAnterior || predio.codigo_anterior || storedPredio.codigoAnterior);
  const geometry = predio.geometry || predio.polygonGeoJson?.geometry || predio.polygonGeoJson || null;

  return {
    found: true,
    status: payload?.status || 'AUDIT_FULL_RESULT',
    routeId,
    lookup_id: routeId,
    source: 'audit-local',
    audit: true,
    canPurchase: true,
    legalNotice: payload?.legalNotice || '',
    predio: {
      ...storedPredio,
      ...predio,
      id: String(predio.id || routeId),
      routeId,
      lookup_id: routeId,
      source: 'audit-local',
      codigoPredial: codigoPredial || predio.id || routeId,
      codigo: codigoPredial || predio.id || routeId,
      codigo_predial: codigoPredial || predio.id || routeId,
      codigoAnterior: codigoAnterior || 'No disponible',
      codigo_anterior: codigoAnterior || '',
      geometry,
      polygonGeoJson: predio.polygonGeoJson || geometry,
      estado: CATASTROX_STATUS.IDENTIFICADO,
      estadoLabel: 'Predio identificado',
      estadoPredial: predio.estadoPredial || 'Predio identificado en la base catastral consultada.',
      referencePoint: predio.referencePoint || storedPredio.referencePoint || storedLookup?.queryPoint || null,
      queryPoint: predio.queryPoint || storedPredio.queryPoint || storedLookup?.queryPoint || null,
      previewMapUrl: predio.previewMapUrl || storedPredio.previewMapUrl || '',
      previewGeometryUrl: predio.previewGeometryUrl || storedPredio.previewGeometryUrl || '',
      previewMessage: predio.previewMessage || storedPredio.previewMessage || 'Predio identificado sobre imagen satelital.',
    },
  };
}

function buildAdvancedPredioFields(payload) {
  if (!payload?.found) return {};

  const fields = {
    nombrePredio: cleanText(payload.nombre_predio),
    nombre_predio: cleanText(payload.nombre_predio),
    direccionReal: cleanText(payload.direccion_real),
    direccion_real: cleanText(payload.direccion_real),
    departamento: cleanText(payload.departamento_nombre),
    departamento_nombre: cleanText(payload.departamento_nombre),
    municipio: cleanText(payload.municipio_nombre),
    municipioDane: cleanText(payload.municipio_dane),
    municipio_nombre: cleanText(payload.municipio_nombre),
    zona: cleanText(payload.zona),
    tipoZona: cleanText(payload.zona),
    veredaNombre: cleanText(payload.vereda_nombre),
    vereda_nombre: cleanText(payload.vereda_nombre),
    veredaDisplay: payload.veredaDisplay || null,
    barrioNombre: cleanText(payload.barrio_nombre),
    barrio_nombre: cleanText(payload.barrio_nombre),
    sectorCodigo: cleanText(payload.sector_codigo),
    sector_codigo: cleanText(payload.sector_codigo),
    manzanaCodigo: cleanText(payload.manzana_codigo),
    manzana_codigo: cleanText(payload.manzana_codigo),
    destinoEconomicoNombre: cleanText(payload.destino_economico_nombre),
    destino_economico_nombre: cleanText(payload.destino_economico_nombre),
    uso1Nombre: cleanText(payload.uso_1_nombre),
    uso_1_nombre: cleanText(payload.uso_1_nombre),
    uso2Nombre: cleanText(payload.uso_2_nombre),
    uso_2_nombre: cleanText(payload.uso_2_nombre),
    uso3Nombre: cleanText(payload.uso_3_nombre),
    uso_3_nombre: cleanText(payload.uso_3_nombre),
    numeroConstrucciones: payload.numero_construcciones,
    numero_construcciones: payload.numero_construcciones,
    areaConstruidaM2: payload.area_construida_m2,
    area_construida_m2: payload.area_construida_m2,
    tiposConstruccionResumen: cleanText(payload.tipos_construccion_resumen),
    tipos_construccion_resumen: cleanText(payload.tipos_construccion_resumen),
    fuente: cleanText(payload.fuente),
    fechaProceso: cleanText(payload.fecha_proceso),
    fecha_proceso: cleanText(payload.fecha_proceso),
  };

  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== null && value !== undefined && value !== ''),
  );
}

export function mergeAuditFullResultWithAdvanced(fullResult, advancedPayload) {
  if (!advancedPayload?.found) return fullResult;

  const advancedFields = buildAdvancedPredioFields(advancedPayload);
  const fullPredio = fullResult?.predio || {};

  // Geometria: siempre viene de fullResult (audit/full-result). advanced/lookup nunca la trae.
  const geometry = fullPredio.geometry || fullPredio.polygonGeoJson?.geometry || fullPredio.polygonGeoJson || null;

  // Codigo predial: prioriza advanced (catastrox_clean), luego fullResult. Nunca routeId/lookup_id.
  const codigoPredial = cleanText(
    advancedPayload.codigo_predial || fullPredio.codigoPredial || fullPredio.codigo || fullPredio.codigo_predial,
  );
  const codigoAnterior = cleanText(
    advancedPayload.codigo_anterior || fullPredio.codigoAnterior || fullPredio.codigo_anterior,
  );

  return {
    ...fullResult,
    advanced: true,
    advancedLookup: {
      status: advancedPayload.status,
      codigo_predial: advancedPayload.codigo_predial,
      geometryAvailable: advancedPayload.geometryAvailable === true,
    },
    predio: {
      ...fullPredio,
      ...advancedFields,
      codigoPredial,
      codigo: codigoPredial,
      codigo_predial: codigoPredial,
      codigoAnterior: codigoAnterior || 'No disponible',
      codigo_anterior: codigoAnterior || '',
      // areaHa/areaM2/perimetroM solo salen de fullResult (audit/full-result), nunca de advanced.
      areaHa: Number(fullPredio.areaHa ?? 0),
      areaM2: Number(fullPredio.areaM2 ?? 0),
      perimetroM: Number(fullPredio.perimetroM ?? 0),
      geometry,
      polygonGeoJson: fullPredio.polygonGeoJson || geometry,
      source: 'audit-local-advanced',
      enrichedSource: 'catastrox_clean',
    },
  };
}

function buildCoverageSummary(payload, fallbackDepartment = 'Caquetá') {
  const coverage = payload?.coverage || null;
  const municipio = cleanText(payload?.municipio || coverage?.municipio);
  const departamento = cleanText(payload?.departamento || coverage?.departamento || fallbackDepartment);

  return {
    municipio: municipio || null,
    departamento: departamento || null,
    codigoMunicipio: cleanText(coverage?.codigoMunicipio) || null,
    gestorCatastral: cleanText(payload?.gestor || coverage?.gestorCatastral) || null,
    estadoCobertura: coverage?.estadoCobertura || CATASTROX_STATUS.PENDIENTE_VALIDACION,
  };
}

function buildNotFoundLookup(coords, payload) {
  const status = payload?.status || 'PENDIENTE_VALIDACION';
  const coverage = buildCoverageSummary(payload);
  const queryPoint = normalizeQueryPoint(payload?.queryPoint, coords);
  const statusToPredioState = {
    NO_PREDIO_INDIVIDUALIZADO: CATASTROX_STATUS.NO_PREDIO_INDIVIDUALIZADO,
    SIN_COBERTURA_CATASTRAL: CATASTROX_STATUS.SIN_COBERTURA_CATASTRAL,
    PENDIENTE_VALIDACION: CATASTROX_STATUS.PENDIENTE_VALIDACION,
  };
  const state = statusToPredioState[status] || CATASTROX_STATUS.PENDIENTE_VALIDACION;
  const stateLabelByState = {
    [CATASTROX_STATUS.NO_PREDIO_INDIVIDUALIZADO]: 'Predio sin individualización',
    [CATASTROX_STATUS.SIN_COBERTURA_CATASTRAL]: 'Cobertura pendiente de validación',
    [CATASTROX_STATUS.PENDIENTE_VALIDACION]: 'Cobertura pendiente de validación',
  };
  const recommendationsByState = {
    [CATASTROX_STATUS.NO_PREDIO_INDIVIDUALIZADO]: [
      'Verifique que la coordenada corresponda al punto real del predio.',
      'Solicite revisión técnica si el predio debería estar individualizado.',
      'Converse con un asesor para validar la ruta catastral más conveniente.',
    ],
    [CATASTROX_STATUS.SIN_COBERTURA_CATASTRAL]: [
      'Este municipio puede estar administrado por un gestor catastral diferente al incluido actualmente en la plataforma.',
      'Solicite verificación con un asesor para revisar la cobertura disponible.',
      'Mantenga la ubicación consultada para acelerar la validación técnica.',
    ],
    [CATASTROX_STATUS.PENDIENTE_VALIDACION]: [
      'La cobertura municipal debe validarse antes de clasificar el caso.',
      'Solicite apoyo de un asesor para confirmar la autoridad catastral competente.',
      'Conserve la ubicación consultada para continuar la revisión.',
    ],
  };

  return {
    found: false,
    status,
    routeId: 'no-found',
    message:
      payload?.message ||
      'No fue posible clasificar la cobertura catastral de esta coordenada con la información disponible.',
    municipio: coverage.municipio,
    departamento: coverage.departamento,
    gestor: coverage.gestorCatastral,
    queryPoint,
    source: 'api',
    predio: {
      id: 'no-found',
      routeId: 'no-found',
      source: 'api',
      estado: state,
      estadoLabel: stateLabelByState[state],
      municipio: coverage.municipio || null,
      departamento: coverage.departamento || null,
      gestorCatastral: coverage.gestorCatastral,
      estadoCobertura: coverage.estadoCobertura,
      estadoPredial: payload?.message || 'Consulta sin individualización confirmada.',
      verificacionPoligono: payload?.message || 'Consulta sin individualización confirmada.',
      recomendaciones: recommendationsByState[state],
      referencePoint: queryPoint || coords,
      queryPoint,
      previewMessage: 'Vista previa cartográfica no disponible para esta consulta.',
      safePreviewUnavailable: true,
    },
  };
}

function buildMockLookup(coords) {
  const predio = lookupPredioMock(coords);
  return {
    found: true,
    routeId: predio.routeId || predio.id,
    source: 'mock',
    predio: {
      ...predio,
      routeId: predio.routeId || predio.id,
      source: 'mock',
    },
  };
}

function persistLookupResult(payload) {
  if (typeof window === 'undefined') return;
  window.sessionStorage?.setItem(CATASTROX_LOOKUP_STORAGE_KEY, JSON.stringify(payload));
}

export function saveLastLookup(payload) {
  persistLookupResult(payload);
}

export function getLastLookup() {
  if (typeof window === 'undefined') return null;

  const raw = window.sessionStorage?.getItem(CATASTROX_LOOKUP_STORAGE_KEY);
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function clearLastLookup() {
  if (typeof window === 'undefined') return;
  window.sessionStorage?.removeItem(CATASTROX_LOOKUP_STORAGE_KEY);
}

export function resolveLookupForRoute(routeId) {
  const stored = getLastLookup();
  if (stored) {
    const storedRouteId = stored.routeId || stored.predio?.routeId || stored.predio?.id;
    if (
      String(storedRouteId) === String(routeId) ||
      String(stored.predio?.id) === String(routeId)
    ) {
      return stored;
    }
  }

  if (String(routeId).startsWith('real-') || String(routeId) === 'no-found' || String(routeId) === 'sin-predio') {
    return null;
  }

  const mockPredio = getCatastroxResultById(routeId);
  return {
    found: true,
    routeId: mockPredio.routeId || mockPredio.id,
    source: 'mock',
    predio: {
      ...mockPredio,
      routeId: mockPredio.routeId || mockPredio.id,
      source: 'mock',
    },
  };
}

export async function lookupPredio({ lat, lng }) {
  const parsedLat = parseCoordinate(lat, 'lat');
  const parsedLng = parseCoordinate(lng, 'lng');
  const coords = { lat: parsedLat, lng: parsedLng };
  let lastError = null;

  for (const apiBase of getApiBaseCandidates()) {
    const url = `${apiBase}/catastrox/lookup`;
    let response;

    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lat: parsedLat, lng: parsedLng }),
      });
    } catch (error) {
      lastError = new CatastroxApiError('No fue posible conectar con el servicio catastral.', {
        code: 'API_UNAVAILABLE',
        url,
        payload: error,
      });
      continue;
    }

    const contentType = response.headers.get('content-type') || '';
    const payload = contentType.includes('application/json') ? await response.json() : null;

    if (response.status === 404) {
      if (isLookupNotFoundPayload(payload)) {
        const notFoundLookup = buildNotFoundLookup(coords, payload);
        persistLookupResult(notFoundLookup);
        return notFoundLookup;
      }

      lastError = new CatastroxApiError('El servicio catastral no respondió con un resultado válido.', {
        code: 'ENDPOINT_NOT_FOUND',
        status: response.status,
        url,
        payload,
      });
      continue;
    }

    if (!response.ok) {
      throw new CatastroxApiError(payload?.error || 'Error al consultar CatastroX.', {
        code: response.status >= 500 ? 'API_ERROR' : 'BAD_REQUEST',
        status: response.status,
        url,
        payload,
      });
    }

    if (!payload || typeof payload !== 'object') {
      lastError = new CatastroxApiError('El servicio catastral no respondió con un resultado válido.', {
        code: 'INVALID_LOOKUP_RESPONSE',
        status: response.status,
        url,
        payload,
      });
      continue;
    }

    const predioPayload = payload.predio || {};
    const normalized = {
      found: true,
      status: payload?.status || 'FOUND',
      queryPoint: normalizeQueryPoint(payload?.queryPoint, coords),
      municipio: cleanText(payload?.municipio) || cleanText(predioPayload?.municipio) || null,
      departamento: cleanText(payload?.departamento) || cleanText(predioPayload?.departamento) || null,
      gestor: cleanText(payload?.gestor) || cleanText(predioPayload?.gestor) || null,
      lookup_id: payload.lookup_id || predioPayload?.lookup_id || null,
      routeId: payload.routeId || payload.lookup_id || predioPayload?.routeId,
      source: 'api',
      canPurchase: payload?.canPurchase === true,
      commercialMessage: payload?.commercialMessage || payload?.message || '',
      legalNotice: payload?.legalNotice || '',
      coverage: payload?.coverage || null,
      predio: buildRealPredio(predioPayload, coords, payload?.queryPoint, apiBase, payload),
    };
    persistLookupResult(normalized);
    return normalized;
  }

  throw lastError || new CatastroxApiError('No fue posible conectar con el servicio catastral.', { code: 'API_UNAVAILABLE' });
}

export async function fetchCatastroxAuditFullResult(routeId) {
  if (!isCatastroxAuditDownloadsAvailable()) {
    throw new CatastroxApiError('El modo auditoría local no está habilitado.', {
      code: 'AUDIT_DOWNLOADS_DISABLED',
      status: 404,
    });
  }

  const lookupId = String(routeId || '').trim();
  if (!lookupId) {
    throw new CatastroxApiError('No hay identificador de consulta para auditoría.', {
      code: 'MISSING_LOOKUP_ID',
      status: 400,
    });
  }

  let lastError = null;

  for (const apiBase of getApiBaseCandidates()) {
    const url = `${apiBase}/catastrox/audit/lookups/${encodeURIComponent(lookupId)}/full-result`;
    let response;

    try {
      response = await fetch(url, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
      });
    } catch (error) {
      lastError = new CatastroxApiError('No fue posible conectar con el endpoint local de auditoría.', {
        code: 'AUDIT_API_UNAVAILABLE',
        url,
        payload: error,
      });
      continue;
    }

    const contentType = response.headers.get('content-type') || '';
    const payload = contentType.includes('application/json') ? await response.json() : null;

    if (!response.ok) {
      lastError = new CatastroxApiError(payload?.error || 'Auditoría local no disponible para esta consulta.', {
        code: payload?.status || 'AUDIT_API_ERROR',
        status: response.status,
        url,
        payload,
      });
      continue;
    }

    return buildAuditLookup(payload, lookupId);
  }

  throw lastError || new CatastroxApiError('No fue posible cargar datos completos de auditoría.', {
    code: 'AUDIT_API_UNAVAILABLE',
  });
}

export async function fetchCatastroxAdvancedLookup({ lat, lng, lookup_id, routeId }) {
  if (!isCatastroxAuditDownloadsAvailable()) {
    throw new CatastroxApiError('El modo auditoría local no está habilitado.', {
      code: 'ADVANCED_LOOKUP_DISABLED',
      status: 404,
    });
  }

  const parsedLat = parseCoordinate(lat, 'lat');
  const parsedLng = parseCoordinate(lng, 'lng');
  const originalLookupId = cleanText(lookup_id || routeId);
  let lastError = null;

  for (const apiBase of getApiBaseCandidates()) {
    const url = `${apiBase}/catastrox/advanced/lookup`;
    let response;

    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lat: parsedLat,
          lng: parsedLng,
          lookup_id: originalLookupId || undefined,
          routeId: originalLookupId || undefined,
        }),
      });
    } catch (error) {
      lastError = new CatastroxApiError('No fue posible conectar con el endpoint avanzado local.', {
        code: 'ADVANCED_API_UNAVAILABLE',
        url,
        payload: error,
      });
      continue;
    }

    const contentType = response.headers.get('content-type') || '';
    const payload = contentType.includes('application/json') ? await response.json() : null;

    if (!response.ok) {
      lastError = new CatastroxApiError(payload?.error || 'Motor avanzado no disponible para esta consulta.', {
        code: payload?.status || 'ADVANCED_API_ERROR',
        status: response.status,
        url,
        payload,
      });
      continue;
    }

    return payload;
  }

  throw lastError || new CatastroxApiError('No fue posible cargar datos del motor avanzado.', {
    code: 'ADVANCED_API_UNAVAILABLE',
  });
}

export async function lookupPredioWithFallback({ lat, lng }) {
  try {
    return await lookupPredio({ lat, lng });
  } catch (error) {
    if (error.code === 'API_UNAVAILABLE' || error.code === 'ENDPOINT_NOT_FOUND') {
      const fallback = buildMockLookup({
        lat: Number.parseFloat(lat),
        lng: Number.parseFloat(lng),
      });
      persistLookupResult(fallback);
      return fallback;
    }

    throw error;
  }
}
