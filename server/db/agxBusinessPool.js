import pg from 'pg';
import { assertConfigValidated } from '../config/env.js';

const { Pool } = pg;

// BFF-001 (ADR-009 §9.2, plano de negocio -- corrección 4): pool FÍSICO
// separado del plano de seguridad (agxAuthPool.js) y del legacy
// (server/db.js). Se conecta como `agx_app` (ACCESO-001) -- sujeto a RLS
// en las 30 tablas de negocio, CERO acceso a las 6 tablas de identidad
// (verificado en el gate ACCESO-001), CERO privilegios administrativos.
//
// BFF-001 no migra ninguna ruta de negocio existente a este pool -- eso
// es un lote posterior. Este módulo solo deja lista la base
// (withOrganizacionTransaction) para cuando esa migración se autorice.

let poolInstance = null;

/**
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} source
 */
export function getAgxBusinessPool(source = process.env) {
  if (poolInstance) return poolInstance;

  assertConfigValidated();

  const connectionString = source.AGX_BUSINESS_DATABASE_URL;
  if (!connectionString) {
    const error = new Error(
      'AGX_BUSINESS_DATABASE_URL no está configurada. No es posible abrir una transacción de negocio de Ganadería.',
    );
    error.status = 503;
    error.code = 'AGX_BUSINESS_DB_NOT_CONFIGURED';
    throw error;
  }

  poolInstance = new Pool({ connectionString });
  return poolInstance;
}

/**
 * Patrón obligatorio de contexto tenant (BFF-001, corrección explícita del
 * usuario sobre el diseño original): `SELECT set_config('app.current_org_id',
 * $1, true)` -- NUNCA `SET LOCAL app.current_org_id = $1` (ese comando no
 * admite parámetros bindeados; forzaría a interpolar el UUID directamente
 * en el texto SQL). `set_config(..., true)` es una función regular, sí
 * soporta bind parameters vía el driver `pg`, y el tercer argumento
 * `true` (`is_local`) reproduce exactamente la semántica de `SET LOCAL`:
 * el valor solo vive hasta el COMMIT/ROLLBACK de esta transacción, en
 * este mismo `client` -- nunca sobrevive fuera de ella, nunca se filtra a
 * otra conexión del pool.
 *
 * Un único `client` (adquirido de este pool) durante todo el ciclo
 * BEGIN -> set_config -> consultas de `fn(client)` -> COMMIT/ROLLBACK.
 * `fn` NUNCA debe usar `pool.query()` suelto -- solo `client.query()` (o
 * `insertDynamic`/`updateDynamic` de server/db.js pasándoles este mismo
 * `client`), o el contexto de organización no aplicaría a esas consultas.
 *
 * @param {string} organizacionId - uuid de la organización activa ya
 *   resuelta y autorizada (nunca un valor sin pasar por
 *   fn_resolver_autorizacion_sesion).
 * @param {(client: import('pg').PoolClient) => Promise<any>} fn
 * @returns {Promise<any>}
 */
export async function withOrganizacionTransaction(organizacionId, fn) {
  const pool = getAgxBusinessPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_org_id', $1, true)", [organizacionId]);
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

// Mismo patrón de cierre idempotente que server/db.js#closeMainDbPool.
let poolClosingState = null; // { pool, promise } | null

export function closeAgxBusinessPool() {
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
export function __hasAgxBusinessPoolForTests() {
  return poolInstance !== null;
}

export function __resetAgxBusinessPoolForTests() {
  poolInstance = null;
  poolClosingState = null;
}
