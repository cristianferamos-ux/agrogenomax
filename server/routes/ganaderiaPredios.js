// SPRINT-3C1-MIS-PREDIOS-API: backend de "Mis Predios" -- listar, ver
// detalle, buscar por coordenadas/código vía el motor interno de
// CatastroX, y registrar un predio (automático confirmado por CatastroX,
// o manual). Monta en /api/ganaderia/predios (server/index.js) --
// deliberadamente separado de la ruta legacy /api/predios (sin
// aislamiento por organización, Postgres legacy, no se toca en este
// sprint).
//
// Regla de oro (§1 del pedido): esta ruta SOLO habla con
// Postgres-AGX-Business, exclusivamente vía agxBusinessPool.js /
// withOrganizacionTransaction. Nunca importa server/db.js ni
// DATABASE_URL. El tenant (organizacionId) sale exclusivamente de
// req.ganaderiaAuth, resuelto server-side por createRequireGanaderiaSession
// contra Postgres-AGX (agx.fn_resolver_autorizacion_sesion) -- jamás de
// body/query/header (§2).
import { Router } from 'express';
import {
  createRequireGanaderiaSession,
  createRequireGanaderiaCsrf,
} from '../security/ganaderiaSession.js';
import { prediosSearchLimiter } from '../middleware/rateLimit.js';
import {
  lookupPredioPorCoordenadas,
  lookupPredioPorCodigo,
} from '../services/catastroxPredioLookup.js';
import {
  createPredioCandidate,
  reservePredioCandidate,
  commitPredioCandidate,
  releasePredioCandidate,
} from '../services/ganaderia/prediosCandidateStore.js';
import {
  listPredios,
  getPredioDetail,
  createManualPredio,
  createCatastroxPredio,
} from '../services/ganaderia/prediosRepository.js';

const MAX_NOMBRE_PREDIO_LENGTH = 200;
const MAX_TEXT_FIELD_LENGTH = 120;
const DEFAULT_NOMBRE_PREDIO = 'Predio sin nombre';

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

// -----------------------------------------------------------------------
// Validación de entrada
// -----------------------------------------------------------------------

export function validateCoordinatesBody(body) {
  const lat = Number(body?.lat);
  const lng = Number(body?.lng);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw Object.assign(new Error('lat/lng deben ser números finitos.'), {
      status: 400,
      code: 'INVALID_COORDINATES',
    });
  }
  if (lat < -90 || lat > 90) {
    throw Object.assign(new Error('lat debe estar entre -90 y 90.'), {
      status: 400,
      code: 'INVALID_COORDINATES',
    });
  }
  if (lng < -180 || lng > 180) {
    throw Object.assign(new Error('lng debe estar entre -180 y 180.'), {
      status: 400,
      code: 'INVALID_COORDINATES',
    });
  }

  return { lat, lng };
}

// §16: manual mode -- allowlist estricta, rechaza explícitamente
// cualquier campo prohibido (geometry, codigo_predial, organizacion_id,
// etc.) en vez de ignorarlo silenciosamente.
const MANUAL_ALLOWED_KEYS = new Set([
  'mode',
  'nombrePredio',
  'departamento',
  'municipio',
  'vereda',
  'areaTotalHa',
  'latitud',
  'longitud',
]);

export function validateManualPredioBody(body) {
  const unknownKeys = Object.keys(body || {}).filter((key) => !MANUAL_ALLOWED_KEYS.has(key));
  if (unknownKeys.length > 0) {
    throw Object.assign(new Error(`Campos no permitidos: ${unknownKeys.join(', ')}`), {
      status: 400,
      code: 'FORBIDDEN_FIELDS',
    });
  }

  if (!isNonEmptyString(body.nombrePredio) || body.nombrePredio.trim().length > MAX_NOMBRE_PREDIO_LENGTH) {
    throw Object.assign(new Error('nombrePredio es obligatorio (máx 200 caracteres).'), {
      status: 400,
      code: 'INVALID_NOMBRE_PREDIO',
    });
  }
  if (!isNonEmptyString(body.departamento) || body.departamento.trim().length > MAX_TEXT_FIELD_LENGTH) {
    throw Object.assign(new Error('departamento es obligatorio.'), {
      status: 400,
      code: 'INVALID_DEPARTAMENTO',
    });
  }
  if (!isNonEmptyString(body.municipio) || body.municipio.trim().length > MAX_TEXT_FIELD_LENGTH) {
    throw Object.assign(new Error('municipio es obligatorio.'), {
      status: 400,
      code: 'INVALID_MUNICIPIO',
    });
  }

  const vereda = body.vereda === undefined || body.vereda === null ? null : String(body.vereda).trim().slice(0, MAX_TEXT_FIELD_LENGTH) || null;

  let areaTotalHa = null;
  if (body.areaTotalHa !== undefined && body.areaTotalHa !== null && body.areaTotalHa !== '') {
    const parsed = Number(body.areaTotalHa);
    if (!isFiniteNumber(parsed) || parsed <= 0) {
      throw Object.assign(new Error('areaTotalHa debe ser un número positivo.'), {
        status: 400,
        code: 'INVALID_AREA_TOTAL_HA',
      });
    }
    areaTotalHa = parsed;
  }

  let latitud = null;
  let longitud = null;
  if (body.latitud !== undefined && body.latitud !== null && body.latitud !== '') {
    latitud = Number(body.latitud);
    if (!isFiniteNumber(latitud) || latitud < -90 || latitud > 90) {
      throw Object.assign(new Error('latitud inválida.'), { status: 400, code: 'INVALID_LATITUD' });
    }
  }
  if (body.longitud !== undefined && body.longitud !== null && body.longitud !== '') {
    longitud = Number(body.longitud);
    if (!isFiniteNumber(longitud) || longitud < -180 || longitud > 180) {
      throw Object.assign(new Error('longitud inválida.'), { status: 400, code: 'INVALID_LONGITUD' });
    }
  }

  return {
    nombrePredio: body.nombrePredio.trim(),
    departamento: body.departamento.trim(),
    municipio: body.municipio.trim(),
    vereda,
    areaTotalHa,
    latitud,
    longitud,
  };
}

// §12: modo automático -- allowlist igualmente estricta. candidateId es
// la ÚNICA fuente de geometry/codigoPredial/areaCatastral/fuente; el
// cuerpo nunca puede aportarlos (§12 explícito).
const CATASTROX_ALLOWED_KEYS = new Set(['mode', 'candidateId', 'nombrePersonalizado']);

export function validateCatastroxSaveBody(body) {
  const unknownKeys = Object.keys(body || {}).filter((key) => !CATASTROX_ALLOWED_KEYS.has(key));
  if (unknownKeys.length > 0) {
    throw Object.assign(new Error(`Campos no permitidos: ${unknownKeys.join(', ')}`), {
      status: 400,
      code: 'FORBIDDEN_FIELDS',
    });
  }

  if (!isNonEmptyString(body.candidateId)) {
    throw Object.assign(new Error('candidateId es obligatorio.'), { status: 400, code: 'INVALID_CANDIDATE_ID' });
  }

  let nombrePersonalizado = null;
  if (body.nombrePersonalizado !== undefined && body.nombrePersonalizado !== null && body.nombrePersonalizado !== '') {
    if (typeof body.nombrePersonalizado !== 'string' || body.nombrePersonalizado.trim().length > MAX_NOMBRE_PREDIO_LENGTH) {
      throw Object.assign(new Error('nombrePersonalizado inválido.'), {
        status: 400,
        code: 'INVALID_NOMBRE_PERSONALIZADO',
      });
    }
    nombrePersonalizado = body.nombrePersonalizado.trim();
  }

  return { candidateId: body.candidateId, nombrePersonalizado };
}

// -----------------------------------------------------------------------
// Serialización DB -> API (§3: nunca exponer organizacion_id/WKT/SRID)
// -----------------------------------------------------------------------

function serializePredioListItem(row) {
  return {
    predioId: String(row.predio_id),
    nombrePredio: row.nombre_predio,
    departamento: row.departamento,
    municipio: row.municipio,
    vereda: row.vereda,
    areaTotalHa: row.area_total_ha === null ? null : Number(row.area_total_ha),
    codigoPredial: row.codigo_predial,
    latitud: row.latitud === null ? null : Number(row.latitud),
    longitud: row.longitud === null ? null : Number(row.longitud),
    tieneGeometria: Boolean(row.tiene_geometria),
    fechaCreacion: row.fecha_creacion,
  };
}

function serializeSnapshot(row) {
  if (!row) return null;
  return {
    codigoPredial: row.codigo_predial,
    codigoAnterior: row.codigo_anterior,
    nombrePredioCatastral: row.nombre_predio_catastral,
    departamento: row.departamento,
    municipio: row.municipio,
    vereda: row.vereda,
    sector: row.sector,
    areaM2: row.area_m2 === null ? null : Number(row.area_m2),
    areaHa: row.area_ha === null ? null : Number(row.area_ha),
    geometry: row.geometry,
    fuente: row.fuente,
    versionFuente: row.version_fuente,
    fechaConsulta: row.fecha_consulta,
  };
}

function serializePredioDetail(row, snapshotRow) {
  return {
    predioId: String(row.predio_id),
    nombrePredio: row.nombre_predio,
    propietario: row.propietario,
    departamento: row.departamento,
    municipio: row.municipio,
    vereda: row.vereda,
    areaTotalHa: row.area_total_ha === null ? null : Number(row.area_total_ha),
    codigoPredial: row.codigo_predial,
    latitud: row.latitud === null ? null : Number(row.latitud),
    longitud: row.longitud === null ? null : Number(row.longitud),
    geometry: row.geometry,
    fechaCreacion: row.fecha_creacion,
    fechaActualizacion: row.fecha_actualizacion,
    snapshotCatastral: serializeSnapshot(snapshotRow),
  };
}

// -----------------------------------------------------------------------
// Router
// -----------------------------------------------------------------------

export default function createGanaderiaPrediosRouter({ appEnv, csrfServerSecret, allowedOrigins } = {}) {
  const router = Router();

  const requireSession = createRequireGanaderiaSession({ appEnv });
  const requireCsrf = createRequireGanaderiaCsrf({ csrfServerSecret, allowedOrigins });

  // §2: toda la superficie de este router exige identidad + organización
  // activa resuelta server-side, y CSRF en toda mutación (GET/HEAD/OPTIONS
  // pasan libres dentro de createRequireGanaderiaCsrf).
  router.use(requireSession);
  router.use(requireCsrf);

  // §3: GET /api/ganaderia/predios
  router.get('/', async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const { organizacionId } = req.ganaderiaAuth;
      const rows = await listPredios(organizacionId);
      res.json({ predios: rows.map(serializePredioListItem) });
    } catch (error) {
      next(error);
    }
  });

  // §4: GET /api/ganaderia/predios/:predioId
  router.get('/:predioId', async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (!/^\d+$/.test(String(req.params.predioId))) {
        res.status(400).json({ error: 'INVALID_PREDIO_ID' });
        return;
      }

      const { organizacionId } = req.ganaderiaAuth;
      const detail = await getPredioDetail(organizacionId, req.params.predioId);

      if (!detail) {
        res.status(404).json({ error: 'PREDIO_NOT_FOUND' });
        return;
      }

      res.json(serializePredioDetail(detail.predioRow, detail.snapshotRow));
    } catch (error) {
      next(error);
    }
  });

  // §6: POST /api/ganaderia/predios/buscar-por-coordenadas
  router.post('/buscar-por-coordenadas', prediosSearchLimiter, async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const { lat, lng } = validateCoordinatesBody(req.body);
      const result = await lookupPredioPorCoordenadas(lat, lng);

      if (result.outcome === 'ambiguous') {
        res.status(409).json({
          error: 'REQUIRES_TECHNICAL_VALIDATION',
          message: 'No pudimos identificar un único predio para este punto.',
        });
        return;
      }
      if (result.outcome === 'not_found') {
        res.status(404).json({ error: 'PREDIO_NOT_FOUND' });
        return;
      }

      const { organizacionId, cuentaId } = req.ganaderiaAuth;
      const candidateId = createPredioCandidate({ organizacionId, cuentaId, predio: result.predio });
      res.json({ candidateId, predio: result.predio });
    } catch (error) {
      if (error?.code === 'INVALID_COORDINATES') {
        res.status(400).json({ error: error.code, message: error.message });
        return;
      }
      next(error);
    }
  });

  // §7: POST /api/ganaderia/predios/buscar-por-codigo
  router.post('/buscar-por-codigo', prediosSearchLimiter, async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const result = await lookupPredioPorCodigo(req.body?.codigo);

      if (result.outcome === 'ambiguous') {
        res.status(409).json({
          error: 'REQUIRES_TECHNICAL_VALIDATION',
          message: 'No pudimos identificar un único predio para este número predial.',
        });
        return;
      }
      if (result.outcome === 'not_found') {
        res.status(404).json({ error: 'PREDIO_NOT_FOUND' });
        return;
      }

      const { organizacionId, cuentaId } = req.ganaderiaAuth;
      const candidateId = createPredioCandidate({ organizacionId, cuentaId, predio: result.predio });
      res.json({ candidateId, predio: result.predio });
    } catch (error) {
      if (error?.publicCode === 'INVALID_CADASTRAL_CODE') {
        res.status(400).json({ error: 'INVALID_CADASTRAL_CODE', message: error.publicMessage });
        return;
      }
      next(error);
    }
  });

  // §12/§16: POST /api/ganaderia/predios -- crear predio (automático o manual)
  router.post('/', async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const mode = req.body?.mode;
      if (mode !== 'catastrox' && mode !== 'manual') {
        res.status(400).json({ error: 'INVALID_MODE', message: 'mode debe ser "catastrox" o "manual".' });
        return;
      }

      const { organizacionId, cuentaId } = req.ganaderiaAuth;

      if (mode === 'manual') {
        const value = validateManualPredioBody(req.body);
        const predioId = await createManualPredio(organizacionId, value);
        res.status(201).json({ ok: true, predioId: String(predioId), mode: 'manual' });
        return;
      }

      // mode === 'catastrox'
      const { candidateId, nombrePersonalizado } = validateCatastroxSaveBody(req.body);

      // SPRINT-3C1.1 §1: reserve() ANTES de la transacción de negocio --
      // pasa a PROCESSING, nunca CONSUMED todavía. Una segunda solicitud
      // concurrente sobre el mismo candidateId ve 'in_use' mientras esta
      // transacción está en curso.
      const reservation = reservePredioCandidate({ candidateId, organizacionId, cuentaId });

      if (reservation.status === 'expired') {
        res.status(410).json({ error: 'CANDIDATE_EXPIRED', message: 'La búsqueda expiró. Vuelve a buscar el predio.' });
        return;
      }
      if (reservation.status === 'consumed') {
        res.status(409).json({ error: 'CANDIDATE_ALREADY_CONSUMED', message: 'Este resultado ya fue utilizado.' });
        return;
      }
      if (reservation.status === 'in_use') {
        res.status(409).json({ error: 'CANDIDATE_IN_USE', message: 'Esta búsqueda ya se está procesando. Espera un momento.' });
        return;
      }
      if (reservation.status === 'not_found' || reservation.status === 'forbidden') {
        // §10: nunca distinguir "no existe" de "pertenece a otra
        // organización/cuenta" en la respuesta.
        res.status(404).json({ error: 'CANDIDATE_NOT_FOUND', message: 'La búsqueda no es válida. Vuelve a intentarlo.' });
        return;
      }

      const { predio } = reservation;
      const nombreFinal = nombrePersonalizado || predio.nombrePredio || DEFAULT_NOMBRE_PREDIO;
      const geometryJson = JSON.stringify(predio.geometry);

      // SPRINT-3C1.1 §2: commit() SOLO tras COMMIT real de la transacción
      // de negocio; cualquier fallo (incluido el 23505 de duplicado)
      // libera el candidate de vuelta a AVAILABLE -- nunca queda
      // CONSUMED sin que el predio exista de verdad.
      let predioId;
      try {
        predioId = await createCatastroxPredio(organizacionId, { nombreFinal, predio, geometryJson });
      } catch (transactionError) {
        releasePredioCandidate(candidateId);
        throw transactionError;
      }
      commitPredioCandidate(candidateId);

      res.status(201).json({ ok: true, predioId: String(predioId), mode: 'catastrox' });
    } catch (error) {
      if (error?.code === 'DUPLICATE_CODIGO_PREDIAL') {
        res.status(409).json({ error: 'DUPLICATE_CODIGO_PREDIAL', message: 'Este predio ya está registrado en tu cuenta.' });
        return;
      }
      if (error?.status === 400) {
        res.status(400).json({ error: error.code, message: error.message });
        return;
      }
      next(error);
    }
  });

  return router;
}
