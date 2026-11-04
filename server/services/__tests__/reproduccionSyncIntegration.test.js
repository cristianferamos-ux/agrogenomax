// FASE 4E.1 -- pull reproductivo contra un Postgres/PostGIS REAL con agx_app (RLS
// FORCE): evento nuevo, anulación posterior, corrección, keyset con instantes
// iguales, solape, confirmación tardía, conciliación, aislamiento y trazabilidad.
// Mismas variables que reproduccionIntegration; se auto-omite si faltan o si 0026
// no está aplicada.
delete process.env.AGX_BUSINESS_DATABASE_URL;
delete process.env.AGX_BUSINESS_QR_ADMIN_DATABASE_URL;

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import pg from 'pg';
import { validateCreateAnimalBody } from '../ganaderia/animalValidation.js';
import {
  validateAnularEventoReproductivoBody,
  validateCorregirEventoReproductivoBody,
  validateCrearEventoReproductivoBody,
} from '../ganaderia/reproduccionValidation.js';
import { resolveFechaHoyNegocio } from '../ganaderia/motorDescansoAuto/businessTimezone.js';
import { ORG_STORES } from '../../../src/modules/ganaderia/offline/offlineSchema.js';
import { createMemoryStorage } from '../../../src/modules/ganaderia/offline/storage.js';
import { createLocalRepo } from '../../../src/modules/ganaderia/offline/localRepo.js';
import { OUTBOX_ESTADOS, REPRODUCCION_EVENTO_CREAR, claveOrdenAnimal, newOperation } from '../../../src/modules/ganaderia/offline/outbox.js';

let dbAvailable = false;
let adminPool;
let appPool;
let animalesRepo;
let repro;
let sync;
let businessDb;
let qrAdminDb;

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
  appPool = new pg.Pool({ connectionString: app, max: 2 });
  dbAvailable = (await adminPool.query(`select to_regclass('agx.reproduccion_eventos') is not null as ok`)).rows[0].ok === true;
} catch {
  dbAvailable = false;
}

if (dbAvailable) {
  animalesRepo = await import('../ganaderia/animalesRepository.js');
  repro = await import('../ganaderia/reproduccionRepository.js');
  sync = await import('../ganaderia/reproduccionSyncRepository.js');
  businessDb = await import('../../db/agxBusinessPool.js');
  qrAdminDb = await import('../../db/agxQrAdminPool.js');
}

after(async () => {
  await adminPool?.end().catch(() => {});
  await appPool?.end().catch(() => {});
  businessDb?.closeAgxBusinessPool?.();
  await qrAdminDb?.closeAgxQrAdminPool?.();
});

const HOY = resolveFechaHoyNegocio();
const OPTS = { hoy: HOY, horaAhora: '23:59' };
const ACTOR = '00000000-0000-4000-8000-0000000000aa';
const op = () => crypto.randomUUID();

async function seedAnimal(org, extra = {}) {
  const predio = await adminPool.query(`insert into agx.predios (organizacion_id, nombre_predio, estado) values ($1, 'Predio 4E', 'ACTIVO') returning predio_id`, [org]);
  const body = validateCreateAnimalBody({
    clientOperationId: op(), predioId: String(predio.rows[0].predio_id), numeroVisual: `R-${op().slice(0, 8)}`,
    sexo: 'HEMBRA', nacimientoTipo: 'DESCONOCIDA', razaTipo: 'DESCONOCIDA', ...extra,
  }, { hoy: HOY });
  return (await animalesRepo.createAnimalIdempotente(org, body, { actorCuentaId: ACTOR })).animal.animalId;
}

const registrar = (org, animalId, body = { tipoEvento: 'CELO_OBSERVADO', fechaEvento: HOY }) => repro.registrarEventoReproductivoIdempotente(
  org, animalId, validateCrearEventoReproductivoBody({ clientOperationId: op(), ...body }, OPTS), { actorCuentaId: ACTOR, hoy: HOY },
);
const anular = (org, animalId, eventoId) => repro.anularEventoReproductivoIdempotente(
  org, animalId, eventoId, validateAnularEventoReproductivoBody({ clientOperationId: op(), motivo: 'Error de digitación' }), { actorCuentaId: ACTOR, hoy: HOY },
);

/** Filas con marca controlada: el trigger solo vigila UPDATE y DELETE. */
async function insertarDirecto(org, animalId, { registradoAt, anuladoAt = null }) {
  const anulado = anuladoAt !== null;
  const { rows } = await adminPool.query(
    `insert into agx.reproduccion_eventos (organizacion_id, animal_id, tipo_evento, fecha_evento, registrado_por, registrado_at, client_operation_id, intent_hash,
       estado_registro, anulado_por, anulado_at, motivo_anulacion, anulacion_client_operation_id)
     values ($1, $2, 'CELO_OBSERVADO', $3, $4, $5::timestamptz, gen_random_uuid(), 'v1:' || repeat('c', 64),
       $6, $7, $8::timestamptz, $9, $10)
     returning evento_id::text as evento_id`,
    [org, animalId, HOY, ACTOR, registradoAt, anulado ? 'ANULADO' : 'ACTIVO', anulado ? ACTOR : null, anuladoAt, anulado ? 'Motivo' : null, anulado ? op() : null],
  );
  return rows[0].evento_id;
}

const pull = (org, cursor) => sync.pullEventosReproductivos(org, { cursor });

/** Recorre todas las páginas con un tamaño pequeño, en la misma forma que el endpoint. */
async function recorrer(org, cursor, limite) {
  const paginas = [];
  let actual = cursor;
  for (;;) {
    const pagina = await businessDb.withOrganizacionTransaction(org, (client) => sync.leerPaginaEnTx(client, { cursor: actual, limite }));
    paginas.push(pagina);
    actual = pagina.cursor;
    if (!pagina.hayMas) return { paginas, cursor: actual, eventos: paginas.flatMap((p) => p.eventos) };
  }
}

const hace = (ms) => new Date(Date.now() - ms).toISOString();
const ids = (eventos) => eventos.map((e) => e.eventoId);
const tieneId = (eventos, id) => ids(eventos).includes(String(id));

describe('pull reproductivo: Postgres real', { skip: !dbAvailable }, () => {
  test('RLS: la tabla sigue con ENABLE + FORCE y agx_app no la evita', async () => {
    const { rows: [t] } = await adminPool.query(`select relrowsecurity, relforcerowsecurity from pg_class where oid = 'agx.reproduccion_eventos'::regclass`);
    assert.deepEqual(t, { relrowsecurity: true, relforcerowsecurity: true });
    const { rows: [rol] } = await appPool.query(`select current_user, rolbypassrls, rolsuper from pg_roles where rolname = current_user`);
    assert.deepEqual(rol, { current_user: 'agx_app', rolbypassrls: false, rolsuper: false });
    const sinOrg = await appPool.query('select count(*)::int as n from agx.reproduccion_eventos');
    assert.equal(sinOrg.rows[0].n, 0, 'sin organización en la sesión no se ve nada');
  });

  test('organización sin eventos: respuesta válida y vacía', async () => {
    const res = await pull(crypto.randomUUID());
    assert.deepEqual(res.eventos, []);
    assert.equal(res.hayMas, false);
    assert.equal(res.completo, true);
    assert.deepEqual(res.totales, { eventos: 0, anulados: 0 });
    assert.equal(typeof res.cursor, 'string');
    const siguiente = await pull(crypto.randomUUID(), res.cursor);
    assert.deepEqual(siguiente.eventos, []);
    assert.equal(siguiente.completo, false);
  });

  test('evento nuevo entra en el siguiente pull, con el formato público y su clientOperationId', async () => {
    const org = crypto.randomUUID();
    const animalId = await seedAnimal(org);
    const inicio = await pull(org);
    const { evento } = await registrar(org, animalId);
    const res = await pull(org, inicio.cursor);
    assert.ok(tieneId(res.eventos, evento.eventoId));
    const fila = res.eventos.find((e) => e.eventoId === evento.eventoId);
    assert.equal(fila.animalId, String(animalId));
    assert.equal(fila.tipoEvento, 'CELO_OBSERVADO');
    assert.equal(fila.estadoRegistro, 'ACTIVO');
    assert.match(fila.clientOperationId, /^[0-9a-f-]{36}$/);
    for (const prohibido of ['registradoPor', 'registrado_por', 'anuladoPor', 'intentHash', 'intent_hash', 'organizacionId', 'marca']) {
      assert.equal(prohibido in fila, false, prohibido);
    }
    assert.deepEqual(res.totales, { eventos: 1, anulados: 0 });
  });

  test('evento anulado después de sincronizarse vuelve a entrar y conserva la trazabilidad', async () => {
    const org = crypto.randomUUID();
    const animalId = await seedAnimal(org);
    const eventoId = await insertarDirecto(org, animalId, { registradoAt: hace(30 * 86_400_000) });
    const primero = await pull(org);
    assert.equal(primero.eventos[0].estadoRegistro, 'ACTIVO');

    // Con registrado_at muy anterior al solape, solo anulado_at puede traerlo de vuelta.
    await anular(org, animalId, eventoId);
    const res = await pull(org, primero.cursor);
    const fila = res.eventos.find((e) => e.eventoId === eventoId);
    assert.ok(fila, 'la anulación no se pierde');
    assert.equal(fila.estadoRegistro, 'ANULADO');
    assert.equal(fila.anulacion.motivo, 'Error de digitación');
    assert.ok(fila.anulacion.anuladoEn);
    assert.ok(fila.registradoEn < fila.anulacion.anuladoEn);
    assert.equal(fila.tipoEvento, 'CELO_OBSERVADO');
    assert.deepEqual(res.totales, { eventos: 1, anulados: 1 });
  });

  test('corrección: el original anulado y el nuevo llegan juntos, enlazados entre sí', async () => {
    const org = crypto.randomUUID();
    const animalId = await seedAnimal(org);
    const eventoId = await insertarDirecto(org, animalId, { registradoAt: hace(30 * 86_400_000) });
    const primero = await pull(org);
    const corregido = await repro.corregirEventoReproductivoIdempotente(
      org, animalId, eventoId,
      validateCorregirEventoReproductivoBody({ clientOperationId: op(), motivo: 'Fecha mal digitada', evento: { tipoEvento: 'CELO_OBSERVADO', fechaEvento: HOY } }, OPTS),
      { actorCuentaId: ACTOR, hoy: HOY },
    );
    const res = await pull(org, primero.cursor);
    const original = res.eventos.find((e) => e.eventoId === eventoId);
    assert.equal(original.estadoRegistro, 'ANULADO');
    assert.equal(original.corregidoPorEventoId, corregido.evento.eventoId);
    assert.equal(res.eventos.find((e) => e.eventoId === corregido.evento.eventoId).corrigeEventoId, eventoId);
  });

  test('keyset: muchas filas con el MISMO instante no se pierden al paginar, en ningún tamaño de página', async () => {
    const org = crypto.randomUUID();
    const animalId = await seedAnimal(org);
    const instante = hace(3_600_000);
    const creados = [];
    for (let i = 0; i < 7; i += 1) creados.push(await insertarDirecto(org, animalId, { registradoAt: instante }));
    creados.push(await insertarDirecto(org, animalId, { registradoAt: hace(7_200_000), anuladoAt: instante }));
    for (const limite of [1, 2, 3, 8, 9]) {
      const { eventos, paginas } = await recorrer(org, undefined, limite);
      assert.deepEqual(ids(eventos).sort(), [...creados].sort(), `limite ${limite}`);
      assert.equal(new Set(ids(eventos)).size, eventos.length, 'sin repetir dentro del recorrido');
      assert.ok(paginas.slice(0, -1).every((p) => p.hayMas && p.totales === null && p.completo));
      assert.deepEqual(paginas.at(-1).totales, { eventos: 8, anulados: 1 });
    }
  });

  test('keyset: con el mismo instante manda evento_id aunque el orden físico sea el inverso', async () => {
    const org = crypto.randomUUID();
    const animalId = await seedAnimal(org);
    const instante = hace(3_600_000);
    const { rows: reservados } = await adminPool.query(`select nextval('agx.reproduccion_eventos_evento_id_seq')::text as id from generate_series(1, 6)`);
    const descendentes = reservados.map((r) => r.id).reverse();
    for (const id of descendentes) {
      await adminPool.query(
        `insert into agx.reproduccion_eventos (evento_id, organizacion_id, animal_id, tipo_evento, fecha_evento, registrado_por, registrado_at, client_operation_id, intent_hash)
         values ($1, $2, $3, 'CELO_OBSERVADO', $4, $5, $6::timestamptz, gen_random_uuid(), 'v1:' || repeat('c', 64))`,
        [id, org, animalId, HOY, ACTOR, instante],
      );
    }
    const { eventos } = await recorrer(org, undefined, 1);
    assert.deepEqual(ids(eventos), [...descendentes].reverse());
  });

  test('keyset: instantes que solo difieren en microsegundos conservan el orden y no se saltan', async () => {
    const org = crypto.randomUUID();
    const animalId = await seedAnimal(org);
    const base = '2026-01-15T10:00:00.1234';
    const creados = [];
    for (const us of ['57Z', '56Z', '58Z']) creados.push(await insertarDirecto(org, animalId, { registradoAt: base + us }));
    const { eventos } = await recorrer(org, undefined, 1);
    assert.deepEqual(ids(eventos), [creados[1], creados[0], creados[2]]);
  });

  test('solape: reentrega lo reciente en el siguiente recorrido y no lo anterior a la ventana', async () => {
    const org = crypto.randomUUID();
    const animalId = await seedAnimal(org);
    const viejo = await insertarDirecto(org, animalId, { registradoAt: hace(sync.REPRO_SYNC_SOLAPE_MS * 3) });
    const reciente = await insertarDirecto(org, animalId, { registradoAt: hace(60_000) });
    const primero = await pull(org);
    assert.deepEqual(ids(primero.eventos).sort(), [viejo, reciente].sort());
    const segundo = await pull(org, primero.cursor);
    assert.deepEqual(ids(segundo.eventos), [reciente], 'duplicado de transporte, ventana exacta');
    assert.equal(segundo.completo, false);
    assert.deepEqual(segundo.totales, { eventos: 2, anulados: 0 });
  });

  test('confirmación tardía: una fila con marca anterior al corte, visible después, entra por el solape', async () => {
    const org = crypto.randomUUID();
    const animalId = await seedAnimal(org);
    const primero = await pull(org);
    // Transacción que empezó antes del corte y confirmó después.
    const tardia = await insertarDirecto(org, animalId, { registradoAt: hace(120_000) });
    const res = await pull(org, primero.cursor);
    assert.ok(tieneId(res.eventos, tardia));
  });

  test('confirmación MÁS tardía que el solape: la fila no llega por tiempo, y los totales lo delatan', async () => {
    const org = crypto.randomUUID();
    const animalId = await seedAnimal(org);
    const primero = await pull(org);
    const perdida = await insertarDirecto(org, animalId, { registradoAt: hace(sync.REPRO_SYNC_SOLAPE_MS * 2) });
    const res = await pull(org, primero.cursor);
    assert.equal(tieneId(res.eventos, perdida), false);
    assert.equal(res.totales.eventos, 1, 'el dispositivo con 0 detecta el desfase');
    assert.ok(tieneId((await pull(org)).eventos, perdida), 'el recorrido completo la recupera');
  });

  test('una fila anulada durante el recorrido se entrega con su estado final', async () => {
    const org = crypto.randomUUID();
    const animalId = await seedAnimal(org);
    const a = await insertarDirecto(org, animalId, { registradoAt: hace(40_000_000) });
    const b = await insertarDirecto(org, animalId, { registradoAt: hace(30_000_000) });
    const leer = (cursor) => businessDb.withOrganizacionTransaction(org, (client) => sync.leerPaginaEnTx(client, { cursor, limite: 1 }));
    const uno = await leer();
    assert.deepEqual(ids(uno.eventos), [a]);
    await anular(org, animalId, b);
    const vistos = [];
    let cursor = uno.cursor;
    for (;;) {
      const pagina = await leer(cursor);
      vistos.push(...pagina.eventos);
      cursor = pagina.cursor;
      if (!pagina.hayMas) break;
    }
    assert.equal(vistos.find((e) => e.eventoId === b).estadoRegistro, 'ANULADO');
  });

  test('una anulación que entra mientras se recorre tampoco se pierde en el siguiente recorrido', async () => {
    const org = crypto.randomUUID();
    const animalId = await seedAnimal(org);
    const a = await insertarDirecto(org, animalId, { registradoAt: hace(40_000_000) });
    const fin = await pull(org);
    await anular(org, animalId, a);
    const res = await pull(org, fin.cursor);
    assert.equal(res.eventos[0].estadoRegistro, 'ANULADO');
  });

  test('aislamiento: animal, evento y totales de otra organización nunca aparecen, ni con su cursor', async () => {
    const orgA = crypto.randomUUID();
    const orgB = crypto.randomUUID();
    const animalA = await seedAnimal(orgA);
    const animalB = await seedAnimal(orgB);
    const deA = (await registrar(orgA, animalA)).evento.eventoId;
    const deB = (await registrar(orgB, animalB)).evento.eventoId;
    const deBAnulado = await insertarDirecto(orgB, animalB, { registradoAt: hace(1000), anuladoAt: hace(500) });

    const res = await pull(orgA);
    assert.deepEqual(ids(res.eventos), [deA]);
    assert.ok(res.eventos.every((e) => e.animalId === String(animalA)));
    assert.deepEqual(res.totales, { eventos: 1, anulados: 0 });
    assert.deepEqual(ids((await pull(orgB)).eventos).sort(), [deB, deBAnulado].sort());

    // Cursor emitido a B presentado con la sesión de A: sigue viendo solo lo de A.
    const conCursorAjeno = await pull(orgA, (await pull(orgB)).cursor);
    assert.equal(tieneId(conCursorAjeno.eventos, deB), false);
    assert.equal(tieneId(conCursorAjeno.eventos, deBAnulado), false);
    const { paginas } = await recorrer(orgB, undefined, 1);
    const continuacion = paginas[0].cursor;
    const res2 = await businessDb.withOrganizacionTransaction(orgA, (client) => sync.leerPaginaEnTx(client, { cursor: continuacion, limite: 5 }));
    assert.equal(tieneId(res2.eventos, deB), false);
  });

  test('toro de la organización: viaja como referencia propia, sin datos de otra', async () => {
    const org = crypto.randomUUID();
    const animalId = await seedAnimal(org);
    const { evento } = await registrar(org, animalId, { tipoEvento: 'SERVICIO_MONTA', fechaEvento: HOY, tipoServicio: 'LIBRE', toroExterno: 'Toro externo' });
    const fila = (await pull(org)).eventos.find((e) => e.eventoId === evento.eventoId);
    assert.equal(fila.detalle.toroExterno, 'Toro externo');
    assert.equal(fila.detalle.tipoServicio, 'LIBRE');
    assert.equal('toroExterno' in fila, false, 'el detalle no se duplica en plano');
  });

  test('sin N+1: dos consultas por página más now() en la primera, sea cual sea el tamaño', async () => {
    const org = crypto.randomUUID();
    const animalId = await seedAnimal(org);
    for (let i = 0; i < 25; i += 1) await insertarDirecto(org, animalId, { registradoAt: hace(1_000_000 + i) });
    await businessDb.withOrganizacionTransaction(org, async (client) => {
      const original = client.query.bind(client);
      let consultas = 0;
      const contador = { query: (...args) => { consultas += 1; return original(...args); } };
      const primera = await sync.leerPaginaEnTx(contador, { limite: 20 });
      assert.equal(primera.eventos.length, 20);
      assert.equal(consultas, 3);
      consultas = 0;
      const segunda = await sync.leerPaginaEnTx(contador, { cursor: primera.cursor, limite: 20 });
      assert.equal(segunda.eventos.length, 5);
      assert.equal(consultas, 2);
    });
  });

  test('los totales se leen antes que las filas: un commit entre ambas no causa un falso desfase', async () => {
    const org = crypto.randomUUID();
    const animalId = await seedAnimal(org);
    await insertarDirecto(org, animalId, { registradoAt: hace(1000) });
    await businessDb.withOrganizacionTransaction(org, async (client) => {
      const original = client.query.bind(client);
      const envuelto = {
        query: async (sql, params) => {
          const res = await original(sql, params);
          if (sql.includes('count(*)')) await insertarDirecto(org, animalId, { registradoAt: hace(500) });
          return res;
        },
      };
      const res = await sync.leerPaginaEnTx(envuelto, {});
      assert.equal(res.totales.eventos, 1);
      assert.equal(res.eventos.length, 2, 'READ COMMITTED: el dispositivo queda con más, nunca con menos');
    });
  });

  test('solo lectura: el endpoint declara la transacción READ ONLY antes de leer, y ahí no se puede escribir', async () => {
    const org = crypto.randomUUID();
    const pool = businessDb.getAgxBusinessPool();
    const connect = pool.connect;
    const consultas = [];
    pool.connect = async (...args) => {
      const client = await connect.apply(pool, args);
      const query = client.query;
      client.query = (sql, ...resto) => { consultas.push(String(sql)); return query.call(client, sql, ...resto); };
      const release = client.release;
      client.release = (...r) => { client.query = query; client.release = release; return release.apply(client, r); };
      return client;
    };
    try {
      assert.deepEqual((await pull(org)).eventos, []);
    } finally {
      pool.connect = connect;
    }
    const soloLectura = consultas.indexOf('set transaction read only');
    assert.ok(soloLectura > 0, 'se declara');
    assert.ok(soloLectura < consultas.findIndex((sql) => sql.includes('reproduccion_eventos')), 'antes de leer');

    await assert.rejects(businessDb.withOrganizacionTransaction(org, async (client) => {
      await client.query('set transaction read only');
      await client.query(`insert into agx.predios (organizacion_id, nombre_predio) values ($1, 'x')`, [org]);
    }), { code: '25006' });
  });

  test('cursor inválido: 400 antes de abrir la transacción', async () => {
    await assert.rejects(pull(crypto.randomUUID(), 'x'), { code: 'INVALID_CURSOR', status: 400 });
  });

  describe('conciliación de punta a punta: POST real, pull real, repositorio local real', () => {
    const CUENTA_B = '00000000-0000-4000-8000-0000000000bb';

    async function dispositivoCon(org, animalId, cuerpo, clientOperationId, cambios = {}) {
      const repoLocal = createLocalRepo(createMemoryStorage(ORG_STORES), { organizacionId: org, deviceId: 'd' });
      const operacion = {
        ...newOperation({
          tipoOperacion: REPRODUCCION_EVENTO_CREAR, entidad: 'reproduccion_evento', localUuid: op(), clientOperationId,
          payload: { animalId: String(animalId), evento: cuerpo }, deviceId: 'd', now: new Date(), uuid: op,
          claveOrden: claveOrdenAnimal(animalId), origen: { organizacionId: org, cuentaId: ACTOR },
        }),
        estado: OUTBOX_ESTADOS.ERROR_REINTENTABLE,
        posibleEnServidor: true,
        ...cambios,
      };
      await repoLocal.storage.put('outbox', operacion);
      return { repoLocal, operacion };
    }

    /** POST que llegó al servidor; el cliente no vio la respuesta. */
    const postPerdido = (org, animalId, clientOperationId, cuerpo) => registrar(org, animalId, { clientOperationId, ...cuerpo });
    const paginaDe = async (org, cuentaId) => ({ organizacionId: org, cuentaId, ...(await pull(org)) });

    for (const [nombre, cuerpoDe] of [
      ['CELO_OBSERVADO', () => ({ tipoEvento: 'CELO_OBSERVADO', fechaEvento: HOY, intensidadCelo: 'ALTA', metodoDeteccion: 'VISUAL', observaciones: '  nota\r\nsegunda  ' })],
      ['SERVICIO_MONTA', (toro) => ({ tipoEvento: 'SERVICIO_MONTA', fechaEvento: HOY, tipoServicio: 'LIBRE', toroAnimalId: toro, horaEvento: '00:01' })],
      ['INSEMINACION_ARTIFICIAL', () => ({ tipoEvento: 'INSEMINACION_ARTIFICIAL', fechaEvento: HOY, semenCodigo: ' PAJ   1 ', tecnico: ' Ana  María ', toroExterno: ' Gyr X ' })],
      ['IATF', () => ({ tipoEvento: 'IATF', fechaEvento: HOY, protocoloIatf: ' J-Synch  6 ', semenCodigo: '  ' })],
      ['TRANSFERENCIA_EMBRION', () => ({ tipoEvento: 'TRANSFERENCIA_EMBRION', fechaEvento: HOY, embrionCodigo: ' E-1 ', embrionRaza: 'Gyr  lechero', embrionDonadora: ' D ', toroExterno: ' P ', embrionEstadio: ' 7 ', embrionCalidad: ' 1 ', embrionConservacion: 'FRESCO', tecnico: ' T ' })],
      ['DIAGNOSTICO_PRENEZ', () => ({ tipoEvento: 'DIAGNOSTICO_PRENEZ', fechaEvento: HOY, diagnosticoResultado: 'PRENADA', diagnosticoMetodo: 'ECOGRAFIA', diasGestacion: 45, tecnico: ' T ' })],
      ['ABORTO', () => ({ tipoEvento: 'ABORTO', fechaEvento: HOY, diasGestacion: 90, abortoCausa: '  Causa   rara ' })],
      ['PARTO', () => ({ tipoEvento: 'PARTO', fechaEvento: HOY, partoTipo: 'CESAREA', numeroCrias: 2 })],
    ]) {
      test(`${nombre}: respuesta perdida + pull real con la misma cuenta confirma, sin falso conflicto`, async () => {
        const org = crypto.randomUUID();
        const animalId = await seedAnimal(org);
        const toro = await seedAnimal(org, { sexo: 'MACHO' });
        const cuerpo = cuerpoDe(toro);
        const id = op();
        await postPerdido(org, animalId, id, cuerpo);
        const { repoLocal } = await dispositivoCon(org, animalId, cuerpo, id);
        await repoLocal.aplicarPullReproduccion(await paginaDe(org, ACTOR));
        assert.deepEqual(await repoLocal.listOutbox(), []);
        assert.equal((await repoLocal.listEventosReproductivos(animalId)).length, 1);
      });
    }

    test('otra cuenta de la misma organización: no confirma, aunque coincidan id e intención', async () => {
      const org = crypto.randomUUID();
      const animalId = await seedAnimal(org);
      const cuerpo = { tipoEvento: 'CELO_OBSERVADO', fechaEvento: HOY };
      const id = op();
      await postPerdido(org, animalId, id, cuerpo);
      const { repoLocal, operacion } = await dispositivoCon(org, animalId, cuerpo, id);
      await repoLocal.aplicarPullReproduccion(await paginaDe(org, CUENTA_B));
      assert.deepEqual(await repoLocal.listOutbox(), [operacion]);
    });

    test('intención distinta con el mismo id: conflicto seguro y la base no cambia', async () => {
      const org = crypto.randomUUID();
      const animalId = await seedAnimal(org);
      const id = op();
      await postPerdido(org, animalId, id, { tipoEvento: 'CELO_OBSERVADO', fechaEvento: HOY, intensidadCelo: 'ALTA' });
      const { repoLocal } = await dispositivoCon(org, animalId, { tipoEvento: 'CELO_OBSERVADO', fechaEvento: HOY, intensidadCelo: 'BAJA' }, id);
      await repoLocal.aplicarPullReproduccion(await paginaDe(org, ACTOR));
      assert.equal((await repoLocal.listOutbox())[0].estado, OUTBOX_ESTADOS.CONFLICTO);
      assert.equal((await pull(org)).eventos[0].detalle.intensidadCelo, 'ALTA');
    });

    test('dos eventos iguales del mismo animal: solo el id exacto cierra la operación', async () => {
      const org = crypto.randomUUID();
      const animalId = await seedAnimal(org);
      const cuerpo = { tipoEvento: 'CELO_OBSERVADO', fechaEvento: HOY };
      await postPerdido(org, animalId, op(), cuerpo);
      const id = op();
      const { repoLocal, operacion } = await dispositivoCon(org, animalId, cuerpo, id);
      await repoLocal.aplicarPullReproduccion(await paginaDe(org, ACTOR));
      assert.deepEqual(await repoLocal.listOutbox(), [operacion]);
      await postPerdido(org, animalId, id, cuerpo);
      await repoLocal.aplicarPullReproduccion(await paginaDe(org, ACTOR));
      assert.deepEqual(await repoLocal.listOutbox(), []);
      assert.equal((await repoLocal.listEventosReproductivos(animalId)).length, 2);
    });

    test('creado y anulado antes del pull: la creación se concilia y queda ANULADO', async () => {
      const org = crypto.randomUUID();
      const animalId = await seedAnimal(org);
      const cuerpo = { tipoEvento: 'CELO_OBSERVADO', fechaEvento: HOY };
      const id = op();
      const { evento } = await postPerdido(org, animalId, id, cuerpo);
      await anular(org, animalId, evento.eventoId);
      const { repoLocal } = await dispositivoCon(org, animalId, cuerpo, id);
      await repoLocal.aplicarPullReproduccion(await paginaDe(org, ACTOR));
      assert.deepEqual(await repoLocal.listOutbox(), []);
      const [guardado] = await repoLocal.listEventosReproductivos(animalId);
      assert.equal(guardado.estadoRegistro, 'ANULADO');
      assert.equal(guardado.anulacion.motivo, 'Error de digitación');
    });

    test('un evento de corrección con ese id no cierra el registro', async () => {
      const org = crypto.randomUUID();
      const animalId = await seedAnimal(org);
      const { evento } = await registrar(org, animalId);
      const id = op();
      const cuerpo = { tipoEvento: 'CELO_OBSERVADO', fechaEvento: HOY };
      await repro.corregirEventoReproductivoIdempotente(org, animalId, evento.eventoId,
        validateCorregirEventoReproductivoBody({ clientOperationId: id, motivo: 'Corrige', evento: cuerpo }, OPTS),
        { actorCuentaId: ACTOR, hoy: HOY });
      const { repoLocal } = await dispositivoCon(org, animalId, cuerpo, id);
      await repoLocal.aplicarPullReproduccion(await paginaDe(org, ACTOR));
      assert.equal((await repoLocal.listOutbox())[0].estado, OUTBOX_ESTADOS.CONFLICTO);
    });
  });

  test('el pull no modifica ninguna fila', async () => {
    const org = crypto.randomUUID();
    const animalId = await seedAnimal(org);
    await registrar(org, animalId);
    const antes = (await adminPool.query(`select xmin::text, * from agx.reproduccion_eventos where organizacion_id = $1`, [org])).rows;
    await pull(org);
    const despues = (await adminPool.query(`select xmin::text, * from agx.reproduccion_eventos where organizacion_id = $1`, [org])).rows;
    assert.deepEqual(despues, antes);
  });
});
