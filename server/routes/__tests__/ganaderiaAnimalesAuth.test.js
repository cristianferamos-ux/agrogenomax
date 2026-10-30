// SPRINT-3D11.2: garantías HTTP de /api/ganaderia/animales y
// /api/ganaderia/catalogo-razas SIN base de negocio configurada --
// servidor Express efímero real, fetch() directo, sin mocks de middleware.
//   - sin sesión -> 401 en toda la superficie;
//   - sesión de organización válida (agx_auth simulado en memoria, mismo
//     patrón que ganaderiaPotreroCicloPastoreoAuth.test.js) sin CSRF o con
//     CSRF inválido -> 403 en mutaciones;
//   - con sesión + CSRF válido, toda validación de entrada responde 400
//     ANTES de tocar Postgres-AGX-Business (no configurado: cualquier
//     acceso sería un 500).
// 404 entre organizaciones y los 409 se prueban contra Postgres real en
// server/services/__tests__/animalesRepositoryIntegration.test.js.
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import express from 'express';

import createGanaderiaAnimalesRouter from '../ganaderiaAnimales.js';
import createGanaderiaCatalogoRazasRouter from '../ganaderiaCatalogoRazas.js';
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
  app.use('/api/ganaderia/animales', createGanaderiaAnimalesRouter(ROUTER_CONFIG));
  app.use('/api/ganaderia/catalogo-razas', createGanaderiaCatalogoRazasRouter(ROUTER_CONFIG));
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
      return { rows: [{ sesion_id: 'sesion-1', cuenta_id: 'cuenta-1', organizacion_id: ORG_ID, rol: 'owner' }] }; // FASE 3A: rol real de membresía (RBAC)
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

const VALID_BODY = Object.freeze({
  clientOperationId: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
  predioId: '12',
  numeroVisual: '045',
  sexo: 'HEMBRA',
  nacimientoTipo: 'DESCONOCIDA',
  razaTipo: 'DESCONOCIDA',
});

describe('SPRINT-3D11.2: sin sesión -> 401 en toda la superficie', () => {
  const cases = [
    ['GET', '/animales'],
    ['GET', '/animales/1'],
    ['POST', '/animales', VALID_BODY],
    ['POST', '/animales/1/corregir', { fechaActualizacionEsperada: '2026-10-15T00:00:00.000000Z', nombre: 'x', numeroVisual: null }],
    ['POST', '/animales/1/anular', { motivo: 'x' }],
    ['GET', '/catalogo-razas'],
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

describe('SPRINT-3D11.2: mutaciones exigen CSRF', () => {
  for (const path of ['/animales', '/animales/1/corregir', '/animales/1/anular']) {
    test(`POST ${path} con sesión y SIN X-CSRF-Token -> 403 CSRF_REQUIRED`, async () => {
      const rawToken = wireFakeTenantSession();
      const ctx = await startApp();
      try {
        const { status, json } = await request(ctx, 'POST', path, { body: VALID_BODY, rawToken });
        assert.equal(status, 403);
        assert.equal(json.error, 'CSRF_REQUIRED');
      } finally {
        await closeApp(ctx);
      }
    });

    test(`POST ${path} con sesión y X-CSRF-Token inválido -> 403 CSRF_INVALID`, async () => {
      const rawToken = wireFakeTenantSession();
      const ctx = await startApp();
      try {
        const { status, json } = await request(ctx, 'POST', path, { body: VALID_BODY, rawToken, csrf: 'token-invalido' });
        assert.equal(status, 403);
        assert.equal(json.error, 'CSRF_INVALID');
      } finally {
        await closeApp(ctx);
      }
    });
  }
});

describe('SPRINT-3D11.2: POST /animales valida antes de tocar la base (400)', () => {
  const invalid = [
    ['campo desconocido', { ...VALID_BODY, foo: 1 }, 'FORBIDDEN_FIELDS'],
    ['organizacionId del cliente', { ...VALID_BODY, organizacionId: ORG_ID }, 'FORBIDDEN_FIELDS'],
    ['estado del cliente', { ...VALID_BODY, estado: 'ANULADO' }, 'FORBIDDEN_FIELDS'],
    ['creationIntentHash del cliente', { ...VALID_BODY, creationIntentHash: 'v1:x' }, 'FORBIDDEN_FIELDS'],
    ['sin clientOperationId', { ...VALID_BODY, clientOperationId: undefined }, 'INVALID_CLIENT_OPERATION_ID'],
    ['clientOperationId no UUID', { ...VALID_BODY, clientOperationId: 'abc' }, 'INVALID_CLIENT_OPERATION_ID'],
    ['clientOperationId nulo', { ...VALID_BODY, clientOperationId: '00000000-0000-0000-0000-000000000000' }, 'INVALID_CLIENT_OPERATION_ID'],
    ['predioId inválido', { ...VALID_BODY, predioId: 'x' }, 'INVALID_PREDIO_ID'],
    ['sexo inválido', { ...VALID_BODY, sexo: 'OTRO' }, 'INVALID_SEXO'],
    ['sin chapeta ni nombre', { ...VALID_BODY, numeroVisual: '   ' }, 'IDENTIDAD_REQUERIDA'],
    ['EXACTA sin fecha', { ...VALID_BODY, nacimientoTipo: 'EXACTA' }, 'INVALID_NACIMIENTO'],
    ['APROXIMADA con fecha', { ...VALID_BODY, nacimientoTipo: 'APROXIMADA', edadAproximadaMeses: 18, fechaNacimiento: '2024-01-01' }, 'INVALID_NACIMIENTO'],
    ['fecha futura', { ...VALID_BODY, nacimientoTipo: 'EXACTA', fechaNacimiento: '2999-01-01' }, 'INVALID_NACIMIENTO'],
    ['PURA con catálogo y otro nombre', { ...VALID_BODY, razaTipo: 'PURA', razaPrincipalId: '1', razaOtroNombre: 'Charolais' }, 'INVALID_RAZA'],
    ['PURA sin raza', { ...VALID_BODY, razaTipo: 'PURA' }, 'INVALID_RAZA'],
    ['CRUCE vacío', { ...VALID_BODY, razaTipo: 'CRUCE' }, 'INVALID_RAZA'],
    ['CRUCE con otro nombre', { ...VALID_BODY, razaTipo: 'CRUCE', razaOtroNombre: 'Charolais', cruceDescripcion: 'x' }, 'INVALID_RAZA'],
    ['DESCONOCIDA con datos', { ...VALID_BODY, razaTipo: 'DESCONOCIDA', cruceDescripcion: 'Mestizo' }, 'INVALID_RAZA'],
    ['peso sin método', { ...VALID_BODY, pesoInicialKg: 280 }, 'INVALID_PESO'],
    ['peso con dos decimales', { ...VALID_BODY, pesoInicialKg: 280.25, pesoInicialMetodo: 'BASCULA' }, 'INVALID_PESO'],
    ['peso fuera de rango', { ...VALID_BODY, pesoInicialKg: 2500, pesoInicialMetodo: 'BASCULA' }, 'INVALID_PESO'],
    ['categoría inválida', { ...VALID_BODY, categoriaProductivaId: 'vaca' }, 'INVALID_CATEGORIA'],
    ['nacido en el predio con procedencia', { ...VALID_BODY, origenTipo: 'NACIDO_EN_PREDIO', procedencia: 'Finca X' }, 'INVALID_ORIGEN'],
  ];
  for (const [label, body, code] of invalid) {
    test(`${label} -> 400 ${code}`, async () => {
      const { status, json } = await authedPost('/animales', body);
      assert.equal(status, 400);
      assert.equal(json.error, code);
    });
  }
});

describe('SPRINT-3D11.2: corregir/anular/detalle/listado validan antes de la base (400)', () => {
  test('animalId no numérico -> 400 INVALID_ANIMAL_ID (detalle, corregir, anular)', async () => {
    assert.equal((await authedGet('/animales/abc')).json.error, 'INVALID_ANIMAL_ID');
    assert.equal((await authedPost('/animales/abc/corregir', {})).json.error, 'INVALID_ANIMAL_ID');
    assert.equal((await authedPost('/animales/abc/anular', { motivo: 'x' })).json.error, 'INVALID_ANIMAL_ID');
  });

  test('corregir: predioId/estado/peso no son corregibles -> 400 FORBIDDEN_FIELDS', async () => {
    for (const field of ['predioId', 'estado', 'pesoInicialKg', 'clientOperationId', 'creationIntentHash']) {
      const { status, json } = await authedPost('/animales/1/corregir', {
        fechaActualizacionEsperada: '2026-10-15T00:00:00.000000Z', [field]: 'x',
      });
      assert.equal(status, 400);
      assert.equal(json.error, 'FORBIDDEN_FIELDS', field);
    }
  });

  test('corregir: sin fecha esperada, vacío o grupo incompleto -> 400', async () => {
    assert.equal((await authedPost('/animales/1/corregir', { nombre: 'x', numeroVisual: null })).json.error, 'INVALID_FECHA_ACTUALIZACION');
    assert.equal(
      (await authedPost('/animales/1/corregir', { fechaActualizacionEsperada: '2026-10-15T00:00:00Z' })).json.error,
      'EMPTY_CORRECTION',
    );
    assert.equal(
      (await authedPost('/animales/1/corregir', { fechaActualizacionEsperada: '2026-10-15T00:00:00Z', razaTipo: 'PURA' })).json.error,
      'INCOMPLETE_CORRECTION_GROUP',
    );
  });

  test('anular: motivo obligatorio -> 400 INVALID_MOTIVO', async () => {
    assert.equal((await authedPost('/animales/1/anular', { motivo: '  ' })).json.error, 'INVALID_MOTIVO');
    assert.equal((await authedPost('/animales/1/anular', {})).json.error, 'INVALID_MOTIVO');
  });

  test('listado: parámetros inválidos o desconocidos -> 400 INVALID_QUERY (incluye organizacionId)', async () => {
    for (const query of ['estado=VENDIDO', 'sexo=X', 'limit=0', 'limit=201', 'offset=-1', 'predioId=abc', `organizacionId=${ORG_ID}`]) {
      const { status, json } = await authedGet(`/animales?${query}`);
      assert.equal(status, 400, query);
      assert.equal(json.error, 'INVALID_QUERY', query);
    }
  });
});
