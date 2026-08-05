import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import {
  sendVerificationEmail,
  sendDeliverableEmail,
  parseEmailFromHeader,
  isEmailFromValidForEnvironment,
} from '../emailSender.js';

// EMAIL_PROVIDER_002: pruebas del envío real de OTP vía Resend. `fetch` es
// una API Web global en este runtime de Node -- sin red real: se sustituye
// en cada prueba y se restaura en `afterEach`. Mismo patrón que
// functions/api/__tests__/healthRelay.test.js/corsRelay.test.js.

const originalFetch = globalThis.fetch;
const ENV_KEYS = ['APP_ENV', 'EMAIL_PROVIDER', 'RESEND_API_KEY', 'EMAIL_FROM', 'EMAIL_SEND_TIMEOUT_MS'];
let savedEnv;

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  mock.timers.reset();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

function setStagingEnv(overrides = {}) {
  process.env.APP_ENV = 'staging';
  process.env.EMAIL_PROVIDER = 'resend';
  process.env.RESEND_API_KEY = 're_synthetic_test_key_1234567890';
  process.env.EMAIL_FROM = 'CatastroX <no-reply@mail.staging.agrogenomax.com>';
  delete process.env.EMAIL_SEND_TIMEOUT_MS;
  Object.assign(process.env, overrides);
}

function stubFetch(handler) {
  let calls = 0;
  const capturedArgs = [];
  globalThis.fetch = async (...args) => {
    calls += 1;
    capturedArgs.push(args);
    return handler(...args, calls);
  };
  return { getCalls: () => calls, getArgs: () => capturedArgs };
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
}

const BASE_INPUT = {
  to: 'comprador@example.com',
  verificationCode: '123456',
  expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  customerName: 'Ana Pérez',
  idempotencyKey: 'catastrox-otp-11111111-1111-1111-1111-111111111111',
};

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

describe('EMAIL_PROVIDER_002: sendVerificationEmail() -- gate por ambiente', () => {
  test('1. development nunca llama a Resend, sin importar EMAIL_PROVIDER', async () => {
    const { getCalls } = stubFetch(() => jsonResponse(200, { id: 'msg_1' }));
    process.env.APP_ENV = 'development';
    process.env.EMAIL_PROVIDER = 'resend';
    process.env.RESEND_API_KEY = 're_synthetic_test_key_1234567890';
    process.env.EMAIL_FROM = 'CatastroX <no-reply@mail.staging.agrogenomax.com>';

    const result = await sendVerificationEmail(BASE_INPUT);

    assert.equal(getCalls(), 0);
    assert.deepEqual(result, { delivered: false, provider: 'stub', providerMessageId: null, errorCode: null });
  });

  test('2. test nunca llama a Resend, sin importar EMAIL_PROVIDER', async () => {
    const { getCalls } = stubFetch(() => jsonResponse(200, { id: 'msg_1' }));
    process.env.APP_ENV = 'test';
    process.env.EMAIL_PROVIDER = 'resend';
    process.env.RESEND_API_KEY = 're_synthetic_test_key_1234567890';
    process.env.EMAIL_FROM = 'CatastroX <no-reply@mail.staging.agrogenomax.com>';

    const result = await sendVerificationEmail(BASE_INPUT);

    assert.equal(getCalls(), 0);
    assert.deepEqual(result, { delivered: false, provider: 'stub', providerMessageId: null, errorCode: null });
  });

  test('3. production no habilita Resend automáticamente (EMAIL_PROVIDER_NOT_CONFIGURED, sin llamar fetch)', async () => {
    const { getCalls } = stubFetch(() => jsonResponse(200, { id: 'msg_1' }));
    process.env.APP_ENV = 'production';
    process.env.EMAIL_PROVIDER = 'resend';
    process.env.RESEND_API_KEY = 're_synthetic_test_key_1234567890';
    process.env.EMAIL_FROM = 'CatastroX <no-reply@mail.staging.agrogenomax.com>';

    const result = await sendVerificationEmail(BASE_INPUT);

    assert.equal(getCalls(), 0);
    assert.equal(result.delivered, false);
    assert.equal(result.errorCode, 'EMAIL_PROVIDER_NOT_CONFIGURED');
  });

  test('4. staging requiere EMAIL_PROVIDER=resend -- sin configurar, no llama fetch', async () => {
    const { getCalls } = stubFetch(() => jsonResponse(200, { id: 'msg_1' }));
    process.env.APP_ENV = 'staging';
    delete process.env.EMAIL_PROVIDER;
    process.env.RESEND_API_KEY = 're_synthetic_test_key_1234567890';
    process.env.EMAIL_FROM = 'CatastroX <no-reply@mail.staging.agrogenomax.com>';

    const result = await sendVerificationEmail(BASE_INPUT);

    assert.equal(getCalls(), 0);
    assert.equal(result.delivered, false);
    assert.equal(result.provider, 'stub');
    assert.equal(result.errorCode, 'EMAIL_PROVIDER_NOT_CONFIGURED');
  });

  test('4b. staging con EMAIL_PROVIDER distinto de resend no llama fetch (EMAIL_PROVIDER_UNSUPPORTED)', async () => {
    const { getCalls } = stubFetch(() => jsonResponse(200, { id: 'msg_1' }));
    setStagingEnv({ EMAIL_PROVIDER: 'sendgrid' });

    const result = await sendVerificationEmail(BASE_INPUT);

    assert.equal(getCalls(), 0);
    assert.equal(result.errorCode, 'EMAIL_PROVIDER_UNSUPPORTED');
  });
});

describe('EMAIL_PROVIDER_002: precondiciones antes de llamar a Resend', () => {
  test('5. falta RESEND_API_KEY -- EMAIL_API_KEY_MISSING, sin llamar fetch', async () => {
    const { getCalls } = stubFetch(() => jsonResponse(200, { id: 'msg_1' }));
    setStagingEnv({ RESEND_API_KEY: '' });

    const result = await sendVerificationEmail(BASE_INPUT);

    assert.equal(getCalls(), 0);
    assert.deepEqual(result, { delivered: false, provider: 'resend', providerMessageId: null, errorCode: 'EMAIL_API_KEY_MISSING' });
  });

  test('6. RESEND_API_KEY con valor de marcador de posición -- EMAIL_API_KEY_MISSING, sin llamar fetch', async () => {
    const { getCalls } = stubFetch(() => jsonResponse(200, { id: 'msg_1' }));
    setStagingEnv({ RESEND_API_KEY: 're_REEMPLAZAR' });

    const result = await sendVerificationEmail(BASE_INPUT);

    assert.equal(getCalls(), 0);
    assert.equal(result.errorCode, 'EMAIL_API_KEY_MISSING');
  });

  test('7. EMAIL_FROM inválido (dominio localhost) -- EMAIL_FROM_INVALID, sin llamar fetch', async () => {
    const { getCalls } = stubFetch(() => jsonResponse(200, { id: 'msg_1' }));
    setStagingEnv({ EMAIL_FROM: 'CatastroX <no-reply@localhost>' });

    const result = await sendVerificationEmail(BASE_INPUT);

    assert.equal(getCalls(), 0);
    assert.equal(result.errorCode, 'EMAIL_FROM_INVALID');
  });

  test('7b. EMAIL_FROM ausente -- EMAIL_FROM_INVALID, sin llamar fetch', async () => {
    const { getCalls } = stubFetch(() => jsonResponse(200, { id: 'msg_1' }));
    setStagingEnv({ EMAIL_FROM: '' });

    const result = await sendVerificationEmail(BASE_INPUT);

    assert.equal(getCalls(), 0);
    assert.equal(result.errorCode, 'EMAIL_FROM_INVALID');
  });
});

describe('EMAIL_PROVIDER_002: respuestas del proveedor', () => {
  test('8. envío 200 válido -- delivered:true con providerMessageId', async () => {
    stubFetch(() => jsonResponse(200, { id: 'msg_abc123' }));
    setStagingEnv();

    const result = await sendVerificationEmail(BASE_INPUT);

    assert.deepEqual(result, { delivered: true, provider: 'resend', providerMessageId: 'msg_abc123', errorCode: null });
  });

  test('8b. envío 201 válido -- delivered:true con providerMessageId', async () => {
    stubFetch(() => jsonResponse(201, { id: 'msg_created_201' }));
    setStagingEnv();

    const result = await sendVerificationEmail(BASE_INPUT);

    assert.equal(result.delivered, true);
    assert.equal(result.providerMessageId, 'msg_created_201');
  });

  test('9. respuesta exitosa sin id -- EMAIL_RESPONSE_INVALID, fail-closed, sin reintentar', async () => {
    const { getCalls } = stubFetch(() => jsonResponse(200, { message: 'ok, sin id' }));
    setStagingEnv();

    const result = await sendVerificationEmail(BASE_INPUT);

    assert.equal(getCalls(), 1);
    assert.deepEqual(result, { delivered: false, provider: 'resend', providerMessageId: null, errorCode: 'EMAIL_RESPONSE_INVALID' });
  });

  test('10. HTTP 400 no reintenta -- EMAIL_PROVIDER_REJECTED', async () => {
    const { getCalls } = stubFetch(() => jsonResponse(400, { message: 'invalid recipient' }));
    setStagingEnv();

    const result = await sendVerificationEmail(BASE_INPUT);

    assert.equal(getCalls(), 1);
    assert.deepEqual(result, { delivered: false, provider: 'resend', providerMessageId: null, errorCode: 'EMAIL_PROVIDER_REJECTED' });
  });

  test('11. HTTP 401 no reintenta -- EMAIL_PROVIDER_REJECTED', async () => {
    const { getCalls } = stubFetch(() => jsonResponse(401, { message: 'invalid api key' }));
    setStagingEnv();

    const result = await sendVerificationEmail(BASE_INPUT);

    assert.equal(getCalls(), 1);
    assert.equal(result.errorCode, 'EMAIL_PROVIDER_REJECTED');
  });

  test('11b. HTTP 422 no reintenta -- EMAIL_PROVIDER_REJECTED', async () => {
    const { getCalls } = stubFetch(() => jsonResponse(422, { message: 'unprocessable' }));
    setStagingEnv();

    const result = await sendVerificationEmail(BASE_INPUT);

    assert.equal(getCalls(), 1);
    assert.equal(result.errorCode, 'EMAIL_PROVIDER_REJECTED');
  });

  test('12. HTTP 429 reintenta una vez y tiene éxito en el segundo intento', async () => {
    const { getCalls } = stubFetch((_url, _options, callNumber) =>
      callNumber === 1 ? jsonResponse(429, { message: 'rate limited' }) : jsonResponse(200, { id: 'msg_after_429' }),
    );
    setStagingEnv();

    const result = await sendVerificationEmail(BASE_INPUT);

    assert.equal(getCalls(), 2);
    assert.equal(result.delivered, true);
    assert.equal(result.providerMessageId, 'msg_after_429');
  });

  test('13. HTTP 500 reintenta una vez y tiene éxito en el segundo intento', async () => {
    const { getCalls } = stubFetch((_url, _options, callNumber) =>
      callNumber === 1 ? jsonResponse(500, { message: 'internal error' }) : jsonResponse(200, { id: 'msg_after_500' }),
    );
    setStagingEnv();

    const result = await sendVerificationEmail(BASE_INPUT);

    assert.equal(getCalls(), 2);
    assert.equal(result.delivered, true);
  });

  test('14. error de red reintenta una vez y tiene éxito en el segundo intento', async () => {
    const { getCalls } = stubFetch((_url, _options, callNumber) => {
      if (callNumber === 1) throw new TypeError('fetch failed');
      return jsonResponse(200, { id: 'msg_after_network_error' });
    });
    setStagingEnv();

    const result = await sendVerificationEmail(BASE_INPUT);

    assert.equal(getCalls(), 2);
    assert.equal(result.delivered, true);
  });

  test('15. segundo fallo (dos 500 consecutivos) termina fail-closed', async () => {
    const { getCalls } = stubFetch(() => jsonResponse(500, { message: 'internal error' }));
    setStagingEnv();

    const result = await sendVerificationEmail(BASE_INPUT);

    assert.equal(getCalls(), 2);
    assert.deepEqual(result, { delivered: false, provider: 'resend', providerMessageId: null, errorCode: 'EMAIL_PROVIDER_UNAVAILABLE' });
  });

  test('15b. segundo fallo (dos errores de red consecutivos) termina fail-closed', async () => {
    const { getCalls } = stubFetch(() => {
      throw new TypeError('fetch failed');
    });
    setStagingEnv();

    const result = await sendVerificationEmail(BASE_INPUT);

    assert.equal(getCalls(), 2);
    assert.deepEqual(result, { delivered: false, provider: 'resend', providerMessageId: null, errorCode: 'EMAIL_TRANSPORT_ERROR' });
  });

  test('16. timeout reintenta una vez y tiene éxito en el segundo intento', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    let calls = 0;
    globalThis.fetch = (_url, options) => {
      calls += 1;
      if (calls === 1) {
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => {
            const abortError = new Error('The operation was aborted');
            abortError.name = 'AbortError';
            reject(abortError);
          });
        });
      }
      return Promise.resolve(jsonResponse(200, { id: 'msg_after_timeout' }));
    };
    setStagingEnv();

    const resultPromise = sendVerificationEmail(BASE_INPUT);
    await flush();
    mock.timers.tick(5000); // dispara el timeout del primer intento (default 5000ms)
    await flush();
    mock.timers.tick(200); // dispara el delay entre el primer y el segundo intento
    await flush();

    const result = await resultPromise;
    assert.equal(calls, 2);
    assert.equal(result.delivered, true);
    assert.equal(result.providerMessageId, 'msg_after_timeout');
  });

  test('16b. dos timeouts consecutivos terminan fail-closed con EMAIL_TIMEOUT', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    let calls = 0;
    globalThis.fetch = (_url, options) => {
      calls += 1;
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          const abortError = new Error('The operation was aborted');
          abortError.name = 'AbortError';
          reject(abortError);
        });
      });
    };
    setStagingEnv();

    const resultPromise = sendVerificationEmail(BASE_INPUT);
    await flush();
    mock.timers.tick(5000);
    await flush();
    mock.timers.tick(200);
    await flush();
    mock.timers.tick(5000);
    await flush();

    const result = await resultPromise;
    assert.equal(calls, 2);
    assert.deepEqual(result, { delivered: false, provider: 'resend', providerMessageId: null, errorCode: 'EMAIL_TIMEOUT' });
  });
});

describe('EMAIL_PROVIDER_002: Idempotency-Key', () => {
  test('17. Idempotency-Key presente y estable entre el primer intento y el reintento', async () => {
    const { getArgs } = stubFetch((_url, _options, callNumber) =>
      callNumber === 1 ? jsonResponse(500, {}) : jsonResponse(200, { id: 'msg_idem' }),
    );
    setStagingEnv();

    await sendVerificationEmail(BASE_INPUT);

    const args = getArgs();
    assert.equal(args.length, 2);
    const firstKey = args[0][1].headers['Idempotency-Key'];
    const secondKey = args[1][1].headers['Idempotency-Key'];
    assert.equal(firstKey, BASE_INPUT.idempotencyKey);
    assert.equal(secondKey, BASE_INPUT.idempotencyKey);
  });

  test('17b. Idempotency-Key ausente si no se provee (nunca se inventa uno)', async () => {
    const { getArgs } = stubFetch(() => jsonResponse(200, { id: 'msg_no_idem' }));
    setStagingEnv();

    await sendVerificationEmail({ ...BASE_INPUT, idempotencyKey: null });

    const headers = getArgs()[0][1].headers;
    assert.equal('Idempotency-Key' in headers, false);
  });
});

describe('EMAIL_PROVIDER_002: seguridad -- logs y errores saneados', () => {
  test('18. el OTP nunca aparece en ningún log emitido durante el envío', async () => {
    stubFetch(() => jsonResponse(200, { id: 'msg_1' }));
    setStagingEnv();
    const capture = captureConsole();
    try {
      await sendVerificationEmail(BASE_INPUT);
    } finally {
      capture.restore();
    }
    const joined = JSON.stringify(capture.lines);
    assert.ok(!joined.includes(BASE_INPUT.verificationCode));
  });

  test('19. el correo completo del destinatario y su dominio nunca aparecen en ningún log', async () => {
    stubFetch(() => jsonResponse(200, { id: 'msg_1' }));
    setStagingEnv();
    const capture = captureConsole();
    try {
      await sendVerificationEmail(BASE_INPUT);
    } finally {
      capture.restore();
    }
    const joined = JSON.stringify(capture.lines);
    assert.ok(!joined.includes(BASE_INPUT.to));
    assert.ok(!joined.includes('example.com'));
    assert.ok(!joined.includes('toDomain'));
  });

  test('19b. ni el OTP ni el correo completo aparecen en logs de un envío fallido', async () => {
    stubFetch(() => jsonResponse(400, { message: `rejected ${BASE_INPUT.to}` }));
    setStagingEnv();
    const capture = captureConsole();
    try {
      await sendVerificationEmail(BASE_INPUT);
    } finally {
      capture.restore();
    }
    const joined = JSON.stringify(capture.lines);
    assert.ok(!joined.includes(BASE_INPUT.verificationCode));
    assert.ok(!joined.includes(BASE_INPUT.to));
  });

  test('20. la API key nunca aparece en el resultado devuelto ante ningún tipo de fallo', async () => {
    const apiKey = 're_synthetic_test_key_1234567890';
    setStagingEnv({ RESEND_API_KEY: apiKey });
    stubFetch(() => jsonResponse(401, { message: `unauthorized for key ${apiKey}` }));

    const result = await sendVerificationEmail(BASE_INPUT);

    assert.ok(!JSON.stringify(result).includes(apiKey));
  });

  test('20b. la API key nunca aparece en ningún log', async () => {
    const apiKey = 're_synthetic_test_key_1234567890';
    setStagingEnv({ RESEND_API_KEY: apiKey });
    stubFetch(() => jsonResponse(200, { id: 'msg_1' }));
    const capture = captureConsole();
    try {
      await sendVerificationEmail(BASE_INPUT);
    } finally {
      capture.restore();
    }
    const joined = JSON.stringify(capture.lines);
    assert.ok(!joined.includes(apiKey));
  });

  test('20c. el cuerpo completo de una respuesta de error del proveedor nunca se reenvía en el resultado', async () => {
    const secretLookingBody = { message: 'error interno', internalTraceId: 'trace-super-secreto-9001' };
    stubFetch(() => jsonResponse(500, secretLookingBody));
    setStagingEnv();

    const result = await sendVerificationEmail(BASE_INPUT);

    assert.ok(!JSON.stringify(result).includes('trace-super-secreto-9001'));
  });
});

describe('EMAIL_PROVIDER_002: plantilla OTP', () => {
  test('21. escapa customerName antes de insertarlo en HTML', async () => {
    const { getArgs } = stubFetch(() => jsonResponse(200, { id: 'msg_1' }));
    setStagingEnv();

    await sendVerificationEmail({ ...BASE_INPUT, customerName: '<script>alert(1)</script>' });

    const body = JSON.parse(getArgs()[0][1].body);
    assert.ok(!body.html.includes('<script>alert(1)</script>'));
    assert.ok(body.html.includes('&lt;script&gt;'));
  });

  test('21b. el texto plano no depende de escapado HTML (customerName aparece literal)', async () => {
    const { getArgs } = stubFetch(() => jsonResponse(200, { id: 'msg_1' }));
    setStagingEnv();

    await sendVerificationEmail({ ...BASE_INPUT, customerName: 'María José' });

    const body = JSON.parse(getArgs()[0][1].body);
    assert.ok(body.text.includes('María José'));
  });

  test('22. el payload enviado a Resend no contiene campos de PII adicional (solo from/to/subject/html/text)', async () => {
    const { getArgs } = stubFetch(() => jsonResponse(200, { id: 'msg_1' }));
    setStagingEnv();

    await sendVerificationEmail(BASE_INPUT);

    const body = JSON.parse(getArgs()[0][1].body);
    assert.deepEqual(Object.keys(body).sort(), ['from', 'html', 'subject', 'text', 'to']);
    assert.deepEqual(body.to, [BASE_INPUT.to]);
  });

  test('22b. la plantilla no incluye ningún enlace (sin <a href)', async () => {
    const { getArgs } = stubFetch(() => jsonResponse(200, { id: 'msg_1' }));
    setStagingEnv();

    await sendVerificationEmail(BASE_INPUT);

    const body = JSON.parse(getArgs()[0][1].body);
    assert.ok(!/href\s*=/i.test(body.html));
  });

  test('22c. la plantilla HTML/texto incluye el código, la marca CatastroX y una indicación de ignorar si no se solicitó', async () => {
    const { getArgs } = stubFetch(() => jsonResponse(200, { id: 'msg_1' }));
    setStagingEnv();

    await sendVerificationEmail(BASE_INPUT);

    const body = JSON.parse(getArgs()[0][1].body);
    for (const content of [body.html, body.text]) {
      assert.ok(content.includes('CatastroX'));
      assert.ok(content.includes(BASE_INPUT.verificationCode));
      assert.ok(/ignora/i.test(content));
    }
  });
});

describe('EMAIL_PROVIDER_002: parseEmailFromHeader()/isEmailFromValidForEnvironment()', () => {
  test('23. acepta "Nombre <correo@dominio>"', () => {
    const parsed = parseEmailFromHeader('CatastroX <no-reply@mail.staging.agrogenomax.com>');
    assert.deepEqual(parsed, {
      raw: 'CatastroX <no-reply@mail.staging.agrogenomax.com>',
      displayName: 'CatastroX',
      email: 'no-reply@mail.staging.agrogenomax.com',
      domain: 'mail.staging.agrogenomax.com',
    });
  });

  test('24. acepta "correo@dominio" plano', () => {
    const parsed = parseEmailFromHeader('no-reply@mail.staging.agrogenomax.com');
    assert.equal(parsed.email, 'no-reply@mail.staging.agrogenomax.com');
    assert.equal(parsed.displayName, null);
  });

  test('25. rechaza un valor sin @ ', () => {
    assert.equal(parseEmailFromHeader('no-es-un-correo'), null);
  });

  test('26. staging rechaza localhost/127.0.0.1/TLD reservado', () => {
    for (const value of [
      'no-reply@localhost',
      'no-reply@127.0.0.1',
      'no-reply@backend.local',
      'no-reply@backend.internal',
      'no-reply@backend.test',
    ]) {
      assert.equal(isEmailFromValidForEnvironment(value, 'staging'), false, `esperado rechazo para ${value}`);
    }
  });

  test('27. staging acepta un dominio público real', () => {
    assert.equal(isEmailFromValidForEnvironment('no-reply@mail.staging.agrogenomax.com', 'staging'), true);
  });

  test('28. development no restringe el dominio (un dominio no público en staging se acepta en development)', () => {
    assert.equal(isEmailFromValidForEnvironment('no-reply@backend.local', 'development'), true);
  });

  test('28b. un valor sin @ (sintácticamente inválido) se rechaza en cualquier ambiente, incluido development', () => {
    assert.equal(isEmailFromValidForEnvironment('no-es-un-correo', 'development'), false);
  });
});

// CATX-DELIVERY-001: sendDeliverableEmail() -- función paralela a
// sendVerificationEmail, mismo gate REAL_PROVIDER_ENABLED_ENVIRONMENTS
// (=['staging']), pero con adjunto (el PDF comprado) y con el código de
// error específico EMAIL_PROVIDER_DISABLED (nunca EMAIL_PROVIDER_NOT_CONFIGURED)
// cuando el ambiente no tiene el proveedor real habilitado -- señal que
// deliveryJobService.js necesita para nunca declarar "enviado" sin una
// confirmación real (ajuste obligatorio del plan aprobado).
describe('CATX-DELIVERY-001: sendDeliverableEmail() -- adjunto + gate por ambiente', () => {
  const DELIVERABLE_BASE_INPUT = {
    to: 'comprador@example.com',
    customerName: 'Ana Pérez',
    orderReference: 'CATX-BASICO-20260101-ABCDE',
    packageLabel: 'Básico',
    predioLabel: '184600002000000030015000000000',
    pdfBuffer: Buffer.from('%PDF-1.4 contenido de prueba', 'utf8'),
    pdfFilename: '184600002000000030015000000000_basico.pdf',
    idempotencyKey: 'catastrox-deliverable-11111111-1111-1111-1111-111111111111',
  };

  test('1. development nunca llama al proveedor real -- EMAIL_PROVIDER_DISABLED, no EMAIL_PROVIDER_NOT_CONFIGURED', async () => {
    const { getCalls } = stubFetch(() => jsonResponse(200, { id: 'msg_1' }));
    process.env.APP_ENV = 'development';
    process.env.EMAIL_PROVIDER = 'resend';
    process.env.RESEND_API_KEY = 're_synthetic_test_key_1234567890';
    process.env.EMAIL_FROM = 'CatastroX <no-reply@mail.staging.agrogenomax.com>';

    const result = await sendDeliverableEmail(DELIVERABLE_BASE_INPUT);

    assert.equal(getCalls(), 0);
    assert.deepEqual(result, { delivered: false, provider: 'stub', providerMessageId: null, errorCode: 'EMAIL_PROVIDER_DISABLED' });
  });

  test('2. test nunca llama al proveedor real -- EMAIL_PROVIDER_DISABLED', async () => {
    const { getCalls } = stubFetch(() => jsonResponse(200, { id: 'msg_1' }));
    process.env.APP_ENV = 'test';

    const result = await sendDeliverableEmail(DELIVERABLE_BASE_INPUT);

    assert.equal(getCalls(), 0);
    assert.equal(result.delivered, false);
    assert.equal(result.errorCode, 'EMAIL_PROVIDER_DISABLED');
  });

  test('3. production no habilita el proveedor -- EMAIL_PROVIDER_DISABLED (nunca declara enviado)', async () => {
    const { getCalls } = stubFetch(() => jsonResponse(200, { id: 'msg_1' }));
    process.env.APP_ENV = 'production';
    process.env.EMAIL_PROVIDER = 'resend';
    process.env.RESEND_API_KEY = 're_synthetic_test_key_1234567890';
    process.env.EMAIL_FROM = 'CatastroX <no-reply@mail.agrogenomax.com>';

    const result = await sendDeliverableEmail(DELIVERABLE_BASE_INPUT);

    assert.equal(getCalls(), 0);
    assert.equal(result.delivered, false);
    assert.equal(result.errorCode, 'EMAIL_PROVIDER_DISABLED');
  });

  test('4. sin pdfBuffer (o vacío) -- EMAIL_ATTACHMENT_MISSING, sin llamar fetch', async () => {
    const { getCalls } = stubFetch(() => jsonResponse(200, { id: 'msg_1' }));
    setStagingEnv();

    const result = await sendDeliverableEmail({ ...DELIVERABLE_BASE_INPUT, pdfBuffer: Buffer.alloc(0) });

    assert.equal(getCalls(), 0);
    assert.equal(result.errorCode, 'EMAIL_ATTACHMENT_MISSING');
  });

  test('5. envío 200 válido en staging -- delivered:true, adjunto presente en el body enviado a Resend', async () => {
    const { getCalls, getArgs } = stubFetch(() => jsonResponse(200, { id: 'msg_deliverable_1' }));
    setStagingEnv();

    const result = await sendDeliverableEmail(DELIVERABLE_BASE_INPUT);

    assert.equal(getCalls(), 1);
    assert.deepEqual(result, {
      delivered: true,
      provider: 'resend',
      providerMessageId: 'msg_deliverable_1',
      errorCode: null,
    });

    const [, options] = getArgs()[0];
    const sentBody = JSON.parse(options.body);
    assert.equal(sentBody.attachments.length, 1);
    assert.equal(sentBody.attachments[0].filename, DELIVERABLE_BASE_INPUT.pdfFilename);
    assert.equal(sentBody.attachments[0].content, DELIVERABLE_BASE_INPUT.pdfBuffer.toString('base64'));
    assert.ok(sentBody.subject.includes(DELIVERABLE_BASE_INPUT.orderReference));
  });

  test('5b. logs de email no incluyen correo completo ni dominio derivado', async () => {
    const consoleCapture = captureConsole();
    stubFetch(() => jsonResponse(200, { id: 'msg_log_minimized' }));
    setStagingEnv();
    try {
      const result = await sendDeliverableEmail(DELIVERABLE_BASE_INPUT);
      assert.equal(result.delivered, true);
    } finally {
      consoleCapture.restore();
    }

    const serializedLogs = JSON.stringify(consoleCapture.lines);
    assert.equal(serializedLogs.includes(DELIVERABLE_BASE_INPUT.to), false);
    assert.equal(serializedLogs.includes('example.com'), false);
    assert.equal(serializedLogs.includes('toDomain'), false);
  });

  test('6. HTTP 400 no reintenta -- EMAIL_PROVIDER_REJECTED', async () => {
    const { getCalls } = stubFetch(() => jsonResponse(400, { message: 'invalid' }));
    setStagingEnv();

    const result = await sendDeliverableEmail(DELIVERABLE_BASE_INPUT);

    assert.equal(getCalls(), 1);
    assert.equal(result.errorCode, 'EMAIL_PROVIDER_REJECTED');
  });

  test('7. HTTP 500 reintenta una vez y tiene éxito en el segundo intento', async () => {
    const { getCalls } = stubFetch((url, options, callNumber) =>
      callNumber === 1 ? jsonResponse(500, { message: 'down' }) : jsonResponse(200, { id: 'msg_retry' }),
    );
    setStagingEnv();

    const result = await sendDeliverableEmail(DELIVERABLE_BASE_INPUT);

    assert.equal(getCalls(), 2);
    assert.equal(result.delivered, true);
    assert.equal(result.providerMessageId, 'msg_retry');
  });

  test('8. falta RESEND_API_KEY -- EMAIL_API_KEY_MISSING, sin llamar fetch', async () => {
    const { getCalls } = stubFetch(() => jsonResponse(200, { id: 'msg_1' }));
    setStagingEnv({ RESEND_API_KEY: '' });

    const result = await sendDeliverableEmail(DELIVERABLE_BASE_INPUT);

    assert.equal(getCalls(), 0);
    assert.equal(result.errorCode, 'EMAIL_API_KEY_MISSING');
  });

  test('9. EMAIL_FROM inválido para el ambiente -- EMAIL_FROM_INVALID, sin llamar fetch', async () => {
    const { getCalls } = stubFetch(() => jsonResponse(200, { id: 'msg_1' }));
    setStagingEnv({ EMAIL_FROM: 'no-reply@localhost' });

    const result = await sendDeliverableEmail(DELIVERABLE_BASE_INPUT);

    assert.equal(getCalls(), 0);
    assert.equal(result.errorCode, 'EMAIL_FROM_INVALID');
  });

  test('10. sendVerificationEmail() (OTP) sigue sin adjuntos y con su propio código de error -- no se cruzó lógica entre ambas funciones', async () => {
    const { getCalls, getArgs } = stubFetch(() => jsonResponse(200, { id: 'msg_otp_1' }));
    setStagingEnv();

    const result = await sendVerificationEmail(BASE_INPUT);

    assert.equal(getCalls(), 1);
    assert.equal(result.delivered, true);
    const [, options] = getArgs()[0];
    const sentBody = JSON.parse(options.body);
    assert.equal('attachments' in sentBody, false, 'el correo de OTP nunca debe llevar adjuntos');
  });
});
