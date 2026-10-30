// FASE 2A -- CIERRE OPERATIVO DEL ANIMAL. La misma fábrica se monta dos veces
// (server/index.js), ANTES del router de animales:
//   POST /api/ganaderia/animales/:animalId/salida  (tipo SALIDA)
//   POST /api/ganaderia/animales/:animalId/muerte  (tipo MUERTE)
// Endpoints explícitos (no un POST /estado genérico): salida y muerte tienen
// semánticas y catálogos distintos. Sesión obligatoria, CSRF, tenant
// EXCLUSIVAMENTE de req.ganaderiaAuth (organizacionId en el body es
// FORBIDDEN_FIELDS). Solo Postgres-AGX-Business (cierreRepository.js).
//
// FASE 2B -- RBAC: solo owner/admin de la organización activa registran
// cierres. createRequireGanaderiaRole va DESPUÉS de la sesión (que resuelve
// el rol server-side desde agx.membresias); operador/lector -> 403
// ROLE_FORBIDDEN sin tocar la base de negocio. El resto del módulo no cambia.
//
//   201 { ok, yaExistia:false, animal, evento } | 200 { ok, yaExistia:true, animal, evento }
//   400 INVALID_* / FORBIDDEN_FIELDS, 403 ROLE_FORBIDDEN, 404 ANIMAL_NOT_FOUND,
//   409 ANIMAL_ANULADO | ANIMAL_YA_SALIDO | ANIMAL_YA_MUERTO | CLIENT_OPERATION_ID_REUSED
import { Router } from 'express';
import {
  createRequireGanaderiaCsrf,
  createRequireGanaderiaRole,
  createRequireGanaderiaSession,
} from '../security/ganaderiaSession.js';
import { resolveFechaHoyNegocio } from '../services/ganaderia/motorDescansoAuto/businessTimezone.js';
import { isValidPositiveId } from '../services/ganaderia/animalValidation.js';
import { TIPOS_CIERRE, validateCierreBody } from '../services/ganaderia/cierreValidation.js';
import { registrarCierreIdempotente } from '../services/ganaderia/cierreRepository.js';

// Roles de membresía (agx.membresias.rol) autorizados a cerrar un animal.
export const ROLES_CIERRE = Object.freeze(['owner', 'admin']);

function sendSemanticError(res, error) {
  if (typeof error?.status === 'number' && typeof error?.code === 'string') {
    res.status(error.status).json({ error: error.code, message: error.message });
    return true;
  }
  return false;
}

export default function createGanaderiaAnimalCierreRouter({
  tipo,
  appEnv,
  csrfServerSecret,
  allowedOrigins,
  registrarCierre = registrarCierreIdempotente,
} = {}) {
  if (!TIPOS_CIERRE[tipo]) throw new Error(`Tipo de cierre desconocido: ${tipo}`);
  const router = Router({ mergeParams: true });

  router.use(createRequireGanaderiaSession({ appEnv }));
  router.use(createRequireGanaderiaCsrf({ csrfServerSecret, allowedOrigins }));
  router.use(createRequireGanaderiaRole(...ROLES_CIERRE));

  router.post('/', async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (!isValidPositiveId(req.params.animalId)) {
        res.status(400).json({ error: 'INVALID_ANIMAL_ID' });
        return;
      }
      const value = validateCierreBody(tipo, req.body, { hoy: resolveFechaHoyNegocio() });
      const { organizacionId, cuentaId } = req.ganaderiaAuth;
      const { animal, evento, yaExistia } = await registrarCierre(organizacionId, req.params.animalId, value, {
        actorCuentaId: cuentaId,
      });
      res.status(yaExistia ? 200 : 201).json({ ok: true, yaExistia, animal, evento });
    } catch (error) {
      if (sendSemanticError(res, error)) return;
      next(error);
    }
  });

  return router;
}
