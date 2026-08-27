// SPRINT-3D9.1 -- CICLO REAL DE PASTOREO
//
// Monta en /api/ganaderia/predios/:predioId/potreros/:potreroId/
// ciclos-pastoreo (server/index.js) -- mismo patrón que
// ganaderiaPotreroDescansoReentrada.js.
//
// Regla de oro: el cliente NUNCA aporta fechas -- fecha_ingreso_real y
// fecha_salida_real se resuelven SIEMPRE server-side (America/Bogota, ver
// businessTimezone.js). El único input real del cliente es, como mucho,
// un ajuste del lote (numeroAnimales/pesoPromedioKg/categoriaCodigo) al
// iniciar, y el motivo obligatorio al cancelar.
import { Router } from 'express';
import {
  createRequireGanaderiaSession,
  createRequireGanaderiaCsrf,
} from '../security/ganaderiaSession.js';
import {
  iniciarCicloPastoreo,
  finalizarCicloPastoreo,
  cancelarCicloPastoreo,
  getCicloActual,
  getCicloHistorial,
} from '../services/ganaderia/potreroCicloPastoreoRepository.js';

function isPredioIdValid(predioId) {
  return /^\d+$/.test(String(predioId));
}

function isPotreroIdValid(potreroId) {
  return /^\d+$/.test(String(potreroId));
}

function isCicloIdValid(cicloId) {
  return /^\d+$/.test(String(cicloId));
}

function validationError(code, message) {
  return Object.assign(new Error(message), { status: 400, code });
}

const ALLOWED_KEYS_INICIAR = new Set(['numeroAnimales', 'pesoPromedioKg', 'categoriaCodigo']);
const ALLOWED_KEYS_CANCELAR = new Set(['motivo']);

// Nunca fechas del cliente -- solo el ajuste opcional del lote real.
export function validateIniciarBody(body) {
  const unknownKeys = Object.keys(body || {}).filter((key) => !ALLOWED_KEYS_INICIAR.has(key));
  if (unknownKeys.length > 0) {
    throw validationError('FORBIDDEN_FIELDS', `Campos no permitidos: ${unknownKeys.join(', ')}`);
  }
  const { numeroAnimales, pesoPromedioKg, categoriaCodigo } = body || {};
  if (numeroAnimales !== undefined && typeof numeroAnimales !== 'number') {
    throw validationError('INVALID_NUMERO_ANIMALES_REAL', 'numeroAnimales debe ser numérico.');
  }
  if (pesoPromedioKg !== undefined && typeof pesoPromedioKg !== 'number') {
    throw validationError('INVALID_PESO_PROMEDIO_REAL', 'pesoPromedioKg debe ser numérico.');
  }
  if (categoriaCodigo !== undefined && typeof categoriaCodigo !== 'string') {
    throw validationError('INVALID_CATEGORIA_CODIGO', 'categoriaCodigo debe ser texto.');
  }
  return { numeroAnimales, pesoPromedioKg, categoriaCodigo };
}

export function validateCancelarBody(body) {
  const unknownKeys = Object.keys(body || {}).filter((key) => !ALLOWED_KEYS_CANCELAR.has(key));
  if (unknownKeys.length > 0) {
    throw validationError('FORBIDDEN_FIELDS', `Campos no permitidos: ${unknownKeys.join(', ')}`);
  }
  const motivo = body?.motivo;
  if (typeof motivo !== 'string' || motivo.trim() === '') {
    throw validationError('INVALID_MOTIVO_CANCELACION', 'motivo es obligatorio para cancelar un ciclo.');
  }
  return { motivo };
}

function sendSemanticError(res, error) {
  if (typeof error?.status === 'number' && typeof error?.code === 'string') {
    res.status(error.status).json({ error: error.code, message: error.message });
    return true;
  }
  return false;
}

export default function createGanaderiaPotreroCicloPastoreoRouter({ appEnv, csrfServerSecret, allowedOrigins } = {}) {
  const router = Router({ mergeParams: true });

  const requireSession = createRequireGanaderiaSession({ appEnv });
  const requireCsrf = createRequireGanaderiaCsrf({ csrfServerSecret, allowedOrigins });

  router.use(requireSession);
  router.use(requireCsrf);

  // GET .../ciclos-pastoreo/actual -- ciclo EN_CURSO, o { actual: null }.
  // Estrictamente read-only -- nunca dispara Iniciar/Finalizar.
  router.get('/actual', async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const { predioId, potreroId } = req.params;
      if (!isPredioIdValid(predioId) || !isPotreroIdValid(potreroId)) {
        res.status(400).json({ error: 'INVALID_POTRERO_ID' });
        return;
      }
      const { organizacionId } = req.ganaderiaAuth;
      const actual = await getCicloActual(organizacionId, predioId, potreroId);
      res.json({ actual });
    } catch (error) {
      if (sendSemanticError(res, error)) return;
      next(error);
    }
  });

  // GET .../ciclos-pastoreo/historial -- ciclos FINALIZADO/CANCELADO.
  router.get('/historial', async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const { predioId, potreroId } = req.params;
      if (!isPredioIdValid(predioId) || !isPotreroIdValid(potreroId)) {
        res.status(400).json({ error: 'INVALID_POTRERO_ID' });
        return;
      }
      const { organizacionId } = req.ganaderiaAuth;
      const historial = await getCicloHistorial(organizacionId, predioId, potreroId);
      res.json({ historial });
    } catch (error) {
      if (sendSemanticError(res, error)) return;
      next(error);
    }
  });

  // POST .../ciclos-pastoreo/iniciar -- crea el ciclo (EN_CURSO) + evento
  // PASTOREO_INICIADO. Doble clic/requests concurrentes -> 409
  // CICLO_ALREADY_IN_PROGRESS (garantía DB, índice único parcial).
  router.post('/iniciar', async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const { predioId, potreroId } = req.params;
      if (!isPredioIdValid(predioId) || !isPotreroIdValid(potreroId)) {
        res.status(400).json({ error: 'INVALID_POTRERO_ID' });
        return;
      }
      const payload = validateIniciarBody(req.body);
      const { organizacionId, cuentaId } = req.ganaderiaAuth;

      const ciclo = await iniciarCicloPastoreo(organizacionId, predioId, potreroId, {
        ...payload, actorCuentaId: cuentaId,
      });
      res.status(201).json({ ok: true, ciclo });
    } catch (error) {
      if (sendSemanticError(res, error)) return;
      next(error);
    }
  });

  // POST .../ciclos-pastoreo/:cicloId/finalizar -- FASE A (crítica) +
  // FASE B (best-effort, descanso post-real). Idempotente: reintentar
  // sobre un ciclo ya FINALIZADO nunca duplica la transición, solo
  // reintenta el descanso si quedó PENDIENTE/ERROR_TECNICO. Siempre 200
  // si el ciclo existe y no está CANCELADO -- un descanso pendiente NUNCA
  // es un error HTTP (el hecho real ya es un éxito irrevocable).
  router.post('/:cicloId/finalizar', async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const { predioId, potreroId, cicloId } = req.params;
      if (!isPredioIdValid(predioId) || !isPotreroIdValid(potreroId) || !isCicloIdValid(cicloId)) {
        res.status(400).json({ error: 'INVALID_POTRERO_ID' });
        return;
      }
      const { organizacionId, cuentaId } = req.ganaderiaAuth;

      const resultado = await finalizarCicloPastoreo(organizacionId, predioId, potreroId, cicloId, {
        actorCuentaId: cuentaId,
      });
      res.json({ ok: true, ...resultado });
    } catch (error) {
      if (sendSemanticError(res, error)) return;
      next(error);
    }
  });

  // POST .../ciclos-pastoreo/:cicloId/cancelar -- solo EN_CURSO ->
  // CANCELADO. Motivo obligatorio. Nunca DELETE.
  router.post('/:cicloId/cancelar', async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const { predioId, potreroId, cicloId } = req.params;
      if (!isPredioIdValid(predioId) || !isPotreroIdValid(potreroId) || !isCicloIdValid(cicloId)) {
        res.status(400).json({ error: 'INVALID_POTRERO_ID' });
        return;
      }
      const payload = validateCancelarBody(req.body);
      const { organizacionId, cuentaId } = req.ganaderiaAuth;

      const ciclo = await cancelarCicloPastoreo(organizacionId, predioId, potreroId, cicloId, {
        ...payload, actorCuentaId: cuentaId,
      });
      res.json({ ok: true, ciclo });
    } catch (error) {
      if (sendSemanticError(res, error)) return;
      next(error);
    }
  });

  return router;
}
