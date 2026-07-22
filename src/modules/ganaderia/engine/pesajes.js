// Motor comun de pesajes y ganancia diaria de peso (GDP) para Ganaderia Inteligente.
// Extraido fielmente de AnimalPesajesTab.jsx. No inventa umbrales nuevos: los umbrales
// por categoria son los mismos que ya usa la cuenta real (obtenerUmbralesGDP).

import { valueOf, calcularEdadEnFecha, getFechaNacimientoRealAnimal, getFechaNacimientoEstimadaPorEdad, todayISO, normalizeDateInput } from './edad.js';
import { clasificarCategoriaPorEdadSexo } from './categoria.js';

export function getFecha(row) {
  return valueOf(row, ['fecha_pesaje', 'fecha', 'weighing_date']);
}

export function getPeso(row, aliases = ['peso_kg', 'peso', 'weight_kg']) {
  const value = valueOf(row, aliases);
  return value === '' ? null : Number(value);
}

export function isBirthWeightRow(row, previous) {
  const notes = String(valueOf(row, ['observaciones', 'notes']) || '');
  return Boolean(row?.es_peso_nacimiento) || (!previous && /peso\s+(inicial|al\s+nacimiento|nacimiento)|nacimiento/i.test(notes));
}

export function isBirthReferenceRow(row) {
  const notes = String(valueOf(row, ['observaciones', 'notes']) || '');
  return Boolean(row?.es_peso_nacimiento) || /peso\s+(inicial|al\s+nacimiento|nacimiento)|nacimiento/i.test(notes);
}

export function sortByDateAsc(rows) {
  return [...rows].sort((a, b) => {
    const dateA = new Date(getFecha(a)).getTime() || 0;
    const dateB = new Date(getFecha(b)).getTime() || 0;
    const idA = a.es_peso_nacimiento ? -1 : Number(a.pesaje_id || 0);
    const idB = b.es_peso_nacimiento ? -1 : Number(b.pesaje_id || 0);
    return dateA - dateB || idA - idB;
  });
}

export function getFechaNacimientoProductiva(animal, rows = []) {
  const ordered = sortByDateAsc(rows);
  const realBirthDate = getFechaNacimientoRealAnimal(animal);
  if (realBirthDate) return realBirthDate;
  const birthRow = ordered.find((row) => isBirthReferenceRow(row));
  if (birthRow) return normalizeDateInput(getFecha(birthRow));
  return normalizeDateInput(getFecha(ordered[0])) || getFechaNacimientoEstimadaPorEdad(animal);
}

export function daysSince(value) {
  const date = normalizeDateInput(value);
  if (!date) return '—';
  const diff = Math.floor((new Date(todayISO()) - new Date(date)) / 86400000);
  if (!Number.isFinite(diff)) return '—';
  if (diff === 0) return 'Hoy';
  if (diff === 1) return 'Hace 1 día';
  return `Hace ${diff} días`;
}

// Umbrales de GDP "excelente/aceptable" por categoria. Son los mismos umbrales que ya
// usa la cuenta real: Coronado (demo) debe evaluarse con este mismo criterio, no con un
// umbral fijo inventado.
export function obtenerUmbralesGDP(categoria) {
  const text = String(categoria || '').toLowerCase();
  if (/lactante/.test(text)) return { excelente: 0.7, aceptable: 0.4 };
  if (/destet/.test(text)) return { excelente: 0.8, aceptable: 0.5 };
  if (/novill[ao] de levante|levante/.test(text)) return { excelente: 0.75, aceptable: 0.45 };
  if (/novilla de desarrollo/.test(text)) return { excelente: 0.6, aceptable: 0.3 };
  if (/novill[ao] de ceba|novillo de desarrollo/.test(text)) return { excelente: 0.9, aceptable: 0.6 };
  if (/vaca/.test(text)) return { excelente: 0.3, aceptable: 0 };
  if (/toro/.test(text)) return { excelente: 0.4, aceptable: 0 };
  return { excelente: 0.8, aceptable: 0.5 };
}

function formatNumber(value) {
  return Number.isFinite(value)
    ? new Intl.NumberFormat('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)
    : null;
}

export function thresholdText(thresholds) {
  return `Excelente >= ${formatNumber(thresholds.excelente)} kg/día | Aceptable ${formatNumber(thresholds.aceptable)} a ${formatNumber(thresholds.excelente - 0.01)} kg/día | Crítico < ${formatNumber(thresholds.aceptable)} kg/día`;
}

export function technicalInterpretation(statusInfo, timeAlert) {
  if (statusInfo.label === 'Sin datos') return 'Se requieren al menos dos pesajes para interpretar el desempeño productivo.';
  if (statusInfo.label === 'Excelente') return 'Ganancia diaria de peso superior al estándar esperado para su categoría productiva.';
  if (statusInfo.label === 'Aceptable') return 'Ganancia diaria de peso dentro del rango esperado. Mantener seguimiento productivo.';
  if (timeAlert?.className === 'estado-vencida') return 'Se recomienda actualizar el seguimiento de pesaje y revisar nutrición, oferta forrajera y estado sanitario.';
  return 'Ganancia diaria de peso inferior al estándar esperado para la categoría actual. Revisar nutrición, oferta forrajera, sanidad, genética y manejo.';
}

export function classifyProductivity(gdpReciente, difference, hasEnoughData, thresholds) {
  if (!hasEnoughData) {
    return {
      label: 'Sin datos',
      className: 'estado-sin-programacion',
      icon: '⚪',
      description: 'Se requieren al menos dos pesajes para calcular tendencia productiva.',
    };
  }

  if ((Number.isFinite(difference) && difference < 0) || (Number.isFinite(gdpReciente) && gdpReciente < thresholds.aceptable)) {
    return {
      label: 'Crítico',
      className: 'estado-vencida',
      icon: '🔴',
      description: 'Ganancia diaria de peso inferior al estándar esperado para la categoría actual. Revisar nutrición, oferta forrajera, sanidad, genética y manejo.',
    };
  }

  if (gdpReciente >= thresholds.excelente) {
    return {
      label: 'Excelente',
      className: 'estado-vigente',
      icon: '🟢',
      description: 'Ganancia diaria de peso superior al estándar esperado para su categoría productiva.',
    };
  }

  return {
    label: 'Aceptable',
    trendLabel: 'Aceptable',
    className: 'estado-proxima',
    icon: '🟡',
    description: 'Ganancia diaria de peso dentro del rango esperado. Mantener seguimiento productivo.',
  };
}

export function classifyTimeSinceLastWeighing(days) {
  if (!Number.isFinite(days)) {
    return {
      label: 'Sin fecha',
      className: 'estado-sin-programacion',
      message: 'No existe fecha de último pesaje.',
    };
  }

  if (days <= 30) {
    return { label: 'Actualizado', className: 'estado-vigente', message: 'Pesaje actualizado.' };
  }

  if (days <= 60) {
    return { label: 'Recomendado', className: 'estado-proxima', message: 'Se recomienda nuevo pesaje.' };
  }

  return { label: 'Atrasado', className: 'estado-vencida', message: 'Alerta por falta de seguimiento.' };
}

export function classifyRow(row, thresholds = { excelente: 0.8, aceptable: 0.5 }) {
  if (row.es_peso_nacimiento || !Number.isFinite(row.peso_anterior)) return { label: 'Inicial', className: 'estado-sin-programacion' };
  if (Number.isFinite(row.diferencia_kg) && row.diferencia_kg < 0) return { label: 'Pérdida de peso', className: 'estado-vencida' };
  if (Number.isFinite(row.ganancia_diaria_kg) && row.ganancia_diaria_kg >= thresholds.excelente) return { label: 'Excelente', className: 'estado-vigente' };
  if (Number.isFinite(row.ganancia_diaria_kg) && row.ganancia_diaria_kg >= thresholds.aceptable) return { label: 'Aceptable', className: 'estado-proxima' };
  return { label: 'Crítico', className: 'estado-vencida' };
}

export function classForGdp(value, thresholds) {
  if (!Number.isFinite(value)) return 'estado-sin-programacion';
  if (value >= thresholds.excelente) return 'estado-vigente';
  if (value >= thresholds.aceptable) return 'estado-proxima';
  return 'estado-vencida';
}

export function classForDifference(value) {
  if (!Number.isFinite(value)) return 'estado-sin-programacion';
  if (value < 0) return 'estado-vencida';
  if (value === 0) return 'estado-proxima';
  return 'estado-vigente';
}

export function chartColorForState(className) {
  if (className === 'estado-vigente') return '#9aff00';
  if (className === 'estado-proxima') return '#ffd600';
  if (className === 'estado-vencida') return '#ff3b3b';
  return '#6ea8ff';
}

// Ganancia diaria de peso entre dos pesos con N dias de diferencia.
export function calcularGDP(pesoActual, pesoAnterior, dias) {
  if (!Number.isFinite(pesoActual) || !Number.isFinite(pesoAnterior) || !Number.isFinite(dias) || dias <= 0) return null;
  return (pesoActual - pesoAnterior) / dias;
}

// Enriquece cada pesaje con peso anterior, dias entre pesajes, GDP, edad en esa fecha,
// categoria evaluada en esa fecha y estado productivo segun umbral de esa categoria.
export function enrichRows(rows, categoriaProductiva, thresholds, animal) {
  const ordered = sortByDateAsc(rows).filter((row) => Number.isFinite(getPeso(row)));
  const fechaNacimiento = getFechaNacimientoProductiva(animal, ordered);
  return ordered.map((row, index) => {
    const previous = ordered[index - 1];
    const peso = getPeso(row);
    const pesoAnterior = previous ? getPeso(previous) : null;
    const currentDate = new Date(getFecha(row)).getTime();
    const previousDate = previous ? new Date(getFecha(previous)).getTime() : null;
    const birthWeightRow = isBirthWeightRow(row, previous);
    const dias = previous && Number.isFinite(currentDate) && Number.isFinite(previousDate)
      ? Math.max(0, Math.round((currentDate - previousDate) / 86400000))
      : null;
    const diferencia = Number.isFinite(peso) && Number.isFinite(pesoAnterior) ? peso - pesoAnterior : null;
    const gdp = calcularGDP(peso, pesoAnterior, dias);
    const edadPesaje = calcularEdadEnFecha(fechaNacimiento, getFecha(row));
    const edadMesesPesaje = edadPesaje?.edadMesesDecimal ?? null;
    const categoriaEvaluada = clasificarCategoriaPorEdadSexo(animal, getFecha(row), birthWeightRow || index === 0, fechaNacimiento) || categoriaProductiva;
    const rowThresholds = obtenerUmbralesGDP(categoriaEvaluada);
    const status = classifyRow({ ...row, peso_anterior: pesoAnterior, diferencia_kg: diferencia, ganancia_diaria_kg: gdp }, rowThresholds);
    return {
      ...row,
      peso_kg: peso,
      peso_anterior: pesoAnterior,
      diferencia_kg: diferencia,
      dias_entre_pesajes: dias,
      edad_meses_en_pesaje: edadMesesPesaje,
      edad_texto_en_pesaje: (birthWeightRow || index === 0) ? '----' : (edadPesaje?.edadTexto || '--'),
      ganancia_diaria_kg: gdp,
      estado_productivo: status.label,
      estado_productivo_class: status.className,
      es_peso_nacimiento: birthWeightRow,
      categoria_evaluada: categoriaEvaluada,
      umbrales_evaluados: rowThresholds,
    };
  });
}

// Tendencia reciente comparando los dos ultimos periodos con GDP valido.
export function calcularTendenciaPesajes(enrichedRows) {
  const periods = enrichedRows.filter((row) => Number.isFinite(row.ganancia_diaria_kg));
  const best = periods.reduce((acc, row) => (!acc || row.ganancia_diaria_kg > acc.ganancia_diaria_kg ? row : acc), null);
  const worst = periods.reduce((acc, row) => (!acc || row.ganancia_diaria_kg < acc.ganancia_diaria_kg ? row : acc), null);
  const hasComparativePeriods = periods.length >= 2;
  let tendencia = 'Sin datos';
  let trendClassName = 'estado-sin-programacion';
  const latest = periods[periods.length - 1];
  const previous = periods[periods.length - 2];
  if (latest && previous) {
    const diff = latest.ganancia_diaria_kg - previous.ganancia_diaria_kg;
    const tolerance = Math.abs(previous.ganancia_diaria_kg || 1) * 0.05;
    if (Math.abs(diff) <= tolerance) {
      tendencia = 'Estable';
      trendClassName = 'estado-proxima';
    } else if (diff > 0) {
      tendencia = 'Mejorando';
      trendClassName = 'estado-vigente';
    } else {
      tendencia = 'Empeorando';
      trendClassName = 'estado-vencida';
    }
  }
  return { best, worst, hasComparativePeriods, tendencia, trendClassName };
}
