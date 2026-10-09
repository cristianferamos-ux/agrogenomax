// SPRINT-3D9.1: garantía server-side de que TODA la superficie de
// /api/ganaderia/predios/:predioId/potreros/:potreroId/ciclos-pastoreo
// exige sesión Ganadería con organización activa. Mismo patrón que
// ganaderiaPotreroDescansoReentradaAuth.test.js -- servidor HTTP efímero
// real, fetch() directo, sin mocks de middleware, sin DB configurada.
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import createGanaderiaPotreroCicloPastoreoRouter from '../ganaderiaPotreroCicloPastoreo.js';
import crypto from 'crypto';
import { getAgxAuthPool, __resetAgxAuthPoolForTests } from '../../db/agxAuthPool.js';
import { hashSessionSecret, sessionCookieName } from '../../security/ganaderiaSession.js';
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

  // SPRINT-3D9.2
  test('POST .../ciclos-pastoreo/:cicloId/anular sin sesión -> 401', async () => {
    await assertAnonymousRejected('POST', '/101/potreros/5/ciclos-pastoreo/1/anular', { motivo: 'x' });
  });

  test('POST .../ciclos-pastoreo/:cicloId/corregir sin sesión -> 401', async () => {
    await assertAnonymousRejected('POST', '/101/potreros/5/ciclos-pastoreo/1/corregir', { motivo: 'x', numeroAnimales: 10 });
  });

  test('POST .../ciclos-pastoreo/evaluar-reingreso sin sesión -> 401', async () => {
    await assertAnonymousRejected('POST', '/101/potreros/5/ciclos-pastoreo/evaluar-reingreso', { fichaId: '9', resultado: 'APTO' });
  });

  test('POST .../ciclos-pastoreo/:cicloId/descanso-declarado sin sesión -> 401', async () => {
    await assertAnonymousRejected('POST', '/101/potreros/5/ciclos-pastoreo/42/descanso-declarado', { diasDescanso: 30 });
  });

  test('GET .../ciclos-pastoreo/estado-operativo sin sesión -> 401', async () => {
    await assertAnonymousRejected('GET', '/101/potreros/5/ciclos-pastoreo/estado-operativo');
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

// SPRINT-3D10.8.1: el descanso declarado es una mutación -- con una
// sesión de organización VÁLIDA pero sin X-CSRF-Token (o con uno
// inválido) se rechaza ANTES de llegar al repositorio. agx_auth simulado
// en memoria (mismo patrón que ganaderiaAdmin.test.js); Postgres-AGX-Business
// no está configurado, así que cualquier acceso a negocio sería un 500.
const FAKE_AUTH_CONNECTION_STRING = 'postgres://test:test@192.0.2.1:5432/never_connects';

function wireFakeTenantSession() {
  const rawToken = crypto.randomBytes(32).toString('base64url');
  const tokenHash = hashSessionSecret(rawToken);
  const pool = getAgxAuthPool({ AGX_AUTH_DATABASE_URL: FAKE_AUTH_CONNECTION_STRING });
  pool.query = async (text, params = []) => {
    if (text.includes('from agx.sesiones s') && params[0] === tokenHash) {
      return {
        rows: [{
          sesion_id: 'sesion-1', cuenta_id: 'cuenta-1', organizacion_id: '00000000-0000-4000-8000-000000000001',
          fecha_expiracion: new Date(Date.now() + 60_000).toISOString(), fecha_revocacion: null,
          cuenta_estado: 'activa', email: 'test@example.com', nombre: 'Test',
        }],
      };
    }
    if (text.includes('fn_resolver_autorizacion_sesion') && params[0] === tokenHash) {
      return { rows: [{ sesion_id: 'sesion-1', cuenta_id: 'cuenta-1', organizacion_id: '00000000-0000-4000-8000-000000000001', rol: 'propietario' }] };
    }
    return { rows: [] };
  };
  return rawToken;
}

describe('SPRINT-3D10.8.1: descanso-declarado exige CSRF', () => {
  test('sesión válida SIN X-CSRF-Token -> 403 CSRF_REQUIRED', async () => {
    const rawToken = wireFakeTenantSession();
    const ctx = await startApp();
    try {
      const response = await fetch(`${ctx.baseUrl}/101/potreros/5/ciclos-pastoreo/42/descanso-declarado`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `${sessionCookieName('development')}=${rawToken}`,
          Origin: 'https://agrogenomax.com',
        },
        body: JSON.stringify({ diasDescanso: 30 }),
      });
      assert.equal(response.status, 403);
      assert.equal((await response.json()).error, 'CSRF_REQUIRED');
    } finally {
      await closeApp(ctx);
    }
  });

  test('sesión válida con X-CSRF-Token inválido -> 403 CSRF_INVALID', async () => {
    const rawToken = wireFakeTenantSession();
    const ctx = await startApp();
    try {
      const response = await fetch(`${ctx.baseUrl}/101/potreros/5/ciclos-pastoreo/42/descanso-declarado`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `${sessionCookieName('development')}=${rawToken}`,
          Origin: 'https://agrogenomax.com',
          'X-CSRF-Token': 'token-invalido',
        },
        body: JSON.stringify({ diasDescanso: 30 }),
      });
      assert.equal(response.status, 403);
      assert.equal((await response.json()).error, 'CSRF_INVALID');
    } finally {
      await closeApp(ctx);
    }
  });
});
