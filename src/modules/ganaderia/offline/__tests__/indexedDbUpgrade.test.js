// FASE 4E.1 -- IndexedDB v1 -> v2 con una implementación completa de IndexedDB
// (fake-indexeddb, solo pruebas): upgrade sin pérdida, versionchange, blocked,
// reapertura y base más nueva que el código. Una IDBFactory nueva por prueba.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { IDBFactory } from 'fake-indexeddb';
import { ORG_DB_VERSION, ORG_STORES, orgDbName } from '../offlineSchema.js';
import { createIndexedDbStorage, createMemoryStorage, openIndexedDb } from '../storage.js';
import { createLocalRepo } from '../localRepo.js';
import { esBaseMasNueva } from '../browserOffline.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const NOMBRE = orgDbName(ORG);

// Esquema v1 TAL COMO se publicó: congelado aquí a propósito.
const ORG_STORES_V1 = Object.freeze({
  meta: { keyPath: 'key', indexes: [] },
  animales: {
    keyPath: 'key',
    indexes: [['animalId', 'animalId', false], ['localUuid', 'localUuid', false], ['clientOperationId', 'clientOperationId', false], ['estadoSync', 'estadoSync', false]],
  },
  chapetas: { keyPath: 'codigoVisible', indexes: [['tokenHash', 'tokenHash', false], ['animalId', 'animalId', false], ['estado', 'estado', false]] },
  predios: { keyPath: 'predioId', indexes: [] },
  potreros: { keyPath: 'potreroId', indexes: [['predioId', 'predioId', false]] },
  razas: { keyPath: 'razaId', indexes: [] },
  categorias: { keyPath: 'categoriaId', indexes: [] },
  outbox: { keyPath: 'operationId', indexes: [['estado', 'estado', false], ['createdAt', 'createdAt', false], ['localUuid', 'localUuid', false]] },
  aliases: { keyPath: 'localUuid', indexes: [] },
});

const OP_V1 = Object.freeze({
  operationId: 'op-1',
  clientOperationId: 'c-1',
  tipoOperacion: 'PESAJE_CREAR',
  entidad: 'pesaje',
  localUuid: 'l-1',
  payload: { animalId: '7', fecha: '2026-10-01', pesoKg: 300, metodo: 'BASCULA', clientOperationId: 'c-1' },
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  estado: 'PENDIENTE',
  intentos: 0,
  ultimoError: null,
  siguienteIntentoAt: null,
  deviceId: 'd-1',
});
const META_V1 = Object.freeze({ key: 'sync', organizacionId: ORG, cursor: 'cursor-v1', ultimaSyncAt: '2026-10-01T00:00:00.000Z', ultimaSyncOk: true, ultimoError: null, preparadoAt: '2026-09-01T00:00:00.000Z' });
const ANIMAL_V1 = Object.freeze({ key: 'srv:7', animalId: '7', sexo: 'HEMBRA', estado: 'ACTIVO', estadoSync: 'SINCRONIZADO' });

async function baseV1(idb) {
  const db = await openIndexedDb(idb, NOMBRE, 1, ORG_STORES_V1);
  await createIndexedDbStorage(db).batch([
    { op: 'put', store: 'outbox', value: OP_V1 },
    { op: 'put', store: 'meta', value: META_V1 },
    { op: 'put', store: 'animales', value: ANIMAL_V1 },
  ]);
  return db;
}

const abrirV2 = (idb, opciones) => openIndexedDb(idb, NOMBRE, ORG_DB_VERSION, ORG_STORES, opciones);

test('la versión vigente es la 2 y el nombre de la base no cambia', () => {
  assert.equal(ORG_DB_VERSION, 2);
  assert.equal(NOMBRE, `agx-ganaderia-org-v1-${ORG}`);
});

test('v1 -> v2: conserva outbox, cursor y copia local; agrega store e índice', async () => {
  const idb = new IDBFactory();
  (await baseV1(idb)).close();

  const db = await abrirV2(idb);
  assert.equal(db.version, 2);
  assert.ok(db.objectStoreNames.contains('reproduccion_eventos'));
  const tx = db.transaction(['outbox', 'reproduccion_eventos'], 'readonly');
  assert.ok(tx.objectStore('outbox').indexNames.contains('claveOrden'));
  assert.deepEqual([...tx.objectStore('reproduccion_eventos').indexNames].sort(), ['animalId', 'clientOperationId']);

  const storage = createIndexedDbStorage(db);
  assert.deepEqual(await storage.get('outbox', 'op-1'), OP_V1);
  assert.deepEqual(await storage.get('meta', 'sync'), META_V1);
  assert.deepEqual(await storage.get('animales', 'srv:7'), ANIMAL_V1);
  assert.deepEqual(await storage.getAll('reproduccion_eventos'), []);
  await storage.close();
});

test('v1 -> v2: una operación anterior sin claveOrden no entra en ninguna cadena', async () => {
  const idb = new IDBFactory();
  (await baseV1(idb)).close();
  const storage = createIndexedDbStorage(await abrirV2(idb));
  const repo = createLocalRepo(storage, { organizacionId: ORG, deviceId: 'd-1' });
  assert.deepEqual(await repo.cadenaReproductiva('7'), []);
  assert.equal((await repo.contar()).pendientes, 1);
  await storage.close();
});

test('v2 sobre v2 es idempotente y conserva los datos', async () => {
  const idb = new IDBFactory();
  const primera = createIndexedDbStorage(await abrirV2(idb));
  await primera.put('reproduccion_eventos', { eventoId: '1', animalId: '7' });
  await primera.close();
  const segunda = createIndexedDbStorage(await abrirV2(idb));
  assert.deepEqual(await segunda.getAll('reproduccion_eventos'), [{ eventoId: '1', animalId: '7' }]);
  await segunda.close();
});

test('upgrade abortado: la base sigue en v1 con todos sus datos', async () => {
  const idb = new IDBFactory();
  (await baseV1(idb)).close();

  // La transacción de upgrade falla a mitad de camino, con el store ya creado.
  const request = idb.open(NOMBRE, 2);
  await new Promise((resolve) => {
    request.onupgradeneeded = () => {
      request.result.createObjectStore('reproduccion_eventos', { keyPath: 'eventoId' });
      request.transaction.abort();
    };
    request.onerror = (event) => {
      event.preventDefault?.();
      resolve();
    };
    request.onsuccess = () => resolve();
  });

  const db = await openIndexedDb(idb, NOMBRE, 1, ORG_STORES_V1);
  assert.equal(db.version, 1);
  assert.equal(db.objectStoreNames.contains('reproduccion_eventos'), false);
  assert.deepEqual(await createIndexedDbStorage(db).get('outbox', 'op-1'), OP_V1);
  db.close();
});

test('conexión v1 sin onversionchange (pestaña antigua): avisa, espera y luego actualiza sin perder datos', async () => {
  const idb = new IDBFactory();
  const antigua = await baseV1(idb);
  antigua.onversionchange = null; // el código publicado no lo maneja

  let avisos = 0;
  let resuelta = false;
  const apertura = abrirV2(idb, { onBlocked: () => { avisos += 1; } }).then((db) => { resuelta = true; return db; });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(avisos, 1);
  assert.equal(resuelta, false, 'sigue pendiente: no falla con un error críptico');

  antigua.close();
  const db = await apertura;
  assert.equal(db.version, 2);
  assert.deepEqual(await createIndexedDbStorage(db).get('outbox', 'op-1'), OP_V1);
  db.close();
});

test('onversionchange cierra la conexión y notifica; la otra apertura continúa sin bloquearse', async () => {
  const idb = new IDBFactory();
  let cerrada = 0;
  const actual = await openIndexedDb(idb, NOMBRE, 2, ORG_STORES, { onVersionChange: () => { cerrada += 1; } });
  let bloqueos = 0;
  const v3 = await openIndexedDb(idb, NOMBRE, 3, ORG_STORES, { onBlocked: () => { bloqueos += 1; } });
  assert.equal(cerrada, 1);
  assert.equal(bloqueos, 0);
  assert.equal(v3.version, 3);
  assert.throws(() => actual.transaction('outbox'));
  v3.close();
});

test('borrar la base desde otra pestaña también cierra esta conexión', async () => {
  const idb = new IDBFactory();
  let cerrada = 0;
  await abrirV2(idb, { onVersionChange: () => { cerrada += 1; } });
  await new Promise((resolve, reject) => {
    const request = idb.deleteDatabase(NOMBRE);
    request.onsuccess = resolve;
    request.onerror = reject;
  });
  assert.equal(cerrada, 1);
});

test('esperaBloqueoMs (Service Worker): deja de esperar y cierra la conexión si llega tarde', async () => {
  const idb = new IDBFactory();
  const antigua = await baseV1(idb);
  antigua.onversionchange = null;
  await assert.rejects(abrirV2(idb, { esperaBloqueoMs: 10 }), (error) => error.code === 'IDB_BLOQUEADA');

  antigua.close();
  await new Promise((resolve) => setTimeout(resolve, 20));
  // La apertura abandonada completó el upgrade y se cerró: no bloquea a nadie.
  let bloqueos = 0;
  const v3 = await openIndexedDb(idb, NOMBRE, 3, ORG_STORES, { onBlocked: () => { bloqueos += 1; } });
  assert.equal(bloqueos, 0);
  assert.deepEqual(await createIndexedDbStorage(v3).get('outbox', 'op-1'), OP_V1);
  v3.close();
});

test('base más nueva que el código (rollback): VersionError identificable y datos intactos', async () => {
  const idb = new IDBFactory();
  const v3 = await openIndexedDb(idb, NOMBRE, 3, ORG_STORES);
  await createIndexedDbStorage(v3).put('outbox', OP_V1);
  v3.close();

  await assert.rejects(abrirV2(idb), (error) => esBaseMasNueva(error));
  const reabierta = await openIndexedDb(idb, NOMBRE, 3, ORG_STORES);
  assert.deepEqual(await createIndexedDbStorage(reabierta).get('outbox', 'op-1'), OP_V1);
  reabierta.close();
});

test('el Service Worker no se queda esperando un upgrade ni trata la base nueva como fallo', () => {
  const src = fs.readFileSync(new URL('../swSyncEntry.js', import.meta.url), 'utf8');
  assert.match(src, /esperaBloqueoMs: SW_ESPERA_BLOQUEO_MS/);
  assert.match(src, /IDB_BLOQUEADA/);
  assert.match(src, /esBaseMasNueva\(error\)/);
});

test('la interfaz muestra el mensaje funcional y permite reintentar o recargar', () => {
  const barra = fs.readFileSync(new URL('../OfflineStatusBar.jsx', import.meta.url), 'utf8');
  const browser = fs.readFileSync(new URL('../browserOffline.js', import.meta.url), 'utf8');
  assert.match(browser, /Cierra otras pestañas de AgroGenomaX para actualizar el modo offline\./);
  assert.match(barra, /actualizacion_bloqueada/);
  assert.match(barra, /reintentarApertura\(\)/);
  assert.match(barra, /location\.reload\(\)/);
});

// ---------------------------------------------------------------------------
// storage.mutate: mismo contrato en memoria y en IndexedDB
// ---------------------------------------------------------------------------

const ADAPTADORES = {
  memoria: async () => createMemoryStorage(ORG_STORES),
  indexeddb: async () => createIndexedDbStorage(await abrirV2(new IDBFactory())),
};

for (const [nombre, crear] of Object.entries(ADAPTADORES)) {
  test(`mutate (${nombre}): escribe, borra, no cambia y revierte si lanza`, async () => {
    const storage = await crear();
    await storage.put('outbox', { operationId: 'a', estado: 'PENDIENTE' });

    const escrito = await storage.mutate('outbox', 'a', (actual) => ({ ...actual, estado: 'SINCRONIZANDO' }));
    assert.equal(escrito.estado, 'SINCRONIZANDO');
    assert.equal((await storage.get('outbox', 'a')).estado, 'SINCRONIZANDO');

    const igual = await storage.mutate('outbox', 'a', () => undefined);
    assert.equal(igual.estado, 'SINCRONIZANDO');

    const error = Object.assign(new Error('NO'), { code: 'X' });
    await assert.rejects(storage.mutate('outbox', 'a', () => { throw error; }), (e) => e === error);
    assert.equal((await storage.get('outbox', 'a')).estado, 'SINCRONIZANDO');

    assert.equal(await storage.mutate('outbox', 'a', () => null), null);
    assert.equal(await storage.get('outbox', 'a'), undefined);
    assert.equal(await storage.mutate('outbox', 'no-existe', (actual) => { assert.equal(actual, undefined); return undefined; }), undefined);
    await storage.close();
  });
}
