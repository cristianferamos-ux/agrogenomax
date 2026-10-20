// FASE 1A: validación del body y derivaciones del historial de pesajes
// (sin base de datos). Las fórmulas vienen del motor canónico compartido
// shared/ganaderia/engine/pesajes.js -- aquí se comprueba el contrato de la API.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { MAX_OBSERVACIONES_PESAJE, validateCreatePesajeBody } from '../ganaderia/pesajeValidation.js';
import { construirHistorialPesajes } from '../ganaderia/pesajesService.js';
import * as motorFront from '../../../src/modules/ganaderia/engine/pesajes.js';
import * as motorShared from '../../../shared/ganaderia/engine/pesajes.js';

const HOY = '2025-06-15';
const OP = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≉ ${b}`);
const p = (pesajeId, fecha, pesoKg, extra = {}) => ({
  pesajeId: String(pesajeId), fecha, pesoKg, metodo: 'BASCULA', origen: 'MANUAL', observaciones: null, createdAt: '2025-06-15T12:00:00.000000Z', ...extra,
});

describe('validación del body', () => {
  test('cuerpo válido normalizado (clientOperationId en minúsculas, observaciones recortadas)', () => {
    assert.deepEqual(
      validateCreatePesajeBody({ fecha: '2025-06-15', pesoKg: 350.5, metodo: 'ESTIMADO', observaciones: '  ok  ', clientOperationId: OP.toUpperCase() }, { hoy: HOY }),
      { clientOperationId: OP, fecha: '2025-06-15', pesoKg: 350.5, metodo: 'ESTIMADO', observaciones: 'ok' },
    );
  });

  test('un decimal permitido; observaciones vacías -> null; hoy permitido; histórico permitido', () => {
    assert.equal(validateCreatePesajeBody({ fecha: HOY, pesoKg: 0.1, metodo: 'BASCULA', clientOperationId: OP }, { hoy: HOY }).pesoKg, 0.1);
    assert.equal(validateCreatePesajeBody({ fecha: '1990-01-01', pesoKg: 2000, metodo: 'BASCULA', clientOperationId: OP, observaciones: '   ' }, { hoy: HOY }).observaciones, null);
  });

  test('errores con su código', () => {
    const base = { fecha: HOY, pesoKg: 300, metodo: 'BASCULA', clientOperationId: OP };
    const err = (body) => {
      try {
        validateCreatePesajeBody(body, { hoy: HOY });
        return null;
      } catch (e) {
        return `${e.status}:${e.code}`;
      }
    };
    assert.equal(err({ ...base, pesoKg: 0 }), '400:INVALID_PESO');
    assert.equal(err({ ...base, pesoKg: -1 }), '400:INVALID_PESO');
    assert.equal(err({ ...base, pesoKg: 2001 }), '400:INVALID_PESO');
    assert.equal(err({ ...base, pesoKg: 300.25 }), '400:INVALID_PESO');
    assert.equal(err({ ...base, pesoKg: Number.NaN }), '400:INVALID_PESO');
    assert.equal(err({ ...base, metodo: 'bascula' }), '400:INVALID_METODO');
    assert.equal(err({ ...base, fecha: '2025-06-16' }), '400:INVALID_FECHA');
    assert.equal(err({ ...base, clientOperationId: '00000000-0000-0000-0000-000000000000' }), '400:INVALID_CLIENT_OPERATION_ID');
    assert.equal(err({ ...base, observaciones: 'x'.repeat(MAX_OBSERVACIONES_PESAJE + 1) }), '400:INVALID_OBSERVACIONES');
    assert.equal(err({ ...base, organizacionId: 'x' }), '400:FORBIDDEN_FIELDS');
    assert.equal(err(null), '400:INVALID_BODY');
  });
});

describe('historial derivado (motor canónico)', () => {
  test('orden ASCENDENTE (fecha, pesajeId) aunque el origen venga desordenado', () => {
    const h = construirHistorialPesajes({
      animalId: '7',
      pesajes: [p(3, '2025-03-01', 262.5), p(1, '2025-01-31', 240, { origen: 'REGISTRO_INICIAL' }), p(2, '2025-02-28', 250.1)],
    });
    assert.equal(h.orden, 'ASCENDENTE');
    assert.deepEqual(h.pesajes.map((x) => x.pesajeId), ['1', '2', '3']);
    assert.deepEqual(Object.keys(h.pesajes[0]), [
      'pesajeId', 'fecha', 'pesoKg', 'metodo', 'origen', 'observaciones', 'createdAt', 'diferenciaKg', 'diasDesdeAnterior', 'gmdKgDia',
    ]);
  });

  test('GMD positiva, negativa, cero; null sin anterior; null el mismo día (ambos se conservan)', () => {
    const h = construirHistorialPesajes({
      animalId: '7',
      pesajes: [
        p(1, '2025-01-01', 300),
        p(2, '2025-01-11', 310),
        p(3, '2025-01-21', 305),
        p(4, '2025-01-31', 305),
        p(5, '2025-01-31', 306),
      ],
    });
    const g = h.pesajes.map((x) => x.gmdKgDia);
    assert.equal(g[0], null);
    close(g[1], 1);
    close(g[2], -0.5);
    assert.equal(g[3], 0);
    assert.equal(g[4], null);
    assert.equal(h.pesajes[4].diasDesdeAnterior, 0);
    assert.equal(h.pesajes[4].diferenciaKg, 1);
    assert.equal(h.pesajes.length, 5);
  });

  test('resumen independiente del orden y ganancia acumulada desde el PRIMER PESO REGISTRADO', () => {
    const h = construirHistorialPesajes({ animalId: '7', pesajes: [p(2, '2025-04-11', 260), p(1, '2025-01-01', 200)] });
    assert.deepEqual(
      { ...h.resumen, gmdKgDia: null, gananciaAcumulada: { ...h.resumen.gananciaAcumulada, gmdPromedioKgDia: null } },
      {
        totalPesajes: 2,
        ultimoPesoKg: 260,
        fechaUltimoPeso: '2025-04-11',
        metodoUltimoPeso: 'BASCULA',
        pesoAnteriorKg: 200,
        diferenciaKg: 60,
        diasDesdeAnterior: 100,
        gmdKgDia: null,
        gananciaAcumulada: {
          primerPesoRegistradoKg: 200,
          fechaPrimerPesoRegistrado: '2025-01-01',
          ultimoPesoKg: 260,
          gananciaKg: 60,
          dias: 100,
          gmdPromedioKgDia: null,
        },
      },
    );
    close(h.resumen.gmdKgDia, 0.6);
    close(h.resumen.gananciaAcumulada.gmdPromedioKgDia, 0.6);
    assert.equal(JSON.stringify(h).includes('nacimiento'), false);
  });

  test('sin pesajes / un pesaje: resumen con nulls, sin ganancia acumulada', () => {
    const vacio = construirHistorialPesajes({ animalId: '7', pesajes: [] });
    assert.equal(vacio.resumen.ultimoPesoKg, null);
    assert.equal(vacio.resumen.gananciaAcumulada, null);
    assert.deepEqual(vacio.pesajes, []);
    const uno = construirHistorialPesajes({ animalId: '7', pesajes: [p(1, '2025-01-01', 200)] });
    assert.equal(uno.resumen.ultimoPesoKg, 200);
    assert.equal(uno.resumen.pesoAnteriorKg, null);
    assert.equal(uno.resumen.gmdKgDia, null);
    assert.equal(uno.resumen.gananciaAcumulada, null);
  });

  test('sin redondeo interno (precisión completa)', () => {
    const h = construirHistorialPesajes({ animalId: '7', pesajes: [p(1, '2025-01-01', 100), p(2, '2025-01-04', 100.1)] });
    close(h.pesajes[1].gmdKgDia, 0.1 / 3);
    assert.notEqual(h.pesajes[1].gmdKgDia, 0.03);
  });
});

describe('una sola fórmula para backend y frontend', () => {
  test('src/.../engine/pesajes.js reexporta el motor canónico de shared/', () => {
    assert.equal(motorFront.calcularGMD, motorShared.calcularGMD);
    assert.equal(motorFront.enriquecerPesajes, motorShared.enriquecerPesajes);
  });

  test('el backend no reimplementa la GMD ni accede a legacy/animal_eventos/animales para escribir', () => {
    const service = fs.readFileSync(new URL('../ganaderia/pesajesService.js', import.meta.url), 'utf8');
    const sinComentarios = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const repo = sinComentarios(fs.readFileSync(new URL('../ganaderia/pesajesRepository.js', import.meta.url), 'utf8'));
    // Copia byte a byte de shared/ (paridad en ganaderiaEngineParidad.test.js).
    assert.match(service, /from '\.\/engine\/pesajes\.js'/);
    assert.doesNotMatch(service + repo, /\/\s*dias|\(peso.*-.*\)\s*\//);
    assert.doesNotMatch(repo, /db\.js|update agx\.|delete from|insert into agx\.animal_eventos|insert into agx\.animales/i);
  });
});
