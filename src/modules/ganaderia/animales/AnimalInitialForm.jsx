import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
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
  estado: '',
  observaciones: '',
  tipo_raza: '',
};

function isCommaDecimalInput(value) {
  return /^\d*(,\d{0,2})?$/.test(value);
}

function isValidCommaDecimal(value) {
  return value === '' || /^\d+(,\d{1,2})?$/.test(value);
}

function toApiDecimal(value) {
  return value === '' ? '' : value.replace(',', '.');
}

export default function AnimalInitialForm({ codigoQr, onCreated }) {
  const [form, setForm] = useState(initialForm);
  const [predios, setPredios] = useState([]);
  const [potreros, setPotreros] = useState([]);
  const [razas, setRazas] = useState([]);
  const [selectedRazas, setSelectedRazas] = useState([]);
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
  const hasPredios = predios.length > 0;
  const hasPotreros = potreros.length > 0;

  const update = (field, value) => setForm((current) => ({ ...current, [field]: value }));
  const updateWeight = (field, value) => {
    if (isCommaDecimalInput(value)) update(field, value);
  };
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

    if (!codigoQr) return setError('El código QR es obligatorio para registrar el animal.');
    if (!form.predio_id) return setError('Selecciona un predio.');
    if (!form.potrero_id) return setError('Selecciona un potrero asociado al predio.');
    if (!['Macho', 'Hembra'].includes(form.sexo)) return setError('Selecciona sexo Macho o Hembra.');
    if (!form.fecha_nacimiento) return setError('La fecha de nacimiento es obligatoria para registrar el animal.');
    if (!['puro', 'cruzado'].includes(form.tipo_raza)) return setError('Selecciona si el animal es puro o cruzado.');
    if (!isValidCommaDecimal(form.peso_nacimiento)) return setError('Ingresa el peso al nacimiento con coma y máximo dos decimales. Ejemplo: 56,45.');
    if (form.tipo_raza === 'cruzado' && selectedRazas.some((item) => !item.raza_id || Number(item.porcentaje || 0) <= 0)) {
      return setError('Selecciona cada raza e ingresa porcentajes mayores a cero.');
    }
    if (form.tipo_raza === 'cruzado' && Math.round(razaTotal * 100) / 100 !== 100) {
      return setError('La suma de porcentajes raciales debe ser 100%.');
    }
    if (!selectedRazas[0]?.raza_id) return setError('Selecciona al menos una raza.');
    if (form.tipo_raza === 'puro' && Number(selectedRazas[0]?.porcentaje || 0) !== 100) {
      return setError('Para un animal puro, la raza seleccionada debe representar el 100%.');
    }

    const razasPayload = selectedRazas.filter((item) => item.raza_id);

    try {
      const animal = await ganaderiaApi.createAnimal({
        codigo_qr: codigoQr,
        predio_id: form.predio_id,
        potrero_id: form.potrero_id,
        codigo_interno: form.codigo_interno,
        nombre: form.nombre,
        sexo: form.sexo,
        fecha_nacimiento: form.fecha_nacimiento,
        peso_nacimiento: toApiDecimal(form.peso_nacimiento),
        color: form.color,
        numero_arete: form.numero_arete,
        estado: form.estado,
        observaciones: form.observaciones,
        tipo_raza: form.tipo_raza,
        razas: razasPayload,
      });
      setStatus('Animal guardado y QR asociado a tu cuenta.');
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
          <select value={form.predio_id} onChange={(event) => update('predio_id', event.target.value)} required disabled={!hasPredios}>
            <option value="">{hasPredios ? 'Selecciona un predio registrado' : 'No hay predios registrados'}</option>
            {predios.map((predio) => (
              <option key={getRowId(predio)} value={getRowId(predio)}>{getRowLabel(predio)}</option>
            ))}
          </select>
        </FormField>
        <FormField label="Potrero" required>
          <select value={form.potrero_id} onChange={(event) => update('potrero_id', event.target.value)} required disabled={!form.predio_id || !hasPotreros}>
            <option value="">
              {!form.predio_id
                ? 'Primero selecciona un predio'
                : hasPotreros
                  ? 'Selecciona un potrero registrado'
                  : 'Este predio aún no tiene potreros registrados'}
            </option>
            {potreros.map((potrero) => (
              <option key={potrero.potrero_id ?? getRowId(potrero)} value={potrero.potrero_id ?? getRowId(potrero)}>{getRowLabel(potrero)}</option>
            ))}
          </select>
        </FormField>
        {!hasPredios ? (
          <div className="gan-action-row">
            <StatusMessage>Selecciona un predio registrado antes de crear animales.</StatusMessage>
            <Link className="gan-secondary-button" to="/ganaderia/predios">Crear predio</Link>
          </div>
        ) : null}
        {form.predio_id && !hasPotreros ? (
          <div className="gan-action-row">
            <StatusMessage>Este predio aún no tiene potreros registrados.</StatusMessage>
            <Link className="gan-secondary-button" to="/ganaderia/potreros">Crear potrero</Link>
          </div>
        ) : null}
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
        <FormField label="Fecha de nacimiento" required>
          <input type="date" value={form.fecha_nacimiento} onChange={(event) => update('fecha_nacimiento', event.target.value)} required />
        </FormField>
        <FormField label="Peso al nacimiento">
          <input
            inputMode="decimal"
            pattern="[0-9]+(,[0-9]{1,2})?"
            placeholder="56,45"
            value={form.peso_nacimiento}
            onChange={(event) => updateWeight('peso_nacimiento', event.target.value)}
          />
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
            <span className="gan-eyebrow">Composición racial</span>
            <h3>Selecciona el tipo y las razas registradas</h3>
          </div>
          <div className="gan-segment">
            <button type="button" className={form.tipo_raza === 'puro' ? 'is-active' : ''} onClick={() => {
              update('tipo_raza', 'puro');
              setSelectedRazas([{ raza_id: selectedRazas[0]?.raza_id || '', porcentaje: 100 }]);
            }}>Animal puro</button>
            <button type="button" className={form.tipo_raza === 'cruzado' ? 'is-active' : ''} onClick={() => {
              update('tipo_raza', 'cruzado');
              setSelectedRazas(selectedRazas.length ? selectedRazas : [{ raza_id: '', porcentaje: '' }]);
            }}>Animal cruzado</button>
          </div>

          {form.tipo_raza ? selectedRazas.map((item, index) => (
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
          )) : null}
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
