import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import {
  RECOVERY_COOKIE_NAME,
  buildRecoveryClearCookieHeader,
  buildRecoverySetCookieHeader,
  getRecoverySessionTokenFromCookieHeader,
} from '../recoveryCookie.js';

test('getRecoverySessionTokenFromCookieHeader: extrae el valor correcto entre varios cookies', () => {
  const header = `otra_cookie=algo; ${RECOVERY_COOKIE_NAME}=abc123; tercera=xyz`;
  assert.equal(getRecoverySessionTokenFromCookieHeader(header), 'abc123');
});

test('getRecoverySessionTokenFromCookieHeader: decodifica el valor (URL-encoded)', () => {
  const token = 'abc/def+123=';
  const header = `${RECOVERY_COOKIE_NAME}=${encodeURIComponent(token)}`;
  assert.equal(getRecoverySessionTokenFromCookieHeader(header), token);
});

test('getRecoverySessionTokenFromCookieHeader: sin header -> null', () => {
  assert.equal(getRecoverySessionTokenFromCookieHeader(undefined), null);
  assert.equal(getRecoverySessionTokenFromCookieHeader(''), null);
  assert.equal(getRecoverySessionTokenFromCookieHeader(null), null);
});

test('getRecoverySessionTokenFromCookieHeader: cookie ausente entre otros -> null', () => {
  assert.equal(getRecoverySessionTokenFromCookieHeader('otra=algo; mas=cosas'), null);
});

test('getRecoverySessionTokenFromCookieHeader: valor vacío -> null (nunca cadena vacía como token válido)', () => {
  assert.equal(getRecoverySessionTokenFromCookieHeader(`${RECOVERY_COOKIE_NAME}=`), null);
});

test('getRecoverySessionTokenFromCookieHeader: valor mal codificado -> null, no lanza', () => {
  assert.doesNotThrow(() => {
    const result = getRecoverySessionTokenFromCookieHeader(`${RECOVERY_COOKIE_NAME}=%`);
    assert.equal(result, null);
  });
});

test('buildRecoverySetCookieHeader: incluye HttpOnly, SameSite=Lax y el Path cubre /api/catastrox (pagos + lookups/full-result)', () => {
  const header = buildRecoverySetCookieHeader({ token: 'tok-xyz', appEnv: 'development' });
  assert.match(header, /HttpOnly/);
  assert.match(header, /SameSite=Lax/);
  // Ampliado desde /api/catastrox/payments (corrección de seguridad:
  // full-result vive fuera de ese prefijo, ver server/routes/catastrox.js
  // resolveFullResultAccess) -- exactamente '/api/catastrox;', no un
  // subconjunto más angosto.
  assert.match(header, /Path=\/api\/catastrox;/);
  assert.match(header, new RegExp(`${RECOVERY_COOKIE_NAME}=tok-xyz`));
});

test('buildRecoverySetCookieHeader: Secure solo en staging/production, nunca en development', () => {
  assert.doesNotMatch(buildRecoverySetCookieHeader({ token: 't', appEnv: 'development' }), /Secure/);
  assert.doesNotMatch(buildRecoverySetCookieHeader({ token: 't', appEnv: 'test' }), /Secure/);
  assert.match(buildRecoverySetCookieHeader({ token: 't', appEnv: 'staging' }), /Secure/);
  assert.match(buildRecoverySetCookieHeader({ token: 't', appEnv: 'production' }), /Secure/);
});

test('buildRecoverySetCookieHeader: el valor va URL-encoded (nunca caracteres crudos peligrosos en el header)', () => {
  const header = buildRecoverySetCookieHeader({ token: 'a b;c', appEnv: 'development' });
  assert.match(header, new RegExp(`${RECOVERY_COOKIE_NAME}=${encodeURIComponent('a b;c')}`));
});

test('el valor emitido por buildRecoverySetCookieHeader se recupera exacto con getRecoverySessionTokenFromCookieHeader (round-trip)', () => {
  const token = crypto.randomUUID();
  const setCookieHeader = buildRecoverySetCookieHeader({ token, appEnv: 'production' });
  // El header Set-Cookie completo (con atributos) no es directamente el
  // header Cookie que el navegador reenvía -- se simula extrayendo solo el
  // par name=value, como haría un cliente HTTP real.
  const nameValue = setCookieHeader.split(';')[0];
  assert.equal(getRecoverySessionTokenFromCookieHeader(nameValue), token);
});

test('buildRecoveryClearCookieHeader: Max-Age=0 y mismos atributos Path/SameSite que el de emisión', () => {
  const header = buildRecoveryClearCookieHeader({ appEnv: 'production' });
  assert.match(header, /Max-Age=0/);
  assert.match(header, /Path=\/api\/catastrox;/);
  assert.match(header, /SameSite=Lax/);
  assert.match(header, /Secure/);
});
