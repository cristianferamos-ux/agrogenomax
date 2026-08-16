import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';

import {
  sessionCookieName,
  generateSessionSecret,
  hashSessionSecret,
  buildSessionSetCookieHeader,
  buildSessionClearCookieHeader,
  getSessionRawTokenFromCookieHeader,
  computeCsrfToken,
  validateCsrfToken,
  isRequestOriginValid,
  resolveSessionIdentity,
  resolveTenantAuthorization,
  listOrganizacionesDisponibles,
  isMembresiaActivaParaOrganizacion,
  createRequireGanaderiaIdentity,
  createRequireGanaderiaSession,
  createRequireGanaderiaRole,
  createRequireGanaderiaCsrf,
} from '../ganaderiaSession.js';
import { getAgxAuthPool, __resetAgxAuthPoolForTests } from '../../db/agxAuthPool.js';
import { getConfig, __resetValidationStateForTests } from '../../config/env.js';

const FAKE_CONNECTION_STRING = 'postgres://test:test@192.0.2.1:5432/never_connects';
const TEST_CSRF_SECRET = 'gwslZ1bKInXjQ0TLmMqWeV6vRAL2hONB6bTBqpAjVFs='; // 32 bytes base64, sintético
const ALLOWED_ORIGINS = Object.freeze(['https://agrogenomax.com', 'https://agrogenomax.co']);

function stubPoolQuery(handler) {
  const pool = getAgxAuthPool({ AGX_AUTH_DATABASE_URL: FAKE_CONNECTION_STRING });
  pool.query = handler;
  return pool;
}

function makeReq({ method = 'GET', cookie, origin, referer, headers = {} } = {}) {
  const lowerHeaders = {};
  for (const [key, value] of Object.entries(headers)) lowerHeaders[key.toLowerCase()] = value;
  if (cookie !== undefined) lowerHeaders.cookie = cookie;
  if (origin !== undefined) lowerHeaders.origin = origin;
  if (referer !== undefined) lowerHeaders.referer = referer;

  return {
    method,
    headers: lowerHeaders,
    get(name) {
      return lowerHeaders[String(name).toLowerCase()];
    },
  };
}

function makeRes() {
  const res = {
    statusCode: null,
    body: undefined,
    ended: false,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    end() {
      this.ended = true;
      return this;
    },
    headersSent: false,
  };
  return res;
}

beforeEach(() => {
  __resetAgxAuthPoolForTests();
  __resetValidationStateForTests();
  getConfig({ APP_ENV: 'development' }, {});
});

describe('BFF-001: cookie de sesión', () => {
  test('nombre de cookie condicionado al ambiente (__Host- exige Secure, rompería development sobre HTTP)', () => {
    assert.equal(sessionCookieName('development'), 'agx_session');
    assert.equal(sessionCookieName('test'), 'agx_session');
    assert.equal(sessionCookieName('staging'), '__Host-agx_session');
    assert.equal(sessionCookieName('production'), '__Host-agx_session');
  });

  test('generateSessionSecret produce valores distintos y de alta entropía', () => {
    const a = generateSessionSecret();
    const b = generateSessionSecret();
    assert.notEqual(a, b);
    assert.ok(a.length >= 40);
  });

  test('el hash guardado NUNCA es igual al token crudo (requisito 1 del plan de pruebas)', () => {
    const raw = generateSessionSecret();
    const hash = hashSessionSecret(raw);
    assert.notEqual(hash, raw);
    assert.equal(hash, crypto.createHash('sha256').update(raw, 'utf8').digest('hex'));
    assert.match(hash, /^[0-9a-f]{64}$/);
  });

  test('buildSessionSetCookieHeader: HttpOnly/SameSite=Lax/Path=/ siempre; Secure solo en staging/production', () => {
    const dev = buildSessionSetCookieHeader('raw-token', 'development');
    assert.match(dev, /^agx_session=raw-token;/);
    assert.match(dev, /HttpOnly/);
    assert.match(dev, /SameSite=Lax/);
    assert.match(dev, /Path=\//);
    assert.doesNotMatch(dev, /Secure/);

    const prod = buildSessionSetCookieHeader('raw-token', 'production');
    assert.match(prod, /^__Host-agx_session=raw-token;/);
    assert.match(prod, /Secure/);
  });

  test('buildSessionClearCookieHeader: Max-Age=0, mismos atributos que la de creación', () => {
    const cleared = buildSessionClearCookieHeader('production');
    assert.match(cleared, /^__Host-agx_session=;/);
    assert.match(cleared, /Max-Age=0/);
    assert.match(cleared, /HttpOnly/);
    assert.match(cleared, /Secure/);
    assert.match(cleared, /SameSite=Lax/);
  });

  test('getSessionRawTokenFromCookieHeader: extrae el valor exacto, ignora otras cookies, null si ausente', () => {
    assert.equal(getSessionRawTokenFromCookieHeader(undefined, 'development'), null);
    assert.equal(getSessionRawTokenFromCookieHeader('otra=x; otra2=y', 'development'), null);
    assert.equal(getSessionRawTokenFromCookieHeader('otra=x; agx_session=abc123; otra2=y', 'development'), 'abc123');
    assert.equal(getSessionRawTokenFromCookieHeader('agx_session=abc123', 'production'), null, 'nombre distinto en production');
    assert.equal(getSessionRawTokenFromCookieHeader('__Host-agx_session=xyz', 'production'), 'xyz');
  });
});

describe('BFF-001: CSRF (HMAC-SHA256, sin persistencia)', () => {
  test('mismo token de sesión -> mismo csrfToken (determinista)', () => {
    const raw = generateSessionSecret();
    const a = computeCsrfToken(raw, TEST_CSRF_SECRET);
    const b = computeCsrfToken(raw, TEST_CSRF_SECRET);
    assert.equal(a, b);
  });

  test('csrfToken distinto de la cookie de sesión y del secreto de servidor', () => {
    const raw = generateSessionSecret();
    const token = computeCsrfToken(raw, TEST_CSRF_SECRET);
    assert.notEqual(token, raw);
    assert.notEqual(token, TEST_CSRF_SECRET);
  });

  test('rota automáticamente al rotar la sesión (secreto distinto -> token distinto)', () => {
    const rawA = generateSessionSecret();
    const rawB = generateSessionSecret();
    assert.notEqual(computeCsrfToken(rawA, TEST_CSRF_SECRET), computeCsrfToken(rawB, TEST_CSRF_SECRET));
  });

  test('validateCsrfToken: válido -> true', () => {
    const raw = generateSessionSecret();
    const token = computeCsrfToken(raw, TEST_CSRF_SECRET);
    assert.equal(validateCsrfToken(raw, token, TEST_CSRF_SECRET), true);
  });

  test('validateCsrfToken: token de otra sesión -> false', () => {
    const rawA = generateSessionSecret();
    const rawB = generateSessionSecret();
    const tokenB = computeCsrfToken(rawB, TEST_CSRF_SECRET);
    assert.equal(validateCsrfToken(rawA, tokenB, TEST_CSRF_SECRET), false);
  });

  test('validateCsrfToken: ausente/vacío -> false, nunca lanza', () => {
    const raw = generateSessionSecret();
    assert.equal(validateCsrfToken(raw, undefined, TEST_CSRF_SECRET), false);
    assert.equal(validateCsrfToken(raw, '', TEST_CSRF_SECRET), false);
  });

  test('validateCsrfToken: longitud distinta -> false, nunca lanza (guard antes de timingSafeEqual)', () => {
    const raw = generateSessionSecret();
    assert.equal(validateCsrfToken(raw, 'corto', TEST_CSRF_SECRET), false);
  });
});

describe('BFF-001: política Origin/Referer (catálogo cerrado)', () => {
  test('Origin presente y permitido -> true', () => {
    const req = makeReq({ origin: 'https://agrogenomax.com' });
    assert.equal(isRequestOriginValid(req, ALLOWED_ORIGINS), true);
  });

  test('Origin presente pero no coincide -> false (rechazo inmediato)', () => {
    const req = makeReq({ origin: 'https://evil.example' });
    assert.equal(isRequestOriginValid(req, ALLOWED_ORIGINS), false);
  });

  test("Origin: 'null' literal -> false siempre", () => {
    const req = makeReq({ origin: 'null' });
    assert.equal(isRequestOriginValid(req, ALLOWED_ORIGINS), false);
  });

  test('Origin ausente + Referer de origen permitido -> true (único escenario del catálogo)', () => {
    const req = makeReq({ referer: 'https://agrogenomax.com/ganaderia/predios' });
    assert.equal(isRequestOriginValid(req, ALLOWED_ORIGINS), true);
  });

  test('Origin ausente + Referer de origen NO permitido -> false', () => {
    const req = makeReq({ referer: 'https://evil.example/pagina' });
    assert.equal(isRequestOriginValid(req, ALLOWED_ORIGINS), false);
  });

  test('Origin ausente + Referer ausente -> false (nunca aceptación implícita por ausencia de ambos)', () => {
    const req = makeReq({});
    assert.equal(isRequestOriginValid(req, ALLOWED_ORIGINS), false);
  });

  test('Referer malformado -> false, nunca lanza', () => {
    const req = makeReq({ referer: 'no-es-una-url' });
    assert.equal(isRequestOriginValid(req, ALLOWED_ORIGINS), false);
  });
});

describe('BFF-001: matriz de estados de sesión (resolveSessionIdentity / resolveTenantAuthorization)', () => {
  test('hash inexistente (0 filas) -> null', async () => {
    stubPoolQuery(async () => ({ rows: [] }));
    assert.equal(await resolveSessionIdentity('token-cualquiera'), null);
  });

  test('sesión revocada (fecha_revocacion no nula) -> null', async () => {
    stubPoolQuery(async () => ({
      rows: [
        {
          sesion_id: 's1',
          cuenta_id: 'c1',
          organizacion_id: null,
          fecha_expiracion: new Date(Date.now() + 60_000).toISOString(),
          fecha_revocacion: new Date().toISOString(),
          cuenta_estado: 'activa',
          email: 'a@b.com',
          nombre: 'A',
        },
      ],
    }));
    assert.equal(await resolveSessionIdentity('t'), null);
  });

  test('sesión expirada -> null', async () => {
    stubPoolQuery(async () => ({
      rows: [
        {
          sesion_id: 's1',
          cuenta_id: 'c1',
          organizacion_id: null,
          fecha_expiracion: new Date(Date.now() - 60_000).toISOString(),
          fecha_revocacion: null,
          cuenta_estado: 'activa',
          email: 'a@b.com',
          nombre: 'A',
        },
      ],
    }));
    assert.equal(await resolveSessionIdentity('t'), null);
  });

  test('cuenta inactiva -> null', async () => {
    stubPoolQuery(async () => ({
      rows: [
        {
          sesion_id: 's1',
          cuenta_id: 'c1',
          organizacion_id: null,
          fecha_expiracion: new Date(Date.now() + 60_000).toISOString(),
          fecha_revocacion: null,
          cuenta_estado: 'inactiva',
          email: 'a@b.com',
          nombre: 'A',
        },
      ],
    }));
    assert.equal(await resolveSessionIdentity('t'), null);
  });

  test('sesión válida NUEVA + organizacion_id NULL -> identidad válida, organizacionId null (Arquitectura B)', async () => {
    stubPoolQuery(async () => ({
      rows: [
        {
          sesion_id: 's1',
          cuenta_id: 'c1',
          organizacion_id: null,
          fecha_expiracion: new Date(Date.now() + 60_000).toISOString(),
          fecha_revocacion: null,
          cuenta_estado: 'activa',
          email: 'a@b.com',
          nombre: 'A',
        },
      ],
    }));
    const identity = await resolveSessionIdentity('t');
    assert.deepEqual(identity, { sesionId: 's1', cuentaId: 'c1', organizacionId: null, email: 'a@b.com', nombre: 'A' });
  });

  test('sesión válida CON organización -> identidad válida, organizacionId presente', async () => {
    stubPoolQuery(async () => ({
      rows: [
        {
          sesion_id: 's1',
          cuenta_id: 'c1',
          organizacion_id: 'org-1',
          fecha_expiracion: new Date(Date.now() + 60_000).toISOString(),
          fecha_revocacion: null,
          cuenta_estado: 'activa',
          email: 'a@b.com',
          nombre: 'A',
        },
      ],
    }));
    const identity = await resolveSessionIdentity('t');
    assert.equal(identity.organizacionId, 'org-1');
  });

  test('resolveTenantAuthorization: 0 filas -> null (membresía/organización caídas, o sin fn_resolver_autorizacion_sesion positivo)', async () => {
    stubPoolQuery(async () => ({ rows: [] }));
    assert.equal(await resolveTenantAuthorization('t'), null);
  });

  test('resolveTenantAuthorization: 1 fila -> objeto con rol', async () => {
    stubPoolQuery(async () => ({ rows: [{ sesion_id: 's1', cuenta_id: 'c1', organizacion_id: 'org-1', rol: 'admin' }] }));
    const tenant = await resolveTenantAuthorization('t');
    assert.deepEqual(tenant, { sesionId: 's1', cuentaId: 'c1', organizacionId: 'org-1', rol: 'admin' });
  });

  test('listOrganizacionesDisponibles mapea filas a {organizacionId, rol, nombre}', async () => {
    stubPoolQuery(async () => ({
      rows: [{ organizacion_id: 'org-1', rol: 'owner', nombre: 'Finca A' }],
    }));
    const orgs = await listOrganizacionesDisponibles('c1');
    assert.deepEqual(orgs, [{ organizacionId: 'org-1', rol: 'owner', nombre: 'Finca A' }]);
  });

  test('isMembresiaActivaParaOrganizacion: sin fila -> null; con fila -> {rol}', async () => {
    stubPoolQuery(async () => ({ rows: [] }));
    assert.equal(await isMembresiaActivaParaOrganizacion('c1', 'org-x'), null);

    stubPoolQuery(async () => ({ rows: [{ rol: 'operador' }] }));
    assert.deepEqual(await isMembresiaActivaParaOrganizacion('c1', 'org-1'), { rol: 'operador' });
  });
});

describe('BFF-001: middlewares Express', () => {
  test('requireGanaderiaIdentity: sin cookie -> 401 SESSION_REQUIRED', async () => {
    const middleware = createRequireGanaderiaIdentity({ appEnv: 'development' });
    const req = makeReq({});
    const res = makeRes();
    await middleware(req, res, () => assert.fail('next() no debía llamarse'));
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.error, 'SESSION_REQUIRED');
  });

  test('requireGanaderiaIdentity: cookie inválida (hash no resuelve) -> 401 SESSION_INVALID', async () => {
    stubPoolQuery(async () => ({ rows: [] }));
    const middleware = createRequireGanaderiaIdentity({ appEnv: 'development' });
    const req = makeReq({ cookie: 'agx_session=no-existe' });
    const res = makeRes();
    await middleware(req, res, () => assert.fail('next() no debía llamarse'));
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.error, 'SESSION_INVALID');
  });

  test('requireGanaderiaIdentity: sesión válida -> next(), req.ganaderiaAuth poblado', async () => {
    stubPoolQuery(async () => ({
      rows: [
        {
          sesion_id: 's1',
          cuenta_id: 'c1',
          organizacion_id: null,
          fecha_expiracion: new Date(Date.now() + 60_000).toISOString(),
          fecha_revocacion: null,
          cuenta_estado: 'activa',
          email: 'a@b.com',
          nombre: 'A',
        },
      ],
    }));
    const middleware = createRequireGanaderiaIdentity({ appEnv: 'development' });
    const req = makeReq({ cookie: 'agx_session=raw-valido' });
    const res = makeRes();
    let nextCalled = false;
    await middleware(req, res, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, true);
    assert.equal(req.ganaderiaAuth.sesionId, 's1');
    assert.equal(req.ganaderiaAuth.rawToken, 'raw-valido');
  });

  test('requireGanaderiaSession: identidad válida + organizacion_id NULL -> 409 ORGANIZATION_REQUIRED', async () => {
    stubPoolQuery(async () => ({
      rows: [
        {
          sesion_id: 's1',
          cuenta_id: 'c1',
          organizacion_id: null,
          fecha_expiracion: new Date(Date.now() + 60_000).toISOString(),
          fecha_revocacion: null,
          cuenta_estado: 'activa',
          email: 'a@b.com',
          nombre: 'A',
        },
      ],
    }));
    const middleware = createRequireGanaderiaSession({ appEnv: 'development' });
    const req = makeReq({ cookie: 'agx_session=raw-valido' });
    const res = makeRes();
    await middleware(req, res, () => assert.fail('next() no debía llamarse'));
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.error, 'ORGANIZATION_REQUIRED');
  });

  test('requireGanaderiaSession: organizacion_id fijado pero resolución de tenant falla (Modelo 1) -> 401, NUNCA degrada a tenant-less', async () => {
    const pool = getAgxAuthPool({ AGX_AUTH_DATABASE_URL: FAKE_CONNECTION_STRING });
    let call = 0;
    pool.query = async () => {
      call += 1;
      if (call === 1) {
        // resolveSessionIdentity: identidad "válida" con organizacion_id fijado
        return {
          rows: [
            {
              sesion_id: 's1',
              cuenta_id: 'c1',
              organizacion_id: 'org-1',
              fecha_expiracion: new Date(Date.now() + 60_000).toISOString(),
              fecha_revocacion: null,
              cuenta_estado: 'activa',
              email: 'a@b.com',
              nombre: 'A',
            },
          ],
        };
      }
      // resolveTenantAuthorization: 0 filas (membresía/organización cayeron)
      return { rows: [] };
    };

    const middleware = createRequireGanaderiaSession({ appEnv: 'development' });
    const req = makeReq({ cookie: 'agx_session=raw-valido' });
    const res = makeRes();
    await middleware(req, res, () => assert.fail('next() no debía llamarse'));
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.error, 'SESSION_INVALID');
  });

  test('requireGanaderiaSession: identidad + tenant resueltos -> next(), req.ganaderiaAuth.rol poblado', async () => {
    const pool = getAgxAuthPool({ AGX_AUTH_DATABASE_URL: FAKE_CONNECTION_STRING });
    let call = 0;
    pool.query = async () => {
      call += 1;
      if (call === 1) {
        return {
          rows: [
            {
              sesion_id: 's1',
              cuenta_id: 'c1',
              organizacion_id: 'org-1',
              fecha_expiracion: new Date(Date.now() + 60_000).toISOString(),
              fecha_revocacion: null,
              cuenta_estado: 'activa',
              email: 'a@b.com',
              nombre: 'A',
            },
          ],
        };
      }
      return { rows: [{ sesion_id: 's1', cuenta_id: 'c1', organizacion_id: 'org-1', rol: 'admin' }] };
    };

    const middleware = createRequireGanaderiaSession({ appEnv: 'development' });
    const req = makeReq({ cookie: 'agx_session=raw-valido' });
    const res = makeRes();
    let nextCalled = false;
    await middleware(req, res, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, true);
    assert.equal(req.ganaderiaAuth.rol, 'admin');
  });

  test('requireGanaderiaRole: rol no permitido -> 403 ROLE_FORBIDDEN', () => {
    const middleware = createRequireGanaderiaRole('owner', 'admin');
    const req = { ganaderiaAuth: { rol: 'lector' } };
    const res = makeRes();
    middleware(req, res, () => assert.fail('next() no debía llamarse'));
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.error, 'ROLE_FORBIDDEN');
  });

  test('requireGanaderiaRole: rol permitido -> next()', () => {
    const middleware = createRequireGanaderiaRole('owner', 'admin');
    const req = { ganaderiaAuth: { rol: 'admin' } };
    const res = makeRes();
    let nextCalled = false;
    middleware(req, res, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, true);
  });

  describe('requireGanaderiaCsrf', () => {
    function csrfMiddleware() {
      return createRequireGanaderiaCsrf({ csrfServerSecret: TEST_CSRF_SECRET, allowedOrigins: ALLOWED_ORIGINS });
    }

    test('GET nunca requiere CSRF -- ni siquiera valida el header', () => {
      const middleware = csrfMiddleware();
      const req = makeReq({ method: 'GET' });
      const res = makeRes();
      let nextCalled = false;
      middleware(req, res, () => {
        nextCalled = true;
      });
      assert.equal(nextCalled, true);
    });

    test('HEAD/OPTIONS tampoco requieren CSRF', () => {
      const middleware = csrfMiddleware();
      for (const method of ['HEAD', 'OPTIONS']) {
        const req = makeReq({ method });
        const res = makeRes();
        let nextCalled = false;
        middleware(req, res, () => {
          nextCalled = true;
        });
        assert.equal(nextCalled, true, `${method} debía pasar sin CSRF`);
      }
    });

    test('POST sin sesión resuelta previamente -> 401 SESSION_REQUIRED', () => {
      const middleware = csrfMiddleware();
      const req = makeReq({ method: 'POST', origin: 'https://agrogenomax.com' });
      const res = makeRes();
      middleware(req, res, () => assert.fail('next() no debía llamarse'));
      assert.equal(res.statusCode, 401);
    });

    test('POST con Origin inválido -> 403 ORIGIN_INVALID', () => {
      const middleware = csrfMiddleware();
      const raw = generateSessionSecret();
      const req = makeReq({ method: 'POST', origin: 'https://evil.example' });
      req.ganaderiaAuth = { rawToken: raw };
      const res = makeRes();
      middleware(req, res, () => assert.fail('next() no debía llamarse'));
      assert.equal(res.statusCode, 403);
      assert.equal(res.body.error, 'ORIGIN_INVALID');
    });

    test('POST sin Origin ni Referer -> 403 ORIGIN_INVALID (nunca aceptación implícita)', () => {
      const middleware = csrfMiddleware();
      const raw = generateSessionSecret();
      const req = makeReq({ method: 'POST' });
      req.ganaderiaAuth = { rawToken: raw };
      const res = makeRes();
      middleware(req, res, () => assert.fail('next() no debía llamarse'));
      assert.equal(res.statusCode, 403);
      assert.equal(res.body.error, 'ORIGIN_INVALID');
    });

    test('POST con Origin válido pero sin header X-CSRF-Token -> 403 CSRF_REQUIRED', () => {
      const middleware = csrfMiddleware();
      const raw = generateSessionSecret();
      const req = makeReq({ method: 'POST', origin: 'https://agrogenomax.com' });
      req.ganaderiaAuth = { rawToken: raw };
      const res = makeRes();
      middleware(req, res, () => assert.fail('next() no debía llamarse'));
      assert.equal(res.statusCode, 403);
      assert.equal(res.body.error, 'CSRF_REQUIRED');
    });

    test('POST con X-CSRF-Token inválido -> 403 CSRF_INVALID', () => {
      const middleware = csrfMiddleware();
      const raw = generateSessionSecret();
      const req = makeReq({
        method: 'POST',
        origin: 'https://agrogenomax.com',
        headers: { 'x-csrf-token': 'token-incorrecto' },
      });
      req.ganaderiaAuth = { rawToken: raw };
      const res = makeRes();
      middleware(req, res, () => assert.fail('next() no debía llamarse'));
      assert.equal(res.statusCode, 403);
      assert.equal(res.body.error, 'CSRF_INVALID');
    });

    test('POST con Origin válido + X-CSRF-Token correcto -> next()', () => {
      const middleware = csrfMiddleware();
      const raw = generateSessionSecret();
      const token = computeCsrfToken(raw, TEST_CSRF_SECRET);
      const req = makeReq({
        method: 'POST',
        origin: 'https://agrogenomax.com',
        headers: { 'x-csrf-token': token },
      });
      req.ganaderiaAuth = { rawToken: raw };
      const res = makeRes();
      let nextCalled = false;
      middleware(req, res, () => {
        nextCalled = true;
      });
      assert.equal(nextCalled, true);
    });

    test('POST con Origin ausente pero Referer válido + CSRF correcto -> next() (fallback cerrado)', () => {
      const middleware = csrfMiddleware();
      const raw = generateSessionSecret();
      const token = computeCsrfToken(raw, TEST_CSRF_SECRET);
      const req = makeReq({
        method: 'POST',
        referer: 'https://agrogenomax.com/ganaderia/predios',
        headers: { 'x-csrf-token': token },
      });
      req.ganaderiaAuth = { rawToken: raw };
      const res = makeRes();
      let nextCalled = false;
      middleware(req, res, () => {
        nextCalled = true;
      });
      assert.equal(nextCalled, true);
    });
  });
});
