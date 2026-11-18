// FASE 5A.1b -- anulación auditada, serie diaria ACTIVA y fechas de pesajes
// contra rutas Express REALES y Postgres REAL (agx_app, RLS FORCE, 0028).
// Solo se simula la sesión (rol por cuenta): el plano de identidad no forma
// parte de esta base. Mismas variables que animalPesajesIntegration; se
// auto-omite si faltan o si 0028 no está aplicada (y el runner de la suite
// exige un mínimo de pruebas aprobadas: una omisión es un fallo).
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
import { validateCorregirAnimalBody, validateListAnimalesQuery } from '../ganaderia/animalValidation.js';
import { validateCierreBody } from '../ganaderia/cierreValidation.js';
import { resolveFechaHoyNegocio } from '../ganaderia/motorDescansoAuto/businessTimezone.js';

const CSRF = 'gwslZ1bKInXjQ0TLmMqWeV6vRAL2hONB6bTBqpAjVFs=';
const ORIGEN = 'https://agrogenomax.com';
const HOY = resolveFechaHoyNegocio();
const op = () => crypto.randomUUID();

let dbAvailable = false;
let adminPool;
let appPool;
let businessDb;
let qrAdminDb;
let crearRutaPesajes;
let animalesRepo;
let cierreRepo;
let reporte;
let alertas;

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
  appPool = new pg.Pool({ connectionString: app, max: 2 });
  const check = await adminPool.query(
    `select count(*)::int as n from information_schema.columns
      where table_schema = 'agx' and table_name = 'animal_pesajes' and column_name = 'estado_registro'`,
  );
  dbAvailable = check.rows[0].n === 1;
} catch {
  dbAvailable = false;
}

if (dbAvailable) {
  businessDb = await import('../../db/agxBusinessPool.js');
  qrAdminDb = await import('../../db/agxQrAdminPool.js');
  crearRutaPesajes = (await import('../../routes/ganaderiaAnimalPesajes.js')).default;
  animalesRepo = await import('../ganaderia/animalesRepository.js');
  cierreRepo = await import('../ganaderia/cierreRepository.js');
  reporte = await import('../ganaderia/reporteProductivo/reporteProductivoService.js');
  alertas = await import('../ganaderia/engine/alertasPesajes.js');
}

// cuentaId -> { organizacionId, rol }
const cuentas = new Map();
const sesiones = new Map();
let servidor;
let baseUrl;

function nuevaSesion(organizacionId, rol) {
  const cuentaId = crypto.randomUUID();
  const token = crypto.randomBytes(32).toString('base64url');
  sesiones.set(hashSessionSecret(token), { cuentaId, organizacionId, rol });
  cuentas.set(cuentaId, { organizacionId, rol });
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
      return { rows: [{ sesion_id: 's', cuenta_id: s.cuentaId, organizacion_id: s.organizacionId, rol: s.rol }] };
    }
    return { rows: [] };
  };
  const app = express();
  app.use(express.json());
  const config = { appEnv: 'development', csrfServerSecret: CSRF, allowedOrigins: [ORIGEN] };
  app.use('/api/ganaderia/animales/:animalId/pesajes', crearRutaPesajes(config));
  app.use(notFound);
  app.use(errorHandler);
  await new Promise((resolve) => { servidor = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${servidor.address().port}`;
});

after(async () => {
  await new Promise((resolve) => (servidor ? servidor.close(resolve) : resolve()));
  await adminPool?.end().catch(() => {});
  await appPool?.end().catch(() => {});
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
  return { status: res.status, data, text };
}

/** Organización con owner/admin/operador, predio y un animal (fechas opcionales). */
async function escenario({ fechaNacimiento = null, fechaIngreso = null } = {}) {
  const org = crypto.randomUUID();
  const { rows: [p] } = await adminPool.query(`insert into agx.predios (organizacion_id, nombre_predio, estado) values ($1, 'Predio 5A.1b', 'ACTIVO') returning predio_id`, [org]);
  const { rows: [a] } = await adminPool.query(
    `insert into agx.animales (organizacion_id, predio_id, sexo, client_operation_id, creation_intent_hash, numero_visual,
                               nacimiento_tipo, fecha_nacimiento, raza_tipo, origen_tipo, procedencia, fecha_ingreso)
     values ($1, $2, 'MACHO', gen_random_uuid(), 'v1:' || repeat('a', 64), $3, $4, $5, 'DESCONOCIDA', $6, $7, $8)
     returning animal_id::text as animal_id`,
    [org, p.predio_id, `P5-${op().slice(0, 8)}`, fechaNacimiento ? 'EXACTA' : 'DESCONOCIDA', fechaNacimiento,
      fechaIngreso ? 'COMPRADO' : null, fechaIngreso ? 'Feria QA' : null, fechaIngreso],
  );
  const owner = nuevaSesion(org, 'owner');
  return {
    org,
    animalId: a.animal_id,
    owner,
    admin: nuevaSesion(org, 'admin'),
    operador: nuevaSesion(org, 'operador'),
    ruta: `/api/ganaderia/animales/${a.animal_id}/pesajes`,
  };
}

async function registrar(e, fecha, pesoKg, sesion = e.operador) {
  const r = await peticion(e.ruta, sesion, { method: 'POST', body: { fecha, pesoKg, metodo: 'BASCULA', clientOperationId: op() } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data.pesaje.pesajeId;
}

const anular = (e, pesajeId, sesion, cuerpo = {}) => peticion(`${e.ruta}/${pesajeId}/anular`, sesion, {
  method: 'POST',
  body: { motivo: 'Error de digitación', clientOperationId: op(), ...cuerpo },
});

async function fila(pesajeId) {
  return (await adminPool.query(
    `select pesaje_id::text, organizacion_id::text, animal_id::text, to_char(fecha, 'YYYY-MM-DD') as fecha, peso_kg::text, metodo, origen,
            actor_cuenta_id::text, created_at, client_operation_id::text, observaciones,
            estado_registro, anulado_por::text, anulado_at, motivo_anulacion, anulacion_client_operation_id::text,
            (anulado_at between now() - interval '5 minutes' and now()) as anulado_reciente
       from agx.animal_pesajes where pesaje_id = $1`,
    [pesajeId],
  )).rows[0];
}

const ORIGINALES = ['pesaje_id', 'organizacion_id', 'animal_id', 'fecha', 'peso_kg', 'metodo', 'origen', 'actor_cuenta_id', 'created_at', 'client_operation_id', 'observaciones'];
const originales = (f) => Object.fromEntries(ORIGINALES.map((k) => [k, f[k] instanceof Date ? f[k].toISOString() : f[k]]));

async function expectSemantic(promise, code, status) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code, `se esperaba ${code}, llegó ${error.code}: ${error.message}`);
    if (status) assert.equal(error.status, status);
    return true;
  });
}

describe('FASE 5A.1b: anulación de pesajes (rutas y Postgres reales)', { skip: !dbAvailable }, () => {
  test('1/12. owner anula: 200, actor = sesión, instante del servidor, motivo y operación; el original no cambia', async () => {
    const e = await escenario();
    const id = await registrar(e, '2026-10-19', 350);
    const antes = await fila(id);
    const opId = op();
    const r = await anular(e, id, e.owner, { clientOperationId: opId, motivo: '  Error de digitación  ' });
    assert.equal(r.status, 200);
    assert.equal(r.data.yaExistia, false);
    assert.equal(r.data.pesaje.estadoRegistro, 'ANULADO');
    assert.equal(r.data.pesaje.anulacion.motivo, 'Error de digitación');
    assert.match(r.data.pesaje.anulacion.anuladoEn, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
    assert.equal(r.data.resumen.totalPesajes, 0);
    assert.equal(r.data.resumen.totalAnulados, 1);
    const despues = await fila(id);
    assert.equal(despues.estado_registro, 'ANULADO');
    assert.equal(despues.anulado_por, e.owner.cuentaId);
    assert.equal(despues.anulado_reciente, true, 'anulado_at = now() de Postgres');
    assert.equal(despues.motivo_anulacion, 'Error de digitación');
    assert.equal(despues.anulacion_client_operation_id, opId);
    assert.deepEqual(originales(despues), originales(antes));
    // Nunca se expone el actor ni los ids de operación.
    assert.equal(r.text.includes(e.owner.cuentaId), false);
    assert.equal(r.text.includes(opId), false);
  });

  test('2. admin anula (anulado_por = cuenta admin de la sesión)', async () => {
    const e = await escenario();
    const id = await registrar(e, '2026-10-19', 350);
    const r = await anular(e, id, e.admin);
    assert.equal(r.status, 200);
    assert.equal((await fila(id)).anulado_por, e.admin.cuentaId);
  });

  test('3. operador -> 403 ROLE_FORBIDDEN, sin escribir', async () => {
    const e = await escenario();
    const id = await registrar(e, '2026-10-19', 350);
    const r = await anular(e, id, e.operador);
    assert.equal(r.status, 403);
    assert.equal(r.data.error, 'ROLE_FORBIDDEN');
    assert.equal((await fila(id)).estado_registro, 'ACTIVO');
  });

  test('4. cross-tenant: 404 sin revelar existencia (animal ajeno o pesaje ajeno bajo animal propio)', async () => {
    const a = await escenario();
    const b = await escenario();
    const idA = await registrar(a, '2026-10-19', 350);
    const ajeno = await peticion(`${a.ruta}/${idA}/anular`, b.owner, { method: 'POST', body: { motivo: 'x', clientOperationId: op() } });
    assert.equal(ajeno.status, 404);
    assert.equal(ajeno.data.error, 'ANIMAL_NOT_FOUND');
    const cruzado = await peticion(`${b.ruta}/${idA}/anular`, b.owner, { method: 'POST', body: { motivo: 'x', clientOperationId: op() } });
    assert.equal(cruzado.status, 404);
    assert.equal(cruzado.data.error, 'PESAJE_NOT_FOUND');
    const inexistente = await peticion(`${b.ruta}/999999999/anular`, b.owner, { method: 'POST', body: { motivo: 'x', clientOperationId: op() } });
    assert.deepEqual([inexistente.status, inexistente.data.error], [404, 'PESAJE_NOT_FOUND'], 'mismo 404 que el pesaje ajeno');
    assert.equal((await fila(idA)).estado_registro, 'ACTIVO');
  });

  test('4b. pesaje de OTRO animal de la misma organización -> 404 PESAJE_NOT_FOUND (el pesaje pertenece al animal de la ruta)', async () => {
    const e = await escenario();
    const { rows: [otro] } = await adminPool.query(
      `insert into agx.animales (organizacion_id, predio_id, sexo, client_operation_id, creation_intent_hash, numero_visual, nacimiento_tipo, raza_tipo)
       select organizacion_id, predio_id, 'HEMBRA', gen_random_uuid(), 'v1:' || repeat('b', 64), $2, 'DESCONOCIDA', 'DESCONOCIDA'
         from agx.animales where animal_id = $1
       returning animal_id::text as animal_id`,
      [e.animalId, `P5-${op().slice(0, 8)}`],
    );
    const id = await registrar(e, '2026-10-19', 350);
    const r = await peticion(`/api/ganaderia/animales/${otro.animal_id}/pesajes/${id}/anular`, e.owner, { method: 'POST', body: { motivo: 'x', clientOperationId: op() } });
    assert.deepEqual([r.status, r.data.error], [404, 'PESAJE_NOT_FOUND']);
    assert.equal((await fila(id)).estado_registro, 'ACTIVO');
  });

  test('5. identidadEsperada distinta de la sesión -> 409 IDENTIDAD_NO_COINCIDE, sin escribir', async () => {
    const e = await escenario();
    const id = await registrar(e, '2026-10-19', 350);
    const r = await anular(e, id, e.owner, { identidadEsperada: { cuentaId: e.admin.cuentaId, organizacionId: e.org } });
    assert.equal(r.status, 409);
    assert.equal(r.data.error, 'IDENTIDAD_NO_COINCIDE');
    assert.equal((await fila(id)).estado_registro, 'ACTIVO');
    const ok = await anular(e, id, e.owner, { identidadEsperada: { cuentaId: e.owner.cuentaId, organizacionId: e.org } });
    assert.equal(ok.status, 200, 'la identidad correcta se acepta');
  });

  test('6. reintento de la MISMA anulación -> 200 yaExistia, sin reescribir anulado_at', async () => {
    const e = await escenario();
    const id = await registrar(e, '2026-10-19', 350);
    const cuerpo = { motivo: 'Duplicado', clientOperationId: op() };
    const r1 = await anular(e, id, e.owner, cuerpo);
    const t1 = (await fila(id)).anulado_at.toISOString();
    const r2 = await anular(e, id, e.owner, cuerpo);
    assert.deepEqual([r1.status, r1.data.yaExistia, r2.status, r2.data.yaExistia], [200, false, 200, true]);
    assert.equal((await fila(id)).anulado_at.toISOString(), t1);
    assert.deepEqual(r2.data.pesaje, r1.data.pesaje);
  });

  test('7/8. operación reutilizada con otro motivo u otro pesaje -> 409 CLIENT_OPERATION_ID_REUSED', async () => {
    const e = await escenario();
    const id1 = await registrar(e, '2026-10-19', 350);
    const id2 = await registrar(e, '2026-10-20', 355);
    const opId = op();
    assert.equal((await anular(e, id1, e.owner, { clientOperationId: opId, motivo: 'A' })).status, 200);
    const otroMotivo = await anular(e, id1, e.owner, { clientOperationId: opId, motivo: 'B' });
    assert.deepEqual([otroMotivo.status, otroMotivo.data.error], [409, 'CLIENT_OPERATION_ID_REUSED']);
    const otroPesaje = await anular(e, id2, e.owner, { clientOperationId: opId, motivo: 'A' });
    assert.deepEqual([otroPesaje.status, otroPesaje.data.error], [409, 'CLIENT_OPERATION_ID_REUSED']);
    assert.equal((await fila(id2)).estado_registro, 'ACTIVO');
  });

  test('9. id de una operación de REGISTRO reutilizado para ANULAR -> 409, sin escribir', async () => {
    const e = await escenario();
    const opRegistro = op();
    const r = await peticion(e.ruta, e.operador, { method: 'POST', body: { fecha: '2026-10-19', pesoKg: 350, metodo: 'BASCULA', clientOperationId: opRegistro } });
    assert.equal(r.status, 201);
    const a = await anular(e, r.data.pesaje.pesajeId, e.owner, { clientOperationId: opRegistro });
    assert.deepEqual([a.status, a.data.error], [409, 'CLIENT_OPERATION_ID_REUSED']);
    assert.equal((await fila(r.data.pesaje.pesajeId)).estado_registro, 'ACTIVO');
  });

  test('10. id de una ANULACIÓN reutilizado para REGISTRAR -> 409, sin escribir', async () => {
    const e = await escenario();
    const id = await registrar(e, '2026-10-19', 350);
    const opAnular = op();
    assert.equal((await anular(e, id, e.owner, { clientOperationId: opAnular })).status, 200);
    const r = await peticion(e.ruta, e.operador, { method: 'POST', body: { fecha: '2026-10-20', pesoKg: 360, metodo: 'BASCULA', clientOperationId: opAnular } });
    assert.deepEqual([r.status, r.data.error], [409, 'CLIENT_OPERATION_ID_REUSED']);
    assert.equal((await adminPool.query('select count(*)::int as n from agx.animal_pesajes where animal_id = $1', [e.animalId])).rows[0].n, 1);
  });

  test('11. pesaje ya ANULADO con otra operación -> 409 PESAJE_YA_ANULADO; la anulación original se conserva', async () => {
    const e = await escenario();
    const id = await registrar(e, '2026-10-19', 350);
    assert.equal((await anular(e, id, e.owner, { motivo: 'Primero' })).status, 200);
    const r = await anular(e, id, e.admin, { motivo: 'Segundo' });
    assert.deepEqual([r.status, r.data.error], [409, 'PESAJE_YA_ANULADO']);
    const f = await fila(id);
    assert.deepEqual([f.motivo_anulacion, f.anulado_por], ['Primero', e.owner.cuentaId]);
  });

  test('13/14/19. GET: `pesajes` solo ACTIVOS, `historial` con el ANULADO; serie diaria (último del día)', async () => {
    const e = await escenario();
    const id350 = await registrar(e, '2026-10-19', 350);
    const id355 = await registrar(e, '2026-10-20', 355);
    const id360 = await registrar(e, '2026-10-20', 360);
    let g = (await peticion(e.ruta, e.operador)).data;
    // 19: ambos activos el 20/10 -> el último (360) representa la fecha.
    assert.deepEqual([g.resumen.ultimoPesoKg, g.resumen.pesoAnteriorKg, g.resumen.diferenciaKg, g.resumen.diasDesdeAnterior, g.resumen.gmdKgDia], [360, 350, 10, 1, 10]);
    assert.deepEqual(g.resumen.mismoDia, { fecha: '2026-10-20', mediciones: 2, primerPesoKg: 355, ultimoPesoKg: 360, diferenciaKg: 5 });
    assert.deepEqual(g.resumen.gananciaAcumulada.gananciaKg, 10);
    assert.equal(g.pesajes.find((p) => p.pesajeId === id355).gmdKgDia, null);
    // Anular 355 (13/14).
    assert.equal((await anular(e, id355, e.owner)).status, 200);
    const r = await peticion(e.ruta, e.operador);
    g = r.data;
    assert.deepEqual(g.pesajes.map((p) => p.pesajeId), [id350, id360]);
    assert.ok(g.pesajes.every((p) => p.estadoRegistro === 'ACTIVO'));
    assert.deepEqual(g.historial.map((p) => `${p.pesajeId}:${p.estadoRegistro}`), [`${id350}:ACTIVO`, `${id355}:ANULADO`, `${id360}:ACTIVO`]);
    const anulado = g.historial.find((p) => p.pesajeId === id355);
    assert.equal(anulado.anulacion.motivo, 'Error de digitación');
    assert.equal(anulado.gmdKgDia, null);
    assert.equal(g.resumen.totalPesajes, 2);
    assert.equal(g.resumen.totalAnulados, 1);
    assert.equal(g.resumen.mismoDia, null, 'sin mediciones múltiples activas');
    assert.doesNotMatch(r.text, /anulado_?por|anuladoPor|clientOperationId|client_operation_id/i);
    assert.equal(r.text.includes(e.owner.cuentaId), false);
  });

  test('15. el último peso (ficha/listado y GET) cambia al anular el último pesaje ACTIVO', async () => {
    const e = await escenario();
    await registrar(e, '2026-10-19', 350);
    const id360 = await registrar(e, '2026-10-21', 360);
    assert.equal((await animalesRepo.getAnimal(e.org, e.animalId)).ultimoPeso.pesoKg, 360);
    assert.equal((await anular(e, id360, e.owner)).status, 200);
    const animal = await animalesRepo.getAnimal(e.org, e.animalId);
    assert.deepEqual([animal.ultimoPeso.pesoKg, animal.ultimoPeso.fecha], [350, '2026-10-19']);
    const lista = await animalesRepo.listAnimales(e.org, validateListAnimalesQuery({}));
    assert.equal(lista.animales.find((x) => String(x.animalId) === e.animalId).ultimoPeso.pesoKg, 350);
    assert.equal((await peticion(e.ruta, e.operador)).data.resumen.ultimoPesoKg, 350);
  });

  test('16. el cierre ignora pesajes ANULADOS como límite de fecha', async () => {
    const e = await escenario();
    await registrar(e, '2026-10-19', 350);
    const tardio = await registrar(e, '2026-10-25', 352);
    const salida = (fecha) => validateCierreBody('SALIDA', { fechaSalida: fecha, motivoSalida: 'VENTA', clientOperationId: op() }, { hoy: HOY });
    await expectSemantic(cierreRepo.registrarCierreIdempotente(e.org, e.animalId, salida('2026-10-22'), { actorCuentaId: e.owner.cuentaId }), 'INVALID_FECHA', 400);
    assert.equal((await anular(e, tardio, e.owner)).status, 200);
    const r = await cierreRepo.registrarCierreIdempotente(e.org, e.animalId, salida('2026-10-22'), { actorCuentaId: e.owner.cuentaId });
    assert.equal(r.yaExistia, false);
  });

  test('17/18. PDF: resumen sin el ANULADO; historial lo muestra con estado, fecha y motivo, sin actor', async () => {
    const e = await escenario();
    await registrar(e, '2026-10-19', 350);
    const id360 = await registrar(e, '2026-10-21', 360);
    assert.equal((await anular(e, id360, e.owner, { motivo: 'Báscula descalibrada' })).status, 200);
    const { modelo } = await reporte.generarReporteProductivo(e.org, e.animalId);
    const valor = (etiqueta) => modelo.resumen.find((x) => x.etiqueta === etiqueta)?.valor;
    assert.equal(valor('Pesajes registrados'), '1');
    assert.equal(valor('Último peso'), '350 kg (báscula)');
    assert.equal(valor('Ganancia acumulada'), 'Sin dato');
    assert.equal(modelo.historial.filas.length, 2);
    const filaAnulada = modelo.historial.filas.find((f) => f[0] === '21/10/2026');
    assert.match(filaAnulada[6], /^ANULADO el \d{2}\/\d{2}\/\d{4}\. Motivo: Báscula descalibrada$/);
    assert.deepEqual(filaAnulada.slice(3, 6), ['—', '—', '—']);
    assert.equal(modelo.graficaPeso.puntos.length, 1, 'la gráfica no incluye el anulado');
    assert.equal(JSON.stringify(modelo).includes(e.owner.cuentaId), false);
  });

  test('20. pérdida el mismo día -> PESAJE_MISMO_DIA (INFO) con diferencia negativa, sin GMD inventada', async () => {
    const e = await escenario();
    await registrar(e, '2026-10-19', 350);
    await registrar(e, '2026-10-20', 355);
    await registrar(e, '2026-10-20', 340);
    const g = (await peticion(e.ruta, e.operador)).data;
    assert.deepEqual(g.resumen.mismoDia, { fecha: '2026-10-20', mediciones: 2, primerPesoKg: 355, ultimoPesoKg: 340, diferenciaKg: -15 });
    assert.deepEqual([g.resumen.ultimoPesoKg, g.resumen.diferenciaKg, g.resumen.diasDesdeAnterior], [340, -10, 1]);
    const lista = alertas.construirAlertasPesajes({ pesajes: g.pesajes, resumen: g.resumen, fechaReferencia: '2026-10-21' });
    const md = lista.find((a) => a.codigo === 'PESAJE_MISMO_DIA');
    assert.equal(md.severidad, 'INFO');
    assert.equal(md.datos.diferenciaKg, -15);
    assert.match(md.mensaje, /\(-15 kg\)/);
  });

  test('21/22. fecha anterior a nacimiento / ingreso -> 400; si viola ambas, NACIMIENTO (orden determinista)', async () => {
    const e = await escenario({ fechaNacimiento: '2024-01-10', fechaIngreso: '2024-06-01' });
    const post = (fecha) => peticion(e.ruta, e.operador, { method: 'POST', body: { fecha, pesoKg: 100, metodo: 'BASCULA', clientOperationId: op() } });
    let r = await post('2024-01-09');
    assert.deepEqual([r.status, r.data.error], [400, 'FECHA_ANTERIOR_A_NACIMIENTO'], 'viola ambas: se informa nacimiento');
    r = await post('2024-03-01');
    assert.deepEqual([r.status, r.data.error], [400, 'FECHA_ANTERIOR_A_INGRESO']);
    r = await post('2024-06-01');
    assert.equal(r.status, 201, 'la fecha de ingreso es válida (igualdad)');
    const soloNacimiento = await escenario({ fechaNacimiento: '2024-01-10' });
    r = await peticion(soloNacimiento.ruta, soloNacimiento.operador, { method: 'POST', body: { fecha: '2024-01-01', pesoKg: 40, metodo: 'BASCULA', clientOperationId: op() } });
    assert.deepEqual([r.status, r.data.error], [400, 'FECHA_ANTERIOR_A_NACIMIENTO']);
    assert.equal((await adminPool.query('select count(*)::int as n from agx.animal_pesajes where animal_id = $1', [soloNacimiento.animalId])).rows[0].n, 0);
  });

  async function corregir(e, cuerpo) {
    const animal = await animalesRepo.getAnimal(e.org, e.animalId);
    const value = validateCorregirAnimalBody({ fechaActualizacionEsperada: animal.fechaActualizacion, ...cuerpo }, { hoy: HOY });
    return animalesRepo.corregirAnimal(e.org, e.animalId, value, { actorCuentaId: e.owner.cuentaId });
  }

  test('23/24/25. corregir nacimiento/ingreso posterior al primer pesaje ACTIVO -> 409; un ANULADO no restringe', async () => {
    const e = await escenario({ fechaNacimiento: '2024-01-10', fechaIngreso: '2024-06-01' });
    const primero = await registrar(e, '2024-07-01', 150);
    await registrar(e, '2024-09-01', 200);
    await expectSemantic(
      corregir(e, { nacimientoTipo: 'EXACTA', fechaNacimiento: '2024-07-02', edadAproximadaMeses: null, origenTipo: 'COMPRADO', procedencia: 'Feria QA', fechaIngreso: '2024-07-02' }),
      'HISTORIAL_PESAJES_FECHA_INCOMPATIBLE', 409,
    );
    // 23: solo nacimiento (animal sin ingreso, para aislar la regla de pesajes).
    const n = await escenario({ fechaNacimiento: '2024-01-10' });
    await registrar(n, '2024-03-01', 80);
    await expectSemantic(corregir(n, { nacimientoTipo: 'EXACTA', fechaNacimiento: '2024-03-02', edadAproximadaMeses: null }), 'HISTORIAL_PESAJES_FECHA_INCOMPATIBLE', 409);
    await corregir(n, { nacimientoTipo: 'EXACTA', fechaNacimiento: '2024-03-01', edadAproximadaMeses: null });
    // 24: solo ingreso.
    await expectSemantic(corregir(e, { origenTipo: 'COMPRADO', procedencia: 'Feria QA', fechaIngreso: '2024-07-15' }), 'HISTORIAL_PESAJES_FECHA_INCOMPATIBLE', 409);
    // Igual al primer pesaje: válido.
    await corregir(e, { origenTipo: 'COMPRADO', procedencia: 'Feria QA', fechaIngreso: '2024-07-01' });
    // 25: anulado el primer pesaje, el límite pasa al siguiente ACTIVO; el anulado no se toca.
    assert.equal((await anular(e, primero, e.owner, { motivo: 'Animal equivocado' })).status, 200);
    const antes = await fila(primero);
    await corregir(e, { origenTipo: 'COMPRADO', procedencia: 'Feria QA', fechaIngreso: '2024-08-01' });
    assert.equal((await animalesRepo.getAnimal(e.org, e.animalId)).fechaIngreso, '2024-08-01');
    assert.deepEqual(await fila(primero), antes);
    await expectSemantic(corregir(e, { origenTipo: 'COMPRADO', procedencia: 'Feria QA', fechaIngreso: '2024-09-02' }), 'HISTORIAL_PESAJES_FECHA_INCOMPATIBLE', 409);
  });

  test('26. concurrencia: dos anulaciones distintas del mismo pesaje -> una 200 y otra 409; la misma operación dos veces -> una sola escritura', async () => {
    const e = await escenario();
    const id = await registrar(e, '2026-10-19', 350);
    const [a, b] = await Promise.all([anular(e, id, e.owner, { motivo: 'A' }), anular(e, id, e.admin, { motivo: 'B' })]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    assert.equal([a, b].find((x) => x.status === 409).data.error, 'PESAJE_YA_ANULADO');
    const id2 = await registrar(e, '2026-10-20', 351);
    const cuerpo = { motivo: 'Mismo', clientOperationId: op() };
    const [c, d] = await Promise.all([anular(e, id2, e.owner, cuerpo), anular(e, id2, e.owner, cuerpo)]);
    assert.deepEqual([c.status, d.status], [200, 200]);
    assert.deepEqual([c.data.yaExistia, d.data.yaExistia].sort(), [false, true]);
    // Registrar y anular con el mismo id a la vez: el lock común deja pasar exactamente una.
    const id3 = await registrar(e, '2026-10-21', 352);
    const comun = op();
    const [x, y] = await Promise.all([
      anular(e, id3, e.owner, { clientOperationId: comun }),
      peticion(e.ruta, e.operador, { method: 'POST', body: { fecha: '2026-10-22', pesoKg: 353, metodo: 'BASCULA', clientOperationId: comun } }),
    ]);
    assert.deepEqual([x.status, y.status].filter((s) => s === 409).length, 1, `${x.status}/${y.status}`);
    const usos = (await adminPool.query(
      `select count(*)::int as n from agx.animal_pesajes where organizacion_id = $1 and ($2::uuid in (client_operation_id, anulacion_client_operation_id))`,
      [e.org, comun],
    )).rows[0].n;
    assert.equal(usos, 1);
  });

  test('27/28. RLS y sin DELETE: agx_app de otra organización no ve ni anula; DELETE denegado', async () => {
    const a = await escenario();
    const b = await escenario();
    const id = await registrar(a, '2026-10-19', 350);
    const client = await appPool.connect();
    try {
      await client.query('begin');
      await client.query("select set_config('app.current_org_id', $1, true)", [b.org]);
      assert.equal((await client.query('select 1 from agx.animal_pesajes where pesaje_id = $1', [id])).rowCount, 0);
      const upd = await client.query(
        `update agx.animal_pesajes set estado_registro = 'ANULADO', anulado_por = $2, anulado_at = now(), motivo_anulacion = 'x', anulacion_client_operation_id = $3 where pesaje_id = $1`,
        [id, b.owner.cuentaId, op()],
      );
      assert.equal(upd.rowCount, 0);
      await client.query('rollback');
      await client.query('begin');
      await client.query("select set_config('app.current_org_id', $1, true)", [a.org]);
      await assert.rejects(client.query('delete from agx.animal_pesajes where pesaje_id = $1', [id]), { code: '42501' });
    } finally {
      await client.query('rollback').catch(() => {});
      client.release();
    }
    await assert.rejects(adminPool.query('delete from agx.animal_pesajes where pesaje_id = $1', [id]), /no admite DELETE/);
    assert.equal((await fila(id)).estado_registro, 'ACTIVO');
  });

  test('animal SALIDO admite anular (corrección de historia); animal ANULADO -> 409 ANIMAL_ANULADO', async () => {
    const e = await escenario();
    const id1 = await registrar(e, '2026-10-19', 350);
    const id2 = await registrar(e, '2026-10-20', 352);
    const salida = validateCierreBody('SALIDA', { fechaSalida: '2026-10-21', motivoSalida: 'VENTA', clientOperationId: op() }, { hoy: HOY });
    await cierreRepo.registrarCierreIdempotente(e.org, e.animalId, salida, { actorCuentaId: e.owner.cuentaId });
    assert.equal((await anular(e, id1, e.owner)).status, 200);
    await animalesRepo.anularAnimal(e.org, e.animalId, { motivo: 'Registro duplicado', actorCuentaId: e.owner.cuentaId });
    const r = await anular(e, id2, e.owner);
    assert.deepEqual([r.status, r.data.error], [409, 'ANIMAL_ANULADO']);
  });
});
