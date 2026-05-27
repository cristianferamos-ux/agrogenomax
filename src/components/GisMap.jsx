import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import ley2Url from '../data/ley_2_colombia_simplificada.geojson?url';
import rondaUrl from '../data/Ronda_Hidrica_Caqueta.geojson?url';

const COLOMBIA_BOUNDS = [
  [-4.05, -79.01],
  [11.34, -66.85],
];

const LEY_2_ZONES = {
  25: { label: 'Zona A', color: '#ef4444' },
  24: { label: 'Zona B', color: '#facc15' },
  27: { label: 'Zona C', color: '#22c55e' },
  26: { label: 'Área de previa decisión', color: '#d946ef' },
};

const LEY_2_LEGEND_ORDER = [25, 24, 27, 26];

const getLey2Zone = (feature) => {
  const code = Number(feature?.properties?.uab_tipo_z);
  return LEY_2_ZONES[code] ?? { label: 'Zona sin clasificar', color: '#94a3b8' };
};

const createLey2Legend = () => {
  const legend = L.control({ position: 'bottomright' });

  legend.onAdd = () => {
    const container = L.DomUtil.create('div', 'gis-legend');
    const zones = LEY_2_LEGEND_ORDER
      .map((code) => LEY_2_ZONES[code])
      .map(
        (zone) => `
          <div>
            <span style="background:${zone.color}"></span>
            ${zone.label}
          </div>
        `,
      )
      .join('');

    container.innerHTML = `<h4>Ley 2 de 1959</h4>${zones}`;
    return container;
  };

  return legend;
};

const createRondaLegend = () => {
  const legend = L.control({ position: 'bottomright' });

  legend.onAdd = () => {
    const container = L.DomUtil.create('div', 'gis-legend');

    container.innerHTML = `
      <h4>Ronda hídrica Caquetá</h4>
      <div>
        <span style="background:#00bfff"></span>
        Franja de protección 30 m
      </div>
    `;

    return container;
  };

  return legend;
};

function GisMap() {
  const mapContainer = useRef(null);
  const map = useRef(null);
  const markerRef = useRef(null);

  const [coordInput, setCoordInput] = useState('');
  const [isLocating, setIsLocating] = useState(false);
  const [mapError, setMapError] = useState('');

  useEffect(() => {
    if (!mapContainer.current || map.current) return undefined;

    const mapInstance = L.map(mapContainer.current, {
      center: [2.5, -74.5],
      zoom: 6,
      zoomControl: true,
      dragging: true,
      touchZoom: true,
      scrollWheelZoom: true,
      doubleClickZoom: true,
      boxZoom: true,
      keyboard: true,
      attributionControl: true,
      wheelPxPerZoomLevel: 80,
    });

    map.current = mapInstance;

    mapInstance.dragging.enable();
    mapInstance.touchZoom.enable();
    mapInstance.scrollWheelZoom.enable();
    mapInstance.doubleClickZoom.enable();
    mapInstance.boxZoom.enable();
    mapInstance.keyboard.enable();

    const mapElement = mapInstance.getContainer();
    mapElement.style.pointerEvents = 'auto';
    mapElement.style.touchAction = 'none';
    mapElement.style.cursor = 'grab';

    const mapPane = mapInstance.getPane('mapPane');
    const tilePane = mapInstance.getPane('tilePane');

    if (mapPane) {
      mapPane.style.pointerEvents = 'auto';
      mapPane.style.cursor = 'grab';
    }

    if (tilePane) {
      tilePane.style.pointerEvents = 'auto';
      tilePane.style.cursor = 'grab';
    }

    const setDraggingCursor = () => {
      mapElement.style.cursor = 'grabbing';

      if (mapPane) mapPane.style.cursor = 'grabbing';
      if (tilePane) tilePane.style.cursor = 'grabbing';
    };

    const setGrabCursor = () => {
      mapElement.style.cursor = 'grab';

      if (mapPane) mapPane.style.cursor = 'grab';
      if (tilePane) tilePane.style.cursor = 'grab';
    };

    mapInstance.on('dragstart', setDraggingCursor);
    mapInstance.on('dragend', setGrabCursor);
    mapInstance.on('zoomend', setGrabCursor);

    mapInstance.createPane('dragPane');

    const dragPane = mapInstance.getPane('dragPane');

    if (dragPane) {
      dragPane.style.zIndex = 350;
      dragPane.style.pointerEvents = 'auto';
      dragPane.style.cursor = 'grab';
    }

    const detailedLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
    });

    const satelliteImageryLayer = L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      {
        maxZoom: 19,
        attribution: 'Tiles &copy; Esri',
      },
    );

    const satelliteLabelsLayer = L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
      {
        maxZoom: 19,
        attribution: 'Labels &copy; Esri',
      },
    );

    const satelliteRoadsLayer = L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}',
      {
        maxZoom: 19,
        attribution: 'Transportation &copy; Esri',
      },
    );

    const satelliteLayer = L.layerGroup([
      satelliteImageryLayer,
      satelliteRoadsLayer,
      satelliteLabelsLayer,
    ]);

    detailedLayer.addTo(mapInstance);

    const dragSurface = L.rectangle(
      [
        [-90, -180],
        [90, 180],
      ],
      {
        pane: 'dragPane',
        interactive: true,
        bubblingMouseEvents: true,
        className: 'gis-drag-surface',
        stroke: false,
        fill: true,
        fillColor: '#000000',
        fillOpacity: 0.001,
      },
    ).addTo(mapInstance);

    const ley2Layer = L.geoJSON(null, {
      style: (feature) => {
        const zone = getLey2Zone(feature);

        return {
          color: zone.color,
          weight: 1,
          fillColor: zone.color,
          fillOpacity: 0.42,
        };
      },
      onEachFeature: (feature, layer) => {
        const area = feature?.properties?.area_ha || 'N/A';
        const code = feature?.properties?.uab_tipo_z || 'N/A';
        const zone = getLey2Zone(feature);

        layer.bindPopup(`
          <strong>Ley 2 de 1959</strong><br/>
          ${zone.label}<br/>
          Código: ${code}<br/>
          Área: ${area} ha
        `);
      },
    }).addTo(mapInstance);

    const ley2Legend = createLey2Legend();

    const rondaLayer = L.geoJSON(null, {
      style: {
        color: '#00ffff',
        weight: 1,
        fillColor: '#00bfff',
        fillOpacity: 0.35,
      },
      onEachFeature: (feature, layer) => {
        const area = feature?.properties?.area_ha || 'N/A';
        layer.bindPopup(`<strong>Ronda hídrica</strong><br/>Área: ${area} ha`);
      },
    }).addTo(mapInstance);

    const rondaLegend = createRondaLegend();

    L.control
      .layers(
        {
          'Mapa detallado': detailedLayer,
          'Satelital con nombres': satelliteLayer,
        },
        {
          'Ley 2 de 1959': ley2Layer,
          'Ronda hídrica': rondaLayer,
        },
        {
          collapsed: false,
        },
      )
      .addTo(mapInstance);

    const syncLegends = () => {
      if (mapInstance.hasLayer(ley2Layer)) {
        ley2Legend.addTo(mapInstance);
      } else {
        ley2Legend.remove();
      }

      if (mapInstance.hasLayer(rondaLayer)) {
        rondaLegend.addTo(mapInstance);
      } else {
        rondaLegend.remove();
      }
    };

    mapInstance.on('overlayadd', syncLegends);
    mapInstance.on('overlayremove', syncLegends);
    syncLegends();

    L.control
      .scale({
        imperial: false,
        metric: true,
      })
      .addTo(mapInstance);

    const loadLayer = async (url, layer) => {
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`No se pudo cargar ${url}`);
      }

      layer.addData(await response.json());
    };

    Promise.all([loadLayer(ley2Url, ley2Layer), loadLayer(rondaUrl, rondaLayer)])
      .then(() => {
        const group = L.featureGroup([ley2Layer, rondaLayer]);
        const bounds = group.getBounds();

        if (bounds.isValid()) {
          mapInstance.fitBounds(bounds, { padding: [24, 24] });
        } else {
          mapInstance.fitBounds(COLOMBIA_BOUNDS, { padding: [24, 24] });
        }
      })
      .catch((error) => {
        console.error(error);
        setMapError('No se pudieron cargar las capas GIS locales.');
        mapInstance.fitBounds(COLOMBIA_BOUNDS, { padding: [24, 24] });
      });

    const resizeObserver = new ResizeObserver(() => {
      mapInstance.invalidateSize();
    });

    resizeObserver.observe(mapContainer.current);

    window.setTimeout(() => {
      mapInstance.invalidateSize();
    }, 250);

    return () => {
      resizeObserver.disconnect();
      dragSurface.remove();
      mapInstance.off('dragstart', setDraggingCursor);
      mapInstance.off('dragend', setGrabCursor);
      mapInstance.off('zoomend', setGrabCursor);
      mapInstance.off('overlayadd', syncLegends);
      mapInstance.off('overlayremove', syncLegends);
      ley2Legend.remove();
      rondaLegend.remove();
      markerRef.current?.remove();
      markerRef.current = null;
      mapInstance.remove();
      map.current = null;
    };
  }, []);

  const flyToLocation = (lat, lng, title = 'Predio consultado') => {
    if (!map.current) return;

    const latLng = [lat, lng];

    map.current.flyTo(latLng, 16);

    if (!markerRef.current) {
      markerRef.current = L.marker(latLng, {
        icon: L.divIcon({
          className: 'gps-location-marker',
          html: '<span class="gps-location-pin"><span></span></span>',
          iconSize: [36, 46],
          iconAnchor: [18, 42],
          popupAnchor: [0, -38],
        }),
      })
        .bindPopup(`<strong>${title}</strong><br/>Lat: ${lat}<br/>Lng: ${lng}`)
        .addTo(map.current);
    } else {
      markerRef.current.setLatLng(latLng);
      markerRef.current.setPopupContent(`<strong>${title}</strong><br/>Lat: ${lat}<br/>Lng: ${lng}`);
    }

    markerRef.current.openPopup();
  };

  const handleGeolocate = () => {
    if (!navigator.geolocation) {
      window.alert('GPS no soportado');
      return;
    }

    setIsLocating(true);

    navigator.geolocation.getCurrentPosition(
      (position) => {
        flyToLocation(position.coords.latitude, position.coords.longitude, 'Mi ubicación actual');
        setIsLocating(false);
      },
      (error) => {
        console.error(error);
        window.alert('No se pudo obtener la ubicación');
        setIsLocating(false);
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
      },
    );
  };

  const handleManualQuery = (event) => {
    event.preventDefault();

    if (!coordInput.trim()) {
      window.alert('Ingresa coordenadas');
      return;
    }

    const parts = coordInput.split(/[\s,]+/);

    if (parts.length < 2) {
      window.alert('Formato inválido');
      return;
    }

    const lat = parseFloat(parts[0]);
    const lng = parseFloat(parts[1]);

    if (Number.isNaN(lat) || Number.isNaN(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      window.alert('Coordenadas inválidas');
      return;
    }

    flyToLocation(lat, lng, 'Predio consultado');
  };

  return (
    <div className="gis-mapbox">
      <div className="gis-mapbox-canvas">
        <div ref={mapContainer} className="gis-mapbox-host" />
        {mapError ? <div className="gis-mapbox-error">{mapError}</div> : null}
      </div>

      <div className="gis-mapbox-panel">
        <button type="button" onClick={handleGeolocate} disabled={isLocating}>
          {isLocating ? 'Buscando GPS...' : 'Ubicarme en el mapa'}
        </button>

        <form onSubmit={handleManualQuery}>
          <input
            type="text"
            value={coordInput}
            onChange={(event) => setCoordInput(event.target.value)}
            placeholder="Latitud, Longitud"
          />
          <button type="submit">Consultar</button>
        </form>
      </div>
    </div>
  );
}

export default GisMap;
