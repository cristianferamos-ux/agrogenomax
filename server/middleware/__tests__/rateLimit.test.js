import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { checkoutLimiter, webhookLimiter, prediosSearchLimiter, prediosSearchRateLimitKeyGenerator, potrerosPreviewLimiter } from '../rateLimit.js';

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

// SPRINT-3C1.1 §4/§5: prediosSearchLimiter debe limitar por CUENTA
// autenticada (req.ganaderiaAuth.cuentaId, resuelto server-side), no por
// IP -- pruebas puras del keyGenerator (sin red) más una prueba HTTP end
// to end que demuestra el aislamiento real entre cuentas/IPs.

test('prediosSearchRateLimitKeyGenerator: usa "cuenta:<cuentaId>" cuando hay sesión resuelta, ignora la IP', () => {
  const reqA1 = { ganaderiaAuth: { cuentaId: 'cuenta-a' }, ip: '10.0.0.1' };
  const reqA2 = { ganaderiaAuth: { cuentaId: 'cuenta-a' }, ip: '10.0.0.2' }; // misma cuenta, otra IP
  const reqB = { ganaderiaAuth: { cuentaId: 'cuenta-b' }, ip: '10.0.0.1' }; // otra cuenta, misma IP que reqA1

  assert.equal(prediosSearchRateLimitKeyGenerator(reqA1), 'cuenta:cuenta-a');
  assert.equal(prediosSearchRateLimitKeyGenerator(reqA1), prediosSearchRateLimitKeyGenerator(reqA2), 'la misma cuenta conserva su clave aunque cambie de IP');
  assert.notEqual(prediosSearchRateLimitKeyGenerator(reqA1), prediosSearchRateLimitKeyGenerator(reqB), 'cuentas distintas nunca comparten clave, aunque compartan IP');
});

test('prediosSearchRateLimitKeyGenerator: sin sesión resuelta, cae a IP (caso defensivo -- el router real nunca llega aquí sin sesión)', () => {
  const req = { ganaderiaAuth: undefined, ip: '10.0.0.5' };
  assert.match(prediosSearchRateLimitKeyGenerator(req), /^(?!cuenta:)/);
});

test('prediosSearchRateLimitKeyGenerator: cuentaId no-string o vacío nunca se usa como clave (no confía en el body/valores falsificables)', () => {
  assert.doesNotMatch(prediosSearchRateLimitKeyGenerator({ ganaderiaAuth: { cuentaId: '' }, ip: '10.0.0.9' }), /^cuenta:$/);
  assert.doesNotMatch(prediosSearchRateLimitKeyGenerator({ ganaderiaAuth: { cuentaId: 123 }, ip: '10.0.0.9' }), /^cuenta:123$/);
});

function startAppWithSimulatedAuth(limiter, authByRequestIndex) {
  const app = express();
  let requestIndex = 0;
  app.use((req, _res, next) => {
    req.ganaderiaAuth = authByRequestIndex(requestIndex);
    requestIndex += 1;
    next();
  });
  app.get('/probe', limiter, (_req, res) => res.json({ ok: true }));
  const server = app.listen(0);
  return new Promise((resolve) => {
    server.once('listening', () => {
      const { port } = server.address();
      resolve({ baseUrl: `http://127.0.0.1:${port}/probe`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

test('prediosSearchLimiter: Cuenta A y Cuenta B desde la MISMA IP tienen contadores independientes; Cuenta A conserva el suyo al cambiar de IP', async () => {
  // Nota: req.ip es siempre 127.0.0.1 en este test HTTP local (mismo
  // socket) -- por eso el escenario "misma cuenta, otra IP" ya está
  // demostrado de forma determinista y sin red en el test de
  // prediosSearchRateLimitKeyGenerator de arriba; aquí se demuestra el
  // aislamiento real entre CUENTAS a través del limiter completo
  // (express-rate-limit real, no solo el keyGenerator en aislamiento).
  // Los primeros 31 requests (índices 0-30) son de Cuenta A -- 30 dentro
  // del cupo + 1 que debe bloquearse. Cualquier request posterior sería
  // ya de Cuenta B, pero esta app no llega a usarlos (ver appB abajo).
  const app = await startAppWithSimulatedAuth(prediosSearchLimiter, (i) => ({
    cuentaId: i < 31 ? 'cuenta-a-http-test' : 'cuenta-b-http-test',
  }));
  try {
    // Agota el cupo de Cuenta A (30/10min).
    for (let i = 0; i < 30; i += 1) {
      const response = await fetch(app.baseUrl);
      assert.equal(response.status, 200, `cuenta A solicitud ${i + 1}/30 debe pasar`);
    }
    const blockedA = await fetch(app.baseUrl);
    assert.equal(blockedA.status, 429, 'cuenta A debe estar bloqueada tras agotar su cupo');
  } finally {
    await app.close();
  }

  // Cuenta B, misma IP (127.0.0.1, mismo proceso de test), limiter
  // reiniciado en una app nueva -- confirma que B nunca hereda el cupo ya
  // agotado de A cuando ambas comparten infraestructura de red.
  const appB = await startAppWithSimulatedAuth(prediosSearchLimiter, () => ({ cuentaId: 'cuenta-b-http-test' }));
  try {
    const responseB = await fetch(appB.baseUrl);
    assert.equal(responseB.status, 200, 'cuenta B debe tener su propio cupo intacto, aunque comparta IP con A');
  } finally {
    await appB.close();
  }
});

// SPRINT-3D3-POTREROS-API-FOUNDATION §18/§Z: previews de potreros
// (coordenadas/gps) -- mismo límite 30/10min por cuenta que
// prediosSearchLimiter, instancia de limiter independiente (store propio,
// no comparte cupo con prediosSearchLimiter aunque reutilice el mismo
// keyGenerator).
test('potrerosPreviewLimiter: agota el cupo de 30/10min por cuenta y responde 429 sin filtrar detalles internos', async () => {
  const app = await startAppWithSimulatedAuth(potrerosPreviewLimiter, () => ({ cuentaId: 'cuenta-potreros-preview-test' }));
  try {
    for (let i = 0; i < 30; i += 1) {
      const response = await fetch(app.baseUrl);
      assert.equal(response.status, 200, `solicitud ${i + 1}/30 debe pasar`);
    }
    const blocked = await fetch(app.baseUrl);
    assert.equal(blocked.status, 429);
    const payload = await blocked.json();
    assert.equal(payload.code, 'RATE_LIMITED_POTREROS_PREVIEW');
    assert.equal(Object.keys(payload).length, 3);
  } finally {
    await app.close();
  }
});
