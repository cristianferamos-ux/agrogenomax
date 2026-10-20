// FASE 0 -- estado sanitario (vacunaciones). Funciones puras sobre fechas
// calendario 'YYYY-MM-DD'.
//
// Regla Business:
//   * El estado de cada VACUNA sale SOLO de su ÚLTIMA aplicación (agrupando
//     por catalogo_vacuna_id o, sin catálogo, por nombre normalizado). Una
//     dosis histórica ya reemplazada por un refuerzo no vuelve "vencido" al
//     animal (BUG-03).
//   * Estado por aplicación según la próxima fecha programada:
//       VENCIDA (< 0 días) > PROXIMA (<= diasAviso) > VIGENTE > SIN_PROGRAMACION.
//   * Estado general = el peor estado entre las vacunas; SIN_PROGRAMACION solo
//     si NINGUNA vacuna tiene programación (no degrada a las vigentes).
//   * diasAviso = 30 es CONFIGURACIÓN PROVISIONAL (criterio heredado de la UI),
//     no norma sanitaria oficial.
import { aFechaISO, diasEntre, fechaHoyLocal } from './fechas.js';

export const ESTADOS_VACUNA = Object.freeze(['VENCIDA', 'PROXIMA', 'VIGENTE', 'SIN_PROGRAMACION']);
const PRIORIDAD = Object.freeze({ VENCIDA: 0, PROXIMA: 1, VIGENTE: 2, SIN_PROGRAMACION: 3 });

function proximaFecha(aplicacion) {
  return aFechaISO(aplicacion?.proximaAplicacion ?? aplicacion?.proxima_aplicacion ?? aplicacion?.fechaProxima ?? aplicacion?.fecha_proxima);
}

function fechaAplicacion(aplicacion) {
  return aFechaISO(aplicacion?.fechaAplicacion ?? aplicacion?.fecha_aplicacion);
}

/** Estado de UNA aplicación en fechaObjetivo. */
export function estadoAplicacion(aplicacion, fechaObjetivo, { diasAviso = 30 } = {}) {
  const dias = diasEntre(fechaObjetivo, proximaFecha(aplicacion));
  if (dias === null) return { estado: 'SIN_PROGRAMACION', diasRestantes: null };
  if (dias < 0) return { estado: 'VENCIDA', diasRestantes: dias };
  if (dias <= diasAviso) return { estado: 'PROXIMA', diasRestantes: dias };
  return { estado: 'VIGENTE', diasRestantes: dias };
}

/** Clave de la vacuna: catálogo > nombre normalizado > la propia aplicación (no agrupable). */
export function claveVacuna(aplicacion, indice = 0) {
  const catalogo = aplicacion?.catalogoVacunaId ?? aplicacion?.catalogo_vacuna_id;
  if (catalogo !== null && catalogo !== undefined && catalogo !== '') return `catalogo:${catalogo}`;
  const nombre = String(aplicacion?.vacuna ?? aplicacion?.nombreVacuna ?? aplicacion?.nombre_vacuna ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (nombre) return `nombre:${nombre}`;
  const id = aplicacion?.vacunacionId ?? aplicacion?.vacunacion_id;
  return `aplicacion:${id ?? `#${indice}`}`;
}

/** Última aplicación de cada vacuna (por fecha de aplicación y, a igual fecha, la posterior en la lista). */
export function ultimasAplicacionesPorVacuna(aplicaciones = []) {
  const porClave = new Map();
  aplicaciones.forEach((aplicacion, indice) => {
    const clave = claveVacuna(aplicacion, indice);
    const actual = porClave.get(clave);
    const nueva = fechaAplicacion(aplicacion);
    if (!actual) {
      porClave.set(clave, { clave, aplicacion, indice });
      return;
    }
    const diff = diasEntre(fechaAplicacion(actual.aplicacion), nueva);
    if (diff === null ? nueva !== null : diff >= 0) porClave.set(clave, { clave, aplicacion, indice });
  });
  return [...porClave.values()];
}

/**
 * Resumen sanitario por vacuna en fechaObjetivo.
 * estadoGeneral: VENCIDA | PROXIMA | VIGENTE | SIN_PROGRAMACION | SIN_REGISTROS.
 */
export function resumenSanitario(aplicaciones = [], fechaObjetivo, opciones = {}) {
  const porVacuna = ultimasAplicacionesPorVacuna(aplicaciones).map(({ clave, aplicacion }) => ({
    clave,
    aplicacion,
    ...estadoAplicacion(aplicacion, fechaObjetivo, opciones),
  }));
  const contar = (estado) => porVacuna.filter((v) => v.estado === estado).length;
  const estadoGeneral = porVacuna.length === 0
    ? 'SIN_REGISTROS'
    : porVacuna.reduce((peor, v) => (PRIORIDAD[v.estado] < PRIORIDAD[peor] ? v.estado : peor), 'SIN_PROGRAMACION');
  return {
    totalVacunas: porVacuna.length,
    vencidas: contar('VENCIDA'),
    proximas: contar('PROXIMA'),
    vigentes: contar('VIGENTE'),
    sinProgramacion: contar('SIN_PROGRAMACION'),
    estadoGeneral,
    porVacuna,
  };
}

// ---------------------------------------------------------------------------
// Adaptadores de presentación para la Demo y la UI huérfana legacy (etiquetas
// en español y clases CSS). Usan la misma regla de fechas calendario.
// ---------------------------------------------------------------------------

export function todayISO() {
  return fechaHoyLocal();
}

export function parseDate(value) {
  const date = aFechaISO(value);
  return date ? new Date(`${date}T00:00:00`) : null;
}

export function daysUntil(value, hoy = todayISO()) {
  return diasEntre(hoy, value);
}

const ETIQUETAS = Object.freeze({
  VENCIDA: 'Vencida',
  PROXIMA: 'Próxima a vencer',
  VIGENTE: 'Vigente',
  SIN_PROGRAMACION: 'Sin programación',
});

// Vigente / Próxima a vencer (<=30 días) / Vencida / Sin programación (por aplicación).
export function vaccinationStatus(vacunacion, hoy = todayISO()) {
  return ETIQUETAS[estadoAplicacion(vacunacion, hoy).estado];
}

export function remainingDaysLabel(vacunacion, hoy = todayISO()) {
  const days = daysUntil(proximaFecha(vacunacion), hoy);
  if (days === null) return 'Sin programación';
  if (days === 0) return 'Vence hoy';
  if (days < 0) return `Vencida hace ${Math.abs(days)} días`;
  return `Vence en ${days} días`;
}

export function alertClass(alerta) {
  if (alerta === 'Vencida') return 'estado-vencida';
  if (alerta === 'Próxima a vencer') return 'estado-proxima';
  if (alerta === 'Vigente') return 'estado-vigente';
  return 'estado-sin-programacion';
}

// Estado general a partir de conteos (vencidas/proximas/vigentes) que el
// consumidor DEBE calcular sobre la última aplicación de cada vacuna
// (resumenSanitario). FASE 0: si hay vigentes y ninguna vencida/próxima es
// "Excelente" aunque existan vacunas sin programación.
export function sanitaryGeneralStatus(resumen) {
  if (resumen.vencidas > 0) {
    return {
      label: 'Crítico',
      icon: '🔴',
      className: 'estado-vencida',
      description: 'Existe al menos una vacuna vencida.',
    };
  }

  if (resumen.proximas > 0) {
    return {
      label: 'Atención',
      icon: '🟡',
      className: 'estado-proxima',
      description: 'Existe al menos una vacuna próxima a vencer.',
    };
  }

  if (resumen.vigentes > 0) {
    return {
      label: 'Excelente',
      icon: '🟢',
      className: 'estado-vigente',
      description: 'Todas las vacunas programadas están vigentes.',
    };
  }

  return {
    label: 'Sin programación',
    icon: '⚪',
    className: 'estado-sin-programacion',
    description: 'No hay próximas aplicaciones programadas.',
  };
}

export function complianceClass(resumen) {
  if (resumen.vencidas > 0) return 'estado-vencida';
  if (resumen.proximas > 0) return 'estado-proxima';
  return 'estado-vigente';
}
