// FASE 1A -- una sola fórmula de pesajes/fechas para frontend y backend.
// La fuente canónica es shared/ganaderia/engine/ (reexportada por
// src/modules/ganaderia/engine/). El runtime de Railway solo garantiza
// server/ (server/__tests__/architecture/noSrcImports.test.js), así que el
// backend usa una COPIA en server/services/ganaderia/engine/. Este test exige
// que la copia sea IDÉNTICA byte a byte (salvo fin de línea): cualquier
// cambio de fórmula debe hacerse en shared/ y copiarse, o el test falla.
//
// FASE 4E.1 -- reproduccion.js: la copia es un ARCHIVO DERIVADO con cabecera.
// Se exige la cabecera exacta y, tras ella, el contenido idéntico a la fuente.
// Un cambio de reglas se hace primero en shared/ y luego se regenera la copia.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CAMPOS_INTENCION_REPRODUCTIVA, intencionCoincide } from '../ganaderia/engine/reproduccion.js';
import { CAMPOS_EVENTO, validateEventoReproductivo } from '../ganaderia/reproduccionValidation.js';

const leer = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

const ARCHIVOS = ['fechas.js', 'pesajes.js', 'alertasPesajes.js'];
const CABECERA_DERIVADO = [
  '// ARCHIVO DERIVADO — NO EDITAR DIRECTAMENTE.',
  '// Fuente canónica:',
  '// shared/ganaderia/engine/reproduccion.js',
  '//',
  '',
].join('\n');

for (const archivo of ARCHIVOS) {
  test(`server/services/ganaderia/engine/${archivo} es copia idéntica de shared/ganaderia/engine/${archivo}`, () => {
    assert.equal(
      leer(`../ganaderia/engine/${archivo}`),
      leer(`../../../shared/ganaderia/engine/${archivo}`),
      `Copia desincronizada: ejecutar  cp shared/ganaderia/engine/${archivo} server/services/ganaderia/engine/${archivo}`,
    );
  });
}

test('server/services/ganaderia/engine/reproduccion.js es derivado: cabecera exacta + fuente idéntica', () => {
  const copia = leer('../ganaderia/engine/reproduccion.js');
  assert.ok(copia.startsWith(CABECERA_DERIVADO), 'Falta la cabecera de archivo derivado en la copia del servidor.');
  assert.equal(
    copia.slice(CABECERA_DERIVADO.length),
    leer('../../../shared/ganaderia/engine/reproduccion.js'),
    'Copia desincronizada: editar shared/ganaderia/engine/reproduccion.js y regenerar la copia (cabecera + fuente).',
  );
});

test('la fuente canónica no lleva la cabecera de archivo derivado', () => {
  assert.doesNotMatch(leer('../../../shared/ganaderia/engine/reproduccion.js'), /ARCHIVO DERIVADO/);
});

test('la copia del servidor no importa nada fuera de su carpeta', () => {
  for (const archivo of [...ARCHIVOS, 'reproduccion.js']) {
    const imports = [...leer(`../ganaderia/engine/${archivo}`).matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    assert.ok(imports.every((spec) => spec.startsWith('./')), `${archivo}: ${imports.join(', ')}`);
  }
});

test('la intención compartida usa los mismos campos que el intent_hash del servidor', () => {
  assert.deepEqual([...CAMPOS_INTENCION_REPRODUCTIVA], [...CAMPOS_EVENTO]);
});

// Cuerpos con el ruido que el servidor normaliza: si esta normalización y la de la
// validación divergen, una respuesta perdida terminaría en un falso conflicto.
const CUERPOS_CON_RUIDO = [
  { tipoEvento: 'CELO_OBSERVADO', fechaEvento: '2026-01-05', horaEvento: '', intensidadCelo: 'ALTA', metodoDeteccion: '', observaciones: '  nota\r\nsegunda  ' },
  { tipoEvento: 'SERVICIO_MONTA', fechaEvento: '2026-01-05', tipoServicio: 'LIBRE', toroAnimalId: 12, toroExterno: '  Toro \t Gyr ' },
  { tipoEvento: 'INSEMINACION_ARTIFICIAL', fechaEvento: '2026-01-05', horaEvento: '08:30', toroAnimalId: '12', semenCodigo: ' PAJ  1 ', tecnico: '\nAna\nMaría ' },
  { tipoEvento: 'IATF', fechaEvento: '2026-01-05', protocoloIatf: ' J-Synch   6 ', semenCodigo: '   ', tecnico: null },
  { tipoEvento: 'TRANSFERENCIA_EMBRION', fechaEvento: '2026-01-05', embrionCodigo: ' E 1 ', embrionRaza: 'Gyr  lechero', embrionDonadora: ' D ', toroExterno: ' P ', embrionEstadio: ' 7 ', embrionCalidad: ' 1 ', embrionConservacion: 'FRESCO', tecnico: ' T ' },
  { tipoEvento: 'DIAGNOSTICO_PRENEZ', fechaEvento: '2026-01-05', diagnosticoResultado: 'PRENADA', diagnosticoMetodo: 'ECOGRAFIA', diasGestacion: 45, tecnico: ' T  U ' },
  { tipoEvento: 'ABORTO', fechaEvento: '2026-01-05', diasGestacion: 90, abortoCausa: '  Causa   desconocida ' },
  { tipoEvento: 'PARTO', fechaEvento: '2026-01-05', partoTipo: 'NORMAL', numeroCrias: 2, observaciones: '   ' },
];

for (const cuerpo of CUERPOS_CON_RUIDO) {
  test(`intención ${cuerpo.tipoEvento}: el cuerpo local equivale a lo que normaliza el servidor`, () => {
    const normalizado = validateEventoReproductivo(cuerpo, { hoy: '2026-11-03', horaAhora: '23:59' });
    assert.equal(intencionCoincide(cuerpo, normalizado), true);
  });
}
