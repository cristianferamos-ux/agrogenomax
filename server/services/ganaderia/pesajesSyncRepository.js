// FASE 5A.3a -- PULL de pesajes (GET /api/ganaderia/sync/pesajes). Solo lectura,
// bajo withOrganizacionTransaction (RLS FORCE): el tenant sale de la sesión.
// Cursor propio, nunca compartido con /sync/pull ni con /sync/reproduccion.
//
// MARCA: marcaCambio = coalesce(anulado_at, created_at). agx.animal_pesajes es
// inmutable salvo ACTIVO -> ANULADO (trigger animal_pesajes_guard, 0028) y no
// admite DELETE, así que un pesaje nuevo y su anulación posterior se detectan con
// una sola columna lógica.
//
// ORDEN TOTAL: ORDER BY marcaCambio ASC, pesaje_id ASC. La página siguiente
// empieza ESTRICTAMENTE después del último par entregado: (marca, id) > (m, i).
// Filas con exactamente el mismo instante nunca se pierden ni se repiten dentro
// de un recorrido, y los instantes viajan como texto con microsegundos.
//
// CURSOR: opaco, base64url de JSON, versión v=1, ámbito s='pesajes', ligado a la
// organización de la sesión (o). Cualquier otra forma -> 400 INVALID_CURSOR.
//   entre recorridos { v, s, o, c }             c = now() de la 1.ª página del recorrido
//   dentro de uno    { v, s, o, c, d, m, i, f } d = cota inferior; (m, i) = última fila
//                                                entregada; f = 1 si el recorrido es completo
//
// SOLAPE (defensa adicional, no sustituto del cursor): cada recorrido nuevo empieza
// en c - 5 min. now() es el inicio de la transacción, no su commit: una fila puede
// hacerse visible con una marca ya superada. El cliente deduplica por pesajeId
// (upsert idempotente; ANULADO es terminal).
//
// CONCILIACIÓN: la última página de cada recorrido trae totales { pesajes, anulados }
// de la organización. Ambos solo crecen; si el dispositivo tiene menos, falta algo y
// el cliente rehace el recorrido completo. Se cuentan ANTES de leer las filas: en READ
// COMMITTED un commit entre ambas lecturas solo puede dejar filas de más.
//
// EVIDENCIA: clientOperationId (creación) y anulacionClientOperationId (qué operación
// anuló la fila) solo viajan aquí, para que el motor offline concilie; nunca en el GET
// público. Nunca se leen anulado_por ni actor_cuenta_id.
import { withOrganizacionTransaction } from '../../db/agxBusinessPool.js';
import { PESAJE_COLUMNS, serializePesaje } from './pesajesRepository.js';

export const PESAJES_SYNC_SOLAPE_MS = 5 * 60 * 1000;
export const PESAJES_SYNC_PAGINA = 500;
const EPOCH = new Date(0).toISOString();
const INSTANTE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const ID_PESAJE = /^[1-9]\d{0,18}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BIGINT_MAX = 9223372036854775807n;
const CLAVES_ENTRE = Object.freeze(['c', 'o', 's', 'v']);
const CLAVES_DENTRO = Object.freeze(['c', 'd', 'f', 'i', 'm', 'o', 's', 'v']);

function cursorInvalido() {
  return Object.assign(new Error('Cursor de sincronización inválido.'), { status: 400, code: 'INVALID_CURSOR' });
}

function esInstante(valor) {
  if (typeof valor !== 'string' || !INSTANTE.test(valor)) return false;
  const fecha = new Date(valor);
  return !Number.isNaN(fecha.getTime()) && fecha.toISOString().slice(0, 23) === valor.slice(0, 23);
}

const mismasClaves = (objeto, claves) => {
  const propias = Object.keys(objeto).sort();
  return propias.length === claves.length && propias.every((clave, i) => clave === claves[i]);
};

export function encodeCursorPesajes(organizacionId, contenido) {
  return Buffer.from(JSON.stringify({ v: 1, s: 'pesajes', o: organizacionId, ...contenido }), 'utf8').toString('base64url');
}

/**
 * Cursor opaco -> { c, d?, m?, i?, f } o null si está ausente. Ilegible, de otra
 * versión/ámbito, con campos de más o de otra organización -> 400 INVALID_CURSOR.
 */
export function decodeCursorPesajes(raw, organizacionId) {
  if (raw === undefined || raw === '') return null;
  if (typeof raw !== 'string' || raw.length > 500) throw cursorInvalido();
  let cursor;
  try {
    cursor = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw cursorInvalido();
  }
  if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) throw cursorInvalido();
  if (cursor.v !== 1 || cursor.s !== 'pesajes' || !esInstante(cursor.c)) throw cursorInvalido();
  if (typeof cursor.o !== 'string' || !UUID.test(cursor.o) || cursor.o !== String(organizacionId ?? '').toLowerCase()) throw cursorInvalido();
  if (mismasClaves(cursor, CLAVES_ENTRE)) return { c: cursor.c, f: false };
  if (!mismasClaves(cursor, CLAVES_DENTRO)) throw cursorInvalido();
  const idValido = typeof cursor.i === 'string' && ID_PESAJE.test(cursor.i) && BigInt(cursor.i) <= BIGINT_MAX;
  if (!esInstante(cursor.m) || !idValido || !esInstante(cursor.d) || (cursor.f !== 0 && cursor.f !== 1)) throw cursorInvalido();
  // La última fila entregada nunca es anterior a la cota inferior de su recorrido.
  if (cursor.m < cursor.d) throw cursorInvalido();
  return { c: cursor.c, d: cursor.d, m: cursor.m, i: cursor.i, f: cursor.f === 1 };
}

const textoInstante = (fecha) => `${fecha.toISOString().slice(0, 23)}000Z`;

/** Fila de sync: el pesaje público + la evidencia de conciliación, nada más. */
export function serializePesajeSync(fila) {
  return {
    ...serializePesaje(fila),
    animalId: fila.animal_id,
    organizacionId: fila.organizacion_id,
    clientOperationId: fila.client_operation_id ?? null,
    anulacionClientOperationId: fila.anulacion_client_operation_id ?? null,
  };
}

/** SQL de la página (exportado para EXPLAIN en la integración). */
export const SQL_PAGINA_PESAJES = `with pagina as (
       select p.pesaje_id, coalesce(p.anulado_at, p.created_at) as marca
         from agx.animal_pesajes p
        where coalesce(p.anulado_at, p.created_at) >= $1::timestamptz
          and ($2::timestamptz is null or (coalesce(p.anulado_at, p.created_at), p.pesaje_id) > ($2::timestamptz, $3::bigint))
        order by coalesce(p.anulado_at, p.created_at), p.pesaje_id
        limit $4
     )
     select ${PESAJE_COLUMNS},
            organizacion_id::text as organizacion_id,
            client_operation_id::text as client_operation_id,
            anulacion_client_operation_id::text as anulacion_client_operation_id,
            to_char(pg.marca at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as marca
       from pagina pg
       join agx.animal_pesajes using (pesaje_id)
      -- Calificado: un "pesaje_id" suelto resolvería al alias de salida ::text
      -- (orden lexicográfico '10' < '9') y la página saltaría filas.
      order by pg.marca, pg.pesaje_id`;

export const SQL_TOTALES_PESAJES = `select count(*)::int as pesajes,
            count(*) filter (where estado_registro = 'ANULADO')::int as anulados
       from agx.animal_pesajes`;

/** Página de un recorrido. Una consulta de totales y una de filas, sin N+1. */
export async function leerPaginaPesajesEnTx(client, organizacionId, { cursor: crudo, limite = PESAJES_SYNC_PAGINA } = {}) {
  const cursor = decodeCursorPesajes(crudo, organizacionId);
  const continua = Boolean(cursor?.m);
  const completo = cursor ? cursor.f : true;
  const corte = continua
    ? cursor.c
    : (await client.query(`select to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as t`)).rows[0].t;
  let desde = EPOCH;
  if (continua) desde = cursor.d;
  else if (cursor) desde = new Date(new Date(cursor.c).getTime() - PESAJES_SYNC_SOLAPE_MS).toISOString();
  desde = textoInstante(new Date(desde));

  const { rows: [totales] } = await client.query(SQL_TOTALES_PESAJES);
  const { rows } = await client.query(SQL_PAGINA_PESAJES, [desde, cursor?.m ?? null, cursor?.i ?? null, limite + 1]);

  const hayMas = rows.length > limite;
  const filas = hayMas ? rows.slice(0, limite) : rows;
  const ultima = filas[filas.length - 1];
  const org = String(organizacionId).toLowerCase();
  return {
    pesajes: filas.map(serializePesajeSync),
    hayMas,
    completo,
    cursorSiguiente: hayMas
      ? encodeCursorPesajes(org, { c: corte, d: desde, m: ultima.marca, i: ultima.pesaje_id, f: completo ? 1 : 0 })
      : encodeCursorPesajes(org, { c: corte }),
    totales: hayMas ? null : totales,
  };
}

export async function pullPesajes(organizacionId, { cursor }) {
  decodeCursorPesajes(cursor, organizacionId);
  return withOrganizacionTransaction(organizacionId, async (client) => {
    await client.query('set transaction read only');
    return leerPaginaPesajesEnTx(client, organizacionId, { cursor });
  });
}
