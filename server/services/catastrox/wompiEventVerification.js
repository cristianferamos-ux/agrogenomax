// Verificación de la firma de eventos (webhook) de Wompi.
//
// Mecanismo (documentación oficial de Wompi, "Eventos"): el payload trae
// `signature.properties` (rutas dentro de `data`, en el orden que define el
// checksum), `signature.checksum` y `timestamp` (unix, entero). El checksum
// se calcula concatenando en orden: los valores de `data` señalados por
// `properties`, luego `timestamp`, luego un secreto de eventos -- DISTINTO
// del secreto de integridad usado para firmar el checkout
// (WOMPI_INTEGRITY_SECRET_TEST) -- con SHA256. El mismo checksum también
// viaja en el header `X-Event-Checksum`, pero la fuente de verdad aquí es
// siempre recomputar desde el body: un atacante que controle el body podría
// controlar cualquier header que él mismo envíe, así que el header nunca
// sustituye la recomputación.
//
// Nunca se confía en `data` para monto/estado/paquete -- este módulo solo
// autentica que el evento vino de Wompi. server/routes/catastroxPayments.js
// SIEMPRE re-consulta la transacción server-to-server (fetchWompiTransaction)
// antes de aplicar cualquier cambio de estado a una orden.

import crypto from 'crypto';

const SHA256_HEX_LENGTH = 64;

function getByPath(obj, path) {
  return String(path)
    .split('.')
    .reduce((acc, key) => (acc === null || acc === undefined ? undefined : acc[key]), obj);
}

/**
 * @param {{ properties: string[], data: object, timestamp: number|string, secret: string }} input
 * @returns {string} checksum SHA256 en hexadecimal minúscula.
 */
export function computeWompiEventChecksum({ properties, data, timestamp, secret }) {
  const concatenatedValues = properties.map((path) => {
    const value = getByPath(data, path);
    return value === null || value === undefined ? '' : String(value);
  });

  const payload = `${concatenatedValues.join('')}${timestamp}${secret}`;
  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
}

function isValidEventPayloadShape(payload) {
  if (!payload || typeof payload !== 'object') return false;
  if (typeof payload.event !== 'string' || !payload.event.trim()) return false;
  if (!payload.data || typeof payload.data !== 'object') return false;

  const signature = payload.signature;
  if (!signature || typeof signature !== 'object') return false;
  if (!Array.isArray(signature.properties) || signature.properties.length === 0) return false;
  if (!signature.properties.every((p) => typeof p === 'string' && p.trim())) return false;
  if (typeof signature.checksum !== 'string' || !signature.checksum.trim()) return false;

  const timestamp = payload.timestamp;
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp <= 0) return false;

  return true;
}

function timingSafeEqualHex(hexA, hexB) {
  // Longitud de un hex SHA256 es una constante pública (64) -- comparar
  // longitudes primero no filtra nada sensible del secreto. Un checksum
  // recibido con otra longitud simplemente no puede ser válido.
  if (hexA.length !== hexB.length) return false;

  const bufferA = Buffer.from(hexA, 'utf8');
  const bufferB = Buffer.from(hexB, 'utf8');
  if (bufferA.length !== bufferB.length) return false;

  return crypto.timingSafeEqual(bufferA, bufferB);
}

/**
 * Verifica la autenticidad de un evento de Wompi ya parseado como JSON.
 * Nunca lanza -- siempre devuelve un resultado explícito para que la ruta
 * decida el código HTTP sin depender de manejo de excepciones.
 *
 * @param {unknown} payload body ya parseado (express.json()).
 * @param {string} secret WOMPI_EVENTS_SECRET_TEST (u homólogo de producción).
 * @returns {{ valid: boolean, reason?: string }}
 */
export function verifyWompiEventSignature(payload, secret) {
  if (!secret) {
    return { valid: false, reason: 'events_secret_not_configured' };
  }

  if (!isValidEventPayloadShape(payload)) {
    return { valid: false, reason: 'malformed_payload' };
  }

  const expectedChecksum = computeWompiEventChecksum({
    properties: payload.signature.properties,
    data: payload.data,
    timestamp: payload.timestamp,
    secret,
  });

  const receivedChecksum = String(payload.signature.checksum).trim().toLowerCase();

  if (receivedChecksum.length !== SHA256_HEX_LENGTH) {
    return { valid: false, reason: 'malformed_checksum' };
  }

  if (!timingSafeEqualHex(expectedChecksum, receivedChecksum)) {
    return { valid: false, reason: 'checksum_mismatch' };
  }

  return { valid: true };
}

export const WOMPI_ALLOWED_EVENT_TYPES = Object.freeze(['transaction.updated']);

export function isAllowedWompiEventType(eventType) {
  return WOMPI_ALLOWED_EVENT_TYPES.includes(String(eventType || ''));
}
