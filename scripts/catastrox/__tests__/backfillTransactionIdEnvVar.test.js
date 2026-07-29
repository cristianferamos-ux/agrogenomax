// Prueba de caja negra (Postgres real, se auto-omite si no hay base
// alcanzable) para el defecto corregido: scripts/catastrox/
// backfill-known-approved-order.mjs ya no acepta ningún transactionId
// codificado en el código fuente -- CATASTROX_BACKFILL_TRANSACTION_ID es
// la única fuente, validada estrictamente y nunca impresa completa.
//
// Invoca el script REAL como proceso hijo (igual que un operador),
// exactamente como backfillRehashIdempotency.test.js hace para el otro
// script de backfill.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

dotenv.config({ path: '.env', quiet: true });
dotenv.config({ path: 'server/.env', quiet: true });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const workspaceRoot = path.resolve(__dirname, '..', '..', '..');
const scriptPath = path.join(workspaceRoot, 'scripts', 'catastrox', 'backfill-known-approved-order.mjs');

let dbAvailable = false;
try {
  const { getConfig } = await import('../../../server/config/env.js');
  const { getDbPool } = await import('../../../server/db.js');
  getConfig();
  const pool = getDbPool();
  await pool.query('select 1');
  dbAvailable = true;
} catch {
  dbAvailable = false;
}

function runBackfillScript(extraEnv) {
  return execFileSync('node', [scriptPath], {
    cwd: workspaceRoot,
    env: { ...process.env, CATASTROX_ALLOW_TEST_BACKFILL: 'true', ...extraEnv },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function runBackfillScriptExpectingFailure(extraEnv) {
  try {
    runBackfillScript(extraEnv);
    throw new Error('El script debía fallar pero terminó con éxito.');
  } catch (error) {
    if (error.status === undefined && error.signal === undefined && !('stdout' in error)) {
      throw error; // no era un fallo del proceso hijo, sino de la aserción de arriba
    }
    return { stdout: error.stdout || '', stderr: error.stderr || '', status: error.status };
  }
}

test('backfill-known-approved-order.mjs: CATASTROX_BACKFILL_TRANSACTION_ID (integración, requiere Postgres real)', { skip: !dbAvailable }, async (t) => {
  await t.test('1) sin la variable -> aborta con CATASTROX_BACKFILL_TRANSACTION_ID_REQUIRED', () => {
    const { stdout, stderr, status } = runBackfillScriptExpectingFailure({ CATASTROX_BACKFILL_TRANSACTION_ID: '' });
    assert.notEqual(status, 0);
    const combined = stdout + stderr;
    assert.match(combined, /CATASTROX_BACKFILL_TRANSACTION_ID es obligatoria/);
  });

  await t.test('2) valor mal formado (espacios/símbolos) -> aborta, nunca imprime el valor completo', () => {
    const malformed = 'valor con espacios y símbolos!! ###';
    const { stdout, stderr, status } = runBackfillScriptExpectingFailure({
      CATASTROX_BACKFILL_TRANSACTION_ID: malformed,
    });
    assert.notEqual(status, 0);
    const combined = stdout + stderr;
    assert.match(combined, /formato inválido/);
    assert.doesNotMatch(combined, new RegExp(malformed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  await t.test('3) valor sintético válido -> continúa (pasa la validación, no aborta por la variable)', () => {
    // Reutiliza la reference ya conocida/backfilled en este entorno de
    // prueba -- el script la encuentra existente y responde de forma
    // idempotente sin necesitar contactar a Wompi con este transactionId
    // sintético, así que no requiere credenciales reales de Sandbox.
    const syntheticId = 'synthetic-test-txn-000111';
    const stdout = runBackfillScript({ CATASTROX_BACKFILL_TRANSACTION_ID: syntheticId });
    assert.doesNotMatch(stdout, /CATASTROX_BACKFILL_TRANSACTION_ID_REQUIRED/);
    assert.doesNotMatch(stdout, /CATASTROX_BACKFILL_TRANSACTION_ID_INVALID/);
    assert.match(stdout, /CATASTROX_BACKFILL_TRANSACTION_ID=synt\.\.\./, 'debe imprimir la variable enmascarada, nunca completa');
    assert.doesNotMatch(stdout, new RegExp(syntheticId));
  });
});

// Nota: la confirmación de que el transactionId real retirado de este
// script (el que antes estaba codificado como constante) ya no aparece en
// NINGÚN archivo versionado se hace con una búsqueda de texto sobre el
// repositorio completo como parte de la validación de esta entrega, no
// aquí -- ese valor real no debe existir ni siquiera como fixture de
// prueba dentro del código fuente (regla explícita del pedido: "constante;
// fallback; valor por defecto; fixture; comentario; ejemplo").
