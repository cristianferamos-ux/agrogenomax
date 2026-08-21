// SPRINT-3D6-FICHA-PRODUCTIVA: backend de la ficha productiva del potrero
// -- ver detalle (ficha actual + historial resumido) y registrar una
// ficha nueva (append, nunca sobrescribe -- §4 del sprint). Monta en
// /api/ganaderia/predios/:predioId/potreros/:potreroId/ficha-productiva
// (server/index.js) -- deliberadamente separado del router de catálogo
// (ganaderiaCatalogoPasturas.js), que no está subordinado a predio/potrero.
//
// Regla de oro: igual que ganaderiaPotreros.js -- SOLO habla con
// Postgres-AGX-Business vía potreroFichaProductivaRepository.js. El
// tenant (organizacionId) sale exclusivamente de req.ganaderiaAuth. §15:
// area_ha/biomasaTotalKg/tipoCobertura/nombrePrincipal NUNCA se aceptan
// del cliente -- se calculan/derivan siempre en el repositorio.
import { Router } from 'express';
import {
  createRequireGanaderiaSession,
  createRequireGanaderiaCsrf,
} from '../security/ganaderiaSession.js';
import {
  getFichaProductivaByPotrero,
  createFichaProductiva,
  AFORO_MAX_G_M2,
} from '../services/ganaderia/potreroFichaProductivaRepository.js';

const MAX_OBSERVACIONES_LENGTH = 2000;
const MAX_NOMBRE_PERSONALIZADO_LENGTH = 160;
const MAX_ESPECIES_POR_FICHA = 20;
const FECHA_AFORO_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isPredioIdValid(predioId) {
  return /^\d+$/.test(String(predioId));
}

function isPotreroIdValid(potreroId) {
  return /^\d+$/.test(String(potreroId));
}

function isPositiveIntegerId(value) {
  return /^\d+$/.test(String(value));
}

// -----------------------------------------------------------------------
// Validación de entrada -- creación de ficha (§17/§18 del sprint).
// -----------------------------------------------------------------------

// Nunca organizacionId/predioId/potreroId/areaHa/biomasaTotalKg/
// tipoCobertura/nombrePrincipal -- esos son siempre derivados server-side
// (§15). El cliente solo aporta lo que realmente captura en campo.
const CREATE_ALLOWED_KEYS = new Set([
  'especies',
  'aforoPromedioGM2',
  'numeroMuestras',
  'fechaAforo',
  'observaciones',
  'nombrePersonalizado',
]);
const ESPECIE_ALLOWED_KEYS = new Set(['pasturaId', 'porcentajeEstimado']);

function validateEspecies(rawEspecies) {
  if (!Array.isArray(rawEspecies) || rawEspecies.length === 0) {
    throw Object.assign(new Error('Se requiere al menos una especie de pastura.'), {
      status: 400,
      code: 'EMPTY_ESPECIES',
    });
  }
  if (rawEspecies.length > MAX_ESPECIES_POR_FICHA) {
    throw Object.assign(new Error(`Se permiten hasta ${MAX_ESPECIES_POR_FICHA} especies por ficha.`), {
      status: 400,
      code: 'INVALID_ESPECIES',
    });
  }

  return rawEspecies.map((especie) => {
    const unknownKeys = Object.keys(especie || {}).filter((key) => !ESPECIE_ALLOWED_KEYS.has(key));
    if (unknownKeys.length > 0) {
      throw Object.assign(new Error(`Campos no permitidos en especie: ${unknownKeys.join(', ')}`), {
        status: 400,
        code: 'FORBIDDEN_FIELDS',
      });
    }
    if (!isPositiveIntegerId(especie?.pasturaId)) {
      throw Object.assign(new Error('pasturaId inválido.'), { status: 400, code: 'INVALID_ESPECIES' });
    }

    let porcentajeEstimado = null;
    if (especie.porcentajeEstimado !== undefined && especie.porcentajeEstimado !== null && especie.porcentajeEstimado !== '') {
      const parsed = Number(especie.porcentajeEstimado);
      if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 100) {
        throw Object.assign(new Error('porcentajeEstimado debe estar entre 0 (exclusivo) y 100.'), {
          status: 400,
          code: 'INVALID_PORCENTAJE',
        });
      }
      porcentajeEstimado = parsed;
    }

    return { pasturaId: especie.pasturaId, porcentajeEstimado };
  });
}

function validateAforoPromedioGM2(rawValue) {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw Object.assign(new Error('aforoPromedioGM2 debe ser un número mayor que 0.'), {
      status: 400,
      code: 'INVALID_AFORO',
    });
  }
  if (parsed > AFORO_MAX_G_M2) {
    throw Object.assign(new Error(`aforoPromedioGM2 supera el máximo técnico permitido (${AFORO_MAX_G_M2} g/m²).`), {
      status: 400,
      code: 'AFORO_TOO_HIGH',
    });
  }
  return parsed;
}

function validateNumeroMuestras(rawValue) {
  if (rawValue === undefined || rawValue === null || rawValue === '') return null;
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1) {
    throw Object.assign(new Error('numeroMuestras debe ser un entero >= 1.'), {
      status: 400,
      code: 'INVALID_NUMERO_MUESTRAS',
    });
  }
  return parsed;
}

function validateFechaAforo(rawValue) {
  if (rawValue === undefined || rawValue === null || rawValue === '') return null;
  if (typeof rawValue !== 'string' || !FECHA_AFORO_PATTERN.test(rawValue) || Number.isNaN(Date.parse(rawValue))) {
    throw Object.assign(new Error('fechaAforo debe tener formato YYYY-MM-DD.'), {
      status: 400,
      code: 'INVALID_FECHA_AFORO',
    });
  }
  return rawValue;
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

function validateNombrePersonalizado(rawValue) {
  if (rawValue === undefined || rawValue === null || rawValue === '') return null;
  if (typeof rawValue !== 'string' || rawValue.trim().length > MAX_NOMBRE_PERSONALIZADO_LENGTH) {
    throw Object.assign(new Error(`nombrePersonalizado debe ser texto (máx ${MAX_NOMBRE_PERSONALIZADO_LENGTH} caracteres).`), {
      status: 400,
      code: 'INVALID_NOMBRE_PERSONALIZADO',
    });
  }
  return rawValue.trim() || null;
}

export function validateCreateFichaBody(body) {
  const unknownKeys = Object.keys(body || {}).filter((key) => !CREATE_ALLOWED_KEYS.has(key));
  if (unknownKeys.length > 0) {
    throw Object.assign(new Error(`Campos no permitidos: ${unknownKeys.join(', ')}`), {
      status: 400,
      code: 'FORBIDDEN_FIELDS',
    });
  }

  return {
    especies: validateEspecies(body?.especies),
    aforoPromedioGM2: validateAforoPromedioGM2(body?.aforoPromedioGM2),
    numeroMuestras: validateNumeroMuestras(body?.numeroMuestras),
    fechaAforo: validateFechaAforo(body?.fechaAforo),
    observaciones: validateObservaciones(body?.observaciones),
    nombrePersonalizado: validateNombrePersonalizado(body?.nombrePersonalizado),
  };
}

// -----------------------------------------------------------------------
// Manejo compartido de errores semánticos lanzados por el repositorio.
// -----------------------------------------------------------------------

function sendSemanticError(res, error) {
  if (typeof error?.status === 'number' && typeof error?.code === 'string') {
    res.status(error.status).json({ error: error.code, message: error.message });
    return true;
  }
  return false;
}

// -----------------------------------------------------------------------
// Router -- montado con mergeParams para heredar :predioId/:potreroId del
// mount en server/index.js (subordinado a ganaderiaPotreros.js).
// -----------------------------------------------------------------------

export default function createGanaderiaPotreroFichaProductivaRouter({ appEnv, csrfServerSecret, allowedOrigins } = {}) {
  const router = Router({ mergeParams: true });

  const requireSession = createRequireGanaderiaSession({ appEnv });
  const requireCsrf = createRequireGanaderiaCsrf({ csrfServerSecret, allowedOrigins });

  router.use(requireSession);
  router.use(requireCsrf);

  // GET .../ficha-productiva -- ficha actual + historial resumido (§17/§23).
  // Potrero sin ficha -> 200 con { actual: null, historial: [] } (§24),
  // nunca 404 (el potrero sí existe).
  router.get('/', async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const { predioId, potreroId } = req.params;
      if (!isPredioIdValid(predioId) || !isPotreroIdValid(potreroId)) {
        res.status(400).json({ error: 'INVALID_POTRERO_ID' });
        return;
      }

      const { organizacionId } = req.ganaderiaAuth;
      const result = await getFichaProductivaByPotrero(organizacionId, predioId, potreroId);
      res.json(result);
    } catch (error) {
      if (sendSemanticError(res, error)) return;
      next(error);
    }
  });

  // POST .../ficha-productiva -- registra una ficha NUEVA (append, §4).
  router.post('/', async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const { predioId, potreroId } = req.params;
      if (!isPredioIdValid(predioId) || !isPotreroIdValid(potreroId)) {
        res.status(400).json({ error: 'INVALID_POTRERO_ID' });
        return;
      }

      const payload = validateCreateFichaBody(req.body);
      const { organizacionId } = req.ganaderiaAuth;

      const ficha = await createFichaProductiva(organizacionId, predioId, potreroId, payload);
      res.status(201).json({ ok: true, ficha });
    } catch (error) {
      if (sendSemanticError(res, error)) return;
      next(error);
    }
  });

  return router;
}
