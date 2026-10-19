// FASE 15: paquete maestro de fabricación láser -- SVG maestro (solo
// rellenos, tamaño físico real, quiet zone 4), PDF vectorial con la misma
// geometría, manifest, checksums, ZIP y verificación que aborta el export.
// La decodificación usa jsQR sobre un raster en memoria de NUESTRO SVG
// (independiente de la librería qrcode que generó la matriz).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { DOMParser } from '@xmldom/xmldom';
import jsQR from 'jsqr';
import JSZip from 'jszip';

import {
  ARTE_LAYOUT,
  QR_EXPORT,
  buildChapetaArte,
  buildQrMatrix,
  codigoPeorCaso,
  matrixFromArteSvg,
  renderArteSvg,
  renderQrSvg,
  verificarArteSvg,
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

const URL_BASE = 'https://agrogenomax.com';

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

function svgDe(chapeta) {
  const url = qrUrl(URL_BASE, chapeta.token);
  return { url, svg: renderArteSvg(buildChapetaArte({ codigoVisible: chapeta.codigoVisible, url })) };
}

function attr(svg, name) {
  return svg.match(new RegExp(`<svg [^>]*\\b${name}="([^"]*)"`))?.[1];
}

/** Raster RGBA en memoria del path QR de nuestro SVG (blanco = sin grabar). */
function rasterQr(svg, pxPorModulo = 6) {
  const [, , ancho, alto] = attr(svg, 'viewBox').split(' ').map(Number);
  const d = svg.match(/<path id="qr" fill="#000000" d="([^"]*)"/)[1];
  const w = ancho * pxPorModulo;
  const h = alto * pxPorModulo;
  const data = new Uint8ClampedArray(w * h * 4).fill(255);
  for (const tramo of d.split('z').filter(Boolean)) {
    const [, x, y, ww] = tramo.match(/^M(\d+) (\d+)h(\d+)v1h-\d+$/).map(Number);
    for (let py = y * pxPorModulo; py < (y + 1) * pxPorModulo; py += 1) {
      for (let px = x * pxPorModulo; px < (x + ww) * pxPorModulo; px += 1) {
        const i = (py * w + px) * 4;
        data[i] = 0;
        data[i + 1] = 0;
        data[i + 2] = 0;
      }
    }
  }
  return { data, w, h };
}

function textosPdf(pdf) {
  const hex = [...pdf.matchAll(/<([0-9a-f]+)>/g)].map((m) => Buffer.from(m[1], 'hex').toString('latin1'));
  return hex.join('');
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

describe('FASE 15: SVG maestro por chapeta', () => {
  const { chapetas } = fixtureLote(1);
  const { url, svg } = svgDe(chapetas[0]);

  test('QR_EXPORT único: Q, quiet zone 4, 30 mm', () => {
    assert.deepEqual({ ...QR_EXPORT }, { errorCorrectionLevel: 'Q', margin: 4, sizeMm: 30 });
  });

  test('1. XML válido (xmldom sin errores) con raíz <svg> SVG 1.1', () => {
    const errores = [];
    const doc = new DOMParser({ onError: (nivel, msg) => errores.push(`${nivel}: ${msg}`) }).parseFromString(svg, 'image/svg+xml');
    assert.deepEqual(errores, []);
    assert.equal(doc.documentElement.nodeName, 'svg');
    assert.equal(doc.documentElement.getAttribute('xmlns'), 'http://www.w3.org/2000/svg');
    assert.equal(doc.getElementsByTagName('path').length, 3);
  });

  test('2-4. sin <image>, sin stroke, sin <text>, sin filtros/degradados/estilos', () => {
    assert.doesNotMatch(svg, /<image/i);
    assert.doesNotMatch(svg, /stroke/i);
    assert.doesNotMatch(svg, /<text|<tspan|font-family/i);
    assert.doesNotMatch(svg, /filter|gradient|<style|<script|opacity|href=/i);
  });

  test('5-6. todos los elementos son paths rellenos #000000; sin fondo ni <rect> blanco', () => {
    const paths = [...svg.matchAll(/<path [^>]*>/g)].map((m) => m[0]);
    assert.equal(paths.length, 3);
    for (const p of paths) assert.match(p, /^<path id="(marca|qr|codigo-visible)" fill="#000000" d="/);
    assert.doesNotMatch(svg, /<rect|#fff|white|fill="(?!#000000)/i);
    const matrix = buildQrMatrix(url);
    // La quiet zone queda vacía: ningún módulo en las 4 filas/columnas exteriores.
    for (let y = 0; y < matrix.total; y += 1) {
      for (let x = 0; x < matrix.total; x += 1) {
        const enMargen = x < 4 || y < 4 || x >= matrix.total - 4 || y >= matrix.total - 4;
        if (enMargen) assert.equal(matrix.bits[y * matrix.total + x], 0);
      }
    }
  });

  test('7-11. ECC Q, versión 5, matriz 37×37, quiet zone 4, total 45×45 (URL de 59 caracteres)', () => {
    assert.equal(url.length, 59);
    const matrix = buildQrMatrix(url);
    assert.equal(matrix.ecc, 'Q');
    assert.equal(matrix.version, 5);
    assert.equal(matrix.size, 37);
    assert.equal(matrix.margin, 4);
    assert.equal(matrix.total, 45);
  });

  test('12. tamaño físico real: QR = 30 mm exactos; lienzo 50 × 46 mm en mm', () => {
    assert.equal(attr(svg, 'width'), '50mm');
    assert.equal(attr(svg, 'height'), '46mm');
    assert.equal(attr(svg, 'viewBox'), '0 0 75 69');
    assert.equal(attr(svg, 'preserveAspectRatio'), 'xMidYMid meet');
    assert.equal(attr(svg, 'shape-rendering'), 'crispEdges');
    const mmPorUnidad = 50 / 75;
    assert.equal(45 * mmPorUnidad, 30);
    assert.ok(Math.abs(mmPorUnidad - 30 / 45) < 1e-12);
    const arte = buildChapetaArte({ codigoVisible: chapetas[0].codigoVisible, url });
    assert.deepEqual({ ...arte.layout.qr }, { x: 15, y: 9, lado: 45 });
  });

  test('SVG solo-QR (vista previa): width/height 30mm, viewBox 0 0 45 45, misma matriz', () => {
    const qrSvg = renderQrSvg(url);
    assert.match(qrSvg, /^<svg [^>]*width="30mm" height="30mm" viewBox="0 0 45 45" preserveAspectRatio="xMidYMid meet" shape-rendering="crispEdges">/);
    assert.doesNotMatch(qrSvg, /stroke|<image|<rect|#fff/i);
  });

  test('13. codigo_visible correcto en paths (y nunca como texto); otro código no verifica', () => {
    assert.doesNotThrow(() => verificarArteSvg({ svg, url, codigoVisible: chapetas[0].codigoVisible }));
    assert.ok(!svg.includes(chapetas[0].codigoVisible));
    const otro = generateCodigoVisible();
    assert.notEqual(otro, chapetas[0].codigoVisible);
    assert.throws(() => verificarArteSvg({ svg, url, codigoVisible: otro }), { code: 'EXPORT_VERIFICATION_FAILED', detalle: 'CODIGO_VISIBLE_GEOMETRIA' });
  });

  test('zona reservada 30 × 30 mm: marca y código fuera del QR y dentro del lienzo', () => {
    const arte = buildChapetaArte({ codigoVisible: chapetas[0].codigoVisible, url });
    const qr = arte.layout.qr;
    for (const caja of [arte.marca.bbox, arte.codigo.bbox]) {
      const cruza = caja.x1 < qr.x + qr.lado && caja.x2 > qr.x && caja.y1 < qr.y + qr.lado && caja.y2 > qr.y;
      assert.equal(cruza, false);
      assert.ok(caja.x1 >= 0 && caja.y1 >= 0 && caja.x2 <= arte.layout.ancho && caja.y2 <= arte.layout.alto);
    }
    assert.ok(arte.marca.bbox.y2 <= qr.y);
    assert.ok(arte.codigo.bbox.y1 >= qr.y + qr.lado);
  });

  test('código visible ~4 mm de alto; el peor caso del alfabeto (todo W) cabe sin bajar de 3 mm', () => {
    const arte = buildChapetaArte({ codigoVisible: chapetas[0].codigoVisible, url });
    const altoMm = (arte.codigo.bbox.y2 - arte.codigo.bbox.y1) / arte.layout.unidadesPorMm;
    assert.ok(altoMm > 3 && altoMm <= ARTE_LAYOUT.codigo.capMm + 0.2, String(altoMm));
    const peor = codigoPeorCaso();
    const artePeor = buildChapetaArte({ codigoVisible: peor.codigo, url });
    const anchoMm = (artePeor.codigo.bbox.x2 - artePeor.codigo.bbox.x1) / artePeor.layout.unidadesPorMm;
    assert.ok(anchoMm <= ARTE_LAYOUT.anchoMm - 2 * ARTE_LAYOUT.margenLateralMm + 0.01, String(anchoMm));
  });

  test('18. el token no aparece como texto en el SVG ni en la vista previa HTML', () => {
    assert.ok(!svg.includes(chapetas[0].token));
    assert.ok(!svg.includes(url));
    const html = buildProveedorHtml({ lote: { codigoLote: 'LQR-20261018-TEST', urlBase: URL_BASE }, chapetas });
    assert.ok(!html.includes(chapetas[0].token));
    assert.doesNotMatch(html, /<script/i);
  });

  test('19. jsQR (independiente de qrcode) decodifica el raster de nuestro SVG a url_qr EXACTA', () => {
    const { data, w, h } = rasterQr(svg);
    const leido = jsQR(data, w, h, { inversionAttempts: 'dontInvert' });
    assert.ok(leido, 'jsQR no encontró el QR');
    assert.equal(leido.data, url);
    assert.equal(leido.version, 5);
  });

  test('20. matriz reconstruida desde el SVG = matriz generada (bit a bit)', () => {
    const esperada = buildQrMatrix(url);
    const reconstruida = matrixFromArteSvg(svg, esperada.total);
    assert.ok(reconstruida);
    assert.deepEqual(Array.from(reconstruida), Array.from(esperada.bits));
  });

  test('SVG determinista: mismo input -> mismo archivo y mismo SHA-256', () => {
    assert.equal(sha256Hex(svgDe(chapetas[0]).svg), sha256Hex(svg));
  });
});

describe('FASE 15: verificación previa aborta TODO el export', () => {
  test('35. un módulo alterado, un token cuyo hash no coincide o un código duplicado abortan', () => {
    const data = fixtureLote(3);
    const { url, svg } = svgDe(data.chapetas[0]);
    const d = svg.match(/<path id="qr" fill="#000000" d="([^"]*)"/)[1];
    const alterado = svg.replace(d, d.replace(/h(\d+)v1h-\1z/, (m, w) => `h${Number(w) + 1}v1h-${Number(w) + 1}z`));
    assert.throws(() => verificarArteSvg({ svg: alterado, url, codigoVisible: data.chapetas[0].codigoVisible }), { code: 'EXPORT_VERIFICATION_FAILED' });
    assert.throws(() => verificarArteSvg({ svg: svg.replace('fill="#000000"', 'fill="#000000" stroke="#000000"'), url, codigoVisible: data.chapetas[0].codigoVisible }), { detalle: 'SVG_CONTIENE_ELEMENTOS_PROHIBIDOS' });
    // QR de OTRA chapeta con el código de ésta -> no coincide.
    assert.throws(() => verificarArteSvg({ svg, url: svgDe(data.chapetas[1]).url, codigoVisible: data.chapetas[0].codigoVisible }), { detalle: 'QR_MATRIZ_DISTINTA' });

    const hashMalo = structuredClone(data);
    hashMalo.chapetas[2].tokenHash = hashQrToken(generateQrToken());
    assert.throws(() => prepararFabricacion(hashMalo), { code: 'EXPORT_VERIFICATION_FAILED', detalle: 'TOKEN_HASH_DISTINTO' });

    const duplicado = structuredClone(data);
    duplicado.chapetas[1].codigoVisible = duplicado.chapetas[0].codigoVisible;
    assert.throws(() => prepararFabricacion(duplicado), { detalle: 'CODIGO_VISIBLE_DUPLICADO' });

    const sinToken = structuredClone(data);
    sinToken.chapetas[0].token = null;
    assert.throws(() => prepararFabricacion(sinToken), { detalle: 'TOKEN_AUSENTE_O_INVALIDO' });

    const incompleto = structuredClone(data);
    incompleto.chapetas.pop();
    assert.throws(() => prepararFabricacion(incompleto), { detalle: 'CANTIDAD_DISTINTA' });

    const legacy = structuredClone(data);
    legacy.lote.tipo = 'QR_LEGACY';
    assert.throws(() => prepararFabricacion(legacy), { detalle: 'LOTE_NO_QR_AGX' });

    const origen = structuredClone(data);
    origen.lote.urlBase = 'https://agrogenomax.com/otra';
    assert.throws(() => prepararFabricacion(origen), { detalle: 'URL_BASE_INVALIDA' });
  });

  test('35. buildPaqueteFabricacion rechaza sin generar ningún archivo', async () => {
    const data = fixtureLote(2);
    data.chapetas[1].tokenHash = 'f'.repeat(64);
    await assert.rejects(buildPaqueteFabricacion(data), (error) => {
      assert.equal(error.code, 'EXPORT_VERIFICATION_FAILED');
      assert.equal(error.status, 500);
      assert.ok(!String(error.message).includes(data.chapetas[1].token));
      assert.ok(!String(error.detalle).includes(data.chapetas[1].token));
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
  const pdfBuffer = paquete.files['pdf/LQR-20261018-TEST-referencia.pdf'];
  const pdf = pdfBuffer.toString('latin1');

  test('14-15. nombre <codigo_visible>.svg y SHA-256 del SVG correcto', () => {
    for (const item of preparado.items) {
      assert.equal(item.filename, `${item.codigoVisible}.svg`);
      assert.equal(item.svgSha256, sha256Hex(item.svg));
      assert.equal(sha256Hex(paquete.files[`svg/${item.filename}`]), item.svgSha256);
    }
  });

  test('16. manifest coherente: columnas, filas = archivos = cantidad, valores Q/5/45/30', () => {
    const lines = buildManifestCsv(preparado).trimEnd().split('\r\n');
    assert.equal(lines[0], MANIFEST_COLUMNS.join(','));
    assert.equal(lines[0], 'codigo_lote,codigo_visible,url_qr,svg_filename,svg_sha256,qr_version,ecc,module_count,physical_size_mm');
    assert.equal(lines.length - 1, 10);
    lines.slice(1).forEach((line, i) => {
      const campos = line.slice(1, -1).split('","');
      const chapeta = data.chapetas[i];
      assert.equal(campos.length, 9);
      assert.match(line, /^"[^"]*"(,"[^"]*"){8}$/);
      assert.deepEqual(campos, [
        'LQR-20261018-TEST', chapeta.codigoVisible, `${URL_BASE}/qr/${chapeta.token}`, `${chapeta.codigoVisible}.svg`,
        sha256Hex(paquete.files[`svg/${chapeta.codigoVisible}.svg`]), '5', 'Q', '45', '30',
      ]);
    });
    assert.equal(paquete.files['manifest.csv'].toString('utf8'), buildManifestCsv(preparado));
  });

  test('17. 10 SVG únicos (nombre, contenido y hash)', () => {
    const svgs = Object.keys(paquete.files).filter((p) => p.startsWith('svg/'));
    assert.equal(svgs.length, 10);
    assert.equal(new Set(svgs.map((p) => sha256Hex(paquete.files[p]))).size, 10);
  });

  test('27. CSV sin formula injection: = + - @ tab neutralizados y todo entrecomillado', () => {
    assert.equal(csvField('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
    for (const peligroso of ['+1', '-1', '@SUM(A1)', '\tx', '\rx']) assert.ok(csvField(peligroso).startsWith(`"'`));
    assert.equal(csvField('AGX-7KM4-P2XZ-R'), '"AGX-7KM4-P2XZ-R"');
  });

  test('21. PDF 100 % vectorial: sin imágenes raster, con rellenos', () => {
    assert.ok(pdf.startsWith('%PDF-'));
    assert.doesNotMatch(pdf, /\/Subtype \/Image|\/XObject|\/DCTDecode|\/FlateDecode/);
    assert.ok((pdf.match(/ 1 re\n/g) || []).length > 1000);
  });

  test('22. PDF usa la MISMA geometría: tramos QR = SVG, escala 1:1 en mm', () => {
    const bloques = bloquesPdf(pdf);
    assert.equal(bloques.length, 10);
    bloques.forEach((bloque, i) => {
      const item = preparado.items[i];
      assert.ok(Math.abs(bloque.escala - PT_POR_MM / item.arte.layout.unidadesPorMm) < 1e-5);
      const esperados = item.arte.runs.map((r) => ({ x: r.x + item.arte.layout.qr.x, y: r.y + item.arte.layout.qr.y, w: r.w }));
      assert.deepEqual(bloque.runs, esperados);
      // Reconstrucción desde el PDF = matriz del SVG.
      const bits = new Uint8Array(45 * 45);
      for (const r of bloque.runs) for (let k = 0; k < r.w; k += 1) bits[(r.y - 9) * 45 + (r.x - 15 + k)] = 1;
      assert.deepEqual(Array.from(bits), Array.from(matrixFromArteSvg(item.svg, 45)));
      assert.ok(textosPdf(pdf).includes(item.codigoVisible));
    });
  });

  test('23. regla de control de 10 mm y nota "al 100 % — no ajustar a página"', () => {
    const anchos = [...pdf.matchAll(/^[\d.]+ [\d.]+ ([\d.]+) [\d.]+ re$/gm)].map((m) => Number(m[1]));
    assert.ok(anchos.some((w) => Math.abs(w - 10 * PT_POR_MM) < 1e-4));
    const textos = textosPdf(pdf);
    assert.ok(textos.includes('Imprimir / visualizar al 100 % \x97 no ajustar a p\xe1gina'));
    assert.ok(textos.includes('10 mm'));
    assert.ok(textos.includes('LQR-20261018-TEST'));
  });

  test('18. ningún token en el PDF, el README, los SVG ni CHECKSUMS', () => {
    for (const [path, buffer] of Object.entries(paquete.files)) {
      if (path === 'manifest.csv') continue;
      const texto = buffer.toString('latin1');
      for (const chapeta of data.chapetas) {
        assert.ok(!texto.includes(chapeta.token), path);
        assert.ok(!textosPdf(texto).includes(chapeta.token), path);
      }
    }
  });

  test('24. CHECKSUMS.sha256 cubre todos los SVG, manifest, PDF y README y coincide', () => {
    const lineas = paquete.files['CHECKSUMS.sha256'].toString('utf8').trimEnd().split('\n');
    const esperado = nombresPaquete(data.lote, preparado.items).filter((p) => p !== 'CHECKSUMS.sha256');
    assert.deepEqual(lineas.map((l) => l.split('  ')[1]), esperado);
    for (const linea of lineas) {
      const [hash, path] = linea.split('  ');
      assert.equal(hash, sha256Hex(paquete.files[path]), path);
    }
  });

  test('25-26. ZIP con exactamente los archivos esperados; SHA-256 del ZIP correcto', async () => {
    assert.equal(paquete.filename, 'LQR-20261018-TEST-fabricacion.zip');
    assert.equal(paquete.sha256, sha256Hex(paquete.buffer));
    const zip = await JSZip.loadAsync(paquete.buffer);
    const archivos = Object.values(zip.files).filter((f) => !f.dir).map((f) => f.name).sort();
    assert.deepEqual(archivos, nombresPaquete(data.lote, preparado.items).map((p) => `LQR-20261018-TEST/${p}`));
    assert.equal(archivos.length, 14);
    for (const nombre of archivos) {
      const contenido = await zip.file(nombre).async('nodebuffer');
      assert.ok(contenido.equals(paquete.files[nombre.replace('LQR-20261018-TEST/', '')]), nombre);
    }
  });

  test('README del proveedor: reglas de fabricación explícitas', () => {
    const readme = paquete.files['README_PROVEEDOR.txt'].toString('utf8');
    for (const regla of ['al 100 %', 'NO redimensionar', 'NO invertir colores', 'NO suavizar', 'NO convertir el QR a contornos/strokes',
      'NO regenerar el QR', 'NO modificar la URL ni añadir parámetros', 'formas rellenas', 'DEL MISMO ARCHIVO', 'Borrar el ZIP']) {
      assert.ok(readme.includes(regla), regla);
    }
  });

  test('PDF de referencia sin lote: misma salida de buildReferenciaPdf', async () => {
    const otra = await buildReferenciaPdf(preparado);
    assert.equal(bloquesPdf(otra.toString('latin1')).length, 10);
  });
});
