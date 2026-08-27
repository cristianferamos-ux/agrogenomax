// SPRINT-3D4 §15: lista de potreros EXCLUSIVA de un predio -- GET
// /api/ganaderia/predios/:predioId/potreros (server/routes/ganaderiaPotreros.js).
// predioId viene fijo desde la tarjeta del predio que monta este panel --
// nunca mezcla potreros de otros predios, nunca selector global.
import { useEffect, useState } from 'react';
import { FormField, StatusMessage } from '../components/FormField.jsx';
import { listPotrerosByPredio, archivarPotrero, restaurarPotrero } from './ganaderiaPotrerosApi.js';
import { formatDateDisplay } from '../utils/dateFormat.js';
import GanaderiaPotreroCardMap from './GanaderiaPotreroCardMap.jsx';
import PotreroFichaProductivaPanel from './PotreroFichaProductivaPanel.jsx';
import PotreroAgroClimaPanel from './PotreroAgroClimaPanel.jsx';

const LIST_ERROR_MESSAGE = 'No fue posible cargar los potreros de este predio. Intenta nuevamente.';
const LIST_EMPTY_MESSAGE = 'Aún no tienes potreros registrados en este predio.';

const METODO_LABELS = {
  coordenadas: 'Coordenadas',
  gps_movil: 'GPS del dispositivo',
  kml: 'KML',
  kmz: 'KMZ',
};

function formatAreaHa(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '—';
  return `${num.toLocaleString('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ha`;
}

// SPRINT-3D5.3 §1: m² es SOLO presentación -- se deriva del areaHa ya
// calculado server-side (autoritativo), nunca se recalcula desde geometry
// en el cliente. areaHa * 10000 es una conversión de unidad pura (1 ha =
// 10000 m²), no un nuevo cálculo geométrico.
function formatAreaM2(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '—';
  return `${(num * 10000).toLocaleString('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} m²`;
}

// refreshKey: contador explícito controlado por el padre (PredioCard en
// PrediosPage.jsx) -- SPRINT-3D4 (cierre): el GET se repite cada vez que
// refreshKey cambia, sin depender de que predioId cambie ni de que este
// componente se desmonte/remonte. El padre lo incrementa en
// handlePotreroCreated justo después de un POST create exitoso -- así el
// refetch post-save es determinístico incluso si en algún momento futuro
// el panel deja de desmontarse al cambiar de vista.
export default function PotrerosByPredioPanel({ predioId, refreshKey = 0, successMessage = '' }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [potreros, setPotreros] = useState([]);
  // SPRINT-3D5.3-PERF: geometry del predio resuelta UNA sola vez por
  // predioId aquí -- nunca por GanaderiaPotreroCardMap.jsx (antes cada
  // card la pedía por su cuenta: N potreros -> N GETs idénticos del mismo
  // predio). Se pasa como prop a cada card; null mientras carga o si el
  // GET falla, y eso nunca oculta las cards (§4 del sprint).
  const [predioGeometry, setPredioGeometry] = useState(null);
  // SPRINT-3D6-FICHA-PRODUCTIVA: a lo sumo UNA ficha productiva abierta a
  // la vez, ligada al potreroId de la tarjeta que la abrió -- nunca un
  // flujo global (§20 del sprint: siempre Predio -> Potrero -> Ficha).
  const [openFichaPotreroId, setOpenFichaPotreroId] = useState(null);
  // SPRINT-3D7.1-AGROCLIMA: a lo sumo UN contexto agroclimático abierto a
  // la vez, independiente de la ficha productiva -- se resuelve
  // directamente de la geometry del potrero (§1 del sprint).
  const [openAgroClimaPotreroId, setOpenAgroClimaPotreroId] = useState(null);
  // SPRINT-3D9.2: "Ver archivados" -- único punto de acceso explícito para
  // ver potreros ARCHIVADO en este predio; internalRefreshKey se
  // incrementa tras un archivar/restaurar exitoso (mismo criterio que
  // refreshKey, pero interno a este panel -- el padre no necesita saberlo).
  const [mostrarArchivados, setMostrarArchivados] = useState(false);
  const [internalRefreshKey, setInternalRefreshKey] = useState(0);

  function handleArchivoChanged() {
    setInternalRefreshKey((key) => key + 1);
  }

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');

    listPotrerosByPredio(predioId, { incluirArchivados: mostrarArchivados })
      .then(({ ok, data }) => {
        if (!active) return;
        if (!ok || !Array.isArray(data?.potreros)) {
          setError(LIST_ERROR_MESSAGE);
          setLoading(false);
          return;
        }
        setPotreros(data.potreros);
        setLoading(false);
      })
      .catch(() => {
        if (active) {
          setError(LIST_ERROR_MESSAGE);
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [predioId, refreshKey, mostrarArchivados, internalRefreshKey]);

  useEffect(() => {
    let active = true;
    setPredioGeometry(null);

    fetch(`/api/ganaderia/predios/${predioId}`, { credentials: 'include' })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (!active) return;
        setPredioGeometry(data?.geometry || null);
      })
      .catch(() => {});

    return () => {
      active = false;
    };
  }, [predioId]);

  const successBanner = successMessage ? <StatusMessage type="success">{successMessage}</StatusMessage> : null;
  // SPRINT-3D9.2: visible en todo estado (loading/error/vacío/lista) --
  // el usuario siempre puede alternar activos<->archivados, incluso si la
  // vista activa está vacía (p.ej. todos los potreros de este predio están
  // archivados).
  const toggleArchivadosButton = (
    <button
      type="button"
      className="gan-back-inline"
      onClick={() => setMostrarArchivados((current) => !current)}
    >
      {mostrarArchivados ? 'Ver activos' : 'Ver archivados'}
    </button>
  );

  if (loading) {
    return (
      <>
        {successBanner}
        {toggleArchivadosButton}
        <StatusMessage>Cargando potreros de este predio...</StatusMessage>
      </>
    );
  }

  if (error) {
    return (
      <>
        {successBanner}
        {toggleArchivadosButton}
        <StatusMessage type="error">{error}</StatusMessage>
      </>
    );
  }

  if (potreros.length === 0) {
    return (
      <>
        {successBanner}
        {toggleArchivadosButton}
        <p className="gan-empty-text">{LIST_EMPTY_MESSAGE}</p>
      </>
    );
  }

  return (
    <div className="gan-potrero-list">
      {successBanner}
      {toggleArchivadosButton}
      {potreros.map((potrero) => (
        <PotreroCard
          key={potrero.potreroId}
          potrero={potrero}
          predioId={predioId}
          predioGeometry={predioGeometry}
          openFichaPotreroId={openFichaPotreroId}
          setOpenFichaPotreroId={setOpenFichaPotreroId}
          openAgroClimaPotreroId={openAgroClimaPotreroId}
          setOpenAgroClimaPotreroId={setOpenAgroClimaPotreroId}
          onArchivoChanged={handleArchivoChanged}
        />
      ))}
    </div>
  );
}

// SPRINT-3D9.2: archivar/restaurar -- reemplaza el hard DELETE de potrero
// (revocado en 0010, nunca existió un botón de borrado definitivo). "Eliminar
// potrero" en la UI internamente archiva -- el historial (fichas,
// recomendaciones, ciclos) se conserva. Mismo patrón que PredioCard en
// PrediosPage.jsx (motivo obligatorio, confirmación inline, refetch tras
// éxito, manejo explícito de PREDIO_ARCHIVADO al restaurar).
function PotreroCard({
  potrero,
  predioId,
  predioGeometry,
  openFichaPotreroId,
  setOpenFichaPotreroId,
  openAgroClimaPotreroId,
  setOpenAgroClimaPotreroId,
  onArchivoChanged,
}) {
  const [mostrarArchivar, setMostrarArchivar] = useState(false);
  const [motivoArchivar, setMotivoArchivar] = useState('');
  const [archivoEnCurso, setArchivoEnCurso] = useState(false);
  const [archivoError, setArchivoError] = useState('');
  const archivado = potrero.estado === 'ARCHIVADO';

  async function handleConfirmarArchivar() {
    if (archivoEnCurso) return;
    if (motivoArchivar.trim() === '') {
      setArchivoError('Escribe el motivo.');
      return;
    }
    setArchivoEnCurso(true);
    setArchivoError('');
    const { ok, data } = await archivarPotrero(predioId, potrero.potreroId, motivoArchivar.trim());
    setArchivoEnCurso(false);
    if (!ok) {
      setArchivoError(data?.error === 'POTRERO_CON_CICLO_EN_CURSO'
        ? 'No se puede archivar: este potrero tiene un pastoreo en curso.'
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
    const { ok, data } = await restaurarPotrero(predioId, potrero.potreroId);
    setArchivoEnCurso(false);
    if (!ok) {
      setArchivoError(data?.error === 'PREDIO_ARCHIVADO'
        ? 'No se puede restaurar: el predio de este potrero sigue archivado. Restaura primero el predio.'
        : 'No fue posible completar la operación en este momento. Intenta nuevamente.');
      return;
    }
    onArchivoChanged?.();
  }

  return (
    <div className="gan-potrero-card">
      <strong className="gan-potrero-card-name">{potrero.nombre}</strong>
      {archivado ? <StatusMessage type="warning">Este potrero está archivado -- su historial se conserva.</StatusMessage> : null}
      <div className="gan-potrero-card-body">
        <div className="gan-potrero-data">
          <div className="gan-ficha-row">
            <span>Área</span>
            <strong>{formatAreaHa(potrero.areaHa)}</strong>
            <strong>{formatAreaM2(potrero.areaHa)}</strong>
          </div>
          <div className="gan-ficha-row">
            <span>Capacidad de animales</span>
            <strong>{potrero.capacidadAnimales === null ? '—' : potrero.capacidadAnimales}</strong>
          </div>
          <div className="gan-ficha-row">
            <span>Método de delimitación</span>
            <strong>{METODO_LABELS[potrero.metodoDelimitacion] || potrero.metodoDelimitacion}</strong>
          </div>
          <div className="gan-ficha-row">
            <span>Fecha de creación</span>
            <strong>{formatDateDisplay(potrero.fechaCreacion)}</strong>
          </div>
          {potrero.observaciones ? (
            <div className="gan-ficha-row">
              <span>Observaciones</span>
              <strong>{potrero.observaciones}</strong>
            </div>
          ) : null}
        </div>
        <div className="gan-potrero-map-wrap">
          <GanaderiaPotreroCardMap
            predioId={predioId}
            potreroId={potrero.potreroId}
            predioGeometry={predioGeometry}
          />
        </div>
      </div>

      <div className="gan-potrero-card-actions">
        <button
          type="button"
          className="gan-secondary-button"
          onClick={() => setOpenFichaPotreroId((current) => (current === potrero.potreroId ? null : potrero.potreroId))}
        >
          Ficha productiva
        </button>
        <button
          type="button"
          className="gan-secondary-button"
          onClick={() => setOpenAgroClimaPotreroId((current) => (current === potrero.potreroId ? null : potrero.potreroId))}
        >
          Contexto agroclimático
        </button>
        {!archivado ? (
          <button
            type="button"
            className="gan-back-inline"
            onClick={() => { setMostrarArchivar(true); setMotivoArchivar(''); setArchivoError(''); }}
          >
            Eliminar potrero
          </button>
        ) : (
          <button type="button" className="gan-back-inline" onClick={handleRestaurar} disabled={archivoEnCurso}>
            {archivoEnCurso ? 'Restaurando...' : 'Restaurar potrero'}
          </button>
        )}
      </div>

      {mostrarArchivar ? (
        <div className="gan-stack">
          <StatusMessage type="info">El potrero dejará de aparecer entre los activos. Su historial se conservará.</StatusMessage>
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

      {openFichaPotreroId === potrero.potreroId ? (
        <PotreroFichaProductivaPanel
          predioId={predioId}
          potreroId={potrero.potreroId}
          areaHa={potrero.areaHa}
        />
      ) : null}

      {openAgroClimaPotreroId === potrero.potreroId ? (
        <PotreroAgroClimaPanel predioId={predioId} potreroId={potrero.potreroId} />
      ) : null}
    </div>
  );
}
