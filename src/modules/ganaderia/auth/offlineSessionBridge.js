// SPRINT-3D11.3 (R1): puente entre la sesión real (GET /auth/session) y el
// modo OFFLINE de Ganadería. La sesión sigue siendo fail-closed:
//   * respuesta del servidor (incluido 5xx del relay)  -> manda el servidor;
//   * SIN respuesta (fallo de red / navigator offline) -> solo si existe un
//     perfil offline vigente de la última sesión validada online (7 días),
//     se abre en modo offline con los datos locales de ESA organización.
// El perfil no contiene secretos (ni cookie, ni CSRF, ni contraseña). Al
// volver la red, el proveedor revalida la sesión contra el servidor.
import { indexedDbDisponible, openDeviceStorage, contarPendientesOrg, borrarBaseOrg } from '../offline/browserOffline.js';
import { cerrarSesionOffline, leerPerfilOffline } from '../offline/offlineSession.js';

export function isNetworkFailure(error, nav = globalThis.navigator) {
  return error instanceof TypeError || nav?.onLine === false;
}

export function buildOfflineSessionPayload(perfil) {
  return {
    authenticated: true,
    offline: true,
    cuenta: perfil.cuenta ?? null,
    tipoAcceso: 'cliente',
    rolInterno: null,
    organizacionActiva: perfil.organizacionActiva,
    organizacionesDisponibles: [perfil.organizacionActiva],
    offlineHasta: perfil.offlineHasta,
  };
}

export async function loadOfflineSession() {
  if (!indexedDbDisponible()) return null;
  try {
    const device = await openDeviceStorage();
    try {
      const perfil = await leerPerfilOffline(device);
      return perfil ? buildOfflineSessionPayload(perfil) : null;
    } finally {
      await device.close();
    }
  } catch {
    return null;
  }
}

/** Cierre de sesión: sin perfil offline; base local purgada si no tiene pendientes. */
export async function clearOfflineSession(organizacionId) {
  if (!indexedDbDisponible()) return;
  try {
    const device = await openDeviceStorage();
    try {
      await cerrarSesionOffline(device, organizacionId ?? null, { contarPendientes: contarPendientesOrg, borrarBase: borrarBaseOrg });
    } finally {
      await device.close();
    }
  } catch {
    // Sin IndexedDB utilizable no hay nada que limpiar.
  }
}
