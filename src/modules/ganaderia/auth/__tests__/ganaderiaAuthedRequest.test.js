// SPRINT-3D10.5 F3a: contrato del cliente HTTP autenticado compartido.
// Tests puros (node:test) con un fetch falso que registra cada llamada --
// nunca red real, nunca cuentas reales.
import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchCsrfToken,
  getJsonWithSession,
  postJsonWithCsrf,
  performGanaderiaLogout,
  postWithCsrf,
} from '../ganaderiaAuthedRequest.js';
import { subscribeAuthNotice } from '../ganaderiaAuthNoticeSignal.js';

const CSRF_URL = '/api/ganaderia/auth/csrf';
const TARGET = '/api/ganaderia/predios/p1/potreros/q1/ciclo-pastoreo/iniciar';

const originalFetch = globalThis.fetch;
let calls;
let notices;
let unsubscribe;

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function text(status, body) {
  return new Response(body, { status, headers: { 'Content-Type': 'text/html' } });
}

// Cada respuesta de la cola es una Response o una función que lanza
// (simula fallo de red).
function installFetch(...queue) {
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    const next = queue.shift();
    if (next === undefined) throw new Error(`fetch inesperado: ${url}`);
    if (typeof next === 'function') return next();
    return next;
  };
}

function networkFailure() {
  throw new TypeError('Failed to fetch');
}

const csrfOk = () => json(200, { csrfToken: 'server-token' });
const postCalls = () => calls.filter((c) => c.url !== CSRF_URL);

beforeEach(() => {
  calls = [];
  notices = [];
  unsubscribe = subscribeAuthNotice((kind) => notices.push(kind));
});

afterEach(() => {
  unsubscribe();
  globalThis.fetch = originalFetch;
});

// 1
test('csrf 200 + POST 200: resultado idéntico al contrato previo, 1 csrf + 1 POST, sin failure', async () => {
  installFetch(csrfOk(), json(200, { ok: true, cicloId: 'c1' }));
  const result = await postJsonWithCsrf(TARGET, { a: 1 });
  assert.deepEqual(result, { ok: true, status: 200, data: { ok: true, cicloId: 'c1' } });
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'failure'), false);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, CSRF_URL);
  assert.equal(calls[1].url, TARGET);
  assert.equal(calls[1].init.method, 'POST');
  assert.equal(calls[1].init.credentials, 'include');
  assert.equal(calls[1].init.headers['X-CSRF-Token'], 'server-token');
  assert.equal(calls[1].init.headers['Content-Type'], 'application/json');
  assert.equal(calls[1].init.body, JSON.stringify({ a: 1 }));
  assert.deepEqual(notices, []);
});

test('GET /csrf usa method GET + credentials include', async () => {
  installFetch(csrfOk(), json(200, {}));
  await postJsonWithCsrf(TARGET, {});
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.credentials, 'include');
});

// 2
for (const code of ['SESSION_REQUIRED', 'SESSION_INVALID']) {
  test(`csrf 401 ${code}: 0 POST, SESSION_EXPIRED, aviso una vez, no lanza`, async () => {
    installFetch(json(401, { error: code }));
    const result = await postJsonWithCsrf(TARGET, { a: 1 });
    assert.deepEqual(result, { ok: false, status: 401, data: { error: 'SESSION_EXPIRED' }, failure: 'SESSION_EXPIRED' });
    assert.equal(postCalls().length, 0);
    assert.deepEqual(notices, ['SESSION_EXPIRED']);
  });
}

// 3
test('csrf con error de red: 0 POST, REQUEST_NOT_SENT, sin aviso, no lanza', async () => {
  installFetch(networkFailure);
  const result = await postJsonWithCsrf(TARGET, { a: 1 });
  assert.deepEqual(result, { ok: false, status: 0, data: { error: 'CSRF_UNAVAILABLE' }, failure: 'REQUEST_NOT_SENT' });
  assert.equal(postCalls().length, 0);
  assert.deepEqual(notices, []);
});

// 4
for (const [label, response, status] of [
  ['401 con código desconocido', () => json(401, { error: 'OTRA_COSA' }), 401],
  ['401 sin body JSON', () => text(401, 'no autorizado'), 401],
  ['403', () => json(403, { error: 'FORBIDDEN' }), 403],
  ['500', () => json(500, { error: 'Error interno' }), 500],
  ['503 relay', () => json(503, { error: 'Relay de Ganadería no disponible.' }), 503],
  ['200 con JSON inválido', () => text(200, '<html>'), 0],
  ['200 sin csrfToken', () => json(200, {}), 0],
  ['200 con csrfToken vacío', () => json(200, { csrfToken: '' }), 0],
]) {
  test(`csrf ${label}: 0 POST, REQUEST_NOT_SENT, sin aviso`, async () => {
    installFetch(response());
    const result = await postJsonWithCsrf(TARGET, { a: 1 });
    assert.deepEqual(result, { ok: false, status, data: { error: 'CSRF_UNAVAILABLE' }, failure: 'REQUEST_NOT_SENT' });
    assert.equal(postCalls().length, 0);
    assert.deepEqual(notices, []);
  });
}

// 5
for (const code of ['SESSION_REQUIRED', 'SESSION_INVALID']) {
  test(`POST 401 ${code}: conserva body del backend, SESSION_EXPIRED + aviso`, async () => {
    installFetch(csrfOk(), json(401, { error: code }));
    const result = await postJsonWithCsrf(TARGET, {});
    assert.deepEqual(result, { ok: false, status: 401, data: { error: code }, failure: 'SESSION_EXPIRED' });
    assert.deepEqual(notices, ['SESSION_EXPIRED']);
  });
}

// 6
test('POST 401 sin body JSON: sin aviso ni failure (nunca se clasifica solo por status)', async () => {
  installFetch(csrfOk(), text(401, 'nope'));
  const result = await postJsonWithCsrf(TARGET, {});
  assert.deepEqual(result, { ok: false, status: 401, data: null });
  assert.deepEqual(notices, []);
});

test('POST 401 con código no-sesión: sin aviso ni failure', async () => {
  installFetch(csrfOk(), json(401, { error: 'INVALID_CREDENTIALS' }));
  const result = await postJsonWithCsrf(TARGET, {});
  assert.deepEqual(result, { ok: false, status: 401, data: { error: 'INVALID_CREDENTIALS' } });
  assert.deepEqual(notices, []);
});

// 7
for (const code of ['CSRF_REQUIRED', 'CSRF_INVALID', 'ORIGIN_INVALID']) {
  test(`POST 403 ${code}: CSRF_REJECTED, aviso CSRF, nunca SESSION_EXPIRED`, async () => {
    installFetch(csrfOk(), json(403, { error: code }));
    const result = await postJsonWithCsrf(TARGET, {});
    assert.deepEqual(result, { ok: false, status: 403, data: { error: code }, failure: 'CSRF_REJECTED' });
    assert.deepEqual(notices, ['CSRF_REJECTED']);
  });
}

// 8
test('POST 403 ROLE_FORBIDDEN: se conserva tal cual, sin aviso', async () => {
  installFetch(csrfOk(), json(403, { error: 'ROLE_FORBIDDEN' }));
  const result = await postJsonWithCsrf(TARGET, {});
  assert.deepEqual(result, { ok: false, status: 403, data: { error: 'ROLE_FORBIDDEN' } });
  assert.deepEqual(notices, []);
});

// 9
test('POST con error de red: status 0, NETWORK_ERROR, aviso NETWORK, no lanza', async () => {
  installFetch(csrfOk(), networkFailure);
  const result = await postJsonWithCsrf(TARGET, {});
  assert.deepEqual(result, { ok: false, status: 0, data: { error: 'NETWORK_ERROR' }, failure: 'NETWORK_ERROR' });
  assert.equal(postCalls().length, 1);
  assert.deepEqual(notices, ['NETWORK_ERROR']);
});

// 10
for (const [status, code] of [[400, 'VALIDATION_ERROR'], [409, 'CICLO_YA_EN_CURSO'], [409, 'ORGANIZATION_REQUIRED']]) {
  test(`POST ${status} ${code} (negocio): contrato previo intacto, sin failure`, async () => {
    installFetch(csrfOk(), json(status, { error: code }));
    const result = await postJsonWithCsrf(TARGET, {});
    assert.deepEqual(result, { ok: false, status, data: { error: code } });
    assert.deepEqual(notices, []);
  });
}

// 11
test('POST 500 y 503: se conservan', async () => {
  installFetch(csrfOk(), json(500, { error: 'Error interno' }), csrfOk(), json(503, { error: 'Relay de Ganadería no disponible.' }));
  assert.deepEqual(await postJsonWithCsrf(TARGET, {}), { ok: false, status: 500, data: { error: 'Error interno' } });
  assert.deepEqual(await postJsonWithCsrf(TARGET, {}), { ok: false, status: 503, data: { error: 'Relay de Ganadería no disponible.' } });
  assert.deepEqual(notices, []);
});

// 12
test('POST 200 con body no JSON: data null', async () => {
  installFetch(csrfOk(), text(200, 'ok'));
  assert.deepEqual(await postJsonWithCsrf(TARGET, {}), { ok: true, status: 200, data: null });
});

// 13
test('cero reintentos: fetch se llama como máximo 2 veces en todos los escenarios de fallo', async () => {
  const scenarios = [
    [json(401, { error: 'SESSION_INVALID' })],
    [networkFailure],
    [json(500, {})],
    [csrfOk(), networkFailure],
    [csrfOk(), json(401, { error: 'SESSION_INVALID' })],
    [csrfOk(), json(403, { error: 'CSRF_INVALID' })],
    [csrfOk(), json(500, {})],
  ];
  for (const queue of scenarios) {
    calls = [];
    installFetch(...queue);
    await postJsonWithCsrf(TARGET, {});
    assert.ok(calls.length <= 2, `llamadas: ${calls.length}`);
    assert.ok(postCalls().length <= 1);
  }
});

test('exactamente 1 GET /csrf y 1 POST por invocación exitosa', async () => {
  installFetch(csrfOk(), json(200, {}));
  await postJsonWithCsrf(TARGET, {});
  assert.equal(calls.filter((c) => c.url === CSRF_URL).length, 1);
  assert.equal(postCalls().length, 1);
});

// 14
test('un X-CSRF-Token del caller (cualquier capitalización) NO reemplaza el token del servidor', async () => {
  installFetch(csrfOk(), json(200, {}));
  await postWithCsrf(TARGET, {
    body: 'x',
    headers: { 'X-CSRF-Token': 'forjado', 'x-csrf-token': 'forjado2', 'X-Otro': 'v' },
  });
  const headers = calls[1].init.headers;
  const csrfKeys = Object.keys(headers).filter((k) => k.toLowerCase() === 'x-csrf-token');
  assert.deepEqual(csrfKeys, ['X-CSRF-Token']);
  assert.equal(headers['X-CSRF-Token'], 'server-token');
  assert.equal(headers['X-Otro'], 'v');
});

test('body undefined se conserva: postWithCsrf sin body no envía body ni Content-Type', async () => {
  installFetch(csrfOk(), json(200, {}));
  await postWithCsrf(TARGET);
  assert.equal(calls[1].init.body, undefined);
  assert.deepEqual(calls[1].init.headers, { 'X-CSRF-Token': 'server-token' });
});

test('body undefined se conserva: postJsonWithCsrf(path, undefined) envía body undefined', async () => {
  installFetch(csrfOk(), json(200, {}));
  await postJsonWithCsrf(TARGET, undefined);
  assert.equal(calls[1].init.body, undefined);
});

test('body raw (archivo) se envía sin transformar con las cabeceras del caller', async () => {
  const blob = new Blob(['<kml/>']);
  installFetch(csrfOk(), json(200, {}));
  await postWithCsrf(TARGET, { body: blob, headers: { 'Content-Type': 'application/octet-stream', 'X-Potrero-File-Name': 'a.kml' } });
  assert.equal(calls[1].init.body, blob);
  assert.equal(calls[1].init.headers['Content-Type'], 'application/octet-stream');
  assert.equal(calls[1].init.headers['X-Potrero-File-Name'], 'a.kml');
  assert.equal(calls[1].init.headers['X-CSRF-Token'], 'server-token');
});

test('un listener que lanza no rompe el helper', async () => {
  const off = subscribeAuthNotice(() => {
    throw new Error('boom');
  });
  try {
    installFetch(json(401, { error: 'SESSION_INVALID' }));
    const result = await postJsonWithCsrf(TARGET, {});
    assert.equal(result.failure, 'SESSION_EXPIRED');
    assert.deepEqual(notices, ['SESSION_EXPIRED']);
  } finally {
    off();
  }
});

// 15
test('fetchCsrfToken: 200 devuelve el token', async () => {
  installFetch(csrfOk());
  assert.equal(await fetchCsrfToken(), 'server-token');
});

test('fetchCsrfToken: sigue lanzando CSRF_FETCH_FAILED_<status> con err.status y err.code', async () => {
  installFetch(json(401, { error: 'SESSION_REQUIRED' }));
  await assert.rejects(fetchCsrfToken(), (err) => {
    assert.equal(err.message, 'CSRF_FETCH_FAILED_401');
    assert.equal(err.status, 401);
    assert.equal(err.code, 'SESSION_REQUIRED');
    return true;
  });
});

test('fetchCsrfToken: no-ok sin body JSON -> err.code null', async () => {
  installFetch(text(502, 'bad gateway'));
  await assert.rejects(fetchCsrfToken(), (err) => err.message === 'CSRF_FETCH_FAILED_502' && err.status === 502 && err.code === null);
});

test('fetchCsrfToken: 200 sin csrfToken válido -> CSRF_TOKEN_MISSING', async () => {
  installFetch(json(200, { csrfToken: 42 }));
  await assert.rejects(fetchCsrfToken(), (err) => err.status === 200 && err.code === 'CSRF_TOKEN_MISSING');
});

test('fetchCsrfToken: error de red se propaga como TypeError nativo sin status', async () => {
  installFetch(networkFailure);
  await assert.rejects(fetchCsrfToken(), (err) => err instanceof TypeError && err.status === undefined);
});

// 17
test('getJsonWithSession: contrato idéntico al getJson previo', async () => {
  installFetch(json(200, { items: [] }));
  const result = await getJsonWithSession('/api/ganaderia/x');
  assert.deepEqual(result, { ok: true, status: 200, data: { items: [] } });
  assert.deepEqual(calls[0].init, { credentials: 'include' });
  assert.deepEqual(notices, []);
});

test('getJsonWithSession: 401 SESSION_* emite aviso y conserva {ok,status,data} sin failure', async () => {
  installFetch(json(401, { error: 'SESSION_INVALID' }));
  const result = await getJsonWithSession('/api/ganaderia/x');
  assert.deepEqual(result, { ok: false, status: 401, data: { error: 'SESSION_INVALID' } });
  assert.deepEqual(notices, ['SESSION_EXPIRED']);
});

test('getJsonWithSession: 404/500/no-JSON se conservan sin aviso', async () => {
  installFetch(json(404, { error: 'NOT_FOUND' }), json(500, { error: 'x' }), text(200, 'x'));
  assert.deepEqual(await getJsonWithSession('/a'), { ok: false, status: 404, data: { error: 'NOT_FOUND' } });
  assert.deepEqual(await getJsonWithSession('/a'), { ok: false, status: 500, data: { error: 'x' } });
  assert.deepEqual(await getJsonWithSession('/a'), { ok: true, status: 200, data: null });
  assert.deepEqual(notices, []);
});

test('getJsonWithSession: error de red SIGUE lanzando (compatibilidad con .catch de loaders)', async () => {
  installFetch(networkFailure);
  await assert.rejects(getJsonWithSession('/a'), TypeError);
  assert.deepEqual(notices, []);
});

// ---------------------------------------------------------------------
// SPRINT-3D10.5 F3b: performGanaderiaLogout -- nunca lanza, nunca emite
// avisos globales, sigue exigiendo CSRF cuando la sesión existe.
// ---------------------------------------------------------------------
const LOGOUT_URL = '/api/ganaderia/auth/logout';

test('logout 200: LOGGED_OUT, POST /auth/logout con CSRF + credentials include, sin body', async () => {
  installFetch(csrfOk(), json(200, { ok: true }));
  assert.equal(await performGanaderiaLogout(), 'LOGGED_OUT');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, CSRF_URL);
  assert.equal(calls[1].url, LOGOUT_URL);
  assert.deepEqual(calls[1].init, { method: 'POST', credentials: 'include', headers: { 'X-CSRF-Token': 'server-token' } });
  assert.deepEqual(notices, []);
});

for (const code of ['SESSION_REQUIRED', 'SESSION_INVALID']) {
  test(`logout con /csrf 401 ${code}: ALREADY_LOGGED_OUT, 0 POST, sin aviso`, async () => {
    installFetch(json(401, { error: code }));
    assert.equal(await performGanaderiaLogout(), 'ALREADY_LOGGED_OUT');
    assert.equal(calls.filter((c) => c.url === LOGOUT_URL).length, 0);
    assert.deepEqual(notices, []);
  });

  test(`logout con POST 401 ${code}: ALREADY_LOGGED_OUT, sin aviso`, async () => {
    installFetch(csrfOk(), json(401, { error: code }));
    assert.equal(await performGanaderiaLogout(), 'ALREADY_LOGGED_OUT');
    assert.deepEqual(notices, []);
  });
}

for (const code of ['CSRF_REQUIRED', 'CSRF_INVALID', 'ORIGIN_INVALID']) {
  test(`logout con POST 403 ${code}: CSRF_REJECTED (permanece autenticado), sin aviso`, async () => {
    installFetch(csrfOk(), json(403, { error: code }));
    assert.equal(await performGanaderiaLogout(), 'CSRF_REJECTED');
    assert.deepEqual(notices, []);
  });
}

test('logout con red caída en /csrf: NETWORK_ERROR, 0 POST', async () => {
  installFetch(networkFailure);
  assert.equal(await performGanaderiaLogout(), 'NETWORK_ERROR');
  assert.equal(calls.length, 1);
});

test('logout con red caída en el POST: NETWORK_ERROR, un solo POST (sin retry)', async () => {
  installFetch(csrfOk(), networkFailure);
  assert.equal(await performGanaderiaLogout(), 'NETWORK_ERROR');
  assert.equal(calls.filter((c) => c.url === LOGOUT_URL).length, 1);
  assert.deepEqual(notices, []);
});

for (const [label, queue] of [
  ['POST 500', () => [csrfOk(), json(500, { error: 'x' })]],
  ['POST 401 sin código de sesión', () => [csrfOk(), json(401, { error: 'OTRA' })]],
  ['POST 403 ROLE_FORBIDDEN', () => [csrfOk(), json(403, { error: 'ROLE_FORBIDDEN' })]],
  ['/csrf 500', () => [json(500, {})]],
  ['/csrf 401 sin código de sesión', () => [text(401, 'x')]],
  ['/csrf 200 sin token', () => [json(200, {})]],
]) {
  test(`logout con ${label}: FAILED, no lanza`, async () => {
    installFetch(...queue());
    assert.equal(await performGanaderiaLogout(), 'FAILED');
    assert.ok(calls.length <= 2);
  });
}
