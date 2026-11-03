// SPRINT-3D11.3 (R1) -- sincronización offline-first de Ganadería. Monta
// en /api/ganaderia/sync. Sesión con organización (+ CSRF en mutaciones,
// hoy no hay). El PUSH reutiliza los endpoints de escritura existentes, ya
// idempotentes por clientOperationId (POST /animales y
// POST /qr/chapetas/:codigo/registrar-animal); aquí solo vive el PULL.
import { Router } from 'express';
import {
  createRequireGanaderiaSession,
  createRequireGanaderiaCsrf,
} from '../security/ganaderiaSession.js';
import { pullCambios } from '../services/ganaderia/syncRepository.js';
import { pullEventosReproductivos } from '../services/ganaderia/reproduccionSyncRepository.js';

export default function createGanaderiaSyncRouter({
  appEnv,
  csrfServerSecret,
  allowedOrigins,
  reproduccionRepo = { pullEventosReproductivos },
} = {}) {
  const router = Router();

  router.use(createRequireGanaderiaSession({ appEnv }));
  router.use(createRequireGanaderiaCsrf({ csrfServerSecret, allowedOrigins }));

  // FASE 4E.1: cursor propio (reproduccionSyncRepository.js). Mismas reglas que /pull.
  router.get('/reproduccion', async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const unknown = Object.keys(req.query).filter((key) => key !== 'cursor');
      if (unknown.length > 0) {
        res.status(400).json({ error: 'INVALID_QUERY' });
        return;
      }
      const { organizacionId, cuentaId } = req.ganaderiaAuth;
      const result = await reproduccionRepo.pullEventosReproductivos(organizacionId, { cursor: req.query.cursor });
      // cuentaId: la de esta misma sesión. El dispositivo solo concilia operaciones de esa cuenta.
      res.json({ ok: true, ...result, organizacionId, cuentaId });
    } catch (error) {
      if (typeof error?.status === 'number' && typeof error?.code === 'string') {
        res.status(error.status).json({ error: error.code, message: error.message });
        return;
      }
      next(error);
    }
  });

  router.get('/pull', async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const unknown = Object.keys(req.query).filter((key) => key !== 'cursor');
      if (unknown.length > 0) {
        res.status(400).json({ error: 'INVALID_QUERY' });
        return;
      }
      const { organizacionId } = req.ganaderiaAuth;
      const result = await pullCambios(organizacionId, { cursor: req.query.cursor });
      res.json({ ok: true, organizacionId, ...result });
    } catch (error) {
      if (typeof error?.status === 'number' && typeof error?.code === 'string') {
        res.status(error.status).json({ error: error.code, message: error.message });
        return;
      }
      next(error);
    }
  });

  return router;
}
