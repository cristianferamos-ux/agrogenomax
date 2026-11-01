// FASE 4A: validación de eventos reproductivos, hash de intención, máquina de
// estados derivada y su mapeo a la línea de tiempo (sin base de datos). La
// integración real (RLS, locks, idempotencia, anulación) vive en
// server/services/__tests__/reproduccionIntegration.test.js.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  CAMPOS_EVENTO,
  TIPOS_EVENTO_REPRODUCTIVO,
  validateAnularEventoReproductivoBody,
  validateCorregirEventoReproductivoBody,
  validateCrearEventoReproductivoBody,
} from '../reproduccionValidation.js';
import { computeReproduccionIntentHash } from '../reproduccionIntentHash.js';
import { derivarEstadoReproductivo, reglaRegistro } from '../reproduccionEstado.js';
import { construirTimelineAnimal } from '../timeline/timelineModelo.js';

const HOY = '2026-10-31';
const OPTS = { hoy: HOY, horaAhora: '10:30' };
const OP = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

const crear = (body) => validateCrearEventoReproductivoBody({ clientOperationId: OP, fechaEvento: '2026-10-01', ...body }, OPTS);
const codigo = (fn, code) => assert.throws(fn, (e) => e.code === code && e.status === 400);

const MINIMOS = Object.freeze({
  CELO_OBSERVADO: {},
  SERVICIO_MONTA: { tipoServicio: 'CONTROLADA' },
  INSEMINACION_ARTIFICIAL: {},
  IATF: {},
  TRANSFERENCIA_EMBRION: { embrionConservacion: 'FRESCO' },
  DIAGNOSTICO_PRENEZ: { diagnosticoResultado: 'PRENADA', diagnosticoMetodo: 'ECOGRAFIA' },
  ABORTO: {},
  PARTO: { partoTipo: 'NORMAL', numeroCrias: 1 },
});

describe('validación del POST de eventos', () => {
  test('los 8 tipos con sus campos mínimos', () => {
    assert.deepEqual(Object.keys(MINIMOS), [...TIPOS_EVENTO_REPRODUCTIVO]);
    for (const [tipoEvento, extra] of Object.entries(MINIMOS)) {
      const v = crear({ tipoEvento, ...extra });
      assert.equal(v.tipoEvento, tipoEvento);
      assert.equal(v.clientOperationId, OP);
      assert.deepEqual(Object.keys(v).filter((k) => k !== 'clientOperationId').sort(), [...CAMPOS_EVENTO].sort());
    }
  });

  test('caso PIDAR: TE de embrión fresco F1 Girolando con técnico y código', () => {
    const v = crear({
      tipoEvento: 'TRANSFERENCIA_EMBRION', embrionConservacion: 'FRESCO', embrionCodigo: ' EMB-0042 ',
      embrionRaza: 'F1   Girolando', tecnico: 'Técnico PIDAR', toroExterno: 'Gyr lechero', embrionCalidad: '1',
    });
    assert.equal(v.embrionCodigo, 'EMB-0042');
    assert.equal(v.embrionRaza, 'F1 Girolando');
    assert.equal(v.toroExterno, 'Gyr lechero');
  });

  test('tipo inválido, ausente o en minúsculas -> INVALID_TIPO_EVENTO', () => {
    for (const tipoEvento of [undefined, 'CELO', 'parto', 'VACUNACION', 7]) codigo(() => crear({ tipoEvento }), 'INVALID_TIPO_EVENTO');
  });

  test('un campo de otro tipo, organizacionId o rol -> FORBIDDEN_FIELDS', () => {
    codigo(() => crear({ tipoEvento: 'CELO_OBSERVADO', partoTipo: 'NORMAL' }), 'FORBIDDEN_FIELDS');
    codigo(() => crear({ tipoEvento: 'PARTO', partoTipo: 'NORMAL', numeroCrias: 1, embrionCodigo: 'X' }), 'FORBIDDEN_FIELDS');
    codigo(() => crear({ tipoEvento: 'ABORTO', organizacionId: 'x' }), 'FORBIDDEN_FIELDS');
    codigo(() => crear({ tipoEvento: 'ABORTO', rol: 'owner' }), 'FORBIDDEN_FIELDS');
    codigo(() => crear({ tipoEvento: 'ABORTO', animalId: '9' }), 'FORBIDDEN_FIELDS');
    codigo(() => crear({ tipoEvento: 'ABORTO', estadoRegistro: 'ANULADO' }), 'FORBIDDEN_FIELDS');
  });

  test('fechas: obligatoria, real, >= 1990, no futura', () => {
    codigo(() => crear({ tipoEvento: 'ABORTO', fechaEvento: undefined }), 'INVALID_FECHA');
    for (const fechaEvento of ['2026-02-30', '31/10/2026', '1989-12-31', '2026-11-01', 20261001]) {
      codigo(() => crear({ tipoEvento: 'ABORTO', fechaEvento }), 'INVALID_FECHA');
    }
    assert.equal(crear({ tipoEvento: 'ABORTO', fechaEvento: HOY }).fechaEvento, HOY);
  });

  test('hora: HH:MM y no futura el día de hoy', () => {
    assert.equal(crear({ tipoEvento: 'IATF', horaEvento: '23:59' }).horaEvento, '23:59');
    for (const horaEvento of ['24:00', '7:00', '07:00:00', 'mañana']) codigo(() => crear({ tipoEvento: 'IATF', horaEvento }), 'INVALID_HORA');
    codigo(() => crear({ tipoEvento: 'IATF', fechaEvento: HOY, horaEvento: '10:31' }), 'INVALID_HORA');
    assert.equal(crear({ tipoEvento: 'IATF', fechaEvento: HOY, horaEvento: '10:30' }).horaEvento, '10:30');
  });

  test('observaciones: máximo 500, vacías -> null', () => {
    assert.equal(crear({ tipoEvento: 'ABORTO', observaciones: '   ' }).observaciones, null);
    assert.equal(crear({ tipoEvento: 'ABORTO', observaciones: 'x'.repeat(500) }).observaciones.length, 500);
    codigo(() => crear({ tipoEvento: 'ABORTO', observaciones: 'x'.repeat(501) }), 'INVALID_OBSERVACIONES');
    codigo(() => crear({ tipoEvento: 'ABORTO', observaciones: 5 }), 'INVALID_OBSERVACIONES');
  });

  test('catálogos y obligatorios por tipo', () => {
    codigo(() => crear({ tipoEvento: 'SERVICIO_MONTA' }), 'INVALID_TIPO_SERVICIO');
    codigo(() => crear({ tipoEvento: 'CELO_OBSERVADO', intensidadCelo: 'EXTREMA' }), 'INVALID_INTENSIDAD_CELO');
    codigo(() => crear({ tipoEvento: 'TRANSFERENCIA_EMBRION' }), 'INVALID_EMBRION');
    codigo(() => crear({ tipoEvento: 'DIAGNOSTICO_PRENEZ', diagnosticoMetodo: 'PALPACION' }), 'INVALID_DIAGNOSTICO');
    codigo(() => crear({ tipoEvento: 'DIAGNOSTICO_PRENEZ', diagnosticoResultado: 'PRENADA', diagnosticoMetodo: 'RAYOS_X' }), 'INVALID_DIAGNOSTICO');
    codigo(() => crear({ tipoEvento: 'PARTO', partoTipo: 'NORMAL' }), 'INVALID_PARTO');
    codigo(() => crear({ tipoEvento: 'PARTO', partoTipo: 'NORMAL', numeroCrias: 5 }), 'INVALID_PARTO');
    codigo(() => crear({ tipoEvento: 'PARTO', partoTipo: 'NORMAL', numeroCrias: 1.5 }), 'INVALID_PARTO');
  });

  test('días de gestación: 1..300 y solo con diagnóstico PRENADA o aborto', () => {
    assert.equal(crear({ ...MINIMOS.DIAGNOSTICO_PRENEZ, tipoEvento: 'DIAGNOSTICO_PRENEZ', diasGestacion: 45 }).diasGestacion, 45);
    codigo(() => crear({ tipoEvento: 'DIAGNOSTICO_PRENEZ', diagnosticoResultado: 'VACIA', diagnosticoMetodo: 'PALPACION', diasGestacion: 40 }), 'INVALID_DIAS_GESTACION');
    codigo(() => crear({ tipoEvento: 'ABORTO', diasGestacion: 0 }), 'INVALID_DIAS_GESTACION');
    codigo(() => crear({ tipoEvento: 'ABORTO', diasGestacion: 301 }), 'INVALID_DIAS_GESTACION');
  });

  test('toroAnimalId: id positivo; textos con límite', () => {
    assert.equal(crear({ tipoEvento: 'INSEMINACION_ARTIFICIAL', toroAnimalId: 12 }).toroAnimalId, '12');
    codigo(() => crear({ tipoEvento: 'INSEMINACION_ARTIFICIAL', toroAnimalId: '-1' }), 'INVALID_TORO');
    codigo(() => crear({ tipoEvento: 'INSEMINACION_ARTIFICIAL', semenCodigo: 'x'.repeat(81) }), 'INVALID_SEMEN');
    codigo(() => crear({ tipoEvento: 'IATF', protocoloIatf: 'x'.repeat(121) }), 'INVALID_PROTOCOLO_IATF');
  });

  test('clientOperationId obligatorio y uuid; body no objeto', () => {
    codigo(() => validateCrearEventoReproductivoBody({ tipoEvento: 'ABORTO', fechaEvento: '2026-10-01' }, OPTS), 'INVALID_CLIENT_OPERATION_ID');
    codigo(() => validateCrearEventoReproductivoBody([], OPTS), 'INVALID_BODY');
  });

  test('anular: motivo obligatorio (<= 500) y sin campos extra', () => {
    assert.deepEqual(validateAnularEventoReproductivoBody({ clientOperationId: OP, motivo: ' error ' }), { clientOperationId: OP, motivo: 'error' });
    codigo(() => validateAnularEventoReproductivoBody({ clientOperationId: OP }), 'INVALID_MOTIVO');
    codigo(() => validateAnularEventoReproductivoBody({ clientOperationId: OP, motivo: 'x'.repeat(501) }), 'INVALID_MOTIVO');
    codigo(() => validateAnularEventoReproductivoBody({ clientOperationId: OP, motivo: 'x', organizacionId: 'y' }), 'FORBIDDEN_FIELDS');
  });

  test('corregir: motivo + evento tipado completo', () => {
    const v = validateCorregirEventoReproductivoBody({
      clientOperationId: OP, motivo: 'tipo equivocado', evento: { tipoEvento: 'IATF', fechaEvento: '2026-10-01' },
    }, OPTS);
    assert.equal(v.evento.tipoEvento, 'IATF');
    codigo(() => validateCorregirEventoReproductivoBody({ clientOperationId: OP, motivo: 'x' }, OPTS), 'INVALID_BODY');
    codigo(() => validateCorregirEventoReproductivoBody({ clientOperationId: OP, motivo: 'x', evento: { tipoEvento: 'NUEVO' } }, OPTS), 'INVALID_TIPO_EVENTO');
  });
});

describe('hash de intención v1', () => {
  test('determinístico, sensible al contenido y a la acción', () => {
    const { clientOperationId, ...a } = crear({ tipoEvento: 'ABORTO', observaciones: 'x' });
    assert.ok(clientOperationId);
    const h = computeReproduccionIntentHash(a);
    assert.match(h, /^v1:[0-9a-f]{64}$/);
    assert.equal(computeReproduccionIntentHash({ ...a }), h);
    assert.notEqual(computeReproduccionIntentHash({ ...a, observaciones: 'y' }), h);
    assert.notEqual(computeReproduccionIntentHash(a, { accion: 'CORRECCION', corrigeEventoId: '5', motivo: 'm' }), h);
    assert.notEqual(
      computeReproduccionIntentHash(a, { accion: 'CORRECCION', corrigeEventoId: '5', motivo: 'm' }),
      computeReproduccionIntentHash(a, { accion: 'CORRECCION', corrigeEventoId: '6', motivo: 'm' }),
    );
  });
});

let seq = 0;
function ev(tipoEvento, fechaEvento, extra = {}) {
  seq += 1;
  return { eventoId: String(seq), tipoEvento, fechaEvento, estadoRegistro: 'ACTIVO', ...extra };
}

describe('estado reproductivo derivado', () => {
  test('sin eventos -> SIN_ESTADO; macho -> NO_APLICA', () => {
    assert.equal(derivarEstadoReproductivo({ sexo: 'HEMBRA', eventos: [] }).estado, 'SIN_ESTADO');
    assert.equal(derivarEstadoReproductivo({ sexo: 'MACHO', eventos: [ev('CELO_OBSERVADO', '2026-01-01')] }).estado, 'NO_APLICA');
  });

  test('transiciones canónicas', () => {
    const casos = [
      [[ev('CELO_OBSERVADO', '2026-01-01')], 'CICLANDO'],
      ...['SERVICIO_MONTA', 'INSEMINACION_ARTIFICIAL', 'IATF', 'TRANSFERENCIA_EMBRION'].map((t) => [[ev(t, '2026-01-01')], 'SERVIDA']),
      [[ev('IATF', '2026-01-01'), ev('DIAGNOSTICO_PRENEZ', '2026-02-15', { diagnosticoResultado: 'PRENADA' })], 'PRENADA'],
      [[ev('IATF', '2026-01-01'), ev('DIAGNOSTICO_PRENEZ', '2026-02-15', { diagnosticoResultado: 'VACIA' })], 'VACIA'],
      [[ev('IATF', '2026-01-01'), ev('DIAGNOSTICO_PRENEZ', '2026-02-15', { diagnosticoResultado: 'DUDOSA' })], 'SERVIDA'],
      [[ev('DIAGNOSTICO_PRENEZ', '2026-02-15', { diagnosticoResultado: 'PRENADA' }), ev('ABORTO', '2026-04-01')], 'VACIA'],
      [[ev('DIAGNOSTICO_PRENEZ', '2026-02-15', { diagnosticoResultado: 'PRENADA' }), ev('PARTO', '2026-10-01')], 'POSPARTO'],
    ];
    for (const [eventos, esperado] of casos) {
      assert.equal(derivarEstadoReproductivo({ sexo: 'HEMBRA', eventos }).estado, esperado, eventos.map((e) => e.tipoEvento).join('>'));
    }
  });

  test('anulados no se pliegan: el estado se recalcula desde el historial válido', () => {
    const servicio = ev('IATF', '2026-01-01');
    const diag = ev('DIAGNOSTICO_PRENEZ', '2026-02-15', { diagnosticoResultado: 'PRENADA' });
    const parto = ev('PARTO', '2026-10-01');
    const base = [servicio, diag, parto];
    assert.equal(derivarEstadoReproductivo({ sexo: 'HEMBRA', eventos: base }).estado, 'POSPARTO');
    assert.equal(derivarEstadoReproductivo({ sexo: 'HEMBRA', eventos: [servicio, diag, { ...parto, estadoRegistro: 'ANULADO' }] }).estado, 'PRENADA');
    assert.equal(derivarEstadoReproductivo({ sexo: 'HEMBRA', eventos: [servicio, { ...diag, estadoRegistro: 'ANULADO' }] }).estado, 'SERVIDA');
    const e = derivarEstadoReproductivo({ sexo: 'HEMBRA', eventos: [{ ...servicio, estadoRegistro: 'ANULADO' }, diag, parto] });
    assert.equal(e.estado, 'POSPARTO');
    assert.equal(e.ultimoServicio, null);
    assert.equal(e.eventosActivos, 2);
  });

  test('orden por fecha y luego id (independiente del orden de entrada)', () => {
    const a = ev('DIAGNOSTICO_PRENEZ', '2026-03-01', { diagnosticoResultado: 'VACIA' });
    const b = ev('CELO_OBSERVADO', '2026-02-01');
    assert.equal(derivarEstadoReproductivo({ sexo: 'HEMBRA', eventos: [a, b] }).estado, 'VACIA');
  });

  test('gestación: por días del diagnóstico, por servicio y por TE (embrión día 7)', () => {
    const porDiag = derivarEstadoReproductivo({
      sexo: 'HEMBRA', hoy: '2026-03-01',
      eventos: [ev('DIAGNOSTICO_PRENEZ', '2026-02-01', { diagnosticoResultado: 'PRENADA', diasGestacion: 40 })],
    });
    assert.deepEqual(porDiag.gestacion, { base: 'DIAGNOSTICO', fechaConcepcionEstimada: '2025-12-23', diasEstimados: 68, fechaProbableParto: '2026-10-02' });
    const porTe = derivarEstadoReproductivo({
      sexo: 'HEMBRA', hoy: '2026-03-01',
      eventos: [ev('TRANSFERENCIA_EMBRION', '2026-01-08'), ev('DIAGNOSTICO_PRENEZ', '2026-02-10', { diagnosticoResultado: 'PRENADA' })],
    });
    assert.equal(porTe.gestacion.base, 'SERVICIO');
    assert.equal(porTe.gestacion.fechaConcepcionEstimada, '2026-01-01');
    assert.equal(porTe.gestacion.diasEstimados, 59);
    assert.equal(porTe.desde, '2026-02-10');
    const sinBase = derivarEstadoReproductivo({ sexo: 'HEMBRA', eventos: [ev('DIAGNOSTICO_PRENEZ', '2026-02-10', { diagnosticoResultado: 'PRENADA' })] });
    assert.equal(sinBase.gestacion, null);
    // Un servicio anterior al último parto no es base de la gestación actual.
    const viejo = derivarEstadoReproductivo({
      sexo: 'HEMBRA',
      eventos: [ev('IATF', '2025-01-01'), ev('PARTO', '2025-10-10', { numeroCrias: 1 }), ev('DIAGNOSTICO_PRENEZ', '2026-02-10', { diagnosticoResultado: 'PRENADA' })],
    });
    assert.equal(viejo.gestacion, null);
    assert.equal(viejo.ultimoParto.numeroCrias, 1);
  });

  test('reglas de registro (409) por estado', () => {
    for (const t of ['CELO_OBSERVADO', 'SERVICIO_MONTA', 'INSEMINACION_ARTIFICIAL', 'IATF', 'TRANSFERENCIA_EMBRION']) {
      assert.equal(reglaRegistro('PRENADA', t)?.code, 'EVENTO_NO_PERMITIDO_POR_ESTADO', t);
    }
    for (const estado of ['VACIA', 'POSPARTO']) {
      for (const t of ['PARTO', 'ABORTO']) assert.equal(reglaRegistro(estado, t)?.code, 'EVENTO_NO_PERMITIDO_POR_ESTADO');
    }
    for (const estado of ['SIN_ESTADO', 'CICLANDO', 'SERVIDA', 'PRENADA']) {
      assert.equal(reglaRegistro(estado, 'PARTO'), null, estado);
      assert.equal(reglaRegistro(estado, 'DIAGNOSTICO_PRENEZ'), null, estado);
    }
    assert.equal(reglaRegistro('POSPARTO', 'IATF'), null);
  });
});

describe('línea de tiempo: eventos reproductivos', () => {
  const animal = { animalId: '1', fechaCreacion: '2026-01-01T00:00:00.000Z' };
  test('mapeo de tipos, fecha efectiva, hora y anulados marcados', () => {
    const t = construirTimelineAnimal({
      animal,
      eventosReproductivos: [
        { eventoId: '1', tipoEvento: 'TRANSFERENCIA_EMBRION', fechaEvento: '2026-01-08', horaEvento: '08:15', estadoRegistro: 'ACTIVO',
          embrionConservacion: 'FRESCO', embrionCodigo: 'EMB-1', embrionRaza: 'F1 Girolando', detalle: { embrionConservacion: 'FRESCO' }, registradoEn: '2026-01-08T14:00:00.000000Z' },
        { eventoId: '2', tipoEvento: 'DIAGNOSTICO_PRENEZ', fechaEvento: '2026-02-10', horaEvento: null, estadoRegistro: 'ANULADO',
          diagnosticoResultado: 'PRENADA', diasGestacion: 40, anulacion: { motivo: 'fecha errada' }, detalle: {}, registradoEn: '2026-02-10T14:00:00.000000Z' },
        { eventoId: '3', tipoEvento: 'NO_EXISTE', fechaEvento: '2026-02-11', estadoRegistro: 'ACTIVO' },
      ],
    });
    const repro = t.eventos.filter((e) => e.origen === 'reproduccion_eventos');
    assert.deepEqual(repro.map((e) => e.tipo), ['PRENEZ', 'TRANSFERENCIA_EMBRION']);
    assert.equal(repro[0].titulo, 'Diagnóstico de preñez (anulado)');
    assert.match(repro[0].descripcion, /Preñada.*40 días.*Anulado: fecha errada/);
    assert.equal(repro[0].datos.estadoRegistro, 'ANULADO');
    assert.equal(repro[1].fecha, '2026-01-08');
    assert.equal(repro[1].hora, '08:15');
    assert.equal(repro[1].fechaHora, null);
    assert.match(repro[1].descripcion, /Embrión fresco EMB-1 \(F1 Girolando\)/);
    assert.ok(!JSON.stringify(t).includes('NO_EXISTE'));
  });
});
