// SPRINT-3D11.3 (R1) -- uso de chapetas QR por la organización. Dos
// routers sobre Postgres-AGX-Business (qrChapetasRepository.js), con
// sesión + organización + CSRF:
//   /api/ganaderia/qr                     resolver (token o código), mis chapetas,
//                                         registrar animal con chapeta
//   /api/ganaderia/animales/:animalId/qr  chapeta del animal: ver, asociar,
//                                         reemplazar, dar de baja
// La organización nunca genera chapetas ni ve el stock central. Nunca
// reactiva /api/qr ni /api/animales legacy. Chapeta inexistente, de otra
// organización o del stock central -> 404 QR_NOT_FOUND idéntico.
import { Router } from 'express';
import {
  createRequireGanaderiaSession,
  createRequireGanaderiaCsrf,
} from '../security/ganaderiaSession.js';
import { resolveFechaHoyNegocio } from '../services/ganaderia/motorDescansoAuto/businessTimezone.js';
import { isValidPositiveId, validateCreateAnimalBody } from '../services/ganaderia/animalValidation.js';
import { isQrToken, normalizeCodigoVisible } from '../services/ganaderia/qrCodigos.js';
import {
  requireCodigoVisible,
  validateAsociarBody,
  validateBajaOrganizacionBody,
  validateListChapetasQuery,
  validateReemplazarBody,
} from '../services/ganaderia/qrValidation.js';
import {
  asociarChapetaAAnimal,
  bajaChapetaDeAnimal,
  getChapetasDeAnimal,
  listChapetasOrganizacion,
  reemplazarChapetaDeAnimal,
  registrarAnimalConChapeta,
  resolverChapeta,
} from '../services/ganaderia/qrChapetasRepository.js';

function sendSemanticError(res, error) {
  if (typeof error?.status === 'number' && typeof error?.code === 'string') {
    const body = { error: error.code, message: error.message };
    if (typeof error.estado === 'string') body.estado = error.estado;
    res.status(error.status).json(body);
    return true;
  }
  return false;
}

function handler(fn) {
  return async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      await fn(req, res);
    } catch (error) {
      if (sendSemanticError(res, error)) return;
      next(error);
    }
  };
}

function withAnimalId(fn) {
  return handler(async (req, res) => {
    if (!isValidPositiveId(req.params.animalId)) {
      res.status(400).json({ error: 'INVALID_ANIMAL_ID' });
      return;
    }
    await fn(req, res);
  });
}

/**
 * Resultado de resolverChapeta -> respuesta HTTP:
 *   null          -> 404 QR_NOT_FOUND
 *   DISPONIBLE    -> 200 { resultado: 'DISPONIBLE', chapeta }   (abrir registro)
 *   ANIMAL        -> 200 { resultado: 'ANIMAL', animalId, chapeta } (abrir ficha)
 *   NO_OPERATIVA  -> 410 QR_NO_OPERATIVO { estado }             (estado controlado)
 */
export function sendResolution(res, resolved) {
  if (!resolved) {
    res.status(404).json({ error: 'QR_NOT_FOUND' });
    return;
  }
  if (resolved.resultado === 'NO_OPERATIVA') {
    res.status(410).json({ error: 'QR_NO_OPERATIVO', estado: resolved.chapeta.estado });
    return;
  }
  res.json({ ok: true, ...resolved });
}

export function createGanaderiaQrRouter({ appEnv, csrfServerSecret, allowedOrigins } = {}) {
  const router = Router();

  router.use(createRequireGanaderiaSession({ appEnv }));
  router.use(createRequireGanaderiaCsrf({ csrfServerSecret, allowedOrigins }));

  router.get('/token/:token', handler(async (req, res) => {
    res.setHeader('Referrer-Policy', 'no-referrer');
    const { token } = req.params;
    if (!isQrToken(token)) {
      res.status(404).json({ error: 'QR_NOT_FOUND' });
      return;
    }
    sendResolution(res, await resolverChapeta(req.ganaderiaAuth.organizacionId, { token }));
  }));

  router.get('/codigo/:codigo', handler(async (req, res) => {
    const codigoVisible = normalizeCodigoVisible(req.params.codigo);
    if (!codigoVisible) {
      res.status(404).json({ error: 'QR_NOT_FOUND' });
      return;
    }
    sendResolution(res, await resolverChapeta(req.ganaderiaAuth.organizacionId, { codigoVisible }));
  }));

  router.get('/chapetas', handler(async (req, res) => {
    const filtros = validateListChapetasQuery(req.query);
    const result = await listChapetasOrganizacion(req.ganaderiaAuth.organizacionId, filtros);
    res.json({ ok: true, ...result, limit: filtros.limit, offset: filtros.offset });
  }));

  router.post('/chapetas/:codigo/registrar-animal', handler(async (req, res) => {
    const codigoVisible = requireCodigoVisible(req.params.codigo);
    const value = validateCreateAnimalBody(req.body, { hoy: resolveFechaHoyNegocio() });
    const { organizacionId, cuentaId } = req.ganaderiaAuth;
    const { animal, chapeta, yaExistia } = await registrarAnimalConChapeta(organizacionId, codigoVisible, value, {
      actorCuentaId: cuentaId,
    });
    res.status(yaExistia ? 200 : 201).json({ ok: true, yaExistia, animal, chapeta });
  }));

  return router;
}

export function createGanaderiaAnimalQrRouter({ appEnv, csrfServerSecret, allowedOrigins } = {}) {
  const router = Router({ mergeParams: true });

  router.use(createRequireGanaderiaSession({ appEnv }));
  router.use(createRequireGanaderiaCsrf({ csrfServerSecret, allowedOrigins }));

  router.get('/', withAnimalId(async (req, res) => {
    const result = await getChapetasDeAnimal(req.ganaderiaAuth.organizacionId, req.params.animalId);
    if (!result) {
      res.status(404).json({ error: 'ANIMAL_NOT_FOUND' });
      return;
    }
    res.json({ ok: true, ...result });
  }));

  router.post('/asociar', withAnimalId(async (req, res) => {
    const { codigoVisible } = validateAsociarBody(req.body);
    const { organizacionId, cuentaId } = req.ganaderiaAuth;
    const result = await asociarChapetaAAnimal(organizacionId, req.params.animalId, codigoVisible, { actorCuentaId: cuentaId });
    res.status(result.yaExistia ? 200 : 201).json({ ok: true, ...result });
  }));

  router.post('/reemplazar', withAnimalId(async (req, res) => {
    const { codigoNuevo, motivo } = validateReemplazarBody(req.body);
    const { organizacionId, cuentaId } = req.ganaderiaAuth;
    const result = await reemplazarChapetaDeAnimal(organizacionId, req.params.animalId, {
      codigoNuevo,
      motivo,
      actorCuentaId: cuentaId,
    });
    res.status(result.yaExistia ? 200 : 201).json({ ok: true, ...result });
  }));

  router.post('/baja', withAnimalId(async (req, res) => {
    const { causa, motivo } = validateBajaOrganizacionBody(req.body);
    const { organizacionId, cuentaId } = req.ganaderiaAuth;
    const result = await bajaChapetaDeAnimal(organizacionId, req.params.animalId, { causa, motivo, actorCuentaId: cuentaId });
    res.json({ ok: true, ...result });
  }));

  return router;
}
