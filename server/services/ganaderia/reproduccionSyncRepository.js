// FASE 4E.1 -- PULL reproductivo (GET /api/ganaderia/sync/reproduccion). Solo
// lectura, bajo withOrganizacionTransaction (RLS FORCE): el tenant sale de la
// sesión. Cursor propio, nunca compartido con /sync/pull.
//
// MARCA: coalesce(anulado_at, registrado_at), el último cambio de la fila. El
// historial es inmutable salvo ACTIVO -> ANULADO y no hay borrados, así que un
// evento nuevo y una anulación posterior se detectan con una sola columna lógica.
//
// CURSOR: opaco, base64url de JSON con s='repro'.
//   entre recorridos { v, s, c }             c = now() de la primera página del recorrido
//   dentro de uno    { v, s, c, d, m, i, f } d = cota inferior; (m, i) = última fila
//                                            entregada; f = recorrido completo
// El orden (marca, evento_id) es total: filas con el mismo instante no se pierden
// al paginar, y los instantes viajan como texto con microsegundos.
//
// SOLAPE: cada recorrido nuevo empieza en c - 5 min. now() es el inicio de la
// transacción, no su commit: una fila puede hacerse visible con una marca ya
// superada. Registrar tarda milisegundos, pero el pool no tiene statement_timeout
// y puede esperar por el bloqueo del animal; los 5 min cubren esa espera y pasos
// del reloj sin coste apreciable (la ventana suele traer pocas filas), y el cliente
// resuelve la reentrega con un upsert idempotente.
//
// CONCILIACIÓN: el solape no depende solo del reloj. La última página de cada
// recorrido trae totales { eventos, anulados }. Ambos solo crecen, de modo que si
// el dispositivo tiene menos que el servidor falta algo, sea cual sea la causa, y
// el cliente rehace el recorrido completo. Se cuentan ANTES de leer las filas: en
// READ COMMITTED un commit entre ambas lecturas solo puede dejar filas de más, nunca
// un falso desfase.
//
// Sin índice nuevo: medido hasta 200.000 eventos por organización (ver el informe
// de la fase); el índice ensayado no mejoró el caso incremental con RLS.
import { withOrganizacionTransaction } from '../../db/agxBusinessPool.js';
import { EVENTO_COLUMNS, eventoPublico, serializeEventoReproductivo } from './reproduccionRepository.js';

export const REPRO_SYNC_SOLAPE_MS = 5 * 60 * 1000;
export const REPRO_SYNC_PAGINA = 500;
const EPOCH = new Date(0).toISOString();
const INSTANTE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const ID_EVENTO = /^[1-9]\d{0,18}$/;
const BIGINT_MAX = 9223372036854775807n;

function cursorInvalido() {
  return Object.assign(new Error('Cursor de sincronización inválido.'), { status: 400, code: 'INVALID_CURSOR' });
}

function esInstante(valor) {
  if (typeof valor !== 'string' || !INSTANTE.test(valor)) return false;
  const fecha = new Date(valor);
  return !Number.isNaN(fecha.getTime()) && fecha.toISOString().slice(0, 23) === valor.slice(0, 23);
}

export function encodeCursorReproduccion(contenido) {
  return Buffer.from(JSON.stringify({ v: 1, s: 'repro', ...contenido }), 'utf8').toString('base64url');
}

/** Cursor opaco -> { c, d?, m?, i?, f? } o null si está ausente. Ilegible -> 400. */
export function decodeCursorReproduccion(raw) {
  if (raw === undefined || raw === '') return null;
  if (typeof raw !== 'string' || raw.length > 400) throw cursorInvalido();
  let cursor;
  try {
    cursor = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw cursorInvalido();
  }
  if (cursor?.v !== 1 || cursor.s !== 'repro' || !esInstante(cursor.c)) throw cursorInvalido();
  if (cursor.m === undefined && cursor.i === undefined && cursor.d === undefined) return { c: cursor.c, f: false };
  const idValido = typeof cursor.i === 'string' && ID_EVENTO.test(cursor.i) && BigInt(cursor.i) <= BIGINT_MAX;
  if (!esInstante(cursor.m) || !idValido || typeof cursor.d !== 'string' || Number.isNaN(new Date(cursor.d).getTime())) throw cursorInvalido();
  return { c: cursor.c, d: new Date(cursor.d).toISOString(), m: cursor.m, i: cursor.i, f: cursor.f === 1 };
}

/** Página de un recorrido. Una sola consulta de totales y una de filas, sin N+1. */
export async function leerPaginaEnTx(client, { cursor: crudo, limite = REPRO_SYNC_PAGINA } = {}) {
  const cursor = decodeCursorReproduccion(crudo);
  const continua = Boolean(cursor?.m);
  const completo = cursor ? cursor.f : true;
  const corte = continua
    ? cursor.c
    : (await client.query(`select to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as t`)).rows[0].t;
  let desde = EPOCH;
  if (continua) desde = cursor.d;
  else if (cursor) desde = new Date(new Date(cursor.c).getTime() - REPRO_SYNC_SOLAPE_MS).toISOString();

  const { rows: [totales] } = await client.query(
    `select count(*)::int as eventos, count(*) filter (where e.estado_registro = 'ANULADO')::int as anulados
       from agx.reproduccion_eventos e`,
  );
  const { rows } = await client.query(
    `with pagina as (
       select e.evento_id, coalesce(e.anulado_at, e.registrado_at) as marca
         from agx.reproduccion_eventos e
        where coalesce(e.anulado_at, e.registrado_at) >= $1::timestamptz
          and ($2::timestamptz is null or (coalesce(e.anulado_at, e.registrado_at), e.evento_id) > ($2::timestamptz, $3::bigint))
        order by coalesce(e.anulado_at, e.registrado_at), e.evento_id
        limit $4
     )
     select ${EVENTO_COLUMNS},
            e.client_operation_id::text as client_operation_id,
            to_char(p.marca at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as marca
       from pagina p
       join agx.reproduccion_eventos e on e.evento_id = p.evento_id
      order by p.marca, p.evento_id`,
    [desde, cursor?.m ?? null, cursor?.i ?? null, limite + 1],
  );

  const hayMas = rows.length > limite;
  const filas = hayMas ? rows.slice(0, limite) : rows;
  const ultima = filas[filas.length - 1];
  return {
    eventos: filas.map((fila) => ({ ...eventoPublico(serializeEventoReproductivo(fila)), clientOperationId: fila.client_operation_id })),
    hayMas,
    completo,
    cursor: hayMas
      ? encodeCursorReproduccion({ c: corte, d: desde, m: ultima.marca, i: ultima.evento_id, f: completo ? 1 : 0 })
      : encodeCursorReproduccion({ c: corte }),
    totales: hayMas ? null : totales,
  };
}

export async function pullEventosReproductivos(organizacionId, { cursor }) {
  decodeCursorReproduccion(cursor);
  return withOrganizacionTransaction(organizacionId, async (client) => {
    await client.query('set transaction read only');
    return leerPaginaEnTx(client, { cursor });
  });
}
