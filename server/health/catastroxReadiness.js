/**
 * Readiness de CatastroX (LOTE-007, ADR-012 §6/§7/§19): evalúa PostGIS y
 * los esquemas críticos (`catastrox`, `catastrox_clean`, `gis`), de forma
 * independiente de Ganadería. Wompi queda fuera (error funcional de
 * negocio, no de disponibilidad de instancia, ADR-012 §6).
 */

import { getCatastroxDbPool, catastroxSchema } from '../catastroxDb.js';
import { checkPostgresReadiness } from './dbReadiness.js';

const DEPENDENCY_NAME = 'postgis_catastrox';

// FIX CATASTROX READINESS ARRAY PARSING: `array_agg(schema_name)` agrega
// sobre `information_schema.schemata.schema_name`, cuyo tipo real es el
// dominio `information_schema.sql_identifier` (sobre `name`) -- el arreglo
// resultante recibe un OID derivado dinámicamente por Postgres (no un OID
// de arreglo conocido de antemano como `_text`/1009), para el que `pg`
// (node-postgres) no tiene ningún parser registrado. Sin parser, `pg`
// devuelve el valor tal como llega por el protocolo: el literal de texto
// crudo de Postgres, p. ej. `"{catastrox,catastrox_clean,gis}"` -- una
// STRING, no un arreglo de JS. Confirmado empíricamente contra la base de
// dev local antes de este cambio: `result.fields[...].dataTypeID` para esa
// columna es un OID de cuatro-cinco cifras fuera de cualquier tabla de
// tipos conocida, y `Array.isArray(row.existing_schemas)` daba `false`.
//
// Consecuencia real (el bug reportado desde Railway): más abajo,
// `new Set(row.existing_schemas || [])` recibía esa STRING completa. El
// constructor de `Set` itera cualquier iterable -- para un string, eso es
// CARÁCTER POR CARÁCTER (`'{', 'c', 'a', 't', ...}`), nunca los nombres de
// esquema completos. Por eso `existingSchemas.has('catastrox')` siempre
// daba `false`, sin importar que el esquema sí existiera -- `has_postgis`
// podía ser `true` y los tres esquemas podían existir de verdad, y aun así
// `missingSchemas` reportaba los tres como faltantes.
//
// Corrección (opción preferida del pedido, sin parser manual de arreglos
// de Postgres): `jsonb_agg` en vez de `array_agg`. `jsonb`/`json` SÍ tienen
// un OID fijo y bien conocido (3802/114) con parser nativo en `pg`
// (`JSON.parse` interno) -- el resultado llega siempre como un arreglo de
// JS real, verificado también empíricamente (`Array.isArray === true`)
// tanto con esquemas presentes como con el caso vacío (`'[]'::jsonb` ->
// `[]`, nunca la string `"[]"`).
const CRITICAL_SCHEMA_QUERY = `
  select
    exists(select 1 from pg_extension where extname = 'postgis') as has_postgis,
    coalesce(
      jsonb_agg(schema_name order by schema_name) filter (where schema_name is not null),
      '[]'::jsonb
    ) as existing_schemas
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
  // Defensa adicional (nunca el control principal -- ese es jsonb_agg, ver
  // el comentario de CRITICAL_SCHEMA_QUERY arriba): si por cualquier motivo
  // `existing_schemas` no llegara como un arreglo real de JS, se trata como
  // "ningún esquema presente" en vez de repetir el bug original de
  // `new Set(stringNoIterableComoElementos)`, que silenciosamente producía
  // falsos negativos en vez de fallar de forma clara.
  const existingSchemas = new Set(Array.isArray(row.existing_schemas) ? row.existing_schemas : []);
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
