import { COMMON_PASSWORD_BLOCKLIST_SET } from './data/passwordBlocklist.js';

// AUTH-001 (aprobado v2.2, §1/§2): política de contraseña moderna. Sin
// reglas de composición arbitrarias, sin truncamiento silencioso,
// normalización NFC obligatoria e idéntica al establecer/cambiar/
// verificar. Lógica pura, sin I/O, testeable de forma aislada.

export const PASSWORD_MIN_LENGTH = 15;
export const PASSWORD_MAX_LENGTH = 128;

// Coincidencia COMPLETA de la marca (tolerante a sustituciones leet
// LETRA POR LETRA -- o<->0, e<->3, a<->4/@) + sufijo trivial acotado
// (dígitos/uno de "!."), NUNCA análisis de substring libre -- una
// passphrase legítima como "trabajoenagrogenomaxtodoslosdias" NO debe
// dispararlo.
//
// Deliberadamente NO se sustituye el string completo antes de comparar
// (ver bug autodetectado en las pruebas de este módulo): eso mangla
// cualquier sufijo numérico que contenga un dígito con sustituto leet
// (0/1/3/4/5) -- p. ej. "agrogenomax2026!" se convertiría en
// "agrogenomax2o26!", que ya no matchea `\d{0,4}` y se dejaría pasar sin
// bloquear pese a ser un password trivial evidente. En su lugar, cada
// letra de la marca acepta su(s) propio(s) sustituto(s) leet vía clase de
// caracteres, y el sufijo se compara siempre sobre los dígitos literales.
const BRAND_TRIVIAL_PATTERN = /^[a4@]gr[o0]g[e3]n[o0]m[a4@]x\d{0,4}[!.]?$/;

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * NFC + minúsculas + trim -- misma normalización usada para comparar
 * contra el blocklist, el correo y el nombre. NUNCA la usada para
 * hashear (esa vive en passwordHashing.js y solo aplica NFC, preservando
 * mayúsculas/espacios reales del password).
 */
function normalizeForComparison(value) {
  return String(value).normalize('NFC').trim().toLowerCase();
}

/**
 * @param {string} password
 * @param {{emailNormalizado?: string, nombre?: string}} [contexto]
 * @returns {{ok:true} | {ok:false, code:string}}
 */
export function validatePasswordPolicy(password, contexto = {}) {
  if (!isNonEmptyString(password)) {
    return { ok: false, code: 'PASSWORD_REQUIRED' };
  }

  // Longitud en caracteres Unicode reales (code points), no en unidades
  // UTF-16 -- evita que un emoji/carácter fuera del BMP cuente como 2.
  const length = Array.from(password).length;

  if (length < PASSWORD_MIN_LENGTH) {
    return { ok: false, code: 'PASSWORD_TOO_SHORT' };
  }
  // Nunca truncar silenciosamente -- si excede el máximo, se rechaza.
  if (length > PASSWORD_MAX_LENGTH) {
    return { ok: false, code: 'PASSWORD_TOO_LONG' };
  }

  const normalized = normalizeForComparison(password);

  if (COMMON_PASSWORD_BLOCKLIST_SET.has(normalized)) {
    return { ok: false, code: 'PASSWORD_BLOCKLISTED' };
  }

  const strippedForBrandCheck = normalized.replace(/[\s.\-_]/g, '');
  if (BRAND_TRIVIAL_PATTERN.test(strippedForBrandCheck)) {
    return { ok: false, code: 'PASSWORD_BLOCKLISTED' };
  }

  if (isNonEmptyString(contexto.emailNormalizado) && normalized === normalizeForComparison(contexto.emailNormalizado)) {
    return { ok: false, code: 'PASSWORD_BLOCKLISTED' };
  }

  // Nombre: solo coincidencia EXACTA, y solo si el nombre normalizado
  // tiene una longitud mínima razonable -- evita falsos disparos con
  // nombres de una letra o iniciales.
  if (isNonEmptyString(contexto.nombre)) {
    const nombreNormalizado = normalizeForComparison(contexto.nombre);
    if (nombreNormalizado.length >= 4 && normalized === nombreNormalizado) {
      return { ok: false, code: 'PASSWORD_BLOCKLISTED' };
    }
  }

  return { ok: true };
}
