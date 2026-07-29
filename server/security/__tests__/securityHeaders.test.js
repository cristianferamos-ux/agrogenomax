import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createPermissionsPolicyMiddleware, createSecurityHeadersMiddleware } from '../securityHeaders.js';

async function startApp({ appEnv }) {
  const app = express();
  app.use(createSecurityHeadersMiddleware({ appEnv }));
  app.use(createPermissionsPolicyMiddleware());
  app.get('/probe', (_req, res) => res.json({ ok: true }));
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  return { baseUrl: `http://127.0.0.1:${port}/probe`, close: () => new Promise((resolve) => server.close(resolve)) };
}

test('CSP estricta (default-src none) -- esta API nunca sirve el SPA ni embebe el widget de Wompi', async () => {
  const app = await startApp({ appEnv: 'production' });
  try {
    const response = await fetch(app.baseUrl);
    const csp = response.headers.get('content-security-policy');
    assert.ok(csp.includes("default-src 'none'"));
    assert.ok(csp.includes("frame-ancestors 'none'"));
  } finally {
    await app.close();
  }
});

test('X-Content-Type-Options: nosniff siempre presente', async () => {
  const app = await startApp({ appEnv: 'development' });
  try {
    const response = await fetch(app.baseUrl);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  } finally {
    await app.close();
  }
});

test('Referrer-Policy: no-referrer', async () => {
  const app = await startApp({ appEnv: 'development' });
  try {
    const response = await fetch(app.baseUrl);
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  } finally {
    await app.close();
  }
});

test('Permissions-Policy restrictivo presente', async () => {
  const app = await startApp({ appEnv: 'development' });
  try {
    const response = await fetch(app.baseUrl);
    const policy = response.headers.get('permissions-policy');
    assert.ok(policy.includes('camera=()'));
    assert.ok(policy.includes('geolocation=()'));
    assert.ok(policy.includes('payment=()'));
  } finally {
    await app.close();
  }
});

test('HSTS solo en production -- development/test/demo/staging no fuerzan HTTPS', async () => {
  const prodApp = await startApp({ appEnv: 'production' });
  const devApp = await startApp({ appEnv: 'development' });
  try {
    const prodResponse = await fetch(prodApp.baseUrl);
    const devResponse = await fetch(devApp.baseUrl);
    assert.ok(prodResponse.headers.get('strict-transport-security'));
    assert.equal(devResponse.headers.get('strict-transport-security'), null);
  } finally {
    await prodApp.close();
    await devApp.close();
  }
});

test('respuesta no expone stack traces ni detalles internos en las cabeceras', async () => {
  const app = await startApp({ appEnv: 'production' });
  try {
    const response = await fetch(app.baseUrl);
    assert.equal(response.headers.get('x-powered-by'), null);
  } finally {
    await app.close();
  }
});
