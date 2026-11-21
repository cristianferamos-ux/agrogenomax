// FASE 5A.2 -- anulación de pesajes en el frontend ONLINE: rol, motivo,
// payload, doble clic, errores del backend, historial ACTIVO/ANULADO, mismo
// día y bloqueo sin conexión. Modelo puro + comprobaciones de arquitectura
// sobre los componentes (sin DOM).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { capacidadesDe } from '../../auth/ganaderiaPermisos.js';
import { identidadEsperadaDe } from '../reproduccionOfflineModel.js';
import { enriquecerHistorialPesajes, enriquecerPesajes } from '../../engine/pesajes.js';
import { messageForError } from '../hatoFormModel.js';
import { puntosGmd, resultadoRegistro, validatePesajeForm } from '../pesajesModel.js';
import {
  ADVERTENCIA_ANULACION_PESAJE,
  MAX_MOTIVO_ANULACION_PESAJE,
  MENSAJE_ANULACION_REQUIERE_CONEXION,
  TEXTO_MEDICION_NO_USADA,
  accionAnularPesaje,
  buildAnularPesajeBody,
  crearControladorAnulacion,
  filasHistorial,
  presentarFilaHistorial,
  resultadoAnulacion,
  validarMotivoAnulacion,
} from '../pesajesAnulacionModel.js';

const sinComentarios = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const src = (rel) => sinComentarios(fs.readFileSync(new URL(rel, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const panel = src('../HatoPesajesPanel.jsx');
const historialJsx = src('../HatoPesajesHistorial.jsx');
const dialogo = src('../HatoPesajeAnularDialog.jsx');
const ACTIVO = { pesajeId: '3', fecha: '2026-10-20', pesoKg: 360, metodo: 'BASCULA', estadoRegistro: 'ACTIVO' };
const ANULADO = { ...ACTIVO, estadoRegistro: 'ANULADO', anulacion: { anuladoEn: '2026-11-18T15:00:00.000000Z', motivo: 'Error de digitación' } };
const AUTH = { cuenta: { cuentaId: 'cuenta-1' }, organizacionActiva: { organizacionId: 'org-1', rol: 'owner' } };
const ok = (pesaje = ANULADO, extra = {}) => ({ ok: true, status: 200, data: { ok: true, yaExistia: false, pesaje, resumen: {}, ...extra } });
const err = (status, error) => ({ ok: false, status, data: { error, message: 'msg servidor' } });

// 1-5: RBAC y estado del pesaje -----------------------------------------
for (const [rol, visible] of [['owner', true], ['admin', true], ['operador', false], ['lector', false], [null, false]]) {
  test(`${visible ? 'muestra' : 'oculta'} "Anular" para ${rol ?? 'rol desconocido'}`, () => {
    const caps = capacidadesDe(rol);
    assert.equal(caps.anularPesaje, visible);
    assert.equal(accionAnularPesaje({ puedeAnular: caps.anularPesaje, pesaje: ACTIVO }).visible, visible);
  });
}

test('5. un pesaje ANULADO no tiene acción (ni para owner)', () => {
  assert.equal(accionAnularPesaje({ puedeAnular: true, pesaje: ANULADO }).visible, false);
  assert.equal(accionAnularPesaje({ puedeAnular: true, pesaje: ACTIVO, admitePesajes: false }).visible, false, 'animal anulado: sin acción');
});

// 6-7: motivo -------------------------------------------------------------
test('6/7. motivo: vacío/espacios bloqueado, >500 bloqueado, 500 válido, misma normalización que el backend', () => {
  for (const v of ['', '   ', '\n\t', null, undefined, 5]) assert.equal(validarMotivoAnulacion(v).valido, false, JSON.stringify(v));
  assert.equal(validarMotivoAnulacion('m'.repeat(MAX_MOTIVO_ANULACION_PESAJE + 1)).valido, false);
  assert.equal(validarMotivoAnulacion('m'.repeat(MAX_MOTIVO_ANULACION_PESAJE)).valido, true);
  assert.deepEqual(validarMotivoAnulacion('  Error\r\nde báscula  '), { valido: true, motivo: 'Error\nde báscula', error: null });
  assert.equal(MAX_MOTIVO_ANULACION_PESAJE, 500);
});

// 8-9: payload --------------------------------------------------------------
test('8/9. payload exacto: motivo, clientOperationId e identidadEsperada de la sesión (nada más)', () => {
  const body = buildAnularPesajeBody({ motivo: 'Duplicado', clientOperationId: 'op-1', identidadEsperada: identidadEsperadaDe(AUTH) });
  assert.deepEqual(body, { motivo: 'Duplicado', clientOperationId: 'op-1', identidadEsperada: { cuentaId: 'cuenta-1', organizacionId: 'org-1' } });
  assert.deepEqual(buildAnularPesajeBody({ motivo: 'x', clientOperationId: 'op-2', identidadEsperada: null }), { motivo: 'x', clientOperationId: 'op-2' });
  for (const prohibido of ['anuladoPor', 'anuladoAt', 'organizacionId', 'estadoRegistro']) assert.equal(prohibido in body, false, prohibido);
  // El panel usa la identidad de la sesión, nunca un actor propio.
  assert.match(panel, /identidadEsperada: identidadEsperadaDe\(auth\)/);
  assert.match(panel, /anularPesaje\(animalId, pesaje\.pesajeId, buildAnularPesajeBody\(/);
});

// 10: doble clic --------------------------------------------------------------
test('10. doble clic: un solo POST; el reintento incierto conserva el id; otro motivo = id nuevo', async () => {
  let llamadas = 0;
  let soltar;
  const ids = [];
  let n = 0;
  const c = crearControladorAnulacion({
    nuevoId: () => `op-${++n}`,
    enviar: ({ clientOperationId }) => {
      llamadas += 1;
      ids.push(clientOperationId);
      return new Promise((resolve) => { soltar = resolve; });
    },
  });
  const p1 = c.anular('Duplicado');
  const p2 = c.anular('Duplicado');
  assert.equal(await p2, null, 'el segundo clic se ignora');
  soltar({ data: { error: 'NETWORK_ERROR' } });
  assert.equal((await p1).tipo, 'INCIERTO');
  assert.equal(llamadas, 1);
  const p3 = c.anular('Duplicado');
  soltar(err(502));
  await p3;
  assert.deepEqual(ids, ['op-1', 'op-1'], 'mismo id tras resultado incierto');
  const p4 = c.anular('Otro motivo');
  soltar(ok());
  assert.equal((await p4).exito, true);
  assert.equal(ids.at(-1), 'op-2', 'motivo distinto -> intención nueva');
  // Botón y diálogo deshabilitados mientras se envía.
  assert.match(dialogo, /disabled=\{enviando\}/);
  assert.match(dialogo, /aria-busy=\{enviando \? 'true' : undefined\}/);
  assert.match(panel, /if \(!controlador \|\| controlador\.enCurso\) return;/);
});

// 11-12: éxito -----------------------------------------------------------------
test('11/12. éxito: cierra el diálogo y recarga resumen/historial; el historial muestra el ANULADO', () => {
  const r = resultadoAnulacion(ok());
  assert.equal(r.tipo, 'ANULADO');
  assert.equal(r.exito, true);
  assert.equal(resultadoAnulacion(ok(ANULADO, { yaExistia: true })).exito, true);
  assert.match(panel, /if \(resultado\.exito \|\| resultado\.tipo === 'RECARGAR'\) \{\s+setAnulando\(null\);[\s\S]*?await cargar\(\);/);
  const historial = filasHistorial({ pesajes: [ACTIVO], historial: [{ ...ACTIVO, pesajeId: '2' }, ANULADO] });
  assert.equal(historial.length, 2, 'usa `historial` (ACTIVOS + ANULADOS)');
  const v = presentarFilaHistorial(ANULADO);
  assert.equal(v.etiquetaEstado, 'Anulado');
  assert.equal(v.sinDerivaciones, true);
  assert.equal(v.notaCalculo, 'Anulado el 18/11/2026. Motivo: Error de digitación. No participa en los cálculos.');
  assert.match(historialJsx, /formatFecha\(p\.fecha\)/, 'fecha original');
  assert.match(historialJsx, /formatKg\(p\.pesoKg\)/, 'peso original');
  assert.deepEqual(filasHistorial({ pesajes: [ACTIVO] }), [ACTIVO], 'API sin historial: compatibilidad');
});

// 13-15, 18: errores ------------------------------------------------------------
test('13/14/15. errores de anulación con mensajes comprensibles (sin códigos técnicos)', () => {
  const casos = [
    [err(409, 'PESAJE_YA_ANULADO'), 'RECARGAR'],
    [err(409, 'CLIENT_OPERATION_ID_REUSED'), 'NUEVA_INTENCION'],
    [err(409, 'IDENTIDAD_NO_COINCIDE'), 'IDENTIDAD'],
    [err(400, 'INVALID_MOTIVO'), 'CAMPO'],
    [err(403, 'ROLE_FORBIDDEN'), 'PERMISOS'],
    [err(404, 'PESAJE_NOT_FOUND'), 'RECARGAR'],
    [{ data: { error: 'NETWORK_ERROR' } }, 'INCIERTO'],
    [err(500), 'INCIERTO'],
  ];
  for (const [res, tipo] of casos) {
    const r = resultadoAnulacion(res);
    assert.equal(r.tipo, tipo, res.data.error);
    assert.ok(r.mensaje && !/[A-Z]{3,}_[A-Z_]+/.test(r.mensaje), `${res.data.error}: mensaje sin código técnico`);
  }
});

test('retry: tras un fallo definitivo, el mismo motivo reintenta la MISMA intención y un motivo distinto usa un id nuevo', async () => {
  let n = 0;
  const envios = [];
  const respuestas = [err(409, 'IDENTIDAD_NO_COINCIDE'), err(400, 'INVALID_MOTIVO'), ok()];
  const c = crearControladorAnulacion({ nuevoId: () => `op-${++n}`, enviar: async (e) => { envios.push(e); return respuestas.shift(); } });
  assert.equal((await c.anular('Motivo A')).tipo, 'IDENTIDAD');
  assert.equal((await c.anular('Motivo A')).tipo, 'CAMPO');
  assert.equal((await c.anular('Motivo B')).exito, true);
  assert.deepEqual(envios, [
    { clientOperationId: 'op-1', motivo: 'Motivo A' },
    { clientOperationId: 'op-1', motivo: 'Motivo A' },
    { clientOperationId: 'op-2', motivo: 'Motivo B' },
  ], 'un id nunca viaja con una intención (motivo) diferente');
  // Un diálogo nuevo crea un controlador nuevo: otra intención, otro id.
  assert.match(panel, /controladorRef\.current = crearControladorAnulacion\(\{/);
});

test('14. CLIENT_OPERATION_ID_REUSED renueva el clientOperationId', async () => {
  let n = 0;
  const ids = [];
  const c = crearControladorAnulacion({ nuevoId: () => `op-${++n}`, enviar: async ({ clientOperationId }) => { ids.push(clientOperationId); return ids.length === 1 ? err(409, 'CLIENT_OPERATION_ID_REUSED') : ok(); } });
  assert.equal((await c.anular('x')).tipo, 'NUEVA_INTENCION');
  assert.equal((await c.anular('x')).exito, true);
  assert.deepEqual(ids, ['op-1', 'op-2']);
});

test('16/17. fecha anterior a nacimiento / ingreso: validación local (mismo orden que el backend) y mapeo del 400', () => {
  const form = { fecha: '2024-01-05', pesoKg: '100', metodo: 'BASCULA', observaciones: '' };
  const v1 = validatePesajeForm(form, { hoy: '2026-11-18', fechaNacimiento: '2024-01-10', fechaIngreso: '2024-06-01' });
  assert.match(v1.errores.fecha, /anterior a la fecha de nacimiento del animal \(10\/01\/2024\)/, 'si viola ambas: nacimiento');
  const v2 = validatePesajeForm({ ...form, fecha: '2024-03-01' }, { hoy: '2026-11-18', fechaNacimiento: '2024-01-10', fechaIngreso: '2024-06-01' });
  assert.match(v2.errores.fecha, /anterior a la fecha de ingreso del animal al hato \(01\/06\/2024\)/);
  assert.equal(validatePesajeForm({ ...form, fecha: '2024-06-01' }, { hoy: '2026-11-18', fechaIngreso: '2024-06-01' }).valido, true, 'igualdad válida');
  for (const code of ['FECHA_ANTERIOR_A_NACIMIENTO', 'FECHA_ANTERIOR_A_INGRESO']) {
    const r = resultadoRegistro(err(400, code));
    assert.equal(r.tipo, 'CAMPO');
    assert.equal(r.campo, 'fecha');
    assert.ok(!r.mensaje.includes(code));
  }
  assert.match(panel, /validatePesajeForm\(form, \{ hoy: fechaNegocio, fechaNacimiento, fechaIngreso \}\)/);
});

test('18. corrección del animal incompatible con pesajes activos: mensaje claro', () => {
  const m = messageForError('HISTORIAL_PESAJES_FECHA_INCOMPATIBLE');
  assert.match(m, /pesaje activo/);
  assert.ok(!m.includes('HISTORIAL_'));
});

// 19-20: mismo día ----------------------------------------------------------------
test('19/20. mismo día: la medición previa explica por qué no tiene GMD; la GMD no usa la medición intradía anterior', () => {
  const filas = [
    { pesajeId: '1', fecha: '2026-10-19', pesoKg: 350, metodo: 'BASCULA' },
    { pesajeId: '2', fecha: '2026-10-20', pesoKg: 355, metodo: 'BASCULA' },
    { pesajeId: '3', fecha: '2026-10-20', pesoKg: 360, metodo: 'BASCULA' },
  ];
  const h = enriquecerHistorialPesajes(filas);
  const previa = presentarFilaHistorial(h[1]);
  assert.equal(previa.notaCalculo, TEXTO_MEDICION_NO_USADA);
  assert.equal(previa.sinDerivaciones, true);
  const ultima = presentarFilaHistorial(h[2]);
  assert.equal(ultima.sinDerivaciones, false);
  assert.match(ultima.notaMismoDia, /Último de 2 pesajes activos del día \(de 355 kg a 360 kg, \+5 kg\)/);
  assert.equal(presentarFilaHistorial(h[0]).notaCalculo, null, 'primer pesaje: sin nota (Sin dato normal)');
  const puntos = puntosGmd(enriquecerPesajes(filas));
  assert.deepEqual(puntos.map((x) => [x.fecha, x.gmdKgDia]), [['2026-10-20', 10]], 'un solo período 350 -> 360');
  assert.match(historialJsx, /colSpan=\{3\}/);
});

// 21: offline ----------------------------------------------------------------------
test('21. sin conexión: sin motor offline se bloquea con aviso claro; con motor se ENCOLA (nunca fetch)', () => {
  const a = accionAnularPesaje({ puedeAnular: true, pesaje: ACTIVO, online: false });
  assert.deepEqual(a, { visible: true, habilitado: false, motivoBloqueo: MENSAJE_ANULACION_REQUIERE_CONEXION });
  assert.match(MENSAJE_ANULACION_REQUIERE_CONEXION, /requiere conexión/);
  // FASE 5A.3c: sin conexión solo se bloquea si el dispositivo NO puede encolar (sin motor offline).
  assert.match(panel, /if \(!online && !repoOffline\) \{\s+setMensaje\(\{ type: 'info', text: MENSAJE_ANULACION_REQUIERE_CONEXION \}\);/);
  // FASE 5A.3c: la vía offline solo encola en el motor; el POST directo queda en la vía online.
  const encolar = panel.slice(panel.indexOf('async function encolarAnulacion'), panel.indexOf('async function cancelarPendiente'));
  assert.ok(encolar.length > 200);
  assert.match(encolar, /await repoOffline\.encolarAnulacionPesaje\(\{/);
  assert.doesNotMatch(encolar, /anularPesaje\(|fetch\(|postJson/);
  assert.match(panel, /if \(controlador\.modo === 'offline'\) \{[\s\S]*?await encolarAnulacion\(controlador, motivo\);/);
  // Historial, diálogo y modelo no tocan el outbox: solo presentan.
  for (const fuente of [historialJsx, dialogo, src('../pesajesAnulacionModel.js')]) {
    assert.doesNotMatch(fuente, /PESAJE_ANULAR|registrarAnulacionLocal|outbox|repoOffline\./i);
  }
  // FASE 5A.3c: la ficha encola y cancela SOLO a través del motor (nunca outbox directo).
  assert.match(src('../../offline/operationHandlers.js'), /PESAJE_ANULAR/);
  assert.match(panel, /repoOffline\.encolarAnulacionPesaje\(/);
  assert.match(panel, /repoOffline\.cancelarPesajePendiente\(pendiente\.localOperationId, \{ cuentaId \}\)/);
  assert.doesNotMatch(panel, /storage\.|putOperacion|'outbox'/);
});

// Diálogo y privacidad ---------------------------------------------------------------
test('diálogo accesible con la advertencia exigida; sin actor ni ids internos en la presentación', () => {
  assert.match(dialogo, /role="alertdialog"/);
  assert.match(dialogo, /aria-modal="true"/);
  assert.match(dialogo, /\{ADVERTENCIA_ANULACION_PESAJE\}/);
  assert.equal(ADVERTENCIA_ANULACION_PESAJE, 'El pesaje no se eliminará. Quedará registrado como anulado y dejará de participar en los cálculos productivos.');
  assert.match(dialogo, /required/);
  assert.match(historialJsx, /accion\.visible \?/);
  for (const fuente of [historialJsx, dialogo]) assert.doesNotMatch(fuente, /anuladoPor|anulado_por|clientOperationId|cuentaId/);
  const v = JSON.stringify(presentarFilaHistorial({ ...ANULADO, anuladoPor: 'uuid-actor' }));
  assert.equal(v.includes('uuid-actor'), false);
});
