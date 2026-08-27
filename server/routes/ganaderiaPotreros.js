// SPRINT-3D3-POTREROS-API-FOUNDATION: backend de Potreros -- listar, ver
// detalle, previsualizar geometría (coordenadas/gps) y confirmar creación
// vía candidate. Monta en /api/ganaderia/predios/:predioId/potreros
// (server/index.js) -- deliberadamente separado de la ruta legacy
// /api/potreros (Postgres legacy, sin aislamiento por organización, no se
// toca en este sprint).
//
// Regla de oro: esta ruta SOLO habla con Postgres-AGX-Business, vía
// server/services/ganaderia/potrerosRepository.js ->
// agxBusinessPool.js/withOrganizacionTransaction. El tenant
// (organizacionId) sale exclusivamente de req.ganaderiaAuth, resuelto
// server-side por createRequireGanaderiaSession -- jamás de
// body/query/header. Regla de dominio: ORGANIZACIÓN -> PREDIO -> POTRERO;
// toda ruta está subordinada a :predioId, tomado del path (params
// heredados del mount vía mergeParams), nunca del body.
//
// Router({ mergeParams: true }) es OBLIGATORIO aquí -- sin esto,
// req.params.predioId (definido en el path de montaje en server/index.js)
// no sería visible dentro de los handlers de este router.
import { Router, raw } from 'express';
import {
  createRequireGanaderiaSession,
  createRequireGanaderiaCsrf,
} from '../security/ganaderiaSession.js';
import { potrerosPreviewLimiter } from '../middleware/rateLimit.js';
import {
  listPotrerosByPredio,
  getPotreroDetail,
  buildPolygonWktFromPuntos,
  computePotreroPreview,
  computePotreroPreviewsBatch,
  createPotreroFromCandidate,
} from '../services/ganaderia/potrerosRepository.js';
import {
  createPotreroCandidate,
  reservePotreroCandidate,
  commitPotreroCandidate,
  releasePotreroCandidate,
} from '../services/ganaderia/potrerosCandidateStore.js';
import { parseKmlOrKmzUpload, FILE_MAX_BYTES } from '../services/ganaderia/potreroKmlImport.js';
import { archivarPotrero, restaurarPotrero } from '../services/ganaderia/potreroArchivoRepository.js';
import { validateGpsAccuracyList } from '../services/ganaderia/potreroSpatialTolerance.js';

const MAX_NOMBRE_LENGTH = 120;
const MAX_OBSERVACIONES_LENGTH = 2000;

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function isPredioIdValid(predioId) {
  return /^\d+$/.test(String(predioId));
}

function isPotreroIdValid(potreroId) {
  return /^\d+$/.test(String(potreroId));
}

// -----------------------------------------------------------------------
// Validación de entrada
// -----------------------------------------------------------------------

function validateCapacidadAnimales(rawValue) {
  if (rawValue === undefined || rawValue === null || rawValue === '') return null;
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
    throw Object.assign(new Error('capacidadAnimales debe ser un entero >= 0.'), {
      status: 400,
      code: 'INVALID_CAPACIDAD_ANIMALES',
    });
  }
  return parsed;
}

function validateObservaciones(rawValue) {
  if (rawValue === undefined || rawValue === null || rawValue === '') return null;
  if (typeof rawValue !== 'string' || rawValue.length > MAX_OBSERVACIONES_LENGTH) {
    throw Object.assign(new Error(`observaciones debe ser texto (máx ${MAX_OBSERVACIONES_LENGTH} caracteres).`), {
      status: 400,
      code: 'INVALID_OBSERVACIONES',
    });
  }
  return rawValue.trim() || null;
}

// §13: preview por coordenadas/gps -- únicamente `puntos`, nunca
// geometry/areaHa/metodoDelimitacion/predioId/organizacionId libres.
const PREVIEW_ALLOWED_KEYS = new Set(['puntos']);

export function validatePreviewBody(body) {
  const unknownKeys = Object.keys(body || {}).filter((key) => !PREVIEW_ALLOWED_KEYS.has(key));
  if (unknownKeys.length > 0) {
    throw Object.assign(new Error(`Campos no permitidos: ${unknownKeys.join(', ')}`), {
      status: 400,
      code: 'FORBIDDEN_FIELDS',
    });
  }
  return buildPolygonWktFromPuntos(body?.puntos);
}

// §6: creación definitiva -- únicamente candidateId + campos operativos
// del cliente. NUNCA organizacionId, predioId, geometry, areaHa ni
// metodoDelimitacion (esos tres últimos vienen exclusivamente del
// candidate ya validado server-side).
const CREATE_ALLOWED_KEYS = new Set(['candidateId', 'nombre', 'capacidadAnimales', 'observaciones']);

export function validateCreatePotreroBody(body) {
  const unknownKeys = Object.keys(body || {}).filter((key) => !CREATE_ALLOWED_KEYS.has(key));
  if (unknownKeys.length > 0) {
    throw Object.assign(new Error(`Campos no permitidos: ${unknownKeys.join(', ')}`), {
      status: 400,
      code: 'FORBIDDEN_FIELDS',
    });
  }

  if (!isNonEmptyString(body?.candidateId)) {
    throw Object.assign(new Error('candidateId es obligatorio.'), { status: 400, code: 'INVALID_CANDIDATE_ID' });
  }
  if (!isNonEmptyString(body?.nombre) || body.nombre.trim().length > MAX_NOMBRE_LENGTH) {
    throw Object.assign(new Error(`nombre es obligatorio (máx ${MAX_NOMBRE_LENGTH} caracteres).`), {
      status: 400,
      code: 'INVALID_NOMBRE',
    });
  }

  return {
    candidateId: body.candidateId,
    nombre: body.nombre.trim(),
    capacidadAnimales: validateCapacidadAnimales(body.capacidadAnimales),
    observaciones: validateObservaciones(body.observaciones),
  };
}

// -----------------------------------------------------------------------
// Serialización DB -> API (nunca organizacion_id; listado nunca expone
// geometry completa -- solo tieneGeometria, siempre true en este esquema
// porque agx.potreros.geometry es NOT NULL, se mantiene el campo por
// forma/consistencia con el contrato acordado).
// -----------------------------------------------------------------------

function serializePotreroListItem(predioId, row) {
  return {
    potreroId: String(row.potrero_id),
    nombre: row.nombre,
    areaHa: Number(row.area_ha),
    capacidadAnimales: row.capacidad_animales === null ? null : Number(row.capacidad_animales),
    observaciones: row.observaciones ?? null,
    metodoDelimitacion: row.metodo_delimitacion,
    tieneGeometria: true,
    fechaCreacion: row.created_at,
    fechaActualizacion: row.updated_at,
    // SPRINT-3D9.2
    estado: row.estado,
  };
}

function serializePotreroDetail(row) {
  return {
    potreroId: String(row.potrero_id),
    nombre: row.nombre,
    areaHa: Number(row.area_ha),
    capacidadAnimales: row.capacidad_animales === null ? null : Number(row.capacidad_animales),
    observaciones: row.observaciones ?? null,
    metodoDelimitacion: row.metodo_delimitacion,
    geometry: row.geometry,
    fechaCreacion: row.created_at,
    fechaActualizacion: row.updated_at,
  };
}

// -----------------------------------------------------------------------
// Manejo compartido de errores semánticos lanzados por el repositorio
// (siempre { status, code, message }).
// -----------------------------------------------------------------------

function sendSemanticError(res, error) {
  if (typeof error?.status === 'number' && typeof error?.code === 'string') {
    res.status(error.status).json({ error: error.code, message: error.message });
    return true;
  }
  return false;
}

// SPRINT-3D5.2 §13: cuando el resultado espacial es OUTSIDE (más allá del
// margen de tolerancia operacional), el error POTRERO_OUTSIDE_PREDIO trae
// `.details` (geometry/areaHa/métricas de la geometría RECHAZADA) --
// se expone en el cuerpo de la respuesta para que el frontend pueda
// mostrar un preview de solo lectura (contorno rechazado), sin crear
// candidate ni persistir nada. NUNCA se filtran métricas internas fuera
// de este contrato explícito (áreaFueraM2/porcentajeFuera/
// distanciaMaximaFueraM/toleranceApplied -- nunca SQL ni stack traces).
function sendPreviewError(res, error) {
  if (error?.code === 'POTRERO_OUTSIDE_PREDIO' && error?.details) {
    res.status(error.status).json({ error: error.code, message: error.message, rejected: error.details });
    return true;
  }
  return sendSemanticError(res, error);
}

// -----------------------------------------------------------------------
// Router
// -----------------------------------------------------------------------

export default function createGanaderiaPotrerosRouter({ appEnv, csrfServerSecret, allowedOrigins } = {}) {
  const router = Router({ mergeParams: true });

  const requireSession = createRequireGanaderiaSession({ appEnv });
  const requireCsrf = createRequireGanaderiaCsrf({ csrfServerSecret, allowedOrigins });

  router.use(requireSession);
  router.use(requireCsrf);

  // GET /api/ganaderia/predios/:predioId/potreros
  router.get('/', async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const { predioId } = req.params;
      if (!isPredioIdValid(predioId)) {
        res.status(400).json({ error: 'INVALID_PREDIO_ID' });
        return;
      }

      const { organizacionId } = req.ganaderiaAuth;
      const incluirArchivados = req.query.incluirArchivados === 'true';
      const rows = await listPotrerosByPredio(organizacionId, predioId, { incluirArchivados });
      res.json({ predioId: String(predioId), potreros: rows.map((row) => serializePotreroListItem(predioId, row)) });
    } catch (error) {
      if (sendSemanticError(res, error)) return;
      next(error);
    }
  });

  // GET /api/ganaderia/predios/:predioId/potreros/:potreroId
  router.get('/:potreroId', async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const { predioId, potreroId } = req.params;
      if (!isPredioIdValid(predioId) || !isPotreroIdValid(potreroId)) {
        res.status(400).json({ error: 'INVALID_POTRERO_ID' });
        return;
      }

      const { organizacionId } = req.ganaderiaAuth;
      const row = await getPotreroDetail(organizacionId, predioId, potreroId);

      if (!row) {
        res.status(404).json({ error: 'POTRERO_NOT_FOUND' });
        return;
      }

      res.json(serializePotreroDetail(row));
    } catch (error) {
      if (sendSemanticError(res, error)) return;
      next(error);
    }
  });

  // §13: POST /api/ganaderia/predios/:predioId/potreros/preview-coordinates
  router.post('/preview-coordinates', potrerosPreviewLimiter, async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const { predioId } = req.params;
      if (!isPredioIdValid(predioId)) {
        res.status(400).json({ error: 'INVALID_PREDIO_ID' });
        return;
      }

      const wkt = validatePreviewBody(req.body);
      const { organizacionId, cuentaId } = req.ganaderiaAuth;
      const { geometry, areaHa, validacion } = await computePotreroPreview(organizacionId, predioId, wkt, {
        metodoDelimitacion: 'coordenadas',
      });

      const candidateId = createPotreroCandidate({
        organizacionId,
        cuentaId,
        predioId,
        geometry,
        areaHa,
        metodoDelimitacion: 'coordenadas',
        toleranceInfo: validacion,
      });

      res.json({ candidateId, preview: { areaHa, metodoDelimitacion: 'coordenadas', geometry, validacion } });
    } catch (error) {
      if (sendPreviewError(res, error)) return;
      next(error);
    }
  });

  // §14/SPRINT-3D5.2 §7-9: POST .../preview-gps -- mismo contrato
  // geométrico que preview-coordinates (cierre de anillo, ST_IsValid,
  // validación operacional espacial, ST_Area), con dos diferencias: (1)
  // metodoDelimitacion='gps_movil', (2) cada punto puede traer `accuracy`
  // opcional (metros, navigator.geolocation.coords.accuracy) -- si algún
  // punto la trae y supera GPS_MAX_ACCURACY_M, se rechaza con
  // GPS_ACCURACY_TOO_LOW (pide recaptura) ANTES de tocar PostGIS. Sin
  // accuracy en ningún punto, se aplica el margen fijo conservador
  // GPS_FALLBACK_NO_ACCURACY (ver potreroSpatialTolerance.js) -- nunca se
  // inventa un valor de precisión.
  router.post('/preview-gps', potrerosPreviewLimiter, async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const { predioId } = req.params;
      if (!isPredioIdValid(predioId)) {
        res.status(400).json({ error: 'INVALID_PREDIO_ID' });
        return;
      }

      const wkt = validatePreviewBody(req.body);
      const { maxAccuracyM } = validateGpsAccuracyList(req.body?.puntos);
      const { organizacionId, cuentaId } = req.ganaderiaAuth;
      const { geometry, areaHa, validacion } = await computePotreroPreview(organizacionId, predioId, wkt, {
        metodoDelimitacion: 'gps_movil',
        gpsAccuracyMaxM: maxAccuracyM,
      });

      const candidateId = createPotreroCandidate({
        organizacionId,
        cuentaId,
        predioId,
        geometry,
        areaHa,
        metodoDelimitacion: 'gps_movil',
        toleranceInfo: validacion,
      });

      res.json({ candidateId, preview: { areaHa, metodoDelimitacion: 'gps_movil', geometry, validacion } });
    } catch (error) {
      if (sendPreviewError(res, error)) return;
      next(error);
    }
  });

  // §15/SPRINT-3D5: POST .../preview-file (KML/KMZ). El archivo viaja como
  // bytes crudos en el body (Content-Type: application/octet-stream),
  // NUNCA como JSON/base64 -- por eso este router monta su propio
  // middleware `raw()` únicamente en esta ruta (el resto del router sigue
  // colgando de express.json() global en server/index.js, que ignora esta
  // request porque el Content-Type no es application/json). El nombre de
  // archivo declarado viaja en el header X-Potrero-File-Name -- se usa
  // SOLO para decidir .kml vs .kmz (ver potreroKmlImport.js, que además
  // verifica la firma binaria real; la extensión nunca es la única
  // defensa, y nunca se usa para escribir a disco ni como identificador).
  const rawKmlFileParser = raw({ type: 'application/octet-stream', limit: FILE_MAX_BYTES });

  // Middleware de error de 4 argumentos: captura específicamente el
  // PayloadTooLargeError que lanza `raw()` cuando el body excede
  // FILE_MAX_BYTES, y lo reescribe al contrato de error semántico del
  // sprint (§18: FILE_TOO_LARGE) en vez de dejarlo caer al errorHandler
  // genérico (que expondría el mensaje crudo de body-parser).
  function handleRawFileParseError(err, _req, res, next) {
    if (!err) {
      next();
      return;
    }
    if (err.type === 'entity.too.large' || err.status === 413) {
      res.status(413).json({
        error: 'FILE_TOO_LARGE',
        message: `El archivo supera el máximo permitido (${Math.round(FILE_MAX_BYTES / (1024 * 1024))} MB).`,
      });
      return;
    }
    res.status(400).json({ error: 'INVALID_KML', message: 'No fue posible leer el archivo enviado.' });
  }

  router.post('/preview-file', potrerosPreviewLimiter, rawKmlFileParser, handleRawFileParseError, async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const { predioId } = req.params;
      if (!isPredioIdValid(predioId)) {
        res.status(400).json({ error: 'INVALID_PREDIO_ID' });
        return;
      }

      // Defensa en profundidad -- redundante con el límite de `raw()`
      // arriba, pero §4 exige validar tamaño ANTES de parsear, y esto lo
      // deja explícito en el propio handler, no solo implícito en la
      // config del body-parser.
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        res.status(400).json({ error: 'INVALID_KML', message: 'No se recibió ningún archivo.' });
        return;
      }
      if (req.body.length > FILE_MAX_BYTES) {
        res.status(413).json({
          error: 'FILE_TOO_LARGE',
          message: `El archivo supera el máximo permitido (${Math.round(FILE_MAX_BYTES / (1024 * 1024))} MB).`,
        });
        return;
      }

      const fileNameHeader = req.get('X-Potrero-File-Name') || '';
      const { organizacionId, cuentaId } = req.ganaderiaAuth;

      const { metodoDelimitacion, polygons, ignored, converted } = await parseKmlOrKmzUpload(req.body, { fileNameHeader });

      // §8/§9: NUNCA ST_Union -- cada polígono (ya separado si venía de un
      // MultiPolygon) se valida por separado en una única transacción.
      // §3D5.2/§17: mismo pipeline de tolerancia operacional que
      // coordenadas/gps -- metodoDelimitacion ('kml'/'kmz') decide el
      // umbral técnico aplicado.
      const previews = await computePotreroPreviewsBatch(
        organizacionId,
        predioId,
        polygons.map((polygon) => polygon.wkt),
        { metodoDelimitacion },
      );

      const candidates = [];
      const invalidos = [];

      previews.forEach((preview, index) => {
        const { nombreSugerido } = polygons[index];
        if (preview.ok) {
          // §12: candidate store reutilizado sin cambios -- mismo TTL,
          // mismo state machine, mismo ligamen organizacionId/cuentaId/
          // predioId que coordenadas/gps. metodoDelimitacion es 'kml' o
          // 'kmz' según el archivo subido.
          const candidateId = createPotreroCandidate({
            organizacionId,
            cuentaId,
            predioId,
            geometry: preview.geometry,
            areaHa: preview.areaHa,
            metodoDelimitacion,
            toleranceInfo: preview.validacion,
          });
          candidates.push({
            candidateId,
            nombreSugerido,
            areaHa: preview.areaHa,
            metodoDelimitacion,
            geometry: preview.geometry,
            validacion: preview.validacion,
            // SPRINT-3D5.1: trazabilidad -- null salvo que este candidate
            // provenga de un LineString cerrado convertido a Polygon.
            origenConversion: polygons[index].origenConversion ?? null,
          });
        } else {
          // SPRINT-3D5.2 §13: si el rechazo fue por OUTSIDE (más allá del
          // margen de tolerancia), `details` trae la geometría rechazada
          // para preview de solo lectura -- nunca se crea candidate.
          invalidos.push({ index, nombreSugerido, error: preview.code, rejected: preview.details ?? null });
        }
      });

      // SPRINT-3D5-CIERRE-SEMANTICO §1: Point/LineString abierto/
      // MultiLineString nunca se procesan en silencio -- se reportan
      // explícitamente al cliente (conteos, no solo un booleano) para que
      // el frontend pueda avisar al usuario sin abortar los Polygon
      // válidos del mismo archivo. SPRINT-3D5.1: `convertidos` reporta,
      // también de forma explícita, cuántos LineString CERRADOS fueron
      // interpretados como Polygon (nunca silencioso).
      res.json({ candidates, invalidos, ignorados: ignored, convertidos: converted });
    } catch (error) {
      if (sendSemanticError(res, error)) return;
      next(error);
    }
  });

  // §6: POST /api/ganaderia/predios/:predioId/potreros -- crear potrero
  // definitivo a partir de un candidate ya reservado.
  router.post('/', async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const { predioId } = req.params;
      if (!isPredioIdValid(predioId)) {
        res.status(400).json({ error: 'INVALID_PREDIO_ID' });
        return;
      }

      const { candidateId, nombre, capacidadAnimales, observaciones } = validateCreatePotreroBody(req.body);
      const { organizacionId, cuentaId } = req.ganaderiaAuth;

      const reservation = reservePotreroCandidate({ candidateId, organizacionId, cuentaId, predioId });

      if (reservation.status === 'expired') {
        res.status(410).json({ error: 'CANDIDATE_EXPIRED', message: 'El preview expiró. Vuelve a generarlo.' });
        return;
      }
      if (reservation.status === 'consumed') {
        res.status(409).json({ error: 'CANDIDATE_ALREADY_USED', message: 'Este preview ya fue utilizado.' });
        return;
      }
      if (reservation.status === 'in_use') {
        res.status(409).json({ error: 'CANDIDATE_IN_USE', message: 'Este preview ya se está procesando. Espera un momento.' });
        return;
      }
      if (reservation.status === 'scope_mismatch') {
        res.status(409).json({ error: 'CANDIDATE_SCOPE_MISMATCH', message: 'Este preview fue generado para otro predio.' });
        return;
      }
      if (reservation.status === 'not_found' || reservation.status === 'forbidden') {
        res.status(404).json({ error: 'CANDIDATE_NOT_FOUND', message: 'El preview no es válido. Vuelve a generarlo.' });
        return;
      }

      const { geometry, areaHa, metodoDelimitacion } = reservation;

      let potreroId;
      try {
        potreroId = await createPotreroFromCandidate(organizacionId, predioId, {
          geometry,
          areaHa,
          metodoDelimitacion,
          nombre,
          capacidadAnimales,
          observaciones,
        });
      } catch (transactionError) {
        releasePotreroCandidate(candidateId);
        throw transactionError;
      }
      commitPotreroCandidate(candidateId);

      res.status(201).json({ ok: true, potreroId: String(potreroId), predioId: String(predioId) });
    } catch (error) {
      if (sendSemanticError(res, error)) return;
      next(error);
    }
  });

  // SPRINT-3D9.2: archivar/restaurar -- "Eliminar potrero" en la UI
  // internamente llama a este endpoint (reemplaza el hard DELETE,
  // revocado en 0010).
  router.post('/:potreroId/archivar', async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (!/^\d+$/.test(String(req.params.potreroId))) {
        res.status(400).json({ error: 'INVALID_POTRERO_ID' });
        return;
      }
      const { organizacionId, cuentaId } = req.ganaderiaAuth;
      const potrero = await archivarPotrero(organizacionId, req.params.predioId, req.params.potreroId, {
        motivo: req.body?.motivo, actorCuentaId: cuentaId,
      });
      res.json({ ok: true, potrero });
    } catch (error) {
      if (sendSemanticError(res, error)) return;
      next(error);
    }
  });

  router.post('/:potreroId/restaurar', async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (!/^\d+$/.test(String(req.params.potreroId))) {
        res.status(400).json({ error: 'INVALID_POTRERO_ID' });
        return;
      }
      const { organizacionId, cuentaId } = req.ganaderiaAuth;
      const potrero = await restaurarPotrero(organizacionId, req.params.predioId, req.params.potreroId, { actorCuentaId: cuentaId });
      res.json({ ok: true, potrero });
    } catch (error) {
      if (sendSemanticError(res, error)) return;
      next(error);
    }
  });

  return router;
}
