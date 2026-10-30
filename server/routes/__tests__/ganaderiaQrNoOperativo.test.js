// FASE 2B: 410 QR_NO_OPERATIVO con vínculo histórico. animalId solo cuando
// el resolver (bajo RLS de la organización de la sesión) lo devolvió; sin
// sesión -> 401 sin ninguna pista; el acceso público no consulta la API.
// Mismo tenant / otro tenant contra Postgres real:
// server/services/__tests__/animalCierreIntegration.test.js (test 18).
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import express from 'express';

import { createGanaderiaQrRouter, sendResolution } from '../ganaderiaAnimalQr.js';
import { __resetAgxAuthPoolForTests } from '../../db/agxAuthPool.js';
import { __resetAgxBusinessPoolForTests } from '../../db/agxBusinessPool.js';
import { getConfig, __resetValidationStateForTests } from '../../config/env.js';
import { errorHandler, notFound } from '../../middleware/errors.js';

function capturar(resolved) {
  const out = {};
  sendResolution({ status(s) { out.status = s; return this; }, json(b) { out.body = b; } }, resolved);
  return out;
}

const CHAPETA = { qrId: '9', codigoVisible: 'AGX-7KM4-P2XZ-R', estado: 'REVOCADO', animalId: '7' };

before(() => {
  delete process.env.DATABASE_URL;
  delete process.env.AGX_BUSINESS_DATABASE_URL;
});

beforeEach(() => {
  __resetAgxAuthPoolForTests();
  __resetAgxBusinessPoolForTests();
  __resetValidationStateForTests();
  getConfig({ APP_ENV: 'development' }, {});
});

describe('FASE 2B: sendResolution NO_OPERATIVA', () => {
  test('misma organización (resolver con animalId) -> 410 con animalId', () => {
    assert.deepEqual(capturar({ resultado: 'NO_OPERATIVA', animalId: '7', chapeta: CHAPETA }), {
      status: 410, body: { error: 'QR_NO_OPERATIVO', estado: 'REVOCADO', animalId: '7' },
    });
  });

  test('sin animalId del resolver -> 410 SIN animalId aunque la chapeta lo traiga (nunca se filtra la fila cruda)', () => {
    const r = capturar({ resultado: 'NO_OPERATIVA', chapeta: CHAPETA });
    assert.deepEqual(r, { status: 410, body: { error: 'QR_NO_OPERATIVO', estado: 'REVOCADO' } });
    assert.equal(Object.hasOwn(r.body, 'animalId'), false);
  });

  test('otra organización (resolver null) -> 404 QR_NOT_FOUND idéntico, sin pista', () => {
    assert.deepEqual(capturar(null), { status: 404, body: { error: 'QR_NOT_FOUND' } });
  });
});

describe('FASE 2B: acceso sin sesión / público', () => {
  test('GET /api/ganaderia/qr/codigo|token sin sesión -> 401 sin animalId ni estado', async () => {
    const app = express();
    app.use('/api/ganaderia/qr', createGanaderiaQrRouter({ appEnv: 'development', csrfServerSecret: 'x'.repeat(44), allowedOrigins: ['https://agrogenomax.com'] }));
    app.use(notFound);
    app.use(errorHandler);
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    try {
      for (const ruta of ['/codigo/AGX-7KM4-P2XZ-R', '/token/abc']) {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/ganaderia/qr${ruta}`);
        const text = await response.text();
        assert.equal(response.status, 401, ruta);
        assert.doesNotMatch(text, /animalId|QR_NO_OPERATIVO|REVOCADO/);
      }
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('la página pública /qr/:codigo nunca consulta la API (solo redirige al resolver privado)', () => {
    const src = fs.readFileSync(new URL('../../../src/modules/ganaderia/hato/HatoQrEntradaPublica.jsx', import.meta.url), 'utf8');
    assert.doesNotMatch(src, /hatoApi|fetch\(|getJson/);
  });
});
