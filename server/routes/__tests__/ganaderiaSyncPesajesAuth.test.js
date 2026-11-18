// FASE 5A.3a: garantías HTTP de GET /api/ganaderia/sync/pesajes (servidor Express
// efímero real; sesión simulada; repositorio inyectado) y validación del cursor.
// RLS, keyset y solape reales: server/services/__tests__/pesajesSyncIntegration.test.js.
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
import { decodeCursorPesajes, encodeCursorPesajes, pullPesajes, serializePesajeSync } from '../../services/ganaderia/pesajesSyncRepository.js';
import { decodeCursorReproduccion, encodeCursorReproduccion } from '../../services/ganaderia/reproduccionSyncRepository.js';
import { decodeCursor, encodeCursor } from '../../services/ganaderia/syncRepository.js';

const TEST_CSRF_SECRET = 'gwslZ1bKInXjQ0TLmMqWeV6vRAL2hONB6bTBqpAjVFs=';
const ALLOWED_ORIGIN = 'https://agrogenomax.com';
const FAKE_AUTH_CONNECTION_STRING = 'postgres://test:test@192.0.2.1:5432/never_connects';
const ORG_A = '00000000-0000-4000-8000-00000000000a';
const ORG_B = '00000000-0000-4000-8000-00000000000b';
const INSTANTE = '2026-10-20T15:00:00.123456Z';
const VACIA = Object.freeze({ pesajes: [], hayMas: false, completo: true, cursorSiguiente: 'c', totales: { pesajes: 0, anulados: 0 } });

const llamadas = [];
let respuesta = VACIA;
const REPO = {
  async pullPesajes(...args) {
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
    if (text.includes('fn_resolver_autorizacion_sesion') && params[0] === tokenHash && organizacionId) {
      return { rows: [{ sesion_id: 's', cuenta_id: 'cuenta-1', organizacion_id: organizacionId, rol }] };
    }
    return { rows: [] };
  };
  return rawToken;
}

async function llamar(ruta, { org = ORG_A, sinSesion = false, rol = 'lector', method = 'GET', headers: extra = {}, repo = REPO } = {}) {
  const rawToken = sinSesion ? null : wireFakeSession(org, rol);
  const app = express();
  app.use(express.json());
  app.use('/api/ganaderia/sync', createGanaderiaSyncRouter({ appEnv: 'development', csrfServerSecret: TEST_CSRF_SECRET, allowedOrigins: [ALLOWED_ORIGIN], pesajesRepo: repo }));
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

describe('GET /sync/pesajes', () => {
  test('vacío: contrato exacto, no-store y el tenant sale de la sesión', async () => {
    const res = await llamar('/pesajes');
    assert.equal(res.status, 200);
    assert.equal(res.cache, 'no-store');
    assert.deepEqual(res.json, { ok: true, organizacionId: ORG_A, cuentaId: 'cuenta-1', ...VACIA });
    assert.deepEqual(llamadas[0], [ORG_A, { cursor: undefined }]);
  });

  test('organizacionId y cuentaId son los de la sesión: ni el repositorio ni la petición los cambian', async () => {
    respuesta = { ...VACIA, cuentaId: 'cuenta-2', organizacionId: ORG_B };
    const res = await llamar('/pesajes', { headers: { 'X-Cuenta-Id': 'cuenta-3', 'X-Organizacion-Id': ORG_B } });
    assert.equal(res.status, 200);
    assert.equal(res.json.cuentaId, 'cuenta-1');
    assert.equal(res.json.organizacionId, ORG_A);
    assert.equal(llamadas[0][0], ORG_A);
  });

  test('los 4 roles leen (preparar dispositivo no exige owner/admin)', async () => {
    for (const rol of ['owner', 'admin', 'operador', 'lector']) assert.equal((await llamar('/pesajes', { rol })).status, 200, rol);
  });

  test('sin sesión: 401 y nunca toca el repositorio', async () => {
    const res = await llamar('/pesajes', { sinSesion: true });
    assert.equal(res.status, 401);
    assert.equal(llamadas.length, 0);
  });

  test('sesión sin organización activa: 409 ORGANIZATION_REQUIRED y nunca toca el repositorio', async () => {
    const res = await llamar('/pesajes', { org: null });
    assert.equal(res.status, 409);
    assert.equal(res.json.error, 'ORGANIZATION_REQUIRED');
    assert.equal(llamadas.length, 0);
  });

  test('el tenant nunca viene de la query: parámetros desconocidos -> 400 INVALID_QUERY', async () => {
    for (const q of [`organizacionId=${ORG_B}`, `organizacion_id=${ORG_B}`, `cursor=&organizacionId=${ORG_B}`, 'limit=1000', 'animalId=1']) {
      const res = await llamar(`/pesajes?${q}`);
      assert.equal(res.status, 400, q);
      assert.equal(res.json.error, 'INVALID_QUERY');
      assert.equal(res.cache, 'no-store');
    }
    assert.equal(llamadas.length, 0);
  });

  test('solo lectura: ninguna mutación existe', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      assert.equal((await llamar('/pesajes', { method, rol: 'owner' })).status, 404, method);
    }
    assert.equal(llamadas.length, 0);
  });

  test('cursor inválido: 400 determinista con el repositorio real, sin tocar la base', async () => {
    const malos = [
      'x', '%00', encodeURIComponent('{"v":1}'), 'a'.repeat(501),
      encodeCursor(INSTANTE),
      encodeCursorReproduccion({ c: INSTANTE }),
      encodeCursorPesajes(ORG_B, { c: INSTANTE }),
      encodeCursorPesajes(ORG_A, { c: 'no-es-fecha' }),
    ];
    for (const cursor of malos) {
      const res = await llamar(`/pesajes?cursor=${cursor}`, { repo: { pullPesajes } });
      assert.equal(res.status, 400, cursor);
      assert.deepEqual(res.json, { error: 'INVALID_CURSOR', message: 'Cursor de sincronización inválido.' });
      assert.equal(res.cache, 'no-store');
    }
  });

  test('cursor repetido en la query (array): 400 seguro', async () => {
    const res = await llamar('/pesajes?cursor=a&cursor=b', { repo: { pullPesajes } });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, 'INVALID_CURSOR');
  });

  test('un error interno no expone SQL ni detalles', async () => {
    respuesta = new Error('select secreto from agx.animal_pesajes');
    const res = await llamar('/pesajes');
    assert.equal(res.status, 500);
    assert.equal(res.text.includes('secreto'), false);
    assert.equal(res.text.includes('animal_pesajes'), false);
    assert.equal(res.cache, 'no-store');
  });
});

describe('cursor de pesajes', () => {
  const ENTRE = { c: INSTANTE };
  const DENTRO = { c: INSTANTE, d: '2026-10-20T14:55:00.123000Z', m: '2026-10-20T14:56:00.000001Z', i: '42', f: 1 };

  test('ida y vuelta conserva microsegundos, id y completitud', () => {
    assert.deepEqual(decodeCursorPesajes(encodeCursorPesajes(ORG_A, ENTRE), ORG_A), { c: INSTANTE, f: false });
    assert.deepEqual(decodeCursorPesajes(encodeCursorPesajes(ORG_A, DENTRO), ORG_A), DENTRO.f === 1 ? { ...DENTRO, f: true } : DENTRO);
    assert.equal(decodeCursorPesajes(encodeCursorPesajes(ORG_A, { ...DENTRO, f: 0 }), ORG_A).f, false);
  });

  test('ausente o vacío: recorrido completo', () => {
    assert.equal(decodeCursorPesajes(undefined, ORG_A), null);
    assert.equal(decodeCursorPesajes('', ORG_A), null);
  });

  test('ligado a la organización de la sesión', () => {
    assert.throws(() => decodeCursorPesajes(encodeCursorPesajes(ORG_A, DENTRO), ORG_B), { code: 'INVALID_CURSOR', status: 400 });
    assert.throws(() => decodeCursorPesajes(encodeCursorPesajes(ORG_A, ENTRE), null), { code: 'INVALID_CURSOR' });
  });

  test('no comparte cursor con /sync/pull ni /sync/reproduccion, en ningún sentido', () => {
    assert.throws(() => decodeCursorPesajes(encodeCursor(INSTANTE), ORG_A), { code: 'INVALID_CURSOR' });
    assert.throws(() => decodeCursorPesajes(encodeCursorReproduccion(ENTRE), ORG_A), { code: 'INVALID_CURSOR' });
    assert.throws(() => decodeCursor(encodeCursorPesajes(ORG_A, ENTRE)), { code: 'INVALID_CURSOR' });
    assert.throws(() => decodeCursorReproduccion(encodeCursorPesajes(ORG_A, ENTRE)), { code: 'INVALID_CURSOR' });
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
    ['cota sin microsegundos', { ...DENTRO, d: '2026-10-20T14:55:00.123Z' }],
    ['marca anterior a la cota', { ...DENTRO, m: '2026-10-20T14:50:00.000000Z' }],
    ['completitud no binaria', { ...DENTRO, f: true }],
    ['campo extra entre recorridos', { ...ENTRE, x: 1 }],
    ['campo extra dentro', { ...DENTRO, limite: 5000 }],
  ]) {
    test(`rechaza: ${nombre}`, () => {
      assert.throws(() => decodeCursorPesajes(encodeCursorPesajes(ORG_A, contenido), ORG_A), { code: 'INVALID_CURSOR', status: 400 });
    });
  }

  test('rechaza otra versión, otro ámbito, organización mal formada o JSON no objeto', () => {
    const crudo = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');
    for (const contenido of [
      { v: 2, s: 'pesajes', o: ORG_A, c: INSTANTE },
      { v: 1, s: 'repro', o: ORG_A, c: INSTANTE },
      { v: 1, s: 'pesajes', o: 'no-uuid', c: INSTANTE },
      { v: 1, s: 'pesajes', c: INSTANTE },
      null, [1], 'texto',
    ]) {
      assert.throws(() => decodeCursorPesajes(crudo(contenido), ORG_A), { code: 'INVALID_CURSOR' }, JSON.stringify(contenido));
    }
  });
});

describe('fila de sync', () => {
  test('pesaje público + evidencia de conciliación; nunca actor ni anulado_por', () => {
    const fila = serializePesajeSync({
      pesaje_id: '7', animal_id: '3', organizacion_id: ORG_A, fecha: '2026-10-20', peso_kg: '205.5', metodo: 'BASCULA', origen: 'MANUAL',
      observaciones: null, created_at: INSTANTE, estado_registro: 'ANULADO', motivo_anulacion: 'Error', anulado_at: INSTANTE,
      client_operation_id: 'op-c', anulacion_client_operation_id: 'op-a', anulado_por: 'actor-x', actor_cuenta_id: 'actor-y',
    });
    assert.deepEqual(fila, {
      pesajeId: '7', fecha: '2026-10-20', pesoKg: 205.5, metodo: 'BASCULA', origen: 'MANUAL', observaciones: null, createdAt: INSTANTE,
      estadoRegistro: 'ANULADO', anulacion: { anuladoEn: INSTANTE, motivo: 'Error' },
      animalId: '3', organizacionId: ORG_A, clientOperationId: 'op-c', anulacionClientOperationId: 'op-a',
    });
    assert.equal(JSON.stringify(fila).includes('actor-'), false);
  });

  test('ACTIVO: anulacion null y anulacionClientOperationId null; REGISTRO_INICIAL sin clientOperationId -> null', () => {
    const fila = serializePesajeSync({
      pesaje_id: '8', animal_id: '3', organizacion_id: ORG_A, fecha: '2026-10-20', peso_kg: '200', metodo: 'ESTIMADO', origen: 'REGISTRO_INICIAL',
      observaciones: null, created_at: INSTANTE, estado_registro: 'ACTIVO', motivo_anulacion: null, anulado_at: null,
      client_operation_id: null, anulacion_client_operation_id: null,
    });
    assert.equal(fila.anulacion, null);
    assert.equal(fila.clientOperationId, null);
    assert.equal(fila.anulacionClientOperationId, null);
  });
});
