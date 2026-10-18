// FASE-14 (PR 3) -- endurecimiento de la sincronización offline:
//   * un fallo de RED no suma intento ni backoff exponencial;
//   * al volver la red (online / visible) se reintenta ya, sin adelantar
//     408/429/5xx (que conservan su backoff);
//   * lock por organización (navigator.locks) entre motores;
//   * SINCRONIZANDO reciente no se roba sin lock exclusivo.
// JS puro, sin navegador: almacenamiento en memoria, reloj y red simulados.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { ORG_STORES } from '../offlineSchema.js';
import { createMemoryStorage } from '../storage.js';
import { createLocalRepo } from '../localRepo.js';
import { createSyncEngine, RUN_RESULT, RED_REINTENTO_MS, SINCRONIZANDO_LEASE_MS, esFalloDeRed } from '../syncEngine.js';
import { OUTBOX_ESTADOS, backoffMs, esErrorDeRed } from '../outbox.js';
import { startAutoSync } from '../autoSync.js';
import { createNavigatorLock, syncLockName } from '../browserOffline.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OFFLINE_DIR = path.resolve(__dirname, '..');
const ORG = '11111111-1111-4111-8111-111111111111';
const CODIGO = 'AGX-000002';

function reloj(inicio = '2026-10-18T12:00:00.000Z') {
  let t = new Date(inicio).getTime();
  return { now: () => new Date(t), avanzar: (ms) => { t += ms; } };
}

/** Servidor mínimo e idempotente por clientOperationId (como el real). */
function servidor() {
  const animales = new Map();
  const posts = [];
  let siguiente = 1;
  return {
    animales,
    posts,
    responder(body) {
      const existente = animales.get(body.clientOperationId);
      if (existente) return { ok: true, status: 200, data: { animal: existente, yaExistia: true } };
      const animal = { animalId: String(siguiente++), nombre: body.nombre, estado: 'ACTIVO', clientOperationId: body.clientOperationId };
      animales.set(body.clientOperationId, animal);
      return { ok: true, status: 201, data: { animal, yaExistia: false } };
    },
  };
}

function transporte(srv, { red = { online: true }, respuesta = null, retener = null } = {}) {
  return {
    async postJson(pathname, body) {
      srv.posts.push(pathname);
      if (!red.online) throw new TypeError('Failed to fetch');
      if (retener) await retener();
      if (respuesta) return respuesta;
      return srv.responder(body);
    },
    async getJson() {
      if (!red.online) throw new TypeError('Failed to fetch');
      return { ok: true, status: 200, data: { organizacionId: ORG, cursor: 'c', completo: false, animales: [], chapetas: [], predios: [], potreros: [], razas: [], categorias: [] } };
    },
  };
}

async function dispositivo({ online = true, conChapeta = false } = {}) {
  const storage = createMemoryStorage(ORG_STORES);
  const repo = createLocalRepo(storage, { organizacionId: ORG, deviceId: randomUUID() });
  if (conChapeta) await storage.put('chapetas', { codigoVisible: CODIGO, estado: 'ASIGNADO_ORGANIZACION', animalId: null, reservaLocalUuid: null, tokenHash: null });
  return { storage, repo, red: { online } };
}

async function registrar(repo, { chapeta = null } = {}) {
  const body = { clientOperationId: randomUUID(), predioId: '7', numeroVisual: null, nombre: `QA ${randomUUID().slice(0, 4)}`, sexo: 'HEMBRA', nacimientoTipo: 'DESCONOCIDA', razaTipo: 'DESCONOCIDA' };
  const { localUuid } = await repo.registrarAnimalLocal({ body, chapetaCodigo: chapeta });
  return { localUuid, body };
}

const unaOp = async (repo) => (await repo.listOutbox())[0];

/** navigator.locks simulado con exclusión real (request / ifAvailable). */
function fakeLocks() {
  const tomados = new Set();
  const colas = new Map();
  return {
    async request(nombre, opciones, callback) {
      if (typeof opciones === 'function') { callback = opciones; opciones = {}; }
      if (opciones.ifAvailable && tomados.has(nombre)) return callback(null);
      while (tomados.has(nombre)) await new Promise((resolve) => (colas.get(nombre) ?? colas.set(nombre, []).get(nombre)).push(resolve));
      tomados.add(nombre);
      try {
        return await callback({ name: nombre });
      } finally {
        tomados.delete(nombre);
        colas.get(nombre)?.shift()?.();
      }
    },
  };
}

// ---------------------------------------------------------------------
// Clasificación de fallos
// ---------------------------------------------------------------------

test('esFalloDeRed: solo sin respuesta HTTP (status 0); un 5xx/408/429 nunca es red', () => {
  assert.equal(esFalloDeRed({ ok: false, status: 0, failure: 'NETWORK_ERROR' }), true);
  assert.equal(esFalloDeRed({ ok: false, status: 0, failure: 'REQUEST_NOT_SENT' }), true);
  assert.equal(esFalloDeRed({ ok: false, status: 0 }), true);
  for (const status of [500, 503, 408, 429]) assert.equal(esFalloDeRed({ ok: false, status }), false, String(status));
  assert.equal(esFalloDeRed({ ok: false, status: 503, failure: 'REQUEST_NOT_SENT' }), false, '/csrf con 5xx es HTTP');
  assert.equal(esFalloDeRed({ ok: false, status: 0, failure: 'SESSION_EXPIRED' }), false);
});

test('1. sin red antes de enviar: no hay POST ni se suma intento', async () => {
  const srv = servidor();
  const d = await dispositivo({ online: false });
  await registrar(d.repo);
  const engine = createSyncEngine({ repo: d.repo, transport: transporte(srv, { red: d.red }), isOnline: () => d.red.online });
  assert.equal(await engine.syncNow(), RUN_RESULT.OFFLINE);
  assert.equal(srv.posts.length, 0);
  const op = await unaOp(d.repo);
  assert.equal(op.estado, OUTBOX_ESTADOS.PENDIENTE);
  assert.equal(op.intentos, 0);
});

test('2. fetch lanza error de red: la operación queda pendiente, sin sumar intento ni backoff exponencial', async () => {
  const srv = servidor();
  const d = await dispositivo();
  await registrar(d.repo);
  const r = reloj();
  // navigator.onLine "miente" (lie-fi): el motor intenta y el fetch falla.
  const engine = createSyncEngine({ repo: d.repo, transport: transporte(srv, { red: { online: false } }), isOnline: () => true, now: r.now, random: () => 0.5 });
  for (let i = 0; i < 4; i += 1) {
    assert.equal(await engine.syncNow({ forzar: true }), RUN_RESULT.OFFLINE);
    r.avanzar(1000);
  }
  const op = await unaOp(d.repo);
  assert.equal(op.estado, OUTBOX_ESTADOS.ERROR_REINTENTABLE);
  assert.equal(op.intentos, 0, 'cuatro fallos de red no suman intentos');
  assert.equal(op.ultimoError.tipo, 'red');
  assert.equal(new Date(op.siguienteIntentoAt).getTime() - r.now().getTime() + 1000, RED_REINTENTO_MS, 'espera fija, no exponencial');
});

test('3. evento online: la operación con fallo de RED pasa a "ahora" y se envía de inmediato', async () => {
  const srv = servidor();
  const d = await dispositivo();
  await registrar(d.repo);
  const r = reloj();
  const red = { online: false };
  const engine = createSyncEngine({ repo: d.repo, transport: transporte(srv, { red }), isOnline: () => true, now: r.now });
  await engine.syncNow();
  assert.ok((await unaOp(d.repo)).siguienteIntentoAt > r.now().toISOString(), 'espera vigente');

  red.online = true;
  const win = new EventTarget();
  const auto = startAutoSync({ engine, repo: d.repo, win, doc: null, serviceWorker: null, setTimer: () => 0, clearTimer: () => {}, now: r.now });
  await auto.primera; // apertura: la espera sigue vigente -> no envía
  assert.equal(srv.animales.size, 0);
  win.dispatchEvent(new Event('online'));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(srv.animales.size, 1, 'enviado al volver la red, sin esperar el reintento');
  assert.deepEqual(await d.repo.listOutbox(), []);
  auto.stop();
});

for (const status of [500, 429, 408]) {
  test(`4-7. HTTP ${status}: suma intento, programa backoff exponencial y el evento online NO lo adelanta`, async () => {
    const srv = servidor();
    const d = await dispositivo();
    await registrar(d.repo);
    const r = reloj();
    const engine = createSyncEngine({ repo: d.repo, transport: transporte(srv, { respuesta: { ok: false, status, data: { error: 'X' } } }), now: r.now, random: () => 0.5 });
    assert.equal(await engine.syncNow(), RUN_RESULT.ERROR);
    const op = await unaOp(d.repo);
    assert.equal(op.intentos, 1);
    assert.equal(op.ultimoError.tipo, 'http');
    assert.equal(op.siguienteIntentoAt, new Date(r.now().getTime() + backoffMs(1, () => 0.5)).toISOString());

    assert.equal(await engine.reactivarFallosDeRed(), 0);
    assert.equal((await unaOp(d.repo)).siguienteIntentoAt, op.siguienteIntentoAt, 'conserva su backoff');
    const posts = srv.posts.length;
    assert.equal(await engine.syncNow(), RUN_RESULT.OK, 'ciclo sin envíos: aún no vence');
    assert.equal(srv.posts.length, posts);
  });
}

test('8. 400 y 403 (no CSRF) -> RECHAZADO, sin reintento; 401 -> PENDIENTE sin sumar intento y el ciclo se detiene', async () => {
  for (const status of [400, 403]) {
    const srv = servidor();
    const d = await dispositivo();
    await registrar(d.repo);
    const engine = createSyncEngine({ repo: d.repo, transport: transporte(srv, { respuesta: { ok: false, status, data: { error: 'INVALID' } } }) });
    await engine.syncNow();
    assert.equal((await unaOp(d.repo)).estado, OUTBOX_ESTADOS.RECHAZADO, String(status));
    await engine.syncNow({ forzar: true });
    await engine.syncNow({ forzar: true });
    assert.equal(srv.posts.length, 1, `${status}: nunca se reenvía solo`);
  }
  const srv = servidor();
  const d = await dispositivo();
  await registrar(d.repo);
  const engine = createSyncEngine({ repo: d.repo, transport: transporte(srv, { respuesta: { ok: false, status: 401, failure: 'SESSION_EXPIRED', data: { error: 'SESSION_EXPIRED' } } }) });
  assert.equal(await engine.syncNow(), RUN_RESULT.SESION_REQUERIDA);
  const op = await unaOp(d.repo);
  assert.equal(op.estado, OUTBOX_ESTADOS.PENDIENTE);
  assert.equal(op.intentos, 0);
  assert.equal(srv.posts.length, 1, 'un POST por ciclo, sin bucle interno');
});

test('9. 409 QR_YA_ASOCIADO sigue siendo CONFLICTO (no un reintento genérico) y libera la reserva local', async () => {
  const srv = servidor();
  const d = await dispositivo({ conChapeta: true });
  const { localUuid } = await registrar(d.repo, { chapeta: CODIGO });
  const engine = createSyncEngine({ repo: d.repo, transport: transporte(srv, { respuesta: { ok: false, status: 409, data: { error: 'QR_YA_ASOCIADO', message: 'Esta chapeta ya está asociada a otro animal.' } } }) });
  await engine.syncNow();
  const op = await unaOp(d.repo);
  assert.equal(op.estado, OUTBOX_ESTADOS.CONFLICTO);
  assert.equal(op.ultimoError.codigo, 'QR_YA_ASOCIADO');
  assert.equal(await engine.reactivarFallosDeRed(), 0);
  const chapeta = await d.repo.getChapetaPorCodigo(CODIGO);
  assert.equal(chapeta.reservaLocalUuid, null);
  assert.equal((await d.storage.get('animales', `loc:${localUuid}`)).estadoSync, 'CONFLICTO');
});

// ---------------------------------------------------------------------
// Concurrencia
// ---------------------------------------------------------------------

function retenedor() {
  let soltar;
  const barrera = new Promise((resolve) => { soltar = resolve; });
  let llamadas = 0;
  return { retener: async () => { llamadas += 1; if (llamadas === 1) await barrera; }, soltar: () => soltar() };
}

test('10 / F. carrera CON lock: dos motores de la misma organización -> un solo POST', async () => {
  const srv = servidor();
  const d = await dispositivo();
  await registrar(d.repo);
  const locks = fakeLocks();
  const ret = retenedor();
  const transport = transporte(srv, { retener: ret.retener });
  const lockA = createNavigatorLock(syncLockName(ORG), locks);
  const lockB = createNavigatorLock(syncLockName(ORG), locks);
  const A = createSyncEngine({ repo: d.repo, transport, lock: lockA });
  const B = createSyncEngine({ repo: d.repo, transport, lock: lockB });

  const cicloA = A.syncNow();
  await new Promise((resolve) => setTimeout(resolve, 5)); // A ya está enviando
  assert.equal(await B.syncNow(), RUN_RESULT.EN_CURSO, 'B cede: el lock lo tiene A');
  ret.soltar();
  assert.equal(await cicloA, RUN_RESULT.OK);
  assert.equal(srv.posts.length, 1);
  assert.equal(srv.animales.size, 1);
  assert.deepEqual(await d.repo.listOutbox(), []);
});

test('un ciclo forzado (preparar / "Sincronizar ahora") espera el lock en vez de ceder', async () => {
  const srv = servidor();
  const d = await dispositivo();
  await registrar(d.repo);
  const locks = fakeLocks();
  const ret = retenedor();
  const transport = transporte(srv, { retener: ret.retener });
  const A = createSyncEngine({ repo: d.repo, transport, lock: createNavigatorLock(syncLockName(ORG), locks) });
  const B = createSyncEngine({ repo: d.repo, transport, lock: createNavigatorLock(syncLockName(ORG), locks) });
  const cicloA = A.syncNow();
  await new Promise((resolve) => setTimeout(resolve, 5));
  const cicloB = B.syncNow({ forzar: true });
  ret.soltar();
  assert.equal(await cicloA, RUN_RESULT.OK);
  assert.equal(await cicloB, RUN_RESULT.OK, 'B corrió después de A');
  assert.equal(srv.posts.length, 1, 'B ya no encontró nada que enviar');
});

test('F. carrera SIN lock: el lease evita robar un SINCRONIZANDO reciente; si vence, dos POST pero sin duplicar datos y estado consistente', async () => {
  // a) dentro del lease: B no reenvía lo que A está enviando.
  {
    const srv = servidor();
    const d = await dispositivo();
    await registrar(d.repo);
    const ret = retenedor();
    const transport = transporte(srv, { retener: ret.retener });
    const A = createSyncEngine({ repo: d.repo, transport });
    const B = createSyncEngine({ repo: d.repo, transport });
    const cicloA = A.syncNow();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await B.syncNow();
    ret.soltar();
    await cicloA;
    assert.equal(srv.posts.length, 1, 'sin lock y dentro del lease: un solo POST');
  }
  // b) A colgado más que el lease: B lo recupera -> 2 POST, idempotencia.
  {
    const srv = servidor();
    const d = await dispositivo();
    await registrar(d.repo);
    const ret = retenedor();
    const r = reloj(new Date().toISOString());
    const transport = transporte(srv, { retener: ret.retener });
    const A = createSyncEngine({ repo: d.repo, transport, now: r.now });
    const B = createSyncEngine({ repo: d.repo, transport, now: () => new Date(r.now().getTime() + SINCRONIZANDO_LEASE_MS + 1000) });
    const cicloA = A.syncNow();
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(await B.syncNow(), RUN_RESULT.OK);
    ret.soltar();
    await cicloA;
    assert.equal(srv.posts.length, 2, 'sin lock y lease vencido: dos POST');
    assert.equal(srv.animales.size, 1, 'el servidor no duplica (idempotencia)');
    assert.deepEqual(await d.repo.listOutbox(), [], 'outbox consistente');
    const animales = await d.storage.getAll('animales');
    assert.equal(animales.length, 1, 'un solo animal local');
    assert.equal(animales[0].key, `srv:${[...srv.animales.values()][0].animalId}`);
  }
});

test('con lock exclusivo, un SINCRONIZANDO reciente se recupera de inmediato (nadie más puede estar enviándolo)', async () => {
  const srv = servidor();
  const d = await dispositivo();
  await registrar(d.repo);
  const op = await unaOp(d.repo);
  await d.repo.putOperacion({ ...op, estado: OUTBOX_ESTADOS.SINCRONIZANDO, updatedAt: new Date().toISOString() });
  const conLock = createSyncEngine({ repo: d.repo, transport: transporte(srv), lock: createNavigatorLock(syncLockName(ORG), fakeLocks()) });
  assert.equal(await conLock.syncNow(), RUN_RESULT.OK);
  assert.equal(srv.animales.size, 1);
});

test('11. sin navigator.locks: createNavigatorLock devuelve null y el motor sincroniza igual', async () => {
  assert.equal(createNavigatorLock('x', null), null);
  assert.equal(createNavigatorLock('x', {}), null);
  const srv = servidor();
  const d = await dispositivo();
  await registrar(d.repo);
  const engine = createSyncEngine({ repo: d.repo, transport: transporte(srv), lock: createNavigatorLock('x', null) });
  assert.equal(await engine.syncNow(), RUN_RESULT.OK);
  assert.equal(srv.animales.size, 1);
  assert.equal(syncLockName(ORG), `agx-sync-${ORG}`);
});

// ---------------------------------------------------------------------
// visibilitychange / compatibilidad / Service Worker
// ---------------------------------------------------------------------

test('12. visibilitychange con red: adelanta SOLO los fallos de red; un 503 conserva su backoff', async () => {
  const srv = servidor();
  const d = await dispositivo();
  const r = reloj();
  const { body: bodyRed } = await registrar(d.repo);
  r.avanzar(1000);
  await registrar(d.repo);
  const [opRed, opHttp] = await d.repo.listOutbox();
  const futuro = new Date(r.now().getTime() + 10 * 60_000).toISOString();
  await d.repo.putOperacion({ ...opRed, estado: OUTBOX_ESTADOS.ERROR_REINTENTABLE, ultimoError: { codigo: 'NETWORK_ERROR', status: 0, tipo: 'red' }, siguienteIntentoAt: futuro });
  await d.repo.putOperacion({ ...opHttp, estado: OUTBOX_ESTADOS.ERROR_REINTENTABLE, intentos: 3, ultimoError: { codigo: 'X', status: 503, tipo: 'http' }, siguienteIntentoAt: futuro });

  const engine = createSyncEngine({ repo: d.repo, transport: transporte(srv), now: r.now });
  const doc = Object.assign(new EventTarget(), { visibilityState: 'hidden' });
  const auto = startAutoSync({ engine, repo: d.repo, win: null, doc, serviceWorker: null, setTimer: () => 0, clearTimer: () => {}, now: r.now });
  await auto.primera;
  assert.equal(srv.posts.length, 0, 'ambas esperan');
  doc.visibilityState = 'visible';
  doc.dispatchEvent(new Event('visibilitychange'));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(srv.posts.length, 1, 'solo la de red');
  assert.ok(srv.animales.has(bodyRed.clientOperationId));
  const [restante] = await d.repo.listOutbox();
  assert.equal(restante.operationId, opHttp.operationId);
  assert.equal(restante.siguienteIntentoAt, futuro, 'el 503 conserva su backoff');
  auto.stop();
});

test('visibilitychange SIN red no adelanta nada', async () => {
  const d = await dispositivo();
  await registrar(d.repo);
  const op = await unaOp(d.repo);
  const futuro = '2099-01-01T00:00:00.000Z';
  await d.repo.putOperacion({ ...op, estado: OUTBOX_ESTADOS.ERROR_REINTENTABLE, ultimoError: { codigo: 'NETWORK_ERROR', status: 0, tipo: 'red' }, siguienteIntentoAt: futuro });
  const engine = createSyncEngine({ repo: d.repo, transport: transporte(servidor()), isOnline: () => false });
  assert.equal(await engine.reactivarFallosDeRed(), 0);
  assert.equal((await unaOp(d.repo)).siguienteIntentoAt, futuro);
});

test('13. operaciones anteriores sin ultimoError.tipo siguen funcionando (status 0 = red; 5xx = http)', async () => {
  assert.equal(esErrorDeRed({ ultimoError: { codigo: 'NETWORK_ERROR', mensaje: null, status: 0 } }), true);
  assert.equal(esErrorDeRed({ ultimoError: { codigo: 'X', mensaje: null, status: 503 } }), false);
  assert.equal(esErrorDeRed({ ultimoError: null }), false);
  assert.equal(esErrorDeRed({}), false);

  const srv = servidor();
  const d = await dispositivo();
  await registrar(d.repo);
  const op = await unaOp(d.repo);
  // Formato previo a FASE-14: intentos=5 por fallos de red, sin `tipo`.
  await d.repo.putOperacion({ ...op, estado: OUTBOX_ESTADOS.ERROR_REINTENTABLE, intentos: 5, ultimoError: { codigo: 'NETWORK_ERROR', mensaje: null, status: 0 }, siguienteIntentoAt: '2099-01-01T00:00:00.000Z' });
  const engine = createSyncEngine({ repo: d.repo, transport: transporte(srv) });
  assert.equal(await engine.reactivarFallosDeRed(), 1);
  assert.equal(await engine.syncNow(), RUN_RESULT.OK);
  assert.equal(srv.animales.size, 1);
});

test('14. Service Worker: aunque self.navigator.onLine diga "online", un fallo de red no suma intento; usa el mismo lock por organización', async () => {
  const srv = servidor();
  const d = await dispositivo();
  await registrar(d.repo);
  // Mismo motor que crea swSyncEntry.js, con isOnline optimista.
  const engine = createSyncEngine({ repo: d.repo, transport: transporte(srv, { red: { online: false } }), isOnline: () => true, lock: createNavigatorLock(syncLockName(ORG), fakeLocks()) });
  assert.equal(await engine.syncNow({ motivo: 'background-sync' }), RUN_RESULT.OFFLINE);
  const op = await unaOp(d.repo);
  assert.equal(op.intentos, 0);
  assert.equal(op.ultimoError.tipo, 'red');

  const swEntry = fs.readFileSync(path.join(OFFLINE_DIR, 'swSyncEntry.js'), 'utf8');
  assert.match(swEntry, /lock: createNavigatorLock\(syncLockName\(perfil\.organizacionId\), self\.navigator\?\.locks\)/);
  const browser = fs.readFileSync(path.join(OFFLINE_DIR, 'browserOffline.js'), 'utf8');
  assert.match(browser, /const lock = createNavigatorLock\(syncLockName\(organizacionId\)\);/);
});

test('10b. carrera con la Web Locks API REAL (Node 24 implementa navigator.locks): un solo POST', { skip: typeof globalThis.navigator?.locks?.request !== 'function' }, async () => {
  const srv = servidor();
  const d = await dispositivo();
  await registrar(d.repo);
  const ret = retenedor();
  const transport = transporte(srv, { retener: ret.retener });
  const nombre = syncLockName(`${ORG}-${randomUUID()}`);
  const A = createSyncEngine({ repo: d.repo, transport, lock: createNavigatorLock(nombre, globalThis.navigator.locks) });
  const B = createSyncEngine({ repo: d.repo, transport, lock: createNavigatorLock(nombre, globalThis.navigator.locks) });
  const cicloA = A.syncNow();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(await B.syncNow(), RUN_RESULT.EN_CURSO);
  ret.soltar();
  assert.equal(await cicloA, RUN_RESULT.OK);
  assert.equal(srv.posts.length, 1);
});
