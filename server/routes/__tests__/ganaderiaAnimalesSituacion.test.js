// FASE 2B: GET /api/ganaderia/animales?estadoOperativo= y GET
// /api/ganaderia/animales/resumen (servidor Express efímero real; sesión
// simulada; repositorio inyectado). El filtro real bajo RLS y la consulta
// agregada única: server/services/__tests__/animalCierreIntegration.test.js.
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import express from 'express';

import createGanaderiaAnimalesRouter from '../ganaderiaAnimales.js';
import { RESUMEN_ANIMALES_SQL } from '../../services/ganaderia/animalesRepository.js';
import { getAgxAuthPool, __resetAgxAuthPoolForTests } from '../../db/agxAuthPool.js';
import { hashSessionSecret, sessionCookieName } from '../../security/ganaderiaSession.js';
import { __resetAgxBusinessPoolForTests } from '../../db/agxBusinessPool.js';
import { getConfig, __resetValidationStateForTests } from '../../config/env.js';
import { errorHandler, notFound } from '../../middleware/errors.js';

const TEST_CSRF_SECRET = 'gwslZ1bKInXjQ0TLmMqWeV6vRAL2hONB6bTBqpAjVFs=';
const ALLOWED_ORIGIN = 'https://agrogenomax.com';
const FAKE_AUTH_CONNECTION_STRING = 'postgres://test:test@192.0.2.1:5432/never_connects';
const ORG_A = '00000000-0000-4000-8000-00000000000a';
const ORG_B = '00000000-0000-4000-8000-00000000000b';

const llamadas = { listar: [], resumir: [] };

before(() => {
  delete process.env.DATABASE_URL;
  delete process.env.AGX_BUSINESS_DATABASE_URL;
});

beforeEach(() => {
  __resetAgxAuthPoolForTests();
  __resetAgxBusinessPoolForTests();
  __resetValidationStateForTests();
  getConfig({ APP_ENV: 'development' }, {});
  llamadas.listar.length = 0;
  llamadas.resumir.length = 0;
});

function wireFakeSession(organizacionId, rol = 'lector') {
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

async function get(path, { org = ORG_A } = {}) {
  const rawToken = org ? wireFakeSession(org) : null;
  const app = express();
  app.use(express.json());
  app.use('/api/ganaderia/animales', createGanaderiaAnimalesRouter({
    appEnv: 'development',
    csrfServerSecret: TEST_CSRF_SECRET,
    allowedOrigins: [ALLOWED_ORIGIN],
    listar: async (organizacionId, filtros) => {
      llamadas.listar.push({ organizacionId, filtros });
      return { animales: [], total: 0 };
    },
    resumir: async (organizacionId) => {
      llamadas.resumir.push(organizacionId);
      return { hatoActual: 1, salidos: 1, muertos: 1 };
    },
  }));
  app.use(notFound);
  app.use(errorHandler);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    const headers = { Origin: ALLOWED_ORIGIN };
    if (rawToken) headers.Cookie = `${sessionCookieName('development')}=${rawToken}`;
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/ganaderia${path}`, { headers });
    return { status: response.status, json: await response.json().catch(() => null), cache: response.headers.get('cache-control') };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe('FASE 2B: listado por situación (estadoOperativo)', () => {
  test('default -> EN_HATO (y estado ACTIVO); tenant SOLO de la sesión', async () => {
    const r = await get(`/animales`);
    assert.equal(r.status, 200);
    assert.equal(llamadas.listar[0].organizacionId, ORG_A);
    assert.equal(llamadas.listar[0].filtros.estadoOperativo, 'EN_HATO');
    assert.equal(llamadas.listar[0].filtros.estado, 'ACTIVO');
  });

  test('SALIDO, MUERTO y TODOS se delegan tal cual; vacío = default', async () => {
    for (const valor of ['SALIDO', 'MUERTO', 'TODOS', 'EN_HATO']) {
      assert.equal((await get(`/animales?estadoOperativo=${valor}`)).status, 200, valor);
    }
    await get('/animales?estadoOperativo=');
    assert.deepEqual(llamadas.listar.map((l) => l.filtros.estadoOperativo), ['SALIDO', 'MUERTO', 'TODOS', 'EN_HATO', 'EN_HATO']);
  });

  test('ejes independientes: estado=ANULADO&estadoOperativo=SALIDO', async () => {
    await get('/animales?estado=ANULADO&estadoOperativo=SALIDO');
    assert.equal(llamadas.listar[0].filtros.estado, 'ANULADO');
    assert.equal(llamadas.listar[0].filtros.estadoOperativo, 'SALIDO');
  });

  test('valor inválido -> 400 INVALID_QUERY sin consultar', async () => {
    for (const valor of ['VENDIDO', 'en_hato', 'ACTIVO']) {
      const r = await get(`/animales?estadoOperativo=${valor}`);
      assert.equal(r.status, 400, valor);
      assert.equal(r.json.error, 'INVALID_QUERY');
    }
    assert.equal(llamadas.listar.length, 0);
  });

  test('sin sesión -> 401', async () => {
    assert.equal((await get('/animales?estadoOperativo=TODOS', { org: null })).status, 401);
    assert.equal(llamadas.listar.length, 0);
  });
});

describe('FASE 2B: GET /animales/resumen', () => {
  test('200 con contadores; organización de la sesión; no-store; no cae en /:animalId', async () => {
    const r = await get('/animales/resumen', { org: ORG_B });
    assert.equal(r.status, 200);
    assert.equal(r.cache, 'no-store');
    assert.deepEqual(r.json, { ok: true, resumen: { hatoActual: 1, salidos: 1, muertos: 1 } });
    assert.deepEqual(llamadas.resumir, [ORG_B]);
  });

  test('cualquier query (incluido organizacionId) -> 400; sin sesión -> 401', async () => {
    assert.equal((await get(`/animales/resumen?organizacionId=${ORG_B}`)).json.error, 'INVALID_QUERY');
    assert.equal((await get('/animales/resumen', { org: null })).status, 401);
    assert.equal(llamadas.resumir.length, 0);
  });

  test('UNA sola consulta agregada (count filter), sin listados', () => {
    assert.equal((RESUMEN_ANIMALES_SQL.match(/\bselect\b/gi) ?? []).length, 1);
    assert.match(RESUMEN_ANIMALES_SQL, /estado = 'ACTIVO' and a\.estado_operativo = 'EN_HATO'\)::int as hato_actual/);
    assert.match(RESUMEN_ANIMALES_SQL, /estado_operativo = 'SALIDO'\)::int as salidos/);
    assert.match(RESUMEN_ANIMALES_SQL, /estado_operativo = 'MUERTO'\)::int as muertos/);
    assert.doesNotMatch(RESUMEN_ANIMALES_SQL, /limit|offset|organizacion_id/i);
  });
});
