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
import { CONFIGURACION_CALIDAD_REPRODUCCION, MENSAJE_ANALITICA_OCUPADA, MENSAJE_TIMEOUT_ANALITICA, MENSAJE_VOLUMEN_ANALITICA, crearSemaforoAnalitica, errorVolumenAnalitica } from '../../services/ganaderia/reproduccionAnalitica.js';
import { leerHistorialLimitado } from '../../services/ganaderia/reproduccionAnaliticaRepository.js';

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

  test('volumen excedido -> 422 funcional, sin conteos ni detalles técnicos', async () => {
    respuesta = errorVolumenAnalitica();
    const r = await get('/analitica');
    assert.equal(r.status, 422);
    assert.deepEqual(r.json, { error: 'ANALITICA_VOLUMEN_EXCEDIDO', message: MENSAJE_VOLUMEN_ANALITICA });
    assert.equal(r.cache, 'no-store');
    assert.doesNotMatch(r.text, /\d/);
    assert.doesNotMatch(r.text, /select|agx\.|count|stack|maxEventos/i);
  });

  test('fallo interno -> sin detalles de SQL ni stack al cliente', async () => {
    respuesta = new Error('select secreto from agx.reproduccion_eventos');
    const r = await get('/analitica');
    assert.equal(r.status, 500);
    assert.doesNotMatch(r.text, /secreto|reproduccion_eventos|at .*\.js/);
  });
});

describe('FASE 4D: concurrencia de /analitica (un servidor y un semáforo compartidos)', () => {
  const RESULTADO = { poblacion: { hembrasConEventos: 0 }, metricas: { M1: { total: 0 } } };

  // Repositorio con el COUNT y el historial reales de leerHistorialLimitado sobre
  // un cliente falso: registra cada consulta. `paso` controla cada entrada.
  async function conServidor(fn) {
    const estado = { entradas: 0, consultas: [], pasos: [], tablero: 0 };
    const semaforo = crearSemaforoAnalitica();
    const repo = {
      analiticaReproductiva: async (org, filtros, { hoy }) => {
        estado.entradas += 1;
        const paso = estado.pasos.shift() ?? {};
        if (paso.compuerta) await paso.compuerta;
        if (paso.falloAntes) throw paso.falloAntes;
        const client = {
          query: async (sql) => {
            const tipo = sql.includes('set_config') ? 'TIMEOUT' : sql.includes('count(*)') ? 'COUNT' : 'HISTORIAL';
            estado.consultas.push(tipo);
            if (paso.canceladaEn === tipo) {
              throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
            }
            return tipo === 'COUNT' ? { rows: [{ total: paso.total ?? 1 }] } : { rows: [] };
          },
        };
        await leerHistorialLimitado(client, filtros, { hoy, maxEventos: 100 });
        if (paso.falloDespues) throw paso.falloDespues; // p. ej. una excepción de plegado
        return RESULTADO;
      },
      resumenTableroReproductivo: async () => { estado.tablero += 1; return { hembrasEnSeguimiento: 0, porEstado: {}, porAlerta: {} }; },
      listarTableroReproductivo: async () => { estado.tablero += 1; return { total: 0, animales: [] }; },
    };
    const app = express();
    app.use(express.json());
    app.use('/api/ganaderia/reproduccion', createGanaderiaReproduccionRouter({
      appEnv: 'development', csrfServerSecret: TEST_CSRF_SECRET, allowedOrigins: [ALLOWED_ORIGIN], repo, fechaNegocio: () => HOY, semaforoAnalitica: semaforo,
    }));
    app.use(notFound);
    app.use(errorHandler);
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const rawToken = wireFakeSession(ORG_A, 'owner');
    const baseUrl = `http://127.0.0.1:${server.address().port}/api/ganaderia/reproduccion`;
    const llamar = async (path) => {
      const response = await fetch(`${baseUrl}${path}`, { headers: { Origin: ALLOWED_ORIGIN, Cookie: `${sessionCookieName('development')}=${rawToken}` } });
      const text = await response.text();
      return { status: response.status, text, json: JSON.parse(text), retryAfter: response.headers.get('retry-after'), cache: response.headers.get('cache-control') };
    };
    try {
      await fn({ estado, llamar, semaforo });
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  }

  function compuerta() {
    let soltar;
    const promesa = new Promise((resolve) => { soltar = resolve; });
    return { promesa, soltar };
  }

  async function hasta(condicion) {
    for (let i = 0; i < 500 && !condicion(); i += 1) await new Promise((resolve) => setTimeout(resolve, 2));
    assert.ok(condicion(), 'la primera petición no llegó al repositorio');
  }

  function assertOcupada(r) {
    assert.equal(r.status, 429);
    assert.deepEqual(r.json, { error: 'ANALITICA_OCUPADA', message: MENSAJE_ANALITICA_OCUPADA });
    assert.equal(r.retryAfter, '2');
    assert.equal(r.cache, 'no-store');
    assert.doesNotMatch(r.text, /\d|select|count|semaforo|enCurso|stack/i);
  }

  test('la primera entra; las siguientes reciben 429 sin COUNT ni historial; al terminar vuelve a entrar', async () => {
    await conServidor(async ({ estado, llamar, semaforo }) => {
      const puerta = compuerta();
      estado.pasos.push({ compuerta: puerta.promesa });
      const primera = llamar('/analitica');
      await hasta(() => estado.entradas === 1);

      assertOcupada(await llamar('/analitica'));
      // Un 429 no libera el cupo de la petición en curso.
      assertOcupada(await llamar('/analitica?predioId=7'));
      assert.equal(estado.entradas, 1);
      assert.deepEqual(estado.consultas, []);
      assert.equal(semaforo.enCurso, 1);

      puerta.soltar();
      assert.equal((await primera).status, 200);
      assert.deepEqual(estado.consultas, ['TIMEOUT', 'COUNT', 'HISTORIAL']); // solo los de la primera
      assert.equal(semaforo.enCurso, 0);

      assert.equal((await llamar('/analitica')).status, 200);
      assert.equal(estado.entradas, 2);
      assert.equal(semaforo.enCurso, 0);
    });
  });

  test('excepción antes de consultar y excepción de plegado: responde 500 y libera', async () => {
    await conServidor(async ({ estado, llamar, semaforo }) => {
      estado.pasos.push({ falloAntes: new Error('fallo de conexión secreto') });
      const antes = await llamar('/analitica');
      assert.equal(antes.status, 500);
      assert.doesNotMatch(antes.text, /secreto/);
      assert.equal(semaforo.enCurso, 0);

      estado.pasos.push({ falloDespues: new TypeError('plegado secreto') });
      const despues = await llamar('/analitica');
      assert.equal(despues.status, 500);
      assert.doesNotMatch(despues.text, /secreto/);
      assert.equal(semaforo.enCurso, 0);

      assert.equal((await llamar('/analitica')).status, 200);
    });
  });

  test('excepción con otra petición esperando: tras el fallo vuelve a entrar', async () => {
    await conServidor(async ({ estado, llamar }) => {
      const puerta = compuerta();
      estado.pasos.push({ compuerta: puerta.promesa, falloAntes: new Error('boom') });
      const primera = llamar('/analitica');
      await hasta(() => estado.entradas === 1);
      assertOcupada(await llamar('/analitica'));
      puerta.soltar();
      assert.equal((await primera).status, 500);
      assert.equal((await llamar('/analitica')).status, 200);
    });
  });

  test('ANALITICA_VOLUMEN_EXCEDIDO libera y no ejecuta la consulta pesada', async () => {
    await conServidor(async ({ estado, llamar, semaforo }) => {
      estado.pasos.push({ total: 101 });
      const r = await llamar('/analitica');
      assert.equal(r.status, 422);
      assert.equal(r.json.error, 'ANALITICA_VOLUMEN_EXCEDIDO');
      assert.deepEqual(estado.consultas, ['TIMEOUT', 'COUNT']);
      assert.equal(semaforo.enCurso, 0);
      assert.equal((await llamar('/analitica')).status, 200);
    });
  });

  test('statement_timeout en COUNT o historial: 503 seguro, libera y la siguiente entra', async () => {
    await conServidor(async ({ estado, llamar, semaforo }) => {
      for (const canceladaEn of ['COUNT', 'HISTORIAL']) {
        estado.pasos.push({ canceladaEn });
        const r = await llamar('/analitica');
        assert.equal(r.status, 503, canceladaEn);
        assert.deepEqual(r.json, { error: 'ANALITICA_TIMEOUT', message: MENSAJE_TIMEOUT_ANALITICA });
        assert.equal(r.cache, 'no-store');
        assert.doesNotMatch(r.text, /statement|cancel|select|agx\.|stack|\d/i);
        assert.equal(semaforo.enCurso, 0, canceladaEn);
        assert.equal((await llamar('/analitica')).status, 200, canceladaEn);
        assert.equal(semaforo.enCurso, 0, canceladaEn);
      }
    });
  });

  test('statement_timeout con otra petición rechazada mientras tanto: se recupera', async () => {
    await conServidor(async ({ estado, llamar, semaforo }) => {
      const puerta = compuerta();
      estado.pasos.push({ compuerta: puerta.promesa, canceladaEn: 'COUNT' });
      const primera = llamar('/analitica');
      await hasta(() => estado.entradas === 1);
      assertOcupada(await llamar('/analitica'));
      assert.equal(semaforo.enCurso, 1);
      puerta.soltar();
      assert.equal((await primera).status, 503);
      assert.equal(semaforo.enCurso, 0);
      assert.equal((await llamar('/analitica')).status, 200);
    });
  });

  test('/resumen y /animales no ajustan el timeout ni consultan por la analítica', async () => {
    await conServidor(async ({ estado, llamar }) => {
      assert.equal((await llamar('/resumen')).status, 200);
      assert.equal((await llamar('/animales')).status, 200);
      assert.equal(estado.tablero, 2);
      assert.equal(estado.entradas, 0);
      assert.deepEqual(estado.consultas, []);
    });
  });

  test('/resumen y /animales siguen funcionando mientras la analítica está ocupada', async () => {
    await conServidor(async ({ estado, llamar, semaforo }) => {
      const puerta = compuerta();
      estado.pasos.push({ compuerta: puerta.promesa });
      const primera = llamar('/analitica');
      await hasta(() => estado.entradas === 1);

      const resumen = await llamar('/resumen');
      assert.equal(resumen.status, 200);
      assert.equal(resumen.retryAfter, null);
      assert.equal((await llamar('/animales')).status, 200);
      assert.equal(estado.tablero, 2);
      assert.equal(semaforo.enCurso, 1); // el tablero no toma ni libera el cupo
      assertOcupada(await llamar('/analitica'));

      puerta.soltar();
      assert.equal((await primera).status, 200);
    });
  });

  test('una query inválida responde 400 sin tomar el cupo ni liberar el ajeno', async () => {
    await conServidor(async ({ estado, llamar, semaforo }) => {
      assert.equal((await llamar('/analitica?desde=ayer')).status, 400);
      assert.equal(semaforo.enCurso, 0);
      const puerta = compuerta();
      estado.pasos.push({ compuerta: puerta.promesa });
      const primera = llamar('/analitica');
      await hasta(() => estado.entradas === 1);
      assert.equal((await llamar('/analitica?desde=ayer')).status, 400);
      assert.equal(semaforo.enCurso, 1);
      assertOcupada(await llamar('/analitica'));
      puerta.soltar();
      assert.equal((await primera).status, 200);
    });
  });
});
