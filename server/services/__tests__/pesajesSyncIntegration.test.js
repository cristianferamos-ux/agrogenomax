// FASE 5A.3a -- GET /api/ganaderia/sync/pesajes contra rutas Express REALES y
// Postgres REAL con agx_app (RLS FORCE). Solo se simula la sesión (el plano de
// identidad no forma parte de esta base). Cubre: tenant, organización activa,
// pull inicial ACTIVO/ANULADO, evidencia de conciliación solo en sync, GET público
// sin ids, keyset con instantes idénticos, paginación determinista, ACTIVO ->
// ANULADO tras un pull, cursor inválido/de otro tenant, totales y no-store.
// Mismas variables que la integración de animales; se auto-omite sin ellas o sin 0028.
delete process.env.AGX_BUSINESS_DATABASE_URL;
delete process.env.AGX_BUSINESS_QR_ADMIN_DATABASE_URL;

import { test, describe, after, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import express from 'express';
import pg from 'pg';
import { computeCsrfToken, hashSessionSecret, sessionCookieName } from '../../security/ganaderiaSession.js';
import { getAgxAuthPool, __resetAgxAuthPoolForTests } from '../../db/agxAuthPool.js';
import { errorHandler, notFound } from '../../middleware/errors.js';
import { resolveFechaHoyNegocio } from '../ganaderia/motorDescansoAuto/businessTimezone.js';

const CSRF = 'gwslZ1bKInXjQ0TLmMqWeV6vRAL2hONB6bTBqpAjVFs=';
const ORIGEN = 'https://agrogenomax.com';
const HOY = resolveFechaHoyNegocio();
const ACTOR = '00000000-0000-4000-8000-0000000000aa';
const op = () => crypto.randomUUID();

let dbAvailable = false;
let adminPool;
let businessDb;
let qrAdminDb;
let crearRutaPesajes;
let crearRutaSync;
let sync;

try {
  const app = process.env.AGX_BUSINESS_DATABASE_URL_TEST;
  const admin = process.env.AGX_BUSINESS_INTEGRATION_ADMIN_DATABASE_URL;
  const qrAdmin = process.env.AGX_BUSINESS_QR_ADMIN_DATABASE_URL_TEST;
  if (!app || !admin || !qrAdmin) throw new Error('conexiones de prueba no configuradas');
  process.env.AGX_BUSINESS_DATABASE_URL = app;
  process.env.AGX_BUSINESS_QR_ADMIN_DATABASE_URL = qrAdmin;
  process.env.AGX_QR_TOKEN_ENCRYPTION_KEY = process.env.AGX_QR_TOKEN_ENCRYPTION_KEY_TEST || crypto.randomBytes(32).toString('base64');
  const { getConfig } = await import('../../config/env.js');
  getConfig({ APP_ENV: 'development' }, {});
  adminPool = new pg.Pool({ connectionString: admin, max: 4 });
  const check = await adminPool.query(
    `select count(*)::int as n from information_schema.columns
      where table_schema = 'agx' and table_name = 'animal_pesajes' and column_name = 'anulacion_client_operation_id'`,
  );
  dbAvailable = check.rows[0].n === 1;
} catch {
  dbAvailable = false;
}

if (dbAvailable) {
  businessDb = await import('../../db/agxBusinessPool.js');
  qrAdminDb = await import('../../db/agxQrAdminPool.js');
  crearRutaPesajes = (await import('../../routes/ganaderiaAnimalPesajes.js')).default;
  crearRutaSync = (await import('../../routes/ganaderiaSync.js')).default;
  sync = await import('../ganaderia/pesajesSyncRepository.js');
}

const sesiones = new Map();
let servidor;
let baseUrl;

function nuevaSesion(organizacionId, rol = 'owner') {
  const cuentaId = crypto.randomUUID();
  const token = crypto.randomBytes(32).toString('base64url');
  sesiones.set(hashSessionSecret(token), { cuentaId, organizacionId, rol });
  return { token, cuentaId, organizacionId, rol };
}

before(async () => {
  if (!dbAvailable) return;
  __resetAgxAuthPoolForTests();
  const auth = getAgxAuthPool({ AGX_AUTH_DATABASE_URL: 'postgres://test:test@192.0.2.1:5432/never_connects' });
  auth.query = async (text, params = []) => {
    const s = sesiones.get(params[0]);
    if (!s) return { rows: [] };
    if (text.includes('from agx.sesiones s')) {
      return { rows: [{ sesion_id: 's', cuenta_id: s.cuentaId, organizacion_id: s.organizacionId, fecha_expiracion: new Date(Date.now() + 60_000).toISOString(), fecha_revocacion: null, cuenta_estado: 'activa', email: 'qa@example.test', nombre: 'QA' }] };
    }
    if (text.includes('fn_resolver_autorizacion_sesion')) {
      if (!s.organizacionId) return { rows: [] };
      return { rows: [{ sesion_id: 's', cuenta_id: s.cuentaId, organizacion_id: s.organizacionId, rol: s.rol }] };
    }
    return { rows: [] };
  };
  const app = express();
  app.use(express.json());
  const config = { appEnv: 'development', csrfServerSecret: CSRF, allowedOrigins: [ORIGEN] };
  app.use('/api/ganaderia/animales/:animalId/pesajes', crearRutaPesajes(config));
  app.use('/api/ganaderia/sync', crearRutaSync(config));
  app.use(notFound);
  app.use(errorHandler);
  await new Promise((resolve) => { servidor = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${servidor.address().port}`;
});

after(async () => {
  await new Promise((resolve) => (servidor ? servidor.close(resolve) : resolve()));
  await adminPool?.end().catch(() => {});
  businessDb?.closeAgxBusinessPool?.();
  await qrAdminDb?.closeAgxQrAdminPool?.();
  __resetAgxAuthPoolForTests();
});

async function peticion(ruta, sesion, { method = 'GET', body } = {}) {
  const res = await fetch(`${baseUrl}${ruta}`, {
    method,
    headers: {
      Origin: ORIGEN,
      ...(sesion ? { Cookie: `${sessionCookieName('development')}=${sesion.token}`, 'X-CSRF-Token': computeCsrfToken(sesion.token, CSRF) } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = null; }
  return { status: res.status, data, text, cache: res.headers.get('cache-control') };
}

/** Organización con owner, predio y un animal. */
async function escenario() {
  const org = crypto.randomUUID();
  const { rows: [p] } = await adminPool.query(`insert into agx.predios (organizacion_id, nombre_predio, estado) values ($1, 'Predio 5A.3a', 'ACTIVO') returning predio_id`, [org]);
  const animal = async () => (await adminPool.query(
    `insert into agx.animales (organizacion_id, predio_id, sexo, client_operation_id, creation_intent_hash, numero_visual,
                               nacimiento_tipo, raza_tipo)
     values ($1, $2, 'MACHO', gen_random_uuid(), 'v1:' || repeat('a', 64), $3, 'DESCONOCIDA', 'DESCONOCIDA')
     returning animal_id::text as animal_id`,
    [org, p.predio_id, `S5-${op().slice(0, 8)}`],
  )).rows[0].animal_id;
  const animalId = await animal();
  return { org, animalId, otroAnimal: animal, owner: nuevaSesion(org, 'owner'), ruta: (id = animalId) => `/api/ganaderia/animales/${id}/pesajes` };
}

async function registrar(e, { pesoKg = 200, clientOperationId = op(), animalId = e.animalId } = {}) {
  const r = await peticion(e.ruta(animalId), e.owner, { method: 'POST', body: { fecha: HOY, pesoKg, metodo: 'BASCULA', clientOperationId } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return { pesajeId: r.data.pesaje.pesajeId, clientOperationId };
}

async function anular(e, pesajeId, { motivo = 'Error de digitación', clientOperationId = op(), animalId = e.animalId } = {}) {
  const r = await peticion(`${e.ruta(animalId)}/${pesajeId}/anular`, e.owner, { method: 'POST', body: { motivo, clientOperationId } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return { clientOperationId, motivo };
}

/** Fila MANUAL con created_at controlado (el trigger admite INSERT ACTIVO). */
async function insertarDirecto(org, animalId, { createdAt, pesoKg = 300 }) {
  const { rows } = await adminPool.query(
    `insert into agx.animal_pesajes (organizacion_id, animal_id, fecha, peso_kg, metodo, origen, actor_cuenta_id, client_operation_id, created_at)
     values ($1, $2, $3, $4, 'BASCULA', 'MANUAL', $5, gen_random_uuid(), $6::timestamptz)
     returning pesaje_id::text as pesaje_id`,
    [org, animalId, HOY, pesoKg, ACTOR, createdAt],
  );
  return rows[0].pesaje_id;
}

/** ACTIVO -> ANULADO con anulado_at controlado (solo columnas de anulación). */
async function anularDirecto(pesajeId, anuladoAt) {
  await adminPool.query(
    `update agx.animal_pesajes set estado_registro = 'ANULADO', anulado_por = $2, anulado_at = $3::timestamptz,
            motivo_anulacion = 'Motivo directo', anulacion_client_operation_id = gen_random_uuid()
      where pesaje_id = $1`,
    [pesajeId, ACTOR, anuladoAt],
  );
}

const pullHttp = (sesion, cursor) => peticion(`/api/ganaderia/sync/pesajes${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, sesion);

/** Recorre todas las páginas con un tamaño pequeño, igual que el endpoint. */
async function recorrer(org, cursor, limite) {
  const paginas = [];
  let actual = cursor;
  for (;;) {
    const pagina = await businessDb.withOrganizacionTransaction(org, (client) => sync.leerPaginaPesajesEnTx(client, org, { cursor: actual, limite }));
    paginas.push(pagina);
    actual = pagina.cursorSiguiente;
    if (!pagina.hayMas) return { paginas, cursor: actual, pesajes: paginas.flatMap((p) => p.pesajes) };
  }
}

const ids = (pesajes) => pesajes.map((p) => p.pesajeId);

describe('GET /sync/pesajes: Express + Postgres real', { skip: !dbAvailable }, () => {
  test('18. RLS: animal_pesajes sigue con ENABLE + FORCE y agx_app no tiene BYPASSRLS', async () => {
    const { rows: [t] } = await adminPool.query(
      `select c.relrowsecurity, c.relforcerowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'agx' and c.relname = 'animal_pesajes'`,
    );
    assert.equal(t.relrowsecurity, true);
    assert.equal(t.relforcerowsecurity, true);
    const { rows: [r] } = await adminPool.query(`select rolbypassrls, rolsuper from pg_roles where rolname = 'agx_app'`);
    assert.equal(r.rolbypassrls, false);
    assert.equal(r.rolsuper, false);
  });

  test('1. sin sesión: 401 sin datos', async () => {
    const res = await pullHttp(null);
    assert.equal(res.status, 401);
    assert.equal(res.data.pesajes, undefined);
    assert.equal(res.data.totales, undefined);
  });

  test('2. sesión sin organización activa: 409 ORGANIZATION_REQUIRED, sin datos', async () => {
    const res = await pullHttp(nuevaSesion(null));
    assert.equal(res.status, 409);
    assert.equal(res.data.error, 'ORGANIZATION_REQUIRED');
    assert.equal(res.data.pesajes, undefined);
  });

  test('3/4/5/14/15. pull inicial: activos y anulados del tenant, totales exactos, no-store, organización = sesión', async () => {
    const e = await escenario();
    const a = await registrar(e, { pesoKg: 200 });
    const b = await registrar(e, { pesoKg: 205 });
    await anular(e, b.pesajeId);
    const otro = await escenario();
    await registrar(otro, { pesoKg: 999 });

    const res = await pullHttp(e.owner);
    assert.equal(res.status, 200);
    assert.equal(res.cache, 'no-store');
    assert.equal(res.data.ok, true);
    assert.equal(res.data.organizacionId, e.org);
    assert.equal(res.data.cuentaId, e.owner.cuentaId);
    assert.equal(res.data.hayMas, false);
    assert.equal(res.data.completo, true);
    assert.equal(typeof res.data.cursorSiguiente, 'string');
    assert.deepEqual(res.data.totales, { pesajes: 2, anulados: 1 });
    assert.deepEqual(ids(res.data.pesajes).sort(), [a.pesajeId, b.pesajeId].sort());
    const porId = Object.fromEntries(res.data.pesajes.map((p) => [p.pesajeId, p]));
    assert.equal(porId[a.pesajeId].estadoRegistro, 'ACTIVO');
    assert.equal(porId[a.pesajeId].anulacion, null);
    assert.equal(porId[b.pesajeId].estadoRegistro, 'ANULADO');
    for (const p of res.data.pesajes) {
      assert.equal(p.organizacionId, e.org);
      assert.equal(p.animalId, e.animalId);
    }
    // Tenant B no aparece en A, ni A en B (cross-tenant = 0 filas).
    const resOtro = await pullHttp(otro.owner);
    assert.deepEqual(resOtro.data.totales, { pesajes: 1, anulados: 0 });
    assert.equal(resOtro.data.pesajes.some((p) => p.organizacionId !== otro.org), false);
    assert.equal(resOtro.data.pesajes.some((p) => ids(res.data.pesajes).includes(p.pesajeId)), false);
  });

  test('3b. RLS directo: la transacción de otra organización ve 0 filas del tenant', async () => {
    const e = await escenario();
    await registrar(e);
    const ajena = crypto.randomUUID();
    const pagina = await businessDb.withOrganizacionTransaction(ajena, (client) => sync.leerPaginaPesajesEnTx(client, ajena, {}));
    assert.deepEqual(pagina.pesajes, []);
    assert.deepEqual(pagina.totales, { pesajes: 0, anulados: 0 });
  });

  test('6/7/16. evidencia exacta: clientOperationId del CREATE y anulacionClientOperationId + motivo del ANULAR', async () => {
    const e = await escenario();
    const creado = await registrar(e);
    const anulacion = await anular(e, creado.pesajeId, { motivo: '  Báscula descalibrada\r\nrevisada  ' });
    const fila = (await pullHttp(e.owner)).data.pesajes.find((p) => p.pesajeId === creado.pesajeId);
    assert.equal(fila.clientOperationId, creado.clientOperationId);
    assert.equal(fila.anulacionClientOperationId, anulacion.clientOperationId);
    assert.equal(fila.estadoRegistro, 'ANULADO');
    assert.equal(fila.animalId, e.animalId);
    assert.equal(fila.anulacion.motivo, 'Báscula descalibrada\nrevisada');
    assert.match(fila.anulacion.anuladoEn, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
    assert.deepEqual(Object.keys(fila.anulacion).sort(), ['anuladoEn', 'motivo']);
    // Nunca el actor ni quién anuló.
    for (const prohibido of ['anuladoPor', 'anulado_por', 'actorCuentaId', 'actor_cuenta_id', 'anuladoPorCuentaId']) {
      assert.equal(prohibido in fila, false, prohibido);
    }
    assert.equal(JSON.stringify(fila).includes(e.owner.cuentaId), false);
    assert.equal(JSON.stringify(fila).includes(ACTOR), false);
  });

  test('8. el GET público sigue sin exponer clientOperationId ni anulacionClientOperationId', async () => {
    const e = await escenario();
    const creado = await registrar(e);
    const anulacion = await anular(e, creado.pesajeId);
    await registrar(e);
    const res = await peticion(e.ruta(), e.owner);
    assert.equal(res.status, 200);
    assert.equal(res.text.includes(creado.clientOperationId), false);
    assert.equal(res.text.includes(anulacion.clientOperationId), false);
    assert.equal(res.text.includes('lientOperationId'), false);
    assert.equal(res.text.includes('anulado_por'), false);
  });

  test('9. tres filas con EXACTAMENTE el mismo instante: ninguna se pierde ni se repite con página de 1', async () => {
    const e = await escenario();
    const instante = '2026-10-20T15:00:00.123456Z';
    const mismos = [];
    for (let i = 0; i < 3; i += 1) mismos.push(await insertarDirecto(e.org, e.animalId, { createdAt: instante }));
    const antes = await insertarDirecto(e.org, e.animalId, { createdAt: '2026-10-20T14:59:59.999999Z' });
    const despues = await insertarDirecto(e.org, e.animalId, { createdAt: '2026-10-20T15:00:00.123457Z' });
    const { paginas, pesajes } = await recorrer(e.org, undefined, 1);
    assert.equal(paginas.length, 5);
    const orden = [antes, ...mismos.sort((x, y) => Number(x) - Number(y)), despues];
    assert.deepEqual(ids(pesajes), orden);
    assert.equal(new Set(ids(pesajes)).size, 5);
    // Páginas intermedias sin totales; solo la última los trae.
    assert.equal(paginas.slice(0, -1).every((p) => p.totales === null && p.hayMas), true);
    assert.deepEqual(paginas.at(-1).totales, { pesajes: 5, anulados: 0 });
  });

  test('9b. mismo instante con ids de distinta longitud (9 < 10 numérico, no texto): orden y páginas exactos', async () => {
    const e = await escenario();
    const instante = '2026-10-20T16:00:00.000001Z';
    // Ids únicos por ejecución (la base puede reutilizarse) que siguen cruzando la
    // longitud de dígitos: <r>9 < <r>10 < <r>11 en número, pero '<r>10' < '<r>9' en texto.
    const r = 10_000_000 + crypto.randomInt(80_000_000);
    const explicitos = [`${r}9`, `${r}10`, `${r}11`];
    for (const id of [...explicitos].reverse()) {
      await adminPool.query(
        `insert into agx.animal_pesajes (pesaje_id, organizacion_id, animal_id, fecha, peso_kg, metodo, origen, actor_cuenta_id, client_operation_id, created_at)
         values ($1, $2, $3, $4, 250, 'BASCULA', 'MANUAL', $5, gen_random_uuid(), $6::timestamptz)`,
        [id, e.org, e.animalId, HOY, ACTOR, instante],
      );
    }
    for (const limite of [1, 2, 500]) {
      const { pesajes } = await recorrer(e.org, undefined, limite);
      assert.deepEqual(ids(pesajes), explicitos, `limite ${limite}`);
    }
  });

  test('10. paginación pequeña: orden total (marcaCambio, pesajeId) determinista y estable entre recorridos', async () => {
    const e = await escenario();
    const otro = await e.otroAnimal();
    const base = Date.parse('2026-10-21T10:00:00.000Z');
    const creados = [];
    for (let i = 0; i < 9; i += 1) {
      const instante = new Date(base + Math.floor(i / 3) * 1000).toISOString().replace('Z', '000Z');
      creados.push(await insertarDirecto(e.org, i % 2 ? otro : e.animalId, { createdAt: instante }));
    }
    // Una anulación mueve la fila al final del orden por marcaCambio.
    await anularDirecto(creados[0], '2026-10-21T11:00:00.000001Z');
    const uno = await recorrer(e.org, undefined, 2);
    const dos = await recorrer(e.org, undefined, 4);
    assert.deepEqual(ids(uno.pesajes), ids(dos.pesajes));
    assert.deepEqual(ids(uno.pesajes), [...creados.slice(1), creados[0]]);
    assert.equal(uno.pesajes.at(-1).estadoRegistro, 'ANULADO');
    assert.deepEqual(uno.paginas.at(-1).totales, { pesajes: 9, anulados: 1 });
    // Por HTTP, con la página real: un solo bloque.
    const http = await pullHttp(e.owner);
    assert.deepEqual(ids(http.data.pesajes), ids(uno.pesajes));
  });

  test('11. ACTIVO leído en un pull -> ANULADO después -> reaparece en el siguiente pull con su anulación', async () => {
    const e = await escenario();
    const creado = await registrar(e);
    const primero = await pullHttp(e.owner);
    assert.equal(primero.data.pesajes.find((p) => p.pesajeId === creado.pesajeId).estadoRegistro, 'ACTIVO');
    const anulacion = await anular(e, creado.pesajeId);
    const segundo = await pullHttp(e.owner, primero.data.cursorSiguiente);
    assert.equal(segundo.status, 200);
    const fila = segundo.data.pesajes.find((p) => p.pesajeId === creado.pesajeId);
    assert.equal(fila.estadoRegistro, 'ANULADO');
    assert.equal(fila.anulacionClientOperationId, anulacion.clientOperationId);
    assert.deepEqual(segundo.data.totales, { pesajes: 1, anulados: 1 });
  });

  test('11b. anulación antigua tras un pull también aparece (marca nueva = anulado_at)', async () => {
    const e = await escenario();
    const antiguo = await insertarDirecto(e.org, e.animalId, { createdAt: '2025-01-01T00:00:00.000000Z' });
    const primero = await pullHttp(e.owner);
    assert.deepEqual(ids(primero.data.pesajes), [antiguo]);
    await anularDirecto(antiguo, new Date().toISOString().replace('Z', '000Z'));
    const segundo = await pullHttp(e.owner, primero.data.cursorSiguiente);
    assert.deepEqual(ids(segundo.data.pesajes), [antiguo]);
    assert.equal(segundo.data.pesajes[0].estadoRegistro, 'ANULADO');
  });

  test('11c. sin cambios, el solape solo re-entrega filas recientes; las antiguas no vuelven', async () => {
    const e = await escenario();
    const antiguo = await insertarDirecto(e.org, e.animalId, { createdAt: '2025-01-01T00:00:00.000000Z' });
    const reciente = await registrar(e);
    const primero = await pullHttp(e.owner);
    const segundo = await pullHttp(e.owner, primero.data.cursorSiguiente);
    assert.deepEqual(ids(segundo.data.pesajes), [reciente.pesajeId]);
    assert.equal(ids(segundo.data.pesajes).includes(antiguo), false);
  });

  test('12. cursor inválido: 400 INVALID_CURSOR determinista, no-store', async () => {
    const e = await escenario();
    const malos = ['x', 'a'.repeat(501), Buffer.from('{"v":1,"s":"pesajes"}').toString('base64url')];
    for (const cursor of malos) {
      const res = await pullHttp(e.owner, cursor);
      assert.equal(res.status, 400, cursor);
      assert.deepEqual(res.data, { error: 'INVALID_CURSOR', message: 'Cursor de sincronización inválido.' });
      assert.equal(res.cache, 'no-store');
    }
  });

  test('13. un cursor de otra organización no cambia el tenant: 400, nunca filas ajenas', async () => {
    const a = await escenario();
    const b = await escenario();
    await registrar(a);
    await registrar(b);
    const cursorDeA = (await pullHttp(a.owner)).data.cursorSiguiente;
    const res = await pullHttp(b.owner, cursorDeA);
    assert.equal(res.status, 400);
    assert.equal(res.data.error, 'INVALID_CURSOR');
    // Un cursor fabricado con la organización de A no sirve en la sesión de B.
    const fabricado = sync.encodeCursorPesajes(a.org, { c: '2026-10-20T15:00:00.123456Z' });
    assert.equal((await pullHttp(b.owner, fabricado)).status, 400);
    // Y el tenant tampoco viene de la query.
    const query = await peticion(`/api/ganaderia/sync/pesajes?organizacionId=${a.org}`, b.owner);
    assert.equal(query.status, 400);
    assert.equal(query.data.error, 'INVALID_QUERY');
  });

  test('17. otra operación de anulación no se confunde: cada fila trae SU anulacionClientOperationId', async () => {
    const e = await escenario();
    const p1 = await registrar(e, { pesoKg: 200 });
    const p2 = await registrar(e, { pesoKg: 205 });
    const an1 = await anular(e, p1.pesajeId, { motivo: 'Motivo uno' });
    const an2 = await anular(e, p2.pesajeId, { motivo: 'Motivo dos' });
    const filas = Object.fromEntries((await pullHttp(e.owner)).data.pesajes.map((p) => [p.pesajeId, p]));
    assert.equal(filas[p1.pesajeId].anulacionClientOperationId, an1.clientOperationId);
    assert.equal(filas[p1.pesajeId].anulacion.motivo, 'Motivo uno');
    assert.equal(filas[p2.pesajeId].anulacionClientOperationId, an2.clientOperationId);
    assert.equal(filas[p2.pesajeId].anulacion.motivo, 'Motivo dos');
    assert.notEqual(filas[p1.pesajeId].anulacionClientOperationId, filas[p2.pesajeId].anulacionClientOperationId);
    // El clientOperationId de creación nunca coincide con el de anulación.
    assert.notEqual(filas[p1.pesajeId].clientOperationId, filas[p1.pesajeId].anulacionClientOperationId);
  });

  test('solo lectura: el endpoint no admite mutaciones y corre en transacción read only', async () => {
    const e = await escenario();
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      assert.equal((await peticion('/api/ganaderia/sync/pesajes', e.owner, { method })).status, 404, method);
    }
  });

  test('los 4 roles leen sync (preparar dispositivo no depende de owner/admin)', async () => {
    const e = await escenario();
    await registrar(e);
    for (const rol of ['owner', 'admin', 'operador', 'lector']) {
      const res = await pullHttp(nuevaSesion(e.org, rol));
      assert.equal(res.status, 200, rol);
      assert.equal(res.data.pesajes.length, 1, rol);
    }
  });
});
