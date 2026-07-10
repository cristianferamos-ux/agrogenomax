import dotenv from 'dotenv';
import pg from 'pg';
import path from 'path';
import { fileURLToPath } from 'url';

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../.env'), quiet: true });
dotenv.config({ path: path.resolve(__dirname, '.env'), quiet: true });

export const catastroxSchema = process.env.CATASTROX_PGSCHEMA || 'catastrox';

const connectionString = process.env.CATASTROX_DATABASE_URL || '';

export const catastroxPool = connectionString
  ? new Pool({ connectionString })
  : null;

export async function catastroxQuery(text, params = []) {
  if (!catastroxPool) {
    console.error('[CatastroX] CATASTROX_DATABASE_URL no configurada.');
    const error = new Error(
      'La consulta predial no está disponible en este momento. Intenta nuevamente más tarde.',
    );
    error.status = 503;
    error.code = 'CATASTROX_DB_NOT_CONFIGURED';
    throw error;
  }

  return catastroxPool.query(text, params);
}

export function catastroxTableName(name) {
  return `"${catastroxSchema}"."${name}"`;
}
