import { useEffect, useMemo, useState } from 'react';
import { Beef, CalendarClock, FileBarChart, MapPin, Scale, ShieldPlus, Sprout, Users } from 'lucide-react';
import { Link } from 'react-router-dom';
import GanaderiaSidebar from '../components/GanaderiaSidebar.jsx';
import GanaderiaHeader from '../components/GanaderiaHeader.jsx';
import GanaderiaMetricCard from '../components/GanaderiaMetricCard.jsx';
import GanaderiaQuickAccess from '../components/GanaderiaQuickAccess.jsx';
import GanaderiaAlerts from '../components/GanaderiaAlerts.jsx';
import GanaderiaRecentActivity from '../components/GanaderiaRecentActivity.jsx';
import GanaderiaProductivity from '../components/GanaderiaProductivity.jsx';
import GanaderiaEmptyState from '../components/GanaderiaEmptyState.jsx';
import { ganaderiaApi } from '../api/ganaderiaApi.js';
import '../styles/ganaderia-dashboard.css';

export default function GanaderiaDashboard() {
  const [summary, setSummary] = useState({
    animales: null,
    predios: null,
    potreros: null,
    error: '',
  });

  useEffect(() => {
    let active = true;

    Promise.allSettled([ganaderiaApi.listAnimales(), ganaderiaApi.listPredios(), ganaderiaApi.listPotreros()])
      .then(([animalesResult, prediosResult, potrerosResult]) => {
        if (!active) return;

        setSummary({
          animales: animalesResult.status === 'fulfilled' ? animalesResult.value.length : null,
          predios: prediosResult.status === 'fulfilled' ? prediosResult.value.length : null,
          potreros: potrerosResult.status === 'fulfilled' ? potrerosResult.value.length : null,
          error: [animalesResult, prediosResult, potrerosResult].some((result) => result.status === 'rejected')
            ? 'Algunos indicadores no están disponibles todavía.'
            : '',
        });
      })
      .catch(() => {
        if (!active) return;
        setSummary((current) => ({ ...current, error: 'No fue posible cargar indicadores reales.' }));
      });

    return () => {
      active = false;
    };
  }, []);

  const metricItems = useMemo(
    () => [
      { label: 'Animales registrados', value: summary.animales ?? 'Sin datos', icon: Beef },
      { label: 'Predios registrados', value: summary.predios ?? 'Sin datos', icon: MapPin },
      { label: 'Potreros registrados', value: summary.potreros ?? 'Sin datos', icon: Sprout },
      { label: 'Pesajes', value: 'Por animal', icon: Scale },
      { label: 'Sanidad', value: 'Por animal', icon: ShieldPlus },
      { label: 'Reproducción', value: 'Por animal', icon: CalendarClock },
      { label: 'Reportes', value: 'Por animal', icon: FileBarChart },
      { label: 'Indicadores analíticos', value: 'Sin datos', icon: Users },
    ],
    [summary],
  );

  const hasRegisteredData = [summary.animales, summary.predios, summary.potreros].some((value) => Number(value) > 0);

  return (
    <div className="gan-dash-shell">
      <GanaderiaSidebar />
      <main className="gan-dash-main">
        <Link to="/" className="gan-dash-back">
          ← Volver al Home
        </Link>
        <GanaderiaHeader />

        <section className="gan-dash-section">
          <h2>Resumen del hato</h2>
          <div className="gan-dash-metrics-grid">
            {metricItems.map((item) => (
              <GanaderiaMetricCard key={item.label} icon={item.icon} label={item.label} value={item.value} />
            ))}
          </div>
          {summary.error ? <p>{summary.error}</p> : null}
        </section>

        {!hasRegisteredData ? (
          <section className="gan-dash-section">
            <GanaderiaEmptyState />
          </section>
        ) : null}

        <GanaderiaQuickAccess />

        <div className="gan-dash-columns">
          <GanaderiaAlerts />
          <GanaderiaRecentActivity />
        </div>

        <GanaderiaProductivity />
      </main>
    </div>
  );
}
