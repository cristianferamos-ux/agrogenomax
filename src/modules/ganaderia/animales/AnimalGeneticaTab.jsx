import { Baby, Boxes, Download, Dna, GitBranch, Scale, ShieldCheck, Sparkles, TreePine } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ganaderiaApi } from '../api/ganaderiaApi.js';
import { StatusMessage } from '../components/FormField.jsx';
import { createGeneticReportPdfBlob, geneticReportFileName } from './geneticReportPdf.js';

function valueOf(row, fields, fallback = '--') {
  return fields.map((field) => row?.[field]).find((value) => value !== undefined && value !== null && value !== '') ?? fallback;
}

function animalName(animal, fallback) {
  return valueOf(animal, ['nombre', 'name', 'codigo_interno', 'codigo'], fallback);
}

function animalQr(animal) {
  return valueOf(animal, ['codigo_qr', 'qr', 'codigo', 'codigo_interno'], '--');
}

function normalizeSex(value) {
  const sex = String(value || '').toLowerCase();
  if (['macho', 'm', 'male'].includes(sex)) return 'Macho';
  if (['hembra', 'h', 'female'].includes(sex)) return 'Hembra';
  return '--';
}

function ageMonths(animal) {
  const direct = Number(valueOf(animal, ['edad_meses', 'edadMeses'], NaN));
  if (Number.isFinite(direct)) return Math.max(0, Math.round(direct));
  const birth = valueOf(animal, ['fecha_nacimiento', 'fechaNacimiento', 'nacimiento', 'fecha_nac'], '');
  if (!birth) return null;
  const birthDate = new Date(birth);
  if (Number.isNaN(birthDate.getTime())) return null;
  return Math.max(0, Math.floor((Date.now() - birthDate.getTime()) / (1000 * 60 * 60 * 24 * 30.44)));
}

function formatMoney(value) {
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(Number(value || 0));
}

function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

function geneticCategory(sex, months) {
  if (!Number.isFinite(months)) return 'Categoría genética no determinada';
  if (months < 8) return sex === 'Hembra' ? 'Ternera lactante' : sex === 'Macho' ? 'Ternero lactante' : 'Cría lactante';
  if (months < 24) return sex === 'Hembra' ? 'Novilla de levante' : sex === 'Macho' ? 'Novillo de levante' : 'Levante';
  if (sex === 'Hembra') return 'Vientre / donadora potencial';
  if (sex === 'Macho') return 'Reproductor / ceba genética';
  return 'Adulto productivo';
}

function inferDecision(sex, merit, age) {
  if (!Number.isFinite(age) || age < 12) return { state: 'Conservar', action: 'Evaluar desarrollo genético', tone: 'warning' };
  if (merit >= 90 && sex === 'Macho') return { state: 'Usar como reproductor', action: 'Validar fertilidad y descendencia', tone: 'success' };
  if (merit >= 90 && sex === 'Hembra') return { state: 'Donadora', action: 'Validar sanidad y mérito materno', tone: 'success' };
  if (merit >= 75) return { state: 'Conservar', action: 'Mantener seguimiento productivo y sanitario', tone: 'success' };
  if (merit >= 55) return { state: 'Vender', action: 'Evaluar precio comercial y objetivo del hato', tone: 'warning' };
  return { state: 'Descarte', action: 'Revisar permanencia productiva', tone: 'danger' };
}

function toneClass(tone) {
  if (tone === 'success') return 'is-success';
  if (tone === 'warning') return 'is-warning';
  if (tone === 'danger') return 'is-danger';
  return 'is-info';
}

function GeneticCard({ icon: Icon, label, value, detail, tone = 'info' }) {
  return (
    <article className={`metric-card gan-summary-card repro-data-card agx-genetic-card ${toneClass(tone)}`}>
      {Icon ? <Icon className="metric-icon" aria-hidden="true" /> : null}
      <span className="metric-label">{label}</span>
      <strong className="metric-value">{value}</strong>
      {detail ? <small className="metric-description">{detail}</small> : null}
    </article>
  );
}

export default function AnimalGeneticaTab() {
  const { id } = useParams();
  const [animal, setAnimal] = useState(null);
  const [razas, setRazas] = useState([]);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [generatingPdf, setGeneratingPdf] = useState(false);

  useEffect(() => {
    let mounted = true;
    Promise.allSettled([ganaderiaApi.getAnimal(id), ganaderiaApi.getAnimalRazas(id)]).then(([animalResult, razasResult]) => {
      if (!mounted) return;
      if (animalResult.status === 'fulfilled') setAnimal(animalResult.value);
      else setError(animalResult.reason?.message || 'No se pudo cargar el animal.');
      if (razasResult.status === 'fulfilled') setRazas(razasResult.value || []);
    });
    return () => { mounted = false; };
  }, [id]);

  const metrics = useMemo(() => {
    const sex = normalizeSex(valueOf(animal, ['sexo', 'sex'], ''));
    const age = ageMonths(animal);
    const breedCount = razas.length;
    const purity = razas.reduce((max, row) => Math.max(max, Number(row.porcentaje || 0)), 0);
    const merit = Math.min(100, Math.round(52 + (purity * 0.28) + Math.min(breedCount, 3) * 5 + (Number.isFinite(age) && age >= 12 ? 8 : 0)));
    const decision = inferDecision(sex, merit, age);
    return {
      sex,
      age,
      ageText: Number.isFinite(age) ? `${age} meses` : '--',
      category: geneticCategory(sex, age),
      purity,
      breedCount,
      merit,
      decision,
      value: merit >= 90 ? 18000000 : merit >= 75 ? 12000000 : merit >= 55 ? 7500000 : 4200000,
    };
  }, [animal, razas]);

  const breedCards = razas.length
    ? razas.map((row) => ({
        label: row.nombre_raza || `Raza ${row.raza_id || ''}`,
        value: `${Number(row.porcentaje || 0).toLocaleString('es-CO')}%`,
        detail: 'Composición racial registrada',
      }))
    : [{ label: 'Composición racial', value: 'Sin registro', detail: 'Registre razas para calcular mérito genético.' }];

  const genealogy = [
    { label: 'Padre', value: valueOf(animal, ['padre', 'nombre_padre'], '--'), detail: 'Línea paterna' },
    { label: 'Madre', value: valueOf(animal, ['madre', 'nombre_madre'], '--'), detail: 'Línea materna' },
    { label: 'Abuelo materno', value: valueOf(animal, ['abuelo_materno'], '--'), detail: 'Referencia genética' },
    { label: 'Línea genética', value: valueOf(animal, ['linea_genetica'], 'Línea por documentar'), detail: 'Preparado para genealogía avanzada' },
  ];

  const inventory = [
    { label: 'Pajillas disponibles', value: metrics.sex === 'Macho' ? '0' : 'No aplica', detail: 'Inventario seminal' },
    { label: 'Embriones disponibles', value: metrics.sex === 'Hembra' ? '0' : 'No aplica', detail: 'Inventario embrionario' },
    { label: 'Certificados genéticos', value: 'Pendiente', detail: 'Estructura lista para adjuntos' },
  ];

  const offspring = [
    { label: 'Crías registradas', value: '0', detail: 'Pendiente conexión genética.' },
    { label: 'Peso promedio descendencia', value: '--', detail: 'Requiere registros productivos.' },
    { label: 'Hembras retenidas', value: '--', detail: 'Indicador para selección.' },
    { label: 'Índice descendencia', value: 'No disponible', detail: 'Sin crías registradas.' },
  ];

  const downloadReport = async () => {
    setGeneratingPdf(true);
    setStatus('');
    setError('');
    try {
      const name = animalName(animal, `Animal ${id}`);
      const qr = animalQr(animal);
      const report = {
        generatedAt: new Date().toLocaleString('es-CO', { dateStyle: 'medium', timeStyle: 'short' }),
        animal: [
          { label: 'Nombre', value: name },
          { label: 'QR', value: qr },
          { label: 'Raza base', value: razas.map((row) => row.nombre_raza).filter(Boolean).join(' / ') || '--' },
          { label: 'Sexo', value: metrics.sex },
          { label: 'Edad', value: metrics.ageText },
          { label: 'Categoría genética', value: metrics.category },
        ],
        razas: breedCards.map((card) => ({ label: card.label, value: `${card.value} - ${card.detail}` })),
        genealogia: genealogy,
        merito: [
          { label: 'Mérito genético AGX', value: `${metrics.merit}/100`, color: metrics.merit >= 75 ? [0.28, 0.62, 0] : [0.9, 0.68, 0] },
          { label: 'Valor genético estimado', value: formatMoney(metrics.value) },
          { label: 'Decisión AGX', value: metrics.decision.state },
        ],
        inventario: inventory,
        arbol: [
          `Padre: ${genealogy[0].value}`,
          `Madre: ${genealogy[1].value}`,
          `Abuelo materno: ${genealogy[2].value}`,
          `Línea genética: ${genealogy[3].value}`,
        ],
        descendencia: offspring,
        decision: [metrics.decision.state, metrics.decision.action, 'Reporte generado con datos registrados en AgroGenomaX. Validar genealogía y certificados antes de decisiones comerciales.'],
      };
      const blob = await createGeneticReportPdfBlob(report);
      downloadBlob(blob, geneticReportFileName(name, qr));
      setStatus('Reporte genético descargado en PDF.');
    } catch (err) {
      setError(err.message || 'No se pudo generar el reporte genético.');
    } finally {
      setGeneratingPdf(false);
    }
  };

  if (!animal && !error) return <div className="gan-panel">Cargando módulo de genética...</div>;

  return (
    <div className="gan-stack gan-repro agx-genetics">
      <div className="gan-section-heading repro-intro">
        <p>Identidad genética, genealogía, mérito AGX, embriones, pajillas, descendencia y valor comercial del animal.</p>
      </div>

      <section className="gan-panel repro-summary-panel">
        <div className="gan-section-heading gan-pdf-heading">
          <div>
            <span className="gan-eyebrow">Resumen genético del animal</span>
            <h3>{animalName(animal, `Animal ${id}`)}</h3>
          </div>
          <button className={`gan-secondary-button gan-pdf-button ${generatingPdf ? 'is-loading' : ''}`} type="button" disabled={generatingPdf} onClick={downloadReport}>
            <Download className="h-5 w-5" />
            {generatingPdf ? 'Generando reporte...' : 'Descargar reporte genético'}
          </button>
        </div>
        <div className="repro-executive-grid">
          <GeneticCard label="QR" value={animalQr(animal)} detail="Identificación genética" />
          <GeneticCard label="Sexo" value={metrics.sex} detail="Contexto de selección" />
          <GeneticCard label="Edad" value={metrics.ageText} detail="Edad actual" />
          <GeneticCard label="Categoría" value={metrics.category} detail="Clasificación genética productiva" />
          <GeneticCard label="Mérito genético AGX" value={`${metrics.merit}/100`} detail="Índice estimado interno" tone={metrics.merit >= 75 ? 'success' : 'warning'} />
          <GeneticCard label="Valor genético estimado" value={formatMoney(metrics.value)} detail="Referencia comercial no contractual" />
        </div>
      </section>

      <section className="gan-panel">
        <div className="gan-section-heading">
          <span className="gan-eyebrow">Composición racial</span>
          <h3>Cards de composición racial</h3>
        </div>
        <div className="gan-summary-grid repro-metric-grid">
          {breedCards.map((card) => <GeneticCard key={card.label} label={card.label} value={card.value} detail={card.detail} icon={Dna} />)}
        </div>
      </section>

      <section className="gan-panel">
        <div className="gan-section-heading">
          <span className="gan-eyebrow">Genealogía</span>
          <h3>Padre, madre y línea genética</h3>
        </div>
        <div className="gan-summary-grid repro-metric-grid">
          {genealogy.map((card) => <GeneticCard key={card.label} label={card.label} value={card.value} detail={card.detail} icon={GitBranch} />)}
        </div>
      </section>

      <section className="gan-panel agx-genetic-tree">
        <div className="gan-section-heading">
          <span className="gan-eyebrow">Árbol genealógico visual</span>
          <h3>Línea genética</h3>
        </div>
        <div className="agx-tree-map">
          <article><TreePine /><strong>{genealogy[0].value}</strong><span>Padre</span></article>
          <article><Baby /><strong>{animalName(animal, `Animal ${id}`)}</strong><span>Animal</span></article>
          <article><TreePine /><strong>{genealogy[1].value}</strong><span>Madre</span></article>
          <article><GitBranch /><strong>{genealogy[2].value}</strong><span>Abuelo materno</span></article>
        </div>
      </section>

      <section className="gan-panel">
        <div className="gan-section-heading">
          <span className="gan-eyebrow">Inventario reproductivo</span>
          <h3>Pajillas y embriones</h3>
        </div>
        <div className="gan-summary-grid repro-metric-grid">
          {inventory.map((card) => <GeneticCard key={card.label} label={card.label} value={card.value} detail={card.detail} icon={Boxes} />)}
        </div>
      </section>

      <section className="gan-panel">
        <div className="gan-section-heading">
          <span className="gan-eyebrow">Descendencia registrada</span>
          <h3>Proyección de legado genético</h3>
        </div>
        <div className="gan-summary-grid repro-metric-grid">
          {offspring.map((card) => <GeneticCard key={card.label} label={card.label} value={card.value} detail={card.detail} icon={Baby} />)}
        </div>
      </section>

      <section className={`gan-panel repro-decision-panel ${toneClass(metrics.decision.tone)}`}>
        <div className="gan-section-heading">
          <span className="gan-eyebrow">Decisión AGX</span>
          <h3>{metrics.decision.state}</h3>
          <p>{metrics.decision.action}</p>
        </div>
        <div className="gan-summary-grid repro-metric-grid">
          <GeneticCard icon={ShieldCheck} label="Conservar" value={metrics.decision.state === 'Conservar' ? 'Recomendado' : 'En evaluación'} detail="Selección productiva" />
          <GeneticCard icon={Sparkles} label="Usar como reproductor" value={metrics.decision.state === 'Usar como reproductor' ? 'Recomendado' : 'Según categoría'} detail="Validar fertilidad" />
          <GeneticCard icon={Dna} label="Donadora / receptora" value={metrics.decision.state === 'Donadora' ? 'Recomendado' : 'En evaluación'} detail="Validar sanidad y mérito" />
          <GeneticCard icon={Scale} label="Valor comercial" value={formatMoney(metrics.value)} detail="Estimación interna AGX" />
        </div>
      </section>

      <StatusMessage type="success">{status}</StatusMessage>
      <StatusMessage type="error">{error}</StatusMessage>
    </div>
  );
}
