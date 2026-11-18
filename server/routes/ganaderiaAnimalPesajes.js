// FASE 1A / FASE 5A.1b -- PESAJES. Monta en
// /api/ganaderia/animales/:animalId/pesajes (server/index.js). Mismo
// contrato de seguridad que ganaderiaAnimales.js: sesión obligatoria, CSRF en
// POST, tenant EXCLUSIVAMENTE de req.ganaderiaAuth (organizacionId en el body
// es FORBIDDEN_FIELDS). Habla solo con Postgres-AGX-Business vía
// pesajesService.js; nunca con el legacy (/api/pesajes sigue desmontado).
//
//   GET  /                    -> 200 { ok, animalId, orden:'ASCENDENTE', resumen, pesajes[], historial[] }
//                                pesajes = solo ACTIVOS (semántica histórica); historial = ACTIVOS + ANULADOS;
//                                resumen = serie diaria ACTIVA. 404 ANIMAL_NOT_FOUND.
//   POST /                    (operación) -> 201 { ok, yaExistia:false, pesaje } | 200 { ok, yaExistia:true, pesaje }
//                                400 INVALID_* / FORBIDDEN_FIELDS / FECHA_ANTERIOR_A_NACIMIENTO / FECHA_ANTERIOR_A_INGRESO,
//                                404 ANIMAL_NOT_FOUND, 409 ANIMAL_ANULADO | ANIMAL_YA_* | CLIENT_OPERATION_ID_REUSED
//   POST /:pesajeId/anular    (administración: owner/admin) -> 200 { ok, yaExistia, pesaje, resumen }
//                                400 INVALID_* / FORBIDDEN_FIELDS, 403 ROLE_FORBIDDEN,
//                                404 ANIMAL_NOT_FOUND | PESAJE_NOT_FOUND,
//                                409 IDENTIDAD_NO_COINCIDE | ANIMAL_ANULADO | PESAJE_YA_ANULADO | CLIENT_OPERATION_ID_REUSED
//
// Ambos POST admiten `identidadEsperada` opcional (FASE 5A.3 offline), con el
// mismo middleware y orden que reproducción: rol -> identidad -> ids ->
// validación. El actor y el instante de la anulación salen SIEMPRE de la
// sesión y de Postgres, nunca del cuerpo.
import { Router } from 'express';
import { createRequireGanaderiaCsrf, createRequireGanaderiaSession } from '../security/ganaderiaSession.js';
import { createRequireAdministracion, createRequireOperacion } from '../security/ganaderiaPermisos.js';
import { requireIdentidadEsperada } from '../security/identidadEsperada.js';
import { resolveFechaHoyNegocio } from '../services/ganaderia/motorDescansoAuto/businessTimezone.js';
import { isValidPositiveId } from '../services/ganaderia/animalValidation.js';
import { validateAnularPesajeBody, validateCreatePesajeBody } from '../services/ganaderia/pesajeValidation.js';
import { anularPesaje, obtenerHistorialPesajes, registrarPesaje } from '../services/ganaderia/pesajesService.js';

function sendSemanticError(res, error) {
  if (typeof error?.status === 'number' && typeof error?.code === 'string') {
    res.status(error.status).json({ error: error.code, message: error.message });
    return true;
  }
  return false;
}

function withAnimalId(fn, { pesaje = false } = {}) {
  return async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (!isValidPositiveId(req.params.animalId)) {
        res.status(400).json({ error: 'INVALID_ANIMAL_ID' });
        return;
      }
      if (pesaje && !isValidPositiveId(req.params.pesajeId)) {
        res.status(400).json({ error: 'INVALID_PESAJE_ID' });
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
  // FASE 3A: RBAC por acción (ver server/security/ganaderiaPermisos.js).
  const requireOperacion = createRequireOperacion();
  const requireAdministracion = createRequireAdministracion();

  router.get('/', withAnimalId(async (req, res) => {
    const historial = await obtenerHistorialPesajes(req.ganaderiaAuth.organizacionId, req.params.animalId);
    if (!historial) {
      res.status(404).json({ error: 'ANIMAL_NOT_FOUND' });
      return;
    }
    res.json({ ok: true, ...historial });
  }));

  router.post('/', requireOperacion, requireIdentidadEsperada, withAnimalId(async (req, res) => {
    const value = validateCreatePesajeBody(req.body, { hoy: resolveFechaHoyNegocio() });
    const { organizacionId, cuentaId } = req.ganaderiaAuth;
    const { pesaje, yaExistia } = await registrarPesaje(organizacionId, req.params.animalId, value, { actorCuentaId: cuentaId });
    res.status(yaExistia ? 200 : 201).json({ ok: true, yaExistia, pesaje });
  }));

  router.post('/:pesajeId/anular', requireAdministracion, requireIdentidadEsperada, withAnimalId(async (req, res) => {
    const value = validateAnularPesajeBody(req.body);
    const { organizacionId, cuentaId } = req.ganaderiaAuth;
    const { pesaje, resumen, yaExistia } = await anularPesaje(organizacionId, req.params.animalId, req.params.pesajeId, value, { actorCuentaId: cuentaId });
    res.status(200).json({ ok: true, yaExistia, pesaje, resumen });
  }, { pesaje: true }));

  return router;
}
