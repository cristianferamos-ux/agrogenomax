import { sanitizeErrorMeta, sanitizeUrl } from '../observability/sanitize.js';

const GENERIC_MESSAGE = 'Error interno del servidor';
export const INTERNAL_ERROR_CODE = 'INTERNAL_ERROR';

const SAFE_ID = /^[1-9]\d{0,17}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ADR-012 §11/§23: acepta solo enteros HTTP 400-599 provistos por el
// propio código de la aplicación; cualquier otro valor (ausente, no
// entero, fuera de rango) se trata como fallo inesperado -> 500.
function normalizeStatus(rawStatus) {
  if (
    typeof rawStatus === 'number' &&
    Number.isInteger(rawStatus) &&
    rawStatus >= 400 &&
    rawStatus <= 599
  ) {
    return rawStatus;
  }
  return 500;
}

// FASE 3B: ruta LÓGICA (patrón de Express: /api/ganaderia/qr + /token/:token),
// nunca la URL real con valores. Sin ruta resuelta (error en un middleware
// previo) se usa la ruta sanitizada (segmentos con forma de token/hash
// redactados, sin query).
function logicalRoute(req) {
  try {
    const routePath = req?.route?.path;
    if (typeof routePath === 'string') {
      const base = typeof req.baseUrl === 'string' ? sanitizeUrl(req.baseUrl).split('?')[0] : '';
      return `${base}${routePath}`;
    }
    const raw = typeof req?.originalUrl === 'string' ? req.originalUrl : '';
    return raw ? sanitizeUrl(raw).split('?')[0] : undefined;
  } catch {
    return undefined;
  }
}

// 404/409 son flujo normal (recurso ajeno, conflicto esperado): info. El
// resto de 4xx: warn. Solo 5xx es error (stderr).
function levelForStatus(status) {
  if (status >= 500) return 'error';
  if (status === 404 || status === 409) return 'info';
  return 'warn';
}

/**
 * Evento estructurado del errorHandler (FASE 3B). Campos permitidos:
 * timestamp, level, event, correlationId, method, route (lógica), status,
 * errorCode (forma de código), organizacionId y animalId (solo con forma
 * válida y de la propia sesión). Nunca message, stack, name, SQL, body,
 * cabeceras, cookies ni la URL con valores.
 */
export function buildErrorLogEvent(error, req, status) {
  const event = {
    timestamp: new Date().toISOString(),
    level: levelForStatus(status),
    event: status >= 500 ? 'request_error' : 'request_client_error',
    status,
  };
  const correlationId = req?.correlationId;
  if (typeof correlationId === 'string' && UUID.test(correlationId)) event.correlationId = correlationId;
  if (typeof req?.method === 'string') event.method = req.method;
  const route = logicalRoute(req);
  if (route) event.route = route;
  const { errorCode } = sanitizeErrorMeta(error);
  if (errorCode) event.errorCode = errorCode;
  const organizacionId = req?.ganaderiaAuth?.organizacionId;
  if (typeof organizacionId === 'string' && UUID.test(organizacionId)) event.organizacionId = organizacionId;
  const animalId = animalIdDe(req);
  if (event.organizacionId && animalId) event.animalId = animalId;
  return event;
}

// En el errorHandler de nivel app, Express ya restableció req.params: el
// animalId se toma de la ruta real (/animales/<id>), solo con forma de id.
function animalIdDe(req) {
  const param = req?.params?.animalId;
  if (typeof param === 'string' && SAFE_ID.test(param)) return param;
  const url = typeof req?.originalUrl === 'string' ? req.originalUrl.split('?')[0] : '';
  const match = url.match(/\/animales\/([1-9]\d{0,17})(?:\/|$)/);
  return match ? match[1] : undefined;
}

function defaultSink(event) {
  const line = JSON.stringify(event);
  if (event.level === 'error') console.error(line);
  else console.log(line);
}

function safeEmit(sink, event) {
  try {
    sink(event);
  } catch {
    // El fallo del log nunca rompe la respuesta.
  }
}

export function notFound(_req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(404).json({ error: 'Ruta no encontrada' });
}

export function createErrorHandler({ sink = defaultSink } = {}) {
  return function errorHandler(error, req, res, next) {
    const status = normalizeStatus(error && (error.status ?? error.statusCode));

    safeEmit(sink, buildErrorLogEvent(error, req, status));

    if (res.headersSent) {
      next(error);
      return;
    }

    res.setHeader('Cache-Control', 'no-store');

    // ADR-012 §11: los 5xx (pg, conexión, SQL, configuración o desconocido)
    // nunca exponen error.message crudo; los 4xx controlados sí lo conservan
    // porque validaciones funcionales dependen de ese texto.
    const isControlled4xx = status >= 400 && status < 500;
    if (isControlled4xx) {
      const message = error && typeof error.message === 'string' && error.message ? error.message : GENERIC_MESSAGE;
      res.status(status).json({ error: message });
      return;
    }

    // FASE 3B: 5xx -> mensaje genérico + código estable + correlationId
    // (código de seguimiento para soporte). `error` conserva el texto
    // histórico (contrato existente de clientes, incluida CatastroX).
    const body = { error: GENERIC_MESSAGE, code: INTERNAL_ERROR_CODE };
    const correlationId = req?.correlationId;
    if (typeof correlationId === 'string' && UUID.test(correlationId)) body.correlationId = correlationId;
    res.status(status).json(body);
  };
}

export const errorHandler = createErrorHandler();
