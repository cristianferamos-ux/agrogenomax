import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { evaluateGanaderiaReadiness } from '../ganaderiaReadiness.js';
import { evaluateCatastroxReadiness } from '../catastroxReadiness.js';

// LOTE-007 (ADR-012 §6/§7/§19): dependencias inyectadas -- nunca se
// importa/conecta un pool real de PostgreSQL/PostGIS en estas pruebas.

describe('LOTE-007: server/health/ganaderiaReadiness.js', () => {
  test('getPool ausente de DATABASE_URL se clasifica como not_configured', async () => {
    const result = await evaluateGanaderiaReadiness({
      getPool: () => {
        const error = new Error('DATABASE_URL no está configurada.');
        error.code = 'AGX_DB_NOT_CONFIGURED';
        throw error;
      },
    });
    assert.deepEqual(result, { ok: false, code: 'not_configured', dependency: 'postgresql_agx' });
  });

  test('checker exitoso reporta ok con el nombre de dependencia agx', async () => {
    const result = await evaluateGanaderiaReadiness({
      getPool: () => ({ id: 'agx-pool' }),
      checker: async () => ({ ok: true, code: 'ok' }),
    });
    assert.deepEqual(result, { ok: true, code: 'ok', dependency: 'postgresql_agx' });
  });

  test('checker con fallo propaga el código clasificado', async () => {
    const result = await evaluateGanaderiaReadiness({
      getPool: () => ({ id: 'agx-pool' }),
      checker: async () => ({ ok: false, code: 'pool_exhausted' }),
    });
    assert.deepEqual(result, { ok: false, code: 'pool_exhausted', dependency: 'postgresql_agx' });
  });

  test('checker recibe una función run que consulta el esquema agx de forma parametrizada', async () => {
    let receivedRun;
    await evaluateGanaderiaReadiness({
      getPool: () => ({ id: 'agx-pool' }),
      checker: async (_pool, options) => {
        receivedRun = options?.run;
        return { ok: true, code: 'ok' };
      },
    });
    assert.equal(typeof receivedRun, 'function');

    const poolStub = {
      query: async (config) => {
        // Nunca concatenación: el esquema viaja como parámetro ($1).
        assert.ok(!config.text.includes('agx'));
        assert.deepEqual(config.values, ['agx']);
        return { rows: [{ schema_exists: true }] };
      },
    };
    await assert.doesNotReject(() => receivedRun(poolStub, 500));
  });

  test('esquema agx ausente clasifica schema_missing vía la query real', async () => {
    let receivedRun;
    await evaluateGanaderiaReadiness({
      getPool: () => ({ id: 'agx-pool' }),
      checker: async (_pool, options) => {
        receivedRun = options.run;
        return { ok: true, code: 'ok' };
      },
    });

    const poolStub = { query: async () => ({ rows: [{ schema_exists: false }] }) };
    await assert.rejects(() => receivedRun(poolStub, 500), (error) => error.readinessCode === 'schema_missing');
  });

  test('run de ganadería propaga timeoutMs como query_timeout', async () => {
    let receivedRun;
    await evaluateGanaderiaReadiness({
      getPool: () => ({ id: 'agx-pool' }),
      checker: async (_pool, options) => {
        receivedRun = options.run;
        return { ok: true, code: 'ok' };
      },
    });

    let receivedTimeout;
    const poolStub = {
      query: async (config) => {
        receivedTimeout = config.query_timeout;
        return { rows: [{ schema_exists: true }] };
      },
    };
    await receivedRun(poolStub, 777);
    assert.equal(receivedTimeout, 777);
  });
});

describe('LOTE-007: server/health/catastroxReadiness.js', () => {
  test('sin CATASTROX_DATABASE_URL (getPool devuelve null) reporta not_configured', async () => {
    const result = await evaluateCatastroxReadiness({ getPool: () => null });
    assert.deepEqual(result, { ok: false, code: 'not_configured', dependency: 'postgis_catastrox' });
  });

  test('checker exitoso reporta ok con el nombre de dependencia catastrox', async () => {
    const result = await evaluateCatastroxReadiness({
      getPool: () => ({ id: 'catastrox-pool' }),
      checker: async () => ({ ok: true, code: 'ok' }),
    });
    assert.deepEqual(result, { ok: true, code: 'ok', dependency: 'postgis_catastrox' });
  });

  test('checker recibe una función run que consulta postgis/esquemas', async () => {
    let receivedRun;
    await evaluateCatastroxReadiness({
      getPool: () => ({ id: 'catastrox-pool' }),
      checker: async (_pool, options) => {
        receivedRun = options?.run;
        return { ok: true, code: 'ok' };
      },
    });
    assert.equal(typeof receivedRun, 'function');
  });

  test('esquema/extensión faltante clasifica schema_missing vía la query real', async () => {
    let receivedRun;
    await evaluateCatastroxReadiness({
      getPool: () => ({ id: 'catastrox-pool' }),
      checker: async (_pool, options) => {
        receivedRun = options.run;
        return { ok: true, code: 'ok' };
      },
    });

    const poolStub = {
      query: async (config) => {
        // Solo el esquema dinámico 'catastrox' existe -- faltan
        // catastrox_clean y gis, y no hay extensión postgis.
        const requested = config.values[0];
        const existing = requested.filter((name) => name === 'catastrox');
        return { rows: [{ has_postgis: false, existing_schemas: existing }] };
      },
    };

    await assert.rejects(() => receivedRun(poolStub, 500), (error) => error.readinessCode === 'schema_missing');
  });

  test('esquema/extensión completos no lanzan', async () => {
    let receivedRun;
    await evaluateCatastroxReadiness({
      getPool: () => ({ id: 'catastrox-pool' }),
      checker: async (_pool, options) => {
        receivedRun = options.run;
        return { ok: true, code: 'ok' };
      },
    });

    const poolStub = {
      query: async (config) => ({
        rows: [{ has_postgis: true, existing_schemas: config.values[0] }],
      }),
    };

    await assert.doesNotReject(() => receivedRun(poolStub, 500));
  });

  test('esquemas requeridos siempre incluyen los literales catastrox, catastrox_clean y gis, sin duplicados', async () => {
    let receivedRun;
    await evaluateCatastroxReadiness({
      getPool: () => ({ id: 'catastrox-pool' }),
      checker: async (_pool, options) => {
        receivedRun = options.run;
        return { ok: true, code: 'ok' };
      },
    });

    let requestedSchemas;
    const poolStub = {
      query: async (config) => {
        requestedSchemas = config.values[0];
        return { rows: [{ has_postgis: true, existing_schemas: requestedSchemas }] };
      },
    };
    await receivedRun(poolStub, 500);

    // El esquema configurado por defecto es 'catastrox', igual a uno de
    // los literales -- no debe duplicarse en el parámetro enviado.
    assert.deepEqual([...requestedSchemas].sort(), ['catastrox', 'catastrox_clean', 'gis']);
  });

  test('run de catastrox propaga timeoutMs como query_timeout', async () => {
    let receivedRun;
    await evaluateCatastroxReadiness({
      getPool: () => ({ id: 'catastrox-pool' }),
      checker: async (_pool, options) => {
        receivedRun = options.run;
        return { ok: true, code: 'ok' };
      },
    });

    let receivedTimeout;
    const poolStub = {
      query: async (config) => {
        receivedTimeout = config.query_timeout;
        return { rows: [{ has_postgis: true, existing_schemas: config.values[0] }] };
      },
    };
    await receivedRun(poolStub, 999);
    assert.equal(receivedTimeout, 999);
  });
});
