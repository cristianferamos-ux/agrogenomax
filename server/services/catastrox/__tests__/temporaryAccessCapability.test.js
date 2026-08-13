// CATX-FREEZE-01: pruebas unitarias del capability de acceso temporal --
// sin Postgres, sin red. Mismo patrón de aislamiento que
// identityCapability.test.js: cada caso fija/restaura
// process.env.CATASTROX_TEMP_ACCESS_TOKEN_KEY/CATASTROX_TEMP_ACCESS_SECRET
// explícitamente.
import test, { describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  createTemporaryAccessCapability,
  verifyTemporaryAccessCapability,
  verifyTemporaryAccessPassword,
  isValidTemporaryAccessPackageId,
} from '../temporaryAccessCapability.js';

// 32 bytes en base64 estándar canónico -- generado una sola vez para todo
// este archivo, nunca usado fuera de pruebas.
const TEST_TOKEN_KEY = 'WR0Tf6SO/JAVyhDrEgQt6GV5JyZUV8wmL/NvG1kAZoQ=';
const TEST_SECRET = 'catx-freeze-synthetic-test-secret-1234';

let originalTokenKey;
let originalSecret;

beforeEach(() => {
  originalTokenKey = process.env.CATASTROX_TEMP_ACCESS_TOKEN_KEY;
  originalSecret = process.env.CATASTROX_TEMP_ACCESS_SECRET;
  process.env.CATASTROX_TEMP_ACCESS_TOKEN_KEY = TEST_TOKEN_KEY;
  process.env.CATASTROX_TEMP_ACCESS_SECRET = TEST_SECRET;
});

afterEach(() => {
  if (originalTokenKey === undefined) delete process.env.CATASTROX_TEMP_ACCESS_TOKEN_KEY;
  else process.env.CATASTROX_TEMP_ACCESS_TOKEN_KEY = originalTokenKey;
  if (originalSecret === undefined) delete process.env.CATASTROX_TEMP_ACCESS_SECRET;
  else process.env.CATASTROX_TEMP_ACCESS_SECRET = originalSecret;
});

describe('CATX-FREEZE-01: isValidTemporaryAccessPackageId()', () => {
  test('acepta exactamente basico/plus/profesional', () => {
    assert.equal(isValidTemporaryAccessPackageId('basico'), true);
    assert.equal(isValidTemporaryAccessPackageId('plus'), true);
    assert.equal(isValidTemporaryAccessPackageId('profesional'), true);
  });

  test('rechaza cualquier otro valor', () => {
    for (const invalid of ['premium', 'pro', '', null, undefined, 'BASICO', 'basico ']) {
      assert.equal(isValidTemporaryAccessPackageId(invalid), false);
    }
  });
});

describe('CATX-FREEZE-01: verifyTemporaryAccessPassword() (crypto.timingSafeEqual)', () => {
  test('1) contraseña correcta -> true', () => {
    assert.equal(verifyTemporaryAccessPassword(TEST_SECRET), true);
  });

  test('2) contraseña incorrecta (misma longitud) -> false', () => {
    const wrong = 'x'.repeat(TEST_SECRET.length);
    assert.equal(verifyTemporaryAccessPassword(wrong), false);
  });

  test('3) longitud distinta nunca lanza, siempre false', () => {
    assert.doesNotThrow(() => verifyTemporaryAccessPassword('a'));
    assert.equal(verifyTemporaryAccessPassword('a'), false);
    assert.doesNotThrow(() => verifyTemporaryAccessPassword(TEST_SECRET + 'x'.repeat(50)));
    assert.equal(verifyTemporaryAccessPassword(TEST_SECRET + 'x'.repeat(50)), false);
  });

  test('4) valores no-string/vacíos -> false, nunca lanza', () => {
    assert.equal(verifyTemporaryAccessPassword(''), false);
    assert.equal(verifyTemporaryAccessPassword(null), false);
    assert.equal(verifyTemporaryAccessPassword(undefined), false);
    assert.equal(verifyTemporaryAccessPassword(123), false);
  });

  test('5) CATASTROX_TEMP_ACCESS_SECRET ausente -> siempre false, nunca lanza', () => {
    delete process.env.CATASTROX_TEMP_ACCESS_SECRET;
    assert.equal(verifyTemporaryAccessPassword(TEST_SECRET), false);
  });
});

describe('CATX-FREEZE-01: createTemporaryAccessCapability() / verifyTemporaryAccessCapability()', () => {
  test('6) capability válido se verifica y devuelve exactamente predio+lookup+package', () => {
    const token = createTemporaryAccessCapability({
      canonicalPredioId: 'predio-A',
      lookupId: 'lookup-A',
      packageId: 'plus',
    });
    const result = verifyTemporaryAccessCapability(token);
    assert.equal(result.ok, true);
    assert.equal(result.canonicalPredioId, 'predio-A');
    assert.equal(result.lookupId, 'lookup-A');
    assert.equal(result.packageId, 'plus');
  });

  test('7) el token nunca contiene el packageId/predio en texto plano (viaja cifrado)', () => {
    const token = createTemporaryAccessCapability({
      canonicalPredioId: 'predio-secreto-XYZ',
      lookupId: 'lookup-secreto-ABC',
      packageId: 'profesional',
    });
    assert.equal(token.includes('predio-secreto-XYZ'), false);
    assert.equal(token.includes('lookup-secreto-ABC'), false);
    assert.equal(token.includes('profesional'), false);
  });

  test('8) [BINDING] token de predio A no sirve para predio B', () => {
    const token = createTemporaryAccessCapability({ canonicalPredioId: 'predio-A', lookupId: 'lookup-A', packageId: 'basico' });
    const result = verifyTemporaryAccessCapability(token);
    assert.equal(result.ok, true);
    assert.notEqual(result.canonicalPredioId, 'predio-B');
  });

  test('9) [BINDING] token básico no sirve para plus (el consumidor debe comparar packageId)', () => {
    const token = createTemporaryAccessCapability({ canonicalPredioId: 'predio-A', lookupId: 'lookup-A', packageId: 'basico' });
    const result = verifyTemporaryAccessCapability(token);
    assert.notEqual(result.packageId, 'plus');
  });

  test('10) [BINDING] token básico no sirve para profesional', () => {
    const token = createTemporaryAccessCapability({ canonicalPredioId: 'predio-A', lookupId: 'lookup-A', packageId: 'basico' });
    const result = verifyTemporaryAccessCapability(token);
    assert.notEqual(result.packageId, 'profesional');
  });

  test('11) [BINDING] token plus no sirve para profesional', () => {
    const token = createTemporaryAccessCapability({ canonicalPredioId: 'predio-A', lookupId: 'lookup-A', packageId: 'plus' });
    const result = verifyTemporaryAccessCapability(token);
    assert.notEqual(result.packageId, 'profesional');
  });

  test('12) token alterado (un carácter distinto) se rechaza', () => {
    const token = createTemporaryAccessCapability({ canonicalPredioId: 'predio-A', lookupId: 'lookup-A', packageId: 'plus' });
    const [iv, ciphertext, authTag] = token.split('.');
    const tampered = [iv, ciphertext.slice(0, -1) + (ciphertext.slice(-1) === 'A' ? 'B' : 'A'), authTag].join('.');
    const result = verifyTemporaryAccessCapability(tampered);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'invalid');
  });

  test('13) token con formato inválido (no tres partes) se rechaza sin lanzar', () => {
    assert.doesNotThrow(() => verifyTemporaryAccessCapability('no-es-un-token-valido'));
    assert.equal(verifyTemporaryAccessCapability('no-es-un-token-valido').ok, false);
    assert.equal(verifyTemporaryAccessCapability('').ok, false);
    assert.equal(verifyTemporaryAccessCapability(null).ok, false);
    assert.equal(verifyTemporaryAccessCapability(undefined).ok, false);
  });

  test('14) token expirado se rechaza', () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const token = createTemporaryAccessCapability({
      canonicalPredioId: 'predio-A',
      lookupId: 'lookup-A',
      packageId: 'basico',
      now: nowSeconds - 20 * 60, // emitido hace 20 min, TTL es 15 min
    });
    const result = verifyTemporaryAccessCapability(token, { now: nowSeconds });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'invalid');
  });

  test('15) token dentro del TTL (15 min) se acepta', () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const token = createTemporaryAccessCapability({
      canonicalPredioId: 'predio-A',
      lookupId: 'lookup-A',
      packageId: 'basico',
      now: nowSeconds - 10 * 60, // emitido hace 10 min, TTL 15 min
    });
    const result = verifyTemporaryAccessCapability(token, { now: nowSeconds });
    assert.equal(result.ok, true);
  });

  test('16) un token creado con CATASTROX_TEMP_ACCESS_TOKEN_KEY distinto se rechaza (dominio criptográfico separado)', () => {
    const token = createTemporaryAccessCapability({ canonicalPredioId: 'predio-A', lookupId: 'lookup-A', packageId: 'basico' });
    process.env.CATASTROX_TEMP_ACCESS_TOKEN_KEY = 'hCwx16yxDbj5m9l2KGXIFtTN8mrQ6YYYZj4Pcw3RZcU=';
    const result = verifyTemporaryAccessCapability(token);
    assert.equal(result.ok, false);
  });

  test('17) crear un capability con packageId inválido lanza (nunca emite un token para un paquete inexistente)', () => {
    assert.throws(() =>
      createTemporaryAccessCapability({ canonicalPredioId: 'predio-A', lookupId: 'lookup-A', packageId: 'premium' }),
    );
  });

  test('18) verificar sin CATASTROX_TEMP_ACCESS_TOKEN_KEY configurada nunca lanza, devuelve invalid', () => {
    const token = createTemporaryAccessCapability({ canonicalPredioId: 'predio-A', lookupId: 'lookup-A', packageId: 'basico' });
    delete process.env.CATASTROX_TEMP_ACCESS_TOKEN_KEY;
    assert.doesNotThrow(() => verifyTemporaryAccessCapability(token));
    assert.equal(verifyTemporaryAccessCapability(token).ok, false);
  });
});
