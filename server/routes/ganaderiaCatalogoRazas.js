// SPRINT-3D11.2: GET /api/ganaderia/catalogo-razas -- catálogo de razas
// para el registro de animales. Transversal a la organización activa (no
// subordinado a predio). Sesión con organización + CSRF, como el resto de
// /api/ganaderia/*. Nunca el router legacy /api/razas (desmontado).
import { Router } from 'express';
import {
  createRequireGanaderiaSession,
  createRequireGanaderiaCsrf,
} from '../security/ganaderiaSession.js';
import { listRazas } from '../services/ganaderia/catalogoRazasRepository.js';

export default function createGanaderiaCatalogoRazasRouter({ appEnv, csrfServerSecret, allowedOrigins } = {}) {
  const router = Router();

  router.use(createRequireGanaderiaSession({ appEnv }));
  router.use(createRequireGanaderiaCsrf({ csrfServerSecret, allowedOrigins }));

  router.get('/', async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const { organizacionId } = req.ganaderiaAuth;
      res.json({ razas: await listRazas(organizacionId) });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
