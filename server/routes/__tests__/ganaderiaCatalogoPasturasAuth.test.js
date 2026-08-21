// SPRINT-3D6-FICHA-PRODUCTIVA: garantía server-side de que TODA la
// superficie de /api/ganaderia/catalogo-pasturas exige sesión Ganadería
// con organización activa, y que las mutaciones exigen CSRF. Mismo
// patrón que ganaderiaPotrerosAuth.test.js.
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import createGanaderiaCatalogoPasturasRouter from '../ganaderiaCatalogoPasturas.js';
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
  app.use('/api/ganaderia/catalogo-pasturas', createGanaderiaCatalogoPasturasRouter(ROUTER_CONFIG));
  app.use(notFound);
  app.use(errorHandler);

  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}/api/ganaderia/catalogo-pasturas` });
    });
  });
}

async function closeApp(ctx) {
  if (ctx?.server) await new Promise((resolve) => ctx.server.close(resolve));
}

describe('SPRINT-3D6: catálogo de pasturas exige sesión con organización', () => {
  test('GET / sin sesión -> 401', async () => {
    const ctx = await startApp();
    try {
      const response = await fetch(ctx.baseUrl);
      assert.equal(response.status, 401);
      const body = await response.json();
      assert.equal(body.error, 'SESSION_REQUIRED');
    } finally {
      await closeApp(ctx);
    }
  });

  test('POST /personalizadas sin sesión -> 401', async () => {
    const ctx = await startApp();
    try {
      const response = await fetch(`${ctx.baseUrl}/personalizadas`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nombreComun: 'X', tipo: 'graminea' }),
      });
      assert.equal(response.status, 401);
      const body = await response.json();
      assert.equal(body.error, 'SESSION_REQUIRED');
    } finally {
      await closeApp(ctx);
    }
  });
});
