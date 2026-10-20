// FASE 0 -- producción de leche. La cuenta real todavía NO tiene tabla ni API
// (módulo futuro); la Demo lo usa con datos de sesión. Funciones puras, sin
// React/window/fetch, fechas calendario 'YYYY-MM-DD', litros sin redondear
// (redondear solo al presentar).
//
// Reglas:
//   * Varios registros/ordeños del mismo día se CONSOLIDAN por fecha (suma)
//     antes de promediar. Un registro admite litros del día o litros AM + PM.
//   * Los promedios usan DÍAS CALENDARIO (ventana [ref-(N-1), ref]), no "los
//     últimos N registros" (BUG-04). Un día sin registro NO cuenta como 0:
//     el promedio es sobre los días con registro dentro de la ventana.
//   * fechaReferencia por defecto = último día con registro (función pura).
//   * Días en leche = fechaObjetivo - fechaParto (null sin parto).
//   * Umbrales de caída (15 % atención, 25 % crítico) y etapas de lactancia
//     (<100 / 100-200 / >200 días) son HEURÍSTICOS hasta aprobación oficial.
import { aFechaISO, diasEntre, sumarDias } from './fechas.js';

function numero(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function primerDefinido(registro, claves) {
  for (const clave of claves) {
    if (registro?.[clave] !== undefined && registro?.[clave] !== null && registro?.[clave] !== '') return registro[clave];
  }
  return null;
}

/** Litros de un registro: litros del día, o AM + PM si vienen separados. */
export function litrosDeRegistro(registro) {
  const dia = numero(primerDefinido(registro, ['litrosDia', 'litros_dia', 'litros', 'litros_día', 'totalLitros', 'total_liters']));
  if (dia !== null) return dia;
  const am = numero(primerDefinido(registro, ['litrosAm', 'litros_am', 'liters_am']));
  const pm = numero(primerDefinido(registro, ['litrosPm', 'litros_pm', 'liters_pm']));
  return am === null && pm === null ? null : (am ?? 0) + (pm ?? 0);
}

/**
 * Forma canónica por REGISTRO (sin consolidar), ordenada por fecha:
 * { fecha, litros_dia, numero_ordenos, potrero_id, observaciones }.
 */
export function normalizarRegistrosLeche(registros = []) {
  return registros
    .map((registro) => ({
      fecha: aFechaISO(primerDefinido(registro, ['fecha', 'fecha_registro', 'production_date'])),
      litros_dia: litrosDeRegistro(registro),
      numero_ordenos: numero(primerDefinido(registro, ['numero_ordenos', 'ordenos'])),
      potrero_id: primerDefinido(registro, ['potrero_id', 'potrero']),
      observaciones: primerDefinido(registro, ['observaciones', 'notes']) || '',
    }))
    .filter((registro) => registro.fecha && registro.litros_dia !== null && registro.litros_dia >= 0)
    .sort((a, b) => diasEntre(b.fecha, a.fecha));
}

/** Un valor por día: { fecha, litros (suma del día), registros }. Orden ascendente. */
export function consolidarLechePorDia(registros = []) {
  const porDia = new Map();
  for (const registro of normalizarRegistrosLeche(registros)) {
    const dia = porDia.get(registro.fecha) ?? { fecha: registro.fecha, litros: 0, registros: 0 };
    dia.litros += registro.litros_dia;
    dia.registros += 1;
    porDia.set(registro.fecha, dia);
  }
  return [...porDia.values()].sort((a, b) => diasEntre(b.fecha, a.fecha));
}

function ultimaFecha(dias) {
  return dias.length ? dias[dias.length - 1].fecha : null;
}

/** Días consolidados dentro de [ref-(ventanaDias-1), ref]. */
export function diasEnVentana(diasConsolidados, ventanaDias, fechaReferencia = ultimaFecha(diasConsolidados)) {
  const ref = aFechaISO(fechaReferencia);
  if (!ref || !Number.isInteger(ventanaDias) || ventanaDias <= 0) return [];
  const desde = sumarDias(ref, -(ventanaDias - 1));
  return diasConsolidados.filter((d) => diasEntre(desde, d.fecha) >= 0 && diasEntre(d.fecha, ref) >= 0);
}

function promedio(valores) {
  return valores.length ? valores.reduce((s, v) => s + v, 0) / valores.length : null;
}

/**
 * Promedio de litros/día sobre los días con registro de una ventana de N días
 * calendario. ventanaDias null/undefined -> todos los días con registro.
 */
export function calcularPromedioLeche(registros, ventanaDias, { fechaReferencia } = {}) {
  const dias = consolidarLechePorDia(registros);
  const relevantes = Number.isInteger(ventanaDias) ? diasEnVentana(dias, ventanaDias, fechaReferencia ?? ultimaFecha(dias)) : dias;
  return promedio(relevantes.map((d) => d.litros));
}

/** Suma de litros de todos los registros (no inventa totales de lactancia). */
export function calcularProduccionAcumulada(registros) {
  return consolidarLechePorDia(registros).reduce((sum, d) => sum + d.litros, 0);
}

/**
 * Compara el promedio de la ventana reciente [ref-(R-1), ref] con el de la
 * ventana base de B días inmediatamente anterior (no superpuesta).
 * variacionPorcentaje > 0 significa CAÍDA. null si no hay datos suficientes
 * (menos de minDiasReciente / minDiasBase días con registro).
 */
export function calcularVariacionLeche(registros, {
  fechaReferencia,
  ventanaRecienteDias = 3,
  ventanaBaseDias = 15,
  minDiasReciente = 2,
  minDiasBase = 3,
} = {}) {
  const dias = consolidarLechePorDia(registros);
  const ref = aFechaISO(fechaReferencia) ?? ultimaFecha(dias);
  if (!ref) return null;
  const recientes = diasEnVentana(dias, ventanaRecienteDias, ref);
  const base = diasEnVentana(dias, ventanaBaseDias, sumarDias(ref, -ventanaRecienteDias));
  if (recientes.length < minDiasReciente || base.length < minDiasBase) return null;
  const promedioReciente = promedio(recientes.map((d) => d.litros));
  const promedioBase = promedio(base.map((d) => d.litros));
  return {
    fechaReferencia: ref,
    ventanaRecienteDias,
    ventanaBaseDias,
    diasConRegistroReciente: recientes.length,
    diasConRegistroBase: base.length,
    promedioReciente,
    promedioBase,
    variacionPorcentaje: promedioBase > 0 ? ((promedioBase - promedioReciente) / promedioBase) * 100 : null,
  };
}

/** HEURÍSTICO: caída >= umbralCaidaPct (15 %) de la ventana reciente frente a la base. */
export function detectarCaidaProduccion(registros, { umbralCaidaPct = 15, ...ventanas } = {}) {
  const variacion = calcularVariacionLeche(registros, ventanas);
  if (!variacion || !Number.isFinite(variacion.variacionPorcentaje)) {
    return { hayCaida: false, variacionPorcentaje: null, datosSuficientes: Boolean(variacion) };
  }
  if (variacion.variacionPorcentaje >= umbralCaidaPct) {
    return {
      hayCaida: true,
      datosSuficientes: true,
      variacionPorcentaje: variacion.variacionPorcentaje,
      promedioReciente: variacion.promedioReciente,
      promedioBase: variacion.promedioBase,
      ventanaRecienteDias: variacion.ventanaRecienteDias,
      alerta: `Producción de leche cayó aproximadamente ${Math.round(variacion.variacionPorcentaje)}% en los últimos ${variacion.ventanaRecienteDias} días.`,
      interpretacion: 'Puede estar asociada a alimentación, disponibilidad de agua, cambio de potrero o estrés calórico.',
      recomendacion: 'Revisar agua, dieta y confort térmico.',
    };
  }
  return { hayCaida: false, datosSuficientes: true, variacionPorcentaje: variacion.variacionPorcentaje };
}

/** Días en leche = fechaObjetivo - fechaParto; null sin parto o si el objetivo es anterior. */
export function calcularDiasEnLeche(fechaParto, fechaObjetivo) {
  const dias = diasEntre(fechaParto, fechaObjetivo);
  return dias === null || dias < 0 ? null : dias;
}

// HEURÍSTICO: Temprana <100, Media 100-200, Tardía >200 días en leche.
export function calcularEtapaLactancia(diasEnLeche) {
  if (!Number.isFinite(diasEnLeche)) return 'Sin datos';
  if (diasEnLeche < 100) return 'Temprana';
  if (diasEnLeche <= 200) return 'Media';
  return 'Tardía';
}

/**
 * Resumen lechero. Los días en leche salen de fechaParto (nunca de un campo
 * fijo). fechaObjetivo por defecto = último día con registro.
 */
export function calcularResumenLechero({ registrosLeche = [], fechaParto = null, fechaObjetivo = null } = {}) {
  const registros = normalizarRegistrosLeche(registrosLeche);
  const dias = consolidarLechePorDia(registrosLeche);
  const referencia = aFechaISO(fechaObjetivo) ?? ultimaFecha(dias);
  const hoy = dias.find((d) => d.fecha === referencia) ?? null;
  const diasEnLeche = calcularDiasEnLeche(fechaParto, referencia);
  const caida = detectarCaidaProduccion(registrosLeche, { fechaReferencia: referencia });

  return {
    fecha_referencia: referencia,
    litros_hoy: hoy ? hoy.litros : null,
    promedio_semanal: calcularPromedioLeche(registrosLeche, 7, { fechaReferencia: referencia }),
    promedio_historico: calcularPromedioLeche(registrosLeche),
    produccion_acumulada: calcularProduccionAcumulada(registrosLeche),
    dias_en_leche: diasEnLeche,
    etapa_lactancia: calcularEtapaLactancia(diasEnLeche),
    alerta_principal: caida.hayCaida ? caida.alerta : 'Sin alertas activas de producción.',
    interpretacion: caida.hayCaida ? caida.interpretacion : 'Producción dentro del comportamiento reciente esperado.',
    recomendacion: caida.hayCaida ? caida.recomendacion : 'Mantener el manejo actual y seguir registrando la producción diaria.',
    caida,
    registros,
  };
}

// HEURÍSTICO: Crítico si la caída es >= 25 %, Atención si hay caída, Estable si no.
export function obtenerEstadoProduccionLeche(resumen, { umbralCriticoPct = 25 } = {}) {
  if (resumen?.caida?.hayCaida) {
    if (resumen.caida.variacionPorcentaje >= umbralCriticoPct) return { label: 'Crítico', className: 'estado-vencida' };
    return { label: 'Atención', className: 'estado-proxima' };
  }
  return { label: 'Estable', className: 'estado-vigente' };
}
