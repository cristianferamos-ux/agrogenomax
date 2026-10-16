// SPRINT-3D11.2: "Mis animales" -- GET /api/ganaderia/animales. Tarjetas
// con chapeta/nombre, sexo, raza o cruce, categoría, último peso (≈ si fue
// estimado) y predio. Sin ids técnicos. Por defecto solo ACTIVO.
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import GanaderiaBackLink from '../components/GanaderiaBackLink.jsx';
import { StatusMessage } from '../components/FormField.jsx';
import { listAnimales, listPrediosActivos } from './hatoApi.js';
import { formatEdad, formatIdentidad, formatPeso, formatRaza, formatSexo } from './hatoFormModel.js';
import '../styles/ganaderia-hato.css';

const PAGE_SIZE = 50;

export default function HatoListaPage() {
  const [predios, setPredios] = useState([]);
  const [filtros, setFiltros] = useState({ predioId: '', q: '', estado: 'ACTIVO' });
  const [busqueda, setBusqueda] = useState('');
  const [state, setState] = useState({ status: 'loading', animales: [], total: 0 });
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    let active = true;
    listPrediosActivos()
      .then(({ ok, data }) => {
        if (active && ok && Array.isArray(data?.predios)) setPredios(data.predios);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  const load = useCallback(async () => {
    setState((current) => ({ ...current, status: 'loading' }));
    try {
      const { ok, data } = await listAnimales({ ...filtros, limit: PAGE_SIZE, offset: 0 });
      if (!ok || !Array.isArray(data?.animales)) {
        setState({ status: 'error', animales: [], total: 0 });
        return;
      }
      setState({ status: 'ok', animales: data.animales, total: data.total ?? data.animales.length });
    } catch {
      setState({ status: 'error', animales: [], total: 0 });
    }
  }, [filtros]);

  useEffect(() => {
    load();
  }, [load]);

  async function cargarMas() {
    if (loadingMore) return;
    setLoadingMore(true);
    try {
      const { ok, data } = await listAnimales({ ...filtros, limit: PAGE_SIZE, offset: state.animales.length });
      if (ok && Array.isArray(data?.animales)) {
        setState((current) => ({ ...current, animales: [...current.animales, ...data.animales], total: data.total }));
      }
    } catch {
      // Se conserva lo ya cargado; el botón sigue disponible.
    } finally {
      setLoadingMore(false);
    }
  }

  function buscar(event) {
    event.preventDefault();
    setFiltros((current) => ({ ...current, q: busqueda.trim() }));
  }

  const hayFiltros = Boolean(filtros.q || filtros.predioId);

  return (
    <div className="gan-panel gan-hato">
      <GanaderiaBackLink />
      <div className="gan-section-heading">
        <span className="gan-eyebrow">Animales</span>
        <h2>Mis animales</h2>
        <Link className="gan-submit gan-hato-cta" to="/ganaderia/animales/nuevo">Registrar animal</Link>
      </div>

      <form className="gan-hato-toolbar" onSubmit={buscar} role="search">
        <input
          type="search"
          value={busqueda}
          maxLength={40}
          placeholder="Buscar por chapeta o nombre"
          aria-label="Buscar por chapeta o nombre"
          onChange={(event) => setBusqueda(event.target.value)}
        />
        <select
          value={filtros.predioId}
          aria-label="Filtrar por predio"
          onChange={(event) => setFiltros((current) => ({ ...current, predioId: event.target.value }))}
        >
          <option value="">Todos los predios</option>
          {predios.map((predio) => (
            <option key={predio.predioId} value={predio.predioId}>{predio.nombrePredio}</option>
          ))}
        </select>
        <button type="submit" className="gan-secondary-button">Buscar</button>
        <button
          type="button"
          className="gan-back-inline"
          onClick={() => setFiltros((current) => ({ ...current, estado: current.estado === 'ACTIVO' ? 'ANULADO' : 'ACTIVO' }))}
        >
          {filtros.estado === 'ACTIVO' ? 'Ver anulados' : 'Ver activos'}
        </button>
      </form>

      {state.status === 'loading' ? <StatusMessage>Cargando animales...</StatusMessage> : null}
      {state.status === 'error' ? (
        <div className="gan-hato-actions">
          <StatusMessage type="error">No fue posible cargar tus animales. Intenta nuevamente.</StatusMessage>
          <button type="button" className="gan-secondary-button" onClick={load}>Reintentar</button>
        </div>
      ) : null}
      {state.status === 'ok' && state.animales.length === 0 ? (
        <StatusMessage type="info">
          {hayFiltros
            ? 'Ningún animal coincide con la búsqueda.'
            : filtros.estado === 'ANULADO'
              ? 'No hay registros anulados.'
              : 'Aún no tienes animales registrados.'}
        </StatusMessage>
      ) : null}

      {state.status === 'ok' && state.animales.length > 0 ? (
        <>
          <p className="gan-hato-hint">{state.total} {state.total === 1 ? 'animal' : 'animales'}</p>
          <ul className="gan-hato-list">
            {state.animales.map((animal) => (
              <li key={animal.animalId}>
                <Link className="gan-hato-card" to={`/ganaderia/animales/${animal.animalId}`}>
                  <div className="gan-hato-card-head">
                    <strong>{formatIdentidad(animal)}</strong>
                    <span>{formatSexo(animal.sexo)}</span>
                  </div>
                  <div className="gan-hato-card-body">
                    <span>{formatRaza(animal)}</span>
                    {animal.categoriaProductivaNombre ? <span>{animal.categoriaProductivaNombre}</span> : null}
                    <span>{formatEdad(animal)}</span>
                    <span>{formatPeso(animal.ultimoPeso)}</span>
                    <span>{animal.predioNombre}</span>
                    {animal.estado === 'ANULADO' ? <span className="gan-hato-badge">Anulado</span> : null}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
          {state.animales.length < state.total ? (
            <button type="button" className="gan-secondary-button" onClick={cargarMas} disabled={loadingMore}>
              {loadingMore ? 'Cargando...' : 'Ver más'}
            </button>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
