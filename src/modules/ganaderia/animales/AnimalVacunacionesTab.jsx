import { Save } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ganaderiaApi } from '../api/ganaderiaApi.js';
import { FormField, StatusMessage } from '../components/FormField.jsx';

const LABORATORIOS = [
  'Vecol',
  'Zoetis',
  'MSD Salud Animal',
  'Boehringer Ingelheim',
  'Virbac',
  'Ourofino',
  'Calier',
  'Carval',
  'Genfar',
  'Erma',
  'Otro',
];

const DOSIS = [
  'Primera dosis',
  'Segunda dosis',
  'Tercera dosis',
  'Refuerzo',
  'Revacunación',
  'Campaña oficial',
  'Dosis única',
  'Otro',
];

function todayLocal() {
  const now = new Date();
  const timezoneOffset = now.getTimezoneOffset() * 60000;
  return new Date(now.getTime() - timezoneOffset).toISOString().slice(0, 10);
}

function emptyForm() {
  return {
    catalogo_vacuna_id: '',
    fecha_aplicacion: todayLocal(),
    lote: '',
    laboratorio: '',
    laboratorio_manual: '',
    dosis: '',
    dosis_manual: '',
    proxima_aplicacion: '',
    observaciones: '',
  };
}

function formatDate(value) {
  return value ? String(value).slice(0, 10) : '—';
}

function alertClass(alerta) {
  if (alerta === 'Vencida') return 'is-danger';
  if (alerta === 'Próxima a vencer') return 'is-warning';
  if (alerta === 'Vigente') return 'is-ok';
  return '';
}

function vaccineLabel(row) {
  return row.nombre_vacuna || row.vacuna || `Vacuna ${row.catalogo_vacuna_id}`;
}

function resolveOptionValue(selected, manual) {
  return selected === 'Otro' ? manual.trim() : selected;
}

export default function AnimalVacunacionesTab({ animalId }) {
  const [catalogo, setCatalogo] = useState([]);
  const [vacunaciones, setVacunaciones] = useState([]);
  const [form, setForm] = useState(emptyForm);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');

  const load = async () => {
    if (!animalId) return;
    setLoading(true);
    setError('');
    try {
      const [catalogoRows, vacunacionRows] = await Promise.all([
        ganaderiaApi.listCatalogoVacunas(),
        ganaderiaApi.listAnimalVacunaciones(animalId),
      ]);
      setCatalogo(catalogoRows);
      setVacunaciones(vacunacionRows);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [animalId]);

  const update = (field, value) => setForm((current) => ({ ...current, [field]: value }));

  const submit = async (event) => {
    event.preventDefault();
    setError('');
    setStatus('');

    if (!animalId) {
      setError('No hay animal válido para registrar vacunación.');
      return;
    }

    if (!form.catalogo_vacuna_id) {
      setError('Selecciona una vacuna del catálogo.');
      return;
    }

    if (!form.fecha_aplicacion) {
      setError('La fecha de aplicación es obligatoria.');
      return;
    }

    const laboratorioFinal = resolveOptionValue(form.laboratorio, form.laboratorio_manual);
    const dosisFinal = resolveOptionValue(form.dosis, form.dosis_manual);

    if (form.laboratorio === 'Otro' && !laboratorioFinal) {
      setError('Especifica el laboratorio.');
      return;
    }

    if (form.dosis === 'Otro' && !dosisFinal) {
      setError('Especifica la dosis.');
      return;
    }

    try {
      await ganaderiaApi.createVacunacion({
        animal_id: animalId,
        catalogo_vacuna_id: form.catalogo_vacuna_id,
        fecha_aplicacion: form.fecha_aplicacion,
        lote: form.lote,
        laboratorio: laboratorioFinal,
        dosis: dosisFinal,
        proxima_aplicacion: form.proxima_aplicacion,
        observaciones: form.observaciones,
      });
      setForm(emptyForm());
      setStatus('Vacunación registrada en PostgreSQL');
      await load();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className="gan-stack">
      <form className="gan-form" onSubmit={submit}>
        <FormField label="Vacuna">
          <select value={form.catalogo_vacuna_id} onChange={(event) => update('catalogo_vacuna_id', event.target.value)} required>
            <option value="">Seleccionar vacuna del catálogo</option>
            {catalogo.map((vacuna) => (
              <option key={vacuna.catalogo_vacuna_id} value={vacuna.catalogo_vacuna_id}>
                {vaccineLabel(vacuna)}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label="Fecha aplicación">
          <input type="date" value={form.fecha_aplicacion} onChange={(event) => update('fecha_aplicacion', event.target.value)} required />
        </FormField>
        <FormField label="Próxima aplicación">
          <input type="date" value={form.proxima_aplicacion} onChange={(event) => update('proxima_aplicacion', event.target.value)} />
        </FormField>
        <FormField label="Lote">
          <input value={form.lote} onChange={(event) => update('lote', event.target.value)} />
        </FormField>
        <FormField label="Laboratorio">
          <select value={form.laboratorio} onChange={(event) => update('laboratorio', event.target.value)}>
            <option value="">Seleccionar laboratorio</option>
            {LABORATORIOS.map((laboratorio) => (
              <option key={laboratorio} value={laboratorio}>
                {laboratorio}
              </option>
            ))}
          </select>
        </FormField>
        {form.laboratorio === 'Otro' ? (
          <FormField label="Especifique laboratorio">
            <input value={form.laboratorio_manual} onChange={(event) => update('laboratorio_manual', event.target.value)} required />
          </FormField>
        ) : null}
        <FormField label="Dosis">
          <select value={form.dosis} onChange={(event) => update('dosis', event.target.value)}>
            <option value="">Seleccionar dosis</option>
            {DOSIS.map((dosis) => (
              <option key={dosis} value={dosis}>
                {dosis}
              </option>
            ))}
          </select>
        </FormField>
        {form.dosis === 'Otro' ? (
          <FormField label="Especifique dosis">
            <input value={form.dosis_manual} onChange={(event) => update('dosis_manual', event.target.value)} required />
          </FormField>
        ) : null}
        <FormField label="Observaciones">
          <textarea value={form.observaciones} onChange={(event) => update('observaciones', event.target.value)} />
        </FormField>
        <button className="gan-submit" type="submit">
          <Save className="h-5 w-5" />
          Guardar vacunación
        </button>
      </form>

      {!catalogo.length && !loading ? (
        <p className="gan-empty-text">No hay vacunas activas en el catálogo sanitario.</p>
      ) : null}
      <StatusMessage type="success">{status}</StatusMessage>
      <StatusMessage type="error">{error}</StatusMessage>

      <div className="gan-breed-box">
        <div className="gan-section-heading">
          <span className="gan-eyebrow">Historial sanitario</span>
          <h3>Vacunaciones registradas</h3>
        </div>
        {loading ? (
          <p className="gan-empty-text">Cargando vacunaciones...</p>
        ) : vacunaciones.length ? (
          <div className="gan-vaccine-list">
            {vacunaciones.map((vacunacion) => (
              <article className="gan-vaccine-row" key={vacunacion.vacunacion_id}>
                <div>
                  <strong>{vaccineLabel(vacunacion)}</strong>
                  <span>Fecha aplicación: {formatDate(vacunacion.fecha_aplicacion)}</span>
                  <span>Próxima aplicación: {formatDate(vacunacion.proxima_aplicacion || vacunacion.fecha_proxima)}</span>
                  <span>Laboratorio: {vacunacion.laboratorio || '—'}</span>
                  <span>Lote: {vacunacion.lote || '—'}</span>
                  <span>Dosis: {vacunacion.dosis || '—'}</span>
                </div>
                <span className={`gan-alert-pill ${alertClass(vacunacion.alerta)}`}>{vacunacion.alerta || 'Sin próxima aplicación'}</span>
                {vacunacion.observaciones ? <small>{vacunacion.observaciones}</small> : null}
              </article>
            ))}
          </div>
        ) : (
          <p className="gan-empty-text">Sin vacunaciones registradas.</p>
        )}
      </div>
    </div>
  );
}
