import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { createGracefulShutdown, resolveShutdownTimeoutMs, DEFAULT_SHUTDOWN_TIMEOUT_MS } from '../gracefulShutdown.js';

// LOTE-007: pruebas de graceful shutdown. Nunca se registran señales
// reales, nunca se llama process.exit() real, y los timers son
// completamente inyectados (setTimer/clearTimer falsos) -- no se usa
// mock.timers ni se espera tiempo real en ningún caso, así que no quedan
// timers reales pendientes al terminar la suite.

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const gracefulShutdownSource = readFileSync(path.resolve(__dirname, '../gracefulShutdown.js'), 'utf8');
const indexSource = readFileSync(path.resolve(__dirname, '../../index.js'), 'utf8');

// Red de seguridad (casos 24/25): si alguna prueba llegara a invocar el
// process.exit() real por no inyectar `exit`, esto lo intercepta y lo
// convierte en un fallo de prueba explícito, en lugar de terminar el
// proceso de pruebas.
const originalProcessExit = process.exit;
before(() => {
  process.exit = (code) => {
    throw new Error(`process.exit(${code}) real invocado durante una prueba -- exit no fue inyectado correctamente.`);
  };
});
after(() => {
  process.exit = originalProcessExit;
});

function makeFakeTimer() {
  let scheduled = null;
  let idCounter = 0;
  const setTimer = (callback, delay) => {
    idCounter += 1;
    scheduled = { id: idCounter, callback, delay };
    return idCounter;
  };
  const clearTimer = (id) => {
    if (scheduled && scheduled.id === id) scheduled = null;
  };
  return {
    setTimer,
    clearTimer,
    trigger() {
      if (!scheduled) throw new Error('No hay timer programado para disparar.');
      const { callback } = scheduled;
      scheduled = null;
      callback();
    },
    isScheduled: () => scheduled !== null,
    getDelay: () => scheduled?.delay,
  };
}

function makeFakeServer({ behavior = 'success' } = {}) {
  let closeCalls = 0;
  return {
    close(callback) {
      closeCalls += 1;
      if (behavior === 'success') {
        queueMicrotask(() => callback());
      } else if (behavior === 'error') {
        queueMicrotask(() => callback(new Error('fallo simulado de server.close')));
      }
      // behavior === 'hang': nunca invoca el callback (simula que las
      // conexiones activas nunca terminan -- el timeout debe intervenir).
    },
    getCloseCalls: () => closeCalls,
  };
}

function makeResource(name, { behavior = 'success' } = {}) {
  let calls = 0;
  return {
    name,
    async close() {
      calls += 1;
      if (behavior === 'error') {
        const error = new Error('fallo simulado de recurso');
        error.code = 'FAKE_RESOURCE_ERROR';
        throw error;
      }
      if (behavior === 'hang') {
        return new Promise(() => {}); // nunca resuelve
      }
    },
    getCalls: () => calls,
  };
}

function makeExitSpy() {
  const calls = [];
  return { exit: (code) => calls.push(code), getCalls: () => calls };
}

function makeReporterSpy() {
  const events = [];
  return { reporter: (event) => events.push(event), getEvents: () => events };
}

describe('LOTE-007: server/lifecycle/gracefulShutdown.js', () => {
  test('1. SIGTERM inicia cierre', () => {
    const server = makeFakeServer();
    const timer = makeFakeTimer();
    const { exit } = makeExitSpy();
    const controller = createGracefulShutdown({ server, exit, setTimer: timer.setTimer, clearTimer: timer.clearTimer });

    assert.equal(controller.isShuttingDown(), false);
    controller.handleSignal('SIGTERM');
    assert.equal(controller.isShuttingDown(), true);
  });

  test('2. SIGINT inicia cierre', () => {
    const server = makeFakeServer();
    const timer = makeFakeTimer();
    const { exit } = makeExitSpy();
    const controller = createGracefulShutdown({ server, exit, setTimer: timer.setTimer, clearTimer: timer.clearTimer });

    assert.equal(controller.isShuttingDown(), false);
    controller.handleSignal('SIGINT');
    assert.equal(controller.isShuttingDown(), true);
  });

  test('3. server.close se ejecuta una sola vez', async () => {
    const server = makeFakeServer();
    const timer = makeFakeTimer();
    const { exit } = makeExitSpy();
    const controller = createGracefulShutdown({ server, exit, setTimer: timer.setTimer, clearTimer: timer.clearTimer });

    await controller.handleSignal('SIGTERM');
    controller.handleSignal('SIGTERM');
    controller.handleSignal('SIGINT');
    assert.equal(server.getCloseCalls(), 1);
  });

  test('4. cierre exitoso finaliza con código 0', async () => {
    const server = makeFakeServer();
    const timer = makeFakeTimer();
    const exitSpy = makeExitSpy();
    const controller = createGracefulShutdown({
      server,
      resources: [makeResource('a'), makeResource('b')],
      exit: exitSpy.exit,
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
    });

    await controller.handleSignal('SIGTERM');
    assert.deepEqual(exitSpy.getCalls(), [0]);
  });

  test('5. cierre HTTP ocurre antes de cerrar pools', async () => {
    const order = [];
    const server = makeFakeServer();
    const originalClose = server.close.bind(server);
    server.close = (callback) => originalClose(() => { order.push('http'); callback(); });

    const resourceA = makeResource('agx_pg_pool');
    resourceA.close = async () => { order.push('agx_pg_pool'); };

    const timer = makeFakeTimer();
    const { exit } = makeExitSpy();
    const controller = createGracefulShutdown({
      server,
      resources: [resourceA],
      exit,
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
    });

    await controller.handleSignal('SIGTERM');
    assert.deepEqual(order, ['http', 'agx_pg_pool']);
  });

  test('6. todos los recursos son cerrados', async () => {
    const server = makeFakeServer();
    const resourceA = makeResource('a');
    const resourceB = makeResource('b');
    const timer = makeFakeTimer();
    const { exit } = makeExitSpy();
    const controller = createGracefulShutdown({
      server,
      resources: [resourceA, resourceB],
      exit,
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
    });

    await controller.handleSignal('SIGTERM');
    assert.equal(resourceA.getCalls(), 1);
    assert.equal(resourceB.getCalls(), 1);
  });

  test('7. recursos se cierran en orden definido (secuencial, según el arreglo resources)', async () => {
    const order = [];
    const server = makeFakeServer();
    const resourceA = { name: 'a', close: async () => { order.push('a'); } };
    const resourceB = { name: 'b', close: async () => { order.push('b'); } };
    const timer = makeFakeTimer();
    const { exit } = makeExitSpy();
    const controller = createGracefulShutdown({
      server,
      resources: [resourceA, resourceB],
      exit,
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
    });

    await controller.handleSignal('SIGTERM');
    assert.deepEqual(order, ['a', 'b']);
  });

  test('8. pool no inicializado no se crea (recurso nunca invocado si close() no crea nada)', async () => {
    let poolCreated = false;
    const resource = {
      name: 'agx_pg_pool',
      async close() {
        // Simula closeMainDbPool(): si el pool nunca fue creado, esta
        // función no debe crearlo -- únicamente se limita a no hacer nada.
        if (!poolCreated) return;
        poolCreated = false;
      },
    };
    const server = makeFakeServer();
    const timer = makeFakeTimer();
    const { exit } = makeExitSpy();
    const controller = createGracefulShutdown({
      server,
      resources: [resource],
      exit,
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
    });

    await controller.handleSignal('SIGTERM');
    assert.equal(poolCreated, false);
  });

  test('9. pool inicializado ejecuta end() (verificado mediante recurso que expone su propio contador)', async () => {
    let endCalls = 0;
    const resource = { name: 'agx_pg_pool', close: async () => { endCalls += 1; } };
    const server = makeFakeServer();
    const timer = makeFakeTimer();
    const { exit } = makeExitSpy();
    const controller = createGracefulShutdown({
      server,
      resources: [resource],
      exit,
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
    });

    await controller.handleSignal('SIGTERM');
    assert.equal(endCalls, 1);
  });

  test('10. cierre de pool es idempotente (el recurso solo se cierra una vez incluso con señales duplicadas)', async () => {
    const resource = makeResource('agx_pg_pool');
    const server = makeFakeServer();
    const timer = makeFakeTimer();
    const { exit } = makeExitSpy();
    const controller = createGracefulShutdown({
      server,
      resources: [resource],
      exit,
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
    });

    await Promise.all([controller.handleSignal('SIGTERM'), controller.handleSignal('SIGTERM')]);
    await controller.handleSignal('SIGINT');
    assert.equal(resource.getCalls(), 1);
  });

  test('11. fallo de un recurso no evita cerrar el siguiente', async () => {
    const resourceA = makeResource('a', { behavior: 'error' });
    const resourceB = makeResource('b');
    const server = makeFakeServer();
    const timer = makeFakeTimer();
    const { exit } = makeExitSpy();
    const controller = createGracefulShutdown({
      server,
      resources: [resourceA, resourceB],
      exit,
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
    });

    await controller.handleSignal('SIGTERM');
    assert.equal(resourceA.getCalls(), 1);
    assert.equal(resourceB.getCalls(), 1);
  });

  test('12. fallo de recurso produce código 1', async () => {
    const resourceA = makeResource('a', { behavior: 'error' });
    const server = makeFakeServer();
    const timer = makeFakeTimer();
    const exitSpy = makeExitSpy();
    const controller = createGracefulShutdown({
      server,
      resources: [resourceA],
      exit: exitSpy.exit,
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
    });

    await controller.handleSignal('SIGTERM');
    assert.deepEqual(exitSpy.getCalls(), [1]);
  });

  test('13. error de server.close produce código 1 (y aun así intenta cerrar los recursos)', async () => {
    const server = makeFakeServer({ behavior: 'error' });
    const resourceA = makeResource('a');
    const timer = makeFakeTimer();
    const exitSpy = makeExitSpy();
    const controller = createGracefulShutdown({
      server,
      resources: [resourceA],
      exit: exitSpy.exit,
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
    });

    await controller.handleSignal('SIGTERM');
    assert.deepEqual(exitSpy.getCalls(), [1]);
    assert.equal(resourceA.getCalls(), 1);
  });

  test('14. timeout produce código 1', async () => {
    const server = makeFakeServer({ behavior: 'hang' });
    const timer = makeFakeTimer();
    const exitSpy = makeExitSpy();
    const controller = createGracefulShutdown({
      server,
      exit: exitSpy.exit,
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
    });

    controller.handleSignal('SIGTERM');
    assert.equal(timer.isScheduled(), true);
    timer.trigger();
    assert.deepEqual(exitSpy.getCalls(), [1]);
  });

  test('15. timeout no produce dos exits (incluso si el cierre real termina después)', async () => {
    let resolveResourceClose;
    const resource = {
      name: 'slow',
      close: () => new Promise((resolve) => { resolveResourceClose = resolve; }),
    };
    const server = makeFakeServer();
    const timer = makeFakeTimer();
    const exitSpy = makeExitSpy();
    const controller = createGracefulShutdown({
      server,
      resources: [resource],
      exit: exitSpy.exit,
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
    });

    controller.handleSignal('SIGTERM');
    // El servidor HTTP ya cerró (microtask), pero el recurso "slow" sigue
    // pendiente cuando el timeout se dispara.
    await Promise.resolve();
    await Promise.resolve();
    timer.trigger();
    assert.deepEqual(exitSpy.getCalls(), [1]);

    // Ahora se completa el cierre "tardío" del recurso -- no debe producir
    // un segundo exit.
    resolveResourceClose();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(exitSpy.getCalls(), [1]);
  });

  test('16. cierre exitoso limpia el timer', async () => {
    const server = makeFakeServer();
    const timer = makeFakeTimer();
    const { exit } = makeExitSpy();
    const controller = createGracefulShutdown({ server, exit, setTimer: timer.setTimer, clearTimer: timer.clearTimer });

    controller.handleSignal('SIGTERM');
    assert.equal(timer.isScheduled(), true);
    await controller.waitForShutdown();
    assert.equal(timer.isScheduled(), false);
  });

  test('17. llamada duplicada no repite server.close', async () => {
    const server = makeFakeServer();
    const timer = makeFakeTimer();
    const { exit } = makeExitSpy();
    const controller = createGracefulShutdown({ server, exit, setTimer: timer.setTimer, clearTimer: timer.clearTimer });

    controller.handleSignal('SIGTERM');
    controller.handleSignal('SIGTERM');
    controller.handleSignal('SIGINT');
    await controller.waitForShutdown();
    assert.equal(server.getCloseCalls(), 1);
  });

  test('18. llamada duplicada no repite recursos', async () => {
    const resource = makeResource('a');
    const server = makeFakeServer();
    const timer = makeFakeTimer();
    const { exit } = makeExitSpy();
    const controller = createGracefulShutdown({
      server,
      resources: [resource],
      exit,
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
    });

    controller.handleSignal('SIGTERM');
    controller.handleSignal('SIGTERM');
    await controller.waitForShutdown();
    assert.equal(resource.getCalls(), 1);
  });

  test('19. telemetría no expone URLs ni credenciales', async () => {
    const sensitiveError = new Error(
      'connection to postgres://usuario:secreto123@db-real-host.internal:5432/agx failed',
    );
    sensitiveError.code = 'ECONNREFUSED';
    const resource = { name: 'agx_pg_pool', close: async () => { throw sensitiveError; } };
    const server = makeFakeServer();
    const timer = makeFakeTimer();
    const { exit } = makeExitSpy();
    const reporterSpy = makeReporterSpy();
    const controller = createGracefulShutdown({
      server,
      resources: [resource],
      exit,
      reporter: reporterSpy.reporter,
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
    });

    await controller.handleSignal('SIGTERM');
    const serialized = JSON.stringify(reporterSpy.getEvents());
    assert.ok(!serialized.includes('secreto123'));
    assert.ok(!serialized.includes('postgres://'));
    assert.ok(!serialized.includes('db-real-host'));
    assert.ok(serialized.includes('ECONNREFUSED'));
  });

  test('20. el módulo no registra señales automáticamente al importarse', () => {
    // Solo código ejecutable -- el docstring del módulo menciona
    // `process.on('SIGTERM'|'SIGINT', ...)` a modo de explicación, lo cual
    // es intencional y no debe confundirse con un registro real.
    const codeLines = gracefulShutdownSource
      .split('\n')
      .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*') && !line.trim().startsWith('/**'));
    const codeOnly = codeLines.join('\n');
    assert.ok(!codeOnly.includes("process.on('SIGTERM'"));
    assert.ok(!codeOnly.includes("process.on('SIGINT'"));
    assert.ok(!codeOnly.includes("process.once('SIGTERM'"));
    assert.ok(!codeOnly.includes("process.once('SIGINT'"));
  });

  test('21. entrypoint registra SIGTERM', () => {
    assert.ok(indexSource.includes("process.once('SIGTERM'"));
  });

  test('22. entrypoint registra SIGINT', () => {
    assert.ok(indexSource.includes("process.once('SIGINT'"));
  });

  test('23. handlers usan once o mecanismo equivalente', () => {
    assert.ok(indexSource.includes("process.once('SIGTERM'"));
    assert.ok(indexSource.includes("process.once('SIGINT'"));
    assert.ok(!indexSource.includes("process.on('SIGTERM'"));
    assert.ok(!indexSource.includes("process.on('SIGINT'"));
  });

  test('24. exit está inyectado en pruebas (nunca se usa el default real dentro de esta suite)', async () => {
    const server = makeFakeServer();
    const timer = makeFakeTimer();
    const exitSpy = makeExitSpy();
    const controller = createGracefulShutdown({
      server,
      exit: exitSpy.exit,
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
    });
    await controller.handleSignal('SIGTERM');
    assert.deepEqual(exitSpy.getCalls(), [0]);
  });

  test('25. ningún test termina el proceso real (red de seguridad activa)', () => {
    assert.notEqual(process.exit, originalProcessExit);
    assert.throws(() => process.exit(0), /process\.exit\(0\) real invocado/);
  });

  test('30. timeout configurable válido', () => {
    assert.equal(resolveShutdownTimeoutMs({ SHUTDOWN_TIMEOUT_MS: '20000' }), 20000);
    assert.equal(resolveShutdownTimeoutMs({ SHUTDOWN_TIMEOUT_MS: '15000' }), 15000);
  });

  test('31. timeout inválido utiliza comportamiento seguro (default)', () => {
    assert.equal(resolveShutdownTimeoutMs({ SHUTDOWN_TIMEOUT_MS: 'no-es-un-numero' }), DEFAULT_SHUTDOWN_TIMEOUT_MS);
    assert.equal(resolveShutdownTimeoutMs({ SHUTDOWN_TIMEOUT_MS: '-5' }), DEFAULT_SHUTDOWN_TIMEOUT_MS);
    assert.equal(resolveShutdownTimeoutMs({ SHUTDOWN_TIMEOUT_MS: '1' }), DEFAULT_SHUTDOWN_TIMEOUT_MS);
    assert.equal(resolveShutdownTimeoutMs({ SHUTDOWN_TIMEOUT_MS: '999999' }), DEFAULT_SHUTDOWN_TIMEOUT_MS);
    assert.equal(resolveShutdownTimeoutMs({ SHUTDOWN_TIMEOUT_MS: '1500.5' }), DEFAULT_SHUTDOWN_TIMEOUT_MS);
    assert.equal(resolveShutdownTimeoutMs({}), DEFAULT_SHUTDOWN_TIMEOUT_MS);
    assert.equal(resolveShutdownTimeoutMs({ SHUTDOWN_TIMEOUT_MS: '' }), DEFAULT_SHUTDOWN_TIMEOUT_MS);
  });

  test('32. ausencia de server produce error controlado', () => {
    assert.throws(() => createGracefulShutdown({}), TypeError);
    assert.throws(() => createGracefulShutdown({ server: { close: 'no-es-funcion' } }), TypeError);
  });

  test('33. recurso sin close válido no rompe el proceso -- se valida al crear', () => {
    const server = makeFakeServer();
    assert.throws(() => createGracefulShutdown({ server, resources: [{ name: 'malo' }] }), TypeError);
    assert.throws(() => createGracefulShutdown({ server, resources: ['no-es-objeto'] }), TypeError);
  });

  test('34. no hay listeners duplicados (una sola línea de registro por señal en el entrypoint)', () => {
    const sigtermMatches = indexSource.match(/process\.once\('SIGTERM'/g) || [];
    const sigintMatches = indexSource.match(/process\.once\('SIGINT'/g) || [];
    assert.equal(sigtermMatches.length, 1);
    assert.equal(sigintMatches.length, 1);
  });

  test('35. no quedan timers pendientes tras un cierre exitoso', async () => {
    const server = makeFakeServer();
    const timer = makeFakeTimer();
    const { exit } = makeExitSpy();
    const controller = createGracefulShutdown({ server, exit, setTimer: timer.setTimer, clearTimer: timer.clearTimer });

    await controller.handleSignal('SIGTERM');
    assert.equal(timer.isScheduled(), false);
  });
});
