import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  getCatastroxDbPool,
  catastroxQuery,
  closeCatastroxDbPool,
  __hasCatastroxDbPoolForTests,
  __resetCatastroxDbPoolForTests,
} from '../catastroxDb.js';
import { getConfig, ConfigurationError, __resetValidationStateForTests } from '../config/env.js';

// Ver la nota de aislamiento en server/__tests__/db.test.js -- se aplica
// igual aquí: ninguna conexión real, ningún .query()/.connect() sobre un
// Pool real, dirección reservada RFC 5737 cuando se necesita un
// connection string sintácticamente válido.
const FAKE_CONNECTION_STRING = 'postgres://test:test@192.0.2.1:5432/never_connects';

describe('LOTE-002 (corrección): server/catastroxDb.js -- inicialización perezosa del Pool', () => {
  beforeEach(() => {
    __resetCatastroxDbPoolForTests();
    __resetValidationStateForTests();
  });

  test('2. importar catastroxDb.js no construye un Pool', () => {
    // catastroxDb.js no contiene ninguna llamada a `new Pool()` en su
    // nivel superior (verificable por lectura directa del archivo).
    assert.equal(__hasCatastroxDbPoolForTests(), false);
  });

  test('3-bis. un Pool no puede crearse antes de validar configuración (CatastroX)', () => {
    assert.throws(
      () => getCatastroxDbPool({ CATASTROX_DATABASE_URL: FAKE_CONNECTION_STRING }),
      (error) => error instanceof ConfigurationError && error.code === 'CONFIG_NOT_VALIDATED',
    );
    assert.equal(__hasCatastroxDbPoolForTests(), false);
  });

  test('8. production sin CATASTROX_DATABASE_URL falla antes de crear cualquier Pool', () => {
    assert.throws(
      () => getConfig({ APP_ENV: 'production', DATABASE_URL: 'postgres://real-host/agx' }, {}),
      (error) => error.code === 'REQUIRED_VARIABLE_MISSING' && error.variable === 'CATASTROX_DATABASE_URL',
    );
    assert.equal(__hasCatastroxDbPoolForTests(), false);
  });

  test('CATASTROX_DATABASE_URL ausente en development: getCatastroxDbPool() devuelve null (nunca fabrica una URL) y catastroxQuery() falla claramente', async () => {
    getConfig({ APP_ENV: 'development' }, {});
    assert.equal(getCatastroxDbPool({}), null);
    assert.equal(__hasCatastroxDbPoolForTests(), false);

    const original = process.env.CATASTROX_DATABASE_URL;
    delete process.env.CATASTROX_DATABASE_URL;
    try {
      await assert.rejects(
        () => catastroxQuery('select 1'),
        (error) => error.code === 'CATASTROX_DB_NOT_CONFIGURED',
      );
    } finally {
      if (original !== undefined) process.env.CATASTROX_DATABASE_URL = original;
    }
    assert.equal(__hasCatastroxDbPoolForTests(), false);
  });

  test('el Pool se construye correctamente una vez validada la configuración, con CATASTROX_DATABASE_URL presente', () => {
    getConfig({ APP_ENV: 'development' }, {});
    const createdPool = getCatastroxDbPool({ CATASTROX_DATABASE_URL: FAKE_CONNECTION_STRING });
    assert.notEqual(createdPool, null);
    assert.equal(__hasCatastroxDbPoolForTests(), true);
    assert.equal(getCatastroxDbPool({ CATASTROX_DATABASE_URL: FAKE_CONNECTION_STRING }), createdPool);
  });

  test('(LOTE-007) closeCatastroxDbPool() sobre un Pool nunca creado no lo crea', async () => {
    assert.equal(__hasCatastroxDbPoolForTests(), false);
    await assert.doesNotReject(() => closeCatastroxDbPool());
    assert.equal(__hasCatastroxDbPoolForTests(), false);
  });

  test('(LOTE-007) closeCatastroxDbPool() sobre un Pool creado invoca end() y libera la referencia', async () => {
    getConfig({ APP_ENV: 'development' }, {});
    const createdPool = getCatastroxDbPool({ CATASTROX_DATABASE_URL: FAKE_CONNECTION_STRING });
    let endCalls = 0;
    createdPool.end = async () => {
      endCalls += 1;
    };

    await closeCatastroxDbPool();
    assert.equal(endCalls, 1);
    assert.equal(__hasCatastroxDbPoolForTests(), false);
  });

  test('(LOTE-007) closeCatastroxDbPool() es idempotente -- end() se invoca una sola vez', async () => {
    getConfig({ APP_ENV: 'development' }, {});
    const createdPool = getCatastroxDbPool({ CATASTROX_DATABASE_URL: FAKE_CONNECTION_STRING });
    let endCalls = 0;
    createdPool.end = async () => {
      endCalls += 1;
    };

    const [first, second] = await Promise.all([closeCatastroxDbPool(), closeCatastroxDbPool()]);
    await closeCatastroxDbPool();
    assert.equal(endCalls, 1);
    assert.equal(first, second);
  });

  test('(LOTE-007, corrección) tras un cierre exitoso puede crearse y cerrarse una instancia nueva', async () => {
    getConfig({ APP_ENV: 'development' }, {});
    const poolA = getCatastroxDbPool({ CATASTROX_DATABASE_URL: FAKE_CONNECTION_STRING });
    let endCallsA = 0;
    poolA.end = async () => {
      endCallsA += 1;
    };

    await closeCatastroxDbPool();
    assert.equal(endCallsA, 1);
    assert.equal(__hasCatastroxDbPoolForTests(), false);

    const poolB = getCatastroxDbPool({ CATASTROX_DATABASE_URL: FAKE_CONNECTION_STRING });
    assert.notEqual(poolB, poolA);
    let endCallsB = 0;
    poolB.end = async () => {
      endCallsB += 1;
    };

    await closeCatastroxDbPool();
    assert.equal(endCallsB, 1);
    assert.equal(__hasCatastroxDbPoolForTests(), false);
  });

  test('(LOTE-007, corrección) el cierre tardío de una instancia anterior no borra la referencia de una instancia nueva', async () => {
    getConfig({ APP_ENV: 'development' }, {});
    const poolA = getCatastroxDbPool({ CATASTROX_DATABASE_URL: FAKE_CONNECTION_STRING });
    let resolveEndA;
    const endAPromise = new Promise((resolve) => {
      resolveEndA = resolve;
    });
    poolA.end = () => endAPromise;

    const closePromiseA = closeCatastroxDbPool(); // queda pendiente a propósito

    __resetCatastroxDbPoolForTests();
    const poolB = getCatastroxDbPool({ CATASTROX_DATABASE_URL: FAKE_CONNECTION_STRING });
    assert.notEqual(poolB, poolA);

    resolveEndA();
    await closePromiseA;

    assert.equal(__hasCatastroxDbPoolForTests(), true);
    assert.equal(getCatastroxDbPool({ CATASTROX_DATABASE_URL: FAKE_CONNECTION_STRING }), poolB);
  });

  test('(LOTE-007, corrección) un rechazo de end() libera la promesa de cierre y permite reintentar/cerrar una instancia posterior', async () => {
    getConfig({ APP_ENV: 'development' }, {});
    const poolA = getCatastroxDbPool({ CATASTROX_DATABASE_URL: FAKE_CONNECTION_STRING });
    poolA.end = async () => {
      throw new Error('fallo simulado');
    };

    await assert.rejects(() => closeCatastroxDbPool(), /fallo simulado/);
    await assert.doesNotReject(() => closeCatastroxDbPool());

    const poolB = getCatastroxDbPool({ CATASTROX_DATABASE_URL: FAKE_CONNECTION_STRING });
    let endCallsB = 0;
    poolB.end = async () => {
      endCallsB += 1;
    };
    await closeCatastroxDbPool();
    assert.equal(endCallsB, 1);
  });

  test('(LOTE-007, corrección) __resetCatastroxDbPoolForTests() limpia tanto la instancia como el estado de cierre', async () => {
    getConfig({ APP_ENV: 'development' }, {});
    const poolA = getCatastroxDbPool({ CATASTROX_DATABASE_URL: FAKE_CONNECTION_STRING });
    poolA.end = () => new Promise(() => {}); // nunca resuelve -- cierre "colgado" a propósito
    void closeCatastroxDbPool();

    __resetCatastroxDbPoolForTests();
    assert.equal(__hasCatastroxDbPoolForTests(), false);

    const poolB = getCatastroxDbPool({ CATASTROX_DATABASE_URL: FAKE_CONNECTION_STRING });
    let endCallsB = 0;
    poolB.end = async () => {
      endCallsB += 1;
    };
    await closeCatastroxDbPool();
    assert.equal(endCallsB, 1);
    assert.equal(__hasCatastroxDbPoolForTests(), false);
  });

  test('(LOTE-007, corrección final) carrera A/B: el cierre de A termina mientras B ya tiene su propio estado de cierre activo', async () => {
    getConfig({ APP_ENV: 'development' }, {});

    const poolA = getCatastroxDbPool({ CATASTROX_DATABASE_URL: FAKE_CONNECTION_STRING });
    let resolveEndA;
    let endCallsA = 0;
    const endAPromise = new Promise((resolve) => {
      resolveEndA = resolve;
    });
    poolA.end = () => {
      endCallsA += 1;
      return endAPromise;
    };

    // 3. Pool A comienza cierre.
    const closePromiseA = closeCatastroxDbPool();

    // 4. Se resetea/recrea Pool B mientras A sigue cerrando.
    __resetCatastroxDbPoolForTests();
    const poolB = getCatastroxDbPool({ CATASTROX_DATABASE_URL: FAKE_CONNECTION_STRING });
    assert.notEqual(poolB, poolA);

    let resolveEndB;
    let endCallsB = 0;
    const endBPromise = new Promise((resolve) => {
      resolveEndB = resolve;
    });
    poolB.end = () => {
      endCallsB += 1;
      return endBPromise;
    };

    // 5. Comienza cierre de Pool B (A sigue pendiente).
    const closePromiseB1 = closeCatastroxDbPool();
    // 1. Dos cierres simultáneos de la MISMA instancia (B) retornan ===
    // exactamente el mismo objeto Promise.
    const closePromiseB2 = closeCatastroxDbPool();
    assert.equal(closePromiseB1, closePromiseB2);
    assert.notEqual(closePromiseB1, closePromiseA);

    // 6. Termina el cierre de Pool A.
    resolveEndA();
    await closePromiseA;
    // 2. end() de A se ejecutó una sola vez.
    assert.equal(endCallsA, 1);

    // 7-8. El estado de cierre de Pool B sigue intacto -- una tercera
    // llamada retorna exactamente la misma promesa.
    const closePromiseB3 = closeCatastroxDbPool();
    assert.equal(closePromiseB3, closePromiseB1);
    // 9. end() de B todavía no se ejecutó más de una vez.
    assert.equal(endCallsB, 1);

    // 10. Terminar B limpia únicamente su propio estado.
    resolveEndB();
    await closePromiseB1;
    assert.equal(endCallsB, 1);
    assert.equal(__hasCatastroxDbPoolForTests(), false);

    // 12. El cierre posterior de una instancia nueva (C) funciona con
    // normalidad.
    const poolC = getCatastroxDbPool({ CATASTROX_DATABASE_URL: FAKE_CONNECTION_STRING });
    let endCallsC = 0;
    poolC.end = async () => {
      endCallsC += 1;
    };
    await closeCatastroxDbPool();
    assert.equal(endCallsC, 1);
    assert.equal(__hasCatastroxDbPoolForTests(), false);
  });

  test('(LOTE-007, corrección final) 11. un rechazo del cierre de A no borra el estado de cierre de B', async () => {
    getConfig({ APP_ENV: 'development' }, {});

    const poolA = getCatastroxDbPool({ CATASTROX_DATABASE_URL: FAKE_CONNECTION_STRING });
    let rejectEndA;
    const endAPromise = new Promise((_resolve, reject) => {
      rejectEndA = reject;
    });
    poolA.end = () => endAPromise;

    const closePromiseA = closeCatastroxDbPool();
    closePromiseA.catch(() => {});

    __resetCatastroxDbPoolForTests();
    const poolB = getCatastroxDbPool({ CATASTROX_DATABASE_URL: FAKE_CONNECTION_STRING });
    let resolveEndB;
    let endCallsB = 0;
    const endBPromise = new Promise((resolve) => {
      resolveEndB = resolve;
    });
    poolB.end = () => {
      endCallsB += 1;
      return endBPromise;
    };

    const closePromiseB = closeCatastroxDbPool();

    rejectEndA(new Error('fallo simulado de A'));
    await assert.rejects(() => closePromiseA, /fallo simulado de A/);

    assert.equal(closeCatastroxDbPool(), closePromiseB);
    assert.equal(endCallsB, 1);

    resolveEndB();
    await closePromiseB;
    assert.equal(endCallsB, 1);
    assert.equal(__hasCatastroxDbPoolForTests(), false);
  });
});
