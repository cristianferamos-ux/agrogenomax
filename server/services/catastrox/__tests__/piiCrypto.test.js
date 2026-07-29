// Requiere CATASTROX_PII_ENCRYPTION_KEY/CATASTROX_PII_HASH_SECRET
// configuradas (server/.env local) -- se auto-omite si no lo están, mismo
// criterio que las pruebas de integración con Postgres real.
import test from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';

dotenv.config({ path: '.env', quiet: true });
dotenv.config({ path: 'server/.env', quiet: true });

const keysConfigured = Boolean(process.env.CATASTROX_PII_ENCRYPTION_KEY && process.env.CATASTROX_PII_HASH_SECRET);

const { encryptPii, decryptPii, hashPii, hashDocumentNumber, hashEmail, normalizeEmail, normalizeDocumentNumber } = await import(
  '../piiCrypto.js'
);

test('encryptPii/decryptPii: round-trip exacto', { skip: !keysConfigured }, () => {
  const plaintext = 'documento-de-prueba-1234567890';
  const encrypted = encryptPii(plaintext);
  assert.notEqual(encrypted, plaintext);
  assert.equal(decryptPii(encrypted), plaintext);
});

test('encryptPii: valores distintos producen ciphertext distinto (IV aleatorio, nunca determinista)', { skip: !keysConfigured }, () => {
  const a = encryptPii('mismo-valor');
  const b = encryptPii('mismo-valor');
  assert.notEqual(a, b, 'el mismo texto claro cifrado dos veces no debe producir el mismo ciphertext');
  assert.equal(decryptPii(a), 'mismo-valor');
  assert.equal(decryptPii(b), 'mismo-valor');
});

test('encryptPii: cadena vacía -> null (nunca cifra un valor vacío como si fuera real)', { skip: !keysConfigured }, () => {
  assert.equal(encryptPii(''), null);
  assert.equal(encryptPii(null), null);
  assert.equal(encryptPii(undefined), null);
});

test('decryptPii: valor corrupto/manipulado -> lanza, nunca devuelve datos parciales', { skip: !keysConfigured }, () => {
  const encrypted = encryptPii('valor-real');
  const tampered = encrypted.slice(0, -4) + 'AAAA';
  assert.throws(() => decryptPii(tampered));
});

test('decryptPii: formato inválido (no 3 partes) -> lanza', { skip: !keysConfigured }, () => {
  assert.throws(() => decryptPii('formato-invalido-sin-puntos'));
});

test('hashPii: determinista (mismo valor -> mismo hash) y sensible a mayúsculas/espacios ya normalizados por el llamador', { skip: !keysConfigured }, () => {
  const a = hashPii('1032456789');
  const b = hashPii('1032456789');
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test('hashPii: valores distintos -> hashes distintos', { skip: !keysConfigured }, () => {
  assert.notEqual(hashPii('1032456789'), hashPii('1032456780'));
});

test('hashPii: cadena vacía -> null', { skip: !keysConfigured }, () => {
  assert.equal(hashPii(''), null);
  assert.equal(hashPii(null), null);
});

test('normalizeEmail: trim + lowercase', () => {
  assert.equal(normalizeEmail('  Ana@Example.COM '), 'ana@example.com');
});

test('normalizeDocumentNumber: elimina espacios, puntos y guiones', () => {
  assert.equal(normalizeDocumentNumber(' 10.324-567 89 '), '1032456789');
});

// --- Separación de dominios (endurecimiento criptográfico final) ---------
//
// hashDocumentNumber()/hashEmail() hashean sobre "catastrox:document:v1:"/
// "catastrox:email:v1:" + el valor normalizado, nunca el valor desnudo --
// nunca deben coincidir con hashPii() genérico ni entre sí para el mismo
// texto.

test('hashDocumentNumber/hashEmail: el MISMO texto usado como documento y como correo produce hashes DISTINTOS (separación de dominios)', { skip: !keysConfigured }, () => {
  const sameText = '12345678900';
  const asDocument = hashDocumentNumber(sameText);
  const asEmail = hashEmail(sameText);
  assert.notEqual(asDocument, asEmail, 'el prefijo de dominio debe impedir que el mismo texto colisione entre campos');
});

test('hashDocumentNumber: determinista -- el mismo documento normalizado siempre produce el mismo hash', { skip: !keysConfigured }, () => {
  const a = hashDocumentNumber('1032456789');
  const b = hashDocumentNumber('1032456789');
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test('hashDocumentNumber: normaliza internamente (espacios/puntos/guiones) -- entradas equivalentes producen el mismo hash', { skip: !keysConfigured }, () => {
  assert.equal(hashDocumentNumber('10.324-567 89'), hashDocumentNumber('1032456789'));
});

test('hashEmail: determinista -- el mismo correo normalizado siempre produce el mismo hash', { skip: !keysConfigured }, () => {
  const a = hashEmail('ana@example.com');
  const b = hashEmail('ana@example.com');
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test('hashEmail: mayúsculas/espacios en el correo normalizan al MISMO hash', { skip: !keysConfigured }, () => {
  assert.equal(hashEmail('  Ana@Example.COM '), hashEmail('ana@example.com'));
});

test('hashDocumentNumber/hashEmail: valores distintos -> hashes distintos (dentro del mismo dominio)', { skip: !keysConfigured }, () => {
  assert.notEqual(hashDocumentNumber('1032456789'), hashDocumentNumber('1032456780'));
  assert.notEqual(hashEmail('ana@example.com'), hashEmail('otra@example.com'));
});

test('hashDocumentNumber/hashEmail: NUNCA coinciden con hashPii() genérico del mismo valor desnudo (dominios/versión distintos producen hashes distintos)', { skip: !keysConfigured }, () => {
  const value = '1032456789';
  assert.notEqual(hashDocumentNumber(value), hashPii(value));
  assert.notEqual(hashEmail('ana@example.com'), hashPii('ana@example.com'));
});

test('hashDocumentNumber/hashEmail: cadena vacía -> null', { skip: !keysConfigured }, () => {
  assert.equal(hashDocumentNumber(''), null);
  assert.equal(hashDocumentNumber(null), null);
  assert.equal(hashEmail(''), null);
  assert.equal(hashEmail(null), null);
});
