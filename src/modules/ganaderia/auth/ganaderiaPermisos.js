// FASE 3A -- matriz CENTRAL de capacidades por rol de organización
// (agx.membresias.rol: owner | admin | operador | lector). JS puro, sin
// React: la usan la UI (ocultar acciones), el flujo offline (no encolar lo
// que el rol no puede hacer) y las pruebas.
//
// Es SOLO UX: el backend (server/security/ganaderiaPermisos.js) es la
// autoridad final y responde 403 ROLE_FORBIDDEN. Debe mantenerse alineada
// con esa matriz. El rol sale de la sesión (organizacionActiva.rol); un rol
// desconocido o ausente no puede escribir nada. super_admin es un rol
// INTERNO separado y no otorga capacidades de organización.
//
// Cambio de rol con la UI abierta: el rol se toma de la sesión vigente en
// el contexto de autenticación; cuando la sesión se vuelve a validar con el
// servidor (recarga, login, revalidación del perfil offline) el rol nuevo
// domina. Mientras tanto, cualquier escritura que el rol ya no permita la
// rechaza el backend con 403 ROLE_FORBIDDEN.

export const ROLES_ORGANIZACION = Object.freeze(['owner', 'admin', 'operador', 'lector']);

const OPERACION = Object.freeze(['owner', 'admin', 'operador']);
const ADMINISTRACION = Object.freeze(['owner', 'admin']);

export const CAPACIDADES = Object.freeze({
  // Animales / pesajes / QR
  crearAnimal: OPERACION,
  registrarPesaje: OPERACION,
  asociarQr: OPERACION,
  corregirAnimal: ADMINISTRACION,
  anularAnimal: ADMINISTRACION,
  reemplazarQr: ADMINISTRACION,
  darBajaQr: ADMINISTRACION,
  cerrarAnimal: ADMINISTRACION, // salida / muerte
  // Estructura territorial
  editarPredio: ADMINISTRACION, // crear / archivar / restaurar
  editarPotrero: ADMINISTRACION, // crear / archivar / restaurar / ficha productiva
  // Pastoreo
  operarCiclo: OPERACION, // iniciar / finalizar / residual real / descanso declarado / reingreso
  administrarCiclo: ADMINISTRACION, // corregir / anular / cancelar (ciclo y residual)
  planificarPastoreo: OPERACION, // capacidad / recomendación / descanso planificado / agroclima
  // Catálogos
  crearCatalogoPersonalizado: ADMINISTRACION,
});

export { MENSAJE_ROLE_FORBIDDEN } from './ganaderiaAuthedRequest.js';
export const MENSAJE_OFFLINE_ROLE_FORBIDDEN = 'La operación no se sincronizó porque ya no tienes permisos para realizarla.';

/** true solo si `rol` (exacto, en minúsculas) tiene la capacidad. */
export function puede(rol, capacidad) {
  const roles = CAPACIDADES[capacidad];
  if (!roles) throw new Error(`CAPACIDAD_DESCONOCIDA:${capacidad}`);
  return typeof rol === 'string' && roles.includes(rol);
}

/** Mapa { capacidad: boolean } + soloLectura (ninguna escritura permitida). */
export function capacidadesDe(rol) {
  const caps = {};
  for (const capacidad of Object.keys(CAPACIDADES)) caps[capacidad] = puede(rol, capacidad);
  caps.soloLectura = !Object.keys(CAPACIDADES).some((c) => caps[c]);
  return Object.freeze(caps);
}

export const canCrearAnimal = (rol) => puede(rol, 'crearAnimal');
export const canRegistrarPesaje = (rol) => puede(rol, 'registrarPesaje');
export const canAsociarQr = (rol) => puede(rol, 'asociarQr');
export const canCorregirAnimal = (rol) => puede(rol, 'corregirAnimal');
export const canAnularAnimal = (rol) => puede(rol, 'anularAnimal');
export const canReemplazarQr = (rol) => puede(rol, 'reemplazarQr');
export const canDarBajaQr = (rol) => puede(rol, 'darBajaQr');
export const canCerrarAnimal = (rol) => puede(rol, 'cerrarAnimal');
export const canEditarPredio = (rol) => puede(rol, 'editarPredio');
export const canEditarPotrero = (rol) => puede(rol, 'editarPotrero');
export const canOperarCiclo = (rol) => puede(rol, 'operarCiclo');
export const canAdministrarCiclo = (rol) => puede(rol, 'administrarCiclo');
export const canPlanificarPastoreo = (rol) => puede(rol, 'planificarPastoreo');
export const canCrearCatalogoPersonalizado = (rol) => puede(rol, 'crearCatalogoPersonalizado');

// Operaciones del outbox offline -> capacidad requerida para ENCOLARLAS.
export const CAPACIDAD_OPERACION_OFFLINE = Object.freeze({
  ANIMAL_CREAR: 'crearAnimal',
  ANIMAL_CREAR_CON_CHAPETA: 'crearAnimal',
  PESAJE_CREAR: 'registrarPesaje',
});

/** ¿Puede este rol encolar `tipoOperacion` sin red? Desconocida -> false. */
export function puedeEncolar(rol, tipoOperacion) {
  const capacidad = CAPACIDAD_OPERACION_OFFLINE[tipoOperacion];
  return Boolean(capacidad) && puede(rol, capacidad);
}
