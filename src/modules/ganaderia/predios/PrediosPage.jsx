import { useEffect, useState } from 'react';
import { ganaderiaApi, getRowId, getRowLabel } from '../api/ganaderiaApi.js';
import { FormField, StatusMessage } from '../components/FormField.jsx';

const initialForm = {
  nombre: '',
  codigo: '',
  propietario: '',
  documento: '',
  telefono: '',
  correo: '',
  departamento: '',
  municipio: '',
  vereda: '',
  area_total: '',
  observaciones: '',
};

export default function PrediosPage() {
  const [items, setItems] = useState([]);
  const [form, setForm] = useState(initialForm);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');

  const load = async () => {
    setItems(await ganaderiaApi.listPredios());
  };

  useEffect(() => {
    load().catch((err) => setError(err.message));
  }, []);

  const update = (field, value) => setForm((current) => ({ ...current, [field]: value }));

  const submit = async (event) => {
    event.preventDefault();
    setError('');
    setStatus('');

    try {
      await ganaderiaApi.createPredio(form);
      setForm(initialForm);
      await load();
      setStatus('Predio guardado en PostgreSQL.');
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className="gan-stack">
      <div className="gan-panel">
        <div className="gan-section-heading">
          <span className="gan-eyebrow">Registro de Predio</span>
          <h2>Datos básicos del predio</h2>
        </div>
        <form className="gan-form" onSubmit={submit}>
          <FormField label="Nombre del predio" required>
            <input value={form.nombre} onChange={(event) => update('nombre', event.target.value)} required />
          </FormField>
          <FormField label="Código interno">
            <input value={form.codigo} onChange={(event) => update('codigo', event.target.value)} />
          </FormField>
          <FormField label="Propietario">
            <input value={form.propietario} onChange={(event) => update('propietario', event.target.value)} />
          </FormField>
          <FormField label="Documento / NIT">
            <input value={form.documento} onChange={(event) => update('documento', event.target.value)} />
          </FormField>
          <FormField label="Teléfono">
            <input value={form.telefono} onChange={(event) => update('telefono', event.target.value)} />
          </FormField>
          <FormField label="Correo">
            <input type="email" value={form.correo} onChange={(event) => update('correo', event.target.value)} />
          </FormField>
          <FormField label="Departamento">
            <input value={form.departamento} onChange={(event) => update('departamento', event.target.value)} />
          </FormField>
          <FormField label="Municipio">
            <input value={form.municipio} onChange={(event) => update('municipio', event.target.value)} />
          </FormField>
          <FormField label="Vereda">
            <input value={form.vereda} onChange={(event) => update('vereda', event.target.value)} />
          </FormField>
          <FormField label="Área total ha">
            <input type="number" value={form.area_total} onChange={(event) => update('area_total', event.target.value)} />
          </FormField>
          <FormField label="Observaciones">
            <textarea value={form.observaciones} onChange={(event) => update('observaciones', event.target.value)} />
          </FormField>
          <button className="gan-submit" type="submit">Guardar predio</button>
        </form>
        <StatusMessage type="success">{status}</StatusMessage>
        <StatusMessage type="error">{error}</StatusMessage>
      </div>

      <div className="gan-panel">
        <div className="gan-section-heading">
          <span className="gan-eyebrow">Predios existentes</span>
          <h2>{items.length} registros</h2>
        </div>
        <div className="gan-list">
          {items.map((item) => (
            <article key={getRowId(item)} className="gan-list-row">
              <strong>{getRowLabel(item)}</strong>
              <span>{item.municipio || item.municipality || item.departamento || item.department || 'Sin ubicación'}</span>
            </article>
          ))}
        </div>
      </div>
    </div>
  );
}
