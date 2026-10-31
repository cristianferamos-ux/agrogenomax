// FASE 3B: token QR "pendiente de resolver" SOLO en memoria del SPA. Nunca
// en la URL, el historial (location.state), localStorage, sessionStorage
// ni el HTML. Lo deja el escáner (o una URL antigua /qr/<token> o
// /ganaderia/qr/<token> que llegó al SPA) justo antes de navegar a la URL
// limpia /ganaderia/qr; el resolver lo envía en el body de
// POST /api/ganaderia/qr/resolver. Caduca en 10 minutos y se descarta al
// obtener una respuesta definitiva. Una recarga lo pierde: la chapeta
// impresa sigue funcionando por la cookie HttpOnly de la Pages Function.
import { isQrToken, qrResolverPath } from './qrToken.js';

export const QR_PENDIENTE_TTL_MS = 10 * 60 * 1000;

let pendiente = null;

export function guardarTokenPendiente(token, now = Date.now()) {
  if (isQrToken(token)) pendiente = { token, expira: now + QR_PENDIENTE_TTL_MS };
}

export function leerTokenPendiente(now = Date.now()) {
  if (!pendiente) return null;
  if (pendiente.expira <= now) {
    pendiente = null;
    return null;
  }
  return pendiente.token;
}

export function descartarTokenPendiente() {
  pendiente = null;
}

/**
 * Lectura válida (parseQrContent) -> ruta del resolver. Un token se guarda
 * en memoria y la ruta es la URL limpia; un código (no secreto) va en la ruta.
 */
export function rutaResolverQr(parsed) {
  if (parsed?.kind === 'token') guardarTokenPendiente(parsed.token);
  return qrResolverPath(parsed);
}
