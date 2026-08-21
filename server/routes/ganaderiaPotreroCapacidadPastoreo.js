// SPRINT-3D7-CAPACIDAD-PASTOREO: backend de capacidad de pastoreo del
// potrero -- ver cálculo actual + historial, previsualizar (no persiste)
// y crear (persiste, histórico -- §3/§5 del sprint) un cálculo. Monta en
// /api/ganaderia/predios/:predioId/potreros/:potreroId/capacidad-pastoreo
// (server/index.js) -- mismo patrón que ganaderiaPotreroFichaProductiva.js.
//
// Regla de oro (§22 del sprint): el cliente NUNCA aporta biomasaFrescaKg/
// materiaSecaTotalKg/materiaSecaUtilizableKg/demandaDiariaLoteKgMs/
// diasOcupacionEstimados/capacidadAnimalesPeriodo/areaHa/fichaId como
// valores autoritativos -- el repositorio siempre recalcula server-side
// sobre la ficha productiva real del potrero.
import { Router } from 'express';
import {
  createRequireGanaderiaSession,
  createRequireGanaderiaCsrf,
} from '../security/ganaderiaSession.js';
import {
  getCapacidadPastoreoByPotrero,
  previewCapacidadPastoreo,
  createCapacidadPastoreo,
} from '../services/ganaderia/potreroCapacidadPastoreoRepository.js';
import {
  MAX_PESO_VIVO_PROMEDIO_KG,
  MAX_NUMERO_ANIMALES,
  MAX_PERIODO_OBJETIVO_DIAS,
  MAX_CONSUMO_PCT_PESO_VIVO,
} from '../services/ganaderia/capacidadPastoreoFormulas.js';

const MAX_OBSERVACIONES_LENGTH = 2000;
const MODO_VALUES = new Set(['dias_ocupacion', 'capacidad_animales']);

function isPredioIdValid(predioId) {
  return /^\d+$/.test(String(predioId));
}

function isPotreroIdValid(potreroId) {
  return /^\d+$/.test(String(potreroId));
}

// -----------------------------------------------------------------------
// Validación de entrada -- §18/§28/§29 del sprint. Nunca
// biomasaFrescaKg/materiaSecaTotalKg/materiaSecaUtilizableKg/
// demandaDiariaLoteKgMs/diasOcupacionEstimados/capacidadAnimalesPeriodo/
// areaHa/fichaId/organizacionId/predioId/potreroId -- esos son siempre
// derivados server-side (§22). El cliente solo aporta los parámetros
// técnicos y los datos de entrada del modo elegido.
// -----------------------------------------------------------------------

function validationError(code, message) {
  return Object.assign(new Error(message), { status: 400, code });
}

function validateModo(rawValue) {
  if (!MODO_VALUES.has(rawValue)) {
    throw validationError('INVALID_MODO', 'modo debe ser "dias_ocupacion" o "capacidad_animales".');
  }
  return rawValue;
}

function validatePositiveNumber(rawValue, { code, max, maxCode, label }) {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw validationError(code, `${label} debe ser un número mayor que 0.`);
  }
  if (max !== undefined && parsed > max) {
    throw validationError(maxCode, `${label} supera el máximo técnico permitido (${max}).`);
  }
  return parsed;
}

function validatePesoVivoPromedioKg(rawValue) {
  return validatePositiveNumber(rawValue, {
    code: 'INVALID_PESO_VIVO',
    max: MAX_PESO_VIVO_PROMEDIO_KG,
    maxCode: 'PESO_VIVO_TOO_HIGH',
    label: 'peso_vivo_promedio_kg',
  });
}

function validatePorcentaje(rawValue, code) {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 100) {
    throw validationError(code, 'El porcentaje debe estar entre 0 (exclusivo) y 100.');
  }
  return parsed;
}

function validateConsumoPctPesoVivo(rawValue) {
  return validatePositiveNumber(rawValue, {
    code: 'INVALID_CONSUMO',
    max: MAX_CONSUMO_PCT_PESO_VIVO,
    maxCode: 'CONSUMO_TOO_HIGH',
    label: 'consumo_pct_peso_vivo',
  });
}

function validateNumeroAnimales(rawValue) {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1) {
    throw validationError('INVALID_NUMERO_ANIMALES', 'numero_animales debe ser un entero >= 1.');
  }
  if (parsed > MAX_NUMERO_ANIMALES) {
    throw validationError('NUMERO_ANIMALES_TOO_HIGH', `numero_animales supera el máximo técnico permitido (${MAX_NUMERO_ANIMALES}).`);
  }
  return parsed;
}

function validatePeriodoObjetivoDias(rawValue) {
  return validatePositiveNumber(rawValue, {
    code: 'INVALID_PERIODO_OBJETIVO',
    max: MAX_PERIODO_OBJETIVO_DIAS,
    maxCode: 'PERIODO_OBJETIVO_TOO_HIGH',
    label: 'periodo_objetivo_dias',
  });
}

function validateObservaciones(rawValue) {
  if (rawValue === undefined || rawValue === null || rawValue === '') return null;
  if (typeof rawValue !== 'string' || rawValue.length > MAX_OBSERVACIONES_LENGTH) {
    throw validationError('INVALID_OBSERVACIONES', `observaciones debe ser texto (máx ${MAX_OBSERVACIONES_LENGTH} caracteres).`);
  }
  return rawValue.trim() || null;
}

// allowObservaciones: solo el endpoint create acepta observaciones -- el
// preview no persiste nada, así que no tiene sentido aceptarlas ahí
// (§21/§22 del sprint).
export function validateCapacidadPastoreoBody(body, { allowObservaciones = false } = {}) {
  const modo = validateModo(body?.modo);

  const allowedKeys = new Set(['modo', 'pesoVivoPromedioKg', 'porcentajeMateriaSeca', 'porcentajeUtilizacion', 'consumoPctPesoVivo']);
  allowedKeys.add(modo === 'dias_ocupacion' ? 'numeroAnimales' : 'periodoObjetivoDias');
  if (allowObservaciones) allowedKeys.add('observaciones');

  const unknownKeys = Object.keys(body || {}).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length > 0) {
    throw validationError('FORBIDDEN_FIELDS', `Campos no permitidos: ${unknownKeys.join(', ')}`);
  }

  const payload = {
    modo,
    pesoVivoPromedioKg: validatePesoVivoPromedioKg(body?.pesoVivoPromedioKg),
    porcentajeMateriaSeca: validatePorcentaje(body?.porcentajeMateriaSeca, 'INVALID_MATERIA_SECA'),
    porcentajeUtilizacion: validatePorcentaje(body?.porcentajeUtilizacion, 'INVALID_UTILIZACION'),
    consumoPctPesoVivo: validateConsumoPctPesoVivo(body?.consumoPctPesoVivo),
  };

  if (modo === 'dias_ocupacion') {
    payload.numeroAnimales = validateNumeroAnimales(body?.numeroAnimales);
  } else {
    payload.periodoObjetivoDias = validatePeriodoObjetivoDias(body?.periodoObjetivoDias);
  }

  if (allowObservaciones) {
    payload.observaciones = validateObservaciones(body?.observaciones);
  }

  return payload;
}

// -----------------------------------------------------------------------
// Manejo compartido de errores semánticos lanzados por el repositorio o
// por las validaciones de arriba.
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

export default function createGanaderiaPotreroCapacidadPastoreoRouter({ appEnv, csrfServerSecret, allowedOrigins } = {}) {
  const router = Router({ mergeParams: true });

  const requireSession = createRequireGanaderiaSession({ appEnv });
  const requireCsrf = createRequireGanaderiaCsrf({ csrfServerSecret, allowedOrigins });

  router.use(requireSession);
  router.use(requireCsrf);

  // GET .../capacidad-pastoreo -- cálculo más reciente + historial
  // resumido (§21/§27). Sin cálculos todavía -> 200 con
  // { actual: null, historial: [] }, nunca 404 (el potrero sí existe).
  router.get('/', async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const { predioId, potreroId } = req.params;
      if (!isPredioIdValid(predioId) || !isPotreroIdValid(potreroId)) {
        res.status(400).json({ error: 'INVALID_POTRERO_ID' });
        return;
      }

      const { organizacionId } = req.ganaderiaAuth;
      const result = await getCapacidadPastoreoByPotrero(organizacionId, predioId, potreroId);
      res.json(result);
    } catch (error) {
      if (sendSemanticError(res, error)) return;
      next(error);
    }
  });

  // POST .../capacidad-pastoreo/preview -- calcula server-side sobre la
  // ficha real, NO persiste (§21/§22).
  router.post('/preview', async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const { predioId, potreroId } = req.params;
      if (!isPredioIdValid(predioId) || !isPotreroIdValid(potreroId)) {
        res.status(400).json({ error: 'INVALID_POTRERO_ID' });
        return;
      }

      const payload = validateCapacidadPastoreoBody(req.body, { allowObservaciones: false });
      const { organizacionId } = req.ganaderiaAuth;

      const preview = await previewCapacidadPastoreo(organizacionId, predioId, potreroId, payload);
      res.json({ ok: true, preview });
    } catch (error) {
      if (sendSemanticError(res, error)) return;
      next(error);
    }
  });

  // POST .../capacidad-pastoreo -- recalcula server-side y persiste un
  // cálculo NUEVO (append, §3/§5).
  router.post('/', async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const { predioId, potreroId } = req.params;
      if (!isPredioIdValid(predioId) || !isPotreroIdValid(potreroId)) {
        res.status(400).json({ error: 'INVALID_POTRERO_ID' });
        return;
      }

      const payload = validateCapacidadPastoreoBody(req.body, { allowObservaciones: true });
      const { organizacionId } = req.ganaderiaAuth;

      const calculo = await createCapacidadPastoreo(organizacionId, predioId, potreroId, payload);
      res.status(201).json({ ok: true, calculo });
    } catch (error) {
      if (sendSemanticError(res, error)) return;
      next(error);
    }
  });

  return router;
}
