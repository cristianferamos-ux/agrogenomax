// LOTE 019-B: contrato de redirectUrl del checkout Wompi. La redirectUrl local
// (localhost/127.0.0.1) solo debe habilitarse en development + WOMPI_ENV=test;
// fuera de esa combinacion exacta, unicamente se permite una URL https real.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRedirectUrl, isLocalFrontendUrl, shouldSendWompiRedirectUrl } from '../catastroxPayments.js';

test('1) development + test + localhost -> redirectUrl permitida', () => {
  const allowed = shouldSendWompiRedirectUrl({
    appEnv: 'development',
    wompiEnv: 'test',
    frontendUrl: 'http://127.0.0.1:5178',
  });
  assert.equal(allowed, true);
});

test('2) production + localhost -> redirectUrl rechazada', () => {
  const allowed = shouldSendWompiRedirectUrl({
    appEnv: 'production',
    wompiEnv: 'test',
    frontendUrl: 'http://127.0.0.1:5178',
  });
  assert.equal(allowed, false);
});

test('3) staging + localhost -> redirectUrl rechazada', () => {
  const allowed = shouldSendWompiRedirectUrl({
    appEnv: 'staging',
    wompiEnv: 'test',
    frontendUrl: 'http://127.0.0.1:5178',
  });
  assert.equal(allowed, false);
});

test('4) production + URL https -> permitida', () => {
  const allowed = shouldSendWompiRedirectUrl({
    appEnv: 'production',
    wompiEnv: 'production',
    frontendUrl: 'https://agrogenomax.com',
  });
  assert.equal(allowed, true);
});

test('development + WOMPI_ENV=production + localhost -> rechazada (WOMPI_ENV tambien debe ser test)', () => {
  const allowed = shouldSendWompiRedirectUrl({
    appEnv: 'development',
    wompiEnv: 'production',
    frontendUrl: 'http://127.0.0.1:5178',
  });
  assert.equal(allowed, false);
});

test('development + test + URL https -> permitida (regla https no se rompe)', () => {
  const allowed = shouldSendWompiRedirectUrl({
    appEnv: 'development',
    wompiEnv: 'test',
    frontendUrl: 'https://staging.agrogenomax.com',
  });
  assert.equal(allowed, true);
});

test('sin frontendUrl configurado -> nunca se envia redirectUrl', () => {
  assert.equal(shouldSendWompiRedirectUrl({ appEnv: 'development', wompiEnv: 'test', frontendUrl: '' }), false);
});

test('isLocalFrontendUrl reconoce localhost y 127.0.0.1 unicamente', () => {
  assert.equal(isLocalFrontendUrl('http://127.0.0.1:5178'), true);
  assert.equal(isLocalFrontendUrl('http://localhost:5178'), true);
  assert.equal(isLocalFrontendUrl('https://agrogenomax.com'), false);
});

test('buildRedirectUrl produce una URL limpia sin datos comerciales', () => {
  const url = buildRedirectUrl({ frontendUrl: 'http://127.0.0.1:5178' });
  const parsed = new URL(url);
  assert.equal(parsed.pathname, '/catastrox/pagos/wompi/retorno');
  assert.equal([...parsed.searchParams.keys()].length, 0, 'la redirectUrl no debe llevar query params propios');
});
