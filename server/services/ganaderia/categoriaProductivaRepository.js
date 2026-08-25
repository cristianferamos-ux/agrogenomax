// SPRINT-3D7.2-RECOMENDACION-PASTOREO-AUTO: acceso de solo lectura al
// catálogo de categorías productivas (agx.catalogo_categorias_productivas,
// fundación en 0007_potrero_recomendacion_pastoreo.sql). Transversal a la
// organización activa (catálogo de sistema, §3 del sprint) -- mismo
// patrón que listCatalogoPasturas en potreroFichaProductivaRepository.js,
// pero SOLO lectura (v1 no implementa categorías personalizadas).
import { withOrganizacionTransaction } from '../../db/agxBusinessPool.js';

function semanticError(code, status, message) {
  return Object.assign(new Error(message || code), { status, code });
}

function serializeCategoriaRow(row) {
  return {
    categoriaId: String(row.categoria_id),
    codigo: row.codigo,
    nombre: row.nombre,
    grupoProductivo: row.grupo_productivo,
    descripcion: row.descripcion ?? null,
    consumoMsPctPvMin: Number(row.consumo_ms_pct_pv_min),
    consumoMsPctPvTipico: Number(row.consumo_ms_pct_pv_tipico),
    consumoMsPctPvMax: Number(row.consumo_ms_pct_pv_max),
    pesoMinReferenciaKg: row.peso_min_referencia_kg === null ? null : Number(row.peso_min_referencia_kg),
    pesoMaxReferenciaKg: row.peso_max_referencia_kg === null ? null : Number(row.peso_max_referencia_kg),
    requiereProduccionLeche: row.requiere_produccion_leche,
    requiereTerneroAlPie: row.requiere_ternero_al_pie,
    requiereEstadoFisiologico: row.requiere_estado_fisiologico,
    metadataTecnica: row.metadata_tecnica ?? {},
    // Hardening §1/§9: ADAPTED (ecuación NASEM/NRC simplificada a %PV) o
    // FALLBACK (sin tabla NASEM/NRC específica de la categoría -- p.ej.
    // receptoras) -- degrada el nivel de confianza cuando es FALLBACK, ver
    // resolveNivelConfianza en recomendacionPastoreoFormulas.js.
    fuenteTipo: row.metadata_tecnica?.fuente_tipo ?? null,
  };
}

const CATEGORIA_COLUMNS = `categoria_id, codigo, nombre, grupo_productivo, descripcion,
       consumo_ms_pct_pv_min, consumo_ms_pct_pv_tipico, consumo_ms_pct_pv_max,
       peso_min_referencia_kg, peso_max_referencia_kg,
       requiere_produccion_leche, requiere_ternero_al_pie, requiere_estado_fisiologico,
       metadata_tecnica`;

/**
 * Lista el catálogo de categorías activas visible para la organización
 * (v1: solo catálogo de sistema, organizacion_id NULL -- la policy de
 * lectura ya soporta un futuro personalizado sin cambios aquí).
 */
export async function listCategoriasProductivas(organizacionId) {
  return withOrganizacionTransaction(organizacionId, async (client) => {
    const result = await client.query(
      `select ${CATEGORIA_COLUMNS}
         from agx.catalogo_categorias_productivas
        where activo = true
        order by grupo_productivo asc, nombre asc`,
    );
    return result.rows.map(serializeCategoriaRow);
  });
}

/**
 * Resuelve una categoría por código dentro de una transacción ya abierta
 * (uso interno de potreroRecomendacionPastoreoRepository.js) -- lanza
 * NO_PRODUCTIVE_PROFILE si el código no existe/no está activo (§18 del
 * sprint).
 */
export async function fetchCategoriaByCodigo(client, categoriaCodigo) {
  const result = await client.query(
    `select ${CATEGORIA_COLUMNS}
       from agx.catalogo_categorias_productivas
      where codigo = $1 and activo = true`,
    [categoriaCodigo],
  );
  if (result.rows.length === 0) {
    throw semanticError('NO_PRODUCTIVE_PROFILE', 400, 'Selecciona una categoría productiva válida.');
  }
  return serializeCategoriaRow(result.rows[0]);
}
