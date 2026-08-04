// CATX-PDF-PARITY-002: extractor de texto de PDF mínimo, dependiente
// únicamente de Node estándar -- sin agregar ninguna librería nueva
// (ni pdf-parse ni pdfjs-dist), consistente con el resto del módulo
// (cero dependencias nuevas de composición/lectura de PDF).
//
// PDFKit (con compress:false, ya usado en todo este módulo justamente para
// esto) escribe cada operador de texto (Tj / TJ) con el contenido
// codificado en hexadecimal dentro de <...> -- verificado empíricamente:
// aunque se use una fuente estándar (Helvetica) sin incrustar, PDFKit NUNCA
// escribe el texto como ASCII literal en el content stream, así que un
// grep directo del Buffer nunca encuentra las palabras reales. Este
// extractor decodifica esos hex/literal strings dentro de cada bloque
// BT...ET y los concatena, reconstruyendo el texto visible de cada página
// en el orden en que PDFKit las escribió (un content stream por página,
// identificado por contener al menos un bloque BT...ET -- los demás
// streams del documento son datos binarios de imagen/fuente, nunca
// contienen esa estructura).
function decodeHexString(hex) {
  return Buffer.from(hex, 'hex').toString('latin1');
}

function decodeLiteralString(lit) {
  return lit.replace(/\\(.)/g, '$1');
}

function extractTextFromContentStream(streamText) {
  let out = '';

  const tjRe = /(<[0-9a-fA-F]+>|\([^)]*\))\s*Tj/g;
  let m;
  while ((m = tjRe.exec(streamText))) {
    const tok = m[1];
    out += tok.startsWith('<') ? decodeHexString(tok.slice(1, -1)) : decodeLiteralString(tok.slice(1, -1));
  }

  const tjArrRe = /\[((?:<[0-9a-fA-F]+>|\([^)]*\)|[^[\]])*)\]\s*TJ/g;
  while ((m = tjArrRe.exec(streamText))) {
    const inner = m[1];
    const tokRe = /<[0-9a-fA-F]+>|\([^)]*\)/g;
    let t;
    while ((t = tokRe.exec(inner))) {
      const tok = t[0];
      out += tok.startsWith('<') ? decodeHexString(tok.slice(1, -1)) : decodeLiteralString(tok.slice(1, -1));
    }
    out += ' ';
  }

  return out;
}

/**
 * @param {Buffer} buffer PDF generado con `compress:false`.
 * @returns {string[]} texto visible reconstruido, un elemento por página,
 *   en el orden real de aparición en el documento.
 */
export function extractPdfPageTexts(buffer) {
  const raw = buffer.toString('latin1');
  const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  const pageTexts = [];
  let sm;
  while ((sm = streamRe.exec(raw))) {
    const streamBody = sm[1];
    if (/BT[\s\S]*?ET/.test(streamBody)) {
      pageTexts.push(extractTextFromContentStream(streamBody));
    }
  }
  return pageTexts;
}

/** Cuenta objetos `/Type /Page` (páginas reales) -- distinto de `/Type /Pages` (el árbol). */
export function countPdfPages(buffer) {
  const raw = buffer.toString('latin1');
  const matches = raw.match(/\/Type\s*\/Page(?!s)/g);
  return matches ? matches.length : 0;
}

/** Cuenta imágenes XObject embebidas (`/Subtype /Image`) en todo el documento. */
export function countPdfImages(buffer) {
  const raw = buffer.toString('latin1');
  const matches = raw.match(/\/Subtype\s*\/Image/g);
  return matches ? matches.length : 0;
}
