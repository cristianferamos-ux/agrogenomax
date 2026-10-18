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

export async function createBrowserOffline({ organizacionId, deviceId, isOnline = isNavigatorOnline }) {
  const storage = await openOrgStorage(organizacionId);
  const repo = createLocalRepo(storage, { organizacionId, deviceId });
  const engine = createSyncEngine({ repo, transport: browserTransport, isOnline });
  return { storage, repo, engine };
}
