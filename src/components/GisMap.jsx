import React, { useEffect, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';

// ======================================================
// TOKEN MAPBOX
// ======================================================

mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN;

// ======================================================
// COMPONENTE
// ======================================================

function GisMap({ compact = false }) {

  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);
  const userMarkerRef = useRef(null);

  // ======================================================
  // ESTADOS
  // ======================================================

  const [mapStyle, setMapStyle] = useState(
    'mapbox://styles/mapbox/satellite-streets-v12'
  );

  const [coordInput, setCoordInput] = useState('');
  const [isLocating, setIsLocating] = useState(false);

  // ======================================================
  // CONSULTA MANUAL
  // ======================================================

  const handleManualQuery = (e) => {

    e.preventDefault();

    if (!coordInput.trim()) {
      alert('Ingresa coordenadas');
      return;
    }

    const parts = coordInput.split(/[\s,]+/);

    if (parts.length < 2) {
      alert('Formato inválido');
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
      alert('Coordenadas inválidas');
      return;
    }

    if (!mapRef.current) return;

    mapRef.current.flyTo({
      center: [lng, lat],
      zoom: 15,
      essential: true
    });

    // Marker

    if (!userMarkerRef.current) {

      const el = document.createElement('div');
      el.className = 'user-gps-marker';

      userMarkerRef.current = new mapboxgl.Marker(el)
        .setLngLat([lng, lat])
        .setPopup(
          new mapboxgl.Popup({ offset: 25 }).setHTML(`
            <div style="font-size:12px;">
              <b>Predio consultado</b><br/>
              Lat: ${lat}<br/>
              Lng: ${lng}
            </div>
          `)
        )
        .addTo(mapRef.current);

    } else {

      userMarkerRef.current.setLngLat([lng, lat]);

    }

  };

  // ======================================================
  // GEOLOCALIZACIÓN GPS
  // ======================================================

  const handleGeolocate = () => {

    if (!navigator.geolocation) {
      alert('Tu navegador no soporta GPS');
      return;
    }

    setIsLocating(true);

    navigator.geolocation.getCurrentPosition(

      (position) => {

        const { longitude, latitude } = position.coords;

        if (!mapRef.current) return;

        mapRef.current.flyTo({
          center: [longitude, latitude],
          zoom: 15,
          essential: true
        });

        if (!userMarkerRef.current) {

          const el = document.createElement('div');
          el.className = 'user-gps-marker';

          userMarkerRef.current = new mapboxgl.Marker(el)
            .setLngLat([longitude, latitude])
            .setPopup(
              new mapboxgl.Popup({ offset: 25 }).setHTML(`
                <div style="font-size:12px;">
                  Tu ubicación actual
                </div>
              `)
            )
            .addTo(mapRef.current);

        } else {

          userMarkerRef.current.setLngLat([longitude, latitude]);

        }

        setIsLocating(false);

      },

      (error) => {

        console.error(error);

        alert('No se pudo obtener ubicación');

        setIsLocating(false);

      },

      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 0
      }

    );

  };

  // ======================================================
  // MAPA PRINCIPAL
  // ======================================================

  useEffect(() => {

    if (!mapContainerRef.current) return;

    // Verificación token

    if (!mapboxgl.accessToken) {

      console.error('MAPBOX TOKEN NO CONFIGURADO');

      return;
    }

    const map = new mapboxgl.Map({

      container: mapContainerRef.current,

      style: mapStyle,

      center: [-75.6062, 1.6144],

      zoom: 9,

      pitch: 0,

      attributionControl: false

    });

    mapRef.current = map;

    // ======================================================
    // CONTROLES
    // ======================================================

    map.addControl(
      new mapboxgl.NavigationControl(),
      'top-right'
    );

    map.addControl(
      new mapboxgl.ScaleControl({
        unit: 'metric'
      }),
      'bottom-left'
    );

    // ======================================================
    // EVENTO LOAD
    // ======================================================

    map.on('load', () => {

      console.log('Mapa cargado correctamente');

    });

    // ======================================================
    // ERROR MAPBOX
    // ======================================================

    map.on('error', (e) => {

      console.error('MAPBOX ERROR:', e);

    });

    // ======================================================
    // CLEANUP
    // ======================================================

    return () => {

      if (userMarkerRef.current) {
        userMarkerRef.current.remove();
      }

      map.remove();

    };

  }, [mapStyle]);

  // ======================================================
  // UI
  // ======================================================

  return (

    <div
      className={`relative w-full h-full rounded-xl overflow-hidden ${
        compact ? 'min-h-[500px]' : 'min-h-[700px]'
      }`}
    >

      {/* MAPA */}

      <div
        ref={mapContainerRef}
        className="absolute inset-0"
      />

      {/* PANEL */}

      <div className="absolute top-4 left-4 z-10 bg-black/80 backdrop-blur-md border border-white/10 rounded-lg p-4 w-72 flex flex-col gap-3">

        {/* GPS */}

        <button
          onClick={handleGeolocate}
          disabled={isLocating}
          className="bg-cyan-500 hover:bg-cyan-400 text-white px-4 py-2 rounded font-semibold"
        >
          {isLocating ? 'Buscando GPS...' : '📍 Mi ubicación'}
        </button>

        {/* CONSULTA */}

        <form
          onSubmit={handleManualQuery}
          className="flex flex-col gap-2"
        >

          <input
            type="text"
            value={coordInput}
            onChange={(e) => setCoordInput(e.target.value)}
            placeholder="Latitud, Longitud"
            className="px-3 py-2 rounded bg-white text-black"
          />

          <button
            type="submit"
            className="bg-cyan-500 hover:bg-cyan-400 text-white px-4 py-2 rounded font-semibold"
          >
            Consultar
          </button>

        </form>

        {/* ESTILOS */}

        <div className="flex flex-col gap-2">

          <button
            onClick={() =>
              setMapStyle('mapbox://styles/mapbox/satellite-streets-v12')
            }
            className="bg-white/10 hover:bg-white/20 text-white px-3 py-2 rounded text-sm"
          >
            🛰️ Satelital
          </button>

          <button
            onClick={() =>
              setMapStyle('mapbox://styles/mapbox/dark-v11')
            }
            className="bg-white/10 hover:bg-white/20 text-white px-3 py-2 rounded text-sm"
          >
            🌑 Oscuro
          </button>

        </div>

      </div>

      {/* ESTILOS MARKER */}

      <style>{`

        .user-gps-marker {

          width: 18px;
          height: 18px;

          background: #00d8ff;

          border: 3px solid white;

          border-radius: 50%;

          box-shadow: 0 0 12px rgba(0,216,255,0.7);

          animation: pulseGps 2s infinite;

          cursor: pointer;

        }

        @keyframes pulseGps {

          0% {
            box-shadow: 0 0 0 0 rgba(0,216,255,0.7);
          }

          70% {
            box-shadow: 0 0 0 16px rgba(0,216,255,0);
          }

          100% {
            box-shadow: 0 0 0 0 rgba(0,216,255,0);
          }

        }

      `}</style>

    </div>

  );

}

export default GisMap;