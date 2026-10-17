// SPRINT-3D11.3 (R1) -- organizaciones destino de una asignación de
// chapetas. Fuente de verdad: Postgres-AGX (identidad), solo lectura. El
// inventario (Postgres-AGX-Business) guarda únicamente el organizacion_id.
import { getAgxAuthPool } from '../../db/agxAuthPool.js';

export async function listOrganizacionesActivas() {
  const result = await getAgxAuthPool().query(
    `select organizacion_id, nombre from agx.organizaciones where estado = 'activa' order by nombre, organizacion_id`,
  );
  return result.rows.map((row) => ({ organizacionId: row.organizacion_id, nombre: row.nombre }));
}

export async function isOrganizacionActiva(organizacionId) {
  const result = await getAgxAuthPool().query(
    `select 1 from agx.organizaciones where organizacion_id = $1 and estado = 'activa'`,
    [organizacionId],
  );
  return result.rowCount > 0;
}
