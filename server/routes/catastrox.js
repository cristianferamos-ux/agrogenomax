import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import {
  CATASTROX_COVERAGE_STATUS,
  estimateMunicipalCoverageByPoint,
  getMunicipalCoverageByCode,
} from '../data/catastroxCoberturaMunicipal.js';
import { catastroxQuery as query } from '../catastroxDb.js';
import { createCatastroxResolverShadow } from '../services/catastrox/catastroxResolverShadow.js';
import { getRecoverySessionTokenFromCookieHeader } from '../security/recoveryCookie.js';
import * as recoverySessions from '../services/catastrox/recoverySessionRepository.js';
import { packageSatisfies } from '../services/catastrox/paymentOrderTransitions.js';

const router = Router();

const CATASTROX_LEGAL_NOTICE =
  'CatastroX realiza análisis técnico sobre información geográfica y catastral pública disponible. No reemplaza certificados oficiales del IGAC, gestor catastral, oficina de registro ni autoridad competente.';
const LOOKUP_PREVIEW_TTL_MS = 30 * 60 * 1000;
const LOOKUP_BY_CODE_RATE_WINDOW_MS = 10 * 60 * 1000;
const LOOKUP_BY_CODE_RATE_MAX_REQUESTS = 30;
const lookupPreviewStore = new Map();
const lookupByCodeRateStore = new Map();
const AUDIT_DOWNLOADS_ENABLED = String(process.env.CATASTROX_AUDIT_DOWNLOADS || '').toLowerCase() === 'true';
const ADVANCED_LOOKUP_ENABLED = String(process.env.CATASTROX_ADVANCED_LOOKUP_ENABLED || '').toLowerCase() === 'true';
// Modo sombra del resolver de duplicados: desactivado por defecto. Solo observa;
// nunca decide la respuesta de /lookup. Ver docs/catastrox/CATASTROX_RESOLVER_SHADOW_MODE_V1.md.
const RESOLVER_SHADOW_ENABLED = String(process.env.CATASTROX_RESOLVER_SHADOW_ENABLED || '').toLowerCase() === 'true';
const TECHNICAL_VEREDA_PATTERN = /^\d+[A-Z]{2}$/i;
const CATASTROX_ORIGEN_NACIONAL_PROJ =
  '+proj=tmerc +lat_0=4 +lon_0=-73 +k=0.9992 +x_0=5000000 +y_0=2000000 +ellps=GRS80 +units=m +no_defs +type=crs';

// Versión del dataset catastral servido -- no existe hoy un versionado real
// por fila/importación (el dump se recarga manualmente), así que esta es
// una aproximación deliberada: una etiqueta estática configurable,
// documentada como tal. Solo se usa para construir el identificador
// canónico de respaldo (predios sin código conocido) -- nunca participa en
// decisiones de negocio ni de pago por sí sola.
const CATASTROX_DATASET_VERSION = process.env.CATASTROX_DATASET_VERSION || '2026-01';

// Lookup sin dependencia dura de gis.*: gis.catastro_caqueta,
// gis.municipios_colombia y catastrox_clean.v_predios_enriquecidos son
// relaciones OPCIONALES en Railway (ver docs/catastrox/, ADR-006) -- pueden
// no existir todavía sin que eso sea un error real. 42P01 es el SQLSTATE de
// Postgres para "relación inexistente" (mismo código ya usado como
// convención en server/health/dbReadiness.js). Solo ese código específico
// se trata como "fuente opcional ausente"; cualquier otro (auth, conexión,
// timeout, columna inexistente, etc.) se re-lanza sin tocar y sigue
// produciendo 500 -- ver cada call site abajo para qué relación concreta
// cubre cada uso de queryOptional.
export function isUndefinedRelationError(error) {
  return Boolean(error) && error.code === '42P01';
}

async function queryOptional(queryImpl, sql, params) {
  try {
    return await queryImpl(sql, params);
  } catch (error) {
    if (isUndefinedRelationError(error)) return null;
    throw error;
  }
}

/**
 * Identidad canónica de un predio (Bloque 3/4/5): estable entre los tres
 * métodos de búsqueda (código, coordenadas manuales, "mi ubicación
 * actual" -- los dos últimos son la misma llamada a este archivo, ver
 * comentario en POST /lookup). Prioridad: el código predial normalizado
 * cuando existe (ya es una identidad nacional estable por construcción);
 * si no existe, un identificador de respaldo fuente+versión+id de fila --
 * nunca latitud/longitud/GPS, que jamás son identidad de pago.
 *
 * @param {{ codigoPredial?: string|null, source: 'legacy'|'clean', terrenoId: string|number }} input
 */
export function resolveCanonicalPredioId({ codigoPredial, source, terrenoId }) {
  const normalized = codigoPredial ? normalizeCadastralCodeInput(codigoPredial) : '';
  if (normalized) return normalized;
  return `${source}:v${CATASTROX_DATASET_VERSION}:${terrenoId}`;
}

/**
 * Bloque 4/5: decide si dos filas candidatas devueltas por una búsqueda por
 * punto (LIMIT 2, ver POST /lookup) representan un empate real -- misma
 * prioridad de coincidencia (ambas ST_Covers, o ambas solo ST_Intersects;
 * nunca se compara covers contra intersects, eso ya lo desempata
 * correctamente el ORDER BY de la consulta) y códigos prediales distintos.
 * Pura -- sin SQL, testeable sin base de datos.
 *
 * @param {{ priority_tier: number, codigo_predial: string|null }} first
 * @param {{ priority_tier: number, codigo_predial: string|null }|undefined|null} second
 */
export function isAmbiguousPointMatch(first, second) {
  if (!first || !second) return false;
  return second.priority_tier === first.priority_tier && second.codigo_predial !== first.codigo_predial;
}

export function buildLookupId() {
  return `cx-${randomUUID()}`;
}

function rememberLookupPreview(lookupId, predioId, extras = null) {
  const existing = lookupPreviewStore.get(lookupId);
  lookupPreviewStore.set(lookupId, {
    ...(existing || {}),
    predioId,
    ...(extras || {}),
    createdAt: Date.now(),
  });
}

function rememberAdvancedLookupPreview(lookupId, codigoPredial, extras = null) {
  const existing = lookupPreviewStore.get(lookupId);
  lookupPreviewStore.set(lookupId, {
    ...(existing || {}),
    source: 'clean',
    codigoPredial,
    ...(extras || {}),
    createdAt: Date.now(),
  });
}

export function resolveLookupPreview(lookupId) {
  const record = lookupPreviewStore.get(lookupId);
  if (!record) return null;
  if (Date.now() - record.createdAt > LOOKUP_PREVIEW_TTL_MS) {
    lookupPreviewStore.delete(lookupId);
    return null;
  }
  return record;
}

export function __getLookupPreviewForTests(lookupId) {
  return lookupPreviewStore.get(lookupId) || null;
}

export function __clearLookupStateForTests() {
  lookupPreviewStore.clear();
  lookupByCodeRateStore.clear();
}

// Exclusivamente para pruebas de integración (p. ej.
// server/routes/__tests__/catastroxPaymentOrders.test.js): registra un
// preview de lookup sintético sin pasar por una consulta PostGIS real --
// necesario porque, tras la corrección de seguridad que elimina el
// fallback inseguro de checkout, POST /checkout exige un routeId que
// resuelva a un preview real (con canonicalPredioId) y esas pruebas usan
// códigos prediales sintéticos que no existen en la base geográfica.
export function __rememberLookupPreviewForTests(lookupId, record = {}) {
  lookupPreviewStore.set(lookupId, { createdAt: Date.now(), ...record });
}

export function __getLookupByCodeRateStoreSizeForTests() {
  return lookupByCodeRateStore.size;
}

function isLocalAuditRequest(req) {
  const host = String(req.hostname || req.headers.host || '').split(':')[0];
  const forwardedHost = String(req.headers['x-forwarded-host'] || '').split(':')[0];
  const candidates = [host, forwardedHost].filter(Boolean);
  return candidates.some((value) => ['localhost', '127.0.0.1', '::1'].includes(value));
}

// Direcciones de loopback aceptadas para los endpoints locales del modo sombra
// del resolver. A diferencia de isLocalAuditRequest (que confia en el header
// Host), esta guarda compara exclusivamente contra la conexion TCP real
// (req.socket.remoteAddress) — nunca contra Host, X-Forwarded-*, Origin,
// Referer ni req.hostname, que son valores que el cliente controla libremente.
// No modifica la politica global de "trust proxy" de Express: lee el socket
// subyacente directamente, sin pasar por la capa de confianza de proxies.
const LOCAL_SOCKET_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function isLocalSocketRequest(req) {
  const remoteAddress = req?.socket?.remoteAddress || req?.connection?.remoteAddress || '';
  return LOCAL_SOCKET_ADDRESSES.has(remoteAddress);
}

function buildLookupByCodeRateKey(req) {
  return req?.ip || req?.socket?.remoteAddress || req?.connection?.remoteAddress || 'unknown';
}

export function purgeExpiredLookupByCodeRateEntries(now = Date.now()) {
  for (const [key, value] of lookupByCodeRateStore.entries()) {
    if (!value || now - value.windowStart >= LOOKUP_BY_CODE_RATE_WINDOW_MS) {
      lookupByCodeRateStore.delete(key);
    }
  }
}

export function enforceLookupByCodeRateLimit(req, now = Date.now()) {
  purgeExpiredLookupByCodeRateEntries(now);
  const key = buildLookupByCodeRateKey(req);
  const existing = lookupByCodeRateStore.get(key);

  if (!existing || now - existing.windowStart >= LOOKUP_BY_CODE_RATE_WINDOW_MS) {
    lookupByCodeRateStore.set(key, { windowStart: now, count: 1 });
    return;
  }

  if (existing.count >= LOOKUP_BY_CODE_RATE_MAX_REQUESTS) {
    throw Object.assign(
      new Error('La consulta por número predial no está disponible en este momento. Intenta nuevamente más tarde.'),
      { status: 429, publicCode: 'RATE_LIMITED_CADASTRAL_LOOKUP' },
    );
  }

  existing.count += 1;
}

function normalizeRingForSvg(geometry) {
  const geo = typeof geometry === 'string' ? JSON.parse(geometry) : geometry;
  const coordinates = geo?.type === 'Polygon'
    ? geo.coordinates?.[0]
    : geo?.type === 'MultiPolygon'
      ? geo.coordinates?.[0]?.[0]
      : [];
  const ring = (coordinates || [])
    .map(([lng, lat]) => [Number(lng), Number(lat)])
    .filter(([lng, lat]) => Number.isFinite(lng) && Number.isFinite(lat));

  if (ring.length < 3) return '';

  const bounds = ring.reduce(
    (acc, [lng, lat]) => ({
      minLng: Math.min(acc.minLng, lng),
      maxLng: Math.max(acc.maxLng, lng),
      minLat: Math.min(acc.minLat, lat),
      maxLat: Math.max(acc.maxLat, lat),
    }),
    { minLng: Infinity, maxLng: -Infinity, minLat: Infinity, maxLat: -Infinity },
  );
  const width = 760;
  const height = 420;
  const padding = 52;
  const spanLng = Math.max(bounds.maxLng - bounds.minLng, 0.000001);
  const spanLat = Math.max(bounds.maxLat - bounds.minLat, 0.000001);
  const scale = Math.min((width - padding * 2) / spanLng, (height - padding * 2) / spanLat);
  const projectedWidth = spanLng * scale;
  const projectedHeight = spanLat * scale;
  const offsetX = (width - projectedWidth) / 2;
  const offsetY = (height - projectedHeight) / 2;
  const maxPoints = 90;
  const step = Math.max(1, Math.floor(ring.length / maxPoints));
  const reduced = ring.filter((_, index) => index % step === 0);
  const closed = reduced.at(0)?.[0] === reduced.at(-1)?.[0] && reduced.at(0)?.[1] === reduced.at(-1)?.[1]
    ? reduced
    : [...reduced, reduced[0]];

  return closed
    .map(([lng, lat], index) => {
      const x = Math.round(offsetX + (lng - bounds.minLng) * scale);
      const y = Math.round(offsetY + (bounds.maxLat - lat) * scale);
      return `${index === 0 ? 'M' : 'L'}${x} ${y}`;
    })
    .join(' ')
    .concat(' Z');
}

function buildPreviewSvg(pathData) {
  const safePath = pathData || 'M170 112 L594 126 L632 292 L442 348 L156 292 Z';
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="760" height="420" viewBox="0 0 760 420" role="img" aria-label="Predio identificado">
  <defs>
    <linearGradient id="satellite" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#20331f"/>
      <stop offset="0.45" stop-color="#5a6137"/>
      <stop offset="1" stop-color="#162921"/>
    </linearGradient>
    <filter id="softGlow" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="7" result="blur"/>
      <feMerge>
        <feMergeNode in="blur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
    <pattern id="texture" width="48" height="48" patternUnits="userSpaceOnUse">
      <path d="M0 24 H48 M24 0 V48" stroke="rgba(255,255,255,0.05)" stroke-width="1"/>
      <circle cx="11" cy="14" r="6" fill="rgba(156,255,26,0.07)"/>
      <circle cx="35" cy="31" r="9" fill="rgba(0,216,255,0.04)"/>
    </pattern>
  </defs>
  <rect width="760" height="420" fill="url(#satellite)"/>
  <rect width="760" height="420" fill="url(#texture)"/>
  <path d="${safePath}" fill="rgba(156,255,26,0.24)" stroke="#d7ff3f" stroke-width="5" stroke-linejoin="round" filter="url(#softGlow)"/>
  <path d="${safePath}" fill="none" stroke="rgba(255,255,255,0.86)" stroke-width="1.5" stroke-dasharray="8 8" stroke-linejoin="round"/>
</svg>`;
}

function parseCoordinate(value, label) {
  if (value === undefined || value === null || value === '') {
    throw Object.assign(new Error(`La coordenada ${label} es obligatoria.`), { status: 400 });
  }

  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) {
    throw Object.assign(new Error(`La coordenada ${label} debe ser numérica.`), { status: 400 });
  }

  return parsed;
}

function toNullableString(value) {
  return value === null || value === undefined || value === '' ? null : String(value).trim();
}

function toNullableNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function hasValidRing(ring) {
  return Array.isArray(ring) && ring.length >= 4;
}

function isValidPredioGeometry(geometry) {
  const geo = typeof geometry === 'string' ? JSON.parse(geometry) : geometry;
  if (!geo || !geo.type || !Array.isArray(geo.coordinates)) return false;

  if (geo.type === 'Polygon') {
    return hasValidRing(geo.coordinates[0]);
  }

  if (geo.type === 'MultiPolygon') {
    return geo.coordinates.some((polygon) => hasValidRing(polygon?.[0]));
  }

  return false;
}

function getVeredaDisplay(veredaNombre) {
  const value = toNullableString(veredaNombre);

  if (!value) {
    return {
      label: 'Vereda',
      value: 'Información no disponible',
      isCadastralCode: false,
    };
  }

  if (TECHNICAL_VEREDA_PATTERN.test(value)) {
    return {
      label: 'Vereda',
      value: 'Información no disponible',
      secondaryLabel: 'Identificador catastral de vereda',
      secondaryValue: value,
      note: 'La fuente catastral pública consultada no registra un nombre común de vereda para este predio.',
      isCadastralCode: true,
    };
  }

  return {
    label: 'Vereda',
    value,
    isCadastralCode: false,
  };
}

function buildQueryPoint(lat, lng) {
  return {
    lat: Number(lat),
    lng: Number(lng),
  };
}

export function normalizeCadastralCodeInput(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim().replace(/[\s-]+/g, '');
}

export function validateCadastralCodeInput(value) {
  const normalized = normalizeCadastralCodeInput(value);

  if (!/^(?:\d{20}|\d{30})$/.test(normalized)) {
    throw Object.assign(new Error('El número predial debe contener exactamente 20 o 30 dígitos.'), {
      status: 400,
      publicCode: 'INVALID_CADASTRAL_CODE',
      publicMessage: 'El número predial debe contener exactamente 20 o 30 dígitos.',
    });
  }

  return normalized;
}

export function buildLookupByCodeQuery(normalizedCode) {
  const column = normalizedCode.length === 20 ? 'codigo_anterior' : 'codigo_predial';

  return {
    column,
    sql: `select
            p.codigo_predial,
            p.codigo_anterior,
            p.municipio_dane,
            p.municipio_nombre,
            p.departamento_nombre,
            p.zona,
        ST_Y(
          ST_Transform(
            ST_SetSRID(ST_PointOnSurface(p.geom), 0),
            '${CATASTROX_ORIGEN_NACIONAL_PROJ}',
            4326
          )
        ) as query_lat,
        ST_X(
          ST_Transform(
            ST_SetSRID(ST_PointOnSurface(p.geom), 0),
            '${CATASTROX_ORIGEN_NACIONAL_PROJ}',
            4326
          )
        ) as query_lng,
            round(ST_Area(p.geom)::numeric, 6) as area_m2_exact,
            round(ST_Perimeter(p.geom)::numeric, 6) as perimetro_m_exact,
            ST_NumGeometries(ST_Multi(p.geom)) as part_count,
            ST_AsText(ST_Envelope(p.geom)) as bbox_wkt,
            md5(encode(ST_AsEWKB(ST_Force2D(p.geom)), 'hex')) as geometry_fingerprint
          from catastrox_clean.predios p
          where ${column} = $1`,
    params: [normalizedCode],
  };
}

function canonicalText(value) {
  return toNullableString(value) || '';
}

function buildCandidateGeometrySignature(row) {
  return [
    canonicalText(row.codigo_predial),
    canonicalText(row.municipio_dane),
    canonicalText(row.municipio_nombre),
    canonicalText(row.departamento_nombre),
    canonicalText(row.zona),
    canonicalText(row.geometry_fingerprint),
  ].join('|');
}

function isCanonicalPredialCode(value) {
  return /^[0-9]{30}$/.test(canonicalText(value));
}

export function resolveExactFullResultByCodeRows(rows, normalizedCode) {
  const resolution = resolveLookupByCodeCandidates(rows, normalizedCode);
  if (resolution.outcome !== 'resolved') {
    return resolution;
  }

  const signature = buildCandidateGeometrySignature(rows[0]);
  const selectedRow = rows.find((row) => buildCandidateGeometrySignature(row) === signature) || rows[0];

  return {
    ...resolution,
    row: selectedRow,
  };
}

export function resolveLookupByCodeCandidates(rows, normalizedCode) {
  const candidates = Array.isArray(rows) ? rows : [];

  if (!candidates.length) {
    return {
      outcome: 'not_found',
      normalizedCode,
      searchLength: normalizedCode.length,
    };
  }

  const canonicalCodes = new Set(candidates.map((row) => canonicalText(row.codigo_predial)).filter(Boolean));
  if (canonicalCodes.size !== 1) {
    return {
      outcome: 'ambiguous',
      reason: 'MULTIPLE_CANONICAL_CODES',
      normalizedCode,
      searchLength: normalizedCode.length,
    };
  }

  const municipalities = new Set(candidates.map((row) => canonicalText(row.municipio_nombre)));
  const departments = new Set(candidates.map((row) => canonicalText(row.departamento_nombre)));
  const zones = new Set(candidates.map((row) => canonicalText(row.zona)));
  const geometrySignatures = new Set(candidates.map(buildCandidateGeometrySignature));

  if (municipalities.size > 1 || departments.size > 1 || zones.size > 1 || geometrySignatures.size > 1) {
    return {
      outcome: 'ambiguous',
      reason: 'CONFLICTING_TERRITORIAL_OR_GEOMETRY_DATA',
      normalizedCode,
      searchLength: normalizedCode.length,
    };
  }

  const baseRow = candidates[0];
  return {
    outcome: 'resolved',
    normalizedCode,
    searchLength: normalizedCode.length,
    canonicalCode: canonicalText(baseRow.codigo_predial),
    candidate: {
      codigoPredial: canonicalText(baseRow.codigo_predial),
      codigoAnterior: canonicalText(baseRow.codigo_anterior),
      municipioDane: canonicalText(baseRow.municipio_dane),
      municipio: canonicalText(baseRow.municipio_nombre),
      departamento: canonicalText(baseRow.departamento_nombre),
      zona: canonicalText(baseRow.zona),
      queryPoint: buildQueryPoint(baseRow.query_lat, baseRow.query_lng),
    },
  };
}

export async function findPredioByCadastralCode(normalizedCode, queryImpl = query) {
  const { sql, params, column } = buildLookupByCodeQuery(normalizedCode);
  const result = await queryImpl(sql, params);
  return {
    column,
    ...resolveLookupByCodeCandidates(result.rows, normalizedCode),
  };
}

function buildLookupByCodeMunicipio(candidate) {
  return {
    codigoMunicipio: canonicalText(candidate?.municipioDane),
    municipio: canonicalText(candidate?.municipio),
    departamento: canonicalText(candidate?.departamento),
    gestorCatastral: null,
  };
}

function buildLookupByCodeFoundResponse(lookupId, candidate) {
  const municipio = buildLookupByCodeMunicipio(candidate);
  const coverage = resolveCoverageStatus({
    municipio,
    lat: candidate.queryPoint.lat,
    lng: candidate.queryPoint.lng,
  });
  // Búsqueda por código: candidate.codigoPredial siempre existe (es
  // literalmente cómo se encontró el predio) -- resolveCanonicalPredioId
  // siempre toma la rama del código normalizado aquí, nunca el respaldo
  // fuente:versión:id.
  const canonicalPredioId = resolveCanonicalPredioId({
    codigoPredial: candidate.codigoPredial,
    source: 'code',
    terrenoId: null,
  });

  return {
    lookup_id: lookupId,
    routeId: lookupId,
    canonicalPredioId,
    found: true,
    status: 'FOUND',
    municipio: candidate.municipio || null,
    departamento: candidate.departamento || null,
    tipoZona: candidate.zona || null,
    gestor: null,
    canPurchase: true,
    commercialMessage:
      'Predio identificado. Para conocer área, perímetro, códigos prediales, plano y archivos descargables, seleccione un paquete.',
    legalNotice: CATASTROX_LEGAL_NOTICE,
    coverage: {
      municipio: coverage?.municipio || municipio?.municipio || null,
      departamento: coverage?.departamento || municipio?.departamento || null,
      gestorCatastral: coverage?.gestorCatastral || municipio?.gestorCatastral || null,
      estadoCobertura: coverage?.estadoCobertura || null,
    },
    predio: {
      lookup_id: lookupId,
      routeId: lookupId,
      canonicalPredioId,
      municipio: candidate.municipio || null,
      departamento: candidate.departamento || null,
      tipoZona: candidate.zona || null,
      gestor: null,
      estadoPredial:
        'Predio identificado. Información detallada disponible únicamente al activar un paquete.',
      previewMapUrl: `/api/catastrox/lookups/${encodeURIComponent(lookupId)}/preview-map`,
      previewGeometryUrl: `/api/catastrox/lookups/${encodeURIComponent(lookupId)}/preview-geometry`,
      previewMessage: 'Vista previa protegida del predio identificado.',
    },
  };
}

export function createLookupByCodeSuccessState(lookupId, normalizedCode, candidate) {
  // canonicalPredioId se guarda en el propio preview (no solo en la
  // respuesta JSON) -- es la fuente de verdad que usan resolveFullResultAccess()
  // y POST /checkout más abajo; nunca se vuelve a confiar en lo que el
  // cliente reenvíe. Cálculo puro (sin SQL), igual al de
  // buildLookupByCodeFoundResponse -- mismo resultado determinístico.
  const canonicalPredioId = resolveCanonicalPredioId({
    codigoPredial: candidate.codigoPredial,
    source: 'code',
    terrenoId: null,
  });

  rememberAdvancedLookupPreview(lookupId, candidate.codigoPredial, {
    canonicalPredioId,
    queryPoint: candidate.queryPoint,
    searchType: 'code',
    queriedCode: normalizedCode,
  });

  return buildLookupByCodeFoundResponse(lookupId, candidate);
}

function normalizeMunicipioRow(row) {
  if (!row) return null;

  return {
    codigoMunicipio: toNullableString(row.mpcodigo),
    municipio: toNullableString(row.mpnombre),
    departamento: toNullableString(row.depto),
    gestorCatastral: toNullableString(row.gestor),
  };
}

function resolveCoverageStatus({ municipio, lat, lng }) {
  const coverageByCode = getMunicipalCoverageByCode(municipio?.codigoMunicipio);
  return coverageByCode || estimateMunicipalCoverageByPoint(lat, lng);
}

function buildNotFoundResponse({ queryPoint, municipio, coverage }) {
  const estadoCobertura = coverage?.estadoCobertura || CATASTROX_COVERAGE_STATUS.PENDIENTE_VALIDACION;

  if (estadoCobertura === CATASTROX_COVERAGE_STATUS.CUBIERTO_IGAC) {
    return {
      statusCode: 404,
      body: {
        found: false,
        status: 'NO_PREDIO_INDIVIDUALIZADO',
        queryPoint,
        municipio: coverage?.municipio || municipio?.municipio,
        departamento: coverage?.departamento || municipio?.departamento,
        gestor: coverage?.gestorCatastral || municipio?.gestorCatastral,
        message:
          'La coordenada cae dentro de una zona con cobertura disponible, pero no devolvió un predio individualizado con la geometría cargada actualmente.',
        canPurchase: false,
        commercialMessage:
          'No se habilita compra automática hasta validar técnicamente la ubicación consultada.',
        legalNotice: CATASTROX_LEGAL_NOTICE,
        coverage: {
          municipio: coverage?.municipio || municipio?.municipio,
          departamento: coverage?.departamento || municipio?.departamento,
          gestorCatastral: coverage?.gestorCatastral || municipio?.gestorCatastral,
          estadoCobertura,
        },
      },
    };
  }

  if (estadoCobertura === CATASTROX_COVERAGE_STATUS.GESTOR_DIFERENTE) {
    return {
      statusCode: 404,
      body: {
        found: false,
        status: 'SIN_COBERTURA_CATASTRAL',
        queryPoint,
        municipio: coverage?.municipio || municipio?.municipio,
        departamento: coverage?.departamento || municipio?.departamento,
        gestor: coverage?.gestorCatastral || municipio?.gestorCatastral,
        message:
          'No se encontró información predial individualizada para esta ubicación en la cobertura catastral cargada actualmente.',
        canPurchase: false,
        commercialMessage:
          'Solicite acompañamiento para validar cobertura y disponibilidad antes de comprar un entregable.',
        legalNotice: CATASTROX_LEGAL_NOTICE,
        coverage: {
          municipio: coverage?.municipio || municipio?.municipio,
          departamento: coverage?.departamento || municipio?.departamento,
          gestorCatastral: coverage?.gestorCatastral || municipio?.gestorCatastral,
          estadoCobertura,
        },
      },
    };
  }

  return {
    statusCode: 404,
    body: {
      found: false,
      status: 'PENDIENTE_VALIDACION',
      queryPoint,
      municipio: coverage?.municipio || municipio?.municipio || null,
      departamento: coverage?.departamento || municipio?.departamento || null,
      gestor: coverage?.gestorCatastral || municipio?.gestorCatastral || null,
      message:
        'La cobertura municipal de esta coordenada debe validarse antes de clasificar el caso con la información geográfica cargada actualmente.',
      canPurchase: false,
      commercialMessage:
        'Solicite acompañamiento para validar la cobertura antes de comprar un entregable.',
      legalNotice: CATASTROX_LEGAL_NOTICE,
      coverage: {
        municipio: coverage?.municipio || municipio?.municipio || null,
        departamento: coverage?.departamento || municipio?.departamento || null,
        gestorCatastral: coverage?.gestorCatastral || municipio?.gestorCatastral || null,
        estadoCobertura,
      },
    },
  };
}

// gis.municipios_colombia es OPCIONAL (enriquecimiento de gestor/municipio,
// ver POST /lookup): si la relación no existe (42P01), se degrada a "sin
// municipio" en vez de 500 -- el llamador ya tolera un resultado null.
export async function findMunicipioByPoint(lng, lat, queryImpl = query) {
  const directMatch = await queryOptional(
    queryImpl,
    `with point as (
       select ST_SetSRID(ST_MakePoint($1, $2), 4326) as geom
     )
     select
       mpcodigo,
       mpnombre,
       depto,
       gestor
     from gis.municipios_colombia, point
     where ST_Covers(gis.municipios_colombia.geom, point.geom)
        or ST_Intersects(gis.municipios_colombia.geom, point.geom)
     limit 1`,
    [lng, lat],
  );

  if (directMatch === null) return null;

  if (directMatch.rows[0]) {
    return normalizeMunicipioRow(directMatch.rows[0]);
  }

  const nearestMatch = await queryOptional(
    queryImpl,
    `with point as (
       select ST_SetSRID(ST_MakePoint($1, $2), 4326) as geom
     )
     select
       mpcodigo,
       mpnombre,
       depto,
       gestor
     from gis.municipios_colombia, point
     order by gis.municipios_colombia.geom <-> point.geom
     limit 1`,
    [lng, lat],
  );

  return nearestMatch ? normalizeMunicipioRow(nearestMatch.rows[0]) : null;
}

// Devuelve hasta 2 filas (no 1): el llamador (POST /lookup) usa la segunda
// exclusivamente para detectar un empate real de prioridad (Bloque 4/5,
// mismo criterio que la consulta legacy en el mismo archivo) -- el
// desempate ST_Covers-antes-que-ST_Intersects/área/código para el caso no
// ambiguo no cambia.
//
// municipio_nombre/departamento_nombre se seleccionan aquí (Fuente 1)
// porque ya existen como columnas propias del dataset limpio -- evita
// depender de gis.municipios_colombia solo para esos dos campos (ver
// POST /lookup, que ahora los usa como fuente primaria).
function buildCleanCandidatesSql(fromRelation) {
  return `with punto as (
       select ST_SetSRID(
         ST_Transform(
           ST_SetSRID(ST_MakePoint($1, $2), 4326),
           $3
         ),
         9377
       ) as geom
     ),
     candidatos as (
       select
         p.codigo_predial,
         p.zona,
         p.municipio_nombre,
         p.departamento_nombre,
         p.fid,
         ST_Multi(
           ST_CollectionExtract(
             case
               when ST_IsValid(p.geom) then p.geom
               else ST_MakeValid(p.geom)
             end,
             3
           )
         ) as lookup_geom
       from ${fromRelation} p
     )
     select
       c.codigo_predial,
       c.zona,
       c.municipio_nombre,
       c.departamento_nombre,
       c.fid,
       case when ST_Covers(c.lookup_geom, p.geom) then 0 else 1 end as priority_tier
     from candidatos c, punto p
     where c.lookup_geom is not null
       and not ST_IsEmpty(c.lookup_geom)
       and (
         ST_Covers(c.lookup_geom, p.geom)
         or ST_Intersects(c.lookup_geom, p.geom)
       )
     order by
       case
         when ST_Covers(c.lookup_geom, p.geom) then 0
         else 1
       end,
       ST_Area(c.lookup_geom) asc,
       c.codigo_predial asc
     limit 2`;
}

// catastrox_clean.v_predios_enriquecidos (Fuente 2, principal) y
// catastrox_clean.predios (Fuente 3, fallback si la vista no existe) son
// las dos relaciones opcionales de esta función -- ambas con las mismas
// columnas, así que el fallback no pierde datos. Si ninguna existe (42P01
// en las dos), se devuelve [] -- el llamador ya trata "sin candidatos"
// como "seguir la cascada", nunca 500.
export async function findCleanPredioCandidatesByPoint(lng, lat, queryImpl = query) {
  let result = await queryOptional(
    queryImpl,
    buildCleanCandidatesSql('catastrox_clean.v_predios_enriquecidos'),
    [lng, lat, CATASTROX_ORIGEN_NACIONAL_PROJ],
  );

  if (result === null) {
    result = await queryOptional(
      queryImpl,
      buildCleanCandidatesSql('catastrox_clean.predios'),
      [lng, lat, CATASTROX_ORIGEN_NACIONAL_PROJ],
    );
  }

  if (result === null) return [];

  return result.rows;
}

// Candidatos tecnicos de solo lectura para el modo sombra del resolver: unica
// consulta que el motor de decision puede recibir para EXACT + NONE. Nunca se
// mezclan candidatos legacy con candidatos clean (source siempre 'clean' aqui).
async function cleanCandidateProvider(codigoPredial) {
  const result = await query(
    `select
       'clean' as source,
       fid::text as source_record_id
     from catastrox_clean.predios
     where codigo_predial = $1
     order by fid`,
    [codigoPredial],
  );

  return result.rows.map((row) => ({ source: row.source, sourceRecordId: row.source_record_id }));
}

// Limite operativo (a nivel de consulta SQL) de codigos clean distintos que se
// consideran para un solo punto: una salvaguarda de rendimiento/memoria ante
// datos anomalos, muy por encima de MAX_ALTERNATE_CANDIDATES (10) en
// catastroxResolverShadow.js, que aplica su propio limite de exhibicion sobre
// lo que esta funcion devuelva. Este limite nunca decide "cual" codigo
// conservar por relevancia — solo acota cuantas filas puede devolver la
// consulta como maximo.
const CROSS_SOURCE_PROBE_QUERY_LIMIT = 200;

// Sondeo de solo lectura (V1.1) usado exclusivamente para observabilidad de
// divergencia legacy/clean: cuando /lookup sirvio un codigo legacy que no
// esta en la matriz, verifica que codigo(s) de catastrox_clean.predios
// cubren el mismo punto. Nunca decide nada por si mismo — solo reporta lo que
// encuentra, con la forma limitada que exige catastroxResolverShadow.js
// (found, alternateSource, alternateCandidates POR CODIGO, totalCodeCount,
// totalRecordCount, queryResultTruncated, relationStatus). No se ejecuta
// ninguna consulta de escritura.
//
// Contrato por codigo, no por fila: cada codigo_predial distinto produce UNA
// entrada en alternateCandidates, con TODOS sus identificadores tecnicos
// (fid) agrupados en sourceRecordIds — nunca se elige un unico fid
// representativo (nunca MIN(fid), MAX(fid) ni ninguna otra seleccion
// arbitraria). Los identificadores solo sirven de trazabilidad tecnica;
// ninguno representa vigencia oficial.
//
// Conteos reales antes del limite: totalCodeCount y totalRecordCount se
// calculan con funciones de ventana (count(*) over(), sum(...) over()) sobre
// el conjunto YA agrupado por codigo_predial, evaluadas antes de que la
// clausula LIMIT recorte las filas devueltas — por eso reflejan el universo
// real, no solo lo que esta consulta decide devolver. queryResultTruncated
// es true cuando totalCodeCount supera la cantidad de codigos efectivamente
// devueltos (CROSS_SOURCE_PROBE_QUERY_LIMIT).
async function crossSourceCleanProbe({ lat, lng, currentCodigoPredial }) {
  const result = await query(
    `with punto as (
       select ST_SetSRID(
         ST_Transform(
           ST_SetSRID(ST_MakePoint($1, $2), 4326),
           $3
         ),
         9377
       ) as geom
     ),
     coincidencias as (
       select p.codigo_predial, p.fid
       from catastrox_clean.predios p, punto
       where ST_Covers(
         ST_Multi(
           ST_CollectionExtract(
             case
               when ST_IsValid(p.geom) then p.geom
               else ST_MakeValid(p.geom)
             end,
             3
           )
         ),
         punto.geom
       )
     ),
     agrupado as (
       -- Un renglon por codigo_predial distinto, con TODOS sus fid
       -- agrupados (nunca MIN/MAX): array_agg conserva cada identificador
       -- tecnico encontrado, ordenado para reproducibilidad.
       select
         codigo_predial,
         array_agg(fid order by fid) as fids,
         count(*) as record_count
       from coincidencias
       group by codigo_predial
     ),
     con_totales as (
       -- Funciones de ventana evaluadas sobre TODO el conjunto agrupado,
       -- antes de aplicar LIMIT abajo: total_code_count/total_record_count
       -- son el conteo real, no el conteo de lo que finalmente se devuelve.
       select
         codigo_predial,
         fids,
         record_count,
         count(*) over () as total_code_count,
         sum(record_count) over () as total_record_count
       from agrupado
     )
     select codigo_predial, fids, record_count, total_code_count, total_record_count
     from con_totales
     order by codigo_predial
     limit ${CROSS_SOURCE_PROBE_QUERY_LIMIT}`,
    [lng, lat, CATASTROX_ORIGEN_NACIONAL_PROJ],
  );

  const rows = result.rows;

  if (rows.length === 0) {
    return {
      found: false,
      alternateSource: null,
      alternateCandidates: [],
      totalCodeCount: 0,
      totalRecordCount: 0,
      queryResultTruncated: false,
      relationStatus: 'NO_CLEAN_MATCH',
    };
  }

  const totalCodeCount = Number(rows[0].total_code_count);
  const totalRecordCount = Number(rows[0].total_record_count);
  const returnedCodeCount = rows.length;
  const queryResultTruncated = totalCodeCount > returnedCodeCount;

  const alternateCandidates = rows.map((row) => ({
    codigoPredial: row.codigo_predial,
    sourceRecordIds: (row.fids || []).map(String),
  }));

  if (totalCodeCount > 1) {
    return {
      found: true,
      alternateSource: 'clean',
      alternateCandidates,
      totalCodeCount,
      totalRecordCount,
      queryResultTruncated,
      relationStatus: 'MULTIPLE_CLEAN_CODES',
    };
  }

  const [row] = rows;
  return {
    found: true,
    alternateSource: 'clean',
    alternateCandidates,
    totalCodeCount,
    totalRecordCount,
    queryResultTruncated,
    relationStatus: row.codigo_predial === currentCodigoPredial ? 'SAME_CODE' : 'DIFFERENT_CODE',
  };
}

// Instancia unica del servicio de modo sombra. Desactivado por defecto
// (RESOLVER_SHADOW_ENABLED=false). Nunca tiene autoridad sobre /lookup: solo
// observa y registra en un bufer en memoria (ver FASE 4/7 del modo sombra).
const resolverShadow = createCatastroxResolverShadow({
  enabled: RESOLVER_SHADOW_ENABLED,
  candidateProvider: cleanCandidateProvider,
  crossSourceProbe: crossSourceCleanProbe,
  maxEntries: 200,
});

// Dispara la evaluacion en modo sombra sin bloquear ni retrasar la respuesta ya
// enviada a /lookup. No usa await: setImmediate desacopla la ejecucion del ciclo
// de eventos actual, de modo que esta funcion siempre retorna de forma
// sincrona antes de que la evaluacion sombra corra. Cualquier rechazo de la
// promesa devuelta por evaluateLookupInShadow se captura aqui mismo (.catch),
// por lo que nunca se propaga como unhandledRejection ni llega a /lookup.
// Recibe la instancia de sombra como parametro (en vez de cerrar sobre la
// instancia del modulo) para que este disparador se pueda probar de forma
// aislada con una instancia simulada.
export function scheduleResolverShadowEvaluation(shadowInstance, input) {
  setImmediate(() => {
    shadowInstance.evaluateLookupInShadow(input).catch(() => {});
  });
}

router.post('/lookup', async (req, res, next) => {
  try {
    const lat = parseCoordinate(req.body?.lat, 'lat');
    const lng = parseCoordinate(req.body?.lng, 'lng');

    // Fuente 1 (legacy, opcional): esta consulta única referencia
    // gis.catastro_caqueta y gis.municipios_colombia -- si cualquiera de
    // las dos no existe (42P01), toda la sentencia falla igual (no se
    // puede distinguir cuál faltó dentro de una sola query), y eso se
    // trata como "fuente legacy no disponible": se sigue la cascada hacia
    // catastrox_clean, nunca 500. catastrox_clean.v_predios_enriquecidos
    // también participa aquí (left join) solo para 'zona'; si falta, cae
    // en el mismo caso -- la Fuente 2 más abajo la vuelve a intentar sola.
    const predioResult = await queryOptional(
      query,
      `with punto as (
         select ST_SetSRID(ST_MakePoint($1, $2), 4326) as geom
       ),
       catastro as (
         select
           c.id,
           c.codigo as codigo_predial,
           c.codigo_municipio,
           c.codigo_departamento,
           c.shape_area,
           ST_Multi(
             ST_CollectionExtract(
               case
                 when ST_IsValid(c.geom) then c.geom
                 else ST_MakeValid(c.geom)
               end,
               3
             )
           ) as lookup_geom
         from gis.catastro_caqueta c
       ),
        predio as (
          select
            c.id,
            c.codigo_predial,
            c.codigo_municipio,
            c.codigo_departamento,
            c.shape_area,
            clean.zona,
            -- Bloque 4/5: se piden hasta 2 filas (no 1) exclusivamente
            -- para poder detectar un empate real de prioridad más abajo
            -- en JS (ver ambigüedad de búsqueda por punto) -- el
            -- desempate ST_Covers-antes-que-ST_Intersects sigue siendo
            -- el mismo de siempre y no cambia para el caso no ambiguo.
            case when ST_Covers(c.lookup_geom, p.geom) then 0 else 1 end as priority_tier
          from catastro c
          cross join punto p
          left join catastrox_clean.v_predios_enriquecidos clean
            on clean.codigo_predial = c.codigo_predial
          where c.lookup_geom is not null
            and not ST_IsEmpty(c.lookup_geom)
            and (
             ST_Covers(c.lookup_geom, p.geom)
             or ST_Intersects(c.lookup_geom, p.geom)
           )
         order by
           case
             when ST_Covers(c.lookup_geom, p.geom) then 0
             else 1
           end,
           c.shape_area asc nulls last
         limit 2
       ),
       municipio as (
         select
           m.mpcodigo,
           m.mpnombre,
           m.depto,
           m.gestor
         from gis.municipios_colombia m, punto p
         where ST_Covers(m.geom, p.geom)
            or ST_Intersects(m.geom, p.geom)
         limit 1
       )
       select
         p.*,
         m.mpcodigo,
         m.mpnombre,
         m.depto,
         m.gestor
       from predio p
       left join municipio m on true`,
      [lng, lat],
    );

    if (predioResult && predioResult.rows[0]) {
      const [firstCandidate, secondCandidate] = predioResult.rows;

      // Bloque 4/5: dos filas con la MISMA prioridad (ambas ST_Covers, o
      // ambas solo ST_Intersects) y códigos prediales distintos son un
      // empate real -- polígonos superpuestos/duplicados en el punto
      // consultado. Nunca se elige una silenciosamente: mismo contrato
      // 409 que ya usa la búsqueda por código (resolveLookupByCodeCandidates
      // más abajo). No se recuerda preview -- ningún routeId se emite para
      // un resultado ambiguo, igual que en el flujo por código.
      if (isAmbiguousPointMatch(firstCandidate, secondCandidate)) {
        res.status(409).json({
          ok: false,
          code: 'REQUIRES_TECHNICAL_VALIDATION',
          message:
            'Este punto coincide con varios predios catastrales. Ubique el predio mediante su número predial o solicite validación técnica.',
          canPurchase: false,
        });
        return;
      }

      const row = firstCandidate;
      const municipio = normalizeMunicipioRow(row);
      const coverage = resolveCoverageStatus({ municipio, lat, lng });
      const lookupId = buildLookupId();
      const canonicalPredioId = resolveCanonicalPredioId({
        codigoPredial: row.codigo || row.codigo_predial || null,
        source: 'legacy',
        terrenoId: row.id,
      });
      rememberLookupPreview(lookupId, row.id, {
        canonicalPredioId,
        codigoPredial: row.codigo || row.codigo_predial || null,
        queryPoint: buildQueryPoint(lat, lng),
      });

      res.json({
        lookup_id: lookupId,
        routeId: lookupId,
        canonicalPredioId,
        found: true,
        status: 'FOUND',
        municipio: toNullableString(row.mpnombre),
        departamento: toNullableString(row.depto),
        tipoZona: toNullableString(row.zona),
        gestor: toNullableString(row.gestor),
        canPurchase: true,
        commercialMessage:
          'Predio identificado. Para conocer área, perímetro, códigos prediales, plano y archivos descargables, seleccione un paquete.',
        legalNotice: CATASTROX_LEGAL_NOTICE,
        coverage: {
          municipio: coverage?.municipio || municipio?.municipio,
          departamento: coverage?.departamento || municipio?.departamento,
          gestorCatastral: coverage?.gestorCatastral || municipio?.gestorCatastral,
          estadoCobertura: coverage?.estadoCobertura || null,
        },
        predio: {
          lookup_id: lookupId,
          routeId: lookupId,
          canonicalPredioId,
          municipio: toNullableString(row.mpnombre),
          departamento: toNullableString(row.depto),
          tipoZona: toNullableString(row.zona),
          gestor: toNullableString(row.gestor),
          estadoPredial:
            'Predio identificado. Información detallada disponible únicamente al activar un paquete.',
          previewMapUrl: `/api/catastrox/lookups/${encodeURIComponent(lookupId)}/preview-map`,
          previewGeometryUrl: `/api/catastrox/lookups/${encodeURIComponent(lookupId)}/preview-geometry`,
          previewMessage: 'Vista previa protegida del predio identificado.',
        },
      });

      // lat/lng se pasan unicamente para permitir el sondeo de divergencia de
      // fuente (crossSourceProbe) dentro de evaluateLookupInShadow; el modulo
      // de sombra las usa de forma efimera y nunca las incluye en la
      // telemetria persistida (ver catastroxResolverShadow.js).
      scheduleResolverShadowEvaluation(resolverShadow, {
        lookupId,
        codigoPredial: row.codigo_predial || null,
        currentSource: 'legacy',
        currentSourceRecordId: row.id != null ? String(row.id) : null,
        lat,
        lng,
      });
      return;
    }

    const cleanCandidates = await findCleanPredioCandidatesByPoint(lng, lat);
    const [firstCleanCandidate, secondCleanCandidate] = cleanCandidates;

    if (firstCleanCandidate) {
      if (isAmbiguousPointMatch(firstCleanCandidate, secondCleanCandidate)) {
        res.status(409).json({
          ok: false,
          code: 'REQUIRES_TECHNICAL_VALIDATION',
          message:
            'Este punto coincide con varios predios catastrales. Ubique el predio mediante su número predial o solicite validación técnica.',
          canPurchase: false,
        });
        return;
      }

      const cleanPredio = firstCleanCandidate;
      // Fuente 4 (opcional, solo enriquecimiento de gestor): gis.municipios_colombia
      // no tiene equivalente en catastrox_clean -- si no existe, findMunicipioByPoint
      // ya degrada a null (ver su propio comentario) y gestor queda null, nunca 500.
      const municipio = await findMunicipioByPoint(lng, lat);
      const coverage = municipio ? resolveCoverageStatus({ municipio, lat, lng }) : null;
      const lookupId = buildLookupId();
      const canonicalPredioId = resolveCanonicalPredioId({
        codigoPredial: cleanPredio.codigo_predial || null,
        source: 'clean',
        terrenoId: cleanPredio.fid,
      });
      rememberAdvancedLookupPreview(lookupId, cleanPredio.codigo_predial, {
        canonicalPredioId,
        queryPoint: buildQueryPoint(lat, lng),
      });

      // municipio_nombre/departamento_nombre de catastrox_clean son la fuente
      // primaria (Requisito 2) -- gis.municipios_colombia solo rellena si el
      // dato limpio viniera vacío. gestor no tiene fuente en catastrox_clean,
      // así que sigue dependiendo exclusivamente de gis (puede ser null).
      const municipioNombre = cleanPredio.municipio_nombre || municipio?.municipio || null;
      const departamentoNombre = cleanPredio.departamento_nombre || municipio?.departamento || null;

      res.json({
        lookup_id: lookupId,
        routeId: lookupId,
        canonicalPredioId,
        found: true,
        status: 'FOUND',
        municipio: toNullableString(municipioNombre),
        departamento: toNullableString(departamentoNombre),
        tipoZona: toNullableString(cleanPredio.zona),
        gestor: toNullableString(municipio?.gestorCatastral),
        canPurchase: true,
        commercialMessage:
          'Predio identificado. Para conocer área, perímetro, códigos prediales, plano y archivos descargables, seleccione un paquete.',
        legalNotice: CATASTROX_LEGAL_NOTICE,
        coverage: {
          municipio: coverage?.municipio || municipioNombre,
          departamento: coverage?.departamento || departamentoNombre,
          gestorCatastral: coverage?.gestorCatastral || municipio?.gestorCatastral || null,
          estadoCobertura: coverage?.estadoCobertura || null,
        },
        predio: {
          lookup_id: lookupId,
          routeId: lookupId,
          canonicalPredioId,
          municipio: toNullableString(municipioNombre),
          departamento: toNullableString(departamentoNombre),
          tipoZona: toNullableString(cleanPredio.zona),
          gestor: toNullableString(municipio?.gestorCatastral),
          estadoPredial:
            'Predio identificado. Información detallada disponible únicamente al activar un paquete.',
          previewMapUrl: `/api/catastrox/lookups/${encodeURIComponent(lookupId)}/preview-map`,
          previewGeometryUrl: `/api/catastrox/lookups/${encodeURIComponent(lookupId)}/preview-geometry`,
          previewMessage: 'Vista previa protegida del predio identificado.',
        },
      });

      scheduleResolverShadowEvaluation(resolverShadow, {
        lookupId,
        codigoPredial: cleanPredio.codigo_predial || null,
        currentSource: 'clean',
        currentSourceRecordId: cleanPredio.fid != null ? String(cleanPredio.fid) : null,
      });
      return;
    }

    const municipio = await findMunicipioByPoint(lng, lat);

    if (municipio) {
      const queryPoint = buildQueryPoint(lat, lng);
      const coverage = resolveCoverageStatus({ municipio, lat, lng });
      const response = buildNotFoundResponse({
        queryPoint,
        municipio,
        coverage,
      });

      res.status(response.statusCode).json(response.body);
      return;
    }

    res.status(404).json({
      found: false,
      status: 'PENDIENTE_VALIDACION',
      queryPoint: buildQueryPoint(lat, lng),
      municipio: null,
      departamento: null,
      message:
        'No fue posible identificar el municipio para esta ubicación con la información geográfica cargada actualmente.',
      canPurchase: false,
      commercialMessage:
        'Solicite acompañamiento para revisar la ubicación antes de comprar un entregable.',
      legalNotice: CATASTROX_LEGAL_NOTICE,
      coverage: {
        municipio: null,
        departamento: null,
        gestorCatastral: null,
        estadoCobertura: 'PENDIENTE_VALIDACION',
      },
    });
  } catch (error) {
    next(error);
  }
});

router.post('/lookup-by-code', async (req, res, next) => {
  try {
    enforceLookupByCodeRateLimit(req);

    const normalizedCode = validateCadastralCodeInput(req.body?.codigo);
    const result = await findPredioByCadastralCode(normalizedCode);

    if (result.outcome === 'not_found') {
      res.status(404).json({
        ok: false,
        code: 'CADASTRAL_CODE_NOT_FOUND',
        message: 'No se encontró un predio asociado con este número predial.',
        canPurchase: false,
      });
      return;
    }

    if (result.outcome !== 'resolved') {
      res.status(409).json({
        ok: false,
        code: 'REQUIRES_TECHNICAL_VALIDATION',
        message:
          'Este número predial está asociado con varios registros catastrales. Ubique el predio mediante coordenadas o solicite validación técnica.',
        canPurchase: false,
      });
      return;
    }

    const lookupId = buildLookupId();
    res.json(createLookupByCodeSuccessState(lookupId, normalizedCode, result.candidate));
  } catch (error) {
    if (error?.publicCode === 'INVALID_CADASTRAL_CODE') {
      res.status(400).json({
        ok: false,
        code: 'INVALID_CADASTRAL_CODE',
        message: 'El número predial debe contener exactamente 20 o 30 dígitos.',
      });
      return;
    }

    if (error?.publicCode === 'RATE_LIMITED_CADASTRAL_LOOKUP') {
      res.status(429).json({
        ok: false,
        code: 'RATE_LIMITED_CADASTRAL_LOOKUP',
        message: 'La consulta por número predial no está disponible en este momento. Intenta nuevamente más tarde.',
        canPurchase: false,
      });
      return;
    }

    next(error);
  }
});

router.get('/lookups/:lookupId/preview-map', async (req, res, next) => {
  try {
    const lookupId = String(req.params?.lookupId || '').trim();
    const preview = resolveLookupPreview(lookupId);

    if (!preview) {
      res.status(404).type('image/svg+xml').send(buildPreviewSvg(''));
      return;
    }

    const previewResult = preview.source === 'clean'
      ? await query(
          `with source as (
             select
               ST_Transform(
                 ST_Multi(
                   ST_CollectionExtract(
                     case
                       when ST_IsValid(p.geom) then p.geom
                       else ST_MakeValid(p.geom)
                     end,
                     3
                   )
                 ),
                 $2,
                 4326
               ) as geom
             from catastrox_clean.v_predios_enriquecidos p
             where p.codigo_predial = $1
             limit 1
           ),
           metrics as (
             select
               geom,
               ST_Area(geom::geography) as area_m2,
               ST_NPoints(geom) as point_count
             from source
             where geom is not null and not ST_IsEmpty(geom)
           )
           select
             ST_AsGeoJSON(
               case
                 when area_m2 <= 2500 or point_count <= 12 then ST_SnapToGrid(geom, 0.00001)
                 else ST_SimplifyPreserveTopology(ST_SnapToGrid(geom, 0.00003), 0.00003)
               end,
               5
             )::json as preview_geometry
           from metrics`,
          [preview.codigoPredial, CATASTROX_ORIGEN_NACIONAL_PROJ],
        )
      : await query(
          `with source as (
             select
               ST_Multi(
                 ST_CollectionExtract(
                   case
                     when ST_IsValid(c.geom) then c.geom
                     else ST_MakeValid(c.geom)
                   end,
                   3
                 )
               ) as geom
             from gis.catastro_caqueta c
             where c.id = $1
             limit 1
           ),
           metrics as (
             select
               geom,
               ST_Area(geom::geography) as area_m2,
               ST_NPoints(geom) as point_count
             from source
             where geom is not null and not ST_IsEmpty(geom)
           )
           select
             ST_AsGeoJSON(
               case
                 when area_m2 <= 2500 or point_count <= 12 then ST_SnapToGrid(geom, 0.00001)
                 else ST_SimplifyPreserveTopology(ST_SnapToGrid(geom, 0.00003), 0.00003)
               end,
               5
             )::json as preview_geometry
           from metrics`,
          [preview.predioId],
        );
    const pathData = normalizeRingForSvg(previewResult.rows[0]?.preview_geometry);
    res.setHeader('Cache-Control', 'no-store');
    res.type('image/svg+xml').send(buildPreviewSvg(pathData));
  } catch (error) {
    next(error);
  }
});

router.get('/lookups/:lookupId/preview-geometry', async (req, res, next) => {
  try {
    const lookupId = String(req.params?.lookupId || '').trim();
    const preview = resolveLookupPreview(lookupId);

    if (!preview) {
      res.status(404).json({
        found: false,
        status: 'NOT_FOUND',
      });
      return;
    }

    const previewResult = preview.source === 'clean'
      ? await query(
          `with source as (
             select
               ST_Transform(
                 ST_Multi(
                   ST_CollectionExtract(
                     case
                       when ST_IsValid(p.geom) then p.geom
                       else ST_MakeValid(p.geom)
                     end,
                     3
                   )
                 ),
                 $2,
                 4326
               ) as geom
             from catastrox_clean.v_predios_enriquecidos p
             where p.codigo_predial = $1
             limit 1
           ),
           metrics as (
             select
               geom,
               ST_Area(geom::geography) as area_m2,
               ST_NPoints(geom) as point_count
             from source
             where geom is not null and not ST_IsEmpty(geom)
           ),
           degraded as (
             select
               case
                 when area_m2 <= 2500 or point_count <= 12 then ST_SnapToGrid(geom, 0.00001)
                 else ST_SimplifyPreserveTopology(ST_SnapToGrid(geom, 0.00008), 0.00008)
               end as geom
             from metrics
           )
           select ST_AsGeoJSON(geom, 5)::json as preview_geometry
           from degraded`,
          [preview.codigoPredial, CATASTROX_ORIGEN_NACIONAL_PROJ],
        )
      : await query(
          `with source as (
             select
               ST_Multi(
                 ST_CollectionExtract(
                   case
                     when ST_IsValid(c.geom) then c.geom
                     else ST_MakeValid(c.geom)
                   end,
                   3
                 )
               ) as geom
             from gis.catastro_caqueta c
             where c.id = $1
             limit 1
           ),
           metrics as (
             select
               geom,
               ST_Area(geom::geography) as area_m2,
               ST_NPoints(geom) as point_count
             from source
             where geom is not null and not ST_IsEmpty(geom)
           ),
           degraded as (
             select
               case
                 when area_m2 <= 2500 or point_count <= 12 then ST_SnapToGrid(geom, 0.00001)
                 else ST_SimplifyPreserveTopology(ST_SnapToGrid(geom, 0.00008), 0.00008)
               end as geom
             from metrics
           )
           select ST_AsGeoJSON(geom, 5)::json as preview_geometry
           from degraded`,
          [preview.predioId],
        );

    const previewGeometry = previewResult.rows[0]?.preview_geometry || null;

    if (!previewGeometry) {
      res.status(404).json({
        found: false,
        status: 'PREVIEW_UNAVAILABLE',
      });
      return;
    }

    res.setHeader('Cache-Control', 'no-store');
    res.json({
      found: true,
      status: 'PREVIEW_AVAILABLE',
      preview: true,
      geometry: previewGeometry,
    });
  } catch (error) {
    next(error);
  }
});

export async function buildLookupFullResultPayload(lookupId) {
  const preview = resolveLookupPreview(lookupId);

  if (!preview) {
    return {
      errorStatus: 404,
      payload: {
        found: false,
        status: 'LOOKUP_NOT_FOUND',
      },
    };
  }

const CLEAN_FULL_RESULT_QUERY = `select
         p.codigo_predial,
         p.codigo_anterior,
         p.municipio_dane,
         p.departamento_nombre,
         p.municipio_nombre,
         p.zona,
         p.nombre_predio,
         p.direccion_real,
         p.vereda_nombre,
         p.barrio_nombre,
         p.sector_codigo,
         p.manzana_codigo,
         p.area_terreno_m2,
         p.area_terreno_ha,
         ST_Area(p.geom) as area_m2_exact,
         ST_Perimeter(p.geom) as perimetro_m,
         ST_NumGeometries(ST_Multi(p.geom)) as part_count,
         ST_AsText(ST_Envelope(p.geom)) as bbox_wkt,
         md5(encode(ST_AsEWKB(ST_Force2D(p.geom)), 'hex')) as geometry_fingerprint,
         ST_Y(
           ST_Transform(
             ST_SetSRID(ST_PointOnSurface(p.geom), 0),
             $2,
             4326
           )
         ) as query_lat,
         ST_X(
           ST_Transform(
             ST_SetSRID(ST_PointOnSurface(p.geom), 0),
             $2,
             4326
           )
         ) as query_lng,
         p.destino_economico_nombre,
         p.uso_1_nombre,
         p.uso_2_nombre,
         p.uso_3_nombre,
         p.numero_construcciones,
         p.area_construida_m2,
         p.tipos_construccion_resumen,
         p.fuente,
         p.fecha_proceso,
         ST_AsGeoJSON(
           ST_SetSRID(
             ST_Force2D(
               ST_Multi(
                 ST_CollectionExtract(
                   case
                     when ST_IsValid(p.geom) then p.geom
                     else ST_MakeValid(p.geom)
                   end,
                   3
                 )
               )
             ),
             0
           )
         )::json as projected_geometry,
         ST_AsGeoJSON(
           ST_Transform(
             ST_Multi(
               ST_CollectionExtract(
                 case
                   when ST_IsValid(p.geom) then p.geom
                   else ST_MakeValid(p.geom)
                 end,
                 3
               )
             ),
             $2,
             4326
           )
         )::json as geometry
       from catastrox_clean.v_predios_enriquecidos p
        where p.codigo_predial = $1
        `;

  const CLEAN_FULL_RESULT_BY_POINT_QUERY = `select
         p.codigo_predial,
         p.codigo_anterior,
         p.departamento_nombre,
         p.municipio_nombre,
         p.zona,
         p.nombre_predio,
         p.direccion_real,
         p.vereda_nombre,
         p.barrio_nombre,
         p.sector_codigo,
         p.manzana_codigo,
         p.area_terreno_m2,
         p.area_terreno_ha,
         ST_Area(p.geom) as area_m2_exact,
         ST_Perimeter(p.geom) as perimetro_m,
         p.destino_economico_nombre,
         p.uso_1_nombre,
         p.uso_2_nombre,
         p.uso_3_nombre,
         p.numero_construcciones,
         p.area_construida_m2,
         p.tipos_construccion_resumen,
         p.fuente,
         p.fecha_proceso,
         ST_AsGeoJSON(
           ST_SetSRID(
             ST_Force2D(
               ST_Multi(
                 ST_CollectionExtract(
                   case
                     when ST_IsValid(p.geom) then p.geom
                     else ST_MakeValid(p.geom)
                   end,
                   3
                 )
               )
             ),
             0
           )
         )::json as projected_geometry,
         ST_AsGeoJSON(
           ST_Transform(
             ST_Multi(
               ST_CollectionExtract(
                 case
                   when ST_IsValid(p.geom) then p.geom
                   else ST_MakeValid(p.geom)
                 end,
                 3
               )
             ),
             $3,
             4326
           )
         )::json as geometry
       from catastrox_clean.v_predios_enriquecidos p
       where ST_Covers(
         p.geom,
            ST_Transform(
              ST_SetSRID(ST_Point($1, $2), 4326),
              $3
            )
       )
       order by p.area_terreno_m2 asc nulls last
       limit 1`;

  const LEGACY_FULL_RESULT_QUERY = `select
         c.id,
         c.codigo,
         c.codigo_anterior,
         c.codigo_municipio,
         c.codigo_departamento,
         c.shape_area,
         c.shape_length,
         ST_AsGeoJSON(
            ST_Multi(
              ST_CollectionExtract(
               case
                 when ST_IsValid(c.geom) then c.geom
                 else ST_MakeValid(c.geom)
               end,
               3
             )
            )
          )::json as geometry,
         ST_Y(ST_PointOnSurface(c.geom)) as query_lat,
         ST_X(ST_PointOnSurface(c.geom)) as query_lng,
         m.mpnombre,
         m.depto,
         m.gestor
       from gis.catastro_caqueta c
       left join gis.municipios_colombia m
         on m.mpcodigo = c.codigo_municipio
       where c.id = $1
        limit 1`;

  let source = null;
  let row = null;

  if (preview.codigoPredial) {
    const cleanResult = await query(CLEAN_FULL_RESULT_QUERY, [preview.codigoPredial, CATASTROX_ORIGEN_NACIONAL_PROJ]);
    if (preview.searchType === 'code' && isCanonicalPredialCode(preview.codigoPredial)) {
      const exactResolution = resolveExactFullResultByCodeRows(cleanResult.rows, preview.codigoPredial);
      if (exactResolution.outcome === 'resolved' && exactResolution.row && isValidPredioGeometry(exactResolution.row.geometry)) {
        source = 'clean';
        row = exactResolution.row;
      } else if (exactResolution.outcome === 'ambiguous') {
        return {
          errorStatus: 409,
          payload: {
            found: false,
            status: 'REQUIRES_TECHNICAL_VALIDATION',
          },
        };
      }
    } else if (cleanResult.rows[0] && isValidPredioGeometry(cleanResult.rows[0].geometry)) {
      source = 'clean';
      row = cleanResult.rows[0];
    }
  }

  if (!row && preview.predioId) {
    const legacyResult = await query(LEGACY_FULL_RESULT_QUERY, [preview.predioId]);
    if (legacyResult.rows[0] && isValidPredioGeometry(legacyResult.rows[0].geometry)) {
      source = 'legacy';
      row = legacyResult.rows[0];
    }
  }

  if (
    source === 'legacy'
    && Number.isFinite(Number(preview?.queryPoint?.lng))
    && Number.isFinite(Number(preview?.queryPoint?.lat))
  ) {
    const cleanPointResult = await query(CLEAN_FULL_RESULT_BY_POINT_QUERY, [
      Number(preview.queryPoint.lng),
      Number(preview.queryPoint.lat),
      CATASTROX_ORIGEN_NACIONAL_PROJ,
    ]);
    if (cleanPointResult.rows[0] && isValidPredioGeometry(cleanPointResult.rows[0].geometry)) {
      source = 'clean';
      row = cleanPointResult.rows[0];
    }
  }

  if (
    source === 'legacy'
    && Number.isFinite(Number(row?.query_lng))
    && Number.isFinite(Number(row?.query_lat))
  ) {
    const cleanPointResult = await query(CLEAN_FULL_RESULT_BY_POINT_QUERY, [
      Number(row.query_lng),
      Number(row.query_lat),
      CATASTROX_ORIGEN_NACIONAL_PROJ,
    ]);
    if (cleanPointResult.rows[0] && isValidPredioGeometry(cleanPointResult.rows[0].geometry)) {
      source = 'clean';
      row = cleanPointResult.rows[0];
    }
  }

  if (!row) {
    return {
      errorStatus: 404,
      payload: {
        found: false,
        status: 'FULL_RESULT_UNAVAILABLE',
      },
    };
  }

  return {
    errorStatus: null,
    payload: {
      found: true,
      status: 'FULL_RESULT_READY',
      legalNotice: CATASTROX_LEGAL_NOTICE,
      predio: {
        id: source === 'clean' ? row.codigo_predial : row.id,
        routeId: lookupId,
        lookup_id: lookupId,
        source: source === 'clean' ? 'audit-local-clean' : 'audit-local',
        codigoPredial: toNullableString(source === 'clean' ? row.codigo_predial : (row.codigo || row.codigo_predial)),
        // Identidad canónica (Bloque 3/4/5): esta es la que checkout/
        // entitlements/check deben usar -- llega aquí sin importar si el
        // predio se resolvió originalmente por código, coordenadas o
        // ubicación actual, porque los tres convergen en esta misma
        // función de full-result.
        canonicalPredioId: resolveCanonicalPredioId({
          codigoPredial: source === 'clean' ? row.codigo_predial : (row.codigo || row.codigo_predial),
          source: source === 'clean' ? 'clean' : 'legacy',
          terrenoId: source === 'clean' ? row.codigo_predial : row.id,
        }),
        codigoAnterior: toNullableString(row.codigo_anterior) || 'No disponible',
        municipio: toNullableString(row.mpnombre || row.municipio_nombre),
        departamento: toNullableString(row.depto || row.departamento_nombre),
        gestor: toNullableString(row.gestor),
        nombrePredio: toNullableString(row.nombre_predio),
        direccionReal: toNullableString(row.direccion_real),
        veredaDisplay: getVeredaDisplay(row.vereda_nombre),
        barrioNombre: toNullableString(row.barrio_nombre),
        sectorCodigo: toNullableString(row.sector_codigo),
        manzanaCodigo: toNullableString(row.manzana_codigo),
        areaM2: Number(row.area_m2_exact || row.shape_area || row.area_terreno_m2 || 0),
        areaHa: Number(row.area_terreno_ha || (Number(row.area_m2_exact || row.shape_area || 0) / 10000)),
        perimetroM: Number(row.shape_length || row.perimetro_m || 0),
        estadoPredial: 'Predio identificado en la base catastral consultada.',
        tipoZona: toNullableString(row.zona) || 'Rural',
        destinoEconomicoNombre: toNullableString(row.destino_economico_nombre),
        uso1Nombre: toNullableString(row.uso_1_nombre),
        uso2Nombre: toNullableString(row.uso_2_nombre),
        uso3Nombre: toNullableString(row.uso_3_nombre),
        numeroConstrucciones: toNullableNumber(row.numero_construcciones),
        areaConstruidaM2: toNullableNumber(row.area_construida_m2),
        tiposConstruccionResumen: toNullableString(row.tipos_construccion_resumen),
        fuente: toNullableString(row.fuente),
        fechaProceso: toNullableString(row.fecha_proceso),
        projectedGeometry: source === 'clean' ? row.projected_geometry : null,
        geometry: row.geometry,
        polygonGeoJson: {
          type: 'Feature',
          properties: {},
          geometry: row.geometry,
        },
        },
    },
  };
}

const FULL_RESULT_REQUIRED_PACKAGE_ID = 'basico';

// CORRECCIÓN DE SEGURIDAD (vulnerabilidad confirmada en producción):
// GET /lookups/:lookupId/full-result devolvía área/perímetro/geometría
// exacta y todos los atributos del predio con solo tener un lookup_id
// vigente (obtenible gratis, sin pago, sin sesión, vía POST /lookup) --
// nunca verificaba una compra. Esta función es la ÚNICA fuente de verdad
// para decidir acceso: lookup_id -> canonicalPredioId (guardado en el
// propio preview al crear el lookup, NUNCA recibido del cliente en esta
// ruta -- no acepta canonicalPredioId/codigoPredial/routeId por query ni
// body) -> sesión de recuperación (cookie HttpOnly, RECOVERY_COOKIE_PATH
// ahora cubre /api/catastrox además de /api/catastrox/payments, ver
// server/security/recoveryCookie.js) -> orden APPROVED de esa sesión para
// ESE canonicalPredioId exacto. Firma con inyección de dependencias
// (mismo patrón que findMunicipioByPoint/findCleanPredioCandidatesByPoint
// en este archivo) para permitir pruebas unitarias sin base de datos real.
export async function resolveFullResultAccess({
  lookupId,
  cookieHeader,
  getPreview = resolveLookupPreview,
  getSessionToken = getRecoverySessionTokenFromCookieHeader,
  hashSessionToken = recoverySessions.hashSessionToken,
  findActiveSessionByTokenHash = recoverySessions.findActiveSessionByTokenHash,
  findApprovedOrderForSession = recoverySessions.findApprovedOrderForSession,
  findAnyApprovedOrderForSession = recoverySessions.findAnyApprovedOrderForSession,
}) {
  const preview = getPreview(lookupId);
  if (!preview || !preview.canonicalPredioId) {
    return { ok: false, status: 404, code: 'LOOKUP_NOT_FOUND' };
  }

  const sessionToken = getSessionToken(cookieHeader);
  if (!sessionToken) {
    return { ok: false, status: 401, code: 'SESSION_REQUIRED' };
  }

  const tokenHash = hashSessionToken(sessionToken);
  const session = await findActiveSessionByTokenHash(tokenHash);
  if (!session) {
    return { ok: false, status: 401, code: 'SESSION_REQUIRED' };
  }

  const order = await findApprovedOrderForSession({
    sessionId: session.id,
    canonicalPredioId: preview.canonicalPredioId,
  });

  if (!order || !packageSatisfies({ ownedPackageId: order.package_id, requiredPackageId: FULL_RESULT_REQUIRED_PACKAGE_ID })) {
    // Distingue "nunca compró nada" de "compró, pero otro predio" -- ambos
    // son 403, pero con código distinto (Requisito 4). Nunca decide acceso
    // por sí sola: solo clasifica el motivo cuando ya se sabe que no hay
    // una orden aprobada válida para ESTE predio.
    const anyApprovedOrder = await findAnyApprovedOrderForSession(session.id);
    if (anyApprovedOrder) {
      return { ok: false, status: 403, code: 'PREDIO_MISMATCH' };
    }
    return { ok: false, status: 403, code: 'ENTITLEMENT_REQUIRED' };
  }

  return { ok: true, canonicalPredioId: preview.canonicalPredioId, order };
}

router.get('/lookups/:lookupId/full-result', async (req, res, next) => {
  try {
    const lookupId = String(req.params?.lookupId || '').trim();
    const access = await resolveFullResultAccess({ lookupId, cookieHeader: req.headers.cookie });

    if (!access.ok) {
      res.setHeader('Cache-Control', 'no-store');
      res.status(access.status).json({ found: false, status: access.code });
      return;
    }

    const result = await buildLookupFullResultPayload(lookupId);

    if (result.errorStatus) {
      res.setHeader('Cache-Control', 'no-store');
      res.status(result.errorStatus).json(result.payload);
      return;
    }

    res.setHeader('Cache-Control', 'no-store');
    res.json({
      ...result.payload,
      status: 'FULL_RESULT_READY',
      lookupId,
    });
  } catch (error) {
    next(error);
  }
});

router.get('/audit/lookups/:lookupId/full-result', async (req, res, next) => {
  try {
    if (!AUDIT_DOWNLOADS_ENABLED || !isLocalAuditRequest(req)) {
      res.status(404).json({
        found: false,
        status: 'AUDIT_DOWNLOADS_DISABLED',
      });
      return;
    }

    const lookupId = String(req.params?.lookupId || '').trim();
    const result = await buildLookupFullResultPayload(lookupId);

    if (result.errorStatus) {
      res.status(result.errorStatus).json(result.payload);
      return;
    }

    res.setHeader('Cache-Control', 'no-store');
    res.json({
      ...result.payload,
      status: 'AUDIT_FULL_RESULT',
      audit: true,
      localOnly: true,
      lookupId,
    });
  } catch (error) {
    next(error);
  }
});

router.post('/advanced/lookup', async (req, res, next) => {
  try {
    if (!ADVANCED_LOOKUP_ENABLED || !isLocalAuditRequest(req)) {
      res.status(404).json({
        found: false,
        status: 'ADVANCED_LOOKUP_DISABLED',
      });
      return;
    }

    const lat = parseCoordinate(req.body?.lat, 'lat');
    const lng = parseCoordinate(req.body?.lng, 'lng');

    const advancedResult = await query(
      `with punto as (
         select ST_SetSRID(
           ST_Transform(
             ST_SetSRID(ST_MakePoint($1, $2), 4326),
             $3
           ),
           9377
         ) as geom
       )
       select
         p.codigo_predial,
         p.codigo_anterior,
         p.departamento_nombre,
         p.municipio_dane,
         p.municipio_nombre,
         p.zona,
         p.nombre_predio,
         p.direccion_real,
         p.vereda_nombre,
         p.barrio_nombre,
         p.sector_codigo,
         p.manzana_codigo,
         p.area_terreno_m2,
         p.area_terreno_ha,
         p.destino_economico_nombre,
         p.uso_1_nombre,
         p.uso_2_nombre,
         p.uso_3_nombre,
         p.numero_construcciones,
         p.area_construida_m2,
         p.tipos_construccion_resumen,
         p.fuente,
         p.fecha_proceso
       from catastrox_clean.v_predios_enriquecidos p, punto
       where ST_Covers(p.geom, punto.geom)
          or ST_Intersects(p.geom, punto.geom)
       order by
         case when ST_Covers(p.geom, punto.geom) then 0 else 1 end,
         ST_Area(p.geom) asc
       limit 1`,
      [lng, lat, CATASTROX_ORIGEN_NACIONAL_PROJ],
    );

    const row = advancedResult.rows[0];

    if (!row) {
      res.status(404).json({
        found: false,
        status: 'ADVANCED_PREDIO_NOT_FOUND',
        queryPoint: buildQueryPoint(lat, lng),
      });
      return;
    }

    const lookupId = buildLookupId();
    rememberAdvancedLookupPreview(lookupId, row.codigo_predial, {
      canonicalPredioId: resolveCanonicalPredioId({
        codigoPredial: row.codigo_predial || null,
        source: 'clean',
        terrenoId: row.fid ?? null,
      }),
      queryPoint: buildQueryPoint(lat, lng),
    });

    res.setHeader('Cache-Control', 'no-store');
    res.json({
      found: true,
      status: 'ADVANCED_LOOKUP_FOUND',
      internal: true,
      localOnly: true,
      lookup_id: lookupId,
      routeId: lookupId,
      queryPoint: buildQueryPoint(lat, lng),
      geometryAvailable: true,
      codigo_predial: toNullableString(row.codigo_predial),
      codigo_anterior: toNullableString(row.codigo_anterior),
      nombre_predio: toNullableString(row.nombre_predio),
      direccion_real: toNullableString(row.direccion_real),
      departamento_nombre: toNullableString(row.departamento_nombre),
      municipio_dane: toNullableString(row.municipio_dane),
      municipio_nombre: toNullableString(row.municipio_nombre),
      zona: toNullableString(row.zona),
      vereda_nombre: toNullableString(row.vereda_nombre),
      veredaDisplay: getVeredaDisplay(row.vereda_nombre),
      barrio_nombre: toNullableString(row.barrio_nombre),
      sector_codigo: toNullableString(row.sector_codigo),
      manzana_codigo: toNullableString(row.manzana_codigo),
      area_terreno_m2: toNullableNumber(row.area_terreno_m2),
      area_terreno_ha: toNullableNumber(row.area_terreno_ha),
      destino_economico_nombre: toNullableString(row.destino_economico_nombre),
      uso_1_nombre: toNullableString(row.uso_1_nombre),
      uso_2_nombre: toNullableString(row.uso_2_nombre),
      uso_3_nombre: toNullableString(row.uso_3_nombre),
      numero_construcciones: toNullableNumber(row.numero_construcciones),
      area_construida_m2: toNullableNumber(row.area_construida_m2),
      tipos_construccion_resumen: toNullableString(row.tipos_construccion_resumen),
      fuente: toNullableString(row.fuente),
      fecha_proceso: toNullableString(row.fecha_proceso),
    });
  } catch (error) {
    next(error);
  }
});

router.get('/audit/resolver-shadow', (req, res) => {
  if (!isLocalSocketRequest(req)) {
    res.status(404).json({
      found: false,
      status: 'RESOLVER_SHADOW_AUDIT_DISABLED',
    });
    return;
  }

  const summary = resolverShadow.getShadowSummary();
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    enabled: summary.enabled,
    matrixVersion: summary.matrixVersion,
    matrixCounts: summary.matrixCounts,
    summary,
    evaluations: resolverShadow.getShadowEvaluations(),
  });
});

router.delete('/audit/resolver-shadow', (req, res) => {
  if (!isLocalSocketRequest(req)) {
    res.status(404).json({
      found: false,
      status: 'RESOLVER_SHADOW_AUDIT_DISABLED',
    });
    return;
  }

  resolverShadow.clearShadowEvaluations();
  res.setHeader('Cache-Control', 'no-store');
  res.json({ cleared: true });
});

export default router;
