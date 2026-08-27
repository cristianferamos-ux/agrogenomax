// SPRINT-3D9.2 -- ARCHIVAR/RESTAURAR PREDIO Y POTRERO
//
// Reemplaza el hard DELETE (revocado en 0010) por un archivado
// reversible: ACTIVO <-> ARCHIVADO. Nunca borra historia -- fichas,
// recomendaciones, ciclos y eventos permanecen intactos y consultables.
// Cada transición (archivar/restaurar) queda en un log append-only
// propio (agx.predio_archivo_eventos / agx.potrero_archivo_eventos),
// independiente de las columnas current-state (que solo reflejan la
// ÚLTIMA transición) -- así no se pierde auditoría aunque se archive y
// restaure varias veces.
//
// Archivar un predio NUNCA modifica físicamente potrero.estado -- el
// estado operativo ARCHIVADO por herencia del predio es una precedencia
// de LECTURA (ver potreroEstadoOperativoRepository.js), nunca una
// escritura en cascada.
import { withOrganizacionTransaction } from '../../db/agxBusinessPool.js';

function semanticError(code, status, message) {
  return Object.assign(new Error(message || code), { status, code });
}

function assertPredioIdFormat(predioId) {
  if (!/^\d+$/.test(String(predioId))) {
    throw semanticError('INVALID_PREDIO_ID', 400, 'predioId inválido.');
  }
}

function assertPotreroIdFormat(potreroId) {
  if (!/^\d+$/.test(String(potreroId))) {
    throw semanticError('INVALID_POTRERO_ID', 400, 'potreroId inválido.');
  }
}

const PREDIO_ESTADO_SELECT = 'predio_id, estado, archivado_at, archivado_por, motivo_archivado';
const POTRERO_ESTADO_SELECT = 'potrero_id, predio_id, estado, archivado_at, archivado_por, motivo_archivado';

function serializePredioEstado(row) {
  return {
    predioId: String(row.predio_id),
    estado: row.estado,
    archivadoAt: row.archivado_at,
    archivadoPor: row.archivado_por === null || row.archivado_por === undefined ? null : String(row.archivado_por),
    motivoArchivado: row.motivo_archivado,
  };
}

function serializePotreroEstado(row) {
  return {
    potreroId: String(row.potrero_id),
    predioId: String(row.predio_id),
    estado: row.estado,
    archivadoAt: row.archivado_at,
    archivadoPor: row.archivado_por === null || row.archivado_por === undefined ? null : String(row.archivado_por),
    motivoArchivado: row.motivo_archivado,
  };
}

async function fetchPredioEstado(client, predioId) {
  const result = await client.query(`select ${PREDIO_ESTADO_SELECT} from agx.predios where predio_id = $1`, [predioId]);
  if (result.rows.length === 0) {
    throw semanticError('PREDIO_NOT_FOUND', 404, 'El predio no existe o no pertenece a tu organización.');
  }
  return result.rows[0];
}

async function fetchPotreroEstado(client, potreroId, predioId) {
  const result = await client.query(
    `select ${POTRERO_ESTADO_SELECT} from agx.potreros where potrero_id = $1 and predio_id = $2`,
    [potreroId, predioId],
  );
  if (result.rows.length === 0) {
    throw semanticError('POTRERO_NOT_FOUND', 404, 'El potrero no existe, no pertenece a este predio o no pertenece a tu organización.');
  }
  return result.rows[0];
}

async function existeCicloEnCursoEnPredio(client, predioId) {
  const result = await client.query(
    `select 1
       from agx.potrero_ciclos_pastoreo c
       join agx.potreros p on p.potrero_id = c.potrero_id
      where p.predio_id = $1 and c.estado = 'EN_CURSO'
      limit 1`,
    [predioId],
  );
  return result.rows.length > 0;
}

async function existeCicloEnCursoEnPotrero(client, potreroId) {
  const result = await client.query(
    `select 1 from agx.potrero_ciclos_pastoreo where potrero_id = $1 and estado = 'EN_CURSO' limit 1`,
    [potreroId],
  );
  return result.rows.length > 0;
}

/** Archivar predio -- motivo obligatorio. Idempotente si ya ARCHIVADO. */
export async function archivarPredio(organizacionId, predioId, { motivo, actorCuentaId, now } = {}) {
  assertPredioIdFormat(predioId);
  const motivoLimpio = typeof motivo === 'string' ? motivo.trim() : '';
  if (motivoLimpio === '') {
    throw semanticError('INVALID_MOTIVO_ARCHIVADO', 400, 'motivo es obligatorio para archivar un predio.');
  }

  return withOrganizacionTransaction(organizacionId, async (client) => {
    const predio = await fetchPredioEstado(client, predioId);
    if (predio.estado === 'ARCHIVADO') {
      return serializePredioEstado(predio); // idempotente -- no duplica evento
    }
    if (await existeCicloEnCursoEnPredio(client, predioId)) {
      throw semanticError('PREDIO_CON_CICLO_EN_CURSO', 409, 'No se puede archivar: al menos un potrero de este predio tiene un pastoreo en curso.');
    }

    const ocurridoEn = now ?? new Date();
    const actualizado = await client.query(
      `update agx.predios
          set estado = 'ARCHIVADO', archivado_at = $1, archivado_por = $2, motivo_archivado = $3
        where predio_id = $4
        returning ${PREDIO_ESTADO_SELECT}`,
      [ocurridoEn, actorCuentaId ?? null, motivoLimpio, predioId],
    );
    await client.query(
      `insert into agx.predio_archivo_eventos (organizacion_id, predio_id, tipo_evento, motivo, actor_cuenta_id, ocurrido_en)
       values ($1, $2, 'ARCHIVADO', $3, $4, $5)`,
      [organizacionId, predioId, motivoLimpio, actorCuentaId ?? null, ocurridoEn],
    );
    return serializePredioEstado(actualizado.rows[0]);
  });
}

/** Restaurar predio -- idempotente si ya ACTIVO. Nunca reactiva potreros individualmente archivados. */
export async function restaurarPredio(organizacionId, predioId, { actorCuentaId, now } = {}) {
  assertPredioIdFormat(predioId);

  return withOrganizacionTransaction(organizacionId, async (client) => {
    const predio = await fetchPredioEstado(client, predioId);
    if (predio.estado === 'ACTIVO') {
      return serializePredioEstado(predio); // idempotente
    }

    const ocurridoEn = now ?? new Date();
    const actualizado = await client.query(
      `update agx.predios
          set estado = 'ACTIVO', archivado_at = null, archivado_por = null, motivo_archivado = null
        where predio_id = $1
        returning ${PREDIO_ESTADO_SELECT}`,
      [predioId],
    );
    await client.query(
      `insert into agx.predio_archivo_eventos (organizacion_id, predio_id, tipo_evento, actor_cuenta_id, ocurrido_en)
       values ($1, $2, 'RESTAURADO', $3, $4)`,
      [organizacionId, predioId, actorCuentaId ?? null, ocurridoEn],
    );
    return serializePredioEstado(actualizado.rows[0]);
  });
}

/** Archivar potrero -- motivo obligatorio. Idempotente si ya ARCHIVADO. */
export async function archivarPotrero(organizacionId, predioId, potreroId, { motivo, actorCuentaId, now } = {}) {
  assertPredioIdFormat(predioId);
  assertPotreroIdFormat(potreroId);
  const motivoLimpio = typeof motivo === 'string' ? motivo.trim() : '';
  if (motivoLimpio === '') {
    throw semanticError('INVALID_MOTIVO_ARCHIVADO', 400, 'motivo es obligatorio para archivar un potrero.');
  }

  return withOrganizacionTransaction(organizacionId, async (client) => {
    const potrero = await fetchPotreroEstado(client, potreroId, predioId);
    if (potrero.estado === 'ARCHIVADO') {
      return serializePotreroEstado(potrero); // idempotente
    }
    if (await existeCicloEnCursoEnPotrero(client, potreroId)) {
      throw semanticError('POTRERO_CON_CICLO_EN_CURSO', 409, 'No se puede archivar: este potrero tiene un pastoreo en curso.');
    }

    const ocurridoEn = now ?? new Date();
    const actualizado = await client.query(
      `update agx.potreros
          set estado = 'ARCHIVADO', archivado_at = $1, archivado_por = $2, motivo_archivado = $3
        where potrero_id = $4
        returning ${POTRERO_ESTADO_SELECT}`,
      [ocurridoEn, actorCuentaId ?? null, motivoLimpio, potreroId],
    );
    await client.query(
      `insert into agx.potrero_archivo_eventos (organizacion_id, potrero_id, tipo_evento, motivo, actor_cuenta_id, ocurrido_en)
       values ($1, $2, 'ARCHIVADO', $3, $4, $5)`,
      [organizacionId, potreroId, motivoLimpio, actorCuentaId ?? null, ocurridoEn],
    );
    return serializePotreroEstado(actualizado.rows[0]);
  });
}

/**
 * Restaurar potrero -- idempotente si ya ACTIVO. Rechaza con
 * PREDIO_ARCHIVADO si el predio padre sigue archivado (SPRINT-3D9.2
 * DESIGN REVISION, punto 3) -- restaurar el potrero primero requiere que
 * el predio ya esté ACTIVO.
 */
export async function restaurarPotrero(organizacionId, predioId, potreroId, { actorCuentaId, now } = {}) {
  assertPredioIdFormat(predioId);
  assertPotreroIdFormat(potreroId);

  return withOrganizacionTransaction(organizacionId, async (client) => {
    const predio = await fetchPredioEstado(client, predioId);
    if (predio.estado === 'ARCHIVADO') {
      throw semanticError('PREDIO_ARCHIVADO', 409, 'No se puede restaurar el potrero mientras su predio siga archivado -- restaura primero el predio.');
    }

    const potrero = await fetchPotreroEstado(client, potreroId, predioId);
    if (potrero.estado === 'ACTIVO') {
      return serializePotreroEstado(potrero); // idempotente
    }

    const ocurridoEn = now ?? new Date();
    const actualizado = await client.query(
      `update agx.potreros
          set estado = 'ACTIVO', archivado_at = null, archivado_por = null, motivo_archivado = null
        where potrero_id = $1
        returning ${POTRERO_ESTADO_SELECT}`,
      [potreroId],
    );
    await client.query(
      `insert into agx.potrero_archivo_eventos (organizacion_id, potrero_id, tipo_evento, actor_cuenta_id, ocurrido_en)
       values ($1, $2, 'RESTAURADO', $3, $4)`,
      [organizacionId, potreroId, actorCuentaId ?? null, ocurridoEn],
    );
    return serializePotreroEstado(actualizado.rows[0]);
  });
}
