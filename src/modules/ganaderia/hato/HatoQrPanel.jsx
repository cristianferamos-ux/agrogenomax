// SPRINT-3D11.3 (R1): sección QR de la ficha del animal. Muestra el QR
// ACTIVO (enlace /qr/<token>) y permite generar, reemplazar y revocar.
// Solo POST con CSRF vía hatoApi.js; nunca reintenta automáticamente. El
// reemplazo usa un clientOperationId fijo por formulario abierto: un
// reintento manual tras un fallo de red no reemplaza dos veces.
import { useCallback, useEffect, useState } from 'react';
import { FormField, StatusMessage } from '../components/FormField.jsx';
import { asignarQr, getAnimalQr, reemplazarQr, revocarQr } from './hatoApi.js';
import { GENERIC_ERROR_MESSAGE, newClientOperationId } from './hatoFormModel.js';
import { qrPublicUrl } from './qrToken.js';

const QR_ERROR_MESSAGES = Object.freeze({
  QR_NO_ACTIVO: 'El animal no tiene un QR activo.',
  ANIMAL_ANULADO: 'Este registro está anulado: no admite un QR nuevo.',
  ANIMAL_NOT_FOUND: 'Este animal no está disponible.',
  CLIENT_OPERATION_ID_REUSED: 'Esta operación ya se usó. Recarga la página e inténtalo nuevamente.',
  INVALID_MOTIVO: 'Escribe el motivo (máximo 500 caracteres).',
});

const ESTADO_LABELS = Object.freeze({ ACTIVO: 'Activo', REVOCADO: 'Revocado', REEMPLAZADO: 'Reemplazado' });

function qrErrorMessage(code) {
  return QR_ERROR_MESSAGES[code] ?? GENERIC_ERROR_MESSAGE;
}

function formatFecha(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('es-CO', { dateStyle: 'medium', timeStyle: 'short' });
}

export default function HatoQrPanel({ animalId, animalActivo }) {
  const [state, setState] = useState({ status: 'loading', activo: null, historial: [] });
  const [modo, setModo] = useState('ver');
  const [motivo, setMotivo] = useState('');
  const [operationId, setOperationId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [aviso, setAviso] = useState('');

  const load = useCallback(async () => {
    setState((current) => ({ ...current, status: 'loading' }));
    try {
      const { ok, data } = await getAnimalQr(animalId);
      if (ok && data) setState({ status: 'ok', activo: data.activo ?? null, historial: data.historial ?? [] });
      else setState({ status: 'error', activo: null, historial: [] });
    } catch {
      setState({ status: 'error', activo: null, historial: [] });
    }
  }, [animalId]);

  useEffect(() => {
    load();
  }, [load]);

  function abrir(nuevoModo) {
    setMotivo('');
    setError('');
    setAviso('');
    setOperationId(nuevoModo === 'reemplazar' ? newClientOperationId() : null);
    setModo(nuevoModo);
  }

  async function ejecutar(accion, mensajeExito) {
    if (saving) return;
    setSaving(true);
    setError('');
    try {
      const { ok, data } = await accion();
      if (ok) {
        setModo('ver');
        setAviso(mensajeExito);
        await load();
      } else {
        setError(qrErrorMessage(data?.error));
      }
    } catch {
      setError(GENERIC_ERROR_MESSAGE);
    } finally {
      setSaving(false);
    }
  }

  function generar() {
    ejecutar(() => asignarQr(animalId), 'QR generado.');
  }

  function confirmar(event) {
    event.preventDefault();
    const texto = motivo.trim();
    if (!texto) {
      setError(QR_ERROR_MESSAGES.INVALID_MOTIVO);
      return;
    }
    if (modo === 'revocar') {
      ejecutar(() => revocarQr(animalId, texto), 'QR revocado. El código anterior ya no abre la ficha.');
      return;
    }
    if (!operationId) {
      setError('No pudimos iniciar una operación segura. Recarga la página e inténtalo nuevamente.');
      return;
    }
    ejecutar(() => reemplazarQr(animalId, { motivo: texto, clientOperationId: operationId }), 'QR reemplazado. Imprime el nuevo código.');
  }

  async function copiarEnlace() {
    const clipboard = globalThis.navigator?.clipboard;
    if (!clipboard?.writeText) return;
    try {
      await clipboard.writeText(qrPublicUrl(state.activo.valor));
      setAviso('Enlace copiado.');
    } catch {
      setAviso('');
    }
  }

  const { activo, historial } = state;
  const anteriores = historial.filter((item) => item.estado !== 'ACTIVO');

  return (
    <section className="gan-hato-qr" aria-labelledby="gan-hato-qr-title">
      <h3 id="gan-hato-qr-title">Código QR</h3>
      {state.status === 'loading' ? <StatusMessage>Cargando QR...</StatusMessage> : null}
      {state.status === 'error' ? (
        <div className="gan-hato-actions">
          <StatusMessage type="error">No fue posible cargar el QR del animal.</StatusMessage>
          <button type="button" className="gan-secondary-button" onClick={load}>Reintentar</button>
        </div>
      ) : null}
      {aviso ? <StatusMessage type="success">{aviso}</StatusMessage> : null}

      {state.status === 'ok' && modo === 'ver' ? (
        <>
          {activo ? (
            <div className="gan-hato-ficha">
              <div className="gan-ficha-row">
                <span>Estado</span>
                <strong>Activo desde {formatFecha(activo.asignadoAt)}</strong>
              </div>
              <div className="gan-ficha-row">
                <span>Enlace del QR</span>
                <strong className="gan-hato-qr-link">{qrPublicUrl(activo.valor)}</strong>
              </div>
            </div>
          ) : (
            <p className="gan-hato-hint">Este animal no tiene un QR activo.</p>
          )}
          {error ? <StatusMessage type="error">{error}</StatusMessage> : null}
          <div className="gan-hato-actions">
            {!activo && animalActivo ? (
              <button type="button" className="gan-submit" onClick={generar} disabled={saving}>
                {saving ? 'Generando...' : 'Generar QR'}
              </button>
            ) : null}
            {activo ? (
              <>
                <button type="button" className="gan-secondary-button" onClick={copiarEnlace}>Copiar enlace</button>
                {animalActivo ? (
                  <button type="button" className="gan-secondary-button" onClick={() => abrir('reemplazar')}>Reemplazar QR</button>
                ) : null}
                <button type="button" className="gan-secondary-button" onClick={() => abrir('revocar')}>Revocar QR</button>
              </>
            ) : null}
          </div>
          {anteriores.length > 0 ? (
            <details className="gan-hato-qr-historial">
              <summary>Historial de QR ({anteriores.length})</summary>
              <ul>
                {anteriores.map((item) => (
                  <li key={item.identificadorId}>
                    {ESTADO_LABELS[item.estado] ?? item.estado} el {formatFecha(item.revocadoAt)}
                    {item.motivo ? ` — ${item.motivo}` : ''}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </>
      ) : null}

      {state.status === 'ok' && (modo === 'revocar' || modo === 'reemplazar') ? (
        <form className="gan-form" onSubmit={confirmar} noValidate>
          <StatusMessage type="info">
            {modo === 'revocar'
              ? 'Al revocar, el QR actual deja de abrir la ficha. El animal queda sin QR activo.'
              : 'Al reemplazar, el QR actual deja de funcionar y se genera uno nuevo para imprimir.'}
          </StatusMessage>
          <FormField label="Motivo" required>
            <textarea value={motivo} maxLength={500} rows={3} onChange={(event) => setMotivo(event.target.value)} disabled={saving} />
          </FormField>
          {error ? <StatusMessage type="error">{error}</StatusMessage> : null}
          <div className="gan-hato-actions">
            <button type="submit" className="gan-submit" disabled={saving}>
              {saving ? 'Guardando...' : modo === 'revocar' ? 'Confirmar revocación' : 'Confirmar reemplazo'}
            </button>
            <button type="button" className="gan-secondary-button" onClick={() => setModo('ver')} disabled={saving}>Cancelar</button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
