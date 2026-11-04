// FASE 4E.1 -- motor offline REAL contra rutas Express REALES y Postgres REAL (agx_app,
// RLS FORCE): creación, respuesta incierta, conciliación, aislamiento, conflicto,
// identidad y orden causal. Solo se simula la sesión: el plano de identidad no forma
// parte de esta base. Mismas variables que reproduccionIntegration; se auto-omite si
// faltan o si 0026 no está aplicada.
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
import { ORG_STORES } from '../../../src/modules/ganaderia/offline/offlineSchema.js';
import { createMemoryStorage } from '../../../src/modules/ganaderia/offline/storage.js';
import { createLocalRepo } from '../../../src/modules/ganaderia/offline/localRepo.js';
import { createSyncEngine } from '../../../src/modules/ganaderia/offline/syncEngine.js';
import { OUTBOX_ESTADOS } from '../../../src/modules/ganaderia/offline/outbox.js';

const CSRF = 'gwslZ1bKInXjQ0TLmMqWeV6vRAL2hONB6bTBqpAjVFs=';
const ORIGEN = 'https://agrogenomax.com';
const SESSION_PATH = '/api/ganaderia/auth/session';
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

// Sesiones simuladas: token -> { cuentaId, organizacionId }.
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

async function sembrar(org) {
  const { rows: [p] } = await adminPool.query(`insert into agx.predios (organizacion_id, nombre_predio, estado) values ($1, 'Predio motor 4E', 'ACTIVO') returning predio_id`, [org]);
  const { rows: [a] } = await adminPool.query(
    `insert into agx.animales (organizacion_id, predio_id, sexo, client_operation_id, creation_intent_hash, numero_visual, nacimiento_tipo, raza_tipo)
     values ($1, $2, 'HEMBRA', gen_random_uuid(), 'v1:' || repeat('a', 64), $3, 'DESCONOCIDA', 'DESCONOCIDA') returning animal_id::text as animal_id`,
    [org, p.predio_id, `M-${op().slice(0, 8)}`],
  );
  return a.animal_id;
}

const filas = async (animalId) => (await adminPool.query(
  `select client_operation_id::text as coid, to_char(fecha_evento, 'YYYY-MM-DD') as fecha, registrado_por::text as autor from agx.reproduccion_eventos where animal_id = $1 order by evento_id`,
  [animalId],
)).rows;

/** Un dispositivo: repositorio y motor reales; el transporte habla HTTP con el servidor real. */
function dispositivo(org, cuenta, animalId) {
  const repo = createLocalRepo(createMemoryStorage(ORG_STORES), { organizacionId: org, deviceId: 'd' });
  const estado = {
    sesion: nuevaSesion(cuenta, org),
    verificada: null, // la sesión que responde /auth/session si difiere de la de la cookie
    alEnviar: null, // (ruta, cuerpo, enviar) => resultado: permite perder o sustituir la respuesta
    posts: [],
  };
  const peticion = async (ruta, opciones = {}) => {
    const res = await fetch(`${baseUrl}${ruta}`, {
      ...opciones,
      headers: {
        Origin: ORIGEN,
        Cookie: `${sessionCookieName('development')}=${estado.sesion.token}`,
        'X-CSRF-Token': computeCsrfToken(estado.sesion.token, CSRF),
        ...(opciones.body ? { 'Content-Type': 'application/json' } : {}),
      },
    });
    const data = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, data };
  };
  const transport = {
    async getJson(ruta) {
      if (ruta === SESSION_PATH) {
        const s = estado.verificada ?? estado.sesion;
        return { ok: true, status: 200, data: { authenticated: true, cuenta: { cuentaId: s.cuentaId }, organizacionActiva: { organizacionId: s.organizacionId } } };
      }
      return peticion(ruta);
    },
    async postJson(ruta, cuerpo) {
      estado.posts.push({ ruta, cuerpo });
      const enviar = () => peticion(ruta, { method: 'POST', body: JSON.stringify(cuerpo) });
      return estado.alEnviar ? estado.alEnviar(enviar, cuerpo) : enviar();
    },
  };
  const motor = createSyncEngine({ repo, transport, random: () => 0.5 });
  const registrar = (fechaEvento, confirmarAdvertencia = true) => repo.registrarEventoReproductivoLocal({
    animalId, cuentaId: cuenta, confirmarAdvertencia,
    body: { clientOperationId: op(), tipoEvento: 'CELO_OBSERVADO', fechaEvento },
  });
  const preparar = async () => {
    await repo.storage.put('animales', { key: `srv:${animalId}`, animalId, sexo: 'HEMBRA', estado: 'ACTIVO', estadoOperativo: 'EN_HATO' });
    await repo.putMeta({ reproduccionListaAt: new Date().toISOString() });
  };
  return { repo, motor, estado, registrar, preparar };
}

async function escenario() {
  const org = crypto.randomUUID();
  const cuenta = crypto.randomUUID();
  const animalId = await sembrar(org);
  const d = dispositivo(org, cuenta, animalId);
  await d.preparar();
  return { org, cuenta, animalId, d };
}

describe('motor offline contra rutas y Postgres reales', { skip: !dbAvailable }, () => {
  test('creación offline: exactamente 1 evento, con el autor de la sesión', async () => {
    const { cuenta, animalId, d } = await escenario();
    await d.registrar('2026-01-05');
    assert.deepEqual(await filas(animalId), [], 'nada sale sin sincronizar');
    await d.motor.syncNow();
    const [fila, ...resto] = await filas(animalId);
    assert.deepEqual(resto, []);
    assert.equal(fila.autor, cuenta);
    assert.deepEqual(await d.repo.listOutbox(), []);
    assert.equal(d.estado.posts.length, 1);
    assert.equal((await d.repo.listEventosReproductivos(animalId)).length, 1);
    await d.motor.syncNow({ forzar: true });
    assert.equal(d.estado.posts.length, 1, 'no hay un segundo envío');
    assert.equal((await filas(animalId)).length, 1);
  });

  test('retry incierto: el POST guardó, se perdió la respuesta; mismo id y 1 solo evento', async () => {
    const { animalId, d } = await escenario();
    const { operationId } = await d.registrar('2026-01-05');
    const antes = await d.repo.getOperacion(operationId);
    d.estado.alEnviar = async (enviar) => {
      d.estado.alEnviar = null;
      await enviar();
      throw new TypeError('Failed to fetch');
    };
    await d.motor.syncNow();
    const incierta = await d.repo.getOperacion(operationId);
    assert.equal(incierta.estado, OUTBOX_ESTADOS.ERROR_REINTENTABLE);
    assert.equal(incierta.posibleEnServidor, true);
    assert.equal(incierta.clientOperationId, antes.clientOperationId);
    assert.equal((await filas(animalId)).length, 1);

    await d.motor.syncNow({ forzar: true });
    assert.deepEqual(d.estado.posts.map((p) => p.cuerpo.clientOperationId), [antes.clientOperationId, antes.clientOperationId]);
    assert.equal((await filas(animalId)).length, 1, 'el reintento no duplica');
    assert.deepEqual(await d.repo.listOutbox(), []);
  });

  test('conciliación por pull: 503 tras guardar y en backoff, el pull la cierra sin otro POST', async () => {
    const { animalId, d } = await escenario();
    await d.registrar('2026-01-05');
    d.estado.alEnviar = async (enviar) => {
      d.estado.alEnviar = null;
      await enviar();
      return { ok: false, status: 503, data: {} };
    };
    await d.motor.syncNow();
    const [incierta] = await d.repo.listOutbox();
    assert.equal(incierta.estado, OUTBOX_ESTADOS.ERROR_REINTENTABLE);
    await d.motor.syncNow();
    assert.equal(d.estado.posts.length, 1, 'el backoff sigue vigente');
    assert.deepEqual(await d.repo.listOutbox(), []);
    assert.equal((await filas(animalId)).length, 1);
    assert.equal((await d.repo.listEventosReproductivos(animalId))[0].clientOperationId, incierta.clientOperationId);
  });

  test('aislamiento: una operación contra un animal ajeno no escribe nada y se conserva', async () => {
    const victima = await escenario();
    const orgB = crypto.randomUUID();
    const d = dispositivo(orgB, crypto.randomUUID(), victima.animalId);
    await d.preparar();
    await d.registrar('2026-01-05');
    await d.motor.syncNow();
    assert.deepEqual(await filas(victima.animalId), []);
    const [conservada] = await d.repo.listOutbox();
    assert.equal(conservada.estado, OUTBOX_ESTADOS.CONFLICTO);
    assert.equal(conservada.ultimoError.codigo, 'ANIMAL_NOT_FOUND');
    assert.deepEqual(await d.repo.listEventosReproductivos(victima.animalId), [], 'el pull de B no trae nada de A');
  });

  test('conflicto seguro: mismo id con otra intención en el servidor, sin sobrescribir ninguno', async () => {
    const { animalId, d } = await escenario();
    const { operationId } = await d.registrar('2026-01-05');
    const op1 = await d.repo.getOperacion(operationId);
    await d.motor.syncNow({ soloPush: true });
    assert.equal((await filas(animalId)).length, 1);

    const otra = dispositivo(d.estado.sesion.organizacionId, d.estado.sesion.cuentaId, animalId);
    await otra.preparar();
    const { operationId: id2 } = await otra.repo.registrarEventoReproductivoLocal({
      animalId, cuentaId: d.estado.sesion.cuentaId, confirmarAdvertencia: true,
      body: { clientOperationId: op1.clientOperationId, tipoEvento: 'CELO_OBSERVADO', fechaEvento: '2026-01-06' },
    });
    await otra.motor.syncNow({ soloPush: true });
    const conflicto = await otra.repo.getOperacion(id2);
    assert.equal(conflicto.estado, OUTBOX_ESTADOS.CONFLICTO);
    assert.equal(conflicto.ultimoError.codigo, 'CLIENT_OPERATION_ID_REUSED');
    assert.equal(conflicto.payload.evento.fechaEvento, '2026-01-06');
    assert.deepEqual((await filas(animalId)).map((f) => f.fecha), ['2026-01-05']);
  });

  test('identidad: otra cuenta de la misma organización no envía; la original sí', async () => {
    const { org, cuenta, animalId, d } = await escenario();
    const { operationId } = await d.registrar('2026-01-05');
    const sesionA = d.estado.sesion;
    d.estado.sesion = nuevaSesion(crypto.randomUUID(), org);
    await d.motor.syncNow();
    assert.equal(d.estado.posts.length, 0);
    const bloqueada = await d.repo.getOperacion(operationId);
    assert.equal(bloqueada.estado, OUTBOX_ESTADOS.BLOQUEADA_POR_IDENTIDAD);
    assert.equal(bloqueada.origen.cuentaId, cuenta, 'no se reasigna');
    assert.deepEqual(await filas(animalId), []);

    d.estado.sesion = sesionA;
    await d.motor.syncNow();
    assert.deepEqual((await filas(animalId)).map((f) => f.autor), [cuenta]);
    assert.deepEqual(await d.repo.listOutbox(), []);
  });

  test('identidad: si la cookie cambia entre verificar y enviar, el servidor real responde 409 y no escribe', async () => {
    const { org, cuenta, animalId, d } = await escenario();
    const { operationId } = await d.registrar('2026-01-05');
    const sesionA = d.estado.sesion;
    d.estado.verificada = sesionA;
    d.estado.sesion = nuevaSesion(crypto.randomUUID(), org);
    await d.motor.syncNow({ soloPush: true });
    assert.equal(d.estado.posts.length, 1, 'la verificación local pasó');
    assert.deepEqual(await filas(animalId), [], 'el servidor no escribió');
    const bloqueada = await d.repo.getOperacion(operationId);
    assert.equal(bloqueada.estado, OUTBOX_ESTADOS.BLOQUEADA_POR_IDENTIDAD);
    assert.equal(bloqueada.ultimoError.codigo, 'IDENTIDAD_NO_COINCIDE');

    d.estado.verificada = null;
    d.estado.sesion = sesionA;
    await d.motor.syncNow();
    assert.deepEqual((await filas(animalId)).map((f) => f.autor), [cuenta]);
  });

  test('FIFO causal: la segunda no adelanta a la primera durante el backoff ni tras un conflicto', async () => {
    const { animalId, d } = await escenario();
    const primera = await d.registrar('2026-01-05');
    const segunda = await d.registrar('2026-01-06');
    d.estado.alEnviar = async () => ({ ok: false, status: 503, data: {} });
    await d.motor.syncNow();
    assert.equal(d.estado.posts.length, 1);
    await d.motor.syncNow();
    assert.equal(d.estado.posts.length, 1, 'la segunda no sale mientras dura el backoff de la primera');
    assert.deepEqual(await filas(animalId), []);
    d.estado.alEnviar = null;
    await d.motor.syncNow({ forzar: true });
    assert.deepEqual((await filas(animalId)).map((f) => f.fecha), ['2026-01-05', '2026-01-06'], 'en orden causal');
    assert.equal((await d.repo.getOperacion(primera.operationId)), undefined);
    assert.equal((await d.repo.getOperacion(segunda.operationId)), undefined);

    // Un evento posterior creado por otro dispositivo deja en conflicto a la siguiente.
    const tercera = await d.registrar('2026-01-07');
    const cuarta = await d.registrar('2026-01-08');
    await adminPool.query(
      `insert into agx.reproduccion_eventos (organizacion_id, animal_id, tipo_evento, fecha_evento, registrado_por, client_operation_id, intent_hash)
       values ($1, $2, 'CELO_OBSERVADO', '2026-02-01', $3, gen_random_uuid(), 'v1:' || repeat('d', 64))`,
      [d.estado.sesion.organizacionId, animalId, d.estado.sesion.cuentaId],
    );
    const envios = d.estado.posts.length;
    await d.motor.syncNow({ soloPush: true });
    assert.equal(d.estado.posts.length, envios + 1, 'solo sale la primera de la cadena');
    assert.equal((await d.repo.getOperacion(tercera.operationId)).estado, OUTBOX_ESTADOS.CONFLICTO);
    assert.equal((await d.repo.getOperacion(cuarta.operationId)).estado, OUTBOX_ESTADOS.PENDIENTE);
    await d.motor.syncNow({ forzar: true, soloPush: true });
    assert.equal(d.estado.posts.length, envios + 1, 'sigue retenida al forzar');
  });
});
