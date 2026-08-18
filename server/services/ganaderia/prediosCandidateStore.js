// SPRINT-3C1-MIS-PREDIOS-API §9/§10/§11 + SPRINT-3C1.1 §1/§2: almacén
// temporal de candidatos CatastroX resueltos por "Mis Predios", en
// memoria de proceso (mismo patrón/alcance que lookupPreviewStore de
// catastrox.js -- válido para una sola instancia, documentado como
// riesgo residual si se escala horizontalmente sin un store compartido,
// ver informe).
//
// Propósito de seguridad (§9, CRÍTICO): el frontend NUNCA envía geometry
// al guardar un predio automático. Cada búsqueda válida (coordenadas o
// código) genera un candidateId aleatorio criptográfico que referencia,
// server-side, el resultado CatastroX EXACTO ya resuelto. El endpoint de
// guardado (POST /api/ganaderia/predios) solo recibe ese candidateId --
// nunca geometry/codigoPredial/areaCatastral/fuente del cliente.
//
// SPRINT-3C1.1 §1/§2: state machine explícita -- el bug real del diseño
// original era marcar el candidate "consumed" en el mismo paso que lo
// valida, ANTES de que la transacción de negocio (INSERT predio+snapshot)
// siquiera empezara. Si esa transacción fallaba (ROLLBACK), el candidate
// quedaba consumido para siempre aunque el predio nunca se hubiera
// creado -- el usuario perdía su búsqueda sin haber logrado nada.
//
//   AVAILABLE  -- recién creado, o liberado tras un fallo de negocio.
//   PROCESSING -- reservado por una solicitud en curso (reserve()).
//                 Un segundo reserve() concurrente sobre el MISMO
//                 candidateId falla con 'in_use' (409) mientras dure.
//   CONSUMED   -- la transacción de negocio confirmó éxito (commit()).
//                 Terminal, nunca vuelve a AVAILABLE.
//
// reserve()/commit()/release() son síncronas y operan sobre un Map en
// memoria de un único proceso Node -- Node es single-threaded y ninguna
// de las tres funciones hace await internamente, así que la transición
// AVAILABLE->PROCESSING de reserve() es atómica de hecho (sin ventana
// para una segunda solicitud concurrente entre el chequeo y la
// escritura), incluso sin lock explícito. Esto NO se sostiene si el
// proceso se escala horizontalmente (múltiples instancias, cada una con
// su propio Map) -- riesgo residual ya documentado, requeriría un store
// compartido (Redis/Postgres) para ser correcto multi-instancia.
import { randomBytes } from 'node:crypto';

const CANDIDATE_TTL_MS = 15 * 60 * 1000; // §9: TTL recomendado 15 minutos

const STATE = Object.freeze({
  AVAILABLE: 'AVAILABLE',
  PROCESSING: 'PROCESSING',
  CONSUMED: 'CONSUMED',
});

const store = new Map();

function buildCandidateId() {
  // §9: criptográficamente aleatorio, NO secuencial. 32 bytes -> 256 bits
  // de entropía, codificado base64url (sin relleno, seguro en URL/JSON).
  return `pcand_${randomBytes(32).toString('base64url')}`;
}

function purgeExpired(now = Date.now()) {
  for (const [id, record] of store) {
    if (now - record.createdAt > CANDIDATE_TTL_MS) {
      store.delete(id);
    }
  }
}

/**
 * Crea un candidato ligado a organizacionId + cuentaId (§10, decisión MVP:
 * ligado a cuenta + organización -- más simple y más seguro que compartir
 * entre todos los miembros de la organización). Estado inicial: AVAILABLE.
 */
export function createPredioCandidate({ organizacionId, cuentaId, predio }) {
  purgeExpired();

  const candidateId = buildCandidateId();
  const now = Date.now();
  store.set(candidateId, {
    candidateId,
    organizacionId,
    cuentaId,
    predio,
    createdAt: now,
    state: STATE.AVAILABLE,
  });

  return candidateId;
}

/**
 * Reserva un candidato AVAILABLE para procesarlo -- primer paso del flujo
 * de guardado automático, ANTES de abrir la transacción de negocio.
 *
 * Resultado semántico (§1/§10/§11):
 *   - 'not_found'  -> candidateId inexistente/alterado
 *   - 'expired'    -> pasó el TTL (410 Gone)
 *   - 'forbidden'  -> pertenece a otra organización/cuenta (nunca se
 *                     distingue de 'not_found' en la respuesta HTTP, para
 *                     no revelar que el candidateId existía -- ver router)
 *   - 'in_use'     -> otra solicitud ya lo tiene en PROCESSING ahora mismo
 *                     (409 CANDIDATE_IN_USE)
 *   - 'consumed'   -> ya fue confirmado exitosamente antes (409)
 *   - 'ok'         -> pasó a PROCESSING, devuelve `predio`
 */
export function reservePredioCandidate({ candidateId, organizacionId, cuentaId }) {
  // Deliberadamente NO se llama a purgeExpired() aquí (a diferencia de
  // createPredioCandidate) -- purgar primero borraría este candidateId
  // específico si ya expiró, y la búsqueda posterior lo confundiría con
  // 'not_found' (alterado/inexistente) en vez de 'expired' (410 Gone,
  // distinción real que el router necesita, §11).
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

  record.state = STATE.PROCESSING;
  return { status: 'ok', predio: record.predio };
}

/**
 * Confirma un candidato ya reservado como consumido -- SOLO tras COMMIT
 * exitoso de la transacción de negocio (§2). Terminal: nunca vuelve a
 * AVAILABLE. No-op silencioso si el candidate ya no existe (expiró justo
 * en el borde) -- el predio ya se creó de todas formas, no hay nada que
 * revertir por este lado.
 */
export function commitPredioCandidate(candidateId) {
  const record = store.get(candidateId);
  if (!record) return;
  record.state = STATE.CONSUMED;
}

/**
 * Libera un candidato reservado de vuelta a AVAILABLE -- tras ROLLBACK de
 * la transacción de negocio (§2), para que la misma búsqueda pueda
 * reintentarse sin obligar al usuario a repetirla desde cero.
 *
 * Excepción documentada (§1, "corrupción/invalidez del propio
 * candidate"): en el diseño actual NO existe ningún caso real donde un
 * fallo de la transacción de negocio invalide el candidate EN SÍ MISMO
 * -- incluso el conflicto de codigo_predial duplicado (23505) es un
 * choque contra el estado actual de agx.predios, no una corrupción del
 * resultado CatastroX que el candidate contiene (que sigue siendo válido
 * y re-consultable). Por eso release() se aplica uniformemente ante
 * cualquier fallo de negocio, sin distinguir causas. Si en el futuro
 * apareciera un caso real de candidate corrupto, debe manejarse ANTES de
 * llegar aquí (rechazando el reserve()), no cambiando esta función.
 */
export function releasePredioCandidate(candidateId) {
  const record = store.get(candidateId);
  if (!record) return;
  if (record.state === STATE.PROCESSING) {
    record.state = STATE.AVAILABLE;
  }
}

export function __resetPrediosCandidateStoreForTests() {
  store.clear();
}

export function __hasPredioCandidateForTests(candidateId) {
  return store.has(candidateId);
}

export function __getPredioCandidateStateForTests(candidateId) {
  return store.get(candidateId)?.state ?? null;
}
