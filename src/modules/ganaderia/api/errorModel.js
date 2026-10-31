// FASE 3C: contrato de errores del frontend de Ganadería (puro, sin React ni
// red). Toda pantalla traduce un fallo con mensajeError(); nadie vuelve a
// interpretar status, data.error, correlationId ni errores de red por su cuenta.
//
//   CANCELADO  AbortError / cancelación       -> sin mensaje (null)
//   RED        sin respuesta (status 0)       -> MENSAJE_SIN_CONEXION
//   SERVIDOR   5xx                            -> genérico (+ código de seguimiento)
//   PERMISO    403 ROLE_FORBIDDEN             -> MENSAJE_ROLE_FORBIDDEN
//   CLIENTE    resto de 4xx                   -> mensaje funcional del módulo (por código)
//
// Un 5xx NUNCA muestra texto del backend (message, SQL, stack...): solo el
// mensaje genérico y, si el servidor devolvió un correlationId válido
// (body 5xx o cabecera X-Request-ID), sus 8 primeros caracteres. El
// correlationId nunca se inventa ni se persiste (ni localStorage ni
// sessionStorage ni IndexedDB): vive solo en el resultado de la solicitud.

export const MENSAJE_ERROR_SERVIDOR = 'Ocurrió un error. Intenta nuevamente.';
export const MENSAJE_SIN_CONEXION = 'No fue posible conectar con el servidor. Revisa tu conexión.';
export const MENSAJE_SIN_PERMISOS = 'No tienes permisos para realizar esta acción.';
export const MENSAJE_FALLBACK_CLIENTE = 'No fue posible completar la acción. Revisa los datos e intenta nuevamente.';

export const TIPOS_FALLO = Object.freeze({
  CANCELADO: 'CANCELADO',
  RED: 'RED',
  SERVIDOR: 'SERVIDOR',
  PERMISO: 'PERMISO',
  CLIENTE: 'CLIENTE',
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Fallos del cliente autenticado (ganaderiaAuthedRequest.js) que significan
// "no hubo respuesta del servidor".
const FALLOS_DE_RED = new Set(['NETWORK_ERROR', 'REQUEST_NOT_SENT']);

export function esCorrelationIdValido(value) {
  return typeof value === 'string' && UUID.test(value);
}

/** UUID válido -> 8 primeros caracteres en minúsculas; cualquier otro valor -> null. */
export function codigoSeguimiento(correlationId) {
  return esCorrelationIdValido(correlationId) ? correlationId.slice(0, 8).toLowerCase() : null;
}

function leerCabecera(headers, nombre) {
  try {
    if (headers && typeof headers.get === 'function') return headers.get(nombre);
    if (headers && typeof headers === 'object') return headers[nombre] ?? headers[nombre.toLowerCase()] ?? null;
  } catch {
    // cabeceras ilegibles: sin correlationId
  }
  return null;
}

/**
 * correlationId de una respuesta 5xx: primero el body ({ correlationId }),
 * luego la cabecera X-Request-ID. Solo UUID válidos; si no, null.
 */
export function correlationIdDeRespuesta(status, data, headers) {
  if (typeof status !== 'number' || status < 500) return null;
  const delBody = data && typeof data === 'object' ? data.correlationId : null;
  if (esCorrelationIdValido(delBody)) return delBody;
  const deCabecera = leerCabecera(headers, 'X-Request-ID');
  return esCorrelationIdValido(deCabecera) ? deCabecera : null;
}

function esCancelacion(error) {
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
}

/**
 * Resultado de los helpers ({ ok, status, data, failure, correlationId })
 * o una excepción (fetch abortado, TypeError de red, Error con status) ->
 * { tipo, status, codigo, correlationId }.
 */
export function clasificarFallo(fallo) {
  if (fallo instanceof Error || esCancelacion(fallo)) {
    if (esCancelacion(fallo)) return { tipo: TIPOS_FALLO.CANCELADO, status: 0, codigo: null, correlationId: null };
    if (typeof fallo.status === 'number' && fallo.status > 0) {
      return clasificarFallo({ status: fallo.status, data: { error: fallo.code ?? null } });
    }
    return { tipo: TIPOS_FALLO.RED, status: 0, codigo: null, correlationId: null };
  }
  const status = typeof fallo?.status === 'number' ? fallo.status : 0;
  const data = fallo?.data && typeof fallo.data === 'object' ? fallo.data : null;
  const codigo = typeof data?.error === 'string' ? data.error : null;
  if (!fallo || status === 0 || FALLOS_DE_RED.has(fallo.failure) || codigo === 'NETWORK_ERROR') {
    return { tipo: TIPOS_FALLO.RED, status: 0, codigo, correlationId: null };
  }
  if (status >= 500) {
    const correlationId = esCorrelationIdValido(fallo.correlationId)
      ? fallo.correlationId
      : correlationIdDeRespuesta(status, data, fallo.headers);
    // El texto de un 5xx nunca se usa: ni como código ni como mensaje.
    return { tipo: TIPOS_FALLO.SERVIDOR, status, codigo: null, correlationId };
  }
  if (status === 403 && (codigo === 'ROLE_FORBIDDEN' || fallo.failure === 'ROLE_FORBIDDEN')) {
    return { tipo: TIPOS_FALLO.PERMISO, status, codigo: 'ROLE_FORBIDDEN', correlationId: null };
  }
  return { tipo: TIPOS_FALLO.CLIENTE, status, codigo, correlationId: null };
}

/** 5xx -> mensaje genérico con código de seguimiento si existe. */
export function mensajeServidor(correlationId) {
  const corto = codigoSeguimiento(correlationId);
  return corto ? `Ocurrió un error. Código de seguimiento: ${corto}` : MENSAJE_ERROR_SERVIDOR;
}

/** Agrega " Código de seguimiento: xxxxxxxx" a un mensaje propio (p. ej. "incierto") si hay correlationId. */
export function conCodigoSeguimiento(mensaje, correlationId) {
  const corto = codigoSeguimiento(correlationId);
  return corto ? `${mensaje} Código de seguimiento: ${corto}` : mensaje;
}

function mensajeFuncional(porCodigo, codigo, status) {
  if (typeof porCodigo === 'function') return porCodigo(codigo, status);
  if (porCodigo && typeof porCodigo === 'object' && codigo && Object.hasOwn(porCodigo, codigo)) return porCodigo[codigo];
  return null;
}

/**
 * Fallo -> mensaje para el usuario (o null si fue una cancelación).
 *   porCodigo: función (codigo, status) => mensaje, o mapa { CODIGO: mensaje },
 *              con los mensajes funcionales del módulo para 4xx (409, 400...).
 *   fallback:  mensaje para un 4xx sin mensaje funcional.
 */
export function mensajeError(fallo, porCodigo = null, { fallback = MENSAJE_FALLBACK_CLIENTE } = {}) {
  const f = fallo && typeof fallo === 'object' && 'tipo' in fallo && Object.hasOwn(TIPOS_FALLO, fallo.tipo)
    ? fallo
    : clasificarFallo(fallo);
  switch (f.tipo) {
    case TIPOS_FALLO.CANCELADO:
      return null;
    case TIPOS_FALLO.RED:
      return MENSAJE_SIN_CONEXION;
    case TIPOS_FALLO.SERVIDOR:
      return mensajeServidor(f.correlationId);
    case TIPOS_FALLO.PERMISO:
      return MENSAJE_SIN_PERMISOS;
    default:
      return mensajeFuncional(porCodigo, f.codigo, f.status) || fallback;
  }
}

// ---------------------------------------------------------------------------
// Excepciones (try/catch de pantallas): nunca se muestra error.message salvo
// que sea un mensaje ya traducido para el usuario.
// ---------------------------------------------------------------------------

const CODIGO_DOMINIO = /^[A-Z][A-Z0-9_]+$/;

/** Error cuyo message es apto para mostrar (ya traducido por un modelo de errores). */
export function errorConMensajeSeguro(mensaje) {
  return Object.assign(new Error(mensaje), { mensajeSeguro: true });
}

/**
 * Excepción -> mensaje para el usuario (o null si fue una cancelación).
 *   - errorConMensajeSeguro(...)                  -> su mensaje
 *   - error de dominio local ({ code: 'QR_NO_DISPONIBLE', message }) -> su mensaje
 *   - AbortError                                  -> null
 *   - TypeError de fetch (sin respuesta)          -> MENSAJE_SIN_CONEXION
 *   - cualquier otro (DOMException, Error técnico) -> fallback (nunca su message)
 */
export function mensajeDeExcepcion(error, fallback = MENSAJE_ERROR_SERVIDOR) {
  if (!error) return fallback;
  if (esCancelacion(error)) return null;
  const message = typeof error.message === 'string' ? error.message : '';
  if (error.mensajeSeguro === true && message) return message;
  // Error HTTP (p. ej. csrfFetchError: message técnico CSRF_FETCH_FAILED_500).
  if (typeof error.status === 'number' && error.status > 0) return mensajeError(error, null, { fallback });
  if (typeof error.code === 'string' && CODIGO_DOMINIO.test(error.code) && message) return message;
  if (error instanceof TypeError) return MENSAJE_SIN_CONEXION;
  return fallback;
}
