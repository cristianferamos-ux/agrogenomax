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
import {
  resolveFichaIdBaseReal,
  crearSnapshotLoteReal,
  invalidarSnapshotLoteReal,
  fetchSnapshotLoteRealVigente,
} from './potreroCicloRealPressureRepository.js';

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
    `select recomendacion_id, ficha_id, contexto_id, categoria_id, numero_animales, peso_promedio_kg,
            produccion_leche_l_dia, dias_en_leche, grasa_leche_pct, ternero_al_pie
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
            ingreso_real_at, salida_real_at,
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
    // SPRINT-3D9.3: timestamps operacionales precisos -- NULL en ciclos
    // creados antes de 3D9.3, nunca inferidos.
    ingresoRealAt: row.ingreso_real_at ?? null,
    salidaRealAt: row.salida_real_at ?? null,
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
  numeroAnimales, pesoPromedioKg, categoriaCodigo,
  produccionLecheLDia, diasEnLeche, grasaLechePct, terneroAlPie,
  actorCuentaId, now,
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

    // SPRINT-3D9.3 -- campos condicionales REAL (leche/ternero): mismo
    // criterio que numeroAnimales/pesoPromedioKg/categoriaCodigo -- si el
    // cliente no aporta un ajuste, se hereda del PLAN vigente (puede ser
    // null si el PLAN tampoco los tenía). NUNCA se exige su presencia
    // aquí -- iniciar el ciclo nunca se bloquea por evidencia científica
    // incompleta (eso degrada a PLAN_FALLBACK más adelante, al calcular
    // presión real). Solo se valida el TIPO cuando el cliente sí envía un
    // valor.
    const produccionLecheLDiaReal = produccionLecheLDia !== undefined
      ? produccionLecheLDia
      : (recomendacionRow.produccion_leche_l_dia === null ? null : Number(recomendacionRow.produccion_leche_l_dia));
    const diasEnLecheReal = diasEnLeche !== undefined
      ? diasEnLeche
      : (recomendacionRow.dias_en_leche === null ? null : Number(recomendacionRow.dias_en_leche));
    const grasaLechePctReal = grasaLechePct !== undefined
      ? grasaLechePct
      : (recomendacionRow.grasa_leche_pct === null ? null : Number(recomendacionRow.grasa_leche_pct));
    const terneroAlPieReal = terneroAlPie !== undefined ? terneroAlPie : recomendacionRow.ternero_al_pie;

    if (produccionLecheLDiaReal !== null && !Number.isFinite(produccionLecheLDiaReal)) {
      throw semanticError('INVALID_PRODUCCION_LECHE_REAL', 400, 'produccionLecheLDia debe ser numérico.');
    }
    if (diasEnLecheReal !== null && !Number.isFinite(diasEnLecheReal)) {
      throw semanticError('INVALID_DIAS_EN_LECHE_REAL', 400, 'diasEnLeche debe ser numérico.');
    }
    if (grasaLechePctReal !== null && !Number.isFinite(grasaLechePctReal)) {
      throw semanticError('INVALID_GRASA_LECHE_REAL', 400, 'grasaLechePct debe ser numérico.');
    }
    if (terneroAlPieReal !== null && terneroAlPieReal !== undefined && typeof terneroAlPieReal !== 'boolean') {
      throw semanticError('INVALID_TERNERO_AL_PIE_REAL', 400, 'terneroAlPie debe ser verdadero o falso.');
    }

    const ingresoRealAt = now ?? new Date();
    const fechaIngresoReal = resolveFechaHoyNegocio(ingresoRealAt);

    let insertResult;
    try {
      insertResult = await client.query(
        `insert into agx.potrero_ciclos_pastoreo
           (organizacion_id, predio_id, potrero_id, recomendacion_pastoreo_id, recomendacion_descanso_plan_id,
            categoria_id, numero_animales_real, peso_promedio_real_kg, fecha_ingreso_real, ingreso_real_at, contexto_id, estado)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'EN_CURSO')
         returning ${CICLO_SELECT}`,
        [
          organizacionId, predioId, potreroId, recomendacionRow.recomendacion_id, recomendacionDescansoPlanId,
          categoriaId, numeroAnimalesReal, pesoPromedioRealKg, fechaIngresoReal, ingresoRealAt, contextoId,
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

    // SPRINT-3D9.3 -- snapshot v1 SIEMPRE, incluso si no hay ficha
    // elegible (fichaIdBaseReal queda null -- el ciclo igual inicia con
    // normalidad, ver diseño 3D9.3 punto 3). Fuente científica
    // autoritativa desde este momento en adelante para este ciclo.
    const fichaIdBaseReal = await resolveFichaIdBaseReal(client, { potreroId, ingresoRealAt });
    await crearSnapshotLoteReal(client, {
      organizacionId, predioId, potreroId, cicloId: ciclo.ciclo_id, version: 1,
      categoriaId, numeroAnimales: numeroAnimalesReal, pesoPromedioKg: pesoPromedioRealKg,
      produccionLecheLDia: produccionLecheLDiaReal, diasEnLeche: diasEnLecheReal, grasaLechePct: grasaLechePctReal,
      terneroAlPie: terneroAlPieReal, fichaIdBaseReal, ingresoRealAt, salidaRealAt: null, actorCuentaId,
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

    const salidaRealAt = now ?? new Date();
    const fechaSalidaReal = resolveFechaHoyNegocio(salidaRealAt);
    const actualizado = await client.query(
      `update agx.potrero_ciclos_pastoreo
          set estado = 'FINALIZADO', fecha_salida_real = $1, salida_real_at = $2
        where ciclo_id = $3 and estado = 'EN_CURSO'
        returning ${CICLO_SELECT}`,
      [fechaSalidaReal, salidaRealAt, cicloId],
    );
    if (actualizado.rows.length === 0) {
      // Perdió la carrera contra otra transacción concurrente (no debería
      // ocurrir gracias al FOR UPDATE, pero es la garantía de última
      // línea) -- releer el estado real en vez de asumir. Nunca crea un
      // snapshot nuevo aquí -- el ganador de la carrera ya lo hizo.
      const releido = await client.query(`select ${CICLO_SELECT} from agx.potrero_ciclos_pastoreo where ciclo_id = $1`, [cicloId]);
      return releido.rows[0];
    }

    const cicloFinalizado = actualizado.rows[0];
    await insertEvento(client, {
      organizacionId, potreroId, cicloId, tipoEvento: 'PASTOREO_FINALIZADO', actorCuentaId,
      payload: { fechaSalidaReal },
    });

    // SPRINT-3D9.3 -- versiona el snapshot real: v1 (solo ingreso) -> vN+1
    // (copia TODOS los campos científicos + agrega salida_real_at),
    // invalida vN. Nunca UPDATE científico. Solo ocurre en esta rama
    // (transición EN_CURSO -> FINALIZADO real, nunca en un retry
    // idempotente ni en el release-de-carrera de arriba). Ciclos sin
    // snapshot vigente (creados antes de 3D9.3) simplemente no tienen
    // nada que versionar -- comportamiento legacy intacto.
    const vigente = await fetchSnapshotLoteRealVigente(client, cicloId);
    if (vigente) {
      await crearSnapshotLoteReal(client, {
        organizacionId, predioId, potreroId, cicloId, version: vigente.version + 1,
        categoriaId: vigente.categoriaId, numeroAnimales: vigente.numeroAnimales, pesoPromedioKg: vigente.pesoPromedioKg,
        produccionLecheLDia: vigente.produccionLecheLDia, diasEnLeche: vigente.diasEnLeche, grasaLechePct: vigente.grasaLechePct,
        terneroAlPie: vigente.terneroAlPie, fichaIdBaseReal: vigente.fichaIdBaseReal,
        ingresoRealAt: vigente.ingresoRealAt, salidaRealAt, actorCuentaId,
      });
      await invalidarSnapshotLoteReal(client, {
        snapshotId: vigente.snapshotId, cicloId, potreroId, organizacionId, motivo: 'ciclo_finalizado', actorCuentaId,
      });
    }

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
// =========================================================================
// SPRINT-3D9.3 -- REGLA FORMAL DE CORRECCIÓN TEMPORAL (PRE-COMMIT FIX
// ROUND, punto 2). No existe UI para capturar una hora nueva exacta --
// "corregir fecha_ingreso_real/fecha_salida_real" solo recibe una FECHA
// (YYYY-MM-DD), nunca una hora. Ninguna corrección de fecha puede
// entonces INVENTAR una hora nueva -- la regla es:
//
//   nuevoTimestamp = timestampOriginal + (fechaNueva - fechaAnterior)
//
// es decir, se PRESERVA la hora-del-día original y se desplaza el
// timestamp completo por el delta EXACTO de días de calendario entre la
// fecha anterior y la nueva. Ejemplo (America/Bogota, UTC-5):
//   ingreso_real_at original = 2026-08-28 08:37 America/Bogota
//   corrección: fechaIngresoReal 2026-08-28 -> 2026-08-27
//   resultado  = 2026-08-27 08:37 America/Bogota (misma hora, un día antes)
//
// Aritmética en milisegundos UTC (Date.parse con sufijo 'T00:00:00Z',
// NUNCA Date#setFullYear/local) -- el delta de calendario es el mismo
// número de milisegundos sin importar timezone (América/Bogotá no tiene
// DST, así que un delta de N días de calendario es exactamente N*86400000
// ms, sin ambigüedad ni salto de huso horario).
//
// Esta MISMA función se usa para sincronizar, en la misma transacción
// (FASE A'):
//   1. el timestamp OPERACIONAL de agx.potrero_ciclos_pastoreo
//      (ingreso_real_at/salida_real_at, UPDATE-able desde 0014), y
//   2. el timestamp CONGELADO de la nueva versión del snapshot
//      (agx.potrero_ciclo_lote_real_versiones.ingreso_real_at/salida_real_at)
// -- ambos reciben EXACTAMENTE el mismo valor calculado una sola vez, por
// lo que nunca pueden divergir (ver corregirCicloPastoreo más abajo).
// Corregir ingreso_real_at SIEMPRE re-resuelve ficha_id_base_real (la
// evidencia elegible puede cambiar con el ingreso); corregir
// salida_real_at nunca lo hace (la base real se fija al ingreso, no a la
// salida).
// =========================================================================
function shiftTimestampPorDeltaFechas(timestampOriginal, fechaAnteriorIso, fechaNuevaIso) {
  const deltaMs = Date.parse(`${fechaNuevaIso}T00:00:00Z`) - Date.parse(`${fechaAnteriorIso}T00:00:00Z`);
  return new Date(new Date(timestampOriginal).getTime() + deltaMs);
}

function sameInstant(a, b) {
  const aMs = a === null || a === undefined ? null : new Date(a).getTime();
  const bMs = b === null || b === undefined ? null : new Date(b).getTime();
  return aMs === bMs;
}

export async function corregirCicloPastoreo(organizacionId, predioId, potreroId, cicloId, {
  fechaIngresoReal, fechaSalidaReal, categoriaCodigo, numeroAnimales, pesoPromedioKg,
  produccionLecheLDia, diasEnLeche, grasaLechePct, terneroAlPie,
  motivo, actorCuentaId, now, climatologyFetchImpl,
} = {}) {
  assertPredioIdFormat(predioId);
  assertPotreroIdFormat(potreroId);

  const motivoLimpio = typeof motivo === 'string' ? motivo.trim() : '';
  if (motivoLimpio === '') {
    throw semanticError('INVALID_MOTIVO_CORRECCION', 400, 'motivo es obligatorio para corregir un ciclo.');
  }

  const algunCampoSolicitado = [
    fechaIngresoReal, fechaSalidaReal, categoriaCodigo, numeroAnimales, pesoPromedioKg,
    produccionLecheLDia, diasEnLeche, grasaLechePct, terneroAlPie,
  ].some((valor) => valor !== undefined);
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
  if (produccionLecheLDia !== undefined && produccionLecheLDia !== null && !Number.isFinite(produccionLecheLDia)) {
    throw semanticError('INVALID_PRODUCCION_LECHE_REAL', 400, 'produccionLecheLDia debe ser numérico.');
  }
  if (diasEnLeche !== undefined && diasEnLeche !== null && !Number.isFinite(diasEnLeche)) {
    throw semanticError('INVALID_DIAS_EN_LECHE_REAL', 400, 'diasEnLeche debe ser numérico.');
  }
  if (grasaLechePct !== undefined && grasaLechePct !== null && !Number.isFinite(grasaLechePct)) {
    throw semanticError('INVALID_GRASA_LECHE_REAL', 400, 'grasaLechePct debe ser numérico.');
  }
  if (terneroAlPie !== undefined && terneroAlPie !== null && typeof terneroAlPie !== 'boolean') {
    throw semanticError('INVALID_TERNERO_AL_PIE_REAL', 400, 'terneroAlPie debe ser verdadero o falso.');
  }

  // Legacy (ciclos SIN snapshot -- comportamiento 3D9.2 intacto): solo
  // fecha dispara regeneración, porque categoría/numeroAnimales/peso
  // nunca alimentaban el motor de descanso PLAN.
  const debeRegenerarDescansoLegacy = fechaIngresoReal !== undefined || fechaSalidaReal !== undefined;

  const { ciclo, huboCambios, huboCambiosSnapshot } = await withOrganizacionTransaction(organizacionId, async (client) => {
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

    // SPRINT-3D9.3 FINAL IMPLEMENTATION GATE, punto 1 -- fuente única de
    // verdad: si el ciclo tiene snapshot vigente, categoría/numeroAnimales/
    // pesoPromedioKg/fechas NUNCA se corrigen como UPDATE científico
    // independiente -- el UPDATE de abajo sobre potrero_ciclos_pastoreo
    // pasa a ser exclusivamente el espejo de sincronización de la nueva
    // versión del snapshot (mismo valor, mismo motivo, misma transacción).
    const vigenteSnapshot = await fetchSnapshotLoteRealVigente(client, cicloId);

    let huboCambiosSnapshotLocal = false;
    let ingresoRealAtEfectivo = vigenteSnapshot ? vigenteSnapshot.ingresoRealAt : null;
    let salidaRealAtEfectivo = vigenteSnapshot ? vigenteSnapshot.salidaRealAt : null;
    let fichaIdBaseRealEfectiva = vigenteSnapshot ? vigenteSnapshot.fichaIdBaseReal : null;

    if (vigenteSnapshot) {
      const categoriaIdEfectiva = categoriaAjustadaId !== undefined ? String(categoriaAjustadaId) : vigenteSnapshot.categoriaId;
      const numeroAnimalesEfectivo = numeroAnimales !== undefined ? numeroAnimales : vigenteSnapshot.numeroAnimales;
      const pesoPromedioEfectivo = pesoPromedioKg !== undefined ? pesoPromedioKg : vigenteSnapshot.pesoPromedioKg;
      const produccionLecheEfectiva = produccionLecheLDia !== undefined ? produccionLecheLDia : vigenteSnapshot.produccionLecheLDia;
      const diasEnLecheEfectivo = diasEnLeche !== undefined ? diasEnLeche : vigenteSnapshot.diasEnLeche;
      const grasaLecheEfectiva = grasaLechePct !== undefined ? grasaLechePct : vigenteSnapshot.grasaLechePct;
      const terneroAlPieEfectivo = terneroAlPie !== undefined ? terneroAlPie : vigenteSnapshot.terneroAlPie;

      if (fechaIngresoReal !== undefined && fechaIngresoReal !== cicloActual.fecha_ingreso_real) {
        ingresoRealAtEfectivo = shiftTimestampPorDeltaFechas(vigenteSnapshot.ingresoRealAt, cicloActual.fecha_ingreso_real, fechaIngresoReal);
        // El ingreso cambió -> la evidencia elegible como base real puede
        // cambiar -- SIEMPRE se re-resuelve, nunca se conserva a ciegas.
        fichaIdBaseRealEfectiva = await resolveFichaIdBaseReal(client, { potreroId, ingresoRealAt: ingresoRealAtEfectivo });
      }
      if (fechaSalidaReal !== undefined && fechaSalidaReal !== cicloActual.fecha_salida_real && vigenteSnapshot.salidaRealAt) {
        salidaRealAtEfectivo = shiftTimestampPorDeltaFechas(vigenteSnapshot.salidaRealAt, cicloActual.fecha_salida_real, fechaSalidaReal);
      }

      huboCambiosSnapshotLocal = (
        categoriaIdEfectiva !== vigenteSnapshot.categoriaId
        || numeroAnimalesEfectivo !== vigenteSnapshot.numeroAnimales
        || pesoPromedioEfectivo !== vigenteSnapshot.pesoPromedioKg
        || produccionLecheEfectiva !== vigenteSnapshot.produccionLecheLDia
        || diasEnLecheEfectivo !== vigenteSnapshot.diasEnLeche
        || grasaLecheEfectiva !== vigenteSnapshot.grasaLechePct
        || terneroAlPieEfectivo !== vigenteSnapshot.terneroAlPie
        || !sameInstant(ingresoRealAtEfectivo, vigenteSnapshot.ingresoRealAt)
        || !sameInstant(salidaRealAtEfectivo, vigenteSnapshot.salidaRealAt)
        || String(fichaIdBaseRealEfectiva) !== String(vigenteSnapshot.fichaIdBaseReal)
      );

      if (huboCambiosSnapshotLocal) {
        await crearSnapshotLoteReal(client, {
          organizacionId, predioId, potreroId, cicloId, version: vigenteSnapshot.version + 1,
          categoriaId: categoriaIdEfectiva, numeroAnimales: numeroAnimalesEfectivo, pesoPromedioKg: pesoPromedioEfectivo,
          produccionLecheLDia: produccionLecheEfectiva, diasEnLeche: diasEnLecheEfectivo, grasaLechePct: grasaLecheEfectiva,
          terneroAlPie: terneroAlPieEfectivo, fichaIdBaseReal: fichaIdBaseRealEfectiva,
          ingresoRealAt: ingresoRealAtEfectivo, salidaRealAt: salidaRealAtEfectivo, actorCuentaId,
        });
        await invalidarSnapshotLoteReal(client, {
          snapshotId: vigenteSnapshot.snapshotId, cicloId, potreroId, organizacionId, motivo: 'correccion_lote_real', actorCuentaId,
        });
      }
    }

    if (cambios.length === 0 && !huboCambiosSnapshotLocal) {
      // Idempotente: retry con el mismo payload ya aplicado -- sin
      // evento nuevo, sin invalidar nada. El llamador igual intenta
      // FASE B' más abajo (mismo criterio que finalizar/FASE B).
      return { ciclo: cicloActual, huboCambios: false, huboCambiosSnapshot: false };
    }

    // UPDATE del ciclo -- para un ciclo CON snapshot, este UPDATE es
    // EXCLUSIVAMENTE el espejo de sincronización (mismos valores que la
    // nueva versión del snapshot recién creada arriba), nunca un segundo
    // camino de corrección independiente.
    const actualizado = await client.query(
      `update agx.potrero_ciclos_pastoreo
          set fecha_ingreso_real = $1, fecha_salida_real = $2, categoria_id = $3,
              numero_animales_real = $4, peso_promedio_real_kg = $5,
              ingreso_real_at = $6, salida_real_at = $7
        where ciclo_id = $8
        returning ${CICLO_SELECT}`,
      [
        fechaIngresoReal !== undefined ? fechaIngresoReal : cicloActual.fecha_ingreso_real,
        fechaSalidaReal !== undefined ? fechaSalidaReal : cicloActual.fecha_salida_real,
        categoriaAjustadaId !== undefined ? categoriaAjustadaId : cicloActual.categoria_id,
        numeroAnimales !== undefined ? numeroAnimales : Number(cicloActual.numero_animales_real),
        pesoPromedioKg !== undefined ? pesoPromedioKg : Number(cicloActual.peso_promedio_real_kg),
        ingresoRealAtEfectivo ?? cicloActual.ingreso_real_at,
        salidaRealAtEfectivo ?? cicloActual.salida_real_at,
        cicloId,
      ],
    );
    const cicloCorregido = actualizado.rows[0];

    await insertEvento(client, {
      organizacionId, potreroId, cicloId, tipoEvento: 'PASTOREO_CORREGIDO', actorCuentaId, now,
      payload: { motivo: motivoLimpio, cambios },
    });

    const debeInvalidarDescanso = debeRegenerarDescansoLegacy || huboCambiosSnapshotLocal;
    if (debeInvalidarDescanso) {
      const vigenteDescanso = await fetchDescansoVigentePorCiclo(client, cicloId);
      if (vigenteDescanso) {
        await invalidarDescansoVersion(client, {
          descansoId: Number(vigenteDescanso.descansoId),
          cicloPastoreoId: cicloId,
          potreroId,
          organizacionId,
          motivo: 'correccion_lote_real',
          actorCuentaId,
        });
      }
    }

    return { ciclo: cicloCorregido, huboCambios: true, huboCambiosSnapshot: huboCambiosSnapshotLocal };
  });

  const debeRegenerarDescanso = debeRegenerarDescansoLegacy || huboCambiosSnapshot;
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
