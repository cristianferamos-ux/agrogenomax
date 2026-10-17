// SPRINT-3D11.3 (R1) -- identificadores de chapeta y archivo del proveedor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CODIGO_ALFABETO,
  CODIGO_VISIBLE_PATTERN,
  QR_TOKEN_BYTES,
  generateCodigoLote,
  generateCodigoVisible,
  generateQrToken,
  hashQrToken,
  isCodigoVisible,
  isQrToken,
  normalizeCodigoVisible,
} from '../ganaderia/qrCodigos.js';
import { buildProveedorCsv, buildProveedorHtml, qrUrl } from '../ganaderia/qrProveedorExport.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, '..', 'ganaderia', 'qrCodigos.js'), 'utf8');

test('token: 192 bits (>= 128) de crypto.randomBytes, base64url de 32 caracteres, 5000 sin repetidos', () => {
  assert.ok(QR_TOKEN_BYTES * 8 >= 128);
  const tokens = new Set(Array.from({ length: 5000 }, generateQrToken));
  assert.equal(tokens.size, 5000);
  for (const token of tokens) assert.equal(isQrToken(token), true);
  assert.equal(Buffer.from([...tokens][0], 'base64url').length, QR_TOKEN_BYTES);
  assert.equal(generateQrToken.length, 0, 'no recibe datos del animal ni del código');
  assert.doesNotMatch(source, /Math\.random|Date\.now|nextval/);
});

test('token_hash: SHA-256 hex determinista', () => {
  assert.equal(hashQrToken('A'.repeat(32)), hashQrToken('A'.repeat(32)));
  assert.match(hashQrToken(generateQrToken()), /^[0-9a-f]{64}$/);
});

test('código visible: AGX-XXXX-XXXX, alfabeto de 32 sin O/0/I/1, no secuencial', () => {
  assert.equal(CODIGO_ALFABETO.length, 32);
  for (const ambiguo of ['O', '0', 'I', '1']) assert.ok(!CODIGO_ALFABETO.includes(ambiguo), ambiguo);
  const codes = Array.from({ length: 5000 }, generateCodigoVisible);
  assert.ok(new Set(codes).size >= 4999, 'colisiones casi imposibles (40 bits); la base las rechaza igualmente');
  for (const code of codes) assert.match(code, CODIGO_VISIBLE_PATTERN);
  const sorted = [...codes].sort();
  assert.notDeepEqual(codes.slice(0, 20), sorted.slice(0, 20), 'no sale en orden');
});

test('código de lote: LQR-AAAAMMDD-XXXX', () => {
  assert.match(generateCodigoLote(new Date('2026-10-17T12:00:00Z')), /^LQR-20261017-[A-HJ-NP-Z2-9]{4}$/);
});

test('normalización del código digitado en campo', () => {
  const cases = [
    ['AGX-7KM4-P2XZ', 'AGX-7KM4-P2XZ'],
    ['agx-7km4-p2xz', 'AGX-7KM4-P2XZ'],
    [' agx 7km4 p2xz ', 'AGX-7KM4-P2XZ'],
    ['7KM4P2XZ', 'AGX-7KM4-P2XZ'],
    ['7km4-p2xz', 'AGX-7KM4-P2XZ'],
    ['AGX7KM4P2XZ', 'AGX-7KM4-P2XZ'],
    ['AGXB2345', 'AGX-AGXB-2345'], // cuerpo que empieza por AGX, sin prefijo
    ['agx-000003', 'AGX-000003'],
    ['000003', 'AGX-000003'],
  ];
  for (const [raw, expected] of cases) assert.equal(normalizeCodigoVisible(raw), expected, raw);
  for (const raw of ['', 'HOLA', 'AGX-0000-0000', 'AGX-OIOI-OIOI', 'AGX-12345', 'AGX-7KM4-P2X', null, 42, 'x'.repeat(40)]) {
    assert.equal(normalizeCodigoVisible(raw), null, String(raw));
  }
  assert.equal(isCodigoVisible('AGX-7KM4-P2XZ'), true);
  assert.equal(isCodigoVisible('AGX-000003'), true);
  assert.equal(isCodigoVisible('agx-7km4-p2xz'), false, 'isCodigoVisible exige forma canónica');
});

const LOTE = { codigoLote: 'LQR-20261017-ABCD', urlBase: 'https://agrogenomax.com' };
const CHAPETAS = [
  { codigoVisible: 'AGX-7KM4-P2XZ', token: 'aB3_-xYz09QwErTyUiOpAsDfGhJkLzXc' },
  { codigoVisible: 'AGX-4TR8-N6CW', token: 'Zz9-_yXw8VuTsRqPoNmLkJiHgFeDcBa7' },
];

test('archivo proveedor CSV: lote, código visible y URL /qr/<token> por chapeta', () => {
  const csv = buildProveedorCsv({ lote: LOTE, chapetas: CHAPETAS });
  const lines = csv.trim().split('\r\n');
  assert.equal(lines[0], 'codigo_lote,codigo_visible,url_qr');
  assert.equal(lines[1], '"LQR-20261017-ABCD","AGX-7KM4-P2XZ","https://agrogenomax.com/qr/aB3_-xYz09QwErTyUiOpAsDfGhJkLzXc"');
  assert.equal(lines.length, 3);
  assert.equal(qrUrl(LOTE.urlBase, CHAPETAS[0].token), 'https://agrogenomax.com/qr/aB3_-xYz09QwErTyUiOpAsDfGhJkLzXc');
});

test('archivo proveedor HTML imprimible: marca, código visible y QR SVG por chapeta, sin scripts', async () => {
  const html = await buildProveedorHtml({ lote: LOTE, chapetas: CHAPETAS });
  assert.equal((html.match(/<svg/g) || []).length, 2);
  assert.equal((html.match(/AGROGENOMAX/g) || []).length, 2);
  assert.ok(html.includes('AGX-7KM4-P2XZ') && html.includes('AGX-4TR8-N6CW'));
  assert.ok(html.includes('LQR-20261017-ABCD'));
  assert.doesNotMatch(html, /<script/i);
});
