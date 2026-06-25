import { useState } from 'react';
import { createLeadMock } from '../services/catastroxMockService.js';

export default function CatastroXLeadForm() {
  const [sent, setSent] = useState(null);
  const [sending, setSending] = useState(false);
  const [form, setForm] = useState({
    nombre: '',
    telefono: '',
    correo: '',
    municipio: '',
    departamento: '',
    areaEstimada: '',
    necesidadPrincipal: 'Regularizar su predio',
    mensaje: '',
  });

  function updateField(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  return (
    <form
      className="catastrox-card catastrox-form"
      onSubmit={async (event) => {
        event.preventDefault();
        setSending(true);
        const response = await createLeadMock(form);
        setSent(response);
        setSending(false);
      }}
    >
      <div className="catastrox-section-heading">
        <span>Solicitud de asesoría</span>
        <h2>Cuéntenos qué necesita resolver con su predio</h2>
      </div>
      <label className="catastrox-field">
        <span>Nombre</span>
        <input value={form.nombre} onChange={(event) => updateField('nombre', event.target.value)} required />
      </label>
      <label className="catastrox-field">
        <span>Teléfono</span>
        <input value={form.telefono} onChange={(event) => updateField('telefono', event.target.value)} required />
      </label>
      <label className="catastrox-field">
        <span>Correo</span>
        <input type="email" value={form.correo} onChange={(event) => updateField('correo', event.target.value)} required />
      </label>
      <label className="catastrox-field">
        <span>Municipio</span>
        <input value={form.municipio} onChange={(event) => updateField('municipio', event.target.value)} required />
      </label>
      <label className="catastrox-field">
        <span>Departamento</span>
        <input value={form.departamento} onChange={(event) => updateField('departamento', event.target.value)} required />
      </label>
      <label className="catastrox-field">
        <span>Área aproximada</span>
        <input value={form.areaEstimada} onChange={(event) => updateField('areaEstimada', event.target.value)} required />
      </label>
      <label className="catastrox-field">
        <span>Necesidad principal</span>
        <select value={form.necesidadPrincipal} onChange={(event) => updateField('necesidadPrincipal', event.target.value)}>
          <option>Regularizar su predio</option>
          <option>Resolver una inconsistencia catastral</option>
          <option>Preparar una venta o compra</option>
          <option>Acceder a crédito</option>
          <option>Resolver un conflicto de linderos</option>
        </select>
      </label>
      <label className="catastrox-field is-full">
        <span>Mensaje</span>
        <textarea rows="4" value={form.mensaje} onChange={(event) => updateField('mensaje', event.target.value)} />
      </label>
      <button className="catastrox-button" type="submit" disabled={sending}>
        {sending ? 'Enviando...' : 'Solicitar llamada de un asesor'}
      </button>
      {sent && (
        <div className="catastrox-success">
          <strong>Solicitud registrada correctamente.</strong>
          <span>Lead: {sent.leadId}</span>
          <span>
            Un asesor revisará su caso y se comunicará para explicarle los pasos, requisitos y opciones disponibles para regularizar su predio.
          </span>
        </div>
      )}
    </form>
  );
}
