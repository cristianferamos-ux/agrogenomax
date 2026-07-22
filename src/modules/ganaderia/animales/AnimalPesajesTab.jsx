import { Download, Save } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { ganaderiaApi } from '../api/ganaderiaApi.js';
import { FormField, StatusMessage } from '../components/FormField.jsx';
import { formatDateDisplay as formatDateDisplayValue } from '../utils/dateFormat.js';
import { createProductiveReportPdfBlob, productiveReportFileName } from './productiveReportPdf.js';
import {
  valueOf,
  normalizeDateInput as formatDate,
  getFechaNacimiento,
  getFechaNacimientoRealAnimal,
  getFechaNacimientoEstimadaPorEdad,
  formatAgeLabel as animalAgeLabel,
} from '../engine/edad.js';
import { normalizeSex, categoriaCebaPorSexo, clasificarCategoriaPorEdadSexo, clasificarCategoriaActual } from '../engine/categoria.js';
import {
  getFecha,
  getPeso,
  sortByDateAsc,
  getFechaNacimientoProductiva,
  daysSince,
  obtenerUmbralesGDP,
  thresholdText,
  technicalInterpretation,
  classifyProductivity,
  classifyTimeSinceLastWeighing,
  classForGdp,
  classForDifference,
  chartColorForState,
  enrichRows,
  calcularTendenciaPesajes,
} from '../engine/pesajes.js';

function todayLocal() {
  const now = new Date();
  const timezoneOffset = now.getTimezoneOffset() * 60000;
  return new Date(now.getTime() - timezoneOffset).toISOString().slice(0, 10);
}

function isCommaDecimalInput(value) {
  return /^\d*(,\d{0,2})?$/.test(value);
}

function isValidCommaDecimal(value) {
  return /^\d+(,\d{1,2})?$/.test(value);
}

function toApiDecimal(value) {
  return value.replace(',', '.');
}

function getPesoNacimiento(animal) {
  const value = valueOf(animal, ['peso_nacimiento', 'peso_nacimiento_kg', 'birth_weight_kg']);
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function animalLabel(animal, fallback = 'Animal') {
  return valueOf(animal, ['nombre', 'name', 'codigo_interno', 'codigo']) || fallback;
}

function animalQrLabel(animal) {
  const explicit = valueOf(animal, ['codigo_qr', 'qr_codigo', 'qr']);
  if (explicit) return explicit;
  const internal = valueOf(animal, ['codigo_interno', 'numero_arete', 'codigo']);
  const digits = String(internal || '').replace(/\D/g, '');
  return digits ? `AGX-${digits.padStart(6, '0')}` : '--';
}

function animalBreedLabel(animal) {
  return valueOf(animal, ['raza', 'nombre_raza', 'raza_principal', 'composicion_racial', 'breed']) || '--';
}

function formatDateDisplay(value) {
  return formatDateDisplayValue(value, '--');
}

function formatNumber(value) {
  return Number.isFinite(value)
    ? new Intl.NumberFormat('es-CO', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(value)
    : null;
}

function formatMetric(value, suffix = '') {
  const formatted = formatNumber(value);
  return formatted ? `${formatted}${suffix}` : '—';
}

function formatMoney(value) {
  return Number.isFinite(value)
    ? new Intl.NumberFormat('es-CO', {
        style: 'currency',
        currency: 'COP',
        maximumFractionDigits: 0,
      }).format(value)
    : '—';
}

function formatDays(value) {
  if (value === undefined || value === null || value === '') return '—';
  const days = Number(value);
  return Number.isFinite(days) ? `${days} días` : '—';
}

function formatMonthsFromDays(value) {
  if (value === undefined || value === null || value === '') return '—';
  const days = Number(value);
  if (!Number.isFinite(days)) return '—';
  return `${formatNumber(days / 30.44)} meses`;
}

function formatAgeMonths(value) {
  if (typeof value === 'string' && value.trim()) return value;
  return Number.isFinite(value) ? `${formatNumber(value)} meses` : '--';
}

function initialPlaceholder(row, value, suffix = '') {
  return row?.es_peso_nacimiento || !Number.isFinite(row?.peso_anterior) ? '----' : formatMetric(value, suffix);
}

function initialMonthsPlaceholder(row, value) {
  return row?.es_peso_nacimiento || !Number.isFinite(row?.peso_anterior) ? '----' : formatMonthsFromDays(value);
}

function initialIntervalPlaceholder(row, value) {
  return row?.es_peso_nacimiento || !Number.isFinite(row?.peso_anterior) ? '----' : formatDays(value);
}

function ThresholdSemaforo({ thresholds }) {
  return (
    <strong className="gan-threshold-list">
      <span className="gan-threshold-excellent">Excelente &gt;= {formatNumber(thresholds.excelente)} kg/día</span>
      <span className="gan-threshold-acceptable">Aceptable {formatNumber(thresholds.aceptable)} a {formatNumber(thresholds.excelente - 0.01)} kg/día</span>
      <span className="gan-threshold-critical">Crítico &lt; {formatNumber(thresholds.aceptable)} kg/día</span>
    </strong>
  );
}

export default function AnimalPesajesTab({ animalId }) {
  const params = useParams();
  const resolvedAnimalId = animalId || params.id;
  const [animal, setAnimal] = useState(null);
  const [pesajes, setPesajes] = useState([]);
  const [form, setForm] = useState({ fecha_pesaje: todayLocal(), peso_kg: '', observaciones: '' });
  const [economics, setEconomics] = useState({ precioKg: '', costoDiario: '', otrosCostosDiarios: '' });
  const [goal, setGoal] = useState({ pesoObjetivo: '', fechaObjetivo: '' });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [generatingPdf, setGeneratingPdf] = useState(false);

  const loadPesajes = async () => {
    if (!resolvedAnimalId) return;
    setLoading(true);
    setError('');
    try {
      const [animalRow, rows] = await Promise.all([
        ganaderiaApi.getAnimal(resolvedAnimalId),
        ganaderiaApi.listAnimalPesajesEvolucion(resolvedAnimalId),
      ]);
      setAnimal(animalRow);
      setPesajes(rows);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadPesajes();
  }, [resolvedAnimalId]);

  const pesoNacimientoRow = useMemo(() => {
    const pesoNacimiento = getPesoNacimiento(animal);
    if (!Number.isFinite(pesoNacimiento)) return null;

    const fechaNacimiento = formatDate(getFechaNacimiento(animal)) || formatDate(getFecha(sortByDateAsc(pesajes)[0])) || todayLocal();
    const hasInitialRecord = pesajes.some((pesaje) => /peso\s+(inicial|al\s+nacimiento|nacimiento)/i.test(String(valueOf(pesaje, ['observaciones', 'notes']))));
    if (hasInitialRecord) return null;

    const alreadyExists = pesajes.some((pesaje) => {
      const peso = getPeso(pesaje);
      return formatDate(getFecha(pesaje)) === fechaNacimiento && Number.isFinite(peso) && Math.abs(peso - pesoNacimiento) < 0.001;
    });

    if (alreadyExists) return null;

    return {
      pesaje_id: 'peso-nacimiento',
      fecha_pesaje: fechaNacimiento,
      peso_kg: pesoNacimiento,
      observaciones: 'Peso al nacimiento registrado en ficha animal',
      es_peso_nacimiento: true,
      animal_origen: animal,
    };
  }, [animal, pesajes]);

  const pesajesConPesoInicial = useMemo(
    () => (pesoNacimientoRow ? [pesoNacimientoRow, ...pesajes] : pesajes),
    [pesoNacimientoRow, pesajes],
  );

  const fechaNacimientoAnalisis = useMemo(
    () => getFechaNacimientoProductiva(animal, pesajesConPesoInicial),
    [animal, pesajesConPesoInicial],
  );
  const animalConFechaAnalisis = useMemo(
    () => ({ ...(animal || {}), fecha_nacimiento: fechaNacimientoAnalisis || valueOf(animal, ['fecha_nacimiento']) }),
    [animal, fechaNacimientoAnalisis],
  );

  const categoriaProductiva = useMemo(() => clasificarCategoriaActual(animalConFechaAnalisis), [animalConFechaAnalisis]);
  const umbralesGDP = useMemo(() => obtenerUmbralesGDP(categoriaProductiva), [categoriaProductiva]);
  const enrichedRows = useMemo(
    () => enrichRows(pesajesConPesoInicial, categoriaProductiva, umbralesGDP, animalConFechaAnalisis),
    [pesajesConPesoInicial, categoriaProductiva, umbralesGDP, animalConFechaAnalisis],
  );

  const summary = useMemo(() => {
    const first = enrichedRows[0];
    const last = enrichedRows[enrichedRows.length - 1];
    const previous = enrichedRows[enrichedRows.length - 2];
    const firstWeight = first ? getPeso(first) : null;
    const lastWeight = last ? getPeso(last) : null;
    const previousWeight = previous ? getPeso(previous) : null;
    const difference = Number.isFinite(firstWeight) && Number.isFinite(lastWeight) && enrichedRows.length >= 2 ? lastWeight - firstWeight : null;
    const firstDate = first ? new Date(getFecha(first)).getTime() : null;
    const lastDate = last ? new Date(getFecha(last)).getTime() : null;
    const daysBetween =
      Number.isFinite(firstDate) && Number.isFinite(lastDate) && enrichedRows.length >= 2 ? Math.round((lastDate - firstDate) / 86400000) : null;
    const historicalDailyAverage = Number.isFinite(difference) && daysBetween > 0 ? difference / daysBetween : null;
    const recentDailyAverage = last?.ganancia_diaria_kg ?? null;
    const hasEnoughData = enrichedRows.length >= 2 && Number.isFinite(recentDailyAverage);
    const statusInfo = classifyProductivity(recentDailyAverage, last?.diferencia_kg, hasEnoughData, umbralesGDP);
    const hasHistoricalData = enrichedRows.length >= 2 && Number.isFinite(historicalDailyAverage);
    const historicalStatusInfo = classifyProductivity(historicalDailyAverage, difference, hasHistoricalData, umbralesGDP);
    const lastDateValue = last ? new Date(getFecha(last)).getTime() : null;
    const daysSinceLast = Number.isFinite(lastDateValue) ? Math.floor((new Date(todayLocal()) - new Date(lastDateValue)) / 86400000) : null;
    const timeAlert = classifyTimeSinceLastWeighing(daysSinceLast);
    const interpretacionTecnica = technicalInterpretation(statusInfo, timeAlert);

    return {
      total: enrichedRows.length,
      primerPeso: firstWeight,
      ultimoPeso: lastWeight,
      pesoAnterior: previousWeight,
      diferencia: difference,
      diasEntrePrimerUltimo: daysBetween,
      gdpHistorico: historicalDailyAverage,
      gdpReciente: recentDailyAverage,
      promedioDiario: recentDailyAverage,
      gananciaMensual: Number.isFinite(recentDailyAverage) ? recentDailyAverage * 30 : null,
      ultimoPesajeFecha: last ? formatDateDisplay(getFecha(last)) : '',
      ultimoPesajeHace: last ? daysSince(getFecha(last)) : '—',
      diasDesdeUltimoPesaje: daysSinceLast,
      timeAlert,
      categoriaProductiva,
      umbralesGDP,
      umbralAplicado: thresholdText(umbralesGDP),
      lastPeriodDays: last?.dias_entre_pesajes ?? null,
      statusInfo,
      historicalStatusInfo,
      interpretacionTecnica,
      trendLabel: statusInfo.trendLabel || statusInfo.label,
      lastDifference: last?.diferencia_kg ?? null,
    };
  }, [enrichedRows, categoriaProductiva, umbralesGDP]);

  const projections = useMemo(() => {
    const canProjectRecent = Number.isFinite(summary.gdpReciente) && summary.gdpReciente > 0 && Number.isFinite(summary.ultimoPeso);
    const canProjectHistorical = Number.isFinite(summary.gdpHistorico) && summary.gdpHistorico > 0 && Number.isFinite(summary.ultimoPeso);
    const canProjectPotential = Number.isFinite(summary.umbralesGDP?.excelente) && summary.umbralesGDP.excelente > 0 && Number.isFinite(summary.ultimoPeso);
    const projectWith = (gdp, days) => (Number.isFinite(gdp) && gdp > 0 && Number.isFinite(summary.ultimoPeso) ? summary.ultimoPeso + gdp * days : null);
    const estimateDateForWeight = (targetWeight, gdp = summary.gdpReciente) => {
      if (!Number.isFinite(gdp) || gdp <= 0 || !Number.isFinite(summary.ultimoPeso) || summary.ultimoPeso >= targetWeight) return null;
      const daysToTarget = Math.ceil((targetWeight - summary.ultimoPeso) / gdp);
      const estimatedDate = new Date(todayLocal());
      estimatedDate.setDate(estimatedDate.getDate() + daysToTarget);
      return { days: daysToTarget, date: estimatedDate.toISOString().slice(0, 10) };
    };

    return {
      d30: canProjectRecent ? projectWith(summary.gdpReciente, 30) : null,
      d60: canProjectRecent ? projectWith(summary.gdpReciente, 60) : null,
      d90: canProjectRecent ? projectWith(summary.gdpReciente, 90) : null,
      escenarios: [
        { label: 'Escenario actual', detail: 'GDP reciente', className: summary.statusInfo?.className || 'estado-sin-programacion', d30: projectWith(summary.gdpReciente, 30), d60: projectWith(summary.gdpReciente, 60), d90: projectWith(summary.gdpReciente, 90), enabled: canProjectRecent },
        { label: 'Escenario histórico', detail: 'GDP histórico', className: summary.historicalStatusInfo?.className || 'estado-sin-programacion', d30: projectWith(summary.gdpHistorico, 30), d60: projectWith(summary.gdpHistorico, 60), d90: projectWith(summary.gdpHistorico, 90), enabled: canProjectHistorical },
        { label: 'Escenario óptimo', detail: 'Umbral excelente esperado', className: 'estado-vigente', d30: projectWith(summary.umbralesGDP?.excelente, 30), d60: projectWith(summary.umbralesGDP?.excelente, 60), d90: projectWith(summary.umbralesGDP?.excelente, 90), enabled: canProjectPotential },
      ],
      venta550: estimateDateForWeight(550),
    };
  }, [summary]);

  const rentabilidad = useMemo(() => {
    const precioKg = Number(toApiDecimal(economics.precioKg || '0'));
    const costoDiario = economics.costoDiario ? Number(toApiDecimal(economics.costoDiario)) : null;
    const otrosCostosDiarios = economics.otrosCostosDiarios ? Number(toApiDecimal(economics.otrosCostosDiarios)) : 0;
    if (!Number.isFinite(precioKg) || precioKg <= 0) return null;
    const totalCostoDiario = (Number.isFinite(costoDiario) ? costoDiario : 0) + (Number.isFinite(otrosCostosDiarios) ? otrosCostosDiarios : 0);
    const valorGanancia = Number.isFinite(summary.diferencia) ? summary.diferencia * precioKg : null;
    const valor30 = Number.isFinite(summary.gananciaMensual) ? summary.gananciaMensual * precioKg : null;
    const margen30 = Number.isFinite(valor30) && totalCostoDiario > 0 ? valor30 - totalCostoDiario * 30 : null;
    const diasPeriodo = summary.lastPeriodDays;
    const costoTotalPeriodo = Number.isFinite(diasPeriodo) && totalCostoDiario > 0 ? totalCostoDiario * diasPeriodo : null;
    const valorBrutoPeriodo = Number.isFinite(summary.lastDifference) ? summary.lastDifference * precioKg : null;
    const margenPeriodo = Number.isFinite(valorBrutoPeriodo) && Number.isFinite(costoTotalPeriodo) ? valorBrutoPeriodo - costoTotalPeriodo : null;
    const costoPorKgGanado = Number.isFinite(costoTotalPeriodo) && summary.lastDifference > 0 ? costoTotalPeriodo / summary.lastDifference : null;
    const retornoEstimado = Number.isFinite(valorBrutoPeriodo) && Number.isFinite(costoTotalPeriodo) && costoTotalPeriodo > 0 ? valorBrutoPeriodo / costoTotalPeriodo : null;
    return {
      precioKg,
      costoDiario,
      otrosCostosDiarios,
      totalCostoDiario,
      valorGanancia,
      valor30,
      margen30,
      costoTotalPeriodo,
      valorBrutoPeriodo,
      margenPeriodo,
      costoPorKgGanado,
      retornoEstimado,
    };
  }, [economics, summary]);

  const productiveGoal = useMemo(() => {
    const pesoObjetivo = goal.pesoObjetivo ? Number(toApiDecimal(goal.pesoObjetivo)) : null;
    if (!Number.isFinite(pesoObjetivo) || pesoObjetivo <= 0) return null;
    if (Number.isFinite(summary.ultimoPeso) && summary.ultimoPeso >= pesoObjetivo) {
      return { pesoObjetivo, achieved: true, message: 'Meta alcanzada.' };
    }
    if (!Number.isFinite(summary.gdpReciente) || summary.gdpReciente <= 0) {
      return { pesoObjetivo, achieved: false, message: 'No es posible proyectar meta con GDP actual.' };
    }
    const kgFaltantes = pesoObjetivo - summary.ultimoPeso;
    const diasEstimados = kgFaltantes / summary.gdpReciente;
    const estimatedDate = new Date(todayLocal());
    estimatedDate.setDate(estimatedDate.getDate() + Math.ceil(diasEstimados));
    return {
      pesoObjetivo,
      fechaObjetivo: goal.fechaObjetivo,
      kgFaltantes,
      diasEstimados,
      fechaEstimada: estimatedDate.toISOString().slice(0, 10),
      achieved: false,
      message: goal.fechaObjetivo ? `Fecha objetivo: ${formatDateDisplay(goal.fechaObjetivo)}` : 'Proyección calculada con GDP reciente.',
    };
  }, [goal, summary]);

  const performance = useMemo(() => calcularTendenciaPesajes(enrichedRows), [enrichedRows]);

  const chartData = useMemo(
    () =>
      enrichedRows.map((row) => ({
        fecha: formatDateDisplay(getFecha(row)),
        fechaIso: formatDate(getFecha(row)),
        peso: getPeso(row),
        pesoAnterior: row.peso_anterior,
        pesoAnteriorLabel: row.es_peso_nacimiento || !Number.isFinite(row.peso_anterior) ? 'Registro inicial' : formatMetric(row.peso_anterior, ' kg'),
        diferencia: row.diferencia_kg,
        diferenciaLabel: row.es_peso_nacimiento || !Number.isFinite(row.diferencia_kg) ? 'Registro inicial' : formatMetric(row.diferencia_kg, ' kg'),
        dias: row.dias_entre_pesajes,
        intervaloLabel: row.es_peso_nacimiento || !Number.isFinite(row.dias_entre_pesajes) ? 'Registro inicial' : formatDays(row.dias_entre_pesajes),
        edad: row.edad_texto_en_pesaje,
        gdp: row.ganancia_diaria_kg,
        gdpLabel: row.es_peso_nacimiento || !Number.isFinite(row.ganancia_diaria_kg) ? 'Registro inicial' : formatMetric(row.ganancia_diaria_kg, ' kg/día'),
        estado: row.estado_productivo,
        estadoClass: row.estado_productivo_class,
        categoria: row.categoria_evaluada,
        umbrales: row.umbrales_evaluados,
        umbralLabel: thresholdText(row.umbrales_evaluados || obtenerUmbralesGDP(row.categoria_evaluada)),
      })),
    [enrichedRows],
  );

  const chartSegmentData = useMemo(() => {
    const data = chartData.map((point) => ({ ...point }));
    const segments = [];
    for (let index = 1; index < data.length; index += 1) {
      const key = `segment_${index}`;
      data[index - 1][key] = data[index - 1].peso;
      data[index][key] = data[index].peso;
      segments.push({
        key,
        color: chartColorForState(data[index].estadoClass),
        state: data[index].estado,
      });
    }
    return { data, segments };
  }, [chartData]);

  const gdpChartSegmentData = useMemo(() => {
    const data = chartData.map((point) => ({
      ...point,
      gdpPlot: Number.isFinite(point.gdp) ? point.gdp : null,
    }));
    const segments = [];
    for (let index = 2; index < data.length; index += 1) {
      const key = `gdp_segment_${index}`;
      data[index - 1][key] = data[index - 1].gdpPlot;
      data[index][key] = data[index].gdpPlot;
      segments.push({
        key,
        color: chartColorForState(data[index].estadoClass),
        state: data[index].estado,
      });
    }
    return { data, segments };
  }, [chartData]);

  const historyRows = useMemo(() => [...enrichedRows].reverse(), [enrichedRows]);

  const nextWeight = form.peso_kg && isValidCommaDecimal(form.peso_kg) ? Number(toApiDecimal(form.peso_kg)) : null;
  const weightLossWarning = Number.isFinite(nextWeight) && Number.isFinite(summary.ultimoPeso) && nextWeight < summary.ultimoPeso;

  const update = (field, value) => setForm((current) => ({ ...current, [field]: value }));
  const updateWeight = (value) => {
    if (isCommaDecimalInput(value)) update('peso_kg', value);
  };
  const updateEconomics = (field, value) => {
    if (value === '' || isCommaDecimalInput(value)) setEconomics((current) => ({ ...current, [field]: value }));
  };
  const updateGoal = (field, value) => {
    if (field === 'pesoObjetivo' && value !== '' && !isCommaDecimalInput(value)) return;
    setGoal((current) => ({ ...current, [field]: value }));
  };

  const submit = async (event) => {
    event.preventDefault();
    setError('');
    setStatus('');

    if (!resolvedAnimalId) {
      setError('No hay animal válido para registrar pesaje.');
      return;
    }

    if (!form.fecha_pesaje) {
      setError('La fecha de pesaje es obligatoria.');
      return;
    }

    if (form.fecha_pesaje > todayLocal()) {
      setError('La fecha de pesaje no puede ser futura.');
      return;
    }

    if (!isValidCommaDecimal(form.peso_kg)) {
      setError('Ingresa el peso con coma y máximo dos decimales. Ejemplo: 56,45.');
      return;
    }

    const next = Number(toApiDecimal(form.peso_kg));
    if (!Number.isFinite(next) || next <= 0) {
      setError('El peso debe ser mayor que 0.');
      return;
    }

    if (Number.isFinite(summary.ultimoPeso)) {
      const percentDifference = Math.abs(next - summary.ultimoPeso) / summary.ultimoPeso;
      if (percentDifference > 0.3) {
        const confirmed = window.confirm('El nuevo peso difiere más del 30% respecto al último peso registrado. Confirma si deseas guardarlo.');
        if (!confirmed) return;
      }
    }

    try {
      await ganaderiaApi.createPesaje({
        animal_id: resolvedAnimalId,
        fecha_pesaje: form.fecha_pesaje,
        peso_kg: toApiDecimal(form.peso_kg),
        observaciones: form.observaciones,
      });
      setForm({ fecha_pesaje: todayLocal(), peso_kg: '', observaciones: '' });
      setStatus('Pesaje registrado en PostgreSQL');
      await loadPesajes();
    } catch (err) {
      setError(err.message);
    }
  };

  const downloadPdf = async () => {
    setError('');
    setStatus('');
    setGeneratingPdf(true);
    try {
      const report = {
        animal: {
          nombre: animalLabel(animal, `Animal ${resolvedAnimalId}`),
          qr: animalQrLabel(animal),
          raza: animalBreedLabel(animal),
          sexo: valueOf(animal, ['sexo', 'sex']) || '--',
          edad: animalAgeLabel(animalConFechaAnalisis, fechaNacimientoAnalisis),
        },
        resumen: summary,
        estado: summary.statusInfo,
        historial: enrichedRows,
        proyecciones: projections,
        rentabilidad,
        meta: productiveGoal,
        desempeno: performance,
        generatedAt: new Date().toLocaleString('es-CO'),
      };
      const blob = await createProductiveReportPdfBlob(report);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = productiveReportFileName(report.animal.nombre, report.animal.qr);
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setStatus('Informe productivo descargado en PDF.');
    } catch (err) {
      setError(err.message || 'No se pudo generar el informe productivo.');
    } finally {
      setGeneratingPdf(false);
    }
  };

  return (
    <div className="gan-stack gan-productivity">
      <div className="gan-metric-grid gan-health-summary gan-productivity-summary">
        <article className="estado-neutro">
          <span className="gan-metric-title"><span className="gan-card-icon" aria-hidden="true">⚖️</span><span>Peso actual</span></span>
          <strong>{formatMetric(summary.ultimoPeso, ' kg')}</strong>
        </article>
        <article className={classForGdp(summary.gdpReciente, summary.umbralesGDP)}>
          <span className="gan-metric-title"><span className="gan-card-icon" aria-hidden="true">📈</span><span>GDP reciente</span></span>
          <strong>{formatMetric(summary.gdpReciente, ' kg/día')}</strong>
        </article>
        <article className={classForGdp(summary.gdpHistorico, summary.umbralesGDP)}>
          <span className="gan-metric-title"><span className="gan-card-icon" aria-hidden="true">📊</span><span>GDP histórico</span></span>
          <strong>{formatMetric(summary.gdpHistorico, ' kg/día')}</strong>
        </article>
        <article className={classForGdp(summary.gdpReciente, summary.umbralesGDP)}>
          <span className="gan-metric-title"><span className="gan-card-icon" aria-hidden="true">📅</span><span>Ganancia mensual proyectada</span></span>
          <strong>{formatMetric(summary.gananciaMensual, ' kg/mes')}</strong>
        </article>
        <article className={summary.timeAlert.className}>
          <span className="gan-metric-title"><span className="gan-card-icon" aria-hidden="true">🗓️</span><span>Último pesaje</span></span>
          <strong>{summary.ultimoPesajeFecha || '—'}</strong>
          <small className="gan-metric-note">{summary.ultimoPesajeHace}</small>
          <small className="gan-metric-note">{summary.timeAlert.message}</small>
        </article>
        <article className={`gan-general-status ${summary.statusInfo.className}`}>
          <span className="gan-metric-title"><span className="gan-card-icon" aria-hidden="true">{summary.statusInfo.icon}</span><span>Estado productivo general</span></span>
          <strong>{summary.statusInfo.label}</strong>
          <small>{summary.statusInfo.description}</small>
        </article>
      </div>

      <div className="gan-breed-box gan-animal-dashboard">
        <div className="gan-section-heading">
          <span className="gan-eyebrow">Resumen productivo del animal</span>
          <h3>{animalLabel(animal, `Animal ${resolvedAnimalId}`)}</h3>
        </div>
        <div className="gan-animal-meta">
          <span><strong>QR:</strong> {animalQrLabel(animal)}</span>
          <span><strong>Raza:</strong> {animalBreedLabel(animal)}</span>
          <span><strong>Sexo:</strong> {valueOf(animal, ['sexo', 'sex']) || '--'}</span>
          <span><strong>Edad:</strong> {animalAgeLabel(animalConFechaAnalisis, fechaNacimientoAnalisis)}</span>
          <span><strong>Categoría:</strong> {summary.categoriaProductiva}</span>
        </div>
        <div className="gan-dashboard-grid">
          <article className="estado-neutro"><span>Peso inicial</span><strong>{formatMetric(summary.primerPeso, ' kg')}</strong></article>
          <article className="estado-neutro"><span>Peso actual</span><strong>{formatMetric(summary.ultimoPeso, ' kg')}</strong></article>
          <article className="estado-neutro"><span>Peso anterior</span><strong>{formatMetric(summary.pesoAnterior, ' kg')}</strong></article>
          <article className={classForDifference(summary.diferencia)}><span>Ganancia acumulada</span><strong>{formatMetric(summary.diferencia, ' kg')}</strong></article>
          <article className={classForDifference(summary.lastDifference)}><span>Diferencia último pesaje</span><strong>{formatMetric(summary.lastDifference, ' kg')}</strong></article>
          <article className={classForGdp(summary.gdpReciente, summary.umbralesGDP)}><span>GDP reciente</span><strong>{formatMetric(summary.gdpReciente, ' kg/día')}</strong></article>
          <article className={classForGdp(summary.gdpHistorico, summary.umbralesGDP)}><span>GDP histórico</span><strong>{formatMetric(summary.gdpHistorico, ' kg/día')}</strong></article>
          <article className={summary.statusInfo.className}><span>Estado actual</span><strong>{summary.statusInfo.label}</strong></article>
          <article className={summary.historicalStatusInfo.className}><span>Estado histórico</span><strong>{summary.historicalStatusInfo.label}</strong></article>
          <article className="estado-neutro gan-threshold-card"><span>Umbral aplicado</span><ThresholdSemaforo thresholds={summary.umbralesGDP} /></article>
          <article className="estado-neutro"><span>Total pesajes</span><strong>{summary.total}</strong></article>
        </div>
      </div>

      <form className="gan-form gan-productivity-form" onSubmit={submit}>
        <FormField label="Fecha">
          <input
            max={todayLocal()}
            type="date"
            value={form.fecha_pesaje}
            onChange={(event) => update('fecha_pesaje', event.target.value)}
            required
          />
        </FormField>
        <FormField label="Peso kg">
          <input
            inputMode="decimal"
            pattern="[0-9]+(,[0-9]{1,2})?"
            placeholder="56,45"
            value={form.peso_kg}
            onChange={(event) => updateWeight(event.target.value)}
            required
          />
        </FormField>
        <FormField label="Observaciones">
          <textarea value={form.observaciones} onChange={(event) => update('observaciones', event.target.value)} />
        </FormField>
        {weightLossWarning ? (
          <div className="gan-inline-warning">Advertencia: el animal registra pérdida de peso.</div>
        ) : null}
        <button className="gan-submit" type="submit">
          <Save className="h-5 w-5" />
          Guardar pesaje
        </button>
      </form>

      <StatusMessage type="success">{status}</StatusMessage>
      <StatusMessage type="error">{error}</StatusMessage>

      <div className={`gan-feature-alert gan-feature-alert-premium ${summary.statusInfo.className}`}>
        <span className="gan-feature-icon" aria-hidden="true">{summary.statusInfo.icon}</span>
        <div>
          <span className="gan-feature-kicker">Alerta productiva</span>
          <strong>
            {summary.statusInfo.label === 'Sin datos'
              ? 'Sin análisis productivo'
              : `Estado productivo: ${summary.statusInfo.label}`}
          </strong>
          <span>{animalLabel(animal, `Animal ${resolvedAnimalId}`)}</span>
          <small>Sexo: {valueOf(animal, ['sexo', 'sex']) || '--'}</small>
          <small>Edad: {animalAgeLabel(animalConFechaAnalisis)}</small>
          <small>Categoría productiva: {summary.categoriaProductiva}</small>
          <small>GDP reciente: {formatMetric(summary.gdpReciente, ' kg/día')}</small>
          <small>GDP histórico: {formatMetric(summary.gdpHistorico, ' kg/día')}</small>
          <small>Tendencia: {performance.tendencia}</small>
          <small>Estado histórico: {summary.historicalStatusInfo.label}</small>
          <small>Última diferencia: {formatMetric(summary.lastDifference, ' kg')}</small>
          <small>Último pesaje: {summary.ultimoPesajeHace}. {summary.timeAlert.message}</small>
          <small>Umbral aplicado: {summary.umbralAplicado}</small>
          <span>{summary.interpretacionTecnica}</span>
          <small>
            {Number.isFinite(summary.gdpReciente)
              ? `Estado calculado con GDP reciente: ${formatMetric(summary.gdpReciente, ' kg/día')}`
              : 'Registra al menos dos pesajes con fechas diferentes.'}
          </small>
        </div>
      </div>

      <div className="gan-breed-box">
        <div className="gan-section-heading">
          <span className="gan-eyebrow">Crecimiento</span>
          <h3>Evolución del peso</h3>
        </div>
        {chartData.length ? (
          <div className="gan-weight-chart gan-productivity-chart">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartSegmentData.data} margin={{ top: 12, right: 18, left: 0, bottom: 4 }}>
                <CartesianGrid stroke="rgba(255,255,255,0.08)" vertical={false} />
                <XAxis dataKey="fecha" stroke="#a7b3c2" tick={{ fill: '#a7b3c2', fontSize: 12 }} tickMargin={10} />
                <YAxis
                  stroke="#a7b3c2"
                  tick={{ fill: '#a7b3c2', fontSize: 12 }}
                  tickFormatter={(value) => `${value} kg`}
                  width={58}
                />
                <Tooltip
                  wrapperStyle={{ maxWidth: 260, zIndex: 10 }}
                  contentStyle={{
                    background: '#081017',
                    border: '1px solid rgba(154,255,0,0.35)',
                    borderRadius: '0.6rem',
                    color: '#f6f8fb',
                  }}
                  formatter={(value, name) => {
                    if (name === 'peso') return [`${formatNumber(Number(value))} kg`, 'Peso'];
                    return [formatNumber(Number(value)), name];
                  }}
                  labelFormatter={(label) => `Fecha: ${label}`}
                  content={({ active, payload, label }) => {
                    if (!active || !payload?.length) return null;
                    const row = payload.find((item) => item.dataKey === 'peso')?.payload || payload[0].payload;
                    return (
                      <div className="gan-chart-tooltip">
                        <strong>Fecha: {label}</strong>
                        <span>Peso: {formatMetric(row.peso, ' kg')}</span>
                        <span>Anterior: {row.pesoAnteriorLabel}</span>
                        <span>Dif.: {row.diferenciaLabel}</span>
                        <span>Intervalo: {row.intervaloLabel}</span>
                        <span>Edad: {formatAgeMonths(row.edad)}</span>
                        <span>GDP: {row.gdpLabel}</span>
                        <span>Estado: {row.estado}</span>
                        <span>Categoría: {row.categoria}</span>
                        <small>Umbral: {row.umbralLabel}</small>
                      </div>
                    );
                  }}
                />
                {chartSegmentData.segments.map((segment) => (
                  <Line
                    key={segment.key}
                    dataKey={segment.key}
                    dot={false}
                    activeDot={false}
                    connectNulls={false}
                    isAnimationActive={false}
                    legendType="none"
                    stroke={segment.color}
                    strokeWidth={4}
                    type="monotone"
                  />
                ))}
                <Line
                  dataKey="peso"
                  name="peso"
                  stroke="rgba(255,255,255,0)"
                  strokeWidth={1}
                  dot={({ cx, cy, payload }) => {
                    const color = chartColorForState(payload.estadoClass);
                    return <circle cx={cx} cy={cy} r={5} fill={color} stroke="#f6f8fb" strokeWidth={1.6} />;
                  }}
                  activeDot={{ r: 6 }}
                  type="monotone"
                />
              </LineChart>
            </ResponsiveContainer>
            <div className="gan-chart-legend" aria-label="Leyenda de estados productivos">
              <span><i className="gan-chart-dot estado-sin-programacion" /> Inicial</span>
              <span><i className="gan-chart-dot estado-vigente" /> Excelente</span>
              <span><i className="gan-chart-dot estado-proxima" /> Aceptable</span>
              <span><i className="gan-chart-dot estado-vencida" /> Crítico</span>
            </div>
          </div>
        ) : (
          <p className="gan-empty-text">Sin datos suficientes para graficar.</p>
        )}
      </div>

      <div className="gan-breed-box">
        <div className="gan-section-heading">
          <span className="gan-eyebrow">Crecimiento</span>
          <h3>Ganancia diaria de peso</h3>
        </div>
        {chartData.some((row) => Number.isFinite(row.gdp)) ? (
          <div className="gan-weight-chart gan-productivity-chart">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={gdpChartSegmentData.data} margin={{ top: 12, right: 18, left: 0, bottom: 4 }}>
                <CartesianGrid stroke="rgba(255,255,255,0.08)" vertical={false} />
                <XAxis dataKey="fecha" stroke="#a7b3c2" tick={{ fill: '#a7b3c2', fontSize: 12 }} tickMargin={10} />
                <YAxis
                  stroke="#a7b3c2"
                  tick={{ fill: '#a7b3c2', fontSize: 12 }}
                  tickFormatter={(value) => `${formatNumber(Number(value))} kg/día`}
                  width={76}
                />
                <Tooltip
                  wrapperStyle={{ maxWidth: 250, zIndex: 10 }}
                  content={({ active, payload, label }) => {
                    if (!active || !payload?.length) return null;
                    const row = payload.find((item) => item.dataKey === 'gdpPlot')?.payload || payload[0].payload;
                    return (
                      <div className="gan-chart-tooltip">
                        <strong>Fecha: {label}</strong>
                        <span>GDP: {row.gdpLabel}</span>
                        <span>Estado: {row.estado}</span>
                        <span>Categoría: {row.categoria}</span>
                        <span>Intervalo: {row.intervaloLabel}</span>
                        <span>Dif.: {row.diferenciaLabel}</span>
                        <small>Umbral: {row.umbralLabel}</small>
                      </div>
                    );
                  }}
                />
                {gdpChartSegmentData.segments.map((segment) => (
                  <Line
                    key={segment.key}
                    dataKey={segment.key}
                    dot={false}
                    activeDot={false}
                    connectNulls={false}
                    isAnimationActive={false}
                    legendType="none"
                    stroke={segment.color}
                    strokeWidth={4}
                    type="monotone"
                  />
                ))}
                <Line
                  dataKey="gdpPlot"
                  name="GDP periodo"
                  stroke="rgba(255,255,255,0)"
                  strokeWidth={1}
                  dot={({ cx, cy, payload }) => {
                    if (!Number.isFinite(payload.gdpPlot)) return null;
                    const color = chartColorForState(payload.estadoClass);
                    return <circle cx={cx} cy={cy} r={5} fill={color} stroke="#f6f8fb" strokeWidth={1.6} />;
                  }}
                  activeDot={{ r: 6 }}
                  type="monotone"
                />
              </LineChart>
            </ResponsiveContainer>
            <div className="gan-chart-legend" aria-label="Leyenda de estados productivos">
              <span><i className="gan-chart-dot estado-vigente" /> Excelente</span>
              <span><i className="gan-chart-dot estado-proxima" /> Aceptable</span>
              <span><i className="gan-chart-dot estado-vencida" /> Crítico</span>
            </div>
          </div>
        ) : (
          <p className="gan-empty-text">Registra al menos dos pesajes para graficar GDP.</p>
        )}
      </div>

      <div className="gan-breed-box">
        <div className="gan-section-heading">
          <span className="gan-eyebrow">Meta productiva</span>
          <h3>Objetivo de peso</h3>
        </div>
        <div className="gan-form gan-economics-form">
          <FormField label="Peso objetivo kg">
            <input inputMode="decimal" placeholder="450,00" value={goal.pesoObjetivo} onChange={(event) => updateGoal('pesoObjetivo', event.target.value)} />
          </FormField>
          <FormField label="Fecha objetivo">
            <input type="date" value={goal.fechaObjetivo} onChange={(event) => updateGoal('fechaObjetivo', event.target.value)} />
          </FormField>
        </div>
        {productiveGoal ? (
          <div className="gan-dashboard-grid gan-projection-grid">
            <article className={productiveGoal.achieved ? 'estado-vigente' : 'estado-proxima'}><span>Kg faltantes</span><strong>{productiveGoal.achieved ? 'Meta alcanzada' : formatMetric(productiveGoal.kgFaltantes, ' kg')}</strong></article>
            <article className={productiveGoal.achieved ? 'estado-vigente' : 'estado-proxima'}><span>Días estimados</span><strong>{Number.isFinite(productiveGoal.diasEstimados) ? formatDays(Math.ceil(productiveGoal.diasEstimados)) : '----'}</strong></article>
            <article className={productiveGoal.achieved ? 'estado-vigente' : 'estado-proxima'}><span>Fecha estimada</span><strong>{productiveGoal.fechaEstimada ? formatDateDisplay(productiveGoal.fechaEstimada) : '----'}</strong></article>
            <article className={productiveGoal.achieved ? 'estado-vigente' : 'estado-sin-programacion'}><span>Estado meta</span><strong>{productiveGoal.message}</strong></article>
          </div>
        ) : (
          <p className="gan-empty-text">Ingrese un peso objetivo para proyectar la meta.</p>
        )}
      </div>

      <div className="gan-breed-box">
        <div className="gan-section-heading">
          <span className="gan-eyebrow">Desempeño productivo</span>
          <h3>Ranking local del animal</h3>
        </div>
        <div className="gan-dashboard-grid gan-projection-grid">
          {performance.hasComparativePeriods ? (
            <>
              <article className="estado-vigente"><span>Mejor periodo de ganancia</span><strong>{performance.best ? `${formatMetric(performance.best.ganancia_diaria_kg, ' kg/día')} (${formatDateDisplay(getFecha(performance.best))})` : '----'}</strong></article>
              <article className="estado-vencida"><span>Peor periodo de ganancia</span><strong>{performance.worst ? `${formatMetric(performance.worst.ganancia_diaria_kg, ' kg/día')} (${formatDateDisplay(getFecha(performance.worst))})` : '----'}</strong></article>
            </>
          ) : (
            <article className="estado-neutro"><span>Periodo evaluado</span><strong>{performance.best ? `${formatMetric(performance.best.ganancia_diaria_kg, ' kg/día')} (${formatDateDisplay(getFecha(performance.best))})` : '----'}</strong></article>
          )}
          <article className="estado-neutro"><span>Promedio histórico</span><strong>{formatMetric(summary.gdpHistorico, ' kg/día')}</strong></article>
          <article className={performance.trendClassName}><span>Tendencia actual</span><strong>{performance.tendencia}</strong></article>
          <article className="estado-neutro"><span>Animales comparados</span><strong>No disponible</strong></article>
          <article className="estado-neutro"><span>Posición / percentil</span><strong>No disponible</strong></article>
          <article className="estado-neutro"><span>Grupo comparable futuro</span><strong>Misma raza, sexo, edad y categoría productiva</strong></article>
          <article className="estado-neutro"><span>Mensaje comparativo</span><strong>Comparativo pendiente de datos poblacionales.</strong></article>
        </div>
      </div>

      <div className="gan-breed-box">
        <div className="gan-section-heading">
          <span className="gan-eyebrow">Proyección productiva</span>
          <h3>Peso proyectado</h3>
        </div>
        <p className="gan-empty-text">Proyección basada en desempeño productivo actual, histórico y potencial esperado para la categoría.</p>
        {Number.isFinite(summary.gdpReciente) ? (
          <div className="gan-dashboard-grid gan-projection-grid">
            {projections.escenarios.map((scenario) => (
              <article key={scenario.label} className={scenario.enabled ? scenario.className : 'estado-sin-programacion'}>
                <span>{scenario.label}</span>
                <strong>{scenario.detail}</strong>
                <small>30 días: {formatMetric(scenario.d30, ' kg')}</small>
                <small>60 días: {formatMetric(scenario.d60, ' kg')}</small>
                <small>90 días: {formatMetric(scenario.d90, ' kg')}</small>
              </article>
            ))}
            <article className={projections.venta550 ? summary.statusInfo.className : 'estado-sin-programacion'}><span>Fecha estimada 550 kg</span><strong>{projections.venta550 ? `${formatDateDisplay(projections.venta550.date)} (${formatDays(projections.venta550.days)})` : '----'}</strong></article>
          </div>
        ) : (
          <p className="gan-empty-text">Sin proyección disponible.</p>
        )}
      </div>

      <div className="gan-breed-box">
        <div className="gan-section-heading">
          <span className="gan-eyebrow">Rentabilidad estimada</span>
          <h3>Proyección económica</h3>
        </div>
        <p className="gan-empty-text">La rentabilidad estimada depende del mantenimiento del desempeño productivo actual.</p>
        <div className="gan-form gan-economics-form">
          <FormField label="Precio estimado por kg">
            <input inputMode="decimal" placeholder="8500,00" value={economics.precioKg} onChange={(event) => updateEconomics('precioKg', event.target.value)} />
          </FormField>
          <FormField label="Costo diario alimentación">
            <input inputMode="decimal" placeholder="12000,00" value={economics.costoDiario} onChange={(event) => updateEconomics('costoDiario', event.target.value)} />
          </FormField>
          <FormField label="Otros costos diarios">
            <input inputMode="decimal" placeholder="3000,00" value={economics.otrosCostosDiarios} onChange={(event) => updateEconomics('otrosCostosDiarios', event.target.value)} />
          </FormField>
        </div>
        {rentabilidad ? (
          <div className="gan-dashboard-grid gan-profit-grid">
            <article className="estado-vigente"><span>Valor bruto estimado por ganancia acumulada</span><strong>{formatMoney(rentabilidad.valorGanancia)}</strong></article>
            <article className="estado-proxima"><span>Ingreso proyectado 30 días</span><strong>{formatMoney(rentabilidad.valor30)}</strong></article>
            <article className="estado-proxima"><span>Valor bruto proyectado a 30 días</span><strong>{formatMoney(rentabilidad.valor30)}</strong></article>
            <article className="estado-proxima"><span>Valor bruto ganado periodo reciente</span><strong>{formatMoney(rentabilidad.valorBrutoPeriodo)}</strong></article>
            <article className="estado-neutro"><span>Costo total periodo reciente</span><strong>{formatMoney(rentabilidad.costoTotalPeriodo)}</strong></article>
            <article className={Number.isFinite(rentabilidad.margenPeriodo) && rentabilidad.margenPeriodo < 0 ? 'estado-vencida' : 'estado-vigente'}><span>Margen periodo reciente</span><strong>{formatMoney(rentabilidad.margenPeriodo)}</strong></article>
            <article className="estado-neutro"><span>Costo por kg ganado</span><strong>{formatMoney(rentabilidad.costoPorKgGanado)}</strong></article>
            <article className="estado-vigente"><span>Retorno estimado</span><strong>{Number.isFinite(rentabilidad.retornoEstimado) ? `${formatNumber(rentabilidad.retornoEstimado)}x` : '—'}</strong></article>
            {Number.isFinite(rentabilidad.margen30) ? (
              <article className={rentabilidad.margen30 < 0 ? 'estado-vencida' : 'estado-vigente'}><span>Margen estimado 30 días</span><strong>{formatMoney(rentabilidad.margen30)}</strong></article>
            ) : null}
          </div>
        ) : (
          <p className="gan-empty-text">Ingrese precio por kg para estimar rentabilidad.</p>
        )}
        <p className="gan-empty-text">Los valores son estimaciones y no representan utilidad neta final.</p>
      </div>

      <div className="gan-breed-box">
        <div className="gan-section-heading gan-pdf-heading">
          <div>
            <span className="gan-eyebrow">Histórico productivo</span>
            <h3>Pesajes registrados</h3>
          </div>
          <button className={`gan-secondary-button gan-pdf-button ${generatingPdf ? 'is-loading' : ''}`} disabled={generatingPdf} type="button" onClick={downloadPdf}>
            <Download className="h-5 w-5" />
            {generatingPdf ? 'Generando informe...' : 'Descargar informe productivo'}
          </button>
        </div>
        {loading ? (
          <p className="gan-empty-text">Cargando pesajes...</p>
        ) : historyRows.length ? (
          <div className="gan-pesajes-table gan-productivity-calendar">
            <div className="gan-pesajes-head">
              <span>Fecha</span>
              <span>Peso</span>
              <span>Peso anterior</span>
              <span>Diferencia</span>
              <span>Intervalo</span>
              <span>Edad</span>
              <span>GDP</span>
              <span>Estado</span>
              <span>Categoría</span>
            </div>
            {historyRows.map((pesaje) => {
              const rowStatus = {
                label: pesaje.estado_productivo,
                className: pesaje.estado_productivo_class,
              };
              return (
                <article className="gan-pesajes-row" key={pesaje.pesaje_id || `${getFecha(pesaje)}-${getPeso(pesaje)}`}>
                  <span className="gan-date-cell" data-label="Fecha">{formatDateDisplay(getFecha(pesaje))}</span>
                  <strong data-label="Peso">{formatMetric(getPeso(pesaje), ' kg')}</strong>
                  <span data-label="Peso anterior">{initialPlaceholder(pesaje, pesaje.peso_anterior, ' kg')}</span>
                  <span data-label="Diferencia">{initialPlaceholder(pesaje, pesaje.diferencia_kg, ' kg')}</span>
                  <span data-label="Intervalo">{initialIntervalPlaceholder(pesaje, pesaje.dias_entre_pesajes)}</span>
                  <span data-label="Edad">{formatAgeMonths(pesaje.edad_texto_en_pesaje)}</span>
                  <span data-label="GDP">{initialPlaceholder(pesaje, pesaje.ganancia_diaria_kg, ' kg/día')}</span>
                  <span data-label="Estado" className={`gan-alert-pill ${rowStatus.className}`}>{rowStatus.label}</span>
                  <span data-label="Categoría">{pesaje.categoria_evaluada}</span>
                  {valueOf(pesaje, ['observaciones', 'notes']) ? <small>{valueOf(pesaje, ['observaciones', 'notes'])}</small> : null}
                </article>
              );
            })}
          </div>
        ) : (
          <p className="gan-empty-text">Sin pesajes registrados.</p>
        )}
      </div>
    </div>
  );
}
