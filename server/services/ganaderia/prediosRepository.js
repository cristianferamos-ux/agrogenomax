// SPRINT-3C1-MIS-PREDIOS-API: acceso a datos de "Mis Predios" contra
// Postgres-AGX-Business, aislado del router (server/routes/ganaderiaPredios.js)
// para poder probarse directamente contra un Postgres/PostGIS real vía
// withOrganizacionTransaction, sin necesitar el stack HTTP/sesión
// completo -- mismo principio de separación ya usado en
// server/services/catastrox/paymentOrderRepository.js.
//
// Todas las funciones reciben `organizacionId` ya autorizado por el
// llamador (nunca lo validan ni lo derivan) y operan dentro de una
// withOrganizacionTransaction ya abierta -- confían en RLS+FORCE
// (0001_business_foundation.sql) como el único mecanismo de aislamiento,
// sin filtros WHERE organizacion_id redundantes.
import { withOrganizacionTransaction } from '../../db/agxBusinessPool.js';

// SPRINT-3D9.2 (PRE-COMMIT FINAL ROUND, punto 3): por defecto solo se
// listan predios ACTIVO -- un predio ARCHIVADO nunca aparece en la
// operación normal. `incluirArchivados` es el único mecanismo explícito
// de opt-in (usado por la vista "Ver archivados"); nunca se infiere de
// otro parámetro ni se activa implícitamente.
export async function listPredios(organizacionId, { incluirArchivados = false } = {}) {
  return withOrganizacionTransaction(organizacionId, async (client) => {
    const result = await client.query(
      `select predio_id, nombre_predio, departamento, municipio, vereda,
              area_total_ha, observaciones, codigo_predial, latitud, longitud,
              (geometry is not null) as tiene_geometria, fecha_creacion,
              estado
         from agx.predios
        ${incluirArchivados ? '' : "where estado = 'ACTIVO'"}
        order by fecha_creacion desc`,
    );
    return result.rows;
  });
}

export async function getPredioDetail(organizacionId, predioId) {
  return withOrganizacionTransaction(organizacionId, async (client) => {
    // RLS (FORCE) filtra automáticamente cualquier predio_id que no
    // pertenezca a app.current_org_id -- una fila de otra organización
    // produce 0 filas aquí, indistinguible de "no existe" (§4).
    const predioResult = await client.query(
      `select predio_id, nombre_predio, propietario, departamento, municipio, vereda,
              area_total_ha, observaciones, latitud, longitud, codigo_predial,
              ST_AsGeoJSON(geometry)::json as geometry,
              fecha_creacion, fecha_actualizacion
         from agx.predios
        where predio_id = $1`,
      [predioId],
    );

    const predioRow = predioResult.rows[0];
    if (!predioRow) return null;

    const snapshotResult = await client.query(
      `select codigo_predial, codigo_anterior, nombre_predio_catastral,
              departamento, municipio, vereda, sector, area_m2, area_ha,
              ST_AsGeoJSON(geometry)::json as geometry,
              fuente, version_fuente, fecha_consulta
         from agx.predio_snapshots_catastrales
        where predio_id = $1
        order by fecha_creacion desc
        limit 1`,
      [predioId],
    );

    return { predioRow, snapshotRow: snapshotResult.rows[0] || null };
  });
}

export async function createManualPredio(organizacionId, value) {
  return withOrganizacionTransaction(organizacionId, async (client) => {
    const result = await client.query(
      `insert into agx.predios
         (organizacion_id, nombre_predio, departamento, municipio, vereda, area_total_ha, observaciones, latitud, longitud, codigo_predial)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, null)
       returning predio_id`,
      [
        organizacionId,
        value.nombrePredio,
        value.departamento,
        value.municipio,
        value.vereda,
        value.areaDeclaradaHa,
        value.observaciones,
        value.latitud,
        value.longitud,
      ],
    );
    return result.rows[0].predio_id;
  });
}

function translateDuplicateCodigoPredial(error) {
  if (error?.code === '23505') {
    const duplicateError = new Error('DUPLICATE_CODIGO_PREDIAL');
    duplicateError.status = 409;
    duplicateError.code = 'DUPLICATE_CODIGO_PREDIAL';
    throw duplicateError;
  }
  throw error;
}

/**
 * §12/§13/§14/§18 + SPRINT-3C2.5 §10/§11: crea predio + snapshot en UNA
 * sola transacción de negocio -- si el INSERT del snapshot falla, el
 * INSERT del predio se revierte (withOrganizacionTransaction hace
 * ROLLBACK ante cualquier excepción). `predio` es el resultado YA
 * hidratado y validado del candidate store (nunca datos crudos del body
 * del cliente) -- geometry/codigoPredial/areaCatastral(Ha|M2)/fuente
 * vienen exclusivamente de ahí. `geometryJson` es el mismo GeoJSON serializado
 * una sola vez por el llamador, reutilizado para predio y snapshot.
 *
 * SPRINT-3C2.5 §10 (regla explícita): `areaDeclaradaHa`/`observaciones`
 * vienen del CLIENTE (body validado por el router), nunca se auto-rellena
 * area_total_ha con predio.areaCatastralHa -- si el cliente no envía un
 * valor, area_total_ha/observaciones quedan null.
 *
 * SPRINT-3C2.6 §2 (defensa en profundidad, mismo patrón ya usado para
 * version_fuente en 3C2.5 §11): el snapshot.sector se hardcodea a `null`
 * aquí -- NUNCA se lee predio.sector, aunque ese campo ya sea `null` en
 * origen (catastroxPredioLookup.js). Así, incluso si una futura
 * modificación de buildNormalizedPredio() reintrodujera por error un
 * código técnico en `predio.sector`, este INSERT seguiría sin poder
 * persistirlo como campo descriptivo. Los códigos técnicos crudos
 * (predio.sectorCodigoTecnico/predio.veredaCodigoTecnico) se preservan
 * únicamente en snapshot.atributos_json -- nunca en snapshot.sector ni en
 * ninguna columna descriptiva de agx.predios (que ni siquiera tiene
 * columna `sector`).
 */
export async function createCatastroxPredio(organizacionId, { nombreFinal, predio, geometryJson, areaDeclaradaHa = null, observaciones = null }) {
  return withOrganizacionTransaction(organizacionId, async (client) => {
    // SPRINT-3C1.1 §8 (auditoría de la afirmación "ST_MakeValid ya era
    // estrategia auditada"): patrón EXACTO ya usado dos veces en
    // server/routes/catastrox.js --
    //   buildCleanCandidatesSql() (candidatos por punto):
    //     `case when ST_IsValid(p.geom) then p.geom else ST_MakeValid(p.geom) end`
    //   buildDeliveryPredioSql() (resolvePredioDataForDelivery, la MISMA
    //   función que produce `predio.geometry` que llega aquí vía el
    //   candidate):
    //     `case when ST_IsValid(p.geom) then p.geom else ST_MakeValid(p.geom) end`
    // Este INSERT reaplica el MISMO case/ST_IsValid/ST_MakeValid sobre la
    // geometry ya devuelta por resolvePredioDataForDelivery -- en la
    // práctica es un no-op defensivo (esa geometry ya pasó por esa misma
    // reparación al resolverse el candidate), nunca una transformación
    // nueva. No se introduce ST_Buffer(0), simplificación ni snap-to-grid
    // -- ninguno de los tres existe en este archivo ni en catastrox.js. La
    // geometry persistida es la misma exacta autorizada para delivery,
    // salvo esta única transformación ya existente y documentada.
    // geometry exclusivamente desde el candidate server-side, parametrizada
    // (nunca interpolada), SRID 4326, MultiPolygon forzado (§13).
    const predioResult = await client.query(
      `insert into agx.predios
         (organizacion_id, nombre_predio, departamento, municipio, vereda, area_total_ha, observaciones, codigo_predial, geometry)
       values (
         $1, $2, $3, $4, $5, $6, $7, $8,
         ST_Multi(ST_CollectionExtract(
           case
             when ST_IsValid(ST_SetSRID(ST_GeomFromGeoJSON($9), 4326))
             then ST_SetSRID(ST_GeomFromGeoJSON($9), 4326)
             else ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON($9), 4326))
           end,
           3
         ))
       )
       returning predio_id`,
      [organizacionId, nombreFinal, predio.departamento, predio.municipio, predio.vereda, areaDeclaradaHa, observaciones, predio.codigoPredial, geometryJson],
    );
    const newPredioId = predioResult.rows[0].predio_id;

    // SPRINT-3C2.6 §7: único lugar donde se preservan códigos técnicos
    // (sector_codigo/vereda_codigo) para trazabilidad -- nunca en una
    // columna descriptiva. atributos_json ya existe en el esquema desde
    // 0001 (nullable, sin usar hasta ahora); no se crea ninguna columna
    // nueva. Mismo patrón JSON.stringify + ::jsonb ya usado en
    // deliveryAttemptRepository.js.
    const atributosJson = JSON.stringify({
      sectorCodigoTecnico: predio.sectorCodigoTecnico ?? null,
      veredaCodigoTecnico: predio.veredaCodigoTecnico ?? null,
    });

    await client.query(
      `insert into agx.predio_snapshots_catastrales
         (predio_id, organizacion_id, codigo_predial, codigo_anterior, nombre_predio_catastral,
          departamento, municipio, vereda, sector, area_m2, area_ha, geometry, fuente, version_fuente, fecha_consulta, atributos_json)
       values (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
         ST_Multi(ST_CollectionExtract(
           case
             when ST_IsValid(ST_SetSRID(ST_GeomFromGeoJSON($12), 4326))
             then ST_SetSRID(ST_GeomFromGeoJSON($12), 4326)
             else ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON($12), 4326))
           end,
           3
         )),
         $13, $14, $15, $16::jsonb
       )`,
      [
        newPredioId,
        organizacionId,
        predio.codigoPredial,
        predio.codigoAnterior,
        predio.nombrePredio,
        predio.departamento,
        predio.municipio,
        predio.vereda,
        // SPRINT-3C2.6 §2: sector SIEMPRE null aquí (defensa en
        // profundidad -- ver comentario del JSDoc de esta función);
        // deliberadamente NO se lee predio.sector.
        null,
        predio.areaCatastralM2,
        predio.areaCatastralHa,
        geometryJson,
        predio.fuente,
        // SPRINT-3C2.5 §5/§11: version_fuente siempre null -- nunca se
        // deriva de CATASTROX_DATASET_VERSION ni se infiere de `fuente`.
        null,
        predio.fechaConsulta,
        atributosJson,
      ],
    );

    return newPredioId;
  }).catch(translateDuplicateCodigoPredial);
}
