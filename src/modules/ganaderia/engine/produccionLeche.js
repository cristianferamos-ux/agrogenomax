// Motor comun de produccion diaria de leche para Ganaderia Inteligente.
// La cuenta real todavia no tiene tabla ni API para esto (modulo "Futuro" segun
// el diseno de proposito productivo). La Cuenta Demo lo usa hoy con datos en
// sessionStorage, con el mismo criterio que deberia usar la cuenta real cuando
// el modulo exista — funciones puras, sin React, sin window/document, sin fetch.

import { valueOf, normalizeDateInput } from './edad.js';

function round1(value) {
  return Number.isFinite(value) ? Math.round(value * 10) / 10 : value;
}

function promedio(values) {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

// 1. Normaliza registros con forma libre (alias de campos) a la forma canonica
// { fecha, litros_dia, numero_ordenos, potrero_id, observaciones }, ordenados
// por fecha ascendente (del mas antiguo al mas reciente).
export function normalizarRegistrosLeche(registros = []) {
  return registros
    .map((registro) => {
      const ordenosRaw = valueOf(registro, ['numero_ordenos', 'ordenos']);
      return {
        fecha: normalizeDateInput(valueOf(registro, ['fecha', 'fecha_registro'])),
        litros_dia: Number(valueOf(registro, ['litros_dia', 'litros', 'litros_día'])),
        numero_ordenos: ordenosRaw === '' ? null : Number(ordenosRaw),
        potrero_id: valueOf(registro, ['potrero_id', 'potrero']) || null,
        observaciones: valueOf(registro, ['observaciones', 'notes']) || '',
      };
    })
    .filter((registro) => registro.fecha && Number.isFinite(registro.litros_dia))
    .sort((a, b) => new Date(`${a.fecha}T00:00:00`).getTime() - new Date(`${b.fecha}T00:00:00`).getTime());
}

// 2. Promedio de litros/dia sobre una ventana de N dias mas recientes.
// dias=undefined/null -> promedio sobre todos los registros disponibles.
export function calcularPromedioLeche(registrosOrdenados, dias) {
  const relevantes = Number.isFinite(dias) ? registrosOrdenados.slice(-dias) : registrosOrdenados;
  return round1(promedio(relevantes.map((registro) => registro.litros_dia)));
}

// 3. Suma de litros de los registros dados (no inventa un total de lactancia
// que no este respaldado por registros reales).
export function calcularProduccionAcumulada(registrosOrdenados) {
  return round1(registrosOrdenados.reduce((sum, registro) => sum + registro.litros_dia, 0));
}

// 4. Compara el promedio de una ventana reciente contra el promedio de la
// ventana base inmediatamente anterior (no superpuesta).
export function calcularVariacionLeche(registrosOrdenados, ventanaReciente, ventanaBase) {
  const total = registrosOrdenados.length;
  if (total < ventanaReciente + 1 || ventanaReciente <= 0) return null;

  const recientes = registrosOrdenados.slice(-ventanaReciente);
  const disponiblesParaBase = registrosOrdenados.slice(0, total - ventanaReciente);
  const base = disponiblesParaBase.slice(-ventanaBase);
  if (!base.length) return null;

  const promedioReciente = promedio(recientes.map((registro) => registro.litros_dia));
  const promedioBase = promedio(base.map((registro) => registro.litros_dia));
  const variacionPorcentaje = Number.isFinite(promedioBase) && promedioBase > 0
    ? round1(((promedioBase - promedioReciente) / promedioBase) * 100)
    : null;

  return {
    ventanaReciente,
    ventanaBase: base.length,
    promedioReciente: round1(promedioReciente),
    promedioBase: round1(promedioBase),
    variacionPorcentaje,
  };
}

// 5. Alerta de caida de produccion. Umbral: caida >= 15% en los ultimos 3 dias
// vs. el promedio de los dias base disponibles inmediatamente anteriores.
// No diagnostica enfermedad, no afirma una causa unica, no usa lenguaje
// veterinario cerrado — solo describe el dato y sugiere revisar variables de manejo.
export function detectarCaidaProduccion(registrosOrdenados) {
  const total = registrosOrdenados.length;
  const ventanaBaseDisponible = Math.max(0, total - 3);
  const variacion = calcularVariacionLeche(registrosOrdenados, 3, ventanaBaseDisponible);

  if (!variacion || !Number.isFinite(variacion.variacionPorcentaje)) {
    return { hayCaida: false, variacionPorcentaje: null };
  }

  if (variacion.variacionPorcentaje >= 15) {
    return {
      hayCaida: true,
      variacionPorcentaje: variacion.variacionPorcentaje,
      promedioReciente: variacion.promedioReciente,
      promedioBase: variacion.promedioBase,
      alerta: `Producción de leche cayó aproximadamente ${Math.round(variacion.variacionPorcentaje)}% en los últimos 3 días.`,
      interpretacion: 'Puede estar asociada a alimentación, disponibilidad de agua, cambio de potrero o estrés calórico.',
      recomendacion: 'Revisar agua, dieta y confort térmico.',
    };
  }

  return { hayCaida: false, variacionPorcentaje: variacion.variacionPorcentaje };
}

// 6. Etapa de lactancia por dias en leche: Temprana <100, Media 100-200, Tardía >200.
export function calcularEtapaLactancia(diasEnLeche) {
  if (!Number.isFinite(diasEnLeche)) return 'Sin datos';
  if (diasEnLeche < 100) return 'Temprana';
  if (diasEnLeche <= 200) return 'Media';
  return 'Tardía';
}

// 7. Resumen lechero consolidado — la unica fuente de verdad que debe consumir
// cualquier pantalla (demo hoy, cuenta real cuando el modulo exista).
export function calcularResumenLechero({ animal, registrosLeche }) {
  const registros = normalizarRegistrosLeche(registrosLeche);
  const hoy = registros.at(-1) || null;
  const diasEnLecheRaw = valueOf(animal, ['dias_en_leche', 'diasEnLeche']);
  const diasEnLeche = diasEnLecheRaw === '' ? null : Number(diasEnLecheRaw);
  const etapaLactancia = calcularEtapaLactancia(diasEnLeche);
  const caida = detectarCaidaProduccion(registros);

  const alertaPrincipal = caida.hayCaida ? caida.alerta : 'Sin alertas activas de producción.';
  const interpretacion = caida.hayCaida
    ? caida.interpretacion
    : 'Producción dentro del comportamiento reciente esperado.';
  const recomendacion = caida.hayCaida
    ? caida.recomendacion
    : 'Mantener el manejo actual y seguir registrando la producción diaria.';

  return {
    litros_hoy: hoy ? hoy.litros_dia : null,
    promedio_semanal: calcularPromedioLeche(registros, 7),
    promedio_historico: calcularPromedioLeche(registros),
    produccion_acumulada: calcularProduccionAcumulada(registros),
    dias_en_leche: Number.isFinite(diasEnLeche) ? diasEnLeche : null,
    etapa_lactancia: etapaLactancia,
    alerta_principal: alertaPrincipal,
    interpretacion,
    recomendacion,
    caida,
    registros,
  };
}

// 8. Estado general de produccion segun la caida detectada en el resumen.
export function obtenerEstadoProduccionLeche(resumen) {
  if (resumen?.caida?.hayCaida) {
    if (resumen.caida.variacionPorcentaje >= 25) {
      return { label: 'Crítico', className: 'estado-vencida' };
    }
    return { label: 'Atención', className: 'estado-proxima' };
  }
  return { label: 'Estable', className: 'estado-vigente' };
}
