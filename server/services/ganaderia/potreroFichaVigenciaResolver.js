// SPRINT-3D10.4 -- AUTORIDAD UNICA DE VIGENCIA DE AFORO.
//
// Reemplaza el fetchFichaMasReciente duplicado que existia en
// potreroRecomendacionPastoreoRepository.js y
// potreroCapacidadPastoreoRepository.js -- ambos hacian
// `order by created_at desc limit 1` sin ningun resguardo contra un
// pastoreo real ya ocurrido despues de la ficha (gap identificado en
// 3D10.1, cerrado en 3D10.3/3D10.3.1).
//
// Autoridad temporal (3D10.3.1 SS C/D/E, aprobada):
// - fecha_aforo (DATE) es el UNICO hecho fisico de cuando se midio el
//   forraje. created_at (timestamptz, momento de registro en el sistema)
//   NUNCA sustituye ni "rescata" una fecha_aforo anterior o igual a la
//   frontera -- solo desempata entre fichas con la MISMA fecha_aforo.
// - La frontera de invalidez es la ultima SALIDA real (fecha_salida_real)
//   del ultimo ciclo con estado='FINALIZADO' del potrero. Se ignoran
//   EN_CURSO (sin salida todavia), CANCELADO y ANULADO (ninguno de los
//   tres representa una salida real que haya modificado la biomasa).
// - Un aforo del MISMO DIA de la salida NO es valido en v1 (politica
//   conservadora: sin timestamp de medicion del aforo, el mismo dia es
//   ambiguo -- pudo medirse antes de que los animales salieran esa
//   manana). Se exige fecha_aforo > fecha_salida_real, estrictamente.
// - Si el potrero nunca tuvo un ciclo FINALIZADO, no hay frontera que
//   aplicar -- se usa la ficha mas reciente por fecha_aforo (created_at
//   solo desempate). Una ficha con fecha_aforo NULL queda relegada al
//   final del orden, nunca excluida (no hay frontera que no pueda probar
//   cumplir).
//
// Contrato de retorno: { ficha, motivo }.
// - ficha=fila | motivo=null -> ficha vigente resuelta.
// - ficha=null | motivo='AFORO_ANTERIOR_AL_ULTIMO_PASTOREO' -> el potrero
//   tiene ficha(s), pero ninguna es posterior a la ultima salida real.
// - ficha=null | motivo=null -> el potrero no tiene ninguna ficha
//   registrada todavia.
//
// FASE 1 (3D10.4): los llamadores existentes (recomendacion manual,
// capacidad de pastoreo) colapsan ambos casos de ficha=null al mismo
// codigo/mensaje de error que usan hoy (INSUFFICIENT_FORAGE_DATA /
// FICHA_NOT_FOUND) -- no se introduce una semantica HTTP nueva en esta
// fase (3D10.4 SS8).
export async function resolveFichaVigente(client, potreroId) {
  const ultimoFinalizadoResult = await client.query(
    `select to_char(fecha_salida_real, 'YYYY-MM-DD') as fecha_salida_real
       from agx.potrero_ciclos_pastoreo
      where potrero_id = $1 and estado = 'FINALIZADO'
      order by fecha_salida_real desc, created_at desc
      limit 1`,
    [potreroId],
  );

  if (ultimoFinalizadoResult.rows.length > 0) {
    const frontera = ultimoFinalizadoResult.rows[0].fecha_salida_real;
    const candidataResult = await client.query(
      `select ficha_id, biomasa_total_kg, tipo_cobertura, aforo_promedio_g_m2,
              to_char(fecha_aforo, 'YYYY-MM-DD') as fecha_aforo, created_at
         from agx.potrero_fichas_productivas
        where potrero_id = $1
          and fecha_aforo is not null
          and fecha_aforo > $2
        order by fecha_aforo desc, created_at desc
        limit 1`,
      [potreroId, frontera],
    );
    if (candidataResult.rows.length === 0) {
      return { ficha: null, motivo: 'AFORO_ANTERIOR_AL_ULTIMO_PASTOREO' };
    }
    return { ficha: candidataResult.rows[0], motivo: null };
  }

  const sinCicloResult = await client.query(
    `select ficha_id, biomasa_total_kg, tipo_cobertura, aforo_promedio_g_m2,
            to_char(fecha_aforo, 'YYYY-MM-DD') as fecha_aforo, created_at
       from agx.potrero_fichas_productivas
      where potrero_id = $1
      order by fecha_aforo desc nulls last, created_at desc
      limit 1`,
    [potreroId],
  );
  if (sinCicloResult.rows.length === 0) {
    return { ficha: null, motivo: null };
  }
  return { ficha: sinCicloResult.rows[0], motivo: null };
}
