// SPRINT-3D4 §15: lista de potreros EXCLUSIVA de un predio -- GET
// /api/ganaderia/predios/:predioId/potreros (server/routes/ganaderiaPotreros.js).
// predioId viene fijo desde la tarjeta del predio que monta este panel --
// nunca mezcla potreros de otros predios, nunca selector global.
import { useEffect, useState } from 'react';
import { StatusMessage } from '../components/FormField.jsx';
import { listPotrerosByPredio } from './ganaderiaPotrerosApi.js';
import { formatDateDisplay } from '../utils/dateFormat.js';

const LIST_ERROR_MESSAGE = 'No fue posible cargar los potreros de este predio. Intenta nuevamente.';
const LIST_EMPTY_MESSAGE = 'Aún no tienes potreros registrados en este predio.';

const METODO_LABELS = {
  coordenadas: 'Coordenadas',
  gps_movil: 'GPS del dispositivo',
};

function formatAreaHa(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '—';
  return `${num.toLocaleString('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ha`;
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

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');

    listPotrerosByPredio(predioId)
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
  }, [predioId, refreshKey]);

  const successBanner = successMessage ? <StatusMessage type="success">{successMessage}</StatusMessage> : null;

  if (loading) {
    return (
      <>
        {successBanner}
        <StatusMessage>Cargando potreros de este predio...</StatusMessage>
      </>
    );
  }

  if (error) {
    return (
      <>
        {successBanner}
        <StatusMessage type="error">{error}</StatusMessage>
      </>
    );
  }

  if (potreros.length === 0) {
    return (
      <>
        {successBanner}
        <p className="gan-empty-text">{LIST_EMPTY_MESSAGE}</p>
      </>
    );
  }

  return (
    <div className="gan-potrero-list">
      {successBanner}
      {potreros.map((potrero) => (
        <div className="gan-potrero-list-item" key={potrero.potreroId}>
          <strong>{potrero.nombre}</strong>
          <div className="gan-ficha-row">
            <span>Área</span>
            <strong>{formatAreaHa(potrero.areaHa)}</strong>
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
        </div>
      ))}
    </div>
  );
}
