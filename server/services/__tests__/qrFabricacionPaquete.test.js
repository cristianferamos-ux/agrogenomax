// FASE 15: paquete maestro de fabricación láser, chapeta de DOS caras
// (superficie útil medida 60 × 30.7 mm). FRENTE variable: QR (Q, quiet zone
// 4, 24 mm) + código visible debajo, solo rellenos. REVERSO común:
// identidad AgroGenomaX en contornos. PDF vectorial con la misma geometría,
// manifest, checksums, ZIP y verificación que aborta el export.
// La decodificación usa jsQR sobre un raster en memoria de NUESTRO SVG
// (independiente de la librería qrcode), también con degradaciones.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { DOMParser } from '@xmldom/xmldom';
import JSZip from 'jszip';

import {
  CHAPETA_AREA_UTIL_MM,
  FRENTE_LAYOUT,
  QR_EXPORT,
  QR_TAMANOS_CANDIDATOS_MM,
  REVERSO_FILENAME,
  REVERSO_LAYOUT,
  buildChapetaArte,
  buildQrMatrix,
  buildReversoArte,
  codigoPeorCaso,
  evaluarTamanoQr,
  matrixFromArteSvg,
  renderArteSvg,
  renderQrSvg,
  renderReversoSvg,
  verificarArteSvg,
  verificarReversoSvg,
} from '../ganaderia/qrFabricacionGeometria.js';
import {
  MANIFEST_COLUMNS,
  PT_POR_MM,
  buildManifestCsv,
  buildPaqueteFabricacion,
  buildReferenciaPdf,
  csvField,
  nombresPaquete,
  prepararFabricacion,
  sha256Hex,
} from '../ganaderia/qrFabricacionPaquete.js';
import { buildProveedorHtml, qrUrl } from '../ganaderia/qrProveedorExport.js';
import { generateCodigoVisible, generateQrToken, hashQrToken } from '../ganaderia/qrCodigos.js';
import { decryptQrToken, encryptQrToken } from '../ganaderia/qrTokenCrypto.js';
import { ESCENARIOS, leerQr, morfologia, rasterSvg } from './qrRasterTestUtils.js';

const URL_BASE = 'https://agrogenomax.com';
// Tokens fijos (deterministas) para las pruebas de robustez.
const TOKENS_FIJOS = [0, 1, 2].map((i) => crypto.createHash('sha256').update(`agx-fase15-robustez-${i}`).digest().subarray(0, 24).toString('base64url'));

function fixtureLote(cantidad = 10) {
  const vistos = new Set();
  const chapetas = [];
  while (chapetas.length < cantidad) {
    const codigoVisible = generateCodigoVisible();
    if (vistos.has(codigoVisible)) continue;
    vistos.add(codigoVisible);
    const token = generateQrToken();
    chapetas.push({ codigoVisible, token, tokenHash: hashQrToken(token) });
  }
  return {
    lote: { codigoLote: 'LQR-20261018-TEST', tipo: 'QR_AGX', cantidad, urlBase: URL_BASE, creadoAt: '2026-10-18T12:00:00.000Z' },
    chapetas,
  };
}

function frenteDe(codigoVisible, token) {
  const url = qrUrl(URL_BASE, token);
  const arte = buildChapetaArte({ codigoVisible, url });
  return { url, arte, svg: renderArteSvg(arte) };
}

function attr(svg, name) {
  return svg.match(new RegExp(`<svg [^>]*\\b${name}="([^"]*)"`))?.[1];
}

function textosPdf(pdf) {
  return [...pdf.matchAll(/<([0-9a-f]+)>/g)].map((m) => Buffer.from(m[1], 'hex').toString('latin1')).join('');
}

/** Bloques de arte del PDF: q, translate, scale, ... Q -> tramos QR (x y w 1 re). */
function bloquesPdf(pdf) {
  const bloques = [];
  const re = /q\n1 0 0 1 ([\d.]+) ([\d.]+) cm\n([\d.]+) 0 0 \3 0 0 cm\n([\s\S]*?)\nQ\n/g;
  let m;
  while ((m = re.exec(pdf)) !== null) {
    const runs = [...m[4].matchAll(/^(\d+) (\d+) (\d+) 1 re$/gm)].map((r) => ({ x: Number(r[1]), y: Number(r[2]), w: Number(r[3]) }));
    bloques.push({ escala: Number(m[3]), runs, cuerpo: m[4] });
  }
  return bloques;
}

function sinErroresXml(svg) {
  const errores = [];
  const doc = new DOMParser({ onError: (nivel, msg) => errores.push(`${nivel}: ${msg}`) }).parseFromString(svg, 'image/svg+xml');
  assert.deepEqual(errores, []);
  assert.equal(doc.documentElement.nodeName, 'svg');
  assert.equal(doc.documentElement.getAttribute('xmlns'), 'http://www.w3.org/2000/svg');
  return doc;
}

describe('FASE 15: tamaño del QR frente a la superficie útil 60 × 30.7 mm', () => {
  test('10-11. se elige el MAYOR candidato que cabe limpiamente: 24 mm (0.5333 mm/módulo); 24.5 y 25 no caben', () => {
    const evaluados = QR_TAMANOS_CANDIDATOS_MM.map((size) => ({ size, ...evaluarTamanoQr(45, size) }));
    const caben = evaluados.filter((e) => e.cabe).map((e) => e.size);
    assert.deepEqual(caben, [23, 23.5, 24]);
    assert.equal(QR_EXPORT.sizeMm, Math.max(...caben));
    assert.equal(QR_EXPORT.sizeMm, 24);
    for (const e of evaluados.filter((x) => !x.cabe)) assert.equal(e.motivo, 'MARGEN_INFERIOR_INSUFICIENTE');
    const elegido = evaluados.find((e) => e.size === 24);
    assert.ok(Math.abs(elegido.moduloMm - 24 / 45) < 1e-12);
    assert.ok(elegido.margenes.inferiorMm >= FRENTE_LAYOUT.margenInferiorMinMm);
    assert.ok(elegido.margenes.superiorMm >= FRENTE_LAYOUT.margenSuperiorMinMm);
  });
});

describe('FASE 15: FRENTE -- SVG maestro por chapeta', () => {
  const { chapetas } = fixtureLote(1);
  const { url, arte, svg } = frenteDe(chapetas[0].codigoVisible, chapetas[0].token);
  const L = arte.layout;

  test('QR_EXPORT único: Q, quiet zone 4, 24 mm', () => {
    assert.deepEqual({ ...QR_EXPORT }, { errorCorrectionLevel: 'Q', margin: 4, sizeMm: 24 });
  });

  test('XML válido con raíz <svg> y exactamente 2 paths (QR + código)', () => {
    const doc = sinErroresXml(svg);
    assert.equal(doc.getElementsByTagName('path').length, 2);
  });

  test('1. frente dentro de 60 × 30.7 mm (lienzo 57.0667 × 29.8667 mm, ≤ 58 × 30)', () => {
    assert.equal(attr(svg, 'width'), '57.0667mm');
    assert.equal(attr(svg, 'height'), '29.8667mm');
    assert.equal(attr(svg, 'viewBox'), '0 0 107 56');
    assert.ok(L.anchoMm <= FRENTE_LAYOUT.maxAnchoMm && L.altoMm <= FRENTE_LAYOUT.maxAltoMm);
    assert.ok(L.anchoMm <= CHAPETA_AREA_UTIL_MM.ancho && L.altoMm <= CHAPETA_AREA_UTIL_MM.alto);
    assert.equal(attr(svg, 'preserveAspectRatio'), 'xMidYMid meet');
    assert.equal(attr(svg, 'shape-rendering'), 'crispEdges');
  });

  test('2-3. QR centrado horizontalmente; código visible centrado DEBAJO del QR', () => {
    assert.deepEqual({ ...L.qr }, { x: 31, y: 2, lado: 45 });
    assert.equal(L.qr.x * 2 + L.qr.lado, L.ancho);
    const c = arte.codigo.bbox;
    assert.ok(Math.abs((c.x1 + c.x2) / 2 - L.ancho / 2) < 0.25, 'código centrado');
    assert.ok(c.y1 >= L.qr.y + L.qr.lado, 'código bajo la zona del QR');
    assert.ok(c.y2 <= L.alto);
  });

  test('4-5. sin marca, logo, web ni elementos comerciales en el frente', () => {
    assert.doesNotMatch(svg, /id="(marca|by-crh|vertical|web)"/);
    assert.equal((svg.match(/<path /g) || []).length, 2);
    assert.deepEqual([...svg.matchAll(/<path id="([^"]+)"/g)].map((m) => m[1]), ['qr', 'codigo-visible']);
  });

  test('6-9. ECC Q, versión 5, matriz 37×37, quiet zone 4, total 45×45 (URL de 59 caracteres)', () => {
    assert.equal(url.length, 59);
    const matrix = buildQrMatrix(url);
    assert.equal(matrix.ecc, 'Q');
    assert.equal(matrix.version, 5);
    assert.equal(matrix.size, 37);
    assert.equal(matrix.margin, 4);
    assert.equal(matrix.total, 45);
  });

  test('10-11. QR de 24 mm exactos: 45 módulos de 0.5333 mm', () => {
    assert.equal(L.qr.lado / L.unidadesPorMm, 24);
    assert.ok(Math.abs(L.moduloMm - 0.533333) < 1e-6);
    assert.ok(Math.abs(Number.parseFloat(attr(svg, 'width')) / L.ancho - L.moduloMm) < 1e-6);
  });

  test('12. ningún elemento invade la quiet zone ni la zona del QR', () => {
    const matrix = buildQrMatrix(url);
    for (let y = 0; y < matrix.total; y += 1) {
      for (let x = 0; x < matrix.total; x += 1) {
        if (x < 4 || y < 4 || x >= matrix.total - 4 || y >= matrix.total - 4) assert.equal(matrix.bits[y * matrix.total + x], 0);
      }
    }
    const c = arte.codigo.bbox;
    const cruza = c.x1 < L.qr.x + L.qr.lado && c.x2 > L.qr.x && c.y1 < L.qr.y + L.qr.lado && c.y2 > L.qr.y;
    assert.equal(cruza, false);
  });

  test('13-14. código visible en paths (nunca como texto), altura 3 mm ≥ mínimo 2.5 mm; peor caso del alfabeto sin reducir', () => {
    assert.ok(!svg.includes(chapetas[0].codigoVisible));
    assert.equal(arte.codigo.capMm, 3);
    const altoMm = (arte.codigo.bbox.y2 - arte.codigo.bbox.y1) / L.unidadesPorMm;
    assert.ok(altoMm >= FRENTE_LAYOUT.codigo.capMinimoMm && altoMm <= 3.2, String(altoMm));
    const peor = buildChapetaArte({ codigoVisible: codigoPeorCaso(), url });
    assert.equal(peor.codigo.capMm, 3, 'AGX-WWWW-WWWW-W cabe a 3 mm');
    assert.ok(peor.codigo.bbox.x1 >= FRENTE_LAYOUT.margenLateralMinMm * L.unidadesPorMm);
    assert.ok(peor.codigo.bbox.x2 <= L.ancho - FRENTE_LAYOUT.margenLateralMinMm * L.unidadesPorMm);
  });

  test('otro código visible no verifica (QR y código del mismo archivo)', () => {
    const otro = generateCodigoVisible();
    assert.notEqual(otro, chapetas[0].codigoVisible);
    assert.throws(() => verificarArteSvg({ svg, url, codigoVisible: otro }), { code: 'EXPORT_VERIFICATION_FAILED', detalle: 'CODIGO_VISIBLE_GEOMETRIA' });
  });

  test('17-19. solo fill #000000: 0 stroke, 0 <image>, 0 <text>, sin fondo ni filtros', () => {
    for (const p of [...svg.matchAll(/<path [^>]*>/g)].map((m) => m[0])) assert.match(p, /^<path id="(qr|codigo-visible)" fill="#000000" d="/);
    assert.doesNotMatch(svg, /stroke/i);
    assert.doesNotMatch(svg, /<image/i);
    assert.doesNotMatch(svg, /<text|<tspan|font-family/i);
    assert.doesNotMatch(svg, /<rect|#fff|white|filter|gradient|<style|<script|opacity|href=/i);
  });

  test('SVG solo-QR (vista previa): 24mm × 24mm, viewBox 0 0 45 45, solo rellenos', () => {
    assert.match(renderQrSvg(url), /^<svg [^>]*width="24mm" height="24mm" viewBox="0 0 45 45" preserveAspectRatio="xMidYMid meet" shape-rendering="crispEdges">/);
    assert.doesNotMatch(renderQrSvg(url), /stroke|<image|<rect|#fff/i);
  });

  test('el token no aparece en el SVG ni en la vista previa HTML', () => {
    assert.ok(!svg.includes(chapetas[0].token));
    assert.ok(!svg.includes(url));
    const html = buildProveedorHtml({ lote: { codigoLote: 'LQR-20261018-TEST', urlBase: URL_BASE }, chapetas });
    assert.ok(!html.includes(chapetas[0].token));
    assert.doesNotMatch(html, /<script/i);
  });

  test('matriz reconstruida desde el SVG = matriz generada (bit a bit)', () => {
    const esperada = buildQrMatrix(url);
    assert.deepEqual(Array.from(matrixFromArteSvg(svg, esperada.total)), Array.from(esperada.bits));
  });

  test('15. jsQR (independiente de qrcode) decodifica el frente completo rasterizado a url_qr EXACTA', () => {
    assert.equal(leerQr(rasterSvg(svg, 10)), url);
  });

  test('SVG determinista: mismo input -> mismo archivo', () => {
    assert.equal(sha256Hex(frenteDe(chapetas[0].codigoVisible, chapetas[0].token).svg), sha256Hex(svg));
  });
});

describe('FASE 15: robustez digital del frente de 24 mm (jsQR, tokens fijos)', () => {
  // Resolución simulada de cámara: 6 px/mm (≈ 3.2 px por módulo). La
  // erosión/dilatación de 1 px se aplica a 16 px/mm (≈ 0.06 mm por lado de
  // sangrado del láser, ~12 % del módulo).
  const casos = TOKENS_FIJOS.map((token) => frenteDe('AGX-7KM4-P2XZ-R', token));
  for (const escenario of ['limpio', 'contrasteBajo', 'desenfoque', 'inclinacion', 'combinado']) {
    test(`16. ${escenario} a 6 px/mm -> url_qr exacta`, () => {
      for (const { url, svg } of casos) assert.equal(leerQr(ESCENARIOS[escenario](rasterSvg(svg, 6))), url);
    });
  }
  for (const modo of ['erosionar', 'dilatar']) {
    test(`16. ${modo} ~0.06 mm por lado -> url_qr exacta`, () => {
      for (const { url, svg } of casos) assert.equal(leerQr(morfologia(rasterSvg(svg, 16), modo)), url);
    });
  }
  test('16. reducción de resolución: decodifica hasta 4.5 px/mm (≈ 2.4 px por módulo)', () => {
    for (const { url, svg } of casos) assert.equal(leerQr(rasterSvg(svg, 4.5)), url);
  });
});

describe('FASE 15: REVERSO común', () => {
  const svg = renderReversoSvg();
  const reverso = buildReversoArte();

  test('20. reverso único y determinista (mismo archivo para todo el lote)', () => {
    assert.equal(renderReversoSvg(), svg);
    assert.equal(REVERSO_FILENAME, 'agrogenomax-back.svg');
  });

  test('21. reverso dentro de 60 × 30.7 mm (lienzo 58 × 30 mm) y textos con margen ≥ 1 mm', () => {
    sinErroresXml(svg);
    assert.equal(attr(svg, 'width'), '58mm');
    assert.equal(attr(svg, 'height'), '30mm');
    assert.equal(attr(svg, 'viewBox'), '0 0 58 30');
    assert.equal(verificarReversoSvg(svg), true);
    for (const l of reverso.lineas) {
      assert.ok(l.bbox.x1 >= REVERSO_LAYOUT.margenMinMm && l.bbox.x2 <= 58 - REVERSO_LAYOUT.margenMinMm, l.id);
      assert.ok(l.bbox.y1 >= REVERSO_LAYOUT.margenMinMm && l.bbox.y2 <= 30 - REVERSO_LAYOUT.margenMinMm, l.id);
    }
    // Las líneas no se solapan entre sí.
    const ordenadas = [...reverso.lineas].sort((a, b) => a.bbox.y1 - b.bbox.y1);
    for (let i = 1; i < ordenadas.length; i += 1) assert.ok(ordenadas[i].bbox.y1 > ordenadas[i - 1].bbox.y2 + 0.3, ordenadas[i].id);
  });

  test('identidad: AgroGenomaX, by CRH, Ganadería Inteligente, www.agrogenomax.com -- en contornos, sin QR', () => {
    assert.deepEqual(reverso.lineas.map((l) => l.texto), ['AgroGenomaX', 'by CRH', 'Ganadería Inteligente', 'www.agrogenomax.com']);
    assert.deepEqual([...svg.matchAll(/<path id="([^"]+)" fill="#000000"/g)].map((m) => m[1]), ['marca', 'by-crh', 'vertical', 'web']);
    assert.doesNotMatch(svg, /stroke|<image|<text|<rect|#fff|white|href=/i);
    assert.doesNotMatch(svg, /AgroGenomaX|agrogenomax\.com|Ganader/);
    assert.equal(leerQr(rasterSvg(svg, 8)), null);
  });
});

describe('FASE 15: verificación previa aborta TODO el export', () => {
  test('35. módulo alterado, stroke, QR ajeno, hash distinto, duplicado, sin token, cantidad, legacy, origen', () => {
    const data = fixtureLote(3);
    const { url, svg } = frenteDe(data.chapetas[0].codigoVisible, data.chapetas[0].token);
    const d = svg.match(/<path id="qr" fill="#000000" d="([^"]*)"/)[1];
    const alterado = svg.replace(d, d.replace(/h(\d+)v1h-\1z/, (m, w) => `h${Number(w) + 1}v1h-${Number(w) + 1}z`));
    assert.throws(() => verificarArteSvg({ svg: alterado, url, codigoVisible: data.chapetas[0].codigoVisible }), { code: 'EXPORT_VERIFICATION_FAILED' });
    assert.throws(() => verificarArteSvg({ svg: svg.replace('fill="#000000"', 'fill="#000000" stroke="#000000"'), url, codigoVisible: data.chapetas[0].codigoVisible }), { detalle: 'SVG_CONTIENE_ELEMENTOS_PROHIBIDOS' });
    assert.throws(() => verificarArteSvg({ svg, url: qrUrl(URL_BASE, data.chapetas[1].token), codigoVisible: data.chapetas[0].codigoVisible }), { detalle: 'QR_MATRIZ_DISTINTA' });
    assert.throws(() => verificarReversoSvg(renderReversoSvg().replace('fill="#000000"', 'fill="#ffffff"')), { code: 'EXPORT_VERIFICATION_FAILED' });

    const mutar = (fn) => {
      const copia = structuredClone(data);
      fn(copia);
      return copia;
    };
    assert.throws(() => prepararFabricacion(mutar((c) => { c.chapetas[2].tokenHash = hashQrToken(generateQrToken()); })), { detalle: 'TOKEN_HASH_DISTINTO' });
    assert.throws(() => prepararFabricacion(mutar((c) => { c.chapetas[1].codigoVisible = c.chapetas[0].codigoVisible; })), { detalle: 'CODIGO_VISIBLE_DUPLICADO' });
    assert.throws(() => prepararFabricacion(mutar((c) => { c.chapetas[0].token = null; })), { detalle: 'TOKEN_AUSENTE_O_INVALIDO' });
    assert.throws(() => prepararFabricacion(mutar((c) => { c.chapetas.pop(); })), { detalle: 'CANTIDAD_DISTINTA' });
    assert.throws(() => prepararFabricacion(mutar((c) => { c.lote.tipo = 'QR_LEGACY'; })), { detalle: 'LOTE_NO_QR_AGX' });
    assert.throws(() => prepararFabricacion(mutar((c) => { c.lote.urlBase = 'https://agrogenomax.com/otra'; })), { detalle: 'URL_BASE_INVALIDA' });
  });

  test('35. buildPaqueteFabricacion rechaza sin generar ningún archivo ni filtrar el token', async () => {
    const data = fixtureLote(2);
    data.chapetas[1].tokenHash = 'f'.repeat(64);
    await assert.rejects(buildPaqueteFabricacion(data), (error) => {
      assert.equal(error.code, 'EXPORT_VERIFICATION_FAILED');
      assert.equal(error.status, 500);
      assert.ok(!`${error.message} ${error.detalle}`.includes(data.chapetas[1].token));
      return true;
    });
  });

  test('36. un token cifrado movido a otra fila no descifra (AAD = codigo_visible)', () => {
    const key = crypto.randomBytes(32);
    const [a, b] = fixtureLote(2).chapetas;
    const blobA = encryptQrToken(a.token, a.codigoVisible, key);
    assert.equal(decryptQrToken(blobA, a.codigoVisible, key), a.token);
    assert.throws(() => decryptQrToken(blobA, b.codigoVisible, key));
  });
});

describe('FASE 15: manifest, PDF, checksums y ZIP (lote simulado de 10)', async () => {
  const data = fixtureLote(10);
  const preparado = prepararFabricacion(data);
  const paquete = await buildPaqueteFabricacion(data);
  const pdf = paquete.files['pdf/LQR-20261018-TEST-referencia.pdf'].toString('latin1');
  const backSha = sha256Hex(renderReversoSvg());

  test('nombre <codigo_visible>-front.svg y SHA-256 de cada frente correcto', () => {
    for (const item of preparado.items) {
      assert.equal(item.filename, `${item.codigoVisible}-front.svg`);
      assert.equal(sha256Hex(paquete.files[`front/${item.filename}`]), item.svgSha256);
    }
  });

  test('22-23. manifest: svg_filename = frente; back_filename/back_sha256 comunes y correctos; Q/5/45/24', () => {
    const lines = buildManifestCsv(preparado).trimEnd().split('\r\n');
    assert.equal(lines[0], MANIFEST_COLUMNS.join(','));
    assert.equal(lines[0], 'codigo_lote,codigo_visible,url_qr,svg_filename,svg_sha256,qr_version,ecc,module_count,physical_size_mm,back_filename,back_sha256');
    assert.equal(lines.length - 1, 10);
    lines.slice(1).forEach((line, i) => {
      const chapeta = data.chapetas[i];
      assert.match(line, /^"[^"]*"(,"[^"]*"){10}$/);
      assert.deepEqual(line.slice(1, -1).split('","'), [
        'LQR-20261018-TEST', chapeta.codigoVisible, `${URL_BASE}/qr/${chapeta.token}`, `${chapeta.codigoVisible}-front.svg`,
        sha256Hex(paquete.files[`front/${chapeta.codigoVisible}-front.svg`]), '5', 'Q', '45', '24', 'agrogenomax-back.svg', backSha,
      ]);
    });
    assert.equal(sha256Hex(paquete.files['back/agrogenomax-back.svg']), backSha);
  });

  test('10 frentes únicos (nombre, contenido y hash)', () => {
    const svgs = Object.keys(paquete.files).filter((p) => p.startsWith('front/'));
    assert.equal(svgs.length, 10);
    assert.equal(new Set(svgs.map((p) => sha256Hex(paquete.files[p]))).size, 10);
  });

  test('CSV sin formula injection: = + - @ tab neutralizados y todo entrecomillado', () => {
    assert.equal(csvField('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
    for (const peligroso of ['+1', '-1', '@SUM(A1)', '\tx', '\rx']) assert.ok(csvField(peligroso).startsWith(`"'`));
    assert.equal(csvField('AGX-7KM4-P2XZ-R'), '"AGX-7KM4-P2XZ-R"');
  });

  test('26. PDF 100 % vectorial: sin imágenes raster, con rellenos', () => {
    assert.ok(pdf.startsWith('%PDF-'));
    assert.doesNotMatch(pdf, /\/Subtype \/Image|\/XObject|\/DCTDecode|\/FlateDecode/);
    assert.ok((pdf.match(/ 1 re\n/g) || []).length > 1000);
  });

  test('25. PDF muestra FRENTE (misma geometría QR) y REVERSO (mismos contornos) a escala 1:1', () => {
    const bloques = bloquesPdf(pdf);
    const frentes = bloques.filter((b) => b.runs.length > 0);
    const reversos = bloques.filter((b) => b.runs.length === 0);
    assert.equal(frentes.length, 10);
    assert.equal(reversos.length, 10);
    frentes.forEach((bloque, i) => {
      const item = preparado.items[i];
      assert.ok(Math.abs(bloque.escala - PT_POR_MM / item.arte.layout.unidadesPorMm) < 1e-5);
      const { x: qx, y: qy, lado } = item.arte.layout.qr;
      assert.deepEqual(bloque.runs, item.arte.runs.map((r) => ({ x: r.x + qx, y: r.y + qy, w: r.w })));
      const bits = new Uint8Array(lado * lado);
      for (const r of bloque.runs) for (let k = 0; k < r.w; k += 1) bits[(r.y - qy) * lado + (r.x - qx + k)] = 1;
      assert.deepEqual(Array.from(bits), Array.from(matrixFromArteSvg(item.svg, lado)));
    });
    for (const b of reversos) assert.ok(Math.abs(b.escala - PT_POR_MM) < 1e-5);
    const textos = textosPdf(pdf);
    for (const item of preparado.items) assert.ok(textos.includes(`FRENTE \xb7 ${item.codigoVisible}`));
    assert.ok(textos.includes('REVERSO (com\xfan)'));
    assert.ok(textos.includes('60 \xd7 30.7 mm'));
  });

  test('regla de control de 10 mm y nota "al 100 % — no ajustar a página"', () => {
    const anchos = [...pdf.matchAll(/^[\d.]+ [\d.]+ ([\d.]+) [\d.]+ re$/gm)].map((m) => Number(m[1]));
    assert.ok(anchos.some((w) => Math.abs(w - 10 * PT_POR_MM) < 1e-4));
    const textos = textosPdf(pdf);
    assert.ok(textos.includes('Visualizar / imprimir al 100 % \x97 no ajustar a p\xe1gina'));
    assert.ok(textos.includes('10 mm'));
  });

  test('ningún token en PDF, README, SVG ni CHECKSUMS', () => {
    for (const [path, buffer] of Object.entries(paquete.files)) {
      if (path === 'manifest.csv') continue;
      const texto = buffer.toString('latin1');
      for (const chapeta of data.chapetas) {
        assert.ok(!texto.includes(chapeta.token), path);
        assert.ok(!textosPdf(texto).includes(chapeta.token), path);
      }
    }
  });

  test('CHECKSUMS.sha256 cubre frentes, reverso, manifest, PDF y README y coincide', () => {
    const lineas = paquete.files['CHECKSUMS.sha256'].toString('utf8').trimEnd().split('\n');
    assert.deepEqual(lineas.map((l) => l.split('  ')[1]), nombresPaquete(data.lote, preparado.items).filter((p) => p !== 'CHECKSUMS.sha256'));
    for (const linea of lineas) {
      const [hash, path] = linea.split('  ');
      assert.equal(hash, sha256Hex(paquete.files[path]), path);
    }
    assert.ok(lineas.includes(`${backSha}  back/agrogenomax-back.svg`));
  });

  test('24. ZIP: N frentes + 1 reverso + PDF + manifest + README + CHECKSUMS; SHA-256 del ZIP correcto', async () => {
    assert.equal(paquete.filename, 'LQR-20261018-TEST-fabricacion.zip');
    assert.equal(paquete.sha256, sha256Hex(paquete.buffer));
    const zip = await JSZip.loadAsync(paquete.buffer);
    const archivos = Object.values(zip.files).filter((f) => !f.dir).map((f) => f.name).sort();
    assert.deepEqual(archivos, nombresPaquete(data.lote, preparado.items).map((p) => `LQR-20261018-TEST/${p}`));
    assert.equal(archivos.filter((n) => n.includes('/front/')).length, 10);
    assert.deepEqual(archivos.filter((n) => n.includes('/back/')), ['LQR-20261018-TEST/back/agrogenomax-back.svg']);
    assert.equal(archivos.length, 15);
    for (const nombre of archivos) {
      const contenido = await zip.file(nombre).async('nodebuffer');
      assert.ok(contenido.equals(paquete.files[nombre.replace('LQR-20261018-TEST/', '')]), nombre);
    }
  });

  test('README del proveedor: frente/reverso y reglas de fabricación explícitas', () => {
    const readme = paquete.files['README_PROVEEDOR.txt'].toString('utf8');
    for (const regla of ['<codigo_visible>-front.svg', 'agrogenomax-back.svg', 'Respetar frente y reverso', 'al 100 %', 'NO redimensionar ni deformar',
      'NO invertir colores', 'NO suavizar', 'NO convertir los módulos del QR en contornos/strokes', 'NO regenerar el QR',
      'NO modificar la URL', 'DEL MISMO ARCHIVO', 'cantidad autorizada por escrito por AgroGenomaX', 'podrá solicitar una muestra física', 'Borrar el ZIP', '60.0 x 30.7 mm']) {
      assert.ok(readme.includes(regla), regla);
    }
    assert.doesNotMatch(readme, /UNA SOLA muestra/);
  });

  test('buildReferenciaPdf reutilizable con el mismo preparado', async () => {
    assert.equal(bloquesPdf((await buildReferenciaPdf(preparado)).toString('latin1')).length, 20);
  });
});
