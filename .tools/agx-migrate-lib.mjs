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
import { fileURLToPath } from 'node:url';
import { LexError, lexPsql } from './agx-psql-lexer.mjs';

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
// Parámetros de URL que el runner implementa; cualquier otro se rechaza.
export const SSL_MODES = new Set(['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full']);
// Tamaño mínimo de un dump aceptable como evidencia de backup.
export const MIN_BACKUP_EVIDENCE_BYTES = 16 * 1024;
// Variables psql reservadas para el runner: ninguna migración puede leerlas ni fijarlas.
export const RESERVED_VAR_PREFIX = 'agx_migrate_';

/**
 * Historial CONGELADO: cada migración histórica (Business 0000-0027, Auth
 * 0000-0002, con sus rollbacks) está fijada por nombre + SHA-256 (contenido
 * LF) + la secuencia exacta de metacomandos psql que contiene. Vive junto al
 * runner (no en el directorio de migraciones) para que --root o
 * --migrations-dir no puedan sustituirlo. Las migraciones posteriores son
 * SQL puro (ver auditMigration).
 */
export const FROZEN_MANIFEST_PATH = fileURLToPath(new URL('./agx-migrate-frozen.json', import.meta.url));
export const FROZEN = JSON.parse(fs.readFileSync(FROZEN_MANIFEST_PATH, 'utf8'));

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
 * Texto de "código" (sin cadenas, identificadores entre comillas, cuerpos
 * dollar-quoted, comentarios ni metacomandos) según el lexer compatible con psql.
 */
export function stripSqlForScan(sql) {
  return lexPsql(sql).code;
}

/** Variables psql que el archivo interpola como literal (`:'nombre'`), en código. */
export function psqlVariables(sql) {
  const names = new Set(lexPsql(sql).vars.filter((v) => v.kind === 'literal').map((v) => v.name));
  return [...names].sort();
}

const TX_CONTROL = /(^|;)\s*(begin|start\s+transaction|commit|end|rollback|abort|savepoint|release|prepare\s+transaction)\b[^;]*;/i;

function assertNoTxControl(code, filename) {
  if (TX_CONTROL.test(code)) {
    throw fail('AGX_MIGRATE_TX_CONTROL', `${filename} contiene control de transacción de nivel superior; el runner gestiona BEGIN/COMMIT.`);
  }
}

function lexOrFail(content, filename, opts) {
  try {
    return lexPsql(content, opts);
  } catch (e) {
    if (e instanceof LexError) throw fail('AGX_MIGRATE_LEXER', `${filename}: ${e.message} (offset ${e.offset}); no se adivina qué haría psql`);
    throw e;
  }
}

function versionOf(filename) {
  const m = FILE_RE.exec(filename);
  if (!m) throw fail('AGX_MIGRATE_BAD_FILENAME', `nombre de migración no válido: ${filename}`);
  return Number(m[1]);
}

/**
 * Política de contenido de una migración (UP o rollback).
 *
 * - HISTÓRICA (versión <= maxVersion del manifiesto congelado del target):
 *   debe figurar en el manifiesto con el mismo SHA-256, y su secuencia de
 *   metacomandos (según el lexer) debe ser EXACTAMENTE la congelada. Un byte
 *   significativo distinto, otro nombre, un metacomando de más o una variante:
 *   FAIL. No hay forma de "añadir" una excepción sin editar el manifiesto.
 * - NUEVA (posterior): SQL PURO. Ninguna barra invertida en todo el archivo
 *   (tampoco en cadenas o comentarios), de modo que ningún metacomando psql
 *   es posible aunque el lexer se equivocara. Además: el lexer (en las dos
 *   interpretaciones de standard_conforming_strings) no debe encontrar
 *   metacomandos, no puede referenciar variables reservadas agx_migrate_*, y
 *   la ÚNICA interpolación psql admitida es :'nombre' (literal escapado).
 */
export function auditMigration({ content, filename, checksum, target }) {
  const frozen = FROZEN[target];
  if (!frozen) throw fail('AGX_MIGRATE_ARGS', `target sin manifiesto congelado: ${target}`);
  const version = versionOf(filename);
  if (version <= frozen.maxVersion) {
    const entry = frozen.files[filename];
    if (!entry) throw fail('AGX_MIGRATE_HISTORICAL_NOT_FROZEN', `${filename} está en el rango histórico (<= ${pad(frozen.maxVersion)}) pero no figura en el manifiesto congelado`);
    if (entry.sha256 !== checksum) throw fail('AGX_MIGRATE_HISTORICAL_TAMPERED', `${filename} no coincide con el historial congelado (sha256 ${checksum.slice(0, 12)}…, esperado ${entry.sha256.slice(0, 12)}…)`);
    const lex = lexOrFail(content, filename);
    const metas = lex.metas.map((m) => m.text);
    if (JSON.stringify(metas) !== JSON.stringify(entry.metas)) {
      throw fail('AGX_MIGRATE_META_COMMAND', `${filename}: metacomandos distintos de los congelados`);
    }
    assertNoTxControl(lex.code, filename);
    return lex;
  }
  const backslash = content.indexOf('\\');
  if (backslash !== -1) {
    const line = content.slice(0, backslash).split('\n').length;
    throw fail('AGX_MIGRATE_META_COMMAND', `${filename}:${line}: las migraciones nuevas son SQL puro; no se admite ninguna barra invertida (metacomandos psql prohibidos)`);
  }
  const lex = lexOrFail(content, filename, { stdStrings: true });
  const alt = lexOrFail(content, filename, { stdStrings: false });
  if (lex.metas.length || alt.metas.length) throw fail('AGX_MIGRATE_META_COMMAND', `${filename}: metacomando psql detectado`);
  const reserved = [...lex.vars, ...alt.vars].find((v) => v.name.toLowerCase().startsWith(RESERVED_VAR_PREFIX));
  if (reserved) throw fail('AGX_MIGRATE_RESERVED_VAR', `${filename}: la variable psql ${reserved.name} está reservada para el runner`);
  // Única interpolación admitida: :'nombre' (psql la emite como literal SQL
  // escapado). :nombre se copia tal cual y psql VUELVE A LEXEAR el valor
  // (puede traer metacomandos); :"nombre" y :{?nombre} tampoco son necesarios.
  const unsafe = [...lex.vars, ...alt.vars].find((v) => v.kind !== 'literal');
  if (unsafe) {
    const line = content.slice(0, unsafe.offset).split('\n').length;
    const form = { raw: `:${unsafe.name}`, identifier: `:"${unsafe.name}"`, defined: `:{?${unsafe.name}}` }[unsafe.kind];
    throw fail('AGX_MIGRATE_UNSAFE_VAR', `${filename}:${line}: interpolación psql ${form} no permitida; usar :'${unsafe.name}' (literal). Un slice de array se escribe con espacios: a[1 : 2]`);
  }
  assertNoTxControl(lex.code, filename);
  assertNoTxControl(alt.code, filename);
  return lex;
}

/** Compatibilidad: audita `sql` como si fuera el archivo `filename` del target. */
export function assertBundleSafe(sql, filename, checksum = null, target = 'business') {
  auditMigration({ content: sql, filename, checksum: checksum ?? sha256(sql), target });
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
 * Lista migraciones UP (y su rollback si existe) del `target`. Exige
 * versiones únicas y contiguas desde 0000 y aplica auditMigration a cada
 * archivo: un hueco o un archivo fuera de política es un error.
 */
export function listMigrations(dir, target) {
  if (!FROZEN[target]) throw fail('AGX_MIGRATE_ARGS', `listMigrations requiere target (business|auth), recibió ${target}`);
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
  // El historial congelado debe estar completo: no se puede "retirar" un archivo histórico.
  for (const f of Object.keys(FROZEN[target].files)) {
    if (!entries.includes(f)) throw fail('AGX_MIGRATE_HISTORICAL_NOT_FROZEN', `falta el archivo histórico congelado ${f}`);
  }
  return versions.map((version) => {
    const up = readMigration(dir, ups.get(version));
    auditMigration({ ...up, target });
    const rollback = downs.has(version) ? readMigration(dir, downs.get(version)) : null;
    if (rollback) auditMigration({ ...rollback, target });
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

/** Nonce por bundle: identifica de forma inequívoca la marca de COMMIT de ESTA ejecución. */
export function newNonce() {
  return crypto.randomBytes(16).toString('hex');
}

function assertNonce(nonce) {
  if (!/^[0-9a-f]{32}$/.test(nonce)) throw fail('AGX_MIGRATE_BAD_NONCE', 'nonce inválido');
}

function header({ target, kind, migration, extra = [], nonce }) {
  assertNonce(nonce);
  return [
    `-- AGX_MIGRATE bundle (${RUNNER_VERSION}) -- generado, no editar.`,
    `-- target=${target} tipo=${kind} archivo=${migration.filename} sha256=${migration.checksum}`,
    ...extra.map((l) => `-- ${l}`),
    '\\set ON_ERROR_STOP 1',
    '\\set AUTOCOMMIT on',
    '\\unset ON_ERROR_ROLLBACK',
    // Sesión psql nueva: no puede haber errores previos. Ver REASSERT.
    `select set_config('agx_migrate.last_error_sqlstate', :'LAST_ERROR_SQLSTATE', false) = '00000' as agx_migrate_sin_errores \\gset`,
    '\\if :agx_migrate_sin_errores',
    '\\else',
    "do $agx_migrate_err$ begin raise exception 'AGX_MIGRATE_SUPPRESSED_ERROR: la sesión psql ya tenía un error (SQLSTATE %)', current_setting('agx_migrate.last_error_sqlstate'); end $agx_migrate_err$;",
    '\\endif',
    'begin;',
    `select pg_advisory_xact_lock(${LEDGER_LOCK_KEY}) as agx_migrate_lock \\gset`,
    // xid de la transacción: el runner verifica después con pg_xact_status que hizo COMMIT.
    'select pg_current_xact_id()::text as agx_migrate_xid \\gset',
    '',
  ].join('\n');
}

/**
 * Reafirma el control del runner tras el contenido de una migración y
 * comprueba el ERROR ACUMULADO de la sesión: psql conserva en
 * LAST_ERROR_SQLSTATE el SQLSTATE del último error aunque después haya
 * sentencias exitosas (verificado con psql 16 y 18). Si una sentencia falló
 * y su error se ignoró (ON_ERROR_STOP desactivado, ON_ERROR_ROLLBACK...),
 * vale distinto de 00000 y el bundle aborta ANTES de registrar el ledger.
 */
const REASSERT = [
  '\\set ON_ERROR_STOP 1',
  '\\unset ON_ERROR_ROLLBACK',
  `select set_config('agx_migrate.last_error_sqlstate', :'LAST_ERROR_SQLSTATE', true) = '00000' as agx_migrate_sin_errores \\gset`,
  '\\if :agx_migrate_sin_errores',
  '\\else',
  "do $agx_migrate_err$ begin raise exception 'AGX_MIGRATE_SUPPRESSED_ERROR: la migración tuvo un error ignorado (SQLSTATE %); no se registra', current_setting('agx_migrate.last_error_sqlstate'); end $agx_migrate_err$;",
  '\\endif',
  '',
].join('\n');

/**
 * Cierre: COMMIT y, ya fuera de la transacción, verificación en servidor
 * del ledger esperado (si aplica) y marca con nonce + xid para el runner.
 */
function trailer(expectation, nonce) {
  assertNonce(nonce);
  const parts = ['-- <agx-migrate-commit>', REASSERT, 'commit;', '-- </agx-migrate-commit>'];
  if (expectation) parts.push(postCommitCheck(expectation));
  parts.push(`\\echo 'AGX_MIGRATE_COMMITTED ${nonce} xid=' :agx_migrate_xid`, '');
  return parts.join('\n');
}

/**
 * xid de la ÚLTIMA marca de COMMIT con el nonce de esta ejecución; null si no hay.
 * Una marca sin el nonce (o con otro) se ignora.
 */
export function parseCommitMarker(stdout, nonce) {
  assertNonce(nonce);
  const re = new RegExp(`^AGX_MIGRATE_COMMITTED ${nonce} xid=\\s*(\\d+)\\s*$`, 'gm');
  let xid = null;
  for (const m of String(stdout ?? '').replace(/\r/g, '').matchAll(re)) xid = m[1];
  return xid;
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
export function buildUpBundle({ target, migration, kind, expected = [], fingerprint = null, nonce = newNonce() }) {
  if (kind !== 'bootstrap' && kind !== 'ledger') {
    throw fail('AGX_MIGRATE_HISTORICAL_BUNDLE_BLOCKED', `${migration.filename}: las migraciones anteriores al ledger solo se construyen con --fresh sobre una base vacía`);
  }
  return [
    header({ target, kind, migration, nonce }),
    migrationBody({ migration, kind, expected, fingerprint }),
    trailer(ledgerExpectation({ migration, kind, expected }), nonce),
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
export function buildFreshBundle({ target, config, migrations, to, fingerprint = null, nonce = newNonce() }) {
  const chosen = migrations.filter((m) => m.version <= to);
  if (!chosen.length || chosen[chosen.length - 1].version !== to) throw fail('AGX_MIGRATE_ARGS', `--to fuera de rango: ${to}`);
  const last = chosen[chosen.length - 1];
  const parts = [header({ target, kind: 'fresh', migration: last, extra: [`construcción desde cero 0000..${pad(to)}`], nonce })];
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
  parts.push(trailer(present.length ? { present, absent: [] } : null, nonce));
  return { sql: parts.join('\n'), expectation: present.length ? { present, absent: [] } : null, nonce };
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
export function buildRollbackBundle({ target, migration, ledgerVersion, historical, evidence = null, nonce = newNonce() }) {
  if (!migration.rollback) throw fail('AGX_MIGRATE_NO_ROLLBACK', `${migration.filename} no tiene archivo de rollback`);
  const v = migration.version;
  const extra = evidence ? [`backup-evidence sha256=${evidence.sha256} bytes=${evidence.size} toc=${evidence.entries}`] : [];
  const parts = [header({ target, kind: historical ? 'rollback-historico' : 'rollback', migration: migration.rollback, extra, nonce })];
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
  parts.push(trailer({ present: [], absent: [v] }, nonce));
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
