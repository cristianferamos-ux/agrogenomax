// FASE 1C.1: bloque "Alertas" de la pestaña Pesajes. Solo presenta las
// alertas DERIVADAS de construirAlertasPesajes (no persiste nada). Cada
// alerta muestra su severidad en texto, el mensaje y el dato que la origina:
// el color es un refuerzo, nunca la única señal.
import { ETIQUETAS_SEVERIDAD, detalleAlerta } from './pesajesAlertas.js';

export default function HatoPesajesAlertas({ alertas = [] }) {
  return (
    <section className="gan-pesajes-alertas" aria-labelledby="pesajes-alertas-titulo">
      <h4 id="pesajes-alertas-titulo">Alertas</h4>
      {alertas.length ? (
        <ul>
          {alertas.map((alerta) => {
            const detalle = detalleAlerta(alerta);
            return (
              <li key={alerta.codigo} className="gan-pesajes-alerta" data-severidad={alerta.severidad}>
                <strong className="gan-pesajes-alerta-severidad">{ETIQUETAS_SEVERIDAD[alerta.severidad]}</strong>
                <p>{alerta.mensaje}</p>
                {detalle ? <p className="gan-pesajes-alerta-detalle">{detalle}</p> : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="gan-pesajes-alertas-vacio">No hay alertas de pesaje activas.</p>
      )}
    </section>
  );
}
