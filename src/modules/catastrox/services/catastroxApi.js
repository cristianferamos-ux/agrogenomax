import { CATASTROX_STATUS } from '../data/catastroxMockData.js';
// LOTE-003 (ADR-014 §13/§21): resolución de URL de API y de hostname
// local centralizadas en src/config/runtimeConfig.js -- fuera de
// development local, la base de API resuelve exclusivamente al relay
// same-origin (/api) en staging/producción, nunca a VITE_API_URL/
// VITE_AGX_API_URL configuradas en build (evita que una URL externa,
// p. ej. Railway, quede como backend efectivo de un despliegue). En
// demo (ADR-014 §7) no existe ninguna base válida: resolveApiBaseUrl()
// lanza ApiDisabledError -- por eso se resuelve de forma perezosa (solo
// al construir una URL real, nunca al cargar este módulo) para que el
// import no rompa el renderizado de la demo.
import { isLocalHostname, normalizeApiBase, resolveApiBaseCandidates, resolveApiBaseUrl } from '../../../config/runtimeConfig.js';

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

function buildApiUrl(apiBase, path) {
  const normalizedBase = normalizeApiBase(apiBase || resolveApiBaseUrl());
  return `${normalizedBase}${path}`;
}

function buildApiResourceUrl(apiBase, resourcePath, fallbackPath) {
  const resource = cleanText(resourcePath) || fallbackPath;
  if (/^https?:\/\//i.test(resource)) return resource;

  const normalizedBase = normalizeApiBase(apiBase || resolveApiBaseUrl());
  if (resource.startsWith('/api/')) {
    if (normalizedBase === '/api') return resource;
    return `${normalizedBase.replace(/\/api$/, '')}${resource}`;
  }

  if (resource.startsWith('/')) return `${normalizedBase}${resource}`;
  return `${normalizedBase}/${resource}`;
}

function getApiBaseCandidates() {
  return resolveApiBaseCandidates();
}

function logLookupFailure(error, responseBody = null) {
  if (!import.meta.env.DEV) return;
  console.error('[CatastroX lookup failure]', {
    endpoint: error?.url || null,
    status: error?.status || 0,
    code: error?.code || 'UNKNOWN',
    message: error?.message || 'Error sin mensaje',
    responseBody,
    error: error?.payload || null,
  });
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

export function resolveLookupId(payload = {}) {
  return cleanText(
    payload?.lookupId ||
      payload?.lookup_id ||
      payload?.routeId ||
      payload?.predio?.lookupId ||
      payload?.predio?.lookup_id ||
      payload?.predio?.routeId,
  ) || null;
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
  const routeId = resolveLookupId({ ...payload, predio }) || `lookup-${Date.now()}`;
  const resolvedQueryPoint = normalizeQueryPoint(queryPoint, coords);
  const previewPath = `/catastrox/lookups/${encodeURIComponent(routeId)}/preview-map`;
  const previewGeometryPath = `/catastrox/lookups/${encodeURIComponent(routeId)}/preview-geometry`;

  return {
    id: String(routeId),
    routeId,
    source: 'api',
    // Defecto bloqueante corregido (revisión de seguridad): esta función
    // mapeaba la respuesta del backend a una lista blanca de campos que
    // nunca incluía canonicalPredioId -- el backend SÍ lo devuelve (las
    // tres vías de búsqueda: código, coordenadas y "mi ubicación actual",
    // ver server/routes/catastrox.js) pero se perdía aquí antes de llegar
    // a CatastroXPackagePage. Sin canonicalPredioId, y con codigoPredial
    // legítimamente ausente (es un entregable pago, no se revela antes de
    // comprar), POST /checkout no tenía ninguna identidad de predio válida
    // que enviar y rechazaba con INVALID_CADASTRAL_CODE -- el usuario
    // nunca llegaba a ver Wompi.
    canonicalPredioId: cleanText(predio.canonicalPredioId) || cleanText(payload.canonicalPredioId) || null,
    // El backend ya decide si el predio requiere revisión especial (área
    // >= umbral, ver resolveLookupPointFiscalStatus en
    // server/routes/catastrox.js) y lo envía en payload.status -- antes
    // esta línea lo ignoraba y siempre forzaba "identificado", por lo que
    // un predio de gran extensión podía seguir el flujo normal de compra.
    estado: payload.status === 'REVISION_ESPECIAL' ? CATASTROX_STATUS.REVISION_ESPECIAL : CATASTROX_STATUS.IDENTIFICADO,
    estadoLabel: 'Predio identificado',
    municipio: cleanText(predio.municipio) || cleanText(payload.municipio) || null,
    departamento: cleanText(predio.departamento) || cleanText(payload.departamento) || null,
    zona: cleanText(predio.zona) || cleanText(predio.tipoZona) || cleanText(payload.zona) || cleanText(payload.tipoZona) || null,
    tipoZona: cleanText(predio.tipoZona) || cleanText(predio.zona) || cleanText(payload.tipoZona) || cleanText(payload.zona) || null,
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

function getLookupByCodePublicMessage(payload, status) {
  const code = cleanText(payload?.code).toUpperCase();
  if (code === 'INVALID_CADASTRAL_CODE' || status === 400) {
    return 'El número predial debe contener exactamente 20 o 30 dígitos.';
  }
  if (code === 'CADASTRAL_CODE_NOT_FOUND' || status === 404) {
    return 'No se encontró un predio asociado con este número predial.';
  }
  if (code === 'REQUIRES_TECHNICAL_VALIDATION' || status === 409) {
    return 'Este número predial está asociado con varios registros catastrales. Ubique el predio mediante coordenadas o solicite validación técnica.';
  }
  if (code === 'RATE_LIMITED_CADASTRAL_LOOKUP' || status === 429) {
    return 'La consulta por número predial no está disponible en este momento. Intenta nuevamente más tarde.';
  }
  return 'No fue posible completar la consulta por número predial.';
}

function buildSuccessfulLookupResult(payload, coords, apiBase) {
  const predioPayload = payload.predio || {};
  const lookupId = resolveLookupId(payload);

  return {
    found: true,
    status: payload?.status || 'FOUND',
    queryPoint: normalizeQueryPoint(payload?.queryPoint, coords),
    municipio: cleanText(payload?.municipio) || cleanText(predioPayload?.municipio) || null,
    departamento: cleanText(payload?.departamento) || cleanText(predioPayload?.departamento) || null,
    gestor: cleanText(payload?.gestor) || cleanText(predioPayload?.gestor) || null,
    lookup_id: lookupId,
    routeId: lookupId,
    source: 'api',
    canPurchase: payload?.canPurchase === true,
    commercialMessage: payload?.commercialMessage || payload?.message || '',
    legalNotice: payload?.legalNotice || '',
    coverage: payload?.coverage || null,
    predio: buildRealPredio(predioPayload, coords, payload?.queryPoint, apiBase, payload),
  };
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
  const projectedGeometry = predio.projectedGeometry || predio.projected_geometry || null;

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
      projectedGeometry,
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
  const projectedGeometry = fullPredio.projectedGeometry || fullPredio.projected_geometry || null;

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
      projectedGeometry,
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
    const storedSource = stored.source || stored.predio?.source;
    if (
      storedSource !== 'mock' &&
      (String(storedRouteId) === String(routeId) || String(stored.predio?.id) === String(routeId))
    ) {
      return stored;
    }
  }

  return null;
}

export async function lookupPredio({ lat, lng }) {
  const parsedLat = parseCoordinate(lat, 'lat');
  const parsedLng = parseCoordinate(lng, 'lng');
  const coords = { lat: parsedLat, lng: parsedLng };
  const apiBase = normalizeApiBase(resolveApiBaseUrl());
  const url = `${apiBase}/catastrox/lookup`;
  let response;

  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lat: parsedLat, lng: parsedLng }),
    });
  } catch (error) {
    const apiError = new CatastroxApiError('No fue posible conectar con el servicio catastral.', {
      code: 'API_UNAVAILABLE',
      url,
      payload: error,
    });
    logLookupFailure(apiError);
    throw apiError;
  }

  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json') ? await response.json() : null;

  if (response.status === 404) {
    if (isLookupNotFoundPayload(payload)) {
      const notFoundLookup = buildNotFoundLookup(coords, payload);
      persistLookupResult(notFoundLookup);
      return notFoundLookup;
    }

    const apiError = new CatastroxApiError('El servicio catastral no respondió con un resultado válido.', {
      code: 'ENDPOINT_NOT_FOUND',
      status: response.status,
      url,
      payload,
    });
    logLookupFailure(apiError, payload);
    throw apiError;
  }

  if (!response.ok) {
    const apiError = new CatastroxApiError(payload?.error || 'Error al consultar CatastroX.', {
      code: response.status >= 500 ? 'API_ERROR' : 'BAD_REQUEST',
      status: response.status,
      url,
      payload,
    });
    logLookupFailure(apiError, payload);
    throw apiError;
  }

  if (!payload || typeof payload !== 'object') {
    const apiError = new CatastroxApiError('El servicio catastral no respondió con un resultado válido.', {
      code: 'INVALID_LOOKUP_RESPONSE',
      status: response.status,
      url,
      payload,
    });
    logLookupFailure(apiError, payload);
    throw apiError;
  }

  const normalized = buildSuccessfulLookupResult(payload, coords, apiBase);
  persistLookupResult(normalized);
  return normalized;
}

export async function lookupPredioByCode({ codigo }) {
  const rawCode = String(codigo ?? '');
  const apiBase = normalizeApiBase(resolveApiBaseUrl());
  const url = `${apiBase}/catastrox/lookup-by-code`;
  let response;

  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ codigo: rawCode }),
    });
  } catch (error) {
    const apiError = new CatastroxApiError('No fue posible conectar con el servicio catastral.', {
      code: 'API_UNAVAILABLE',
      url,
      payload: error,
    });
    logLookupFailure(apiError);
    throw apiError;
  }

  const contentType = response.headers.get('content-type') || '';
  let payload = null;

  if (contentType.includes('application/json')) {
    try {
      payload = await response.json();
    } catch (error) {
      const apiError = new CatastroxApiError('El servicio catastral no respondió con un resultado válido.', {
        code: 'INVALID_LOOKUP_RESPONSE',
        status: response.status,
        url,
        payload: error,
      });
      logLookupFailure(apiError);
      throw apiError;
    }
  }

  if (!response.ok) {
    const message = getLookupByCodePublicMessage(payload, response.status);
    const apiError = new CatastroxApiError(message, {
      code: cleanText(payload?.code) || (response.status >= 500 ? 'API_ERROR' : 'BAD_REQUEST'),
      status: response.status,
      url,
      payload,
    });
    logLookupFailure(apiError, payload);
    throw apiError;
  }

  if (!payload || typeof payload !== 'object') {
    const apiError = new CatastroxApiError('El servicio catastral no respondió con un resultado válido.', {
      code: 'INVALID_LOOKUP_RESPONSE',
      status: response.status,
      url,
      payload,
    });
    logLookupFailure(apiError, payload);
    throw apiError;
  }

  const lookupId = resolveLookupId(payload);

  if (payload?.found !== true || !lookupId) {
    const apiError = new CatastroxApiError('El servicio catastral no respondió con un resultado válido.', {
      code: 'INVALID_LOOKUP_RESPONSE',
      status: response.status,
      url,
      payload,
    });
    logLookupFailure(apiError, payload);
    throw apiError;
  }

  const normalized = buildSuccessfulLookupResult(payload, null, apiBase);
  persistLookupResult(normalized);
  return normalized;
}

async function fetchCatastroxFullResultByPath(routeId, pathBuilder, unavailableMessage, disabledError = null) {
  if (disabledError) {
    throw disabledError;
  }
  const lookupId = String(routeId || '').trim();
  if (!lookupId) {
    throw new CatastroxApiError('No hay identificador de consulta para generar entregables.', {
      code: 'MISSING_LOOKUP_ID',
      status: 400,
    });
  }

  let lastError = null;

  for (const apiBase of getApiBaseCandidates()) {
    const url = `${apiBase}${pathBuilder(lookupId)}`;
    let response;

    try {
      response = await fetch(url, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
      });
    } catch (error) {
      lastError = new CatastroxApiError(unavailableMessage, {
        code: 'FULL_RESULT_API_UNAVAILABLE',
        url,
        payload: error,
      });
      continue;
    }

    const contentType = response.headers.get('content-type') || '';
    const payload = contentType.includes('application/json') ? await response.json() : null;

    if (!response.ok) {
      lastError = new CatastroxApiError(payload?.error || 'No fue posible cargar el detalle completo del predio para generar entregables.', {
        code: payload?.status || 'FULL_RESULT_API_ERROR',
        status: response.status,
        url,
        payload,
      });
      continue;
    }

    return buildAuditLookup(payload, lookupId);
  }

  throw lastError || new CatastroxApiError('No fue posible cargar el detalle completo del predio.', {
    code: 'FULL_RESULT_API_UNAVAILABLE',
  });
}

export async function fetchCatastroxLookupFullResult(routeId) {
  return fetchCatastroxFullResultByPath(
    routeId,
    (lookupId) => `/catastrox/lookups/${encodeURIComponent(lookupId)}/full-result`,
    'No fue posible conectar con el endpoint local de detalle del predio.',
  );
}

export async function fetchCatastroxAuditFullResult(routeId) {
  return fetchCatastroxFullResultByPath(
    routeId,
    (lookupId) => `/catastrox/audit/lookups/${encodeURIComponent(lookupId)}/full-result`,
    'No fue posible conectar con el endpoint local de auditoría.',
    !isCatastroxAuditDownloadsAvailable()
      ? new CatastroxApiError('El modo auditoría local no está habilitado.', {
          code: 'AUDIT_DOWNLOADS_DISABLED',
          status: 404,
        })
      : null,
  );
}

function resolveLookupCoordinates(...candidates) {
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (Array.isArray(candidate) && candidate.length >= 2) {
      const [lat, lng] = candidate;
      if (Number.isFinite(Number(lat)) && Number.isFinite(Number(lng))) {
        return { lat: Number(lat), lng: Number(lng) };
      }
    }
    if (typeof candidate === 'object') {
      const lat = Number(candidate.lat ?? candidate.latitude);
      const lng = Number(candidate.lng ?? candidate.lon ?? candidate.longitude);
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        return { lat, lng };
      }
    }
  }
  return null;
}

export async function hydrateLookupForDeliverables(lookup, { useAuditEndpoint = false } = {}) {
  const originalLookupId = cleanText(lookup?.routeId || lookup?.lookup_id || lookup?.predio?.routeId || lookup?.predio?.lookup_id || lookup?.predio?.id);
  if (!originalLookupId) {
    throw new CatastroxApiError('No hay identificador de consulta para preparar los entregables.', {
      code: 'MISSING_LOOKUP_ID',
      status: 400,
    });
  }

  let fullLookup;
  if (useAuditEndpoint) {
    fullLookup = await fetchCatastroxAuditFullResult(originalLookupId);
  } else {
    try {
      fullLookup = await fetchCatastroxLookupFullResult(originalLookupId);
    } catch (error) {
      if (!isCatastroxAuditDownloadsAvailable() || ![404, 502, 503].includes(Number(error?.status))) {
        throw error;
      }
      fullLookup = await fetchCatastroxAuditFullResult(originalLookupId);
    }
  }

  const coordinates = resolveLookupCoordinates(
    lookup?.predio?.queryPoint,
    lookup?.queryPoint,
    lookup?.predio?.referencePoint,
    fullLookup?.predio?.queryPoint,
    fullLookup?.queryPoint,
  );

  if (!coordinates || !isCatastroxAuditDownloadsAvailable()) {
    return fullLookup;
  }

  try {
    const advancedLookup = await fetchCatastroxAdvancedLookup({
      ...coordinates,
      lookup_id: originalLookupId,
    });
    return mergeAuditFullResultWithAdvanced(fullLookup, advancedLookup);
  } catch {
    return fullLookup;
  }
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
      throw new CatastroxApiError('No pudimos completar la consulta del predio en este momento. Intenta nuevamente.', {
        code: 'LOOKUP_UNAVAILABLE',
        status: error.status || 503,
        payload: error.payload,
      });
    }

    throw error;
  }
}
