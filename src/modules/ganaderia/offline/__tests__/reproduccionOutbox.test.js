// FASE 4E.1 -- modelo de REPRODUCCION_EVENTO_CREAR en el outbox: claveOrden, FIFO
// por reloj, intención, edición / cancelación e identidad. Sobre memoria e
// IndexedDB (fake-indexeddb, solo pruebas). El envío se prueba en el bloque de sync.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { IDBFactory } from 'fake-indexeddb';
import { ORG_DB_VERSION, ORG_STORES, orgDbName } from '../offlineSchema.js';
import { createIndexedDbStorage, createMemoryStorage, openIndexedDb } from '../storage.js';
import { createLocalRepo, eventoPendienteDe } from '../localRepo.js';
import {
  OUTBOX_ESTADOS,
  REPRODUCCION_EVENTO_CREAR,
  claveOrdenAnimal,
  estaLista,
  firmaIntencion,
  identidadCoincide,
  instanteEnCadena,
  newOperation,
} from '../outbox.js';
import { puedeEncolar } from '../../auth/ganaderiaPermisos.js';
import { buildCrearBody, formInicialEvento } from '../../hato/reproduccionModel.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const CUENTA_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const CUENTA_B = 'bbbbbbbb-0000-4000-8000-000000000002';
const HEMBRA = { key: 'srv:7', animalId: '7', sexo: 'HEMBRA', estado: 'ACTIVO', estadoOperativo: 'EN_HATO' };

function contadorUuid() {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
}

function reloj(inicio = '2026-10-20T15:00:00.000Z') {
  let t = new Date(inicio).getTime();
  return { now: () => new Date(t), avanzar: (ms) => { t += ms; } };
}

async function preparar(storage, { lista = true, animales = [HEMBRA], confirmados = [] } = {}) {
  const r = reloj();
  const repo = createLocalRepo(storage, { organizacionId: ORG, deviceId: 'd-1', now: r.now, uuid: contadorUuid() });
  for (const animal of animales) await storage.put('animales', animal);
  for (const evento of confirmados) await storage.put('reproduccion_eventos', evento);
  if (lista) await repo.putMeta({ reproduccionListaAt: '2026-10-20T14:00:00.000Z' });
  return { repo, storage, reloj: r };
}

const crear = (id, tipoEvento, fechaEvento, extra = {}) => ({ tipoEvento, fechaEvento, ...extra, clientOperationId: id });
const registrar = (repo, body, opciones = {}) => repo.registrarEventoReproductivoLocal({ animalId: '7', body, cuentaId: CUENTA_A, ...opciones });

const ID1 = 'c0000000-0000-4000-8000-000000000001';
const ID2 = 'c0000000-0000-4000-8000-000000000002';

const ADAPTADORES = {
  memoria: async () => createMemoryStorage(ORG_STORES),
  indexeddb: async () => createIndexedDbStorage(await openIndexedDb(new IDBFactory(), orgDbName(ORG), ORG_DB_VERSION, ORG_STORES)),
};

// ---------------------------------------------------------------------------
// Modelo puro
// ---------------------------------------------------------------------------

test('claveOrden exacta por animal', () => {
  assert.equal(claveOrdenAnimal('7'), 'repro:animal:7');
});

test('newOperation: sin claveOrden conserva la forma anterior (animales y pesajes)', () => {
  const op = newOperation({ tipoOperacion: 'PESAJE_CREAR', entidad: 'pesaje', localUuid: 'l', clientOperationId: 'c', payload: {}, deviceId: 'd', now: new Date(0), uuid: () => 'u' });
  for (const campo of ['claveOrden', 'origen', 'posibleEnServidor', 'runtimeNoSoporta']) assert.equal(campo in op, false, campo);
});

test('instanteEnCadena: un reloj que retrocede no altera el orden', () => {
  const cadena = [{ createdAt: '2026-10-20T15:00:00.000Z' }];
  assert.equal(instanteEnCadena(cadena, new Date('2026-10-20T14:00:00.000Z')).toISOString(), '2026-10-20T15:00:00.001Z');
  assert.equal(instanteEnCadena(cadena, new Date('2026-10-20T15:00:00.000Z')).toISOString(), '2026-10-20T15:00:00.001Z');
  assert.equal(instanteEnCadena(cadena, new Date('2026-10-20T16:00:00.000Z')).toISOString(), '2026-10-20T16:00:00.000Z');
  assert.equal(instanteEnCadena([], new Date('2026-10-20T16:00:00.000Z')).toISOString(), '2026-10-20T16:00:00.000Z');
});

test('firmaIntencion: no depende del orden de los campos; sí de los valores', () => {
  assert.equal(firmaIntencion({ a: 1, b: 2 }), firmaIntencion({ b: 2, a: 1 }));
  assert.notEqual(firmaIntencion({ a: 1 }), firmaIntencion({ a: 2 }));
});

test('BLOQUEADA_POR_IDENTIDAD nunca es enviable', () => {
  const op = { estado: OUTBOX_ESTADOS.BLOQUEADA_POR_IDENTIDAD, siguienteIntentoAt: null };
  assert.equal(estaLista(op, new Date()), false);
  assert.equal(estaLista(op, new Date(), { forzar: true }), false);
});

test('identidadCoincide: exacta; sin origen completo no es de nadie', () => {
  const origen = { cuentaId: CUENTA_A, organizacionId: ORG };
  assert.equal(identidadCoincide({ origen }, CUENTA_A), true);
  assert.equal(identidadCoincide({ origen }, CUENTA_B), false);
  assert.equal(identidadCoincide({ origen }, null), false);
  assert.equal(identidadCoincide({}, CUENTA_B), false);
  assert.equal(identidadCoincide({ origen: { cuentaId: CUENTA_A } }, CUENTA_A), false);
});

test('permisos: operador puede encolar; lector no', () => {
  assert.equal(puedeEncolar('operador', REPRODUCCION_EVENTO_CREAR), true);
  assert.equal(puedeEncolar('lector', REPRODUCCION_EVENTO_CREAR), false);
});

test('FASE 4E.2B: ANULAR y CORREGIR solo los encolan owner y admin', () => {
  for (const tipo of ['REPRODUCCION_EVENTO_ANULAR', 'REPRODUCCION_EVENTO_CORREGIR']) {
    assert.equal(puedeEncolar('owner', tipo), true, tipo);
    assert.equal(puedeEncolar('admin', tipo), true, tipo);
    assert.equal(puedeEncolar('operador', tipo), false, tipo);
    assert.equal(puedeEncolar('lector', tipo), false, tipo);
    assert.equal(puedeEncolar(null, tipo), false, tipo);
  }
});

test('el panel encola registro y administración por caminos distintos', () => {
  const panel = fs.readFileSync(new URL('../../hato/HatoReproduccionPanel.jsx', import.meta.url), 'utf8');
  assert.match(panel, /registrarEventoReproductivoLocal/);
  assert.match(panel, /encolarOperacionAdministrativa/);
});

// ---------------------------------------------------------------------------
// Repositorio (mismo contrato en ambos adaptadores)
// ---------------------------------------------------------------------------

for (const [nombre, crearStorage] of Object.entries(ADAPTADORES)) {
  const caso = (titulo, fn) => test(`${titulo} [${nombre}]`, async () => {
    const storage = await crearStorage();
    try {
      await fn(storage);
    } finally {
      await storage.close();
    }
  });

  caso('registrar: operación con el esquema exacto', async (storage) => {
    const { repo } = await preparar(storage);
    const { operationId, yaEncolado } = await registrar(repo, crear(ID1, 'CELO_OBSERVADO', '2026-10-01', { intensidadCelo: 'ALTA' }));
    assert.equal(yaEncolado, false);
    const op = await storage.get('outbox', operationId);
    assert.equal(op.tipoOperacion, REPRODUCCION_EVENTO_CREAR);
    assert.equal(op.entidad, 'reproduccion_evento');
    assert.equal(op.claveOrden, 'repro:animal:7');
    assert.equal(op.clientOperationId, ID1);
    assert.deepEqual(op.payload, { animalId: '7', evento: { tipoEvento: 'CELO_OBSERVADO', fechaEvento: '2026-10-01', intensidadCelo: 'ALTA' } });
    assert.deepEqual(op.origen, { organizacionId: ORG, cuentaId: CUENTA_A });
    assert.equal(op.posibleEnServidor, false);
    assert.equal(op.estado, OUTBOX_ESTADOS.PENDIENTE);
    assert.deepEqual(await storage.getAll('reproduccion_eventos'), [], 'un pendiente nunca entra en la copia confirmada');
  });

  caso('registrar: acepta el cuerpo real de buildCrearBody en todos los tipos', async (storage) => {
    for (const tipo of ['CELO_OBSERVADO', 'SERVICIO_MONTA', 'INSEMINACION_ARTIFICIAL', 'IATF', 'TRANSFERENCIA_EMBRION', 'DIAGNOSTICO_PRENEZ', 'ABORTO', 'PARTO']) {
      const { repo } = await preparar(storage);
      const form = { ...formInicialEvento(tipo, '2026-10-01'), tipoServicio: 'LIBRE', embrionConservacion: 'FRESCO', diagnosticoResultado: 'VACIA', diagnosticoMetodo: 'OTRO', partoTipo: 'NORMAL' };
      const id = `d0000000-0000-4000-8000-${String(tipo.length).padStart(4, '0')}${tipo.charCodeAt(1).toString().padStart(8, '0')}`;
      const res = await registrar(repo, buildCrearBody(form, id), { confirmarAdvertencia: true });
      if (res.operationId) await repo.cancelarEventoReproductivoPendiente(res.operationId, { cuentaId: CUENTA_A });
      assert.ok(res.operationId, tipo);
    }
  });

  caso('registrar: mismo clientOperationId no crea otra operación (reintento)', async (storage) => {
    const { repo } = await preparar(storage);
    const body = crear(ID1, 'CELO_OBSERVADO', '2026-10-01');
    const primera = await registrar(repo, body);
    const segunda = await registrar(repo, body);
    assert.equal(segunda.yaEncolado, true);
    assert.equal(segunda.operationId, primera.operationId);
    assert.equal((await repo.cadenaReproductiva('7')).length, 1);
  });

  caso('registrar: mismo clientOperationId con otra intención se rechaza', async (storage) => {
    const { repo } = await preparar(storage);
    await registrar(repo, crear(ID1, 'CELO_OBSERVADO', '2026-10-01'));
    await assert.rejects(registrar(repo, crear(ID1, 'CELO_OBSERVADO', '2026-10-02')), { code: 'CLIENT_OPERATION_ID_REUSED' });
  });

  caso('registrar: exige animalId del servidor y copia local apta', async (storage) => {
    const macho = { ...HEMBRA, key: 'srv:8', animalId: '8', sexo: 'MACHO' };
    const anulada = { ...HEMBRA, key: 'srv:9', animalId: '9', estado: 'ANULADO' };
    const vendida = { ...HEMBRA, key: 'srv:10', animalId: '10', estadoOperativo: 'SALIDO' };
    const { repo } = await preparar(storage, { animales: [HEMBRA, macho, anulada, vendida] });
    const body = crear(ID1, 'CELO_OBSERVADO', '2026-10-01');
    await assert.rejects(registrar(repo, body, { animalId: 'local:abc' }), { code: 'REPRODUCCION_REQUIERE_ANIMAL_SINCRONIZADO' });
    await assert.rejects(registrar(repo, body, { animalId: '99' }), { code: 'ANIMAL_NO_EN_DISPOSITIVO' });
    for (const animalId of ['8', '9', '10']) await assert.rejects(registrar(repo, body, { animalId }), { code: 'ANIMAL_NO_ADMITE_REPRODUCCION' });
    assert.deepEqual(await storage.getAll('outbox'), []);
  });

  caso('registrar: sin historial descargado no se encola', async (storage) => {
    const { repo } = await preparar(storage, { lista: false });
    await assert.rejects(registrar(repo, crear(ID1, 'CELO_OBSERVADO', '2026-10-01')), { code: 'REPRODUCCION_SIN_COPIA_LOCAL' });
  });

  caso('registrar: nunca acepta organización del cliente y exige cuenta', async (storage) => {
    const { repo } = await preparar(storage);
    await assert.rejects(registrar(repo, { ...crear(ID1, 'CELO_OBSERVADO', '2026-10-01'), organizacionId: ORG }), { code: 'CAMPO_NO_PERMITIDO' });
    await assert.rejects(registrar(repo, crear(ID1, 'CELO_OBSERVADO', '2026-10-01'), { cuentaId: null }), { code: 'OPERACION_SIN_CUENTA' });
  });

  caso('registrar: conflicto con un pendiente local BLOQUEA y no encola', async (storage) => {
    const { repo } = await preparar(storage);
    await registrar(repo, crear(ID1, 'DIAGNOSTICO_PRENEZ', '2026-10-01', { diagnosticoResultado: 'PRENADA', diagnosticoMetodo: 'OTRO' }));
    await assert.rejects(registrar(repo, crear(ID2, 'CELO_OBSERVADO', '2026-10-02')), { code: 'EVENTO_NO_PERMITIDO_POR_ESTADO' });
    await assert.rejects(registrar(repo, crear(ID2, 'ABORTO', '2026-09-01')), { code: 'FECHA_ANTERIOR_A_HISTORIAL' });
    assert.equal((await repo.cadenaReproductiva('7')).length, 1);
  });

  caso('registrar: conflicto con la copia confirmada ADVIERTE; con confirmación se encola sin confirmarse', async (storage) => {
    const prenez = { eventoId: '1', animalId: '7', tipoEvento: 'DIAGNOSTICO_PRENEZ', fechaEvento: '2026-09-01', diagnosticoResultado: 'PRENADA', estadoRegistro: 'ACTIVO' };
    const { repo } = await preparar(storage, { confirmados: [prenez] });
    const body = crear(ID1, 'CELO_OBSERVADO', '2026-10-01');

    const aviso = await registrar(repo, body);
    assert.equal(aviso.requiereConfirmacion, true);
    assert.equal(aviso.advertencia.code, 'EVENTO_NO_PERMITIDO_POR_ESTADO');
    assert.deepEqual(await storage.getAll('outbox'), []);

    const res = await registrar(repo, body, { confirmarAdvertencia: true });
    assert.equal(res.advertencia.code, 'EVENTO_NO_PERMITIDO_POR_ESTADO');
    assert.equal(res.pendiente.estado, OUTBOX_ESTADOS.PENDIENTE);
    assert.equal('eventoId' in res.pendiente, false);
    assert.equal((await storage.getAll('reproduccion_eventos')).length, 1);
  });

  caso('registrar: un pendiente en conflicto no se usa como causa de bloqueo', async (storage) => {
    const { repo } = await preparar(storage);
    const { operationId } = await registrar(repo, crear(ID1, 'DIAGNOSTICO_PRENEZ', '2026-10-01', { diagnosticoResultado: 'PRENADA', diagnosticoMetodo: 'OTRO' }));
    await storage.put('outbox', { ...(await storage.get('outbox', operationId)), estado: OUTBOX_ESTADOS.CONFLICTO });
    assert.ok((await registrar(repo, crear(ID2, 'CELO_OBSERVADO', '2026-10-02'))).operationId);
  });

  caso('FIFO: el orden de la cadena resiste un reloj que retrocede', async (storage) => {
    const { repo, reloj: r } = await preparar(storage);
    await registrar(repo, crear(ID1, 'CELO_OBSERVADO', '2026-10-01'));
    r.avanzar(-3_600_000);
    await registrar(repo, crear(ID2, 'CELO_OBSERVADO', '2026-10-02'));
    assert.deepEqual((await repo.listEventosReproductivosPendientes('7')).map((e) => e.clientOperationId), [ID1, ID2]);
  });

  caso('cadenas independientes por animal', async (storage) => {
    const otra = { ...HEMBRA, key: 'srv:8', animalId: '8' };
    const { repo } = await preparar(storage, { animales: [HEMBRA, otra] });
    await registrar(repo, crear(ID1, 'DIAGNOSTICO_PRENEZ', '2026-10-01', { diagnosticoResultado: 'PRENADA', diagnosticoMetodo: 'OTRO' }));
    assert.ok((await registrar(repo, crear(ID2, 'CELO_OBSERVADO', '2026-10-02'), { animalId: '8' })).operationId);
    assert.equal((await repo.cadenaReproductiva('7')).length, 1);
    assert.equal((await repo.cadenaReproductiva('8')).length, 1);
  });

  caso('editar: id nuevo, misma operación y misma posición; sin duplicar', async (storage) => {
    const { repo, reloj: r } = await preparar(storage);
    const { operationId } = await registrar(repo, crear(ID1, 'CELO_OBSERVADO', '2026-10-01'));
    await registrar(repo, crear(ID2, 'CELO_OBSERVADO', '2026-10-05'));
    const antes = await storage.get('outbox', operationId);
    r.avanzar(1000);

    const res = await repo.editarEventoReproductivoPendiente({ operationId, body: crear('ignorado', 'CELO_OBSERVADO', '2026-10-02'), cuentaId: CUENTA_A });
    assert.equal(res.sinCambios, false);
    const despues = await storage.get('outbox', operationId);
    assert.notEqual(despues.clientOperationId, ID1);
    assert.notEqual(despues.clientOperationId, 'ignorado');
    assert.equal(despues.createdAt, antes.createdAt);
    assert.equal(despues.payload.evento.fechaEvento, '2026-10-02');
    assert.equal('clientOperationId' in despues.payload.evento, false);
    assert.deepEqual((await repo.cadenaReproductiva('7')).map((op) => op.operationId)[0], operationId);
    assert.equal((await repo.cadenaReproductiva('7')).length, 2);
  });

  caso('editar: la misma intención normalizada conserva el id', async (storage) => {
    const { repo } = await preparar(storage);
    const { operationId } = await registrar(repo, crear(ID1, 'CELO_OBSERVADO', '2026-10-01', { intensidadCelo: 'ALTA' }));
    const res = await repo.editarEventoReproductivoPendiente({ operationId, body: { intensidadCelo: 'ALTA', fechaEvento: '2026-10-01', tipoEvento: 'CELO_OBSERVADO' }, cuentaId: CUENTA_A });
    assert.equal(res.sinCambios, true);
    assert.equal((await storage.get('outbox', operationId)).clientOperationId, ID1);
  });

  caso('editar: resolver un conflicto reencola la operación', async (storage) => {
    const { repo } = await preparar(storage);
    const { operationId } = await registrar(repo, crear(ID1, 'CELO_OBSERVADO', '2026-10-01'));
    await storage.put('outbox', { ...(await storage.get('outbox', operationId)), estado: OUTBOX_ESTADOS.CONFLICTO, ultimoError: { codigo: 'X' }, intentos: 2 });
    await repo.editarEventoReproductivoPendiente({ operationId, body: { tipoEvento: 'CELO_OBSERVADO', fechaEvento: '2026-10-02' }, cuentaId: CUENTA_A });
    const op = await storage.get('outbox', operationId);
    assert.equal(op.estado, OUTBOX_ESTADOS.PENDIENTE);
    assert.equal(op.ultimoError, null);
    assert.equal(op.intentos, 0);
  });

  caso('editar: no puede dejar inválido un pendiente posterior', async (storage) => {
    const { repo } = await preparar(storage);
    const { operationId } = await registrar(repo, crear(ID1, 'CELO_OBSERVADO', '2026-10-01'));
    await registrar(repo, crear(ID2, 'IATF', '2026-10-05'));
    await assert.rejects(
      repo.editarEventoReproductivoPendiente({ operationId, body: { tipoEvento: 'DIAGNOSTICO_PRENEZ', fechaEvento: '2026-10-01', diagnosticoResultado: 'PRENADA', diagnosticoMetodo: 'OTRO' }, cuentaId: CUENTA_A }),
      { code: 'EVENTO_NO_PERMITIDO_POR_ESTADO' },
    );
    assert.equal((await storage.get('outbox', operationId)).clientOperationId, ID1);
  });

  caso('editar: con envío incierto NO cambia la intención ni el id', async (storage) => {
    const { repo } = await preparar(storage);
    const { operationId } = await registrar(repo, crear(ID1, 'CELO_OBSERVADO', '2026-10-01'));
    const incierta = { ...(await storage.get('outbox', operationId)), estado: OUTBOX_ESTADOS.ERROR_REINTENTABLE, posibleEnServidor: true };
    await storage.put('outbox', incierta);
    await assert.rejects(repo.editarEventoReproductivoPendiente({ operationId, body: { tipoEvento: 'CELO_OBSERVADO', fechaEvento: '2026-10-02' }, cuentaId: CUENTA_A }), { code: 'EVENTO_ENVIO_INCIERTO' });
    assert.deepEqual(await storage.get('outbox', operationId), incierta);
  });

  caso('editar: una operación enviándose no se toca', async (storage) => {
    const { repo } = await preparar(storage);
    const { operationId } = await registrar(repo, crear(ID1, 'CELO_OBSERVADO', '2026-10-01'));
    await storage.put('outbox', { ...(await storage.get('outbox', operationId)), estado: OUTBOX_ESTADOS.SINCRONIZANDO });
    await assert.rejects(repo.editarEventoReproductivoPendiente({ operationId, body: { tipoEvento: 'CELO_OBSERVADO', fechaEvento: '2026-10-02' }, cuentaId: CUENTA_A }), { code: 'EVENTO_PENDIENTE_EN_CURSO' });
  });

  caso('editar: la carrera con el motor no pisa el reclamo', async (storage) => {
    const { repo, reloj: r } = await preparar(storage);
    const { operationId } = await registrar(repo, crear(ID1, 'CELO_OBSERVADO', '2026-10-01'));
    r.avanzar(1000);
    // El motor reclama la operación justo después de la lectura de la edición.
    const original = storage.getAllByIndex.bind(storage);
    let reclamada = false;
    storage.getAllByIndex = async (...args) => {
      const filas = await original(...args);
      if (!reclamada && args[0] === 'outbox') {
        reclamada = true;
        await storage.put('outbox', { ...(await storage.get('outbox', operationId)), estado: OUTBOX_ESTADOS.SINCRONIZANDO, posibleEnServidor: true, updatedAt: r.now().toISOString() });
      }
      return filas;
    };
    await assert.rejects(repo.editarEventoReproductivoPendiente({ operationId, body: { tipoEvento: 'CELO_OBSERVADO', fechaEvento: '2026-10-02' }, cuentaId: CUENTA_A }), { code: 'EVENTO_PENDIENTE_CAMBIO' });
    const op = await storage.get('outbox', operationId);
    assert.equal(op.clientOperationId, ID1);
    assert.equal(op.estado, OUTBOX_ESTADOS.SINCRONIZANDO);
  });

  caso('identidad: otra cuenta no puede editar; nunca se reasigna la autoría', async (storage) => {
    const { repo } = await preparar(storage);
    const { operationId } = await registrar(repo, crear(ID1, 'CELO_OBSERVADO', '2026-10-01'));
    await assert.rejects(repo.editarEventoReproductivoPendiente({ operationId, body: { tipoEvento: 'CELO_OBSERVADO', fechaEvento: '2026-10-02' }, cuentaId: CUENTA_B }), { code: 'BLOQUEADA_POR_IDENTIDAD' });
    assert.equal((await storage.get('outbox', operationId)).origen.cuentaId, CUENTA_A);
  });

  caso('identidad: la bloqueada cuenta como pendiente y puede descartarse explícitamente', async (storage) => {
    const { repo } = await preparar(storage);
    const { operationId } = await registrar(repo, crear(ID1, 'CELO_OBSERVADO', '2026-10-01'));
    await storage.put('outbox', { ...(await storage.get('outbox', operationId)), estado: OUTBOX_ESTADOS.BLOQUEADA_POR_IDENTIDAD });
    const stats = await repo.contar();
    assert.equal(stats.pendientes, 1);
    assert.equal(stats.bloqueadasIdentidad, 1);
    await repo.cancelarEventoReproductivoPendiente(operationId, { cuentaId: CUENTA_A });
    assert.equal(await storage.get('outbox', operationId), undefined);
  });

  caso('cancelar: elimina solo la operación local no enviada', async (storage) => {
    const { repo } = await preparar(storage);
    const { operationId } = await registrar(repo, crear(ID1, 'CELO_OBSERVADO', '2026-10-01'));
    let avisos = 0;
    repo.subscribe(() => { avisos += 1; });
    await repo.cancelarEventoReproductivoPendiente(operationId, { cuentaId: CUENTA_A });
    assert.deepEqual(await storage.getAll('outbox'), []);
    assert.equal(avisos, 1);
    await assert.rejects(repo.cancelarEventoReproductivoPendiente(operationId, { cuentaId: CUENTA_A }), { code: 'EVENTO_PENDIENTE_NO_ENCONTRADO' });
  });

  caso('cancelar: con envío incierto se conserva para reconciliar', async (storage) => {
    const { repo } = await preparar(storage);
    const { operationId } = await registrar(repo, crear(ID1, 'CELO_OBSERVADO', '2026-10-01'));
    await storage.put('outbox', { ...(await storage.get('outbox', operationId)), estado: OUTBOX_ESTADOS.ERROR_REINTENTABLE, posibleEnServidor: true });
    await assert.rejects(repo.cancelarEventoReproductivoPendiente(operationId, { cuentaId: CUENTA_A }), { code: 'EVENTO_ENVIO_INCIERTO' });
    await assert.rejects(repo.cancelarEventoReproductivoPendiente(operationId, { cuentaId: CUENTA_A, confirmarIncierto: true }), { code: 'EVENTO_ENVIO_INCIERTO' });
    assert.ok(await storage.get('outbox', operationId));
  });

  caso('cancelar: un rechazo con posible envío exige confirmación explícita', async (storage) => {
    const { repo } = await preparar(storage);
    const { operationId } = await registrar(repo, crear(ID1, 'CELO_OBSERVADO', '2026-10-01'));
    await storage.put('outbox', { ...(await storage.get('outbox', operationId)), estado: OUTBOX_ESTADOS.RECHAZADO, posibleEnServidor: true });
    await assert.rejects(repo.cancelarEventoReproductivoPendiente(operationId, { cuentaId: CUENTA_A }), { code: 'EVENTO_ENVIO_INCIERTO' });
    await repo.cancelarEventoReproductivoPendiente(operationId, { cuentaId: CUENTA_A, confirmarIncierto: true });
    assert.equal(await storage.get('outbox', operationId), undefined);
  });

  caso('cancelar: no toca operaciones de otro tipo', async (storage) => {
    const { repo } = await preparar(storage);
    await storage.put('outbox', { operationId: 'p', tipoOperacion: 'PESAJE_CREAR', estado: 'PENDIENTE' });
    await assert.rejects(repo.cancelarEventoReproductivoPendiente('p'), { code: 'EVENTO_PENDIENTE_NO_ENCONTRADO' });
    assert.ok(await storage.get('outbox', 'p'));
  });

  caso('copia confirmada: orden de plegado por animal', async (storage) => {
    const evento = (eventoId, fechaEvento) => ({ eventoId, animalId: '7', tipoEvento: 'CELO_OBSERVADO', fechaEvento, estadoRegistro: 'ACTIVO' });
    const { repo } = await preparar(storage, { confirmados: [evento('3', '2026-01-02'), evento('10', '2026-01-02'), evento('5', '2026-01-01'), { ...evento('6', '2026-01-01'), animalId: '8' }] });
    assert.deepEqual((await repo.listEventosReproductivos('7')).map((e) => e.eventoId), ['5', '3', '10']);
  });
}

test('un reinicio conserva la operación y su identidad (reapertura de IndexedDB)', async () => {
  const idb = new IDBFactory();
  const abrir = async () => createIndexedDbStorage(await openIndexedDb(idb, orgDbName(ORG), ORG_DB_VERSION, ORG_STORES));
  const storage = await abrir();
  const { repo } = await preparar(storage);
  const { operationId } = await registrar(repo, crear(ID1, 'CELO_OBSERVADO', '2026-10-01'));
  await storage.close();

  const reabierta = await abrir();
  const op = await reabierta.get('outbox', operationId);
  assert.equal(op.clientOperationId, ID1);
  assert.equal(op.claveOrden, 'repro:animal:7');
  assert.equal(op.origen.cuentaId, CUENTA_A);
  await reabierta.close();
});

test('la vista de un pendiente no presenta nada como confirmado', () => {
  const vista = eventoPendienteDe({
    operationId: 'o', clientOperationId: 'c', estado: 'PENDIENTE', createdAt: 'x',
    payload: { animalId: '7', evento: { tipoEvento: 'PARTO', fechaEvento: '2026-10-01' } },
  });
  for (const campo of ['eventoId', 'estadoRegistro', 'registradoEn']) assert.equal(campo in vista, false, campo);
  assert.equal(vista.posibleEnServidor, false);
});
