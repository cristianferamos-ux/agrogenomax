import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { RATE_LIMIT_WINDOW_SECONDS, RATE_LIMIT_THRESHOLDS, checkAndIncrementRateLimit, clearEmailRateLimit } from '../authRateLimit.js';
import { getAgxAuthPool, __resetAgxAuthPoolForTests } from '../../db/agxAuthPool.js';
import { getConfig, __resetValidationStateForTests } from '../../config/env.js';

// AUTH-001 (aprobado v2.2, §3/§7): rate limit atómico Postgres. Estas
// pruebas usan un fake Postgres EN MEMORIA que reproduce fielmente la
// semántica del UPSERT real (incluida la ventana deslizante) -- no un
// mock ingenuo que simplemente cuenta llamadas -- para poder verificar de
// verdad la lógica de umbral/reseteo/retry-after sin una base de datos
// real.

const FAKE_CONNECTION_STRING = 'postgres://test:test@192.0.2.1:5432/never_connects';

function makeFakeRateLimitTable() {
  const rows = new Map(); // key: `${dimension}:${keyFingerprint}` -> {window_started_at, attempt_count}

  async function query(text, params) {
    if (text.includes('insert into agx.auth_rate_limits')) {
      const [dimension, keyFingerprint] = params;
      const key = `${dimension}:${keyFingerprint}`;
      const now = new Date();
      const existing = rows.get(key);

      if (!existing) {
        const row = { window_started_at: now, attempt_count: 1 };
        rows.set(key, row);
        return { rows: [{ window_started_at: row.window_started_at.toISOString(), attempt_count: row.attempt_count }] };
      }

      const windowExpired = existing.window_started_at.getTime() <= now.getTime() - RATE_LIMIT_WINDOW_SECONDS * 1000;
      if (windowExpired) {
        existing.window_started_at = now;
        existing.attempt_count = 1;
      } else {
        existing.attempt_count += 1;
      }
      return { rows: [{ window_started_at: existing.window_started_at.toISOString(), attempt_count: existing.attempt_count }] };
    }

    if (text.includes('delete from agx.auth_rate_limits')) {
      const [keyFingerprint] = params;
      rows.delete(`email:${keyFingerprint}`);
      return { rows: [] };
    }

    throw new Error(`Query no reconocida por el fake rate-limit table: ${text}`);
  }

  return { rows, query };
}

beforeEach(() => {
  __resetAgxAuthPoolForTests();
  __resetValidationStateForTests();
  getConfig({ APP_ENV: 'development' }, {});
});

describe('AUTH-001: authRateLimit.js -- umbrales y ventana', () => {
  test('constantes: email=5, ip=100, ventana=15min', () => {
    assert.equal(RATE_LIMIT_THRESHOLDS.email, 5);
    assert.equal(RATE_LIMIT_THRESHOLDS.ip, 100);
    assert.equal(RATE_LIMIT_WINDOW_SECONDS, 15 * 60);
  });

  test('email: intentos 1-5 no throttlean, intento 6 SÍ throttlea (umbral 5, bloquea en 6+)', async () => {
    const pool = getAgxAuthPool({ AGX_AUTH_DATABASE_URL: FAKE_CONNECTION_STRING });
    const fake = makeFakeRateLimitTable();
    pool.query = fake.query;

    for (let i = 1; i <= 5; i += 1) {
      const result = await checkAndIncrementRateLimit('email', 'fp-email-1');
      assert.equal(result.throttled, false, `intento ${i} no debía throttlear`);
      assert.equal(result.attemptCount, i);
    }

    const sixth = await checkAndIncrementRateLimit('email', 'fp-email-1');
    assert.equal(sixth.throttled, true);
    assert.equal(sixth.attemptCount, 6);
    assert.ok(sixth.retryAfterSeconds > 0 && sixth.retryAfterSeconds <= RATE_LIMIT_WINDOW_SECONDS);
  });

  test('ip: intentos 1-100 no throttlean, intento 101 SÍ throttlea (umbral 100, bloquea en 101+)', async () => {
    const pool = getAgxAuthPool({ AGX_AUTH_DATABASE_URL: FAKE_CONNECTION_STRING });
    const fake = makeFakeRateLimitTable();
    pool.query = fake.query;

    let last;
    for (let i = 1; i <= 100; i += 1) {
      last = await checkAndIncrementRateLimit('ip', 'fp-ip-1');
    }
    assert.equal(last.throttled, false);
    assert.equal(last.attemptCount, 100);

    const overflow = await checkAndIncrementRateLimit('ip', 'fp-ip-1');
    assert.equal(overflow.throttled, true);
    assert.equal(overflow.attemptCount, 101);
  });

  test('dimensiones/fingerprints distintos son contadores independientes', async () => {
    const pool = getAgxAuthPool({ AGX_AUTH_DATABASE_URL: FAKE_CONNECTION_STRING });
    const fake = makeFakeRateLimitTable();
    pool.query = fake.query;

    await checkAndIncrementRateLimit('email', 'fp-a');
    await checkAndIncrementRateLimit('email', 'fp-a');
    const b = await checkAndIncrementRateLimit('email', 'fp-b');
    assert.equal(b.attemptCount, 1, 'fp-b no debe verse afectado por los intentos de fp-a');
  });

  test('ventana expirada -> el contador se reinicia a 1, no queda "pegado" en throttled', async () => {
    const pool = getAgxAuthPool({ AGX_AUTH_DATABASE_URL: FAKE_CONNECTION_STRING });
    const fake = makeFakeRateLimitTable();
    pool.query = fake.query;

    for (let i = 0; i < 6; i += 1) await checkAndIncrementRateLimit('email', 'fp-ventana');
    const throttledRow = fake.rows.get('email:fp-ventana');
    assert.equal(throttledRow.attempt_count, 6);

    // Simula el paso del tiempo más allá de la ventana.
    throttledRow.window_started_at = new Date(Date.now() - (RATE_LIMIT_WINDOW_SECONDS + 60) * 1000);

    const afterWindow = await checkAndIncrementRateLimit('email', 'fp-ventana');
    assert.equal(afterWindow.throttled, false);
    assert.equal(afterWindow.attemptCount, 1);
  });

  test('clearEmailRateLimit: borra el contador de email, login exitoso puede volver a intentar desde 1', async () => {
    const pool = getAgxAuthPool({ AGX_AUTH_DATABASE_URL: FAKE_CONNECTION_STRING });
    const fake = makeFakeRateLimitTable();
    pool.query = fake.query;

    await checkAndIncrementRateLimit('email', 'fp-clear');
    await checkAndIncrementRateLimit('email', 'fp-clear');
    assert.equal(fake.rows.get('email:fp-clear').attempt_count, 2);

    await clearEmailRateLimit('fp-clear');
    assert.equal(fake.rows.has('email:fp-clear'), false);

    const afterClear = await checkAndIncrementRateLimit('email', 'fp-clear');
    assert.equal(afterClear.attemptCount, 1);
  });

  test('clearEmailRateLimit acepta un client transaccional explícito (runner = client || pool)', async () => {
    const pool = getAgxAuthPool({ AGX_AUTH_DATABASE_URL: FAKE_CONNECTION_STRING });
    const fake = makeFakeRateLimitTable();
    pool.query = async () => {
      throw new Error('no debía usarse el pool -- se pasó un client explícito');
    };

    let usedClientQuery = false;
    const fakeClient = {
      async query(text, params) {
        usedClientQuery = true;
        return fake.query(text, params);
      },
    };

    await clearEmailRateLimit('fp-cualquiera', fakeClient);
    assert.equal(usedClientQuery, true);
  });

  test('retryAfterSeconds nunca es 0 ni negativo cuando throttled=true (Retry-After siempre útil)', async () => {
    const pool = getAgxAuthPool({ AGX_AUTH_DATABASE_URL: FAKE_CONNECTION_STRING });
    const fake = makeFakeRateLimitTable();
    pool.query = fake.query;

    for (let i = 0; i < 6; i += 1) {
      var result = await checkAndIncrementRateLimit('email', 'fp-retry-after');
    }
    assert.equal(result.throttled, true);
    assert.ok(Number.isInteger(result.retryAfterSeconds));
    assert.ok(result.retryAfterSeconds >= 1);
  });

  test('retryAfterSeconds es null cuando throttled=false', async () => {
    const pool = getAgxAuthPool({ AGX_AUTH_DATABASE_URL: FAKE_CONNECTION_STRING });
    const fake = makeFakeRateLimitTable();
    pool.query = fake.query;

    const result = await checkAndIncrementRateLimit('email', 'fp-no-throttle');
    assert.equal(result.retryAfterSeconds, null);
  });
});
