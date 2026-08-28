// SPRINT-3D9.1 -- CICLO REAL DE PASTOREO
//
// Monta en /api/ganaderia/predios/:predioId/potreros/:potreroId/
// ciclos-pastoreo (server/index.js) -- mismo patrón que
// ganaderiaPotreroDescansoReentrada.js.
//
// Regla de oro: el cliente NUNCA aporta fechas -- fecha_ingreso_real y
// fecha_salida_real se resuelven SIEMPRE server-side (America/Bogota, ver
// businessTimezone.js). El único input real del cliente es, como mucho,
// un ajuste del lote (numeroAnimales/pesoPromedioKg/categoriaCodigo) al
// iniciar, y el motivo obligatorio al cancelar.
import { Router } from 'express';
import {
  createRequireGanaderiaSession,
  createRequireGanaderiaCsrf,
} from '../security/ganaderiaSession.js';
import {
  iniciarCicloPastoreo,
  finalizarCicloPastoreo,
  cancelarCicloPastoreo,
  anularCicloPastoreo,
  corregirCicloPastoreo,
  evaluarReingreso,
  getCicloActual,
  getCicloHistorial,
} from '../services/ganaderia/potreroCicloPastoreoRepository.js';
import { getEstadoOperativoPotrero } from '../services/ganaderia/potreroEstadoOperativoRepository.js';
import { previewFichaBaseReal } from '../services/ganaderia/potreroCicloRealPressureRepository.js';

function isPredioIdValid(predioId) {
  return /^\d+$/.test(String(predioId));
}

function isPotreroIdValid(potreroId) {
  return /^\d+$/.test(String(potreroId));
}

function isCicloIdValid(cicloId) {
  return /^\d+$/.test(String(cicloId));
}

function validationError(code, message) {
  return Object.assign(new Error(message), { status: 400, code });
}

// SPRINT-3D9.3: campos condicionales REAL (leche/ternero) -- mismo
// criterio de validación type-check-únicamente que el resto de este
// archivo (el repositorio decide requeridad exacta por categoría; aquí
// solo se garantiza que, si el cliente los envía, tienen el tipo
// correcto -- nunca se exige su presencia, iniciar nunca se bloquea por
// evidencia científica incompleta).
const ALLOWED_KEYS_INICIAR = new Set([
  'numeroAnimales', 'pesoPromedioKg', 'categoriaCodigo',
  'produccionLecheLDia', 'diasEnLeche', 'grasaLechePct', 'terneroAlPie',
]);
const ALLOWED_KEYS_CANCELAR = new Set(['motivo']);

// Nunca fechas del cliente -- solo el ajuste opcional del lote real.
export function validateIniciarBody(body) {
  const unknownKeys = Object.keys(body || {}).filter((key) => !ALLOWED_KEYS_INICIAR.has(key));
  if (unknownKeys.length > 0) {
    throw validationError('FORBIDDEN_FIELDS', `Campos no permitidos: ${unknownKeys.join(', ')}`);
  }
  const {
    numeroAnimales, pesoPromedioKg, categoriaCodigo,
    produccionLecheLDia, diasEnLeche, grasaLechePct, terneroAlPie,
  } = body || {};
  if (numeroAnimales !== undefined && typeof numeroAnimales !== 'number') {
    throw validationError('INVALID_NUMERO_ANIMALES_REAL', 'numeroAnimales debe ser numérico.');
  }
  if (pesoPromedioKg !== undefined && typeof pesoPromedioKg !== 'number') {
    throw validationError('INVALID_PESO_PROMEDIO_REAL', 'pesoPromedioKg debe ser numérico.');
  }
  if (categoriaCodigo !== undefined && typeof categoriaCodigo !== 'string') {
    throw validationError('INVALID_CATEGORIA_CODIGO', 'categoriaCodigo debe ser texto.');
  }
  if (produccionLecheLDia !== undefined && produccionLecheLDia !== null && typeof produccionLecheLDia !== 'number') {
    throw validationError('INVALID_PRODUCCION_LECHE_REAL', 'produccionLecheLDia debe ser numérico.');
  }
  if (diasEnLeche !== undefined && diasEnLeche !== null && typeof diasEnLeche !== 'number') {
    throw validationError('INVALID_DIAS_EN_LECHE_REAL', 'diasEnLeche debe ser numérico.');
  }
  if (grasaLechePct !== undefined && grasaLechePct !== null && typeof grasaLechePct !== 'number') {
    throw validationError('INVALID_GRASA_LECHE_REAL', 'grasaLechePct debe ser numérico.');
  }
  if (terneroAlPie !== undefined && terneroAlPie !== null && typeof terneroAlPie !== 'boolean') {
    throw validationError('INVALID_TERNERO_AL_PIE_REAL', 'terneroAlPie debe ser verdadero o falso.');
  }
  return {
    numeroAnimales, pesoPromedioKg, categoriaCodigo,
    produccionLecheLDia, diasEnLeche, grasaLechePct, terneroAlPie,
  };
}

export function validateCancelarBody(body) {
  const unknownKeys = Object.keys(body || {}).filter((key) => !ALLOWED_KEYS_CANCELAR.has(key));
  if (unknownKeys.length > 0) {
    throw validationError('FORBIDDEN_FIELDS', `Campos no permitidos: ${unknownKeys.join(', ')}`);
  }
  const motivo = body?.motivo;
  if (typeof motivo !== 'string' || motivo.trim() === '') {
    throw validationError('INVALID_MOTIVO_CANCELACION', 'motivo es obligatorio para cancelar un ciclo.');
  }
  return { motivo };
}

const ALLOWED_KEYS_ANULAR = new Set(['motivo']);

export function validateAnularBody(body) {
  const unknownKeys = Object.keys(body || {}).filter((key) => !ALLOWED_KEYS_ANULAR.has(key));
  if (unknownKeys.length > 0) {
    throw validationError('FORBIDDEN_FIELDS', `Campos no permitidos: ${unknownKeys.join(', ')}`);
  }
  const motivo = body?.motivo;
  if (typeof motivo !== 'string' || motivo.trim() === '') {
    throw validationError('INVALID_MOTIVO_ANULACION', 'motivo es obligatorio para anular un ciclo.');
  }
  return { motivo };
}

const ALLOWED_KEYS_CORREGIR = new Set([
  'fechaIngresoReal', 'fechaSalidaReal', 'categoriaCodigo', 'numeroAnimales', 'pesoPromedioKg', 'motivo',
  'produccionLecheLDia', 'diasEnLeche', 'grasaLechePct', 'terneroAlPie',
]);

// SPRINT-3D9.2/3D9.3: type-check únicamente -- el repositorio valida
// formato/rango exacto (mismo criterio que validateIniciarBody).
export function validateCorregirBody(body) {
  const unknownKeys = Object.keys(body || {}).filter((key) => !ALLOWED_KEYS_CORREGIR.has(key));
  if (unknownKeys.length > 0) {
    throw validationError('FORBIDDEN_FIELDS', `Campos no permitidos: ${unknownKeys.join(', ')}`);
  }
  const {
    fechaIngresoReal, fechaSalidaReal, categoriaCodigo, numeroAnimales, pesoPromedioKg,
    produccionLecheLDia, diasEnLeche, grasaLechePct, terneroAlPie, motivo,
  } = body || {};
  if (typeof motivo !== 'string' || motivo.trim() === '') {
    throw validationError('INVALID_MOTIVO_CORRECCION', 'motivo es obligatorio para corregir un ciclo.');
  }
  if (fechaIngresoReal !== undefined && typeof fechaIngresoReal !== 'string') {
    throw validationError('INVALID_FECHA_INGRESO_REAL', 'fechaIngresoReal debe ser texto YYYY-MM-DD.');
  }
  if (fechaSalidaReal !== undefined && typeof fechaSalidaReal !== 'string') {
    throw validationError('INVALID_FECHA_SALIDA_REAL', 'fechaSalidaReal debe ser texto YYYY-MM-DD.');
  }
  if (categoriaCodigo !== undefined && typeof categoriaCodigo !== 'string') {
    throw validationError('INVALID_CATEGORIA_CODIGO', 'categoriaCodigo debe ser texto.');
  }
  if (numeroAnimales !== undefined && typeof numeroAnimales !== 'number') {
    throw validationError('INVALID_NUMERO_ANIMALES_REAL', 'numeroAnimales debe ser numérico.');
  }
  if (pesoPromedioKg !== undefined && typeof pesoPromedioKg !== 'number') {
    throw validationError('INVALID_PESO_PROMEDIO_REAL', 'pesoPromedioKg debe ser numérico.');
  }
  if (produccionLecheLDia !== undefined && produccionLecheLDia !== null && typeof produccionLecheLDia !== 'number') {
    throw validationError('INVALID_PRODUCCION_LECHE_REAL', 'produccionLecheLDia debe ser numérico.');
  }
  if (diasEnLeche !== undefined && diasEnLeche !== null && typeof diasEnLeche !== 'number') {
    throw validationError('INVALID_DIAS_EN_LECHE_REAL', 'diasEnLeche debe ser numérico.');
  }
  if (grasaLechePct !== undefined && grasaLechePct !== null && typeof grasaLechePct !== 'number') {
    throw validationError('INVALID_GRASA_LECHE_REAL', 'grasaLechePct debe ser numérico.');
  }
  if (terneroAlPie !== undefined && terneroAlPie !== null && typeof terneroAlPie !== 'boolean') {
    throw validationError('INVALID_TERNERO_AL_PIE_REAL', 'terneroAlPie debe ser verdadero o falso.');
  }
  const algunCampo = [
    fechaIngresoReal, fechaSalidaReal, categoriaCodigo, numeroAnimales, pesoPromedioKg,
    produccionLecheLDia, diasEnLeche, grasaLechePct, terneroAlPie,
  ].some((v) => v !== undefined);
  if (!algunCampo) {
    throw validationError('SIN_CAMBIOS_SOLICITADOS', 'Debes indicar al menos un campo a corregir.');
  }
  return {
    fechaIngresoReal, fechaSalidaReal, categoriaCodigo, numeroAnimales, pesoPromedioKg,
    produccionLecheLDia, diasEnLeche, grasaLechePct, terneroAlPie, motivo,
  };
}

const ALLOWED_KEYS_EVALUAR_REINGRESO = new Set(['fichaId', 'resultado', 'observacion']);

export function validateEvaluarReingresoBody(body) {
  const unknownKeys = Object.keys(body || {}).filter((key) => !ALLOWED_KEYS_EVALUAR_REINGRESO.has(key));
  if (unknownKeys.length > 0) {
    throw validationError('FORBIDDEN_FIELDS', `Campos no permitidos: ${unknownKeys.join(', ')}`);
  }
  const { fichaId, resultado, observacion } = body || {};
  if (fichaId === undefined || fichaId === null || (typeof fichaId !== 'string' && typeof fichaId !== 'number')) {
    throw validationError('INVALID_FICHA_ID', 'fichaId es obligatorio.');
  }
  if (resultado !== 'APTO' && resultado !== 'NO_APTO') {
    throw validationError('INVALID_RESULTADO_EVALUACION', 'resultado debe ser APTO o NO_APTO.');
  }
  if (observacion !== undefined && typeof observacion !== 'string') {
    throw validationError('INVALID_OBSERVACION_EVALUACION', 'observacion debe ser texto.');
  }
  if (resultado === 'NO_APTO' && (typeof observacion !== 'string' || observacion.trim() === '')) {
    throw validationError('INVALID_OBSERVACION_EVALUACION', 'observacion es obligatoria cuando el resultado es NO_APTO.');
  }
  return { fichaId, resultado, observacion };
}

function sendSemanticError(res, error) {
  if (typeof error?.status === 'number' && typeof error?.code === 'string') {
    res.status(error.status).json({ error: error.code, message: error.message });
    return true;
  }
  return false;
}

export default function createGanaderiaPotreroCicloPastoreoRouter({ appEnv, csrfServerSecret, allowedOrigins } = {}) {
  const router = Router({ mergeParams: true });

  const requireSession = createRequireGanaderiaSession({ appEnv });
  const requireCsrf = createRequireGanaderiaCsrf({ csrfServerSecret, allowedOrigins });

  router.use(requireSession);
  router.use(requireCsrf);

  // GET .../ciclos-pastoreo/actual -- ciclo EN_CURSO, o { actual: null }.
  // Estrictamente read-only -- nunca dispara Iniciar/Finalizar.
  router.get('/actual', async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const { predioId, potreroId } = req.params;
      if (!isPredioIdValid(predioId) || !isPotreroIdValid(potreroId)) {
        res.status(400).json({ error: 'INVALID_POTRERO_ID' });
        return;
      }
      const { organizacionId } = req.ganaderiaAuth;
      const actual = await getCicloActual(organizacionId, predioId, potreroId);
      res.json({ actual });
    } catch (error) {
      if (sendSemanticError(res, error)) return;
      next(error);
    }
  });

  // GET .../ciclos-pastoreo/historial -- ciclos FINALIZADO/CANCELADO.
  router.get('/historial', async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const { predioId, potreroId } = req.params;
      if (!isPredioIdValid(predioId) || !isPotreroIdValid(potreroId)) {
        res.status(400).json({ error: 'INVALID_POTRERO_ID' });
        return;
      }
      const { organizacionId } = req.ganaderiaAuth;
      const historial = await getCicloHistorial(organizacionId, predioId, potreroId);
      res.json({ historial });
    } catch (error) {
      if (sendSemanticError(res, error)) return;
      next(error);
    }
  });

  // SPRINT-3D9.3 -- GET .../ciclos-pastoreo/aforo-base-preview -- muestra
  // ANTES de confirmar "Iniciar pastoreo" qué aforo se usaría como base
  // real (mismo doble guardrail que la resolución real al iniciar).
  // Read-only, nunca bloquea el inicio.
  router.get('/aforo-base-preview', async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const { predioId, potreroId } = req.params;
      if (!isPredioIdValid(predioId) || !isPotreroIdValid(potreroId)) {
        res.status(400).json({ error: 'INVALID_POTRERO_ID' });
        return;
      }
      const { organizacionId } = req.ganaderiaAuth;
      const preview = await previewFichaBaseReal(organizacionId, predioId, potreroId);
      res.json(preview);
    } catch (error) {
      if (sendSemanticError(res, error)) return;
      next(error);
    }
  });

  // POST .../ciclos-pastoreo/iniciar -- crea el ciclo (EN_CURSO) + evento
  // PASTOREO_INICIADO. Doble clic/requests concurrentes -> 409
  // CICLO_ALREADY_IN_PROGRESS (garantía DB, índice único parcial).
  router.post('/iniciar', async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const { predioId, potreroId } = req.params;
      if (!isPredioIdValid(predioId) || !isPotreroIdValid(potreroId)) {
        res.status(400).json({ error: 'INVALID_POTRERO_ID' });
        return;
      }
      const payload = validateIniciarBody(req.body);
      const { organizacionId, cuentaId } = req.ganaderiaAuth;

      const ciclo = await iniciarCicloPastoreo(organizacionId, predioId, potreroId, {
        ...payload, actorCuentaId: cuentaId,
      });
      res.status(201).json({ ok: true, ciclo });
    } catch (error) {
      if (sendSemanticError(res, error)) return;
      next(error);
    }
  });

  // POST .../ciclos-pastoreo/:cicloId/finalizar -- FASE A (crítica) +
  // FASE B (best-effort, descanso post-real). Idempotente: reintentar
  // sobre un ciclo ya FINALIZADO nunca duplica la transición, solo
  // reintenta el descanso si quedó PENDIENTE/ERROR_TECNICO. Siempre 200
  // si el ciclo existe y no está CANCELADO -- un descanso pendiente NUNCA
  // es un error HTTP (el hecho real ya es un éxito irrevocable).
  router.post('/:cicloId/finalizar', async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const { predioId, potreroId, cicloId } = req.params;
      if (!isPredioIdValid(predioId) || !isPotreroIdValid(potreroId) || !isCicloIdValid(cicloId)) {
        res.status(400).json({ error: 'INVALID_POTRERO_ID' });
        return;
      }
      const { organizacionId, cuentaId } = req.ganaderiaAuth;

      const resultado = await finalizarCicloPastoreo(organizacionId, predioId, potreroId, cicloId, {
        actorCuentaId: cuentaId,
      });
      res.json({ ok: true, ...resultado });
    } catch (error) {
      if (sendSemanticError(res, error)) return;
      next(error);
    }
  });

  // POST .../ciclos-pastoreo/:cicloId/cancelar -- solo EN_CURSO ->
  // CANCELADO. Motivo obligatorio. Nunca DELETE.
  router.post('/:cicloId/cancelar', async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const { predioId, potreroId, cicloId } = req.params;
      if (!isPredioIdValid(predioId) || !isPotreroIdValid(potreroId) || !isCicloIdValid(cicloId)) {
        res.status(400).json({ error: 'INVALID_POTRERO_ID' });
        return;
      }
      const payload = validateCancelarBody(req.body);
      const { organizacionId, cuentaId } = req.ganaderiaAuth;

      const ciclo = await cancelarCicloPastoreo(organizacionId, predioId, potreroId, cicloId, {
        ...payload, actorCuentaId: cuentaId,
      });
      res.json({ ok: true, ciclo });
    } catch (error) {
      if (sendSemanticError(res, error)) return;
      next(error);
    }
  });

  // SPRINT-3D9.2 -- POST .../ciclos-pastoreo/:cicloId/anular -- ciclo
  // histórico (FINALIZADO/CANCELADO) que nunca debió contar. Nunca sobre
  // EN_CURSO (usar Cancelar). Invalida atómicamente el descanso vigente
  // derivado, si existía.
  router.post('/:cicloId/anular', async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const { predioId, potreroId, cicloId } = req.params;
      if (!isPredioIdValid(predioId) || !isPotreroIdValid(potreroId) || !isCicloIdValid(cicloId)) {
        res.status(400).json({ error: 'INVALID_POTRERO_ID' });
        return;
      }
      const payload = validateAnularBody(req.body);
      const { organizacionId, cuentaId } = req.ganaderiaAuth;

      const ciclo = await anularCicloPastoreo(organizacionId, predioId, potreroId, cicloId, {
        ...payload, actorCuentaId: cuentaId,
      });
      res.json({ ok: true, ciclo });
    } catch (error) {
      if (sendSemanticError(res, error)) return;
      next(error);
    }
  });

  // SPRINT-3D9.2 -- POST .../ciclos-pastoreo/:cicloId/corregir -- dato
  // real capturado incorrectamente en un ciclo ya FINALIZADO. FASE
  // A'/B' (ver potreroCicloPastoreoRepository.js) -- si se corrige una
  // fecha, invalida atómicamente el descanso vigente y reintenta
  // generar la siguiente versión (best-effort).
  router.post('/:cicloId/corregir', async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const { predioId, potreroId, cicloId } = req.params;
      if (!isPredioIdValid(predioId) || !isPotreroIdValid(potreroId) || !isCicloIdValid(cicloId)) {
        res.status(400).json({ error: 'INVALID_POTRERO_ID' });
        return;
      }
      const payload = validateCorregirBody(req.body);
      const { organizacionId, cuentaId } = req.ganaderiaAuth;

      const resultado = await corregirCicloPastoreo(organizacionId, predioId, potreroId, cicloId, {
        ...payload, actorCuentaId: cuentaId,
      });
      res.json({ ok: true, ...resultado });
    } catch (error) {
      if (sendSemanticError(res, error)) return;
      next(error);
    }
  });

  // SPRINT-3D9.2 -- POST .../ciclos-pastoreo/evaluar-reingreso -- el
  // sistema NUNCA decide APTO/NO_APTO, solo registra el juicio humano
  // respaldado por un aforo nuevo. Solo aplica con estado operativo
  // EVALUACION_REINGRESO.
  router.post('/evaluar-reingreso', async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const { predioId, potreroId } = req.params;
      if (!isPredioIdValid(predioId) || !isPotreroIdValid(potreroId)) {
        res.status(400).json({ error: 'INVALID_POTRERO_ID' });
        return;
      }
      const payload = validateEvaluarReingresoBody(req.body);
      const { organizacionId, cuentaId } = req.ganaderiaAuth;

      const evaluacion = await evaluarReingreso(organizacionId, predioId, potreroId, {
        ...payload, actorCuentaId: cuentaId,
      });
      res.status(201).json({ ok: true, evaluacion });
    } catch (error) {
      if (sendSemanticError(res, error)) return;
      next(error);
    }
  });

  // SPRINT-3D9.2 -- GET .../ciclos-pastoreo/estado-operativo -- estado
  // derivado (DISPONIBLE/EN_PASTOREO/EN_DESCANSO/EVALUACION_REINGRESO/
  // ARCHIVADO). Lectura pura, nunca dispara ninguna acción.
  router.get('/estado-operativo', async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const { predioId, potreroId } = req.params;
      if (!isPredioIdValid(predioId) || !isPotreroIdValid(potreroId)) {
        res.status(400).json({ error: 'INVALID_POTRERO_ID' });
        return;
      }
      const { organizacionId } = req.ganaderiaAuth;
      const estadoOperativo = await getEstadoOperativoPotrero(organizacionId, predioId, potreroId);
      res.json({ estadoOperativo });
    } catch (error) {
      if (sendSemanticError(res, error)) return;
      next(error);
    }
  });

  return router;
}
