// FASE 2A: garantías HTTP de POST /api/ganaderia/animales/:animalId/salida y
// /muerte (servidor Express efímero real; sesión simulada; repositorio
// inyectado con `registrarCierre`). RLS, transacciones, idempotencia y
// concurrencia reales: server/services/__tests__/animalCierreIntegration.test.js.
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import express from 'express';

import createGanaderiaAnimalCierreRouter from '../ganaderiaAnimalCierre.js';
import { getAgxAuthPool, __resetAgxAuthPoolForTests } from '../../db/agxAuthPool.js';
import { computeCsrfToken, hashSessionSecret, sessionCookieName } from '../../security/ganaderiaSession.js';
import { __resetAgxBusinessPoolForTests } from '../../db/agxBusinessPool.js';
import { getConfig, __resetValidationStateForTests } from '../../config/env.js';
import { errorHandler, notFound } from '../../middleware/errors.js';
import { resolveFechaHoyNegocio } from '../../services/ganaderia/motorDescansoAuto/businessTimezone.js';

const TEST_CSRF_SECRET = 'gwslZ1bKInXjQ0TLmMqWeV6vRAL2hONB6bTBqpAjVFs=';
const ALLOWED_ORIGIN = 'https://agrogenomax.com';
const FAKE_AUTH_CONNECTION_STRING = 'postgres://test:test@192.0.2.1:5432/never_connects';
const ORG_A = '00000000-0000-4000-8000-00000000000a';
const ORG_B = '00000000-0000-4000-8000-00000000000b';
const OP_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const SALIDA = Object.freeze({ fechaSalida: '2026-10-01', motivoSalida: 'VENTA', clientOperationId: OP_ID });
const MUERTE = Object.freeze({ fechaMuerte: '2026-10-01', causaMuerte: 'ENFERMEDAD', clientOperationId: OP_ID });

const llamadas = [];
let respuesta = null;
async function registrarFalso(organizacionId, animalId, value, opciones) {
  llamadas.push({ organizacionId, animalId, value, opciones });
  if (respuesta instanceof Error) throw respuesta;
  return respuesta ?? { animal: { animalId }, evento: { tipo: 'SALIDO' }, yaExistia: false };
}

before(() => {
  delete process.env.DATABASE_URL;
  delete process.env.AGX_BUSINESS_DATABASE_URL;
});

beforeEach(() => {
  __resetAgxAuthPoolForTests();
  __resetAgxBusinessPoolForTests();
  __resetValidationStateForTests();
  getConfig({ APP_ENV: 'development' }, {});
  llamadas.length = 0;
  respuesta = null;
});

function startApp({ inyectar = true } = {}) {
  const app = express();
  app.use(express.json());
  for (const [ruta, tipo] of [['salida', 'SALIDA'], ['muerte', 'MUERTE']]) {
    app.use(`/api/ganaderia/animales/:animalId/${ruta}`, createGanaderiaAnimalCierreRouter({
      tipo,
      appEnv: 'development',
      csrfServerSecret: TEST_CSRF_SECRET,
      allowedOrigins: [ALLOWED_ORIGIN],
      ...(inyectar ? { registrarCierre: registrarFalso } : {}),
    }));
  }
  app.use(notFound);
  app.use(errorHandler);
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}/api/ganaderia` }));
  });
}

function wireFakeSession(organizacionId, rol = 'owner') {
  const rawToken = crypto.randomBytes(32).toString('base64url');
  const tokenHash = hashSessionSecret(rawToken);
  const pool = getAgxAuthPool({ AGX_AUTH_DATABASE_URL: FAKE_AUTH_CONNECTION_STRING });
  pool.query = async (text, params = []) => {
    if (text.includes('from agx.sesiones s') && params[0] === tokenHash) {
      return { rows: [{ sesion_id: 's', cuenta_id: 'cuenta-1', organizacion_id: organizacionId, fecha_expiracion: new Date(Date.now() + 60_000).toISOString(), fecha_revocacion: null, cuenta_estado: 'activa', email: 't@example.com', nombre: 'T' }] };
    }
    if (text.includes('fn_resolver_autorizacion_sesion') && params[0] === tokenHash) {
      return { rows: [{ sesion_id: 's', cuenta_id: 'cuenta-1', organizacion_id: organizacionId, rol }] };
    }
    return { rows: [] };
  };
  return rawToken;
}

async function post(path, body, { org = ORG_A, rol = 'owner', csrf = 'valid', method = 'POST', headers: extra = {}, inyectar } = {}) {
  const rawToken = org ? wireFakeSession(org, rol) : null;
  const ctx = await startApp({ inyectar });
  try {
    const headers = { 'Content-Type': 'application/json', Origin: ALLOWED_ORIGIN, ...extra };
    if (rawToken) headers.Cookie = `${sessionCookieName('development')}=${rawToken}`;
    if (rawToken && csrf === 'valid') headers['X-CSRF-Token'] = computeCsrfToken(rawToken, TEST_CSRF_SECRET);
    if (rawToken && csrf === 'invalid') headers['X-CSRF-Token'] = 'x'.repeat(43);
    const response = await fetch(`${ctx.baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    return { status: response.status, json, text, cache: response.headers.get('cache-control') };
  } finally {
    await new Promise((resolve) => ctx.server.close(resolve));
  }
}

describe('FASE 2A: POST salida / muerte -- autenticación y CSRF', () => {
  test('sin sesión -> 401 (salida y muerte), sin tocar el repositorio', async () => {
    assert.equal((await post('/animales/1/salida', SALIDA, { org: null })).status, 401);
    assert.equal((await post('/animales/1/muerte', MUERTE, { org: null })).status, 401);
    assert.equal(llamadas.length, 0);
  });

  test('POST exige CSRF: sin token o inválido -> 403', async () => {
    for (const csrf of ['none', 'invalid']) {
      assert.equal((await post('/animales/1/salida', SALIDA, { csrf })).status, 403, csrf);
      assert.equal((await post('/animales/1/muerte', MUERTE, { csrf })).status, 403, csrf);
    }
    assert.equal(llamadas.length, 0);
  });

  test('solo POST: GET -> 404 (sin endpoint genérico de estado)', async () => {
    assert.equal((await post('/animales/1/salida', undefined, { method: 'GET' })).status, 404);
  });
});

describe('FASE 2A: validación previa a la base de negocio', () => {
  test('animalId inválido -> 400 INVALID_ANIMAL_ID', async () => {
    for (const id of ['abc', '0', '1.5']) {
      assert.equal((await post(`/animales/${id}/salida`, SALIDA)).json.error, 'INVALID_ANIMAL_ID', id);
    }
    assert.equal(llamadas.length, 0);
  });

  test('organizacionId en el body -> 400 FORBIDDEN_FIELDS; campos del otro tipo también', async () => {
    assert.equal((await post('/animales/1/salida', { ...SALIDA, organizacionId: ORG_B })).json.error, 'FORBIDDEN_FIELDS');
    assert.equal((await post('/animales/1/salida', { ...SALIDA, causaMuerte: 'ENFERMEDAD' })).json.error, 'FORBIDDEN_FIELDS');
    assert.equal((await post('/animales/1/muerte', { ...MUERTE, motivoSalida: 'VENTA' })).json.error, 'FORBIDDEN_FIELDS');
    assert.equal(llamadas.length, 0);
  });

  test('fecha futura, formato o ausente -> 400 INVALID_FECHA', async () => {
    const manana = new Date(`${resolveFechaHoyNegocio()}T12:00:00Z`);
    manana.setUTCDate(manana.getUTCDate() + 1);
    const futura = manana.toISOString().slice(0, 10);
    for (const fecha of [futura, '2026-13-01', '01/10/2026', '', undefined]) {
      assert.equal((await post('/animales/1/salida', { ...SALIDA, fechaSalida: fecha })).json.error, 'INVALID_FECHA', String(fecha));
      assert.equal((await post('/animales/1/muerte', { ...MUERTE, fechaMuerte: fecha })).json.error, 'INVALID_FECHA', String(fecha));
    }
    assert.equal(llamadas.length, 0);
  });

  test('motivo/causa fuera de catálogo -> 400; SACRIFICIO es causa de muerte, no motivo de salida', async () => {
    assert.equal((await post('/animales/1/salida', { ...SALIDA, motivoSalida: 'SACRIFICIO' })).json.error, 'INVALID_MOTIVO_SALIDA');
    assert.equal((await post('/animales/1/muerte', { ...MUERTE, causaMuerte: 'VENTA' })).json.error, 'INVALID_CAUSA_MUERTE');
    assert.equal(llamadas.length, 0);
  });

  test('clientOperationId inválido y observaciones > 500 -> 400', async () => {
    assert.equal((await post('/animales/1/salida', { ...SALIDA, clientOperationId: 'x' })).json.error, 'INVALID_CLIENT_OPERATION_ID');
    assert.equal((await post('/animales/1/salida', { ...SALIDA, observaciones: 'a'.repeat(501) })).json.error, 'INVALID_OBSERVACIONES');
    assert.equal(llamadas.length, 0);
  });
});

describe('FASE 2A: delegación al repositorio', () => {
  test('201 al crear; organización y actor SOLO de la sesión (query/headers ignorados)', async () => {
    const r = await post(`/animales/7/salida?organizacionId=${ORG_B}`, { ...SALIDA, observaciones: '  Lote  vendido \r\n' }, { headers: { 'X-Organizacion-Id': ORG_B } });
    assert.equal(r.status, 201);
    assert.equal(r.cache, 'no-store');
    assert.deepEqual(r.json, { ok: true, yaExistia: false, animal: { animalId: '7' }, evento: { tipo: 'SALIDO' } });
    assert.equal(llamadas.length, 1);
    assert.equal(llamadas[0].organizacionId, ORG_A);
    assert.equal(llamadas[0].animalId, '7');
    assert.deepEqual(llamadas[0].opciones, { actorCuentaId: 'cuenta-1' });
    assert.deepEqual(llamadas[0].value, { tipo: 'SALIDA', clientOperationId: OP_ID, fecha: '2026-10-01', causa: 'VENTA', observaciones: 'Lote  vendido' });
  });

  test('muerte delega con tipo MUERTE; reintento idempotente -> 200 yaExistia', async () => {
    respuesta = { animal: { animalId: '7' }, evento: { tipo: 'MUERTO' }, yaExistia: true };
    const r = await post('/animales/7/muerte', MUERTE);
    assert.equal(r.status, 200);
    assert.equal(r.json.yaExistia, true);
    assert.equal(llamadas[0].value.tipo, 'MUERTE');
    assert.equal(llamadas[0].value.causa, 'ENFERMEDAD');
  });

  test('errores semánticos -> mismo status/código; sin SQL ni trazas', async () => {
    for (const [code, status] of [['ANIMAL_NOT_FOUND', 404], ['ANIMAL_ANULADO', 409], ['ANIMAL_YA_SALIDO', 409], ['ANIMAL_YA_MUERTO', 409], ['CLIENT_OPERATION_ID_REUSED', 409]]) {
      respuesta = Object.assign(new Error('mensaje'), { status, code });
      const r = await post('/animales/7/salida', SALIDA);
      assert.equal(r.status, status, code);
      assert.deepEqual(r.json, { error: code, message: 'mensaje' });
    }
    respuesta = Object.assign(new Error('relation "agx.animales" violates check constraint'), { code: '23514' });
    const r = await post('/animales/7/salida', SALIDA);
    assert.equal(r.status, 500);
    assert.doesNotMatch(r.text, /agx\.|constraint|select|stack|at /i);
  });
});

describe('FASE 2B: RBAC de cierres (owner/admin)', () => {
  test('operador y lector -> 403 ROLE_FORBIDDEN en salida y muerte, sin tocar el repositorio', async () => {
    for (const rol of ['operador', 'lector']) {
      const salida = await post('/animales/7/salida', SALIDA, { rol });
      const muerte = await post('/animales/7/muerte', MUERTE, { rol });
      assert.equal(salida.status, 403, rol);
      assert.deepEqual(salida.json, { error: 'ROLE_FORBIDDEN' });
      assert.equal(muerte.status, 403, rol);
      assert.deepEqual(muerte.json, { error: 'ROLE_FORBIDDEN' });
    }
    assert.equal(llamadas.length, 0);
  });

  test('owner y admin -> pasan (201) y delegan al repositorio', async () => {
    for (const rol of ['owner', 'admin']) {
      assert.equal((await post('/animales/7/salida', SALIDA, { rol })).status, 201, rol);
      assert.equal((await post('/animales/7/muerte', MUERTE, { rol })).status, 201, rol);
    }
    assert.equal(llamadas.length, 4);
  });

  test('rol desconocido (p. ej. "propietario") o ausente -> 403; sin sesión sigue siendo 401', async () => {
    for (const rol of ['propietario', 'super_admin', null]) {
      assert.equal((await post('/animales/7/salida', SALIDA, { rol })).json?.error, 'ROLE_FORBIDDEN', String(rol));
    }
    assert.equal((await post('/animales/7/salida', SALIDA, { org: null, rol: 'lector' })).status, 401);
    assert.equal(llamadas.length, 0);
  });

  test('el rol se exige DESPUÉS de la sesión (orden de middlewares en el router)', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('../ganaderiaAnimalCierre.js', import.meta.url), 'utf8');
    const sesion = src.indexOf('router.use(createRequireGanaderiaSession');
    const rol = src.indexOf('router.use(createRequireGanaderiaRole(...ROLES_CIERRE))');
    const post = src.indexOf("router.post('/'");
    assert.ok(sesion > 0 && rol > sesion && post > rol);
    // FASE 3A: ROLES_CIERRE sale de la matriz central (owner/admin).
    assert.match(src, /ROLES_CIERRE = ROLES_ADMINISTRACION;/);
    const { ROLES_CIERRE } = await import('../ganaderiaAnimalCierre.js');
    assert.deepEqual([...ROLES_CIERRE], ['owner', 'admin']);
  });
});
