// SPRINT-3D9.1 -- CICLO REAL DE PASTOREO
//
// Separa estrictamente PLANIFICACIÓN (potreroRecomendacionPastoreoRepository.js,
// potreroDescansoRepository.js) de EJECUCIÓN REAL. Modelo híbrido
// aprobado (DESIGN REVISION 1): agx.potrero_ciclos_pastoreo (entidad
// operacional, mutable de forma controlada) + agx.potrero_ciclo_eventos
// (log append-only, auditoría independiente).
//
// El ciclo NO tiene estado PLANIFICADO -- nace únicamente vía "Iniciar
// pastoreo" (estado inicial EN_CURSO). Estados terminales: FINALIZADO,
// CANCELADO.
//
// "Finalizar pastoreo" es DOS FASES DESACOPLADAS (Design Revision 1
// corrección 1): FASE A (crítica, atómica -- transición del ciclo,
// nunca depende del clima) y FASE B (best-effort, transacción SEPARADA
// -- genera el descanso post-real, ver potreroDescansoRepository.js#generarDescansoPostCicloReal).
// Un fallo de FASE B NUNCA revierte FASE A.
import { withOrganizacionTransaction } from '../../db/agxBusinessPool.js';
import { resolveFechaHoyNegocio } from './motorDescansoAuto/businessTimezone.js';
import { generarDescansoPostCicloReal } from './potreroDescansoRepository.js';

const HISTORIAL_LIMIT = 10;

// Códigos Postgres transitorios/reintentables (Design Revision 1,
// Guardrail 2) -- serialization_failure, deadlock_detected, excepciones
// de conexión, statement_timeout. Cualquier otro error se clasifica
// ERROR_TECNICO (excepción inesperada/bug), nunca expuesto con detalle al
// cliente -- ambos casos dejan el ciclo FINALIZADO, solo cambia el nivel
// de log server-side.
const CODIGOS_PG_TRANSITORIOS = new Set(['40001', '40P01', '53300', '57014', '08000', '08003', '08006']);

/**
 * Clasifica un error de FASE B (Design Revision 1, Guardrail 2) --
 * exportada por separado para poder probarse de forma determinística sin
 * necesitar reproducir un error transitorio real de Postgres.
 */
export function classifyFaseBError(error) {
  return CODIGOS_PG_TRANSITORIOS.has(error?.code) ? 'PENDIENTE' : 'ERROR_TECNICO';
}

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

async function assertPotreroBelongsToPredio(client, predioId, potreroId) {
  const result = await client.query(
    'select potrero_id from agx.potreros where potrero_id = $1 and predio_id = $2',
    [potreroId, predioId],
  );
  if (result.rows.length === 0) {
    throw semanticError('POTRERO_NOT_FOUND', 404, 'El potrero no existe, no pertenece a este predio o no pertenece a tu organización.');
  }
}

async function fetchRecomendacionPastoreoMasReciente(client, potreroId) {
  const result = await client.query(
    `select recomendacion_id, ficha_id, contexto_id, categoria_id, numero_animales, peso_promedio_kg
       from agx.potrero_recomendaciones_pastoreo
      where potrero_id = $1
      order by created_at desc
      limit 1`,
    [potreroId],
  );
  if (result.rows.length === 0) {
    throw semanticError('NO_GRAZING_RECOMMENDATION', 404, 'Primero guarda una recomendación de pastoreo para este potrero.');
  }
  return result.rows[0];
}

async function fetchDescansoPlanMasReciente(client, potreroId) {
  const result = await client.query(
    `select descanso_id
       from agx.potrero_recomendaciones_descanso
      where potrero_id = $1
      order by created_at desc
      limit 1`,
    [potreroId],
  );
  return result.rows[0]?.descanso_id ?? null;
}

async function fetchContextoMasRecienteId(client, potreroId) {
  const result = await client.query(
    `select contexto_id from agx.potrero_contextos_agroclimaticos where potrero_id = $1 order by created_at desc limit 1`,
    [potreroId],
  );
  return result.rows[0]?.contexto_id ?? null;
}

async function resolveCategoriaId(client, categoriaCodigo) {
  if (categoriaCodigo === undefined || categoriaCodigo === null) return null;
  const result = await client.query(
    `select categoria_id from agx.catalogo_categorias_productivas where codigo = $1`,
    [categoriaCodigo],
  );
  if (result.rows.length === 0) {
    throw semanticError('INVALID_CATEGORIA_CODIGO', 400, 'La categoría indicada no existe en el catálogo.');
  }
  return result.rows[0].categoria_id;
}

const CICLO_SELECT = `ciclo_id, organizacion_id, predio_id, potrero_id, recomendacion_pastoreo_id,
            recomendacion_descanso_plan_id, categoria_id, numero_animales_real, peso_promedio_real_kg,
            to_char(fecha_ingreso_real, 'YYYY-MM-DD') as fecha_ingreso_real,
            to_char(fecha_salida_real, 'YYYY-MM-DD') as fecha_salida_real,
            estado, motivo_cancelacion, contexto_id, created_at`;

function serializeCiclo(row) {
  return {
    cicloId: String(row.ciclo_id),
    predioId: String(row.predio_id),
    potreroId: String(row.potrero_id),
    recomendacionPastoreoId: String(row.recomendacion_pastoreo_id),
    recomendacionDescansoPlanId: row.recomendacion_descanso_plan_id === null ? null : String(row.recomendacion_descanso_plan_id),
    categoriaId: String(row.categoria_id),
    numeroAnimalesReal: Number(row.numero_animales_real),
    pesoPromedioRealKg: Number(row.peso_promedio_real_kg),
    fechaIngresoReal: row.fecha_ingreso_real,
    fechaSalidaReal: row.fecha_salida_real,
    estado: row.estado,
    motivoCancelacion: row.motivo_cancelacion,
    contextoId: row.contexto_id === null ? null : String(row.contexto_id),
    createdAt: row.created_at,
  };
}

async function insertEvento(client, { organizacionId, potreroId, cicloId, tipoEvento, actorCuentaId, payload, now }) {
  await client.query(
    `insert into agx.potrero_ciclo_eventos (organizacion_id, potrero_id, ciclo_id, tipo_evento, ocurrido_en, actor_cuenta_id, payload_json)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [organizacionId, potreroId, cicloId, tipoEvento, now ?? new Date(), actorCuentaId ?? null, JSON.stringify(payload ?? {})],
  );
}

/**
 * Iniciar pastoreo -- crea el ciclo (estado EN_CURSO) + evento
 * PASTOREO_INICIADO en la MISMA transacción. El cliente NUNCA aporta una
 * fecha -- `fecha_ingreso_real` se resuelve SIEMPRE server-side (hoy,
 * hora del negocio). El único ajuste opcional del cliente es la
 * confirmación REAL del lote (puede diferir de lo planificado) -- nunca
 * modifica la recomendación de pastoreo original.
 *
 * Doble clic / dos requests concurrentes: el índice único parcial
 * (organizacion_id, potrero_id) WHERE estado='EN_CURSO' es la autoridad
 * -- un 23505 se traduce a CICLO_ALREADY_IN_PROGRESS (409), nunca una
 * carrera silenciosa.
 */
export async function iniciarCicloPastoreo(organizacionId, predioId, potreroId, {
  numeroAnimales, pesoPromedioKg, categoriaCodigo, actorCuentaId, now,
} = {}) {
  assertPredioIdFormat(predioId);
  assertPotreroIdFormat(potreroId);

  return withOrganizacionTransaction(organizacionId, async (client) => {
    await assertPotreroBelongsToPredio(client, predioId, potreroId);

    const recomendacionRow = await fetchRecomendacionPastoreoMasReciente(client, potreroId);
    const recomendacionDescansoPlanId = await fetchDescansoPlanMasReciente(client, potreroId);
    const contextoId = await fetchContextoMasRecienteId(client, potreroId);
    const categoriaAjustadaId = await resolveCategoriaId(client, categoriaCodigo);

    const categoriaId = categoriaAjustadaId ?? recomendacionRow.categoria_id;
    const numeroAnimalesReal = numeroAnimales !== undefined && numeroAnimales !== null
      ? Number(numeroAnimales)
      : Number(recomendacionRow.numero_animales);
    const pesoPromedioRealKg = pesoPromedioKg !== undefined && pesoPromedioKg !== null
      ? Number(pesoPromedioKg)
      : Number(recomendacionRow.peso_promedio_kg);

    if (!Number.isFinite(numeroAnimalesReal) || numeroAnimalesReal < 1 || numeroAnimalesReal > 100000) {
      throw semanticError('INVALID_NUMERO_ANIMALES_REAL', 400, 'numeroAnimales debe ser un entero entre 1 y 100000.');
    }
    if (!Number.isFinite(pesoPromedioRealKg) || pesoPromedioRealKg <= 0 || pesoPromedioRealKg > 2000) {
      throw semanticError('INVALID_PESO_PROMEDIO_REAL', 400, 'pesoPromedioKg debe ser mayor que 0 y menor o igual a 2000.');
    }

    const fechaIngresoReal = resolveFechaHoyNegocio(now);

    let insertResult;
    try {
      insertResult = await client.query(
        `insert into agx.potrero_ciclos_pastoreo
           (organizacion_id, predio_id, potrero_id, recomendacion_pastoreo_id, recomendacion_descanso_plan_id,
            categoria_id, numero_animales_real, peso_promedio_real_kg, fecha_ingreso_real, contexto_id, estado)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'EN_CURSO')
         returning ${CICLO_SELECT}`,
        [
          organizacionId, predioId, potreroId, recomendacionRow.recomendacion_id, recomendacionDescansoPlanId,
          categoriaId, numeroAnimalesReal, pesoPromedioRealKg, fechaIngresoReal, contextoId,
        ],
      );
    } catch (error) {
      if (error.code === '23505') {
        throw semanticError('CICLO_ALREADY_IN_PROGRESS', 409, 'Ya existe un pastoreo en curso en este potrero.');
      }
      throw error;
    }

    const ciclo = insertResult.rows[0];
    await insertEvento(client, {
      organizacionId, potreroId, cicloId: ciclo.ciclo_id, tipoEvento: 'PASTOREO_INICIADO', actorCuentaId,
      payload: { categoriaId, numeroAnimalesReal, pesoPromedioRealKg },
    });

    return serializeCiclo(ciclo);
  });
}

/**
 * Finalizar pastoreo -- FASE A (crítica, atómica) + FASE B (best-effort,
 * transacción separada). Ver cabecera del archivo. Idempotente: llamar
 * este endpoint N veces sobre el mismo cicloId nunca duplica la
 * transición ni el evento -- solo reintenta FASE B si quedó pendiente.
 */
export async function finalizarCicloPastoreo(organizacionId, predioId, potreroId, cicloId, {
  actorCuentaId, now, climatologyFetchImpl,
} = {}) {
  assertPredioIdFormat(predioId);
  assertPotreroIdFormat(potreroId);

  // ---- FASE A: crítica y atómica -- NUNCA depende del clima. ----
  const ciclo = await withOrganizacionTransaction(organizacionId, async (client) => {
    const actual = await client.query(
      `select ${CICLO_SELECT} from agx.potrero_ciclos_pastoreo
        where ciclo_id = $1 and potrero_id = $2 and predio_id = $3
        for update`,
      [cicloId, potreroId, predioId],
    );
    if (actual.rows.length === 0) {
      throw semanticError('CICLO_NOT_FOUND', 404, 'El ciclo de pastoreo no existe o no pertenece a este potrero.');
    }
    const cicloActual = actual.rows[0];

    if (cicloActual.estado === 'CANCELADO') {
      throw semanticError('CICLO_CANCELADO', 409, 'Este ciclo fue cancelado -- no puede finalizarse.');
    }
    if (cicloActual.estado === 'FINALIZADO') {
      // Idempotente: FASE A ya se ejecutó en una llamada anterior -- NUNCA
      // un segundo UPDATE ni un segundo evento PASTOREO_FINALIZADO.
      return cicloActual;
    }

    const fechaSalidaReal = resolveFechaHoyNegocio(now);
    const actualizado = await client.query(
      `update agx.potrero_ciclos_pastoreo
          set estado = 'FINALIZADO', fecha_salida_real = $1
        where ciclo_id = $2 and estado = 'EN_CURSO'
        returning ${CICLO_SELECT}`,
      [fechaSalidaReal, cicloId],
    );
    if (actualizado.rows.length === 0) {
      // Perdió la carrera contra otra transacción concurrente (no debería
      // ocurrir gracias al FOR UPDATE, pero es la garantía de última
      // línea) -- releer el estado real en vez de asumir.
      const releido = await client.query(`select ${CICLO_SELECT} from agx.potrero_ciclos_pastoreo where ciclo_id = $1`, [cicloId]);
      return releido.rows[0];
    }

    const cicloFinalizado = actualizado.rows[0];
    await insertEvento(client, {
      organizacionId, potreroId, cicloId, tipoEvento: 'PASTOREO_FINALIZADO', actorCuentaId,
      payload: { fechaSalidaReal },
    });
    return cicloFinalizado;
  });

  if (ciclo.estado !== 'FINALIZADO') {
    // CANCELADO detectado en el release-de-carrera -- terminal, igual que
    // el chequeo explícito de arriba.
    throw semanticError('CICLO_CANCELADO', 409, 'Este ciclo fue cancelado -- no puede finalizarse.');
  }

  // ---- FASE B: best-effort, transacción SEPARADA -- un fallo aquí NUNCA
  // revierte FASE A (ya comprometida). ----
  try {
    const { descanso } = await generarDescansoPostCicloReal(organizacionId, {
      predioId,
      potreroId,
      cicloId: Number(ciclo.ciclo_id),
      fechaIngresoReal: ciclo.fecha_ingreso_real,
      fechaSalidaReal: ciclo.fecha_salida_real,
      recomendacionDescansoPlanId: ciclo.recomendacion_descanso_plan_id,
      climatologyFetchImpl,
    });
    return { ciclo: serializeCiclo(ciclo), descansoEstado: 'GENERADO', descanso };
  } catch (error) {
    const descansoEstado = classifyFaseBError(error);
    if (descansoEstado === 'PENDIENTE') {
      // eslint-disable-next-line no-console
      console.warn('[ciclo-pastoreo] FASE B pendiente (condición transitoria/reintentable):', { cicloId, code: error?.code, message: error?.message });
    } else {
      // eslint-disable-next-line no-console
      console.error('[ciclo-pastoreo] FASE B error técnico inesperado:', { cicloId, code: error?.code, message: error?.message, stack: error?.stack });
    }
    return { ciclo: serializeCiclo(ciclo), descansoEstado, descanso: null };
  }
}

/**
 * Cancelar -- solo EN_CURSO -> CANCELADO. Motivo obligatorio, no vacío.
 * Nunca DELETE. Idempotente: cancelar un ciclo ya CANCELADO es un no-op
 * (mismo criterio de "nunca duplicar el evento" que finalizar).
 */
export async function cancelarCicloPastoreo(organizacionId, predioId, potreroId, cicloId, { motivo, actorCuentaId } = {}) {
  assertPredioIdFormat(predioId);
  assertPotreroIdFormat(potreroId);

  const motivoLimpio = typeof motivo === 'string' ? motivo.trim() : '';
  if (motivoLimpio === '') {
    throw semanticError('INVALID_MOTIVO_CANCELACION', 400, 'motivo es obligatorio para cancelar un ciclo.');
  }

  return withOrganizacionTransaction(organizacionId, async (client) => {
    const actual = await client.query(
      `select ${CICLO_SELECT} from agx.potrero_ciclos_pastoreo
        where ciclo_id = $1 and potrero_id = $2 and predio_id = $3
        for update`,
      [cicloId, potreroId, predioId],
    );
    if (actual.rows.length === 0) {
      throw semanticError('CICLO_NOT_FOUND', 404, 'El ciclo de pastoreo no existe o no pertenece a este potrero.');
    }
    const cicloActual = actual.rows[0];

    if (cicloActual.estado === 'CANCELADO') {
      return serializeCiclo(cicloActual);
    }
    if (cicloActual.estado === 'FINALIZADO') {
      throw semanticError('CICLO_NOT_IN_PROGRESS', 409, 'Este ciclo ya fue finalizado -- no puede cancelarse.');
    }

    const actualizado = await client.query(
      `update agx.potrero_ciclos_pastoreo
          set estado = 'CANCELADO', motivo_cancelacion = $1
        where ciclo_id = $2 and estado = 'EN_CURSO'
        returning ${CICLO_SELECT}`,
      [motivoLimpio, cicloId],
    );
    if (actualizado.rows.length === 0) {
      const releido = await client.query(`select ${CICLO_SELECT} from agx.potrero_ciclos_pastoreo where ciclo_id = $1`, [cicloId]);
      return serializeCiclo(releido.rows[0]);
    }

    const cicloCancelado = actualizado.rows[0];
    await insertEvento(client, {
      organizacionId, potreroId, cicloId, tipoEvento: 'PASTOREO_CANCELADO', actorCuentaId, payload: { motivo: motivoLimpio },
    });
    return serializeCiclo(cicloCancelado);
  });
}

/** Ciclo EN_CURSO del potrero, o null -- nunca 404 (lectura pura). */
export async function getCicloActual(organizacionId, predioId, potreroId) {
  assertPredioIdFormat(predioId);
  assertPotreroIdFormat(potreroId);

  return withOrganizacionTransaction(organizacionId, async (client) => {
    await assertPotreroBelongsToPredio(client, predioId, potreroId);
    const result = await client.query(
      `select ${CICLO_SELECT} from agx.potrero_ciclos_pastoreo
        where potrero_id = $1 and estado = 'EN_CURSO'
        limit 1`,
      [potreroId],
    );
    return result.rows[0] ? serializeCiclo(result.rows[0]) : null;
  });
}

/** Historial de ciclos FINALIZADO/CANCELADO -- lectura pura. */
export async function getCicloHistorial(organizacionId, predioId, potreroId) {
  assertPredioIdFormat(predioId);
  assertPotreroIdFormat(potreroId);

  return withOrganizacionTransaction(organizacionId, async (client) => {
    await assertPotreroBelongsToPredio(client, predioId, potreroId);
    const result = await client.query(
      `select ${CICLO_SELECT} from agx.potrero_ciclos_pastoreo
        where potrero_id = $1 and estado <> 'EN_CURSO'
        order by created_at desc
        limit $2`,
      [potreroId, HISTORIAL_LIMIT],
    );
    return result.rows.map(serializeCiclo);
  });
}
