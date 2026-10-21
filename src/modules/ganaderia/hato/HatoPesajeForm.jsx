// FASE 1B: formulario controlado de nuevo pesaje (fecha, peso, método,
// observaciones). El clientOperationId NO se muestra: lo gestiona el panel.
// Labels reales, errores asociados a cada campo (aria-describedby +
// aria-invalid) y botón con texto; mientras envía, todo queda deshabilitado.
// FASE 1D.1: sin conexión el botón dice "Guardar para sincronizar" (el panel
// guarda en el outbox; no hay POST).
import { MAX_OBSERVACIONES_PESAJE, MAX_PESO_KG } from './pesajesModel.js';
import { PESO_METODOS } from './hatoFormModel.js';
import { textoBotonPesaje } from './pesajesOfflineModel.js';

function campoError(id, mensaje) {
  return mensaje ? (
    <span id={id} className="gan-field-error" role="alert">
      {mensaje}
    </span>
  ) : null;
}

export default function HatoPesajeForm({ form, errores = {}, onChange, onSubmit, saving = false, hoy, primerPesaje = false, online = true }) {
  const err = (campo) => errores[campo];
  const describedBy = (campo) => (err(campo) ? `pesaje-${campo}-error` : undefined);
  return (
    <form className="gan-form gan-pesaje-form" onSubmit={onSubmit} noValidate aria-label="Registrar pesaje">
      <div className="gan-pesaje-form-grid">
        <label className="gan-field" htmlFor="pesaje-fecha">
          <span>Fecha del pesaje</span>
          <input
            id="pesaje-fecha"
            type="date"
            value={form.fecha}
            max={hoy}
            min="1990-01-01"
            required
            disabled={saving}
            aria-invalid={err('fecha') ? 'true' : undefined}
            aria-describedby={describedBy('fecha')}
            onChange={(event) => onChange('fecha', event.target.value)}
          />
          {campoError('pesaje-fecha-error', err('fecha'))}
        </label>

        <label className="gan-field" htmlFor="pesaje-peso">
          <span>Peso (kg)</span>
          <input
            id="pesaje-peso"
            type="number"
            inputMode="decimal"
            step="0.1"
            min="0.1"
            max={MAX_PESO_KG}
            value={form.pesoKg}
            required
            disabled={saving}
            aria-invalid={err('pesoKg') ? 'true' : undefined}
            aria-describedby={describedBy('pesoKg')}
            onChange={(event) => onChange('pesoKg', event.target.value)}
          />
          {campoError('pesaje-pesoKg-error', err('pesoKg'))}
        </label>

        <label className="gan-field" htmlFor="pesaje-metodo">
          <span>Método</span>
          <select
            id="pesaje-metodo"
            value={form.metodo}
            required
            disabled={saving}
            aria-invalid={err('metodo') ? 'true' : undefined}
            aria-describedby={describedBy('metodo')}
            onChange={(event) => onChange('metodo', event.target.value)}
          >
            {PESO_METODOS.map((m) => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </select>
          {campoError('pesaje-metodo-error', err('metodo'))}
        </label>
      </div>

      <label className="gan-field" htmlFor="pesaje-observaciones">
        <span>Observaciones (opcional)</span>
        <textarea
          id="pesaje-observaciones"
          rows={2}
          maxLength={MAX_OBSERVACIONES_PESAJE}
          value={form.observaciones}
          disabled={saving}
          aria-invalid={err('observaciones') ? 'true' : undefined}
          aria-describedby={describedBy('observaciones')}
          onChange={(event) => onChange('observaciones', event.target.value)}
        />
        {campoError('pesaje-observaciones-error', err('observaciones'))}
      </label>

      <div className="gan-hato-actions">
        <button type="submit" className="gan-submit" disabled={saving} aria-busy={saving ? 'true' : undefined}>
          {textoBotonPesaje({ online, saving, primerPesaje })}
        </button>
      </div>
    </form>
  );
}
