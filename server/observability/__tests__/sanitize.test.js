// FASE 3B: sanitizador central de observabilidad (server/observability/sanitize.js).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  REDACTED,
  isSensitiveKey,
  sanitizeBody,
  sanitizeErrorMeta,
  sanitizeHeaders,
  sanitizeQuery,
  sanitizeUrl,
} from '../sanitize.js';

const QR_TOKEN = 'aB3_-xYz09QwErTyUiOpAsDfGhJkLzXc';
const SHA = 'a'.repeat(64);
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJh';

describe('FASE 3B: sanitize.js', () => {
  test('claves sensibles: lista explícita (token, secret, password, authorization, cookie, csrf, api key, database url, hash...)', () => {
    for (const key of [
      'token', 'qrToken', 'token_hash', 'tokenCifrado', 'recoveryToken', 'session_token', 'password', 'contrasena',
      'Authorization', 'cookie', 'X-CSRF-Token', 'csrfToken', 'apiKey', 'api_key', 'DATABASE_URL', 'databaseUrl',
      'client_secret', 'AGX_QR_TOKEN_ENCRYPTION_KEY', 'privateKey',
    ]) {
      assert.ok(isSensitiveKey(key), key);
    }
    for (const key of ['nombre', 'animalId', 'estado', 'codigoVisible', 'limit']) {
      assert.equal(isSensitiveKey(key), false, key);
    }
  });

  test('body: claves y valores sensibles redactados, anidados y en arrays', () => {
    const out = sanitizeBody({
      nombre: 'Lola',
      token: QR_TOKEN,
      nested: { password: 'secreto123', ok: 1, lista: [{ csrf: 'x' }, QR_TOKEN] },
      libre: QR_TOKEN,
      hash: SHA,
      jwt: JWT,
      conexion: 'postgres://u:p@host:5432/db',
    });
    assert.equal(out.nombre, 'Lola');
    assert.equal(out.token, REDACTED);
    assert.equal(out.nested.password, REDACTED);
    assert.equal(out.nested.ok, 1);
    assert.equal(out.nested.lista[0].csrf, REDACTED);
    assert.equal(out.nested.lista[1], REDACTED, 'valor con forma de token QR');
    assert.equal(out.libre, REDACTED);
    assert.equal(out.hash, REDACTED);
    assert.equal(out.jwt, REDACTED);
    assert.equal(out.conexion, REDACTED);
    const serialized = JSON.stringify(out);
    for (const leak of [QR_TOKEN, 'secreto123', SHA, JWT, 'postgres://']) assert.ok(!serialized.includes(leak), leak);
  });

  test('cabeceras: Authorization, Cookie, Set-Cookie, X-CSRF-Token y Referer siempre redactadas', () => {
    const out = sanitizeHeaders({
      Authorization: 'Bearer abc.def',
      cookie: '__Host-agx_session=s3cr3t; __Secure-agx_qr_pendiente=' + QR_TOKEN,
      'X-CSRF-Token': 'csrf-value',
      referer: `https://agrogenomax.com/qr/${QR_TOKEN}`,
      'set-cookie': ['a=b'],
      'content-type': 'application/json',
      'x-request-id': '4612e456-7890-4abc-8def-740987654321',
    });
    assert.equal(out.authorization, REDACTED);
    assert.equal(out.cookie, REDACTED);
    assert.equal(out['x-csrf-token'], REDACTED);
    assert.equal(out.referer, REDACTED);
    assert.equal(out['set-cookie'], REDACTED);
    assert.equal(out['content-type'], 'application/json');
    assert.ok(!JSON.stringify(out).includes(QR_TOKEN));
    assert.ok(!JSON.stringify(out).includes('s3cr3t'));
  });

  test('URL: segmento token QR / hash / JWT redactado, query sensible redactada, sin fragmento', () => {
    assert.equal(sanitizeUrl(`/qr/${QR_TOKEN}`), `/qr/${REDACTED}`);
    assert.equal(sanitizeUrl(`/api/ganaderia/qr/token/${QR_TOKEN}`), `/api/ganaderia/qr/token/${REDACTED}`);
    assert.equal(sanitizeUrl(`https://agrogenomax.com/qr/${QR_TOKEN}#x`), `https://agrogenomax.com/qr/${REDACTED}`);
    assert.equal(sanitizeUrl('/api/ganaderia/qr/codigo/AGX-7KM4-P2XZ-R'), '/api/ganaderia/qr/codigo/AGX-7KM4-P2XZ-R');
    assert.equal(sanitizeUrl('/api/ganaderia/animales/123/qr'), '/api/ganaderia/animales/123/qr');
    const q = sanitizeUrl(`/restablecer?token=${QR_TOKEN}&limit=10&x=${SHA}`);
    assert.ok(!q.includes(QR_TOKEN) && !q.includes(SHA));
    assert.match(q, /limit=10/);
    assert.equal(sanitizeUrl(`/x/${encodeURIComponent(JWT)}`), `/x/${REDACTED}`);
    assert.equal(sanitizeUrl(''), '');
    assert.equal(sanitizeUrl(undefined), '');
  });

  test('query: objeto o URLSearchParams', () => {
    assert.deepEqual(sanitizeQuery({ token: QR_TOKEN, limit: '5' }), { token: REDACTED, limit: '5' });
    assert.deepEqual(sanitizeQuery(new URLSearchParams(`password=x&q=lola`)), { password: REDACTED, q: 'lola' });
  });

  test('metadatos de error: solo code con forma de código y status entero; nunca message/stack/detail/SQL', () => {
    const pgError = Object.assign(new Error('duplicate key value violates unique constraint "qr_chapeta_tokens_token_hash_key"'), {
      code: '23505', detail: `Key (token_hash)=(${SHA}) already exists.`, constraint: 'qr_chapeta_tokens_token_hash_key', status: 500,
    });
    assert.deepEqual(sanitizeErrorMeta(pgError), { errorCode: '23505', errorStatus: 500 });
    assert.deepEqual(sanitizeErrorMeta(Object.assign(new Error('x'), { code: 'token=abc; DROP' })), {});
    assert.deepEqual(sanitizeErrorMeta(null), {});
    const hostil = {};
    Object.defineProperty(hostil, 'code', { get() { throw new Error('boom'); } });
    assert.deepEqual(sanitizeErrorMeta(hostil), {});
  });

  test('nunca lanza ante entradas raras (ciclos, profundidad, tipos exóticos)', () => {
    const ciclo = { a: 1 };
    ciclo.self = ciclo;
    assert.doesNotThrow(() => sanitizeBody(ciclo));
    assert.doesNotThrow(() => sanitizeBody({ f() {}, s: Symbol('x'), b: 10n }));
    assert.doesNotThrow(() => sanitizeHeaders(null));
    assert.doesNotThrow(() => sanitizeUrl('http://[malformada'));
  });
});
