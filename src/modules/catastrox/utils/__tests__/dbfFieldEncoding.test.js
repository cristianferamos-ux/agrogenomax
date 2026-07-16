import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildShpZipBytes,
  encodeDbfFieldBytes,
  truncateUtf8ToByteBudget,
} from '../catastroxDeliverables.js';

// Regresion para CX-FILE-003: los campos de texto del DBF (shapefile) se
// escribian recortando `text.slice(0, size)` -- unidades UTF-16 de
// JavaScript -- contra un ancho `size` que en el formato DBF es en BYTES.
// Con tildes/ñ eso podia producir mas bytes de los declarados por el campo,
// o cortar una secuencia UTF-8 a mitad (byte lider colgante), corrompiendo
// el campo y, en el peor caso, desalineando los campos siguientes del
// registro. Todos los valores usados aqui son sinteticos.

const fatalDecoder = new TextDecoder('utf-8', { fatal: true });

test('A. ASCII menor que el campo: conserva el texto, completa con espacios, longitud exacta', () => {
  const field = encodeDbfFieldBytes('ABC', 10, 'left');
  assert.equal(field.length, 10);
  assert.equal(fatalDecoder.decode(field), 'ABC       ');
});

test('B. ASCII mayor que el campo: trunca, longitud exacta', () => {
  const field = encodeDbfFieldBytes('ABCDEFGHIJKL', 5, 'left');
  assert.equal(field.length, 5);
  assert.equal(fatalDecoder.decode(field), 'ABCDE');
});

test('C. UTF-8 en el limite: "x".repeat(31) + "ñ" dentro de un campo de 32 bytes', () => {
  const value = 'x'.repeat(31) + 'ñ';
  // Confirma la premisa del caso: el texto completo ocupa 33 bytes en
  // UTF-8 (31 ASCII + 2 de "ñ"), uno mas que el ancho del campo.
  const fullBytes = new TextEncoder().encode(value);
  assert.equal(fullBytes.length, 33);

  const field = encodeDbfFieldBytes(value, 32, 'left');
  assert.equal(field.length, 32);
  assert.doesNotThrow(() => fatalDecoder.decode(field), 'debe ser UTF-8 valido, sin byte lider colgante');
  // La "ñ" (2 bytes) no cabe completa en el byte 32 disponible tras los 31
  // "x": se descarta entera en vez de dejar su byte lider (0xC3) sin
  // continuacion, y el ultimo byte queda como relleno ASCII.
  assert.equal(field[31], 0x20);
  assert.equal(fatalDecoder.decode(field), `${'x'.repeat(31)} `);
});

test('D. Tildes y caracteres multibyte (Á, É, Í, Ó, Ú, ñ): nunca exceden byteWidth, siempre decodificables', () => {
  const value = 'ÁÉÍÓÚñÑ'; // 7 caracteres, 2 bytes UTF-8 cada uno = 14 bytes
  for (const byteWidth of [1, 2, 3, 7, 8, 13, 14, 20]) {
    const field = encodeDbfFieldBytes(value, byteWidth, 'left');
    assert.equal(field.length, byteWidth, `byteWidth=${byteWidth}`);
    assert.doesNotThrow(() => fatalDecoder.decode(field), `byteWidth=${byteWidth} debe decodificar sin error`);
  }
});

test('E. Emoji / surrogate pair sintetico: no corta a mitad, salida valida, longitud exacta', () => {
  const value = 'ab\u{1F600}cd'; // 'a','b', 😀 (4 bytes UTF-8, par subrogado en UTF-16), 'c','d'

  // Ancho que corta a mitad del emoji si se recortara por posicion ingenua:
  // 'a'(1) + 'b'(1) + 3 de los 4 bytes del emoji = 5 bytes.
  const cutMidEmoji = encodeDbfFieldBytes(value, 5, 'left');
  assert.equal(cutMidEmoji.length, 5);
  assert.doesNotThrow(() => fatalDecoder.decode(cutMidEmoji), 'no debe quedar el emoji cortado a mitad');
  assert.equal(fatalDecoder.decode(cutMidEmoji), 'ab   ', 'el emoji entero se descarta si no cabe completo');

  // Ancho que alcanza exactamente para 'a'+'b'+emoji completo (6 bytes).
  const exactEmoji = encodeDbfFieldBytes(value, 6, 'left');
  assert.equal(exactEmoji.length, 6);
  assert.doesNotThrow(() => fatalDecoder.decode(exactEmoji));
  assert.equal(fatalDecoder.decode(exactEmoji), 'ab\u{1F600}');
});

test('truncateUtf8ToByteBudget: nunca devuelve mas bytes que el presupuesto y no parte secuencias', () => {
  const bytes = new TextEncoder().encode('ñandú 🙂 café');
  for (let budget = 0; budget <= bytes.length + 2; budget += 1) {
    const truncated = truncateUtf8ToByteBudget(bytes, budget);
    assert.ok(truncated.length <= budget, `budget=${budget}`);
    assert.doesNotThrow(() => fatalDecoder.decode(truncated), `budget=${budget} debe seguir siendo UTF-8 valido`);
  }
});

test('alineacion derecha (campos numericos): rellena a la izquierda, longitud exacta', () => {
  const field = encodeDbfFieldBytes('42', 8, 'right');
  assert.equal(field.length, 8);
  assert.equal(fatalDecoder.decode(field), '      42');
});

// ---- F. Integracion DBF: municipio/departamento largos y acentuados ----

function buildAlbaniaProjectedGeometry() {
  return {
    type: 'Polygon',
    coordinates: [[
      [4869000, 1589000],
      [4869010, 1589000],
      [4869015, 1589002],
      [4869020, 1589002],
      [4869020, 1589005],
      [4869015, 1589005],
      [4869010, 1589007],
      [4869000, 1589007],
      [4869000, 1589000],
    ]],
  };
}

function buildSource(overrides = {}) {
  return {
    predio: {
      id: '181500003000000130054000000000',
      codigoPredial: '181500003000000130054000000000',
      codigoAnterior: '181500003000000130054000000000',
      municipio: overrides.municipio || 'ALBANIA',
      departamento: overrides.departamento || 'CAQUETA',
      tipoZona: 'rural',
      areaM2: 34926.72,
      areaHa: 3.49,
      perimetroM: 2327.96,
      geometry: {
        type: 'MultiPolygon',
        coordinates: [[[
          [-75.95, 1.18], [-75.949, 1.18], [-75.949, 1.181], [-75.95, 1.181], [-75.95, 1.18],
        ]]],
      },
      projectedGeometry: buildAlbaniaProjectedGeometry(),
    },
  };
}

// Extrae una entrada del ZIP manual (metodo STORE, sin compresion) que
// generan buildShpZipBytes/buildKmzBytes. Mismo patron ya usado en
// projectedGeometryExports.test.js para no depender de una libreria de ZIP.
function extractZipEntry(zipBytes, suffix) {
  const buffer = Buffer.from(zipBytes);
  let offset = 0;
  while (offset + 30 <= buffer.length) {
    const signature = buffer.readUInt32LE(offset);
    if (signature !== 0x04034b50) break;
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const fileNameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const fileName = buffer.slice(offset + 30, offset + 30 + fileNameLength).toString('utf8');
    const dataStart = offset + 30 + fileNameLength + extraLength;
    const dataEnd = dataStart + compressedSize;
    if (fileName.endsWith(suffix)) {
      return buffer.slice(dataStart, dataEnd);
    }
    offset = dataEnd;
  }
  throw new Error(`No se encontro ${suffix} dentro del ZIP`);
}

// Layout de campos DBF tal como los declara writeShapefileParts en
// catastroxDeliverables.js (nombre, ancho en bytes) -- usado aqui solo para
// calcular offsets de lectura, no para redefinir el formato.
const DBF_FIELD_WIDTHS = [
  ['id', 8],
  ['codigo', 40],
  ['municipio', 32],
  ['depto', 32],
  ['zona', 16],
  ['area_m2', 14],
  ['area_ha', 12],
  ['perim_m', 14],
];

function locateDbfField(fieldName) {
  const headerLength = 32 + DBF_FIELD_WIDTHS.length * 32 + 1;
  let offset = headerLength + 1; // +1: salta el byte de borrado del registro
  for (const [name, width] of DBF_FIELD_WIDTHS) {
    if (name === fieldName) return { offset, width };
    offset += width;
  }
  throw new Error(`Campo DBF desconocido: ${fieldName}`);
}

test('F. municipio y departamento largos y acentuados: ancho exacto, UTF-8 valido, sin invadir el campo siguiente', () => {
  const source = buildSource({
    municipio: 'Archipiélago de San Andrés, Providencia y Santa Catalina', // 58 caracteres, con tildes -- excede 32 bytes en UTF-8
    departamento: 'CAQUETA',
  });

  const zipBytes = buildShpZipBytes(source);
  const dbfBytes = extractZipEntry(zipBytes, '.dbf');

  const municipioField = locateDbfField('municipio');
  const deptoField = locateDbfField('depto');

  const municipioBytes = dbfBytes.slice(municipioField.offset, municipioField.offset + municipioField.width);
  const deptoBytes = dbfBytes.slice(deptoField.offset, deptoField.offset + deptoField.width);

  assert.equal(municipioBytes.length, 32, 'el segmento debe tener exactamente el ancho declarado del campo');
  assert.doesNotThrow(
    () => fatalDecoder.decode(municipioBytes),
    'el campo municipio debe decodificar como UTF-8 valido sin secuencias partidas',
  );

  assert.equal(deptoBytes.length, 32);
  assert.equal(
    fatalDecoder.decode(deptoBytes).trimEnd(),
    'CAQUETA',
    'el desbordamiento de municipio no debe invadir el campo depto siguiente',
  );
});
