// FASE 4A -- historial reproductivo (agx.reproduccion_eventos, 0026) contra
// Postgres-AGX-Business. Mismo contrato que pesajesRepository.js /
// cierreRepository.js: `organizacionId` llega YA autorizado
// (req.ganaderiaAuth, nunca del cliente) y todo corre en
// withOrganizacionTransaction; RLS+FORCE aísla y un animal de otra
// organización es indistinguible de uno inexistente (404).
//
// Fuente canónica única: agx.reproduccion_eventos. El estado reproductivo se
// DERIVA (reproduccionEstado.js) al leer y dentro de cada escritura; nunca se
// guarda en agx.animales ni se duplica en agx.animal_eventos (la línea de
// tiempo lee esta tabla directamente).
//
// Concurrencia (orden FIJO de bloqueos en todas las escrituras -> sin
// interbloqueos):
//   1. pg_advisory_xact_lock(org + client_operation_id): serializa reintentos
//      de la MISMA operación;
//   2. pg_advisory_xact_lock(org + animal): serializa TODA escritura
//      reproductiva del mismo animal (dos diagnósticos simultáneos se aplican
//      uno tras otro, cada uno contra el estado que dejó el anterior);
//   3. animal FOR SHARE: una anulación o cierre concurrente del animal (FOR
//      UPDATE) espera al COMMIT, sin bloquear pesajes (también FOR SHARE).
// Nunca toca el Postgres legacy (server/db.js).
import { withOrganizacionTransaction } from '../../db/agxBusinessPool.js';
import { errorAnimalCerrado } from './cierreValidation.js';
import { computeReproduccionIntentHash } from './reproduccionIntentHash.js';
import { derivarEstadoReproductivo, reglaRegistro } from './reproduccionEstado.js';

const CLIENT_OPERATION_UNIQUE_CONSTRAINT = 'reproduccion_eventos_org_client_operation_key';
const ANULACION_CLIENT_OPERATION_UNIQUE_INDEX = 'reproduccion_eventos_org_anulacion_client_operation_key';
const UNA_CORRECCION_UNIQUE_INDEX = 'reproduccion_eventos_una_correccion_idx';

function semanticError(code, status, message) {
  return Object.assign(new Error(message || code), { status, code });
}

const errorReused = () => semanticError(
  'CLIENT_OPERATION_ID_REUSED',
  409,
  'Esta operación ya fue registrada con datos distintos. Revisa el historial reproductivo del animal.',
);

// camelCase (validación) <-> columna. Orden = INSERT.
const COLUMNAS = Object.freeze({
  tipoEvento: 'tipo_evento',
  fechaEvento: 'fecha_evento',
  horaEvento: 'hora_evento',
  intensidadCelo: 'intensidad_celo',
  metodoDeteccion: 'metodo_deteccion',
  tipoServicio: 'tipo_servicio',
  toroAnimalId: 'toro_animal_id',
  toroExterno: 'toro_externo',
  semenCodigo: 'semen_codigo',
  protocoloIatf: 'protocolo_iatf',
  tecnico: 'tecnico',
  embrionCodigo: 'embrion_codigo',
  embrionRaza: 'embrion_raza',
  embrionDonadora: 'embrion_donadora',
  embrionEstadio: 'embrion_estadio',
  embrionCalidad: 'embrion_calidad',
  embrionConservacion: 'embrion_conservacion',
  diagnosticoResultado: 'diagnostico_resultado',
  diagnosticoMetodo: 'diagnostico_metodo',
  diasGestacion: 'dias_gestacion',
  abortoCausa: 'aborto_causa',
  partoTipo: 'parto_tipo',
  numeroCrias: 'numero_crias',
  observaciones: 'observaciones',
});
// Campos propios de un tipo (se exponen en `detalle` solo si no son null).
const CAMPOS_DETALLE = Object.keys(COLUMNAS).filter((c) => !['tipoEvento', 'fechaEvento', 'horaEvento', 'observaciones'].includes(c));

// Fechas/horas como texto (sin conversión de zona horaria del driver).
const EVENTO_COLUMNS = `
  e.evento_id::text as evento_id,
  e.animal_id::text as animal_id,
  e.tipo_evento,
  to_char(e.fecha_evento, 'YYYY-MM-DD') as fecha_evento,
  to_char(e.hora_evento, 'HH24:MI') as hora_evento,
  e.intensidad_celo, e.metodo_deteccion, e.tipo_servicio,
  e.toro_animal_id::text as toro_animal_id, e.toro_externo,
  e.semen_codigo, e.protocolo_iatf, e.tecnico,
  e.embrion_codigo, e.embrion_raza, e.embrion_donadora, e.embrion_estadio, e.embrion_calidad, e.embrion_conservacion,
  e.diagnostico_resultado, e.diagnostico_metodo, e.dias_gestacion, e.aborto_causa,
  e.parto_tipo, e.numero_crias,
  e.observaciones,
  e.corrige_evento_id::text as corrige_evento_id,
  (select c.evento_id::text from agx.reproduccion_eventos c where c.corrige_evento_id = e.evento_id) as corregido_por_evento_id,
  e.estado_registro,
  e.motivo_anulacion,
  to_char(e.anulado_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as anulado_at,
  to_char(e.registrado_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as registrado_at`;

/**
 * Evento en el formato público. Nunca expone actor, client_operation_id ni
 * intent_hash. Los campos propios del tipo van planos (para el plegado del
 * estado) y en `detalle` (solo los presentes).
 */
export function serializeEventoReproductivo(row) {
  const evento = {
    eventoId: row.evento_id,
    animalId: row.animal_id,
    tipoEvento: row.tipo_evento,
    fechaEvento: row.fecha_evento,
    horaEvento: row.hora_evento ?? null,
    observaciones: row.observaciones ?? null,
    detalle: {},
    estadoRegistro: row.estado_registro,
    corrigeEventoId: row.corrige_evento_id ?? null,
    corregidoPorEventoId: row.corregido_por_evento_id ?? null,
    anulacion: row.estado_registro === 'ANULADO' ? { anuladoEn: row.anulado_at, motivo: row.motivo_anulacion } : null,
    registradoEn: row.registrado_at,
  };
  for (const campo of CAMPOS_DETALLE) {
    const raw = row[COLUMNAS[campo]];
    const valor = raw === undefined ? null : raw;
    evento[campo] = valor;
    if (valor !== null) evento.detalle[campo] = valor;
  }
  return evento;
}

// Vista pública: sin los campos planos de detalle (ya están en `detalle`).
function publico(evento) {
  const out = { ...evento };
  for (const campo of CAMPOS_DETALLE) delete out[campo];
  return out;
}

async function fetchAnimalRepro(client, animalId, { forShare = false } = {}) {
  const result = await client.query(
    `select animal_id::text as animal_id, estado, estado_operativo, sexo,
            to_char(fecha_nacimiento, 'YYYY-MM-DD') as fecha_nacimiento
       from agx.animales where animal_id = $1${forShare ? ' for share' : ''}`,
    [animalId],
  );
  return result.rows[0] ?? null;
}

/** Historial completo (ACTIVO y ANULADO), ASCENDENTE (fecha, id). Transacción YA abierta. */
export async function listEventosReproductivosEnTx(client, animalId) {
  const result = await client.query(
    `select ${EVENTO_COLUMNS}
       from agx.reproduccion_eventos e
      where e.animal_id = $1
      order by e.fecha_evento asc, e.evento_id asc`,
    [animalId],
  );
  return result.rows.map(serializeEventoReproductivo);
}

async function fetchEvento(client, eventoId) {
  const result = await client.query(`select ${EVENTO_COLUMNS} from agx.reproduccion_eventos e where e.evento_id = $1`, [eventoId]);
  return result.rows[0] ? serializeEventoReproductivo(result.rows[0]) : null;
}

function resumen(animal, eventos, hoy) {
  return {
    animalId: animal.animal_id,
    sexo: animal.sexo,
    estado: derivarEstadoReproductivo({ sexo: animal.sexo, eventos, hoy }),
  };
}

/** GET historial + estado. null si el animal no existe o es de otra organización. */
export async function obtenerReproduccionAnimal(organizacionId, animalId, { hoy }) {
  return withOrganizacionTransaction(organizacionId, async (client) => {
    const animal = await fetchAnimalRepro(client, animalId);
    if (!animal) return null;
    const eventos = await listEventosReproductivosEnTx(client, animalId);
    return { ...resumen(animal, eventos, hoy), orden: 'ASCENDENTE', eventos: eventos.map(publico) };
  });
}

/** GET estado derivado. null si el animal no existe o es de otra organización. */
export async function obtenerEstadoReproductivo(organizacionId, animalId, { hoy }) {
  return withOrganizacionTransaction(organizacionId, async (client) => {
    const animal = await fetchAnimalRepro(client, animalId);
    if (!animal) return null;
    return resumen(animal, await listEventosReproductivosEnTx(client, animalId), hoy);
  });
}

async function lockOperacion(client, organizacionId, clientOperationId) {
  await client.query('select pg_advisory_xact_lock(hashtext($1))', [
    `ganaderia_reproduccion_op:${organizacionId}:${clientOperationId}`,
  ]);
}

/**
 * Bloqueos 2 y 3 + invariantes del animal comunes a toda escritura:
 * 404 ANIMAL_NOT_FOUND, 409 ANIMAL_ANULADO. `operativo` = registro ordinario
 * (además exige EN_HATO).
 */
async function bloquearAnimal(client, organizacionId, animalId, { operativo }) {
  await client.query('select pg_advisory_xact_lock(hashtext($1))', [
    `ganaderia_reproduccion_animal:${organizacionId}:${animalId}`,
  ]);
  const animal = await fetchAnimalRepro(client, animalId, { forShare: true });
  if (!animal) throw semanticError('ANIMAL_NOT_FOUND', 404, 'Animal no encontrado.');
  if (animal.estado !== 'ACTIVO') {
    throw semanticError('ANIMAL_ANULADO', 409, 'El animal está anulado: no admite eventos reproductivos.');
  }
  if (operativo) {
    const cerrado = errorAnimalCerrado(animal.estado_operativo, 'no admite nuevos eventos reproductivos');
    if (cerrado) throw cerrado;
  }
  return animal;
}

/** Invariantes del evento contra el animal (registro y corrección). */
async function validarEventoContraAnimal(client, animal, evento) {
  if (animal.sexo !== 'HEMBRA') {
    throw semanticError('SEXO_INCOMPATIBLE', 409, 'Los eventos reproductivos se registran sobre una hembra.');
  }
  if (animal.fecha_nacimiento && evento.fechaEvento < animal.fecha_nacimiento) {
    throw semanticError('INVALID_FECHA', 400, `fechaEvento no puede ser anterior a la fecha de nacimiento (${animal.fecha_nacimiento}).`);
  }
  if (evento.toroAnimalId) {
    // RLS: un toro de otra organización es invisible (mismo 400 que inexistente).
    // FOR SHARE: una corrección de sexo concurrente del toro (FOR UPDATE en
    // corregirAnimal) espera al COMMIT y entonces ve esta referencia.
    const toro = await client.query(
      `select sexo, estado from agx.animales where animal_id = $1 for share`,
      [evento.toroAnimalId],
    );
    const row = toro.rows[0];
    if (!row || row.estado !== 'ACTIVO' || row.sexo !== 'MACHO' || evento.toroAnimalId === animal.animal_id) {
      throw semanticError('INVALID_TORO', 400, 'toroAnimalId debe ser un macho registrado (activo) de la organización.');
    }
  }
}

/**
 * Corrección de datos del animal (animalesRepository.corregirAnimal) frente a
 * su historial reproductivo -- ACTIVO y ANULADO: el historial auditado sigue
 * existiendo. Se llama dentro de la MISMA transacción, con el animal ya
 * bloqueado FOR UPDATE: un registro reproductivo concurrente (FOR SHARE del
 * animal y del toro) o espera y ve el sexo/fecha nuevos, o terminó antes y
 * su fila es visible aquí (READ COMMITTED: nueva instantánea por sentencia).
 * Solo agregados (count/min), nunca el historial completo. Tenant: RLS.
 *   - sujeto de eventos -> el sexo debe seguir siendo HEMBRA;
 *   - toro referenciado -> el sexo debe seguir siendo MACHO;
 *   - fechaNacimiento nueva <= evento reproductivo más antiguo.
 * Nunca modifica eventos para permitir el cambio.
 */
export async function assertCorreccionCompatibleConReproduccionEnTx(client, animalId, { sexo, fechaNacimiento, cambiaSexo, cambiaFechaNacimiento }) {
  if (!cambiaSexo && !cambiaFechaNacimiento) return;
  const result = await client.query(
    `select (select count(*)::int from agx.reproduccion_eventos where animal_id = $1) as como_hembra,
            (select to_char(min(fecha_evento), 'YYYY-MM-DD') from agx.reproduccion_eventos where animal_id = $1) as primer_evento,
            (select count(*)::int from agx.reproduccion_eventos where toro_animal_id = $1) as como_toro`,
    [animalId],
  );
  const { como_hembra: comoHembra, primer_evento: primerEvento, como_toro: comoToro } = result.rows[0];
  if (cambiaSexo && ((comoHembra > 0 && sexo !== 'HEMBRA') || (comoToro > 0 && sexo !== 'MACHO'))) {
    throw semanticError(
      'HISTORIAL_REPRODUCTIVO_INCOMPATIBLE',
      409,
      'El sexo del animal no puede modificarse porque ya tiene historial reproductivo.',
    );
  }
  if (cambiaFechaNacimiento && fechaNacimiento && primerEvento && fechaNacimiento > primerEvento) {
    throw semanticError(
      'HISTORIAL_REPRODUCTIVO_FECHA_INCOMPATIBLE',
      409,
      `La fecha de nacimiento no puede ser posterior al primer evento reproductivo del animal (${primerEvento}).`,
    );
  }
}

async function insertarEvento(client, organizacionId, animalId, evento, { clientOperationId, intentHash, actorCuentaId, corrigeEventoId = null }) {
  const campos = Object.keys(COLUMNAS);
  const columnas = ['organizacion_id', 'animal_id', ...campos.map((c) => COLUMNAS[c]), 'corrige_evento_id', 'registrado_por', 'client_operation_id', 'intent_hash'];
  const valores = [organizacionId, animalId, ...campos.map((c) => evento[c] ?? null), corrigeEventoId, actorCuentaId, clientOperationId, intentHash];
  try {
    const inserted = await client.query(
      `insert into agx.reproduccion_eventos (${columnas.join(', ')})
       values (${valores.map((_, i) => `$${i + 1}`).join(', ')})
       returning evento_id::text as evento_id`,
      valores,
    );
    return inserted.rows[0].evento_id;
  } catch (error) {
    if (error?.code === '23505' && error?.constraint === CLIENT_OPERATION_UNIQUE_CONSTRAINT) throw errorReused();
    if (error?.code === '23505' && error?.constraint === UNA_CORRECCION_UNIQUE_INDEX) {
      throw semanticError('EVENTO_YA_ANULADO', 409, 'El evento ya fue corregido.');
    }
    throw error;
  }
}

async function existentePorOperacion(client, organizacionId, clientOperationId) {
  const result = await client.query(
    `select evento_id::text as evento_id, animal_id::text as animal_id, intent_hash
       from agx.reproduccion_eventos
      where organizacion_id = $1 and client_operation_id = $2`,
    [organizacionId, clientOperationId],
  );
  return result.rows[0] ?? null;
}

async function respuesta(client, animal, eventoId, hoy, extra = {}) {
  const eventos = await listEventosReproductivosEnTx(client, animal.animal_id);
  const evento = eventos.find((e) => e.eventoId === String(eventoId));
  return { evento: publico(evento), estado: resumen(animal, eventos, hoy).estado, ...extra };
}

/**
 * POST evento reproductivo operativo idempotente por
 * (organizacion_id, client_operation_id):
 *   1. lock de operación; si existe: mismo animal + intent_hash -> 200
 *      {yaExistia:true}; distinto -> 409 CLIENT_OPERATION_ID_REUSED (el
 *      conflicto de transporte se evalúa antes que el de negocio);
 *   2. lock del animal + FOR SHARE: 404 / 409 ANIMAL_ANULADO /
 *      ANIMAL_YA_SALIDO / ANIMAL_YA_MUERTO / SEXO_INCOMPATIBLE; fecha >=
 *      nacimiento; toro válido;
 *   3. historial en orden: fechaEvento >= último evento activo (409
 *      FECHA_ANTERIOR_A_HISTORIAL; lo retroactivo se corrige por la vía
 *      administrativa) y regla de transición (409 EVENTO_NO_PERMITIDO_POR_ESTADO);
 *   4. INSERT + estado recalculado.
 */
export async function registrarEventoReproductivoIdempotente(organizacionId, animalId, value, { actorCuentaId, hoy }) {
  const { clientOperationId, ...evento } = value;
  const intentHash = computeReproduccionIntentHash(evento);
  return withOrganizacionTransaction(organizacionId, async (client) => {
    await lockOperacion(client, organizacionId, clientOperationId);
    const existing = await existentePorOperacion(client, organizacionId, clientOperationId);
    if (existing) {
      if (existing.animal_id !== String(animalId) || existing.intent_hash !== intentHash) throw errorReused();
      const animal = await fetchAnimalRepro(client, existing.animal_id);
      return respuesta(client, animal, existing.evento_id, hoy, { yaExistia: true });
    }

    const animal = await bloquearAnimal(client, organizacionId, animalId, { operativo: true });
    await validarEventoContraAnimal(client, animal, evento);

    const eventos = await listEventosReproductivosEnTx(client, animalId);
    const actual = derivarEstadoReproductivo({ sexo: animal.sexo, eventos, hoy });
    if (actual.ultimoEvento && evento.fechaEvento < actual.ultimoEvento.fechaEvento) {
      throw semanticError(
        'FECHA_ANTERIOR_A_HISTORIAL',
        409,
        `fechaEvento no puede ser anterior al último evento reproductivo (${actual.ultimoEvento.fechaEvento}). Un registro retroactivo se corrige por la vía administrativa.`,
      );
    }
    const regla = reglaRegistro(actual.estado, evento.tipoEvento);
    if (regla) throw semanticError(regla.code, 409, regla.message);

    const eventoId = await insertarEvento(client, organizacionId, animalId, evento, { clientOperationId, intentHash, actorCuentaId });
    return respuesta(client, animal, eventoId, hoy, { yaExistia: false });
  });
}

async function bloquearEvento(client, animalId, eventoId) {
  const result = await client.query(
    `select evento_id::text as evento_id, estado_registro
       from agx.reproduccion_eventos
      where evento_id = $1 and animal_id = $2
      for update`,
    [eventoId, animalId],
  );
  const row = result.rows[0];
  if (!row) throw semanticError('EVENTO_NOT_FOUND', 404, 'Evento reproductivo no encontrado.');
  if (row.estado_registro !== 'ACTIVO') throw semanticError('EVENTO_YA_ANULADO', 409, 'El evento ya está anulado.');
}

async function marcarAnulado(client, eventoId, { motivo, clientOperationId, actorCuentaId }) {
  try {
    await client.query(
      `update agx.reproduccion_eventos
          set estado_registro = 'ANULADO', anulado_por = $2, anulado_at = now(),
              motivo_anulacion = $3, anulacion_client_operation_id = $4
        where evento_id = $1`,
      [eventoId, actorCuentaId, motivo, clientOperationId],
    );
  } catch (error) {
    if (error?.code === '23505' && error?.constraint === ANULACION_CLIENT_OPERATION_UNIQUE_INDEX) throw errorReused();
    throw error;
  }
}

/**
 * POST anular (owner/admin) idempotente por
 * (organizacion_id, anulacion_client_operation_id): misma operación + mismo
 * evento + mismo motivo -> 200; si no -> 409. Marca ANULADO con
 * quién/cuándo/motivo (sin DELETE) y devuelve el estado recalculado desde los
 * eventos ACTIVO. Admite animales SALIDO/MUERTO (corrección de historia);
 * nunca un animal ANULADO.
 */
export async function anularEventoReproductivoIdempotente(organizacionId, animalId, eventoId, value, { actorCuentaId, hoy }) {
  return withOrganizacionTransaction(organizacionId, async (client) => {
    await lockOperacion(client, organizacionId, value.clientOperationId);
    const existingResult = await client.query(
      `select e.evento_id::text as evento_id, e.animal_id::text as animal_id, e.motivo_anulacion,
              exists (select 1 from agx.reproduccion_eventos c
                       where c.corrige_evento_id = e.evento_id and c.client_operation_id = e.anulacion_client_operation_id) as por_correccion
         from agx.reproduccion_eventos e
        where e.organizacion_id = $1 and e.anulacion_client_operation_id = $2`,
      [organizacionId, value.clientOperationId],
    );
    const existing = existingResult.rows[0];
    if (existing) {
      if (existing.por_correccion || existing.animal_id !== String(animalId)
        || existing.evento_id !== String(eventoId) || existing.motivo_anulacion !== value.motivo) {
        throw errorReused();
      }
      const animal = await fetchAnimalRepro(client, existing.animal_id);
      return respuesta(client, animal, existing.evento_id, hoy, { yaExistia: true });
    }

    const animal = await bloquearAnimal(client, organizacionId, animalId, { operativo: false });
    await bloquearEvento(client, animalId, eventoId);
    await marcarAnulado(client, eventoId, { ...value, actorCuentaId });
    return respuesta(client, animal, eventoId, hoy, { yaExistia: false });
  });
}

/**
 * POST corregir (owner/admin): en UNA transacción anula el evento erróneo y
 * crea el corregido enlazado (corrige_evento_id, mismo animal). Idempotente
 * por client_operation_id del evento nuevo (hash con accion CORRECCION +
 * evento corregido + motivo). Valida las invariantes del animal y del evento
 * (hembra, fecha, toro) pero NO la regla de transición ni el orden
 * cronológico: es un acto administrativo sobre la historia; el estado se
 * recalcula desde el historial resultante.
 */
export async function corregirEventoReproductivoIdempotente(organizacionId, animalId, eventoId, value, { actorCuentaId, hoy }) {
  const { clientOperationId, motivo, evento } = value;
  const intentHash = computeReproduccionIntentHash(evento, { accion: 'CORRECCION', corrigeEventoId: eventoId, motivo });
  return withOrganizacionTransaction(organizacionId, async (client) => {
    await lockOperacion(client, organizacionId, clientOperationId);
    const existing = await existentePorOperacion(client, organizacionId, clientOperationId);
    if (existing) {
      if (existing.animal_id !== String(animalId) || existing.intent_hash !== intentHash) throw errorReused();
      const animal = await fetchAnimalRepro(client, existing.animal_id);
      return respuesta(client, animal, existing.evento_id, hoy, {
        eventoCorregido: publico(await fetchEvento(client, eventoId)),
        yaExistia: true,
      });
    }

    const animal = await bloquearAnimal(client, organizacionId, animalId, { operativo: false });
    await validarEventoContraAnimal(client, animal, evento);
    await bloquearEvento(client, animalId, eventoId);
    await marcarAnulado(client, eventoId, { motivo, clientOperationId, actorCuentaId });
    const nuevoId = await insertarEvento(client, organizacionId, animalId, evento, {
      clientOperationId, intentHash, actorCuentaId, corrigeEventoId: eventoId,
    });
    return respuesta(client, animal, nuevoId, hoy, {
      eventoCorregido: publico(await fetchEvento(client, eventoId)),
      yaExistia: false,
    });
  });
}
