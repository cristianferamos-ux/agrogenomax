import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  getAgxBusinessPool,
  withOrganizacionTransaction,
  closeAgxBusinessPool,
  __hasAgxBusinessPoolForTests,
  __resetAgxBusinessPoolForTests,
} from '../agxBusinessPool.js';
import { getConfig, ConfigurationError, __resetValidationStateForTests } from '../../config/env.js';

const FAKE_CONNECTION_STRING = 'postgres://test:test@192.0.2.1:5432/never_connects';
const FAKE_ORG_ID = '11111111-1111-1111-1111-111111111111';

function makeFakeClient() {
  return {
    queries: [],
    released: false,
    async query(text, params) {
      this.queries.push({ text, params });
      return { rows: [] };
    },
    release() {
      this.released = true;
    },
  };
}

describe('BFF-001: server/db/agxBusinessPool.js -- pool del plano de negocio (agx_app)', () => {
  beforeEach(() => {
    __resetAgxBusinessPoolForTests();
    __resetValidationStateForTests();
  });

  test('importar el módulo no construye un Pool', () => {
    assert.equal(__hasAgxBusinessPoolForTests(), false);
  });

  test('no puede crearse antes de validar configuración', () => {
    assert.throws(
      () => getAgxBusinessPool({ AGX_BUSINESS_DATABASE_URL: FAKE_CONNECTION_STRING }),
      (error) => error instanceof ConfigurationError && error.code === 'CONFIG_NOT_VALIDATED',
    );
  });

  test('sin AGX_BUSINESS_DATABASE_URL falla-cerrado', () => {
    getConfig({ APP_ENV: 'development' }, {});
    assert.throws(() => getAgxBusinessPool({}), (error) => error.code === 'AGX_BUSINESS_DB_NOT_CONFIGURED');
  });

  describe('withOrganizacionTransaction -- BEGIN / SELECT set_config(..., true) / COMMIT / ROLLBACK', () => {
    test('usa exactamente set_config(\'app.current_org_id\', $1, true) -- NUNCA "SET LOCAL app.current_org_id = $1"', async () => {
      getConfig({ APP_ENV: 'development' }, {});
      const pool = getAgxBusinessPool({ AGX_BUSINESS_DATABASE_URL: FAKE_CONNECTION_STRING });
      const fakeClient = makeFakeClient();
      pool.connect = async () => fakeClient;

      await withOrganizacionTransaction(FAKE_ORG_ID, async (client) => {
        await client.query('select 1');
      });

      assert.deepEqual(
        fakeClient.queries.map((q) => q.text),
        ['BEGIN', "SELECT set_config('app.current_org_id', $1, true)", 'select 1', 'COMMIT'],
      );
      assert.deepEqual(fakeClient.queries[1].params, [FAKE_ORG_ID]);
      assert.equal(
        fakeClient.queries.some((q) => /SET\s+LOCAL/i.test(q.text)),
        false,
        'no debe usarse SET LOCAL en ningún punto',
      );
    });

    test('usa el MISMO client durante todo BEGIN->consultas->COMMIT -- nunca pool.query() suelto', async () => {
      getConfig({ APP_ENV: 'development' }, {});
      const pool = getAgxBusinessPool({ AGX_BUSINESS_DATABASE_URL: FAKE_CONNECTION_STRING });
      const fakeClient = makeFakeClient();
      let poolQueryCalls = 0;
      pool.connect = async () => fakeClient;
      pool.query = async () => {
        poolQueryCalls += 1;
        return { rows: [] };
      };

      let receivedClient;
      await withOrganizacionTransaction(FAKE_ORG_ID, async (client) => {
        receivedClient = client;
        await client.query('select 2');
      });

      assert.equal(receivedClient, fakeClient);
      assert.equal(poolQueryCalls, 0, 'pool.query() nunca debe invocarse dentro de la transacción');
    });

    test('COMMIT solo se ejecuta si fn() resuelve sin lanzar', async () => {
      getConfig({ APP_ENV: 'development' }, {});
      const pool = getAgxBusinessPool({ AGX_BUSINESS_DATABASE_URL: FAKE_CONNECTION_STRING });
      const fakeClient = makeFakeClient();
      pool.connect = async () => fakeClient;

      const result = await withOrganizacionTransaction(FAKE_ORG_ID, async () => 'ok');
      assert.equal(result, 'ok');
      assert.ok(fakeClient.queries.some((q) => q.text === 'COMMIT'));
      assert.equal(fakeClient.queries.some((q) => q.text === 'ROLLBACK'), false);
    });

    test('ROLLBACK se ejecuta y el error original se relanza si fn() lanza', async () => {
      getConfig({ APP_ENV: 'development' }, {});
      const pool = getAgxBusinessPool({ AGX_BUSINESS_DATABASE_URL: FAKE_CONNECTION_STRING });
      const fakeClient = makeFakeClient();
      pool.connect = async () => fakeClient;

      await assert.rejects(
        () =>
          withOrganizacionTransaction(FAKE_ORG_ID, async () => {
            throw new Error('fallo simulado de negocio');
          }),
        /fallo simulado de negocio/,
      );
      assert.ok(fakeClient.queries.some((q) => q.text === 'ROLLBACK'));
      assert.equal(fakeClient.queries.some((q) => q.text === 'COMMIT'), false);
    });

    test('client.release() siempre se llama -- éxito y error', async () => {
      getConfig({ APP_ENV: 'development' }, {});
      const pool = getAgxBusinessPool({ AGX_BUSINESS_DATABASE_URL: FAKE_CONNECTION_STRING });

      const fakeClientOk = makeFakeClient();
      pool.connect = async () => fakeClientOk;
      await withOrganizacionTransaction(FAKE_ORG_ID, async () => {});
      assert.equal(fakeClientOk.released, true);

      const fakeClientErr = makeFakeClient();
      pool.connect = async () => fakeClientErr;
      await assert.rejects(() =>
        withOrganizacionTransaction(FAKE_ORG_ID, async () => {
          throw new Error('boom');
        }),
      );
      assert.equal(fakeClientErr.released, true);
    });

    test('dos transacciones sucesivas adquieren clientes independientes (nunca reutilizan/filtran contexto entre sí)', async () => {
      getConfig({ APP_ENV: 'development' }, {});
      const pool = getAgxBusinessPool({ AGX_BUSINESS_DATABASE_URL: FAKE_CONNECTION_STRING });
      const clients = [makeFakeClient(), makeFakeClient()];
      let call = 0;
      pool.connect = async () => clients[call++];

      await withOrganizacionTransaction('11111111-1111-1111-1111-111111111111', async () => {});
      await withOrganizacionTransaction('22222222-2222-2222-2222-222222222222', async () => {});

      assert.notEqual(clients[0], clients[1]);
      assert.deepEqual(clients[0].queries[1].params, ['11111111-1111-1111-1111-111111111111']);
      assert.deepEqual(clients[1].queries[1].params, ['22222222-2222-2222-2222-222222222222']);
      // Nota: esto prueba la disciplina del código (nunca reutiliza/filtra un
      // client entre transacciones). La garantía de que `set_config(...,
      // true)` en sí no sobrevive fuera de su propia transacción es un
      // comportamiento del motor de PostgreSQL (documentado, no algo que
      // este código pudiera romper de forma independiente) -- verificarlo
      // contra un Postgres real queda fuera de este lote (ver informe).
    });
  });

  describe('cierre del pool', () => {
    test('closeAgxBusinessPool() sobre un Pool nunca creado no lo crea', async () => {
      assert.equal(__hasAgxBusinessPoolForTests(), false);
      await assert.doesNotReject(() => closeAgxBusinessPool());
    });

    test('closeAgxBusinessPool() invoca end() y libera la referencia', async () => {
      getConfig({ APP_ENV: 'development' }, {});
      const createdPool = getAgxBusinessPool({ AGX_BUSINESS_DATABASE_URL: FAKE_CONNECTION_STRING });
      let endCalls = 0;
      createdPool.end = async () => {
        endCalls += 1;
      };
      await closeAgxBusinessPool();
      assert.equal(endCalls, 1);
      assert.equal(__hasAgxBusinessPoolForTests(), false);
    });
  });
});
