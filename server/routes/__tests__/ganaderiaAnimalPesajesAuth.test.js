// FASE 1A: garantías HTTP de /api/ganaderia/animales/:animalId/pesajes SIN
// base de negocio configurada -- servidor Express efímero real, fetch()
// directo, mismo patrón que ganaderiaAnimalesAuth.test.js:
//   - sin sesión -> 401 (GET y POST);
//   - sesión de organización válida sin CSRF / CSRF inválido -> 403 en POST;
//   - con sesión + CSRF, toda validación responde 400 ANTES de tocar
//     Postgres-AGX-Business (no configurado: cualquier acceso sería 500).
// Aislamiento entre organizaciones, 404/409 e idempotencia se prueban contra
// Postgres real en server/services/__tests__/animalPesajesIntegration.test.js.
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import express from 'express';

import createGanaderiaAnimalPesajesRouter from '../ganaderiaAnimalPesajes.js';
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
const OP_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const VALIDO = Object.freeze({ fecha: '2025-01-10', pesoKg: 350.5, metodo: 'BASCULA', clientOperationId: OP_ID });

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
  app.use('/api/ganaderia/animales/:animalId/pesajes', createGanaderiaAnimalPesajesRouter(ROUTER_CONFIG));
  app.use(notFound);
  app.use(errorHandler);
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}/api/ganaderia` });
    });
  });
}

function wireFakeTenantSession(rol = 'owner') {
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
      return { rows: [{ sesion_id: 'sesion-1', cuenta_id: 'cuenta-1', organizacion_id: ORG_ID, rol }] }; // FASE 3A: rol real de membresía (RBAC)
    }
    return { rows: [] };
  };
  return rawToken;
}

async function call(method, path, { body, session = true, csrf = 'valid', rol = 'owner' } = {}) {
  const rawToken = session ? wireFakeTenantSession(rol) : null;
  const ctx = await startApp();
  try {
    const headers = { 'Content-Type': 'application/json', Origin: ALLOWED_ORIGIN };
    if (rawToken) headers.Cookie = `${sessionCookieName('development')}=${rawToken}`;
    if (rawToken && csrf === 'valid') headers['X-CSRF-Token'] = computeCsrfToken(rawToken, TEST_CSRF_SECRET);
    if (rawToken && csrf === 'invalid') headers['X-CSRF-Token'] = 'x'.repeat(43);
    const response = await fetch(`${ctx.baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    let json = null;
    try {
      json = await response.json();
    } catch {
      json = null;
    }
    return { status: response.status, json, cache: response.headers.get('cache-control') };
  } finally {
    await new Promise((resolve) => ctx.server.close(resolve));
  }
}

describe('FASE 1A: /api/ganaderia/animales/:animalId/pesajes -- autenticación', () => {
  test('GET sin sesión -> 401', async () => {
    const { status } = await call('GET', '/animales/1/pesajes', { session: false });
    assert.equal(status, 401);
  });

  test('POST sin sesión -> 401', async () => {
    const { status } = await call('POST', '/animales/1/pesajes', { body: VALIDO, session: false });
    assert.equal(status, 401);
  });

  test('POST con sesión pero SIN CSRF -> 403', async () => {
    const { status, json } = await call('POST', '/animales/1/pesajes', { body: VALIDO, csrf: 'none' });
    assert.equal(status, 403);
    assert.equal(json.error, 'CSRF_REQUIRED');
  });

  test('POST con CSRF inválido -> 403', async () => {
    const { status } = await call('POST', '/animales/1/pesajes', { body: VALIDO, csrf: 'invalid' });
    assert.equal(status, 403);
  });
});

describe('FASE 1A: validación antes de tocar la base (400)', () => {
  const casos = [
    ['animalId inválido (GET)', 'GET', '/animales/abc/pesajes', undefined, 'INVALID_ANIMAL_ID'],
    ['animalId 0', 'POST', '/animales/0/pesajes', VALIDO, 'INVALID_ANIMAL_ID'],
    ['peso 0', 'POST', '/animales/1/pesajes', { ...VALIDO, pesoKg: 0 }, 'INVALID_PESO'],
    ['peso negativo', 'POST', '/animales/1/pesajes', { ...VALIDO, pesoKg: -5 }, 'INVALID_PESO'],
    ['peso > 2000', 'POST', '/animales/1/pesajes', { ...VALIDO, pesoKg: 2000.1 }, 'INVALID_PESO'],
    ['peso con 2 decimales', 'POST', '/animales/1/pesajes', { ...VALIDO, pesoKg: 350.55 }, 'INVALID_PESO'],
    ['peso como texto', 'POST', '/animales/1/pesajes', { ...VALIDO, pesoKg: '350' }, 'INVALID_PESO'],
    ['método inválido', 'POST', '/animales/1/pesajes', { ...VALIDO, metodo: 'OJO' }, 'INVALID_METODO'],
    ['método ausente', 'POST', '/animales/1/pesajes', { ...VALIDO, metodo: undefined }, 'INVALID_METODO'],
    ['fecha futura', 'POST', '/animales/1/pesajes', { ...VALIDO, fecha: '2999-01-01' }, 'INVALID_FECHA'],
    ['fecha imposible', 'POST', '/animales/1/pesajes', { ...VALIDO, fecha: '2025-02-30' }, 'INVALID_FECHA'],
    ['fecha anterior a 1990', 'POST', '/animales/1/pesajes', { ...VALIDO, fecha: '1989-12-31' }, 'INVALID_FECHA'],
    ['fecha ausente', 'POST', '/animales/1/pesajes', { ...VALIDO, fecha: undefined }, 'INVALID_FECHA'],
    ['clientOperationId ausente', 'POST', '/animales/1/pesajes', { ...VALIDO, clientOperationId: undefined }, 'INVALID_CLIENT_OPERATION_ID'],
    ['clientOperationId no UUID', 'POST', '/animales/1/pesajes', { ...VALIDO, clientOperationId: 'abc' }, 'INVALID_CLIENT_OPERATION_ID'],
    ['observaciones > 500', 'POST', '/animales/1/pesajes', { ...VALIDO, observaciones: 'x'.repeat(501) }, 'INVALID_OBSERVACIONES'],
    ['observaciones no texto', 'POST', '/animales/1/pesajes', { ...VALIDO, observaciones: 5 }, 'INVALID_OBSERVACIONES'],
    ['organizacionId en body', 'POST', '/animales/1/pesajes', { ...VALIDO, organizacionId: ORG_ID }, 'FORBIDDEN_FIELDS'],
    ['origen en body', 'POST', '/animales/1/pesajes', { ...VALIDO, origen: 'REGISTRO_INICIAL' }, 'FORBIDDEN_FIELDS'],
    ['body array', 'POST', '/animales/1/pesajes', [VALIDO], 'INVALID_BODY'],
  ];
  for (const [nombre, method, path, body, code] of casos) {
    test(`${nombre} -> 400 ${code}`, async () => {
      const { status, json, cache } = await call(method, path, { body });
      assert.equal(status, 400);
      assert.equal(json.error, code);
      assert.equal(cache, 'no-store');
    });
  }
});

// ---------------------------------------------------------------------
// FASE 5A.1b: POST /:pesajeId/anular -- rol -> identidad -> ids -> validación,
// todo ANTES de tocar Postgres-AGX-Business (no configurado: cualquier acceso
// sería 500). Idempotencia, cross-tenant y escritura real: integración.
// ---------------------------------------------------------------------
const OP_ANULAR = '8c1f2a64-5717-4562-b3fc-2c963f66afa7';
const ANULAR = Object.freeze({ motivo: 'Error de digitación', clientOperationId: OP_ANULAR });
const IDENTIDAD_OK = Object.freeze({ cuentaId: 'cuenta-1', organizacionId: ORG_ID });

describe('FASE 5A.1b: anular pesaje -- autenticación y rol', () => {
  test('sin sesión -> 401', async () => {
    const { status } = await call('POST', '/animales/1/pesajes/7/anular', { body: ANULAR, session: false });
    assert.equal(status, 401);
  });
  test('sin CSRF -> 403', async () => {
    const { status } = await call('POST', '/animales/1/pesajes/7/anular', { body: ANULAR, csrf: 'none' });
    assert.equal(status, 403);
  });
  for (const rol of ['operador', 'lector']) {
    test(`${rol} -> 403 ROLE_FORBIDDEN (antes de validar e incluso con identidad ajena)`, async () => {
      for (const body of [ANULAR, { motivo: '' }, { ...ANULAR, identidadEsperada: { cuentaId: 'otra', organizacionId: ORG_ID } }]) {
        const { status, json } = await call('POST', '/animales/1/pesajes/7/anular', { body, rol });
        assert.equal(status, 403);
        assert.equal(json.error, 'ROLE_FORBIDDEN');
      }
    });
  }
});

describe('FASE 5A.1b: anular pesaje -- identidad y validación (400/409) antes de la base', () => {
  test('identidadEsperada de otra cuenta -> 409 IDENTIDAD_NO_COINCIDE (owner y admin)', async () => {
    for (const rol of ['owner', 'admin']) {
      const { status, json } = await call('POST', '/animales/1/pesajes/7/anular', { body: { ...ANULAR, identidadEsperada: { cuentaId: 'cuenta-2', organizacionId: ORG_ID } }, rol });
      assert.equal(status, 409);
      assert.equal(json.error, 'IDENTIDAD_NO_COINCIDE');
    }
  });
  test('identidadEsperada de otra organización -> 409 IDENTIDAD_NO_COINCIDE', async () => {
    const { status, json } = await call('POST', '/animales/1/pesajes/7/anular', { body: { ...ANULAR, identidadEsperada: { cuentaId: 'cuenta-1', organizacionId: '00000000-0000-4000-8000-000000000002' } } });
    assert.equal(status, 409);
    assert.equal(json.error, 'IDENTIDAD_NO_COINCIDE');
  });
  test('identidadEsperada mal formada -> 400 INVALID_IDENTIDAD_ESPERADA', async () => {
    const { status, json } = await call('POST', '/animales/1/pesajes/7/anular', { body: { ...ANULAR, identidadEsperada: { cuentaId: 'cuenta-1' } } });
    assert.equal(status, 400);
    assert.equal(json.error, 'INVALID_IDENTIDAD_ESPERADA');
  });
  test('registrar pesaje con identidadEsperada ajena -> 409 IDENTIDAD_NO_COINCIDE', async () => {
    const { status, json } = await call('POST', '/animales/1/pesajes', { body: { ...VALIDO, identidadEsperada: { cuentaId: 'cuenta-2', organizacionId: ORG_ID } } });
    assert.equal(status, 409);
    assert.equal(json.error, 'IDENTIDAD_NO_COINCIDE');
  });
  const casos = [
    ['pesajeId inválido', '/animales/1/pesajes/abc/anular', ANULAR, 'INVALID_PESAJE_ID'],
    ['pesajeId 0', '/animales/1/pesajes/0/anular', ANULAR, 'INVALID_PESAJE_ID'],
    ['animalId inválido', '/animales/x/pesajes/7/anular', ANULAR, 'INVALID_ANIMAL_ID'],
    ['motivo ausente', '/animales/1/pesajes/7/anular', { clientOperationId: OP_ANULAR }, 'INVALID_MOTIVO'],
    ['motivo en blanco', '/animales/1/pesajes/7/anular', { ...ANULAR, motivo: '   ' }, 'INVALID_MOTIVO'],
    ['motivo > 500', '/animales/1/pesajes/7/anular', { ...ANULAR, motivo: 'm'.repeat(501) }, 'INVALID_MOTIVO'],
    ['motivo no texto', '/animales/1/pesajes/7/anular', { ...ANULAR, motivo: 5 }, 'INVALID_MOTIVO'],
    ['clientOperationId ausente', '/animales/1/pesajes/7/anular', { motivo: 'x' }, 'INVALID_CLIENT_OPERATION_ID'],
    ['clientOperationId no UUID', '/animales/1/pesajes/7/anular', { ...ANULAR, clientOperationId: 'abc' }, 'INVALID_CLIENT_OPERATION_ID'],
    // El actor y el instante NUNCA vienen del cliente.
    ['anuladoPor en body', '/animales/1/pesajes/7/anular', { ...ANULAR, anuladoPor: 'cuenta-9' }, 'FORBIDDEN_FIELDS'],
    ['anulado_por en body', '/animales/1/pesajes/7/anular', { ...ANULAR, anulado_por: 'cuenta-9' }, 'FORBIDDEN_FIELDS'],
    ['anuladoAt en body', '/animales/1/pesajes/7/anular', { ...ANULAR, anuladoAt: '2020-01-01T00:00:00Z' }, 'FORBIDDEN_FIELDS'],
    ['organizacionId en body', '/animales/1/pesajes/7/anular', { ...ANULAR, organizacionId: ORG_ID }, 'FORBIDDEN_FIELDS'],
    ['estadoRegistro en body', '/animales/1/pesajes/7/anular', { ...ANULAR, estadoRegistro: 'ANULADO' }, 'FORBIDDEN_FIELDS'],
    ['body array', '/animales/1/pesajes/7/anular', [ANULAR], 'INVALID_BODY'],
  ];
  for (const [nombre, path, body, code] of casos) {
    test(`${nombre} -> 400 ${code}`, async () => {
      const { status, json, cache } = await call('POST', path, { body, rol: 'admin' });
      assert.equal(status, 400);
      assert.equal(json.error, code);
      assert.equal(cache, 'no-store');
    });
  }
  test('identidadEsperada correcta se acepta y se retira antes de validar (no es FORBIDDEN_FIELDS)', async () => {
    const { status, json } = await call('POST', '/animales/1/pesajes/7/anular', { body: { motivo: '', clientOperationId: OP_ANULAR, identidadEsperada: IDENTIDAD_OK } });
    assert.equal(status, 400);
    assert.equal(json.error, 'INVALID_MOTIVO');
  });
});
