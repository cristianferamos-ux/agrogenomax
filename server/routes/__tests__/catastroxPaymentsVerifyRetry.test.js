// LOTE 019-C2: resiliencia minima de fetchWompiTransaction ante fallos de
// transporte (confirmado en produccion real: Node fetch rechazo una vez con
// "fetch failed" contra sandbox.wompi.co y el intento inmediatamente siguiente,
// sin ningun otro cambio, respondio 200 con la transaccion real APPROVED).
// Maximo 1 intento inicial + 1 reintento, unicamente para fallos de transporte
// (fetch() rechaza antes de obtener respuesta). Cualquier respuesta HTTP real de
// Wompi (2xx o error) nunca se reintenta -- fetch() no rechaza por status code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchWompiTransaction, isWompiTransportError } from '../catastroxPayments.js';

const originalFetch = globalThis.fetch;

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

test('isWompiTransportError reconoce TypeError y el mensaje "fetch failed", nada mas', () => {
  assert.equal(isWompiTransportError(new TypeError('fetch failed')), true);
  assert.equal(isWompiTransportError(new Error('fetch failed')), true);
  assert.equal(isWompiTransportError(new Error('Not Found')), false);
  assert.equal(isWompiTransportError(new Error('Internal Server Error')), false);
});

test('1) primer fetch falla por transporte, el segundo responde APPROVED -> exito con exactamente 2 llamadas', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) throw new TypeError('fetch failed');
    return jsonResponse(200, { data: { id: 'txn-1', status: 'APPROVED', amount_in_cents: 3990000, currency: 'COP', reference: 'REF-1' } });
  };

  try {
    const data = await fetchWompiTransaction({ transactionId: 'txn-1', apiBaseUrl: 'https://sandbox.wompi.co/v1', publicKey: 'pub_test_x' });
    assert.equal(data.status, 'APPROVED');
    assert.equal(calls, 2);
  } finally {
    restoreFetch();
  }
});

test('2) dos fallos de transporte consecutivos -> el error de transporte se propaga tras exactamente 2 intentos', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new TypeError('fetch failed');
  };

  try {
    await assert.rejects(
      () => fetchWompiTransaction({ transactionId: 'txn-2', apiBaseUrl: 'https://sandbox.wompi.co/v1', publicKey: 'pub_test_x' }),
      (error) => isWompiTransportError(error),
    );
    assert.equal(calls, 2, 'exactamente 1 intento inicial + 1 reintento, nunca mas');
  } finally {
    restoreFetch();
  }
});

test('3) 404 real de Wompi no se reintenta', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return jsonResponse(404, { error: { reason: 'transaction_not_found' } });
  };

  try {
    await assert.rejects(
      () => fetchWompiTransaction({ transactionId: 'txn-3', apiBaseUrl: 'https://sandbox.wompi.co/v1', publicKey: 'pub_test_x' }),
      (error) => error.status === 404,
    );
    assert.equal(calls, 1, 'un 404 real es una respuesta HTTP -- fetch() no rechaza, no hay reintento');
  } finally {
    restoreFetch();
  }
});

test('4) 401 real de Wompi no se reintenta', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return jsonResponse(401, { error: { reason: 'unauthorized' } });
  };

  try {
    await assert.rejects(
      () => fetchWompiTransaction({ transactionId: 'txn-4', apiBaseUrl: 'https://sandbox.wompi.co/v1', publicKey: 'pub_test_x' }),
      (error) => error.status === 401,
    );
    assert.equal(calls, 1);
  } finally {
    restoreFetch();
  }
});

test('5) 500 real de Wompi no se reintenta', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return jsonResponse(500, { message: 'internal error' });
  };

  try {
    await assert.rejects(
      () => fetchWompiTransaction({ transactionId: 'txn-5', apiBaseUrl: 'https://sandbox.wompi.co/v1', publicKey: 'pub_test_x' }),
      (error) => error.status === 500,
    );
    assert.equal(calls, 1);
  } finally {
    restoreFetch();
  }
});

test('6) APPROVED en el primer intento no genera un segundo fetch', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return jsonResponse(200, { data: { id: 'txn-6', status: 'APPROVED', amount_in_cents: 3990000, currency: 'COP', reference: 'REF-6' } });
  };

  try {
    const data = await fetchWompiTransaction({ transactionId: 'txn-6', apiBaseUrl: 'https://sandbox.wompi.co/v1', publicKey: 'pub_test_x' });
    assert.equal(data.status, 'APPROVED');
    assert.equal(calls, 1);
  } finally {
    restoreFetch();
  }
});

// 429/409/422 tambien son respuestas HTTP reales: mismo principio que 404/401/500,
// se agrupan en una sola prueba para no repetir el mismo caso cinco veces.
test('otros status reales (409, 422, 429) tampoco se reintentan', async () => {
  for (const status of [409, 422, 429]) {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return jsonResponse(status, { message: `status ${status}` });
    };

    await assert.rejects(
      () => fetchWompiTransaction({ transactionId: `txn-${status}`, apiBaseUrl: 'https://sandbox.wompi.co/v1', publicKey: 'pub_test_x' }),
      (error) => error.status === status,
    );
    assert.equal(calls, 1, `status ${status} no debe reintentarse`);
    restoreFetch();
  }
});
