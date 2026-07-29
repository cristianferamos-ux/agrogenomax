// LOTE 019-B: contrato de redirectUrl del checkout Wompi. La redirectUrl local
// (localhost/127.0.0.1) solo debe habilitarse en development + WOMPI_ENV=test;
// fuera de esa combinacion exacta, unicamente se permite una URL https real.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildIdempotencyKey,
  buildRedirectUrl,
  isLocalFrontendUrl,
  isValidPurchaseAttemptId,
  shouldSendWompiRedirectUrl,
} from '../catastroxPayments.js';

// Bloque 6 (revisión de seguridad): idempotencia de doble clic por
// purchaseAttemptId -- nunca de predio+paquete solos, y ya no depende de
// una ventana temporal (ver comentario en catastroxPayments.js).
const ATTEMPT_A = '11111111-1111-4111-8111-111111111111';
const ATTEMPT_B = '22222222-2222-4222-8222-222222222222';

test('buildIdempotencyKey: mismo comprador+predio+paquete+purchaseAttemptId -> misma llave (reutilizable por un reintento inmediato)', () => {
  const a = buildIdempotencyKey({ customerId: 'cust-1', canonicalPredioId: 'predio-1', packageId: 'basico', purchaseAttemptId: ATTEMPT_A });
  const b = buildIdempotencyKey({ customerId: 'cust-1', canonicalPredioId: 'predio-1', packageId: 'basico', purchaseAttemptId: ATTEMPT_A });
  assert.equal(a, b);
});

test('buildIdempotencyKey: compradores distintos NUNCA comparten llave, aunque sea el mismo predio+paquete+purchaseAttemptId', () => {
  const a = buildIdempotencyKey({ customerId: 'cust-1', canonicalPredioId: 'predio-1', packageId: 'basico', purchaseAttemptId: ATTEMPT_A });
  const b = buildIdempotencyKey({ customerId: 'cust-2', canonicalPredioId: 'predio-1', packageId: 'basico', purchaseAttemptId: ATTEMPT_A });
  assert.notEqual(a, b);
});

test('buildIdempotencyKey: predios o paquetes distintos producen llaves distintas', () => {
  const base = { customerId: 'cust-1', canonicalPredioId: 'predio-1', packageId: 'basico', purchaseAttemptId: ATTEMPT_A };
  assert.notEqual(buildIdempotencyKey(base), buildIdempotencyKey({ ...base, canonicalPredioId: 'predio-2' }));
  assert.notEqual(buildIdempotencyKey(base), buildIdempotencyKey({ ...base, packageId: 'plus' }));
});

test('buildIdempotencyKey: purchaseAttemptId distinto -> llave distinta (una compra explícita posterior nunca reutiliza la orden, sin importar el tiempo transcurrido)', () => {
  const a = buildIdempotencyKey({ customerId: 'cust-1', canonicalPredioId: 'predio-1', packageId: 'basico', purchaseAttemptId: ATTEMPT_A });
  const b = buildIdempotencyKey({ customerId: 'cust-1', canonicalPredioId: 'predio-1', packageId: 'basico', purchaseAttemptId: ATTEMPT_B });
  assert.notEqual(a, b);
});

test('isValidPurchaseAttemptId: acepta únicamente el formato UUID exacto', () => {
  assert.equal(isValidPurchaseAttemptId(ATTEMPT_A), true);
  assert.equal(isValidPurchaseAttemptId(''), false);
  assert.equal(isValidPurchaseAttemptId('no-es-un-uuid'), false);
  assert.equal(isValidPurchaseAttemptId(null), false);
  assert.equal(isValidPurchaseAttemptId(undefined), false);
  assert.equal(isValidPurchaseAttemptId('11111111-1111-4111-8111-11111111111'), false); // un carácter corto
  assert.equal(isValidPurchaseAttemptId(`${ATTEMPT_A}; DROP TABLE catastrox_payment_orders;`), false);
});

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
