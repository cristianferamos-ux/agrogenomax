// SPRINT-3D11.2: registro manual de un animal (POST /api/ganaderia/animales).
//
// Idempotencia (mismo principio que el registro manual de Predios): una
// intención de registro = un clientOperationId estable. Se genera al abrir
// el formulario y al pulsar "Registrar otro animal"; se CONSERVA ante
// cualquier error (red, 400, 409, 500) para que un reintento manual nunca
// duplique; se descarta solo tras el éxito o al cancelar. Sin
// localStorage/sessionStorage. Nunca hay reintento automático del POST.
//
// SPRINT-3D11.3 (R1): con ?chapeta=AGX-... (llega desde el resolver QR
// cuando la chapeta está disponible) el registro usa
// POST /api/ganaderia/qr/chapetas/:codigo/registrar-animal: animal +
// asociación en UNA transacción (si falla, la chapeta sigue disponible) y,
// al terminar, abre la ficha del animal.
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import GanaderiaBackLink from '../components/GanaderiaBackLink.jsx';
import { StatusMessage } from '../components/FormField.jsx';
import HatoAnimalFields from './HatoAnimalFields.jsx';
import { createAnimal, registrarAnimalConChapeta } from './hatoApi.js';
import {
  GENERIC_ERROR_MESSAGE,
  INITIAL_ANIMAL_FORM,
  NETWORK_UNCERTAIN_MESSAGE,
  OPERATION_UNAVAILABLE_MESSAGE,
  buildCreateAnimalBody,
  categoriaSigueValida,
  fechaHoyLocal,
  formatIdentidad,
  messageForError,
  newClientOperationId,
  validateAnimalForm,
} from './hatoFormModel.js';
import useHatoCatalogos from './useHatoCatalogos.js';
import { normalizeCodigoChapeta } from './qrToken.js';
import { useGanaderiaOffline } from '../offline/GanaderiaOfflineProvider.jsx';
import '../styles/ganaderia-hato.css';

const FAILURE_NETWORK_ERROR = 'NETWORK_ERROR';
const CODIGO_NO_DISPONIBLE_MESSAGE = 'Código no disponible en este dispositivo. Conéctese para verificarlo.';
const LOCAL_ERROR_MESSAGES = Object.freeze({
  QR_NO_EN_DISPOSITIVO: CODIGO_NO_DISPONIBLE_MESSAGE,
  QR_NO_DISPONIBLE: 'Esta chapeta ya no está disponible en este dispositivo.',
  QR_CODIGO_INVALIDO: 'El código de chapeta no es válido.',
});

export default function HatoRegistroPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const chapetaParam = searchParams.get('chapeta');
  const chapeta = chapetaParam === null ? null : normalizeCodigoChapeta(chapetaParam);
  const chapetaInvalida = chapetaParam !== null && !chapeta;
  const catalogos = useHatoCatalogos();
  const offline = useGanaderiaOffline();
  const local = offline.preparado && offline.repo ? offline.repo : null;
  const [form, setForm] = useState(INITIAL_ANIMAL_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [fieldError, setFieldError] = useState('');
  const [operationReused, setOperationReused] = useState(false);
  const [registrado, setRegistrado] = useState(null);
  const operationIdRef = useRef(newClientOperationId());

  // Un único predio activo se preselecciona.
  useEffect(() => {
    if (catalogos.status === 'ok' && catalogos.predios.length === 1) {
      setForm((current) => (current.predioId ? current : { ...current, predioId: catalogos.predios[0].predioId }));
    }
  }, [catalogos.status, catalogos.predios]);

  function update(field, value) {
    setFieldError('');
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

  function registrarOtro() {
    operationIdRef.current = newClientOperationId();
    setForm((current) => ({ ...INITIAL_ANIMAL_FORM, predioId: current.predioId }));
    setRegistrado(null);
    setError('');
    setFieldError('');
    setOperationReused(false);
  }

  function cancelar() {
    operationIdRef.current = null;
    navigate('/ganaderia/animales');
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (saving || operationReused || chapetaInvalida) return;

    const problema = validateAnimalForm(form);
    if (problema) {
      setError(problema);
      return;
    }
    // Fail-closed: sin UUID de la intención no se envía nada.
    if (!operationIdRef.current) {
      setError(OPERATION_UNAVAILABLE_MESSAGE);
      return;
    }

    setSaving(true);
    setError('');
    setFieldError('');

    // SPRINT-3D11.3 (R1) offline-first: con el dispositivo preparado el
    // registro SIEMPRE se guarda primero en el dispositivo (animal local +
    // reserva de la chapeta + operación en el outbox, una transacción
    // local) y abre la ficha local; la sincronización automática lo envía
    // al servidor (mismo clientOperationId -> sin duplicados).
    if (local) {
      const body = buildCreateAnimalBody(form, operationIdRef.current);
      const chapetaEnDispositivo = chapeta ? await local.getChapetaPorCodigo(chapeta) : null;
      if (!chapeta || chapetaEnDispositivo || !offline.online) {
        try {
          if (chapeta && !chapetaEnDispositivo) {
            setError(CODIGO_NO_DISPONIBLE_MESSAGE);
            return;
          }
          const numero = String(body.numeroVisual ?? '').trim().toLowerCase();
          if (numero && (await local.listAnimales({ estado: 'ACTIVO', estadoOperativo: 'TODOS' })).some((a) => String(a.numeroVisual ?? '').trim().toLowerCase() === numero)) {
            setFieldError(messageForError('ANIMAL_NUMERO_VISUAL_DUPLICADO'));
            return;
          }
          const { localUuid } = await local.registrarAnimalLocal({ body, chapetaCodigo: chapeta });
          operationIdRef.current = null;
          navigate(`/ganaderia/animales/local:${localUuid}`, { replace: true });
        } catch (localError) {
          setError(LOCAL_ERROR_MESSAGES[localError?.code] ?? GENERIC_ERROR_MESSAGE);
        } finally {
          setSaving(false);
        }
        return;
      }
      // Chapeta que aún no está en el dispositivo y hay red: se verifica y
      // registra directamente en el servidor (flujo en línea de abajo).
    }

    try {
      const body = buildCreateAnimalBody(form, operationIdRef.current);
      const { ok, status, data, failure } = chapeta
        ? await registrarAnimalConChapeta(chapeta, body)
        : await createAnimal(body);
      if (ok && data?.animal && chapeta) {
        operationIdRef.current = null;
        navigate(`/ganaderia/animales/${data.animal.animalId}`, { replace: true });
        return;
      }
      if (ok && data?.animal) {
        // 201 (creado) y 200 (yaExistia) son el mismo éxito para el productor.
        operationIdRef.current = null;
        setRegistrado(data.animal);
        return;
      }
      if (failure === FAILURE_NETWORK_ERROR) {
        setError(NETWORK_UNCERTAIN_MESSAGE);
      } else if (status === 409 && data?.error === 'CLIENT_OPERATION_ID_REUSED') {
        // Esta intención ya creó otro animal: crear otro exige una intención nueva.
        setOperationReused(true);
        setError(messageForError(data.error));
      } else if (status === 409 && data?.error === 'ANIMAL_NUMERO_VISUAL_DUPLICADO') {
        setFieldError(messageForError(data.error));
      } else if (failure) {
        // Sesión expirada / CSRF: el aviso global ya informa; el formulario conserva lo escrito.
        setError('No se pudo enviar el registro. Revisa el aviso de sesión e inténtalo de nuevo.');
      } else {
        setError(messageForError(data?.error));
      }
    } catch {
      setError(NETWORK_UNCERTAIN_MESSAGE);
    } finally {
      setSaving(false);
    }
  }

  if (registrado) {
    return (
      <div className="gan-panel gan-hato">
        <div className="gan-section-heading">
          <span className="gan-eyebrow">Animales</span>
          <h2>Animal registrado</h2>
        </div>
        <StatusMessage type="success">{formatIdentidad(registrado)} quedó registrado en {registrado.predioNombre}.</StatusMessage>
        <div className="gan-hato-actions">
          <button type="button" className="gan-submit" onClick={registrarOtro}>Registrar otro animal</button>
          <Link className="gan-secondary-button" to={`/ganaderia/animales/${registrado.animalId}`}>Ver animal</Link>
          <Link className="gan-secondary-button" to="/ganaderia/animales">Ver mis animales</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="gan-panel gan-hato">
      <GanaderiaBackLink to="/ganaderia/animales">Volver a mis animales</GanaderiaBackLink>
      <div className="gan-section-heading">
        <span className="gan-eyebrow">Animales</span>
        <h2>Registrar animal</h2>
      </div>
      {chapeta ? (
        <StatusMessage type="info">
          Chapeta <strong>{chapeta}</strong>: quedará asociada a este animal al registrarlo.
        </StatusMessage>
      ) : null}
      {chapetaInvalida ? (
        <StatusMessage type="error">
          El código de chapeta no es válido. <Link to="/ganaderia/escanear-qr">Escanear de nuevo</Link>
        </StatusMessage>
      ) : null}

      {catalogos.status === 'loading' ? <StatusMessage>Cargando datos del formulario...</StatusMessage> : null}
      {catalogos.status === 'error' ? (
        <div className="gan-hato-actions">
          <StatusMessage type="error">No fue posible cargar los datos del formulario.</StatusMessage>
          <button type="button" className="gan-secondary-button" onClick={catalogos.reload}>Reintentar</button>
        </div>
      ) : null}
      {catalogos.status === 'ok' && catalogos.predios.length === 0 ? (
        <StatusMessage type="info">
          Para registrar animales primero necesitas un predio activo. <Link to="/ganaderia/predios">Registrar predio</Link>
        </StatusMessage>
      ) : null}

      {catalogos.status === 'ok' && catalogos.predios.length > 0 ? (
        <form className="gan-form" onSubmit={handleSubmit} noValidate>
          <HatoAnimalFields
            form={form}
            onChange={update}
            razas={catalogos.razas}
            categorias={catalogos.categorias}
            predios={catalogos.predios}
            showPeso
            disabled={saving || operationReused}
            maxFecha={fechaHoyLocal()}
          />
          {fieldError ? <StatusMessage type="error">{fieldError}</StatusMessage> : null}
          {error ? <StatusMessage type="error">{error}</StatusMessage> : null}
          <div className="gan-hato-actions">
            {operationReused ? (
              <button type="button" className="gan-submit" onClick={registrarOtro}>Registrar otro animal</button>
            ) : (
              <button type="submit" className="gan-submit" disabled={saving || chapetaInvalida}>
                {saving ? 'Registrando...' : 'Registrar animal'}
              </button>
            )}
            <button type="button" className="gan-secondary-button" onClick={cancelar} disabled={saving}>Cancelar</button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
