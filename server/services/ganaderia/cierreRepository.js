// FASE 2A -- cierre operativo del animal (SALIDA / MUERTE) contra
// Postgres-AGX-Business (0025). Mismo contrato que pesajesRepository.js:
// `organizacionId` llega YA autorizado (req.ganaderiaAuth, nunca del
// cliente) y todo corre en withOrganizacionTransaction; RLS+FORCE aísla y un
// animal de otra organización es indistinguible de uno inexistente (404).
//
// Fuente canónica: estado actual en agx.animales (estado_operativo +
// cierre_*) y auditoría en agx.animal_eventos (SALIDO / MUERTO). Ninguna
// otra tabla de eventos repite el hecho. La chapeta QR activa se revoca en la
// MISMA transacción (revocarChapetaActivaEnTx, igual que la anulación).
// Nunca toca el Postgres legacy (server/db.js).
import { withOrganizacionTransaction } from '../../db/agxBusinessPool.js';
import { fetchAnimal, revocarChapetaActivaEnTx } from './animalesRepository.js';
import { TIPOS_CIERRE, errorAnimalCerrado } from './cierreValidation.js';

const CLIENT_OPERATION_UNIQUE_CONSTRAINT = 'animales_org_cierre_client_operation_key';

const QR_REVOCACION = Object.freeze({
  SALIDA: { causa: 'ANIMAL_SALIDO', motivo: 'Animal salió del hato' },
  MUERTE: { causa: 'ANIMAL_MUERTO', motivo: 'Animal muerto' },
});

function semanticError(code, status, message) {
  return Object.assign(new Error(message || code), { status, code });
}

const TIPO_POR_ESTADO = Object.freeze({ SALIDO: 'SALIDA', MUERTO: 'MUERTE' });

function mismaIntencion(row, animalId, value) {
  return (
    row.animal_id === String(animalId)
    && TIPO_POR_ESTADO[row.estado_operativo] === value.tipo
    && row.cierre_fecha === value.fecha
    && row.cierre_causa === value.causa
    && (row.cierre_observaciones ?? null) === (value.observaciones ?? null)
  );
}

// Evento SALIDO/MUERTO en el formato público (sin actor ni metadata cruda).
function serializeEvento(row) {
  const meta = row.metadata_json ?? {};
  return {
    eventoId: row.evento_id,
    tipo: row.tipo_evento,
    fecha: meta.fecha ?? null,
    causa: meta.motivo ?? meta.causa ?? null,
    observaciones: meta.observaciones ?? null,
    registradoEn: row.ocurrido_en,
  };
}

async function fetchEventoCierre(client, animalId) {
  const result = await client.query(
    `select evento_id::text as evento_id, tipo_evento, metadata_json,
            to_char(ocurrido_en at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as ocurrido_en
       from agx.animal_eventos
      where animal_id = $1 and tipo_evento in ('SALIDO', 'MUERTO')`,
    [animalId],
  );
  return result.rows[0] ? serializeEvento(result.rows[0]) : null;
}

/**
 * Límite inferior de la fecha efectiva: nacimiento, ingreso y el último
 * pesaje (un animal pesado en una fecha seguía en el hato y vivo ese día).
 * La fecha de registro técnico (created_at) NO es límite: se admite
 * registrar a posteriori un cierre ocurrido antes de digitalizar el animal.
 */
function validarFechaMinima(row, value, campoFecha) {
  const limites = [
    ['la fecha de nacimiento', row.fecha_nacimiento],
    ['la fecha de ingreso', row.fecha_ingreso],
    ['el último pesaje registrado', row.ultimo_pesaje_fecha],
  ];
  for (const [descripcion, limite] of limites) {
    if (limite && value.fecha < limite) {
      throw semanticError('INVALID_FECHA', 400, `${campoFecha} no puede ser anterior a ${descripcion} (${limite}).`);
    }
  }
}

/**
 * POST salida/muerte idempotente por (organizacion_id, cierre_client_operation_id):
 *   1. advisory lock transaccional por org + operación (serializa reintentos
 *      concurrentes de la MISMA operación);
 *   2. si la operación ya existe: misma intención (animal, tipo, fecha,
 *      causa, observaciones) -> {yaExistia: true} sin escribir; distinta ->
 *      409 CLIENT_OPERATION_ID_REUSED;
 *   3. si no existe: animal bloqueado FOR UPDATE (serializa cierres
 *      concurrentes con distinta operación, anulaciones y pesajes FOR SHARE);
 *      404 / 409 ANIMAL_ANULADO / ANIMAL_YA_SALIDO / ANIMAL_YA_MUERTO;
 *      fecha >= nacimiento, ingreso y último pesaje;
 *   4. UPDATE del estado + evento + revocación de la chapeta activa.
 * El conflicto de transporte (2) se evalúa antes que el de negocio (3).
 */
export async function registrarCierreIdempotente(organizacionId, animalId, value, { actorCuentaId }) {
  const config = TIPOS_CIERRE[value.tipo];
  if (!config) throw new Error(`Tipo de cierre desconocido: ${value.tipo}`);
  return withOrganizacionTransaction(organizacionId, async (client) => {
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [
      `ganaderia_animal_cierre:${organizacionId}:${value.clientOperationId}`,
    ]);

    const existingResult = await client.query(
      `select animal_id::text as animal_id, estado_operativo,
              to_char(cierre_fecha, 'YYYY-MM-DD') as cierre_fecha, cierre_causa, cierre_observaciones
         from agx.animales
        where organizacion_id = $1 and cierre_client_operation_id = $2`,
      [organizacionId, value.clientOperationId],
    );
    const existing = existingResult.rows[0];
    if (existing) {
      if (!mismaIntencion(existing, animalId, value)) {
        throw semanticError(
          'CLIENT_OPERATION_ID_REUSED',
          409,
          'Esta operación ya registró un cierre con datos distintos. Revisa la ficha del animal.',
        );
      }
      return {
        animal: await fetchAnimal(client, existing.animal_id),
        evento: await fetchEventoCierre(client, existing.animal_id),
        yaExistia: true,
      };
    }

    const locked = await client.query(
      `select a.animal_id::text as animal_id, a.estado, a.estado_operativo,
              to_char(a.fecha_nacimiento, 'YYYY-MM-DD') as fecha_nacimiento,
              to_char(a.fecha_ingreso, 'YYYY-MM-DD') as fecha_ingreso
         from agx.animales a
        where a.animal_id = $1
        for update`,
      [animalId],
    );
    const row = locked.rows[0];
    if (!row) throw semanticError('ANIMAL_NOT_FOUND', 404, 'Animal no encontrado.');
    if (row.estado === 'ANULADO') {
      throw semanticError('ANIMAL_ANULADO', 409, 'El animal está anulado: no admite salida ni muerte.');
    }
    const cerrado = errorAnimalCerrado(row.estado_operativo, 'no admite otra salida ni muerte');
    if (cerrado) throw cerrado;

    // Con el animal bloqueado, ningún pesaje nuevo puede entrar (FOR SHARE espera).
    const ultimo = await client.query(
      `select to_char(max(fecha), 'YYYY-MM-DD') as fecha from agx.animal_pesajes where animal_id = $1`,
      [animalId],
    );
    validarFechaMinima({ ...row, ultimo_pesaje_fecha: ultimo.rows[0]?.fecha ?? null }, value, config.campoFecha);

    try {
      await client.query(
        `update agx.animales
            set estado_operativo = $2, cierre_fecha = $3, cierre_causa = $4, cierre_observaciones = $5,
                cierre_at = now(), cierre_por = $6, cierre_client_operation_id = $7, updated_at = now()
          where animal_id = $1`,
        [animalId, config.estadoOperativo, value.fecha, value.causa, value.observaciones, actorCuentaId, value.clientOperationId],
      );
    } catch (error) {
      if (error?.code === '23505' && error?.constraint === CLIENT_OPERATION_UNIQUE_CONSTRAINT) {
        throw semanticError('CLIENT_OPERATION_ID_REUSED', 409, 'Esta operación ya fue registrada.');
      }
      throw error;
    }

    // Metadata mínima, sin payload crudo ni client_operation_id.
    const metadata = { fecha: value.fecha, [config.claveMetadata]: value.causa };
    if (value.observaciones) metadata.observaciones = value.observaciones;
    await client.query(
      `insert into agx.animal_eventos (organizacion_id, animal_id, tipo_evento, metadata_json, actor_cuenta_id)
       values ($1, $2, $3, $4::jsonb, $5)`,
      [organizacionId, animalId, config.tipoEvento, JSON.stringify(metadata), actorCuentaId],
    );

    // La chapeta deja de identificar a un animal en el hato: REVOCADO (terminal).
    await revocarChapetaActivaEnTx(client, { organizacionId, animalId, actorCuentaId, ...QR_REVOCACION[value.tipo] });

    return {
      animal: await fetchAnimal(client, animalId),
      evento: await fetchEventoCierre(client, animalId),
      yaExistia: false,
    };
  });
}
