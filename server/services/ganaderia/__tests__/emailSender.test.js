import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  sendRecoveryEmail,
  resolveGanaderiaPublicOrigin,
  buildRestablecerContrasenaUrl,
} from '../emailSender.js';

// AUTH-RECOVERY-002: pruebas del sender de correo de recuperación de
// Ganadería, AISLADO de server/services/catastrox/emailSender.js (nunca lo
// importa). `fetch` se sustituye por prueba y se restaura en `afterEach` --
// mismo patrón que server/services/catastrox/__tests__/emailSender.test.js.

const originalFetch = globalThis.fetch;
const ENV_KEYS = ['APP_ENV', 'EMAIL_PROVIDER', 'RESEND_API_KEY', 'EMAIL_FROM', 'EMAIL_SEND_TIMEOUT_MS'];
let savedEnv;

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

function setStagingEnv(overrides = {}) {
  process.env.APP_ENV = 'staging';
  process.env.EMAIL_PROVIDER = 'resend';
  process.env.RESEND_API_KEY = 're_synthetic_test_key_1234567890';
  process.env.EMAIL_FROM = 'AgroGenomaX <no-reply@mail.staging.agrogenomax.com>';
  delete process.env.EMAIL_SEND_TIMEOUT_MS;
  Object.assign(process.env, overrides);
}

function stubFetch(handler) {
  let calls = 0;
  globalThis.fetch = async (...args) => {
    calls += 1;
    return handler(...args, calls);
  };
  return { getCalls: () => calls };
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function captureConsole() {
  const originalInfo = console.info;
  const originalError = console.error;
  const lines = [];
  console.info = (...args) => lines.push(args);
  console.error = (...args) => lines.push(args);
  return {
    lines,
    restore: () => {
      console.info = originalInfo;
      console.error = originalError;
    },
  };
}

describe('AUTH-RECOVERY-002: resolveGanaderiaPublicOrigin / buildRestablecerContrasenaUrl -- origen canónico sin hardcodear', () => {
  test('development -> primer origin de CORS_MANDATORY_ORIGINS_BY_ENV.development (localhost:5173)', () => {
    assert.equal(resolveGanaderiaPublicOrigin('development'), 'http://localhost:5173');
  });

  test('staging -> https://staging.agrogenomax.com', () => {
    assert.equal(resolveGanaderiaPublicOrigin('staging'), 'https://staging.agrogenomax.com');
  });

  test('production -> https://agrogenomax.com (nunca agrogenomax.co ni ningún otro hardcode)', () => {
    assert.equal(resolveGanaderiaPublicOrigin('production'), 'https://agrogenomax.com');
  });

  test('test -> null (CORS_MANDATORY_ORIGINS_BY_ENV.test está vacío) -- nunca inventa localhost', () => {
    assert.equal(resolveGanaderiaPublicOrigin('test'), null);
  });

  test('buildRestablecerContrasenaUrl: construye la URL absoluta con el token URL-encoded', () => {
    const url = buildRestablecerContrasenaUrl('token-crudo-con-caracteres/+especiales', 'staging');
    assert.equal(url, 'https://staging.agrogenomax.com/ganaderia/restablecer-contrasena?token=token-crudo-con-caracteres%2F%2Bespeciales');
  });

  test('buildRestablecerContrasenaUrl: null cuando no hay origin canónico para el ambiente', () => {
    assert.equal(buildRestablecerContrasenaUrl('cualquier-token', 'test'), null);
  });
});

describe('AUTH-RECOVERY-002: sendRecoveryEmail() -- gate por ambiente (mismo criterio que CatastroX)', () => {
  test('development nunca llama al proveedor real, sin importar EMAIL_PROVIDER', async () => {
    const { getCalls } = stubFetch(() => jsonResponse(200, { id: 'msg_1' }));
    process.env.APP_ENV = 'development';
    process.env.EMAIL_PROVIDER = 'resend';
    process.env.RESEND_API_KEY = 're_synthetic_test_key_1234567890';

    const console_ = captureConsole();
    const result = await sendRecoveryEmail({ to: 'operador@fincaa.test', recoveryUrl: 'https://x.test/r?token=abc' });
    console_.restore();

    assert.equal(result.delivered, false);
    assert.equal(result.provider, 'stub');
    assert.equal(getCalls(), 0);
  });

  test('production no está habilitado en este lote -> EMAIL_PROVIDER_NOT_CONFIGURED, jamás llama a fetch', async () => {
    const { getCalls } = stubFetch(() => jsonResponse(200, { id: 'msg_1' }));
    process.env.APP_ENV = 'production';
    process.env.EMAIL_PROVIDER = 'resend';
    process.env.RESEND_API_KEY = 're_synthetic_test_key_1234567890';

    const result = await sendRecoveryEmail({ to: 'x@y.test', recoveryUrl: 'https://x.test/r' });
    assert.equal(result.delivered, false);
    assert.equal(result.errorCode, 'EMAIL_PROVIDER_NOT_CONFIGURED');
    assert.equal(getCalls(), 0);
  });

  test('staging + envío exitoso -> delivered:true, payload incluye el link de recuperación', async () => {
    setStagingEnv();
    let capturedBody = null;
    stubFetch((url, options) => {
      capturedBody = JSON.parse(options.body);
      return jsonResponse(200, { id: 'msg_ok' });
    });

    const result = await sendRecoveryEmail({ to: 'operador@fincaa.test', recoveryUrl: 'https://staging.agrogenomax.com/ganaderia/restablecer-contrasena?token=abc123' });
    assert.equal(result.delivered, true);
    assert.equal(result.provider, 'resend');
    assert.equal(capturedBody.to[0], 'operador@fincaa.test');
    assert.match(capturedBody.subject, /Recupera tu acceso/);
    assert.match(capturedBody.html, /abc123/);
    assert.equal(capturedBody.from, 'AgroGenomaX <no-reply@mail.staging.agrogenomax.com>');
    assert.match(capturedBody.text, /abc123/);
  });

  test('(K) staging + proveedor caído (500 persistente) -> delivered:false con errorCode interno, NUNCA lanza -- el llamador nunca ve detalle', async () => {
    setStagingEnv();
    stubFetch(() => new Response('boom', { status: 500 }));

    const console_ = captureConsole();
    const result = await sendRecoveryEmail({ to: 'operador@fincaa.test', recoveryUrl: 'https://staging.agrogenomax.com/x' });
    console_.restore();

    assert.equal(result.delivered, false);
    assert.equal(result.errorCode, 'EMAIL_PROVIDER_UNAVAILABLE');
    // El resultado es un objeto plano, nunca un throw -- el router que
    // llama sendRecoveryEmail dentro de un try/catch nunca ve un error
    // filtrarse hacia la respuesta HTTP pública.
  });

  test('AUTH-RECOVERY-003: el nombre visible siempre es "AgroGenomaX", sin importar el nombre configurado en EMAIL_FROM (nunca lo hereda ni lo muestra tal cual)', async () => {
    // Simula el valor REAL de producción -- EMAIL_FROM es una variable
    // compartida con CatastroX, cuyo nombre visible ahí es "CatastroX".
    // Ganadería NUNCA debe mostrar ese nombre, pero SÍ debe reusar la
    // MISMA dirección/dominio ya verificado en Resend (no inventa uno).
    setStagingEnv({ EMAIL_FROM: 'CatastroX <no-reply@mail.agrogenomax.com>' });
    let capturedBody = null;
    stubFetch((url, options) => {
      capturedBody = JSON.parse(options.body);
      return jsonResponse(200, { id: 'msg_ok' });
    });

    const result = await sendRecoveryEmail({ to: 'operador@fincaa.test', recoveryUrl: 'https://staging.agrogenomax.com/x' });
    assert.equal(result.delivered, true);
    assert.equal(capturedBody.from, 'AgroGenomaX <no-reply@mail.agrogenomax.com>');
    assert.doesNotMatch(capturedBody.from, /CatastroX/);
  });

  test('AUTH-RECOVERY-003: EMAIL_FROM con formato inválido -> EMAIL_FROM_INVALID (nunca envía con un remitente vacío/roto)', async () => {
    setStagingEnv({ EMAIL_FROM: 'esto-no-es-un-correo-valido' });
    const { getCalls } = stubFetch(() => jsonResponse(200, { id: 'x' }));

    const console_ = captureConsole();
    const result = await sendRecoveryEmail({ to: 'operador@fincaa.test', recoveryUrl: 'https://staging.agrogenomax.com/x' });
    console_.restore();

    assert.equal(result.delivered, false);
    assert.equal(result.errorCode, 'EMAIL_FROM_INVALID');
    assert.equal(getCalls(), 0);
  });

  test('(K) staging + API key ausente -> delivered:false EMAIL_API_KEY_MISSING, no llama a fetch', async () => {
    setStagingEnv({ RESEND_API_KEY: '' });
    const { getCalls } = stubFetch(() => jsonResponse(200, { id: 'x' }));

    const console_ = captureConsole();
    const result = await sendRecoveryEmail({ to: 'operador@fincaa.test', recoveryUrl: 'https://staging.agrogenomax.com/x' });
    console_.restore();

    assert.equal(result.delivered, false);
    assert.equal(result.errorCode, 'EMAIL_API_KEY_MISSING');
    assert.equal(getCalls(), 0);
  });

  test('nunca importa server/services/catastrox/emailSender.js (aislamiento de módulos)', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const source = await fs.readFile(path.join(import.meta.dirname, '..', 'emailSender.js'), 'utf8');
    // Se despojan los comentarios antes de la aserción -- el propio archivo
    // documenta en prosa, dentro de un comentario, que NO debe importar
    // catastrox/emailSender.js, lo que produciría un falso positivo si se
    // buscara el patrón contra el texto crudo incluyendo comentarios.
    const codeOnly = source.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(codeOnly, /catastrox\/emailSender/);
    assert.doesNotMatch(codeOnly, /from ['"].*catastrox/);
  });
});
