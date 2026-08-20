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
import { Router } from 'express';
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
  createPotreroFromCandidate,
} from '../services/ganaderia/potrerosRepository.js';
import {
  createPotreroCandidate,
  reservePotreroCandidate,
  commitPotreroCandidate,
  releasePotreroCandidate,
} from '../services/ganaderia/potrerosCandidateStore.js';

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
      const rows = await listPotrerosByPredio(organizacionId, predioId);
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
      const { geometry, areaHa } = await computePotreroPreview(organizacionId, predioId, wkt);

      const candidateId = createPotreroCandidate({
        organizacionId,
        cuentaId,
        predioId,
        geometry,
        areaHa,
        metodoDelimitacion: 'coordenadas',
      });

      res.json({ candidateId, preview: { areaHa, metodoDelimitacion: 'coordenadas', geometry } });
    } catch (error) {
      if (sendSemanticError(res, error)) return;
      next(error);
    }
  });

  // §14: POST /api/ganaderia/predios/:predioId/potreros/preview-gps --
  // mismo contrato geométrico exacto que preview-coordinates (misma
  // validación server-side: cierre de anillo, ST_IsValid, ST_CoveredBy,
  // ST_Area), única diferencia es metodoDelimitacion='gps_movil'. No se
  // introduce precisión GPS catastral ni lógica adicional -- el frontend
  // GPS (watchPosition) queda fuera de alcance de este sprint (§14).
  router.post('/preview-gps', potrerosPreviewLimiter, async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const { predioId } = req.params;
      if (!isPredioIdValid(predioId)) {
        res.status(400).json({ error: 'INVALID_PREDIO_ID' });
        return;
      }

      const wkt = validatePreviewBody(req.body);
      const { organizacionId, cuentaId } = req.ganaderiaAuth;
      const { geometry, areaHa } = await computePotreroPreview(organizacionId, predioId, wkt);

      const candidateId = createPotreroCandidate({
        organizacionId,
        cuentaId,
        predioId,
        geometry,
        areaHa,
        metodoDelimitacion: 'gps_movil',
      });

      res.json({ candidateId, preview: { areaHa, metodoDelimitacion: 'gps_movil', geometry } });
    } catch (error) {
      if (sendSemanticError(res, error)) return;
      next(error);
    }
  });

  // §15: POST .../preview-file (KML/KMZ) -- DELIBERADAMENTE NO
  // implementado en este sprint (3D3). Requiere @tmcw/togeojson +
  // @xmldom/xmldom + jszip, ninguna instalada todavía (auditado, ver
  // handoff). No se monta ninguna ruta para evitar una implementación
  // parcial insegura -- queda documentado como alcance de 3D4.

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

  return router;
}
