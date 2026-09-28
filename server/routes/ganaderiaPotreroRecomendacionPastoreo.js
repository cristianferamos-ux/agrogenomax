// SPRINT-3D7.2-RECOMENDACION-PASTOREO-AUTO: backend del motor automático
// de recomendación de pastoreo -- ver recomendación actual + historial,
// previsualizar (no persiste) y crear (persiste, histórico) una
// recomendación. Monta en /api/ganaderia/predios/:predioId/potreros/
// :potreroId/recomendacion-pastoreo (server/index.js) -- mismo patrón que
// ganaderiaPotreroCapacidadPastoreo.js ("Modo técnico", que permanece
// intacto y disponible en paralelo).
//
// Regla de oro (§7/§17 del sprint): el cliente NUNCA aporta biomasaFrescaKg/
// materiaSecaPctAplicada/utilizacionPctAplicada/consumoPctPvAplicado/
// resultados/fichaId/contextoId/categoriaId/organizacionId como valores
// autoritativos -- el repositorio siempre recalcula server-side sobre la
// categoría del catálogo + la ficha productiva real + el motor
// pastura/clima determinístico.
import { Router } from 'express';
import {
  createRequireGanaderiaSession,
  createRequireGanaderiaCsrf,
} from '../security/ganaderiaSession.js';
import {
  getRecomendacionPastoreoByPotrero,
  previewRecomendacionPastoreo,
  createRecomendacionPastoreo,
} from '../services/ganaderia/potreroRecomendacionPastoreoRepository.js';
import {
  previewCargaAutomatica,
  evaluarEscenarioCargaAutomatica,
  guardarCargaAutomatica,
} from '../services/ganaderia/potreroCargaAutomaticaRepository.js';
import { parseFechaCalendario } from '../services/ganaderia/motorPastoreoAuto/fechaPlanHelpers.js';
import {
  MAX_PESO_VIVO_PROMEDIO_KG,
  MAX_NUMERO_ANIMALES,
} from '../services/ganaderia/capacidadPastoreoFormulas.js';

// Hardening ronda 3: tope realista de 60 L/día (antes 100, sin
// justificación) -- combinado con el rango peso_min/max_referencia_kg de
// la categoría (cota dura desde este hardening), mantiene el %PV
// equivalente derivado de la ecuación NRC (2001) dentro del guardrail
// técnico de la tabla para cualquier combinación válida.
const MAX_PRODUCCION_LECHE_L_DIA = 60;
// Días en leche (DIM) -- input requerido por la ecuación NRC (2001) para
// vacas en producción (hardening §1/§3). Tope de 500 días acompaña el
// CHECK de la migración 0007.
const MAX_DIAS_EN_LECHE = 500;
// Hardening ronda 4 §4: %grasa de la leche -- SIEMPRE OPCIONAL. Rango
// típico de grasa de leche bovina 2-7%; tope de 10% deja margen para
// razas/sistemas atípicos sin aceptar errores de digitación obvios.
const MAX_GRASA_LECHE_PCT = 10;
const CATEGORIA_CODIGO_PATTERN = /^[a-z][a-z0-9_]{1,58}[a-z0-9]$/;

function isPredioIdValid(predioId) {
  return /^\d+$/.test(String(predioId));
}

function isPotreroIdValid(potreroId) {
  return /^\d+$/.test(String(potreroId));
}

function validationError(code, message) {
  return Object.assign(new Error(message), { status: 400, code });
}

function validateCategoriaCodigo(rawValue) {
  if (typeof rawValue !== 'string' || !CATEGORIA_CODIGO_PATTERN.test(rawValue)) {
    throw validationError('INVALID_CATEGORIA_CODIGO', 'categoriaCodigo inválido.');
  }
  return rawValue;
}

function validateNumeroAnimales(rawValue) {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1) {
    throw validationError('INVALID_NUMERO_ANIMALES', 'numero_animales debe ser un entero >= 1.');
  }
  if (parsed > MAX_NUMERO_ANIMALES) {
    throw validationError('NUMERO_ANIMALES_TOO_HIGH', `numero_animales supera el máximo técnico permitido (${MAX_NUMERO_ANIMALES}).`);
  }
  return parsed;
}

function validatePesoPromedioKg(rawValue) {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw validationError('INVALID_PESO_PROMEDIO', 'peso_promedio_kg debe ser un número mayor que 0.');
  }
  if (parsed > MAX_PESO_VIVO_PROMEDIO_KG) {
    throw validationError('PESO_PROMEDIO_TOO_HIGH', `peso_promedio_kg supera el máximo técnico permitido (${MAX_PESO_VIVO_PROMEDIO_KG}).`);
  }
  return parsed;
}

function validateProduccionLecheLDia(rawValue) {
  if (rawValue === undefined || rawValue === null || rawValue === '') return null;
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > MAX_PRODUCCION_LECHE_L_DIA) {
    throw validationError('INVALID_PRODUCCION_LECHE', `produccion_leche_l_dia debe estar entre 0 y ${MAX_PRODUCCION_LECHE_L_DIA}.`);
  }
  return parsed;
}

function validateDiasEnLeche(rawValue) {
  if (rawValue === undefined || rawValue === null || rawValue === '') return null;
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > MAX_DIAS_EN_LECHE) {
    throw validationError('INVALID_DIAS_EN_LECHE', `dias_en_leche debe ser un número entre 0 (exclusivo) y ${MAX_DIAS_EN_LECHE}.`);
  }
  return parsed;
}

function validateGrasaLechePct(rawValue) {
  if (rawValue === undefined || rawValue === null || rawValue === '') return null;
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > MAX_GRASA_LECHE_PCT) {
    throw validationError('INVALID_GRASA_LECHE', `grasa_leche_pct debe ser un número entre 0 (exclusivo) y ${MAX_GRASA_LECHE_PCT}.`);
  }
  return parsed;
}

function validateTerneroAlPie(rawValue) {
  if (rawValue === undefined || rawValue === null) return null;
  if (typeof rawValue !== 'boolean') {
    throw validationError('INVALID_TERNERO_AL_PIE', 'ternero_al_pie debe ser verdadero/falso.');
  }
  return rawValue;
}

const ALLOWED_KEYS = new Set(['categoriaCodigo', 'numeroAnimales', 'pesoPromedioKg', 'produccionLecheLDia', 'diasEnLeche', 'grasaLechePct', 'terneroAlPie']);

// §7 del sprint: SOLO los inputs mínimos del cliente -- nunca
// biomasaFrescaKg/materiaSecaPct/utilizacionPct/consumoPctPesoVivo/
// resultados/fichaId/contextoId/categoriaId (siempre derivados server-side).
export function validateRecomendacionPastoreoBody(body) {
  const unknownKeys = Object.keys(body || {}).filter((key) => !ALLOWED_KEYS.has(key));
  if (unknownKeys.length > 0) {
    throw validationError('FORBIDDEN_FIELDS', `Campos no permitidos: ${unknownKeys.join(', ')}`);
  }

  return {
    categoriaCodigo: validateCategoriaCodigo(body?.categoriaCodigo),
    numeroAnimales: validateNumeroAnimales(body?.numeroAnimales),
    pesoPromedioKg: validatePesoPromedioKg(body?.pesoPromedioKg),
    produccionLecheLDia: validateProduccionLecheLDia(body?.produccionLecheLDia),
    diasEnLeche: validateDiasEnLeche(body?.diasEnLeche),
    grasaLechePct: validateGrasaLechePct(body?.grasaLechePct),
    terneroAlPie: validateTerneroAlPie(body?.terneroAlPie),
  };
}

// SPRINT-3D10.4 FASE 3 §1/§10 -- input autoritativo del motor automático:
// SOLO hechos del productor (categoría, peso, fecha prevista + leche/
// ternero condicionales). fechaIngresoPrevista es formato calendario
// YYYY-MM-DD -- parseFechaCalendario rechaza formato incorrecto Y fechas
// inexistentes (ej. 2026-02-30).
function validateFechaIngresoPrevista(rawValue) {
  if (typeof rawValue !== 'string') {
    throw validationError('INVALID_FECHA_INGRESO_PREVISTA', 'fechaIngresoPrevista debe tener formato YYYY-MM-DD.');
  }
  try {
    parseFechaCalendario(rawValue);
  } catch {
    throw validationError('INVALID_FECHA_INGRESO_PREVISTA', 'fechaIngresoPrevista debe ser una fecha de calendario válida en formato YYYY-MM-DD.');
  }
  return rawValue;
}

// §9 del sprint: mismo rango que validateNumeroAnimales, con un código de
// error propio (nunca confundir el override del escenario con el input
// del endpoint manual).
function validateNumeroAnimalesUsuario(rawValue) {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1) {
    throw validationError('INVALID_NUMERO_ANIMALES_USUARIO', 'numeroAnimalesUsuario debe ser un entero >= 1.');
  }
  if (parsed > MAX_NUMERO_ANIMALES) {
    throw validationError('NUMERO_ANIMALES_USUARIO_TOO_HIGH', `numeroAnimalesUsuario supera el máximo técnico permitido (${MAX_NUMERO_ANIMALES}).`);
  }
  return parsed;
}

// §0/§1 del sprint: whitelist estricta -- el cliente NUNCA aporta fichaId/
// tipoPastura/generoPastura/occupationPolicy/MSU/DI/resultados/provenance
// (ni siquiera numeroAnimales, que aquí es SIEMPRE output). Cualquier otra
// clave -> 400 FORBIDDEN_FIELDS.
const ALLOWED_KEYS_AUTO = new Set(['categoriaCodigo', 'pesoPromedioKg', 'fechaIngresoPrevista', 'produccionLecheLDia', 'diasEnLeche', 'grasaLechePct', 'terneroAlPie']);
const ALLOWED_KEYS_AUTO_ESCENARIO = new Set([...ALLOWED_KEYS_AUTO, 'numeroAnimalesUsuario']);

function parseCargaAutomaticaCamposComunes(body) {
  return {
    categoriaCodigo: validateCategoriaCodigo(body?.categoriaCodigo),
    pesoPromedioKg: validatePesoPromedioKg(body?.pesoPromedioKg),
    fechaIngresoPrevista: validateFechaIngresoPrevista(body?.fechaIngresoPrevista),
    produccionLecheLDia: validateProduccionLecheLDia(body?.produccionLecheLDia),
    diasEnLeche: validateDiasEnLeche(body?.diasEnLeche),
    grasaLechePct: validateGrasaLechePct(body?.grasaLechePct),
    terneroAlPie: validateTerneroAlPie(body?.terneroAlPie),
  };
}

export function validateCargaAutomaticaBody(body) {
  const unknownKeys = Object.keys(body || {}).filter((key) => !ALLOWED_KEYS_AUTO.has(key));
  if (unknownKeys.length > 0) {
    throw validationError('FORBIDDEN_FIELDS', `Campos no permitidos: ${unknownKeys.join(', ')}`);
  }
  return parseCargaAutomaticaCamposComunes(body);
}

export function validateCargaAutomaticaEscenarioBody(body) {
  const unknownKeys = Object.keys(body || {}).filter((key) => !ALLOWED_KEYS_AUTO_ESCENARIO.has(key));
  if (unknownKeys.length > 0) {
    throw validationError('FORBIDDEN_FIELDS', `Campos no permitidos: ${unknownKeys.join(', ')}`);
  }
  return {
    ...parseCargaAutomaticaCamposComunes(body),
    numeroAnimalesUsuario: validateNumeroAnimalesUsuario(body?.numeroAnimalesUsuario),
  };
}

function sendSemanticError(res, error) {
  if (typeof error?.status === 'number' && typeof error?.code === 'string') {
    res.status(error.status).json({ error: error.code, message: error.message });
    return true;
  }
  return false;
}

// Router -- montado con mergeParams para heredar :predioId/:potreroId del
// mount en server/index.js.
export default function createGanaderiaPotreroRecomendacionPastoreoRouter({ appEnv, csrfServerSecret, allowedOrigins } = {}) {
  const router = Router({ mergeParams: true });

  const requireSession = createRequireGanaderiaSession({ appEnv });
  const requireCsrf = createRequireGanaderiaCsrf({ csrfServerSecret, allowedOrigins });

  router.use(requireSession);
  router.use(requireCsrf);

  // GET .../recomendacion-pastoreo -- recomendación más reciente +
  // historial resumido. Sin recomendaciones todavía -> 200 con
  // { actual: null, historial: [] }, nunca 404 (el potrero sí existe).
  router.get('/', async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const { predioId, potreroId } = req.params;
      if (!isPredioIdValid(predioId) || !isPotreroIdValid(potreroId)) {
        res.status(400).json({ error: 'INVALID_POTRERO_ID' });
        return;
      }

      const { organizacionId } = req.ganaderiaAuth;
      const result = await getRecomendacionPastoreoByPotrero(organizacionId, predioId, potreroId);
      res.json(result);
    } catch (error) {
      if (sendSemanticError(res, error)) return;
      next(error);
    }
  });

  // POST .../recomendacion-pastoreo/preview -- calcula server-side sobre la
  // ficha real + categoría + motor pastura/clima, NO persiste.
  router.post('/preview', async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const { predioId, potreroId } = req.params;
      if (!isPredioIdValid(predioId) || !isPotreroIdValid(potreroId)) {
        res.status(400).json({ error: 'INVALID_POTRERO_ID' });
        return;
      }

      const payload = validateRecomendacionPastoreoBody(req.body);
      const { organizacionId } = req.ganaderiaAuth;

      const preview = await previewRecomendacionPastoreo(organizacionId, predioId, potreroId, payload);
      res.json({ ok: true, preview });
    } catch (error) {
      if (sendSemanticError(res, error)) return;
      next(error);
    }
  });

  // POST .../recomendacion-pastoreo -- recalcula server-side y persiste una
  // recomendación NUEVA (append, nunca sobrescribe una anterior).
  router.post('/', async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const { predioId, potreroId } = req.params;
      if (!isPredioIdValid(predioId) || !isPotreroIdValid(potreroId)) {
        res.status(400).json({ error: 'INVALID_POTRERO_ID' });
        return;
      }

      const payload = validateRecomendacionPastoreoBody(req.body);
      const { organizacionId } = req.ganaderiaAuth;

      const recomendacion = await createRecomendacionPastoreo(organizacionId, predioId, potreroId, payload);
      res.status(201).json({ ok: true, recomendacion });
    } catch (error) {
      if (sendSemanticError(res, error)) return;
      next(error);
    }
  });

  // ---------------------------------------------------------------------
  // SPRINT-3D10.4 FASE 3 -- motor automático de carga recomendada. Rutas
  // NUEVAS, el endpoint manual de arriba queda 100% intacto (§19 del
  // sprint) -- ni su body, ni su validación, ni su cálculo, ni su
  // response cambian.
  // ---------------------------------------------------------------------

  // POST .../auto/preview -- recalcula TODO server-side, NUNCA persiste.
  router.post('/auto/preview', async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const { predioId, potreroId } = req.params;
      if (!isPredioIdValid(predioId) || !isPotreroIdValid(potreroId)) {
        res.status(400).json({ error: 'INVALID_POTRERO_ID' });
        return;
      }

      const payload = validateCargaAutomaticaBody(req.body);
      const { organizacionId } = req.ganaderiaAuth;

      const resultado = await previewCargaAutomatica(organizacionId, predioId, potreroId, payload);
      res.json({ ok: true, ...resultado });
    } catch (error) {
      if (sendSemanticError(res, error)) return;
      next(error);
    }
  });

  // POST .../auto/escenario -- recalcula TODO desde cero (nunca reutiliza
  // un preview anterior del navegador), evalúa numeroAnimalesUsuario.
  // NUNCA persiste.
  router.post('/auto/escenario', async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const { predioId, potreroId } = req.params;
      if (!isPredioIdValid(predioId) || !isPotreroIdValid(potreroId)) {
        res.status(400).json({ error: 'INVALID_POTRERO_ID' });
        return;
      }

      const payload = validateCargaAutomaticaEscenarioBody(req.body);
      const { organizacionId } = req.ganaderiaAuth;

      const resultado = await evaluarEscenarioCargaAutomatica(organizacionId, predioId, potreroId, payload);
      res.json({ ok: true, ...resultado });
    } catch (error) {
      if (sendSemanticError(res, error)) return;
      next(error);
    }
  });

  // POST .../auto -- RECALCULA DESDE CERO (nunca confía en un preview
  // previo) y persiste SOLO si estado=OK (modo_calculo='AUTOMATICO',
  // append-only, igual que el endpoint manual).
  router.post('/auto', async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const { predioId, potreroId } = req.params;
      if (!isPredioIdValid(predioId) || !isPotreroIdValid(potreroId)) {
        res.status(400).json({ error: 'INVALID_POTRERO_ID' });
        return;
      }

      const payload = validateCargaAutomaticaBody(req.body);
      const { organizacionId } = req.ganaderiaAuth;

      const resultado = await guardarCargaAutomatica(organizacionId, predioId, potreroId, payload);
      res.status(resultado.estado === 'OK' ? 201 : 200).json({ ok: true, ...resultado });
    } catch (error) {
      if (sendSemanticError(res, error)) return;
      next(error);
    }
  });

  return router;
}
