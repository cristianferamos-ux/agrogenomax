// FASE 15 -- utilidades de TEST (no es un archivo de test): rasteriza en
// memoria NUESTROS SVG (paths rellenos: tramos QR y contornos de glifos) a
// una resolución física simulada (px/mm) y aplica degradaciones simples
// para comprobar con jsQR que la lectura no depende de un raster perfecto.
// JavaScript puro: sin canvas ni dependencias nuevas.
import jsQR from 'jsqr';

function attr(svg, name) {
  return svg.match(new RegExp(`<svg [^>]*\\b${name}="([^"]*)"`))?.[1];
}

/** Contornos de un atributo d (M L Q C Z y h/v relativos) -> polígonos aplanados. */
function polygons(d) {
  const t = d.match(/[MLQCZhvz]|-?\d*\.?\d+/g);
  const out = [];
  let cur = null;
  let x = 0;
  let y = 0;
  let i = 0;
  const num = () => Number(t[i++]);
  while (i < t.length) {
    const c = t[i++];
    if (c === 'M') {
      x = num();
      y = num();
      cur = [[x, y]];
      out.push(cur);
    } else if (c === 'L') {
      x = num();
      y = num();
      cur.push([x, y]);
    } else if (c === 'h') {
      x += num();
      cur.push([x, y]);
    } else if (c === 'v') {
      y += num();
      cur.push([x, y]);
    } else if (c === 'Q') {
      const [a, b, ex, ey] = [num(), num(), num(), num()];
      for (let s = 1; s <= 8; s += 1) {
        const u = s / 8;
        const m = 1 - u;
        cur.push([m * m * x + 2 * m * u * a + u * u * ex, m * m * y + 2 * m * u * b + u * u * ey]);
      }
      x = ex;
      y = ey;
    } else if (c === 'C') {
      const [a, b, c2, d2, ex, ey] = [num(), num(), num(), num(), num(), num()];
      for (let s = 1; s <= 10; s += 1) {
        const u = s / 10;
        const m = 1 - u;
        cur.push([m ** 3 * x + 3 * m * m * u * a + 3 * m * u * u * c2 + u ** 3 * ex, m ** 3 * y + 3 * m * m * u * b + 3 * m * u * u * d2 + u ** 3 * ey]);
      }
      x = ex;
      y = ey;
    } else if ((c === 'Z' || c === 'z') && cur) {
      [x, y] = cur[0];
    }
  }
  return out;
}

/**
 * Raster en escala de grises (0 = grabado/negro, 1 = sin grabar) del SVG a
 * `pxPorMm`, con supermuestreo `ss` (antialiasing de cámara) y un borde
 * blanco de `bordeMm` alrededor (fondo de la chapeta).
 */
export function rasterSvg(svg, pxPorMm, { ss = 4, bordeMm = 3 } = {}) {
  const [, , vbW, vbH] = attr(svg, 'viewBox').split(' ').map(Number);
  const anchoMm = Number.parseFloat(attr(svg, 'width'));
  const unidadesPorMm = vbW / anchoMm;
  const borde = bordeMm * unidadesPorMm;
  const escala = (pxPorMm * ss) / unidadesPorMm; // px hi-res por unidad
  const W = Math.round((vbW + 2 * borde) * escala);
  const H = Math.round((vbH + 2 * borde) * escala);
  const edges = [];
  for (const m of svg.matchAll(/ d="([^"]+)"/g)) {
    for (const p of polygons(m[1])) {
      for (let j = 0; j < p.length; j += 1) {
        const [x1, y1] = p[j];
        const [x2, y2] = p[(j + 1) % p.length];
        if (y1 !== y2) edges.push([(x1 + borde) * escala, (y1 + borde) * escala, (x2 + borde) * escala, (y2 + borde) * escala]);
      }
    }
  }
  const hi = new Uint8Array(W * H);
  for (let py = 0; py < H; py += 1) {
    const yy = py + 0.5;
    const xs = [];
    for (const [x1, y1, x2, y2] of edges) {
      if ((y1 <= yy && y2 > yy) || (y2 <= yy && y1 > yy)) xs.push([x1 + ((yy - y1) * (x2 - x1)) / (y2 - y1), y2 > y1 ? 1 : -1]);
    }
    xs.sort((a, b) => a[0] - b[0]);
    let wnd = 0;
    for (let j = 0; j < xs.length - 1; j += 1) {
      wnd += xs[j][1];
      if (wnd === 0) continue;
      for (let px = Math.max(0, Math.ceil(xs[j][0] - 0.5)); px < Math.min(W, xs[j + 1][0] - 0.5); px += 1) hi[py * W + px] = 1;
    }
  }
  const w = Math.floor(W / ss);
  const h = Math.floor(H / ss);
  const gray = new Float32Array(w * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let negro = 0;
      for (let dy = 0; dy < ss; dy += 1) for (let dx = 0; dx < ss; dx += 1) negro += hi[(y * ss + dy) * W + x * ss + dx];
      gray[y * w + x] = 1 - negro / (ss * ss);
    }
  }
  return { w, h, gray };
}

function map(img, fn) {
  return { w: img.w, h: img.h, gray: img.gray.map(fn) };
}

/** Contraste reducido: negro -> `negro`, blanco -> `blanco` (0..1). */
export function contraste(img, negro, blanco) {
  return map(img, (v) => negro + v * (blanco - negro));
}

/** Desenfoque de caja separable de radio r (px). */
export function desenfoque(img, r) {
  const { w, h } = img;
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let s = 0;
      let n = 0;
      for (let k = -r; k <= r; k += 1) {
        const xx = Math.min(w - 1, Math.max(0, x + k));
        s += img.gray[y * w + xx];
        n += 1;
      }
      tmp[y * w + x] = s / n;
    }
  }
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let s = 0;
      let n = 0;
      for (let k = -r; k <= r; k += 1) {
        const yy = Math.min(h - 1, Math.max(0, y + k));
        s += tmp[yy * w + x];
        n += 1;
      }
      out[y * w + x] = s / n;
    }
  }
  return { w, h, gray: out };
}

/** Morfología 1 px: 'dilatar' engrosa el grabado (mín.), 'erosionar' lo adelgaza (máx.). */
export function morfologia(img, modo) {
  const { w, h } = img;
  const out = new Float32Array(w * h);
  const pick = modo === 'dilatar' ? Math.min : Math.max;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let v = img.gray[y * w + x];
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx >= 0 && yy >= 0 && xx < w && yy < h) v = pick(v, img.gray[yy * w + xx]);
      }
      out[y * w + x] = v;
    }
  }
  return { w, h, gray: out };
}

/**
 * Inclinación + perspectiva: rota `grados` y comprime un lado (factor
 * `perspectiva`, p. ej. 0.15) con muestreo bilineal inverso sobre fondo blanco.
 */
export function inclinar(img, grados, perspectiva = 0) {
  const { w, h } = img;
  const out = new Float32Array(w * h).fill(1);
  const a = (grados * Math.PI) / 180;
  const cx = w / 2;
  const cy = h / 2;
  const sample = (x, y) => {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    if (x0 < 0 || y0 < 0 || x0 + 1 >= w || y0 + 1 >= h) return 1;
    const fx = x - x0;
    const fy = y - y0;
    const g = img.gray;
    return (g[y0 * w + x0] * (1 - fx) + g[y0 * w + x0 + 1] * fx) * (1 - fy) + (g[(y0 + 1) * w + x0] * (1 - fx) + g[(y0 + 1) * w + x0 + 1] * fx) * fy;
  };
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      // Perspectiva: el lado derecho se ve más pequeño (escala vertical variable).
      const t = x / w;
      const sv = 1 - perspectiva * t;
      const dx = x - cx;
      const dy = (y - cy) / sv;
      const rx = Math.cos(a) * dx + Math.sin(a) * dy + cx;
      const ry = -Math.sin(a) * dx + Math.cos(a) * dy + cy;
      out[y * w + x] = sample(rx, ry);
    }
  }
  return { w, h, gray: out };
}

/** Decodifica con jsQR; devuelve el texto o null. */
export function leerQr(img) {
  const data = new Uint8ClampedArray(img.w * img.h * 4);
  for (let i = 0; i < img.gray.length; i += 1) {
    const v = Math.round(Math.min(1, Math.max(0, img.gray[i])) * 255);
    data[i * 4] = v;
    data[i * 4 + 1] = v;
    data[i * 4 + 2] = v;
    data[i * 4 + 3] = 255;
  }
  return jsQR(data, img.w, img.h)?.data ?? null;
}

/** Escenarios de degradación aplicados a un raster limpio. */
export const ESCENARIOS = Object.freeze({
  limpio: (img) => img,
  contrasteBajo: (img) => contraste(img, 0.4, 0.75),
  desenfoque: (img) => desenfoque(img, 1),
  erosion: (img) => morfologia(img, 'erosionar'),
  dilatacion: (img) => morfologia(img, 'dilatar'),
  inclinacion: (img) => inclinar(img, 12, 0.15),
  combinado: (img) => inclinar(contraste(desenfoque(img, 1), 0.35, 0.8), 8, 0.1),
});
