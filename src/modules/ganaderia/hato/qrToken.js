// SPRINT-3D11.3 (R1): lectura del contenido de un QR AGX. Reemplaza el uso
// de qr/normalizeQrCode.js (legacy), que pasaba todo a MAYÚSCULAS y
// corrompería el token base64url (sensible a mayúsculas). Módulo puro, sin
// red: el token solo se resuelve contra GET /api/ganaderia/qr/:token.

export const QR_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32}$/;
const LEGACY_CODE_PATTERN = /\bAGX-\d{1,12}\b/i;
const QR_PATH_PATTERN = /^\/(?:ganaderia\/)?qr\/([^/?#]+)\/?$/;

export function isQrToken(value) {
  return typeof value === 'string' && QR_TOKEN_PATTERN.test(value);
}

/**
 * Contenido escaneado o escrito -> { kind: 'token', token } |
 * { kind: 'legacy' } | { kind: 'invalid' }. Acepta el token suelto o una
 * URL /qr/<token> (o /ganaderia/qr/<token>) de cualquier host: solo se
 * extrae el token, nunca se navega a la URL leída.
 */
export function parseQrContent(rawValue) {
  const raw = String(rawValue ?? '').trim();
  if (!raw) return { kind: 'invalid' };
  if (isQrToken(raw)) return { kind: 'token', token: raw };

  let pathname = null;
  try {
    const url = new URL(raw);
    if (url.protocol === 'https:' || url.protocol === 'http:') pathname = url.pathname;
  } catch {
    pathname = raw.startsWith('/') ? raw.split(/[?#]/)[0] : null;
  }
  const match = pathname ? pathname.match(QR_PATH_PATTERN) : null;
  if (match && isQrToken(match[1])) return { kind: 'token', token: match[1] };

  // Códigos impresos del sistema anterior (AGX-000001, ...): aún no
  // migrados -- nunca se consultan contra la API.
  if (LEGACY_CODE_PATTERN.test(raw)) return { kind: 'legacy' };
  return { kind: 'invalid' };
}

export function qrResolverPath(token) {
  return `/ganaderia/qr/${token}`;
}

export function qrPublicUrl(token, origin = globalThis.location?.origin ?? '') {
  return `${origin}/qr/${token}`;
}

/**
 * Respuesta de GET /api/ganaderia/qr/:token -> estado de pantalla. 404
 * (otra organización, revocado, reemplazado, inexistente) es un único
 * estado controlado: la UI no distingue los casos.
 */
export function qrResolutionOutcome({ ok, status, data } = {}) {
  if (ok && typeof data?.animalId === 'string' && /^[1-9]\d{0,17}$/.test(data.animalId)) {
    return { status: 'found', to: `/ganaderia/animales/${data.animalId}` };
  }
  if (status === 404) return { status: 'not_found' };
  return { status: 'error' };
}
