// SPRINT-3D3-POTREROS-API-FOUNDATION: acceso a datos de Potreros contra
// Postgres-AGX-Business (agx.potreros, fundación aplicada en
// 0003_potreros_foundation.sql / SPRINT-3D2). Mismo principio de
// separación router/repositorio ya usado en prediosRepository.js --
// probable directamente contra un Postgres/PostGIS real vía
// withOrganizacionTransaction, sin stack HTTP/sesión.
//
// Regla de dominio (§ dominio del sprint): ORGANIZACIÓN -> PREDIO ->
// POTRERO. Toda función recibe `organizacionId` ya autorizado por el
// llamador y confía en RLS+FORCE (0003) como aislamiento de tenant --
// además, cada consulta filtra explícitamente por `predio_id` (RLS NO
// aísla por predio, solo por organización) para nunca mezclar potreros de
// dos predios de la misma organización.
import { withOrganizacionTransaction } from '../../db/agxBusinessPool.js';
import { computeCoverageMetrics, decideToleranceStatus, TOLERANCE_STATUS } from './potreroSpatialTolerance.js';

function semanticError(code, status, message) {
  return Object.assign(new Error(message || code), { status, code });
}

function assertPredioIdFormat(predioId) {
  if (!/^\d+$/.test(String(predioId))) {
    throw semanticError('INVALID_PREDIO_ID', 400, 'predioId inválido.');
  }
}

function assertPotreroIdFormat(potreroId) {
  if (!/^\d+$/.test(String(potreroId))) {
    throw semanticError('INVALID_POTRERO_ID', 400, 'potreroId inválido.');
  }
}

/**
 * Confirma que `predioId` pertenece a la organización activa (RLS +
 * FORCE). Lanza PREDIO_NOT_FOUND (404) si no existe o pertenece a otro
 * tenant -- ambos casos son indistinguibles para el cliente.
 */
async function assertPredioBelongsToOrg(client, predioId) {
  const result = await client.query('select predio_id from agx.predios where predio_id = $1', [predioId]);
  if (result.rows.length === 0) {
    throw semanticError('PREDIO_NOT_FOUND', 404, 'El predio no existe o no pertenece a tu organización.');
  }
}

export async function listPotrerosByPredio(organizacionId, predioId) {
  assertPredioIdFormat(predioId);
  return withOrganizacionTransaction(organizacionId, async (client) => {
    await assertPredioBelongsToOrg(client, predioId);

    const result = await client.query(
      `select potrero_id, nombre, area_ha, capacidad_animales, observaciones,
              metodo_delimitacion, created_at, updated_at
         from agx.potreros
        where predio_id = $1
        order by created_at desc`,
      [predioId],
    );
    return result.rows;
  });
}

export async function getPotreroDetail(organizacionId, predioId, potreroId) {
  assertPredioIdFormat(predioId);
  assertPotreroIdFormat(potreroId);
  return withOrganizacionTransaction(organizacionId, async (client) => {
    // Una sola consulta verifica simultáneamente tenant (RLS) + predio
    // correcto + pertenencia del potrero a ESE predio -- si el mismo
    // potrero_id existe bajo otro predio, o el potrero pertenece a otra
    // organización, esta consulta devuelve 0 filas en ambos casos.
    const result = await client.query(
      `select potrero_id, nombre, area_ha, capacidad_animales, observaciones,
              metodo_delimitacion, ST_AsGeoJSON(geometry)::json as geometry,
              created_at, updated_at
         from agx.potreros
        where potrero_id = $1 and predio_id = $2`,
      [potreroId, predioId],
    );
    return result.rows[0] || null;
  });
}

const MIN_DISTINCT_VERTICES = 3;

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Construye un WKT Polygon cerrado explícitamente a partir de una lista de
 * puntos {latitud, longitud} (§13 del sprint). NUNCA aplica buffer, snap,
 * clip ni tolerancia oculta -- la única normalización es cerrar el anillo
 * si el cliente no lo cerró él mismo, y eso se hace explícitamente aquí,
 * nunca en SQL.
 */
export function buildPolygonWktFromPuntos(puntos) {
  if (!Array.isArray(puntos) || puntos.length < MIN_DISTINCT_VERTICES) {
    throw semanticError('INVALID_POTRERO_COORDINATES', 400, `Se requieren al menos ${MIN_DISTINCT_VERTICES} vértices.`);
  }

  const parsed = puntos.map((punto) => {
    const lat = Number(punto?.latitud);
    const lng = Number(punto?.longitud);
    if (!isFiniteNumber(lat) || !isFiniteNumber(lng)) {
      throw semanticError('INVALID_POTRERO_COORDINATES', 400, 'Cada punto requiere latitud/longitud numéricas.');
    }
    if (lat < -90 || lat > 90) {
      throw semanticError('INVALID_POTRERO_COORDINATES', 400, 'latitud debe estar entre -90 y 90.');
    }
    if (lng < -180 || lng > 180) {
      throw semanticError('INVALID_POTRERO_COORDINATES', 400, 'longitud debe estar entre -180 y 180.');
    }
    return { lat, lng };
  });

  // Si el cliente ya envió el anillo cerrado (primer punto === último),
  // se descarta el duplicado final antes de contar vértices distintos --
  // el cierre real se vuelve a aplicar explícitamente más abajo.
  let ring = parsed;
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (ring.length > MIN_DISTINCT_VERTICES && first.lat === last.lat && first.lng === last.lng) {
    ring = ring.slice(0, -1);
  }

  const distinctCount = new Set(ring.map((p) => `${p.lat}:${p.lng}`)).size;
  if (ring.length < MIN_DISTINCT_VERTICES || distinctCount < MIN_DISTINCT_VERTICES) {
    throw semanticError('INVALID_POTRERO_COORDINATES', 400, `Se requieren al menos ${MIN_DISTINCT_VERTICES} vértices distintos.`);
  }

  const closedRing = [...ring, ring[0]];
  const wkt = `POLYGON((${closedRing.map((p) => `${p.lng} ${p.lat}`).join(', ')}))`;
  return wkt;
}

/**
 * SPRINT-3D5.2: evalúa UN polígono ya ST_IsValid=true contra el predio y
 * decide STRICT_OK/TOLERANCE_OK/OUTSIDE (potreroSpatialTolerance.js).
 * NUNCA modifica la geometría del usuario -- `geometry` que se devuelve es
 * siempre exactamente ST_AsGeoJSON(ST_GeomFromText(wkt)), jamás el
 * resultado de ST_Difference/ST_Buffer/ST_Snap (esas operaciones viven
 * exclusivamente dentro de computeCoverageMetrics, solo para medir).
 *
 * Devuelve { geometry, areaHa, validacion } si STRICT_OK/TOLERANCE_OK, o
 * lanza POTRERO_OUTSIDE_PREDIO (con `.details` -- geometry/areaHa/metrics
 * -- para que el caller pueda ofrecer un preview de solo lectura de la
 * geometría rechazada, §13 del sprint) si OUTSIDE.
 */
async function evaluatePolygonAgainstPredio(client, wkt, predioId, { metodoDelimitacion, gpsAccuracyMaxM = null } = {}) {
  const geometryResult = await client.query(
    `select ST_IsValid(g.geom) as is_valid,
            ST_Area(g.geom::geography) as area_total_m2,
            ST_AsGeoJSON(g.geom)::json as geometry
       from (select ST_GeomFromText($1, 4326) as geom) g`,
    [wkt],
  );
  const { is_valid: isValid, area_total_m2: areaTotalM2Raw, geometry } = geometryResult.rows[0];
  if (!isValid) {
    throw semanticError('INVALID_POTRERO_GEOMETRY', 422, 'El polígono propuesto no es una geometría válida (posible autointersección).');
  }

  const areaTotalM2 = Number(areaTotalM2Raw);
  if (!(areaTotalM2 > 0)) {
    throw semanticError('INVALID_POTRERO_GEOMETRY', 422, 'El polígono no tiene área (área total <= 0).');
  }
  const areaHa = areaTotalM2 / 10000;

  const metrics = await computeCoverageMetrics(client, wkt, predioId, areaTotalM2);
  const decision = decideToleranceStatus({ ...metrics, areaTotalM2, metodoDelimitacion, gpsAccuracyMaxM });

  if (decision.status === TOLERANCE_STATUS.OUTSIDE) {
    const error = semanticError('POTRERO_OUTSIDE_PREDIO', 422, 'El potrero se encuentra fuera del predio más allá del margen operacional permitido.');
    error.details = {
      geometry,
      areaHa,
      metrics: {
        areaFueraM2: metrics.areaFueraM2,
        porcentajeFuera: metrics.porcentajeFuera,
        distanciaMaximaFueraM: metrics.distanciaMaximaFueraM,
      },
      toleranceApplied: decision.toleranceApplied,
    };
    throw error;
  }

  return {
    geometry,
    areaHa,
    validacion: {
      estado: decision.status,
      areaFueraM2: metrics.areaFueraM2,
      porcentajeFuera: metrics.porcentajeFuera,
      distanciaMaximaFueraM: metrics.distanciaMaximaFueraM,
      toleranceApplied: decision.toleranceApplied,
    },
  };
}

/**
 * Valida y calcula el preview espacial de un potrero contra el predio
 * padre (§9/§10/§11/§13 del sprint 3D3; tolerancia operacional §3D5.2):
 * predio existe y pertenece al tenant, predio tiene geometry, el polygon
 * propuesto es topológicamente válido (ST_IsValid -- sin ST_MakeValid, sin
 * auto-corrección), y queda STRICT_OK o TOLERANCE_OK contra el predio
 * (evaluatePolygonAgainstPredio/potreroSpatialTolerance.js). Su área se
 * calcula server-side (ST_Area(geometry::geography)/10000).
 *
 * `context.metodoDelimitacion` decide el umbral de tolerancia aplicado;
 * `context.gpsAccuracyMaxM` solo aplica a gps_movil (§7/§8 del sprint).
 *
 * Devuelve { geometry (GeoJSON), areaHa, validacion } listos para un
 * candidate.
 */
export async function computePotreroPreview(organizacionId, predioId, wkt, context = {}) {
  assertPredioIdFormat(predioId);
  return withOrganizacionTransaction(organizacionId, async (client) => {
    const predioResult = await client.query(
      'select (geometry is null) as sin_geometria from agx.predios where predio_id = $1',
      [predioId],
    );
    if (predioResult.rows.length === 0) {
      throw semanticError('PREDIO_NOT_FOUND', 404, 'El predio no existe o no pertenece a tu organización.');
    }
    if (predioResult.rows[0].sin_geometria) {
      throw semanticError('PREDIO_WITHOUT_GEOMETRY', 422, 'El predio no tiene geometría registrada.');
    }

    return evaluatePolygonAgainstPredio(client, wkt, predioId, context);
  });
}

/**
 * SPRINT-3D5-POTRERO-KML-KMZ (tolerancia §3D5.2): variante batch de
 * computePotreroPreview -- misma validación espacial exacta
 * (evaluatePolygonAgainstPredio: ST_IsValid sin ST_MakeValid,
 * STRICT_OK/TOLERANCE_OK/OUTSIDE sin buffer/snap/ajuste de vértices,
 * ST_Area/10000), pero aplicada a VARIOS polígonos de un mismo archivo
 * KML/KMZ dentro de UNA sola transacción (predio se busca/valida una
 * única vez). Regla de dominio §8/§9: nunca ST_Union, nunca se aborta el
 * archivo completo por un polígono individual inválido/OUTSIDE -- cada
 * wkt se evalúa de forma independiente y su resultado (ok con
 * geometry/areaHa/validacion, u ok:false con code + details de la
 * geometría rechazada si aplica) se devuelve en el mismo orden que
 * `wktList`.
 */
export async function computePotreroPreviewsBatch(organizacionId, predioId, wktList, context = {}) {
  assertPredioIdFormat(predioId);
  return withOrganizacionTransaction(organizacionId, async (client) => {
    const predioResult = await client.query(
      'select (geometry is null) as sin_geometria from agx.predios where predio_id = $1',
      [predioId],
    );
    if (predioResult.rows.length === 0) {
      throw semanticError('PREDIO_NOT_FOUND', 404, 'El predio no existe o no pertenece a tu organización.');
    }
    if (predioResult.rows[0].sin_geometria) {
      throw semanticError('PREDIO_WITHOUT_GEOMETRY', 422, 'El predio no tiene geometría registrada.');
    }

    const results = [];
    for (const wkt of wktList) {
      try {
        const evaluated = await evaluatePolygonAgainstPredio(client, wkt, predioId, context);
        results.push({ ok: true, ...evaluated });
      } catch (error) {
        if (typeof error?.code !== 'string') throw error;
        results.push({ ok: false, code: error.code, details: error.details ?? null });
      }
    }

    return results;
  });
}

/**
 * Crea el potrero definitivo a partir de un candidate ya reservado (§6 del
 * sprint) -- geometry/areaHa/metodoDelimitacion vienen EXCLUSIVAMENTE del
 * candidate (nunca del body), nombre/capacidadAnimales/observaciones son
 * los únicos campos que puede aportar el cliente en este paso.
 */
export async function createPotreroFromCandidate(organizacionId, predioId, { geometry, areaHa, metodoDelimitacion, nombre, capacidadAnimales, observaciones }) {
  assertPredioIdFormat(predioId);
  return withOrganizacionTransaction(organizacionId, async (client) => {
    const geometryJson = JSON.stringify(geometry);
    const result = await client.query(
      `insert into agx.potreros
         (organizacion_id, predio_id, nombre, geometry, area_ha, metodo_delimitacion, capacidad_animales, observaciones)
       values ($1, $2, $3, ST_SetSRID(ST_GeomFromGeoJSON($4), 4326), $5, $6, $7, $8)
       returning potrero_id`,
      [organizacionId, predioId, nombre, geometryJson, areaHa, metodoDelimitacion, capacidadAnimales, observaciones],
    );
    return result.rows[0].potrero_id;
  });
}
