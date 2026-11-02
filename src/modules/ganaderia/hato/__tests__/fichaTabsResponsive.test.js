// FASE 4B.1: barra de pestañas de la ficha (Resumen, Pesajes, Reproducción,
// Actividad) en móvil. Regresión del recorte de "Actividad" a 320 px: la
// barra medía 248 px, el texto ~257 px y con min-width: 0 los botones se
// encogían por debajo de su texto. Sin jsdom: se modela la cascada REAL de
// ganaderia-hato.css (base + media queries en orden de aparición) y se
// compara con los anchos de barra medidos en la ficha de producción.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HATO_DIR = path.resolve(__dirname, '..');
const css = fs.readFileSync(path.resolve(HATO_DIR, '..', 'styles', 'ganaderia-hato.css'), 'utf8')
  .replace(/\r\n/g, '\n')
  .replace(/\/\*[\s\S]*?\*\//g, '');
const detalle = fs.readFileSync(path.join(HATO_DIR, 'HatoDetallePage.jsx'), 'utf8').replace(/\r\n/g, '\n');

const TAB = ".gan-hato-tabs [role='tab']";
const BARRA = '.gan-hato-tabs';
const REM = 16;

// Ancho de la barra en la ficha de producción (clientWidth medido, 4B.1).
const BARRA_REAL = Object.freeze({ 320: 248, 360: 273, 375: 288, 414: 327, 479: 392, 480: 393, 600: 513, 768: 673, 1280: 878 });
// Ancho del texto de cada etiqueta medido a 13.12 px (0.82rem), sin letter-spacing.
const TEXTO_13_12 = Object.freeze({ Resumen: 59, Pesajes: 49.3, 'Reproducción': 88.2, Actividad: 60.1 });
const ETIQUETAS = Object.keys(TEXTO_13_12);

/** Reglas { media: { tipo: 'max'|'min', px }|null, selector, decl } en orden de fuente. */
function reglas(fuente) {
  const out = [];
  const re = /@media \((max|min)-width: (\d+)px\) \{|([^{}@]+)\{([^{}]*)\}|\}/g;
  let media = null;
  let m;
  while ((m = re.exec(fuente))) {
    if (m[1]) media = { tipo: m[1], px: Number(m[2]) };
    else if (m[3] !== undefined) {
      const decl = {};
      for (const linea of m[4].split(';')) {
        const i = linea.indexOf(':');
        if (i > 0) decl[linea.slice(0, i).trim()] = linea.slice(i + 1).trim();
      }
      for (const selector of m[3].split(',').map((s) => s.trim())) out.push({ media, selector, decl });
    } else media = null;
  }
  return out;
}
const REGLAS = reglas(css);

function efectivo(selector, ancho) {
  const r = {};
  for (const regla of REGLAS) {
    if (regla.selector !== selector) continue;
    if (regla.media?.tipo === 'max' && ancho > regla.media.px) continue;
    if (regla.media?.tipo === 'min' && ancho < regla.media.px) continue;
    Object.assign(r, regla.decl);
  }
  return r;
}

function px(valor, fs) {
  if (!valor || valor === 'normal' || valor === '0') return 0;
  if (valor.endsWith('rem')) return parseFloat(valor) * REM;
  if (valor.endsWith('em')) return parseFloat(valor) * fs;
  if (valor.endsWith('px')) return parseFloat(valor);
  throw new Error(`unidad no soportada: ${valor}`);
}

/** Ancho que necesitan las cuatro pestañas (texto + padding + gap) a un ancho de viewport. */
function anchoNecesario(ancho) {
  const tab = efectivo(TAB, ancho);
  const barra = efectivo(BARRA, ancho);
  const fs = px(tab['font-size'], 0);
  const [, padX = '0'] = tab.padding.split(/\s+/);
  const ls = px(tab['letter-spacing'] ?? 'normal', fs);
  const texto = ETIQUETAS.reduce((suma, e) => suma + TEXTO_13_12[e] * (fs / 13.12) + e.length * ls, 0);
  return { fs, necesario: texto + ETIQUETAS.length * 2 * px(padX, fs) + (ETIQUETAS.length - 1) * px(barra.gap, fs), tab, barra };
}

test('las cuatro pestañas de la ficha siguen siendo las esperadas', () => {
  for (const etiqueta of ETIQUETAS) assert.match(detalle, new RegExp(`label: '${etiqueta}'`));
});

test('320/360/375/414/479/480/600/768/1280: las cuatro caben completas en la barra real, con margen', () => {
  for (const [ancho, barra] of Object.entries(BARRA_REAL)) {
    const { necesario, fs } = anchoNecesario(Number(ancho));
    assert.ok(necesario <= barra - 4, `${ancho}px: necesitan ${necesario.toFixed(1)}px y la barra mide ${barra}px`);
    // Nunca una tipografía ilegible para "caber".
    assert.ok(fs >= 12, `${ancho}px: font-size ${fs}px`);
  }
});

test('320 px: ya no se reproduce el recorte (antes ~257 px de texto en 248 px)', () => {
  const { necesario } = anchoNecesario(320);
  assert.ok(necesario <= 244, `320px necesita ${necesario.toFixed(1)}px`);
});

test('en móvil un botón nunca es más estrecho que su texto (sin recorte ni solape)', () => {
  for (const ancho of [320, 360, 375, 414, 479, 480, 600]) {
    const tab = efectivo(TAB, ancho);
    assert.equal(tab['min-width'], 'max-content', `${ancho}px min-width`);
    assert.equal(tab['white-space'], 'nowrap', `${ancho}px white-space`);
    assert.match(tab.flex, /^1 0 /, `${ancho}px: no se encoge (flex-shrink 0)`);
  }
});

test('sin ellipsis, texto oculto, zoom, scale ni anchos fijos en las pestañas', () => {
  for (const regla of REGLAS.filter((r) => r.selector.startsWith(TAB) || r.selector === BARRA)) {
    const decl = regla.decl;
    assert.notEqual(decl['text-overflow'], 'ellipsis', regla.selector);
    assert.ok(!('zoom' in decl), regla.selector);
    assert.doesNotMatch(decl.transform ?? '', /scale/, regla.selector);
    if (regla.selector.startsWith(TAB)) {
      assert.notEqual(decl.overflow, 'hidden', regla.selector);
      assert.doesNotMatch(decl.width ?? '', /px/, regla.selector);
      assert.doesNotMatch(decl['max-width'] ?? '', /px/, regla.selector);
    }
  }
});

test('barra usable: scroll horizontal solo de respaldo y con barra visible (nunca oculta)', () => {
  for (const ancho of [320, 768]) {
    const barra = efectivo(BARRA, ancho);
    assert.equal(barra['overflow-x'], 'auto');
    assert.notEqual(barra['scrollbar-width'], 'none');
  }
});

test('foco visible: outline hacia dentro (el overflow de la barra no lo recorta); activa marcada', () => {
  const foco = efectivo(".gan-hato-tabs [role='tab']:focus-visible", 320);
  assert.match(foco.outline, /3px solid/);
  assert.ok(parseFloat(foco['outline-offset']) < 0, foco['outline-offset']);
  assert.match(efectivo(".gan-hato-tabs [role='tab'].is-active", 320)['border-bottom-color'], /#9cff1a/);
});

test('accesibilidad de las pestañas intacta (role=tab, aria-selected, roving tabindex, flechas)', () => {
  assert.match(detalle, /role="tablist" aria-label="Secciones del animal"/);
  assert.match(detalle, /role="tab"/);
  assert.match(detalle, /aria-selected=\{activa === p\.id\}/);
  assert.match(detalle, /tabIndex=\{activa === p\.id \? 0 : -1\}/);
  assert.match(detalle, /ArrowRight:/);
  assert.match(detalle, /ArrowLeft:/);
});
