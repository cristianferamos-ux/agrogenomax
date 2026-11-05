// FASE 4E.2B -- ANULAR y CORREGIR en el outbox. Motor y repositorio reales, con un
// servidor que reproduce el contrato de POST .../anular y .../corregir (4E.2A):
// identidad antes de escribir, idempotencia por clientOperationId y corrección en una
// transacción. El contrato real contra PostgreSQL se prueba en el bloque de integración.
import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { ORG_DB_VERSION, ORG_STORES, orgDbName } from '../offlineSchema.js';
import { createIndexedDbStorage, createMemoryStorage, openIndexedDb } from '../storage.js';
import { createLocalRepo } from '../localRepo.js';
import { RUN_RESULT, calcularOnline, classifyResult, createSyncEngine } from '../syncEngine.js';
import {
  ADVERTENCIA_CORRECCION_DIFERIDA,
  OUTBOX_ESTADOS as E,
  REPRODUCCION_EVENTO_ANULAR as ANULAR,
  REPRODUCCION_EVENTO_CORREGIR as CORREGIR,
  REPRODUCCION_EVENTO_CREAR as CREAR,
  claveOrdenAnimal,
  newOperation,
  operacionesEnTurno,
} from '../outbox.js';
import { handlerDe } from '../operationHandlers.js';
import { startAutoSync } from '../autoSync.js';
import { CONCILIACION, conciliarAnular, conciliarCorregir } from '../reproduccionConciliacionAdmin.js';
import {
  accionesEventoPendiente,
  estadoEventoPendiente,
  identidadEsperadaDe,
  operacionAdministrativaDe,
  persistenciaTrasFallo,
} from '../../hato/reproduccionOfflineModel.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const CUENTA_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const CUENTA_B = 'bbbbbbbb-0000-4000-8000-000000000002';
const ID = (n) => `d0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CELO = Object.freeze({ tipoEvento: 'CELO_OBSERVADO', fechaEvento: '2026-10-01', intensidadCelo: 'ALTA' });
const CORREGIDO = Object.freeze({ tipoEvento: 'CELO_OBSERVADO', fechaEvento: '2026-10-02', intensidadCelo: 'BAJA', observaciones: 'revisado' });

const publico = ({ clientOperationId: _c, anulacionClientOperationId: _a, ...evento }) => evento;
const animalDe = (pathname) => pathname.match(/\/animales\/(\d+)\//)?.[1];

function aEvento(body, datos) {
  const { tipoEvento, fechaEvento, horaEvento = null, observaciones = null, ...detalle } = body;
  return { tipoEvento, fechaEvento, horaEvento, observaciones, detalle, estadoRegistro: 'ACTIVO', corrigeEventoId: null, corregidoPorEventoId: null, anulacion: null, anulacionClientOperationId: null, ...datos };
}

function servidor() {
  let seq = 100;
  const srv = {
    eventos: [],
    posts: [],
    sesion: { authenticated: true, cuenta: { cuentaId: CUENTA_A }, organizacionActiva: { organizacionId: ORG } },
    falla: null,
    alEnviar: null,
    sembrar(eventoId, animalId, body = CELO) {
      const evento = aEvento(body, { eventoId, animalId, clientOperationId: ID(9000 + Number(eventoId)) });
      srv.eventos.push(evento);
      return evento;
    },
    anularPorFuera(eventoId, id = ID(9999), motivo = 'otra persona') {
      const evento = srv.eventos.find((e) => e.eventoId === eventoId);
      Object.assign(evento, { estadoRegistro: 'ANULADO', anulacion: { anuladoEn: 'x', motivo }, anulacionClientOperationId: id });
    },
    responder(pathname, { clientOperationId, identidadEsperada, ...cuerpo }) {
      if (identidadEsperada && (identidadEsperada.cuentaId !== srv.sesion.cuenta?.cuentaId || identidadEsperada.organizacionId !== srv.sesion.organizacionActiva?.organizacionId)) {
        return { ok: false, status: 409, data: { error: 'IDENTIDAD_NO_COINCIDE' } };
      }
      const animalId = animalDe(pathname);
      const administrada = pathname.match(/\/eventos\/(\d+)\/(anular|corregir)$/);
      const porAnulacion = srv.eventos.find((e) => e.anulacionClientOperationId === clientOperationId);
      const porCreacion = srv.eventos.find((e) => e.clientOperationId === clientOperationId);
      if (!administrada) {
        if (porCreacion) return { ok: true, status: 200, data: { ok: true, yaExistia: true, evento: publico(porCreacion) } };
        const nuevo = aEvento(cuerpo, { eventoId: String(++seq), animalId, clientOperationId });
        srv.eventos.push(nuevo);
        return { ok: true, status: 201, data: { ok: true, yaExistia: false, evento: publico(nuevo) } };
      }
      const [, eventoId, accion] = administrada;
      if (accion === 'anular') {
        if (porAnulacion) {
          const mismo = !porAnulacion.corregidoPorEventoId && porAnulacion.eventoId === eventoId && porAnulacion.animalId === animalId && porAnulacion.anulacion.motivo === cuerpo.motivo;
          if (!mismo) return { ok: false, status: 409, data: { error: 'CLIENT_OPERATION_ID_REUSED' } };
          return { ok: true, status: 200, data: { ok: true, yaExistia: true, evento: publico(porAnulacion) } };
        }
        if (porCreacion) return { ok: false, status: 409, data: { error: 'CLIENT_OPERATION_ID_REUSED' } };
      } else {
        if (porCreacion) {
          const original = srv.eventos.find((e) => e.eventoId === eventoId);
          const mismo = porCreacion.animalId === animalId && porCreacion.corrigeEventoId === eventoId && JSON.stringify(porCreacion.intencion) === JSON.stringify(cuerpo);
          if (!mismo) return { ok: false, status: 409, data: { error: 'CLIENT_OPERATION_ID_REUSED' } };
          return { ok: true, status: 200, data: { ok: true, yaExistia: true, evento: publico(porCreacion), eventoCorregido: publico(original) } };
        }
        if (porAnulacion) return { ok: false, status: 409, data: { error: 'CLIENT_OPERATION_ID_REUSED' } };
        if (cuerpo.evento?.tipoEvento === 'INVALIDO') return { ok: false, status: 400, data: { error: 'INVALID_TIPO_EVENTO' } };
      }
      const objetivo = srv.eventos.find((e) => e.eventoId === eventoId && e.animalId === animalId);
      if (!objetivo) return { ok: false, status: 404, data: { error: 'EVENTO_NOT_FOUND' } };
      if (objetivo.estadoRegistro !== 'ACTIVO') return { ok: false, status: 409, data: { error: 'EVENTO_YA_ANULADO' } };
      Object.assign(objetivo, { estadoRegistro: 'ANULADO', anulacion: { anuladoEn: 'x', motivo: cuerpo.motivo }, anulacionClientOperationId: clientOperationId });
      if (accion === 'anular') return { ok: true, status: 200, data: { ok: true, yaExistia: false, evento: publico(objetivo) } };
      const corrector = aEvento(cuerpo.evento, { eventoId: String(++seq), animalId, clientOperationId, corrigeEventoId: eventoId, intencion: cuerpo });
      objetivo.corregidoPorEventoId = corrector.eventoId;
      srv.eventos.push(corrector);
      return { ok: true, status: 201, data: { ok: true, yaExistia: false, evento: publico(corrector), eventoCorregido: publico(objetivo) } };
    },
    pagina(cambios = {}) {
      return {
        organizacionId: ORG,
        cuentaId: srv.sesion.cuenta?.cuentaId ?? null,
        eventos: srv.eventos.map(({ intencion: _i, ...evento }) => evento),
        cursor: 'c1',
        hayMas: false,
        totales: { eventos: 0, anulados: 0 },
        ...cambios,
      };
    },
  };
  return srv;
}

function transporte(srv) {
  return {
    async postJson(pathname, body) {
      srv.posts.push({ pathname, body: structuredClone(body) });
      await srv.alEnviar?.(pathname, body);
      const falla = srv.falla?.(pathname, body);
      if (falla === 'red') throw new TypeError('Failed to fetch');
      if (falla === 'red-tras-guardar') {
        srv.responder(pathname, body);
        throw new TypeError('Failed to fetch');
      }
      if (falla) return { ok: false, ...falla };
      return srv.responder(pathname, body);
    },
    async getJson(pathname) {
      if (pathname.endsWith('/auth/session')) return { ok: true, status: 200, data: srv.sesion };
      if (pathname.includes('/sync/reproduccion')) return { ok: true, status: 200, data: srv.pagina() };
      return { ok: true, status: 200, data: { organizacionId: ORG, cursor: 'p', animales: [], chapetas: [], predios: [], potreros: [], razas: [], categorias: [] } };
    },
  };
}

function reloj() {
  let t = new Date('2026-10-20T15:00:00.000Z').getTime();
  return { now: () => new Date(t), avanzar: (ms) => { t += ms; } };
}

async function montar({ storage = createMemoryStorage(ORG_STORES), lock = null } = {}) {
  const srv = servidor();
  const r = reloj();
  let n = 0;
  const repo = createLocalRepo(storage, { organizacionId: ORG, deviceId: 'd', now: r.now, uuid: () => ID(++n) });
  await storage.put('animales', { key: 'srv:7', animalId: '7', sexo: 'HEMBRA', estado: 'ACTIVO', estadoOperativo: 'EN_HATO' });
  await storage.put('animales', { key: 'srv:8', animalId: '8', sexo: 'HEMBRA', estado: 'ACTIVO', estadoOperativo: 'EN_HATO' });
  await repo.putMeta({ reproduccionListaAt: '2026-10-20T14:00:00.000Z' });
  for (const [eventoId, animalId] of [['1', '7'], ['2', '7'], ['3', '8']]) {
    const evento = srv.sembrar(eventoId, animalId);
    await storage.put('reproduccion_eventos', { ...evento, ...evento.detalle });
  }
  const red = { online: true };
  const engine = createSyncEngine({ repo, transport: transporte(srv), isOnline: () => red.online, now: r.now, random: () => 0.5, lock });
  return { srv, repo, storage, engine, red, reloj: r };
}

const datosAnular = (cambios = {}) => ({
  tipoOperacion: ANULAR, animalId: '7', eventoId: '1', motivo: 'Registrado por error', clientOperationId: ID(501), cuentaId: CUENTA_A, rol: 'admin', ...cambios,
});
const datosCorregir = (cambios = {}) => ({
  tipoOperacion: CORREGIR, animalId: '7', eventoId: '1', motivo: 'Fecha errónea', evento: { ...CORREGIDO }, clientOperationId: ID(601), cuentaId: CUENTA_A, rol: 'owner', confirmarAdvertencia: true, ...cambios,
});
const crearCuerpo = (id, fechaEvento = '2026-10-15') => ({ tipoEvento: 'CELO_OBSERVADO', fechaEvento, clientOperationId: id });
const unica = async (repo) => {
  const ops = await repo.listOutbox();
  assert.equal(ops.length, 1);
  return ops[0];
};
const sufijos = (srv) => srv.posts.map((p) => p.pathname.replace('/api/ganaderia/animales/', ''));

// ---------------------------------------------------------------------------
// Modelo de la operación
// ---------------------------------------------------------------------------

test('ANULAR: modelo exacto del outbox', async () => {
  const { repo } = await montar();
  await repo.encolarOperacionAdministrativa(datosAnular({ motivo: '  Registrado\r\npor error  ' }));
  const op = await unica(repo);
  assert.equal(op.tipoOperacion, ANULAR);
  assert.deepEqual(op.payload, { animalId: '7', eventoId: '1', motivo: 'Registrado\npor error' }, 'motivo con la normalización del servidor');
  assert.equal(op.clientOperationId, ID(501));
  assert.equal(op.claveOrden, 'repro:animal:7');
  assert.deepEqual(op.origen, { organizacionId: ORG, cuentaId: CUENTA_A });
  assert.equal(op.posibleEnServidor, false);
  assert.equal(op.estado, E.PENDIENTE);
});

test('CORREGIR: modelo exacto del outbox', async () => {
  const { repo } = await montar();
  await repo.encolarOperacionAdministrativa(datosCorregir());
  const op = await unica(repo);
  assert.equal(op.tipoOperacion, CORREGIR);
  assert.deepEqual(op.payload, { animalId: '7', eventoId: '1', motivo: 'Fecha errónea', evento: { ...CORREGIDO } });
  assert.equal(op.claveOrden, claveOrdenAnimal('7'));
  assert.deepEqual(op.origen, { organizacionId: ORG, cuentaId: CUENTA_A });
  assert.equal(op.posibleEnServidor, false);
});

test('request: solo con animal y evento reales, e identidadEsperada exacta', () => {
  const origen = { organizacionId: ORG, cuentaId: CUENTA_A };
  const anular = (payload) => handlerDe(ANULAR).request({ payload, clientOperationId: ID(1), origen });
  assert.deepEqual(anular({ animalId: '7', eventoId: '1', motivo: 'm' }), {
    path: '/api/ganaderia/animales/7/reproduccion/eventos/1/anular',
    body: { motivo: 'm', clientOperationId: ID(1), identidadEsperada: origen },
  });
  assert.equal(anular({ animalId: 'local:1', eventoId: '1', motivo: 'm' }), null);
  assert.equal(anular({ animalId: '7', eventoId: 'pendiente', motivo: 'm' }), null);
  assert.equal(anular({ animalId: '7', motivo: 'm' }), null);
  const corregir = (payload) => handlerDe(CORREGIR).request({ payload, clientOperationId: ID(2), origen });
  assert.deepEqual(corregir({ animalId: '7', eventoId: '1', motivo: 'm', evento: { ...CELO } }), {
    path: '/api/ganaderia/animales/7/reproduccion/eventos/1/corregir',
    body: { motivo: 'm', clientOperationId: ID(2), evento: { ...CELO }, identidadEsperada: origen },
  });
  assert.equal(corregir({ animalId: '7', eventoId: '0', motivo: 'm', evento: {} }), null);
});

test('el repositorio exige evento real y motivo', async () => {
  const { repo } = await montar();
  await assert.rejects(repo.encolarOperacionAdministrativa(datosAnular({ eventoId: 'loc:1' })), { code: 'REPRODUCCION_REQUIERE_EVENTO_CONFIRMADO' });
  await assert.rejects(repo.encolarOperacionAdministrativa(datosAnular({ animalId: 'local:1' })), { code: 'REPRODUCCION_REQUIERE_EVENTO_CONFIRMADO' });
  await assert.rejects(repo.encolarOperacionAdministrativa(datosAnular({ motivo: '   ' })), { code: 'INVALID_MOTIVO' });
  assert.deepEqual(await repo.listOutbox(), []);
});

test('un evento ya anulado en la copia local no se encola, salvo tras un envío incierto', async () => {
  const { repo, storage } = await montar();
  await storage.put('reproduccion_eventos', { eventoId: '1', animalId: '7', estadoRegistro: 'ANULADO' });
  await assert.rejects(repo.encolarOperacionAdministrativa(datosAnular()), { code: 'EVENTO_YA_ANULADO' });
  await repo.encolarOperacionAdministrativa(datosAnular({ posibleEnServidor: true, fallo: { codigo: 'NETWORK_ERROR', status: 0, tipo: 'red' } }));
  assert.equal((await unica(repo)).posibleEnServidor, true);
});

// ---------------------------------------------------------------------------
// RBAC e identidad al encolar
// ---------------------------------------------------------------------------

for (const tipo of [ANULAR, CORREGIR]) {
  const datos = tipo === ANULAR ? datosAnular : datosCorregir;
  for (const rol of ['operador', 'lector', null, undefined]) {
    test(`${tipo}: el rol ${rol} no encola`, async () => {
      const { repo } = await montar();
      await assert.rejects(repo.encolarOperacionAdministrativa(datos({ rol })), { code: 'ROLE_FORBIDDEN' });
      assert.deepEqual(await repo.listOutbox(), []);
    });
  }
  for (const rol of ['owner', 'admin']) {
    test(`${tipo}: el rol ${rol} encola`, async () => {
      const { repo } = await montar();
      await repo.encolarOperacionAdministrativa(datos({ rol }));
      assert.equal((await unica(repo)).tipoOperacion, tipo);
    });
  }
}

test('identidadEsperada sale de la sesión, y sin ella no se afirma nada', () => {
  assert.deepEqual(identidadEsperadaDe({ cuenta: { cuentaId: CUENTA_A }, organizacionActiva: { organizacionId: ORG } }), { cuentaId: CUENTA_A, organizacionId: ORG });
  assert.equal(identidadEsperadaDe({ cuenta: { cuentaId: CUENTA_A }, organizacionActiva: null }), null);
  assert.equal(identidadEsperadaDe(null), null);
});

// ---------------------------------------------------------------------------
// Idempotencia y una sola operación por evento
// ---------------------------------------------------------------------------

test('misma operación al reabrir: no se duplica', async () => {
  const { repo } = await montar();
  const a = await repo.encolarOperacionAdministrativa(datosAnular());
  const b = await repo.encolarOperacionAdministrativa(datosAnular());
  assert.equal(b.yaEncolado, true);
  assert.equal(b.operationId, a.operationId);
  await unica(repo);
});

test('clientOperationId no se reutiliza entre operaciones distintas', async () => {
  const { repo } = await montar();
  await repo.encolarOperacionAdministrativa(datosAnular());
  await assert.rejects(repo.encolarOperacionAdministrativa(datosAnular({ motivo: 'otro' })), { code: 'CLIENT_OPERATION_ID_REUSED' });
  await assert.rejects(repo.encolarOperacionAdministrativa(datosAnular({ eventoId: '2' })), { code: 'CLIENT_OPERATION_ID_REUSED' });
  await assert.rejects(repo.encolarOperacionAdministrativa(datosCorregir({ clientOperationId: ID(501), eventoId: '2' })), { code: 'CLIENT_OPERATION_ID_REUSED' });
  await assert.rejects(repo.registrarEventoReproductivoLocal({ animalId: '7', body: crearCuerpo(ID(501)), cuentaId: CUENTA_A }), { code: 'CLIENT_OPERATION_ID_REUSED' });
  await unica(repo);
});

test('segunda operación administrativa sobre el mismo evento: bloqueada, en cualquier combinación', async () => {
  for (const [primera, segunda] of [
    [datosAnular(), datosAnular({ clientOperationId: ID(502) })],
    [datosAnular(), datosCorregir()],
    [datosCorregir(), datosAnular()],
    [datosCorregir(), datosCorregir({ clientOperationId: ID(602) })],
  ]) {
    const { repo } = await montar();
    await repo.encolarOperacionAdministrativa(primera);
    await assert.rejects(repo.encolarOperacionAdministrativa(segunda), { code: 'OPERACION_ADMINISTRATIVA_PENDIENTE' });
    await unica(repo);
  }
});

test('la operación en conflicto o rechazada sigue bloqueando el evento', async () => {
  for (const estado of [E.CONFLICTO, E.RECHAZADO, E.BLOQUEADA_POR_IDENTIDAD]) {
    const { repo } = await montar();
    const { operationId } = await repo.encolarOperacionAdministrativa(datosAnular());
    await repo.putOperacion({ ...await repo.getOperacion(operationId), estado });
    await assert.rejects(repo.encolarOperacionAdministrativa(datosCorregir()), { code: 'OPERACION_ADMINISTRATIVA_PENDIENTE' });
  }
});

test('otro evento del mismo animal sí admite su propia operación', async () => {
  const { repo } = await montar();
  await repo.encolarOperacionAdministrativa(datosAnular());
  await repo.encolarOperacionAdministrativa(datosCorregir({ eventoId: '2' }));
  assert.equal((await repo.listOutbox()).length, 2);
});

test('dos pestañas a la vez sobre IndexedDB: una sola operación por evento (atómico)', async () => {
  const db = await openIndexedDb(new IDBFactory(), orgDbName(ORG), ORG_DB_VERSION, ORG_STORES);
  const { repo } = await montar({ storage: createIndexedDbStorage(db) });
  const resultados = await Promise.allSettled([
    repo.encolarOperacionAdministrativa(datosAnular()),
    repo.encolarOperacionAdministrativa(datosCorregir()),
  ]);
  assert.equal(resultados.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(resultados.find((r) => r.status === 'rejected').reason.code, 'OPERACION_ADMINISTRATIVA_PENDIENTE');
  await unica(repo);
  db.close();
});

test('la vista de la UI localiza la operación del evento', async () => {
  const { repo } = await montar();
  await repo.encolarOperacionAdministrativa(datosAnular());
  const pendientes = await repo.listEventosReproductivosPendientes('7');
  assert.equal(operacionAdministrativaDe(pendientes, '1').motivo, 'Registrado por error');
  assert.equal(operacionAdministrativaDe(pendientes, '2'), null);
});

// ---------------------------------------------------------------------------
// ANULAR: envío
// ---------------------------------------------------------------------------

test('ANULAR offline: se conserva sin enviar y sale al reconectar', async () => {
  const { srv, repo, engine, red, storage } = await montar();
  red.online = false;
  await repo.encolarOperacionAdministrativa(datosAnular());
  assert.equal(await engine.syncNow(), RUN_RESULT.OFFLINE);
  assert.equal(srv.posts.length, 0);
  assert.equal((await unica(repo)).estado, E.PENDIENTE);

  red.online = true;
  assert.equal(await engine.syncNow(), RUN_RESULT.OK);
  assert.deepEqual(srv.posts.map((p) => p.body), [{ motivo: 'Registrado por error', clientOperationId: ID(501), identidadEsperada: { organizacionId: ORG, cuentaId: CUENTA_A } }]);
  assert.deepEqual(await repo.listOutbox(), []);
  const local = await storage.get('reproduccion_eventos', '1');
  assert.equal(local.estadoRegistro, 'ANULADO');
  assert.equal(local.anulacionClientOperationId, ID(501));
  assert.equal(local.clientOperationId, ID(9001), 'no pierde el id de su creación');
});

test('confirmar solo con la respuesta, sin pull: conserva el id de creación y deja la evidencia', async () => {
  const anular = await montar();
  await anular.repo.encolarOperacionAdministrativa(datosAnular());
  await anular.engine.syncNow({ soloPush: true });
  const anulado = await anular.storage.get('reproduccion_eventos', '1');
  assert.equal(anulado.clientOperationId, ID(9001));
  assert.equal(anulado.anulacionClientOperationId, ID(501));
  assert.equal(anulado.estadoRegistro, 'ANULADO');

  const corregir = await montar();
  await corregir.repo.encolarOperacionAdministrativa(datosCorregir());
  await corregir.engine.syncNow({ soloPush: true });
  const original = await corregir.storage.get('reproduccion_eventos', '1');
  assert.equal(original.clientOperationId, ID(9001));
  assert.equal(original.anulacionClientOperationId, ID(601));
  const corrector = await corregir.storage.get('reproduccion_eventos', original.corregidoPorEventoId);
  assert.equal(corrector.clientOperationId, ID(601));
});

test('ANULAR respuesta perdida: reintento con el mismo id y sin segunda anulación', async () => {
  const { srv, repo, engine } = await montar();
  await repo.encolarOperacionAdministrativa(datosAnular());
  let cortar = true;
  srv.falla = () => {
    if (!cortar) return null;
    cortar = false;
    return 'red-tras-guardar';
  };
  assert.equal(await engine.syncNow(), RUN_RESULT.OFFLINE);
  const incierta = await unica(repo);
  assert.equal(incierta.posibleEnServidor, true);
  assert.equal(incierta.estado, E.ERROR_REINTENTABLE);
  assert.equal(incierta.clientOperationId, ID(501));

  assert.equal(await engine.syncNow({ forzar: true }), RUN_RESULT.OK);
  assert.equal(srv.posts.length, 2);
  assert.equal(srv.posts[0].body.clientOperationId, srv.posts[1].body.clientOperationId);
  assert.deepEqual(await repo.listOutbox(), []);
  assert.equal(srv.eventos.filter((e) => e.estadoRegistro === 'ANULADO').length, 1);
});

test('ANULAR respuesta perdida: el pull exacto la cierra sin otro POST', async () => {
  const { srv, repo, engine } = await montar();
  await repo.encolarOperacionAdministrativa(datosAnular());
  srv.falla = () => 'red-tras-guardar';
  await engine.syncNow();
  srv.falla = null;
  assert.equal(await engine.syncNow(), RUN_RESULT.OK, 'en backoff: push no envía, pull concilia');
  assert.equal(srv.posts.length, 1);
  assert.deepEqual(await repo.listOutbox(), []);
});

// ---------------------------------------------------------------------------
// ANULAR: reconciliación exacta
// ---------------------------------------------------------------------------

async function anularIncierta() {
  const montaje = await montar();
  await montaje.repo.encolarOperacionAdministrativa(datosAnular({ posibleEnServidor: true, fallo: { codigo: 'NETWORK_ERROR', status: 0, tipo: 'red' } }));
  return montaje;
}

const vistaAnulada = (cambios = {}) => ({
  eventoId: '1', animalId: '7', tipoEvento: 'CELO_OBSERVADO', fechaEvento: '2026-10-01', estadoRegistro: 'ANULADO', clientOperationId: ID(9001), anulacionClientOperationId: ID(501), corregidoPorEventoId: null, anulacion: { motivo: 'Registrado por error' }, detalle: {}, ...cambios,
});

test('ANULAR: reconciliación exacta con las cuatro condiciones', async () => {
  const { srv, repo } = await anularIncierta();
  await repo.aplicarPullReproduccion(srv.pagina({ eventos: [vistaAnulada()] }));
  assert.deepEqual(await repo.listOutbox(), []);
});

test('ANULAR: sin anulacionClientOperationId exacto no es éxito, aunque esté ANULADO con el mismo motivo', async () => {
  for (const anulacionClientOperationId of [null, undefined, ID(777)]) {
    const { srv, repo } = await anularIncierta();
    await repo.aplicarPullReproduccion(srv.pagina({ eventos: [vistaAnulada({ anulacionClientOperationId })] }));
    const op = await unica(repo);
    assert.equal(op.estado, E.ERROR_REINTENTABLE, 'sigue incierta: su reintento lo decide el servidor');
    assert.equal(op.clientOperationId, ID(501));
  }
});

for (const [titulo, cambios] of [
  ['eventoId', { eventoId: '2' }],
  ['animalId', { animalId: '8' }],
  ['estadoRegistro', { estadoRegistro: 'ACTIVO' }],
  ['id usado por una corrección', { corregidoPorEventoId: '50' }],
]) {
  test(`ANULAR: mismatch de ${titulo} -> CONFLICTO, sin sobrescribir lo local`, async () => {
    const { srv, repo } = await anularIncierta();
    await repo.aplicarPullReproduccion(srv.pagina({ eventos: [vistaAnulada(cambios)] }));
    const op = await unica(repo);
    assert.equal(op.estado, E.CONFLICTO);
    assert.equal(op.ultimoError.codigo, 'CONCILIACION_INTENCION_DISTINTA');
    assert.deepEqual(op.payload, { animalId: '7', eventoId: '1', motivo: 'Registrado por error' });
    assert.equal(op.posibleEnServidor, true);
  });
}

test('ANULAR: el mismo id en una creación no es esta operación -> CONFLICTO', async () => {
  const { srv, repo } = await anularIncierta();
  await repo.aplicarPullReproduccion(srv.pagina({ eventos: [{ eventoId: '9', animalId: '7', estadoRegistro: 'ACTIVO', clientOperationId: ID(501), anulacionClientOperationId: null, detalle: {} }] }));
  assert.equal((await unica(repo)).estado, E.CONFLICTO);
});

test('ANULAR: la evidencia ya guardada en la copia también cuenta', async () => {
  const { srv, repo, storage } = await anularIncierta();
  await storage.put('reproduccion_eventos', vistaAnulada());
  await repo.aplicarPullReproduccion(srv.pagina({ eventos: [] }));
  assert.deepEqual(await repo.listOutbox(), []);
});

test('ANULAR: otra cuenta, otra sesión o un estado no incierto no concilian', async () => {
  const otra = await anularIncierta();
  await otra.repo.aplicarPullReproduccion(otra.srv.pagina({ cuentaId: CUENTA_B, eventos: [vistaAnulada()] }));
  assert.equal((await unica(otra.repo)).estado, E.ERROR_REINTENTABLE);

  const sinCuenta = await anularIncierta();
  await sinCuenta.repo.aplicarPullReproduccion(sinCuenta.srv.pagina({ cuentaId: undefined, eventos: [vistaAnulada()] }));
  assert.equal((await unica(sinCuenta.repo)).estado, E.ERROR_REINTENTABLE);

  for (const estado of [E.CONFLICTO, E.RECHAZADO, E.BLOQUEADA_POR_IDENTIDAD]) {
    const { srv, repo } = await anularIncierta();
    await repo.putOperacion({ ...await unica(repo), estado });
    await repo.aplicarPullReproduccion(srv.pagina({ eventos: [vistaAnulada()] }));
    assert.equal((await unica(repo)).estado, estado);
  }
});

test('ANULAR: una operación SINCRONIZANDO reciente no se concilia; pasado el lease, sí', async () => {
  const { srv, repo, reloj: r } = await anularIncierta();
  await repo.putOperacion({ ...await unica(repo), estado: E.SINCRONIZANDO, updatedAt: r.now().toISOString() });
  await repo.aplicarPullReproduccion(srv.pagina({ eventos: [vistaAnulada()] }));
  assert.equal((await unica(repo)).estado, E.SINCRONIZANDO);
  r.avanzar(2 * 60_000);
  await repo.aplicarPullReproduccion(srv.pagina({ eventos: [] }));
  assert.deepEqual(await repo.listOutbox(), []);
});

// ---------------------------------------------------------------------------
// Respuestas del servidor (ambas operaciones)
// ---------------------------------------------------------------------------

const ENCOLAR = { ANULAR: datosAnular, CORREGIR: datosCorregir };

for (const [nombre, datos] of Object.entries(ENCOLAR)) {
  test(`${nombre} EVENTO_YA_ANULADO: CONFLICTO sin reintento automático ni marcar offline`, async () => {
    const { srv, repo, engine } = await montar();
    await repo.encolarOperacionAdministrativa(datos());
    srv.anularPorFuera('1');
    assert.equal(await engine.syncNow(), RUN_RESULT.OK);
    const op = await unica(repo);
    assert.equal(op.estado, E.CONFLICTO);
    assert.equal(op.ultimoError.codigo, 'EVENTO_YA_ANULADO');
    assert.equal(op.posibleEnServidor, false);
    assert.equal(engine.getState().servidorAlcanzable, true);
    await engine.syncNow({ forzar: true });
    assert.equal(srv.posts.length, 1, 'no se reintenta solo');
    await assert.rejects(repo.reintentarEventoPendiente(op.operationId, { cuentaId: CUENTA_A }), { code: 'EVENTO_NO_REINTENTABLE' });
  });

  test(`${nombre} EVENTO_NOT_FOUND: CONFLICTO`, async () => {
    const { srv, repo, engine } = await montar();
    await repo.encolarOperacionAdministrativa(datos({ eventoId: '55' }));
    await engine.syncNow();
    const op = await unica(repo);
    assert.equal(op.estado, E.CONFLICTO);
    assert.equal(op.ultimoError.codigo, 'EVENTO_NOT_FOUND');
    await engine.syncNow({ forzar: true });
    assert.equal(srv.posts.length, 1);
    await assert.rejects(repo.reintentarEventoPendiente(op.operationId, { cuentaId: CUENTA_A }), { code: 'EVENTO_NO_REINTENTABLE' });
  });

  test(`${nombre} CLIENT_OPERATION_ID_REUSED: CONFLICTO`, async () => {
    const { srv, repo, engine } = await montar();
    await repo.encolarOperacionAdministrativa(datos());
    srv.falla = () => ({ status: 409, data: { error: 'CLIENT_OPERATION_ID_REUSED' } });
    await engine.syncNow();
    const op = await unica(repo);
    assert.equal(op.estado, E.CONFLICTO);
    await engine.syncNow({ forzar: true });
    assert.equal(srv.posts.length, 1);
    await assert.rejects(repo.reintentarEventoPendiente(op.operationId, { cuentaId: CUENTA_A }), { code: 'EVENTO_NO_REINTENTABLE' });
  });

  test(`${nombre} IDENTIDAD_NO_COINCIDE: bloqueada y vuelve a salir solo con su cuenta`, async () => {
    const { srv, repo, engine } = await montar();
    await repo.encolarOperacionAdministrativa(datos());
    // La cookie cambia después de la verificación previa, justo antes del POST.
    srv.alEnviar = () => {
      srv.sesion = { ...srv.sesion, cuenta: { cuentaId: CUENTA_B } };
      srv.alEnviar = null;
    };
    await engine.syncNow();
    const op = await unica(repo);
    assert.equal(op.estado, E.BLOQUEADA_POR_IDENTIDAD);
    assert.equal(op.ultimoError.codigo, 'IDENTIDAD_NO_COINCIDE');
    assert.deepEqual(op.origen, { organizacionId: ORG, cuentaId: CUENTA_A }, 'nunca cambia de autor');
    assert.equal(srv.eventos.find((e) => e.eventoId === '1').estadoRegistro, 'ACTIVO', 'el servidor no escribió');

    // Otra cuenta de la MISMA organización: ni se envía.
    await engine.syncNow({ forzar: true });
    assert.equal(srv.posts.length, 1);
    assert.equal((await unica(repo)).estado, E.BLOQUEADA_POR_IDENTIDAD);

    srv.sesion = { ...srv.sesion, cuenta: { cuentaId: CUENTA_A } };
    await engine.syncNow({ forzar: true });
    assert.equal(srv.posts.length, 2);
    assert.equal(srv.posts[1].body.clientOperationId, op.clientOperationId);
    assert.deepEqual(await repo.listOutbox(), []);
  });

  test(`${nombre} rol perdido: RECHAZADO conservando posibleEnServidor`, async () => {
    const { srv, repo, engine } = await montar();
    await repo.encolarOperacionAdministrativa(datos());
    srv.falla = () => 'red-tras-guardar';
    await engine.syncNow();
    srv.falla = () => ({ status: 403, data: { error: 'ROLE_FORBIDDEN' } });
    await engine.syncNow({ forzar: true });
    const op = await unica(repo);
    assert.equal(op.estado, E.RECHAZADO);
    assert.equal(op.ultimoError.codigo, 'ROLE_FORBIDDEN');
    assert.equal(op.posibleEnServidor, true);
    assert.equal(estadoEventoPendiente({ ...op, posibleEnServidor: true }).etiqueta, 'Rechazado');
  });

  test(`${nombre} rol perdido en el primer envío: posibleEnServidor sigue en false`, async () => {
    const { srv, repo, engine } = await montar();
    await repo.encolarOperacionAdministrativa(datos());
    srv.falla = () => ({ status: 403, data: { error: 'ROLE_FORBIDDEN' } });
    await engine.syncNow();
    const op = await unica(repo);
    assert.equal(op.estado, E.RECHAZADO);
    assert.equal(op.posibleEnServidor, false);
  });

  for (const status of [408, 429, 500, 503]) {
    test(`${nombre} HTTP ${status}: reintento con backoff y el motor sigue online`, async () => {
      const { srv, repo, engine } = await montar();
      await repo.encolarOperacionAdministrativa(datos());
      srv.falla = () => ({ status, data: { error: 'TEMPORAL' } });
      assert.equal(await engine.syncNow(), RUN_RESULT.ERROR);
      const op = await unica(repo);
      assert.equal(op.estado, E.ERROR_REINTENTABLE);
      assert.equal(op.ultimoError.tipo, 'http');
      assert.equal(op.posibleEnServidor, true);
      assert.ok(op.siguienteIntentoAt);
      const estado = engine.getState();
      assert.equal(estado.servidorAlcanzable, true);
      assert.equal(calcularOnline({ navegadorOnline: true, sesionOffline: false, ultimoResultado: estado.ultimoResultado, servidorAlcanzable: estado.servidorAlcanzable }), true);
      assert.equal(estadoEventoPendiente(op).etiqueta, 'Error temporal');
    });
  }

  test(`${nombre} status 0: OFFLINE y reconexión`, async () => {
    const { srv, repo, engine } = await montar();
    await repo.encolarOperacionAdministrativa(datos());
    srv.falla = () => 'red';
    assert.equal(await engine.syncNow(), RUN_RESULT.OFFLINE);
    const estado = engine.getState();
    assert.equal(estado.servidorAlcanzable, false);
    assert.equal(estado.reconexionNecesaria, true);
    const op = await unica(repo);
    assert.equal(op.ultimoError.tipo, 'red');
    assert.equal(op.posibleEnServidor, true);
    assert.equal(estadoEventoPendiente(op).etiqueta, 'Pendiente');
  });

  test(`${nombre} HTTP 400: RECHAZADO definitivo, sin marcar offline`, async () => {
    const { srv, repo, engine } = await montar();
    await repo.encolarOperacionAdministrativa(datos());
    srv.falla = () => ({ status: 400, data: { error: 'INVALID_MOTIVO' } });
    assert.equal(await engine.syncNow(), RUN_RESULT.OK);
    const op = await unica(repo);
    assert.equal(op.estado, E.RECHAZADO);
    assert.equal(op.posibleEnServidor, false);
    assert.equal(engine.getState().servidorAlcanzable, true);
  });

  test(`${nombre}: cancelar antes de enviar, sin tocar el servidor`, async () => {
    const { srv, repo, engine } = await montar();
    const { operationId } = await repo.encolarOperacionAdministrativa(datos());
    await repo.cancelarEventoReproductivoPendiente(operationId, { cuentaId: CUENTA_A });
    assert.deepEqual(await repo.listOutbox(), []);
    await engine.syncNow();
    assert.equal(srv.posts.length, 0);
    await repo.encolarOperacionAdministrativa(datos({ clientOperationId: ID(777) }));
    await unica(repo);
  });

  test(`${nombre}: con posibleEnServidor no se cancela y el payload no cambia`, async () => {
    const { srv, repo, engine } = await montar();
    const { operationId } = await repo.encolarOperacionAdministrativa(datos());
    srv.falla = () => 'red';
    await engine.syncNow();
    const antes = await unica(repo);
    await assert.rejects(repo.cancelarEventoReproductivoPendiente(operationId, { cuentaId: CUENTA_A }), { code: 'EVENTO_ENVIO_INCIERTO' });
    assert.deepEqual(await unica(repo), antes);
    assert.equal(antes.posibleEnServidor, true);
  });

  test(`${nombre}: otra cuenta no cancela ni reintenta`, async () => {
    const { repo } = await montar();
    const { operationId } = await repo.encolarOperacionAdministrativa(datos());
    await assert.rejects(repo.cancelarEventoReproductivoPendiente(operationId, { cuentaId: CUENTA_B }), { code: E.BLOQUEADA_POR_IDENTIDAD });
    await assert.rejects(repo.reintentarEventoPendiente(operationId, { cuentaId: CUENTA_B }), { code: E.BLOQUEADA_POR_IDENTIDAD });
    await unica(repo);
  });
}

test('clasificación: ningún 4xx de estas operaciones es reintentable ni de red', () => {
  const clase = (status, error) => classifyResult({ ok: false, status, data: { error } });
  assert.equal(clase(409, 'EVENTO_YA_ANULADO'), 'CONFLICTO');
  assert.equal(clase(404, 'EVENTO_NOT_FOUND'), 'CONFLICTO');
  assert.equal(clase(409, 'CLIENT_OPERATION_ID_REUSED'), 'CONFLICTO');
  assert.equal(clase(409, 'IDENTIDAD_NO_COINCIDE'), 'IDENTIDAD');
  assert.equal(clase(403, 'ROLE_FORBIDDEN'), 'RECHAZADO');
  assert.equal(clase(400, 'INVALID_MOTIVO'), 'RECHAZADO');
  for (const status of [408, 429, 500, 503]) assert.equal(clase(status, 'X'), 'REINTENTABLE');
});

// ---------------------------------------------------------------------------
// CORREGIR
// ---------------------------------------------------------------------------

test('CORREGIR diferida: exige confirmar la advertencia exacta y no encola antes', async () => {
  const { repo } = await montar();
  const r = await repo.encolarOperacionAdministrativa(datosCorregir({ confirmarAdvertencia: false }));
  assert.equal(r.requiereConfirmacion, true);
  assert.equal(r.advertencia.code, 'CORRECCION_DIFERIDA');
  assert.equal(r.advertencia.message, 'La corrección quedará pendiente y puede aplicarse más adelante cuando se restablezca la conexión. El estado reproductivo visible puede cambiar al sincronizar.');
  assert.equal(r.advertencia.message, ADVERTENCIA_CORRECCION_DIFERIDA);
  assert.deepEqual(await repo.listOutbox(), []);
  await repo.encolarOperacionAdministrativa(datosCorregir({ confirmarAdvertencia: true }));
  await unica(repo);
});

test('ANULAR no pide advertencia: su diálogo ya exige confirmación', async () => {
  const { repo } = await montar();
  const r = await repo.encolarOperacionAdministrativa(datosAnular());
  assert.equal(r.requiereConfirmacion, undefined);
  await unica(repo);
});

test('CORREGIR offline: sale al reconectar con cuerpo exacto y entra en la copia enlazada', async () => {
  const { srv, repo, engine, red, storage } = await montar();
  red.online = false;
  await repo.encolarOperacionAdministrativa(datosCorregir());
  assert.equal(await engine.syncNow(), RUN_RESULT.OFFLINE);
  assert.equal(srv.posts.length, 0);
  red.online = true;
  assert.equal(await engine.syncNow(), RUN_RESULT.OK);
  assert.deepEqual(srv.posts[0].body, { motivo: 'Fecha errónea', clientOperationId: ID(601), evento: { ...CORREGIDO }, identidadEsperada: { organizacionId: ORG, cuentaId: CUENTA_A } });
  assert.deepEqual(await repo.listOutbox(), []);
  const original = await storage.get('reproduccion_eventos', '1');
  assert.equal(original.estadoRegistro, 'ANULADO');
  assert.equal(original.anulacionClientOperationId, ID(601));
  const corrector = await storage.get('reproduccion_eventos', original.corregidoPorEventoId);
  assert.equal(corrector.corrigeEventoId, '1');
  assert.equal(corrector.clientOperationId, ID(601));
  assert.equal(corrector.fechaEvento, '2026-10-02');
});

test('CORREGIR respuesta perdida: el pull exacto la cierra sin otro POST', async () => {
  const { srv, repo, engine } = await montar();
  await repo.encolarOperacionAdministrativa(datosCorregir());
  srv.falla = () => 'red-tras-guardar';
  await engine.syncNow();
  assert.equal((await unica(repo)).posibleEnServidor, true);
  srv.falla = null;
  assert.equal(await engine.syncNow(), RUN_RESULT.OK);
  assert.equal(srv.posts.length, 1);
  assert.deepEqual(await repo.listOutbox(), []);
  assert.equal(srv.eventos.filter((e) => e.corrigeEventoId === '1').length, 1);
});

test('CORREGIR respuesta perdida: el reintento con el mismo id no duplica', async () => {
  const { srv, repo, engine } = await montar();
  await repo.encolarOperacionAdministrativa(datosCorregir());
  let cortar = true;
  srv.falla = () => {
    if (!cortar) return null;
    cortar = false;
    return 'red-tras-guardar';
  };
  await engine.syncNow();
  await engine.syncNow({ forzar: true });
  assert.equal(srv.posts[0].body.clientOperationId, srv.posts[1].body.clientOperationId);
  assert.deepEqual(await repo.listOutbox(), []);
  assert.equal(srv.eventos.filter((e) => e.corrigeEventoId === '1').length, 1);
});

async function corregirIncierta() {
  const montaje = await montar();
  await montaje.repo.encolarOperacionAdministrativa(datosCorregir({ posibleEnServidor: true, fallo: { codigo: 'NETWORK_ERROR', status: 0, tipo: 'red' } }));
  return montaje;
}

const vistaCorrector = (cambios = {}) => ({
  eventoId: '50', animalId: '7', tipoEvento: CORREGIDO.tipoEvento, fechaEvento: CORREGIDO.fechaEvento, horaEvento: null, observaciones: CORREGIDO.observaciones,
  detalle: { intensidadCelo: CORREGIDO.intensidadCelo }, estadoRegistro: 'ACTIVO', corrigeEventoId: '1', corregidoPorEventoId: null, clientOperationId: ID(601), anulacionClientOperationId: null, ...cambios,
});
const vistaOriginal = (cambios = {}) => ({
  eventoId: '1', animalId: '7', tipoEvento: CELO.tipoEvento, fechaEvento: CELO.fechaEvento, detalle: {}, estadoRegistro: 'ANULADO', corrigeEventoId: null, corregidoPorEventoId: '50',
  anulacion: { anuladoEn: 'x', motivo: 'Fecha errónea' }, clientOperationId: ID(9001), anulacionClientOperationId: ID(601), ...cambios,
});

test('CORREGIR: reconciliación exacta', async () => {
  const { srv, repo } = await corregirIncierta();
  await repo.aplicarPullReproduccion(srv.pagina({ eventos: [vistaOriginal(), vistaCorrector()] }));
  assert.deepEqual(await repo.listOutbox(), []);
});

test('CORREGIR: el corrector ANULADO después no invalida que la corrección ocurrió', async () => {
  const { srv, repo } = await corregirIncierta();
  const anulado = vistaCorrector({ estadoRegistro: 'ANULADO', anulacionClientOperationId: ID(888), anulacion: { motivo: 'otra' } });
  await repo.aplicarPullReproduccion(srv.pagina({ eventos: [vistaOriginal(), anulado] }));
  assert.deepEqual(await repo.listOutbox(), []);
});

test('CORREGIR: original y corrector en páginas distintas: espera y luego confirma', async () => {
  const { srv, repo } = await corregirIncierta();
  await repo.aplicarPullReproduccion(srv.pagina({ eventos: [vistaOriginal()], hayMas: true, totales: null }));
  assert.equal((await unica(repo)).estado, E.ERROR_REINTENTABLE, 'solo el original: aún sin evidencia completa');
  await repo.aplicarPullReproduccion(srv.pagina({ eventos: [vistaCorrector()] }));
  assert.deepEqual(await repo.listOutbox(), []);
});

test('CORREGIR: solo el corrector, con el original aún ACTIVO en la copia: espera', async () => {
  const { srv, repo } = await corregirIncierta();
  await repo.aplicarPullReproduccion(srv.pagina({ eventos: [vistaCorrector()], hayMas: true, totales: null }));
  assert.equal((await unica(repo)).estado, E.ERROR_REINTENTABLE);
});

for (const [titulo, eventos] of [
  ['intención: tipo', [vistaOriginal(), vistaCorrector({ tipoEvento: 'ABORTO' })]],
  ['intención: fecha', [vistaOriginal(), vistaCorrector({ fechaEvento: '2026-10-03' })]],
  ['intención: campo específico', [vistaOriginal(), vistaCorrector({ detalle: { intensidadCelo: 'MEDIA' } })]],
  ['intención: observaciones', [vistaOriginal(), vistaCorrector({ observaciones: 'otra' })]],
  ['motivo', [vistaOriginal({ anulacion: { motivo: 'parecido' } }), vistaCorrector()]],
  ['corrigeEventoId', [vistaOriginal(), vistaCorrector({ corrigeEventoId: '2' })]],
  ['corrigeEventoId ausente (id usado en una creación)', [vistaCorrector({ corrigeEventoId: null })]],
  ['animalId del corrector', [vistaOriginal(), vistaCorrector({ animalId: '8' })]],
  ['animalId del original', [vistaOriginal({ animalId: '8' }), vistaCorrector()]],
  ['eventoId del original', [vistaOriginal({ eventoId: '2' }), vistaCorrector()]],
  ['enlace del original a otro corrector', [vistaOriginal({ corregidoPorEventoId: '51' }), vistaCorrector()]],
  ['original no anulado por este id', [vistaOriginal({ anulacionClientOperationId: ID(888) }), vistaCorrector()]],
  ['original con anulacionClientOperationId nulo', [vistaOriginal({ anulacionClientOperationId: null }), vistaCorrector()]],
  ['original sin ANULADO', [vistaOriginal({ estadoRegistro: 'ACTIVO' }), vistaCorrector()]],
]) {
  test(`CORREGIR: mismatch de ${titulo} -> CONFLICTO, sin sobrescribir lo local`, async () => {
    const { srv, repo } = await corregirIncierta();
    await repo.aplicarPullReproduccion(srv.pagina({ eventos }));
    const op = await unica(repo);
    assert.equal(op.estado, E.CONFLICTO);
    assert.equal(op.ultimoError.codigo, 'CONCILIACION_INTENCION_DISTINTA');
    assert.deepEqual(op.payload.evento, { ...CORREGIDO });
    assert.equal(op.clientOperationId, ID(601));
  });
}

test('CORREGIR: un clientOperationId sin coincidencia y estado ANULADO ajeno no son evidencia', async () => {
  const { srv, repo } = await corregirIncierta();
  await repo.aplicarPullReproduccion(srv.pagina({ eventos: [vistaOriginal({ anulacionClientOperationId: ID(888), corregidoPorEventoId: null })] }));
  assert.equal((await unica(repo)).estado, E.ERROR_REINTENTABLE);
});

test('funciones puras: sin evidencia no concluyen nada', () => {
  const op = { clientOperationId: ID(1), payload: { animalId: '7', eventoId: '1', motivo: 'm', evento: { ...CELO } } };
  const ajeno = { eventoId: '1', animalId: '7', estadoRegistro: 'ANULADO', clientOperationId: ID(2), anulacionClientOperationId: ID(3) };
  assert.equal(conciliarAnular(op, []), CONCILIACION.SIN_EVIDENCIA);
  assert.equal(conciliarAnular(op, [ajeno]), CONCILIACION.SIN_EVIDENCIA);
  assert.equal(conciliarCorregir(op, []), CONCILIACION.SIN_EVIDENCIA);
  assert.equal(conciliarCorregir(op, [ajeno]), CONCILIACION.SIN_EVIDENCIA);
});

test('CORREGIR evento inválido 400: rollback del servidor, sin nada local, y se puede editar', async () => {
  const { srv, repo, engine, storage } = await montar();
  const { operationId } = await repo.encolarOperacionAdministrativa(datosCorregir({ evento: { tipoEvento: 'INVALIDO', fechaEvento: '2026-10-02' } }));
  assert.equal(await engine.syncNow(), RUN_RESULT.OK);
  const op = await unica(repo);
  assert.equal(op.estado, E.RECHAZADO);
  assert.equal(op.ultimoError.codigo, 'INVALID_TIPO_EVENTO');
  assert.equal(op.posibleEnServidor, false);
  // La transacción no ocurrió: original intacto y sin corrector, en servidor y en copia.
  assert.equal(srv.eventos.find((e) => e.eventoId === '1').estadoRegistro, 'ACTIVO');
  assert.equal(srv.eventos.some((e) => e.corrigeEventoId === '1'), false);
  assert.equal((await storage.get('reproduccion_eventos', '1')).estadoRegistro, 'ACTIVO');

  const { pendiente } = await repo.editarCorreccionPendiente({ operationId, motivo: 'Fecha errónea', evento: { ...CORREGIDO }, cuentaId: CUENTA_A, rol: 'admin' });
  assert.notEqual(pendiente.clientOperationId, op.clientOperationId, 'otra intención, otro id');
  await engine.syncNow();
  assert.deepEqual(await repo.listOutbox(), []);
  assert.equal(srv.eventos.filter((e) => e.corrigeEventoId === '1').length, 1);
});

test('CORREGIR 503 con rollback: el original sigue ACTIVO, no se concilia y se reintenta con el mismo id', async () => {
  const { srv, repo, engine, reloj: r } = await montar();
  await repo.encolarOperacionAdministrativa(datosCorregir());
  srv.falla = () => ({ status: 503, data: { error: 'TEMPORAL' } });
  await engine.syncNow();
  await repo.aplicarPullReproduccion(srv.pagina());
  const op = await unica(repo);
  assert.equal(op.estado, E.ERROR_REINTENTABLE);
  srv.falla = null;
  r.avanzar(60_000);
  await engine.syncNow();
  assert.equal(srv.posts[1].body.clientOperationId, op.clientOperationId);
  assert.deepEqual(await repo.listOutbox(), []);
});

test('CORREGIR: editar antes del primer envío conserva posición y cambia el id', async () => {
  const { repo } = await montar();
  await repo.registrarEventoReproductivoLocal({ animalId: '7', body: crearCuerpo(ID(1)), cuentaId: CUENTA_A });
  const { operationId } = await repo.encolarOperacionAdministrativa(datosCorregir());
  const antes = await repo.getOperacion(operationId);
  const { pendiente, sinCambios } = await repo.editarCorreccionPendiente({ operationId, motivo: 'Otro motivo', evento: { ...CELO, fechaEvento: '2026-10-05' }, cuentaId: CUENTA_A, rol: 'admin' });
  assert.equal(sinCambios, false);
  assert.notEqual(pendiente.clientOperationId, antes.clientOperationId);
  const despues = await repo.getOperacion(operationId);
  assert.equal(despues.createdAt, antes.createdAt);
  assert.equal(despues.payload.motivo, 'Otro motivo');
  assert.equal(despues.payload.eventoId, '1');
  assert.equal((await repo.listOutbox()).length, 2);
});

test('CORREGIR: editar sin cambios conserva el id', async () => {
  const { repo } = await montar();
  const { operationId } = await repo.encolarOperacionAdministrativa(datosCorregir());
  const { sinCambios, pendiente } = await repo.editarCorreccionPendiente({ operationId, motivo: 'Fecha errónea', evento: { ...CORREGIDO }, cuentaId: CUENTA_A, rol: 'admin' });
  assert.equal(sinCambios, true);
  assert.equal(pendiente.clientOperationId, ID(601));
});

test('CORREGIR: no se edita con posibleEnServidor, ni siquiera rechazada', async () => {
  const { srv, repo, engine } = await montar();
  const { operationId } = await repo.encolarOperacionAdministrativa(datosCorregir());
  srv.falla = () => 'red';
  await engine.syncNow();
  const editar = () => repo.editarCorreccionPendiente({ operationId, motivo: 'otro', evento: { ...CELO }, cuentaId: CUENTA_A, rol: 'admin' });
  const antes = await unica(repo);
  await assert.rejects(editar(), { code: 'EVENTO_ENVIO_INCIERTO' });
  assert.deepEqual(await unica(repo), antes);
  await repo.putOperacion({ ...antes, estado: E.RECHAZADO });
  await assert.rejects(editar(), { code: 'EVENTO_ENVIO_INCIERTO' });
  const final = await unica(repo);
  assert.equal(final.clientOperationId, ID(601));
  assert.deepEqual(final.payload, antes.payload);
});

test('CORREGIR: otra cuenta, otro rol, enviándose o en conflicto no se edita', async () => {
  const { repo } = await montar();
  const { operationId } = await repo.encolarOperacionAdministrativa(datosCorregir());
  const base = { operationId, motivo: 'otro', evento: { ...CELO }, cuentaId: CUENTA_A, rol: 'admin' };
  await assert.rejects(repo.editarCorreccionPendiente({ ...base, cuentaId: CUENTA_B }), { code: E.BLOQUEADA_POR_IDENTIDAD });
  await assert.rejects(repo.editarCorreccionPendiente({ ...base, rol: 'operador' }), { code: 'ROLE_FORBIDDEN' });
  const op = await unica(repo);
  await repo.putOperacion({ ...op, estado: E.SINCRONIZANDO });
  await assert.rejects(repo.editarCorreccionPendiente(base), { code: 'EVENTO_PENDIENTE_EN_CURSO' });
  await repo.putOperacion({ ...op, estado: E.CONFLICTO });
  await assert.rejects(repo.editarCorreccionPendiente(base), { code: 'EVENTO_EN_CONFLICTO' });
});

test('una anulación no se edita con el camino de corrección', async () => {
  const { repo } = await montar();
  const { operationId } = await repo.encolarOperacionAdministrativa(datosAnular());
  await assert.rejects(repo.editarCorreccionPendiente({ operationId, motivo: 'otro', evento: { ...CELO }, cuentaId: CUENTA_A, rol: 'admin' }), { code: 'EVENTO_PENDIENTE_NO_ENCONTRADO' });
  await assert.rejects(repo.editarEventoReproductivoPendiente({ operationId, body: { ...CELO }, cuentaId: CUENTA_A }), { code: 'EVENTO_PENDIENTE_NO_ENCONTRADO' });
});

// ---------------------------------------------------------------------------
// Acciones de la UI y persistencia tras un intento online
// ---------------------------------------------------------------------------

const vista = (tipoOperacion, estado, cambios = {}) => ({ tipoOperacion, eventoObjetivoId: '1', cuentaOrigenId: CUENTA_A, estado, posibleEnServidor: false, ultimoError: null, ...cambios });
const acciones = (p, cambios = {}) => accionesEventoPendiente(p, { cuentaId: CUENTA_A, puedeRegistrar: true, puedeAdministrar: true, ...cambios });

test('acciones: ANULAR se cancela pero no se edita; CORREGIR, ambas', () => {
  assert.deepEqual(acciones(vista(ANULAR, E.PENDIENTE)), { editar: false, cancelar: true, reintentar: false, confirmarIncierto: false });
  assert.deepEqual(acciones(vista(CORREGIR, E.PENDIENTE)), { editar: true, cancelar: true, reintentar: false, confirmarIncierto: false });
});

test('acciones: con posibleEnServidor nada muta la intención', () => {
  for (const tipo of [ANULAR, CORREGIR]) {
    for (const estado of [E.PENDIENTE, E.ERROR_REINTENTABLE, E.RECHAZADO, E.CONFLICTO]) {
      assert.equal(acciones(vista(tipo, estado, { posibleEnServidor: true })).editar, false, `${tipo} ${estado}`);
    }
    assert.equal(acciones(vista(tipo, E.PENDIENTE, { posibleEnServidor: true })).cancelar, false);
    assert.equal(acciones(vista(tipo, E.CONFLICTO, { posibleEnServidor: true })).confirmarIncierto, true);
  }
});

test('acciones: sin permiso de administración no se reintenta ni se edita; el operador no administra', () => {
  const sinPermiso = { puedeAdministrar: false };
  assert.equal(acciones(vista(CORREGIR, E.RECHAZADO), sinPermiso).reintentar, false);
  assert.equal(acciones(vista(CORREGIR, E.PENDIENTE), sinPermiso).editar, false);
  assert.equal(acciones(vista(CORREGIR, E.RECHAZADO), { puedeRegistrar: false }).reintentar, true);
  assert.equal(acciones(vista(CORREGIR, E.CONFLICTO)).editar, false, 'el servidor ya decidió');
});

test('acciones: EVENTO_YA_ANULADO y EVENTO_NOT_FOUND no ofrecen reintento', () => {
  for (const codigo of ['EVENTO_YA_ANULADO', 'EVENTO_NOT_FOUND', 'CLIENT_OPERATION_ID_REUSED']) {
    assert.equal(acciones(vista(ANULAR, E.CONFLICTO, { ultimoError: { codigo } })).reintentar, false, codigo);
  }
});

test('intento online: qué se persiste según la respuesta', () => {
  assert.deepEqual(persistenciaTrasFallo(null), { posibleEnServidor: true, fallo: { codigo: 'ERROR', status: 0, tipo: 'red' } });
  assert.deepEqual(persistenciaTrasFallo({ ok: false, status: 0, failure: 'NETWORK_ERROR' }), { posibleEnServidor: true, fallo: { codigo: 'NETWORK_ERROR', status: 0, tipo: 'red' } });
  assert.deepEqual(persistenciaTrasFallo({ ok: false, status: 0, failure: 'REQUEST_NOT_SENT' }), { posibleEnServidor: false, fallo: null });
  for (const status of [408, 429, 500, 503]) {
    assert.deepEqual(persistenciaTrasFallo({ ok: false, status, data: { error: 'X' } }), { posibleEnServidor: true, fallo: { codigo: 'X', status, tipo: 'http' } });
  }
  for (const [status, error] of [[400, 'INVALID_MOTIVO'], [403, 'ROLE_FORBIDDEN'], [404, 'EVENTO_NOT_FOUND'], [409, 'EVENTO_YA_ANULADO'], [409, 'IDENTIDAD_NO_COINCIDE'], [409, 'CLIENT_OPERATION_ID_REUSED'], [401, 'X']]) {
    assert.equal(persistenciaTrasFallo({ ok: false, status, data: { error } }), null, `${status} ${error}`);
  }
  assert.equal(persistenciaTrasFallo({ ok: false, status: 403, failure: 'CSRF_REJECTED' }), null);
});

test('intento online sin respuesta: persistida con el mismo id y la incertidumbre del envío', async () => {
  const { srv, repo, engine } = await montar();
  await repo.encolarOperacionAdministrativa(datosAnular({ clientOperationId: ID(42), ...persistenciaTrasFallo({ ok: false, status: 0, failure: 'NETWORK_ERROR' }) }));
  const op = await unica(repo);
  assert.equal(op.clientOperationId, ID(42));
  assert.equal(op.posibleEnServidor, true);
  assert.equal(op.estado, E.ERROR_REINTENTABLE);
  await engine.syncNow();
  assert.equal(srv.posts[0].body.clientOperationId, ID(42));
  assert.deepEqual(await repo.listOutbox(), []);
});

test('intento online 503: persistida en backoff; una corrección no pide otra advertencia', async () => {
  const { srv, repo, engine } = await montar();
  const r = await repo.encolarOperacionAdministrativa(datosCorregir({ confirmarAdvertencia: false, ...persistenciaTrasFallo({ ok: false, status: 503, data: { error: 'X' } }) }));
  assert.equal(r.requiereConfirmacion, undefined);
  const op = await unica(repo);
  assert.equal(op.ultimoError.tipo, 'http');
  assert.ok(op.siguienteIntentoAt > new Date('2026-10-20T15:00:00.000Z').toISOString());
  await engine.syncNow();
  assert.equal(srv.posts.length, 0, 'respeta el backoff');
});

// ---------------------------------------------------------------------------
// "Sincronizar ahora" (syncNow forzado) frente al backoff HTTP
// ---------------------------------------------------------------------------

const VENCER = 11 * 60_000; // mayor que cualquier backoff de estas pruebas

for (const status of [408, 429, 500, 503]) {
  for (const [nombre, datos] of Object.entries(ENCOLAR)) {
    test(`forzado ${status} ${nombre}: 0 POST antes de vencer; exactamente 1 después, con el mismo id`, async () => {
      const { srv, repo, engine, reloj: r } = await montar();
      await repo.encolarOperacionAdministrativa(datos());
      srv.falla = () => ({ status, data: { error: 'TEMPORAL' } });
      assert.equal(await engine.syncNow(), RUN_RESULT.ERROR);
      const op = await unica(repo);
      assert.equal(op.estado, E.ERROR_REINTENTABLE);
      assert.ok(op.siguienteIntentoAt > r.now().toISOString(), 'proximoIntento futuro');
      srv.falla = null;
      for (let i = 0; i < 3; i += 1) await engine.syncNow({ forzar: true });
      assert.equal(srv.posts.length, 1, 'ningún POST antes de vencer');
      assert.deepEqual(await unica(repo), op, 'la operación no se toca');
      r.avanzar(VENCER);
      await engine.syncNow({ forzar: true });
      assert.equal(srv.posts.length, 2, 'exactamente un POST al vencer');
      assert.equal(srv.posts[1].body.clientOperationId, op.clientOperationId);
      assert.deepEqual(await repo.listOutbox(), []);
    });
  }
}

test('forzado: ninguna ráfaga aunque el servidor siga respondiendo 429 al vencer', async () => {
  const { srv, repo, engine, reloj: r } = await montar();
  await repo.encolarOperacionAdministrativa(datosAnular());
  srv.falla = () => ({ status: 429, data: { error: 'RATE_LIMITED' } });
  await engine.syncNow();
  for (let i = 0; i < 5; i += 1) await engine.syncNow({ forzar: true });
  assert.equal(srv.posts.length, 1);
  r.avanzar(VENCER);
  for (let i = 0; i < 5; i += 1) await engine.syncNow({ forzar: true });
  assert.equal(srv.posts.length, 2, 'cada vencimiento permite un solo envío');
  assert.equal((await unica(repo)).intentos, 2);
});

test('forzado: también respeta el backoff de una operación antigua sin `tipo` (por status)', async () => {
  const { srv, repo, engine, reloj: r } = await montar();
  await repo.encolarOperacionAdministrativa(datosAnular());
  const op = await unica(repo);
  await repo.putOperacion({ ...op, estado: E.ERROR_REINTENTABLE, ultimoError: { codigo: 'X', status: 503 }, siguienteIntentoAt: new Date(r.now().getTime() + 60_000).toISOString() });
  await engine.syncNow({ forzar: true });
  assert.equal(srv.posts.length, 0);
});

test('forzado: un fallo de RED sí se adelanta (no hubo respuesta que respetar)', async () => {
  const { srv, repo, engine } = await montar();
  await repo.encolarOperacionAdministrativa(datosAnular());
  srv.falla = () => 'red';
  await engine.syncNow();
  assert.equal((await unica(repo)).ultimoError.tipo, 'red');
  srv.falla = null;
  await engine.syncNow({ forzar: true });
  assert.equal(srv.posts.length, 2);
  assert.deepEqual(await repo.listOutbox(), []);
});

test('forzado: una PENDIENTE nunca enviada de otro animal sale ya; la cabeza en backoff y su cadena esperan', async () => {
  const { srv, repo, engine } = await montar();
  await repo.encolarOperacionAdministrativa(datosAnular());
  await repo.encolarOperacionAdministrativa(datosCorregir({ eventoId: '2' }));
  srv.falla = () => ({ status: 503, data: { error: 'X' } });
  await engine.syncNow();
  srv.falla = null;
  await repo.encolarOperacionAdministrativa(datosAnular({ animalId: '8', eventoId: '3', clientOperationId: ID(503) }));
  await engine.syncNow({ forzar: true });
  assert.deepEqual(sufijos(srv), ['7/reproduccion/eventos/1/anular', '8/reproduccion/eventos/3/anular']);
  assert.equal((await repo.cadenaReproductiva('7')).length, 2);
});

test('forzado: tampoco lo adelanta para CREATE, PESAJE ni ANIMAL', async () => {
  const { srv, repo, engine, reloj: r, storage } = await montar();
  await repo.registrarEventoReproductivoLocal({ animalId: '7', body: crearCuerpo(ID(1)), cuentaId: CUENTA_A });
  await repo.registrarPesajeLocal({ animalId: '8', body: { fecha: '2026-10-01', pesoKg: 400, metodo: 'BASCULA', clientOperationId: ID(2) } });
  await repo.registrarAnimalLocal({ body: { clientOperationId: ID(3), sexo: 'HEMBRA' } });
  const vence = new Date(r.now().getTime() + 60_000).toISOString();
  for (const op of await repo.listOutbox()) {
    await storage.put('outbox', { ...op, estado: E.ERROR_REINTENTABLE, ultimoError: { codigo: 'X', status: 503, tipo: 'http' }, siguienteIntentoAt: vence });
  }
  await engine.syncNow({ forzar: true });
  assert.equal(srv.posts.length, 0);
});

test('forzado: cuando el ciclo concilia, el pull corre aunque la operación esté en backoff', async () => {
  const { srv, repo, engine } = await montar();
  await repo.encolarOperacionAdministrativa(datosAnular());
  let cortar = true;
  srv.falla = () => {
    if (!cortar) return { status: 503, data: { error: 'X' } };
    cortar = false;
    return 'red-tras-guardar';
  };
  await engine.syncNow();
  await engine.syncNow({ forzar: true });
  assert.equal((await unica(repo)).ultimoError.tipo, 'http');
  const posts = srv.posts.length;
  await engine.syncNow({ forzar: true });
  assert.equal(srv.posts.length, posts, 'sin POST');
  assert.deepEqual(await repo.listOutbox(), [], 'el pull exacto la cierra');
});

test('reintento manual: en backoff HTTP vigente se rechaza y nada cambia; vencido, sí', async () => {
  const { srv, repo, engine, reloj: r } = await montar();
  const { operationId } = await repo.encolarOperacionAdministrativa(datosAnular());
  srv.falla = () => ({ status: 429, data: { error: 'X' } });
  await engine.syncNow();
  const antes = await unica(repo);
  await assert.rejects(repo.reintentarEventoPendiente(operationId, { cuentaId: CUENTA_A }), { code: 'EVENTO_EN_BACKOFF' });
  assert.deepEqual(await unica(repo), antes);
  r.avanzar(VENCER);
  await repo.reintentarEventoPendiente(operationId, { cuentaId: CUENTA_A });
  assert.equal((await unica(repo)).estado, E.PENDIENTE);
});

test('reactivación expresa: un RECHAZADO que el usuario reintenta sale de inmediato', async () => {
  const { srv, repo, engine } = await montar();
  const { operationId } = await repo.encolarOperacionAdministrativa(datosAnular());
  srv.falla = () => ({ status: 403, data: { error: 'ROLE_FORBIDDEN' } });
  await engine.syncNow();
  srv.falla = null;
  await repo.reintentarEventoPendiente(operationId, { cuentaId: CUENTA_A });
  await engine.syncNow({ forzar: true });
  assert.equal(srv.posts.length, 2);
  assert.deepEqual(await repo.listOutbox(), []);
});

test('acciones: un 408/429/5xx no ofrece Reintentar; un fallo de red o un rechazo, sí', () => {
  const http = { ultimoError: { codigo: 'X', status: 503, tipo: 'http' } };
  for (const tipo of [ANULAR, CORREGIR, CREAR]) {
    assert.equal(acciones(vista(tipo, E.ERROR_REINTENTABLE, http)).reintentar, false, tipo);
    assert.equal(acciones(vista(tipo, E.ERROR_REINTENTABLE, { ultimoError: { codigo: 'X', status: 429 } })).reintentar, false, `${tipo} sin tipo`);
    assert.equal(acciones(vista(tipo, E.ERROR_REINTENTABLE, { ultimoError: { codigo: 'N', status: 0, tipo: 'red' } })).reintentar, true, tipo);
    assert.equal(acciones(vista(tipo, E.RECHAZADO, { ultimoError: { codigo: 'R', status: 403 } })).reintentar, true, tipo);
  }
});

test('autoSync: una operación que entra en backoff programa su reintento sin adelantarlo', async () => {
  const { srv, repo, engine, reloj: r } = await montar();
  const temporizadores = [];
  const auto = startAutoSync({
    repo,
    engine,
    now: r.now,
    setTimer: (fn, ms) => {
      const t = { fn, ms, vivo: true };
      temporizadores.push(t);
      return t;
    },
    clearTimer: (t) => { t.vivo = false; },
  });
  const vaciarDebounces = async () => {
    for (const t of temporizadores.filter((x) => x.vivo && x.ms === 1_500)) {
      t.vivo = false;
      await t.fn();
    }
    await new Promise((resolve) => { setImmediate(resolve); });
  };
  // El ciclo de apertura termina y deja de haber avisos pendientes.
  await auto.primera;
  await vaciarDebounces();
  await repo.encolarOperacionAdministrativa(datosCorregir({ ...persistenciaTrasFallo({ ok: false, status: 503, data: { error: 'X' } }) }));
  assert.equal(srv.posts.length, 0, 'no se envía al persistirla');
  await vaciarDebounces();
  assert.equal(srv.posts.length, 0, 'el backoff se respeta');
  const reintento = temporizadores.filter((t) => t.vivo && t.ms >= 1_000 && t.ms <= 6_000).at(-1);
  assert.ok(reintento, 'queda un reintento programado dentro de su backoff');
  auto.stop();
});

// ---------------------------------------------------------------------------
// FIFO causal
// ---------------------------------------------------------------------------

test('eventosCausales: una CORREGIR pendiente no cuenta como evento creado', async () => {
  const { repo } = await montar();
  // Con la corrección tratada como creación, su fecha posterior bloquearía este registro.
  await repo.encolarOperacionAdministrativa(datosCorregir({ evento: { ...CELO, fechaEvento: '2026-10-18' } }));
  await repo.encolarOperacionAdministrativa(datosAnular({ eventoId: '2' }));
  const r = await repo.registrarEventoReproductivoLocal({ animalId: '7', body: crearCuerpo(ID(1), '2026-10-05'), cuentaId: CUENTA_A, confirmarAdvertencia: true });
  assert.equal(r.yaEncolado, false);
  assert.equal(r.requiereConfirmacion, undefined);
});

test('eventosCausales: editar un CREATE con operaciones administrativas en la cadena no falla', async () => {
  const { repo } = await montar();
  const { operationId } = await repo.registrarEventoReproductivoLocal({ animalId: '7', body: crearCuerpo(ID(1)), cuentaId: CUENTA_A });
  await repo.encolarOperacionAdministrativa(datosAnular());
  const { sinCambios } = await repo.editarEventoReproductivoPendiente({ operationId, body: { tipoEvento: 'CELO_OBSERVADO', fechaEvento: '2026-10-16' }, cuentaId: CUENTA_A });
  assert.equal(sinCambios, false);
});

test('FIFO: CREATE -> ANULAR', async () => {
  const { srv, repo, engine } = await montar();
  await repo.registrarEventoReproductivoLocal({ animalId: '7', body: crearCuerpo(ID(1)), cuentaId: CUENTA_A });
  await repo.encolarOperacionAdministrativa(datosAnular());
  await engine.syncNow();
  assert.deepEqual(sufijos(srv), ['7/reproduccion/eventos', '7/reproduccion/eventos/1/anular']);
  assert.deepEqual(await repo.listOutbox(), []);
});

test('FIFO: CREATE -> CORREGIR', async () => {
  const { srv, repo, engine } = await montar();
  await repo.registrarEventoReproductivoLocal({ animalId: '7', body: crearCuerpo(ID(1)), cuentaId: CUENTA_A });
  await repo.encolarOperacionAdministrativa(datosCorregir());
  await engine.syncNow();
  assert.deepEqual(sufijos(srv), ['7/reproduccion/eventos', '7/reproduccion/eventos/1/corregir']);
});

test('FIFO: ANULAR -> CREATE posterior', async () => {
  const { srv, repo, engine } = await montar();
  await repo.encolarOperacionAdministrativa(datosAnular());
  await repo.registrarEventoReproductivoLocal({ animalId: '7', body: crearCuerpo(ID(1)), cuentaId: CUENTA_A });
  await engine.syncNow();
  assert.deepEqual(sufijos(srv), ['7/reproduccion/eventos/1/anular', '7/reproduccion/eventos']);
});

test('FIFO: CORREGIR -> CREATE posterior', async () => {
  const { srv, repo, engine } = await montar();
  await repo.encolarOperacionAdministrativa(datosCorregir());
  await repo.registrarEventoReproductivoLocal({ animalId: '7', body: crearCuerpo(ID(1)), cuentaId: CUENTA_A });
  await engine.syncNow();
  assert.deepEqual(sufijos(srv), ['7/reproduccion/eventos/1/corregir', '7/reproduccion/eventos']);
});

test('FIFO: ANULAR y CORREGIR del mismo animal se serializan', async () => {
  const { srv, repo, engine } = await montar();
  await repo.encolarOperacionAdministrativa(datosCorregir({ eventoId: '2' }));
  await repo.encolarOperacionAdministrativa(datosAnular());
  await engine.syncNow();
  assert.deepEqual(sufijos(srv), ['7/reproduccion/eventos/2/corregir', '7/reproduccion/eventos/1/anular']);
});

test('FIFO: el reloj que retrocede no altera el orden', async () => {
  const { srv, repo, engine, reloj: r } = await montar();
  await repo.encolarOperacionAdministrativa(datosAnular());
  r.avanzar(-3_600_000);
  await repo.encolarOperacionAdministrativa(datosCorregir({ eventoId: '2' }));
  await engine.syncNow();
  assert.deepEqual(sufijos(srv), ['7/reproduccion/eventos/1/anular', '7/reproduccion/eventos/2/corregir']);
});

for (const [titulo, cambios] of [
  ['backoff', { estado: E.ERROR_REINTENTABLE, siguienteIntentoAt: '2030-01-01T00:00:00.000Z', ultimoError: { codigo: 'X', status: 503, tipo: 'http' } }],
  ['sincronizando', { estado: E.SINCRONIZANDO }],
  ['conflicto', { estado: E.CONFLICTO, ultimoError: { codigo: 'EVENTO_YA_ANULADO', status: 409 } }],
  ['rechazo', { estado: E.RECHAZADO, ultimoError: { codigo: 'INVALID_MOTIVO', status: 400 } }],
  ['identidad', { estado: E.BLOQUEADA_POR_IDENTIDAD, origen: { organizacionId: ORG, cuentaId: CUENTA_B } }],
]) {
  test(`FIFO: ${titulo} detiene su cadena; el otro animal sigue`, async () => {
    const { srv, repo, engine } = await montar();
    const { operationId } = await repo.encolarOperacionAdministrativa(datosAnular());
    await repo.encolarOperacionAdministrativa(datosCorregir({ eventoId: '2' }));
    await repo.registrarEventoReproductivoLocal({ animalId: '7', body: crearCuerpo(ID(1)), cuentaId: CUENTA_A });
    await repo.encolarOperacionAdministrativa(datosAnular({ animalId: '8', eventoId: '3', clientOperationId: ID(503) }));
    await repo.putOperacion({ ...await repo.getOperacion(operationId), updatedAt: new Date('2026-10-20T15:00:00.000Z').toISOString(), ...cambios });
    await engine.syncNow();
    assert.deepEqual(sufijos(srv), ['8/reproduccion/eventos/3/anular']);
    const cadena = await repo.cadenaReproductiva('7');
    assert.equal(cadena.length, 3);
    assert.deepEqual(cadena.slice(1).map((op) => op.estado), [E.PENDIENTE, E.PENDIENTE]);
  });
}

test('FIFO: operacionesEnTurno respeta la cadena mixta', async () => {
  const { repo } = await montar();
  await repo.encolarOperacionAdministrativa(datosAnular());
  await repo.registrarEventoReproductivoLocal({ animalId: '7', body: crearCuerpo(ID(1)), cuentaId: CUENTA_A });
  await repo.encolarOperacionAdministrativa(datosCorregir({ animalId: '8', eventoId: '3' }));
  const turno = operacionesEnTurno(await repo.listOutbox());
  assert.deepEqual(turno.map((op) => op.tipoOperacion).sort(), [ANULAR, CORREGIR].sort());
});

test('FIFO: animales distintos no se bloquean en la cola ni con red intermitente por rechazo', async () => {
  const { srv, repo, engine } = await montar();
  await repo.encolarOperacionAdministrativa(datosAnular());
  await repo.encolarOperacionAdministrativa(datosAnular({ animalId: '8', eventoId: '3', clientOperationId: ID(503) }));
  srv.falla = (pathname) => (pathname.includes('/7/') ? { status: 400, data: { error: 'INVALID_MOTIVO' } } : null);
  await engine.syncNow();
  const [op] = await repo.listOutbox();
  assert.equal(op.payload.animalId, '7');
  assert.equal(op.estado, E.RECHAZADO);
  assert.equal(srv.eventos.find((e) => e.eventoId === '3').estadoRegistro, 'ANULADO');
});

// ---------------------------------------------------------------------------
// Compatibilidad
// ---------------------------------------------------------------------------

test('CREATE 4E.1: su forma de pendiente y su conciliación no cambian', async () => {
  const { srv, repo } = await montar();
  const { pendiente } = await repo.registrarEventoReproductivoLocal({ animalId: '7', body: crearCuerpo(ID(1)), cuentaId: CUENTA_A });
  for (const campo of ['tipoOperacion', 'eventoObjetivoId', 'motivo']) assert.equal(campo in pendiente, false, campo);
  await repo.aplicarPullReproduccion(srv.pagina({ eventos: [aEvento({ tipoEvento: 'CELO_OBSERVADO', fechaEvento: '2026-10-15' }, { eventoId: '60', animalId: '7', clientOperationId: ID(1) })] }));
  assert.deepEqual(await repo.listOutbox(), []);
});

test('un tipo desconocido en la cadena se conserva y la detiene; ANULAR no lo adelanta', async () => {
  const { srv, repo, engine, storage } = await montar();
  const desconocida = newOperation({
    tipoOperacion: 'REPRODUCCION_EVENTO_FUTURO', entidad: 'reproduccion_evento', localUuid: 'l', clientOperationId: ID(70), payload: { animalId: '7', eventoId: '1' }, deviceId: 'd', now: new Date('2026-10-19T00:00:00.000Z'), uuid: () => 'op-futura', claveOrden: claveOrdenAnimal('7'), origen: { organizacionId: ORG, cuentaId: CUENTA_A },
  });
  await storage.put('outbox', desconocida);
  await repo.encolarOperacionAdministrativa(datosAnular());
  await engine.syncNow();
  assert.equal(srv.posts.length, 0);
  const conservada = await repo.getOperacion('op-futura');
  assert.equal(conservada.tipoOperacion, 'REPRODUCCION_EVENTO_FUTURO');
  assert.ok(conservada.runtimeNoSoporta);
  assert.equal((await repo.listOutbox()).length, 2);
});

test('una operación antigua sin claveOrden sigue su camino junto a las administrativas', async () => {
  const { srv, repo, engine } = await montar();
  await repo.registrarPesajeLocal({ animalId: '7', body: { fecha: '2026-10-01', pesoKg: 400, metodo: 'BASCULA', clientOperationId: ID(80) } });
  await repo.encolarOperacionAdministrativa(datosAnular());
  await engine.syncNow();
  assert.equal(srv.posts.length, 2);
});

test('multipágina: con lock, dos motores envían una sola vez', async () => {
  let cola = Promise.resolve();
  const lock = (fn) => {
    const turno = cola.then(fn);
    cola = turno.catch(() => {});
    return turno;
  };
  const { srv, repo, storage } = await montar({ lock });
  const transport = transporte(srv);
  const motor = () => createSyncEngine({ repo, transport, isOnline: () => true, lock, random: () => 0.5 });
  await repo.encolarOperacionAdministrativa(datosAnular());
  await Promise.all([motor().syncNow(), motor().syncNow()]);
  assert.equal(srv.posts.length, 1);
  assert.equal((await storage.get('reproduccion_eventos', '1')).estadoRegistro, 'ANULADO');
});

test('reinicio de pestaña: una operación SINCRONIZANDO interrumpida se reenvía con su mismo id', async () => {
  const { srv, repo, engine, reloj: r } = await montar();
  await repo.encolarOperacionAdministrativa(datosCorregir());
  await repo.putOperacion({ ...await unica(repo), estado: E.SINCRONIZANDO, posibleEnServidor: true, updatedAt: r.now().toISOString() });
  r.avanzar(2 * 60_000 + 1);
  await engine.syncNow();
  assert.equal(srv.posts[0].body.clientOperationId, ID(601));
  assert.deepEqual(await repo.listOutbox(), []);
});

test('IndexedDB v2: ANULAR y CORREGIR viven en el esquema actual, sin subir de versión', async () => {
  assert.equal(ORG_DB_VERSION, 2);
  const idb = new IDBFactory();
  const db = await openIndexedDb(idb, orgDbName(ORG), ORG_DB_VERSION, ORG_STORES);
  const { repo, engine, srv } = await montar({ storage: createIndexedDbStorage(db) });
  await repo.encolarOperacionAdministrativa(datosAnular());
  await repo.encolarOperacionAdministrativa(datosCorregir({ eventoId: '2' }));
  assert.equal((await repo.cadenaReproductiva('7')).length, 2);
  await engine.syncNow();
  assert.equal(srv.posts.length, 2);
  assert.deepEqual(await repo.listOutbox(), []);
  db.close();
});

test('el tipo CREATE sigue enviando su cuerpo de 4E.1', () => {
  const origen = { organizacionId: ORG, cuentaId: CUENTA_A };
  assert.deepEqual(handlerDe(CREAR).request({ payload: { animalId: '7', evento: { ...CELO } }, clientOperationId: ID(1), origen }), {
    path: '/api/ganaderia/animales/7/reproduccion/eventos',
    body: { ...CELO, clientOperationId: ID(1), identidadEsperada: origen },
  });
});
