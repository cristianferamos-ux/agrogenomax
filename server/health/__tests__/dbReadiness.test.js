import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { checkPostgresReadiness, __resetReadinessStateForTests } from '../dbReadiness.js';

// LOTE-007 (ADR-012 §7/§14): dobles de pool en memoria -- nunca una
// conexión real a PostgreSQL/PostGIS.

function fakePool({ totalCount = 0, idleCount = 0, waitingCount = 0, max = 10, query } = {}) {
  return {
    totalCount,
    idleCount,
    waitingCount,
    options: { max },
    query: query || (async () => ({ rows: [{}] })),
  };
}

describe('LOTE-007: server/health/dbReadiness.js', () => {
  test('pool ausente reporta not_configured sin lanzar', async () => {
    const result = await checkPostgresReadiness(null);
    assert.deepEqual(result, { ok: false, code: 'not_configured' });
  });

  test('consulta exitosa reporta ok', async () => {
    const pool = fakePool();
    const result = await checkPostgresReadiness(pool);
    assert.deepEqual(result, { ok: true, code: 'ok' });
    __resetReadinessStateForTests(pool);
  });

  test('pool saturado se reporta sin ejecutar query', async () => {
    let queryCalls = 0;
    const pool = fakePool({
      totalCount: 10,
      idleCount: 0,
      waitingCount: 3,
      max: 10,
      query: async () => {
        queryCalls += 1;
        return { rows: [{}] };
      },
    });
    const result = await checkPostgresReadiness(pool);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'pool_exhausted');
    assert.equal(queryCalls, 0);
    __resetReadinessStateForTests(pool);
  });

  test('timeout estricto clasifica query_timeout sin reintentar', async () => {
    let queryCalls = 0;
    const pool = fakePool({
      query: () => {
        queryCalls += 1;
        return new Promise(() => {}); // nunca resuelve dentro del timeout
      },
    });
    const result = await checkPostgresReadiness(pool, { timeoutMs: 20 });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'query_timeout');
    assert.equal(queryCalls, 1);
    __resetReadinessStateForTests(pool);
  });

  test('error de autenticación se clasifica sin exponer error.message crudo', async () => {
    const pool = fakePool({
      query: async () => {
        const error = new Error('password authentication failed for user "agx" at host 10.0.0.5');
        error.code = '28P01';
        throw error;
      },
    });
    const result = await checkPostgresReadiness(pool);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'auth_failed');
    assert.ok(!JSON.stringify(result).includes('10.0.0.5'));
    __resetReadinessStateForTests(pool);
  });

  test('error de conexión desconocido se clasifica como database_unreachable', async () => {
    const pool = fakePool({
      query: async () => {
        const error = new Error('connect ECONNREFUSED 10.0.0.9:5432');
        error.code = 'ECONNREFUSED';
        throw error;
      },
    });
    const result = await checkPostgresReadiness(pool);
    assert.equal(result.code, 'database_unreachable');
    assert.ok(!JSON.stringify(result).includes('10.0.0.9'));
    __resetReadinessStateForTests(pool);
  });

  test('caché interna breve evita una segunda consulta inmediata', async () => {
    let queryCalls = 0;
    const pool = fakePool({
      query: async () => {
        queryCalls += 1;
        return { rows: [{}] };
      },
    });
    await checkPostgresReadiness(pool, { cacheMs: 5000 });
    await checkPostgresReadiness(pool, { cacheMs: 5000 });
    assert.equal(queryCalls, 1);
    __resetReadinessStateForTests(pool);
  });

  test('verificaciones concurrentes se deduplican', async () => {
    // Checker aislado (import fresco, sin caché ni estado de otras
    // pruebas) para que esta verificación dependa únicamente de sus
    // propias dos llamadas concurrentes sobre el mismo pool.
    const fresh = await import(`../dbReadiness.js?fresh=${Date.now()}-${Math.random()}`);

    let queryCalls = 0;
    let resolveQuery;
    const pool = fakePool({
      query: () => {
        queryCalls += 1;
        return new Promise((resolve) => {
          resolveQuery = resolve;
        });
      },
    });

    const first = fresh.checkPostgresReadiness(pool, { timeoutMs: 5000 });
    const second = fresh.checkPostgresReadiness(pool, { timeoutMs: 5000 });

    // Deja correr el microtask que dispara pool.query() antes de resolverlo:
    // sin este tick, resolveQuery todavía no fue asignado por el checker.
    await Promise.resolve();
    resolveQuery({ rows: [{}] });

    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.equal(queryCalls, 1, 'una sola consulta concurrente para ambas llamadas');
    assert.deepEqual(firstResult, secondResult);
    fresh.__resetReadinessStateForTests(pool);
  });

  test('run personalizado permite verificar dependencias adicionales y recibe timeoutMs', async () => {
    const pool = fakePool();
    let receivedTimeoutMs;
    const result = await checkPostgresReadiness(pool, {
      timeoutMs: 456,
      run: async (_pool, timeoutMs) => {
        receivedTimeoutMs = timeoutMs;
      },
    });
    assert.equal(receivedTimeoutMs, 456);
    assert.equal(result.ok, true);
    __resetReadinessStateForTests(pool);
  });

  test('consulta por defecto (sin run) aplica query_timeout de node-postgres', async () => {
    let receivedConfig;
    const pool = fakePool({
      query: async (config) => {
        receivedConfig = config;
        return { rows: [{}] };
      },
    });
    await checkPostgresReadiness(pool, { timeoutMs: 321 });
    assert.equal(receivedConfig.text, 'select 1');
    assert.equal(receivedConfig.query_timeout, 321);
    __resetReadinessStateForTests(pool);
  });

  test('run personalizado que lanza con readinessCode propaga esa clasificación', async () => {
    const pool = fakePool();
    const result = await checkPostgresReadiness(pool, {
      run: async () => {
        const error = new Error('esquema crítico ausente');
        error.readinessCode = 'schema_missing';
        throw error;
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'schema_missing');
    __resetReadinessStateForTests(pool);
  });
});
