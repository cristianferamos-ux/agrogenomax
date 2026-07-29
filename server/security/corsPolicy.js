/**
 * Adaptador Express de la política CORS (LOTE-004, ADR-014 §7 Barrera 4/
 * §21, ADR-013 §21). La lógica de decisión pura vive en
 * shared/security/corsPolicy.js -- este módulo únicamente construye la
 * política final (con los métodos/headers/credentials que no varían por
 * `APP_ENV`) y la conecta a `req`/`res`/`next`.
 *
 * CORS no es autenticación (decisión vinculante de este lote): un origen
 * permitido aquí no exime a ninguna ruta de exigir autenticación,
 * autorización, validación de sesión o CSRF cuando corresponda.
 */

import {
  DEFAULT_CORS_HEADERS,
  DEFAULT_CORS_METHODS,
  buildCorsPolicy,
  evaluateCorsRequest,
  isOriginAllowed,
  normalizeOrigin,
} from '../../shared/security/corsPolicy.js';

export { DEFAULT_CORS_HEADERS, DEFAULT_CORS_METHODS, buildCorsPolicy, evaluateCorsRequest, isOriginAllowed, normalizeOrigin };

/**
 * Construye la política CORS final para `appEnv` a partir de la
 * *allowlist* ya resuelta por server/config/env.js
 * (`appConfig.cors.allowedOrigins`). Métodos, headers y `credentials` son
 * constantes -- no dependen de `APP_ENV`.
 *
 * ADR-009 implementado: `allowCredentials: true` habilita el cookie
 * HttpOnly de recuperación de CatastroX (server/security/recoveryCookie.js)
 * -- el aislamiento real de ese cookie lo da su atributo `Path`
 * (`/api/catastrox/payments`), no este flag: `allowCredentials` solo
 * permite que el navegador incluya/lea credenciales en solicitudes
 * cross-origin ya autorizadas por la allowlist (nunca hay reflejo de `*`
 * en este módulo, condición necesaria para poder activar credentials sin
 * abrir la política).
 *
 * @param {{appEnv: string, allowedOrigins: string[]}} corsConfig
 */
export function buildExpressCorsPolicy(corsConfig) {
  return buildCorsPolicy({
    appEnv: corsConfig.appEnv,
    allowedOrigins: corsConfig.allowedOrigins,
    allowedMethods: DEFAULT_CORS_METHODS,
    allowedHeaders: DEFAULT_CORS_HEADERS,
    allowCredentials: true,
  });
}

/**
 * Emite un evento de telemetría seguro ante un origen rechazado. Nunca
 * incluye cookies, tokens, `Authorization`, *payload* ni *query string*
 * completa -- únicamente ambiente, origen normalizado/crudo, método, ruta
 * y motivo. Si se inyecta un `reporter`, se usa en lugar de
 * `console.warn` (observabilidad completa diferida a un lote posterior).
 */
export function reportRejectedCorsRequest(details, options = {}) {
  const { appEnv, origin, method, path, reason } = details;
  const event = { type: 'cors_origin_rejected', appEnv, origin: origin ?? null, method, path, reason };

  if (typeof options.reporter === 'function') {
    options.reporter(event);
    return event;
  }

  if (typeof console !== 'undefined' && typeof console.warn === 'function') {
    console.warn(
      `[AgroGenomaX CORS] Origen rechazado (ambiente="${appEnv}", motivo="${reason}", ` +
        `metodo="${method}", ruta="${path}").`,
    );
  }
  return event;
}

/**
 * Middleware Express construido sobre `evaluateCorsRequest()`. Debe
 * montarse antes de cualquier ruta de negocio (server/index.js).
 *
 * - `continue`: sin cabecera Origin -- same-origin/health/server-to-server;
 *   continúa sin añadir cabeceras CORS, sin tratarlo como autenticado.
 * - `allow`: origen permitido, solicitud real -- añade ACAO/Vary (y
 *   Allow-Credentials si la política lo declara) y continúa.
 * - `preflight-ok`: OPTIONS válido -- responde 204 con las cabeceras
 *   completas, sin invocar ninguna ruta de negocio.
 * - `reject`: Origin: null, origen no permitido, o preflight con
 *   método/headers no permitidos -- responde 403, sin cabeceras CORS,
 *   sin invocar ninguna ruta de negocio, y reporta el intento.
 *
 * @param {ReturnType<typeof buildCorsPolicy>} policy
 * @param {{reporter?: Function}} options
 */
export function createCorsMiddleware(policy, options = {}) {
  return function corsMiddleware(req, res, next) {
    const origin = req.headers.origin;
    const decision = evaluateCorsRequest(policy, {
      method: req.method,
      origin,
      requestedMethod: req.headers['access-control-request-method'],
      requestedHeaders: req.headers['access-control-request-headers'],
    });

    if (decision.action === 'continue') {
      next();
      return;
    }

    if (decision.action === 'allow') {
      for (const [key, value] of Object.entries(decision.headers)) {
        res.setHeader(key, value);
      }
      next();
      return;
    }

    if (decision.action === 'preflight-ok') {
      for (const [key, value] of Object.entries(decision.headers)) {
        res.setHeader(key, value);
      }
      res.status(decision.status).end();
      return;
    }

    reportRejectedCorsRequest(
      {
        appEnv: policy.appEnv,
        origin,
        method: req.method,
        path: req.path || req.originalUrl || req.url,
        reason: decision.reason,
      },
      options,
    );
    res.status(decision.status || 403).json({ error: 'Origen no permitido por CORS.' });
  };
}
