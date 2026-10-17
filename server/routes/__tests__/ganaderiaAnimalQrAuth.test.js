// SPRINT-3D11.3 (R1): garantías HTTP de /api/ganaderia/animales/:id/qr y
// /api/ganaderia/qr/:token SIN base de negocio configurada -- servidor
// Express efímero real, fetch() directo, sin mocks de middleware:
//   - sin sesión -> 401 en toda la superficie QR;
//   - mutaciones sin CSRF / con CSRF inválido -> 403;
//   - con sesión + CSRF, toda validación responde ANTES de tocar
//     Postgres-AGX-Business (no configurado: cualquier acceso sería 500);
//   - token con formato inválido -> 404 QR_NOT_FOUND sin consultar la base.
// Aislamiento entre organizaciones, revocación y reemplazo se prueban
// contra Postgres real en animalQrRepositoryIntegration.test.js.
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import express from 'express';

import { createGanaderiaAnimalQrRouter, createGanaderiaQrResolverRouter } from '../ganaderiaAnimalQr.js';
import { getAgxAuthPool, __resetAgxAuthPoolForTests } from '../../db/agxAuthPool.js';
import { computeCsrfToken, hashSessionSecret, sessionCookieName } from '../../security/ganaderiaSession.js';
import { __resetAgxBusinessPoolForTests } from '../../db/agxBusinessPool.js';
import { getConfig, __resetValidationStateForTests } from '../../config/env.js';
import { errorHandler, notFound } from '../../middleware/errors.js';

const TEST_CSRF_SECRET = 'gwslZ1bKInXjQ0TLmMqWeV6vRAL2hONB6bTBqpAjVFs=';
const ALLOWED_ORIGIN = 'https://agrogenomax.com';
const ROUTER_CONFIG = Object.freeze({
  appEnv: 'development',
  csrfServerSecret: TEST_CSRF_SECRET,
  allowedOrigins: Object.freeze([ALLOWED_ORIGIN]),
});
const FAKE_AUTH_CONNECTION_STRING = 'postgres://test:test@192.0.2.1:5432/never_connects';
const ORG_ID = '00000000-0000-4000-8000-000000000001';

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
  app.use('/api/ganaderia/animales/:animalId/qr', createGanaderiaAnimalQrRouter(ROUTER_CONFIG));
  app.use('/api/ganaderia/qr', createGanaderiaQrResolverRouter(ROUTER_CONFIG));
  app.use(notFound);
  app.use(errorHandler);
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}/api/ganaderia` });
    });
  });
}

async function closeApp(ctx) {
  if (ctx?.server) await new Promise((resolve) => ctx.server.close(resolve));
}

function wireFakeTenantSession() {
  const rawToken = crypto.randomBytes(32).toString('base64url');
  const tokenHash = hashSessionSecret(rawToken);
  const pool = getAgxAuthPool({ AGX_AUTH_DATABASE_URL: FAKE_AUTH_CONNECTION_STRING });
  pool.query = async (text, params = []) => {
    if (text.includes('from agx.sesiones s') && params[0] === tokenHash) {
      return {
        rows: [{
          sesion_id: 'sesion-1', cuenta_id: 'cuenta-1', organizacion_id: ORG_ID,
          fecha_expiracion: new Date(Date.now() + 60_000).toISOString(), fecha_revocacion: null,
          cuenta_estado: 'activa', email: 'test@example.com', nombre: 'Test',
        }],
      };
    }
    if (text.includes('fn_resolver_autorizacion_sesion') && params[0] === tokenHash) {
      return { rows: [{ sesion_id: 'sesion-1', cuenta_id: 'cuenta-1', organizacion_id: ORG_ID, rol: 'propietario' }] };
    }
    return { rows: [] };
  };
  return rawToken;
}

async function request(ctx, method, path, { body, rawToken, csrf } = {}) {
  const headers = { 'Content-Type': 'application/json', Origin: ALLOWED_ORIGIN };
  if (rawToken) headers.Cookie = `${sessionCookieName('development')}=${rawToken}`;
  if (csrf) headers['X-CSRF-Token'] = csrf;
  const response = await fetch(`${ctx.baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  return { status: response.status, json };
}

/** Sesión + CSRF válidos: la respuesta solo puede venir de la validación. */
async function authedPost(path, body) {
  const rawToken = wireFakeTenantSession();
  const ctx = await startApp();
  try {
    return await request(ctx, 'POST', path, { body, rawToken, csrf: computeCsrfToken(rawToken, TEST_CSRF_SECRET) });
  } finally {
    await closeApp(ctx);
  }
}

async function authedGet(path) {
  const rawToken = wireFakeTenantSession();
  const ctx = await startApp();
  try {
    return await request(ctx, 'GET', path, { rawToken });
  } finally {
    await closeApp(ctx);
  }
}

const OP_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const VALID_TOKEN_SHAPE = 'A'.repeat(32);

describe('SPRINT-3D11.3: sin sesión -> 401 en toda la superficie QR', () => {
  const cases = [
    ['GET', '/animales/1/qr'],
    ['POST', '/animales/1/qr', {}],
    ['POST', '/animales/1/qr/revocar', { motivo: 'x' }],
    ['POST', '/animales/1/qr/reemplazar', { motivo: 'x', clientOperationId: OP_ID }],
    ['GET', `/qr/${VALID_TOKEN_SHAPE}`],
  ];
  for (const [method, path, body] of cases) {
    test(`${method} ${path} sin sesión -> 401 SESSION_REQUIRED`, async () => {
      const ctx = await startApp();
      try {
        const { status, json } = await request(ctx, method, path, { body });
        assert.equal(status, 401);
        assert.equal(json.error, 'SESSION_REQUIRED');
      } finally {
        await closeApp(ctx);
      }
    });
  }
});

describe('SPRINT-3D11.3: mutaciones QR exigen CSRF', () => {
  for (const path of ['/animales/1/qr', '/animales/1/qr/revocar', '/animales/1/qr/reemplazar']) {
    test(`POST ${path} con sesión y SIN X-CSRF-Token -> 403 CSRF_REQUIRED`, async () => {
      const rawToken = wireFakeTenantSession();
      const ctx = await startApp();
      try {
        const { status, json } = await request(ctx, 'POST', path, { body: { motivo: 'x', clientOperationId: OP_ID }, rawToken });
        assert.equal(status, 403);
        assert.equal(json.error, 'CSRF_REQUIRED');
      } finally {
        await closeApp(ctx);
      }
    });

    test(`POST ${path} con X-CSRF-Token inválido -> 403 CSRF_INVALID`, async () => {
      const rawToken = wireFakeTenantSession();
      const ctx = await startApp();
      try {
        const { status, json } = await request(ctx, 'POST', path, { body: {}, rawToken, csrf: 'token-invalido' });
        assert.equal(status, 403);
        assert.equal(json.error, 'CSRF_INVALID');
      } finally {
        await closeApp(ctx);
      }
    });
  }
});

describe('SPRINT-3D11.3: validación antes de tocar la base', () => {
  const invalid = [
    ['asignar: animalId inválido', '/animales/abc/qr', {}, 400, 'INVALID_ANIMAL_ID'],
    ['asignar: animalId cero', '/animales/0/qr', {}, 400, 'INVALID_ANIMAL_ID'],
    ['asignar: token del cliente', '/animales/1/qr', { valor: VALID_TOKEN_SHAPE }, 400, 'FORBIDDEN_FIELDS'],
    ['asignar: organizacionId del cliente', '/animales/1/qr', { organizacionId: ORG_ID }, 400, 'FORBIDDEN_FIELDS'],
    ['revocar: sin motivo', '/animales/1/qr/revocar', {}, 400, 'INVALID_MOTIVO'],
    ['revocar: motivo en blanco', '/animales/1/qr/revocar', { motivo: '   ' }, 400, 'INVALID_MOTIVO'],
    ['revocar: motivo > 500', '/animales/1/qr/revocar', { motivo: 'x'.repeat(501) }, 400, 'INVALID_MOTIVO'],
    ['revocar: organizacionId del cliente', '/animales/1/qr/revocar', { motivo: 'x', organizacionId: ORG_ID }, 400, 'FORBIDDEN_FIELDS'],
    ['reemplazar: sin clientOperationId', '/animales/1/qr/reemplazar', { motivo: 'x' }, 400, 'INVALID_CLIENT_OPERATION_ID'],
    ['reemplazar: clientOperationId inválido', '/animales/1/qr/reemplazar', { motivo: 'x', clientOperationId: 'abc' }, 400, 'INVALID_CLIENT_OPERATION_ID'],
    ['reemplazar: sin motivo', '/animales/1/qr/reemplazar', { clientOperationId: OP_ID }, 400, 'INVALID_MOTIVO'],
    ['reemplazar: token del cliente', '/animales/1/qr/reemplazar', { motivo: 'x', clientOperationId: OP_ID, valor: VALID_TOKEN_SHAPE }, 400, 'FORBIDDEN_FIELDS'],
  ];
  for (const [name, path, body, expectedStatus, expectedError] of invalid) {
    test(`${name} -> ${expectedStatus} ${expectedError}`, async () => {
      const { status, json } = await authedPost(path, body);
      assert.equal(status, expectedStatus);
      assert.equal(json.error, expectedError);
    });
  }

  test('GET /animales/abc/qr -> 400 INVALID_ANIMAL_ID', async () => {
    const { status, json } = await authedGet('/animales/abc/qr');
    assert.equal(status, 400);
    assert.equal(json.error, 'INVALID_ANIMAL_ID');
  });

  const badTokens = ['corto', 'A'.repeat(31), 'A'.repeat(33), `${'A'.repeat(31)}=`, 'AGX-000003', `${'A'.repeat(31)}%2F`];
  for (const token of badTokens) {
    test(`GET /qr/${token} (formato inválido) -> 404 QR_NOT_FOUND sin consultar la base`, async () => {
      const { status, json } = await authedGet(`/qr/${token}`);
      assert.equal(status, 404);
      assert.deepEqual(json, { error: 'QR_NOT_FOUND' });
    });
  }
});
