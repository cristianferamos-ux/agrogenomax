// SPRINT-3D8-DESCANSO-REENTRADA: backend del motor de descanso y
// reentrada -- ver recomendación actual + historial, previsualizar (no
// persiste) y crear (persiste, histórico) una recomendación de descanso.
// Monta en /api/ganaderia/predios/:predioId/potreros/:potreroId/
// descanso-reentrada (server/index.js) -- mismo patrón que
// ganaderiaPotreroRecomendacionPastoreo.js.
//
// Regla de oro (§2 del sprint): el cliente NUNCA aporta ficha_id/
// contexto_id/recomendacion_pastoreo_id/resultados/organizacionId como
// valores autoritativos -- el repositorio siempre recalcula server-side
// sobre la última recomendación de pastoreo guardada + la ficha real +
// el contexto agroclimático más reciente. El ÚNICO input del cliente es
// fechaInicioPastoreo (§11/§12/§19 del sprint).
import { Router } from 'express';
import {
  createRequireGanaderiaSession,
  createRequireGanaderiaCsrf,
} from '../security/ganaderiaSession.js';
import {
  getDescansoReentradaByPotrero,
  previewDescansoReentrada,
  createDescansoReentrada,
} from '../services/ganaderia/potreroDescansoRepository.js';

const FECHA_ISO_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// Date.parse/new Date() NORMALIZAN fechas de calendario inválidas (p.ej.
// "2026-02-30" se convierte silenciosamente en 2026-03-02) en vez de
// rechazarlas -- se valida reconstruyendo la fecha en UTC y comparando
// que el resultado sea EXACTAMENTE la cadena recibida.
function esFechaIsoCalendarioValido(fechaIso) {
  const [anio, mes, dia] = fechaIso.split('-').map(Number);
  const timestamp = Date.UTC(anio, mes - 1, dia);
  const reconstruida = new Date(timestamp);
  return (
    reconstruida.getUTCFullYear() === anio
    && reconstruida.getUTCMonth() === mes - 1
    && reconstruida.getUTCDate() === dia
  );
}

function isPredioIdValid(predioId) {
  return /^\d+$/.test(String(predioId));
}

function isPotreroIdValid(potreroId) {
  return /^\d+$/.test(String(potreroId));
}

function validationError(code, message) {
  return Object.assign(new Error(message), { status: 400, code });
}

const ALLOWED_KEYS = new Set(['fechaInicioPastoreo']);

// §11/§12 del sprint: ÚNICO input del cliente -- nunca ficha_id/
// contexto_id/recomendacion_pastoreo_id/resultados (siempre derivados
// server-side).
export function validateDescansoReentradaBody(body) {
  const unknownKeys = Object.keys(body || {}).filter((key) => !ALLOWED_KEYS.has(key));
  if (unknownKeys.length > 0) {
    throw validationError('FORBIDDEN_FIELDS', `Campos no permitidos: ${unknownKeys.join(', ')}`);
  }

  const fechaInicioPastoreo = body?.fechaInicioPastoreo;
  if (typeof fechaInicioPastoreo !== 'string' || !FECHA_ISO_PATTERN.test(fechaInicioPastoreo)) {
    throw validationError('INVALID_FECHA_INICIO_PASTOREO', 'fechaInicioPastoreo debe tener formato YYYY-MM-DD.');
  }
  if (!esFechaIsoCalendarioValido(fechaInicioPastoreo)) {
    throw validationError('INVALID_FECHA_INICIO_PASTOREO', 'fechaInicioPastoreo no es una fecha válida.');
  }

  return { fechaInicioPastoreo };
}

function sendSemanticError(res, error) {
  if (typeof error?.status === 'number' && typeof error?.code === 'string') {
    res.status(error.status).json({ error: error.code, message: error.message });
    return true;
  }
  return false;
}

// Router -- montado con mergeParams para heredar :predioId/:potreroId del
// mount en server/index.js.
export default function createGanaderiaPotreroDescansoReentradaRouter({ appEnv, csrfServerSecret, allowedOrigins } = {}) {
  const router = Router({ mergeParams: true });

  const requireSession = createRequireGanaderiaSession({ appEnv });
  const requireCsrf = createRequireGanaderiaCsrf({ csrfServerSecret, allowedOrigins });

  router.use(requireSession);
  router.use(requireCsrf);

  // GET .../descanso-reentrada -- recomendación de descanso más reciente +
  // historial resumido. Sin recomendaciones todavía -> 200 con
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
      const result = await getDescansoReentradaByPotrero(organizacionId, predioId, potreroId);
      res.json(result);
    } catch (error) {
      if (sendSemanticError(res, error)) return;
      next(error);
    }
  });

  // POST .../descanso-reentrada/preview -- calcula server-side sobre la
  // última recomendación de pastoreo guardada + ficha + contexto más
  // reciente, NO persiste.
  router.post('/preview', async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const { predioId, potreroId } = req.params;
      if (!isPredioIdValid(predioId) || !isPotreroIdValid(potreroId)) {
        res.status(400).json({ error: 'INVALID_POTRERO_ID' });
        return;
      }

      const payload = validateDescansoReentradaBody(req.body);
      const { organizacionId } = req.ganaderiaAuth;

      const preview = await previewDescansoReentrada(organizacionId, predioId, potreroId, payload);
      res.json({ ok: true, preview });
    } catch (error) {
      if (sendSemanticError(res, error)) return;
      next(error);
    }
  });

  // POST .../descanso-reentrada -- recalcula server-side y persiste una
  // recomendación de descanso NUEVA (append, nunca sobrescribe una anterior).
  router.post('/', async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const { predioId, potreroId } = req.params;
      if (!isPredioIdValid(predioId) || !isPotreroIdValid(potreroId)) {
        res.status(400).json({ error: 'INVALID_POTRERO_ID' });
        return;
      }

      const payload = validateDescansoReentradaBody(req.body);
      const { organizacionId } = req.ganaderiaAuth;

      const descanso = await createDescansoReentrada(organizacionId, predioId, potreroId, payload);
      res.status(201).json({ ok: true, descanso });
    } catch (error) {
      if (sendSemanticError(res, error)) return;
      next(error);
    }
  });

  return router;
}
