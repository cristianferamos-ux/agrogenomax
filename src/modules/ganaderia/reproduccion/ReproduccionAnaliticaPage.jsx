// FASE 4D: analítica reproductiva de la ORGANIZACIÓN
// (/ganaderia/reproduccion/analitica). Solo lectura para los 4 roles. Todo lo
// calcula el backend: cada cambio de periodo o predio es una consulta nueva y
// solo la más reciente aplica su resultado (response-race, incluido un fallo).
// M14 queda siempre visible junto a las métricas.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import GanaderiaBackLink from '../components/GanaderiaBackLink.jsx';
import { StatusMessage } from '../components/FormField.jsx';
import { getAnaliticaReproductiva, listPrediosActivos } from '../hato/hatoApi.js';
import { cargarVigente, crearSecuencia } from './tableroModel.js';
import {
  TEXTO_CARGANDO_ANALITICA,
  estadoAnalitica,
  gruposCalidad,
  queryAnalitica,
  tarjetasMetricas,
  textoPeriodo,
  textoPoblacion,
  textoUmbralesCalidad,
} from './analiticaModel.js';
import '../styles/ganaderia-hato.css';

const FILTROS_INICIALES = Object.freeze({ predioId: '', desde: '', hasta: '' });

function TarjetaMetrica({ tarjeta }) {
  return (
    <li className="gan-analitica-card">
      <h4>{tarjeta.titulo}</h4>
      <p className="gan-analitica-valor">{tarjeta.valor}</p>
      {tarjeta.detalle ? <p className="gan-hato-hint">{tarjeta.detalle}</p> : null}
      <dl className="gan-tablero-datos">
        {tarjeta.datos.map(([label, valor]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{valor}</dd>
          </div>
        ))}
        {tarjeta.cobertura ? (
          <div>
            <dt>Cobertura</dt>
            <dd>{tarjeta.cobertura}</dd>
          </div>
        ) : null}
      </dl>
      {tarjeta.desglose.length ? (
        <ul className="gan-analitica-desglose" aria-label="Por tipo de servicio">
          {tarjeta.desglose.map((d) => (
            <li key={d.tipo}>
              <span>{d.etiqueta}</span>
              <span>{d.valor} · n {d.n}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export default function ReproduccionAnaliticaPage() {
  const [filtros, setFiltros] = useState(FILTROS_INICIALES);
  const [formulario, setFormulario] = useState({ desde: '', hasta: '' });
  const [predios, setPredios] = useState([]);
  const [estado, setEstado] = useState({ status: 'loading', data: null, mensaje: null });
  const secuencia = useRef(null);
  if (!secuencia.current) secuencia.current = crearSecuencia();

  useEffect(() => {
    let activo = true;
    listPrediosActivos()
      .then(({ ok, data }) => { if (activo && ok && Array.isArray(data?.predios)) setPredios(data.predios); })
      .catch(() => {});
    return () => { activo = false; };
  }, []);

  const cargar = useCallback(async () => {
    setEstado((e) => ({ ...e, status: 'loading' }));
    await cargarVigente(
      secuencia.current,
      () => getAnaliticaReproductiva(queryAnalitica(filtros)),
      (resultado) => {
        const siguiente = estadoAnalitica(resultado);
        setEstado(siguiente);
        if (siguiente.data?.periodo) setFormulario({ desde: siguiente.data.periodo.desde, hasta: siguiente.data.periodo.hasta });
      },
    );
  }, [filtros]);

  useEffect(() => { cargar(); }, [cargar]);

  function aplicarPeriodo(event) {
    event.preventDefault();
    setFiltros((f) => ({ ...f, desde: formulario.desde, hasta: formulario.hasta }));
  }

  const { data } = estado;
  const tarjetas = tarjetasMetricas(data?.metricas);
  const calidad = gruposCalidad(data?.metricas);
  const cargando = estado.status === 'loading';

  return (
    <div className="gan-panel gan-hato gan-tablero gan-analitica">
      <GanaderiaBackLink />
      <div className="gan-section-heading">
        <span className="gan-eyebrow">Reproducción</span>
        <h2>Analítica reproductiva</h2>
        <p>Resultados del periodo según los eventos registrados. Incluye hembras salidas o muertas si el evento pertenece al periodo.</p>
        <Link className="gan-secondary-button" to="/ganaderia/reproduccion">Volver al tablero</Link>
      </div>

      <form className="gan-hato-toolbar gan-analitica-toolbar" onSubmit={aplicarPeriodo}>
        <label>
          <span>Desde</span>
          <input type="date" value={formulario.desde} max={formulario.hasta || undefined} required onChange={(event) => setFormulario((f) => ({ ...f, desde: event.target.value }))} />
        </label>
        <label>
          <span>Hasta</span>
          <input type="date" value={formulario.hasta} max={data?.fecha} required onChange={(event) => setFormulario((f) => ({ ...f, hasta: event.target.value }))} />
        </label>
        <label>
          <span>Predio actual</span>
          <select value={filtros.predioId} onChange={(event) => setFiltros((f) => ({ ...f, predioId: event.target.value }))}>
            <option value="">Todos los predios</option>
            {predios.map((p) => <option key={p.predioId} value={p.predioId}>{p.nombrePredio}</option>)}
          </select>
        </label>
        <button type="submit" className="gan-secondary-button">Aplicar</button>
        <button type="button" className="gan-secondary-button" onClick={() => setFiltros((f) => ({ ...f, desde: '', hasta: '' }))}>Últimos 12 meses</button>
      </form>

      <div aria-live="polite">
        {cargando && !data ? <StatusMessage>{TEXTO_CARGANDO_ANALITICA}</StatusMessage> : null}
        {estado.status === 'error' ? (
          <div className="gan-hato-actions">
            <StatusMessage type="error">{estado.mensaje}</StatusMessage>
            <button type="button" className="gan-secondary-button" onClick={cargar}>Reintentar</button>
          </div>
        ) : null}
      </div>

      {data ? (
        <div className="gan-analitica-cuerpo" aria-busy={cargando ? 'true' : undefined}>
          <section aria-labelledby="analitica-metricas-titulo">
            <h3 id="analitica-metricas-titulo" className="gan-tablero-subtitulo">Métricas del periodo</h3>
            <p className="gan-hato-hint">{textoPeriodo(data.periodo)} {textoPoblacion(data.poblacion)}</p>
            <a className="gan-analitica-enlace-calidad" href="#analitica-calidad-titulo">Ver calidad y exclusiones</a>
            <ul className="gan-analitica-grid">
              {tarjetas.map((t) => <TarjetaMetrica key={t.id} tarjeta={t} />)}
            </ul>
          </section>

          <section className="gan-analitica-calidad" aria-labelledby="analitica-calidad-titulo" tabIndex={0}>
            <h3 id="analitica-calidad-titulo" className="gan-tablero-subtitulo">Calidad y exclusiones</h3>
            {calidad.map((grupo) => (
              <div key={grupo.metrica} className="gan-analitica-calidad-grupo">
                <h4>{grupo.titulo}</h4>
                <ul>
                  {grupo.items.map((item) => (
                    <li key={item.codigo}>
                      <span>{item.etiqueta}</span>
                      <strong>{item.conteo}</strong>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            <p className="gan-hato-hint">{textoUmbralesCalidad(data.configuracion, data.muestraMinima)}</p>
          </section>
        </div>
      ) : null}
    </div>
  );
}
