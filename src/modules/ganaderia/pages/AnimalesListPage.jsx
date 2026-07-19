import { MapPin, QrCode, Sprout } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ganaderiaApi, getRowId } from '../api/ganaderiaApi.js';
import GanaderiaBackLink from '../components/GanaderiaBackLink.jsx';
import { StatusMessage } from '../components/FormField.jsx';

function getAnimalLabel(animal) {
  return animal?.nombre || animal?.name || animal?.codigo_interno || animal?.codigo_qr || `Animal ${getRowId(animal) || ''}`;
}

function getAnimalRaza(animal) {
  return animal?.raza_principal || animal?.nombre_raza || animal?.raza || animal?.tipo_raza || 'No registrada';
}

const animalModulePaths = {
  ficha: '',
  pesajes: '/pesajes',
  vacunaciones: '/vacunaciones',
  tratamientos: '/tratamientos',
  reproduccion: '/reproduccion',
  genetica: '/genetica',
};

const animalModuleLabels = {
  ficha: 'ficha',
  pesajes: 'pesajes',
  vacunaciones: 'vacunaciones',
  tratamientos: 'tratamientos',
  reproduccion: 'reproducción',
  genetica: 'genética',
};

export default function AnimalesListPage() {
  const [searchParams] = useSearchParams();
  const requestedModule = searchParams.get('modulo');
  const hasValidRequestedModule = !requestedModule || Object.hasOwn(animalModulePaths, requestedModule);
  const [animales, setAnimales] = useState([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    ganaderiaApi.listAnimales()
      .then((rows) => {
        if (!active) return;
        setAnimales(Array.isArray(rows) ? rows : []);
      })
      .catch((err) => {
        console.error('No fue posible cargar animales de Ganadería.', err);
        if (!active) return;
        setError('No fue posible cargar los animales de tu cuenta. Intenta nuevamente.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return animales;
    return animales.filter((animal) =>
      [animal.nombre, animal.codigo_interno, animal.codigo_qr, animal.sexo, getAnimalRaza(animal), animal.nombre_predio, animal.nombre_potrero]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle)),
    );
  }, [animales, query]);

  return (
    <div className="gan-panel">
      <GanaderiaBackLink to="/ganaderia/dashboard">Volver al dashboard</GanaderiaBackLink>
      <div className="gan-section-heading">
        <span className="gan-eyebrow">Inventario real</span>
        <h2>Mis animales</h2>
        <p>Busca y abre animales registrados sin depender únicamente del QR físico.</p>
      </div>

      {requestedModule && hasValidRequestedModule ? (
        <StatusMessage>
          Selecciona un animal para abrir {animalModuleLabels[requestedModule]}.
        </StatusMessage>
      ) : null}

      {requestedModule && !hasValidRequestedModule ? (
        <StatusMessage type="error">
          El módulo solicitado no está disponible desde esta vista.
        </StatusMessage>
      ) : null}

      {requestedModule && !hasValidRequestedModule ? (
        <div className="gan-action-row">
          <Link className="gan-secondary-button" to="/ganaderia/animales/listado">
            Ver listado sin módulo
          </Link>
          <Link className="gan-secondary-button" to="/ganaderia/dashboard">
            Volver al dashboard
          </Link>
        </div>
      ) : null}

      <div className="gan-manual-qr">
        <label className="gan-field">
          <span>Buscar animal</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Nombre, código interno, QR, predio o potrero"
            aria-label="Buscar animal"
          />
        </label>
      </div>

      <StatusMessage type="error">{error}</StatusMessage>

      {!loading && !error && animales.length === 0 ? (
        <div className="gan-breed-box">
          <div className="gan-section-heading">
            <span className="gan-eyebrow">Sin animales registrados</span>
            <h3>Aún no hay animales registrados.</h3>
            <p>Primero registra el predio con los datos de su propietario y un potrero; luego valida un QR para crear el animal.</p>
          </div>
          <div className="gan-action-row">
            <Link className="gan-secondary-button" to="/ganaderia/predios">
              <MapPin className="h-4 w-4" />
              Registrar predio
            </Link>
            <Link className="gan-secondary-button" to="/ganaderia/potreros">
              <Sprout className="h-4 w-4" />
              Registrar potrero
            </Link>
            <Link className="gan-secondary-button" to="/ganaderia/escanear-qr">
              <QrCode className="h-4 w-4" />
              Escanear QR
            </Link>
          </div>
        </div>
      ) : null}

      {loading ? <StatusMessage>Cargando animales registrados...</StatusMessage> : null}

      {filtered.length > 0 ? (
        <div className="gan-form">
          {filtered.map((animal) => {
            const id = getRowId(animal);
            const animalPath = id && hasValidRequestedModule
              ? `/ganaderia/animal/${id}${requestedModule ? animalModulePaths[requestedModule] : ''}`
              : '';
            return (
              <div className="gan-breed-box" key={id || animal.codigo_qr || animal.codigo_interno}>
                <strong>{getAnimalLabel(animal)}</strong>
                <div className="gan-ficha-row">
                  <span>Código interno / QR</span>
                  <strong>{animal.codigo_interno || 'Sin código interno'} · {animal.codigo_qr || 'Sin QR visible'}</strong>
                </div>
                <div className="gan-ficha-row">
                  <span>Sexo / raza</span>
                  <strong>{animal.sexo || 'Sexo no registrado'} · {getAnimalRaza(animal)}</strong>
                </div>
                <div className="gan-ficha-row">
                  <span>Ubicación</span>
                  <strong>{animal.nombre_predio || 'Predio no registrado'} / {animal.nombre_potrero || 'Potrero no registrado'}</strong>
                </div>
                {id && hasValidRequestedModule ? (
                  <Link className="gan-secondary-button" to={animalPath}>
                    {hasValidRequestedModule && requestedModule ? `Abrir ${animalModuleLabels[requestedModule]}` : 'Abrir ficha'}
                  </Link>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}

      {!loading && animales.length > 0 && filtered.length === 0 ? (
        <StatusMessage>No hay animales que coincidan con la búsqueda.</StatusMessage>
      ) : null}

      <div className="gan-action-row">
        <Link className="gan-secondary-button" to="/ganaderia/predios">
          <MapPin className="h-4 w-4" />
          Registrar predio
        </Link>
        <Link className="gan-secondary-button" to="/ganaderia/potreros">
          <Sprout className="h-4 w-4" />
          Registrar potrero
        </Link>
        <Link className="gan-secondary-button" to="/ganaderia/escanear-qr">
          <QrCode className="h-4 w-4" />
          Escanear QR
        </Link>
      </div>
    </div>
  );
}
