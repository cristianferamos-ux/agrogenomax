// SPRINT-3D11.3 (R1) -- identificadores de una chapeta QR, todos generados
// con CSPRNG (crypto.randomBytes) e independientes entre sí:
//   * token QR (secreto, va dentro del QR): 24 bytes = 192 bits, base64url
//     de 32 caracteres. En base solo se guarda su SHA-256 (token_hash).
//   * código visible (impreso, se digita en campo): AGX-XXXX-XXXX con un
//     alfabeto de 32 símbolos sin O/0/I/1 = 40 bits; no secuencial.
//   * código de lote: LQR-AAAAMMDD-XXXX.
// Ninguno deriva de otro, de animal_id, de la organización ni de una
// secuencia.
import { createHash, randomBytes } from 'node:crypto';

export const QR_TOKEN_BYTES = 24;
export const QR_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32}$/;
// 32 símbolos: A-Z sin I/O + 2-9 (sin 0/1). 256 % 32 === 0 -> sin sesgo.
export const CODIGO_ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODIGO_VISIBLE_PATTERN = /^AGX-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;
export const CODIGO_LEGACY_PATTERN = /^AGX-[0-9]{6}$/;

function randomSymbols(length) {
  const bytes = randomBytes(length);
  let out = '';
  for (const byte of bytes) out += CODIGO_ALFABETO[byte & 31];
  return out;
}

export function generateQrToken() {
  return randomBytes(QR_TOKEN_BYTES).toString('base64url');
}

export function isQrToken(value) {
  return typeof value === 'string' && QR_TOKEN_PATTERN.test(value);
}

export function hashQrToken(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function generateCodigoVisible() {
  const symbols = randomSymbols(8);
  return `AGX-${symbols.slice(0, 4)}-${symbols.slice(4)}`;
}

export function generateCodigoLote(now = new Date()) {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return `LQR-${y}${m}${d}-${randomSymbols(4)}`;
}

/**
 * Código digitado en campo -> código canónico o null. Tolera minúsculas,
 * espacios, guiones faltantes o sobrantes y el prefijo omitido:
 * "agx 7km4 p2xz", "7KM4P2XZ", "AGX7KM4-P2XZ" -> "AGX-7KM4-P2XZ";
 * "agx-000003", "000003" -> "AGX-000003" (legacy).
 */
export function normalizeCodigoVisible(rawValue) {
  if (typeof rawValue !== 'string') return null;
  const compact = rawValue.toUpperCase().replace(/[\s_-]+/g, '');
  if (compact.length === 0 || compact.length > 16) return null;
  // Prefijo AGX solo cuando la longitud lo confirma (un cuerpo nuevo puede
  // empezar por A, G o X).
  const conPrefijo = compact.startsWith('AGX') && (compact.length === 11 || compact.length === 9);
  const body = conPrefijo ? compact.slice(3) : compact;
  if (/^[0-9]{6}$/.test(body)) return `AGX-${body}`;
  if (/^[A-HJ-NP-Z2-9]{8}$/.test(body)) return `AGX-${body.slice(0, 4)}-${body.slice(4)}`;
  return null;
}

export function isCodigoVisible(value) {
  return typeof value === 'string' && (CODIGO_VISIBLE_PATTERN.test(value) || CODIGO_LEGACY_PATTERN.test(value));
}
