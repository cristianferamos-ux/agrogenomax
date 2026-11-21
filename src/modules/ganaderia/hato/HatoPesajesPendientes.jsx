// FASE 1D.1: pesajes guardados en el dispositivo y aún NO confirmados por el
// servidor (outbox PESAJE_CREAR). Se muestran APARTE del historial
// confirmado, con su estado en texto; no tienen pesajeId ni entran en KPIs,
// gráficas, alertas ni PDF hasta que el servidor los confirma.
//
// FASE 5A.3c: estados "Pendiente de sincronización" / "Pendiente de confirmar" /
// "Conflicto" / "Rechazado" / "Bloqueado por cambio de cuenta" y acciones:
//   * "Cancelar registro pendiente" -- SOLO si el motor lo declaró cancelable seguro
//     (nunca salió) y es de esta cuenta; pide confirmación. Nunca se llama "Anular".
//   * "Solicitar anulación" -- owner/admin, para un registro que pudo llegar al servidor:
//     queda como anulación diferida hasta que el servidor confirme el pesaje.
// Nunca se muestran ids internos.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { formatFecha, formatKg, formatMetodo } from './pesajesModel.js';
import { estadoPesajePendiente, resumenPendientes } from './pesajesOfflineModel.js';
import { ADVERTENCIA_CANCELAR_PENDIENTE, estadoAnulacionPendiente } from './pesajesOfflineVista.js';

export default function HatoPesajesPendientes({
  pendientes = [], anulaciones = [], accionesDe = () => ({}), ocupado = false, onCancelar, onAnular,
}) {
  const [confirmando, setConfirmando] = useState(null);
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
          const acciones = accionesDe(p);
          const anulacion = anulaciones.find((a) => a.refClientOperationId && a.refClientOperationId === p.clientOperationId) ?? null;
          const estadoAnulacion = anulacion ? estadoAnulacionPendiente(anulacion) : null;
          const preguntando = confirmando === p.localOperationId;
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
              {estadoAnulacion ? (
                <span className="gan-pesajes-pendiente-detalle" data-anulacion-pendiente="true">
                  <strong>{estadoAnulacion.etiqueta}:</strong> {estadoAnulacion.detalle}
                </span>
              ) : null}
              {preguntando ? (
                <div className="gan-pesajes-pendiente-confirmar" role="group" aria-label="Confirmar cancelación del registro pendiente">
                  <p>{ADVERTENCIA_CANCELAR_PENDIENTE}</p>
                  <div className="gan-hato-actions">
                    <button type="button" className="gan-secondary-button" onClick={() => setConfirmando(null)} disabled={ocupado}>Conservar</button>
                    <button
                      type="button"
                      className="gan-secondary-button gan-pesaje-cancelar-pendiente"
                      disabled={ocupado}
                      onClick={async () => {
                        await onCancelar?.(p);
                        setConfirmando(null);
                      }}
                    >
                      Retirar del dispositivo
                    </button>
                  </div>
                </div>
              ) : null}
              {!preguntando && (acciones.cancelar || acciones.anularDiferida) ? (
                <div className="gan-hato-actions">
                  {acciones.cancelar ? (
                    <button type="button" className="gan-secondary-button gan-pesaje-cancelar-pendiente" disabled={ocupado} onClick={() => setConfirmando(p.localOperationId)}>
                      Cancelar registro pendiente
                    </button>
                  ) : null}
                  {acciones.anularDiferida ? (
                    <button type="button" className="gan-secondary-button gan-pesaje-anular" disabled={ocupado} onClick={() => onAnular?.(p)}>
                      Solicitar anulación
                    </button>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
