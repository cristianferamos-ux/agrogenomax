// FASE 1A / FASE 5A.1b -- acceso a datos de pesajes (agx.animal_pesajes,
// 0022 + 0024 + 0028) contra Postgres-AGX-Business. Mismo contrato que
// animalesRepository.js: `organizacionId` llega YA autorizado
// (req.ganaderiaAuth, nunca del cliente) y todo corre en
// withOrganizacionTransaction; RLS+FORCE aísla y un animal o pesaje de otra
// organización es indistinguible de uno inexistente (404).
//
// agx_app: SELECT/INSERT y, desde 0028, UPDATE SOLO de las columnas de
// anulación (el trigger agx.fn_animal_pesajes_guard impide cualquier otro
// cambio y el DELETE). Un pesaje erróneo se ANULA (quién, cuándo, por qué);
// nunca se borra ni se edita. No se escribe en agx.animales (peso actual,
// GMD, etc. se derivan al leer) ni en agx.animal_eventos.
// Nunca toca el Postgres legacy (server/db.js).
//
// IDEMPOTENCIA (FASE 5A.1b): registrar y anular comparten el MISMO advisory
// lock por organización + clientOperationId, con la clave histórica
// `ganaderia_pesaje_create:<org>:<op>` (una instancia anterior que solo
// registra serializa igual con una nueva que anula). Orden en ambos:
// lock -> reintento legítimo -> reutilización cruzada (el id ya se usó en el
// otro tipo de operación: 409 CLIENT_OPERATION_ID_REUSED) -> reglas de
// negocio -> escritura.
import { withOrganizacionTransaction } from '../../db/agxBusinessPool.js';
import { errorAnimalCerrado } from './cierreValidation.js';

const CLIENT_OPERATION_UNIQUE_CONSTRAINT = 'animal_pesajes_org_client_operation_key';
const ANULACION_CLIENT_OPERATION_UNIQUE_INDEX = 'animal_pesajes_org_anulacion_client_operation_key';

function semanticError(code, status, message) {
  return Object.assign(new Error(message || code), { status, code });
}

function errorReused(message = 'Esta operación ya fue usada con datos distintos. Revisa el historial del animal.') {
  return semanticError('CLIENT_OPERATION_ID_REUSED', 409, message);
}

// Fechas como texto (sin conversión de zona horaria del driver) y peso como
// texto exacto de numeric (se convierte a Number al serializar). Nunca se
// leen anulado_por ni los client_operation_id: no se exponen (FASE 5A.3a: los
// client_operation_id solo los lee pesajesSyncRepository, para /sync/pesajes).
export const PESAJE_COLUMNS = `
  pesaje_id::text as pesaje_id,
  animal_id::text as animal_id,
  to_char(fecha, 'YYYY-MM-DD') as fecha,
  peso_kg::text as peso_kg,
  metodo,
  origen,
  observaciones,
  to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at,
  estado_registro,
  motivo_anulacion,
  to_char(anulado_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as anulado_at`;

export function serializePesaje(row) {
  return {
    pesajeId: row.pesaje_id,
    fecha: row.fecha,
    pesoKg: Number(row.peso_kg),
    metodo: row.metodo,
    origen: row.origen,
    observaciones: row.observaciones,
    createdAt: row.created_at,
    estadoRegistro: row.estado_registro,
    anulacion: row.estado_registro === 'ANULADO' ? { anuladoEn: row.anulado_at, motivo: row.motivo_anulacion } : null,
  };
}

async function fetchAnimalEstado(client, animalId, { forShare = false } = {}) {
  // FOR SHARE: una anulación o corrección concurrente del animal (FOR UPDATE)
  // espera al COMMIT del pesaje (y viceversa), sin bloquear otros pesajes.
  const result = await client.query(
    `select animal_id::text as animal_id, estado, estado_operativo,
            to_char(fecha_nacimiento, 'YYYY-MM-DD') as fecha_nacimiento,
            to_char(fecha_ingreso, 'YYYY-MM-DD') as fecha_ingreso
       from agx.animales where animal_id = $1${forShare ? ' for share' : ''}`,
    [animalId],
  );
  return result.rows[0] ?? null;
}

/**
 * Pesajes del animal, ACTIVOS y ANULADOS (ASCENDENTE: fecha, pesaje_id),
 * dentro de una transacción YA abierta con withOrganizacionTransaction (RLS
 * activo). La línea de tiempo la reutiliza para leer todo en una sola
 * transacción; los cálculos filtran ACTIVOS en el motor canónico.
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
 * Historial completo del animal (ACTIVOS + ANULADOS) en orden cronológico
 * ASCENDENTE. null si el animal no existe o es de otra organización.
 */
export async function listPesajesDeAnimal(organizacionId, animalId) {
  return withOrganizacionTransaction(organizacionId, async (client) => {
    const animal = await fetchAnimalEstado(client, animalId);
    if (!animal) return null;
    return { animalId: animal.animal_id, estadoAnimal: animal.estado, pesajes: await listPesajesEnTx(client, animalId) };
  });
}

async function lockOperacion(client, organizacionId, clientOperationId) {
  // Clave HISTÓRICA compartida por registrar y anular (ver cabecera).
  await client.query('select pg_advisory_xact_lock(hashtext($1))', [
    `ganaderia_pesaje_create:${organizacionId}:${clientOperationId}`,
  ]);
}

async function existeAnulacionConOperacion(client, organizacionId, clientOperationId) {
  const result = await client.query(
    `select 1 from agx.animal_pesajes
      where organizacion_id = $1 and anulacion_client_operation_id = $2
      limit 1`,
    [organizacionId, clientOperationId],
  );
  return result.rows.length > 0;
}

async function existeRegistroConOperacion(client, organizacionId, clientOperationId) {
  const result = await client.query(
    `select 1 from agx.animal_pesajes
      where organizacion_id = $1 and client_operation_id = $2
      limit 1`,
    [organizacionId, clientOperationId],
  );
  return result.rows.length > 0;
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
 * Límite inferior de la fecha de un pesaje (FASE 5A.1b): nacimiento y,
 * después, ingreso físico/adquisición (fecha_ingreso >= fecha_nacimiento por
 * CHECK; si la fecha viola ambas, se informa NACIMIENTO: orden determinista).
 */
function validarFechaContraAnimal(animal, fecha) {
  if (animal.fecha_nacimiento && fecha < animal.fecha_nacimiento) {
    throw semanticError(
      'FECHA_ANTERIOR_A_NACIMIENTO',
      400,
      `La fecha del pesaje no puede ser anterior a la fecha de nacimiento del animal (${animal.fecha_nacimiento}).`,
    );
  }
  if (animal.fecha_ingreso && fecha < animal.fecha_ingreso) {
    throw semanticError(
      'FECHA_ANTERIOR_A_INGRESO',
      400,
      `La fecha del pesaje no puede ser anterior a la fecha de ingreso del animal (${animal.fecha_ingreso}).`,
    );
  }
}

/**
 * POST pesaje MANUAL idempotente por (organizacion_id, client_operation_id):
 *   1. advisory lock transaccional por org + operación (común con anular);
 *   2. si la operación ya registró un pesaje: misma intención (animal, fecha,
 *      peso, método, observaciones) -> {yaExistia: true} sin escribir;
 *      distinta -> 409 CLIENT_OPERATION_ID_REUSED;
 *   3. si la operación ya ANULÓ un pesaje -> 409 CLIENT_OPERATION_ID_REUSED;
 *   4. animal visible (404 ANIMAL_NOT_FOUND), ACTIVO (409 ANIMAL_ANULADO), en
 *      el hato (409 por cierre) y fecha >= nacimiento / ingreso (400);
 *   5. INSERT origen MANUAL (nace ACTIVO).
 * Los conflictos de transporte (2-3) se evalúan antes que los de negocio (4).
 */
export async function registrarPesajeIdempotente(organizacionId, animalId, value, { actorCuentaId }) {
  return withOrganizacionTransaction(organizacionId, async (client) => {
    await lockOperacion(client, organizacionId, value.clientOperationId);

    const existingResult = await client.query(
      `select ${PESAJE_COLUMNS}
         from agx.animal_pesajes
        where organizacion_id = $1 and client_operation_id = $2`,
      [organizacionId, value.clientOperationId],
    );
    const existing = existingResult.rows[0];
    if (existing) {
      if (!mismaIntencion(existing, animalId, value)) {
        throw errorReused('Esta operación ya registró un pesaje con datos distintos. Revisa el historial del animal.');
      }
      return { pesaje: serializePesaje(existing), yaExistia: true };
    }
    // FASE 5A.1b: el id ya se usó para ANULAR un pesaje.
    if (await existeAnulacionConOperacion(client, organizacionId, value.clientOperationId)) throw errorReused();

    const animal = await fetchAnimalEstado(client, animalId, { forShare: true });
    if (!animal) throw semanticError('ANIMAL_NOT_FOUND', 404, 'Animal no encontrado.');
    if (animal.estado !== 'ACTIVO') {
      throw semanticError('ANIMAL_ANULADO', 409, 'El animal está anulado: no admite nuevos pesajes.');
    }
    // FASE 2A: un animal salido o muerto conserva su historial, sin pesajes nuevos.
    const cerrado = errorAnimalCerrado(animal.estado_operativo, 'no admite nuevos pesajes');
    if (cerrado) throw cerrado;
    validarFechaContraAnimal(animal, value.fecha);

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
        throw errorReused('Esta operación ya fue registrada.');
      }
      throw error;
    }
  });
}

/**
 * POST anular (owner/admin) idempotente por
 * (organizacion_id, anulacion_client_operation_id):
 *   1. advisory lock transaccional por org + operación (común con registrar);
 *   2. si la operación ya anuló un pesaje: mismo pesaje + animal + motivo ->
 *      {yaExistia: true} sin escribir; si no -> 409 CLIENT_OPERATION_ID_REUSED;
 *   3. si la operación ya REGISTRÓ un pesaje -> 409 CLIENT_OPERATION_ID_REUSED;
 *   4. animal visible (404 ANIMAL_NOT_FOUND) y no ANULADO (409 ANIMAL_ANULADO;
 *      un animal SALIDO/MUERTO sí admite corregir su historia); pesaje del
 *      animal visible (404 PESAJE_NOT_FOUND, también si es de otra
 *      organización) y ACTIVO (409 PESAJE_YA_ANULADO);
 *   5. UPDATE SOLO de las columnas de anulación: actor = cuenta de la sesión,
 *      instante = now() de Postgres. Nunca DELETE ni cambios del original.
 * Devuelve el historial completo del animal leído en la MISMA transacción.
 */
export async function anularPesajeIdempotente(organizacionId, animalId, pesajeId, value, { actorCuentaId }) {
  return withOrganizacionTransaction(organizacionId, async (client) => {
    await lockOperacion(client, organizacionId, value.clientOperationId);

    const previa = await client.query(
      `select pesaje_id::text as pesaje_id, animal_id::text as animal_id, motivo_anulacion
         from agx.animal_pesajes
        where organizacion_id = $1 and anulacion_client_operation_id = $2`,
      [organizacionId, value.clientOperationId],
    );
    const existente = previa.rows[0];
    if (existente) {
      if (existente.pesaje_id !== String(pesajeId) || existente.animal_id !== String(animalId) || existente.motivo_anulacion !== value.motivo) {
        throw errorReused('Esta operación ya anuló un pesaje con datos distintos. Revisa el historial del animal.');
      }
      const pesajes = await listPesajesEnTx(client, animalId);
      return { pesajes, yaExistia: true };
    }
    // El id ya se usó para REGISTRAR un pesaje.
    if (await existeRegistroConOperacion(client, organizacionId, value.clientOperationId)) throw errorReused();

    const animal = await fetchAnimalEstado(client, animalId, { forShare: true });
    if (!animal) throw semanticError('ANIMAL_NOT_FOUND', 404, 'Animal no encontrado.');
    if (animal.estado !== 'ACTIVO') {
      throw semanticError('ANIMAL_ANULADO', 409, 'El animal está anulado: sus pesajes no admiten cambios.');
    }

    const objetivo = await client.query(
      `select estado_registro from agx.animal_pesajes
        where pesaje_id = $1 and animal_id = $2
        for update`,
      [pesajeId, animalId],
    );
    const fila = objetivo.rows[0];
    if (!fila) throw semanticError('PESAJE_NOT_FOUND', 404, 'Pesaje no encontrado.');
    if (fila.estado_registro !== 'ACTIVO') throw semanticError('PESAJE_YA_ANULADO', 409, 'El pesaje ya está anulado.');

    try {
      await client.query(
        `update agx.animal_pesajes
            set estado_registro = 'ANULADO', anulado_por = $2, anulado_at = now(),
                motivo_anulacion = $3, anulacion_client_operation_id = $4
          where pesaje_id = $1`,
        [pesajeId, actorCuentaId, value.motivo, value.clientOperationId],
      );
    } catch (error) {
      if (error?.code === '23505' && error?.constraint === ANULACION_CLIENT_OPERATION_UNIQUE_INDEX) throw errorReused();
      throw error;
    }
    const pesajes = await listPesajesEnTx(client, animalId);
    return { pesajes, yaExistia: false };
  });
}

/**
 * Corrección de fechas del animal (animalesRepository.corregirAnimal) frente
 * a sus pesajes ACTIVOS -- los ANULADOS no restringen. Misma transacción, con
 * el animal ya FOR UPDATE (un pesaje concurrente toma FOR SHARE y espera).
 * Nunca modifica pesajes para permitir el cambio.
 */
export async function assertCorreccionCompatibleConPesajesEnTx(client, animalId, { fechaNacimiento, fechaIngreso, cambiaFechaNacimiento, cambiaFechaIngreso }) {
  if (!cambiaFechaNacimiento && !cambiaFechaIngreso) return;
  const result = await client.query(
    `select to_char(min(fecha), 'YYYY-MM-DD') as primer_pesaje
       from agx.animal_pesajes
      where animal_id = $1 and estado_registro = 'ACTIVO'`,
    [animalId],
  );
  const primerPesaje = result.rows[0]?.primer_pesaje ?? null;
  if (!primerPesaje) return;
  for (const [cambia, fecha, campo] of [
    [cambiaFechaNacimiento, fechaNacimiento, 'fecha de nacimiento'],
    [cambiaFechaIngreso, fechaIngreso, 'fecha de ingreso'],
  ]) {
    if (cambia && fecha && fecha > primerPesaje) {
      throw semanticError(
        'HISTORIAL_PESAJES_FECHA_INCOMPATIBLE',
        409,
        `La ${campo} no puede ser posterior al primer pesaje activo del animal (${primerPesaje}). Anula ese pesaje si es erróneo.`,
      );
    }
  }
}
