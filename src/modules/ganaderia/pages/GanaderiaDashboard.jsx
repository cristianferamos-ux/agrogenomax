import { Beef, FileBarChart, MapPin, Sprout } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ganaderiaApi } from '../api/ganaderiaApi.js';
import GanaderiaSidebar from '../components/GanaderiaSidebar.jsx';
import '../styles/ganaderia-dashboard.css';

// SPRINT-3D11.SECURITY-LEGACY: sin tarjetas hacia los flujos legacy de
// animales/QR/potreros (backend desmontado). Los potreros se registran
// desde la tarjeta de cada predio.
const operationCards = [
  {
    label: 'Registro de Predio',
    text: 'Registra la unidad productiva y los datos de su propietario.',
    icon: MapPin,
    to: '/ganaderia/predios',
  },
  {
    label: 'Potreros',
    text: 'Registra potreros desde la tarjeta de un predio registrado.',
    icon: Sprout,
    to: '/ganaderia/predios',
  },
  {
    label: 'Mis animales',
    text: 'El módulo de animales está en preparación.',
    icon: Beef,
    to: '/ganaderia/animales',
  },
  {
    label: 'Reportes',
    text: 'Disponible en una fase posterior.',
    icon: FileBarChart,
    to: '/ganaderia/proximamente/reportes',
  },
];

const flowSteps = ['Predio', 'Potrero', 'Animal'];

export default function GanaderiaDashboard() {
  // Predios: fuente tenant-safe (Postgres-AGX-Business). Potreros y Animales
  // aún no tienen fuente tenant-safe en Business DB (pendiente Sprint 3D2) --
  // se muestran como "No disponible" sin consultar sus endpoints legacy.
  const [prediosState, setPrediosState] = useState({ status: 'loading', count: null });

  useEffect(() => {
    let active = true;

    ganaderiaApi
      .listGanaderiaPredios()
      .then((response) => {
        if (!active) return;
        if (!Array.isArray(response?.predios)) {
          console.error('Respuesta con forma inválida para el indicador de Predios registrados.', response);
          setPrediosState({ status: 'error', count: null });
          return;
        }
        setPrediosState({ status: 'ok', count: response.predios.length });
      })
      .catch((error) => {
        if (!active) return;
        console.error('No se pudo obtener el indicador de Predios registrados.', error);
        setPrediosState({ status: 'error', count: null });
      });

    return () => {
      active = false;
    };
  }, []);

  const indicators = useMemo(() => {
    const prediosValue =
      prediosState.status === 'loading'
        ? 'Cargando...'
        : prediosState.status === 'error'
          ? 'No disponible'
          : String(prediosState.count);

    return [
      {
        label: 'Predios registrados',
        value: prediosValue,
        helper: prediosState.status === 'error' ? 'No se pudo consultar este indicador.' : 'Datos reales de tu cuenta.',
        icon: MapPin,
      },
      {
        label: 'Potreros registrados',
        value: 'No disponible',
        helper: 'Fuente tenant-safe en desarrollo.',
        icon: Sprout,
      },
      {
        label: 'Animales registrados',
        value: 'No disponible',
        helper: 'Fuente tenant-safe en desarrollo.',
        icon: Beef,
      },
    ];
  }, [prediosState]);

  return (
    <div className="gan-dash-shell">
      <GanaderiaSidebar />
      <main className="gan-dash-main gan-dash-main-operativo">
        <header className="gan-dash-operativo-hero">
          <div>
            <span className="gan-dash-badge">Flujo operativo</span>
            <h1>AgroGenomaX Ganadería Inteligente</h1>
            <p>Gestiona tus predios y potreros con datos reales de tu cuenta y decisiones inteligentes de pastoreo.</p>
          </div>
          <Link to="/ganaderia/predios" className="gan-dash-btn is-primary">
            Registrar predio <MapPin size={17} />
          </Link>
        </header>

        <section className="gan-dash-productivity-grid" aria-label="Indicadores reales de la cuenta">
          {indicators.map(({ label, value, helper, icon: Icon }) => (
            <article className="gan-dash-productivity-card" key={label}>
              <div className="gan-dash-quick-icon">
                <Icon size={20} />
              </div>
              <span>{label}</span>
              <strong>{value}</strong>
              <p>{helper}</p>
            </article>
          ))}
        </section>

        <section className="gan-dash-operativo-panel">
          <div className="gan-dash-operativo-copy">
            <span className="gan-dash-badge">Operación de campo</span>
            <h2>Operación ganadera desde campo.</h2>
            <p>
              Primero registra el predio y completa su información básica. Luego registra los potreros. El registro
              de animales estará disponible próximamente.
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
      </main>
    </div>
  );
}
