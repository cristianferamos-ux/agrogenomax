// CATX-DELIVERY-001: adaptador de almacenamiento por defecto/producción --
// guarda los bytes del PDF entregable en Postgres (catastrox_deliverable_blobs,
// migración 007), NUNCA en el disco efímero del proceso.
//
// Consultas siempre por deliverable_id exacto (clave primaria) -- este
// módulo no expone ninguna función de listado; ningún endpoint de
// historial debe poder enumerar blobs (ajuste obligatorio del plan
// aprobado).
import { query } from '../../../db.js';

const TABLE = 'public.catastrox_deliverable_blobs';

// Límite documentado en server/config/env.js (CATASTROX_DELIVERABLE_MAX_BYTES)
// y reforzado por un CHECK en la migración 007 -- esta es la primera
// barrera, a nivel de aplicación, antes de intentar el INSERT.
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10 MB

export function resolveMaxDeliverableBytes(source = process.env) {
  const raw = source.CATASTROX_DELIVERABLE_MAX_BYTES;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_BYTES;
}

/**
 * @param {string} deliverableId
 * @param {Buffer} buffer
 * @param {{ contentType?: string }} [options]
 * @returns {Promise<{ storageKey: string }>}
 */
export async function put(deliverableId, buffer, { contentType = 'application/pdf' } = {}) {
  if (!deliverableId) {
    throw Object.assign(new Error('deliverableId es obligatorio para almacenar un entregable.'), {
      code: 'DELIVERABLE_ID_REQUIRED',
    });
  }
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw Object.assign(new Error('El PDF generado está vacío -- no se almacena.'), {
      code: 'EMPTY_DELIVERABLE_BUFFER',
    });
  }

  const maxBytes = resolveMaxDeliverableBytes();
  if (buffer.length > maxBytes) {
    throw Object.assign(
      new Error(`El PDF generado (${buffer.length} bytes) supera el límite permitido (${maxBytes} bytes).`),
      { code: 'DELIVERABLE_TOO_LARGE' },
    );
  }

  await query(
    `insert into ${TABLE} (deliverable_id, bytes, content_type, byte_size)
     values ($1, $2, $3, $4)
     on conflict (deliverable_id) do update
       set bytes = excluded.bytes, content_type = excluded.content_type, byte_size = excluded.byte_size`,
    [deliverableId, buffer, contentType, buffer.length],
  );

  return { storageKey: `pg:${deliverableId}` };
}

/**
 * Recupera los bytes de un entregable por su deliverable_id EXACTO. Nunca
 * acepta un patrón, prefijo ni listado -- una sola fila o null.
 *
 * @param {string} deliverableId
 * @returns {Promise<{ bytes: Buffer, contentType: string } | null>}
 */
export async function get(deliverableId) {
  if (!deliverableId) return null;

  const result = await query(`select bytes, content_type from ${TABLE} where deliverable_id = $1`, [deliverableId]);
  const row = result.rows[0];
  if (!row) return null;

  return { bytes: row.bytes, contentType: row.content_type };
}
