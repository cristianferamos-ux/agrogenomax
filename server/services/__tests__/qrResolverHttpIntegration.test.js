// FASE 3B: resolución QR SIN token en la URL, de punta a punta contra
// Postgres-AGX-Business desechable (migraciones 0000-0025): Express efímero
// real con requestLogging + POST /api/ganaderia/qr/resolver + errorHandler.
// La sesión (Postgres-AGX) se simula como en ganaderiaRbacMatriz.test.js.
//
// Garantías: chapetas generadas por el flujo existente (pre-3B) siguen
// resolviendo con la MISMA semántica que GET /qr/token/:token (activa,
// revocada, reemplazada, dañada, animal SALIDO/MUERTO/ANULADO, otra
// organización, sin sesión, Super Admin); qr_chapeta_tokens no cambia; el
// token nunca aparece en la respuesta ni en los logs; la cookie efímera se
// borra al resolver; Referrer-Policy no-referrer y Cache-Control no-store.
delete process.env.AGX_BUSINESS_DATABASE_URL;
delete process.env.AGX_BUSINESS_QR_ADMIN_DATABASE_URL;

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import pg from 'pg';
import express from 'express';
import { validateCreateAnimalBody } from '../ganaderia/animalValidation.js';
import { validateCierreBody } from '../ganaderia/cierreValidation.js';
import { resolveFechaHoyNegocio } from '../ganaderia/motorDescansoAuto/businessTimezone.js';

const TEST_CSRF_SECRET = 'gwslZ1bKInXjQ0TLmMqWeV6vRAL2hONB6bTBqpAjVFs=';
const ALLOWED_ORIGIN = 'https://agrogenomax.com';
const FAKE_AUTH_CONNECTION_STRING = 'postgres://test:test@192.0.2.1:5432/never_connects';
const COOKIE = 'agx_qr_pendiente'; // APP_ENV=development (sin __Secure-)

let dbAvailable = false;
let adminPool;
let mods = {};

try {
  const testConnectionString = process.env.AGX_BUSINESS_DATABASE_URL_TEST;
  const adminConnectionString = process.env.AGX_BUSINESS_INTEGRATION_ADMIN_DATABASE_URL;
  const qrAdminConnectionString = process.env.AGX_BUSINESS_QR_ADMIN_DATABASE_URL_TEST;
  if (!testConnectionString || !adminConnectionString || !qrAdminConnectionString) throw new Error('sin conexiones');
  process.env.AGX_BUSINESS_DATABASE_URL = testConnectionString;
  process.env.AGX_BUSINESS_QR_ADMIN_DATABASE_URL = qrAdminConnectionString;
  process.env.AGX_QR_TOKEN_ENCRYPTION_KEY = process.env.AGX_QR_TOKEN_ENCRYPTION_KEY_TEST || crypto.randomBytes(32).toString('base64');
  const { getConfig } = await import('../../config/env.js');
  getConfig({ APP_ENV: 'development' }, {});
  adminPool = new pg.Pool({ connectionString: adminConnectionString, max: 2 });
  const check = await adminPool.query(
    `select to_regclass('agx.qr_chapetas') as t,
            (select count(*)::int from information_schema.columns
              where table_schema = 'agx' and table_name = 'animales' and column_name = 'estado_operativo') as cierre`,
  );
  dbAvailable = Boolean(check.rows[0]?.t) && check.rows[0].cierre === 1;
} catch {
  dbAvailable = false;
}

if (dbAvailable) {
  mods = {
    animalesRepo: await import('../ganaderia/animalesRepository.js'),
    chapetasRepo: await import('../ganaderia/qrChapetasRepository.js'),
    inventario: await import('../ganaderia/qrInventarioRepository.js'),
    cierreRepo: await import('../ganaderia/cierreRepository.js'),
    businessDb: await import('../../db/agxBusinessPool.js'),
    qrAdminDb: await import('../../db/agxQrAdminPool.js'),
    authPool: await import('../../db/agxAuthPool.js'),
    session: await import('../../security/ganaderiaSession.js'),
    qrRouter: await import('../../routes/ganaderiaAnimalQr.js'),
    errors: await import('../../middleware/errors.js'),
    requestLogging: await import('../../observability/requestLogging.js'),
  };
}

const HOY = resolveFechaHoyNegocio();
const SUPERADMIN = { actorCuentaId: '00000000-0000-4000-8000-0000000000ad' };
const ACTOR = '00000000-0000-4000-8000-0000000000aa';

const logs = [];
let ctx = null;

function startApp() {
  const config = { appEnv: 'development', csrfServerSecret: TEST_CSRF_SECRET, allowedOrigins: [ALLOWED_ORIGIN] };
  const app = express();
  app.use(mods.requestLogging.createRequestLogging({ sink: (e) => logs.push(e) }));
  app.use(express.json());
  app.use('/api/ganaderia/qr', mods.qrRouter.createGanaderiaQrRouter(config));
  app.use(mods.errors.notFound);
  app.use(mods.errors.createErrorHandler({ sink: (e) => logs.push(e) }));
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}/api/ganaderia/qr` }));
  });
}

/** Sesión simulada (Postgres-AGX) de `org` con `rol`; superAdmin = fila activa en staff_crh. */
function wireSession(org, { rol = 'lector', superAdmin = false } = {}) {
  const rawToken = crypto.randomBytes(32).toString('base64url');
  const tokenHash = mods.session.hashSessionSecret(rawToken);
  const pool = mods.authPool.getAgxAuthPool({ AGX_AUTH_DATABASE_URL: FAKE_AUTH_CONNECTION_STRING });
  pool.query = async (text, params = []) => {
    if (text.includes('from agx.sesiones s') && params[0] === tokenHash) {
      return { rows: [{ sesion_id: 's', cuenta_id: 'cuenta-1', organizacion_id: org, fecha_expiracion: new Date(Date.now() + 60_000).toISOString(), fecha_revocacion: null, cuenta_estado: 'activa', email: 't@example.com', nombre: 'T' }] };
    }
    if (text.includes('fn_resolver_autorizacion_sesion') && params[0] === tokenHash) {
      return { rows: [{ sesion_id: 's', cuenta_id: 'cuenta-1', organizacion_id: org, rol }] };
    }
    if (text.includes('agx.staff_crh') && superAdmin) return { rows: [{ rol_interno: 'administrador_plataforma' }] };
    return { rows: [] };
  };
  return rawToken;
}

/** POST /resolver con token en cookie (chapeta impresa) o en body (escáner). */
async function resolver(org, { token, via = 'cookie', sesion = true, rol, superAdmin, cookieValue } = {}) {
  const headers = { 'Content-Type': 'application/json', Origin: ALLOWED_ORIGIN };
  const cookies = [];
  if (sesion) {
    const raw = wireSession(org, { rol, superAdmin });
    cookies.push(`${mods.session.sessionCookieName('development')}=${raw}`);
    headers['X-CSRF-Token'] = mods.session.computeCsrfToken(raw, TEST_CSRF_SECRET);
  }
  if (via === 'cookie') cookies.push(`${COOKIE}=${cookieValue ?? token}`);
  if (cookies.length) headers.Cookie = cookies.join('; ');
  const body = via === 'body' ? JSON.stringify({ token }) : '{}';
  const response = await fetch(`${ctx.base}/resolver`, { method: 'POST', headers, body });
  const text = await response.text();
  return { status: response.status, text, json: text ? JSON.parse(text) : null, headers: response.headers };
}

/** GET legacy /token/:token (compatibilidad) con la misma sesión. */
async function resolverLegacy(org, token) {
  const raw = wireSession(org);
  const response = await fetch(`${ctx.base}/token/${token}`, { headers: { Cookie: `${mods.session.sessionCookieName('development')}=${raw}` } });
  return { status: response.status, json: await response.json() };
}

function orgId() {
  return crypto.randomUUID();
}

async function seedPredio(org) {
  const r = await adminPool.query(`insert into agx.predios (organizacion_id, nombre_predio, estado) values ($1, 'Predio 3B', 'ACTIVO') returning predio_id`, [org]);
  return String(r.rows[0].predio_id);
}

async function seedAnimal(org) {
  const value = validateCreateAnimalBody({
    clientOperationId: crypto.randomUUID(), predioId: await seedPredio(org), numeroVisual: `3B-${crypto.randomUUID().slice(0, 6)}`,
    sexo: 'HEMBRA', nacimientoTipo: 'DESCONOCIDA', razaTipo: 'DESCONOCIDA',
  }, { hoy: HOY });
  return (await mods.animalesRepo.createAnimalIdempotente(org, value, { actorCuentaId: ACTOR })).animal.animalId;
}

/** Chapetas generadas por el flujo EXISTENTE (lote -> stock -> asignación), sin nada de FASE 3B. */
async function chapetasDe(org, cantidad = 1) {
  const { inventario } = mods;
  const lote = (await inventario.crearLote(
    { cantidad, proveedor: 'Proveedor 3B', observaciones: null, urlBase: 'https://agrogenomax.test', clientOperationId: crypto.randomUUID() },
    SUPERADMIN,
  )).lote;
  await inventario.cambiarEstadoLote(lote.loteId, 'EN_FABRICACION', SUPERADMIN);
  await inventario.cambiarEstadoLote(lote.loteId, 'EN_STOCK', SUPERADMIN);
  await inventario.asignarChapetas(lote.loteId, { organizacionId: org, referencia: 'Plan 3B', clientOperationId: crypto.randomUUID() }, SUPERADMIN);
  return (await inventario.exportLoteProveedor(lote.loteId)).chapetas.map((c) => ({ codigo: c.codigoVisible, token: c.token }));
}

async function asociar(org, codigo) {
  const animal = await seedAnimal(org);
  await mods.chapetasRepo.asociarChapetaAAnimal(org, animal, codigo, { actorCuentaId: ACTOR });
  return animal;
}

function cerrar(org, animalId, tipo) {
  return mods.cierreRepo.registrarCierreIdempotente(org, animalId, validateCierreBody(
    tipo,
    tipo === 'SALIDA'
      ? { fechaSalida: HOY, motivoSalida: 'VENTA', clientOperationId: crypto.randomUUID() }
      : { fechaMuerte: HOY, causaMuerte: 'ENFERMEDAD', clientOperationId: crypto.randomUUID() },
    { hoy: HOY },
  ), { actorCuentaId: ACTOR });
}

async function tokensSnapshot(codigo) {
  return (await adminPool.query(
    `select t.qr_id::text, c.token_hash, t.clave_version, md5(t::text) as fila
       from agx.qr_chapeta_tokens t join agx.qr_chapetas c using (qr_id) where c.codigo_visible = $1`,
    [codigo],
  )).rows;
}

/** Respuesta segura: sin token, sin hash, con cabeceras de protección y cookie borrada si se envió. */
function assertRespuestaSegura(r, token, { cookieEnviada }) {
  assert.ok(!r.text.includes(token), 'el token no vuelve en el body');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
  assert.match(r.headers.get('x-request-id') ?? '', /^[0-9a-f-]{36}$/);
  const setCookie = r.headers.get('set-cookie') ?? '';
  if (cookieEnviada) {
    assert.match(setCookie, new RegExp(`^${COOKIE}=; Max-Age=0; Path=/api/ganaderia/qr; HttpOnly; SameSite=Lax`));
    assert.ok(!setCookie.includes(token));
  }
}

describe('FASE 3B: POST /api/ganaderia/qr/resolver contra Postgres real', { skip: !dbAvailable }, () => {
  before(async () => { ctx = await startApp(); });
  after(async () => {
    await new Promise((resolve) => ctx.server.close(resolve));
    mods.authPool.__resetAgxAuthPoolForTests();
    mods.businessDb.closeAgxBusinessPool?.();
    await mods.qrAdminDb.closeAgxQrAdminPool?.();
    await adminPool.end().catch(() => {});
  });

  test('3B-1. QR generado antes de FASE 3B: resuelve por cookie y por body igual que GET legacy; qr_chapeta_tokens intacto', async () => {
    const org = orgId();
    const [disponible, enUso] = await chapetasDe(org, 2);
    const animal = await asociar(org, enUso.codigo);
    const antes = [await tokensSnapshot(disponible.codigo), await tokensSnapshot(enUso.codigo)];

    for (const via of ['cookie', 'body']) {
      const d = await resolver(org, { token: disponible.token, via });
      assert.equal(d.status, 200, via);
      assert.equal(d.json.resultado, 'DISPONIBLE');
      assert.equal(d.json.chapeta.codigoVisible, disponible.codigo);
      assertRespuestaSegura(d, disponible.token, { cookieEnviada: via === 'cookie' });
      const a = await resolver(org, { token: enUso.token, via });
      assert.equal(a.status, 200, via);
      assert.equal(a.json.resultado, 'ANIMAL');
      assert.equal(a.json.animalId, animal);
      assertRespuestaSegura(a, enUso.token, { cookieEnviada: via === 'cookie' });
      assert.deepEqual(d.json, (await resolverLegacy(org, disponible.token)).json, 'misma semántica que el GET legacy');
      assert.deepEqual(a.json, (await resolverLegacy(org, enUso.token)).json);
    }
    assert.deepEqual([await tokensSnapshot(disponible.codigo), await tokensSnapshot(enUso.codigo)], antes, 'ni token, ni hash, ni cifrado cambian');
  });

  test('3B-2. revocada, dañada y reemplazada: 410 QR_NO_OPERATIVO con estado y animal original (misma organización)', async () => {
    const org = orgId();
    const [rev, dan, vieja, nueva] = await chapetasDe(org, 4);
    const a1 = await asociar(org, rev.codigo);
    await mods.chapetasRepo.bajaChapetaDeAnimal(org, a1, { causa: 'REVOCADO', motivo: 'Perdida', actorCuentaId: ACTOR });
    const a2 = await asociar(org, dan.codigo);
    await mods.chapetasRepo.bajaChapetaDeAnimal(org, a2, { causa: 'DANADO', motivo: 'Rota', actorCuentaId: ACTOR });
    const a3 = await asociar(org, vieja.codigo);
    await mods.chapetasRepo.reemplazarChapetaDeAnimal(org, a3, { codigoNuevo: nueva.codigo, motivo: 'Ilegible', actorCuentaId: ACTOR });
    for (const [c, estado, animal] of [[rev, 'REVOCADO', a1], [dan, 'DANADO', a2], [vieja, 'REEMPLAZADO', a3]]) {
      const r = await resolver(org, { token: c.token });
      assert.equal(r.status, 410, estado);
      assert.deepEqual(r.json, { error: 'QR_NO_OPERATIVO', estado, animalId: animal });
      assertRespuestaSegura(r, c.token, { cookieEnviada: true });
      const legacy = await resolverLegacy(org, c.token);
      assert.deepEqual([legacy.status, legacy.json], [r.status, r.json]);
    }
    const n = await resolver(org, { token: nueva.token });
    assert.deepEqual([n.status, n.json.resultado, n.json.animalId], [200, 'ANIMAL', a3]);
  });

  test('3B-3. animal SALIDO, MUERTO y ANULADO: 410 REVOCADO con el animal original', async () => {
    const org = orgId();
    const [s, m, an] = await chapetasDe(org, 3);
    const aS = await asociar(org, s.codigo);
    await cerrar(org, aS, 'SALIDA');
    const aM = await asociar(org, m.codigo);
    await cerrar(org, aM, 'MUERTE');
    const aA = await asociar(org, an.codigo);
    await mods.animalesRepo.anularAnimal(org, aA, { motivo: 'Duplicado', actorCuentaId: ACTOR });
    for (const [c, animal] of [[s, aS], [m, aM], [an, aA]]) {
      const r = await resolver(org, { token: c.token, via: 'body' });
      assert.equal(r.status, 410);
      assert.equal(r.json.error, 'QR_NO_OPERATIVO');
      assert.equal(r.json.estado, 'REVOCADO');
      assert.equal(r.json.animalId, animal);
      const legacy = await resolverLegacy(org, c.token);
      assert.deepEqual([legacy.status, legacy.json], [r.status, r.json]);
    }
  });

  test('3B-4. otra organización: 404 QR_NOT_FOUND indistinguible de un token inexistente; nunca animalId ni org', async () => {
    const orgA = orgId();
    const orgB = orgId();
    const [deB, terminalDeB] = await chapetasDe(orgB, 2);
    const animalB = await asociar(orgB, terminalDeB.codigo);
    await cerrar(orgB, animalB, 'SALIDA');
    const inexistente = crypto.randomBytes(24).toString('base64url');
    const respuestas = [];
    for (const token of [deB.token, terminalDeB.token, inexistente]) {
      const r = await resolver(orgA, { token });
      assert.equal(r.status, 404);
      assert.ok(!r.text.includes(orgB) && !r.text.includes(animalB));
      assertRespuestaSegura(r, token, { cookieEnviada: true });
      respuestas.push(r.json);
    }
    assert.deepEqual(respuestas, [{ error: 'QR_NOT_FOUND' }, { error: 'QR_NOT_FOUND' }, { error: 'QR_NOT_FOUND' }]);
  });

  test('3B-5. sin sesión: 401 y la cookie pendiente NO se consume (sigue sirviendo tras el login)', async () => {
    const org = orgId();
    const [c] = await chapetasDe(org);
    const r = await resolver(org, { token: c.token, sesion: false });
    assert.equal(r.status, 401);
    assert.equal(r.headers.get('set-cookie'), null);
    assert.ok(!r.text.includes(c.token));
    const tras = await resolver(org, { token: c.token });
    assert.equal(tras.status, 200);
  });

  test('3B-6. Super Admin: sin bypass -- solo su organización de sesión; otra organización 404', async () => {
    const org = orgId();
    const otra = orgId();
    const [c] = await chapetasDe(otra);
    const r = await resolver(org, { token: c.token, superAdmin: true, rol: 'lector' });
    assert.equal(r.status, 404);
    assert.deepEqual(r.json, { error: 'QR_NOT_FOUND' });
  });

  test('3B-7. token inválido (body o cookie) y sin token: 404 sin consultar; la cookie inválida se borra', async () => {
    const org = orgId();
    const malo = await resolver(org, { token: 'corto', via: 'body' });
    assert.deepEqual([malo.status, malo.json], [404, { error: 'QR_NOT_FOUND' }]);
    const cookieMala = await resolver(org, { via: 'cookie', cookieValue: '../../etc' });
    assert.deepEqual([cookieMala.status, cookieMala.json], [404, { error: 'QR_PENDIENTE_AUSENTE' }]);
    assert.match(cookieMala.headers.get('set-cookie') ?? '', /Max-Age=0/);
    const nada = await resolver(org, { via: 'none' });
    assert.deepEqual([nada.status, nada.json], [404, { error: 'QR_PENDIENTE_AUSENTE' }]);
    assert.equal(nada.headers.get('set-cookie'), null);
  });

  test('3B-8. logs: ningún evento contiene token, hash, cookie, CSRF ni sesión', async () => {
    const hashes = (await adminPool.query('select token_hash from agx.qr_chapetas where token_hash is not null order by qr_id desc limit 50')).rows.map((r) => r.token_hash);
    const serialized = JSON.stringify(logs);
    assert.ok(logs.length > 0);
    for (const h of hashes) assert.ok(!serialized.includes(h), 'token_hash en logs');
    assert.doesNotMatch(serialized, /agx_qr_pendiente|agx_session|X-CSRF|cookie|resolver\/|\/token\/[A-Za-z0-9_-]{32}/i);
    for (const e of logs) {
      for (const value of Object.values(e)) {
        if (typeof value === 'string') assert.doesNotMatch(value, /^[A-Za-z0-9_-]{32}$/, 'valor con forma de token QR');
      }
    }
  });
});
