// HARDENING PRE-SANIDAD (PR A) -- núcleo puro del runner de migraciones.
//
// Sin I/O de base de datos: lista y valida archivos, calcula checksums y
// genera "bundles" psql autocontenidos. Toda verificación de estado
// (ledger, orden, checksum, precondiciones de rollback) se repite DENTRO
// del bundle, en la misma transacción que la migración, para que el
// resultado sea seguro aunque el bundle se ejecute en otra máquina (p. ej.
// `railway ssh` + psql en el contenedor de producción).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const RUNNER_VERSION = 'agx-migrate/1';
// Clave fija del advisory lock transaccional del ledger (bigint).
export const LEDGER_LOCK_KEY = 7426590127n;

export const TARGETS = {
  business: {
    dir: 'db/agx-business/migrations',
    ledgerVersion: 27,
    // Rollbacks 0001-0026: históricos, anteriores al ledger, destructivos.
    historicalMaxVersion: 26,
    baselineFingerprint: 'db/agx-business/verify/baseline_0000_0026.fingerprint',
    fingerprintSchemas: 'agx',
  },
  auth: {
    dir: 'db/agx/migrations',
    ledgerVersion: null,
    historicalMaxVersion: 2,
    baselineFingerprint: null,
    fingerprintSchemas: 'agx',
  },
};

const FILE_RE = /^(\d{4})_([a-z0-9_]+)\.sql$/;
const ALLOWED_META = new Set(['set', 'unset', 'if', 'elif', 'else', 'endif', 'echo', 'gset', 'gexec', 'pset', 'qecho', 'warn']);

export function fail(code, message) {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

/**
 * Contenido canónico, determinista: la ÚNICA transformación es CRLF -> LF
 * (git guarda LF; el checkout de Windows puede tener CRLF). Un BOM o un CR
 * suelto no se "arreglan": se rechazan, para que el checksum nunca oculte
 * un cambio real de bytes. Mismo algoritmo para checksum, ejecución,
 * huellas de referencia y tests.
 */
export function normalizeSql(text) {
  if (text.charCodeAt(0) === 0xfeff) throw fail('AGX_MIGRATE_ENCODING', 'el archivo empieza con BOM; guardarlo como UTF-8 sin BOM.');
  const lf = text.replace(/\r\n/g, '\n');
  if (lf.includes('\r')) throw fail('AGX_MIGRATE_ENCODING', 'el archivo contiene CR sueltos (no CRLF).');
  return lf;
}

export function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

export function md5(text) {
  return crypto.createHash('md5').update(text, 'utf8').digest('hex');
}

/**
 * Elimina comentarios, cuerpos dollar-quoted y literales de cadena para
 * poder buscar sentencias de nivel superior sin falsos positivos.
 */
export function stripSqlForScan(sql) {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? sql.length : nl;
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
      out += ' ';
      continue;
    }
    if (ch === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const end = sql.indexOf(m[0], i + m[0].length);
        i = end === -1 ? sql.length : end + m[0].length;
        out += ' $body$ ';
        continue;
      }
    }
    if (ch === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") { j += 2; continue; }
        if (sql[j] === "'") break;
        j += 1;
      }
      i = j + 1;
      out += " '' ";
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** Variables psql que el archivo interpola (`:'nombre'` o `:nombre`), fuera de comentarios. */
export function psqlVariables(sql) {
  const noComments = sql.replace(/--[^\n]*/g, '');
  const names = new Set();
  for (const m of noComments.matchAll(/(?<!:):'([A-Za-z_][A-Za-z0-9_]*)'/g)) names.add(m[1]);
  return [...names].sort();
}

/**
 * Rechaza control de transacción de nivel superior y metacomandos psql que
 * romperían la atomicidad del bundle (cambiar de conexión, incluir otros
 * archivos, salir).
 */
export function assertBundleSafe(sql, filename) {
  const scan = stripSqlForScan(sql);
  const tx = /(^|;)\s*(begin|start\s+transaction|commit|end|rollback|abort|savepoint|release|prepare\s+transaction)\b[^;]*;/i;
  if (tx.test(scan)) {
    throw fail('AGX_MIGRATE_TX_CONTROL', `${filename} contiene control de transacción de nivel superior; el runner gestiona BEGIN/COMMIT.`);
  }
  for (const m of scan.matchAll(/(^|\n)\s*\\([A-Za-z!]+)/g)) {
    if (!ALLOWED_META.has(m[2])) {
      throw fail('AGX_MIGRATE_META_COMMAND', `${filename} usa el metacomando psql \\${m[2]}, no permitido dentro de un bundle.`);
    }
  }
  // \gset/\gexec van al final de una línea de consulta: validar también esos.
  for (const m of scan.matchAll(/\\(g[a-z]*)\b/g)) {
    if (!ALLOWED_META.has(m[1])) {
      throw fail('AGX_MIGRATE_META_COMMAND', `${filename} usa el metacomando psql \\${m[1]}, no permitido.`);
    }
  }
}

function readMigration(dir, filename) {
  const full = path.join(dir, filename);
  const content = normalizeSql(fs.readFileSync(full, 'utf8'));
  return { filename, path: full, content, checksum: sha256(content) };
}

/**
 * Lista migraciones UP (y su rollback si existe). Exige versiones únicas y
 * contiguas desde 0000: un hueco en el directorio es un error.
 */
export function listMigrations(dir) {
  const entries = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const ups = new Map();
  const downs = new Map();
  for (const filename of entries) {
    const m = FILE_RE.exec(filename);
    if (!m) throw fail('AGX_MIGRATE_BAD_FILENAME', `nombre de migración no válido: ${filename}`);
    const version = Number(m[1]);
    const isRollback = m[2].endsWith('_rollback');
    const map = isRollback ? downs : ups;
    if (map.has(version)) throw fail('AGX_MIGRATE_DUPLICATE_VERSION', `versión ${m[1]} duplicada (${filename})`);
    map.set(version, filename);
  }
  const versions = [...ups.keys()].sort((a, b) => a - b);
  versions.forEach((v, idx) => {
    if (v !== idx) throw fail('AGX_MIGRATE_GAP', `hueco en el directorio: se esperaba ${pad(idx)} y aparece ${pad(v)}`);
  });
  for (const v of downs.keys()) {
    if (!ups.has(v)) throw fail('AGX_MIGRATE_ORPHAN_ROLLBACK', `rollback sin migración UP: ${downs.get(v)}`);
  }
  return versions.map((version) => {
    const up = readMigration(dir, ups.get(version));
    assertBundleSafe(up.content, up.filename);
    const rollback = downs.has(version) ? readMigration(dir, downs.get(version)) : null;
    if (rollback) assertBundleSafe(rollback.content, rollback.filename);
    return { version, ...up, variables: psqlVariables(up.content), rollback };
  });
}

export function pad(version) {
  return String(version).padStart(4, '0');
}

export function ledgerEntries(migrations, belowVersion) {
  return migrations
    .filter((m) => m.version < belowVersion)
    .map((m) => ({ version: m.version, filename: m.filename, checksum: m.checksum }));
}

/**
 * Compara (cliente) el ledger leído de la base con los archivos locales.
 * Devuelve las migraciones pendientes en orden. Falla ante checksum
 * cambiado, versión desconocida o hueco.
 */
export function planFromLedger(migrations, ledger) {
  const byVersion = new Map(migrations.map((m) => [m.version, m]));
  const applied = [...ledger].sort((a, b) => a.version - b.version);
  for (const row of applied) {
    const local = byVersion.get(row.version);
    if (!local) throw fail('AGX_MIGRATE_UNKNOWN_VERSION', `el ledger tiene ${pad(row.version)} (${row.filename}) que no existe localmente`);
    if (local.filename !== row.filename) throw fail('AGX_MIGRATE_FILENAME_MISMATCH', `${pad(row.version)}: ledger=${row.filename} local=${local.filename}`);
    if (local.checksum !== row.checksum) throw fail('AGX_MIGRATE_CHECKSUM_MISMATCH', `${row.filename} cambió después de aplicarse (ledger ${row.checksum.slice(0, 12)}…, local ${local.checksum.slice(0, 12)}…)`);
  }
  applied.forEach((row, idx) => {
    if (row.version !== idx) throw fail('AGX_MIGRATE_GAP', `el ledger tiene un hueco: falta ${pad(idx)}`);
  });
  return migrations.filter((m) => m.version >= applied.length);
}

export function sqlLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function assertEntry(entry) {
  if (!Number.isInteger(entry.version) || !FILE_RE.test(entry.filename) || !/^[0-9a-f]{64}$/.test(entry.checksum)) {
    throw fail('AGX_MIGRATE_BAD_ENTRY', `entrada de ledger inválida: ${JSON.stringify(entry)}`);
  }
}

function header({ target, kind, migration }) {
  return [
    `-- AGX_MIGRATE bundle (${RUNNER_VERSION}) -- generado, no editar.`,
    `-- target=${target} tipo=${kind} archivo=${migration.filename} sha256=${migration.checksum}`,
    '\\set ON_ERROR_STOP 1',
    '\\set AUTOCOMMIT on',
    'begin;',
    `select pg_advisory_xact_lock(${LEDGER_LOCK_KEY}) as agx_migrate_lock \\gset`,
    '',
  ].join('\n');
}

function expectedLedgerCheck(expected, targetVersion) {
  expected.forEach(assertEntry);
  const json = JSON.stringify(expected.map((e) => ({ version: e.version, filename: e.filename, checksum: e.checksum })));
  return `do $agx_migrate_check$
declare
  expected jsonb := $agx_expected$${json}$agx_expected$::jsonb;
  n integer;
begin
  if to_regclass('agx_meta.schema_migrations') is null then
    raise exception 'AGX_MIGRATE_NO_LEDGER: agx_meta.schema_migrations no existe en esta base';
  end if;
  if exists (select 1 from agx_meta.schema_migrations where version = ${targetVersion}) then
    raise exception 'AGX_MIGRATE_ALREADY_APPLIED: la migración ${pad(targetVersion)} ya está registrada';
  end if;
  select count(*) into n
    from agx_meta.schema_migrations l
    join jsonb_array_elements(expected) e on (e->>'version')::integer = l.version
   where l.filename <> e->>'filename' or l.checksum_sha256 <> e->>'checksum';
  if n > 0 then
    raise exception 'AGX_MIGRATE_CHECKSUM_MISMATCH: % migraciones registradas difieren de los archivos (archivo o checksum)', n;
  end if;
  select count(*) into n
    from jsonb_array_elements(expected) e
   where not exists (select 1 from agx_meta.schema_migrations l where l.version = (e->>'version')::integer);
  if n > 0 then
    raise exception 'AGX_MIGRATE_GAP: faltan % migraciones previas a ${pad(targetVersion)} en el ledger', n;
  end if;
  select count(*) into n
    from agx_meta.schema_migrations l
   where not exists (select 1 from jsonb_array_elements(expected) e where (e->>'version')::integer = l.version);
  if n > 0 then
    raise exception 'AGX_MIGRATE_OUT_OF_ORDER: el ledger contiene % versiones posteriores o desconocidas para ${pad(targetVersion)}', n;
  end if;
end
$agx_migrate_check$;
`;
}

function ledgerInsert(entries, kind) {
  entries.forEach(assertEntry);
  if (!entries.length) return '';
  const values = entries
    .map((e) => `  (${e.version}, ${sqlLiteral(e.filename)}, ${sqlLiteral(e.checksum)}, ${sqlLiteral(kind)}, ${sqlLiteral(RUNNER_VERSION)})`)
    .join(',\n');
  return `insert into agx_meta.schema_migrations (version, filename, checksum_sha256, kind, runner_version)\nvalues\n${values};\n`;
}

/** Extrae la consulta de huella entre los marcadores `-- <fp-query>`. */
export function extractFingerprintQuery(fingerprintSql) {
  const m = /--\s*<fp-query>\n([\s\S]*?)--\s*<\/fp-query>/.exec(normalizeSql(fingerprintSql));
  if (!m) throw fail('AGX_MIGRATE_FP_QUERY', 'no se encontró el bloque <fp-query> en schema_fingerprint.sql');
  if (stripSqlForScan(m[1]).includes(';')) throw fail('AGX_MIGRATE_FP_QUERY', 'el bloque <fp-query> no debe contener ;');
  return m[1];
}

/** Líneas de huella relevantes para certificar: sin extensiones (Railway añade extensiones de imagen fuera de agx). */
export function certificationLines(fingerprintText) {
  return normalizeSql(fingerprintText)
    .split('\n')
    .filter((l) => l.length && !l.startsWith('extension|'));
}

export function certificationMd5(fingerprintText) {
  return md5(certificationLines(fingerprintText).join('\n'));
}

function fingerprintCheck({ query, schemas, expectedMd5, expectedLines }) {
  if (!/^[a-z_,]+$/.test(schemas)) throw fail('AGX_MIGRATE_FP_SCHEMAS', `lista de esquemas inválida: ${schemas}`);
  if (!/^[0-9a-f]{32}$/.test(expectedMd5)) throw fail('AGX_MIGRATE_FP_MD5', 'md5 esperado inválido');
  return `select set_config('agx.fp_schemas', ${sqlLiteral(schemas)}, true) as agx_fp_schemas \\gset
do $agx_migrate_fp$
declare
  got text;
  n integer;
begin
  select md5(coalesce(string_agg(q.line, E'\\n' order by q.line collate "C"), '')), count(*)
    into got, n
    from (
${query}
    ) q
   where q.line not like 'extension|%';
  if got is distinct from '${expectedMd5}' then
    raise exception 'AGX_MIGRATE_BASELINE_FINGERPRINT_MISMATCH: la huella de catálogo (% objetos, md5 %) no coincide con la referencia (${expectedLines} objetos, md5 ${expectedMd5}). No se certifica ni se crea el ledger.', n, got;
  end if;
end
$agx_migrate_fp$;
`;
}

/**
 * Bundle UP.
 * - kind 'plain': sin ledger (base vacía antes de la versión del ledger, o
 *   target sin ledger). Exige que el ledger NO exista.
 * - kind 'bootstrap': crea el ledger certificando la huella del esquema.
 * - kind 'ledger': migración normal posterior al ledger.
 */
export function buildUpBundle({ target, migration, kind, expected = [], fingerprint = null }) {
  const parts = [header({ target, kind, migration })];
  if (kind === 'plain') {
    parts.push(`do $agx_migrate_check$
begin
  if to_regnamespace('agx_meta') is not null then
    raise exception 'AGX_MIGRATE_LEDGER_PRESENT: esta base ya tiene ledger; use el modo normal';
  end if;
end
$agx_migrate_check$;
`);
  } else if (kind === 'bootstrap') {
    if (!fingerprint) throw fail('AGX_MIGRATE_FP_REQUIRED', 'el bootstrap del ledger exige huella de referencia');
    parts.push(`do $agx_migrate_check$
begin
  if to_regnamespace('agx_meta') is not null then
    raise exception 'AGX_MIGRATE_ALREADY_APPLIED: agx_meta ya existe; el ledger ya fue creado';
  end if;
end
$agx_migrate_check$;
`);
    parts.push(fingerprintCheck(fingerprint));
  } else if (kind === 'ledger') {
    parts.push(expectedLedgerCheck(expected, migration.version));
  } else {
    throw fail('AGX_MIGRATE_BAD_KIND', kind);
  }
  parts.push(`-- >>> ${migration.filename}\n${migration.content.replace(/\n*$/, '\n')}-- <<< ${migration.filename}\n`);
  if (kind === 'bootstrap') {
    parts.push(ledgerInsert(expected, 'baseline_certificada'));
    parts.push(ledgerInsert([{ version: migration.version, filename: migration.filename, checksum: migration.checksum }], 'aplicada'));
  } else if (kind === 'ledger') {
    parts.push(ledgerInsert([{ version: migration.version, filename: migration.filename, checksum: migration.checksum }], 'aplicada'));
  }
  parts.push('commit;\n');
  return parts.join('\n');
}

/**
 * Objetos que un rollback destruye con datos: DROP TABLE y DROP COLUMN
 * sobre agx.*. Se usan como precondición (deben estar vacíos / en NULL).
 */
export function destructiveTargets(rollbackSql) {
  const scan = stripSqlForScan(rollbackSql);
  const tables = new Set();
  const columns = [];
  for (const m of scan.matchAll(/drop\s+table\s+(?:if\s+exists\s+)?([a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*(?:\s*,\s*[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*)*)/gi)) {
    for (const t of m[1].split(',')) tables.add(t.trim().toLowerCase());
  }
  for (const stmt of scan.split(';')) {
    const alter = /alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?([a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*)/i.exec(stmt);
    if (!alter) continue;
    for (const c of stmt.matchAll(/drop\s+column\s+(?:if\s+exists\s+)?([a-z_][a-z0-9_]*)/gi)) {
      columns.push({ table: alter[1].toLowerCase(), column: c[1].toLowerCase() });
    }
  }
  return { tables: [...tables].sort(), columns };
}

function rollbackPreconditions({ tables, columns }) {
  const tableArr = `array[${tables.map(sqlLiteral).join(', ')}]::text[]`;
  const colArr = `array[${columns.map((c) => sqlLiteral(`${c.table}|${c.column}`)).join(', ')}]::text[]`;
  return `do $agx_migrate_pre$
declare
  t text;
  c text;
  has_rows boolean;
begin
  foreach t in array ${tableArr} loop
    if to_regclass(t) is not null then
      execute format('select exists (select 1 from %s)', t) into has_rows;
      if has_rows then
        raise exception 'AGX_MIGRATE_ROLLBACK_PRECONDITION: % tiene filas; el rollback las borraría', t;
      end if;
    end if;
  end loop;
  foreach c in array ${colArr} loop
    if exists (
      select 1 from pg_attribute
       where attrelid = to_regclass(split_part(c, '|', 1))
         and attname = split_part(c, '|', 2) and not attisdropped
    ) then
      execute format('select exists (select 1 from %s where %I is not null)', split_part(c, '|', 1), split_part(c, '|', 2)) into has_rows;
      if has_rows then
        raise exception 'AGX_MIGRATE_ROLLBACK_PRECONDITION: %.% tiene valores; el rollback los borraría', split_part(c, '|', 1), split_part(c, '|', 2);
      end if;
    end if;
  end loop;
end
$agx_migrate_pre$;
`;
}

/**
 * Bundle ROLLBACK (DOWN). Solo la última versión aplicada (excluido el
 * propio ledger), con su checksum UP intacto. Las precondiciones de datos
 * se comprueban en la misma transacción.
 */
export function buildRollbackBundle({ target, migration, ledgerVersion, historical }) {
  if (!migration.rollback) throw fail('AGX_MIGRATE_NO_ROLLBACK', `${migration.filename} no tiene archivo de rollback`);
  const v = migration.version;
  const parts = [header({ target, kind: historical ? 'rollback-historico' : 'rollback', migration: migration.rollback })];
  parts.push(`do $agx_migrate_check$
declare
  top integer;
begin
  if to_regclass('agx_meta.schema_migrations') is null then
    raise exception 'AGX_MIGRATE_NO_LEDGER: sin ledger no se ejecutan rollbacks';
  end if;
  select max(version) into top from agx_meta.schema_migrations where version <> ${ledgerVersion ?? -1};
  if top is distinct from ${v} then
    raise exception 'AGX_MIGRATE_ROLLBACK_NOT_TOP: solo se revierte la última versión aplicada (%), no ${pad(v)}', top;
  end if;
  if not exists (
    select 1 from agx_meta.schema_migrations
     where version = ${v} and filename = ${sqlLiteral(migration.filename)} and checksum_sha256 = ${sqlLiteral(migration.checksum)}
  ) then
    raise exception 'AGX_MIGRATE_CHECKSUM_MISMATCH: ${migration.filename} no coincide con el ledger';
  end if;
end
$agx_migrate_check$;
`);
  parts.push(rollbackPreconditions(destructiveTargets(migration.rollback.content)));
  parts.push(`-- >>> ${migration.rollback.filename}\n${migration.rollback.content.replace(/\n*$/, '\n')}-- <<< ${migration.rollback.filename}\n`);
  parts.push(`select set_config('agx_meta.revertir_version', '${v}', true) as agx_migrate_revert \\gset\n`);
  parts.push(`delete from agx_meta.schema_migrations where version = ${v};\n`);
  parts.push('commit;\n');
  return parts.join('\n');
}

/**
 * Política de rollback del CLI. Los históricos (anteriores al ledger) solo
 * con la opción extraordinaria que repite la versión exacta y evidencia de
 * backup local en formato pg_dump custom.
 */
export function assertRollbackAllowed({ config, version, options, readFileHead = (p) => fs.readFileSync(p).subarray(0, 5) }) {
  if (config.ledgerVersion === null) throw fail('AGX_MIGRATE_NO_LEDGER', 'este target no tiene ledger; los rollbacks no se ejecutan con el runner');
  if (version === config.ledgerVersion) throw fail('AGX_MIGRATE_LEDGER_ROLLBACK_FORBIDDEN', 'el ledger no se revierte con el runner (ver runbook)');
  if (version === 0) throw fail('AGX_MIGRATE_ROLLBACK_FORBIDDEN', '0000 (roles) no tiene rollback');
  if (options.force !== undefined) throw fail('AGX_MIGRATE_FORCE_NOT_SUPPORTED', '--force no existe: los rollbacks no tienen atajo genérico');
  const historical = version <= config.historicalMaxVersion;
  if (historical) {
    if (String(options['allow-historical-destructive-rollback'] ?? '') !== String(version)) {
      throw fail('AGX_MIGRATE_HISTORICAL_ROLLBACK_BLOCKED', `el rollback ${pad(version)} es histórico y destructivo; requiere --allow-historical-destructive-rollback ${version} y --backup-evidence <dump>`);
    }
    const evidence = options['backup-evidence'];
    if (!evidence) throw fail('AGX_MIGRATE_HISTORICAL_ROLLBACK_BLOCKED', 'falta --backup-evidence <ruta a dump pg_dump -Fc verificado>');
    let head;
    try { head = readFileHead(evidence); } catch { throw fail('AGX_MIGRATE_BACKUP_EVIDENCE', `no se puede leer ${evidence}`); }
    if (Buffer.from(head).toString('latin1') !== 'PGDMP') throw fail('AGX_MIGRATE_BACKUP_EVIDENCE', `${evidence} no es un dump pg_dump en formato custom`);
  } else if (String(options['confirm-rollback'] ?? '') !== String(version)) {
    throw fail('AGX_MIGRATE_ROLLBACK_NOT_CONFIRMED', `requiere --confirm-rollback ${version}`);
  }
  return { historical };
}
