// CATX-DELIVERY-001: pruebas de los adaptadores de almacenamiento.
//
// localFsStorage y resolveStorageAdapter() se prueban 100% en memoria/disco
// temporal (sin Postgres). postgresBlobStorage tiene dos tipos de prueba:
// la validación de tamaño máximo (ajuste obligatorio #6) es pura -- ocurre
// ANTES de tocar la base de datos, así que corre siempre -- y el roundtrip
// put/get real requiere Postgres, así que se auto-omite si no hay base
// alcanzable (mismo criterio que el resto de pruebas de integración de
// CatastroX).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import * as localFsStorage from '../localFsStorage.js';
import * as postgresBlobStorage from '../postgresBlobStorage.js';
import { resolveStorageAdapter } from '../storageAdapter.js';

let dbAvailable = false;
let query;
let paymentOrders;

try {
  const { getConfig } = await import('../../../../config/env.js');
  ({ query } = await import('../../../../db.js'));
  getConfig();
  const { getDbPool } = await import('../../../../db.js');
  const pool = getDbPool();
  await pool.query('select 1');
  const tableCheck = await pool.query("select to_regclass('public.catastrox_deliverable_blobs') as t");
  dbAvailable = Boolean(tableCheck.rows[0]?.t);
} catch {
  dbAvailable = false;
}

if (dbAvailable) {
  paymentOrders = await import('../../paymentOrderRepository.js');
}

const TEST_CODIGO = '900000000000000000000000000077';

function randomUuid() {
  return crypto.randomUUID();
}

describe('localFsStorage (solo desarrollo, sin Postgres)', () => {
  test('put()/get() hacen roundtrip exacto de los bytes', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'catx-localfs-'));
    const originalDir = process.env.CATASTROX_LOCAL_STORAGE_DIR;
    process.env.CATASTROX_LOCAL_STORAGE_DIR = tmpDir;
    try {
      const deliverableId = randomUuid();
      const buffer = Buffer.from('%PDF-1.4 contenido de prueba', 'utf8');

      const putResult = await localFsStorage.put(deliverableId, buffer, { contentType: 'application/pdf' });
      assert.equal(putResult.storageKey, `local:${deliverableId}`);

      const getResult = await localFsStorage.get(deliverableId);
      assert.ok(Buffer.isBuffer(getResult.bytes));
      assert.deepEqual(getResult.bytes, buffer);
      assert.equal(getResult.contentType, 'application/pdf');
    } finally {
      if (originalDir === undefined) delete process.env.CATASTROX_LOCAL_STORAGE_DIR;
      else process.env.CATASTROX_LOCAL_STORAGE_DIR = originalDir;
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test('get() de un deliverableId que nunca se guardó devuelve null (nunca lanza)', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'catx-localfs-'));
    const originalDir = process.env.CATASTROX_LOCAL_STORAGE_DIR;
    process.env.CATASTROX_LOCAL_STORAGE_DIR = tmpDir;
    try {
      const result = await localFsStorage.get(randomUuid());
      assert.equal(result, null);
    } finally {
      if (originalDir === undefined) delete process.env.CATASTROX_LOCAL_STORAGE_DIR;
      else process.env.CATASTROX_LOCAL_STORAGE_DIR = originalDir;
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test('put() rechaza un buffer vacío', async () => {
    await assert.rejects(
      () => localFsStorage.put(randomUuid(), Buffer.alloc(0)),
      (error) => error.code === 'EMPTY_DELIVERABLE_BUFFER',
    );
  });

  test('put() rechaza un deliverableId que no tiene forma de UUID (defensa contra path traversal)', async () => {
    await assert.rejects(
      () => localFsStorage.put('../../etc/passwd', Buffer.from('x')),
      (error) => error.code === 'DELIVERABLE_ID_REQUIRED',
    );
  });
});

// Ajuste obligatorio #6: límite máximo documentado (10 MB por defecto,
// configurable vía CATASTROX_DELIVERABLE_MAX_BYTES) -- se aplica ANTES de
// intentar el INSERT, así que esta prueba no necesita Postgres real.
describe('postgresBlobStorage: límite de tamaño (aplicación, ajuste #6)', () => {
  test('resolveMaxDeliverableBytes() usa 10 MB por defecto', () => {
    assert.equal(postgresBlobStorage.resolveMaxDeliverableBytes({}), 10 * 1024 * 1024);
  });

  test('resolveMaxDeliverableBytes() respeta CATASTROX_DELIVERABLE_MAX_BYTES cuando es válido', () => {
    assert.equal(postgresBlobStorage.resolveMaxDeliverableBytes({ CATASTROX_DELIVERABLE_MAX_BYTES: '1000' }), 1000);
  });

  test('put() rechaza un buffer que excede el límite (DELIVERABLE_TOO_LARGE), sin necesitar Postgres', async () => {
    const oversized = Buffer.alloc(11 * 1024 * 1024, 1);
    await assert.rejects(
      () => postgresBlobStorage.put(randomUuid(), oversized, { contentType: 'application/pdf' }),
      (error) => error.code === 'DELIVERABLE_TOO_LARGE',
    );
  });

  test('put() rechaza un buffer vacío, sin necesitar Postgres', async () => {
    await assert.rejects(
      () => postgresBlobStorage.put(randomUuid(), Buffer.alloc(0)),
      (error) => error.code === 'EMPTY_DELIVERABLE_BUFFER',
    );
  });

  test('put() rechaza sin deliverableId, sin necesitar Postgres', async () => {
    await assert.rejects(
      () => postgresBlobStorage.put(null, Buffer.from('x')),
      (error) => error.code === 'DELIVERABLE_ID_REQUIRED',
    );
  });
});

describe('postgresBlobStorage: roundtrip real (integración, requiere Postgres)', { skip: !dbAvailable }, () => {
  test('put()/get() hacen roundtrip exacto de los bytes vía catastrox_deliverable_blobs', async () => {
    // delivery_job_id es NOT NULL + FK real -- se crea una orden y un
    // delivery job mínimos primero (mismo patrón que
    // customerEmailChangeAndJobConcurrency.test.js), luego una fila de
    // metadatos en catastrox_deliverables, igual que hace
    // deliveryJobService.generateAndStoreDeliverable en el flujo real.
    const order = await paymentOrders.insertPendingOrder({
      orderToken: paymentOrders.generateOrderToken(),
      packageId: 'basico',
      canonicalPredioId: TEST_CODIGO,
      codigoPredialNormalized: TEST_CODIGO,
      customerId: null,
      idempotencyKey: `storage-adapter-test-${Date.now()}`,
      wompiReference: `CATX-STORAGETEST-${Date.now()}`,
      expectedAmountInCents: 3990000,
      currency: 'COP',
    });
    const jobRow = await query(
      `insert into public.catastrox_delivery_jobs (payment_order_id, status) values ($1, 'QUEUED') returning id`,
      [order.id],
    );
    const jobId = jobRow.rows[0].id;

    const deliverableInsert = await query(
      `insert into public.catastrox_deliverables (delivery_job_id, file_type, content_hash, byte_size, file_name)
       values ($1, 'pdf', 'test-hash', 1, 'test.pdf') returning id`,
      [jobId],
    );
    const deliverableRowId = deliverableInsert.rows[0].id;

    try {
      const buffer = Buffer.from('%PDF-1.4 contenido de prueba postgres', 'utf8');
      const putResult = await postgresBlobStorage.put(deliverableRowId, buffer, { contentType: 'application/pdf' });
      assert.equal(putResult.storageKey, `pg:${deliverableRowId}`);

      const getResult = await postgresBlobStorage.get(deliverableRowId);
      assert.ok(Buffer.isBuffer(getResult.bytes));
      assert.deepEqual(getResult.bytes, buffer);
      assert.equal(getResult.contentType, 'application/pdf');
    } finally {
      await query('delete from public.catastrox_deliverable_blobs where deliverable_id = $1', [deliverableRowId]);
      await query('delete from public.catastrox_deliverables where id = $1', [deliverableRowId]);
      await query('delete from public.catastrox_delivery_jobs where id = $1', [jobId]);
      await query('delete from public.catastrox_payment_orders where id = $1', [order.id]);
    }
  });

  test('get() de un deliverable_id que nunca se guardó devuelve null', async () => {
    const result = await postgresBlobStorage.get(randomUuid());
    assert.equal(result, null);
  });
});

describe('resolveStorageAdapter()', () => {
  test('default (sin CATASTROX_STORAGE_DRIVER) resuelve a postgresBlobStorage', () => {
    const adapter = resolveStorageAdapter({});
    assert.equal(adapter, postgresBlobStorage);
  });

  test('CATASTROX_STORAGE_DRIVER=postgres resuelve a postgresBlobStorage', () => {
    const adapter = resolveStorageAdapter({ CATASTROX_STORAGE_DRIVER: 'postgres' });
    assert.equal(adapter, postgresBlobStorage);
  });

  test('CATASTROX_STORAGE_DRIVER=local-dev-only resuelve a localFsStorage (fuera de producción)', () => {
    const adapter = resolveStorageAdapter({ CATASTROX_STORAGE_DRIVER: 'local-dev-only', APP_ENV: 'development' });
    assert.equal(adapter, localFsStorage);
  });

  test('driver desconocido lanza UNKNOWN_STORAGE_DRIVER', () => {
    assert.throws(
      () => resolveStorageAdapter({ CATASTROX_STORAGE_DRIVER: 's3-nunca-implementado' }),
      (error) => error.code === 'UNKNOWN_STORAGE_DRIVER',
    );
  });

  test('local-dev-only en producción lanza STORAGE_DRIVER_NOT_ALLOWED_IN_PRODUCTION (segunda barrera, redundante con env.js)', () => {
    assert.throws(
      () => resolveStorageAdapter({ CATASTROX_STORAGE_DRIVER: 'local-dev-only', APP_ENV: 'production' }),
      (error) => error.code === 'STORAGE_DRIVER_NOT_ALLOWED_IN_PRODUCTION',
    );
  });
});
