// FASE 1A -- acceso a datos de pesajes (agx.animal_pesajes, 0022 + 0024)
// contra Postgres-AGX-Business. Mismo contrato que animalesRepository.js:
// `organizacionId` llega YA autorizado (req.ganaderiaAuth, nunca del
// cliente) y todo corre en withOrganizacionTransaction; RLS+FORCE aísla y un
// animal de otra organización es indistinguible de uno inexistente (404).
//
// animal_pesajes es append-only para agx_app: aquí solo hay SELECT e INSERT.
// No se escribe en agx.animales (peso actual, GMD, etc. se derivan al leer)
// ni en agx.animal_eventos (el historial es la fuente de verdad; la línea de
// tiempo futura se agregará desde las tablas especializadas).
// Nunca toca el Postgres legacy (server/db.js).
import { withOrganizacionTransaction } from '../../db/agxBusinessPool.js';
import { errorAnimalCerrado } from './cierreValidation.js';

const CLIENT_OPERATION_UNIQUE_CONSTRAINT = 'animal_pesajes_org_client_operation_key';

function semanticError(code, status, message) {
  return Object.assign(new Error(message || code), { status, code });
}

// Fechas como texto (sin conversión de zona horaria del driver) y peso como
// texto exacto de numeric (se convierte a Number al serializar).
const PESAJE_COLUMNS = `
  pesaje_id::text as pesaje_id,
  animal_id::text as animal_id,
  to_char(fecha, 'YYYY-MM-DD') as fecha,
  peso_kg::text as peso_kg,
  metodo,
  origen,
  observaciones,
  to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at`;

export function serializePesaje(row) {
  return {
    pesajeId: row.pesaje_id,
    fecha: row.fecha,
    pesoKg: Number(row.peso_kg),
    metodo: row.metodo,
    origen: row.origen,
    observaciones: row.observaciones,
    createdAt: row.created_at,
  };
}

async function fetchAnimalEstado(client, animalId, { forShare = false } = {}) {
  // FOR SHARE: una anulación concurrente del animal espera al COMMIT del
  // pesaje (y viceversa), sin bloquear otros pesajes del mismo animal.
  const result = await client.query(
    `select animal_id::text as animal_id, estado, estado_operativo
       from agx.animales where animal_id = $1${forShare ? ' for share' : ''}`,
    [animalId],
  );
  return result.rows[0] ?? null;
}

/**
 * Pesajes del animal (ASCENDENTE: fecha, pesaje_id) dentro de una
 * transacción YA abierta con withOrganizacionTransaction (RLS activo).
 * FASE 1D.2: la reutiliza la línea de tiempo para leer todo en una sola
 * transacción.
 */
export async function listPesajesEnTx(client, animalId) {
  const result = await client.query(
    `select ${PESAJE_COLUMNS}
       from agx.animal_pesajes
      where animal_id = $1
      order by fecha asc, pesaje_id asc`,
    [animalId],
  );
  return result.rows.map(serializePesaje);
}

/**
 * Historial completo del animal en orden cronológico ASCENDENTE
 * (fecha, pesaje_id). null si el animal no existe o es de otra organización.
 */
export async function listPesajesDeAnimal(organizacionId, animalId) {
  return withOrganizacionTransaction(organizacionId, async (client) => {
    const animal = await fetchAnimalEstado(client, animalId);
    if (!animal) return null;
    return { animalId: animal.animal_id, estadoAnimal: animal.estado, pesajes: await listPesajesEnTx(client, animalId) };
  });
}

function mismaIntencion(row, animalId, value) {
  return (
    row.animal_id === String(animalId)
    && row.fecha === value.fecha
    && Number(row.peso_kg) === value.pesoKg
    && row.metodo === value.metodo
    && (row.observaciones ?? null) === (value.observaciones ?? null)
  );
}

/**
 * POST pesaje MANUAL idempotente por (organizacion_id, client_operation_id):
 *   1. advisory lock transaccional por org + operación (serializa reintentos
 *      concurrentes de la MISMA operación);
 *   2. si la operación ya existe: misma intención (animal, fecha, peso,
 *      método, observaciones) -> {yaExistia: true} sin escribir; distinta ->
 *      409 CLIENT_OPERATION_ID_REUSED;
 *   3. si no existe: animal visible (404 ANIMAL_NOT_FOUND) y ACTIVO
 *      (409 ANIMAL_ANULADO), INSERT origen MANUAL.
 * El conflicto de transporte (2) se evalúa antes que el de negocio (3).
 */
export async function registrarPesajeIdempotente(organizacionId, animalId, value, { actorCuentaId }) {
  return withOrganizacionTransaction(organizacionId, async (client) => {
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [
      `ganaderia_pesaje_create:${organizacionId}:${value.clientOperationId}`,
    ]);

    const existingResult = await client.query(
      `select ${PESAJE_COLUMNS}
         from agx.animal_pesajes
        where organizacion_id = $1 and client_operation_id = $2`,
      [organizacionId, value.clientOperationId],
    );
    const existing = existingResult.rows[0];
    if (existing) {
      if (!mismaIntencion(existing, animalId, value)) {
        throw semanticError(
          'CLIENT_OPERATION_ID_REUSED',
          409,
          'Esta operación ya registró un pesaje con datos distintos. Revisa el historial del animal.',
        );
      }
      return { pesaje: serializePesaje(existing), yaExistia: true };
    }

    const animal = await fetchAnimalEstado(client, animalId, { forShare: true });
    if (!animal) throw semanticError('ANIMAL_NOT_FOUND', 404, 'Animal no encontrado.');
    if (animal.estado !== 'ACTIVO') {
      throw semanticError('ANIMAL_ANULADO', 409, 'El animal está anulado: no admite nuevos pesajes.');
    }
    // FASE 2A: un animal salido o muerto conserva su historial, sin pesajes nuevos.
    const cerrado = errorAnimalCerrado(animal.estado_operativo, 'no admite nuevos pesajes');
    if (cerrado) throw cerrado;

    try {
      const inserted = await client.query(
        `insert into agx.animal_pesajes
           (organizacion_id, animal_id, fecha, peso_kg, metodo, origen, actor_cuenta_id, client_operation_id, observaciones)
         values ($1, $2, $3, $4, $5, 'MANUAL', $6, $7, $8)
         returning ${PESAJE_COLUMNS}`,
        [organizacionId, animalId, value.fecha, value.pesoKg, value.metodo, actorCuentaId, value.clientOperationId, value.observaciones],
      );
      return { pesaje: serializePesaje(inserted.rows[0]), yaExistia: false };
    } catch (error) {
      if (error?.code === '23505' && error?.constraint === CLIENT_OPERATION_UNIQUE_CONSTRAINT) {
        throw semanticError('CLIENT_OPERATION_ID_REUSED', 409, 'Esta operación ya fue registrada.');
      }
      throw error;
    }
  });
}
