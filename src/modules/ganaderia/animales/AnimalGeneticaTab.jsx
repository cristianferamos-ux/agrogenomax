import { Download, Dna, GitBranch } from 'lucide-react';
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

const ADVANCED_GENETIC_EMPTY = 'Información genética avanzada no registrada.';

function animalInternalCode(animal) {
  return valueOf(animal, ['codigo_interno', 'numero_arete', 'codigo'], '--');
}

function explicitQr(animal) {
  const raw = valueOf(animal, ['codigo_qr', 'qr_codigo', 'qr', 'codigoQr'], '');
  const match = String(raw || '').match(/AGX-\d{1,}/i);
  return match ? match[0].toUpperCase() : '';
}

function qrCandidateFromRelation(animal) {
  const qrId = valueOf(animal, ['qr_id', 'qrCodeId'], '');
  const digits = String(qrId || '').replace(/\D/g, '');
  return digits ? `AGX-${digits.padStart(6, '0')}` : '';
}

async function resolveAnimalQr(animal) {
  const direct = explicitQr(animal);
  if (direct) return direct;

  const candidate = qrCandidateFromRelation(animal);
  if (!candidate) return '--';

  try {
    const result = await ganaderiaApi.lookupQr(candidate);
    const qrAnimalId = String(result?.qr?.animal_id || result?.animal?.animal_id || '');
    if (result?.exists && qrAnimalId === String(animal?.animal_id || '')) return candidate;
  } catch {
    return '--';
  }

  return '--';
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
  const [qrCode, setQrCode] = useState('--');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [generatingPdf, setGeneratingPdf] = useState(false);

  useEffect(() => {
    let mounted = true;
    Promise.allSettled([ganaderiaApi.getAnimal(id), ganaderiaApi.getAnimalRazas(id)]).then(([animalResult, razasResult]) => {
      if (!mounted) return;
      if (animalResult.status === 'fulfilled') {
        setAnimal(animalResult.value);
        resolveAnimalQr(animalResult.value).then((code) => {
          if (mounted) setQrCode(code);
        });
      } else setError(animalResult.reason?.message || 'No se pudo cargar el animal.');
      if (razasResult.status === 'fulfilled') setRazas(razasResult.value || []);
    });
    return () => { mounted = false; };
  }, [id]);

  const metrics = useMemo(() => {
    const sex = normalizeSex(valueOf(animal, ['sexo', 'sex'], ''));
    const age = ageMonths(animal);
    const breedCount = razas.length;
    const purity = razas.reduce((max, row) => Math.max(max, Number(row.porcentaje || 0)), 0);
    return {
      sex,
      age,
      ageText: Number.isFinite(age) ? `${age} meses` : '--',
      category: geneticCategory(sex, age),
      purity,
      breedCount,
    };
  }, [animal, razas]);

  const breedCards = razas.length
    ? razas.map((row) => ({
        label: row.nombre_raza || `Raza ${row.raza_id || ''}`,
        value: `${Number(row.porcentaje || 0).toLocaleString('es-CO')}%`,
        detail: 'Composición racial registrada',
      }))
    : [{ label: 'Composición racial', value: 'Sin registro', detail: 'Sin composición racial registrada en API.' }];

  const genealogy = [
    { label: 'Genealogía', value: ADVANCED_GENETIC_EMPTY, detail: 'Sin padre, madre o línea genética registrada en API.' },
  ];

  const inventory = [
    { label: 'Inventario genético', value: ADVANCED_GENETIC_EMPTY, detail: 'Sin certificados, pajillas ni embriones registrados.' },
  ];

  const offspring = [
    { label: 'Descendencia', value: ADVANCED_GENETIC_EMPTY, detail: 'Sin crías o desempeño de descendencia registrados.' },
  ];

  const downloadReport = async () => {
    setGeneratingPdf(true);
    setStatus('');
    setError('');
    try {
      const name = animalName(animal, `Animal ${id}`);
      const qr = qrCode !== '--' ? qrCode : await resolveAnimalQr(animal);
      const report = {
        generatedAt: new Date().toLocaleString('es-CO', { dateStyle: 'medium', timeStyle: 'short' }),
        animal: [
          { label: 'Nombre', value: name },
          { label: 'QR', value: qr },
          { label: 'Código interno', value: animalInternalCode(animal) },
          { label: 'Raza base', value: razas.map((row) => row.nombre_raza).filter(Boolean).join(' / ') || '--' },
          { label: 'Sexo', value: metrics.sex },
          { label: 'Edad', value: metrics.ageText },
          { label: 'Categoría genética', value: metrics.category },
        ],
        razas: breedCards.map((card) => ({ label: card.label, value: `${card.value} - ${card.detail}` })),
        genealogia: [],
        merito: [],
        inventario: [],
        arbol: [],
        descendencia: [],
        decision: [],
        advancedNotice: ADVANCED_GENETIC_EMPTY,
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
        <p>Identidad genética básica y composición racial registrada en AgroGenomaX.</p>
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
          <GeneticCard label="QR" value={qrCode} detail="Identificación real validada" />
          <GeneticCard label="Código interno" value={animalInternalCode(animal)} detail="Código operativo separado del QR" />
          <GeneticCard label="Raza base" value={razas.map((row) => row.nombre_raza).filter(Boolean).join(' / ') || '--'} detail="Dato registrado" />
          <GeneticCard label="Sexo" value={metrics.sex} detail="Contexto de selección" />
          <GeneticCard label="Edad" value={metrics.ageText} detail="Edad actual" />
          <GeneticCard label="Categoría" value={metrics.category} detail="Clasificación genética productiva" />
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
          <span className="gan-eyebrow">Información genética avanzada</span>
          <h3>Estado del registro</h3>
        </div>
        <div className="gan-summary-grid repro-metric-grid">
          {genealogy.map((card) => <GeneticCard key={card.label} label={card.label} value={card.value} detail={card.detail} icon={GitBranch} />)}
        </div>
      </section>

      <section className="gan-panel">
        <div className="gan-section-heading">
          <span className="gan-eyebrow">Inventario y descendencia</span>
          <h3>Información no registrada</h3>
        </div>
        <div className="gan-summary-grid repro-metric-grid">
          {inventory.map((card) => <GeneticCard key={card.label} label={card.label} value={card.value} detail={card.detail} icon={GitBranch} />)}
          {offspring.map((card) => <GeneticCard key={card.label} label={card.label} value={card.value} detail={card.detail} icon={GitBranch} />)}
        </div>
      </section>

      <StatusMessage type="success">{status}</StatusMessage>
      <StatusMessage type="error">{error}</StatusMessage>
    </div>
  );
}
