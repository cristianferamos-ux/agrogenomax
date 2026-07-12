import { Router } from 'express';
import {
  CATASTROX_COVERAGE_STATUS,
  estimateMunicipalCoverageByPoint,
  getMunicipalCoverageByCode,
} from '../data/catastroxCoberturaMunicipal.js';
import { catastroxQuery as query } from '../catastroxDb.js';
import { createCatastroxResolverShadow } from '../services/catastrox/catastroxResolverShadow.js';

const router = Router();

const CATASTROX_LEGAL_NOTICE =
  'CatastroX realiza análisis técnico sobre información geográfica y catastral pública disponible. No reemplaza certificados oficiales del IGAC, gestor catastral, oficina de registro ni autoridad competente.';
const LOOKUP_PREVIEW_TTL_MS = 30 * 60 * 1000;
const lookupPreviewStore = new Map();
const AUDIT_DOWNLOADS_ENABLED = String(process.env.CATASTROX_AUDIT_DOWNLOADS || '').toLowerCase() === 'true';
const ADVANCED_LOOKUP_ENABLED = String(process.env.CATASTROX_ADVANCED_LOOKUP_ENABLED || '').toLowerCase() === 'true';
// Modo sombra del resolver de duplicados: desactivado por defecto. Solo observa;
// nunca decide la respuesta de /lookup. Ver docs/catastrox/CATASTROX_RESOLVER_SHADOW_MODE_V1.md.
const RESOLVER_SHADOW_ENABLED = String(process.env.CATASTROX_RESOLVER_SHADOW_ENABLED || '').toLowerCase() === 'true';
const TECHNICAL_VEREDA_PATTERN = /^\d+[A-Z]{2}$/i;
const CATASTROX_ORIGEN_NACIONAL_PROJ =
  '+proj=tmerc +lat_0=4 +lon_0=-73 +k=0.9992 +x_0=5000000 +y_0=2000000 +ellps=GRS80 +units=m +no_defs +type=crs';

function buildLookupId() {
  return `cx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function rememberLookupPreview(lookupId, predioId) {
  const existing = lookupPreviewStore.get(lookupId);
  lookupPreviewStore.set(lookupId, {
    ...(existing || {}),
    predioId,
    createdAt: Date.now(),
  });
}

function rememberAdvancedLookupPreview(lookupId, codigoPredial) {
  const existing = lookupPreviewStore.get(lookupId);
  lookupPreviewStore.set(lookupId, {
    ...(existing || {}),
    source: 'clean',
    codigoPredial,
    createdAt: Date.now(),
  });
}

function resolveLookupPreview(lookupId) {
  const record = lookupPreviewStore.get(lookupId);
  if (!record) return null;
  if (Date.now() - record.createdAt > LOOKUP_PREVIEW_TTL_MS) {
    lookupPreviewStore.delete(lookupId);
    return null;
  }
  return record;
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

async function findMunicipioByPoint(lng, lat) {
  const directMatch = await query(
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

  if (directMatch.rows[0]) {
    return normalizeMunicipioRow(directMatch.rows[0]);
  }

  const nearestMatch = await query(
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

  return normalizeMunicipioRow(nearestMatch.rows[0]);
}

async function findCleanPredioByPoint(lng, lat) {
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
     candidatos as (
       select
         p.codigo_predial,
         p.zona,
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
       from catastrox_clean.predios p
     )
     select
       c.codigo_predial,
       c.zona,
       c.fid
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
     limit 1`,
    [lng, lat, CATASTROX_ORIGEN_NACIONAL_PROJ],
  );

  return result.rows[0] || null;
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

    const predioResult = await query(
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
           c.shape_area
         from catastro c, punto p
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
         limit 1
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

    if (predioResult.rows[0]) {
      const row = predioResult.rows[0];
      const municipio = normalizeMunicipioRow(row);
      const coverage = resolveCoverageStatus({ municipio, lat, lng });
      const lookupId = buildLookupId();
      rememberLookupPreview(lookupId, row.id);

      res.json({
        lookup_id: lookupId,
        routeId: lookupId,
        found: true,
        status: 'FOUND',
        municipio: toNullableString(row.mpnombre),
        departamento: toNullableString(row.depto),
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
          municipio: toNullableString(row.mpnombre),
          departamento: toNullableString(row.depto),
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

    const cleanPredio = await findCleanPredioByPoint(lng, lat);

    if (cleanPredio) {
      const municipio = await findMunicipioByPoint(lng, lat);
      const coverage = municipio ? resolveCoverageStatus({ municipio, lat, lng }) : null;
      const lookupId = buildLookupId();
      rememberAdvancedLookupPreview(lookupId, cleanPredio.codigo_predial);

      res.json({
        lookup_id: lookupId,
        routeId: lookupId,
        found: true,
        status: 'FOUND',
        municipio: toNullableString(municipio?.municipio),
        departamento: toNullableString(municipio?.departamento),
        gestor: toNullableString(municipio?.gestorCatastral),
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
          municipio: toNullableString(municipio?.municipio),
          departamento: toNullableString(municipio?.departamento),
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
          `select
             ST_AsGeoJSON(
               ST_SimplifyPreserveTopology(
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
                 ),
                 0.00003
               )
             )::json as preview_geometry
           from catastrox_clean.v_predios_enriquecidos p
           where p.codigo_predial = $1
           limit 1`,
          [preview.codigoPredial, CATASTROX_ORIGEN_NACIONAL_PROJ],
        )
      : await query(
          `select
             ST_AsGeoJSON(
               ST_SimplifyPreserveTopology(
                 ST_Multi(
                   ST_CollectionExtract(
                     case
                       when ST_IsValid(c.geom) then c.geom
                       else ST_MakeValid(c.geom)
                     end,
                     3
                   )
                 ),
                 0.00003
               )
             )::json as preview_geometry
           from gis.catastro_caqueta c
           where c.id = $1
           limit 1`,
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
           degraded as (
             select
               ST_SimplifyPreserveTopology(
                 ST_SnapToGrid(geom, 0.00008),
                 0.00008
               ) as geom
             from source
             where geom is not null and not ST_IsEmpty(geom)
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
           degraded as (
             select
               ST_SimplifyPreserveTopology(
                 ST_SnapToGrid(geom, 0.00008),
                 0.00008
               ) as geom
             from source
             where geom is not null and not ST_IsEmpty(geom)
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
    const preview = resolveLookupPreview(lookupId);

    if (!preview) {
      res.status(404).json({
        found: false,
        status: 'LOOKUP_NOT_FOUND',
      });
      return;
    }

    const CLEAN_FULL_RESULT_QUERY = `select
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
      if (cleanResult.rows[0] && isValidPredioGeometry(cleanResult.rows[0].geometry)) {
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

    if (!row) {
      res.status(404).json({
        found: false,
        status: 'FULL_RESULT_UNAVAILABLE',
      });
      return;
    }

    res.setHeader('Cache-Control', 'no-store');
    res.json({
      found: true,
      status: 'AUDIT_FULL_RESULT',
      audit: true,
      localOnly: true,
      legalNotice: CATASTROX_LEGAL_NOTICE,
      predio: {
        id: source === 'clean' ? row.codigo_predial : row.id,
        routeId: lookupId,
        lookup_id: lookupId,
        source: source === 'clean' ? 'audit-local-clean' : 'audit-local',
        codigoPredial: toNullableString(source === 'clean' ? row.codigo_predial : (row.codigo || row.codigo_predial)),
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
        areaM2: Number(row.shape_area || row.area_terreno_m2 || 0),
        areaHa: Number(row.area_terreno_ha || (Number(row.shape_area || 0) / 10000)),
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
        geometry: row.geometry,
        polygonGeoJson: {
          type: 'Feature',
          properties: {},
          geometry: row.geometry,
        },
      },
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

    const requestedLookupId = String(req.body?.lookup_id || req.body?.routeId || '').trim();
    const lookupId = requestedLookupId || buildLookupId();
    rememberAdvancedLookupPreview(lookupId, row.codigo_predial);

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
