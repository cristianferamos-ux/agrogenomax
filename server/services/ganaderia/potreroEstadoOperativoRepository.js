// SPRINT-3D9.2 -- ESTADO OPERATIVO DERIVADO DEL POTRERO
//
// Nunca persistido/duplicado -- se calcula en cada consulta a partir de
// hechos ya existentes (predio/potrero.estado, ciclos, descanso vigente,
// evaluaciones de reingreso). Precedencia exacta (se detiene en el
// primer match):
//
//   1. predio.estado = 'ARCHIVADO'                       -> ARCHIVADO / PREDIO_ARCHIVADO
//   2. potrero.estado = 'ARCHIVADO'                       -> ARCHIVADO / POTRERO_ARCHIVADO
//   3. ciclo EN_CURSO                                     -> EN_PASTOREO
//   4. último ciclo FINALIZADO (CANCELADO/ANULADO NUNCA
//      participan -- filtro POSITIVO por estado='FINALIZADO',
//      nunca una exclusión negativa)
//      4a. no existe ninguno                              -> DISPONIBLE
//      4b. descanso vigente no resoluble (nunca generado /
//          invalidado sin reemplazo)                       -> EN_DESCANSO (reason: ASSESSMENT_PENDING)
//      4c. hoy < fecha_reingreso_min                        -> EN_DESCANSO (reason: ANTES_DE_VENTANA)
//      4d. hoy >= fecha_reingreso_min, sin evaluación APTO   -> EVALUACION_REINGRESO
//      4e. hoy >= fecha_reingreso_min, con evaluación APTO   -> DISPONIBLE
//
// Este módulo es puro lectura -- todas las funciones reciben un `client`
// ya dentro de una transacción/organización resuelta (withOrganizacionTransaction
// en el llamador), nunca abren su propia conexión.
import { withOrganizacionTransaction } from '../../db/agxBusinessPool.js';
import { fetchDescansoVigentePorCiclo } from './potreroDescansoRepository.js';
import { resolveFechaHoyNegocio } from './motorDescansoAuto/businessTimezone.js';

function semanticError(code, status, message) {
  return Object.assign(new Error(message || code), { status, code });
}

function assertPredioIdFormat(predioId) {
  if (!/^\d+$/.test(String(predioId))) {
    throw semanticError('INVALID_PREDIO_ID', 400, 'predioId inválido.');
  }
}

function assertPotreroIdFormat(potreroId) {
  if (!/^\d+$/.test(String(potreroId))) {
    throw semanticError('INVALID_POTRERO_ID', 400, 'potreroId inválido.');
  }
}

async function assertPotreroBelongsToPredio(client, predioId, potreroId) {
  const result = await client.query(
    'select potrero_id from agx.potreros where potrero_id = $1 and predio_id = $2',
    [potreroId, predioId],
  );
  if (result.rows.length === 0) {
    throw semanticError('POTRERO_NOT_FOUND', 404, 'El potrero no existe, no pertenece a este predio o no pertenece a tu organización.');
  }
}

async function fetchPredioEstado(client, predioId) {
  const result = await client.query('select estado from agx.predios where predio_id = $1', [predioId]);
  return result.rows[0]?.estado ?? null;
}

async function fetchPotreroEstado(client, potreroId) {
  const result = await client.query('select estado from agx.potreros where potrero_id = $1', [potreroId]);
  return result.rows[0]?.estado ?? null;
}

async function fetchCicloEnCurso(client, potreroId) {
  const result = await client.query(
    `select ciclo_id from agx.potrero_ciclos_pastoreo where potrero_id = $1 and estado = 'EN_CURSO' limit 1`,
    [potreroId],
  );
  return result.rows[0]?.ciclo_id ?? null;
}

// Filtro POSITIVO por estado='FINALIZADO' -- CANCELADO y ANULADO nunca
// entran a esta selección, no requieren exclusión explícita (SPRINT-3D9.2
// DESIGN REVISION, punto 2: "el descanso del ciclo A [FINALIZADO] SIGUE
// gobernando" aunque exista un ciclo B CANCELADO más reciente).
async function fetchUltimoCicloFinalizado(client, potreroId) {
  const result = await client.query(
    `select ciclo_id from agx.potrero_ciclos_pastoreo
      where potrero_id = $1 and estado = 'FINALIZADO'
      order by fecha_salida_real desc, created_at desc
      limit 1`,
    [potreroId],
  );
  return result.rows[0]?.ciclo_id ?? null;
}

async function existeEvaluacionApto(client, descansoId) {
  const result = await client.query(
    `select 1 from agx.potrero_evaluaciones_reingreso where descanso_id = $1 and resultado = 'APTO' limit 1`,
    [descansoId],
  );
  return result.rows.length > 0;
}

/**
 * Estado operativo derivado -- para mostrar en UI (GET .../estado-operativo)
 * y para que el reentry guard de iniciarCicloPastoreo lo reutilice sin
 * duplicar lógica.
 */
export async function resolveEstadoOperativoPotrero(client, { predioId, potreroId, now } = {}) {
  const predioEstado = await fetchPredioEstado(client, predioId);
  if (predioEstado === 'ARCHIVADO') {
    return { estado: 'ARCHIVADO', reason: 'PREDIO_ARCHIVADO' };
  }
  const potreroEstado = await fetchPotreroEstado(client, potreroId);
  if (potreroEstado === 'ARCHIVADO') {
    return { estado: 'ARCHIVADO', reason: 'POTRERO_ARCHIVADO' };
  }

  const cicloEnCursoId = await fetchCicloEnCurso(client, potreroId);
  if (cicloEnCursoId) {
    return { estado: 'EN_PASTOREO' };
  }

  const cicloOrigenId = await fetchUltimoCicloFinalizado(client, potreroId);
  if (!cicloOrigenId) {
    return { estado: 'DISPONIBLE' };
  }

  const descansoVigente = await fetchDescansoVigentePorCiclo(client, cicloOrigenId);
  if (!descansoVigente) {
    return { estado: 'EN_DESCANSO', reason: 'ASSESSMENT_PENDING', cicloOrigenId: String(cicloOrigenId) };
  }

  const hoy = resolveFechaHoyNegocio(now);
  if (hoy < descansoVigente.fechaReingresoMin) {
    return {
      estado: 'EN_DESCANSO',
      reason: 'ANTES_DE_VENTANA',
      cicloOrigenId: String(cicloOrigenId),
      descanso: descansoVigente,
    };
  }

  const apto = await existeEvaluacionApto(client, Number(descansoVigente.descansoId));
  if (!apto) {
    return {
      estado: 'EVALUACION_REINGRESO',
      cicloOrigenId: String(cicloOrigenId),
      descanso: descansoVigente,
    };
  }

  return { estado: 'DISPONIBLE' };
}

function diasEntre(fechaIso, hoyIso) {
  const [a1, m1, d1] = hoyIso.split('-').map(Number);
  const [a2, m2, d2] = fechaIso.split('-').map(Number);
  const hoyMs = Date.UTC(a1, m1 - 1, d1);
  const fechaMs = Date.UTC(a2, m2 - 1, d2);
  return Math.round((fechaMs - hoyMs) / (24 * 60 * 60 * 1000));
}

/**
 * Reentry guard -- backend es la autoridad final (nunca solo frontend).
 * Lanza el código semántico correspondiente si el potrero NO puede
 * iniciar un ciclo nuevo; retorna silenciosamente si puede.
 */
export async function assertPuedeIniciarCiclo(client, { predioId, potreroId, now } = {}) {
  const estado = await resolveEstadoOperativoPotrero(client, { predioId, potreroId, now });

  if (estado.estado === 'ARCHIVADO') {
    if (estado.reason === 'PREDIO_ARCHIVADO') {
      throw semanticError('PREDIO_ARCHIVADO', 409, 'Este predio está archivado -- no se pueden iniciar nuevos ciclos.');
    }
    throw semanticError('POTRERO_ARCHIVADO', 409, 'Este potrero está archivado -- no se pueden iniciar nuevos ciclos.');
  }

  if (estado.estado === 'EN_DESCANSO' && estado.reason === 'ASSESSMENT_PENDING') {
    const error = semanticError('POTRERO_REST_ASSESSMENT_PENDING', 409, 'Todavía no se pudo calcular el descanso del último pastoreo -- reintenta "Finalizar" o espera unos minutos.');
    error.cicloOrigenId = estado.cicloOrigenId;
    throw error;
  }

  if (estado.estado === 'EN_DESCANSO' && estado.reason === 'ANTES_DE_VENTANA') {
    const hoy = resolveFechaHoyNegocio(now);
    const error = semanticError('POTRERO_IN_REST_PERIOD', 409, 'Este potrero está en descanso -- todavía no puede reingresar.');
    error.fechaReingresoMin = estado.descanso.fechaReingresoMin;
    error.fechaReingresoRecomendada = estado.descanso.fechaReingresoRecomendada;
    error.fechaReingresoMax = estado.descanso.fechaReingresoMax;
    error.diasRestantes = diasEntre(estado.descanso.fechaReingresoMin, hoy);
    error.descansoId = estado.descanso.descansoId;
    error.cicloOrigenId = estado.cicloOrigenId;
    throw error;
  }

  if (estado.estado === 'EVALUACION_REINGRESO') {
    const error = semanticError('POTRERO_REINGRESO_NO_CONFIRMADO', 409, 'La ventana de reingreso ya se abrió, pero todavía no se confirmó con un nuevo aforo -- evalúa el reingreso antes de iniciar.');
    error.fechaReingresoMin = estado.descanso.fechaReingresoMin;
    error.fechaReingresoRecomendada = estado.descanso.fechaReingresoRecomendada;
    error.fechaReingresoMax = estado.descanso.fechaReingresoMax;
    error.descansoId = estado.descanso.descansoId;
    error.cicloOrigenId = estado.cicloOrigenId;
    throw error;
  }

  // EN_PASTOREO se detecta después por el índice único parcial
  // (CICLO_ALREADY_IN_PROGRESS, 23505) -- defensa en profundidad ya
  // existente desde 3D9.1, no se duplica aquí.
}

/** Lectura pura -- GET .../estado-operativo. */
export async function getEstadoOperativoPotrero(organizacionId, predioId, potreroId) {
  assertPredioIdFormat(predioId);
  assertPotreroIdFormat(potreroId);

  return withOrganizacionTransaction(organizacionId, async (client) => {
    await assertPotreroBelongsToPredio(client, predioId, potreroId);
    return resolveEstadoOperativoPotrero(client, { predioId, potreroId });
  });
}
