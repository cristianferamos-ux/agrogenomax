import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { getDbPool, pool, query, __hasDbPoolForTests, __resetDbPoolForTests } from '../db.js';
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
});
