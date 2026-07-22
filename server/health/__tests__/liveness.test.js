import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import express from 'express';

import { createLivenessHandler, createLivenessPayload } from '../liveness.js';
import { buildExpressCorsPolicy, createCorsMiddleware } from '../../security/corsPolicy.js';
import * as dbModule from '../../db.js';
import * as catastroxDbModule from '../../catastroxDb.js';

// LOTE-005 (ADR-012 §4/§5.1/§7/§90): pruebas de liveness / health de
// plataforma. Nunca abren red real ni PostgreSQL -- únicamente una app
// Express efímera en 127.0.0.1 con puerto 0 (asignado por el SO), cerrada
// al final de la suite. No se arranca server/index.js completo: se
// reconstruye una app mínima equivalente con los mismos middlewares
// relevantes (CORS + liveness), evitando montar routers de negocio,
// dotenv, getConfig() ni app.listen() reales.

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const livenessSource = readFileSync(path.resolve(__dirname, '../liveness.js'), 'utf8');
const indexSource = readFileSync(path.resolve(__dirname, '../../index.js'), 'utf8');

function buildTestApp(appEnv, allowedOrigins) {
  const app = express();
  const policy = buildExpressCorsPolicy({ appEnv, allowedOrigins });
  app.use(createCorsMiddleware(policy));
  app.get('/api/health/live', createLivenessHandler(appEnv));
  app.get('/api/other', (_req, res) => res.json({ ok: true, other: true }));
  return app;
}

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

let productionServer;
let productionBaseUrl;

before(async () => {
  const app = buildTestApp('production', ['https://agrogenomax.com', 'https://agrogenomax.co']);
  const started = await startServer(app);
  productionServer = started.server;
  productionBaseUrl = started.baseUrl;
});

after(async () => {
  await stopServer(productionServer);
});

describe('LOTE-005: server/health/liveness.js', () => {
  test('1. GET /api/health/live responde 200', async () => {
    const response = await fetch(`${productionBaseUrl}/api/health/live`);
    assert.equal(response.status, 200);
  });

  test('2. cuerpo contiene status: "ok"', async () => {
    const response = await fetch(`${productionBaseUrl}/api/health/live`);
    const body = await response.json();
    assert.equal(body.status, 'ok');
  });

  test('3. cuerpo contiene check: "liveness"', async () => {
    const response = await fetch(`${productionBaseUrl}/api/health/live`);
    const body = await response.json();
    assert.equal(body.check, 'liveness');
  });

  test('4. respuesta es JSON', async () => {
    const response = await fetch(`${productionBaseUrl}/api/health/live`);
    assert.ok(response.headers.get('content-type').includes('application/json'));
    await assert.doesNotReject(() => response.json());
  });

  test('5. incluye Cache-Control: no-store', async () => {
    const response = await fetch(`${productionBaseUrl}/api/health/live`);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  });

  test('6. no incluye secretos', async () => {
    const response = await fetch(`${productionBaseUrl}/api/health/live`);
    const body = await response.json();
    const serialized = JSON.stringify(body).toLowerCase();
    for (const forbidden of ['secret', 'password', 'token', 'key', 'credential']) {
      assert.ok(!serialized.includes(forbidden), `no debía incluir "${forbidden}"`);
    }
  });

  test('7. no incluye DATABASE_URL', async () => {
    const response = await fetch(`${productionBaseUrl}/api/health/live`);
    const serialized = JSON.stringify(await response.json());
    assert.ok(!serialized.includes('DATABASE_URL'));
    assert.ok(!serialized.includes('postgres://'));
  });

  test('8. no incluye CATASTROX_DATABASE_URL', async () => {
    const response = await fetch(`${productionBaseUrl}/api/health/live`);
    const serialized = JSON.stringify(await response.json());
    assert.ok(!serialized.includes('CATASTROX_DATABASE_URL'));
  });

  test('9. no incluye API_BACKEND_URL', async () => {
    const response = await fetch(`${productionBaseUrl}/api/health/live`);
    const serialized = JSON.stringify(await response.json());
    assert.ok(!serialized.includes('API_BACKEND_URL'));
  });

  test('10. no incluye stack trace', async () => {
    const response = await fetch(`${productionBaseUrl}/api/health/live`);
    const body = await response.json();
    assert.deepEqual(Object.keys(body).sort(), ['appEnv', 'check', 'status', 'timestamp'].sort());
    assert.equal('stack' in body, false);
  });

  test('11. no ejecuta getDbPool()', async () => {
    assert.equal(dbModule.__hasDbPoolForTests(), false);
    await fetch(`${productionBaseUrl}/api/health/live`);
    await fetch(`${productionBaseUrl}/api/health/live`);
    assert.equal(dbModule.__hasDbPoolForTests(), false);
  });

  test('12. no ejecuta getCatastroxDbPool()', async () => {
    assert.equal(catastroxDbModule.__hasCatastroxDbPoolForTests(), false);
    await fetch(`${productionBaseUrl}/api/health/live`);
    assert.equal(catastroxDbModule.__hasCatastroxDbPoolForTests(), false);
  });

  test('13. no ejecuta ninguna query SQL (liveness.js nunca importa db.js/catastroxDb.js)', () => {
    const importLines = livenessSource.split('\n').filter((line) => line.trim().startsWith('import '));
    assert.equal(importLines.length, 0, 'liveness.js no debería tener ningún import (módulo casi-puro)');
  });

  test('14. no ejecuta fetch', async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    const spiedFetch = (...args) => {
      calls += 1;
      return originalFetch(...args);
    };
    globalThis.fetch = spiedFetch;
    try {
      // Se usa un fetch "de prueba" (no espiado) para golpear el endpoint,
      // y se cuentan únicamente las llamadas que el propio handler pudiera
      // hacer -- el handler no tiene acceso a esta variable espiada, así
      // que cualquier incremento vendría exclusivamente del cliente HTTP
      // de la prueba, nunca del servidor.
      const response = await new Promise((resolve, reject) => {
        http.get(`${productionBaseUrl}/api/health/live`, resolve).on('error', reject);
      });
      response.resume();
      await new Promise((resolve) => response.on('end', resolve));
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal(calls, 0);
  });

  test('15. funciona con bases no configuradas en development/test', () => {
    const handlerCalls = [];
    const res = {
      setHeader: () => {},
      status(code) {
        handlerCalls.push(code);
        return this;
      },
      json(body) {
        handlerCalls.push(body);
      },
    };
    // Sin DATABASE_URL/CATASTROX_DATABASE_URL en este `source` -- el
    // handler ni siquiera los consulta.
    createLivenessHandler('development')({}, res);
    assert.equal(handlerCalls[0], 200);
    assert.equal(handlerCalls[1].status, 'ok');
  });

  test('16. una base simulada como caída no cambia el 200', async () => {
    // server/db.js real, sin getConfig() ejecutado en este proceso de
    // pruebas -- getDbPool() lanzaría CONFIG_NOT_VALIDATED si algo lo
    // invocara. El endpoint de liveness sigue respondiendo 200 porque
    // nunca lo invoca.
    assert.throws(() => dbModule.getDbPool());
    const response = await fetch(`${productionBaseUrl}/api/health/live`);
    assert.equal(response.status, 200);
  });

  test('17. no requiere Authorization', async () => {
    const response = await fetch(`${productionBaseUrl}/api/health/live`);
    assert.equal(response.status, 200);
  });

  test('18. solicitud sin Origin funciona', async () => {
    const response = await fetch(`${productionBaseUrl}/api/health/live`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  });

  test('19. Origin permitido recibe CORS correcto', async () => {
    const response = await fetch(`${productionBaseUrl}/api/health/live`, {
      headers: { Origin: 'https://agrogenomax.com' },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), 'https://agrogenomax.com');
    assert.notEqual(response.headers.get('access-control-allow-origin'), '*');
  });

  test('20. Origin rechazado se bloquea antes del handler', async () => {
    const response = await fetch(`${productionBaseUrl}/api/health/live`, {
      headers: { Origin: 'https://evil.example' },
    });
    assert.equal(response.status, 403);
    const body = await response.text();
    assert.ok(!body.includes('liveness'));
    assert.ok(!body.includes('"status":"ok"'));
  });

  test('21. Origin:null se bloquea', async () => {
    const response = await fetch(`${productionBaseUrl}/api/health/live`, {
      headers: { Origin: 'null' },
    });
    assert.equal(response.status, 403);
  });

  test('22. el handler no muta estado global', () => {
    const first = createLivenessPayload({ appEnv: 'production' });
    const second = createLivenessPayload({ appEnv: 'production' });
    assert.notEqual(first, second); // objetos distintos, no reutiliza/memoiza estado compartido
    assert.equal(first.status, second.status);
    assert.equal(first.check, second.check);
  });

  test('23. el payload es inmutable o se genera de forma segura', () => {
    const payload = createLivenessPayload({ appEnv: 'production' });
    assert.ok(Object.isFrozen(payload));
    assert.throws(() => {
      'use strict';
      payload.status = 'degraded';
    });
    assert.equal(payload.status, 'ok');
  });

  test('24. importarlo no crea pools', () => {
    assert.equal(dbModule.__hasDbPoolForTests(), false);
    assert.equal(catastroxDbModule.__hasCatastroxDbPoolForTests(), false);
  });

  test('25. el endpoint se registra antes de rutas de negocio', () => {
    const livenessIndex = indexSource.indexOf("app.get('/api/health/live'");
    const catastroxRouteIndex = indexSource.indexOf("app.use('/api/catastrox'");
    const prediosRouteIndex = indexSource.indexOf("app.use('/api/predios'");
    assert.ok(livenessIndex > -1, 'la ruta debe estar registrada en server/index.js');
    assert.ok(livenessIndex < catastroxRouteIndex);
    assert.ok(livenessIndex < prediosRouteIndex);
  });

  test('26. el endpoint no depende de rutas CatastroX', () => {
    const importLines = livenessSource.split('\n').filter((line) => line.trim().startsWith('import '));
    assert.ok(!importLines.some((line) => line.toLowerCase().includes('catastrox')));
  });

  test('27. el endpoint no depende de rutas Ganadería', () => {
    const importLines = livenessSource.split('\n').filter((line) => line.trim().startsWith('import '));
    assert.ok(!importLines.some((line) => /ganaderia|predio|animal/i.test(line)));
  });

  test('28. otros endpoints existentes no se rompen', async () => {
    const response = await fetch(`${productionBaseUrl}/api/other`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
  });

  test('29. configuración inválida sigue impidiendo arrancar el proceso antes del endpoint', () => {
    const getConfigCallIndex = indexSource.indexOf('appConfig = getConfig()');
    const livenessRegisterIndex = indexSource.indexOf("app.get('/api/health/live'");
    const processExitIndex = indexSource.indexOf('process.exit(1)');
    assert.ok(getConfigCallIndex > -1 && livenessRegisterIndex > -1 && processExitIndex > -1);
    assert.ok(getConfigCallIndex < livenessRegisterIndex);
    assert.ok(processExitIndex < livenessRegisterIndex);
  });

  test('30. el endpoint no constituye readiness', () => {
    const payload = createLivenessPayload({ appEnv: 'production' });
    for (const readinessField of ['checks', 'domains', 'database', 'postgis', 'ready']) {
      assert.equal(readinessField in payload, false);
    }
    // La diferencia con readiness debe quedar documentada en el módulo
    // (no solo implícita en el comportamiento).
    assert.ok(livenessSource.toLowerCase().includes('readiness'));
  });
});

describe('LOTE-005: staging/development también exponen liveness (no exclusivo de production)', () => {
  test('staging: GET /api/health/live responde 200 con appEnv=staging', async () => {
    const app = buildTestApp('staging', ['https://staging.agrogenomax.com']);
    const { server, baseUrl } = await startServer(app);
    try {
      const response = await fetch(`${baseUrl}/api/health/live`);
      const body = await response.json();
      assert.equal(response.status, 200);
      assert.equal(body.appEnv, 'staging');
    } finally {
      await stopServer(server);
    }
  });

  test('development: GET /api/health/live responde 200 con appEnv=development', async () => {
    const app = buildTestApp('development', ['http://localhost:5173', 'http://127.0.0.1:5173']);
    const { server, baseUrl } = await startServer(app);
    try {
      const response = await fetch(`${baseUrl}/api/health/live`);
      const body = await response.json();
      assert.equal(response.status, 200);
      assert.equal(body.appEnv, 'development');
    } finally {
      await stopServer(server);
    }
  });

  test('test: GET /api/health/live responde 200 con appEnv=test', async () => {
    const app = buildTestApp('test', []);
    const { server, baseUrl } = await startServer(app);
    try {
      const response = await fetch(`${baseUrl}/api/health/live`);
      const body = await response.json();
      assert.equal(response.status, 200);
      assert.equal(body.appEnv, 'test');
    } finally {
      await stopServer(server);
    }
  });
});
