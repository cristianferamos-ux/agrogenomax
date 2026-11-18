// FASE 0 / FASE 1A / FASE 5A.1b -- pesajes y ganancia media diaria (GMD)
// según el modelo Business (agx.animal_pesajes). Fuente CANÓNICA compartida
// por el backend (GET /api/ganaderia/animales/:id/pesajes, reporte PDF,
// línea de tiempo) y el frontend (reexportada en
// src/modules/ganaderia/engine/pesajes.js): una sola fórmula.
// Funciones puras: fechas calendario 'YYYY-MM-DD', peso en kg, GMD en
// kg/día, sin redondeo (solo al presentar).
//
// Reglas:
//   * FASE 5A: un pesaje ANULADO (estadoRegistro) NUNCA interviene en un
//     cálculo productivo (último peso, GMD, ganancia acumulada, tendencia,
//     alertas, PDF): solo aparece en el historial. Una fila sin
//     estadoRegistro (código o datos anteriores a 0028) es ACTIVO.
//   * FASE 5A: SERIE DIARIA. Varios pesajes ACTIVOS en la misma fecha son
//     válidos; para calcular, cada fecha se representa con su ÚLTIMO pesaje
//     ACTIVO (orden de registro: pesajeId; no hay hora fiable). Las demás
//     mediciones del día quedan en el historial, sin derivaciones.
//   * GMD = (peso_actual - peso_anterior) / días_transcurridos, SOLO entre
//     fechas distintas de la serie diaria. Sin fecha anterior -> GMD null.
//   * GMD positiva, negativa o cero son resultados válidos. Sin umbrales de
//     plausibilidad (FASE 5A, decisión de negocio pendiente).
//   * REGISTRO_INICIAL NO es peso al nacimiento y el primer pesaje NO se
//     convierte en nacimiento, fecha de nacimiento ni categoría lactante
//     (BUG-02). Nacimiento, edad y categoría vienen del animal Business.
//   * No hay umbrales productivos "oficiales": interpretar la GMD (bueno /
//     crítico) requerirá una configuración oficial futura. Los umbrales de la
//     Demo viven en engine/demo/pesajesDemo.js.
import { aFechaISO, diasEntre } from './fechas.js';

export const ESTADOS_REGISTRO_PESAJE = Object.freeze({ ACTIVO: 'ACTIVO', ANULADO: 'ANULADO' });

/** GMD en kg/día; null si falta un peso o si días <= 0. */
export function calcularGMD(pesoActualKg, pesoAnteriorKg, dias) {
  if (!Number.isFinite(pesoActualKg) || !Number.isFinite(pesoAnteriorKg) || !Number.isFinite(dias) || dias <= 0) return null;
  return (pesoActualKg - pesoAnteriorKg) / dias;
}

/** ACTIVO salvo que el registro diga explícitamente ANULADO (filas anteriores a 0028 = ACTIVO). */
export function esPesajeActivo(row) {
  return (row?.estadoRegistro ?? row?.estado_registro ?? ESTADOS_REGISTRO_PESAJE.ACTIVO) !== ESTADOS_REGISTRO_PESAJE.ANULADO;
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
 * misma fecha, por pesajeId. Las filas inválidas se descartan. Incluye
 * ACTIVOS y ANULADOS (orden del historial).
 */
export function ordenarPesajes(pesajes = []) {
  return pesajes
    .map((row) => ({ row, fecha: aFechaISO(row?.fecha ?? row?.fecha_pesaje), pesoKg: pesoDe(row) }))
    .filter((p) => p.fecha && p.pesoKg !== null)
    .sort((a, b) => diasEntre(b.fecha, a.fecha) || idDe(a.row) - idDe(b.row));
}

/** Pesajes ACTIVOS (sin ANULADOS), en el mismo orden recibido. */
export function filtrarPesajesActivos(pesajes = []) {
  return pesajes.filter(esPesajeActivo);
}

/**
 * SERIE DIARIA productiva: un punto por fecha (último pesaje ACTIVO del día),
 * en orden cronológico. Elementos { row, fecha, pesoKg, mediciones, primerPesoKg }.
 */
export function construirSerieDiaria(pesajes = []) {
  const serie = [];
  for (const p of ordenarPesajes(filtrarPesajesActivos(pesajes))) {
    const ultimo = serie.at(-1);
    if (ultimo && ultimo.fecha === p.fecha) {
      serie[serie.length - 1] = { ...p, mediciones: ultimo.mediciones + 1, primerPesoKg: ultimo.primerPesoKg };
    } else {
      serie.push({ ...p, mediciones: 1, primerPesoKg: p.pesoKg });
    }
  }
  return serie;
}

function resumenMismoDia(punto) {
  if (!punto || punto.mediciones < 2) return null;
  return {
    fecha: punto.fecha,
    mediciones: punto.mediciones,
    primerPesoKg: punto.primerPesoKg,
    ultimoPesoKg: punto.pesoKg,
    diferenciaKg: punto.pesoKg - punto.primerPesoKg,
  };
}

const SIN_DERIVACIONES = Object.freeze({
  pesoAnteriorKg: null,
  fechaAnterior: null,
  diferenciaKg: null,
  diasDesdeAnterior: null,
  gmdKgDia: null,
  representativoDelDia: false,
  mismoDia: null,
});

/**
 * HISTORIAL completo (ACTIVOS + ANULADOS) en orden cronológico, cada fila con
 * { fecha, pesoKg, estadoRegistro, pesoAnteriorKg, fechaAnterior, diferenciaKg,
 * diasDesdeAnterior, gmdKgDia, representativoDelDia, mismoDia }:
 *   - fila representativa del día (último ACTIVO de su fecha): derivaciones
 *     respecto de la fecha anterior de la serie diaria; `mismoDia` describe
 *     las mediciones ACTIVAS del día cuando hay más de una (primera -> última);
 *   - medición ACTIVA previa del mismo día o fila ANULADA: sin derivaciones.
 * No calcula edad, categoría ni etapa.
 */
export function enriquecerHistorialPesajes(pesajes = []) {
  const serie = construirSerieDiaria(pesajes);
  const indicePorFecha = new Map(serie.map((punto, i) => [punto.fecha, i]));
  return ordenarPesajes(pesajes).map((p) => {
    const activo = esPesajeActivo(p.row);
    const base = { ...p.row, fecha: p.fecha, pesoKg: p.pesoKg, estadoRegistro: activo ? ESTADOS_REGISTRO_PESAJE.ACTIVO : ESTADOS_REGISTRO_PESAJE.ANULADO };
    const i = activo ? indicePorFecha.get(p.fecha) : undefined;
    const punto = i === undefined ? null : serie[i];
    if (!punto || punto.row !== p.row) return { ...base, ...SIN_DERIVACIONES };
    const anterior = i > 0 ? serie[i - 1] : null;
    const dias = anterior ? diasEntre(anterior.fecha, punto.fecha) : null;
    return {
      ...base,
      pesoAnteriorKg: anterior ? anterior.pesoKg : null,
      fechaAnterior: anterior ? anterior.fecha : null,
      diferenciaKg: anterior ? punto.pesoKg - anterior.pesoKg : null,
      diasDesdeAnterior: dias,
      gmdKgDia: anterior ? calcularGMD(punto.pesoKg, anterior.pesoKg, dias) : null,
      representativoDelDia: true,
      mismoDia: resumenMismoDia(punto),
    };
  });
}

/**
 * Lista PRODUCTIVA: solo pesajes ACTIVOS, enriquecidos como en
 * enriquecerHistorialPesajes (mismas derivaciones de la serie diaria).
 */
export function enriquecerPesajes(pesajes = []) {
  return enriquecerHistorialPesajes(pesajes).filter((p) => p.estadoRegistro === ESTADOS_REGISTRO_PESAJE.ACTIVO);
}

/** Ganancia entre el primer y el último punto de la serie diaria ACTIVA (fechas distintas). */
export function calcularGananciaAcumulada(pesajes = []) {
  const serie = construirSerieDiaria(pesajes);
  if (serie.length < 2) return null;
  const primero = serie[0];
  const ultimo = serie[serie.length - 1];
  const dias = diasEntre(primero.fecha, ultimo.fecha);
  return {
    pesoInicialKg: primero.pesoKg,
    pesoFinalKg: ultimo.pesoKg,
    fechaInicial: primero.fecha,
    fechaFinal: ultimo.fecha,
    gananciaKg: ultimo.pesoKg - primero.pesoKg,
    dias,
    gmdPromedioKgDia: calcularGMD(ultimo.pesoKg, primero.pesoKg, dias),
  };
}

/** Mediciones ACTIVAS múltiples en la ÚLTIMA fecha de la serie diaria, o null. */
export function calcularMismoDiaUltimaFecha(pesajes = []) {
  return resumenMismoDia(construirSerieDiaria(pesajes).at(-1) ?? null);
}

/**
 * HEURÍSTICA VISUAL, NO criterio veterinario: compara la GMD de los dos
 * últimos períodos con GMD válida. ESTABLE si la diferencia está dentro de
 * ±toleranciaRelativa de la GMD anterior (si la anterior es 0, se usa una
 * tolerancia absoluta de toleranciaRelativa kg/día). Con filas enriquecidas
 * por este motor, solo las representativas del día tienen GMD.
 */
export function calcularTendenciaGMD(pesajesEnriquecidos = [], { toleranciaRelativa = 0.05 } = {}) {
  const periodos = pesajesEnriquecidos.filter((p) => esPesajeActivo(p) && Number.isFinite(p.gmdKgDia));
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
