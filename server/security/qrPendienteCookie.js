// FASE 3B -- cookie efímera "chapeta pendiente". La chapeta impresa abre
// GET <origen>/qr/<token>; la Pages Function functions/qr/[codigo].js
// responde 303 a la URL limpia /ganaderia/qr y deja el token SOLO en esta
// cookie: HttpOnly (el JS del SPA nunca lo ve), Path=/api/ganaderia/qr (no
// viaja a ninguna otra ruta), SameSite=Lax, 10 minutos. El backend la
// consume en POST /api/ganaderia/qr/resolver y la borra al resolver.
// Sin estado en servidor, sin tabla, sin migración.
//
// Mismo nombre y atributos que la Function (que no puede importar módulos
// del servidor): functions/qr/__tests__ verifica que ambos coincidan.
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
