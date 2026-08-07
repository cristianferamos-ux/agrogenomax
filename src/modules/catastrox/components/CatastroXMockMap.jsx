import L from 'leaflet';
import { useEffect, useState } from 'react';
import { GeoJSON, MapContainer, TileLayer, useMap } from 'react-leaflet';
import CatastroXMap from './CatastroXMap.jsx';

const FISCAL_REVIEW_STATUSES = new Set(['PREDIO_FISCAL', 'POSIBLE_PREDIO_FISCAL', 'REVISION_ESPECIAL']);

function PreviewViewport({ geometry }) {
  const map = useMap();

  useEffect(() => {
    if (!geometry) return undefined;

    const layer = L.geoJSON(geometry);
    const bounds = layer.getBounds();
    if (!bounds.isValid()) return undefined;

    // Zoom urbano dinamico: fitBounds ajusta al bounding box real del predio. El tope se
    // elevo de 17 a 18 (antes insuficiente para lotes de pocos metros de lado). Se probo
    // subir hasta 21 pero el proveedor de teselas (Esri World_Imagery) devuelve "Map data
    // not yet available" para zonas rurales/urbanas pequenas de Caqueta a partir de zoom 19;
    // 18 es el maximo que carga imagenes reales de forma consistente en las tres cabeceras
    // urbanas probadas (Puerto Rico, La Montanita, Valparaiso).
    const syncPreview = () => {
      map.invalidateSize(false);
      map.fitBounds(bounds, { padding: [28, 28], animate: false, maxZoom: 18 });
    };

    syncPreview();
    const timeoutId = window.setTimeout(syncPreview, 0);
    return () => window.clearTimeout(timeoutId);
  }, [geometry, map]);

  return null;
}

function SatellitePreviewMap({ predio }) {
  const [previewGeometry, setPreviewGeometry] = useState(null);
  const [previewStatus, setPreviewStatus] = useState('loading');

  useEffect(() => {
    let cancelled = false;

    async function loadPreviewGeometry() {
      if (!predio?.previewGeometryUrl) {
        setPreviewStatus('unavailable');
        return;
      }

      try {
        setPreviewStatus('loading');
        const response = await fetch(predio.previewGeometryUrl);
        if (!response.ok) throw new Error('preview_unavailable');
        const payload = await response.json();
        if (!payload?.geometry) throw new Error('preview_unavailable');
        if (!cancelled) {
          setPreviewGeometry(payload.geometry);
          setPreviewStatus('ready');
        }
      } catch {
        if (!cancelled) {
          setPreviewGeometry(null);
          setPreviewStatus('unavailable');
        }
      }
    }

    loadPreviewGeometry();
    return () => {
      cancelled = true;
    };
  }, [predio?.previewGeometryUrl]);

  if (previewStatus === 'unavailable') {
    return (
      <div className="catastrox-protected-preview-frame">
        {predio?.previewMapUrl ? (
          <img src={predio.previewMapUrl} alt="Predio identificado" />
        ) : (
          <div className="catastrox-map-loading">
            <span>Predio identificado.</span>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="catastrox-protected-preview-frame">
      <MapContainer
        center={[4.5709, -74.2973]}
        zoom={5}
        maxZoom={18}
        scrollWheelZoom={false}
        dragging={false}
        doubleClickZoom={false}
        zoomControl={false}
        attributionControl={false}
        className="catastrox-preview-leaflet-map"
      >
        <TileLayer
          attribution="Tiles &copy; Esri"
          url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
          maxZoom={18}
        />
        {previewGeometry ? <PreviewViewport geometry={previewGeometry} /> : null}
        {previewGeometry ? (
          <>
            <GeoJSON
              data={previewGeometry}
              style={{
                color: '#00d8ff',
                weight: 8,
                opacity: 0.5,
                fillOpacity: 0,
              }}
              interactive={false}
            />
            <GeoJSON
              data={previewGeometry}
              style={{
                color: '#d7ff3f',
                weight: 4,
                fillColor: '#9cff1a',
                fillOpacity: 0.22,
              }}
              interactive={false}
            />
          </>
        ) : null}
      </MapContainer>
      {previewStatus === 'loading' ? (
        <div className="catastrox-map-loading">
          <span>Cargando imagen satelital...</span>
        </div>
      ) : null}
    </div>
  );
}

export default function CatastroXMockMap({ predio }) {
  if (predio?.previewGeometryUrl || predio?.previewMapUrl) {
    return (
      <article className="catastrox-card catastrox-protected-preview">
        <div className="catastrox-section-heading">
          <span>Vista satelital</span>
          <h2>Predio identificado</h2>
        </div>
        <SatellitePreviewMap predio={predio} />
        <p className="catastrox-copy">
          {predio?.previewMessage || 'Predio identificado sobre imagen satelital.'}
        </p>
        <p className="catastrox-note">
          {FISCAL_REVIEW_STATUSES.has(predio?.estado)
            ? 'La información técnica detallada se habilitará únicamente después de la validación especializada del caso.'
            : 'El área, perímetro, códigos y archivos técnicos se habilitan dentro del paquete seleccionado.'}
        </p>
      </article>
    );
  }

  if (!predio?.polygonGeoJson) {
    return (
      <article className="catastrox-card">
        <div className="catastrox-section-heading">
          <span>Vista previa protegida</span>
          <h2>Predio identificado</h2>
        </div>
        <p className="catastrox-copy">
          {predio?.previewMessage || 'Predio identificado. Vista previa cartográfica en preparación.'}
        </p>
        <p className="catastrox-note">
          El área, perímetro, códigos prediales y geometría se habilitan únicamente dentro del paquete seleccionado.
        </p>
      </article>
    );
  }

  return <CatastroXMap mode="result" predio={predio} />;
}
