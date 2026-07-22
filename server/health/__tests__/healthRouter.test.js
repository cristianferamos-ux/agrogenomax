import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';

import createHealthRouter from '../../routes/health.js';

// LOTE-007 (ADR-012 §7/§35.A): integración del router real, en un proceso
// de pruebas donde getConfig() NUNCA se ejecuta -- por diseño, esto hace
// que getDbPool()/getCatastroxDbPool() (server/db.js, server/catastroxDb.js)
// fallen con ConfigurationError ANTES de construir cualquier pg.Pool real
// (assertConfigValidated(), corrección LOTE-002), así que ni siquiera un
// intento de conexión de red llega a producirse -- solo se verifica el
// cableado de autenticación/rutas/headers, nunca contra una base real.

function startServer(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

function stopServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

describe('LOTE-007: server/routes/health.js -- sin HEALTH_MONITOR_TOKEN configurado', () => {
  let server;
  let baseUrl;

  before(async () => {
    const app = express();
    app.use('/api/health', createHealthRouter({}));
    ({ server, baseUrl } = await startServer(app));
  });

  after(() => stopServer(server));

  test('GET /api/health/ (raíz) sigue público', async () => {
    const response = await fetch(`${baseUrl}/api/health/`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  });

  test('GET /api/health/ready responde 503 sin exponer detalle', async () => {
    const response = await fetch(`${baseUrl}/api/health/ready`, {
      headers: { Authorization: 'Bearer cualquier-cosa' },
    });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  });

  test('GET /api/health/ready/ganaderia responde 503 sin token configurado', async () => {
    const response = await fetch(`${baseUrl}/api/health/ready/ganaderia`);
    assert.equal(response.status, 503);
  });

  test('GET /api/health/db responde 503 sin token configurado', async () => {
    const response = await fetch(`${baseUrl}/api/health/db`);
    assert.equal(response.status, 503);
  });
});

describe('LOTE-007: server/routes/health.js -- con HEALTH_MONITOR_TOKEN configurado', () => {
  let server;
  let baseUrl;
  const token = 'token-de-prueba-no-real';

  before(async () => {
    const app = express();
    app.use('/api/health', createHealthRouter({ healthMonitorToken: token }));
    ({ server, baseUrl } = await startServer(app));
  });

  after(() => stopServer(server));

  test('GET /api/health/ (raíz) no exige Authorization', async () => {
    const response = await fetch(`${baseUrl}/api/health/`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  });

  test('GET /api/health/ready con esquema "bearer" en minúsculas también autentica', async () => {
    const response = await fetch(`${baseUrl}/api/health/ready`, {
      headers: { Authorization: `bearer ${token}` },
    });
    assert.equal(response.status, 503);
  });

  for (const routePath of ['/ready', '/ready/ganaderia', '/ready/catastrox', '/db']) {
    test(`GET /api/health${routePath} sin Authorization responde 401`, async () => {
      const response = await fetch(`${baseUrl}/api/health${routePath}`);
      assert.equal(response.status, 401);
      assert.equal(response.headers.get('cache-control'), 'no-store');
    });

    test(`GET /api/health${routePath} con Bearer incorrecto responde 401`, async () => {
      const response = await fetch(`${baseUrl}/api/health${routePath}`, {
        headers: { Authorization: 'Bearer token-incorrecto' },
      });
      assert.equal(response.status, 401);
    });

    test(`GET /api/health${routePath} con Bearer correcto pasa la autenticación (503 por config no validada, nunca 401)`, async () => {
      const response = await fetch(`${baseUrl}/api/health${routePath}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(response.status, 503);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const body = await response.json();
      const serialized = JSON.stringify(body).toLowerCase();
      for (const forbidden of ['password', 'econnrefused', 'stack', token.toLowerCase()]) {
        assert.ok(!serialized.includes(forbidden), `no debía incluir "${forbidden}"`);
      }
    });
  }
});
