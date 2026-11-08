// HARDENING -- lexer mínimo compatible con psql (psqlscan.l) para auditar
// migraciones. NO ejecuta ni interpreta SQL: solo separa "código" de
// cadenas, identificadores entre comillas, cuerpos dollar-quoted y
// comentarios, para encontrar:
//   - metacomandos psql (cualquier barra invertida en contexto de código),
//   - referencias a variables psql (:nombre, :'nombre', :"nombre", :{?nombre}).
//
// Reglas que replica de psql/PostgreSQL:
//   - identificadores: {ident_start}{ident_cont}*, ident_cont incluye `$`
//     (por eso `x$q$` es UN identificador, no un dollar-quote);
//   - dollar quote: $tag$...$tag$ solo al inicio de un token;
//   - "..." identificador con "" como escape (puede contener ' y --);
//   - '...' cadena estándar con '' como escape (standard_conforming_strings on);
//   - E'...' cadena con escapes de barra invertida (\' no termina);
//   - U&'...', N'...', B'...', X'...' como cadenas estándar;
//   - -- comentario hasta fin de línea; /* */ con ANIDAMIENTO;
//   - una barra invertida fuera de todo lo anterior inicia un metacomando
//     que psql procesa hasta el fin de la línea.
// Cualquier construcción sin cerrar al final del archivo es un error: se
// rechaza en lugar de adivinar qué haría psql.
//
// Con stdStrings=false se lexea como si standard_conforming_strings
// estuviera en off (barra invertida escapa dentro de '...'). El auditor
// combina ambas pasadas, porque una migración puede cambiar ese parámetro
// en tiempo de ejecución y psql ajusta su lexer al ParameterStatus.

const IDENT_START = /[A-Za-z_\u0080-\uFFFF]/;
const IDENT_CONT = /[A-Za-z0-9_$\u0080-\uFFFF]/;
const VAR_CHAR = /[A-Za-z0-9_\u0080-\uFFFF]/;

export class LexError extends Error {
  constructor(message, offset) {
    super(message);
    this.code = 'AGX_MIGRATE_LEXER';
    this.offset = offset;
  }
}

function readQuoted(sql, start, quote, { backslashEscapes }) {
  // start apunta a la comilla de apertura; devuelve el índice tras el cierre.
  let i = start + 1;
  while (i < sql.length) {
    const ch = sql[i];
    if (backslashEscapes && ch === '\\') { i += 2; continue; }
    if (ch === quote) {
      if (sql[i + 1] === quote) { i += 2; continue; }
      return i + 1;
    }
    i += 1;
  }
  throw new LexError(`${quote === '"' ? 'identificador' : 'cadena'} sin cerrar`, start);
}

function readVarRef(sql, i) {
  // i apunta a ':' (no '::'). Devuelve { end, name, kind } o null.
  const next = sql[i + 1];
  if (next === "'" || next === '"') {
    let j = i + 2;
    while (j < sql.length && VAR_CHAR.test(sql[j])) j += 1;
    if (j > i + 2 && sql[j] === next) return { end: j + 1, name: sql.slice(i + 2, j), kind: next === "'" ? 'literal' : 'identifier' };
    return null;
  }
  if (next === '{' && sql[i + 2] === '?') {
    let j = i + 3;
    while (j < sql.length && VAR_CHAR.test(sql[j])) j += 1;
    if (j > i + 3 && sql[j] === '}') return { end: j + 1, name: sql.slice(i + 3, j), kind: 'defined' };
    return null;
  }
  let j = i + 1;
  while (j < sql.length && VAR_CHAR.test(sql[j])) j += 1;
  if (j > i + 1) return { end: j, name: sql.slice(i + 1, j), kind: 'raw' };
  return null;
}

/**
 * Lexea `sql`. Devuelve:
 *   code: el texto con cadenas/identificadores/comentarios/cuerpos/metacomandos
 *         sustituidos por marcadores neutros (para buscar sentencias),
 *   metas: [{ cmd, text, offset }] en orden de aparición,
 *   vars:  [{ name, offset }] referencias a variables psql en código.
 */
export function lexPsql(sql, { stdStrings = true } = {}) {
  let out = '';
  const metas = [];
  const vars = [];
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    const nx = sql[i + 1];
    // Comentario de línea.
    if (ch === '-' && nx === '-') {
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? sql.length : nl;
      out += ' ';
      continue;
    }
    // Comentario de bloque anidable.
    if (ch === '/' && nx === '*') {
      let depth = 1;
      let j = i + 2;
      while (j < sql.length && depth > 0) {
        if (sql[j] === '/' && sql[j + 1] === '*') { depth += 1; j += 2; continue; }
        if (sql[j] === '*' && sql[j + 1] === '/') { depth -= 1; j += 2; continue; }
        j += 1;
      }
      if (depth > 0) throw new LexError('comentario /* sin cerrar', i);
      i = j;
      out += ' ';
      continue;
    }
    // Metacomando psql: barra invertida en contexto de código, hasta fin de línea.
    if (ch === '\\') {
      const nl = sql.indexOf('\n', i);
      const end = nl === -1 ? sql.length : nl;
      const text = sql.slice(i, end).replace(/\s+$/, '');
      const cmd = /^\\([A-Za-z]+|.?)/.exec(text)[1];
      metas.push({ cmd, text, offset: i });
      i = end;
      out += ' ';
      continue;
    }
    // Identificador entre comillas.
    if (ch === '"') {
      i = readQuoted(sql, i, '"', { backslashEscapes: false });
      out += ' "q" ';
      continue;
    }
    // Cadena estándar.
    if (ch === "'") {
      i = readQuoted(sql, i, "'", { backslashEscapes: !stdStrings });
      out += " '' ";
      continue;
    }
    // Dollar quote (solo al inicio de un token: los identificadores se consumen enteros abajo).
    if (ch === '$') {
      const m = /^\$([A-Za-z_\u0080-\uFFFF][A-Za-z0-9_\u0080-\uFFFF]*)?\$/.exec(sql.slice(i, i + 256));
      if (m) {
        const close = sql.indexOf(m[0], i + m[0].length);
        if (close === -1) throw new LexError(`cuerpo ${m[0]} sin cerrar`, i);
        i = close + m[0].length;
        out += ' $body$ ';
        continue;
      }
      out += ch;
      i += 1;
      continue;
    }
    // Referencias a variables psql (no '::').
    if (ch === ':') {
      if (nx === ':') { out += '::'; i += 2; continue; }
      const ref = readVarRef(sql, i);
      if (ref) {
        vars.push({ name: ref.name, kind: ref.kind, offset: i });
        out += ' :var ';
        i = ref.end;
        continue;
      }
      out += ch;
      i += 1;
      continue;
    }
    // Identificadores y prefijos de cadena (E'', U&'', U&"", N'', B'', X'').
    if (IDENT_START.test(ch)) {
      if ((ch === 'e' || ch === 'E') && nx === "'") {
        i = readQuoted(sql, i + 1, "'", { backslashEscapes: true });
        out += " '' ";
        continue;
      }
      if ((ch === 'u' || ch === 'U') && nx === '&' && (sql[i + 2] === "'" || sql[i + 2] === '"')) {
        i = readQuoted(sql, i + 2, sql[i + 2], { backslashEscapes: false });
        out += " '' ";
        continue;
      }
      if (/[nN]/.test(ch) && nx === "'") {
        i = readQuoted(sql, i + 1, "'", { backslashEscapes: !stdStrings });
        out += " '' ";
        continue;
      }
      if (/[bBxX]/.test(ch) && nx === "'") {
        i = readQuoted(sql, i + 1, "'", { backslashEscapes: false });
        out += " '' ";
        continue;
      }
      let j = i + 1;
      while (j < sql.length && IDENT_CONT.test(sql[j])) j += 1;
      out += sql.slice(i, j);
      i = j;
      continue;
    }
    // Números: se consumen enteros para que un `$` posterior se trate como psql.
    // PostgreSQL >= 15 (psql 16/18): un número seguido de un identificador es
    // UN token basura ({decinteger}{identifier}, *_junk): `1E'x'` es `1E` +
    // cadena estándar 'x', NO una cadena E''.
    if (/[0-9]/.test(ch)) {
      const m = /^[0-9][0-9_]*(\.[0-9_]*)?([eE][+-]?[0-9]+)?/.exec(sql.slice(i, i + 128));
      let j = i + m[0].length;
      if (j < sql.length && IDENT_START.test(sql[j])) {
        j += 1;
        while (j < sql.length && IDENT_CONT.test(sql[j])) j += 1;
      }
      out += sql.slice(i, j);
      i = j;
      continue;
    }
    out += ch;
    i += 1;
  }
  return { code: out, metas, vars };
}
