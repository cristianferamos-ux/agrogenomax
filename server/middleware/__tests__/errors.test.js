import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { errorHandler, notFound } from '../errors.js';

// LOTE-009 (ADR-012 §11/§23): sin servidor real, sin base de datos --
// únicamente objetos req/res simulados en memoria.

function fakeRes({ headersSent = false } = {}) {
  const res = {
    statusCode: null,
    headers: {},
    body: null,
    headersSent,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  return res;
}

function captureConsoleError(fn) {
  const original = console.error;
  const calls = [];
  console.error = (...args) => {
    calls.push(args);
  };
  try {
    fn();
  } finally {
    console.error = original;
  }
  return calls;
}

describe('LOTE-009: server/middleware/errors.js', () => {
  test('notFound responde 404 con mensaje fijo y Cache-Control: no-store', () => {
    const res = fakeRes();
    notFound({}, res);
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.body, { error: 'Ruta no encontrada' });
    assert.equal(res.headers['Cache-Control'], 'no-store');
  });

  test('error 400 controlado conserva error.message', () => {
    const res = fakeRes();
    const error = Object.assign(new Error('Campo "nombre" es obligatorio'), { status: 400 });
    captureConsoleError(() => errorHandler(error, {}, res, () => {}));
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.body, { error: 'Campo "nombre" es obligatorio' });
    assert.equal(res.headers['Cache-Control'], 'no-store');
  });

  test('error 404 controlado conserva error.message', () => {
    const res = fakeRes();
    const error = Object.assign(new Error('Recurso no existe'), { status: 404 });
    captureConsoleError(() => errorHandler(error, {}, res, () => {}));
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.body, { error: 'Recurso no existe' });
  });

  test('error 409 controlado conserva error.message', () => {
    const res = fakeRes();
    const error = Object.assign(new Error('El registro ya existe'), { status: 409 });
    captureConsoleError(() => errorHandler(error, {}, res, () => {}));
    assert.equal(res.statusCode, 409);
    assert.deepEqual(res.body, { error: 'El registro ya existe' });
  });

  test('error 429 controlado conserva error.message', () => {
    const res = fakeRes();
    const error = Object.assign(new Error('Demasiadas solicitudes'), { status: 429 });
    captureConsoleError(() => errorHandler(error, {}, res, () => {}));
    assert.equal(res.statusCode, 429);
    assert.deepEqual(res.body, { error: 'Demasiadas solicitudes' });
  });

  test('error 500 nunca expone error.message', () => {
    const res = fakeRes();
    const error = Object.assign(new Error('detalle interno sensible'), { status: 500 });
    captureConsoleError(() => errorHandler(error, {}, res, () => {}));
    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.body, { error: 'Error interno del servidor' });
    const serialized = JSON.stringify(res.body);
    assert.ok(!serialized.includes('detalle interno sensible'));
  });

  test('error 503 (readiness/mantenimiento) nunca expone error.message', () => {
    const res = fakeRes();
    const error = Object.assign(new Error('pool_exhausted en agx'), { status: 503 });
    captureConsoleError(() => errorHandler(error, {}, res, () => {}));
    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.body, { error: 'Error interno del servidor' });
  });

  test('error simulado de driver pg (5xx) no expone mensaje crudo ni credenciales', () => {
    const res = fakeRes();
    const pgError = Object.assign(
      new Error('connection to server at "db.internal" (10.0.0.5), port 5432 failed: password authentication failed for user "agx_app"'),
      { status: 500, code: '28P01', name: 'error' },
    );
    captureConsoleError(() => errorHandler(pgError, {}, res, () => {}));
    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.body, { error: 'Error interno del servidor' });
    const serialized = JSON.stringify(res.body);
    assert.ok(!serialized.includes('password'));
    assert.ok(!serialized.includes('10.0.0.5'));
    assert.ok(!serialized.includes('agx_app'));
  });

  test('status ausente normaliza a 500 con mensaje genérico', () => {
    const res = fakeRes();
    const error = new Error('sin status definido');
    captureConsoleError(() => errorHandler(error, {}, res, () => {}));
    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.body, { error: 'Error interno del servidor' });
  });

  test('status inválido (string, decimal o fuera de rango) normaliza a 500', () => {
    for (const rawStatus of ['404', 404.5, 999, -1, 0, NaN, {}, null]) {
      const res = fakeRes();
      const error = Object.assign(new Error('mensaje irrelevante'), { status: rawStatus });
      captureConsoleError(() => errorHandler(error, {}, res, () => {}));
      assert.equal(res.statusCode, 500, `status=${JSON.stringify(rawStatus)} debía normalizar a 500`);
      assert.deepEqual(res.body, { error: 'Error interno del servidor' });
    }
  });

  test('statusCode entero válido normaliza igual que status', () => {
    const res = fakeRes();
    const error = Object.assign(new Error('Solicitud inválida'), { statusCode: 400 });
    captureConsoleError(() => errorHandler(error, {}, res, () => {}));
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.body, { error: 'Solicitud inválida' });
  });

  test('toda respuesta de errorHandler incluye Cache-Control: no-store', () => {
    for (const status of [400, 404, 409, 429, 500, 503]) {
      const res = fakeRes();
      const error = Object.assign(new Error('x'), { status });
      captureConsoleError(() => errorHandler(error, {}, res, () => {}));
      assert.equal(res.headers['Cache-Control'], 'no-store', `status=${status} debía incluir no-store`);
    }
  });

  test('el registro de consola es mínimo y no incluye message, stack, SQL ni credenciales', () => {
    const error = Object.assign(
      new Error('SELECT * FROM usuarios WHERE password = \'secreto123\' -- token=abc'),
      { status: 500, name: 'DatabaseError' },
    );
    const calls = captureConsoleError(() => errorHandler(error, {}, fakeRes(), () => {}));
    assert.equal(calls.length, 1);
    const serializedCall = JSON.stringify(calls[0]);
    assert.ok(!serializedCall.includes('secreto123'));
    assert.ok(!serializedCall.includes('token=abc'));
    assert.ok(!serializedCall.includes('SELECT'));
    assert.ok(!serializedCall.includes('DatabaseError'));
    assert.ok(!serializedCall.includes(error.stack));
    assert.ok(!serializedCall.includes(error.message));
    assert.deepEqual(calls[0], ['[errorHandler] status=500 category=internal_error']);
  });

  test('error.name con SQL, token, salto de línea y credencial nunca llega a console.error', () => {
    const error = Object.assign(
      new Error('mensaje irrelevante'),
      { status: 500, name: 'SQL_ERROR token=abc\ncredencial=secreto123' },
    );
    const calls = captureConsoleError(() => errorHandler(error, {}, fakeRes(), () => {}));
    assert.equal(calls.length, 1);
    const serializedCall = JSON.stringify(calls[0]);
    assert.ok(!serializedCall.includes('SQL'));
    assert.ok(!serializedCall.includes('token'));
    assert.ok(!serializedCall.includes('credencial'));
    assert.ok(!serializedCall.includes('\n'));
    assert.deepEqual(calls[0], ['[errorHandler] status=500 category=internal_error']);
  });

  test('con headersSent=true, delega con next(error) sin llamar status/json de nuevo', () => {
    const res = fakeRes({ headersSent: true });
    const error = Object.assign(new Error('ya se envió parte de la respuesta'), { status: 500 });
    let forwardedError = null;
    captureConsoleError(() =>
      errorHandler(error, {}, res, (err) => {
        forwardedError = err;
      }),
    );
    assert.equal(forwardedError, error);
    assert.equal(res.statusCode, null);
    assert.equal(res.body, null);
  });
});
