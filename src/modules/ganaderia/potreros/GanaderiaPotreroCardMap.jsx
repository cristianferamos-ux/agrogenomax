// SPRINT-3D5.3 §7: mapa de SOLO LECTURA para la tarjeta de un potrero ya
// registrado ("Ver potreros"). Componente PROPIO, separado de
// GanaderiaPotreroPreviewMap.jsx -- ese componente sirve al flujo de
// REGISTRO (preview de un candidate aún no confirmado, con estados de
// tolerancia OUTSIDE/rejected que no aplican a un potrero ya guardado).
// Mezclar ambas lógicas en un único componente acoplaría la vista de
// solo lectura al state machine de preview/candidate.
//
// Geometría del potrero: GET /api/ganaderia/predios/:predioId/potreros/:potreroId
// (detalle -- la lista de PotrerosByPredioPanel.jsx NO incluye geometry,
// ver ganaderiaPotrerosApi.js). Se pide únicamente cuando esta card se
// monta (lazy-load real: mientras el panel "Ver potreros" no está
// abierto, PotrerosByPredioPanel ni siquiera renderiza esta card). Un GET
// de detalle por potrero es inevitable -- cada potrero tiene geometry
// distinta -- pero SIEMPRE es 1 por card montada, nunca más.
//
// SPRINT-3D5.3-PERF: geometría del predio -- este componente YA NO la
// pide. Antes cada card repetía GET /api/ganaderia/predios/:predioId
// (N potreros -> N GETs idénticos del mismo predio); ahora
// PotrerosByPredioPanel.jsx resuelve esa geometry UNA sola vez por
// predioId y la pasa como prop `predioGeometry` (GeoJSON crudo) a cada
// card. Solo contexto visual (contorno verde, sin relleno) -- si la prop
// llega null/inválida (aún no cargó o falló), el potrero se sigue
// mostrando solo, nunca bloquea el mapa.
import { useEffect, useState } from 'react';
import { GeoJSON, MapContainer, TileLayer } from 'react-leaflet';
import { getPotreroByPredio } from './ganaderiaPotrerosApi.js';

const SATELLITE_TILE_URL =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';

const PREDIO_STYLE = { color: '#9cff1a', weight: 3, fillOpacity: 0 };
const POTRERO_STYLE = { color: '#00d8ff', weight: 3, fillColor: '#00d8ff', fillOpacity: 0.12 };

const MAP_ERROR_MESSAGE = 'No fue posible cargar el mapa del potrero.';

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

// predioId/potreroId identifican de forma única la geometría a cargar --
// nunca se mezclan potreros entre predios porque ambos vienen fijos desde
// la card que monta este componente (PotrerosByPredioPanel.jsx).
// predioGeometry: GeoJSON crudo (o null) ya resuelto por el panel padre --
// puramente presentacional aquí, este componente nunca lo fetchea.
export default function GanaderiaPotreroCardMap({ predioId, potreroId, predioGeometry }) {
  const [potreroStatus, setPotreroStatus] = useState('loading'); // loading | ready | error
  const [potreroFeature, setPotreroFeature] = useState(null);
  const [potreroBounds, setPotreroBounds] = useState(null);

  useEffect(() => {
    let active = true;
    setPotreroStatus('loading');
    setPotreroFeature(null);
    setPotreroBounds(null);

    getPotreroByPredio(predioId, potreroId)
      .then(({ ok, data }) => {
        if (!active) return;
        const latLngs = extractRingLatLngs(data?.geometry);
        if (!ok || !latLngs) {
          setPotreroStatus('error');
          return;
        }
        setPotreroBounds(latLngs);
        setPotreroFeature({ type: 'Feature', properties: {}, geometry: data.geometry });
        setPotreroStatus('ready');
      })
      .catch(() => {
        if (active) setPotreroStatus('error');
      });

    return () => {
      active = false;
    };
  }, [predioId, potreroId]);

  if (potreroStatus === 'loading') {
    return <div className="gan-potrero-card-map-loading">Cargando mapa...</div>;
  }

  if (potreroStatus !== 'ready' || !potreroBounds || !potreroFeature) {
    return <div className="gan-potrero-card-map-loading">{MAP_ERROR_MESSAGE}</div>;
  }

  // El contexto del predio es puramente visual -- una geometry ausente o
  // inválida en la prop nunca bloquea el mapa del potrero (§4 del sprint).
  const predioLatLngs = extractRingLatLngs(predioGeometry);
  const predioFeature = predioLatLngs ? { type: 'Feature', properties: {}, geometry: predioGeometry } : null;

  return (
    <div className="gan-potrero-card-map">
      <MapContainer
        bounds={potreroBounds}
        boundsOptions={{ padding: [24, 24] }}
        dragging={false}
        scrollWheelZoom={false}
        doubleClickZoom={false}
        touchZoom={false}
        zoomControl={false}
        attributionControl={false}
        className="gan-potrero-card-map-canvas"
      >
        <TileLayer url={SATELLITE_TILE_URL} />
        {predioFeature ? <GeoJSON key="predio-base" data={predioFeature} style={PREDIO_STYLE} /> : null}
        <GeoJSON key="potrero" data={potreroFeature} style={POTRERO_STYLE} />
      </MapContainer>
    </div>
  );
}
