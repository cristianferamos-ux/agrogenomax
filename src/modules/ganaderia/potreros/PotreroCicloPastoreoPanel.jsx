// SPRINT-3D9.1: "PASTOREO REAL" -- registra el ciclo REALMENTE ejecutado
// (distinto del plan de PotreroDescansoReentradaPanel.jsx). Un clic para
// "Iniciar pastoreo" (precarga el lote desde la recomendación de pastoreo
// vigente) y un clic para "Finalizar pastoreo" (FASE A crítica + FASE B
// best-effort -- genera el descanso post-real anclado a la salida REAL).
// El cliente NUNCA aporta fechas -- se resuelven server-side
// (businessTimezone.js). "Cancelar" exige un motivo no vacío.
import { useEffect, useState } from 'react';
import { FormField, StatusMessage } from '../components/FormField.jsx';
import { formatDateDisplay } from '../utils/dateFormat.js';
import {
  getCicloActual,
  iniciarCicloPastoreo,
  finalizarCicloPastoreo,
  cancelarCicloPastoreo,
} from './ganaderiaCicloPastoreoApi.js';

const GENERIC_ERROR = 'No fue posible completar la operación en este momento. Intenta nuevamente.';

const CICLO_ERROR_MESSAGES = {
  NO_GRAZING_RECOMMENDATION: 'Primero guarda una recomendación de pastoreo para este potrero.',
  CICLO_ALREADY_IN_PROGRESS: 'Ya existe un pastoreo en curso en este potrero.',
  CICLO_NOT_FOUND: 'Este ciclo de pastoreo ya no está disponible.',
  CICLO_CANCELADO: 'Este ciclo fue cancelado -- no puede finalizarse.',
  CICLO_NOT_IN_PROGRESS: 'Este ciclo ya no está en curso.',
  INVALID_MOTIVO_CANCELACION: 'Escribe el motivo de la cancelación.',
  POTRERO_NOT_FOUND: 'Este potrero ya no está disponible.',
  INVALID_NUMERO_ANIMALES_REAL: 'El número de animales debe ser un entero entre 1 y 100.000.',
  INVALID_PESO_PROMEDIO_REAL: 'El peso promedio debe ser mayor que 0 y menor o igual a 2.000 kg.',
  INVALID_CATEGORIA_CODIGO: 'Selecciona una categoría productiva válida.',
};

function resolveErrorMessage(code) {
  return CICLO_ERROR_MESSAGES[code] || GENERIC_ERROR;
}

// SPRINT-3D9.1 PRE-COMMIT FIX: validación client-side del ajuste de lote,
// espejo EXACTO de los rangos que ya enforca potreroCicloPastoreoRepository.js
// (iniciarCicloPastoreo) -- nunca una fuente de verdad nueva, solo evita un
// round-trip obvio. El backend sigue siendo la autoridad final.
function validateAjusteLote({ numeroAnimales, pesoPromedioKg, categoriaCodigo, categorias }) {
  if (!Number.isInteger(numeroAnimales) || numeroAnimales < 1 || numeroAnimales > 100000) {
    return 'INVALID_NUMERO_ANIMALES_REAL';
  }
  if (!Number.isFinite(pesoPromedioKg) || pesoPromedioKg <= 0 || pesoPromedioKg > 2000) {
    return 'INVALID_PESO_PROMEDIO_REAL';
  }
  if (!categoriaCodigo || !(categorias || []).some((c) => c.codigo === categoriaCodigo)) {
    return 'INVALID_CATEGORIA_CODIGO';
  }
  return null;
}

// El descanso post-real puede quedar GENERADO (incluso en modo degradado --
// eso sigue siendo un éxito), PENDIENTE (condición transitoria,
// reintentable con el mismo botón "Finalizar") o ERROR_TECNICO (el ciclo
// YA quedó finalizado igual -- esto nunca revierte ese hecho).
const DESCANSO_ESTADO_MESSAGES = {
  GENERADO: { type: 'info', text: 'Descanso post-real calculado.' },
  PENDIENTE: { type: 'warning', text: 'El descanso no pudo calcularse todavía por una condición temporal -- vuelve a intentar "Finalizar" en unos minutos.' },
  ERROR_TECNICO: { type: 'warning', text: 'El pastoreo quedó registrado, pero no fue posible calcular el descanso automáticamente.' },
};

export default function PotreroCicloPastoreoPanel({ predioId, potreroId, planLote, categorias }) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [actual, setActual] = useState(null);

  const [iniciando, setIniciando] = useState(false);
  const [iniciarError, setIniciarError] = useState('');

  // SPRINT-3D9.1 PRE-COMMIT FIX: "Ajustar lote" -- acción secundaria
  // discreta, nunca un formulario obligatorio. Los tres campos se
  // precargan SIEMPRE desde `planLote` en el momento de abrir el bloque
  // (nunca desde un ajuste previo de un ciclo anterior) -- así un
  // re-inicio posterior arranca desde el plan VIGENTE, nunca de un valor
  // viejo que quedó en memoria.
  const [ajustando, setAjustando] = useState(false);
  const [ajusteNumeroAnimales, setAjusteNumeroAnimales] = useState('');
  const [ajustePesoPromedioKg, setAjustePesoPromedioKg] = useState('');
  const [ajusteCategoriaCodigo, setAjusteCategoriaCodigo] = useState('');
  const [ajusteError, setAjusteError] = useState('');

  const [finalizando, setFinalizando] = useState(false);
  const [finalizarError, setFinalizarError] = useState('');
  const [descansoResultado, setDescansoResultado] = useState(null);

  const [cancelando, setCancelando] = useState(false);
  const [cancelarError, setCancelarError] = useState('');
  const [mostrarCancelar, setMostrarCancelar] = useState(false);
  const [motivoCancelacion, setMotivoCancelacion] = useState('');

  function loadActual() {
    setLoading(true);
    setLoadError('');
    getCicloActual(predioId, potreroId)
      .then(({ ok, data }) => {
        if (!ok) {
          setLoadError(GENERIC_ERROR);
          setLoading(false);
          return;
        }
        setActual(data?.actual ?? null);
        setLoading(false);
      })
      .catch(() => {
        setLoadError(GENERIC_ERROR);
        setLoading(false);
      });
  }

  useEffect(() => {
    loadActual();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [predioId, potreroId]);

  async function handleIniciar() {
    if (iniciando) return;
    setIniciando(true);
    setIniciarError('');
    const { ok, data } = await iniciarCicloPastoreo(predioId, potreroId);
    setIniciando(false);
    if (!ok) {
      setIniciarError(resolveErrorMessage(data?.error));
      return;
    }
    setDescansoResultado(null);
    loadActual();
  }

  // Abrir el bloque de ajuste NUNCA dispara una mutación -- solo precarga
  // los tres campos desde el plan VIGENTE en ese instante.
  function handleAbrirAjuste() {
    setAjusteNumeroAnimales(planLote?.numeroAnimales != null ? String(planLote.numeroAnimales) : '');
    setAjustePesoPromedioKg(planLote?.pesoPromedioKg != null ? String(planLote.pesoPromedioKg) : '');
    setAjusteCategoriaCodigo(planLote?.categoriaCodigo || '');
    setAjusteError('');
    setAjustando(true);
  }

  // "Usar valores recomendados / Cancelar ajuste" -- vuelve al modo
  // simple sin tocar la red, descarta cualquier edición sin guardar.
  function handleCancelarAjuste() {
    setAjustando(false);
    setAjusteError('');
  }

  async function handleConfirmarIniciarConAjuste() {
    if (iniciando) return;
    const numeroAnimales = Number(ajusteNumeroAnimales);
    const pesoPromedioKg = Number(ajustePesoPromedioKg);
    const codigoInvalido = validateAjusteLote({
      numeroAnimales, pesoPromedioKg, categoriaCodigo: ajusteCategoriaCodigo, categorias,
    });
    if (codigoInvalido) {
      setAjusteError(resolveErrorMessage(codigoInvalido));
      return;
    }
    setIniciando(true);
    setAjusteError('');
    const { ok, data } = await iniciarCicloPastoreo(predioId, potreroId, {
      numeroAnimales, pesoPromedioKg, categoriaCodigo: ajusteCategoriaCodigo,
    });
    setIniciando(false);
    if (!ok) {
      // Se conservan los valores ingresados para que el usuario corrija y
      // reintente -- nunca se limpia el formulario en un error.
      setAjusteError(resolveErrorMessage(data?.error));
      return;
    }
    setAjustando(false);
    setDescansoResultado(null);
    loadActual();
  }

  async function handleFinalizar() {
    if (finalizando || !actual) return;
    setFinalizando(true);
    setFinalizarError('');
    const { ok, data } = await finalizarCicloPastoreo(predioId, potreroId, actual.cicloId);
    setFinalizando(false);
    if (!ok) {
      setFinalizarError(resolveErrorMessage(data?.error));
      return;
    }
    setDescansoResultado(data?.descansoEstado ?? null);
    loadActual();
  }

  function handleAbrirCancelar() {
    setMostrarCancelar(true);
    setMotivoCancelacion('');
    setCancelarError('');
  }

  async function handleConfirmarCancelar() {
    if (cancelando || !actual) return;
    if (motivoCancelacion.trim() === '') {
      setCancelarError(resolveErrorMessage('INVALID_MOTIVO_CANCELACION'));
      return;
    }
    setCancelando(true);
    setCancelarError('');
    const { ok, data } = await cancelarCicloPastoreo(predioId, potreroId, actual.cicloId, motivoCancelacion.trim());
    setCancelando(false);
    if (!ok) {
      setCancelarError(resolveErrorMessage(data?.error));
      return;
    }
    setMostrarCancelar(false);
    setDescansoResultado(null);
    loadActual();
  }

  if (loading) {
    return <p className="gan-potrero-points-hint">Cargando pastoreo real...</p>;
  }

  if (loadError) {
    return <StatusMessage type="error">{loadError}</StatusMessage>;
  }

  return (
    <div className="gan-ficha-productiva-panel gan-ciclo-pastoreo-panel">
      <p className="gan-capacidad-section-label">Pastoreo real</p>

      {/* El resultado del descanso post-real (FASE B) se muestra sin
          importar si el ciclo recién finalizado ya desapareció de
          `actual` tras el refresco -- es la confirmación de la acción que
          el usuario acaba de ejecutar, nunca debe desaparecer de golpe. */}
      {descansoResultado ? (
        <StatusMessage type={DESCANSO_ESTADO_MESSAGES[descansoResultado]?.type || 'info'}>
          {DESCANSO_ESTADO_MESSAGES[descansoResultado]?.text || ''}
        </StatusMessage>
      ) : null}

      {!actual ? (
        <div className="gan-ficha-productiva-empty">
          {planLote ? (
            <div className="gan-ficha-row"><span>Lote</span><strong>{planLote.numeroAnimales} animales ({planLote.pesoPromedioKg} kg prom.)</strong></div>
          ) : null}

          {!ajustando ? (
            <>
              <button type="button" className="gan-secondary-button" onClick={handleIniciar} disabled={iniciando}>
                {iniciando ? 'Iniciando...' : 'Iniciar pastoreo'}
              </button>
              {planLote ? (
                <button type="button" className="gan-back-inline" onClick={handleAbrirAjuste} disabled={iniciando}>
                  Ajustar lote
                </button>
              ) : null}
              <StatusMessage type="error">{iniciarError}</StatusMessage>
            </>
          ) : (
            <div className="gan-stack">
              <FormField label="Categoría">
                <select
                  value={ajusteCategoriaCodigo}
                  onChange={(event) => setAjusteCategoriaCodigo(event.target.value)}
                  disabled={iniciando}
                >
                  {(categorias || []).map((categoria) => (
                    <option key={categoria.codigo} value={categoria.codigo}>{categoria.nombre}</option>
                  ))}
                </select>
              </FormField>
              <FormField label="Número de animales" required>
                <input
                  type="number"
                  min="1"
                  max="100000"
                  step="1"
                  value={ajusteNumeroAnimales}
                  onChange={(event) => setAjusteNumeroAnimales(event.target.value)}
                  disabled={iniciando}
                />
              </FormField>
              <FormField label="Peso promedio (kg)" required>
                <input
                  type="number"
                  min="0"
                  max="2000"
                  step="any"
                  value={ajustePesoPromedioKg}
                  onChange={(event) => setAjustePesoPromedioKg(event.target.value)}
                  disabled={iniciando}
                />
              </FormField>
              <StatusMessage type="error">{ajusteError}</StatusMessage>
              <div className="gan-potrero-actions">
                <button type="button" className="gan-submit" onClick={handleConfirmarIniciarConAjuste} disabled={iniciando}>
                  {iniciando ? 'Iniciando...' : 'Confirmar e iniciar'}
                </button>
                <button type="button" className="gan-back-inline" onClick={handleCancelarAjuste} disabled={iniciando}>
                  Usar valores recomendados / Cancelar ajuste
                </button>
              </div>
            </div>
          )}
        </div>
      ) : null}

      {actual ? (
        <div className="gan-stack">
          <div className="gan-ficha-row"><span>Lote</span><strong>{actual.numeroAnimalesReal} animales ({actual.pesoPromedioRealKg} kg prom.)</strong></div>
          <div className="gan-ficha-row"><span>Ingreso real</span><strong>{formatDateDisplay(actual.fechaIngresoReal)}</strong></div>

          <StatusMessage type="error">{finalizarError}</StatusMessage>

          {!mostrarCancelar ? (
            <div className="gan-potrero-actions">
              <button type="button" className="gan-submit" onClick={handleFinalizar} disabled={finalizando || cancelando}>
                {finalizando ? 'Finalizando...' : 'Finalizar pastoreo'}
              </button>
              <button type="button" className="gan-back-inline" onClick={handleAbrirCancelar} disabled={finalizando || cancelando}>
                Cancelar
              </button>
            </div>
          ) : (
            <div className="gan-stack">
              <FormField label="Motivo de la cancelación" required>
                <input
                  type="text"
                  value={motivoCancelacion}
                  onChange={(event) => setMotivoCancelacion(event.target.value)}
                />
              </FormField>
              <StatusMessage type="error">{cancelarError}</StatusMessage>
              <div className="gan-potrero-actions">
                <button type="button" className="gan-secondary-button" onClick={handleConfirmarCancelar} disabled={cancelando}>
                  {cancelando ? 'Cancelando...' : 'Confirmar cancelación'}
                </button>
                <button type="button" className="gan-back-inline" onClick={() => setMostrarCancelar(false)} disabled={cancelando}>
                  Volver
                </button>
              </div>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
