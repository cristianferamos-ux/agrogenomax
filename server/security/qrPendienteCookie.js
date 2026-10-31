// FASE 3B.1 -- cookie efímera "chapeta pendiente" (lado servidor). En FASE
// 3B.2 la Pages Function functions/qr/[codigo].js atenderá el primer GET
// <origen>/qr/<token> de la chapeta impresa (ese primer hit legacy sigue
// llegando al edge), responderá 303 a la URL visible /ganaderia/qr y dejará
// el token solo en esta cookie: HttpOnly, Path=/api/ganaderia/qr,
// SameSite=Lax, 10 minutos. El backend la consume en
// POST /api/ganaderia/qr/resolver y la borra al resolver. Sin estado en
// servidor, sin tabla, sin migración.
//
// 3B.2 debe usar el mismo nombre y atributos (la Function no puede importar
// módulos del servidor) y agregar el test de paridad correspondiente.
import { isQrToken } from '../services/ganaderia/qrCodigos.js';

export const QR_PENDIENTE_COOKIE_PATH = '/api/ganaderia/qr';
export const QR_PENDIENTE_MAX_AGE_SECONDS = 600;

function isSecureEnv(appEnv) {
  return appEnv === 'production' || appEnv === 'staging';
}

// __Secure- (no __Host-): __Host- exige Path=/ y aquí el Path está acotado.
export function qrPendienteCookieName(appEnv) {
  return isSecureEnv(appEnv) ? '__Secure-agx_qr_pendiente' : 'agx_qr_pendiente';
}

export function buildQrPendienteClearCookieHeader(appEnv) {
  const attrs = [`${qrPendienteCookieName(appEnv)}=`, 'Max-Age=0', `Path=${QR_PENDIENTE_COOKIE_PATH}`, 'HttpOnly', 'SameSite=Lax'];
  if (isSecureEnv(appEnv)) attrs.push('Secure');
  return attrs.join('; ');
}

/** Cookie header -> token QR con formato válido, o null (nunca el valor crudo inválido). */
export function getQrPendienteTokenFromCookieHeader(cookieHeader, appEnv) {
  if (!cookieHeader) return null;
  const name = qrPendienteCookieName(appEnv);
  for (const pair of String(cookieHeader).split(';')) {
    const separatorIndex = pair.indexOf('=');
    if (separatorIndex === -1) continue;
    if (pair.slice(0, separatorIndex).trim() !== name) continue;
    const value = pair.slice(separatorIndex + 1).trim();
    return isQrToken(value) ? value : null;
  }
  return null;
}

/** true si la solicitud trae la cookie (con o sin valor válido): hay que borrarla. */
export function hasQrPendienteCookie(cookieHeader, appEnv) {
  if (!cookieHeader) return false;
  const name = qrPendienteCookieName(appEnv);
  return String(cookieHeader)
    .split(';')
    .some((pair) => pair.slice(0, pair.indexOf('=') === -1 ? pair.length : pair.indexOf('=')).trim() === name);
}
