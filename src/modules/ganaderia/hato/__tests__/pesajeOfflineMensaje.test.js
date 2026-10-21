// Micro-PR: el aviso "Pesaje pendiente de sincronización." se retira cuando
// deja de ser cierto (ningún PESAJE_CREAR de este animal sigue en curso),
// sin afirmar "sincronizado" y sin borrar otros mensajes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ESTADOS_PESAJE_EN_CURSO,
  MENSAJE_PESAJE_PENDIENTE,
  hayPesajesEnCurso,
  mensajeTrasLeerPendientes,
} from '../pesajesOfflineModel.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const panel = fs.readFileSync(path.join(__dirname, '..', 'HatoPesajesPanel.jsx'), 'utf8').replace(/\r\n/g, '\n');

const AVISO = Object.freeze({ type: 'info', text: MENSAJE_PESAJE_PENDIENTE });
const p = (estado, id = estado) => ({ localOperationId: id, estado });

test('estados "en curso": PENDIENTE, SINCRONIZANDO, ERROR_REINTENTABLE', () => {
  assert.deepEqual([...ESTADOS_PESAJE_EN_CURSO], ['PENDIENTE', 'SINCRONIZANDO', 'ERROR_REINTENTABLE']);
  assert.equal(hayPesajesEnCurso([]), false);
  assert.equal(hayPesajesEnCurso([p('CONFLICTO'), p('RECHAZADO')]), false);
  assert.equal(hayPesajesEnCurso([p('CONFLICTO'), p('ERROR_REINTENTABLE')]), true);
});

test('1/2. tras guardar offline el aviso aparece y se mantiene mientras siga pendiente', () => {
  assert.equal(mensajeTrasLeerPendientes(AVISO, [p('PENDIENTE')]), AVISO);
  assert.equal(mensajeTrasLeerPendientes(AVISO, [p('ERROR_REINTENTABLE')]), AVISO, 'reintentando: sigue pendiente');
});

test('3. PENDIENTE -> SINCRONIZANDO: el aviso puede permanecer', () => {
  assert.equal(mensajeTrasLeerPendientes(AVISO, [p('SINCRONIZANDO')]), AVISO);
});

test('4. confirmada y eliminada del outbox: el aviso se limpia (sin afirmar "sincronizado")', () => {
  assert.equal(mensajeTrasLeerPendientes(AVISO, []), null);
});

test('5/6. en CONFLICTO o RECHAZADO: el aviso "pendiente" ya no es cierto y se retira, sin presentar éxito', () => {
  for (const estado of ['CONFLICTO', 'RECHAZADO']) {
    const r = mensajeTrasLeerPendientes(AVISO, [p(estado)]);
    assert.equal(r, null, estado);
  }
  // La información del conflicto/rechazo sigue en la sección de pendientes (no la decide el mensaje).
  assert.match(panel, /<HatoPesajesPendientes pendientes=\{pendientes\} \/>/);
});

test('7. descartada desde Sincronización: el aviso desaparece y nunca se muestra "sincronizado"', () => {
  assert.equal(mensajeTrasLeerPendientes(AVISO, []), null);
  const modelo = fs.readFileSync(path.join(__dirname, '..', 'pesajesOfflineModel.js'), 'utf8');
  assert.doesNotMatch(modelo, /sincronizado\.'|'Pesaje sincronizado/i);
  assert.doesNotMatch(panel, /Pesaje sincronizado/i);
});

test('8. otros mensajes (error, éxito online, validación) NUNCA se borran', () => {
  const otros = [
    { type: 'error', text: 'No se pudo guardar el pesaje en este dispositivo. Intenta nuevamente.' },
    { type: 'error', text: MENSAJE_PESAJE_PENDIENTE }, // mismo texto pero no es el aviso informativo
    { type: 'success', text: 'Pesaje registrado.' },
    { type: 'info', text: 'Otro aviso independiente.' },
  ];
  for (const m of otros) assert.equal(mensajeTrasLeerPendientes(m, []), m, m.text);
  assert.equal(mensajeTrasLeerPendientes(null, []), null);
});

test('9. varios pendientes: no se limpia hasta que ninguno siga en curso', () => {
  let m = AVISO;
  m = mensajeTrasLeerPendientes(m, [p('PENDIENTE', 'a'), p('PENDIENTE', 'b')]);
  assert.equal(m, AVISO);
  m = mensajeTrasLeerPendientes(m, [p('PENDIENTE', 'b')]); // 'a' confirmado
  assert.equal(m, AVISO, 'queda uno: el aviso sigue siendo cierto');
  m = mensajeTrasLeerPendientes(m, [p('CONFLICTO', 'b')]);
  assert.equal(m, null);
});

test('panel: aplica la regla al releer el outbox con una actualización funcional (sin estado obsoleto)', () => {
  assert.match(panel, /setPendientes\(lista\);\s*(\/\/[^\n]*\n\s*)*setMensaje\(\(actual\) => mensajeTrasLeerPendientes\(actual, lista\)\);/);
  // guardarOffline fija el aviso y luego relee: con su operación PENDIENTE el aviso se mantiene.
  const offline = panel.slice(panel.indexOf('async function guardarOffline(body)'), panel.indexOf('async function guardar(event)'));
  assert.ok(offline.indexOf("setMensaje({ type: 'info', text: MENSAJE_PESAJE_PENDIENTE })") < offline.indexOf('await leerPendientes()'));
  // Motor, política de reintentos y outbox no cambian en este micro-PR.
  assert.doesNotMatch(panel, /putOperacion|descartarPesajePendiente|syncNow/);
});
