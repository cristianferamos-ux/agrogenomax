// FASE 4A: garantías HTTP de /api/ganaderia/animales/:animalId/reproduccion
// (servidor Express efímero real; sesión simulada; repositorio inyectado).
// RLS, transacciones, idempotencia, anulación y concurrencia reales:
// server/services/__tests__/reproduccionIntegration.test.js.
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import express from 'express';

import createGanaderiaAnimalReproduccionRouter from '../ganaderiaAnimalReproduccion.js';
import { getAgxAuthPool, __resetAgxAuthPoolForTests } from '../../db/agxAuthPool.js';
import { computeCsrfToken, hashSessionSecret, sessionCookieName } from '../../security/ganaderiaSession.js';
import { __resetAgxBusinessPoolForTests } from '../../db/agxBusinessPool.js';
import { getConfig, __resetValidationStateForTests } from '../../config/env.js';
import { errorHandler, notFound } from '../../middleware/errors.js';

const TEST_CSRF_SECRET = 'gwslZ1bKInXjQ0TLmMqWeV6vRAL2hONB6bTBqpAjVFs=';
const ALLOWED_ORIGIN = 'https://agrogenomax.com';
const FAKE_AUTH_CONNECTION_STRING = 'postgres://test:test@192.0.2.1:5432/never_connects';
const ORG_A = '00000000-0000-4000-8000-00000000000a';
const ORG_B = '00000000-0000-4000-8000-00000000000b';
const OP_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const CELO = Object.freeze({ tipoEvento: 'CELO_OBSERVADO', fechaEvento: '2026-10-01', clientOperationId: OP_ID });
const ANULAR = Object.freeze({ motivo: 'Registro duplicado', clientOperationId: OP_ID });

const llamadas = [];
let respuesta = null;
function metodo(nombre) {
  return async (...args) => {
    llamadas.push({ nombre, args });
    if (respuesta instanceof Error) throw respuesta;
    return respuesta ?? { evento: { eventoId: '9' }, estado: { estado: 'CICLANDO' }, yaExistia: false };
  };
}
const REPO = {
  obtenerReproduccionAnimal: metodo('obtenerReproduccionAnimal'),
  obtenerEstadoReproductivo: metodo('obtenerEstadoReproductivo'),
  registrarEventoReproductivoIdempotente: metodo('registrar'),
  anularEventoReproductivoIdempotente: metodo('anular'),
  corregirEventoReproductivoIdempotente: metodo('corregir'),
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
  app.use('/api/ganaderia/animales/:animalId/reproduccion', createGanaderiaAnimalReproduccionRouter({
    appEnv: 'development', csrfServerSecret: TEST_CSRF_SECRET, allowedOrigins: [ALLOWED_ORIGIN], repo: REPO,
  }));
  app.use(notFound);
  app.use(errorHandler);
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}/api/ganaderia` }));
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

async function call(method, path, body, { org = ORG_A, rol = 'owner', csrf = 'valid', headers: extra = {} } = {}) {
  const rawToken = org ? wireFakeSession(org, rol) : null;
  const ctx = await startApp();
  try {
    const headers = { 'Content-Type': 'application/json', Origin: ALLOWED_ORIGIN, ...extra };
    if (rawToken) headers.Cookie = `${sessionCookieName('development')}=${rawToken}`;
    if (rawToken && csrf === 'valid') headers['X-CSRF-Token'] = computeCsrfToken(rawToken, TEST_CSRF_SECRET);
    const response = await fetch(`${ctx.baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    return { status: response.status, json, text, cache: response.headers.get('cache-control') };
  } finally {
    await new Promise((resolve) => ctx.server.close(resolve));
  }
}

const P = '/animales/7/reproduccion';

describe('FASE 4E.1: identidadEsperada en POST /eventos', () => {
  const PROPIA = Object.freeze({ cuentaId: 'cuenta-1', organizacionId: ORG_A });

  test('coincide: registra como la sesión; el campo no llega a la validación ni al repositorio', async () => {
    const res = await call('POST', `${P}/eventos`, { ...CELO, identidadEsperada: PROPIA });
    assert.equal(res.status, 201);
    assert.equal(llamadas.length, 1);
    const [org, animalId, value, contexto] = llamadas[0].args;
    assert.equal(org, ORG_A);
    assert.equal(animalId, '7');
    assert.equal('identidadEsperada' in value, false);
    assert.equal(contexto.actorCuentaId, 'cuenta-1');
  });

  test('la autoría sale solo de la sesión: el cliente no puede declarar registrado_por', async () => {
    for (const campo of ['registrado_por', 'registradoPor', 'actorCuentaId', 'cuentaId']) {
      const res = await call('POST', `${P}/eventos`, { ...CELO, identidadEsperada: PROPIA, [campo]: 'cuenta-2' });
      assert.equal(res.status, 400, campo);
      assert.equal(res.json.error, 'FORBIDDEN_FIELDS', campo);
    }
    assert.equal(llamadas.length, 0);
  });

  test('misma operación con y sin el campo: valor idéntico (no altera el intent_hash)', async () => {
    await call('POST', `${P}/eventos`, { ...CELO, identidadEsperada: PROPIA });
    await call('POST', `${P}/eventos`, CELO);
    assert.deepEqual(llamadas[0].args[2], llamadas[1].args[2]);
  });

  test('otra cuenta de la misma organización: 409 sin tocar el repositorio', async () => {
    const res = await call('POST', `${P}/eventos`, { ...CELO, identidadEsperada: { cuentaId: 'cuenta-2', organizacionId: ORG_A } });
    assert.equal(res.status, 409);
    assert.equal(res.json.error, 'IDENTIDAD_NO_COINCIDE');
    assert.equal(llamadas.length, 0);
  });

  test('otra organización: 409 sin tocar el repositorio', async () => {
    const res = await call('POST', `${P}/eventos`, { ...CELO, identidadEsperada: { cuentaId: 'cuenta-1', organizacionId: ORG_B } });
    assert.equal(res.status, 409);
    assert.equal(llamadas.length, 0);
  });

  test('la respuesta no revela la identidad de la sesión', async () => {
    const res = await call('POST', `${P}/eventos`, { ...CELO, identidadEsperada: { cuentaId: 'cuenta-2', organizacionId: ORG_A } });
    assert.doesNotMatch(res.text, /cuenta-1|cuenta-2/);
    assert.doesNotMatch(res.text, new RegExp(ORG_A));
  });

  test('el rol sigue siendo lo primero: un lector de otra cuenta recibe 403 y nada se escribe', async () => {
    const res = await call('POST', `${P}/eventos`, { ...CELO, identidadEsperada: { cuentaId: 'cuenta-2', organizacionId: ORG_A } }, { rol: 'lector' });
    assert.equal(res.status, 403);
    assert.equal(res.json.error, 'ROLE_FORBIDDEN');
    assert.equal(llamadas.length, 0);
  });

  test('con la identidad correcta el rol sigue aplicando', async () => {
    const res = await call('POST', `${P}/eventos`, { ...CELO, identidadEsperada: PROPIA }, { rol: 'lector' });
    assert.equal(res.status, 403);
    assert.equal(res.json.error, 'ROLE_FORBIDDEN');
    assert.equal(llamadas.length, 0);
  });

  test('sesión y CSRF siguen antes que la identidad', async () => {
    assert.equal((await call('POST', `${P}/eventos`, { ...CELO, identidadEsperada: PROPIA }, { org: null })).status, 401);
    assert.equal((await call('POST', `${P}/eventos`, { ...CELO, identidadEsperada: PROPIA }, { csrf: 'none' })).status, 403);
    assert.equal(llamadas.length, 0);
  });

  test('forma inválida: 400 sin tocar el repositorio', async () => {
    for (const identidadEsperada of [null, 'x', [], {}, { cuentaId: 'cuenta-1' }, { cuentaId: 1, organizacionId: ORG_A }, { ...PROPIA, extra: 1 }, { cuentaId: 'c'.repeat(65), organizacionId: ORG_A }]) {
      const res = await call('POST', `${P}/eventos`, { ...CELO, identidadEsperada });
      assert.equal(res.status, 400, JSON.stringify(identidadEsperada));
      assert.equal(res.json.error, 'INVALID_IDENTIDAD_ESPERADA');
    }
    assert.equal(llamadas.length, 0);
  });

  test('sin el campo: el registro online no cambia', async () => {
    assert.equal((await call('POST', `${P}/eventos`, CELO)).status, 201);
    assert.equal(llamadas.length, 1);
  });

});

describe('FASE 4E.2A: identidadEsperada en anular y corregir', () => {
  const PROPIA = Object.freeze({ cuentaId: 'cuenta-1', organizacionId: ORG_A });
  const CASOS = Object.freeze([
    { accion: 'anular', repo: 'anular', cuerpo: ANULAR, exito: 200 },
    { accion: 'corregir', repo: 'corregir', cuerpo: { motivo: 'Dato erróneo', clientOperationId: OP_ID, evento: { tipoEvento: 'CELO_OBSERVADO', fechaEvento: '2026-10-01' } }, exito: 201 },
  ]);

  for (const { accion, repo, cuerpo, exito } of CASOS) {
    const ruta = `${P}/eventos/3/${accion}`;
    describe(accion, () => {
      test('cliente sin el campo: mismo estado, cuerpo y repositorio', async () => {
        const res = await call('POST', ruta, cuerpo);
        assert.equal(res.status, exito);
        assert.equal(res.json.ok, true);
        assert.deepEqual(llamadas.map((l) => l.nombre), [repo]);
      });

      test('coincide: la validación y el repositorio reciben exactamente lo mismo que sin el campo', async () => {
        const conCampo = await call('POST', ruta, { ...cuerpo, identidadEsperada: PROPIA });
        const sinCampo = await call('POST', ruta, cuerpo);
        assert.equal(conCampo.status, exito);
        assert.equal(conCampo.text, sinCampo.text);
        assert.deepEqual(llamadas[0].args.slice(0, 3), llamadas[1].args.slice(0, 3));
        const [org, animalId, eventoId, value, contexto] = llamadas[0].args;
        assert.deepEqual([org, animalId, eventoId], [ORG_A, '7', '3']);
        assert.equal('identidadEsperada' in value, false);
        assert.equal(contexto.actorCuentaId, 'cuenta-1');
      });

      for (const [nombre, identidadEsperada] of [
        ['otra cuenta de la misma organización', { cuentaId: 'cuenta-2', organizacionId: ORG_A }],
        ['otra organización', { cuentaId: 'cuenta-1', organizacionId: ORG_B }],
      ]) {
        test(`${nombre}: 409 sin tocar el repositorio ni revelar la sesión`, async () => {
          const res = await call('POST', ruta, { ...cuerpo, identidadEsperada });
          assert.equal(res.status, 409);
          assert.equal(res.json.error, 'IDENTIDAD_NO_COINCIDE');
          assert.equal(res.cache, 'no-store');
          assert.equal(llamadas.length, 0);
          assert.doesNotMatch(res.text, /cuenta-1|cuenta-2/);
          assert.doesNotMatch(res.text, new RegExp(`${ORG_A}|${ORG_B}`));
        });
      }

      test('el rol va antes que la identidad: un operador recibe 403, coincida o no', async () => {
        for (const identidadEsperada of [PROPIA, { cuentaId: 'cuenta-2', organizacionId: ORG_A }]) {
          const res = await call('POST', ruta, { ...cuerpo, identidadEsperada }, { rol: 'operador' });
          assert.equal(res.status, 403);
          assert.equal(res.json.error, 'ROLE_FORBIDDEN');
        }
        assert.equal(llamadas.length, 0);
      });

      test('sesión y CSRF siguen antes que la identidad', async () => {
        assert.equal((await call('POST', ruta, { ...cuerpo, identidadEsperada: PROPIA }, { org: null })).status, 401);
        assert.equal((await call('POST', ruta, { ...cuerpo, identidadEsperada: PROPIA }, { csrf: 'none' })).status, 403);
        assert.equal(llamadas.length, 0);
      });

      test('forma inválida: 400 sin tocar el repositorio', async () => {
        for (const identidadEsperada of [null, 'x', [], {}, { cuentaId: 'cuenta-1' }, { cuentaId: 1, organizacionId: ORG_A }, { ...PROPIA, extra: 1 }]) {
          const res = await call('POST', ruta, { ...cuerpo, identidadEsperada });
          assert.equal(res.status, 400, JSON.stringify(identidadEsperada));
          assert.equal(res.json.error, 'INVALID_IDENTIDAD_ESPERADA');
        }
        assert.equal(llamadas.length, 0);
      });

      test('el cliente no puede declarar la autoría ni el tenant', async () => {
        for (const campo of ['anulado_por', 'anuladoPor', 'actorCuentaId', 'cuentaId', 'organizacionId']) {
          const res = await call('POST', ruta, { ...cuerpo, identidadEsperada: PROPIA, [campo]: 'cuenta-2' });
          assert.equal(res.status, 400, campo);
          assert.equal(res.json.error, 'FORBIDDEN_FIELDS', campo);
        }
        assert.equal(llamadas.length, 0);
      });
    });
  }

  test('corregir: identidadEsperada dentro de `evento` no es el campo: FORBIDDEN_FIELDS', async () => {
    const res = await call('POST', `${P}/eventos/3/corregir`, { ...CASOS[1].cuerpo, evento: { ...CASOS[1].cuerpo.evento, identidadEsperada: PROPIA } });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, 'FORBIDDEN_FIELDS');
    assert.equal(llamadas.length, 0);
  });
});

describe('FASE 4A: sesión, CSRF y RBAC', () => {
  test('sin sesión -> 401 en lecturas y escrituras, sin tocar el repositorio', async () => {
    for (const [m, p, b] of [['GET', P], ['GET', `${P}/estado`], ['POST', `${P}/eventos`, CELO], ['POST', `${P}/eventos/3/anular`, ANULAR]]) {
      assert.equal((await call(m, p, b, { org: null })).status, 401, `${m} ${p}`);
    }
    assert.equal(llamadas.length, 0);
  });

  test('POST sin CSRF -> 403', async () => {
    assert.equal((await call('POST', `${P}/eventos`, CELO, { csrf: 'none' })).status, 403);
    assert.equal(llamadas.length, 0);
  });

  test('lector: lee, pero no registra ni anula (ROLE_FORBIDDEN); operador registra pero no anula ni corrige', async () => {
    assert.equal((await call('GET', P, undefined, { rol: 'lector' })).status, 200);
    assert.deepEqual((await call('POST', `${P}/eventos`, CELO, { rol: 'lector' })).json, { error: 'ROLE_FORBIDDEN' });
    assert.equal((await call('POST', `${P}/eventos`, CELO, { rol: 'operador' })).status, 201);
    for (const accion of ['anular', 'corregir']) {
      assert.deepEqual((await call('POST', `${P}/eventos/3/${accion}`, ANULAR, { rol: 'operador' })).json, { error: 'ROLE_FORBIDDEN' });
    }
    assert.deepEqual(llamadas.map((l) => l.nombre), ['obtenerReproduccionAnimal', 'registrar']);
  });

  test('rol en body/header no eleva permisos', async () => {
    const r = await call('POST', `${P}/eventos/3/anular`, { ...ANULAR }, { rol: 'operador', headers: { 'X-Rol': 'owner' } });
    assert.deepEqual(r.json, { error: 'ROLE_FORBIDDEN' });
  });
});

describe('FASE 4A: validación previa a la base de negocio', () => {
  test('ids inválidos -> 400', async () => {
    assert.equal((await call('POST', '/animales/abc/reproduccion/eventos', CELO)).json.error, 'INVALID_ANIMAL_ID');
    assert.equal((await call('POST', `${P}/eventos/0/anular`, ANULAR)).json.error, 'INVALID_EVENTO_ID');
    assert.equal(llamadas.length, 0);
  });

  test('organizacionId en el body, tipo inválido, observaciones largas -> 400', async () => {
    assert.equal((await call('POST', `${P}/eventos`, { ...CELO, organizacionId: ORG_B })).json.error, 'FORBIDDEN_FIELDS');
    assert.equal((await call('POST', `${P}/eventos`, { ...CELO, tipoEvento: 'VACUNA' })).json.error, 'INVALID_TIPO_EVENTO');
    assert.equal((await call('POST', `${P}/eventos`, { ...CELO, observaciones: 'a'.repeat(501) })).json.error, 'INVALID_OBSERVACIONES');
    assert.equal((await call('POST', `${P}/eventos`, { ...CELO, fechaEvento: '2999-01-01' })).json.error, 'INVALID_FECHA');
    assert.equal(llamadas.length, 0);
  });
});

describe('FASE 4A: delegación y códigos de respuesta', () => {
  test('201 al crear; organización y actor SOLO de la sesión', async () => {
    const r = await call('POST', `${P}/eventos?organizacionId=${ORG_B}`, CELO, { headers: { 'X-Organizacion-Id': ORG_B } });
    assert.equal(r.status, 201);
    assert.equal(r.cache, 'no-store');
    const [org, animalId, value, opciones] = llamadas[0].args;
    assert.equal(org, ORG_A);
    assert.equal(animalId, '7');
    assert.equal(value.tipoEvento, 'CELO_OBSERVADO');
    assert.equal(opciones.actorCuentaId, 'cuenta-1');
  });

  test('reintento -> 200 yaExistia; anular -> 200; corregir -> 201', async () => {
    respuesta = { evento: {}, estado: {}, yaExistia: true };
    assert.equal((await call('POST', `${P}/eventos`, CELO)).status, 200);
    respuesta = null;
    assert.equal((await call('POST', `${P}/eventos/3/anular`, ANULAR)).status, 200);
    const c = await call('POST', `${P}/eventos/3/corregir`, { ...ANULAR, evento: { tipoEvento: 'IATF', fechaEvento: '2026-10-01' } });
    assert.equal(c.status, 201);
    assert.equal(llamadas.at(-1).args[2], '3');
  });

  test('GET 404 indistinguible para animal ajeno o inexistente', async () => {
    respuesta = null;
    REPO.obtenerReproduccionAnimal = async () => null;
    try {
      assert.deepEqual((await call('GET', P)).json, { error: 'ANIMAL_NOT_FOUND' });
    } finally {
      REPO.obtenerReproduccionAnimal = metodo('obtenerReproduccionAnimal');
    }
  });

  test('errores semánticos con su status; error interno sin SQL ni trazas', async () => {
    for (const [code, status] of [
      ['ANIMAL_NOT_FOUND', 404], ['EVENTO_NOT_FOUND', 404], ['ANIMAL_ANULADO', 409], ['ANIMAL_YA_SALIDO', 409],
      ['SEXO_INCOMPATIBLE', 409], ['EVENTO_NO_PERMITIDO_POR_ESTADO', 409], ['CLIENT_OPERATION_ID_REUSED', 409],
    ]) {
      respuesta = Object.assign(new Error('mensaje'), { status, code });
      const r = await call('POST', `${P}/eventos`, CELO);
      assert.equal(r.status, status, code);
      assert.deepEqual(r.json, { error: code, message: 'mensaje' });
    }
    respuesta = Object.assign(new Error('relation "agx.reproduccion_eventos" violates check constraint'), { code: '23514' });
    const r = await call('POST', `${P}/eventos`, CELO);
    assert.equal(r.status, 500);
    assert.doesNotMatch(r.text, /agx\.|constraint|select|stack|at /i);
  });
});
