// SPRINT-3D7.1-AGROCLIMA: backend del contexto agroclimático territorial
// del potrero -- ver snapshot actual + historial resumido, y refrescar
// (consulta proveedores externos, persiste histórico). Monta en
// /api/ganaderia/predios/:predioId/potreros/:potreroId/contexto-agroclimatico
// (server/index.js) -- mismo patrón que ganaderiaPotreroCapacidadPastoreo.js.
//
// §12 del sprint: ninguna de las dos rutas acepta lat/lng/organizacionId/
// predioId/potreroId del body -- todo se resuelve server-side. POST
// refresh no tiene body de entrada en absoluto.
import { Router } from 'express';
import {
  createRequireGanaderiaSession,
  createRequireGanaderiaCsrf,
} from '../security/ganaderiaSession.js';
import {
  getContextoAgroclimatico,
  refreshContextoAgroclimatico,
} from '../services/ganaderia/agroClimateContextRepository.js';

function isPredioIdValid(predioId) {
  return /^\d+$/.test(String(predioId));
}

function isPotreroIdValid(potreroId) {
  return /^\d+$/.test(String(potreroId));
}

function sendSemanticError(res, error) {
  if (typeof error?.status === 'number' && typeof error?.code === 'string') {
    res.status(error.status).json({ error: error.code, message: error.message });
    return true;
  }
  return false;
}

export default function createGanaderiaPotreroContextoAgroclimaticoRouter({ appEnv, csrfServerSecret, allowedOrigins } = {}) {
  const router = Router({ mergeParams: true });

  const requireSession = createRequireGanaderiaSession({ appEnv });
  const requireCsrf = createRequireGanaderiaCsrf({ csrfServerSecret, allowedOrigins });

  router.use(requireSession);
  router.use(requireCsrf);

  // GET .../contexto-agroclimatico -- snapshot más reciente + historial
  // resumido (§9/§12/§13 del sprint). Sin snapshots todavía -> 200 con
  // { actual: null, historial: [] }, nunca 404 (el potrero sí existe).
  // SIEMPRE lee de DB -- nunca consulta proveedores externos.
  router.get('/', async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const { predioId, potreroId } = req.params;
      if (!isPredioIdValid(predioId) || !isPotreroIdValid(potreroId)) {
        res.status(400).json({ error: 'INVALID_POTRERO_ID' });
        return;
      }

      const { organizacionId } = req.ganaderiaAuth;
      const result = await getContextoAgroclimatico(organizacionId, predioId, potreroId);
      res.json(result);
    } catch (error) {
      if (sendSemanticError(res, error)) return;
      next(error);
    }
  });

  // POST .../contexto-agroclimatico/refresh -- resuelve geometry
  // server-side, consulta ERA5-Land/IDEAM, normaliza y persiste un
  // snapshot NUEVO (histórico append-only, §9). Nunca acepta body (§12).
  router.post('/refresh', async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const { predioId, potreroId } = req.params;
      if (!isPredioIdValid(predioId) || !isPotreroIdValid(potreroId)) {
        res.status(400).json({ error: 'INVALID_POTRERO_ID' });
        return;
      }

      const { organizacionId } = req.ganaderiaAuth;
      const result = await refreshContextoAgroclimatico(organizacionId, predioId, potreroId);
      res.status(result.snapshot ? 201 : 200).json({ ok: true, ...result });
    } catch (error) {
      if (sendSemanticError(res, error)) return;
      next(error);
    }
  });

  return router;
}
