/**
 * Readiness de Ganadería (LOTE-007, ADR-012 §6/§7/§19): evalúa
 * exclusivamente PostgreSQL `agx`, de forma independiente de CatastroX.
 * La verificación real es un SELECT de solo lectura que confirma, además
 * de la conectividad, la existencia del esquema configurado -- el nombre
 * del esquema viaja siempre como parámetro ($1), nunca concatenado en el
 * texto de la consulta.
 */

import { getDbPool, schema } from '../db.js';
import { checkPostgresReadiness } from './dbReadiness.js';

const DEPENDENCY_NAME = 'postgresql_agx';

const SCHEMA_READINESS_QUERY = `
  select exists(
    select 1 from information_schema.schemata where schema_name = $1
  ) as schema_exists
`;

async function runGanaderiaCheck(pool, timeoutMs) {
  const result = await pool.query({ text: SCHEMA_READINESS_QUERY, values: [schema], query_timeout: timeoutMs });
  const schemaExists = Boolean(result.rows[0]?.schema_exists);

  if (!schemaExists) {
    const error = new Error('esquema agx ausente');
    error.readinessCode = 'schema_missing';
    throw error;
  }
}

/**
 * @param {{getPool?: () => import('pg').Pool, checker?: typeof checkPostgresReadiness}} [deps]
 */
export async function evaluateGanaderiaReadiness({ getPool = getDbPool, checker = checkPostgresReadiness } = {}) {
  let pool;
  try {
    pool = getPool();
  } catch (error) {
    return {
      ok: false,
      code: error?.code === 'AGX_DB_NOT_CONFIGURED' ? 'not_configured' : 'database_unreachable',
      dependency: DEPENDENCY_NAME,
    };
  }

  const result = await checker(pool, { run: runGanaderiaCheck });
  return { ...result, dependency: DEPENDENCY_NAME };
}
