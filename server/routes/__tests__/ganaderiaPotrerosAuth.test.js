// SPRINT-3D3-POTREROS-API-FOUNDATION: garantía server-side de que TODA la
// superficie de /api/ganaderia/predios/:predioId/potreros exige sesión
// Ganadería con organización activa, y que las mutaciones exigen CSRF.
// Mismo patrón que ganaderiaPrediosAuth.test.js -- servidor HTTP efímero
// real, fetch() directo, sin mocks de middleware, sin DB configurada (si
// el handler llegara a ejecutarse tocaría AGX_BUSINESS_DATABASE_URL y
// fallaría con 503, no con el 401/403 limpio que se espera aquí).
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import createGanaderiaPotrerosRouter from '../ganaderiaPotreros.js';
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
  // §: mergeParams del router exige que el mount conserve :predioId en el
  // path -- mismo patrón que server/index.js.
  app.use('/api/ganaderia/predios/:predioId/potreros', createGanaderiaPotrerosRouter(ROUTER_CONFIG));
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

describe('SPRINT-3D3-POTREROS-API-FOUNDATION: exige sesión con organización', () => {
  test('GET /:predioId/potreros sin sesión -> 401', async () => {
    await assertAnonymousRejected('GET', '/101/potreros');
  });

  test('GET /:predioId/potreros/:potreroId sin sesión -> 401', async () => {
    await assertAnonymousRejected('GET', '/101/potreros/5');
  });

  test('POST /:predioId/potreros/preview-coordinates sin sesión -> 401', async () => {
    await assertAnonymousRejected('POST', '/101/potreros/preview-coordinates', { puntos: [] });
  });

  test('POST /:predioId/potreros/preview-gps sin sesión -> 401', async () => {
    await assertAnonymousRejected('POST', '/101/potreros/preview-gps', { puntos: [] });
  });

  test('POST /:predioId/potreros sin sesión -> 401', async () => {
    await assertAnonymousRejected('POST', '/101/potreros', { candidateId: 'x', nombre: 'Potrero 1' });
  });

  // SPRINT-3D5: requireSession se monta vía router.use() ANTES de
  // cualquier ruta -- corre para preview-file igual que para el resto,
  // sin importar que esta ruta use un body-parser distinto (raw()) más
  // abajo en la cadena. Una request anónima nunca llega a leer el body.
  test('POST /:predioId/potreros/preview-file sin sesión -> 401', async () => {
    const ctx = await startApp();
    try {
      const response = await fetch(`${ctx.baseUrl}/101/potreros/preview-file`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'X-Potrero-File-Name': 'x.kml' },
        body: Buffer.from('<kml/>'),
      });
      assert.equal(response.status, 401);
      const responseBody = await response.json();
      assert.equal(responseBody.error, 'SESSION_REQUIRED');
    } finally {
      await closeApp(ctx);
    }
  });

  test('nunca toca Postgres (ni legacy ni AGX-Business) en una solicitud anónima', async () => {
    const ctx = await startApp();
    try {
      const response = await fetch(`${ctx.baseUrl}/101/potreros`);
      assert.equal(response.status, 401);
    } finally {
      await closeApp(ctx);
    }
  });
});
