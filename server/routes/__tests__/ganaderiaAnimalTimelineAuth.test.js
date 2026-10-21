// FASE 1D.2: garantías HTTP de GET /api/ganaderia/animales/:animalId/timeline
// (servidor Express efímero real; sesión simulada; fuentes Business
// inyectadas con `leerFuentes`). El aislamiento con RLS real se prueba en
// server/services/__tests__/timelineIntegration.test.js.
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import express from 'express';

import createGanaderiaAnimalTimelineRouter from '../ganaderiaAnimalTimeline.js';
import { getAgxAuthPool, __resetAgxAuthPoolForTests } from '../../db/agxAuthPool.js';
import { hashSessionSecret, sessionCookieName } from '../../security/ganaderiaSession.js';
import { __resetAgxBusinessPoolForTests } from '../../db/agxBusinessPool.js';
import { getConfig, __resetValidationStateForTests } from '../../config/env.js';
import { errorHandler, notFound } from '../../middleware/errors.js';

const TEST_CSRF_SECRET = 'gwslZ1bKInXjQ0TLmMqWeV6vRAL2hONB6bTBqpAjVFs=';
const ALLOWED_ORIGIN = 'https://agrogenomax.com';
const FAKE_AUTH_CONNECTION_STRING = 'postgres://test:test@192.0.2.1:5432/never_connects';
const ORG_A = '00000000-0000-4000-8000-00000000000a';
const ORG_B = '00000000-0000-4000-8000-00000000000b';
const TOKEN = 'aB3_-xYz09QwErTyUiOpAsDfGhJkLzX1';

const ev = (eventoId, tipoEvento, ocurridoEn, metadata = {}) => ({ eventoId: String(eventoId), tipoEvento, metadata, ocurridoEn });
const ps = (pesajeId, fecha, pesoKg, createdAt) => ({ pesajeId: String(pesajeId), fecha, pesoKg, metodo: 'BASCULA', origen: 'MANUAL', observaciones: null, createdAt });

const DATOS = {
  [ORG_A]: {
    1: { animal: { animalId: '1', estado: 'ACTIVO', fechaCreacion: '2026-10-18T12:20:58Z' }, eventosAnimal: [ev(1, 'REGISTRADO', '2026-10-18T12:20:58Z', { intentHash: 'v1:secreto' })], pesajes: [] },
    2: {
      animal: { animalId: '2', estado: 'ACTIVO', fechaCreacion: '2026-10-18T12:20:58Z' },
      eventosAnimal: [ev(2, 'REGISTRADO', '2026-10-18T12:20:58Z', { intentHash: 'v1:secreto' }), ev(3, 'QR_ASOCIADO', '2026-10-18T13:00:00Z', { qrId: '9', codigoVisible: 'AGX-7KM4-P2XZ-R', token: TOKEN })],
      pesajes: [ps(1, '2026-10-19', 350, '2026-10-20T01:00:00Z'), ps(2, '2026-10-20', 355, '2026-10-21T00:38:34Z'), ps(3, '2026-10-20', 360, '2026-10-21T04:03:05Z')],
    },
    3: {
      animal: { animalId: '3', estado: 'ANULADO', fechaCreacion: '2026-10-01T12:00:00Z' },
      eventosAnimal: [ev(4, 'REGISTRADO', '2026-10-01T12:00:00Z'), ev(5, 'ANULADO', '2026-10-02T12:00:00Z', { motivo: 'Duplicado' })],
      pesajes: [],
    },
  },
  [ORG_B]: {
    900: { animal: { animalId: '900', estado: 'ACTIVO', fechaCreacion: '2026-10-01T12:00:00Z' }, eventosAnimal: [ev(99, 'REGISTRADO', '2026-10-01T12:00:00Z')], pesajes: [ps(99, '2026-10-01', 777, '2026-10-01T15:00:00Z')] },
  },
};

const llamadas = [];
async function leerFuentesFalso(organizacionId, animalId) {
  llamadas.push({ organizacionId, animalId });
  const fila = DATOS[organizacionId]?.[animalId];
  return fila ? structuredClone(fila) : null;
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
});

function startApp(opciones = {}) {
  const app = express();
  app.use(express.json());
  app.use('/api/ganaderia/animales/:animalId/timeline', createGanaderiaAnimalTimelineRouter({
    appEnv: 'development', csrfServerSecret: TEST_CSRF_SECRET, allowedOrigins: [ALLOWED_ORIGIN], leerFuentes: leerFuentesFalso, ...opciones,
  }));
  app.use(notFound);
  app.use(errorHandler);
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}/api/ganaderia` }));
  });
}

function wireFakeSession(organizacionId) {
  const rawToken = crypto.randomBytes(32).toString('base64url');
  const tokenHash = hashSessionSecret(rawToken);
  const pool = getAgxAuthPool({ AGX_AUTH_DATABASE_URL: FAKE_AUTH_CONNECTION_STRING });
  pool.query = async (text, params = []) => {
    if (text.includes('from agx.sesiones s') && params[0] === tokenHash) {
      return { rows: [{ sesion_id: 's', cuenta_id: 'c', organizacion_id: organizacionId, fecha_expiracion: new Date(Date.now() + 60_000).toISOString(), fecha_revocacion: null, cuenta_estado: 'activa', email: 't@example.com', nombre: 'T' }] };
    }
    if (text.includes('fn_resolver_autorizacion_sesion') && params[0] === tokenHash) {
      return { rows: [{ sesion_id: 's', cuenta_id: 'c', organizacion_id: organizacionId, rol: 'propietario' }] };
    }
    return { rows: [] };
  };
  return rawToken;
}

async function pedir(path, { org = ORG_A, method = 'GET', headers: extra = {}, opciones } = {}) {
  const rawToken = org ? wireFakeSession(org) : null;
  const ctx = await startApp(opciones);
  try {
    const headers = { Origin: ALLOWED_ORIGIN, ...extra };
    if (rawToken) headers.Cookie = `${sessionCookieName('development')}=${rawToken}`;
    const response = await fetch(`${ctx.baseUrl}${path}`, { method, headers });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    return { status: response.status, headers: response.headers, text, json };
  } finally {
    await new Promise((resolve) => ctx.server.close(resolve));
  }
}

const URL_T = (id, q = '') => `/animales/${id}/timeline${q}`;

describe('FASE 1D.2: timeline -- autenticación, validación y tenant', () => {
  test('1. sin sesión -> 401 y no lee fuentes', async () => {
    const r = await pedir(URL_T(1), { org: null });
    assert.equal(r.status, 401);
    assert.equal(llamadas.length, 0);
  });

  test('animalId o limit inválidos -> 400 sin leer fuentes', async () => {
    for (const id of ['abc', '0', '1.5']) assert.equal((await pedir(URL_T(id))).json.error, 'INVALID_ANIMAL_ID', id);
    for (const q of ['?limit=0', '?limit=201', '?limit=abc', '?limit=-3']) assert.equal((await pedir(URL_T(1, q))).json.error, 'INVALID_LIMIT', q);
    assert.equal(llamadas.length, 0);
  });

  test('2/3. inexistente y ajeno -> mismo 404, sin datos de la otra organización', async () => {
    const ajeno = await pedir(URL_T(900));
    const inexistente = await pedir(URL_T(999999));
    assert.equal(ajeno.status, 404);
    assert.deepEqual(ajeno.json, inexistente.json);
    assert.deepEqual(ajeno.json, { error: 'ANIMAL_NOT_FOUND' });
    assert.doesNotMatch(ajeno.text, /777/);
    assert.equal((await pedir(URL_T(900), { org: ORG_B })).status, 200, 'la dueña sí lo ve');
  });

  test('21. la organización SIEMPRE sale de la sesión (query/headers ignorados)', async () => {
    const r = await pedir(URL_T(900, `?organizacionId=${ORG_B}&organizacion_id=${ORG_B}`), { headers: { 'X-Organizacion-Id': ORG_B } });
    assert.equal(r.status, 404);
    assert.deepEqual(llamadas.map((l) => l.organizacionId), [ORG_A]);
  });

  test('22. solo lectura: POST/PUT/DELETE no existen (403 CSRF o 404), nunca escriben', async () => {
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const r = await pedir(URL_T(2), { method });
      assert.ok([403, 404].includes(r.status), `${method} -> ${r.status}`);
    }
    assert.equal(llamadas.length, 0);
  });
});

describe('FASE 1D.2: timeline -- respuesta', () => {
  test('4/7/16. animal activo con registro + QR + pesajes: contrato y orden DESCENDENTE', async () => {
    const r = await pedir(URL_T(2));
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal(r.json.ok, true);
    assert.equal(r.json.animalId, '2');
    assert.equal(r.json.orden, 'DESCENDENTE');
    assert.equal(r.json.limit, 50);
    assert.equal(r.json.total, 5);
    assert.equal(r.json.truncado, false);
    assert.deepEqual(r.json.eventos.map((e) => e.id), ['pesaje:3', 'pesaje:2', 'pesaje:1', 'animal_evento:3', 'animal_evento:2']);
    const p3 = r.json.eventos[0];
    assert.equal(p3.datos.diasDesdeAnterior, 0);
    assert.equal(p3.datos.gmdKgDia, null);
    assert.equal(r.json.eventos[1].datos.gmdKgDia, 5);
  });

  test('19. nunca expone token QR, qrId ni intentHash', async () => {
    const r = await pedir(URL_T(2));
    assert.ok(!r.text.includes(TOKEN));
    assert.doesNotMatch(r.text, /qrId|intentHash|v1:secreto|"token"/);
    assert.match(r.text, /AGX-7KM4-P2XZ-R/);
  });

  test('5/12. animal anulado: timeline permitido con el evento de anulación', async () => {
    const r = await pedir(URL_T(3));
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.eventos.map((e) => `${e.tipo}:${e.descripcion}`), ['ANIMAL_ANULADO:Motivo: Duplicado', 'ANIMAL_REGISTRADO:Alta del animal en AgroGenomaX.']);
  });

  test('6. solo registro', async () => {
    const r = await pedir(URL_T(1));
    assert.deepEqual(r.json.eventos.map((e) => e.tipo), ['ANIMAL_REGISTRADO']);
  });

  test('18. limit aplicado', async () => {
    const r = await pedir(URL_T(2, '?limit=2'));
    assert.equal(r.json.limit, 2);
    assert.equal(r.json.eventos.length, 2);
    assert.equal(r.json.total, 5);
    assert.equal(r.json.truncado, true);
  });

  test('error interno -> 500 genérico sin SQL ni stack', async () => {
    const r = await pedir(URL_T(2), { opciones: { leerFuentes: async () => { throw new Error('relation agx.animal_eventos does not exist at x.js:1'); } } });
    assert.equal(r.status, 500);
    assert.doesNotMatch(r.text, /relation|animal_eventos|\.js:/);
  });
});
