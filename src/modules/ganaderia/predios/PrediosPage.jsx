// SPRINT-3C3.2 — REGISTRO DE PREDIO (flujo aprobado de verificación +
// edición) -- reemplaza la pantalla anterior (CRUD directo contra el
// router legacy /api/predios, sin CSRF, sin CatastroX) por el flujo
// real: búsqueda automática CatastroX -> verificación -> edición
// opcional -> confirmación, más registro manual como alternativa
// explícita.
//
// Habla EXCLUSIVAMENTE con /api/ganaderia/predios/* (server/routes/ganaderiaPredios.js,
// Postgres-AGX-Business, org-scoped, CSRF-gated) -- nunca con el router
// legacy /api/predios que usaba ganaderiaApi.js (ese router no aplica
// aislamiento por organización y no exige CSRF). Sigue el mismo patrón
// fetchCsrfToken + credentials:'include' + X-CSRF-Token ya usado en
// GanaderiaAdminCrearCuenta.jsx.
//
// La identidad del cliente/organización viene exclusivamente de la
// sesión autenticada server-side -- este formulario NUNCA pide código
// interno, propietario, documento/NIT, teléfono ni correo.
import { useEffect, useState } from 'react';
import { fetchCsrfToken } from '../auth/GanaderiaAuthContext.jsx';
import GanaderiaBackLink from '../components/GanaderiaBackLink.jsx';
import { FormField, StatusMessage } from '../components/FormField.jsx';
import CatastroXMap from '../../catastrox/components/CatastroXMap.jsx';
import GanaderiaPredioMiniMap from './GanaderiaPredioMiniMap.jsx';
import PotreroRegistrationPanel from '../potreros/PotreroRegistrationPanel.jsx';
import PotrerosByPredioPanel from '../potreros/PotrerosByPredioPanel.jsx';
import '../../catastrox/styles/catastrox.css';

const GENERIC_SEARCH_ERROR = 'No fue posible consultar el predio en este momento. Intenta nuevamente.';
const GENERIC_SAVE_ERROR = 'No fue posible registrar el predio en este momento. Intenta nuevamente.';
const SUCCESS_MESSAGE = 'Predio registrado correctamente.';
const LIST_ERROR_MESSAGE = 'No fue posible cargar tus predios registrados. Intenta nuevamente.';
const LIST_EMPTY_MESSAGE = 'Aún no tienes predios registrados.';

// SPRINT-3C3.2 §9: copy de usuario para cada desenlace de búsqueda --
// nunca detalles técnicos (backend/túnel/API/stack).
const SEARCH_OUTCOME_MESSAGES = {
  not_found: 'No encontramos un predio en esa ubicación o código. Puedes intentar de nuevo o registrar manualmente.',
  ambiguous: 'No pudimos identificar un único predio para este punto. Intenta con el código predial o afina la ubicación.',
  validation: 'Verifica los datos ingresados e intenta nuevamente.',
  rate_limited: 'Has hecho demasiadas búsquedas. Espera un momento e intenta nuevamente.',
  error: GENERIC_SEARCH_ERROR,
};

// SPRINT-3C4.1 §10: copy amigable para cada desenlace de geolocalización --
// nunca códigos técnicos GeolocationPositionError ni detalles internos.
const GEO_MESSAGES = {
  locating: 'Obteniendo tu ubicación...',
  success: 'Ubicación encontrada. Revisa las coordenadas y pulsa Buscar predio.',
  denied: 'No fue posible acceder a tu ubicación. Verifica los permisos del navegador.',
  unavailable: 'No fue posible determinar tu ubicación en este momento.',
  timeout: 'La solicitud de ubicación tardó demasiado. Intenta nuevamente.',
  unsupported: 'Tu navegador o dispositivo no permite obtener tu ubicación.',
};

// SPRINT-3C3.2 §11 (protección backend ya existente, ver reservePredioCandidate
// en prediosCandidateStore.js) -- copy amigable para cada código de error
// real del POST /api/ganaderia/predios en modo catastrox.
const SAVE_ERROR_MESSAGES = {
  CANDIDATE_EXPIRED: 'La búsqueda expiró. Vuelve a buscar el predio.',
  CANDIDATE_ALREADY_CONSUMED: 'Este resultado ya fue utilizado. Vuelve a buscar el predio.',
  CANDIDATE_IN_USE: 'Esta búsqueda ya se está procesando. Espera un momento.',
  CANDIDATE_NOT_FOUND: 'La búsqueda no es válida. Vuelve a intentarlo.',
  DUPLICATE_CODIGO_PREDIAL: 'Este predio ya está registrado en tu cuenta.',
};

const INITIAL_MANUAL_FORM = {
  nombrePredio: '',
  departamento: '',
  municipio: '',
  vereda: '',
  areaDeclaradaHa: '',
  observaciones: '',
};

function formatAreaHa(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '—';
  return `${num.toLocaleString('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ha`;
}

// SPRINT-3C3.2 §12: el área catastral se redondea a 2 decimales SOLO
// como sugerencia visual/precarga del campo editable -- nunca se envía
// al backend un valor derivado del área catastral si el cliente no lo
// confirma explícitamente (el body siempre lleva lo que esté en el
// campo en el momento del envío, editado o no).
function roundAreaHa(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '';
  return Math.round(num * 100) / 100;
}

function buildMapPredio(predio) {
  if (!predio?.geometry || !predio?.centroide) return null;
  return {
    polygonGeoJson: { type: 'Feature', properties: {}, geometry: predio.geometry },
    referencePoint: predio.centroide,
    municipio: predio.municipio,
    departamento: predio.departamento,
  };
}

// §2 del sprint 3C4: GET simple, sin CSRF (no es mutación) --
// credentials:'include' para que la sesión viaje igual que en los POST.
// SPRINT-3D9.2 (PRE-COMMIT FINAL ROUND, punto 3): incluirArchivados=true
// es el único opt-in explícito -- sin él, el backend ya filtra a
// estado=ACTIVO (prediosRepository.js).
async function fetchRegisteredPrediosList(incluirArchivados = false) {
  const query = incluirArchivados ? '?incluirArchivados=true' : '';
  const response = await fetch(`/api/ganaderia/predios${query}`, { credentials: 'include' });
  if (!response.ok) throw new Error('LIST_FAILED');
  const data = await response.json();
  return Array.isArray(data?.predios) ? data.predios : [];
}

function displayOrDash(value) {
  return value === null || value === undefined || value === '' ? '—' : value;
}

async function postGanaderiaPredios(path, body) {
  const csrfToken = await fetchCsrfToken();
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
    body: JSON.stringify(body),
  });

  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  return { ok: response.ok, status: response.status, data };
}

function resolveSearchOutcomeKind(status) {
  if (status === 409) return 'ambiguous';
  if (status === 404) return 'not_found';
  if (status === 400) return 'validation';
  if (status === 429) return 'rate_limited';
  return 'error';
}

export default function PrediosPage() {
  // ---- Mis Predios Registrados (§2/§3/§6/§7 del sprint 3C4) ----
  const [registeredPredios, setRegisteredPredios] = useState([]);
  const [prediosListLoading, setPrediosListLoading] = useState(true);
  const [prediosListError, setPrediosListError] = useState('');
  // SPRINT-3D9.2: "Ver archivados" -- único punto de acceso explícito para
  // ver predios ARCHIVADO; la vista normal (false) siempre queda activa.
  const [mostrarArchivadosPredios, setMostrarArchivadosPredios] = useState(false);

  async function reloadRegisteredPredios() {
    setPrediosListLoading(true);
    setPrediosListError('');
    try {
      const predios = await fetchRegisteredPrediosList(mostrarArchivadosPredios);
      setRegisteredPredios(predios);
    } catch {
      setPrediosListError(LIST_ERROR_MESSAGE);
    } finally {
      setPrediosListLoading(false);
    }
  }

  useEffect(() => {
    reloadRegisteredPredios();
  }, [mostrarArchivadosPredios]);

  // 'search' | 'manual' | 'result' | 'saved'
  const [screen, setScreen] = useState('search');

  // ---- búsqueda automática (§2 A/B, §3) ----
  const [searchMode, setSearchMode] = useState('coordenadas'); // 'coordenadas' | 'codigo'
  const [lat, setLat] = useState('');
  const [lng, setLng] = useState('');
  const [codigo, setCodigo] = useState('');
  const [searchStatus, setSearchStatus] = useState('idle'); // idle | searching | not_found | ambiguous | validation | rate_limited | error

  // ---- "Mi ubicación" (§9-§12 sprint 3C4.1) ----
  // idle | locating | success | denied | unavailable | timeout | unsupported
  const [geoStatus, setGeoStatus] = useState('idle');
  const [geoAccuracy, setGeoAccuracy] = useState(null);

  // ---- resultado / verificación / edición (§3, §5, §7) ----
  const [candidateId, setCandidateId] = useState(null);
  const [predio, setPredio] = useState(null);
  const [editing, setEditing] = useState(false);
  const [nombreOperativo, setNombreOperativo] = useState('');
  const [areaDeclarada, setAreaDeclarada] = useState('');
  const [observaciones, setObservaciones] = useState('');
  const [editSnapshot, setEditSnapshot] = useState(null);

  // ---- guardado (§6, §8, §10, §11) ----
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  // ---- registro manual (§14) ----
  const [manualForm, setManualForm] = useState(INITIAL_MANUAL_FORM);
  const [manualSaving, setManualSaving] = useState(false);
  const [manualError, setManualError] = useState('');

  function resetSearchState() {
    setSearchStatus('idle');
    setCandidateId(null);
    setPredio(null);
    setEditing(false);
    setEditSnapshot(null);
    setSaveError('');
  }

  function goToSearch() {
    resetSearchState();
    setScreen('search');
  }

  function goToManual() {
    resetSearchState();
    setManualForm(INITIAL_MANUAL_FORM);
    setManualError('');
    setScreen('manual');
  }

  // ---------------------------------------------------------------------
  // §2 A/B: búsqueda automática CatastroX -- NUNCA guarda nada, solo
  // genera un candidate temporal server-side.
  // ---------------------------------------------------------------------
  async function handleSearchSubmit(event) {
    event.preventDefault();
    if (searchStatus === 'searching') return;

    setSearchStatus('searching');

    const path =
      searchMode === 'coordenadas'
        ? '/api/ganaderia/predios/buscar-por-coordenadas'
        : '/api/ganaderia/predios/buscar-por-codigo';
    const body = searchMode === 'coordenadas' ? { lat: Number(lat), lng: Number(lng) } : { codigo: codigo.trim() };

    try {
      const { ok, status, data } = await postGanaderiaPredios(path, body);

      if (ok && data?.candidateId && data?.predio) {
        setCandidateId(data.candidateId);
        setPredio(data.predio);
        setNombreOperativo(data.predio.nombrePredio || '');
        setAreaDeclarada(roundAreaHa(data.predio.areaCatastralHa));
        setObservaciones('');
        setEditing(false);
        setEditSnapshot(null);
        setSearchStatus('idle');
        setScreen('result');
        return;
      }

      setSearchStatus(resolveSearchOutcomeKind(status));
    } catch {
      setSearchStatus('error');
    }
  }

  // ---------------------------------------------------------------------
  // §9/§12 sprint 3C4.1: "Mi ubicación" -- SOLO bajo acción explícita del
  // usuario (nunca al montar la página), SOLO getCurrentPosition (nunca
  // watchPosition / tracking continuo). Precarga lat/lng pero NUNCA
  // dispara la búsqueda automáticamente -- el usuario debe pulsar
  // "Buscar predio" para confirmar la consulta.
  // ---------------------------------------------------------------------
  function handleUseMyLocation() {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setGeoStatus('unsupported');
      return;
    }

    setSearchMode('coordenadas');
    setGeoStatus('locating');
    setGeoAccuracy(null);

    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLat(String(position.coords.latitude));
        setLng(String(position.coords.longitude));
        setGeoAccuracy(Number.isFinite(position.coords.accuracy) ? Math.round(position.coords.accuracy) : null);
        setGeoStatus('success');
      },
      (error) => {
        // PERMISSION_DENIED=1, POSITION_UNAVAILABLE=2, TIMEOUT=3 (spec fijo).
        if (error.code === 1) setGeoStatus('denied');
        else if (error.code === 3) setGeoStatus('timeout');
        else setGeoStatus('unavailable');
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 0 },
    );
  }

  // ---------------------------------------------------------------------
  // §7/§8: modo edición -- solo los campos OPERATIVOS son editables
  // (nombre con el que se registra, área declarada, observaciones).
  // departamento/municipio/vereda permanecen de solo lectura en este
  // sprint: el contrato actual de POST /api/ganaderia/predios (modo
  // catastrox) solo acepta candidateId/nombrePersonalizado/areaDeclaradaHa/
  // observaciones -- NO se amplía el backend silenciosamente para
  // aceptarlos (instrucción explícita del sprint). codigoPredial,
  // codigoAnterior, areaCatastralHa, areaCatastralM2, geometry, fuente,
  // versionFuente y snapshot NUNCA son editables desde este formulario.
  // ---------------------------------------------------------------------
  function startEditing() {
    setEditSnapshot({ nombreOperativo, areaDeclarada, observaciones });
    setEditing(true);
  }

  function cancelEditing() {
    if (editSnapshot) {
      setNombreOperativo(editSnapshot.nombreOperativo);
      setAreaDeclarada(editSnapshot.areaDeclarada);
      setObservaciones(editSnapshot.observaciones);
    }
    setEditSnapshot(null);
    setEditing(false);
    // §8: cancelar edición NUNCA consume el candidate ni escribe DB --
    // no se dispara ningún fetch aquí, solo se restauran valores locales.
  }

  // ---------------------------------------------------------------------
  // §6/§8: confirmación directa y "guardar tras editar" usan el MISMO
  // endpoint y el MISMO body -- la única diferencia es si el usuario tocó
  // los campos operativos antes de enviar. El área declarada mostrada
  // precargada es solo una sugerencia visual: el body SIEMPRE envía el
  // valor que esté actualmente en el campo, nunca un dato catastral
  // adicional tomado del candidate en el frontend.
  // ---------------------------------------------------------------------
  async function handleConfirm() {
    if (saving) return;
    setSaving(true);
    setSaveError('');

    const trimmedNombre = nombreOperativo.trim();
    const trimmedObservaciones = observaciones.trim();

    const body = {
      mode: 'catastrox',
      candidateId,
      nombrePersonalizado: trimmedNombre ? trimmedNombre : null,
      areaDeclaradaHa: areaDeclarada === '' || areaDeclarada === null ? null : Number(areaDeclarada),
      observaciones: trimmedObservaciones ? trimmedObservaciones : null,
    };

    try {
      const { ok, status, data } = await postGanaderiaPredios('/api/ganaderia/predios', body);

      if (ok) {
        setSaving(false);
        setScreen('saved');
        // §6: refetch de la fuente real (GET) -- nunca insertar una copia
        // optimista del candidate/body enviado.
        reloadRegisteredPredios();
        return;
      }

      setSaveError(SAVE_ERROR_MESSAGES[data?.error] || GENERIC_SAVE_ERROR);
      setSaving(false);
      void status;
    } catch {
      setSaveError(GENERIC_SAVE_ERROR);
      setSaving(false);
    }
  }

  // ---------------------------------------------------------------------
  // §14: registro manual -- solo los 6 campos aprobados, nunca geometry/
  // snapshot/codigoPredial/código interno/propietario/documento/teléfono/
  // correo.
  // ---------------------------------------------------------------------
  function updateManualField(field, value) {
    setManualForm((current) => ({ ...current, [field]: value }));
  }

  async function handleManualSubmit(event) {
    event.preventDefault();
    if (manualSaving) return;
    setManualSaving(true);
    setManualError('');

    const body = {
      mode: 'manual',
      nombrePredio: manualForm.nombrePredio.trim(),
      departamento: manualForm.departamento.trim(),
      municipio: manualForm.municipio.trim(),
      vereda: manualForm.vereda.trim() ? manualForm.vereda.trim() : null,
      areaDeclaradaHa: manualForm.areaDeclaradaHa === '' ? null : Number(manualForm.areaDeclaradaHa),
      observaciones: manualForm.observaciones.trim() ? manualForm.observaciones.trim() : null,
    };

    try {
      const { ok } = await postGanaderiaPredios('/api/ganaderia/predios', body);

      if (ok) {
        setManualSaving(false);
        setScreen('saved');
        // §6: refetch de la fuente real (GET) -- nunca insertar una copia
        // optimista del body enviado.
        reloadRegisteredPredios();
        return;
      }

      setManualError(GENERIC_SAVE_ERROR);
      setManualSaving(false);
    } catch {
      setManualError(GENERIC_SAVE_ERROR);
      setManualSaving(false);
    }
  }

  const mapPredio = buildMapPredio(predio);

  return (
    <div className="gan-stack">
      <div className="gan-panel">
        <GanaderiaBackLink />
        <div className="gan-section-heading">
          <span className="gan-eyebrow">Predios</span>
          <h2>Mis predios registrados</h2>
          <button
            type="button"
            className="gan-back-inline"
            onClick={() => setMostrarArchivadosPredios((current) => !current)}
          >
            {mostrarArchivadosPredios ? 'Ver activos' : 'Ver archivados'}
          </button>
        </div>

        <MisPrediosSection
          loading={prediosListLoading}
          error={prediosListError}
          predios={registeredPredios}
          onArchivoChanged={reloadRegisteredPredios}
        />
      </div>

      <div className="gan-panel">
        <div className="gan-section-heading">
          <span className="gan-eyebrow">Registrar nuevo predio</span>
          <h2>
            {screen === 'search' && 'Buscar predio en CatastroX'}
            {screen === 'manual' && 'Registrar predio manualmente'}
            {screen === 'result' && (editing ? 'Editar o completar información' : 'Encontramos este predio')}
            {screen === 'saved' && 'Predio registrado'}
          </h2>
        </div>

        {screen === 'search' ? (
          <SearchScreen
            searchMode={searchMode}
            setSearchMode={setSearchMode}
            lat={lat}
            setLat={setLat}
            lng={lng}
            setLng={setLng}
            codigo={codigo}
            setCodigo={setCodigo}
            searchStatus={searchStatus}
            onSubmit={handleSearchSubmit}
            onGoManual={goToManual}
            geoStatus={geoStatus}
            geoAccuracy={geoAccuracy}
            onUseMyLocation={handleUseMyLocation}
          />
        ) : null}

        {screen === 'manual' ? (
          <ManualScreen
            form={manualForm}
            onChange={updateManualField}
            onSubmit={handleManualSubmit}
            saving={manualSaving}
            error={manualError}
            onCancel={goToSearch}
          />
        ) : null}

        {screen === 'result' && predio ? (
          <ResultScreen
            predio={predio}
            mapPredio={mapPredio}
            editing={editing}
            nombreOperativo={nombreOperativo}
            setNombreOperativo={setNombreOperativo}
            areaDeclarada={areaDeclarada}
            setAreaDeclarada={setAreaDeclarada}
            observaciones={observaciones}
            setObservaciones={setObservaciones}
            saving={saving}
            saveError={saveError}
            onConfirm={handleConfirm}
            onStartEditing={startEditing}
            onCancelEditing={cancelEditing}
            onBackToSearch={goToSearch}
          />
        ) : null}

        {screen === 'saved' ? (
          <div className="gan-stack">
            <StatusMessage type="success">{SUCCESS_MESSAGE}</StatusMessage>
            <button type="button" className="gan-submit" onClick={goToSearch}>
              Registrar otro predio
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// §1/§3/§7 sprint 3C4: "Mis Predios Registrados" -- lista los predios ya
// guardados en Postgres-AGX-Business (GET /api/ganaderia/predios). Cada
// card usa EXCLUSIVAMENTE campos que el GET realmente entrega -- nunca
// predioId, organizacionId ni geometry cruda como texto.
// ---------------------------------------------------------------------
function MisPrediosSection({ loading, error, predios, onArchivoChanged }) {
  if (loading) {
    return <StatusMessage>Cargando tus predios registrados...</StatusMessage>;
  }

  if (error) {
    return <StatusMessage type="error">{error}</StatusMessage>;
  }

  if (predios.length === 0) {
    return <p className="gan-empty-text">{LIST_EMPTY_MESSAGE}</p>;
  }

  return (
    <div className="gan-card-grid gan-predios-grid">
      {predios.map((item) => (
        <PredioCard key={item.predioId} predio={item} onArchivoChanged={onArchivoChanged} />
      ))}
    </div>
  );
}

// SPRINT-3C4.1 §2/§4/§6: card de dos columnas -- datos operativos a la
// izquierda, mapa satelital ampliado a la derecha (desktop); se apilan
// verticalmente en tablet/móvil vía CSS (ver .gan-predio-card-body en
// styles.css). El nombre del predio es el elemento principal, y cada dato
// va en su propia fila LABEL/valor (.gan-ficha-row) en vez de texto
// concatenado.
// SPRINT-3D4 §2/§3: cada card fija su propio predioId -- "Registrar
// potrero"/"Ver potreros" actúan EXCLUSIVAMENTE sobre el predio de ESTA
// card (nunca un selector global, nunca estado compartido entre cards).
function PredioCard({ predio, onArchivoChanged }) {
  // null | 'registrar' | 'ver' -- expansión inline dentro de la MISMA
  // tarjeta, nunca una lista plana que mezcle potreros de otros predios.
  const [activePanel, setActivePanel] = useState(null);

  // SPRINT-3D9.2: archivar/restaurar -- reemplaza el hard DELETE (nunca
  // existió un botón "Eliminar definitivamente" para un predio). "Eliminar
  // predio" en la UI internamente ARCHIVA -- el historial se conserva.
  const [mostrarArchivar, setMostrarArchivar] = useState(false);
  const [motivoArchivar, setMotivoArchivar] = useState('');
  const [archivoEnCurso, setArchivoEnCurso] = useState(false);
  const [archivoError, setArchivoError] = useState('');
  const archivado = predio.estado === 'ARCHIVADO';

  async function handleConfirmarArchivar() {
    if (archivoEnCurso) return;
    if (motivoArchivar.trim() === '') {
      setArchivoError('Escribe el motivo.');
      return;
    }
    setArchivoEnCurso(true);
    setArchivoError('');
    const { ok, data } = await postGanaderiaPredios(`/api/ganaderia/predios/${predio.predioId}/archivar`, { motivo: motivoArchivar.trim() });
    setArchivoEnCurso(false);
    if (!ok) {
      setArchivoError(data?.error === 'PREDIO_CON_CICLO_EN_CURSO'
        ? 'No se puede archivar: al menos un potrero de este predio tiene un pastoreo en curso.'
        : 'No fue posible completar la operación en este momento. Intenta nuevamente.');
      return;
    }
    setMostrarArchivar(false);
    onArchivoChanged?.();
  }

  async function handleRestaurar() {
    if (archivoEnCurso) return;
    setArchivoEnCurso(true);
    setArchivoError('');
    const { ok } = await postGanaderiaPredios(`/api/ganaderia/predios/${predio.predioId}/restaurar`, {});
    setArchivoEnCurso(false);
    if (!ok) {
      setArchivoError('No fue posible completar la operación en este momento. Intenta nuevamente.');
      return;
    }
    onArchivoChanged?.();
  }

  // SPRINT-3D4 (cierre): mecanismo EXPLÍCITO y determinístico de refetch
  // post-save -- potrerosRefreshKey es un contador que PotrerosByPredioPanel
  // consume en su useEffect ([predioId, refreshKey]); se incrementa
  // exclusivamente en handlePotreroCreated, invocado de forma síncrona por
  // PotreroRegistrationPanel justo después de un POST create exitoso.
  // Nunca window.location.reload, nunca depende de que el usuario
  // cierre/reabra el panel manualmente, nunca un cambio artificial de
  // predioId. La fuente de verdad sigue siendo el GET real que dispara ese
  // useEffect -- ver PotrerosByPredioPanel.jsx.
  const [potrerosRefreshKey, setPotrerosRefreshKey] = useState(0);
  const [potreroSuccessMessage, setPotreroSuccessMessage] = useState('');

  function toggleRegistrar() {
    setPotreroSuccessMessage('');
    setActivePanel((current) => (current === 'registrar' ? null : 'registrar'));
  }

  function toggleVer() {
    setPotreroSuccessMessage('');
    setActivePanel((current) => (current === 'ver' ? null : 'ver'));
  }

  function handlePotreroCreated() {
    setPotrerosRefreshKey((key) => key + 1);
    setPotreroSuccessMessage('Potrero registrado correctamente.');
    setActivePanel('ver');
  }

  return (
    <div className="gan-predio-card">
      <strong className="gan-predio-card-name">{displayOrDash(predio.nombrePredio)}</strong>
      {archivado ? <StatusMessage type="warning">Este predio está archivado -- su historial se conserva.</StatusMessage> : null}
      <div className="gan-predio-card-body">
        <div className="gan-predio-data">
          <div className="gan-ficha-row">
            <span>Departamento</span>
            <strong>{displayOrDash(predio.departamento)}</strong>
          </div>
          <div className="gan-ficha-row">
            <span>Municipio</span>
            <strong>{displayOrDash(predio.municipio)}</strong>
          </div>
          <div className="gan-ficha-row">
            <span>Vereda</span>
            <strong>{displayOrDash(predio.vereda)}</strong>
          </div>
          <div className="gan-ficha-row">
            <span>Área declarada</span>
            <strong>{predio.areaDeclaradaHa === null ? '—' : formatAreaHa(predio.areaDeclaradaHa)}</strong>
          </div>
          <div className="gan-ficha-row">
            <span>Código predial</span>
            <strong>{predio.codigoPredial || 'Registro manual'}</strong>
          </div>
        </div>
        <div className="gan-predio-map-wrap">
          {predio.tieneGeometria ? (
            <GanaderiaPredioMiniMap predioId={predio.predioId} />
          ) : (
            <div className="gan-predio-map-empty">Mapa no disponible para este predio.</div>
          )}
        </div>
      </div>

      <div className="gan-predio-card-actions">
        <button type="button" className="gan-secondary-button" onClick={toggleRegistrar} disabled={archivado}>
          Registrar potrero
        </button>
        <button type="button" className="gan-secondary-button" onClick={toggleVer}>
          Ver potreros
        </button>
        {!archivado ? (
          <button type="button" className="gan-back-inline" onClick={() => { setMostrarArchivar(true); setMotivoArchivar(''); setArchivoError(''); }}>
            Eliminar predio
          </button>
        ) : (
          <button type="button" className="gan-back-inline" onClick={handleRestaurar} disabled={archivoEnCurso}>
            {archivoEnCurso ? 'Restaurando...' : 'Restaurar'}
          </button>
        )}
      </div>

      {mostrarArchivar ? (
        <div className="gan-stack">
          <StatusMessage type="info">El predio dejará de aparecer entre los activos. Su historial se conservará.</StatusMessage>
          <FormField label="Motivo" required>
            <input type="text" value={motivoArchivar} onChange={(event) => setMotivoArchivar(event.target.value)} />
          </FormField>
          <StatusMessage type="error">{archivoError}</StatusMessage>
          <div className="gan-potrero-actions">
            <button type="button" className="gan-secondary-button" onClick={handleConfirmarArchivar} disabled={archivoEnCurso}>
              {archivoEnCurso ? 'Eliminando...' : 'Confirmar'}
            </button>
            <button type="button" className="gan-back-inline" onClick={() => setMostrarArchivar(false)} disabled={archivoEnCurso}>
              Volver
            </button>
          </div>
        </div>
      ) : null}
      <StatusMessage type="error">{!mostrarArchivar ? archivoError : ''}</StatusMessage>

      {activePanel === 'registrar' ? (
        <PotreroRegistrationPanel
          predioId={predio.predioId}
          predioNombre={predio.nombrePredio}
          onClose={() => setActivePanel(null)}
          onCreated={handlePotreroCreated}
        />
      ) : null}

      {activePanel === 'ver' ? (
        <PotrerosByPredioPanel
          predioId={predio.predioId}
          refreshKey={potrerosRefreshKey}
          successMessage={potreroSuccessMessage}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------
// Pantalla de búsqueda automática (§2 A, §9 estados: idle/buscando/
// sin resultado/error técnico)
// ---------------------------------------------------------------------
function SearchScreen({
  searchMode,
  setSearchMode,
  lat,
  setLat,
  lng,
  setLng,
  codigo,
  setCodigo,
  searchStatus,
  onSubmit,
  onGoManual,
  geoStatus,
  geoAccuracy,
  onUseMyLocation,
}) {
  const searching = searchStatus === 'searching';
  const locating = geoStatus === 'locating';

  return (
    <>
      <div className="gan-segment" role="tablist">
        <button type="button" className={searchMode === 'coordenadas' ? 'is-active' : ''} onClick={() => setSearchMode('coordenadas')}>
          Por coordenadas
        </button>
        <button type="button" className={searchMode === 'codigo' ? 'is-active' : ''} onClick={() => setSearchMode('codigo')}>
          Por código predial
        </button>
        <button type="button" onClick={onUseMyLocation} disabled={locating}>
          {locating ? 'Obteniendo ubicación...' : 'Mi ubicación'}
        </button>
      </div>

      {geoStatus !== 'idle' ? (
        <StatusMessage type={geoStatus === 'success' ? 'success' : geoStatus === 'locating' ? 'info' : 'error'}>
          {GEO_MESSAGES[geoStatus]}
        </StatusMessage>
      ) : null}

      {geoStatus === 'success' && geoAccuracy !== null ? (
        <p className="gan-geo-accuracy">Precisión aproximada: {geoAccuracy} m</p>
      ) : null}

      <form className="gan-form" onSubmit={onSubmit}>
        {searchMode === 'coordenadas' ? (
          <>
            <FormField label="Latitud" required>
              <input
                type="number"
                step="any"
                value={lat}
                onChange={(event) => setLat(event.target.value)}
                required
              />
            </FormField>
            <FormField label="Longitud" required>
              <input
                type="number"
                step="any"
                value={lng}
                onChange={(event) => setLng(event.target.value)}
                required
              />
            </FormField>
          </>
        ) : (
          <FormField label="Código predial" required>
            <input value={codigo} onChange={(event) => setCodigo(event.target.value)} required />
          </FormField>
        )}

        <button className="gan-submit" type="submit" disabled={searching}>
          {searching ? 'Buscando...' : 'Buscar predio'}
        </button>
      </form>

      {searchStatus !== 'idle' && searchStatus !== 'searching' ? (
        <StatusMessage type="error">{SEARCH_OUTCOME_MESSAGES[searchStatus]}</StatusMessage>
      ) : null}

      <button type="button" className="gan-secondary-button" onClick={onGoManual} style={{ marginTop: '1rem' }}>
        Registrar manualmente
      </button>
    </>
  );
}

// ---------------------------------------------------------------------
// §3/§4/§5/§7: resultado encontrado -- mapa + verificación + edición
// opcional, sin navegar a otra pantalla.
// ---------------------------------------------------------------------
function ResultScreen({
  predio,
  mapPredio,
  editing,
  nombreOperativo,
  setNombreOperativo,
  areaDeclarada,
  setAreaDeclarada,
  observaciones,
  setObservaciones,
  saving,
  saveError,
  onConfirm,
  onStartEditing,
  onCancelEditing,
  onBackToSearch,
}) {
  return (
    <div className="gan-stack">
      <div className="gan-eyebrow">ENCONTRAMOS ESTE PREDIO</div>

      <div className="gan-form">
        <FormField label="Nombre">
          <input value={predio.nombrePredio || ''} readOnly />
        </FormField>
        <FormField label="Departamento">
          <input value={predio.departamento || ''} readOnly />
        </FormField>
        <FormField label="Municipio">
          <input value={predio.municipio || ''} readOnly />
        </FormField>
        <FormField label="Vereda">
          <input value={predio.vereda || '—'} readOnly />
        </FormField>
        <FormField label="Área catastral">
          <input value={formatAreaHa(predio.areaCatastralHa)} readOnly />
        </FormField>
        <FormField label="Código predial">
          <input value={predio.codigoPredial || ''} readOnly />
        </FormField>
      </div>

      {mapPredio ? (
        <CatastroXMap mode="result" predio={mapPredio} />
      ) : (
        <StatusMessage type="error">Mapa no disponible para este predio.</StatusMessage>
      )}

      <div className="gan-form">
        <FormField label="Nombre con el que quieres registrarlo">
          <input
            value={nombreOperativo}
            onChange={(event) => setNombreOperativo(event.target.value)}
            readOnly={!editing}
          />
        </FormField>
        <FormField label="Área que manejas/declaras (ha)">
          <input
            type="number"
            step="0.01"
            value={areaDeclarada}
            onChange={(event) => setAreaDeclarada(event.target.value)}
            readOnly={!editing}
          />
        </FormField>
        <FormField label="Observaciones">
          <textarea
            value={observaciones}
            onChange={(event) => setObservaciones(event.target.value)}
            readOnly={!editing}
          />
        </FormField>
      </div>

      <StatusMessage type="error">{saveError}</StatusMessage>

      {editing ? (
        <div className="gan-stack" style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
          <button type="button" className="gan-submit" onClick={onConfirm} disabled={saving}>
            {saving ? 'Guardando...' : 'Guardar y registrar predio'}
          </button>
          <button type="button" className="gan-secondary-button" onClick={onCancelEditing} disabled={saving}>
            Cancelar edición
          </button>
        </div>
      ) : (
        <div className="gan-stack" style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
          <button type="button" className="gan-submit" onClick={onConfirm} disabled={saving}>
            {saving ? 'Guardando...' : '✓ Los datos son correctos'}
          </button>
          <button type="button" className="gan-secondary-button" onClick={onStartEditing} disabled={saving}>
            ✎ Editar o completar información
          </button>
        </div>
      )}

      <button type="button" className="gan-back-inline" onClick={onBackToSearch} disabled={saving}>
        Buscar otro predio
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------
// §14: registro manual -- alternativa explícita, formulario mínimo.
// ---------------------------------------------------------------------
function ManualScreen({ form, onChange, onSubmit, saving, error, onCancel }) {
  return (
    <>
      <form className="gan-form" onSubmit={onSubmit}>
        <FormField label="Nombre del predio" required>
          <input value={form.nombrePredio} onChange={(event) => onChange('nombrePredio', event.target.value)} required />
        </FormField>
        <FormField label="Departamento" required>
          <input value={form.departamento} onChange={(event) => onChange('departamento', event.target.value)} required />
        </FormField>
        <FormField label="Municipio" required>
          <input value={form.municipio} onChange={(event) => onChange('municipio', event.target.value)} required />
        </FormField>
        <FormField label="Vereda">
          <input value={form.vereda} onChange={(event) => onChange('vereda', event.target.value)} />
        </FormField>
        <FormField label="Área que manejas/declaras (ha)">
          <input
            type="number"
            step="0.01"
            value={form.areaDeclaradaHa}
            onChange={(event) => onChange('areaDeclaradaHa', event.target.value)}
          />
        </FormField>
        <FormField label="Observaciones">
          <textarea value={form.observaciones} onChange={(event) => onChange('observaciones', event.target.value)} />
        </FormField>

        <button className="gan-submit" type="submit" disabled={saving}>
          {saving ? 'Guardando...' : 'Guardar predio'}
        </button>
      </form>

      <StatusMessage type="error">{error}</StatusMessage>

      <button type="button" className="gan-back-inline" onClick={onCancel} disabled={saving}>
        Cancelar y volver a la búsqueda
      </button>
    </>
  );
}
