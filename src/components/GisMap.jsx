import React, { useEffect, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';

// TOKEN
mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN;

function GisMap() {

  const mapContainer = useRef(null);
  const map = useRef(null);
  const markerRef = useRef(null);

  const [coordInput, setCoordInput] = useState('');
  const [isLocating, setIsLocating] = useState(false);

  // =====================================================
  // INICIALIZAR MAPA
  // =====================================================

  useEffect(() => {

    if (!mapContainer.current) return;

    if (map.current) return;

    map.current = new mapboxgl.Map({

      container: mapContainer.current,

      style: 'mapbox://styles/mapbox/satellite-streets-v12',

      center: [-75.6062, 1.6144],

      zoom: 8,

      attributionControl: false

    });

    // CONTROLES

    map.current.addControl(
      new mapboxgl.NavigationControl(),
      'top-right'
    );

    map.current.addControl(
      new mapboxgl.ScaleControl({
        unit: 'metric'
      }),
      'bottom-left'
    );

    // LOAD

    map.current.on('load', () => {

      map.current.resize();

      console.log('MAPA CARGADO');

    });

    // ERROR

    map.current.on('error', (e) => {

      console.error('MAPBOX ERROR:', e);

    });

    // RESIZE

    window.addEventListener('resize', () => {
      if (map.current) {
        map.current.resize();
      }
    });

    // CLEANUP

    return () => {

      if (markerRef.current) {
        markerRef.current.remove();
      }

      if (map.current) {
        map.current.remove();
      }

    };

  }, []);

  // =====================================================
  // GEOLOCALIZACIÓN
  // =====================================================

  const handleGeolocate = () => {

    if (!navigator.geolocation) {

      alert('GPS no soportado');

      return;

    }

    setIsLocating(true);

    navigator.geolocation.getCurrentPosition(

      (position) => {

        const lng = position.coords.longitude;
        const lat = position.coords.latitude;

        flyToLocation(lat, lng);

        setIsLocating(false);

      },

      (error) => {

        console.error(error);

        alert('No se pudo obtener ubicación');

        setIsLocating(false);

      },

      {
        enableHighAccuracy: true,
        timeout: 10000
      }

    );

  };

  // =====================================================
  // CONSULTA MANUAL
  // =====================================================

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

    flyToLocation(lat, lng);

  };

  // =====================================================
  // IR A UBICACIÓN
  // =====================================================

  const flyToLocation = (lat, lng) => {

    if (!map.current) return;

    map.current.flyTo({

      center: [lng, lat],

      zoom: 15,

      essential: true

    });

    // MARKER

    if (!markerRef.current) {

      const el = document.createElement('div');

      el.className = 'gps-marker';

      markerRef.current = new mapboxgl.Marker(el)
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
        .addTo(map.current);

    } else {

      markerRef.current.setLngLat([lng, lat]);

    }

  };

  // =====================================================
  // UI
  // =====================================================

  return (

    <div
      style={{
        width: '100%',
        display: 'flex',
        flexDirection: window.innerWidth < 768 ? 'column' : 'row',
        gap: '16px',
        alignItems: 'stretch'
      }}
    >

      {/* MAPA */}

      <div
        style={{
          flex: 1,
          position: 'relative',
          minHeight: window.innerWidth < 768 ? '450px' : '700px',
          height: window.innerWidth < 768 ? '450px' : '700px',
          borderRadius: '18px',
          overflow: 'hidden',
          background: '#111'
        }}
      >

        <div
          ref={mapContainer}
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%'
          }}
        />

      </div>

      {/* PANEL */}

      <div
        style={{
          width: window.innerWidth < 768 ? '100%' : '320px',
          background: 'rgba(0,0,0,0.85)',
          backdropFilter: 'blur(12px)',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: '18px',
          padding: '18px',
          display: 'flex',
          flexDirection: 'column',
          gap: '14px'
        }}
      >

        {/* GPS */}

        <button
          onClick={handleGeolocate}
          disabled={isLocating}
          style={{
            background: '#06b6d4',
            color: 'white',
            border: 'none',
            borderRadius: '12px',
            padding: '14px',
            fontWeight: '700',
            fontSize: '16px',
            cursor: 'pointer'
          }}
        >
          {isLocating ? 'Buscando GPS...' : '📍 Mi ubicación'}
        </button>

        {/* CONSULTA */}

        <form
          onSubmit={handleManualQuery}
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '12px'
          }}
        >

          <input
            type="text"
            value={coordInput}
            onChange={(e) => setCoordInput(e.target.value)}
            placeholder="Latitud, Longitud"
            style={{
              padding: '14px',
              borderRadius: '12px',
              border: 'none',
              fontSize: '15px'
            }}
          />

          <button
            type="submit"
            style={{
              background: '#06b6d4',
              color: 'white',
              border: 'none',
              borderRadius: '12px',
              padding: '14px',
              fontWeight: '700',
              cursor: 'pointer'
            }}
          >
            Consultar
          </button>

        </form>

      </div>

      {/* ESTILOS */}

      <style>{`

        .gps-marker {

          width: 20px;
          height: 20px;

          background: #00d8ff;

          border-radius: 50%;

          border: 3px solid white;

          box-shadow: 0 0 12px rgba(0,216,255,0.8);

          animation: pulseGps 2s infinite;

        }

        @keyframes pulseGps {

          0% {
            box-shadow: 0 0 0 0 rgba(0,216,255,0.8);
          }

          70% {
            box-shadow: 0 0 0 18px rgba(0,216,255,0);
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