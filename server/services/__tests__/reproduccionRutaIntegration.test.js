// FASE 4E.1A -- contrato de compatibilidad con rutas Express REALES y Postgres REAL
// (agx_app, RLS FORCE): identidadEsperada es opcional en POST /eventos y GET
// /sync/reproduccion responde con sesión. Solo se simula la sesión: el plano de
// identidad no forma parte de esta base. Mismas variables que reproduccionIntegration;
// se auto-omite si faltan o si 0026 no está aplicada.
delete process.env.AGX_BUSINESS_DATABASE_URL;
delete process.env.AGX_BUSINESS_QR_ADMIN_DATABASE_URL;

import { test, describe, after, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import express from 'express';
import pg from 'pg';
import { computeCsrfToken, hashSessionSecret, sessionCookieName } from '../../security/ganaderiaSession.js';
import { getAgxAuthPool, __resetAgxAuthPoolForTests } from '../../db/agxAuthPool.js';
import { errorHandler, notFound } from '../../middleware/errors.js';

const CSRF = 'gwslZ1bKInXjQ0TLmMqWeV6vRAL2hONB6bTBqpAjVFs=';
const ORIGEN = 'https://agrogenomax.com';
const op = () => crypto.randomUUID();

let dbAvailable = false;
let adminPool;
let businessDb;
let qrAdminDb;
let crearRutaReproduccion;
let crearRutaSync;

try {
  const app = process.env.AGX_BUSINESS_DATABASE_URL_TEST;
  const admin = process.env.AGX_BUSINESS_INTEGRATION_ADMIN_DATABASE_URL;
  const qrAdmin = process.env.AGX_BUSINESS_QR_ADMIN_DATABASE_URL_TEST;
  if (!app || !admin || !qrAdmin) throw new Error('conexiones de prueba no configuradas');
  process.env.AGX_BUSINESS_DATABASE_URL = app;
  process.env.AGX_BUSINESS_QR_ADMIN_DATABASE_URL = qrAdmin;
  process.env.AGX_QR_TOKEN_ENCRYPTION_KEY = process.env.AGX_QR_TOKEN_ENCRYPTION_KEY_TEST || crypto.randomBytes(32).toString('base64');
  const { getConfig } = await import('../../config/env.js');
  getConfig({ APP_ENV: 'development' }, {});
  adminPool = new pg.Pool({ connectionString: admin, max: 2 });
  dbAvailable = (await adminPool.query(`select to_regclass('agx.reproduccion_eventos') is not null as ok`)).rows[0].ok === true;
} catch {
  dbAvailable = false;
}

if (dbAvailable) {
  businessDb = await import('../../db/agxBusinessPool.js');
  qrAdminDb = await import('../../db/agxQrAdminPool.js');
  crearRutaReproduccion = (await import('../../routes/ganaderiaAnimalReproduccion.js')).default;
  crearRutaSync = (await import('../../routes/ganaderiaSync.js')).default;
}

const sesiones = new Map();
let servidor;
let baseUrl;

function nuevaSesion(cuentaId, organizacionId) {
  const token = crypto.randomBytes(32).toString('base64url');
  sesiones.set(hashSessionSecret(token), { cuentaId, organizacionId });
  return { token, cuentaId, organizacionId };
}

before(async () => {
  if (!dbAvailable) return;
  __resetAgxAuthPoolForTests();
  const auth = getAgxAuthPool({ AGX_AUTH_DATABASE_URL: 'postgres://test:test@192.0.2.1:5432/never_connects' });
  auth.query = async (text, params = []) => {
    const s = sesiones.get(params[0]);
    if (!s) return { rows: [] };
    if (text.includes('from agx.sesiones s')) {
      return { rows: [{ sesion_id: 's', cuenta_id: s.cuentaId, organizacion_id: s.organizacionId, fecha_expiracion: new Date(Date.now() + 60_000).toISOString(), fecha_revocacion: null, cuenta_estado: 'activa', email: 'qa@example.test', nombre: 'QA' }] };
    }
    if (text.includes('fn_resolver_autorizacion_sesion')) {
      return { rows: [{ sesion_id: 's', cuenta_id: s.cuentaId, organizacion_id: s.organizacionId, rol: 'owner' }] };
    }
    return { rows: [] };
  };
  const app = express();
  app.use(express.json());
  const config = { appEnv: 'development', csrfServerSecret: CSRF, allowedOrigins: [ORIGEN] };
  app.use('/api/ganaderia/animales/:animalId/reproduccion', crearRutaReproduccion(config));
  app.use('/api/ganaderia/sync', crearRutaSync(config));
  app.use(notFound);
  app.use(errorHandler);
  await new Promise((resolve) => { servidor = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${servidor.address().port}`;
});

after(async () => {
  await new Promise((resolve) => (servidor ? servidor.close(resolve) : resolve()));
  await adminPool?.end().catch(() => {});
  businessDb?.closeAgxBusinessPool?.();
  await qrAdminDb?.closeAgxQrAdminPool?.();
  __resetAgxAuthPoolForTests();
});

async function peticion(ruta, sesion, { method = 'GET', body } = {}) {
  const res = await fetch(`${baseUrl}${ruta}`, {
    method,
    headers: {
      Origin: ORIGEN,
      ...(sesion ? { Cookie: `${sessionCookieName('development')}=${sesion.token}`, 'X-CSRF-Token': computeCsrfToken(sesion.token, CSRF) } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, cache: res.headers.get('cache-control'), data: await res.json().catch(() => null) };
}

async function escenario() {
  const org = crypto.randomUUID();
  const cuenta = crypto.randomUUID();
  const { rows: [p] } = await adminPool.query(`insert into agx.predios (organizacion_id, nombre_predio, estado) values ($1, 'Predio ruta 4E', 'ACTIVO') returning predio_id`, [org]);
  const { rows: [a] } = await adminPool.query(
    `insert into agx.animales (organizacion_id, predio_id, sexo, client_operation_id, creation_intent_hash, numero_visual, nacimiento_tipo, raza_tipo)
     values ($1, $2, 'HEMBRA', gen_random_uuid(), 'v1:' || repeat('a', 64), $3, 'DESCONOCIDA', 'DESCONOCIDA') returning animal_id::text as animal_id`,
    [org, p.predio_id, `R-${op().slice(0, 8)}`],
  );
  return { org, cuenta, animalId: a.animal_id, sesion: nuevaSesion(cuenta, org), ruta: `/api/ganaderia/animales/${a.animal_id}/reproduccion/eventos` };
}

const filas = async (animalId) => (await adminPool.query(
  `select client_operation_id::text as coid, registrado_por::text as autor, organizacion_id::text as org from agx.reproduccion_eventos where animal_id = $1 order by evento_id`,
  [animalId],
)).rows;

const evento = (cambios = {}) => ({ tipoEvento: 'CELO_OBSERVADO', fechaEvento: '2026-01-05', clientOperationId: op(), ...cambios });

describe('compatibilidad 4E.1A: rutas y Postgres reales', { skip: !dbAvailable }, () => {
  test('cliente actual, sin identidadEsperada: 201, y el reintento 200 yaExistia', async () => {
    const { animalId, cuenta, sesion, ruta } = await escenario();
    const cuerpo = evento();
    const primero = await peticion(ruta, sesion, { method: 'POST', body: cuerpo });
    assert.equal(primero.status, 201);
    assert.equal(primero.data.yaExistia, false);
    const reintento = await peticion(ruta, sesion, { method: 'POST', body: cuerpo });
    assert.equal(reintento.status, 200);
    assert.equal(reintento.data.yaExistia, true);
    assert.deepEqual((await filas(animalId)).map((f) => f.autor), [cuenta]);
  });

  test('identidad correcta: 201, reintento 200, y es la misma operación que sin el campo', async () => {
    const { org, animalId, cuenta, sesion, ruta } = await escenario();
    const identidadEsperada = { cuentaId: cuenta, organizacionId: org };
    const cuerpo = evento();
    assert.equal((await peticion(ruta, sesion, { method: 'POST', body: { ...cuerpo, identidadEsperada } })).status, 201);
    const conCampo = await peticion(ruta, sesion, { method: 'POST', body: { ...cuerpo, identidadEsperada } });
    assert.equal(conCampo.status, 200);
    assert.equal(conCampo.data.yaExistia, true);
    const sinCampo = await peticion(ruta, sesion, { method: 'POST', body: cuerpo });
    assert.equal(sinCampo.status, 200, 'identidadEsperada no entra en el intent_hash');
    assert.equal(sinCampo.data.yaExistia, true);
    assert.deepEqual((await filas(animalId)).map((f) => f.autor), [cuenta]);
  });

  for (const [nombre, identidad] of [
    ['otra cuenta de la misma organización', ({ org }) => ({ cuentaId: op(), organizacionId: org })],
    ['otra organización', ({ cuenta }) => ({ cuentaId: cuenta, organizacionId: op() })],
  ]) {
    test(`identidad incorrecta (${nombre}): 409 sin escritura`, async () => {
      const e = await escenario();
      const res = await peticion(e.ruta, e.sesion, { method: 'POST', body: evento({ identidadEsperada: identidad(e) }) });
      assert.equal(res.status, 409);
      assert.equal(res.data.error, 'IDENTIDAD_NO_COINCIDE');
      assert.deepEqual(await filas(e.animalId), []);
    });
  }

  test('identidadEsperada nunca es fuente del tenant ni del actor', async () => {
    const { org, animalId, cuenta, sesion, ruta } = await escenario();
    await peticion(ruta, sesion, { method: 'POST', body: evento({ identidadEsperada: { cuentaId: cuenta, organizacionId: org } }) });
    const [fila] = await filas(animalId);
    assert.equal(fila.autor, cuenta);
    assert.equal(fila.org, org);
    const ajena = nuevaSesion(op(), op());
    const res = await peticion(ruta, ajena, { method: 'POST', body: evento({ fechaEvento: '2026-01-06', identidadEsperada: { cuentaId: cuenta, organizacionId: org } }) });
    assert.equal(res.status, 409, 'declarar la identidad de otro no da acceso');
    assert.equal((await filas(animalId)).length, 1);
  });

  test('GET /sync/reproduccion: 200 autenticado, no-store, con cuenta y organización de la sesión', async () => {
    const { org, cuenta, sesion, ruta } = await escenario();
    await peticion(ruta, sesion, { method: 'POST', body: evento() });
    const res = await peticion('/api/ganaderia/sync/reproduccion', sesion);
    assert.equal(res.status, 200);
    assert.equal(res.cache, 'no-store');
    assert.equal(res.data.organizacionId, org);
    assert.equal(res.data.cuentaId, cuenta);
    assert.equal(res.data.eventos.length, 1);
    assert.deepEqual(res.data.totales, { eventos: 1, anulados: 0 });
    assert.equal(res.data.hayMas, false);
  });

  test('GET /sync/reproduccion sin sesión: 401', async () => {
    const res = await peticion('/api/ganaderia/sync/reproduccion', null);
    assert.equal(res.status, 401);
  });

  test('GET /sync/reproduccion con el cursor devuelto: sigue con el mismo contrato', async () => {
    const { sesion, ruta } = await escenario();
    await peticion(ruta, sesion, { method: 'POST', body: evento() });
    const primero = await peticion('/api/ganaderia/sync/reproduccion', sesion);
    const res = await peticion(`/api/ganaderia/sync/reproduccion?cursor=${encodeURIComponent(primero.data.cursor)}`, sesion);
    assert.equal(res.status, 200);
    assert.equal(res.data.completo, false);
    assert.equal(res.data.eventos.length, 1, 'el evento reciente vuelve por el solape');
    const invalido = await peticion('/api/ganaderia/sync/reproduccion?cursor=x', sesion);
    assert.equal(invalido.status, 400);
    assert.equal(invalido.data.error, 'INVALID_CURSOR');
  });

  test('aislamiento: otra organización no ve el evento ni el animal en el pull', async () => {
    const a = await escenario();
    const b = await escenario();
    await peticion(a.ruta, a.sesion, { method: 'POST', body: evento() });
    const res = await peticion('/api/ganaderia/sync/reproduccion', b.sesion);
    assert.equal(res.status, 200);
    assert.deepEqual(res.data.eventos, []);
    assert.deepEqual(res.data.totales, { eventos: 0, anulados: 0 });
    const cruzado = await peticion(a.ruta, b.sesion, { method: 'POST', body: evento() });
    assert.equal(cruzado.status, 404);
    assert.equal(cruzado.data.error, 'ANIMAL_NOT_FOUND');
    assert.equal((await filas(a.animalId)).length, 1);
  });

  test('anulación posterior: vuelve a entrar por el cursor con su trazabilidad', async () => {
    const { sesion, ruta } = await escenario();
    const { data } = await peticion(ruta, sesion, { method: 'POST', body: evento() });
    const cursor = (await peticion('/api/ganaderia/sync/reproduccion', sesion)).data.cursor;
    const anulada = await peticion(`${ruta}/${data.evento.eventoId}/anular`, sesion, { method: 'POST', body: { clientOperationId: op(), motivo: 'Error de digitación' } });
    assert.equal(anulada.status, 200);
    const res = await peticion(`/api/ganaderia/sync/reproduccion?cursor=${encodeURIComponent(cursor)}`, sesion);
    const fila = res.data.eventos.find((e) => e.eventoId === data.evento.eventoId);
    assert.equal(fila.estadoRegistro, 'ANULADO');
    assert.equal(fila.anulacion.motivo, 'Error de digitación');
    assert.deepEqual(res.data.totales, { eventos: 1, anulados: 1 });
  });
});
