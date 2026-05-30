import dotenv from 'dotenv';
import pg from 'pg';

const { Pool } = pg;

dotenv.config({ path: '.env', quiet: true });
dotenv.config({ path: 'server/.env', quiet: true });

export const schema = process.env.PGSCHEMA || 'agx';

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/AGROGENOMAX',
});

const columnCache = new Map();

export async function query(text, params = []) {
  return pool.query(text, params);
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
