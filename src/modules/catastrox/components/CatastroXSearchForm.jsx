import { LocateFixed, Search } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import CatastroXMap from './CatastroXMap.jsx';
import {
  CatastroxApiError,
  clearLastLookup,
  lookupPredio,
  lookupPredioByCode,
  resolveLookupId,
} from '../services/catastroxApi.js';

const INITIAL_COORDS = { lat: '', lng: '' };
const LOOKUP_UNAVAILABLE_MESSAGE =
  'La consulta predial no está disponible en este momento. Intenta nuevamente más tarde.';
const SEARCH_MODE = {
  COORDINATES: 'coordinates',
  CADASTRAL_CODE: 'code',
};
const CADASTRAL_CODE_HELP =
  'Ingrese el número predial anterior de 20 dígitos o el código predial nacional de 30 dígitos.';
const INVALID_CADASTRAL_CODE_MESSAGE =
  'El número predial debe contener exactamente 20 o 30 dígitos.';

function normalizeCadastralCodeInput(value) {
  return String(value ?? '').trim().replace(/[\s-]+/g, '');
}

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
  const [searchMode, setSearchMode] = useState(SEARCH_MODE.COORDINATES);
  const [draftCoords, setDraftCoords] = useState(INITIAL_COORDS);
  const [cadastralCode, setCadastralCode] = useState('');
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

  function handleSearchModeChange(nextMode) {
    if (loading || nextMode === searchMode) return;
    setSearchMode(nextMode);
    setErrorMessage('');
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
    if (loading) return;
    setLoading(true);
    setErrorMessage('');

    try {
      if (searchMode === SEARCH_MODE.CADASTRAL_CODE) {
        const normalizedCode = normalizeCadastralCodeInput(cadastralCode);
        if (!/^(?:\d{20}|\d{30})$/.test(normalizedCode)) {
          throw new CatastroxApiError(INVALID_CADASTRAL_CODE_MESSAGE, {
            code: 'INVALID_CADASTRAL_CODE',
            status: 400,
          });
        }

        clearLastLookup();
        const result = await lookupPredioByCode({ codigo: cadastralCode });
        const routeId = resolveLookupId(result);

        if (result.found && routeId) {
          navigate(`/catastrox/resultado/${encodeURIComponent(routeId)}`);
          return;
        }

        throw new CatastroxApiError('No fue posible completar la consulta por número predial.', {
          code: 'INVALID_LOOKUP_RESPONSE',
          status: 500,
        });
      }

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
        const routeId = resolveLookupId(result) || result.routeId || result.predio?.routeId || result.predio?.id;
        navigate(`/catastrox/resultado/${routeId}`);
        return;
      }

      navigate('/catastrox/resultado/no-found');
    } catch (error) {
      if (typeof window !== 'undefined' && ['127.0.0.1', 'localhost'].includes(window.location.hostname)) {
        console.error('[CatastroX lookup failure]', JSON.stringify({
          endpoint: searchMode === SEARCH_MODE.CADASTRAL_CODE ? '/api/catastrox/lookup-by-code' : '/api/catastrox/lookup',
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
          <span>Método de consulta</span>
          <h2>{searchMode === SEARCH_MODE.CADASTRAL_CODE ? 'Busque con número predial' : 'Use coordenadas o su ubicación actual'}</h2>
        </div>
        <p className="catastrox-copy">
          {searchMode === SEARCH_MODE.CADASTRAL_CODE
            ? CADASTRAL_CODE_HELP
            : 'El mapa inicia centrado en Colombia. Puede digitar latitud y longitud o usar su ubicación actual; la consulta solo se ejecuta cuando confirme la búsqueda.'}
        </p>
        <div className="catastrox-search-mode-switch" role="group" aria-label="Método de búsqueda">
          <button
            type="button"
            className={`catastrox-search-mode-option ${searchMode === SEARCH_MODE.COORDINATES ? 'is-active' : ''}`}
            aria-pressed={searchMode === SEARCH_MODE.COORDINATES}
            disabled={loading}
            onClick={() => handleSearchModeChange(SEARCH_MODE.COORDINATES)}
          >
            Coordenadas
          </button>
          <button
            type="button"
            className={`catastrox-search-mode-option ${searchMode === SEARCH_MODE.CADASTRAL_CODE ? 'is-active' : ''}`}
            aria-pressed={searchMode === SEARCH_MODE.CADASTRAL_CODE}
            disabled={loading}
            onClick={() => handleSearchModeChange(SEARCH_MODE.CADASTRAL_CODE)}
          >
            Número predial
          </button>
        </div>
        {searchMode === SEARCH_MODE.CADASTRAL_CODE ? (
          <div className="catastrox-search-mode-panel catastrox-search-mode-panel--code">
            <label className="catastrox-field">
              <span>Número predial</span>
              <input
                type="text"
                inputMode="numeric"
                autoComplete="off"
                spellCheck={false}
                maxLength={48}
                placeholder="Ej. 181500003000000130054000000000"
                value={cadastralCode}
                onChange={(event) => {
                  setCadastralCode(event.target.value);
                  setErrorMessage('');
                }}
              />
              <small className="catastrox-search-field-help">{CADASTRAL_CODE_HELP}</small>
            </label>
            <button type="submit" className="catastrox-button catastrox-search-submit" disabled={loading}>
              <Search size={18} /> {loading ? 'Buscando...' : 'Buscar predio'}
            </button>
          </div>
        ) : (
          <div className="catastrox-search-coordinates-layout">
            <button type="button" className="catastrox-button is-secondary catastrox-search-geo" onClick={handleUseCurrentLocation} disabled={locating || loading}>
              <LocateFixed size={18} /> {locating ? 'Ubicando...' : 'Usar mi ubicación actual'}
            </button>
            <div className="catastrox-search-toolbar-row catastrox-search-toolbar-row--coordinates">
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
            </div>
            <button type="submit" className="catastrox-button catastrox-search-submit" disabled={loading}>
              <Search size={18} /> {loading ? 'Consultando...' : 'Consultar predio'}
            </button>
          </div>
        )}
        {errorMessage ? (
          <article className="catastrox-card is-danger catastrox-search-feedback">
            <div className="catastrox-section-heading">
              <span>Consulta no completada</span>
              <h2>{searchMode === SEARCH_MODE.CADASTRAL_CODE ? 'Revise el número predial o intente nuevamente' : 'Revise la coordenada o intente nuevamente'}</h2>
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
