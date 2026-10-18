// SPRINT-3D11.2: lectura del catálogo de razas (agx.catalogo_razas, 0022)
// -- mismo criterio que categoriaProductivaRepository.js: solo filas
// activas visibles para la organización (v1: catálogo de sistema).
import { withOrganizacionTransaction } from '../../db/agxBusinessPool.js';

function serializeRazaRow(row) {
  return {
    razaId: String(row.raza_id),
    codigo: row.codigo,
    nombre: row.nombre,
    tipoProductivo: row.tipo_productivo,
  };
}

export async function listRazas(organizacionId) {
  return withOrganizacionTransaction(organizacionId, async (client) => {
    const result = await client.query(
      `select raza_id, codigo, nombre, tipo_productivo
         from agx.catalogo_razas
        where activo = true
        order by tipo_productivo asc, nombre asc`,
    );
    return result.rows.map(serializeRazaRow);
  });
}
