// HARDENING PRE-SANIDAD (PR A) -- núcleo puro del runner de migraciones.
//
// Sin I/O de base de datos: lista y valida archivos, calcula checksums y
// genera "bundles" psql autocontenidos. Toda verificación de estado
// (ledger, orden, checksum, precondiciones de rollback) se repite DENTRO
// del bundle, en la misma transacción que la migración, para que el
// resultado sea seguro aunque el bundle se ejecute en otra máquina (p. ej.
// `railway ssh` + psql en el contenedor de producción).
import { spawnSync } from 'node:child_process';
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
// Whitelist explícita de metacomandos psql dentro de una migración. Todo lo
// demás (\connect, \i, \ir, \include*, \!, \o, \g, \gx, \gexec, \copy,
// \getenv, \setenv, \pset, \\, ...) se rechaza. Reglas adicionales por
// metacomando en assertMetaCommand().
const ALLOWED_META = new Set(['set', 'unset', 'if', 'elif', 'else', 'endif', 'echo', 'warn', 'gset']);
// Excepciones históricas fijadas por archivo + checksum exacto (contenido LF):
// migraciones ya aplicadas en producción que no se pueden reescribir. Si el
// archivo cambia, la excepción deja de valer.
const HISTORICAL_META_EXEMPTIONS = {
  // GRANT CONNECT ON DATABASE <base actual>: el nombre de la base no se conoce de antemano.
  '0023_qr_inventario_chapetas.sql': {
    checksum: 'a1c630e8ee7c31194e79d9e613b35a18d1a8ef9404325c73d83d8a5a321bf861',
    meta: ['gexec'],
  },
};
// Único \set de variable especial admitido: reafirmar ON_ERROR_STOP (no desactivarlo).
const ON_ERROR_STOP_ON = /^(on|1|true)$/i;
// Parámetros de URL que el runner implementa; cualquier otro se rechaza.
export const SSL_MODES = new Set(['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full']);
// Tamaño mínimo de un dump aceptable como evidencia de backup.
export const MIN_BACKUP_EVIDENCE_BYTES = 16 * 1024;

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
export function assertBundleSafe(sql, filename, checksum = null) {
  const scan = stripSqlForScan(sql);
  const tx = /(^|;)\s*(begin|start\s+transaction|commit|end|rollback|abort|savepoint|release|prepare\s+transaction)\b[^;]*;/i;
  if (tx.test(scan)) {
    throw fail('AGX_MIGRATE_TX_CONTROL', `${filename} contiene control de transacción de nivel superior; el runner gestiona BEGIN/COMMIT.`);
  }
  const exemption = HISTORICAL_META_EXEMPTIONS[filename];
  const exempt = new Set(exemption && checksum === exemption.checksum ? exemption.meta : []);
  // psql interpreta una barra invertida fuera de cadenas/cuerpos como metacomando
  // en cualquier posición de la línea: se examinan TODAS.
  for (const m of scan.matchAll(/\\([A-Za-z]+|.)([^\n]*)/g)) {
    assertMetaCommand(m[1], m[2], { filename, exempt, before: scan.slice(0, m.index) });
  }
}

const meta = (filename, cmd, why) => fail('AGX_MIGRATE_META_COMMAND', `${filename} usa \\${cmd}: ${why}`);

function assertMetaCommand(cmd, rest, { filename, exempt, before }) {
  if (!ALLOWED_META.has(cmd) && !exempt.has(cmd)) throw meta(filename, cmd, 'metacomando psql no permitido dentro de una migración');
  // psql ejecuta comandos de shell entre comillas invertidas en los argumentos.
  if (rest.includes('`')) throw meta(filename, cmd, 'comillas invertidas (ejecución de shell) no permitidas');
  const args = rest.trim().split(/\s+/).filter(Boolean);
  if (cmd === 'set' || cmd === 'unset') {
    const name = args[0] ?? '';
    if (/^[a-z_][a-z0-9_]*$/.test(name)) return;
    // Las variables especiales de psql van en mayúsculas (ON_ERROR_STOP,
    // ON_ERROR_ROLLBACK, AUTOCOMMIT, SINGLESTEP...): alteran el control del runner.
    if (cmd === 'set' && name === 'ON_ERROR_STOP' && args.length === 2 && ON_ERROR_STOP_ON.test(args[1])) return;
    throw meta(filename, `${cmd} ${name}`, 'solo se admiten variables en minúsculas (y \\set ON_ERROR_STOP on)');
  }
  if (cmd === 'gset') {
    // Sin prefijo, \gset crea variables con el nombre de cada columna: un
    // alias entre comillas ("ON_ERROR_ROLLBACK") o un * podrían fijar una
    // variable especial. Se exige alias simple (en minúsculas por el parser).
    if (args.length && !/^[a-z_][a-z0-9_]*$/.test(args[0])) throw meta(filename, cmd, 'prefijo no válido');
    const stmt = before.slice(before.lastIndexOf(';') + 1);
    if (!args.length && (stmt.includes('"') || /\*/.test(stmt.replace(/count\s*\(\s*\*\s*\)/gi, '')))) {
      throw meta(filename, cmd, 'consulta con identificadores entre comillas o * no permitida');
    }
  }
}

/**
 * Entorno para psql/pg_* sin NINGUNA variable libpq heredada (PGHOST,
 * PGHOSTADDR, PGSERVICE, PGSERVICEFILE, PGSSLMODE, PGOPTIONS, PGPASSFILE...):
 * el destino solo puede venir de lo que fija el runner.
 */
export function sanitizedPgEnv(base = process.env, pg = {}) {
  const out = {};
  for (const [k, v] of Object.entries(base)) {
    if (/^PG/i.test(k) || /^PSQL/i.test(k)) continue;
    out[k] = v;
  }
  return { ...out, ...pg };
}

/** Sustituye valores secretos por *** en cualquier texto que se vaya a mostrar. */
export function redact(text, secrets) {
  let out = String(text ?? '');
  for (const s of secrets) {
    if (s && String(s).length >= 4) out = out.split(String(s)).join('***');
  }
  return out;
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
    assertBundleSafe(up.content, up.filename, up.checksum);
    const rollback = downs.has(version) ? readMigration(dir, downs.get(version)) : null;
    if (rollback) assertBundleSafe(rollback.content, rollback.filename, rollback.checksum);
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

function header({ target, kind, migration, extra = [] }) {
  return [
    `-- AGX_MIGRATE bundle (${RUNNER_VERSION}) -- generado, no editar.`,
    `-- target=${target} tipo=${kind} archivo=${migration.filename} sha256=${migration.checksum}`,
    ...extra.map((l) => `-- ${l}`),
    '\\set ON_ERROR_STOP 1',
    '\\set AUTOCOMMIT on',
    '\\unset ON_ERROR_ROLLBACK',
    'begin;',
    `select pg_advisory_xact_lock(${LEDGER_LOCK_KEY}) as agx_migrate_lock \\gset`,
    // xid de la transacción: el runner verifica después con pg_xact_status que hizo COMMIT.
    'select pg_current_xact_id()::text as agx_migrate_xid \\gset',
    '',
  ].join('\n');
}

/** Reafirma el control del runner tras el contenido de la migración. */
const REASSERT = '\\set ON_ERROR_STOP 1\n\\unset ON_ERROR_ROLLBACK\n';

/**
 * Cierre: COMMIT y, ya fuera de la transacción, verificación en servidor
 * del ledger esperado (si aplica) y marca con el xid para el runner.
 */
function trailer(expectation) {
  const parts = ['-- <agx-migrate-commit>', REASSERT, 'commit;', '-- </agx-migrate-commit>'];
  if (expectation) parts.push(postCommitCheck(expectation));
  parts.push("\\echo 'AGX_MIGRATE_COMMITTED xid=' :agx_migrate_xid", '');
  return parts.join('\n');
}

/**
 * expectation: { present: [{version, filename, checksum, kind}], absent: [version] }.
 * Mismo criterio en el bundle (servidor) y en el runner (cliente, post-psql).
 */
function postCommitCheck({ present = [], absent = [] }) {
  present.forEach(assertEntry);
  const json = JSON.stringify(present.map((e) => ({ version: e.version, filename: e.filename, checksum: e.checksum, kind: e.kind })));
  return `-- <agx-migrate-post-check>
do $agx_migrate_post$
declare
  expected jsonb := $agx_expected$${json}$agx_expected$::jsonb;
  n integer;
begin
  select count(*) into n
    from jsonb_array_elements(expected) e
   where not exists (
     select 1 from agx_meta.schema_migrations l
      where l.version = (e->>'version')::integer and l.filename = e->>'filename'
        and l.checksum_sha256 = e->>'checksum' and l.kind = e->>'kind');
  if n > 0 then
    raise exception 'AGX_MIGRATE_POST_VERIFY: tras COMMIT faltan o difieren % filas esperadas del ledger', n;
  end if;
  if exists (select 1 from agx_meta.schema_migrations where version = any (array[${absent.map(Number).join(', ')}]::integer[])) then
    raise exception 'AGX_MIGRATE_POST_VERIFY: tras COMMIT el ledger aún contiene versiones revertidas';
  end if;
end
$agx_migrate_post$;
-- </agx-migrate-post-check>`;
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
/**
 * Filas que deben existir en el ledger tras aplicar `migration` con `kind`
 * (vacío para 'plain': sin ledger solo se puede verificar el COMMIT por xid).
 */
export function ledgerExpectation({ migration, kind, expected = [] }) {
  const self = { version: migration.version, filename: migration.filename, checksum: migration.checksum, kind: 'aplicada' };
  if (kind === 'bootstrap') return { present: [...expected.map((e) => ({ ...e, kind: 'baseline_certificada' })), self], absent: [] };
  if (kind === 'ledger') return { present: [self], absent: [] };
  return null;
}

function migrationBody({ migration, kind, expected = [], fingerprint = null }) {
  const parts = [];
  if (kind === 'bootstrap') {
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
  } else if (kind !== 'plain') {
    throw fail('AGX_MIGRATE_BAD_KIND', kind);
  }
  parts.push(`-- >>> ${migration.filename}\n${migration.content.replace(/\n*$/, '\n')}-- <<< ${migration.filename}\n`);
  parts.push(REASSERT);
  const self = [{ version: migration.version, filename: migration.filename, checksum: migration.checksum }];
  if (kind === 'bootstrap') {
    parts.push(ledgerInsert(expected, 'baseline_certificada'));
    parts.push(ledgerInsert(self, 'aplicada'));
  } else if (kind === 'ledger') {
    parts.push(ledgerInsert(self, 'aplicada'));
  }
  return parts.join('\n');
}

/**
 * Bundle UP de UNA migración con ledger.
 * - kind 'bootstrap': crea el ledger certificando la huella del esquema.
 * - kind 'ledger': migración normal posterior al ledger.
 * Las migraciones anteriores al ledger (o de un target sin ledger) no tienen
 * bundle individual: solo se construyen con buildFreshBundle, sobre una base vacía.
 */
export function buildUpBundle({ target, migration, kind, expected = [], fingerprint = null }) {
  if (kind !== 'bootstrap' && kind !== 'ledger') {
    throw fail('AGX_MIGRATE_HISTORICAL_BUNDLE_BLOCKED', `${migration.filename}: las migraciones anteriores al ledger solo se construyen con --fresh sobre una base vacía`);
  }
  return [
    header({ target, kind, migration }),
    migrationBody({ migration, kind, expected, fingerprint }),
    trailer(ledgerExpectation({ migration, kind, expected })),
  ].join('\n');
}

/** Clasifica cada versión según el target: antes del ledger, el propio ledger, o posterior. */
export function kindFor(config, version) {
  if (config.ledgerVersion === null || version < config.ledgerVersion) return 'plain';
  return version === config.ledgerVersion ? 'bootstrap' : 'ledger';
}

/**
 * Bundle de construcción desde cero (0000..to) en UNA transacción. Aborta en
 * servidor si la base ya tiene esquema agx o ledger: nunca reaplica historia
 * sobre una base existente.
 */
export function buildFreshBundle({ target, config, migrations, to, fingerprint = null }) {
  const chosen = migrations.filter((m) => m.version <= to);
  if (!chosen.length || chosen[chosen.length - 1].version !== to) throw fail('AGX_MIGRATE_ARGS', `--to fuera de rango: ${to}`);
  const last = chosen[chosen.length - 1];
  const parts = [header({ target, kind: 'fresh', migration: last, extra: [`construcción desde cero 0000..${pad(to)}`] })];
  parts.push(`do $agx_migrate_check$
begin
  if to_regnamespace('agx') is not null or to_regnamespace('agx_meta') is not null then
    raise exception 'AGX_MIGRATE_NOT_FRESH: --fresh exige una base sin esquema agx ni ledger';
  end if;
end
$agx_migrate_check$;
`);
  const present = [];
  for (const m of chosen) {
    const kind = kindFor(config, m.version);
    const expected = ledgerEntries(migrations, m.version);
    parts.push(migrationBody({ migration: m, kind, expected, fingerprint: kind === 'bootstrap' ? fingerprint : null }));
    const exp = ledgerExpectation({ migration: m, kind, expected });
    if (exp) {
      for (const row of exp.present) {
        const i = present.findIndex((p) => p.version === row.version);
        if (i === -1) present.push(row);
      }
    }
  }
  parts.push(trailer(present.length ? { present, absent: [] } : null));
  return { sql: parts.join('\n'), expectation: present.length ? { present, absent: [] } : null };
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
export function buildRollbackBundle({ target, migration, ledgerVersion, historical, evidence = null }) {
  if (!migration.rollback) throw fail('AGX_MIGRATE_NO_ROLLBACK', `${migration.filename} no tiene archivo de rollback`);
  const v = migration.version;
  const extra = evidence ? [`backup-evidence sha256=${evidence.sha256} bytes=${evidence.size} toc=${evidence.entries}`] : [];
  const parts = [header({ target, kind: historical ? 'rollback-historico' : 'rollback', migration: migration.rollback, extra })];
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
  parts.push(REASSERT);
  parts.push(`select set_config('agx_meta.revertir_version', '${v}', true) as agx_migrate_revert \\gset\n`);
  parts.push(`delete from agx_meta.schema_migrations where version = ${v};\n`);
  parts.push(trailer({ present: [], absent: [v] }));
  return parts.join('\n');
}

/** Expectativa post-rollback para el runner. */
export function rollbackExpectation(version) {
  return { present: [], absent: [version] };
}

/**
 * Inspección de un dump usado como evidencia de backup: tamaño mínimo,
 * cabecera PGDMP, legible completo por `pg_restore --list` con entradas TOC,
 * y SHA-256 para dejar constancia.
 */
export function inspectBackupEvidence(file, { pgRestore = process.env.PG_RESTORE_BIN || 'pg_restore', env = sanitizedPgEnv() } = {}) {
  let stat;
  try { stat = fs.statSync(file); } catch { throw fail('AGX_MIGRATE_BACKUP_EVIDENCE', `no se puede leer ${file}`); }
  if (!stat.isFile()) throw fail('AGX_MIGRATE_BACKUP_EVIDENCE', `${file} no es un archivo`);
  if (stat.size < MIN_BACKUP_EVIDENCE_BYTES) {
    throw fail('AGX_MIGRATE_BACKUP_EVIDENCE', `${file} tiene ${stat.size} bytes; mínimo ${MIN_BACKUP_EVIDENCE_BYTES}`);
  }
  const buf = fs.readFileSync(file);
  if (buf.subarray(0, 5).toString('latin1') !== 'PGDMP') throw fail('AGX_MIGRATE_BACKUP_EVIDENCE', `${file} no es un dump pg_dump en formato custom`);
  const res = spawnSync(pgRestore, ['--list', file], { encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });
  if (res.error) throw fail('AGX_MIGRATE_BACKUP_EVIDENCE', `no se pudo ejecutar pg_restore (${res.error.code})`);
  if (res.status !== 0) throw fail('AGX_MIGRATE_BACKUP_EVIDENCE', `pg_restore --list no puede leer ${file}`);
  const entries = res.stdout.split('\n').filter((l) => /^\d+;/.test(l)).length;
  if (entries === 0) throw fail('AGX_MIGRATE_BACKUP_EVIDENCE', `${file} no contiene entradas TOC`);
  return { sha256: crypto.createHash('sha256').update(buf).digest('hex'), size: stat.size, entries };
}

/**
 * Política de rollback del CLI. Los históricos (anteriores al ledger) solo
 * con la opción extraordinaria que repite la versión exacta y evidencia de
 * backup local en formato pg_dump custom.
 */
export function assertRollbackAllowed({ config, version, options, inspectEvidence = inspectBackupEvidence }) {
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
    return { historical, evidence: inspectEvidence(evidence) };
  }
  if (String(options['confirm-rollback'] ?? '') !== String(version)) {
    throw fail('AGX_MIGRATE_ROLLBACK_NOT_CONFIRMED', `requiere --confirm-rollback ${version}`);
  }
  return { historical, evidence: null };
}
