import dotenv from 'dotenv';
import pg from 'pg';
import path from 'path';
import { fileURLToPath } from 'url';
import { assertConfigValidated } from './config/env.js';

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../.env'), quiet: true });
dotenv.config({ path: path.resolve(__dirname, '.env'), quiet: true });

export const catastroxSchema = process.env.CATASTROX_PGSCHEMA || 'catastrox';

let catastroxPoolInstance = null;

/**
 * Crea (o reutiliza) el Pool de PostGIS-CatastroX, de forma perezosa.
 *
 * CORRECCIÓN LOTE-002: nunca se instancia al importar este módulo -- solo
 * en el primer acceso real, y solo si la configuración central (APP_ENV)
 * ya fue validada. Si CATASTROX_DATABASE_URL no está configurada, no
 * fabrica ninguna URL -- devuelve null (comportamiento ya existente,
 * ahora perezoso además de tolerante); catastroxQuery() clasifica esa
 * ausencia con un error claro (CATASTROX_DB_NOT_CONFIGURED).
 *
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} source
 */
export function getCatastroxDbPool(source = process.env) {
  if (catastroxPoolInstance) return catastroxPoolInstance;

  assertConfigValidated();

  const connectionString = source.CATASTROX_DATABASE_URL;
  if (!connectionString) return null;

  catastroxPoolInstance = new Pool({ connectionString });
  return catastroxPoolInstance;
}

export async function catastroxQuery(text, params = []) {
  const pool = getCatastroxDbPool();
  if (!pool) {
    console.error('[CatastroX] CATASTROX_DATABASE_URL no configurada.');
    const error = new Error(
      'La consulta predial no está disponible en este momento. Intenta nuevamente más tarde.',
    );
    error.status = 503;
    error.code = 'CATASTROX_DB_NOT_CONFIGURED';
    throw error;
  }

  return pool.query(text, params);
}

export function catastroxTableName(name) {
  return `"${catastroxSchema}"."${name}"`;
}

// Exclusivamente para pruebas unitarias aisladas (LOTE-002): reporta si ya
// existe una instancia real del Pool, sin exponerla, y permite resetear
// el estado entre casos.
export function __hasCatastroxDbPoolForTests() {
  return catastroxPoolInstance !== null;
}

export function __resetCatastroxDbPoolForTests() {
  catastroxPoolInstance = null;
}
