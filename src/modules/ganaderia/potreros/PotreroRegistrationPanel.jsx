// SPRINT-3D4: flujo de registro de Potreros -- SIEMPRE arranca desde la
// tarjeta de un predio ya registrado (predioId fijado por el padre,
// nunca seleccionable aquí, nunca "Seleccionar predio"). Habla
// EXCLUSIVAMENTE con /api/ganaderia/predios/:predioId/potreros/* vía
// ganaderiaPotrerosApi.js -- nunca con /api/potreros legacy ni con
// PotrerosPage.jsx legacy.
//
// Pasos: 'form' (predio bloqueado + campos operativos + método) ->
// 'points' (coordenadas o GPS, según método) -> 'preview' (confirmación
// con área/mapa calculados server-side) -> 'success'.
import { useState } from 'react';
import { FormField, StatusMessage } from '../components/FormField.jsx';
import { createPotrero, previewPotreroCoordinates, previewPotreroGps } from './ganaderiaPotrerosApi.js';
import GanaderiaPotreroPreviewMap from './GanaderiaPotreroPreviewMap.jsx';

const GENERIC_PREVIEW_ERROR = 'No fue posible generar la vista previa en este momento. Intenta nuevamente.';
const GENERIC_CREATE_ERROR = 'No fue posible registrar el potrero en este momento. Intenta nuevamente.';
const MIN_POINTS = 3;

// §12: el frontend NUNCA decide si el potrero cae dentro del predio --
// solo traduce los códigos de error reales del backend a copy amigable.
const PREVIEW_ERROR_MESSAGES = {
  POTRERO_OUTSIDE_PREDIO: 'El potrero debe quedar completamente dentro del predio.',
  INVALID_POTRERO_GEOMETRY: 'Los puntos ingresados no forman un polígono válido.',
  PREDIO_WITHOUT_GEOMETRY: 'Este predio no tiene un polígono disponible para registrar potreros.',
  INVALID_POTRERO_COORDINATES:
    'Verifica los puntos: se requieren al menos 3 vértices distintos con coordenadas válidas.',
};

// §21: errores de candidate en la creación definitiva.
const CREATE_ERROR_MESSAGES = {
  CANDIDATE_EXPIRED: 'La vista previa expiró. Genera una nueva.',
  CANDIDATE_ALREADY_USED: 'Esta vista previa ya fue utilizada. Genera una nueva.',
  CANDIDATE_IN_USE: 'Esta vista previa ya se está procesando. Espera un momento.',
  CANDIDATE_NOT_FOUND: 'La vista previa no es válida. Genera una nueva.',
  CANDIDATE_SCOPE_MISMATCH: 'La vista previa no corresponde a este predio. Genera una nueva.',
};

// §9/§12 sprint 3C4.1 (mismo patrón ya aprobado en PrediosPage.jsx):
// copy amigable de geolocalización, sin exponer códigos técnicos.
const GEO_MESSAGES = {
  locating: 'Obteniendo tu ubicación...',
  denied: 'No fue posible acceder a tu ubicación. Verifica los permisos del navegador.',
  unavailable: 'No fue posible determinar tu ubicación en este momento.',
  timeout: 'La solicitud de ubicación tardó demasiado. Intenta nuevamente.',
  unsupported: 'Tu navegador o dispositivo no permite obtener tu ubicación.',
};

function emptyPoint() {
  return { latitud: '', longitud: '' };
}

function resolvePreviewErrorMessage(code) {
  return PREVIEW_ERROR_MESSAGES[code] || GENERIC_PREVIEW_ERROR;
}

function resolveCreateErrorMessage(code) {
  return CREATE_ERROR_MESSAGES[code] || GENERIC_CREATE_ERROR;
}

function pointsAreValid(points) {
  if (points.length < MIN_POINTS) return false;
  return points.every((point) => {
    const lat = Number(point.latitud);
    const lng = Number(point.longitud);
    return (
      point.latitud !== '' &&
      point.longitud !== '' &&
      Number.isFinite(lat) &&
      Number.isFinite(lng) &&
      lat >= -90 &&
      lat <= 90 &&
      lng >= -180 &&
      lng <= 180
    );
  });
}

// onCreated: callback SÍNCRONO invocado justo después de un POST create
// exitoso -- ver handleCreate más abajo y PredioCard en PrediosPage.jsx
// (dueño del refreshKey/activePanel que reacciona a esta llamada).
export default function PotreroRegistrationPanel({ predioId, predioNombre, onClose, onCreated }) {
  // 'form' | 'points' | 'preview'
  const [step, setStep] = useState('form');

  const [nombre, setNombre] = useState('');
  const [capacidadAnimales, setCapacidadAnimales] = useState('');
  const [observaciones, setObservaciones] = useState('');
  const [metodo, setMetodo] = useState('coordenadas'); // 'coordenadas' | 'gps'

  const [coordPoints, setCoordPoints] = useState([emptyPoint(), emptyPoint(), emptyPoint()]);
  const [gpsPoints, setGpsPoints] = useState([]);
  // idle | locating | denied | unavailable | timeout | unsupported --
  // arranca en 'idle': NUNCA se solicita ubicación al montar la vista.
  const [gpsStatus, setGpsStatus] = useState('idle');

  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const [previewData, setPreviewData] = useState(null); // { candidateId, areaHa, geometry, metodoDelimitacion }

  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');

  function goToPoints() {
    if (!nombre.trim()) return;
    setPreviewError('');
    setStep('points');
  }

  function backToForm() {
    setStep('form');
  }

  function updateCoordPoint(index, field, value) {
    setCoordPoints((current) => current.map((point, i) => (i === index ? { ...point, [field]: value } : point)));
  }

  function addCoordPoint() {
    setCoordPoints((current) => [...current, emptyPoint()]);
  }

  function removeCoordPoint(index) {
    setCoordPoints((current) => (current.length <= MIN_POINTS ? current : current.filter((_, i) => i !== index)));
  }

  // §8/§9: SOLO getCurrentPosition bajo pulsación explícita -- nunca
  // watchPosition, nunca tracking continuo.
  function captureGpsPoint() {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setGpsStatus('unsupported');
      return;
    }
    setGpsStatus('locating');
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setGpsPoints((current) => [
          ...current,
          {
            latitud: String(position.coords.latitude),
            longitud: String(position.coords.longitude),
            precision: Number.isFinite(position.coords.accuracy) ? Math.round(position.coords.accuracy) : null,
          },
        ]);
        setGpsStatus('idle');
      },
      (error) => {
        // PERMISSION_DENIED=1, POSITION_UNAVAILABLE=2, TIMEOUT=3 (spec fijo).
        if (error.code === 1) setGpsStatus('denied');
        else if (error.code === 3) setGpsStatus('timeout');
        else setGpsStatus('unavailable');
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 0 },
    );
  }

  function removeGpsPoint(index) {
    setGpsPoints((current) => current.filter((_, i) => i !== index));
  }

  async function handlePreview() {
    if (previewLoading) return;
    const points = metodo === 'coordenadas' ? coordPoints : gpsPoints;
    if (!pointsAreValid(points)) {
      setPreviewError(PREVIEW_ERROR_MESSAGES.INVALID_POTRERO_COORDINATES);
      return;
    }

    setPreviewLoading(true);
    setPreviewError('');

    const puntos = points.map((point) => ({ latitud: Number(point.latitud), longitud: Number(point.longitud) }));

    try {
      const { ok, data } =
        metodo === 'coordenadas'
          ? await previewPotreroCoordinates(predioId, puntos)
          : await previewPotreroGps(predioId, puntos);

      if (ok && data?.candidateId && data?.preview) {
        setPreviewData({
          candidateId: data.candidateId,
          areaHa: data.preview.areaHa,
          geometry: data.preview.geometry,
          metodoDelimitacion: data.preview.metodoDelimitacion,
        });
        setPreviewLoading(false);
        setStep('preview');
        return;
      }

      setPreviewError(resolvePreviewErrorMessage(data?.error));
      setPreviewLoading(false);
    } catch {
      setPreviewError(GENERIC_PREVIEW_ERROR);
      setPreviewLoading(false);
    }
  }

  // §13: body EXCLUSIVAMENTE {candidateId, nombre, capacidadAnimales?,
  // observaciones?} -- geometry/areaHa/metodoDelimitacion/organizacionId/
  // predioId NUNCA viajan en este body (geometry/areaHa/metodo vienen del
  // candidate server-side; predioId va en el path).
  //
  // SPRINT-3D4 (cierre): el refetch post-save NO depende de que este
  // componente se desmonte/remonte por sí solo -- en cuanto el POST
  // responde ok, se invoca onCreated() de forma síncrona y determinística
  // (nunca window.location.reload, nunca un cierre/reapertura manual del
  // panel como truco para forzar el remount). onCreated() es responsabilidad
  // del padre (ver PredioCard en PrediosPage.jsx): ahí se incrementa un
  // refreshKey explícito que PotrerosByPredioPanel consume en su
  // useEffect -- la fuente de verdad tras el POST sigue siendo el GET real,
  // nunca una inserción optimista del body enviado aquí.
  async function handleCreate() {
    if (creating || !previewData) return;
    setCreating(true);
    setCreateError('');

    const body = {
      candidateId: previewData.candidateId,
      nombre: nombre.trim(),
      capacidadAnimales: capacidadAnimales === '' ? null : Number(capacidadAnimales),
      observaciones: observaciones.trim() ? observaciones.trim() : null,
    };

    try {
      const { ok, data } = await createPotrero(predioId, body);
      if (ok) {
        setCreating(false);
        onCreated();
        return;
      }
      setCreateError(resolveCreateErrorMessage(data?.error));
      setCreating(false);
    } catch {
      setCreateError(GENERIC_CREATE_ERROR);
      setCreating(false);
    }
  }

  function backToPointsFromPreview() {
    setPreviewData(null);
    setCreateError('');
    setStep('points');
  }

  return (
    <div className="gan-potrero-panel">
      <div className="gan-potrero-panel-context">
        <span className="gan-eyebrow">Predio</span>
        <strong>{predioNombre}</strong>
      </div>

      {step === 'form' ? (
        <div className="gan-form">
          <FormField label="Nombre del potrero" required>
            <input value={nombre} onChange={(event) => setNombre(event.target.value)} required />
          </FormField>
          <FormField label="Capacidad de animales (opcional)">
            <input
              type="number"
              min="0"
              step="1"
              value={capacidadAnimales}
              onChange={(event) => setCapacidadAnimales(event.target.value)}
            />
          </FormField>
          <FormField label="Observaciones (opcional)">
            <textarea value={observaciones} onChange={(event) => setObservaciones(event.target.value)} />
          </FormField>

          <div className="gan-potrero-method-grid" role="radiogroup" aria-label="Método de delimitación">
            <button
              type="button"
              className={`gan-potrero-method-card${metodo === 'coordenadas' ? ' is-active' : ''}`}
              onClick={() => setMetodo('coordenadas')}
            >
              Coordenadas
            </button>
            <button
              type="button"
              className={`gan-potrero-method-card${metodo === 'gps' ? ' is-active' : ''}`}
              onClick={() => setMetodo('gps')}
            >
              GPS del dispositivo
            </button>
            <button type="button" className="gan-potrero-method-card" disabled>
              KML/KMZ · Próximamente
            </button>
          </div>

          <button type="button" className="gan-submit" onClick={goToPoints} disabled={!nombre.trim()}>
            Continuar
          </button>
        </div>
      ) : null}

      {step === 'points' && metodo === 'coordenadas' ? (
        <div className="gan-stack">
          <p className="gan-potrero-points-hint">Ingresa al menos 3 puntos distintos (latitud/longitud).</p>
          <div className="gan-potrero-points">
            {coordPoints.map((point, index) => (
              <div className="gan-potrero-point-row" key={index}>
                <span className="gan-potrero-point-label">Punto {index + 1}</span>
                <input
                  type="number"
                  step="any"
                  placeholder="Latitud"
                  value={point.latitud}
                  onChange={(event) => updateCoordPoint(index, 'latitud', event.target.value)}
                />
                <input
                  type="number"
                  step="any"
                  placeholder="Longitud"
                  value={point.longitud}
                  onChange={(event) => updateCoordPoint(index, 'longitud', event.target.value)}
                />
                <button
                  type="button"
                  className="gan-potrero-point-remove"
                  onClick={() => removeCoordPoint(index)}
                  disabled={coordPoints.length <= MIN_POINTS}
                >
                  Eliminar
                </button>
              </div>
            ))}
          </div>
          <button type="button" className="gan-secondary-button" onClick={addCoordPoint}>
            + Agregar punto
          </button>

          <StatusMessage type="error">{previewError}</StatusMessage>

          <div className="gan-potrero-actions">
            <button type="button" className="gan-submit" onClick={handlePreview} disabled={previewLoading}>
              {previewLoading ? 'Generando vista previa...' : 'Vista previa'}
            </button>
            <button type="button" className="gan-back-inline" onClick={backToForm} disabled={previewLoading}>
              Volver
            </button>
          </div>
        </div>
      ) : null}

      {step === 'points' && metodo === 'gps' ? (
        <div className="gan-stack">
          <p className="gan-potrero-points-hint">Captura al menos 3 puntos caminando el contorno del potrero.</p>

          {gpsStatus !== 'idle' ? (
            <StatusMessage type={gpsStatus === 'locating' ? 'info' : 'error'}>{GEO_MESSAGES[gpsStatus]}</StatusMessage>
          ) : null}

          <button
            type="button"
            className="gan-secondary-button"
            onClick={captureGpsPoint}
            disabled={gpsStatus === 'locating'}
          >
            {gpsStatus === 'locating' ? 'Obteniendo ubicación...' : 'Capturar punto GPS'}
          </button>

          <div className="gan-potrero-points">
            {gpsPoints.map((point, index) => (
              <div className="gan-potrero-point-row gan-potrero-point-row-readonly" key={index}>
                <span className="gan-potrero-point-label">Punto {index + 1}</span>
                <span>{point.latitud}</span>
                <span>{point.longitud}</span>
                <span className="gan-potrero-point-precision">
                  {point.precision !== null ? `±${point.precision} m` : '—'}
                </span>
                <button type="button" className="gan-potrero-point-remove" onClick={() => removeGpsPoint(index)}>
                  Eliminar
                </button>
              </div>
            ))}
          </div>

          <StatusMessage type="error">{previewError}</StatusMessage>

          <div className="gan-potrero-actions">
            <button
              type="button"
              className="gan-submit"
              onClick={handlePreview}
              disabled={previewLoading || gpsPoints.length < MIN_POINTS}
            >
              {previewLoading ? 'Generando vista previa...' : 'Vista previa'}
            </button>
            <button type="button" className="gan-back-inline" onClick={backToForm} disabled={previewLoading}>
              Volver
            </button>
          </div>
        </div>
      ) : null}

      {step === 'preview' && previewData ? (
        <div className="gan-stack">
          <div className="gan-eyebrow">CONFIRMA EL REGISTRO</div>

          <GanaderiaPotreroPreviewMap predioId={predioId} potreroGeometry={previewData.geometry} />

          <div className="gan-form">
            <FormField label="Nombre">
              <input value={nombre} readOnly />
            </FormField>
            <FormField label="Predio">
              <input value={predioNombre} readOnly />
            </FormField>
            <FormField label="Área calculada">
              <input value={`${previewData.areaHa.toFixed(2)} ha`} readOnly />
            </FormField>
            <FormField label="Método">
              <input
                value={previewData.metodoDelimitacion === 'gps_movil' ? 'GPS del dispositivo' : 'Coordenadas'}
                readOnly
              />
            </FormField>
            <FormField label="Capacidad de animales">
              <input value={capacidadAnimales || '—'} readOnly />
            </FormField>
            <FormField label="Observaciones">
              <input value={observaciones || '—'} readOnly />
            </FormField>
          </div>

          <StatusMessage type="error">{createError}</StatusMessage>

          <div className="gan-potrero-actions">
            <button type="button" className="gan-submit" onClick={handleCreate} disabled={creating}>
              {creating ? 'Registrando...' : 'Registrar potrero'}
            </button>
            <button type="button" className="gan-back-inline" onClick={backToPointsFromPreview} disabled={creating}>
              Volver
            </button>
          </div>
        </div>
      ) : null}

      <button type="button" className="gan-back-inline" onClick={onClose}>
        Cancelar
      </button>
    </div>
  );
}
