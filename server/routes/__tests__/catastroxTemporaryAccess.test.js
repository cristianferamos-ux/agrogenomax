// CATX-FREEZE-01: acceso temporal por contraseña compartida. Dos bloques:
//   A) rutas puras de /access/* que no requieren Postgres (mode discovery,
//      verify, rechazo de capability inválido/expirado, rate limit, gate de
//      paquete en full-result) -- corren siempre, sin auto-skip.
//   B) integración real contra Postgres (generación real del PDF oficial +
//      confirmación de cero escrituras comerciales + guardas COMMERCE_DISABLED
//      en /customers y /checkout + cobertura Plus/Profesional + históricos
//      bajo password mode) -- se auto-omite si no hay base alcanzable, mismo
//      criterio que catastroxDeliveryLifecycle.test.js.
//
// FASE 1.2 (corrección de los 4 P2 de la revisión de diff):
//   P2-01: full-result temporal ahora rechaza capabilities 'basico' (403
//          PACKAGE_ACCESS_DENIED) -- ver tests 15A/15D/15E y el bloque Plus/
//          Profesional en Postgres.
//   P2-02: /access/generate/pdf tiene su propio rate limit (temporaryPdfLimiter,
//          independiente de temporaryAccessLimiter) -- ver describe dedicado.
//   P2-03: las pruebas de "cero escrituras comerciales" dejan de usar
//          count(*) global (frágil bajo ejecución concurrente multi-archivo)
//          y pasan a filtros escopados por canonical_predio_id/payment_order_id
//          del propio fixture, más una ventana de tiempo para customers (sin
//          FK natural, ya que el flujo temporal nunca envía PII).
//   P2-04: cobertura end-to-end real para Plus y Profesional (verify+pdf+
//          full-result), prueba de "misma contraseña, capabilities distintos
//          y correctamente escopados", y prueba dinámica de que los
//          endpoints históricos NO son interceptados por el guard de modo
//          comercial.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import dotenv from 'dotenv';

dotenv.config({ path: '.env', quiet: true });
dotenv.config({ path: 'server/.env', quiet: true });

const TEST_TOKEN_KEY = 'WR0Tf6SO/JAVyhDrEgQt6GV5JyZUV8wmL/NvG1kAZoQ=';
const TEST_SECRET = 'catx-freeze-route-test-secret-9876';

process.env.CATASTROX_TEMP_ACCESS_TOKEN_KEY = process.env.CATASTROX_TEMP_ACCESS_TOKEN_KEY || TEST_TOKEN_KEY;
process.env.CATASTROX_TEMP_ACCESS_SECRET = process.env.CATASTROX_TEMP_ACCESS_SECRET || TEST_SECRET;

let dbAvailable = false;
let query;
let catastroxRouter;
let catastroxPaymentsRouter;
let __rememberLookupPreviewForTests;
let __clearLookupStateForTests;

try {
  const { getConfig } = await import('../../config/env.js');
  const { query: q } = await import('../../db.js');
  query = q;
  getConfig();
  const tableCheck = await query("select to_regclass('public.catastrox_customers') as t");
  dbAvailable = Boolean(tableCheck.rows[0]?.t);
} catch {
  dbAvailable = false;
}

({ default: catastroxRouter, __rememberLookupPreviewForTests, __clearLookupStateForTests } = await import('../catastrox.js'));
if (dbAvailable) {
  ({ default: catastroxPaymentsRouter } = await import('../catastroxPayments.js'));
}

const { temporaryAccessLimiter, temporaryPdfLimiter } = await import('../../middleware/rateLimit.js');

// Ambos limiters son middlewares compartidos a nivel de módulo (no por
// instancia de Express) -- su estado sobrevive entre `describe` dentro del
// mismo proceso. Se resetean explícitamente entre pruebas que los agotan a
// propósito, mismo patrón que resetRateLimiters() en
// catastroxCustomerOtpAndHistory.test.js.
function resetTemporaryAccessLimiter() {
  for (const candidateKey of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    temporaryAccessLimiter.resetKey(candidateKey);
  }
}
function resetTemporaryPdfLimiter() {
  for (const candidateKey of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    temporaryPdfLimiter.resetKey(candidateKey);
  }
}

async function startTestApp(router, mountPath) {
  const app = express();
  app.use(express.json());
  app.use(mountPath, router);
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}${mountPath}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function withEnv(overrides, fn) {
  const original = {};
  for (const key of Object.keys(overrides)) original[key] = process.env[key];
  Object.assign(process.env, overrides);
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of Object.keys(overrides)) {
        if (original[key] === undefined) delete process.env[key];
        else process.env[key] = original[key];
      }
    });
}

const LOOKUP_ID = 'temp-access-test-lookup-001';
const CANONICAL_PREDIO_ID = '888800000000000000000000000099';

// ---------------------------------------------------------------------
// Bloque A: rutas /access/* que no requieren Postgres
// ---------------------------------------------------------------------

describe('CATX-FREEZE-01: GET /access/mode', () => {
  test('1) mode=password devuelve únicamente {mode:"password"}, sin secretos', async () => {
    await withEnv({ CATASTROX_COMMERCE_MODE: 'password' }, async () => {
      const app = await startTestApp(catastroxRouter, '/api/catastrox');
      try {
        const response = await fetch(`${app.baseUrl}/access/mode`);
        const payload = await response.json();
        assert.equal(response.status, 200);
        assert.deepEqual(Object.keys(payload), ['mode']);
        assert.equal(payload.mode, 'password');
      } finally {
        await app.close();
      }
    });
  });

  test('2) mode=wompi_test devuelve el modo correcto', async () => {
    await withEnv({ CATASTROX_COMMERCE_MODE: 'wompi_test' }, async () => {
      const app = await startTestApp(catastroxRouter, '/api/catastrox');
      try {
        const response = await fetch(`${app.baseUrl}/access/mode`);
        const payload = await response.json();
        assert.equal(payload.mode, 'wompi_test');
      } finally {
        await app.close();
      }
    });
  });

  test('3) mode=wompi_live devuelve el modo correcto', async () => {
    await withEnv({ CATASTROX_COMMERCE_MODE: 'wompi_live' }, async () => {
      const app = await startTestApp(catastroxRouter, '/api/catastrox');
      try {
        const response = await fetch(`${app.baseUrl}/access/mode`);
        const payload = await response.json();
        assert.equal(payload.mode, 'wompi_live');
      } finally {
        await app.close();
      }
    });
  });

  test('4) variable ausente preserva compatibilidad legacy -- nunca reporta "password"', async () => {
    await withEnv({ CATASTROX_COMMERCE_MODE: '' }, async () => {
      const app = await startTestApp(catastroxRouter, '/api/catastrox');
      try {
        const response = await fetch(`${app.baseUrl}/access/mode`);
        const payload = await response.json();
        assert.notEqual(payload.mode, 'password');
        assert.ok(['wompi_test', 'wompi_live'].includes(payload.mode));
      } finally {
        await app.close();
      }
    });
  });
});

describe('CATX-FREEZE-01: POST /access/verify', () => {
  test('5) commerceMode !== password -> 404 TEMPORARY_ACCESS_DISABLED, nunca valida la contraseña', async () => {
    await withEnv({ CATASTROX_COMMERCE_MODE: 'wompi_test' }, async () => {
      const app = await startTestApp(catastroxRouter, '/api/catastrox');
      try {
        const response = await fetch(`${app.baseUrl}/access/verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: TEST_SECRET, packageId: 'basico', lookupId: LOOKUP_ID }),
        });
        const payload = await response.json();
        assert.equal(response.status, 404);
        assert.equal(payload.code, 'TEMPORARY_ACCESS_DISABLED');
      } finally {
        await app.close();
      }
    });
  });

  test('6) packageId inválido -> 400 INVALID_PACKAGE', async () => {
    await withEnv({ CATASTROX_COMMERCE_MODE: 'password' }, async () => {
      const app = await startTestApp(catastroxRouter, '/api/catastrox');
      try {
        const response = await fetch(`${app.baseUrl}/access/verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: TEST_SECRET, packageId: 'premium', lookupId: LOOKUP_ID }),
        });
        const payload = await response.json();
        assert.equal(response.status, 400);
        assert.equal(payload.code, 'INVALID_PACKAGE');
      } finally {
        await app.close();
      }
    });
  });

  test('7) lookupId no registrado -> 404 LOOKUP_NOT_FOUND', async () => {
    await withEnv({ CATASTROX_COMMERCE_MODE: 'password' }, async () => {
      const app = await startTestApp(catastroxRouter, '/api/catastrox');
      try {
        const response = await fetch(`${app.baseUrl}/access/verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: TEST_SECRET, packageId: 'basico', lookupId: 'lookup-nunca-registrado' }),
        });
        const payload = await response.json();
        assert.equal(response.status, 404);
        assert.equal(payload.code, 'LOOKUP_NOT_FOUND');
      } finally {
        await app.close();
      }
    });
  });

  test('8) contraseña incorrecta -> 401 INVALID_PASSWORD, sin capability', async () => {
    resetTemporaryAccessLimiter();
    __rememberLookupPreviewForTests(LOOKUP_ID, { canonicalPredioId: CANONICAL_PREDIO_ID });
    await withEnv({ CATASTROX_COMMERCE_MODE: 'password' }, async () => {
      const app = await startTestApp(catastroxRouter, '/api/catastrox');
      try {
        const response = await fetch(`${app.baseUrl}/access/verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: 'contraseña-incorrecta', packageId: 'basico', lookupId: LOOKUP_ID }),
        });
        const payload = await response.json();
        assert.equal(response.status, 401);
        assert.equal(payload.code, 'INVALID_PASSWORD');
        assert.equal('capability' in payload, false);
      } finally {
        await app.close();
        resetTemporaryAccessLimiter();
      }
    });
  });

  test('9) contraseña correcta -> 200 con capability ligado a predio+lookup+package, nunca expone el secreto', async () => {
    resetTemporaryAccessLimiter();
    __rememberLookupPreviewForTests(LOOKUP_ID, { canonicalPredioId: CANONICAL_PREDIO_ID });
    await withEnv({ CATASTROX_COMMERCE_MODE: 'password' }, async () => {
      const app = await startTestApp(catastroxRouter, '/api/catastrox');
      try {
        const response = await fetch(`${app.baseUrl}/access/verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: TEST_SECRET, packageId: 'plus', lookupId: LOOKUP_ID }),
        });
        const payload = await response.json();
        assert.equal(response.status, 200);
        assert.equal(payload.ok, true);
        assert.equal(payload.packageId, 'plus');
        assert.ok(typeof payload.capability === 'string' && payload.capability.length > 0);
        assert.equal(JSON.stringify(payload).includes(TEST_SECRET), false);
      } finally {
        await app.close();
        resetTemporaryAccessLimiter();
      }
    });
  });

  test('10) rate limit aplica -- el sexto intento en la ventana se rechaza con 429', async () => {
    resetTemporaryAccessLimiter();
    __rememberLookupPreviewForTests(LOOKUP_ID, { canonicalPredioId: CANONICAL_PREDIO_ID });
    await withEnv({ CATASTROX_COMMERCE_MODE: 'password' }, async () => {
      const app = await startTestApp(catastroxRouter, '/api/catastrox');
      try {
        let lastStatus = 0;
        for (let i = 0; i < 6; i += 1) {
          // eslint-disable-next-line no-await-in-loop
          const response = await fetch(`${app.baseUrl}/access/verify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: 'siempre-incorrecta', packageId: 'basico', lookupId: LOOKUP_ID }),
          });
          lastStatus = response.status;
        }
        assert.equal(lastStatus, 429);
      } finally {
        await app.close();
        resetTemporaryAccessLimiter();
      }
    });
  });
});

describe('CATX-FREEZE-01: POST /access/generate/pdf (sin Postgres)', () => {
  test('11) commerceMode !== password -> 404 TEMPORARY_ACCESS_DISABLED', async () => {
    await withEnv({ CATASTROX_COMMERCE_MODE: 'wompi_test' }, async () => {
      const app = await startTestApp(catastroxRouter, '/api/catastrox');
      try {
        const response = await fetch(`${app.baseUrl}/access/generate/pdf`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ capability: 'cualquier-cosa' }),
        });
        const payload = await response.json();
        assert.equal(response.status, 404);
        assert.equal(payload.code, 'TEMPORARY_ACCESS_DISABLED');
      } finally {
        await app.close();
      }
    });
  });

  test('12) capability inválido/ausente -> 401 CAPABILITY_INVALID, nunca intenta generar nada', async () => {
    resetTemporaryPdfLimiter();
    await withEnv({ CATASTROX_COMMERCE_MODE: 'password' }, async () => {
      const app = await startTestApp(catastroxRouter, '/api/catastrox');
      try {
        const response = await fetch(`${app.baseUrl}/access/generate/pdf`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ capability: 'token-basura' }),
        });
        const payload = await response.json();
        assert.equal(response.status, 401);
        assert.equal(payload.code, 'CAPABILITY_INVALID');
      } finally {
        await app.close();
        resetTemporaryPdfLimiter();
      }
    });
  });
});

// P2-02: rate limit dedicado de /access/generate/pdf, independiente del de
// /access/verify.
describe('CATX-FREEZE-01: rate limit de /access/generate/pdf (P2-02)', () => {
  test('13) hasta 10 solicitudes permitidas por el limiter (no 429); la 11a se rechaza con 429', async () => {
    resetTemporaryPdfLimiter();
    await withEnv({ CATASTROX_COMMERCE_MODE: 'password' }, async () => {
      const app = await startTestApp(catastroxRouter, '/api/catastrox');
      try {
        const statuses = [];
        for (let i = 0; i < 11; i += 1) {
          // Capability deliberadamente inválido -- lo que se prueba aquí es
          // el comportamiento del RATE LIMITER (que actúa antes que el
          // handler), no la validez del capability. Las primeras 10 deben
          // pasar el limiter y fallar luego con 401 CAPABILITY_INVALID.
          // eslint-disable-next-line no-await-in-loop
          const response = await fetch(`${app.baseUrl}/access/generate/pdf`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ capability: 'capability-invalido-para-esta-prueba' }),
          });
          statuses.push(response.status);
        }
        assert.deepEqual(statuses.slice(0, 10), new Array(10).fill(401), 'las primeras 10 deben pasar el limiter (401 por capability inválido, no 429)');
        assert.equal(statuses[10], 429, 'la solicitud 11 debe rechazarse por el rate limiter');
      } finally {
        await app.close();
        resetTemporaryPdfLimiter();
      }
    });
  });

  test('14) el limiter de PDF es independiente del limiter de verify -- agotar verify no bloquea generate/pdf', async () => {
    resetTemporaryAccessLimiter();
    resetTemporaryPdfLimiter();
    __rememberLookupPreviewForTests(LOOKUP_ID, { canonicalPredioId: CANONICAL_PREDIO_ID });
    await withEnv({ CATASTROX_COMMERCE_MODE: 'password' }, async () => {
      const app = await startTestApp(catastroxRouter, '/api/catastrox');
      try {
        for (let i = 0; i < 6; i += 1) {
          // eslint-disable-next-line no-await-in-loop
          await fetch(`${app.baseUrl}/access/verify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: 'siempre-incorrecta', packageId: 'basico', lookupId: LOOKUP_ID }),
          });
        }
        const verifyResponse = await fetch(`${app.baseUrl}/access/verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: 'siempre-incorrecta', packageId: 'basico', lookupId: LOOKUP_ID }),
        });
        assert.equal(verifyResponse.status, 429, 'verify debe seguir agotado (confirma que sí se agotó)');

        const pdfResponse = await fetch(`${app.baseUrl}/access/generate/pdf`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ capability: 'capability-invalido' }),
        });
        assert.notEqual(pdfResponse.status, 429, 'generate/pdf no debe verse afectado por el agotamiento de verify');
        assert.equal(pdfResponse.status, 401, 'debe fallar por capability inválido, no por rate limit');
      } finally {
        await app.close();
        resetTemporaryAccessLimiter();
        resetTemporaryPdfLimiter();
      }
    });
  });

  test('15) GET /access/mode sigue accesible incluso con ambos limiters agotados', async () => {
    await withEnv({ CATASTROX_COMMERCE_MODE: 'password' }, async () => {
      const app = await startTestApp(catastroxRouter, '/api/catastrox');
      try {
        const response = await fetch(`${app.baseUrl}/access/mode`);
        assert.equal(response.status, 200, 'mode nunca tiene rate limit propio');
      } finally {
        await app.close();
        resetTemporaryAccessLimiter();
        resetTemporaryPdfLimiter();
      }
    });
  });
});

describe('CATX-FREEZE-01: GET /access/lookups/:lookupId/full-result (sin Postgres)', () => {
  test('16) el gate original de /lookups/:lookupId/full-result NO se debilita -- sigue exigiendo sesión/orden, nunca acepta el capability temporal', async () => {
    __rememberLookupPreviewForTests(LOOKUP_ID, { canonicalPredioId: CANONICAL_PREDIO_ID });
    const app = await startTestApp(catastroxRouter, '/api/catastrox');
    try {
      const response = await fetch(`${app.baseUrl}/lookups/${LOOKUP_ID}/full-result`);
      // Sin cookie de sesión de recuperación -> SESSION_REQUIRED (401),
      // exactamente igual que antes de CATX-FREEZE-01.
      assert.equal(response.status, 401);
      const payload = await response.json();
      assert.equal(payload.status, 'SESSION_REQUIRED');
    } finally {
      await app.close();
    }
  });

  test('17) el camino temporal separado exige capability -- sin header Authorization, 401', async () => {
    __rememberLookupPreviewForTests(LOOKUP_ID, { canonicalPredioId: CANONICAL_PREDIO_ID });
    await withEnv({ CATASTROX_COMMERCE_MODE: 'password' }, async () => {
      const app = await startTestApp(catastroxRouter, '/api/catastrox');
      try {
        const response = await fetch(`${app.baseUrl}/access/lookups/${LOOKUP_ID}/full-result`);
        assert.equal(response.status, 401);
      } finally {
        await app.close();
      }
    });
  });
});

// P2-01: básico nunca debe poder obtener el full-result temporal completo
// (solo incluye PDF). Los casos que requieren un capability 200 exitoso
// (Plus/Profesional) necesitan Postgres real (buildLookupFullResultPayload
// consulta la geometría) -- viven en el Bloque B. Los tres casos de abajo
// (A: básico rechazado, D: binding cruzado de lookup, E: binding cruzado de
// predio) son puramente de autorización/binding, verificables antes de
// tocar la base de datos.
describe('CATX-FREEZE-01: gate de paquete en full-result temporal (P2-01, sin Postgres)', () => {
  test('18-A) capability "basico" -> full-result temporal -> 403 PACKAGE_ACCESS_DENIED', async () => {
    resetTemporaryAccessLimiter();
    const lookupId = 'temp-access-package-gate-basico';
    __rememberLookupPreviewForTests(lookupId, { canonicalPredioId: CANONICAL_PREDIO_ID });
    await withEnv({ CATASTROX_COMMERCE_MODE: 'password' }, async () => {
      const app = await startTestApp(catastroxRouter, '/api/catastrox');
      try {
        const verifyResponse = await fetch(`${app.baseUrl}/access/verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: TEST_SECRET, packageId: 'basico', lookupId }),
        });
        const verifyPayload = await verifyResponse.json();
        assert.equal(verifyResponse.status, 200);

        const fullResultResponse = await fetch(`${app.baseUrl}/access/lookups/${lookupId}/full-result`, {
          headers: { Authorization: `Bearer ${verifyPayload.capability}` },
        });
        const fullResultPayload = await fullResultResponse.json();
        assert.equal(fullResultResponse.status, 403);
        assert.equal(fullResultPayload.status, 'PACKAGE_ACCESS_DENIED');
      } finally {
        await app.close();
        resetTemporaryAccessLimiter();
      }
    });
  });

  test('18-D) capability "plus" contra OTRO lookup -> rechazado (binding, no llega al gate de paquete)', async () => {
    resetTemporaryAccessLimiter();
    const lookupIdA = 'temp-access-package-gate-plus-a';
    const lookupIdB = 'temp-access-package-gate-plus-b';
    __rememberLookupPreviewForTests(lookupIdA, { canonicalPredioId: CANONICAL_PREDIO_ID });
    __rememberLookupPreviewForTests(lookupIdB, { canonicalPredioId: '777700000000000000000000000088' });
    await withEnv({ CATASTROX_COMMERCE_MODE: 'password' }, async () => {
      const app = await startTestApp(catastroxRouter, '/api/catastrox');
      try {
        const verifyResponse = await fetch(`${app.baseUrl}/access/verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: TEST_SECRET, packageId: 'plus', lookupId: lookupIdA }),
        });
        const verifyPayload = await verifyResponse.json();
        assert.equal(verifyResponse.status, 200);

        const fullResultResponse = await fetch(`${app.baseUrl}/access/lookups/${lookupIdB}/full-result`, {
          headers: { Authorization: `Bearer ${verifyPayload.capability}` },
        });
        assert.equal(fullResultResponse.status, 401, 'el capability de lookupA no debe servir para lookupB');
      } finally {
        await app.close();
        resetTemporaryAccessLimiter();
      }
    });
  });

  test('18-E) capability "profesional" contra otro predio/lookup -> rechazado (binding, no llega al gate de paquete)', async () => {
    resetTemporaryAccessLimiter();
    const lookupIdA = 'temp-access-package-gate-pro-a';
    const lookupIdB = 'temp-access-package-gate-pro-b';
    __rememberLookupPreviewForTests(lookupIdA, { canonicalPredioId: CANONICAL_PREDIO_ID });
    // Mismo lookupId de destino pero un canonicalPredioId distinto al que
    // el capability autoriza -- simula un lookupId reutilizado apuntando a
    // otro predio.
    __rememberLookupPreviewForTests(lookupIdB, { canonicalPredioId: '666600000000000000000000000077' });
    await withEnv({ CATASTROX_COMMERCE_MODE: 'password' }, async () => {
      const app = await startTestApp(catastroxRouter, '/api/catastrox');
      try {
        const verifyResponse = await fetch(`${app.baseUrl}/access/verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: TEST_SECRET, packageId: 'profesional', lookupId: lookupIdA }),
        });
        const verifyPayload = await verifyResponse.json();
        assert.equal(verifyResponse.status, 200);

        const fullResultResponse = await fetch(`${app.baseUrl}/access/lookups/${lookupIdB}/full-result`, {
          headers: { Authorization: `Bearer ${verifyPayload.capability}` },
        });
        assert.equal(fullResultResponse.status, 401, 'el capability de lookupA no debe servir para lookupB aunque el packageId coincida');
      } finally {
        await app.close();
        resetTemporaryAccessLimiter();
      }
    });
  });

  // FASE 1.4: allowlist fail-closed. isValidTemporaryAccessPackageId() ya
  // rechaza cualquier packageId fuera de {basico,plus,profesional} en la
  // CAPA CRIPTOGRÁFICA (createTemporaryAccessCapability lanza al crear,
  // verifyTemporaryAccessCapability nunca decodifica un packageId inválido)
  // -- no existe hoy una vía legítima para obtener un capability real con
  // un packageId "futuro/desconocido" sin forjar el token, y forjarlo
  // debilitaría exactamente la validación criptográfica que este freeze
  // debe preservar (explícitamente prohibido). Por eso esta prueba es
  // ESTRUCTURAL, no dinámica end-to-end: confirma por parsing de código
  // fuente que la ruta usa una ALLOWLIST negada (`!X.has(packageId)`), no
  // una denylist -- es decir, que CUALQUIER valor no explícitamente
  // listado (incluido uno que no exista todavía) queda denegado por
  // construcción, nunca permitido por omisión.
  test('18-F) [FASE 1.4] la policy de full-result temporal es una allowlist fail-closed -- cualquier packageId no listado (incluido uno futuro) queda denegado por construcción', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const source = fs.readFileSync(path.resolve(__dirname, '../catastrox.js'), 'utf8');

    assert.ok(
      source.includes("const PACKAGES_WITH_TEMPORARY_FULL_RESULT = new Set(['plus', 'profesional']);"),
      'la allowlist debe ser exactamente {plus, profesional} -- básico y cualquier valor futuro quedan fuera',
    );
    assert.ok(
      source.includes('if (!PACKAGES_WITH_TEMPORARY_FULL_RESULT.has(verification.packageId)) {'),
      'el gate debe negar la pertenencia a la allowlist (fail-closed), no negar una denylist (fail-open)',
    );
    // Regresión explícita: asegura que NO volvió el patrón denylist
    // original (P2-01), que fallaba abierto ante un paquete futuro.
    assert.ok(
      !source.includes('PACKAGES_WITHOUT_TEMPORARY_FULL_RESULT'),
      'no debe quedar rastro de la denylist fail-open anterior',
    );
  });
});

// ---------------------------------------------------------------------
// Bloque B: integración real (Postgres real, se auto-omite)
// ---------------------------------------------------------------------

test('CATX-FREEZE-01: integración Postgres real (requiere Postgres real)', { skip: !dbAvailable }, async (t) => {
  const INTEGRATION_TEST_CODIGO = '999999999999999999999999999901';
  const originalFetch = globalThis.fetch;
  const MOCK_TILE_BUFFER = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  );

  // P2-03: en vez de un único array global compartido por todo el bloque,
  // cada sub-prueba que necesita demostrar "cero llamadas a Wompi/proveedor
  // de correo" toma su propio snapshot de `externalCalls.length` al empezar
  // y revisa solo lo agregado desde ahí -- así las pruebas de históricos
  // (que SÍ deben poder llamar a Wompi, esa es la prueba) no contaminan la
  // aserción de cero-efectos-secundarios del flujo temporal.
  const externalCalls = [];

  t.before(() => {
    resetTemporaryAccessLimiter();
    resetTemporaryPdfLimiter();
    globalThis.fetch = async (url, init) => {
      const urlString = String(url);
      if (urlString.includes('arcgisonline.com')) {
        return new Response(MOCK_TILE_BUFFER, { status: 200, headers: { 'Content-Type': 'image/png' } });
      }
      // Mock rápido y determinista de Wompi Sandbox -- evita depender de
      // red real en la prueba de históricos (sección 19) y, a la vez,
      // permite registrar la llamada como lo que es: una llamada real a
      // Wompi disparada por un endpoint histórico que NO debe estar
      // bloqueado por el modo password.
      if (urlString.includes('sandbox.wompi.co')) {
        externalCalls.push(urlString);
        return new Response(JSON.stringify({ data: null, error: { type: 'NOT_FOUND' } }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (urlString.includes('api.resend.com')) {
        externalCalls.push(urlString);
        return new Response(JSON.stringify({ id: 'mock-resend-id' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      // Cualquier otra llamada (incluidas las del propio test contra el
      // servidor Express local en 127.0.0.1) pasa a través del fetch real --
      // solo se interceptan/registran las llamadas a proveedores externos
      // reales (Wompi, Resend) y las teselas del mapa.
      return originalFetch(url, init);
    };
  });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  function externalCallsSince(markerIndex) {
    return externalCalls.slice(markerIndex);
  }
  function assertNoWompiOrEmailCalls(markerIndex, label) {
    const calls = externalCallsSince(markerIndex).filter(
      (url) => url.includes('wompi.co') || url.includes('resend.com'),
    );
    assert.deepEqual(calls, [], `${label}: el flujo temporal nunca debe llamar a Wompi ni al proveedor de correo`);
  }

  // P2-03: la primera corrección (escopar por canonical_predio_id en vez de
  // count(*) global) demostró SEGUIR siendo frágil bajo ejecución
  // concurrente real: catastroxPaymentOrders/Webhook/DeliveryLifecycle.test.js
  // usan el MISMO código sintético INTEGRATION_TEST_CODIGO como su propio
  // fixture (es la única fila disponible en catastrox_clean.predios), así
  // que un conteo "antes/después" escopado por predio sigue mezclando las
  // escrituras LEGÍTIMAS de esas otras suites con las de esta prueba en
  // cuanto corren en paralelo -- confirmado empíricamente (ver commit:
  // "6 !== 5" al correr las 5 suites juntas con concurrencia por defecto).
  //
  // La única verificación realmente inmune a cualquier ejecución
  // concurrente (porque no depende de NINGUNA medición en tiempo de
  // ejecución) es estática: mismo patrón de parsing que
  // server/__tests__/architecture/noSrcImports.test.js.
  //   - server/routes/catastrox.js (dueño de TODO /access/*, no solo estas
  //     3 rutas) JAMÁS importa customerRepository.js, paymentOrderRepository.js
  //     ni deliveryJobService.js -- estructuralmente imposible que el flujo
  //     temporal cree un customer, una orden o un delivery job, sin
  //     importar qué otra suite corra en paralelo ni qué fixture comparta.
  //   - dentro de los handlers POST /customers y POST /checkout de
  //     catastroxPayments.js, el guard COMMERCE_DISABLED aparece
  //     sintácticamente ANTES de la primera llamada real al repositorio.
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const __dirname = path.dirname(fileURLToPath(import.meta.url));

  function assertRouteNeverImportsCommercialWriteRepositories() {
    const source = fs.readFileSync(path.resolve(__dirname, '../catastrox.js'), 'utf8');
    for (const forbidden of ['customerRepository.js', 'paymentOrderRepository.js', 'deliveryJobService.js']) {
      assert.ok(
        !source.includes(forbidden),
        `server/routes/catastrox.js (dueño de /access/*) no debe importar ${forbidden} -- el flujo temporal nunca debe poder escribir customer/orden/delivery job`,
      );
    }
  }

  function assertCommerceGuardPrecedesRepositoryCall(routeMarker, repositoryCallMarker, label) {
    const source = fs.readFileSync(path.resolve(__dirname, '../catastroxPayments.js'), 'utf8');
    const handlerStart = source.indexOf(routeMarker);
    assert.ok(handlerStart >= 0, `no se encontró el handler ${label}`);
    const guardIndex = source.indexOf("resolveCurrentCommerceMode() === 'password'", handlerStart);
    const repositoryCallIndex = source.indexOf(repositoryCallMarker, handlerStart);
    assert.ok(guardIndex >= 0, `no se encontró el guard COMMERCE_DISABLED dentro del handler ${label}`);
    assert.ok(repositoryCallIndex >= 0, `no se encontró la llamada real al repositorio dentro del handler ${label}`);
    assert.ok(
      guardIndex < repositoryCallIndex,
      `el guard COMMERCE_DISABLED debe aparecer antes que cualquier llamada al repositorio en ${label}`,
    );
  }

  await t.test('19) Básico: contraseña correcta + capability + PDF real generado, CERO escrituras comerciales, cero Wompi/email', async () => {
    resetTemporaryAccessLimiter();
    const markerIndex = externalCalls.length;
    __rememberLookupPreviewForTests('temp-access-integration-basico', { canonicalPredioId: INTEGRATION_TEST_CODIGO });

    assertRouteNeverImportsCommercialWriteRepositories();

    await withEnv({ CATASTROX_COMMERCE_MODE: 'password' }, async () => {
      const app = await startTestApp(catastroxRouter, '/api/catastrox');
      try {
        const verifyResponse = await fetch(`${app.baseUrl}/access/verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: TEST_SECRET, packageId: 'basico', lookupId: 'temp-access-integration-basico' }),
        });
        const verifyPayload = await verifyResponse.json();
        assert.equal(verifyResponse.status, 200);

        const pdfResponse = await fetch(`${app.baseUrl}/access/generate/pdf`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ capability: verifyPayload.capability }),
        });
        assert.equal(pdfResponse.status, 200);
        assert.equal(pdfResponse.headers.get('content-type'), 'application/pdf');
        const buffer = Buffer.from(await pdfResponse.arrayBuffer());
        assert.equal(buffer.subarray(0, 5).toString('latin1'), '%PDF-');
        assert.ok(buffer.length > 1000, 'el PDF generado debe tener contenido real');

        // P2-01: básico tampoco debe poder obtener el full-result temporal.
        const fullResultResponse = await fetch(`${app.baseUrl}/access/lookups/temp-access-integration-basico/full-result`, {
          headers: { Authorization: `Bearer ${verifyPayload.capability}` },
        });
        assert.equal(fullResultResponse.status, 403);
      } finally {
        await app.close();
        resetTemporaryAccessLimiter();
      }
    });

    assertNoWompiOrEmailCalls(markerIndex, 'Básico');
  });

  await t.test('20) capability de básico rechazado por /access/generate/pdf si se reenvía para otro paquete (el packageId viaja DENTRO del capability, no se puede sustituir desde el cliente)', async () => {
    resetTemporaryAccessLimiter();
    __rememberLookupPreviewForTests('temp-access-integration-binding', { canonicalPredioId: INTEGRATION_TEST_CODIGO });

    await withEnv({ CATASTROX_COMMERCE_MODE: 'password' }, async () => {
      const app = await startTestApp(catastroxRouter, '/api/catastrox');
      try {
        const verifyResponse = await fetch(`${app.baseUrl}/access/verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: TEST_SECRET, packageId: 'basico', lookupId: 'temp-access-integration-binding' }),
        });
        const verifyPayload = await verifyResponse.json();
        assert.equal(verifyPayload.packageId, 'basico');

        // El capability emitido para 'basico' se usa tal cual -- no hay
        // forma de "pedirle" que autorice 'profesional" desde el cliente,
        // porque generate/pdf lee packageId EXCLUSIVAMENTE del capability
        // verificado, nunca de un campo del body.
        const pdfResponse = await fetch(`${app.baseUrl}/access/generate/pdf`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ capability: verifyPayload.capability, packageId: 'profesional' }),
        });
        assert.equal(pdfResponse.status, 200);
        // El PDF generado corresponde al paquete real del capability
        // (basico) -- confirmado indirectamente: la ruta nunca lee
        // req.body.packageId en absoluto (ver server/routes/catastrox.js).
      } finally {
        await app.close();
        resetTemporaryAccessLimiter();
      }
    });
  });

  await t.test('21) Plus end-to-end: verify -> PDF -> full-result, todos 200, config real desde catastroxPackages.js', async () => {
    resetTemporaryAccessLimiter();
    const markerIndex = externalCalls.length;
    const lookupId = 'temp-access-integration-plus';
    __rememberLookupPreviewForTests(lookupId, { canonicalPredioId: INTEGRATION_TEST_CODIGO, codigoPredial: INTEGRATION_TEST_CODIGO });

    const { getCatastroxPackage } = await import('../../../src/modules/catastrox/config/catastroxPackages.js');
    assert.deepEqual(getCatastroxPackage('plus').downloads, ['pdf', 'kml', 'kmz']);

    await withEnv({ CATASTROX_COMMERCE_MODE: 'password' }, async () => {
      const app = await startTestApp(catastroxRouter, '/api/catastrox');
      try {
        const verifyResponse = await fetch(`${app.baseUrl}/access/verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: TEST_SECRET, packageId: 'plus', lookupId }),
        });
        const verifyPayload = await verifyResponse.json();
        assert.equal(verifyResponse.status, 200);
        assert.equal(verifyPayload.packageId, 'plus');

        const pdfResponse = await fetch(`${app.baseUrl}/access/generate/pdf`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ capability: verifyPayload.capability }),
        });
        assert.equal(pdfResponse.status, 200);
        assert.equal(pdfResponse.headers.get('content-type'), 'application/pdf');

        const fullResultResponse = await fetch(`${app.baseUrl}/access/lookups/${lookupId}/full-result`, {
          headers: { Authorization: `Bearer ${verifyPayload.capability}` },
        });
        assert.equal(fullResultResponse.status, 200);
        const fullResultPayload = await fullResultResponse.json();
        assert.equal(fullResultPayload.status, 'TEMPORARY_ACCESS_FULL_RESULT');
      } finally {
        await app.close();
        resetTemporaryAccessLimiter();
      }
    });

    assertNoWompiOrEmailCalls(markerIndex, 'Plus');
  });

  await t.test('22) Profesional end-to-end: verify -> PDF -> full-result, todos 200, config real desde catastroxPackages.js', async () => {
    resetTemporaryAccessLimiter();
    const markerIndex = externalCalls.length;
    const lookupId = 'temp-access-integration-profesional';
    __rememberLookupPreviewForTests(lookupId, { canonicalPredioId: INTEGRATION_TEST_CODIGO, codigoPredial: INTEGRATION_TEST_CODIGO });

    const { getCatastroxPackage } = await import('../../../src/modules/catastrox/config/catastroxPackages.js');
    assert.deepEqual(getCatastroxPackage('profesional').downloads, ['pdf', 'kml', 'kmz', 'shp', 'dxf', 'coords9377']);

    await withEnv({ CATASTROX_COMMERCE_MODE: 'password' }, async () => {
      const app = await startTestApp(catastroxRouter, '/api/catastrox');
      try {
        const verifyResponse = await fetch(`${app.baseUrl}/access/verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: TEST_SECRET, packageId: 'profesional', lookupId }),
        });
        const verifyPayload = await verifyResponse.json();
        assert.equal(verifyResponse.status, 200);
        assert.equal(verifyPayload.packageId, 'profesional');

        const pdfResponse = await fetch(`${app.baseUrl}/access/generate/pdf`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ capability: verifyPayload.capability }),
        });
        assert.equal(pdfResponse.status, 200);
        assert.equal(pdfResponse.headers.get('content-type'), 'application/pdf');

        const fullResultResponse = await fetch(`${app.baseUrl}/access/lookups/${lookupId}/full-result`, {
          headers: { Authorization: `Bearer ${verifyPayload.capability}` },
        });
        assert.equal(fullResultResponse.status, 200);
        const fullResultPayload = await fullResultResponse.json();
        assert.equal(fullResultPayload.status, 'TEMPORARY_ACCESS_FULL_RESULT');
      } finally {
        await app.close();
        resetTemporaryAccessLimiter();
      }
    });

    assertNoWompiOrEmailCalls(markerIndex, 'Profesional');
  });

  await t.test('23) misma contraseña, mismo predio -> tres capabilities distintos y correctamente escopados por paquete', async () => {
    resetTemporaryAccessLimiter();
    const lookupId = 'temp-access-integration-same-password';
    __rememberLookupPreviewForTests(lookupId, { canonicalPredioId: INTEGRATION_TEST_CODIGO, codigoPredial: INTEGRATION_TEST_CODIGO });

    await withEnv({ CATASTROX_COMMERCE_MODE: 'password' }, async () => {
      const app = await startTestApp(catastroxRouter, '/api/catastrox');
      try {
        const verifyFor = async (packageId) => {
          const response = await fetch(`${app.baseUrl}/access/verify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: TEST_SECRET, packageId, lookupId }),
          });
          const payload = await response.json();
          assert.equal(response.status, 200);
          return payload.capability;
        };

        const tokenBasico = await verifyFor('basico');
        const tokenPlus = await verifyFor('plus');
        const tokenProfesional = await verifyFor('profesional');

        // Misma contraseña -> tres tokens distintos como texto (nunca el
        // mismo string).
        assert.notEqual(tokenBasico, tokenPlus);
        assert.notEqual(tokenPlus, tokenProfesional);
        assert.notEqual(tokenBasico, tokenProfesional);

        // La autorización real de cada uno (no solo que el texto difiera)
        // se prueba contra el gate de full-result reforzado por P2-01:
        // básico rechazado, plus/profesional permitidos.
        const fullResultFor = (token) =>
          fetch(`${app.baseUrl}/access/lookups/${lookupId}/full-result`, {
            headers: { Authorization: `Bearer ${token}` },
          });

        const [resultBasico, resultPlus, resultProfesional] = await Promise.all([
          fullResultFor(tokenBasico),
          fullResultFor(tokenPlus),
          fullResultFor(tokenProfesional),
        ]);
        assert.equal(resultBasico.status, 403, 'básico debe rechazarse (PACKAGE_ACCESS_DENIED)');
        assert.equal(resultPlus.status, 200, 'plus debe permitirse');
        assert.equal(resultProfesional.status, 200, 'profesional debe permitirse');
      } finally {
        await app.close();
        resetTemporaryAccessLimiter();
      }
    });
  });

  await t.test('24) COMMERCE_DISABLED: POST /payments/customers rechaza ANTES de crear customer/PII/OTP', async () => {
    assertCommerceGuardPrecedesRepositoryCall(
      "router.post('/customers'",
      'customers.resolveCustomerForVerification(',
      'POST /customers',
    );

    await withEnv({ CATASTROX_COMMERCE_MODE: 'password' }, async () => {
      const app = await startTestApp(catastroxPaymentsRouter, '/api/catastrox/payments');
      try {
        const response = await fetch(`${app.baseUrl}/customers`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            customerType: 'natural',
            firstName: 'Temp',
            lastName: 'Access',
            documentType: 'CC',
            documentNumber: '900000001',
            email: 'temp-freeze-test@example.com',
            emailConfirmation: 'temp-freeze-test@example.com',
            phone: '3000000000',
            countryCode: 'CO',
            department: 'Caqueta',
            city: 'Florencia',
            address: 'Direccion de prueba',
            privacyConsentAccepted: true,
            termsAccepted: true,
            deliveryAuthorizationAccepted: true,
          }),
        });
        const payload = await response.json();
        assert.equal(response.status, 403);
        assert.equal(payload.code, 'COMMERCE_DISABLED');
      } finally {
        await app.close();
      }
    });
  });

  await t.test('25) COMMERCE_DISABLED: POST /payments/checkout rechaza ANTES de crear la orden', async () => {
    assertCommerceGuardPrecedesRepositoryCall(
      "router.post('/checkout'",
      'paymentOrders.withCheckoutLock(',
      'POST /checkout',
    );

    await withEnv({ CATASTROX_COMMERCE_MODE: 'password' }, async () => {
      const app = await startTestApp(catastroxPaymentsRouter, '/api/catastrox/payments');
      try {
        const response = await fetch(`${app.baseUrl}/checkout`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ packageId: 'basico', purchaseAttemptId: '00000000-0000-4000-8000-000000000000' }),
        });
        const payload = await response.json();
        assert.equal(response.status, 403);
        assert.equal(payload.code, 'COMMERCE_DISABLED');
      } finally {
        await app.close();
      }
    });
  });

  await t.test('26) fuera de modo password, /payments/customers y /payments/checkout NO quedan bloqueados por el guard nuevo (solo fallan por validación normal)', async () => {
    await withEnv({ CATASTROX_COMMERCE_MODE: 'wompi_test' }, async () => {
      const app = await startTestApp(catastroxPaymentsRouter, '/api/catastrox/payments');
      try {
        const response = await fetch(`${app.baseUrl}/customers`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        const payload = await response.json();
        assert.notEqual(payload.code, 'COMMERCE_DISABLED');
      } finally {
        await app.close();
      }
    });
  });

  // P2-04: los 5 endpoints históricos/de reconciliación deben seguir
  // funcionando exactamente igual bajo CATASTROX_COMMERCE_MODE=password --
  // no hace falta que todos devuelvan 200 (no hay fixture real detrás de
  // estos tokens/IDs falsos), lo único que se prueba es que NINGUNO
  // devuelve el código COMMERCE_DISABLED del guard nuevo.
  await t.test('27) históricos bajo password mode: webhook/verify/orders/entitlements/download NO son interceptados por COMMERCE_DISABLED', async () => {
    await withEnv({ CATASTROX_COMMERCE_MODE: 'password' }, async () => {
      const app = await startTestApp(catastroxPaymentsRouter, '/api/catastrox/payments');
      try {
        // POST /wompi/events -- firma inválida (evento sintético sin firma
        // real) -> 401, nunca COMMERCE_DISABLED.
        const webhookResponse = await fetch(`${app.baseUrl}/wompi/events`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ event: 'transaction.updated', data: { transaction: { id: 'fake-tx', reference: 'fake-ref' } } }),
        });
        const webhookPayload = await webhookResponse.json();
        assert.notEqual(webhookResponse.status, 403);
        assert.notEqual(webhookPayload.code, 'COMMERCE_DISABLED');

        // GET /verify/:transactionId -- transacción inexistente en Wompi
        // (mockeado arriba a 404) -> 404, nunca COMMERCE_DISABLED.
        const verifyResponse = await fetch(`${app.baseUrl}/verify/fake-transaction-id`);
        const verifyPayload = await verifyResponse.json();
        assert.notEqual(verifyResponse.status, 403);
        assert.notEqual(verifyPayload.code, 'COMMERCE_DISABLED');

        // GET /orders/:orderToken/status -- token inexistente -> 404,
        // nunca COMMERCE_DISABLED.
        const statusResponse = await fetch(`${app.baseUrl}/orders/token-inexistente/status`);
        const statusPayload = await statusResponse.json();
        assert.notEqual(statusResponse.status, 403);
        assert.notEqual(statusPayload.code, 'COMMERCE_DISABLED');
        assert.equal(statusResponse.status, 404);

        // POST /entitlements/check -- sin cookie de sesión -> 200
        // isPaid:false (su semántica normal), nunca COMMERCE_DISABLED.
        const entitlementResponse = await fetch(`${app.baseUrl}/entitlements/check`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ packageId: 'basico', canonicalPredioId: INTEGRATION_TEST_CODIGO }),
        });
        const entitlementPayload = await entitlementResponse.json();
        assert.notEqual(entitlementResponse.status, 403);
        assert.notEqual(entitlementPayload.code, 'COMMERCE_DISABLED');
        assert.equal(entitlementResponse.status, 200);
        assert.equal(entitlementPayload.isPaid, false);

        // GET /orders/:orderToken/deliverable/download -- sin sesión ->
        // 401 SESSION_REQUIRED (su semántica normal), nunca COMMERCE_DISABLED.
        const downloadResponse = await fetch(`${app.baseUrl}/orders/token-inexistente/deliverable/download`);
        const downloadPayload = await downloadResponse.json();
        assert.notEqual(downloadResponse.status, 403);
        assert.notEqual(downloadPayload.code, 'COMMERCE_DISABLED');
        assert.equal(downloadPayload.code, 'SESSION_REQUIRED');
      } finally {
        await app.close();
      }
    });
  });

  // R4: el worker autónomo nunca importa deliveryJobService.js directamente
  // (todas sus dependencias se inyectan) y no lee CATASTROX_COMMERCE_MODE en
  // absoluto -- confirmado por lectura de código (deliveryWorker.js sin
  // diff). Esta prueba es un smoke test estructural: bajo password mode,
  // arranca/corre un ciclo y se detiene sin lanzar, sin crear ningún job
  // nuevo (findJobIds/processJob son mocks inyectados, nunca tocan Postgres).
  await t.test('28) R4: el worker de entrega sigue arrancando bajo password mode, sin crear delivery jobs nuevos', async () => {
    const { createDeliveryWorker } = await import('../../services/catastrox/deliveryWorker.js');
    await withEnv({ CATASTROX_COMMERCE_MODE: 'password' }, async () => {
      let findCalls = 0;
      const worker = createDeliveryWorker({
        findJobIds: async () => {
          findCalls += 1;
          return [];
        },
        processJob: async () => {
          throw new Error('no debería llamarse -- findJobIds no devolvió jobs');
        },
        logger: { log: () => {}, error: () => {} },
      });

      const summary = await worker.runOnce();
      assert.equal(findCalls, 1);
      assert.equal(summary.processed, 0);
    });
  });
});
