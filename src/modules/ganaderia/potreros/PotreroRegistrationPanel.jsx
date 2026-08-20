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
import {
  createPotrero,
  previewPotreroCoordinates,
  previewPotreroFile,
  previewPotreroGps,
} from './ganaderiaPotrerosApi.js';
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

// SPRINT-3D5 §18: errores propios de la importación KML/KMZ -- el
// frontend nunca decide si un archivo es válido, solo traduce el código
// real devuelto por preview-file (potreroKmlImport.js) a copy amigable.
const FILE_ERROR_MESSAGES = {
  UNSUPPORTED_FILE_TYPE: 'Solo se aceptan archivos .kml o .kmz.',
  FILE_TOO_LARGE: 'El archivo es demasiado grande.',
  INVALID_KML: 'El archivo KML no es válido.',
  INVALID_KMZ: 'El archivo KMZ no es válido.',
  KMZ_TOO_MANY_ENTRIES: 'El archivo KMZ contiene demasiados elementos.',
  KMZ_DECOMPRESSED_TOO_LARGE: 'El contenido del archivo KMZ es demasiado grande.',
  NO_POLYGONS_FOUND: 'El archivo no contiene ningún polígono.',
  TOO_MANY_POLYGONS: 'El archivo contiene demasiados polígonos.',
  PREDIO_WITHOUT_GEOMETRY: 'Este predio no tiene un polígono disponible para registrar potreros.',
  // SPRINT-3D5-CIERRE-SEMANTICO §2: KMZ con más de un .kml es ambiguo --
  // nunca se elige "el primero" en silencio, se rechaza con copy claro.
  KMZ_MULTIPLE_KML_FILES:
    'El archivo KMZ contiene varios archivos KML. Exporta el potrero en un KMZ con un solo archivo KML principal.',
};

// SPRINT-3D5-CIERRE-SEMANTICO §1: Point/LineString/MultiLineString nunca
// se procesan en silencio -- si preview-file reporta elementos ignorados
// (ignorados.{points,lineStrings,multiLineStrings}), se muestra un aviso
// amigable con las cantidades, sin abortar los Polygon válidos del mismo
// archivo.
function describeIgnoredElements(ignorados) {
  if (!ignorados) return null;
  const parts = [];
  if (ignorados.points > 0) parts.push(`${ignorados.points} punto${ignorados.points === 1 ? '' : 's'}`);
  if (ignorados.lineStrings > 0) parts.push(`${ignorados.lineStrings} línea${ignorados.lineStrings === 1 ? '' : 's'}`);
  if (ignorados.multiLineStrings > 0) {
    parts.push(`${ignorados.multiLineStrings} multilínea${ignorados.multiLineStrings === 1 ? '' : 's'}`);
  }
  if (parts.length === 0) return null;
  return `Se importaron los polígonos encontrados. Algunos puntos o líneas del archivo fueron ignorados porque no representan potreros (${parts.join(', ')}).`;
}

// SPRINT-3D5.1-KML-CLOSED-LINESTRING: si preview-file reporta
// convertidos.closedLineStrings > 0, la conversión LineString cerrado ->
// Polygon NUNCA es silenciosa -- se avisa al usuario, sin detalles
// técnicos, sin bloquear el preview.
function describeConversionNotice(convertidos) {
  const count = convertidos?.closedLineStrings;
  if (!(count > 0)) return null;
  return count === 1
    ? 'Se detectó una línea cerrada en el archivo y se interpretó como polígono del potrero.'
    : `Se detectaron ${count} líneas cerradas en el archivo y se interpretaron como polígonos de potrero.`;
}

const ACCEPTED_FILE_EXTENSIONS = ['.kml', '.kmz'];

function hasAcceptedFileExtension(fileName) {
  const lower = String(fileName || '').toLowerCase();
  return ACCEPTED_FILE_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

function resolveFileErrorMessage(code) {
  return FILE_ERROR_MESSAGES[code] || GENERIC_PREVIEW_ERROR;
}

const METODO_DELIMITACION_LABELS = {
  coordenadas: 'Coordenadas',
  gps_movil: 'GPS del dispositivo',
  kml: 'KML',
  kmz: 'KMZ',
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
  const [metodo, setMetodo] = useState('coordenadas'); // 'coordenadas' | 'gps' | 'kml'

  const [coordPoints, setCoordPoints] = useState([emptyPoint(), emptyPoint(), emptyPoint()]);
  const [gpsPoints, setGpsPoints] = useState([]);
  // idle | locating | denied | unavailable | timeout | unsupported --
  // arranca en 'idle': NUNCA se solicita ubicación al montar la vista.
  const [gpsStatus, setGpsStatus] = useState('idle');

  // SPRINT-3D5: estado del flujo KML/KMZ. `fileCandidates` solo se llena
  // cuando preview-file devuelve MÁS de un candidato válido -- §15: un
  // único polígono válido salta directo a 'preview', nunca se lista.
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState('');
  const [fileName, setFileName] = useState('');
  const [fileCandidates, setFileCandidates] = useState([]);
  const [fileInvalidCount, setFileInvalidCount] = useState(0);
  const [fileIgnoredNotice, setFileIgnoredNotice] = useState('');
  const [fileConversionNotice, setFileConversionNotice] = useState('');

  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const [previewData, setPreviewData] = useState(null); // { candidateId, areaHa, geometry, metodoDelimitacion }

  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');

  function goToPoints() {
    // KML/KMZ: el nombre puede quedar vacío aquí -- si el archivo trae
    // nombreSugerido por Placemark, se usa como valor inicial editable en
    // el paso de confirmación (§13). Coordenadas/GPS siguen exigiendo
    // nombre desde este paso (comportamiento sin cambios).
    if (metodo !== 'kml' && !nombre.trim()) return;
    setPreviewError('');
    setFileError('');
    setFileCandidates([]);
    setFileInvalidCount(0);
    setFileIgnoredNotice('');
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

  // SPRINT-3D5: aplica un candidate resuelto por preview-file (uno solo, o
  // uno elegido de una lista) como previewData -- MISMO shape exacto que
  // coordenadas/gps, para que el paso 'preview' no necesite lógica extra
  // por método. Si el usuario no escribió nombre todavía, se usa
  // nombreSugerido como valor inicial (editable, nunca se envía tal cual
  // sin pasar por el input).
  function applyFileCandidate(candidate) {
    if (!nombre.trim() && candidate.nombreSugerido) {
      setNombre(candidate.nombreSugerido);
    }
    setPreviewData({
      candidateId: candidate.candidateId,
      areaHa: candidate.areaHa,
      geometry: candidate.geometry,
      metodoDelimitacion: candidate.metodoDelimitacion,
    });
    setCreateError('');
    setStep('preview');
  }

  // §14/§15/§21: sube el archivo tal cual (Blob/File nativo, nunca
  // FileReader ni parseo/geometry en el cliente) a preview-file. Backend
  // decide todo: tipo, tamaño, seguridad ZIP/XML, validez geométrica,
  // pertenencia al predio y área. Un único polígono válido -> preview
  // directo (§15); varios -> lista para que el usuario elija (§8/§15).
  async function handleFileChange(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    setFileError('');
    setFileCandidates([]);
    setFileInvalidCount(0);
    setFileIgnoredNotice('');
    setFileConversionNotice('');
    setFileName(file.name || '');

    if (!hasAcceptedFileExtension(file.name)) {
      setFileError(resolveFileErrorMessage('UNSUPPORTED_FILE_TYPE'));
      return;
    }

    setFileLoading(true);
    try {
      const { ok, data } = await previewPotreroFile(predioId, file);
      setFileLoading(false);

      if (!ok) {
        setFileError(resolveFileErrorMessage(data?.error));
        return;
      }

      const candidates = Array.isArray(data?.candidates) ? data.candidates : [];
      const invalidos = Array.isArray(data?.invalidos) ? data.invalidos : [];
      setFileInvalidCount(invalidos.length);

      if (candidates.length === 0) {
        setFileError(
          invalidos.length > 0
            ? 'Ningún polígono del archivo quedó dentro del predio.'
            : resolveFileErrorMessage('NO_POLYGONS_FOUND'),
        );
        return;
      }

      // §1: se informa SIEMPRE que haya elementos ignorados, sin importar
      // si el archivo produjo 1 candidate (preview directo) o varios
      // (lista) -- el aviso debe seguir visible en ambos casos.
      setFileIgnoredNotice(describeIgnoredElements(data?.ignorados) || '');
      // SPRINT-3D5.1: mismo criterio para la conversión LineString cerrado
      // -> Polygon -- nunca silenciosa, visible tanto en la lista de
      // candidates como en el preview final.
      setFileConversionNotice(describeConversionNotice(data?.convertidos) || '');

      if (candidates.length === 1) {
        applyFileCandidate(candidates[0]);
        return;
      }

      setFileCandidates(candidates);
    } catch {
      setFileLoading(false);
      setFileError(GENERIC_PREVIEW_ERROR);
    }
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
            <button
              type="button"
              className={`gan-potrero-method-card${metodo === 'kml' ? ' is-active' : ''}`}
              onClick={() => setMetodo('kml')}
            >
              KML/KMZ
            </button>
          </div>

          <button
            type="button"
            className="gan-submit"
            onClick={goToPoints}
            disabled={metodo !== 'kml' && !nombre.trim()}
          >
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

      {step === 'points' && metodo === 'kml' ? (
        <div className="gan-stack">
          <p className="gan-potrero-points-hint">Sube un archivo .kml o .kmz con el contorno del potrero.</p>

          <label className="gan-secondary-button" htmlFor="gan-potrero-kml-input">
            {fileLoading ? 'Procesando archivo...' : 'Seleccionar archivo'}
          </label>
          <input
            id="gan-potrero-kml-input"
            type="file"
            accept=".kml,.kmz"
            onChange={handleFileChange}
            disabled={fileLoading}
            style={{ display: 'none' }}
          />
          {fileName ? <p className="gan-potrero-points-hint">Archivo: {fileName}</p> : null}

          <StatusMessage type="error">{fileError}</StatusMessage>
          {fileIgnoredNotice ? <StatusMessage type="info">{fileIgnoredNotice}</StatusMessage> : null}
          {fileConversionNotice ? <StatusMessage type="info">{fileConversionNotice}</StatusMessage> : null}

          {fileCandidates.length > 0 ? (
            <div className="gan-potrero-points">
              {fileInvalidCount > 0 ? (
                <StatusMessage type="info">
                  {fileInvalidCount === 1
                    ? '1 polígono del archivo quedó fuera del predio y no se muestra.'
                    : `${fileInvalidCount} polígonos del archivo quedaron fuera del predio y no se muestran.`}
                </StatusMessage>
              ) : null}
              {fileCandidates.map((candidate, index) => (
                <div className="gan-potrero-point-row gan-potrero-point-row-readonly" key={candidate.candidateId}>
                  <span className="gan-potrero-point-label">
                    {candidate.nombreSugerido || `Polígono ${index + 1}`}
                  </span>
                  <span>{candidate.areaHa.toFixed(2)} ha</span>
                  <button type="button" className="gan-secondary-button" onClick={() => applyFileCandidate(candidate)}>
                    Vista previa / Seleccionar
                  </button>
                </div>
              ))}
            </div>
          ) : null}

          <div className="gan-potrero-actions">
            <button type="button" className="gan-back-inline" onClick={backToForm} disabled={fileLoading}>
              Volver
            </button>
          </div>
        </div>
      ) : null}

      {step === 'preview' && previewData ? (
        <div className="gan-stack">
          <div className="gan-eyebrow">CONFIRMA EL REGISTRO</div>

          <GanaderiaPotreroPreviewMap predioId={predioId} potreroGeometry={previewData.geometry} />

          {metodo === 'kml' && fileIgnoredNotice ? <StatusMessage type="info">{fileIgnoredNotice}</StatusMessage> : null}
          {metodo === 'kml' && fileConversionNotice ? <StatusMessage type="info">{fileConversionNotice}</StatusMessage> : null}

          <div className="gan-form">
            <FormField label="Nombre" required={metodo === 'kml'}>
              {metodo === 'kml' ? (
                <input value={nombre} onChange={(event) => setNombre(event.target.value)} required />
              ) : (
                <input value={nombre} readOnly />
              )}
            </FormField>
            <FormField label="Predio">
              <input value={predioNombre} readOnly />
            </FormField>
            <FormField label="Área calculada">
              <input value={`${previewData.areaHa.toFixed(2)} ha`} readOnly />
            </FormField>
            <FormField label="Método">
              <input value={METODO_DELIMITACION_LABELS[previewData.metodoDelimitacion] || 'Coordenadas'} readOnly />
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
            <button type="button" className="gan-submit" onClick={handleCreate} disabled={creating || !nombre.trim()}>
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
