// SPRINT-3D11.3 (R1): garantías HTTP del inventario QR SIN base de negocio
// configurada -- servidor Express efímero real, fetch() directo:
//   Super Admin  /api/ganaderia/admin/qr/*: sin sesión 401; cuenta cliente
//                403 SUPERADMIN_REQUIRED (incluso en GET); mutaciones sin
//                CSRF 403; validación 400 y organización inexistente 404
//                ANTES de tocar Postgres-AGX-Business.
//   Organización /api/ganaderia/qr/* y /animales/:id/qr/*: sin sesión 401;
//                sin CSRF 403; validación 400; token/código con formato
//                inválido 404 sin consultar la base.
// Aislamiento, transiciones y RLS se prueban contra Postgres real en
// server/services/__tests__/qrInventarioIntegration.test.js.
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import express from 'express';

import createGanaderiaAdminQrRouter from '../ganaderiaAdminQr.js';
import { createGanaderiaAnimalQrRouter, createGanaderiaQrRouter } from '../ganaderiaAnimalQr.js';
import createGanaderiaSyncRouter from '../ganaderiaSync.js';
import { __resetAgxQrAdminPoolForTests } from '../../db/agxQrAdminPool.js';
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
const ORG_INEXISTENTE = '00000000-0000-4000-8000-0000000000ff';
const OP_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const TOKEN_SHAPE = 'A'.repeat(32);

before(() => {
  delete process.env.DATABASE_URL;
  delete process.env.AGX_BUSINESS_DATABASE_URL;
  delete process.env.AGX_BUSINESS_QR_ADMIN_DATABASE_URL;
  delete process.env.AGX_QR_PUBLIC_ORIGIN;
});

beforeEach(() => {
  __resetAgxAuthPoolForTests();
  __resetAgxBusinessPoolForTests();
  __resetAgxQrAdminPoolForTests();
  __resetValidationStateForTests();
  getConfig({ APP_ENV: 'development' }, {});
});

function startApp(adminConfig = ROUTER_CONFIG) {
  const app = express();
  app.use(express.json());
  app.use('/api/ganaderia/admin/qr', createGanaderiaAdminQrRouter(adminConfig));
  app.use('/api/ganaderia/animales/:animalId/qr', createGanaderiaAnimalQrRouter(ROUTER_CONFIG));
  app.use('/api/ganaderia/qr', createGanaderiaQrRouter(ROUTER_CONFIG));
  app.use('/api/ganaderia/sync', createGanaderiaSyncRouter(ROUTER_CONFIG));
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

/** Sesión simulada en memoria; superAdmin -> staff_crh administrador_plataforma. */
function wireFakeSession({ superAdmin = false } = {}) {
  const rawToken = crypto.randomBytes(32).toString('base64url');
  const tokenHash = hashSessionSecret(rawToken);
  const pool = getAgxAuthPool({ AGX_AUTH_DATABASE_URL: FAKE_AUTH_CONNECTION_STRING });
  pool.query = async (text, params = []) => {
    if (text.includes('from agx.sesiones s') && params[0] === tokenHash) {
      return {
        rowCount: 1,
        rows: [{
          sesion_id: 'sesion-1', cuenta_id: 'cuenta-1', organizacion_id: ORG_ID,
          fecha_expiracion: new Date(Date.now() + 60_000).toISOString(), fecha_revocacion: null,
          cuenta_estado: 'activa', email: 'test@example.com', nombre: 'Test',
        }],
      };
    }
    if (text.includes('fn_resolver_autorizacion_sesion') && params[0] === tokenHash) {
      return { rowCount: 1, rows: [{ sesion_id: 'sesion-1', cuenta_id: 'cuenta-1', organizacion_id: ORG_ID, rol: 'propietario' }] };
    }
    if (text.includes('from agx.staff_crh')) {
      return superAdmin ? { rowCount: 1, rows: [{ rol_interno: 'administrador_plataforma' }] } : { rowCount: 0, rows: [] };
    }
    if (text.includes('from agx.organizaciones where organizacion_id = $1')) {
      return { rowCount: 0, rows: [] };
    }
    return { rowCount: 0, rows: [] };
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

async function call(method, path, { body, superAdmin = false, session = true, withCsrf = true } = {}) {
  const rawToken = session ? wireFakeSession({ superAdmin }) : null;
  const ctx = await startApp();
  try {
    return await request(ctx, method, path, {
      body,
      rawToken,
      csrf: rawToken && withCsrf ? computeCsrfToken(rawToken, TEST_CSRF_SECRET) : undefined,
    });
  } finally {
    await closeApp(ctx);
  }
}

const ADMIN_SURFACE = [
  ['GET', '/admin/qr/organizaciones'],
  ['GET', '/admin/qr/lotes'],
  ['POST', '/admin/qr/lotes', { cantidad: 10, clientOperationId: OP_ID }],
  ['POST', '/admin/qr/lotes/importar-legacy', { codigos: ['AGX-000001'], clientOperationId: OP_ID }],
  ['GET', '/admin/qr/lotes/1'],
  ['POST', '/admin/qr/lotes/1/estado', { estado: 'EN_STOCK' }],
  ['POST', '/admin/qr/lotes/1/asignar', { organizacionId: ORG_ID, clientOperationId: OP_ID }],
  ['GET', '/admin/qr/lotes/1/paquete.zip'],
  ['GET', '/admin/qr/lotes/1/referencia.pdf'],
  ['GET', '/admin/qr/lotes/1/manifest.csv'],
  ['GET', '/admin/qr/lotes/1/proveedor.html'],
  ['GET', '/admin/qr/chapetas'],
  ['GET', '/admin/qr/chapetas/1'],
  ['GET', '/admin/qr/chapetas/1/arte.svg'],
  ['POST', '/admin/qr/chapetas/1/revocar', { motivo: 'x' }],
  ['POST', '/admin/qr/chapetas/1/danada', { motivo: 'x' }],
  ['POST', '/admin/qr/chapetas/1/reemplazar', { codigoNuevo: 'AGX-7KM4-P2XZ-R', motivo: 'x' }],
];

describe('SPRINT-3D11.3: Super Admin -- autorización del panel existente', () => {
  for (const [method, path, body] of ADMIN_SURFACE) {
    test(`${method} ${path} sin sesión -> 401`, async () => {
      const { status, json } = await call(method, path, { body, session: false });
      assert.equal(status, 401);
      assert.equal(json.error, 'SESSION_REQUIRED');
    });

    test(`${method} ${path} con cuenta cliente (no super admin) -> 403 SUPERADMIN_REQUIRED`, async () => {
      const { status, json } = await call(method, path, { body });
      assert.equal(status, 403);
      assert.equal(json.error, 'SUPERADMIN_REQUIRED');
    });
  }

  for (const [method, path, body] of ADMIN_SURFACE.filter(([m]) => m === 'POST')) {
    test(`${method} ${path} super admin SIN CSRF -> 403`, async () => {
      const { status, json } = await call(method, path, { body, superAdmin: true, withCsrf: false });
      assert.equal(status, 403);
      assert.equal(json.error, 'CSRF_REQUIRED');
    });
  }
});

describe('SPRINT-3D11.3: Super Admin -- validación antes de tocar la base', () => {
  const cases = [
    ['lote: cantidad 0', 'POST', '/admin/qr/lotes', { cantidad: 0, clientOperationId: OP_ID }, 400, 'INVALID_CANTIDAD'],
    ['lote: cantidad 5001', 'POST', '/admin/qr/lotes', { cantidad: 5001, clientOperationId: OP_ID }, 400, 'INVALID_CANTIDAD'],
    ['lote: cantidad texto', 'POST', '/admin/qr/lotes', { cantidad: '10', clientOperationId: OP_ID }, 400, 'INVALID_CANTIDAD'],
    ['lote: sin clientOperationId', 'POST', '/admin/qr/lotes', { cantidad: 10 }, 400, 'INVALID_CLIENT_OPERATION_ID'],
    ['lote: urlBase del cliente', 'POST', '/admin/qr/lotes', { cantidad: 10, clientOperationId: OP_ID, urlBase: 'https://evil.example' }, 400, 'FORBIDDEN_FIELDS'],
    ['lote: tokens del cliente', 'POST', '/admin/qr/lotes', { cantidad: 10, clientOperationId: OP_ID, tokens: [] }, 400, 'FORBIDDEN_FIELDS'],
    ['legacy: formato nuevo', 'POST', '/admin/qr/lotes/importar-legacy', { codigos: ['AGX-7KM4-P2XZ-R'], clientOperationId: OP_ID }, 400, 'INVALID_CODIGOS'],
    ['legacy: repetidos', 'POST', '/admin/qr/lotes/importar-legacy', { codigos: ['AGX-000001', 'agx-000001'], clientOperationId: OP_ID }, 400, 'INVALID_CODIGOS'],
    ['legacy: vacío', 'POST', '/admin/qr/lotes/importar-legacy', { codigos: [], clientOperationId: OP_ID }, 400, 'INVALID_CODIGOS'],
    ['estado: GENERADO', 'POST', '/admin/qr/lotes/1/estado', { estado: 'GENERADO' }, 400, 'INVALID_ESTADO'],
    ['estado: loteId inválido', 'POST', '/admin/qr/lotes/abc/estado', { estado: 'EN_STOCK' }, 400, 'INVALID_LOTE_ID'],
    ['asignar: organización inválida', 'POST', '/admin/qr/lotes/1/asignar', { organizacionId: 'x', clientOperationId: OP_ID }, 400, 'INVALID_ORGANIZACION'],
    ['asignar: cantidad y códigos', 'POST', '/admin/qr/lotes/1/asignar', { organizacionId: ORG_ID, cantidad: 1, codigos: ['AGX-7KM4-P2XZ-R'], clientOperationId: OP_ID }, 400, 'INVALID_SELECCION'],
    ['asignar: organización inexistente', 'POST', '/admin/qr/lotes/1/asignar', { organizacionId: ORG_INEXISTENTE, clientOperationId: OP_ID }, 404, 'ORGANIZACION_NOT_FOUND'],
    ['revocar: sin motivo', 'POST', '/admin/qr/chapetas/1/revocar', {}, 400, 'INVALID_MOTIVO'],
    ['reemplazar: código inválido', 'POST', '/admin/qr/chapetas/1/reemplazar', { codigoNuevo: 'XYZ', motivo: 'x' }, 400, 'INVALID_CODIGO_NUEVO'],
    ['chapeta: qrId inválido', 'POST', '/admin/qr/chapetas/0/danada', { motivo: 'x' }, 400, 'INVALID_QR_ID'],
    ['búsqueda: estado inválido', 'GET', '/admin/qr/chapetas?estado=BORRADO', undefined, 400, 'INVALID_QUERY'],
    ['búsqueda: parámetro desconocido', 'GET', '/admin/qr/chapetas?token=x', undefined, 400, 'INVALID_QUERY'],
    ['export: loteId inválido', 'GET', '/admin/qr/lotes/x/paquete.zip', undefined, 400, 'INVALID_LOTE_ID'],
    ['export pdf: loteId inválido', 'GET', '/admin/qr/lotes/0/referencia.pdf', undefined, 400, 'INVALID_LOTE_ID'],
    ['export manifest: loteId inválido', 'GET', '/admin/qr/lotes/x/manifest.csv', undefined, 400, 'INVALID_LOTE_ID'],
    ['arte svg: qrId inválido', 'GET', '/admin/qr/chapetas/x/arte.svg', undefined, 400, 'INVALID_QR_ID'],
  ];
  for (const [name, method, path, body, expectedStatus, expectedError] of cases) {
    test(`${name} -> ${expectedStatus} ${expectedError}`, async () => {
      const { status, json } = await call(method, path, { body, superAdmin: true });
      assert.equal(status, expectedStatus);
      assert.equal(json.error, expectedError);
    });
  }
});

const TENANT_SURFACE = [
  ['GET', `/qr/token/${TOKEN_SHAPE}`],
  ['GET', '/qr/codigo/AGX-7KM4-P2XZ-R-R'],
  ['GET', '/qr/chapetas'],
  ['POST', '/qr/chapetas/AGX-7KM4-P2XZ-R/registrar-animal', {}],
  ['GET', '/animales/1/qr'],
  ['POST', '/animales/1/qr/asociar', { codigoVisible: 'AGX-7KM4-P2XZ-R' }],
  ['POST', '/animales/1/qr/reemplazar', { codigoNuevo: 'AGX-7KM4-P2XZ-R', motivo: 'x' }],
  ['POST', '/animales/1/qr/baja', { causa: 'REVOCADO', motivo: 'x' }],
];

describe('SPRINT-3D11.3: organización -- sesión y CSRF', () => {
  for (const [method, path, body] of TENANT_SURFACE) {
    test(`${method} ${path} sin sesión -> 401`, async () => {
      const { status, json } = await call(method, path, { body, session: false });
      assert.equal(status, 401);
      assert.equal(json.error, 'SESSION_REQUIRED');
    });
  }
  for (const [method, path, body] of TENANT_SURFACE.filter(([m]) => m === 'POST')) {
    test(`${method} ${path} sin CSRF -> 403`, async () => {
      const { status, json } = await call(method, path, { body, withCsrf: false });
      assert.equal(status, 403);
      assert.equal(json.error, 'CSRF_REQUIRED');
    });
  }
});

describe('SPRINT-3D11.3: organización -- validación antes de tocar la base', () => {
  const cases = [
    ['asociar: código inválido', 'POST', '/animales/1/qr/asociar', { codigoVisible: 'AGX-0000-0000' }, 400, 'INVALID_CODIGO'],
    ['asociar: organizacionId del cliente', 'POST', '/animales/1/qr/asociar', { codigoVisible: 'AGX-7KM4-P2XZ-R', organizacionId: ORG_ID }, 400, 'FORBIDDEN_FIELDS'],
    ['asociar: animalId inválido', 'POST', '/animales/abc/qr/asociar', { codigoVisible: 'AGX-7KM4-P2XZ-R' }, 400, 'INVALID_ANIMAL_ID'],
    ['reemplazar: sin motivo', 'POST', '/animales/1/qr/reemplazar', { codigoNuevo: 'AGX-7KM4-P2XZ-R' }, 400, 'INVALID_MOTIVO'],
    ['baja: causa inválida', 'POST', '/animales/1/qr/baja', { causa: 'REEMPLAZADO', motivo: 'x' }, 400, 'INVALID_CAUSA'],
    ['registrar: código inválido', 'POST', '/qr/chapetas/HOLA/registrar-animal', {}, 400, 'INVALID_CODIGO'],
    ['registrar: cuerpo de animal inválido', 'POST', '/qr/chapetas/AGX-7KM4-P2XZ-R/registrar-animal', { foo: 1 }, 400, 'FORBIDDEN_FIELDS'],
    ['listar: estado EN_INVENTARIO (stock central)', 'GET', '/qr/chapetas?estado=EN_INVENTARIO', undefined, 400, 'INVALID_QUERY'],
  ];
  for (const [name, method, path, body, expectedStatus, expectedError] of cases) {
    test(`${name} -> ${expectedStatus} ${expectedError}`, async () => {
      const { status, json } = await call(method, path, { body });
      assert.equal(status, expectedStatus);
      assert.equal(json.error, expectedError);
    });
  }

  for (const path of [
    '/qr/token/corto', `/qr/token/${'A'.repeat(31)}=`, '/qr/token/AGX-000003',
    '/qr/codigo/HOLA', '/qr/codigo/AGX-0000-0000', '/qr/codigo/AGX-12345',
  ]) {
    test(`GET ${path} (formato inválido) -> 404 QR_NOT_FOUND sin consultar la base`, async () => {
      const { status, json } = await call('GET', path);
      assert.equal(status, 404);
      assert.deepEqual(json, { error: 'QR_NOT_FOUND' });
    });
  }
});

describe('SPRINT-3D11.3: dígito de control -- un error de digitación nunca llega a la base', () => {
  test('asociar con dígito de control incorrecto -> 400 INVALID_CODIGO', async () => {
    const { status, json } = await call('POST', '/animales/1/qr/asociar', { codigoVisible: 'AGX-7KM4-P2XZ-S' });
    assert.equal(status, 400);
    assert.equal(json.error, 'INVALID_CODIGO');
  });
  for (const codigo of ['AGX-7KM4-P2XZ-S', 'AGX-7KM4-P2ZX-R', 'AGX-7KM4-P2XZ', 'AGX-7KN4-P2XZ-R']) {
    test(`GET /qr/codigo/${codigo} (control inválido) -> 404 sin consultar la base`, async () => {
      const { status, json } = await call('GET', `/qr/codigo/${codigo}`);
      assert.equal(status, 404);
      assert.deepEqual(json, { error: 'QR_NOT_FOUND' });
    });
  }
});

describe('SPRINT-3D11.3: configuración del inventario QR -- fail-closed', () => {
  const lote = { cantidad: 10, clientOperationId: OP_ID };
  test('crear lote sin AGX_QR_PUBLIC_ORIGIN -> 503 (el dominio nunca sale del navegador)', async () => {
    const { status, json } = await call('POST', '/admin/qr/lotes', { body: lote, superAdmin: true });
    assert.equal(status, 503);
    assert.equal(json.error, 'QR_PUBLIC_ORIGIN_NOT_CONFIGURED');
  });
  test('crear lote con origen pero sin clave de cifrado -> 503 QR_KEY_NOT_CONFIGURED; con clave y sin conexión agx_qr_admin -> 503 QR_ADMIN_DB_NOT_CONFIGURED', async () => {
    process.env.AGX_QR_PUBLIC_ORIGIN = 'https://agrogenomax.com';
    try {
      const sinClave = await call('POST', '/admin/qr/lotes', { body: lote, superAdmin: true });
      assert.equal(sinClave.status, 503);
      assert.equal(sinClave.json.error, 'QR_KEY_NOT_CONFIGURED');
      process.env.AGX_QR_TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
      const sinDb = await call('POST', '/admin/qr/lotes', { body: lote, superAdmin: true });
      assert.equal(sinDb.status, 503);
      assert.equal(sinDb.json.error, 'QR_ADMIN_DB_NOT_CONFIGURED');
    } finally {
      delete process.env.AGX_QR_PUBLIC_ORIGIN;
      delete process.env.AGX_QR_TOKEN_ENCRYPTION_KEY;
    }
  });
  test('un Origin malicioso no cambia el dominio impreso: sigue exigiendo AGX_QR_PUBLIC_ORIGIN', async () => {
    const { status } = await call('POST', '/admin/qr/lotes', { body: lote, superAdmin: true });
    assert.equal(status, 503);
  });
});

describe('SPRINT-3D11.3: /api/ganaderia/sync/pull', () => {
  test('sin sesión -> 401', async () => {
    const { status, json } = await call('GET', '/sync/pull', { session: false });
    assert.equal(status, 401);
    assert.equal(json.error, 'SESSION_REQUIRED');
  });
  test('parámetro desconocido -> 400 INVALID_QUERY', async () => {
    const { status, json } = await call('GET', '/sync/pull?organizacionId=x');
    assert.equal(status, 400);
    assert.equal(json.error, 'INVALID_QUERY');
  });
  test('cursor ilegible -> 400 INVALID_CURSOR sin consultar la base', async () => {
    const { status, json } = await call('GET', '/sync/pull?cursor=nope');
    assert.equal(status, 400);
    assert.equal(json.error, 'INVALID_CURSOR');
  });
});

// FASE 15: descargas de fabricación con el router REAL (sesión + Super
// Admin) y repositorio sustituido por datos en memoria.
describe('FASE 15: descargas de fabricación láser (Super Admin)', () => {
  const lote = { loteId: '7', codigoLote: 'LQR-20261018-TEST', tipo: 'QR_AGX', cantidad: 2, urlBase: 'https://agrogenomax.com', creadoAt: '2026-10-18T12:00:00.000Z' };
  const chapetas = ['AGX-7KM4-P2XZ-R', 'AGX-4TR8-N6CW-H'].map((codigoVisible, i) => {
    const token = crypto.randomBytes(24).toString('base64url');
    return { qrId: String(i + 1), codigoVisible, token, tokenHash: crypto.createHash('sha256').update(token).digest('hex') };
  });
  const loaders = {
    loadLote: async (loteId) => {
      if (loteId === '7') return { lote, chapetas };
      if (loteId === '8') return { lote: { ...lote, loteId: '8', tipo: 'QR_LEGACY', urlBase: null }, chapetas: [] };
      if (loteId === '9') return { lote, chapetas: [chapetas[0], { ...chapetas[1], tokenHash: 'f'.repeat(64) }] };
      return null;
    },
    loadChapeta: async (qrId) => {
      if (qrId === '1') return { lote, chapeta: chapetas[0] };
      if (qrId === '3') return { lote: { ...lote, tipo: 'QR_LEGACY' }, chapeta: { qrId: '3', codigoVisible: 'AGX-000001', token: null, tokenHash: null } };
      return null;
    },
  };

  async function descargar(path, { superAdmin = true } = {}) {
    const rawToken = wireFakeSession({ superAdmin });
    const ctx = await startApp({ ...ROUTER_CONFIG, fabricacionLoaders: loaders });
    try {
      const response = await fetch(`${ctx.baseUrl}${path}`, {
        headers: { Origin: ALLOWED_ORIGIN, Cookie: `${sessionCookieName('development')}=${rawToken}` },
      });
      return { status: response.status, headers: response.headers, body: Buffer.from(await response.arrayBuffer()) };
    } finally {
      await closeApp(ctx);
    }
  }

  const ARCHIVOS = [
    ['/admin/qr/lotes/7/paquete.zip', 'application/zip', 'LQR-20261018-TEST-fabricacion.zip'],
    ['/admin/qr/lotes/7/referencia.pdf', 'application/pdf', 'LQR-20261018-TEST-referencia.pdf'],
    ['/admin/qr/lotes/7/manifest.csv', 'text/csv; charset=utf-8', 'LQR-20261018-TEST-manifest.csv'],
    ['/admin/qr/lotes/7/proveedor.html', 'text/html; charset=utf-8', 'LQR-20261018-TEST-vista-previa.html'],
    ['/admin/qr/chapetas/1/arte.svg', 'image/svg+xml; charset=utf-8', 'AGX-7KM4-P2XZ-R-front.svg'],
  ];

  for (const [path, type, filename] of ARCHIVOS) {
    test(`${path}: 200, attachment, no-store, nosniff, ${type}`, async () => {
      const { status, headers, body } = await descargar(path);
      assert.equal(status, 200);
      assert.equal(headers.get('content-type'), type);
      assert.equal(headers.get('content-disposition'), `attachment; filename="${filename}"`);
      assert.equal(headers.get('cache-control'), 'no-store');
      assert.equal(headers.get('x-content-type-options'), 'nosniff');
      assert.ok(body.length > 0);
      if (!path.endsWith('manifest.csv')) {
        for (const c of chapetas) assert.ok(!body.toString('latin1').includes(c.token), 'token en el archivo');
      }
    });
  }

  test('paquete.zip: X-Content-SHA256 = SHA-256 de los bytes recibidos', async () => {
    const { headers, body } = await descargar('/admin/qr/lotes/7/paquete.zip');
    assert.match(headers.get('x-content-sha256'), /^[0-9a-f]{64}$/);
    assert.equal(headers.get('x-content-sha256'), crypto.createHash('sha256').update(body).digest('hex'));
    assert.equal(body.subarray(0, 2).toString('latin1'), 'PK');
  });

  test('arte.svg: CSP default-src none y SVG maestro del FRENTE', async () => {
    const { headers, body } = await descargar('/admin/qr/chapetas/1/arte.svg');
    assert.equal(headers.get('content-security-policy'), "default-src 'none'");
    assert.match(body.toString('utf8'), /<svg [^>]*width="57.0667mm" height="29.8667mm" viewBox="0 0 107 56"/);
  });

  for (const path of ['/admin/qr/lotes/8/paquete.zip', '/admin/qr/lotes/8/referencia.pdf', '/admin/qr/lotes/8/manifest.csv', '/admin/qr/chapetas/3/arte.svg']) {
    test(`${path}: lote legacy -> 409 LOTE_LEGACY_SIN_ARCHIVO`, async () => {
      const { status, body } = await descargar(path);
      assert.equal(status, 409);
      assert.equal(JSON.parse(body).error, 'LOTE_LEGACY_SIN_ARCHIVO');
    });
  }

  test('lote o chapeta inexistente -> 404', async () => {
    assert.equal(JSON.parse((await descargar('/admin/qr/lotes/99/paquete.zip')).body).error, 'LOTE_NOT_FOUND');
    assert.equal(JSON.parse((await descargar('/admin/qr/chapetas/99/arte.svg')).body).error, 'QR_NOT_FOUND');
  });

  for (const path of ['/admin/qr/lotes/9/paquete.zip', '/admin/qr/lotes/9/referencia.pdf', '/admin/qr/lotes/9/manifest.csv']) {
    test(`${path}: verificación fallida -> 500 EXPORT_VERIFICATION_FAILED, sin archivo ni detalles`, async () => {
      const originalError = console.error;
      const logs = [];
      console.error = (...args) => logs.push(args.join(' '));
      try {
        const { status, headers, body } = await descargar(path);
        assert.equal(status, 500);
        assert.equal(headers.get('content-disposition'), null);
        assert.equal(headers.get('x-content-sha256'), null);
        const json = JSON.parse(body);
        assert.equal(json.error, 'EXPORT_VERIFICATION_FAILED');
        assert.doesNotMatch(JSON.stringify(json), /TOKEN_HASH|stack|select/i);
        assert.ok(logs.some((l) => l.includes('TOKEN_HASH_DISTINTO')));
        for (const c of chapetas) assert.ok(!logs.join('\n').includes(c.token));
      } finally {
        console.error = originalError;
      }
    });
  }

  test('cuenta cliente con loaders reales simulados -> 403 (nunca llega a exportar)', async () => {
    const { status, body } = await descargar('/admin/qr/lotes/7/paquete.zip', { superAdmin: false });
    assert.equal(status, 403);
    assert.equal(JSON.parse(body).error, 'SUPERADMIN_REQUIRED');
  });

  test('ruta antigua proveedor.csv retirada -> 404', async () => {
    const { status } = await descargar('/admin/qr/lotes/7/proveedor.csv');
    assert.equal(status, 404);
  });
});
