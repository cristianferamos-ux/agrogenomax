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
import { createRequireAdministracion, createRequireLectura, createRequireOperacion } from '../security/ganaderiaPermisos.js';
import { resolveFechaHoyNegocio } from '../services/ganaderia/motorDescansoAuto/businessTimezone.js';
import { isValidPositiveId, validateCreateAnimalBody } from '../services/ganaderia/animalValidation.js';
import { isQrToken, normalizeCodigoVisible } from '../services/ganaderia/qrCodigos.js';
import {
  buildQrPendienteClearCookieHeader,
  getQrPendienteTokenFromCookieHeader,
  hasQrPendienteCookie,
} from '../security/qrPendienteCookie.js';
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
 *   NO_OPERATIVA  -> 410 QR_NO_OPERATIVO { estado, animalId? }  (estado controlado)
 * FASE 2B: animalId (vínculo histórico, para "Ver ficha del animal") solo
 * llega si el resolver lo dio, es decir, bajo la organización de la sesión.
 * Este router exige sesión: el acceso público (/qr/:codigo) nunca lo
 * consulta y otra organización recibe 404 QR_NOT_FOUND idéntico.
 */
export function sendResolution(res, resolved) {
  if (!resolved) {
    res.status(404).json({ error: 'QR_NOT_FOUND' });
    return;
  }
  if (resolved.resultado === 'NO_OPERATIVA') {
    const body = { error: 'QR_NO_OPERATIVO', estado: resolved.chapeta.estado };
    if (typeof resolved.animalId === 'string') body.animalId = resolved.animalId;
    res.status(410).json(body);
    return;
  }
  res.json({ ok: true, ...resolved });
}

export function createGanaderiaQrRouter({ appEnv, csrfServerSecret, allowedOrigins } = {}) {
  const router = Router();

  router.use(createRequireGanaderiaSession({ appEnv }));
  router.use(createRequireGanaderiaCsrf({ csrfServerSecret, allowedOrigins }));
  // FASE 3A: RBAC por acción (ver server/security/ganaderiaPermisos.js).
  // El inventario de la organización (GET) es de lectura para todos los roles.
  const requireOperacion = createRequireOperacion();
  const requireLectura = createRequireLectura();

  // FASE 3B: resolución SIN token en la URL. El token llega en el body
  // (escáner del SPA, en memoria) o en la cookie efímera HttpOnly que fija
  // la Pages Function al abrir la chapeta impresa (qrPendienteCookie.js).
  // Misma resolución, mismo tenant y mismas respuestas que GET /token/:token.
  // La cookie se borra en cuanto hay respuesta definitiva (no en 5xx: el
  // usuario puede reintentar sin volver a escanear). Una sola consulta.
  router.post('/resolver', requireLectura, handler(async (req, res) => {
    res.setHeader('Referrer-Policy', 'no-referrer');
    const cookieHeader = req.headers.cookie;
    const traeCookie = hasQrPendienteCookie(cookieHeader, appEnv);
    const clearCookie = () => {
      if (traeCookie) res.append('Set-Cookie', buildQrPendienteClearCookieHeader(appEnv));
    };
    const bodyToken = req.body && typeof req.body === 'object' ? req.body.token : undefined;
    if (bodyToken !== undefined && !isQrToken(bodyToken)) {
      clearCookie();
      res.status(404).json({ error: 'QR_NOT_FOUND' });
      return;
    }
    const token = bodyToken ?? getQrPendienteTokenFromCookieHeader(cookieHeader, appEnv);
    if (!token) {
      clearCookie();
      res.status(404).json({ error: 'QR_PENDIENTE_AUSENTE' });
      return;
    }
    const resolved = await resolverChapeta(req.ganaderiaAuth.organizacionId, { token });
    clearCookie();
    sendResolution(res, resolved);
  }));

  // Compatibilidad (SPA en caché anterior a FASE 3B): el token viaja en la
  // ruta. El SPA vigente usa POST /resolver. Ningún log registra la URL.
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

  router.post('/chapetas/:codigo/registrar-animal', requireOperacion, handler(async (req, res) => {
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
  // FASE 3A: RBAC por acción (ver server/security/ganaderiaPermisos.js).
  const requireAdministracion = createRequireAdministracion();
  const requireOperacion = createRequireOperacion();

  router.get('/', withAnimalId(async (req, res) => {
    const result = await getChapetasDeAnimal(req.ganaderiaAuth.organizacionId, req.params.animalId);
    if (!result) {
      res.status(404).json({ error: 'ANIMAL_NOT_FOUND' });
      return;
    }
    res.json({ ok: true, ...result });
  }));

  router.post('/asociar', requireOperacion, withAnimalId(async (req, res) => {
    const { codigoVisible } = validateAsociarBody(req.body);
    const { organizacionId, cuentaId } = req.ganaderiaAuth;
    const result = await asociarChapetaAAnimal(organizacionId, req.params.animalId, codigoVisible, { actorCuentaId: cuentaId });
    res.status(result.yaExistia ? 200 : 201).json({ ok: true, ...result });
  }));

  router.post('/reemplazar', requireAdministracion, withAnimalId(async (req, res) => {
    const { codigoNuevo, motivo } = validateReemplazarBody(req.body);
    const { organizacionId, cuentaId } = req.ganaderiaAuth;
    const result = await reemplazarChapetaDeAnimal(organizacionId, req.params.animalId, {
      codigoNuevo,
      motivo,
      actorCuentaId: cuentaId,
    });
    res.status(result.yaExistia ? 200 : 201).json({ ok: true, ...result });
  }));

  router.post('/baja', requireAdministracion, withAnimalId(async (req, res) => {
    const { causa, motivo } = validateBajaOrganizacionBody(req.body);
    const { organizacionId, cuentaId } = req.ganaderiaAuth;
    const result = await bajaChapetaDeAnimal(organizacionId, req.params.animalId, { causa, motivo, actorCuentaId: cuentaId });
    res.json({ ok: true, ...result });
  }));

  return router;
}
