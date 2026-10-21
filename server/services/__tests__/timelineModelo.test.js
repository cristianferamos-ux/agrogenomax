// FASE 1D.2: modelo PURO de la línea de tiempo del animal (sin base de
// datos ni reloj). Pesajes derivados con el motor canónico real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { construirHistorialPesajes } from '../ganaderia/pesajesService.js';
import {
  TIMELINE_LIMIT_DEFAULT,
  TIMELINE_LIMIT_MAX,
  TIPOS_TIMELINE,
  construirTimelineAnimal,
  normalizarLimiteTimeline,
} from '../ganaderia/timeline/timelineModelo.js';

const animal = { animalId: '1', fechaCreacion: '2026-10-18T12:20:58.490870Z' };
const ev = (eventoId, tipoEvento, ocurridoEn, metadata = {}) => ({ eventoId: String(eventoId), tipoEvento, metadata, ocurridoEn });
const ps = (pesajeId, fecha, pesoKg, createdAt, extra = {}) => ({ pesajeId: String(pesajeId), fecha, pesoKg, metodo: 'BASCULA', origen: 'MANUAL', observaciones: null, createdAt, ...extra });
const derivar = (filas) => construirHistorialPesajes({ animalId: '1', pesajes: filas }).pesajes;
const tl = (p) => construirTimelineAnimal({ animal, ...p });
const ids = (r) => r.eventos.map((e) => e.id);

const REGISTRO = ev(1, 'REGISTRADO', '2026-10-18T12:20:58.490870Z', { intentHash: 'v1:' + 'a'.repeat(64), pesajeInicialId: null });
const QR = ev(2, 'QR_ASOCIADO', '2026-10-18T12:21:30.000000Z', { qrId: '5', codigoVisible: 'AGX-7KM4-P2XZ-R' });

test('6. solo registro: un evento ANIMAL_REGISTRADO con fecha/hora de Colombia', () => {
  const r = tl({ eventosAnimal: [REGISTRO] });
  assert.equal(r.total, 1);
  const [e] = r.eventos;
  assert.deepEqual(e, {
    id: 'animal_evento:1', tipo: 'ANIMAL_REGISTRADO', titulo: 'Animal registrado', descripcion: 'Alta del animal en AgroGenomaX.',
    datos: {}, origen: 'animal_eventos', fechaHora: '2026-10-18T12:20:58.490Z', fecha: '2026-10-18', hora: '07:20',
  });
  assert.doesNotMatch(JSON.stringify(r), /intentHash|nacid|nacimiento/i);
});

test('sin evento REGISTRADO: respaldo único desde animales.created_at (nunca dos registros)', () => {
  const r = tl({ eventosAnimal: [] });
  assert.deepEqual(r.eventos.map((e) => [e.id, e.tipo, e.origen]), [['animal:1:registro', 'ANIMAL_REGISTRADO', 'animales']]);
  const conCanonico = tl({ eventosAnimal: [REGISTRO] });
  assert.equal(conCanonico.eventos.filter((e) => e.tipo === 'ANIMAL_REGISTRADO').length, 1);
  assert.equal(tl({ eventosAnimal: [], animal: { animalId: '1' } }).total, 0, 'sin fuente confiable no se inventa');
});

test('7/8/9/10. pesajes: fecha EFECTIVA (sin instante UTC), derivaciones canónicas, mismo día GMD null', () => {
  const pesajes = derivar([
    ps(1, '2026-10-19', 350, '2026-10-20T01:00:00.000000Z', { observaciones: 'QA FASE1A PESAJE' }),
    ps(2, '2026-10-20', 355, '2026-10-21T00:38:34.603491Z'),
    ps(3, '2026-10-20', 360, '2026-10-21T04:03:05.038204Z'),
  ]);
  const r = tl({ eventosAnimal: [REGISTRO], pesajes });
  const p3 = r.eventos.find((e) => e.id === 'pesaje:3');
  assert.equal(p3.fecha, '2026-10-20', 'creado el 21/10 UTC, pero el pesaje es del 20/10');
  assert.equal(p3.fechaHora, null);
  assert.equal(p3.hora, null);
  assert.equal(p3.titulo, 'Pesaje registrado');
  assert.equal(p3.descripcion, '360 kg · Pesado en báscula');
  assert.deepEqual(p3.datos, { pesoKg: 360, metodo: 'BASCULA', origen: 'MANUAL', diferenciaKg: 5, diasDesdeAnterior: 0, gmdKgDia: null, observaciones: null, registradoEn: '2026-10-21T04:03:05.038204Z' });
  const p2 = r.eventos.find((e) => e.id === 'pesaje:2');
  assert.equal(p2.datos.gmdKgDia, 5);
  const p1 = r.eventos.find((e) => e.id === 'pesaje:1');
  assert.equal(p1.datos.diasDesdeAnterior, null);
  assert.equal(p1.datos.observaciones, 'QA FASE1A PESAJE');
  assert.equal(r.eventos.find((e) => e.id === 'pesaje:1').origen, 'animal_pesajes');
});

test('peso inicial del registro: un pesaje propio (no duplica el evento de registro)', () => {
  const r = tl({ eventosAnimal: [REGISTRO], pesajes: derivar([ps(9, '2026-10-18', 300, '2026-10-18T12:20:58.490870Z', { origen: 'REGISTRO_INICIAL' })]) });
  assert.deepEqual(r.eventos.map((e) => `${e.tipo}:${e.titulo}`), ['PESAJE_REGISTRADO:Peso inicial registrado', 'ANIMAL_REGISTRADO:Animal registrado']);
});

test('11. corrección: campos con etiquetas legibles (sin columnas internas ni JSON crudo)', () => {
  const r = tl({ eventosAnimal: [ev(3, 'DATOS_CORREGIDOS', '2026-10-19T15:00:00Z', { campos: ['sexo', 'raza_tipo', 'raza_principal_id', 'columna_rara'] })] });
  const [e] = r.eventos.filter((x) => x.tipo === 'ANIMAL_CORREGIDO');
  assert.equal(e.titulo, 'Datos del animal corregidos');
  assert.equal(e.descripcion, 'Campos: Sexo, Raza.');
  assert.deepEqual(e.datos, { campos: ['Sexo', 'Raza'] });
  assert.doesNotMatch(JSON.stringify(e), /raza_tipo|columna_rara|_id/);
  const generico = tl({ eventosAnimal: [ev(4, 'DATOS_CORREGIDOS', '2026-10-19T15:00:00Z', { campos: 'x' })] }).eventos.find((x) => x.tipo === 'ANIMAL_CORREGIDO');
  assert.equal(generico.descripcion, 'Se corrigieron datos del animal.');
});

test('12. anulación: "Animal anulado" con motivo; sin motivo -> texto explícito', () => {
  const [a] = tl({ eventosAnimal: [ev(5, 'ANULADO', '2026-10-20T15:00:00Z', { motivo: '  Registro   duplicado ' })] }).eventos.filter((x) => x.tipo === 'ANIMAL_ANULADO');
  assert.equal(a.titulo, 'Animal anulado');
  assert.equal(a.descripcion, 'Motivo: Registro duplicado');
  const [b] = tl({ eventosAnimal: [ev(6, 'ANULADO', '2026-10-20T15:00:00Z', {})] }).eventos.filter((x) => x.tipo === 'ANIMAL_ANULADO');
  assert.equal(b.descripcion, 'Sin motivo registrado.');
});

test('13/14/19. QR asignado, dado de baja y reemplazado: solo código visible; nunca qrId ni tokens', () => {
  const TOKEN = 'aB3_-xYz09QwErTyUiOpAsDfGhJkLzX1';
  const r = tl({
    eventosAnimal: [
      QR,
      ev(7, 'QR_REVOCADO', '2026-10-19T10:00:00Z', { qrId: '5', codigoVisible: 'AGX-7KM4-P2XZ-R', causa: 'DANADO', motivo: 'Chapeta rota' }),
      ev(8, 'QR_REEMPLAZADO', '2026-10-19T11:00:00Z', { qrId: '6', codigoVisible: 'AGX-4TR8-N6CW-H', anteriorQrId: '5', anteriorCodigoVisible: 'AGX-7KM4-P2XZ-R', motivo: 'Pérdida' }),
      ev(9, 'QR_REVOCADO', '2026-10-20T10:00:00Z', { qrId: '6', codigoVisible: 'AGX-4TR8-N6CW-H', causa: 'ANIMAL_ANULADO' }),
      ev(10, 'QR_ASOCIADO', '2026-10-20T11:00:00Z', { qrId: '7', codigoVisible: TOKEN, token: TOKEN, tokenCifrado: 'xyz' }),
    ],
  });
  const porId = Object.fromEntries(r.eventos.map((e) => [e.id, e]));
  assert.equal(porId['animal_evento:2'].tipo, 'QR_ASIGNADO');
  assert.equal(porId['animal_evento:2'].descripcion, 'Chapeta AGX-7KM4-P2XZ-R.');
  assert.equal(porId['animal_evento:7'].tipo, 'QR_DESASIGNADO');
  assert.equal(porId['animal_evento:7'].descripcion, 'Chapeta AGX-7KM4-P2XZ-R marcada como dañada. Motivo: Chapeta rota');
  assert.equal(porId['animal_evento:8'].tipo, 'QR_REEMPLAZADO');
  assert.equal(porId['animal_evento:8'].descripcion, 'AGX-7KM4-P2XZ-R → AGX-4TR8-N6CW-H. Motivo: Pérdida');
  assert.equal(porId['animal_evento:9'].descripcion, 'Chapeta AGX-4TR8-N6CW-H revocada por anulación del animal.');
  assert.equal(porId['animal_evento:10'].descripcion, 'Se asignó una chapeta QR.', 'un valor con forma de token nunca se muestra');
  const json = JSON.stringify(r);
  assert.ok(!json.includes(TOKEN));
  assert.doesNotMatch(json, /qrId|tokenCifrado|"token"/);
});

test('15/16. mezcla de fuentes en orden DESCENDENTE por fecha efectiva', () => {
  const r = tl({
    eventosAnimal: [REGISTRO, QR, ev(3, 'DATOS_CORREGIDOS', '2026-10-19T15:00:00Z', { campos: ['nombre'] })],
    pesajes: derivar([ps(1, '2026-10-19', 350, '2026-10-20T01:00:00Z'), ps(2, '2026-10-20', 355, '2026-10-21T00:38:34Z')]),
  });
  assert.deepEqual(ids(r), ['pesaje:2', 'pesaje:1', 'animal_evento:3', 'animal_evento:2', 'animal_evento:1']);
  const fechas = r.eventos.map((e) => e.fecha);
  assert.deepEqual(fechas, [...fechas].sort().reverse());
});

test('17. empates determinísticos: instante, prioridad de tipo y id de fuente', () => {
  const mismo = '2026-10-20T15:00:00Z';
  const a = tl({ eventosAnimal: [ev(20, 'ANULADO', mismo, { motivo: 'x' }), ev(21, 'QR_REVOCADO', mismo, { codigoVisible: 'AGX-1', causa: 'ANIMAL_ANULADO' })] });
  assert.deepEqual(ids(a).slice(0, 2), ['animal_evento:20', 'animal_evento:21'], 'anulación antes que su consecuencia QR');
  const b = tl({ pesajes: derivar([ps(30, '2026-10-20', 1, mismo), ps(31, '2026-10-20', 2, mismo)]), eventosAnimal: [REGISTRO] });
  assert.deepEqual(ids(b).slice(0, 2), ['pesaje:31', 'pesaje:30']);
  // Mismo input en cualquier orden -> mismo resultado.
  const entradas = [REGISTRO, QR, ev(3, 'DATOS_CORREGIDOS', '2026-10-19T15:00:00Z', { campos: ['nombre'] })];
  assert.deepEqual(ids(tl({ eventosAnimal: entradas })), ids(tl({ eventosAnimal: [...entradas].reverse() })));
});

test('IDs estables (derivados de la fuente) y sin duplicados aunque una fila llegue repetida', () => {
  const r1 = tl({ eventosAnimal: [REGISTRO, QR, QR], pesajes: derivar([ps(1, '2026-10-19', 350, '2026-10-20T01:00:00Z')]) });
  const r2 = tl({ eventosAnimal: [REGISTRO, QR], pesajes: derivar([ps(1, '2026-10-19', 350, '2026-10-20T01:00:00Z')]) });
  assert.deepEqual(ids(r1), ids(r2));
  assert.equal(new Set(ids(r1)).size, ids(r1).length);
  for (const id of ids(r1)) assert.match(id, /^(animal_evento:\d+|pesaje:\d+|animal:\d+:registro)$/);
});

test('tipos desconocidos o metadata inválida: se ignoran (nunca se exponen crudos)', () => {
  const r = tl({ eventosAnimal: [REGISTRO, ev(40, 'TIPO_FUTURO', '2026-10-19T00:00:00Z', { secreto: 'x' }), ev(41, 'ANULADO', '2026-10-19T00:00:00Z', null)] });
  assert.deepEqual(r.eventos.map((e) => e.tipo).sort(), ['ANIMAL_ANULADO', 'ANIMAL_REGISTRADO']);
  assert.doesNotMatch(JSON.stringify(r), /TIPO_FUTURO|secreto/);
});

test('18. limit: por defecto 50, máximo 200; truncado y total', () => {
  const muchos = derivar(Array.from({ length: 230 }, (_, i) => ps(i + 1, new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10), 200 + i, new Date(Date.UTC(2025, 0, 1 + i, 15)).toISOString())));
  const r = tl({ eventosAnimal: [REGISTRO], pesajes: muchos });
  assert.equal(r.eventos.length, TIMELINE_LIMIT_DEFAULT);
  assert.equal(r.total, 231);
  assert.equal(r.truncado, true);
  assert.deepEqual(ids(r).slice(0, 2), ['animal_evento:1', 'pesaje:230'], 'los más recientes primero (registro 2026 > pesajes 2025)');
  assert.ok(!ids(r).includes('pesaje:1'), 'los más antiguos quedan fuera del límite');
  assert.equal(tl({ eventosAnimal: [REGISTRO], pesajes: muchos, limit: 999 }).eventos.length, TIMELINE_LIMIT_MAX);
  assert.equal(tl({ eventosAnimal: [REGISTRO], pesajes: muchos, limit: 5 }).eventos.length, 5);
  assert.equal(tl({ eventosAnimal: [REGISTRO] }).truncado, false);
  assert.equal(normalizarLimiteTimeline(undefined), 50);
  assert.equal(normalizarLimiteTimeline('200'), 200);
  for (const malo of ['0', '201', '-1', '1.5', 'abc', '99999']) assert.equal(normalizarLimiteTimeline(malo), null, malo);
});

test('contrato normalizado: solo { id, tipo, fechaHora, fecha, hora, titulo, descripcion, datos, origen }', () => {
  const r = tl({ eventosAnimal: [REGISTRO, QR], pesajes: derivar([ps(1, '2026-10-19', 350, '2026-10-20T01:00:00Z')]) });
  for (const e of r.eventos) {
    assert.deepEqual(Object.keys(e).sort(), ['datos', 'descripcion', 'fecha', 'fechaHora', 'hora', 'id', 'origen', 'tipo', 'titulo']);
    assert.ok(Object.values(TIPOS_TIMELINE).includes(e.tipo));
  }
});
