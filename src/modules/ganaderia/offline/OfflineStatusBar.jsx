// SPRINT-3D11.3 (R1): indicador SIEMPRE visible en Ganadería:
// ONLINE — SINCRONIZADO | OFFLINE | SINCRONIZANDO | X CAMBIOS PENDIENTES |
// CONFLICTO DE SINCRONIZACIÓN | ERROR DE SINCRONIZACIÓN, con última
// sincronización, pendientes y "Sincronizar ahora" como acción SECUNDARIA
// (la sincronización es automática).
import { Link } from 'react-router-dom';
import { useGanaderiaOffline } from './GanaderiaOfflineProvider.jsx';
import { MENSAJE_ACTUALIZACION_BLOQUEADA, MENSAJE_REQUIERE_RECARGA } from './browserOffline.js';
import '../styles/ganaderia-offline.css';

export function formatUltimaSync(iso) {
  if (!iso) return 'Nunca';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? 'Nunca' : date.toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' });
}

export default function OfflineStatusBar() {
  const offline = useGanaderiaOffline();
  if (offline.status === 'no_disponible' || !offline.indicador) return null;
  // FASE 4E.1: actualización de la base local pendiente (los datos siguen intactos).
  if (offline.status === 'actualizacion_bloqueada' || offline.status === 'requiere_recarga') {
    const bloqueada = offline.status === 'actualizacion_bloqueada';
    return (
      <div className="gan-offline-bar gan-offline-error" role="alert">
        <strong>{bloqueada ? MENSAJE_ACTUALIZACION_BLOQUEADA : MENSAJE_REQUIERE_RECARGA}</strong>
        <span className="gan-offline-bar-actions">
          <button type="button" onClick={() => (bloqueada ? offline.reintentarApertura() : window.location.reload())}>
            {bloqueada ? 'Reintentar' : 'Recargar'}
          </button>
        </span>
      </div>
    );
  }
  const { indicador, stats } = offline;
  return (
    <div className={`gan-offline-bar gan-offline-${indicador.estado.toLowerCase()}`} role="status" aria-live="polite">
      <strong>{indicador.etiqueta}</strong>
      <span>Última sincronización: {formatUltimaSync(stats?.ultimaSyncAt)}</span>
      {stats?.pendientes ? <span>{stats.pendientes} pendientes</span> : null}
      {!offline.preparado ? <span>Dispositivo no preparado para trabajo sin señal</span> : null}
      <span className="gan-offline-bar-actions">
        <Link to="/ganaderia/sincronizacion">Detalles</Link>
        {offline.online ? (
          <button type="button" onClick={() => offline.syncNow()} disabled={offline.engineState?.enCurso}>
            Sincronizar ahora
          </button>
        ) : null}
      </span>
    </div>
  );
}
