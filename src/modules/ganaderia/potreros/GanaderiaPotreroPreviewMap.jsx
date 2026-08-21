// SPRINT-3D4 §10/§11: mapa propio de Ganadería para el flujo de registro
// de Potreros -- contorno del PREDIO base (verde AGX, sin relleno, mismo
// criterio que GanaderiaPredioMiniMap.jsx) + polígono del POTRERO en
// preview (línea distinta, relleno MUY tenue solo para legibilidad, sin
// oscurecer el satélite). Componente PROPIO de Ganadería: no importa ni
// modifica CatastroXMap.jsx.
//
// Geometría del predio: GET /api/ganaderia/predios/:predioId (mismo
// endpoint que ya usa GanaderiaPredioMiniMap.jsx). Geometría del potrero:
// viene del candidate ya resuelto server-side (preview-coordinates /
// preview-gps) -- nunca se recalcula ni se valida en el cliente.
import { useEffect, useState } from 'react';
import { GeoJSON, MapContainer, TileLayer } from 'react-leaflet';

const SATELLITE_TILE_URL =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';

const PREDIO_STYLE = { color: '#9cff1a', weight: 3, fillOpacity: 0 };
const POTRERO_STYLE = { color: '#00d8ff', weight: 3, fillColor: '#00d8ff', fillOpacity: 0.12 };
// SPRINT-3D5.2 §13: potrero RECHAZADO por tolerancia (OUTSIDE) -- contorno
// rojo, relleno muy tenue, solo para visualización de solo lectura. Nunca
// acompaña un candidate confirmable.
const POTRERO_REJECTED_STYLE = { color: '#ff4d4d', weight: 3, fillColor: '#ff4d4d', fillOpacity: 0.12 };

function extractRingLatLngs(geometry) {
  const ring =
    geometry?.type === 'Polygon'
      ? geometry.coordinates?.[0]
      : geometry?.type === 'MultiPolygon'
        ? geometry.coordinates?.[0]?.[0]
        : null;

  if (!Array.isArray(ring) || ring.length === 0) return null;
  return ring.map(([lng, lat]) => [lat, lng]);
}

// §13: `potreroGeometry` (aceptado, STRICT_OK/TOLERANCE_OK) y
// `rejectedGeometry` (OUTSIDE, solo lectura) son mutuamente excluyentes en
// la práctica -- si ambos llegan, se prioriza `rejectedGeometry` porque
// nunca debe verse un contorno rechazado como si fuera confirmable.
export default function GanaderiaPotreroPreviewMap({ predioId, potreroGeometry, rejectedGeometry }) {
  const [predioStatus, setPredioStatus] = useState('loading'); // loading | ready | unavailable
  const [predioGeoJsonFeature, setPredioGeoJsonFeature] = useState(null);
  const [predioBounds, setPredioBounds] = useState(null);

  useEffect(() => {
    let active = true;
    setPredioStatus('loading');

    fetch(`/api/ganaderia/predios/${predioId}`, { credentials: 'include' })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (!active) return;
        const latLngs = extractRingLatLngs(data?.geometry);
        if (!latLngs) {
          setPredioStatus('unavailable');
          return;
        }
        setPredioBounds(latLngs);
        setPredioGeoJsonFeature({ type: 'Feature', properties: {}, geometry: data.geometry });
        setPredioStatus('ready');
      })
      .catch(() => {
        if (active) setPredioStatus('unavailable');
      });

    return () => {
      active = false;
    };
  }, [predioId]);

  if (predioStatus === 'loading') {
    return <div className="gan-potrero-preview-map-loading">Cargando mapa del predio...</div>;
  }

  if (predioStatus !== 'ready' || !predioBounds || !predioGeoJsonFeature) {
    return <div className="gan-potrero-preview-map-loading">Mapa no disponible para este predio.</div>;
  }

  const rejectedFeature = rejectedGeometry ? { type: 'Feature', properties: {}, geometry: rejectedGeometry } : null;
  const potreroFeature =
    !rejectedFeature && potreroGeometry ? { type: 'Feature', properties: {}, geometry: potreroGeometry } : null;
  const focusGeometry = rejectedFeature ? rejectedGeometry : potreroGeometry;
  const focusBounds = focusGeometry ? extractRingLatLngs(focusGeometry) : null;
  const bounds = focusBounds || predioBounds;

  return (
    <div className="gan-potrero-preview-map">
      <MapContainer
        bounds={bounds}
        boundsOptions={{ padding: [24, 24] }}
        scrollWheelZoom={false}
        attributionControl={false}
        className="gan-potrero-preview-map-canvas"
      >
        <TileLayer url={SATELLITE_TILE_URL} />
        <GeoJSON key="predio-base" data={predioGeoJsonFeature} style={PREDIO_STYLE} />
        {potreroFeature ? <GeoJSON key="potrero-preview" data={potreroFeature} style={POTRERO_STYLE} /> : null}
        {rejectedFeature ? (
          <GeoJSON key="potrero-rejected" data={rejectedFeature} style={POTRERO_REJECTED_STYLE} />
        ) : null}
      </MapContainer>
      <div className="gan-potrero-preview-legend">
        <span className="gan-potrero-legend-item gan-potrero-legend-predio">Predio base</span>
        {potreroFeature ? (
          <span className="gan-potrero-legend-item gan-potrero-legend-potrero">Potrero a registrar</span>
        ) : null}
        {rejectedFeature ? (
          <span className="gan-potrero-legend-item gan-potrero-legend-rejected">Potrero fuera de rango (no confirmable)</span>
        ) : null}
      </div>
    </div>
  );
}
