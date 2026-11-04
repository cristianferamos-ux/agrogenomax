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
import { browserTransport, createNavigatorLock, esBaseMasNueva, syncLockName } from './browserOffline.js';

// FASE 4E.1: el SW no espera indefinidamente un upgrade que otra pestaña impide.
const SW_ESPERA_BLOQUEO_MS = 10_000;

async function abrirBaseOrganizacion(organizacionId) {
  try {
    return createIndexedDbStorage(await openIndexedDb(indexedDB, orgDbName(organizacionId), ORG_DB_VERSION, ORG_STORES, { esperaBloqueoMs: SW_ESPERA_BLOQUEO_MS }));
  } catch (error) {
    // Upgrade impedido o base más nueva que este bundle: no se toca nada y la
    // sincronización queda para la página. Nunca se reintenta en bucle.
    if (error?.code === 'IDB_BLOQUEADA' || esBaseMasNueva(error)) return null;
    throw error;
  }
}

export async function pushDesdeServiceWorker() {
  const device = createIndexedDbStorage(await openIndexedDb(indexedDB, DEVICE_DB_NAME, DEVICE_DB_VERSION, DEVICE_STORES));
  try {
    const perfil = await leerPerfilOffline(device);
    const dispositivo = await device.get('dispositivo', 'dispositivo');
    if (!perfil || !dispositivo?.deviceId) return 'SIN_PERFIL';
    const storage = await abrirBaseOrganizacion(perfil.organizacionId);
    if (!storage) return 'BASE_NO_DISPONIBLE';
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
