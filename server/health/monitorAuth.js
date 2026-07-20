/**
 * Autenticación técnica de monitoreo (LOTE-007, ADR-012 §35.A).
 *
 * Protege readiness por dominio y GET /api/health/db: exige
 * `Authorization: Bearer <HEALTH_MONITOR_TOKEN>` (esquema aceptado sin
 * distinguir mayúsculas/minúsculas) con comparación segura en tiempo
 * constante, sin registrar ni devolver el token ni fragmentos de él.
 * HEALTH_MONITOR_TOKEN es obligatorio en staging/production (validado en
 * el arranque por server/config/env.js), prohibido en demo, e inyectable
 * de forma opcional en development/test.
 *
 * La comparación se hace sobre el hash SHA-256 (longitud fija de 32 bytes)
 * de cada token, nunca sobre los tokens crudos -- así timingSafeEqual
 * jamás retorna en función de la longitud del token recibido.
 *
 * Sin token configurado, el acceso se niega siempre -- nunca existe un
 * "modo abierto" implícito por ambiente.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

const BEARER_PATTERN = /^Bearer\s+(\S+)$/i;

function hashToken(value) {
  return createHash('sha256').update(value, 'utf8').digest();
}

function safeTokensEqual(provided, expected) {
  return timingSafeEqual(hashToken(provided), hashToken(expected));
}

/**
 * @param {{token?: string}} options
 */
export function createMonitorAuthMiddleware({ token } = {}) {
  return function monitorAuthMiddleware(req, res, next) {
    res.setHeader('Cache-Control', 'no-store');

    if (typeof token !== 'string' || token === '') {
      res.status(503).json({ status: 'unavailable' });
      return;
    }

    const header = req.headers.authorization;
    const match = typeof header === 'string' ? BEARER_PATTERN.exec(header) : null;

    if (!match || !safeTokensEqual(match[1], token)) {
      res.status(401).json({ error: 'No autorizado' });
      return;
    }

    next();
  };
}
