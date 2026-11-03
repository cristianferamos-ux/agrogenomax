// FASE 4E.1 -- reglas reproductivas compartidas: pureza, misma fuente para
// frontend y backend, y distinción bloqueo / advertencia al registrar sin red.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  ESTADOS_REPRODUCTIVOS,
  derivarEstadoReproductivo,
  evaluarRegistroLocal,
  primerBloqueoEnCadena,
  reglaRegistro,
} from '../../../../../shared/ganaderia/engine/reproduccion.js';
import * as frontend from '../reproduccion.js';
import * as backend from '../../../../../server/services/ganaderia/reproduccionEstado.js';

const confirmado = (eventoId, tipoEvento, fechaEvento, extra = {}) => ({ eventoId: String(eventoId), tipoEvento, fechaEvento, estadoRegistro: 'ACTIVO', ...extra });
const pendiente = (tipoEvento, fechaEvento, extra = {}) => ({ tipoEvento, fechaEvento, ...extra });
const PRENEZ = { diagnosticoResultado: 'PRENADA' };

const quitarComentarios = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('pureza: sin Express, base de datos, process, APIs de Node, React ni reloj', () => {
  const src = quitarComentarios(fs.readFileSync(new URL('../../../../../shared/ganaderia/engine/reproduccion.js', import.meta.url), 'utf8'));
  assert.doesNotMatch(src, /^\s*import\s/m);
  assert.doesNotMatch(src, /\brequire\(|\bprocess\b|\bBuffer\b|\bwindow\b|\bdocument\b|new Date\(\)|Date\.now\(/);
});

test('frontend y backend exponen exactamente las mismas funciones de la fuente compartida', () => {
  assert.equal(frontend.reglaRegistro, reglaRegistro);
  assert.deepEqual(Object.keys(backend).sort(), Object.keys(frontend).sort());
  assert.deepEqual(
    backend.derivarEstadoReproductivo({ sexo: 'HEMBRA', eventos: [confirmado(1, 'PARTO', '2026-01-01')], hoy: '2026-02-01' }),
    derivarEstadoReproductivo({ sexo: 'HEMBRA', eventos: [confirmado(1, 'PARTO', '2026-01-01')], hoy: '2026-02-01' }),
  );
});

test('el frontend no importa módulos de server/', () => {
  const src = fs.readFileSync(new URL('../reproduccion.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /server\//);
});

test('sin conflicto: ni bloqueo ni advertencia', () => {
  assert.deepEqual(
    evaluarRegistroLocal({ sexo: 'HEMBRA', evento: pendiente('CELO_OBSERVADO', '2026-03-01') }),
    { bloqueo: null, advertencia: null },
  );
});

test('A) conflicto de estado causado por un pendiente local: BLOQUEA', () => {
  const r = evaluarRegistroLocal({
    sexo: 'HEMBRA',
    confirmados: [confirmado(1, 'IATF', '2026-01-10')],
    pendientes: [pendiente('DIAGNOSTICO_PRENEZ', '2026-03-01', PRENEZ)],
    evento: pendiente('CELO_OBSERVADO', '2026-03-05'),
  });
  assert.equal(r.bloqueo.code, 'EVENTO_NO_PERMITIDO_POR_ESTADO');
  assert.equal(r.advertencia, null);
});

test('A) fecha anterior a un pendiente local: BLOQUEA', () => {
  const r = evaluarRegistroLocal({
    sexo: 'HEMBRA',
    pendientes: [pendiente('CELO_OBSERVADO', '2026-03-10')],
    evento: pendiente('IATF', '2026-03-01'),
  });
  assert.equal(r.bloqueo.code, 'FECHA_ANTERIOR_A_HISTORIAL');
});

test('B) conflicto de estado que solo sale de la copia confirmada: ADVIERTE', () => {
  const r = evaluarRegistroLocal({
    sexo: 'HEMBRA',
    confirmados: [confirmado(1, 'DIAGNOSTICO_PRENEZ', '2026-03-01', PRENEZ)],
    evento: pendiente('CELO_OBSERVADO', '2026-03-05'),
  });
  assert.equal(r.bloqueo, null);
  assert.equal(r.advertencia.code, 'EVENTO_NO_PERMITIDO_POR_ESTADO');
});

test('B) fecha anterior a la copia confirmada: ADVIERTE', () => {
  const r = evaluarRegistroLocal({
    sexo: 'HEMBRA',
    confirmados: [confirmado(1, 'CELO_OBSERVADO', '2026-03-10')],
    evento: pendiente('IATF', '2026-03-01'),
  });
  assert.equal(r.bloqueo, null);
  assert.equal(r.advertencia.code, 'FECHA_ANTERIOR_A_HISTORIAL');
});

test('un pendiente que resuelve el estado confirmado evita la advertencia', () => {
  const r = evaluarRegistroLocal({
    sexo: 'HEMBRA',
    confirmados: [confirmado(1, 'DIAGNOSTICO_PRENEZ', '2026-03-01', PRENEZ)],
    pendientes: [pendiente('ABORTO', '2026-03-05')],
    evento: pendiente('CELO_OBSERVADO', '2026-03-06'),
  });
  assert.deepEqual(r, { bloqueo: null, advertencia: null });
});

test('un pendiente sin efecto en el estado no se atribuye el conflicto (DUDOSA)', () => {
  const r = evaluarRegistroLocal({
    sexo: 'HEMBRA',
    confirmados: [confirmado(1, 'DIAGNOSTICO_PRENEZ', '2026-03-01', PRENEZ)],
    pendientes: [pendiente('DIAGNOSTICO_PRENEZ', '2026-03-05', { diagnosticoResultado: 'DUDOSA' })],
    evento: pendiente('CELO_OBSERVADO', '2026-03-06'),
  });
  assert.equal(r.bloqueo, null);
  assert.equal(r.advertencia.code, 'EVENTO_NO_PERMITIDO_POR_ESTADO');
});

test('una misma fecha es admisible y el pendiente se pliega después del confirmado', () => {
  const r = evaluarRegistroLocal({
    sexo: 'HEMBRA',
    confirmados: [confirmado(900, 'DIAGNOSTICO_PRENEZ', '2026-03-01', PRENEZ)],
    pendientes: [pendiente('ABORTO', '2026-03-01')],
    evento: pendiente('CELO_OBSERVADO', '2026-03-01'),
  });
  assert.deepEqual(r, { bloqueo: null, advertencia: null });
});

test('un evento ANULADO confirmado no cuenta', () => {
  const r = evaluarRegistroLocal({
    sexo: 'HEMBRA',
    confirmados: [confirmado(1, 'DIAGNOSTICO_PRENEZ', '2026-03-01', { ...PRENEZ, estadoRegistro: 'ANULADO' })],
    evento: pendiente('CELO_OBSERVADO', '2026-02-01'),
  });
  assert.deepEqual(r, { bloqueo: null, advertencia: null });
});

test('los eventos evaluados no se modifican ni reciben eventoId', () => {
  const pendientes = [Object.freeze(pendiente('CELO_OBSERVADO', '2026-03-01'))];
  evaluarRegistroLocal({ sexo: 'HEMBRA', pendientes, evento: Object.freeze(pendiente('IATF', '2026-03-02')) });
  assert.equal('eventoId' in pendientes[0], false);
});

test('primerBloqueoEnCadena: encuentra el primer pendiente inválido en orden', () => {
  assert.equal(primerBloqueoEnCadena({ sexo: 'HEMBRA', pendientes: [pendiente('IATF', '2026-01-10'), pendiente('PARTO', '2026-10-01')] }), null);
  const r = primerBloqueoEnCadena({
    sexo: 'HEMBRA',
    pendientes: [pendiente('DIAGNOSTICO_PRENEZ', '2026-03-01', PRENEZ), pendiente('CELO_OBSERVADO', '2026-03-02'), pendiente('IATF', '2026-03-03')],
  });
  assert.equal(r.indice, 1);
  assert.equal(r.bloqueo.code, 'EVENTO_NO_PERMITIDO_POR_ESTADO');
});

test('la evaluación no altera el estado confirmado', () => {
  const confirmados = [confirmado(1, 'IATF', '2026-01-10')];
  const antes = derivarEstadoReproductivo({ sexo: 'HEMBRA', eventos: confirmados });
  evaluarRegistroLocal({ sexo: 'HEMBRA', confirmados, pendientes: [pendiente('DIAGNOSTICO_PRENEZ', '2026-03-01', PRENEZ)], evento: pendiente('PARTO', '2026-10-01') });
  assert.deepEqual(derivarEstadoReproductivo({ sexo: 'HEMBRA', eventos: confirmados }), antes);
  assert.equal(antes.estado, ESTADOS_REPRODUCTIVOS.SERVIDA);
});
