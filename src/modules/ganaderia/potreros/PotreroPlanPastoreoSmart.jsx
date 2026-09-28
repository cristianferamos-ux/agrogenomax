// SPRINT-3D10.4 FASE 4 -- EXPERIENCIA SIMPLE DEL PRODUCTOR: consume el
// motor automático de carga recomendada (3D10.4 Fase 3, endpoints
// .../recomendacion-pastoreo/auto*). Reemplaza como flujo PRINCIPAL a
// PotreroRecomendacionPastoreoPanel.jsx (que ahora vive detrás de
// "Opciones avanzadas" en PotreroMotorPastoreoPanel.jsx -- NO se elimina,
// NO se deprecia, sigue 100% operativo).
//
// Objetivo de producto (§0 del sprint): el productor solo aporta
// categoría, peso promedio y fecha prevista de ingreso -- AgroGenomaX
// responde cuántos animales, cuántos días y cuándo sale. La cantidad de
// animales es SIEMPRE output, nunca input en este camino.
//
// Regla dura (§11 del sprint): "Usar esta recomendación"/"Guardar" NUNCA
// envía resultados del preview -- solo los inputs originales. El backend
// recalcula desde cero (protección stale-preview, 3D10.4 Fase 3 §9).
import { useEffect, useState } from 'react';
import { FormField, StatusMessage } from '../components/FormField.jsx';
import { formatDateDisplay } from '../utils/dateFormat.js';
import { buildGruposConCategorias } from './categoriaProductivaSelector.js';
import {
  getCategoriasProductivas,
  getRecomendacionPastoreo,
  previewCargaAutomatica,
  evaluarEscenarioCargaAutomatica,
  guardarCargaAutomatica,
} from './ganaderiaRecomendacionPastoreoApi.js';
import PotreroDescansoReentradaPanel from './PotreroDescansoReentradaPanel.jsx';
import PotreroCicloPastoreoPanel from './PotreroCicloPastoreoPanel.jsx';
import { buildBodyAuto, isFormComplete } from './potreroPlanPastoreoSmartLogic.js';

export { buildBodyAuto, isFormComplete };

const GENERIC_ERROR = 'No fue posible completar la operación en este momento. Intenta nuevamente.';

// §28 del sprint: traducir códigos HTTP/negocio a lenguaje humano -- nunca
// mostrar el código crudo, SQL ni stack al productor.
const ERROR_MESSAGES = {
  NO_PRODUCTIVE_PROFILE: 'Selecciona una categoría productiva válida.',
  INVALID_CATEGORIA_CODIGO: 'Selecciona una categoría productiva válida.',
  INVALID_PESO_PROMEDIO: 'El peso promedio debe ser mayor que 0.',
  PESO_PROMEDIO_TOO_HIGH: 'El peso promedio supera el máximo permitido (2.000 kg).',
  PESO_FUERA_DE_RANGO_CATEGORIA: 'El peso promedio ingresado está fuera del rango esperado para esta categoría.',
  INVALID_FECHA_INGRESO_PREVISTA: 'Ingresa una fecha de ingreso válida.',
  INVALID_PRODUCCION_LECHE: 'Los litros promedio por vaca/día deben estar entre 0 y 60.',
  INVALID_DIAS_EN_LECHE: 'Los días en leche deben ser un número mayor que 0.',
  MISSING_PRODUCCION_LECHE: 'Esta categoría requiere el promedio de litros/vaca/día.',
  MISSING_DIAS_EN_LECHE: 'Si aportas el %grasa de la leche, también debes indicar los días en leche.',
  INVALID_GRASA_LECHE: 'El %grasa de la leche debe ser un número entre 0 y 10.',
  MISSING_TERNERO_AL_PIE: 'Indica si hay ternero al pie.',
  INVALID_NUMERO_ANIMALES_USUARIO: 'Ingresa una cantidad de animales válida (entero, 1 o más).',
  NUMERO_ANIMALES_USUARIO_TOO_HIGH: 'Esa cantidad supera el máximo permitido.',
  POTRERO_NOT_FOUND: 'Este potrero ya no está disponible.',
  INPUT_INVALID: GENERIC_ERROR,
};

function resolveErrorMessage(code) {
  return ERROR_MESSAGES[code] || GENERIC_ERROR;
}

function formatDiasSimple(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '—';
  return `${num} ${num === 1 ? 'día' : 'días'}`;
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

const INITIAL_FORM = { pesoPromedioKg: '', fechaIngresoPrevista: '', produccionLecheLDia: '', diasEnLeche: '', grasaLechePct: '', terneroAlPie: false };

// §19 del sprint: cerrado por defecto, labels traducidos, nunca JSON
// crudo -- mismo patrón que DetalleTecnico en PotreroDescansoReentradaPanel.jsx.
function DetalleTecnicoAutomatico({ detalle }) {
  const [visible, setVisible] = useState(false);
  if (!detalle) return null;
  return (
    <div className="gan-descanso-detalle-tecnico">
      <button type="button" className="gan-back-inline" onClick={() => setVisible((v) => !v)}>
        {visible ? 'Ocultar detalle técnico' : 'Ver detalle técnico'}
      </button>
      {visible ? (
        <div className="gan-ficha-preview">
          <div className="gan-ficha-row"><span>Fecha de aforo</span><strong>{formatDateDisplay(detalle.ficha?.fechaAforo) || '—'}</strong></div>
          <div className="gan-ficha-row"><span>Biomasa fresca</span><strong>{Number(detalle.ficha?.biomasaFrescaKg ?? 0).toFixed(1)} kg</strong></div>
          <div className="gan-ficha-row"><span>% materia seca aplicado</span><strong>{detalle.materiaSecaPctAplicada}%</strong></div>
          <div className="gan-ficha-row"><span>% utilización aplicado</span><strong>{detalle.utilizacionPctAplicada}%</strong></div>
          <div className="gan-ficha-row"><span>Materia seca total</span><strong>{Number(detalle.materiaSecaTotalKg ?? 0).toFixed(1)} kg</strong></div>
          <div className="gan-ficha-row"><span>Materia seca utilizable</span><strong>{Number(detalle.materiaSecaUtilizableKg ?? 0).toFixed(1)} kg</strong></div>
          <div className="gan-ficha-row"><span>Demanda individual</span><strong>{Number(detalle.demandaIndividualKgMsDia ?? 0).toFixed(2)} kg MS/día</strong></div>
          {detalle.consumoOperativoKg != null ? <div className="gan-ficha-row"><span>Consumo estimado</span><strong>{Number(detalle.consumoOperativoKg).toFixed(1)} kg</strong></div> : null}
          {detalle.remanenteOperativoKg != null ? <div className="gan-ficha-row"><span>Remanente estimado</span><strong>{Number(detalle.remanenteOperativoKg).toFixed(1)} kg</strong></div> : null}
          {detalle.margenForrajeKg != null ? <div className="gan-ficha-row"><span>Margen de forraje</span><strong>{Number(detalle.margenForrajeKg).toFixed(1)} kg</strong></div> : null}
          {detalle.diasMaximosSoportadosExactos != null ? <div className="gan-ficha-row"><span>Capacidad máxima física</span><strong>{Number(detalle.diasMaximosSoportadosExactos).toFixed(2)} días</strong></div> : null}
          <div className="gan-ficha-row"><span>Contexto agroclimático</span><strong>{detalle.estadoContexto === 'READY' ? 'Disponible' : 'Parcial/no disponible'}</strong></div>
          <div className="gan-ficha-row"><span>Fuente de consumo</span><strong>{detalle.dmiModel === 'NRC_2001_DAIRY_DMI' ? 'Ecuación NRC (2001)' : 'Perfil de categoría'}</strong></div>
          <div className="gan-ficha-row"><span>Nivel de confianza</span><strong>{detalle.nivelConfianza}</strong></div>
          <div className="gan-ficha-row"><span>Motor</span><strong>versión de política: {detalle.occupationPolicy?.version}</strong></div>
        </div>
      ) : null}
    </div>
  );
}

export default function PotreroPlanPastoreoSmart({ predioId, potreroId, tieneFicha, onCrearFicha }) {
  const [categorias, setCategorias] = useState([]);
  const [categoriasError, setCategoriasError] = useState('');

  // Estado "¿ya existe un plan guardado?" -- se consulta al montar para no
  // perder continuidad entre recargas de página (mismo GET ya existente,
  // compartido con el flujo manual -- sin endpoint nuevo).
  const [loading, setLoading] = useState(tieneFicha);
  const [actual, setActual] = useState(null);
  // Resultado completo de ESTA sesión al guardar (incluye días/motivo/
  // fechas -- campos que el GET compartido con el flujo manual no expone
  // todavía). Si existe, se prioriza sobre `actual` para la tarjeta.
  const [savedThisSession, setSavedThisSession] = useState(null);

  const [aforoFaltante, setAforoFaltante] = useState(false);

  const [grupoAbierto, setGrupoAbierto] = useState(null);
  const [categoriaCodigo, setCategoriaCodigo] = useState('');
  const [form, setForm] = useState({ ...INITIAL_FORM, fechaIngresoPrevista: todayIso() });
  const [preview, setPreview] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  const [showEscenario, setShowEscenario] = useState(false);
  const [numeroAnimalesUsuario, setNumeroAnimalesUsuario] = useState('');
  const [escenario, setEscenario] = useState(null);
  const [escenarioLoading, setEscenarioLoading] = useState(false);
  const [escenarioError, setEscenarioError] = useState('');
  // §16/§26 del sprint: cantidad alternativa elegida en el escenario --
  // NUNCA crea una recomendación automática nueva. Se conserva solo como
  // INTENCIÓN, para precargar "Ajustar lote" en PotreroCicloPastoreoPanel
  // al confirmar ingreso una vez guardado el plan. La recomendación AGX
  // persistida sigue siendo la original (§20: PLAN ≠ REAL).
  const [selectedRealOverride, setSelectedRealOverride] = useState(null);

  const [descansoRefreshKey, setDescansoRefreshKey] = useState(0);

  useEffect(() => {
    let active = true;
    getCategoriasProductivas().then(({ ok, data }) => {
      if (!active) return;
      if (!ok || !Array.isArray(data?.categorias)) {
        setCategoriasError(GENERIC_ERROR);
        return;
      }
      setCategorias(data.categorias);
    }).catch(() => {
      if (active) setCategoriasError(GENERIC_ERROR);
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!tieneFicha) {
      setLoading(false);
      return undefined;
    }
    let active = true;
    setLoading(true);
    getRecomendacionPastoreo(predioId, potreroId).then(({ ok, data }) => {
      if (!active) return;
      setActual(ok ? (data?.actual ?? null) : null);
      setLoading(false);
    }).catch(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [predioId, potreroId, tieneFicha]);

  const categoriaSeleccionada = categorias.find((c) => c.codigo === categoriaCodigo) || null;

  // §26/§27 del sprint: cualquier cambio de input invalida el preview y
  // cualquier escenario derivado de él -- nunca dejar visible un resultado
  // calculado con datos que ya no corresponden al formulario actual.
  function invalidarCalculoPrevio() {
    setPreview(null);
    setPreviewError('');
    setShowEscenario(false);
    setEscenario(null);
    setEscenarioError('');
    setNumeroAnimalesUsuario('');
    setSelectedRealOverride(null);
  }

  function updateField(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
    invalidarCalculoPrevio();
  }

  function selectCategoria(codigo) {
    setCategoriaCodigo(codigo);
    setForm({ ...INITIAL_FORM, fechaIngresoPrevista: form.fechaIngresoPrevista || todayIso() });
    invalidarCalculoPrevio();
  }

  function volverAPlanear() {
    setSavedThisSession(null);
    setActual(null);
    setCategoriaCodigo('');
    setForm({ ...INITIAL_FORM, fechaIngresoPrevista: todayIso() });
    invalidarCalculoPrevio();
  }

  async function handleCalcular() {
    if (previewLoading || !isFormComplete(categoriaSeleccionada, form)) return;
    setPreviewLoading(true);
    setPreviewError('');
    const { ok, data } = await previewCargaAutomatica(predioId, potreroId, buildBodyAuto(categoriaSeleccionada, form));
    setPreviewLoading(false);
    if (!ok) {
      if (data?.error === 'INSUFFICIENT_FORAGE_DATA') {
        setAforoFaltante(true);
        return;
      }
      setPreviewError(resolveErrorMessage(data?.error));
      return;
    }
    setPreview(data);
  }

  async function handleGuardar() {
    if (saving || !preview || preview.estado !== 'OK') return;
    setSaving(true);
    setSaveError('');
    const { ok, data } = await guardarCargaAutomatica(predioId, potreroId, buildBodyAuto(categoriaSeleccionada, form));
    setSaving(false);
    if (!ok) {
      if (data?.error === 'INSUFFICIENT_FORAGE_DATA') {
        setAforoFaltante(true);
        return;
      }
      setSaveError(resolveErrorMessage(data?.error));
      return;
    }
    setSavedThisSession({
      ...data.recomendacion,
      categoriaNombre: categoriaSeleccionada.nombre,
      pesoPromedioKg: Number(form.pesoPromedioKg),
      produccionLecheLDia: categoriaSeleccionada.requiereProduccionLeche && form.produccionLecheLDia !== '' ? Number(form.produccionLecheLDia) : null,
      diasEnLeche: categoriaSeleccionada.requiereProduccionLeche && form.diasEnLeche !== '' ? Number(form.diasEnLeche) : null,
      grasaLechePct: categoriaSeleccionada.requiereProduccionLeche && form.grasaLechePct !== '' ? Number(form.grasaLechePct) : null,
      terneroAlPie: categoriaSeleccionada.requiereTerneroAlPie ? form.terneroAlPie : null,
    });
    setPreview(null);
    setShowEscenario(false);
  }

  async function handleEvaluarEscenario() {
    const parsed = Number(numeroAnimalesUsuario);
    if (escenarioLoading || !Number.isInteger(parsed) || parsed < 1) return;
    setEscenarioLoading(true);
    setEscenarioError('');
    const { ok, data } = await evaluarEscenarioCargaAutomatica(predioId, potreroId, {
      ...buildBodyAuto(categoriaSeleccionada, form),
      numeroAnimalesUsuario: parsed,
    });
    setEscenarioLoading(false);
    if (!ok) {
      if (data?.error === 'INSUFFICIENT_FORAGE_DATA') {
        setAforoFaltante(true);
        return;
      }
      setEscenarioError(resolveErrorMessage(data?.error));
      return;
    }
    setEscenario(data);
  }

  // §16 del sprint: NUNCA crea otra recomendación automática -- solo
  // conserva la intención de ajuste real y vuelve a mostrar la
  // recomendación AGX original (que el usuario todavía debe guardar).
  function handleUsarCantidadEscenario() {
    setSelectedRealOverride(Number(numeroAnimalesUsuario));
    setShowEscenario(false);
    setEscenario(null);
  }

  // -----------------------------------------------------------------------
  // §3: sin aforo válido -- ni fichaId/MSU/enum técnico en la superficie
  // principal. Cubre tanto "nunca hubo ficha" (tieneFicha=false, ya
  // resuelto arriba en la jerarquía) como "aforo anterior al último
  // pastoreo" (descubierto recién al intentar calcular/guardar).
  // -----------------------------------------------------------------------
  if (!tieneFicha || aforoFaltante) {
    return (
      <div className="gan-ficha-productiva-panel gan-plan-pastoreo-smart">
        <div className="gan-ficha-productiva-empty">
          <p className="gan-potrero-points-hint">
            Necesitamos medir cuánto pasto hay disponible antes de recomendar el próximo pastoreo.
          </p>
          <button type="button" className="gan-secondary-button" onClick={onCrearFicha}>
            Registrar aforo
          </button>
        </div>
      </div>
    );
  }

  if (loading) {
    return <p className="gan-potrero-points-hint">Cargando plan de pastoreo...</p>;
  }

  // -----------------------------------------------------------------------
  // Estado "plan guardado" -- prioriza el resultado rico de esta sesión;
  // si no existe (recarga de página), usa el `actual` del GET compartido
  // con el flujo manual (shape más simple, pero suficiente para alimentar
  // planLote/descanso/ciclo real exactamente igual que el flujo anterior).
  // -----------------------------------------------------------------------
  const planGuardado = savedThisSession || actual;

  if (planGuardado && !showEscenario) {
    const esRico = Boolean(savedThisSession);
    // §16/§20 del sprint: si el usuario eligió una cantidad alternativa
    // durante el escenario, esa cantidad precarga "Ajustar lote" al
    // confirmar ingreso -- la recomendación AGX persistida (numeroAnimalesRecomendado)
    // NUNCA se altera, "Ajustar lote" ya la deja disponible como opción.
    const numeroAnimalesParaIngreso = esRico
      ? (selectedRealOverride ?? planGuardado.numeroAnimalesRecomendado)
      : planGuardado.numeroAnimales;
    const planLote = {
      categoriaCodigo: planGuardado.categoriaCodigo,
      categoriaNombre: planGuardado.categoriaNombre,
      numeroAnimales: numeroAnimalesParaIngreso,
      pesoPromedioKg: planGuardado.pesoPromedioKg,
      produccionLecheLDia: planGuardado.produccionLecheLDia,
      diasEnLeche: planGuardado.diasEnLeche,
      grasaLechePct: planGuardado.grasaLechePct,
      terneroAlPie: planGuardado.terneroAlPie,
    };
    return (
      <div className="gan-ficha-productiva-panel gan-plan-pastoreo-smart">
        <div className="gan-ficha-preview gan-recomendacion-resultado">
          <p className="gan-capacidad-section-label">Plan de pastoreo</p>
          <div className="gan-ficha-row"><span>Recomendamos</span><strong>{esRico ? planGuardado.numeroAnimalesRecomendado : planGuardado.numeroAnimales} {planLote.categoriaNombre || 'animales'}</strong></div>
          {esRico ? (
            <>
              <div className="gan-ficha-row"><span>Permanencia</span><strong>{formatDiasSimple(planGuardado.diasPermanenciaRecomendada)}</strong></div>
              <div className="gan-ficha-row"><span>Ingreso</span><strong>{formatDateDisplay(planGuardado.fechaIngresoPrevista)}</strong></div>
              <div className="gan-ficha-row"><span>Salida estimada</span><strong>{formatDateDisplay(planGuardado.fechaSalidaEstimada)}</strong></div>
              {planGuardado.motivoDuracion === 'FALLBACK_MIN_2_DAYS' ? (
                <p className="gan-potrero-points-hint">Hay poco pasto disponible para esta categoría.</p>
              ) : null}
            </>
          ) : null}
          {selectedRealOverride != null && selectedRealOverride !== planGuardado.numeroAnimalesRecomendado ? (
            <p className="gan-potrero-points-hint">
              Elegiste ingresar con {selectedRealOverride} animales -- "Ajustar lote" abajo ya lo trae precargado.
            </p>
          ) : null}
        </div>
        <div className="gan-potrero-actions">
          <button type="button" className="gan-secondary-button" onClick={volverAPlanear}>
            Nueva recomendación
          </button>
        </div>

        <PotreroDescansoReentradaPanel predioId={predioId} potreroId={potreroId} refreshKey={descansoRefreshKey} />
        <PotreroCicloPastoreoPanel
          predioId={predioId}
          potreroId={potreroId}
          planLote={planLote}
          categorias={categorias}
          onDescansoChange={() => setDescansoRefreshKey((k) => k + 1)}
        />
      </div>
    );
  }

  const grupos = buildGruposConCategorias(categorias);

  return (
    <div className="gan-ficha-productiva-panel gan-plan-pastoreo-smart">
      <div className="gan-stack">
        {categoriasError ? <StatusMessage type="error">{categoriasError}</StatusMessage> : null}

        {!categoriaSeleccionada ? (
          <div className="gan-recomendacion-selector">
            <p className="gan-capacidad-section-label">¿Qué vas a manejar en este potrero?</p>
            {grupos.map((grupoDef) => (
              <div className="gan-recomendacion-grupo" key={grupoDef.grupo}>
                <button
                  type="button"
                  className="gan-secondary-button"
                  aria-expanded={grupoAbierto === grupoDef.grupo}
                  onClick={() => setGrupoAbierto((current) => (current === grupoDef.grupo ? null : grupoDef.grupo))}
                >
                  {grupoDef.label}
                </button>
                {grupoAbierto === grupoDef.grupo ? (
                  <div className="gan-recomendacion-categorias" role="listbox" aria-label={grupoDef.label}>
                    {grupoDef.categorias.map((cat) => (
                      <button type="button" key={cat.codigo} className="gan-back-inline" onClick={() => selectCategoria(cat.codigo)}>
                        {cat.nombre}
                      </button>
                    ))}
                    {grupoDef.comingSoon ? grupoDef.comingSoon.map((label) => (
                      <span className="gan-potrero-points-hint" key={label}>{label} — próximamente</span>
                    )) : null}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        ) : (
          <>
            <div className="gan-ficha-row">
              <span>Categoría seleccionada</span>
              <strong>{categoriaSeleccionada.nombre}</strong>
              <button type="button" className="gan-back-inline" onClick={() => selectCategoria('')}>Cambiar</button>
            </div>

            <FormField label="Peso promedio (kg)" required>
              <input type="number" min="0" max="2000" step="any" value={form.pesoPromedioKg} onChange={(e) => updateField('pesoPromedioKg', e.target.value)} />
            </FormField>

            <FormField label="Fecha prevista de ingreso" required>
              <input type="date" value={form.fechaIngresoPrevista} onChange={(e) => updateField('fechaIngresoPrevista', e.target.value)} />
            </FormField>

            {categoriaSeleccionada.requiereProduccionLeche ? (
              <>
                <FormField label="Litros promedio / vaca / día" required>
                  <input type="number" min="0" max="60" step="any" value={form.produccionLecheLDia} onChange={(e) => updateField('produccionLecheLDia', e.target.value)} />
                </FormField>
                <FormField label="Grasa de la leche (%) — opcional">
                  <input type="number" min="0" max="10" step="any" value={form.grasaLechePct} onChange={(e) => updateField('grasaLechePct', e.target.value)} />
                </FormField>
                <FormField label="Días en leche (desde el parto)" required={form.grasaLechePct !== ''}>
                  <input type="number" min="1" max="500" step="1" value={form.diasEnLeche} onChange={(e) => updateField('diasEnLeche', e.target.value)} />
                </FormField>
              </>
            ) : null}

            {categoriaSeleccionada.requiereTerneroAlPie ? (
              <FormField label="Ternero al pie">
                <input type="checkbox" checked={form.terneroAlPie} onChange={(e) => updateField('terneroAlPie', e.target.checked)} />
              </FormField>
            ) : null}

            <StatusMessage type="error">{previewError}</StatusMessage>

            <div className="gan-potrero-actions">
              <button
                type="button"
                className="gan-secondary-button"
                onClick={handleCalcular}
                disabled={previewLoading || !isFormComplete(categoriaSeleccionada, form)}
              >
                {previewLoading ? 'Calculando...' : 'Calcular recomendación'}
              </button>
            </div>

            {/* §7/§8/§9/§10 del sprint -- resultado por estado de negocio. */}
            {preview && preview.estado === 'OK' && !showEscenario ? (
              <div className="gan-ficha-preview gan-recomendacion-resultado">
                <p className="gan-capacidad-section-label">Recomendamos</p>
                <div className="gan-ficha-row"><span>Cantidad</span><strong>{preview.numeroAnimalesRecomendado} animales</strong></div>
                <div className="gan-ficha-row"><span>Permanencia</span><strong>{formatDiasSimple(preview.diasPermanenciaRecomendada)}</strong></div>
                <div className="gan-ficha-row"><span>Ingreso</span><strong>{formatDateDisplay(preview.fechaIngresoPrevista)}</strong></div>
                <div className="gan-ficha-row"><span>Salida estimada</span><strong>{formatDateDisplay(preview.fechaSalidaEstimada)}</strong></div>
                {preview.detalleTecnico?.motivoDuracion === 'FALLBACK_MIN_2_DAYS' ? (
                  <p className="gan-potrero-points-hint">Hay poco pasto disponible para esta categoría.</p>
                ) : null}
                {selectedRealOverride != null ? (
                  <p className="gan-potrero-points-hint">Elegiste ingresar con {selectedRealOverride} animales al confirmar.</p>
                ) : null}

                <StatusMessage type="error">{saveError}</StatusMessage>
                <div className="gan-potrero-actions">
                  <button type="button" className="gan-submit" onClick={handleGuardar} disabled={saving}>
                    {saving ? 'Guardando...' : 'Usar esta recomendación'}
                  </button>
                  <button type="button" className="gan-back-inline" onClick={() => setShowEscenario(true)} disabled={saving}>
                    Quiero ingresar otra cantidad
                  </button>
                </div>

                <DetalleTecnicoAutomatico detalle={preview.detalleTecnico} />
              </div>
            ) : null}

            {/* §15/§16/§17/§18 del sprint -- cantidad alternativa, NUNCA
                crea una recomendación automática nueva. */}
            {preview && preview.estado === 'OK' && showEscenario ? (
              <div className="gan-ficha-preview gan-recomendacion-escenario">
                <p className="gan-capacidad-section-label">Probar otra cantidad</p>
                <FormField label="Cantidad de animales">
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={numeroAnimalesUsuario}
                    onChange={(e) => { setNumeroAnimalesUsuario(e.target.value); setEscenario(null); setEscenarioError(''); }}
                  />
                </FormField>
                <StatusMessage type="error">{escenarioError}</StatusMessage>
                <div className="gan-potrero-actions">
                  <button
                    type="button"
                    className="gan-secondary-button"
                    onClick={handleEvaluarEscenario}
                    disabled={escenarioLoading || !Number.isInteger(Number(numeroAnimalesUsuario)) || Number(numeroAnimalesUsuario) < 1}
                  >
                    {escenarioLoading ? 'Evaluando...' : 'Evaluar cantidad'}
                  </button>
                  <button type="button" className="gan-back-inline" onClick={() => { setShowEscenario(false); setEscenario(null); }}>
                    Volver a la recomendación
                  </button>
                </div>

                {escenario && escenario.estado === 'TARGET_COMPATIBLE' ? (
                  <>
                    <p className="gan-ficha-row"><span>Con {escenario.numeroAnimalesUsuario} animales recomendamos</span><strong>una permanencia de {formatDiasSimple(escenario.diasPermanenciaEscenario)}.</strong></p>
                    <div className="gan-potrero-actions">
                      <button type="button" className="gan-submit" onClick={handleUsarCantidadEscenario}>Usar esta cantidad al ingresar</button>
                    </div>
                  </>
                ) : null}

                {escenario && escenario.estado === 'MINIMUM_COMPATIBLE' ? (
                  <>
                    <p className="gan-ficha-row"><span>Con esta cantidad recomendamos</span><strong>una permanencia de {formatDiasSimple(escenario.diasPermanenciaEscenario)}.</strong></p>
                    <p className="gan-potrero-points-hint">Esta cantidad utiliza más rápidamente el pasto disponible.</p>
                    <div className="gan-potrero-actions">
                      <button type="button" className="gan-submit" onClick={handleUsarCantidadEscenario}>Usar esta cantidad al ingresar</button>
                    </div>
                  </>
                ) : null}

                {escenario && escenario.estado === 'INSUFFICIENT_FORAGE' ? (
                  <StatusMessage type="warning">Esta cantidad es demasiado alta para el pasto disponible.</StatusMessage>
                ) : null}
              </div>
            ) : null}

            {preview && preview.estado === 'NO_RECOMMENDATION_INSUFFICIENT_FORAGE' ? (
              <StatusMessage type="warning">
                El pasto disponible no alcanza para recomendar este tipo de animal en una rotación adecuada.
              </StatusMessage>
            ) : null}

            {preview && preview.estado === 'PASTURA_SIN_POLITICA_DEFINIDA' ? (
              <StatusMessage type="info">
                Todavía no tenemos una recomendación automática validada para este tipo de cobertura.
              </StatusMessage>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
