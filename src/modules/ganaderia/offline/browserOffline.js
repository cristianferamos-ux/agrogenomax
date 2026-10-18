// SPRINT-3D11.3 (R1) -- arranque offline en el NAVEGADOR (página o Service
// Worker): abre las bases IndexedDB y construye repo + motor con el
// transporte autenticado compartido (cookie HttpOnly same-origin + CSRF por
// mutación). Sin React. Capacitor/app nativa reemplazaría este archivo.
import { getJsonWithSession, postJsonWithCsrf } from '../auth/ganaderiaAuthedRequest.js';
import { DEVICE_DB_NAME, DEVICE_DB_VERSION, DEVICE_STORES, ORG_DB_VERSION, ORG_STORES, orgDbName } from './offlineSchema.js';
import { createIndexedDbStorage, deleteIndexedDb, openIndexedDb } from './storage.js';
import { createLocalRepo } from './localRepo.js';
import { createSyncEngine } from './syncEngine.js';
import { OUTBOX_ESTADOS } from './outbox.js';
import { RUN_RESULT } from './syncEngine.js';

export const browserTransport = Object.freeze({
  postJson: (path, body) => postJsonWithCsrf(path, body),
  getJson: (path) => getJsonWithSession(path),
});

export function indexedDbDisponible() {
  return typeof indexedDB !== 'undefined';
}

export async function openDeviceStorage() {
  return createIndexedDbStorage(await openIndexedDb(indexedDB, DEVICE_DB_NAME, DEVICE_DB_VERSION, DEVICE_STORES));
}

export async function openOrgStorage(organizacionId) {
  return createIndexedDbStorage(await openIndexedDb(indexedDB, orgDbName(organizacionId), ORG_DB_VERSION, ORG_STORES));
}

/** Pendientes de una organización (para decidir purga), sin dejar la base abierta. */
export async function contarPendientesOrg(organizacionId) {
  const storage = await openOrgStorage(organizacionId);
  try {
    return (await storage.getAll('outbox')).filter((op) => op.estado !== OUTBOX_ESTADOS.SINCRONIZADO).length;
  } finally {
    await storage.close();
  }
}

export function borrarBaseOrg(nombre) {
  return deleteIndexedDb(indexedDB, nombre);
}

/** `navigator.onLine` es optimista (wifi sin Internet): se combina con el último fallo real de red. */
export function isNavigatorOnline() {
  return typeof navigator === 'undefined' ? true : navigator.onLine !== false;
}

export function syncLockName(organizacionId) {
  return `agx-sync-${organizacionId}`;
}

/**
 * FASE-14: sección crítica best-effort entre pestañas y Service Worker del
 * mismo origen (Web Locks API). Disparos automáticos: si otro motor tiene
 * el lock, ceden (EN_CURSO) en lugar de enviar la misma cola en paralelo.
 * Forzados: esperan su turno. Sin `locks` (navegadores antiguos) devuelve
 * null y el motor funciona como antes; la idempotencia del servidor sigue
 * evitando duplicados.
 */
export function createNavigatorLock(nombre, locks = globalThis.navigator?.locks) {
  if (!locks || typeof locks.request !== 'function') return null;
  return (fn, { esperar = false } = {}) => (esperar
    ? locks.request(nombre, () => fn())
    : locks.request(nombre, { ifAvailable: true }, (adquirido) => (adquirido ? fn() : RUN_RESULT.EN_CURSO)));
}

export async function createBrowserOffline({ organizacionId, deviceId, isOnline = isNavigatorOnline }) {
  const storage = await openOrgStorage(organizacionId);
  const repo = createLocalRepo(storage, { organizacionId, deviceId });
  const lock = createNavigatorLock(syncLockName(organizacionId));
  const engine = createSyncEngine({ repo, transport: browserTransport, isOnline, lock });
  return { storage, repo, engine };
}
