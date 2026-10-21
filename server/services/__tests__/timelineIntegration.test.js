// FASE 1D.2 -- línea de tiempo DERIVADA contra un Postgres/PostGIS REAL
// (0000-0024): flujos reales de alta, pesajes, corrección, chapetas QR
// (asociación, reemplazo, baja) y anulación; RLS por organización
// (agx_app); deduplicación frente a agx.qr_chapeta_eventos (que registra
// los mismos hechos QR) y ausencia de escrituras al leer.
//
// Lee EXCLUSIVAMENTE AGX_BUSINESS_DATABASE_URL_TEST (agx_app),
// AGX_BUSINESS_QR_ADMIN_DATABASE_URL_TEST (agx_qr_admin) y
// AGX_BUSINESS_INTEGRATION_ADMIN_DATABASE_URL; se auto-omite si faltan.
delete process.env.AGX_BUSINESS_DATABASE_URL;
delete process.env.AGX_BUSINESS_QR_ADMIN_DATABASE_URL;

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import pg from 'pg';
import { validateCreateAnimalBody } from '../ganaderia/animalValidation.js';
import { validateCreatePesajeBody } from '../ganaderia/pesajeValidation.js';
import { resolveFechaHoyNegocio } from '../ganaderia/motorDescansoAuto/businessTimezone.js';

let dbAvailable = false;
let adminPool;
let animalesRepo;
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
  const check = await adminPool.query(
    `select count(*)::int as n from information_schema.columns
      where table_schema = 'agx' and table_name = 'animal_pesajes' and column_name = 'client_operation_id'`,
  );
  dbAvailable = check.rows[0].n === 1;
} catch {
  dbAvailable = false;
}

if (dbAvailable) {
  animalesRepo = await import('../ganaderia/animalesRepository.js');
  chapetasRepo = await import('../ganaderia/qrChapetasRepository.js');
  inventario = await import('../ganaderia/qrInventarioRepository.js');
  pesajes = await import('../ganaderia/pesajesService.js');
  timeline = await import('../ganaderia/timeline/timelineService.js');
  businessDb = await import('../../db/agxBusinessPool.js');
  qrAdminDb = await import('../../db/agxQrAdminPool.js');
}

after(async () => {
  await adminPool?.end().catch(() => {});
  businessDb?.closeAgxBusinessPool?.();
  await qrAdminDb?.closeAgxQrAdminPool?.();
});

const HOY = resolveFechaHoyNegocio();
const ACTOR = '00000000-0000-4000-8000-0000000000aa';
const SUPERADMIN = { actorCuentaId: '00000000-0000-4000-8000-0000000000ad' };

async function seedAnimal(org, extra = {}) {
  const predio = await adminPool.query(
    `insert into agx.predios (organizacion_id, nombre_predio, estado) values ($1, 'Predio Timeline', 'ACTIVO') returning predio_id`,
    [org],
  );
  const body = validateCreateAnimalBody({
    clientOperationId: crypto.randomUUID(),
    predioId: String(predio.rows[0].predio_id),
    numeroVisual: `TL-${crypto.randomUUID().slice(0, 6)}`,
    sexo: 'HEMBRA',
    nacimientoTipo: 'DESCONOCIDA',
    razaTipo: 'DESCONOCIDA',
    ...extra,
  }, { hoy: HOY });
  const { animal } = await animalesRepo.createAnimalIdempotente(org, body, { actorCuentaId: ACTOR });
  return animal;
}

function registrarPesaje(org, animalId, fecha, pesoKg) {
  const value = validateCreatePesajeBody({ fecha, pesoKg, metodo: 'BASCULA', clientOperationId: crypto.randomUUID() }, { hoy: HOY });
  return pesajes.registrarPesaje(org, animalId, value, { actorCuentaId: ACTOR });
}

/** Chapetas asignadas a `org` (flujo real de inventario). */
async function chapetasDe(org, cantidad) {
  const lote = (await inventario.crearLote(
    { cantidad, proveedor: 'Proveedor prueba', observaciones: null, urlBase: 'https://agrogenomax.test', clientOperationId: crypto.randomUUID() },
    SUPERADMIN,
  )).lote;
  await inventario.cambiarEstadoLote(lote.loteId, 'EN_FABRICACION', SUPERADMIN);
  await inventario.cambiarEstadoLote(lote.loteId, 'EN_STOCK', SUPERADMIN);
  await inventario.asignarChapetas(lote.loteId, { organizacionId: org, referencia: 'Plan prueba', clientOperationId: crypto.randomUUID() }, SUPERADMIN);
  return (await inventario.exportLoteProveedor(lote.loteId)).chapetas.map((c) => ({ codigo: c.codigoVisible, token: c.token }));
}

async function huella(org) {
  return (await adminPool.query(
    `select (select count(*) from agx.animal_eventos where organizacion_id = $1)::int as eventos,
            (select count(*) from agx.animal_pesajes where organizacion_id = $1)::int as pesajes,
            (select count(*) from agx.qr_chapeta_eventos where organizacion_id = $1)::int as qr_eventos,
            (select max(updated_at)::text from agx.animales where organizacion_id = $1) as animales_upd`,
    [org],
  )).rows[0];
}

describe('FASE 1D.2: línea de tiempo con Postgres real (RLS)', { skip: !dbAvailable }, () => {
  test('6/7/8/9/10. solo registro y luego registro + pesajes (mismo día: GMD null)', async () => {
    const org = crypto.randomUUID();
    const animal = await seedAnimal(org);
    let t = await timeline.obtenerTimelineAnimal(org, animal.animalId, { limit: 50 });
    assert.deepEqual(t.eventos.map((e) => e.tipo), ['ANIMAL_REGISTRADO']);
    assert.match(t.eventos[0].id, /^animal_evento:\d+$/);
    await registrarPesaje(org, animal.animalId, '2025-01-10', 300);
    await registrarPesaje(org, animal.animalId, '2025-02-09', 315);
    await registrarPesaje(org, animal.animalId, '2025-02-09', 316);
    t = await timeline.obtenerTimelineAnimal(org, animal.animalId, { limit: 50 });
    const pes = t.eventos.filter((e) => e.tipo === 'PESAJE_REGISTRADO');
    assert.deepEqual(pes.map((e) => e.datos.pesoKg), [316, 315, 300], 'DESC: mismo día, el registrado después primero');
    assert.equal(pes[0].datos.diasDesdeAnterior, 0);
    assert.equal(pes[0].datos.gmdKgDia, null);
    assert.equal(pes[1].datos.gmdKgDia, 0.5);
    assert.equal(pes[1].fecha, '2025-02-09');
    assert.equal(pes[1].fechaHora, null);
  });

  test('peso inicial al registrar: un pesaje REGISTRO_INICIAL, sin duplicar el registro', async () => {
    const org = crypto.randomUUID();
    const animal = await seedAnimal(org, { pesoInicialKg: 280, pesoInicialMetodo: 'ESTIMADO' });
    const t = await timeline.obtenerTimelineAnimal(org, animal.animalId, { limit: 50 });
    assert.equal(t.eventos.filter((e) => e.tipo === 'ANIMAL_REGISTRADO').length, 1);
    const inicial = t.eventos.find((e) => e.tipo === 'PESAJE_REGISTRADO');
    assert.equal(inicial.titulo, 'Peso inicial registrado');
    assert.equal(inicial.datos.origen, 'REGISTRO_INICIAL');
  });

  test('11/12/13/14/15. corrección, QR (asociación, reemplazo, baja) y anulación: una entrada por hecho', async () => {
    const org = crypto.randomUUID();
    const animal = await seedAnimal(org);
    const [c1, c2] = await chapetasDe(org, 2);
    await animalesRepo.corregirAnimal(org, animal.animalId, { cambios: { nombre: 'Lucero' }, fechaActualizacionEsperada: animal.fechaActualizacion }, { actorCuentaId: ACTOR });
    await chapetasRepo.asociarChapetaAAnimal(org, animal.animalId, c1.codigo, { actorCuentaId: ACTOR });
    await chapetasRepo.reemplazarChapetaDeAnimal(org, animal.animalId, { codigoNuevo: c2.codigo, motivo: 'Chapeta ilegible', actorCuentaId: ACTOR });
    await animalesRepo.anularAnimal(org, animal.animalId, { motivo: 'Registro de prueba', actorCuentaId: ACTOR });

    const t = await timeline.obtenerTimelineAnimal(org, animal.animalId, { limit: 50 });
    const tipos = t.eventos.map((e) => e.tipo);
    assert.deepEqual(tipos, ['ANIMAL_ANULADO', 'QR_DESASIGNADO', 'QR_REEMPLAZADO', 'QR_ASIGNADO', 'ANIMAL_CORREGIDO', 'ANIMAL_REGISTRADO']);
    const porTipo = Object.fromEntries(t.eventos.map((e) => [e.tipo, e]));
    assert.equal(porTipo.ANIMAL_CORREGIDO.descripcion, 'Campos: Nombre.');
    assert.equal(porTipo.QR_ASIGNADO.datos.codigoVisible, c1.codigo);
    assert.equal(porTipo.QR_REEMPLAZADO.descripcion, `${c1.codigo} → ${c2.codigo}. Motivo: Chapeta ilegible`);
    assert.equal(porTipo.QR_DESASIGNADO.descripcion, `Chapeta ${c2.codigo} revocada por anulación del animal.`);
    assert.equal(porTipo.ANIMAL_ANULADO.descripcion, 'Motivo: Registro de prueba');

    // Deduplicación: qr_chapeta_eventos registra los MISMOS hechos (y más), pero no se suman.
    const qrEventos = (await adminPool.query('select count(*)::int as n from agx.qr_chapeta_eventos where organizacion_id = $1', [org])).rows[0].n;
    assert.ok(qrEventos >= 4, `qr_chapeta_eventos tiene ${qrEventos} filas para estos hechos`);
    assert.equal(t.eventos.filter((e) => e.tipo.startsWith('QR_')).length, 3, 'una entrada por hecho QR del animal');
    assert.equal(new Set(t.eventos.map((e) => e.id)).size, t.eventos.length);

    // 19. sin tokens ni ids internos.
    const json = JSON.stringify(t);
    for (const c of [c1, c2]) assert.ok(!json.includes(c.token), 'token QR nunca expuesto');
    assert.doesNotMatch(json, /qrId|intentHash|token/i);
  });

  test('5. animal anulado: la línea de tiempo sigue disponible', async () => {
    const org = crypto.randomUUID();
    const animal = await seedAnimal(org);
    await animalesRepo.anularAnimal(org, animal.animalId, { motivo: 'duplicado', actorCuentaId: ACTOR });
    const t = await timeline.obtenerTimelineAnimal(org, animal.animalId, { limit: 50 });
    assert.deepEqual(t.eventos.map((e) => e.tipo), ['ANIMAL_ANULADO', 'ANIMAL_REGISTRADO']);
  });

  test('2/3/21. RLS: animal de otra organización e inexistente -> null (404)', async () => {
    const orgA = crypto.randomUUID();
    const orgB = crypto.randomUUID();
    const animalB = await seedAnimal(orgB);
    await registrarPesaje(orgB, animalB.animalId, '2025-01-10', 400);
    assert.equal(await timeline.obtenerTimelineAnimal(orgA, animalB.animalId, { limit: 50 }), null);
    assert.equal(await timeline.obtenerTimelineAnimal(orgA, '999999999999', { limit: 50 }), null);
    assert.ok(await timeline.obtenerTimelineAnimal(orgB, animalB.animalId, { limit: 50 }));
  });

  test('18. limit sobre datos reales', async () => {
    const org = crypto.randomUUID();
    const animal = await seedAnimal(org);
    for (let i = 1; i <= 4; i += 1) await registrarPesaje(org, animal.animalId, `2025-0${i}-01`, 300 + i);
    const t = await timeline.obtenerTimelineAnimal(org, animal.animalId, { limit: 2 });
    assert.equal(t.eventos.length, 2);
    assert.equal(t.total, 5);
    assert.equal(t.truncado, true);
    // El registro es de hoy: más reciente que los pesajes de 2025.
    assert.deepEqual(t.eventos.map((e) => e.tipo), ['ANIMAL_REGISTRADO', 'PESAJE_REGISTRADO']);
    assert.equal(t.eventos[1].datos.pesoKg, 304);
  });

  test('22. leer la línea de tiempo NO escribe nada', async () => {
    const org = crypto.randomUUID();
    const animal = await seedAnimal(org);
    await registrarPesaje(org, animal.animalId, '2025-01-10', 300);
    const antes = await huella(org);
    await timeline.obtenerTimelineAnimal(org, animal.animalId, { limit: 50 });
    await timeline.obtenerTimelineAnimal(org, animal.animalId, { limit: 200 });
    assert.deepEqual(await huella(org), antes);
  });
});
