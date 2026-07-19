import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { getDbPool, pool, query, closeMainDbPool, __hasDbPoolForTests, __resetDbPoolForTests } from '../db.js';
import { getConfig, ConfigurationError, __resetValidationStateForTests } from '../config/env.js';

// Ninguna prueba de este archivo abre una conexión real: pg.Pool no
// conecta al construirse (solo al invocar .query()/.connect()), y ninguna
// prueba aquí llama a esos métodos sobre una instancia real -- solo
// verifica la existencia/ausencia del Pool y el comportamiento de error
// antes de crearlo. Cuando una prueba sí necesita "un connection string
// presente" para probar la construcción, usa una dirección reservada para
// documentación (RFC 5737 TEST-NET-1), que nunca se llega a contactar.
const FAKE_CONNECTION_STRING = 'postgres://test:test@192.0.2.1:5432/never_connects';

describe('LOTE-002 (corrección): server/db.js -- inicialización perezosa del Pool', () => {
  beforeEach(() => {
    __resetDbPoolForTests();
    __resetValidationStateForTests();
  });

  test('1. importar db.js no construye un Pool', () => {
    // db.js no contiene ninguna llamada a `new Pool()` en su nivel
    // superior (verificable por lectura directa del archivo); esta
    // aserción confirma que, sin haber llamado a getDbPool()/pool.* en
    // este caso, no existe ninguna instancia -- el reset de beforeEach
    // solo limpia estado de casos anteriores, nunca "esconde" una
    // construcción a nivel de módulo, porque tal construcción no existe.
    assert.equal(__hasDbPoolForTests(), false);
  });

  test('3. un Pool no puede crearse antes de validar configuración', () => {
    assert.throws(
      () => getDbPool({ DATABASE_URL: FAKE_CONNECTION_STRING }),
      (error) => error instanceof ConfigurationError && error.code === 'CONFIG_NOT_VALIDATED',
    );
    assert.equal(__hasDbPoolForTests(), false);
  });

  test('4. no existe fallback PostgreSQL fabricado (DATABASE_URL ausente falla, nunca se inventa una URL)', () => {
    getConfig({ APP_ENV: 'development' }, {});
    assert.throws(() => getDbPool({}), (error) => error.code === 'AGX_DB_NOT_CONFIGURED');
    assert.equal(__hasDbPoolForTests(), false);
  });

  test('5. development sin DATABASE_URL no conecta ni crea Pool', () => {
    getConfig({ APP_ENV: 'development' }, {});
    assert.throws(() => getDbPool({}), (error) => error.code === 'AGX_DB_NOT_CONFIGURED');
    assert.equal(__hasDbPoolForTests(), false);
  });

  test('6. una operación que requiere base sin configuración falla claramente (query())', async () => {
    getConfig({ APP_ENV: 'development' }, {});

    const original = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      await assert.rejects(() => query('select 1'), (error) => error.code === 'AGX_DB_NOT_CONFIGURED');
    } finally {
      if (original !== undefined) process.env.DATABASE_URL = original;
    }
    assert.equal(__hasDbPoolForTests(), false);
  });

  test('7. production sin DATABASE_URL falla antes de crear cualquier Pool', () => {
    assert.throws(
      () => getConfig({ APP_ENV: 'production', CATASTROX_DATABASE_URL: 'postgres://real-host/gis' }, {}),
      (error) => error.code === 'REQUIRED_VARIABLE_MISSING' && error.variable === 'DATABASE_URL',
    );
    assert.equal(__hasDbPoolForTests(), false);
  });

  test('el Pool se construye correctamente una vez validada la configuración, con DATABASE_URL presente', () => {
    getConfig({ APP_ENV: 'development' }, {});
    const createdPool = getDbPool({ DATABASE_URL: FAKE_CONNECTION_STRING });
    assert.equal(__hasDbPoolForTests(), true);
    // reutiliza la misma instancia en llamadas posteriores (singleton perezoso).
    assert.equal(getDbPool({ DATABASE_URL: FAKE_CONNECTION_STRING }), createdPool);
  });

  test('pool (proxy de compatibilidad) no crea el Pool real hasta el primer acceso a una propiedad', () => {
    assert.equal(__hasDbPoolForTests(), false);
    getConfig({ APP_ENV: 'development' }, {});

    const original = process.env.DATABASE_URL;
    process.env.DATABASE_URL = FAKE_CONNECTION_STRING;
    try {
      // Validar + fijar DATABASE_URL todavía no construye nada.
      assert.equal(__hasDbPoolForTests(), false);
      // El primer acceso a una propiedad del proxy (usado por
      // server/routes/animales.js y server/routes/qr.js como
      // `pool.connect()`) dispara la construcción perezosa.
      assert.equal(typeof pool.connect, 'function');
      assert.equal(__hasDbPoolForTests(), true);
    } finally {
      if (original === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = original;
    }
  });

  test('(auditoría) compatibilidad del proxy: connect() enlazado, singleton reutilizado, y patrón begin/query/commit/release preservado -- sin conexión real', async () => {
    getConfig({ APP_ENV: 'development' }, {});
    const realPool = getDbPool({ DATABASE_URL: FAKE_CONNECTION_STRING });

    // Sustituye connect() por un stub que nunca toca la red: prueba
    // exclusivamente que el Proxy enlaza y reenvía la llamada al Pool
    // real (mismo patrón que usan server/routes/animales.js y
    // server/routes/qr.js), sin ejecutar ninguna conexión TCP.
    const fakeClient = {
      queries: [],
      async query(text) {
        this.queries.push(text);
        return { rows: [] };
      },
      released: false,
      release() {
        this.released = true;
      },
    };
    realPool.connect = async function stubConnect() {
      // Confirma que el método obtenido vía el proxy invoca esta función
      // con `this` correcto (el propio realPool) -- exactamente lo que
      // pg.Pool.prototype.connect esperaría al ejecutarse.
      assert.equal(this, realPool);
      return fakeClient;
    };

    // Acceso repetido al mismo singleton (misma instancia subyacente).
    assert.equal(getDbPool(), realPool);
    assert.equal(getDbPool(), getDbPool());

    // Patrón real usado por los consumidores: pool.connect() -> begin ->
    // ... -> commit -> release (o rollback -> release ante error).
    const client = await pool.connect();
    assert.equal(client, fakeClient);
    await client.query('begin');
    await client.query('select 1');
    await client.query('commit');
    client.release();

    assert.deepEqual(fakeClient.queries, ['begin', 'select 1', 'commit']);
    assert.equal(fakeClient.released, true);
  });

  test('(auditoría) inspección/serialización del proxy nunca dispara la construcción del Pool ni lanza', async () => {
    // Estado limpio (sin validar, sin pool) -- exactamente el peor caso:
    // cualquiera de estos accesos, antes de esta corrección, lanzaba
    // ConfigurationError (then/await) o TypeError nativo (String/toJSON).
    assert.equal(typeof pool.then, 'undefined');
    assert.equal(await pool, pool); // no-thenable: se resuelve al propio valor
    assert.equal(String(pool), '[object Object]');
    assert.equal(`${pool}`, '[object Object]');
    assert.equal(JSON.stringify(pool), '{}');
    assert.doesNotThrow(() => {
      // eslint-disable-next-line no-unused-expressions
      pool.constructor;
    });
    assert.equal(__hasDbPoolForTests(), false);
  });

  test('(LOTE-007) closeMainDbPool() sobre un Pool nunca creado no lo crea', async () => {
    assert.equal(__hasDbPoolForTests(), false);
    await assert.doesNotReject(() => closeMainDbPool());
    assert.equal(__hasDbPoolForTests(), false);
  });

  test('(LOTE-007) closeMainDbPool() sobre un Pool creado invoca end() y libera la referencia', async () => {
    getConfig({ APP_ENV: 'development' }, {});
    const createdPool = getDbPool({ DATABASE_URL: FAKE_CONNECTION_STRING });
    let endCalls = 0;
    createdPool.end = async () => {
      endCalls += 1;
    };

    assert.equal(__hasDbPoolForTests(), true);
    await closeMainDbPool();
    assert.equal(endCalls, 1);
    assert.equal(__hasDbPoolForTests(), false);
  });

  test('(LOTE-007) closeMainDbPool() es idempotente -- end() se invoca una sola vez', async () => {
    getConfig({ APP_ENV: 'development' }, {});
    const createdPool = getDbPool({ DATABASE_URL: FAKE_CONNECTION_STRING });
    let endCalls = 0;
    createdPool.end = async () => {
      endCalls += 1;
    };

    const [first, second] = await Promise.all([closeMainDbPool(), closeMainDbPool()]);
    await closeMainDbPool(); // llamada adicional tras completarse
    assert.equal(endCalls, 1);
    assert.equal(first, second);
  });

  test('(LOTE-007) closeMainDbPool() controla un end() rechazado sin lanzar de forma no manejable', async () => {
    getConfig({ APP_ENV: 'development' }, {});
    const createdPool = getDbPool({ DATABASE_URL: FAKE_CONNECTION_STRING });
    createdPool.end = async () => {
      throw new Error('fallo simulado de cierre de pool');
    };

    await assert.rejects(() => closeMainDbPool(), /fallo simulado/);
    // La referencia se libera igual (en el finally), incluso ante fallo.
    assert.equal(__hasDbPoolForTests(), false);
  });

  test('(LOTE-007, corrección) tras un cierre exitoso puede crearse y cerrarse una instancia nueva', async () => {
    getConfig({ APP_ENV: 'development' }, {});
    const poolA = getDbPool({ DATABASE_URL: FAKE_CONNECTION_STRING });
    let endCallsA = 0;
    poolA.end = async () => {
      endCallsA += 1;
    };

    await closeMainDbPool();
    assert.equal(endCallsA, 1);
    assert.equal(__hasDbPoolForTests(), false);

    const poolB = getDbPool({ DATABASE_URL: FAKE_CONNECTION_STRING });
    assert.notEqual(poolB, poolA);
    let endCallsB = 0;
    poolB.end = async () => {
      endCallsB += 1;
    };

    await closeMainDbPool();
    assert.equal(endCallsB, 1);
    assert.equal(__hasDbPoolForTests(), false);
  });

  test('(LOTE-007, corrección) el cierre tardío de una instancia anterior no borra la referencia de una instancia nueva', async () => {
    getConfig({ APP_ENV: 'development' }, {});
    const poolA = getDbPool({ DATABASE_URL: FAKE_CONNECTION_STRING });
    // Deferred creado por adelantado (no dentro de `end`): `end()` se
    // invoca dentro de un `.then()` de closeMainDbPool(), un tick después
    // de llamarlo -- si `resolveEndA` se asignara solo al ejecutar `end`,
    // todavía sería `undefined` en el punto donde este test lo necesita.
    let resolveEndA;
    const endAPromise = new Promise((resolve) => {
      resolveEndA = resolve;
    });
    poolA.end = () => endAPromise;

    const closePromiseA = closeMainDbPool(); // queda pendiente a propósito

    // Simula que, mientras A todavía está cerrando, el estado se resetea
    // (p. ej. entre pruebas) y se crea una instancia nueva (B) antes de
    // que el cierre de A termine.
    __resetDbPoolForTests();
    const poolB = getDbPool({ DATABASE_URL: FAKE_CONNECTION_STRING });
    assert.notEqual(poolB, poolA);

    // Ahora se completa el cierre "tardío" de A.
    resolveEndA();
    await closePromiseA;

    // B debe seguir siendo la instancia activa -- el cierre de A no debió
    // borrarla (comprobación de identidad).
    assert.equal(__hasDbPoolForTests(), true);
    assert.equal(getDbPool({ DATABASE_URL: FAKE_CONNECTION_STRING }), poolB);
  });

  test('(LOTE-007, corrección) un rechazo de end() libera la promesa de cierre y permite reintentar/cerrar una instancia posterior', async () => {
    getConfig({ APP_ENV: 'development' }, {});
    const poolA = getDbPool({ DATABASE_URL: FAKE_CONNECTION_STRING });
    poolA.end = async () => {
      throw new Error('fallo simulado');
    };

    await assert.rejects(() => closeMainDbPool(), /fallo simulado/);

    // La promesa de cierre ya no debe quedar "atascada" -- una llamada
    // posterior sin instancia (ya liberada) no lanza ni reutiliza la
    // promesa rechazada anterior.
    await assert.doesNotReject(() => closeMainDbPool());

    const poolB = getDbPool({ DATABASE_URL: FAKE_CONNECTION_STRING });
    let endCallsB = 0;
    poolB.end = async () => {
      endCallsB += 1;
    };
    await closeMainDbPool();
    assert.equal(endCallsB, 1);
  });

  test('(LOTE-007, corrección) __resetDbPoolForTests() limpia tanto la instancia como el estado de cierre', async () => {
    getConfig({ APP_ENV: 'development' }, {});
    const poolA = getDbPool({ DATABASE_URL: FAKE_CONNECTION_STRING });
    poolA.end = () => new Promise(() => {}); // nunca resuelve -- cierre "colgado" a propósito
    void closeMainDbPool();

    __resetDbPoolForTests();
    assert.equal(__hasDbPoolForTests(), false);

    const poolB = getDbPool({ DATABASE_URL: FAKE_CONNECTION_STRING });
    let endCallsB = 0;
    poolB.end = async () => {
      endCallsB += 1;
    };
    await closeMainDbPool();
    assert.equal(endCallsB, 1);
    assert.equal(__hasDbPoolForTests(), false);
  });

  test('(LOTE-007, corrección final) carrera A/B: el cierre de A termina mientras B ya tiene su propio estado de cierre activo', async () => {
    getConfig({ APP_ENV: 'development' }, {});

    // Pool A: cierre controlado manualmente.
    const poolA = getDbPool({ DATABASE_URL: FAKE_CONNECTION_STRING });
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
    const closePromiseA = closeMainDbPool();

    // 4. Se resetea/recrea Pool B mientras A sigue cerrando.
    __resetDbPoolForTests();
    const poolB = getDbPool({ DATABASE_URL: FAKE_CONNECTION_STRING });
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
    const closePromiseB1 = closeMainDbPool();
    // 1. Dos cierres simultáneos de la MISMA instancia (B) retornan ===
    // exactamente el mismo objeto Promise.
    const closePromiseB2 = closeMainDbPool();
    assert.equal(closePromiseB1, closePromiseB2);
    assert.notEqual(closePromiseB1, closePromiseA);

    // 6. Termina el cierre de Pool A.
    resolveEndA();
    await closePromiseA;
    // 2. end() de A se ejecutó una sola vez.
    assert.equal(endCallsA, 1);

    // 7. El estado de cierre de Pool B sigue intacto -- no lo borró el
    // `finally` tardío de A. 8. Una tercera llamada para B retorna
    // exactamente la misma promesa que ya teníamos.
    const closePromiseB3 = closeMainDbPool();
    assert.equal(closePromiseB3, closePromiseB1);
    // 9. end() de B todavía no se ejecutó más de una vez.
    assert.equal(endCallsB, 1);

    // 10. Terminar B limpia únicamente su propio estado.
    resolveEndB();
    await closePromiseB1;
    assert.equal(endCallsB, 1);
    assert.equal(__hasDbPoolForTests(), false);

    // 12. El cierre posterior de una instancia nueva (C) funciona con
    // normalidad, sin arrastrar ningún estado de A ni de B.
    const poolC = getDbPool({ DATABASE_URL: FAKE_CONNECTION_STRING });
    let endCallsC = 0;
    poolC.end = async () => {
      endCallsC += 1;
    };
    await closeMainDbPool();
    assert.equal(endCallsC, 1);
    assert.equal(__hasDbPoolForTests(), false);
  });

  test('(LOTE-007, corrección final) 11. un rechazo del cierre de A no borra el estado de cierre de B', async () => {
    getConfig({ APP_ENV: 'development' }, {});

    const poolA = getDbPool({ DATABASE_URL: FAKE_CONNECTION_STRING });
    let rejectEndA;
    const endAPromise = new Promise((_resolve, reject) => {
      rejectEndA = reject;
    });
    poolA.end = () => endAPromise;

    const closePromiseA = closeMainDbPool();
    closePromiseA.catch(() => {}); // evita "unhandled rejection" en este punto del test

    __resetDbPoolForTests();
    const poolB = getDbPool({ DATABASE_URL: FAKE_CONNECTION_STRING });
    // B también se mantiene "cerrando" (pendiente) durante todo el
    // rechazo de A -- de lo contrario, si `end()` de B resolviera de
    // inmediato, su propio `finally` ya habría liberado el estado antes
    // de que este test pudiera comprobar la identidad de la promesa.
    let resolveEndB;
    let endCallsB = 0;
    const endBPromise = new Promise((resolve) => {
      resolveEndB = resolve;
    });
    poolB.end = () => {
      endCallsB += 1;
      return endBPromise;
    };

    const closePromiseB = closeMainDbPool();

    rejectEndA(new Error('fallo simulado de A'));
    await assert.rejects(() => closePromiseA, /fallo simulado de A/);

    // El estado de cierre de B debe seguir siendo el mismo objeto Promise
    // -- el rechazo de A no debió tocarlo.
    assert.equal(closeMainDbPool(), closePromiseB);
    assert.equal(endCallsB, 1);

    resolveEndB();
    await closePromiseB;
    assert.equal(endCallsB, 1);
    assert.equal(__hasDbPoolForTests(), false);
  });
});
