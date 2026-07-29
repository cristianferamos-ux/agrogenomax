// Verificación documentada de legibilidad de <select>/<option> (Bloque 1
// del pedido) -- este repo no tiene infraestructura de pruebas de
// componentes React con DOM real (ningún archivo de este proyecto renderiza
// JSX en pruebas, confirmado en toda la suite existente), así que esta
// prueba verifica que las reglas CSS correctivas existen en el archivo
// fuente. La verificación VISUAL real (Persona jurídica, CC/CE/NIT/
// PASAPORTE/TI legibles en Chrome/Edge) se hizo a mano en el navegador --
// ver el informe de entrega para la captura/observación exacta.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cssPath = path.resolve(__dirname, '..', 'catastrox.css');
const css = fs.readFileSync(cssPath, 'utf8');

test('1/2) catastrox.css fija color-scheme:dark en .catastrox-field select (hint nativo para el desplegable de Chrome/Edge)', () => {
  const selectBlockMatch = css.match(/\.catastrox-field select\s*{([^}]*)}/);
  assert.ok(selectBlockMatch, 'debe existir una regla .catastrox-field select');
  assert.match(selectBlockMatch[1], /color-scheme:\s*dark/);
});

test('1/2) catastrox.css fija color y background-color explícitos en .catastrox-field select option', () => {
  const optionBlockMatch = css.match(/\.catastrox-field select option\s*{([^}]*)}/);
  assert.ok(optionBlockMatch, 'debe existir una regla .catastrox-field select option');
  assert.match(optionBlockMatch[1], /color:\s*#fff/i);
  assert.match(optionBlockMatch[1], /background-color:\s*#/i);
});
