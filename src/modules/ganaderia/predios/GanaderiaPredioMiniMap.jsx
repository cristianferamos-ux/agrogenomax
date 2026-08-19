// SPRINT-3C4: mini vista satelital + polígono de un predio ya
// registrado, para la card de "Mis Predios Registrados".
//
// Componente PROPIO de Ganadería -- deliberadamente NO reutiliza
// CatastroXMap.jsx: ese componente es un mapa interactivo completo
// (click para buscar, scroll-zoom, popups, tonos ligados a
// CATASTROX_STATUS) pensado para una única vista de resultado, no para
// renderizar N miniaturas dentro de una grilla de cards. Sí reutiliza la
// infraestructura de tiles ya usada en CatastroX (Esri World_Imagery vía
// react-leaflet), sin importar nada de src/modules/catastrox --
// Ganadería no queda acoplada al módulo CatastroX.
//
// Fuente de la geometría: GET /api/ganaderia/predios/:predioId (mismo
// endpoint ya expuesto por server/routes/ganaderiaPredios.js, org-scoped
// vía RLS). La geometría cruda vive solo dentro de este componente para
// dibujar el polígono -- nunca se expone como texto/JSON en la card.
//
// Pensado como base futura: Gestión del Predio y Potreros reutilizarán
// el mismo patrón (fetch de geometry + tiles Esri) en una vista más
// grande e interactiva.
import { useEffect, useState } from 'react';
import { GeoJSON, MapContainer, TileLayer } from 'react-leaflet';

const SATELLITE_TILE_URL =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';

const POLYGON_STYLE = { color: '#9cff1a', weight: 2, fillColor: '#00d8ff', fillOpacity: 0.2 };

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

export default function GanaderiaPredioMiniMap({ predioId }) {
  const [status, setStatus] = useState('loading'); // loading | ready | unavailable
  const [bounds, setBounds] = useState(null);
  const [geoJsonFeature, setGeoJsonFeature] = useState(null);

  useEffect(() => {
    let active = true;
    setStatus('loading');

    fetch(`/api/ganaderia/predios/${predioId}`, { credentials: 'include' })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (!active) return;
        const latLngs = extractRingLatLngs(data?.geometry);
        if (!latLngs) {
          setStatus('unavailable');
          return;
        }
        setBounds(latLngs);
        setGeoJsonFeature({ type: 'Feature', properties: {}, geometry: data.geometry });
        setStatus('ready');
      })
      .catch(() => {
        if (active) setStatus('unavailable');
      });

    return () => {
      active = false;
    };
  }, [predioId]);

  if (status === 'loading') {
    return <div className="gan-predio-minimap gan-predio-minimap-loading">Cargando mapa...</div>;
  }

  if (status !== 'ready' || !bounds || !geoJsonFeature) {
    return null;
  }

  return (
    <div className="gan-predio-minimap">
      <MapContainer
        bounds={bounds}
        boundsOptions={{ padding: [6, 6] }}
        dragging={false}
        scrollWheelZoom={false}
        doubleClickZoom={false}
        touchZoom={false}
        zoomControl={false}
        attributionControl={false}
        className="gan-predio-minimap-canvas"
      >
        <TileLayer url={SATELLITE_TILE_URL} />
        <GeoJSON data={geoJsonFeature} style={POLYGON_STYLE} />
      </MapContainer>
    </div>
  );
}
