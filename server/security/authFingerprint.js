import crypto from 'crypto';
import { ipKeyGenerator } from 'express-rate-limit';

// AUTH-001 (aprobado v2.2, §5/§6): fingerprints con separación de dominio
// -- HMAC-SHA256(secreto, `${domain}\0${valorNormalizado}`), nunca
// sha256(valor) plano (baja entropía, enumerable offline). El secreto
// (AGX_AUTH_FINGERPRINT_SECRET) SIEMPRE se recibe como parámetro
// explícito -- este módulo nunca lee process.env directamente, mismo
// criterio que computeCsrfToken en server/security/ganaderiaSession.js.

/**
 * lower(trim(email)) -- misma normalización que la columna generada
 * `agx.cuentas.email_normalizado` (lower(trim(email)) STORED). Debe
 * producir SIEMPRE el mismo resultado que Postgres, para que el
 * fingerprint de un email calculado en la aplicación coincida con el que
 * se derivaría de la fila real.
 */
export function normalizeEmail(email) {
  return String(email).trim().toLowerCase();
}

/**
 * `req.ip` (ya resuelto por Express según TRUST_PROXY_HOPS -- nunca se
 * parsea X-Forwarded-For aquí) -> forma canónica vía `ipKeyGenerator` de
 * express-rate-limit, con el segundo argumento SIEMPRE `64` explícito
 * (el default de la librería es `56` -- nunca se debe depender de él).
 * Colapsa IPv4 e IPv4-mapeada-en-IPv6 a la misma identidad lógica;
 * trunca IPv6 real a su bloque /64.
 */
export function normalizeIp(rawIp) {
  return ipKeyGenerator(rawIp, 64);
}

/**
 * @param {'email'|'ip'} domain
 * @param {string} normalizedValue - ya normalizado (normalizeEmail/normalizeIp)
 * @param {string} fingerprintSecretBase64 - AGX_AUTH_FINGERPRINT_SECRET, base64, 32 bytes
 * @returns {string} hex minúsculas, 64 caracteres
 */
export function computeFingerprint(domain, normalizedValue, fingerprintSecretBase64) {
  const keyBytes = Buffer.from(fingerprintSecretBase64, 'base64');
  const message = `${domain}\0${normalizedValue}`;
  return crypto.createHmac('sha256', keyBytes).update(message, 'utf8').digest('hex');
}
