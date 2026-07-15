import { LocateFixed, Search } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import CatastroXMap from './CatastroXMap.jsx';
import { CatastroxApiError, clearLastLookup, lookupPredio } from '../services/catastroxApi.js';

const INITIAL_COORDS = { lat: '', lng: '' };
const LOOKUP_UNAVAILABLE_MESSAGE =
  'La consulta predial no está disponible en este momento. Intenta nuevamente más tarde.';

function getPublicLookupErrorMessage(error) {
  const message = String(error?.message || '');
  if (/CATASTROX_DATABASE_URL|PostGIS|base\s+independiente|variable\s+de\s+entorno/i.test(message)) {
    return LOOKUP_UNAVAILABLE_MESSAGE;
  }
  if (error?.status >= 500 || error?.code === 'API_ERROR' || error?.code === 'API_UNAVAILABLE') {
    return LOOKUP_UNAVAILABLE_MESSAGE;
  }
  return message || LOOKUP_UNAVAILABLE_MESSAGE;
}

export default function CatastroXSearchForm() {
  const navigate = useNavigate();
  const [draftCoords, setDraftCoords] = useState(INITIAL_COORDS);
  const [confirmedPoint, setConfirmedPoint] = useState(null);
  const [locating, setLocating] = useState(false);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  function updateDraftCoords(nextCoords) {
    setDraftCoords(nextCoords);
    setErrorMessage('');
  }

  function confirmCoords(nextCoords) {
    setDraftCoords(nextCoords);
    setConfirmedPoint(nextCoords);
    setErrorMessage('');
  }

  function handleMapCoordinateSelect(nextCoords) {
    confirmCoords(nextCoords);
  }

  function handleUseCurrentLocation() {
    if (!navigator.geolocation) {
      setErrorMessage('La geolocalización no está disponible en este dispositivo.');
      return;
    }

    setLocating(true);
    setErrorMessage('');
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const nextCoords = {
          lat: position.coords.latitude.toFixed(6),
          lng: position.coords.longitude.toFixed(6),
        };
        confirmCoords(nextCoords);
        setLocating(false);
      },
      () => {
        setErrorMessage('No fue posible obtener su ubicación actual.');
        setLocating(false);
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
      },
    );
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setLoading(true);
    setErrorMessage('');

    try {
      const lat = Number.parseFloat(String(draftCoords.lat).replace(',', '.'));
      const lng = Number.parseFloat(String(draftCoords.lng).replace(',', '.'));

      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        throw new CatastroxApiError('Ingrese una latitud y una longitud válidas.', {
          code: 'INVALID_COORDINATE',
          status: 400,
        });
      }

      const confirmedCoords = {
        lat: lat.toFixed(6),
        lng: lng.toFixed(6),
      };

      setConfirmedPoint(confirmedCoords);
      clearLastLookup();

      const result = await lookupPredio({ lat, lng });

      if (result.found) {
        const routeId = result.routeId || result.predio?.routeId || result.predio?.id;
        navigate(`/catastrox/resultado/${routeId}`);
        return;
      }

      navigate('/catastrox/resultado/no-found');
    } catch (error) {
      if (typeof window !== 'undefined' && ['127.0.0.1', 'localhost'].includes(window.location.hostname)) {
        console.error('[CatastroX lookup failure]', JSON.stringify({
          endpoint: '/api/catastrox/lookup',
          status: error?.status || 0,
          code: error?.code || 'UNKNOWN',
          message: error?.message || 'Error sin mensaje',
          responseBody: error?.payload || null,
        }));
      }
      if (error instanceof CatastroxApiError) {
        setErrorMessage(getPublicLookupErrorMessage(error));
      } else {
        setErrorMessage('No fue posible completar la consulta predial.');
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="catastrox-search-stack">
      <form className="catastrox-card catastrox-search-toolbar" onSubmit={handleSubmit}>
        <div className="catastrox-section-heading">
          <span>Consulta predial</span>
          <h2>Ingrese coordenadas o capture su ubicación actual</h2>
        </div>
        <p className="catastrox-copy">
          El mapa inicia centrado en Colombia. Puede digitar latitud y longitud o usar su ubicación actual; la consulta solo se ejecuta cuando confirme la búsqueda.
        </p>
        <div className="catastrox-search-toolbar-row">
          <button type="button" className="catastrox-button is-secondary" onClick={handleUseCurrentLocation} disabled={locating || loading}>
            <LocateFixed size={18} /> {locating ? 'Ubicando...' : 'Usar mi ubicación actual'}
          </button>
          <label className="catastrox-field">
            <span>Latitud</span>
            <input
              placeholder="Ej. 1.258651"
              value={draftCoords.lat}
              onChange={(event) => updateDraftCoords({ ...draftCoords, lat: event.target.value })}
            />
          </label>
          <label className="catastrox-field">
            <span>Longitud</span>
            <input
              placeholder="Ej. -75.821317"
              value={draftCoords.lng}
              onChange={(event) => updateDraftCoords({ ...draftCoords, lng: event.target.value })}
            />
          </label>
          <button type="submit" className="catastrox-button" disabled={loading}>
            <Search size={18} /> {loading ? 'Buscando...' : 'Buscar predio'}
          </button>
        </div>
        {errorMessage ? (
          <article className="catastrox-card is-danger catastrox-search-feedback">
            <div className="catastrox-section-heading">
              <span>Consulta no completada</span>
              <h2>Revise la coordenada o intente nuevamente</h2>
            </div>
            <p className="catastrox-copy">{errorMessage}</p>
          </article>
        ) : null}
      </form>

      <CatastroXMap
        mode="search"
        coordinates={confirmedPoint}
        onCoordinateSelect={handleMapCoordinateSelect}
      />
    </div>
  );
}
