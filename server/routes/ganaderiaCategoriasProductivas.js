// SPRINT-3D7.2-RECOMENDACION-PASTOREO-AUTO: catálogo de categorías
// productivas (agx.catalogo_categorias_productivas, sistema únicamente en
// v1). Deliberadamente NO subordinado a predio/potrero -- transversal a
// toda la organización, mismo criterio que ganaderiaCatalogoPasturas.js.
// Monta directamente en /api/ganaderia/categorias-productivas
// (server/index.js). Solo lectura -- v1 no implementa categorías
// personalizadas (§3 del sprint).
import { Router } from 'express';
import {
  createRequireGanaderiaSession,
  createRequireGanaderiaCsrf,
} from '../security/ganaderiaSession.js';
import { listCategoriasProductivas } from '../services/ganaderia/categoriaProductivaRepository.js';

export default function createGanaderiaCategoriasProductivasRouter({ appEnv, csrfServerSecret, allowedOrigins } = {}) {
  const router = Router();

  const requireSession = createRequireGanaderiaSession({ appEnv });
  const requireCsrf = createRequireGanaderiaCsrf({ csrfServerSecret, allowedOrigins });

  router.use(requireSession);
  router.use(requireCsrf);

  router.get('/', async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const { organizacionId } = req.ganaderiaAuth;
      const categorias = await listCategoriasProductivas(organizacionId);
      res.json({ categorias });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
