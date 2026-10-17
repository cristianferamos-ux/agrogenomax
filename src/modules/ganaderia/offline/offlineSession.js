// SPRINT-3D11.3 (R1) -- identidad del dispositivo, perfil offline y
// aislamiento de datos entre organizaciones. JS puro sobre un adaptador de
// almacenamiento del DISPOSITIVO (sin datos de negocio).
//
// Perfil offline: copia NO secreta de la última sesión validada ONLINE
// (cuenta + organización activa). Permite abrir Ganadería sin red con los
// datos locales de ESA organización. Caduca a los 7 días sin validar la
// sesión con el servidor (OFFLINE_VALIDEZ_MS); nunca guarda cookie, CSRF ni
// contraseña. Super Admin nunca obtiene perfil offline.
//
// Organizaciones: una base local por organización. Al activar otra
// organización (o cerrar sesión) las bases de las demás se PURGAN si no
// tienen cambios pendientes; si los tienen se conservan aisladas e
// inaccesibles desde la interfaz (solo se abre la base de la organización
// de la sesión) hasta que esa organización vuelva a iniciar sesión.
import { orgDbName } from './offlineSchema.js';

export const OFFLINE_VALIDEZ_MS = 7 * 24 * 60 * 60 * 1000;

export async function getOrCreateDeviceId(deviceStorage, uuid = () => globalThis.crypto.randomUUID()) {
  const existente = await deviceStorage.get('dispositivo', 'dispositivo');
  if (existente?.deviceId) return existente.deviceId;
  const deviceId = uuid();
  await deviceStorage.put('dispositivo', { key: 'dispositivo', deviceId, creadoAt: new Date().toISOString() });
  return deviceId;
}

/** Tras una sesión ONLINE válida de cliente con organización. */
export async function guardarPerfilOffline(deviceStorage, { cuenta, organizacionActiva, rolInterno }, now = new Date()) {
  if (rolInterno || !organizacionActiva?.organizacionId) return null;
  const perfil = {
    key: 'perfil',
    organizacionId: organizacionActiva.organizacionId,
    organizacionActiva: { ...organizacionActiva },
    cuenta: cuenta ? { cuentaId: cuenta.cuentaId ?? null, email: cuenta.email ?? null, nombre: cuenta.nombre ?? null } : null,
    validadoAt: now.toISOString(),
    offlineHasta: new Date(now.getTime() + OFFLINE_VALIDEZ_MS).toISOString(),
  };
  await deviceStorage.put('dispositivo', perfil);
  return perfil;
}

export async function leerPerfilOffline(deviceStorage, now = new Date()) {
  const perfil = await deviceStorage.get('dispositivo', 'perfil');
  if (!perfil?.organizacionId || !perfil.offlineHasta) return null;
  return perfil.offlineHasta > now.toISOString() ? perfil : null;
}

export async function borrarPerfilOffline(deviceStorage) {
  await deviceStorage.delete('dispositivo', 'perfil');
}

async function organizacionesConocidas(deviceStorage) {
  return (await deviceStorage.get('dispositivo', 'organizaciones'))?.ids ?? [];
}

/**
 * Activa la base de `organizacionId` y purga las de otras organizaciones
 * sin cambios pendientes. `contarPendientes(orgId)` y `borrarBase(nombre)`
 * los aporta el entorno (IndexedDB en el navegador; memoria en pruebas).
 * Devuelve las organizaciones conservadas por tener pendientes.
 */
export async function activarOrganizacion(deviceStorage, organizacionId, { contarPendientes, borrarBase }) {
  orgDbName(organizacionId);
  const conocidas = await organizacionesConocidas(deviceStorage);
  const conservadas = [];
  for (const otra of conocidas) {
    if (otra === organizacionId) continue;
    if ((await contarPendientes(otra)) > 0) {
      conservadas.push(otra);
      continue;
    }
    await borrarBase(orgDbName(otra));
  }
  await deviceStorage.put('dispositivo', { key: 'organizaciones', ids: [...new Set([...conservadas, organizacionId])] });
  return { conservadas };
}

/** Cierre de sesión: sin perfil offline; la base se purga si no tiene pendientes. */
export async function cerrarSesionOffline(deviceStorage, organizacionId, { contarPendientes, borrarBase }) {
  await borrarPerfilOffline(deviceStorage);
  if (!organizacionId) return { conservada: false };
  const pendientes = await contarPendientes(organizacionId);
  if (pendientes > 0) return { conservada: true, pendientes };
  await borrarBase(orgDbName(organizacionId));
  const restantes = (await organizacionesConocidas(deviceStorage)).filter((id) => id !== organizacionId);
  await deviceStorage.put('dispositivo', { key: 'organizaciones', ids: restantes });
  return { conservada: false };
}
