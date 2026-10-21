// FASE 1D.2: pestaña "Actividad" de la ficha -- línea de tiempo DERIVADA del
// animal (GET /api/ganaderia/animales/:id/timeline), más reciente primero.
// Carga DIFERIDA: solo cuando la pestaña es visible por primera vez. Al volver
// se reutiliza lo cargado, salvo que la ficha haya marcado un cambio
// (`version`: pesaje confirmado, corrección, anulación, chapeta QR): si la
// pestaña está abierta se recarga, y si está cerrada se recarga al abrirla.
// Sin polling. Los pesajes pendientes del outbox NO aparecen aquí (solo los
// confirmados por el servidor). Si un PESAJE_CREAR de este animal desaparece
// del outbox (confirmado por el motor) mientras esta pestaña está montada, se
// marca como desactualizada (avisos del repositorio local, sin polling).
import { useCallback, useEffect, useRef, useState } from 'react';
import { StatusMessage } from '../components/FormField.jsx';
import { getTimelineAnimal } from './hatoApi.js';
import {
  TEXTO_CARGANDO_ACTIVIDAD,
  TEXTO_ERROR_ACTIVIDAD,
  TEXTO_SIN_ACTIVIDAD,
  detallesEvento,
  estadoActividad,
  etiquetaTipoEvento,
  fechaEvento,
} from './actividadModel.js';
import { huboConfirmaciones, idsPendientes } from './pesajesOfflineModel.js';

export default function HatoActividadPanel({ animalId, visible, version = 0, repoOffline = null }) {
  const [state, setState] = useState({ status: 'idle', eventos: [], total: 0, truncado: false });
  const [confirmacionesLocales, setConfirmacionesLocales] = useState(0);
  const versionCargadaRef = useRef(null);
  const pendientesRef = useRef(new Set());
  // La clave incluye el animal: otra ficha nunca reutiliza datos ajenos.
  const clave = `${animalId}:${version}:${confirmacionesLocales}`;

  const cargar = useCallback(async (versionPedida) => {
    versionCargadaRef.current = versionPedida;
    setState((actual) => ({ ...actual, status: actual.eventos.length ? 'refrescando' : 'loading' }));
    try {
      setState(estadoActividad(await getTimelineAnimal(animalId)));
    } catch {
      setState({ status: 'error', eventos: [], total: 0, truncado: false });
    }
  }, [animalId]);

  // Lazy + stale: solo pide cuando está visible y su versión quedó atrás.
  useEffect(() => {
    if (visible && versionCargadaRef.current !== clave) cargar(clave);
  }, [visible, clave, cargar]);

  // Pesajes offline confirmados por el motor (outbox local, sin red).
  useEffect(() => {
    if (!repoOffline) return undefined;
    let activo = true;
    const revisar = async () => {
      let lista;
      try {
        lista = await repoOffline.listPesajesPendientes(animalId);
      } catch {
        return;
      }
      if (!activo) return;
      const actuales = idsPendientes(lista);
      if (huboConfirmaciones(pendientesRef.current, actuales)) setConfirmacionesLocales((n) => n + 1);
      pendientesRef.current = actuales;
    };
    revisar();
    const unsubscribe = repoOffline.subscribe(() => { revisar(); });
    return () => {
      activo = false;
      unsubscribe();
    };
  }, [repoOffline, animalId]);

  return (
    <section className="gan-actividad" aria-labelledby="actividad-titulo">
      <h3 id="actividad-titulo">Actividad del animal</h3>

      {state.status === 'loading' || state.status === 'idle' ? <StatusMessage>{TEXTO_CARGANDO_ACTIVIDAD}</StatusMessage> : null}
      {state.status === 'not_found' ? <StatusMessage type="error">Este animal no está disponible.</StatusMessage> : null}
      {state.status === 'error' ? (
        <div className="gan-hato-actions">
          <StatusMessage type="error">{TEXTO_ERROR_ACTIVIDAD}</StatusMessage>
          <button type="button" className="gan-secondary-button" onClick={() => cargar(clave)}>Reintentar</button>
        </div>
      ) : null}
      {state.status === 'vacio' ? <p className="gan-actividad-vacio">{TEXTO_SIN_ACTIVIDAD}</p> : null}

      {state.eventos.length ? (
        <>
          <ol className="gan-actividad-lista" aria-busy={state.status === 'refrescando' ? 'true' : undefined}>
            {state.eventos.map((evento) => (
              <li key={evento.id} className="gan-actividad-evento" data-tipo={evento.tipo}>
                <span className="gan-actividad-marca" aria-hidden="true" />
                <div className="gan-actividad-cuerpo">
                  <div className="gan-actividad-cabecera">
                    <span className="gan-actividad-tipo">{etiquetaTipoEvento(evento.tipo)}</span>
                    <time className="gan-actividad-fecha" dateTime={evento.fechaHora ?? evento.fecha ?? undefined}>{fechaEvento(evento)}</time>
                  </div>
                  <strong className="gan-actividad-titulo">{evento.titulo}</strong>
                  {evento.descripcion ? <p className="gan-actividad-descripcion">{evento.descripcion}</p> : null}
                  {detallesEvento(evento).length ? (
                    <ul className="gan-actividad-detalles">
                      {detallesEvento(evento).map((linea) => <li key={linea}>{linea}</li>)}
                    </ul>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
          {state.truncado ? (
            <p className="gan-hato-hint">Se muestran los {state.eventos.length} eventos más recientes de {state.total}.</p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
