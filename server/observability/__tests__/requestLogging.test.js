import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { createRequestLogging, REQUEST_ID_HEADER } from '../requestLogging.js';

// LOTE-010 (ADR-012 §25): sin servidor real, sin base de datos -- únicamente
// objetos req/res simulados en memoria (res es un EventEmitter, como el
// `http.ServerResponse` real, para poder disparar 'finish'/'close').

const CANONICAL_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function fakeReq({ headers = {}, method = 'GET' } = {}) {
  return { headers, method };
}

function fakeRes({ statusCode = 200 } = {}) {
  const res = new EventEmitter();
  res.statusCode = statusCode;
  res.locals = {};
  res.headers = {};
  res.setHeader = (name, value) => {
    res.headers[name] = value;
  };
  return res;
}

function collectingSink() {
  const events = [];
  const sink = (event) => events.push(event);
  sink.events = events;
  return sink;
}

const ALLOWED_FIELDS = new Set(['timestamp', 'level', 'event', 'correlationId', 'method', 'statusCode', 'durationMs']);
const FORBIDDEN_SUBSTRINGS = [
  '/api/',
  'password',
  'bearer',
  'authorization',
  'cookie',
  'secret',
  '192.168',
  'mozilla',
  '4.6',
  '-74.1',
  'geometry',
  '<script>',
];

describe('LOTE-010: server/observability/requestLogging.js', () => {
  test('genera un correlationId único por solicitud cuando no llega X-Request-ID', () => {
    const sink = collectingSink();
    const middleware = createRequestLogging({ sink });

    const req1 = fakeReq();
    const res1 = fakeRes();
    let nextCalled1 = false;
    middleware(req1, res1, () => {
      nextCalled1 = true;
    });

    const req2 = fakeReq();
    const res2 = fakeRes();
    middleware(req2, res2, () => {});

    assert.equal(nextCalled1, true);
    assert.notEqual(req1.correlationId, req2.correlationId);
    assert.match(req1.correlationId, CANONICAL_UUID_PATTERN);
    assert.match(req2.correlationId, CANONICAL_UUID_PATTERN);
  });

  test('propaga un UUID canónico entrante como correlationId', () => {
    const sink = collectingSink();
    const middleware = createRequestLogging({ sink });
    const incoming = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
    const req = fakeReq({ headers: { 'x-request-id': incoming } });
    const res = fakeRes();

    middleware(req, res, () => {});

    assert.equal(req.correlationId, incoming);
    assert.equal(res.locals.correlationId, incoming);
    assert.equal(res.headers[REQUEST_ID_HEADER], incoming);
  });

  test('reemplaza entrada maliciosa/no-UUID por un UUID generado y no la registra', () => {
    const sink = collectingSink();
    const generated = '11111111-1111-4111-8111-111111111111';
    const middleware = createRequestLogging({ sink, generateId: () => generated });
    const malicious = '"; DROP TABLE users; -- <script>alert(1)</script>';
    const req = fakeReq({ headers: { 'x-request-id': malicious } });
    const res = fakeRes();

    middleware(req, res, () => {});
    res.emit('finish');

    assert.equal(req.correlationId, generated);
    assert.notEqual(req.correlationId, malicious);
    for (const event of sink.events) {
      const serialized = JSON.stringify(event);
      assert.equal(serialized.includes('DROP TABLE'), false);
      assert.equal(serialized.includes('<script>'), false);
      assert.equal(event.correlationId, generated);
    }
  });

  test('asigna header de respuesta, req.correlationId y res.locals.correlationId', () => {
    const sink = collectingSink();
    const middleware = createRequestLogging({ sink });
    const req = fakeReq();
    const res = fakeRes();

    middleware(req, res, () => {});

    assert.equal(typeof req.correlationId, 'string');
    assert.equal(res.locals.correlationId, req.correlationId);
    assert.equal(res.headers[REQUEST_ID_HEADER], req.correlationId);
  });

  test('emite request_started (JSON de una línea, parseable) al entrar', () => {
    const sink = collectingSink();
    const middleware = createRequestLogging({ sink });
    const req = fakeReq({ method: 'POST' });
    const res = fakeRes();

    middleware(req, res, () => {});

    assert.equal(sink.events.length, 1);
    const [event] = sink.events;
    const roundTrip = JSON.parse(JSON.stringify(event));
    assert.equal(roundTrip.event, 'request_started');
    assert.equal(roundTrip.level, 'info');
    assert.equal(roundTrip.method, 'POST');
    assert.equal(roundTrip.correlationId, req.correlationId);
    assert.equal(typeof roundTrip.timestamp, 'string');
    assert.equal(Number.isNaN(Date.parse(roundTrip.timestamp)), false);
  });

  test('emite request_completed en finish, no request_aborted', () => {
    const sink = collectingSink();
    const middleware = createRequestLogging({ sink });
    const req = fakeReq();
    const res = fakeRes({ statusCode: 201 });

    middleware(req, res, () => {});
    res.emit('finish');
    res.emit('close');

    const completed = sink.events.filter((e) => e.event === 'request_completed');
    const aborted = sink.events.filter((e) => e.event === 'request_aborted');
    assert.equal(completed.length, 1);
    assert.equal(aborted.length, 0);
    assert.equal(completed[0].statusCode, 201);
  });

  test('emite request_aborted si la conexión cierra antes de finish, sin duplicar', () => {
    const sink = collectingSink();
    const middleware = createRequestLogging({ sink });
    const req = fakeReq();
    const res = fakeRes();

    middleware(req, res, () => {});
    res.emit('close');
    res.emit('close');
    res.emit('finish');

    const aborted = sink.events.filter((e) => e.event === 'request_aborted');
    const completed = sink.events.filter((e) => e.event === 'request_completed');
    assert.equal(aborted.length, 1);
    assert.equal(completed.length, 0);
  });

  test('niveles: info 2xx/3xx, warn 4xx, error 5xx, warn aborted', () => {
    const cases = [
      { statusCode: 204, expectedLevel: 'info' },
      { statusCode: 301, expectedLevel: 'info' },
      { statusCode: 404, expectedLevel: 'warn' },
      { statusCode: 500, expectedLevel: 'error' },
    ];

    for (const { statusCode, expectedLevel } of cases) {
      const sink = collectingSink();
      const middleware = createRequestLogging({ sink });
      const req = fakeReq();
      const res = fakeRes({ statusCode });
      middleware(req, res, () => {});
      res.emit('finish');
      const [, completedEvent] = sink.events;
      assert.equal(completedEvent.level, expectedLevel, `status ${statusCode}`);
    }

    const sink = collectingSink();
    const middleware = createRequestLogging({ sink });
    const req = fakeReq();
    const res = fakeRes();
    middleware(req, res, () => {});
    res.emit('close');
    const [, abortedEvent] = sink.events;
    assert.equal(abortedEvent.level, 'warn');
  });

  test('duración: reloj monotónico inyectado, no negativa', () => {
    const sink = collectingSink();
    let tickNs = 0n;
    const now = () => {
      const value = tickNs;
      tickNs += 5_000_000n; // 5ms por llamada
      return value;
    };
    const middleware = createRequestLogging({ sink, now });
    const req = fakeReq();
    const res = fakeRes();

    middleware(req, res, () => {});
    res.emit('finish');

    const [, completedEvent] = sink.events;
    assert.equal(completedEvent.durationMs, 5);
    assert.equal(completedEvent.durationMs >= 0, true);
  });

  test('ningún evento contiene campos fuera de la lista permitida ni datos sensibles', () => {
    const sink = collectingSink();
    const middleware = createRequestLogging({ sink });
    const req = fakeReq({
      headers: {
        'x-request-id': '3fa85f64-5717-4562-b3fc-2c963f66afa6',
        authorization: 'Bearer secret-token-value',
        cookie: 'session=abc123',
        'user-agent': 'Mozilla/5.0',
      },
      method: 'GET',
    });
    req.url = '/api/animales?token=abc&lat=4.6&lon=-74.1';
    req.ip = '192.168.1.10';
    const res = fakeRes();

    middleware(req, res, () => {});
    res.emit('finish');

    assert.equal(sink.events.length, 2);
    for (const event of sink.events) {
      for (const key of Object.keys(event)) {
        assert.equal(ALLOWED_FIELDS.has(key), true, `campo no permitido: ${key}`);
      }
      const serialized = JSON.stringify(event).toLowerCase();
      for (const forbidden of FORBIDDEN_SUBSTRINGS) {
        assert.equal(serialized.includes(forbidden), false, `filtración de "${forbidden}" en ${serialized}`);
      }
    }
  });

  test('un sink que lanza no rompe la solicitud ni el flujo finish/close', () => {
    const throwingSink = () => {
      throw new Error('sink caído');
    };
    const middleware = createRequestLogging({ sink: throwingSink });
    const req = fakeReq();
    const res = fakeRes();
    let nextCalled = false;

    assert.doesNotThrow(() => {
      middleware(req, res, () => {
        nextCalled = true;
      });
    });
    assert.equal(nextCalled, true);
    assert.doesNotThrow(() => res.emit('finish'));
  });

  test('siempre invoca next()', () => {
    const sink = collectingSink();
    const middleware = createRequestLogging({ sink });
    const req = fakeReq();
    const res = fakeRes();
    let nextCalled = false;

    middleware(req, res, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, true);
  });

  test('server/index.js monta el middleware inmediatamente tras crear app y antes de CORS/json/health/rutas', () => {
    const indexPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../index.js');
    const source = readFileSync(indexPath, 'utf8');

    const appCreatedAt = source.indexOf('const app = express();');
    const requestLoggingImportAt = source.indexOf("from './observability/requestLogging.js'");
    const requestLoggingMountAt = source.indexOf('app.use(createRequestLogging())');
    const corsMountAt = source.indexOf('app.use(createCorsMiddleware(corsPolicy))');
    const jsonMountAt = source.indexOf('app.use(express.json(');
    const healthMountAt = source.indexOf("app.get('/api/health/live'");
    const firstBusinessRouteAt = source.indexOf("app.use('/api/health'");

    assert.notEqual(appCreatedAt, -1);
    assert.notEqual(requestLoggingImportAt, -1);
    assert.notEqual(requestLoggingMountAt, -1);
    assert.notEqual(corsMountAt, -1);
    assert.notEqual(jsonMountAt, -1);
    assert.notEqual(healthMountAt, -1);
    assert.notEqual(firstBusinessRouteAt, -1);

    assert.equal(requestLoggingMountAt > appCreatedAt, true);
    assert.equal(requestLoggingMountAt < corsMountAt, true);
    assert.equal(requestLoggingMountAt < jsonMountAt, true);
    assert.equal(requestLoggingMountAt < healthMountAt, true);
    assert.equal(requestLoggingMountAt < firstBusinessRouteAt, true);
  });
});
