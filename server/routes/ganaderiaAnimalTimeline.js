// FASE 1D.2 -- LÍNEA DE TIEMPO DERIVADA del animal. Monta en
// /api/ganaderia/animales/:animalId/timeline (server/index.js), ANTES del
// router de animales. Mismo contrato de seguridad que pesajes y reporte:
// sesión obligatoria; tenant EXCLUSIVAMENTE de req.ganaderiaAuth; GET sin
// CSRF (lectura); solo lectura. Solo Postgres-AGX-Business; nunca legacy.
//
//   GET ?limit=1..200 (por defecto 50)
//     -> 200 { ok, animalId, orden:'DESCENDENTE', limit, total, truncado, eventos[] }
//        400 INVALID_ANIMAL_ID | INVALID_LIMIT
//        401 SESSION_REQUIRED / SESSION_INVALID
//        404 ANIMAL_NOT_FOUND (inexistente o de otra organización; un
//            animal ANULADO sí tiene línea de tiempo)
import { Router } from 'express';
import { createRequireGanaderiaCsrf, createRequireGanaderiaSession } from '../security/ganaderiaSession.js';
import { isValidPositiveId } from '../services/ganaderia/animalValidation.js';
import { normalizarLimiteTimeline } from '../services/ganaderia/timeline/timelineModelo.js';
import { leerFuentesTimeline } from '../services/ganaderia/timeline/timelineRepository.js';
import { obtenerTimelineAnimal } from '../services/ganaderia/timeline/timelineService.js';

export default function createGanaderiaAnimalTimelineRouter({ appEnv, csrfServerSecret, allowedOrigins, leerFuentes = leerFuentesTimeline } = {}) {
  const router = Router({ mergeParams: true });

  router.use(createRequireGanaderiaSession({ appEnv }));
  router.use(createRequireGanaderiaCsrf({ csrfServerSecret, allowedOrigins }));

  router.get('/', async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (!isValidPositiveId(req.params.animalId)) {
        res.status(400).json({ error: 'INVALID_ANIMAL_ID' });
        return;
      }
      const limit = normalizarLimiteTimeline(req.query.limit);
      if (limit === null) {
        res.status(400).json({ error: 'INVALID_LIMIT', message: 'limit debe ser un entero entre 1 y 200.' });
        return;
      }
      const timeline = await obtenerTimelineAnimal(req.ganaderiaAuth.organizacionId, req.params.animalId, { limit, leerFuentes });
      if (!timeline) {
        res.status(404).json({ error: 'ANIMAL_NOT_FOUND' });
        return;
      }
      res.json({ ok: true, animalId: timeline.animalId, orden: 'DESCENDENTE', limit, total: timeline.total, truncado: timeline.truncado, eventos: timeline.eventos });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
