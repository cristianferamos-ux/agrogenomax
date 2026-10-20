// FASE 1A -- pesajes posteriores (agx.animal_pesajes, 0022 + 0024) contra un
// Postgres/PostGIS REAL: migración, RLS+FORCE, FK tenant-safe, append-only,
// registro MANUAL idempotente (secuencial y concurrente), historial
// derivado con el motor canónico, animal ajeno/inexistente/anulado y
// unicidad de REGISTRO_INICIAL.
//
// Los valores pasan por validateCreatePesajeBody (misma normalización que la
// ruta HTTP). Lee EXCLUSIVAMENTE AGX_BUSINESS_DATABASE_URL_TEST (agx_app) y
// AGX_BUSINESS_INTEGRATION_ADMIN_DATABASE_URL (siembra/inspección); se
// auto-omite si no están configuradas o si 0024 no está aplicada.
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
let appPool;
let animalesRepo;
let service;
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
  appPool = new pg.Pool({ connectionString: testConnectionString, max: 2 });
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
  service = await import('../ganaderia/pesajesService.js');
  businessDb = await import('../../db/agxBusinessPool.js');
}

after(async () => {
  await adminPool?.end().catch(() => {});
  await appPool?.end().catch(() => {});
  businessDb?.closeAgxBusinessPool?.();
});

const HOY = resolveFechaHoyNegocio();
const ACTOR = '00000000-0000-4000-8000-0000000000aa';
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≉ ${b}`);

async function seedPredio(orgId) {
  const r = await adminPool.query(
    `insert into agx.predios (organizacion_id, nombre_predio, estado) values ($1, 'Predio FASE 1A', 'ACTIVO') returning predio_id`,
    [orgId],
  );
  return String(r.rows[0].predio_id);
}

async function seedAnimal(orgId, { pesoInicialKg } = {}) {
  const predioId = await seedPredio(orgId);
  const raw = {
    clientOperationId: crypto.randomUUID(),
    predioId,
    numeroVisual: `P-${crypto.randomUUID().slice(0, 8)}`,
    sexo: 'MACHO',
    nacimientoTipo: 'DESCONOCIDA',
    razaTipo: 'DESCONOCIDA',
    ...(pesoInicialKg ? { pesoInicialKg, pesoInicialMetodo: 'BASCULA' } : {}),
  };
  const { animal } = await animalesRepo.createAnimalIdempotente(orgId, validateCreateAnimalBody(raw, { hoy: HOY }), { actorCuentaId: ACTOR });
  return animal.animalId;
}

function pesaje(overrides = {}) {
  return validateCreatePesajeBody({ fecha: '2025-01-10', pesoKg: 300, metodo: 'BASCULA', clientOperationId: crypto.randomUUID(), ...overrides }, { hoy: HOY });
}

function registrar(orgId, animalId, value) {
  return service.registrarPesaje(orgId, animalId, value, { actorCuentaId: ACTOR });
}

async function expectSemantic(promise, code, status) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code, `se esperaba ${code}, llegó ${error.code}: ${error.message}`);
    if (status) assert.equal(error.status, status);
    return true;
  });
}

async function countPesajes(animalId, extra = '') {
  return (await adminPool.query(`select count(*)::int as n from agx.animal_pesajes where animal_id = $1 ${extra}`, [animalId])).rows[0].n;
}

/** Ejecuta `sql` como agx_app con app.current_org_id = orgId (dentro de una transacción revertida). */
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

describe('FASE 1A: migración 0024 y esquema', { skip: !dbAvailable }, () => {
  test('1. columnas, CHECKs e índices de 0024; RLS ENABLE + FORCE intactos', async () => {
    const cols = (await adminPool.query(
      `select column_name, data_type, is_nullable from information_schema.columns
        where table_schema='agx' and table_name='animal_pesajes' and column_name in ('client_operation_id','observaciones','created_at') order by 1`,
    )).rows;
    assert.deepEqual(cols, [
      { column_name: 'client_operation_id', data_type: 'uuid', is_nullable: 'YES' },
      { column_name: 'created_at', data_type: 'timestamp with time zone', is_nullable: 'NO' },
      { column_name: 'observaciones', data_type: 'text', is_nullable: 'YES' },
    ]);
    const cons = (await adminPool.query(`select conname, pg_get_constraintdef(oid) as def from pg_constraint where conrelid='agx.animal_pesajes'::regclass`)).rows;
    const def = (n) => cons.find((c) => c.conname === n)?.def ?? '';
    assert.match(def('animal_pesajes_origen_check'), /REGISTRO_INICIAL.*MANUAL/);
    assert.match(def('animal_pesajes_manual_client_operation_check'), /client_operation_id IS NOT NULL/);
    assert.match(def('animal_pesajes_observaciones_check'), /500/);
    const idx = (await adminPool.query(`select indexname from pg_indexes where schemaname='agx' and tablename='animal_pesajes' order by 1`)).rows.map((r) => r.indexname);
    assert.deepEqual(idx, [
      'animal_pesajes_animal_fecha_idx',
      'animal_pesajes_org_client_operation_key',
      'animal_pesajes_organizacion_id_idx',
      'animal_pesajes_pkey',
      'animal_pesajes_un_registro_inicial_idx',
    ]);
    const rls = (await adminPool.query(`select relrowsecurity, relforcerowsecurity from pg_class where oid='agx.animal_pesajes'::regclass`)).rows[0];
    assert.deepEqual(rls, { relrowsecurity: true, relforcerowsecurity: true });
  });

  test('origen: OFFLINE/IMPORTADO rechazados; MANUAL exige client_operation_id; observaciones vacías rechazadas', async () => {
    const org = crypto.randomUUID();
    const animalId = await seedAnimal(org);
    const ins = (origen, op, obs = null) => adminPool.query(
      `insert into agx.animal_pesajes (organizacion_id, animal_id, fecha, peso_kg, metodo, origen, actor_cuenta_id, client_operation_id, observaciones)
       values ($1, $2, '2025-01-01', 100, 'BASCULA', $3, $4, $5, $6)`,
      [org, animalId, origen, ACTOR, op, obs],
    );
    for (const origen of ['OFFLINE', 'IMPORTADO']) await assert.rejects(ins(origen, crypto.randomUUID()), { code: '23514' });
    await assert.rejects(ins('MANUAL', null), { code: '23514' });
    await assert.rejects(ins('MANUAL', crypto.randomUUID(), '   '), { code: '23514' });
    await assert.rejects(ins('MANUAL', crypto.randomUUID(), 'x'.repeat(501)), { code: '23514' });
  });

  test('2/6. RLS: agx_app solo ve pesajes de su organización; append-only (sin UPDATE/DELETE)', async () => {
    const orgA = crypto.randomUUID();
    const orgB = crypto.randomUUID();
    const animalA = await seedAnimal(orgA);
    await registrar(orgA, animalA, pesaje());
    assert.equal((await asApp(orgA, 'select count(*)::int as n from agx.animal_pesajes where animal_id = $1', [animalA])).rows[0].n, 1);
    assert.equal((await asApp(orgB, 'select count(*)::int as n from agx.animal_pesajes where animal_id = $1', [animalA])).rows[0].n, 0);
    await assert.rejects(asApp(orgA, 'update agx.animal_pesajes set peso_kg = 1 where animal_id = $1', [animalA]), { code: '42501' });
    await assert.rejects(asApp(orgA, 'delete from agx.animal_pesajes where animal_id = $1', [animalA]), { code: '42501' });
    // Insertar con otra organización viola la política WITH CHECK.
    await assert.rejects(
      asApp(orgA, `insert into agx.animal_pesajes (organizacion_id, animal_id, fecha, peso_kg, metodo, origen, actor_cuenta_id, client_operation_id)
                   values ($1, $2, '2025-01-01', 100, 'BASCULA', 'MANUAL', $3, $4)`, [orgB, animalA, ACTOR, crypto.randomUUID()]),
      { code: '42501' },
    );
  });

  test('3/7. FK tenant-safe: (animal_id, organizacion_id) de otra organización es rechazado incluso como superusuario', async () => {
    const orgA = crypto.randomUUID();
    const orgB = crypto.randomUUID();
    const animalB = await seedAnimal(orgB);
    await assert.rejects(
      adminPool.query(
        `insert into agx.animal_pesajes (organizacion_id, animal_id, fecha, peso_kg, metodo, origen, actor_cuenta_id, client_operation_id)
         values ($1, $2, '2025-01-01', 100, 'BASCULA', 'MANUAL', $3, $4)`,
        [orgA, animalB, ACTOR, crypto.randomUUID()],
      ),
      { code: '23503' },
    );
  });
});

describe('FASE 1A: registro y lectura de pesajes (repositorio + servicio)', { skip: !dbAvailable }, () => {
  test('4/5. POST válido (MANUAL) y GET historial', async () => {
    const org = crypto.randomUUID();
    const animalId = await seedAnimal(org);
    const value = pesaje({ pesoKg: 350.5, metodo: 'ESTIMADO', observaciones: 'Báscula en reparación' });
    const { pesaje: creado, yaExistia } = await registrar(org, animalId, value);
    assert.equal(yaExistia, false);
    assert.deepEqual({ ...creado, pesajeId: 'x', createdAt: 'x' }, {
      pesajeId: 'x', fecha: '2025-01-10', pesoKg: 350.5, metodo: 'ESTIMADO', origen: 'MANUAL', observaciones: 'Báscula en reparación', createdAt: 'x',
    });
    assert.match(creado.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
    const h = await service.obtenerHistorialPesajes(org, animalId);
    assert.equal(h.animalId, String(animalId));
    assert.equal(h.pesajes.length, 1);
    assert.equal(h.resumen.ultimoPesoKg, 350.5);
    assert.equal(h.pesajes[0].gmdKgDia, null);
  });

  test('6/19-25. múltiples pesajes: orden ascendente, GMD +/−/0, null sin anterior y mismo día, ganancia acumulada', async () => {
    const org = crypto.randomUUID();
    const animalId = await seedAnimal(org);
    for (const [fecha, pesoKg] of [['2025-01-21', 305], ['2025-01-01', 300], ['2025-01-11', 310], ['2025-01-31', 305], ['2025-01-31', 306]]) {
      await registrar(org, animalId, pesaje({ fecha, pesoKg }));
    }
    const h = await service.obtenerHistorialPesajes(org, animalId);
    assert.deepEqual(h.pesajes.map((x) => x.fecha), ['2025-01-01', '2025-01-11', '2025-01-21', '2025-01-31', '2025-01-31']);
    const g = h.pesajes.map((x) => x.gmdKgDia);
    assert.equal(g[0], null);
    close(g[1], 1);
    close(g[2], -0.5);
    assert.equal(g[3], 0);
    assert.equal(g[4], null);
    assert.equal(h.pesajes[4].diasDesdeAnterior, 0);
    assert.equal(h.resumen.ultimoPesoKg, 306);
    assert.equal(h.resumen.gananciaAcumulada.primerPesoRegistradoKg, 300);
    assert.equal(h.resumen.gananciaAcumulada.gananciaKg, 6);
    assert.equal(h.resumen.gananciaAcumulada.dias, 30);
    close(h.resumen.gananciaAcumulada.gmdPromedioKgDia, 0.2);
  });

  test('8. dos animales: historiales independientes', async () => {
    const org = crypto.randomUUID();
    const a1 = await seedAnimal(org);
    const a2 = await seedAnimal(org);
    await registrar(org, a1, pesaje({ pesoKg: 100 }));
    await registrar(org, a2, pesaje({ pesoKg: 200 }));
    await registrar(org, a2, pesaje({ pesoKg: 210, fecha: '2025-01-20' }));
    assert.equal((await service.obtenerHistorialPesajes(org, a1)).pesajes.length, 1);
    assert.equal((await service.obtenerHistorialPesajes(org, a2)).pesajes.length, 2);
  });

  test('9/10. animal ajeno e inexistente: GET null (404) y POST 404 sin filtrar existencia ni escribir', async () => {
    const orgA = crypto.randomUUID();
    const orgB = crypto.randomUUID();
    const animalB = await seedAnimal(orgB);
    await registrar(orgB, animalB, pesaje());
    assert.equal(await service.obtenerHistorialPesajes(orgA, animalB), null);
    assert.equal(await service.obtenerHistorialPesajes(orgA, '999999999999'), null);
    await expectSemantic(registrar(orgA, animalB, pesaje()), 'ANIMAL_NOT_FOUND', 404);
    await expectSemantic(registrar(orgA, '999999999999', pesaje()), 'ANIMAL_NOT_FOUND', 404);
    assert.equal(await countPesajes(animalB), 1);
  });

  test('11. animal ANULADO: rechaza nuevos pesajes (409 ANIMAL_ANULADO) pero el historial sigue legible', async () => {
    const org = crypto.randomUUID();
    const animalId = await seedAnimal(org);
    await registrar(org, animalId, pesaje());
    await animalesRepo.anularAnimal(org, animalId, { motivo: 'registro erróneo', actorCuentaId: ACTOR });
    await expectSemantic(registrar(org, animalId, pesaje({ fecha: '2025-02-01' })), 'ANIMAL_ANULADO', 409);
    assert.equal((await service.obtenerHistorialPesajes(org, animalId)).pesajes.length, 1);
  });

  test('16. idempotencia: mismo clientOperationId -> mismo pesaje, una fila; datos distintos -> 409', async () => {
    const org = crypto.randomUUID();
    const animalId = await seedAnimal(org);
    const value = pesaje({ pesoKg: 321.4, observaciones: 'nota' });
    const primero = await registrar(org, animalId, value);
    const segundo = await registrar(org, animalId, value);
    assert.equal(segundo.yaExistia, true);
    assert.deepEqual(segundo.pesaje, primero.pesaje);
    assert.equal(await countPesajes(animalId), 1);
    await expectSemantic(registrar(org, animalId, { ...value, pesoKg: 321.5 }), 'CLIENT_OPERATION_ID_REUSED', 409);
    const otro = await seedAnimal(org);
    await expectSemantic(registrar(org, otro, value), 'CLIENT_OPERATION_ID_REUSED', 409);
    assert.equal(await countPesajes(animalId), 1);
    assert.equal(await countPesajes(otro), 0);
  });

  test('16b. el mismo clientOperationId en otra organización es una operación independiente', async () => {
    const orgA = crypto.randomUUID();
    const orgB = crypto.randomUUID();
    const a = await seedAnimal(orgA);
    const b = await seedAnimal(orgB);
    const op = crypto.randomUUID();
    assert.equal((await registrar(orgA, a, pesaje({ clientOperationId: op }))).yaExistia, false);
    assert.equal((await registrar(orgB, b, pesaje({ clientOperationId: op }))).yaExistia, false);
  });

  test('17/O. concurrencia: mismo clientOperationId simultáneo -> 1 fila; distintos simultáneos mismo animal y fecha -> N filas', async () => {
    const org = crypto.randomUUID();
    const animalId = await seedAnimal(org);
    const value = pesaje({ fecha: '2025-03-03', pesoKg: 400 });
    const resultados = await Promise.all(Array.from({ length: 5 }, () => registrar(org, animalId, value)));
    assert.equal(resultados.filter((r) => !r.yaExistia).length, 1);
    assert.equal(new Set(resultados.map((r) => r.pesaje.pesajeId)).size, 1);
    assert.equal(await countPesajes(animalId), 1);

    const distintos = await Promise.all(Array.from({ length: 4 }, (_, i) => registrar(org, animalId, pesaje({ fecha: '2025-03-03', pesoKg: 401 + i }))));
    assert.ok(distintos.every((r) => !r.yaExistia));
    assert.equal(await countPesajes(animalId), 5);
    const h = await service.obtenerHistorialPesajes(org, animalId);
    assert.ok(h.pesajes.every((x) => x.gmdKgDia === null), 'mismo día -> GMD null');
  });

  test('26/27. REGISTRO_INICIAL sigue único por animal; MANUAL ilimitado; ambos en el mismo historial', async () => {
    const org = crypto.randomUUID();
    const animalId = await seedAnimal(org, { pesoInicialKg: 250 });
    assert.equal(await countPesajes(animalId, "and origen = 'REGISTRO_INICIAL'"), 1);
    await assert.rejects(
      adminPool.query(
        `insert into agx.animal_pesajes (organizacion_id, animal_id, fecha, peso_kg, metodo, origen, actor_cuenta_id)
         values ($1, $2, '2025-01-01', 100, 'BASCULA', 'REGISTRO_INICIAL', $3)`,
        [org, animalId, ACTOR],
      ),
      { code: '23505' },
    );
    for (let i = 0; i < 3; i += 1) await registrar(org, animalId, pesaje({ fecha: HOY, pesoKg: 251 + i }));
    assert.equal(await countPesajes(animalId, "and origen = 'MANUAL'"), 3);
    const h = await service.obtenerHistorialPesajes(org, animalId);
    assert.equal(h.pesajes[0].origen, 'REGISTRO_INICIAL');
    assert.equal(h.resumen.gananciaAcumulada.primerPesoRegistradoKg, 250);
  });

  test('28-30. no toca QR, animales, eventos ni la columna de estado (solo animal_pesajes)', async () => {
    const org = crypto.randomUUID();
    const animalId = await seedAnimal(org);
    const snapshot = async () => (await adminPool.query(
      `select (select count(*) from agx.qr_chapetas) qr, (select count(*) from agx.qr_chapeta_eventos) qr_ev,
              (select count(*) from agx.animal_eventos where animal_id = $1) eventos,
              (select md5(a::text) from agx.animales a where animal_id = $1) animal`,
      [animalId],
    )).rows[0];
    const antes = await snapshot();
    await registrar(org, animalId, pesaje());
    assert.deepEqual(await snapshot(), antes);
  });
});
