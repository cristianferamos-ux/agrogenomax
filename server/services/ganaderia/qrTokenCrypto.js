// SPRINT-3D11.3 (R1) -- cifrado autenticado del token QR para reimprimir el
// archivo del proveedor. El token NUNCA se guarda en claro.
//
//   Algoritmo: AES-256-GCM, IV aleatorio de 12 bytes, tag de 16 bytes.
//   Formato v1 (60 bytes): iv(12) || tag(16) || ciphertext(32).
//   AAD: 'agx-qr-token:v1:<codigo_visible>' -- ata el cifrado a su chapeta
//        (un valor copiado a otra fila no descifra).
//   Clave: AGX_QR_TOKEN_ENCRYPTION_KEY (base64 canónico, 32 bytes), PROPIA
//        del inventario QR -- server/config/env.js rechaza reutilizar
//        cualquier otra clave/secreto. Sin clave -> 503 QR_KEY_NOT_CONFIGURED
//        (fail-closed) en crear lote / exportar.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export const QR_TOKEN_CLAVE_VERSION = 1;
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

function semanticError(code, status, message) {
  return Object.assign(new Error(message), { status, code });
}

export function loadQrTokenKey(source = process.env) {
  const raw = source.AGX_QR_TOKEN_ENCRYPTION_KEY;
  if (typeof raw !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(raw)) {
    throw semanticError('QR_KEY_NOT_CONFIGURED', 503, 'El inventario QR no está configurado en este servidor.');
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw semanticError('QR_KEY_NOT_CONFIGURED', 503, 'El inventario QR no está configurado en este servidor.');
  }
  return key;
}

function aad(codigoVisible) {
  return Buffer.from(`agx-qr-token:v${QR_TOKEN_CLAVE_VERSION}:${codigoVisible}`, 'utf8');
}

export function encryptQrToken(token, codigoVisible, key) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(aad(codigoVisible));
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

export function decryptQrToken(blob, codigoVisible, key) {
  const buffer = Buffer.from(blob);
  if (buffer.length !== IV_BYTES + TAG_BYTES + 32) throw new Error('QR_TOKEN_CIFRADO_INVALIDO');
  const decipher = createDecipheriv(ALGORITHM, key, buffer.subarray(0, IV_BYTES));
  decipher.setAAD(aad(codigoVisible));
  decipher.setAuthTag(buffer.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  return Buffer.concat([decipher.update(buffer.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8');
}
