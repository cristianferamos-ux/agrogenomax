// FASE 2A -- cierre operativo (salida / muerte) contra un Postgres/PostGIS
// REAL (0000-0025): migración (CHECKs, trigger, grants, RLS+FORCE, rollback),
// transición atómica con evento y revocación de chapeta QR, idempotencia
// (secuencial y concurrente), concurrencia entre cierres, guardas de
// pesajes/QR/corrección, aislamiento por organización y línea de tiempo.
//
// Los valores pasan por validateCierreBody (misma normalización que la ruta
// HTTP). Lee EXCLUSIVAMENTE AGX_BUSINESS_DATABASE_URL_TEST (agx_app),
// AGX_BUSINESS_QR_ADMIN_DATABASE_URL_TEST (agx_qr_admin) y
// AGX_BUSINESS_INTEGRATION_ADMIN_DATABASE_URL; se auto-omite si faltan o si
// 0025 no está aplicada.
delete process.env.AGX_BUSINESS_DATABASE_URL;
delete process.env.AGX_BUSINESS_QR_ADMIN_DATABASE_URL;

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { validateCreateAnimalBody, validateCorregirAnimalBody } from '../ganaderia/animalValidation.js';
import { validateCreatePesajeBody } from '../ganaderia/pesajeValidation.js';
import { validateCierreBody } from '../ganaderia/cierreValidation.js';
import { resolveFechaHoyNegocio } from '../ganaderia/motorDescansoAuto/businessTimezone.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.resolve(__dirname, '..', '..', '..', 'db', 'agx-business', 'migrations');

let dbAvailable = false;
let adminPool;
let appPool;
let animalesRepo;
let cierreRepo;
let chapetasRepo;
let inventario;
let pesajes;
let timeline;
let businessDb;
let qrAdminDb;

try {
  const testConnectionString = process.env.AGX_BUSINESS_DATABASE_URL_TEST;
  const adminConnectionString = process.env.AGX_BUSINESS_INTEGRATION_ADMIN_DATABASE_URL;
  const qrAdminConnectionString = process.env.AGX_BUSINESS_QR_ADMIN_DATABASE_URL_TEST;
  if (!testConnectionString || !adminConnectionString || !qrAdminConnectionString) throw new Error('conexiones de prueba no configuradas');
  process.env.AGX_BUSINESS_DATABASE_URL = testConnectionString;
  process.env.AGX_BUSINESS_QR_ADMIN_DATABASE_URL = qrAdminConnectionString;
  process.env.AGX_QR_TOKEN_ENCRYPTION_KEY = process.env.AGX_QR_TOKEN_ENCRYPTION_KEY_TEST || crypto.randomBytes(32).toString('base64');
  const { getConfig } = await import('../../config/env.js');
  getConfig({ APP_ENV: 'development' }, {});
  adminPool = new pg.Pool({ connectionString: adminConnectionString, max: 2 });
  appPool = new pg.Pool({ connectionString: testConnectionString, max: 2 });
  const check = await adminPool.query(
    `select count(*)::int as n from information_schema.columns
      where table_schema = 'agx' and table_name = 'animales' and column_name = 'estado_operativo'`,
  );
  dbAvailable = check.rows[0].n === 1;
} catch {
  dbAvailable = false;
}

if (dbAvailable) {
  animalesRepo = await import('../ganaderia/animalesRepository.js');
  cierreRepo = await import('../ganaderia/cierreRepository.js');
  chapetasRepo = await import('../ganaderia/qrChapetasRepository.js');
  inventario = await import('../ganaderia/qrInventarioRepository.js');
  pesajes = await import('../ganaderia/pesajesService.js');
  timeline = await import('../ganaderia/timeline/timelineService.js');
  businessDb = await import('../../db/agxBusinessPool.js');
  qrAdminDb = await import('../../db/agxQrAdminPool.js');
}

after(async () => {
  await adminPool?.end().catch(() => {});
  await appPool?.end().catch(() => {});
  businessDb?.closeAgxBusinessPool?.();
  await qrAdminDb?.closeAgxQrAdminPool?.();
});

const HOY = resolveFechaHoyNegocio();
const ACTOR = '00000000-0000-4000-8000-0000000000aa';
const SUPERADMIN = { actorCuentaId: '00000000-0000-4000-8000-0000000000ad' };

async function seedAnimal(org, extra = {}) {
  const predio = await adminPool.query(
    `insert into agx.predios (organizacion_id, nombre_predio, estado) values ($1, 'Predio FASE 2A', 'ACTIVO') returning predio_id`,
    [org],
  );
  const body = validateCreateAnimalBody({
    clientOperationId: crypto.randomUUID(),
    predioId: String(predio.rows[0].predio_id),
    numeroVisual: `C-${crypto.randomUUID().slice(0, 8)}`,
    sexo: 'HEMBRA',
    nacimientoTipo: 'DESCONOCIDA',
    razaTipo: 'DESCONOCIDA',
    ...extra,
  }, { hoy: HOY });
  const { animal } = await animalesRepo.createAnimalIdempotente(org, body, { actorCuentaId: ACTOR });
  return animal.animalId;
}

async function chapetaDe(org) {
  const lote = (await inventario.crearLote(
    { cantidad: 2, proveedor: 'Proveedor prueba', observaciones: null, urlBase: 'https://agrogenomax.test', clientOperationId: crypto.randomUUID() },
    SUPERADMIN,
  )).lote;
  await inventario.cambiarEstadoLote(lote.loteId, 'EN_FABRICACION', SUPERADMIN);
  await inventario.cambiarEstadoLote(lote.loteId, 'EN_STOCK', SUPERADMIN);
  await inventario.asignarChapetas(lote.loteId, { organizacionId: org, referencia: 'Plan prueba', clientOperationId: crypto.randomUUID() }, SUPERADMIN);
  return (await inventario.exportLoteProveedor(lote.loteId)).chapetas.map((c) => c.codigoVisible);
}

const salida = (extra = {}) => validateCierreBody('SALIDA', { fechaSalida: '2026-01-15', motivoSalida: 'VENTA', clientOperationId: crypto.randomUUID(), ...extra }, { hoy: HOY });
const muerte = (extra = {}) => validateCierreBody('MUERTE', { fechaMuerte: '2026-01-15', causaMuerte: 'ENFERMEDAD', clientOperationId: crypto.randomUUID(), ...extra }, { hoy: HOY });
const cerrar = (org, animalId, value) => cierreRepo.registrarCierreIdempotente(org, animalId, value, { actorCuentaId: ACTOR });
const pesar = (org, animalId, fecha) => pesajes.registrarPesaje(
  org, animalId, validateCreatePesajeBody({ fecha, pesoKg: 300, metodo: 'BASCULA', clientOperationId: crypto.randomUUID() }, { hoy: HOY }), { actorCuentaId: ACTOR },
);

async function expectSemantic(promise, code, status) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code, `se esperaba ${code}, llegó ${error.code}: ${error.message}`);
    if (status) assert.equal(error.status, status);
    return true;
  });
}

async function huella(animalId) {
  return (await adminPool.query(
    `select a.estado, a.estado_operativo, a.cierre_fecha::text, a.cierre_causa, a.updated_at::text,
            (select count(*) from agx.animal_eventos e where e.animal_id = a.animal_id)::int as eventos,
            (select string_agg(c.estado, ',' order by c.qr_id) from agx.qr_chapetas c where c.animal_id = a.animal_id) as qr,
            (select count(*) from agx.qr_chapeta_eventos ce join agx.qr_chapetas c using (qr_id) where c.animal_id = a.animal_id)::int as qr_eventos
       from agx.animales a where a.animal_id = $1`,
    [animalId],
  )).rows[0];
}

/** Ejecuta `sql` como agx_app con app.current_org_id = orgId (transacción revertida). */
async function asApp(orgId, sql, params = []) {
  const client = await appPool.connect();
  try {
    await client.query('BEGIN');
    await client.query("select set_config('app.current_org_id', $1, true)", [orgId]);
    return await client.query(sql, params);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}

describe('FASE 2A: migración 0025', { skip: !dbAvailable }, () => {
  test('1. columnas, CHECKs, índices, trigger y grants; RLS ENABLE + FORCE intactos', async () => {
    const cols = (await adminPool.query(
      `select column_name, is_nullable, column_default from information_schema.columns
        where table_schema = 'agx' and table_name = 'animales' and (column_name like 'cierre%' or column_name = 'estado_operativo')
        order by column_name`,
    )).rows;
    assert.deepEqual(cols.map((c) => c.column_name), [
      'cierre_at', 'cierre_causa', 'cierre_client_operation_id', 'cierre_fecha', 'cierre_observaciones', 'cierre_por', 'estado_operativo',
    ]);
    const estadoOperativo = cols.find((c) => c.column_name === 'estado_operativo');
    assert.equal(estadoOperativo.is_nullable, 'NO');
    assert.match(estadoOperativo.column_default, /EN_HATO/);
    const constraints = (await adminPool.query(
      `select conname from pg_constraint where conrelid = 'agx.animales'::regclass and conname like 'animales_%cierre%' or conname = 'animales_estado_operativo_check'`,
    )).rows.map((r) => r.conname).sort();
    assert.deepEqual(constraints, [
      'animales_cierre_consistency_check', 'animales_cierre_fecha_min_check', 'animales_cierre_fecha_orden_check',
      'animales_cierre_observaciones_check', 'animales_estado_operativo_check',
    ]);
    const indices = (await adminPool.query(
      `select indexname from pg_indexes where schemaname = 'agx' and indexname in ('animales_org_cierre_client_operation_key', 'animal_eventos_un_cierre_idx')`,
    )).rows;
    assert.equal(indices.length, 2);
    const trigger = await adminPool.query(`select 1 from pg_trigger where tgname = 'animales_cierre_guard' and not tgisinternal`);
    assert.equal(trigger.rowCount, 1);
    const rls = (await adminPool.query(
      `select relname, relrowsecurity, relforcerowsecurity from pg_class where oid in ('agx.animales'::regclass, 'agx.animal_eventos'::regclass)`,
    )).rows;
    for (const r of rls) assert.ok(r.relrowsecurity && r.relforcerowsecurity, r.relname);
    const grants = (await adminPool.query(
      `select column_name from information_schema.column_privileges
        where table_schema = 'agx' and table_name = 'animales' and grantee = 'agx_app' and privilege_type = 'UPDATE'
          and (column_name like 'cierre%' or column_name = 'estado_operativo')`,
    )).rows;
    assert.equal(grants.length, 7);
    const anteriores = (await adminPool.query(`select count(*)::int as n from agx.animales where estado_operativo <> 'EN_HATO' and cierre_fecha is null`)).rows[0].n;
    assert.equal(anteriores, 0);
  });

  test('2. trigger: sin reapertura, sin SALIDO -> MUERTO y cierre inmutable (también con UPDATE directo de agx_app)', async () => {
    const org = crypto.randomUUID();
    const animalId = await seedAnimal(org);
    await cerrar(org, animalId, salida());
    for (const sql of [
      "update agx.animales set estado_operativo = 'EN_HATO', cierre_fecha = null, cierre_causa = null, cierre_at = null, cierre_por = null, cierre_client_operation_id = null where animal_id = $1",
      "update agx.animales set estado_operativo = 'MUERTO', cierre_causa = 'ENFERMEDAD' where animal_id = $1",
      "update agx.animales set cierre_causa = 'DONACION' where animal_id = $1",
      "update agx.animales set cierre_fecha = date '2026-01-10' where animal_id = $1",
    ]) {
      await assert.rejects(asApp(org, sql, [animalId]), (e) => e.code === '23514', sql);
    }
    await assert.rejects(
      asApp(org, "insert into agx.animal_eventos (organizacion_id, animal_id, tipo_evento, metadata_json, actor_cuenta_id) values ($1, $2, 'MUERTO', '{}', $3)", [org, animalId, ACTOR]),
      (e) => e.code === '23505',
      'como mucho un evento de cierre por animal',
    );
  });
});

// Sin DB (mismo criterio que 0022): ejecutar DDL de rollback contra la base
// compartida choca con los otros archivos de integración que corren en
// paralelo. El rollback real se ejecutó contra Postgres desechable (informe 2A).
describe('FASE 2A: 0025 es aditiva y su rollback es exacto (sin DB)', () => {
  test('3. el rollback revierte cada objeto de 0025 y no borra datos de cierre', () => {
    const sinComentarios = (sql) => sql.replace(/--.*$/gm, '');
    const forward = sinComentarios(fs.readFileSync(path.join(MIGRATIONS, '0025_animal_cierre_operativo.sql'), 'utf8'));
    const rollback = sinComentarios(fs.readFileSync(path.join(MIGRATIONS, '0025_animal_cierre_operativo_rollback.sql'), 'utf8'));
    assert.doesNotMatch(forward, /drop (table|column)|delete from|truncate/i, 'forward aditiva');
    const columnas = [...forward.matchAll(/add column (\w+)/g)].map((m) => m[1]).sort();
    assert.deepEqual([...rollback.matchAll(/drop column if exists (\w+)/g)].map((m) => m[1]).sort(), columnas);
    const constraints = [...forward.matchAll(/add constraint (animales_\w+)/g)].map((m) => m[1]).sort();
    assert.deepEqual([...rollback.matchAll(/drop constraint if exists (animales_\w+)/g)].map((m) => m[1]).sort(), constraints);
    for (const objeto of ['animales_org_cierre_client_operation_key', 'animal_eventos_un_cierre_idx', 'animales_cierre_guard', 'agx.fn_animales_cierre_guard']) {
      assert.ok(rollback.includes(objeto), objeto);
    }
    assert.match(rollback, /revoke update \(/);
    assert.match(rollback, /'REGISTRADO', 'DATOS_CORREGIDOS', 'ANULADO',\s+'QR_ASOCIADO', 'QR_REVOCADO', 'QR_REEMPLAZADO'\s+\)\);/);
    assert.doesNotMatch(rollback, /delete from|truncate|update agx/i, 'nunca borra cierres reales: si existen, el CHECK falla');
  });
});

describe('FASE 2A: salida y muerte con Postgres real', { skip: !dbAvailable }, () => {
  test('4. salida válida: estado, evento con metadata mínima, chapeta revocada, línea de tiempo', async () => {
    const org = crypto.randomUUID();
    const animalId = await seedAnimal(org, { origenTipo: 'COMPRADO', fechaIngreso: '2025-06-01' });
    const [codigo] = await chapetaDe(org);
    await chapetasRepo.asociarChapetaAAnimal(org, animalId, codigo, { actorCuentaId: ACTOR });
    await pesar(org, animalId, '2026-01-10');

    const value = salida({ observaciones: '  Vendido a   feria ' });
    const r = await cerrar(org, animalId, value);
    assert.equal(r.yaExistia, false);
    assert.equal(r.animal.estado, 'ACTIVO');
    assert.equal(r.animal.estadoOperativo, 'SALIDO');
    assert.deepEqual({ ...r.animal.cierre, registradoEn: undefined }, { tipo: 'SALIDA', fecha: '2026-01-15', causa: 'VENTA', observaciones: 'Vendido a   feria', registradoEn: undefined });
    assert.equal(r.evento.tipo, 'SALIDO');
    assert.equal(r.evento.fecha, '2026-01-15');
    assert.equal(r.evento.causa, 'VENTA');
    assert.doesNotMatch(JSON.stringify(r), /clientOperationId|cierre_client|cierrePor|organizacion/i);

    const evento = (await adminPool.query(`select metadata_json from agx.animal_eventos where animal_id = $1 and tipo_evento = 'SALIDO'`, [animalId])).rows;
    assert.equal(evento.length, 1);
    assert.deepEqual(evento[0].metadata_json, { fecha: '2026-01-15', motivo: 'VENTA', observaciones: 'Vendido a   feria' });

    const h = await huella(animalId);
    assert.equal(h.qr, 'REVOCADO');
    const qrEvento = (await adminPool.query(
      `select metadata_json from agx.animal_eventos where animal_id = $1 and tipo_evento = 'QR_REVOCADO'`, [animalId],
    )).rows[0].metadata_json;
    assert.equal(qrEvento.causa, 'ANIMAL_SALIDO');
    assert.equal(qrEvento.codigoVisible, codigo);
    const resolucion = await chapetasRepo.resolverChapeta(org, { codigoVisible: codigo });
    assert.equal(resolucion.resultado, 'NO_OPERATIVA', 'la chapeta ya no abre la ficha como animal en el hato');

    const t = await timeline.obtenerTimelineAnimal(org, animalId, { limit: 50 });
    const salidas = t.eventos.filter((e) => e.tipo === 'ANIMAL_SALIDO');
    assert.equal(salidas.length, 1);
    assert.equal(salidas[0].fecha, '2026-01-15');
    assert.equal(salidas[0].descripcion, 'Motivo: Venta. Observaciones: Vendido a feria');
    const revocadas = t.eventos.filter((e) => e.tipo === 'QR_DESASIGNADO');
    assert.equal(revocadas.length, 1);
    assert.match(revocadas[0].descripcion, /revocada por salida del animal/);
    assert.equal(new Set(t.eventos.map((e) => e.id)).size, t.eventos.length);
  });

  test('5. muerte válida sin chapeta: evento MUERTO, sin efectos QR', async () => {
    const org = crypto.randomUUID();
    const animalId = await seedAnimal(org);
    const r = await cerrar(org, animalId, muerte({ causaMuerte: 'SACRIFICIO' }));
    assert.equal(r.animal.estadoOperativo, 'MUERTO');
    assert.equal(r.animal.cierre.tipo, 'MUERTE');
    assert.equal(r.evento.tipo, 'MUERTO');
    assert.equal(r.evento.causa, 'SACRIFICIO');
    const h = await huella(animalId);
    assert.equal(h.qr, null);
    assert.equal(h.qr_eventos, 0);
    const t = await timeline.obtenerTimelineAnimal(org, animalId, { limit: 50 });
    // El registro técnico es de hoy; la muerte, de su fecha efectiva anterior.
    assert.deepEqual(t.eventos.map((e) => [e.tipo, e.fecha]), [['ANIMAL_REGISTRADO', HOY], ['ANIMAL_MUERTO', '2026-01-15']]);
  });

  test('6. fecha anterior a nacimiento, ingreso o último pesaje -> 400 INVALID_FECHA sin escribir', async () => {
    const org = crypto.randomUUID();
    const nacido = await seedAnimal(org, { nacimientoTipo: 'EXACTA', fechaNacimiento: '2025-03-01' });
    const ingresado = await seedAnimal(org, { origenTipo: 'COMPRADO', fechaIngreso: '2025-08-01' });
    const pesado = await seedAnimal(org);
    await pesar(org, pesado, '2026-02-01');
    for (const [animalId, fecha] of [[nacido, '2025-02-28'], [ingresado, '2025-07-31'], [pesado, '2026-01-31']]) {
      const antes = await huella(animalId);
      await expectSemantic(cerrar(org, animalId, salida({ fechaSalida: fecha })), 'INVALID_FECHA', 400);
      await expectSemantic(cerrar(org, animalId, muerte({ fechaMuerte: fecha })), 'INVALID_FECHA', 400);
      assert.deepEqual(await huella(animalId), antes);
    }
    const r = await cerrar(org, pesado, muerte({ fechaMuerte: '2026-02-01' }));
    assert.equal(r.animal.estadoOperativo, 'MUERTO', 'el mismo día del último pesaje es válido');
  });

  test('7. anulado -> 409 ANIMAL_ANULADO; ya salido / ya muerto -> 409 (incluido SALIDO -> MUERTO)', async () => {
    const org = crypto.randomUUID();
    const anulado = await seedAnimal(org);
    await animalesRepo.anularAnimal(org, anulado, { motivo: 'Duplicado', actorCuentaId: ACTOR });
    await expectSemantic(cerrar(org, anulado, salida()), 'ANIMAL_ANULADO', 409);
    await expectSemantic(cerrar(org, anulado, muerte()), 'ANIMAL_ANULADO', 409);

    const salido = await seedAnimal(org);
    await cerrar(org, salido, salida());
    const antes = await huella(salido);
    await expectSemantic(cerrar(org, salido, salida()), 'ANIMAL_YA_SALIDO', 409);
    await expectSemantic(cerrar(org, salido, muerte()), 'ANIMAL_YA_SALIDO', 409);
    assert.deepEqual(await huella(salido), antes);

    const muerto = await seedAnimal(org);
    await cerrar(org, muerto, muerte());
    await expectSemantic(cerrar(org, muerto, muerte()), 'ANIMAL_YA_MUERTO', 409);
    await expectSemantic(cerrar(org, muerto, salida()), 'ANIMAL_YA_MUERTO', 409);
  });

  test('8. idempotencia: mismo id + misma intención -> yaExistia; datos distintos u otro animal -> 409 REUSED', async () => {
    const org = crypto.randomUUID();
    const animalId = await seedAnimal(org);
    const otro = await seedAnimal(org);
    const value = salida({ observaciones: 'Feria' });
    const primero = await cerrar(org, animalId, value);
    const antes = await huella(animalId);
    const reintento = await cerrar(org, animalId, { ...value });
    assert.equal(reintento.yaExistia, true);
    assert.deepEqual(reintento.evento, primero.evento);
    assert.equal(reintento.animal.estadoOperativo, 'SALIDO');
    assert.deepEqual(await huella(animalId), antes, 'el reintento no escribe');

    await expectSemantic(cerrar(org, animalId, { ...value, causa: 'DONACION' }), 'CLIENT_OPERATION_ID_REUSED', 409);
    await expectSemantic(cerrar(org, animalId, { ...value, fecha: '2026-01-14' }), 'CLIENT_OPERATION_ID_REUSED', 409);
    await expectSemantic(cerrar(org, animalId, { ...value, observaciones: null }), 'CLIENT_OPERATION_ID_REUSED', 409);
    await expectSemantic(cerrar(org, animalId, { ...value, tipo: 'MUERTE', causa: 'OTRA' }), 'CLIENT_OPERATION_ID_REUSED', 409);
    await expectSemantic(cerrar(org, otro, value), 'CLIENT_OPERATION_ID_REUSED', 409);
    assert.equal((await huella(otro)).estado_operativo, 'EN_HATO');
  });

  test('9. concurrencia: salida/salida, muerte/muerte y salida/muerte -> una sola transición', async () => {
    const org = crypto.randomUUID();
    for (const [a, b] of [[salida, salida], [muerte, muerte], [salida, muerte]]) {
      const animalId = await seedAnimal(org);
      const resultados = await Promise.allSettled([cerrar(org, animalId, a()), cerrar(org, animalId, b())]);
      const ok = resultados.filter((r) => r.status === 'fulfilled');
      const ko = resultados.filter((r) => r.status === 'rejected');
      assert.equal(ok.length, 1);
      assert.equal(ko.length, 1);
      assert.match(ko[0].reason.code, /^ANIMAL_YA_(SALIDO|MUERTO)$/);
      const eventos = (await adminPool.query(
        `select count(*)::int as n from agx.animal_eventos where animal_id = $1 and tipo_evento in ('SALIDO', 'MUERTO')`, [animalId],
      )).rows[0].n;
      assert.equal(eventos, 1);
    }
  });

  test('10. reintento concurrente de la MISMA operación (respuesta perdida) -> un 201 y un yaExistia', async () => {
    const org = crypto.randomUUID();
    const animalId = await seedAnimal(org);
    const value = muerte();
    const [a, b] = await Promise.all([cerrar(org, animalId, value), cerrar(org, animalId, { ...value })]);
    assert.deepEqual([a.yaExistia, b.yaExistia].sort(), [false, true]);
    assert.deepEqual(a.evento, b.evento);
    const h = await huella(animalId);
    assert.equal(h.eventos, 2, 'REGISTRADO + MUERTO');
  });

  test('11. aislamiento: otra organización -> 404 sin escritura; RLS oculta columnas de cierre', async () => {
    const orgA = crypto.randomUUID();
    const orgB = crypto.randomUUID();
    const animalB = await seedAnimal(orgB);
    const antes = await huella(animalB);
    await expectSemantic(cerrar(orgA, animalB, salida()), 'ANIMAL_NOT_FOUND', 404);
    assert.deepEqual(await huella(animalB), antes);
    await cerrar(orgB, animalB, salida());
    const visto = await asApp(orgA, 'select estado_operativo from agx.animales where animal_id = $1', [animalB]);
    assert.equal(visto.rowCount, 0);
    const eventos = await asApp(orgA, `select 1 from agx.animal_eventos where animal_id = $1 and tipo_evento = 'SALIDO'`, [animalB]);
    assert.equal(eventos.rowCount, 0);
  });

  test('12. rollback completo: si falla el evento, ni estado ni chapeta cambian', async () => {
    const org = crypto.randomUUID();
    const animalId = await seedAnimal(org);
    const [codigo] = await chapetaDe(org);
    await chapetasRepo.asociarChapetaAAnimal(org, animalId, codigo, { actorCuentaId: ACTOR });
    // Evento de cierre huérfano sembrado por fuera de la app: el INSERT de la
    // transacción choca con animal_eventos_un_cierre_idx DESPUÉS del UPDATE.
    await adminPool.query(
      `insert into agx.animal_eventos (organizacion_id, animal_id, tipo_evento, metadata_json, actor_cuenta_id) values ($1, $2, 'MUERTO', '{}', $3)`,
      [org, animalId, ACTOR],
    );
    const antes = await huella(animalId);
    await assert.rejects(cerrar(org, animalId, salida()), (e) => e.code === '23505');
    const despues = await huella(animalId);
    assert.deepEqual(despues, antes);
    assert.equal(despues.estado_operativo, 'EN_HATO');
    assert.equal(despues.qr, 'ASIGNADO_ANIMAL');
  });
});

describe('FASE 2A: efectos sobre otras funciones', { skip: !dbAvailable }, () => {
  test('13. pesajes: 409 tras salida/muerte; historial existente sigue legible', async () => {
    const org = crypto.randomUUID();
    const salido = await seedAnimal(org);
    await pesar(org, salido, '2026-01-01');
    await cerrar(org, salido, salida());
    await expectSemantic(pesar(org, salido, '2026-01-16'), 'ANIMAL_YA_SALIDO', 409);
    const historial = await pesajes.obtenerHistorialPesajes(org, salido);
    assert.equal(historial.pesajes.length, 1);

    const muerto = await seedAnimal(org);
    await cerrar(org, muerto, muerte());
    await expectSemantic(pesar(org, muerto, '2026-01-10'), 'ANIMAL_YA_MUERTO', 409);
  });

  test('14. QR: sin asociar ni reemplazar en un animal cerrado; la chapeta revocada no se reutiliza; historial conservado', async () => {
    const org = crypto.randomUUID();
    const animalId = await seedAnimal(org);
    const [primera, segunda] = await chapetaDe(org);
    await chapetasRepo.asociarChapetaAAnimal(org, animalId, primera, { actorCuentaId: ACTOR });
    await cerrar(org, animalId, muerte());
    await expectSemantic(chapetasRepo.asociarChapetaAAnimal(org, animalId, segunda, { actorCuentaId: ACTOR }), 'ANIMAL_YA_MUERTO', 409);
    await expectSemantic(
      chapetasRepo.reemplazarChapetaDeAnimal(org, animalId, { codigoNuevo: segunda, motivo: 'Prueba', actorCuentaId: ACTOR }),
      'ANIMAL_YA_MUERTO',
      409,
    );
    const otro = await seedAnimal(org);
    await assert.rejects(chapetasRepo.asociarChapetaAAnimal(org, otro, primera, { actorCuentaId: ACTOR }), (e) => e.code === 'QR_NO_OPERATIVO');
    const historico = await chapetasRepo.getChapetasDeAnimal(org, animalId);
    assert.ok(JSON.stringify(historico).includes(primera), 'el historial QR del animal se conserva');
  });

  test('15. corrección de datos declarados permitida, pero no deja nacimiento/ingreso después del cierre; anular sigue disponible', async () => {
    const org = crypto.randomUUID();
    const animalId = await seedAnimal(org);
    await cerrar(org, animalId, salida({ fechaSalida: '2026-01-15' }));
    const leido = await animalesRepo.getAnimal(org, animalId);
    const corregir = (cambios) => animalesRepo.corregirAnimal(
      org, animalId, validateCorregirAnimalBody({ ...cambios, fechaActualizacionEsperada: leido.fechaActualizacion }, { hoy: HOY }), { actorCuentaId: ACTOR },
    );
    await expectSemantic(corregir({ nacimientoTipo: 'EXACTA', fechaNacimiento: '2026-01-16', edadAproximadaMeses: null }), 'INVALID_FECHA', 400);
    await expectSemantic(corregir({ origenTipo: 'COMPRADO', procedencia: null, fechaIngreso: '2026-01-20' }), 'INVALID_FECHA', 400);
    const ok = await corregir({ numeroVisual: leido.numeroVisual, nombre: 'Lucera' });
    assert.equal(ok.animal.nombre, 'Lucera');
    assert.equal(ok.animal.estadoOperativo, 'SALIDO');
    const anulado = await animalesRepo.anularAnimal(org, animalId, { motivo: 'Registro duplicado', actorCuentaId: ACTOR });
    assert.equal(anulado.animal.estado, 'ANULADO');
    assert.equal(anulado.animal.estadoOperativo, 'SALIDO', 'anular no reabre ni borra el cierre');
  });

  test('16. compatibilidad: animal EN_HATO conserva registro, pesajes, QR y lectura sin cambios', async () => {
    const org = crypto.randomUUID();
    const animalId = await seedAnimal(org, { pesoInicialKg: 200, pesoInicialMetodo: 'BASCULA' });
    const [codigo] = await chapetaDe(org);
    await chapetasRepo.asociarChapetaAAnimal(org, animalId, codigo, { actorCuentaId: ACTOR });
    await pesar(org, animalId, '2026-01-10');
    const animal = await animalesRepo.getAnimal(org, animalId);
    assert.equal(animal.estado, 'ACTIVO');
    assert.equal(animal.estadoOperativo, 'EN_HATO');
    assert.equal(animal.cierre, null);
    const resolucion = await chapetasRepo.resolverChapeta(org, { codigoVisible: codigo });
    assert.equal(resolucion.resultado, 'ANIMAL');
    const t = await timeline.obtenerTimelineAnimal(org, animalId, { limit: 50 });
    assert.ok(!t.eventos.some((e) => ['ANIMAL_SALIDO', 'ANIMAL_MUERTO'].includes(e.tipo)));
  });
});
