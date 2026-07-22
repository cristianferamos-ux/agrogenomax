/**
 * Readiness de CatastroX (LOTE-007, ADR-012 §6/§7/§19): evalúa PostGIS y
 * los esquemas críticos (`catastrox`, `catastrox_clean`, `gis`), de forma
 * independiente de Ganadería. Wompi queda fuera (error funcional de
 * negocio, no de disponibilidad de instancia, ADR-012 §6).
 */

import { getCatastroxDbPool, catastroxSchema } from '../catastroxDb.js';
import { checkPostgresReadiness } from './dbReadiness.js';

const DEPENDENCY_NAME = 'postgis_catastrox';

const CRITICAL_SCHEMA_QUERY = `
  select
    exists(select 1 from pg_extension where extname = 'postgis') as has_postgis,
    coalesce(array_agg(schema_name) filter (where schema_name is not null), '{}') as existing_schemas
  from information_schema.schemata
  where schema_name = any($1)
`;

// Esquemas literales siempre exigidos, más el esquema configurado (que
// puede coincidir con 'catastrox') -- deduplicados para no repetir el
// mismo nombre en el parámetro de la consulta.
const LITERAL_REQUIRED_SCHEMAS = Object.freeze(['catastrox', 'catastrox_clean', 'gis']);

function resolveRequiredSchemas(configuredSchema) {
  return Array.from(new Set([...LITERAL_REQUIRED_SCHEMAS, configuredSchema]));
}

async function runCatastroxCheck(pool, timeoutMs) {
  const requiredSchemas = resolveRequiredSchemas(catastroxSchema);
  const result = await pool.query({ text: CRITICAL_SCHEMA_QUERY, values: [requiredSchemas], query_timeout: timeoutMs });
  const row = result.rows[0] || {};
  const existingSchemas = new Set(row.existing_schemas || []);
  const missingSchemas = requiredSchemas.filter((schema) => !existingSchemas.has(schema));

  if (!row.has_postgis || missingSchemas.length > 0) {
    const error = new Error('critical schema or extension missing');
    error.readinessCode = 'schema_missing';
    throw error;
  }
}

/**
 * @param {{getPool?: () => import('pg').Pool | null, checker?: typeof checkPostgresReadiness}} [deps]
 */
export async function evaluateCatastroxReadiness({ getPool = getCatastroxDbPool, checker = checkPostgresReadiness } = {}) {
  let pool;
  try {
    pool = getPool();
  } catch (error) {
    return { ok: false, code: 'database_unreachable', dependency: DEPENDENCY_NAME };
  }

  if (!pool) {
    return { ok: false, code: 'not_configured', dependency: DEPENDENCY_NAME };
  }

  const result = await checker(pool, { run: runCatastroxCheck });
  return { ...result, dependency: DEPENDENCY_NAME };
}
