// R4/B5-03: durable autonomous delivery worker.
//
// Dos bloques de pruebas:
//   A) UNITARIAS del worker (server/services/catastrox/deliveryWorker.js)
//      -- sin Postgres, con findJobIds/processJob/timers totalmente
//      inyectados (fake timer determinista, ver createFakeTimer()).
//   B) DE SELECCIÓN e INTEGRACIÓN contra Postgres real
//      (findAutonomousDeliveryJobIds en deliveryJobService.js) -- se
//      auto-omiten si no hay base alcanzable, mismo criterio que
//      catastroxDeliveryLifecycle.test.js. Nunca usan producción/Railway.
//
// El bloque B nunca duplica la prueba de concurrencia real ya cubierta por
// catastroxDeliveryLifecycle.test.js ("10) dos processDeliveryJob
// concurrentes...") -- reutiliza esa cobertura y añade solo lo que falta:
// que el DESCUBRIMIENTO autónomo (findAutonomousDeliveryJobIds) respeta la
// política de estados, y que dos invocaciones que reciben el MISMO id
// candidato siguen resolviendo en un solo efecto real (vía el CAS ya
// probado, nunca reimplementado aquí).
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';

dotenv.config({ path: '.env', quiet: true });
dotenv.config({ path: 'server/.env', quiet: true });

import { createDeliveryWorker } from '../deliveryWorker.js';

// ---------------------------------------------------------------------
// Bloque A: helpers de timers/concurrencia deterministas (sin Postgres)
// ---------------------------------------------------------------------

// Timer falso: setTimeoutFn nunca dispara nada por sí solo -- las pruebas
// controlan explícitamente cuándo "pasa el tiempo" llamando fire(handle).
// Permite probar scheduling/jitter/no-solapamiento sin esperar tiempo real.
function createFakeTimer() {
  let nextHandle = 0;
  const pending = new Map();
  const calls = [];

  function setTimeoutFn(fn, delay) {
    nextHandle += 1;
    const handle = nextHandle;
    pending.set(handle, fn);
    calls.push({ handle, delay });
    return handle;
  }

  function clearTimeoutFn(handle) {
    pending.delete(handle);
  }

  async function fire(handle) {
    const fn = pending.get(handle);
    if (!fn) throw new Error(`createFakeTimer.fire: no hay temporizador pendiente con handle ${handle}`);
    pending.delete(handle);
    await fn();
  }

  async function fireLatest() {
    const handles = [...pending.keys()];
    const handle = handles[handles.length - 1];
    if (handle === undefined) throw new Error('createFakeTimer.fireLatest: no hay temporizadores pendientes');
    await fire(handle);
  }

  return { setTimeoutFn, clearTimeoutFn, calls, fire, fireLatest, pendingHandles: () => [...pending.keys()] };
}

// Espera a que `predicate()` sea verdadero, cediendo el control del event
// loop (setImmediate, macrotask real) en cada iteración -- nunca espera
// tiempo de reloj significativo (unas pocas vueltas del loop, típicamente
// microsegundos/milisegundos), y nunca depende de los timers del propio
// worker (esos siempre están fake-eados en el Bloque A).
async function waitUntil(predicate, { retries = 200 } = {}) {
  for (let i = 0; i < retries; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('waitUntil: la condición nunca se cumplió');
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function silentLogger() {
  return { log: () => {}, error: () => {}, warn: () => {} };
}

describe('R4/B5-03: deliveryWorker -- pruebas unitarias (sin Postgres)', () => {
  test('1) runOnce procesa los IDs seleccionados llamando processJob para cada uno', async () => {
    const processed = [];
    const worker = createDeliveryWorker({
      findJobIds: async () => ['job-1', 'job-2'],
      processJob: async (jobId) => {
        processed.push(jobId);
      },
      logger: silentLogger(),
    });

    const summary = await worker.runOnce();
    assert.deepEqual(processed.sort(), ['job-1', 'job-2']);
    assert.equal(summary.selected, 2);
    assert.equal(summary.processed, 2);
    assert.equal(summary.rejected, 0);
  });

  test('2) el batch nunca excede batchSize aunque findJobIds devuelva más candidatos', async () => {
    const processed = [];
    const worker = createDeliveryWorker({
      findJobIds: async () => ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
      processJob: async (jobId) => {
        processed.push(jobId);
      },
      batchSize: 5,
      logger: silentLogger(),
    });

    const summary = await worker.runOnce();
    assert.equal(processed.length, 5);
    assert.equal(summary.selected, 5);
  });

  test('3) concurrencia nunca excede el límite configurado', async () => {
    let current = 0;
    let peak = 0;
    const gates = ['j1', 'j2', 'j3', 'j4', 'j5'].map(() => deferred());
    let callIndex = 0;

    const worker = createDeliveryWorker({
      findJobIds: async () => ['j1', 'j2', 'j3', 'j4', 'j5'],
      processJob: async () => {
        const myGate = gates[callIndex];
        callIndex += 1;
        current += 1;
        peak = Math.max(peak, current);
        await myGate.promise;
        current -= 1;
      },
      batchSize: 5,
      concurrency: 2,
      logger: silentLogger(),
    });

    const runPromise = worker.runOnce();
    // Deja que las primeras 2 "lanes" arranquen y queden bloqueadas en su gate.
    await waitUntil(() => current === 2);
    assert.equal(peak, 2, 'nunca deben arrancar más de 2 jobs simultáneamente');

    // Libera de a una -- cada liberación debe permitir que arranque la
    // siguiente en cola, pero el pico nunca debe superar 2.
    gates[0].resolve();
    await waitUntil(() => callIndex >= 3);
    assert.ok(peak <= 2, `peak nunca debe superar concurrency=2, fue ${peak}`);

    gates[1].resolve();
    await waitUntil(() => callIndex >= 4);
    gates[2].resolve();
    await waitUntil(() => callIndex >= 5);
    gates[3].resolve();
    gates[4].resolve();

    await runPromise;
    assert.ok(peak <= 2, `peak final nunca debe superar concurrency=2, fue ${peak}`);
  });

  test('4) el error de un job individual no aborta el resto del batch ni se propaga', async () => {
    const processed = [];
    const worker = createDeliveryWorker({
      findJobIds: async () => ['ok-1', 'fails', 'ok-2'],
      processJob: async (jobId) => {
        if (jobId === 'fails') throw Object.assign(new Error('boom'), { code: 'SIMULATED_FAILURE' });
        processed.push(jobId);
      },
      logger: silentLogger(),
    });

    const summary = await worker.runOnce();
    assert.deepEqual(processed.sort(), ['ok-1', 'ok-2']);
    assert.equal(summary.processed, 2);
    assert.equal(summary.rejected, 1);
  });

  test('5) start() es idempotente -- llamarlo dos veces produce un solo loop', async () => {
    const fakeTimer = createFakeTimer();
    let findCalls = 0;
    const worker = createDeliveryWorker({
      findJobIds: async () => {
        findCalls += 1;
        return [];
      },
      processJob: async () => {},
      logger: silentLogger(),
      setTimeoutFn: fakeTimer.setTimeoutFn,
      clearTimeoutFn: fakeTimer.clearTimeoutFn,
    });

    worker.start();
    worker.start();
    worker.start();

    await waitUntil(() => fakeTimer.calls.length === 1);
    assert.equal(findCalls, 1, 'un solo tick inicial, sin importar cuántas veces se llame start()');
    assert.equal(fakeTimer.calls.length, 1, 'solo un temporizador programado para el siguiente tick');

    await worker.stop();
  });

  test('6) nunca hay ticks solapados -- el siguiente solo se programa tras completar el anterior', async () => {
    const fakeTimer = createFakeTimer();
    const tickStarts = [];
    const gate = deferred();
    let tickCount = 0;

    const worker = createDeliveryWorker({
      findJobIds: async () => {
        tickCount += 1;
        tickStarts.push(tickCount);
        if (tickCount === 1) await gate.promise;
        return [];
      },
      processJob: async () => {},
      logger: silentLogger(),
      setTimeoutFn: fakeTimer.setTimeoutFn,
      clearTimeoutFn: fakeTimer.clearTimeoutFn,
    });

    worker.start();
    await waitUntil(() => tickCount === 1);
    // Mientras el primer tick sigue bloqueado, no debe existir ningún
    // temporizador programado para un segundo tick todavía.
    assert.equal(fakeTimer.calls.length, 0, 'no debe programarse un segundo tick mientras el primero sigue en curso');

    gate.resolve();
    await waitUntil(() => fakeTimer.calls.length === 1);
    assert.equal(tickCount, 1, 'el segundo tick aún no debe haber arrancado -- solo se programó su temporizador');

    await worker.stop();
  });

  test('7) stop() cancela el siguiente tick programado', async () => {
    const fakeTimer = createFakeTimer();
    let findCalls = 0;
    const worker = createDeliveryWorker({
      findJobIds: async () => {
        findCalls += 1;
        return [];
      },
      processJob: async () => {},
      logger: silentLogger(),
      setTimeoutFn: fakeTimer.setTimeoutFn,
      clearTimeoutFn: fakeTimer.clearTimeoutFn,
    });

    worker.start();
    await waitUntil(() => fakeTimer.calls.length === 1);
    assert.equal(findCalls, 1);

    const pendingHandle = fakeTimer.pendingHandles()[0];
    await worker.stop();
    assert.equal(fakeTimer.pendingHandles().includes(pendingHandle), false, 'el temporizador pendiente debe cancelarse');

    // Si el temporizador cancelado se disparara igual (bug), findCalls subiría.
    assert.equal(findCalls, 1, 'ningún tick adicional debe ejecutarse tras stop()');
  });

  test('8) tras stop(), el worker no reclama jobs nuevos', async () => {
    const fakeTimer = createFakeTimer();
    let findCalls = 0;
    const worker = createDeliveryWorker({
      findJobIds: async () => {
        findCalls += 1;
        return [];
      },
      processJob: async () => {},
      logger: silentLogger(),
      setTimeoutFn: fakeTimer.setTimeoutFn,
      clearTimeoutFn: fakeTimer.clearTimeoutFn,
    });

    worker.start();
    await waitUntil(() => fakeTimer.calls.length === 1);
    await worker.stop();

    const state = worker.getState();
    assert.equal(state.started, false);
    assert.equal(state.stopped, true);
    assert.equal(findCalls, 1, 'sin nuevas llamadas a findJobIds después de stop()');
  });

  test('9) bounded drain: stop() espera el batch en curso hasta drainBudgetMs, nunca más', async () => {
    const fakeTimer = createFakeTimer();
    const gate = deferred();
    let jobStarted = false;

    const worker = createDeliveryWorker({
      findJobIds: async () => ['slow-job'],
      processJob: async () => {
        jobStarted = true;
        await gate.promise; // nunca se resuelve durante la prueba -- simula un job "colgado"
      },
      drainBudgetMs: 20, // pequeño para no alargar la prueba -- el mecanismo es el mismo a cualquier escala
      logger: silentLogger(),
      // Timers REALES aquí a propósito (no fakeTimer): esta prueba mide que
      // stop() efectivamente deja de esperar tras drainBudgetMs de tiempo
      // real transcurrido, no solo que se invoque un callback fake.
    });

    worker.start();
    await waitUntil(() => jobStarted === true);

    const startedAt = Date.now();
    await worker.stop(); // debe resolver por el timeout de drain, no porque el job termine
    const elapsedMs = Date.now() - startedAt;

    assert.ok(elapsedMs < 2000, `stop() no debe esperar indefinidamente (tardó ${elapsedMs}ms)`);
    const state = worker.getState();
    assert.equal(state.stopped, true, 'stop() debe resolver igual aunque el batch siga en curso');
  });

  test('10) un fallo de findJobIds (poll) no mata el loop -- se registra y se programa el siguiente tick', async () => {
    const fakeTimer = createFakeTimer();
    let attempt = 0;
    const worker = createDeliveryWorker({
      findJobIds: async () => {
        attempt += 1;
        if (attempt === 1) throw Object.assign(new Error('DB temporalmente no disponible'), { code: 'ECONNREFUSED' });
        return [];
      },
      processJob: async () => {},
      logger: silentLogger(),
      setTimeoutFn: fakeTimer.setTimeoutFn,
      clearTimeoutFn: fakeTimer.clearTimeoutFn,
    });

    worker.start();
    await waitUntil(() => fakeTimer.calls.length === 1);
    assert.equal(attempt, 1, 'el primer tick falló pero igual se programó el siguiente');

    await fakeTimer.fireLatest();
    await waitUntil(() => attempt === 2);
    assert.equal(worker.getState().lastError, 'ECONNREFUSED');

    await worker.stop();
  });

  test('11) el jitter siempre cae dentro de [pollIntervalMs*(1-ratio), pollIntervalMs*(1+ratio)]', async () => {
    const fakeTimer = createFakeTimer();
    const worker = createDeliveryWorker({
      findJobIds: async () => [],
      processJob: async () => {},
      pollIntervalMs: 10000,
      jitterRatio: 0.2,
      logger: silentLogger(),
      setTimeoutFn: fakeTimer.setTimeoutFn,
      clearTimeoutFn: fakeTimer.clearTimeoutFn,
    });

    worker.start();
    await waitUntil(() => fakeTimer.calls.length === 1);
    const { delay } = fakeTimer.calls[0];
    assert.ok(delay >= 8000 && delay <= 12000, `delay fuera de rango: ${delay}`);
    assert.ok(delay >= 0, 'el delay nunca debe ser negativo');

    await worker.stop();
  });

  test('12) getState()/runOnce() nunca exponen PII, email ni bytes de PDF', async () => {
    const worker = createDeliveryWorker({
      findJobIds: async () => ['job-1'],
      processJob: async () => ({
        delivery_email_encrypted: 'secreto',
        provider_message_id: 'msg_x',
        pdfBytes: Buffer.from('no debería salir de aquí'),
      }),
      logger: silentLogger(),
    });

    const summary = await worker.runOnce();
    const serializedSummary = JSON.stringify(summary);
    assert.equal(serializedSummary.includes('secreto'), false);
    assert.equal(serializedSummary.includes('msg_x'), false);
    assert.deepEqual(Object.keys(summary).sort(), ['processed', 'rejected', 'selected']);

    const state = worker.getState();
    const serializedState = JSON.stringify(state);
    assert.equal(serializedState.includes('secreto'), false);
    assert.equal(serializedState.includes('@'), false);
  });
});

// ---------------------------------------------------------------------
// Bloque B: selección DB + integración (Postgres real, se auto-omite)
// ---------------------------------------------------------------------

let dbAvailable = false;
let query;
let paymentOrders;
let deliveryJobService;

try {
  const { getConfig } = await import('../../../config/env.js');
  ({ query } = await import('../../../db.js'));
  getConfig();
  const tableCheck = await query("select to_regclass('public.catastrox_delivery_jobs') as t");
  dbAvailable = Boolean(tableCheck.rows[0]?.t);
} catch {
  dbAvailable = false;
}

if (dbAvailable) {
  paymentOrders = await import('../paymentOrderRepository.js');
  deliveryJobService = await import('../deliveryJobService.js');
}

// 30 dígitos, sin fixture en catastrox_clean.predios -- nunca resoluble por
// resolvePredioDataForDelivery. Suficiente para la mayoría de estas
// pruebas: la selección de candidatos y el CAS de exclusión nunca
// requieren que la generación del PDF tenga éxito.
const NON_RESOLVABLE_CODIGO = '888800000000000000000000000001';

// Mismo código sintético que catastroxDeliveryLifecycle.test.js -- ya tiene
// una fila fixture en catastrox_clean.predios de este mismo entorno de
// integración (scripts/catastrox/test/setup_integration_postgis.sql), así
// que resolvePredioDataForDelivery() sí tiene éxito con él. Se reutiliza
// deliberadamente en vez de crear un fixture nuevo -- lo único que la
// prueba 28 necesita de él es que el PDF llegue a generarse de verdad, para
// poder ejercitar el desenlace terminal SENT (ver Fase 1.6).
const INTEGRATION_TEST_CODIGO = '999999999999999999999999999901';

let orderCounter = 0;
const createdOrderIds = [];

async function createOrder({ status = 'APPROVED', canonicalPredioId = NON_RESOLVABLE_CODIGO } = {}) {
  orderCounter += 1;
  const orderToken = paymentOrders.generateOrderToken();
  const order = await paymentOrders.insertPendingOrder({
    orderToken,
    packageId: 'basico',
    canonicalPredioId,
    codigoPredialNormalized: canonicalPredioId,
    customerId: null,
    idempotencyKey: `delivery-worker-test-${Date.now()}-${orderCounter}`,
    wompiReference: `CATX-DWORKER-${Date.now()}-${orderCounter}`,
    expectedAmountInCents: 3990000,
    currency: 'COP',
  });
  if (status !== 'PENDING') {
    await query('update public.catastrox_payment_orders set status = $2 where id = $1', [order.id, status]);
    order.status = status;
  }
  createdOrderIds.push(order.id);
  return order;
}

async function createJob(order, overrides = {}) {
  const job = await deliveryJobService.createDeliveryJobForOrder({
    orderId: order.id,
    customerId: null,
    deliveryEmail: 'delivery-worker-test@example.com',
  });
  const entries = Object.entries(overrides);
  if (entries.length) {
    const sets = [];
    const values = [job.id];
    let i = 2;
    for (const [column, value] of entries) {
      sets.push(`${column} = $${i}`);
      values.push(value);
      i += 1;
    }
    await query(`update public.catastrox_delivery_jobs set ${sets.join(', ')} where id = $1`, values);
  }
  const result = await query('select * from public.catastrox_delivery_jobs where id = $1', [job.id]);
  return result.rows[0];
}

async function cleanupAll() {
  if (!dbAvailable || !createdOrderIds.length) return;
  const ids = [...createdOrderIds];
  await query(
    'delete from public.catastrox_delivery_attempts where delivery_job_id in (select id from public.catastrox_delivery_jobs where payment_order_id = any($1))',
    [ids],
  );
  await query(
    'delete from public.catastrox_deliverable_blobs where deliverable_id in (select id from public.catastrox_deliverables where delivery_job_id in (select id from public.catastrox_delivery_jobs where payment_order_id = any($1)))',
    [ids],
  );
  await query(
    'delete from public.catastrox_deliverables where delivery_job_id in (select id from public.catastrox_delivery_jobs where payment_order_id = any($1))',
    [ids],
  );
  await query('delete from public.catastrox_delivery_jobs where payment_order_id = any($1)', [ids]);
  await query('delete from public.catastrox_payment_orders where id = any($1)', [ids]);
  createdOrderIds.length = 0;
}

function minutesAgo(n) {
  return new Date(Date.now() - n * 60 * 1000);
}

function minutesFromNow(n) {
  return new Date(Date.now() + n * 60 * 1000);
}

test('R4/B5-03: findAutonomousDeliveryJobIds -- selección de candidatos (integración, requiere Postgres real)', { skip: !dbAvailable }, async (t) => {
  t.after(cleanupAll);

  await t.test('13) QUEUED es candidato inmediatamente', async () => {
    const order = await createOrder();
    const job = await createJob(order);
    assert.equal(job.status, 'QUEUED');
    const ids = await deliveryJobService.findAutonomousDeliveryJobIds({ limit: 50 });
    assert.ok(ids.includes(job.id));
  });

  await t.test('14) FAILED con next_retry_at vencido es candidato', async () => {
    const order = await createOrder();
    const job = await createJob(order, { status: 'FAILED', next_retry_at: minutesAgo(1) });
    const ids = await deliveryJobService.findAutonomousDeliveryJobIds({ limit: 50 });
    assert.ok(ids.includes(job.id));
  });

  await t.test('15) FAILED con next_retry_at NULL es candidato', async () => {
    const order = await createOrder();
    const job = await createJob(order, { status: 'FAILED', next_retry_at: null });
    const ids = await deliveryJobService.findAutonomousDeliveryJobIds({ limit: 50 });
    assert.ok(ids.includes(job.id));
  });

  await t.test('16) FAILED con next_retry_at futuro NO es candidato', async () => {
    const order = await createOrder();
    const job = await createJob(order, { status: 'FAILED', next_retry_at: minutesFromNow(30) });
    const ids = await deliveryJobService.findAutonomousDeliveryJobIds({ limit: 50 });
    assert.equal(ids.includes(job.id), false);
  });

  await t.test('17) GENERATING vencido (>30min, sin provider_message_id) es candidato', async () => {
    const order = await createOrder();
    const job = await createJob(order, { status: 'GENERATING', provider_message_id: null, last_attempt_at: minutesAgo(31) });
    const ids = await deliveryJobService.findAutonomousDeliveryJobIds({ limit: 50 });
    assert.ok(ids.includes(job.id));
  });

  await t.test('18) GENERATING reciente (<30min) NO es candidato', async () => {
    const order = await createOrder();
    const job = await createJob(order, { status: 'GENERATING', provider_message_id: null, last_attempt_at: minutesAgo(1) });
    const ids = await deliveryJobService.findAutonomousDeliveryJobIds({ limit: 50 });
    assert.equal(ids.includes(job.id), false);
  });

  await t.test('19) READY vencido (>30min, sin provider_message_id) es candidato', async () => {
    const order = await createOrder();
    const job = await createJob(order, { status: 'READY', provider_message_id: null, last_attempt_at: minutesAgo(31) });
    const ids = await deliveryJobService.findAutonomousDeliveryJobIds({ limit: 50 });
    assert.ok(ids.includes(job.id));
  });

  await t.test('20) READY reciente (<30min) NO es candidato', async () => {
    const order = await createOrder();
    const job = await createJob(order, { status: 'READY', provider_message_id: null, last_attempt_at: minutesAgo(1) });
    const ids = await deliveryJobService.findAutonomousDeliveryJobIds({ limit: 50 });
    assert.equal(ids.includes(job.id), false);
  });

  await t.test('21) GENERATING/READY vencidos con provider_message_id NO-nulo NO son candidatos (defensa coherente)', async () => {
    const order = await createOrder();
    const generating = await createJob(order, {
      status: 'GENERATING',
      provider_message_id: 'msg_defensivo_generating',
      last_attempt_at: minutesAgo(31),
    });
    const order2 = await createOrder();
    const ready = await createJob(order2, {
      status: 'READY',
      provider_message_id: 'msg_defensivo_ready',
      last_attempt_at: minutesAgo(31),
    });
    const ids = await deliveryJobService.findAutonomousDeliveryJobIds({ limit: 50 });
    assert.equal(ids.includes(generating.id), false);
    assert.equal(ids.includes(ready.id), false);
  });

  await t.test('22) [REGRESIÓN R4-ADJ-01] SENDING vencido con provider_message_id NULL nunca se reclama de forma autónoma -- la aceptación ambigua del proveedor no debe auto-reintentarse', async () => {
    const order = await createOrder();
    const job = await createJob(order, { status: 'SENDING', provider_message_id: null, last_attempt_at: minutesAgo(31) });
    const ids = await deliveryJobService.findAutonomousDeliveryJobIds({ limit: 50 });
    assert.equal(
      ids.includes(job.id),
      false,
      'SENDING debe quedar EXCLUIDO de findAutonomousDeliveryJobIds sin importar cuánto tiempo pase -- ver R4/B5-03 Fase 0.5',
    );
  });

  await t.test('23) SENT nunca es candidato', async () => {
    const order = await createOrder();
    const job = await createJob(order, { status: 'SENT', provider_message_id: 'msg_ya_enviado' });
    const ids = await deliveryJobService.findAutonomousDeliveryJobIds({ limit: 50 });
    assert.equal(ids.includes(job.id), false);
  });

  await t.test('24) orden FIFO -- created_at ASC, id ASC como desempate', async () => {
    const orderA = await createOrder();
    const jobA = await createJob(orderA, { created_at: new Date('2020-01-01T00:00:00Z') });
    const orderB = await createOrder();
    const jobB = await createJob(orderB, { created_at: new Date('2020-01-01T00:00:00Z') }); // mismo instante -- desempate por id
    const orderC = await createOrder();
    const jobC = await createJob(orderC, { created_at: new Date('2020-01-02T00:00:00Z') });

    const ids = await deliveryJobService.findAutonomousDeliveryJobIds({ limit: 50 });
    const indexA = ids.indexOf(jobA.id);
    const indexB = ids.indexOf(jobB.id);
    const indexC = ids.indexOf(jobC.id);
    assert.ok(indexA !== -1 && indexB !== -1 && indexC !== -1);
    assert.ok(indexC > indexA && indexC > indexB, 'el más reciente (jobC) debe ir después de A y B');
    const expectedAB = [jobA.id, jobB.id].sort();
    assert.deepEqual([ids[Math.min(indexA, indexB)], ids[Math.max(indexA, indexB)]], expectedAB, 'con created_at empatado, el desempate es por id ASC');
  });

  await t.test('25) el límite se respeta', async () => {
    const jobs = [];
    for (let i = 0; i < 7; i += 1) {
      const order = await createOrder();
      // eslint-disable-next-line no-await-in-loop
      jobs.push(await createJob(order));
    }
    const ids = await deliveryJobService.findAutonomousDeliveryJobIds({ limit: 5 });
    assert.equal(ids.length, 5);
  });

  await t.test('26) limit se normaliza de forma defensiva (no entero/negativo -> fallback; exceso -> tope máximo)', async () => {
    const idsDefault = await deliveryJobService.findAutonomousDeliveryJobIds({ limit: 0 });
    assert.ok(Array.isArray(idsDefault));
    const idsHuge = await deliveryJobService.findAutonomousDeliveryJobIds({ limit: 999999 });
    assert.ok(Array.isArray(idsHuge));
  });
});

test('R4/B5-03: integración worker <-> processDeliveryJob (integración, requiere Postgres real)', { skip: !dbAvailable }, async (t) => {
  t.after(cleanupAll);

  await t.test('27) restart semantics -- un job QUEUED creado sin ninguna request HTTP es procesado por runOnce() de un worker nuevo', async () => {
    const order = await createOrder({ status: 'APPROVED' });
    const job = await createJob(order); // QUEUED, nunca se llamó processDeliveryJob para este id
    assert.equal(job.status, 'QUEUED');

    const worker = createDeliveryWorker({
      findJobIds: (opts) => deliveryJobService.findAutonomousDeliveryJobIds(opts),
      processJob: (jobId) => deliveryJobService.processDeliveryJob(jobId),
      logger: { log: () => {}, error: () => {} },
    });

    await worker.runOnce();

    const finalJob = await deliveryJobService.findLatestDeliveryJobForOrder(order.id);
    // El predio no es resoluble (NON_RESOLVABLE_CODIGO) -- termina en FAILED
    // en vez de SENT, pero eso es exactamente la prueba de aceptación de
    // B5-03: el job salió de QUEUED sin que ninguna request HTTP lo tocara.
    // La ruta feliz completa hasta SENT ya está probada en
    // catastroxDeliveryLifecycle.test.js.
    assert.notEqual(finalJob.status, 'QUEUED');
    assert.equal(finalJob.attempt_count, 1);
  });

  await t.test('28) dos workers que descubren el MISMO job candidato solo producen un intento/deliverable/email efectivo, terminando en SENT (CAS existente, no reimplementado aquí)', async () => {
    // Rediseño Fase 1.6 -- la versión anterior de esta prueba usaba una
    // orden PENDING, cuyo único desenlace posible es FAILED. FAILED
    // pertenece a CLAIMABLE_STATUSES: si el primer worker completaba todo
    // su ciclo (reclamo->intento->FAILED) antes de que el segundo llegara
    // siquiera a intentar su propio reclamo, el segundo podía reclamar
    // legítimamente el job YA VUELTO A FAILED -- dos intentos reales, pero
    // NUNCA una violación del CAS (confirmado cruzando con la prueba
    // equivalente y ya existente "10) dos processDeliveryJob concurrentes"
    // de catastroxDeliveryLifecycle.test.js, que sí pasa de forma estable
    // porque termina en SENT, un estado terminal NO reclamable). Esta
    // versión usa una orden APPROVED contra el predio fixture
    // INTEGRATION_TEST_CODIGO (mismo patrón que esa prueba) para que el
    // único desenlace posible sea SENT -- así, sin importar el orden real
    // de llegada de los dos reclamos, el segundo NUNCA encuentra el job en
    // un estado reclamable una vez que el primero lo mueve a SENT.
    const originalFetch = globalThis.fetch;
    const originalAppEnv = process.env.APP_ENV;
    const originalEmailProvider = process.env.EMAIL_PROVIDER;
    const originalResendApiKey = process.env.RESEND_API_KEY;
    const originalEmailFrom = process.env.EMAIL_FROM;

    const MOCK_TILE_BUFFER = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    );
    let sendCount = 0;
    globalThis.fetch = async (url) => {
      const urlString = String(url);
      if (urlString.includes('arcgisonline.com')) {
        return new Response(MOCK_TILE_BUFFER, { status: 200, headers: { 'Content-Type': 'image/png' } });
      }
      if (urlString.includes('api.resend.com')) {
        sendCount += 1;
        return new Response(JSON.stringify({ id: `msg_worker_cas_${sendCount}` }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`fetch no mockeado en la prueba 28: ${urlString}`);
    };
    process.env.APP_ENV = 'staging'; // único ambiente donde emailSender llama al proveedor real (mockeado arriba)
    process.env.EMAIL_PROVIDER = 'resend';
    process.env.RESEND_API_KEY = 're_synthetic_test_key_1234567890';
    process.env.EMAIL_FROM = 'CatastroX <no-reply@mail.staging.agrogenomax.com>';

    try {
      const order = await createOrder({ status: 'APPROVED', canonicalPredioId: INTEGRATION_TEST_CODIGO });
      const job = await createJob(order);
      assert.equal(job.status, 'QUEUED', '1. job QUEUED persistido');

      const sharedFindJobIds = async () => [job.id]; // 2. ambos workers descubren el mismo id
      const workerA = createDeliveryWorker({
        findJobIds: sharedFindJobIds,
        processJob: (jobId) => deliveryJobService.processDeliveryJob(jobId),
        logger: { log: () => {}, error: () => {} },
      });
      const workerB = createDeliveryWorker({
        findJobIds: sharedFindJobIds,
        processJob: (jobId) => deliveryJobService.processDeliveryJob(jobId),
        logger: { log: () => {}, error: () => {} },
      });

      // 3. ambos ejecutan runOnce()/processJob simultáneamente -- sin
      // sleeps ni bloqueo manual de ninguno de los dos: la corrección debe
      // venir exclusivamente del CAS real de Postgres.
      await Promise.all([workerA.runOnce(), workerB.runOnce()]);

      const attempts = await deliveryJobService.listAttemptsForJob(job.id);
      assert.equal(attempts.length, 1, '4/5. solo un claim/intento efectivo debe haber progresado'); // 4, 5

      const deliverables = await deliveryJobService.listDeliverablesForJob(job.id);
      assert.equal(deliverables.length, 1, '6. solo un deliverable debe haberse creado'); // 6

      assert.equal(sendCount, 1, '7. solo una llamada real al proveedor de correo (mock)'); // 7

      const finalJob = await deliveryJobService.findLatestDeliveryJobForOrder(order.id);
      assert.equal(finalJob.status, 'SENT', '8. estado final SENT'); // 8
      assert.equal(finalJob.attempt_count, 1, 'el segundo worker no debe haber incrementado attempt_count de nuevo');

      // 9. ningún segundo intento después de SENT -- un tercer runOnce()
      // sobre el mismo id no debe reclamar nada (SENT no está en
      // CLAIMABLE_STATUSES).
      const workerC = createDeliveryWorker({
        findJobIds: sharedFindJobIds,
        processJob: (jobId) => deliveryJobService.processDeliveryJob(jobId),
        logger: { log: () => {}, error: () => {} },
      });
      await workerC.runOnce();
      assert.equal(sendCount, 1, '9. ningún envío adicional tras SENT');
      assert.equal((await deliveryJobService.listAttemptsForJob(job.id)).length, 1, '9. ningún intento adicional tras SENT');
    } finally {
      globalThis.fetch = originalFetch;
      if (originalAppEnv === undefined) delete process.env.APP_ENV;
      else process.env.APP_ENV = originalAppEnv;
      if (originalEmailProvider === undefined) delete process.env.EMAIL_PROVIDER;
      else process.env.EMAIL_PROVIDER = originalEmailProvider;
      if (originalResendApiKey === undefined) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = originalResendApiKey;
      if (originalEmailFrom === undefined) delete process.env.EMAIL_FROM;
      else process.env.EMAIL_FROM = originalEmailFrom;
    }
  });
});
