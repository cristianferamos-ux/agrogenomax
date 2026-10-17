// SPRINT-3D11.3 (R1) -- token QR_AGX: 24 bytes de crypto.randomBytes
// (CSPRNG, 192 bits) en base64url sin padding = 32 caracteres. Opaco: no
// codifica animal_id, secuencias, organización ni datos del animal.
import { randomBytes } from 'node:crypto';

export const QR_AGX_TOKEN_BYTES = 24;
export const QR_AGX_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32}$/;

export function generateQrAgxToken() {
  return randomBytes(QR_AGX_TOKEN_BYTES).toString('base64url');
}

export function isQrAgxToken(value) {
  return typeof value === 'string' && QR_AGX_TOKEN_PATTERN.test(value);
}
