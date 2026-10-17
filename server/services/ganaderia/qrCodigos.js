// SPRINT-3D11.3 (R1) -- identificadores de una chapeta QR, todos generados
// con CSPRNG (crypto.randomBytes) e independientes entre sí:
//   * token QR (secreto, va dentro del QR): 24 bytes = 192 bits, base64url
//     de 32 caracteres. En base se guarda su SHA-256 (token_hash) y, para
//     reimpresión, el token cifrado (qrTokenCrypto.js) -- nunca en claro.
//   * código visible (impreso, se digita en campo): AGX-XXXX-XXXX-C con un
//     alfabeto de 32 símbolos sin O/0/I/1 (40 bits aleatorios) + dígito de
//     control C (Luhn mod 32): toda sustitución de un carácter y casi toda
//     transposición adyacente da un código inválido, detectable sin red.
//   * código de lote: LQR-AAAAMMDD-XXXX.
// Ninguno deriva de otro, de animal_id, de la organización ni de una
// secuencia. La misma normalización/validación existe en el frontend
// (src/modules/ganaderia/hato/qrToken.js) y en SQL (fn_qr_codigo_control_ok).
import { createHash, randomBytes } from 'node:crypto';

export const QR_TOKEN_BYTES = 24;
export const QR_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32}$/;
// 32 símbolos: A-Z sin I/O + 2-9 (sin 0/1). 256 % 32 === 0 -> sin sesgo.
export const CODIGO_ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODIGO_VISIBLE_PATTERN = /^AGX-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]$/;
export const CODIGO_LEGACY_PATTERN = /^AGX-[0-9]{6}$/;
const MOD = CODIGO_ALFABETO.length;

function randomSymbols(length) {
  const bytes = randomBytes(length);
  let out = '';
  for (const byte of bytes) out += CODIGO_ALFABETO[byte & 31];
  return out;
}

/** Luhn mod 32: carácter de control para un cuerpo de símbolos del alfabeto. */
export function digitoControl(cuerpo) {
  let factor = 2;
  let suma = 0;
  for (let i = cuerpo.length - 1; i >= 0; i -= 1) {
    const sumando = factor * CODIGO_ALFABETO.indexOf(cuerpo[i]);
    factor = factor === 2 ? 1 : 2;
    suma += Math.floor(sumando / MOD) + (sumando % MOD);
  }
  return CODIGO_ALFABETO[(MOD - (suma % MOD)) % MOD];
}

/** true si el cuerpo + control (9 símbolos) satisface Luhn mod 32. */
function controlValido(cuerpoConControl) {
  let factor = 1;
  let suma = 0;
  for (let i = cuerpoConControl.length - 1; i >= 0; i -= 1) {
    const index = CODIGO_ALFABETO.indexOf(cuerpoConControl[i]);
    if (index < 0) return false;
    const sumando = factor * index;
    factor = factor === 2 ? 1 : 2;
    suma += Math.floor(sumando / MOD) + (sumando % MOD);
  }
  return suma % MOD === 0;
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
  const cuerpo = randomSymbols(8);
  return `AGX-${cuerpo.slice(0, 4)}-${cuerpo.slice(4)}-${digitoControl(cuerpo)}`;
}

export function generateCodigoLote(now = new Date()) {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return `LQR-${y}${m}${d}-${randomSymbols(4)}`;
}

/** Código QR_AGX canónico con dígito de control correcto. */
export function isCodigoNuevoValido(value) {
  return typeof value === 'string' && CODIGO_VISIBLE_PATTERN.test(value) && controlValido(value.slice(4).replace(/-/g, ''));
}

/**
 * Código digitado en campo -> código canónico o null. Tolera minúsculas,
 * espacios, guiones faltantes/sobrantes y el prefijo omitido:
 *   "agx 7km4 p2xz h", "7KM4P2XZH", "AGX7KM4-P2XZH" -> "AGX-7KM4-P2XZ-H"
 *   "agx-000003", "000003"                       -> "AGX-000003" (legacy)
 * Un código nuevo con el dígito de control incorrecto (error de digitación)
 * -> null: inválido sin consultar el backend.
 */
export function normalizeCodigoVisible(rawValue) {
  if (typeof rawValue !== 'string') return null;
  const compact = rawValue.toUpperCase().replace(/[\s_-]+/g, '');
  if (compact.length === 0 || compact.length > 16) return null;
  if (/^(?:AGX)?[0-9]{6}$/.test(compact)) return `AGX-${compact.slice(-6)}`;
  // Prefijo AGX solo cuando la longitud lo confirma (un cuerpo nuevo puede
  // empezar por A, G o X).
  const body = compact.length === 12 && compact.startsWith('AGX') ? compact.slice(3) : compact;
  if (!/^[A-HJ-NP-Z2-9]{9}$/.test(body) || !controlValido(body)) return null;
  return `AGX-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8)}`;
}

export function isCodigoVisible(value) {
  return typeof value === 'string' && (isCodigoNuevoValido(value) || CODIGO_LEGACY_PATTERN.test(value));
}
