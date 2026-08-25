// SPRINT-3D7.1-AGROCLIMA: acceso a datos del contexto agroclimático del
// potrero (agx.potrero_contextos_agroclimaticos, fundación en
// 0006_potrero_contexto_agroclimatico.sql) contra Postgres-AGX-Business.
// Mismo patrón router/repositorio que potreroCapacidadPastoreoRepository.js.
//
// Regla de dominio: ORGANIZACIÓN -> PREDIO -> POTRERO -> CONTEXTO
// AGROCLIMÁTICO. Regla de historial (§9 del sprint): cada refresh crea
// una fila NUEVA -- nunca actualiza un snapshot existente.
//
// Regla de fuente autoritativa (§1/§12 del sprint): lat/lng SIEMPRE se
// resuelven aquí desde ST_PointOnSurface(agx.potreros.geometry) -- el
// cliente NUNCA aporta coordenadas.
import { withOrganizacionTransaction } from '../../db/agxBusinessPool.js';
import { refreshAgroClimateContext } from './agroClimate/agroClimateOrchestrator.js';
import { AGRO_CLIMATE_STATUS } from './agroClimate/agroClimateObservation.js';

const HISTORIAL_LIMIT = 10;

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
 * organización activa (RLS + FORCE + filtro explícito por predio_id),
 * y resuelve su punto representativo server-side -- ST_PointOnSurface
 * garantiza un punto DENTRO del polígono (a diferencia de ST_Centroid,
 * que puede caer fuera en polígonos cóncavos) -- §1 del sprint.
 */
async function resolvePotreroPoint(client, predioId, potreroId) {
  const result = await client.query(
    `select potrero_id,
            ST_Y(ST_PointOnSurface(geometry)) as lat,
            ST_X(ST_PointOnSurface(geometry)) as lng
       from agx.potreros
      where potrero_id = $1 and predio_id = $2`,
    [potreroId, predioId],
  );
  if (result.rows.length === 0) {
    throw semanticError('POTRERO_NOT_FOUND', 404, 'El potrero no existe, no pertenece a este predio o no pertenece a tu organización.');
  }
  return { lat: Number(result.rows[0].lat), lng: Number(result.rows[0].lng) };
}

function serializeSnapshotRow(row) {
  return {
    contextoId: String(row.contexto_id),
    fechaReferencia: row.fecha_referencia,
    precipitacion24hMm: row.precipitacion_24h_mm === null ? null : Number(row.precipitacion_24h_mm),
    precipitacion7dMm: row.precipitacion_7d_mm === null ? null : Number(row.precipitacion_7d_mm),
    precipitacion15dMm: row.precipitacion_15d_mm === null ? null : Number(row.precipitacion_15d_mm),
    precipitacion30dMm: row.precipitacion_30d_mm === null ? null : Number(row.precipitacion_30d_mm),
    temperaturaMediaC: row.temperatura_media_c === null ? null : Number(row.temperatura_media_c),
    temperaturaMinC: row.temperatura_min_c === null ? null : Number(row.temperatura_min_c),
    temperaturaMaxC: row.temperatura_max_c === null ? null : Number(row.temperatura_max_c),
    humedadRelativaMediaPct: row.humedad_relativa_media_pct === null ? null : Number(row.humedad_relativa_media_pct),
    humedadSueloSuperficial: row.humedad_suelo_superficial === null ? null : Number(row.humedad_suelo_superficial),
    humedadSueloSubsuperficial: row.humedad_suelo_subsuperficial === null ? null : Number(row.humedad_suelo_subsuperficial),
    radiacionSolar: row.radiacion_solar === null ? null : Number(row.radiacion_solar),
    vientoMedioMs: row.viento_medio_ms === null ? null : Number(row.viento_medio_ms),
    sourceObservedUntil: row.source_observed_until,
    fuentePrincipal: row.fuente_principal,
    calidad: row.calidad,
    fuentes: row.fuentes_json,
    createdAt: row.created_at,
  };
}

const SNAPSHOT_COLUMNS = `contexto_id, fecha_referencia, precipitacion_24h_mm, precipitacion_7d_mm,
       precipitacion_15d_mm, precipitacion_30d_mm, temperatura_media_c, temperatura_min_c,
       temperatura_max_c, humedad_relativa_media_pct, humedad_suelo_superficial,
       humedad_suelo_subsuperficial, radiacion_solar, viento_medio_ms, source_observed_until,
       fuente_principal, calidad, fuentes_json, created_at`;

/**
 * Snapshot más reciente + historial resumido (§9/§12 del sprint). Sin
 * snapshots todavía -> 200 con { actual: null, historial: [] }, nunca
 * 404 (el potrero sí existe). §13 del sprint: SIEMPRE lee de DB -- nunca
 * consulta proveedores externos (eso es exclusivo de refresh()).
 */
export async function getContextoAgroclimatico(organizacionId, predioId, potreroId) {
  assertPredioIdFormat(predioId);
  assertPotreroIdFormat(potreroId);

  return withOrganizacionTransaction(organizacionId, async (client) => {
    await resolvePotreroPoint(client, predioId, potreroId);

    const result = await client.query(
      `select ${SNAPSHOT_COLUMNS}
         from agx.potrero_contextos_agroclimaticos
        where potrero_id = $1
        order by created_at desc
        limit $2`,
      [potreroId, HISTORIAL_LIMIT + 1],
    );

    if (result.rows.length === 0) {
      return { actual: null, historial: [] };
    }

    const [actualRow, ...historialRows] = result.rows;
    return {
      actual: serializeSnapshotRow(actualRow),
      historial: historialRows.map(serializeSnapshotRow),
    };
  });
}

/**
 * Refresh (§12/§13/§15 del sprint): resuelve geometry server-side,
 * consulta proveedores (fuera de la transacción de DB -- llamadas de red
 * lentas nunca deben mantener una conexión de Postgres abierta), y
 * persiste un snapshot NUEVO solo si hay al menos un dato usable
 * (COMPLETE/PARTIAL). UNAVAILABLE nunca se persiste -- no tiene sentido
 * guardar una fila histórica sin ningún dato real (§15: "no convertir
 * fallo externo en error que rompa la ficha del potrero" -- SÍ se
 * responde 200 con status UNAVAILABLE, solo no se persiste snapshot).
 */
export async function refreshContextoAgroclimatico(organizacionId, predioId, potreroId, { fetchImpl } = {}) {
  assertPredioIdFormat(predioId);
  assertPotreroIdFormat(potreroId);

  const { lat, lng } = await withOrganizacionTransaction(
    organizacionId,
    (client) => resolvePotreroPoint(client, predioId, potreroId),
  );

  const { status, snapshot, fuentesJson } = await refreshAgroClimateContext({ lat, lng, fetchImpl });

  if (status === AGRO_CLIMATE_STATUS.UNAVAILABLE) {
    return { status, snapshot: null, fuentes: fuentesJson };
  }

  const persisted = await withOrganizacionTransaction(organizacionId, async (client) => {
    // Reconfirma pertenencia dentro de la misma transacción de escritura
    // -- el potrero pudo, en teoría, dejar de existir entre la resolución
    // del punto y este insert (ventana muy pequeña, pero la FK compuesta
    // ya lo protegería a nivel físico; esta consulta solo produce el
    // mismo error semántico 404 en vez de un 500 de FK).
    await resolvePotreroPoint(client, predioId, potreroId);

    const insertResult = await client.query(
      `insert into agx.potrero_contextos_agroclimaticos
         (organizacion_id, predio_id, potrero_id, fecha_referencia,
          precipitacion_24h_mm, precipitacion_7d_mm, precipitacion_15d_mm, precipitacion_30d_mm,
          temperatura_media_c, temperatura_min_c, temperatura_max_c, humedad_relativa_media_pct,
          humedad_suelo_superficial, humedad_suelo_subsuperficial, radiacion_solar, viento_medio_ms,
          source_observed_until, fuente_principal, calidad, fuentes_json)
       values ($1, $2, $3, current_date, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
       returning ${SNAPSHOT_COLUMNS}`,
      [
        organizacionId, predioId, potreroId,
        snapshot.precipitacion24hMm, snapshot.precipitacion7dMm, snapshot.precipitacion15dMm, snapshot.precipitacion30dMm,
        snapshot.temperaturaMediaC, snapshot.temperaturaMinC, snapshot.temperaturaMaxC, snapshot.humedadRelativaMediaPct,
        snapshot.humedadSueloSuperficial, snapshot.humedadSueloSubsuperficial, snapshot.radiacionSolar, snapshot.vientoMedioMs,
        snapshot.sourceObservedUntil, snapshot.fuentePrincipal, snapshot.calidad, JSON.stringify(fuentesJson),
      ],
    );
    return serializeSnapshotRow(insertResult.rows[0]);
  });

  return { status, snapshot: persisted, fuentes: fuentesJson };
}
