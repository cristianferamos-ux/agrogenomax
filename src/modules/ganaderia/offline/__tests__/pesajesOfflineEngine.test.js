// FASE 5A.3b -- motor offline de pesajes: IndexedDB v3 (store pesajes), pull de
// GET /sync/pesajes (cursorSiguiente), PESAJE_CREAR v2, PESAJE_ANULAR, FIFO común por
// animal, conciliación EXACTA, legacy incierto, identidad, posibleEnServidor, backoff
// y último peso local. Motor y repositorio reales con un servidor falso que reproduce
// el contrato de las rutas (idempotencia por clientOperationId, identidadEsperada,
// 409 PESAJE_YA_ANULADO / CLIENT_OPERATION_ID_REUSED, paginación con totales).
import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { ORG_DB_VERSION, ORG_STORES, orgDbName } from '../offlineSchema.js';
import { createIndexedDbStorage, createMemoryStorage, openIndexedDb } from '../storage.js';
import { createLocalRepo } from '../localRepo.js';
import { RUN_RESULT, createSyncEngine } from '../syncEngine.js';
import {
  OUTBOX_ESTADOS, PESAJE_ANULAR, PESAJE_CREAR, REPRODUCCION_EVENTO_CREAR, claveOrdenAnimal, claveOrdenPesajes,
  esPesajeCrearLegacy, newOperation, operacionesEnTurno, pesajeCrearCancelableSeguro,
} from '../outbox.js';
import { handlerDe } from '../operationHandlers.js';
import { derivarUltimoPesoLocal, filaConfirmaAnular, filaConfirmaCreate, fusionarPesaje, proyectarPesajeSync } from '../pesajesLocales.js';
import { createNavigatorLock, syncLockName } from '../browserOffline.js';
import { puedeEncolar } from '../../auth/ganaderiaPermisos.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTRA_ORG = '22222222-2222-4222-8222-222222222222';
const CUENTA_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const CUENTA_B = 'bbbbbbbb-0000-4000-8000-000000000002';
const SESSION_PATH = '/api/ganaderia/auth/session';
const SYNC_PESAJES = '/api/ganaderia/sync/pesajes';
const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function reloj(inicio = '2026-11-18T15:00:00.000Z') {
  let t = new Date(inicio).getTime();
  return { now: () => new Date(t), avanzar: (ms) => { t += ms; } };
}

function contadorUuid(prefijo = 'f') {
  let n = 0;
  return () => `${prefijo.repeat(8)}-0000-4000-8000-${String(++n).padStart(12, '0')}`;
}

const sesionDe = (cuentaId, organizacionId = ORG) => ({ authenticated: true, cuenta: { cuentaId }, organizacionActiva: { organizacionId } });

/** Servidor falso: pesajes, anulación, sesión y /sync/pesajes paginado con totales. */
function servidor() {
  const srv = {
    filas: [],
    log: [], // pesajeId por cada cambio (creación o anulación), en orden de marca
    posts: [],
    gets: [],
    seq: 100,
    pagina: 500,
    solape: 0,
    sesion: sesionDe(CUENTA_A),
    falla: null, // (pathname, body) => 'red' | 'red-tras-guardar' | 'no-enviada' | { status, data } | null
    alEnviar: null,
    trasPagina: null,
    sembrar(fila) {
      const completa = { organizacionId: ORG, metodo: 'BASCULA', origen: 'MANUAL', observaciones: null, createdAt: '2026-10-01T10:00:00.000Z', estadoRegistro: 'ACTIVO', anulacion: null, clientOperationId: null, anulacionClientOperationId: null, ...fila };
      srv.filas.push(completa);
      srv.log.push(completa.pesajeId);
      return completa;
    },
    anularEnServidor(pesajeId, motivo, clientOperationId) {
      const fila = srv.filas.find((f) => f.pesajeId === pesajeId);
      Object.assign(fila, { estadoRegistro: 'ANULADO', anulacion: { anuladoEn: '2026-11-18T12:00:00.000Z', motivo }, anulacionClientOperationId: clientOperationId });
      srv.log.push(pesajeId);
    },
    publico(f) {
      const { animalId: _a, organizacionId: _o, clientOperationId: _c, anulacionClientOperationId: _ac, ...vista } = f;
      return vista;
    },
    identidadDistinta(identidadEsperada) {
      return identidadEsperada && (identidadEsperada.cuentaId !== srv.sesion.cuenta?.cuentaId || identidadEsperada.organizacionId !== srv.sesion.organizacionActiva?.organizacionId);
    },
    responder(pathname, body) {
      const anular = pathname.match(/\/animales\/(\d+)\/pesajes\/(\d+)\/anular$/);
      const crear = pathname.match(/\/animales\/(\d+)\/pesajes$/);
      if (srv.identidadDistinta(body.identidadEsperada)) return { ok: false, status: 409, data: { error: 'IDENTIDAD_NO_COINCIDE' } };
      if (crear) {
        const animalId = crear[1];
        const previa = srv.filas.find((f) => f.clientOperationId === body.clientOperationId);
        if (previa) {
          const misma = previa.animalId === animalId && previa.fecha === body.fecha && previa.pesoKg === Number(body.pesoKg);
          return misma ? { ok: true, status: 200, data: { ok: true, yaExistia: true, pesaje: srv.publico(previa) } } : { ok: false, status: 409, data: { error: 'CLIENT_OPERATION_ID_REUSED' } };
        }
        const fila = srv.sembrar({ pesajeId: String(++srv.seq), animalId, fecha: body.fecha, pesoKg: Number(body.pesoKg), metodo: body.metodo, clientOperationId: body.clientOperationId, createdAt: '2026-11-18T15:00:00.000Z' });
        return { ok: true, status: 201, data: { ok: true, yaExistia: false, pesaje: srv.publico(fila) } };
      }
      if (anular) {
        const [, animalId, pesajeId] = anular;
        const fila = srv.filas.find((f) => f.pesajeId === pesajeId && f.animalId === animalId);
        if (!fila) return { ok: false, status: 404, data: { error: 'PESAJE_NOT_FOUND' } };
        const otra = srv.filas.find((f) => f.anulacionClientOperationId === body.clientOperationId);
        if (otra && otra !== fila) return { ok: false, status: 409, data: { error: 'CLIENT_OPERATION_ID_REUSED' } };
        if (fila.estadoRegistro === 'ANULADO') {
          if (fila.anulacionClientOperationId === body.clientOperationId && fila.anulacion.motivo === body.motivo) {
            return { ok: true, status: 200, data: { ok: true, yaExistia: true, pesaje: srv.publico(fila) } };
          }
          return { ok: false, status: 409, data: { error: fila.anulacionClientOperationId === body.clientOperationId ? 'CLIENT_OPERATION_ID_REUSED' : 'PESAJE_YA_ANULADO' } };
        }
        srv.anularEnServidor(pesajeId, body.motivo, body.clientOperationId);
        return { ok: true, status: 200, data: { ok: true, yaExistia: false, pesaje: srv.publico(fila), resumen: {} } };
      }
      return { ok: false, status: 404, data: { error: 'NOT_FOUND' } };
    },
    paginaPesajes(cursorRaw) {
      let cursor = null;
      try {
        cursor = cursorRaw ? JSON.parse(Buffer.from(cursorRaw, 'base64url').toString('utf8')) : null;
      } catch {
        return { ok: false, status: 400, data: { error: 'INVALID_CURSOR' } };
      }
      if (cursorRaw && (!cursor || typeof cursor.i !== 'number')) return { ok: false, status: 400, data: { error: 'INVALID_CURSOR' } };
      const desde = cursor ? (cursor.dentro ? cursor.i : Math.max(0, cursor.i - srv.solape)) : 0;
      const ids = srv.log.slice(desde, desde + srv.pagina);
      const hayMas = desde + srv.pagina < srv.log.length;
      const fin = desde + ids.length;
      const respuesta = {
        ok: true,
        status: 200,
        data: {
          ok: true,
          pesajes: ids.map((id) => structuredClone(srv.filas.find((f) => f.pesajeId === id))),
          hayMas,
          completo: !cursor,
          cursorSiguiente: Buffer.from(JSON.stringify({ i: fin, dentro: hayMas }), 'utf8').toString('base64url'),
          totales: hayMas ? null : { pesajes: srv.filas.length, anulados: srv.filas.filter((f) => f.estadoRegistro === 'ANULADO').length },
          organizacionId: srv.sesion.organizacionActiva.organizacionId,
          cuentaId: srv.sesion.cuenta.cuentaId,
        },
      };
      return respuesta;
    },
  };
  return srv;
}

function transporte(srv) {
  return {
    async postJson(pathname, body) {
      srv.posts.push({ pathname, body: structuredClone(body), cuenta: srv.sesion.cuenta?.cuentaId ?? null });
      await srv.alEnviar?.(pathname, body);
      const falla = srv.falla?.(pathname, body);
      if (falla === 'red') throw new TypeError('Failed to fetch');
      if (falla === 'no-enviada') return { ok: false, status: 0, failure: 'REQUEST_NOT_SENT', data: null };
      if (falla === 'red-tras-guardar') {
        srv.responder(pathname, body);
        throw new TypeError('Failed to fetch');
      }
      if (falla) return { ok: false, ...falla };
      return srv.responder(pathname, body);
    },
    async getJson(pathname) {
      srv.gets.push(pathname);
      if (pathname === SESSION_PATH) return { ok: true, status: 200, data: srv.sesion };
      if (pathname.startsWith('/api/ganaderia/sync/pull')) {
        return { ok: true, status: 200, data: { organizacionId: ORG, cursor: 'c', completo: false, animales: [], chapetas: [], predios: [], potreros: [], razas: [], categorias: [] } };
      }
      if (pathname.startsWith(SYNC_PESAJES)) {
        const cursor = new URL(pathname, 'http://x').searchParams.get('cursor');
        const respuesta = srv.paginaPesajes(cursor);
        srv.trasPagina?.();
        return respuesta;
      }
      return { ok: false, status: 404, data: { error: 'NOT_FOUND' } };
    },
  };
}

function dispositivo({ storage = createMemoryStorage(ORG_STORES) } = {}) {
  const clock = reloj();
  const repo = createLocalRepo(storage, { organizacionId: ORG, deviceId: 'd-1', now: clock.now, uuid: contadorUuid() });
  return { storage, clock, repo };
}

const motor = (d, srv, extra = {}) => createSyncEngine({ repo: d.repo, transport: transporte(srv), now: d.clock.now, random: () => 0.5, ...extra });
const body = (n, fecha = '2026-11-10', pesoKg = 300) => ({ fecha, pesoKg, metodo: 'BASCULA', clientOperationId: ID(n) });
const crear = (d, n, { animalId = '7', fecha, pesoKg, cuentaId = CUENTA_A } = {}) => d.repo.registrarPesajeLocal({ animalId, body: body(n, fecha, pesoKg), cuentaId });
const anular = (d, datos) => d.repo.encolarAnulacionPesaje({ animalId: '7', motivo: 'Error de báscula', cuentaId: CUENTA_A, rol: 'admin', ...datos });
const postsA = (srv, re) => srv.posts.filter((p) => re.test(p.pathname));
const filaLocal = (fila) => proyectarPesajeSync({ organizacionId: ORG, metodo: 'BASCULA', origen: 'MANUAL', observaciones: null, createdAt: '2026-10-01T10:00:00.000Z', estadoRegistro: 'ACTIVO', anulacion: null, clientOperationId: null, anulacionClientOperationId: null, ...fila }, ORG);

/** Página de /sync/pesajes construida a mano. */
const pagina = (pesajes, extra = {}) => ({
  ok: true, pesajes, hayMas: false, completo: true, cursorSiguiente: 'cur-1', totales: { pesajes: pesajes.length, anulados: pesajes.filter((p) => p.estadoRegistro === 'ANULADO').length },
  organizacionId: ORG, cuentaId: CUENTA_A, ...extra,
});
const filaSync = (fila) => ({ organizacionId: ORG, metodo: 'BASCULA', origen: 'MANUAL', observaciones: null, createdAt: '2026-10-01T10:00:00.000Z', estadoRegistro: 'ACTIVO', anulacion: null, clientOperationId: null, anulacionClientOperationId: null, ...fila });

/** CREATE legacy tal como lo guardaba 1D.1 (sin claveOrden, origen ni posibleEnServidor). */
function opLegacy(n, { animalId = '7', estado = OUTBOX_ESTADOS.PENDIENTE } = {}) {
  return {
    ...newOperation({
      tipoOperacion: PESAJE_CREAR, entidad: 'pesaje', localUuid: `l-${n}`, clientOperationId: ID(n),
      payload: { animalId, fecha: '2026-11-01', pesoKg: 280, metodo: 'BASCULA', observaciones: null, clientOperationId: ID(n) },
      deviceId: 'd-0', now: new Date('2026-11-01T00:00:00.000Z'), uuid: () => `legacy-${n}`,
    }),
    estado,
  };
}

// ---------------------------------------------------------------------------------
// 1-2. IndexedDB v3
// ---------------------------------------------------------------------------------

test('1. upgrade IndexedDB v2 -> v3: conserva outbox, meta, animales y reproducción; agrega pesajes', async () => {
  assert.equal(ORG_DB_VERSION, 3);
  const { pesajes: _nuevo, ...STORES_V2 } = ORG_STORES;
  const idb = new IDBFactory();
  const nombre = orgDbName(ORG);
  const opV2 = newOperation({ tipoOperacion: REPRODUCCION_EVENTO_CREAR, entidad: 'reproduccion_evento', localUuid: 'l-r', clientOperationId: ID(900), payload: { animalId: '7', evento: { tipoEvento: 'CELO_OBSERVADO', fechaEvento: '2026-10-01' } }, deviceId: 'd-1', now: new Date('2026-10-01T00:00:00.000Z'), uuid: () => 'op-r', claveOrden: claveOrdenAnimal('7'), origen: { organizacionId: ORG, cuentaId: CUENTA_A } });
  const legacy = opLegacy(901);
  const meta = { key: 'sync', organizacionId: ORG, cursor: 'c-v2', reproduccionCursor: 'r-v2', preparadoAt: '2026-09-01T00:00:00.000Z' };
  const v2 = await openIndexedDb(idb, nombre, 2, STORES_V2);
  await createIndexedDbStorage(v2).batch([
    { op: 'put', store: 'outbox', value: opV2 },
    { op: 'put', store: 'outbox', value: legacy },
    { op: 'put', store: 'meta', value: meta },
    { op: 'put', store: 'animales', value: { key: 'srv:7', animalId: '7', ultimoPeso: { pesoKg: 280, fecha: '2026-11-01', metodo: 'BASCULA' } } },
    { op: 'put', store: 'reproduccion_eventos', value: { eventoId: '1', animalId: '7', clientOperationId: ID(1) } },
  ]);
  v2.close();

  const db = await openIndexedDb(idb, nombre, ORG_DB_VERSION, ORG_STORES);
  assert.equal(db.version, 3);
  assert.deepEqual([...db.objectStoreNames].sort(), Object.keys(ORG_STORES).sort());
  const tx = db.transaction(['pesajes', 'outbox'], 'readonly');
  assert.deepEqual([...tx.objectStore('pesajes').indexNames].sort(), ['animalId', 'anulacionClientOperationId', 'clientOperationId']);
  assert.equal(tx.objectStore('pesajes').keyPath, 'pesajeId');
  assert.ok(tx.objectStore('outbox').indexNames.contains('claveOrden'));
  const storage = createIndexedDbStorage(db);
  assert.deepEqual(await storage.get('outbox', 'op-r'), opV2);
  assert.deepEqual(await storage.get('outbox', 'legacy-901'), legacy);
  assert.deepEqual(await storage.get('meta', 'sync'), meta);
  assert.equal((await storage.get('animales', 'srv:7')).ultimoPeso.pesoKg, 280);
  assert.equal((await storage.getAll('reproduccion_eventos')).length, 1);
  assert.deepEqual(await storage.getAll('pesajes'), []);
  // El legacy sigue siendo legacy: el upgrade no le inventa identidad ni cadena.
  assert.equal(esPesajeCrearLegacy(await storage.get('outbox', 'legacy-901')), true);
  await storage.close();
  // Reabrir v3 es idempotente.
  const otra = createIndexedDbStorage(await openIndexedDb(idb, nombre, ORG_DB_VERSION, ORG_STORES));
  assert.equal((await otra.getAll('outbox')).length, 2);
  await otra.close();
});

test('2. store pesajes (IndexedDB): clave pesajeId e índices animalId / clientOperationId / anulacionClientOperationId', async () => {
  const storage = createIndexedDbStorage(await openIndexedDb(new IDBFactory(), orgDbName(ORG), ORG_DB_VERSION, ORG_STORES));
  await storage.batch([
    { op: 'put', store: 'pesajes', value: filaLocal({ pesajeId: '1', animalId: '7', fecha: '2026-10-01', pesoKg: 300, clientOperationId: ID(1) }) },
    { op: 'put', store: 'pesajes', value: filaLocal({ pesajeId: '2', animalId: '8', fecha: '2026-10-01', pesoKg: 310, estadoRegistro: 'ANULADO', anulacion: { anuladoEn: 'x', motivo: 'm' }, anulacionClientOperationId: ID(50) }) },
  ]);
  assert.deepEqual((await storage.getAllByIndex('pesajes', 'animalId', '7')).map((p) => p.pesajeId), ['1']);
  assert.deepEqual((await storage.getAllByIndex('pesajes', 'clientOperationId', ID(1))).map((p) => p.pesajeId), ['1']);
  assert.deepEqual((await storage.getAllByIndex('pesajes', 'anulacionClientOperationId', ID(50))).map((p) => p.pesajeId), ['2']);
  const fila = await storage.get('pesajes', '2');
  assert.deepEqual(Object.keys(fila).sort(), ['anulacion', 'anulacionClientOperationId', 'animalId', 'clientOperationId', 'createdAt', 'estadoRegistro', 'fecha', 'metodo', 'observaciones', 'organizacionId', 'origen', 'pesajeId', 'pesoKg'].sort());
  await storage.close();
});

test('2b. contrato local: nunca guarda actor, anulado_por ni campos ajenos al sync', () => {
  const p = proyectarPesajeSync(filaSync({ pesajeId: '5', animalId: '7', fecha: '2026-10-01', pesoKg: 300, anuladoPor: 'x', anulado_por: 'y', actorCuentaId: 'z' }), ORG);
  assert.equal('anuladoPor' in p || 'anulado_por' in p || 'actorCuentaId' in p, false);
  assert.throws(() => proyectarPesajeSync(filaSync({ pesajeId: '5', animalId: '7', fecha: '2026-10-01', pesoKg: 300, organizacionId: OTRA_ORG }), ORG), { code: 'ORGANIZACION_DISTINTA' });
});

// ---------------------------------------------------------------------------------
// 3-9. Pull
// ---------------------------------------------------------------------------------

test('3/4. upsert ACTIVO y luego ACTIVO -> ANULADO; un dato viejo nunca retrocede ANULADO -> ACTIVO', async () => {
  const d = dispositivo();
  const activo = filaSync({ pesajeId: '10', animalId: '7', fecha: '2026-10-01', pesoKg: 300, clientOperationId: ID(10) });
  await d.repo.aplicarPullPesajes(pagina([activo]));
  assert.equal((await d.storage.get('pesajes', '10')).estadoRegistro, 'ACTIVO');
  const anulado = { ...activo, estadoRegistro: 'ANULADO', anulacion: { anuladoEn: '2026-11-01T00:00:00.000Z', motivo: 'Error' }, anulacionClientOperationId: ID(11) };
  await d.repo.aplicarPullPesajes(pagina([anulado]));
  let local = await d.storage.get('pesajes', '10');
  assert.equal(local.estadoRegistro, 'ANULADO');
  assert.deepEqual(local.anulacion, { anuladoEn: '2026-11-01T00:00:00.000Z', motivo: 'Error' });
  assert.equal(local.anulacionClientOperationId, ID(11));
  await d.repo.aplicarPullPesajes(pagina([activo], { totales: { pesajes: 1, anulados: 1 } }));
  local = await d.storage.get('pesajes', '10');
  assert.equal(local.estadoRegistro, 'ANULADO', 'el solape con datos viejos no desanula');
  assert.equal(local.clientOperationId, ID(10));
  assert.equal(fusionarPesaje(local, { ...local, estadoRegistro: 'ACTIVO' }), local);
});

test('5. dedupe por pesajeId dentro de una página y entre páginas', async () => {
  const d = dispositivo();
  const a = filaSync({ pesajeId: '1', animalId: '7', fecha: '2026-10-01', pesoKg: 300 });
  const aAnulado = { ...a, estadoRegistro: 'ANULADO', anulacion: { anuladoEn: 'x', motivo: 'm' } };
  await d.repo.aplicarPullPesajes(pagina([aAnulado, a, a], { totales: { pesajes: 1, anulados: 1 } }));
  await d.repo.aplicarPullPesajes(pagina([a], { totales: { pesajes: 1, anulados: 1 } }));
  const todos = await d.storage.getAll('pesajes');
  assert.equal(todos.length, 1);
  assert.equal(todos[0].estadoRegistro, 'ANULADO');
});

test('6. cursorSiguiente: se persiste y el siguiente GET lo usa; una página sin cursorSiguiente se rechaza', async () => {
  const d = dispositivo();
  const srv = servidor();
  srv.sembrar({ pesajeId: '1', animalId: '7', fecha: '2026-10-01', pesoKg: 300 });
  await motor(d, srv).syncNow();
  const cursor = (await d.repo.getMeta()).pesajesCursor;
  assert.ok(cursor);
  srv.gets.length = 0;
  await motor(d, srv).syncNow();
  assert.ok(srv.gets.includes(`${SYNC_PESAJES}?cursor=${encodeURIComponent(cursor)}`));
  // El campo del contrato es cursorSiguiente, NO `cursor` como en reproducción.
  await assert.rejects(d.repo.aplicarPullPesajes({ ...pagina([]), cursorSiguiente: undefined, cursor: 'x' }), { code: 'PULL_PESAJES_INVALIDO' });
  assert.equal((await d.repo.getMeta()).pesajesCursor, cursor, 'una página inválida no mueve el cursor');
});

test('7. múltiples páginas: recorrido completo hasta hayMas=false y copia marcada completa', async () => {
  const d = dispositivo();
  const srv = servidor();
  srv.pagina = 2;
  for (let i = 1; i <= 5; i += 1) srv.sembrar({ pesajeId: String(i), animalId: '7', fecha: `2026-10-0${i}`, pesoKg: 300 + i });
  assert.equal(await motor(d, srv).syncNow(), RUN_RESULT.OK);
  assert.equal(srv.gets.filter((g) => g.startsWith(SYNC_PESAJES)).length, 3);
  assert.equal((await d.storage.getAll('pesajes')).length, 5);
  const meta = await d.repo.getMeta();
  assert.ok(meta.pesajesListaAt);
  assert.ok(meta.pesajesSyncAt);
  assert.equal(meta.pesajesUltimoError ?? null, null);
});

test('8. solape entre recorridos: las filas repetidas no se duplican', async () => {
  const d = dispositivo();
  const srv = servidor();
  srv.solape = 3;
  for (let i = 1; i <= 4; i += 1) srv.sembrar({ pesajeId: String(i), animalId: '7', fecha: `2026-10-0${i}`, pesoKg: 300 + i });
  await motor(d, srv).syncNow();
  srv.sembrar({ pesajeId: '5', animalId: '7', fecha: '2026-10-05', pesoKg: 305 });
  await motor(d, srv).syncNow();
  const ultimaPagina = srv.paginaPesajes((await d.repo.getMeta()).pesajesCursor);
  assert.ok(ultimaPagina.data.pesajes.length > 0, 'el servidor vuelve a enviar filas por el solape');
  await d.repo.aplicarPullPesajes(ultimaPagina.data);
  assert.deepEqual((await d.storage.getAll('pesajes')).map((p) => p.pesajeId).sort(), ['1', '2', '3', '4', '5']);
  assert.ok((await d.repo.getMeta()).pesajesListaAt);
});

test('9. cambio de sesión durante el pull: la página de otra cuenta no se aplica y el cursor no avanza', async () => {
  const d = dispositivo();
  const srv = servidor();
  srv.pagina = 1;
  srv.sembrar({ pesajeId: '1', animalId: '7', fecha: '2026-10-01', pesoKg: 300 });
  srv.sembrar({ pesajeId: '2', animalId: '7', fecha: '2026-10-02', pesoKg: 301 });
  let paginas = 0;
  srv.trasPagina = () => {
    paginas += 1;
    if (paginas === 1) srv.sesion = sesionDe(CUENTA_B);
  };
  const cursorTrasPrimera = [];
  const original = d.repo.aplicarPullPesajes.bind(d.repo);
  d.repo.aplicarPullPesajes = async (...args) => {
    const r = await original(...args);
    cursorTrasPrimera.push((await d.repo.getMeta()).pesajesCursor);
    return r;
  };
  await motor(d, srv).syncNow();
  assert.deepEqual((await d.storage.getAll('pesajes')).map((p) => p.pesajeId), ['1']);
  const meta = await d.repo.getMeta();
  assert.equal(meta.pesajesUltimoError.codigo, 'SESION_CAMBIADA');
  assert.equal(meta.pesajesCursor, cursorTrasPrimera[0]);
  assert.equal(meta.pesajesListaAt ?? null, null);
  // Otra organización: nada se escribe.
  await assert.rejects(d.repo.aplicarPullPesajes(pagina([filaSync({ pesajeId: '9', animalId: '7', fecha: '2026-10-09', pesoKg: 1 })], { organizacionId: OTRA_ORG })), { code: 'ORGANIZACION_DISTINTA' });
  assert.equal(await d.storage.get('pesajes', '9'), undefined);
});

test('9b. el pull de pesajes nunca cambia el resultado del ciclo (endpoint caído)', async () => {
  const d = dispositivo();
  const srv = servidor();
  const t = transporte(srv);
  const get = t.getJson.bind(t);
  t.getJson = async (p) => (p.startsWith(SYNC_PESAJES) ? { ok: false, status: 503, data: { error: 'X' } } : get(p));
  assert.equal(await createSyncEngine({ repo: d.repo, transport: t, now: d.clock.now }).syncNow(), RUN_RESULT.OK);
  assert.equal((await d.repo.getMeta()).pesajesUltimoError.status, 503);
});

test('9c. INVALID_CURSOR reinicia el recorrido una vez; desfase de totales vuelve a recorrer y la copia deja de ser completa', async () => {
  const d = dispositivo();
  const srv = servidor();
  srv.sembrar({ pesajeId: '1', animalId: '7', fecha: '2026-10-01', pesoKg: 300 });
  await d.repo.putMeta({ pesajesCursor: 'basura' });
  await motor(d, srv).syncNow();
  assert.equal((await d.storage.getAll('pesajes')).length, 1);
  assert.ok((await d.repo.getMeta()).pesajesListaAt);
  const r = await d.repo.aplicarPullPesajes(pagina([], { totales: { pesajes: 7, anulados: 0 } }));
  assert.equal(r.desfase, true);
  const meta = await d.repo.getMeta();
  assert.equal(meta.pesajesCursor, null);
  assert.equal(meta.pesajesListaAt, null);
});

// ---------------------------------------------------------------------------------
// 10-16. CREATE v2, FIFO, identidad, cancelación y legacy
// ---------------------------------------------------------------------------------

test('10. CREATE v2: claveOrden pesaje:animal, origen, posibleEnServidor y POST con identidadEsperada', async () => {
  const d = dispositivo();
  const srv = servidor();
  const r = await crear(d, 1);
  const op = await d.storage.get('outbox', r.operationId);
  assert.equal(op.tipoOperacion, PESAJE_CREAR);
  assert.equal(op.claveOrden, claveOrdenPesajes('7'));
  assert.equal(op.claveOrden, 'pesaje:animal:7');
  assert.deepEqual(op.origen, { organizacionId: ORG, cuentaId: CUENTA_A });
  assert.equal(op.posibleEnServidor, false);
  assert.equal(op.runtimeNoSoporta, null);
  assert.equal(op.clientOperationId, ID(1));
  assert.equal(esPesajeCrearLegacy(op), false);
  assert.equal(r.pendiente.posibleEnServidor, false);
  let antesDelPost = null;
  srv.alEnviar = async () => { antesDelPost = await d.storage.get('outbox', r.operationId); };
  await motor(d, srv).syncNow();
  assert.equal(antesDelPost.posibleEnServidor, true, 'se persiste ANTES del POST');
  assert.equal(antesDelPost.estado, OUTBOX_ESTADOS.SINCRONIZANDO);
  assert.deepEqual(srv.posts[0].body, { fecha: '2026-11-10', pesoKg: 300, metodo: 'BASCULA', clientOperationId: ID(1), identidadEsperada: { organizacionId: ORG, cuentaId: CUENTA_A } });
  assert.deepEqual(await d.repo.listOutbox(), []);
  const confirmado = await d.storage.get('pesajes', '101');
  assert.equal(confirmado.clientOperationId, ID(1));
  assert.equal(confirmado.animalId, '7');
  assert.equal(confirmado.estadoRegistro, 'ACTIVO');
  // Doble clic: misma intención, una sola operación.
  const d2 = dispositivo();
  await crear(d2, 2);
  assert.equal((await crear(d2, 2)).yaEncolado, true);
  assert.equal((await d2.repo.listOutbox()).length, 1);
});

test('11. FIFO CREATE1, CREATE2, ANULAR del mismo animal: orden estable y una que no sale detiene la cadena', async () => {
  const d = dispositivo();
  const srv = servidor();
  const previo = srv.sembrar({ pesajeId: '50', animalId: '7', fecha: '2026-10-01', pesoKg: 290 });
  await d.repo.aplicarPullPesajes(pagina([previo]));
  await crear(d, 1, { fecha: '2026-11-01' });
  await crear(d, 2, { fecha: '2026-11-02' });
  await anular(d, { pesajeId: '50', clientOperationId: ID(3) });
  const cadena = await d.repo.cadenaPesajes('7');
  assert.deepEqual(cadena.map((op) => op.clientOperationId), [ID(1), ID(2), ID(3)]);
  assert.ok(new Set(cadena.map((op) => op.createdAt)).size === 3, 'instantes estrictamente crecientes');
  // CREATE1 en conflicto -> nada más de ese animal sale.
  srv.falla = (p, b) => (b.clientOperationId === ID(1) ? { status: 409, data: { error: 'ANIMAL_YA_SALIDO' } } : null);
  await motor(d, srv).syncNow();
  assert.deepEqual(srv.posts.map((p) => p.body.clientOperationId), [ID(1)]);
  // Resuelto: el orden se mantiene.
  srv.falla = null;
  srv.posts.length = 0;
  await d.repo.storage.mutate('outbox', cadena[0].operationId, (op) => ({ ...op, estado: OUTBOX_ESTADOS.PENDIENTE, ultimoError: null }));
  await motor(d, srv).syncNow();
  assert.deepEqual(srv.posts.map((p) => p.body.clientOperationId), [ID(1), ID(2), ID(3)]);
  assert.match(srv.posts[2].pathname, /\/animales\/7\/pesajes\/50\/anular$/);
  assert.deepEqual(srv.posts[2].body, { motivo: 'Error de báscula', clientOperationId: ID(3), identidadEsperada: { organizacionId: ORG, cuentaId: CUENTA_A } });
  assert.equal((await d.storage.get('pesajes', '50')).estadoRegistro, 'ANULADO');
  assert.deepEqual(await d.repo.listOutbox(), []);
});

test('12. animales distintos avanzan independientes', async () => {
  const d = dispositivo();
  const srv = servidor();
  await crear(d, 1, { animalId: '7' });
  await crear(d, 2, { animalId: '7' });
  await crear(d, 3, { animalId: '8' });
  srv.falla = (p) => (p.includes('/animales/7/') ? { status: 409, data: { error: 'ANIMAL_YA_MUERTO' } } : null);
  await motor(d, srv).syncNow();
  assert.deepEqual(srv.posts.map((p) => p.body.clientOperationId), [ID(1), ID(3)]);
  const restantes = await d.repo.listOutbox();
  assert.deepEqual(restantes.map((op) => op.clientOperationId).sort(), [ID(1), ID(2)]);
});

test('13. identidad distinta -> BLOQUEADA_POR_IDENTIDAD sin POST (CREATE y ANULAR); vuelve con su cuenta', async () => {
  const d = dispositivo();
  const srv = servidor();
  await d.repo.aplicarPullPesajes(pagina([filaSync({ pesajeId: '60', animalId: '8', fecha: '2026-10-01', pesoKg: 300 })]));
  srv.sembrar({ pesajeId: '60', animalId: '8', fecha: '2026-10-01', pesoKg: 300 });
  const c = await crear(d, 1);
  const a = await d.repo.encolarAnulacionPesaje({ animalId: '8', pesajeId: '60', motivo: 'x', clientOperationId: ID(2), cuentaId: CUENTA_A, rol: 'owner' });
  srv.sesion = sesionDe(CUENTA_B);
  await motor(d, srv).syncNow();
  assert.equal(srv.posts.length, 0);
  assert.equal((await d.storage.get('outbox', c.operationId)).estado, OUTBOX_ESTADOS.BLOQUEADA_POR_IDENTIDAD);
  assert.equal((await d.storage.get('outbox', a.operationId)).estado, OUTBOX_ESTADOS.BLOQUEADA_POR_IDENTIDAD);
  assert.equal((await d.storage.get('outbox', c.operationId)).posibleEnServidor, false, 'nunca salió');
  // Otra organización activa: tampoco.
  srv.sesion = sesionDe(CUENTA_A, OTRA_ORG);
  await motor(d, srv).syncNow();
  assert.equal(srv.posts.length, 0);
  // La cuenta original vuelve: salen las dos, sin adoptar nada.
  srv.sesion = sesionDe(CUENTA_A);
  await motor(d, srv).syncNow();
  assert.equal(srv.posts.length, 2);
  assert.ok(srv.posts.every((p) => p.cuenta === CUENTA_A));
  // La cuenta B no puede cancelar lo de A.
  const otra = await crear(d, 3);
  await assert.rejects(d.repo.cancelarPesajePendiente(otra.operationId, { cuentaId: CUENTA_B }), { code: OUTBOX_ESTADOS.BLOQUEADA_POR_IDENTIDAD });
});

test('14. Caso 1: CREATE nunca enviado (posibleEnServidor=false) -> cancelación local, 0 POST, sin anulación ficticia', async () => {
  const d = dispositivo();
  const srv = servidor();
  const r = await crear(d, 1);
  assert.equal(pesajeCrearCancelableSeguro(await d.storage.get('outbox', r.operationId)), true);
  // Pedir anularlo no encola nada: debe cancelarse.
  await assert.rejects(anular(d, { pesajeRef: { clientOperationId: ID(1) }, clientOperationId: ID(2) }), { code: 'PESAJE_CANCELABLE_LOCALMENTE' });
  const res = await d.repo.cancelarPesajePendiente(r.operationId, { cuentaId: CUENTA_A });
  assert.equal(res.cancelado, true);
  assert.deepEqual(await d.repo.listOutbox(), []);
  assert.deepEqual(await d.storage.getAll('pesajes'), []);
  await motor(d, srv).syncNow();
  assert.equal(srv.posts.length, 0);
  // El clientOperationId del CREATE cancelado no se reutiliza nunca.
  await assert.rejects(crear(d, 1), { code: 'OPERACION_CANCELADA' });
  assert.deepEqual(await d.repo.listOutbox(), []);
  // Una petición no enviada (REQUEST_NOT_SENT) tampoco la vuelve incierta.
  const r2 = await crear(d, 5);
  srv.falla = () => 'no-enviada';
  await motor(d, srv).syncNow();
  assert.equal((await d.storage.get('outbox', r2.operationId)).posibleEnServidor, false);
  await d.repo.cancelarPesajePendiente(r2.operationId, { cuentaId: CUENTA_A });
});

test('15. Caso 2: posibleEnServidor=true no se cancela; ANULAR dependiente FIFO: CREATE -> pesajeId -> ANULAR', async () => {
  const d = dispositivo();
  const srv = servidor();
  const r = await crear(d, 1);
  srv.falla = () => 'red-tras-guardar';
  assert.equal(await motor(d, srv).syncNow(), RUN_RESULT.OFFLINE);
  const op = await d.storage.get('outbox', r.operationId);
  assert.equal(op.posibleEnServidor, true);
  await assert.rejects(d.repo.cancelarPesajePendiente(r.operationId, { cuentaId: CUENTA_A }), { code: 'PESAJE_ENVIO_INCIERTO' });
  const a = await anular(d, { pesajeRef: { clientOperationId: ID(1) }, clientOperationId: ID(2) });
  assert.equal(a.diferida, true);
  assert.equal(a.operationId, `pesaje-anular:ref:${ID(1)}`);
  const diferida = await d.storage.get('outbox', a.operationId);
  assert.equal(diferida.claveOrden, 'pesaje:animal:7');
  assert.equal(diferida.payload.pesajeId, null);
  assert.equal(await handlerDe(PESAJE_ANULAR).request(diferida, d.repo), null, 'no sale sin pesajeId');
  // Sin bucle: la diferida sin resolver no cuenta como "en turno" para los disparadores.
  assert.deepEqual(operacionesEnTurno([diferida]), []);
  // Con dependiente, ni siquiera la cancelación segura borra el CREATE.
  await assert.rejects(d.repo.cancelarPesajePendiente(r.operationId, { cuentaId: CUENTA_A }), { code: 'PESAJE_ENVIO_INCIERTO' });
  srv.falla = null;
  srv.posts.length = 0;
  d.clock.avanzar(60_000); // reintento fijo tras fallo de red
  await motor(d, srv).syncNow();
  assert.deepEqual(srv.posts.map((p) => p.pathname), ['/api/ganaderia/animales/7/pesajes', '/api/ganaderia/animales/7/pesajes/101/anular']);
  assert.equal(srv.filas.length, 1, 'el reenvío del CREATE fue idempotente (yaExistia)');
  const local = await d.storage.get('pesajes', '101');
  assert.equal(local.estadoRegistro, 'ANULADO');
  assert.equal(local.clientOperationId, ID(1));
  assert.equal(local.anulacionClientOperationId, ID(2));
  assert.deepEqual(await d.repo.listOutbox(), []);
});

test('16. CREATE legacy incierto: nunca cancelable, sin identidad inventada; ANULAR espera a confirmarlo', async () => {
  const d = dispositivo();
  const srv = servidor();
  const legacy = opLegacy(1);
  await d.storage.put('outbox', legacy);
  assert.equal(esPesajeCrearLegacy(legacy), true);
  assert.equal(pesajeCrearCancelableSeguro(legacy), false);
  assert.equal((await d.repo.listPesajesPendientes('7'))[0].posibleEnServidor, null);
  assert.equal((await d.repo.listPesajesPendientes('7'))[0].legacy, true);
  await assert.rejects(d.repo.cancelarPesajePendiente(legacy.operationId, { cuentaId: CUENTA_A }), { code: 'PESAJE_ENVIO_INCIERTO' });
  // intentos = 0 tampoco prueba nada: sigue incierto.
  assert.equal(legacy.intentos, 0);
  const a = await anular(d, { pesajeRef: { clientOperationId: ID(1) }, clientOperationId: ID(2) });
  assert.equal(a.diferida, true);
  // El legacy no recibe origen ni cadena retroactivamente.
  const tras = await d.storage.get('outbox', legacy.operationId);
  assert.equal(tras.origen, undefined);
  assert.equal(tras.claveOrden, undefined);
  // Primero se intenta confirmar por el servidor: el pull trae su fila exacta.
  srv.sembrar({ pesajeId: '77', animalId: '7', fecha: '2026-11-01', pesoKg: 280, clientOperationId: ID(1) });
  srv.falla = (p) => (p.endsWith('/pesajes') ? { status: 503, data: { error: 'X' } } : null);
  await motor(d, srv).syncNow();
  // 503 en el CREATE legacy corta el push; el pull no corre: nada se borra.
  assert.equal((await d.storage.get('outbox', legacy.operationId)).tipoOperacion, PESAJE_CREAR);
  const pull = srv.paginaPesajes(null).data;
  await d.repo.aplicarPullPesajes(pull);
  assert.equal(await d.storage.get('outbox', legacy.operationId), undefined, 'conciliado por su clientOperationId exacto');
  const resuelta = await d.storage.get('outbox', a.operationId);
  assert.equal(resuelta.payload.pesajeId, '77', 'la confirmación del CREATE resuelve la diferida');
  assert.deepEqual(resuelta.payload.pesajeRef, { clientOperationId: ID(1) });
  assert.deepEqual(operacionesEnTurno([resuelta]).map((op) => op.operationId), [a.operationId], 'y queda en turno para salir');
  assert.equal(await d.repo.resolverPesajeIdDeAnulacion(resuelta), '77');
  srv.falla = null;
  srv.posts.length = 0;
  d.clock.avanzar(60 * 60_000);
  await motor(d, srv).syncNow();
  assert.deepEqual(srv.posts.map((p) => p.pathname), ['/api/ganaderia/animales/7/pesajes/77/anular']);
  assert.equal((await d.storage.get('pesajes', '77')).estadoRegistro, 'ANULADO');
});

test('16b. CREATE legacy sigue sincronizando como antes: sin identidadEsperada ni verificación de sesión', async () => {
  const d = dispositivo();
  const srv = servidor();
  await d.storage.put('outbox', opLegacy(1));
  await motor(d, srv).syncNow();
  assert.equal(srv.posts.length, 1);
  assert.equal('identidadEsperada' in srv.posts[0].body, false);
  assert.equal(srv.gets.includes(SESSION_PATH), false);
  assert.deepEqual(await d.repo.listOutbox(), []);
  assert.equal((await d.storage.get('pesajes', '101')).clientOperationId, ID(1));
});

// ---------------------------------------------------------------------------------
// 17-22. Conciliación exacta
// ---------------------------------------------------------------------------------

async function createIncierto(d, n, extra = {}) {
  const r = await crear(d, n, extra);
  await d.storage.mutate('outbox', r.operationId, (op) => ({ ...op, estado: OUTBOX_ESTADOS.ERROR_REINTENTABLE, posibleEnServidor: true, ultimoError: { codigo: 'NETWORK_ERROR', status: 0, tipo: 'red' } }));
  return r;
}

test('17. CREATE conciliado por clientOperationId exacto (sin POST)', async () => {
  const d = dispositivo();
  const r = await createIncierto(d, 1);
  await d.repo.aplicarPullPesajes(pagina([filaSync({ pesajeId: '200', animalId: '7', fecha: '2026-11-10', pesoKg: 300, clientOperationId: ID(1) })]));
  assert.equal(await d.storage.get('outbox', r.operationId), undefined);
  assert.equal(filaConfirmaCreate({ tipoOperacion: PESAJE_CREAR, clientOperationId: ID(1), payload: { animalId: '7' } }, { clientOperationId: ID(1), animalId: '7', pesajeId: '200' }), true);
});

test('18. CREATE: otro clientOperationId (aunque coincidan animal, fecha y peso) u otro animal no concilian', async () => {
  const d = dispositivo();
  const r = await createIncierto(d, 1);
  await d.repo.aplicarPullPesajes(pagina([
    filaSync({ pesajeId: '200', animalId: '7', fecha: '2026-11-10', pesoKg: 300, clientOperationId: ID(99) }),
    filaSync({ pesajeId: '201', animalId: '7', fecha: '2026-11-10', pesoKg: 300, clientOperationId: null }),
  ]));
  assert.ok(await d.storage.get('outbox', r.operationId));
  await d.repo.aplicarPullPesajes(pagina([filaSync({ pesajeId: '202', animalId: '8', fecha: '2026-11-10', pesoKg: 300, clientOperationId: ID(1) })], { totales: { pesajes: 3, anulados: 0 } }));
  assert.ok(await d.storage.get('outbox', r.operationId), 'mismo clientOperationId en otro animal: no se cierra');
  // De otra cuenta: tampoco se adopta.
  const d2 = dispositivo();
  const r2 = await createIncierto(d2, 1);
  await d2.repo.aplicarPullPesajes(pagina([filaSync({ pesajeId: '200', animalId: '7', fecha: '2026-11-10', pesoKg: 300, clientOperationId: ID(1) })], { cuentaId: CUENTA_B }));
  assert.ok(await d2.storage.get('outbox', r2.operationId));
});

async function anularIncierta(d, n, { pesajeId = '300', motivo = 'Error de báscula' } = {}) {
  const r = await anular(d, { pesajeId, clientOperationId: ID(n), motivo });
  await d.storage.mutate('outbox', r.operationId, (op) => ({ ...op, estado: OUTBOX_ESTADOS.ERROR_REINTENTABLE, posibleEnServidor: true, ultimoError: { codigo: 'NETWORK_ERROR', status: 0, tipo: 'red' } }));
  return r;
}
const activo300 = filaSync({ pesajeId: '300', animalId: '7', fecha: '2026-10-01', pesoKg: 300, clientOperationId: ID(300) });
const anulado300 = (anulacionClientOperationId, motivo = 'Error de báscula', extra = {}) => ({ ...activo300, estadoRegistro: 'ANULADO', anulacion: { anuladoEn: '2026-11-18T00:00:00.000Z', motivo }, anulacionClientOperationId, ...extra });

test('19. ANULAR conciliada exacta: operationId, pesajeId, animalId, ANULADO y motivo', async () => {
  const d = dispositivo();
  await d.repo.aplicarPullPesajes(pagina([activo300]));
  const r = await anularIncierta(d, 5);
  await d.repo.aplicarPullPesajes(pagina([anulado300(ID(5))]));
  assert.equal(await d.storage.get('outbox', r.operationId), undefined);
  assert.equal((await d.storage.get('pesajes', '300')).estadoRegistro, 'ANULADO');
});

test('20. ANULAR: una anulación con OTRA operationId no cierra la pendiente; el POST termina en CONFLICTO', async () => {
  const d = dispositivo();
  const srv = servidor();
  srv.sembrar({ ...activo300 });
  await d.repo.aplicarPullPesajes(pagina([activo300]));
  const r = await anularIncierta(d, 5);
  srv.anularEnServidor('300', 'Error de báscula', ID(77));
  await d.repo.aplicarPullPesajes(pagina([anulado300(ID(77))]));
  assert.ok(await d.storage.get('outbox', r.operationId), 'no se cierra');
  d.clock.avanzar(60_000);
  await motor(d, srv).syncNow();
  const op = await d.storage.get('outbox', r.operationId);
  assert.equal(op.estado, OUTBOX_ESTADOS.CONFLICTO);
  assert.equal(op.ultimoError.codigo, 'PESAJE_YA_ANULADO');
});

test('21. ANULAR: motivo distinto no concilia', async () => {
  const d = dispositivo();
  await d.repo.aplicarPullPesajes(pagina([activo300]));
  const r = await anularIncierta(d, 5);
  await d.repo.aplicarPullPesajes(pagina([anulado300(ID(5), 'Otro motivo')]));
  assert.ok(await d.storage.get('outbox', r.operationId));
  assert.equal(filaConfirmaAnular(await d.storage.get('outbox', r.operationId), anulado300(ID(5), 'Otro motivo'), '300'), false);
  // Respuesta del POST con motivo distinto: CONFLICTO, nunca confirmación.
  const d2 = dispositivo();
  await d2.repo.aplicarPullPesajes(pagina([activo300]));
  const r2 = await anular(d2, { pesajeId: '300', clientOperationId: ID(6) });
  await d2.repo.confirmarAnulacionPesaje(await d2.storage.get('outbox', r2.operationId), { ...anulado300(ID(6), 'Otro') });
  assert.equal((await d2.storage.get('outbox', r2.operationId)).estado, OUTBOX_ESTADOS.CONFLICTO);
  assert.equal((await d2.storage.get('pesajes', '300')).estadoRegistro, 'ACTIVO');
});

test('22. ANULAR: animal o pesaje distintos no concilian', async () => {
  const d = dispositivo();
  await d.repo.aplicarPullPesajes(pagina([activo300]));
  const r = await anularIncierta(d, 5);
  const op = await d.storage.get('outbox', r.operationId);
  assert.equal(filaConfirmaAnular(op, anulado300(ID(5), 'Error de báscula', { pesajeId: '301' }), '300'), false);
  assert.equal(filaConfirmaAnular(op, anulado300(ID(5), 'Error de báscula', { animalId: '8' }), '300'), false);
  await d.repo.aplicarPullPesajes(pagina([anulado300(ID(5), 'Error de báscula', { pesajeId: '301' })], { totales: { pesajes: 2, anulados: 1 } }));
  assert.ok(await d.storage.get('outbox', r.operationId));
  await d.repo.aplicarPullPesajes(pagina([anulado300(ID(5), 'Error de báscula', { pesajeId: '302', animalId: '8' })], { totales: { pesajes: 3, anulados: 2 } }));
  assert.ok(await d.storage.get('outbox', r.operationId));
});

// ---------------------------------------------------------------------------------
// 23-26. posibleEnServidor y clasificación HTTP (política existente)
// ---------------------------------------------------------------------------------

test('23. timeout / red tras enviar -> posibleEnServidor=true (CREATE y ANULAR)', async () => {
  for (const falla of ['red', 'red-tras-guardar']) {
    const d = dispositivo();
    const srv = servidor();
    srv.sembrar({ ...activo300 });
    await d.repo.aplicarPullPesajes(pagina([activo300]));
    const c = await crear(d, 1, { animalId: '8' });
    const a = await anular(d, { pesajeId: '300', clientOperationId: ID(2) });
    srv.falla = () => falla;
    await motor(d, srv).syncNow();
    const op = await d.storage.get('outbox', c.operationId);
    assert.equal(op.posibleEnServidor, true, falla);
    assert.equal(op.ultimoError.tipo, 'red');
    assert.equal(op.intentos, 0, 'un fallo de red no suma intento');
    // La red cae: el ciclo termina y la ANULAR (de otra cadena) queda como estaba.
    assert.equal((await d.storage.get('outbox', a.operationId)).posibleEnServidor, false);
  }
});

for (const status of [408, 429, 500, 503]) {
  test(`24. ${status} -> ERROR_REINTENTABLE con backoff; ni un sync forzado lo adelanta`, async () => {
    const d = dispositivo();
    const srv = servidor();
    const c = await crear(d, 1);
    srv.falla = () => ({ status, data: { error: 'X' } });
    assert.equal(await motor(d, srv).syncNow(), RUN_RESULT.ERROR);
    const op = await d.storage.get('outbox', c.operationId);
    assert.equal(op.estado, OUTBOX_ESTADOS.ERROR_REINTENTABLE);
    assert.equal(op.ultimoError.tipo, 'http');
    assert.equal(op.posibleEnServidor, true);
    assert.ok(op.siguienteIntentoAt > d.clock.now().toISOString());
    srv.posts.length = 0;
    srv.falla = null;
    await motor(d, srv).syncNow({ forzar: true });
    assert.equal(srv.posts.length, 0, 'sin ráfaga durante el backoff');
    d.clock.avanzar(30 * 60_000);
    await motor(d, srv).syncNow();
    assert.equal(srv.posts.length, 1);
    assert.deepEqual(await d.repo.listOutbox(), []);
  });
}

for (const [status, error] of [[400, 'INVALID_PESO'], [403, 'ROLE_FORBIDDEN']]) {
  test(`25. ${status} ${error} -> RECHAZADO y detiene la cadena`, async () => {
    const d = dispositivo();
    const srv = servidor();
    const c = await crear(d, 1);
    await crear(d, 2);
    srv.falla = (p, b) => (b.clientOperationId === ID(1) ? { status, data: { error } } : null);
    await motor(d, srv).syncNow();
    assert.equal((await d.storage.get('outbox', c.operationId)).estado, OUTBOX_ESTADOS.RECHAZADO);
    assert.equal(srv.posts.length, 1);
  });
}

for (const [status, error] of [[404, 'PESAJE_NOT_FOUND'], [409, 'PESAJE_YA_ANULADO'], [410, 'GONE']]) {
  test(`26. ${status} ${error} -> CONFLICTO (ANULAR) con posibleEnServidor=false`, async () => {
    const d = dispositivo();
    const srv = servidor();
    await d.repo.aplicarPullPesajes(pagina([activo300]));
    const a = await anular(d, { pesajeId: '300', clientOperationId: ID(2) });
    srv.falla = () => ({ status, data: { error } });
    await motor(d, srv).syncNow();
    const op = await d.storage.get('outbox', a.operationId);
    assert.equal(op.estado, OUTBOX_ESTADOS.CONFLICTO);
    assert.equal(op.ultimoError.codigo, error);
    assert.equal(op.posibleEnServidor, false);
  });
}

test('26b. ANULAR: permiso anularPesaje obligatorio; motivo normalizado; una sola por pesaje', async () => {
  const d = dispositivo();
  await d.repo.aplicarPullPesajes(pagina([activo300]));
  for (const rol of ['operador', 'lector', null]) {
    await assert.rejects(anular(d, { pesajeId: '300', clientOperationId: ID(2), rol }), { code: 'ROLE_FORBIDDEN' });
  }
  await assert.rejects(anular(d, { pesajeId: '300', clientOperationId: ID(2), motivo: '   ' }), { code: 'INVALID_MOTIVO' });
  await assert.rejects(anular(d, { pesajeId: '300', clientOperationId: ID(2), motivo: 'x'.repeat(501) }), { code: 'INVALID_MOTIVO' });
  const r = await anular(d, { pesajeId: '300', clientOperationId: ID(2), motivo: '  Error\r\nde báscula ' });
  assert.equal(r.operationId, 'pesaje-anular:300');
  const op = await d.storage.get('outbox', r.operationId);
  assert.deepEqual(op.payload, { animalId: '7', pesajeId: '300', motivo: 'Error\nde báscula' });
  assert.equal('organizacionId' in op.payload || 'cuentaId' in op.payload, false, 'metadata fuera del payload');
  assert.equal((await anular(d, { pesajeId: '300', clientOperationId: ID(2), motivo: 'Error\nde báscula' })).yaEncolado, true);
  await assert.rejects(anular(d, { pesajeId: '300', clientOperationId: ID(3) }), { code: 'OPERACION_ADMINISTRATIVA_PENDIENTE' });
  await assert.rejects(anular(d, { pesajeId: '300', clientOperationId: ID(2), motivo: 'otro' }), { code: 'CLIENT_OPERATION_ID_REUSED' });
  // Ya anulado en la copia local: no se encola.
  const d2 = dispositivo();
  await d2.repo.aplicarPullPesajes(pagina([anulado300(ID(9))]));
  await assert.rejects(anular(d2, { pesajeId: '300', clientOperationId: ID(4) }), { code: 'PESAJE_YA_ANULADO' });
  // Cancelar una anulación nunca enviada; con posibleEnServidor se conserva.
  await d.repo.cancelarAnulacionPesajePendiente(r.operationId, { cuentaId: CUENTA_A });
  assert.deepEqual(await d.repo.listOutbox(), []);
});

// ---------------------------------------------------------------------------------
// 27-32. Último peso local
// ---------------------------------------------------------------------------------

async function conPesajes(filas, { animal = { key: 'srv:7', animalId: '7', ultimoPeso: { pesoKg: 999, fecha: '2026-01-01', metodo: 'ESTIMADO' } } } = {}) {
  const d = dispositivo();
  await d.storage.put('animales', animal);
  await d.repo.aplicarPullPesajes(pagina(filas.map((f) => filaSync({ animalId: '7', ...f }))));
  return d;
}

test('27. último peso con un pesaje', async () => {
  const d = await conPesajes([{ pesajeId: '1', fecha: '2026-10-01', pesoKg: 300 }]);
  const r = await d.repo.ultimoPesoLocal('7');
  assert.deepEqual(r.ultimoPeso, { pesoKg: 300, fecha: '2026-10-01', metodo: 'BASCULA', pesajeId: '1' });
  assert.equal(r.fuente, 'LOCAL');
});

test('28. último peso con varios días: el más reciente por fecha', async () => {
  const d = await conPesajes([
    { pesajeId: '9', fecha: '2026-10-01', pesoKg: 300 },
    { pesajeId: '2', fecha: '2026-11-01', pesoKg: 330 },
    { pesajeId: '5', fecha: '2026-10-15', pesoKg: 315 },
  ]);
  assert.equal((await d.repo.ultimoPesoLocal('7')).ultimoPeso.pesajeId, '2');
});

test('29. mismo día: gana el último pesajeId (determinista, sin pérdida de precisión)', async () => {
  const d = await conPesajes([
    { pesajeId: '10', fecha: '2026-11-01', pesoKg: 330 },
    { pesajeId: '9', fecha: '2026-11-01', pesoKg: 331 },
    { pesajeId: '11', fecha: '2026-11-01', pesoKg: 332 },
  ]);
  assert.equal((await d.repo.ultimoPesoLocal('7')).ultimoPeso.pesoKg, 332);
  const grandes = derivarUltimoPesoLocal({
    copiaCompleta: true,
    animal: { animalId: '7' },
    pesajes: [{ pesajeId: '9007199254740993', animalId: '7', fecha: '2026-11-01', pesoKg: 1 }, { pesajeId: '9007199254740992', animalId: '7', fecha: '2026-11-01', pesoKg: 2 }],
  });
  assert.equal(grandes.ultimoPeso.pesajeId, '9007199254740993');
});

test('30. el más reciente con ANULAR pendiente -> se usa el anterior (ejemplo 205 / 200)', async () => {
  const d = await conPesajes([
    { pesajeId: '1', fecha: '2026-10-01', pesoKg: 200 },
    { pesajeId: '2', fecha: '2026-11-01', pesoKg: 205 },
  ]);
  assert.equal((await d.repo.ultimoPesoLocal('7')).ultimoPeso.pesoKg, 205);
  const a = await anular(d, { pesajeId: '2', clientOperationId: ID(5) });
  let r = await d.repo.ultimoPesoLocal('7');
  assert.equal(r.ultimoPeso.pesoKg, 200);
  assert.deepEqual(r.excluidosPorAnulacion, ['2']);
  // Una anulación en CONFLICTO no es coherente: el pesaje vuelve a contar.
  await d.storage.mutate('outbox', a.operationId, (op) => ({ ...op, estado: OUTBOX_ESTADOS.CONFLICTO }));
  r = await d.repo.ultimoPesoLocal('7');
  assert.equal(r.ultimoPeso.pesoKg, 205);
  // No se toca la copia del animal.
  assert.equal((await d.storage.get('animales', 'srv:7')).updatedAt, undefined);
});

test('31. un pesaje confirmado ANULADO no participa; CREATE pendientes solo aparte y marcados', async () => {
  const d = await conPesajes([
    { pesajeId: '1', fecha: '2026-10-01', pesoKg: 200 },
    { pesajeId: '2', fecha: '2026-11-01', pesoKg: 205, estadoRegistro: 'ANULADO', anulacion: { anuladoEn: 'x', motivo: 'm' } },
  ]);
  await crear(d, 8, { fecha: '2026-11-15', pesoKg: 260 });
  const r = await d.repo.ultimoPesoLocal('7');
  assert.equal(r.ultimoPeso.pesoKg, 200, 'el pendiente nunca se mezcla con lo confirmado');
  assert.equal('pendientes' in r, false);
  const conPend = await d.repo.ultimoPesoLocal('7', { incluirPendientes: true });
  assert.equal(conPend.ultimoPeso.pesoKg, 200);
  assert.deepEqual(conPend.pendientes.map((p) => [p.pendiente, p.pesoKg]), [[true, 260]]);
});

test('32. copia local incompleta -> respaldo conservador animal.ultimoPeso', async () => {
  const d = dispositivo();
  await d.storage.put('animales', { key: 'srv:7', animalId: '7', ultimoPeso: { pesoKg: 410, fecha: '2026-11-01', metodo: 'BASCULA' } });
  await d.repo.aplicarPullPesajes(pagina([filaSync({ pesajeId: '1', animalId: '7', fecha: '2026-09-01', pesoKg: 300 })], { hayMas: true, totales: null }));
  const r = await d.repo.ultimoPesoLocal('7');
  assert.equal(r.fuente, 'ANIMAL');
  assert.equal(r.completo, false);
  assert.equal(r.ultimoPeso.pesoKg, 410, 'un dato parcial no se presenta como certeza');
  assert.equal((await d.repo.ultimoPesoLocal('99')).ultimoPeso, null);
});

// ---------------------------------------------------------------------------------
// 33-35. Concurrencia, reproducción y outbox legacy
// ---------------------------------------------------------------------------------

test('33. Web Lock: el motor automático cede; reclamo atómico sin lock: un solo POST', async () => {
  const d = dispositivo();
  const srv = servidor();
  await crear(d, 1);
  const lock = createNavigatorLock(syncLockName(ORG), globalThis.navigator?.locks);
  assert.ok(lock, 'Web Locks disponible en este runtime');
  let liberar;
  srv.alEnviar = () => new Promise((resolve) => { liberar = resolve; });
  const m1 = motor(d, srv, { lock });
  const m2 = motor(d, srv, { lock });
  const primero = m1.syncNow();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(await m2.syncNow(), RUN_RESULT.EN_CURSO);
  liberar();
  assert.equal(await primero, RUN_RESULT.OK);
  assert.equal(srv.posts.length, 1);

  const d2 = dispositivo();
  const srv2 = servidor();
  await crear(d2, 2);
  const otroRepo = createLocalRepo(d2.storage, { organizacionId: ORG, deviceId: 'd-2', now: d2.clock.now, uuid: contadorUuid('e') });
  await Promise.all([
    motor(d2, srv2).syncNow(),
    createSyncEngine({ repo: otroRepo, transport: transporte(srv2), now: d2.clock.now }).syncNow(),
  ]);
  assert.equal(srv2.posts.length, 1);
  assert.equal(srv2.filas.length, 1);
});

test('34. compatibilidad con reproducción: cadenas y cursores independientes', async () => {
  const d = dispositivo();
  const srv = servidor();
  const repro = newOperation({ tipoOperacion: REPRODUCCION_EVENTO_CREAR, entidad: 'reproduccion_evento', localUuid: 'l-r', clientOperationId: ID(50), payload: { animalId: '7', evento: { tipoEvento: 'CELO_OBSERVADO', fechaEvento: '2026-10-01' } }, deviceId: 'd-1', now: new Date('2026-11-01T00:00:00.000Z'), uuid: () => 'op-r', claveOrden: claveOrdenAnimal('7'), origen: { organizacionId: ORG, cuentaId: CUENTA_A } });
  await d.storage.put('outbox', { ...repro, estado: OUTBOX_ESTADOS.CONFLICTO });
  await crear(d, 1);
  assert.notEqual(claveOrdenAnimal('7'), claveOrdenPesajes('7'));
  await d.repo.putMeta({ reproduccionCursor: 'r-1' });
  await motor(d, srv).syncNow();
  assert.deepEqual(srv.posts.map((p) => p.pathname), ['/api/ganaderia/animales/7/pesajes'], 'un conflicto reproductivo no frena los pesajes');
  assert.equal((await d.storage.get('outbox', 'op-r')).estado, OUTBOX_ESTADOS.CONFLICTO);
  assert.deepEqual((await d.repo.cadenaReproductiva('7')).map((op) => op.operationId), ['op-r']);
  assert.equal((await d.repo.cadenaPesajes('7')).length, 0);
  const meta = await d.repo.getMeta();
  assert.equal(meta.reproduccionCursor, 'r-1');
  assert.ok(meta.pesajesCursor);
  assert.notEqual(meta.pesajesCursor, meta.reproduccionCursor);
});

test('35. sin regresión del outbox legacy: pendientes, descartes y conteo', async () => {
  const d = dispositivo();
  await d.storage.put('outbox', opLegacy(1, { estado: OUTBOX_ESTADOS.RECHAZADO }));
  await crear(d, 2);
  const pendientes = await d.repo.listPesajesPendientes('7');
  assert.deepEqual(pendientes.map((p) => p.clientOperationId), [ID(1), ID(2)]);
  assert.equal((await d.repo.contar()).pendientes, 1);
  assert.equal((await d.repo.contar()).conflictos, 1);
  // descartarPesajePendiente (OfflineSyncPage) sigue igual para el legacy rechazado.
  await d.repo.descartarPesajePendiente('legacy-1');
  assert.deepEqual((await d.repo.listPesajesPendientes('7')).map((p) => p.clientOperationId), [ID(2)]);
  // Sin cuenta (llamador antiguo) se conserva el formato anterior: incierto, sin cadena.
  const sinCuenta = await d.repo.registrarPesajeLocal({ animalId: '8', body: body(3) });
  const op = await d.storage.get('outbox', sinCuenta.operationId);
  assert.equal(op.claveOrden, undefined);
  assert.equal(esPesajeCrearLegacy(op), true);
  // Con rol: la capacidad se valida en el repositorio.
  await assert.rejects(d.repo.registrarPesajeLocal({ animalId: '8', body: body(4), cuentaId: CUENTA_A, rol: 'lector' }), { code: 'ROLE_FORBIDDEN' });
});

// ---------------------------------------------------------------------------------
// Revisión final 5A.3b: invariantes
// ---------------------------------------------------------------------------------

test('INV1. anularPesaje: owner y admin sí; operador, lector, desconocido y null no (permiso y repo)', async () => {
  for (const [rol, esperado] of [['owner', true], ['admin', true], ['operador', false], ['lector', false], ['super_admin', false], [null, false]]) {
    assert.equal(puedeEncolar(rol, PESAJE_ANULAR), esperado, String(rol));
    const d = dispositivo();
    await d.repo.aplicarPullPesajes(pagina([activo300]));
    const intento = anular(d, { pesajeId: '300', clientOperationId: ID(2), rol });
    if (esperado) {
      assert.equal((await intento).operationId, 'pesaje-anular:300');
    } else {
      await assert.rejects(intento, { code: 'ROLE_FORBIDDEN' });
      assert.deepEqual(await d.repo.listOutbox(), []);
    }
  }
});

test('INV2a. diferida resuelta por POST: misma operación (id, motivo, origen, claveOrden), sin segunda ANULAR y sin envío previo', async () => {
  const d = dispositivo();
  const srv = servidor();
  await crear(d, 1);
  srv.falla = () => 'red-tras-guardar';
  await motor(d, srv).syncNow();
  const a = await anular(d, { pesajeRef: { clientOperationId: ID(1) }, clientOperationId: ID(2), motivo: 'Duplicado' });
  const antes = await d.storage.get('outbox', a.operationId);
  await assert.rejects(anular(d, { pesajeRef: { clientOperationId: ID(1) }, clientOperationId: ID(3) }), { code: 'OPERACION_ADMINISTRATIVA_PENDIENTE' });
  srv.falla = null;
  srv.posts.length = 0;
  const vistas = [];
  srv.alEnviar = async (pathname) => {
    if (pathname.endsWith('/anular')) vistas.push(structuredClone(await d.storage.get('outbox', a.operationId)));
  };
  d.clock.avanzar(60_000);
  await motor(d, srv).syncNow();
  assert.deepEqual(srv.posts.map((p) => p.pathname), ['/api/ganaderia/animales/7/pesajes', '/api/ganaderia/animales/7/pesajes/101/anular']);
  const enviada = vistas[0];
  assert.equal(enviada.operationId, antes.operationId);
  assert.equal(enviada.clientOperationId, ID(2));
  assert.equal(enviada.payload.motivo, 'Duplicado');
  assert.equal(enviada.payload.pesajeId, '101');
  assert.deepEqual(enviada.origen, antes.origen);
  assert.equal(enviada.claveOrden, 'pesaje:animal:7');
  assert.deepEqual(srv.posts[1].body, { motivo: 'Duplicado', clientOperationId: ID(2), identidadEsperada: antes.origen });
  assert.equal(srv.posts.filter((p) => p.pathname.endsWith('/anular')).length, 1);
  assert.deepEqual(await d.repo.listOutbox(), []);
});

test('INV2b. diferida resuelta por /sync/pesajes: el CREATE se cierra y la MISMA ANULAR queda con pesajeId', async () => {
  const d = dispositivo();
  const c = await createIncierto(d, 1);
  const a = await anular(d, { pesajeRef: { clientOperationId: ID(1) }, clientOperationId: ID(2) });
  const antes = await d.storage.get('outbox', a.operationId);
  await d.repo.aplicarPullPesajes(pagina([filaSync({ pesajeId: '200', animalId: '7', fecha: '2026-11-10', pesoKg: 300, clientOperationId: ID(1) })]));
  assert.equal(await d.storage.get('outbox', c.operationId), undefined);
  const despues = await d.storage.get('outbox', a.operationId);
  assert.deepEqual(despues, { ...antes, payload: { ...antes.payload, pesajeId: '200' } }, 'solo cambia payload.pesajeId');
  assert.equal((await d.repo.listOutbox()).filter((op) => op.tipoOperacion === PESAJE_ANULAR).length, 1);
});

test('INV2c. CREATE en CONFLICTO o RECHAZADO: la ANULAR diferida no se resuelve ni sale, aunque llegue una fila con su clientOperationId', async () => {
  for (const estado of [OUTBOX_ESTADOS.CONFLICTO, OUTBOX_ESTADOS.RECHAZADO]) {
    const d = dispositivo();
    const srv = servidor();
    const c = await createIncierto(d, 1);
    const a = await anular(d, { pesajeRef: { clientOperationId: ID(1) }, clientOperationId: ID(2) });
    await d.storage.mutate('outbox', c.operationId, (op) => ({ ...op, estado, ultimoError: { codigo: 'X', status: 409 } }));
    srv.sembrar({ pesajeId: '200', animalId: '7', fecha: '2026-11-10', pesoKg: 300, clientOperationId: ID(1) });
    await d.repo.aplicarPullPesajes(srv.paginaPesajes(null).data);
    const diferida = await d.storage.get('outbox', a.operationId);
    assert.equal(diferida.payload.pesajeId, null, estado);
    assert.equal(await d.repo.resolverPesajeIdDeAnulacion(diferida), null);
    assert.deepEqual(operacionesEnTurno([diferida]), []);
    d.clock.avanzar(60 * 60_000);
    await motor(d, srv).syncNow({ forzar: true });
    assert.equal(srv.posts.filter((p) => p.pathname.endsWith('/anular')).length, 0, estado);
  }
});

test('INV2d. CREATE legacy RECHAZADO (nunca llegó): la diferida espera; al descartar el CREATE se retira la ANULAR que nunca salió', async () => {
  const d = dispositivo();
  const srv = servidor();
  await d.storage.put('outbox', opLegacy(1));
  const a = await anular(d, { pesajeRef: { clientOperationId: ID(1) }, clientOperationId: ID(2) });
  srv.falla = () => ({ status: 400, data: { error: 'INVALID_PESO' } });
  await motor(d, srv).syncNow();
  assert.equal((await d.storage.get('outbox', 'legacy-1')).estado, OUTBOX_ESTADOS.RECHAZADO);
  assert.equal((await d.storage.get('outbox', a.operationId)).payload.pesajeId, null);
  assert.equal(srv.posts.filter((p) => p.pathname.endsWith('/anular')).length, 0);
  await d.repo.aplicarPullPesajes(pagina([activo300]));
  const otra = await anular(d, { pesajeId: '300', clientOperationId: ID(3) });
  await d.repo.descartarPesajePendiente('legacy-1');
  assert.equal(await d.storage.get('outbox', a.operationId), undefined);
  assert.ok(await d.storage.get('outbox', otra.operationId), 'otra ANULAR no se toca');
});

test('INV2e. CREATE que nunca se puede confirmar: la diferida permanece conservadora (sin POST, sin pesajeId)', async () => {
  const d = dispositivo();
  const srv = servidor();
  await createIncierto(d, 1);
  const a = await anular(d, { pesajeRef: { clientOperationId: ID(1) }, clientOperationId: ID(2) });
  srv.falla = () => 'red';
  for (let i = 0; i < 3; i += 1) {
    d.clock.avanzar(60_000);
    await motor(d, srv).syncNow({ forzar: true });
  }
  assert.ok(srv.posts.every((p) => p.pathname.endsWith('/pesajes')));
  const diferida = await d.storage.get('outbox', a.operationId);
  assert.equal(diferida.payload.pesajeId, null);
  assert.equal(diferida.posibleEnServidor, false);
  assert.equal(diferida.estado, OUTBOX_ESTADOS.PENDIENTE);
});

test('INV3. cancelación segura: solo esa operación, 0 POST, sin ANULAR, pesajes intactos, idempotente', async () => {
  const d = dispositivo();
  const srv = servidor();
  await d.repo.aplicarPullPesajes(pagina([activo300]));
  const pesajesAntes = await d.storage.getAll('pesajes');
  const objetivo = await crear(d, 1);
  await crear(d, 2);
  await crear(d, 3, { animalId: '8' });
  await anular(d, { pesajeId: '300', clientOperationId: ID(4) });
  const orden = (lista) => [...lista].sort((x, y) => x.operationId.localeCompare(y.operationId));
  const outboxAntes = orden((await d.repo.listOutbox()).filter((op) => op.operationId !== objetivo.operationId));
  const r1 = await d.repo.cancelarPesajePendiente(objetivo.operationId, { cuentaId: CUENTA_A });
  const r2 = await d.repo.cancelarPesajePendiente(objetivo.operationId, { cuentaId: CUENTA_A });
  assert.deepEqual(r1, { cancelado: true, operationId: objetivo.operationId, clientOperationId: ID(1) });
  assert.deepEqual(r2, { cancelado: true, yaCancelado: true, operationId: objetivo.operationId, clientOperationId: ID(1) });
  const outboxDespues = orden(await d.repo.listOutbox());
  assert.deepEqual(outboxDespues, outboxAntes, 'las demás operaciones no cambian');
  assert.equal(outboxDespues.filter((op) => op.tipoOperacion === PESAJE_ANULAR).length, 1, 'solo la anulación que ya existía');
  assert.deepEqual(await d.storage.getAll('pesajes'), pesajesAntes);
  assert.deepEqual((await d.repo.getMeta()).pesajesOperacionesCanceladas, [{ operationId: objetivo.operationId, clientOperationId: ID(1) }]);
  await assert.rejects(crear(d, 1), { code: 'OPERACION_CANCELADA' });
  srv.sembrar({ ...activo300 });
  await motor(d, srv).syncNow();
  assert.equal(srv.posts.some((p) => p.body.clientOperationId === ID(1)), false, 'el CREATE cancelado nunca sale');
  assert.deepEqual(await d.repo.listOutbox(), []);
});

test('INV3b. la marca de cancelación persiste en IndexedDB de la organización (reabrir) y no bloquea otra organización', async () => {
  const idb = new IDBFactory();
  const abrir = async (org) => createIndexedDbStorage(await openIndexedDb(idb, orgDbName(org), ORG_DB_VERSION, ORG_STORES));
  const s1 = await abrir(ORG);
  const r1 = createLocalRepo(s1, { organizacionId: ORG, deviceId: 'd-1', uuid: contadorUuid() });
  const op = await r1.registrarPesajeLocal({ animalId: '7', body: body(1), cuentaId: CUENTA_A });
  await r1.cancelarPesajePendiente(op.operationId, { cuentaId: CUENTA_A });
  await s1.close();
  const s2 = await abrir(ORG);
  const r2 = createLocalRepo(s2, { organizacionId: ORG, deviceId: 'd-1', uuid: contadorUuid('a') });
  await assert.rejects(r2.registrarPesajeLocal({ animalId: '7', body: body(1), cuentaId: CUENTA_A }), { code: 'OPERACION_CANCELADA' });
  assert.equal((await r2.cancelarPesajePendiente(op.operationId, { cuentaId: CUENTA_A })).yaCancelado, true);
  await s2.close();
  const s3 = await abrir(OTRA_ORG);
  const r3 = createLocalRepo(s3, { organizacionId: OTRA_ORG, deviceId: 'd-1', uuid: contadorUuid('b') });
  assert.equal((await r3.registrarPesajeLocal({ animalId: '7', body: body(1), cuentaId: CUENTA_A })).yaEncolado, false);
  assert.equal((await r3.getMeta()).pesajesOperacionesCanceladas, undefined);
  await s3.close();
});

test('INV3c. si la cancelación no se aplica (empezó a enviarse), la marca se retira y la operación sigue intacta', async () => {
  const d = dispositivo();
  const r = await crear(d, 1);
  const mutate = d.storage.mutate.bind(d.storage);
  d.storage.mutate = async (store, key, fn) => {
    d.storage.mutate = mutate;
    await mutate('outbox', r.operationId, (op) => ({ ...op, estado: OUTBOX_ESTADOS.SINCRONIZANDO }));
    return mutate(store, key, fn);
  };
  await assert.rejects(d.repo.cancelarPesajePendiente(r.operationId, { cuentaId: CUENTA_A }), { code: 'PESAJE_PENDIENTE_EN_CURSO' });
  assert.equal((await d.storage.get('outbox', r.operationId)).estado, OUTBOX_ESTADOS.SINCRONIZANDO);
  assert.deepEqual((await d.repo.getMeta()).pesajesOperacionesCanceladas, []);
});

test('INV4. ANULADO + fila vieja ACTIVO se conserva; fila nueva ANULADO actualiza motivo, anuladoEn y operación', async () => {
  const d = dispositivo();
  await d.repo.aplicarPullPesajes(pagina([anulado300(null, 'Motivo previo')]));
  await d.repo.aplicarPullPesajes(pagina([activo300], { totales: { pesajes: 1, anulados: 1 } }));
  let local = await d.storage.get('pesajes', '300');
  assert.equal(local.estadoRegistro, 'ANULADO');
  assert.equal(local.anulacion.motivo, 'Motivo previo');
  const nueva = { ...anulado300(ID(9), 'Motivo definitivo'), anulacion: { anuladoEn: '2026-11-18T09:30:00.000Z', motivo: 'Motivo definitivo' } };
  await d.repo.aplicarPullPesajes(pagina([nueva]));
  local = await d.storage.get('pesajes', '300');
  assert.deepEqual(local.anulacion, { anuladoEn: '2026-11-18T09:30:00.000Z', motivo: 'Motivo definitivo' });
  assert.equal(local.anulacionClientOperationId, ID(9));
  assert.equal(local.clientOperationId, ID(300));
  await d.repo.aplicarPullPesajes(pagina([{ ...nueva, anulacion: null, anulacionClientOperationId: null }]));
  local = await d.storage.get('pesajes', '300');
  assert.equal(local.anulacion.motivo, 'Motivo definitivo', 'una fila ANULADO sin bloque de anulación no borra lo conocido');
  assert.equal(local.anulacionClientOperationId, ID(9));
});

test('INV5. copia completa solo con evidencia explícita: parcial, interrumpida, sesión cambiada o desfase -> animal.ultimoPeso', async () => {
  const d = dispositivo();
  await d.storage.put('animales', { key: 'srv:7', animalId: '7', ultimoPeso: { pesoKg: 410, fecha: '2026-11-01', metodo: 'BASCULA' } });
  const fuente = async () => (await d.repo.ultimoPesoLocal('7')).fuente;
  const fila = (id, fecha, pesoKg) => filaSync({ pesajeId: id, animalId: '7', fecha, pesoKg });
  await d.repo.aplicarPullPesajes(pagina([fila('1', '2026-09-01', 300)], { hayMas: true, totales: null }));
  assert.equal(await fuente(), 'ANIMAL', 'hay filas, pero el recorrido no terminó');
  await d.repo.aplicarPullPesajes(pagina([fila('2', '2026-10-01', 320)], { totales: { pesajes: 2, anulados: 0 } }));
  assert.equal(await fuente(), 'LOCAL');
  await d.repo.aplicarPullPesajes(pagina([fila('3', '2026-10-15', 330)], { hayMas: true, totales: null }));
  assert.equal(await fuente(), 'ANIMAL', 'recorrido incremental a medias');
  await d.repo.aplicarPullPesajes(pagina([], { totales: { pesajes: 3, anulados: 0 } }));
  assert.equal(await fuente(), 'LOCAL');
  await d.repo.aplicarPullPesajes(pagina([], { totales: { pesajes: 9, anulados: 0 } }));
  assert.equal(await fuente(), 'ANIMAL', 'desfase de totales');

  const d2 = dispositivo();
  await d2.storage.put('animales', { key: 'srv:7', animalId: '7', ultimoPeso: { pesoKg: 410, fecha: '2026-11-01', metodo: 'BASCULA' } });
  const srv = servidor();
  srv.sembrar({ pesajeId: '1', animalId: '7', fecha: '2026-10-01', pesoKg: 300 });
  await motor(d2, srv).syncNow();
  assert.equal((await d2.repo.ultimoPesoLocal('7')).fuente, 'LOCAL');
  srv.pagina = 1;
  srv.sembrar({ pesajeId: '2', animalId: '7', fecha: '2026-10-02', pesoKg: 301 });
  srv.sembrar({ pesajeId: '3', animalId: '7', fecha: '2026-10-03', pesoKg: 302 });
  let paginas = 0;
  srv.trasPagina = () => {
    paginas += 1;
    if (paginas === 1) srv.sesion = sesionDe(CUENTA_B);
  };
  await motor(d2, srv).syncNow();
  assert.equal((await d2.repo.getMeta()).pesajesUltimoError.codigo, 'SESION_CAMBIADA');
  assert.equal((await d2.repo.ultimoPesoLocal('7')).fuente, 'ANIMAL', 'sesión cambiada durante el recorrido');
});
