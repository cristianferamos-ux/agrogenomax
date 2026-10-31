// FASE 3A: matriz RBAC completa de /api/ganaderia/* (roles de membresía
// owner/admin/operador/lector). Servidor Express efímero con TODOS los
// routers de negocio montados como en server/index.js; sesión simulada
// (pool agx_auth falso) y SIN AGX_BUSINESS_DATABASE_URL: un rol permitido
// llega al handler (400 de validación o 503 de base no configurada), un rol
// sin permiso recibe 403 ROLE_FORBIDDEN antes de cualquier acceso a datos.
// Inventario estático: ninguna ruta de escritura queda sin requireGanaderiaRole.
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import fs from 'node:fs';
import express from 'express';

import createGanaderiaPrediosRouter from '../ganaderiaPredios.js';
import createGanaderiaPotrerosRouter from '../ganaderiaPotreros.js';
import createGanaderiaPotreroFichaProductivaRouter from '../ganaderiaPotreroFichaProductiva.js';
import createGanaderiaPotreroCapacidadPastoreoRouter from '../ganaderiaPotreroCapacidadPastoreo.js';
import createGanaderiaPotreroContextoAgroclimaticoRouter from '../ganaderiaPotreroContextoAgroclimatico.js';
import createGanaderiaPotreroRecomendacionPastoreoRouter from '../ganaderiaPotreroRecomendacionPastoreo.js';
import createGanaderiaPotreroDescansoReentradaRouter from '../ganaderiaPotreroDescansoReentrada.js';
import createGanaderiaPotreroCicloPastoreoRouter from '../ganaderiaPotreroCicloPastoreo.js';
import createGanaderiaCatalogoPasturasRouter from '../ganaderiaCatalogoPasturas.js';
import createGanaderiaCategoriasProductivasRouter from '../ganaderiaCategoriasProductivas.js';
import createGanaderiaAnimalesRouter from '../ganaderiaAnimales.js';
import { createGanaderiaAnimalQrRouter, createGanaderiaQrRouter } from '../ganaderiaAnimalQr.js';
import createGanaderiaAnimalPesajesRouter from '../ganaderiaAnimalPesajes.js';
import createGanaderiaAnimalReporteRouter from '../ganaderiaAnimalReporte.js';
import createGanaderiaAnimalTimelineRouter from '../ganaderiaAnimalTimeline.js';
import createGanaderiaAnimalCierreRouter from '../ganaderiaAnimalCierre.js';
import createGanaderiaAnimalReproduccionRouter from '../ganaderiaAnimalReproduccion.js';
import createGanaderiaSyncRouter from '../ganaderiaSync.js';
import createGanaderiaCatalogoRazasRouter from '../ganaderiaCatalogoRazas.js';
import { getAgxAuthPool, __resetAgxAuthPoolForTests } from '../../db/agxAuthPool.js';
import { __resetAgxBusinessPoolForTests } from '../../db/agxBusinessPool.js';
import { computeCsrfToken, hashSessionSecret, sessionCookieName } from '../../security/ganaderiaSession.js';
import { ROLES_ADMINISTRACION, ROLES_LECTURA, ROLES_OPERACION } from '../../security/ganaderiaPermisos.js';
import { getConfig, __resetValidationStateForTests } from '../../config/env.js';
import { errorHandler, notFound } from '../../middleware/errors.js';

const TEST_CSRF_SECRET = 'gwslZ1bKInXjQ0TLmMqWeV6vRAL2hONB6bTBqpAjVFs=';
const ALLOWED_ORIGIN = 'https://agrogenomax.com';
const FAKE_AUTH_CONNECTION_STRING = 'postgres://test:test@192.0.2.1:5432/never_connects';
const ORG = '00000000-0000-4000-8000-00000000000a';
const ROLES = ['owner', 'admin', 'operador', 'lector'];

const CONFIG = { appEnv: 'development', csrfServerSecret: TEST_CSRF_SECRET, allowedOrigins: [ALLOWED_ORIGIN] };
const PT = '/predios/:predioId/potreros/:potreroId';
// Mismo orden de montaje que server/index.js (rutas hijas antes que el padre).
const MOUNTS = [
  ['/predios', createGanaderiaPrediosRouter(CONFIG)],
  ['/predios/:predioId/potreros', createGanaderiaPotrerosRouter(CONFIG)],
  [`${PT}/ficha-productiva`, createGanaderiaPotreroFichaProductivaRouter(CONFIG)],
  [`${PT}/capacidad-pastoreo`, createGanaderiaPotreroCapacidadPastoreoRouter(CONFIG)],
  [`${PT}/contexto-agroclimatico`, createGanaderiaPotreroContextoAgroclimaticoRouter(CONFIG)],
  [`${PT}/recomendacion-pastoreo`, createGanaderiaPotreroRecomendacionPastoreoRouter(CONFIG)],
  [`${PT}/descanso-reentrada`, createGanaderiaPotreroDescansoReentradaRouter(CONFIG)],
  [`${PT}/ciclos-pastoreo`, createGanaderiaPotreroCicloPastoreoRouter(CONFIG)],
  ['/catalogo-pasturas', createGanaderiaCatalogoPasturasRouter(CONFIG)],
  ['/categorias-productivas', createGanaderiaCategoriasProductivasRouter(CONFIG)],
  ['/animales/:animalId/pesajes', createGanaderiaAnimalPesajesRouter(CONFIG)],
  ['/animales/:animalId/timeline', createGanaderiaAnimalTimelineRouter(CONFIG)],
  ['/animales/:animalId/salida', createGanaderiaAnimalCierreRouter({ ...CONFIG, tipo: 'SALIDA' })],
  ['/animales/:animalId/muerte', createGanaderiaAnimalCierreRouter({ ...CONFIG, tipo: 'MUERTE' })],
  ['/animales/:animalId/reproduccion', createGanaderiaAnimalReproduccionRouter(CONFIG)],
  ['/animales/:animalId/reporte-productivo.pdf', createGanaderiaAnimalReporteRouter(CONFIG)],
  ['/animales/:animalId/qr', createGanaderiaAnimalQrRouter(CONFIG)],
  ['/qr', createGanaderiaQrRouter(CONFIG)],
  ['/sync', createGanaderiaSyncRouter(CONFIG)],
  ['/animales', createGanaderiaAnimalesRouter(CONFIG)],
  ['/catalogo-razas', createGanaderiaCatalogoRazasRouter(CONFIG)],
];

const ALL = ROLES_LECTURA;
const OP = ROLES_OPERACION;
const ADM = ROLES_ADMINISTRACION;
const P = '/predios/11';
const POT = `${P}/potreros/22`;
const CIC = `${POT}/ciclos-pastoreo`;

// Matriz oficial FASE 3A: [método, path concreto, roles permitidos].
const ESCRITURAS = [
  // Animales
  ['POST', '/animales', OP],
  ['POST', '/animales/1/corregir', ADM],
  ['POST', '/animales/1/anular', ADM],
  // Pesajes
  ['POST', '/animales/1/pesajes', OP],
  // QR
  ['POST', '/animales/1/qr/asociar', OP],
  ['POST', '/animales/1/qr/reemplazar', ADM],
  ['POST', '/animales/1/qr/baja', ADM],
  ['POST', '/qr/chapetas/AGX-000001/registrar-animal', OP],
  // FASE 3B: resolver por POST (token fuera de la URL) -- lectura, 4 roles.
  ['POST', '/qr/resolver', ALL],
  // Cierres
  ['POST', '/animales/1/salida', ADM],
  ['POST', '/animales/1/muerte', ADM],
  // Reproducción (FASE 4A): registrar = operación; anular/corregir = administración
  ['POST', '/animales/1/reproduccion/eventos', OP],
  ['POST', '/animales/1/reproduccion/eventos/7/anular', ADM],
  ['POST', '/animales/1/reproduccion/eventos/7/corregir', ADM],
  // Predios (incluye búsquedas del flujo de alta)
  ['POST', '/predios', ADM],
  ['POST', '/predios/buscar-por-coordenadas', ADM],
  ['POST', '/predios/buscar-por-codigo', ADM],
  ['POST', `${P}/archivar`, ADM],
  ['POST', `${P}/restaurar`, ADM],
  // Potreros (incluye previews de geometría del flujo de alta)
  ['POST', `${P}/potreros`, ADM],
  ['POST', `${P}/potreros/preview-coordinates`, ADM],
  ['POST', `${P}/potreros/preview-gps`, ADM],
  ['POST', `${P}/potreros/preview-file`, ADM],
  ['POST', `${POT}/archivar`, ADM],
  ['POST', `${POT}/restaurar`, ADM],
  ['POST', `${POT}/ficha-productiva`, ADM],
  // Planificación del potrero (operación cotidiana; previews sin persistencia)
  ['POST', `${POT}/capacidad-pastoreo`, OP],
  ['POST', `${POT}/capacidad-pastoreo/preview`, ALL],
  ['POST', `${POT}/contexto-agroclimatico/refresh`, OP],
  ['POST', `${POT}/recomendacion-pastoreo`, OP],
  ['POST', `${POT}/recomendacion-pastoreo/auto`, OP],
  ['POST', `${POT}/recomendacion-pastoreo/preview`, ALL],
  ['POST', `${POT}/recomendacion-pastoreo/auto/preview`, ALL],
  ['POST', `${POT}/recomendacion-pastoreo/auto/escenario`, ALL],
  ['POST', `${POT}/descanso-reentrada`, OP],
  ['POST', `${POT}/descanso-reentrada/preview`, ALL],
  // Ciclos de pastoreo
  ['POST', `${CIC}/iniciar`, OP],
  ['POST', `${CIC}/5/finalizar`, OP],
  ['POST', `${CIC}/5/descanso-declarado`, OP],
  ['POST', `${CIC}/evaluar-reingreso`, OP],
  ['POST', `${CIC}/5/residual-real`, OP],
  ['POST', `${CIC}/5/residual-real/actualizar-comparativo`, OP],
  ['POST', `${CIC}/5/residual-real/aplicar-a-descanso`, OP],
  ['POST', `${CIC}/5/cancelar`, ADM],
  ['POST', `${CIC}/5/anular`, ADM],
  ['POST', `${CIC}/5/corregir`, ADM],
  ['POST', `${CIC}/5/residual-real/corregir`, ADM],
  ['POST', `${CIC}/5/residual-real/anular`, ADM],
  // Catálogos
  ['POST', '/catalogo-pasturas/personalizadas', ADM],
];

const LECTURAS = [
  '/animales', '/animales/resumen', '/animales/1', '/animales/1/pesajes', '/animales/1/timeline',
  '/animales/1/reporte-productivo.pdf', '/animales/1/qr', '/qr/chapetas', '/qr/codigo/AGX-000001',
  '/animales/1/reproduccion', '/animales/1/reproduccion/estado',
  '/predios', P, `${P}/potreros`, POT, `${POT}/ficha-productiva`, `${POT}/capacidad-pastoreo`,
  `${POT}/contexto-agroclimatico`, `${POT}/recomendacion-pastoreo`, `${POT}/descanso-reentrada`,
  `${CIC}/actual`, `${CIC}/historial`, `${CIC}/estado-operativo`, '/catalogo-pasturas',
  '/categorias-productivas', '/catalogo-razas', '/sync/pull',
];

before(() => {
  delete process.env.DATABASE_URL;
  delete process.env.AGX_BUSINESS_DATABASE_URL;
});

beforeEach(() => {
  __resetAgxAuthPoolForTests();
  __resetAgxBusinessPoolForTests();
  __resetValidationStateForTests();
  getConfig({ APP_ENV: 'development' }, {});
});

let ctx = null;
function startApp() {
  const app = express();
  app.use(express.json());
  for (const [path, router] of MOUNTS) app.use(`/api/ganaderia${path}`, router);
  app.use(notFound);
  app.use(errorHandler);
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}/api/ganaderia` }));
  });
}

function wireFakeSession(rol, { superAdmin = false } = {}) {
  const rawToken = crypto.randomBytes(32).toString('base64url');
  const tokenHash = hashSessionSecret(rawToken);
  const pool = getAgxAuthPool({ AGX_AUTH_DATABASE_URL: FAKE_AUTH_CONNECTION_STRING });
  pool.query = async (text, params = []) => {
    if (text.includes('from agx.sesiones s') && params[0] === tokenHash) {
      return { rows: [{ sesion_id: 's', cuenta_id: 'cuenta-1', organizacion_id: ORG, fecha_expiracion: new Date(Date.now() + 60_000).toISOString(), fecha_revocacion: null, cuenta_estado: 'activa', email: 't@example.com', nombre: 'T' }] };
    }
    if (text.includes('fn_resolver_autorizacion_sesion') && params[0] === tokenHash) {
      return { rows: [{ sesion_id: 's', cuenta_id: 'cuenta-1', organizacion_id: ORG, rol }] };
    }
    if (text.includes('agx.staff_crh') && superAdmin) return { rows: [{ rol_interno: 'administrador_plataforma' }] };
    return { rows: [] };
  };
  return rawToken;
}

async function call(method, path, { rol, body = {}, headers: extra = {}, superAdmin } = {}) {
  const rawToken = wireFakeSession(rol, { superAdmin });
  const headers = {
    'Content-Type': 'application/json',
    Origin: ALLOWED_ORIGIN,
    Cookie: `${sessionCookieName('development')}=${rawToken}`,
    'X-CSRF-Token': computeCsrfToken(rawToken, TEST_CSRF_SECRET),
    ...extra,
  };
  const response = await fetch(`${ctx.baseUrl}${path}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: response.status, json };
}

const esRoleForbidden = (r) => r.status === 403 && r.json?.error === 'ROLE_FORBIDDEN';

describe('FASE 3A: matriz RBAC de escrituras /api/ganaderia/*', () => {
  before(async () => { ctx = await startApp(); });
  // node:test ejecuta after() del describe; cerrar el servidor al final.
  test('servidor efímero listo', () => assert.ok(ctx));

  for (const [method, path, permitidos] of ESCRITURAS) {
    test(`${method} ${path} -> permitidos: ${permitidos.join('/')}`, async () => {
      for (const rol of ROLES) {
        const r = await call(method, path, { rol });
        if (permitidos.includes(rol)) {
          assert.ok(!esRoleForbidden(r), `${rol} debería pasar el RBAC (${r.status} ${r.json?.error})`);
          assert.notEqual(r.status, 401, `${rol}: 401 inesperado`);
        } else {
          assert.equal(r.status, 403, `${rol} debería recibir 403 (${r.status})`);
          assert.deepEqual(r.json, { error: 'ROLE_FORBIDDEN' }, rol);
        }
      }
    });
  }

  test('lecturas: los 4 roles pasan el RBAC en todas las familias', async () => {
    for (const path of LECTURAS) {
      for (const rol of ROLES) {
        const r = await call('GET', path, { rol });
        assert.ok(!esRoleForbidden(r), `GET ${path} (${rol}) -> ${r.status} ${r.json?.error}`);
        assert.notEqual(r.status, 401, `GET ${path} (${rol})`);
      }
    }
  });

  test('rol del cliente (body/query/header) nunca cambia la autorización', async () => {
    const intentos = [
      { body: { rol: 'owner', role: 'owner', organizacionId: ORG } },
      { headers: { 'X-Ganaderia-Rol': 'owner', 'X-Role': 'owner', 'X-Rol': 'owner' } },
    ];
    for (const extra of intentos) {
      for (const [method, path] of [['POST', '/animales/1/anular'], ['POST', '/animales'], ['POST', '/predios'], ['POST', `${CIC}/iniciar`]]) {
        const r = await call(method, path, { rol: 'lector', ...extra });
        assert.ok(esRoleForbidden(r), `${path} ${JSON.stringify(extra)}`);
      }
    }
    const q = await call('POST', '/animales/1/corregir?rol=owner&role=admin', { rol: 'operador' });
    assert.ok(esRoleForbidden(q));
  });

  test('roles desconocidos, vacíos o con otra capitalización -> 403', async () => {
    for (const rol of [null, '', 'propietario', 'OWNER', 'Admin', 'super_admin', 'superadmin']) {
      const r = await call('POST', '/animales', { rol });
      assert.ok(esRoleForbidden(r), String(rol));
    }
  });

  test('super_admin interno con membresía lector NO adquiere permisos de organización', async () => {
    const r = await call('POST', '/animales/1/anular', { rol: 'lector', superAdmin: true });
    assert.ok(esRoleForbidden(r));
  });

  test('403 no revela existencia: misma respuesta para cualquier id (propio, ajeno, inexistente)', async () => {
    const a = await call('POST', '/animales/1/corregir', { rol: 'operador' });
    const b = await call('POST', '/animales/987654321/corregir', { rol: 'operador' });
    assert.deepEqual(a, b);
  });

  test('cierre del servidor', async () => {
    await new Promise((resolve) => ctx.server.close(resolve));
  });
});

// ---------------------------------------------------------------------------
// Inventario estático: toda ruta no-GET tiene requireGanaderiaRole como
// PRIMER middleware de la ruta (antes de limitadores/parsers/handler) o a
// nivel de router; el router siempre exige sesión y CSRF antes.
// ---------------------------------------------------------------------------
// Path de ruta Express -> path concreto usado en ESCRITURAS.
const norm = (p) => p
  .replace('/predios/:predioId/potreros/:potreroId', POT)
  .replace('/predios/:predioId', P)
  .replace(/:cicloId/g, '5').replace(/:eventoId/g, '7').replace(/:animalId/g, '1').replace(':codigo', 'AGX-000001');
// Únicas rutas POST abiertas a los 4 roles: previews de cálculo que NUNCA persisten.
// FASE 3B: POST de LECTURA (con rol de lectura explícito), no es un preview.
const LECTURAS_POST = new Set(['POST /qr/resolver']);
const PREVIEWS_ABIERTOS = new Set(ESCRITURAS.filter(([, , roles]) => roles === ALL).map(([m, p]) => `${m} ${p}`).filter((k) => !LECTURAS_POST.has(k)));

function inventario() {
  const filas = [];
  for (const [base, router] of MOUNTS) {
    const nivelRouter = router.stack.filter((l) => !l.route).map((l) => l.handle?.name ?? l.name);
    for (const layer of router.stack.filter((l) => l.route)) {
      for (const method of Object.keys(layer.route.methods)) {
        const handles = layer.route.stack.map((l) => l.handle?.name ?? l.name);
        filas.push({ method: method.toUpperCase(), path: `${base}${layer.route.path === '/' ? '' : layer.route.path}`, nivelRouter, handles });
      }
    }
  }
  return filas;
}

describe('FASE 3A: inventario de rutas /api/ganaderia/*', () => {
  test('toda escritura tiene RBAC; sesión y CSRF van antes', () => {
    const filas = inventario();
    const escrituras = filas.filter((f) => f.method !== 'GET' && f.method !== 'HEAD');
    assert.ok(escrituras.length >= ESCRITURAS.length, `${escrituras.length} escrituras inventariadas`);
    assert.equal(PREVIEWS_ABIERTOS.size, 5);
    for (const k of PREVIEWS_ABIERTOS) assert.match(k, /\/(preview|auto\/preview|auto\/escenario)$/);
    for (const f of escrituras) {
      assert.ok(f.nivelRouter.includes('requireGanaderiaSession'), `${f.path}: sin sesión`);
      assert.ok(f.nivelRouter.includes('requireGanaderiaCsrf'), `${f.path}: sin CSRF`);
      assert.ok(f.nivelRouter.indexOf('requireGanaderiaSession') < f.nivelRouter.indexOf('requireGanaderiaCsrf'));
      if (PREVIEWS_ABIERTOS.has(`${f.method} ${norm(f.path)}`)) continue;
      const enRouter = f.nivelRouter.includes('requireGanaderiaRole');
      const primeroEnRuta = f.handles[0] === 'requireGanaderiaRole';
      assert.ok(enRouter || primeroEnRuta, `${f.method} ${f.path}: escritura sin RBAC (${f.handles.join(',')})`);
    }
  });

  test('la matriz probada cubre exactamente todas las escrituras inventariadas', () => {
    const inventariadas = inventario().filter((f) => f.method === 'POST').map((f) => `POST ${norm(f.path)}`).sort();
    const probadas = ESCRITURAS.map(([m, p]) => `${m} ${p}`).sort();
    assert.deepEqual(inventariadas, probadas);
  });

  test('todos los routers de /api/ganaderia/* de server/index.js (salvo auth/admin) están en la matriz', () => {
    const src = fs.readFileSync(new URL('../../index.js', import.meta.url), 'utf8');
    const montados = [...src.matchAll(/['`]\/api\/ganaderia(\/[^'`]+)['`]/g)].map((m) => m[1])
      .filter((p) => !p.startsWith('/auth') && !p.startsWith('/admin'))
      .map((p) => p.replace('${ruta}', 'salida'));
    const probados = new Set(MOUNTS.map(([p]) => p));
    for (const p of montados) assert.ok(probados.has(p), `router montado sin cobertura RBAC: ${p}`);
  });
});
