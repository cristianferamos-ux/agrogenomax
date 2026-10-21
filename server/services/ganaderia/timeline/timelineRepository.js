// FASE 1D.2 -- lectura de las fuentes Business de la línea de tiempo en UNA
// transacción con el tenant de la sesión (withOrganizacionTransaction + RLS
// ENABLE/FORCE): animal, agx.animal_eventos y agx.animal_pesajes. Solo
// SELECT: la línea de tiempo no escribe nada. Un animal de otra organización
// es indistinguible de uno inexistente (null -> 404). Nunca legacy.
//
// agx.qr_chapeta_eventos NO se lee: sus hechos de animal ya están en
// agx.animal_eventos (QR_ASOCIADO / QR_REVOCADO / QR_REEMPLAZADO).
import { withOrganizacionTransaction } from '../../../db/agxBusinessPool.js';
import { fetchAnimal } from '../animalesRepository.js';
import { listPesajesEnTx } from '../pesajesRepository.js';

export async function leerFuentesTimeline(organizacionId, animalId) {
  return withOrganizacionTransaction(organizacionId, async (client) => {
    const animal = await fetchAnimal(client, animalId);
    if (!animal) return null;
    const eventos = await client.query(
      `select evento_id::text as evento_id,
              tipo_evento,
              metadata_json,
              to_char(ocurrido_en at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as ocurrido_en
         from agx.animal_eventos
        where animal_id = $1
        order by ocurrido_en asc, evento_id asc`,
      [animalId],
    );
    const pesajes = await listPesajesEnTx(client, animalId);
    return {
      animal,
      eventosAnimal: eventos.rows.map((r) => ({
        eventoId: r.evento_id,
        tipoEvento: r.tipo_evento,
        metadata: r.metadata_json,
        ocurridoEn: r.ocurrido_en,
      })),
      pesajes,
    };
  });
}
