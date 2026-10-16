import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateAnimalesIntegrationEnv, requireAnimalesIntegrationEnv } from '../animales-integration-env.mjs';

const APP = 'AGX_BUSINESS_DATABASE_URL_TEST';
const ADMIN = 'AGX_BUSINESS_INTEGRATION_ADMIN_DATABASE_URL';
const env = { AGX_ALLOW_DISPOSABLE_DB_TESTS: 'yes', AGX_DISPOSABLE_TEST_DB_NAME: 'agx_test', [APP]: 'postgres://agx_app@127.0.0.1:55436/agx_test', [ADMIN]: 'postgres://postgres@127.0.0.1:55436/agx_test' };
for (const name of [APP, ADMIN]) {
  for (const value of [undefined, '', '   ', 'invalid', 'https://localhost/db', 'postgres://user@production.invalid/db']) {
    test(`configuración rechazada: ${name} (${String(value)})`, () => {
      assert.throws(() => validateAnimalesIntegrationEnv({ ...env, [name]: value }), new RegExp(name));
    });
  }
}
test('ignora la URL runtime/producción y valida exclusivamente las dos variables de prueba', () => {
  assert.deepEqual(validateAnimalesIntegrationEnv({ ...env, AGX_BUSINESS_DATABASE_URL: 'postgres://production.invalid/live' }), {
    app: env[APP], admin: env[ADMIN],
  });
});
test('rechaza destinos distintos y un rol app administrativo', () => {
  assert.throws(() => validateAnimalesIntegrationEnv({ ...env, [ADMIN]: env[ADMIN].replace('agx_test', 'other') }), /misma base/);
  assert.throws(() => validateAnimalesIntegrationEnv({ ...env, [ADMIN]: env[ADMIN].replace('55436', '55437') }), /mismo|misma/);
  assert.throws(() => validateAnimalesIntegrationEnv({ ...env, [APP]: env[APP].replace('agx_app', 'postgres') }), /rol agx_app/);
});
for (const failingKind of ['app', 'admin', 'missing', 'ok']) {
  test(`preflight y cierre de pools: ${failingKind}`, async () => {
    const pools = [];
    const factory = (options) => {
      const kind = pools.length === 0 ? 'app' : 'admin';
      const pool = {
        ended: false,
        async query(sql, params) {
          assert.match(sql, /^select /);
          assert.equal(options.connectionTimeoutMillis, 5000);
          if (kind === failingKind) throw new Error('PRIVATE_CONNECTION_DETAILS');
          return { rows: params[1].map((name) => ({ name, relation: failingKind === 'missing' && name === 'animal_eventos' ? null : `agx.${name}` })) };
        },
        async end() { this.ended = true; },
      };
      pools.push(pool);
      return pool;
    };
    if (failingKind === 'ok') await requireAnimalesIntegrationEnv(env, factory);
    else await assert.rejects(requireAnimalesIntegrationEnv(env, factory), (error) => {
      assert.doesNotMatch(error.message, /PRIVATE_CONNECTION_DETAILS/);
      assert.match(error.message, failingKind === 'missing' ? /animal_eventos.*0022/ : new RegExp(`conexión ${failingKind}`));
      return true;
    });
    assert.ok(pools.every((pool) => pool.ended));
  });
}
const app='postgres://agx_app@127.0.0.1:55436/agx_test';
test('rechaza host remoto sobreescrito por query string antes de conectar', () => {
 assert.throws(() => validateAnimalesIntegrationEnv({
  ...env,
  AGX_BUSINESS_DATABASE_URL_TEST: `${app}?host=production.invalid`,
  AGX_BUSINESS_INTEGRATION_ADMIN_DATABASE_URL: 'postgres://postgres@127.0.0.1:55436/agx_test',
 }), /loopback/);
});

test('rechaza integracion sin autorizacion explicita', () => {
  assert.throws(
    () => validateAnimalesIntegrationEnv({
      ...env,
      AGX_ALLOW_DISPOSABLE_DB_TESTS: undefined,
    }),
    /AGX_ALLOW_DISPOSABLE_DB_TESTS/,
  );
});

test('rechaza autorizacion incorrecta', () => {
  assert.throws(
    () => validateAnimalesIntegrationEnv({
      ...env,
      AGX_ALLOW_DISPOSABLE_DB_TESTS: 'true',
    }),
    /AGX_ALLOW_DISPOSABLE_DB_TESTS/,
  );
});

test('rechaza base declarada distinta de la conectada', () => {
  assert.throws(
    () => validateAnimalesIntegrationEnv({
      ...env,
      AGX_DISPOSABLE_TEST_DB_NAME: 'otra_test',
    }),
    /AGX_DISPOSABLE_TEST_DB_NAME/,
  );
});

test('rechaza identificador de base sin sufijo de pruebas', () => {
  assert.throws(
    () => validateAnimalesIntegrationEnv({
      ...env,
      AGX_DISPOSABLE_TEST_DB_NAME: 'agx_production',
    }),
    /AGX_DISPOSABLE_TEST_DB_NAME/,
  );
});