// FASE 4C -- tablero reproductivo de la ORGANIZACIÓN. Monta en
// /api/ganaderia/reproduccion (server/index.js); no confundir con
// /api/ganaderia/animales/:id/reproduccion (ficha, 4A) ni con
// /api/reproduccion legacy (desmontado). Solo lectura: sesión con
// organización + RBAC de lectura (los 4 roles); tenant EXCLUSIVAMENTE de
// req.ganaderiaAuth; GET sin CSRF. Solo Postgres-AGX-Business.
//
//   GET /resumen?predioId
//     -> 200 { ok, fecha, configuracion, hembrasEnSeguimiento, porEstado, porAlerta }
//   GET /animales?estadoReproductivo&alerta&predioId&q&situacion&registro&limit&offset
//     -> 200 { ok, fecha, total, limit, offset, animales[] }
//   400 INVALID_QUERY · 401 SESSION_* · 403 ROLE_FORBIDDEN
import { Router } from 'express';
import { createRequireGanaderiaCsrf, createRequireGanaderiaSession } from '../security/ganaderiaSession.js';
import { createRequireLectura } from '../security/ganaderiaPermisos.js';
import { resolveFechaHoraNegocio } from '../services/ganaderia/motorDescansoAuto/businessTimezone.js';
import {
  CONFIGURACION_ALERTAS_REPRODUCCION,
  validateListadoTableroQuery,
  validateResumenTableroQuery,
} from '../services/ganaderia/reproduccionAlertas.js';
import { listarTableroReproductivo, resumenTableroReproductivo } from '../services/ganaderia/reproduccionTableroRepository.js';

function sendValidationError(res, error) {
  if (error?.status === 400 && typeof error.code === 'string') {
    res.status(400).json({ error: error.code, message: error.message });
    return true;
  }
  return false;
}

export default function createGanaderiaReproduccionRouter({
  appEnv,
  csrfServerSecret,
  allowedOrigins,
  repo = { listarTableroReproductivo, resumenTableroReproductivo },
  fechaNegocio = () => resolveFechaHoraNegocio().fecha,
} = {}) {
  const router = Router();

  router.use(createRequireGanaderiaSession({ appEnv }));
  router.use(createRequireGanaderiaCsrf({ csrfServerSecret, allowedOrigins }));
  router.use(createRequireLectura());

  router.get('/resumen', async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const filtros = validateResumenTableroQuery(req.query);
      const hoy = fechaNegocio();
      const resumen = await repo.resumenTableroReproductivo(req.ganaderiaAuth.organizacionId, filtros, { hoy });
      res.json({ ok: true, fecha: hoy, configuracion: CONFIGURACION_ALERTAS_REPRODUCCION, ...resumen });
    } catch (error) {
      if (sendValidationError(res, error)) return;
      next(error);
    }
  });

  router.get('/animales', async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const filtros = validateListadoTableroQuery(req.query);
      const hoy = fechaNegocio();
      const { total, animales } = await repo.listarTableroReproductivo(req.ganaderiaAuth.organizacionId, filtros, { hoy });
      res.json({ ok: true, fecha: hoy, total, limit: filtros.limit, offset: filtros.offset, animales });
    } catch (error) {
      if (sendValidationError(res, error)) return;
      next(error);
    }
  });

  return router;
}
