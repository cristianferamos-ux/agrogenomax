import { Router } from 'express';
import { schema } from '../db.js';
import { createMonitorAuthMiddleware } from '../health/monitorAuth.js';
import { evaluateGanaderiaReadiness } from '../health/ganaderiaReadiness.js';
import {
  createGeneralReadinessHandler,
  createGanaderiaReadinessHandler,
  createCatastroxReadinessHandler,
} from '../health/readiness.js';

/**
 * LOTE-007 (ADR-012 §7/§35.A): readiness general y por dominio, más la
 * ruta heredada `/db`, protegidas por autenticación técnica de monitoreo
 * (Authorization: Bearer + HEALTH_MONITOR_TOKEN). Ninguna se expone a
 * través del relay público general de Cloudflare (functions/api/health.js
 * no las consulta).
 *
 * @param {{healthMonitorToken?: string}} [options]
 */
export default function createHealthRouter({ healthMonitorToken } = {}) {
  const router = Router();
  const monitorAuth = createMonitorAuthMiddleware({ token: healthMonitorToken });

  router.get('/', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, service: 'api', status: 'running' });
  });

  router.get('/ready', monitorAuth, createGeneralReadinessHandler());
  router.get('/ready/ganaderia', monitorAuth, createGanaderiaReadinessHandler());
  router.get('/ready/catastrox', monitorAuth, createCatastroxReadinessHandler());

  // Ruta heredada (ADR-012 §7 fila 6): misma protección que
  // `ready/ganaderia`, misma clasificación de causas -- se retira una vez
  // verificado que no queda ningún consumidor dependiendo de ella.
  router.get('/db', monitorAuth, async (_req, res) => {
    const result = await evaluateGanaderiaReadiness();
    res.setHeader('Cache-Control', 'no-store');
    if (!result.ok) {
      res.status(503).json({ ok: false, database: 'unavailable', code: result.code });
      return;
    }
    res.json({ ok: true, database: 'connected', schema });
  });

  return router;
}
