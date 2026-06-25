import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const workspaceRoot = path.resolve(__dirname, '..', '..', '..');
const defaultInputPath = path.join(__dirname, 'sample-predio.example.json');
const cdpVersionUrl = process.env.CATASTROX_CDP_URL || 'http://127.0.0.1:9222/json/version';
const bindHost = '127.0.0.1';

const mimeTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'application/javascript; charset=utf-8'],
  ['.mjs', 'application/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.ttf', 'font/ttf'],
]);

function toPosixPath(value) {
  return value.split(path.sep).join('/');
}

function safeStem(value) {
  return String(value || 'predio-real')
    .trim()
    .replace(/[^\w.-]+/g, '_')
    .slice(0, 80) || 'predio-real';
}

function decodeBase64Utf8(base64) {
  return Buffer.from(base64, 'base64').toString('utf8');
}

function fetchJson(url) {
  return fetch(url).then((response) => {
    if (!response.ok) {
      throw new Error(`No se pudo consultar ${url} (${response.status})`);
    }
    return response.json();
  });
}

async function ensureFileReadable(filePath) {
  await fs.access(filePath);
}

function createStaticServer(rootDir) {
  return http.createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url, `http://${bindHost}`);
      let relativePath = decodeURIComponent(requestUrl.pathname);
      if (relativePath === '/') relativePath = '/index.html';

      const resolvedPath = path.resolve(rootDir, `.${relativePath}`);
      if (!resolvedPath.startsWith(rootDir)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Forbidden');
        return;
      }

      const stat = await fs.stat(resolvedPath);
      if (stat.isDirectory()) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Directory listing disabled');
        return;
      }

      const ext = path.extname(resolvedPath).toLowerCase();
      const contentType = mimeTypes.get(ext) || 'application/octet-stream';
      const bytes = await fs.readFile(resolvedPath);
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(bytes);
    } catch (error) {
      const status = error?.code === 'ENOENT' ? 404 : 500;
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(status === 404 ? 'Not found' : `Server error: ${error?.message || String(error)}`);
    }
  });
}

async function readHarnessPayload(harnessUrl) {
  const version = await fetchJson(cdpVersionUrl);
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
      }, 120000);
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
  await send('Page.navigate', { url: harnessUrl }, sessionId);

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
    throw new Error('No se obtuvo result-json del harness real-world dentro del tiempo esperado.');
  }
  if (!payload.ok) {
    throw new Error(payload.fatal?.message || 'El harness real-world reportó un fallo.');
  }

  return payload;
}

async function writeArtifacts(outputDir, payload) {
  const stem = safeStem(payload.codigoPredial || payload.predioId || payload.debugSummary?.code);
  const files = [
    [`${stem}_plano.pdf`, payload.artifacts?.planPdfBase64, 'base64'],
    [`${stem}.pdf`, payload.artifacts?.diagnosticPdfBase64, 'base64'],
    [`${stem}.kml`, payload.artifacts?.kmlBase64, 'base64-utf8'],
    [`${stem}.kmz`, payload.artifacts?.kmzBase64, 'base64'],
    [`${stem}.zip`, payload.artifacts?.shpZipBase64, 'base64'],
  ];

  for (const [filename, content, mode] of files) {
    if (!content) continue;
    const target = path.join(outputDir, filename);
    if (mode === 'base64') {
      await fs.writeFile(target, Buffer.from(content, 'base64'));
    } else if (mode === 'base64-utf8') {
      await fs.writeFile(target, decodeBase64Utf8(content), 'utf8');
    }
  }

  const summaryPath = path.join(outputDir, 'summary.json');
  await fs.writeFile(summaryPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

async function main() {
  const inputArg = process.argv[2] ? path.resolve(process.argv[2]) : defaultInputPath;
  await ensureFileReadable(inputArg);

  const rawInput = JSON.parse(await fs.readFile(inputArg, 'utf8'));
  const source = rawInput?.predio ? rawInput : { predio: rawInput };
  const predio = source.predio || {};
  const stem = safeStem(predio.codigoPredial || predio.codigo || predio.id || path.basename(inputArg, path.extname(inputArg)));
  const outputDir = path.join(workspaceRoot, 'tmp', 'catastrox-real-world', stem);
  await fs.mkdir(outputDir, { recursive: true });

  const stagedInputPath = path.join(outputDir, 'input.json');
  await fs.writeFile(stagedInputPath, `${JSON.stringify(rawInput, null, 2)}\n`, 'utf8');

  const server = createStaticServer(workspaceRoot);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, bindHost, resolve);
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const inputUrl = `http://${bindHost}:${port}/${toPosixPath(path.relative(workspaceRoot, stagedInputPath))}`;
  const harnessUrl = `http://${bindHost}:${port}/scripts/catastrox/real-world/browser-harness.html?input=${encodeURIComponent(inputUrl)}`;

  try {
    const payload = await readHarnessPayload(harnessUrl);
    await writeArtifacts(outputDir, payload);

    const metrics = payload.regressionMetrics || {};
    const summary = {
      codigoPredial: payload.codigoPredial,
      municipio: payload.municipality,
      departamento: payload.department,
      ringVertices: payload.ringVertices,
      totalVisiblePoints: metrics.totalVisiblePoints,
      totalRequested: metrics.totalRequested,
      totalPlaced: metrics.totalPlaced,
      totalHidden: metrics.totalHidden,
      guideLinesSuggested: metrics.guideLinesSuggested,
      guideLinesRendered: metrics.guideLinesRendered,
      labelOverlapCount: metrics.labelOverlapCount,
      labelsInsidePolygonCount: metrics.labelsInsidePolygonCount,
      labelsOverPointCount: metrics.labelsOverPointCount,
      pdfBytes: payload.artifacts?.pdfBytes || 0,
      diagnosticPdfBytes: payload.artifacts?.diagnosticPdfBytes || 0,
      kmlBytes: payload.artifacts?.kmlBytes || 0,
      kmzBytes: payload.artifacts?.kmzBytes || 0,
      shpZipBytes: payload.artifacts?.shpZipBytes || 0,
      errors: payload.pdfError ? [payload.pdfError.message] : [],
      outputDir,
    };

    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
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
