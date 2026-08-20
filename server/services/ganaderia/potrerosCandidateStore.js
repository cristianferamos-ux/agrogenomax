// SPRINT-3D3-POTREROS-API-FOUNDATION: almacén temporal de candidatos de
// Potreros, en memoria de proceso -- mismo patrón exacto que
// prediosCandidateStore.js (state machine AVAILABLE -> PROCESSING ->
// CONSUMED, TTL 15 min, candidateId cripto-aleatorio, reserve() síncrono
// sin ventana de carrera dentro de un único proceso Node).
//
// Diferencia respecto a Predios: cada candidato de Potrero queda además
// ligado a un `predioId` concreto (regla de dominio ORGANIZACIÓN -> PREDIO
// -> POTRERO, §7 del sprint). Un candidato generado bajo un predio NO
// puede confirmarse bajo otro predio, aunque pertenezca a la misma
// organización/cuenta -- reservePotreroCandidate() distingue ese caso
// ('scope_mismatch') del caso cross-tenant real ('forbidden', que se
// pliega junto con 'not_found' en el router para no revelar existencia).
import { randomBytes } from 'node:crypto';

const CANDIDATE_TTL_MS = 15 * 60 * 1000; // §7: TTL 15 minutos

const STATE = Object.freeze({
  AVAILABLE: 'AVAILABLE',
  PROCESSING: 'PROCESSING',
  CONSUMED: 'CONSUMED',
});

const store = new Map();

function buildCandidateId() {
  return `potcand_${randomBytes(32).toString('base64url')}`;
}

function purgeExpired(now = Date.now()) {
  for (const [id, record] of store) {
    if (now - record.createdAt > CANDIDATE_TTL_MS) {
      store.delete(id);
    }
  }
}

/**
 * Crea un candidato ligado a organizacionId + cuentaId + predioId (§7).
 * `geometry` (GeoJSON), `areaHa` y `metodoDelimitacion` ya fueron
 * calculados/validados server-side (ST_IsValid + ST_CoveredBy + ST_Area)
 * antes de llegar aquí -- nunca datos crudos del cliente. Estado inicial:
 * AVAILABLE.
 */
export function createPotreroCandidate({ organizacionId, cuentaId, predioId, geometry, areaHa, metodoDelimitacion }) {
  purgeExpired();

  const candidateId = buildCandidateId();
  const now = Date.now();
  store.set(candidateId, {
    candidateId,
    organizacionId,
    cuentaId,
    predioId: String(predioId),
    geometry,
    areaHa,
    metodoDelimitacion,
    createdAt: now,
    state: STATE.AVAILABLE,
  });

  return candidateId;
}

/**
 * Reserva un candidato AVAILABLE -- primer paso del flujo de confirmación,
 * antes de abrir la transacción de negocio (mismo patrón que Predios,
 * §8 del sprint).
 *
 * Resultado semántico:
 *   - 'not_found'      -> candidateId inexistente/alterado
 *   - 'expired'        -> pasó el TTL (410)
 *   - 'forbidden'      -> pertenece a otra organización/cuenta (nunca se
 *                         distingue de 'not_found' en la respuesta HTTP)
 *   - 'in_use'         -> otra solicitud ya lo tiene en PROCESSING
 *   - 'consumed'       -> ya fue confirmado exitosamente antes
 *   - 'scope_mismatch' -> misma organización/cuenta, pero el candidato fue
 *                         generado para OTRO predioId (§7: "Candidate
 *                         generado para LA PRIMAVERA NO puede confirmarse
 *                         usando otro predioId"). Distinguible de
 *                         'forbidden' porque el llamador ya es el dueño
 *                         legítimo del candidato -- no hay fuga de
 *                         información cross-tenant al reportarlo aparte.
 *   - 'ok'              -> pasó a PROCESSING, devuelve geometry/areaHa/metodoDelimitacion
 */
export function reservePotreroCandidate({ candidateId, organizacionId, cuentaId, predioId }) {
  // Deliberadamente sin purgeExpired() aquí -- ver justificación idéntica
  // en prediosCandidateStore.js (distinguir 'expired' de 'not_found').
  const record = store.get(candidateId);
  if (!record) return { status: 'not_found' };

  if (Date.now() - record.createdAt > CANDIDATE_TTL_MS) {
    store.delete(candidateId);
    return { status: 'expired' };
  }

  if (record.state === STATE.CONSUMED) {
    return { status: 'consumed' };
  }

  if (record.state === STATE.PROCESSING) {
    return { status: 'in_use' };
  }

  if (record.organizacionId !== organizacionId || record.cuentaId !== cuentaId) {
    return { status: 'forbidden' };
  }

  if (record.predioId !== String(predioId)) {
    return { status: 'scope_mismatch' };
  }

  record.state = STATE.PROCESSING;
  return {
    status: 'ok',
    geometry: record.geometry,
    areaHa: record.areaHa,
    metodoDelimitacion: record.metodoDelimitacion,
  };
}

/**
 * Confirma un candidato ya reservado como consumido -- SOLO tras COMMIT
 * exitoso de la transacción de negocio. Terminal. No-op silencioso si el
 * candidate ya no existe.
 */
export function commitPotreroCandidate(candidateId) {
  const record = store.get(candidateId);
  if (!record) return;
  record.state = STATE.CONSUMED;
}

/**
 * Libera un candidato reservado de vuelta a AVAILABLE -- tras ROLLBACK de
 * la transacción de negocio, para que la misma búsqueda pueda reintentarse.
 */
export function releasePotreroCandidate(candidateId) {
  const record = store.get(candidateId);
  if (!record) return;
  if (record.state === STATE.PROCESSING) {
    record.state = STATE.AVAILABLE;
  }
}

export function __resetPotrerosCandidateStoreForTests() {
  store.clear();
}

export function __hasPotreroCandidateForTests(candidateId) {
  return store.has(candidateId);
}

export function __getPotreroCandidateStateForTests(candidateId) {
  return store.get(candidateId)?.state ?? null;
}
