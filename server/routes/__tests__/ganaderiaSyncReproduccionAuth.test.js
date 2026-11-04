// FASE 4E.1: garantías HTTP de GET /api/ganaderia/sync/reproduccion (servidor
// Express efímero real; sesión simulada; repositorio inyectado). RLS, cursor y
// solape reales: server/services/__tests__/reproduccionSyncIntegration.test.js.
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import express from 'express';

import createGanaderiaSyncRouter from '../ganaderiaSync.js';
import { getAgxAuthPool, __resetAgxAuthPoolForTests } from '../../db/agxAuthPool.js';
import { computeCsrfToken, hashSessionSecret, sessionCookieName } from '../../security/ganaderiaSession.js';
import { __resetAgxBusinessPoolForTests } from '../../db/agxBusinessPool.js';
import { getConfig, __resetValidationStateForTests } from '../../config/env.js';
import { errorHandler, notFound } from '../../middleware/errors.js';
import {
  decodeCursorReproduccion,
  encodeCursorReproduccion,
  pullEventosReproductivos,
} from '../../services/ganaderia/reproduccionSyncRepository.js';
import { decodeCursor, encodeCursor } from '../../services/ganaderia/syncRepository.js';

const TEST_CSRF_SECRET = 'gwslZ1bKInXjQ0TLmMqWeV6vRAL2hONB6bTBqpAjVFs=';
const ALLOWED_ORIGIN = 'https://agrogenomax.com';
const FAKE_AUTH_CONNECTION_STRING = 'postgres://test:test@192.0.2.1:5432/never_connects';
const ORG_A = '00000000-0000-4000-8000-00000000000a';
const ORG_B = '00000000-0000-4000-8000-00000000000b';
const INSTANTE = '2026-10-20T15:00:00.123456Z';
const VACIA = Object.freeze({ eventos: [], hayMas: false, completo: true, cursor: 'c', totales: { eventos: 0, anulados: 0 } });

const llamadas = [];
let respuesta = VACIA;
const REPO = {
  async pullEventosReproductivos(...args) {
    llamadas.push(args);
    if (respuesta instanceof Error) throw respuesta;
    return respuesta;
  },
};

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
  respuesta = VACIA;
});

function wireFakeSession(organizacionId, rol) {
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

async function llamar(ruta, { org = ORG_A, rol = 'lector', method = 'GET', headers: extra = {}, repo = REPO } = {}) {
  const rawToken = org ? wireFakeSession(org, rol) : null;
  const app = express();
  app.use(express.json());
  app.use('/api/ganaderia/sync', createGanaderiaSyncRouter({ appEnv: 'development', csrfServerSecret: TEST_CSRF_SECRET, allowedOrigins: [ALLOWED_ORIGIN], reproduccionRepo: repo }));
  app.use(notFound);
  app.use(errorHandler);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const headers = { Origin: ALLOWED_ORIGIN, ...extra };
    if (rawToken) {
      headers.Cookie = `${sessionCookieName('development')}=${rawToken}`;
      headers['X-CSRF-Token'] = computeCsrfToken(rawToken, TEST_CSRF_SECRET);
    }
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/ganaderia/sync${ruta}`, { method, headers });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    return { status: response.status, json, text, cache: response.headers.get('cache-control') };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe('GET /sync/reproduccion', () => {
  test('vacío: respuesta válida, no-store y el tenant sale de la sesión', async () => {
    const res = await llamar('/reproduccion');
    assert.equal(res.status, 200);
    assert.equal(res.cache, 'no-store');
    assert.deepEqual(res.json, { ok: true, organizacionId: ORG_A, cuentaId: 'cuenta-1', ...VACIA });
    assert.deepEqual(llamadas[0], [ORG_A, { cursor: undefined }]);
  });

  test('cuentaId es la de la sesión: ni el repositorio ni la petición pueden cambiarla', async () => {
    respuesta = { ...VACIA, cuentaId: 'cuenta-2', organizacionId: ORG_B };
    const res = await llamar('/reproduccion', { headers: { 'X-Cuenta-Id': 'cuenta-3' } });
    assert.equal(res.status, 200);
    assert.equal(res.json.cuentaId, 'cuenta-1');
    assert.equal(res.json.organizacionId, ORG_A);
    assert.equal((await llamar('/reproduccion?cuentaId=cuenta-3')).status, 400);
  });

  test('los 4 roles leen', async () => {
    for (const rol of ['owner', 'admin', 'operador', 'lector']) assert.equal((await llamar('/reproduccion', { rol })).status, 200, rol);
  });

  test('sin sesión: 401 y nunca toca el repositorio', async () => {
    const res = await llamar('/reproduccion', { org: null });
    assert.equal(res.status, 401);
    assert.equal(llamadas.length, 0);
  });

  test('el tenant nunca viene de query ni de cabeceras', async () => {
    for (const q of [`organizacionId=${ORG_B}`, `organizacion_id=${ORG_B}`, `cursor=&organizacionId=${ORG_B}`, 'limit=1000']) {
      const res = await llamar(`/reproduccion?${q}`);
      assert.equal(res.status, 400, q);
      assert.equal(res.json.error, 'INVALID_QUERY');
      assert.equal(res.cache, 'no-store');
    }
    assert.equal(llamadas.length, 0);
    await llamar('/reproduccion', { headers: { 'X-Organizacion-Id': ORG_B } });
    assert.equal(llamadas[0][0], ORG_A);
  });

  test('solo lectura: ninguna mutación existe', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      assert.equal((await llamar('/reproduccion', { method, rol: 'owner' })).status, 404, method);
    }
    assert.equal(llamadas.length, 0);
  });

  test('cursor inválido: 400 seguro con el repositorio real, sin tocar la base', async () => {
    const malos = ['x', '%00', encodeURIComponent('{"v":1}'), 'a'.repeat(401), encodeCursor(INSTANTE), encodeCursorReproduccion({ c: 'no-es-fecha' })];
    for (const cursor of malos) {
      const res = await llamar(`/reproduccion?cursor=${cursor}`, { repo: { pullEventosReproductivos } });
      assert.equal(res.status, 400, cursor);
      assert.deepEqual(res.json, { error: 'INVALID_CURSOR', message: 'Cursor de sincronización inválido.' });
      assert.equal(res.cache, 'no-store');
    }
  });

  test('cursor repetido en la query (array): 400 seguro', async () => {
    const res = await llamar('/reproduccion?cursor=a&cursor=b', { repo: { pullEventosReproductivos } });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, 'INVALID_CURSOR');
  });

  test('un error interno no expone SQL ni detalles', async () => {
    respuesta = new Error('select secreto from agx.reproduccion_eventos');
    const res = await llamar('/reproduccion');
    assert.equal(res.status, 500);
    assert.equal(res.text.includes('secreto'), false);
    assert.equal(res.text.includes('reproduccion_eventos'), false);
  });

  test('error semántico del repositorio: su código, sin más', async () => {
    respuesta = Object.assign(new Error('Cursor de sincronización inválido.'), { status: 400, code: 'INVALID_CURSOR' });
    const res = await llamar('/reproduccion?cursor=z');
    assert.equal(res.status, 400);
    assert.equal(res.json.error, 'INVALID_CURSOR');
  });
});

describe('cursor reproductivo', () => {
  const ENTRE = { c: INSTANTE };
  const DENTRO = { c: INSTANTE, d: '2026-10-20T14:55:00.123Z', m: '2026-10-20T14:56:00.000001Z', i: '42', f: 1 };

  test('ida y vuelta conserva los microsegundos', () => {
    assert.deepEqual(decodeCursorReproduccion(encodeCursorReproduccion(ENTRE)), { c: INSTANTE, f: false });
    const dentro = decodeCursorReproduccion(encodeCursorReproduccion(DENTRO));
    assert.equal(dentro.m, DENTRO.m);
    assert.equal(dentro.i, '42');
    assert.equal(dentro.f, true);
  });

  test('ausente o vacío: recorrido completo', () => {
    assert.equal(decodeCursorReproduccion(undefined), null);
    assert.equal(decodeCursorReproduccion(''), null);
  });

  test('no comparte cursor con /sync/pull, en ningún sentido', () => {
    assert.throws(() => decodeCursorReproduccion(encodeCursor(INSTANTE)), { code: 'INVALID_CURSOR' });
    assert.throws(() => decodeCursor(encodeCursorReproduccion(ENTRE)), { code: 'INVALID_CURSOR' });
  });

  for (const [nombre, contenido] of [
    ['fecha imposible', { c: '2026-02-30T00:00:00.000000Z' }],
    ['sin microsegundos', { c: '2026-10-20T15:00:00Z' }],
    ['inyección en la marca', { ...DENTRO, m: "2026-10-20T14:56:00.000001Z'; drop table x" }],
    ['id no numérico', { ...DENTRO, i: '1 or 1=1' }],
    ['id fuera de bigint', { ...DENTRO, i: '9223372036854775808' }],
    ['id cero', { ...DENTRO, i: '0' }],
    ['id como número', { ...DENTRO, i: 42 }],
    ['continuación incompleta', { c: INSTANTE, m: DENTRO.m }],
    ['cota inválida', { ...DENTRO, d: 'x' }],
  ]) {
    test(`rechaza: ${nombre}`, () => {
      assert.throws(() => decodeCursorReproduccion(encodeCursorReproduccion(contenido)), { code: 'INVALID_CURSOR', status: 400 });
    });
  }

  test('rechaza otra versión o discriminador', () => {
    const crudo = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');
    assert.throws(() => decodeCursorReproduccion(crudo({ v: 2, s: 'repro', c: INSTANTE })), { code: 'INVALID_CURSOR' });
    assert.throws(() => decodeCursorReproduccion(crudo({ v: 1, s: 'otro', c: INSTANTE })), { code: 'INVALID_CURSOR' });
    assert.throws(() => decodeCursorReproduccion(crudo(null)), { code: 'INVALID_CURSOR' });
  });
});
