// SPRINT-3D11.3 (R1) -- PULL de la sincronización offline-first de
// Ganadería (GET /api/ganaderia/sync/pull). Todo bajo
// withOrganizacionTransaction (RLS FORCE): solo datos de la organización
// de la sesión, nunca stock central, lotes ni tokens.
//
// CURSOR (decisión documentada): opaco para el cliente, base64url de
// {"v":1,"t":"<instante ISO del servidor>"}; `t` = now() de la transacción
// del pull anterior. El siguiente pull devuelve filas con
// updated_at > t - 5 min (ventana de solape): una transacción que empezó
// antes de `t` pero confirmó después sigue entrando. El solape produce
// duplicados inocuos -- el cliente hace upsert idempotente por id. No hay
// borrados físicos en estas tablas (anular/archivar son estados), así que
// no se necesitan "tombstones". Catálogos (pequeños) viajan completos.
// Límite del piloto: 20.000 filas por entidad (413 si se excede).
import { withOrganizacionTransaction } from '../../db/agxBusinessPool.js';
import { ANIMAL_SELECT, serializeAnimal } from './animalesRepository.js';
import { CHAPETA_SELECT, serializeChapeta } from './qrChapetasRepository.js';

export const SYNC_OVERLAP_MS = 5 * 60 * 1000;
export const SYNC_MAX_ROWS = 20_000;
const EPOCH = new Date(0).toISOString();

function semanticError(code, status, message) {
  return Object.assign(new Error(message || code), { status, code });
}

export function encodeCursor(isoInstant) {
  return Buffer.from(JSON.stringify({ v: 1, t: isoInstant }), 'utf8').toString('base64url');
}

/** Cursor opaco -> instante ISO, o null si está ausente. Cursor ilegible -> 400. */
export function decodeCursor(rawCursor) {
  if (rawCursor === undefined || rawCursor === '') return null;
  try {
    if (typeof rawCursor !== 'string' || rawCursor.length > 200) throw new Error('x');
    const parsed = JSON.parse(Buffer.from(rawCursor, 'base64url').toString('utf8'));
    const instant = new Date(parsed?.t);
    if (parsed?.v !== 1 || Number.isNaN(instant.getTime())) throw new Error('x');
    return instant.toISOString();
  } catch {
    throw semanticError('INVALID_CURSOR', 400, 'Cursor de sincronización inválido.');
  }
}

export function desdeConSolape(cursorInstant) {
  if (!cursorInstant) return EPOCH;
  return new Date(new Date(cursorInstant).getTime() - SYNC_OVERLAP_MS).toISOString();
}

function capped(rows, entity) {
  if (rows.length > SYNC_MAX_ROWS) {
    throw semanticError('SYNC_DEMASIADO_GRANDE', 413, `Demasiados registros de ${entity} para una sola sincronización.`);
  }
  return rows;
}

export async function pullCambios(organizacionId, { cursor }) {
  const cursorInstant = decodeCursor(cursor);
  const desde = desdeConSolape(cursorInstant);

  return withOrganizacionTransaction(organizacionId, async (client) => {
    const ahora = (await client.query("select to_char(now() at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') as t")).rows[0].t;
    const limit = SYNC_MAX_ROWS + 1;

    const animalesRows = capped(
      (await client.query(`${ANIMAL_SELECT} where a.updated_at > $1 order by a.animal_id limit $2`, [desde, limit])).rows,
      'animales',
    );
    // clientOperationId solo viaja en la sincronización: permite al
    // dispositivo emparejar un registro local cuya respuesta se perdió.
    const operaciones = new Map();
    if (animalesRows.length > 0) {
      const ops = await client.query(
        'select animal_id::text as animal_id, client_operation_id::text as client_operation_id from agx.animales where animal_id = any($1::bigint[])',
        [animalesRows.map((row) => row.animal_id)],
      );
      for (const row of ops.rows) operaciones.set(row.animal_id, row.client_operation_id);
    }

    const chapetasRows = capped(
      (await client.query(
        `select x.*, c2.token_hash, to_char(c2.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as updated_at_iso
           from (${CHAPETA_SELECT} where c.updated_at > $1) x
           join agx.qr_chapetas c2 on c2.qr_id = x.qr_id::bigint
          order by x.qr_id::bigint limit $2`,
        [desde, limit],
      )).rows,
      'chapetas',
    );

    const predios = (await client.query(
      `select predio_id::text as predio_id, nombre_predio, departamento, municipio, vereda, area_total_ha, estado
         from agx.predios where fecha_actualizacion > $1 order by predio_id`,
      [desde],
    )).rows;
    const potreros = (await client.query(
      `select potrero_id::text as potrero_id, predio_id::text as predio_id, nombre, estado, area_ha
         from agx.potreros where updated_at > $1 order by potrero_id`,
      [desde],
    )).rows;
    const razas = (await client.query(
      'select raza_id, codigo, nombre, tipo_productivo from agx.catalogo_razas where activo = true order by tipo_productivo, nombre',
    )).rows;
    const categorias = (await client.query(
      'select categoria_id, codigo, nombre, grupo_productivo from agx.catalogo_categorias_productivas where activo = true order by grupo_productivo, nombre',
    )).rows;

    return {
      cursor: encodeCursor(ahora),
      completo: cursorInstant === null,
      servidorAhora: ahora,
      animales: animalesRows.map((row) => ({ ...serializeAnimal(row), clientOperationId: operaciones.get(row.animal_id) ?? null })),
      chapetas: chapetasRows.map((row) => ({ ...serializeChapeta(row), tokenHash: row.token_hash, actualizadoAt: row.updated_at_iso })),
      predios: predios.map((row) => ({
        predioId: row.predio_id,
        nombrePredio: row.nombre_predio,
        departamento: row.departamento,
        municipio: row.municipio,
        vereda: row.vereda,
        areaTotalHa: row.area_total_ha === null ? null : Number(row.area_total_ha),
        estado: row.estado,
      })),
      potreros: potreros.map((row) => ({
        potreroId: row.potrero_id,
        predioId: row.predio_id,
        nombre: row.nombre,
        estado: row.estado,
        areaHa: row.area_ha === null ? null : Number(row.area_ha),
      })),
      razas: razas.map((row) => ({ razaId: String(row.raza_id), codigo: row.codigo, nombre: row.nombre, tipoProductivo: row.tipo_productivo })),
      categorias: categorias.map((row) => ({
        categoriaId: String(row.categoria_id),
        codigo: row.codigo,
        nombre: row.nombre,
        grupoProductivo: row.grupo_productivo,
      })),
    };
  });
}
