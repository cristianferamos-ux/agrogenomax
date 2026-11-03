// FASE 4D: garantías HTTP de GET /api/ganaderia/reproduccion/analitica
// (servidor Express efímero real; sesión simulada; repositorio inyectado).
// RLS y datos reales: server/services/__tests__/reproduccionAnaliticaIntegration.test.js.
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import express from 'express';

import createGanaderiaReproduccionRouter from '../ganaderiaReproduccion.js';
import { getAgxAuthPool, __resetAgxAuthPoolForTests } from '../../db/agxAuthPool.js';
import { hashSessionSecret, sessionCookieName } from '../../security/ganaderiaSession.js';
import { __resetAgxBusinessPoolForTests } from '../../db/agxBusinessPool.js';
import { getConfig, __resetValidationStateForTests } from '../../config/env.js';
import { errorHandler, notFound } from '../../middleware/errors.js';
import { CONFIGURACION_CALIDAD_REPRODUCCION } from '../../services/ganaderia/reproduccionAnalitica.js';

const TEST_CSRF_SECRET = 'gwslZ1bKInXjQ0TLmMqWeV6vRAL2hONB6bTBqpAjVFs=';
const ALLOWED_ORIGIN = 'https://agrogenomax.com';
const FAKE_AUTH_CONNECTION_STRING = 'postgres://test:test@192.0.2.1:5432/never_connects';
const ORG_A = '00000000-0000-4000-8000-00000000000a';
const ORG_B = '00000000-0000-4000-8000-00000000000b';
const HOY = '2026-11-02';

const llamadas = [];
let respuesta = null;
const REPO = {
  analiticaReproductiva: async (...args) => {
    llamadas.push(args);
    if (respuesta instanceof Error) throw respuesta;
    return { poblacion: { hembrasConEventos: 0 }, metricas: { M1: { total: 0 } } };
  },
};

before(() => {
  delete process.env.DATABASE_URL;
  delete process.env.AGX_BUSINESS_DATABASE_URL;
});

beforeEach(() => {
  __resetAgxAuthPoolForTests();
  __resetAgxBusinessPoolForTests();
  __resetValidationStateForTests();
  getConfig({ APP_ENV: 'development' }, {});
  llamadas.length = 0;
  respuesta = null;
});

function startApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/ganaderia/reproduccion', createGanaderiaReproduccionRouter({
    appEnv: 'development', csrfServerSecret: TEST_CSRF_SECRET, allowedOrigins: [ALLOWED_ORIGIN], repo: REPO, fechaNegocio: () => HOY,
  }));
  app.use(notFound);
  app.use(errorHandler);
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}/api/ganaderia/reproduccion` }));
  });
}

function wireFakeSession(organizacionId, rol) {
  const rawToken = crypto.randomBytes(32).toString('base64url');
  const tokenHash = hashSessionSecret(rawToken);
  const pool = getAgxAuthPool({ AGX_AUTH_DATABASE_URL: FAKE_AUTH_CONNECTION_STRING });
  pool.query = async (text, params = []) => {
    if (text.includes('from agx.sesiones s') && params[0] === tokenHash) {
      return { rows: [{ sesion_id: 's', cuenta_id: 'cuenta-1', organizacion_id: organizacionId, fecha_expiracion: new Date(Date.now() + 60_000).toISOString(), fecha_revocacion: null, cuenta_estado: 'activa', email: 't@example.com', nombre: 'T' }] };
    }
    if (text.includes('fn_resolver_autorizacion_sesion') && params[0] === tokenHash) {
      return { rows: [{ sesion_id: 's', cuenta_id: 'cuenta-1', organizacion_id: organizacionId, rol }] };
    }
    return { rows: [] };
  };
  return rawToken;
}

async function get(path, { org = ORG_A, rol = 'owner', headers: extra = {} } = {}) {
  const rawToken = org ? wireFakeSession(org, rol) : null;
  const ctx = await startApp();
  try {
    const headers = { Origin: ALLOWED_ORIGIN, ...extra };
    if (rawToken) headers.Cookie = `${sessionCookieName('development')}=${rawToken}`;
    const response = await fetch(`${ctx.baseUrl}${path}`, { headers });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    return { status: response.status, json, text, cache: response.headers.get('cache-control') };
  } finally {
    await new Promise((resolve) => ctx.server.close(resolve));
  }
}

describe('FASE 4D: GET /analitica', () => {
  test('sin sesión -> 401 sin tocar el repositorio', async () => {
    assert.equal((await get('/analitica', { org: null })).status, 401);
    assert.equal(llamadas.length, 0);
  });

  test('los 4 roles leen sin CSRF; respuesta sin caché', async () => {
    for (const rol of ['owner', 'admin', 'operador', 'lector']) {
      const r = await get('/analitica', { rol });
      assert.equal(r.status, 200, rol);
      assert.equal(r.cache, 'no-store');
    }
  });

  test('por defecto: ventana móvil de 12 meses, configuración y muestra mínima', async () => {
    const r = await get('/analitica');
    assert.deepEqual(r.json.periodo, { desde: '2025-11-03', hasta: HOY });
    assert.equal(r.json.fecha, HOY);
    assert.equal(r.json.muestraMinima, 10);
    assert.deepEqual(r.json.configuracion, { ...CONFIGURACION_CALIDAD_REPRODUCCION });
    assert.deepEqual(llamadas[0], [ORG_A, { predioId: null, desde: '2025-11-03', hasta: HOY }, { hoy: HOY }]);
  });

  test('tenant siempre de la sesión: organizacionId en query -> 400 y en header se ignora', async () => {
    const q = await get(`/analitica?organizacionId=${ORG_B}`);
    assert.equal(q.status, 400);
    assert.equal(q.json.error, 'INVALID_QUERY');
    assert.equal(llamadas.length, 0);
    await get('/analitica', { headers: { 'X-Organizacion-Id': ORG_B } });
    assert.equal(llamadas[0][0], ORG_A);
  });

  test('filtros válidos e inválidos', async () => {
    await get('/analitica?predioId=7&desde=2026-01-01&hasta=2026-06-30');
    assert.deepEqual(llamadas[0][1], { predioId: '7', desde: '2026-01-01', hasta: '2026-06-30' });
    llamadas.length = 0;
    for (const qs of ['desde=2026-13-01', 'hasta=2026-11-03', 'desde=2026-06-30&hasta=2026-01-01', 'predioId=abc', 'desde=ayer', 'desde=2026-01-01&desde=2026-02-01']) {
      const r = await get(`/analitica?${qs}`);
      assert.equal(r.status, 400, qs);
      assert.equal(r.json.error, 'INVALID_QUERY', qs);
    }
    assert.equal(llamadas.length, 0);
  });

  test('fallo interno -> sin detalles de SQL ni stack al cliente', async () => {
    respuesta = new Error('select secreto from agx.reproduccion_eventos');
    const r = await get('/analitica');
    assert.equal(r.status, 500);
    assert.doesNotMatch(r.text, /secreto|reproduccion_eventos|at .*\.js/);
  });
});
