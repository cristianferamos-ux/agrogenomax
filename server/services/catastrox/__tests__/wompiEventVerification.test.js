import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import {
  computeWompiEventChecksum,
  isAllowedWompiEventType,
  verifyWompiEventSignature,
} from '../wompiEventVerification.js';

const SECRET = 'events_secret_de_prueba_con_treinta_dos_caracteres_o_mas';

function buildValidPayload({ secret = SECRET, overrides = {} } = {}) {
  const data = {
    transaction: {
      id: 'txn-abc',
      status: 'APPROVED',
      amount_in_cents: 3990000,
      reference: 'CATX-BASICO-REF-1',
    },
  };
  const timestamp = 1732550400;
  const properties = ['transaction.id', 'transaction.status', 'transaction.amount_in_cents', 'transaction.reference'];
  const checksum = computeWompiEventChecksum({ properties, data, timestamp, secret });

  return {
    event: 'transaction.updated',
    data,
    environment: 'test',
    timestamp,
    sent_at: new Date().toISOString(),
    signature: { properties, checksum },
    ...overrides,
  };
}

test('computeWompiEventChecksum es determinista y depende del orden de properties', () => {
  const data = { transaction: { id: 'a', status: 'APPROVED' } };
  const a = computeWompiEventChecksum({ properties: ['transaction.id', 'transaction.status'], data, timestamp: 1, secret: 's' });
  const b = computeWompiEventChecksum({ properties: ['transaction.id', 'transaction.status'], data, timestamp: 1, secret: 's' });
  const c = computeWompiEventChecksum({ properties: ['transaction.status', 'transaction.id'], data, timestamp: 1, secret: 's' });
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test('verifyWompiEventSignature: firma válida -> valid true', () => {
  const payload = buildValidPayload();
  const result = verifyWompiEventSignature(payload, SECRET);
  assert.equal(result.valid, true);
});

test('verifyWompiEventSignature: firma inválida (checksum incorrecto) -> rechazada', () => {
  const payload = buildValidPayload();
  payload.signature.checksum = crypto.createHash('sha256').update('otro-valor-cualquiera').digest('hex');
  const result = verifyWompiEventSignature(payload, SECRET);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'checksum_mismatch');
});

test('verifyWompiEventSignature: secreto distinto al usado para firmar -> rechazada', () => {
  const payload = buildValidPayload({ secret: SECRET });
  const result = verifyWompiEventSignature(payload, 'otro_secreto_completamente_distinto_treinta_dos');
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'checksum_mismatch');
});

test('verifyWompiEventSignature: payload manipulado (monto alterado tras firmar) -> rechazada', () => {
  const payload = buildValidPayload();
  payload.data.transaction.amount_in_cents = 1;
  const result = verifyWompiEventSignature(payload, SECRET);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'checksum_mismatch');
});

test('verifyWompiEventSignature: checksum de longitud distinta a un sha256 hex -> rechazada sin comparar', () => {
  const payload = buildValidPayload();
  payload.signature.checksum = 'abc123';
  const result = verifyWompiEventSignature(payload, SECRET);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'malformed_checksum');
});

test('verifyWompiEventSignature: sin secreto configurado -> rechazada explícitamente', () => {
  const payload = buildValidPayload();
  const result = verifyWompiEventSignature(payload, '');
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'events_secret_not_configured');
});

test('verifyWompiEventSignature: payloads malformados se rechazan sin lanzar', () => {
  const secret = SECRET;
  const malformedCases = [
    null,
    undefined,
    {},
    { event: '', data: {}, signature: { properties: ['a'], checksum: 'x'.repeat(64) }, timestamp: 1 },
    { event: 'transaction.updated', data: null, signature: { properties: ['a'], checksum: 'x'.repeat(64) }, timestamp: 1 },
    { event: 'transaction.updated', data: {}, signature: { properties: [], checksum: 'x'.repeat(64) }, timestamp: 1 },
    { event: 'transaction.updated', data: {}, signature: { properties: ['a'] }, timestamp: 1 },
    { event: 'transaction.updated', data: {}, signature: { properties: ['a'], checksum: 'x'.repeat(64) }, timestamp: 'no-numerico' },
    { event: 'transaction.updated', data: {}, signature: { properties: ['a'], checksum: 'x'.repeat(64) }, timestamp: -5 },
  ];

  for (const payload of malformedCases) {
    assert.doesNotThrow(() => {
      const result = verifyWompiEventSignature(payload, secret);
      assert.equal(result.valid, false);
      assert.equal(result.reason, 'malformed_payload');
    });
  }
});

test('isAllowedWompiEventType: solo transaction.updated está permitido', () => {
  assert.equal(isAllowedWompiEventType('transaction.updated'), true);
  assert.equal(isAllowedWompiEventType('nequi_token.updated'), false);
  assert.equal(isAllowedWompiEventType(''), false);
  assert.equal(isAllowedWompiEventType(undefined), false);
});
