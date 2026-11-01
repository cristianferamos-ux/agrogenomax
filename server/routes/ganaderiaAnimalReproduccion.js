// FASE 4A -- REPRODUCCIÓN BOVINA. Monta en
// /api/ganaderia/animales/:animalId/reproduccion (server/index.js), ANTES del
// router de animales. Mismo contrato de seguridad que pesajes/cierre: sesión
// obligatoria, CSRF, tenant EXCLUSIVAMENTE de req.ganaderiaAuth
// (organizacionId en el body es FORBIDDEN_FIELDS) y rol de la matriz central
// (ganaderiaPermisos.js) evaluado antes de tocar la base de negocio. Solo
// Postgres-AGX-Business (reproduccionRepository.js); nunca el legacy
// /api/reproduccion (server/routes/reproduccion.js, desmontado).
//
// Un único POST de creación tipado por tipoEvento (validación estricta por
// tipo en reproduccionValidation.js) en vez de 8 rutas por evento: mismas
// invariantes, idempotencia y bloqueos para todos los tipos.
//
//   GET  /                              -> 200 { ok, animalId, sexo, estado, orden, eventos[] }
//   GET  /estado                        -> 200 { ok, animalId, sexo, estado }
//   POST /eventos                       (operación)      -> 201 | 200 yaExistia
//   POST /eventos/:eventoId/anular      (administración) -> 200 (yaExistia true|false)
//   POST /eventos/:eventoId/corregir    (administración) -> 201 | 200 yaExistia
//   400 INVALID_* / FORBIDDEN_FIELDS, 403 ROLE_FORBIDDEN, 404 ANIMAL_NOT_FOUND | EVENTO_NOT_FOUND,
//   409 ANIMAL_ANULADO | ANIMAL_YA_SALIDO | ANIMAL_YA_MUERTO | SEXO_INCOMPATIBLE |
//       FECHA_ANTERIOR_A_HISTORIAL | EVENTO_NO_PERMITIDO_POR_ESTADO | EVENTO_YA_ANULADO |
//       CLIENT_OPERATION_ID_REUSED
import { Router } from 'express';
import { createRequireGanaderiaCsrf, createRequireGanaderiaSession } from '../security/ganaderiaSession.js';
import { createRequireAdministracion, createRequireOperacion } from '../security/ganaderiaPermisos.js';
import { resolveFechaHoraNegocio } from '../services/ganaderia/motorDescansoAuto/businessTimezone.js';
import { isValidPositiveId } from '../services/ganaderia/animalValidation.js';
import {
  validateAnularEventoReproductivoBody,
  validateCorregirEventoReproductivoBody,
  validateCrearEventoReproductivoBody,
} from '../services/ganaderia/reproduccionValidation.js';
import {
  anularEventoReproductivoIdempotente,
  corregirEventoReproductivoIdempotente,
  obtenerEstadoReproductivo,
  obtenerReproduccionAnimal,
  registrarEventoReproductivoIdempotente,
} from '../services/ganaderia/reproduccionRepository.js';

function sendSemanticError(res, error) {
  if (typeof error?.status === 'number' && typeof error?.code === 'string') {
    res.status(error.status).json({ error: error.code, message: error.message });
    return true;
  }
  return false;
}

function withIds(fn, { evento = false } = {}) {
  return async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (!isValidPositiveId(req.params.animalId)) {
        res.status(400).json({ error: 'INVALID_ANIMAL_ID' });
        return;
      }
      if (evento && !isValidPositiveId(req.params.eventoId)) {
        res.status(400).json({ error: 'INVALID_EVENTO_ID' });
        return;
      }
      const { fecha: hoy, hora: horaAhora } = resolveFechaHoraNegocio();
      await fn(req, res, { hoy, horaAhora });
    } catch (error) {
      if (sendSemanticError(res, error)) return;
      next(error);
    }
  };
}

export default function createGanaderiaAnimalReproduccionRouter({
  appEnv,
  csrfServerSecret,
  allowedOrigins,
  repo = {
    obtenerReproduccionAnimal,
    obtenerEstadoReproductivo,
    registrarEventoReproductivoIdempotente,
    anularEventoReproductivoIdempotente,
    corregirEventoReproductivoIdempotente,
  },
} = {}) {
  const router = Router({ mergeParams: true });

  router.use(createRequireGanaderiaSession({ appEnv }));
  router.use(createRequireGanaderiaCsrf({ csrfServerSecret, allowedOrigins }));
  const requireOperacion = createRequireOperacion();
  const requireAdministracion = createRequireAdministracion();

  router.get('/', withIds(async (req, res, { hoy }) => {
    const data = await repo.obtenerReproduccionAnimal(req.ganaderiaAuth.organizacionId, req.params.animalId, { hoy });
    if (!data) {
      res.status(404).json({ error: 'ANIMAL_NOT_FOUND' });
      return;
    }
    res.json({ ok: true, ...data });
  }));

  router.get('/estado', withIds(async (req, res, { hoy }) => {
    const data = await repo.obtenerEstadoReproductivo(req.ganaderiaAuth.organizacionId, req.params.animalId, { hoy });
    if (!data) {
      res.status(404).json({ error: 'ANIMAL_NOT_FOUND' });
      return;
    }
    res.json({ ok: true, ...data });
  }));

  router.post('/eventos', requireOperacion, withIds(async (req, res, { hoy, horaAhora }) => {
    const value = validateCrearEventoReproductivoBody(req.body, { hoy, horaAhora });
    const { organizacionId, cuentaId } = req.ganaderiaAuth;
    const result = await repo.registrarEventoReproductivoIdempotente(organizacionId, req.params.animalId, value, {
      actorCuentaId: cuentaId, hoy,
    });
    res.status(result.yaExistia ? 200 : 201).json({ ok: true, ...result });
  }));

  router.post('/eventos/:eventoId/anular', requireAdministracion, withIds(async (req, res, { hoy }) => {
    const value = validateAnularEventoReproductivoBody(req.body);
    const { organizacionId, cuentaId } = req.ganaderiaAuth;
    const result = await repo.anularEventoReproductivoIdempotente(organizacionId, req.params.animalId, req.params.eventoId, value, {
      actorCuentaId: cuentaId, hoy,
    });
    // Anular no crea un recurso: 200 siempre (yaExistia distingue el reintento).
    res.status(200).json({ ok: true, ...result });
  }, { evento: true }));

  router.post('/eventos/:eventoId/corregir', requireAdministracion, withIds(async (req, res, { hoy, horaAhora }) => {
    const value = validateCorregirEventoReproductivoBody(req.body, { hoy, horaAhora });
    const { organizacionId, cuentaId } = req.ganaderiaAuth;
    const result = await repo.corregirEventoReproductivoIdempotente(organizacionId, req.params.animalId, req.params.eventoId, value, {
      actorCuentaId: cuentaId, hoy,
    });
    res.status(result.yaExistia ? 200 : 201).json({ ok: true, ...result });
  }, { evento: true }));

  return router;
}
