// FASE 1C.2 -- reporte productivo individual contra un Postgres/PostGIS REAL
// (agx_app con RLS ENABLE + FORCE): datos Business del animal y su historial
// de pesajes bajo el tenant, animal ajeno/inexistente -> null (404 en la
// ruta), animal anulado con reporte, y el PDF generado con esos datos.
//
// Lee EXCLUSIVAMENTE AGX_BUSINESS_DATABASE_URL_TEST (agx_app) y
// AGX_BUSINESS_INTEGRATION_ADMIN_DATABASE_URL (siembra); se auto-omite si no
// están configuradas o si 0024 no está aplicada.
delete process.env.AGX_BUSINESS_DATABASE_URL;

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
let pesajes;
let reporte;
let businessDb;

try {
  const testConnectionString = process.env.AGX_BUSINESS_DATABASE_URL_TEST;
  const adminConnectionString = process.env.AGX_BUSINESS_INTEGRATION_ADMIN_DATABASE_URL;
  if (!testConnectionString || !adminConnectionString) {
    throw new Error('AGX_BUSINESS_DATABASE_URL_TEST/AGX_BUSINESS_INTEGRATION_ADMIN_DATABASE_URL no configuradas');
  }
  process.env.AGX_BUSINESS_DATABASE_URL = testConnectionString;
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
  pesajes = await import('../ganaderia/pesajesService.js');
  reporte = await import('../ganaderia/reporteProductivo/reporteProductivoService.js');
  businessDb = await import('../../db/agxBusinessPool.js');
}

after(async () => {
  await adminPool?.end().catch(() => {});
  businessDb?.closeAgxBusinessPool?.();
});

const HOY = resolveFechaHoyNegocio();
const ACTOR = '00000000-0000-4000-8000-0000000000aa';
const AHORA = new Date('2026-10-21T02:00:00Z');

async function seedAnimal(orgId, { numeroVisual = `R-${crypto.randomUUID().slice(0, 8)}`, predio = 'Predio Reporte' } = {}) {
  const r = await adminPool.query(
    `insert into agx.predios (organizacion_id, nombre_predio, estado) values ($1, $2, 'ACTIVO') returning predio_id`,
    [orgId, predio],
  );
  const raw = {
    clientOperationId: crypto.randomUUID(),
    predioId: String(r.rows[0].predio_id),
    numeroVisual,
    sexo: 'HEMBRA',
    nacimientoTipo: 'DESCONOCIDA',
    razaTipo: 'DESCONOCIDA',
  };
  const { animal } = await animalesRepo.createAnimalIdempotente(orgId, validateCreateAnimalBody(raw, { hoy: HOY }), { actorCuentaId: ACTOR });
  return animal.animalId;
}

function registrar(orgId, animalId, fecha, pesoKg) {
  const value = validateCreatePesajeBody({ fecha, pesoKg, metodo: 'BASCULA', clientOperationId: crypto.randomUUID() }, { hoy: HOY });
  return pesajes.registrarPesaje(orgId, animalId, value, { actorCuentaId: ACTOR });
}

describe('FASE 1C.2: reporte productivo con Postgres real (RLS)', { skip: !dbAvailable }, () => {
  test('1. animal propio: modelo y PDF con los datos Business reales', async () => {
    const org = crypto.randomUUID();
    const animalId = await seedAnimal(org, { numeroVisual: 'REP-0001', predio: 'Finca Reporte' });
    await registrar(org, animalId, '2025-01-10', 300);
    await registrar(org, animalId, '2025-02-09', 312);
    const r = await reporte.generarReporteProductivo(org, animalId, { ahora: AHORA });
    assert.ok(r);
    const ident = Object.fromEntries(r.modelo.identificacion.map((x) => [x.etiqueta, x.valor]));
    assert.equal(ident['Número de identificación'], 'REP-0001');
    assert.equal(ident.Predio, 'Finca Reporte');
    assert.equal(ident.Estado, 'Activo');
    assert.equal(r.modelo.historial.filas.length, 2);
    assert.deepEqual(r.modelo.historial.filas.map((f) => f[0]), ['10/01/2025', '09/02/2025']);
    assert.equal(r.modelo.resumen.find((x) => x.etiqueta === 'Diferencia').valor, '+12 kg');
    assert.equal(r.modelo.nombreArchivo, 'AgroGenomaX_Reporte_Productivo_REP-0001_2026-10-20.pdf');
    assert.equal(r.pdf.subarray(0, 5).toString('latin1'), '%PDF-');
  });

  test('2/3. animal de otra organización e inexistente -> null (sin filtrar datos)', async () => {
    const orgA = crypto.randomUUID();
    const orgB = crypto.randomUUID();
    const animalB = await seedAnimal(orgB, { numeroVisual: 'SECRETO-B' });
    await registrar(orgB, animalB, '2025-01-10', 400);
    assert.equal(await reporte.generarReporteProductivo(orgA, animalB, { ahora: AHORA }), null);
    assert.equal(await reporte.cargarDatosReporteProductivo(orgA, animalB), null);
    assert.equal(await reporte.generarReporteProductivo(orgA, '999999999999', { ahora: AHORA }), null);
    assert.ok(await reporte.generarReporteProductivo(orgB, animalB, { ahora: AHORA }), 'la organización dueña sí lo obtiene');
  });

  test('4. animal sin pesajes: reporte con alerta INFO', async () => {
    const org = crypto.randomUUID();
    const animalId = await seedAnimal(org);
    const r = await reporte.generarReporteProductivo(org, animalId, { ahora: AHORA });
    assert.deepEqual(r.modelo.alertas.lista.map((a) => a.severidad), ['INFO']);
    assert.deepEqual(r.modelo.historial.filas, []);
  });

  test('5. animal ANULADO: el reporte se genera e indica la anulación', async () => {
    const org = crypto.randomUUID();
    const animalId = await seedAnimal(org);
    await registrar(org, animalId, '2025-01-10', 300);
    await animalesRepo.anularAnimal(org, animalId, { motivo: 'registro erróneo', actorCuentaId: ACTOR });
    const r = await reporte.generarReporteProductivo(org, animalId, { ahora: AHORA });
    const ident = Object.fromEntries(r.modelo.identificacion.map((x) => [x.etiqueta, x.valor]));
    assert.equal(ident.Estado, 'Anulado');
    assert.equal(ident['Motivo de anulación'], 'registro erróneo');
    assert.equal(r.modelo.historial.filas.length, 1);
  });

  test('6. generar el reporte NO escribe nada (solo lectura)', async () => {
    const org = crypto.randomUUID();
    const animalId = await seedAnimal(org);
    await registrar(org, animalId, '2025-01-10', 300);
    const cuenta = async () => (await adminPool.query(
      `select (select count(*) from agx.animal_pesajes where organizacion_id = $1)::int as p,
              (select count(*) from agx.animal_eventos where organizacion_id = $1)::int as e,
              (select max(updated_at) from agx.animales where organizacion_id = $1) as u`, [org],
    )).rows[0];
    const antes = await cuenta();
    await reporte.generarReporteProductivo(org, animalId, { ahora: AHORA });
    assert.deepEqual(await cuenta(), antes);
  });
});
