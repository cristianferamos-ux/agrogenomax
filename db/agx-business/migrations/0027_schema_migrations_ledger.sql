-- HARDENING PRE-SANIDAD (PR A) -- LEDGER DE MIGRACIONES DE Postgres-AGX-Business
--
-- Crea el esquema `agx_meta` con el registro de qué migraciones están
-- aplicadas en ESTA base. No toca ningún objeto de `agx` ni datos de
-- negocio; el runtime (agx_app / agx_qr_admin) no lo lee ni lo escribe.
--
-- NO EJECUTAR CON psql DIRECTO: este archivo solo crea las tablas vacías.
-- Se aplica exclusivamente con el runner, en modo bootstrap:
--
--   node .tools/agx-migrate.mjs bundle --target business --version 27 --out <archivo>
--
-- El bundle, en UNA transacción: (1) toma el advisory lock del ledger;
-- (2) exige que `agx_meta` no exista; (3) CERTIFICA el esquema actual:
-- calcula la huella de catálogo de `agx` (db/verify/schema_fingerprint.sql)
-- y aborta si no coincide con db/agx-business/verify/baseline_0000_0026.fingerprint
-- (resultado de aplicar 0000-0026 desde cero); (4) ejecuta este archivo;
-- (5) registra 0000-0026 como `baseline_certificada` y 0027 como `aplicada`.
--
-- IMPORTANTE: las filas `baseline_certificada` son una CERTIFICACIÓN DEL
-- ESTADO ACTUAL (el catálogo coincide objeto por objeto con lo que producen
-- 0000-0026), NO una reconstrucción histórica: `applied_at` es la fecha de
-- la certificación, no la de la aplicación real de cada archivo, y la mera
-- existencia de un archivo en el repo nunca se registra como evidencia.
--
-- Propiedad: agx_owner (NOLOGIN), igual que todo `agx`. Escritura: solo el
-- ejecutor de migraciones (superusuario del servicio o miembro de
-- agx_owner). Sin GRANT a agx_app, agx_qr_admin ni PUBLIC. Sin RLS: no son
-- datos de negocio ni tienen organizacion_id; el aislamiento es por
-- privilegios (ningún rol runtime tiene USAGE sobre el esquema).
--
-- Append-only: UPDATE/TRUNCATE prohibidos por trigger (también para el
-- superusuario, salvo que deshabilite triggers a propósito). DELETE solo
-- dentro de un rollback del runner (`agx_meta.revertir_version` = versión
-- de la fila, fijado con set_config local en la misma transacción). Cada
-- alta y baja queda en agx_meta.schema_migration_eventos (append-only).
--
-- Sin archivo de rollback: retirar el ledger es una operación manual
-- documentada en docs/runbooks/agx-db-dr-migraciones.md.

create schema agx_meta authorization agx_owner;
revoke all on schema agx_meta from public;

create table agx_meta.schema_migrations (
  version integer primary key,
  filename text not null unique,
  checksum_sha256 text not null,
  kind text not null,
  applied_at timestamptz not null default now(),
  applied_by text not null default session_user,
  runner_version text not null,
  constraint schema_migrations_version_check check (version between 0 and 9999),
  constraint schema_migrations_filename_check
    check (filename ~ '^[0-9]{4}_[a-z0-9_]+\.sql$' and filename !~ '_rollback\.sql$'),
  constraint schema_migrations_filename_version_check
    check (substring(filename from 1 for 4)::integer = version),
  constraint schema_migrations_checksum_check check (checksum_sha256 ~ '^[0-9a-f]{64}$'),
  constraint schema_migrations_kind_check check (kind in ('baseline_certificada', 'aplicada')),
  constraint schema_migrations_runner_version_check check (length(runner_version) between 1 and 40)
);

comment on table agx_meta.schema_migrations is
  'Ledger de migraciones de esta base (HARDENING PRE-SANIDAD). kind=baseline_certificada: certificación por huella de catálogo del estado existente al crear el ledger (no historia real). kind=aplicada: aplicada por .tools/agx-migrate.mjs en la misma transacción que su registro. checksum_sha256 sobre el archivo con finales de línea normalizados a LF.';

create table agx_meta.schema_migration_eventos (
  evento_id bigint generated always as identity primary key,
  version integer not null,
  filename text not null,
  checksum_sha256 text not null,
  accion text not null,
  ocurrido_en timestamptz not null default now(),
  ejecutado_por text not null default session_user,
  constraint schema_migration_eventos_accion_check
    check (accion in ('baseline_certificada', 'aplicada', 'revertida'))
);

comment on table agx_meta.schema_migration_eventos is
  'Auditoría append-only de altas y bajas del ledger (incluye rollbacks del runner).';

create function agx_meta.fn_schema_migrations_guard() returns trigger
language plpgsql
set search_path = pg_catalog, agx_meta
as $$
begin
  if tg_op = 'UPDATE' or tg_op = 'TRUNCATE' then
    raise exception 'agx_meta.schema_migrations es append-only (% prohibido)', tg_op
      using errcode = 'insufficient_privilege';
  end if;
  if tg_op = 'DELETE' then
    if coalesce(current_setting('agx_meta.revertir_version', true), '') <> old.version::text then
      raise exception 'agx_meta.schema_migrations: DELETE solo dentro de un rollback del runner (versión %)', old.version
        using errcode = 'insufficient_privilege';
    end if;
    insert into agx_meta.schema_migration_eventos (version, filename, checksum_sha256, accion)
    values (old.version, old.filename, old.checksum_sha256, 'revertida');
    return old;
  end if;
  insert into agx_meta.schema_migration_eventos (version, filename, checksum_sha256, accion)
  values (new.version, new.filename, new.checksum_sha256, new.kind);
  return new;
end;
$$;

create function agx_meta.fn_schema_migration_eventos_guard() returns trigger
language plpgsql
set search_path = pg_catalog, agx_meta
as $$
begin
  raise exception 'agx_meta.schema_migration_eventos es append-only (% prohibido)', tg_op
    using errcode = 'insufficient_privilege';
end;
$$;

create trigger schema_migrations_guard
  before update or delete on agx_meta.schema_migrations
  for each row execute function agx_meta.fn_schema_migrations_guard();
create trigger schema_migrations_audit
  after insert on agx_meta.schema_migrations
  for each row execute function agx_meta.fn_schema_migrations_guard();
create trigger schema_migrations_no_truncate
  before truncate on agx_meta.schema_migrations
  for each statement execute function agx_meta.fn_schema_migrations_guard();
create trigger schema_migration_eventos_guard
  before update or delete on agx_meta.schema_migration_eventos
  for each row execute function agx_meta.fn_schema_migration_eventos_guard();
create trigger schema_migration_eventos_no_truncate
  before truncate on agx_meta.schema_migration_eventos
  for each statement execute function agx_meta.fn_schema_migration_eventos_guard();

alter table agx_meta.schema_migrations owner to agx_owner;
alter table agx_meta.schema_migration_eventos owner to agx_owner;
alter function agx_meta.fn_schema_migrations_guard() owner to agx_owner;
alter function agx_meta.fn_schema_migration_eventos_guard() owner to agx_owner;
revoke all on function agx_meta.fn_schema_migrations_guard() from public;
revoke all on function agx_meta.fn_schema_migration_eventos_guard() from public;
revoke all on agx_meta.schema_migrations, agx_meta.schema_migration_eventos from public;
