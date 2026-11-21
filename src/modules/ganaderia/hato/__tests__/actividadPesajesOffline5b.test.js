// FASE 5B -- Actividad y outbox de pesajes (repositorio local REAL en memoria).
// La Actividad solo pinta hechos del servidor (GET /timeline): las operaciones
// pendientes (CREATE / ANULAR), canceladas o bloqueadas nunca son auditoría.
// Su desaparición del outbox solo dispara la relectura del servidor.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ORG_STORES } from '../../offline/offlineSchema.js';
import { createMemoryStorage } from '../../offline/storage.js';
import { createLocalRepo } from '../../offline/localRepo.js';
import { OUTBOX_ESTADOS } from '../../offline/outbox.js';
import { huboConfirmaciones, idsOperacionesPesaje } from '../pesajesOfflineModel.js';
import { estadoActividad } from '../actividadModel.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const CUENTA = 'aaaaaaaa-0000-4000-8000-000000000001';
const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function contadorUuid() {
  let n = 0;
  return () => `ffffffff-0000-4000-8000-${String(++n).padStart(12, '0')}`;
}

const fila = (f) => ({
  organizacionId: ORG, animalId: '7', metodo: 'BASCULA', origen: 'MANUAL', observaciones: null, createdAt: '2026-10-21T13:15:00.000Z',
  estadoRegistro: 'ACTIVO', anulacion: null, clientOperationId: ID(1), anulacionClientOperationId: null, ...f,
});

async function dispositivo() {
  const storage = createMemoryStorage(ORG_STORES);
  const repo = createLocalRepo(storage, { organizacionId: ORG, deviceId: 'd-1', now: () => new Date('2026-11-21T15:00:00.000Z'), uuid: contadorUuid() });
  await storage.put('animales', { key: 'srv:7', animalId: '7' });
  const filas = [fila({ pesajeId: '3', fecha: '2026-10-20', pesoKg: 360 })];
  await repo.aplicarPullPesajes({
    ok: true, pesajes: filas, hayMas: false, completo: true, cursorSiguiente: 'c-1',
    totales: { pesajes: 1, anulados: 0 }, organizacionId: ORG, cuentaId: CUENTA,
  });
  return { storage, repo };
}

const anular = (repo, n = 50) => repo.encolarAnulacionPesaje({ animalId: '7', pesajeId: '3', motivo: 'Duplicado', cuentaId: CUENTA, rol: 'owner', clientOperationId: ID(n) });

// Respuesta del servidor ANTES de confirmar la anulación: solo el registro.
const servidorAntes = { ok: true, status: 200, data: { eventos: [{ id: 'pesaje:3', tipo: 'PESAJE_REGISTRADO', datos: { vigente: true } }], total: 1, truncado: false } };

test('5B.15 ANULAR pendiente: visible como operación local, nunca como PESAJE_ANULADO confirmado', async () => {
  const { repo } = await dispositivo();
  await anular(repo);
  const lectura = await repo.leerPesajesLocales('7');
  assert.equal(lectura.anulaciones.length, 1);
  assert.equal(idsOperacionesPesaje(lectura).size, 1, 'la Actividad la vigila para refrescar');
  // Lo que pinta la Actividad sale SOLO del servidor: la pendiente no aparece.
  const estado = estadoActividad(servidorAntes);
  assert.deepEqual(estado.eventos.map((e) => e.tipo), ['PESAJE_REGISTRADO']);
  const confirmado = lectura.confirmados.find((p) => p.pesajeId === '3');
  assert.equal(confirmado.estadoRegistro, 'ACTIVO', 'la copia local confirmada no cambia por una anulación pendiente');
});

test('5B ANULAR offline confirmada por el motor -> desaparece del outbox -> la Actividad se refresca', async () => {
  const { repo, storage } = await dispositivo();
  await anular(repo);
  const antes = idsOperacionesPesaje(await repo.leerPesajesLocales('7'));
  const [op] = (await storage.getAll('outbox')).filter((o) => o.tipoOperacion === 'PESAJE_ANULAR');
  await repo.confirmarAnulacionPesaje(op, {
    ...fila({ pesajeId: '3', fecha: '2026-10-20', pesoKg: 360 }),
    estadoRegistro: 'ANULADO',
    anulacion: { anuladoEn: '2026-11-21T15:00:00.000Z', motivo: 'Duplicado' },
  });
  const despues = idsOperacionesPesaje(await repo.leerPesajesLocales('7'));
  assert.equal(despues.size, 0);
  assert.equal(huboConfirmaciones(antes, despues), true, 'dispara la relectura del GET /timeline');
});

test('5B.14 cancelación segura de una ANULAR nunca enviada: no genera hecho (solo relee el servidor)', async () => {
  const { repo } = await dispositivo();
  await anular(repo);
  const lectura = await repo.leerPesajesLocales('7');
  const [pendiente] = lectura.anulaciones;
  assert.equal(pendiente.cancelableSeguro, true);
  await repo.cancelarAnulacionPesajePendiente(pendiente.localOperationId, { cuentaId: CUENTA });
  const despues = await repo.leerPesajesLocales('7');
  assert.equal(despues.anulaciones.length, 0);
  assert.equal(despues.confirmados.find((p) => p.pesajeId === '3').estadoRegistro, 'ACTIVO', 'ningún hecho local de anulación');
  // La relectura del servidor devuelve lo mismo: no existe PESAJE_ANULADO.
  assert.ok(!estadoActividad(servidorAntes).eventos.some((e) => e.tipo === 'PESAJE_ANULADO'));
});

test('5B.13 CREATE pendiente / cancelado / bloqueado: nunca entra en la Actividad', async () => {
  const { repo, storage } = await dispositivo();
  await repo.registrarPesajeLocal({ animalId: '7', body: { fecha: '2026-11-20', pesoKg: 370, metodo: 'BASCULA', clientOperationId: ID(60) }, cuentaId: CUENTA });
  const lectura = await repo.leerPesajesLocales('7');
  assert.equal(lectura.pendientes.length, 1);
  assert.equal(idsOperacionesPesaje(lectura).size, 1);
  const [op] = (await storage.getAll('outbox')).filter((o) => o.tipoOperacion === 'PESAJE_CREAR');
  await repo.marcarOperacionBloqueada(op, { estado: OUTBOX_ESTADOS.RECHAZADO, codigo: 'X', mensaje: 'x', status: 422 });
  assert.equal((await repo.leerPesajesLocales('7')).pendientes.length, 1, 'bloqueada: sigue siendo local, no un hecho');
  assert.deepEqual(estadoActividad(servidorAntes).eventos.map((e) => e.id), ['pesaje:3']);
});
