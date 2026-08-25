// SPRINT-3D7.1-AGROCLIMA: sección "Contexto agroclimático" de la tarjeta
// del potrero (§23 del sprint). Habla EXCLUSIVAMENTE con
// ganaderiaAgroClimaApi.js (/api/ganaderia/predios/:predioId/potreros/:potreroId/contexto-agroclimatico).
// No depende de la ficha productiva -- se resuelve directamente de la
// geometry del potrero, server-side (§1/§12 del sprint).
//
// §24 del sprint: nunca prometer precisión puntual absoluta -- el copy es
// siempre "estimado a partir de fuentes públicas y observacionales".
import { useEffect, useState } from 'react';
import { StatusMessage } from '../components/FormField.jsx';
import { formatDateDisplay } from '../utils/dateFormat.js';
import { getContextoAgroclimatico, refreshContextoAgroclimatico } from './ganaderiaAgroClimaApi.js';

const GENERIC_ERROR = 'No fue posible completar la operación en este momento. Intenta nuevamente.';

const STATUS_MESSAGES = {
  PARTIAL: 'Contexto parcial: alguna fuente no respondió en este refresco. Los valores mostrados son los que sí se obtuvieron.',
  UNAVAILABLE: 'Ninguna fuente respondió en este refresco. Intenta nuevamente en unos minutos.',
};

function formatNumber(value, options = {}) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '—';
  return num.toLocaleString('es-CO', { minimumFractionDigits: 1, maximumFractionDigits: 1, ...options });
}

const IDEAM_STATUS_LABELS = {
  NO_STATION_NEARBY: 'Sin estaciones IDEAM cercanas en este refresco.',
  STATION_FOUND_NO_RECENT_OBSERVATIONS: 'Hay estaciones IDEAM cercanas, pero ninguna con lecturas recientes.',
  FAILED: 'No disponible en este refresco.',
};

function AgroClimaSummary({ actual }) {
  // dataset (no provider) es la clave estable de enrutado: provider es
  // el nombre honesto del proveedor de entrega (OPEN_METEO/
  // IDEAM_DATOS_ABIERTOS), dataset identifica el conjunto de datos
  // (ERA5_LAND/IDEAM) -- ver agroClimateOrchestrator.js.
  const era5Fuente = (actual.fuentes || []).find((f) => f.dataset === 'ERA5_LAND');
  const ideamFuente = (actual.fuentes || []).find((f) => f.dataset === 'IDEAM');

  return (
    <div className="gan-ficha-productiva-summary">
      <p className="gan-potrero-points-hint">
        Contexto agroclimático estimado a partir de fuentes públicas y observacionales.
      </p>

      <strong className="gan-potrero-card-name">Precipitación</strong>
      <div className="gan-ficha-row"><span>Últimas 24 h</span><strong>{formatNumber(actual.precipitacion24hMm)} mm</strong></div>
      <div className="gan-ficha-row"><span>Últimos 7 días</span><strong>{formatNumber(actual.precipitacion7dMm)} mm</strong></div>
      <div className="gan-ficha-row"><span>Últimos 15 días</span><strong>{formatNumber(actual.precipitacion15dMm)} mm</strong></div>
      <div className="gan-ficha-row"><span>Últimos 30 días</span><strong>{formatNumber(actual.precipitacion30dMm)} mm</strong></div>

      <strong className="gan-potrero-card-name">Temperatura</strong>
      <div className="gan-ficha-row"><span>Media</span><strong>{formatNumber(actual.temperaturaMediaC)} °C</strong></div>
      <div className="gan-ficha-row"><span>Mínima</span><strong>{formatNumber(actual.temperaturaMinC)} °C</strong></div>
      <div className="gan-ficha-row"><span>Máxima</span><strong>{formatNumber(actual.temperaturaMaxC)} °C</strong></div>

      <strong className="gan-potrero-card-name">Humedad</strong>
      <div className="gan-ficha-row"><span>Relativa</span><strong>{formatNumber(actual.humedadRelativaMediaPct)} %</strong></div>
      <div className="gan-ficha-row"><span>Suelo (superficial)</span><strong>{actual.humedadSueloSuperficial === null ? '—' : `${formatNumber(actual.humedadSueloSuperficial, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} m³/m³`}</strong></div>

      <strong className="gan-potrero-card-name">Radiación</strong>
      <div className="gan-ficha-row"><span>Radiación solar</span><strong>{actual.radiacionSolar === null ? '—' : `${formatNumber(actual.radiacionSolar)} W/m²`}</strong></div>

      <strong className="gan-potrero-card-name">Fuentes</strong>
      <div className="gan-ficha-row">
        <span>ERA5-Land</span>
        <strong>{era5Fuente?.status === 'OK' ? 'Disponible' : 'No disponible en este refresco'}</strong>
      </div>
      <div className="gan-ficha-row">
        <span>IDEAM</span>
        <strong>
          {ideamFuente?.status === 'OK'
            ? `${ideamFuente.stationName || ideamFuente.stationCode} (${formatNumber(ideamFuente.distanceKm, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} km)`
            : (IDEAM_STATUS_LABELS[ideamFuente?.status] || IDEAM_STATUS_LABELS.FAILED)}
        </strong>
      </div>

      <div className="gan-ficha-row">
        <span>Datos disponibles hasta</span>
        <strong>{actual.sourceObservedUntil ? formatDateDisplay(actual.sourceObservedUntil) : '—'}</strong>
      </div>
    </div>
  );
}

export default function PotreroAgroClimaPanel({ predioId, potreroId }) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [actual, setActual] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState('');
  const [lastStatus, setLastStatus] = useState(null);

  function loadContexto() {
    let active = true;
    setLoading(true);
    setLoadError('');
    getContextoAgroclimatico(predioId, potreroId)
      .then(({ ok, data }) => {
        if (!active) return;
        if (!ok) {
          setLoadError(GENERIC_ERROR);
          setLoading(false);
          return;
        }
        setActual(data?.actual ?? null);
        setLoading(false);
      })
      .catch(() => {
        if (active) {
          setLoadError(GENERIC_ERROR);
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }

  useEffect(loadContexto, [predioId, potreroId]);

  async function handleRefresh() {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshError('');
    setLastStatus(null);

    const { ok, data } = await refreshContextoAgroclimatico(predioId, potreroId);
    setRefreshing(false);
    if (!ok) {
      setRefreshError(GENERIC_ERROR);
      return;
    }
    setLastStatus(data?.status ?? null);
    if (data?.snapshot) {
      setActual(data.snapshot);
    }
  }

  if (loading) {
    return <p className="gan-potrero-points-hint">Cargando contexto agroclimático...</p>;
  }

  if (loadError) {
    return <StatusMessage type="error">{loadError}</StatusMessage>;
  }

  return (
    <div className="gan-ficha-productiva-panel">
      {!actual ? (
        <div className="gan-ficha-productiva-empty">
          <p className="gan-potrero-points-hint">Aún no hay contexto agroclimático calculado para este potrero.</p>
        </div>
      ) : (
        <AgroClimaSummary actual={actual} />
      )}

      {lastStatus && STATUS_MESSAGES[lastStatus] ? <StatusMessage type="warning">{STATUS_MESSAGES[lastStatus]}</StatusMessage> : null}
      <StatusMessage type="error">{refreshError}</StatusMessage>

      <div className="gan-potrero-actions">
        <button type="button" className="gan-secondary-button" onClick={handleRefresh} disabled={refreshing}>
          {refreshing ? 'Actualizando...' : 'Actualizar contexto'}
        </button>
      </div>
    </div>
  );
}
