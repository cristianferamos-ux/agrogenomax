// SPRINT-3D11.2: "Mis animales" -- GET /api/ganaderia/animales. Tarjetas
// con chapeta/nombre, sexo, raza o cruce, categoría, último peso (≈ si fue
// estimado) y predio. Sin ids técnicos. Por defecto solo ACTIVO.
//
// SPRINT-3D11.3 (R1): local-first -- con el dispositivo preparado la lista
// sale de la copia local (abre sin red, al instante) e incluye los animales
// registrados sin señal con su estado de sincronización.
//
// FASE 2B: dos filtros independientes -- Situación (En hato por defecto,
// Salidos, Muertos, Todos -> estadoOperativo) y Estado del registro
// (Activos por defecto, Anulados, Todos -> estado). La copia local aplica
// los mismos filtros (sin estadoOperativo en caché = EN_HATO). Con red se
// muestran los contadores de GET /animales/resumen (una sola consulta).
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import GanaderiaBackLink from '../components/GanaderiaBackLink.jsx';
import { StatusMessage } from '../components/FormField.jsx';
import { getResumenAnimales, listAnimales, listPrediosActivos } from './hatoApi.js';
import { ETIQUETAS_SITUACION, FILTROS_ESTADO_REGISTRO, FILTROS_LISTADO_DEFAULT, FILTROS_SITUACION, situacionDe } from './cierreModel.js';
import { formatEdad, formatIdentidad, formatPeso, formatRaza, formatSexo } from './hatoFormModel.js';
import { useGanaderiaOffline } from '../offline/GanaderiaOfflineProvider.jsx';
import '../styles/ganaderia-offline.css';
import '../styles/ganaderia-hato.css';

const PAGE_SIZE = 50;

/** Ruta de ficha: id del servidor o 'local:<uuid>' para un registro aún no sincronizado. */
export function animalRouteId(animal) {
  return animal.animalId ?? `local:${animal.localUuid}`;
}

function SyncBadge({ animal }) {
  if (!animal.estadoSync || animal.estadoSync === 'SINCRONIZADO') return null;
  const conflicto = animal.estadoSync === 'CONFLICTO' || animal.estadoSync === 'RECHAZADO';
  return (
    <span className={`gan-hato-badge-sync${conflicto ? ' gan-hato-badge-conflicto' : ''}`}>
      {conflicto ? 'Conflicto de sincronización' : 'Pendiente de sincronizar'}
    </span>
  );
}

export default function HatoListaPage() {
  const offline = useGanaderiaOffline();
  const local = offline.preparado && offline.repo ? offline.repo : null;
  const [predios, setPredios] = useState([]);
  const [filtros, setFiltros] = useState({ predioId: '', q: '', ...FILTROS_LISTADO_DEFAULT });
  const [resumen, setResumen] = useState(null);
  const [busqueda, setBusqueda] = useState('');
  const [state, setState] = useState({ status: 'loading', animales: [], total: 0 });
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    let active = true;
    const fuente = local
      ? local.listPredios().then((lista) => ({ ok: true, data: { predios: lista } }))
      : listPrediosActivos();
    fuente
      .then(({ ok, data }) => {
        if (active && ok && Array.isArray(data?.predios)) setPredios(data.predios);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [local]);

  // Contadores del hato: solo del servidor (no se derivan de la página cargada).
  useEffect(() => {
    let active = true;
    if (!offline.online) {
      setResumen(null);
      return undefined;
    }
    getResumenAnimales()
      .then(({ ok, data }) => {
        if (active) setResumen(ok && data?.resumen ? data.resumen : null);
      })
      .catch(() => {
        if (active) setResumen(null);
      });
    return () => {
      active = false;
    };
  }, [offline.online]);

  const load = useCallback(async () => {
    if (local) {
      try {
        const animales = await local.listAnimales(filtros);
        setState({ status: 'ok', animales, total: animales.length, origen: 'local' });
      } catch {
        setState({ status: 'error', animales: [], total: 0 });
      }
      return;
    }
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
  }, [filtros, local]);

  useEffect(() => {
    load();
    // Copia local: se refresca sola cuando la sincronización la actualiza.
    return local ? local.subscribe(load) : undefined;
  }, [load, local]);

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
  const filtrosPorDefecto = filtros.estado === FILTROS_LISTADO_DEFAULT.estado && filtros.estadoOperativo === FILTROS_LISTADO_DEFAULT.estadoOperativo;

  return (
    <div className="gan-panel gan-hato">
      <GanaderiaBackLink />
      <div className="gan-section-heading">
        <span className="gan-eyebrow">Animales</span>
        <h2>Mis animales</h2>
        <Link className="gan-submit gan-hato-cta" to="/ganaderia/animales/nuevo">Registrar animal</Link>
        <Link className="gan-secondary-button gan-hato-cta" to="/ganaderia/escanear-qr">Escanear QR</Link>
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
        <label className="gan-hato-filtro" htmlFor="filtro-situacion">
          <span>Situación</span>
          <select
            id="filtro-situacion"
            value={filtros.estadoOperativo}
            onChange={(event) => setFiltros((current) => ({ ...current, estadoOperativo: event.target.value }))}
          >
            {FILTROS_SITUACION.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
          </select>
        </label>
        <label className="gan-hato-filtro" htmlFor="filtro-estado-registro">
          <span>Estado del registro</span>
          <select
            id="filtro-estado-registro"
            value={filtros.estado}
            onChange={(event) => setFiltros((current) => ({ ...current, estado: event.target.value }))}
          >
            {FILTROS_ESTADO_REGISTRO.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
          </select>
        </label>
        <button type="submit" className="gan-secondary-button">Buscar</button>
      </form>

      {resumen ? (
        <dl className="gan-hato-resumen" aria-label="Resumen del hato">
          <div><dt>En hato</dt><dd>{resumen.hatoActual}</dd></div>
          <div><dt>Salidos</dt><dd>{resumen.salidos}</dd></div>
          <div><dt>Muertos</dt><dd>{resumen.muertos}</dd></div>
        </dl>
      ) : null}

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
            : !filtrosPorDefecto
              ? 'No hay animales con estos filtros.'
              : 'Aún no tienes animales en el hato.'}
        </StatusMessage>
      ) : null}

      {state.status === 'ok' && state.animales.length > 0 ? (
        <>
          <p className="gan-hato-hint">{state.total} {state.total === 1 ? 'animal' : 'animales'}</p>
          <ul className="gan-hato-list">
            {state.animales.map((animal) => (
              <li key={animal.animalId ?? animal.localUuid}>
                <Link className="gan-hato-card" to={`/ganaderia/animales/${animalRouteId(animal)}`}>
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
                    {situacionDe(animal) !== 'EN_HATO' ? (
                      <span className={`gan-hato-badge gan-hato-badge-situacion-${situacionDe(animal).toLowerCase()}`}>{ETIQUETAS_SITUACION[situacionDe(animal)]}</span>
                    ) : null}
                    <SyncBadge animal={animal} />
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
