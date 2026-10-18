// SPRINT-3D11.3 (R1) -- uso de chapetas QR por la ORGANIZACIÓN
// (Postgres-AGX-Business, 0023). Toda operación corre en
// withOrganizacionTransaction: RLS solo deja ver chapetas con el
// organizacion_id de la sesión -- una chapeta de otra organización o del
// stock central es indistinguible de una inexistente (404).
//
// Las funciones *EnTx operan sobre una transacción ya abierta y las
// reutiliza el contexto Super Admin (qrInventarioRepository.js) tras fijar
// app.current_org_id a la organización de la chapeta. El token nunca se
// devuelve ni se escribe en eventos: se resuelve por su SHA-256.
import { withOrganizacionTransaction } from '../../db/agxBusinessPool.js';
import { createAnimalInTransaction, fetchAnimal } from './animalesRepository.js';
import { hashQrToken, isCodigoVisible, isQrToken } from './qrCodigos.js';

export const ESTADOS_NO_OPERATIVOS = Object.freeze(['REVOCADO', 'DANADO', 'REEMPLAZADO']);

export function semanticError(code, status, message, extra = {}) {
  return Object.assign(new Error(message || code), { status, code, ...extra });
}

export const CHAPETA_SELECT = `
  select c.qr_id::text as qr_id, c.lote_id::text as lote_id, c.tipo, c.codigo_visible, c.estado,
         c.organizacion_id, c.animal_id::text as animal_id,
         c.asignado_organizacion_at, c.asignado_animal_at, c.revocado_at, c.motivo,
         c.reemplazado_por::text as reemplazado_por
    from agx.qr_chapetas c`;

export function serializeChapeta(row) {
  return {
    qrId: row.qr_id,
    codigoVisible: row.codigo_visible,
    tipo: row.tipo,
    estado: row.estado,
    animalId: row.animal_id,
    asignadoOrganizacionAt: row.asignado_organizacion_at,
    asignadoAnimalAt: row.asignado_animal_at,
    revocadoAt: row.revocado_at,
    motivo: row.motivo,
    reemplazadoPor: row.reemplazado_por,
  };
}

function noOperativa(row) {
  return semanticError('QR_NO_OPERATIVO', 410, 'Esta chapeta ya no está en uso.', { estado: row.estado });
}

export async function lockChapetaPorCodigo(client, codigoVisible) {
  const result = await client.query(`${CHAPETA_SELECT} where c.codigo_visible = $1 for update`, [codigoVisible]);
  return result.rows[0] || null;
}

export async function lockChapetaPorId(client, qrId) {
  const result = await client.query(`${CHAPETA_SELECT} where c.qr_id = $1 for update`, [qrId]);
  return result.rows[0] || null;
}

async function fetchChapetaPorId(client, qrId) {
  const result = await client.query(`${CHAPETA_SELECT} where c.qr_id = $1`, [qrId]);
  return result.rows[0] || null;
}

async function fetchChapetaActivaDeAnimal(client, animalId, { lock = false } = {}) {
  const result = await client.query(
    `${CHAPETA_SELECT} where c.animal_id = $1 and c.estado = 'ASIGNADO_ANIMAL'${lock ? ' for update' : ''}`,
    [animalId],
  );
  return result.rows[0] || null;
}

export async function insertChapetaEvento(client, { qrId, organizacionId, tipoEvento, metadata = {}, actorCuentaId }) {
  await client.query(
    `insert into agx.qr_chapeta_eventos (qr_id, organizacion_id, tipo_evento, metadata_json, actor_cuenta_id)
     values ($1, $2, $3, $4::jsonb, $5)`,
    [qrId, organizacionId, tipoEvento, JSON.stringify(metadata), actorCuentaId],
  );
}

async function insertAnimalEvento(client, { organizacionId, animalId, tipoEvento, metadata, actorCuentaId }) {
  await client.query(
    `insert into agx.animal_eventos (organizacion_id, animal_id, tipo_evento, metadata_json, actor_cuenta_id)
     values ($1, $2, $3, $4::jsonb, $5)`,
    [organizacionId, animalId, tipoEvento, JSON.stringify(metadata), actorCuentaId],
  );
}

async function lockAnimalActivo(client, animalId) {
  const result = await client.query(
    'select a.animal_id::text as animal_id, a.estado from agx.animales a where a.animal_id = $1 for update',
    [animalId],
  );
  const animal = result.rows[0];
  if (!animal) throw semanticError('ANIMAL_NOT_FOUND', 404, 'Animal no encontrado.');
  if (animal.estado !== 'ACTIVO') throw semanticError('ANIMAL_ANULADO', 409, 'El animal está anulado.');
  return animal;
}

/** ASIGNADO_ORGANIZACION -> ASIGNADO_ANIMAL + eventos de chapeta y animal. */
async function asociarEnTx(client, { organizacionId, chapeta, animalId, actorCuentaId, tipoEventoChapeta = 'ASOCIADA_ANIMAL' }) {
  await client.query(
    `update agx.qr_chapetas
        set estado = 'ASIGNADO_ANIMAL', animal_id = $2, asignado_animal_at = now(), updated_at = now()
      where qr_id = $1`,
    [chapeta.qr_id, animalId],
  );
  await insertChapetaEvento(client, {
    qrId: chapeta.qr_id,
    organizacionId,
    tipoEvento: tipoEventoChapeta,
    metadata: { animalId: String(animalId) },
    actorCuentaId,
  });
  if (tipoEventoChapeta === 'ASOCIADA_ANIMAL') {
    await insertAnimalEvento(client, {
      organizacionId,
      animalId,
      tipoEvento: 'QR_ASOCIADO',
      metadata: { qrId: chapeta.qr_id, codigoVisible: chapeta.codigo_visible },
      actorCuentaId,
    });
  }
}

/**
 * Baja de una chapeta (REVOCADO o DANADO). Si estaba asociada a un animal
 * se registra también QR_REVOCADO en el animal.
 */
export async function bajaEnTx(client, { organizacionId, chapeta, causa, motivo, actorCuentaId }) {
  if (!['REVOCADO', 'DANADO'].includes(causa)) throw new Error('QR_BAJA_CAUSA_INVALIDA');
  await client.query(
    `update agx.qr_chapetas
        set estado = $2, revocado_at = now(), revocado_por = $3, motivo = $4, updated_at = now()
      where qr_id = $1`,
    [chapeta.qr_id, causa, actorCuentaId, motivo],
  );
  await insertChapetaEvento(client, {
    qrId: chapeta.qr_id,
    organizacionId,
    tipoEvento: causa === 'DANADO' ? 'DANADA' : 'REVOCADA',
    metadata: { motivo, estadoAnterior: chapeta.estado },
    actorCuentaId,
  });
  if (chapeta.estado === 'ASIGNADO_ANIMAL') {
    await insertAnimalEvento(client, {
      organizacionId,
      animalId: chapeta.animal_id,
      tipoEvento: 'QR_REVOCADO',
      metadata: { qrId: chapeta.qr_id, codigoVisible: chapeta.codigo_visible, causa, motivo },
      actorCuentaId,
    });
  }
  return fetchChapetaPorId(client, chapeta.qr_id);
}

/**
 * Reemplazo: la chapeta activa del animal pasa a REEMPLAZADO apuntando a
 * la nueva, que debe estar ASIGNADO_ORGANIZACION en la misma organización.
 * Idempotente: si la nueva ya es la activa del animal y reemplazó a otra,
 * devuelve yaExistia sin escribir.
 */
export async function reemplazarEnTx(client, { organizacionId, animalId, codigoNuevo, motivo, actorCuentaId }) {
  await lockAnimalActivo(client, animalId);
  const nueva = await lockChapetaPorCodigo(client, codigoNuevo);
  if (!nueva) throw semanticError('QR_NOT_FOUND', 404, 'La chapeta nueva no existe en tu organización.');

  if (nueva.estado === 'ASIGNADO_ANIMAL' && nueva.animal_id === String(animalId)) {
    const previa = await client.query(
      `select 1 from agx.qr_chapetas where reemplazado_por = $1 and animal_id = $2`,
      [nueva.qr_id, animalId],
    );
    if (previa.rowCount > 0) return { chapeta: serializeChapeta(nueva), yaExistia: true };
    throw semanticError('QR_YA_ASOCIADO', 409, 'Esa chapeta ya es la chapeta actual del animal.');
  }
  if (ESTADOS_NO_OPERATIVOS.includes(nueva.estado)) throw noOperativa(nueva);
  if (nueva.estado !== 'ASIGNADO_ORGANIZACION') {
    throw semanticError('QR_YA_ASOCIADO', 409, 'La chapeta nueva ya está asociada a otro animal.');
  }

  const anterior = await fetchChapetaActivaDeAnimal(client, animalId, { lock: true });
  if (!anterior) throw semanticError('QR_NO_ACTIVO', 409, 'El animal no tiene una chapeta activa para reemplazar.');

  await client.query(
    `update agx.qr_chapetas
        set estado = 'REEMPLAZADO', reemplazado_por = $2, revocado_at = now(), revocado_por = $3,
            motivo = $4, updated_at = now()
      where qr_id = $1`,
    [anterior.qr_id, nueva.qr_id, actorCuentaId, motivo],
  );
  await insertChapetaEvento(client, {
    qrId: anterior.qr_id,
    organizacionId,
    tipoEvento: 'REEMPLAZADA',
    metadata: { reemplazadoPor: nueva.qr_id, motivo },
    actorCuentaId,
  });
  await asociarEnTx(client, {
    organizacionId,
    chapeta: nueva,
    animalId,
    actorCuentaId,
    tipoEventoChapeta: 'ASOCIADA_POR_REEMPLAZO',
  });
  await insertAnimalEvento(client, {
    organizacionId,
    animalId,
    tipoEvento: 'QR_REEMPLAZADO',
    metadata: {
      qrId: nueva.qr_id,
      codigoVisible: nueva.codigo_visible,
      anteriorQrId: anterior.qr_id,
      anteriorCodigoVisible: anterior.codigo_visible,
      motivo,
    },
    actorCuentaId,
  });
  return { chapeta: serializeChapeta(await fetchChapetaPorId(client, nueva.qr_id)), yaExistia: false };
}

// ---------------------------------------------------------------------
// Resolución (escaneo / digitación)
// ---------------------------------------------------------------------

/**
 * Token (QR) o código visible (digitado) -> resultado:
 *   null                                  -> 404 (inexistente, otra organización, stock central)
 *   { resultado: 'DISPONIBLE', chapeta }  -> abrir registro de animal
 *   { resultado: 'ANIMAL', animalId, chapeta } -> abrir ficha
 *   { resultado: 'NO_OPERATIVA', chapeta } -> estado controlado (revocada/dañada/reemplazada)
 * Formato inválido -> null sin consultar la base.
 */
export async function resolverChapeta(organizacionId, { token, codigoVisible }) {
  let where;
  let param;
  if (token !== undefined) {
    if (!isQrToken(token)) return null;
    where = 'c.token_hash = $1';
    param = hashQrToken(token);
  } else {
    if (!isCodigoVisible(codigoVisible)) return null;
    where = 'c.codigo_visible = $1';
    param = codigoVisible;
  }
  return withOrganizacionTransaction(organizacionId, async (client) => {
    const result = await client.query(`${CHAPETA_SELECT} where ${where}`, [param]);
    const row = result.rows[0];
    if (!row) return null;
    const chapeta = serializeChapeta(row);
    if (row.estado === 'ASIGNADO_ORGANIZACION') return { resultado: 'DISPONIBLE', chapeta };
    if (row.estado === 'ASIGNADO_ANIMAL') {
      const animal = await fetchAnimal(client, row.animal_id);
      // Defensivo: anularAnimal revoca la chapeta en la misma transacción.
      if (animal?.estado === 'ACTIVO') return { resultado: 'ANIMAL', animalId: animal.animalId, chapeta };
    }
    return { resultado: 'NO_OPERATIVA', chapeta };
  });
}

export async function listChapetasOrganizacion(organizacionId, { estado, limit, offset }) {
  return withOrganizacionTransaction(organizacionId, async (client) => {
    const params = [];
    let where = '';
    if (estado) {
      params.push(estado);
      where = `where c.estado = $${params.length}`;
    }
    const total = await client.query(`select count(*)::int as n from agx.qr_chapetas c ${where}`, params);
    params.push(limit, offset);
    const result = await client.query(
      `${CHAPETA_SELECT} ${where} order by c.codigo_visible limit $${params.length - 1} offset $${params.length}`,
      params,
    );
    return { chapetas: result.rows.map(serializeChapeta), total: total.rows[0].n };
  });
}

// ---------------------------------------------------------------------
// Registro de animal con chapeta (atómico)
// ---------------------------------------------------------------------

/**
 * POST /api/ganaderia/qr/chapetas/:codigo/registrar-animal -- en UNA
 * transacción: bloquea la chapeta, crea el animal (mismo núcleo
 * idempotente que POST /animales) y la asocia. Si cualquier paso falla no
 * queda ni animal ni chapeta asociada. Reintento con el mismo
 * clientOperationId -> mismo animal (yaExistia: true).
 */
export async function registrarAnimalConChapeta(organizacionId, codigoVisible, value, { actorCuentaId }) {
  return withOrganizacionTransaction(organizacionId, async (client) => {
    const chapeta = await lockChapetaPorCodigo(client, codigoVisible);
    if (!chapeta) throw semanticError('QR_NOT_FOUND', 404, 'Chapeta no encontrada en tu organización.');

    if (chapeta.estado === 'ASIGNADO_ANIMAL') {
      const replay = await client.query(
        `select animal_id::text as animal_id from agx.animales
          where organizacion_id = $1 and client_operation_id = $2 and animal_id = $3`,
        [organizacionId, value.clientOperationId, chapeta.animal_id],
      );
      if (replay.rows[0]) {
        return { animal: await fetchAnimal(client, chapeta.animal_id), chapeta: serializeChapeta(chapeta), yaExistia: true };
      }
      throw semanticError('QR_YA_ASOCIADO', 409, 'Esta chapeta ya está asociada a otro animal.', { animalId: chapeta.animal_id });
    }
    if (ESTADOS_NO_OPERATIVOS.includes(chapeta.estado)) throw noOperativa(chapeta);

    const { animal, yaExistia } = await createAnimalInTransaction(client, organizacionId, value, { actorCuentaId });
    if (yaExistia) {
      // La operación ya creó un animal por otra vía sin esta chapeta.
      throw semanticError(
        'CLIENT_OPERATION_ID_REUSED',
        409,
        'Esta operación ya registró un animal. Revisa tu lista de animales.',
      );
    }
    await asociarEnTx(client, { organizacionId, chapeta, animalId: animal.animalId, actorCuentaId });
    return {
      animal,
      chapeta: serializeChapeta(await fetchChapetaPorId(client, chapeta.qr_id)),
      yaExistia: false,
    };
  });
}

// ---------------------------------------------------------------------
// Chapeta de un animal existente (ficha)
// ---------------------------------------------------------------------

/** Chapeta activa + historial del animal. null si el animal no existe en la organización. */
export async function getChapetasDeAnimal(organizacionId, animalId) {
  return withOrganizacionTransaction(organizacionId, async (client) => {
    const animal = await client.query('select 1 from agx.animales where animal_id = $1', [animalId]);
    if (animal.rowCount === 0) return null;
    const result = await client.query(
      `${CHAPETA_SELECT} where c.animal_id = $1 order by c.asignado_animal_at desc, c.qr_id desc`,
      [animalId],
    );
    const activaRow = result.rows.find((row) => row.estado === 'ASIGNADO_ANIMAL') || null;
    return {
      activa: activaRow ? serializeChapeta(activaRow) : null,
      historial: result.rows.map(serializeChapeta),
    };
  });
}

/** Asocia a un animal ACTIVO sin chapeta una chapeta disponible de la organización. */
export async function asociarChapetaAAnimal(organizacionId, animalId, codigoVisible, { actorCuentaId }) {
  return withOrganizacionTransaction(organizacionId, async (client) => {
    await lockAnimalActivo(client, animalId);
    const chapeta = await lockChapetaPorCodigo(client, codigoVisible);
    if (!chapeta) throw semanticError('QR_NOT_FOUND', 404, 'Chapeta no encontrada en tu organización.');
    if (chapeta.estado === 'ASIGNADO_ANIMAL') {
      if (chapeta.animal_id === String(animalId)) return { chapeta: serializeChapeta(chapeta), yaExistia: true };
      throw semanticError('QR_YA_ASOCIADO', 409, 'Esta chapeta ya está asociada a otro animal.');
    }
    if (ESTADOS_NO_OPERATIVOS.includes(chapeta.estado)) throw noOperativa(chapeta);

    const actual = await fetchChapetaActivaDeAnimal(client, animalId);
    if (actual) throw semanticError('ANIMAL_YA_TIENE_QR', 409, 'El animal ya tiene una chapeta activa: usa Reemplazar.');

    await asociarEnTx(client, { organizacionId, chapeta, animalId, actorCuentaId });
    return { chapeta: serializeChapeta(await fetchChapetaPorId(client, chapeta.qr_id)), yaExistia: false };
  });
}

export async function reemplazarChapetaDeAnimal(organizacionId, animalId, { codigoNuevo, motivo, actorCuentaId }) {
  return withOrganizacionTransaction(organizacionId, (client) =>
    reemplazarEnTx(client, { organizacionId, animalId, codigoNuevo, motivo, actorCuentaId }));
}

/** Baja (REVOCADO/DANADO) de la chapeta activa del animal. */
export async function bajaChapetaDeAnimal(organizacionId, animalId, { causa, motivo, actorCuentaId }) {
  return withOrganizacionTransaction(organizacionId, async (client) => {
    const animal = await client.query('select 1 from agx.animales where animal_id = $1 for update', [animalId]);
    if (animal.rowCount === 0) throw semanticError('ANIMAL_NOT_FOUND', 404, 'Animal no encontrado.');
    const activa = await fetchChapetaActivaDeAnimal(client, animalId, { lock: true });
    if (!activa) throw semanticError('QR_NO_ACTIVO', 409, 'El animal no tiene una chapeta activa.');
    const row = await bajaEnTx(client, { organizacionId, chapeta: activa, causa, motivo, actorCuentaId });
    return { chapeta: serializeChapeta(row) };
  });
}
