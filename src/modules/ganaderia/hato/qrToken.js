// SPRINT-3D11.3 (R1): lectura de una chapeta QR AgroGenomaX (escaneo o
// digitación). Módulo puro, sin red. Reemplaza qr/normalizeQrCode.js
// (legacy), que pasaba todo a MAYÚSCULAS y corrompería el token base64url.
//   * QR escaneado -> https://<dominio>/qr/<token> (token secreto, 32 chars)
//   * Código visible impreso -> AGX-7KM4-P2XZ (nuevo) o AGX-000003 (legacy)
// Ambos se resuelven SOLO contra /api/ganaderia/qr/* bajo la organización
// de la sesión. Misma normalización de código que el servidor (qrCodigos.js).

export const QR_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32}$/;
export const CODIGO_VISIBLE_PATTERN = /^AGX-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;
export const CODIGO_LEGACY_PATTERN = /^AGX-[0-9]{6}$/;
const QR_PATH_PATTERN = /^\/(?:ganaderia\/)?qr\/([^/?#]+)\/?$/;

export function isQrToken(value) {
  return typeof value === 'string' && QR_TOKEN_PATTERN.test(value);
}

export function isCodigoChapeta(value) {
  return typeof value === 'string' && (CODIGO_VISIBLE_PATTERN.test(value) || CODIGO_LEGACY_PATTERN.test(value));
}

/** "agx 7km4 p2xz", "7KM4P2XZ", "000003" -> código canónico o null. */
export function normalizeCodigoChapeta(rawValue) {
  if (typeof rawValue !== 'string') return null;
  const compact = rawValue.toUpperCase().replace(/[\s_-]+/g, '');
  if (compact.length === 0 || compact.length > 16) return null;
  const conPrefijo = compact.startsWith('AGX') && (compact.length === 11 || compact.length === 9);
  const body = conPrefijo ? compact.slice(3) : compact;
  if (/^[0-9]{6}$/.test(body)) return `AGX-${body}`;
  if (/^[A-HJ-NP-Z2-9]{8}$/.test(body)) return `AGX-${body.slice(0, 4)}-${body.slice(4)}`;
  return null;
}

function classify(value) {
  if (isQrToken(value)) return { kind: 'token', token: value };
  const codigo = normalizeCodigoChapeta(decodeURIComponentSafe(value));
  return codigo ? { kind: 'codigo', codigo } : null;
}

function decodeURIComponentSafe(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Contenido escaneado o escrito -> { kind: 'token', token } |
 * { kind: 'codigo', codigo } | { kind: 'invalid' }. Acepta el valor suelto
 * o una URL /qr/<valor> (o /ganaderia/qr/<valor>) de cualquier host: solo
 * se extrae el valor, nunca se navega a la URL leída. El token conserva
 * mayúsculas/minúsculas.
 */
export function parseQrContent(rawValue) {
  const raw = String(rawValue ?? '').trim();
  if (!raw) return { kind: 'invalid' };
  const direct = classify(raw);
  if (direct) return direct;

  let pathname = null;
  try {
    const url = new URL(raw);
    if (url.protocol === 'https:' || url.protocol === 'http:') pathname = url.pathname;
  } catch {
    pathname = raw.startsWith('/') ? raw.split(/[?#]/)[0] : null;
  }
  const match = pathname ? pathname.match(QR_PATH_PATTERN) : null;
  return (match && classify(match[1])) || { kind: 'invalid' };
}

/** Ruta privada del resolver para un token o un código canónico. */
export function qrResolverPath(parsed) {
  return `/ganaderia/qr/${parsed.kind === 'token' ? parsed.token : parsed.codigo}`;
}

export const ESTADO_CHAPETA_LABELS = Object.freeze({
  ASIGNADO_ORGANIZACION: 'Disponible',
  ASIGNADO_ANIMAL: 'En uso',
  REVOCADO: 'Revocada',
  DANADO: 'Dañada',
  REEMPLAZADO: 'Reemplazada',
});

/**
 * Respuesta de GET /api/ganaderia/qr/{token|codigo}/:valor -> pantalla:
 *   200 ANIMAL     -> ficha del animal
 *   200 DISPONIBLE -> registro de animal con esa chapeta
 *   404            -> un único estado controlado (inexistente / otra organización)
 *   410            -> chapeta fuera de uso (revocada / dañada / reemplazada)
 */
export function qrResolutionOutcome({ ok, status, data } = {}) {
  if (ok && data?.resultado === 'ANIMAL' && typeof data.animalId === 'string' && /^[1-9]\d{0,17}$/.test(data.animalId)) {
    return { status: 'found', to: `/ganaderia/animales/${data.animalId}` };
  }
  const codigo = data?.chapeta?.codigoVisible;
  if (ok && data?.resultado === 'DISPONIBLE' && isCodigoChapeta(codigo)) {
    return { status: 'found', to: `/ganaderia/animales/nuevo?chapeta=${encodeURIComponent(codigo)}` };
  }
  if (status === 404) return { status: 'not_found' };
  if (status === 410) return { status: 'no_operativa', estado: ESTADO_CHAPETA_LABELS[data?.estado] ?? 'Fuera de uso' };
  return { status: 'error' };
}
