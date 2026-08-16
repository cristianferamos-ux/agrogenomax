import { getAgxAuthPool } from '../db/agxAuthPool.js';

// AUTH-001 (aprobado v2.2, §3/§7): rate limiting con PostgreSQL como
// única fuente de verdad -- correcto con múltiples instancias Railway
// por construcción, sin depender de estado en memoria. `express-rate-limit`
// (server/middleware/rateLimit.js) puede seguir existiendo como defensa
// auxiliar barata, pero NUNCA como frontera de seguridad para /login.
//
// Nunca `SELECT count(*) -> decisión en Node -> INSERT` (condición de
// carrera) -- una sola sentencia `INSERT ... ON CONFLICT DO UPDATE`,
// atómica por el bloqueo de fila que Postgres aplica sobre el `UPSERT`.

export const RATE_LIMIT_WINDOW_SECONDS = 15 * 60;
export const RATE_LIMIT_THRESHOLDS = Object.freeze({ email: 5, ip: 100 });

/**
 * Incrementa atómicamente el contador de `dimension`/`keyFingerprint` y
 * decide si debe throttlearse -- nunca decide con un `SELECT` previo.
 *
 * @param {'email'|'ip'} dimension
 * @param {string} keyFingerprint - hex 64 caracteres (computeFingerprint)
 * @returns {Promise<{throttled: boolean, attemptCount: number, retryAfterSeconds: number|null}>}
 */
export async function checkAndIncrementRateLimit(dimension, keyFingerprint) {
  const pool = getAgxAuthPool();
  const result = await pool.query(
    `insert into agx.auth_rate_limits (dimension, key_fingerprint, window_started_at, attempt_count, updated_at)
     values ($1, $2, now(), 1, now())
     on conflict (dimension, key_fingerprint) do update set
       window_started_at = case
         when agx.auth_rate_limits.window_started_at <= now() - $3::interval
           then excluded.window_started_at
         else agx.auth_rate_limits.window_started_at
       end,
       attempt_count = case
         when agx.auth_rate_limits.window_started_at <= now() - $3::interval
           then 1
         else agx.auth_rate_limits.attempt_count + 1
       end,
       updated_at = now()
     returning window_started_at, attempt_count`,
    [dimension, keyFingerprint, `${RATE_LIMIT_WINDOW_SECONDS} seconds`],
  );

  const row = result.rows[0];
  const attemptCount = Number(row.attempt_count);
  const threshold = RATE_LIMIT_THRESHOLDS[dimension];
  const throttled = attemptCount > threshold;

  let retryAfterSeconds = null;
  if (throttled) {
    const windowStartedAtMs = new Date(row.window_started_at).getTime();
    const windowEndsAtMs = windowStartedAtMs + RATE_LIMIT_WINDOW_SECONDS * 1000;
    retryAfterSeconds = Math.max(1, Math.ceil((windowEndsAtMs - Date.now()) / 1000));
  }

  return { throttled, attemptCount, retryAfterSeconds };
}

/**
 * Login exitoso limpia el contador de `email` -- deliberadamente NUNCA el
 * de `ip` (evita que un atacante "lave" su contador de IP acertando una
 * sola cuenta entre muchos intentos contra otras -- credential stuffing).
 * Se invoca SIEMPRE dentro de `withAuthTransaction` (debe confirmarse o
 * revertirse junto con la creación de la sesión) -- por eso acepta el
 * `client` transaccional explícito, mismo patrón `runner = client || pool`
 * que `recordSecurityEvent` en ganaderiaSession.js.
 * @param {string} emailFingerprint
 * @param {import('pg').PoolClient | null} [client]
 */
export async function clearEmailRateLimit(emailFingerprint, client = null) {
  const runner = client || getAgxAuthPool();
  await runner.query(`delete from agx.auth_rate_limits where dimension = 'email' and key_fingerprint = $1`, [
    emailFingerprint,
  ]);
}
