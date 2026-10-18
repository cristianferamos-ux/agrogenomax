// SPRINT-3D11.3 (R1) -- punto de entrada del PUSH en el Service Worker
// (Background Sync con la PWA sin páginas abiertas). Se empaqueta como IIFE
// en dist/agx-offline-sync.js (vite.agx-offline.js) y el SW lo carga con
// importScripts. Usa el MISMO motor, repositorio y outbox que la página.
//
// Límites reales: el navegador decide cuándo despertar al SW (Chromium:
// Android/escritorio con Background Sync; Safari/iOS y Firefox no lo
// implementan). Si el sistema no despierta al SW, la sincronización ocurre
// al volver a abrir la app (los demás disparadores de autoSync.js).
import { DEVICE_DB_NAME, DEVICE_DB_VERSION, DEVICE_STORES, ORG_DB_VERSION, ORG_STORES, orgDbName } from './offlineSchema.js';
import { createIndexedDbStorage, openIndexedDb } from './storage.js';
import { createLocalRepo } from './localRepo.js';
import { createSyncEngine } from './syncEngine.js';
import { leerPerfilOffline } from './offlineSession.js';
import { browserTransport, createNavigatorLock, syncLockName } from './browserOffline.js';

export async function pushDesdeServiceWorker() {
  const device = createIndexedDbStorage(await openIndexedDb(indexedDB, DEVICE_DB_NAME, DEVICE_DB_VERSION, DEVICE_STORES));
  try {
    const perfil = await leerPerfilOffline(device);
    const dispositivo = await device.get('dispositivo', 'dispositivo');
    if (!perfil || !dispositivo?.deviceId) return 'SIN_PERFIL';
    const storage = createIndexedDbStorage(await openIndexedDb(indexedDB, orgDbName(perfil.organizacionId), ORG_DB_VERSION, ORG_STORES));
    try {
      const repo = createLocalRepo(storage, { organizacionId: perfil.organizacionId, deviceId: dispositivo.deviceId });
      // `self.navigator.onLine` solo descarta lo evidente: si miente, el
      // envío falla como fallo de RED y no suma intento ni backoff. El mismo
      // lock por organización que la página (Web Locks también existe en el
      // SW de Chromium); sin él, la idempotencia del servidor protege.
      const engine = createSyncEngine({
        repo,
        transport: browserTransport,
        isOnline: () => self.navigator?.onLine !== false,
        lock: createNavigatorLock(syncLockName(perfil.organizacionId), self.navigator?.locks),
      });
      return await engine.syncNow({ motivo: 'background-sync' });
    } finally {
      await storage.close();
    }
  } finally {
    await device.close();
  }
}
