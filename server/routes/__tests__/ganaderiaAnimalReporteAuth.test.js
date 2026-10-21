// FASE 1C.2: garantías HTTP de GET /api/ganaderia/animales/:animalId/
// reporte-productivo.pdf -- servidor Express efímero real y fetch() directo
// (mismo patrón que ganaderiaAnimalPesajesAuth.test.js). La sesión es falsa
// (pool de auth simulado) y los datos Business se inyectan con `cargarDatos`
// para cubrir animal propio / ajeno / inexistente / anulado sin base real.
// El aislamiento con RLS real se prueba en
// server/services/__tests__/reporteProductivoIntegration.test.js.
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import express from 'express';

import createGanaderiaAnimalReporteRouter from '../ganaderiaAnimalReporte.js';
import { getAgxAuthPool, __resetAgxAuthPoolForTests } from '../../db/agxAuthPool.js';
import { hashSessionSecret, sessionCookieName } from '../../security/ganaderiaSession.js';
import { __resetAgxBusinessPoolForTests } from '../../db/agxBusinessPool.js';
import { getConfig, __resetValidationStateForTests } from '../../config/env.js';
import { errorHandler, notFound } from '../../middleware/errors.js';
import { construirHistorialPesajes } from '../../services/ganaderia/pesajesService.js';

const TEST_CSRF_SECRET = 'gwslZ1bKInXjQ0TLmMqWeV6vRAL2hONB6bTBqpAjVFs=';
const ALLOWED_ORIGIN = 'https://agrogenomax.com';
const FAKE_AUTH_CONNECTION_STRING = 'postgres://test:test@192.0.2.1:5432/never_connects';
const ORG_A = '00000000-0000-4000-8000-00000000000a';
const ORG_B = '00000000-0000-4000-8000-00000000000b';
const AHORA = new Date('2026-10-21T02:00:00Z'); // 20/10/2026 21:00 en Bogotá

let seq = 0;
const p = (fecha, pesoKg) => ({ pesajeId: String(++seq), fecha, pesoKg, metodo: 'BASCULA', origen: 'MANUAL', observaciones: null, createdAt: `${fecha}T12:00:00Z` });
const animal = (animalId, extra = {}) => ({
  animalId, predioNombre: 'Finca A', numeroVisual: `AGX-${animalId}`, nombre: null, sexo: 'MACHO', razaTipo: 'DESCONOCIDA',
  categoriaProductivaNombre: null, estado: 'ACTIVO', estadoMotivo: null, fechaCreacion: new Date('2026-01-10T15:00:00Z'), ...extra,
});

// "Base" de la organización A (la B solo tiene su propio animal 900).
const DATOS = {
  [ORG_A]: {
    1: { animal: animal('1'), pesajes: [] },
    2: { animal: animal('2'), pesajes: [p('2026-10-19', 350)] },
    3: { animal: animal('3'), pesajes: [p('2026-10-19', 350), p('2026-10-20', 355)] },
    4: { animal: animal('4'), pesajes: Array.from({ length: 40 }, (_, i) => p(new Date(Date.UTC(2025, 0, 1 + i * 9)).toISOString().slice(0, 10), 200 + i * 3)) },
    5: { animal: animal('5'), pesajes: [p('2026-06-01', 320), p('2026-07-01', 330), p('2026-08-06', 300)] },
    6: { animal: animal('6', { estado: 'ANULADO', estadoMotivo: 'Registro duplicado' }), pesajes: [p('2026-03-01', 290)] },
  },
  [ORG_B]: {
    900: { animal: animal('900', { numeroVisual: 'SECRETO-B', predioNombre: 'Finca B confidencial' }), pesajes: [p('2026-10-01', 500)] },
  },
};

const llamadas = [];
async function cargarDatosFalso(organizacionId, animalId) {
  llamadas.push({ organizacionId, animalId });
  const fila = DATOS[organizacionId]?.[animalId];
  if (!fila) return null;
  return { animal: fila.animal, historial: construirHistorialPesajes({ animalId, pesajes: fila.pesajes }) };
}

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
});

function startApp(opciones = {}) {
  const app = express();
  app.use(express.json());
  app.use('/api/ganaderia/animales/:animalId/reporte-productivo.pdf', createGanaderiaAnimalReporteRouter({
    appEnv: 'development', csrfServerSecret: TEST_CSRF_SECRET, allowedOrigins: [ALLOWED_ORIGIN],
    cargarDatos: cargarDatosFalso, reloj: () => AHORA, ...opciones,
  }));
  app.use(notFound);
  app.use(errorHandler);
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}/api/ganaderia` }));
  });
}

function wireFakeSession(organizacionId) {
  const rawToken = crypto.randomBytes(32).toString('base64url');
  const tokenHash = hashSessionSecret(rawToken);
  const pool = getAgxAuthPool({ AGX_AUTH_DATABASE_URL: FAKE_AUTH_CONNECTION_STRING });
  pool.query = async (text, params = []) => {
    if (text.includes('from agx.sesiones s') && params[0] === tokenHash) {
      return {
        rows: [{
          sesion_id: 'sesion-1', cuenta_id: 'cuenta-1', organizacion_id: organizacionId,
          fecha_expiracion: new Date(Date.now() + 60_000).toISOString(), fecha_revocacion: null,
          cuenta_estado: 'activa', email: 'test@example.com', nombre: 'Test',
        }],
      };
    }
    if (text.includes('fn_resolver_autorizacion_sesion') && params[0] === tokenHash) {
      return { rows: [{ sesion_id: 'sesion-1', cuenta_id: 'cuenta-1', organizacion_id: organizacionId, rol: 'propietario' }] };
    }
    return { rows: [] };
  };
  return rawToken;
}

async function get(path, { org = ORG_A, method = 'GET', headers: extra = {}, opciones } = {}) {
  const rawToken = org ? wireFakeSession(org) : null;
  const ctx = await startApp(opciones);
  try {
    const headers = { Origin: ALLOWED_ORIGIN, ...extra };
    if (rawToken) headers.Cookie = `${sessionCookieName('development')}=${rawToken}`;
    const response = await fetch(`${ctx.baseUrl}${path}`, { method, headers });
    const body = Buffer.from(await response.arrayBuffer());
    let json = null;
    try { json = JSON.parse(body.toString('utf8')); } catch { json = null; }
    return { status: response.status, headers: response.headers, body, json };
  } finally {
    await new Promise((resolve) => ctx.server.close(resolve));
  }
}

const URL_REPORTE = (id) => `/animales/${id}/reporte-productivo.pdf`;

describe('FASE 1C.2: reporte productivo -- autenticación y validación', () => {
  test('1. sin sesión -> 401 y no consulta datos', async () => {
    const r = await get(URL_REPORTE(3), { org: null });
    assert.equal(r.status, 401);
    assert.equal(llamadas.length, 0);
  });

  test('animalId inválido -> 400 INVALID_ANIMAL_ID sin consultar datos', async () => {
    for (const id of ['abc', '0', '-1', '1.5']) {
      const r = await get(URL_REPORTE(id));
      assert.equal(r.status, 400, id);
      assert.equal(r.json.error, 'INVALID_ANIMAL_ID');
    }
    assert.equal(llamadas.length, 0);
  });

  test('GET sin CSRF es válido (política de lectura)', async () => {
    const r = await get(URL_REPORTE(3));
    assert.equal(r.status, 200);
  });

  test('no existe escritura: POST con sesión -> 403 CSRF (nunca genera ni escribe)', async () => {
    const r = await get(URL_REPORTE(3), { method: 'POST' });
    assert.equal(r.status, 403);
    assert.equal(llamadas.length, 0);
  });
});

describe('FASE 1C.2: reporte productivo -- tenant', () => {
  test('2. animal inexistente -> 404 ANIMAL_NOT_FOUND', async () => {
    const r = await get(URL_REPORTE(999999));
    assert.equal(r.status, 404);
    assert.deepEqual(r.json, { error: 'ANIMAL_NOT_FOUND' });
    assert.equal(r.headers.get('cache-control'), 'no-store');
  });

  test('3/19. animal de OTRA organización -> 404 idéntico al inexistente, sin datos ajenos', async () => {
    const ajeno = await get(URL_REPORTE(900));
    const inexistente = await get(URL_REPORTE(999999));
    assert.equal(ajeno.status, 404);
    assert.deepEqual(ajeno.json, inexistente.json, 'no filtra existencia entre organizaciones');
    assert.doesNotMatch(ajeno.body.toString('latin1'), /SECRETO-B|confidencial/);
    // Y la organización B sí ve el suyo.
    const propioB = await get(URL_REPORTE(900), { org: ORG_B });
    assert.equal(propioB.status, 200);
  });

  test('la organización SIEMPRE sale de la sesión: query/header organizacionId se ignoran', async () => {
    const r = await get(`${URL_REPORTE(900)}?organizacionId=${ORG_B}&organizacion_id=${ORG_B}`, {
      headers: { 'X-Organizacion-Id': ORG_B, 'X-Organization-Id': ORG_B },
    });
    assert.equal(r.status, 404);
    assert.deepEqual(llamadas.map((l) => l.organizacionId), [ORG_A]);
  });
});

describe('FASE 1C.2: reporte productivo -- respuesta PDF', () => {
  test('4/14/15/16/17/18. animal propio -> 200 PDF con cabeceras seguras', async () => {
    const r = await get(URL_REPORTE(3));
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'application/pdf');
    assert.equal(r.headers.get('content-disposition'), 'attachment; filename="AgroGenomaX_Reporte_Productivo_AGX-3_2026-10-20.pdf"');
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(Number(r.headers.get('content-length')), r.body.length);
    assert.equal(r.body.subarray(0, 5).toString('latin1'), '%PDF-');
    assert.ok(r.body.length > 20_000, `tamaño ${r.body.length}`);
    assert.deepEqual(llamadas, [{ organizacionId: ORG_A, animalId: '3' }]);
  });

  test('5-12. 0, 1, varios y muchos pesajes; GMD negativa; anulado -> 200 PDF', async () => {
    for (const id of [1, 2, 3, 4, 5, 6]) {
      const r = await get(URL_REPORTE(id));
      assert.equal(r.status, 200, `animal ${id}`);
      assert.equal(r.body.subarray(0, 5).toString('latin1'), '%PDF-');
    }
  });

  test('13. fecha de negocio Bogotá en el nombre del archivo (UTC ya es el día siguiente)', async () => {
    const r = await get(URL_REPORTE(2));
    assert.match(r.headers.get('content-disposition'), /_2026-10-20\.pdf"$/);
  });

  test('error interno -> 500 genérico sin detalles (ni SQL ni stack)', async () => {
    const r = await get(URL_REPORTE(3), {
      opciones: { cargarDatos: async () => { throw new Error('relation agx.animal_pesajes does not exist at /srv/x.js:1'); } },
    });
    assert.equal(r.status, 500);
    assert.doesNotMatch(r.body.toString('utf8'), /relation|animal_pesajes|\.js:|stack/i);
    assert.notEqual(r.headers.get('content-type'), 'application/pdf');
  });
});
