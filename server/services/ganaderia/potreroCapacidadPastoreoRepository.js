// SPRINT-3D7-CAPACIDAD-PASTOREO: acceso a datos del cálculo de capacidad
// de pastoreo del potrero (agx.potrero_calculos_pastoreo, fundación en
// 0005_potrero_capacidad_pastoreo.sql) contra Postgres-AGX-Business.
// Mismo principio de separación router/repositorio que
// potreroFichaProductivaRepository.js.
//
// Regla de dominio: ORGANIZACIÓN -> PREDIO -> POTRERO -> FICHA
// PRODUCTIVA -> CÁLCULO DE CAPACIDAD DE PASTOREO. Regla de historial
// (§3/§5 del sprint): cada POST create crea una fila NUEVA -- nunca
// actualiza un cálculo existente.
//
// Regla de fuente autoritativa (§2/§22/§23 del sprint): la biomasa
// fresca SIEMPRE se resuelve aquí desde la ficha productiva más reciente
// del potrero (agx.potrero_fichas_productivas) -- el body del cliente
// nunca aporta biomasaFrescaKg/materiaSecaTotalKg/materiaSecaUtilizableKg/
// demandaDiariaLoteKgMs/diasOcupacionEstimados/capacidadAnimalesPeriodo/
// areaHa como valores autoritativos (ver validación del router).
import { withOrganizacionTransaction } from '../../db/agxBusinessPool.js';
import {
  computeCapacidadPastoreoModoDias,
  computeCapacidadPastoreoModoAnimales,
  isResultadoExtremo,
} from './capacidadPastoreoFormulas.js';

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

/**
 * Confirma que `potreroId` existe, pertenece a `predioId` y a la
 * organización activa (RLS + FORCE + filtro explícito por predio_id --
 * mismo criterio que assertPotreroBelongsToPredio en
 * potreroFichaProductivaRepository.js).
 */
async function assertPotreroBelongsToPredio(client, predioId, potreroId) {
  const result = await client.query(
    'select potrero_id from agx.potreros where potrero_id = $1 and predio_id = $2',
    [potreroId, predioId],
  );
  if (result.rows.length === 0) {
    throw semanticError('POTRERO_NOT_FOUND', 404, 'El potrero no existe, no pertenece a este predio o no pertenece a tu organización.');
  }
  return result.rows[0];
}

/**
 * Ficha productiva más reciente del potrero (§23 del sprint: "Por
 * defecto utilizar la ficha productiva más reciente"). Lanza
 * FICHA_NOT_FOUND si el potrero todavía no tiene ninguna ficha
 * registrada (§26 del sprint: sin ficha, no se permite el cálculo).
 * Nunca mezcla datos de distintas fichas (§23) -- una sola fila resuelta
 * aquí, biomasaFrescaKg siempre sale de esta ficha, jamás del body.
 */
async function fetchFichaMasReciente(client, potreroId) {
  const result = await client.query(
    `select ficha_id, biomasa_total_kg, aforo_promedio_g_m2,
            to_char(fecha_aforo, 'YYYY-MM-DD') as fecha_aforo, created_at
       from agx.potrero_fichas_productivas
      where potrero_id = $1
      order by created_at desc
      limit 1`,
    [potreroId],
  );
  if (result.rows.length === 0) {
    throw semanticError(
      'FICHA_NOT_FOUND',
      404,
      'Primero registra una ficha productiva con un aforo del potrero.',
    );
  }
  return result.rows[0];
}

function serializeFichaRef(fichaRow) {
  return {
    fichaId: String(fichaRow.ficha_id),
    biomasaFrescaKg: Number(fichaRow.biomasa_total_kg),
    aforoPromedioGM2: Number(fichaRow.aforo_promedio_g_m2),
    fechaAforo: fichaRow.fecha_aforo,
    fichaCreatedAt: fichaRow.created_at,
  };
}

/**
 * Ejecuta la fórmula correspondiente al modo -- única fuente de verdad
 * de cálculo, compartida entre preview y create (§21/§22 del sprint:
 * ambos endpoints recalculan server-side, nunca confían en el body).
 */
function computeResultado(modo, fichaRow, params) {
  const biomasaFrescaKg = Number(fichaRow.biomasa_total_kg);
  if (modo === 'dias_ocupacion') {
    return computeCapacidadPastoreoModoDias({
      biomasaFrescaKg,
      porcentajeMateriaSeca: params.porcentajeMateriaSeca,
      porcentajeUtilizacion: params.porcentajeUtilizacion,
      consumoPctPesoVivo: params.consumoPctPesoVivo,
      pesoVivoPromedioKg: params.pesoVivoPromedioKg,
      numeroAnimales: params.numeroAnimales,
    });
  }
  return computeCapacidadPastoreoModoAnimales({
    biomasaFrescaKg,
    porcentajeMateriaSeca: params.porcentajeMateriaSeca,
    porcentajeUtilizacion: params.porcentajeUtilizacion,
    consumoPctPesoVivo: params.consumoPctPesoVivo,
    pesoVivoPromedioKg: params.pesoVivoPromedioKg,
    periodoObjetivoDias: params.periodoObjetivoDias,
  });
}

function buildResponsePayload(modo, params, fichaRow, resultado) {
  return {
    modo,
    ficha: serializeFichaRef(fichaRow),
    parametros: {
      numeroAnimales: params.numeroAnimales ?? null,
      pesoVivoPromedioKg: params.pesoVivoPromedioKg,
      periodoObjetivoDias: params.periodoObjetivoDias ?? null,
      porcentajeMateriaSeca: params.porcentajeMateriaSeca,
      porcentajeUtilizacion: params.porcentajeUtilizacion,
      consumoPctPesoVivo: params.consumoPctPesoVivo,
    },
    resultado: {
      materiaSecaTotalKg: resultado.materiaSecaTotalKg,
      materiaSecaUtilizableKg: resultado.materiaSecaUtilizableKg,
      demandaIndividualKgMsDia: resultado.demandaIndividualKgMsDia,
      demandaDiariaLoteKgMs: resultado.demandaDiariaLoteKgMs,
      diasOcupacionEstimados: resultado.diasOcupacionEstimados,
      capacidadAnimalesPeriodo: resultado.capacidadAnimalesPeriodo,
      capacidadAnimalesDecimal: resultado.capacidadAnimalesDecimal ?? null,
    },
    resultadoExtremo: isResultadoExtremo(modo, resultado),
  };
}

/**
 * Preview (§21/§22 del sprint): calcula server-side sobre la ficha real,
 * NUNCA persiste. Frontend usa esto para respuesta inmediata sin crear
 * histórico por cada tecla.
 */
export async function previewCapacidadPastoreo(organizacionId, predioId, potreroId, { modo, ...params }) {
  assertPredioIdFormat(predioId);
  assertPotreroIdFormat(potreroId);

  return withOrganizacionTransaction(organizacionId, async (client) => {
    await assertPotreroBelongsToPredio(client, predioId, potreroId);
    const fichaRow = await fetchFichaMasReciente(client, potreroId);
    const resultado = computeResultado(modo, fichaRow, params);
    return buildResponsePayload(modo, params, fichaRow, resultado);
  });
}

function serializeCalculoRow(row) {
  return {
    calculoId: String(row.calculo_id),
    modo: row.modo,
    fichaId: String(row.ficha_id),
    fichaFechaAforo: row.ficha_fecha_aforo ?? null,
    fichaBiomasaFrescaKg: row.ficha_biomasa_total_kg === undefined || row.ficha_biomasa_total_kg === null
      ? null
      : Number(row.ficha_biomasa_total_kg),
    numeroAnimales: row.numero_animales === null ? null : Number(row.numero_animales),
    pesoVivoPromedioKg: row.peso_vivo_promedio_kg === null ? null : Number(row.peso_vivo_promedio_kg),
    periodoObjetivoDias: row.periodo_objetivo_dias === null ? null : Number(row.periodo_objetivo_dias),
    porcentajeMateriaSeca: Number(row.porcentaje_materia_seca),
    porcentajeUtilizacion: Number(row.porcentaje_utilizacion),
    consumoPctPesoVivo: Number(row.consumo_pct_peso_vivo),
    materiaSecaTotalKg: Number(row.materia_seca_total_kg),
    materiaSecaUtilizableKg: Number(row.materia_seca_utilizable_kg),
    demandaDiariaLoteKgMs: row.demanda_diaria_lote_kg_ms === null ? null : Number(row.demanda_diaria_lote_kg_ms),
    diasOcupacionEstimados: row.dias_ocupacion_estimados === null ? null : Number(row.dias_ocupacion_estimados),
    capacidadAnimalesPeriodo: row.capacidad_animales_periodo === null ? null : Number(row.capacidad_animales_periodo),
    observaciones: row.observaciones ?? null,
    createdAt: row.created_at,
    resultadoExtremo: isResultadoExtremo(row.modo, {
      diasOcupacionEstimados: row.dias_ocupacion_estimados === null ? null : Number(row.dias_ocupacion_estimados),
      capacidadAnimalesPeriodo: row.capacidad_animales_periodo === null ? null : Number(row.capacidad_animales_periodo),
    }),
  };
}

/**
 * Create (§21/§22 del sprint): recalcula server-side (NUNCA confía en
 * resultados enviados por el cliente) y persiste una fila nueva,
 * histórica (§3/§5 -- nunca sobrescribe un cálculo previo).
 */
export async function createCapacidadPastoreo(organizacionId, predioId, potreroId, { modo, observaciones, ...params }) {
  assertPredioIdFormat(predioId);
  assertPotreroIdFormat(potreroId);

  return withOrganizacionTransaction(organizacionId, async (client) => {
    await assertPotreroBelongsToPredio(client, predioId, potreroId);
    const fichaRow = await fetchFichaMasReciente(client, potreroId);
    const resultado = computeResultado(modo, fichaRow, params);

    const insertResult = await client.query(
      `insert into agx.potrero_calculos_pastoreo
         (organizacion_id, predio_id, potrero_id, ficha_id, modo,
          numero_animales, peso_vivo_promedio_kg, periodo_objetivo_dias,
          porcentaje_materia_seca, porcentaje_utilizacion, consumo_pct_peso_vivo,
          materia_seca_total_kg, materia_seca_utilizable_kg,
          demanda_diaria_lote_kg_ms, dias_ocupacion_estimados, capacidad_animales_periodo,
          observaciones)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
       returning calculo_id, modo, ficha_id, numero_animales, peso_vivo_promedio_kg,
                 periodo_objetivo_dias, porcentaje_materia_seca, porcentaje_utilizacion,
                 consumo_pct_peso_vivo, materia_seca_total_kg, materia_seca_utilizable_kg,
                 demanda_diaria_lote_kg_ms, dias_ocupacion_estimados, capacidad_animales_periodo,
                 observaciones, created_at`,
      [
        organizacionId,
        predioId,
        potreroId,
        fichaRow.ficha_id,
        modo,
        params.numeroAnimales ?? null,
        params.pesoVivoPromedioKg,
        params.periodoObjetivoDias ?? null,
        params.porcentajeMateriaSeca,
        params.porcentajeUtilizacion,
        params.consumoPctPesoVivo,
        resultado.materiaSecaTotalKg,
        resultado.materiaSecaUtilizableKg,
        resultado.demandaDiariaLoteKgMs,
        resultado.diasOcupacionEstimados,
        resultado.capacidadAnimalesPeriodo,
        observaciones ?? null,
      ],
    );

    const row = insertResult.rows[0];
    return {
      ...serializeCalculoRow({
        ...row,
        ficha_fecha_aforo: fichaRow.fecha_aforo,
        ficha_biomasa_total_kg: fichaRow.biomasa_total_kg,
      }),
      ficha: serializeFichaRef(fichaRow),
    };
  });
}

/**
 * Cálculo más reciente + historial resumido de un potrero (§21/§27 del
 * sprint). Devuelve { actual: null, historial: [] } si el potrero todavía
 * no tiene ningún cálculo registrado -- nunca 404 en ese caso (el
 * potrero sí existe, y un potrero puede tener ficha sin tener todavía
 * ningún cálculo de capacidad).
 */
export async function getCapacidadPastoreoByPotrero(organizacionId, predioId, potreroId) {
  assertPredioIdFormat(predioId);
  assertPotreroIdFormat(potreroId);

  return withOrganizacionTransaction(organizacionId, async (client) => {
    await assertPotreroBelongsToPredio(client, predioId, potreroId);

    const result = await client.query(
      `select c.calculo_id, c.modo, c.ficha_id, c.numero_animales, c.peso_vivo_promedio_kg,
              c.periodo_objetivo_dias, c.porcentaje_materia_seca, c.porcentaje_utilizacion,
              c.consumo_pct_peso_vivo, c.materia_seca_total_kg, c.materia_seca_utilizable_kg,
              c.demanda_diaria_lote_kg_ms, c.dias_ocupacion_estimados, c.capacidad_animales_periodo,
              c.observaciones, c.created_at,
              to_char(f.fecha_aforo, 'YYYY-MM-DD') as ficha_fecha_aforo,
              f.biomasa_total_kg as ficha_biomasa_total_kg
         from agx.potrero_calculos_pastoreo c
         left join agx.potrero_fichas_productivas f on f.ficha_id = c.ficha_id
        where c.potrero_id = $1
        order by c.created_at desc`,
      [potreroId],
    );

    if (result.rows.length === 0) {
      return { actual: null, historial: [] };
    }

    const [actualRow, ...historialRows] = result.rows;
    return {
      actual: serializeCalculoRow(actualRow),
      historial: historialRows.map(serializeCalculoRow),
    };
  });
}
