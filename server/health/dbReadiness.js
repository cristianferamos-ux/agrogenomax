/**
 * Motor genérico de readiness sobre un `pg.Pool` (LOTE-007, ADR-012 §7/§14).
 *
 * Reglas obligatorias implementadas aquí:
 * - Inspecciona el estado interno del pool (síncrono, sin red) antes de
 *   consultar; si ya indica saturación evidente, reporta `pool_exhausted`
 *   sin ejecutar ninguna consulta adicional.
 * - Timeout estricto sobre la verificación real, cero reintentos. El mismo
 *   `timeoutMs` se aplica también como `query_timeout` de node-postgres en
 *   cada consulta real (carrera de promesas + límite del propio driver),
 *   y se entrega a `run` para que cualquier consulta adicional lo use.
 * - Deduplica verificaciones concurrentes sobre el mismo `pool` (una
 *   verificación en curso se reutiliza, nunca se dispara una segunda).
 * - Caché interna muy breve del resultado -- nunca una caché HTTP.
 * - Clasifica causas sin exponer jamás `error.message` crudo del driver.
 */

const DEFAULT_TIMEOUT_MS = 800;
const DEFAULT_CACHE_MS = 2000;

// Estado por pool (caché + verificación en curso), aislado por instancia --
// nunca se comparte entre el pool de `agx` y el de CatastroX porque la
// clave es la propia referencia del objeto Pool.
const poolStates = new WeakMap();

function inspectSaturation(pool) {
  if (
    typeof pool.totalCount !== 'number' ||
    typeof pool.idleCount !== 'number' ||
    typeof pool.waitingCount !== 'number'
  ) {
    return null;
  }

  const max = typeof pool.options?.max === 'number' ? pool.options.max : null;
  if (max && pool.totalCount >= max && pool.idleCount === 0 && pool.waitingCount > 0) {
    return 'pool_exhausted';
  }

  return null;
}

function classifyDriverError(error) {
  if (typeof error?.readinessCode === 'string' && error.readinessCode.trim() !== '') {
    return error.readinessCode;
  }

  const code = error?.code;
  if (code === '28P01' || code === '28000') return 'auth_failed';
  if (code === '3F000' || code === '42P01' || code === '3D000') return 'schema_missing';

  // Cualquier otra causa (host inalcanzable, conexión rechazada, error no
  // clasificado) se reporta de forma conservadora como no alcanzable --
  // nunca se propaga `error.message` crudo del driver `pg`.
  return 'database_unreachable';
}

function withTimeout(promise, timeoutMs) {
  let timer;

  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error('readiness check timed out');
      error.readinessCode = 'query_timeout';
      reject(error);
    }, timeoutMs);
  });

  // Evita "unhandled rejection" si la promesa original falla después de
  // que el timeout ya decidió el resultado de la carrera.
  promise.catch(() => {});

  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

/**
 * @param {import('pg').Pool} pool
 * @param {{timeoutMs?: number, cacheMs?: number, run?: (pool: import('pg').Pool, timeoutMs: number) => Promise<void>}} options
 * @returns {Promise<{ok: boolean, code: string}>}
 */
export function checkPostgresReadiness(pool, options = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, cacheMs = DEFAULT_CACHE_MS, run } = options;

  if (!pool) {
    return Promise.resolve({ ok: false, code: 'not_configured' });
  }

  const now = Date.now();
  const state = poolStates.get(pool);

  if (state?.result && now - state.resultAt < cacheMs) {
    return Promise.resolve(state.result);
  }

  if (state?.inFlight) {
    return state.inFlight;
  }

  const executeCheck = async () => {
    const saturationCode = inspectSaturation(pool);
    if (saturationCode) {
      return { ok: false, code: saturationCode };
    }

    try {
      await withTimeout(
        Promise.resolve().then(() =>
          run ? run(pool, timeoutMs) : pool.query({ text: 'select 1', query_timeout: timeoutMs }),
        ),
        timeoutMs,
      );
      return { ok: true, code: 'ok' };
    } catch (error) {
      return { ok: false, code: classifyDriverError(error) };
    }
  };

  const inFlight = executeCheck().then((result) => {
    poolStates.set(pool, { result, resultAt: Date.now(), inFlight: null });
    return result;
  });

  poolStates.set(pool, { ...(state || {}), inFlight });
  return inFlight;
}

// Exclusivamente para pruebas unitarias aisladas: limpia el estado
// (caché/verificación en curso) asociado a un `pool` de prueba concreto.
export function __resetReadinessStateForTests(pool) {
  poolStates.delete(pool);
}
