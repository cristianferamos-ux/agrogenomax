import { useEffect, useMemo, useState } from 'react';
import { ganaderiaApi, getRowId, getRowLabel } from '../api/ganaderiaApi.js';
import { FormField, StatusMessage } from '../components/FormField.jsx';

const initialForm = {
  predio_id: '',
  potrero_id: '',
  codigo_interno: '',
  nombre: '',
  sexo: '',
  fecha_nacimiento: '',
  peso_nacimiento: '',
  color: '',
  numero_arete: '',
  estado: 'activo',
  observaciones: '',
  tipo_raza: 'puro',
};

export default function AnimalInitialForm({ codigoQr, onCreated }) {
  const [form, setForm] = useState(initialForm);
  const [predios, setPredios] = useState([]);
  const [potreros, setPotreros] = useState([]);
  const [razas, setRazas] = useState([]);
  const [selectedRazas, setSelectedRazas] = useState([{ raza_id: '', porcentaje: 100 }]);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');

  useEffect(() => {
    Promise.all([ganaderiaApi.listPredios(), ganaderiaApi.listRazas()])
      .then(([predioRows, razaRows]) => {
        setPredios(predioRows);
        setRazas(razaRows);
      })
      .catch((err) => setError(err.message));
  }, []);

  useEffect(() => {
    if (!form.predio_id) {
      setPotreros([]);
      return;
    }
    ganaderiaApi.listPotreros(form.predio_id).then(setPotreros).catch((err) => setError(err.message));
  }, [form.predio_id]);

  const razaTotal = useMemo(
    () => selectedRazas.reduce((sum, item) => sum + Number(item.porcentaje || 0), 0),
    [selectedRazas],
  );

  const update = (field, value) => setForm((current) => ({ ...current, [field]: value }));
  const updateRaza = (index, field, value) => {
    setSelectedRazas((current) =>
      current.map((item, itemIndex) => (itemIndex === index ? { ...item, [field]: value } : item)),
    );
  };

  const addRaza = () => {
    setSelectedRazas((current) => [...current, { raza_id: '', porcentaje: 0 }]);
  };

  const removeRaza = (index) => {
    setSelectedRazas((current) => current.filter((_, itemIndex) => itemIndex !== index));
  };

  const submit = async (event) => {
    event.preventDefault();
    setError('');
    setStatus('');

    if (!form.predio_id) return setError('Selecciona un predio.');
    if (!form.potrero_id) return setError('Selecciona un potrero asociado al predio.');
    if (!['Macho', 'Hembra'].includes(form.sexo)) return setError('Selecciona sexo Macho o Hembra.');
    if (form.tipo_raza === 'cruzado' && Math.round(razaTotal * 100) / 100 !== 100) {
      return setError('La suma de porcentajes raciales debe ser 100%.');
    }
    if (!selectedRazas[0]?.raza_id) return setError('Selecciona al menos una raza.');

    try {
      const animal = await ganaderiaApi.createAnimal({
        ...form,
        codigo_qr: codigoQr,
        razas: selectedRazas.filter((item) => item.raza_id),
      });
      setStatus('Animal guardado y QR asociado en PostgreSQL.');
      onCreated?.({ ...animal, id: animal.id || animal.animal_id });
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className="gan-panel">
      <div className="gan-section-heading">
        <span className="gan-eyebrow">Registro inicial de animal</span>
        <h2>QR validado: {codigoQr}</h2>
      </div>
      <form className="gan-form" onSubmit={submit}>
        <FormField label="Código QR">
          <input value={codigoQr} readOnly />
        </FormField>
        <FormField label="Predio" required>
          <select value={form.predio_id} onChange={(event) => update('predio_id', event.target.value)} required>
            <option value="">Seleccionar predio</option>
            {predios.map((predio) => (
              <option key={getRowId(predio)} value={getRowId(predio)}>{getRowLabel(predio)}</option>
            ))}
          </select>
        </FormField>
        <FormField label="Potrero" required>
          <select value={form.potrero_id} onChange={(event) => update('potrero_id', event.target.value)} required>
            <option value="">Seleccionar potrero</option>
            {potreros.map((potrero) => (
              <option key={getRowId(potrero)} value={getRowId(potrero)}>{getRowLabel(potrero)}</option>
            ))}
          </select>
        </FormField>
        <FormField label="Código interno">
          <input value={form.codigo_interno} onChange={(event) => update('codigo_interno', event.target.value)} />
        </FormField>
        <FormField label="Nombre del animal">
          <input value={form.nombre} onChange={(event) => update('nombre', event.target.value)} />
        </FormField>
        <FormField label="Sexo" required>
          <select value={form.sexo} onChange={(event) => update('sexo', event.target.value)} required>
            <option value="">Seleccionar</option>
            <option>Macho</option>
            <option>Hembra</option>
          </select>
        </FormField>
        <FormField label="Fecha de nacimiento">
          <input type="date" value={form.fecha_nacimiento} onChange={(event) => update('fecha_nacimiento', event.target.value)} />
        </FormField>
        <FormField label="Peso al nacimiento">
          <input type="number" value={form.peso_nacimiento} onChange={(event) => update('peso_nacimiento', event.target.value)} />
        </FormField>
        <FormField label="Color">
          <input value={form.color} onChange={(event) => update('color', event.target.value)} />
        </FormField>
        <FormField label="Número de arete">
          <input value={form.numero_arete} onChange={(event) => update('numero_arete', event.target.value)} />
        </FormField>
        <FormField label="Estado">
          <select value={form.estado} onChange={(event) => update('estado', event.target.value)}>
            <option value="activo">Activo</option>
            <option value="inactivo">Inactivo</option>
            <option value="vendido">Vendido</option>
          </select>
        </FormField>
        <FormField label="Observaciones">
          <textarea value={form.observaciones} onChange={(event) => update('observaciones', event.target.value)} />
        </FormField>

        <div className="gan-breed-box">
          <div className="gan-section-heading">
            <span className="gan-eyebrow">Razas</span>
            <h3>Tipo racial</h3>
          </div>
          <div className="gan-segment">
            <button type="button" className={form.tipo_raza === 'puro' ? 'is-active' : ''} onClick={() => {
              update('tipo_raza', 'puro');
              setSelectedRazas([{ raza_id: selectedRazas[0]?.raza_id || '', porcentaje: 100 }]);
            }}>Puro</button>
            <button type="button" className={form.tipo_raza === 'cruzado' ? 'is-active' : ''} onClick={() => update('tipo_raza', 'cruzado')}>Cruzado</button>
          </div>

          {selectedRazas.map((item, index) => (
            <div className="gan-breed-row" key={`${index}-${item.raza_id}`}>
              <select value={item.raza_id} onChange={(event) => updateRaza(index, 'raza_id', event.target.value)}>
                <option value="">Seleccionar raza</option>
                {razas.map((raza) => (
                  <option key={getRowId(raza)} value={getRowId(raza)}>{getRowLabel(raza)}</option>
                ))}
              </select>
              <input
                type="number"
                value={item.porcentaje}
                disabled={form.tipo_raza === 'puro'}
                onChange={(event) => updateRaza(index, 'porcentaje', event.target.value)}
              />
              {form.tipo_raza === 'cruzado' && selectedRazas.length > 1 ? (
                <button type="button" onClick={() => removeRaza(index)}>Quitar</button>
              ) : null}
            </div>
          ))}
          {form.tipo_raza === 'cruzado' ? (
            <div className="gan-action-row">
              <button type="button" className="gan-secondary-button" onClick={addRaza}>Agregar raza</button>
              <span className={razaTotal === 100 ? 'gan-total-ok' : 'gan-total-bad'}>Total: {razaTotal}%</span>
            </div>
          ) : null}
        </div>

        <button className="gan-submit" type="submit">Guardar animal y asociar QR</button>
      </form>
      <StatusMessage type="success">{status}</StatusMessage>
      <StatusMessage type="error">{error}</StatusMessage>
    </div>
  );
}
