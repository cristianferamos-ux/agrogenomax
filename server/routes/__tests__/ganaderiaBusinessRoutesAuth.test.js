import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import createPrediosRouter from '../predios.js';
import createPotrerosRouter from '../potreros.js';
import createAnimalesRouter from '../animales.js';
import createPesajesRouter from '../pesajes.js';
import createVacunacionesRouter from '../vacunaciones.js';
import createTratamientosRouter from '../tratamientos.js';
import createReproduccionRouter from '../reproduccion.js';
import createRazasRouter from '../razas.js';
import { __resetAgxAuthPoolForTests } from '../../db/agxAuthPool.js';
import { getConfig, __resetValidationStateForTests } from '../../config/env.js';
import { errorHandler, notFound } from '../../middleware/errors.js';

// FIX/GANADERIA-SPRINT-0-BUSINESS-AUTH §10.B: la auditoría "Organizaciones
// y QR" encontró que TODAS estas rutas de negocio legacy estaban montadas
// sin ningún middleware de autenticación. Esta prueba demuestra, para cada
// grupo, que una solicitud anónima recibe 401 SESSION_REQUIRED y nunca
// llega al handler de negocio (nunca intenta tocar DATABASE_URL/Postgres,
// que ni siquiera está configurado en este entorno de pruebas -- si el
// handler se hubiera ejecutado, habría fallado con 503, no con este 401
// limpio y específico).
//
// NO se prueba aquí el comportamiento CON sesión válida (ya cubierto de
// forma exhaustiva para QR en qr.test.js, incluyendo CSRF) -- el objetivo
// de este archivo es exclusivamente confirmar que el cierre del hallazgo
// crítico se aplicó a los 8 grupos restantes, sin duplicar innecesariamente
// la prueba de la puerta de identidad/CSRF ya cubierta en profundidad.

const TEST_CSRF_SECRET = 'gwslZ1bKInXjQ0TLmMqWeV6vRAL2hONB6bTBqpAjVFs=';
const ALLOWED_ORIGINS = Object.freeze(['https://agrogenomax.com']);
const ROUTER_CONFIG = Object.freeze({
  appEnv: 'development',
  csrfServerSecret: TEST_CSRF_SECRET,
  allowedOrigins: ALLOWED_ORIGINS,
});

before(() => {
  delete process.env.DATABASE_URL;
});

beforeEach(() => {
  __resetAgxAuthPoolForTests();
  __resetValidationStateForTests();
  getConfig({ APP_ENV: 'development' }, {});
});

function startApp(mountPath, createRouter) {
  const app = express();
  app.use(express.json());
  app.use(mountPath, createRouter(ROUTER_CONFIG));
  app.use(notFound);
  app.use(errorHandler);

  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}${mountPath}` });
    });
  });
}

async function closeApp(ctx) {
  if (ctx?.server) await new Promise((resolve) => ctx.server.close(resolve));
}

async function assertAnonymousGetRejected(mountPath, createRouter, path = '') {
  const ctx = await startApp(mountPath, createRouter);
  try {
    const response = await fetch(`${ctx.baseUrl}${path}`);
    assert.equal(response.status, 401, `${mountPath}${path} debía responder 401 sin sesión`);
    const body = await response.json();
    assert.equal(body.error, 'SESSION_REQUIRED');
  } finally {
    await closeApp(ctx);
  }
}

async function assertAnonymousPostRejected(mountPath, createRouter, path, payload) {
  const ctx = await startApp(mountPath, createRouter);
  try {
    const response = await fetch(`${ctx.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    assert.equal(response.status, 401, `POST ${mountPath}${path} debía responder 401 sin sesión`);
    const body = await response.json();
    assert.equal(body.error, 'SESSION_REQUIRED');
  } finally {
    await closeApp(ctx);
  }
}

describe('FIX/GANADERIA-SPRINT-0-BUSINESS-AUTH: rutas de negocio legacy exigen sesión', () => {
  test('predios: GET /api/predios sin sesión -> 401', async () => {
    await assertAnonymousGetRejected('/api/predios', createPrediosRouter);
  });

  test('predios: POST /api/predios sin sesión -> 401', async () => {
    await assertAnonymousPostRejected('/api/predios', createPrediosRouter, '', { nombre: 'Finca X' });
  });

  test('potreros: GET /api/potreros sin sesión -> 401', async () => {
    await assertAnonymousGetRejected('/api/potreros', createPotrerosRouter);
  });

  test('animales: GET /api/animales sin sesión -> 401', async () => {
    await assertAnonymousGetRejected('/api/animales', createAnimalesRouter);
  });

  test('animales: GET /api/animales/:id sin sesión -> 401', async () => {
    await assertAnonymousGetRejected('/api/animales', createAnimalesRouter, '/1');
  });

  test('animales: POST /api/animales sin sesión -> 401', async () => {
    await assertAnonymousPostRejected('/api/animales', createAnimalesRouter, '', { codigo_qr: 'AGX-000001' });
  });

  test('pesajes: GET /api/animales/:id/pesajes sin sesión -> 401', async () => {
    await assertAnonymousGetRejected('/api', createPesajesRouter, '/animales/1/pesajes');
  });

  test('pesajes: POST /api/pesajes sin sesión -> 401', async () => {
    await assertAnonymousPostRejected('/api', createPesajesRouter, '/pesajes', { animal_id: 1, peso_kg: 100 });
  });

  test('vacunaciones: GET /api/catalogo-vacunas sin sesión -> 401', async () => {
    await assertAnonymousGetRejected('/api', createVacunacionesRouter, '/catalogo-vacunas');
  });

  test('tratamientos: GET /api/tratamientos sin sesión -> 401', async () => {
    await assertAnonymousGetRejected('/api', createTratamientosRouter, '/tratamientos');
  });

  test('reproduccion: GET /api/reproduccion sin sesión -> 401', async () => {
    await assertAnonymousGetRejected('/api', createReproduccionRouter, '/reproduccion');
  });

  test('razas: GET /api/razas sin sesión -> 401', async () => {
    await assertAnonymousGetRejected('/api/razas', createRazasRouter);
  });
});
