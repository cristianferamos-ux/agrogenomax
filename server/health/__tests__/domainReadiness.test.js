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

  // --- FIX CATASTROX READINESS ARRAY PARSING ------------------------------
  // Caso reproducido y confirmado desde Railway: postgis, catastrox,
  // catastrox_clean y gis existen de verdad, pero el readiness seguía
  // respondiendo schema_missing. Causa raíz: `array_agg(schema_name)`
  // agrega sobre `information_schema.schemata.schema_name`, cuyo tipo real
  // es el dominio `information_schema.sql_identifier` -- el arreglo
  // resultante recibe un OID dinámico sin parser registrado en `pg`
  // (node-postgres), que entonces devuelve el literal de texto crudo de
  // Postgres tal cual ("{catastrox,catastrox_clean,gis}") en vez de un
  // arreglo de JS. `new Set(esaString)` iteraba CARÁCTER POR CARÁCTER, así
  // que `existingSchemas.has('catastrox')` siempre daba `false` sin
  // importar que el esquema existiera. Confirmado empíricamente contra
  // Postgres real antes de corregir (ver informe de entrega). La
  // corrección cambia `array_agg` por `jsonb_agg` -- `jsonb` sí tiene un
  // OID fijo con parser nativo en `pg`, así que `existing_schemas` llega
  // siempre como un arreglo de JS real. Las pruebas de abajo NO pueden
  // ejercitar el parser real de `pg` (los `poolStub` de este archivo nunca
  // tocan un driver real), así que reproducen ambos lados del contrato:
  // el valor que la consulta corregida SÍ produce (un arreglo real), y el
  // valor crudo que la consulta rota producía (para probar que el guard
  // defensivo del código lo trata como "ausente", nunca como una vía para
  // reportar éxito por error).

  test('FIX ARRAY PARSING 1: los tres esquemas presentes como arreglo real (equivalente al caso Railway) -> ok, no lanza', async () => {
    let receivedRun;
    await evaluateCatastroxReadiness({
      getPool: () => ({ id: 'catastrox-pool' }),
      checker: async (_pool, options) => {
        receivedRun = options.run;
        return { ok: true, code: 'ok' };
      },
    });

    const poolStub = {
      query: async () => ({
        // Arreglo real de JS -- exactamente lo que jsonb_agg produce vía
        // el parser de `pg` para columnas jsonb (confirmado empíricamente).
        rows: [{ has_postgis: true, existing_schemas: ['catastrox', 'catastrox_clean', 'gis'] }],
      }),
    };
    await assert.doesNotReject(() => receivedRun(poolStub, 500));
  });

  test('FIX ARRAY PARSING 2: los tres esquemas presentes en cualquier orden -> ok (la verificación no depende del orden)', async () => {
    let receivedRun;
    await evaluateCatastroxReadiness({
      getPool: () => ({ id: 'catastrox-pool' }),
      checker: async (_pool, options) => {
        receivedRun = options.run;
        return { ok: true, code: 'ok' };
      },
    });

    const poolStub = {
      query: async () => ({
        rows: [{ has_postgis: true, existing_schemas: ['gis', 'catastrox_clean', 'catastrox'] }],
      }),
    };
    await assert.doesNotReject(() => receivedRun(poolStub, 500));
  });

  test('FIX ARRAY PARSING 3: un esquema ausente del arreglo real -> schema_missing', async () => {
    let receivedRun;
    await evaluateCatastroxReadiness({
      getPool: () => ({ id: 'catastrox-pool' }),
      checker: async (_pool, options) => {
        receivedRun = options.run;
        return { ok: true, code: 'ok' };
      },
    });

    const poolStub = {
      // Falta 'gis' -- solo dos de los tres esquemas requeridos.
      query: async () => ({ rows: [{ has_postgis: true, existing_schemas: ['catastrox', 'catastrox_clean'] }] }),
    };
    await assert.rejects(() => receivedRun(poolStub, 500), (error) => error.readinessCode === 'schema_missing');
  });

  test('FIX ARRAY PARSING 4: postgis ausente aunque los tres esquemas existan -> schema_missing', async () => {
    let receivedRun;
    await evaluateCatastroxReadiness({
      getPool: () => ({ id: 'catastrox-pool' }),
      checker: async (_pool, options) => {
        receivedRun = options.run;
        return { ok: true, code: 'ok' };
      },
    });

    const poolStub = {
      query: async () => ({
        rows: [{ has_postgis: false, existing_schemas: ['catastrox', 'catastrox_clean', 'gis'] }],
      }),
    };
    await assert.rejects(() => receivedRun(poolStub, 500), (error) => error.readinessCode === 'schema_missing');
  });

  test('FIX ARRAY PARSING 5: existing_schemas vacío (arreglo real, ningún esquema coincide) -> schema_missing', async () => {
    let receivedRun;
    await evaluateCatastroxReadiness({
      getPool: () => ({ id: 'catastrox-pool' }),
      checker: async (_pool, options) => {
        receivedRun = options.run;
        return { ok: true, code: 'ok' };
      },
    });

    const poolStub = {
      query: async () => ({ rows: [{ has_postgis: true, existing_schemas: [] }] }),
    };
    await assert.rejects(() => receivedRun(poolStub, 500), (error) => error.readinessCode === 'schema_missing');
  });

  test('FIX ARRAY PARSING 6 (bug original, defensa): si existing_schemas llegara como el literal de texto crudo de Postgres (nunca debería, tras la corrección), se trata como ausente -- nunca como éxito por accidente', async () => {
    let receivedRun;
    await evaluateCatastroxReadiness({
      getPool: () => ({ id: 'catastrox-pool' }),
      checker: async (_pool, options) => {
        receivedRun = options.run;
        return { ok: true, code: 'ok' };
      },
    });

    const poolStub = {
      query: async () => ({
        // Exactamente el valor crudo que devolvía `array_agg` antes de la
        // corrección (confirmado empíricamente) -- una STRING, no un
        // arreglo. El guard defensivo (Array.isArray) debe tratarla como
        // "ningún esquema presente", nunca reproducir el bug original de
        // `new Set(string)` (que iteraba carácter por carácter y también
        // fallaba, pero por una razón distinta y frágil).
        rows: [{ has_postgis: true, existing_schemas: '{catastrox,catastrox_clean,gis}' }],
      }),
    };
    await assert.rejects(() => receivedRun(poolStub, 500), (error) => error.readinessCode === 'schema_missing');
  });

  test('FIX ARRAY PARSING 7: la consulta corregida usa jsonb_agg, nunca array_agg (guarda contra una reversión silenciosa)', async () => {
    let receivedRun;
    await evaluateCatastroxReadiness({
      getPool: () => ({ id: 'catastrox-pool' }),
      checker: async (_pool, options) => {
        receivedRun = options.run;
        return { ok: true, code: 'ok' };
      },
    });

    let receivedText;
    const poolStub = {
      query: async (config) => {
        receivedText = config.text;
        return { rows: [{ has_postgis: true, existing_schemas: config.values[0] }] };
      },
    };
    await receivedRun(poolStub, 500);

    assert.ok(receivedText.includes('jsonb_agg'), 'la consulta debe usar jsonb_agg');
    assert.ok(!receivedText.includes('array_agg'), 'la consulta no debe volver a usar array_agg');
  });

  test('FIX ARRAY PARSING 8: ningún secreto (cadena de conexión, usuario, host) aparece en el error de schema_missing', async () => {
    let receivedRun;
    await evaluateCatastroxReadiness({
      getPool: () => ({ id: 'catastrox-pool' }),
      checker: async (_pool, options) => {
        receivedRun = options.run;
        return { ok: true, code: 'ok' };
      },
    });

    const secretLookingValue = 'postgres://catastrox:supersecreto123@containers-us-west-1.railway.app:5432/catastrox';
    const poolStub = {
      // Un pool "real" tendría esta cadena en sus opciones internas -- el
      // código de runCatastroxCheck nunca debe leerla ni incluirla en el
      // error, sin importar qué tan "disponible" esté en el objeto pool.
      connectionString: secretLookingValue,
      query: async () => ({ rows: [{ has_postgis: false, existing_schemas: [] }] }),
    };

    try {
      await receivedRun(poolStub, 500);
      assert.fail('se esperaba que lanzara schema_missing');
    } catch (error) {
      assert.equal(error.readinessCode, 'schema_missing');
      assert.equal(error.message, 'critical schema or extension missing');
      assert.ok(!error.message.includes('supersecreto123'));
      assert.ok(!error.message.includes('railway.app'));
      assert.ok(!JSON.stringify(error).includes('supersecreto123'));
    }

    // El resultado final que ve el endpoint de readiness tampoco expone nada.
    const finalResult = await evaluateCatastroxReadiness({
      getPool: () => poolStub,
      checker: async (pool, options) => {
        try {
          await options.run(pool, 500);
          return { ok: true, code: 'ok' };
        } catch (error) {
          return { ok: false, code: error.readinessCode };
        }
      },
    });
    assert.deepEqual(finalResult, { ok: false, code: 'schema_missing', dependency: 'postgis_catastrox' });
    assert.ok(!JSON.stringify(finalResult).includes('supersecreto123'));
  });
});
