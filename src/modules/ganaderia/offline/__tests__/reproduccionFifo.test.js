// FASE 4E.1 -- motor FIFO por claveOrden, tipos desconocidos y aislamiento por
// cuenta. Mismo motor y repositorio reales, con un servidor que reproduce el
// contrato de POST .../reproduccion/eventos (idempotencia por clientOperationId,
// orden de fechas y reglas de estado de la fuente compartida). El contrato real
// contra PostgreSQL se prueba en el bloque de integración.
import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { DEVICE_STORES, ORG_DB_VERSION, ORG_STORES, orgDbName } from '../offlineSchema.js';
import { createIndexedDbStorage, createMemoryStorage, openIndexedDb } from '../storage.js';
import { createLocalRepo } from '../localRepo.js';
import { RED_REINTENTO_MS, RUN_RESULT, SINCRONIZANDO_LEASE_MS, createSyncEngine, leerIdentidadSesion, posibleEnServidorTras } from '../syncEngine.js';
import { OUTBOX_ESTADOS, REPRODUCCION_EVENTO_CREAR, claveOrdenAnimal, contarOutboxNoSincronizado, newOperation, ordenarOutbox } from '../outbox.js';
import { cerrarSesionOffline } from '../offlineSession.js';
import { handlerDe, handlerFor } from '../operationHandlers.js';
import { createNavigatorLock, syncLockName } from '../browserOffline.js';
import { derivarEstadoReproductivo, reglaRegistro } from '../../engine/reproduccion.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTRA_ORG = '22222222-2222-4222-8222-222222222222';
const CUENTA_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const CUENTA_B = 'bbbbbbbb-0000-4000-8000-000000000002';
const SESSION_PATH = '/api/ganaderia/auth/session';

function reloj(inicio = '2026-10-20T15:00:00.000Z') {
  let t = new Date(inicio).getTime();
  return { now: () => new Date(t), avanzar: (ms) => { t += ms; } };
}

function contadorUuid(prefijo = '0') {
  let n = 0;
  return () => `${prefijo.repeat(8)}-0000-4000-8000-${String(++n).padStart(12, '0')}`;
}

const animalDe = (pathname) => pathname.match(/\/animales\/(\d+)\/reproduccion\/eventos$/)?.[1];

function servidor() {
  const eventos = [];
  let seq = 0;
  const srv = {
    eventos,
    posts: [],
    sesion: { authenticated: true, cuenta: { cuentaId: CUENTA_A }, organizacionActiva: { organizacionId: ORG } },
    fallaSesion: null, // 'red' | { status, data }
    falla: null, // (pathname, body) => { status, data } | 'red' | 'red-tras-guardar' | null
    alEnviar: null,
    responder(pathname, { clientOperationId, identidadEsperada, ...evento }) {
      // Mismo orden que la ruta real: identidad antes de cualquier lectura o escritura.
      if (identidadEsperada && (identidadEsperada.cuentaId !== srv.sesion.cuenta?.cuentaId || identidadEsperada.organizacionId !== srv.sesion.organizacionActiva?.organizacionId)) {
        return { ok: false, status: 409, data: { error: 'IDENTIDAD_NO_COINCIDE' } };
      }
      const animalId = animalDe(pathname);
      const previo = eventos.find((e) => e.clientOperationId === clientOperationId);
      if (previo) {
        const mismo = previo.animalId === animalId && previo.tipoEvento === evento.tipoEvento && previo.fechaEvento === evento.fechaEvento;
        if (!mismo) return { ok: false, status: 409, data: { error: 'CLIENT_OPERATION_ID_REUSED' } };
        return { ok: true, status: 200, data: { ok: true, yaExistia: true, evento: srv.publico(previo) } };
      }
      const propios = eventos.filter((e) => e.animalId === animalId);
      const actual = derivarEstadoReproductivo({ sexo: 'HEMBRA', eventos: propios });
      if (actual.ultimoEvento && evento.fechaEvento < actual.ultimoEvento.fechaEvento) return { ok: false, status: 409, data: { error: 'FECHA_ANTERIOR_A_HISTORIAL' } };
      const regla = reglaRegistro(actual.estado, evento.tipoEvento);
      if (regla) return { ok: false, status: 409, data: { error: regla.code } };
      const nuevo = { ...evento, eventoId: String(++seq), animalId, clientOperationId, estadoRegistro: 'ACTIVO' };
      eventos.push(nuevo);
      return { ok: true, status: 201, data: { ok: true, yaExistia: false, evento: srv.publico(nuevo) } };
    },
    publico(e) {
      const { clientOperationId: _c, tipoEvento, fechaEvento, eventoId, animalId, estadoRegistro, ...detalle } = e;
      return { eventoId, animalId, tipoEvento, fechaEvento, estadoRegistro, detalle };
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
      if (falla === 'red-tras-guardar') {
        srv.responder(pathname, body);
        throw new TypeError('Failed to fetch');
      }
      if (falla) return { ok: false, ...falla };
      const respuesta = srv.responder(pathname, body);
      srv.trasResponder?.();
      return respuesta;
    },
    async getJson(pathname) {
      if (pathname === SESSION_PATH) {
        if (srv.fallaSesion === 'red') throw new TypeError('Failed to fetch');
        if (srv.fallaSesion) return { ok: false, ...srv.fallaSesion };
        return { ok: true, status: 200, data: srv.sesion };
      }
      return { ok: true, status: 200, data: { organizacionId: ORG, cursor: 'c', completo: false, animales: [], chapetas: [], predios: [], potreros: [], razas: [], categorias: [] } };
    },
  };
}

function dispositivo({ storage = createMemoryStorage(ORG_STORES), clock = reloj() } = {}) {
  const repo = createLocalRepo(storage, { organizacionId: ORG, deviceId: 'd-1', now: clock.now, uuid: contadorUuid() });
  return { storage, repo, clock };
}

const motor = (d, srv, opciones = {}) => createSyncEngine({ repo: d.repo, transport: transporte(srv), now: d.clock.now, random: () => 0.5, lock: opciones.lock ?? null });

let seqOp = 0;
/** Operación de la cadena tal como la deja registrarEventoReproductivoLocal. */
async function encolar(d, animalId, tipoEvento, fechaEvento, { cuenta = CUENTA_A, organizacionId = ORG, ...resto } = {}) {
  seqOp += 1;
  const op = {
    ...newOperation({
      tipoOperacion: REPRODUCCION_EVENTO_CREAR,
      entidad: 'reproduccion_evento',
      localUuid: `l-${seqOp}`,
      clientOperationId: `c0000000-0000-4000-8000-${String(seqOp).padStart(12, '0')}`,
      payload: { animalId, evento: { tipoEvento, fechaEvento } },
      deviceId: 'd-1',
      now: new Date(d.clock.now().getTime() + seqOp),
      uuid: () => `o-${seqOp}`,
      claveOrden: claveOrdenAnimal(animalId),
      origen: { organizacionId, cuentaId: cuenta },
    }),
    ...resto,
  };
  await d.storage.put('outbox', op);
  return op;
}

const enviados = (srv, animalId = null) => srv.posts.filter((p) => !animalId || animalDe(p.pathname) === animalId).map((p) => p.body.clientOperationId);
const leer = (d, op) => d.storage.get('outbox', op.operationId);

// ---------------------------------------------------------------------------
// FIFO y envío
// ---------------------------------------------------------------------------

test('envía en orden FIFO, con el cuerpo del contrato, y confirma en la copia local', async () => {
  const d = dispositivo();
  const srv = servidor();
  const a = await encolar(d, '7', 'IATF', '2026-10-01');
  const b = await encolar(d, '7', 'DIAGNOSTICO_PRENEZ', '2026-10-10', { payload: { animalId: '7', evento: { tipoEvento: 'DIAGNOSTICO_PRENEZ', fechaEvento: '2026-10-10', diagnosticoResultado: 'PRENADA' } } });
  assert.equal(await motor(d, srv).syncNow(), RUN_RESULT.OK);
  assert.deepEqual(enviados(srv), [a.clientOperationId, b.clientOperationId]);
  assert.equal(srv.posts[0].pathname, '/api/ganaderia/animales/7/reproduccion/eventos');
  assert.deepEqual(srv.posts[0].body, { tipoEvento: 'IATF', fechaEvento: '2026-10-01', clientOperationId: a.clientOperationId, identidadEsperada: { organizacionId: ORG, cuentaId: CUENTA_A } });
  assert.deepEqual(await d.repo.listOutbox(), []);
  const copia = await d.repo.listEventosReproductivos('7');
  assert.deepEqual(copia.map((e) => e.tipoEvento), ['IATF', 'DIAGNOSTICO_PRENEZ']);
  assert.equal(copia[1].diagnosticoResultado, 'PRENADA', 'campos planos para el plegado');
  assert.equal(copia[0].clientOperationId, a.clientOperationId);
});

test('el orden es por createdAt aunque se hayan guardado al revés', async () => {
  const d = dispositivo();
  const srv = servidor();
  const b = await encolar(d, '7', 'CELO_OBSERVADO', '2026-10-05', { createdAt: '2026-10-20T15:00:02.000Z' });
  const a = await encolar(d, '7', 'CELO_OBSERVADO', '2026-10-01', { createdAt: '2026-10-20T15:00:01.000Z' });
  await motor(d, srv).syncNow();
  assert.deepEqual(enviados(srv), [a.clientOperationId, b.clientOperationId]);
});

// ---------------------------------------------------------------------------
// Backoff y errores reintentables
// ---------------------------------------------------------------------------

test('backoff de un ciclo anterior: la siguiente de la cadena NO se adelanta; otro animal sí sale', async () => {
  const d = dispositivo();
  const srv = servidor();
  const futuro = new Date(d.clock.now().getTime() + 60_000).toISOString();
  const a = await encolar(d, '7', 'CELO_OBSERVADO', '2026-10-01', { estado: OUTBOX_ESTADOS.ERROR_REINTENTABLE, siguienteIntentoAt: futuro, ultimoError: { codigo: 'X', status: 500, tipo: 'http' } });
  const b = await encolar(d, '7', 'IATF', '2026-10-02');
  const otro = await encolar(d, '8', 'CELO_OBSERVADO', '2026-10-01');

  assert.equal(await motor(d, srv).syncNow(), RUN_RESULT.OK);
  assert.deepEqual(enviados(srv), [otro.clientOperationId]);
  assert.equal((await leer(d, b)).estado, OUTBOX_ESTADOS.PENDIENTE);

  d.clock.avanzar(60_001);
  await motor(d, srv).syncNow();
  assert.deepEqual(enviados(srv, '7'), [a.clientOperationId, b.clientOperationId]);
});

test('"Sincronizar ahora" salta la espera sin romper el orden', async () => {
  const d = dispositivo();
  const srv = servidor();
  const futuro = new Date(d.clock.now().getTime() + 60_000).toISOString();
  const a = await encolar(d, '7', 'CELO_OBSERVADO', '2026-10-01', { estado: OUTBOX_ESTADOS.ERROR_REINTENTABLE, siguienteIntentoAt: futuro });
  const b = await encolar(d, '7', 'IATF', '2026-10-02');
  await motor(d, srv).syncNow({ forzar: true });
  assert.deepEqual(enviados(srv), [a.clientOperationId, b.clientOperationId]);
});

test('5xx: conserva la operación, mismo id al reintentar y posibleEnServidor=true', async () => {
  const d = dispositivo();
  const srv = servidor();
  const a = await encolar(d, '7', 'CELO_OBSERVADO', '2026-10-01');
  const b = await encolar(d, '7', 'IATF', '2026-10-02');
  srv.falla = () => ({ status: 503, data: { error: 'X' } });
  assert.equal(await motor(d, srv).syncNow(), RUN_RESULT.ERROR);
  const fallida = await leer(d, a);
  assert.equal(fallida.estado, OUTBOX_ESTADOS.ERROR_REINTENTABLE);
  assert.equal(fallida.posibleEnServidor, true);
  assert.deepEqual(enviados(srv), [a.clientOperationId], 'b no se envió');

  srv.falla = null;
  d.clock.avanzar(10 * 60_000);
  await motor(d, srv).syncNow();
  assert.deepEqual(enviados(srv), [a.clientOperationId, a.clientOperationId, b.clientOperationId]);
  assert.equal(srv.eventos.length, 2);
});

test('respuesta perdida: reintento idempotente (200 yaExistia), sin duplicar y sin adelantar', async () => {
  const d = dispositivo();
  const srv = servidor();
  const a = await encolar(d, '7', 'CELO_OBSERVADO', '2026-10-01');
  const b = await encolar(d, '7', 'IATF', '2026-10-02');
  let primera = true;
  srv.falla = () => {
    if (!primera) return null;
    primera = false;
    return 'red-tras-guardar';
  };
  assert.equal(await motor(d, srv).syncNow(), RUN_RESULT.OFFLINE);
  const incierta = await leer(d, a);
  assert.equal(incierta.estado, OUTBOX_ESTADOS.ERROR_REINTENTABLE);
  assert.equal(incierta.posibleEnServidor, true);
  assert.equal(incierta.intentos, 0, 'un fallo de red no suma intento');
  await assert.rejects(d.repo.editarEventoReproductivoPendiente({ operationId: a.operationId, body: { tipoEvento: 'CELO_OBSERVADO', fechaEvento: '2026-10-03' }, cuentaId: CUENTA_A }), { code: 'EVENTO_ENVIO_INCIERTO' });

  d.clock.avanzar(RED_REINTENTO_MS);
  assert.equal(await motor(d, srv).syncNow(), RUN_RESULT.OK);
  assert.equal(srv.eventos.length, 2);
  assert.deepEqual(enviados(srv), [a.clientOperationId, a.clientOperationId, b.clientOperationId]);
  assert.deepEqual(await d.repo.listOutbox(), []);
});

test('el fallo de red persiste posibleEnServidor ANTES de la respuesta (reinicio a mitad de envío)', async () => {
  const d = dispositivo();
  const srv = servidor();
  const a = await encolar(d, '7', 'CELO_OBSERVADO', '2026-10-01');
  let enPleno = null;
  srv.alEnviar = async () => { enPleno = await leer(d, a); };
  await motor(d, srv).syncNow();
  assert.equal(enPleno.estado, OUTBOX_ESTADOS.SINCRONIZANDO);
  assert.equal(enPleno.posibleEnServidor, true);
});

test('reinicio: SINCRONIZANDO se recupera, conserva el mismo id y la incertidumbre', async () => {
  const idb = new IDBFactory();
  const abrir = async () => createIndexedDbStorage(await openIndexedDb(idb, orgDbName(ORG), ORG_DB_VERSION, ORG_STORES));
  const clock = reloj();
  const storage = await abrir();
  const d = dispositivo({ storage, clock });
  const a = await encolar(d, '7', 'CELO_OBSERVADO', '2026-10-01', { estado: OUTBOX_ESTADOS.SINCRONIZANDO, posibleEnServidor: true, updatedAt: clock.now().toISOString() });
  const b = await encolar(d, '7', 'IATF', '2026-10-02');
  await storage.close();

  clock.avanzar(SINCRONIZANDO_LEASE_MS + 1);
  const reabierta = await abrir();
  const tras = dispositivo({ storage: reabierta, clock });
  const srv = servidor();
  assert.equal(await motor(tras, srv).syncNow(), RUN_RESULT.OK);
  assert.deepEqual(enviados(srv), [a.clientOperationId, b.clientOperationId]);
  await reabierta.close();
});

test('SINCRONIZANDO con lease vigente en otro motor detiene la cadena', async () => {
  const d = dispositivo();
  const srv = servidor();
  await encolar(d, '7', 'CELO_OBSERVADO', '2026-10-01', { estado: OUTBOX_ESTADOS.SINCRONIZANDO, updatedAt: d.clock.now().toISOString() });
  await encolar(d, '7', 'IATF', '2026-10-02');
  const otro = await encolar(d, '8', 'CELO_OBSERVADO', '2026-10-01');
  await motor(d, srv).syncNow();
  assert.deepEqual(enviados(srv), [otro.clientOperationId]);
});

test('una operación que aún no puede construir su petición detiene su cadena', async () => {
  const d = dispositivo();
  const srv = servidor();
  await encolar(d, '7', 'CELO_OBSERVADO', '2026-10-01', { payload: { animalId: 'local:x', evento: { tipoEvento: 'CELO_OBSERVADO', fechaEvento: '2026-10-01' } } });
  await encolar(d, '7', 'IATF', '2026-10-02');
  const otro = await encolar(d, '8', 'CELO_OBSERVADO', '2026-10-01');
  await motor(d, srv).syncNow();
  assert.deepEqual(enviados(srv), [otro.clientOperationId]);
});

// ---------------------------------------------------------------------------
// Conflicto y rechazo
// ---------------------------------------------------------------------------

for (const [nombre, respuesta, estado, posible] of [
  ['409 de dominio -> CONFLICTO', { status: 409, data: { error: 'EVENTO_NO_PERMITIDO_POR_ESTADO' } }, OUTBOX_ESTADOS.CONFLICTO, false],
  ['404 -> CONFLICTO', { status: 404, data: { error: 'ANIMAL_NOT_FOUND' } }, OUTBOX_ESTADOS.CONFLICTO, false],
  ['400 de validación -> RECHAZADO', { status: 400, data: { error: 'INVALID_TORO' } }, OUTBOX_ESTADOS.RECHAZADO, false],
  ['403 de rol -> RECHAZADO', { status: 403, data: { error: 'ROLE_FORBIDDEN' }, failure: 'ROLE_FORBIDDEN' }, OUTBOX_ESTADOS.RECHAZADO, false],
]) {
  test(`${nombre}: se conserva y detiene su cadena, en este ciclo y en los siguientes; otro animal sigue`, async () => {
    const d = dispositivo();
    const srv = servidor();
    const a = await encolar(d, '7', 'CELO_OBSERVADO', '2026-10-01');
    const b = await encolar(d, '7', 'IATF', '2026-10-02');
    const otro = await encolar(d, '8', 'CELO_OBSERVADO', '2026-10-01');
    srv.falla = (pathname) => (animalDe(pathname) === '7' ? respuesta : null);

    assert.equal(await motor(d, srv).syncNow(), RUN_RESULT.OK);
    const bloqueada = await leer(d, a);
    assert.equal(bloqueada.estado, estado);
    assert.equal(bloqueada.posibleEnServidor, posible);
    assert.equal(bloqueada.clientOperationId, a.clientOperationId);
    assert.equal((await leer(d, b)).estado, OUTBOX_ESTADOS.PENDIENTE);
    assert.deepEqual(enviados(srv), [a.clientOperationId, otro.clientOperationId]);

    srv.falla = null;
    d.clock.avanzar(24 * 60 * 60_000);
    await motor(d, srv).syncNow({ forzar: true });
    assert.deepEqual(enviados(srv, '7'), [a.clientOperationId], 'nunca salta automáticamente al siguiente');
    assert.equal((await d.repo.listOutbox()).length, 2);
  });
}

test('resolver explícitamente: cancelar libera la cadena', async () => {
  const d = dispositivo();
  const srv = servidor();
  const a = await encolar(d, '7', 'CELO_OBSERVADO', '2026-10-01', { estado: OUTBOX_ESTADOS.CONFLICTO });
  const b = await encolar(d, '7', 'IATF', '2026-10-02');
  await d.repo.cancelarEventoReproductivoPendiente(a.operationId, { cuentaId: CUENTA_A });
  await motor(d, srv).syncNow();
  assert.deepEqual(enviados(srv), [b.clientOperationId]);
});

test('resolver explícitamente: editar reenvía con id nuevo en su misma posición', async () => {
  const d = dispositivo();
  await d.storage.put('animales', { key: 'srv:7', animalId: '7', sexo: 'HEMBRA', estado: 'ACTIVO' });
  const srv = servidor();
  const a = await encolar(d, '7', 'CELO_OBSERVADO', '2026-10-01', { estado: OUTBOX_ESTADOS.CONFLICTO });
  const b = await encolar(d, '7', 'IATF', '2026-10-05');
  await d.repo.editarEventoReproductivoPendiente({ operationId: a.operationId, body: { tipoEvento: 'CELO_OBSERVADO', fechaEvento: '2026-10-02' }, cuentaId: CUENTA_A });
  const editada = await leer(d, a);
  await motor(d, srv).syncNow();
  assert.notEqual(editada.clientOperationId, a.clientOperationId);
  assert.deepEqual(enviados(srv), [editada.clientOperationId, b.clientOperationId]);
});

test('sin el motor FIFO el servidor rechazaría la siguiente: la cadena evita el 409 de orden', async () => {
  const d = dispositivo();
  const srv = servidor();
  await encolar(d, '7', 'DIAGNOSTICO_PRENEZ', '2026-10-01', { payload: { animalId: '7', evento: { tipoEvento: 'DIAGNOSTICO_PRENEZ', fechaEvento: '2026-10-01', diagnosticoResultado: 'PRENADA' } }, estado: OUTBOX_ESTADOS.ERROR_REINTENTABLE, siguienteIntentoAt: new Date(d.clock.now().getTime() + 60_000).toISOString() });
  const parto = await encolar(d, '7', 'PARTO', '2026-10-02');
  await motor(d, srv).syncNow();
  assert.equal((await leer(d, parto)).estado, OUTBOX_ESTADOS.PENDIENTE);
  assert.deepEqual(srv.eventos, []);
});

// ---------------------------------------------------------------------------
// posibleEnServidor
// ---------------------------------------------------------------------------

test('posibleEnServidorTras: matriz', () => {
  const tras = (r, clase, anterior) => posibleEnServidorTras(r, clase, anterior);
  assert.equal(tras({ status: 0, failure: 'NETWORK_ERROR' }, 'REINTENTABLE', false), true);
  assert.equal(tras({ status: 503 }, 'REINTENTABLE', false), true);
  assert.equal(tras({ status: 0, failure: 'REQUEST_NOT_SENT' }, 'REINTENTABLE', false), false);
  assert.equal(tras({ status: 0, failure: 'REQUEST_NOT_SENT' }, 'REINTENTABLE', true), true, 'no borra una incertidumbre previa');
  assert.equal(tras({ status: 409 }, 'CONFLICTO', true), false);
  assert.equal(tras({ status: 400 }, 'RECHAZADO', true), true, '400 no prueba nada sobre un intento previo');
  assert.equal(tras({ status: 403 }, 'RECHAZADO', true), true);
  assert.equal(tras({ status: 401 }, 'SESION', false), false);
  assert.equal(tras({ status: 401 }, 'SESION', true), true);
});

test('CSRF no disponible (no enviada): sigue editable', async () => {
  const d = dispositivo();
  const srv = servidor();
  const a = await encolar(d, '7', 'CELO_OBSERVADO', '2026-10-01');
  srv.falla = () => ({ status: 0, data: { error: 'CSRF_UNAVAILABLE' }, failure: 'REQUEST_NOT_SENT' });
  assert.equal(await motor(d, srv).syncNow(), RUN_RESULT.OFFLINE);
  assert.equal((await leer(d, a)).posibleEnServidor, false);
});

test('401 durante el envío: conserva la operación y detiene el ciclo', async () => {
  const d = dispositivo();
  const srv = servidor();
  const a = await encolar(d, '7', 'CELO_OBSERVADO', '2026-10-01');
  const otro = await encolar(d, '8', 'CELO_OBSERVADO', '2026-10-01');
  srv.falla = () => ({ status: 401, data: { error: 'SESSION_INVALID' }, failure: 'SESSION_EXPIRED' });
  assert.equal(await motor(d, srv).syncNow(), RUN_RESULT.SESION_REQUERIDA);
  const op = await leer(d, a);
  assert.equal(op.estado, OUTBOX_ESTADOS.PENDIENTE);
  assert.equal(op.intentos, 0);
  assert.equal(op.posibleEnServidor, false);
  assert.equal((await leer(d, otro)).estado, OUTBOX_ESTADOS.PENDIENTE);
});

test('403 de CSRF: conserva la operación y no es un rechazo', async () => {
  const d = dispositivo();
  const srv = servidor();
  const a = await encolar(d, '7', 'CELO_OBSERVADO', '2026-10-01');
  srv.falla = () => ({ status: 403, data: { error: 'CSRF_INVALID' }, failure: 'CSRF_REJECTED' });
  assert.equal(await motor(d, srv).syncNow(), RUN_RESULT.SESION_REQUERIDA);
  assert.equal((await leer(d, a)).estado, OUTBOX_ESTADOS.PENDIENTE);
});

// ---------------------------------------------------------------------------
// Doble envío y carreras
// ---------------------------------------------------------------------------

test('dos motores SIN lock: una operación se envía una sola vez', async () => {
  const d = dispositivo();
  const srv = servidor();
  const a = await encolar(d, '7', 'CELO_OBSERVADO', '2026-10-01');
  const m1 = motor(d, srv);
  const m2 = createSyncEngine({ repo: createLocalRepo(d.storage, { organizacionId: ORG, deviceId: 'd-2', now: d.clock.now, uuid: contadorUuid('1') }), transport: transporte(srv), now: d.clock.now });
  await Promise.all([m1.syncNow(), m2.syncNow()]);
  assert.deepEqual(enviados(srv), [a.clientOperationId]);
  assert.equal(srv.eventos.length, 1);
});

test('dos motores con Web Lock: el automático cede y no hay envío doble', async () => {
  const d = dispositivo();
  const srv = servidor();
  const a = await encolar(d, '7', 'CELO_OBSERVADO', '2026-10-01');
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
  assert.deepEqual(enviados(srv), [a.clientOperationId]);
});

test('el lock es por organización', () => {
  assert.equal(syncLockName(ORG), `agx-sync-${ORG}`);
  assert.notEqual(syncLockName(ORG), syncLockName(OTRA_ORG));
});

test('editar mientras el motor verifica la sesión: no se envía la intención anterior', async () => {
  const d = dispositivo();
  await d.storage.put('animales', { key: 'srv:7', animalId: '7', sexo: 'HEMBRA', estado: 'ACTIVO' });
  const srv = servidor();
  const a = await encolar(d, '7', 'CELO_OBSERVADO', '2026-10-01');
  const transport = transporte(srv);
  const getJson = transport.getJson.bind(transport);
  let editada = false;
  transport.getJson = async (pathname) => {
    if (pathname === SESSION_PATH && !editada) {
      editada = true;
      d.clock.avanzar(5);
      await d.repo.editarEventoReproductivoPendiente({ operationId: a.operationId, body: { tipoEvento: 'CELO_OBSERVADO', fechaEvento: '2026-10-02' }, cuentaId: CUENTA_A });
    }
    return getJson(pathname);
  };
  await createSyncEngine({ repo: d.repo, transport, now: d.clock.now }).syncNow();
  assert.deepEqual(srv.posts, [], 'esa lectura ya no vale: sale en el próximo ciclo');
  assert.equal((await leer(d, a)).payload.evento.fechaEvento, '2026-10-02');
});

test('cancelar mientras el motor verifica la sesión: no se envía ni revive', async () => {
  const d = dispositivo();
  const srv = servidor();
  const a = await encolar(d, '7', 'CELO_OBSERVADO', '2026-10-01');
  const transport = transporte(srv);
  const getJson = transport.getJson.bind(transport);
  transport.getJson = async (pathname) => {
    if (pathname === SESSION_PATH) await d.repo.cancelarEventoReproductivoPendiente(a.operationId, { cuentaId: CUENTA_A }).catch(() => {});
    return getJson(pathname);
  };
  await createSyncEngine({ repo: d.repo, transport, now: d.clock.now }).syncNow();
  assert.deepEqual(srv.posts, []);
  assert.deepEqual(await d.repo.listOutbox(), []);
});

test('una operación enviándose no se puede editar ni cancelar', async () => {
  const d = dispositivo();
  await d.storage.put('animales', { key: 'srv:7', animalId: '7', sexo: 'HEMBRA', estado: 'ACTIVO' });
  const srv = servidor();
  const a = await encolar(d, '7', 'CELO_OBSERVADO', '2026-10-01');
  const errores = [];
  srv.alEnviar = async () => {
    await d.repo.editarEventoReproductivoPendiente({ operationId: a.operationId, body: { tipoEvento: 'CELO_OBSERVADO', fechaEvento: '2026-10-02' }, cuentaId: CUENTA_A }).catch((e) => errores.push(e.code));
    await d.repo.cancelarEventoReproductivoPendiente(a.operationId, { cuentaId: CUENTA_A }).catch((e) => errores.push(e.code));
  };
  await motor(d, srv).syncNow();
  assert.deepEqual(errores, ['EVENTO_PENDIENTE_EN_CURSO', 'EVENTO_PENDIENTE_EN_CURSO']);
  assert.equal(srv.eventos[0].fechaEvento, '2026-10-01');
});

// ---------------------------------------------------------------------------
// Tipos desconocidos
// ---------------------------------------------------------------------------

test('handlerDe: nunca lanza ni resuelve propiedades heredadas', () => {
  assert.equal(handlerDe('TIPO_FUTURO'), null);
  assert.equal(handlerDe('constructor'), null);
  assert.equal(handlerDe('__proto__'), null);
  assert.ok(handlerDe(REPRODUCCION_EVENTO_CREAR));
  assert.throws(() => handlerFor('TIPO_FUTURO'), /OPERACION_SIN_MANEJADOR/);
});

test('tipo desconocido CON cadena: se conserva intacto, detiene solo su cadena y no corta el ciclo', async () => {
  const d = dispositivo();
  const srv = servidor();
  const futura = await encolar(d, '7', 'CELO_OBSERVADO', '2026-10-01', { tipoOperacion: 'REPRODUCCION_EVENTO_ANULAR_FUTURO' });
  const siguiente = await encolar(d, '7', 'IATF', '2026-10-02');
  const otro = await encolar(d, '8', 'CELO_OBSERVADO', '2026-10-01');

  assert.equal(await motor(d, srv).syncNow(), RUN_RESULT.OK);
  assert.deepEqual(enviados(srv), [otro.clientOperationId]);
  assert.equal((await leer(d, siguiente)).estado, OUTBOX_ESTADOS.PENDIENTE);
  const marcada = await leer(d, futura);
  assert.ok(marcada.runtimeNoSoporta?.at);
  assert.deepEqual({ ...marcada, runtimeNoSoporta: null }, { ...futura, runtimeNoSoporta: null });
});

test('tipo desconocido SIN cadena: no detiene pesajes ni otras cadenas', async () => {
  const d = dispositivo();
  const srv = servidor();
  const clock = d.clock;
  const futura = { ...newOperation({ tipoOperacion: 'OPERACION_FUTURA', entidad: 'x', localUuid: 'lf', clientOperationId: 'cf', payload: { a: 1 }, deviceId: 'd', now: clock.now(), uuid: () => 'of' }) };
  await d.storage.put('outbox', futura);
  const repro = await encolar(d, '8', 'CELO_OBSERVADO', '2026-10-01');
  assert.equal(await motor(d, srv).syncNow(), RUN_RESULT.OK);
  assert.deepEqual(enviados(srv), [repro.clientOperationId]);
  const conservada = await d.storage.get('outbox', 'of');
  assert.equal(conservada.tipoOperacion, 'OPERACION_FUTURA');
  assert.ok(conservada.runtimeNoSoporta?.at);
});

test('tipo desconocido: la marca se escribe una vez (sin bucle de notificaciones)', async () => {
  const d = dispositivo();
  const srv = servidor();
  const futura = await encolar(d, '7', 'CELO_OBSERVADO', '2026-10-01', { tipoOperacion: 'OTRO_TIPO' });
  await motor(d, srv).syncNow();
  const primera = await leer(d, futura);
  let avisos = 0;
  d.repo.subscribe(() => { avisos += 1; });
  d.clock.avanzar(1000);
  await motor(d, srv).syncNow();
  assert.deepEqual(await leer(d, futura), primera);
  assert.equal(avisos > 1, false, 'solo el pull notifica');
});

test('un runtime que sí conoce el tipo limpia la marca y lo envía', async () => {
  const d = dispositivo();
  const srv = servidor();
  const a = await encolar(d, '7', 'CELO_OBSERVADO', '2026-10-01', { runtimeNoSoporta: { at: '2026-10-19T00:00:00.000Z' } });
  let enPleno = null;
  srv.alEnviar = async () => { enPleno = await leer(d, a); };
  await motor(d, srv).syncNow();
  assert.equal(enPleno.runtimeNoSoporta, null);
  assert.deepEqual(enviados(srv), [a.clientOperationId]);
});

// ---------------------------------------------------------------------------
// Identidad
// ---------------------------------------------------------------------------

test('otra cuenta de la MISMA organización: nunca envía, bloquea, y vuelve al regresar la original', async () => {
  const d = dispositivo();
  const srv = servidor();
  const a = await encolar(d, '7', 'CELO_OBSERVADO', '2026-10-01');
  const b = await encolar(d, '7', 'IATF', '2026-10-02');
  srv.sesion = { authenticated: true, cuenta: { cuentaId: CUENTA_B }, organizacionActiva: { organizacionId: ORG } };

  assert.equal(await motor(d, srv).syncNow(), RUN_RESULT.OK);
  assert.deepEqual(srv.posts, []);
  const bloqueada = await leer(d, a);
  assert.equal(bloqueada.estado, OUTBOX_ESTADOS.BLOQUEADA_POR_IDENTIDAD);
  assert.equal(bloqueada.origen.cuentaId, CUENTA_A, 'nunca se reasigna');
  assert.equal(bloqueada.intentos, 0);
  assert.equal(bloqueada.posibleEnServidor, false);
  assert.equal((await leer(d, b)).estado, OUTBOX_ESTADOS.PENDIENTE);
  assert.equal((await d.repo.contar()).bloqueadasIdentidad, 1);

  await motor(d, srv).syncNow({ forzar: true });
  assert.deepEqual(srv.posts, [], 'ni forzando');

  srv.sesion = { authenticated: true, cuenta: { cuentaId: CUENTA_A }, organizacionActiva: { organizacionId: ORG } };
  await motor(d, srv).syncNow();
  assert.deepEqual(enviados(srv), [a.clientOperationId, b.clientOperationId]);
  assert.ok(srv.posts.every((p) => p.cuenta === CUENTA_A));
  assert.deepEqual(await d.repo.listOutbox(), []);
});

test('otra organización en la sesión: no se envía', async () => {
  const d = dispositivo();
  const srv = servidor();
  const a = await encolar(d, '7', 'CELO_OBSERVADO', '2026-10-01');
  srv.sesion = { authenticated: true, cuenta: { cuentaId: CUENTA_A }, organizacionActiva: { organizacionId: OTRA_ORG } };
  await motor(d, srv).syncNow();
  assert.deepEqual(srv.posts, []);
  assert.equal((await leer(d, a)).estado, OUTBOX_ESTADOS.BLOQUEADA_POR_IDENTIDAD);
});

test('cuenta interna sin organización activa: no se envía', async () => {
  const d = dispositivo();
  const srv = servidor();
  await encolar(d, '7', 'CELO_OBSERVADO', '2026-10-01');
  srv.sesion = { authenticated: true, cuenta: { cuentaId: CUENTA_A }, rolInterno: 'superadmin', organizacionActiva: null };
  await motor(d, srv).syncNow();
  assert.deepEqual(srv.posts, []);
});

test('cadena mixta: la operación de otra cuenta espera a la suya y detiene lo posterior', async () => {
  const d = dispositivo();
  const srv = servidor();
  const a = await encolar(d, '7', 'CELO_OBSERVADO', '2026-10-01');
  const deB = await encolar(d, '7', 'CELO_OBSERVADO', '2026-10-02', { cuenta: CUENTA_B });
  const c = await encolar(d, '7', 'IATF', '2026-10-03');
  await motor(d, srv).syncNow();
  assert.deepEqual(enviados(srv), [a.clientOperationId]);
  assert.equal((await leer(d, deB)).estado, OUTBOX_ESTADOS.BLOQUEADA_POR_IDENTIDAD);
  assert.equal((await leer(d, c)).estado, OUTBOX_ESTADOS.PENDIENTE);
});

test('la sesión cambia a mitad del ciclo: la siguiente operación no sale con la cuenta nueva', async () => {
  const d = dispositivo();
  const srv = servidor();
  const a = await encolar(d, '7', 'CELO_OBSERVADO', '2026-10-01');
  const b = await encolar(d, '7', 'IATF', '2026-10-02');
  srv.trasResponder = () => {
    srv.trasResponder = null;
    srv.sesion = { authenticated: true, cuenta: { cuentaId: CUENTA_B }, organizacionActiva: { organizacionId: ORG } };
  };
  await motor(d, srv).syncNow();
  assert.deepEqual(enviados(srv), [a.clientOperationId]);
  assert.equal((await leer(d, b)).estado, OUTBOX_ESTADOS.BLOQUEADA_POR_IDENTIDAD);
});

test('la cookie cambia ENTRE la verificación y el POST: el servidor no escribe y la operación queda bloqueada', async () => {
  const d = dispositivo();
  const srv = servidor();
  const a = await encolar(d, '7', 'CELO_OBSERVADO', '2026-10-01');
  const b = await encolar(d, '7', 'IATF', '2026-10-02');
  const original = srv.sesion;
  // La verificación del cliente ya pasó con la cuenta A cuando llega este POST.
  srv.alEnviar = () => { srv.sesion = { authenticated: true, cuenta: { cuentaId: CUENTA_B }, organizacionActiva: { organizacionId: ORG } }; };

  assert.equal(await motor(d, srv).syncNow(), RUN_RESULT.OK);
  assert.deepEqual(srv.eventos, [], 'nada se escribió con la cuenta equivocada');
  const bloqueada = await leer(d, a);
  assert.equal(bloqueada.estado, OUTBOX_ESTADOS.BLOQUEADA_POR_IDENTIDAD);
  assert.equal(bloqueada.intentos, 0);
  assert.equal(bloqueada.posibleEnServidor, false, 'el servidor confirmó que no escribió');
  assert.equal(bloqueada.clientOperationId, a.clientOperationId);
  assert.equal(bloqueada.ultimoError.codigo, 'IDENTIDAD_NO_COINCIDE');
  assert.equal((await leer(d, b)).estado, OUTBOX_ESTADOS.PENDIENTE, 'la cadena no se adelanta');

  srv.alEnviar = null;
  srv.sesion = original;
  await motor(d, srv).syncNow();
  assert.deepEqual(srv.eventos.map((e) => e.clientOperationId), [a.clientOperationId, b.clientOperationId], 'vuelve a salir con su cuenta');
});

test('IDENTIDAD_NO_COINCIDE con un intento previo incierto conserva la incertidumbre', async () => {
  const d = dispositivo();
  const srv = servidor();
  const a = await encolar(d, '7', 'CELO_OBSERVADO', '2026-10-01', { posibleEnServidor: true });
  srv.alEnviar = () => { srv.sesion = { authenticated: true, cuenta: { cuentaId: CUENTA_B }, organizacionActiva: { organizacionId: ORG } }; };
  await motor(d, srv).syncNow();
  assert.equal((await leer(d, a)).posibleEnServidor, true);
});

test('pesajes y animales no envían identidadEsperada', () => {
  const op = { payload: { animalId: '7', fecha: 'f', pesoKg: 1, metodo: 'm', clientOperationId: 'c' } };
  assert.equal('identidadEsperada' in handlerDe('PESAJE_CREAR').request(op).body, false);
});

/** Lo único que un bloqueo por identidad puede tocar: su estado, el motivo y la marca de tiempo. */
const sinTransicion = ({ estado: _e, ultimoError: _u, updatedAt: _t, ...resto }) => resto;
const sesionDe = (cuentaId, organizacionId = ORG) => ({ authenticated: true, cuenta: { cuentaId }, organizacionActiva: { organizacionId } });

for (const [nombre, preparar, resultado] of [
  ['sesión expirada (200 sin autenticar)', (srv) => { srv.sesion = { authenticated: false }; }, RUN_RESULT.SESION_REQUERIDA],
  ['sesión expirada (401)', (srv) => { srv.fallaSesion = { status: 401, data: {} }; }, RUN_RESULT.SESION_REQUERIDA],
  ['respuesta sin cuenta', (srv) => { srv.sesion = { authenticated: true, cuenta: null }; }, RUN_RESULT.SESION_REQUERIDA],
  ['5xx al verificar', (srv) => { srv.fallaSesion = { status: 503, data: {} }; }, RUN_RESULT.ERROR],
]) {
  test(`identidad no verificable (${nombre}): no envía, bloquea, conserva todo y sale al volver su cuenta`, async () => {
    const d = dispositivo();
    const srv = servidor();
    const a = await encolar(d, '7', 'CELO_OBSERVADO', '2026-10-01', { posibleEnServidor: true, intentos: 2 });
    preparar(srv);
    assert.equal(await motor(d, srv).syncNow(), resultado);
    assert.deepEqual(srv.posts, []);
    const bloqueada = await leer(d, a);
    assert.equal(bloqueada.estado, OUTBOX_ESTADOS.BLOQUEADA_POR_IDENTIDAD);
    assert.equal(bloqueada.ultimoError.codigo, 'SESION_NO_VERIFICABLE');
    assert.deepEqual(sinTransicion(bloqueada), sinTransicion(a));

    srv.sesion = sesionDe(CUENTA_A);
    srv.fallaSesion = null;
    await motor(d, srv).syncNow();
    assert.deepEqual(enviados(srv), [a.clientOperationId], 'mismo id, misma cuenta');
    assert.deepEqual(await d.repo.listOutbox(), []);
  });
}

test('sin red al verificar: no envía y la operación no cambia en absoluto', async () => {
  const d = dispositivo();
  const srv = servidor();
  const a = await encolar(d, '7', 'CELO_OBSERVADO', '2026-10-01');
  srv.fallaSesion = 'red';
  assert.equal(await motor(d, srv).syncNow(), RUN_RESULT.OFFLINE);
  assert.deepEqual(srv.posts, []);
  assert.deepEqual(await leer(d, a), a);
});

for (const [nombre, origen] of [
  ['sin origen', null],
  ['origen sin cuenta', { organizacionId: ORG }],
  ['origen sin organización', { cuentaId: CUENTA_A }],
  ['cuenta vacía', { cuentaId: '', organizacionId: ORG }],
]) {
  test(`${nombre}: nunca se envía ni forzando, aunque haya sesión válida, y bloquea su cadena`, async () => {
    const d = dispositivo();
    const srv = servidor();
    const a = await encolar(d, '7', 'CELO_OBSERVADO', '2026-10-01', { origen });
    const b = await encolar(d, '7', 'IATF', '2026-10-02');
    const otra = await encolar(d, '8', 'CELO_OBSERVADO', '2026-10-01');
    await motor(d, srv).syncNow({ forzar: true });
    assert.deepEqual(enviados(srv), [otra.clientOperationId], 'la otra cadena sí sigue');
    const bloqueada = await leer(d, a);
    assert.equal(bloqueada.estado, OUTBOX_ESTADOS.BLOQUEADA_POR_IDENTIDAD);
    assert.equal(bloqueada.ultimoError.codigo, 'ORIGEN_NO_VERIFICABLE');
    assert.deepEqual(bloqueada.origen, origen, 'no se completa con la sesión activa');
    assert.equal((await leer(d, b)).estado, OUTBOX_ESTADOS.PENDIENTE);
  });
}

test('bloqueo por identidad: otra cuenta conserva todo y no vuelve a escribir en cada ciclo', async () => {
  const d = dispositivo();
  const srv = servidor();
  const a = await encolar(d, '7', 'CELO_OBSERVADO', '2026-10-01', { posibleEnServidor: true, intentos: 3 });
  srv.sesion = sesionDe(CUENTA_B);
  await motor(d, srv).syncNow();
  const bloqueada = await leer(d, a);
  assert.equal(bloqueada.ultimoError.codigo, 'IDENTIDAD_NO_COINCIDE');
  assert.deepEqual(sinTransicion(bloqueada), sinTransicion(a));
  d.clock.avanzar(1_000);
  await motor(d, srv).syncNow();
  assert.equal((await leer(d, a)).updatedAt, bloqueada.updatedAt);
});

test('logout y login: cuenta B no envía; expira; y al volver A sale con el mismo id', async () => {
  const d = dispositivo();
  const srv = servidor();
  const a = await encolar(d, '7', 'CELO_OBSERVADO', '2026-10-01');
  srv.sesion = { authenticated: false };
  assert.equal(await motor(d, srv).syncNow(), RUN_RESULT.SESION_REQUERIDA);
  srv.sesion = sesionDe(CUENTA_B);
  await motor(d, srv).syncNow();
  assert.equal((await leer(d, a)).ultimoError.codigo, 'IDENTIDAD_NO_COINCIDE', 'el motivo se actualiza');
  assert.deepEqual(srv.posts, []);
  srv.sesion = sesionDe(CUENTA_A);
  await motor(d, srv).syncNow();
  assert.deepEqual(srv.posts.map((p) => [p.body.clientOperationId, p.cuenta]), [[a.clientOperationId, CUENTA_A]]);
  assert.deepEqual(srv.posts[0].body.identidadEsperada, { organizacionId: ORG, cuentaId: CUENTA_A });
});

test('la cookie pasa a una cuenta sin rol durante el POST: 403 sin escribir queda BLOQUEADA, no RECHAZADO', async () => {
  const d = dispositivo();
  const srv = servidor();
  const a = await encolar(d, '7', 'CELO_OBSERVADO', '2026-10-01');
  const b = await encolar(d, '7', 'IATF', '2026-10-02');
  srv.alEnviar = () => { srv.sesion = sesionDe(CUENTA_B); };
  srv.falla = () => ({ status: 403, failure: 'ROLE_FORBIDDEN', data: { error: 'ROLE_FORBIDDEN' } });
  await motor(d, srv).syncNow();
  assert.deepEqual(srv.eventos, []);
  const bloqueada = await leer(d, a);
  assert.equal(bloqueada.estado, OUTBOX_ESTADOS.BLOQUEADA_POR_IDENTIDAD);
  assert.equal(bloqueada.ultimoError.codigo, 'IDENTIDAD_NO_COINCIDE');
  assert.equal(bloqueada.intentos, 0);
  assert.equal(bloqueada.posibleEnServidor, false);
  assert.equal((await leer(d, b)).estado, OUTBOX_ESTADOS.PENDIENTE);

  srv.alEnviar = null;
  srv.falla = null;
  srv.sesion = sesionDe(CUENTA_A);
  await motor(d, srv).syncNow();
  assert.deepEqual(srv.eventos.map((e) => e.clientOperationId), [a.clientOperationId, b.clientOperationId]);
});

test('403 de rol y la sesión no se puede verificar después: no se da por rechazada', async () => {
  const d = dispositivo();
  const srv = servidor();
  const a = await encolar(d, '7', 'CELO_OBSERVADO', '2026-10-01');
  srv.alEnviar = () => { srv.fallaSesion = 'red'; };
  srv.falla = () => ({ status: 403, data: { error: 'ROLE_FORBIDDEN' } });
  await motor(d, srv).syncNow();
  const bloqueada = await leer(d, a);
  assert.equal(bloqueada.estado, OUTBOX_ESTADOS.BLOQUEADA_POR_IDENTIDAD);
  assert.equal(bloqueada.ultimoError.codigo, 'SESION_NO_VERIFICABLE');
});

test('403 de rol con la MISMA cuenta en la sesión: sigue siendo un rechazo real', async () => {
  const d = dispositivo();
  const srv = servidor();
  const a = await encolar(d, '7', 'CELO_OBSERVADO', '2026-10-01');
  srv.falla = () => ({ status: 403, data: { error: 'ROLE_FORBIDDEN' } });
  await motor(d, srv).syncNow();
  assert.equal((await leer(d, a)).estado, OUTBOX_ESTADOS.RECHAZADO);
});

test('otra cuenta no puede cancelar ni editar la operación, y una cuenta nula tampoco', async () => {
  const d = dispositivo();
  const a = await encolar(d, '7', 'CELO_OBSERVADO', '2026-10-01');
  await assert.rejects(d.repo.cancelarEventoReproductivoPendiente(a.operationId, { cuentaId: CUENTA_B }), { code: 'BLOQUEADA_POR_IDENTIDAD' });
  await assert.rejects(d.repo.cancelarEventoReproductivoPendiente(a.operationId), { code: 'BLOQUEADA_POR_IDENTIDAD' });
  await assert.rejects(d.repo.editarEventoReproductivoPendiente({ operationId: a.operationId, body: { tipoEvento: 'IATF', fechaEvento: '2026-10-02' }, cuentaId: CUENTA_B }), { code: 'BLOQUEADA_POR_IDENTIDAD' });
  assert.deepEqual(await leer(d, a), a);
});

test('la operación bloqueada cuenta como pendiente: cerrar sesión no purga su base', async () => {
  const dispositivoStorage = createMemoryStorage(DEVICE_STORES);
  const d = dispositivo();
  const a = await encolar(d, '7', 'CELO_OBSERVADO', '2026-10-01');
  await d.storage.put('outbox', { ...a, estado: OUTBOX_ESTADOS.BLOQUEADA_POR_IDENTIDAD });
  const borradas = [];
  const resultado = await cerrarSesionOffline(dispositivoStorage, ORG, {
    contarPendientes: async () => contarOutboxNoSincronizado(await d.storage.getAll('outbox')),
    borrarBase: async (nombre) => { borradas.push(nombre); },
  });
  assert.deepEqual(resultado, { conservada: true, pendientes: 1 });
  assert.deepEqual(borradas, []);
  assert.equal((await leer(d, a)).origen.cuentaId, CUENTA_A);
});

test('una operación en backoff no consulta la sesión', async () => {
  const d = dispositivo();
  const srv = servidor();
  await encolar(d, '7', 'CELO_OBSERVADO', '2026-10-01', { estado: OUTBOX_ESTADOS.ERROR_REINTENTABLE, siguienteIntentoAt: new Date(d.clock.now().getTime() + 60_000).toISOString() });
  srv.fallaSesion = 'red';
  assert.equal(await motor(d, srv).syncNow(), RUN_RESULT.OK);
});

test('leerIdentidadSesion: contrato de /auth/session', async () => {
  const con = (respuesta) => ({ getJson: async () => respuesta });
  assert.deepEqual(await leerIdentidadSesion(con({ ok: true, status: 200, data: { authenticated: true, cuenta: { cuentaId: CUENTA_A }, organizacionActiva: { organizacionId: ORG } } })), { estado: 'OK', cuentaId: CUENTA_A, organizacionId: ORG });
  assert.deepEqual(await leerIdentidadSesion(con({ ok: true, status: 200, data: { authenticated: false } })), { estado: 'SIN_SESION' });
  assert.deepEqual(await leerIdentidadSesion(con({ ok: false, status: 401, data: {} })), { estado: 'SIN_SESION' });
  assert.deepEqual(await leerIdentidadSesion(con({ ok: false, status: 0, failure: 'NETWORK_ERROR' })), { estado: 'SIN_RED' });
  assert.deepEqual(await leerIdentidadSesion(con({ ok: false, status: 500, data: {} })), { estado: 'NO_VERIFICABLE' });
  assert.deepEqual(await leerIdentidadSesion({ getJson: async () => { throw new TypeError('x'); } }), { estado: 'SIN_RED' });
});

// ---------------------------------------------------------------------------
// Operaciones sin cadena: comportamiento anterior
// ---------------------------------------------------------------------------

test('los pesajes no consultan la sesión ni usan cadena, y su backoff no detiene al siguiente', async () => {
  const d = dispositivo();
  const posts = [];
  let consultas = 0;
  const transport = {
    async postJson(pathname, body) {
      posts.push(body.clientOperationId);
      return { ok: true, status: 201, data: { pesaje: {} } };
    },
    async getJson(pathname) {
      if (pathname === SESSION_PATH) consultas += 1;
      return { ok: true, status: 200, data: { organizacionId: ORG, cursor: 'c', completo: false, animales: [], chapetas: [], predios: [], potreros: [], razas: [], categorias: [] } };
    },
  };
  const pesaje = (id, extra = {}) => ({
    ...newOperation({ tipoOperacion: 'PESAJE_CREAR', entidad: 'pesaje', localUuid: `l${id}`, clientOperationId: id, payload: { animalId: '7', fecha: '2026-10-01', pesoKg: 1, metodo: 'BASCULA', clientOperationId: id }, deviceId: 'd', now: d.clock.now(), uuid: () => `o${id}` }),
    ...extra,
  });
  await d.storage.put('outbox', pesaje('p1', { estado: OUTBOX_ESTADOS.ERROR_REINTENTABLE, siguienteIntentoAt: new Date(d.clock.now().getTime() + 60_000).toISOString() }));
  await d.storage.put('outbox', pesaje('p2'));
  await createSyncEngine({ repo: d.repo, transport, now: d.clock.now }).syncNow();
  assert.deepEqual(posts, ['p2']);
  assert.equal(consultas, 0);
});

test('ordenarOutbox se mantiene estable para la cadena', () => {
  const ops = [{ createdAt: 'b', operationId: '1' }, { createdAt: 'a', operationId: '2' }];
  assert.deepEqual(ordenarOutbox(ops).map((o) => o.operationId), ['2', '1']);
});
