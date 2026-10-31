// FASE 3B: correlationId + logging estructurado/redactado de errores, de
// punta a punta sobre un Express efímero real (requestLogging -> rutas ->
// notFound -> errorHandler). Sin base de datos.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import { createRequestLogging, REQUEST_ID_HEADER } from '../requestLogging.js';
import { createErrorHandler, buildErrorLogEvent, notFound } from '../../middleware/errors.js';

const QR_TOKEN = 'aB3_-xYz09QwErTyUiOpAsDfGhJkLzXc';
const ORG = '00000000-0000-4000-8000-000000000001';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SECRETS = [QR_TOKEN, 'Bearer health-monitor-secret', 'health-monitor-secret', 's3ss10n', 'csrf-value', 'secreto123', 'postgres://', 'SELECT', 'violates'];

let ctx;
const requestEvents = [];
const errorEvents = [];

function startApp() {
  const app = express();
  app.use(createRequestLogging({ sink: (e) => requestEvents.push(e) }));
  app.use(express.json());
  app.post('/api/ganaderia/qr/token/:token', (_req, _res, next) => {
    next(Object.assign(new Error(`SELECT * FROM qr_chapeta_tokens WHERE token_hash = '${QR_TOKEN}' -- password=secreto123`), {
      code: '23505', detail: 'violates unique constraint', status: 500,
    }));
  });
  app.get('/api/ganaderia/animales/:animalId/boom', (req, _res, next) => {
    req.ganaderiaAuth = { organizacionId: ORG, cuentaId: 'cuenta-1', rawToken: 's3ss10n' };
    next(new Error('pg: connection to postgres://agx:pw@10.0.0.5/db failed'));
  });
  app.post('/conflicto', (_req, _res, next) => next(Object.assign(new Error('El registro ya existe'), { status: 409 })));
  app.get('/prohibido', (_req, _res, next) => next(Object.assign(new Error('No autorizado'), { status: 403 })));
  app.use(notFound);
  app.use(createErrorHandler({ sink: (e) => errorEvents.push(e) }));
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

function sensitiveHeaders(extra = {}) {
  return {
    Authorization: 'Bearer health-monitor-secret',
    Cookie: `__Host-agx_session=s3ss10n; __Secure-agx_qr_pendiente=${QR_TOKEN}`,
    'X-CSRF-Token': 'csrf-value',
    Referer: `https://agrogenomax.com/qr/${QR_TOKEN}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

function assertNoSecrets(value, label) {
  const serialized = JSON.stringify(value);
  for (const secret of SECRETS) assert.ok(!serialized.includes(secret), `${label}: filtra ${secret}`);
}

describe('FASE 3B: correlationId y logging estructurado de errores', () => {
  before(async () => { ctx = await startApp(); });
  after(() => new Promise((resolve) => ctx.server.close(resolve)));

  test('correlationId generado (UUID aleatorio) y devuelto en X-Request-ID', async () => {
    const a = await fetch(`${ctx.base}/no-existe`);
    const b = await fetch(`${ctx.base}/no-existe`);
    const idA = a.headers.get(REQUEST_ID_HEADER);
    const idB = b.headers.get(REQUEST_ID_HEADER);
    assert.match(idA, UUID_RE);
    assert.match(idB, UUID_RE);
    assert.notEqual(idA, idB, 'no secuencial ni repetido');
  });

  test('X-Request-ID seguro (UUID) se acepta; inválido se reemplaza', async () => {
    const seguro = '4612e456-7890-4abc-8def-740987654321';
    const ok = await fetch(`${ctx.base}/no-existe`, { headers: { 'X-Request-ID': seguro } });
    assert.equal(ok.headers.get(REQUEST_ID_HEADER), seguro);
    for (const malo of ['1', '../../etc', `${QR_TOKEN}`, '<script>', 'a'.repeat(200), `${seguro}\r\nX-Evil: 1`.replace(/\r\n.*/, ' x')]) {
      const r = await fetch(`${ctx.base}/no-existe`, { headers: { 'X-Request-ID': malo } });
      const id = r.headers.get(REQUEST_ID_HEADER);
      assert.match(id, UUID_RE, malo);
      assert.notEqual(id, malo);
    }
  });

  test('500: mensaje genérico + code + correlationId (= X-Request-ID); sin stack, SQL, constraint ni rutas de archivo', async () => {
    errorEvents.length = 0;
    const r = await fetch(`${ctx.base}/api/ganaderia/qr/token/${QR_TOKEN}`, { method: 'POST', headers: sensitiveHeaders(), body: JSON.stringify({ token: QR_TOKEN, password: 'secreto123' }) });
    assert.equal(r.status, 500);
    const body = await r.json();
    assert.deepEqual(Object.keys(body).sort(), ['code', 'correlationId', 'error']);
    assert.equal(body.code, 'INTERNAL_ERROR');
    assert.equal(body.correlationId, r.headers.get(REQUEST_ID_HEADER));
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assertNoSecrets(body, 'body 500');
    assert.doesNotMatch(JSON.stringify(body), /\.js|node_modules|at |23505|qr_chapeta/);
  });

  test('log 5xx: correlationId, método, ruta LÓGICA, status, errorCode; sin token, body, cabeceras ni mensaje', async () => {
    errorEvents.length = 0;
    const r = await fetch(`${ctx.base}/api/ganaderia/qr/token/${QR_TOKEN}?token=${QR_TOKEN}`, { method: 'POST', headers: sensitiveHeaders(), body: JSON.stringify({ token: QR_TOKEN }) });
    assert.equal(errorEvents.length, 1);
    const [e] = errorEvents;
    assert.equal(e.level, 'error');
    assert.equal(e.event, 'request_error');
    assert.equal(e.correlationId, r.headers.get(REQUEST_ID_HEADER));
    assert.equal(e.method, 'POST');
    assert.equal(e.route, '/api/ganaderia/qr/token/:token');
    assert.equal(e.status, 500);
    assert.equal(e.errorCode, '23505');
    assert.match(e.timestamp, /^\d{4}-\d{2}-\d{2}T/);
    assertNoSecrets(e, 'evento de error');
    assertNoSecrets(requestEvents, 'eventos de request');
  });

  test('log 5xx con sesión: organizacionId y animalId (de la propia sesión); nunca rawToken ni conexión', async () => {
    errorEvents.length = 0;
    await fetch(`${ctx.base}/api/ganaderia/animales/42/boom`, { headers: sensitiveHeaders() });
    const [e] = errorEvents;
    assert.equal(e.organizacionId, ORG);
    assert.equal(e.animalId, '42');
    assert.equal(e.route, '/api/ganaderia/animales/:animalId/boom');
    assert.equal(e.cuentaId, undefined);
    assertNoSecrets(e, 'evento con sesión');
    assert.ok(!JSON.stringify(e).includes('10.0.0.5'));
  });

  test('409 esperado: info, no se registra como error severo; 403: warn; 4xx sin correlationId en el body', async () => {
    errorEvents.length = 0;
    const c = await fetch(`${ctx.base}/conflicto`, { method: 'POST' });
    assert.equal(c.status, 409);
    assert.deepEqual(await c.json(), { error: 'El registro ya existe' });
    const p = await fetch(`${ctx.base}/prohibido`);
    assert.equal(p.status, 403);
    assert.deepEqual(errorEvents.map((e) => [e.status, e.level, e.event]), [
      [409, 'info', 'request_client_error'],
      [403, 'warn', 'request_client_error'],
    ]);
  });

  test('sink por defecto: 5xx a stderr (console.error), 4xx a stdout (console.log), JSON de una línea', () => {
    const originalError = console.error;
    const originalLog = console.log;
    const errs = [];
    const logs = [];
    console.error = (...a) => errs.push(a);
    console.log = (...a) => logs.push(a);
    try {
      const handler = createErrorHandler();
      const res = { headersSent: false, setHeader() {}, status() { return this; }, json() { return this; } };
      handler(Object.assign(new Error('x'), { status: 409 }), { method: 'POST' }, res, () => {});
      handler(new Error(`boom ${QR_TOKEN}`), { method: 'GET', originalUrl: `/qr/${QR_TOKEN}` }, res, () => {});
    } finally {
      console.error = originalError;
      console.log = originalLog;
    }
    assert.equal(logs.length, 1);
    assert.equal(errs.length, 1);
    const evento = JSON.parse(errs[0][0]);
    assert.equal(evento.route, '/qr/[REDACTED]');
    assert.ok(!errs[0][0].includes(QR_TOKEN));
    assert.ok(!errs[0][0].includes('\n'));
  });

  test('buildErrorLogEvent: correlationId u organización con forma inválida no se registran', () => {
    const e = buildErrorLogEvent(new Error('x'), {
      correlationId: 'no-uuid', method: 'GET', ganaderiaAuth: { organizacionId: 'org; DROP' }, params: { animalId: '1' },
    }, 500);
    assert.equal(e.correlationId, undefined);
    assert.equal(e.organizacionId, undefined);
    assert.equal(e.animalId, undefined, 'sin organización válida no se registra animalId');
  });
});
