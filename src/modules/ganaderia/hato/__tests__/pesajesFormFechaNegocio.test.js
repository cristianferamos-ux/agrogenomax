// Micro-PR: el formulario de pesajes usa la fecha calendario de NEGOCIO
// (America/Bogota) -- la misma que el backend (resolveFechaHoyNegocio) --
// para la fecha por defecto, el `max` del input y la cota "no futura" de la
// validación del cliente. Nunca la zona horaria del dispositivo.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fechaHoyNegocio } from '../../engine/fechaNegocio.js';
import { initialPesajeForm, validatePesajeForm } from '../pesajesModel.js';
import { resolveFechaHoyNegocio } from '../../../../../server/services/ganaderia/motorDescansoAuto/businessTimezone.js';
import { validateCreatePesajeBody } from '../../../../../server/services/ganaderia/pesajeValidation.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HATO_DIR = path.resolve(__dirname, '..');
const ENGINE_URL = pathToFileURL(path.resolve(HATO_DIR, '..', 'engine', 'fechaNegocio.js')).href;
const FORM_MODEL_URL = pathToFileURL(path.join(HATO_DIR, 'hatoFormModel.js')).href;

const formEn = (ahora) => initialPesajeForm(fechaHoyNegocio({ ahora }));
const validar = (fecha, ahora) => validatePesajeForm({ ...formEn(ahora), fecha, pesoKg: '350' }, { hoy: fechaHoyNegocio({ ahora }) });

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
}

test('1. 2026-10-21T02:00:00Z: fecha por defecto = 2026-10-20 (Bogotá)', () => {
  assert.equal(formEn('2026-10-21T02:00:00Z').fecha, '2026-10-20');
});

test('2. en ese instante 2026-10-21 es futura para Bogotá; 2026-10-20 e históricas son válidas', () => {
  const ahora = '2026-10-21T02:00:00Z';
  assert.equal(validar('2026-10-21', ahora).errores.fecha, 'La fecha no puede ser futura.');
  assert.equal(validar('2026-10-20', ahora).valido, true);
  assert.equal(validar('2026-01-15', ahora).valido, true);
});

test('3. cruce exacto de medianoche en Bogotá', () => {
  assert.equal(formEn('2026-10-21T04:59:59.999Z').fecha, '2026-10-20');
  assert.equal(validar('2026-10-21', '2026-10-21T04:59:59.999Z').valido, false);
  assert.equal(formEn('2026-10-21T05:00:00Z').fecha, '2026-10-21');
  assert.equal(validar('2026-10-21', '2026-10-21T05:00:00Z').valido, true);
  assert.equal(validar('2026-10-22', '2026-10-21T05:00:00Z').valido, false);
});

test('4. dispositivo en otra zona horaria: la fecha del formulario sigue siendo la de Bogotá', () => {
  const instante = '2026-10-21T02:00:00Z'; // Tokio: 21/10 11:00; UTC: 21/10; Bogotá: 20/10 21:00
  const script = `
    const { fechaHoyNegocio } = await import(${JSON.stringify(ENGINE_URL)});
    const { fechaHoyLocal } = await import(${JSON.stringify(FORM_MODEL_URL)});
    const ahora = new Date(${JSON.stringify(instante)});
    process.stdout.write(JSON.stringify({ negocio: fechaHoyNegocio({ ahora }), local: fechaHoyLocal(ahora) }));
  `;
  const enZona = (tz) => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, TZ: tz }, encoding: 'utf8' }));
  const tokio = enZona('Asia/Tokyo');
  const utc = enZona('UTC');
  const bogota = enZona('America/Bogota');
  // El reloj local del "dispositivo" cambia con su zona...
  assert.equal(tokio.local, '2026-10-21');
  assert.equal(utc.local, '2026-10-21');
  assert.equal(bogota.local, '2026-10-20');
  // ...pero la fecha de negocio no.
  for (const r of [tokio, utc, bogota]) assert.equal(r.negocio, '2026-10-20');
});

test('5. contrato frontend/backend: misma fecha de negocio y la misma cota "no futura"', () => {
  const inicio = Date.UTC(2026, 9, 1, 0, 0);
  for (let t = inicio; t < inicio + 60 * 86400000; t += 97 * 60000) {
    const ahora = new Date(t);
    const hoy = fechaHoyNegocio({ ahora });
    assert.equal(hoy, resolveFechaHoyNegocio(ahora), ahora.toISOString());
  }
  // Lo que el cliente acepta como "hoy" lo acepta el backend; "mañana" lo rechazan ambos.
  const ahora = new Date('2026-10-21T02:00:00Z');
  const hoyBackend = resolveFechaHoyNegocio(ahora);
  const body = (fecha) => ({ fecha, pesoKg: 350, metodo: 'BASCULA', clientOperationId: '0d470fc2-0541-4c09-b387-954ed63729cb' });
  assert.equal(validateCreatePesajeBody(body('2026-10-20'), { hoy: hoyBackend }).fecha, '2026-10-20');
  assert.equal(validar('2026-10-20', ahora).valido, true);
  assert.throws(() => validateCreatePesajeBody(body('2026-10-21'), { hoy: hoyBackend }));
  assert.equal(validar('2026-10-21', ahora).valido, false);
});

test('regresión: peso, decimales, método y observaciones sin cambios', () => {
  const ahora = '2026-10-21T02:00:00Z';
  const hoy = fechaHoyNegocio({ ahora });
  const base = formEn(ahora);
  assert.deepEqual(base, { fecha: '2026-10-20', pesoKg: '', metodo: 'BASCULA', observaciones: '' });
  assert.match(validatePesajeForm({ ...base, pesoKg: '0' }, { hoy }).errores.pesoKg, /mayor que 0/);
  assert.match(validatePesajeForm({ ...base, pesoKg: '355.25' }, { hoy }).errores.pesoKg, /un decimal/);
  assert.match(validatePesajeForm({ ...base, pesoKg: '355', observaciones: 'x'.repeat(501) }, { hoy }).errores.observaciones, /500/);
  assert.ok(validatePesajeForm({ ...base, pesoKg: '355', metodo: 'OJO' }, { hoy }).errores.metodo);
});

test('panel: formulario (defecto, max y validación) y alertas usan UNA fecha de negocio; nunca fechaHoyLocal', () => {
  const panel = stripComments(fs.readFileSync(path.join(HATO_DIR, 'HatoPesajesPanel.jsx'), 'utf8').replace(/\r\n/g, '\n'));
  assert.doesNotMatch(panel, /fechaHoyLocal/);
  assert.equal((panel.match(/fechaHoyNegocio\(\)/g) ?? []).length, 1, 'una sola lectura de la fecha por render');
  assert.match(panel, /const fechaNegocio = fechaHoyNegocio\(\);/);
  assert.match(panel, /useState\(\(\) => initialPesajeForm\(fechaNegocio\)\)/);
  assert.match(panel, /validatePesajeForm\(form, \{ hoy: fechaNegocio \}\)/);
  assert.match(panel, /setForm\(initialPesajeForm\(fechaNegocio\)\)/);
  assert.match(panel, /hoy=\{fechaNegocio\}/, 'max del input date');
  assert.match(panel, /fechaReferencia: fechaNegocio/, 'alertas sin cambios');
  assert.doesNotMatch(panel, /\bhoy\b(?!: fechaNegocio|=\{fechaNegocio\})/);
  const form = stripComments(fs.readFileSync(path.join(HATO_DIR, 'HatoPesajeForm.jsx'), 'utf8'));
  assert.match(form, /max=\{hoy\}/);
});
