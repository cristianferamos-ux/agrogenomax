import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import createQrRouter from '../qr.js';
import { getAgxAuthPool, __resetAgxAuthPoolForTests } from '../../db/agxAuthPool.js';
import { getConfig, __resetValidationStateForTests } from '../../config/env.js';
import { computeCsrfToken } from '../../security/ganaderiaSession.js';
import { errorHandler, notFound } from '../../middleware/errors.js';

// FIX/GANADERIA-SPRINT-0-BUSINESS-AUTH §10.A: prueba que el hallazgo
// crítico de la auditoría "Organizaciones y QR" quedó cerrado --
// POST /api/qr/asociar y POST /api/qr/importar ya no son públicos.
// GET /api/qr/:codigo permanece deliberadamente público (ver comentario
// de cabecera de server/routes/qr.js) -- se prueba explícitamente que
// SIGUE siéndolo, para que un cambio futuro accidental lo rompa aquí.
//
// Mismo patrón que server/routes/__tests__/ganaderiaAuth.test.js: servidor
// Express real en 127.0.0.1, pool `agx_auth` con `pool.query` stubeado
// (sin Postgres real). Para las rutas de negocio (server/db.js, pool
// DISTINTO de agx_auth) se deja DATABASE_URL sin definir a propósito --
// server/db.js falla-rápido con 503 AGX_DB_NOT_CONFIGURED en vez de
// intentar una conexión real, lo cual basta para demostrar "la solicitud
// SÍ llegó al handler de negocio" sin necesitar Postgres en el entorno de
// pruebas.

const FAKE_CONNECTION_STRING = 'postgres://test:test@192.0.2.1:5432/never_connects';
const TEST_CSRF_SECRET = 'gwslZ1bKInXjQ0TLmMqWeV6vRAL2hONB6bTBqpAjVFs=';
const ALLOWED_ORIGINS = Object.freeze(['https://agrogenomax.com']);

const VALID_SESSION_RAW_TOKEN = 'raw-valido-qr-sprint0';

function stubValidSession(pool) {
  pool.query = async (text) => {
    if (String(text).includes('from agx.sesiones')) {
      return {
        rows: [
          {
            sesion_id: 's1',
            cuenta_id: 'c1',
            organizacion_id: null,
            fecha_expiracion: new Date(Date.now() + 60_000).toISOString(),
            fecha_revocacion: null,
            cuenta_estado: 'activa',
            email: 'operador@fincaa.test',
            nombre: 'Operador',
          },
        ],
      };
    }
    return { rows: [] };
  };
}

before(() => {
  delete process.env.DATABASE_URL; // server/db.js debe fallar-rápido con 503, nunca intentar una conexión real
});

beforeEach(() => {
  __resetAgxAuthPoolForTests();
  __resetValidationStateForTests();
});

function startApp() {
  getConfig({ APP_ENV: 'development' }, {});
  const pool = getAgxAuthPool({ AGX_AUTH_DATABASE_URL: FAKE_CONNECTION_STRING });
  stubValidSession(pool);

  const app = express();
  app.use(express.json());
  app.use(
    '/api/qr',
    createQrRouter({ appEnv: 'development', csrfServerSecret: TEST_CSRF_SECRET, allowedOrigins: ALLOWED_ORIGINS }),
  );
  app.use(notFound);
  app.use(errorHandler);

  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}/api/qr` });
    });
  });
}

async function closeApp(ctx) {
  if (ctx?.server) await new Promise((resolve) => ctx.server.close(resolve));
}

describe('FIX/GANADERIA-SPRINT-0-BUSINESS-AUTH: server/routes/qr.js', () => {
  test('A1. POST /api/qr/asociar sin sesión -> 401, no llega al handler de negocio', async () => {
    const ctx = await startApp();
    try {
      const response = await fetch(`${ctx.baseUrl}/asociar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ codigo: 'AGX-000001', animal_id: 1 }),
      });
      assert.equal(response.status, 401);
      const body = await response.json();
      assert.equal(body.error, 'SESSION_REQUIRED');
    } finally {
      await closeApp(ctx);
    }
  });

  test('A2. POST /api/qr/importar sin sesión -> 401, no llega al handler de negocio', async () => {
    const ctx = await startApp();
    try {
      const response = await fetch(`${ctx.baseUrl}/importar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ codigos: ['AGX-000099'] }),
      });
      assert.equal(response.status, 401);
      const body = await response.json();
      assert.equal(body.error, 'SESSION_REQUIRED');
    } finally {
      await closeApp(ctx);
    }
  });

  test('A3. POST /api/qr/asociar con sesión válida pero SIN CSRF -> 403, rechazo antes del handler', async () => {
    const ctx = await startApp();
    try {
      const response = await fetch(`${ctx.baseUrl}/asociar`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://agrogenomax.com',
          Cookie: `agx_session=${VALID_SESSION_RAW_TOKEN}`,
        },
        body: JSON.stringify({ codigo: 'AGX-000001', animal_id: 1 }),
      });
      assert.equal(response.status, 403);
      const body = await response.json();
      assert.equal(body.error, 'CSRF_REQUIRED');
    } finally {
      await closeApp(ctx);
    }
  });

  test('A4. POST /api/qr/asociar con sesión válida + CSRF válido -> pasa ambas puertas y alcanza el handler real (falla en 503 por DB no configurada en el entorno de prueba, NUNCA 401/403)', async () => {
    const ctx = await startApp();
    try {
      const csrfToken = computeCsrfToken(VALID_SESSION_RAW_TOKEN, TEST_CSRF_SECRET);
      const response = await fetch(`${ctx.baseUrl}/asociar`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://agrogenomax.com',
          Cookie: `agx_session=${VALID_SESSION_RAW_TOKEN}`,
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify({ codigo: 'AGX-000001', animal_id: 1 }),
      });
      assert.notEqual(response.status, 401);
      assert.notEqual(response.status, 403);
      assert.equal(response.status, 503);
      const body = await response.json();
      assert.equal(body.error, 'Error interno del servidor');
    } finally {
      await closeApp(ctx);
    }
  });

  test('A4b. Mismo caso para POST /api/qr/importar con sesión + CSRF válidos -> alcanza el handler (503, no 401/403)', async () => {
    const ctx = await startApp();
    try {
      const csrfToken = computeCsrfToken(VALID_SESSION_RAW_TOKEN, TEST_CSRF_SECRET);
      const response = await fetch(`${ctx.baseUrl}/importar`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://agrogenomax.com',
          Cookie: `agx_session=${VALID_SESSION_RAW_TOKEN}`,
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify({ codigos: ['AGX-000099'] }),
      });
      assert.notEqual(response.status, 401);
      assert.notEqual(response.status, 403);
      assert.equal(response.status, 503);
    } finally {
      await closeApp(ctx);
    }
  });

  test('B1. GET /api/qr/:codigo SIGUE siendo público (decisión deliberada, ver cabecera de qr.js) -- sin sesión, nunca 401/403', async () => {
    const ctx = await startApp();
    try {
      const response = await fetch(`${ctx.baseUrl}/AGX-000001`);
      assert.notEqual(response.status, 401);
      assert.notEqual(response.status, 403);
      // Sin DATABASE_URL en el entorno de prueba, el propio lookup falla
      // con 503 (AGX_DB_NOT_CONFIGURED) -- lo relevante para este sprint
      // es que NO fue rechazado por falta de sesión.
      assert.equal(response.status, 503);
    } finally {
      await closeApp(ctx);
    }
  });
});
