import pg from 'pg';
import { assertConfigValidated } from '../config/env.js';

const { Pool } = pg;

// BFF-001 (ADR-009 §9.2, plano de seguridad -- corrección 4): pool FÍSICO
// separado del negocio (agxBusinessPool.js) y del legacy (server/db.js).
// Se conecta como `agx_auth` (ACCESO-001) -- acceso mínimo a
// agx.sesiones/agx.cuentas/agx.membresias/agx.staff_crh/
// agx.concesiones_acceso_interno/agx.auditoria_acceso_interno_uso, CERO
// acceso a tablas de negocio (predios/animales/etc., verificado en el
// gate ACCESO-001), CERO privilegios administrativos. Es el ÚNICO pool
// que server/security/ganaderiaSession.js usa para resolver
// cookie -> hash -> sesión. Los controladores de negocio nunca lo
// importan.
//
// Mismo patrón de inicialización perezosa que server/db.js:
// getDbPool()/getAgxAuthPool() nunca construyen un Pool como efecto
// colateral de importarse -- solo en el primer acceso real, y solo tras
// getConfig() (assertConfigValidated()).

let poolInstance = null;

/**
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} source
 */
export function getAgxAuthPool(source = process.env) {
  if (poolInstance) return poolInstance;

  assertConfigValidated();

  const connectionString = source.AGX_AUTH_DATABASE_URL;
  if (!connectionString) {
    const error = new Error(
      'AGX_AUTH_DATABASE_URL no está configurada. No es posible resolver sesiones de Ganadería.',
    );
    error.status = 503;
    error.code = 'AGX_AUTH_DB_NOT_CONFIGURED';
    throw error;
  }

  poolInstance = new Pool({ connectionString });
  return poolInstance;
}

/**
 * AUTH-001 (aprobado v2.2, §11): helper transaccional del plano de
 * seguridad -- mismo patrón que `withOrganizacionTransaction`
 * (agxBusinessPool.js), pero SIN `set_config` de tenant (el plano de
 * identidad no tiene RLS/contexto organizacional). Reutilizado
 * idéntico por `POST /login` y `POST /password/set`.
 *
 * Contrato obligatorio de todo `fn` que se le pase: cualquier operación
 * CPU-intensiva (Argon2 hash/verify) debe haberse ejecutado YA, ANTES de
 * llamar a `withAuthTransaction` -- nunca dentro de `fn`. Mantener una
 * transacción de Postgres abierta mientras se calcula Argon2 (decenas de
 * milisegundos de CPU) alargaría innecesariamente la ventana de bloqueo
 * de fila sobre `agx.cuentas`/`agx.credenciales_reset_tokens`.
 *
 * @param {(client: import('pg').PoolClient) => Promise<any>} fn
 * @returns {Promise<any>}
 */
export async function withAuthTransaction(fn) {
  const pool = getAgxAuthPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
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

// Mismo patrón de cierre idempotente que server/db.js#closeMainDbPool --
// ver los comentarios extensos de ese archivo (LOTE-007) para el
// razonamiento completo de las dos identidades (instancia + promesa) que
// evitan condiciones de carrera entre cierres sucesivos.
let poolClosingState = null; // { pool, promise } | null

export function closeAgxAuthPool() {
  const poolToClose = poolInstance;

  if (!poolToClose) {
    return Promise.resolve();
  }

  if (poolClosingState?.pool === poolToClose) {
    return poolClosingState.promise;
  }

  const closePromise = Promise.resolve()
    .then(() => poolToClose.end())
    .finally(() => {
      if (poolInstance === poolToClose) {
        poolInstance = null;
      }
      if (poolClosingState?.promise === closePromise) {
        poolClosingState = null;
      }
    });

  poolClosingState = { pool: poolToClose, promise: closePromise };
  return closePromise;
}

/** Exclusivamente para pruebas unitarias aisladas. */
export function __hasAgxAuthPoolForTests() {
  return poolInstance !== null;
}

export function __resetAgxAuthPoolForTests() {
  poolInstance = null;
  poolClosingState = null;
}
