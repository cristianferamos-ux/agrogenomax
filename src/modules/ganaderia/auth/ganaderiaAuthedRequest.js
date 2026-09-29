// SPRINT-3D10.5: cliente HTTP autenticado compartido de Ganadería. JS puro
// (sin React) -- testeable con node:test.
//
// Contrato real auditado (server/security/ganaderiaSession.js,
// server/routes/ganaderiaAuth.js):
//   GET /auth/csrf        401 SESSION_REQUIRED | 401 SESSION_INVALID | 200 { csrfToken }
//   requireSession        401 SESSION_REQUIRED | 401 SESSION_INVALID | 409 ORGANIZATION_REQUIRED
//   requireCsrf           401 SESSION_REQUIRED | 403 ORIGIN_INVALID | 403 CSRF_REQUIRED | 403 CSRF_INVALID
//
// postWithCsrf/postJsonWithCsrf NUNCA lanzan por HTTP ni por red: siempre
// devuelven { ok, status, data } (+ `failure` solo en fallos de sesión,
// CSRF o red). Exactamente 1 GET /csrf y como máximo 1 POST por
// invocación; cero reintentos; si /csrf falla el POST no se envía.
import { AUTH_NOTICE_KINDS, emitAuthNotice } from './ganaderiaAuthNoticeSignal.js';

// Mismo relay same-origin ya usado por functions/api/ganaderia/[[path]].js
// (BFF-001) -- nunca una URL absoluta de Railway.
const CSRF_URL = '/api/ganaderia/auth/csrf';

export const SESSION_EXPIRED_CODES = Object.freeze(['SESSION_REQUIRED', 'SESSION_INVALID']);
export const CSRF_REJECTED_CODES = Object.freeze(['CSRF_REQUIRED', 'CSRF_INVALID', 'ORIGIN_INVALID']);

export const REQUEST_FAILURES = Object.freeze({
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  CSRF_REJECTED: 'CSRF_REJECTED',
  NETWORK_ERROR: 'NETWORK_ERROR',
  REQUEST_NOT_SENT: 'REQUEST_NOT_SENT',
});

async function parseJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function errorCodeOf(data) {
  return typeof data?.error === 'string' ? data.error : null;
}

// Nunca se clasifica solo por status -- exige el código real de sesión.
export function isSessionExpiredResponse(status, data) {
  return status === 401 && SESSION_EXPIRED_CODES.includes(errorCodeOf(data));
}

// Un 403 de CSRF/origen NUNCA se trata como sesión expirada ni logout.
export function isCsrfRejectedResponse(status, data) {
  return status === 403 && CSRF_REJECTED_CODES.includes(errorCodeOf(data));
}

function csrfFetchError(status, code) {
  const error = new Error(`CSRF_FETCH_FAILED_${status}`);
  error.status = status;
  error.code = code;
  return error;
}

// AUTH-FRONT-001 STAGING GATE §1: toda mutación sobre una ruta autenticada
// exige `X-CSRF-Token`, obtenida vía GET /csrf (requiere sesión válida).
// POST /login y POST /password/set quedan fuera (sin sesión todavía). Se
// pide un token fresco en cada mutación -- evita servir un token obsoleto
// tras rotación de sesión (login/logout).
//
// Contrato público conservado: SIGUE LANZANDO ante cualquier fallo, con el
// mismo mensaje `CSRF_FETCH_FAILED_<status>`. SPRINT-3D10.5 solo agrega
// `err.status` y `err.code`. Un error de red se propaga como el TypeError
// nativo de fetch (sin `status`).
export async function fetchCsrfToken() {
  const response = await fetch(CSRF_URL, {
    method: 'GET',
    credentials: 'include',
  });
  if (!response.ok) {
    const payload = await parseJson(response);
    throw csrfFetchError(response.status, errorCodeOf(payload));
  }
  const payload = await parseJson(response);
  if (typeof payload?.csrfToken !== 'string' || payload.csrfToken === '') {
    throw csrfFetchError(response.status, 'CSRF_TOKEN_MISSING');
  }
  return payload.csrfToken;
}

// El caller nunca puede reemplazar X-CSRF-Token (comparación
// case-insensitive): el único token enviado es el obtenido del servidor.
function buildHeaders(callerHeaders, csrfToken) {
  const headers = {};
  if (callerHeaders && typeof callerHeaders === 'object') {
    for (const [name, value] of Object.entries(callerHeaders)) {
      if (String(name).toLowerCase() === 'x-csrf-token') continue;
      headers[name] = value;
    }
  }
  headers['X-CSRF-Token'] = csrfToken;
  return headers;
}

function failureResult(status, errorCode, failure) {
  return { ok: false, status, data: { error: errorCode }, failure };
}

export async function postWithCsrf(path, { body, headers } = {}) {
  let csrfToken;
  try {
    csrfToken = await fetchCsrfToken();
  } catch (error) {
    if (error?.status === 401 && SESSION_EXPIRED_CODES.includes(error.code)) {
      emitAuthNotice(AUTH_NOTICE_KINDS.SESSION_EXPIRED);
      return failureResult(401, 'SESSION_EXPIRED', REQUEST_FAILURES.SESSION_EXPIRED);
    }
    // /csrf no disponible (red, 5xx, 401 sin código de sesión, token
    // ausente): el POST NUNCA se envió -- reintentar a mano es seguro.
    const status = typeof error?.status === 'number' && (error.status < 200 || error.status > 299) ? error.status : 0;
    return failureResult(status, 'CSRF_UNAVAILABLE', REQUEST_FAILURES.REQUEST_NOT_SENT);
  }

  const init = {
    method: 'POST',
    credentials: 'include',
    headers: buildHeaders(headers, csrfToken),
  };
  if (body !== undefined) init.body = body;

  let response;
  try {
    response = await fetch(path, init);
  } catch {
    // Sin respuesta: el resultado de la mutación es INCIERTO. Nunca se
    // reintenta automáticamente.
    emitAuthNotice(AUTH_NOTICE_KINDS.NETWORK_ERROR);
    return failureResult(0, 'NETWORK_ERROR', REQUEST_FAILURES.NETWORK_ERROR);
  }

  const data = await parseJson(response);
  const result = { ok: response.ok, status: response.status, data };

  if (isSessionExpiredResponse(response.status, data)) {
    emitAuthNotice(AUTH_NOTICE_KINDS.SESSION_EXPIRED);
    return { ...result, failure: REQUEST_FAILURES.SESSION_EXPIRED };
  }
  if (isCsrfRejectedResponse(response.status, data)) {
    emitAuthNotice(AUTH_NOTICE_KINDS.CSRF_REJECTED);
    return { ...result, failure: REQUEST_FAILURES.CSRF_REJECTED };
  }
  return result;
}

export function postJsonWithCsrf(path, body) {
  return postWithCsrf(path, {
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

// SPRINT-3D10.5 F3b: logout resiliente. El logout normal SIGUE exigiendo
// CSRF (mismo POST /auth/logout, mismo header, sin body). Solo un 401 con
// código de sesión -- respuesta autoritativa del servidor -- se interpreta
// como "ya desconectado". Nunca emite avisos globales (el logout maneja su
// propia UI), nunca lanza, nunca reintenta.
const LOGOUT_URL = '/api/ganaderia/auth/logout';

export const LOGOUT_OUTCOMES = Object.freeze({
  LOGGED_OUT: 'LOGGED_OUT',
  ALREADY_LOGGED_OUT: 'ALREADY_LOGGED_OUT',
  CSRF_REJECTED: 'CSRF_REJECTED',
  NETWORK_ERROR: 'NETWORK_ERROR',
  FAILED: 'FAILED',
});

export async function performGanaderiaLogout() {
  let csrfToken;
  try {
    csrfToken = await fetchCsrfToken();
  } catch (error) {
    if (error?.status === 401 && SESSION_EXPIRED_CODES.includes(error.code)) {
      return LOGOUT_OUTCOMES.ALREADY_LOGGED_OUT;
    }
    // fetchCsrfToken solo lanza sin `status` numérico ante fallo de red.
    return typeof error?.status === 'number' ? LOGOUT_OUTCOMES.FAILED : LOGOUT_OUTCOMES.NETWORK_ERROR;
  }

  let response;
  try {
    response = await fetch(LOGOUT_URL, {
      method: 'POST',
      credentials: 'include',
      headers: { 'X-CSRF-Token': csrfToken },
    });
  } catch {
    return LOGOUT_OUTCOMES.NETWORK_ERROR;
  }

  if (response.ok) return LOGOUT_OUTCOMES.LOGGED_OUT;
  const data = await parseJson(response);
  if (isSessionExpiredResponse(response.status, data)) return LOGOUT_OUTCOMES.ALREADY_LOGGED_OUT;
  if (isCsrfRejectedResponse(response.status, data)) return LOGOUT_OUTCOMES.CSRF_REJECTED;
  return LOGOUT_OUTCOMES.FAILED;
}

// GET autenticado -- contrato IDÉNTICO al getJson local previo: devuelve
// { ok, status, data } y un error de red SIGUE LANZANDO (los loaders ya
// tienen su propio .catch). Solo agrega el aviso ante 401 de sesión.
export async function getJsonWithSession(path) {
  const response = await fetch(path, { credentials: 'include' });
  const data = await parseJson(response);
  if (isSessionExpiredResponse(response.status, data)) {
    emitAuthNotice(AUTH_NOTICE_KINDS.SESSION_EXPIRED);
  }
  return { ok: response.ok, status: response.status, data };
}
