// CATX-DELIVERY-001: interfaz de almacenamiento intercambiable.
//
// Un adaptador implementa exactamente:
//   put(deliverableId, buffer, { contentType }) -> Promise<{ storageKey }>
//   get(deliverableId) -> Promise<{ bytes, contentType } | null>
//
// Cuando exista un backend real de objetos (Cloudflare R2/S3-compatible),
// se agrega aquí un tercer adaptador con la misma forma -- ningún otro
// archivo del pipeline de entrega necesita cambiar.
import * as postgresBlobStorage from './postgresBlobStorage.js';
import * as localFsStorage from './localFsStorage.js';

const DRIVERS = {
  postgres: postgresBlobStorage,
  'local-dev-only': localFsStorage,
};

/**
 * Resuelve el adaptador de almacenamiento activo según CATASTROX_STORAGE_DRIVER
 * (default 'postgres'). server/config/env.js ya garantiza, en el arranque,
 * que producción nunca puede resolver a 'local-dev-only' -- esta función no
 * repite esa validación (evita una segunda fuente de verdad), pero sí falla
 * de forma clara ante un valor desconocido, por si algo la invoca sin pasar
 * por la validación de arranque (p. ej. una prueba aislada).
 *
 * @param {NodeJS.ProcessEnv} [source]
 */
export function resolveStorageAdapter(source = process.env) {
  const driverName = String(source.CATASTROX_STORAGE_DRIVER || 'postgres').trim();
  const driver = DRIVERS[driverName];

  if (!driver) {
    throw Object.assign(new Error(`CATASTROX_STORAGE_DRIVER desconocido: ${driverName}`), {
      code: 'UNKNOWN_STORAGE_DRIVER',
    });
  }

  if (source.APP_ENV === 'production' && driverName !== 'postgres') {
    // Segunda barrera, redundante a propósito con env.js -- nunca debe
    // alcanzarse en un proceso real (el arranque ya habría fallado), pero
    // un llamador que construya `source` a mano (prueba, script) no debe
    // poder producir escritura a disco efímero en producción por accidente.
    throw Object.assign(
      new Error('CATASTROX_STORAGE_DRIVER=local-dev-only no está permitido en producción.'),
      { code: 'STORAGE_DRIVER_NOT_ALLOWED_IN_PRODUCTION' },
    );
  }

  return driver;
}
