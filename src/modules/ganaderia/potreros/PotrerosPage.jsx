import { useEffect, useState } from 'react';
import { ganaderiaApi, getRowId, getRowLabel } from '../api/ganaderiaApi.js';
import { FormField, StatusMessage } from '../components/FormField.jsx';

const initialForm = {
  predio_id: '',
  nombre: '',
  codigo: '',
  area: '',
  capacidad: '',
  estado: '',
  observaciones: '',
};

export default function PotrerosPage() {
  const [predios, setPredios] = useState([]);
  const [potreros, setPotreros] = useState([]);
  const [form, setForm] = useState(initialForm);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');

  const load = async () => {
    const [predioRows, potreroRows] = await Promise.all([
      ganaderiaApi.listPredios(),
      ganaderiaApi.listPotreros(),
    ]);
    setPredios(predioRows);
    setPotreros(potreroRows);
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
      await ganaderiaApi.createPotrero(form);
      setForm(initialForm);
      await load();
      setStatus('Potrero guardado en PostgreSQL.');
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className="gan-stack">
      <div className="gan-panel">
        <div className="gan-section-heading">
          <span className="gan-eyebrow">Registro de Potreros</span>
          <h2>Asociar potrero a predio</h2>
        </div>
        <form className="gan-form" onSubmit={submit}>
          <FormField label="Predio" required>
            <select value={form.predio_id} onChange={(event) => update('predio_id', event.target.value)} required>
              <option value="">Seleccionar predio</option>
              {predios.map((predio) => (
                <option key={getRowId(predio)} value={getRowId(predio)}>
                  {getRowLabel(predio)}
                </option>
              ))}
            </select>
          </FormField>
          <FormField label="Nombre del potrero" required>
            <input value={form.nombre} onChange={(event) => update('nombre', event.target.value)} required />
          </FormField>
          <FormField label="Código">
            <input value={form.codigo} onChange={(event) => update('codigo', event.target.value)} />
          </FormField>
          <FormField label="Área ha">
            <input type="number" value={form.area} onChange={(event) => update('area', event.target.value)} />
          </FormField>
          <FormField label="Capacidad animales">
            <input type="number" value={form.capacidad} onChange={(event) => update('capacidad', event.target.value)} />
          </FormField>
          <FormField label="Estado">
            <select value={form.estado} onChange={(event) => update('estado', event.target.value)}>
              <option value="activo">Activo</option>
              <option value="descanso">Descanso</option>
              <option value="mantenimiento">Mantenimiento</option>
            </select>
          </FormField>
          <FormField label="Observaciones">
            <textarea value={form.observaciones} onChange={(event) => update('observaciones', event.target.value)} />
          </FormField>
          <button className="gan-submit" type="submit">Guardar potrero</button>
        </form>
        <StatusMessage type="success">{status}</StatusMessage>
        <StatusMessage type="error">{error}</StatusMessage>
      </div>

      <div className="gan-panel">
        <div className="gan-section-heading">
          <span className="gan-eyebrow">Potreros existentes</span>
          <h2>{potreros.length} registros</h2>
        </div>
        <div className="gan-list">
          {potreros.map((item) => (
            <article key={getRowId(item)} className="gan-list-row">
              <strong>{getRowLabel(item)}</strong>
              <span>{item.estado || item.status || 'Sin estado'}</span>
            </article>
          ))}
        </div>
      </div>
    </div>
  );
}
