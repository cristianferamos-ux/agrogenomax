/**
 * Logging estructurado y correlation ID por solicitud (LOTE-010, ADR-012 §25).
 *
 * Se monta inmediatamente después de crear `app`, antes de CORS y de
 * cualquier otro middleware/ruta (server/index.js), para que exista un
 * correlationId disponible durante todo el ciclo de vida de la solicitud.
 *
 * Campos de log permitidos exclusivamente: timestamp, level, event,
 * correlationId, method y, en los eventos finales (`request_completed`/
 * `request_aborted`), statusCode y durationMs. Nunca URL, path, query,
 * headers, cookies, Authorization, body, IP, user-agent, tokens,
 * credenciales, geometría ni error.message -- eso queda fuera de alcance
 * de este lote (server/middleware/errors.js ya cubre el logging de error
 * sin datos sensibles, LOTE-009).
 */

import { randomUUID } from 'crypto';

export const REQUEST_ID_HEADER = 'X-Request-ID';

// RFC 4122: acepta cualquier versión 1-5 con variante 8/9/a/b. Cualquier
// entrada que no calce exactamente (incluida inyección de payloads, JSON,
// scripts, headers duplicados, etc.) se descarta y se genera un UUID nuevo.
const CANONICAL_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isCanonicalUuid(value) {
  return typeof value === 'string' && CANONICAL_UUID_PATTERN.test(value);
}

function resolveCorrelationId(rawHeaderValue, generateId) {
  return isCanonicalUuid(rawHeaderValue) ? rawHeaderValue : generateId();
}

function levelForStatus(statusCode) {
  if (typeof statusCode === 'number' && statusCode >= 500) return 'error';
  if (typeof statusCode === 'number' && statusCode >= 400) return 'warn';
  return 'info';
}

// El fallo del sink de logging (I/O, serialización, etc.) nunca debe
// romper la solicitud en curso.
function safeEmit(sink, event) {
  try {
    sink(event);
  } catch {
    // Intencional: sin fallback de logging ni propagación del error.
  }
}

function defaultSink(event) {
  console.log(JSON.stringify(event));
}

function nonNegativeDurationMs(startedAtNs, nowFn) {
  const diffNs = nowFn() - startedAtNs;
  const ms = Number(diffNs) / 1e6;
  return ms < 0 ? 0 : ms;
}

/**
 * @param {{
 *   sink?: (event: object) => void,
 *   generateId?: () => string,
 *   now?: () => bigint,
 * }} options
 */
export function createRequestLogging({
  sink = defaultSink,
  generateId = randomUUID,
  now = () => process.hrtime.bigint(),
} = {}) {
  return function requestLogging(req, res, next) {
    const incoming = req.headers ? req.headers['x-request-id'] : undefined;
    const correlationId = resolveCorrelationId(incoming, generateId);

    req.correlationId = correlationId;
    res.locals = res.locals || {};
    res.locals.correlationId = correlationId;
    res.setHeader(REQUEST_ID_HEADER, correlationId);

    const startedAtNs = now();
    let settled = false;

    safeEmit(sink, {
      timestamp: new Date().toISOString(),
      level: 'info',
      event: 'request_started',
      correlationId,
      method: req.method,
    });

    res.once('finish', () => {
      if (settled) return;
      settled = true;
      safeEmit(sink, {
        timestamp: new Date().toISOString(),
        level: levelForStatus(res.statusCode),
        event: 'request_completed',
        correlationId,
        method: req.method,
        statusCode: res.statusCode,
        durationMs: nonNegativeDurationMs(startedAtNs, now),
      });
    });

    res.once('close', () => {
      if (settled) return;
      settled = true;
      safeEmit(sink, {
        timestamp: new Date().toISOString(),
        level: 'warn',
        event: 'request_aborted',
        correlationId,
        method: req.method,
        statusCode: res.statusCode,
        durationMs: nonNegativeDurationMs(startedAtNs, now),
      });
    });

    next();
  };
}
