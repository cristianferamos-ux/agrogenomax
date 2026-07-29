import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { ConfigurationError, loadEnv, resolveCorsAllowedOrigins, validateEnv } from '../../config/env.js';
import {
  buildCorsPolicy,
  buildExpressCorsPolicy,
  createCorsMiddleware,
  evaluateCorsRequest,
  normalizeOrigin,
} from '../corsPolicy.js';
import { resolveAllowedOriginsForEnvironment } from '../../../shared/security/corsPolicy.js';

// Todas las pruebas de este archivo operan sobre política/decisión pura o
// sobre objetos req/res simulados -- sin red real, sin base de datos, sin
// navegador. `process.env` real nunca se modifica: `resolveCorsAllowedOrigins`
// recibe siempre un `source` inyectado.

function policyFor(appEnv, source = {}) {
  const allowedOrigins = resolveCorsAllowedOrigins(appEnv, source);
  return buildExpressCorsPolicy({ appEnv, allowedOrigins });
}

function makeReqRes({ method = 'GET', origin, headers = {} } = {}) {
  const req = {
    method,
    headers: { ...(origin !== undefined ? { origin } : {}), ...headers },
    path: '/api/test',
  };
  const res = {
    _headers: {},
    _status: 200,
    _ended: false,
    _body: null,
    setHeader(key, value) {
      this._headers[key] = value;
    },
    status(code) {
      this._status = code;
      return this;
    },
    end() {
      this._ended = true;
    },
    json(body) {
      this._body = body;
      this._ended = true;
    },
  };
  return { req, res };
}

describe('LOTE-004: server/security/corsPolicy.js', () => {
  test('1. development permite localhost autorizado', () => {
    const policy = policyFor('development');
    assert.equal(evaluateCorsRequest(policy, { method: 'GET', origin: 'http://localhost:5173' }).action, 'allow');
  });

  test('2. development permite 127.0.0.1 autorizado', () => {
    const policy = policyFor('development');
    assert.equal(evaluateCorsRequest(policy, { method: 'GET', origin: 'http://127.0.0.1:5173' }).action, 'allow');
  });

  // Defecto corregido (revisión de seguridad): 5178 es el puerto real del
  // entorno de verificación local -- quedaba fuera de la allowlist,
  // rompiendo /checkout y el resto de POST autenticados en CORS.
  test('14) development permite http://127.0.0.1:5178', () => {
    const policy = policyFor('development');
    assert.equal(evaluateCorsRequest(policy, { method: 'GET', origin: 'http://127.0.0.1:5178' }).action, 'allow');
  });

  test('15) development permite http://localhost:5178', () => {
    const policy = policyFor('development');
    assert.equal(evaluateCorsRequest(policy, { method: 'GET', origin: 'http://localhost:5178' }).action, 'allow');
  });

  test('3. development rechaza puerto local no autorizado', () => {
    const policy = policyFor('development');
    assert.equal(evaluateCorsRequest(policy, { method: 'GET', origin: 'http://localhost:9999' }).action, 'reject');
  });

  test('4. development rechaza hostname remoto', () => {
    const policy = policyFor('development');
    assert.equal(evaluateCorsRequest(policy, { method: 'GET', origin: 'https://agrogenomax.com' }).action, 'reject');
  });

  test('5. test usa allowlist inyectada', () => {
    const policy = policyFor('test', { CORS_ALLOWED_ORIGINS: 'https://mock.test' });
    assert.equal(evaluateCorsRequest(policy, { method: 'GET', origin: 'https://mock.test' }).action, 'allow');
    assert.equal(evaluateCorsRequest(policy, { method: 'GET', origin: 'https://otro.test' }).action, 'reject');

    const withoutConfig = policyFor('test');
    assert.deepEqual(withoutConfig.allowedOrigins, []);
  });

  test('6. staging permite staging.agrogenomax.com', () => {
    const policy = policyFor('staging');
    assert.equal(evaluateCorsRequest(policy, { method: 'GET', origin: 'https://staging.agrogenomax.com' }).action, 'allow');
  });

  test('7. staging rechaza demo.agrogenomax.com', () => {
    const policy = policyFor('staging');
    assert.equal(evaluateCorsRequest(policy, { method: 'GET', origin: 'https://demo.agrogenomax.com' }).action, 'reject');
  });

  test('8. staging rechaza agrogenomax.com', () => {
    const policy = policyFor('staging');
    assert.equal(evaluateCorsRequest(policy, { method: 'GET', origin: 'https://agrogenomax.com' }).action, 'reject');
  });

  test('9. staging rechaza localhost', () => {
    const policy = policyFor('staging');
    assert.equal(evaluateCorsRequest(policy, { method: 'GET', origin: 'http://localhost:5173' }).action, 'reject');
  });

  test('10. production permite agrogenomax.com', () => {
    const policy = policyFor('production');
    assert.equal(evaluateCorsRequest(policy, { method: 'GET', origin: 'https://agrogenomax.com' }).action, 'allow');
  });

  test('11. production permite www solo si la política lo declara', () => {
    const withoutWww = policyFor('production');
    assert.equal(evaluateCorsRequest(withoutWww, { method: 'GET', origin: 'https://www.agrogenomax.com' }).action, 'reject');

    const withWww = policyFor('production', { CORS_ALLOWED_ORIGINS: 'https://www.agrogenomax.com' });
    assert.equal(evaluateCorsRequest(withWww, { method: 'GET', origin: 'https://www.agrogenomax.com' }).action, 'allow');
  });

  test('12. production rechaza staging', () => {
    const policy = policyFor('production');
    assert.equal(evaluateCorsRequest(policy, { method: 'GET', origin: 'https://staging.agrogenomax.com' }).action, 'reject');
  });

  test('13. production rechaza demo', () => {
    const policy = policyFor('production');
    assert.equal(evaluateCorsRequest(policy, { method: 'GET', origin: 'https://demo.agrogenomax.com' }).action, 'reject');
  });

  test('14. production rechaza localhost', () => {
    const policy = policyFor('production');
    assert.equal(evaluateCorsRequest(policy, { method: 'GET', origin: 'http://localhost:5173' }).action, 'reject');
  });

  test('15. production rechaza Railway', () => {
    const policy = policyFor('production');
    assert.equal(
      evaluateCorsRequest(policy, { method: 'GET', origin: 'https://agrogenomax-production.up.railway.app' }).action,
      'reject',
    );
    assert.throws(
      () =>
        resolveCorsAllowedOrigins('production', {
          CORS_ALLOWED_ORIGINS: 'https://agrogenomax-production.up.railway.app',
        }),
      { code: 'CORS_ORIGIN_FORBIDDEN' },
    );
  });

  test('16. Origin null se rechaza', () => {
    const policy = policyFor('production');
    assert.equal(evaluateCorsRequest(policy, { method: 'GET', origin: 'null' }).action, 'reject');
  });

  test('17. Origin malformado se rechaza', () => {
    const policy = policyFor('production');
    assert.equal(evaluateCorsRequest(policy, { method: 'GET', origin: 'no-es-una-url-valida::::' }).action, 'reject');
  });

  test('18. Origin con path se rechaza en configuración', () => {
    assert.throws(
      () => resolveCorsAllowedOrigins('staging', { CORS_ALLOWED_ORIGINS: 'https://staging.agrogenomax.com/foo' }),
      { code: 'CORS_ORIGIN_INVALID' },
    );
  });

  test('19. Origin con query se rechaza en configuración', () => {
    assert.throws(
      () => resolveCorsAllowedOrigins('staging', { CORS_ALLOWED_ORIGINS: 'https://staging.agrogenomax.com?x=1' }),
      { code: 'CORS_ORIGIN_INVALID' },
    );
  });

  test('20. Origin con credenciales embebidas se rechaza', () => {
    assert.equal(normalizeOrigin('https://usuario:secreto@agrogenomax.com'), null);
    assert.throws(
      () =>
        resolveCorsAllowedOrigins('staging', {
          CORS_ALLOWED_ORIGINS: 'https://usuario:secreto@staging.agrogenomax.com',
        }),
      { code: 'CORS_ORIGIN_INVALID' },
    );
  });

  test('21. protocolo no http/https se rechaza', () => {
    assert.equal(normalizeOrigin('javascript:alert(1)'), null);
    assert.equal(normalizeOrigin('ftp://agrogenomax.com'), null);
    assert.equal(normalizeOrigin('data:text/html,x'), null);
  });

  test('22. wildcard se rechaza', () => {
    assert.equal(normalizeOrigin('*'), null);
    assert.throws(() => buildCorsPolicy({ appEnv: 'production', allowedOrigins: ['*'] }), {
      code: 'CORS_ORIGIN_INVALID',
    });
  });

  test('23. credentials=true nunca produce ACAO=*', () => {
    const policy = buildCorsPolicy({
      appEnv: 'staging',
      allowedOrigins: ['https://staging.agrogenomax.com'],
      allowCredentials: true,
    });
    const decision = evaluateCorsRequest(policy, { method: 'GET', origin: 'https://staging.agrogenomax.com' });
    assert.equal(decision.headers['Access-Control-Allow-Origin'], 'https://staging.agrogenomax.com');
    assert.notEqual(decision.headers['Access-Control-Allow-Origin'], '*');
    assert.equal(decision.headers['Access-Control-Allow-Credentials'], 'true');
  });

  test('24. origen rechazado no recibe ACAO', () => {
    const policy = policyFor('production');
    const decision = evaluateCorsRequest(policy, { method: 'GET', origin: 'https://evil.example' });
    assert.equal(decision.action, 'reject');
    assert.equal(decision.headers, undefined);
  });

  test('25. origen permitido recibe ACAO exacto', () => {
    const policy = policyFor('production');
    const decision = evaluateCorsRequest(policy, { method: 'GET', origin: 'https://agrogenomax.com' });
    assert.equal(decision.headers['Access-Control-Allow-Origin'], 'https://agrogenomax.com');
  });

  test('26. respuesta permitida incluye Vary: Origin', () => {
    const policy = policyFor('production');
    const decision = evaluateCorsRequest(policy, { method: 'GET', origin: 'https://agrogenomax.com' });
    assert.equal(decision.headers.Vary, 'Origin');
  });

  test('27. preflight permitido responde 204', () => {
    const policy = policyFor('production');
    const decision = evaluateCorsRequest(policy, {
      method: 'OPTIONS',
      origin: 'https://agrogenomax.com',
      requestedMethod: 'POST',
      requestedHeaders: 'Content-Type',
    });
    assert.equal(decision.action, 'preflight-ok');
    assert.equal(decision.status, 204);
  });

  test('28. preflight de origen bloqueado falla', () => {
    const policy = policyFor('production');
    const decision = evaluateCorsRequest(policy, {
      method: 'OPTIONS',
      origin: 'https://evil.example',
      requestedMethod: 'GET',
    });
    assert.equal(decision.action, 'reject');
  });

  test('29. preflight con método no permitido falla', () => {
    const policy = policyFor('production');
    const decision = evaluateCorsRequest(policy, {
      method: 'OPTIONS',
      origin: 'https://agrogenomax.com',
      requestedMethod: 'TRACE',
    });
    assert.equal(decision.action, 'reject');
    assert.equal(decision.reason, 'method_not_allowed');
  });

  test('30. preflight con header no permitido falla', () => {
    const policy = policyFor('production');
    const decision = evaluateCorsRequest(policy, {
      method: 'OPTIONS',
      origin: 'https://agrogenomax.com',
      requestedMethod: 'POST',
      requestedHeaders: 'X-Evil-Header',
    });
    assert.equal(decision.action, 'reject');
    assert.equal(decision.reason, 'header_not_allowed');
  });

  test('31. solicitud sin Origin no se trata automáticamente como cross-origin', () => {
    const policy = policyFor('production');
    assert.equal(evaluateCorsRequest(policy, { method: 'GET' }).action, 'continue');
  });

  test('32. health sin Origin continúa funcionando', () => {
    const policy = policyFor('production');
    const { req, res } = makeReqRes({ method: 'GET' });
    let nextCalled = false;
    createCorsMiddleware(policy)(req, res, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, true);
    assert.equal(res._ended, false);
  });

  test('33. reporter no incluye tokens ni cookies', () => {
    const policy = policyFor('production');
    const events = [];
    const { req, res } = makeReqRes({
      method: 'GET',
      origin: 'https://evil.example',
      headers: { authorization: 'Bearer secreto123', cookie: 'session=abc123' },
    });
    createCorsMiddleware(policy, { reporter: (event) => events.push(event) })(req, res, () => {});
    assert.equal(events.length, 1);
    const serialized = JSON.stringify(events[0]);
    assert.ok(!serialized.includes('secreto123'));
    assert.ok(!serialized.includes('abc123'));
    assert.ok(!('authorization' in events[0]));
    assert.ok(!('cookie' in events[0]));
  });

  test('34. allowlist de staging/production no puede quedar vacía', () => {
    assert.ok(resolveCorsAllowedOrigins('staging', {}).length > 0);
    assert.ok(resolveCorsAllowedOrigins('production', {}).length > 0);
    assert.throws(
      () => buildCorsPolicy({ appEnv: 'staging', allowedOrigins: [], requireNonEmptyOrigins: true }),
      { code: 'CORS_ALLOWLIST_EMPTY' },
    );
  });

  test('35. APP_ENV inválido continúa fallando mediante LOTE-002', () => {
    assert.throws(() => loadEnv({ APP_ENV: 'preproduccion' }), { code: 'APP_ENV_INVALID' });
    assert.ok(ConfigurationError);
  });

  test('36. demo no está permitido en ningún backend real', () => {
    const staging = policyFor('staging');
    const production = policyFor('production');
    assert.equal(evaluateCorsRequest(staging, { method: 'GET', origin: 'https://demo.agrogenomax.com' }).action, 'reject');
    assert.equal(
      evaluateCorsRequest(production, { method: 'GET', origin: 'https://demo.agrogenomax.com' }).action,
      'reject',
    );
    assert.throws(
      () => validateEnv('demo', { CORS_ALLOWED_ORIGINS: 'https://demo.agrogenomax.com' }),
      { code: 'PROHIBITED_VARIABLE_PRESENT' },
    );
  });

  test('37. no existe reflexión libre de Origin', () => {
    const envs = [
      ['development', {}],
      ['test', { CORS_ALLOWED_ORIGINS: 'https://mock.test' }],
      ['staging', {}],
      ['production', {}],
    ];
    for (const [appEnv, source] of envs) {
      const policy = policyFor(appEnv, source);
      const decision = evaluateCorsRequest(policy, { method: 'GET', origin: 'https://random-attacker.example' });
      assert.equal(decision.action, 'reject', `esperado reject para ${appEnv}`);
    }
  });

  test('38. no existe Access-Control-Allow-Origin: *', () => {
    const envs = [
      ['development', {}],
      ['staging', {}],
      ['production', {}],
    ];
    for (const [appEnv, source] of envs) {
      const policy = policyFor(appEnv, source);
      for (const origin of policy.allowedOrigins) {
        const decision = evaluateCorsRequest(policy, { method: 'GET', origin });
        assert.notEqual(decision.headers['Access-Control-Allow-Origin'], '*');
      }
    }
  });

  test('39. OPTIONS no ejecuta handler de negocio', () => {
    const policy = policyFor('production');
    let nextCalled = false;

    const allowed = makeReqRes({
      method: 'OPTIONS',
      origin: 'https://agrogenomax.com',
      headers: { 'access-control-request-method': 'POST' },
    });
    createCorsMiddleware(policy)(allowed.req, allowed.res, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, false);
    assert.equal(allowed.res._status, 204);

    const blocked = makeReqRes({
      method: 'OPTIONS',
      origin: 'https://evil.example',
      headers: { 'access-control-request-method': 'POST' },
    });
    createCorsMiddleware(policy)(blocked.req, blocked.res, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, false);
    assert.equal(blocked.res._status, 403);
  });

  test('40. configuración resultante es inmutable', () => {
    const policy = policyFor('production');
    assert.ok(Object.isFrozen(policy));
    assert.ok(Object.isFrozen(policy.allowedOrigins));
    assert.throws(() => {
      'use strict';
      policy.allowCredentials = true;
    });
  });
});

describe('LOTE-004 (corrección): dominios oficiales de producción (agrogenomax.com y agrogenomax.co)', () => {
  test('D1. production permite https://agrogenomax.com', () => {
    const policy = policyFor('production');
    assert.equal(evaluateCorsRequest(policy, { method: 'GET', origin: 'https://agrogenomax.com' }).action, 'allow');
  });

  test('D2. production permite https://agrogenomax.co', () => {
    const policy = policyFor('production');
    assert.equal(evaluateCorsRequest(policy, { method: 'GET', origin: 'https://agrogenomax.co' }).action, 'allow');
  });

  test('D3. production sin configuración adicional permite exactamente ambos apex', () => {
    const policy = policyFor('production');
    assert.deepEqual(policy.allowedOrigins, ['https://agrogenomax.com', 'https://agrogenomax.co']);
  });

  test('D4. production permite https://www.agrogenomax.com solo si se declara', () => {
    const withoutWww = policyFor('production');
    assert.equal(evaluateCorsRequest(withoutWww, { method: 'GET', origin: 'https://www.agrogenomax.com' }).action, 'reject');

    const withWww = policyFor('production', { CORS_ALLOWED_ORIGINS: 'https://www.agrogenomax.com' });
    assert.equal(evaluateCorsRequest(withWww, { method: 'GET', origin: 'https://www.agrogenomax.com' }).action, 'allow');
  });

  test('D5. production permite https://www.agrogenomax.co solo si se declara', () => {
    const withoutWww = policyFor('production');
    assert.equal(evaluateCorsRequest(withoutWww, { method: 'GET', origin: 'https://www.agrogenomax.co' }).action, 'reject');

    const withWww = policyFor('production', { CORS_ALLOWED_ORIGINS: 'https://www.agrogenomax.co' });
    assert.equal(evaluateCorsRequest(withWww, { method: 'GET', origin: 'https://www.agrogenomax.co' }).action, 'allow');
  });

  test('D6. production rechaza cualquier otro subdominio de agrogenomax.com', () => {
    const policy = policyFor('production');
    assert.equal(evaluateCorsRequest(policy, { method: 'GET', origin: 'https://app.agrogenomax.com' }).action, 'reject');
    assert.throws(
      () => resolveCorsAllowedOrigins('production', { CORS_ALLOWED_ORIGINS: 'https://app.agrogenomax.com' }),
      { code: 'CORS_ORIGIN_FORBIDDEN' },
    );
  });

  test('D7. production rechaza cualquier otro subdominio de agrogenomax.co', () => {
    const policy = policyFor('production');
    assert.equal(evaluateCorsRequest(policy, { method: 'GET', origin: 'https://app.agrogenomax.co' }).action, 'reject');
    assert.throws(
      () => resolveCorsAllowedOrigins('production', { CORS_ALLOWED_ORIGINS: 'https://app.agrogenomax.co' }),
      { code: 'CORS_ORIGIN_FORBIDDEN' },
    );
  });

  test('D8. staging rechaza https://agrogenomax.com', () => {
    const policy = policyFor('staging');
    assert.equal(evaluateCorsRequest(policy, { method: 'GET', origin: 'https://agrogenomax.com' }).action, 'reject');
  });

  test('D9. staging rechaza https://agrogenomax.co', () => {
    const policy = policyFor('staging');
    assert.equal(evaluateCorsRequest(policy, { method: 'GET', origin: 'https://agrogenomax.co' }).action, 'reject');
  });

  test('D10. la política Express (server/config/env.js) y el módulo puro compartido producen exactamente la misma allowlist de producción', () => {
    const fromEnv = resolveCorsAllowedOrigins('production', {});
    const fromShared = resolveAllowedOriginsForEnvironment('production', []);
    assert.deepEqual([...fromEnv], [...fromShared]);
    assert.deepEqual([...fromEnv], ['https://agrogenomax.com', 'https://agrogenomax.co']);

    const fromEnvWithWww = resolveCorsAllowedOrigins('production', { CORS_ALLOWED_ORIGINS: 'https://www.agrogenomax.co' });
    const fromSharedWithWww = resolveAllowedOriginsForEnvironment('production', ['https://www.agrogenomax.co']);
    assert.deepEqual([...fromEnvWithWww], [...fromSharedWithWww]);
  });
});

// LOTE 019-C: excepcion acotada de "tunel de desarrollo" (Cloudflare Quick
// Tunnel) para permitir, unicamente en development + WOMPI_ENV=test +
// CORS_ALLOW_DEV_TUNNEL=true, el origen HTTPS exacto ya listado en
// CORS_ALLOWED_ORIGINS -- sin comodines, sin ampliar ningun otro ambiente.
describe('LOTE 019-C: excepcion de tunel de desarrollo en CORS', () => {
  // Origen ficticio de prueba -- nunca fue ni sera un tunel real activo.
  const TUNNEL_ORIGIN = 'https://catastrox-fixture.trycloudflare.com';
  const baseSource = {
    CORS_ALLOWED_ORIGINS: `http://127.0.0.1:5178,${TUNNEL_ORIGIN}`,
    WOMPI_ENV: 'test',
    CORS_ALLOW_DEV_TUNNEL: 'true',
  };

  test('1. development + test + flag true + origen exacto configurado -> permitido', () => {
    const policy = policyFor('development', baseSource);
    assert.equal(evaluateCorsRequest(policy, { method: 'GET', origin: TUNNEL_ORIGIN }).action, 'allow');
  });

  test('2. development + test + flag false -> rechazado', () => {
    assert.throws(
      () => resolveCorsAllowedOrigins('development', { ...baseSource, CORS_ALLOW_DEV_TUNNEL: 'false' }),
      { code: 'CORS_ORIGIN_FORBIDDEN' },
    );
  });

  test('3. development + WOMPI_ENV=production (no test) -> rechazado', () => {
    assert.throws(
      () => resolveCorsAllowedOrigins('development', { ...baseSource, WOMPI_ENV: 'production' }),
      { code: 'CORS_ORIGIN_FORBIDDEN' },
    );
  });

  test('4. staging + flag true -> rechazado (la excepcion no existe fuera de development)', () => {
    assert.throws(
      () => resolveCorsAllowedOrigins('staging', { ...baseSource, CORS_ALLOWED_ORIGINS: TUNNEL_ORIGIN }),
      { code: 'CORS_ORIGIN_FORBIDDEN' },
    );
  });

  test('5. production + flag true -> rechazado (la excepcion no existe fuera de development)', () => {
    assert.throws(
      () => resolveCorsAllowedOrigins('production', { ...baseSource, CORS_ALLOWED_ORIGINS: TUNNEL_ORIGIN }),
      { code: 'CORS_ORIGIN_FORBIDDEN' },
    );
  });

  test('6. otro subdominio trycloudflare distinto al configurado -> rechazado', () => {
    const policy = policyFor('development', baseSource);
    assert.equal(
      evaluateCorsRequest(policy, { method: 'GET', origin: 'https://otro-subdominio-diferente.trycloudflare.com' }).action,
      'reject',
    );
  });

  test('7. comodin *.trycloudflare.com -> rechazado (normalizeOrigin nunca acepta patrones)', () => {
    assert.throws(
      () => resolveCorsAllowedOrigins('development', { ...baseSource, CORS_ALLOWED_ORIGINS: '*.trycloudflare.com' }),
      { code: 'CORS_ORIGIN_INVALID' },
    );
  });

  test('8. origen del tunel sin HTTPS (http://) -> rechazado incluso con el flag activo', () => {
    const httpTunnelOrigin = 'http://catastrox-fixture.trycloudflare.com';
    assert.throws(
      () => resolveCorsAllowedOrigins('development', { ...baseSource, CORS_ALLOWED_ORIGINS: httpTunnelOrigin }),
      { code: 'CORS_ORIGIN_FORBIDDEN' },
    );
  });

  test('9. localhost/127.0.0.1 conservan su comportamiento actual (mandatorios + explicito ya soportado)', () => {
    const policy = policyFor('development', baseSource);
    assert.equal(evaluateCorsRequest(policy, { method: 'GET', origin: 'http://localhost:5173' }).action, 'allow');
    assert.equal(evaluateCorsRequest(policy, { method: 'GET', origin: 'http://127.0.0.1:5178' }).action, 'allow');
    assert.equal(evaluateCorsRequest(policy, { method: 'GET', origin: 'http://127.0.0.1:9999' }).action, 'reject');
  });

  test('10. sin CORS_ALLOW_DEV_TUNNEL en absoluto (variable ausente) -> se comporta como false, rechaza', () => {
    const { CORS_ALLOW_DEV_TUNNEL, ...withoutFlag } = baseSource;
    assert.throws(() => resolveCorsAllowedOrigins('development', withoutFlag), { code: 'CORS_ORIGIN_FORBIDDEN' });
  });

  test('11. demo prohibe CORS_ALLOW_DEV_TUNNEL explicitamente (validateEnv)', () => {
    assert.throws(
      () => validateEnv('demo', { APP_ENV: 'demo', CORS_ALLOW_DEV_TUNNEL: 'true' }),
      { code: 'PROHIBITED_VARIABLE_PRESENT' },
    );
  });
});
