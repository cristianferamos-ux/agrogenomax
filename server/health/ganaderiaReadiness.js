/**
 * Readiness de Ganadería (LOTE-007, ADR-012 §6/§7/§19), independiente de
 * CatastroX.
 *
 * FASE-14 (readiness real): Ganadería ya no vive en el Postgres legacy
 * (`server/db.js`, DATABASE_URL); sus datos están en Postgres-AGX-Business
 * y sus sesiones en Postgres-AGX (auth). El readiness comprueba ahora:
 *
 *   business  REQUERIDA  AGX_BUSINESS_DATABASE_URL (agx_app)      -- SELECT 1
 *   auth      REQUERIDA  AGX_AUTH_DATABASE_URL (agx_auth)         -- SELECT 1
 *   legacy    REQUERIDA  DATABASE_URL, esquema `agx` (comprobación
 *                        histórica de este readiness). Ganadería ya no la
 *                        usa, pero el comercio de CatastroX sí: se mantiene
 *                        para no dejar esa base sin ningún monitor; moverla
 *                        al readiness de CatastroX es un cambio aparte.
 *   qrAdmin   OPCIONAL   AGX_BUSINESS_QR_ADMIN_DATABASE_URL (agx_qr_admin)
 *                        -- solo el inventario QR del Super Admin depende
 *                        de ella: si falla, `degraded`, nunca 503.
 *
 * Reutiliza los pools perezosos ya existentes (nunca abre una conexión por
 * petición) y el motor común checkPostgresReadiness (timeout, sin
 * reintentos, deduplicación y caché breve por pool). La respuesta solo
 * expone códigos clasificados: nunca hosts, bases, usuarios ni mensajes
 * del driver.
 */

import { getDbPool, schema } from '../db.js';
import { getAgxBusinessPool } from '../db/agxBusinessPool.js';
import { getAgxAuthPool } from '../db/agxAuthPool.js';
import { getAgxQrAdminPool } from '../db/agxQrAdminPool.js';
import { checkPostgresReadiness } from './dbReadiness.js';

const DEPENDENCY_NAME = 'ganaderia_databases';
const LEGACY_DEPENDENCY_NAME = 'postgresql_agx';

const SCHEMA_READINESS_QUERY = `
  select exists(
    select 1 from information_schema.schemata where schema_name = $1
  ) as schema_exists
`;

async function runLegacyAgxCheck(pool, timeoutMs) {
  const result = await pool.query({ text: SCHEMA_READINESS_QUERY, values: [schema], query_timeout: timeoutMs });
  const schemaExists = Boolean(result.rows[0]?.schema_exists);

  if (!schemaExists) {
    const error = new Error('esquema agx ausente');
    error.readinessCode = 'schema_missing';
    throw error;
  }
}

function notConfiguredOrUnreachable(error) {
  return /NOT_CONFIGURED$/.test(String(error?.code ?? '')) ? 'not_configured' : 'database_unreachable';
}

async function checkPool(getPool, checker, run) {
  let pool;
  try {
    pool = getPool();
  } catch (error) {
    return { ok: false, code: notConfiguredOrUnreachable(error) };
  }
  return checker(pool, run ? { run } : {});
}

/**
 * Comprobación histórica del Postgres legacy (`agx`). La usa también la
 * ruta heredada GET /api/health/db, cuya semántica no cambia.
 *
 * @param {{getPool?: () => import('pg').Pool, checker?: typeof checkPostgresReadiness}} [deps]
 */
export async function evaluateLegacyAgxReadiness({ getPool = getDbPool, checker = checkPostgresReadiness } = {}) {
  const result = await checkPool(getPool, checker, runLegacyAgxCheck);
  return { ...result, dependency: LEGACY_DEPENDENCY_NAME };
}

/**
 * @param {{
 *   getBusinessPool?: () => import('pg').Pool,
 *   getAuthPool?: () => import('pg').Pool,
 *   getLegacyPool?: () => import('pg').Pool,
 *   getQrAdminPool?: () => import('pg').Pool,
 *   checker?: typeof checkPostgresReadiness,
 * }} [deps]
 */
export async function evaluateGanaderiaReadiness({
  getBusinessPool = getAgxBusinessPool,
  getAuthPool = getAgxAuthPool,
  getLegacyPool = getDbPool,
  getQrAdminPool = getAgxQrAdminPool,
  checker = checkPostgresReadiness,
} = {}) {
  const [business, auth, legacy, qrAdmin] = await Promise.all([
    checkPool(getBusinessPool, checker),
    checkPool(getAuthPool, checker),
    checkPool(getLegacyPool, checker, runLegacyAgxCheck),
    checkPool(getQrAdminPool, checker),
  ]);

  const required = [['business', business], ['auth', auth], ['legacy', legacy]];
  const failed = required.find(([, result]) => !result.ok);
  const qrAdminStatus = qrAdmin.ok ? 'ok' : qrAdmin.code === 'not_configured' ? 'not_configured' : 'error';

  return {
    ok: !failed,
    code: failed ? failed[1].code : 'ok',
    dependency: DEPENDENCY_NAME,
    degraded: !failed && qrAdminStatus === 'error',
    checks: {
      business: business.ok ? 'ok' : 'error',
      auth: auth.ok ? 'ok' : 'error',
      legacy: legacy.ok ? 'ok' : 'error',
      qrAdmin: qrAdminStatus,
    },
  };
}
