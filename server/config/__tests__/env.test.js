import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  ALLOWED_APP_ENVIRONMENTS,
  ConfigurationError,
  loadEnv,
  validateEnv,
  getConfig,
  resolveCorsAllowedOrigins,
  resolveCommerceMode,
  __resetValidationStateForTests,
} from '../env.js';

// Modelo de comprador (migración 004): staging/production ahora exigen
// también CATASTROX_PII_ENCRYPTION_KEY (32 bytes en base64) y
// CATASTROX_PII_HASH_SECRET (>=32 caracteres) -- valores fijos de prueba,
// nunca usados fuera de este archivo.
const TEST_PII_ENCRYPTION_KEY = '/7cHJDrllkKZ+qVKEMuaM+205+vEvpCTRKUArWkx+cc=';
const TEST_PII_HASH_SECRET = 'b'.repeat(32);

// R3/B6-26 + B6-26-ADJ-01: staging/production ahora también exigen
// CATASTROX_VERIFY_HANDLE_KEY/CATASTROX_CHECKOUT_IDENTITY_KEY (32 bytes en
// base64 cada una, independientes entre sí y de CATASTROX_PII_ENCRYPTION_KEY)
// -- valores sintéticos fijos de prueba, nunca usados fuera de este archivo,
// nunca reutilizados el uno para el otro.
const TEST_VERIFY_HANDLE_KEY = 'gwslZ1bKInXjQ0TLmMqWeV6vRAL2hONB6bTBqpAjVFs=';
const TEST_CHECKOUT_IDENTITY_KEY = 'OhWl0C0aTcvlS6gLqCfjLtV/bC3D8CxTGn4txiSCLIc=';

// STAGING_READINESS_001 (Bloque 4): staging ahora también exige
// WOMPI_PUBLIC_KEY_TEST/WOMPI_INTEGRITY_SECRET_TEST/WOMPI_EVENTS_SECRET_TEST/
// CATASTROX_FRONTEND_URL -- valores sintéticos válidos, reutilizados como
// base por los casos de este archivo que necesitan un staging "completo".
const TEST_WOMPI_PUBLIC_KEY_TEST = 'pub_test_synthetic_key_1234567890';
const TEST_WOMPI_INTEGRITY_SECRET_TEST = 'c'.repeat(32);
const TEST_WOMPI_EVENTS_SECRET_TEST = 'd'.repeat(32);
const TEST_CATASTROX_FRONTEND_URL = 'https://staging.agrogenomax.com';

// EMAIL_PROVIDER_002: staging ahora también exige EMAIL_PROVIDER=resend,
// RESEND_API_KEY y EMAIL_FROM -- valores sintéticos válidos, reutilizados
// como base por los casos de este archivo que necesitan un staging
// "completo".
const TEST_RESEND_API_KEY = 're_synthetic_key_1234567890';
const TEST_EMAIL_FROM = 'CatastroX <no-reply@mail.staging.agrogenomax.com>';

// AGX-SUPERADMIN-AUTH-006: PUBLIC_APP_ORIGIN pasa a ser obligatoria en
// staging (el servicio Railway "production" corre con APP_ENV=staging,
// ver server/services/ganaderia/emailSender.js) -- valor sintético válido,
// reutilizado como base por los casos de este archivo.
const TEST_PUBLIC_APP_ORIGIN = 'https://agrogenomax.com';

function validStagingSource(overrides = {}) {
  return {
    APP_ENV: 'staging',
    DATABASE_URL: 'postgres://staging-host/agx',
    CATASTROX_DATABASE_URL: 'postgres://staging-host/gis',
    HEALTH_MONITOR_TOKEN: 'a'.repeat(32),
    CATASTROX_PII_ENCRYPTION_KEY: TEST_PII_ENCRYPTION_KEY,
    CATASTROX_PII_HASH_SECRET: TEST_PII_HASH_SECRET,
    CATASTROX_VERIFY_HANDLE_KEY: TEST_VERIFY_HANDLE_KEY,
    CATASTROX_CHECKOUT_IDENTITY_KEY: TEST_CHECKOUT_IDENTITY_KEY,
    WOMPI_PUBLIC_KEY_TEST: TEST_WOMPI_PUBLIC_KEY_TEST,
    WOMPI_INTEGRITY_SECRET_TEST: TEST_WOMPI_INTEGRITY_SECRET_TEST,
    WOMPI_EVENTS_SECRET_TEST: TEST_WOMPI_EVENTS_SECRET_TEST,
    CATASTROX_FRONTEND_URL: TEST_CATASTROX_FRONTEND_URL,
    EMAIL_PROVIDER: 'resend',
    RESEND_API_KEY: TEST_RESEND_API_KEY,
    EMAIL_FROM: TEST_EMAIL_FROM,
    PUBLIC_APP_ORIGIN: TEST_PUBLIC_APP_ORIGIN,
    ...overrides,
  };
}

// Todas las pruebas de este archivo operan exclusivamente sobre objetos
// planos inyectados como `source` (nunca sobre el `process.env` real).
// Esto garantiza aislamiento total: no se lee ni se modifica el entorno
// real del proceso, no hay red, no hay base de datos.
//
// getConfig() ahora "bloquea" el ambiente validado dentro del proceso
// (auditoría LOTE-002): por eso cada caso resetea explícitamente ese
// estado compartido antes de correr, para que las pruebas que validan
// distintos APP_ENV en la misma suite no interfieran entre sí -- esto es
// intencional y refleja el mismo bloqueo que protege al proceso real.
describe('LOTE-002 (corrección): server/config/env.js', () => {
  beforeEach(() => {
    __resetValidationStateForTests();
  });

  test('1. APP_ENV válido para development', () => {
    const config = getConfig({ APP_ENV: 'development' }, {});
    assert.equal(config.appEnv, 'development');
    assert.equal(config.isLocalDevelopmentFallback, false);
  });

  test('1b. APP_ENV no depende de NODE_ENV (NODE_ENV=production no cambia appEnv)', () => {
    const config = getConfig({ APP_ENV: 'development', NODE_ENV: 'production' }, {});
    assert.equal(config.appEnv, 'development');
    // NODE_ENV se expone solo como dato informativo, nunca como decisión.
    assert.equal(config.nodeEnv, 'production');
  });

  test('2. APP_ENV válido para test', () => {
    const config = getConfig({ APP_ENV: 'test' }, {});
    assert.equal(config.appEnv, 'test');
  });

  test('3. APP_ENV inválido', () => {
    assert.throws(
      () => getConfig({ APP_ENV: 'preproduccion' }, {}),
      (error) => error instanceof ConfigurationError && error.code === 'APP_ENV_INVALID',
    );
  });

  test('4. APP_ENV ausente con allowLocalFallback pero con indicador de despliegue (CI) falla', () => {
    assert.throws(
      () => getConfig({ CI: 'true', DATABASE_URL: 'postgres://ci-host/agx' }, { allowLocalFallback: true }),
      (error) => error instanceof ConfigurationError && error.code === 'APP_ENV_MISSING',
    );
  });

  test('5. APP_ENV ausente con allowLocalFallback pero con NODE_ENV=production falla', () => {
    assert.throws(
      () => getConfig({ NODE_ENV: 'production' }, { allowLocalFallback: true }),
      (error) => error instanceof ConfigurationError && error.code === 'APP_ENV_MISSING',
    );
  });

  test('6. demo con DATABASE_URL falla', () => {
    assert.throws(
      () => getConfig({ APP_ENV: 'demo', DATABASE_URL: 'postgres://x/y' }, {}),
      (error) =>
        error instanceof ConfigurationError &&
        error.code === 'PROHIBITED_VARIABLE_PRESENT' &&
        error.variable === 'DATABASE_URL',
    );
  });

  test('7. demo con CATASTROX_DATABASE_URL falla', () => {
    assert.throws(
      () => getConfig({ APP_ENV: 'demo', CATASTROX_DATABASE_URL: 'postgres://x/y' }, {}),
      (error) =>
        error instanceof ConfigurationError &&
        error.code === 'PROHIBITED_VARIABLE_PRESENT' &&
        error.variable === 'CATASTROX_DATABASE_URL',
    );
  });

  test('8. demo con variable Wompi falla', () => {
    assert.throws(
      () => getConfig({ APP_ENV: 'demo', WOMPI_PUBLIC_KEY_TEST: 'pub_test_abc' }, {}),
      (error) =>
        error instanceof ConfigurationError &&
        error.code === 'PROHIBITED_VARIABLE_PRESENT' &&
        error.variable === 'WOMPI_PUBLIC_KEY_TEST',
    );
  });

  test('9. production con localhost falla', () => {
    assert.throws(
      () =>
        getConfig(
          {
            APP_ENV: 'production',
            DATABASE_URL: 'postgres://postgres@localhost:5432/agx',
            CATASTROX_DATABASE_URL: 'postgres://postgres@127.0.0.1:5432/gis',
            HEALTH_MONITOR_TOKEN: 'a'.repeat(32),
            CATASTROX_PII_ENCRYPTION_KEY: TEST_PII_ENCRYPTION_KEY,
            CATASTROX_PII_HASH_SECRET: TEST_PII_HASH_SECRET,
            CATASTROX_VERIFY_HANDLE_KEY: TEST_VERIFY_HANDLE_KEY,
            CATASTROX_CHECKOUT_IDENTITY_KEY: TEST_CHECKOUT_IDENTITY_KEY,
            PUBLIC_APP_ORIGIN: TEST_PUBLIC_APP_ORIGIN,
          },
          {},
        ),
      (error) => error instanceof ConfigurationError && error.code === 'INSECURE_VALUE',
    );
  });

  test('10. production con variable test/sandbox falla', () => {
    assert.throws(
      () =>
        getConfig(
          {
            APP_ENV: 'production',
            DATABASE_URL: 'postgres://real-prod-host/agx',
            CATASTROX_DATABASE_URL: 'postgres://real-prod-host/gis',
            HEALTH_MONITOR_TOKEN: 'a'.repeat(32),
            CATASTROX_PII_ENCRYPTION_KEY: TEST_PII_ENCRYPTION_KEY,
            CATASTROX_PII_HASH_SECRET: TEST_PII_HASH_SECRET,
            CATASTROX_VERIFY_HANDLE_KEY: TEST_VERIFY_HANDLE_KEY,
            CATASTROX_CHECKOUT_IDENTITY_KEY: TEST_CHECKOUT_IDENTITY_KEY,
            PUBLIC_APP_ORIGIN: TEST_PUBLIC_APP_ORIGIN,
            WOMPI_ENV: 'test',
          },
          {},
        ),
      (error) =>
        error instanceof ConfigurationError &&
        error.code === 'INCOMPATIBLE_COMBINATION' &&
        error.variable === 'WOMPI_ENV',
    );
  });

  test('11. staging sin variable obligatoria falla', () => {
    assert.throws(
      () => getConfig({ APP_ENV: 'staging', DATABASE_URL: 'postgres://staging-host/agx' }, {}),
      (error) =>
        error instanceof ConfigurationError &&
        error.code === 'REQUIRED_VARIABLE_MISSING' &&
        error.variable === 'CATASTROX_DATABASE_URL',
    );
  });

  test('12. no se exponen secretos en errores', () => {
    const secretValue = 'postgres://user:supersecreto123@localhost:5432/agx';
    try {
      getConfig(
        { APP_ENV: 'production', DATABASE_URL: secretValue, CATASTROX_DATABASE_URL: 'postgres://real-host/gis' },
        {},
      );
      assert.fail('Se esperaba que getConfig lanzara ConfigurationError');
    } catch (error) {
      assert.ok(error instanceof ConfigurationError);
      assert.ok(!error.message.includes('supersecreto123'));
      assert.ok(!error.message.includes(secretValue));
      assert.ok(!JSON.stringify(error).includes('supersecreto123'));
    }
  });

  test('13. configuración resultante es inmutable', () => {
    const config = getConfig({ APP_ENV: 'development' }, {});
    assert.ok(Object.isFrozen(config));
    assert.throws(() => {
      'use strict';
      config.appEnv = 'production';
    });
    assert.equal(config.appEnv, 'development');
  });

  test('14. test no usa servicios reales por defecto', () => {
    const defaultConfig = getConfig({ APP_ENV: 'test' }, {});
    assert.equal(defaultConfig.usesRealServices, false);

    const optedInConfig = getConfig({ APP_ENV: 'test', TEST_USE_REAL_SERVICES: 'true' }, {});
    assert.equal(optedInConfig.usesRealServices, true);
  });

  test('9-bis (corrección). APP_ENV ausente NUNCA se infiere mediante hostname del sistema operativo', () => {
    // loadEnv/getConfig ya no aceptan ni consultan ningún parámetro de
    // hostname -- no existe tal opción en la firma de la función. La
    // única vía de fallback es allowLocalFallback + heurísticos de
    // ausencia de indicios de despliegue, nunca el nombre de la máquina.
    assert.throws(
      () => getConfig({}, {}), // sin allowLocalFallback: siempre falla, sin importar la máquina real
      (error) => error instanceof ConfigurationError && error.code === 'APP_ENV_MISSING',
    );

    // Incluso con allowLocalFallback, un indicador de despliegue basta
    // para descartar el fallback -- el hostname jamás entra en juego.
    assert.throws(
      () => getConfig({ RAILWAY_ENVIRONMENT: 'production' }, { allowLocalFallback: true }),
      (error) => error instanceof ConfigurationError && error.code === 'APP_ENV_MISSING',
    );
  });

  test('10-bis (corrección). APP_ENV explícito development continúa funcionando sin ninguna dependencia de allowLocalFallback', () => {
    const config = getConfig({ APP_ENV: 'development' }, {}); // allowLocalFallback ni siquiera se pasa
    assert.equal(config.appEnv, 'development');
    assert.equal(config.isLocalDevelopmentFallback, false);
  });

  test('15. desarrollo local conserva compatibilidad controlada, solo con allowLocalFallback explícito', () => {
    const config = getConfig({}, { allowLocalFallback: true });
    assert.equal(config.appEnv, 'development');
    assert.equal(config.isLocalDevelopmentFallback, true);
  });

  test('15b. el fallback local NO aplica si hay indicios de staging/producción, aunque se solicite explícitamente', () => {
    assert.throws(
      () =>
        getConfig(
          { DATABASE_URL: 'postgres://user@staging.agrogenomax.com/agx' },
          { allowLocalFallback: true },
        ),
      (error) => error instanceof ConfigurationError && error.code === 'APP_ENV_MISSING',
    );
  });

  test('15c. sin allowLocalFallback explícito, jamás se infiere development, sin importar el resto del contexto', () => {
    assert.throws(
      () => getConfig({}, {}), // ambiente "limpio", pero allowLocalFallback no fue solicitado
      (error) => error instanceof ConfigurationError && error.code === 'APP_ENV_MISSING',
    );
  });

  test('(auditoría) una segunda validación con APP_ENV incompatible NO reemplaza silenciosamente la configuración ya validada', () => {
    const first = getConfig({ APP_ENV: 'development' }, {});
    assert.equal(first.appEnv, 'development');

    // Simula: getConfig() ya validó development; algo externo cambia el
    // ambiente aparente (p. ej. process.env.APP_ENV mutado) y se llama de
    // nuevo. Esto NUNCA debe aceptarse silenciosamente -- un proceso que
    // ya arrancó como development no puede "convertirse" en production a
    // mitad de ejecución sin que nada lo note (dejaría, por ejemplo, un
    // Pool ya creado bajo credenciales de un ambiente y validación de
    // otro).
    assert.throws(
      () =>
        getConfig(
          {
            APP_ENV: 'production',
            DATABASE_URL: 'postgres://real-prod-host/agx',
            CATASTROX_DATABASE_URL: 'postgres://real-prod-host/gis',
            HEALTH_MONITOR_TOKEN: 'a'.repeat(32),
            CATASTROX_PII_ENCRYPTION_KEY: TEST_PII_ENCRYPTION_KEY,
            CATASTROX_PII_HASH_SECRET: TEST_PII_HASH_SECRET,
            CATASTROX_VERIFY_HANDLE_KEY: TEST_VERIFY_HANDLE_KEY,
            CATASTROX_CHECKOUT_IDENTITY_KEY: TEST_CHECKOUT_IDENTITY_KEY,
            PUBLIC_APP_ORIGIN: TEST_PUBLIC_APP_ORIGIN,
          },
          {},
        ),
      (error) => error instanceof ConfigurationError && error.code === 'CONFIG_ALREADY_VALIDATED',
    );

    // Una segunda llamada con el MISMO ambiente sigue siendo válida
    // (idempotente) -- solo se bloquea el cambio, no la repetición.
    const again = getConfig({ APP_ENV: 'development' }, {});
    assert.equal(again.appEnv, 'development');
  });

  test('isConfigValidated()/assertConfigValidated() reflejan si getConfig() ya corrió con éxito', async () => {
    // Import dinámico con querystring único para obtener una instancia de
    // módulo fresca (evita interferencia de estado con otras pruebas de
    // este mismo archivo, que ya llamaron getConfig() muchas veces).
    const fresh = await import(`../env.js?fresh=${Date.now()}-${Math.random()}`);
    assert.equal(fresh.isConfigValidated(), false);
    assert.throws(() => fresh.assertConfigValidated(), fresh.ConfigurationError);

    fresh.getConfig({ APP_ENV: 'development' }, {});
    assert.equal(fresh.isConfigValidated(), true);
    assert.doesNotThrow(() => fresh.assertConfigValidated());

    fresh.__resetValidationStateForTests();
    assert.equal(fresh.isConfigValidated(), false);
  });

  test('ALLOWED_APP_ENVIRONMENTS contiene exactamente los cinco valores permitidos', () => {
    assert.deepEqual([...ALLOWED_APP_ENVIRONMENTS], ['development', 'test', 'demo', 'staging', 'production']);
  });

  test('loadEnv() y validateEnv() son utilizables de forma independiente', () => {
    const { appEnv } = loadEnv({ APP_ENV: 'staging' }, {});
    assert.equal(appEnv, 'staging');
    assert.throws(
      () => validateEnv(appEnv, {}),
      (error) => error instanceof ConfigurationError && error.code === 'REQUIRED_VARIABLE_MISSING',
    );
  });
});

describe('LOTE-007 (ADR-012 §35.A): HEALTH_MONITOR_TOKEN', () => {
  beforeEach(() => {
    __resetValidationStateForTests();
  });

  test('staging sin HEALTH_MONITOR_TOKEN falla (token requerido)', () => {
    assert.throws(
      () =>
        getConfig(
          { APP_ENV: 'staging', DATABASE_URL: 'postgres://staging-host/agx', CATASTROX_DATABASE_URL: 'postgres://staging-host/gis' },
          {},
        ),
      (error) =>
        error instanceof ConfigurationError &&
        error.code === 'REQUIRED_VARIABLE_MISSING' &&
        error.variable === 'HEALTH_MONITOR_TOKEN',
    );
  });

  test('production sin HEALTH_MONITOR_TOKEN falla (token requerido)', () => {
    assert.throws(
      () =>
        getConfig(
          {
            APP_ENV: 'production',
            DATABASE_URL: 'postgres://real-prod-host/agx',
            CATASTROX_DATABASE_URL: 'postgres://real-prod-host/gis',
          },
          {},
        ),
      (error) =>
        error instanceof ConfigurationError &&
        error.code === 'REQUIRED_VARIABLE_MISSING' &&
        error.variable === 'HEALTH_MONITOR_TOKEN',
    );
  });

  test('demo con HEALTH_MONITOR_TOKEN falla (token prohibido)', () => {
    assert.throws(
      () => getConfig({ APP_ENV: 'demo', HEALTH_MONITOR_TOKEN: 'a'.repeat(32) }, {}),
      (error) =>
        error instanceof ConfigurationError &&
        error.code === 'PROHIBITED_VARIABLE_PRESENT' &&
        error.variable === 'HEALTH_MONITOR_TOKEN',
    );
  });

  test('staging con HEALTH_MONITOR_TOKEN de menos de 32 caracteres falla', () => {
    assert.throws(
      () => getConfig(validStagingSource({ HEALTH_MONITOR_TOKEN: 'a'.repeat(31) }), {}),
      (error) =>
        error instanceof ConfigurationError &&
        error.code === 'INSECURE_VALUE' &&
        error.variable === 'HEALTH_MONITOR_TOKEN',
    );
  });

  test('HEALTH_MONITOR_TOKEN con espacio inicial o final falla, incluso en development (opcional)', () => {
    assert.throws(
      () => getConfig({ APP_ENV: 'development', HEALTH_MONITOR_TOKEN: ` ${'a'.repeat(32)}` }, {}),
      (error) =>
        error instanceof ConfigurationError &&
        error.code === 'INSECURE_VALUE' &&
        error.variable === 'HEALTH_MONITOR_TOKEN',
    );
    assert.throws(
      () => getConfig({ APP_ENV: 'development', HEALTH_MONITOR_TOKEN: `${'a'.repeat(32)} ` }, {}),
      (error) =>
        error instanceof ConfigurationError &&
        error.code === 'INSECURE_VALUE' &&
        error.variable === 'HEALTH_MONITOR_TOKEN',
    );
  });

  test('development con HEALTH_MONITOR_TOKEN válido de 32 caracteres exactos no falla', () => {
    const config = getConfig({ APP_ENV: 'development', HEALTH_MONITOR_TOKEN: 'a'.repeat(32) }, {});
    assert.equal(config.appEnv, 'development');
  });

  test('staging con HEALTH_MONITOR_TOKEN válido no expone el secreto en el error', () => {
    const secretToken = `monitor-secret-${'x'.repeat(20)}`;
    try {
      getConfig({ APP_ENV: 'staging', DATABASE_URL: 'postgres://staging-host/agx' }, {});
      assert.fail('Se esperaba que getConfig lanzara ConfigurationError');
    } catch (error) {
      assert.ok(error instanceof ConfigurationError);
      assert.ok(!error.message.includes(secretToken));
      assert.ok(!JSON.stringify(error).includes(secretToken));
    }

    const config = getConfig(validStagingSource({ HEALTH_MONITOR_TOKEN: secretToken }), {});
    assert.ok(!JSON.stringify(config).includes(secretToken));
  });
});

describe('LOTE-004: resolveCorsAllowedOrigins() y appConfig.cors', () => {
  beforeEach(() => {
    __resetValidationStateForTests();
  });

  test('development: allowlist obligatoria fija, sin CORS_ALLOWED_ORIGINS', () => {
    // 5178 se agregó como segundo puerto de desarrollo mandatorio
    // (revisión de seguridad: era el puerto real del entorno de
    // verificación local y quedaba fuera de la allowlist).
    assert.deepEqual(resolveCorsAllowedOrigins('development', {}), [
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      'http://localhost:5178',
      'http://127.0.0.1:5178',
    ]);
  });

  test('development: CORS_ALLOWED_ORIGINS con dominio externo falla', () => {
    assert.throws(
      () => resolveCorsAllowedOrigins('development', { CORS_ALLOWED_ORIGINS: 'https://agrogenomax.com' }),
      (error) => error instanceof ConfigurationError && error.code === 'CORS_ORIGIN_FORBIDDEN',
    );
  });

  test('development: CORS_ALLOWED_ORIGINS con localhost en otro puerto se admite (ampliación válida)', () => {
    const result = resolveCorsAllowedOrigins('development', { CORS_ALLOWED_ORIGINS: 'http://localhost:4173' });
    assert.ok(result.includes('http://localhost:4173'));
    assert.ok(result.includes('http://localhost:5173'));
  });

  test('test: sin configuración, allowlist vacía (sin abrir CORS globalmente)', () => {
    assert.deepEqual(resolveCorsAllowedOrigins('test', {}), []);
  });

  test('test: allowlist inyectable vía CORS_ALLOWED_ORIGINS', () => {
    assert.deepEqual(resolveCorsAllowedOrigins('test', { CORS_ALLOWED_ORIGINS: 'https://mock.test' }), [
      'https://mock.test',
    ]);
  });

  test('demo: allowlist siempre vacía y CORS_ALLOWED_ORIGINS está prohibida', () => {
    assert.deepEqual(resolveCorsAllowedOrigins('demo', {}), []);
    assert.throws(
      () => getConfig({ APP_ENV: 'demo', CORS_ALLOWED_ORIGINS: 'https://demo.agrogenomax.com' }, {}),
      (error) =>
        error instanceof ConfigurationError &&
        error.code === 'PROHIBITED_VARIABLE_PRESENT' &&
        error.variable === 'CORS_ALLOWED_ORIGINS',
    );
  });

  test('staging: allowlist obligatoria fija a staging.agrogenomax.com', () => {
    assert.deepEqual(resolveCorsAllowedOrigins('staging', {}), ['https://staging.agrogenomax.com']);
  });

  test('staging: CORS_ALLOWED_ORIGINS con demo.agrogenomax.com falla', () => {
    assert.throws(
      () => resolveCorsAllowedOrigins('staging', { CORS_ALLOWED_ORIGINS: 'https://demo.agrogenomax.com' }),
      (error) => error instanceof ConfigurationError && error.code === 'CORS_ORIGIN_FORBIDDEN',
    );
  });

  test('production: allowlist obligatoria fija a los dos dominios apex oficiales', () => {
    assert.deepEqual(resolveCorsAllowedOrigins('production', {}), [
      'https://agrogenomax.com',
      'https://agrogenomax.co',
    ]);
  });

  test('production: CORS_ALLOWED_ORIGINS con staging.agrogenomax.com falla', () => {
    assert.throws(
      () => resolveCorsAllowedOrigins('production', { CORS_ALLOWED_ORIGINS: 'https://staging.agrogenomax.com' }),
      (error) => error instanceof ConfigurationError && error.code === 'CORS_ORIGIN_FORBIDDEN',
    );
  });

  test('production: www.agrogenomax.com y www.agrogenomax.co solo se admiten si se declaran explícitamente', () => {
    assert.deepEqual(resolveCorsAllowedOrigins('production', {}), [
      'https://agrogenomax.com',
      'https://agrogenomax.co',
    ]);
    assert.deepEqual(
      resolveCorsAllowedOrigins('production', { CORS_ALLOWED_ORIGINS: 'https://www.agrogenomax.com' }),
      ['https://agrogenomax.com', 'https://agrogenomax.co', 'https://www.agrogenomax.com'],
    );
    assert.deepEqual(
      resolveCorsAllowedOrigins('production', {
        CORS_ALLOWED_ORIGINS: 'https://www.agrogenomax.com,https://www.agrogenomax.co',
      }),
      [
        'https://agrogenomax.com',
        'https://agrogenomax.co',
        'https://www.agrogenomax.com',
        'https://www.agrogenomax.co',
      ],
    );
  });

  test('production: CORS_ALLOWED_ORIGINS con cualquier otro subdominio de agrogenomax.com falla', () => {
    assert.throws(
      () => resolveCorsAllowedOrigins('production', { CORS_ALLOWED_ORIGINS: 'https://app.agrogenomax.com' }),
      (error) => error instanceof ConfigurationError && error.code === 'CORS_ORIGIN_FORBIDDEN',
    );
  });

  test('production: CORS_ALLOWED_ORIGINS con cualquier otro subdominio de agrogenomax.co falla', () => {
    assert.throws(
      () => resolveCorsAllowedOrigins('production', { CORS_ALLOWED_ORIGINS: 'https://app.agrogenomax.co' }),
      (error) => error instanceof ConfigurationError && error.code === 'CORS_ORIGIN_FORBIDDEN',
    );
  });

  test('production: CORS_ALLOWED_ORIGINS con dominio externo/preview/Railway falla', () => {
    for (const badOrigin of [
      'https://preview.pages.dev',
      'https://agrogenomax-production.up.railway.app',
      'https://staging.agrogenomax.com',
      'https://demo.agrogenomax.com',
      'http://localhost:5173',
      'http://127.0.0.1:5173',
    ]) {
      assert.throws(
        () => resolveCorsAllowedOrigins('production', { CORS_ALLOWED_ORIGINS: badOrigin }),
        (error) => error instanceof ConfigurationError && error.code === 'CORS_ORIGIN_FORBIDDEN',
        `esperado CORS_ORIGIN_FORBIDDEN para ${badOrigin}`,
      );
    }
  });

  test('staging: no autoriza automáticamente staging.agrogenomax.co ni demo.agrogenomax.co (no son canónicos)', () => {
    assert.deepEqual(resolveCorsAllowedOrigins('staging', {}), ['https://staging.agrogenomax.com']);
    assert.deepEqual(resolveCorsAllowedOrigins('demo', {}), []);
  });

  test('CORS_ALLOWED_ORIGINS con valor inválido lanza CORS_ORIGIN_INVALID', () => {
    assert.throws(
      () => resolveCorsAllowedOrigins('staging', { CORS_ALLOWED_ORIGINS: 'no-es-una-url' }),
      (error) => error instanceof ConfigurationError && error.code === 'CORS_ORIGIN_INVALID',
    );
  });

  test('getConfig() expone appConfig.cors.allowedOrigins ya resuelto e inmutable', () => {
    const config = getConfig(validStagingSource({ DATABASE_URL: 'x', CATASTROX_DATABASE_URL: 'y' }), {});
    assert.deepEqual(config.cors.allowedOrigins, ['https://staging.agrogenomax.com']);
    assert.ok(Object.isFrozen(config.cors));
    assert.ok(Object.isFrozen(config.cors.allowedOrigins));
  });
});

describe('STAGING_READINESS_001 (Bloque 4): validaciones nuevas de configuración de staging', () => {
  beforeEach(() => {
    __resetValidationStateForTests();
  });

  test('staging con configuración completa y válida no falla', () => {
    const config = getConfig(validStagingSource(), {});
    assert.equal(config.appEnv, 'staging');
  });

  test('production NO exige WOMPI_PUBLIC_KEY_TEST/WOMPI_INTEGRITY_SECRET_TEST/WOMPI_EVENTS_SECRET_TEST/CATASTROX_FRONTEND_URL (riesgo residual documentado, no implementado aún)', () => {
    const config = getConfig(
      {
        APP_ENV: 'production',
        DATABASE_URL: 'postgres://real-prod-host/agx',
        CATASTROX_DATABASE_URL: 'postgres://real-prod-host/gis',
        HEALTH_MONITOR_TOKEN: 'a'.repeat(32),
        CATASTROX_PII_ENCRYPTION_KEY: TEST_PII_ENCRYPTION_KEY,
        CATASTROX_PII_HASH_SECRET: TEST_PII_HASH_SECRET,
        CATASTROX_VERIFY_HANDLE_KEY: TEST_VERIFY_HANDLE_KEY,
        CATASTROX_CHECKOUT_IDENTITY_KEY: TEST_CHECKOUT_IDENTITY_KEY,
        // AGX-SUPERADMIN-AUTH-006: a diferencia de los vars de Wompi/
        // CatastroX de arriba, PUBLIC_APP_ORIGIN sí es obligatoria en
        // production (ver describe() dedicado más abajo).
        PUBLIC_APP_ORIGIN: TEST_PUBLIC_APP_ORIGIN,
      },
      {},
    );
    assert.equal(config.appEnv, 'production');
  });

  test('staging sin WOMPI_PUBLIC_KEY_TEST falla (variable requerida)', () => {
    const source = validStagingSource();
    delete source.WOMPI_PUBLIC_KEY_TEST;
    assert.throws(
      () => getConfig(source, {}),
      (error) =>
        error instanceof ConfigurationError &&
        error.code === 'REQUIRED_VARIABLE_MISSING' &&
        error.variable === 'WOMPI_PUBLIC_KEY_TEST',
    );
  });

  test('staging sin WOMPI_INTEGRITY_SECRET_TEST falla (variable requerida)', () => {
    const source = validStagingSource();
    delete source.WOMPI_INTEGRITY_SECRET_TEST;
    assert.throws(
      () => getConfig(source, {}),
      (error) =>
        error instanceof ConfigurationError &&
        error.code === 'REQUIRED_VARIABLE_MISSING' &&
        error.variable === 'WOMPI_INTEGRITY_SECRET_TEST',
    );
  });

  test('staging sin WOMPI_EVENTS_SECRET_TEST falla (variable requerida)', () => {
    const source = validStagingSource();
    delete source.WOMPI_EVENTS_SECRET_TEST;
    assert.throws(
      () => getConfig(source, {}),
      (error) =>
        error instanceof ConfigurationError &&
        error.code === 'REQUIRED_VARIABLE_MISSING' &&
        error.variable === 'WOMPI_EVENTS_SECRET_TEST',
    );
  });

  test('staging sin CATASTROX_FRONTEND_URL falla (variable requerida)', () => {
    const source = validStagingSource();
    delete source.CATASTROX_FRONTEND_URL;
    assert.throws(
      () => getConfig(source, {}),
      (error) =>
        error instanceof ConfigurationError &&
        error.code === 'REQUIRED_VARIABLE_MISSING' &&
        error.variable === 'CATASTROX_FRONTEND_URL',
    );
  });

  test('WOMPI_PUBLIC_KEY_TEST con valor de marcador de posición falla, incluso fuera de staging', () => {
    assert.throws(
      () => getConfig({ APP_ENV: 'development', WOMPI_PUBLIC_KEY_TEST: 'pub_test_REEMPLAZAR' }, {}),
      (error) =>
        error instanceof ConfigurationError &&
        error.code === 'INSECURE_VALUE' &&
        error.variable === 'WOMPI_PUBLIC_KEY_TEST',
    );
  });

  test('WOMPI_PUBLIC_KEY_TEST que no inicia con pub_test_ falla (rechaza llaves de producción por error)', () => {
    assert.throws(
      () => getConfig(validStagingSource({ WOMPI_PUBLIC_KEY_TEST: 'pub_prod_abcdef123456' }), {}),
      (error) =>
        error instanceof ConfigurationError &&
        error.code === 'INSECURE_VALUE' &&
        error.variable === 'WOMPI_PUBLIC_KEY_TEST',
    );
  });

  test('WOMPI_PUBLIC_KEY_TEST válido (pub_test_...) no falla en staging', () => {
    const config = getConfig(validStagingSource(), {});
    assert.equal(config.appEnv, 'staging');
  });

  test('CATASTROX_FRONTEND_URL con http:// (sin TLS) falla en staging', () => {
    assert.throws(
      () => getConfig(validStagingSource({ CATASTROX_FRONTEND_URL: 'http://staging.agrogenomax.com' }), {}),
      (error) =>
        error instanceof ConfigurationError &&
        error.code === 'INSECURE_VALUE' &&
        error.variable === 'CATASTROX_FRONTEND_URL',
    );
  });

  test('CATASTROX_FRONTEND_URL apuntando a localhost falla en staging', () => {
    assert.throws(
      () => getConfig(validStagingSource({ CATASTROX_FRONTEND_URL: 'https://localhost:5173' }), {}),
      (error) =>
        error instanceof ConfigurationError &&
        error.code === 'INSECURE_VALUE' &&
        error.variable === 'CATASTROX_FRONTEND_URL',
    );
  });

  test('CATASTROX_FRONTEND_URL apuntando a 127.0.0.1 falla en staging', () => {
    assert.throws(
      () => getConfig(validStagingSource({ CATASTROX_FRONTEND_URL: 'https://127.0.0.1:5173' }), {}),
      (error) =>
        error instanceof ConfigurationError &&
        error.code === 'INSECURE_VALUE' &&
        error.variable === 'CATASTROX_FRONTEND_URL',
    );
  });

  test('CATASTROX_FRONTEND_URL https pública válida no falla en staging', () => {
    const config = getConfig(validStagingSource({ CATASTROX_FRONTEND_URL: 'https://staging.agrogenomax.com' }), {});
    assert.equal(config.appEnv, 'staging');
  });

  test('CATASTROX_FRONTEND_URL con localhost no falla fuera de staging/production (development sigue permitiendo localhost)', () => {
    const config = getConfig({ APP_ENV: 'development', CATASTROX_FRONTEND_URL: 'http://127.0.0.1:5173' }, {});
    assert.equal(config.appEnv, 'development');
  });

  test('ningún secreto/llave nuevo se expone en los mensajes de error de las validaciones de staging', () => {
    const secretKey = `pub_test_${'s'.repeat(24)}`;
    try {
      getConfig(validStagingSource({ WOMPI_PUBLIC_KEY_TEST: `${secretKey}_REEMPLAZAR` }), {});
      assert.fail('Se esperaba que getConfig lanzara ConfigurationError');
    } catch (error) {
      assert.ok(error instanceof ConfigurationError);
      assert.ok(!error.message.includes(secretKey));
      assert.ok(!JSON.stringify(error).includes(secretKey));
    }
  });

  // --- Revisión final: casos encontrados al auditar resolvePublicOriginForEnvironment() ---

  test('CATASTROX_FRONTEND_URL con credenciales embebidas (user:password@) falla en staging', () => {
    assert.throws(
      () =>
        getConfig(validStagingSource({ CATASTROX_FRONTEND_URL: 'https://user:password@staging.agrogenomax.com' }), {}),
      (error) =>
        error instanceof ConfigurationError &&
        error.code === 'INSECURE_VALUE' &&
        error.variable === 'CATASTROX_FRONTEND_URL',
    );
  });

  test('CATASTROX_FRONTEND_URL con hostname wildcard falla en staging', () => {
    assert.throws(
      () => getConfig(validStagingSource({ CATASTROX_FRONTEND_URL: 'https://*.agrogenomax.com' }), {}),
      (error) =>
        error instanceof ConfigurationError &&
        error.code === 'INSECURE_VALUE' &&
        error.variable === 'CATASTROX_FRONTEND_URL',
    );
  });

  test('CATASTROX_FRONTEND_URL apuntando a loopback IPv6 (::1) falla en staging', () => {
    assert.throws(
      () => getConfig(validStagingSource({ CATASTROX_FRONTEND_URL: 'https://[::1]:5173' }), {}),
      (error) =>
        error instanceof ConfigurationError &&
        error.code === 'INSECURE_VALUE' &&
        error.variable === 'CATASTROX_FRONTEND_URL',
    );
  });

  test('CATASTROX_FRONTEND_URL apuntando a 0.0.0.0 falla en staging', () => {
    assert.throws(
      () => getConfig(validStagingSource({ CATASTROX_FRONTEND_URL: 'https://0.0.0.0:5173' }), {}),
      (error) =>
        error instanceof ConfigurationError &&
        error.code === 'INSECURE_VALUE' &&
        error.variable === 'CATASTROX_FRONTEND_URL',
    );
  });

  test('WOMPI_INTEGRITY_SECRET_TEST con placeholder falla (antes no tenía ninguna validación de formato)', () => {
    assert.throws(
      () => getConfig(validStagingSource({ WOMPI_INTEGRITY_SECRET_TEST: 'test_integrity_REEMPLAZAR' }), {}),
      (error) =>
        error instanceof ConfigurationError &&
        error.code === 'INSECURE_VALUE' &&
        error.variable === 'WOMPI_INTEGRITY_SECRET_TEST',
    );
  });

  test('WOMPI_INTEGRITY_SECRET_TEST con espacios iniciales/finales falla', () => {
    assert.throws(
      () => getConfig(validStagingSource({ WOMPI_INTEGRITY_SECRET_TEST: ` ${'c'.repeat(32)}` }), {}),
      (error) =>
        error instanceof ConfigurationError &&
        error.code === 'INSECURE_VALUE' &&
        error.variable === 'WOMPI_INTEGRITY_SECRET_TEST',
    );
  });

  test('WOMPI_EVENTS_SECRET_TEST con placeholder largo (>=32 caracteres) falla igual (no basta con burlar el check de longitud)', () => {
    assert.throws(
      () =>
        getConfig(
          validStagingSource({ WOMPI_EVENTS_SECRET_TEST: 'events_secret_REEMPLAZAR_padded_to_thirty_two_chars' }),
          {},
        ),
      (error) =>
        error instanceof ConfigurationError &&
        error.code === 'INSECURE_VALUE' &&
        error.variable === 'WOMPI_EVENTS_SECRET_TEST',
    );
  });

  test('CATASTROX_PII_HASH_SECRET con el placeholder literal de .env.example (49 caracteres, pasaría el check de longitud) falla', () => {
    assert.throws(
      () =>
        getConfig(
          validStagingSource({ CATASTROX_PII_HASH_SECRET: 'pii_hash_secret_REEMPLAZAR_treinta_dos_caracteres' }),
          {},
        ),
      (error) =>
        error instanceof ConfigurationError &&
        error.code === 'INSECURE_VALUE' &&
        error.variable === 'CATASTROX_PII_HASH_SECRET',
    );
  });

  test('ninguna variable WOMPI_*_PRODUCTION/WOMPI_*_PROD es requerida en staging (no implementadas aún)', () => {
    // Config válida sin absolutamente ninguna variable de producción de
    // Wompi presente -- si alguna llegara a exigirse por error, esto
    // fallaría con REQUIRED_VARIABLE_MISSING.
    const source = validStagingSource();
    for (const key of Object.keys(source)) {
      assert.ok(!key.includes('PRODUCTION') && !key.includes('_PROD'), `variable inesperada de producción: ${key}`);
    }
    const config = getConfig(source, {});
    assert.equal(config.appEnv, 'staging');
  });

  test('ningún valor de WOMPI_INTEGRITY_SECRET_TEST/CATASTROX_PII_HASH_SECRET/CATASTROX_FRONTEND_URL se expone en los mensajes de error', () => {
    const secretIntegrity = `c${'x'.repeat(40)}`;
    try {
      getConfig(validStagingSource({ WOMPI_INTEGRITY_SECRET_TEST: `${secretIntegrity} ` }), {});
      assert.fail('Se esperaba ConfigurationError');
    } catch (error) {
      assert.ok(!error.message.includes(secretIntegrity));
      assert.ok(!JSON.stringify(error).includes(secretIntegrity));
    }

    const secretHash = `h${'y'.repeat(40)}`;
    try {
      getConfig(validStagingSource({ CATASTROX_PII_HASH_SECRET: `${secretHash} ` }), {});
      assert.fail('Se esperaba ConfigurationError');
    } catch (error) {
      assert.ok(!error.message.includes(secretHash));
      assert.ok(!JSON.stringify(error).includes(secretHash));
    }

    const frontendHost = 'user:pass@staging.agrogenomax.com';
    try {
      getConfig(validStagingSource({ CATASTROX_FRONTEND_URL: `https://${frontendHost}` }), {});
      assert.fail('Se esperaba ConfigurationError');
    } catch (error) {
      assert.ok(!error.message.includes('user:pass'));
      assert.ok(!JSON.stringify(error).includes('user:pass'));
    }
  });
});

describe('R3/B6-26 + B6-26-ADJ-01: CATASTROX_VERIFY_HANDLE_KEY/CATASTROX_CHECKOUT_IDENTITY_KEY', () => {
  beforeEach(() => {
    __resetValidationStateForTests();
  });

  // Table-driven: mismas reglas para ambas variables, sin duplicar cada
  // caso -- solo se repite lo que realmente difiere (el nombre exacto de
  // la variable en la aserción).
  const IDENTITY_TOKEN_KEY_VARIABLES = Object.freeze(['CATASTROX_VERIFY_HANDLE_KEY', 'CATASTROX_CHECKOUT_IDENTITY_KEY']);

  // validProductionSource() (definida más abajo, dentro del describe de
  // EMAIL_PROVIDER_002) no es accesible aquí -- está en el scope de su
  // propio callback, no a nivel de módulo. Fixture local mínima,
  // equivalente en los campos que a este bloque le importan.
  function minimalValidProductionSource(overrides = {}) {
    return {
      APP_ENV: 'production',
      DATABASE_URL: 'postgres://real-prod-host/agx',
      CATASTROX_DATABASE_URL: 'postgres://real-prod-host/gis',
      HEALTH_MONITOR_TOKEN: 'a'.repeat(32),
      CATASTROX_PII_ENCRYPTION_KEY: TEST_PII_ENCRYPTION_KEY,
      CATASTROX_PII_HASH_SECRET: TEST_PII_HASH_SECRET,
      CATASTROX_VERIFY_HANDLE_KEY: TEST_VERIFY_HANDLE_KEY,
      CATASTROX_CHECKOUT_IDENTITY_KEY: TEST_CHECKOUT_IDENTITY_KEY,
      // AGX-SUPERADMIN-AUTH-006: obligatoria en production desde este fix.
      PUBLIC_APP_ORIGIN: TEST_PUBLIC_APP_ORIGIN,
      ...overrides,
    };
  }

  for (const variable of IDENTITY_TOKEN_KEY_VARIABLES) {
    test(`staging sin ${variable} falla (variable requerida)`, () => {
      const source = validStagingSource();
      delete source[variable];
      assert.throws(
        () => getConfig(source, {}),
        (error) => error instanceof ConfigurationError && error.code === 'REQUIRED_VARIABLE_MISSING' && error.variable === variable,
      );
    });

    test(`production sin ${variable} falla (variable requerida)`, () => {
      const source = minimalValidProductionSource();
      delete source[variable];
      assert.throws(
        () => getConfig(source, {}),
        (error) => error instanceof ConfigurationError && error.code === 'REQUIRED_VARIABLE_MISSING' && error.variable === variable,
      );
    });

    test(`${variable} con caracteres fuera del alfabeto base64 falla (INSECURE_VALUE), incluso si Buffer.from(...) los toleraría`, () => {
      // Node decodifica base64 de forma permisiva: ignora caracteres fuera
      // del alfabeto en vez de fallar. Esta clave insertó 4 caracteres '!'
      // en medio de una clave por lo demás válida -- Buffer.from(...,
      // 'base64') los descarta y, por pura coincidencia, decodifica igual
      // a 32 bytes. El patrón canónico estricto debe rechazarla de todos
      // modos, ANTES de llegar siquiera a decodificar.
      const cleanKey = 'gwslZ1bKInXjQ0TLmMqWeV6vRAL2hONB6bTBqpAjVFs=';
      const keyWithTolerableGarbage = `${cleanKey.slice(0, 10)}!!!!${cleanKey.slice(10)}`;
      assert.equal(Buffer.from(keyWithTolerableGarbage, 'base64').length, 32, 'precondición: Buffer.from() sí lo tolera');

      assert.throws(
        () => getConfig(validStagingSource({ [variable]: keyWithTolerableGarbage }), {}),
        (error) => error instanceof ConfigurationError && error.code === 'INSECURE_VALUE' && error.variable === variable,
      );
    });

    test(`${variable} con espacios iniciales/finales falla (INSECURE_VALUE)`, () => {
      const base = variable === 'CATASTROX_VERIFY_HANDLE_KEY' ? TEST_VERIFY_HANDLE_KEY : TEST_CHECKOUT_IDENTITY_KEY;
      assert.throws(
        () => getConfig(validStagingSource({ [variable]: ` ${base}` }), {}),
        (error) => error instanceof ConfigurationError && error.code === 'INSECURE_VALUE' && error.variable === variable,
      );
      assert.throws(
        () => getConfig(validStagingSource({ [variable]: `${base} ` }), {}),
        (error) => error instanceof ConfigurationError && error.code === 'INSECURE_VALUE' && error.variable === variable,
      );
    });

    test(`${variable} de longitud decodificada distinta de 32 bytes falla (INSECURE_VALUE)`, () => {
      const shortKey = Buffer.alloc(16, 7).toString('base64'); // 16 bytes, no 32
      assert.throws(
        () => getConfig(validStagingSource({ [variable]: shortKey }), {}),
        (error) => error instanceof ConfigurationError && error.code === 'INSECURE_VALUE' && error.variable === variable,
      );
    });
  }

  test('CATASTROX_VERIFY_HANDLE_KEY y CATASTROX_CHECKOUT_IDENTITY_KEY válidas (32 bytes en base64 canónico) no fallan en staging ni en producción', () => {
    const stagingConfig = getConfig(validStagingSource(), {});
    assert.equal(stagingConfig.appEnv, 'staging');

    __resetValidationStateForTests();
    const productionConfig = getConfig(minimalValidProductionSource(), {});
    assert.equal(productionConfig.appEnv, 'production');
  });

  test('CATASTROX_VERIFY_HANDLE_KEY y CATASTROX_CHECKOUT_IDENTITY_KEY son independientes: usar la misma clave para ambas no falla la validación de formato (la separación de propósito es responsabilidad de identityCapability.js, no de env.js)', () => {
    const config = getConfig(
      validStagingSource({ CATASTROX_CHECKOUT_IDENTITY_KEY: TEST_VERIFY_HANDLE_KEY }),
      {},
    );
    assert.equal(config.appEnv, 'staging');
  });
});

describe('EMAIL_PROVIDER_002: EMAIL_PROVIDER/RESEND_API_KEY/EMAIL_FROM/EMAIL_SEND_TIMEOUT_MS', () => {
  beforeEach(() => {
    __resetValidationStateForTests();
  });

  test('staging con configuración de correo completa y válida no falla', () => {
    const config = getConfig(validStagingSource(), {});
    assert.equal(config.appEnv, 'staging');
  });

  test('staging sin EMAIL_PROVIDER falla (variable requerida)', () => {
    const source = validStagingSource();
    delete source.EMAIL_PROVIDER;
    assert.throws(
      () => getConfig(source, {}),
      (error) =>
        error instanceof ConfigurationError &&
        error.code === 'REQUIRED_VARIABLE_MISSING' &&
        error.variable === 'EMAIL_PROVIDER',
    );
  });

  test('staging sin RESEND_API_KEY falla (variable requerida)', () => {
    const source = validStagingSource();
    delete source.RESEND_API_KEY;
    assert.throws(
      () => getConfig(source, {}),
      (error) =>
        error instanceof ConfigurationError &&
        error.code === 'REQUIRED_VARIABLE_MISSING' &&
        error.variable === 'RESEND_API_KEY',
    );
  });

  test('staging sin EMAIL_FROM falla (variable requerida)', () => {
    const source = validStagingSource();
    delete source.EMAIL_FROM;
    assert.throws(
      () => getConfig(source, {}),
      (error) =>
        error instanceof ConfigurationError &&
        error.code === 'REQUIRED_VARIABLE_MISSING' &&
        error.variable === 'EMAIL_FROM',
    );
  });

  test('EMAIL_PROVIDER con un valor no soportado falla, incluso fuera de staging', () => {
    assert.throws(
      () => getConfig({ APP_ENV: 'development', EMAIL_PROVIDER: 'sendgrid' }, {}),
      (error) =>
        error instanceof ConfigurationError && error.code === 'INSECURE_VALUE' && error.variable === 'EMAIL_PROVIDER',
    );
  });

  test('EMAIL_PROVIDER=stub en staging falla (staging exige exactamente resend)', () => {
    assert.throws(
      () => getConfig(validStagingSource({ EMAIL_PROVIDER: 'stub' }), {}),
      (error) =>
        error instanceof ConfigurationError && error.code === 'INSECURE_VALUE' && error.variable === 'EMAIL_PROVIDER',
    );
  });

  test('EMAIL_PROVIDER=stub no falla fuera de staging (development conserva el stub)', () => {
    const config = getConfig({ APP_ENV: 'development', EMAIL_PROVIDER: 'stub' }, {});
    assert.equal(config.appEnv, 'development');
  });

  test('production NO exige EMAIL_PROVIDER/RESEND_API_KEY/EMAIL_FROM (riesgo residual documentado, Resend no habilitado en producción en este lote)', () => {
    const config = getConfig(
      {
        APP_ENV: 'production',
        DATABASE_URL: 'postgres://real-prod-host/agx',
        CATASTROX_DATABASE_URL: 'postgres://real-prod-host/gis',
        HEALTH_MONITOR_TOKEN: 'a'.repeat(32),
        CATASTROX_PII_ENCRYPTION_KEY: TEST_PII_ENCRYPTION_KEY,
        CATASTROX_PII_HASH_SECRET: TEST_PII_HASH_SECRET,
        CATASTROX_VERIFY_HANDLE_KEY: TEST_VERIFY_HANDLE_KEY,
        CATASTROX_CHECKOUT_IDENTITY_KEY: TEST_CHECKOUT_IDENTITY_KEY,
        PUBLIC_APP_ORIGIN: TEST_PUBLIC_APP_ORIGIN,
      },
      {},
    );
    assert.equal(config.appEnv, 'production');
  });

  test('RESEND_API_KEY con valor de marcador de posición falla', () => {
    assert.throws(
      () => getConfig(validStagingSource({ RESEND_API_KEY: 're_REEMPLAZAR' }), {}),
      (error) =>
        error instanceof ConfigurationError && error.code === 'INSECURE_VALUE' && error.variable === 'RESEND_API_KEY',
    );
  });

  test('RESEND_API_KEY con espacios iniciales/finales falla', () => {
    assert.throws(
      () => getConfig(validStagingSource({ RESEND_API_KEY: ` ${TEST_RESEND_API_KEY}` }), {}),
      (error) =>
        error instanceof ConfigurationError && error.code === 'INSECURE_VALUE' && error.variable === 'RESEND_API_KEY',
    );
  });

  test('EMAIL_FROM con formato inválido (sin @) falla', () => {
    assert.throws(
      () => getConfig(validStagingSource({ EMAIL_FROM: 'no-es-un-correo' }), {}),
      (error) => error instanceof ConfigurationError && error.code === 'INSECURE_VALUE' && error.variable === 'EMAIL_FROM',
    );
  });

  test('EMAIL_FROM apuntando a localhost falla en staging', () => {
    assert.throws(
      () => getConfig(validStagingSource({ EMAIL_FROM: 'CatastroX <no-reply@localhost>' }), {}),
      (error) => error instanceof ConfigurationError && error.code === 'INSECURE_VALUE' && error.variable === 'EMAIL_FROM',
    );
  });

  test('EMAIL_FROM apuntando a un TLD no público (.internal) falla en staging', () => {
    assert.throws(
      () => getConfig(validStagingSource({ EMAIL_FROM: 'no-reply@backend.internal' }), {}),
      (error) => error instanceof ConfigurationError && error.code === 'INSECURE_VALUE' && error.variable === 'EMAIL_FROM',
    );
  });

  test('EMAIL_FROM formato "correo@dominio" plano (sin nombre) es válido en staging', () => {
    const config = getConfig(validStagingSource({ EMAIL_FROM: 'no-reply@mail.staging.agrogenomax.com' }), {});
    assert.equal(config.appEnv, 'staging');
  });

  test('EMAIL_SEND_TIMEOUT_MS fuera de rango (menor a 1000) falla', () => {
    assert.throws(
      () => getConfig(validStagingSource({ EMAIL_SEND_TIMEOUT_MS: '500' }), {}),
      (error) =>
        error instanceof ConfigurationError &&
        error.code === 'INSECURE_VALUE' &&
        error.variable === 'EMAIL_SEND_TIMEOUT_MS',
    );
  });

  test('EMAIL_SEND_TIMEOUT_MS fuera de rango (mayor a 15000) falla', () => {
    assert.throws(
      () => getConfig(validStagingSource({ EMAIL_SEND_TIMEOUT_MS: '20000' }), {}),
      (error) =>
        error instanceof ConfigurationError &&
        error.code === 'INSECURE_VALUE' &&
        error.variable === 'EMAIL_SEND_TIMEOUT_MS',
    );
  });

  test('EMAIL_SEND_TIMEOUT_MS dentro de rango no falla', () => {
    const config = getConfig(validStagingSource({ EMAIL_SEND_TIMEOUT_MS: '8000' }), {});
    assert.equal(config.appEnv, 'staging');
  });

  test('ningún valor de RESEND_API_KEY/EMAIL_FROM se expone en los mensajes de error', () => {
    const secretKey = `re_${'s'.repeat(24)}`;
    try {
      getConfig(validStagingSource({ RESEND_API_KEY: `${secretKey}_REEMPLAZAR` }), {});
      assert.fail('Se esperaba ConfigurationError');
    } catch (error) {
      assert.ok(!error.message.includes(secretKey));
      assert.ok(!JSON.stringify(error).includes(secretKey));
    }
  });

  // CATX-DELIVERY-001 (ajuste obligatorio #1): producción NUNCA puede
  // arrancar con CATASTROX_STORAGE_DRIVER=local-dev-only -- ese driver
  // escribe al disco efímero del proceso, y en Railway se pierde en cada
  // redeploy/reinicio. Se falla-rápido aquí, no cuando ya se perdió un PDF.
  function validProductionSource(overrides = {}) {
    return {
      APP_ENV: 'production',
      DATABASE_URL: 'postgres://prod-db.internal/agx',
      CATASTROX_DATABASE_URL: 'postgres://prod-db.internal/gis',
      HEALTH_MONITOR_TOKEN: 'a'.repeat(32),
      CATASTROX_PII_ENCRYPTION_KEY: TEST_PII_ENCRYPTION_KEY,
      CATASTROX_PII_HASH_SECRET: TEST_PII_HASH_SECRET,
      CATASTROX_VERIFY_HANDLE_KEY: TEST_VERIFY_HANDLE_KEY,
      CATASTROX_CHECKOUT_IDENTITY_KEY: TEST_CHECKOUT_IDENTITY_KEY,
      PUBLIC_APP_ORIGIN: TEST_PUBLIC_APP_ORIGIN,
      ...overrides,
    };
  }

  test('CATASTROX_STORAGE_DRIVER=local-dev-only en producción falla (INCOMPATIBLE_COMBINATION)', () => {
    assert.throws(
      () => getConfig(validProductionSource({ CATASTROX_STORAGE_DRIVER: 'local-dev-only' }), {}),
      (error) =>
        error instanceof ConfigurationError &&
        error.code === 'INCOMPATIBLE_COMBINATION' &&
        error.variable === 'CATASTROX_STORAGE_DRIVER',
    );
  });

  test('CATASTROX_STORAGE_DRIVER=postgres en producción no falla', () => {
    const config = getConfig(validProductionSource({ CATASTROX_STORAGE_DRIVER: 'postgres' }), {});
    assert.equal(config.appEnv, 'production');
  });

  test('CATASTROX_STORAGE_DRIVER sin definir en producción no falla (default postgres, implícito)', () => {
    const config = getConfig(validProductionSource(), {});
    assert.equal(config.appEnv, 'production');
  });

  test('CATASTROX_STORAGE_DRIVER=local-dev-only SÍ está permitido fuera de producción (p. ej. staging)', () => {
    const config = getConfig(validStagingSource({ CATASTROX_STORAGE_DRIVER: 'local-dev-only' }), {});
    assert.equal(config.appEnv, 'staging');
  });

  test('CATASTROX_STORAGE_DRIVER con valor desconocido falla en cualquier ambiente (INSECURE_VALUE)', () => {
    assert.throws(
      () => getConfig({ APP_ENV: 'development', CATASTROX_STORAGE_DRIVER: 's3-nunca-implementado' }, {}),
      (error) =>
        error instanceof ConfigurationError &&
        error.code === 'INSECURE_VALUE' &&
        error.variable === 'CATASTROX_STORAGE_DRIVER',
    );
  });

  // CATX-DELIVERY-001 (ajuste obligatorio #6): límite máximo documentado de
  // tamaño de PDF antes de insertarlo en Postgres.
  test('CATASTROX_DELIVERABLE_MAX_BYTES fuera de rango (0, negativo, o mayor a 10 MB) falla', () => {
    for (const invalid of ['0', '-1', '10485761', 'not-a-number']) {
      assert.throws(
        () => getConfig({ APP_ENV: 'development', CATASTROX_DELIVERABLE_MAX_BYTES: invalid }, {}),
        (error) =>
          error instanceof ConfigurationError &&
          error.code === 'INSECURE_VALUE' &&
          error.variable === 'CATASTROX_DELIVERABLE_MAX_BYTES',
        `debía fallar para "${invalid}"`,
      );
    }
  });

  test('CATASTROX_DELIVERABLE_MAX_BYTES dentro de rango (1..10485760) no falla', () => {
    const config = getConfig({ APP_ENV: 'development', CATASTROX_DELIVERABLE_MAX_BYTES: '5242880' }, {});
    assert.equal(config.appEnv, 'development');
  });
});

// CATX-FREEZE-01: matriz CATASTROX_COMMERCE_MODE / WOMPI_ENV. Todas las
// pruebas operan sobre objetos `source` planos inyectados -- nunca sobre
// process.env real, sin red, sin DB (mismo aislamiento que el resto de este
// archivo).
describe('CATX-FREEZE-01: resolveCommerceMode()', () => {
  test('1) mode=password se resuelve sin exigir WOMPI_ENV', () => {
    assert.equal(resolveCommerceMode('development', { CATASTROX_COMMERCE_MODE: 'password' }), 'password');
  });

  test('2) mode=wompi_test se resuelve', () => {
    assert.equal(
      resolveCommerceMode('development', { CATASTROX_COMMERCE_MODE: 'wompi_test', WOMPI_ENV: 'test' }),
      'wompi_test',
    );
  });

  test('3) mode=wompi_live se resuelve', () => {
    assert.equal(
      resolveCommerceMode('production', { CATASTROX_COMMERCE_MODE: 'wompi_live', WOMPI_ENV: 'production' }),
      'wompi_live',
    );
  });

  test('4) variable ausente preserva compatibilidad legacy -- devuelve null, nunca "password"', () => {
    assert.equal(resolveCommerceMode('development', {}), null);
    assert.equal(resolveCommerceMode('production', { WOMPI_ENV: 'production' }), null);
  });

  test('5) valor inválido falla cerrado (ConfigurationError, nunca un valor por defecto silencioso)', () => {
    assert.throws(
      () => resolveCommerceMode('development', { CATASTROX_COMMERCE_MODE: 'wompi_sandbox' }),
      (error) => error instanceof ConfigurationError && error.code === 'INVALID_COMMERCE_MODE',
    );
  });

  test('6) wompi_test + WOMPI_ENV=test es válido', () => {
    assert.equal(
      resolveCommerceMode('development', { CATASTROX_COMMERCE_MODE: 'wompi_test', WOMPI_ENV: 'test' }),
      'wompi_test',
    );
  });

  test('7) wompi_test + WOMPI_ENV=production es inválido', () => {
    assert.throws(
      () => resolveCommerceMode('development', { CATASTROX_COMMERCE_MODE: 'wompi_test', WOMPI_ENV: 'production' }),
      (error) => error instanceof ConfigurationError && error.code === 'INCOMPATIBLE_COMBINATION',
    );
  });

  test('8) wompi_live + WOMPI_ENV=test es inválido', () => {
    assert.throws(
      () => resolveCommerceMode('production', { CATASTROX_COMMERCE_MODE: 'wompi_live', WOMPI_ENV: 'test' }),
      (error) => error instanceof ConfigurationError && error.code === 'INCOMPATIBLE_COMBINATION',
    );
  });

  test('9) wompi_live + WOMPI_ENV=production es válido', () => {
    assert.equal(
      resolveCommerceMode('production', { CATASTROX_COMMERCE_MODE: 'wompi_live', WOMPI_ENV: 'production' }),
      'wompi_live',
    );
  });

  test('10) password + cualquier WOMPI_ENV no exige coherencia (password no usa Wompi)', () => {
    assert.equal(
      resolveCommerceMode('development', { CATASTROX_COMMERCE_MODE: 'password', WOMPI_ENV: 'production' }),
      'password',
    );
  });

  test('11) getConfig() expone commerceMode en la configuración devuelta', () => {
    const config = getConfig({ APP_ENV: 'development', CATASTROX_COMMERCE_MODE: 'password' }, {});
    assert.equal(config.commerceMode, 'password');
  });

  test('12) getConfig() sin CATASTROX_COMMERCE_MODE expone commerceMode: null', () => {
    const config = getConfig({ APP_ENV: 'development' }, {});
    assert.equal(config.commerceMode, null);
  });
});
