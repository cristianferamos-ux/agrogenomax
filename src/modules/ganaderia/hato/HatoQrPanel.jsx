// SPRINT-3D11.3 (R1): sección "Chapeta QR" de la ficha del animal. La
// organización NO genera chapetas: usa las que el Super Admin le asignó.
//   * sin chapeta (animal activo): asociar una chapeta disponible por código;
//   * con chapeta: reemplazar por otra disponible, o reportarla
//     perdida/revocada o dañada (con motivo);
//   * historial de chapetas del animal.
// Solo POST con CSRF vía hatoApi.js; nunca reintenta automáticamente. Las
// tres acciones son idempotentes en el servidor por estado.
import { useCallback, useEffect, useState } from 'react';
import { FormField, StatusMessage } from '../components/FormField.jsx';
import { asociarQr, bajaQr, getAnimalQr, reemplazarQr } from './hatoApi.js';
import { messageForError } from './hatoFormModel.js';
import { ESTADO_CHAPETA_LABELS, normalizeCodigoChapeta } from './qrToken.js';

const CODIGO_INVALIDO = 'Revisa el código de la chapeta (forma AGX-7KM4-P2XZ).';
const MOTIVO_REQUERIDO = 'Escribe el motivo (máximo 500 caracteres).';

function formatFecha(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('es-CO', { dateStyle: 'medium', timeStyle: 'short' });
}

export default function HatoQrPanel({ animalId, animalActivo }) {
  const [state, setState] = useState({ status: 'loading', activa: null, historial: [] });
  const [modo, setModo] = useState('ver');
  const [codigo, setCodigo] = useState('');
  const [motivo, setMotivo] = useState('');
  const [causa, setCausa] = useState('REVOCADO');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [aviso, setAviso] = useState('');

  const load = useCallback(async () => {
    setState((current) => ({ ...current, status: 'loading' }));
    try {
      const { ok, data } = await getAnimalQr(animalId);
      if (ok && data) setState({ status: 'ok', activa: data.activa ?? null, historial: data.historial ?? [] });
      else setState({ status: 'error', activa: null, historial: [] });
    } catch {
      setState({ status: 'error', activa: null, historial: [] });
    }
  }, [animalId]);

  useEffect(() => {
    load();
  }, [load]);

  function abrir(nuevoModo) {
    setCodigo('');
    setMotivo('');
    setCausa('REVOCADO');
    setError('');
    setAviso('');
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
        setError(messageForError(data?.error));
      }
    } catch {
      setError(messageForError(null));
    } finally {
      setSaving(false);
    }
  }

  function confirmar(event) {
    event.preventDefault();
    const texto = motivo.trim();
    if (modo === 'asociar' || modo === 'reemplazar') {
      const codigoNormalizado = normalizeCodigoChapeta(codigo);
      if (!codigoNormalizado) {
        setError(CODIGO_INVALIDO);
        return;
      }
      if (modo === 'asociar') {
        ejecutar(() => asociarQr(animalId, codigoNormalizado), `Chapeta ${codigoNormalizado} asociada.`);
        return;
      }
      if (!texto) {
        setError(MOTIVO_REQUERIDO);
        return;
      }
      ejecutar(
        () => reemplazarQr(animalId, { codigoNuevo: codigoNormalizado, motivo: texto }),
        `Chapeta reemplazada por ${codigoNormalizado}. La anterior ya no abre la ficha.`,
      );
      return;
    }
    if (!texto) {
      setError(MOTIVO_REQUERIDO);
      return;
    }
    ejecutar(() => bajaQr(animalId, { causa, motivo: texto }), 'Chapeta dada de baja. Ya no abre la ficha.');
  }

  const { activa, historial } = state;
  const anteriores = historial.filter((item) => item.estado !== 'ASIGNADO_ANIMAL');

  return (
    <section className="gan-hato-qr" aria-labelledby="gan-hato-qr-title">
      <h3 id="gan-hato-qr-title">Chapeta QR</h3>
      {state.status === 'loading' ? <StatusMessage>Cargando chapeta...</StatusMessage> : null}
      {state.status === 'error' ? (
        <div className="gan-hato-actions">
          <StatusMessage type="error">No fue posible cargar la chapeta del animal.</StatusMessage>
          <button type="button" className="gan-secondary-button" onClick={load}>Reintentar</button>
        </div>
      ) : null}
      {aviso ? <StatusMessage type="success">{aviso}</StatusMessage> : null}

      {state.status === 'ok' && modo === 'ver' ? (
        <>
          {activa ? (
            <div className="gan-hato-ficha">
              <div className="gan-ficha-row">
                <span>Código</span>
                <strong className="gan-hato-qr-codigo">{activa.codigoVisible}</strong>
              </div>
              <div className="gan-ficha-row">
                <span>Asociada</span>
                <strong>{formatFecha(activa.asignadoAnimalAt)}</strong>
              </div>
            </div>
          ) : (
            <p className="gan-hato-hint">Este animal no tiene una chapeta QR asociada.</p>
          )}
          {error ? <StatusMessage type="error">{error}</StatusMessage> : null}
          {animalActivo ? (
            <div className="gan-hato-actions">
              {!activa ? (
                <button type="button" className="gan-submit" onClick={() => abrir('asociar')}>Asociar chapeta</button>
              ) : (
                <>
                  <button type="button" className="gan-secondary-button" onClick={() => abrir('reemplazar')}>Reemplazar chapeta</button>
                  <button type="button" className="gan-secondary-button" onClick={() => abrir('baja')}>Reportar pérdida o daño</button>
                </>
              )}
            </div>
          ) : null}
          {anteriores.length > 0 ? (
            <details className="gan-hato-qr-historial">
              <summary>Historial de chapetas ({anteriores.length})</summary>
              <ul>
                {anteriores.map((item) => (
                  <li key={item.qrId}>
                    {item.codigoVisible} — {ESTADO_CHAPETA_LABELS[item.estado] ?? item.estado} el {formatFecha(item.revocadoAt)}
                    {item.motivo ? ` (${item.motivo})` : ''}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </>
      ) : null}

      {state.status === 'ok' && modo !== 'ver' ? (
        <form className="gan-form" onSubmit={confirmar} noValidate>
          {modo === 'baja' ? (
            <>
              <StatusMessage type="info">La chapeta actual dejará de abrir la ficha. Luego puedes asociar otra.</StatusMessage>
              <FormField label="Qué pasó" required>
                <select value={causa} onChange={(event) => setCausa(event.target.value)} disabled={saving}>
                  <option value="REVOCADO">Se perdió / ya no se usa</option>
                  <option value="DANADO">Está dañada</option>
                </select>
              </FormField>
            </>
          ) : (
            <FormField label={modo === 'asociar' ? 'Código de chapeta' : 'Código de la chapeta nueva'} required>
              <input
                type="text"
                value={codigo}
                placeholder="AGX-7KM4-P2XZ"
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                onChange={(event) => setCodigo(event.target.value)}
                disabled={saving}
              />
            </FormField>
          )}
          {modo !== 'asociar' ? (
            <FormField label="Motivo" required>
              <textarea value={motivo} maxLength={500} rows={3} onChange={(event) => setMotivo(event.target.value)} disabled={saving} />
            </FormField>
          ) : null}
          {error ? <StatusMessage type="error">{error}</StatusMessage> : null}
          <div className="gan-hato-actions">
            <button type="submit" className="gan-submit" disabled={saving}>{saving ? 'Guardando...' : 'Confirmar'}</button>
            <button type="button" className="gan-secondary-button" onClick={() => setModo('ver')} disabled={saving}>Cancelar</button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
