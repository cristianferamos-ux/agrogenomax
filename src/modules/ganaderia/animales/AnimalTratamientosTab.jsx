import {
  AlertTriangle,
  DollarSign,
  Download,
  FileText,
  Hourglass,
  Pill,
  Save,
  ShieldCheck,
  Stethoscope,
  Timer,
  TrendingUp,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ganaderiaApi } from '../api/ganaderiaApi.js';
import { FormField, StatusMessage } from '../components/FormField.jsx';
import { createClinicalHistoryPdfBlob, clinicalHistoryFileName } from './clinicalHistoryPdf.js';

const today = () => new Date().toISOString().slice(0, 10);

const emptyForm = {
  fecha_inicio: today(),
  fecha_finalizacion: '',
  motivo: '',
  diagnostico: '',
  sintomas: '',
  estado_caso: 'En tratamiento',
  nombre_comercial: '',
  principio_activo: '',
  laboratorio: '',
  lote: '',
  fecha_vencimiento: '',
  dosis: '',
  unidad: '',
  via_aplicacion: '',
  frecuencia: '',
  duracion_dias: '',
  retiro_carne_dias: '',
  retiro_leche_dias: '',
  fecha_fin_retiro_carne: '',
  fecha_fin_retiro_leche: '',
  costo_medicamento: '',
  costo_veterinario: '',
  costo_mano_obra: '',
  otros_costos: '',
  profesional: '',
  profesion: '',
  matricula: '',
  entidad: '',
  observaciones: '',
};

const emptyEvidence = {
  nombre: '',
  tipo: 'Foto de lesión',
  fecha: today(),
  observacion: '',
};

const evidenceTypes = [
  'Foto de lesión',
  'Foto de medicamento',
  'Fórmula veterinaria',
  'Resultado de laboratorio',
  'Ecografía',
  'Documento clínico',
  'Otro',
];

const applicationRoutes = [
  'Intramuscular',
  'Subcutánea',
  'Intravenosa',
  'Oral',
  'Tópica',
  'Intramamaria',
  'Otra',
];

const caseStatuses = [
  'En tratamiento',
  'Seguimiento',
  'Recuperado',
  'Crónico',
  'Crítico',
  'Descartado',
  'Fallecido',
];

function valueOf(row, aliases) {
  return aliases.map((key) => row?.[key]).find((value) => value !== undefined && value !== null && value !== '') || '';
}

function animalLabel(animal, fallback = 'Animal') {
  return valueOf(animal, ['nombre', 'name', 'codigo_interno', 'codigo']) || fallback;
}

function animalQrLabel(animal) {
  const explicit = valueOf(animal, ['codigo_qr', 'qr_codigo', 'qr', 'codigoQr']);
  if (explicit) return explicit;
  const internal = valueOf(animal, ['codigo_interno', 'numero_arete', 'codigo']);
  const digits = String(internal || '').replace(/\D/g, '');
  return digits ? `AGX-${digits.padStart(6, '0')}` : '--';
}

function normalizeSex(value) {
  const sex = String(value || '').trim().toLowerCase();
  if (['macho', 'm', 'male'].includes(sex)) return 'macho';
  if (['hembra', 'h', 'female'].includes(sex)) return 'hembra';
  return '';
}

function formatDate(value) {
  if (!value) return '--';
  const [year, month, day] = String(value).slice(0, 10).split('-');
  return year && month && day ? `${day}-${month}-${year}` : String(value);
}

function daysBetween(a, b) {
  if (!a || !b) return null;
  const start = new Date(`${String(a).slice(0, 10)}T00:00:00`).getTime();
  const end = new Date(`${String(b).slice(0, 10)}T00:00:00`).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.round((end - start) / 86400000);
}

function daysSince(value) {
  const days = daysBetween(value, today());
  if (!Number.isFinite(days)) return '--';
  if (days === 0) return 'Hoy';
  if (days === 1) return 'Hace 1 día';
  return `Hace ${days} días`;
}

function daysRemaining(value) {
  const days = daysBetween(today(), value);
  if (!Number.isFinite(days)) return '--';
  if (days < 0) return 'Finalizado';
  if (days === 0) return 'Libera hoy';
  return `Faltan ${days} días`;
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') return 0;
  const parsed = Number(String(value).replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatMoney(value) {
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(Number(value) || 0);
}

function formatMetric(value, suffix = '') {
  return Number.isFinite(value)
    ? `${new Intl.NumberFormat('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)}${suffix}`
    : '--';
}

function getBirthDate(animal) {
  return valueOf(animal, ['fecha_nacimiento', 'fechaNacimiento', 'nacimiento', 'fecha_nac', 'birth_date']);
}

function ageMonths(animal) {
  const direct = toNumber(valueOf(animal, ['edad_meses', 'edadMeses']));
  if (direct > 0) return direct;
  const birth = getBirthDate(animal);
  const days = birth ? daysBetween(birth, today()) : null;
  return Number.isFinite(days) && days >= 0 ? days / 30.44 : null;
}

function ageLabel(animal) {
  const months = ageMonths(animal);
  if (!Number.isFinite(months)) return '--';
  if (months < 2) {
    const days = Math.max(0, Math.round(months * 30.44));
    if (days === 0) return '0 días';
    if (days < 30) return `${days} días`;
    return `1 mes y ${days - 30} días`;
  }
  return `${Math.floor(months)} meses`;
}

function productiveCategory(animal) {
  const months = ageMonths(animal);
  const sex = normalizeSex(valueOf(animal, ['sexo', 'sex']));
  if (!Number.isFinite(months)) return 'Categoría no determinada';
  if (sex === 'hembra') {
    if (months < 8) return 'Ternera lactante';
    if (months < 12) return 'Ternera desteta';
    if (months < 24) return 'Novilla de levante';
    if (months < 36) return 'Novilla de desarrollo';
    return 'Vaca adulta';
  }
  if (sex === 'macho') {
    if (months < 8) return 'Ternero lactante';
    if (months < 12) return 'Ternero desteto';
    if (months < 24) return 'Novillo de levante';
    if (months < 36) return 'Novillo de Ceba';
    return 'Toro adulto';
  }
  if (months < 8) return 'Cría lactante';
  if (months < 12) return 'Cría desteta';
  if (months < 24) return 'Animal de levante';
  if (months < 36) return 'Animal en desarrollo';
  return 'Adulto productivo';
}

function statusClass(status) {
  const text = String(status || '').toLowerCase();
  if (/recuperado|sano|bajo|finalizado|mejor/.test(text)) return 'estado-vigente';
  if (/seguimiento|retiro|tratamiento|medio|activo|estable/.test(text)) return 'estado-proxima';
  if (/crónico|cronico|crítico|critico|alto|fallecido|disminuyó|disminuyo|deterioro|empeoró|empeoro/.test(text)) return 'estado-vencida';
  return 'estado-sin-programacion';
}

function treatmentCostBreakdown(row) {
  return {
    medicamento: toNumber(row?.costo_medicamento),
    veterinario: toNumber(row?.costo_veterinario),
    manoObra: toNumber(row?.costo_mano_obra),
    otros: toNumber(row?.otros_costos),
  };
}

function treatmentTotal(row) {
  const cost = treatmentCostBreakdown(row);
  return cost.medicamento + cost.veterinario + cost.manoObra + cost.otros;
}

function addDays(date, days) {
  if (!date || !Number.isFinite(Number(days)) || Number(days) <= 0) return '';
  const next = new Date(`${date}T00:00:00`);
  next.setDate(next.getDate() + Number(days));
  return next.toISOString().slice(0, 10);
}

function withdrawalState(date) {
  if (!date) return { label: 'Sin restricción', className: 'estado-vigente' };
  return date >= today()
    ? { label: 'Activo', className: 'estado-proxima', release: formatDate(date), countdown: daysRemaining(date) }
    : { label: 'Finalizado', className: 'estado-vigente', release: formatDate(date), countdown: 'Finalizado' };
}

function buildAlerts(rows) {
  const now = today();
  const alerts = [];
  rows.forEach((row) => {
    if (row.fecha_fin_retiro_carne && row.fecha_fin_retiro_carne >= now) {
      alerts.push({ type: 'Retiro carne', text: `No apto para sacrificio hasta ${formatDate(row.fecha_fin_retiro_carne)}.`, className: 'estado-proxima' });
    }
    if (row.fecha_fin_retiro_leche && row.fecha_fin_retiro_leche >= now) {
      alerts.push({ type: 'Retiro leche', text: `Leche no apta para consumo hasta ${formatDate(row.fecha_fin_retiro_leche)}.`, className: 'estado-proxima' });
    }
    if (String(row.estado_caso).toLowerCase().includes('crítico') || String(row.estado_caso).toLowerCase().includes('critico')) {
      alerts.push({ type: 'Caso crítico', text: 'Requiere seguimiento profesional inmediato.', className: 'estado-vencida' });
    }
    if (row.fecha_vencimiento && row.fecha_inicio && row.fecha_vencimiento < row.fecha_inicio) {
      alerts.push({ type: 'Medicamento vencido', text: 'Fecha de vencimiento anterior al tratamiento.', className: 'estado-vencida' });
    }
  });

  const byDiagnosis = rows.reduce((acc, row) => {
    const key = String(row.diagnostico || '').trim().toLowerCase();
    if (!key) return acc;
    acc[key] = [...(acc[key] || []), row];
    return acc;
  }, {});

  Object.entries(byDiagnosis).forEach(([diagnosis, group]) => {
    const recent = group.filter((row) => Math.abs(daysBetween(row.fecha_inicio, today()) || 9999) <= 180);
    if (recent.length >= 3) {
      alerts.push({ type: 'Reincidencia', text: `Reincidencia clínica detectada: ${diagnosis}.`, className: 'estado-vencida' });
    }
  });

  return alerts;
}

function productiveImpact(rows, pesajes) {
  if (!rows.length || !pesajes.length) return null;
  const latest = [...rows].sort((a, b) => String(b.fecha_inicio).localeCompare(String(a.fecha_inicio)))[0];
  const ordered = [...pesajes].sort((a, b) => String(a.fecha_pesaje).localeCompare(String(b.fecha_pesaje)));
  const before = ordered.filter((row) => row.fecha_pesaje < latest.fecha_inicio && Number.isFinite(Number(row.ganancia_diaria_kg))).at(-1);
  const after = ordered.filter((row) => row.fecha_pesaje >= latest.fecha_inicio && Number.isFinite(Number(row.ganancia_diaria_kg))).at(0);
  if (!before || !after) return null;
  const gdpBefore = Number(before.ganancia_diaria_kg);
  const gdpAfter = Number(after.ganancia_diaria_kg);
  const variation = gdpBefore > 0 ? ((gdpAfter - gdpBefore) / gdpBefore) * 100 : null;
  return { gdpBefore, gdpAfter, variation, deltaGdp: gdpAfter - gdpBefore };
}

function impactLabel(impact) {
  if (!impact || !Number.isFinite(impact.variation)) return '--';
  const prefix = impact.variation >= 0 ? 'MEJORÓ +' : 'DISMINUYÓ ';
  return `${prefix}${formatMetric(impact.variation, '%')}`;
}

function reproductiveImpact(rows, animal, resumen) {
  const sex = normalizeSex(valueOf(animal, ['sexo', 'sex']));
  const category = productiveCategory(animal).toLowerCase();
  const status = String(resumen?.estado || '').toLowerCase();
  const trigger = rows.find((row) => /metritis|mastitis|retención placenta|retencion placenta|anestro|cojera/i.test(row.diagnostico || ''));
  if (sex === 'hembra') {
    const reproductiveRole = /vaca|vientre|receptora|donadora|lactante|novilla/.test(category);
    if (trigger && (status.includes('tratamiento') || status.includes('crítico'))) {
      return {
        level: 'Riesgo reproductivo alto',
        diagnosis: trigger.diagnostico,
        message: reproductiveRole ? 'Reevaluar antes de protocolo reproductivo o embrionario.' : 'Revisar evolución sanitaria antes de decisiones reproductivas.',
        effects: ['Retorno al celo', 'Tasa de concepción', 'Fertilidad', 'Producción'],
        className: 'estado-vencida',
      };
    }
    if (trigger) {
      return {
        level: 'Seguimiento reproductivo',
        diagnosis: trigger.diagnostico,
        message: 'Animal en seguimiento. Confirmar recuperación antes de protocolo reproductivo.',
        effects: ['Retorno al celo', 'Fertilidad', 'Condición corporal'],
        className: 'estado-proxima',
      };
    }
    return {
      level: 'Animal apto para programa reproductivo',
      diagnosis: '',
      message: 'No se identifican eventos clínicos con impacto reproductivo directo.',
      effects: [],
      className: 'estado-vigente',
    };
  }
  if (sex === 'macho' && /reproductor|toro/.test(category) && trigger) {
    return {
      level: 'Seguimiento reproductivo del macho',
      diagnosis: trigger.diagnostico,
      message: 'Verificar condición clínica antes de uso reproductivo.',
      effects: ['Libido', 'Aptitud reproductiva', 'Condición corporal'],
      className: 'estado-proxima',
    };
  }
  return null;
}

function clinicalInterpretation({ impact, resumen }) {
  if (!impact) {
    return {
      title: 'Sin datos suficientes para estimar impacto productivo.',
      text: 'Registra pesajes antes y después del tratamiento para que AgroGenomaX estime recuperación, deterioro o estabilidad productiva.',
      recommendations: ['Registrar nuevo pesaje de seguimiento', 'Mantener observación clínica', 'Verificar consumo e hidratación'],
      className: statusClass(resumen.estado),
    };
  }
  if (impact.variation < -10) {
    return {
      title: 'Deterioro productivo posterior al evento clínico.',
      text: 'El GDP posterior disminuyó frente al periodo previo. Se recomienda revisar nutrición, sanidad, manejo y recuperación clínica.',
      recommendations: ['Revisar condición corporal', 'Revisar consumo y oferta forrajera', 'Evaluar dolor, fiebre o recaída', 'Programar control veterinario', 'Programar nuevo pesaje'],
      className: 'estado-vencida',
    };
  }
  if (impact.variation > 10) {
    return {
      title: 'Recuperación productiva favorable.',
      text: 'El GDP posterior muestra mejora frente al periodo previo al tratamiento.',
      recommendations: ['Mantener manejo actual', 'Confirmar recuperación clínica', 'Programar pesaje de control'],
      className: 'estado-vigente',
    };
  }
  return {
    title: 'Desempeño productivo estable.',
    text: 'La variación posterior al tratamiento se mantiene dentro de un rango moderado.',
    recommendations: ['Continuar seguimiento', 'Revisar evolución de síntomas', 'Validar finalización de retiros'],
    className: 'estado-proxima',
  };
}

function riskLevel(alertCount) {
  if (alertCount === 0) return { label: 'Bajo', className: 'estado-vigente' };
  if (alertCount <= 2) return { label: 'Medio', className: 'estado-proxima' };
  return { label: 'Alto', className: 'estado-vencida' };
}

function sanitaryIndex({ tratamientos, alerts, retiroActivo, costo, impact, duracion }) {
  let score = 100;
  score -= tratamientos.filter((row) => row.estado_caso === 'En tratamiento').length * 10;
  score -= tratamientos.filter((row) => ['Crítico', 'Crónico'].includes(row.estado_caso)).length * 15;
  if (retiroActivo) score -= 10;
  score -= alerts.filter((alert) => alert.type === 'Reincidencia').length * 5;
  if (costo >= 500000) score -= 5;
  if (duracion?.days > 15) score -= 5;
  if (impact?.variation < -10) score -= 10;
  if (impact?.variation > 10) score += 5;
  return Math.max(0, Math.round(score));
}

function sanitaryClassification(score, resumen) {
  if (score >= 95) {
    return { label: 'AGX-A+ Elite sanitario', recommendation: 'Apto para reproducción y comercialización.', className: 'estado-vigente' };
  }
  if (score >= 85) {
    return { label: 'A Salud estable', recommendation: 'Apto comercialización. Mantener seguimiento sanitario.', className: 'estado-vigente' };
  }
  if (score >= 70) {
    return { label: 'B Seguimiento recomendado', recommendation: 'Seguimiento veterinario recomendado.', className: 'estado-proxima' };
  }
  const finalStatus = String(resumen?.estado || '').toLowerCase();
  return {
    label: 'C Riesgo sanitario',
    recommendation: finalStatus.includes('crítico') ? 'Evaluar descarte productivo.' : 'Reforzar manejo clínico y seguimiento profesional.',
    className: 'estado-vencida',
  };
}

function recurrenceAnalysis(rows) {
  const groups = rows.reduce((acc, row) => {
    const key = String(row.diagnostico || 'Sin diagnóstico').trim();
    acc[key] = [...(acc[key] || []), row];
    return acc;
  }, {});
  const [pathology = 'Sin registros', events = []] = Object.entries(groups).sort((a, b) => b[1].length - a[1].length)[0] || [];
  const count = events.length || 0;
  const last = [...events].sort((a, b) => String(b.fecha_inicio).localeCompare(String(a.fecha_inicio)))[0];
  if (count >= 3) return { pathology, count, lastDate: last?.fecha_inicio, state: 'Recurrente / posible descarte', className: 'estado-vencida' };
  if (count === 2) return { pathology, count, lastDate: last?.fecha_inicio, state: 'Seguimiento', className: 'estado-proxima' };
  return { pathology, count, lastDate: last?.fecha_inicio, state: 'Sin reincidencia', className: 'estado-vigente' };
}

function sanitaryPrediction({ resumen, impact, recurrence }) {
  let recovery = 92;
  if (resumen.estado === 'Crítico') recovery -= 28;
  if (resumen.estado === 'En tratamiento') recovery -= 15;
  if (resumen.duracion?.days > 15) recovery -= 10;
  if (recurrence.count >= 3) recovery -= 20;
  if (impact?.variation < -10) recovery -= 15;
  if (impact?.variation > 10) recovery += 6;
  recovery = Math.max(15, Math.min(98, Math.round(recovery)));
  const relapse = recurrence.count >= 3 || recovery < 60 ? 'Alto' : recurrence.count === 2 || recovery < 80 ? 'Medio' : 'Bajo';
  const days = relapse === 'Alto' ? 7 : relapse === 'Medio' ? 15 : 30;
  const next = new Date(`${today()}T00:00:00`);
  next.setDate(next.getDate() + days);
  return {
    recovery,
    relapse,
    reviewDays: days,
    reviewDate: next.toISOString().slice(0, 10),
    className: relapse === 'Alto' ? 'estado-vencida' : relapse === 'Medio' ? 'estado-proxima' : 'estado-vigente',
  };
}

function economicResult(economia) {
  if (!economia.available || economia.valorRecuperado === null || economia.costoTratamiento <= 0) {
    return {
      label: 'Sin datos suficientes',
      text: 'Sin datos suficientes para calcular retorno sanitario.',
      className: 'estado-sin-programacion',
    };
  }
  const recoveredByPeso = economia.valorRecuperado / economia.costoTratamiento;
  if (economia.valorRecuperado > economia.costoTratamiento * 1.05) {
    return {
      label: 'TRATAMIENTO RENTABLE',
      text: `Cada $1 invertido recuperó $${formatMetric(recoveredByPeso)}.`,
      className: 'estado-vigente',
    };
  }
  if (Math.abs(economia.valorRecuperado - economia.costoTratamiento) <= economia.costoTratamiento * 0.05) {
    return {
      label: 'PUNTO DE EQUILIBRIO',
      text: `Cada $1 invertido recuperó $${formatMetric(recoveredByPeso)}.`,
      className: 'estado-proxima',
    };
  }
  return {
    label: 'TRATAMIENTO NO RENTABLE',
    text: `Cada $1 invertido recuperó $${formatMetric(recoveredByPeso)}.`,
    className: 'estado-vencida',
  };
}

function recommendedDecision({ resumen, score, recurrence }) {
  const lowRisk = resumen.indiceSanitario >= 90 && recurrence.count <= 1;
  const highRisk = resumen.indiceSanitario < 70 || resumen.riesgo.label === 'Alto' || recurrence.count >= 3;
  if (lowRisk) {
    return {
      title: 'MANTENER',
      className: 'estado-vigente',
      items: [
        'Mantener animal en sistema productivo.',
        'Continuar seguimiento sanitario normal.',
        'Apto para reproducción/comercialización según categoría.',
        'Programar control preventivo.',
      ],
    };
  }
  if (highRisk) {
    return {
      title: 'EVALUAR DESCARTE',
      className: 'estado-vencida',
      items: [
        'Revisar permanencia productiva.',
        'Evaluar descarte sanitario/productivo.',
        'Revisar costos acumulados.',
        'Priorizar valoración profesional.',
      ],
    };
  }
  return {
    title: 'OBSERVAR',
    className: 'estado-proxima',
    items: [
      'Mantener en observación.',
      'Programar control veterinario.',
      'Revisar evolución productiva en próximo pesaje.',
      'Evaluar reincidencia.',
    ],
  };
}

function productiveResultLabel(impact) {
  if (!impact) return { label: 'No evaluado', className: 'estado-sin-programacion' };
  if (impact.variation > 5) return { label: 'Mejoró', className: 'estado-vigente' };
  if (impact.variation < -5) return { label: 'Empeoró', className: 'estado-vencida' };
  return { label: 'Estable', className: 'estado-proxima' };
}

function generalClinicalBadge(resumen) {
  if (resumen.retiroActivo || resumen.riesgo.label === 'Alto') {
    return { label: 'RESTRINGIDO', className: 'estado-vencida' };
  }
  if (resumen.riesgo.label === 'Medio' || resumen.indiceSanitario < 90) {
    return { label: 'EN OBSERVACIÓN', className: 'estado-proxima' };
  }
  return { label: 'APTO', className: 'estado-vigente' };
}

function recoveryClass(value) {
  if (value <= 40) return 'estado-vencida';
  if (value <= 75) return 'estado-proxima';
  return 'estado-vigente';
}

function sanitaryTrend({ impact, recurrence, resumen }) {
  if (recurrence.count >= 3 || resumen.riesgo.label === 'Alto' || impact?.variation < -5) {
    return { label: 'Empeorando', className: 'estado-vencida' };
  }
  if (impact?.variation > 5 || resumen.estado === 'Recuperado') {
    return { label: 'Mejorando', className: 'estado-vigente' };
  }
  return { label: 'Estable', className: 'estado-proxima' };
}

function sanitaryEventCode(row, rows) {
  const sorted = [...rows].sort((a, b) => {
    const dateCompare = String(a.fecha_inicio || '').localeCompare(String(b.fecha_inicio || ''));
    if (dateCompare !== 0) return dateCompare;
    return String(a.tratamiento_id || '').localeCompare(String(b.tratamiento_id || ''));
  });
  const index = sorted.findIndex((item) => item.tratamiento_id === row.tratamiento_id);
  const [year = new Date().getFullYear()] = String(row.fecha_inicio || today()).split('-');
  return `SAN-${year}-${String(Math.max(0, index) + 1).padStart(6, '0')}`;
}

function clinicalDuration(row) {
  if (!row?.fecha_inicio) return null;
  const end = row.fecha_finalizacion || today();
  const days = daysBetween(row.fecha_inicio, end);
  return {
    days: Number.isFinite(days) ? Math.max(0, days) : null,
    start: row.fecha_inicio,
    end: row.fecha_finalizacion || '',
    active: !row.fecha_finalizacion,
    status: row.estado_caso || '--',
  };
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  })[char]);
}

function economicImpact({ impact, costo, precioKg }) {
  const price = toNumber(precioKg);
  if (!impact || price <= 0) {
    return {
      available: false,
      message: 'Información insuficiente para estimación económica.',
      costoTratamiento: costo,
      recuperacionProductiva: null,
      valorRecuperado: null,
      perdidaProductiva: null,
      perdidaEvitada: null,
      retorno: null,
    };
  }
  const diasRecuperacion = 30;
  const kgRecuperados = impact.deltaGdp * diasRecuperacion;
  const value = Math.abs(kgRecuperados) * price;
  const retorno = costo > 0 ? (value - costo) / costo : null;
  return {
    available: true,
    message: 'El tratamiento no solo representa un costo sanitario, también puede evitar pérdidas productivas futuras.',
    costoTratamiento: costo,
    recuperacionProductiva: impact.deltaGdp,
    valorRecuperado: kgRecuperados > 0 ? value : 0,
    perdidaProductiva: kgRecuperados < 0 ? value : 0,
    perdidaEvitada: kgRecuperados > 0 ? value : 0,
    retorno,
  };
}

function openClinicalPrint({ animal, razas, rows, resumen, alerts, impact, clinical, reproductive, evidencias, economia, economicStatus, recurrence, prediction, score, decision, trend }) {
  const safe = escapeHtml;
  const rowsHtml = rows.map((row) => `
    <article class="clinical-card">
      <header><strong>${safe(row.diagnostico || 'Sin diagnóstico')}</strong><span>${safe(row.estado_caso || '--')}</span></header>
      <div class="grid">
        <p><b>Código evento</b>${safe(sanitaryEventCode(row, rows))}</p>
        <p><b>Fecha</b>${safe(formatDate(row.fecha_inicio))}</p>
        <p><b>Medicamento</b>${safe(row.nombre_comercial || '--')}</p>
        <p><b>Principio activo</b>${safe(row.principio_activo || '--')}</p>
        <p><b>Dosis</b>${safe(`${row.dosis || '--'} ${row.unidad || ''}`)}</p>
        <p><b>Duración</b>${safe(row.duracion_dias || '--')} días</p>
        <p><b>Retiro carne</b>${safe(row.fecha_fin_retiro_carne ? formatDate(row.fecha_fin_retiro_carne) : '--')}</p>
        <p><b>Retiro leche</b>${safe(row.fecha_fin_retiro_leche ? formatDate(row.fecha_fin_retiro_leche) : '--')}</p>
        <p><b>Costo total</b>${safe(formatMoney(treatmentTotal(row)))}</p>
        <p><b>Responsable</b>${safe(row.profesional || 'No registrado')}</p>
      </div>
    </article>
  `).join('');

  const timelineHtml = rows.map((row) => `
    <article class="clinical-card">
      <header><strong>${safe(formatDate(row.fecha_inicio))}</strong><span>${safe(sanitaryEventCode(row, rows))}</span></header>
      <div class="grid">
        <p><b>Tipo evento</b>Tratamiento</p>
        <p><b>Descripción</b>${safe(row.diagnostico || 'Sin diagnóstico')}</p>
        <p><b>Tratamiento</b>${safe(row.nombre_comercial || '--')}</p>
        <p><b>Costo</b>${safe(formatMoney(treatmentTotal(row)))}</p>
        <p><b>Resultado productivo</b>${safe(productiveResultLabel(impact).label)}</p>
      </div>
    </article>
  `).join('');

  const evidenciasHtml = evidencias.length
    ? evidencias.map((item) => `<div class="grid"><p><b>Archivo</b>${safe(item.nombre)}</p><p><b>Tipo</b>${safe(item.tipo)}</p><p><b>Fecha captura</b>${safe(formatDate(item.fecha))}</p><p><b>Georreferencia</b>${safe(item.georreferencia ? 'Disponible' : 'No disponible')}</p><p><b>Observación</b>${safe(item.observacion || 'Sin observación')}</p></div>`).join('')
    : '<p>No hay evidencias clínicas registradas.</p>';

  const win = window.open('', '_blank', 'noopener,noreferrer');
  if (!win) throw new Error('No se pudo abrir la ventana de impresión.');
  win.document.write(`<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Historia clínica ${safe(animalLabel(animal))}</title><style>
    *{box-sizing:border-box} body{font-family:Arial,sans-serif;color:#0f172a;margin:24px;line-height:1.35}
    h1,h2,h3,p{margin:0} h1{font-size:30px} h2{color:#008ca0;border-bottom:2px solid #9aff00;margin:22px 0 12px;padding-bottom:7px}
    .brand{display:flex;justify-content:space-between;gap:24px;align-items:flex-start;border-bottom:4px solid #9aff00;padding-bottom:18px;margin-bottom:20px}
    .brand small{display:block;color:#475569;font-weight:700;margin-top:4px}.qr{border:2px solid #008ca0;padding:12px;text-align:center;min-width:130px}
    .panel,.clinical-card{border:1px solid #d7dee8;border-left:6px solid #00a7c2;padding:15px;margin:14px 0;page-break-inside:avoid;background:#fff}
    .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px 14px}.grid p{border:1px solid #e2e8f0;padding:10px;min-height:52px;overflow-wrap:break-word}
    b{display:block;color:#64748b;font-size:10px;text-transform:uppercase;margin-bottom:4px}.metric{font-size:18px;font-weight:800;color:#0f172a}
    .clinical-card header{display:flex;justify-content:space-between;gap:12px;background:#0b1620;color:#fff;margin:-15px -15px 12px;padding:12px 15px}
    .clinical-card header span{border:1px solid #9aff00;border-radius:999px;padding:5px 10px;color:#9aff00;font-weight:800}
    ul{margin:8px 0 0 18px;padding:0}.footer{border-top:1px solid #cbd5e1;margin-top:24px;padding-top:16px;page-break-inside:avoid}
    @media print{body{margin:16mm 14mm}.panel,.clinical-card{break-inside:avoid}.brand{break-inside:avoid}}
  </style></head><body>
    <header class="brand">
      <div>
        <h1>AgroGenomaX By CRH</h1>
        <h3>HISTORIA CLÍNICA ANIMAL</h3>
        <small>Generado: ${safe(new Date().toLocaleString('es-CO'))}</small>
        <small>Sistema Inteligente de Gestión Ganadera, Trazabilidad y Cumplimiento Sanitario</small>
      </div>
      <div class="qr"><strong>QR animal</strong><br>${safe(animalQrLabel(animal))}</div>
    </header>
    <section class="panel"><h2>Resumen sanitario del animal</h2><div class="grid">
      <p><b>Animal</b>${safe(animalLabel(animal))}</p><p><b>QR</b>${safe(animalQrLabel(animal))}</p><p><b>Raza</b>${safe(razas || '--')}</p>
      <p><b>Sexo</b>${safe(valueOf(animal, ['sexo', 'sex']) || '--')}</p><p><b>Edad</b>${safe(ageLabel(animal))}</p><p><b>Categoría</b>${safe(productiveCategory(animal))}</p>
    </div></section>
    <section class="panel"><h2>Dashboard sanitario</h2><div class="grid">
      <p><b>Estado clínico</b><span class="metric">${safe(resumen.estado)}</span></p><p><b>Eventos sanitarios</b><span class="metric">${safe(resumen.total)}</span></p><p><b>Costo sanitario</b><span class="metric">${safe(formatMoney(resumen.costo))}</span></p>
      <p><b>Riesgo</b>${safe(resumen.riesgo.label)}</p><p><b>Índice sanitario</b>${safe(`${resumen.indiceSanitario}/100`)}</p><p><b>Duración clínica</b>${safe(resumen.duracion?.days ?? '--')} días</p>
    </div></section>
    <section class="panel"><h2>Historial clínico</h2>${rowsHtml || '<p>No se registran tratamientos clínicos para este animal.</p>'}</section>
    <section class="panel"><h2>Restricción comercial temporal</h2>${resumen.retiroActivo ? `<div class="grid"><p><b>Estado comercial</b>NO APTO TEMPORALMENTE</p><p><b>Restricción carne</b>${safe(resumen.carne.label === 'Activo' ? 'Retiro de carne activo' : 'Sin restricción')}</p><p><b>Liberación carne</b>${safe(resumen.carne.release || '--')}</p><p><b>Tiempo restante carne</b>${safe(resumen.carne.countdown || '--')}</p><p><b>Restricción leche</b>${safe(resumen.leche.label === 'Activo' ? 'Retiro de leche activo' : 'Sin restricción')}</p><p><b>Liberación leche</b>${safe(resumen.leche.release || '--')}</p></div>` : '<p><b>Estado comercial</b>APTO</p><p>Sin restricciones sanitarias activas.</p>'}</section>
    <section class="panel"><h2>Impacto productivo</h2><p>${impact ? `GDP previo: ${safe(formatMetric(impact.gdpBefore, ' kg/día'))}<br>GDP posterior: ${safe(formatMetric(impact.gdpAfter, ' kg/día'))}<br>Variación: ${safe(impactLabel(impact))}` : 'Sin datos suficientes de pesajes para estimar impacto productivo.'}</p></section>
    <section class="panel"><h2>Impacto económico sanitario</h2><p>Costo sanitario total: ${safe(formatMoney(economia.costoTratamiento))}<br>Recuperación productiva: ${safe(economia.recuperacionProductiva === null ? '--' : formatMetric(economia.recuperacionProductiva, ' kg/día'))}<br>Valor recuperado estimado: ${safe(economia.valorRecuperado === null ? '--' : formatMoney(economia.valorRecuperado))}<br>Pérdida productiva estimada: ${safe(economia.perdidaProductiva === null ? '--' : formatMoney(economia.perdidaProductiva))}<br>Pérdida evitada estimada: ${safe(economia.perdidaEvitada === null ? '--' : formatMoney(economia.perdidaEvitada))}<br>Retorno sanitario: ${safe(Number.isFinite(economia.retorno) ? `${formatMetric(economia.retorno, 'x')}` : '--')}<br>Resultado económico sanitario: ${safe(economicStatus.label)}</p><p>${safe(economicStatus.text)}</p><p>${safe(economia.message)}</p></section>
    <section class="panel"><h2>Score sanitario inteligente</h2><div class="grid"><p><b>Índice sanitario</b>${safe(`${resumen.indiceSanitario}/100`)}</p><p><b>Clasificación</b>${safe(score.label)}</p><p><b>Recomendación</b>${safe(score.recommendation)}</p><p><b>Tendencia sanitaria</b>${safe(trend.label)}</p></div><p>Este índice es una estimación interna de AgroGenomaX basada en tratamientos, reincidencia, retiro sanitario, evolución productiva y estado clínico.</p></section>
    <section class="panel"><h2>Reincidencia sanitaria</h2><div class="grid"><p><b>Patología</b>${safe(recurrence.pathology)}</p><p><b>Eventos</b>${safe(recurrence.count)}</p><p><b>Estado</b>${safe(recurrence.state)}</p></div></section>
    <section class="panel"><h2>Predicción sanitaria AgroGenomaX</h2><div class="grid"><p><b>Índice estimado de recuperación</b>${safe(`${prediction.recovery}%`)}</p><p><b>Riesgo recaída</b>${safe(prediction.relapse)}</p><p><b>Próximo control</b>${safe(formatDate(prediction.reviewDate))}</p></div><p>Basado en respuesta productiva, evolución del GDP, estado clínico e historial sanitario.</p></section>
    <section class="panel"><h2>Decisión recomendada AgroGenomaX</h2><p><strong>${safe(decision.title)}</strong></p><ul>${decision.items.map((item) => `<li>${safe(item)}</li>`).join('')}</ul></section>
    <section class="panel"><h2>Timeline clínico</h2>${timelineHtml || '<p>No existen eventos clínicos registrados.</p>'}</section>
    <section class="panel"><h2>Evidencias clínicas</h2>${evidenciasHtml}</section>
    <section class="panel"><h2>Análisis clínico AgroGenomaX</h2><p><strong>${safe(clinical.title)}</strong></p><p>${safe(clinical.text)}</p><ul>${clinical.recommendations.map((item) => `<li>${safe(item)}</li>`).join('')}</ul><p><small>Análisis generado con datos registrados en AgroGenomaX. La validación clínica final debe realizarse bajo criterio profesional veterinario.</small></p></section>
    <section class="panel"><h2>Impacto reproductivo</h2>${reproductive ? `<p>Diagnóstico relacionado: ${safe(reproductive.diagnosis)}</p><ul>${reproductive.effects.map((item) => `<li>${safe(item)}</li>`).join('')}</ul>` : '<p>Sin impacto reproductivo identificado.</p>'}</section>
    <section class="footer"><h2>Certificación AgroGenomaX</h2><p>Responsable técnico: ______________________________</p><p>Profesión: ______________________________</p><p>Matrícula o registro profesional: ______________________________</p><p>Entidad: ______________________________</p><p>Firma: ______________________________</p><br><p>Certifico que la información clínica registrada en este documento corresponde a los registros almacenados en la plataforma AgroGenomaX.</p></section>
  </body></html>`);
  win.document.close();
  win.focus();
}

function AccordionSection({ title, children }) {
  return (
    <details className="gan-clinical-accordion" open>
      <summary>{title}</summary>
      <div className="gan-clinical-accordion-body">{children}</div>
    </details>
  );
}

export default function AnimalTratamientosTab({ animalId }) {
  const params = useParams();
  const resolvedAnimalId = animalId || params.id;
  const [animal, setAnimal] = useState(null);
  const [razas, setRazas] = useState([]);
  const [pesajes, setPesajes] = useState([]);
  const [tratamientos, setTratamientos] = useState([]);
  const [form, setForm] = useState(emptyForm);
  const [evidenceForm, setEvidenceForm] = useState(emptyEvidence);
  const [evidencias, setEvidencias] = useState([]);
  const [precioKg, setPrecioKg] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [generatingPdf, setGeneratingPdf] = useState(false);

  useEffect(() => {
    Promise.all([
      ganaderiaApi.getAnimal(resolvedAnimalId),
      ganaderiaApi.getAnimalRazas(resolvedAnimalId).catch(() => []),
      ganaderiaApi.listAnimalPesajesEvolucion(resolvedAnimalId).catch(() => []),
      ganaderiaApi.listAnimalTratamientos(resolvedAnimalId).catch(() => []),
    ])
      .then(([animalRow, razaRows, pesajeRows, tratamientoRows]) => {
        setAnimal(animalRow);
        setRazas(razaRows || []);
        setPesajes(pesajeRows || []);
        setTratamientos(tratamientoRows || []);
        setEvidencias([]);
      })
      .catch((err) => setError(err.message));
  }, [resolvedAnimalId]);

  const update = (field, value) => {
    setForm((current) => {
      const next = { ...current, [field]: value };
      if (field === 'fecha_inicio' || field === 'retiro_carne_dias') next.fecha_fin_retiro_carne = addDays(next.fecha_inicio, toNumber(next.retiro_carne_dias));
      if (field === 'fecha_inicio' || field === 'retiro_leche_dias') next.fecha_fin_retiro_leche = addDays(next.fecha_inicio, toNumber(next.retiro_leche_dias));
      return next;
    });
  };

  const alerts = useMemo(() => buildAlerts(tratamientos), [tratamientos]);
  const impact = useMemo(() => productiveImpact(tratamientos, pesajes), [tratamientos, pesajes]);
  const recurrence = useMemo(() => recurrenceAnalysis(tratamientos), [tratamientos]);
  const razaLabel = useMemo(() => {
    if (!razas.length) return valueOf(animal, ['raza', 'nombre_raza']) || '--';
    return razas.map((raza) => `${raza.nombre_raza || `Raza ${raza.raza_id}`}${raza.porcentaje ? ` ${raza.porcentaje}%` : ''}`).join(' / ');
  }, [animal, razas]);

  const resumen = useMemo(() => {
    const critical = tratamientos.some((row) => ['Crítico', 'Crónico'].includes(row.estado_caso));
    const active = tratamientos.some((row) => ['En tratamiento'].includes(row.estado_caso));
    const follow = tratamientos.some((row) => row.estado_caso === 'Seguimiento');
    const ultimo = [...tratamientos].sort((a, b) => String(b.fecha_inicio).localeCompare(String(a.fecha_inicio)))[0];
    const retiroActivo = alerts.some((alert) => /Retiro/.test(alert.type));
    const estado = critical ? 'Crítico' : active ? 'En tratamiento' : follow ? 'Seguimiento' : 'Sano';
    const riesgo = riskLevel(alerts.length);
    const carne = withdrawalState(ultimo?.fecha_fin_retiro_carne);
    const leche = withdrawalState(ultimo?.fecha_fin_retiro_leche);
    const costo = tratamientos.reduce((sum, row) => sum + treatmentTotal(row), 0);
    const duracion = clinicalDuration(ultimo);
    const indiceSanitario = sanitaryIndex({ tratamientos, alerts, retiroActivo, costo, impact, duracion });
    return {
      estado,
      total: tratamientos.length,
      costo,
      ultimo,
      ultimoMedicamento: ultimo?.nombre_comercial || '--',
      ultimoDiagnostico: ultimo?.diagnostico || '--',
      retiroActivo,
      riesgo,
      carne,
      leche,
      costBreakdown: treatmentCostBreakdown(ultimo),
      indiceSanitario,
      duracion,
    };
  }, [tratamientos, alerts, impact]);

  const score = useMemo(() => sanitaryClassification(resumen.indiceSanitario, resumen), [resumen]);
  const prediction = useMemo(() => sanitaryPrediction({ resumen, impact, recurrence }), [resumen, impact, recurrence]);
  const reproductive = useMemo(() => reproductiveImpact(tratamientos, animal, resumen), [tratamientos, animal, resumen]);
  const clinical = useMemo(() => clinicalInterpretation({ impact, resumen }), [impact, resumen]);
  const economia = useMemo(() => economicImpact({ impact, costo: resumen.costo, precioKg }), [impact, precioKg, resumen.costo]);
  const economicStatus = useMemo(() => economicResult(economia), [economia]);
  const decision = useMemo(() => recommendedDecision({ resumen, score, recurrence }), [resumen, score, recurrence]);
  const productiveTimelineResult = useMemo(() => productiveResultLabel(impact), [impact]);
  const trend = useMemo(() => sanitaryTrend({ impact, recurrence, resumen }), [impact, recurrence, resumen]);
  const generalBadge = useMemo(() => generalClinicalBadge(resumen), [resumen]);
  const recoveryBarClass = useMemo(() => recoveryClass(prediction.recovery), [prediction.recovery]);

  const timeline = useMemo(() => {
    const events = [];
    const birth = getBirthDate(animal);
    if (birth) events.push({ date: birth, title: 'Nacimiento', detail: animalLabel(animal), className: 'estado-vigente' });
    tratamientos.forEach((row) => {
      events.push({
        date: row.fecha_inicio,
        code: sanitaryEventCode(row, tratamientos),
        title: row.diagnostico || 'Tratamiento',
        detail: row.nombre_comercial || row.estado_caso,
        state: row.estado_caso,
        className: statusClass(row.estado_caso),
        cost: treatmentTotal(row),
        result: productiveTimelineResult.label,
        resultClassName: productiveTimelineResult.className,
      });
      if (row.fecha_finalizacion) events.push({ date: row.fecha_finalizacion, title: 'Recuperación / cierre', detail: row.estado_caso, state: row.estado_caso, className: row.estado_caso === 'Recuperado' ? 'estado-vigente' : statusClass(row.estado_caso) });
    });
    return events.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  }, [animal, tratamientos, impact, productiveTimelineResult]);

  const submit = (event) => {
    event.preventDefault();
    setError('');
    setStatus('');
    if (!form.fecha_inicio || !form.diagnostico || !form.estado_caso) {
      setError('Fecha inicio, diagnóstico y estado del caso son obligatorios.');
      return;
    }
    setTratamientos((current) => [{ ...form, tratamiento_id: `local-${Date.now()}`, evidencias: [] }, ...current]);
    setForm(emptyForm);
    setStatus('Registro sanitario agregado a la trazabilidad del animal. Pendiente conexión definitiva API/PostgreSQL.');
  };

  const addEvidence = () => {
    setError('');
    setStatus('');
    if (!evidenceForm.nombre.trim()) {
      setError('Ingresa el nombre de la evidencia clínica.');
      return;
    }
    setEvidencias((current) => [{ ...evidenceForm, evidencia_id: `evidencia-${Date.now()}` }, ...current]);
    setEvidenceForm(emptyEvidence);
    setStatus('Evidencia clínica agregada al archivo digital de trazabilidad.');
  };

  const downloadPdf = async () => {
    setGeneratingPdf(true);
    setStatus('');
    setError('');
    try {
      const report = {
        generatedAt: new Date().toLocaleString('es-CO', { dateStyle: 'medium', timeStyle: 'short' }),
        animal: {
          nombre: animalLabel(animal),
          qr: animalQrLabel(animal),
          authUrl: `https://agrogenomax.pages.dev/qr/${encodeURIComponent(animalQrLabel(animal))}`,
          raza: razaLabel,
          sexo: valueOf(animal, ['sexo', 'sex']) || '--',
          edad: ageLabel(animal),
          categoria: productiveCategory(animal),
        },
        resumen: {
          estado: resumen.estado,
          estadoClass: statusClass(resumen.estado),
          total: resumen.total,
          costo: formatMoney(resumen.costo),
          riesgo: resumen.riesgo.label,
          riesgoClass: resumen.riesgo.className,
          indice: `${resumen.indiceSanitario}/100`,
        },
        tratamientos: tratamientos.map((row) => ({
          codigo: sanitaryEventCode(row, tratamientos),
          fecha: formatDate(row.fecha_inicio),
          diagnostico: row.diagnostico || 'Sin diagnóstico',
          medicamento: row.nombre_comercial || '--',
          principioActivo: row.principio_activo || '--',
          dosis: `${row.dosis || '--'} ${row.unidad || ''}`.trim(),
          duracion: `${row.duracion_dias || '--'} días`,
          retiroCarne: row.fecha_fin_retiro_carne ? formatDate(row.fecha_fin_retiro_carne) : '--',
          retiroLeche: row.fecha_fin_retiro_leche ? formatDate(row.fecha_fin_retiro_leche) : '--',
          costoTotal: formatMoney(treatmentTotal(row)),
          responsable: row.profesional || 'No registrado',
          estado: row.estado_caso || '--',
          className: statusClass(row.estado_caso),
        })),
        retiro: {
          className: resumen.retiroActivo ? 'estado-proxima' : 'estado-vigente',
          lines: resumen.retiroActivo
            ? [
              'Estado comercial: NO APTO TEMPORALMENTE',
              `Restricción carne: ${resumen.carne.label === 'Activo' ? 'Retiro de carne activo' : 'Sin restricción'}`,
              `Liberación carne: ${resumen.carne.release || '--'}`,
              `Tiempo restante carne: ${resumen.carne.countdown || '--'}`,
              `Restricción leche: ${resumen.leche.label === 'Activo' ? 'Retiro de leche activo' : 'Sin restricción'}`,
              `Liberación leche: ${resumen.leche.release || '--'}`,
            ]
            : ['Estado comercial: APTO', 'Sin restricciones sanitarias activas.'],
        },
        impact: {
          gdpBefore: impact ? formatMetric(impact.gdpBefore, ' kg/día') : '--',
          gdpAfter: impact ? formatMetric(impact.gdpAfter, ' kg/día') : '--',
          variation: impact ? impactLabel(impact) : '--',
          className: impact?.variation < 0 ? 'estado-vencida' : impact ? 'estado-vigente' : 'estado-sin-programacion',
        },
        economia: {
          costo: formatMoney(economia.costoTratamiento),
          valorRecuperado: economia.valorRecuperado === null ? '--' : formatMoney(economia.valorRecuperado),
          resultado: economicStatus.label,
          resultClass: economicStatus.className,
        },
        clinical,
        score,
        recurrence,
        prediction: {
          recovery: `${prediction.recovery}%`,
          relapse: prediction.relapse,
          reviewDate: formatDate(prediction.reviewDate),
          className: prediction.className,
        },
        decision,
        trend,
        timeline: timeline.map((event) => ({
          codigo: event.code || '',
          fecha: formatDate(event.date),
          tipo: event.title === 'Nacimiento' ? 'Nacimiento' : 'Tratamiento',
          descripcion: event.title,
          estado: event.state || '--',
          tratamiento: event.detail || '--',
          resultado: event.result || 'No evaluado',
          costo: event.cost ? formatMoney(event.cost) : '--',
          className: event.className,
        })),
        evidencias: evidencias.map((item) => ({
          nombre: item.nombre,
          tipo: item.tipo,
          fecha: formatDate(item.fecha),
          georreferencia: item.georreferencia ? 'Disponible' : 'No disponible',
          observacion: item.observacion || 'Sin observación',
        })),
        reproductive: {
          className: reproductive?.className || 'estado-sin-programacion',
          lines: reproductive
            ? [`Diagnóstico relacionado: ${reproductive.diagnosis}`, ...reproductive.effects.map((item) => `Posible afectación: ${item}`)]
            : ['Sin impacto reproductivo identificado.'],
        },
      };
      const blob = await createClinicalHistoryPdfBlob(report);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = clinicalHistoryFileName(report.animal.nombre, report.animal.qr);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1500);
      setStatus('Historia clínica descargada en PDF.');
    } catch (err) {
      setError(err.message || 'No se pudo generar la historia clínica.');
    } finally {
      setGeneratingPdf(false);
    }
  };

  return (
    <div className="gan-stack gan-clinical">
      <div className="gan-section-heading">
        <span className="gan-eyebrow">Tratamientos</span>
        <h3>Panel sanitario inteligente</h3>
        <p>Historia clínica, tratamientos, impacto productivo y trazabilidad sanitaria.</p>
      </div>

      <section className="gan-breed-box gan-clinical-summary">
        <span className="gan-eyebrow">Resumen sanitario del animal</span>
        <span className={`gan-alert-pill gan-clinical-general-badge ${generalBadge.className}`}>{generalBadge.label}</span>
        <h3>{animalLabel(animal, `Animal ${resolvedAnimalId}`)}</h3>
        <div className="gan-animal-meta">
          <article><strong>QR:</strong> {animalQrLabel(animal)}</article>
          <article><strong>Raza:</strong> {razaLabel}</article>
          <article><strong>Sexo:</strong> {valueOf(animal, ['sexo', 'sex']) || '--'}</article>
          <article><strong>Edad:</strong> {ageLabel(animal)}</article>
          <article><strong>Categoría:</strong> {productiveCategory(animal)}</article>
          <article className={statusClass(resumen.estado)}><strong>Estado clínico:</strong> {resumen.estado}</article>
        </div>
      </section>

      <section className="gan-health-summary gan-treatment-kpis">
        <article className={`gan-metric ${statusClass(resumen.estado)}`}>
          <span className="gan-metric-title"><Stethoscope className="gan-card-icon" /><span>Estado clínico</span></span>
          <strong>{resumen.estado.toUpperCase()}</strong>
          <small>{resumen.ultimoDiagnostico}</small>
        </article>
        <article className="gan-metric estado-neutro">
          <span className="gan-metric-title"><Pill className="gan-card-icon" /><span>Eventos sanitarios</span></span>
          <strong>{resumen.total}</strong>
          <small>{resumen.ultimoMedicamento}</small>
        </article>
        <article className="gan-metric estado-neutro">
          <span className="gan-metric-title"><DollarSign className="gan-card-icon" /><span>Costo sanitario</span></span>
          <strong>{formatMoney(resumen.costo)}</strong>
          {resumen.costo > 0 ? (
            <small title={`Otros: ${formatMoney(resumen.costBreakdown.otros)}`}>Medicamento: {formatMoney(resumen.costBreakdown.medicamento)}<br />Veterinario: {formatMoney(resumen.costBreakdown.veterinario)}<br />Mano de obra: {formatMoney(resumen.costBreakdown.manoObra)}</small>
          ) : <small>Detalle no registrado.</small>}
        </article>
        <article className={`gan-metric ${resumen.retiroActivo ? 'estado-proxima' : 'estado-vigente'}`}>
          <span className="gan-metric-title"><Timer className="gan-card-icon" /><span>Retiro sanitario</span></span>
          <strong>{resumen.retiroActivo ? 'ACTIVO' : 'SIN RESTRICCIÓN'}</strong>
          <small>Carne: {resumen.carne.label}{resumen.carne.release ? ` (${resumen.carne.release})` : ''} · Leche: {resumen.leche.label}{resumen.leche.release ? ` (${resumen.leche.release})` : ''}</small>
        </article>
        <article className={`gan-metric ${impact?.variation < 0 ? 'estado-vencida' : impact ? 'estado-vigente' : 'estado-sin-programacion'}`}>
          <span className="gan-metric-title"><TrendingUp className="gan-card-icon" /><span>Impacto productivo</span></span>
          <strong>{impactLabel(impact)}</strong>
          <small>GDP: {impact ? `${formatMetric(impact.gdpBefore)} → ${formatMetric(impact.gdpAfter)} kg/día` : '--'}</small>
        </article>
        <article className={`gan-metric ${resumen.riesgo.className}`}>
          <span className="gan-metric-title"><AlertTriangle className="gan-card-icon" /><span>Riesgo sanitario</span></span>
          <strong>{resumen.riesgo.label.toUpperCase()}</strong>
          <small>{alerts.length} alertas activas</small>
        </article>
        <article className={`gan-metric ${statusClass(resumen.duracion?.status)}`}>
          <span className="gan-metric-title"><Hourglass className="gan-card-icon" /><span>Duración clínica</span></span>
          <strong>{Number.isFinite(resumen.duracion?.days) ? `${resumen.duracion.days} días` : '--'}</strong>
          <small>Inicio: {formatDate(resumen.duracion?.start)} · Cierre: {resumen.duracion?.active ? 'Activo' : formatDate(resumen.duracion?.end)} · Estado: {resumen.duracion?.status || '--'}</small>
        </article>
      </section>

      <section className={`gan-feature-alert gan-clinical-analysis ${clinical.className}`}>
        <span className="gan-feature-icon" aria-hidden="true"><ShieldCheck /></span>
        <div>
          <span className="gan-eyebrow">Análisis clínico AgroGenomaX</span>
          <h3>{clinical.title}</h3>
          <p>{clinical.text}</p>
          <div className="gan-clinical-impact-grid">
            <span>GDP previo: <strong>{impact ? formatMetric(impact.gdpBefore, ' kg/día') : '--'}</strong></span>
            <span>GDP posterior: <strong>{impact ? formatMetric(impact.gdpAfter, ' kg/día') : '--'}</strong></span>
            <span>Variación: <strong>{impact ? impactLabel(impact) : '--'}</strong></span>
          </div>
          <ul className="gan-clinical-recommendations">
            {clinical.recommendations.map((item) => <li key={item}>✓ {item}</li>)}
          </ul>
          <p className="gan-empty-text">Análisis generado con datos registrados en AgroGenomaX. La validación clínica final debe realizarse bajo criterio profesional veterinario.</p>
        </div>
      </section>

      <section className="gan-breed-box">
        <div className="gan-section-heading"><span className="gan-eyebrow">Impacto económico sanitario</span><h3>Costo clínico y recuperación productiva</h3></div>
        <div className="gan-form gan-economics-form">
          <FormField label="Precio estimado por kg">
            <input inputMode="decimal" placeholder="Ejemplo: 8500" value={precioKg} onChange={(event) => setPrecioKg(event.target.value)} />
          </FormField>
        </div>
        <div className="gan-dashboard-grid gan-clinical-ranking">
          <article className="estado-neutro"><span>Costo sanitario</span><strong>{formatMoney(economia.costoTratamiento)}</strong></article>
          <article className={economia.recuperacionProductiva > 0 ? 'estado-vigente' : economia.recuperacionProductiva < 0 ? 'estado-vencida' : 'estado-sin-programacion'}><span>Recuperación productiva</span><strong>{economia.recuperacionProductiva === null ? '--' : formatMetric(economia.recuperacionProductiva, ' kg/día')}</strong></article>
          <article className={economia.valorRecuperado > 0 ? 'estado-vigente' : 'estado-sin-programacion'}><span>Valor recuperado estimado</span><strong>{economia.valorRecuperado === null ? '--' : formatMoney(economia.valorRecuperado)}</strong></article>
          <article className={economia.perdidaProductiva > 0 ? 'estado-vencida' : 'estado-sin-programacion'}><span>Pérdida productiva estimada</span><strong>{economia.perdidaProductiva === null ? '--' : formatMoney(economia.perdidaProductiva)}</strong></article>
          <article className={economia.perdidaEvitada > 0 ? 'estado-vigente' : 'estado-sin-programacion'}><span>Pérdida evitada estimada</span><strong>{economia.perdidaEvitada === null ? '--' : formatMoney(economia.perdidaEvitada)}</strong></article>
          <article className={Number.isFinite(economia.retorno) ? 'estado-vigente' : 'estado-sin-programacion'}><span>Retorno sanitario</span><strong>{Number.isFinite(economia.retorno) ? formatMetric(economia.retorno, 'x') : '--'}</strong></article>
          <article className={economicStatus.className}><span>Resultado económico sanitario</span><strong>{economicStatus.label}</strong><small>{economicStatus.text}</small></article>
        </div>
        <p className="gan-empty-text">{economia.message}</p>
      </section>

      <section className="gan-breed-box">
        <div className="gan-section-heading"><span className="gan-eyebrow">Restricción comercial</span><h3>Retiros y seguridad alimentaria</h3></div>
        {resumen.retiroActivo ? (
          <div className="gan-clinical-alerts">
            {resumen.carne.label === 'Activo' ? <article className="estado-proxima"><strong>Estado comercial: NO APTO TEMPORALMENTE</strong><span>Restricción: Retiro de carne activo</span><span>Liberación: {resumen.carne.release}</span><span>Tiempo restante: {resumen.carne.countdown}</span></article> : null}
            {resumen.leche.label === 'Activo' ? <article className="estado-proxima"><strong>Producto: LECHE NO APTA TEMPORALMENTE</strong><span>Restricción: Retiro de leche activo</span><span>Liberación: {resumen.leche.release}</span><span>Tiempo restante: {resumen.leche.countdown}</span></article> : null}
          </div>
        ) : <div className="gan-clinical-alerts"><article className="estado-vigente"><strong>Estado comercial: APTO</strong><span>Sin restricciones sanitarias activas.</span></article></div>}
      </section>

      <section className="gan-breed-box">
        <div className="gan-section-heading"><span className="gan-eyebrow">Reincidencia sanitaria</span><h3>Análisis de recurrencia clínica</h3></div>
        <div className="gan-dashboard-grid gan-clinical-ranking">
          <article className={recurrence.className}><span>Patología</span><strong>{recurrence.pathology}</strong></article>
          <article className={recurrence.className}><span>Eventos registrados</span><strong>{recurrence.count}</strong></article>
          <article className="estado-neutro"><span>Último evento</span><strong>{formatDate(recurrence.lastDate)}</strong></article>
          <article className={recurrence.className}><span>Estado</span><strong>{recurrence.state}</strong></article>
        </div>
      </section>

      <section className="gan-breed-box">
        <div className="gan-section-heading"><span className="gan-eyebrow">Predicción sanitaria AgroGenomaX</span><h3>Pronóstico clínico y próximo control</h3></div>
        <div className="gan-dashboard-grid gan-clinical-ranking">
          <article className={prediction.className}><span>Índice estimado de recuperación</span><strong>{prediction.recovery}%</strong><small>Basado en respuesta productiva, evolución del GDP, estado clínico e historial sanitario.</small></article>
          <article className={prediction.className}><span>Riesgo recaída</span><strong>{prediction.relapse}</strong></article>
          <article className="estado-neutro"><span>Revisión sugerida</span><strong>{prediction.reviewDays} días</strong></article>
          <article className={prediction.className}><span>Próximo control recomendado</span><strong>{formatDate(prediction.reviewDate)}</strong></article>
        </div>
        <div className={`gan-recovery-progress ${recoveryBarClass}`} aria-label={`Recuperación estimada ${prediction.recovery}%`}>
          <span>Recuperación estimada</span>
          <div><i style={{ width: `${prediction.recovery}%` }} /></div>
          <strong>{prediction.recovery}%</strong>
        </div>
      </section>

      <section className="gan-breed-box">
        <div className="gan-section-heading"><span className="gan-eyebrow">Impacto reproductivo</span><h3>Cruce sanidad × reproducción</h3></div>
        {reproductive ? (
          <div className="gan-clinical-repro">
            <strong>Diagnóstico relacionado: {reproductive.diagnosis}</strong>
            <span>Posibles afectaciones:</span>
            <div>{reproductive.effects.map((item) => <em key={item}>{item}</em>)}</div>
          </div>
        ) : <p className="gan-empty-text">Sin impacto reproductivo identificado.</p>}
      </section>

      <section className={`gan-feature-alert gan-clinical-analysis ${decision.className}`}>
        <span className="gan-feature-icon" aria-hidden="true"><ShieldCheck /></span>
        <div>
          <span className="gan-eyebrow">Decisión recomendada AgroGenomaX</span>
          <h3>{decision.title}</h3>
          <ul className="gan-clinical-recommendations">
            {decision.items.map((item) => <li key={item}>✓ {item}</li>)}
          </ul>
        </div>
      </section>

      <form className="gan-clinical-form-shell" onSubmit={submit}>
        <AccordionSection title="1. Diagnóstico clínico">
          <div className="gan-form gan-clinical-form">
            <FormField label="Fecha inicio"><input type="date" value={form.fecha_inicio} onChange={(e) => update('fecha_inicio', e.target.value)} required /></FormField>
            <FormField label="Fecha finalización"><input type="date" value={form.fecha_finalizacion} onChange={(e) => update('fecha_finalizacion', e.target.value)} /></FormField>
            <FormField label="Motivo del tratamiento"><input value={form.motivo} onChange={(e) => update('motivo', e.target.value)} /></FormField>
            <FormField label="Diagnóstico"><input value={form.diagnostico} onChange={(e) => update('diagnostico', e.target.value)} required /></FormField>
            <FormField label="Síntomas observados"><textarea value={form.sintomas} onChange={(e) => update('sintomas', e.target.value)} /></FormField>
            <FormField label="Estado del caso"><select value={form.estado_caso} onChange={(e) => update('estado_caso', e.target.value)}>{caseStatuses.map((status) => <option key={status}>{status}</option>)}</select></FormField>
          </div>
        </AccordionSection>
        <AccordionSection title="2. Medicamentos">
          <div className="gan-form gan-clinical-form">
            <FormField label="Nombre comercial"><input value={form.nombre_comercial} onChange={(e) => update('nombre_comercial', e.target.value)} /></FormField>
            <FormField label="Principio activo"><input value={form.principio_activo} onChange={(e) => update('principio_activo', e.target.value)} /></FormField>
            <FormField label="Laboratorio"><input value={form.laboratorio} onChange={(e) => update('laboratorio', e.target.value)} /></FormField>
            <FormField label="Lote"><input value={form.lote} onChange={(e) => update('lote', e.target.value)} /></FormField>
            <FormField label="Fecha vencimiento"><input type="date" value={form.fecha_vencimiento} onChange={(e) => update('fecha_vencimiento', e.target.value)} /></FormField>
            <FormField label="Dosis"><input value={form.dosis} onChange={(e) => update('dosis', e.target.value)} /></FormField>
            <FormField label="Unidad"><input value={form.unidad} onChange={(e) => update('unidad', e.target.value)} /></FormField>
            <FormField label="Vía aplicación"><select value={form.via_aplicacion} onChange={(e) => update('via_aplicacion', e.target.value)}><option value="">Seleccione vía</option>{applicationRoutes.map((route) => <option key={route}>{route}</option>)}</select></FormField>
            <FormField label="Frecuencia"><input value={form.frecuencia} onChange={(e) => update('frecuencia', e.target.value)} /></FormField>
            <FormField label="Duración (días)"><input inputMode="numeric" value={form.duracion_dias} onChange={(e) => update('duracion_dias', e.target.value)} /></FormField>
          </div>
        </AccordionSection>
        <AccordionSection title="3. Periodos de retiro">
          <div className="gan-form gan-clinical-form">
            <FormField label="Retiro carne (días)"><input inputMode="numeric" value={form.retiro_carne_dias} onChange={(e) => update('retiro_carne_dias', e.target.value)} /></FormField>
            <FormField label="Retiro leche (días)"><input inputMode="numeric" value={form.retiro_leche_dias} onChange={(e) => update('retiro_leche_dias', e.target.value)} /></FormField>
            <FormField label="Fecha fin retiro carne"><input type="date" value={form.fecha_fin_retiro_carne} onChange={(e) => update('fecha_fin_retiro_carne', e.target.value)} /></FormField>
            <FormField label="Fecha fin retiro leche"><input type="date" value={form.fecha_fin_retiro_leche} onChange={(e) => update('fecha_fin_retiro_leche', e.target.value)} /></FormField>
          </div>
        </AccordionSection>
        <AccordionSection title="4. Costos">
          <div className="gan-form gan-clinical-form">
            <FormField label="Costo medicamento"><input inputMode="decimal" value={form.costo_medicamento} onChange={(e) => update('costo_medicamento', e.target.value)} /></FormField>
            <FormField label="Costo veterinario"><input inputMode="decimal" value={form.costo_veterinario} onChange={(e) => update('costo_veterinario', e.target.value)} /></FormField>
            <FormField label="Costo mano de obra"><input inputMode="decimal" value={form.costo_mano_obra} onChange={(e) => update('costo_mano_obra', e.target.value)} /></FormField>
            <FormField label="Otros costos"><input inputMode="decimal" value={form.otros_costos} onChange={(e) => update('otros_costos', e.target.value)} /></FormField>
          </div>
        </AccordionSection>
        <AccordionSection title="5. Profesional responsable">
          <div className="gan-form gan-clinical-form">
            <FormField label="Nombre"><input value={form.profesional} onChange={(e) => update('profesional', e.target.value)} /></FormField>
            <FormField label="Profesión"><input value={form.profesion} onChange={(e) => update('profesion', e.target.value)} /></FormField>
            <FormField label="Matrícula o tarjeta profesional"><input value={form.matricula} onChange={(e) => update('matricula', e.target.value)} /></FormField>
            <FormField label="Entidad o registro profesional"><input value={form.entidad} onChange={(e) => update('entidad', e.target.value)} /></FormField>
          </div>
        </AccordionSection>
        <AccordionSection title="6. Observaciones y evidencias">
          <div className="gan-form gan-clinical-form">
            <FormField label="Observaciones"><textarea value={form.observaciones} onChange={(e) => update('observaciones', e.target.value)} /></FormField>
          </div>
        </AccordionSection>
        <button className="gan-submit gan-clinical-submit" type="submit"><Save className="h-5 w-5" /> Guardar registro sanitario</button>
      </form>

      <StatusMessage type="success">{status}</StatusMessage>
      <StatusMessage type="error">{error}</StatusMessage>

      <section className="gan-breed-box">
        <div className="gan-section-heading"><span className="gan-eyebrow">Evidencias clínicas</span><h3>Archivo clínico digital</h3></div>
        <p className="gan-empty-text">Evidencias sanitarias permanentes del historial del animal.</p>
        <div className="gan-form gan-clinical-form">
          <FormField label="Nombre archivo o evidencia"><input value={evidenceForm.nombre} onChange={(e) => setEvidenceForm((current) => ({ ...current, nombre: e.target.value }))} /></FormField>
          <FormField label="Tipo evidencia"><select value={evidenceForm.tipo} onChange={(e) => setEvidenceForm((current) => ({ ...current, tipo: e.target.value }))}>{evidenceTypes.map((type) => <option key={type}>{type}</option>)}</select></FormField>
          <FormField label="Fecha"><input type="date" value={evidenceForm.fecha} onChange={(e) => setEvidenceForm((current) => ({ ...current, fecha: e.target.value }))} /></FormField>
          <FormField label="Observación"><input value={evidenceForm.observacion} onChange={(e) => setEvidenceForm((current) => ({ ...current, observacion: e.target.value }))} /></FormField>
          <button className="gan-secondary-button gan-clinical-submit" type="button" onClick={addEvidence}><FileText className="h-5 w-5" /> Agregar evidencia clínica</button>
        </div>
        <div className="gan-clinical-evidence-list">
          {evidencias.length ? evidencias.map((item) => (
            <article key={item.evidencia_id}>
              <strong>📎 {item.tipo}</strong>
              <span>{formatDate(item.fecha)}</span>
              <small>{item.georreferencia ? 'Georreferencia disponible' : 'Sin georreferencia'}</small>
              <button className="gan-mini-action" type="button" title={item.observacion || item.nombre}>Ver evidencia</button>
            </article>
          )) : <p className="gan-empty-text">No hay evidencias clínicas registradas.</p>}
        </div>
      </section>

      <section className="gan-breed-box">
        <div className="gan-section-heading"><span className="gan-eyebrow">Alertas sanitarias</span><h3>Retiros, reincidencias y seguridad alimentaria</h3></div>
        {alerts.length ? <div className="gan-clinical-alerts">{alerts.map((alert, index) => <article className={alert.className} key={`${alert.type}-${index}`}><strong>{alert.type}</strong><span>{alert.text}</span></article>)}</div> : <p className="gan-empty-text">Sin alertas clínicas activas.</p>}
      </section>

      <section className="gan-breed-box">
        <div className="gan-section-heading gan-pdf-heading">
          <div><span className="gan-eyebrow">Historial clínico avanzado</span><h3>Eventos sanitarios registrados</h3></div>
          <button className={`gan-secondary-button gan-pdf-button ${generatingPdf ? 'is-loading' : ''}`} type="button" disabled={generatingPdf} onClick={downloadPdf}>
            <Download className="h-5 w-5" />{generatingPdf ? 'Generando historia...' : 'Descargar historia clínica'}
          </button>
        </div>
        <div className="gan-treatment-history">
          {tratamientos.map((row) => (
            <article className="gan-treatment-row" key={row.tratamiento_id}>
              <div>
                <strong className={`gan-vaccine-title ${statusClass(row.estado_caso)}`}>🩺 {row.diagnostico || 'Sin diagnóstico'}</strong>
                <span>Código evento: {sanitaryEventCode(row, tratamientos)}</span>
                <span>Fecha: {formatDate(row.fecha_inicio)}</span>
                <span>Medicamento: {row.nombre_comercial || '--'}</span>
                <span>Principio activo: {row.principio_activo || '--'}</span>
                <span>Dosis: {row.dosis || '--'} {row.unidad || ''}</span>
                <span>Duración: {row.duracion_dias || '--'} días</span>
                <span>Responsable: {row.profesional || 'No registrado'}</span>
                <span>Costo total: {formatMoney(treatmentTotal(row))}</span>
                <span>Retiro carne: {row.fecha_fin_retiro_carne ? formatDate(row.fecha_fin_retiro_carne) : '--'}</span>
                <span>Retiro leche: {row.fecha_fin_retiro_leche ? formatDate(row.fecha_fin_retiro_leche) : '--'}</span>
                <span>Impacto GDP: {impact ? impactLabel(impact) : '--'}</span>
                <span>Evidencias: {(row.evidencias?.length || 0) + evidencias.length}</span>
                <span>Duración total: {row.duracion_dias || '--'} días</span>
              </div>
              <span className={`gan-alert-pill ${statusClass(row.estado_caso)}`}>Estado: {row.fecha_finalizacion ? 'CERRADO' : row.estado_caso === 'Seguimiento' ? 'SEGUIMIENTO' : 'ABIERTO'}</span>
            </article>
          ))}
        </div>
      </section>

      <section className="gan-breed-box">
        <div className="gan-section-heading"><span className="gan-eyebrow">Evolución sanitaria</span><h3>Timeline clínico</h3></div>
        <div className="gan-clinical-timeline">
          {timeline.map((event) => (
            <article className={event.className} key={`${event.date}-${event.title}`}>
              <span>{formatDate(event.date)}</span>
              {event.code ? <span>Código evento: {event.code}</span> : null}
              <strong>Evento: {event.title}</strong>
              {event.state ? <small>Estado: {event.state}</small> : null}
              {event.result ? <small className={event.resultClassName}>Resultado productivo: {event.result}</small> : null}
            </article>
          ))}
        </div>
      </section>

      <section className="gan-breed-box">
        <div className="gan-section-heading"><span className="gan-eyebrow">Eficiencia sanitaria</span><h3>Ranking sanitario</h3></div>
        <div className="gan-dashboard-grid gan-clinical-ranking">
          <article className={resumen.indiceSanitario >= 80 ? 'estado-vigente' : resumen.indiceSanitario >= 60 ? 'estado-proxima' : 'estado-vencida'}><span>Índice sanitario</span><strong>{resumen.indiceSanitario}/100</strong></article>
          <article className={score.className}><span>Clasificación sanitaria</span><strong>{score.label}</strong></article>
          <article className={score.className}><span>Recomendación</span><strong>{score.recommendation}</strong></article>
          <article className="estado-neutro"><span>Eventos sanitarios</span><strong>{resumen.total}</strong></article>
          <article className="estado-neutro"><span>Costo acumulado</span><strong>{formatMoney(resumen.costo)}</strong></article>
          <article className={resumen.riesgo.className}><span>Riesgo</span><strong>{resumen.riesgo.label}</strong></article>
          <article className={trend.className}><span>Tendencia sanitaria</span><strong>{trend.label}</strong></article>
          <article className="estado-sin-programacion"><span>Comparación local</span><strong>No disponible</strong><small>Preparado para comparar animales similares.</small></article>
        </div>
        <p className="gan-empty-text">Este índice es una estimación interna de AgroGenomaX basada en tratamientos, reincidencia, retiro sanitario, evolución productiva y estado clínico.</p>
        <p className="gan-empty-text">Interpretación: 90–100 Excelente · 80–89 Bueno · 70–79 Seguimiento · &lt;70 Atención.</p>
      </section>
    </div>
  );
}
