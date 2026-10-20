// FASE 0 -- pesajes y ganancia media diaria (GMD) según el modelo Business
// (agx.animal_pesajes). Funciones puras: fechas calendario 'YYYY-MM-DD',
// peso en kg, GMD en kg/día, sin redondeo (solo al presentar).
//
// Reglas:
//   * GMD = (peso_actual - peso_anterior) / días_transcurridos.
//   * Sin pesaje anterior, o misma fecha (0 días) -> GMD null.
//   * GMD positiva, negativa o cero son resultados válidos.
//   * REGISTRO_INICIAL NO es peso al nacimiento y el primer pesaje NO se
//     convierte en nacimiento, fecha de nacimiento ni categoría lactante
//     (BUG-02). Nacimiento, edad y categoría vienen del animal Business.
//   * No hay umbrales productivos "oficiales": interpretar la GMD (bueno /
//     crítico) requerirá una configuración oficial futura. Los umbrales de la
//     Demo viven en engine/demo/pesajesDemo.js.
import { aFechaISO, diasEntre } from './fechas.js';

/** GMD en kg/día; null si falta un peso o si días <= 0. */
export function calcularGMD(pesoActualKg, pesoAnteriorKg, dias) {
  if (!Number.isFinite(pesoActualKg) || !Number.isFinite(pesoAnteriorKg) || !Number.isFinite(dias) || dias <= 0) return null;
  return (pesoActualKg - pesoAnteriorKg) / dias;
}

function pesoDe(row) {
  const raw = row?.pesoKg ?? row?.peso_kg;
  if (raw === null || raw === undefined || raw === '') return null;
  const peso = Number(raw);
  return Number.isFinite(peso) && peso > 0 ? peso : null;
}

function idDe(row) {
  const id = Number(row?.pesajeId ?? row?.pesaje_id);
  return Number.isFinite(id) ? id : Number.POSITIVE_INFINITY;
}

/**
 * Pesajes válidos (fecha calendario + peso > 0) ordenados por fecha y, en la
 * misma fecha, por pesajeId. Las filas inválidas se descartan.
 */
export function ordenarPesajes(pesajes = []) {
  return pesajes
    .map((row) => ({ row, fecha: aFechaISO(row?.fecha ?? row?.fecha_pesaje), pesoKg: pesoDe(row) }))
    .filter((p) => p.fecha && p.pesoKg !== null)
    .sort((a, b) => diasEntre(b.fecha, a.fecha) || idDe(a.row) - idDe(b.row));
}

/**
 * Enriquece cada pesaje con { fecha, pesoKg, pesoAnteriorKg, diferenciaKg,
 * diasDesdeAnterior, gmdKgDia }. No calcula edad, categoría ni etapa.
 */
export function enriquecerPesajes(pesajes = []) {
  const ordenados = ordenarPesajes(pesajes);
  return ordenados.map((actual, index) => {
    const anterior = ordenados[index - 1];
    const dias = anterior ? diasEntre(anterior.fecha, actual.fecha) : null;
    return {
      ...actual.row,
      fecha: actual.fecha,
      pesoKg: actual.pesoKg,
      pesoAnteriorKg: anterior ? anterior.pesoKg : null,
      diferenciaKg: anterior ? actual.pesoKg - anterior.pesoKg : null,
      diasDesdeAnterior: dias,
      gmdKgDia: anterior ? calcularGMD(actual.pesoKg, anterior.pesoKg, dias) : null,
    };
  });
}

/** Ganancia entre el primer y el último pesaje válidos. */
export function calcularGananciaAcumulada(pesajes = []) {
  const ordenados = ordenarPesajes(pesajes);
  if (ordenados.length < 2) return null;
  const primero = ordenados[0];
  const ultimo = ordenados[ordenados.length - 1];
  const dias = diasEntre(primero.fecha, ultimo.fecha);
  return {
    pesoInicialKg: primero.pesoKg,
    pesoFinalKg: ultimo.pesoKg,
    gananciaKg: ultimo.pesoKg - primero.pesoKg,
    dias,
    gmdPromedioKgDia: calcularGMD(ultimo.pesoKg, primero.pesoKg, dias),
  };
}

/**
 * HEURÍSTICA VISUAL, NO criterio veterinario: compara la GMD de los dos
 * últimos períodos con GMD válida. ESTABLE si la diferencia está dentro de
 * ±toleranciaRelativa de la GMD anterior (si la anterior es 0, se usa una
 * tolerancia absoluta de toleranciaRelativa kg/día).
 */
export function calcularTendenciaGMD(pesajesEnriquecidos = [], { toleranciaRelativa = 0.05 } = {}) {
  const periodos = pesajesEnriquecidos.filter((p) => Number.isFinite(p.gmdKgDia));
  if (periodos.length < 2) return { tendencia: 'SIN_DATOS', diferenciaKgDia: null };
  const ultima = periodos[periodos.length - 1].gmdKgDia;
  const anterior = periodos[periodos.length - 2].gmdKgDia;
  const diferencia = ultima - anterior;
  const tolerancia = Math.abs(anterior !== 0 ? anterior : 1) * toleranciaRelativa;
  let tendencia = 'ESTABLE';
  if (Math.abs(diferencia) > tolerancia) tendencia = diferencia > 0 ? 'MEJORANDO' : 'EMPEORANDO';
  return { tendencia, diferenciaKgDia: diferencia };
}

/**
 * CONFIGURACIÓN PROVISIONAL (no regla productiva oficial): antigüedad del
 * último pesaje respecto a la fecha objetivo.
 *   ACTUALIZADO <= diasRecomendado < RECOMENDADO <= diasAtrasado < ATRASADO.
 */
export function clasificarAntiguedadPesaje(fechaUltimoPesaje, fechaObjetivo, { diasRecomendado = 30, diasAtrasado = 60 } = {}) {
  const dias = diasEntre(fechaUltimoPesaje, fechaObjetivo);
  if (dias === null) return { estado: 'SIN_FECHA', dias: null };
  if (dias <= diasRecomendado) return { estado: 'ACTUALIZADO', dias };
  if (dias <= diasAtrasado) return { estado: 'RECOMENDADO', dias };
  return { estado: 'ATRASADO', dias };
}
