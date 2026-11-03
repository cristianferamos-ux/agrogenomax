// FASE 4E.1 -- pull reproductivo en el dispositivo: upsert idempotente, ANULADO
// terminal, cursor propio, totales y paginación en el motor real. Operaciones
// pendientes: reproduccionConciliacion.test.js. Contrato contra PostgreSQL:
// reproduccionSyncIntegration.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { ORG_DB_VERSION, ORG_STORES, orgDbName } from '../offlineSchema.js';
import { createIndexedDbStorage, createMemoryStorage, openIndexedDb } from '../storage.js';
import { createLocalRepo } from '../localRepo.js';
import { REPRO_MAX_PAGINAS_POR_CICLO, RUN_RESULT, createSyncEngine } from '../syncEngine.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTRA_ORG = '22222222-2222-4222-8222-222222222222';
const REPRO = '/api/ganaderia/sync/reproduccion';
const CURSOR_GENERAL = 'cursor-general';

const crearRepo = (storage = createMemoryStorage(ORG_STORES)) => createLocalRepo(storage, { organizacionId: ORG, deviceId: 'd', now: () => new Date('2026-10-20T15:00:00.000Z') });

const evento = (id, cambios = {}) => ({
  eventoId: String(id),
  animalId: '7',
  tipoEvento: 'IATF',
  fechaEvento: '2026-10-01',
  horaEvento: null,
  observaciones: null,
  detalle: { protocoloIatf: 'J-Synch' },
  estadoRegistro: 'ACTIVO',
  corrigeEventoId: null,
  corregidoPorEventoId: null,
  anulacion: null,
  registradoEn: '2026-10-01T10:00:00.000000Z',
  clientOperationId: `c-${id}`,
  ...cambios,
});
const anulado = (id, cambios = {}) => evento(id, { estadoRegistro: 'ANULADO', anulacion: { anuladoEn: '2026-10-05T10:00:00.000000Z', motivo: 'Error de digitación' }, ...cambios });
const pagina = (eventos, cambios = {}) => {
  const totales = { eventos: eventos.length, anulados: eventos.filter((e) => e.estadoRegistro === 'ANULADO').length };
  return { organizacionId: ORG, eventos, cursor: 'cur-1', hayMas: false, completo: true, totales, ...cambios };
};

// ---------------------------------------------------------------------------
// Upsert local
// ---------------------------------------------------------------------------

test('evento nuevo entra con sus campos planos para el plegado del estado', async () => {
  const repo = crearRepo();
  await repo.aplicarPullReproduccion(pagina([evento(1)]));
  const [guardado] = await repo.listEventosReproductivos('7');
  assert.equal(guardado.eventoId, '1');
  assert.equal(guardado.protocoloIatf, 'J-Synch');
  assert.equal(guardado.clientOperationId, 'c-1');
});

test('el mismo evento recibido dos veces no duplica (solape)', async () => {
  const repo = crearRepo();
  await repo.aplicarPullReproduccion(pagina([evento(1), evento(2)]));
  await repo.aplicarPullReproduccion(pagina([evento(2), evento(1)], { totales: { eventos: 2, anulados: 0 } }));
  assert.equal((await repo.listEventosReproductivos('7')).length, 2);
});

test('evento anulado después: la misma fila pasa a ANULADO y conserva su trazabilidad', async () => {
  const repo = crearRepo();
  await repo.aplicarPullReproduccion(pagina([evento(1)]));
  await repo.aplicarPullReproduccion(pagina([anulado(1, { corregidoPorEventoId: '2' })]));
  const [guardado] = await repo.listEventosReproductivos('7');
  assert.equal(guardado.estadoRegistro, 'ANULADO');
  assert.deepEqual(guardado.anulacion, { anuladoEn: '2026-10-05T10:00:00.000000Z', motivo: 'Error de digitación' });
  assert.equal(guardado.corregidoPorEventoId, '2');
  assert.equal(guardado.protocoloIatf, 'J-Synch', 'el contenido original sigue');
});

test('ANULADO es terminal: una copia antigua reentregada nunca lo revierte', async () => {
  const repo = crearRepo();
  await repo.aplicarPullReproduccion(pagina([anulado(1)]));
  await repo.aplicarPullReproduccion(pagina([evento(1)], { totales: { eventos: 1, anulados: 1 } }));
  assert.equal((await repo.listEventosReproductivos('7'))[0].estadoRegistro, 'ANULADO');
});

test('página de otra organización: no se aplica nada', async () => {
  const repo = crearRepo();
  await assert.rejects(repo.aplicarPullReproduccion(pagina([evento(1)], { organizacionId: OTRA_ORG })), { code: 'ORGANIZACION_DISTINTA' });
  assert.deepEqual(await repo.listEventosReproductivos('7'), []);
  assert.equal((await repo.getMeta()).reproduccionCursor, undefined);
});

for (const [nombre, cambios] of [
  ['sin eventos', { eventos: undefined }],
  ['sin cursor', { cursor: undefined }],
  ['última página sin totales', { totales: null }],
]) {
  test(`respuesta malformada (${nombre}): no aplica nada`, async () => {
    const repo = crearRepo();
    await assert.rejects(repo.aplicarPullReproduccion(pagina([evento(1)], cambios)), { code: 'PULL_REPRODUCCION_INVALIDO' });
    assert.deepEqual(await repo.listEventosReproductivos('7'), []);
  });
}

test('una fila malformada no deja la página a medias', async () => {
  const repo = crearRepo();
  await assert.rejects(repo.aplicarPullReproduccion(pagina([evento(1), { eventoId: '2' }])), { code: 'PULL_REPRODUCCION_INVALIDO' });
  assert.deepEqual(await repo.listEventosReproductivos('7'), []);
});

test('el cursor reproductivo es independiente del general', async () => {
  const repo = crearRepo();
  await repo.putMeta({ cursor: CURSOR_GENERAL });
  await repo.aplicarPullReproduccion(pagina([evento(1)]));
  const meta = await repo.getMeta();
  assert.equal(meta.cursor, CURSOR_GENERAL);
  assert.equal(meta.reproduccionCursor, 'cur-1');
  await repo.aplicarPull({ organizacionId: ORG, cursor: 'general-2', completo: false, animales: [], chapetas: [], predios: [], potreros: [], razas: [], categorias: [] });
  const despues = await repo.getMeta();
  assert.equal(despues.cursor, 'general-2');
  assert.equal(despues.reproduccionCursor, 'cur-1');
});

test('el upsert funciona igual sobre IndexedDB real, en una transacción', async () => {
  const idb = new IDBFactory();
  const db = await openIndexedDb(idb, orgDbName(ORG), ORG_DB_VERSION, ORG_STORES);
  const repo = crearRepo(createIndexedDbStorage(db, ORG_STORES));
  await repo.aplicarPullReproduccion(pagina([evento(1), evento(2)]));
  await repo.aplicarPullReproduccion(pagina([anulado(2), evento(1)], { totales: { eventos: 2, anulados: 1 } }));
  const guardados = await repo.listEventosReproductivos('7');
  assert.deepEqual(guardados.map((e) => e.estadoRegistro).sort(), ['ACTIVO', 'ANULADO']);
  db.close();
});

// ---------------------------------------------------------------------------
// Totales: la garantía que no depende de timestamps
// ---------------------------------------------------------------------------

test('fin de recorrido sin desfase: habilita el registro local una vez', async () => {
  const repo = crearRepo();
  assert.equal((await repo.getMeta()).reproduccionListaAt, undefined);
  assert.deepEqual(await repo.aplicarPullReproduccion(pagina([evento(1)])), { hayMas: false, desfase: false });
  const { reproduccionListaAt, reproduccionSyncAt } = await repo.getMeta();
  assert.ok(reproduccionListaAt);
  assert.ok(reproduccionSyncAt);
});

test('recorrido a medias: no habilita nada ni concilia', async () => {
  const repo = crearRepo();
  const res = await repo.aplicarPullReproduccion(pagina([evento(1)], { hayMas: true, totales: null }));
  assert.deepEqual(res, { hayMas: true, desfase: false });
  assert.equal((await repo.getMeta()).reproduccionListaAt, undefined);
  assert.equal((await repo.getMeta()).reproduccionCursor, 'cur-1');
});

test('falta un evento: reinicia el cursor y no se habilita el registro local', async () => {
  const repo = crearRepo();
  const res = await repo.aplicarPullReproduccion(pagina([evento(1)], { totales: { eventos: 2, anulados: 0 } }));
  assert.equal(res.desfase, true);
  const meta = await repo.getMeta();
  assert.equal(meta.reproduccionCursor, null);
  assert.ok(meta.reproduccionDesfaseAt);
  assert.equal(meta.reproduccionListaAt, undefined);
});

test('falta una anulación aunque el número de eventos cuadre: también es desfase', async () => {
  const repo = crearRepo();
  await repo.aplicarPullReproduccion(pagina([evento(1)]));
  const res = await repo.aplicarPullReproduccion(pagina([], { totales: { eventos: 1, anulados: 1 } }));
  assert.equal(res.desfase, true);
  assert.equal((await repo.getMeta()).reproduccionCursor, null);
});

test('el dispositivo con más que el servidor (commit entre lecturas) no es desfase', async () => {
  const repo = crearRepo();
  const res = await repo.aplicarPullReproduccion(pagina([evento(1), anulado(2)], { totales: { eventos: 1, anulados: 0 } }));
  assert.equal(res.desfase, false);
  assert.equal((await repo.getMeta()).reproduccionCursor, 'cur-1');
});

// ---------------------------------------------------------------------------
// Motor
// ---------------------------------------------------------------------------

function transporte(respuestas) {
  const pedidos = [];
  const generales = [];
  return {
    pedidos,
    generales,
    async postJson() { return { ok: true, status: 201, data: {} }; },
    async getJson(ruta) {
      if (ruta.startsWith(REPRO)) {
        pedidos.push(ruta);
        const siguiente = typeof respuestas === 'function' ? respuestas(ruta, pedidos.length) : respuestas[pedidos.length - 1];
        if (siguiente === 'red') throw new TypeError('Failed to fetch');
        return siguiente;
      }
      generales.push(ruta);
      return { ok: true, status: 200, data: { organizacionId: ORG, cursor: CURSOR_GENERAL, completo: false, animales: [], chapetas: [], predios: [], potreros: [], razas: [], categorias: [] } };
    },
  };
}
const motor = (repo, transport) => createSyncEngine({ repo, transport, random: () => 0.5 });
const bien = (data) => ({ ok: true, status: 200, data });

test('recorre las páginas con su cursor, sin pasarle el del pull general', async () => {
  const repo = crearRepo();
  const t = transporte([
    bien(pagina([evento(1)], { hayMas: true, totales: null, cursor: 'p/1' })),
    bien(pagina([evento(1), evento(2)], { cursor: 'p2', totales: { eventos: 2, anulados: 0 } })),
  ]);
  assert.equal(await motor(repo, t).syncNow(), RUN_RESULT.OK);
  assert.deepEqual(t.pedidos, [REPRO, `${REPRO}?cursor=p%2F1`]);
  assert.equal((await repo.listEventosReproductivos('7')).length, 2);
  assert.equal((await repo.getMeta()).reproduccionCursor, 'p2');
  assert.equal((await repo.getMeta()).cursor, CURSOR_GENERAL);
});

test('el siguiente ciclo continúa desde su cursor guardado', async () => {
  const repo = crearRepo();
  await repo.putMeta({ reproduccionCursor: 'guardado' });
  const t = transporte([bien(pagina([], { cursor: 'nuevo', totales: { eventos: 0, anulados: 0 } }))]);
  await motor(repo, t).syncNow();
  assert.deepEqual(t.pedidos, [`${REPRO}?cursor=guardado`]);
});

test('una descarga grande se reparte entre ciclos y no se pierde el avance', async () => {
  const repo = crearRepo();
  const t = transporte((_ruta, n) => bien(pagina([evento(n)], { hayMas: true, totales: null, cursor: `p${n}` })));
  await motor(repo, t).syncNow();
  assert.equal(t.pedidos.length, REPRO_MAX_PAGINAS_POR_CICLO);
  assert.equal((await repo.getMeta()).reproduccionCursor, `p${REPRO_MAX_PAGINAS_POR_CICLO}`);
});

test('cursor rechazado por el servidor: reinicia una vez y hace un recorrido completo', async () => {
  const repo = crearRepo();
  await repo.putMeta({ reproduccionCursor: 'viejo' });
  const t = transporte([{ ok: false, status: 400, data: { error: 'INVALID_CURSOR' } }, bien(pagina([evento(1)]))]);
  await motor(repo, t).syncNow();
  assert.deepEqual(t.pedidos, [`${REPRO}?cursor=viejo`, REPRO]);
  assert.equal((await repo.listEventosReproductivos('7')).length, 1);
});

test('INVALID_CURSOR sin cursor no entra en bucle', async () => {
  const repo = crearRepo();
  const t = transporte(() => ({ ok: false, status: 400, data: { error: 'INVALID_CURSOR' } }));
  await motor(repo, t).syncNow();
  assert.equal(t.pedidos.length, 1);
  assert.equal((await repo.getMeta()).reproduccionUltimoError.codigo, 'INVALID_CURSOR');
});

for (const [nombre, respuesta, codigo] of [
  ['servidor sin el endpoint (404)', { ok: false, status: 404, data: { error: 'NOT_FOUND' } }, 'NOT_FOUND'],
  ['error del servidor', { ok: false, status: 503, data: {} }, 'ERROR'],
  ['sin red', 'red', 'ERROR_LOCAL'],
  ['otra organización', bien(pagina([evento(1)], { organizacionId: OTRA_ORG })), 'ORGANIZACION_DISTINTA'],
  ['respuesta malformada', bien({ organizacionId: ORG }), 'PULL_REPRODUCCION_INVALIDO'],
]) {
  test(`${nombre}: no cambia el resultado del ciclo, conserva el cursor y deja constancia`, async () => {
    const repo = crearRepo();
    await repo.putMeta({ reproduccionCursor: 'guardado' });
    const t = transporte([respuesta]);
    assert.equal(await motor(repo, t).syncNow(), RUN_RESULT.OK);
    const meta = await repo.getMeta();
    assert.equal(meta.reproduccionCursor, 'guardado');
    assert.equal(meta.reproduccionUltimoError.codigo, codigo);
    assert.equal(meta.ultimaSyncOk, true, 'el pull general no se ve afectado');
  });
}

test('un fallo que se repite se anota una sola vez y no notifica en cada ciclo', async () => {
  const repo = crearRepo();
  const fallo = { ok: false, status: 503, data: { error: 'CAIDO' } };
  const t = transporte(() => fallo);
  await motor(repo, t).syncNow();
  const primero = (await repo.getMeta()).reproduccionUltimoError;
  let avisosRepro = 0;
  const putMeta = repo.putMeta;
  repo.putMeta = async (cambios) => {
    if ('reproduccionUltimoError' in cambios) avisosRepro += 1;
    return putMeta(cambios);
  };
  await motor(repo, t).syncNow();
  assert.equal(avisosRepro, 0);
  assert.deepEqual((await repo.getMeta()).reproduccionUltimoError, primero);
});

test('un recorrido sin novedades no notifica por sí mismo', async () => {
  const repo = crearRepo();
  await repo.aplicarPullReproduccion(pagina([]));
  let avisos = 0;
  repo.subscribe(() => { avisos += 1; });
  await repo.aplicarPullReproduccion(pagina([], { cursor: 'cur-2' }));
  assert.equal(avisos, 0);
  assert.equal((await repo.getMeta()).reproduccionCursor, 'cur-2');
});

test('un pull correcto limpia el error anterior', async () => {
  const repo = crearRepo();
  await repo.putMeta({ reproduccionUltimoError: { codigo: 'X' } });
  await motor(repo, transporte([bien(pagina([]))])).syncNow();
  assert.equal((await repo.getMeta()).reproduccionUltimoError, null);
});

test('soloPush no pide el pull reproductivo', async () => {
  const t = transporte([]);
  await motor(crearRepo(), t).syncNow({ soloPush: true });
  assert.deepEqual(t.pedidos, []);
});

test('si falla el pull general no se pide el reproductivo', async () => {
  const t = transporte([]);
  t.getJson = async (ruta) => {
    t.pedidos.push(ruta);
    return { ok: false, status: 503, data: {} };
  };
  assert.equal(await motor(crearRepo(), t).syncNow(), RUN_RESULT.ERROR);
  assert.equal(t.pedidos.some((r) => r.startsWith(REPRO)), false);
});
