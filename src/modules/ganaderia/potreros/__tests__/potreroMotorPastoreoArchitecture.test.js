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
