import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createMonitorAuthMiddleware } from '../monitorAuth.js';

// LOTE-007 (ADR-012 §35.A): sin red, sin base de datos -- únicamente
// objetos req/res simulados en memoria.

function fakeRes() {
  const res = {
    statusCode: null,
    headers: {},
    body: null,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
    },
  };
  return res;
}

describe('LOTE-007: server/health/monitorAuth.js', () => {
  test('sin token configurado responde 503 y nunca llama next()', () => {
    const middleware = createMonitorAuthMiddleware({});
    const res = fakeRes();
    let nextCalled = false;
    middleware({ headers: {} }, res, () => {
      nextCalled = true;
    });
    assert.equal(res.statusCode, 503);
    assert.equal(nextCalled, false);
    assert.equal(res.headers['Cache-Control'], 'no-store');
  });

  test('sin header Authorization responde 401', () => {
    const middleware = createMonitorAuthMiddleware({ token: 'secreto-valido' });
    const res = fakeRes();
    middleware({ headers: {} }, res, () => {
      throw new Error('next() no debía invocarse');
    });
    assert.equal(res.statusCode, 401);
  });

  test('esquema distinto de Bearer responde 401', () => {
    const middleware = createMonitorAuthMiddleware({ token: 'secreto-valido' });
    const res = fakeRes();
    middleware({ headers: { authorization: 'Basic secreto-valido' } }, res, () => {
      throw new Error('next() no debía invocarse');
    });
    assert.equal(res.statusCode, 401);
  });

  test('token incorrecto responde 401', () => {
    const middleware = createMonitorAuthMiddleware({ token: 'secreto-valido' });
    const res = fakeRes();
    middleware({ headers: { authorization: 'Bearer secreto-incorrecto' } }, res, () => {
      throw new Error('next() no debía invocarse');
    });
    assert.equal(res.statusCode, 401);
  });

  test('token de longitud distinta responde 401 sin lanzar', () => {
    const middleware = createMonitorAuthMiddleware({ token: 'secreto-valido' });
    const res = fakeRes();
    assert.doesNotThrow(() => {
      middleware({ headers: { authorization: 'Bearer x' } }, res, () => {
        throw new Error('next() no debía invocarse');
      });
    });
    assert.equal(res.statusCode, 401);
  });

  test('token correcto invoca next() sin cuerpo de error', () => {
    const middleware = createMonitorAuthMiddleware({ token: 'secreto-valido' });
    const res = fakeRes();
    let nextCalled = false;
    middleware({ headers: { authorization: 'Bearer secreto-valido' } }, res, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, true);
    assert.equal(res.statusCode, null);
  });

  test('esquema Bearer se acepta sin distinguir mayúsculas/minúsculas', () => {
    const middleware = createMonitorAuthMiddleware({ token: 'secreto-valido' });

    for (const scheme of ['bearer', 'BEARER', 'BeArEr']) {
      const res = fakeRes();
      let nextCalled = false;
      middleware({ headers: { authorization: `${scheme} secreto-valido` } }, res, () => {
        nextCalled = true;
      });
      assert.equal(nextCalled, true, `esquema "${scheme}" debía autenticar`);
      assert.equal(res.statusCode, null);
    }
  });

  test('token correcto pero más largo que el token esperado (contiene el esperado como prefijo) responde 401', () => {
    // Verifica que la comparación es por hash SHA-256 de longitud fija,
    // nunca por un prefijo/substring del token crudo.
    const middleware = createMonitorAuthMiddleware({ token: 'secreto-valido' });
    const res = fakeRes();
    middleware({ headers: { authorization: 'Bearer secreto-validoXXXX' } }, res, () => {
      throw new Error('next() no debía invocarse');
    });
    assert.equal(res.statusCode, 401);
  });

  test('respuesta de rechazo nunca incluye el token esperado', () => {
    const middleware = createMonitorAuthMiddleware({ token: 'secreto-super-sensible' });
    const res = fakeRes();
    middleware({ headers: { authorization: 'Bearer otra-cosa' } }, res, () => {});
    const serialized = JSON.stringify(res.body || {});
    assert.ok(!serialized.includes('secreto-super-sensible'));
  });
});
