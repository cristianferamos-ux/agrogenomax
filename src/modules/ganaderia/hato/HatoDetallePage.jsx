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
//
// FASE 1B: la ficha se organiza en pestañas "Resumen" (contenido previo) y
// "Pesajes" (HatoPesajesPanel: historial, KPIs, gráfica y registro). La
// pestaña Pesajes solo existe para animales ya confirmados por el servidor.
// FASE 1D.1: el panel recibe el repositorio offline (outbox) para guardar
// pesajes sin conexión; un animal local (sin animal_id) no tiene pestaña.
// FASE 1D.2: pestaña "Actividad" (línea de tiempo derivada). Se monta al
// abrirla por primera vez y queda montada (oculta) al cambiar de pestaña;
// `actividadVersion` marca cambios (pesaje confirmado, corrección,
// anulación, chapeta QR) para recargarla abierta o al volver a abrirla.
//
// FASE 2B: dos ejes SEPARADOS -- "Estado del registro" (ACTIVO/ANULADO) y
// "Situación del animal" (EN_HATO/SALIDO/MUERTO; fallback EN_HATO). El
// bloque Situación del Resumen muestra el cierre (fecha, motivo/causa,
// observaciones) aunque el registro quede ANULADO. Registrar salida/muerte
// (HatoCierreAnimal) solo para ACTIVO + EN_HATO + rol owner|admin y con red.
//
// FASE 4B: pestaña "Reproducción" (HatoReproduccionPanel, backend 4A). Como
// Actividad, se monta al abrirla y queda montada; cada evento registrado,
// anulado o corregido marca la Actividad para recargarla.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, Navigate, useParams, useSearchParams } from 'react-router-dom';
import GanaderiaBackLink from '../components/GanaderiaBackLink.jsx';
import { FormField, StatusMessage } from '../components/FormField.jsx';
import HatoAnimalFields from './HatoAnimalFields.jsx';
import HatoQrPanel from './HatoQrPanel.jsx';
import HatoPesajesPanel from './HatoPesajesPanel.jsx';
import HatoActividadPanel from './HatoActividadPanel.jsx';
import HatoReproduccionPanel from './HatoReproduccionPanel.jsx';
import HatoCierreAnimal from './HatoCierreAnimal.jsx';
import { ETIQUETAS_ESTADO_REGISTRO, ETIQUETAS_SITUACION, bloqueSituacion, situacionDe } from './cierreModel.js';
import { useGanaderiaPermisos } from '../auth/useGanaderiaPermisos.js';
import { useGanaderiaAuthOptional } from '../auth/GanaderiaAuthContext.jsx';
import {
  ESTADO_INICIAL_FICHA,
  MENSAJE_CARGA_ANIMAL,
  cargarFicha,
  crearControlCargas,
  crearGuardEdicion,
  debeRefrescarAlReconectar,
  estadoDeServidor,
  puedeActualizarManual,
  repoDeOrganizacion,
  vistaFicha,
} from './fichaCargaModel.js';
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
import { mensajeError } from '../api/errorModel.js';

function Row({ label, children }) {
  return (
    <div className="gan-ficha-row">
      <span>{label}</span>
      <strong>{children}</strong>
    </div>
  );
}

const PESTANAS = Object.freeze([
  { id: 'resumen', label: 'Resumen' },
  { id: 'pesajes', label: 'Pesajes' },
  { id: 'reproduccion', label: 'Reproducción' },
  { id: 'actividad', label: 'Actividad' },
]);

// Pestañas accesibles (patrón WAI-ARIA tabs): flechas izquierda/derecha,
// Inicio/Fin; solo la pestaña activa es tabulable.
function FichaTabs({ activa, onChange }) {
  function onKeyDown(event) {
    const indice = PESTANAS.findIndex((p) => p.id === activa);
    const destino = {
      ArrowRight: (indice + 1) % PESTANAS.length,
      ArrowLeft: (indice - 1 + PESTANAS.length) % PESTANAS.length,
      Home: 0,
      End: PESTANAS.length - 1,
    }[event.key];
    if (destino === undefined) return;
    event.preventDefault();
    onChange(PESTANAS[destino].id);
    document.getElementById(`ficha-tab-${PESTANAS[destino].id}`)?.focus();
  }
  return (
    <div className="gan-hato-tabs" role="tablist" aria-label="Secciones del animal">
      {PESTANAS.map((p) => (
        <button
          key={p.id}
          type="button"
          role="tab"
          id={`ficha-tab-${p.id}`}
          aria-selected={activa === p.id}
          aria-controls={`ficha-panel-${p.id}`}
          tabIndex={activa === p.id ? 0 : -1}
          className={activa === p.id ? 'is-active' : undefined}
          onClick={() => onChange(p.id)}
          onKeyDown={onKeyDown}
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}

function SituacionAnimal({ animal }) {
  const bloque = bloqueSituacion(animal);
  return (
    <section className={`gan-situacion gan-situacion-${bloque.situacion.toLowerCase()}`} aria-labelledby="situacion-titulo">
      <h3 id="situacion-titulo">Situación</h3>
      <p className="gan-situacion-estado"><strong>{bloque.titulo}</strong></p>
      {bloque.filas.length ? (
        <div className="gan-hato-ficha">
          {bloque.filas.map(([label, valor]) => <Row key={label} label={label}>{valor}</Row>)}
        </div>
      ) : null}
    </section>
  );
}

function formatNacimiento(animal) {
  if (animal.nacimientoTipo === 'EXACTA') return `${animal.fechaNacimiento} (${formatEdad(animal)})`;
  return formatEdad(animal);
}

export default function HatoDetallePage() {
  const { animalId } = useParams();
  // FASE 4C: ?pestana=<id> abre esa pestaña (el tablero reproductivo enlaza
  // con ?pestana=reproduccion). Un valor desconocido se ignora.
  const [searchParams] = useSearchParams();
  const pestanaInicial = PESTANAS.some((p) => p.id === searchParams.get('pestana')) ? searchParams.get('pestana') : 'resumen';
  const idValido = /^(?:[1-9]\d{0,17}|local:[0-9a-f-]{36})$/i.test(String(animalId));
  const esLocal = String(animalId).startsWith('local:');
  const offline = useGanaderiaOffline();
  // Rol de la organización activa (resuelto por el servidor en /session):
  // solo decide qué se MUESTRA; el servidor vuelve a exigirlo (RBAC).
  // FASE 3A: capacidades desde la matriz central (auth/ganaderiaPermisos.js).
  const permisos = useGanaderiaPermisos();
  const rol = permisos.rol;
  // C1: la ficha y la copia local quedan ligadas a la organización activa. Cada
  // organización tiene su propia base IndexedDB; un repositorio de otra (p. ej. en
  // plena transición del proveedor) no se lee.
  const organizacionId = useGanaderiaAuthOptional()?.organizacionActiva?.organizacionId ?? null;
  const repoOrg = repoDeOrganizacion(offline.repo, organizacionId);
  const local = offline.preparado ? repoOrg : null;
  const claveFicha = `${organizacionId}:${animalId}`;
  const [chapetaLocal, setChapetaLocal] = useState(null);
  const [tieneQrActiva, setTieneQrActiva] = useState(false);
  const catalogos = useHatoCatalogos({ conPredios: false });
  const [state, setState] = useState(ESTADO_INICIAL_FICHA);
  const cargasRef = useRef(null);
  if (!cargasRef.current) cargasRef.current = crearControlCargas();
  const cargas = cargasRef.current;
  const [modo, setModo] = useState('ver');
  const guardRef = useRef(null);
  if (!guardRef.current) guardRef.current = crearGuardEdicion();
  const guard = guardRef.current;
  const [form, setForm] = useState(null);
  // C2: versión con la que se abrió la corrección (token de concurrencia optimista).
  const [versionCorreccion, setVersionCorreccion] = useState(null);
  const [motivo, setMotivo] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [aviso, setAviso] = useState('');
  const [pestana, setPestana] = useState(pestanaInicial);
  const [actividadAbierta, setActividadAbierta] = useState(pestanaInicial === 'actividad');
  const [reproduccionAbierta, setReproduccionAbierta] = useState(pestanaInicial === 'reproduccion');
  const [actividadVersion, setActividadVersion] = useState(0);
  const marcarActividad = useCallback(() => setActividadVersion((v) => v + 1), []);
  const cambiarPestana = useCallback((id) => {
    setPestana(id);
    if (id === 'actividad') setActividadAbierta(true);
    if (id === 'reproduccion') setReproduccionAbierta(true);
  }, []);

  // silencioso (FASE 1B): refresca la ficha sin pasar por "cargando" (tras
  // registrar un pesaje, para no desmontar la pestaña ni su mensaje).
  // Issue #116: la decisión de estado vive en fichaCargaModel.js. Solo la carga más
  // reciente toca el estado y un fallo remoto no retira una copia ya visible.
  // C2: con una corrección/anulación abierta ninguna carga toca la entidad base;
  // se aplaza hasta cerrarla.
  const load = useCallback(async ({ silencioso = false } = {}) => {
    if (!idValido || !guard.solicitar()) return;
    const clave = `${organizacionId}:${animalId}`;
    await cargarFicha({
      routeId: animalId,
      organizacionId,
      esLocal,
      local,
      obtenerRemoto: getAnimal,
      silencioso,
      control: cargas,
      setState,
      setChapetaLocal: (valor) => setChapetaLocal({ clave, valor }),
    });
  }, [animalId, organizacionId, idValido, esLocal, local, cargas, guard]);

  const abrirEdicion = useCallback((siguiente) => {
    guard.abrir();
    cargas.invalidar();
    setModo(siguiente);
  }, [guard, cargas]);
  const cerrarEdicion = useCallback(({ refrescar = true } = {}) => {
    const pendiente = guard.cerrar();
    setModo('ver');
    if (refrescar && pendiente) load({ silencioso: true });
  }, [guard, load]);

  // Cambio de animal u organización con una edición abierta: se descarta (el
  // formulario era de otra ficha). Va antes del efecto de carga.
  const claveAnteriorRef = useRef(claveFicha);
  useEffect(() => {
    if (claveAnteriorRef.current === claveFicha) return;
    claveAnteriorRef.current = claveFicha;
    guard.descartar();
    setModo('ver');
    setForm(null);
  }, [claveFicha, guard]);

  useEffect(() => {
    load();
    return () => cargas.invalidar();
  }, [load, cargas]);

  // Al volver la conexión, los datos del servidor sustituyen a la copia.
  const onlineAntesRef = useRef(offline.online);
  useEffect(() => {
    const refrescar = debeRefrescarAlReconectar({ onlineAntes: onlineAntesRef.current, online: offline.online, esLocal });
    onlineAntesRef.current = offline.online;
    if (refrescar) load({ silencioso: true });
  }, [offline.online, esLocal, load]);

  // Copia local: refleja la sincronización (p. ej. local -> animal_id).
  useEffect(() => (local && esLocal ? local.subscribe(load) : undefined), [local, esLocal, load]);

  if (!idValido) return <Navigate to="/ganaderia/animales" replace />;
  if (state.status === 'redirect') return <Navigate to={`/ganaderia/animales/${state.to}`} replace />;

  // C1: nunca se pinta una ficha de otro animal u organización (ni un solo render).
  const vista = vistaFicha(state, animalId, organizacionId);
  const chapetaVisible = chapetaLocal?.clave === claveFicha ? chapetaLocal.valor : null;

  // Corregir, anular y gestionar la chapeta exigen conexión y un animal ya
  // confirmado por el servidor.
  const accionesDisponibles = !esLocal && offline.online;

  const { animal } = vista;
  const situacion = animal ? situacionDe(animal) : 'EN_HATO';
  const enHato = situacion === 'EN_HATO';

  function abrirCorreccion() {
    setForm(formFromAnimal(animal));
    setVersionCorreccion(animal.fechaActualizacion);
    setError('');
    setAviso('');
    abrirEdicion('corregir');
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
      const respuestaApi = await corregirAnimal(animal.animalId, buildCorreccionBody(form, versionCorreccion));
      const { ok, data } = respuestaApi;
      if (ok && data?.animal) {
        cargas.invalidar();
        setState(estadoDeServidor(data.animal, organizacionId));
        cerrarEdicion({ refrescar: false });
        setAviso(data.sinCambios ? 'No había cambios para guardar.' : 'Datos corregidos.');
        if (!data.sinCambios) marcarActividad();
        return;
      }
      if (data?.error === 'ANIMAL_MODIFICADO') {
        setError(mensajeError(respuestaApi, messageForError));
        cerrarEdicion({ refrescar: false });
        await load();
        return;
      }
      setError(mensajeError(respuestaApi, messageForError));
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
      const respuestaApi = await anularAnimal(animal.animalId, motivo.trim());
      const { ok, data } = respuestaApi;
      if (ok && data?.animal) {
        cargas.invalidar();
        setState(estadoDeServidor(data.animal, organizacionId));
        cerrarEdicion({ refrescar: false });
        setAviso(data.yaAnulado ? 'Este registro ya estaba anulado.' : 'Registro anulado.');
        if (!data.yaAnulado) marcarActividad();
        return;
      }
      setError(mensajeError(respuestaApi, messageForError));
    } catch {
      setError(GENERIC_ERROR_MESSAGE);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="gan-panel gan-hato">
      <GanaderiaBackLink to="/ganaderia/animales">Volver a mis animales</GanaderiaBackLink>

      {vista.status === 'loading' ? <StatusMessage>Cargando animal...</StatusMessage> : null}
      {vista.status === 'not_found' ? <StatusMessage type="error">Este animal no está disponible.</StatusMessage> : null}
      {vista.status === 'error' ? (
        <div className="gan-hato-actions">
          <StatusMessage type="error">{vista.mensaje ?? MENSAJE_CARGA_ANIMAL}</StatusMessage>
          <button type="button" className="gan-secondary-button" onClick={load}>Reintentar</button>
        </div>
      ) : null}

      {vista.status === 'ok' && animal ? (
        <>
          <div className="gan-section-heading">
            <span className="gan-eyebrow">Animal</span>
            <h2>{formatIdentidad(animal)}</h2>
          </div>
          <div className="gan-hato-ejes">
            <span className="gan-hato-badge">Registro: {ETIQUETAS_ESTADO_REGISTRO[animal.estado] ?? animal.estado}</span>
            <span className={`gan-hato-badge gan-hato-badge-situacion-${situacion.toLowerCase()}`}>Situación: {ETIQUETAS_SITUACION[situacion]}</span>
          </div>
          {animal.estado === 'ANULADO' ? (
            <StatusMessage type="error">Registro anulado. Motivo: {animal.estadoMotivo}</StatusMessage>
          ) : null}
          {aviso ? <StatusMessage type="success">{aviso}</StatusMessage> : null}
          {vista.avisoRemoto ? (
            <div className="gan-hato-actions">
              <StatusMessage type="info">{vista.avisoRemoto}</StatusMessage>
              {puedeActualizarManual(modo) ? (
                <button type="button" className="gan-secondary-button" onClick={() => load({ silencioso: true })}>Actualizar</button>
              ) : (
                <p className="gan-hato-hint">La ficha se actualizará al cerrar la edición.</p>
              )}
            </div>
          ) : null}
          {animal.estadoSync === 'PENDIENTE' ? (
            <StatusMessage type="info">Registrado en este dispositivo. Se enviará automáticamente al recuperar la conexión.</StatusMessage>
          ) : null}
          {animal.estadoSync === 'CONFLICTO' || animal.estadoSync === 'RECHAZADO' ? (
            <StatusMessage type="error">
              No se pudo sincronizar este registro. Se conserva en el dispositivo.{' '}
              <Link to="/ganaderia/sincronizacion">Resolver</Link>
            </StatusMessage>
          ) : null}

          {modo === 'ver' && !esLocal ? <FichaTabs activa={pestana} onChange={cambiarPestana} /> : null}

          {modo === 'ver' && !esLocal && pestana === 'pesajes' ? (
            <div role="tabpanel" id="ficha-panel-pesajes" aria-labelledby="ficha-tab-pesajes" tabIndex={0}>
              <HatoPesajesPanel
                key={claveFicha}
                animalId={animal.animalId}
                animalActivo={animal.estado === 'ACTIVO'}
                estadoOperativo={situacion}
                online={offline.online}
                repoOffline={repoOrg}
                onPesajeRegistrado={() => {
                  load({ silencioso: true });
                  marcarActividad();
                }}
              />
            </div>
          ) : null}

          {modo === 'ver' && !esLocal && reproduccionAbierta ? (
            <div role="tabpanel" id="ficha-panel-reproduccion" aria-labelledby="ficha-tab-reproduccion" tabIndex={0} hidden={pestana !== 'reproduccion'}>
              <HatoReproduccionPanel
                key={claveFicha}
                animal={animal}
                visible={pestana === 'reproduccion'}
                online={offline.online}
                repoOffline={repoOrg}
                syncNow={offline.syncNow}
                onCambio={marcarActividad}
              />
            </div>
          ) : null}

          {modo === 'ver' && !esLocal && actividadAbierta ? (
            <div role="tabpanel" id="ficha-panel-actividad" aria-labelledby="ficha-tab-actividad" tabIndex={0} hidden={pestana !== 'actividad'}>
              <HatoActividadPanel key={claveFicha} animalId={animal.animalId} visible={pestana === 'actividad'} version={actividadVersion} repoOffline={repoOrg} />
            </div>
          ) : null}

          {modo === 'ver' && (esLocal || pestana === 'resumen') ? (
            <div {...(esLocal ? {} : { role: 'tabpanel', id: 'ficha-panel-resumen', 'aria-labelledby': 'ficha-tab-resumen' })}>
              <div className="gan-hato-ficha">
                <Row label="Estado del registro">{ETIQUETAS_ESTADO_REGISTRO[animal.estado] ?? animal.estado}</Row>
                <Row label="Situación del animal">{ETIQUETAS_SITUACION[situacion]}</Row>
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
              <SituacionAnimal animal={animal} />
              {!esLocal ? (
                <HatoCierreAnimal
                  animal={animal}
                  rol={rol}
                  online={offline.online}
                  esLocal={esLocal}
                  tieneQrActiva={tieneQrActiva}
                  onCerrado={(mensaje) => {
                    setAviso(mensaje);
                    load({ silencioso: true });
                    marcarActividad();
                  }}
                  onRecargar={() => load({ silencioso: true })}
                />
              ) : null}
              {error ? <StatusMessage type="error">{error}</StatusMessage> : null}
              {animal.estado === 'ACTIVO' && !accionesDisponibles && !esLocal && (permisos.corregirAnimal || permisos.anularAnimal || permisos.asociarQr) ? (
                <p className="gan-hato-hint">Corregir, anular o cambiar la chapeta requiere conexión.</p>
              ) : null}
              {animal.estado === 'ACTIVO' && accionesDisponibles && (permisos.corregirAnimal || permisos.anularAnimal) ? (
                <div className="gan-hato-actions">
                  {permisos.corregirAnimal ? (
                    <button type="button" className="gan-submit" onClick={abrirCorreccion} disabled={catalogos.status !== 'ok'}>
                      Corregir datos
                    </button>
                  ) : null}
                  {permisos.anularAnimal ? (
                    <button
                      type="button"
                      className="gan-secondary-button"
                      onClick={() => {
                        setMotivo('');
                        setError('');
                        setAviso('');
                        abrirEdicion('anular');
                      }}
                    >
                      Anular registro
                    </button>
                  ) : null}
                </div>
              ) : null}
              {accionesDisponibles ? (
                <HatoQrPanel
                  key={claveFicha}
                  animalId={animal.animalId}
                  animalActivo={animal.estado === 'ACTIVO' && enHato}
                  estadoOperativo={situacion}
                  onCambio={marcarActividad}
                  onActiva={setTieneQrActiva}
                />
              ) : (
                <section className="gan-hato-qr">
                  <h3>Chapeta QR</h3>
                  <p className="gan-hato-hint">
                    {chapetaVisible
                      ? `${chapetaVisible.codigoVisible}${chapetaVisible.reservaLocalUuid ? ' (asociación pendiente de sincronizar)' : ''}`
                      : animal.chapetaCodigo
                        ? `${animal.chapetaCodigo} (asociación pendiente de sincronizar)`
                        : 'Sin chapeta asociada en este dispositivo.'}
                  </p>
                </section>
              )}
            </div>
          ) : null}

          {modo === 'corregir' && form && permisos.corregirAnimal ? (
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
                <button type="button" className="gan-secondary-button" onClick={() => cerrarEdicion()} disabled={saving}>Cancelar</button>
              </div>
            </form>
          ) : null}

          {modo === 'anular' && permisos.anularAnimal ? (
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
                <button type="button" className="gan-secondary-button" onClick={() => cerrarEdicion()} disabled={saving}>Cancelar</button>
              </div>
            </form>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
