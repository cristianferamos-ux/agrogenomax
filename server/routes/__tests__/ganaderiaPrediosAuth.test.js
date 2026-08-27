// SPRINT-3C1-MIS-PREDIOS-API §2: garantía server-side de que TODA la
// superficie de /api/ganaderia/predios exige sesión Ganadería real. Mismo
// patrón que ganaderiaBusinessRoutesAuth.test.js -- servidor HTTP
// efímero real, fetch() directo, sin mocks de middleware, sin DB
// configurada (una solicitud anónima nunca debe llegar a tocar
// AGX_AUTH_DATABASE_URL/AGX_BUSINESS_DATABASE_URL: si el handler se
// hubiera ejecutado, habría fallado con 503, no con este 401 limpio).
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import createGanaderiaPrediosRouter from '../ganaderiaPredios.js';
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
  app.use('/api/ganaderia/predios', createGanaderiaPrediosRouter(ROUTER_CONFIG));
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

describe('SPRINT-3C1-MIS-PREDIOS-API: /api/ganaderia/predios exige sesión con organización', () => {
  test('GET / sin sesión -> 401', async () => {
    await assertAnonymousRejected('GET', '');
  });

  test('GET /:predioId sin sesión -> 401', async () => {
    await assertAnonymousRejected('GET', '/1');
  });

  test('POST /buscar-por-coordenadas sin sesión -> 401', async () => {
    await assertAnonymousRejected('POST', '/buscar-por-coordenadas', { lat: 1.35, lng: -75.45 });
  });

  test('POST /buscar-por-codigo sin sesión -> 401', async () => {
    await assertAnonymousRejected('POST', '/buscar-por-codigo', { codigo: '186001000000000010001000000000' });
  });

  test('POST / (mode catastrox) sin sesión -> 401', async () => {
    await assertAnonymousRejected('POST', '', { mode: 'catastrox', candidateId: 'x' });
  });

  test('POST / (mode manual) sin sesión -> 401', async () => {
    await assertAnonymousRejected('POST', '', { mode: 'manual', nombrePredio: 'X', departamento: 'D', municipio: 'M' });
  });

  // SPRINT-3D9.2
  test('POST /:predioId/archivar sin sesión -> 401', async () => {
    await assertAnonymousRejected('POST', '/1/archivar', { motivo: 'x' });
  });

  test('POST /:predioId/restaurar sin sesión -> 401', async () => {
    await assertAnonymousRejected('POST', '/1/restaurar', {});
  });

  test('nunca toca Postgres (ni legacy ni AGX-Business) en una solicitud anónima', async () => {
    // Confirma que el 401 ocurre ANTES de cualquier intento de conexión --
    // si algún handler tocara agxBusinessPool sin sesión válida, la
    // ausencia de AGX_BUSINESS_DATABASE_URL (borrada en el before()
    // global) haría fallar con 503 AGX_BUSINESS_DB_NOT_CONFIGURED, no 401.
    const ctx = await startApp();
    try {
      const response = await fetch(`${ctx.baseUrl}/`);
      assert.equal(response.status, 401);
    } finally {
      await closeApp(ctx);
    }
  });
});
