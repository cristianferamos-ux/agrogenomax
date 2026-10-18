// SPRINT-3D11.2 -- REGISTRO MANUAL DE ANIMALES. Monta en
// /api/ganaderia/animales (server/index.js). Habla SOLO con
// Postgres-AGX-Business vía animalesRepository.js; nunca con el Postgres
// legacy ni con los routers legacy /api/animales y /api/qr (desmontados en
// 3D11.SECURITY-LEGACY). El tenant sale exclusivamente de
// req.ganaderiaAuth; cualquier organizacionId en body/query es
// FORBIDDEN_FIELDS/INVALID_QUERY.
import { Router } from 'express';
import {
  createRequireGanaderiaSession,
  createRequireGanaderiaCsrf,
} from '../security/ganaderiaSession.js';
import { resolveFechaHoyNegocio } from '../services/ganaderia/motorDescansoAuto/businessTimezone.js';
import {
  isValidPositiveId,
  validateAnularAnimalBody,
  validateCorregirAnimalBody,
  validateCreateAnimalBody,
  validateListAnimalesQuery,
} from '../services/ganaderia/animalValidation.js';
import {
  anularAnimal,
  corregirAnimal,
  createAnimalIdempotente,
  getAnimal,
  listAnimales,
} from '../services/ganaderia/animalesRepository.js';

function sendSemanticError(res, error) {
  if (typeof error?.status === 'number' && typeof error?.code === 'string') {
    res.status(error.status).json({ error: error.code, message: error.message });
    return true;
  }
  return false;
}

// 201 al crear; 200 cuando la misma intención ya existía. Nunca devuelve
// clientOperationId ni creationIntentHash.
export function buildCreateAnimalResponse({ animal, yaExistia }) {
  return { status: yaExistia ? 200 : 201, body: { ok: true, yaExistia, animal } };
}

export default function createGanaderiaAnimalesRouter({ appEnv, csrfServerSecret, allowedOrigins } = {}) {
  const router = Router();

  router.use(createRequireGanaderiaSession({ appEnv }));
  router.use(createRequireGanaderiaCsrf({ csrfServerSecret, allowedOrigins }));

  router.get('/', async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const filtros = validateListAnimalesQuery(req.query);
      const { organizacionId } = req.ganaderiaAuth;
      const { animales, total } = await listAnimales(organizacionId, filtros);
      res.json({ animales, total, limit: filtros.limit, offset: filtros.offset });
    } catch (error) {
      if (sendSemanticError(res, error)) return;
      next(error);
    }
  });

  router.get('/:animalId', async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (!isValidPositiveId(req.params.animalId)) {
        res.status(400).json({ error: 'INVALID_ANIMAL_ID' });
        return;
      }
      const { organizacionId } = req.ganaderiaAuth;
      const animal = await getAnimal(organizacionId, req.params.animalId);
      if (!animal) {
        res.status(404).json({ error: 'ANIMAL_NOT_FOUND' });
        return;
      }
      res.json({ ok: true, animal });
    } catch (error) {
      next(error);
    }
  });

  router.post('/', async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const value = validateCreateAnimalBody(req.body, { hoy: resolveFechaHoyNegocio() });
      const { organizacionId, cuentaId } = req.ganaderiaAuth;
      const result = await createAnimalIdempotente(organizacionId, value, { actorCuentaId: cuentaId });
      const { status, body } = buildCreateAnimalResponse(result);
      res.status(status).json(body);
    } catch (error) {
      if (sendSemanticError(res, error)) return;
      next(error);
    }
  });

  router.post('/:animalId/corregir', async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (!isValidPositiveId(req.params.animalId)) {
        res.status(400).json({ error: 'INVALID_ANIMAL_ID' });
        return;
      }
      const correccion = validateCorregirAnimalBody(req.body, { hoy: resolveFechaHoyNegocio() });
      const { organizacionId, cuentaId } = req.ganaderiaAuth;
      const { animal, sinCambios } = await corregirAnimal(organizacionId, req.params.animalId, correccion, {
        actorCuentaId: cuentaId,
      });
      res.json({ ok: true, sinCambios, animal });
    } catch (error) {
      if (sendSemanticError(res, error)) return;
      next(error);
    }
  });

  router.post('/:animalId/anular', async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (!isValidPositiveId(req.params.animalId)) {
        res.status(400).json({ error: 'INVALID_ANIMAL_ID' });
        return;
      }
      const { motivo } = validateAnularAnimalBody(req.body);
      const { organizacionId, cuentaId } = req.ganaderiaAuth;
      const { animal, yaAnulado } = await anularAnimal(organizacionId, req.params.animalId, {
        motivo,
        actorCuentaId: cuentaId,
      });
      res.json({ ok: true, yaAnulado, animal });
    } catch (error) {
      if (sendSemanticError(res, error)) return;
      next(error);
    }
  });

  return router;
}
