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

// LOTE-007 (graceful shutdown, ADR-012 §21) -- corrección final de ciclo
// de vida: el estado de cierre asocia explícitamente `pool` + `promise`
// en un único objeto (`catastroxPoolClosingState`), nunca dos variables
// sueltas. Respeta la inicialización perezosa -- si nunca se creó
// (incluida la ausencia tolerante de CATASTROX_DATABASE_URL), no se crea
// solo para cerrarlo.
//
// Identidad estricta en dos niveles:
// 1) Una llamada repetida MIENTRAS la misma instancia sigue cerrándose
//    devuelve exactamente el mismo objeto Promise.
// 2) El `finally` de una instancia (A) solo limpia
//    `catastroxPoolInstance` si todavía apunta a A, y solo limpia
//    `catastroxPoolClosingState` si ese estado sigue correspondiendo a
//    LA PROMESA que ese `finally` originó (comparación por promesa, no
//    solo por pool) -- evita que A borre el estado de cierre de una
//    instancia nueva (B) que ya inició su propio cierre.
//
// No usa `async`: closeCatastroxDbPool() debe devolver el MISMO objeto
// Promise en llamadas repetidas para la misma instancia.
let catastroxPoolClosingState = null; // { pool, promise } | null

export function closeCatastroxDbPool() {
  const poolToClose = catastroxPoolInstance;

  if (!poolToClose) {
    return Promise.resolve();
  }

  if (catastroxPoolClosingState?.pool === poolToClose) {
    return catastroxPoolClosingState.promise;
  }

  const closePromise = Promise.resolve()
    .then(() => poolToClose.end())
    .finally(() => {
      if (catastroxPoolInstance === poolToClose) {
        catastroxPoolInstance = null;
      }
      if (catastroxPoolClosingState?.promise === closePromise) {
        catastroxPoolClosingState = null;
      }
    });

  catastroxPoolClosingState = { pool: poolToClose, promise: closePromise };
  return closePromise;
}

// Exclusivamente para pruebas unitarias aisladas (LOTE-002): reporta si ya
// existe una instancia real del Pool, sin exponerla, y permite resetear
// el estado entre casos.
export function __hasCatastroxDbPoolForTests() {
  return catastroxPoolInstance !== null;
}

export function __resetCatastroxDbPoolForTests() {
  catastroxPoolInstance = null;
  catastroxPoolClosingState = null;
}
