// Motor comun de sanidad/vacunaciones para Ganaderia Inteligente.
// Extraido fielmente de AnimalVacunacionesTab.jsx.
// Criterio real: proxima a vencer cuando faltan 30 dias o menos.

import { normalizeDateValue } from '../utils/dateFormat.js';

export function todayISO() {
  const now = new Date();
  const timezoneOffset = now.getTimezoneOffset() * 60000;
  return new Date(now.getTime() - timezoneOffset).toISOString().slice(0, 10);
}

export function parseDate(value) {
  const date = normalizeDateValue(value);
  if (!date) return null;
  return new Date(`${date}T00:00:00`);
}

export function daysUntil(value) {
  const date = parseDate(value);
  if (!date) return null;
  const today = new Date(`${todayISO()}T00:00:00`);
  return Math.ceil((date.getTime() - today.getTime()) / 86400000);
}

// Vigente / Próxima a vencer (<=30 días) / Vencida / Sin programación.
export function vaccinationStatus(vacunacion) {
  const days = daysUntil(vacunacion.proxima_aplicacion || vacunacion.fecha_proxima);

  if (days === null) return 'Sin programación';
  if (days < 0) return 'Vencida';
  if (days <= 30) return 'Próxima a vencer';
  return 'Vigente';
}

export function remainingDaysLabel(vacunacion) {
  const days = daysUntil(vacunacion.proxima_aplicacion || vacunacion.fecha_proxima);

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

// Estado sanitario general agregado: Crítico si hay vencidas, Atención si hay próximas,
// Excelente si todas vigentes, Sin programación si no hay nada programado.
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

  if (resumen.vencidas === 0 && resumen.proximas === 0 && resumen.total > 0 && resumen.vigentes === resumen.total) {
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
