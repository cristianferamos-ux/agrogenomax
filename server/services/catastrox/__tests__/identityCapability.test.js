// Pruebas unitarias de server/services/catastrox/identityCapability.js
// (R3/B6-26 + B6-26-ADJ-01). SIN Postgres, SIN red -- claves sintéticas
// generadas dentro de este archivo, nunca reales ni compartidas con ningún
// otro proceso. Cada test que necesita forjar un payload "autenticado pero
// inválido" lo construye directamente con node:crypto (mismo formato que
// el propio módulo), en vez de exponer primitivas internas nuevas en la
// API productiva.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';

const VERIFY_KEY_B64 = crypto.randomBytes(32).toString('base64');
const CHECKOUT_KEY_B64 = crypto.randomBytes(32).toString('base64');
process.env.CATASTROX_VERIFY_HANDLE_KEY = VERIFY_KEY_B64;
process.env.CATASTROX_CHECKOUT_IDENTITY_KEY = CHECKOUT_KEY_B64;

const {
  createVerificationHandle,
  verifyVerificationHandle,
  createCheckoutIdentityCapability,
  verifyCheckoutIdentityCapability,
} = await import('../identityCapability.js');

const CUSTOMER_ID = crypto.randomUUID();
const EMAIL_HASH = crypto.createHash('sha256').update('victima@example.com').digest('hex');

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

// Reconstruye el formato exacto del módulo (iv.ciphertext.authTag en
// base64url, AES-256-GCM, AAD = purpose) para forjar payloads "autenticados
// pero inválidos" que el propio API productiva nunca produciría por sí
// sola (JSON corrupto, v incorrecta, purpose interno mentiroso, etc.).
function encodeRawToken(keyB64, aad, plaintextBuffer) {
  const key = Buffer.from(keyB64, 'base64');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintextBuffer), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString('base64url'), ciphertext.toString('base64url'), authTag.toString('base64url')].join('.');
}

function encodeRawJsonToken(keyB64, aad, payload) {
  return encodeRawToken(keyB64, aad, Buffer.from(JSON.stringify(payload), 'utf8'));
}

// Voltea el primer byte de un segmento base64url -- preserva la longitud,
// suficiente para invalidar la autenticación GCM sin cambiar la forma del
// token.
function tamperSegment(segment) {
  const buf = Buffer.from(segment, 'base64url');
  buf[0] = buf[0] ^ 0xff;
  return buf.toString('base64url');
}

test('1) verification handle: roundtrip devuelve exactamente customerId/emailHash originales', () => {
  const token = createVerificationHandle({ customerId: CUSTOMER_ID, emailHash: EMAIL_HASH });
  const result = verifyVerificationHandle(token);
  assert.equal(result.ok, true);
  assert.equal(result.customerId, CUSTOMER_ID);
  assert.equal(result.emailHash, EMAIL_HASH);
});

test('2) checkout identity capability: roundtrip devuelve exactamente customerId/emailHash originales', () => {
  const token = createCheckoutIdentityCapability({ customerId: CUSTOMER_ID, emailHash: EMAIL_HASH });
  const result = verifyCheckoutIdentityCapability(token);
  assert.equal(result.ok, true);
  assert.equal(result.customerId, CUSTOMER_ID);
  assert.equal(result.emailHash, EMAIL_HASH);
});

test('3) un verificationHandle NUNCA valida como checkout identity capability', () => {
  const token = createVerificationHandle({ customerId: CUSTOMER_ID, emailHash: EMAIL_HASH });
  const result = verifyCheckoutIdentityCapability(token);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid');
});

test('4) una checkout identity capability NUNCA valida como verification handle', () => {
  const token = createCheckoutIdentityCapability({ customerId: CUSTOMER_ID, emailHash: EMAIL_HASH });
  const result = verifyVerificationHandle(token);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid');
});

test('5) ciphertext alterado -> inválido', () => {
  const token = createVerificationHandle({ customerId: CUSTOMER_ID, emailHash: EMAIL_HASH });
  const [iv, ciphertext, tag] = token.split('.');
  const tampered = [iv, tamperSegment(ciphertext), tag].join('.');
  assert.equal(verifyVerificationHandle(tampered).ok, false);
});

test('6) authTag alterado -> inválido', () => {
  const token = createVerificationHandle({ customerId: CUSTOMER_ID, emailHash: EMAIL_HASH });
  const [iv, ciphertext, tag] = token.split('.');
  const tampered = [iv, ciphertext, tamperSegment(tag)].join('.');
  assert.equal(verifyVerificationHandle(tampered).ok, false);
});

test('7) IV alterado -> inválido', () => {
  const token = createVerificationHandle({ customerId: CUSTOMER_ID, emailHash: EMAIL_HASH });
  const [iv, ciphertext, tag] = token.split('.');
  const tampered = [tamperSegment(iv), ciphertext, tag].join('.');
  assert.equal(verifyVerificationHandle(tampered).ok, false);
});

test('8) token con solo 2 segmentos -> inválido', () => {
  const token = createVerificationHandle({ customerId: CUSTOMER_ID, emailHash: EMAIL_HASH });
  const [iv, ciphertext] = token.split('.');
  assert.equal(verifyVerificationHandle([iv, ciphertext].join('.')).ok, false);
});

test('9) token con 4 segmentos -> inválido', () => {
  const token = createVerificationHandle({ customerId: CUSTOMER_ID, emailHash: EMAIL_HASH });
  assert.equal(verifyVerificationHandle(`${token}.extra`).ok, false);
});

test('10) basura base64url en los tres segmentos -> inválido, nunca lanza', () => {
  assert.doesNotThrow(() => {
    const result = verifyVerificationHandle('!!!not-base64!!!.###also-not###.$$$nope$$$');
    assert.equal(result.ok, false);
  });
});

test('11) payload autenticado pero JSON inválido -> inválido', () => {
  const token = encodeRawToken(VERIFY_KEY_B64, 'VERIFY_HANDLE_V1', Buffer.from('esto no es json{', 'utf8'));
  assert.equal(verifyVerificationHandle(token).ok, false);
});

test('12) payload autenticado con v incorrecta -> inválido', () => {
  const now = nowSeconds();
  const payload = { v: 2, purpose: 'VERIFY_HANDLE_V1', customerId: CUSTOMER_ID, emailHash: EMAIL_HASH, iat: now, exp: now + 600 };
  const token = encodeRawJsonToken(VERIFY_KEY_B64, 'VERIFY_HANDLE_V1', payload);
  assert.equal(verifyVerificationHandle(token).ok, false);
});

test('13) AAD correcta pero payload.purpose interno mentiroso -> inválido (un VERIFY_HANDLE jamás valida como checkout ni viceversa, ni siquiera falsificando el campo interno)', () => {
  const now = nowSeconds();
  // AAD = VERIFY_HANDLE_V1 (coincide con lo que espera verifyVerificationHandle),
  // pero el campo interno del payload dice CHECKOUT_IDENTITY_V1 -- debe
  // rechazarse por el chequeo explícito de payload.purpose, no solo por AAD.
  const payload = { v: 1, purpose: 'CHECKOUT_IDENTITY_V1', customerId: CUSTOMER_ID, emailHash: EMAIL_HASH, iat: now, exp: now + 600 };
  const token = encodeRawJsonToken(VERIFY_KEY_B64, 'VERIFY_HANDLE_V1', payload);
  assert.equal(verifyVerificationHandle(token).ok, false);
});

test('14) customerId inválido: create lanza, y un payload forjado con customerId malformado -> inválido en verify', () => {
  assert.throws(() => createVerificationHandle({ customerId: 'not-a-uuid', emailHash: EMAIL_HASH }));

  const now = nowSeconds();
  const payload = { v: 1, purpose: 'VERIFY_HANDLE_V1', customerId: 'not-a-uuid', emailHash: EMAIL_HASH, iat: now, exp: now + 600 };
  const token = encodeRawJsonToken(VERIFY_KEY_B64, 'VERIFY_HANDLE_V1', payload);
  assert.equal(verifyVerificationHandle(token).ok, false);
});

test('15) emailHash inválido: create lanza, y un payload forjado con emailHash malformado -> inválido en verify', () => {
  assert.throws(() => createVerificationHandle({ customerId: CUSTOMER_ID, emailHash: 'no-es-un-hash-hex' }));

  const now = nowSeconds();
  const payload = { v: 1, purpose: 'VERIFY_HANDLE_V1', customerId: CUSTOMER_ID, emailHash: 'no-es-un-hash-hex', iat: now, exp: now + 600 };
  const token = encodeRawJsonToken(VERIFY_KEY_B64, 'VERIFY_HANDLE_V1', payload);
  assert.equal(verifyVerificationHandle(token).ok, false);
});

test('16) exp <= iat -> inválido', () => {
  const t = nowSeconds();
  const payload = { v: 1, purpose: 'VERIFY_HANDLE_V1', customerId: CUSTOMER_ID, emailHash: EMAIL_HASH, iat: t, exp: t };
  const token = encodeRawJsonToken(VERIFY_KEY_B64, 'VERIFY_HANDLE_V1', payload);
  assert.equal(verifyVerificationHandle(token, { now: t }).ok, false);
});

test('17) token expirado (now >= exp) -> inválido', () => {
  const start = 1_700_000_000;
  const token = createVerificationHandle({ customerId: CUSTOMER_ID, emailHash: EMAIL_HASH, now: start });
  assert.equal(verifyVerificationHandle(token, { now: start + 600 }).ok, false, 'inválido exactamente al cumplirse el TTL');
  assert.equal(verifyVerificationHandle(token, { now: start + 601 }).ok, false, 'inválido después de expirado');
});

test('18) iat futuro más allá del margen de reloj (60s) -> inválido', () => {
  const baseline = 1_700_000_000;
  const iat = baseline + 61;
  const payload = { v: 1, purpose: 'VERIFY_HANDLE_V1', customerId: CUSTOMER_ID, emailHash: EMAIL_HASH, iat, exp: iat + 600 };
  const token = encodeRawJsonToken(VERIFY_KEY_B64, 'VERIFY_HANDLE_V1', payload);
  assert.equal(verifyVerificationHandle(token, { now: baseline }).ok, false);
});

test('19) iat futuro dentro del margen de reloj permitido (<=60s) -> válido', () => {
  const baseline = 1_700_000_000;
  const iat = baseline + 59;
  const payload = { v: 1, purpose: 'VERIFY_HANDLE_V1', customerId: CUSTOMER_ID, emailHash: EMAIL_HASH, iat, exp: iat + 600 };
  const token = encodeRawJsonToken(VERIFY_KEY_B64, 'VERIFY_HANDLE_V1', payload);
  const result = verifyVerificationHandle(token, { now: baseline });
  assert.equal(result.ok, true);
});

test('20) verificar con la clave equivocada -> inválido', () => {
  const token = createVerificationHandle({ customerId: CUSTOMER_ID, emailHash: EMAIL_HASH });
  const original = process.env.CATASTROX_VERIFY_HANDLE_KEY;
  process.env.CATASTROX_VERIFY_HANDLE_KEY = crypto.randomBytes(32).toString('base64');
  try {
    assert.equal(verifyVerificationHandle(token).ok, false);
  } finally {
    process.env.CATASTROX_VERIFY_HANDLE_KEY = original;
  }
});

test('21) clave ausente: create lanza (fail closed); verify nunca lanza, devuelve inválido', () => {
  const token = createVerificationHandle({ customerId: CUSTOMER_ID, emailHash: EMAIL_HASH });
  const original = process.env.CATASTROX_VERIFY_HANDLE_KEY;
  delete process.env.CATASTROX_VERIFY_HANDLE_KEY;
  try {
    assert.throws(() => createVerificationHandle({ customerId: CUSTOMER_ID, emailHash: EMAIL_HASH }));
    assert.doesNotThrow(() => {
      const result = verifyVerificationHandle(token);
      assert.equal(result.ok, false);
    });
  } finally {
    process.env.CATASTROX_VERIFY_HANDLE_KEY = original;
  }
});

test('22) clave mal formada (no es base64 canónico) -> lanza al crear', () => {
  const original = process.env.CATASTROX_VERIFY_HANDLE_KEY;
  process.env.CATASTROX_VERIFY_HANDLE_KEY = 'no-es-base64-valido!!';
  try {
    assert.throws(() => createVerificationHandle({ customerId: CUSTOMER_ID, emailHash: EMAIL_HASH }));
  } finally {
    process.env.CATASTROX_VERIFY_HANDLE_KEY = original;
  }
});

test('23) clave de longitud incorrecta (no decodifica a 32 bytes) -> lanza al crear', () => {
  const original = process.env.CATASTROX_VERIFY_HANDLE_KEY;
  process.env.CATASTROX_VERIFY_HANDLE_KEY = crypto.randomBytes(16).toString('base64');
  try {
    assert.throws(() => createVerificationHandle({ customerId: CUSTOMER_ID, emailHash: EMAIL_HASH }));
  } finally {
    process.env.CATASTROX_VERIFY_HANDLE_KEY = original;
  }
});

test('24) TTL de verification handle es exactamente 10 minutos', () => {
  const start = 1_700_000_000;
  const token = createVerificationHandle({ customerId: CUSTOMER_ID, emailHash: EMAIL_HASH, now: start });
  assert.equal(verifyVerificationHandle(token, { now: start + 600 - 1 }).ok, true, 'aún válido 1s antes de cumplir 10 min');
  assert.equal(verifyVerificationHandle(token, { now: start + 600 }).ok, false, 'inválido exactamente a los 10 min');
});

test('25) TTL de checkout identity capability es exactamente 10 minutos', () => {
  const start = 1_700_000_000;
  const token = createCheckoutIdentityCapability({ customerId: CUSTOMER_ID, emailHash: EMAIL_HASH, now: start });
  assert.equal(verifyCheckoutIdentityCapability(token, { now: start + 600 - 1 }).ok, true, 'aún válida 1s antes de cumplir 10 min');
  assert.equal(verifyCheckoutIdentityCapability(token, { now: start + 600 }).ok, false, 'inválida exactamente a los 10 min');
});
