// SPRINT-3D11.3 (R1) -- pool del rol PostgreSQL agx_qr_admin (0023), el
// único con acceso al inventario QR global. Conexión PROPIA
// (AGX_BUSINESS_QR_ADMIN_DATABASE_URL), nunca la de agx_app: la frontera
// entre organización y Super Admin es el rol de base de datos, no un GUC.
// Solo lo usan las rutas /api/ganaderia/admin/qr detrás de
// createRequireGanaderiaSuperAdmin. Fail-closed: sin variable -> 503; si la
// conexión no autentica como agx_qr_admin -> error (nunca opera con otro rol).
import pg from 'pg';

let poolInstance = null;
let roleVerified = false;

function notConfigured() {
  return Object.assign(new Error('El inventario QR no está configurado en este servidor.'), {
    status: 503,
    code: 'QR_ADMIN_DB_NOT_CONFIGURED',
  });
}

export function getAgxQrAdminPool(source = process.env) {
  if (poolInstance) return poolInstance;
  const connectionString = source.AGX_BUSINESS_QR_ADMIN_DATABASE_URL;
  if (typeof connectionString !== 'string' || connectionString.trim() === '') throw notConfigured();
  poolInstance = new pg.Pool({ connectionString, max: 4, idleTimeoutMillis: 30_000 });
  poolInstance.on('error', () => {});
  return poolInstance;
}

/**
 * Transacción del rol agx_qr_admin. app.current_org_id arranca vacío; una
 * operación sobre una chapeta ya asignada lo fija a la organización de esa
 * chapeta (para tocar animales/animal_eventos bajo sus policies tenant).
 *
 * @param {(client: import('pg').PoolClient) => Promise<any>} fn
 */
export async function withQrAdminTransaction(fn) {
  const pool = getAgxQrAdminPool();
  const client = await pool.connect();
  try {
    if (!roleVerified) {
      const { rows } = await client.query('select current_user as role');
      if (rows[0]?.role !== 'agx_qr_admin') {
        throw Object.assign(new Error('QR_ADMIN_DB_WRONG_ROLE'), { code: 'QR_ADMIN_DB_WRONG_ROLE' });
      }
      roleVerified = true;
    }
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_org_id', '', true)");
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function closeAgxQrAdminPool() {
  const pool = poolInstance;
  poolInstance = null;
  roleVerified = false;
  if (pool) await pool.end().catch(() => {});
}

export function __resetAgxQrAdminPoolForTests() {
  poolInstance = null;
  roleVerified = false;
}
