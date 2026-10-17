// SPRINT-3D11.3 (R1) -- token QR_AGX: CSPRNG, >= 128 bits, opaco.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  QR_AGX_TOKEN_BYTES,
  QR_AGX_TOKEN_PATTERN,
  generateQrAgxToken,
  isQrAgxToken,
} from '../ganaderia/animalQrToken.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const tokenSource = fs.readFileSync(path.join(here, '..', 'ganaderia', 'animalQrToken.js'), 'utf8');

test('token: 24 bytes aleatorios (192 bits >= 128) en base64url de 32 caracteres', () => {
  assert.ok(QR_AGX_TOKEN_BYTES * 8 >= 128);
  const token = generateQrAgxToken();
  assert.match(token, QR_AGX_TOKEN_PATTERN);
  assert.equal(Buffer.from(token, 'base64url').length, QR_AGX_TOKEN_BYTES);
});

test('token: 5000 generaciones sin repetidos', () => {
  const tokens = new Set(Array.from({ length: 5000 }, generateQrAgxToken));
  assert.equal(tokens.size, 5000);
});

test('token: usa crypto.randomBytes y no recibe datos del animal (sin parámetros, sin Math.random ni secuencias)', () => {
  assert.equal(generateQrAgxToken.length, 0);
  assert.match(tokenSource, /randomBytes\(QR_AGX_TOKEN_BYTES\)/);
  assert.doesNotMatch(tokenSource, /Math\.random|Date\.now|nextval/);
});

test('isQrAgxToken: acepta solo 32 caracteres base64url', () => {
  assert.equal(isQrAgxToken(generateQrAgxToken()), true);
  for (const value of ['', 'AGX-000003', 'A'.repeat(31), 'A'.repeat(33), `${'A'.repeat(31)}=`, `${'A'.repeat(31)}/`, null, undefined, 42]) {
    assert.equal(isQrAgxToken(value), false, String(value));
  }
});
