// SPRINT-3D9.1: garantía server-side de que TODA la superficie de
// /api/ganaderia/predios/:predioId/potreros/:potreroId/ciclos-pastoreo
// exige sesión Ganadería con organización activa. Mismo patrón que
// ganaderiaPotreroDescansoReentradaAuth.test.js -- servidor HTTP efímero
// real, fetch() directo, sin mocks de middleware, sin DB configurada.
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import createGanaderiaPotreroCicloPastoreoRouter from '../ganaderiaPotreroCicloPastoreo.js';
import { __resetAgxAuthPoolForTests } from '../../db/agxAuthPool.js';
import { __resetAgxBusinessPoolForTests } from '../../db/agxBusinessPool.js';
import { getConfig, __resetValidationStateForTests } from '../../config/env.js';
import { errorHandler, notFound } from '../../middleware/errors.js';

const TEST_CSRF_SECRET = 'gwslZ1bKInXjQ0TLmMqWeV6vRAL2hONB6bTBqpAjVFs=';
const ALLOWED_ORIGINS = Object.freeze(['https://agrogenomax.com']);
const ROUTER_CONFIG = Object.freeze({
  appEnv: 'development',
  csrfServerSecret: TEST_CSRF_SECRET,
  allowedOrigins: ALLOWED_ORIGINS,
});

before(() => {
  delete process.env.DATABASE_URL;
  delete process.env.AGX_BUSINESS_DATABASE_URL;
});

beforeEach(() => {
  __resetAgxAuthPoolForTests();
  __resetAgxBusinessPoolForTests();
  __resetValidationStateForTests();
  getConfig({ APP_ENV: 'development' }, {});
});

function startApp() {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/ganaderia/predios/:predioId/potreros/:potreroId/ciclos-pastoreo',
    createGanaderiaPotreroCicloPastoreoRouter(ROUTER_CONFIG),
  );
  app.use(notFound);
  app.use(errorHandler);

  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}/api/ganaderia/predios` });
    });
  });
}

async function closeApp(ctx) {
  if (ctx?.server) await new Promise((resolve) => ctx.server.close(resolve));
}

async function assertAnonymousRejected(method, path, body) {
  const ctx = await startApp();
  try {
    const response = await fetch(`${ctx.baseUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    assert.equal(response.status, 401, `${method} ${path} debía responder 401 sin sesión`);
    const responseBody = await response.json();
    assert.equal(responseBody.error, 'SESSION_REQUIRED');
  } finally {
    await closeApp(ctx);
  }
}

describe('SPRINT-3D9.1: ciclos-pastoreo exige sesión con organización', () => {
  test('GET .../ciclos-pastoreo/actual sin sesión -> 401', async () => {
    await assertAnonymousRejected('GET', '/101/potreros/5/ciclos-pastoreo/actual');
  });

  test('GET .../ciclos-pastoreo/historial sin sesión -> 401', async () => {
    await assertAnonymousRejected('GET', '/101/potreros/5/ciclos-pastoreo/historial');
  });

  test('POST .../ciclos-pastoreo/iniciar sin sesión -> 401', async () => {
    await assertAnonymousRejected('POST', '/101/potreros/5/ciclos-pastoreo/iniciar', {});
  });

  test('POST .../ciclos-pastoreo/:cicloId/finalizar sin sesión -> 401', async () => {
    await assertAnonymousRejected('POST', '/101/potreros/5/ciclos-pastoreo/1/finalizar', {});
  });

  test('POST .../ciclos-pastoreo/:cicloId/cancelar sin sesión -> 401', async () => {
    await assertAnonymousRejected('POST', '/101/potreros/5/ciclos-pastoreo/1/cancelar', { motivo: 'x' });
  });

  test('nunca toca Postgres-AGX-Business en una solicitud anónima', async () => {
    const ctx = await startApp();
    try {
      const response = await fetch(`${ctx.baseUrl}/101/potreros/5/ciclos-pastoreo/actual`);
      assert.equal(response.status, 401);
    } finally {
      await closeApp(ctx);
    }
  });
});
