// FASE 1A -- una sola fórmula de pesajes/fechas para frontend y backend.
// La fuente canónica es shared/ganaderia/engine/ (reexportada por
// src/modules/ganaderia/engine/). El runtime de Railway solo garantiza
// server/ (server/__tests__/architecture/noSrcImports.test.js), así que el
// backend usa una COPIA en server/services/ganaderia/engine/. Este test exige
// que la copia sea IDÉNTICA byte a byte (salvo fin de línea): cualquier
// cambio de fórmula debe hacerse en shared/ y copiarse, o el test falla.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const leer = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

for (const archivo of ['fechas.js', 'pesajes.js', 'alertasPesajes.js']) {
  test(`server/services/ganaderia/engine/${archivo} es copia idéntica de shared/ganaderia/engine/${archivo}`, () => {
    assert.equal(
      leer(`../ganaderia/engine/${archivo}`),
      leer(`../../../shared/ganaderia/engine/${archivo}`),
      `Copia desincronizada: ejecutar  cp shared/ganaderia/engine/${archivo} server/services/ganaderia/engine/${archivo}`,
    );
  });
}

test('la copia del servidor no importa nada fuera de su carpeta', () => {
  for (const archivo of ['fechas.js', 'pesajes.js', 'alertasPesajes.js']) {
    const imports = [...leer(`../ganaderia/engine/${archivo}`).matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    assert.ok(imports.every((spec) => spec.startsWith('./')), `${archivo}: ${imports.join(', ')}`);
  }
});
