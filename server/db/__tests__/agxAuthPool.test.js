import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  getAgxAuthPool,
  closeAgxAuthPool,
  withAuthTransaction,
  __hasAgxAuthPoolForTests,
  __resetAgxAuthPoolForTests,
} from '../agxAuthPool.js';
import { getConfig, ConfigurationError, __resetValidationStateForTests } from '../../config/env.js';

// BFF-001: mismo patrón que server/__tests__/db.test.js -- ninguna prueba
// de este archivo abre una conexión real (pg.Pool no conecta al
// construirse, solo al invocar .query()/.connect()).
const FAKE_CONNECTION_STRING = 'postgres://test:test@192.0.2.1:5432/never_connects';

describe('BFF-001: server/db/agxAuthPool.js -- pool del plano de seguridad (agx_auth)', () => {
  beforeEach(() => {
    __resetAgxAuthPoolForTests();
    __resetValidationStateForTests();
  });

  test('importar el módulo no construye un Pool', () => {
    assert.equal(__hasAgxAuthPoolForTests(), false);
  });

  test('no puede crearse antes de validar configuración', () => {
    assert.throws(
      () => getAgxAuthPool({ AGX_AUTH_DATABASE_URL: FAKE_CONNECTION_STRING }),
      (error) => error instanceof ConfigurationError && error.code === 'CONFIG_NOT_VALIDATED',
    );
    assert.equal(__hasAgxAuthPoolForTests(), false);
  });

  test('sin AGX_AUTH_DATABASE_URL falla-cerrado, nunca inventa una URL', () => {
    getConfig({ APP_ENV: 'development' }, {});
    assert.throws(() => getAgxAuthPool({}), (error) => error.code === 'AGX_AUTH_DB_NOT_CONFIGURED');
    assert.equal(__hasAgxAuthPoolForTests(), false);
  });

  test('se construye correctamente una vez validada la configuración, singleton reutilizado', () => {
    getConfig({ APP_ENV: 'development' }, {});
    const createdPool = getAgxAuthPool({ AGX_AUTH_DATABASE_URL: FAKE_CONNECTION_STRING });
    assert.equal(__hasAgxAuthPoolForTests(), true);
    assert.equal(getAgxAuthPool({ AGX_AUTH_DATABASE_URL: FAKE_CONNECTION_STRING }), createdPool);
  });

  test('es un pool DISTINTO del pool de negocio -- nunca la misma instancia física', async () => {
    getConfig({ APP_ENV: 'development' }, {});
    const authPool = getAgxAuthPool({ AGX_AUTH_DATABASE_URL: FAKE_CONNECTION_STRING });
    const { getAgxBusinessPool, __resetAgxBusinessPoolForTests } = await import('../agxBusinessPool.js');
    __resetAgxBusinessPoolForTests();
    const businessPool = getAgxBusinessPool({ AGX_BUSINESS_DATABASE_URL: FAKE_CONNECTION_STRING });
    assert.notEqual(authPool, businessPool);
    __resetAgxBusinessPoolForTests();
  });

  test('closeAgxAuthPool() sobre un Pool nunca creado no lo crea', async () => {
    assert.equal(__hasAgxAuthPoolForTests(), false);
    await assert.doesNotReject(() => closeAgxAuthPool());
    assert.equal(__hasAgxAuthPoolForTests(), false);
  });

  test('closeAgxAuthPool() invoca end() y libera la referencia', async () => {
    getConfig({ APP_ENV: 'development' }, {});
    const createdPool = getAgxAuthPool({ AGX_AUTH_DATABASE_URL: FAKE_CONNECTION_STRING });
    let endCalls = 0;
    createdPool.end = async () => {
      endCalls += 1;
    };

    await closeAgxAuthPool();
    assert.equal(endCalls, 1);
    assert.equal(__hasAgxAuthPoolForTests(), false);
  });

  test('closeAgxAuthPool() es idempotente', async () => {
    getConfig({ APP_ENV: 'development' }, {});
    const createdPool = getAgxAuthPool({ AGX_AUTH_DATABASE_URL: FAKE_CONNECTION_STRING });
    let endCalls = 0;
    createdPool.end = async () => {
      endCalls += 1;
    };

    const [first, second] = await Promise.all([closeAgxAuthPool(), closeAgxAuthPool()]);
    await closeAgxAuthPool();
    assert.equal(endCalls, 1);
    assert.equal(first, second);
  });
});

describe('AUTH-001: withAuthTransaction (helper transaccional reutilizado por login y password/set)', () => {
  beforeEach(() => {
    __resetAgxAuthPoolForTests();
    __resetValidationStateForTests();
    getConfig({ APP_ENV: 'development' }, {});
  });

  function fakeClient(calls) {
    return {
      async query(text) {
        calls.push(text);
      },
      release() {
        calls.push('RELEASE');
      },
    };
  }

  test('camino feliz: BEGIN -> fn(client) -> COMMIT -> release, en ese orden exacto', async () => {
    const calls = [];
    const client = fakeClient(calls);
    const pool = getAgxAuthPool({ AGX_AUTH_DATABASE_URL: FAKE_CONNECTION_STRING });
    pool.connect = async () => client;

    const result = await withAuthTransaction(async (fnClient) => {
      assert.equal(fnClient, client);
      calls.push('FN');
      return 'valor-de-retorno';
    });

    assert.equal(result, 'valor-de-retorno');
    assert.deepEqual(calls, ['BEGIN', 'FN', 'COMMIT', 'RELEASE']);
  });

  test('fn lanza -> ROLLBACK, release, y el error original se propaga (nunca se traga)', async () => {
    const calls = [];
    const client = fakeClient(calls);
    const pool = getAgxAuthPool({ AGX_AUTH_DATABASE_URL: FAKE_CONNECTION_STRING });
    pool.connect = async () => client;

    const originalError = new Error('fallo intencional dentro de fn');
    await assert.rejects(
      () =>
        withAuthTransaction(async () => {
          calls.push('FN');
          throw originalError;
        }),
      (error) => error === originalError,
    );
    assert.deepEqual(calls, ['BEGIN', 'FN', 'ROLLBACK', 'RELEASE']);
  });

  test('release() se invoca incluso si ROLLBACK mismo falla (finally, nunca fuga el client)', async () => {
    const calls = [];
    const client = {
      async query(text) {
        calls.push(text);
        if (text === 'ROLLBACK') throw new Error('conexión ya caída');
      },
      release() {
        calls.push('RELEASE');
      },
    };
    const pool = getAgxAuthPool({ AGX_AUTH_DATABASE_URL: FAKE_CONNECTION_STRING });
    pool.connect = async () => client;

    await assert.rejects(
      () =>
        withAuthTransaction(async () => {
          throw new Error('fallo original');
        }),
      (error) => error.message === 'fallo original',
    );
    assert.deepEqual(calls, ['BEGIN', 'ROLLBACK', 'RELEASE']);
  });
});
