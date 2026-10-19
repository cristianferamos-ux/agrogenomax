// SPRINT-3D11.3 (R1) -- identificadores de chapeta y archivo del proveedor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { decryptQrToken, encryptQrToken, loadQrTokenKey } from '../ganaderia/qrTokenCrypto.js';
import {
  CODIGO_ALFABETO,
  digitoControl,
  isCodigoNuevoValido,
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
import { buildProveedorHtml, qrUrl } from '../ganaderia/qrProveedorExport.js';

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

test('código visible: AGX-XXXX-XXXX-C, alfabeto de 32 sin O/0/I/1, no secuencial, con dígito de control válido', () => {
  assert.equal(CODIGO_ALFABETO.length, 32);
  for (const ambiguo of ['O', '0', 'I', '1']) assert.ok(!CODIGO_ALFABETO.includes(ambiguo), ambiguo);
  const codes = Array.from({ length: 5000 }, generateCodigoVisible);
  assert.ok(new Set(codes).size >= 4999, 'colisiones casi imposibles (40 bits); la base las rechaza igualmente');
  for (const code of codes) {
    assert.match(code, CODIGO_VISIBLE_PATTERN);
    assert.equal(isCodigoNuevoValido(code), true, code);
  }
  const sorted = [...codes].sort();
  assert.notDeepEqual(codes.slice(0, 20), sorted.slice(0, 20), 'no sale en orden');
  assert.equal(digitoControl('7KM4P2XZ'), 'R');
});

test('dígito de control: TODA sustitución de un carácter se detecta (exhaustivo sobre 200 códigos)', () => {
  for (let n = 0; n < 200; n += 1) {
    const code = generateCodigoVisible();
    const chars = code.replace(/^AGX-/, '').replace(/-/g, '').split('');
    for (let i = 0; i < chars.length; i += 1) {
      for (const sym of CODIGO_ALFABETO) {
        if (sym === chars[i]) continue;
        const typo = [...chars];
        typo[i] = sym;
        assert.equal(normalizeCodigoVisible(typo.join('')), null, `${code} -> ${typo.join('')}`);
      }
    }
  }
});

test('dígito de control: casi toda transposición adyacente se detecta (>= 95%)', () => {
  let total = 0;
  let detectadas = 0;
  for (let n = 0; n < 2000; n += 1) {
    const chars = generateCodigoVisible().replace(/^AGX-/, '').replace(/-/g, '').split('');
    for (let i = 0; i < chars.length - 1; i += 1) {
      if (chars[i] === chars[i + 1]) continue;
      const swap = [...chars];
      [swap[i], swap[i + 1]] = [swap[i + 1], swap[i]];
      total += 1;
      if (normalizeCodigoVisible(swap.join('')) === null) detectadas += 1;
    }
  }
  assert.ok(detectadas / total >= 0.95, `${detectadas}/${total}`);
});

test('código de lote: LQR-AAAAMMDD-XXXX', () => {
  assert.match(generateCodigoLote(new Date('2026-10-17T12:00:00Z')), /^LQR-20261017-[A-HJ-NP-Z2-9]{4}$/);
});

test('normalización del código digitado en campo (con control) y legacy', () => {
  const cases = [
    ['AGX-7KM4-P2XZ-R', 'AGX-7KM4-P2XZ-R'],
    ['agx-7km4-p2xz-r', 'AGX-7KM4-P2XZ-R'],
    [' agx 7km4 p2xz r ', 'AGX-7KM4-P2XZ-R'],
    ['7KM4P2XZR', 'AGX-7KM4-P2XZ-R'],
    ['7km4-p2xz-r', 'AGX-7KM4-P2XZ-R'],
    ['AGX7KM4P2XZR', 'AGX-7KM4-P2XZ-R'],
    ['agx-000003', 'AGX-000003'],
    ['000003', 'AGX-000003'],
    ['AGX000003', 'AGX-000003'],
  ];
  for (const [raw, expected] of cases) assert.equal(normalizeCodigoVisible(raw), expected, raw);
  for (const raw of ['', 'HOLA', 'AGX-7KM4-P2XZ', 'AGX-7KM4-P2XZ-S', 'AGX-0000-0000-0', 'AGX-OIOI-OIOI-A', 'AGX-12345', null, 42, 'x'.repeat(40)]) {
    assert.equal(normalizeCodigoVisible(raw), null, String(raw));
  }
  assert.equal(isCodigoVisible('AGX-7KM4-P2XZ-R'), true);
  assert.equal(isCodigoVisible('AGX-7KM4-P2XZ-S'), false);
  assert.equal(isCodigoVisible('AGX-000003'), true);
  assert.equal(isCodigoVisible('agx-7km4-p2xz-r'), false, 'isCodigoVisible exige forma canónica');
});

test('cifrado del token: AES-256-GCM, 60 bytes, IV aleatorio, atado al código y a la clave', () => {
  const key = crypto.randomBytes(32);
  const token = generateQrToken();
  const a = encryptQrToken(token, 'AGX-7KM4-P2XZ-R', key);
  const b = encryptQrToken(token, 'AGX-7KM4-P2XZ-R', key);
  assert.equal(a.length, 60);
  assert.notDeepEqual(a, b, 'IV distinto en cada cifrado');
  assert.ok(!a.toString('latin1').includes(token));
  assert.equal(decryptQrToken(a, 'AGX-7KM4-P2XZ-R', key), token);
  assert.throws(() => decryptQrToken(a, 'AGX-4TR8-N6CW-H', key));
  assert.throws(() => decryptQrToken(a, 'AGX-7KM4-P2XZ-R', crypto.randomBytes(32)));
  const tampered = Buffer.from(a);
  tampered[40] ^= 1;
  assert.throws(() => decryptQrToken(tampered, 'AGX-7KM4-P2XZ-R', key));
  assert.throws(() => loadQrTokenKey({}), (error) => error.code === 'QR_KEY_NOT_CONFIGURED');
  assert.throws(() => loadQrTokenKey({ AGX_QR_TOKEN_ENCRYPTION_KEY: 'corta' }), (error) => error.code === 'QR_KEY_NOT_CONFIGURED');
  assert.equal(loadQrTokenKey({ AGX_QR_TOKEN_ENCRYPTION_KEY: key.toString('base64') }).length, 32);
});

const LOTE = { codigoLote: 'LQR-20261017-ABCD', urlBase: 'https://agrogenomax.com' };
const CHAPETAS = [
  { codigoVisible: 'AGX-7KM4-P2XZ-R', token: 'aB3_-xYz09QwErTyUiOpAsDfGhJkLzXc' },
  { codigoVisible: 'AGX-4TR8-N6CW-H', token: 'Zz9-_yXw8VuTsRqPoNmLkJiHgFeDcBa7' },
];

test('url_qr: <url_base>/qr/<token> (el código visible no es el token)', () => {
  assert.equal(qrUrl(LOTE.urlBase, CHAPETAS[0].token), 'https://agrogenomax.com/qr/aB3_-xYz09QwErTyUiOpAsDfGhJkLzXc');
});

test('vista previa HTML: marca, código visible y QR (Q, quiet zone 4, 30 mm, solo rellenos) por chapeta, sin scripts', () => {
  const html = buildProveedorHtml({ lote: LOTE, chapetas: CHAPETAS });
  assert.equal((html.match(/<svg/g) || []).length, 2);
  assert.equal((html.match(/width="30mm" height="30mm" viewBox="0 0 45 45"/g) || []).length, 2);
  assert.doesNotMatch(html, /stroke=|<image/);
  assert.match(html, /NO es el archivo de fabricación/);
  assert.equal((html.match(/AGROGENOMAX/g) || []).length, 2);
  assert.ok(html.includes('AGX-7KM4-P2XZ-R') && html.includes('AGX-4TR8-N6CW-H'));
  assert.ok(html.includes('LQR-20261017-ABCD'));
  assert.doesNotMatch(html, /<script/i);
});
