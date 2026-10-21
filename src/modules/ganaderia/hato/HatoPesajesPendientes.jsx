// FASE 1D.1: pesajes guardados en el dispositivo y aún NO confirmados por el
// servidor (outbox PESAJE_CREAR). Se muestran APARTE del historial
// confirmado, con su estado en texto ("Pendiente", "Sincronizando", "No
// sincronizado"); no tienen pesajeId ni entran en KPIs, gráficas, alertas ni
// PDF hasta que el servidor los confirma.
import { Link } from 'react-router-dom';
import { formatFecha, formatKg, formatMetodo } from './pesajesModel.js';
import { estadoPesajePendiente, resumenPendientes } from './pesajesOfflineModel.js';

export default function HatoPesajesPendientes({ pendientes = [] }) {
  if (!pendientes.length) return null;
  return (
    <section className="gan-pesajes-pendientes" aria-labelledby="pesajes-pendientes-titulo">
      <h4 id="pesajes-pendientes-titulo">{resumenPendientes(pendientes.length)}</h4>
      <p className="gan-pesajes-pendientes-nota">
        No cuentan todavía en los indicadores, gráficas, alertas ni en el reporte: el servidor aún no los confirma.
      </p>
      <ul>
        {pendientes.map((p) => {
          const estado = estadoPesajePendiente(p);
          return (
            <li key={p.localOperationId} className="gan-pesajes-pendiente" data-estado={p.estado}>
              <strong className="gan-pesajes-pendiente-badge">{estado.etiqueta}</strong>
              <span className="gan-pesajes-pendiente-datos">
                {formatFecha(p.fecha)} · {formatKg(p.pesoKg)} · {formatMetodo(p.metodo)}
              </span>
              {p.observaciones ? <span className="gan-pesajes-pendiente-obs">{p.observaciones}</span> : null}
              <span className="gan-pesajes-pendiente-detalle">
                {estado.detalle}
                {estado.bloqueado ? <> <Link to="/ganaderia/sincronizacion">Revisar en Sincronización</Link></> : null}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
