import {
  Baby,
  CalendarDays,
  ClipboardPlus,
  Download,
  Dna,
  DollarSign,
  FilePlus2,
  HeartPulse,
  Microscope,
  Save,
  ShieldCheck,
  Sparkles,
  TrendingUp,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ganaderiaApi } from '../api/ganaderiaApi.js';
import { FormField, StatusMessage } from '../components/FormField.jsx';
import { createReproductiveReportPdfBlob, reproductiveReportFileName } from './reproductiveReportPdf.js';

const today = () => new Date().toISOString().slice(0, 10);

const maleEvents = [
  'Evaluación reproductiva',
  'Monta natural',
  'Colecta seminal',
  'Prueba andrológica',
  'Diagnóstico seminal',
  'Servicio registrado',
  'Descarte reproductivo',
];

const femaleEvents = [
  'Celo',
  'Monta natural',
  'IA',
  'IATF',
  'Transferencia embrionaria',
  'Diagnóstico gestación',
  'Parto',
  'Aborto',
  'Secado',
  'Destete',
  'Lavado embrionario',
  'Aspiración folicular',
  'Descarte reproductivo',
];

const fallbackEvents = ['Evaluación reproductiva', 'Descarte reproductivo'];
const embryoResults = ['Preñada', 'Vacía', 'Pendiente'];
const evidenceTypes = ['Ecografía', 'Foto', 'Certificado embrión', 'Diagnóstico', 'PDF'];

const maleEventOptions = [
  'Evaluación reproductiva',
  'Monta natural',
  'Colecta seminal',
  'Prueba andrológica',
  'Diagnóstico seminal',
  'Servicio registrado',
  'Descarte reproductivo',
];

const femaleEventOptions = [
  'Celo',
  'Monta natural',
  'IA',
  'IATF',
  'Transferencia embrionaria',
  'Diagnóstico de gestación',
  'Parto',
  'Aborto',
  'Secado',
  'Destete',
  'Lavado embrionario',
  'Aspiración folicular',
  'Descarte reproductivo',
];

const fallbackEventOptions = ['Evaluación reproductiva', 'Descarte reproductivo'];

const reproductiveMethods = {
  Macho: ['Monta natural', 'Colecta seminal', 'Evaluación andrológica', 'Diagnóstico seminal'],
  Hembra: ['Monta natural', 'IA', 'IATF', 'Transferencia embrionaria', 'Diagnóstico gestacional'],
  fallback: ['Monta natural', 'Evaluación reproductiva'],
};

const initialEventForm = {
  metodo_reproductivo: '',
  tipo_evento: 'Evaluación reproductiva',
  fecha: today(),
  resultado: '',
  responsable: '',
  observaciones: '',
  costo: '',
  circunferencia_escrotal: '',
  motilidad: '',
  concentracion: '',
  morfologia: '',
  resultado_andrologico: '',
  metodo_gestacion: '',
  dias_gestacion: '',
  veterinario_responsable: '',
};

const initialEmbryoForm = {
  codigo_embrion: '',
  donadora: '',
  padre: '',
  raza_embrion: '',
  fecha_transferencia: today(),
  responsable: '',
  calidad: '1',
  sincronizacion: '',
  receptora: '',
  cl: '',
  diagnostico_gestacion: '',
  resultado: 'Pendiente',
};

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
  if (['macho', 'm', 'male'].includes(sex)) return 'Macho';
  if (['hembra', 'h', 'female'].includes(sex)) return 'Hembra';
  return 'No registrado';
}

function getBirthDate(animal) {
  return valueOf(animal, ['fecha_nacimiento', 'fechaNacimiento', 'nacimiento', 'fecha_nac', 'fechaNacimientoAnimal']);
}

function daysBetween(startValue, endValue) {
  if (!startValue || !endValue) return null;
  const start = new Date(`${String(startValue).slice(0, 10)}T00:00:00`).getTime();
  const end = new Date(`${String(endValue).slice(0, 10)}T00:00:00`).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.round((end - start) / 86400000);
}

function ageMonths(animal) {
  const directRaw = valueOf(animal, ['edad_meses']);
  const direct = Number(directRaw);
  if (String(directRaw || '').trim() !== '' && Number.isFinite(direct) && direct >= 0) return Math.round(direct);
  const birth = getBirthDate(animal);
  const days = daysBetween(birth, today());
  if (Number.isFinite(days) && days >= 0) return Math.floor(days / 30.44);
  const ageRaw = valueOf(animal, ['edad']);
  const age = Number(ageRaw);
  if (String(ageRaw || '').trim() !== '' && Number.isFinite(age) && age >= 0) return age > 60 ? Math.floor(age / 30.44) : Math.round(age);
  return null;
}

function formatDate(value) {
  if (!value) return '--';
  const [year, month, day] = String(value).slice(0, 10).split('-');
  return year && month && day ? `${day}-${month}-${year}` : String(value);
}

function parseMoney(value) {
  const number = Number(String(value || '0').replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(number) ? number : 0;
}

function formatMoney(value) {
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(Number(value || 0));
}

function sentenceCase(value) {
  if (value === null || value === undefined) return value;
  const text = String(value).trim();
  if (!text || /^[A-Z]{2,}-\d+/.test(text) || /^\d/.test(text)) return text;
  const hasLetters = /[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/.test(text);
  const isUpper = hasLetters && text === text.toUpperCase();
  const base = isUpper ? text.toLocaleLowerCase('es-CO') : text;
  const fixed = base
    .replace(/\bagx\b/gi, 'AGX')
    .replace(/\bqr\b/gi, 'QR')
    .replace(/\bgdp\b/gi, 'GDP')
    .replace(/\bia\b/g, 'IA')
    .replace(/\biatf\b/gi, 'IATF')
    .replace(/\bte\b/gi, 'TE');
  return fixed.charAt(0).toLocaleUpperCase('es-CO') + fixed.slice(1);
}

function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function percent(value) {
  return Number.isFinite(value) ? `${value.toFixed(0)}%` : '--';
}

function includesAny(value, words) {
  const text = String(value || '').toLowerCase();
  return words.some((word) => text.includes(word));
}

function statusTone(status) {
  const normalized = String(status || '').toLowerCase();
  if (['apta', 'preñada', 'parida', 'elite', 'positivo', 'alto', 'apto', 'mantener'].some((item) => normalized.includes(item))) return 'success';
  if (['protocolo', 'servida', 'seguimiento', 'aceptable', 'vacía', 'medio', 'esperar', 'desarrollo', 'controlado'].some((item) => normalized.includes(item))) return 'warning';
  if (['aborto', 'crítico', 'descartar', 'bajo', 'problema', 'descarte'].some((item) => normalized.includes(item))) return 'danger';
  return 'info';
}

function statusClass(status) {
  const tone = statusTone(status);
  if (tone === 'success') return 'estado-vigente';
  if (tone === 'warning') return 'estado-proxima';
  if (tone === 'danger') return 'estado-vencida';
  return 'estado-sin-programacion';
}

function reproductiveCategory(sex, months, animal, status) {
  const marker = `${valueOf(animal, ['categoria', 'category'])} ${valueOf(animal, ['proposito', 'purpose'])} ${status}`.toLowerCase();
  if (!Number.isFinite(months)) return 'Categoría no determinada';
  if (sex === 'Macho') {
    if (months <= 7) return 'Ternero lactante';
    if (months <= 12) return 'Ternero desteto';
    if (months <= 24) return 'Novillo de levante / desarrollo';
    if (includesAny(marker, ['reproductor', 'toro'])) return 'Toro reproductor';
    return 'Novillo de ceba';
  }
  if (sex === 'Hembra') {
    if (months <= 7) return 'Ternera lactante';
    if (months <= 12) return 'Ternera desteta';
    if (months <= 24) return 'Novilla de levante / desarrollo';
    if (includesAny(marker, ['preñada', 'gestante'])) return 'Vaca gestante';
    if (includesAny(marker, ['parida', 'lactante'])) return 'Vaca lactante';
    if (includesAny(marker, ['receptora'])) return 'Receptora';
    if (includesAny(marker, ['donadora', 'élite', 'elite'])) return 'Donadora';
    return 'Vaca vacía';
  }
  return 'No determinada';
}

function lastByDate(rows) {
  return [...rows].sort((a, b) => String(b.fecha || '').localeCompare(String(a.fecha || '')))[0] || null;
}

function normalizeReproductiveEvent(row) {
  return {
    ...row,
    persisted: true,
    tipo_evento: row.tipo_evento || row.evento || row.estado || 'Evento reproductivo',
    metodo_reproductivo: row.metodo_reproductivo || row.metodo || '',
    resultado: row.resultado || row.estado || row.diagnostico || '',
    responsable: row.responsable || '',
    costo: row.costo || 0,
    observaciones: row.observaciones || '',
  };
}

function resolveReproStatus(sex, months, events) {
  const last = lastByDate(events);
  if (!last) return 'Sin eventos registrados';
  const type = String(last.tipo_evento || '').toLowerCase();
  const result = String(last.resultado || '').toLowerCase();
  if (sex === 'Macho') {
    if (type.includes('descarte')) return 'Descarte reproductivo';
    if (type.includes('androl') || type.includes('seminal')) return result || 'Evaluado';
    if (type.includes('monta') || type.includes('servicio')) return 'Servicio registrado';
    return 'En seguimiento';
  }
  if (type.includes('parto')) return 'Parida';
  if (type.includes('aborto')) return 'Vacía';
  if (type.includes('diagnóstico') && (result.includes('preñ') || result.includes('positiv'))) return 'Preñada';
  if (type.includes('diagnóstico') && (result.includes('vacía') || result.includes('vacia') || result.includes('negativ'))) return 'Vacía';
  if (type.includes('ia') || type.includes('monta') || type.includes('transferencia')) return 'Servida';
  if (type.includes('celo')) return 'Apta';
  if (type.includes('iatf')) return 'En protocolo';
  return 'En protocolo';
}

function getAllowedEvents(sex) {
  if (sex === 'Macho') return maleEventOptions;
  if (sex === 'Hembra') return femaleEventOptions;
  return fallbackEventOptions;
}

function getAllowedMethods(sex, eventType) {
  const base = reproductiveMethods[sex] || reproductiveMethods.fallback;
  if (eventType === 'Prueba andrológica') return ['Evaluación andrológica'];
  if (eventType === 'Colecta seminal') return ['Colecta seminal'];
  if (eventType === 'Diagnóstico seminal') return ['Diagnóstico seminal'];
  if (eventType === 'Transferencia embrionaria') return ['Transferencia embrionaria'];
  if (eventType === 'Diagnóstico de gestación') return ['Diagnóstico gestacional'];
  if (eventType === 'IA' || eventType === 'IATF') return [eventType];
  if (eventType === 'Monta natural') return ['Monta natural'];
  return base;
}

function getReproductiveContext(animal, events = []) {
  const sex = normalizeSex(valueOf(animal, ['sexo', 'sex']));
  const months = ageMonths(animal);
  const reproductiveStatus = resolveReproStatus(sex, months, events);
  const category = reproductiveCategory(sex, months, animal, reproductiveStatus);
  const allowedEvents = getAllowedEvents(sex);

  if (sex === 'Macho') {
    const recommendations =
      Number.isFinite(months) && months < 18
        ? ['Animal macho en desarrollo. No recomendado para servicio intensivo.', 'Próximo paso: revisión a 18 meses.']
        : Number.isFinite(months) && months <= 24
          ? ['Apto con seguimiento.', 'Validar evaluación andrológica antes de uso intensivo.']
          : ['Apto como reproductor si condición corporal y sanidad son favorables.', 'Registrar prueba andrológica.'];
    return {
      sex,
      ageMonths: months,
      category,
      reproductiveRole: Number.isFinite(months) && months > 24 ? 'Reproductor potencial' : 'Macho joven',
      allowedEvents,
      recommendations,
      reproductiveStatus,
    };
  }

  if (sex === 'Hembra') {
    const recommendations =
      Number.isFinite(months) && months < 15
        ? ['En desarrollo reproductivo.', 'No iniciar servicio hasta validar edad, peso y sanidad.']
        : Number.isFinite(months) && months <= 18
          ? ['Evaluar peso, condición corporal y desarrollo.', 'Apta solo con seguimiento técnico.']
          : ['Apta para programa reproductivo si cumple sanidad y condición corporal.', 'Validar protocolo según objetivo productivo.'];
    return {
      sex,
      ageMonths: months,
      category,
      reproductiveRole: Number.isFinite(months) && months >= 18 ? 'Candidata reproductiva' : 'Hembra joven',
      allowedEvents,
      recommendations,
      reproductiveStatus,
    };
  }

  return {
    sex,
    ageMonths: months,
    category,
    reproductiveRole: 'No determinado',
    allowedEvents,
    recommendations: ['Registrar sexo y edad para activar análisis reproductivo.'],
    reproductiveStatus,
  };
}

function calculateMetrics(context, events) {
  const servicios = events.filter((event) =>
    ['Monta natural', 'IA', 'IATF', 'Transferencia embrionaria', 'Servicio registrado'].includes(event.tipo_evento),
  ).length;
  const montas = events.filter((event) => event.tipo_evento === 'Monta natural').length;
  const partos = context.sex === 'Hembra' ? events.filter((event) => event.tipo_evento === 'Parto').length : 0;
  const abortos = context.sex === 'Hembra' ? events.filter((event) => event.tipo_evento === 'Aborto').length : 0;
  const preneces = context.sex === 'Hembra' ? events.filter((event) => /preñ|positiv/i.test(String(event.resultado || ''))).length : 0;
  const costo = events.reduce((sum, event) => sum + parseMoney(event.costo), 0);
  const eficiencia = context.sex === 'Hembra' && servicios ? (preneces / servicios) * 100 : null;
  const evaluacionesSeminales = context.sex === 'Macho' ? events.filter((event) => /seminal|androl/i.test(event.tipo_evento)).length : 0;
  const partosOrdenados = events.filter((event) => event.tipo_evento === 'Parto').sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)));
  const ultimoParto = partosOrdenados.at(-1);
  const intervaloPartos = partosOrdenados.length >= 2 ? daysBetween(partosOrdenados.at(-2).fecha, partosOrdenados.at(-1).fecha) : null;
  const diasAbiertos = context.sex === 'Hembra' && ultimoParto && !['Preñada', 'Parida'].includes(context.reproductiveStatus) ? daysBetween(ultimoParto.fecha, today()) : null;
  const hasEnoughIndexData = context.sex === 'Macho' ? events.length > 0 && evaluacionesSeminales > 0 : events.length > 0 && (servicios > 0 || partos > 0 || preneces > 0);
  let index = null;
  if (hasEnoughIndexData) {
    if (context.sex === 'Macho') {
      const ageScore = Number.isFinite(context.ageMonths) && context.ageMonths >= 18 ? 20 : 8;
      index = Math.max(0, Math.min(100, 55 + ageScore + evaluacionesSeminales * 12 + servicios * 3));
    } else {
      const riskPenalty = abortos * 20 + Math.max(0, servicios - preneces) * 8 + (Number.isFinite(diasAbiertos) && diasAbiertos > 120 ? 15 : 0);
      index = Math.max(0, Math.min(100, 100 - riskPenalty));
    }
  }
  const ranking = !Number.isFinite(index) ? 'Índice no disponible' : index >= 95 ? 'AGX-A+' : index >= 85 ? 'AGX-A' : index >= 70 ? 'AGX-B' : 'AGX-C';
  return { servicios, montas, partos, abortos, preneces, costo, eficiencia, evaluacionesSeminales, intervaloPartos, diasAbiertos, index, ranking, hasEnoughIndexData, eventCount: events.length };
}

function maturityScore(context, metrics, vacunaciones) {
  let score = 0;
  if (Number.isFinite(context.ageMonths)) {
    if (context.sex === 'Macho') score += Math.min(55, Math.round((context.ageMonths / 24) * 55));
    else score += Math.min(55, Math.round((context.ageMonths / 18) * 55));
  }
  if (vacunaciones.length > 0) score += 15;
  if (context.category && !context.category.includes('no determinada')) score += 10;
  if (metrics.servicios > 0 || metrics.evaluacionesSeminales > 0 || metrics.preneces > 0) score += 20;
  return Math.max(0, Math.min(100, score));
}

function maturityText(score, context) {
  if (context.sex === 'Macho' && Number.isFinite(context.ageMonths) && context.ageMonths < 18) return 'No apto todavía';
  if (context.sex === 'Hembra' && Number.isFinite(context.ageMonths) && context.ageMonths < 15) return 'No apta todavía';
  if (score >= 76) return 'Aptitud alta';
  if (score >= 41) return 'Aptitud en seguimiento';
  return 'No apto todavía';
}

function getDecision(context, metrics) {
  if (!metrics.eventCount) return { state: 'SIN EVENTOS REGISTRADOS', action: 'No clasificar', next: 'Registrar evento real' };
  if (context.sex === 'Macho') {
    if (Number.isFinite(context.ageMonths) && context.ageMonths < 18) return { state: 'EN DESARROLLO', action: 'Esperar', next: 'Control a 18 meses' };
    if (Number.isFinite(context.ageMonths) && context.ageMonths <= 24) return { state: 'USO CONTROLADO', action: 'Evaluar', next: 'Prueba andrológica' };
    if (Number.isFinite(metrics.index) && metrics.index < 70) return { state: 'DESCARTE REPRODUCTIVO', action: 'Revisar', next: 'Valoración profesional' };
    return { state: 'APTO COMO REPRODUCTOR', action: 'Usar con control', next: 'Registrar servicio' };
  }
  if (context.sex === 'Hembra') {
    if (Number.isFinite(context.ageMonths) && context.ageMonths < 15) return { state: 'EN DESARROLLO', action: 'Esperar', next: 'Control a 15 meses' };
    if (metrics.abortos > 0 || (Number.isFinite(metrics.index) && metrics.index < 70)) return { state: 'DESCARTE REPRODUCTIVO', action: 'Revisar', next: 'Valoración profesional' };
    if (context.reproductiveStatus === 'Servida') return { state: 'CONFIRMAR GESTACIÓN', action: 'Diagnosticar', next: 'Ecografía o palpación' };
    if (context.reproductiveStatus === 'Apta') return { state: 'TRANSFERIR EMBRIÓN', action: 'Evaluar receptora', next: 'Sincronización' };
    return { state: 'ESPERAR', action: 'Seguimiento', next: 'Completar historial' };
  }
  return { state: 'ESPERAR', action: 'Registrar datos', next: 'Completar ficha' };
}

function embryoSuccess(form) {
  let score = form.calidad === '1' ? 68 : form.calidad === '2' ? 52 : 35;
  if (String(form.sincronizacion).trim()) score += 4;
  if (String(form.cl).trim()) score += 5;
  if (form.resultado === 'Preñada') score = Math.max(score, 75);
  if (form.resultado === 'Vacía') score = Math.min(score, 30);
  return Math.max(15, Math.min(90, score));
}

function embryoIndicator(score) {
  if (score > 60) return 'ALTO';
  if (score >= 40) return 'MEDIO';
  return 'BAJO';
}

function MetricCard({ icon: Icon, label, value, description, tone = 'info', className = '' }) {
  const toneClass = tone === 'success' ? 'is-success' : tone === 'warning' ? 'is-warning' : tone === 'danger' ? 'is-danger' : 'is-info';
  return (
    <article className={`metric-card ${toneClass} ${className}`}>
      {Icon ? <Icon className="metric-icon" aria-hidden="true" /> : null}
      <span className="metric-label">{sentenceCase(label)}</span>
      <strong className="metric-value">{sentenceCase(value)}</strong>
      {description ? <small className="metric-description">{description}</small> : null}
    </article>
  );
}

function KpiCard({ icon: Icon, label, value, detail, tone = 'info' }) {
  return <MetricCard icon={Icon} label={label} value={value} description={detail} tone={tone} className="gan-kpi-card repro-kpi-card" />;
}

function SummaryCard({ label, value, detail, tone, className = '' }) {
  return <MetricCard label={label} value={value} description={detail} tone={tone || 'info'} className={`gan-summary-card repro-data-card ${className}`} />;
}

function DecisionCard({ decision }) {
  return (
    <section className={`gan-panel repro-decision-panel ${statusClass(decision.state)}`}>
      <div className="gan-section-heading">
        <span className="gan-eyebrow">Decisión AGX</span>
        <h3>{sentenceCase(decision.state)}</h3>
      </div>
      <div className="repro-decision-grid">
        <SummaryCard label="Acción" value={decision.action} />
        <SummaryCard label="Próximo paso" value={decision.next} />
      </div>
    </section>
  );
}

export default function AnimalReproduccionTab() {
  const { id } = useParams();
  const [animal, setAnimal] = useState(null);
  const [razas, setRazas] = useState([]);
  const [pesajes, setPesajes] = useState([]);
  const [vacunaciones, setVacunaciones] = useState([]);
  const [events, setEvents] = useState([]);
  const [eventForm, setEventForm] = useState(initialEventForm);
  const [embryoForm, setEmbryoForm] = useState(initialEmbryoForm);
  const [evidenceName, setEvidenceName] = useState('');
  const [evidences, setEvidences] = useState([]);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [generatingPdf, setGeneratingPdf] = useState(false);

  useEffect(() => {
    let mounted = true;
    Promise.allSettled([
      ganaderiaApi.getAnimal(id),
      ganaderiaApi.getAnimalRazas(id),
      ganaderiaApi.listAnimalPesajesEvolucion(id),
      ganaderiaApi.listAnimalVacunaciones(id),
      ganaderiaApi.listAnimalReproduccion(id),
    ]).then((results) => {
      if (!mounted) return;
      const [animalResult, razasResult, pesajesResult, vacunasResult, reproduccionResult] = results;
      if (animalResult.status === 'fulfilled') setAnimal(animalResult.value);
      else setError(animalResult.reason?.message || 'No se pudo cargar el animal.');
      if (razasResult.status === 'fulfilled') setRazas(razasResult.value || []);
      if (pesajesResult.status === 'fulfilled') setPesajes(pesajesResult.value || []);
      if (vacunasResult.status === 'fulfilled') setVacunaciones(vacunasResult.value || []);
      if (reproduccionResult.status === 'fulfilled') setEvents((reproduccionResult.value || []).map(normalizeReproductiveEvent));
    });
    return () => { mounted = false; };
  }, [id]);

  const realEvents = useMemo(() => events.filter((event) => event.persisted), [events]);
  const context = useMemo(() => getReproductiveContext(animal, realEvents), [animal, realEvents]);
  const metrics = useMemo(() => calculateMetrics(context, realEvents), [context, realEvents]);
  const decision = getDecision(context, metrics);
  const lastEvent = lastByDate(events);
  const raza = razas.map((row) => row.nombre_raza || row.raza || row.nombre).filter(Boolean).join(' / ') || valueOf(animal, ['raza', 'nombre_raza']) || '--';
  const embryoProbability = embryoSuccess(embryoForm);
  const embryoTone = embryoProbability > 60 ? 'success' : embryoProbability >= 40 ? 'warning' : 'danger';
  const maturity = maturityScore(context, metrics, vacunaciones);
  const maturityTone = maturity >= 76 ? 'success' : maturity >= 41 ? 'warning' : 'danger';
  const isMale = context.sex === 'Macho';
  const isFemale = context.sex === 'Hembra';
  const allowedMethods = getAllowedMethods(context.sex, eventForm.tipo_evento);

  useEffect(() => {
    if (!context.allowedEvents.includes(eventForm.tipo_evento)) {
      setEventForm((current) => ({ ...current, tipo_evento: context.allowedEvents[0] || 'Evaluación reproductiva' }));
    }
  }, [context.allowedEvents, eventForm.tipo_evento]);

  useEffect(() => {
    if (!allowedMethods.includes(eventForm.metodo_reproductivo)) {
      setEventForm((current) => ({ ...current, metodo_reproductivo: allowedMethods[0] || '' }));
    }
  }, [allowedMethods, eventForm.metodo_reproductivo]);

  const submitEvent = async (event) => {
    event.preventDefault();
    setStatus('');
    setError('');
    if (!eventForm.fecha) {
      setError('La fecha del evento reproductivo es obligatoria.');
      return;
    }
    try {
      await ganaderiaApi.createReproduccion({
        animal_id: id,
        fecha: eventForm.fecha,
        tipo_evento: eventForm.tipo_evento,
        estado: eventForm.resultado,
        diagnostico: eventForm.resultado,
        metodo: eventForm.metodo_reproductivo,
        observaciones: eventForm.observaciones,
      });
      const updated = await ganaderiaApi.listAnimalReproduccion(id);
      setEvents((updated || []).map(normalizeReproductiveEvent));
      setEventForm({ ...initialEventForm, tipo_evento: context.allowedEvents[0] || 'Evaluación reproductiva', metodo_reproductivo: allowedMethods[0] || '' });
      setStatus('Evento reproductivo guardado correctamente en la trazabilidad del animal.');
    } catch (err) {
      setError(err.message || 'No fue posible guardar el evento reproductivo en PostgreSQL/API.');
    }
  };

  const addEvidence = () => {
    setError('');
    setStatus('Evidencias reproductivas pendientes de soporte PostgreSQL/API.');
  };

  if (!animal && !error) return <div className="gan-panel">Cargando módulo de reproducción...</div>;

  const ageText = Number.isFinite(context.ageMonths) ? `${context.ageMonths} meses` : '--';
  const edadReproductiva = isMale
    ? Number.isFinite(context.ageMonths) && context.ageMonths >= 18 ? 'Apto por edad' : 'En desarrollo'
    : Number.isFinite(context.ageMonths) && context.ageMonths >= 15 ? 'Apta por edad' : 'En desarrollo';
  const indexValue = Number.isFinite(metrics.index) ? `${metrics.index}/100` : 'Índice no disponible';
  const indexDetail = metrics.hasEnoughIndexData ? metrics.ranking : 'Registre eventos reproductivos para calcular clasificación.';
  const compactIndexValue = Number.isFinite(metrics.index) ? `${metrics.index}/100` : 'Pendiente evaluación';
  const rankingExplanation = 'Índice calculado mediante desempeño reproductivo, información sanitaria, genética registrada, eficiencia productiva y descendencia comprobada.';
  const maleDescendanceCards = [
    { label: 'Crías registradas', value: '0', detail: 'No hay descendencia registrada.' },
    { label: 'Peso promedio al destete', value: '--', detail: 'Pendiente conexión genética.' },
    { label: 'Hembras retenidas', value: '--', detail: 'Preparado para genética y marketplace.' },
    { label: 'Índice de descendencia', value: 'No disponible', detail: 'Requiere crías registradas.' },
  ];
  const gdpText = isMale
    ? 'Evaluar crecimiento, sanidad y desarrollo antes de clasificar como reproductor.'
    : 'Evaluar sanidad, peso, edad y estado reproductivo antes de servicio o protocolo.';

  const downloadReproductiveReport = async () => {
    setGeneratingPdf(true);
    setStatus('');
    setError('');
    try {
      const animalName = animalLabel(animal, `Animal ${id}`);
      const qrCode = animalQrLabel(animal);
      const maturityLabel = maturityText(maturity, context);
      const maturityToneForReport = maturity >= 76 ? 'success' : maturity >= 41 ? 'warning' : 'danger';
      const hasRealEvents = realEvents.length > 0;
      const indicatorItems = !hasRealEvents
        ? [
            { label: 'Estado reproductivo registrado', value: 'No registrado' },
            { label: 'Eventos reproductivos', value: 'No se registran eventos reproductivos para este animal.' },
            { label: 'Información no registrada', value: 'Sin diagnósticos, servicios, preñez, embriones ni evidencias reales.' },
          ]
        : isMale
          ? [
            { label: 'Servicios/montas', value: String(metrics.servicios) },
            { label: 'Método reproductivo', value: realEvents[0]?.metodo_reproductivo || 'No registrado' },
            { label: 'Evaluación andrológica', value: metrics.evaluacionesSeminales ? 'Registrada' : 'No registrada' },
            { label: 'Calidad seminal', value: metrics.evaluacionesSeminales ? 'En seguimiento' : 'Sin datos' },
            { label: 'Potencial reproductivo', value: Number.isFinite(metrics.index) ? metrics.ranking : 'En evaluación' },
            { label: 'Aptitud reproductiva', value: decision.state, tone: statusTone(decision.state) },
          ]
          : [
            { label: 'Servicios', value: String(metrics.servicios) },
            { label: 'Preñeces', value: String(metrics.preneces) },
            { label: 'Partos', value: String(metrics.partos) },
            { label: 'Abortos', value: String(metrics.abortos), tone: metrics.abortos > 0 ? 'danger' : 'info' },
            { label: 'Días abiertos', value: Number.isFinite(metrics.diasAbiertos) ? `${metrics.diasAbiertos} días` : '--' },
            { label: 'Intervalo entre partos', value: Number.isFinite(metrics.intervaloPartos) ? `${metrics.intervaloPartos} días` : '--' },
          ];
      const report = {
        generatedAt: new Date().toLocaleString('es-CO', { dateStyle: 'medium', timeStyle: 'short' }),
        animal: {
          nombre: animalName,
          qr: qrCode,
          raza,
          sexo: context.sex,
          edad: ageText,
          categoria: context.category,
        },
        estado: {
          estado: hasRealEvents ? context.reproductiveStatus : 'No registrado',
          edadReproductiva,
          madurez: `${maturity}% - ${maturityLabel}`,
          madurezTone: maturityToneForReport,
          decision: hasRealEvents ? decision.state : 'Sin decisión reproductiva registrada',
          proximoPaso: hasRealEvents ? decision.next : 'Registrar eventos reproductivos reales',
          rol: context.reproductiveRole,
          tone: statusTone(context.reproductiveStatus),
        },
        indicadores: indicatorItems,
        eventos: realEvents.map((event) => ({
          fecha: formatDate(event.fecha),
          tipo: event.tipo_evento || '--',
          metodo: event.metodo_reproductivo || '--',
          resultado: event.resultado || '--',
          responsable: event.responsable || '--',
          costo: formatMoney(parseMoney(event.costo)),
          observaciones: event.observaciones || '--',
          tone: statusTone(event.resultado || event.tipo_evento),
        })),
        evidencias: [],
        analisis: [
          { label: 'Datos reales del animal', value: `${ageText} - ${context.category}` },
          { label: 'Estado reproductivo registrado', value: hasRealEvents ? context.reproductiveStatus : 'No registrado' },
          { label: 'Información no registrada', value: hasRealEvents ? `${realEvents.length} eventos registrados.` : 'No se registran eventos reproductivos para este animal.' },
        ],
        descendencia: [],
        ranking: {
          indice: indexValue,
          clasificacion: metrics.hasEnoughIndexData ? metrics.ranking : 'Sin clasificación',
          tendencia: metrics.hasEnoughIndexData ? (metrics.index >= 90 ? 'Mejorando' : metrics.index >= 70 ? 'Estable' : 'Empeorando') : 'Sin datos',
          explicacion: hasRealEvents ? 'Cálculo basado únicamente en eventos reproductivos reales registrados.' : 'Sin eventos reproductivos reales para calcular ranking.',
        },
      };
      const blob = await createReproductiveReportPdfBlob(report);
      downloadBlob(blob, reproductiveReportFileName(animalName, qrCode));
      setStatus('Reporte reproductivo descargado en PDF.');
    } catch (err) {
      setError(err.message || 'No se pudo generar el reporte reproductivo.');
    } finally {
      setGeneratingPdf(false);
    }
  };

  return (
    <div className="gan-stack gan-repro">
      <div className="gan-section-heading repro-intro">
        <p>Gestión reproductiva inteligente y trazabilidad genética.</p>
      </div>

      <section className="gan-panel repro-summary-panel">
        <div className="gan-section-heading">
          <span className="gan-eyebrow">Resumen reproductivo del animal</span>
          <h3>{animalLabel(animal, `Animal ${id}`)}</h3>
        </div>
        <div className="repro-executive-grid">
          <SummaryCard label="QR" value={animalQrLabel(animal)} detail="Identificación" />
          <SummaryCard label="Raza" value={raza} detail="Composición registrada" />
          <SummaryCard label="Sexo" value={context.sex} detail="Contexto reproductivo" />
          <SummaryCard label="Edad" value={ageText} detail="Edad actual" />
          <SummaryCard label="Categoría" value={context.category} detail={context.reproductiveRole} />
          <SummaryCard label="Estado reproductivo" value={context.reproductiveStatus.toUpperCase()} detail={context.reproductiveRole} tone={statusTone(context.reproductiveStatus)} />
          <SummaryCard label="Edad reproductiva" value={edadReproductiva} detail={maturityText(maturity, context)} tone={statusTone(edadReproductiva)} />
          <SummaryCard label={isMale ? 'Servicios / Montas' : 'Servicios'} value={metrics.servicios} detail={isMale ? 'Monta natural, colecta seminal o servicio registrado.' : 'Servicios acumulados'} />
          <SummaryCard label="Índice AGX" value={compactIndexValue} detail="Registre eventos reproductivos para calcular clasificación." className="repro-index-card" />
        </div>
      </section>

      <section className="gan-kpi-grid repro-dashboard-grid">
        <KpiCard icon={HeartPulse} label="Estado" value={context.reproductiveStatus.toUpperCase()} detail={context.reproductiveRole} tone={statusTone(context.reproductiveStatus)} />
        <KpiCard icon={CalendarDays} label="Edad reproductiva" value={ageText} detail={edadReproductiva} tone={statusTone(edadReproductiva)} />
        <KpiCard icon={Dna} label="Potencial" value={Number.isFinite(metrics.index) ? metrics.ranking : 'En evaluación'} detail={metrics.hasEnoughIndexData ? 'Clasificación AGX' : 'Sin datos suficientes'} />
        <KpiCard icon={DollarSign} label="Inversión" value={formatMoney(metrics.costo)} detail={metrics.costo ? 'Costo reproductivo' : 'Sin eventos registrados'} />
        <KpiCard icon={TrendingUp} label="Aptitud" value={decision.state} detail={decision.next} tone={statusTone(decision.state)} />
        {isFemale && realEvents.length ? <KpiCard icon={ShieldCheck} label="Aptitud TE" value={embryoIndicator(embryoProbability)} detail="Transferencia embrionaria registrada" tone={embryoTone} /> : null}
      </section>

      <section className={`gan-panel repro-maturity-panel ${statusClass(maturityText(maturity, context))}`}>
        <div className="gan-section-heading">
          <span className="gan-eyebrow">Madurez reproductiva</span>
          <h3>{maturity}%</h3>
          <p>{maturityText(maturity, context)}</p>
        </div>
        <div className="repro-progress">
          <span className={`is-${maturityTone}`} style={{ width: `${maturity}%` }} />
        </div>
      </section>

      <DecisionCard decision={decision} />

      {isMale ? (
        <section className="gan-panel repro-descendance-panel">
          <div className="gan-section-heading">
            <span className="gan-eyebrow">Descendencia generada</span>
            <h3>Proyección genética y productiva</h3>
            <p>No hay descendencia registrada.</p>
          </div>
          <div className="gan-summary-grid repro-metric-grid">
            {maleDescendanceCards.map((card) => (
              <SummaryCard key={card.label} label={card.label} value={card.value} detail={card.detail} />
            ))}
          </div>
        </section>
      ) : null}

      <section className={`gan-panel repro-analysis-panel ${statusClass(decision.state)}`}>
        <div className="gan-section-heading">
          <span className="gan-eyebrow">Análisis reproductivo AgroGenomaX</span>
          <h3>{sentenceCase(decision.state)}</h3>
          <p>Evaluación integrada según sexo, edad, categoría productiva, sanidad y eventos registrados.</p>
        </div>
        <div className="repro-check-grid">
          {context.recommendations.map((item) => <span key={item}>✓ {item}</span>)}
        </div>
      </section>

      {isFemale && realEvents.length ? (
        <section className="gan-panel repro-embryo-panel">
          <div className="gan-section-heading">
            <span className="gan-eyebrow">Gestión de embriones</span>
            <h3>Transferencia embrionaria premium</h3>
          </div>
          <div className="gan-form">
            <FormField label="Código embrión"><input value={embryoForm.codigo_embrion} onChange={(event) => setEmbryoForm((current) => ({ ...current, codigo_embrion: event.target.value }))} /></FormField>
            <FormField label="Donadora"><input value={embryoForm.donadora} onChange={(event) => setEmbryoForm((current) => ({ ...current, donadora: event.target.value }))} /></FormField>
            <FormField label="Padre"><input value={embryoForm.padre} onChange={(event) => setEmbryoForm((current) => ({ ...current, padre: event.target.value }))} /></FormField>
            <FormField label="Raza"><input value={embryoForm.raza_embrion} onChange={(event) => setEmbryoForm((current) => ({ ...current, raza_embrion: event.target.value }))} /></FormField>
            <FormField label="Fecha transferencia"><input type="date" value={embryoForm.fecha_transferencia} onChange={(event) => setEmbryoForm((current) => ({ ...current, fecha_transferencia: event.target.value }))} /></FormField>
            <FormField label="Responsable"><input value={embryoForm.responsable} onChange={(event) => setEmbryoForm((current) => ({ ...current, responsable: event.target.value }))} /></FormField>
            <FormField label="Calidad embrionaria"><select value={embryoForm.calidad} onChange={(event) => setEmbryoForm((current) => ({ ...current, calidad: event.target.value }))}><option>1</option><option>2</option><option>3</option></select></FormField>
            <FormField label="Estado sincronización"><input value={embryoForm.sincronizacion} onChange={(event) => setEmbryoForm((current) => ({ ...current, sincronizacion: event.target.value }))} /></FormField>
            <FormField label="Receptora"><input value={embryoForm.receptora} onChange={(event) => setEmbryoForm((current) => ({ ...current, receptora: event.target.value }))} /></FormField>
            <FormField label="Cuerpo lúteo"><input value={embryoForm.cl} onChange={(event) => setEmbryoForm((current) => ({ ...current, cl: event.target.value }))} /></FormField>
            <FormField label="Diagnóstico gestación"><input value={embryoForm.diagnostico_gestacion} onChange={(event) => setEmbryoForm((current) => ({ ...current, diagnostico_gestacion: event.target.value }))} /></FormField>
            <FormField label="Resultado"><select value={embryoForm.resultado} onChange={(event) => setEmbryoForm((current) => ({ ...current, resultado: event.target.value }))}>{embryoResults.map((result) => <option key={result}>{result}</option>)}</select></FormField>
          </div>
          <div className="gan-summary-grid repro-metric-grid">
            <SummaryCard label="Probabilidad éxito" value={percent(embryoProbability)} tone={embryoTone} />
            <SummaryCard label="Indicador" value={embryoIndicator(embryoProbability)} tone={embryoTone} />
          </div>
        </section>
      ) : null}

      <section className="gan-panel">
        <div className="gan-section-heading">
          <span className="gan-eyebrow">Motor de eventos reproductivos</span>
          <h3>Registrar evento reproductivo</h3>
        </div>
        <p className="gan-empty-text">Se guarda trazabilidad reproductiva básica soportada por PostgreSQL/API. Campos avanzados quedan pendientes de soporte.</p>
        <form className="gan-form" onSubmit={submitEvent}>
          <FormField label="Tipo evento">
            <select value={eventForm.tipo_evento} onChange={(event) => setEventForm((current) => ({ ...current, tipo_evento: event.target.value }))}>
              {context.allowedEvents.map((type) => <option key={type}>{type}</option>)}
            </select>
          </FormField>
          <FormField label="Método reproductivo">
            <select value={eventForm.metodo_reproductivo} onChange={(event) => setEventForm((current) => ({ ...current, metodo_reproductivo: event.target.value }))}>
              {allowedMethods.map((method) => <option key={method}>{method}</option>)}
            </select>
          </FormField>
          <FormField label="Fecha"><input type="date" value={eventForm.fecha} onChange={(event) => setEventForm((current) => ({ ...current, fecha: event.target.value }))} /></FormField>
          <FormField label="Resultado"><input value={eventForm.resultado} onChange={(event) => setEventForm((current) => ({ ...current, resultado: event.target.value }))} placeholder="Resultado del evento" /></FormField>
          <FormField label="Responsable"><input value={eventForm.responsable} disabled placeholder="Campo pendiente de soporte PostgreSQL/API." onChange={(event) => setEventForm((current) => ({ ...current, responsable: event.target.value }))} /></FormField>
          <FormField label="Costo reproductivo"><input inputMode="numeric" value={eventForm.costo} disabled placeholder="Campo pendiente de soporte PostgreSQL/API." onChange={(event) => setEventForm((current) => ({ ...current, costo: event.target.value }))} /></FormField>
          {eventForm.tipo_evento === 'Prueba andrológica' ? (
            <>
              <FormField label="Circunferencia escrotal"><input value={eventForm.circunferencia_escrotal} disabled placeholder="Campo pendiente de soporte PostgreSQL/API." onChange={(event) => setEventForm((current) => ({ ...current, circunferencia_escrotal: event.target.value }))} /></FormField>
              <FormField label="Motilidad"><input value={eventForm.motilidad} disabled placeholder="Campo pendiente de soporte PostgreSQL/API." onChange={(event) => setEventForm((current) => ({ ...current, motilidad: event.target.value }))} /></FormField>
              <FormField label="Concentración"><input value={eventForm.concentracion} disabled placeholder="Campo pendiente de soporte PostgreSQL/API." onChange={(event) => setEventForm((current) => ({ ...current, concentracion: event.target.value }))} /></FormField>
              <FormField label="Morfología"><input value={eventForm.morfologia} disabled placeholder="Campo pendiente de soporte PostgreSQL/API." onChange={(event) => setEventForm((current) => ({ ...current, morfologia: event.target.value }))} /></FormField>
            </>
          ) : null}
          {eventForm.tipo_evento === 'Diagnóstico gestación' ? (
            <>
              <FormField label="Método"><input value={eventForm.metodo_gestacion} disabled placeholder="Campo pendiente de soporte PostgreSQL/API." onChange={(event) => setEventForm((current) => ({ ...current, metodo_gestacion: event.target.value }))} /></FormField>
              <FormField label="Días de gestación"><input inputMode="numeric" value={eventForm.dias_gestacion} disabled placeholder="Campo pendiente de soporte PostgreSQL/API." onChange={(event) => setEventForm((current) => ({ ...current, dias_gestacion: event.target.value }))} /></FormField>
              <FormField label="Veterinario responsable"><input value={eventForm.veterinario_responsable} disabled placeholder="Campo pendiente de soporte PostgreSQL/API." onChange={(event) => setEventForm((current) => ({ ...current, veterinario_responsable: event.target.value }))} /></FormField>
            </>
          ) : null}
          <FormField label="Observaciones"><textarea value={eventForm.observaciones} onChange={(event) => setEventForm((current) => ({ ...current, observaciones: event.target.value }))} /></FormField>
          <button className="gan-submit" type="submit"><Save className="h-5 w-5" /> Guardar evento reproductivo</button>
        </form>
        <StatusMessage type="success">{status}</StatusMessage>
        <StatusMessage type="error">{error}</StatusMessage>
      </section>

      <section className="gan-panel">
        <div className="gan-section-heading">
          <span className="gan-eyebrow">Dashboard financiero</span>
          <h3>Impacto económico reproductivo</h3>
        </div>
        {metrics.costo > 0 ? (
          <div className="gan-summary-grid repro-metric-grid">
            <SummaryCard label="Inversión reproductiva" value={formatMoney(metrics.costo)} />
            <SummaryCard label="Valor genética generada" value={isMale ? 'Valor genético reproductivo' : metrics.preneces ? 'Potencial en evaluación' : '--'} />
            {isFemale && metrics.preneces ? <SummaryCard label="Costo por preñez lograda" value={formatMoney(metrics.costo / metrics.preneces)} /> : null}
            <SummaryCard label="Resultado económico" value="EN EVALUACIÓN" tone="warning" />
          </div>
        ) : (
          <p className="gan-empty-text">No se registran eventos reproductivos para este animal.</p>
        )}
      </section>

      <section className="gan-panel">
        <div className="gan-section-heading">
          <span className="gan-eyebrow">Timeline reproductivo</span>
          <h3>Trazabilidad</h3>
        </div>
        <div className="repro-compact-timeline">
          <div><span className="dot is-done" /> <strong>Nacimiento</strong> <em>{formatDate(getBirthDate(animal))}</em></div>
          <div className="line">↓</div>
          {realEvents.length ? realEvents.slice().sort((a, b) => String(a.fecha).localeCompare(String(b.fecha))).map((event) => (
            <div key={event.evento_id}><span className={`dot ${statusClass(event.resultado || event.tipo_evento)}`} /> <strong>{event.tipo_evento}</strong> <em>{formatDate(event.fecha)}</em></div>
          )) : <div><span className="dot" /> <strong>Sin eventos registrados</strong></div>}
        </div>
      </section>

      <section className="gan-panel">
        <div className="gan-section-heading">
          <span className="gan-eyebrow">Análisis integral AgroGenomaX</span>
          <h3>Cruce productivo × sanitario × reproducción</h3>
        </div>
        <div className="gan-summary-grid repro-metric-grid">
          <SummaryCard label="GDP" value={gdpText} />
          <SummaryCard label="Sanidad" value="Pendiente de endpoint integrado" />
          <SummaryCard label="Vacunación" value={vacunaciones.length ? `${vacunaciones.length} registros disponibles` : 'Sin registros'} />
          <SummaryCard label="Reproducción" value={`${realEvents.length} eventos registrados`} />
        </div>
      </section>

      <section className="gan-panel">
        <div className="gan-section-heading">
          <span className="gan-eyebrow">Archivo reproductivo</span>
          <h3>Subir evidencia</h3>
        </div>
        <p className="gan-empty-text">Evidencias reproductivas pendientes de soporte PostgreSQL/API.</p>
        <div className="repro-evidence-uploader">
          <FormField label="Tipo evidencia">
            <select disabled>
              {evidenceTypes.map((type) => <option key={type}>{type}</option>)}
            </select>
          </FormField>
          <FormField label="Nombre o referencia">
            <input value={evidenceName} disabled onChange={(event) => setEvidenceName(event.target.value)} placeholder="Campo pendiente de soporte PostgreSQL/API." />
          </FormField>
          <button className="gan-secondary-button" type="button" onClick={addEvidence}>
            <FilePlus2 className="h-4 w-4" /> Seleccionar archivo
          </button>
        </div>
        <div className="repro-evidence-preview">
          {evidences.length ? evidences.map((evidence) => (
            <article key={evidence.evidencia_id}>
              <FilePlus2 className="h-4 w-4" />
              <strong>{evidence.nombre}</strong>
              <small>Preview preparado · {formatDate(evidence.fecha)}</small>
            </article>
          )) : <article><FilePlus2 className="h-4 w-4" /><strong>Preview</strong><small>La evidencia seleccionada aparecerá aquí.</small></article>}
        </div>
      </section>

      <section className="gan-panel">
        <div className="gan-section-heading">
          <span className="gan-eyebrow">Índice reproductivo</span>
          <h3>Ranking AGX</h3>
          <button className={`gan-secondary-button gan-pdf-button ${generatingPdf ? 'is-loading' : ''}`} disabled={generatingPdf} type="button" onClick={downloadReproductiveReport}>
            <Download className="h-5 w-5" />
            {generatingPdf ? 'Generando reporte...' : 'Descargar reporte reproductivo'}
          </button>
        </div>
        <div className="gan-summary-grid repro-metric-grid">
          <SummaryCard label="Índice" value={indexValue} detail={metrics.hasEnoughIndexData ? 'Estado: calculado' : 'Estado: no disponible'} />
          <SummaryCard label="Clasificación" value={metrics.hasEnoughIndexData ? metrics.ranking : 'Sin clasificación'} detail={metrics.hasEnoughIndexData ? 'AGX reproductivo' : 'Registre eventos'} />
          <SummaryCard label="Tendencia" value={metrics.hasEnoughIndexData ? (metrics.index >= 90 ? 'Mejorando' : metrics.index >= 70 ? 'Estable' : 'Empeorando') : 'Sin datos'} />
          <SummaryCard label={metrics.hasEnoughIndexData ? 'Base de cálculo' : 'Estado'} value={metrics.hasEnoughIndexData ? rankingExplanation : 'Registre eventos reproductivos'} detail={metrics.hasEnoughIndexData ? 'Modelo AGX reproductivo.' : rankingExplanation} />
        </div>
      </section>
    </div>
  );
}
