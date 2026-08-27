// SPRINT-3D9.1: pruebas arquitectónicas (análisis de texto fuente) --
// mismo patrón que potreroDescansoReentradaArchitecture.test.js. Este repo
// no tiene jsdom/testing-library configurado para render real de
// componentes React en `test:node`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POTREROS_DIR = path.resolve(__dirname, '..');

function readNormalized(filePath) {
  return fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
}

function stripComments(text) {
  return text.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

const panelSource = readNormalized(path.join(POTREROS_DIR, 'PotreroCicloPastoreoPanel.jsx'));
const apiSource = readNormalized(path.join(POTREROS_DIR, 'ganaderiaCicloPastoreoApi.js'));
const apiCode = stripComments(apiSource);
const recomendacionPanelSource = readNormalized(path.join(POTREROS_DIR, 'PotreroRecomendacionPastoreoPanel.jsx'));

// ---------------------------------------------------------------------
// El panel "Pastoreo real" se embebe junto al plan, dentro del bloque de
// recomendación de pastoreo guardada (misma precondición que el panel de
// descanso).
// ---------------------------------------------------------------------

test('PotreroRecomendacionPastoreoPanel embebe el panel de ciclo real junto al panel de descanso', () => {
  assert.match(recomendacionPanelSource, /import PotreroCicloPastoreoPanel from '\.\/PotreroCicloPastoreoPanel\.jsx'/);
  assert.match(recomendacionPanelSource, /<PotreroCicloPastoreoPanel[\s\S]*?predioId=\{predioId\}[\s\S]*?potreroId=\{potreroId\}[\s\S]*?\/>/);
});

// SPRINT-3D9.1 PRE-COMMIT FIX: el panel de ciclo real recibe el plan
// vigente (`planLote`) y el catálogo (`categorias`) YA cargados por el
// padre -- nunca un fetch/catálogo duplicado para "Ajustar lote".
test('PotreroRecomendacionPastoreoPanel pasa planLote (derivado de `actual`) y categorias (mismo catálogo ya cargado) -- nunca un fetch duplicado', () => {
  const bloque = recomendacionPanelSource.match(/<PotreroCicloPastoreoPanel[\s\S]*?\/>/)?.[0] ?? '';
  assert.notEqual(bloque, '');
  assert.match(bloque, /planLote=\{\{/);
  assert.match(bloque, /categoriaCodigo:\s*actual\.categoriaCodigo/);
  assert.match(bloque, /numeroAnimales:\s*actual\.numeroAnimales/);
  assert.match(bloque, /pesoPromedioKg:\s*actual\.pesoPromedioKg/);
  assert.match(bloque, /categorias=\{categorias\}/);
});

test('el panel de ciclo real se monta DESPUÉS del panel de descanso (plan primero, real después)', () => {
  const idxDescanso = recomendacionPanelSource.indexOf('<PotreroDescansoReentradaPanel');
  const idxCiclo = recomendacionPanelSource.indexOf('<PotreroCicloPastoreoPanel');
  assert.ok(idxDescanso >= 0 && idxCiclo >= 0);
  assert.ok(idxCiclo > idxDescanso);
});

// ---------------------------------------------------------------------
// Acciones de un clic: Iniciar / Finalizar / Cancelar. Nunca un selector
// de fecha -- fecha_ingreso_real/fecha_salida_real se resuelven
// server-side.
// ---------------------------------------------------------------------

test('los tres botones de acción existen: Iniciar pastoreo / Finalizar pastoreo / Cancelar', () => {
  assert.match(panelSource, /Iniciar pastoreo/);
  assert.match(panelSource, /Finalizar pastoreo/);
  assert.match(panelSource, /Cancelar/);
});

test('Iniciar/Ajustar lote NUNCA piden una fecha -- fechaIngresoReal se resuelve server-side (la corrección SÍ puede leerla, para precargar el formulario, ver test dedicado más abajo)', () => {
  const bloqueIniciar = panelSource.match(/async function handleIniciar\(\)[\s\S]*?\n  \}/)?.[0] ?? '';
  const bloqueAjuste = panelSource.match(/async function handleConfirmarIniciarConAjuste\(\)[\s\S]*?\n  \}/)?.[0] ?? '';
  assert.notEqual(bloqueIniciar, '');
  assert.notEqual(bloqueAjuste, '');
  assert.doesNotMatch(bloqueIniciar, /fechaIngresoReal/);
  assert.doesNotMatch(bloqueAjuste, /fechaIngresoReal/);
});

// SPRINT-3D9.2: "Corregir información" SÍ introduce selectores de fecha
// -- deliberado, distinto de "Iniciar" (que nunca los tuvo ni los tiene).
// Corregir es una corrección explícita y motivada de un hecho YA
// ocurrido (el usuario dice qué fecha fue realmente), nunca un input de
// "cuándo entra hoy". Se verifica que los ÚNICOS `type="date"` del
// archivo vivan dentro del bloque de corrección.
test('SPRINT-3D9.2: los únicos selectores de fecha del panel viven dentro del formulario de "Corregir información" -- nunca en Iniciar/Ajustar lote', () => {
  const ocurrencias = panelSource.match(/type="date"/g) || [];
  assert.equal(ocurrencias.length, 2, 'exactamente 2: fecha de ingreso real y fecha de salida real, ambas en el formulario de corrección');
  const bloqueCorregir = panelSource.match(/accionTipo === 'corregir' \? \([\s\S]*?\)\s*: null/)?.[0] ?? '';
  const dateEnCorregir = (bloqueCorregir.match(/type="date"/g) || []).length;
  assert.equal(dateEnCorregir, 2, 'los 2 selectores de fecha deben estar DENTRO del bloque de corrección');
});

test('el cliente de API nunca envía fechaIngresoReal/fechaSalidaReal/organizacionId (campos derivados server-side)', () => {
  for (const forbidden of ['fechaIngresoReal', 'fechaSalidaReal', 'organizacionId', 'actorCuentaId']) {
    assert.doesNotMatch(apiCode, new RegExp(forbidden));
  }
});

test('iniciarCicloPastoreo/finalizarCicloPastoreo/cancelarCicloPastoreo/getCicloActual/getCicloHistorial están expuestos', () => {
  assert.match(apiSource, /export function getCicloActual/);
  assert.match(apiSource, /export function getCicloHistorial/);
  assert.match(apiSource, /export function iniciarCicloPastoreo/);
  assert.match(apiSource, /export function finalizarCicloPastoreo/);
  assert.match(apiSource, /export function cancelarCicloPastoreo/);
});

// ---------------------------------------------------------------------
// Cancelar exige un motivo no vacío ANTES de llamar al backend -- nunca
// un DELETE, nunca cancela sin motivo.
// ---------------------------------------------------------------------

test('cancelar exige un motivo no vacío antes de tocar el backend', () => {
  const bloque = panelSource.match(/async function handleConfirmarCancelar\(\)[\s\S]*?\n  \}/)?.[0] ?? '';
  assert.notEqual(bloque, '');
  assert.match(bloque, /motivoCancelacion\.trim\(\) === ''/);
});

test('el panel nunca invoca un DELETE ni una ruta destructiva -- solo iniciar/finalizar/cancelar (POST) y lecturas (GET)', () => {
  assert.doesNotMatch(panelSource, /DELETE|\.delete\(/i);
});

// ---------------------------------------------------------------------
// Finalizar: FASE A siempre exitosa (el ciclo queda FINALIZADO), FASE B
// (descanso) puede quedar GENERADO/PENDIENTE/ERROR_TECNICO -- ninguno de
// los tres es tratado como fallo de la operación completa.
// ---------------------------------------------------------------------

test('los tres estados de descanso post-real (GENERADO/PENDIENTE/ERROR_TECNICO) tienen mensajes propios, ninguno es un error fatal de la operación', () => {
  assert.match(panelSource, /GENERADO:/);
  assert.match(panelSource, /PENDIENTE:/);
  assert.match(panelSource, /ERROR_TECNICO:/);
  const bloqueFinalizar = panelSource.match(/async function handleFinalizar\(\)[\s\S]*?\n  \}/)?.[0] ?? '';
  assert.doesNotMatch(bloqueFinalizar, /throw/);
});

test('el botón "Finalizar pastoreo" y "Cancelar" quedan deshabilitados mutuamente mientras cualquiera de las dos acciones está en curso (evita doble submit)', () => {
  assert.match(panelSource, /disabled=\{finalizando \|\| cancelando\}/);
});

// ---------------------------------------------------------------------
// Errores semánticos del backend tienen copy propio -- nunca un mensaje
// técnico crudo (código HTTP/SQL) expuesto al productor.
// ---------------------------------------------------------------------

test('CICLO_ALREADY_IN_PROGRESS, CICLO_CANCELADO, CICLO_NOT_IN_PROGRESS e INVALID_MOTIVO_CANCELACION tienen mensajes explícitos propios', () => {
  assert.match(panelSource, /CICLO_ALREADY_IN_PROGRESS/);
  assert.match(panelSource, /CICLO_CANCELADO/);
  assert.match(panelSource, /CICLO_NOT_IN_PROGRESS/);
  assert.match(panelSource, /INVALID_MOTIVO_CANCELACION/);
});

// ---------------------------------------------------------------------
// SPRINT-3D9.1 PRE-COMMIT FIX: "Ajustar lote" -- acción secundaria
// discreta al iniciar, PLANIFICADO != EJECUTADO REAL. Nunca un formulario
// obligatorio -- la acción principal de un clic se mantiene intacta.
// ---------------------------------------------------------------------

test('1. modo default: handleIniciar llama iniciarCicloPastoreo SIN ajuste (misma llamada de un clic de siempre)', () => {
  const bloque = panelSource.match(/async function handleIniciar\(\)[\s\S]*?\n  \}/)?.[0] ?? '';
  assert.notEqual(bloque, '');
  assert.match(bloque, /iniciarCicloPastoreo\(predioId, potreroId\)/);
});

test('2. "Ajustar lote" existe como acción secundaria y abre los controles (handleAbrirAjuste -> ajustando=true)', () => {
  assert.match(panelSource, /Ajustar lote/);
  const bloque = panelSource.match(/function handleAbrirAjuste\(\)[\s\S]*?\n  \}/)?.[0] ?? '';
  assert.notEqual(bloque, '');
  assert.match(bloque, /setAjustando\(true\)/);
});

test('"Ajustar lote" es una acción secundaria (gan-back-inline), nunca el botón principal', () => {
  const botonAjustar = panelSource.match(/<button[^>]*onClick=\{handleAbrirAjuste\}[^>]*>/)?.[0] ?? '';
  assert.match(botonAjustar, /gan-back-inline/);
});

test('los controles de ajuste (categoría/número/peso) solo se renderizan dentro del bloque `ajustando`, nunca visibles junto al botón simple', () => {
  const idxAjustando = panelSource.indexOf('{!ajustando ? (');
  const idxCategoria = panelSource.indexOf('label="Categoría"');
  const idxIniciarSimple = panelSource.indexOf("onClick={handleIniciar}");
  assert.ok(idxAjustando >= 0 && idxCategoria >= 0 && idxIniciarSimple >= 0);
  assert.ok(idxIniciarSimple > idxAjustando, 'el botón simple "Iniciar pastoreo" debe estar en la rama `then` de `!ajustando`');
  assert.ok(idxCategoria > idxAjustando, 'el FormField de categoría debe estar dentro de la rama `else` de `!ajustando`');
  assert.ok(idxCategoria > idxIniciarSimple, 'el bloque de ajuste debe aparecer DESPUÉS del botón simple en el código fuente (rama else)');
});

test('3. los tres campos de ajuste se precargan SIEMPRE desde `planLote` al abrir (nunca desde un ajuste previo)', () => {
  const bloque = panelSource.match(/function handleAbrirAjuste\(\)[\s\S]*?\n  \}/)?.[0] ?? '';
  assert.match(bloque, /planLote\?\.numeroAnimales/);
  assert.match(bloque, /planLote\?\.pesoPromedioKg/);
  assert.match(bloque, /planLote\?\.categoriaCodigo/);
});

test('4. confirmar con ajuste envía iniciarCicloPastoreo con los TRES campos editados (numeroAnimales, pesoPromedioKg, categoriaCodigo)', () => {
  const bloque = panelSource.match(/async function handleConfirmarIniciarConAjuste\(\)[\s\S]*?\n  \}/)?.[0] ?? '';
  assert.notEqual(bloque, '');
  assert.match(bloque, /iniciarCicloPastoreo\(predioId, potreroId, \{\s*numeroAnimales, pesoPromedioKg, categoriaCodigo: ajusteCategoriaCodigo,?\s*\}\)/);
});

test('5. el panel de ciclo real nunca llama a un endpoint de recomendación de pastoreo -- el ajuste NUNCA modifica el plan original', () => {
  assert.doesNotMatch(apiCode, /recomendacion-pastoreo|recomendaciones-pastoreo|createRecomendacionPastoreo|previewRecomendacionPastoreo/);
});

test('6. la validación client-side corre ANTES de la llamada de red y bloquea el request si es inválida', () => {
  const bloque = panelSource.match(/async function handleConfirmarIniciarConAjuste\(\)[\s\S]*?\n  \}/)?.[0] ?? '';
  const idxValidate = bloque.indexOf('validateAjusteLote(');
  const idxReturn = bloque.indexOf('if (codigoInvalido)');
  const idxFetch = bloque.indexOf('iniciarCicloPastoreo(');
  assert.ok(idxValidate >= 0 && idxReturn >= 0 && idxFetch >= 0);
  assert.ok(idxValidate < idxFetch, 'la validación debe ejecutarse antes de la llamada de red');
  assert.ok(idxReturn < idxFetch, 'el early return por validación inválida debe preceder a la llamada de red');
});

test('6b. validateAjusteLote espeja los rangos del backend: numeroAnimales entero 1-100000, pesoPromedioKg >0 y <=2000, categoriaCodigo debe existir en `categorias`', () => {
  const bloque = panelSource.match(/function validateAjusteLote\([\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(bloque, /Number\.isInteger\(numeroAnimales\)/);
  assert.match(bloque, /numeroAnimales < 1 \|\| numeroAnimales > 100000/);
  assert.match(bloque, /pesoPromedioKg <= 0 \|\| pesoPromedioKg > 2000/);
  assert.match(bloque, /categorias \|\| \[\]\)\.some\(\(c\) => c\.codigo === categoriaCodigo\)/);
});

test('7. cancelar el ajuste (handleCancelarAjuste) vuelve al modo simple SIN llamar a la red', () => {
  const bloque = panelSource.match(/function handleCancelarAjuste\(\)[\s\S]*?\n  \}/)?.[0] ?? '';
  assert.notEqual(bloque, '');
  assert.match(bloque, /setAjustando\(false\)/);
  assert.doesNotMatch(bloque, /iniciarCicloPastoreo|fetch\(/);
});

test('8. handleConfirmarIniciarConAjuste corta temprano si ya hay una request en curso (evita doble submit) y el botón queda disabled={iniciando}', () => {
  const bloque = panelSource.match(/async function handleConfirmarIniciarConAjuste\(\)[\s\S]*?\n  \}/)?.[0] ?? '';
  assert.match(bloque, /if \(iniciando\) return;/);
  const botonConfirmar = panelSource.match(/<button[^>]*onClick=\{handleConfirmarIniciarConAjuste\}[^>]*>/)?.[0] ?? '';
  assert.match(botonConfirmar, /disabled=\{iniciando\}/);
});

test('9. tras un éxito con ajuste, se limpia el estado temporal de edición (ajustando vuelve a false); tras un error se conservan los valores para corregir', () => {
  const bloque = panelSource.match(/async function handleConfirmarIniciarConAjuste\(\)[\s\S]*?\n  \}/)?.[0] ?? '';
  const idxErrorReturn = bloque.indexOf("setAjusteError(resolveErrorMessage(data?.error));\n      return;");
  const idxSetAjustandoFalse = bloque.indexOf('setAjustando(false);');
  assert.ok(idxErrorReturn >= 0 && idxSetAjustandoFalse >= 0);
  assert.ok(idxSetAjustandoFalse > idxErrorReturn, 'setAjustando(false) debe ocurrir DESPUÉS del camino de error (solo en éxito), nunca antes');
  assert.doesNotMatch(bloque.slice(0, idxErrorReturn), /setAjuste(NumeroAnimales|PesoPromedioKg|CategoriaCodigo)\(''\)/, 'un error nunca debe limpiar los campos ingresados');
});

test('10. el bloque de ajuste no agrega ningún input de fecha -- solo categoría/número/peso', () => {
  const bloqueAjuste = panelSource.match(/\{ajustando \?[\s\S]*?<\/div>\s*\)\}/)?.[0]
    ?? panelSource.match(/label="Categoría"[\s\S]*?Cancelar ajuste/)?.[0] ?? '';
  assert.notEqual(bloqueAjuste, '');
  assert.doesNotMatch(bloqueAjuste, /type="date"/);
  assert.doesNotMatch(bloqueAjuste, /[Ff]echa/);
});

test('re-iniciar otro ciclo arranca siempre del plan vigente: handleAbrirAjuste calcula sus tres valores EXCLUSIVAMENTE desde `planLote`, nunca mezclando/reusando el estado de ajuste anterior', () => {
  const bloque = panelSource.match(/function handleAbrirAjuste\(\)[\s\S]*?\n  \}/)?.[0] ?? '';
  assert.notEqual(bloque, '');
  // Ninguna de las tres asignaciones lee la variable de estado que ella
  // misma actualiza (nada de `setAjusteX(ajusteX ...)`) -- el único insumo
  // es `planLote`.
  assert.doesNotMatch(bloque, /setAjusteNumeroAnimales\([^)]*ajusteNumeroAnimales/);
  assert.doesNotMatch(bloque, /setAjustePesoPromedioKg\([^)]*ajustePesoPromedioKg/);
  assert.doesNotMatch(bloque, /setAjusteCategoriaCodigo\([^)]*ajusteCategoriaCodigo/);
});

// ---------------------------------------------------------------------
// SPRINT-3D9.2: reentry guard visible -- el backend es la autoridad
// (ya cubierto en el repositorio), el panel solo REFLEJA el estado
// operativo derivado, nunca decide por su cuenta.
// ---------------------------------------------------------------------

test('el panel consulta getEstadoOperativoPotrero junto con getCicloActual en la misma carga', () => {
  assert.match(apiSource, /export function getEstadoOperativoPotrero/);
  const bloque = panelSource.match(/function loadActual\(\)[\s\S]*?\n  \}/)?.[0] ?? '';
  assert.match(bloque, /getEstadoOperativoPotrero\(predioId, potreroId\)/);
});

test('"Iniciar pastoreo" (modo simple) solo se renderiza cuando el estado NO es ARCHIVADO/EN_DESCANSO/EVALUACION_REINGRESO', () => {
  assert.match(panelSource, /!actual && !bloqueadoPorArchivo && !enDescanso && !enEvaluacion/);
});

test('en EN_DESCANSO/EVALUACION_REINGRESO se muestra la ventana completa (mínima/recomendada/máxima), nunca solo una fecha suelta', () => {
  assert.match(panelSource, /Ventana mínima de reingreso/);
  assert.match(panelSource, /Ventana recomendada/);
  assert.match(panelSource, /Ventana máxima/);
});

test('evaluar reingreso: NUNCA se decide automáticamente -- requiere un aforo con fecha posterior a fecha_reingreso_min, verificado en el cliente antes de ofrecer los botones', () => {
  const bloque = panelSource.match(/\{!actual && enEvaluacion \? \([\s\S]*?\n      \) : null\}/)?.[0] ?? '';
  assert.notEqual(bloque, '');
  assert.match(bloque, /fichaEvaluacion\.fechaAforo >= ventana\.fechaReingresoMin/);
  assert.match(bloque, /Registra un aforo nuevo/);
});

test('evaluar reingreso: NO_APTO exige observación (confirmación en dos pasos), APTO no la exige', () => {
  const bloque = panelSource.match(/async function handleEvaluar\(resultado\)[\s\S]*?\n  \}/)?.[0] ?? '';
  assert.match(bloque, /mostrarObservacionNoApto/);
  assert.match(bloque, /INVALID_OBSERVACION_EVALUACION/);
});

// ---------------------------------------------------------------------
// SPRINT-3D9.2: historial -- Anular/Corregir, nunca eliminación
// definitiva de historia.
// ---------------------------------------------------------------------

test('historial: "Anular registro" está disponible para FINALIZADO/CANCELADO, nunca para ANULADO (ya terminal)', () => {
  assert.match(panelSource, /ciclo\.estado !== 'ANULADO' && accionCicloId !== ciclo\.cicloId/);
  assert.match(panelSource, /Anular registro/);
});

test('historial: "Corregir información" solo se ofrece sobre ciclos FINALIZADO', () => {
  const bloque = panelSource.match(/\{ciclo\.estado === 'FINALIZADO' \? \([\s\S]*?\) : null\}/)?.[0] ?? '';
  assert.match(bloque, /Corregir información/);
});

test('anular exige motivo -- el botón de confirmación llama anularCicloPastoreo con el motivo escrito', () => {
  assert.match(apiSource, /export function anularCicloPastoreo/);
  const bloque = panelSource.match(/async function handleConfirmarAnular\(\)[\s\S]*?\n  \}/)?.[0] ?? '';
  assert.match(bloque, /INVALID_MOTIVO_ANULACION/);
  assert.match(bloque, /anularCicloPastoreo\(predioId, potreroId, accionCicloId, motivoAccion\.trim\(\)\)/);
});

test('corregir exige motivo Y al menos un cambio -- nunca envía un objeto de cambios vacío', () => {
  const bloque = panelSource.match(/async function handleConfirmarCorregir\(\)[\s\S]*?\n  \}/)?.[0] ?? '';
  assert.match(bloque, /INVALID_MOTIVO_CORRECCION/);
  assert.match(bloque, /SIN_CAMBIOS_SOLICITADOS/);
  assert.match(bloque, /Object\.keys\(cambios\)\.length === 0/);
});

test('corregir precarga los valores ACTUALES del ciclo -- el usuario solo edita lo que estaba mal, nunca reescribe todo a ciegas', () => {
  const bloque = panelSource.match(/function handleAbrirCorregir\(ciclo\)[\s\S]*?\n  \}/)?.[0] ?? '';
  assert.match(bloque, /fechaIngresoReal: ciclo\.fechaIngresoReal/);
  assert.match(bloque, /fechaSalidaReal: ciclo\.fechaSalidaReal/);
  assert.match(bloque, /numeroAnimales: String\(ciclo\.numeroAnimalesReal/);
  assert.match(bloque, /pesoPromedioKg: String\(ciclo\.pesoPromedioRealKg/);
});

test('el panel nunca muestra "Eliminar" como acción sobre historia operacional -- solo Anular/Corregir/Cancelar', () => {
  assert.doesNotMatch(panelSource, />\s*Eliminar\s*</i);
});
