import fs from 'node:fs/promises';
import path from 'node:path';

const HARNESS_URL =
  process.env.CATASTROX_REGRESSION_URL ||
  'http://127.0.0.1:4175/scripts/catastrox/regression/browser-harness.html';
const CDP_VERSION_URL = process.env.CATASTROX_CDP_URL || 'http://127.0.0.1:9222/json/version';
const ALLOW_PDF_ERROR = process.env.CATASTROX_ALLOW_PDF_ERROR === '1';
const WRITE_ARTIFACTS = process.env.CATASTROX_WRITE_ARTIFACTS === '1';

function validateCase(caseResult, expectations) {
  const metrics = caseResult.regressionMetrics || {};
  const failures = [];

  for (const [key, expected] of Object.entries(expectations.exact || {})) {
    if (JSON.stringify(metrics[key]) !== JSON.stringify(expected)) {
      failures.push(`${caseResult.name}.${key}: esperado ${JSON.stringify(expected)}, recibido ${JSON.stringify(metrics[key])}`);
    }
  }

  for (const requiredPoint of expectations.northPoints || []) {
    if (!(metrics.northPoints || []).includes(requiredPoint)) {
      failures.push(`${caseResult.name}.northPoints: falta ${requiredPoint}`);
    }
  }

  if (expectations.p3p4Recovered !== undefined && metrics.p3p4Recovered !== expectations.p3p4Recovered) {
    failures.push(`${caseResult.name}.p3p4Recovered: esperado ${expectations.p3p4Recovered}, recibido ${metrics.p3p4Recovered}`);
  }

  if (caseResult.pdfGenerationSucceeded === false || caseResult.pdfError) {
    if (!ALLOW_PDF_ERROR) {
      failures.push(
        `${caseResult.name}.pdfGeneration: falló (${caseResult.pdfError?.message || 'sin detalle'})`,
      );
    }
  }

  return failures;
}

async function main() {
  const version = await fetch(CDP_VERSION_URL).then((response) => {
    if (!response.ok) throw new Error(`CDP no disponible en ${CDP_VERSION_URL}`);
    return response.json();
  });

  const ws = new WebSocket(version.webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 1;

  const send = (method, params = {}, sessionId) => {
    const id = nextId += 1;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, method });
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`Timeout waiting for ${method}`));
        }
      }, 30000);
    });
  };

  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message || JSON.stringify(message.error)));
      else resolve(message.result || {});
    }
  });

  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);
  await send('Page.navigate', { url: HARNESS_URL }, sessionId);

  let payload = null;
  const started = Date.now();
  while (!payload && Date.now() - started < 120000) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const evaluation = await send(
      'Runtime.evaluate',
      {
        expression: `(() => {
          const node = document.querySelector('#result-json');
          return node ? node.textContent : '';
        })()`,
        returnByValue: true,
      },
      sessionId,
    );
    const text = evaluation?.result?.value;
    if (text) payload = JSON.parse(text);
  }

  await send('Target.closeTarget', { targetId });
  ws.close();

  if (!payload) {
    throw new Error('No se obtuvo result-json del harness dentro del tiempo esperado.');
  }
  if (!payload.ok) {
    throw new Error(payload.fatal?.message || 'El harness de regresión reportó un fallo.');
  }

  const failures = [];
  const simple = payload.cases.find((entry) => entry.name === 'simple');
  const irregular = payload.cases.find((entry) => entry.name === 'irregular');

  if (!simple || !irregular) {
    throw new Error('El harness no produjo ambos casos esperados: simple e irregular.');
  }

  failures.push(
    ...validateCase(simple, {
      exact: {
        totalRequested: 4,
        totalPlaced: 4,
        totalHidden: 0,
        guideLinesSuggested: 0,
        guideLinesRendered: 0,
        guideLineReasons: {},
        totalVisiblePoints: 4,
        recoveredLongVisibleVertices: 0,
        recoveredLongVisibleSpans: 0,
        labelOverlapCount: 0,
        labelsInsidePolygonCount: 0,
        labelsOverPointCount: 0,
      },
    }),
  );

  failures.push(
    ...validateCase(irregular, {
      exact: {
        totalRequested: 20,
        totalPlaced: 20,
        totalHidden: 0,
        guideLinesSuggested: 3,
        guideLinesRendered: 3,
        guideLineReasons: { 'edge-angular-fallback-short-displaced': 3 },
        totalVisiblePoints: 20,
        recoveredLongVisibleVertices: 7,
        recoveredLongVisibleSpans: 1,
        labelOverlapCount: 0,
        labelsInsidePolygonCount: 0,
        labelsOverPointCount: 0,
      },
      northPoints: ['P13', 'P14', 'P15', 'P16', 'P17', 'P18', 'P19', 'P20'],
      p3p4Recovered: true,
    }),
  );

  const summary = {
    ok: failures.length === 0,
    cases: payload.cases.map((entry) => ({
      name: entry.name,
      predioId: entry.predioId,
      pdfBytes: entry.pdfBytes,
      regressionMetrics: entry.regressionMetrics,
      pdfGenerationSkippedOrFailed: entry.pdfGenerationSucceeded === false || Boolean(entry.pdfError),
      pdfErrorAllowedByEnv: ALLOW_PDF_ERROR && (entry.pdfGenerationSucceeded === false || Boolean(entry.pdfError)),
      pdfError: entry.pdfError,
    })),
    failures,
  };

  if (WRITE_ARTIFACTS) {
    const outputDir = path.resolve('tmp/pdfs');
    await fs.mkdir(outputDir, { recursive: true });

    for (const entry of payload.cases || []) {
      if (!entry.pdfBase64) continue;
      await fs.writeFile(path.join(outputDir, `${entry.name}.pdf`), Buffer.from(entry.pdfBase64, 'base64'));
    }

    await fs.writeFile(
      path.join(outputDir, 'catastrox-v8-regression-summary.json'),
      `${JSON.stringify(summary, null, 2)}\n`,
      'utf8',
    );
  }

  console.log(JSON.stringify(summary, null, 2));

  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: error?.message || String(error),
    stack: error?.stack || null,
  }, null, 2));
  process.exitCode = 1;
});
