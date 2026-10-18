// SPRINT-3D11.3 (R1): validación de arranque de las variables del
// inventario QR. Opcionales (sin ellas el servidor arranca y las rutas QR
// admin responden 503), estrictas cuando están presentes.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigurationError, getConfig, __resetValidationStateForTests } from '../env.js';

const TEMP_ACCESS_TOKEN_KEY = Buffer.alloc(32, 7).toString('base64');
const QR_KEY = Buffer.alloc(32, 9).toString('base64');

function staging(overrides = {}) {
  return {
    APP_ENV: 'staging',
    CATASTROX_COMMERCE_MODE: 'password',
    DATABASE_URL: 'postgres://staging-host/agx',
    CATASTROX_DATABASE_URL: 'postgres://staging-host/gis',
    HEALTH_MONITOR_TOKEN: 'a'.repeat(32),
    PUBLIC_APP_ORIGIN: 'https://agrogenomax.com',
    CATASTROX_TEMP_ACCESS_SECRET: 'contrasena-temporal-de-prueba',
    CATASTROX_TEMP_ACCESS_TOKEN_KEY: TEMP_ACCESS_TOKEN_KEY,
    ...overrides,
  };
}

function rejects(source, variable) {
  assert.throws(() => getConfig(source, {}), (error) => error instanceof ConfigurationError && error.variable === variable);
}

describe('SPRINT-3D11.3: variables del inventario QR', () => {
  beforeEach(() => __resetValidationStateForTests());

  test('sin ninguna variable QR el servidor arranca (fail-closed en las rutas, no en el boot)', () => {
    assert.equal(getConfig(staging(), {}).appEnv, 'staging');
  });

  test('con las tres variables válidas arranca', () => {
    const config = getConfig(staging({
      AGX_QR_TOKEN_ENCRYPTION_KEY: QR_KEY,
      AGX_QR_PUBLIC_ORIGIN: 'https://staging.agrogenomax.com',
      AGX_BUSINESS_DATABASE_URL: 'postgres://agx_app@business-host/agx',
      AGX_BUSINESS_QR_ADMIN_DATABASE_URL: 'postgres://agx_qr_admin@business-host/agx',
    }), {});
    assert.equal(config.appEnv, 'staging');
  });

  test('AGX_QR_TOKEN_ENCRYPTION_KEY: formato canónico de 32 bytes, sin espacios', () => {
    for (const value of ['corta', `${QR_KEY} `, Buffer.alloc(16).toString('base64'), QR_KEY.replace('=', '')]) {
      __resetValidationStateForTests();
      rejects(staging({ AGX_QR_TOKEN_ENCRYPTION_KEY: value }), 'AGX_QR_TOKEN_ENCRYPTION_KEY');
    }
  });

  test('AGX_QR_TOKEN_ENCRYPTION_KEY: nunca reutiliza otra clave del servidor', () => {
    rejects(staging({ AGX_QR_TOKEN_ENCRYPTION_KEY: TEMP_ACCESS_TOKEN_KEY }), 'AGX_QR_TOKEN_ENCRYPTION_KEY');
  });

  test('AGX_QR_PUBLIC_ORIGIN: origen exacto https público en staging', () => {
    for (const value of ['http://staging.agrogenomax.com', 'https://localhost', 'https://agrogenomax.com/', 'https://agrogenomax.com/qr', 'agrogenomax.com']) {
      __resetValidationStateForTests();
      rejects(staging({ AGX_QR_PUBLIC_ORIGIN: value }), 'AGX_QR_PUBLIC_ORIGIN');
    }
  });

  test('AGX_QR_PUBLIC_ORIGIN: en development se admite http://localhost', () => {
    assert.equal(getConfig({ APP_ENV: 'development', AGX_QR_PUBLIC_ORIGIN: 'http://localhost:4299' }, {}).appEnv, 'development');
  });

  test('AGX_BUSINESS_QR_ADMIN_DATABASE_URL: nunca la misma conexión que agx_app', () => {
    const url = 'postgres://agx_app@business-host/agx';
    rejects(staging({ AGX_BUSINESS_DATABASE_URL: url, AGX_BUSINESS_QR_ADMIN_DATABASE_URL: url }), 'AGX_BUSINESS_QR_ADMIN_DATABASE_URL');
  });

  test('demo: las variables QR con secretos están prohibidas', () => {
    for (const variable of ['AGX_BUSINESS_QR_ADMIN_DATABASE_URL', 'AGX_QR_TOKEN_ENCRYPTION_KEY']) {
      __resetValidationStateForTests();
      assert.throws(() => getConfig({ APP_ENV: 'demo', [variable]: variable.includes('KEY') ? QR_KEY : 'postgres://x/y' }, {}), ConfigurationError);
    }
  });
});
