// FASE 3A: matriz RBAC central del módulo Ganadería (roles de membresía de
// organización, agx.membresias.rol). El rol SIEMPRE se lee de
// req.ganaderiaAuth.rol, resuelto server-side por createRequireGanaderiaSession
// (fn_resolver_autorizacion_sesion) -- nunca de body/query/header del cliente.
//
// Orden esperado en cada router: sesión (organización) -> CSRF -> rol -> handler.
// El rol se evalúa ANTES de tocar la base de negocio, así un rol sin permiso
// recibe 403 ROLE_FORBIDDEN sin revelar si el recurso (de su tenant o de otro)
// existe. super_admin es un rol INTERNO (agx.staff_crh) separado: no aparece
// aquí y no otorga permisos de organización.
import { createRequireGanaderiaRole } from './ganaderiaSession.js';

export const ROLES_ORGANIZACION = Object.freeze(['owner', 'admin', 'operador', 'lector']);

// Lectura general: animales, pesajes, timeline, PDF, QR, predios, potreros,
// ciclos, catálogos, inventario QR de la organización.
export const ROLES_LECTURA = ROLES_ORGANIZACION;
// Operación cotidiana: crear animal, pesaje, asociar QR, registrar animal vía
// QR, iniciar/finalizar ciclo, residual real, planificación de pastoreo.
export const ROLES_OPERACION = Object.freeze(['owner', 'admin', 'operador']);
// Administración: corregir/anular animal, reemplazar/baja QR, salida/muerte,
// estructura de predios/potreros, corregir/anular/cancelar ciclos, catálogos.
export const ROLES_ADMINISTRACION = Object.freeze(['owner', 'admin']);

export function createRequireOperacion() {
  return createRequireGanaderiaRole(...ROLES_OPERACION);
}

export function createRequireAdministracion() {
  return createRequireGanaderiaRole(...ROLES_ADMINISTRACION);
}
