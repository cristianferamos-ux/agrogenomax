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
// en el llamador), nunca abren su propia conexión. Única excepción
// (SPRINT-3D10.8.1): `declararDescansoProductor`, cuya precondición es
// exactamente el estado 4b de arriba -- vive aquí para reutilizar
// resolveEstadoOperativoPotrero sin crear un import circular con
// potreroDescansoRepository.js.
import { withOrganizacionTransaction } from '../../db/agxBusinessPool.js';
import {
  fetchDescansoVigentePorCiclo,
  resolveMotivoDescansoPendiente,
  insertDescansoDeclaradoProductorEnTx,
  MOTIVO_DESCANSO_PENDIENTE,
  DIAS_DESCANSO_DECLARADO_MIN,
  DIAS_DESCANSO_DECLARADO_MAX,
} from './potreroDescansoRepository.js';
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
    `select ciclo_id, to_char(fecha_salida_real, 'YYYY-MM-DD') as fecha_salida_real
       from agx.potrero_ciclos_pastoreo
      where potrero_id = $1 and estado = 'FINALIZADO'
      order by fecha_salida_real desc, created_at desc
      limit 1`,
    [potreroId],
  );
  return result.rows[0] ?? null;
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

  const cicloOrigen = await fetchUltimoCicloFinalizado(client, potreroId);
  if (!cicloOrigen) {
    return { estado: 'DISPONIBLE' };
  }
  const cicloOrigenId = cicloOrigen.ciclo_id;

  const descansoVigente = await fetchDescansoVigentePorCiclo(client, cicloOrigenId);
  if (!descansoVigente) {
    // SPRINT-3D10.8.1: motivo derivado (nunca persistido) -- permite a la
    // UI ofrecer "Reintentar" (REINTENTABLE) o declarar el descanso
    // (NO_PASTURE_PROFILE) en vez de dejar el potrero sin salida.
    const { motivo } = await resolveMotivoDescansoPendiente(client, { cicloId: cicloOrigenId, potreroId });
    return {
      estado: 'EN_DESCANSO',
      reason: 'ASSESSMENT_PENDING',
      cicloOrigenId: String(cicloOrigenId),
      motivoDescansoPendiente: motivo,
      fechaSalidaReal: cicloOrigen.fecha_salida_real,
    };
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
    const error = semanticError('POTRERO_REST_ASSESSMENT_PENDING', 409, 'Todavía no se pudo calcular el descanso del último pastoreo -- reintenta el cálculo de descanso o declara los días de descanso.');
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

function resolverDescansoExistente(vigente, diasDescanso) {
  if (vigente.origenDescanso === 'DECLARADO_PRODUCTOR' && vigente.diasDescansoMin === diasDescanso) {
    return { descanso: vigente, yaExistia: true };
  }
  throw semanticError('DESCANSO_YA_EXISTE', 409, 'Este potrero ya tiene un descanso registrado para el último pastoreo.');
}

/**
 * SPRINT-3D10.8.1 -- POST .../ciclos-pastoreo/:cicloId/descanso-declarado.
 * El productor declara N días de descanso SOLO cuando el ciclo es el
 * origen del ASSESSMENT_PENDING actual y la causa es NO_PASTURE_PROFILE --
 * nunca como override de un descanso calculable.
 *
 * Idempotencia/concurrencia: lock FOR UPDATE sobre el ciclo (mismo patrón
 * que generarDescansoPostCicloRealSiguienteVersion) + unique
 * (ciclo_pastoreo_id, version). Reintento con los mismos días -> 200
 * yaExistia; días distintos o descanso calculado vigente -> 409
 * DESCANSO_YA_EXISTE.
 */
export async function declararDescansoProductor(organizacionId, predioId, potreroId, cicloId, {
  diasDescanso, actorCuentaId, now,
} = {}) {
  assertPredioIdFormat(predioId);
  assertPotreroIdFormat(potreroId);
  if (!/^\d+$/.test(String(cicloId))) {
    throw semanticError('INVALID_CICLO_ID', 400, 'cicloId inválido.');
  }
  if (!Number.isInteger(diasDescanso) || diasDescanso < DIAS_DESCANSO_DECLARADO_MIN || diasDescanso > DIAS_DESCANSO_DECLARADO_MAX) {
    throw semanticError('INVALID_DIAS_DESCANSO_DECLARADO', 400, `diasDescanso debe ser un entero entre ${DIAS_DESCANSO_DECLARADO_MIN} y ${DIAS_DESCANSO_DECLARADO_MAX}.`);
  }

  return withOrganizacionTransaction(organizacionId, async (client) => {
    const cicloResult = await client.query(
      `select ciclo_id, estado, recomendacion_descanso_plan_id,
              to_char(fecha_ingreso_real, 'YYYY-MM-DD') as fecha_ingreso_real,
              to_char(fecha_salida_real, 'YYYY-MM-DD') as fecha_salida_real
         from agx.potrero_ciclos_pastoreo
        where ciclo_id = $1 and potrero_id = $2 and predio_id = $3
        for update`,
      [cicloId, potreroId, predioId],
    );
    if (cicloResult.rows.length === 0) {
      throw semanticError('CICLO_NOT_FOUND', 404, 'El ciclo de pastoreo no existe o no pertenece a este potrero.');
    }
    const ciclo = cicloResult.rows[0];

    const vigente = await fetchDescansoVigentePorCiclo(client, cicloId);
    if (vigente) {
      return resolverDescansoExistente(vigente, diasDescanso);
    }

    const noAplica = () => semanticError(
      'DESCANSO_DECLARADO_NO_APLICA',
      409,
      'Este potrero no requiere declarar el descanso manualmente.',
    );
    const estado = await resolveEstadoOperativoPotrero(client, { predioId, potreroId, now });
    if (estado.estado !== 'EN_DESCANSO' || estado.reason !== 'ASSESSMENT_PENDING' || estado.cicloOrigenId !== String(ciclo.ciclo_id)) {
      throw noAplica();
    }
    const motivo = await resolveMotivoDescansoPendiente(client, { cicloId, potreroId });
    if (motivo.motivo !== MOTIVO_DESCANSO_PENDIENTE.NO_PASTURE_PROFILE) {
      throw noAplica();
    }

    const resultado = await insertDescansoDeclaradoProductorEnTx(client, organizacionId, {
      predioId,
      potreroId,
      ciclo,
      diasDescanso,
      recomendacionRow: motivo.recomendacionRow,
      fichaRow: motivo.fichaRow,
      nombresPastura: motivo.nombresPastura,
      actorCuentaId,
      now,
    });
    if (resultado.conflicto) {
      const ganador = await fetchDescansoVigentePorCiclo(client, cicloId);
      if (!ganador) throw semanticError('DESCANSO_YA_EXISTE', 409, 'Este potrero ya tiene un descanso registrado para el último pastoreo.');
      return resolverDescansoExistente(ganador, diasDescanso);
    }
    return { descanso: resultado.descanso, yaExistia: false };
  });
}
