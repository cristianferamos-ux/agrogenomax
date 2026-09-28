// SPRINT-3D7.2-RECOMENDACION-PASTOREO-AUTO §12: pruebas arquitectónicas
// (análisis de texto fuente) de PotreroMotorPastoreoPanel.jsx -- garantiza
// que "Modo técnico" (PotreroCapacidadPastoreoPanel, 3D7) sigue montado e
// intacto, y que "Recomendación automática" (3D7.2) es el modo por
// defecto, nunca el técnico.
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

const wrapperSource = readNormalized(path.join(POTREROS_DIR, 'PotreroMotorPastoreoPanel.jsx'));

test('importa y monta ambos motores -- Recomendación automática Y Modo técnico (nunca elimina el técnico)', () => {
  assert.match(wrapperSource, /import PotreroRecomendacionPastoreoPanel from '\.\/PotreroRecomendacionPastoreoPanel\.jsx';/);
  assert.match(wrapperSource, /import PotreroCapacidadPastoreoPanel from '\.\/PotreroCapacidadPastoreoPanel\.jsx';/);
  assert.match(wrapperSource, /<PotreroRecomendacionPastoreoPanel/);
  assert.match(wrapperSource, /<PotreroCapacidadPastoreoPanel/);
});

test('"Recomendación automática" es el modo por defecto (§12 del sprint: nunca el técnico como experiencia principal)', () => {
  assert.match(wrapperSource, /useState\('automatico'\)/);
});

test('ambos modos reciben tieneFicha/onCrearFicha -- ninguno pierde el estado vacío de §26 (3D7)', () => {
  const automaticoBlock = wrapperSource.match(/<PotreroRecomendacionPastoreoPanel[\s\S]*?\/>/)?.[0] ?? '';
  const tecnicoBlock = wrapperSource.match(/<PotreroCapacidadPastoreoPanel[\s\S]*?\/>/)?.[0] ?? '';
  for (const block of [automaticoBlock, tecnicoBlock]) {
    assert.match(block, /tieneFicha=\{tieneFicha\}/);
    assert.match(block, /onCrearFicha=\{onCrearFicha\}/);
  }
});

test('ofrece exactamente las etiquetas "Recomendación automática" y "Modo técnico"', () => {
  assert.match(wrapperSource, />\s*Recomendación automática\s*</);
  assert.match(wrapperSource, />\s*Modo técnico\s*</);
});

// -----------------------------------------------------------------------
// SPRINT-3D10.4 FASE 4 §2/§31: el motor automático de carga (smart) es
// ahora la experiencia PRINCIPAL dentro de "Recomendación automática" --
// el flujo manual anterior (numeroAnimales input) queda detrás de
// "Opciones avanzadas", NUNCA eliminado ni deprecado, y NUNCA montado a
// la vez que el smart (para no duplicar descanso/ciclo real anidados).
// -----------------------------------------------------------------------

test('importa y monta PotreroPlanPastoreoSmart -- el motor automático nuevo (Fase 4)', () => {
  assert.match(wrapperSource, /import PotreroPlanPastoreoSmart from '\.\/PotreroPlanPastoreoSmart\.jsx';/);
  assert.match(wrapperSource, /<PotreroPlanPastoreoSmart/);
});

test('smart y manual son MUTUAMENTE EXCLUYENTES -- if/else sobre opcionesAvanzadas, nunca ambos a la vez', () => {
  const bloqueAutomatico = wrapperSource.match(/\{modo === 'automatico' \? \([\s\S]*?\n\s{6}\)\s*:\s*\(/)?.[0] ?? '';
  assert.notEqual(bloqueAutomatico, '', 'debía existir el bloque condicional del modo automático');
  assert.match(bloqueAutomatico, /!opcionesAvanzadas \? \(/);
  assert.match(bloqueAutomatico, /<PotreroPlanPastoreoSmart/);
  assert.match(bloqueAutomatico, /<PotreroRecomendacionPastoreoPanel/);
});

test('"Opciones avanzadas" existe como toggle secundario (gan-back-inline, nunca compite visualmente con el CTA principal)', () => {
  assert.match(wrapperSource, /Opciones avanzadas/);
  assert.match(wrapperSource, /Volver a recomendación automática/);
  const toggleBlock = wrapperSource.match(/<button[\s\S]*?setOpcionesAvanzadas[\s\S]*?<\/button>/)?.[0] ?? '';
  assert.match(toggleBlock, /gan-back-inline/);
});

test('PotreroPlanPastoreoSmart recibe tieneFicha/onCrearFicha -- no pierde el estado vacío', () => {
  const smartBlock = wrapperSource.match(/<PotreroPlanPastoreoSmart[\s\S]*?\/>/)?.[0] ?? '';
  assert.match(smartBlock, /tieneFicha=\{tieneFicha\}/);
  assert.match(smartBlock, /onCrearFicha=\{onCrearFicha\}/);
});

test('el flujo manual (PotreroRecomendacionPastoreoPanel) NUNCA se elimina ni se comenta -- sigue importado y montado', () => {
  assert.match(wrapperSource, /import PotreroRecomendacionPastoreoPanel from '\.\/PotreroRecomendacionPastoreoPanel\.jsx';/);
  assert.match(wrapperSource, /<PotreroRecomendacionPastoreoPanel/);
});
