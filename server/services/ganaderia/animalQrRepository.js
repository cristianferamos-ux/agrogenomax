// SPRINT-3D11.3 (R1) -- QR seguro del animal sobre agx.animal_identificadores
// (Postgres-AGX-Business, 0023). Toda operación corre en
// withOrganizacionTransaction: RLS FORCE garantiza que un QR o animal de
// otra organización es invisible (-> 404). Nunca toca el Postgres legacy
// (qr_codes de server/db.js). El token nunca se escribe en animal_eventos.
import { withOrganizacionTransaction } from '../../db/agxBusinessPool.js';
import { fetchAnimal } from './animalesRepository.js';
import { generateQrAgxToken, isQrAgxToken } from './animalQrToken.js';

// Ambos índices detectan una colisión de token (el orden en que Postgres
// los evalúa no está garantizado).
const TOKEN_COLLISION_CONSTRAINTS = new Set([
  'animal_identificadores_qr_agx_valor_key',
  'animal_identificadores_valor_activo_idx',
]);
const UN_ACTIVO_POR_ANIMAL = 'animal_identificadores_un_activo_por_animal_idx';
const CLIENT_OPERATION_UNIQUE = 'animal_identificadores_org_client_operation_key';
const MAX_TOKEN_ATTEMPTS = 3;

function semanticError(code, status, message) {
  return Object.assign(new Error(message || code), { status, code });
}

const IDENTIFICADOR_SELECT = `
  select i.identificador_id::text as identificador_id,
         i.animal_id::text as animal_id,
         i.tipo, i.valor, i.estado,
         i.asignado_at, i.revocado_at, i.motivo,
         i.reemplaza_a::text as reemplaza_a,
         i.client_operation_id::text as client_operation_id
    from agx.animal_identificadores i`;

export function qrPathForToken(token) {
  return `/qr/${token}`;
}

// Identificador activo: incluye el token (solo para la organización dueña,
// para imprimir/mostrar). Historial: nunca expone el valor.
export function serializeIdentificador(row, { includeValor }) {
  const base = {
    identificadorId: row.identificador_id,
    animalId: row.animal_id,
    tipo: row.tipo,
    estado: row.estado,
    asignadoAt: row.asignado_at,
    revocadoAt: row.revocado_at,
    motivo: row.motivo,
    reemplazaA: row.reemplaza_a,
  };
  if (!includeValor) return base;
  return {
    ...base,
    valor: row.valor,
    qrPath: row.tipo === 'QR_AGX' ? qrPathForToken(row.valor) : null,
  };
}

async function lockAnimal(client, animalId) {
  const result = await client.query(
    `select a.animal_id::text as animal_id, a.estado
       from agx.animales a
      where a.animal_id = $1
      for update`,
    [animalId],
  );
  return result.rows[0] || null;
}

async function fetchActivo(client, animalId) {
  const result = await client.query(
    `${IDENTIFICADOR_SELECT} where i.animal_id = $1 and i.estado = 'ACTIVO'`,
    [animalId],
  );
  return result.rows[0] || null;
}

async function insertEvento(client, { organizacionId, animalId, tipoEvento, metadata, actorCuentaId }) {
  await client.query(
    `insert into agx.animal_eventos (organizacion_id, animal_id, tipo_evento, metadata_json, actor_cuenta_id)
     values ($1, $2, $3, $4::jsonb, $5)`,
    [organizacionId, animalId, tipoEvento, JSON.stringify(metadata), actorCuentaId],
  );
}

// INSERT con token nuevo; una colisión del índice global (probabilidad
// despreciable con 192 bits) se reintenta bajo SAVEPOINT.
async function insertQrAgx(client, { organizacionId, animalId, actorCuentaId, reemplazaA = null, clientOperationId = null, tokenGenerator }) {
  for (let attempt = 1; attempt <= MAX_TOKEN_ATTEMPTS; attempt += 1) {
    const token = tokenGenerator();
    await client.query('savepoint agx_qr_insert');
    try {
      const result = await client.query(
        `insert into agx.animal_identificadores
           (organizacion_id, animal_id, tipo, valor, estado, asignado_por, reemplaza_a, client_operation_id)
         values ($1, $2, 'QR_AGX', $3, 'ACTIVO', $4, $5, $6)
         returning identificador_id::text as identificador_id`,
        [organizacionId, animalId, token, actorCuentaId, reemplazaA, clientOperationId],
      );
      await client.query('release savepoint agx_qr_insert');
      return result.rows[0].identificador_id;
    } catch (error) {
      await client.query('rollback to savepoint agx_qr_insert');
      if (error?.code === '23505' && TOKEN_COLLISION_CONSTRAINTS.has(error.constraint) && attempt < MAX_TOKEN_ATTEMPTS) {
        continue;
      }
      throw translateUniqueViolation(error);
    }
  }
  throw new Error('QR_TOKEN_GENERATION_EXHAUSTED');
}

function translateUniqueViolation(error) {
  if (error?.code === '23505' && error.constraint === CLIENT_OPERATION_UNIQUE) {
    return semanticError('CLIENT_OPERATION_ID_REUSED', 409, 'La operación ya fue usada para otro animal.');
  }
  if (error?.code === '23505' && error.constraint === UN_ACTIVO_POR_ANIMAL) {
    // Imposible bajo el FOR UPDATE del animal -- nunca se oculta como éxito.
    return new Error('QR_ACTIVO_CONFLICT_UNDER_LOCK');
  }
  return error;
}

async function fetchIdentificadorById(client, identificadorId) {
  const result = await client.query(`${IDENTIFICADOR_SELECT} where i.identificador_id = $1`, [identificadorId]);
  return result.rows[0] || null;
}

/**
 * GET /api/ganaderia/animales/:id/qr -- QR activo (con token) + historial
 * (sin token). null si el animal no existe en la organización.
 */
export async function getAnimalQr(organizacionId, animalId) {
  return withOrganizacionTransaction(organizacionId, async (client) => {
    const animal = await client.query('select 1 from agx.animales where animal_id = $1', [animalId]);
    if (animal.rowCount === 0) return null;
    const result = await client.query(
      `${IDENTIFICADOR_SELECT} where i.animal_id = $1 order by i.asignado_at desc, i.identificador_id desc`,
      [animalId],
    );
    const activoRow = result.rows.find((row) => row.estado === 'ACTIVO') || null;
    return {
      activo: activoRow ? serializeIdentificador(activoRow, { includeValor: true }) : null,
      historial: result.rows.map((row) => serializeIdentificador(row, { includeValor: false })),
    };
  });
}

/**
 * POST /api/ganaderia/animales/:id/qr -- idempotente por estado: si el
 * animal ya tiene QR ACTIVO se devuelve ese (yaExistia: true, sin
 * escritura). Animal ANULADO -> 409.
 */
export async function asignarQr(organizacionId, animalId, { actorCuentaId, tokenGenerator = generateQrAgxToken }) {
  return withOrganizacionTransaction(organizacionId, async (client) => {
    const animal = await lockAnimal(client, animalId);
    if (!animal) throw semanticError('ANIMAL_NOT_FOUND', 404, 'Animal no encontrado.');

    const existente = await fetchActivo(client, animalId);
    if (existente) {
      return { identificador: serializeIdentificador(existente, { includeValor: true }), yaExistia: true };
    }
    if (animal.estado !== 'ACTIVO') {
      throw semanticError('ANIMAL_ANULADO', 409, 'No se puede asignar QR a un animal anulado.');
    }

    const identificadorId = await insertQrAgx(client, { organizacionId, animalId, actorCuentaId, tokenGenerator });
    await insertEvento(client, {
      organizacionId,
      animalId,
      tipoEvento: 'QR_ASIGNADO',
      metadata: { identificadorId, tipo: 'QR_AGX' },
      actorCuentaId,
    });
    const row = await fetchIdentificadorById(client, identificadorId);
    return { identificador: serializeIdentificador(row, { includeValor: true }), yaExistia: false };
  });
}

async function marcarNoActivo(client, { identificadorId, estado, motivo, actorCuentaId }) {
  await client.query(
    `update agx.animal_identificadores
        set estado = $2, revocado_at = now(), revocado_por = $3, motivo = $4, updated_at = now()
      where identificador_id = $1 and estado = 'ACTIVO'`,
    [identificadorId, estado, actorCuentaId, motivo],
  );
}

/**
 * POST /api/ganaderia/animales/:id/qr/revocar -- el QR activo pasa a
 * REVOCADO (deja de resolver). Reintento tras éxito: si no hay activo y el
 * último identificador está REVOCADO -> yaRevocado: true. Sin QR -> 409.
 */
export async function revocarQr(organizacionId, animalId, { motivo, actorCuentaId }) {
  return withOrganizacionTransaction(organizacionId, async (client) => {
    const animal = await lockAnimal(client, animalId);
    if (!animal) throw semanticError('ANIMAL_NOT_FOUND', 404, 'Animal no encontrado.');

    const activo = await fetchActivo(client, animalId);
    if (!activo) {
      const ultimo = await client.query(
        `${IDENTIFICADOR_SELECT} where i.animal_id = $1 order by i.asignado_at desc, i.identificador_id desc limit 1`,
        [animalId],
      );
      if (ultimo.rows[0]?.estado === 'REVOCADO') {
        return { identificador: serializeIdentificador(ultimo.rows[0], { includeValor: false }), yaRevocado: true };
      }
      throw semanticError('QR_NO_ACTIVO', 409, 'El animal no tiene un QR activo.');
    }

    await marcarNoActivo(client, { identificadorId: activo.identificador_id, estado: 'REVOCADO', motivo, actorCuentaId });
    await insertEvento(client, {
      organizacionId,
      animalId,
      tipoEvento: 'QR_REVOCADO',
      metadata: { identificadorId: activo.identificador_id, motivo },
      actorCuentaId,
    });
    const row = await fetchIdentificadorById(client, activo.identificador_id);
    return { identificador: serializeIdentificador(row, { includeValor: false }), yaRevocado: false };
  });
}

/**
 * POST /api/ganaderia/animales/:id/qr/reemplazar -- en una transacción:
 * activo -> REEMPLAZADO, nuevo QR_AGX ACTIVO con reemplaza_a = anterior y
 * token distinto, evento QR_REEMPLAZADO. Idempotente por clientOperationId
 * (reintento -> mismo QR nuevo, yaExistia: true).
 */
export async function reemplazarQr(
  organizacionId,
  animalId,
  { motivo, clientOperationId, actorCuentaId, tokenGenerator = generateQrAgxToken },
) {
  return withOrganizacionTransaction(organizacionId, async (client) => {
    const animal = await lockAnimal(client, animalId);
    if (!animal) throw semanticError('ANIMAL_NOT_FOUND', 404, 'Animal no encontrado.');

    const replay = await client.query(
      `${IDENTIFICADOR_SELECT} where i.organizacion_id = $1 and i.client_operation_id = $2`,
      [organizacionId, clientOperationId],
    );
    if (replay.rows[0]) {
      if (replay.rows[0].animal_id !== String(animalId)) {
        throw semanticError('CLIENT_OPERATION_ID_REUSED', 409, 'La operación ya fue usada para otro animal.');
      }
      const actual = await fetchActivo(client, animalId);
      const includeValor = actual?.identificador_id === replay.rows[0].identificador_id;
      return { identificador: serializeIdentificador(replay.rows[0], { includeValor }), yaExistia: true };
    }

    if (animal.estado !== 'ACTIVO') {
      throw semanticError('ANIMAL_ANULADO', 409, 'No se puede reemplazar el QR de un animal anulado.');
    }
    const anterior = await fetchActivo(client, animalId);
    if (!anterior) throw semanticError('QR_NO_ACTIVO', 409, 'El animal no tiene un QR activo para reemplazar.');

    await marcarNoActivo(client, { identificadorId: anterior.identificador_id, estado: 'REEMPLAZADO', motivo, actorCuentaId });
    const identificadorId = await insertQrAgx(client, {
      organizacionId,
      animalId,
      actorCuentaId,
      reemplazaA: anterior.identificador_id,
      clientOperationId,
      tokenGenerator,
    });
    await insertEvento(client, {
      organizacionId,
      animalId,
      tipoEvento: 'QR_REEMPLAZADO',
      metadata: { identificadorId, anteriorId: anterior.identificador_id, motivo },
      actorCuentaId,
    });
    const row = await fetchIdentificadorById(client, identificadorId);
    return { identificador: serializeIdentificador(row, { includeValor: true }), yaExistia: false };
  });
}

/**
 * GET /api/ganaderia/qr/:token -- resuelve SOLO identificadores QR_AGX
 * ACTIVO de la organización de la sesión. Formato inválido -> null sin
 * consultar la base. Otra organización / revocado / reemplazado -> null.
 */
export async function resolverQr(organizacionId, token) {
  if (!isQrAgxToken(token)) return null;
  return withOrganizacionTransaction(organizacionId, async (client) => {
    const result = await client.query(
      `select i.animal_id::text as animal_id
         from agx.animal_identificadores i
        where i.tipo = 'QR_AGX' and i.valor = $1 and i.estado = 'ACTIVO'`,
      [token],
    );
    if (!result.rows[0]) return null;
    const animal = await fetchAnimal(client, result.rows[0].animal_id);
    return animal ? { animal } : null;
  });
}
