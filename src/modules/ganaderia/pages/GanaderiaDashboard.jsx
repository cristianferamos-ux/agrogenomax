import {
  Beef,
  ClipboardList,
  Dna,
  FileBarChart,
  HeartPulse,
  MapPin,
  QrCode,
  Scale,
  ShieldPlus,
  Sprout,
  Stethoscope,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ganaderiaApi } from '../api/ganaderiaApi.js';
import GanaderiaSidebar from '../components/GanaderiaSidebar.jsx';
import '../styles/ganaderia-dashboard.css';

const operationCards = [
  {
    label: 'Registro de Predio',
    text: 'Registra la unidad productiva y los datos de su propietario.',
    icon: MapPin,
    to: '/ganaderia/predios',
  },
  {
    label: 'Registro de Potreros',
    text: 'Asocia potreros a un predio registrado.',
    icon: Sprout,
    to: '/ganaderia/potreros',
  },
  {
    label: 'Registro de Animales',
    text: 'Valida un QR antes de registrar animales nuevos.',
    icon: Beef,
    to: '/ganaderia/animales',
  },
  {
    label: 'Escanear QR',
    text: 'Abre cámara o ingresa código manual.',
    icon: QrCode,
    to: '/ganaderia/escanear-qr',
  },
  {
    label: 'Mis animales',
    text: 'Consulta animales registrados y abre su ficha.',
    icon: ClipboardList,
    to: '/ganaderia/animales/listado',
  },
  {
    label: 'Ficha Animal',
    text: 'Abre la trazabilidad completa del animal seleccionado.',
    icon: ShieldPlus,
    to: '/ganaderia/animales/listado?modulo=ficha',
  },
  {
    label: 'Tratamientos',
    text: 'Busca un animal para abrir su historia clínica.',
    icon: Stethoscope,
    to: '/ganaderia/animales/listado?modulo=tratamientos',
  },
];

const flowSteps = ['Predio y propietario', 'Potrero', 'Animal / QR', 'Ficha animal'];

const secondaryModules = [
  { label: 'Ficha', icon: ShieldPlus, to: '/ganaderia/animales/listado?modulo=ficha' },
  { label: 'Pesajes', icon: Scale, to: '/ganaderia/animales/listado?modulo=pesajes' },
  { label: 'Vacunaciones', icon: HeartPulse, to: '/ganaderia/animales/listado?modulo=vacunaciones' },
  { label: 'Tratamientos', icon: Stethoscope, to: '/ganaderia/animales/listado?modulo=tratamientos' },
  { label: 'Reproducción', icon: Sprout, to: '/ganaderia/animales/listado?modulo=reproduccion' },
  { label: 'Genética', icon: Dna, to: '/ganaderia/animales/listado?modulo=genetica' },
  { label: 'Reportes', icon: FileBarChart, to: '/ganaderia/proximamente/reportes' },
];

export default function GanaderiaDashboard() {
  const [summary, setSummary] = useState({ animales: [], predios: [], potreros: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;

    Promise.allSettled([
      ganaderiaApi.listAnimales(),
      ganaderiaApi.listPredios(),
      ganaderiaApi.listPotreros(),
    ])
      .then(([animalesResult, prediosResult, potrerosResult]) => {
        if (!active) return;
        const hasUnavailableIndicator = [animalesResult, prediosResult, potrerosResult].some(
          (result) => result.status === 'rejected',
        );

        if (hasUnavailableIndicator) {
          console.error('Algunos indicadores de Ganadería no están disponibles temporalmente.', {
            animales: animalesResult.status,
            predios: prediosResult.status,
            potreros: potrerosResult.status,
          });
        }

        setSummary({
          animales: animalesResult.status === 'fulfilled' && Array.isArray(animalesResult.value) ? animalesResult.value : [],
          predios: prediosResult.status === 'fulfilled' && Array.isArray(prediosResult.value) ? prediosResult.value : [],
          potreros: potrerosResult.status === 'fulfilled' && Array.isArray(potrerosResult.value) ? potrerosResult.value : [],
        });

        setError(hasUnavailableIndicator ? 'Algunos indicadores no están disponibles temporalmente.' : '');
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, []);

  const indicators = useMemo(() => [
    { label: 'Predios registrados', value: summary.predios.length || 'Sin datos', icon: MapPin },
    { label: 'Potreros registrados', value: summary.potreros.length || 'Sin datos', icon: Sprout },
    { label: 'Animales registrados', value: summary.animales.length || 'Sin datos', icon: Beef },
  ], [summary]);

  return (
    <div className="gan-dash-shell">
      <GanaderiaSidebar />
      <main className="gan-dash-main gan-dash-main-operativo">
        <header className="gan-dash-operativo-hero">
          <div>
            <span className="gan-dash-badge">Flujo operativo</span>
            <h1>AgroGenomaX Ganadería Inteligente</h1>
            <p>Gestiona tu hato con trazabilidad QR, control productivo, sanidad y decisiones inteligentes por animal.</p>
          </div>
          <Link to="/ganaderia/predios" className="gan-dash-btn is-primary">
            Registrar predio y propietario <MapPin size={17} />
          </Link>
        </header>

        <section className="gan-dash-productivity-grid" aria-label="Indicadores reales de la cuenta">
          {indicators.map(({ label, value, icon: Icon }) => (
            <article className="gan-dash-productivity-card" key={label}>
              <div className="gan-dash-quick-icon">
                <Icon size={20} />
              </div>
              <span>{label}</span>
              <strong>{loading ? 'Cargando...' : value}</strong>
              <p>{error || 'Datos reales de tu cuenta.'}</p>
            </article>
          ))}
        </section>

        <section className="gan-dash-operativo-panel">
          <div className="gan-dash-operativo-copy">
            <span className="gan-dash-badge">Operación de campo</span>
            <h2>Operación ganadera por QR desde campo.</h2>
            <p>
              Primero registra el predio con los datos de su propietario y luego los potreros. Después podrás registrar
              animales nuevos o abrir fichas mediante QR con datos reales de tu cuenta.
            </p>
          </div>

          <div className="gan-dash-flow" aria-label="Orden correcto para cliente nuevo">
            {flowSteps.map((step, index) => (
              <div className="gan-dash-flow-step" key={step}>
                <span>{index + 1}</span>
                <strong>{step}</strong>
              </div>
            ))}
          </div>
        </section>

        <section className="gan-dash-section">
          <h2>Tarjetas operativas</h2>
          <div className="gan-dash-quick-grid">
            {operationCards.map(({ label, text, icon: Icon, to }) => (
              <Link key={label} to={to} className="gan-dash-quick-card">
                <span className="gan-dash-quick-icon">
                  <Icon size={20} />
                </span>
                <strong>{label}</strong>
                <p>{text}</p>
              </Link>
            ))}
          </div>
        </section>

        <section className="gan-dash-section">
          <h2>Módulos por animal seleccionado</h2>
          <div className="gan-dash-module-row">
            {secondaryModules.map(({ label, icon: Icon, to }) => (
              <Link key={label} to={to} className="gan-dash-module-link">
                <Icon size={17} />
                <span>{label}</span>
              </Link>
            ))}
          </div>
          <p className="gan-dash-helper">Selecciona un animal para abrir este módulo.</p>
        </section>
      </main>
    </div>
  );
}
