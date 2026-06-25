import { LocateFixed, Search } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import CatastroXMap from './CatastroXMap.jsx';
import { CatastroxApiError, clearLastLookup, lookupPredio } from '../services/catastroxApi.js';

const INITIAL_COORDS = { lat: '1.331245', lng: '-75.872110' };

export default function CatastroXSearchForm() {
  const navigate = useNavigate();
  const [draftCoords, setDraftCoords] = useState(INITIAL_COORDS);
  const [mapCoords, setMapCoords] = useState(INITIAL_COORDS);
  const [locating, setLocating] = useState(false);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  function updateDraftCoords(nextCoords) {
    setDraftCoords(nextCoords);
    setErrorMessage('');
  }

  function confirmCoords(nextCoords) {
    setDraftCoords(nextCoords);
    setMapCoords(nextCoords);
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

      setMapCoords(confirmedCoords);
      clearLastLookup();

      const result = await lookupPredio({ lat, lng });

      if (result.found) {
        navigate(`/catastrox/resultado/real-${result.predio.id}`);
        return;
      }

      navigate('/catastrox/resultado/no-found');
    } catch (error) {
      if (error instanceof CatastroxApiError) {
        setErrorMessage(error.message);
      } else {
        setErrorMessage('No fue posible completar la consulta predial.');
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="catastrox-search-stack">
      <article className="catastrox-card catastrox-map-instructions">
        <div className="catastrox-section-heading">
          <span>Ubicación del predio</span>
          <h2>Seleccione la ubicación del predio</h2>
        </div>
        <p className="catastrox-copy">
          Haga clic sobre el mapa o use su ubicación actual para capturar latitud y longitud.
        </p>
        <div className="catastrox-action-row">
          <button type="button" className="catastrox-button is-secondary" onClick={handleUseCurrentLocation} disabled={locating || loading}>
            <LocateFixed size={18} /> {locating ? 'Ubicando...' : 'Usar mi ubicación actual'}
          </button>
        </div>
      </article>

      <CatastroXMap
        mode="search"
        coordinates={mapCoords}
        onCoordinateSelect={handleMapCoordinateSelect}
      />

      <form className="catastrox-card catastrox-search" onSubmit={handleSubmit}>
        <div className="catastrox-section-heading">
          <span>Consulta predial</span>
          <h2>Ubique su predio con coordenadas capturadas</h2>
        </div>
        <label className="catastrox-field">
          <span>Latitud</span>
          <input
            value={draftCoords.lat}
            onChange={(event) => updateDraftCoords({ ...draftCoords, lat: event.target.value })}
          />
        </label>
        <label className="catastrox-field">
          <span>Longitud</span>
          <input
            value={draftCoords.lng}
            onChange={(event) => updateDraftCoords({ ...draftCoords, lng: event.target.value })}
          />
        </label>
        {errorMessage ? (
          <article className="catastrox-card is-danger catastrox-search-feedback">
            <div className="catastrox-section-heading">
              <span>Consulta no completada</span>
              <h2>Revise la coordenada o intente nuevamente</h2>
            </div>
            <p className="catastrox-copy">{errorMessage}</p>
          </article>
        ) : null}
        <div className="catastrox-action-row is-full">
          <button type="button" className="catastrox-button is-secondary" onClick={handleUseCurrentLocation} disabled={locating || loading}>
            <LocateFixed size={18} /> {locating ? 'Ubicando...' : 'Usar mi ubicación actual'}
          </button>
          <button type="submit" className="catastrox-button" disabled={loading}>
            <Search size={18} /> {loading ? 'Buscando...' : 'Buscar predio'}
          </button>
        </div>
      </form>
    </div>
  );
}
