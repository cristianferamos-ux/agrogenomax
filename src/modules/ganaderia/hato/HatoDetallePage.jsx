// SPRINT-3D11.2: ficha BÁSICA del animal (GET /api/ganaderia/animales/:id)
// + corrección de datos declarados (POST .../corregir, concurrencia
// optimista con fechaActualizacionEsperada) + anulación de un registro
// erróneo (POST .../anular, terminal). No es la ficha completa (3D11.4):
// sin línea de tiempo, pesajes manuales ni sanidad. Predio y peso no se
// corrigen aquí. SPRINT-3D11.3 (R1): incluye la sección QR (HatoQrPanel).
//
// SPRINT-3D11.3 (R1) offline-first: con el dispositivo preparado la ficha
// sale primero de la copia local (abre sin red) y, con red, se refresca del
// servidor. /animales/local:<uuid> muestra un registro aún no sincronizado;
// cuando el servidor confirma su animal_id redirige a /animales/<animal_id>.
// Corregir, anular y gestionar la chapeta requieren conexión.
import { useCallback, useEffect, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import GanaderiaBackLink from '../components/GanaderiaBackLink.jsx';
import { FormField, StatusMessage } from '../components/FormField.jsx';
import HatoAnimalFields from './HatoAnimalFields.jsx';
import HatoQrPanel from './HatoQrPanel.jsx';
import { anularAnimal, corregirAnimal, getAnimal } from './hatoApi.js';
import {
  GENERIC_ERROR_MESSAGE,
  buildCorreccionBody,
  categoriaSigueValida,
  fechaHoyLocal,
  formFromAnimal,
  formatEdad,
  formatIdentidad,
  formatOrigen,
  formatPeso,
  formatRaza,
  formatSexo,
  messageForError,
  validateAnimalForm,
} from './hatoFormModel.js';
import useHatoCatalogos from './useHatoCatalogos.js';
import { useGanaderiaOffline } from '../offline/GanaderiaOfflineProvider.jsx';
import '../styles/ganaderia-hato.css';

function Row({ label, children }) {
  return (
    <div className="gan-ficha-row">
      <span>{label}</span>
      <strong>{children}</strong>
    </div>
  );
}

function formatNacimiento(animal) {
  if (animal.nacimientoTipo === 'EXACTA') return `${animal.fechaNacimiento} (${formatEdad(animal)})`;
  return formatEdad(animal);
}

export default function HatoDetallePage() {
  const { animalId } = useParams();
  const idValido = /^(?:[1-9]\d{0,17}|local:[0-9a-f-]{36})$/i.test(String(animalId));
  const esLocal = String(animalId).startsWith('local:');
  const offline = useGanaderiaOffline();
  const local = offline.preparado && offline.repo ? offline.repo : null;
  const [chapetaLocal, setChapetaLocal] = useState(null);
  const catalogos = useHatoCatalogos({ conPredios: false });
  const [state, setState] = useState({ status: 'loading', animal: null });
  const [modo, setModo] = useState('ver');
  const [form, setForm] = useState(null);
  const [motivo, setMotivo] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [aviso, setAviso] = useState('');

  const load = useCallback(async () => {
    if (!idValido) return;
    let localEncontrado = false;
    if (local) {
      const animalLocal = await local.getAnimal(animalId).catch(() => null);
      if (animalLocal?.redirectTo) {
        setState({ status: 'redirect', animal: null, to: animalLocal.redirectTo });
        return;
      }
      if (animalLocal) {
        localEncontrado = true;
        setState({ status: 'ok', animal: animalLocal, origen: 'local' });
        setChapetaLocal(await local.getChapetaDeAnimal(animalLocal).catch(() => null));
      }
    }
    if (esLocal) {
      if (!localEncontrado) setState({ status: 'not_found', animal: null });
      return;
    }
    if (!localEncontrado) setState((current) => ({ ...current, status: 'loading' }));
    try {
      const { ok, status, data } = await getAnimal(animalId);
      if (ok && data?.animal) setState({ status: 'ok', animal: data.animal, origen: 'servidor' });
      else if (!localEncontrado) setState({ status: status === 404 ? 'not_found' : 'error', animal: null });
    } catch {
      // Sin red: se mantiene la copia local si existe.
      if (!localEncontrado) setState({ status: 'error', animal: null });
    }
  }, [animalId, idValido, esLocal, local]);

  useEffect(() => {
    load();
  }, [load]);

  // Copia local: refleja la sincronización (p. ej. local -> animal_id).
  useEffect(() => (local && esLocal ? local.subscribe(load) : undefined), [local, esLocal, load]);

  if (!idValido) return <Navigate to="/ganaderia/animales" replace />;
  if (state.status === 'redirect') return <Navigate to={`/ganaderia/animales/${state.to}`} replace />;

  // Corregir, anular y gestionar la chapeta exigen conexión y un animal ya
  // confirmado por el servidor.
  const accionesDisponibles = !esLocal && offline.online;

  const { animal } = state;

  function abrirCorreccion() {
    setForm(formFromAnimal(animal));
    setError('');
    setAviso('');
    setModo('corregir');
  }

  function update(field, value) {
    setForm((current) => {
      const next = { ...current, [field]: value };
      if (field === 'sexo' && !categoriaSigueValida(catalogos.categorias, next.categoriaProductivaId, value)) {
        next.categoriaProductivaId = '';
      }
      if (field === 'razaModo') {
        next.razaPrincipalId = '';
        next.razaOtroNombre = '';
        next.cruceDescripcion = '';
      }
      return next;
    });
  }

  async function guardarCorreccion(event) {
    event.preventDefault();
    if (saving) return;
    const problema = validateAnimalForm(form, { requirePredio: false, requirePeso: false });
    if (problema) {
      setError(problema);
      return;
    }
    setSaving(true);
    setError('');
    try {
      const { ok, data } = await corregirAnimal(animal.animalId, buildCorreccionBody(form, animal.fechaActualizacion));
      if (ok && data?.animal) {
        setState({ status: 'ok', animal: data.animal });
        setModo('ver');
        setAviso(data.sinCambios ? 'No había cambios para guardar.' : 'Datos corregidos.');
        return;
      }
      if (data?.error === 'ANIMAL_MODIFICADO') {
        setError(messageForError(data.error));
        await load();
        setModo('ver');
        return;
      }
      setError(messageForError(data?.error));
    } catch {
      setError(GENERIC_ERROR_MESSAGE);
    } finally {
      setSaving(false);
    }
  }

  async function confirmarAnulacion(event) {
    event.preventDefault();
    if (saving) return;
    if (!motivo.trim()) {
      setError('Indica el motivo de la anulación.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const { ok, data } = await anularAnimal(animal.animalId, motivo.trim());
      if (ok && data?.animal) {
        setState({ status: 'ok', animal: data.animal });
        setModo('ver');
        setAviso(data.yaAnulado ? 'Este registro ya estaba anulado.' : 'Registro anulado.');
        return;
      }
      setError(messageForError(data?.error));
    } catch {
      setError(GENERIC_ERROR_MESSAGE);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="gan-panel gan-hato">
      <GanaderiaBackLink to="/ganaderia/animales">Volver a mis animales</GanaderiaBackLink>

      {state.status === 'loading' ? <StatusMessage>Cargando animal...</StatusMessage> : null}
      {state.status === 'not_found' ? <StatusMessage type="error">Este animal no está disponible.</StatusMessage> : null}
      {state.status === 'error' ? (
        <div className="gan-hato-actions">
          <StatusMessage type="error">No fue posible cargar el animal.</StatusMessage>
          <button type="button" className="gan-secondary-button" onClick={load}>Reintentar</button>
        </div>
      ) : null}

      {state.status === 'ok' && animal ? (
        <>
          <div className="gan-section-heading">
            <span className="gan-eyebrow">Animal</span>
            <h2>{formatIdentidad(animal)}</h2>
          </div>
          {animal.estado === 'ANULADO' ? (
            <StatusMessage type="error">Registro anulado. Motivo: {animal.estadoMotivo}</StatusMessage>
          ) : null}
          {aviso ? <StatusMessage type="success">{aviso}</StatusMessage> : null}
          {animal.estadoSync === 'PENDIENTE' ? (
            <StatusMessage type="info">Registrado en este dispositivo. Se enviará automáticamente al recuperar la conexión.</StatusMessage>
          ) : null}
          {animal.estadoSync === 'CONFLICTO' || animal.estadoSync === 'RECHAZADO' ? (
            <StatusMessage type="error">
              No se pudo sincronizar este registro. Se conserva en el dispositivo.{' '}
              <Link to="/ganaderia/sincronizacion">Resolver</Link>
            </StatusMessage>
          ) : null}

          {modo === 'ver' ? (
            <>
              <div className="gan-hato-ficha">
                <Row label="Sexo">{formatSexo(animal.sexo)}</Row>
                <Row label="Raza">{formatRaza(animal)}</Row>
                <Row label="Categoría">{animal.categoriaProductivaNombre ?? 'Sin categoría'}</Row>
                <Row label="Edad">{formatNacimiento(animal)}</Row>
                <Row label="Último peso">{formatPeso(animal.ultimoPeso)}</Row>
                <Row label="Predio">{animal.predioNombre}</Row>
                <Row label="Origen">{formatOrigen(animal.origenTipo)}</Row>
                {animal.procedencia ? <Row label="Procedencia">{animal.procedencia}</Row> : null}
                {animal.fechaIngreso ? <Row label="Fecha de ingreso">{animal.fechaIngreso}</Row> : null}
                {animal.observaciones ? <Row label="Observaciones">{animal.observaciones}</Row> : null}
              </div>
              {error ? <StatusMessage type="error">{error}</StatusMessage> : null}
              {animal.estado === 'ACTIVO' && !accionesDisponibles && !esLocal ? (
                <p className="gan-hato-hint">Corregir, anular o cambiar la chapeta requiere conexión.</p>
              ) : null}
              {animal.estado === 'ACTIVO' && accionesDisponibles ? (
                <div className="gan-hato-actions">
                  <button type="button" className="gan-submit" onClick={abrirCorreccion} disabled={catalogos.status !== 'ok'}>
                    Corregir datos
                  </button>
                  <button
                    type="button"
                    className="gan-secondary-button"
                    onClick={() => {
                      setMotivo('');
                      setError('');
                      setAviso('');
                      setModo('anular');
                    }}
                  >
                    Anular registro
                  </button>
                </div>
              ) : null}
              {accionesDisponibles ? (
                <HatoQrPanel animalId={animal.animalId} animalActivo={animal.estado === 'ACTIVO'} />
              ) : (
                <section className="gan-hato-qr">
                  <h3>Chapeta QR</h3>
                  <p className="gan-hato-hint">
                    {chapetaLocal
                      ? `${chapetaLocal.codigoVisible}${chapetaLocal.reservaLocalUuid ? ' (asociación pendiente de sincronizar)' : ''}`
                      : animal.chapetaCodigo
                        ? `${animal.chapetaCodigo} (asociación pendiente de sincronizar)`
                        : 'Sin chapeta asociada en este dispositivo.'}
                  </p>
                </section>
              )}
            </>
          ) : null}

          {modo === 'corregir' && form ? (
            <form className="gan-form" onSubmit={guardarCorreccion} noValidate>
              <p className="gan-hato-hint">El predio y el peso no se corrigen desde aquí.</p>
              <HatoAnimalFields
                form={form}
                onChange={update}
                razas={catalogos.razas}
                categorias={catalogos.categorias}
                disabled={saving}
                maxFecha={fechaHoyLocal()}
              />
              {error ? <StatusMessage type="error">{error}</StatusMessage> : null}
              <div className="gan-hato-actions">
                <button type="submit" className="gan-submit" disabled={saving}>{saving ? 'Guardando...' : 'Guardar corrección'}</button>
                <button type="button" className="gan-secondary-button" onClick={() => setModo('ver')} disabled={saving}>Cancelar</button>
              </div>
            </form>
          ) : null}

          {modo === 'anular' ? (
            <form className="gan-form" onSubmit={confirmarAnulacion} noValidate>
              <StatusMessage type="info">
                Anula solo un registro hecho por error (por ejemplo, un animal duplicado). El registro se conserva como
                anulado y su número de chapeta queda libre.
              </StatusMessage>
              <FormField label="Motivo" required>
                <textarea value={motivo} maxLength={500} rows={3} onChange={(event) => setMotivo(event.target.value)} disabled={saving} />
              </FormField>
              {error ? <StatusMessage type="error">{error}</StatusMessage> : null}
              <div className="gan-hato-actions">
                <button type="submit" className="gan-submit" disabled={saving}>{saving ? 'Anulando...' : 'Confirmar anulación'}</button>
                <button type="button" className="gan-secondary-button" onClick={() => setModo('ver')} disabled={saving}>Cancelar</button>
              </div>
            </form>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
