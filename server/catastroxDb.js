import dotenv from 'dotenv';
import pg from 'pg';

const { Pool } = pg;

dotenv.config({ path: '.env', quiet: true });
dotenv.config({ path: 'server/.env', quiet: true });

export const catastroxSchema = process.env.CATASTROX_PGSCHEMA || 'catastrox';

const connectionString = process.env.CATASTROX_DATABASE_URL || '';

export const catastroxPool = connectionString
  ? new Pool({ connectionString })
  : null;

export async function catastroxQuery(text, params = []) {
  if (!catastroxPool) {
    const error = new Error(
      'CATASTROX_DATABASE_URL no está configurada. CatastroX requiere una base PostGIS independiente.',
    );
    error.status = 503;
    throw error;
  }

  return catastroxPool.query(text, params);
}

export function catastroxTableName(name) {
  return `"${catastroxSchema}"."${name}"`;
}
