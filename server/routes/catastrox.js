import { Router } from 'express';
import {
  CATASTROX_COVERAGE_STATUS,
  estimateMunicipalCoverageByPoint,
  getMunicipalCoverageByCode,
} from '../data/catastroxCoberturaMunicipal.js';
import { catastroxQuery as query } from '../catastroxDb.js';

const router = Router();

const CATASTROX_LEGAL_NOTICE =
  'CatastroX realiza análisis técnico sobre información geográfica y catastral pública disponible. No reemplaza certificados oficiales del IGAC, gestor catastral, oficina de registro ni autoridad competente.';
const LOOKUP_PREVIEW_TTL_MS = 30 * 60 * 1000;
const lookupPreviewStore = new Map();
const AUDIT_DOWNLOADS_ENABLED = String(process.env.CATASTROX_AUDIT_DOWNLOADS || '').toLowerCase() === 'true';

function buildLookupId() {
  return `cx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function rememberLookupPreview(lookupId, predioId) {
  lookupPreviewStore.set(lookupId, {
    predioId,
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

    const previewResult = await query(
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

    const previewResult = await query(
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

    const fullResult = await query(
      `select
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
       limit 1`,
      [preview.predioId],
    );

    const row = fullResult.rows[0];

    if (!row?.geometry) {
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
        id: row.id,
        routeId: lookupId,
        lookup_id: lookupId,
        source: 'audit-local',
        codigoPredial: toNullableString(row.codigo) || String(row.id),
        codigoAnterior: toNullableString(row.codigo_anterior) || 'No disponible',
        municipio: toNullableString(row.mpnombre),
        departamento: toNullableString(row.depto),
        gestor: toNullableString(row.gestor),
        areaM2: Number(row.shape_area || 0),
        areaHa: Number(row.shape_area || 0) / 10000,
        perimetroM: Number(row.shape_length || 0),
        estadoPredial: 'Predio identificado en la base catastral consultada.',
        tipoZona: 'Rural',
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

export default router;
