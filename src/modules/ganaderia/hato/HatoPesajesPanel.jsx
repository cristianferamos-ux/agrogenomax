// FASE 1B: pestaña "Pesajes" de la ficha del animal. Consume EXCLUSIVAMENTE
// la API Business de Fase 1A vía hatoApi (GET/POST
// /api/ganaderia/animales/:id/pesajes); nunca api/ganaderiaApi.js ni las
// rutas/vistas legacy.
//
// Idempotencia: un clientOperationId (crypto.randomUUID, nunca visible) por
// INTENCIÓN de registro. Se conserva tras un resultado incierto (sin red: el
// reintento manual no duplica) y se renueva solo tras éxito o tras
// CLIENT_OPERATION_ID_REUSED. Nunca se reintenta un POST automáticamente.
// Tras guardar se refrescan historial y resumen (y la ficha vía
// onPesajeRegistrado) sin recargar la página.
//
// FASE 1C.1: bloque "Alertas" DERIVADO (construirAlertasPesajes); no se
// persiste. La fecha de referencia es la fecha calendario de NEGOCIO
// (America/Bogota, fechaHoyNegocio), nunca la fecha local del navegador.
// Solo para animales activos (un animal anulado no admite pesajes).
//
// La MISMA fecha de negocio es la fecha por defecto del formulario, su `max`
// y la cota "no futura" de la validación del cliente: coherente con el
// backend (resolveFechaHoyNegocio), no con la zona horaria del dispositivo.
//
// FASE 1C.2: botón "Descargar reporte productivo" (PDF generado en el
// servidor). Disponible también para animales anulados y sin pesajes.
//
// FASE 1D.1: SIN conexión el pesaje se guarda en el outbox existente
// (PESAJE_CREAR, repoOffline.registrarPesajeLocal) con el MISMO
// clientOperationId; NO hay POST. El motor de sincronización (Web Locks,
// reintentos, reconexión) lo envía después. Los pendientes se muestran
// APARTE ("Pendiente"), nunca en KPIs, gráficas, alertas ni PDF. Cuando una
// operación desaparece del outbox (confirmada) se recarga el historial del
// servidor sin recargar la página.
//
// FASE 2B: animal SALIDO/MUERTO (estadoOperativo) -> historial, gráfica y
// KPIs visibles; SIN formulario (ni online ni offline) y SIN alertas de
// atraso ("Sin alertas: el animal ya no está en el hato."). Un 409
// ANIMAL_YA_SALIDO/MUERTO al guardar (cierre hecho en otro dispositivo)
// produce el mismo estado y refresca la ficha.
import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import { StatusMessage } from '../components/FormField.jsx';
import HatoPesajeForm from './HatoPesajeForm.jsx';
import HatoPesajesAlertas from './HatoPesajesAlertas.jsx';
import HatoPesajesHistorial from './HatoPesajesHistorial.jsx';
import HatoPesajesKpis from './HatoPesajesKpis.jsx';
import HatoPesajesPendientes from './HatoPesajesPendientes.jsx';
import HatoReporteProductivoBoton from './HatoReporteProductivoBoton.jsx';
import { listPesajes, registrarPesaje } from './hatoApi.js';
import { newClientOperationId } from './hatoFormModel.js';
import { buildPesajeBody, initialPesajeForm, resultadoRegistro, validatePesajeForm } from './pesajesModel.js';
import {
  MENSAJE_PESAJE_PENDIENTE,
  MENSAJE_SIN_ALMACEN_LOCAL,
  huboConfirmaciones,
  idsPendientes,
  mensajeErrorGuardadoLocal,
  mensajeTrasLeerPendientes,
} from './pesajesOfflineModel.js';
import { construirAlertasPesajes } from './pesajesAlertas.js';
import { fechaHoyNegocio } from '../engine/fechaNegocio.js';
import { TEXTO_SIN_ALERTAS_CERRADO, mensajePesajesCerrado } from './cierreModel.js';

const HatoPesajesGrafica = lazy(() => import('./HatoPesajesGrafica.jsx'));
/** Relectura del outbox local mientras haya pendientes (confirmaciones de otra pestaña / SW). */
const RELECTURA_PENDIENTES_MS = 4_000;

export default function HatoPesajesPanel({ animalId, animalActivo, estadoOperativo = 'EN_HATO', online = true, repoOffline = null, onPesajeRegistrado }) {
  const fechaNegocio = fechaHoyNegocio();
  const [state, setState] = useState({ status: 'loading', data: null });
  const [form, setForm] = useState(() => initialPesajeForm(fechaNegocio));
  const [errores, setErrores] = useState({});
  const [saving, setSaving] = useState(false);
  const [mensaje, setMensaje] = useState(null);
  const [anuladoEnServidor, setAnuladoEnServidor] = useState(false);
  const [cerradoEnServidor, setCerradoEnServidor] = useState(null);
  const [pendientes, setPendientes] = useState([]);
  const operationIdRef = useRef(newClientOperationId());
  const savingRef = useRef(false);
  const pendientesIdsRef = useRef(new Set());
  const onRegistradoRef = useRef(onPesajeRegistrado);
  onRegistradoRef.current = onPesajeRegistrado;

  const cargar = useCallback(async () => {
    try {
      const { ok, status, data } = await listPesajes(animalId);
      if (ok && Array.isArray(data?.pesajes)) setState({ status: 'ok', data });
      else setState({ status: status === 404 ? 'not_found' : 'error', data: null });
    } catch {
      setState({ status: 'error', data: null });
    }
  }, [animalId]);

  useEffect(() => {
    setState({ status: 'loading', data: null });
    cargar();
  }, [cargar]);

  // Pendientes del outbox de ESTE animal. Si alguno desaparece (el motor lo
  // confirmó), el historial/KPIs/gráficas/alertas se vuelven a pedir al
  // servidor y la ficha se refresca. Otra pestaña o el Service Worker no
  // notifican a este repo: se relee al volver a la pestaña o a la red.
  const leerPendientes = useCallback(async () => {
    if (!repoOffline) return;
    let lista;
    try {
      lista = await repoOffline.listPesajesPendientes(animalId);
    } catch {
      return;
    }
    const actuales = idsPendientes(lista);
    const confirmadas = huboConfirmaciones(pendientesIdsRef.current, actuales);
    pendientesIdsRef.current = actuales;
    setPendientes(lista);
    // El aviso "pendiente" se retira cuando deja de ser cierto (nunca se
    // convierte en "sincronizado"); otros mensajes se conservan.
    setMensaje((actual) => mensajeTrasLeerPendientes(actual, lista));
    if (confirmadas) {
      await cargar();
      onRegistradoRef.current?.();
    }
  }, [repoOffline, animalId, cargar]);

  useEffect(() => {
    if (!repoOffline) {
      pendientesIdsRef.current = new Set();
      setPendientes([]);
      return undefined;
    }
    leerPendientes();
    const unsubscribe = repoOffline.subscribe(() => { leerPendientes(); });
    const alVolver = () => {
      if (document.visibilityState !== 'hidden') leerPendientes();
    };
    window.addEventListener('online', alVolver);
    document.addEventListener('visibilitychange', alVolver);
    return () => {
      unsubscribe();
      window.removeEventListener('online', alVolver);
      document.removeEventListener('visibilitychange', alVolver);
    };
  }, [repoOffline, leerPendientes]);

  // Otra pestaña o el Service Worker pueden confirmar los pendientes sin
  // avisar a este repo: mientras haya pendientes se relee el outbox LOCAL
  // (IndexedDB, sin red) para refrescar en cuanto desaparezcan.
  const hayPendientes = pendientes.length > 0;
  useEffect(() => {
    if (!repoOffline || !hayPendientes) return undefined;
    const id = setInterval(() => { leerPendientes(); }, RELECTURA_PENDIENTES_MS);
    return () => clearInterval(id);
  }, [repoOffline, hayPendientes, leerPendientes]);

  // Situación efectiva: la de la ficha o la que reveló un 409 del servidor.
  const situacion = cerradoEnServidor ?? (estadoOperativo === 'SALIDO' || estadoOperativo === 'MUERTO' ? estadoOperativo : 'EN_HATO');
  const cerrado = situacion !== 'EN_HATO';
  const admitePesajes = animalActivo && !anuladoEnServidor && !cerrado;
  const puedeGuardarOffline = !online && Boolean(repoOffline);

  function update(campo, valor) {
    setForm((current) => ({ ...current, [campo]: valor }));
    setErrores((current) => (current[campo] ? { ...current, [campo]: undefined } : current));
  }

  /** Sin conexión: se persiste en el outbox; NUNCA se hace POST aquí. */
  async function guardarOffline(body) {
    try {
      await repoOffline.registrarPesajeLocal({ animalId, body });
    } catch (error) {
      setMensaje({ type: 'error', text: mensajeErrorGuardadoLocal(error) });
      return;
    }
    // Solo tras quedar persistido: nueva intención y formulario limpio.
    operationIdRef.current = newClientOperationId();
    setForm(initialPesajeForm(fechaNegocio));
    setErrores({});
    setMensaje({ type: 'info', text: MENSAJE_PESAJE_PENDIENTE });
    await leerPendientes();
  }

  async function guardar(event) {
    event.preventDefault();
    if (savingRef.current) return;
    setMensaje(null);
    const { valido, errores: problemas } = validatePesajeForm(form, { hoy: fechaNegocio });
    if (!valido) {
      setErrores(problemas);
      return;
    }
    if (!operationIdRef.current) operationIdRef.current = newClientOperationId();
    if (!operationIdRef.current) {
      setMensaje({ type: 'error', text: 'Este navegador no permite registrar el pesaje de forma segura. Actualízalo e inténtalo de nuevo.' });
      return;
    }
    if (!online && !repoOffline) {
      setMensaje({ type: 'error', text: MENSAJE_SIN_ALMACEN_LOCAL });
      return;
    }
    savingRef.current = true;
    setSaving(true);
    try {
      if (!online) {
        await guardarOffline(buildPesajeBody(form, operationIdRef.current));
        return;
      }
      const resultado = resultadoRegistro(await registrarPesaje(animalId, buildPesajeBody(form, operationIdRef.current)));
      if (resultado.exito) {
        operationIdRef.current = newClientOperationId();
        setForm(initialPesajeForm(fechaNegocio));
        setErrores({});
        setMensaje({ type: 'success', text: resultado.mensaje });
        await cargar();
        onPesajeRegistrado?.();
        return;
      }
      if (resultado.tipo === 'CAMPO') {
        setErrores({ [resultado.campo]: resultado.mensaje });
        return;
      }
      if (resultado.tipo === 'ANULADO') {
        setAnuladoEnServidor(true);
        await cargar();
        onPesajeRegistrado?.();
      }
      if (resultado.tipo === 'CERRADO') {
        setCerradoEnServidor(resultado.estadoOperativo);
        await cargar();
        onPesajeRegistrado?.();
      }
      if (resultado.tipo === 'OPERACION_REUSADA') {
        operationIdRef.current = newClientOperationId();
        await cargar();
      }
      setMensaje({ type: 'error', text: resultado.mensaje });
    } catch {
      setMensaje({ type: 'error', text: 'No fue posible registrar el pesaje en este momento. Intenta nuevamente.' });
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  const pesajes = state.data?.pesajes ?? [];
  const sinPesajes = state.status === 'ok' && pesajes.length === 0;
  // El formulario: con red, cuando el historial confirmado cargó; sin red,
  // siempre que el dispositivo pueda guardar en el outbox (aunque el
  // historial del servidor no esté disponible).
  const mostrarFormulario = admitePesajes && (online ? state.status === 'ok' : puedeGuardarOffline && state.status !== 'not_found');

  const formulario = mostrarFormulario ? (
    <HatoPesajeForm
      form={form}
      errores={errores}
      onChange={update}
      onSubmit={guardar}
      saving={saving}
      hoy={fechaNegocio}
      primerPesaje={sinPesajes}
      online={online}
    />
  ) : null;

  return (
    <section className="gan-pesajes" aria-labelledby="pesajes-titulo">
      <div className="gan-pesajes-cabecera">
        <h3 id="pesajes-titulo">Pesajes</h3>
        <HatoReporteProductivoBoton animalId={animalId} online={online} />
      </div>

      {state.status === 'loading' ? <StatusMessage>Cargando pesajes...</StatusMessage> : null}
      {state.status === 'not_found' ? <StatusMessage type="error">Este animal no está disponible.</StatusMessage> : null}
      {state.status === 'error' ? (
        <div className="gan-hato-actions">
          <StatusMessage type="error">
            {online ? 'No fue posible cargar los pesajes.' : 'Los pesajes requieren conexión.'}
          </StatusMessage>
          <button type="button" className="gan-secondary-button" onClick={cargar}>Reintentar</button>
        </div>
      ) : null}

      <div aria-live="polite">{mensaje ? <StatusMessage type={mensaje.type}>{mensaje.text}</StatusMessage> : null}</div>

      <HatoPesajesPendientes pendientes={pendientes} />

      {state.status === 'ok' ? (
        <>
          {admitePesajes ? (
            <HatoPesajesAlertas
              alertas={construirAlertasPesajes({ pesajes, resumen: state.data.resumen, fechaReferencia: fechaNegocio })}
            />
          ) : null}
          {cerrado ? (
            <section className="gan-pesajes-alertas" aria-labelledby="pesajes-alertas-titulo">
              <h4 id="pesajes-alertas-titulo">Alertas</h4>
              <p className="gan-pesajes-alertas-vacio">{TEXTO_SIN_ALERTAS_CERRADO}</p>
            </section>
          ) : null}

          <HatoPesajesKpis resumen={state.data.resumen} />

          {sinPesajes ? (
            <div className="gan-pesajes-vacio">
              <p>No hay pesajes registrados.</p>
              {mostrarFormulario ? (
                <button type="button" className="gan-secondary-button" onClick={() => document.getElementById('pesaje-peso')?.focus()}>
                  Registrar primer pesaje
                </button>
              ) : null}
            </div>
          ) : (
            <Suspense fallback={<StatusMessage>Cargando gráfica...</StatusMessage>}>
              <HatoPesajesGrafica pesajes={pesajes} />
            </Suspense>
          )}

          {cerrado ? (
            <StatusMessage type="info">{mensajePesajesCerrado(situacion)}</StatusMessage>
          ) : null}
          {!admitePesajes && !cerrado ? (
            <StatusMessage type="info">Este animal está anulado y no admite nuevos pesajes.</StatusMessage>
          ) : null}
          {admitePesajes && !online && !repoOffline ? (
            <p className="gan-hato-hint">Registrar un pesaje requiere conexión.</p>
          ) : null}
          {formulario}

          {pesajes.length ? <HatoPesajesHistorial pesajes={pesajes} /> : null}
        </>
      ) : formulario}
    </section>
  );
}
