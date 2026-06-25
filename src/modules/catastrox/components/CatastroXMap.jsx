import { MapPinned } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import {
  CircleMarker,
  GeoJSON,
  MapContainer,
  Popup,
  TileLayer,
  useMap,
  useMapEvents,
} from 'react-leaflet';
import { CATASTROX_STATUS } from '../data/catastroxMockData.js';

function getMapTone(status) {
  if (
    status === CATASTROX_STATUS.FISCAL ||
    status === CATASTROX_STATUS.REVISION_ESPECIAL ||
    status === CATASTROX_STATUS.POSIBLE_PREDIO_FISCAL
  ) {
    return 'is-danger';
  }

  if (
    status === CATASTROX_STATUS.INCONSISTENCIA ||
    status === CATASTROX_STATUS.NO_PREDIO_INDIVIDUALIZADO ||
    status === CATASTROX_STATUS.SIN_COBERTURA_CATASTRAL ||
    status === CATASTROX_STATUS.PENDIENTE_VALIDACION
  ) {
    return 'is-warning';
  }

  return 'is-success';
}

function buildLatLng(coords) {
  const lat = Number.parseFloat(coords?.lat);
  const lng = Number.parseFloat(coords?.lng);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return [lat, lng];
}

function SearchMapEvents({ onCoordinateSelect }) {
  useMapEvents({
    click(event) {
      onCoordinateSelect({
        lat: event.latlng.lat.toFixed(6),
        lng: event.latlng.lng.toFixed(6),
      });
    },
  });

  return null;
}

function SearchMapViewport({ activePosition }) {
  const map = useMap();

  useEffect(() => {
    if (!activePosition) return;
    map.flyTo(activePosition, Math.max(map.getZoom(), 16), { duration: 1.1 });
  }, [activePosition, map]);

  return null;
}

function ResultMapViewport({ geoJson, fallbackPosition }) {
  const map = useMap();

  useEffect(() => {
    const geometry = geoJson?.geometry;
    const firstRing =
      geometry?.type === 'Polygon'
        ? geometry.coordinates?.[0]
        : geometry?.type === 'MultiPolygon'
          ? geometry.coordinates?.[0]?.[0]
          : null;

    if (firstRing?.length) {
      const latLngs = firstRing.map(([lng, lat]) => [lat, lng]);
      map.fitBounds(latLngs, { padding: [28, 28] });
      return;
    }

    if (fallbackPosition) {
      map.flyTo(fallbackPosition, 15, { duration: 1.1 });
    }
  }, [fallbackPosition, geoJson, map]);

  return null;
}

function sanitizeDisplayText(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function buildLocationLabel(predio) {
  const municipio = sanitizeDisplayText(predio?.municipio);
  const departamento = sanitizeDisplayText(predio?.departamento);

  if (municipio && departamento) return `${municipio}-${departamento}`;
  if (municipio) return municipio;
  if (departamento) return departamento;
  return 'Caquetá';
}

function getResultMapLabel(predio) {
  if (!predio) {
    return {
      eyebrow: 'VISTA PRELIMINAR DEL PREDIO',
      title: 'Caquetá',
    };
  }

  if (predio.estado === CATASTROX_STATUS.REVISION_ESPECIAL) {
    return {
      eyebrow: 'REVISIÓN ESPECIAL REQUERIDA',
      title: buildLocationLabel(predio),
    };
  }

  if (
    predio.estado === CATASTROX_STATUS.SIN_COBERTURA_CATASTRAL ||
    predio.estado === CATASTROX_STATUS.PENDIENTE_VALIDACION
  ) {
    return {
      eyebrow: 'COBERTURA PENDIENTE DE VALIDACIÓN',
      title: buildLocationLabel(predio),
    };
  }

  if (predio.estado === CATASTROX_STATUS.NO_PREDIO_INDIVIDUALIZADO) {
    return {
      eyebrow: 'SIN PREDIO INDIVIDUALIZADO',
      title: buildLocationLabel(predio),
    };
  }

  return {
    eyebrow: 'VISTA PRELIMINAR DEL PREDIO',
    title: buildLocationLabel(predio),
  };
}

export default function CatastroXMap({
  mode = 'result',
  coordinates,
  onCoordinateSelect,
  predio,
}) {
  const markerPosition =
    buildLatLng(predio?.queryPoint) ||
    buildLatLng(coordinates) ||
    (predio ? [predio.referencePoint.lat, predio.referencePoint.lng] : [1.331245, -75.87211]);
  const viewportPosition =
    buildLatLng(coordinates) ||
    buildLatLng(predio?.queryPoint) ||
    (predio ? [predio.referencePoint.lat, predio.referencePoint.lng] : [1.331245, -75.87211]);
  const polygonGeoJson = predio?.polygonGeoJson ?? null;
  const [mapReady, setMapReady] = useState(false);
  const mapLabel = getResultMapLabel(predio);

  const polygonStyle = useMemo(() => {
    if (
      predio?.estado === CATASTROX_STATUS.FISCAL ||
      predio?.estado === CATASTROX_STATUS.REVISION_ESPECIAL ||
      predio?.estado === CATASTROX_STATUS.POSIBLE_PREDIO_FISCAL
    ) {
      return {
        color: '#ff6262',
        weight: 2,
        fillColor: '#ff6262',
        fillOpacity: 0.22,
      };
    }

    if (
      predio?.estado === CATASTROX_STATUS.INCONSISTENCIA ||
      predio?.estado === CATASTROX_STATUS.NO_PREDIO_INDIVIDUALIZADO ||
      predio?.estado === CATASTROX_STATUS.SIN_COBERTURA_CATASTRAL ||
      predio?.estado === CATASTROX_STATUS.PENDIENTE_VALIDACION
    ) {
      return {
        color: '#ffd600',
        weight: 2,
        fillColor: '#ffd600',
        fillOpacity: 0.18,
      };
    }

    return {
      color: '#9cff1a',
      weight: 2,
      fillColor: '#00d8ff',
      fillOpacity: 0.18,
    };
  }, [predio?.estado]);

  return (
    <div className={`catastrox-map ${getMapTone(predio?.estado)} ${mode === 'result' ? 'has-footer' : ''}`}>
      <div className="catastrox-map-canvas">
        <MapContainer
          center={viewportPosition}
          zoom={mode === 'search' ? 14 : 15}
          scrollWheelZoom
          className="catastrox-leaflet-map"
          whenReady={() => setMapReady(true)}
        >
          <TileLayer
            attribution="Tiles &copy; Esri"
            url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
          />
          <TileLayer
            attribution="Labels &copy; Esri"
            url="https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}"
          />

          {mode === 'search' ? <SearchMapEvents onCoordinateSelect={onCoordinateSelect} /> : null}
          {mode === 'search' ? <SearchMapViewport activePosition={viewportPosition} /> : null}
          {mode === 'result' ? <ResultMapViewport geoJson={polygonGeoJson} fallbackPosition={viewportPosition} /> : null}

          {markerPosition ? (
            <CircleMarker
              center={markerPosition}
              radius={10}
              pathOptions={{
                color: '#ffffff',
                weight: 2,
                fillColor: mode === 'search' ? '#00d8ff' : '#9cff1a',
                fillOpacity: 0.92,
              }}
            >
              <Popup>
                <strong>{mode === 'search' ? 'Ubicación seleccionada' : predio?.municipio ?? 'Predio'}</strong>
                <br />
                Lat: {markerPosition[0].toFixed(6)}
                <br />
                Lng: {markerPosition[1].toFixed(6)}
              </Popup>
            </CircleMarker>
          ) : null}

          {mode === 'result' && polygonGeoJson ? <GeoJSON data={polygonGeoJson} style={polygonStyle} /> : null}
        </MapContainer>

        {!mapReady ? (
          <div className="catastrox-map-loading">
            <MapPinned size={22} />
            <span>Cargando mapa predial...</span>
          </div>
        ) : null}
      </div>

      {mode === 'result' ? (
        <div className="catastrox-map-label">
          <small>{mapLabel.eyebrow}</small>
          <strong>{mapLabel.title}</strong>
        </div>
      ) : null}
    </div>
  );
}
