import React, { useEffect, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';

// Token oficial de AgroGenomaX
mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN;

const RONDA_HIDRICA_TILESET = 'mapbox://agrogenomax.4eb1ph5w';
const RONDA_HIDRICA_SOURCE_LAYER = 'Ronda_Hidrica_Caqueta-7wmye6';

const LEY2_TILESET = 'mapbox://agrogenomax.cxix9dvs';
const LEY2_SOURCE_LAYER = 'ley_2_colombia_simplificada-dbv6on';

function GisMap({ compact = false }) {

  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);
  const userMarkerRef = useRef(null);

  const [mapStyle, setMapStyle] = useState(
    'mapbox://styles/agrogenomax/cmpo6hskr000601qtddjm5lhz'
  );

  const [showLey2, setShowLey2] = useState(true);
  const [showRondaHidrica, setShowRondaHidrica] = useState(true);
  const [isLocating, setIsLocating] = useState(false);
  const [coordInput, setCoordInput] = useState('');

  // =====================================================
  // CONSULTA MANUAL DE COORDENADAS
  // =====================================================

  const handleManualQuery = (e) => {

    e.preventDefault();

    if (!coordInput.trim()) {
      alert('Por favor, ingresa las coordenadas.');
      return;
    }

    let parts = coordInput.split(/[\s,]+/);

    if (parts.length < 2) {
      alert('Formato inválido.');
      return;
    }

    const lat = parseFloat(parts[0]);
    const lng = parseFloat(parts[1]);

    if (
      isNaN(lat) ||
      isNaN(lng) ||
      Math.abs(lat) > 90 ||
      Math.abs(lng) > 180
    ) {
      alert('Coordenadas inválidas.');
      return;
    }

    if (mapRef.current) {

      mapRef.current.flyTo({
        center: [lng, lat],
        zoom: 15,
        essential: true
      });

      if (!userMarkerRef.current) {

        const el = document.createElement('div');
        el.className = 'user-gps-marker';

        userMarkerRef.current = new mapboxgl.Marker(el)
          .setLngLat([lng, lat])
          .setPopup(
            new mapboxgl.Popup({ offset: 25 }).setHTML(`
              <span class="font-mono text-xs text-center block">
                <b>Predio Consultado</b><br/>
                Lat: ${lat}<br/>
                Lng: ${lng}
              </span>
            `)
          )
          .addTo(mapRef.current);

      } else {

        userMarkerRef.current.setLngLat([lng, lat]);

      }

    }

  };

  // =====================================================
  // GEOLOCALIZACIÓN GPS
  // =====================================================

  const handleGeolocate = () => {

    if (!navigator.geolocation) {
      alert('Tu navegador no soporta GPS.');
      return;
    }

    setIsLocating(true);

    navigator.geolocation.getCurrentPosition(

      (position) => {

        const { longitude, latitude } = position.coords;

        if (mapRef.current) {

          mapRef.current.flyTo({
            center: [longitude, latitude],
            zoom: 14,
            essential: true
          });

          if (!userMarkerRef.current) {

            const el = document.createElement('div');
            el.className = 'user-gps-marker';

            userMarkerRef.current = new mapboxgl.Marker(el)
              .setLngLat([longitude, latitude])
              .setPopup(
                new mapboxgl.Popup({ offset: 25 }).setHTML(
                  '<span class="font-mono text-xs">Tu ubicación actual</span>'
                )
              )
              .addTo(mapRef.current);

          } else {

            userMarkerRef.current.setLngLat([longitude, latitude]);

          }

        }

        setIsLocating(false);

      },

      (error) => {

        console.error(error);

        alert('No se pudo acceder al GPS.');

        setIsLocating(false);

      },

      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 0
      }

    );

  };

  // =====================================================
  // MAPA PRINCIPAL
  // =====================================================

  useEffect(() => {

    mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN;

    const map = new mapboxgl.Map({

      container: mapContainerRef.current,
      style: mapStyle,
      center: [-75.6062, 1.6144],
      zoom: 10,
      pitch: 15

    });

    mapRef.current = map;

    map.addControl(
      new mapboxgl.NavigationControl({ showCompass: false }),
      'top-right'
    );

    map.addControl(
      new mapboxgl.ScaleControl({ unit: 'metric' }),
      'bottom-left'
    );

    map.on('load', () => {

      // =====================================================
      // SOURCE LEY 2
      // =====================================================

      map.addSource('source-ley2', {
        type: 'vector',
        url: LEY2_TILESET
      });

      // =====================================================
      // CAPA LEY 2
      // =====================================================

      map.addLayer({

        id: 'capa-ley2-relleno',
        type: 'fill',
        source: 'source-ley2',
        'source-layer': LEY2_SOURCE_LAYER,

        layout: {
          visibility: showLey2 ? 'visible' : 'none'
        },

        paint: {

          'fill-color': [
            'match',
            ['get', 'uab_tipo_z'],
            24, '#e1c124',
            25, '#df0101',
            27, '#24a138',
            26, '#b55fb5',
            '#808080'
          ],

          'fill-opacity': 0.35

        }

      });

      // =====================================================
      // SOURCE RONDA HÍDRICA
      // =====================================================

      map.addSource('source-ronda-hidrica-caqueta', {
        type: 'vector',
        url: RONDA_HIDRICA_TILESET
      });

      // =====================================================
      // CAPA RONDA HÍDRICA RELLENO
      // =====================================================

      map.addLayer({

        id: 'capa-ronda-hidrica-caqueta-relleno',
        type: 'fill',
        source: 'source-ronda-hidrica-caqueta',
        'source-layer': RONDA_HIDRICA_SOURCE_LAYER,

        layout: {
          visibility: showRondaHidrica ? 'visible' : 'none'
        },

        paint: {
          'fill-color': '#00d8ff',
          'fill-opacity': 0.2
        }

      });

      // =====================================================
      // BORDE RONDA HÍDRICA
      // =====================================================

      map.addLayer({

        id: 'capa-ronda-hidrica-caqueta-borde',
        type: 'line',
        source: 'source-ronda-hidrica-caqueta',
        'source-layer': RONDA_HIDRICA_SOURCE_LAYER,

        layout: {
          visibility: showRondaHidrica ? 'visible' : 'none'
        },

        paint: {

          'line-color': '#00d8ff',

          'line-opacity': 0.95,

          'line-width': [
            'interpolate',
            ['linear'],
            ['zoom'],
            8, 1.1,
            13, 2.6,
            16, 4
          ]

        }

      });

    });

    return () => {

      if (userMarkerRef.current) {
        userMarkerRef.current.remove();
      }

      map.remove();

    };

  }, [mapStyle]);

  // =====================================================
  // TOGGLE LEY 2
  // =====================================================

  useEffect(() => {

    if (
      mapRef.current &&
      mapRef.current.getLayer('capa-ley2-relleno')
    ) {

      mapRef.current.setLayoutProperty(
        'capa-ley2-relleno',
        'visibility',
        showLey2 ? 'visible' : 'none'
      );

    }

  }, [showLey2]);

  // =====================================================
  // TOGGLE RONDA HÍDRICA
  // =====================================================

  useEffect(() => {

    if (!mapRef.current) return;

    [
      'capa-ronda-hidrica-caqueta-relleno',
      'capa-ronda-hidrica-caqueta-borde'
    ].forEach((layerId) => {

      if (mapRef.current.getLayer(layerId)) {

        mapRef.current.setLayoutProperty(
          layerId,
          'visibility',
          showRondaHidrica ? 'visible' : 'none'
        );

      }

    });

  }, [showRondaHidrica]);

  // =====================================================
  // UI
  // =====================================================

  return (

    <div className={`mapbox-shell ${compact ? 'mapbox-shell-compact' : 'mapbox-shell-full'}`}>

      <div
        ref={mapContainerRef}
        className="mapbox-canvas-host"
      />

      <button
        onClick={handleGeolocate}
        className="absolute top-4 left-4 z-50 bg-black text-white px-3 py-2 rounded"
      >
        {isLocating ? 'Buscando GPS...' : 'Mi ubicación'}
      </button>

      <div className="absolute top-20 left-4 z-50 bg-black/80 p-3 rounded">

        <input
          type="text"
          value={coordInput}
          onChange={(e) => setCoordInput(e.target.value)}
          placeholder="Latitud, Longitud"
          className="text-black px-2 py-1 rounded w-56"
        />

        <button
          onClick={handleManualQuery}
          className="ml-2 bg-cyan-500 text-white px-3 py-1 rounded"
        >
          Consultar
        </button>

      </div>

      <style>{`

        .user-gps-marker {
          width: 16px;
          height: 16px;
          background-color: #007aff;
          border: 3px solid white;
          border-radius: 50%;
          box-shadow: 0 0 10px rgba(0,122,255,0.6);
          animation: pulseGps 2s infinite;
          cursor: pointer;
        }

        @keyframes pulseGps {

          0% {
            box-shadow: 0 0 0 0 rgba(0,122,255,0.7);
          }

          70% {
            box-shadow: 0 0 0 12px rgba(0,122,255,0);
          }

          100% {
            box-shadow: 0 0 0 0 rgba(0,122,255,0);
          }

        }

      `}</style>

    </div>

  );

}

export default GisMap;