import dotenv from 'dotenv';
import pg from 'pg';
import { assertConfigValidated } from './config/env.js';

const { Pool } = pg;

dotenv.config({ path: '.env', quiet: true });
dotenv.config({ path: 'server/.env', quiet: true });

export const schema = process.env.PGSCHEMA || 'agx';

let poolInstance = null;

/**
 * Crea (o reutiliza) el Pool de PostgreSQL de `agx`, de forma perezosa.
 *
 * CORRECCIÓN LOTE-002: nunca se instancia al importar este módulo -- solo
 * en el primer acceso real, y solo si la configuración central (APP_ENV)
 * ya fue validada (server/config/env.js). Nunca fabrica una cadena de
 * conexión por defecto: si DATABASE_URL falta, falla con un error claro
 * en vez de conectar silenciosamente a un valor inseguro hardcodeado.
 *
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} source
 */
export function getDbPool(source = process.env) {
  if (poolInstance) return poolInstance;

  assertConfigValidated();

  const connectionString = source.DATABASE_URL;
  if (!connectionString) {
    const error = new Error(
      'DATABASE_URL no está configurada. No es posible crear la conexión a la base de datos agx.',
    );
    error.status = 503;
    error.code = 'AGX_DB_NOT_CONFIGURED';
    throw error;
  }

  poolInstance = new Pool({ connectionString });
  return poolInstance;
}

// Claves de "inspección/serialización" (no operativas) que nunca deben
// disparar la construcción del Pool real. Sin este resguardo, un
// `console.log(pool)`, un `await pool` accidental (comprobación estándar
// de thenable vía `.then`), o un `JSON.stringify` sobre un objeto que lo
// contenga, forzarían una creación prematura -- o un error de validación
// -- solo por haber sido inspeccionados, no por un uso operativo real.
const PROXY_NON_OPERATIONAL_STRING_KEYS = new Set(['then', 'toJSON', 'toString', 'valueOf', 'constructor']);

// Compatibilidad con consumidores existentes que usan `pool.connect()`
// directamente (server/routes/animales.js, server/routes/qr.js), fuera
// del alcance de archivos permitidos de este lote. Proxy perezoso: nunca
// instancia el Pool real hasta el primer acceso operativo a una de sus
// propiedades/métodos -- nunca como efecto colateral de importar este
// módulo, ni de ser inspeccionado/logueado/serializado.
export const pool = new Proxy(
  /** @type {import('pg').Pool} */ ({}),
  {
    get(target, prop) {
      if (typeof prop === 'symbol' || PROXY_NON_OPERATIONAL_STRING_KEYS.has(prop)) {
        // Defiere al objeto vacío subyacente (y a su cadena de prototipos
        // estándar de Object) para inspección/serialización/coerción --
        // así `String(pool)`/`\`${pool}\`` siguen funcionando (resuelven
        // por Object.prototype.toString/valueOf) sin lanzar y sin
        // disparar la construcción del Pool real.
        return Reflect.get(target, prop, target);
      }

      const realPool = getDbPool();
      const value = Reflect.get(realPool, prop, realPool);
      return typeof value === 'function' ? value.bind(realPool) : value;
    },
  },
);

const columnCache = new Map();

export async function query(text, params = []) {
  return getDbPool().query(text, params);
}

export function tableName(name) {
  return `"${schema}"."${name}"`;
}

export async function getColumns(table) {
  if (columnCache.has(table)) return columnCache.get(table);

  const result = await query(
    `select column_name
       from information_schema.columns
      where table_schema = $1 and table_name = $2`,
    [schema, table],
  );

  const columns = new Set(result.rows.map((row) => row.column_name));
  columnCache.set(table, columns);
  return columns;
}

export function pickColumn(columns, candidates) {
  return candidates.find((candidate) => columns.has(candidate));
}

export function idColumnFor(table, columns) {
  const explicit = {
    predios: ['predio_id'],
    potreros: ['potrero_id'],
    qr_codes: ['qr_id'],
    animales: ['animal_id'],
    razas: ['raza_id'],
    animal_razas: ['animal_raza_id'],
    pesajes: ['pesaje_id'],
    vacunaciones: ['vacunacion_id'],
    catalogo_vacunas: ['catalogo_vacuna_id'],
  };

  return pickColumn(columns, [...(explicit[table] || []), 'id', `${table.slice(0, -1)}_id`]);
}

export function pickPayload(columns, payload, aliases) {
  const selected = {};

  for (const [inputKey, candidates] of Object.entries(aliases)) {
    const column = pickColumn(columns, candidates);
    const value = payload[inputKey];

    if (column && value !== undefined && value !== '') {
      selected[column] = value;
    }
  }

  return selected;
}

export async function insertDynamic(table, values, client = null) {
  const entries = Object.entries(values).filter(([, value]) => value !== undefined);

  if (!entries.length) {
    throw Object.assign(new Error(`No hay columnas compatibles para insertar en ${table}.`), {
      status: 400,
    });
  }

  const columns = entries.map(([column]) => `"${column}"`).join(', ');
  const placeholders = entries.map((_, index) => `$${index + 1}`).join(', ');
  const params = entries.map(([, value]) => value);
  const runner = client || { query };

  const result = await runner.query(
    `insert into ${tableName(table)} (${columns}) values (${placeholders}) returning *`,
    params,
  );

  return result.rows[0];
}

export async function updateDynamic(table, id, values, client = null) {
  const columns = await getColumns(table);
  const idColumn = idColumnFor(table, columns);
  const entries = Object.entries(values).filter(([, value]) => value !== undefined);

  if (!idColumn) {
    throw Object.assign(new Error(`No se encontró columna primaria para ${table}.`), { status: 500 });
  }

  if (!entries.length) {
    throw Object.assign(new Error(`No hay columnas compatibles para actualizar en ${table}.`), {
      status: 400,
    });
  }

  const setClause = entries.map(([column], index) => `"${column}" = $${index + 1}`).join(', ');
  const params = entries.map(([, value]) => value);
  params.push(id);
  const runner = client || { query };

  const result = await runner.query(
    `update ${tableName(table)} set ${setClause} where "${idColumn}" = $${params.length} returning *`,
    params,
  );

  return result.rows[0];
}

// LOTE-007 (graceful shutdown, ADR-012 §21) -- corrección final de ciclo
// de vida: el estado de cierre asocia explícitamente `pool` + `promise`
// en un único objeto (`poolClosingState`), nunca dos variables sueltas.
// Respeta la inicialización perezosa -- si nunca se creó, no se crea
// solo para cerrarlo.
//
// Identidad estricta en dos niveles:
// 1) Una llamada repetida MIENTRAS la misma instancia sigue cerrándose
//    devuelve exactamente el mismo objeto Promise (comparación
//    `poolClosingState.pool === poolToClose`).
// 2) El `finally` de una instancia (A) solo limpia `poolInstance` si
//    todavía apunta a A, y solo limpia `poolClosingState` si ese estado
//    sigue correspondiendo a LA PROMESA que ese `finally` originó
//    (`poolClosingState.promise === closePromise`) -- no basta con
//    comparar el pool, porque una instancia nueva (B) podría haber
//    comenzado su propio cierre (con su propio `poolClosingState`) antes
//    de que el `finally` de A se ejecute; comparar por promesa evita que
//    A borre el estado de cierre de B en esa carrera.
//
// No usa `async`: closeMainDbPool() debe devolver el MISMO objeto
// Promise en llamadas repetidas para la misma instancia, lo que una
// función `async` no garantiza (cada `await`/retorno de una función
// async envuelve el valor en una Promise nueva).
let poolClosingState = null; // { pool, promise } | null

export function closeMainDbPool() {
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

// Exclusivamente para pruebas unitarias aisladas (LOTE-002): reporta si ya
// existe una instancia real del Pool, sin exponerla, y permite resetear
// el estado entre casos.
export function __hasDbPoolForTests() {
  return poolInstance !== null;
}

export function __resetDbPoolForTests() {
  poolInstance = null;
  poolClosingState = null;
}
