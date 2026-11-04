// FASE 4E.1 -- regresión de un bucle hallado en navegador real: una operación que no
// puede salir (retenida en su cadena, en backoff o de un tipo desconocido) mantenía
// disparando ciclos de sincronización sin fin, porque el aviso del pull y el Background
// Sync volvían a dispararlo. El entorno se inyecta: sin navegador, reloj manual.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ORG_STORES } from '../offlineSchema.js';
import { createMemoryStorage } from '../storage.js';
import { createLocalRepo } from '../localRepo.js';
import { createSyncEngine } from '../syncEngine.js';
import { BACKGROUND_SYNC_TAG, startAutoSync } from '../autoSync.js';
import { OUTBOX_ESTADOS as E, REPRODUCCION_EVENTO_CREAR, claveOrdenAnimal, operacionesEnTurno } from '../outbox.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const CUENTA = 'aaaaaaaa-0000-4000-8000-000000000001';
const AHORA = '2026-10-20T15:00:00.000Z';

let seq = 0;
function op(animalId, estado, cambios = {}) {
  seq += 1;
  return {
    operationId: `o-${seq}`, tipoOperacion: REPRODUCCION_EVENTO_CREAR, entidad: 'reproduccion_evento', localUuid: `l-${seq}`,
    clientOperationId: `c-${seq}`, payload: { animalId, evento: { tipoEvento: 'CELO_OBSERVADO', fechaEvento: '2026-10-01' } },
    estado, intentos: 0, ultimoError: null, siguienteIntentoAt: null, createdAt: `2026-10-02T00:00:${String(seq % 60).padStart(2, '0')}.000Z`,
    updatedAt: AHORA, claveOrden: claveOrdenAnimal(animalId), origen: { organizacionId: ORG, cuentaId: CUENTA }, posibleEnServidor: false, runtimeNoSoporta: null, ...cambios,
  };
}
const ids = (lista) => lista.map((o) => o.operationId);

test('en turno: solo la primera activa de cada cadena', () => {
  const a = op('1', E.PENDIENTE);
  const b = op('1', E.PENDIENTE);
  const c = op('2', E.ERROR_REINTENTABLE);
  assert.deepEqual(ids(operacionesEnTurno([b, a, c])), [a.operationId, c.operationId]);
});

for (const estado of [E.CONFLICTO, E.RECHAZADO, E.BLOQUEADA_POR_IDENTIDAD]) {
  test(`en turno: ${estado} retiene al resto de su cadena y no a las demás`, () => {
    const primera = op('1', estado);
    const retenida = op('1', E.PENDIENTE);
    const otra = op('2', E.PENDIENTE);
    assert.deepEqual(ids(operacionesEnTurno([primera, retenida, otra])), [otra.operationId]);
  });
}

test('en turno: un tipo desconocido no cuenta y retiene su cadena', () => {
  const desconocida = op('1', E.PENDIENTE, { tipoOperacion: 'FUTURO' });
  const retenida = op('1', E.PENDIENTE);
  const otra = op('2', E.PENDIENTE);
  const soportado = (o) => o.tipoOperacion !== 'FUTURO';
  assert.deepEqual(ids(operacionesEnTurno([desconocida, retenida, otra], { soportado })), [otra.operationId]);
});

test('en turno: sin cadena mantiene su bloqueo por animal local y deja salir varias', () => {
  const conflicto = { ...op('x', E.CONFLICTO, { localUuid: 'L' }), claveOrden: undefined };
  const delMismoAnimal = { ...op('x', E.PENDIENTE, { localUuid: 'L' }), claveOrden: undefined };
  const p1 = { ...op('y', E.PENDIENTE), claveOrden: undefined, localUuid: 'M' };
  const p2 = { ...op('y', E.PENDIENTE), claveOrden: undefined, localUuid: 'M' };
  assert.deepEqual(ids(operacionesEnTurno([conflicto, delMismoAnimal, p1, p2])), [p1.operationId, p2.operationId]);
});

/** Entorno con temporizadores manuales y un motor contador. */
function entorno(repo) {
  const temporizadores = new Map();
  let siguiente = 1;
  const registros = [];
  const llamadas = [];
  const engine = {
    syncNow: async ({ motivo }) => { llamadas.push(motivo); await repo.putMeta({ ultimaSyncOk: true }); return 'OK'; },
    getState: () => ({ enCurso: false }),
    proximoReintentoAt: async () => null,
  };
  const manejadores = {};
  const serviceWorker = {
    ready: Promise.resolve({ sync: { register: async (tag) => { registros.push(tag); } } }),
    addEventListener: (tipo, h) => { manejadores[tipo] = h; },
    removeEventListener: () => {},
  };
  const auto = startAutoSync({
    engine, repo, win: null, doc: { visibilityState: 'visible', addEventListener: () => {}, removeEventListener: () => {} }, serviceWorker,
    setTimer: (fn, ms) => { const id = siguiente++; temporizadores.set(id, { fn, ms }); return id; },
    clearTimer: (id) => temporizadores.delete(id),
  });
  /** Ejecuta lo que esté en cola con el retardo corto de los avisos (no el barrido de 5 min). */
  const correr = async (vueltas = 6) => {
    for (let i = 0; i < vueltas; i += 1) {
      await new Promise((r) => setTimeout(r, 0));
      for (const [id, t] of [...temporizadores]) {
        if (t.ms > 60_000) continue;
        temporizadores.delete(id);
        await t.fn();
      }
    }
  };
  return { auto, engine, llamadas, registros, manejadores, correr };
}

const repoCon = async (ops) => {
  const repo = createLocalRepo(createMemoryStorage(ORG_STORES), { organizacionId: ORG, deviceId: 'd', now: () => new Date(AHORA) });
  for (const o of ops) await repo.storage.put('outbox', o);
  return repo;
};

for (const [nombre, ops] of [
  ['pendiente retenida detrás de un conflicto', () => [op('1', E.CONFLICTO), op('1', E.PENDIENTE)]],
  ['pendiente retenida detrás de un bloqueo por identidad', () => [op('1', E.BLOQUEADA_POR_IDENTIDAD), op('1', E.PENDIENTE)]],
  ['pendiente retenida detrás de un backoff', () => [op('1', E.ERROR_REINTENTABLE, { siguienteIntentoAt: '2026-10-20T16:00:00.000Z' }), op('1', E.PENDIENTE)]],
  ['tipo desconocido', () => [op('1', E.PENDIENTE, { tipoOperacion: 'FUTURO' })]],
]) {
  test(`${nombre}: el aviso del pull no vuelve a disparar la sincronización`, async () => {
    const repo = await repoCon(ops());
    const { auto, llamadas, correr } = entorno(repo);
    await auto.primera;
    await correr();
    assert.deepEqual(llamadas, ['apertura'], 'solo el arranque');
    auto.stop();
  });
}

test('una pendiente a la que le toca salir sí dispara', async () => {
  const repo = await repoCon([]);
  const { auto, llamadas, correr } = entorno(repo);
  await auto.primera;
  await repo.putOperacion(op('1', E.PENDIENTE));
  await correr(2);
  assert.ok(llamadas.includes('operacion'));
  auto.stop();
});

test('Background Sync: el disparo que viene del SW no vuelve a registrarse (sin ping-pong)', async () => {
  const repo = await repoCon([op('1', E.ERROR_REINTENTABLE, { siguienteIntentoAt: '2026-10-20T16:00:00.000Z' })]);
  const { auto, registros, manejadores, llamadas } = entorno(repo);
  await auto.primera;
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(registros, [BACKGROUND_SYNC_TAG], 'se registra una vez para cuando el navegador tenga red');
  await auto.trigger('background-sync');
  manejadores.message({ data: { type: 'AGX_SYNC_REQUEST' } });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(registros, [BACKGROUND_SYNC_TAG], 'no se vuelve a registrar');
  assert.equal(llamadas.filter((m) => m === 'background-sync').length, 2);
  auto.stop();
});

test('Background Sync: no se registra por lo que no puede salir', async () => {
  const repo = await repoCon([op('1', E.CONFLICTO), op('1', E.PENDIENTE)]);
  const { auto, registros } = entorno(repo);
  await auto.primera;
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(registros, []);
  auto.stop();
});

test('próximo reintento: una retenida con la fecha vencida no reprograma temporizadores', async () => {
  const repo = await repoCon([
    op('1', E.CONFLICTO),
    op('1', E.ERROR_REINTENTABLE, { siguienteIntentoAt: '2026-10-20T14:00:00.000Z' }),
    op('2', E.ERROR_REINTENTABLE, { siguienteIntentoAt: '2026-10-20T16:00:00.000Z' }),
  ]);
  const motor = createSyncEngine({ repo, transport: {}, now: () => new Date(AHORA) });
  assert.equal(await motor.proximoReintentoAt(), '2026-10-20T16:00:00.000Z');
});
