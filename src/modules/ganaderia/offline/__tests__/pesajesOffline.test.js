// FASE 1D.1 -- PESAJE_CREAR en el outbox existente (mismo motor, mismo
// repositorio, mismos Web Locks, mismos reintentos). JS puro: almacenamiento
// en memoria (mismo contrato que IndexedDB), reloj y red simulados, y un
// servidor que reproduce el contrato REAL de POST /api/ganaderia/animales/
// :animalId/pesajes (201 / 200 yaExistia / 409 CLIENT_OPERATION_ID_REUSED /
// 409 ANIMAL_ANULADO / 404 ANIMAL_NOT_FOUND / 400 INVALID_*), probado contra
// PostgreSQL en server/services/__tests__/animalPesajesIntegration.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ORG_STORES } from '../offlineSchema.js';
import { createMemoryStorage } from '../storage.js';
import { createLocalRepo } from '../localRepo.js';
import { createSyncEngine, RUN_RESULT, RED_REINTENTO_MS } from '../syncEngine.js';
import { OUTBOX_ESTADOS } from '../outbox.js';
import { cuerpoPesaje, esAnimalIdServidor, handlerFor } from '../operationHandlers.js';
import { createNavigatorLock, syncLockName } from '../browserOffline.js';
import { buildPesajeBody, initialPesajeForm } from '../../hato/pesajesModel.js';
import { validateCreatePesajeBody } from '../../../../../server/services/ganaderia/pesajeValidation.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const HOY = '2026-10-20';

function reloj(inicio = '2026-10-20T15:00:00.000Z') {
  let t = new Date(inicio).getTime();
  return { now: () => new Date(t), avanzar: (ms) => { t += ms; } };
}

/** Servidor de pesajes con la semántica real (idempotencia por clientOperationId). */
function servidor({ animales = { 1: 'ACTIVO', 2: 'ACTIVO', 3: 'ANULADO' } } = {}) {
  const pesajes = [];
  const posts = [];
  let seq = 0;
  const srv = {
    pesajes,
    posts,
    falla: null, // { status, data } | 'red' | 'red-tras-guardar'
    responder(pathname, body) {
      const m = pathname.match(/^\/api\/ganaderia\/animales\/(\d+)\/pesajes$/);
      if (!m) return { ok: false, status: 404, data: { error: 'NOT_FOUND' } };
      const animalId = m[1];
      let value;
      try {
        value = validateCreatePesajeBody(body, { hoy: HOY });
      } catch (error) {
        return { ok: false, status: error.status ?? 400, data: { error: error.code, message: error.message } };
      }
      if (!animales[animalId]) return { ok: false, status: 404, data: { error: 'ANIMAL_NOT_FOUND' } };
      const previo = pesajes.find((p) => p.clientOperationId === value.clientOperationId);
      if (previo) {
        const mismo = previo.animalId === animalId && previo.fecha === value.fecha && previo.pesoKg === value.pesoKg
          && previo.metodo === value.metodo && (previo.observaciones ?? null) === (value.observaciones ?? null);
        if (!mismo) return { ok: false, status: 409, data: { error: 'CLIENT_OPERATION_ID_REUSED' } };
        return { ok: true, status: 200, data: { ok: true, yaExistia: true, pesaje: { pesajeId: previo.pesajeId } } };
      }
      if (animales[animalId] !== 'ACTIVO') return { ok: false, status: 409, data: { error: 'ANIMAL_ANULADO' } };
      const nuevo = { pesajeId: String(++seq), animalId, ...value };
      pesajes.push(nuevo);
      return { ok: true, status: 201, data: { ok: true, yaExistia: false, pesaje: { pesajeId: nuevo.pesajeId } } };
    },
  };
  return srv;
}

function transporte(srv, { red = { online: true }, retener = null } = {}) {
  return {
    async postJson(pathname, body) {
      srv.posts.push({ pathname, body: structuredClone(body) });
      if (!red.online) throw new TypeError('Failed to fetch');
      if (retener) await retener();
      if (srv.falla === 'red') throw new TypeError('Failed to fetch');
      if (srv.falla === 'red-tras-guardar') {
        srv.falla = null;
        srv.responder(pathname, body); // el servidor guardó...
        throw new TypeError('Failed to fetch'); // ...pero la respuesta nunca llegó
      }
      if (srv.falla) return { ok: false, ...srv.falla };
      return srv.responder(pathname, body);
    },
    async getJson() {
      if (!red.online) throw new TypeError('Failed to fetch');
      return { ok: true, status: 200, data: { organizacionId: ORG, cursor: 'c', completo: false, animales: [], chapetas: [], predios: [], potreros: [], razas: [], categorias: [] } };
    },
  };
}

function dispositivo({ storage = createMemoryStorage(ORG_STORES), clock = reloj() } = {}) {
  const repo = createLocalRepo(storage, { organizacionId: ORG, deviceId: 'dev-1', now: clock.now });
  return { storage, repo, clock };
}

function cuerpo(extra = {}) {
  const form = { ...initialPesajeForm(HOY), pesoKg: '355', ...extra };
  return buildPesajeBody(form, extra.clientOperationId ?? randomUUID());
}

const motor = (d, srv, opciones = {}) => createSyncEngine({ repo: d.repo, transport: transporte(srv, opciones), now: d.clock.now, isOnline: () => opciones.red?.online ?? true, lock: opciones.lock ?? null });

// ---------------------------------------------------------------------
// Encolado offline
// ---------------------------------------------------------------------

test('2/4. offline: PESAJE_CREAR en el outbox con el clientOperationId del formulario y sin organizacionId', async () => {
  const d = dispositivo();
  const body = cuerpo({ observaciones: 'pesaje de campo' });
  const { pendiente, yaEncolado } = await d.repo.registrarPesajeLocal({ animalId: '1', body });
  assert.equal(yaEncolado, false);
  const [op] = await d.repo.listOutbox();
  assert.equal(op.tipoOperacion, 'PESAJE_CREAR');
  assert.equal(op.entidad, 'pesaje');
  assert.equal(op.estado, OUTBOX_ESTADOS.PENDIENTE);
  assert.equal(op.clientOperationId, body.clientOperationId);
  assert.deepEqual(op.payload, { animalId: '1', fecha: HOY, pesoKg: 355, metodo: 'BASCULA', observaciones: 'pesaje de campo', clientOperationId: body.clientOperationId });
  assert.ok(!JSON.stringify(op).includes('organizacionId'), 'la organización la resuelve el servidor');
  assert.equal(pendiente.localOperationId, op.operationId);
  assert.equal(pendiente.estado, 'PENDIENTE');
  assert.ok(!('pesajeId' in pendiente), 'nunca se fabrica un pesajeId de servidor');
  await assert.rejects(d.repo.registrarPesajeLocal({ animalId: '1', body: { ...cuerpo(), organizacionId: ORG } }), { code: 'CAMPO_NO_PERMITIDO' });
});

test('3. sin red: el motor NO hace POST y la operación sigue pendiente', async () => {
  const d = dispositivo();
  const srv = servidor();
  await d.repo.registrarPesajeLocal({ animalId: '1', body: cuerpo() });
  const red = { online: false };
  assert.equal(await motor(d, srv, { red }).syncNow(), RUN_RESULT.OFFLINE);
  assert.equal(srv.posts.length, 0);
  assert.equal((await d.repo.listOutbox())[0].estado, OUTBOX_ESTADOS.PENDIENTE);
});

test('doble clic / reintento del usuario: el mismo clientOperationId no crea otra operación', async () => {
  const d = dispositivo();
  const body = cuerpo();
  const a = await d.repo.registrarPesajeLocal({ animalId: '1', body });
  const b = await d.repo.registrarPesajeLocal({ animalId: '1', body });
  assert.equal(b.yaEncolado, true);
  assert.equal(b.operationId, a.operationId);
  assert.equal((await d.repo.listOutbox()).length, 1);
});

test('30. animal creado offline (sin animal_id real): se bloquea con mensaje explícito; nunca se envía', async () => {
  const d = dispositivo();
  for (const animalId of ['local:3fa85f64-5717-4562-b3fc-2c963f66afa6', '3fa85f64-5717-4562-b3fc-2c963f66afa6', '', null, '0']) {
    await assert.rejects(d.repo.registrarPesajeLocal({ animalId, body: cuerpo() }), { code: 'PESAJE_REQUIERE_ANIMAL_SINCRONIZADO' });
  }
  assert.deepEqual(await d.repo.listOutbox(), []);
  // Defensa en el manejador: una operación con animalId no real nunca produce petición.
  assert.equal(handlerFor('PESAJE_CREAR').request({ payload: { animalId: 'local:x', fecha: HOY, pesoKg: 1, metodo: 'BASCULA', clientOperationId: randomUUID() } }), null);
  assert.equal(esAnimalIdServidor('12'), true);
  assert.equal(esAnimalIdServidor('local:1'), false);
});

test('5. recarga de la página: la operación persiste con el MISMO clientOperationId y se envía con él', async () => {
  const storage = createMemoryStorage(ORG_STORES); // la "IndexedDB" sobrevive a la recarga
  const antes = dispositivo({ storage });
  const body = cuerpo();
  await antes.repo.registrarPesajeLocal({ animalId: '1', body });
  const despues = dispositivo({ storage }); // repo nuevo = página recargada
  const [pendiente] = await despues.repo.listPesajesPendientes('1');
  assert.equal(pendiente.clientOperationId, body.clientOperationId);
  const srv = servidor();
  assert.equal(await motor(despues, srv).syncNow(), RUN_RESULT.OK);
  assert.equal(srv.posts[0].body.clientOperationId, body.clientOperationId);
});

// ---------------------------------------------------------------------
// Reconexión: éxito idempotente
// ---------------------------------------------------------------------

test('6. reconexión -> 201: se confirma, se elimina del outbox y se notifica (refresh post-sync)', async () => {
  const d = dispositivo();
  const srv = servidor();
  const body = cuerpo({ observaciones: 'campo' });
  await d.repo.registrarPesajeLocal({ animalId: '1', body });
  let avisos = 0;
  d.repo.subscribe(() => { avisos += 1; });
  assert.equal(await motor(d, srv).syncNow(), RUN_RESULT.OK);
  assert.deepEqual(srv.posts.map((p) => p.pathname), ['/api/ganaderia/animales/1/pesajes']);
  assert.deepEqual(srv.posts[0].body, cuerpoPesaje({ ...body, animalId: '1' }));
  assert.deepEqual(srv.posts[0].body, body, 'mismo cuerpo que el registro online');
  assert.equal(srv.pesajes.length, 1);
  assert.deepEqual(await d.repo.listOutbox(), []);
  assert.deepEqual(await d.repo.listPesajesPendientes('1'), []);
  assert.ok(avisos > 0, 'la ficha abierta se entera y refresca desde el servidor');
});

test('7 / caso 3. corte DESPUÉS de que el servidor guardó: reintento -> 200 yaExistia, sin duplicado', async () => {
  const d = dispositivo();
  const srv = servidor();
  const body = cuerpo();
  await d.repo.registrarPesajeLocal({ animalId: '1', body });
  srv.falla = 'red-tras-guardar';
  const engine = motor(d, srv);
  assert.equal(await engine.syncNow(), RUN_RESULT.OFFLINE);
  const [op] = await d.repo.listOutbox();
  assert.equal(op.estado, OUTBOX_ESTADOS.ERROR_REINTENTABLE);
  assert.equal(op.clientOperationId, body.clientOperationId, 'nunca un UUID nuevo por reintento');
  assert.equal(srv.pesajes.length, 1, 'el servidor ya lo tenía');
  d.clock.avanzar(RED_REINTENTO_MS + 1);
  assert.equal(await engine.syncNow(), RUN_RESULT.OK);
  assert.equal(srv.pesajes.length, 1, 'no duplicado');
  assert.deepEqual(srv.posts.map((p) => p.body.clientOperationId), [body.clientOperationId, body.clientOperationId]);
  assert.deepEqual(await d.repo.listOutbox(), []);
});

// ---------------------------------------------------------------------
// Política de errores
// ---------------------------------------------------------------------

test('8. red caída al enviar -> ERROR_REINTENTABLE tipo red, sin sumar intento; luego se envía', async () => {
  const d = dispositivo();
  const srv = servidor();
  await d.repo.registrarPesajeLocal({ animalId: '1', body: cuerpo() });
  srv.falla = 'red';
  const engine = motor(d, srv);
  assert.equal(await engine.syncNow(), RUN_RESULT.OFFLINE);
  const [op] = await d.repo.listOutbox();
  assert.equal(op.estado, OUTBOX_ESTADOS.ERROR_REINTENTABLE);
  assert.equal(op.intentos, 0);
  assert.equal(op.ultimoError.tipo, 'red');
  srv.falla = null;
  assert.equal(await engine.syncNow({ forzar: true }), RUN_RESULT.OK);
  assert.equal(srv.pesajes.length, 1);
});

test('9. 5xx -> reintento con backoff (no definitivo)', async () => {
  const d = dispositivo();
  const srv = servidor();
  await d.repo.registrarPesajeLocal({ animalId: '1', body: cuerpo() });
  srv.falla = { status: 503, data: { error: 'SERVICE_UNAVAILABLE' } };
  const engine = motor(d, srv);
  assert.equal(await engine.syncNow(), RUN_RESULT.ERROR);
  const [op] = await d.repo.listOutbox();
  assert.equal(op.estado, OUTBOX_ESTADOS.ERROR_REINTENTABLE);
  assert.equal(op.ultimoError.tipo, 'http');
  assert.ok(op.siguienteIntentoAt > d.clock.now().toISOString());
  srv.falla = null;
  assert.equal(await engine.syncNow({ forzar: true }), RUN_RESULT.OK);
  assert.equal(srv.pesajes.length, 1);
});

async function definitivo(falla, { animalId = '1', body = cuerpo() } = {}) {
  const d = dispositivo();
  const srv = servidor();
  await d.repo.registrarPesajeLocal({ animalId, body });
  if (falla) srv.falla = falla;
  const engine = motor(d, srv);
  await engine.syncNow();
  const [op] = await d.repo.listOutbox();
  // No hay reintento infinito: otro ciclo no vuelve a enviarla.
  const enviados = srv.posts.length;
  d.clock.avanzar(24 * 60 * 60_000);
  await engine.syncNow({ forzar: true });
  assert.equal(srv.posts.length, enviados, 'un fallo definitivo no se reenvía');
  return { op, srv, d };
}

test('10. 400 INVALID_* -> RECHAZADO definitivo', async () => {
  const { op } = await definitivo({ status: 400, data: { error: 'INVALID_PESO', message: 'Peso inválido' } });
  assert.equal(op.estado, OUTBOX_ESTADOS.RECHAZADO);
  assert.equal(op.ultimoError.codigo, 'INVALID_PESO');
});

test('11. 404 ANIMAL_NOT_FOUND -> CONFLICTO definitivo', async () => {
  const { op } = await definitivo(null, { animalId: '999' });
  assert.equal(op.estado, OUTBOX_ESTADOS.CONFLICTO);
  assert.equal(op.ultimoError.codigo, 'ANIMAL_NOT_FOUND');
});

test('12. 409 ANIMAL_ANULADO -> CONFLICTO definitivo', async () => {
  const { op, srv } = await definitivo(null, { animalId: '3' });
  assert.equal(op.estado, OUTBOX_ESTADOS.CONFLICTO);
  assert.equal(op.ultimoError.codigo, 'ANIMAL_ANULADO');
  assert.equal(srv.pesajes.length, 0);
});

test('13. 409 CLIENT_OPERATION_ID_REUSED -> CONFLICTO definitivo; el sync NUNCA genera otro UUID', async () => {
  const d = dispositivo();
  const srv = servidor();
  const reusado = randomUUID();
  srv.responder('/api/ganaderia/animales/1/pesajes', cuerpo({ clientOperationId: reusado, pesoKg: '300' }));
  await d.repo.registrarPesajeLocal({ animalId: '1', body: cuerpo({ clientOperationId: reusado, pesoKg: '355' }) });
  const engine = motor(d, srv);
  await engine.syncNow();
  await engine.syncNow({ forzar: true });
  const [op] = await d.repo.listOutbox();
  assert.equal(op.estado, OUTBOX_ESTADOS.CONFLICTO);
  assert.equal(op.ultimoError.codigo, 'CLIENT_OPERATION_ID_REUSED');
  assert.equal(op.clientOperationId, reusado);
  assert.deepEqual(new Set(srv.posts.map((p) => p.body.clientOperationId)), new Set([reusado]));
  assert.equal(srv.pesajes.length, 1, 'solo el original');
});

test('14. 401 y 403 CSRF -> vuelve a PENDIENTE (espera sesión válida), sin sumar intento', async () => {
  for (const falla of [{ status: 401, data: { error: 'SESSION_REQUIRED' } }, { status: 403, failure: 'CSRF_REJECTED', data: { error: 'CSRF_INVALID' } }]) {
    const d = dispositivo();
    const srv = servidor();
    await d.repo.registrarPesajeLocal({ animalId: '1', body: cuerpo() });
    srv.falla = falla;
    assert.equal(await motor(d, srv).syncNow(), RUN_RESULT.SESION_REQUERIDA);
    const [op] = await d.repo.listOutbox();
    assert.equal(op.estado, OUTBOX_ESTADOS.PENDIENTE);
    assert.equal(op.intentos, 0);
  }
});

test('un pesaje bloqueado NO frena a los demás (cada pesaje tiene su localUuid)', async () => {
  const d = dispositivo();
  const srv = servidor();
  await d.repo.registrarPesajeLocal({ animalId: '3', body: cuerpo() }); // anulado -> CONFLICTO
  await d.repo.registrarPesajeLocal({ animalId: '1', body: cuerpo() });
  await motor(d, srv).syncNow();
  const ops = await d.repo.listOutbox();
  assert.equal(ops.length, 1);
  assert.equal(ops[0].payload.animalId, '3');
  assert.equal(srv.pesajes.length, 1);
});

test('descartar: solo pesajes que el servidor no aceptó, por decisión explícita', async () => {
  const d = dispositivo();
  const pendiente = await d.repo.registrarPesajeLocal({ animalId: '1', body: cuerpo() });
  await assert.rejects(d.repo.descartarPesajePendiente(pendiente.operationId), { code: 'PESAJE_PENDIENTE_EN_CURSO' });
  const { op, d: d2 } = await definitivo(null, { animalId: '3' });
  await d2.repo.descartarPesajePendiente(op.operationId);
  assert.deepEqual(await d2.repo.listOutbox(), []);
  await assert.rejects(d.repo.descartarPesajePendiente('no-existe'), { code: 'PESAJE_PENDIENTE_NO_ENCONTRADO' });
});

// ---------------------------------------------------------------------
// Varias operaciones, orden y concurrencia
// ---------------------------------------------------------------------

test('17/18/20/21. varios pesajes del MISMO día y animal: orden de creación, sin duplicados', async () => {
  const d = dispositivo();
  const srv = servidor();
  const a = cuerpo({ pesoKg: '350' });
  d.clock.avanzar(1000);
  await d.repo.registrarPesajeLocal({ animalId: '1', body: a });
  d.clock.avanzar(1000);
  const b = cuerpo({ pesoKg: '351.5' });
  await d.repo.registrarPesajeLocal({ animalId: '1', body: b });
  const pendientes = await d.repo.listPesajesPendientes('1');
  assert.deepEqual(pendientes.map((p) => p.pesoKg), [350, 351.5]);
  assert.ok(pendientes.every((p) => p.fecha === HOY), 'dos pesajes del mismo día son válidos');
  await motor(d, srv).syncNow();
  assert.deepEqual(srv.pesajes.map((p) => p.pesoKg), [350, 351.5], 'orden de sync = orden de creación');
  assert.equal(new Set(srv.pesajes.map((p) => p.clientOperationId)).size, 2);
});

test('19. varios animales: cada pesaje va a su animal; los pendientes se listan por animal', async () => {
  const d = dispositivo();
  const srv = servidor();
  await d.repo.registrarPesajeLocal({ animalId: '1', body: cuerpo({ pesoKg: '300' }) });
  d.clock.avanzar(1000);
  await d.repo.registrarPesajeLocal({ animalId: '2', body: cuerpo({ pesoKg: '400' }) });
  assert.equal((await d.repo.listPesajesPendientes('1')).length, 1);
  assert.equal((await d.repo.listPesajesPendientes('2')).length, 1);
  await motor(d, srv).syncNow();
  assert.deepEqual(srv.pesajes.map((p) => `${p.animalId}:${p.pesoKg}`), ['1:300', '2:400']);
});

test('pesajes después de un animal pendiente: conviven en el mismo outbox sin bloquearse', async () => {
  const d = dispositivo();
  const srv = servidor();
  const posts = [];
  await d.repo.registrarAnimalLocal({ body: { clientOperationId: randomUUID(), predioId: '7', nombre: 'Nuevo', sexo: 'HEMBRA', nacimientoTipo: 'DESCONOCIDA', razaTipo: 'DESCONOCIDA' } });
  d.clock.avanzar(1000);
  await d.repo.registrarPesajeLocal({ animalId: '1', body: cuerpo() });
  const transport = transporte(srv);
  const engine = createSyncEngine({
    repo: d.repo,
    now: d.clock.now,
    transport: {
      ...transport,
      async postJson(pathname, body) {
        posts.push(pathname);
        if (pathname === '/api/ganaderia/animales') return { ok: true, status: 201, data: { animal: { animalId: '50', estado: 'ACTIVO' } } };
        return transport.postJson(pathname, body);
      },
    },
  });
  assert.equal(await engine.syncNow(), RUN_RESULT.OK);
  assert.deepEqual(posts, ['/api/ganaderia/animales', '/api/ganaderia/animales/1/pesajes']);
  assert.deepEqual(await d.repo.listOutbox(), []);
});

function retenedor() {
  let soltar;
  const espera = new Promise((resolve) => { soltar = resolve; });
  return { retener: () => espera, soltar: () => soltar() };
}

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

test('15/16. dos pestañas con Web Lock: reconexión simultánea -> un solo POST por pesaje', async () => {
  const storage = createMemoryStorage(ORG_STORES);
  const pestanaA = dispositivo({ storage });
  const pestanaB = dispositivo({ storage, clock: pestanaA.clock });
  await pestanaA.repo.registrarPesajeLocal({ animalId: '1', body: cuerpo() });
  const srv = servidor();
  const ret = retenedor();
  const locks = fakeLocks();
  const A = motor(pestanaA, srv, { retener: ret.retener, lock: createNavigatorLock(syncLockName(ORG), locks) });
  const B = motor(pestanaB, srv, { retener: ret.retener, lock: createNavigatorLock(syncLockName(ORG), locks) });
  const cicloA = A.syncNow();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(await B.syncNow(), RUN_RESULT.EN_CURSO, 'B cede: A tiene el lock');
  ret.soltar();
  assert.equal(await cicloA, RUN_RESULT.OK);
  assert.equal(srv.posts.length, 1);
  assert.equal(srv.pesajes.length, 1);
  assert.deepEqual(await pestanaB.repo.listOutbox(), [], 'la otra pestaña ve el outbox vacío');
});

test('dos pestañas SIN Web Lock (navegador antiguo): la idempotencia del servidor evita duplicados', async () => {
  const storage = createMemoryStorage(ORG_STORES);
  const pestanaA = dispositivo({ storage });
  const pestanaB = dispositivo({ storage, clock: pestanaA.clock });
  const body = cuerpo();
  await pestanaA.repo.registrarPesajeLocal({ animalId: '1', body });
  const srv = servidor();
  await Promise.all([motor(pestanaA, srv).syncNow(), motor(pestanaB, srv).syncNow()]);
  assert.equal(srv.pesajes.length, 1, 'nunca dos pesajes por operación');
  assert.ok(srv.posts.every((p) => p.body.clientOperationId === body.clientOperationId));
});

test('retry manual + automático simultáneos en la misma pestaña: un solo ciclo, un solo POST', async () => {
  const d = dispositivo();
  const srv = servidor();
  await d.repo.registrarPesajeLocal({ animalId: '1', body: cuerpo() });
  const engine = motor(d, srv);
  const [r1, r2] = await Promise.all([engine.syncNow({ forzar: true }), engine.syncNow({ motivo: 'online' })]);
  assert.equal(r1, RUN_RESULT.OK);
  assert.equal(r2, RUN_RESULT.OK);
  assert.equal(srv.posts.length, 1);
});

test('cierre a mitad de envío (SINCRONIZANDO): al reabrir se reenvía con el mismo UUID, sin duplicar', async () => {
  const storage = createMemoryStorage(ORG_STORES);
  const d = dispositivo({ storage });
  const body = cuerpo();
  await d.repo.registrarPesajeLocal({ animalId: '1', body });
  const [op] = await d.repo.listOutbox();
  await d.repo.putOperacion({ ...op, estado: OUTBOX_ESTADOS.SINCRONIZANDO, intentos: 1, updatedAt: d.clock.now().toISOString() });
  const srv = servidor();
  srv.responder('/api/ganaderia/animales/1/pesajes', body); // el envío previo sí llegó
  const reabierta = dispositivo({ storage, clock: d.clock });
  const lock = createNavigatorLock(syncLockName(ORG), fakeLocks());
  assert.equal(await motor(reabierta, srv, { lock }).syncNow(), RUN_RESULT.OK);
  assert.equal(srv.pesajes.length, 1);
  assert.deepEqual(await reabierta.repo.listOutbox(), []);
});

// ---------------------------------------------------------------------
// Indicador global y cálculos
// ---------------------------------------------------------------------

test('28. contador global: PESAJE_CREAR cuenta en pendientes, errores y conflictos (mismo indicador)', async () => {
  const d = dispositivo();
  await d.repo.registrarPesajeLocal({ animalId: '1', body: cuerpo() });
  assert.equal((await d.repo.contar()).pendientes, 1);
  const srv = servidor();
  srv.falla = { status: 503, data: { error: 'X' } };
  await motor(d, srv).syncNow();
  let c = await d.repo.contar();
  assert.equal(c.pendientes, 1);
  assert.equal(c.errores, 1);
  const bloqueado = dispositivo();
  await bloqueado.repo.registrarPesajeLocal({ animalId: '3', body: cuerpo() });
  await motor(bloqueado, servidor()).syncNow();
  c = await bloqueado.repo.contar();
  assert.equal(c.conflictos, 1);
  assert.equal(c.pendientes, 0);
});

test('29. animal confirmado por el servidor: permitido', async () => {
  const d = dispositivo();
  await d.repo.registrarPesajeLocal({ animalId: '1', body: cuerpo() });
  assert.equal((await d.repo.listPesajesPendientes('1')).length, 1);
});
