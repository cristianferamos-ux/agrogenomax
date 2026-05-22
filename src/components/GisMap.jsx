import { MapContainer, Marker, Polygon, Popup, TileLayer, LayersControl, CircleMarker } from 'react-leaflet';
import { divIcon } from 'leaflet';
import 'leaflet/dist/leaflet.css';

const center = [4.64, -74.08];

const ranchPolygons = [
  {
    name: 'Predio Genesis Norte',
    status: 'Libre de deforestacion',
    score: '94%',
    color: '#9cff1a',
    positions: [
      [4.665, -74.118],
      [4.686, -74.091],
      [4.671, -74.055],
      [4.637, -74.061],
      [4.626, -74.101],
    ],
  },
  {
    name: 'Unidad Silvopastoril X-12',
    status: 'Regeneracion activa',
    score: '81%',
    color: '#00d8ff',
    positions: [
      [4.621, -74.12],
      [4.642, -74.094],
      [4.626, -74.058],
      [4.594, -74.073],
      [4.591, -74.107],
    ],
  },
  {
    name: 'Corredor Biologico Sur',
    status: 'Cobertura en expansion',
    score: '76%',
    color: '#ffffff',
    positions: [
      [4.608, -74.042],
      [4.634, -74.023],
      [4.617, -73.988],
      [4.583, -74.003],
      [4.578, -74.036],
    ],
  },
];

const monitoringPoints = [
  { name: 'Biodiversidad', type: 'BIO', value: 'Alta', position: [4.656, -74.088], color: '#9cff1a' },
  { name: 'Agua superficial', type: 'H2O', value: 'Estable', position: [4.618, -74.082], color: '#00d8ff' },
  { name: 'Alerta cobertura', type: 'NDVI', value: '0.72', position: [4.602, -74.025], color: '#ffffff' },
  { name: 'Trazabilidad lote', type: 'BOV', value: '100%', position: [4.641, -74.055], color: '#9cff1a' },
];

function markerIcon(color, label) {
  return divIcon({
    className: '',
    html: `<div class="gis-marker" style="--marker-color:${color}"><span>${label}</span></div>`,
    iconSize: [44, 44],
    iconAnchor: [22, 22],
  });
}

export default function GisMap() {
  return (
    <div className="gis-frame">
      <MapContainer center={center} zoom={12} minZoom={10} maxZoom={18} scrollWheelZoom className="gis-map">
        <LayersControl position="topright">
          <LayersControl.BaseLayer checked name="Satelital">
            <TileLayer
              attribution="Tiles &copy; Esri"
              url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
            />
          </LayersControl.BaseLayer>
          <LayersControl.BaseLayer name="Topografico">
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />
          </LayersControl.BaseLayer>

          <LayersControl.Overlay checked name="Poligonos de predios">
            <>
              {ranchPolygons.map((polygon) => (
                <Polygon
                  key={polygon.name}
                  positions={polygon.positions}
                  pathOptions={{
                    color: polygon.color,
                    weight: 2,
                    fillColor: polygon.color,
                    fillOpacity: 0.16,
                    dashArray: polygon.color === '#ffffff' ? '8 8' : undefined,
                  }}
                >
                  <Popup>
                    <strong>{polygon.name}</strong>
                    <br />
                    {polygon.status}
                    <br />
                    Score ambiental: {polygon.score}
                  </Popup>
                </Polygon>
              ))}
            </>
          </LayersControl.Overlay>

          <LayersControl.Overlay checked name="Puntos de monitoreo">
            <>
              {monitoringPoints.map((point) => (
                <Marker
                  key={point.name}
                  position={point.position}
                  icon={markerIcon(point.color, point.type)}
                >
                  <Popup>
                    <strong>{point.name}</strong>
                    <br />
                    Indicador: {point.value}
                  </Popup>
                </Marker>
              ))}
            </>
          </LayersControl.Overlay>

          <LayersControl.Overlay checked name="Zonas de alerta">
            <>
              <CircleMarker
                center={[4.63, -74.035]}
                radius={42}
                pathOptions={{ color: '#00d8ff', fillColor: '#00d8ff', fillOpacity: 0.09, weight: 1 }}
              />
              <CircleMarker
                center={[4.647, -74.103]}
                radius={34}
                pathOptions={{ color: '#9cff1a', fillColor: '#9cff1a', fillOpacity: 0.1, weight: 1 }}
              />
            </>
          </LayersControl.Overlay>
        </LayersControl>
      </MapContainer>

      <div className="gis-hud gis-hud-top">
        <span>AGX GIS LIVE</span>
        <strong>Satellite intelligence</strong>
      </div>
      <div className="gis-hud gis-hud-bottom">
        {[
          ['NDVI', '0.72'],
          ['Bosque', '38%'],
          ['Agua', 'OK'],
          ['Riesgo', 'Bajo'],
        ].map(([label, value]) => (
          <div key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </div>
    </div>
  );
}
