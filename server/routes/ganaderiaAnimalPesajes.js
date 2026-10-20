// FASE 1A -- PESAJES POSTERIORES. Monta en
// /api/ganaderia/animales/:animalId/pesajes (server/index.js). Mismo
// contrato de seguridad que ganaderiaAnimales.js: sesión obligatoria, CSRF en
// POST, tenant EXCLUSIVAMENTE de req.ganaderiaAuth (organizacionId en el body
// es FORBIDDEN_FIELDS). Habla solo con Postgres-AGX-Business vía
// pesajesService.js; nunca con el legacy (/api/pesajes sigue desmontado).
//
//   GET  -> 200 { ok, animalId, orden:'ASCENDENTE', resumen, pesajes[] }
//           404 ANIMAL_NOT_FOUND (inexistente o de otra organización)
//   POST -> 201 { ok, yaExistia:false, pesaje } | 200 { ok, yaExistia:true, pesaje }
//           400 INVALID_* / FORBIDDEN_FIELDS, 404 ANIMAL_NOT_FOUND,
//           409 ANIMAL_ANULADO | CLIENT_OPERATION_ID_REUSED
import { Router } from 'express';
import { createRequireGanaderiaCsrf, createRequireGanaderiaSession } from '../security/ganaderiaSession.js';
import { resolveFechaHoyNegocio } from '../services/ganaderia/motorDescansoAuto/businessTimezone.js';
import { isValidPositiveId } from '../services/ganaderia/animalValidation.js';
import { validateCreatePesajeBody } from '../services/ganaderia/pesajeValidation.js';
import { obtenerHistorialPesajes, registrarPesaje } from '../services/ganaderia/pesajesService.js';

function sendSemanticError(res, error) {
  if (typeof error?.status === 'number' && typeof error?.code === 'string') {
    res.status(error.status).json({ error: error.code, message: error.message });
    return true;
  }
  return false;
}

function withAnimalId(fn) {
  return async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (!isValidPositiveId(req.params.animalId)) {
        res.status(400).json({ error: 'INVALID_ANIMAL_ID' });
        return;
      }
      await fn(req, res);
    } catch (error) {
      if (sendSemanticError(res, error)) return;
      next(error);
    }
  };
}

export default function createGanaderiaAnimalPesajesRouter({ appEnv, csrfServerSecret, allowedOrigins } = {}) {
  const router = Router({ mergeParams: true });

  router.use(createRequireGanaderiaSession({ appEnv }));
  router.use(createRequireGanaderiaCsrf({ csrfServerSecret, allowedOrigins }));

  router.get('/', withAnimalId(async (req, res) => {
    const historial = await obtenerHistorialPesajes(req.ganaderiaAuth.organizacionId, req.params.animalId);
    if (!historial) {
      res.status(404).json({ error: 'ANIMAL_NOT_FOUND' });
      return;
    }
    res.json({ ok: true, ...historial });
  }));

  router.post('/', withAnimalId(async (req, res) => {
    const value = validateCreatePesajeBody(req.body, { hoy: resolveFechaHoyNegocio() });
    const { organizacionId, cuentaId } = req.ganaderiaAuth;
    const { pesaje, yaExistia } = await registrarPesaje(organizacionId, req.params.animalId, value, { actorCuentaId: cuentaId });
    res.status(yaExistia ? 200 : 201).json({ ok: true, yaExistia, pesaje });
  }));

  return router;
}
