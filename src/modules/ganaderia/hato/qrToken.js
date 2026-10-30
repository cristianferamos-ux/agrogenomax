// SPRINT-3D11.3 (R1): lectura de una chapeta QR AgroGenomaX (escaneo o
// digitación). Módulo puro, sin red. Reemplaza qr/normalizeQrCode.js
// (legacy), que pasaba todo a MAYÚSCULAS y corrompería el token base64url.
//   * QR escaneado -> https://<dominio>/qr/<token> (token secreto, 32 chars)
//   * Código visible impreso -> AGX-7KM4-P2XZ-R (nuevo, con dígito de control
//     Luhn mod 32 validable sin red) o AGX-000003 (legacy)
// Ambos se resuelven contra la copia local (offline) o /api/ganaderia/qr/*
// bajo la organización de la sesión. Misma normalización y control que el
// servidor (server/services/ganaderia/qrCodigos.js) y SQL.

export const QR_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32}$/;
export const CODIGO_VISIBLE_PATTERN = /^AGX-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]$/;
export const CODIGO_LEGACY_PATTERN = /^AGX-[0-9]{6}$/;
const CODIGO_ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const QR_PATH_PATTERN = /^\/(?:ganaderia\/)?qr\/([^/?#]+)\/?$/;

export function isQrToken(value) {
  return typeof value === 'string' && QR_TOKEN_PATTERN.test(value);
}

/** Luhn mod 32 sobre cuerpo + control (mismo algoritmo que el servidor y SQL). */
export function controlValido(cuerpoConControl) {
  let factor = 1;
  let suma = 0;
  for (let i = cuerpoConControl.length - 1; i >= 0; i -= 1) {
    const index = CODIGO_ALFABETO.indexOf(cuerpoConControl[i]);
    if (index < 0) return false;
    const sumando = factor * index;
    factor = factor === 2 ? 1 : 2;
    suma += Math.floor(sumando / 32) + (sumando % 32);
  }
  return suma % 32 === 0;
}

export function isCodigoChapeta(value) {
  if (typeof value !== 'string') return false;
  if (CODIGO_LEGACY_PATTERN.test(value)) return true;
  return CODIGO_VISIBLE_PATTERN.test(value) && controlValido(value.slice(4).replace(/-/g, ''));
}

/**
 * "agx 7km4 p2xz r", "7KM4P2XZR", "000003" -> código canónico o null. Un
 * error de digitación (dígito de control que no cuadra) -> null, sin red.
 */
export function normalizeCodigoChapeta(rawValue) {
  if (typeof rawValue !== 'string') return null;
  const compact = rawValue.toUpperCase().replace(/[\s_-]+/g, '');
  if (compact.length === 0 || compact.length > 16) return null;
  if (/^(?:AGX)?[0-9]{6}$/.test(compact)) return `AGX-${compact.slice(-6)}`;
  const body = compact.length === 12 && compact.startsWith('AGX') ? compact.slice(3) : compact;
  if (!/^[A-HJ-NP-Z2-9]{9}$/.test(body) || !controlValido(body)) return null;
  return `AGX-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8)}`;
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
 * FASE 2B: el 410 puede traer animalId (vínculo histórico) SOLO si el
 * servidor lo resolvió bajo la organización de la sesión -> "Ver ficha".
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
  if (status === 410) {
    const animalId = typeof data?.animalId === 'string' && /^[1-9]\d{0,17}$/.test(data.animalId) ? data.animalId : null;
    return { status: 'no_operativa', estado: ESTADO_CHAPETA_LABELS[data?.estado] ?? 'Fuera de uso', animalId };
  }
  return { status: 'error' };
}
