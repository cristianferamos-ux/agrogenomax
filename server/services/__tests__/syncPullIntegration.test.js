// SPRINT-3D11.3 (R1) -- PULL de la sincronización offline-first contra
// Postgres real: aislamiento por organización, contenido mínimo para
// trabajar sin red (animales, chapetas con token_hash, predios, potreros,
// catálogos), cursor incremental con solape y clientOperationId para
// emparejar registros locales. Mismas variables que qrInventarioIntegration.
delete process.env.AGX_BUSINESS_DATABASE_URL;
delete process.env.AGX_BUSINESS_QR_ADMIN_DATABASE_URL;

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import pg from 'pg';
import { validateCreateAnimalBody } from '../ganaderia/animalValidation.js';
import { resolveFechaHoyNegocio } from '../ganaderia/motorDescansoAuto/businessTimezone.js';

let dbAvailable = false;
let adminPool;
let animalesRepo;
let inventario;
let sync;
let businessDb;
let qrAdminDb;

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
  adminPool = new pg.Pool({ connectionString: admin, max: 2 });
  dbAvailable = Boolean((await adminPool.query("select to_regclass('agx.qr_chapetas') as t")).rows[0]?.t);
} catch {
  dbAvailable = false;
}

if (dbAvailable) {
  animalesRepo = await import('../ganaderia/animalesRepository.js');
  inventario = await import('../ganaderia/qrInventarioRepository.js');
  sync = await import('../ganaderia/syncRepository.js');
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

async function seedOrg() {
  const org = crypto.randomUUID();
  const predio = await adminPool.query(
    "insert into agx.predios (organizacion_id, nombre_predio, estado) values ($1, 'Finca Sync', 'ACTIVO') returning predio_id",
    [org],
  );
  const predioId = String(predio.rows[0].predio_id);
  const clientOperationId = crypto.randomUUID();
  const { animal } = await animalesRepo.createAnimalIdempotente(org, validateCreateAnimalBody({
    clientOperationId, predioId, numeroVisual: `S-${crypto.randomUUID().slice(0, 5)}`,
    sexo: 'HEMBRA', nacimientoTipo: 'DESCONOCIDA', razaTipo: 'DESCONOCIDA',
  }, { hoy: HOY }), { actorCuentaId: ACTOR });
  const { lote } = await inventario.crearLote(
    { cantidad: 2, urlBase: 'https://agrogenomax.test', clientOperationId: crypto.randomUUID() },
    SUPERADMIN,
  );
  await inventario.cambiarEstadoLote(lote.loteId, 'EN_FABRICACION', SUPERADMIN);
  await inventario.cambiarEstadoLote(lote.loteId, 'EN_STOCK', SUPERADMIN);
  await inventario.asignarChapetas(lote.loteId, { organizacionId: org, cantidad: 1, clientOperationId: crypto.randomUUID() }, SUPERADMIN);
  return { org, predioId, animal, clientOperationId, loteId: lote.loteId };
}

describe('SPRINT-3D11.3: PULL de sincronización contra Postgres real', { skip: !dbAvailable }, () => {
  test('pull completo: solo datos de la organización, con todo lo necesario para operar sin red', async () => {
    const a = await seedOrg();
    const b = await seedOrg();
    const result = await sync.pullCambios(a.org, { cursor: undefined });
    assert.equal(result.completo, true);
    assert.match(result.cursor, /^[A-Za-z0-9_-]+$/);
    assert.deepEqual(result.animales.map((x) => x.animalId), [a.animal.animalId]);
    assert.equal(result.animales[0].clientOperationId, a.clientOperationId);
    assert.deepEqual(result.predios.map((x) => x.predioId), [a.predioId]);
    assert.equal(result.chapetas.length, 1, 'solo la chapeta asignada; nunca el stock central');
    const [chapeta] = result.chapetas;
    assert.equal(chapeta.estado, 'ASIGNADO_ORGANIZACION');
    assert.match(chapeta.tokenHash, /^[0-9a-f]{64}$/);
    assert.equal(Object.hasOwn(chapeta, 'token'), false);
    assert.ok(result.razas.length >= 15);
    assert.ok(result.categorias.length > 0);
    assert.ok(!result.animales.some((x) => x.animalId === b.animal.animalId), 'nunca animales de otra organización');
    assert.ok(!result.predios.some((x) => x.predioId === b.predioId), 'nunca predios de otra organización');
    assert.ok(!JSON.stringify(result).includes(b.org));
  });

  test('pull incremental: tras el cursor solo llegan cambios (con solape); los nuevos aparecen', async () => {
    const a = await seedOrg();
    const primero = await sync.pullCambios(a.org, { cursor: undefined });
    const segundo = await sync.pullCambios(a.org, { cursor: primero.cursor });
    assert.equal(segundo.completo, false);
    // Solape de 5 min: lo recién creado puede repetirse (upsert idempotente).
    assert.ok(segundo.animales.every((x) => x.animalId === a.animal.animalId));
    const viejo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const cursorViejo = sync.encodeCursor(viejo);
    await adminPool.query("update agx.animales set updated_at = now() - interval '2 hours' where animal_id = $1", [a.animal.animalId]);
    const tercero = await sync.pullCambios(a.org, { cursor: cursorViejo });
    assert.equal(tercero.animales.length, 0, 'un animal sin cambios desde el cursor no se reenvía');
    await adminPool.query('update agx.animales set updated_at = now() where animal_id = $1', [a.animal.animalId]);
    const cuarto = await sync.pullCambios(a.org, { cursor: cursorViejo });
    assert.deepEqual(cuarto.animales.map((x) => x.animalId), [a.animal.animalId]);
  });

  test('cursor ilegible -> 400 INVALID_CURSOR', async () => {
    const a = await seedOrg();
    for (const cursor of ['x', Buffer.from('{"v":2,"t":"2026-01-01"}').toString('base64url'), Buffer.from('{"v":1,"t":"nope"}').toString('base64url')]) {
      await assert.rejects(sync.pullCambios(a.org, { cursor }), (error) => error.code === 'INVALID_CURSOR' && error.status === 400);
    }
  });
});
