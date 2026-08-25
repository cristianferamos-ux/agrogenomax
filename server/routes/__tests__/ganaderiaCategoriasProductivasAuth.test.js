// SPRINT-3D7.2-RECOMENDACION-PASTOREO-AUTO: garantía server-side de que
// GET /api/ganaderia/categorias-productivas exige sesión Ganadería con
// organización activa. Mismo patrón que ganaderiaCatalogoPasturasAuth.test.js.
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import createGanaderiaCategoriasProductivasRouter from '../ganaderiaCategoriasProductivas.js';
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
  app.use('/api/ganaderia/categorias-productivas', createGanaderiaCategoriasProductivasRouter(ROUTER_CONFIG));
  app.use(notFound);
  app.use(errorHandler);

  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}/api/ganaderia/categorias-productivas` });
    });
  });
}

async function closeApp(ctx) {
  if (ctx?.server) await new Promise((resolve) => ctx.server.close(resolve));
}

describe('SPRINT-3D7.2: catálogo de categorías productivas exige sesión con organización', () => {
  test('GET /categorias-productivas sin sesión -> 401', async () => {
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
});
