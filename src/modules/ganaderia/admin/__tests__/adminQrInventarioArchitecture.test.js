// SPRINT-3D11.3 (R1): Administración > QR Ganadería / Inventario de
// chapetas -- lógica pura + invariantes de arquitectura (convención del
// repo: sin jsdom, análisis de texto fuente).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  adminQrErrorMessage,
  codigosLegacyConsecutivos,
  parseCodigosTexto,
  siguienteEstadoLote,
} from '../adminQrModel.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ADMIN_DIR = path.resolve(__dirname, '..');
const SRC_DIR = path.resolve(ADMIN_DIR, '..', '..', '..');

function read(filePath) {
  return fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
}

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
}

const pageCode = stripComments(read(path.join(ADMIN_DIR, 'GanaderiaAdminQrInventario.jsx')));
const apiCode = stripComments(read(path.join(ADMIN_DIR, 'adminQrApi.js')));
const shellCode = read(path.join(ADMIN_DIR, 'GanaderiaAdminShell.jsx'));
const appCode = read(path.join(SRC_DIR, 'App.jsx'));

test('estado del lote: un paso adelante (GENERADO -> EN_FABRICACION -> EN_STOCK)', () => {
  assert.equal(siguienteEstadoLote('GENERADO'), 'EN_FABRICACION');
  assert.equal(siguienteEstadoLote('EN_FABRICACION'), 'EN_STOCK');
  assert.equal(siguienteEstadoLote('EN_STOCK'), null);
  assert.equal(siguienteEstadoLote('CERRADO'), null);
});

test('códigos pegados: separadores varios, mayúsculas, sin repetidos', () => {
  assert.deepEqual(parseCodigosTexto('agx-7km4-p2xz\nAGX-4TR8-N6CW, AGX-7KM4-P2XZ ;  '), ['AGX-7KM4-P2XZ', 'AGX-4TR8-N6CW']);
  assert.deepEqual(parseCodigosTexto(''), []);
});

test('legacy: consecutivos AGX-000001..AGX-000030; rangos inválidos -> null', () => {
  const codigos = codigosLegacyConsecutivos('1', '30');
  assert.equal(codigos.length, 30);
  assert.equal(codigos[0], 'AGX-000001');
  assert.equal(codigos[29], 'AGX-000030');
  for (const [a, b] of [['0', '3'], ['5', '2'], ['x', '3'], ['1', '6000'], ['999999', '1000000']]) {
    assert.equal(codigosLegacyConsecutivos(a, b), null, `${a}-${b}`);
  }
});

test('mensajes de error: legibles, con códigos afectados y sin detalles internos', () => {
  assert.match(adminQrErrorMessage({ error: 'STOCK_INSUFICIENTE' }), /suficientes/);
  assert.match(adminQrErrorMessage({ error: 'QR_CODIGO_YA_EXISTE', codigos: ['AGX-000001'] }), /AGX-000001/);
  assert.match(adminQrErrorMessage({ error: 'X', message: 'select * from' }), /No fue posible/);
});

test('ruta /ganaderia/admin/qr protegida con RequireGanaderiaSuperAdmin (mismo guard del panel)', () => {
  const route = appCode.match(/path="\/ganaderia\/admin\/qr"[\s\S]*?\/>\n/)?.[0] ?? '';
  assert.match(route, /<RequireGanaderiaSuperAdmin>\s*<GanaderiaAdminQrInventario \/>/);
  assert.doesNotMatch(route, /RequireGanaderiaAuth>/);
});

test('panel: tarjeta "QR Ganadería / Inventario de chapetas" navegable a /ganaderia/admin/qr', () => {
  assert.match(shellCode, /label: 'QR Ganadería \/ Inventario de chapetas'[\s\S]{0,200}to: '\/ganaderia\/admin\/qr'/);
});

test('cliente admin: solo /api/ganaderia/admin/qr vía cliente autenticado compartido; sin fetch propio', () => {
  assert.match(apiCode, /const BASE = '\/api\/ganaderia\/admin\/qr';/);
  assert.match(apiCode, /from '\.\.\/auth\/ganaderiaAuthedRequest\.js'/);
  assert.doesNotMatch(apiCode, /\bfetch\(/);
  assert.doesNotMatch(pageCode, /\bfetch\(/);
});

test('página: crear lote, estados, descargas proveedor, asignación total/parcial, búsqueda, baja/daño/reemplazo, legacy', () => {
  for (const call of ['crearLote(', 'cambiarEstadoLote(', 'descargarPaqueteFabricacion(loteId)', "fabricacionUrl(loteId, 'pdf')",
    "fabricacionUrl(loteId, 'manifest')", 'arteSvgUrl(qrId)',
    'asignarLote(', 'buscarChapetas(', 'bajaChapeta(', 'reemplazarChapeta(', 'importarLegacy(']) {
    assert.ok(pageCode.includes(call), call);
  }
  for (const modo of ["setModo('todo')", "setModo('cantidad')", "setModo('codigos')"]) assert.ok(pageCode.includes(modo), modo);
});

test('página (FASE 15): botones de fabricación láser; sin el botón engañoso "hoja imprimible (PDF)" que descargaba HTML', () => {
  for (const label of ['Descargar paquete de fabricación', 'Descargar PDF de referencia', 'Descargar manifest (CSV)',
    'Descargar SVG maestro', 'Vista previa HTML']) {
    assert.ok(pageCode.includes(label), label);
  }
  assert.doesNotMatch(pageCode, /hoja imprimible|CSV proveedor/);
  // Coherente con README_PROVEEDOR: sin muestra única obligatoria ni cantidad fija.
  assert.ok(pageCode.includes('cantidad autorizada por escrito por AgroGenomaX'));
  assert.doesNotMatch(pageCode, /fabricar primero UNA muestra|primero una muestra|UNA muestra/i);
  assert.match(pageCode, /calculado !== result.sha256Servidor/);
});

test('página: cada formulario usa un clientOperationId propio, renovado tras el éxito; sin storage', () => {
  assert.ok((pageCode.match(/useState\(newOperationId\)/g) || []).length >= 3);
  assert.ok((pageCode.match(/setOperationId\(newOperationId\(\)\)/g) || []).length >= 3);
  assert.doesNotMatch(pageCode, /localStorage|sessionStorage/);
});

test('página: nunca muestra tokens QR (solo códigos visibles)', () => {
  assert.doesNotMatch(pageCode, /\.token\b|tokenHash/);
});
