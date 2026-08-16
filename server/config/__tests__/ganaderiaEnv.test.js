import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { getConfig, ConfigurationError, __resetValidationStateForTests } from '../env.js';

// BFF-001: validaciones nuevas en server/config/env.js -- 3 variables
// (AGX_AUTH_DATABASE_URL, AGX_BUSINESS_DATABASE_URL, AGX_CSRF_SERVER_SECRET),
// todas opcionales en todos los ambientes por ahora (ver justificación en
// el informe de entrega), prohibidas en demo, con formato validado
// cuando están presentes.

const VALID_CSRF_SECRET = 'gwslZ1bKInXjQ0TLmMqWeV6vRAL2hONB6bTBqpAjVFs='; // 32 bytes base64, sintético
const VALID_FINGERPRINT_SECRET = 'OhWl0C0aTcvlS6gLqCfjLtV/bC3D8CxTGn4txiSCLIc='; // 32 bytes base64, sintético, DISTINTO del de CSRF

// REQUIRED_VARIABLES_BY_ENV.production (server/config/env.js) -- valores
// sintéticos fijos, nunca usados fuera de este archivo, mismo patrón que
// server/config/__tests__/env.test.js.
function validProductionSource(overrides = {}) {
  return {
    APP_ENV: 'production',
    DATABASE_URL: 'postgres://real-host/agx',
    CATASTROX_DATABASE_URL: 'postgres://real-host/gis',
    HEALTH_MONITOR_TOKEN: 'a'.repeat(32),
    CATASTROX_PII_ENCRYPTION_KEY: '/7cHJDrllkKZ+qVKEMuaM+205+vEvpCTRKUArWkx+cc=',
    CATASTROX_PII_HASH_SECRET: 'b'.repeat(32),
    CATASTROX_VERIFY_HANDLE_KEY: 'gwslZ1bKInXjQ0TLmMqWeV6vRAL2hONB6bTBqpAjVFs=',
    CATASTROX_CHECKOUT_IDENTITY_KEY: 'OhWl0C0aTcvlS6gLqCfjLtV/bC3D8CxTGn4txiSCLIc=',
    ...overrides,
  };
}

beforeEach(() => {
  __resetValidationStateForTests();
});

describe('BFF-001: server/config/env.js -- AGX_CSRF_SERVER_SECRET', () => {
  test('ausente -> no bloquea el arranque en ningún ambiente', () => {
    assert.doesNotThrow(() => getConfig({ APP_ENV: 'development' }, {}));
  });

  test('formato válido -> no lanza', () => {
    assert.doesNotThrow(() => getConfig({ APP_ENV: 'development', AGX_CSRF_SERVER_SECRET: VALID_CSRF_SECRET }, {}));
  });

  test('con espacios iniciales/finales -> ConfigurationError', () => {
    assert.throws(
      () => getConfig({ APP_ENV: 'development', AGX_CSRF_SERVER_SECRET: ` ${VALID_CSRF_SECRET} ` }, {}),
      (error) => error instanceof ConfigurationError && error.code === 'INSECURE_VALUE' && error.variable === 'AGX_CSRF_SERVER_SECRET',
    );
  });

  test('formato no canónico (no 43 chars + "=") -> ConfigurationError', () => {
    assert.throws(
      () => getConfig({ APP_ENV: 'development', AGX_CSRF_SERVER_SECRET: 'demasiado-corto' }, {}),
      (error) => error instanceof ConfigurationError && error.code === 'INSECURE_VALUE',
    );
  });

  test('doble padding "==" (formato inválido, no canónico) -> ConfigurationError', () => {
    const malformed = 'A'.repeat(42) + '==';
    assert.throws(
      () => getConfig({ APP_ENV: 'development', AGX_CSRF_SERVER_SECRET: malformed }, {}),
      (error) => error instanceof ConfigurationError && error.code === 'INSECURE_VALUE',
    );
  });
});

describe('AUTH-001: server/config/env.js -- AGX_AUTH_FINGERPRINT_SECRET', () => {
  test('ausente -> no bloquea el arranque en ningún ambiente', () => {
    assert.doesNotThrow(() => getConfig({ APP_ENV: 'development' }, {}));
  });

  test('formato válido -> no lanza', () => {
    assert.doesNotThrow(() =>
      getConfig({ APP_ENV: 'development', AGX_AUTH_FINGERPRINT_SECRET: VALID_FINGERPRINT_SECRET }, {}),
    );
  });

  test('con espacios iniciales/finales -> ConfigurationError', () => {
    assert.throws(
      () => getConfig({ APP_ENV: 'development', AGX_AUTH_FINGERPRINT_SECRET: ` ${VALID_FINGERPRINT_SECRET} ` }, {}),
      (error) =>
        error instanceof ConfigurationError &&
        error.code === 'INSECURE_VALUE' &&
        error.variable === 'AGX_AUTH_FINGERPRINT_SECRET',
    );
  });

  test('formato no canónico (no 43 chars + "=") -> ConfigurationError', () => {
    assert.throws(
      () => getConfig({ APP_ENV: 'development', AGX_AUTH_FINGERPRINT_SECRET: 'demasiado-corto' }, {}),
      (error) => error instanceof ConfigurationError && error.code === 'INSECURE_VALUE',
    );
  });

  test('igual a AGX_CSRF_SERVER_SECRET -> ConfigurationError fail-closed (secretos independientes)', () => {
    assert.throws(
      () =>
        getConfig(
          {
            APP_ENV: 'development',
            AGX_CSRF_SERVER_SECRET: VALID_CSRF_SECRET,
            AGX_AUTH_FINGERPRINT_SECRET: VALID_CSRF_SECRET,
          },
          {},
        ),
      (error) =>
        error instanceof ConfigurationError &&
        error.code === 'INSECURE_VALUE' &&
        error.variable === 'AGX_AUTH_FINGERPRINT_SECRET',
    );
  });

  test('distinto de AGX_CSRF_SERVER_SECRET -> no lanza', () => {
    assert.doesNotThrow(() =>
      getConfig(
        {
          APP_ENV: 'development',
          AGX_CSRF_SERVER_SECRET: VALID_CSRF_SECRET,
          AGX_AUTH_FINGERPRINT_SECRET: VALID_FINGERPRINT_SECRET,
        },
        {},
      ),
    );
  });
});

describe('BFF-001: server/config/env.js -- AGX_AUTH_DATABASE_URL / AGX_BUSINESS_DATABASE_URL', () => {
  test('ambas ausentes -> no bloquean el arranque en ningún ambiente', () => {
    assert.doesNotThrow(() => getConfig(validProductionSource(), {}));
  });

  test('production con AGX_AUTH_DATABASE_URL apuntando a localhost -> ConfigurationError', () => {
    assert.throws(
      () =>
        getConfig(
          validProductionSource({ AGX_AUTH_DATABASE_URL: 'postgres://user:pass@localhost:5432/agx' }),
          {},
        ),
      (error) => error instanceof ConfigurationError && error.code === 'INSECURE_VALUE' && error.variable === 'AGX_AUTH_DATABASE_URL',
    );
  });

  test('production con AGX_BUSINESS_DATABASE_URL cruzando a staging -> ConfigurationError', () => {
    assert.throws(
      () =>
        getConfig(
          validProductionSource({ AGX_BUSINESS_DATABASE_URL: 'postgres://user:pass@staging.agrogenomax.com:5432/agx' }),
          {},
        ),
      (error) => error instanceof ConfigurationError && error.code === 'INCOMPATIBLE_COMBINATION' && error.variable === 'AGX_BUSINESS_DATABASE_URL',
    );
  });

  test('development con AGX_AUTH_DATABASE_URL local -> no lanza (solo production restringe localhost)', () => {
    assert.doesNotThrow(() =>
      getConfig({ APP_ENV: 'development', AGX_AUTH_DATABASE_URL: 'postgres://agx_auth:x@localhost:5432/AGROGENOMAX' }, {}),
    );
  });
});

describe('BFF-001: server/config/env.js -- prohibición en demo', () => {
  for (const variable of [
    'AGX_AUTH_DATABASE_URL',
    'AGX_BUSINESS_DATABASE_URL',
    'AGX_CSRF_SERVER_SECRET',
    'AGX_AUTH_FINGERPRINT_SECRET',
  ]) {
    test(`${variable} presente en demo -> ConfigurationError (demo no tiene backend ni sesión que proteger)`, () => {
      assert.throws(
        () => getConfig({ APP_ENV: 'demo', [variable]: 'valor-cualquiera' }, {}),
        (error) => error instanceof ConfigurationError && error.code === 'PROHIBITED_VARIABLE_PRESENT' && error.variable === variable,
      );
    });
  }
});
