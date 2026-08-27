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
import {
  generarDescansoPostCicloReal,
  generarDescansoPostCicloRealSiguienteVersion,
  fetchDescansoVigentePorCiclo,
  invalidarDescansoVersion,
} from './potreroDescansoRepository.js';
import { assertPuedeIniciarCiclo, resolveEstadoOperativoPotrero } from './potreroEstadoOperativoRepository.js';

const HISTORIAL_LIMIT = 10;
const FECHA_ISO_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

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
            estado, motivo_cancelacion, motivo_anulacion, contexto_id, created_at`;

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
    motivoAnulacion: row.motivo_anulacion,
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
    // SPRINT-3D9.2: reentry guard -- backend es la autoridad, nunca solo
    // frontend. Orden: archivado (predio/potrero) -> descanso vigente
    // (POTRERO_IN_REST_PERIOD/POTRERO_REST_ASSESSMENT_PENDING) ->
    // evaluación de reingreso pendiente (POTRERO_REINGRESO_NO_CONFIRMADO).
    // CICLO_ALREADY_IN_PROGRESS sigue siendo la última defensa, vía el
    // índice único parcial más abajo (23505).
    await assertPuedeIniciarCiclo(client, { predioId, potreroId, now });

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
      // SPRINT-3D9.2 (FIX BUG_LATEST_RECOMMENDATION): la recomendación
      // EXACTA que originó este ciclo -- nunca "la más reciente del
      // potrero" en el momento de finalizar.
      recomendacionPastoreoId: Number(ciclo.recomendacion_pastoreo_id),
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

/** Historial de ciclos FINALIZADO/CANCELADO/ANULADO -- lectura pura. */
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

/**
 * SPRINT-3D9.2 -- Anular ciclo histórico (FINALIZADO/CANCELADO) que
 * nunca debió contar. NUNCA sobre EN_CURSO -- para eso existe Cancelar.
 * Transacción única (nunca FASE A/B separadas): invalidar el descanso
 * derivado es un INSERT puramente local sin dependencia externa (nunca
 * llama al proveedor climático), así que puede -- y debe -- ir en la
 * MISMA transacción que la transición de estado. Nunca queda un ciclo
 * ANULADO cuyo descanso anterior siga vigente por error.
 */
export async function anularCicloPastoreo(organizacionId, predioId, potreroId, cicloId, { motivo, actorCuentaId, now } = {}) {
  assertPredioIdFormat(predioId);
  assertPotreroIdFormat(potreroId);

  const motivoLimpio = typeof motivo === 'string' ? motivo.trim() : '';
  if (motivoLimpio === '') {
    throw semanticError('INVALID_MOTIVO_ANULACION', 400, 'motivo es obligatorio para anular un ciclo.');
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

    if (cicloActual.estado === 'ANULADO') {
      return serializeCiclo(cicloActual); // idempotente
    }
    if (cicloActual.estado === 'EN_CURSO') {
      throw semanticError('CICLO_EN_CURSO_USE_CANCELAR', 409, 'Este ciclo está en curso -- usa "Cancelar" en vez de "Anular".');
    }
    // FINALIZADO o CANCELADO -- ambos anulables.

    const actualizado = await client.query(
      `update agx.potrero_ciclos_pastoreo
          set estado = 'ANULADO', motivo_anulacion = $1
        where ciclo_id = $2
        returning ${CICLO_SELECT}`,
      [motivoLimpio, cicloId],
    );
    const cicloAnulado = actualizado.rows[0];

    await insertEvento(client, {
      organizacionId, potreroId, cicloId, tipoEvento: 'PASTOREO_ANULADO', actorCuentaId, now,
      payload: { motivo: motivoLimpio, estadoAnterior: cicloActual.estado },
    });

    if (cicloActual.estado === 'FINALIZADO') {
      const vigente = await fetchDescansoVigentePorCiclo(client, cicloId);
      if (vigente) {
        await invalidarDescansoVersion(client, {
          descansoId: Number(vigente.descansoId),
          cicloPastoreoId: cicloId,
          potreroId,
          organizacionId,
          motivo: 'ciclo_anulado',
          actorCuentaId,
        });
      }
    }

    return serializeCiclo(cicloAnulado);
  });
}

/**
 * SPRINT-3D9.2 -- Corregir un ciclo FINALIZADO (dato real capturado
 * incorrectamente). Distinto de Cancelar (EN_CURSO por error) y de
 * Anular (ciclo histórico que nunca debió contar) -- aquí el ciclo SÍ
 * ocurrió, solo se corrige un dato.
 *
 * FASE A' (atómica): valida, aplica el UPDATE, inserta el evento
 * PASTOREO_CORREGIDO, e INVALIDA el descanso vigente derivado (si la
 * corrección toca fecha_ingreso_real/fecha_salida_real y existía uno) --
 * TODO en la misma transacción. Desde el COMMIT, el descanso viejo YA no
 * es vigente, sin importar si FASE B' (recalcular) tiene éxito o falla.
 *
 * FASE B' (best-effort, transacción separada): solo si se corrigió una
 * fecha -- genera la siguiente versión del descanso con las fechas ya
 * corregidas. Un fallo aquí NUNCA revierte la corrección ni restaura el
 * descanso viejo -- "sin recomendación vigente" es preferible a
 * "recomendación conocida como incorrecta".
 */
export async function corregirCicloPastoreo(organizacionId, predioId, potreroId, cicloId, {
  fechaIngresoReal, fechaSalidaReal, categoriaCodigo, numeroAnimales, pesoPromedioKg, motivo, actorCuentaId, now, climatologyFetchImpl,
} = {}) {
  assertPredioIdFormat(predioId);
  assertPotreroIdFormat(potreroId);

  const motivoLimpio = typeof motivo === 'string' ? motivo.trim() : '';
  if (motivoLimpio === '') {
    throw semanticError('INVALID_MOTIVO_CORRECCION', 400, 'motivo es obligatorio para corregir un ciclo.');
  }

  const algunCampoSolicitado = [fechaIngresoReal, fechaSalidaReal, categoriaCodigo, numeroAnimales, pesoPromedioKg]
    .some((valor) => valor !== undefined);
  if (!algunCampoSolicitado) {
    throw semanticError('SIN_CAMBIOS_SOLICITADOS', 400, 'Debes indicar al menos un campo a corregir.');
  }

  if (fechaIngresoReal !== undefined && !FECHA_ISO_PATTERN.test(fechaIngresoReal)) {
    throw semanticError('INVALID_FECHA_INGRESO_REAL', 400, 'fechaIngresoReal debe tener formato YYYY-MM-DD.');
  }
  if (fechaSalidaReal !== undefined && !FECHA_ISO_PATTERN.test(fechaSalidaReal)) {
    throw semanticError('INVALID_FECHA_SALIDA_REAL', 400, 'fechaSalidaReal debe tener formato YYYY-MM-DD.');
  }
  if (numeroAnimales !== undefined && (!Number.isInteger(numeroAnimales) || numeroAnimales < 1 || numeroAnimales > 100000)) {
    throw semanticError('INVALID_NUMERO_ANIMALES_REAL', 400, 'numeroAnimales debe ser un entero entre 1 y 100000.');
  }
  if (pesoPromedioKg !== undefined && (!Number.isFinite(pesoPromedioKg) || pesoPromedioKg <= 0 || pesoPromedioKg > 2000)) {
    throw semanticError('INVALID_PESO_PROMEDIO_REAL', 400, 'pesoPromedioKg debe ser mayor que 0 y menor o igual a 2000.');
  }

  // Solo estos dos campos disparan el recálculo de descanso (FASE B') --
  // categoría/numeroAnimales/pesoPromedio no alimentan el motor de
  // descanso (que usa la recomendación de pastoreo, no el snapshot real).
  const debeRegenerarDescanso = fechaIngresoReal !== undefined || fechaSalidaReal !== undefined;

  const { ciclo, huboCambios } = await withOrganizacionTransaction(organizacionId, async (client) => {
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
    if (cicloActual.estado !== 'FINALIZADO') {
      throw semanticError('CICLO_NOT_FINALIZADO', 409, 'Solo un ciclo finalizado puede corregirse.');
    }

    const categoriaAjustadaId = categoriaCodigo !== undefined ? await resolveCategoriaId(client, categoriaCodigo) : undefined;

    const cambios = [];
    if (fechaIngresoReal !== undefined && fechaIngresoReal !== cicloActual.fecha_ingreso_real) {
      cambios.push({ campo: 'fechaIngresoReal', valorAnterior: cicloActual.fecha_ingreso_real, valorNuevo: fechaIngresoReal });
    }
    if (fechaSalidaReal !== undefined && fechaSalidaReal !== cicloActual.fecha_salida_real) {
      cambios.push({ campo: 'fechaSalidaReal', valorAnterior: cicloActual.fecha_salida_real, valorNuevo: fechaSalidaReal });
    }
    if (categoriaAjustadaId !== undefined && String(categoriaAjustadaId) !== String(cicloActual.categoria_id)) {
      cambios.push({ campo: 'categoriaId', valorAnterior: String(cicloActual.categoria_id), valorNuevo: String(categoriaAjustadaId) });
    }
    if (numeroAnimales !== undefined && numeroAnimales !== Number(cicloActual.numero_animales_real)) {
      cambios.push({ campo: 'numeroAnimalesReal', valorAnterior: Number(cicloActual.numero_animales_real), valorNuevo: numeroAnimales });
    }
    if (pesoPromedioKg !== undefined && pesoPromedioKg !== Number(cicloActual.peso_promedio_real_kg)) {
      cambios.push({ campo: 'pesoPromedioRealKg', valorAnterior: Number(cicloActual.peso_promedio_real_kg), valorNuevo: pesoPromedioKg });
    }

    if (cambios.length === 0) {
      // Idempotente: retry con el mismo payload ya aplicado -- sin
      // evento nuevo, sin invalidar nada. El llamador igual intenta
      // FASE B' más abajo (mismo criterio que finalizar/FASE B).
      return { ciclo: cicloActual, huboCambios: false };
    }

    const actualizado = await client.query(
      `update agx.potrero_ciclos_pastoreo
          set fecha_ingreso_real = $1, fecha_salida_real = $2, categoria_id = $3,
              numero_animales_real = $4, peso_promedio_real_kg = $5
        where ciclo_id = $6
        returning ${CICLO_SELECT}`,
      [
        fechaIngresoReal !== undefined ? fechaIngresoReal : cicloActual.fecha_ingreso_real,
        fechaSalidaReal !== undefined ? fechaSalidaReal : cicloActual.fecha_salida_real,
        categoriaAjustadaId !== undefined ? categoriaAjustadaId : cicloActual.categoria_id,
        numeroAnimales !== undefined ? numeroAnimales : Number(cicloActual.numero_animales_real),
        pesoPromedioKg !== undefined ? pesoPromedioKg : Number(cicloActual.peso_promedio_real_kg),
        cicloId,
      ],
    );
    const cicloCorregido = actualizado.rows[0];

    await insertEvento(client, {
      organizacionId, potreroId, cicloId, tipoEvento: 'PASTOREO_CORREGIDO', actorCuentaId, now,
      payload: { motivo: motivoLimpio, cambios },
    });

    if (debeRegenerarDescanso) {
      const vigente = await fetchDescansoVigentePorCiclo(client, cicloId);
      if (vigente) {
        await invalidarDescansoVersion(client, {
          descansoId: Number(vigente.descansoId),
          cicloPastoreoId: cicloId,
          potreroId,
          organizacionId,
          motivo: 'correccion_fecha',
          actorCuentaId,
        });
      }
    }

    return { ciclo: cicloCorregido, huboCambios: true };
  });

  if (!debeRegenerarDescanso) {
    return { ciclo: serializeCiclo(ciclo), descansoEstado: null, descanso: null, huboCambios };
  }

  // ---- FASE B': best-effort, transacción SEPARADA -- un fallo aquí
  // NUNCA restaura el descanso viejo (ya invalidado en FASE A'). ----
  try {
    const { descanso } = await generarDescansoPostCicloRealSiguienteVersion(organizacionId, {
      predioId,
      potreroId,
      cicloId: Number(ciclo.ciclo_id),
      recomendacionPastoreoId: Number(ciclo.recomendacion_pastoreo_id),
      fechaIngresoReal: ciclo.fecha_ingreso_real,
      fechaSalidaReal: ciclo.fecha_salida_real,
      recomendacionDescansoPlanId: ciclo.recomendacion_descanso_plan_id,
      climatologyFetchImpl,
    });
    return { ciclo: serializeCiclo(ciclo), descansoEstado: 'GENERADO', descanso, huboCambios };
  } catch (error) {
    const descansoEstado = classifyFaseBError(error);
    if (descansoEstado === 'PENDIENTE') {
      // eslint-disable-next-line no-console
      console.warn('[ciclo-pastoreo] FASE B\' pendiente (condición transitoria/reintentable):', { cicloId, code: error?.code, message: error?.message });
    } else {
      // eslint-disable-next-line no-console
      console.error('[ciclo-pastoreo] FASE B\' error técnico inesperado:', { cicloId, code: error?.code, message: error?.message, stack: error?.stack });
    }
    return { ciclo: serializeCiclo(ciclo), descansoEstado, descanso: null, huboCambios };
  }
}

function serializeEvaluacionReingreso(row) {
  return {
    evaluacionId: String(row.evaluacion_id),
    potreroId: String(row.potrero_id),
    cicloOrigenId: String(row.ciclo_origen_id),
    descansoId: String(row.descanso_id),
    fichaId: String(row.ficha_id),
    resultado: row.resultado,
    observacion: row.observacion,
    createdAt: row.created_at,
  };
}

/**
 * SPRINT-3D9.2 -- Evaluar reingreso. El sistema NUNCA decide
 * automáticamente APTO/NO_APTO -- solo registra el juicio humano,
 * siempre respaldado por un aforo NUEVO (fichaId) posterior a la
 * apertura de la ventana (fecha_reingreso_min). Solo aplica cuando el
 * estado operativo derivado es EVALUACION_REINGRESO.
 */
export async function evaluarReingreso(organizacionId, predioId, potreroId, { fichaId, resultado, observacion, actorCuentaId, now } = {}) {
  assertPredioIdFormat(predioId);
  assertPotreroIdFormat(potreroId);

  if (resultado !== 'APTO' && resultado !== 'NO_APTO') {
    throw semanticError('INVALID_RESULTADO_EVALUACION', 400, 'resultado debe ser APTO o NO_APTO.');
  }
  const observacionLimpia = typeof observacion === 'string' ? observacion.trim() : '';
  if (resultado === 'NO_APTO' && observacionLimpia === '') {
    throw semanticError('INVALID_OBSERVACION_EVALUACION', 400, 'observacion es obligatoria cuando el resultado es NO_APTO.');
  }
  if (!/^\d+$/.test(String(fichaId))) {
    throw semanticError('INVALID_FICHA_ID', 400, 'fichaId inválido.');
  }

  return withOrganizacionTransaction(organizacionId, async (client) => {
    await assertPotreroBelongsToPredio(client, predioId, potreroId);

    const estadoActual = await resolveEstadoOperativoPotrero(client, { predioId, potreroId, now });
    if (estadoActual.estado !== 'EVALUACION_REINGRESO') {
      throw semanticError('POTRERO_SIN_VENTANA_REINGRESO_ABIERTA', 409, 'Este potrero no tiene una ventana de reingreso abierta para evaluar.');
    }
    const { cicloOrigenId, descanso } = estadoActual;

    const fichaResult = await client.query(
      `select ficha_id, to_char(fecha_aforo, 'YYYY-MM-DD') as fecha_aforo
         from agx.potrero_fichas_productivas
        where ficha_id = $1 and potrero_id = $2`,
      [fichaId, potreroId],
    );
    if (fichaResult.rows.length === 0) {
      throw semanticError('FICHA_NOT_FOUND', 404, 'La ficha/aforo indicada no existe o no pertenece a este potrero.');
    }
    const ficha = fichaResult.rows[0];
    if (!ficha.fecha_aforo || ficha.fecha_aforo < descanso.fechaReingresoMin) {
      throw semanticError('AFORO_ANTERIOR_A_VENTANA_REINGRESO', 400, 'El aforo debe ser posterior a la apertura de la ventana de reingreso -- registra un aforo nuevo antes de evaluar.');
    }

    // SPRINT-3D9.2 (PRE-COMMIT FINAL ROUND, punto 5): "no aceptar un aforo
    // viejo silenciosamente" -- no basta con que el fichaId enviado sea
    // válido dentro de la ventana; debe ser el aforo válido MÁS RECIENTE
    // de este potrero. Sin este chequeo, un caller que se salte el
    // frontend (que siempre usa el más reciente vía getFichaProductiva)
    // podría reutilizar un aforo antiguo-pero-todavía-dentro-de-ventana en
    // vez del último registrado.
    const masRecienteResult = await client.query(
      `select ficha_id
         from agx.potrero_fichas_productivas
        where potrero_id = $1 and fecha_aforo >= $2
        order by created_at desc
        limit 1`,
      [potreroId, descanso.fechaReingresoMin],
    );
    if (Number(masRecienteResult.rows[0]?.ficha_id) !== Number(fichaId)) {
      throw semanticError('AFORO_NO_ES_EL_MAS_RECIENTE', 409, 'Existe un aforo más reciente para este potrero -- usa el último registrado para evaluar el reingreso.');
    }

    try {
      const result = await client.query(
        `insert into agx.potrero_evaluaciones_reingreso
           (organizacion_id, potrero_id, ciclo_origen_id, descanso_id, ficha_id, resultado, criterios_json, observacion, actor_cuenta_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         returning evaluacion_id, potrero_id, ciclo_origen_id, descanso_id, ficha_id, resultado, observacion, created_at`,
        [
          organizacionId, potreroId, Number(cicloOrigenId), Number(descanso.descansoId), Number(fichaId),
          resultado, JSON.stringify({}), observacionLimpia || null, actorCuentaId ?? null,
        ],
      );
      return serializeEvaluacionReingreso(result.rows[0]);
    } catch (error) {
      if (error.code === '23505') {
        throw semanticError('EVALUACION_APTO_YA_REGISTRADA', 409, 'Ya existe una evaluación APTO registrada para este descanso.');
      }
      throw error;
    }
  });
}
