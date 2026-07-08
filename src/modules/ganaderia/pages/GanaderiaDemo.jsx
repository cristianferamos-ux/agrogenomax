import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Beef,
  ClipboardList,
  Dna,
  FileBarChart,
  LayoutDashboard,
  MapPin,
  QrCode,
  RotateCcw,
  Scale,
  Sprout,
  Syringe,
} from 'lucide-react';
import GanaderiaDemoNotice from '../components/GanaderiaDemoNotice.jsx';
import { loadDemoData, saveDemoData, resetDemoData, generateId, generateQrCodigo } from '../data/ganaderiaDemoData.js';
import { buildDemoReportPdfBlob, downloadBlob } from '../utils/demoPdf.js';
import '../styles/ganaderia-dashboard.css';
import '../styles/ganaderia-demo.css';

const tabs = [
  { id: 'resumen', label: 'Resumen', icon: LayoutDashboard },
  { id: 'animales', label: 'Animales', icon: Beef },
  { id: 'predios', label: 'Predios y potreros', icon: MapPin },
  { id: 'pesajes', label: 'Pesajes', icon: Scale },
  { id: 'sanidad', label: 'Sanidad', icon: Syringe },
  { id: 'reproduccion', label: 'Reproducción', icon: Dna },
  { id: 'qr', label: 'QR', icon: QrCode },
  { id: 'fichas', label: 'Fichas', icon: ClipboardList },
  { id: 'reportes', label: 'Reportes', icon: FileBarChart },
];

export default function GanaderiaDemo() {
  const [data, setData] = useState(() => loadDemoData());
  const [activeTab, setActiveTab] = useState('resumen');

  const update = (updater) => {
    setData((current) => {
      const next = updater(current);
      saveDemoData(next);
      return next;
    });
  };

  const handleReset = () => {
    setData(resetDemoData());
    setActiveTab('resumen');
  };

  return (
    <div className="gan-dash-shell">
      <nav className="gan-dash-sidebar" aria-label="Secciones de la demo">
        <div className="gan-dash-sidebar-brand">
          <QrCode size={20} />
          <span>Demo Ganadería</span>
        </div>
        <div className="gan-dash-sidebar-links">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                type="button"
                className={`gan-dash-sidebar-link${activeTab === tab.id ? ' is-active' : ''}`}
                onClick={() => setActiveTab(tab.id)}
              >
                <Icon size={18} />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>
      </nav>

      <main className="gan-dash-main">
        <Link to="/ganaderia/acceso" className="gan-dash-back">
          ← Volver a Ganadería Inteligente
        </Link>
        <GanaderiaDemoNotice />

        <header className="gan-dash-header">
          <div>
            <span className="gan-dash-badge">Modo Demo</span>
            <h1>Versión Demo interactiva</h1>
            <p>Registra animales, predios, pesajes, sanidad y reproducción de prueba. Nada de esto afecta datos reales.</p>
          </div>
          <div className="gan-dash-header-actions">
            <button type="button" className="gan-dash-btn is-outline" onClick={handleReset}>
              <RotateCcw size={16} /> Reiniciar demo
            </button>
          </div>
        </header>

        {activeTab === 'resumen' && <ResumenTab data={data} />}
        {activeTab === 'animales' && <AnimalesTab data={data} update={update} />}
        {activeTab === 'predios' && <PrediosTab data={data} update={update} />}
        {activeTab === 'pesajes' && <PesajesTab data={data} update={update} />}
        {activeTab === 'sanidad' && <SanidadTab data={data} update={update} />}
        {activeTab === 'reproduccion' && <ReproduccionTab data={data} update={update} />}
        {activeTab === 'qr' && <QrTab data={data} update={update} />}
        {activeTab === 'fichas' && <FichasTab data={data} />}
        {activeTab === 'reportes' && <ReportesTab data={data} />}
      </main>
    </div>
  );
}

function ResumenTab({ data }) {
  const metrics = [
    { label: 'Animales de prueba', value: data.animales.length },
    { label: 'Predios de prueba', value: data.predios.length },
    { label: 'Potreros de prueba', value: data.potreros.length },
    { label: 'Pesajes registrados', value: data.pesajes.length },
    { label: 'Vacunas registradas', value: data.vacunas.length },
    { label: 'Tratamientos registrados', value: data.tratamientos.length },
    { label: 'Eventos reproductivos', value: data.reproduccion.length },
  ];

  return (
    <section className="gan-dash-section">
      <h2>Resumen de la sesión demo</h2>
      <div className="gan-dash-metrics-grid">
        {metrics.map((metric) => (
          <article key={metric.label} className="gan-dash-metric-card">
            <span className="gan-dash-metric-icon">
              <ClipboardList size={20} />
            </span>
            <div>
              <strong>{metric.value}</strong>
              <span>{metric.label}</span>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function AnimalesTab({ data, update }) {
  const [form, setForm] = useState({
    nombre: '',
    especie: 'Bovino',
    sexo: 'Hembra',
    predioId: data.predios[0]?.id || '',
    potreroId: data.potreros[0]?.id || '',
    marcaHierro: '',
    numeroHierro: '',
  });

  const handleSubmit = (event) => {
    event.preventDefault();
    if (!form.nombre.trim()) return;

    update((current) => ({
      ...current,
      animales: [
        ...current.animales,
        {
          id: generateId('animal'),
          ...form,
          qrCodigo: generateQrCodigo(),
          fechaRegistro: new Date().toISOString(),
        },
      ],
    }));
    setForm((prev) => ({ ...prev, nombre: '', marcaHierro: '', numeroHierro: '' }));
  };

  return (
    <section className="gan-dash-section">
      <h2>Registrar animal de prueba</h2>
      <form className="gan-demo-form" onSubmit={handleSubmit}>
        <label>
          Nombre o identificador
          <input value={form.nombre} onChange={(e) => setForm({ ...form, nombre: e.target.value })} required />
        </label>
        <label>
          Especie
          <select value={form.especie} onChange={(e) => setForm({ ...form, especie: e.target.value })}>
            <option>Bovino</option>
            <option>Bufalino</option>
            <option>Equino</option>
          </select>
        </label>
        <label>
          Sexo
          <select value={form.sexo} onChange={(e) => setForm({ ...form, sexo: e.target.value })}>
            <option>Hembra</option>
            <option>Macho</option>
          </select>
        </label>
        <label>
          Predio
          <select value={form.predioId} onChange={(e) => setForm({ ...form, predioId: e.target.value })}>
            <option value="">Sin asignar</option>
            {data.predios.map((p) => (
              <option key={p.id} value={p.id}>
                {p.nombre}
              </option>
            ))}
          </select>
        </label>
        <label>
          Potrero
          <select value={form.potreroId} onChange={(e) => setForm({ ...form, potreroId: e.target.value })}>
            <option value="">Sin asignar</option>
            {data.potreros.map((p) => (
              <option key={p.id} value={p.id}>
                {p.nombre}
              </option>
            ))}
          </select>
        </label>
        <label>
          Marca de hierro
          <input value={form.marcaHierro} onChange={(e) => setForm({ ...form, marcaHierro: e.target.value })} />
        </label>
        <label>
          Número de hierro
          <input value={form.numeroHierro} onChange={(e) => setForm({ ...form, numeroHierro: e.target.value })} />
        </label>
        <button type="submit" className="gan-dash-btn is-primary">
          Registrar animal
        </button>
      </form>

      <h2 className="gan-demo-list-title">Animales registrados en la demo ({data.animales.length})</h2>
      <div className="gan-demo-table">
        {data.animales.map((animal) => (
          <div key={animal.id} className="gan-demo-table-row">
            <strong>{animal.nombre}</strong>
            <span>{animal.especie} · {animal.sexo}</span>
            <span>QR: {animal.qrCodigo}</span>
          </div>
        ))}
        {data.animales.length === 0 && <p className="gan-demo-empty">Aún no hay animales de prueba registrados.</p>}
      </div>
    </section>
  );
}

function PrediosTab({ data, update }) {
  const [predio, setPredio] = useState({ nombre: '', ubicacion: '' });
  const [potrero, setPotrero] = useState({ nombre: '', predioId: data.predios[0]?.id || '', capacidad: '' });

  const submitPredio = (event) => {
    event.preventDefault();
    if (!predio.nombre.trim()) return;
    update((current) => ({ ...current, predios: [...current.predios, { id: generateId('predio'), ...predio }] }));
    setPredio({ nombre: '', ubicacion: '' });
  };

  const submitPotrero = (event) => {
    event.preventDefault();
    if (!potrero.nombre.trim() || !potrero.predioId) return;
    update((current) => ({
      ...current,
      potreros: [...current.potreros, { id: generateId('potrero'), ...potrero, capacidad: Number(potrero.capacidad) || 0 }],
    }));
    setPotrero({ nombre: '', predioId: data.predios[0]?.id || '', capacidad: '' });
  };

  return (
    <section className="gan-dash-section">
      <h2>Crear predio de prueba</h2>
      <form className="gan-demo-form" onSubmit={submitPredio}>
        <label>
          Nombre del predio
          <input value={predio.nombre} onChange={(e) => setPredio({ ...predio, nombre: e.target.value })} required />
        </label>
        <label>
          Ubicación
          <input value={predio.ubicacion} onChange={(e) => setPredio({ ...predio, ubicacion: e.target.value })} />
        </label>
        <button type="submit" className="gan-dash-btn is-primary">
          Crear predio
        </button>
      </form>

      <h2 className="gan-demo-list-title">Crear potrero de prueba</h2>
      <form className="gan-demo-form" onSubmit={submitPotrero}>
        <label>
          Nombre del potrero
          <input value={potrero.nombre} onChange={(e) => setPotrero({ ...potrero, nombre: e.target.value })} required />
        </label>
        <label>
          Predio
          <select value={potrero.predioId} onChange={(e) => setPotrero({ ...potrero, predioId: e.target.value })}>
            {data.predios.map((p) => (
              <option key={p.id} value={p.id}>
                {p.nombre}
              </option>
            ))}
          </select>
        </label>
        <label>
          Capacidad (animales)
          <input type="number" value={potrero.capacidad} onChange={(e) => setPotrero({ ...potrero, capacidad: e.target.value })} />
        </label>
        <button type="submit" className="gan-dash-btn is-primary">
          Crear potrero
        </button>
      </form>

      <div className="gan-demo-columns">
        <div>
          <h3>Predios ({data.predios.length})</h3>
          {data.predios.map((p) => (
            <div key={p.id} className="gan-demo-table-row">
              <strong>{p.nombre}</strong>
              <span>{p.ubicacion || 'Sin ubicación'}</span>
            </div>
          ))}
        </div>
        <div>
          <h3>Potreros ({data.potreros.length})</h3>
          {data.potreros.map((p) => (
            <div key={p.id} className="gan-demo-table-row">
              <strong>{p.nombre}</strong>
              <span>Capacidad: {p.capacidad || 0}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function AnimalSelect({ data, value, onChange }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} required>
      <option value="">Selecciona un animal</option>
      {data.animales.map((animal) => (
        <option key={animal.id} value={animal.id}>
          {animal.nombre}
        </option>
      ))}
    </select>
  );
}

function PesajesTab({ data, update }) {
  const [form, setForm] = useState({ animalId: '', peso: '' });

  const handleSubmit = (event) => {
    event.preventDefault();
    if (!form.animalId || !form.peso) return;
    update((current) => ({
      ...current,
      pesajes: [...current.pesajes, { id: generateId('pesaje'), animalId: form.animalId, peso: Number(form.peso), fecha: new Date().toISOString() }],
    }));
    setForm({ animalId: '', peso: '' });
  };

  return (
    <section className="gan-dash-section">
      <h2>Registrar pesaje de prueba</h2>
      <form className="gan-demo-form" onSubmit={handleSubmit}>
        <label>
          Animal
          <AnimalSelect data={data} value={form.animalId} onChange={(v) => setForm({ ...form, animalId: v })} />
        </label>
        <label>
          Peso (kg)
          <input type="number" value={form.peso} onChange={(e) => setForm({ ...form, peso: e.target.value })} required />
        </label>
        <button type="submit" className="gan-dash-btn is-primary">
          Registrar pesaje
        </button>
      </form>

      <h2 className="gan-demo-list-title">Historial de pesajes ({data.pesajes.length})</h2>
      <div className="gan-demo-table">
        {data.pesajes.map((item) => (
          <div key={item.id} className="gan-demo-table-row">
            <strong>{data.animales.find((a) => a.id === item.animalId)?.nombre || 'Animal eliminado'}</strong>
            <span>{item.peso} kg</span>
            <span>{new Date(item.fecha).toLocaleDateString('es-CO')}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function SanidadTab({ data, update }) {
  const [vacuna, setVacuna] = useState({ animalId: '', nombre: '' });
  const [tratamiento, setTratamiento] = useState({ animalId: '', tipo: '', observacion: '' });

  const submitVacuna = (event) => {
    event.preventDefault();
    if (!vacuna.animalId || !vacuna.nombre.trim()) return;
    update((current) => ({
      ...current,
      vacunas: [...current.vacunas, { id: generateId('vacuna'), ...vacuna, fecha: new Date().toISOString() }],
    }));
    setVacuna({ animalId: '', nombre: '' });
  };

  const submitTratamiento = (event) => {
    event.preventDefault();
    if (!tratamiento.animalId || !tratamiento.tipo.trim()) return;
    update((current) => ({
      ...current,
      tratamientos: [...current.tratamientos, { id: generateId('tratamiento'), ...tratamiento, fecha: new Date().toISOString() }],
    }));
    setTratamiento({ animalId: '', tipo: '', observacion: '' });
  };

  return (
    <section className="gan-dash-section">
      <h2>Registrar vacuna de prueba</h2>
      <form className="gan-demo-form" onSubmit={submitVacuna}>
        <label>
          Animal
          <AnimalSelect data={data} value={vacuna.animalId} onChange={(v) => setVacuna({ ...vacuna, animalId: v })} />
        </label>
        <label>
          Vacuna aplicada
          <input value={vacuna.nombre} onChange={(e) => setVacuna({ ...vacuna, nombre: e.target.value })} required />
        </label>
        <button type="submit" className="gan-dash-btn is-primary">
          Registrar vacuna
        </button>
      </form>

      <h2 className="gan-demo-list-title">Registrar tratamiento de prueba</h2>
      <form className="gan-demo-form" onSubmit={submitTratamiento}>
        <label>
          Animal
          <AnimalSelect data={data} value={tratamiento.animalId} onChange={(v) => setTratamiento({ ...tratamiento, animalId: v })} />
        </label>
        <label>
          Tipo de tratamiento
          <input value={tratamiento.tipo} onChange={(e) => setTratamiento({ ...tratamiento, tipo: e.target.value })} required />
        </label>
        <label>
          Observación
          <input value={tratamiento.observacion} onChange={(e) => setTratamiento({ ...tratamiento, observacion: e.target.value })} />
        </label>
        <button type="submit" className="gan-dash-btn is-primary">
          Registrar tratamiento
        </button>
      </form>

      <div className="gan-demo-columns">
        <div>
          <h3>Vacunas ({data.vacunas.length})</h3>
          {data.vacunas.map((v) => (
            <div key={v.id} className="gan-demo-table-row">
              <strong>{data.animales.find((a) => a.id === v.animalId)?.nombre}</strong>
              <span>{v.nombre}</span>
            </div>
          ))}
        </div>
        <div>
          <h3>Tratamientos ({data.tratamientos.length})</h3>
          {data.tratamientos.map((t) => (
            <div key={t.id} className="gan-demo-table-row">
              <strong>{data.animales.find((a) => a.id === t.animalId)?.nombre}</strong>
              <span>{t.tipo}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function ReproduccionTab({ data, update }) {
  const [form, setForm] = useState({ animalId: '', evento: 'Servicio' });

  const handleSubmit = (event) => {
    event.preventDefault();
    if (!form.animalId) return;
    update((current) => ({
      ...current,
      reproduccion: [...current.reproduccion, { id: generateId('reproduccion'), ...form, fecha: new Date().toISOString() }],
    }));
    setForm({ animalId: '', evento: 'Servicio' });
  };

  return (
    <section className="gan-dash-section">
      <h2>Registrar evento reproductivo de prueba</h2>
      <form className="gan-demo-form" onSubmit={handleSubmit}>
        <label>
          Animal
          <AnimalSelect data={data} value={form.animalId} onChange={(v) => setForm({ ...form, animalId: v })} />
        </label>
        <label>
          Evento
          <select value={form.evento} onChange={(e) => setForm({ ...form, evento: e.target.value })}>
            <option>Servicio</option>
            <option>Diagnóstico de preñez</option>
            <option>Parto</option>
            <option>Destete</option>
          </select>
        </label>
        <button type="submit" className="gan-dash-btn is-primary">
          Registrar evento
        </button>
      </form>

      <h2 className="gan-demo-list-title">Eventos reproductivos ({data.reproduccion.length})</h2>
      <div className="gan-demo-table">
        {data.reproduccion.map((item) => (
          <div key={item.id} className="gan-demo-table-row">
            <strong>{data.animales.find((a) => a.id === item.animalId)?.nombre}</strong>
            <span>{item.evento}</span>
            <span>{new Date(item.fecha).toLocaleDateString('es-CO')}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function QrTab({ data, update }) {
  const regenerar = (animalId) => {
    update((current) => ({
      ...current,
      animales: current.animales.map((a) => (a.id === animalId ? { ...a, qrCodigo: generateQrCodigo() } : a)),
    }));
  };

  return (
    <section className="gan-dash-section">
      <h2>Códigos QR digitales de prueba</h2>
      <div className="gan-demo-qr-grid">
        {data.animales.map((animal) => (
          <article key={animal.id} className="gan-demo-qr-card">
            <div className="gan-demo-qr-pattern" aria-hidden="true" />
            <strong>{animal.nombre}</strong>
            <code>{animal.qrCodigo}</code>
            <button type="button" className="gan-dash-btn is-outline" onClick={() => regenerar(animal.id)}>
              Generar nuevo QR
            </button>
          </article>
        ))}
        {data.animales.length === 0 && <p className="gan-demo-empty">Registra un animal para generar su QR digital.</p>}
      </div>
    </section>
  );
}

function FichasTab({ data }) {
  const [animalId, setAnimalId] = useState(data.animales[0]?.id || '');
  const animal = data.animales.find((a) => a.id === animalId);

  const historial = useMemo(() => {
    if (!animal) return null;
    return {
      pesajes: data.pesajes.filter((p) => p.animalId === animal.id),
      vacunas: data.vacunas.filter((v) => v.animalId === animal.id),
      tratamientos: data.tratamientos.filter((t) => t.animalId === animal.id),
      reproduccion: data.reproduccion.filter((r) => r.animalId === animal.id),
    };
  }, [animal, data]);

  return (
    <section className="gan-dash-section">
      <h2>Consultar ficha animal</h2>
      <label className="gan-demo-select-inline">
        Animal
        <select value={animalId} onChange={(e) => setAnimalId(e.target.value)}>
          {data.animales.map((a) => (
            <option key={a.id} value={a.id}>
              {a.nombre}
            </option>
          ))}
        </select>
      </label>

      {animal && historial ? (
        <div className="gan-demo-ficha">
          <div className="gan-demo-ficha-head">
            <strong>{animal.nombre}</strong>
            <span>{animal.especie} · {animal.sexo}</span>
            <span>QR: {animal.qrCodigo}</span>
            <span>Marca/número de hierro: {animal.marcaHierro || '—'} / {animal.numeroHierro || '—'}</span>
          </div>
          <div className="gan-demo-columns">
            <div>
              <h3>Pesajes ({historial.pesajes.length})</h3>
              {historial.pesajes.map((p) => (
                <div key={p.id} className="gan-demo-table-row">
                  <span>{p.peso} kg</span>
                </div>
              ))}
            </div>
            <div>
              <h3>Sanidad</h3>
              {historial.vacunas.map((v) => (
                <div key={v.id} className="gan-demo-table-row">
                  <span>Vacuna: {v.nombre}</span>
                </div>
              ))}
              {historial.tratamientos.map((t) => (
                <div key={t.id} className="gan-demo-table-row">
                  <span>Tratamiento: {t.tipo}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <p className="gan-demo-empty">Registra un animal para ver su ficha.</p>
      )}
    </section>
  );
}

function ReportesTab({ data }) {
  const handleDescargar = () => {
    const lines = [
      `Animales de prueba: ${data.animales.length}`,
      `Predios de prueba: ${data.predios.length}`,
      `Potreros de prueba: ${data.potreros.length}`,
      `Pesajes registrados: ${data.pesajes.length}`,
      `Vacunas registradas: ${data.vacunas.length}`,
      `Tratamientos registrados: ${data.tratamientos.length}`,
      `Eventos reproductivos: ${data.reproduccion.length}`,
      '',
      'Este informe fue generado en Modo Demo con datos de prueba.',
      'No corresponde a informacion real de clientes de AgroGenomaX.',
    ];
    const blob = buildDemoReportPdfBlob('Informe demo - Ganaderia Inteligente', lines);
    downloadBlob(blob, 'informe-demo-ganaderia-inteligente.pdf');
  };

  return (
    <section className="gan-dash-section">
      <h2>Reportes de prueba</h2>
      <p className="gan-demo-report-text">
        Genera un informe con los datos actuales de tu sesión demo y descárgalo en PDF de prueba.
      </p>
      <button type="button" className="gan-dash-btn is-primary" onClick={handleDescargar}>
        Descargar informe PDF de prueba
      </button>
    </section>
  );
}
