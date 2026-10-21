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
import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import { StatusMessage } from '../components/FormField.jsx';
import HatoPesajeForm from './HatoPesajeForm.jsx';
import HatoPesajesAlertas from './HatoPesajesAlertas.jsx';
import HatoPesajesHistorial from './HatoPesajesHistorial.jsx';
import HatoPesajesKpis from './HatoPesajesKpis.jsx';
import { listPesajes, registrarPesaje } from './hatoApi.js';
import { fechaHoyLocal, newClientOperationId } from './hatoFormModel.js';
import { buildPesajeBody, initialPesajeForm, resultadoRegistro, validatePesajeForm } from './pesajesModel.js';
import { construirAlertasPesajes } from './pesajesAlertas.js';
import { fechaHoyNegocio } from '../engine/fechaNegocio.js';

const HatoPesajesGrafica = lazy(() => import('./HatoPesajesGrafica.jsx'));

export default function HatoPesajesPanel({ animalId, animalActivo, online = true, onPesajeRegistrado }) {
  const hoy = fechaHoyLocal();
  const fechaNegocio = fechaHoyNegocio();
  const [state, setState] = useState({ status: 'loading', data: null });
  const [form, setForm] = useState(() => initialPesajeForm(hoy));
  const [errores, setErrores] = useState({});
  const [saving, setSaving] = useState(false);
  const [mensaje, setMensaje] = useState(null);
  const [anuladoEnServidor, setAnuladoEnServidor] = useState(false);
  const operationIdRef = useRef(newClientOperationId());
  const savingRef = useRef(false);

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

  const admitePesajes = animalActivo && !anuladoEnServidor;

  function update(campo, valor) {
    setForm((current) => ({ ...current, [campo]: valor }));
    setErrores((current) => (current[campo] ? { ...current, [campo]: undefined } : current));
  }

  async function guardar(event) {
    event.preventDefault();
    if (savingRef.current) return;
    setMensaje(null);
    const { valido, errores: problemas } = validatePesajeForm(form, { hoy });
    if (!valido) {
      setErrores(problemas);
      return;
    }
    if (!operationIdRef.current) operationIdRef.current = newClientOperationId();
    if (!operationIdRef.current) {
      setMensaje({ type: 'error', text: 'Este navegador no permite registrar el pesaje de forma segura. Actualízalo e inténtalo de nuevo.' });
      return;
    }
    savingRef.current = true;
    setSaving(true);
    try {
      const resultado = resultadoRegistro(await registrarPesaje(animalId, buildPesajeBody(form, operationIdRef.current)));
      if (resultado.exito) {
        operationIdRef.current = newClientOperationId();
        setForm(initialPesajeForm(hoy));
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

  return (
    <section className="gan-pesajes" aria-labelledby="pesajes-titulo">
      <h3 id="pesajes-titulo">Pesajes</h3>

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

      {state.status === 'ok' ? (
        <>
          {admitePesajes ? (
            <HatoPesajesAlertas
              alertas={construirAlertasPesajes({ pesajes, resumen: state.data.resumen, fechaReferencia: fechaNegocio })}
            />
          ) : null}

          <HatoPesajesKpis resumen={state.data.resumen} />

          {sinPesajes ? (
            <div className="gan-pesajes-vacio">
              <p>No hay pesajes registrados.</p>
              {admitePesajes && online ? (
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

          {!admitePesajes ? (
            <StatusMessage type="info">Este animal está anulado y no admite nuevos pesajes.</StatusMessage>
          ) : null}
          {admitePesajes && !online ? (
            <p className="gan-hato-hint">Registrar un pesaje requiere conexión.</p>
          ) : null}
          {admitePesajes && online ? (
            <HatoPesajeForm
              form={form}
              errores={errores}
              onChange={update}
              onSubmit={guardar}
              saving={saving}
              hoy={hoy}
              primerPesaje={sinPesajes}
            />
          ) : null}

          {pesajes.length ? <HatoPesajesHistorial pesajes={pesajes} /> : null}
        </>
      ) : null}
    </section>
  );
}
