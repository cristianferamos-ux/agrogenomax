// SPRINT-3D11.3 (R1) -- pruebas OFFLINE obligatorias del motor de
// sincronización, el repositorio local y los disparadores automáticos.
//
// Se ejecutan con el adaptador de almacenamiento EN MEMORIA (mismo contrato
// que IndexedDB, ver storage.js) contra un servidor simulado que reproduce
// la semántica real de los endpoints (idempotencia por clientOperationId,
// registro atómico animal + chapeta, 409 QR_YA_ASOCIADO, pull por
// organización). Esa semántica real está probada contra PostgreSQL en
// server/services/__tests__/qrInventarioIntegration.test.js y
// syncPullIntegration.test.js; el Service Worker en serviceWorker.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { ORG_STORES, DEVICE_STORES, orgDbName } from '../offlineSchema.js';
import { createMemoryStorage } from '../storage.js';
import { createLocalRepo } from '../localRepo.js';
import { createSyncEngine, classifyResult, computeSyncIndicator, RUN_RESULT } from '../syncEngine.js';
import { OUTBOX_ESTADOS, backoffMs } from '../outbox.js';
import { startAutoSync, BACKGROUND_SYNC_TAG } from '../autoSync.js';
import {
  activarOrganizacion,
  cerrarSesionOffline,
  getOrCreateDeviceId,
  guardarPerfilOffline,
  leerPerfilOffline,
  OFFLINE_VALIDEZ_MS,
} from '../offlineSession.js';
import { buildOfflineSessionPayload, isNetworkFailure } from '../../auth/offlineSessionBridge.js';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const TOKEN_1 = 'aB3_-xYz09QwErTyUiOpAsDfGhJkLzX1';
const TOKEN_2 = 'aB3_-xYz09QwErTyUiOpAsDfGhJkLzX2';
const CODIGO_1 = 'AGX-7KM4-P2XZ-R';
const CODIGO_2 = 'AGX-4TR8-N6CW-H';
const sha = (text) => createHash('sha256').update(text).digest('hex');

// ---------------------------------------------------------------------
// Servidor simulado (fuente de verdad), por organización
// ---------------------------------------------------------------------

function createFakeServer() {
  const server = {
    nextAnimalId: 100,
    animales: [],
    chapetas: new Map([
      [CODIGO_1, { qrId: '1', codigoVisible: CODIGO_1, tipo: 'QR_AGX', estado: 'ASIGNADO_ORGANIZACION', animalId: null, organizacionId: ORG_A, tokenHash: sha(TOKEN_1) }],
      [CODIGO_2, { qrId: '2', codigoVisible: CODIGO_2, tipo: 'QR_AGX', estado: 'ASIGNADO_ORGANIZACION', animalId: null, organizacionId: ORG_A, tokenHash: sha(TOKEN_2) }],
    ]),
    predios: [{ predioId: '7', nombrePredio: 'La Esperanza', estado: 'ACTIVO', organizacionId: ORG_A }, { predioId: '8', nombrePredio: 'Finca B', estado: 'ACTIVO', organizacionId: ORG_B }],
    llamadas: [],
    caerDespuesDeConfirmar: 0,
  };

  function crearAnimal(org, body) {
    const previo = server.animales.find((a) => a.organizacionId === org && a.clientOperationId === body.clientOperationId);
    if (previo) {
      if (previo.huella !== JSON.stringify(body)) return { status: 409, data: { error: 'CLIENT_OPERATION_ID_REUSED' } };
      return { status: 200, data: { ok: true, yaExistia: true, animal: publico(previo) } };
    }
    if (body.numeroVisual && server.animales.some((a) => a.organizacionId === org && a.estado === 'ACTIVO' && a.numeroVisual === body.numeroVisual)) {
      return { status: 409, data: { error: 'ANIMAL_NUMERO_VISUAL_DUPLICADO' } };
    }
    const animal = {
      animalId: String(server.nextAnimalId++), organizacionId: org, clientOperationId: body.clientOperationId, huella: JSON.stringify(body),
      numeroVisual: body.numeroVisual ?? null, nombre: body.nombre ?? null, sexo: body.sexo, estado: 'ACTIVO', predioId: body.predioId,
      predioNombre: 'La Esperanza', razaTipo: body.razaTipo, nacimientoTipo: body.nacimientoTipo,
    };
    return { status: 201, data: { ok: true, yaExistia: false, animal: publico(animal) }, commit: () => server.animales.push(animal) };
  }

  function publico(animal) {
    const { organizacionId, huella, clientOperationId, ...rest } = animal;
    return rest;
  }

  function handle(org, method, path, body) {
    server.llamadas.push(`${method} ${path}`);
    if (method === 'POST' && path === '/api/ganaderia/animales') {
      const result = crearAnimal(org, body);
      result.commit?.();
      return result;
    }
    const registrar = path.match(/^\/api\/ganaderia\/qr\/chapetas\/([^/]+)\/registrar-animal$/);
    if (method === 'POST' && registrar) {
      const chapeta = server.chapetas.get(decodeURIComponent(registrar[1]));
      if (!chapeta || chapeta.organizacionId !== org) return { status: 404, data: { error: 'QR_NOT_FOUND' } };
      if (chapeta.estado === 'ASIGNADO_ANIMAL') {
        const animal = server.animales.find((a) => a.animalId === chapeta.animalId);
        if (animal?.clientOperationId === body.clientOperationId) {
          return { status: 200, data: { ok: true, yaExistia: true, animal: publico(animal), chapeta: { ...chapeta } } };
        }
        return { status: 409, data: { error: 'QR_YA_ASOCIADO' } };
      }
      if (chapeta.estado !== 'ASIGNADO_ORGANIZACION') return { status: 410, data: { error: 'QR_NO_OPERATIVO', estado: chapeta.estado } };
      // Atómico: animal + asociación en una transacción.
      const result = crearAnimal(org, body);
      if (result.status >= 400) return result;
      result.commit();
      chapeta.estado = 'ASIGNADO_ANIMAL';
      chapeta.animalId = result.data.animal.animalId;
      return { status: 201, data: { ...result.data, chapeta: { ...chapeta } } };
    }
    if (method === 'GET' && path.startsWith('/api/ganaderia/sync/pull')) {
      const completo = !path.includes('cursor=');
      return {
        status: 200,
        data: {
          ok: true,
          organizacionId: org,
          cursor: `c${server.llamadas.length}`,
          completo,
          animales: server.animales.filter((a) => a.organizacionId === org).map((a) => ({ ...publico(a), clientOperationId: a.clientOperationId })),
          chapetas: [...server.chapetas.values()].filter((c) => c.organizacionId === org).map(({ organizacionId, ...c }) => ({ ...c })),
          predios: server.predios.filter((p) => p.organizacionId === org).map(({ organizacionId, ...p }) => p),
          potreros: [{ potreroId: '70', predioId: '7', nombre: 'Lote 1', estado: 'ACTIVO', areaHa: 3 }].filter(() => org === ORG_A),
          razas: [{ razaId: '1', codigo: 'BRAHMAN', nombre: 'Brahman', tipoProductivo: 'CARNE' }],
          categorias: [{ categoriaId: '3', codigo: 'VACA_CRIA', nombre: 'Vaca de cría', grupoProductivo: 'CRIA' }],
        },
      };
    }
    return { status: 404, data: { error: 'NOT_FOUND' } };
  }

  /** Transporte de un dispositivo: { online } controla la red; caerTrasConfirmar simula respuesta perdida. */
  server.transport = (org, red) => ({
    async postJson(path, body) {
      if (!red.online) throw new TypeError('Failed to fetch');
      const result = handle(org, 'POST', path, body);
      if (red.caerTrasConfirmar > 0) {
        red.caerTrasConfirmar -= 1;
        throw new TypeError('connection reset');
      }
      return { ok: result.status < 300, status: result.status, data: result.data };
    },
    async getJson(path) {
      if (!red.online) throw new TypeError('Failed to fetch');
      const result = handle(org, 'GET', path);
      return { ok: result.status < 300, status: result.status, data: result.data };
    },
  });
  return server;
}

function createDevice(server, { org = ORG_A, online = true } = {}) {
  const red = { online, caerTrasConfirmar: 0 };
  const storage = createMemoryStorage(ORG_STORES);
  const deviceId = randomUUID();
  const repo = createLocalRepo(storage, { organizacionId: org, deviceId });
  const engine = createSyncEngine({ repo, transport: server.transport(org, red), isOnline: () => red.online, random: () => 0.5 });
  return { red, storage, repo, engine, deviceId };
}

async function preparar(device) {
  assert.equal(await device.engine.syncNow({ forzar: true }), RUN_RESULT.OK);
  await device.repo.putMeta({ preparadoAt: new Date().toISOString() });
}

function body(overrides = {}) {
  return {
    clientOperationId: randomUUID(), predioId: '7', numeroVisual: `CH-${randomUUID().slice(0, 4)}`, nombre: null,
    sexo: 'HEMBRA', nacimientoTipo: 'DESCONOCIDA', razaTipo: 'PURA', razaPrincipalId: '1', categoriaProductivaId: '3',
    pesoInicialKg: null, pesoInicialMetodo: null, ...overrides,
  };
}

// ---------------------------------------------------------------------
// 1-19 obligatorias
// ---------------------------------------------------------------------

test('1. con datos preparados la app opera sin red: lista, ficha y perfil offline sin ninguna llamada', async () => {
  const server = createFakeServer();
  const device = createDevice(server);
  await preparar(device);
  device.red.online = false;
  const llamadasAntes = server.llamadas.length;
  assert.equal(await device.repo.isPreparado(), true);
  assert.deepEqual(await device.repo.listAnimales(), []);
  assert.equal((await device.repo.listPredios()).length, 1);
  assert.equal(server.llamadas.length, llamadasAntes, 'no consulta la red');
  assert.equal(await device.engine.syncNow(), RUN_RESULT.OFFLINE, 'sin red el motor no espera ninguna API');

  const deviceDb = createMemoryStorage(DEVICE_STORES);
  await guardarPerfilOffline(deviceDb, { cuenta: { cuentaId: 'c1', email: 'a@b.co' }, organizacionActiva: { organizacionId: ORG_A, nombre: 'Finca' }, rolInterno: null });
  const perfil = await leerPerfilOffline(deviceDb);
  const payload = buildOfflineSessionPayload(perfil);
  assert.equal(payload.authenticated, true);
  assert.equal(payload.offline, true);
  assert.equal(payload.organizacionActiva.organizacionId, ORG_A);
  assert.equal(isNetworkFailure(new TypeError('Failed to fetch'), { onLine: true }), true);
  assert.equal(isNetworkFailure(new Error('SESSION_CHECK_FAILED_502'), { onLine: true }), false, 'un 5xx del servidor NO abre modo offline');
});

test('perfil offline: caduca a los 7 días sin validar online; nunca para super admin; sin secretos', async () => {
  const deviceDb = createMemoryStorage(DEVICE_STORES);
  const ahora = new Date('2026-10-17T10:00:00Z');
  assert.equal(await guardarPerfilOffline(deviceDb, { cuenta: {}, organizacionActiva: null, rolInterno: 'super_admin' }, ahora), null);
  await guardarPerfilOffline(deviceDb, { cuenta: { cuentaId: 'c', email: 'e', nombre: 'n', password: 'x' }, organizacionActiva: { organizacionId: ORG_A } }, ahora);
  const guardado = await deviceDb.get('dispositivo', 'perfil');
  assert.deepEqual(Object.keys(guardado.cuenta).sort(), ['cuentaId', 'email', 'nombre']);
  assert.ok(await leerPerfilOffline(deviceDb, new Date(ahora.getTime() + OFFLINE_VALIDEZ_MS - 1000)));
  assert.equal(await leerPerfilOffline(deviceDb, new Date(ahora.getTime() + OFFLINE_VALIDEZ_MS + 1000)), null);
});

test('2-3. escanear (token -> SHA-256) y digitar código resuelven offline contra el dispositivo', async () => {
  const server = createFakeServer();
  const device = createDevice(server);
  await preparar(device);
  device.red.online = false;
  const scan = await device.repo.resolverLocal({ kind: 'token', token: TOKEN_1 });
  assert.equal(scan.resultado, 'DISPONIBLE');
  assert.equal(scan.to, `/ganaderia/animales/nuevo?chapeta=${CODIGO_1}`);
  const digitado = await device.repo.resolverLocal({ kind: 'codigo', codigo: CODIGO_1 });
  assert.equal(digitado.resultado, 'DISPONIBLE');
  const chapetaLocal = await device.repo.getChapetaPorCodigo(CODIGO_1);
  assert.equal(Object.hasOwn(chapetaLocal, 'token'), false, 'el dispositivo nunca guarda el token, solo su hash');
});

test('18. QR o código desconocido offline -> DESCONOCIDA (no se asume inválido)', async () => {
  const server = createFakeServer();
  const device = createDevice(server);
  await preparar(device);
  device.red.online = false;
  assert.deepEqual(await device.repo.resolverLocal({ kind: 'codigo', codigo: 'AGX-H9VK-3P7M-R' }), { resultado: 'DESCONOCIDA' });
  assert.deepEqual(await device.repo.resolverLocal({ kind: 'token', token: 'Z'.repeat(32) }), { resultado: 'DESCONOCIDA' });
});

test('19. catálogos, predios y potreros siguen disponibles offline', async () => {
  const server = createFakeServer();
  const device = createDevice(server);
  await preparar(device);
  device.red.online = false;
  assert.equal((await device.repo.listRazas())[0].nombre, 'Brahman');
  assert.equal((await device.repo.listCategorias())[0].nombre, 'Vaca de cría');
  assert.equal((await device.repo.listPredios())[0].nombrePredio, 'La Esperanza');
  assert.equal((await device.repo.listPotreros('7')).length, 1);
});

test('4-11. registro offline -> outbox -> vuelve la red -> sync automático -> animal_id -> outbox vacío -> sin duplicados', async () => {
  const server = createFakeServer();
  const device = createDevice(server);
  await preparar(device);
  device.red.online = false;

  // 4-5
  const datos = body();
  const { localUuid, animal } = await device.repo.registrarAnimalLocal({ body: datos, chapetaCodigo: CODIGO_1 });
  assert.equal(animal.animalId, null, 'nunca fabrica un animal_id');
  assert.equal(animal.estadoSync, 'PENDIENTE');
  assert.match(localUuid, /^[0-9a-f-]{36}$/);
  const [op] = await device.repo.listOutbox();
  assert.equal(op.estado, OUTBOX_ESTADOS.PENDIENTE);
  assert.equal(op.clientOperationId, datos.clientOperationId);
  assert.equal(op.tipoOperacion, 'ANIMAL_CREAR_CON_CHAPETA');
  assert.equal(op.localUuid, localUuid);
  assert.equal(op.deviceId, device.deviceId);
  assert.equal((await device.repo.getAnimal(`local:${localUuid}`)).numeroVisual, datos.numeroVisual, 'ficha local disponible');
  assert.equal((await device.repo.resolverLocal({ kind: 'codigo', codigo: CODIGO_1 })).to, `/ganaderia/animales/local:${localUuid}`, 'la chapeta ya abre la ficha local');
  assert.equal(server.animales.length, 0);

  // 6-7: vuelve la conectividad -> disparo automático ('online')
  const win = new EventTarget();
  const timers = [];
  const auto = startAutoSync({
    engine: device.engine, repo: device.repo, win, doc: null, serviceWorker: null,
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimer: () => {},
  });
  await auto.primera;
  device.red.online = true;
  win.dispatchEvent(new Event('online'));
  await new Promise((resolve) => setTimeout(resolve, 10));
  await device.engine.syncNow();

  // 8-10
  assert.equal(server.animales.length, 1);
  const animalId = server.animales[0].animalId;
  assert.deepEqual(await device.repo.getAnimal(`local:${localUuid}`), { redirectTo: animalId });
  const sincronizado = await device.repo.getAnimal(animalId);
  assert.equal(sincronizado.localUuid, localUuid);
  assert.equal(sincronizado.estadoSync, 'SINCRONIZADO');
  assert.equal((await device.storage.getAll('animales')).filter((a) => a.key.startsWith('loc:')).length, 0);
  assert.deepEqual(await device.repo.listOutbox(), []);
  const chapeta = await device.repo.getChapetaPorCodigo(CODIGO_1);
  assert.equal(chapeta.estado, 'ASIGNADO_ANIMAL');
  assert.equal(chapeta.animalId, animalId);
  assert.equal(chapeta.reservaLocalUuid, null);

  // 11
  await device.engine.syncNow({ forzar: true });
  await device.engine.syncNow({ forzar: true });
  assert.equal(server.animales.length, 1);
  assert.equal((await device.repo.listAnimales()).length, 1);
  auto.stop();
});

test('12-13. la conexión cae a mitad del sync (servidor confirmó, respuesta perdida) -> reintento idempotente, sin duplicado', async () => {
  const server = createFakeServer();
  const device = createDevice(server);
  await preparar(device);
  const { localUuid } = await device.repo.registrarAnimalLocal({ body: body(), chapetaCodigo: CODIGO_2 });
  device.red.caerTrasConfirmar = 1;
  assert.equal(await device.engine.syncNow(), RUN_RESULT.OFFLINE);
  const [op] = await device.repo.listOutbox();
  assert.equal(op.estado, OUTBOX_ESTADOS.ERROR_REINTENTABLE);
  // FASE-14: un fallo de RED no cuenta como intento ni hace crecer la espera.
  assert.equal(op.intentos, 0);
  assert.equal(op.ultimoError.tipo, 'red');
  assert.ok(op.siguienteIntentoAt, 'reintento corto programado');
  assert.equal(server.animales.length, 1, 'el servidor sí confirmó');
  assert.ok(await device.engine.proximoReintentoAt());

  // Reintento (forzado como lo haría el temporizador de backoff al vencer).
  assert.equal(await device.engine.syncNow({ forzar: true }), RUN_RESULT.OK);
  assert.equal(server.animales.length, 1, 'el reintento no duplica (200 yaExistia)');
  assert.deepEqual(await device.repo.listOutbox(), []);
  assert.deepEqual(await device.repo.getAnimal(`local:${localUuid}`), { redirectTo: server.animales[0].animalId });
});

test('12b. una operación que quedó SINCRONIZANDO (app cerrada a mitad) se reenvía al reabrir', async () => {
  const server = createFakeServer();
  const device = createDevice(server);
  await preparar(device);
  await device.repo.registrarAnimalLocal({ body: body() });
  const [op] = await device.repo.listOutbox();
  // App cerrada a mitad hace rato (más que el lease): sin lock, se recupera.
  await device.repo.putOperacion({ ...op, estado: OUTBOX_ESTADOS.SINCRONIZANDO, updatedAt: new Date(Date.now() - 5 * 60_000).toISOString() });
  assert.equal(await device.engine.syncNow(), RUN_RESULT.OK);
  assert.equal(server.animales.length, 1);
  assert.deepEqual(await device.repo.listOutbox(), []);
});

test('12c. el PULL empareja por clientOperationId una creación cuya respuesta se perdió (sin esperar al reintento)', async () => {
  const server = createFakeServer();
  const device = createDevice(server);
  await preparar(device);
  const datos = body();
  const { localUuid } = await device.repo.registrarAnimalLocal({ body: datos });
  server.animales.push({ animalId: '555', organizacionId: ORG_A, clientOperationId: datos.clientOperationId, huella: JSON.stringify(datos), numeroVisual: datos.numeroVisual, sexo: 'HEMBRA', estado: 'ACTIVO', predioId: '7' });
  const [op] = await device.repo.listOutbox();
  await device.repo.putOperacion({ ...op, estado: OUTBOX_ESTADOS.ERROR_REINTENTABLE, siguienteIntentoAt: '2999-01-01T00:00:00.000Z' });
  assert.equal(await device.engine.syncNow(), RUN_RESULT.OK);
  assert.deepEqual(await device.repo.getAnimal(`local:${localUuid}`), { redirectTo: '555' });
  assert.deepEqual(await device.repo.listOutbox(), []);
  assert.equal(server.animales.length, 1);
});

test('14-15. dos dispositivos usan la misma chapeta offline: uno gana, el otro queda CONFLICTO sin perder el animal; reasignación posterior', async () => {
  const server = createFakeServer();
  const a = createDevice(server);
  const b = createDevice(server);
  await preparar(a);
  await preparar(b);
  a.red.online = false;
  b.red.online = false;
  await a.repo.registrarAnimalLocal({ body: body({ numeroVisual: 'A-1' }), chapetaCodigo: CODIGO_1 });
  const { localUuid: uuidB } = await b.repo.registrarAnimalLocal({ body: body({ numeroVisual: 'B-1' }), chapetaCodigo: CODIGO_1 });

  a.red.online = true;
  b.red.online = true;
  assert.equal(await a.engine.syncNow(), RUN_RESULT.OK);
  await b.engine.syncNow();

  assert.equal(server.animales.length, 1, 'solo el primero se registró con la chapeta');
  assert.equal(server.chapetas.get(CODIGO_1).animalId, server.animales[0].animalId);
  const [opB] = await b.repo.listOutbox();
  assert.equal(opB.estado, OUTBOX_ESTADOS.CONFLICTO);
  assert.equal(opB.ultimoError.codigo, 'QR_YA_ASOCIADO');
  const animalB = await b.repo.getAnimal(`local:${uuidB}`);
  assert.equal(animalB.estadoSync, 'CONFLICTO', 'el animal local NO se borra');
  assert.equal(animalB.numeroVisual, 'B-1');
  assert.equal(animalB.conflicto.valorLocal.chapetaCodigo, CODIGO_1, 'se conserva el valor local');
  assert.equal((await b.repo.contar()).conflictos, 1);
  assert.equal(computeSyncIndicator({ online: true, enCurso: false, conflictos: 1 }).etiqueta, 'CONFLICTO DE SINCRONIZACIÓN');

  // Reasignación posterior: otra chapeta disponible.
  await b.repo.resolverConOtraChapeta(uuidB, CODIGO_2);
  assert.equal(await b.engine.syncNow(), RUN_RESULT.OK);
  assert.equal(server.animales.length, 2);
  assert.equal(server.chapetas.get(CODIGO_2).estado, 'ASIGNADO_ANIMAL');
  assert.deepEqual(await b.repo.listOutbox(), []);
});

test('conflicto resuelto registrando sin chapeta o editando el número duplicado; descartar es explícito', async () => {
  const server = createFakeServer();
  const a = createDevice(server);
  const b = createDevice(server);
  await preparar(a);
  await preparar(b);
  await a.repo.registrarAnimalLocal({ body: body({ numeroVisual: 'DUP' }), chapetaCodigo: CODIGO_1 });
  await a.engine.syncNow();
  const { localUuid: dup } = await b.repo.registrarAnimalLocal({ body: body({ numeroVisual: 'DUP' }) });
  await b.engine.syncNow();
  assert.equal((await b.repo.listOutbox())[0].ultimoError.codigo, 'ANIMAL_NUMERO_VISUAL_DUPLICADO');
  await b.repo.resolverEditando(dup, { numeroVisual: 'DUP-2' });
  assert.equal(await b.engine.syncNow(), RUN_RESULT.OK);
  assert.ok(server.animales.some((x) => x.numeroVisual === 'DUP-2'));

  const { localUuid: otro } = await b.repo.registrarAnimalLocal({ body: body({ numeroVisual: 'X-9' }), chapetaCodigo: CODIGO_2 });
  server.chapetas.get(CODIGO_2).estado = 'REVOCADO';
  await b.engine.syncNow();
  assert.equal((await b.repo.listOutbox())[0].estado, OUTBOX_ESTADOS.CONFLICTO);
  await b.repo.resolverSinChapeta(otro);
  assert.equal(await b.engine.syncNow(), RUN_RESULT.OK);
  assert.ok(server.animales.some((x) => x.numeroVisual === 'X-9'));

  const { localUuid: descartar } = await b.repo.registrarAnimalLocal({ body: body({ numeroVisual: 'DUP-2' }) });
  await b.engine.syncNow();
  await b.repo.descartarLocal(descartar);
  assert.equal(await b.repo.getAnimal(`local:${descartar}`), null);
  assert.deepEqual(await b.repo.listOutbox(), []);
});

test('16. cambiar de organización no mezcla datos: bases separadas, pull de otra organización rechazado, purga segura', async () => {
  assert.notEqual(orgDbName(ORG_A), orgDbName(ORG_B));
  const server = createFakeServer();
  const deviceA = createDevice(server, { org: ORG_A });
  await preparar(deviceA);
  await assert.rejects(deviceA.repo.aplicarPull({ organizacionId: ORG_B, animales: [], chapetas: [], predios: [], potreros: [], razas: [], categorias: [], cursor: 'x', completo: true }), /otra organización/);

  const deviceDb = createMemoryStorage(DEVICE_STORES);
  const borradas = [];
  const pendientes = { [ORG_A]: 0, [ORG_B]: 0 };
  const deps = { contarPendientes: async (org) => pendientes[org], borrarBase: async (nombre) => borradas.push(nombre) };
  await activarOrganizacion(deviceDb, ORG_A, deps);
  await activarOrganizacion(deviceDb, ORG_B, deps);
  assert.deepEqual(borradas, [orgDbName(ORG_A)], 'la base de A se purga al activar B (sin pendientes)');

  pendientes[ORG_B] = 2;
  const { conservadas } = await activarOrganizacion(deviceDb, ORG_A, deps);
  assert.deepEqual(conservadas, [ORG_B], 'con cambios pendientes se conserva aislada');

  await guardarPerfilOffline(deviceDb, { cuenta: {}, organizacionActiva: { organizacionId: ORG_A } });
  pendientes[ORG_A] = 0;
  await cerrarSesionOffline(deviceDb, ORG_A, deps);
  assert.equal(await leerPerfilOffline(deviceDb), null, 'cerrar sesión elimina el perfil offline');
  assert.ok(borradas.includes(orgDbName(ORG_A)));
});

// ---------------------------------------------------------------------
// Motor: clasificación, backoff, indicador, disparadores
// ---------------------------------------------------------------------

test('clasificación de respuestas del outbox', () => {
  assert.equal(classifyResult({ ok: true, status: 200 }), 'OK');
  for (const r of [{ failure: 'NETWORK_ERROR' }, { failure: 'REQUEST_NOT_SENT' }, { status: 0 }, { status: 503 }, { status: 429 }, { status: 408 }]) {
    assert.equal(classifyResult({ ok: false, ...r }), 'REINTENTABLE', JSON.stringify(r));
  }
  assert.equal(classifyResult({ ok: false, status: 401, failure: 'SESSION_EXPIRED' }), 'SESION');
  assert.equal(classifyResult({ ok: false, status: 403, failure: 'CSRF_REJECTED' }), 'SESION');
  for (const status of [404, 409, 410]) assert.equal(classifyResult({ ok: false, status }), 'CONFLICTO');
  assert.equal(classifyResult({ ok: false, status: 400 }), 'RECHAZADO');
});

test('sesión expirada durante el PUSH: la operación vuelve a PENDIENTE y el ciclo se detiene', async () => {
  const server = createFakeServer();
  const device = createDevice(server);
  await preparar(device);
  await device.repo.registrarAnimalLocal({ body: body() });
  const engine = createSyncEngine({
    repo: device.repo,
    transport: { postJson: async () => ({ ok: false, status: 401, failure: 'SESSION_EXPIRED', data: { error: 'SESSION_EXPIRED' } }), getJson: async () => ({ ok: true, data: {} }) },
  });
  assert.equal(await engine.syncNow(), RUN_RESULT.SESION_REQUERIDA);
  const [op] = await device.repo.listOutbox();
  assert.equal(op.estado, OUTBOX_ESTADOS.PENDIENTE);
  assert.equal(op.intentos, 0);
});

test('backoff exponencial con tope', () => {
  const fijo = () => 0.5;
  assert.equal(backoffMs(1, fijo), 5000);
  assert.equal(backoffMs(2, fijo), 10000);
  assert.equal(backoffMs(4, fijo), 40000);
  assert.equal(backoffMs(30, fijo), 600000);
});

test('15. indicador: todos los estados exigidos', () => {
  assert.equal(computeSyncIndicator({ online: true, enCurso: false }).etiqueta, 'ONLINE — SINCRONIZADO');
  assert.equal(computeSyncIndicator({ online: false }).etiqueta, 'OFFLINE');
  assert.equal(computeSyncIndicator({ online: false, pendientes: 2 }).etiqueta, 'OFFLINE — 2 CAMBIOS PENDIENTES');
  assert.equal(computeSyncIndicator({ online: true, enCurso: true }).etiqueta, 'SINCRONIZANDO');
  assert.equal(computeSyncIndicator({ online: true, pendientes: 3 }).etiqueta, '3 CAMBIOS PENDIENTES');
  assert.equal(computeSyncIndicator({ online: true, conflictos: 1 }).etiqueta, 'CONFLICTO DE SINCRONIZACIÓN');
  assert.equal(computeSyncIndicator({ online: true, ultimoResultado: RUN_RESULT.ERROR }).etiqueta, 'ERROR DE SINCRONIZACIÓN');
});

test('9. disparadores automáticos: apertura, online, visible, tras operación, Background Sync y reintento por backoff', async () => {
  const server = createFakeServer();
  const device = createDevice(server);
  await preparar(device);
  const motivos = [];
  const engine = { ...device.engine, syncNow: async (o) => { motivos.push(o.motivo); return device.engine.syncNow(o); } };
  const win = new EventTarget();
  const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const swTarget = new EventTarget();
  const registrados = [];
  const serviceWorker = Object.assign(swTarget, { ready: Promise.resolve({ sync: { register: async (tag) => registrados.push(tag) } }) });
  const timers = [];
  const auto = startAutoSync({
    engine, repo: device.repo, win, doc, serviceWorker,
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimer: () => {},
  });
  await auto.primera;
  assert.deepEqual(motivos, ['apertura']);

  win.dispatchEvent(new Event('online'));
  doc.dispatchEvent(new Event('visibilitychange'));
  swTarget.dispatchEvent(Object.assign(new Event('message'), { data: { type: 'AGX_SYNC_REQUEST' } }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(motivos.includes('online') && motivos.includes('visible') && motivos.includes('background-sync'));

  device.red.online = false;
  await device.repo.registrarAnimalLocal({ body: body() });
  const debounce = timers.find((t) => t.ms === 1500);
  assert.ok(debounce, 'una operación local programa un disparo');
  await debounce.fn();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(motivos.includes('operacion'));
  assert.ok(registrados.includes(BACKGROUND_SYNC_TAG), 'registra Background Sync con pendientes');
  assert.ok(timers.some((t) => t.ms === 5 * 60_000), 'barrido de respaldo cada 5 min');
  auto.stop();
});

test('13. dispositivo único por instalación (device_id UUID persistente)', async () => {
  const deviceDb = createMemoryStorage(DEVICE_STORES);
  const a = await getOrCreateDeviceId(deviceDb);
  const b = await getOrCreateDeviceId(deviceDb);
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f-]{36}$/);
});

test('storage en memoria: batch atómico (si una operación falla no se aplica ninguna)', async () => {
  const storage = createMemoryStorage(ORG_STORES);
  await assert.rejects(storage.batch([
    { op: 'put', store: 'predios', value: { predioId: '1', nombrePredio: 'x' } },
    { op: 'put', store: 'no_existe', value: {} },
  ]));
  assert.deepEqual(await storage.getAll('predios'), []);
});
