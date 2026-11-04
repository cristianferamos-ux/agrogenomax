// Estado online/offline tras reconectar: un fallo transitorio al volver la red
// no puede dejar la interfaz en OFFLINE ni disparar envíos de más.
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
import { RUN_RESULT, calcularOnline, computeSyncIndicator, createSyncEngine } from '../syncEngine.js';
import { startAutoSync } from '../autoSync.js';
import { OUTBOX_ESTADOS, REPRODUCCION_EVENTO_CREAR, claveOrdenAnimal, newOperation } from '../outbox.js';
import { createNavigatorLock, syncLockName } from '../browserOffline.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ORG = '11111111-1111-4111-8111-111111111111';
const CUENTA = 'aaaaaaaa-0000-4000-8000-000000000001';
const SESSION_PATH = '/api/ganaderia/auth/session';
const PULL_PATH = '/api/ganaderia/sync/pull';
const PROVIDER = fs.readFileSync(path.resolve(__dirname, '../GanaderiaOfflineProvider.jsx'), 'utf8');

const asentar = async () => {
  for (let i = 0; i < 30; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

function escenario() {
  const storage = createMemoryStorage(ORG_STORES);
  let instante = new Date('2026-11-04T12:00:00.000Z').getTime();
  const now = () => new Date(instante);
  const repo = createLocalRepo(storage, { organizacionId: ORG, deviceId: randomUUID(), now });
  // falloGet / falloPost: (pathname) => respuesta HTTP fallida, o null para responder bien.
  const red = { navegador: true, servidor: true, falloGet: null, falloPost: null };
  const posts = [];
  const intentosPost = [];
  const vistos = new Map();
  const transport = {
    async postJson(pathname, body) {
      if (!red.servidor) throw new TypeError('Failed to fetch');
      intentosPost.push(body.clientOperationId);
      const fallo = red.falloPost?.(pathname);
      if (fallo) return { ok: false, data: null, ...fallo };
      posts.push(body.clientOperationId);
      const animal = vistos.get(body.clientOperationId) ?? { animalId: String(vistos.size + 1), nombre: body.nombre, estado: 'ACTIVO', clientOperationId: body.clientOperationId };
      vistos.set(body.clientOperationId, animal);
      return { ok: true, status: 201, data: { animal, yaExistia: false } };
    },
    async getJson(pathname) {
      if (!red.servidor) throw new TypeError('Failed to fetch');
      const fallo = red.falloGet?.(pathname);
      if (fallo) return { ok: false, data: null, ...fallo };
      if (pathname === SESSION_PATH) return { ok: true, status: 200, data: { authenticated: true, cuenta: { cuentaId: CUENTA }, organizacionActiva: { organizacionId: ORG } } };
      return { ok: true, status: 200, data: { organizacionId: ORG, cursor: 'c', completo: false, animales: [], chapetas: [], predios: [], potreros: [], razas: [], categorias: [] } };
    },
  };
  return { storage, repo, red, posts, intentosPost, transport, now, avanzar: (ms) => { instante += ms; }, isOnline: () => red.navegador };
}

const registrar = (repo) => repo.registrarAnimalLocal({
  body: { clientOperationId: randomUUID(), predioId: '7', numeroVisual: null, nombre: 'QA', sexo: 'HEMBRA', nacimientoTipo: 'DESCONOCIDA', razaTipo: 'DESCONOCIDA' },
  chapetaCodigo: null,
});

const propio = (ms) => ms !== 300_000 && ms !== 1_500;

function temporizadores() {
  const activos = new Map();
  let siguiente = 1;
  return {
    activos,
    setTimer(fn, ms) {
      const id = siguiente++;
      activos.set(id, { fn, ms });
      return id;
    },
    clearTimer(id) {
      activos.delete(id);
    },
    /** Esperas pendientes, sin contar el barrido de 5 minutos ni el debounce del outbox. */
    esperas: () => [...activos.values()].map((t) => t.ms).filter(propio),
    async disparar() {
      const [id, t] = [...activos.entries()].find(([, x]) => propio(x.ms));
      activos.delete(id);
      await t.fn();
      await asentar();
    },
  };
}

function arrancar(e, { sw = null, doc = null, lock = null, sesionOffline = true } = {}) {
  const t = temporizadores();
  const win = new EventTarget();
  const engine = createSyncEngine({ repo: e.repo, transport: e.transport, isOnline: e.isOnline, now: e.now, random: () => 0.5, ...(lock ? { lock } : {}) });
  const auto = startAutoSync({ engine, repo: e.repo, win, doc, serviceWorker: sw, setTimer: t.setTimer, clearTimer: t.clearTimer, now: e.now });
  const online = () => calcularOnline({ navegadorOnline: e.isOnline(), sesionOffline, ultimoResultado: engine.getState().ultimoResultado });
  const barra = async () => {
    const s = engine.getState();
    const stats = await e.repo.contar();
    return computeSyncIndicator({ online: online(), enCurso: s.enCurso, pendientes: stats.pendientes ?? 0, ultimoResultado: s.ultimoResultado }).estado;
  };
  return { engine, auto, win, t, online, barra };
}

function locksSimulados() {
  const tomados = new Set();
  return {
    async request(nombre, opciones, callback) {
      if (opciones.ifAvailable && tomados.has(nombre)) return callback(null);
      tomados.add(nombre);
      try {
        return await callback({ name: nombre });
      } finally {
        tomados.delete(nombre);
      }
    },
  };
}

// ---------------------------------------------------------------------
// Casos pedidos
// ---------------------------------------------------------------------

test('1. inicia online -> ONLINE', async () => {
  const e = escenario();
  const a = arrancar(e, { sesionOffline: false });
  await a.auto.primera;
  assert.equal(a.online(), true);
  assert.equal(await a.barra(), 'SINCRONIZADO');
  a.auto.stop();
});

test('2. inicia offline -> OFFLINE y sin peticiones ni reintento', async () => {
  const e = escenario();
  e.red.navegador = false;
  const a = arrancar(e);
  await a.auto.primera;
  assert.equal(a.engine.getState().ultimoResultado, RUN_RESULT.OFFLINE);
  assert.equal(a.online(), false);
  assert.equal(await a.barra(), 'OFFLINE');
  assert.deepEqual(a.t.esperas(), [], 'sin red del navegador no hay nada que sondear');
  a.auto.stop();
});

test('3. offline -> online actualiza la interfaz sin recargar', async () => {
  const e = escenario();
  e.red.navegador = false;
  const a = arrancar(e, { sesionOffline: false });
  await a.auto.primera;
  assert.equal(a.online(), false);
  e.red.navegador = true;
  a.win.dispatchEvent(new Event('online'));
  await asentar();
  assert.equal(a.online(), true);
  assert.equal(await a.barra(), 'SINCRONIZADO');
  a.auto.stop();
});

test('4. online -> offline actualiza de inmediato, sin esperar a ningún ciclo', async () => {
  const e = escenario();
  const a = arrancar(e, { sesionOffline: false });
  await a.auto.primera;
  assert.equal(a.online(), true);
  e.red.navegador = false;
  assert.equal(a.engine.getState().ultimoResultado, RUN_RESULT.OK, 'el motor aún no se enteró');
  assert.equal(a.online(), false);
  assert.equal(await a.barra(), 'OFFLINE');
  a.auto.stop();
});

test('5. reabrir offline y reconectar -> ONLINE aunque la revalidación de sesión haya fallado', async () => {
  const e = escenario();
  e.red.navegador = false;
  await registrar(e.repo);
  const a = arrancar(e, { sesionOffline: true });
  await a.auto.primera;
  assert.equal(a.online(), false);
  e.red.navegador = true;
  assert.equal(a.online(), false, 'el evento online por sí solo no confirma el servidor');
  a.win.dispatchEvent(new Event('online'));
  await asentar();
  assert.equal(a.engine.getState().ultimoResultado, RUN_RESULT.OK);
  assert.equal(a.online(), true);
  assert.equal(await a.barra(), 'SINCRONIZADO');
  assert.equal(e.posts.length, 1);
  a.auto.stop();
});

test('6. la reconexión sincroniza una sola vez aunque coincidan online y Background Sync', async () => {
  const e = escenario();
  e.red.navegador = false;
  await registrar(e.repo);
  const sw = new EventTarget();
  sw.ready = Promise.resolve({});
  const a = arrancar(e, { sw });
  await a.auto.primera;
  await asentar();
  e.red.navegador = true;
  a.win.dispatchEvent(new Event('online'));
  sw.dispatchEvent(Object.assign(new Event('message'), { data: { type: 'AGX_SYNC_REQUEST' } }));
  await asentar();
  assert.equal(e.posts.length, 1);
  assert.deepEqual(a.t.esperas(), [], 'tras confirmar la red no queda ningún sondeo');
  a.auto.stop();
});

test('7. no hay listeners dobles tras remontar', async () => {
  const e = escenario();
  e.red.navegador = false;
  await registrar(e.repo);
  const primero = arrancar(e);
  await primero.auto.primera;
  primero.auto.stop();
  const segundo = arrancar(e);
  await segundo.auto.primera;
  let ciclos = 0;
  segundo.engine.subscribe((s) => { if (s.enCurso) ciclos += 1; });
  e.red.navegador = true;
  primero.win.dispatchEvent(new Event('online'));
  await asentar();
  assert.equal(e.posts.length, 0, 'el montaje desmontado ya no escucha');
  segundo.win.dispatchEvent(new Event('online'));
  await asentar();
  assert.equal(e.posts.length, 1);
  assert.equal(ciclos, 1);
  segundo.auto.stop();
  // El proveedor conserva una sola pareja de listeners con su limpieza.
  for (const tipo of ['online', 'offline']) {
    assert.equal(PROVIDER.split(`window.addEventListener('${tipo}'`).length - 1, 1, tipo);
    assert.equal(PROVIDER.split(`window.removeEventListener('${tipo}'`).length - 1, 1, tipo);
  }
});

test('8. al desmontar se limpia todo: ni temporizadores ni sondeos tardíos', async () => {
  const e = escenario();
  e.red.servidor = false;
  const a = arrancar(e);
  await a.auto.primera;
  await asentar();
  assert.equal(a.t.esperas().length, 1);
  a.auto.stop();
  assert.equal(a.t.activos.size, 0);
  // Un ciclo en marcha que termina después del desmontaje no reprograma.
  const b = arrancar(e);
  b.auto.stop();
  await b.auto.primera;
  await asentar();
  assert.equal(b.t.esperas().length, 0);
});

test('9. varias pestañas: un solo POST y la que cedió no se queda en OFFLINE', async () => {
  const e = escenario();
  e.red.navegador = false;
  await registrar(e.repo);
  const locks = locksSimulados();
  const lock = () => createNavigatorLock(syncLockName(ORG), locks);
  const A = arrancar(e, { lock: lock() });
  const B = arrancar(e, { lock: lock() });
  await Promise.all([A.auto.primera, B.auto.primera]);
  e.red.navegador = true;
  A.win.dispatchEvent(new Event('online'));
  B.win.dispatchEvent(new Event('online'));
  await asentar();
  assert.equal(e.posts.length, 1);
  assert.equal(A.engine.getState().ultimoResultado, RUN_RESULT.OK);
  assert.notEqual(B.engine.getState().ultimoResultado, RUN_RESULT.OK, 'cedió sin comprobar nada');
  assert.equal(B.online(), false);
  assert.deepEqual(B.t.esperas(), [2_000]);
  await B.t.disparar();
  assert.equal(B.engine.getState().ultimoResultado, RUN_RESULT.OK);
  assert.equal(B.online(), true);
  assert.equal(e.posts.length, 1, 'el reintento no reenvía');
  A.auto.stop();
  B.auto.stop();
});

test('10. con Service Worker activo un primer intento fallido no deja el estado obsoleto', async () => {
  const e = escenario();
  e.red.navegador = false;
  await registrar(e.repo);
  const registros = [];
  const sw = new EventTarget();
  sw.ready = Promise.resolve({ sync: { register: async (tag) => { registros.push(tag); } } });
  const a = arrancar(e, { sw });
  await a.auto.primera;
  await asentar();
  const registrosAntes = registros.length;
  e.red.navegador = true;
  e.red.servidor = false;
  a.win.dispatchEvent(new Event('online'));
  await asentar();
  assert.equal(a.online(), false);
  const registrosTrasOnline = registros.length;
  assert.ok(registrosTrasOnline >= registrosAntes);
  e.red.servidor = true;
  await a.t.disparar();
  assert.equal(a.online(), true);
  assert.equal(e.posts.length, 1);
  assert.equal(registros.length, registrosTrasOnline, 'el sondeo no registra Background Sync');
  a.auto.stop();
});

// ---------------------------------------------------------------------
// Sondeo de reconexión
// ---------------------------------------------------------------------

test('11. sin operaciones también se recupera: el fallo transitorio no depende del outbox', async () => {
  const e = escenario();
  e.red.navegador = false;
  const a = arrancar(e);
  await a.auto.primera;
  e.red.navegador = true;
  e.red.servidor = false;
  a.win.dispatchEvent(new Event('online'));
  await asentar();
  assert.deepEqual(a.t.esperas(), [2_000]);
  e.red.servidor = true;
  await a.t.disparar();
  assert.equal(a.online(), true);
  assert.equal(await a.barra(), 'SINCRONIZADO');
  assert.deepEqual(a.t.esperas(), []);
  a.auto.stop();
});

test('12. la espera crece hasta 60 s, con un único temporizador', async () => {
  const e = escenario();
  e.red.servidor = false;
  const a = arrancar(e);
  await a.auto.primera;
  await asentar();
  const vistas = [];
  for (let i = 0; i < 8; i += 1) {
    assert.equal(a.t.esperas().length, 1);
    vistas.push(a.t.esperas()[0]);
    await a.t.disparar();
  }
  assert.deepEqual(vistas, [2_000, 4_000, 8_000, 16_000, 30_000, 60_000, 60_000, 60_000]);
  a.auto.stop();
});

test('13. un nuevo online reinicia la espera', async () => {
  const e = escenario();
  e.red.servidor = false;
  const a = arrancar(e);
  await a.auto.primera;
  await asentar();
  await a.t.disparar();
  await a.t.disparar();
  assert.deepEqual(a.t.esperas(), [8_000]);
  a.win.dispatchEvent(new Event('online'));
  await asentar();
  assert.deepEqual(a.t.esperas(), [2_000]);
  a.auto.stop();
});

test('14. si el navegador pierde la red, el sondeo se detiene', async () => {
  const e = escenario();
  e.red.servidor = false;
  const a = arrancar(e);
  await a.auto.primera;
  await asentar();
  e.red.navegador = false;
  await a.t.disparar();
  assert.deepEqual(a.t.esperas(), []);
  a.auto.stop();
});

test('15. con la app oculta no se sondea; al volver a estar visible se reintenta', async () => {
  const e = escenario();
  e.red.servidor = false;
  const doc = Object.assign(new EventTarget(), { visibilityState: 'hidden' });
  const a = arrancar(e, { doc });
  await a.auto.primera;
  await asentar();
  assert.deepEqual(a.t.esperas(), []);
  e.red.servidor = true;
  doc.visibilityState = 'visible';
  doc.dispatchEvent(new Event('visibilitychange'));
  await asentar();
  assert.equal(a.online(), true);
  a.auto.stop();
});

test('16. el sondeo no adelanta ni duplica un backoff más próximo: gana la espera menor', async () => {
  const e = escenario();
  e.red.navegador = false;
  await registrar(e.repo);
  const a = arrancar(e);
  await a.auto.primera;
  e.red.navegador = true;
  e.red.servidor = false;
  a.win.dispatchEvent(new Event('online'));
  await asentar();
  const [espera] = a.t.esperas();
  assert.equal(a.t.esperas().length, 1);
  assert.ok(espera <= 2_000, String(espera));
  a.auto.stop();
});

// ---------------------------------------------------------------------
// calcularOnline
// ---------------------------------------------------------------------

test('17. calcularOnline: tabla de verdad', () => {
  const casos = [
    [true, false, null, true],
    [true, false, RUN_RESULT.OK, true],
    [true, false, RUN_RESULT.ERROR, true],
    [true, false, RUN_RESULT.EN_CURSO, true],
    [true, false, RUN_RESULT.OFFLINE, false],
    [false, false, RUN_RESULT.OK, false],
    [false, true, RUN_RESULT.OK, false],
    [true, true, null, false],
    [true, true, RUN_RESULT.OFFLINE, false],
    [true, true, RUN_RESULT.ERROR, false],
    [true, true, RUN_RESULT.OK, true],
    [true, true, RUN_RESULT.SESION_REQUERIDA, true],
  ];
  for (const [navegadorOnline, sesionOffline, ultimoResultado, esperado] of casos) {
    assert.equal(calcularOnline({ navegadorOnline, sesionOffline, ultimoResultado }), esperado, JSON.stringify({ navegadorOnline, sesionOffline, ultimoResultado }));
  }
});

test('18. con la sesión vencida en el servidor se pide iniciar sesión, no OFFLINE', () => {
  const online = calcularOnline({ navegadorOnline: true, sesionOffline: true, ultimoResultado: RUN_RESULT.SESION_REQUERIDA });
  assert.equal(computeSyncIndicator({ online, enCurso: false, ultimoResultado: RUN_RESULT.SESION_REQUERIDA }).etiqueta, 'ERROR DE SINCRONIZACIÓN — INICIA SESIÓN');
});

test('19. el proveedor usa calcularOnline y no reconstruye la regla', () => {
  assert.match(PROVIDER, /const online = calcularOnline\(\{ navegadorOnline: navigatorOnline, sesionOffline: auth\.offline, ultimoResultado: engineState\.ultimoResultado \}\);/);
  assert.equal(/!auth\.offline &&/.test(PROVIDER), false);
});

// ---------------------------------------------------------------------
// Bordes del temporizador
// ---------------------------------------------------------------------

function motorSimulado({ pendiente = true, proximo = null } = {}) {
  return {
    syncNow: async () => RUN_RESULT.OFFLINE,
    reconexionPendiente: () => pendiente,
    proximoReintentoAt: () => (typeof proximo === 'function' ? proximo() : proximo),
    reactivarFallosDeRed: async () => 0,
  };
}

const repoVacio = { subscribe: () => () => {}, listOutbox: async () => [] };

test('20. un desmontaje durante la consulta del backoff no deja temporizador', async () => {
  const t = temporizadores();
  let soltar;
  const engine = motorSimulado({ proximo: () => new Promise((resolve) => { soltar = resolve; }) });
  const auto = startAutoSync({ engine, repo: repoVacio, win: new EventTarget(), doc: null, serviceWorker: null, setTimer: t.setTimer, clearTimer: t.clearTimer });
  await asentar();
  auto.stop();
  soltar(null);
  await asentar();
  assert.equal(t.activos.size, 0);
});

test('21. un backoff más próximo que el sondeo adelanta el disparo', async () => {
  const t = temporizadores();
  const ahora = new Date('2026-11-04T12:00:00.000Z');
  const engine = motorSimulado({ proximo: new Date(ahora.getTime() + 1_200).toISOString() });
  const auto = startAutoSync({ engine, repo: repoVacio, win: new EventTarget(), doc: null, serviceWorker: null, setTimer: t.setTimer, clearTimer: t.clearTimer, now: () => ahora });
  await asentar();
  assert.deepEqual(t.esperas(), [1_200]);
  auto.stop();
});

test('22. los intentos fallidos del sondeo no registran Background Sync', async () => {
  const e = escenario();
  await registrar(e.repo);
  e.red.servidor = false;
  const registros = [];
  const sw = new EventTarget();
  sw.ready = Promise.resolve({ sync: { register: async (tag) => { registros.push(tag); } } });
  const a = arrancar(e, { sw });
  await a.auto.primera;
  await asentar();
  const antes = registros.length;
  await a.t.disparar();
  await a.t.disparar();
  assert.equal(registros.length, antes);
  a.auto.stop();
});

test('23. confirmar la red reinicia la espera para la próxima caída', async () => {
  const e = escenario();
  e.red.servidor = false;
  const a = arrancar(e);
  await a.auto.primera;
  await asentar();
  await a.t.disparar();
  assert.deepEqual(a.t.esperas(), [4_000]);
  e.red.servidor = true;
  await a.t.disparar();
  assert.deepEqual(a.t.esperas(), []);
  e.red.servidor = false;
  await a.auto.trigger('operacion');
  await asentar();
  assert.deepEqual(a.t.esperas(), [2_000]);
  a.auto.stop();
});

test('24. stop retira todos los listeners de ventana, documento y Service Worker', async () => {
  const conteo = () => {
    const objetivo = new EventTarget();
    objetivo.vivos = 0;
    const add = objetivo.addEventListener.bind(objetivo);
    const remove = objetivo.removeEventListener.bind(objetivo);
    objetivo.addEventListener = (...args) => { objetivo.vivos += 1; add(...args); };
    objetivo.removeEventListener = (...args) => { objetivo.vivos -= 1; remove(...args); };
    return objetivo;
  };
  const [win, doc, sw] = [conteo(), conteo(), conteo()];
  sw.ready = Promise.resolve({});
  const t = temporizadores();
  const auto = startAutoSync({ engine: motorSimulado({ pendiente: false }), repo: repoVacio, win, doc, serviceWorker: sw, setTimer: t.setTimer, clearTimer: t.clearTimer });
  await asentar();
  assert.deepEqual([win.vivos, doc.vivos, sw.vivos], [1, 1, 1]);
  auto.stop();
  assert.deepEqual([win.vivos, doc.vivos, sw.vivos], [0, 0, 0]);
});

// ---------------------------------------------------------------------
// Errores tras reconectar: solo se reintenta lo transitorio
// ---------------------------------------------------------------------

const soloPull = (respuesta) => (pathname) => (pathname.startsWith(PULL_PATH) ? respuesta : null);

/** Abre sin red y vuelve la red con el servidor ya configurado; deja correr el evento online. */
async function reconectarCon(e, opciones = {}) {
  e.red.navegador = false;
  const a = arrancar(e, opciones);
  await a.auto.primera;
  await asentar();
  e.red.navegador = true;
  a.win.dispatchEvent(new Event('online'));
  await asentar();
  return a;
}

let secuenciaOp = 0;
async function encolarReproduccion(e) {
  secuenciaOp += 1;
  const op = newOperation({
    tipoOperacion: REPRODUCCION_EVENTO_CREAR,
    entidad: 'reproduccion_evento',
    localUuid: `l-${secuenciaOp}`,
    clientOperationId: `c0000000-0000-4000-8000-${String(secuenciaOp).padStart(12, '0')}`,
    payload: { animalId: '7', evento: { tipoEvento: 'CELO_OBSERVADO', fechaEvento: '2026-10-01' } },
    deviceId: 'd-1',
    now: e.now(),
    uuid: () => `o-${secuenciaOp}`,
    claveOrden: claveOrdenAnimal('7'),
    origen: { organizacionId: ORG, cuentaId: CUENTA },
  });
  await e.storage.put('outbox', op);
  return op;
}

test('25. caso A: 503 en pull, sesión offline y outbox vacío se recupera solo', async () => {
  // A-D. inicia offline, vuelve el navegador, primer intento con 503, outbox vacío.
  const e = escenario();
  e.red.falloGet = soloPull({ status: 503 });
  const a = await reconectarCon(e);
  assert.equal((await e.repo.listOutbox()).length, 0);
  assert.equal(a.engine.getState().ultimoResultado, RUN_RESULT.ERROR);
  // E. la interfaz sigue OFFLINE.
  assert.equal(a.online(), false);
  assert.equal(await a.barra(), 'OFFLINE');
  // F-G. el servidor vuelve a 200 y hay un reintento automático programado.
  e.red.falloGet = null;
  assert.deepEqual(a.t.esperas(), [2_000]);
  // H. ONLINE sin recarga ni visibilitychange.
  await a.t.disparar();
  assert.equal(a.engine.getState().ultimoResultado, RUN_RESULT.OK);
  assert.equal(a.online(), true);
  assert.equal(await a.barra(), 'SINCRONIZADO');
  assert.deepEqual(a.t.esperas(), []);
  a.auto.stop();
});

for (const status of [408, 429, 500, 503]) {
  test(`26. ${status} en pull reintenta y se recupera`, async () => {
    const e = escenario();
    e.red.falloGet = soloPull({ status });
    const a = await reconectarCon(e);
    assert.equal(a.engine.reconexionPendiente(), true);
    assert.deepEqual(a.t.esperas(), [2_000]);
    await a.t.disparar();
    assert.deepEqual(a.t.esperas(), [4_000], 'sigue fallando: la espera crece');
    e.red.falloGet = null;
    await a.t.disparar();
    assert.equal(a.online(), true);
    assert.equal(a.engine.reconexionPendiente(), false);
    assert.deepEqual(a.t.esperas(), []);
    a.auto.stop();
  });
}

test('27. status 0 reintenta, venga como excepción o como respuesta del transporte', async () => {
  for (const preparar of [(e) => { e.red.servidor = false; }, (e) => { e.red.falloGet = soloPull({ status: 0, failure: 'NETWORK_ERROR' }); }]) {
    const e = escenario();
    preparar(e);
    const a = await reconectarCon(e);
    assert.equal(a.engine.getState().ultimoResultado, RUN_RESULT.OFFLINE);
    assert.deepEqual(a.t.esperas(), [2_000]);
    a.auto.stop();
  }
});

for (const [nombre, respuesta] of [
  ['400', { status: 400, data: { error: 'VALIDACION' } }],
  ['403 de rol', { status: 403, data: { error: 'ROLE_FORBIDDEN' } }],
  ['404', { status: 404, data: { error: 'NO_ENCONTRADO' } }],
  ['409', { status: 409, data: { error: 'CONFLICTO' } }],
]) {
  test(`28. ${nombre} en pull es definitivo: sin sondeo`, async () => {
    const e = escenario();
    e.red.falloGet = soloPull(respuesta);
    const a = await reconectarCon(e);
    assert.equal(a.engine.getState().ultimoResultado, RUN_RESULT.ERROR);
    assert.equal(a.engine.reconexionPendiente(), false);
    assert.deepEqual(a.t.esperas(), []);
    a.auto.stop();
  });
}

test('29. 401 queda en SESION_REQUERIDA, sin sondeo y pidiendo iniciar sesión', async () => {
  const e = escenario();
  e.red.falloGet = soloPull({ status: 401 });
  const a = await reconectarCon(e);
  assert.equal(a.engine.getState().ultimoResultado, RUN_RESULT.SESION_REQUERIDA);
  assert.equal(a.engine.reconexionPendiente(), false);
  assert.deepEqual(a.t.esperas(), []);
  assert.equal(a.online(), true);
  assert.equal(await a.barra(), 'ERROR');
  a.auto.stop();
});

test('30. un error local definitivo no provoca bucle', async () => {
  const e = escenario();
  e.repo.aplicarPull = async () => { throw new Error('dato local corrupto'); };
  const a = await reconectarCon(e);
  assert.equal(a.engine.getState().ultimoResultado, RUN_RESULT.ERROR);
  assert.equal(a.engine.reconexionPendiente(), false);
  assert.deepEqual(a.t.esperas(), []);
  a.auto.stop();
});

for (const status of [408, 429, 503]) {
  test(`31. ${status} con operación pendiente: el sondeo confirma la red y respeta el backoff del envío`, async () => {
    const e = escenario();
    await registrar(e.repo);
    e.red.falloPost = () => ({ status });
    const a = await reconectarCon(e);
    assert.equal(e.intentosPost.length, 1);
    const [op] = await e.repo.listOutbox();
    assert.equal(op.estado, OUTBOX_ESTADOS.ERROR_REINTENTABLE);
    assert.equal(a.online(), false);
    assert.deepEqual(a.t.esperas(), [2_000]);
    e.red.falloPost = null;
    await a.t.disparar();
    assert.equal(e.intentosPost.length, 1, 'el sondeo no adelanta un 408/429/5xx');
    assert.equal(a.online(), true);
    const restante = new Date(op.siguienteIntentoAt).getTime() - e.now().getTime();
    assert.deepEqual(a.t.esperas(), [Math.max(1_000, restante)]);
    e.avanzar(restante + 1);
    await a.t.disparar();
    assert.equal(e.intentosPost.length, 2);
    assert.equal(e.posts.length, 1);
    assert.equal((await e.repo.listOutbox()).length, 0);
    assert.deepEqual(a.t.esperas(), []);
    a.auto.stop();
  });
}

test('32. 400 en el POST marca la operación y no genera sondeo', async () => {
  const e = escenario();
  await registrar(e.repo);
  e.red.falloPost = () => ({ status: 400, data: { error: 'VALIDACION' } });
  const a = await reconectarCon(e);
  assert.equal(e.intentosPost.length, 1);
  assert.equal(a.engine.reconexionPendiente(), false);
  assert.deepEqual(a.t.esperas(), []);
  a.auto.stop();
});

test('33. fallo transitorio al verificar la sesión: reintenta y envía una sola vez', async () => {
  const e = escenario();
  await encolarReproduccion(e);
  e.red.falloGet = (pathname) => (pathname === SESSION_PATH ? { status: 503 } : null);
  const a = await reconectarCon(e);
  assert.equal(a.engine.getState().ultimoResultado, RUN_RESULT.ERROR);
  assert.equal(e.intentosPost.length, 0);
  assert.deepEqual(a.t.esperas(), [2_000]);
  e.red.falloGet = null;
  await a.t.disparar();
  assert.equal(a.online(), true);
  assert.equal(e.intentosPost.length, 1);
  assert.deepEqual(a.t.esperas(), []);
  a.auto.stop();
});

test('34. fallo definitivo al verificar la sesión: sin sondeo', async () => {
  const e = escenario();
  await encolarReproduccion(e);
  e.red.falloGet = (pathname) => (pathname === SESSION_PATH ? { status: 400 } : null);
  const a = await reconectarCon(e);
  assert.equal(a.engine.getState().ultimoResultado, RUN_RESULT.ERROR);
  assert.equal(a.engine.reconexionPendiente(), false);
  assert.deepEqual(a.t.esperas(), []);
  a.auto.stop();
});

test('35. sesión 401 al verificarla: SESION_REQUERIDA y sin sondeo', async () => {
  const e = escenario();
  await encolarReproduccion(e);
  e.red.falloGet = (pathname) => (pathname === SESSION_PATH ? { status: 401 } : null);
  const a = await reconectarCon(e);
  assert.equal(a.engine.getState().ultimoResultado, RUN_RESULT.SESION_REQUERIDA);
  assert.deepEqual(a.t.esperas(), []);
  a.auto.stop();
});

test('36. un 200 limpia la señal y cancela el temporizador, venga de donde venga', async () => {
  const e = escenario();
  e.red.falloGet = soloPull({ status: 503 });
  const a = await reconectarCon(e);
  assert.equal(a.engine.getState().reconexionNecesaria, true);
  assert.deepEqual(a.t.esperas(), [2_000]);
  e.red.falloGet = null;
  a.win.dispatchEvent(new Event('online'));
  await asentar();
  assert.equal(a.engine.getState().reconexionNecesaria, false);
  assert.deepEqual(a.t.esperas(), []);
  a.auto.stop();
});

test('37. un error definitivo tras uno transitorio detiene el sondeo', async () => {
  const e = escenario();
  e.red.falloGet = soloPull({ status: 503 });
  const a = await reconectarCon(e);
  assert.deepEqual(a.t.esperas(), [2_000]);
  e.red.falloGet = soloPull({ status: 400, data: { error: 'VALIDACION' } });
  await a.t.disparar();
  assert.equal(a.engine.reconexionPendiente(), false);
  assert.deepEqual(a.t.esperas(), []);
  a.auto.stop();
});

test('38. la señal del ciclo anterior no se hereda: transitorio tras definitivo vuelve a sondear', async () => {
  const e = escenario();
  e.red.falloGet = soloPull({ status: 400, data: { error: 'VALIDACION' } });
  const a = await reconectarCon(e);
  assert.deepEqual(a.t.esperas(), []);
  e.red.falloGet = soloPull({ status: 503 });
  a.win.dispatchEvent(new Event('online'));
  await asentar();
  assert.deepEqual(a.t.esperas(), [2_000]);
  a.auto.stop();
});

test('39. varias pestañas con 503: un solo POST aceptado y ambas terminan ONLINE', async () => {
  const e = escenario();
  e.red.navegador = false;
  await registrar(e.repo);
  const locks = locksSimulados();
  const lock = () => createNavigatorLock(syncLockName(ORG), locks);
  const A = arrancar(e, { lock: lock() });
  const B = arrancar(e, { lock: lock() });
  await Promise.all([A.auto.primera, B.auto.primera]);
  e.red.navegador = true;
  e.red.falloPost = () => ({ status: 503 });
  A.win.dispatchEvent(new Event('online'));
  B.win.dispatchEvent(new Event('online'));
  await asentar();
  assert.equal(e.intentosPost.length, 1);
  assert.deepEqual(A.t.esperas(), [2_000]);
  assert.deepEqual(B.t.esperas(), [2_000]);
  e.red.falloPost = null;
  await A.t.disparar();
  await B.t.disparar();
  assert.equal(e.intentosPost.length, 1);
  assert.equal(A.online(), true);
  assert.equal(B.online(), true);
  e.avanzar(600_000);
  await A.t.disparar();
  while (B.t.esperas().length) await B.t.disparar();
  assert.equal(e.posts.length, 1);
  assert.equal((await e.repo.listOutbox()).length, 0);
  A.auto.stop();
  B.auto.stop();
});

test('40. nunca se confirmó nada: el motor nuevo arranca con la señal activa', () => {
  const e = escenario();
  const engine = createSyncEngine({ repo: e.repo, transport: e.transport, isOnline: e.isOnline, now: e.now });
  assert.equal(engine.getState().reconexionNecesaria, true);
  assert.equal(engine.reconexionPendiente(), true);
  e.red.navegador = false;
  assert.equal(engine.reconexionPendiente(), false);
});

test('41. un error local justo después de un 503 no hereda el reintento', async () => {
  const e = escenario();
  e.red.falloGet = soloPull({ status: 503 });
  const a = await reconectarCon(e);
  assert.deepEqual(a.t.esperas(), [2_000]);
  e.red.falloGet = null;
  e.repo.aplicarPull = async () => { throw new Error('dato local corrupto'); };
  await a.t.disparar();
  assert.equal(a.engine.getState().ultimoResultado, RUN_RESULT.ERROR);
  assert.equal(a.engine.reconexionPendiente(), false);
  assert.deepEqual(a.t.esperas(), []);
  a.auto.stop();
});

test('42. perder la red tras confirmarla reactiva la señal, aunque el siguiente ciclo ceda', async () => {
  const e = escenario();
  const a = arrancar(e, { sesionOffline: false });
  await a.auto.primera;
  assert.equal(a.engine.getState().reconexionNecesaria, false);
  e.red.navegador = false;
  await a.auto.trigger('operacion');
  assert.equal(a.engine.getState().reconexionNecesaria, true);
  e.red.navegador = true;
  assert.equal(a.engine.reconexionPendiente(), true);
  a.auto.stop();
});
