// FASE 4D -- analítica reproductiva de la ORGANIZACIÓN (solo lectura) contra
// Postgres-AGX-Business. `organizacionId` llega YA autorizado
// (req.ganaderiaAuth, nunca del cliente) y todo corre en
// withOrganizacionTransaction: RLS+FORCE aísla por organización.
//
// Una sola consulta trae el historial ACTIVO de las hembras con registro ACTIVO
// (incluye SALIDO y MUERTO: los históricos no se sesgan hacia las sobrevivientes)
// en orden (animal_id, fecha_evento, evento_id). Los ciclos los pliega
// reproduccionAnalitica.js. Sin N+1. El historial anterior al periodo se lee
// siempre porque da contexto a la clasificación. Nunca toca el legacy.
import { withOrganizacionTransaction } from '../../db/agxBusinessPool.js';
import { agregarMetricas } from './reproduccionAnalitica.js';

export function sqlHistorialAnalitica({ conPredio = false } = {}) {
  return `
    select a.animal_id::text as animal_id, a.estado_operativo, a.origen_tipo, a.nacimiento_tipo,
           to_char(a.fecha_nacimiento, 'YYYY-MM-DD') as fecha_nacimiento,
           e.evento_id::text as evento_id, e.tipo_evento, to_char(e.fecha_evento, 'YYYY-MM-DD') as fecha_evento,
           e.tipo_servicio, e.diagnostico_resultado, e.dias_gestacion, e.parto_tipo, e.numero_crias
      from agx.reproduccion_eventos e
      join agx.animales a on a.animal_id = e.animal_id and a.organizacion_id = e.organizacion_id
     where a.sexo = 'HEMBRA' and a.estado = 'ACTIVO' and e.estado_registro = 'ACTIVO'
       and e.fecha_evento <= $1::date${conPredio ? ' and a.predio_id = $2' : ''}
     order by a.animal_id, e.fecha_evento, e.evento_id`;
}

/** Filas ordenadas por animal -> hembras con su historial. */
export function agruparHembras(rows) {
  const hembras = new Map();
  for (const row of rows) {
    let hembra = hembras.get(row.animal_id);
    if (!hembra) {
      hembra = {
        animalId: row.animal_id,
        estadoOperativo: row.estado_operativo,
        origenTipo: row.origen_tipo,
        nacimientoTipo: row.nacimiento_tipo,
        fechaNacimiento: row.fecha_nacimiento,
        eventos: [],
      };
      hembras.set(row.animal_id, hembra);
    }
    hembra.eventos.push({
      eventoId: row.evento_id,
      tipoEvento: row.tipo_evento,
      fechaEvento: row.fecha_evento,
      tipoServicio: row.tipo_servicio,
      diagnosticoResultado: row.diagnostico_resultado,
      diasGestacion: row.dias_gestacion,
      partoTipo: row.parto_tipo,
      numeroCrias: row.numero_crias,
    });
  }
  return [...hembras.values()];
}

/** GET .../reproduccion/analitica -- métricas del periodo con M14. */
export async function analiticaReproductiva(organizacionId, { predioId = null, desde, hasta }, { hoy }) {
  const rows = await withOrganizacionTransaction(organizacionId, async (client) => {
    const params = predioId ? [hoy, predioId] : [hoy];
    const resultado = await client.query(sqlHistorialAnalitica({ conPredio: Boolean(predioId) }), params);
    return resultado.rows;
  });
  return agregarMetricas(agruparHembras(rows), { desde, hasta, hoy });
}
