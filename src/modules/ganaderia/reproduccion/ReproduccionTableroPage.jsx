// FASE 4C: tablero reproductivo de la ORGANIZACIÓN (/ganaderia/reproduccion).
// No confundir con la pestaña "Reproducción" de la ficha individual (4B).
// Solo lectura para los 4 roles: sin formularios ni acciones; registrar,
// anular y corregir siguen exclusivamente en la ficha (RBAC 4B).
//
// KPIs y listado salen del backend (misma CTE): cada filtro rápido, predio,
// búsqueda o situación es una consulta nueva -- nunca se filtra lo cargado.
// Cada tarjeta lleva a la ficha con la pestaña Reproducción abierta.
// Errores con el modelo de la Fase 3C (red, 403, 5xx con código de
// seguimiento). Sin conexión no hay tablero (no hay copia offline en 4C).
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import GanaderiaBackLink from '../components/GanaderiaBackLink.jsx';
import { StatusMessage } from '../components/FormField.jsx';
import { getResumenReproductivo, listPrediosActivos, listTableroReproductivo } from '../hato/hatoApi.js';
import {
  FILTROS_RAPIDOS,
  SITUACIONES,
  TABLERO_PAGINA,
  TEXTO_CARGANDO_TABLERO,
  anexarPagina,
  cargarVigente,
  crearSecuencia,
  esFiltroAlerta,
  estadoLista,
  estadoResumen,
  filtrosConSituacion,
  kpisDe,
  queryListado,
  tarjetaAnimal,
  textoUmbrales,
  textoVacio,
} from './tableroModel.js';
import '../styles/ganaderia-hato.css';

const FILTROS_INICIALES = Object.freeze({ filtro: 'TODOS', predioId: '', q: '', situacion: 'EN_HATO' });

function TarjetaAnimal({ fila }) {
  const t = tarjetaAnimal(fila);
  return (
    <li>
      <Link className="gan-hato-card gan-tablero-card" to={t.ruta} aria-label={`${t.identidad}: ${t.estadoTexto}. Abrir reproducción`}>
        <div className="gan-hato-card-head">
          <strong>{t.identidad}</strong>
          <span className={`gan-repro-badge gan-repro-badge-${t.estado.toLowerCase()}`}>{t.estadoTexto}</span>
        </div>
        <div className="gan-hato-card-body">
          {t.predio ? <span>{t.predio}</span> : null}
          {t.cerrado ? <span className="gan-hato-badge">{t.cerrado}</span> : null}
          {t.anulado ? <span className="gan-hato-badge">Anulado</span> : null}
        </div>
        {t.datos.length ? (
          <dl className="gan-tablero-datos">
            {t.datos.map(([label, valor]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{valor}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        {t.alertas.length ? (
          <ul className="gan-tablero-alertas">
            {t.alertas.map((a) => (
              <li key={a.codigo} className="gan-tablero-alerta" data-nivel={a.nivel}>
                <span className="gan-tablero-alerta-nivel">{a.nivelTexto}</span>
                <strong>{a.titulo}</strong>
                <span>{a.mensaje}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </Link>
    </li>
  );
}

export default function ReproduccionTableroPage() {
  const [filtros, setFiltros] = useState(FILTROS_INICIALES);
  const [busqueda, setBusqueda] = useState('');
  const [predios, setPredios] = useState([]);
  const [resumen, setResumen] = useState({ status: 'loading', data: null, mensaje: null });
  const [lista, setLista] = useState({ status: 'loading', animales: [], total: 0, mensaje: null });
  const [cargandoMas, setCargandoMas] = useState(false);
  // Response-race: secuencias INDEPENDIENTES para KPIs y listado; solo la
  // petición más reciente de cada una aplica su resultado (incluido un fallo).
  const secuenciaResumen = useRef(null);
  const secuenciaLista = useRef(null);
  if (!secuenciaResumen.current) secuenciaResumen.current = crearSecuencia();
  if (!secuenciaLista.current) secuenciaLista.current = crearSecuencia();

  useEffect(() => {
    let activo = true;
    listPrediosActivos()
      .then(({ ok, data }) => { if (activo && ok && Array.isArray(data?.predios)) setPredios(data.predios); })
      .catch(() => {});
    return () => { activo = false; };
  }, []);

  // KPIs: siempre del hato actual (ACTIVO + EN_HATO), opcionalmente por predio.
  const cargarResumen = useCallback(async () => {
    setResumen((r) => ({ ...r, status: 'loading' }));
    await cargarVigente(
      secuenciaResumen.current,
      () => getResumenReproductivo({ predioId: filtros.predioId || undefined }),
      (resultado) => setResumen(estadoResumen(resultado)),
    );
  }, [filtros.predioId]);

  const cargarLista = useCallback(async () => {
    setLista((l) => ({ ...l, status: 'loading' }));
    await cargarVigente(
      secuenciaLista.current,
      () => listTableroReproductivo(queryListado(filtros)),
      (resultado) => setLista(estadoLista(resultado)),
    );
  }, [filtros]);

  useEffect(() => { cargarResumen(); }, [cargarResumen]);
  useEffect(() => { cargarLista(); }, [cargarLista]);

  // "Ver más" pertenece al listado vigente: no avanza la secuencia, y si los
  // filtros cambian mientras está en vuelo su resultado (o fallo) se descarta.
  async function cargarMas() {
    if (cargandoMas) return;
    setCargandoMas(true);
    try {
      await cargarVigente(
        secuenciaLista.current,
        () => listTableroReproductivo(queryListado(filtros, { offset: lista.animales.length })),
        (resultado) => setLista((l) => anexarPagina(l, resultado)),
        { id: secuenciaLista.current.actual },
      );
    } finally {
      setCargandoMas(false);
    }
  }

  function buscar(event) {
    event.preventDefault();
    setFiltros((f) => ({ ...f, q: busqueda.trim() }));
  }

  const kpis = kpisDe(resumen.data);
  const historico = filtros.situacion !== 'EN_HATO';

  return (
    <div className="gan-panel gan-hato gan-tablero">
      <GanaderiaBackLink />
      <div className="gan-section-heading">
        <span className="gan-eyebrow">Reproducción</span>
        <h2>Tablero reproductivo</h2>
        <p>Hembras del hato que requieren seguimiento reproductivo. Para registrar eventos, abre la ficha del animal.</p>
      </div>

      <section aria-labelledby="tablero-kpis-titulo">
        <h3 id="tablero-kpis-titulo" className="gan-tablero-subtitulo">Hato actual</h3>
        {resumen.status === 'error' ? (
          <div className="gan-hato-actions">
            <StatusMessage type="error">{resumen.mensaje}</StatusMessage>
            <button type="button" className="gan-secondary-button" onClick={cargarResumen}>Reintentar</button>
          </div>
        ) : null}
        {kpis.length ? (
          <ul className="gan-tablero-kpis" aria-busy={resumen.status === 'loading' ? 'true' : undefined}>
            {kpis.map((k) => (
              <li key={k.id}>
                <button
                  type="button"
                  className={`gan-tablero-kpi${filtros.filtro === k.id && !historico ? ' is-active' : ''}${k.alerta && k.valor > 0 ? ' con-alerta' : ''}`}
                  aria-pressed={filtros.filtro === k.id && !historico}
                  onClick={() => setFiltros((f) => ({ ...f, filtro: k.id, situacion: 'EN_HATO' }))}
                >
                  <span className="gan-tablero-kpi-valor">{k.valor}</span>
                  <span className="gan-tablero-kpi-label">{k.label}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {resumen.data?.configuracion ? <p className="gan-hato-hint gan-tablero-reglas">{textoUmbrales(resumen.data.configuracion)}</p> : null}
      </section>

      <div className="gan-tablero-filtros" role="group" aria-label="Filtros rápidos">
        {FILTROS_RAPIDOS.map((f) => (
          <button
            key={f.id}
            type="button"
            className={`gan-tablero-chip${filtros.filtro === f.id ? ' is-active' : ''}`}
            aria-pressed={filtros.filtro === f.id}
            disabled={historico && esFiltroAlerta(f.id)}
            onClick={() => setFiltros((actual) => ({ ...actual, filtro: f.id }))}
          >
            {f.label}
          </button>
        ))}
      </div>

      <form className="gan-hato-toolbar gan-tablero-toolbar" onSubmit={buscar} role="search">
        <input
          type="search"
          value={busqueda}
          maxLength={80}
          placeholder="Buscar por chapeta o nombre"
          aria-label="Buscar por chapeta o nombre"
          onChange={(event) => setBusqueda(event.target.value)}
        />
        <select value={filtros.predioId} aria-label="Filtrar por predio" onChange={(event) => setFiltros((f) => ({ ...f, predioId: event.target.value }))}>
          <option value="">Todos los predios</option>
          {predios.map((p) => <option key={p.predioId} value={p.predioId}>{p.nombrePredio}</option>)}
        </select>
        <select value={filtros.situacion} aria-label="Situación" onChange={(event) => setFiltros((f) => filtrosConSituacion(f, event.target.value))}>
          {SITUACIONES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
        <button type="submit" className="gan-secondary-button">Buscar</button>
      </form>
      {historico ? <p className="gan-hato-hint">Histórico: hembras que ya no están en el hato. Las alertas solo aplican al hato actual.</p> : null}

      <div aria-live="polite">
        {lista.status === 'loading' && !lista.animales.length ? <StatusMessage>{TEXTO_CARGANDO_TABLERO}</StatusMessage> : null}
        {lista.status === 'error' ? (
          <div className="gan-hato-actions">
            <StatusMessage type="error">{lista.mensaje}</StatusMessage>
            <button type="button" className="gan-secondary-button" onClick={cargarLista}>Reintentar</button>
          </div>
        ) : null}
        {lista.status === 'ok' && !lista.animales.length ? <StatusMessage type="info">{textoVacio(filtros)}</StatusMessage> : null}
      </div>

      {lista.animales.length ? (
        <>
          <p className="gan-hato-hint">{lista.total} {lista.total === 1 ? 'hembra' : 'hembras'}</p>
          <ul className="gan-hato-list gan-tablero-lista" aria-busy={lista.status === 'loading' ? 'true' : undefined}>
            {lista.animales.map((fila) => <TarjetaAnimal key={fila.animalId} fila={fila} />)}
          </ul>
          {lista.status === 'ok' && lista.mensaje ? <StatusMessage type="error">{lista.mensaje}</StatusMessage> : null}
          {lista.animales.length < lista.total ? (
            <button type="button" className="gan-secondary-button" onClick={cargarMas} disabled={cargandoMas}>
              {cargandoMas ? 'Cargando…' : `Ver más (${TABLERO_PAGINA} por página)`}
            </button>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
