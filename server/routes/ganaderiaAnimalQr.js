// SPRINT-3D11.3 (R1) -- QR seguro del animal. Dos routers sobre
// Postgres-AGX-Business (animalQrRepository.js):
//   /api/ganaderia/animales/:animalId/qr  -> ver / asignar / revocar / reemplazar
//   /api/ganaderia/qr                      -> resolver token -> animal
// Sesión con organización + CSRF en ambos. Nunca reactiva /api/qr ni
// /api/animales legacy. Token de otra organización, revocado, reemplazado
// o con formato inválido -> 404 QR_NOT_FOUND idéntico (no distingue casos).
import { Router } from 'express';
import {
  createRequireGanaderiaSession,
  createRequireGanaderiaCsrf,
} from '../security/ganaderiaSession.js';
import { isValidPositiveId } from '../services/ganaderia/animalValidation.js';
import {
  validateAsignarQrBody,
  validateReemplazarQrBody,
  validateRevocarQrBody,
} from '../services/ganaderia/animalQrValidation.js';
import {
  asignarQr,
  getAnimalQr,
  reemplazarQr,
  resolverQr,
  revocarQr,
} from '../services/ganaderia/animalQrRepository.js';

function sendSemanticError(res, error) {
  if (typeof error?.status === 'number' && typeof error?.code === 'string') {
    res.status(error.status).json({ error: error.code, message: error.message });
    return true;
  }
  return false;
}

function withAnimalId(handler) {
  return async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (!isValidPositiveId(req.params.animalId)) {
        res.status(400).json({ error: 'INVALID_ANIMAL_ID' });
        return;
      }
      await handler(req, res);
    } catch (error) {
      if (sendSemanticError(res, error)) return;
      next(error);
    }
  };
}

export function createGanaderiaAnimalQrRouter({ appEnv, csrfServerSecret, allowedOrigins } = {}) {
  const router = Router({ mergeParams: true });

  router.use(createRequireGanaderiaSession({ appEnv }));
  router.use(createRequireGanaderiaCsrf({ csrfServerSecret, allowedOrigins }));

  router.get('/', withAnimalId(async (req, res) => {
    const { organizacionId } = req.ganaderiaAuth;
    const qr = await getAnimalQr(organizacionId, req.params.animalId);
    if (!qr) {
      res.status(404).json({ error: 'ANIMAL_NOT_FOUND' });
      return;
    }
    res.json({ ok: true, ...qr });
  }));

  router.post('/', withAnimalId(async (req, res) => {
    validateAsignarQrBody(req.body);
    const { organizacionId, cuentaId } = req.ganaderiaAuth;
    const { identificador, yaExistia } = await asignarQr(organizacionId, req.params.animalId, {
      actorCuentaId: cuentaId,
    });
    res.status(yaExistia ? 200 : 201).json({ ok: true, yaExistia, identificador });
  }));

  router.post('/revocar', withAnimalId(async (req, res) => {
    const { motivo } = validateRevocarQrBody(req.body);
    const { organizacionId, cuentaId } = req.ganaderiaAuth;
    const { identificador, yaRevocado } = await revocarQr(organizacionId, req.params.animalId, {
      motivo,
      actorCuentaId: cuentaId,
    });
    res.json({ ok: true, yaRevocado, identificador });
  }));

  router.post('/reemplazar', withAnimalId(async (req, res) => {
    const { motivo, clientOperationId } = validateReemplazarQrBody(req.body);
    const { organizacionId, cuentaId } = req.ganaderiaAuth;
    const { identificador, yaExistia } = await reemplazarQr(organizacionId, req.params.animalId, {
      motivo,
      clientOperationId,
      actorCuentaId: cuentaId,
    });
    res.status(yaExistia ? 200 : 201).json({ ok: true, yaExistia, identificador });
  }));

  return router;
}

export function createGanaderiaQrResolverRouter({ appEnv, csrfServerSecret, allowedOrigins } = {}) {
  const router = Router();

  router.use(createRequireGanaderiaSession({ appEnv }));
  router.use(createRequireGanaderiaCsrf({ csrfServerSecret, allowedOrigins }));

  router.get('/:token', async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      const { organizacionId } = req.ganaderiaAuth;
      const resolved = await resolverQr(organizacionId, req.params.token);
      if (!resolved) {
        res.status(404).json({ error: 'QR_NOT_FOUND' });
        return;
      }
      res.json({ ok: true, animalId: resolved.animal.animalId, animal: resolved.animal });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
