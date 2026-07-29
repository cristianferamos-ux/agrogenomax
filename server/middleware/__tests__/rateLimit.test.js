import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { checkoutLimiter, webhookLimiter } from '../rateLimit.js';

async function startApp(limiter) {
  const app = express();
  app.get('/probe', limiter, (_req, res) => res.json({ ok: true }));
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  return { baseUrl: `http://127.0.0.1:${port}/probe`, close: () => new Promise((resolve) => server.close(resolve)) };
}

// checkoutLimiter es un singleton importado (mismo store en memoria en todo
// el proceso de test) -- una sola prueba cubre "dentro del límite" y
// "supera el límite" en secuencia, para no depender del orden de ejecución
// entre pruebas ni de contadores que se acumulan entre casos separados.
test('checkoutLimiter: pasa dentro del límite y responde 429 (sin exponer detalles internos) al superarlo', async () => {
  const app = await startApp(checkoutLimiter);
  try {
    for (let i = 0; i < 10; i += 1) {
      const response = await fetch(app.baseUrl);
      assert.equal(response.status, 200, `solicitud ${i + 1} de 10 debe pasar (dentro del máximo)`);
    }

    const limitedResponse = await fetch(app.baseUrl);
    assert.equal(limitedResponse.status, 429);
    const payload = await limitedResponse.json();
    assert.equal(payload.ok, false);
    assert.equal(payload.code, 'RATE_LIMITED_CHECKOUT');
    assert.equal(Object.keys(payload).length, 3, 'no debe filtrar campos adicionales (stack, headers internos, etc.)');
  } finally {
    await app.close();
  }
});

test('webhookLimiter: generoso -- 50 solicitudes rapidas no lo activan (nunca bloquea reintentos legitimos de Wompi solo por volumen normal)', async () => {
  const app = await startApp(webhookLimiter);
  try {
    const responses = await Promise.all(Array.from({ length: 50 }, () => fetch(app.baseUrl)));
    assert.ok(responses.every((response) => response.status === 200));
  } finally {
    await app.close();
  }
});
