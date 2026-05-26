import React, { useEffect, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';

// Token oficial de AgroGenomaX
const MAPBOX_TOKEN = 'pk.eyJ1IjoiYWdyb2dlbm9tYXgiLCJhIjoiY21wbjE0aHVjMm40ajJxb3FzOW16YTFxNCJ9.F9rWrhD8JZdNwHXzs1kIqg';

function GisMap() {
  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);
  const userMarkerRef = useRef(null);
  
  const [mapStyle, setMapStyle] = useState('mapbox://styles/mapbox/satellite-streets-v12');
  const [showLey2, setShowLey2] = useState(true);
  const [isLocating, setIsLocating] = useState(false);
  const [coordInput, setCoordInput] = useState('');

  // Función para procesar y ubicar coordenadas ingresadas manualmente (WhatsApp)
  const handleManualQuery = (e) => {
    e.preventDefault();
    
    if (!coordInput.trim()) {
      alert('Por favor, ingresa las coordenadas.');
      return;
    }

    let parts = coordInput.split(/[\s,]+/);
    
    if (parts.length < 2) {
      alert('Formato inválido. Ingresa Latitud y Longitud separados por una coma o espacio.');
      return;
    }

    const lat = parseFloat(parts[0]);
    const lng = parseFloat(parts[1]);

    if (isNaN(lat) || isNaN(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      alert('Coordenadas no válidas. Asegúrate de ingresar números correctos (Ej: 1.6144, -75.6062).');
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
          .setPopup(new mapboxgl.Popup({ offset: 25 }).setHTML(`<span class="font-mono text-xs text-center block"><b>Predio Consultado</b><br/>Lat: ${lat}<br/>Lng: ${lng}</span>`))
          .addTo(mapRef.current);
      } else {
        userMarkerRef.current.setLngLat([lng, lat]);
        userMarkerRef.current.setPopup(new mapboxgl.Popup({ offset: 25 }).setHTML(`<span class="font-mono text-xs text-center block"><b>Predio Consultado</b><br/>Lat: ${lat}<br/>Lng: ${lng}</span>`));
      }
    }
  };

  // Función de geolocalización por chip GPS
  const handleGeolocate = () => {
    if (!navigator.geolocation) {
      alert('Tu navegador o dispositivo no soporta geolocalización por GPS.');
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
              .setPopup(new mapboxgl.Popup({ offset: 25 }).setHTML('<span class="font-mono text-xs">Tu ubicación actual</span>'))
              .addTo(mapRef.current);
          } else {
            userMarkerRef.current.setLngLat([longitude, latitude]);
          }
        }
        setIsLocating(false);
      },
      (error) => {
        console.error('Error obteniendo coordenadas GPS:', error);
        alert('No se pudo acceder al GPS. Activa los permisos de ubicación.');
        setIsLocating(false);
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  };

  useEffect(() => {
    mapboxgl.accessToken = MAPBOX_TOKEN;

    const map = new mapboxgl.Map({
      container: mapContainerRef.current,
      style: mapStyle,
      center: [-75.6062, 1.6144], 
      zoom: 10,
      pitch: 15
    });

    mapRef.current = map;

    map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(new mapboxgl.ScaleControl({ unit: 'metric' }), 'bottom-left');

    map.on('style.load', () => {
      map.addSource('source-ley2', {
        type: 'vector',
        url: 'mapbox://agrogenomax.cxix9dvs'
      });

      // CAPA CON LOS CÓDIGOS CORREGIDOS SEGÚN TU PARAMETRIZACIÓN DE QGIS
      map.addLayer({
        id: 'capa-ley2-relleno',
        type: 'fill',
        source: 'source-ley2',
        'source-layer': 'ley_2_colombia_simplificada-dbv6on',
        layout: { 'visibility': showLey2 ? 'visible' : 'none' },
        paint: {
          'fill-color': [
            'match',
            ['get', 'uab_tipo_z'], 
            24, '#e1c124', // Código 24 -> Zona B: Amarillo
            25, '#df0101', // Código 25 -> Zona A: Rojo
            27, '#24a138', // Código 27 -> Zona C: Verde
            26, '#b55fb5', // Código 26 -> Área Previa Decisión: Lila/Fucsia
            '#808080'     // Color neutro por si acaso
          ],
          'fill-opacity': 0.35 // Opacidad óptima para superposición satelital
        }
      });
    });

    return () => {
      if (userMarkerRef.current) userMarkerRef.current.remove();
      map.remove();
    };
  }, [mapStyle]);

  useEffect(() => {
    if (mapRef.current && mapRef.current.getLayer('capa-ley2-relleno')) {
      mapRef.current.setLayoutProperty('capa-ley2-relleno', 'visibility', showLey2 ? 'visible' : 'none');
    }
  }, [showLey2]);

  return (
    <div className="relative w-full h-[620px] rounded-lg border border-white/10 overflow-hidden bg-black">
      
      {/* Telemetría en pantalla */}
      <div className="absolute top-4 left-4 z-10 bg-black/80 backdrop-blur-md border border-[#00ffcc]/30 px-3 py-2 rounded text-xs font-mono text-[#00ffcc]">
        AGX-OS // MAPPING_ANALYSIS: LEY_2_COLOMBIA
      </div>

      {/* PANEL UNIFICADO DE CONTROL */}
      <div className="absolute top-4 right-4 z-10 bg-black/95 backdrop-blur-md border border-white/10 p-4 rounded-md flex flex-col gap-3 shadow-2xl w-64 max-h-[580px] overflow-y-auto">
        
        {/* 1. BOTÓN INTERACTIVO GPS */}
        <button
          onClick={handleGeolocate}
          disabled={isLocating}
          className={`w-full py-2 px-3 text-xs font-mono rounded flex items-center justify-center gap-2 border transition-all active:scale-98 ${
            isLocating 
              ? 'bg-[#00ffcc]/10 border-[#00ffcc]/30 text-[#00ffcc]' 
              : 'bg-white/5 hover:bg-white/10 border-white/10 text-white'
          }`}
        >
          {isLocating ? (
            <>
              <span className="w-3 h-3 border-2 border-[#00ffcc] border-t-transparent rounded-full animate-spin" />
              <span>Buscando señal...</span>
            </>
          ) : (
            <>
              <span>📍</span>
              <span className="font-semibold text-gray-200">Mi ubicación en campo</span>
            </>
          )}
        </button>

        <hr className="border-white/10" />

        {/* 2. FORMULARIO DE CONSULTA POR COORDENADAS */}
        <div>
          <span className="text-[9px] font-mono text-gray-400 uppercase tracking-wider block mb-1">Consulta por Coordenadas</span>
          <form onSubmit={handleManualQuery} className="flex flex-col gap-1.5">
            <input 
              type="text"
              value={coordInput}
              onChange={(e) => setCoordInput(e.target.value)}
              placeholder="Ej: 1.6144, -75.6062"
              className="w-full bg-white/5 border border-white/10 text-white font-mono text-xs px-2.5 py-1.5 rounded focus:outline-none focus:border-[#00ffcc]/60 placeholder-gray-600"
            />
            <button
              type="submit"
              className="w-full py-1.5 text-[11px] font-mono bg-[#00ffcc]/10 hover:bg-[#00ffcc]/20 border border-[#00ffcc]/30 text-[#00ffcc] font-bold rounded transition-all active:scale-98"
            >
              🔍 Consultar Predio
            </button>
          </form>
        </div>

        <hr className="border-white/10" />
        
        {/* 3. SECCIÓN: MAPAS BASE */}
        <div>
          <span className="text-[9px] font-mono text-gray-400 uppercase tracking-wider block mb-1">Capas Base</span>
          <div className="flex flex-col gap-1">
            <button
              onClick={() => setMapStyle('mapbox://styles/mapbox/satellite-streets-v12')}
              className={`px-3 py-1 text-xs font-mono rounded text-left transition-all ${
                mapStyle.includes('satellite')
                  ? 'bg-[#00ffcc]/20 text-[#00ffcc] border border-[#00ffcc]/40'
                  : 'text-gray-400 hover:text-white bg-transparent border border-transparent'
              }`}
            >
              🛰️ Satelital Híbrido
            </button>

            <button
              onClick={() => setMapStyle('mapbox://styles/mapbox/dark-v11')}
              className={`px-3 py-1 text-xs font-mono rounded text-left transition-all ${
                mapStyle.includes('dark')
                  ? 'bg-[#00ffcc]/20 text-[#00ffcc] border border-[#00ffcc]/40'
                  : 'text-gray-400 hover:text-white bg-transparent border border-transparent'
              }`}
            >
              🌐 Modo Oscuro
            </button>
          </div>
        </div>

        <hr className="border-white/10" />

        {/* 4. SECCIÓN: FILTRO SIG AMBIENTAL */}
        <div>
          <span className="text-[9px] font-mono text-gray-400 uppercase tracking-wider block mb-2">Determinantes Ambientales</span>
          <label className="flex items-center gap-2 text-xs font-mono text-gray-200 cursor-pointer select-none">
            <input 
              type="checkbox" 
              checked={showLey2} 
              onChange={(e) => setShowLey2(e.target.checked)}
              className="accent-[#00ffcc] h-3.5 w-3.5 rounded bg-black border-white/20 cursor-pointer"
            />
            <span className="text-gray-300 hover:text-white transition-colors">
              Zonificación Ley 2 de 1959
            </span>
          </label>
        </div>

        {/* 5. LEYENDA SINCRO CON CÓDIGOS CORREGIDOS */}
        {showLey2 && (
          <div className="bg-white/5 p-2 rounded border border-white/5 flex flex-col gap-1.5 mt-1">
            <span className="text-[8px] font-mono text-gray-500 uppercase tracking-wider block mb-0.5">Leyenda de Capa</span>
            <div className="flex items-center gap-2 text-[10px] font-mono text-gray-400"><span className="w-2.5 h-2.5 rounded-sm bg-[#df0101]" />Zona A (Rojo)</div>
            <div className="flex items-center gap-2 text-[10px] font-mono text-gray-400"><span className="w-2.5 h-2.5 rounded-sm bg-[#e1c124]" />Zona B (Amarillo)</div>
            <div className="flex items-center gap-2 text-[10px] font-mono text-gray-400"><span className="w-2.5 h-2.5 rounded-sm bg-[#24a138]" />Zona C (Verde)</div>
            <div className="flex items-center gap-2 text-[10px] font-mono text-gray-400"><span className="w-2.5 h-2.5 rounded-sm bg-[#b55fb5]" />Área Previa Decisión (Lila)</div>
          </div>
        )}
      </div>

      {/* Contenedor del Canvas de Mapbox */}
      <div ref={mapContainerRef} className="w-full h-full" />

      {/* Estilos del marcador radar */}
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
          0% { box-shadow: 0 0 0 0 rgba(0, 122, 255, 0.7); }
          70% { box-shadow: 0 0 0 12px rgba(0, 122, 255, 0); }
          100% { box-shadow: 0 0 0 0 rgba(0, 122, 255, 0); }
        }
      `}</style>

    </div>
  );
}

export default GisMap;