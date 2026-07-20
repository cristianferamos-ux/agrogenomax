const GENERIC_MESSAGE = 'Error interno del servidor';

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

// Registro mínimo: nunca lee propiedades de error (ni name/message/stack) --
// solo datos derivados y fijos. LOTE-010 resuelve logging estructurado y
// correlation ID; esto no lo anticipa.
function logSafeError(status) {
  const category = status >= 400 && status < 500 ? 'client_error' : 'internal_error';
  console.error(`[errorHandler] status=${status} category=${category}`);
}

export function notFound(_req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(404).json({ error: 'Ruta no encontrada' });
}

export function errorHandler(error, _req, res, next) {
  const status = normalizeStatus(error && (error.status ?? error.statusCode));

  logSafeError(status);

  if (res.headersSent) {
    next(error);
    return;
  }

  res.setHeader('Cache-Control', 'no-store');

  // ADR-012 §11: los 5xx (pg, conexión, SQL, configuración o desconocido)
  // nunca exponen error.message crudo; los 4xx controlados sí lo conservan
  // porque validaciones funcionales dependen de ese texto.
  const isControlled4xx = status >= 400 && status < 500;
  const message =
    isControlled4xx && error && typeof error.message === 'string' && error.message
      ? error.message
      : GENERIC_MESSAGE;

  res.status(status).json({ error: message });
}
