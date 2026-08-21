// SPRINT-3D6-FICHA-PRODUCTIVA: catálogo de pasturas (sistema +
// personalizado por organización) -- §5/§6/§7/§9 del sprint. Deliberadamente
// NO subordinado a predio/potrero (el catálogo es transversal a toda la
// organización, no a un potrero en particular) -- monta directamente en
// /api/ganaderia/catalogo-pasturas (server/index.js).
//
// Regla de oro: igual que el resto de routers Ganadería -- SOLO habla con
// Postgres-AGX-Business vía potreroFichaProductivaRepository.js. Nunca
// inserta en el catálogo de sistema (organizacion_id NULL) -- eso es
// exclusivamente responsabilidad del seed de la migración 0004, ejecutado
// como superusuario/agx_owner, nunca de esta ruta.
import { Router } from 'express';
import {
  createRequireGanaderiaSession,
  createRequireGanaderiaCsrf,
} from '../security/ganaderiaSession.js';
import {
  listCatalogoPasturas,
  createPasturaPersonalizada,
  isValidCatalogoTipo,
} from '../services/ganaderia/potreroFichaProductivaRepository.js';

const MAX_NOMBRE_COMUN_LENGTH = 160;
const MAX_NOMBRE_CIENTIFICO_LENGTH = 200;
const MAX_GENERO_ESPECIE_CULTIVAR_LENGTH = 120;
const MAX_SEARCH_LENGTH = 160;

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function optionalTrimmedString(rawValue, maxLength, code, label) {
  if (rawValue === undefined || rawValue === null || rawValue === '') return null;
  if (typeof rawValue !== 'string' || rawValue.trim().length > maxLength) {
    throw Object.assign(new Error(`${label} debe ser texto (máx ${maxLength} caracteres).`), { status: 400, code });
  }
  return rawValue.trim() || null;
}

// §9: únicamente los campos descriptivos del cliente -- NUNCA
// organizacionId/alcance/activo/pasturaId (alcance/organizacion_id
// siempre se fijan en el repositorio; nunca se inserta en el catálogo de
// sistema desde esta ruta).
const CREATE_PERSONALIZADA_ALLOWED_KEYS = new Set([
  'nombreComun',
  'nombreCientifico',
  'genero',
  'especie',
  'cultivar',
  'tipo',
]);

export function validateCreatePasturaPersonalizadaBody(body) {
  const unknownKeys = Object.keys(body || {}).filter((key) => !CREATE_PERSONALIZADA_ALLOWED_KEYS.has(key));
  if (unknownKeys.length > 0) {
    throw Object.assign(new Error(`Campos no permitidos: ${unknownKeys.join(', ')}`), {
      status: 400,
      code: 'FORBIDDEN_FIELDS',
    });
  }

  if (!isNonEmptyString(body?.nombreComun) || body.nombreComun.trim().length > MAX_NOMBRE_COMUN_LENGTH) {
    throw Object.assign(new Error(`nombreComun es obligatorio (máx ${MAX_NOMBRE_COMUN_LENGTH} caracteres).`), {
      status: 400,
      code: 'INVALID_NOMBRE_COMUN',
    });
  }
  if (!isValidCatalogoTipo(body?.tipo)) {
    throw Object.assign(new Error('tipo debe ser uno de: graminea, leguminosa, mezcla, otra.'), {
      status: 400,
      code: 'INVALID_TIPO',
    });
  }

  return {
    nombreComun: body.nombreComun.trim(),
    nombreCientifico: optionalTrimmedString(body?.nombreCientifico, MAX_NOMBRE_CIENTIFICO_LENGTH, 'INVALID_NOMBRE_CIENTIFICO', 'nombreCientifico'),
    genero: optionalTrimmedString(body?.genero, MAX_GENERO_ESPECIE_CULTIVAR_LENGTH, 'INVALID_GENERO', 'genero'),
    especie: optionalTrimmedString(body?.especie, MAX_GENERO_ESPECIE_CULTIVAR_LENGTH, 'INVALID_ESPECIE', 'especie'),
    cultivar: optionalTrimmedString(body?.cultivar, MAX_GENERO_ESPECIE_CULTIVAR_LENGTH, 'INVALID_CULTIVAR', 'cultivar'),
    tipo: body.tipo,
  };
}

function serializePastura(row) {
  return {
    pasturaId: String(row.pastura_id),
    nombreComun: row.nombre_comun,
    nombreCientifico: row.nombre_cientifico ?? null,
    genero: row.genero ?? null,
    especie: row.especie ?? null,
    cultivar: row.cultivar ?? null,
    tipo: row.tipo,
    alcance: row.alcance,
  };
}

function sendSemanticError(res, error) {
  if (typeof error?.status === 'number' && typeof error?.code === 'string') {
    res.status(error.status).json({ error: error.code, message: error.message });
    return true;
  }
  return false;
}

export default function createGanaderiaCatalogoPasturasRouter({ appEnv, csrfServerSecret, allowedOrigins } = {}) {
  const router = Router();

  const requireSession = createRequireGanaderiaSession({ appEnv });
  const requireCsrf = createRequireGanaderiaCsrf({ csrfServerSecret, allowedOrigins });

  router.use(requireSession);
  router.use(requireCsrf);

  // GET /api/ganaderia/catalogo-pasturas?q=... -- sistema + personalizado
  // propio (RLS), nunca personalizado de otra organización.
  router.get('/', async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const rawSearch = typeof req.query?.q === 'string' ? req.query.q : '';
      if (rawSearch.length > MAX_SEARCH_LENGTH) {
        res.status(400).json({ error: 'INVALID_SEARCH' });
        return;
      }

      const { organizacionId } = req.ganaderiaAuth;
      const rows = await listCatalogoPasturas(organizacionId, { search: rawSearch });
      res.json({ pasturas: rows.map(serializePastura) });
    } catch (error) {
      if (sendSemanticError(res, error)) return;
      next(error);
    }
  });

  // POST /api/ganaderia/catalogo-pasturas/personalizadas -- crea una
  // entrada personalizada (scope = organización activa, §9 del sprint).
  router.post('/personalizadas', async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const payload = validateCreatePasturaPersonalizadaBody(req.body);
      const { organizacionId } = req.ganaderiaAuth;

      const pastura = await createPasturaPersonalizada(organizacionId, payload);
      res.status(201).json({ ok: true, pastura: serializePastura(pastura) });
    } catch (error) {
      if (sendSemanticError(res, error)) return;
      next(error);
    }
  });

  return router;
}
