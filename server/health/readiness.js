/**
 * Handlers Express de readiness funcional (LOTE-007, ADR-012 §5.3/§7).
 *
 * Separada explícitamente por dominio (Ganadería, CatastroX) -- la caída
 * de uno nunca declara al otro no disponible (evaluados en paralelo, sin
 * dependencia entre sí). `Cache-Control: no-store` en toda respuesta.
 * `503` es diagnóstico/alerta, nunca retira tráfico del ALB por sí solo
 * (eso depende exclusivamente de GET /api/health/live).
 */

import { evaluateGanaderiaReadiness } from './ganaderiaReadiness.js';
import { evaluateCatastroxReadiness } from './catastroxReadiness.js';

function sendDomainReadiness(res, checkName, result) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(result.ok ? 200 : 503).json({
    status: result.ok ? 'ok' : 'unavailable',
    check: checkName,
    timestamp: new Date().toISOString(),
    dependency: result.dependency,
    ...(result.ok ? {} : { code: result.code }),
  });
}

/**
 * @param {{deps?: Parameters<typeof evaluateGanaderiaReadiness>[0]}} [options]
 */
export function createGanaderiaReadinessHandler({ deps } = {}) {
  return async function ganaderiaReadinessHandler(_req, res) {
    const result = await evaluateGanaderiaReadiness(deps);
    sendDomainReadiness(res, 'ready:ganaderia', result);
  };
}

/**
 * @param {{deps?: Parameters<typeof evaluateCatastroxReadiness>[0]}} [options]
 */
export function createCatastroxReadinessHandler({ deps } = {}) {
  return async function catastroxReadinessHandler(_req, res) {
    const result = await evaluateCatastroxReadiness(deps);
    sendDomainReadiness(res, 'ready:catastrox', result);
  };
}

/**
 * @param {{ganaderiaDeps?: Parameters<typeof evaluateGanaderiaReadiness>[0], catastroxDeps?: Parameters<typeof evaluateCatastroxReadiness>[0]}} [options]
 */
export function createGeneralReadinessHandler({ ganaderiaDeps, catastroxDeps } = {}) {
  return async function generalReadinessHandler(_req, res) {
    const [ganaderia, catastrox] = await Promise.all([
      evaluateGanaderiaReadiness(ganaderiaDeps),
      evaluateCatastroxReadiness(catastroxDeps),
    ]);

    const allOk = ganaderia.ok && catastrox.ok;

    res.setHeader('Cache-Control', 'no-store');
    res.status(allOk ? 200 : 503).json({
      status: allOk ? 'ok' : 'degraded',
      check: 'ready',
      timestamp: new Date().toISOString(),
      domains: {
        ganaderia: {
          status: ganaderia.ok ? 'ok' : 'unavailable',
          ...(ganaderia.ok ? {} : { code: ganaderia.code }),
        },
        catastrox: {
          status: catastrox.ok ? 'ok' : 'unavailable',
          ...(catastrox.ok ? {} : { code: catastrox.code }),
        },
      },
    });
  };
}
