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
// FASE 5A.1b: el servicio de timeline usa `historial` (ACTIVOS + ANULADOS).
const derivar = (filas) => construirHistorialPesajes({ animalId: '1', pesajes: filas }).historial;
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

test('7/8/9/10. pesajes: hecho = created_at (Colombia), fechaPesaje aparte, derivaciones canónicas de la serie diaria', () => {
  const pesajes = derivar([
    ps(1, '2026-10-19', 350, '2026-10-20T01:00:00.000000Z', { observaciones: 'QA FASE1A PESAJE' }),
    ps(2, '2026-10-20', 355, '2026-10-21T00:38:34.603491Z'),
    ps(3, '2026-10-20', 360, '2026-10-21T04:03:05.038204Z'),
  ]);
  const r = tl({ eventosAnimal: [REGISTRO], pesajes });
  const p3 = r.eventos.find((e) => e.id === 'pesaje:3');
  // FASE 5B: fecha/hora del HECHO (created_at 21/10 04:03 UTC = 20/10 23:03 Colombia).
  assert.equal(p3.fechaHora, '2026-10-21T04:03:05.038Z');
  assert.equal(p3.fecha, '2026-10-20');
  assert.equal(p3.hora, '23:03');
  assert.equal(p3.titulo, 'Pesaje registrado');
  assert.equal(p3.descripcion, '360 kg · Pesado en báscula');
  // FASE 5A: 360 (último del 20/10) frente a 350 (19/10): +10 kg en 1 día.
  assert.deepEqual(p3.datos, {
    estadoRegistro: 'ACTIVO', anulacion: null, vigente: true,
    pesoKg: 360, metodo: 'BASCULA', origen: 'MANUAL', fechaPesaje: '2026-10-20',
    diferenciaKg: 10, diasDesdeAnterior: 1, gmdKgDia: 10, observaciones: null, registradoEn: '2026-10-21T04:03:05.038204Z',
  });
  const p2 = r.eventos.find((e) => e.id === 'pesaje:2');
  assert.equal(p2.datos.gmdKgDia, null, 'medición previa del mismo día: sin derivaciones');
  const p1 = r.eventos.find((e) => e.id === 'pesaje:1');
  assert.equal(p1.datos.diasDesdeAnterior, null);
  assert.equal(p1.datos.observaciones, 'QA FASE1A PESAJE');
  assert.equal(r.eventos.find((e) => e.id === 'pesaje:1').origen, 'animal_pesajes');
});

// FASE 5B: fila ANULADA con los campos que el servidor nunca debe exponer
// (si alguno llegara al modelo, no puede salir en la respuesta).
const anulado = (fila, anuladoEn, motivo) => ({
  ...fila,
  estadoRegistro: 'ANULADO',
  anulacion: { anuladoEn, motivo },
  actorCuentaId: '11111111-1111-4111-8111-111111111111',
  anuladoPor: '22222222-2222-4222-8222-222222222222',
  clientOperationId: '33333333-3333-4333-8333-333333333333',
  anulacionClientOperationId: '44444444-4444-4444-8444-444444444444',
});

test('5B.1 activo => un solo PESAJE_REGISTRADO (sin PESAJE_ANULADO)', () => {
  const r = tl({ pesajes: derivar([ps(1, '2026-10-19', 350, '2026-10-20T01:00:00Z')]), eventosAnimal: [REGISTRO] });
  assert.deepEqual(r.eventos.filter((e) => e.origen === 'animal_pesajes').map((e) => [e.id, e.tipo]), [['pesaje:1', 'PESAJE_REGISTRADO']]);
});

test('5B.2/3/4/5 anulado => REGISTRADO + ANULADO, ids distintos, fechaPesaje y motivo', () => {
  const pesajes = derivar([
    ps(1, '2026-10-19', 350, '2026-10-20T01:00:00.000000Z'),
    ps(2, '2026-10-20', 355, '2026-10-21T00:38:34.603491Z'),
    anulado(ps(3, '2026-10-20', 360, '2026-10-21T13:15:00.000000Z'), '2026-11-18T19:30:00.000000Z', '  Error   de digitación '),
  ]);
  const r = tl({ eventosAnimal: [REGISTRO], pesajes });
  const delPesaje3 = r.eventos.filter((e) => e.id.startsWith('pesaje:3'));
  assert.deepEqual(delPesaje3.map((e) => [e.id, e.tipo]), [['pesaje:3:anulacion', 'PESAJE_ANULADO'], ['pesaje:3', 'PESAJE_REGISTRADO']]);
  const [anul, reg] = delPesaje3;
  // REGISTRADO permanece: título sin "(anulado)", sin derivaciones, fecha del registro.
  assert.equal(reg.titulo, 'Pesaje registrado');
  assert.equal(reg.descripcion, '360 kg · Pesado en báscula');
  assert.deepEqual([reg.fecha, reg.hora], ['2026-10-21', '08:15']);
  assert.deepEqual(reg.datos, {
    estadoRegistro: 'ANULADO', anulacion: { anuladoEn: '2026-11-18T19:30:00.000000Z', motivo: 'Error de digitación' }, vigente: false,
    pesoKg: 360, metodo: 'BASCULA', origen: 'MANUAL', fechaPesaje: '2026-10-20',
    diferenciaKg: null, diasDesdeAnterior: null, gmdKgDia: null, observaciones: null, registradoEn: '2026-10-21T13:15:00.000000Z',
  });
  // ANULADO: hecho propio en anulado_at, con peso original, fecha del pesaje y motivo.
  assert.deepEqual(anul, {
    id: 'pesaje:3:anulacion',
    tipo: 'PESAJE_ANULADO',
    titulo: 'Anulación de pesaje',
    descripcion: 'Peso original: 360 kg · Fecha del pesaje: 20/10/2026 · Motivo: Error de digitación',
    datos: { pesoKg: 360, metodo: 'BASCULA', fechaPesaje: '2026-10-20', motivo: 'Error de digitación', anuladoEn: '2026-11-18T19:30:00.000000Z' },
    origen: 'animal_pesajes',
    fechaHora: '2026-11-18T19:30:00.000Z',
    fecha: '2026-11-18',
    hora: '14:30',
  });
  // El ACTIVO restante representa el 20/10: 355 frente a 350 (cálculos solo con ACTIVOS).
  const p2 = r.eventos.find((e) => e.id === 'pesaje:2');
  assert.equal(p2.datos.diferenciaKg, 5);
  assert.equal(p2.datos.gmdKgDia, 5);
});

test('5B compatibilidad del contrato público: PESAJE_REGISTRADO conserva estadoRegistro/anulacion (5A.1b) y añade vigente', () => {
  const pesajes = derivar([
    ps(1, '2026-10-19', 350, '2026-10-20T01:00:00Z'),
    anulado(ps(2, '2026-10-20', 360, '2026-10-21T13:15:00Z'), '2026-11-18T19:30:00.000000Z', 'Duplicado'),
  ]);
  const r = tl({ pesajes });
  const activo = r.eventos.find((e) => e.id === 'pesaje:1');
  assert.equal(activo.datos.estadoRegistro, 'ACTIVO');
  assert.equal(activo.datos.anulacion, null);
  assert.equal(activo.datos.vigente, true);
  const reg = r.eventos.find((e) => e.id === 'pesaje:2');
  assert.equal(reg.tipo, 'PESAJE_REGISTRADO');
  assert.equal(reg.datos.estadoRegistro, 'ANULADO');
  assert.equal(reg.datos.vigente, false);
  assert.equal(reg.datos.anulacion.motivo, 'Duplicado');
  assert.equal(reg.datos.anulacion.anuladoEn, '2026-11-18T19:30:00.000000Z');
  assert.deepEqual(Object.keys(reg.datos.anulacion).sort(), ['anuladoEn', 'motivo'], 'sin actor ni operación dentro de anulacion');
  // Sigue habiendo dos hechos y el visual 5B no regresa al de 5A.1b.
  assert.deepEqual(r.eventos.filter((e) => e.id.startsWith('pesaje:2')).map((e) => e.tipo), ['PESAJE_ANULADO', 'PESAJE_REGISTRADO']);
  assert.equal(reg.titulo, 'Pesaje registrado');
  assert.doesNotMatch(JSON.stringify(r), /\(anulado\)|Primer peso registrado/);
  assert.deepEqual([reg.datos.diferenciaKg, reg.datos.diasDesdeAnterior, reg.datos.gmdKgDia], [null, null, null]);
  assert.doesNotMatch(JSON.stringify(r), /11111111|22222222|33333333|44444444|anuladoPor|actorCuentaId|clientOperationId/i);
});

test('5B.3 orden de auditoría: REGISTRADO por created_at y ANULADO por anulado_at (nunca por fecha productiva)', () => {
  // Pesaje del 20/10 registrado el 21/10 08:15 y anulado el 18/11 14:30 (Colombia);
  // otro pesaje del 01/11 registrado el 01/11; QR asociado el 10/11.
  const pesajes = derivar([
    anulado(ps(1, '2026-10-20', 360, '2026-10-21T13:15:00Z'), '2026-11-18T19:30:00Z', 'Duplicado'),
    ps(2, '2026-11-01', 370, '2026-11-01T15:00:00Z'),
  ]);
  const r = tl({ eventosAnimal: [REGISTRO, ev(7, 'QR_ASOCIADO', '2026-11-10T15:00:00Z', { codigoVisible: 'AGX-1' })], pesajes });
  assert.deepEqual(ids(r), ['pesaje:1:anulacion', 'animal_evento:7', 'pesaje:2', 'pesaje:1', 'animal_evento:1']);
  // Retroactivo: registrado HOY con fecha productiva antigua -> aparece en la fecha del registro.
  const retro = tl({ eventosAnimal: [ev(8, 'QR_ASOCIADO', '2026-11-10T15:00:00Z', { codigoVisible: 'AGX-1' })], pesajes: derivar([ps(5, '2026-09-01', 300, '2026-11-15T15:00:00Z')]) });
  assert.deepEqual(ids(retro), ['pesaje:5', 'animal_evento:8', 'animal:1:registro']);
  assert.equal(retro.eventos[0].datos.fechaPesaje, '2026-09-01');
  // Mismo día: la anulación (posterior) precede al registro.
  const mismoDia = tl({ pesajes: derivar([anulado(ps(6, '2026-11-18', 300, '2026-11-18T13:00:00Z'), '2026-11-18T13:05:00Z', 'x')]) });
  assert.deepEqual(ids(mismoDia), ['pesaje:6:anulacion', 'pesaje:6', 'animal:1:registro']);
});

test('5B.6/7 sin actor ni ids de operación (aunque llegaran al modelo)', () => {
  const r = tl({ eventosAnimal: [REGISTRO], pesajes: derivar([anulado(ps(1, '2026-10-20', 360, '2026-10-21T13:15:00Z'), '2026-11-18T19:30:00Z', 'Duplicado')]) });
  const texto = JSON.stringify(r);
  assert.doesNotMatch(texto, /anulado_?por|anuladoPor|actor|cuentaId|clientOperationId|ClientOperationId|11111111|22222222|33333333|44444444/i);
  for (const id of ids(r)) assert.match(id, /^(animal_evento:\d+|pesaje:\d+(:anulacion)?|animal:\d+:registro)$/);
});

test('5B.8/9 fila repetida (reintento) no duplica REGISTRADO ni ANULADO', () => {
  const fila = anulado(ps(1, '2026-10-20', 360, '2026-10-21T13:15:00Z'), '2026-11-18T19:30:00Z', 'Duplicado');
  const r = tl({ pesajes: derivar([fila, fila]) });
  assert.deepEqual(ids(r), ['pesaje:1:anulacion', 'pesaje:1', 'animal:1:registro']);
});

test('5B.17 el timeline no altera los cálculos productivos (mismo historial antes y después)', () => {
  const filas = [ps(1, '2026-10-19', 350, '2026-10-20T01:00:00Z'), anulado(ps(2, '2026-10-20', 999, '2026-10-21T01:00:00Z'), '2026-10-22T01:00:00Z', 'x'), ps(3, '2026-10-21', 352, '2026-10-22T01:00:00Z')];
  const historial = derivar(filas);
  const copia = JSON.parse(JSON.stringify(historial));
  tl({ pesajes: historial });
  assert.deepEqual(historial, copia);
  const p3 = tl({ pesajes: historial }).eventos.find((e) => e.id === 'pesaje:3');
  assert.equal(p3.datos.diferenciaKg, 2, '352 frente a 350: el anulado (999) no interviene');
});

test('5B total/truncado: un anulado cuenta 2 eventos; límite exacto sin off-by-one', () => {
  const filas = [];
  for (let i = 1; i <= 24; i += 1) filas.push(ps(i, '2026-01-01', 300 + i, `2026-01-${String(i).padStart(2, '0')}T15:00:00Z`));
  filas.push(anulado(ps(25, '2026-01-01', 400, '2026-01-25T15:00:00Z'), '2026-01-26T15:00:00Z', 'x'));
  // 24 + 2 + registro del animal = 27 eventos.
  const base = { eventosAnimal: [ev(1, 'REGISTRADO', '2025-12-31T15:00:00Z')], pesajes: derivar(filas) };
  const exacto = tl({ ...base, limit: 27 });
  assert.deepEqual([exacto.total, exacto.eventos.length, exacto.truncado], [27, 27, false]);
  const corto = tl({ ...base, limit: 26 });
  assert.deepEqual([corto.total, corto.eventos.length, corto.truncado], [27, 26, true]);
  assert.equal(corto.eventos.at(-1).id, 'pesaje:1', 'queda fuera el más antiguo (registro del animal)');
  const dos = tl({ ...base, limit: 2 });
  assert.deepEqual(dos.eventos.map((e) => e.id), ['pesaje:25:anulacion', 'pesaje:25']);
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

// FASE 2A: salida y muerte (agx.animal_eventos SALIDO / MUERTO).
test('2A. salida: fecha EFECTIVA calendario, motivo en texto y observaciones seguras', () => {
  const salida = ev(10, 'SALIDO', '2026-10-21T15:00:00.000000Z', { fecha: '2026-10-19', motivo: 'VENTA', observaciones: 'Lote   3' });
  const r = tl({ eventosAnimal: [REGISTRO, salida] });
  const e = r.eventos.find((x) => x.tipo === 'ANIMAL_SALIDO');
  assert.deepEqual(e, {
    id: 'animal_evento:10', tipo: 'ANIMAL_SALIDO', titulo: 'Animal salió del hato',
    descripcion: 'Motivo: Venta. Observaciones: Lote 3',
    datos: { motivo: 'VENTA', observaciones: 'Lote 3', registradoEn: '2026-10-21T15:00:00.000000Z' },
    origen: 'animal_eventos', fechaHora: null, fecha: '2026-10-19', hora: null,
  });
  assert.equal(r.eventos[0].id, 'animal_evento:10');
});

test('2A. muerte: causa en texto, sin "nacido"; catálogo desconocido no se expone crudo', () => {
  const r = tl({ eventosAnimal: [REGISTRO, ev(11, 'MUERTO', '2026-10-21T15:00:00Z', { fecha: '2026-10-20', causa: 'SACRIFICIO' })] });
  const e = r.eventos.find((x) => x.tipo === 'ANIMAL_MUERTO');
  assert.equal(e.titulo, 'Animal muerto');
  assert.equal(e.descripcion, 'Causa: Sacrificio.');
  assert.deepEqual(e.datos, { causa: 'SACRIFICIO', observaciones: null, registradoEn: '2026-10-21T15:00:00Z' });
  const raro = tl({ eventosAnimal: [ev(12, 'MUERTO', '2026-10-21T15:00:00Z', { fecha: '2026-10-20', causa: '<script>' })] });
  const x = raro.eventos.find((y) => y.tipo === 'ANIMAL_MUERTO');
  assert.equal(x.descripcion, 'Sin detalle registrado.');
  assert.equal(x.datos.causa, null);
  assert.doesNotMatch(JSON.stringify(raro), /script/);
});

test('2A. el cierre precede a la revocación de chapeta que provoca (mismo instante y día)', () => {
  const instante = '2026-10-20T15:00:00.000000Z';
  const r = tl({
    eventosAnimal: [
      REGISTRO,
      ev(20, 'MUERTO', instante, { fecha: '2026-10-20', causa: 'ENFERMEDAD' }),
      ev(21, 'QR_REVOCADO', instante, { qrId: '5', codigoVisible: 'AGX-7KM4-P2XZ-R', causa: 'ANIMAL_MUERTO' }),
    ],
    pesajes: derivar([ps(1, '2026-10-20', 300, '2026-10-20T13:00:00Z')]),
  });
  assert.deepEqual(r.eventos.slice(0, 3).map((e) => e.tipo), ['ANIMAL_MUERTO', 'QR_DESASIGNADO', 'PESAJE_REGISTRADO']);
  const qr = r.eventos.find((e) => e.tipo === 'QR_DESASIGNADO');
  assert.equal(qr.descripcion, 'Chapeta AGX-7KM4-P2XZ-R revocada por muerte del animal.');
  assert.equal(qr.titulo, 'Chapeta QR dada de baja por muerte del animal', 'FASE 2B: hecho separado con título propio');
  assert.equal(r.eventos[0].titulo, 'Animal muerto');
  assert.equal(qr.datos.causa, 'ANIMAL_MUERTO');
  assert.doesNotMatch(JSON.stringify(r), /"qrId"|"5"/);
});

test('2A. salida con fecha efectiva anterior: se ordena por su fecha, la revocación por la de registro', () => {
  const r = tl({
    eventosAnimal: [
      REGISTRO,
      ev(30, 'SALIDO', '2026-10-21T15:00:00Z', { fecha: '2026-10-19', motivo: 'TRASLADO' }),
      ev(31, 'QR_REVOCADO', '2026-10-21T15:00:00Z', { codigoVisible: 'AGX-7KM4-P2XZ-R', causa: 'ANIMAL_SALIDO' }),
    ],
  });
  assert.deepEqual(r.eventos.map((e) => [e.tipo, e.fecha]), [
    ['QR_DESASIGNADO', '2026-10-21'], ['ANIMAL_SALIDO', '2026-10-19'], ['ANIMAL_REGISTRADO', '2026-10-18'],
  ]);
  assert.equal(r.eventos[0].titulo, 'Chapeta QR dada de baja por salida del animal');
  assert.equal(r.eventos[1].titulo, 'Animal salió del hato');
  assert.match(r.eventos[0].descripcion, /revocada por salida del animal\.$/);
  assert.equal(new Set(ids(r)).size, r.eventos.length, 'sin duplicados');
});
