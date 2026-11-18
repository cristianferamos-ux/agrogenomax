// FASE 5A.2 -- diálogo de anulación de un pesaje (solo online, owner/admin).
// Mismo patrón accesible que la anulación reproductiva: role="alertdialog" +
// aria-modal, foco inicial en el motivo, focus trap, ESC = Cancelar (salvo
// con el POST en curso). El motivo es obligatorio (1..500, misma regla que el
// backend) y el botón queda deshabilitado mientras se envía: un doble clic
// nunca produce dos POST (además lo garantiza crearControladorAnulacion).
// No hay DELETE: el pesaje queda en el historial marcado como anulado.
import { useEffect, useRef } from 'react';
import { StatusMessage } from '../components/FormField.jsx';
import { ADVERTENCIA_ANULACION_PESAJE, MAX_MOTIVO_ANULACION_PESAJE } from './pesajesAnulacionModel.js';
import { formatFecha, formatKg, formatMetodo } from './pesajesModel.js';

export default function HatoPesajeAnularDialog({ pesaje, motivo, setMotivo, error, fallo, enviando, onCancelar, onConfirmar }) {
  const dialogRef = useRef(null);
  const motivoRef = useRef(null);

  useEffect(() => {
    motivoRef.current?.focus();
  }, []);

  function onKeyDown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (!enviando) onCancelar();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusables = [...(dialogRef.current?.querySelectorAll('textarea, button:not([disabled])') ?? [])];
    if (!focusables.length) return;
    const primero = focusables[0];
    const ultimo = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === primero) {
      event.preventDefault();
      ultimo.focus();
    } else if (!event.shiftKey && document.activeElement === ultimo) {
      event.preventDefault();
      primero.focus();
    }
  }

  return (
    <div className="gan-cierre-overlay">
      <div
        ref={dialogRef}
        className="gan-cierre-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="pesaje-anular-titulo"
        aria-describedby="pesaje-anular-texto"
        onKeyDown={onKeyDown}
      >
        <h3 id="pesaje-anular-titulo">Anular pesaje</h3>
        <p className="gan-pesaje-anular-resumen">
          {formatKg(pesaje.pesoKg)} del {formatFecha(pesaje.fecha)} · {formatMetodo(pesaje.metodo)}
        </p>
        <p id="pesaje-anular-texto">{ADVERTENCIA_ANULACION_PESAJE}</p>
        <label className="gan-field" htmlFor="pesaje-anular-motivo">
          <span>Motivo (obligatorio)</span>
          <textarea
            id="pesaje-anular-motivo"
            ref={motivoRef}
            rows={3}
            value={motivo}
            maxLength={MAX_MOTIVO_ANULACION_PESAJE}
            required
            disabled={enviando}
            aria-invalid={error ? 'true' : undefined}
            aria-describedby={error ? 'pesaje-anular-motivo-error' : undefined}
            onChange={(event) => setMotivo(event.target.value)}
          />
          {error ? <span id="pesaje-anular-motivo-error" className="gan-field-error" role="alert">{error}</span> : null}
        </label>
        <div aria-live="polite">{fallo ? <StatusMessage type="error">{fallo}</StatusMessage> : null}</div>
        <div className="gan-hato-actions gan-cierre-dialog-acciones">
          <button type="button" className="gan-secondary-button" onClick={onCancelar} disabled={enviando}>Cancelar</button>
          <button
            type="button"
            className="gan-submit gan-cierre-confirmar"
            onClick={onConfirmar}
            disabled={enviando}
            aria-busy={enviando ? 'true' : undefined}
          >
            {enviando ? 'Anulando…' : 'Anular pesaje'}
          </button>
        </div>
      </div>
    </div>
  );
}
