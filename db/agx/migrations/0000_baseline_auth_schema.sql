-- HARDENING PRE-SANIDAD (PR A) -- BASELINE DE Postgres-AGX (plano de identidad)
--
-- QUÉ ES: la estructura que existía en Postgres-AGX ANTES de 0001/0002 y
-- que nunca se versionó (se aprovisionó a mano en Railway). Junto con
-- 0001 y 0002 permite RECONSTRUIR la base de identidad desde cero en un
-- cluster vacío (DR, staging nuevo, pruebas).
--
-- QUÉ NO ES: no es una migración para producción. Producción YA tiene
-- estos objetos; este archivo falla a propósito si el esquema `agx` ya
-- existe (`create schema agx` sin `if not exists`).
--
-- ORIGEN: extraído el 2026-11-06 con `pg_dump --schema-only --schema=agx`
-- (solo lectura, sin filas) de Postgres-AGX producción (PostgreSQL 18.6).
-- Se separaron los objetos que ya crean 0001 (organizaciones, membresias,
-- funciones/triggers de revocación, FKs de sesiones hacia organización y
-- membresía, idx_sesiones_organizacion_activa) y 0002 (INSERT sobre
-- cuentas/organizaciones/membresias). Huella de referencia del resultado
-- 0000+0001+0002: db/agx/verify/prod_auth_20261106.fingerprint.
--
-- NO existen en producción (verificado 2026-11-06), y por eso NO están
-- aquí aunque los mencionen comentarios del código:
-- agx.concesiones_acceso_interno, agx.auditoria_acceso_interno_uso,
-- agx.fn_revocar_sesiones_por_cuenta_inactiva.
--
-- Roles que deben existir antes de restaurar un dump de esta base:
-- agx_owner (NOLOGIN, dueño de todo) y agx_auth (LOGIN, rol runtime del
-- pool de identidad, sin RLS: estas tablas no son de negocio y no tienen
-- organizacion_id directo -- ADR-008 §13-14). Este archivo los crea si
-- faltan. La contraseña de agx_auth NUNCA vive en el repo: se inyecta con
-- la variable psql `agx_auth_password`:
--
--   psql "$SUPERUSER_URL" -1 -v ON_ERROR_STOP=1 -v agx_auth_password="$AGX_AUTH_PASSWORD" \
--     -f db/agx/migrations/0000_baseline_auth_schema.sql
--
-- Preferir el runner: node .tools/agx-migrate.mjs up --target auth --fresh ...

-- ---------------------------------------------------------------------
-- Variable obligatoria: sin `agx_auth_password` (o vacía) el archivo
-- aborta antes de crear nada, aunque se ejecute sin -v ON_ERROR_STOP=1.
-- No existe valor por defecto.
-- ---------------------------------------------------------------------
\set ON_ERROR_STOP on
\if :{?agx_auth_password}
\else
  do $$ begin raise exception 'AGX_AUTH_PASSWORD_REQUIRED: falta la variable psql agx_auth_password'; end $$;
\endif
select length(:'agx_auth_password') = 0 as agx_auth_password_vacia \gset
\if :agx_auth_password_vacia
  do $$ begin raise exception 'AGX_AUTH_PASSWORD_REQUIRED: la variable psql agx_auth_password está vacía'; end $$;
\endif

-- ---------------------------------------------------------------------
-- Roles (idempotente; nunca modifica una contraseña existente).
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'agx_owner') then
    create role agx_owner nologin;
  end if;
end
$$;

select not exists (select 1 from pg_roles where rolname = 'agx_auth') as should_create_agx_auth \gset
\if :should_create_agx_auth
  create role agx_auth login password :'agx_auth_password'
    nosuperuser nocreatedb nocreaterole nobypassrls noreplication;
\else
  \echo 'agx_auth ya existe -- se omite la creación (la contraseña existente no se modifica aquí).'
\endif

-- ---------------------------------------------------------------------
-- Esquema (falla si ya existe: este archivo solo reconstruye).
-- ---------------------------------------------------------------------
create schema agx authorization agx_owner;

-- ---------------------------------------------------------------------
-- Tablas preexistentes a 0001.
-- ---------------------------------------------------------------------
create table agx.cuentas (
    cuenta_id uuid default gen_random_uuid() not null,
    email text not null,
    email_normalizado text generated always as (lower(trim(both from email))) stored,
    nombre text,
    estado text default 'activa'::text not null,
    password_hash text,
    password_changed_at timestamp with time zone,
    fecha_creacion timestamp with time zone default now() not null,
    fecha_actualizacion timestamp with time zone default now() not null,
    constraint cuentas_estado_check check ((estado = any (array['activa'::text, 'inactiva'::text]))),
    constraint cuentas_pkey primary key (cuenta_id),
    constraint cuentas_email_normalizado_key unique (email_normalizado)
);
alter table agx.cuentas owner to agx_owner;
comment on column agx.cuentas.email_normalizado is 'lower(trim(email)), columna GENERADA -- misma normalización que normalizeEmail(). Clave real de búsqueda de login.';
comment on column agx.cuentas.password_hash is 'Hash PHC de Argon2id. NULL hasta el primer POST /password/set. Nunca texto plano.';

create table agx.sesiones (
    sesion_id uuid default gen_random_uuid() not null,
    cuenta_id uuid not null,
    organizacion_id uuid,
    token_hash text not null,
    fecha_creacion timestamp with time zone default now() not null,
    fecha_expiracion timestamp with time zone not null,
    ultima_actividad timestamp with time zone default now() not null,
    fecha_revocacion timestamp with time zone,
    constraint sesiones_fecha_expiracion_check check ((fecha_expiracion > fecha_creacion)),
    constraint sesiones_pkey primary key (sesion_id),
    constraint sesiones_token_hash_key unique (token_hash),
    constraint sesiones_cuenta_id_fkey foreign key (cuenta_id) references agx.cuentas(cuenta_id)
);
alter table agx.sesiones owner to agx_owner;
create index idx_sesiones_cuenta_activa on agx.sesiones using btree (cuenta_id) where (fecha_revocacion is null);

create table agx.staff_crh (
    cuenta_id uuid not null,
    rol_interno text not null,
    estado text default 'activo'::text not null,
    fecha_creacion timestamp with time zone default now() not null,
    constraint staff_crh_estado_check check ((estado = any (array['activo'::text, 'inactivo'::text]))),
    constraint staff_crh_rol_interno_check check ((rol_interno = any (array['soporte'::text, 'operaciones'::text, 'administrador_plataforma'::text]))),
    constraint staff_crh_pkey primary key (cuenta_id),
    constraint staff_crh_cuenta_id_fkey foreign key (cuenta_id) references agx.cuentas(cuenta_id)
);
alter table agx.staff_crh owner to agx_owner;

create table agx.auth_rate_limits (
    rate_limit_id uuid default gen_random_uuid() not null,
    dimension text not null,
    key_fingerprint text not null,
    window_started_at timestamp with time zone default now() not null,
    attempt_count integer default 1 not null,
    updated_at timestamp with time zone default now() not null,
    constraint auth_rate_limits_attempt_count_check check ((attempt_count > 0)),
    constraint auth_rate_limits_dimension_check check ((dimension = any (array['email'::text, 'ip'::text]))),
    constraint auth_rate_limits_key_fingerprint_check check ((key_fingerprint ~ '^[0-9a-f]{64}$'::text)),
    constraint auth_rate_limits_pkey primary key (rate_limit_id),
    constraint auth_rate_limits_dimension_fingerprint_key unique (dimension, key_fingerprint)
);
alter table agx.auth_rate_limits owner to agx_owner;

create table agx.credenciales_reset_tokens (
    token_id uuid default gen_random_uuid() not null,
    cuenta_id uuid not null,
    token_hash text not null,
    proposito text not null,
    creado_por_cuenta_id uuid,
    fecha_creacion timestamp with time zone default now() not null,
    fecha_expiracion timestamp with time zone not null,
    fecha_uso timestamp with time zone,
    constraint credenciales_reset_tokens_expiracion_check check ((fecha_expiracion > fecha_creacion)),
    constraint credenciales_reset_tokens_proposito_check check ((proposito = any (array['establecer_inicial'::text, 'reset'::text]))),
    constraint credenciales_reset_tokens_pkey primary key (token_id),
    constraint credenciales_reset_tokens_token_hash_key unique (token_hash),
    constraint credenciales_reset_tokens_cuenta_id_fkey foreign key (cuenta_id) references agx.cuentas(cuenta_id),
    constraint credenciales_reset_tokens_creado_por_cuenta_id_fkey foreign key (creado_por_cuenta_id) references agx.cuentas(cuenta_id)
);
alter table agx.credenciales_reset_tokens owner to agx_owner;
create index idx_credenciales_reset_tokens_cuenta on agx.credenciales_reset_tokens using btree (cuenta_id);

create table agx.eventos_seguridad_auth (
    evento_id uuid default gen_random_uuid() not null,
    tipo text not null,
    cuenta_id uuid,
    email_fingerprint text not null,
    ip_fingerprint text,
    motivo text,
    creado_en timestamp with time zone default now() not null,
    constraint eventos_seguridad_auth_email_fingerprint_check check ((email_fingerprint ~ '^[0-9a-f]{64}$'::text)),
    constraint eventos_seguridad_auth_ip_fingerprint_check check (((ip_fingerprint is null) or (ip_fingerprint ~ '^[0-9a-f]{64}$'::text))),
    constraint eventos_seguridad_auth_tipo_check check ((tipo = any (array['LOGIN_SUCCESS'::text, 'LOGIN_FAILURE'::text, 'LOGOUT'::text, 'PASSWORD_SET_INITIAL'::text, 'PASSWORD_CHANGED'::text, 'PASSWORD_RESET_REQUEST'::text, 'PASSWORD_RESET_SUCCESS'::text, 'ACCOUNT_THROTTLED'::text]))),
    constraint eventos_seguridad_auth_pkey primary key (evento_id),
    constraint eventos_seguridad_auth_cuenta_id_fkey foreign key (cuenta_id) references agx.cuentas(cuenta_id)
);
alter table agx.eventos_seguridad_auth owner to agx_owner;
create index idx_eventos_seguridad_auth_creado_en on agx.eventos_seguridad_auth using btree (creado_en);
create index idx_eventos_seguridad_auth_cuenta on agx.eventos_seguridad_auth using btree (cuenta_id) where (cuenta_id is not null);
create index idx_eventos_seguridad_auth_email_fingerprint on agx.eventos_seguridad_auth using btree (email_fingerprint);

-- ---------------------------------------------------------------------
-- Grants de agx_auth sobre estas tablas, tal como están en producción
-- (revisados contra el código: ganaderiaSession.js / authRateLimit.js).
-- El INSERT sobre cuentas lo agrega 0002. Sin DELETE salvo
-- auth_rate_limits (reset del contador tras login correcto).
-- ---------------------------------------------------------------------
grant usage on schema agx to agx_auth;
grant select, update on agx.cuentas to agx_auth;
grant select, insert, update on agx.sesiones to agx_auth;
grant select on agx.staff_crh to agx_auth;
grant select, insert, update, delete on agx.auth_rate_limits to agx_auth;
grant select, insert, update on agx.credenciales_reset_tokens to agx_auth;
grant select, insert on agx.eventos_seguridad_auth to agx_auth;
