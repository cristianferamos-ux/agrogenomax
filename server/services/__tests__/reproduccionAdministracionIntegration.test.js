// FASE 4E.2A -- contrato backend de anular y corregir para el futuro outbox, con rutas
// Express REALES y Postgres REAL (agx_app, RLS FORCE): identidadEsperada, ids cruzados
// entre tipos, atomicidad, autoría y anulacionClientOperationId en el pull. Solo se
// simula la sesión: el plano de identidad no forma parte de esta base. Se auto-omite
// si faltan las variables o 0026 (el runner de integración convierte la omisión en fallo).
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

function nuevaSesion(cuentaId, organizacionId, rol = 'owner') {
  const token = crypto.randomBytes(32).toString('base64url');
  sesiones.set(hashSessionSecret(token), { cuentaId, organizacionId, rol });
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
      return { rows: [{ sesion_id: 's', cuenta_id: s.cuentaId, organizacion_id: s.organizacionId, rol: s.rol }] };
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

async function post(ruta, sesion, body) {
  const res = await fetch(`${baseUrl}${ruta}`, {
    method: 'POST',
    headers: {
      Origin: ORIGEN,
      Cookie: `${sessionCookieName('development')}=${sesion.token}`,
      'X-CSRF-Token': computeCsrfToken(sesion.token, CSRF),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

async function get(ruta, sesion) {
  const res = await fetch(`${baseUrl}${ruta}`, {
    headers: { Origin: ORIGEN, Cookie: `${sessionCookieName('development')}=${sesion.token}` },
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

async function escenario() {
  const org = crypto.randomUUID();
  const cuenta = crypto.randomUUID();
  const { rows: [p] } = await adminPool.query(`insert into agx.predios (organizacion_id, nombre_predio, estado) values ($1, 'Predio 4E.2A', 'ACTIVO') returning predio_id`, [org]);
  const nuevoAnimal = async (extra = {}) => {
    const { rows: [a] } = await adminPool.query(
      `insert into agx.animales (organizacion_id, predio_id, sexo, client_operation_id, creation_intent_hash, numero_visual, nacimiento_tipo, fecha_nacimiento, raza_tipo)
       values ($1, $2, 'HEMBRA', gen_random_uuid(), 'v1:' || repeat('a', 64), $3, $4, $5, 'DESCONOCIDA') returning animal_id::text as animal_id`,
      [org, p.predio_id, `R-${op().slice(0, 8)}`, extra.fechaNacimiento ? 'EXACTA' : 'DESCONOCIDA', extra.fechaNacimiento ?? null],
    );
    return a.animal_id;
  };
  const animalId = await nuevoAnimal();
  const sesion = nuevaSesion(cuenta, org);
  const ctx = {
    org,
    cuenta,
    animalId,
    nuevoAnimal,
    sesion,
    identidad: { cuentaId: cuenta, organizacionId: org },
    ruta: (a = animalId) => `/api/ganaderia/animales/${a}/reproduccion/eventos`,
  };
  ctx.crear = (cambios = {}, a = animalId, s = sesion) => post(ctx.ruta(a), s, { ...CELO, clientOperationId: op(), ...cambios });
  ctx.anular = (eventoId, cambios = {}, a = animalId, s = sesion) => post(`${ctx.ruta(a)}/${eventoId}/anular`, s, { motivo: 'Error de digitación', clientOperationId: op(), ...cambios });
  ctx.corregir = (eventoId, cambios = {}, a = animalId, s = sesion) => post(`${ctx.ruta(a)}/${eventoId}/corregir`, s, { motivo: 'Dato erróneo', clientOperationId: op(), evento: IA, ...cambios });
  ctx.evento = async (cambios = {}) => (await ctx.crear(cambios)).data.evento.eventoId;
  return ctx;
}

const CELO = Object.freeze({ tipoEvento: 'CELO_OBSERVADO', fechaEvento: '2026-01-05' });
const IA = Object.freeze({ tipoEvento: 'INSEMINACION_ARTIFICIAL', fechaEvento: '2026-01-06', toroExterno: 'Gyr X' });

const filas = async (animalId) => (await adminPool.query(
  `select evento_id::text as id, estado_registro as estado, corrige_evento_id::text as corrige,
          client_operation_id::text as coid, anulacion_client_operation_id::text as acoid,
          registrado_por::text as autor, anulado_por::text as anulador, motivo_anulacion as motivo,
          organizacion_id::text as org
     from agx.reproduccion_eventos where animal_id = $1 order by evento_id`,
  [animalId],
)).rows;

function esReused(res) {
  assert.equal(res.status, 409, JSON.stringify(res.data));
  assert.equal(res.data.error, 'CLIENT_OPERATION_ID_REUSED');
}

describe('FASE 4E.2A: anular y corregir (rutas y Postgres reales)', { skip: !dbAvailable }, () => {
  describe('RLS', () => {
    test('la tabla sigue con RLS ENABLE + FORCE y la conexión de la app es agx_app', async () => {
      const { rows: [t] } = await adminPool.query(
        `select c.relrowsecurity as r, c.relforcerowsecurity as f from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'agx' and c.relname = 'reproduccion_eventos'`,
      );
      assert.deepEqual(t, { r: true, f: true });
      const usuario = await businessDb.withOrganizacionTransaction(op(), async (client) => (await client.query('select current_user as u')).rows[0].u);
      assert.equal(usuario, 'agx_app');
    });
  });

  describe('ANULAR', () => {
    test('cliente viejo sin el campo: 200, ANULADO, sin DELETE, con la autoría de la sesión', async () => {
      const e = await escenario();
      const eventoId = await e.evento();
      const res = await e.anular(eventoId);
      assert.equal(res.status, 200);
      assert.equal(res.data.yaExistia, false);
      assert.equal(res.data.evento.estadoRegistro, 'ANULADO');
      assert.deepEqual(Object.keys(res.data).sort(), ['estado', 'evento', 'ok', 'yaExistia']);
      const [fila, ...resto] = await filas(e.animalId);
      assert.deepEqual(resto, []);
      assert.equal(fila.estado, 'ANULADO');
      assert.equal(fila.anulador, e.cuenta);
    });

    test('identidad correcta: 200 con la misma autoría; el reintento con o sin el campo es idempotente', async () => {
      const e = await escenario();
      const eventoId = await e.evento();
      const cuerpo = { clientOperationId: op() };
      const primero = await e.anular(eventoId, { ...cuerpo, identidadEsperada: e.identidad });
      assert.equal(primero.status, 200);
      assert.equal(primero.data.yaExistia, false);
      for (const extra of [{ identidadEsperada: e.identidad }, {}]) {
        const reintento = await e.anular(eventoId, { ...cuerpo, ...extra });
        assert.equal(reintento.status, 200);
        assert.equal(reintento.data.yaExistia, true);
      }
      const [fila] = await filas(e.animalId);
      assert.equal(fila.acoid, cuerpo.clientOperationId);
      assert.equal(fila.anulador, e.cuenta);
    });

    for (const [nombre, identidad] of [
      ['otra cuenta de la misma organización', (e) => ({ cuentaId: op(), organizacionId: e.org })],
      ['otra organización', (e) => ({ cuentaId: e.cuenta, organizacionId: op() })],
    ]) {
      test(`identidad incorrecta (${nombre}): 409 y cero escrituras`, async () => {
        const e = await escenario();
        const eventoId = await e.evento();
        const antes = await filas(e.animalId);
        const res = await e.anular(eventoId, { identidadEsperada: identidad(e) });
        assert.equal(res.status, 409);
        assert.equal(res.data.error, 'IDENTIDAD_NO_COINCIDE');
        assert.deepEqual(await filas(e.animalId), antes);
      });
    }

    test('otra cuenta con la identidad del autor original: 409 aunque la operación ya exista', async () => {
      const e = await escenario();
      const eventoId = await e.evento();
      const clientOperationId = op();
      await e.anular(eventoId, { clientOperationId, identidadEsperada: e.identidad });
      const otra = nuevaSesion(op(), e.org);
      const res = await e.anular(eventoId, { clientOperationId, identidadEsperada: e.identidad }, e.animalId, otra);
      assert.equal(res.status, 409);
      assert.equal(res.data.error, 'IDENTIDAD_NO_COINCIDE');
      assert.equal((await filas(e.animalId))[0].anulador, e.cuenta);
    });

    test('rol operador: 403 y cero escrituras', async () => {
      const e = await escenario();
      const eventoId = await e.evento();
      const res = await e.anular(eventoId, { identidadEsperada: e.identidad }, e.animalId, nuevaSesion(e.cuenta, e.org, 'operador'));
      assert.equal(res.status, 403);
      assert.equal(res.data.error, 'ROLE_FORBIDDEN');
      assert.equal((await filas(e.animalId))[0].estado, 'ACTIVO');
    });

    test('aislamiento: otra organización recibe 404 aunque declare su propia identidad', async () => {
      const a = await escenario();
      const b = await escenario();
      const eventoId = await a.evento();
      const res = await a.anular(eventoId, { identidadEsperada: b.identidad }, a.animalId, b.sesion);
      assert.equal(res.status, 404);
      assert.equal(res.data.error, 'ANIMAL_NOT_FOUND');
      assert.equal((await filas(a.animalId))[0].estado, 'ACTIVO');
    });

    test('semántica online conservada: animal SALIDO no es conflicto; otro id sobre ANULADO sí', async () => {
      const e = await escenario();
      const eventoId = await e.evento();
      await adminPool.query(`update agx.animales set estado_operativo = 'SALIDO', cierre_fecha = '2026-01-20', cierre_causa = 'VENTA', cierre_por = $2, cierre_at = now(), cierre_client_operation_id = gen_random_uuid() where animal_id = $1`, [e.animalId, e.cuenta]);
      assert.equal((await e.anular(eventoId)).status, 200);
      const otra = await e.anular(eventoId);
      assert.equal(otra.status, 409);
      assert.equal(otra.data.error, 'EVENTO_YA_ANULADO');
    });
  });

  describe('CORREGIR', () => {
    test('cliente viejo sin el campo: 201, original ANULADO + un corrector ACTIVO enlazado, autoría de la sesión', async () => {
      const e = await escenario();
      const eventoId = await e.evento();
      const clientOperationId = op();
      const res = await e.corregir(eventoId, { clientOperationId });
      assert.equal(res.status, 201);
      assert.equal(res.data.yaExistia, false);
      assert.deepEqual(Object.keys(res.data).sort(), ['estado', 'evento', 'eventoCorregido', 'ok', 'yaExistia']);
      assert.equal(res.data.eventoCorregido.estadoRegistro, 'ANULADO');
      const [original, corrector, ...resto] = await filas(e.animalId);
      assert.deepEqual(resto, []);
      assert.equal(original.estado, 'ANULADO');
      assert.equal(original.acoid, clientOperationId);
      assert.equal(original.anulador, e.cuenta);
      assert.equal(corrector.estado, 'ACTIVO');
      assert.equal(corrector.corrige, original.id);
      assert.equal(corrector.coid, clientOperationId);
      assert.equal(corrector.autor, e.cuenta);
    });

    test('vínculo interno: el reintento de la misma corrección usa el mismo id en sus dos filas y es 200 yaExistia', async () => {
      const e = await escenario();
      const eventoId = await e.evento();
      const cuerpo = { clientOperationId: op() };
      assert.equal((await e.corregir(eventoId, { ...cuerpo, identidadEsperada: e.identidad })).status, 201);
      const antes = await filas(e.animalId);
      for (const extra of [{ identidadEsperada: e.identidad }, {}]) {
        const reintento = await e.corregir(eventoId, { ...cuerpo, ...extra });
        assert.equal(reintento.status, 200);
        assert.equal(reintento.data.yaExistia, true);
        assert.equal(reintento.data.evento.corrigeEventoId, eventoId);
      }
      assert.deepEqual(await filas(e.animalId), antes);
    });

    test('reintento de la corrección con el corrector ya anulado: sigue siendo la misma operación ejecutada', async () => {
      const e = await escenario();
      const eventoId = await e.evento();
      const cuerpo = { clientOperationId: op() };
      const { data } = await e.corregir(eventoId, cuerpo);
      assert.equal((await e.anular(data.evento.eventoId)).status, 200);
      const reintento = await e.corregir(eventoId, cuerpo);
      assert.equal(reintento.status, 200);
      assert.equal(reintento.data.yaExistia, true);
      assert.equal(reintento.data.evento.estadoRegistro, 'ANULADO');
    });

    for (const [nombre, identidad] of [
      ['otra cuenta de la misma organización', (e) => ({ cuentaId: op(), organizacionId: e.org })],
      ['otra organización', (e) => ({ cuentaId: e.cuenta, organizacionId: op() })],
    ]) {
      test(`identidad incorrecta (${nombre}): 409 y cero escrituras`, async () => {
        const e = await escenario();
        const eventoId = await e.evento();
        const antes = await filas(e.animalId);
        const res = await e.corregir(eventoId, { identidadEsperada: identidad(e) });
        assert.equal(res.status, 409);
        assert.equal(res.data.error, 'IDENTIDAD_NO_COINCIDE');
        assert.deepEqual(await filas(e.animalId), antes);
      });
    }

    test('rollback: un corrector inválido deja el original ACTIVO y no crea filas', async () => {
      const e = await escenario();
      const a = await e.nuevoAnimal({ fechaNacimiento: '2024-03-01' });
      const eventoId = (await e.crear({}, a)).data.evento.eventoId;
      const antes = await filas(a);
      const fecha = await e.corregir(eventoId, { evento: { ...CELO, fechaEvento: '2024-02-01' } }, a);
      assert.equal(fecha.status, 400);
      assert.equal(fecha.data.error, 'INVALID_FECHA');
      const toro = await e.corregir(eventoId, { evento: { tipoEvento: 'INSEMINACION_ARTIFICIAL', fechaEvento: '2026-01-06', toroAnimalId: '999999999' } }, a);
      assert.equal(toro.status, 400);
      assert.equal(toro.data.error, 'INVALID_TORO');
      assert.deepEqual(await filas(a), antes);
    });

    test('rollback: si el INSERT del corrector falla después de anular, la anulación se revierte', async () => {
      const e = await escenario();
      const eventoId = await e.evento();
      const antes = await filas(e.animalId);
      // El disparador rechaza el corrector cuando el original YA fue marcado ANULADO en esta transacción.
      const sufijo = crypto.randomUUID().replaceAll('-', '');
      const nombre = `tg_rechazo_${sufijo}`;
      await adminPool.query(`create function agx.${nombre}() returns trigger language plpgsql as $f$
        begin
          if new.corrige_evento_id = ${Number(eventoId)} then raise exception 'fallo inyectado'; end if;
          return new;
        end $f$`);
      await adminPool.query(`create trigger ${nombre} before insert on agx.reproduccion_eventos for each row execute function agx.${nombre}()`);
      try {
        const res = await e.corregir(eventoId);
        assert.equal(res.status, 500);
        assert.doesNotMatch(JSON.stringify(res.data), /fallo inyectado|insert into|reproduccion_eventos/);
      } finally {
        await adminPool.query(`drop trigger ${nombre} on agx.reproduccion_eventos`);
        await adminPool.query(`drop function agx.${nombre}()`);
      }
      assert.deepEqual(await filas(e.animalId), antes, 'ni anulación ni corrector');
    });

    test('aislamiento: otra organización recibe 404 y nada cambia', async () => {
      const a = await escenario();
      const b = await escenario();
      const eventoId = await a.evento();
      const res = await a.corregir(eventoId, {}, a.animalId, b.sesion);
      assert.equal(res.status, 404);
      assert.equal((await filas(a.animalId)).length, 1);
    });
  });

  describe('ids cruzados entre tipos', () => {
    test('CREATE -> ANULAR: el id de un registro no puede anular (ni otro evento ni el suyo)', async () => {
      const e = await escenario();
      const x = op();
      const propio = await e.evento({ clientOperationId: x });
      const otro = await e.evento({ ...IA });
      const antes = await filas(e.animalId);
      esReused(await e.anular(otro, { clientOperationId: x }));
      esReused(await e.anular(propio, { clientOperationId: x }));
      assert.deepEqual(await filas(e.animalId), antes);
    });

    test('ANULAR -> CREATE: el id de una anulación no puede registrar', async () => {
      const e = await escenario();
      const x = op();
      const eventoId = await e.evento();
      await e.anular(eventoId, { clientOperationId: x });
      const antes = await filas(e.animalId);
      esReused(await e.crear({ ...IA, clientOperationId: x }));
      assert.deepEqual(await filas(e.animalId), antes);
    });

    test('CREATE -> CORREGIR: el id de un registro no puede corregir, y el original no cambia', async () => {
      const e = await escenario();
      const x = op();
      const eventoId = await e.evento({ clientOperationId: x });
      const antes = await filas(e.animalId);
      esReused(await e.corregir(eventoId, { clientOperationId: x }));
      assert.deepEqual(await filas(e.animalId), antes);
    });

    test('ANULAR -> CORREGIR: reutilización externa rechazada, sobre el mismo evento o sobre otro', async () => {
      const e = await escenario();
      const x = op();
      const anulado = await e.evento();
      const otro = await e.evento({ ...IA });
      await e.anular(anulado, { clientOperationId: x });
      const antes = await filas(e.animalId);
      esReused(await e.corregir(anulado, { clientOperationId: x }));
      esReused(await e.corregir(otro, { clientOperationId: x }));
      assert.deepEqual(await filas(e.animalId), antes);
    });

    test('CORREGIR -> CREATE / ANULAR: el id de una corrección no sirve para otra intención independiente', async () => {
      const e = await escenario();
      const x = op();
      const original = await e.evento();
      const otro = await e.evento({ ...IA });
      const { data } = await e.corregir(original, { clientOperationId: x });
      const antes = await filas(e.animalId);
      esReused(await e.crear({ ...IA, fechaEvento: '2026-01-07', clientOperationId: x }));
      esReused(await e.anular(otro, { clientOperationId: x }));
      esReused(await e.anular(original, { clientOperationId: x }));
      esReused(await e.anular(data.evento.eventoId, { clientOperationId: x }));
      assert.deepEqual(await filas(e.animalId), antes);
    });

    test('CORREGIR -> CORREGIR: mismo id con otro objetivo, motivo o evento', async () => {
      const e = await escenario();
      const x = op();
      const original = await e.evento();
      const otro = await e.evento({ ...IA });
      await e.corregir(original, { clientOperationId: x });
      const antes = await filas(e.animalId);
      esReused(await e.corregir(otro, { clientOperationId: x }));
      esReused(await e.corregir(original, { clientOperationId: x, motivo: 'otro' }));
      esReused(await e.corregir(original, { clientOperationId: x, evento: { ...IA, toroExterno: 'Otro' } }));
      assert.deepEqual(await filas(e.animalId), antes);
    });

    test('el conflicto de id se evalúa antes que el de negocio y no revela datos ajenos', async () => {
      const e = await escenario();
      const x = op();
      await e.evento({ clientOperationId: x });
      const res = await e.anular('999999999', { clientOperationId: x });
      esReused(res);
      assert.doesNotMatch(JSON.stringify(res.data), new RegExp(x));
    });

    test('el mismo id en otra organización es otra operación: el control no cruza tenants', async () => {
      const a = await escenario();
      const b = await escenario();
      const x = op();
      await a.evento({ clientOperationId: x });
      const deB = await b.evento();
      assert.equal((await b.anular(deB, { clientOperationId: x })).status, 200);
      const y = op();
      const deA = await a.evento({ ...IA });
      await a.anular(deA, { clientOperationId: y });
      assert.equal((await b.crear({ ...IA, clientOperationId: y })).status, 201);
    });

    test('idempotencia legítima intacta: cada operación reintentada responde yaExistia', async () => {
      const e = await escenario();
      const [idCrear, idAnular, idCorregir] = [op(), op(), op()];
      const cuerpoCrear = { ...CELO, clientOperationId: idCrear };
      const creado = await e.crear(cuerpoCrear);
      assert.equal(creado.status, 201);
      const reCrear = await e.crear(cuerpoCrear);
      assert.equal(reCrear.status, 200);
      assert.equal(reCrear.data.yaExistia, true);
      const objetivoAnular = await e.evento({ ...IA });
      assert.equal((await e.anular(objetivoAnular, { clientOperationId: idAnular })).status, 200);
      assert.equal((await e.anular(objetivoAnular, { clientOperationId: idAnular })).data.yaExistia, true);
      const objetivoCorregir = await e.evento({ ...IA, fechaEvento: '2026-01-07' });
      assert.equal((await e.corregir(objetivoCorregir, { clientOperationId: idCorregir })).status, 201);
      assert.equal((await e.corregir(objetivoCorregir, { clientOperationId: idCorregir })).data.yaExistia, true);
    });

    test('datos históricos con un id ya cruzado: los reintentos exactos siguen siendo idempotentes', async () => {
      const e = await escenario();
      const x = op();
      const cuerpoCrear = { ...CELO, clientOperationId: x };
      await e.crear(cuerpoCrear);
      const anulado = await e.evento({ ...IA });
      await adminPool.query(
        `update agx.reproduccion_eventos
            set estado_registro = 'ANULADO', anulado_por = $2, anulado_at = now(), motivo_anulacion = 'Histórico', anulacion_client_operation_id = $3
          where evento_id = $1`,
        [anulado, e.cuenta, x],
      );
      const reCrear = await e.crear(cuerpoCrear);
      assert.equal(reCrear.status, 200);
      assert.equal(reCrear.data.yaExistia, true);
      const reAnular = await e.anular(anulado, { clientOperationId: x, motivo: 'Histórico' });
      assert.equal(reAnular.status, 200);
      assert.equal(reAnular.data.yaExistia, true);
    });

    test('concurrencia: CREATE y ANULAR simultáneos con el mismo id: gana uno, nunca los dos', async () => {
      for (let vuelta = 0; vuelta < 8; vuelta += 1) {
        const e = await escenario();
        const objetivo = await e.evento();
        const x = op();
        const [creado, anulado] = await Promise.all([
          e.crear({ ...IA, clientOperationId: x }),
          e.anular(objetivo, { clientOperationId: x }),
        ]);
        const exitos = [creado, anulado].filter((r) => r.status < 300).length;
        assert.equal(exitos, 1, `${creado.status}/${anulado.status}`);
        for (const r of [creado, anulado]) if (r.status >= 300) esReused(r);
        const usos = (await filas(e.animalId)).filter((f) => f.coid === x || f.acoid === x);
        assert.equal(usos.length, 1);
      }
    });
  });

  describe('anulacionClientOperationId en el pull', () => {
    const pull = async (sesion) => {
      const res = await get('/api/ganaderia/sync/reproduccion', sesion);
      assert.equal(res.status, 200);
      return new Map(res.data.eventos.map((e) => [e.eventoId, e]));
    };

    test('ACTIVO -> null; ANULAR -> su id; el id de creación no se confunde con el de anulación', async () => {
      const e = await escenario();
      const [idCrear, idAnular] = [op(), op()];
      const activo = await e.evento();
      const anulado = await e.evento({ ...IA, clientOperationId: idCrear });
      await e.anular(anulado, { clientOperationId: idAnular });
      const eventos = await pull(e.sesion);
      assert.equal(eventos.get(activo).anulacionClientOperationId, null);
      assert.equal(eventos.get(anulado).anulacionClientOperationId, idAnular);
      assert.equal(eventos.get(anulado).clientOperationId, idCrear);
      assert.equal(eventos.get(anulado).estadoRegistro, 'ANULADO');
    });

    test('evidencia exacta: dos anulaciones con igual motivo, fecha y tipo se distinguen solo por su id', async () => {
      const e = await escenario();
      const b = await e.nuevoAnimal();
      const [idA, idB] = [op(), op()];
      const enA = await e.evento();
      const enB = (await e.crear({}, b)).data.evento.eventoId;
      await e.anular(enA, { clientOperationId: idA });
      await e.anular(enB, { clientOperationId: idB }, b);
      const eventos = await pull(e.sesion);
      assert.equal(eventos.get(enA).anulacion.motivo, eventos.get(enB).anulacion.motivo);
      assert.equal(eventos.get(enA).fechaEvento, eventos.get(enB).fechaEvento);
      assert.equal(eventos.get(enA).anulacionClientOperationId, idA);
      assert.equal(eventos.get(enB).anulacionClientOperationId, idB);
      assert.notEqual(idA, idB);
    });

    test('CORREGIR es demostrable: mismo id en corrector y original, enlazados, también con el corrector anulado', async () => {
      const e = await escenario();
      const x = op();
      const original = await e.evento();
      const { data } = await e.corregir(original, { clientOperationId: x });
      const corrector = data.evento.eventoId;
      const fila = (await pull(e.sesion)).get(corrector);
      assert.deepEqual(
        [fila.clientOperationId, fila.corrigeEventoId, fila.animalId, fila.estadoRegistro, fila.anulacionClientOperationId],
        [x, original, e.animalId, 'ACTIVO', null],
      );
      assert.equal((await pull(e.sesion)).get(original).anulacionClientOperationId, x);
      assert.equal((await pull(e.sesion)).get(original).corregidoPorEventoId, corrector);
      const idAnulaCorrector = op();
      await e.anular(corrector, { clientOperationId: idAnulaCorrector });
      const despues = (await pull(e.sesion)).get(corrector);
      assert.deepEqual(
        [despues.clientOperationId, despues.corrigeEventoId, despues.estadoRegistro, despues.anulacionClientOperationId],
        [x, original, 'ANULADO', idAnulaCorrector],
      );
    });

    test('aislamiento: otra organización no ve ni el evento ni el id', async () => {
      const a = await escenario();
      const b = await escenario();
      const x = op();
      await a.anular(await a.evento(), { clientOperationId: x });
      const res = await get('/api/ganaderia/sync/reproduccion', b.sesion);
      assert.deepEqual(res.data.eventos, []);
      assert.doesNotMatch(JSON.stringify(res.data), new RegExp(x));
    });

    test('el GET público no expone ni el id de anulación ni el de creación', async () => {
      const e = await escenario();
      const [idCrear, idAnular] = [op(), op()];
      await e.anular(await e.evento({ clientOperationId: idCrear }), { clientOperationId: idAnular });
      const publico = await get(`/api/ganaderia/animales/${e.animalId}/reproduccion`, e.sesion);
      assert.equal(publico.status, 200);
      const texto = JSON.stringify(publico.data);
      assert.doesNotMatch(texto, new RegExp(`${idCrear}|${idAnular}`));
      assert.doesNotMatch(texto, /anulacionClientOperationId|clientOperationId/);
    });
  });
});
