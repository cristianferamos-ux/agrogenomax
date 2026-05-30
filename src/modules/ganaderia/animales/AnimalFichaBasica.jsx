import { ArrowLeft, Save } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ganaderiaApi } from '../api/ganaderiaApi.js';
import { FormField, StatusMessage } from '../components/FormField.jsx';
import AnimalPesajesTab from './AnimalPesajesTab.jsx';
import AnimalVacunacionesTab from './AnimalVacunacionesTab.jsx';

const fields = [
  ['codigo_interno', 'Codigo interno'],
  ['nombre', 'Nombre'],
  ['sexo', 'Sexo'],
  ['fecha_nacimiento', 'Fecha de nacimiento'],
  ['peso_nacimiento', 'Peso nacimiento'],
  ['color', 'Color'],
  ['numero_arete', 'Numero de arete'],
  ['estado', 'Estado'],
  ['observaciones', 'Observaciones'],
];

function valueOf(animal, field) {
  const aliases = {
    codigo_interno: ['codigo_interno', 'codigo', 'internal_code', 'code'],
    fecha_nacimiento: ['fecha_nacimiento', 'birth_date'],
    peso_nacimiento: ['peso_nacimiento', 'peso_nacimiento_kg', 'birth_weight_kg'],
    numero_arete: ['numero_arete', 'arete', 'tag_number'],
    observaciones: ['observaciones', 'notes'],
    nombre: ['nombre', 'name'],
    sexo: ['sexo', 'sex'],
    estado: ['estado', 'status'],
    color: ['color'],
  };
  return aliases[field]?.map((key) => animal?.[key]).find((value) => value !== undefined && value !== null) || '';
}

export default function AnimalFichaBasica() {
  const { id } = useParams();
  const [animal, setAnimal] = useState(null);
  const [form, setForm] = useState({});
  const [razas, setRazas] = useState([]);
  const [activeTab, setActiveTab] = useState('general');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');

  useEffect(() => {
    Promise.all([ganaderiaApi.getAnimal(id), ganaderiaApi.getAnimalRazas(id)])
      .then(([row, razaRows]) => {
        setAnimal(row);
        setRazas(razaRows);
        setForm(Object.fromEntries(fields.map(([field]) => [field, valueOf(row, field)])));
      })
      .catch((err) => setError(err.message));
  }, [id]);

  const update = (field, value) => setForm((current) => ({ ...current, [field]: value }));

  const submit = async (event) => {
    event.preventDefault();
    setError('');
    setStatus('');
    try {
      const updated = await ganaderiaApi.updateAnimal(id, form);
      setAnimal(updated);
      setStatus('Ficha basica actualizada en PostgreSQL.');
    } catch (err) {
      setError(err.message);
    }
  };

  if (!animal && !error) {
    return <div className="gan-panel">Cargando ficha animal...</div>;
  }

  return (
    <div className="gan-stack">
      <div className="gan-panel">
        <Link to="/ganaderia/animales" className="gan-back-inline">
          <ArrowLeft className="h-4 w-4" />
          Volver a QR
        </Link>
        <div className="gan-section-heading">
          <span className="gan-eyebrow">Ficha Animal</span>
          <h2>{valueOf(animal, 'nombre') || valueOf(animal, 'codigo_interno') || `Animal ${id}`}</h2>
          <p>Vista basica del animal. Las pestanas clinicas y productivas adicionales quedan para fases posteriores.</p>
        </div>
        <div className="gan-ficha-tabs">
          <button className={activeTab === 'general' ? 'is-active' : ''} type="button" onClick={() => setActiveTab('general')}>
            Informacion general
          </button>
          <button className={activeTab === 'pesajes' ? 'is-active' : ''} type="button" onClick={() => setActiveTab('pesajes')}>
            Pesajes
          </button>
          <button className={activeTab === 'vacunaciones' ? 'is-active' : ''} type="button" onClick={() => setActiveTab('vacunaciones')}>
            Vacunaciones
          </button>
          <button type="button" disabled>Tratamientos</button>
          <button type="button" disabled>Reproduccion</button>
          <button type="button" disabled>Genetica</button>
          <button type="button" disabled>Historial QR</button>
        </div>

        {activeTab === 'general' ? (
          <>
            <div className="gan-breed-box">
              <div className="gan-section-heading">
                <span className="gan-eyebrow">Composicion racial</span>
                <h3>Razas registradas en PostgreSQL</h3>
              </div>
              {razas.length ? (
                <div className="gan-list">
                  {razas.map((raza) => (
                    <article className="gan-list-row" key={raza.animal_raza_id || `${raza.raza_id}-${raza.porcentaje}`}>
                      <strong>{raza.nombre_raza || `Raza ${raza.raza_id}`}</strong>
                      <span>{raza.porcentaje}%</span>
                    </article>
                  ))}
                </div>
              ) : (
                <p className="gan-empty-text">Sin composicion racial registrada.</p>
              )}
            </div>
            <form className="gan-form" onSubmit={submit}>
              <FormField label="Codigo interno">
                <input value={form.codigo_interno || ''} onChange={(event) => update('codigo_interno', event.target.value)} />
              </FormField>
              <FormField label="Nombre">
                <input value={form.nombre || ''} onChange={(event) => update('nombre', event.target.value)} />
              </FormField>
              <FormField label="Sexo">
                <select value={form.sexo || ''} onChange={(event) => update('sexo', event.target.value)}>
                  <option value="">Seleccionar</option>
                  <option>Macho</option>
                  <option>Hembra</option>
                </select>
              </FormField>
              <FormField label="Fecha de nacimiento">
                <input type="date" value={String(form.fecha_nacimiento || '').slice(0, 10)} onChange={(event) => update('fecha_nacimiento', event.target.value)} />
              </FormField>
              <FormField label="Peso nacimiento">
                <input type="number" value={form.peso_nacimiento || ''} onChange={(event) => update('peso_nacimiento', event.target.value)} />
              </FormField>
              <FormField label="Color">
                <input value={form.color || ''} onChange={(event) => update('color', event.target.value)} />
              </FormField>
              <FormField label="Numero de arete">
                <input value={form.numero_arete || ''} onChange={(event) => update('numero_arete', event.target.value)} />
              </FormField>
              <FormField label="Estado">
                <input value={form.estado || ''} onChange={(event) => update('estado', event.target.value)} />
              </FormField>
              <FormField label="Observaciones">
                <textarea value={form.observaciones || ''} onChange={(event) => update('observaciones', event.target.value)} />
              </FormField>
              <button className="gan-submit" type="submit">
                <Save className="h-5 w-5" />
                Guardar cambios
              </button>
            </form>
            <StatusMessage type="success">{status}</StatusMessage>
            <StatusMessage type="error">{error}</StatusMessage>
          </>
        ) : activeTab === 'pesajes' ? (
          <AnimalPesajesTab animalId={id} />
        ) : (
          <AnimalVacunacionesTab animalId={id} />
        )}
      </div>
    </div>
  );
}
