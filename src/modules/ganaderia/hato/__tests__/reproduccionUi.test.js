// FASE 4B: UI de reproducción en la ficha (pestaña "Reproducción") y
// etiquetas reproductivas del timeline. Modelo puro + invariantes por
// fuente (no hay jsdom en el repo), como el resto de pruebas de hato/.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ACCIONES_OPERACION,
  CAMPOS_POR_TIPO,
  ETIQUETAS_ESTADO_REPRODUCTIVO,
  ETIQUETAS_TIPO_EVENTO,
  MENSAJES_ERROR_REPRODUCCION,
  MENSAJE_INCIERTO,
  MENSAJE_REPRODUCCION_OFFLINE,
  TEXTO_SIN_EVENTOS,
  TIPOS_EVENTO_REPRODUCTIVO,
  accionesReproduccion,
  buildAnularBody,
  buildCorregirBody,
  buildCrearBody,
  buildEventoBody,
  camposDelFormulario,
  cambiarTipoForm,
  crearControlOperacion,
  crearOperacionesReproduccion,
  detalleEvento,
  estadoCarga,
  fechaHoraEvento,
  firmaOperacion,
  formDesdeEvento,
  formInicialEvento,
  necesitaToros,
  ordenarHistorial,
  referenciaToro,
  relacionCorreccion,
  resultadoOperacion,
  resumenEstado,
  torosDesdeListado,
  validarEvento,
  validarMotivo,
} from '../reproduccionModel.js';
import { esEventoAnulado, etiquetaTipoEvento } from '../actividadModel.js';
import { capacidadesDe } from '../../auth/ganaderiaPermisos.js';
import { MENSAJE_SIN_CONEXION, MENSAJE_SIN_PERMISOS } from '../../api/errorModel.js';
import { TIPOS_EVENTO_REPRODUCTIVO as TIPOS_SERVIDOR, validateEventoReproductivo } from '../../../../../server/services/ganaderia/reproduccionValidation.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HATO_DIR = path.resolve(__dirname, '..');
const GANADERIA_DIR = path.resolve(HATO_DIR, '..');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
const leer = (...p) => strip(fs.readFileSync(path.join(...p), 'utf8').replace(/\r\n/g, '\n'));
const panel = leer(HATO_DIR, 'HatoReproduccionPanel.jsx');
const detalle = leer(HATO_DIR, 'HatoDetallePage.jsx');
const actividadPanel = leer(HATO_DIR, 'HatoActividadPanel.jsx');
const api = fs.readFileSync(path.join(HATO_DIR, 'hatoApi.js'), 'utf8').replace(/\r\n/g, '\n');
const css = fs.readFileSync(path.join(GANADERIA_DIR, 'styles', 'ganaderia-hato.css'), 'utf8').replace(/\r\n/g, '\n');

const HOY = '2026-11-02';
const HEMBRA = Object.freeze({ animalId: '1', sexo: 'HEMBRA', estado: 'ACTIVO', estadoOperativo: 'EN_HATO' });
const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';
const UUID_C = '33333333-3333-4333-8333-333333333333';
const CORRELATION = 'abcdef12-3456-4789-8abc-def012345678';

function form(tipo, campos = {}) {
  return { ...formInicialEvento(tipo, '2026-10-01'), ...campos };
}

// Lo que el servidor aceptaría: el body construido pasa la validación real 4A.
function aceptaServidor(body) {
  return validateEventoReproductivo(body, { hoy: HOY, horaAhora: '23:59' });
}

const SIN_ESTADO = Object.freeze({
  estado: 'SIN_ESTADO', desde: null, eventoEstado: null, ultimoEvento: null, ultimoServicio: null,
  ultimoDiagnostico: null, ultimoParto: null, gestacion: null, eventosActivos: 0,
});

// ---------------------------------------------------------------------------
// Estado reproductivo
// ---------------------------------------------------------------------------

test('render SIN_ESTADO: etiqueta, sin gestación y "Sin registro" en servicio/diagnóstico/parto', () => {
  const r = resumenEstado(SIN_ESTADO);
  assert.equal(r.estado, 'SIN_ESTADO');
  assert.equal(r.etiqueta, 'Sin estado');
  assert.equal(r.gestacion, null);
  assert.deepEqual(r.filas, [['Último servicio', 'Sin registro'], ['Último diagnóstico', 'Sin registro'], ['Último parto', 'Sin registro']]);
});

test('los 7 estados visuales tienen etiqueta propia y clase de color', () => {
  assert.deepEqual(Object.keys(ETIQUETAS_ESTADO_REPRODUCTIVO), ['SIN_ESTADO', 'CICLANDO', 'SERVIDA', 'PRENADA', 'VACIA', 'POSPARTO', 'NO_APLICA']);
  for (const estado of Object.keys(ETIQUETAS_ESTADO_REPRODUCTIVO)) {
    assert.equal(resumenEstado({ ...SIN_ESTADO, estado }).etiqueta, ETIQUETAS_ESTADO_REPRODUCTIVO[estado]);
    assert.match(css, new RegExp(`\\.gan-repro-badge-${estado.toLowerCase()}`), estado);
  }
  // Un estado desconocido nunca se muestra crudo.
  assert.equal(resumenEstado({ estado: 'RARO' }).etiqueta, 'Sin estado');
  // NO_APLICA (macho): solo la etiqueta y una nota, sin filas.
  const macho = resumenEstado({ ...SIN_ESTADO, estado: 'NO_APLICA' });
  assert.deepEqual(macho.filas, []);
  assert.match(macho.descripcion, /hembras/);
});

test('PRENADA con gestación: muestra los valores DEL SERVIDOR sin recalcular', () => {
  const estado = {
    ...SIN_ESTADO,
    estado: 'PRENADA',
    desde: '2026-09-10',
    ultimoServicio: { eventoId: '5', tipoEvento: 'INSEMINACION_ARTIFICIAL', fechaEvento: '2026-08-01' },
    ultimoDiagnostico: { eventoId: '6', tipoEvento: 'DIAGNOSTICO_PRENEZ', fechaEvento: '2026-09-10', resultado: 'PRENADA', diasGestacion: 40 },
    // Valores deliberadamente "no derivables" para probar que no se recalculan.
    gestacion: { base: 'DIAGNOSTICO', fechaConcepcionEstimada: '2026-08-01', diasEstimados: 93, fechaProbableParto: '2027-05-11' },
  };
  const r = resumenEstado(estado);
  assert.equal(r.etiqueta, 'Preñada');
  assert.equal(r.desde, '10/09/2026');
  assert.deepEqual(r.filas[0], ['Último servicio', 'Inseminación artificial · 01/08/2026']);
  assert.deepEqual(r.filas[1], ['Último diagnóstico', 'Preñada · 10/09/2026 · 40 días']);
  assert.deepEqual(r.gestacion, [
    ['Gestación estimada', '93 días'],
    ['Concepción estimada', '01/08/2026'],
    ['Fecha probable de parto', '11/05/2027'],
    ['Calculada desde', 'Días del diagnóstico'],
  ]);
  // Sin gestación del servidor -> no se inventa.
  assert.equal(resumenEstado({ ...estado, gestacion: null }).gestacion, null);
  // Fuera de PRENADA nunca se muestra gestación.
  assert.equal(resumenEstado({ ...estado, estado: 'VACIA' }).gestacion, null);
  assert.doesNotMatch(panel, /283|sumarDias|diasEntre/);
});

test('último parto con número de crías', () => {
  const r = resumenEstado({ ...SIN_ESTADO, estado: 'POSPARTO', ultimoParto: { eventoId: '9', tipoEvento: 'PARTO', fechaEvento: '2026-10-20', numeroCrias: 2 } });
  assert.deepEqual(r.filas[2], ['Último parto', '20/10/2026 · 2 crías']);
});

// ---------------------------------------------------------------------------
// Historial
// ---------------------------------------------------------------------------

test('historial vacío: estado ok sin eventos y texto propio', () => {
  const r = estadoCarga({ ok: true, status: 200, data: { ok: true, animalId: '1', sexo: 'HEMBRA', estado: SIN_ESTADO, orden: 'ASCENDENTE', eventos: [] } });
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.eventos, []);
  assert.equal(TEXTO_SIN_EVENTOS, 'No hay eventos reproductivos registrados.');
  assert.match(panel, /TEXTO_SIN_EVENTOS/);
});

const ORIGINAL = Object.freeze({
  eventoId: '10', animalId: '1', tipoEvento: 'INSEMINACION_ARTIFICIAL', fechaEvento: '2026-09-01', horaEvento: '07:30',
  observaciones: 'Celo de la mañana', detalle: { toroAnimalId: '44', semenCodigo: 'PJ-1', tecnico: 'Ana' },
  estadoRegistro: 'ANULADO', corrigeEventoId: null, corregidoPorEventoId: '11',
  anulacion: { anuladoEn: '2026-09-02T10:00:00.000000Z', motivo: 'Toro equivocado' }, registradoEn: '2026-09-01T12:00:00.000000Z',
});
const CORRECTOR = Object.freeze({
  ...ORIGINAL, eventoId: '11', detalle: { toroExterno: 'Brahman 123', semenCodigo: 'PJ-1', tecnico: 'Ana' },
  estadoRegistro: 'ACTIVO', corrigeEventoId: '10', corregidoPorEventoId: null, anulacion: null,
});

test('historial con ACTIVO + ANULADO: ambos visibles, orden cronológico y relación de corrección', () => {
  const r = estadoCarga({ ok: true, data: { sexo: 'HEMBRA', estado: SIN_ESTADO, eventos: [CORRECTOR, ORIGINAL] } });
  assert.deepEqual(r.eventos.map((e) => e.eventoId), ['10', '11']);
  assert.deepEqual(relacionCorreccion(ORIGINAL), { corrige: null, corregidoPor: 'Corregido por el evento #11' });
  assert.deepEqual(relacionCorreccion(CORRECTOR), { corrige: 'Corrige el evento #10', corregidoPor: null });
  assert.equal(fechaHoraEvento(ORIGINAL), '01/09/2026 · 07:30');
  assert.equal(fechaHoraEvento({ fechaEvento: '2026-09-01', horaEvento: null }), '01/09/2026');
  // Los ANULADO se marcan, nunca se filtran.
  assert.match(panel, /anulado \? 'Anulado' : 'Activo'/);
  assert.match(panel, /is-anulado/);
  assert.match(panel, /Motivo de anulación/);
  assert.doesNotMatch(panel, /eventos\.filter\(/);
  // Un ANULADO no ofrece acciones administrativas.
  assert.match(panel, /administrar && !anulado/);
});

test('orden cronológico estable: fecha y luego id', () => {
  const lista = ordenarHistorial([
    { eventoId: '3', fechaEvento: '2026-05-01' }, { eventoId: '1', fechaEvento: '2026-06-01' }, { eventoId: '2', fechaEvento: '2026-05-01' },
  ]);
  assert.deepEqual(lista.map((e) => e.eventoId), ['2', '3', '1']);
});

// ---------------------------------------------------------------------------
// Detalle por tipo y toro
// ---------------------------------------------------------------------------

test('toro: referencia legible con UNA consulta (listado de machos), fallback "Animal #id", toro externo como texto', () => {
  const toros = torosDesdeListado({
    ok: true,
    data: { animales: [
      { animalId: '44', sexo: 'MACHO', estado: 'ACTIVO', numeroVisual: 'T-44', nombre: 'Sultán' },
      { animalId: '45', sexo: 'MACHO', estado: 'ANULADO', numeroVisual: 'T-45' },
      { animalId: '46', sexo: 'HEMBRA', estado: 'ACTIVO', numeroVisual: 'H-46' },
    ] },
  }, (a) => (a.nombre ? `${a.numeroVisual} · ${a.nombre}` : a.numeroVisual));
  assert.equal(toros.mapa.get('44'), 'T-44 · Sultán');
  assert.equal(toros.mapa.get('45'), 'T-45');
  assert.equal(toros.mapa.has('46'), false);
  assert.deepEqual(toros.opciones, [{ value: '44', label: 'T-44 · Sultán' }]);
  assert.equal(referenciaToro('44', toros.mapa), 'T-44 · Sultán');
  assert.equal(referenciaToro('99', toros.mapa), 'Animal #99');
  assert.deepEqual(detalleEvento(ORIGINAL, { toros: toros.mapa })[0], ['Toro del hato', 'T-44 · Sultán']);
  assert.deepEqual(detalleEvento(CORRECTOR)[0], ['Toro / pajilla externa', 'Brahman 123']);
  // Solo se pide el listado si hace falta; nunca por fila.
  assert.equal(necesitaToros([CORRECTOR]), false);
  assert.equal(necesitaToros([ORIGINAL]), true);
  assert.equal(necesitaToros([], 'IATF'), true);
  assert.equal(necesitaToros([], 'PARTO'), false);
  assert.equal((panel.match(/listAnimales\(/g) ?? []).length, 1);
  assert.match(panel, /sexo: 'MACHO'/);
  assert.match(panel, /torosRef\.current/);
});

test('detalle de cada tipo en texto (nunca códigos crudos)', () => {
  const casos = [
    [{ tipoEvento: 'CELO_OBSERVADO', detalle: { intensidadCelo: 'ALTA', metodoDeteccion: 'PARCHE_DETECTOR' } },
      [['Intensidad', 'Alta'], ['Método de detección', 'Parche detector']]],
    [{ tipoEvento: 'SERVICIO_MONTA', detalle: { tipoServicio: 'LIBRE', toroExterno: 'Vecino' } },
      [['Tipo de servicio', 'Libre'], ['Toro externo', 'Vecino']]],
    [{ tipoEvento: 'IATF', detalle: { protocoloIatf: 'J-Synch', semenCodigo: 'S1', tecnico: 'Luis' } },
      [['Protocolo IATF', 'J-Synch'], ['Código de semen', 'S1'], ['Técnico', 'Luis']]],
    [{ tipoEvento: 'TRANSFERENCIA_EMBRION', detalle: {
      embrionCodigo: 'E-77', embrionRaza: 'Gyr x Holstein', embrionDonadora: 'D-12', toroExterno: 'Padre X',
      embrionEstadio: 'Blastocisto', embrionCalidad: 'Grado 1', embrionConservacion: 'CONGELADO', tecnico: 'Vet',
    } }, [
      ['Código del embrión', 'E-77'], ['Raza / cruce', 'Gyr x Holstein'], ['Donadora', 'D-12'], ['Genética / padre', 'Padre X'],
      ['Estadio', 'Blastocisto'], ['Calidad', 'Grado 1'], ['Conservación', 'Congelado'], ['Técnico', 'Vet'],
    ]],
    [{ tipoEvento: 'DIAGNOSTICO_PRENEZ', detalle: { diagnosticoResultado: 'PRENADA', diagnosticoMetodo: 'ECOGRAFIA', diasGestacion: 45 } },
      [['Resultado', 'Preñada'], ['Método', 'Ecografía'], ['Días de gestación', '45']]],
    [{ tipoEvento: 'ABORTO', detalle: { diasGestacion: 120, abortoCausa: 'Trauma' } }, [['Días de gestación', '120'], ['Causa', 'Trauma']]],
    [{ tipoEvento: 'PARTO', detalle: { partoTipo: 'ASISTIDO', numeroCrias: 2 } }, [['Tipo de parto', 'Asistido'], ['Número de crías', '2']]],
  ];
  for (const [evento, esperado] of casos) assert.deepEqual(detalleEvento(evento), esperado, evento.tipoEvento);
});

// ---------------------------------------------------------------------------
// Formularios por tipo (contrato 4A exacto)
// ---------------------------------------------------------------------------

test('tipos y campos por tipo idénticos al contrato 4A', () => {
  assert.deepEqual([...TIPOS_EVENTO_REPRODUCTIVO], [...TIPOS_SERVIDOR]);
  assert.deepEqual(Object.keys(ETIQUETAS_TIPO_EVENTO), [...TIPOS_SERVIDOR]);
  // Cada campo del formulario es aceptado por el servidor para su tipo
  // (un campo ajeno -> 400 FORBIDDEN_FIELDS).
  for (const tipo of TIPOS_SERVIDOR) {
    for (const campo of CAMPOS_POR_TIPO[tipo]) {
      const valor = campo === 'toroAnimalId' ? '44' : campo === 'diasGestacion' ? 30 : campo === 'numeroCrias' ? 1 : null;
      const body = { tipoEvento: tipo, fechaEvento: '2026-10-01', [campo]: valor ?? undefined };
      if (tipo === 'SERVICIO_MONTA') body.tipoServicio = 'LIBRE';
      if (tipo === 'TRANSFERENCIA_EMBRION') body.embrionConservacion = 'FRESCO';
      if (tipo === 'DIAGNOSTICO_PRENEZ') Object.assign(body, { diagnosticoResultado: 'PRENADA', diagnosticoMetodo: 'PALPACION' });
      if (tipo === 'PARTO') Object.assign(body, { partoTipo: 'NORMAL', numeroCrias: 1 });
      assert.doesNotThrow(() => aceptaServidor(body), `${tipo}.${campo}`);
    }
  }
});

test('CELO: body solo con lo informado (sin campos vacíos) y aceptado por el servidor', () => {
  const body = buildEventoBody(form('CELO_OBSERVADO', { intensidadCelo: 'MEDIA' }));
  assert.deepEqual(body, { tipoEvento: 'CELO_OBSERVADO', fechaEvento: '2026-10-01', intensidadCelo: 'MEDIA' });
  assert.doesNotThrow(() => aceptaServidor(body));
  assert.deepEqual(validarEvento(form('CELO_OBSERVADO'), { hoy: HOY }), {});
});

test('IA: toro del hato (id) + semen + técnico; vacíos omitidos', () => {
  const body = buildEventoBody(form('INSEMINACION_ARTIFICIAL', { toroAnimalId: '44', semenCodigo: ' PJ-9 ', tecnico: '', horaEvento: '06:15' }));
  assert.deepEqual(body, { tipoEvento: 'INSEMINACION_ARTIFICIAL', fechaEvento: '2026-10-01', horaEvento: '06:15', toroAnimalId: '44', semenCodigo: 'PJ-9' });
  assert.doesNotThrow(() => aceptaServidor(body));
});

test('IATF: protocolo y toro externo', () => {
  const body = buildEventoBody(form('IATF', { protocoloIatf: 'Ovsynch', toroExterno: 'Angus 55' }));
  assert.deepEqual(body, { tipoEvento: 'IATF', fechaEvento: '2026-10-01', protocoloIatf: 'Ovsynch', toroExterno: 'Angus 55' });
  assert.doesNotThrow(() => aceptaServidor(body));
});

test('TE: todos los campos del embrión + FRESCO/CONGELADO obligatorio', () => {
  const datos = {
    embrionCodigo: 'E-1', embrionRaza: 'Gyr', embrionDonadora: 'D-3', toroExterno: 'Padre Z',
    embrionEstadio: 'Mórula', embrionCalidad: 'Grado 2', embrionConservacion: 'CONGELADO', tecnico: 'Vet',
  };
  const body = buildEventoBody(form('TRANSFERENCIA_EMBRION', datos));
  assert.deepEqual(body, { tipoEvento: 'TRANSFERENCIA_EMBRION', fechaEvento: '2026-10-01', ...datos });
  assert.doesNotThrow(() => aceptaServidor(body));
  assert.deepEqual(validarEvento(form('TRANSFERENCIA_EMBRION'), { hoy: HOY }), { embrionConservacion: 'Este dato es obligatorio.' });
  assert.equal(CAMPOS_POR_TIPO.TRANSFERENCIA_EMBRION.includes('toroAnimalId'), false);
});

test('diagnóstico: resultado y método obligatorios; días de gestación solo con PRENADA', () => {
  assert.deepEqual(Object.keys(validarEvento(form('DIAGNOSTICO_PRENEZ'), { hoy: HOY })).sort(), ['diagnosticoMetodo', 'diagnosticoResultado']);
  const prenada = form('DIAGNOSTICO_PRENEZ', { diagnosticoResultado: 'PRENADA', diagnosticoMetodo: 'PALPACION', diasGestacion: '60' });
  assert.deepEqual(buildEventoBody(prenada), { tipoEvento: 'DIAGNOSTICO_PRENEZ', fechaEvento: '2026-10-01', diagnosticoResultado: 'PRENADA', diagnosticoMetodo: 'PALPACION', diasGestacion: 60 });
  assert.doesNotThrow(() => aceptaServidor(buildEventoBody(prenada)));
  // VACIA: el campo días desaparece del formulario y nunca se envía (400 en el servidor).
  const vacia = { ...prenada, diagnosticoResultado: 'VACIA' };
  assert.equal(camposDelFormulario(vacia).includes('diasGestacion'), false);
  assert.equal('diasGestacion' in buildEventoBody(vacia), false);
  assert.doesNotThrow(() => aceptaServidor(buildEventoBody(vacia)));
  assert.match(validarEvento({ ...prenada, diasGestacion: '301' }, { hoy: HOY }).diasGestacion, /entre 1 y 300/);
});

test('aborto: días y causa opcionales', () => {
  const body = buildEventoBody(form('ABORTO', { diasGestacion: '120', abortoCausa: 'Desconocida' }));
  assert.deepEqual(body, { tipoEvento: 'ABORTO', fechaEvento: '2026-10-01', diasGestacion: 120, abortoCausa: 'Desconocida' });
  assert.doesNotThrow(() => aceptaServidor(body));
  assert.deepEqual(buildEventoBody(form('ABORTO')), { tipoEvento: 'ABORTO', fechaEvento: '2026-10-01' });
});

test('parto: tipo obligatorio y crías (1 por defecto, 1-4)', () => {
  const f = form('PARTO', { partoTipo: 'NORMAL' });
  assert.equal(f.numeroCrias, '1');
  assert.deepEqual(buildEventoBody(f), { tipoEvento: 'PARTO', fechaEvento: '2026-10-01', partoTipo: 'NORMAL', numeroCrias: 1 });
  assert.doesNotThrow(() => aceptaServidor(buildEventoBody(f)));
  assert.match(validarEvento({ ...f, numeroCrias: '5' }, { hoy: HOY }).numeroCrias, /entre 1 y 4/);
  assert.equal(validarEvento({ ...f, partoTipo: '' }, { hoy: HOY }).partoTipo, 'Este dato es obligatorio.');
});

test('validación común: tipo, fecha obligatoria y no futura, hora HH:MM, observaciones ≤ 500', () => {
  assert.deepEqual(validarEvento(formInicialEvento(''), { hoy: HOY }), { tipoEvento: 'Selecciona el tipo de evento.' });
  assert.equal(validarEvento(form('CELO_OBSERVADO', { fechaEvento: '' }), { hoy: HOY }).fechaEvento, 'Indica la fecha del evento.');
  assert.equal(validarEvento(form('CELO_OBSERVADO', { fechaEvento: '2026-11-03' }), { hoy: HOY }).fechaEvento, 'La fecha no puede ser futura.');
  assert.equal(validarEvento(form('CELO_OBSERVADO', { horaEvento: '25:00' }), { hoy: HOY }).horaEvento, 'Usa el formato HH:MM.');
  assert.match(validarEvento(form('CELO_OBSERVADO', { observaciones: 'x'.repeat(501) }), { hoy: HOY }).observaciones, /500/);
  assert.equal(buildEventoBody(form('CELO_OBSERVADO', { observaciones: '  nota  ' })).observaciones, 'nota');
});

test('cambiar de tipo limpia los campos del tipo anterior (nunca FORBIDDEN_FIELDS)', () => {
  const f = cambiarTipoForm(form('IATF', { protocoloIatf: 'X', semenCodigo: 'S', observaciones: 'o', horaEvento: '08:00' }), 'PARTO');
  assert.equal(f.protocoloIatf, '');
  assert.equal(f.semenCodigo, '');
  assert.equal(f.observaciones, 'o');
  assert.equal(f.horaEvento, '08:00');
  assert.equal(f.fechaEvento, '2026-10-01');
  assert.deepEqual(Object.keys(buildEventoBody({ ...f, partoTipo: 'NORMAL' })).sort(), ['fechaEvento', 'horaEvento', 'numeroCrias', 'observaciones', 'partoTipo', 'tipoEvento']);
});

// ---------------------------------------------------------------------------
// RBAC
// ---------------------------------------------------------------------------

function accionesPara(rol, extra = {}) {
  const caps = capacidadesDe(rol);
  return accionesReproduccion({ animal: HEMBRA, puedeRegistrar: caps.registrarReproduccion, puedeAdministrar: caps.administrarReproduccion, online: true, ...extra });
}

test('lector: solo lectura (sin registrar, anular ni corregir)', () => {
  const a = accionesPara('lector');
  assert.equal(a.registrar, false);
  assert.equal(a.administrar, false);
  assert.equal(accionesPara(null).registrar, false);
});

test('operador: registra, pero no ve anular/corregir', () => {
  const a = accionesPara('operador');
  assert.equal(a.registrar, true);
  assert.equal(a.administrar, false);
});

test('owner/admin: registrar, anular y corregir', () => {
  for (const rol of ['owner', 'admin']) {
    const a = accionesPara(rol);
    assert.equal(a.registrar, true, rol);
    assert.equal(a.administrar, true, rol);
  }
});

test('reglas del animal: macho, anulado o cerrado no registran; cerrado sí admite anular/corregir', () => {
  assert.equal(accionesPara('owner', { sexo: 'MACHO', animal: { ...HEMBRA, sexo: 'MACHO' } }).registrar, false);
  assert.equal(accionesPara('owner', { sexo: 'MACHO', animal: { ...HEMBRA, sexo: 'MACHO' } }).administrar, false);
  assert.equal(accionesPara('owner', { animal: { ...HEMBRA, estado: 'ANULADO' } }).administrar, false);
  const salida = accionesPara('owner', { animal: { ...HEMBRA, estadoOperativo: 'SALIDO' } });
  assert.equal(salida.registrar, false);
  assert.equal(salida.administrar, true);
});

test('el panel decide la UI solo con la matriz central (sin roles literales) y gatea cada acción', () => {
  assert.match(panel, /permisos\.registrarReproduccion/);
  assert.match(panel, /permisos\.administrarReproduccion/);
  assert.doesNotMatch(panel, /'(owner|admin|operador|lector)'/);
  assert.match(panel, /acciones\.registrar && !formularioAbierto \?/);
  assert.match(panel, /administrar=\{acciones\.administrar\}/);
  assert.match(panel, /Anular evento/);
  assert.match(panel, />Corregir</);
});

// ---------------------------------------------------------------------------
// Idempotencia
// ---------------------------------------------------------------------------

test('clientOperationId: uno por operación; crear, anular y corregir nunca comparten', () => {
  const ids = [UUID_A, UUID_B, UUID_C];
  const generar = () => ids.shift();
  const crear = crearControlOperacion(generar);
  const anular = crearControlOperacion(generar);
  const corregir = crearControlOperacion(generar);
  const f = form('CELO_OBSERVADO');
  const idCrear = crear.revisar(firmaOperacion('crear', { form: f }));
  const idAnular = anular.revisar(firmaOperacion('anular', { eventoId: '10', motivo: 'm' }));
  const idCorregir = corregir.revisar(firmaOperacion('corregir', { eventoId: '10', form: f, motivo: 'm' }));
  assert.equal(new Set([idCrear, idAnular, idCorregir]).size, 3);
  assert.notEqual(firmaOperacion('anular', { eventoId: '10', motivo: 'm' }), firmaOperacion('corregir', { eventoId: '10', motivo: 'm' }));
  // El panel usa un control por acción (crearOperacionesReproduccion).
  assert.deepEqual([...ACCIONES_OPERACION], ['crear', 'anular', 'corregir']);
  assert.match(panel, /crearOperacionesReproduccion\(newClientOperationId\)/);
  const ops = crearOperacionesReproduccion((() => { let n = 0; return () => `id-${++n}`; })());
  const firma = firmaOperacion('anular', { eventoId: '10', motivo: 'm' });
  assert.notEqual(ops.idPara('anular', firma), ops.idPara('corregir', firma));
});

// ---------------------------------------------------------------------------
// Idempotencia tras resultado INCIERTO + cerrar/reabrir (revisión PR #105)
// ---------------------------------------------------------------------------

// Simula el panel con el controlador real: enviar = idPara + resultadoOperacion
// + resolver; cerrar/reabrir NO toca los ids (ver invariante de fuente abajo).
function simulador() {
  let n = 0;
  const ops = crearOperacionesReproduccion(() => `id-${++n}`);
  const posts = [];
  return {
    posts,
    enviar(accion, firma, respuesta) {
      const id = ops.idPara(accion, firma);
      posts.push({ accion, id });
      const resultado = resultadoOperacion(accion, respuesta);
      ops.resolver(accion, resultado);
      return { id, resultado };
    },
    cerrarYReabrir() {
      // cerrar() del panel: sin descartar (no hay llamada sobre `ops`).
    },
  };
}

const R500 = Object.freeze({ ok: false, status: 500, data: { error: 'Error interno del servidor', correlationId: CORRELATION }, correlationId: CORRELATION });
const RED = Object.freeze({ ok: false, status: 0, data: { error: 'NETWORK_ERROR' }, failure: 'NETWORK_ERROR' });
const okCon = (status = 201) => ({ ok: true, status, data: { evento: CORRECTOR, yaExistia: false } });

test('incierto 1 — crear: 500 o NETWORK_ERROR, cerrar y reabrir la misma intención reutiliza el id A', () => {
  for (const fallo of [R500, RED]) {
    const s = simulador();
    const firma = firmaOperacion('crear', { form: form('CELO_OBSERVADO', { intensidadCelo: 'ALTA' }) });
    const a = s.enviar('crear', firma, fallo);
    assert.equal(a.resultado.tipo, 'INCIERTO');
    assert.equal(a.resultado.descartarOperacion, false);
    s.cerrarYReabrir();
    // Reabre con formulario nuevo y vuelve a cargar los mismos datos.
    const reintento = s.enviar('crear', firmaOperacion('crear', { form: form('CELO_OBSERVADO', { intensidadCelo: 'ALTA' }) }), okCon());
    assert.equal(reintento.id, a.id);
    assert.equal(a.id, 'id-1');
  }
});

test('incierto 2 — crear: tras incierto, cambiar un dato genera un id nuevo (B)', () => {
  const s = simulador();
  const a = s.enviar('crear', firmaOperacion('crear', { form: form('CELO_OBSERVADO', { intensidadCelo: 'ALTA' }) }), R500);
  s.cerrarYReabrir();
  const b = s.enviar('crear', firmaOperacion('crear', { form: form('CELO_OBSERVADO', { intensidadCelo: 'MEDIA' }) }), okCon());
  assert.notEqual(b.id, a.id);
  assert.equal(b.id, 'id-2');
});

test('incierto 3 — anular: cerrar y reabrir el mismo evento con el mismo motivo reutiliza el id', () => {
  const s = simulador();
  const a = s.enviar('anular', firmaOperacion('anular', { eventoId: '10', motivo: 'Toro equivocado' }), RED);
  assert.equal(a.resultado.tipo, 'INCIERTO');
  s.cerrarYReabrir();
  // Espacios extra en el motivo: misma intención (se normaliza como en el body).
  const b = s.enviar('anular', firmaOperacion('anular', { eventoId: '10', motivo: ' Toro equivocado ' }), { ok: true, status: 200, data: { evento: ORIGINAL, yaExistia: true } });
  assert.equal(b.id, a.id);
  assert.equal(b.resultado.tipo, 'YA_EXISTIA');
  // Otro evento u otro motivo = otra intención.
  const c = s.enviar('anular', firmaOperacion('anular', { eventoId: '11', motivo: 'Toro equivocado' }), R500);
  assert.notEqual(c.id, a.id);
});

test('incierto 4 — corregir: cerrar y reabrir la misma corrección reutiliza el id', () => {
  const s = simulador();
  const corregido = { ...formDesdeEvento(ORIGINAL), toroAnimalId: '', toroExterno: 'Brahman 123' };
  const a = s.enviar('corregir', firmaOperacion('corregir', { eventoId: '10', form: corregido, motivo: 'toro' }), R500);
  s.cerrarYReabrir();
  // Reabre: formulario precargado del original y vuelve a aplicar el mismo cambio.
  const otraVez = { ...formDesdeEvento(ORIGINAL), toroAnimalId: '', toroExterno: 'Brahman 123' };
  const b = s.enviar('corregir', firmaOperacion('corregir', { eventoId: '10', form: otraVez, motivo: 'toro' }), okCon());
  assert.equal(b.id, a.id);
});

test('incierto 5 — éxito: la misma intención posterior obtiene un id nuevo', () => {
  for (const [accion, opciones] of [
    ['crear', { form: form('PARTO', { partoTipo: 'NORMAL' }) }],
    ['anular', { eventoId: '10', motivo: 'm' }],
    ['corregir', { eventoId: '10', form: form('PARTO', { partoTipo: 'NORMAL' }), motivo: 'm' }],
  ]) {
    const s = simulador();
    const firma = firmaOperacion(accion, opciones);
    const a = s.enviar(accion, firma, okCon(accion === 'anular' ? 200 : 201));
    assert.equal(a.resultado.exito, true, accion);
    const b = s.enviar(accion, firma, okCon());
    assert.notEqual(b.id, a.id, accion);
  }
});

test('incierto 6 — rechazo definitivo 400/403/409: se descarta y el siguiente intento obtiene id nuevo', () => {
  const rechazos = [
    { ok: false, status: 400, data: { error: 'INVALID_FECHA' } },
    { ok: false, status: 403, data: { error: 'ROLE_FORBIDDEN' }, failure: 'ROLE_FORBIDDEN' },
    { ok: false, status: 409, data: { error: 'EVENTO_NO_PERMITIDO_POR_ESTADO' } },
  ];
  for (const accion of ['crear', 'anular', 'corregir']) {
    for (const rechazo of rechazos) {
      const s = simulador();
      const firma = firmaOperacion(accion, { eventoId: accion === 'crear' ? null : '10', form: form('ABORTO'), motivo: 'm' });
      const a = s.enviar(accion, firma, rechazo);
      assert.equal(a.resultado.descartarOperacion, true, `${accion} ${rechazo.status}`);
      const b = s.enviar(accion, firma, okCon());
      assert.notEqual(b.id, a.id, `${accion} ${rechazo.status}`);
    }
  }
});

test('incierto 7 — doble clic: un solo POST (bloqueo) y, si llegara a repetirse, el mismo id', () => {
  const s = simulador();
  const firma = firmaOperacion('crear', { form: form('CELO_OBSERVADO') });
  const ops = crearOperacionesReproduccion((() => { let n = 0; return () => `x-${++n}`; })());
  assert.equal(ops.idPara('crear', firma), ops.idPara('crear', firma));
  assert.equal(s.posts.length, 0);
  // El panel bloquea el segundo envío mientras el primero está en curso.
  assert.match(panel, /async function ejecutar\(accion, firma, enviar\) \{\n\s+if \(enviandoRef\.current \|\| !online\) return;/);
  assert.match(panel, /enviandoRef\.current = true;\n\s+setEnviando\(true\);/);
});

test('invariante: cerrar() del panel nunca descarta ids; solo resolver() tras resultado definitivo', () => {
  const cuerpoCerrar = panel.slice(panel.indexOf('function cerrar() {'), panel.indexOf('function abrirCrear('));
  assert.ok(cuerpoCerrar.length > 0);
  assert.doesNotMatch(cuerpoCerrar, /descartar|resolver|operaciones\.current/);
  assert.doesNotMatch(panel, /\.descartar\(\)/);
  assert.equal((panel.match(/operaciones\.current\.resolver\(accion, resultado\)/g) ?? []).length, 1);
  // Un incierto (red, 5xx, no enviado, sesión, CSRF) conserva; éxito y rechazos descartan.
  for (const r of [R500, RED, { ok: false, status: 0, data: { error: 'CSRF_UNAVAILABLE' }, failure: 'REQUEST_NOT_SENT' },
    { ok: false, status: 401, data: { error: 'SESSION_EXPIRED' }, failure: 'SESSION_EXPIRED' },
    { ok: false, status: 403, data: { error: 'CSRF_INVALID' }, failure: 'CSRF_REJECTED' }]) {
    assert.equal(resultadoOperacion('crear', r).descartarOperacion, false, JSON.stringify(r.data));
  }
  assert.equal(resultadoOperacion('crear', okCon()).descartarOperacion, true);
});

test('doble submit: mismo id mientras la intención no cambia; nuevo tras éxito o cambio de datos', () => {
  let n = 0;
  const control = crearControlOperacion(() => `id-${++n}`);
  const f = form('CELO_OBSERVADO');
  const firma = firmaOperacion('crear', { form: f });
  assert.equal(control.revisar(firma), 'id-1');
  assert.equal(control.revisar(firma), 'id-1'); // reintento / doble clic
  assert.equal(control.revisar(firmaOperacion('crear', { form: { ...f, intensidadCelo: 'ALTA' } })), 'id-2');
  control.descartar();
  assert.equal(control.revisar(firma), 'id-3');
  // Bloqueo de doble envío en la UI: ref + botón deshabilitado durante el envío.
  assert.match(panel, /if \(enviandoRef\.current \|\| !online\) return;/);
  assert.match(panel, /enviandoRef\.current = true;/);
  assert.match(panel, /disabled=\{enviando \|\| deshabilitado\}/);
  assert.match(panel, /disabled=\{enviando \|\| deshabilitado \|\| !confirmado\}/);
});

test('bodies de escritura: clientOperationId en crear/anular/corregir; corrección envía el evento completo', () => {
  const f = form('PARTO', { partoTipo: 'NORMAL' });
  assert.deepEqual(buildCrearBody(f, UUID_A), { tipoEvento: 'PARTO', fechaEvento: '2026-10-01', partoTipo: 'NORMAL', numeroCrias: 1, clientOperationId: UUID_A });
  assert.deepEqual(buildAnularBody('  error de digitación ', UUID_B), { motivo: 'error de digitación', clientOperationId: UUID_B });
  assert.deepEqual(buildCorregirBody(f, 'fecha', UUID_C), {
    motivo: 'fecha', clientOperationId: UUID_C,
    evento: { tipoEvento: 'PARTO', fechaEvento: '2026-10-01', partoTipo: 'NORMAL', numeroCrias: 1 },
  });
  assert.equal(validarMotivo('  '), 'Indica el motivo.');
  assert.match(validarMotivo('x'.repeat(501)), /500/);
  assert.equal(validarMotivo('ok'), null);
});

test('API: rutas 4A exactas, POST con CSRF y sin reintentos automáticos', () => {
  assert.match(api, /`\$\{BASE\}\/animales\/\$\{encodeURIComponent\(animalId\)\}\/reproduccion`/);
  assert.match(api, /registrarEventoReproductivo[\s\S]*?postJsonWithCsrf\(`\$\{reproduccionBase\(animalId\)\}\/eventos`, body\)/);
  assert.match(api, /\/eventos\/\$\{encodeURIComponent\(eventoId\)\}\/anular`/);
  assert.match(api, /\/eventos\/\$\{encodeURIComponent\(eventoId\)\}\/corregir`/);
  assert.doesNotMatch(api, /\/api\/reproduccion/);
});

// ---------------------------------------------------------------------------
// Corrección y anulación
// ---------------------------------------------------------------------------

test('corrección: formulario precargado con el original; usa /corregir y no edita el evento', () => {
  const f = formDesdeEvento(ORIGINAL);
  assert.equal(f.tipoEvento, 'INSEMINACION_ARTIFICIAL');
  assert.equal(f.fechaEvento, '2026-09-01');
  assert.equal(f.horaEvento, '07:30');
  assert.equal(f.observaciones, 'Celo de la mañana');
  assert.equal(f.toroAnimalId, '44');
  assert.equal(f.semenCodigo, 'PJ-1');
  assert.equal(f.tecnico, 'Ana');
  assert.deepEqual(buildEventoBody(f), {
    tipoEvento: 'INSEMINACION_ARTIFICIAL', fechaEvento: '2026-09-01', horaEvento: '07:30',
    toroAnimalId: '44', semenCodigo: 'PJ-1', tecnico: 'Ana', observaciones: 'Celo de la mañana',
  });
  assert.equal(formDesdeEvento({ tipoEvento: 'PARTO', fechaEvento: '2026-01-01', detalle: { partoTipo: 'NORMAL', numeroCrias: 3 } }).numeroCrias, '3');
  assert.match(panel, /corregirEventoReproductivo\(animalId, eventoId, buildCorregirBody\(form, motivo, id\)\)/);
  assert.match(panel, /formDesdeEvento\(evento\)/);
  // Tras el éxito se recarga el historial (original ANULADO + nuevo ACTIVO).
  assert.equal(resultadoOperacion('corregir', { ok: true, status: 201, data: { evento: CORRECTOR, yaExistia: false } }).recargar, true);
});

test('anulación: motivo + confirmación explícita; el evento queda visible como ANULADO', () => {
  assert.match(panel, /role="alertdialog"/);
  assert.match(panel, /type="checkbox"/);
  assert.match(panel, /Confirmo que quiero anular este evento\./);
  assert.match(panel, /if \(errMotivo \|\| !confirmado\) return;/);
  assert.match(panel, /anularEventoReproductivo\(animalId, eventoId, buildAnularBody\(motivo, id\)\)/);
  assert.match(panel, /queda en el historial marcado como anulado/);
  const r = resultadoOperacion('anular', { ok: true, status: 200, data: { evento: ORIGINAL, yaExistia: false } });
  assert.equal(r.exito, true);
  assert.equal(r.recargar, true);
  assert.match(r.mensaje, /Se conserva en el historial/);
});

// ---------------------------------------------------------------------------
// Errores (Fase 3C)
// ---------------------------------------------------------------------------

test('mensajes funcionales para todos los códigos del contrato; nunca el message del servidor', () => {
  const codigos = ['SEXO_INCOMPATIBLE', 'ANIMAL_ANULADO', 'ANIMAL_YA_SALIDO', 'ANIMAL_YA_MUERTO', 'FECHA_ANTERIOR_A_HISTORIAL',
    'EVENTO_NO_PERMITIDO_POR_ESTADO', 'EVENTO_YA_ANULADO', 'CLIENT_OPERATION_ID_REUSED', 'INVALID_TORO', 'INVALID_FECHA', 'ROLE_FORBIDDEN'];
  for (const code of codigos) {
    assert.ok(MENSAJES_ERROR_REPRODUCCION[code], code);
    const status = code === 'ROLE_FORBIDDEN' ? 403 : code.startsWith('INVALID_') ? 400 : 409;
    const r = resultadoOperacion('crear', { ok: false, status, data: { error: code, message: 'SQL: select * from agx.x' } });
    assert.equal(r.exito, false, code);
    assert.equal(r.mensaje, MENSAJES_ERROR_REPRODUCCION[code], code);
    assert.doesNotMatch(r.mensaje, /SQL|agx\.|select/i, code);
  }
});

test('400: mensaje funcional y campo marcado; código desconocido -> genérico', () => {
  const r = resultadoOperacion('crear', { ok: false, status: 400, data: { error: 'INVALID_FECHA', message: 'fechaEvento...' } });
  assert.equal(r.campo, 'fechaEvento');
  assert.equal(r.tipo, 'RECHAZADO');
  assert.equal(resultadoOperacion('crear', { ok: false, status: 400, data: { error: 'INVALID_TORO' } }).campo, 'toroAnimalId');
  const raro = resultadoOperacion('crear', { ok: false, status: 400, data: { error: 'FORBIDDEN_FIELDS', message: 'Campos no permitidos: x' } });
  assert.doesNotMatch(raro.mensaje, /Campos no permitidos|FORBIDDEN/);
});

test('403 ROLE_FORBIDDEN: mensaje de permisos y la operación se descarta', () => {
  const r = resultadoOperacion('anular', { ok: false, status: 403, data: { error: 'ROLE_FORBIDDEN' }, failure: 'ROLE_FORBIDDEN' });
  assert.equal(r.tipo, 'PERMISOS');
  assert.equal(r.mensaje, MENSAJE_SIN_PERMISOS);
  assert.equal(r.descartarOperacion, true);
});

test('409: recarga el historial cuando el servidor cambió; FECHA_ANTERIOR marca la fecha', () => {
  for (const code of ['EVENTO_YA_ANULADO', 'EVENTO_NO_PERMITIDO_POR_ESTADO', 'ANIMAL_YA_SALIDO', 'ANIMAL_YA_MUERTO', 'ANIMAL_ANULADO']) {
    assert.equal(resultadoOperacion('crear', { ok: false, status: 409, data: { error: code } }).recargar, true, code);
  }
  const fecha = resultadoOperacion('crear', { ok: false, status: 409, data: { error: 'FECHA_ANTERIOR_A_HISTORIAL' } });
  assert.equal(fecha.campo, 'fechaEvento');
  const reusado = resultadoOperacion('crear', { ok: false, status: 409, data: { error: 'CLIENT_OPERATION_ID_REUSED' } });
  assert.equal(reusado.descartarOperacion, true);
});

test('500 con correlationId: incierto + código de seguimiento; se CONSERVA el clientOperationId', () => {
  const r = resultadoOperacion('crear', { ok: false, status: 500, data: { error: 'Error interno del servidor', code: 'INTERNAL_ERROR', correlationId: CORRELATION }, correlationId: CORRELATION });
  assert.equal(r.tipo, 'INCIERTO');
  assert.equal(r.descartarOperacion, false);
  assert.equal(r.mensaje, `${MENSAJE_INCIERTO} Código de seguimiento: abcdef12`);
  assert.doesNotMatch(r.mensaje, /INTERNAL_ERROR|Error interno/);
  // Sin correlationId válido: sin código inventado.
  assert.equal(resultadoOperacion('crear', { ok: false, status: 502, data: {} }).mensaje, MENSAJE_INCIERTO);
});

test('sin red: POST incierto (reintento seguro); POST no enviado -> mensaje de conexión', () => {
  const red = resultadoOperacion('corregir', { ok: false, status: 0, data: { error: 'NETWORK_ERROR' }, failure: 'NETWORK_ERROR' });
  assert.equal(red.tipo, 'INCIERTO');
  assert.equal(red.descartarOperacion, false);
  const noEnviado = resultadoOperacion('crear', { ok: false, status: 0, data: { error: 'CSRF_UNAVAILABLE' }, failure: 'REQUEST_NOT_SENT' });
  assert.equal(noEnviado.tipo, 'NO_ENVIADO');
  assert.equal(noEnviado.mensaje, MENSAJE_SIN_CONEXION);
  assert.equal(resultadoOperacion('crear', null).tipo, 'INCIERTO');
});

test('carga: 404 y errores de red/5xx con mensajes seguros (Fase 3C)', () => {
  assert.equal(estadoCarga({ ok: false, status: 404, data: { error: 'ANIMAL_NOT_FOUND' } }).status, 'not_found');
  assert.equal(estadoCarga({ ok: false, status: 0, data: { error: 'NETWORK_ERROR' }, failure: 'NETWORK_ERROR' }).mensaje, MENSAJE_SIN_CONEXION);
  assert.equal(estadoCarga({ ok: false, status: 500, data: { correlationId: CORRELATION }, correlationId: CORRELATION }).mensaje, 'Ocurrió un error. Código de seguimiento: abcdef12');
});

// ---------------------------------------------------------------------------
// Offline
// ---------------------------------------------------------------------------

test('offline sin copia descargada: acciones deshabilitadas con mensaje de conexión; se conserva lo ya cargado', () => {
  const a = accionesReproduccion({ animal: HEMBRA, puedeRegistrar: true, puedeAdministrar: true, online: false });
  assert.equal(a.habilitado, false);
  assert.equal(a.registrarHabilitado, false);
  assert.equal(a.aviso, MENSAJE_REPRODUCCION_OFFLINE);
  assert.match(MENSAJE_REPRODUCCION_OFFLINE, /requiere conexión/);
  assert.match(panel, /disabled=\{!acciones\.registrarHabilitado\}/);
  assert.match(panel, /siguiente\.status === 'error' && actual\.eventos\.length/);
  // El registro offline se prueba en reproduccionPanelOffline.test.js.
});

// ---------------------------------------------------------------------------
// Ficha + timeline
// ---------------------------------------------------------------------------

test('ficha: pestaña "Reproducción" montada al abrirla y marca la Actividad tras cada cambio', () => {
  assert.match(detalle, /\{ id: 'reproduccion', label: 'Reproducción' \}/);
  assert.match(detalle, /<HatoReproduccionPanel/);
  assert.match(detalle, /visible=\{pestana === 'reproduccion'\}/);
  assert.match(detalle, /onCambio=\{marcarActividad\}/);
  assert.match(detalle, /hidden=\{pestana !== 'reproduccion'\}/);
});

test('timeline: etiquetas reales de los eventos reproductivos (nunca "Actividad")', () => {
  const esperado = {
    CELO: 'Celo observado',
    SERVICIO: 'Servicio por monta',
    INSEMINACION: 'Inseminación artificial',
    IATF: 'IATF',
    TRANSFERENCIA_EMBRION: 'Transferencia de embrión',
    PRENEZ: 'Diagnóstico de preñez',
    ABORTO: 'Aborto',
    PARTO: 'Parto',
  };
  for (const [tipo, etiqueta] of Object.entries(esperado)) assert.equal(etiquetaTipoEvento(tipo), etiqueta, tipo);
});

test('timeline: anulados marcados "Anulado" sin duplicar eventos', () => {
  const anulado = { id: 'reproduccion:10', tipo: 'INSEMINACION', origen: 'reproduccion_eventos', datos: { estadoRegistro: 'ANULADO' } };
  assert.equal(esEventoAnulado(anulado), true);
  assert.equal(esEventoAnulado({ ...anulado, datos: { estadoRegistro: 'ACTIVO' } }), false);
  assert.equal(esEventoAnulado({ id: 'animal_evento:1', tipo: 'ANIMAL_ANULADO', origen: 'animal_eventos', datos: {} }), false);
  assert.match(actividadPanel, /esEventoAnulado\(evento\) \? <span className="gan-repro-badge gan-repro-badge-anulado">Anulado<\/span>/);
  // Cada evento se pinta una vez (clave = id del servidor).
  assert.match(actividadPanel, /key=\{evento\.id\}/);
});

// ---------------------------------------------------------------------------
// Responsive
// ---------------------------------------------------------------------------

test('responsive: sin anchos fijos; formulario de una columna en móvil; acciones administrativas discretas', () => {
  assert.match(css, /\.gan-repro-form-grid \{\n\s+grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(css, /\.gan-repro-accion \{[\s\S]*?background: transparent;/);
  assert.match(css, /\.gan-hato-tabs \{\n\s+overflow-x: auto;/);
  const bloque = css.slice(css.indexOf('/* FASE 4B: pestaña Reproducción. */'));
  // Anchos fijos en px (no media queries) desbordarían a 320 px.
  assert.doesNotMatch(bloque, /^\s+(min-)?width:\s*\d{3,}px/m);
});
