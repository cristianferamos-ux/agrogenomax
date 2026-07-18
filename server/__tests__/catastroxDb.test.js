import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  getCatastroxDbPool,
  catastroxQuery,
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
});
