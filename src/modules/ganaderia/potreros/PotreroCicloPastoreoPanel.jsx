// SPRINT-3D9.1/3D9.2: "PASTOREO REAL" -- registra el ciclo REALMENTE
// ejecutado (distinto del plan de PotreroDescansoReentradaPanel.jsx). Un
// clic para "Iniciar pastoreo" (precarga el lote desde la recomendación
// de pastoreo vigente) y un clic para "Finalizar pastoreo" (FASE A
// crítica + FASE B best-effort -- genera el descanso post-real anclado a
// la salida REAL). El cliente NUNCA aporta fechas -- se resuelven
// server-side (businessTimezone.js). "Cancelar" exige un motivo no
// vacío.
//
// SPRINT-3D9.2: el backend es la autoridad del reentry guard -- este
// panel consulta el estado operativo derivado (DISPONIBLE/EN_PASTOREO/
// EN_DESCANSO/EVALUACION_REINGRESO/ARCHIVADO) y refleja el bloqueo, pero
// NUNCA decide por su cuenta -- "Iniciar pastoreo" solo se muestra
// habilitado cuando el estado es DISPONIBLE; en cualquier otro caso el
// propio backend rechazaría el intento igual. También agrega, sobre el
// historial, "Anular registro" (ciclo histórico que nunca debió contar)
// y "Corregir información" (dato real capturado mal) -- ninguno borra
// permanentemente historia.
import { useEffect, useState } from 'react';
import { FormField, StatusMessage } from '../components/FormField.jsx';
import { formatDateDisplay } from '../utils/dateFormat.js';
import {
  getCicloActual,
  getCicloHistorial,
  getEstadoOperativoPotrero,
  getAforoBasePreview,
  iniciarCicloPastoreo,
  finalizarCicloPastoreo,
  cancelarCicloPastoreo,
  anularCicloPastoreo,
  corregirCicloPastoreo,
  evaluarReingreso,
} from './ganaderiaCicloPastoreoApi.js';
import { getFichaProductiva } from './ganaderiaFichaProductivaApi.js';

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
  PREDIO_ARCHIVADO: 'Este predio está archivado -- no se pueden iniciar nuevos ciclos.',
  POTRERO_ARCHIVADO: 'Este potrero está archivado -- no se pueden iniciar nuevos ciclos.',
  POTRERO_IN_REST_PERIOD: 'Este potrero está en descanso -- todavía no puede reingresar.',
  POTRERO_REST_ASSESSMENT_PENDING: 'Todavía no se pudo calcular el descanso del último pastoreo.',
  POTRERO_REINGRESO_NO_CONFIRMADO: 'La ventana de reingreso ya se abrió, pero todavía no se confirmó con un nuevo aforo.',
  INVALID_MOTIVO_ANULACION: 'Escribe el motivo de la anulación.',
  CICLO_EN_CURSO_USE_CANCELAR: 'Este ciclo está en curso -- usa "Cancelar" en vez de "Anular".',
  INVALID_MOTIVO_CORRECCION: 'Escribe el motivo de la corrección.',
  SIN_CAMBIOS_SOLICITADOS: 'Cambia al menos un dato antes de guardar la corrección.',
  CICLO_NOT_FINALIZADO: 'Solo un ciclo finalizado puede corregirse.',
  AFORO_ANTERIOR_A_VENTANA_REINGRESO: 'El aforo debe ser posterior a la apertura de la ventana de reingreso -- registra un aforo nuevo antes de evaluar.',
  AFORO_NO_ES_EL_MAS_RECIENTE: 'Existe un aforo más reciente para este potrero. Recarga la página y evalúa con el último registrado.',
  INVALID_OBSERVACION_EVALUACION: 'Escribe una observación.',
  EVALUACION_APTO_YA_REGISTRADA: 'Ya se confirmó el reingreso de este potrero.',
  // SPRINT-3D9.3
  INVALID_PRODUCCION_LECHE_REAL: 'El promedio de litros/vaca/día debe ser numérico.',
  INVALID_DIAS_EN_LECHE_REAL: 'Los días en leche deben ser numéricos.',
  INVALID_GRASA_LECHE_REAL: 'El %grasa de la leche debe ser numérico.',
  INVALID_TERNERO_AL_PIE_REAL: 'Indica si hay ternero al pie.',
};

function resolveErrorMessage(code) {
  return CICLO_ERROR_MESSAGES[code] || GENERIC_ERROR;
}

// SPRINT-3D9.1 PRE-COMMIT FIX: validación client-side del ajuste de lote,
// espejo EXACTO de los rangos que ya enforca potreroCicloPastoreoRepository.js
// (iniciarCicloPastoreo) -- nunca una fuente de verdad nueva, solo evita un
// round-trip obvio. El backend sigue siendo la autoridad final.
// SPRINT-3D9.3: resuelve la categoría seleccionada (ajuste o plan
// vigente) para decidir qué campos condicionales mostrar -- mismo
// criterio que categoriaSeleccionada en PotreroRecomendacionPastoreoPanel.jsx,
// nunca un catálogo/lógica paralela.
function resolveCategoriaSeleccionada(codigo, categorias) {
  return (categorias || []).find((c) => c.codigo === codigo) || null;
}

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

// SPRINT-3D9.2: copy simple por estado operativo derivado -- nunca jerga
// técnica (nunca "409", nunca el código del reason).
const ESTADO_OPERATIVO_LABELS = {
  DISPONIBLE: 'Disponible',
  EN_PASTOREO: 'En pastoreo',
  EN_DESCANSO: 'En descanso',
  EVALUACION_REINGRESO: 'Evaluar reingreso',
  ARCHIVADO: 'Archivado',
};

const HISTORIAL_ESTADO_LABELS = {
  FINALIZADO: 'Finalizado',
  CANCELADO: 'Cancelado',
  ANULADO: 'Anulado',
};

const CORREGIBLE_FIELDS_INICIALES = { fechaIngresoReal: '', fechaSalidaReal: '', categoriaCodigo: '', numeroAnimales: '', pesoPromedioKg: '' };

export default function PotreroCicloPastoreoPanel({ predioId, potreroId, planLote, categorias }) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [actual, setActual] = useState(null);
  const [estadoOperativo, setEstadoOperativo] = useState(null);

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
  // SPRINT-3D9.3: campos condicionales REAL -- mismo patrón que el resto
  // del ajuste (precargados desde planLote al abrir, nunca obligatorios
  // para iniciar).
  const [ajusteProduccionLecheLDia, setAjusteProduccionLecheLDia] = useState('');
  const [ajusteDiasEnLeche, setAjusteDiasEnLeche] = useState('');
  const [ajusteGrasaLechePct, setAjusteGrasaLechePct] = useState('');
  const [ajusteTerneroAlPie, setAjusteTerneroAlPie] = useState(false);
  const [ajusteError, setAjusteError] = useState('');

  // SPRINT-3D9.3: aforo base real -- se muestra ANTES de confirmar
  // "Iniciar pastoreo", nunca bloquea el inicio si no hay ninguno válido.
  const [aforoPreview, setAforoPreview] = useState(null);

  const [finalizando, setFinalizando] = useState(false);
  const [finalizarError, setFinalizarError] = useState('');
  const [descansoResultado, setDescansoResultado] = useState(null);

  const [cancelando, setCancelando] = useState(false);
  const [cancelarError, setCancelarError] = useState('');
  const [mostrarCancelar, setMostrarCancelar] = useState(false);
  const [motivoCancelacion, setMotivoCancelacion] = useState('');

  // SPRINT-3D9.2: evaluar reingreso.
  const [fichaEvaluacion, setFichaEvaluacion] = useState(null);
  const [evaluando, setEvaluando] = useState(false);
  const [evaluarError, setEvaluarError] = useState('');
  const [observacionEvaluacion, setObservacionEvaluacion] = useState('');
  const [mostrarObservacionNoApto, setMostrarObservacionNoApto] = useState(false);

  // SPRINT-3D9.2: historial + anular/corregir.
  const [historial, setHistorial] = useState([]);
  const [mostrarHistorial, setMostrarHistorial] = useState(false);
  const [accionCicloId, setAccionCicloId] = useState(null);
  const [accionTipo, setAccionTipo] = useState(null); // 'anular' | 'corregir'
  const [motivoAccion, setMotivoAccion] = useState('');
  const [corregirCampos, setCorregirCampos] = useState(CORREGIBLE_FIELDS_INICIALES);
  const [accionEnCurso, setAccionEnCurso] = useState(false);
  const [accionError, setAccionError] = useState('');

  function loadActual() {
    setLoading(true);
    setLoadError('');
    Promise.all([getCicloActual(predioId, potreroId), getEstadoOperativoPotrero(predioId, potreroId)])
      .then(([actualRes, estadoRes]) => {
        if (!actualRes.ok || !estadoRes.ok) {
          setLoadError(GENERIC_ERROR);
          setLoading(false);
          return;
        }
        setActual(actualRes.data?.actual ?? null);
        setEstadoOperativo(estadoRes.data?.estadoOperativo ?? null);
        setLoading(false);
      })
      .catch(() => {
        setLoadError(GENERIC_ERROR);
        setLoading(false);
      });
  }

  function loadHistorial() {
    getCicloHistorial(predioId, potreroId).then(({ ok, data }) => {
      if (ok) setHistorial(Array.isArray(data?.historial) ? data.historial : []);
    });
  }

  useEffect(() => {
    loadActual();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [predioId, potreroId]);

  // SPRINT-3D9.3: muestra el aforo que se usaría como base real ANTES de
  // confirmar "Iniciar pastoreo" -- solo se consulta cuando el potrero
  // realmente está por iniciar (nunca de entrada, mismo criterio que
  // fichaEvaluacion más abajo). Read-only, nunca bloquea el inicio.
  useEffect(() => {
    if (actual || estadoOperativo?.estado !== 'DISPONIBLE') {
      setAforoPreview(null);
      return;
    }
    getAforoBasePreview(predioId, potreroId).then(({ ok, data }) => {
      if (ok) setAforoPreview(data ?? null);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actual, estadoOperativo?.estado, predioId, potreroId]);

  // El aforo más reciente se consulta SOLO cuando hace falta evaluar
  // reingreso -- nunca de entrada, para no pedir un dato que no se va a
  // usar en el caso normal (DISPONIBLE/EN_PASTOREO).
  useEffect(() => {
    if (estadoOperativo?.estado !== 'EVALUACION_REINGRESO') return;
    getFichaProductiva(predioId, potreroId).then(({ ok, data }) => {
      if (ok) setFichaEvaluacion(data?.actual ?? null);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [estadoOperativo?.estado, predioId, potreroId]);

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
    // SPRINT-3D9.3: mismo criterio -- precarga SIEMPRE desde el plan
    // vigente en ese instante, nunca desde un ajuste previo.
    setAjusteProduccionLecheLDia(planLote?.produccionLecheLDia != null ? String(planLote.produccionLecheLDia) : '');
    setAjusteDiasEnLeche(planLote?.diasEnLeche != null ? String(planLote.diasEnLeche) : '');
    setAjusteGrasaLechePct(planLote?.grasaLechePct != null ? String(planLote.grasaLechePct) : '');
    setAjusteTerneroAlPie(planLote?.terneroAlPie === true);
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
    const categoriaAjustada = resolveCategoriaSeleccionada(ajusteCategoriaCodigo, categorias);
    const { ok, data } = await iniciarCicloPastoreo(predioId, potreroId, {
      numeroAnimales,
      pesoPromedioKg,
      categoriaCodigo: ajusteCategoriaCodigo,
      // SPRINT-3D9.3: solo se envían cuando la categoría los usa -- nunca
      // campos irrelevantes (mismo criterio que PotreroRecomendacionPastoreoPanel).
      ...(categoriaAjustada?.requiereProduccionLeche ? {
        produccionLecheLDia: ajusteProduccionLecheLDia !== '' ? Number(ajusteProduccionLecheLDia) : null,
        grasaLechePct: ajusteGrasaLechePct !== '' ? Number(ajusteGrasaLechePct) : null,
        diasEnLeche: ajusteDiasEnLeche !== '' ? Number(ajusteDiasEnLeche) : null,
      } : {}),
      ...(categoriaAjustada?.requiereTerneroAlPie ? { terneroAlPie: ajusteTerneroAlPie } : {}),
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

  // SPRINT-3D9.2 -- Evaluar reingreso: el sistema NUNCA decide, solo
  // registra el juicio humano respaldado por el aforo más reciente.
  async function handleEvaluar(resultado) {
    if (evaluando || !fichaEvaluacion) return;
    if (resultado === 'NO_APTO' && !mostrarObservacionNoApto) {
      setMostrarObservacionNoApto(true);
      return;
    }
    if (resultado === 'NO_APTO' && observacionEvaluacion.trim() === '') {
      setEvaluarError(resolveErrorMessage('INVALID_OBSERVACION_EVALUACION'));
      return;
    }
    setEvaluando(true);
    setEvaluarError('');
    const { ok, data } = await evaluarReingreso(predioId, potreroId, {
      fichaId: fichaEvaluacion.fichaId, resultado, observacion: resultado === 'NO_APTO' ? observacionEvaluacion.trim() : undefined,
    });
    setEvaluando(false);
    if (!ok) {
      setEvaluarError(resolveErrorMessage(data?.error));
      return;
    }
    setMostrarObservacionNoApto(false);
    setObservacionEvaluacion('');
    loadActual();
  }

  function handleAbrirHistorial() {
    const abrir = !mostrarHistorial;
    setMostrarHistorial(abrir);
    if (abrir && historial.length === 0) loadHistorial();
  }

  function handleAbrirAnular(cicloId) {
    setAccionCicloId(cicloId);
    setAccionTipo('anular');
    setMotivoAccion('');
    setAccionError('');
  }

  function handleAbrirCorregir(ciclo) {
    setAccionCicloId(ciclo.cicloId);
    setAccionTipo('corregir');
    setMotivoAccion('');
    setAccionError('');
    // Precarga con los valores ACTUALES del ciclo -- el usuario solo
    // edita el campo que estaba mal, nunca reescribe todo a ciegas.
    setCorregirCampos({
      fechaIngresoReal: ciclo.fechaIngresoReal || '',
      fechaSalidaReal: ciclo.fechaSalidaReal || '',
      categoriaCodigo: '',
      numeroAnimales: String(ciclo.numeroAnimalesReal ?? ''),
      pesoPromedioKg: String(ciclo.pesoPromedioRealKg ?? ''),
    });
  }

  function handleCerrarAccion() {
    setAccionCicloId(null);
    setAccionTipo(null);
    setAccionError('');
  }

  async function handleConfirmarAnular() {
    if (accionEnCurso) return;
    if (motivoAccion.trim() === '') {
      setAccionError(resolveErrorMessage('INVALID_MOTIVO_ANULACION'));
      return;
    }
    setAccionEnCurso(true);
    setAccionError('');
    const { ok, data } = await anularCicloPastoreo(predioId, potreroId, accionCicloId, motivoAccion.trim());
    setAccionEnCurso(false);
    if (!ok) {
      setAccionError(resolveErrorMessage(data?.error));
      return;
    }
    handleCerrarAccion();
    loadHistorial();
    loadActual();
  }

  async function handleConfirmarCorregir() {
    if (accionEnCurso) return;
    if (motivoAccion.trim() === '') {
      setAccionError(resolveErrorMessage('INVALID_MOTIVO_CORRECCION'));
      return;
    }
    const cambios = {};
    if (corregirCampos.fechaIngresoReal) cambios.fechaIngresoReal = corregirCampos.fechaIngresoReal;
    if (corregirCampos.fechaSalidaReal) cambios.fechaSalidaReal = corregirCampos.fechaSalidaReal;
    if (corregirCampos.categoriaCodigo) cambios.categoriaCodigo = corregirCampos.categoriaCodigo;
    if (corregirCampos.numeroAnimales !== '') cambios.numeroAnimales = Number(corregirCampos.numeroAnimales);
    if (corregirCampos.pesoPromedioKg !== '') cambios.pesoPromedioKg = Number(corregirCampos.pesoPromedioKg);
    if (Object.keys(cambios).length === 0) {
      setAccionError(resolveErrorMessage('SIN_CAMBIOS_SOLICITADOS'));
      return;
    }
    setAccionEnCurso(true);
    setAccionError('');
    const { ok, data } = await corregirCicloPastoreo(predioId, potreroId, accionCicloId, cambios, motivoAccion.trim());
    setAccionEnCurso(false);
    if (!ok) {
      setAccionError(resolveErrorMessage(data?.error));
      return;
    }
    handleCerrarAccion();
    loadHistorial();
    loadActual();
  }

  if (loading) {
    return <p className="gan-potrero-points-hint">Cargando pastoreo real...</p>;
  }

  if (loadError) {
    return <StatusMessage type="error">{loadError}</StatusMessage>;
  }

  const estado = estadoOperativo?.estado;
  const bloqueadoPorArchivo = estado === 'ARCHIVADO';
  const enDescanso = estado === 'EN_DESCANSO';
  const enEvaluacion = estado === 'EVALUACION_REINGRESO';
  const ventana = estadoOperativo?.descanso;

  return (
    <div className="gan-ficha-productiva-panel gan-ciclo-pastoreo-panel">
      <p className="gan-capacidad-section-label">Pastoreo real</p>

      {estado && estado !== 'DISPONIBLE' ? (
        <StatusMessage type={bloqueadoPorArchivo ? 'error' : 'info'}>
          {ESTADO_OPERATIVO_LABELS[estado] || estado}
        </StatusMessage>
      ) : null}

      {/* El resultado del descanso post-real (FASE B) se muestra sin
          importar si el ciclo recién finalizado ya desapareció de
          `actual` tras el refresco -- es la confirmación de la acción que
          el usuario acaba de ejecutar, nunca debe desaparecer de golpe. */}
      {descansoResultado ? (
        <StatusMessage type={DESCANSO_ESTADO_MESSAGES[descansoResultado]?.type || 'info'}>
          {DESCANSO_ESTADO_MESSAGES[descansoResultado]?.text || ''}
        </StatusMessage>
      ) : null}

      {!actual && !bloqueadoPorArchivo && (enDescanso || enEvaluacion) && ventana ? (
        <div className="gan-ficha-preview">
          <div className="gan-ficha-row"><span>Ventana mínima de reingreso</span><strong>{formatDateDisplay(ventana.fechaReingresoMin)}</strong></div>
          <div className="gan-ficha-row"><span>Ventana recomendada</span><strong>{formatDateDisplay(ventana.fechaReingresoRecomendada)}</strong></div>
          <div className="gan-ficha-row"><span>Ventana máxima</span><strong>{formatDateDisplay(ventana.fechaReingresoMax)}</strong></div>
        </div>
      ) : null}

      {!actual && enEvaluacion ? (
        <div className="gan-stack">
          {!fichaEvaluacion ? (
            <p className="gan-potrero-points-hint">Cargando último aforo...</p>
          ) : fichaEvaluacion.fechaAforo && ventana && fichaEvaluacion.fechaAforo >= ventana.fechaReingresoMin ? (
            <>
              <p className="gan-potrero-points-hint">Aforo más reciente: {formatDateDisplay(fichaEvaluacion.fechaAforo)}.</p>
              <StatusMessage type="error">{evaluarError}</StatusMessage>
              {!mostrarObservacionNoApto ? (
                <div className="gan-potrero-actions">
                  <button type="button" className="gan-submit" onClick={() => handleEvaluar('APTO')} disabled={evaluando}>
                    {evaluando ? 'Guardando...' : 'Apto -- reingresar'}
                  </button>
                  <button type="button" className="gan-back-inline" onClick={() => handleEvaluar('NO_APTO')} disabled={evaluando}>
                    No apto todavía
                  </button>
                </div>
              ) : (
                <div className="gan-stack">
                  <FormField label="Observación" required>
                    <input
                      type="text"
                      value={observacionEvaluacion}
                      onChange={(event) => setObservacionEvaluacion(event.target.value)}
                    />
                  </FormField>
                  <div className="gan-potrero-actions">
                    <button type="button" className="gan-secondary-button" onClick={() => handleEvaluar('NO_APTO')} disabled={evaluando}>
                      {evaluando ? 'Guardando...' : 'Confirmar no apto'}
                    </button>
                    <button type="button" className="gan-back-inline" onClick={() => setMostrarObservacionNoApto(false)} disabled={evaluando}>
                      Volver
                    </button>
                  </div>
                </div>
              )}
            </>
          ) : (
            <p className="gan-potrero-points-hint">Registra un aforo nuevo (ficha productiva) para este potrero, fechado desde hoy en adelante, y vuelve aquí para evaluar el reingreso.</p>
          )}
        </div>
      ) : null}

      {!actual && !bloqueadoPorArchivo && !enDescanso && !enEvaluacion ? (
        <div className="gan-ficha-productiva-empty">
          {planLote ? (
            <div className="gan-ficha-row"><span>Lote</span><strong>{planLote.numeroAnimales} animales ({planLote.pesoPromedioKg} kg prom.)</strong></div>
          ) : null}

          {/* SPRINT-3D9.3, diseño punto 12: aforo base real -- se muestra
              ANTES de confirmar, nunca bloquea el inicio. */}
          {aforoPreview ? (
            aforoPreview.fichaIdBaseReal ? (
              <p className="gan-potrero-points-hint">Aforo base real: {formatDateDisplay(aforoPreview.fechaAforo)}.</p>
            ) : (
              <p className="gan-potrero-points-hint">No hay un aforo registrado antes del inicio. El descanso usará temporalmente la estimación planificada.</p>
            )
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

              {/* SPRINT-3D9.3: campos condicionales REAL -- mismo criterio
                  que PotreroRecomendacionPastoreoPanel.jsx (11/13
                  categorías no muestran nada de esto). */}
              {resolveCategoriaSeleccionada(ajusteCategoriaCodigo, categorias)?.requiereProduccionLeche ? (
                <>
                  <FormField label="Producción de leche (L/vaca/día)">
                    <input
                      type="number" min="0" step="any"
                      value={ajusteProduccionLecheLDia}
                      onChange={(event) => setAjusteProduccionLecheLDia(event.target.value)}
                      disabled={iniciando}
                    />
                  </FormField>
                  <FormField label="%grasa de la leche (opcional)">
                    <input
                      type="number" min="0" max="10" step="any"
                      value={ajusteGrasaLechePct}
                      onChange={(event) => setAjusteGrasaLechePct(event.target.value)}
                      disabled={iniciando}
                    />
                  </FormField>
                  <FormField label="Días en leche (solo si aportas %grasa)">
                    <input
                      type="number" min="0" max="500" step="1"
                      value={ajusteDiasEnLeche}
                      onChange={(event) => setAjusteDiasEnLeche(event.target.value)}
                      disabled={iniciando}
                    />
                  </FormField>
                </>
              ) : null}
              {resolveCategoriaSeleccionada(ajusteCategoriaCodigo, categorias)?.requiereTerneroAlPie ? (
                <FormField label="Ternero al pie">
                  <select
                    value={ajusteTerneroAlPie ? 'true' : 'false'}
                    onChange={(event) => setAjusteTerneroAlPie(event.target.value === 'true')}
                    disabled={iniciando}
                  >
                    <option value="false">No</option>
                    <option value="true">Sí</option>
                  </select>
                </FormField>
              ) : null}

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
                Cancelar registro
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

      {/* SPRINT-3D9.2: historial -- "Anular registro" (ciclo histórico que
          nunca debió contar) y "Corregir información" (dato real
          capturado mal). Nunca una eliminación definitiva para historia. */}
      <button type="button" className="gan-back-inline" onClick={handleAbrirHistorial}>
        {mostrarHistorial ? 'Ocultar historial' : 'Ver historial'}
      </button>

      {mostrarHistorial ? (
        <div className="gan-ficha-historial-list">
          {historial.length === 0 ? <p className="gan-potrero-points-hint">Sin ciclos anteriores.</p> : null}
          {historial.map((ciclo) => (
            <div className="gan-ficha-historial-item" key={ciclo.cicloId}>
              <strong>{HISTORIAL_ESTADO_LABELS[ciclo.estado] || ciclo.estado}</strong>
              <span>{ciclo.numeroAnimalesReal} animales, {ciclo.pesoPromedioRealKg} kg prom.</span>
              <span>Ingreso: {formatDateDisplay(ciclo.fechaIngresoReal)}</span>
              {ciclo.fechaSalidaReal ? <span>Salida: {formatDateDisplay(ciclo.fechaSalidaReal)}</span> : null}

              {ciclo.estado !== 'ANULADO' && accionCicloId !== ciclo.cicloId ? (
                <div className="gan-potrero-actions">
                  <button type="button" className="gan-back-inline" onClick={() => handleAbrirAnular(ciclo.cicloId)}>
                    Anular registro
                  </button>
                  {ciclo.estado === 'FINALIZADO' ? (
                    <button type="button" className="gan-back-inline" onClick={() => handleAbrirCorregir(ciclo)}>
                      Corregir información
                    </button>
                  ) : null}
                </div>
              ) : null}

              {accionCicloId === ciclo.cicloId && accionTipo === 'anular' ? (
                <div className="gan-stack">
                  <FormField label="Motivo de la anulación" required>
                    <input type="text" value={motivoAccion} onChange={(event) => setMotivoAccion(event.target.value)} />
                  </FormField>
                  <StatusMessage type="error">{accionError}</StatusMessage>
                  <div className="gan-potrero-actions">
                    <button type="button" className="gan-secondary-button" onClick={handleConfirmarAnular} disabled={accionEnCurso}>
                      {accionEnCurso ? 'Anulando...' : 'Confirmar anulación'}
                    </button>
                    <button type="button" className="gan-back-inline" onClick={handleCerrarAccion} disabled={accionEnCurso}>
                      Volver
                    </button>
                  </div>
                </div>
              ) : null}

              {accionCicloId === ciclo.cicloId && accionTipo === 'corregir' ? (
                <div className="gan-stack">
                  <FormField label="Fecha de ingreso real">
                    <input
                      type="date"
                      value={corregirCampos.fechaIngresoReal}
                      onChange={(event) => setCorregirCampos((c) => ({ ...c, fechaIngresoReal: event.target.value }))}
                    />
                  </FormField>
                  <FormField label="Fecha de salida real">
                    <input
                      type="date"
                      value={corregirCampos.fechaSalidaReal}
                      onChange={(event) => setCorregirCampos((c) => ({ ...c, fechaSalidaReal: event.target.value }))}
                    />
                  </FormField>
                  <FormField label="Categoría">
                    <select
                      value={corregirCampos.categoriaCodigo}
                      onChange={(event) => setCorregirCampos((c) => ({ ...c, categoriaCodigo: event.target.value }))}
                    >
                      <option value="">Sin cambio</option>
                      {(categorias || []).map((categoria) => (
                        <option key={categoria.codigo} value={categoria.codigo}>{categoria.nombre}</option>
                      ))}
                    </select>
                  </FormField>
                  <FormField label="Número de animales">
                    <input
                      type="number" min="1" max="100000" step="1"
                      value={corregirCampos.numeroAnimales}
                      onChange={(event) => setCorregirCampos((c) => ({ ...c, numeroAnimales: event.target.value }))}
                    />
                  </FormField>
                  <FormField label="Peso promedio (kg)">
                    <input
                      type="number" min="0" max="2000" step="any"
                      value={corregirCampos.pesoPromedioKg}
                      onChange={(event) => setCorregirCampos((c) => ({ ...c, pesoPromedioKg: event.target.value }))}
                    />
                  </FormField>
                  <FormField label="Motivo de la corrección" required>
                    <input type="text" value={motivoAccion} onChange={(event) => setMotivoAccion(event.target.value)} />
                  </FormField>
                  <StatusMessage type="error">{accionError}</StatusMessage>
                  <div className="gan-potrero-actions">
                    <button type="button" className="gan-secondary-button" onClick={handleConfirmarCorregir} disabled={accionEnCurso}>
                      {accionEnCurso ? 'Guardando...' : 'Guardar corrección'}
                    </button>
                    <button type="button" className="gan-back-inline" onClick={handleCerrarAccion} disabled={accionEnCurso}>
                      Volver
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
