-- SPRINT-3D11.3 (R1) -- INVENTARIO CENTRAL DE CHAPETAS QR
--
-- Modelo comercial: AgroGenomaX (Super Admin) genera LOTES de chapetas,
-- las fabrica un proveedor, quedan en stock central y se ASIGNAN a una
-- organización cliente; la organización ASOCIA cada chapeta a un animal.
-- Las chapetas existen antes que el animal; el ganadero nunca las genera.
--
--   agx.qr_lotes           inventario central (sin organizacion_id)
--   agx.qr_asignaciones    entregas lote -> organización (completas o parciales)
--   agx.qr_chapetas        chapeta física: código visible con dígito de control + SHA-256 del token
--   agx.qr_chapeta_tokens  token CIFRADO (AES-256-GCM) para reimprimir el archivo del proveedor
--   agx.qr_chapeta_eventos historial por chapeta
--   agx.qr_lote_eventos    historial por lote
--
-- AUTORIZACIÓN -- separación por ROL de PostgreSQL, no por GUC:
--   * agx_qr_admin (rol nuevo, conexión propia AGX_BUSINESS_QR_ADMIN_DATABASE_URL,
--     solo usada por /api/ganaderia/admin/qr tras createRequireGanaderiaSuperAdmin):
--     inventario completo vía policies `TO agx_qr_admin`. Sobre animales y
--     animal_eventos solo actúa bajo app.current_org_id de la chapeta tratada
--     (policies tenant existentes de 0022).
--   * agx_app (conexión normal de la aplicación): SIN privilegio alguno sobre
--     qr_lotes, qr_chapeta_tokens ni qr_lote_eventos; sobre qr_chapetas solo
--     SELECT/UPDATE de sus filas (organizacion_id = app.current_org_id) y sin
--     INSERT; nunca puede fijar organizacion_id. Ningún SET/set_config le da
--     acceso global: no hay policy ni grant que dependa de un GUC para ello.
--   * El trigger de transiciones exige current_user = 'agx_qr_admin' para
--     sacar una chapeta del inventario central.
--
-- Transiciones de agx.qr_chapetas (trigger, no solo app):
--   EN_INVENTARIO --(agx_qr_admin)--> ASIGNADO_ORGANIZACION --> ASIGNADO_ANIMAL
--   EN_INVENTARIO --(agx_qr_admin)--> REVOCADO | DANADO
--   ASIGNADO_ORGANIZACION --> REVOCADO | DANADO
--   ASIGNADO_ANIMAL --> REVOCADO | DANADO | REEMPLAZADO
--   REVOCADO, DANADO, REEMPLAZADO: terminales.
--   organizacion_id y animal_id, una vez fijados, son inmutables.
--
-- Código visible QR_AGX: AGX-XXXX-XXXX-C sobre 32 símbolos sin O/0/I/1; C =
-- dígito de control Luhn mod 32 (detecta toda sustitución de un carácter y
-- casi toda transposición adyacente). Validado también aquí
-- (agx.fn_qr_codigo_control_ok). QR_LEGACY: AGX-000000 histórico, sin control.
--
-- QR_LEGACY: solo modelo + importación controlada vía endpoint Super Admin.
-- Esta migración NO inserta ningún código.
--
-- Requiere 0000-0022 y la variable psql agx_qr_admin_password:
--   psql -1 -v ON_ERROR_STOP=1 -v agx_qr_admin_password=... -f 0023_qr_inventario_chapetas.sql
-- Nunca ejecutar contra Railway sin autorización explícita separada.

-- ---------------------------------------------------------------------
-- Rol administrativo QR (mismo patrón que agx_app en 0000).
-- ---------------------------------------------------------------------
select not exists (select 1 from pg_roles where rolname = 'agx_qr_admin') as should_create_agx_qr_admin \gset
\if :should_create_agx_qr_admin
  create role agx_qr_admin login password :'agx_qr_admin_password'
    nosuperuser nocreatedb nocreaterole noinherit nobypassrls noreplication;
\else
  \echo 'agx_qr_admin ya existe -- se omite la creación (la contraseña existente no se modifica aquí).'
\endif

select format('grant connect on database %I to agx_qr_admin', current_database()) \gexec
grant usage on schema agx to agx_qr_admin;

-- ---------------------------------------------------------------------
-- Dígito de control del código visible.
-- ---------------------------------------------------------------------
create or replace function agx.fn_qr_codigo_control_ok(codigo text) returns boolean
  language plpgsql immutable strict
  as $$
declare
  alfabeto constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  cuerpo text;
  factor integer := 1;
  suma integer := 0;
  sumando integer;
  i integer;
begin
  if codigo !~ '^AGX-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]$' then
    return false;
  end if;
  cuerpo := replace(substr(codigo, 5), '-', '');
  for i in reverse 9..1 loop
    sumando := factor * (strpos(alfabeto, substr(cuerpo, i, 1)) - 1);
    factor := case when factor = 2 then 1 else 2 end;
    suma := suma + (sumando / 32) + (sumando % 32);
  end loop;
  return suma % 32 = 0;
end
$$;

alter function agx.fn_qr_codigo_control_ok(text) owner to agx_owner;

-- ---------------------------------------------------------------------
-- agx.qr_lotes -- inventario central. Estados físicos del lote; el grado
-- de asignación (parcial/total) se DERIVA de sus chapetas, no se guarda.
-- url_base = AGX_QR_PUBLIC_ORIGIN vigente al crear el lote (dominio impreso).
-- ---------------------------------------------------------------------
create table agx.qr_lotes (
  lote_id bigserial primary key,
  codigo_lote varchar(32) not null,
  tipo varchar(20) not null,
  cantidad integer not null,
  estado varchar(20) not null default 'GENERADO',
  url_base varchar(200),
  proveedor varchar(160),
  observaciones text,
  creado_por uuid not null,
  client_operation_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint qr_lotes_codigo_lote_key unique (codigo_lote),
  constraint qr_lotes_client_operation_key unique (client_operation_id),
  constraint qr_lotes_id_tipo_unique unique (lote_id, tipo),
  constraint qr_lotes_tipo_check check (tipo in ('QR_AGX', 'QR_LEGACY')),
  constraint qr_lotes_estado_check check (estado in ('GENERADO', 'EN_FABRICACION', 'EN_STOCK', 'CERRADO')),
  constraint qr_lotes_cantidad_check check (cantidad between 1 and 5000),
  constraint qr_lotes_codigo_lote_formato_check check (codigo_lote ~ '^LQR-[0-9]{8}-[A-HJ-NP-Z2-9]{4}$'),
  constraint qr_lotes_url_base_check check (
    (tipo = 'QR_AGX' and url_base ~ '^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?$')
    or (tipo = 'QR_LEGACY' and url_base is null)
  ),
  -- Los códigos legacy ya existen físicamente: nunca pasan por fabricación.
  constraint qr_lotes_legacy_estado_check check (tipo = 'QR_AGX' or estado in ('EN_STOCK', 'CERRADO'))
);

comment on table agx.qr_lotes is
  'Lotes de chapetas QR (SPRINT-3D11.3). Inventario central: solo rol agx_qr_admin. Sin DELETE.';

-- ---------------------------------------------------------------------
-- agx.qr_asignaciones -- cada entrega comercial de chapetas a una
-- organización (lote completo o parte). Inmutable.
-- ---------------------------------------------------------------------
create table agx.qr_asignaciones (
  asignacion_id bigserial primary key,
  organizacion_id uuid not null,
  lote_id bigint not null references agx.qr_lotes (lote_id),
  cantidad integer not null,
  referencia varchar(200),
  asignado_por uuid not null,
  client_operation_id uuid not null,
  created_at timestamptz not null default now(),

  constraint qr_asignaciones_id_organizacion_unique unique (asignacion_id, organizacion_id),
  constraint qr_asignaciones_client_operation_key unique (client_operation_id),
  constraint qr_asignaciones_cantidad_check check (cantidad between 1 and 5000)
);

create index qr_asignaciones_organizacion_idx on agx.qr_asignaciones (organizacion_id, created_at desc);
create index qr_asignaciones_lote_idx on agx.qr_asignaciones (lote_id);

-- ---------------------------------------------------------------------
-- agx.qr_chapetas -- la chapeta física.
-- ---------------------------------------------------------------------
create table agx.qr_chapetas (
  qr_id bigserial primary key,
  lote_id bigint not null,
  tipo varchar(20) not null,
  codigo_visible varchar(20) not null,
  token_hash char(64),
  estado varchar(30) not null default 'EN_INVENTARIO',
  organizacion_id uuid,
  asignacion_id bigint,
  animal_id bigint,
  asignado_organizacion_at timestamptz,
  asignado_animal_at timestamptz,
  revocado_at timestamptz,
  revocado_por uuid,
  motivo text,
  reemplazado_por bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint qr_chapetas_id_organizacion_unique unique (qr_id, organizacion_id),
  constraint qr_chapetas_codigo_visible_key unique (codigo_visible),
  constraint qr_chapetas_token_hash_key unique (token_hash),
  constraint qr_chapetas_lote_tipo_fkey
    foreign key (lote_id, tipo) references agx.qr_lotes (lote_id, tipo),
  constraint qr_chapetas_asignacion_organizacion_fkey
    foreign key (asignacion_id, organizacion_id) references agx.qr_asignaciones (asignacion_id, organizacion_id),
  constraint qr_chapetas_animal_organizacion_fkey
    foreign key (animal_id, organizacion_id) references agx.animales (animal_id, organizacion_id),
  constraint qr_chapetas_reemplazado_por_fkey
    foreign key (reemplazado_por, organizacion_id) references agx.qr_chapetas (qr_id, organizacion_id),
  constraint qr_chapetas_tipo_check check (tipo in ('QR_AGX', 'QR_LEGACY')),
  constraint qr_chapetas_estado_check check (estado in (
    'EN_INVENTARIO', 'ASIGNADO_ORGANIZACION', 'ASIGNADO_ANIMAL', 'REVOCADO', 'DANADO', 'REEMPLAZADO'
  )),
  -- QR_AGX: AGX-7KM4-P2XZ-C con dígito de control válido + token_hash;
  -- QR_LEGACY: consecutivo histórico AGX-000003, sin token.
  constraint qr_chapetas_formato_check check (
    (tipo = 'QR_AGX' and agx.fn_qr_codigo_control_ok(codigo_visible)
      and token_hash is not null and token_hash ~ '^[0-9a-f]{64}$')
    or (tipo = 'QR_LEGACY' and codigo_visible ~ '^AGX-[0-9]{6}$' and token_hash is null)
  ),
  constraint qr_chapetas_estado_consistencia_check check (
    (estado = 'EN_INVENTARIO'
      and organizacion_id is null and asignacion_id is null and animal_id is null
      and asignado_organizacion_at is null and asignado_animal_at is null and revocado_at is null)
    or (estado = 'ASIGNADO_ORGANIZACION'
      and organizacion_id is not null and asignacion_id is not null and asignado_organizacion_at is not null
      and animal_id is null and asignado_animal_at is null and revocado_at is null)
    or (estado = 'ASIGNADO_ANIMAL'
      and organizacion_id is not null and animal_id is not null and asignado_animal_at is not null
      and revocado_at is null)
    or (estado in ('REVOCADO', 'DANADO', 'REEMPLAZADO')
      and revocado_at is not null and revocado_por is not null
      and motivo is not null and length(btrim(motivo)) between 1 and 500)
  ),
  constraint qr_chapetas_reemplazo_check check (
    (estado = 'REEMPLAZADO') = (reemplazado_por is not null)
    and (estado <> 'REEMPLAZADO' or animal_id is not null)
  ),
  constraint qr_chapetas_reemplazado_por_self_check check (reemplazado_por is null or reemplazado_por <> qr_id)
);

comment on table agx.qr_chapetas is
  'Chapetas QR físicas (SPRINT-3D11.3). Solo token_hash (SHA-256); el token solo existe cifrado en qr_chapeta_tokens. Transiciones e inmutabilidad por trigger. Sin DELETE.';

-- Una chapeta operativa por animal.
create unique index qr_chapetas_un_activa_por_animal_idx
  on agx.qr_chapetas (animal_id) where estado = 'ASIGNADO_ANIMAL';
create index qr_chapetas_lote_idx on agx.qr_chapetas (lote_id, qr_id);
create index qr_chapetas_organizacion_estado_idx on agx.qr_chapetas (organizacion_id, estado);
create index qr_chapetas_organizacion_updated_idx on agx.qr_chapetas (organizacion_id, updated_at);
create index qr_chapetas_animal_idx on agx.qr_chapetas (animal_id);

create or replace function agx.fn_qr_chapetas_guard() returns trigger
  language plpgsql
  as $$
begin
  if new.qr_id is distinct from old.qr_id or new.lote_id is distinct from old.lote_id
     or new.tipo is distinct from old.tipo or new.codigo_visible is distinct from old.codigo_visible
     or new.token_hash is distinct from old.token_hash or new.created_at is distinct from old.created_at then
    raise exception 'qr_chapetas: identidad inmutable'
      using errcode = 'check_violation', constraint = 'qr_chapetas_inmutable_check';
  end if;

  if old.organizacion_id is not null and new.organizacion_id is distinct from old.organizacion_id then
    raise exception 'qr_chapetas: la organización asignada es inmutable'
      using errcode = 'check_violation', constraint = 'qr_chapetas_organizacion_inmutable_check';
  end if;

  if old.animal_id is not null and new.animal_id is distinct from old.animal_id then
    raise exception 'qr_chapetas: el animal asociado es inmutable'
      using errcode = 'check_violation', constraint = 'qr_chapetas_animal_inmutable_check';
  end if;

  if new.estado is distinct from old.estado then
    if not (
      (old.estado = 'EN_INVENTARIO' and new.estado in ('ASIGNADO_ORGANIZACION', 'REVOCADO', 'DANADO')
        and current_user = 'agx_qr_admin')
      or (old.estado = 'ASIGNADO_ORGANIZACION' and new.estado in ('ASIGNADO_ANIMAL', 'REVOCADO', 'DANADO'))
      or (old.estado = 'ASIGNADO_ANIMAL' and new.estado in ('REVOCADO', 'DANADO', 'REEMPLAZADO'))
    ) then
      raise exception 'qr_chapetas: transición % -> % no permitida', old.estado, new.estado
        using errcode = 'check_violation', constraint = 'qr_chapetas_transicion_check';
    end if;
  elsif row(new.organizacion_id, new.asignacion_id, new.animal_id, new.asignado_organizacion_at,
            new.asignado_animal_at, new.revocado_at, new.revocado_por, new.motivo, new.reemplazado_por)
        is distinct from
        row(old.organizacion_id, old.asignacion_id, old.animal_id, old.asignado_organizacion_at,
            old.asignado_animal_at, old.revocado_at, old.revocado_por, old.motivo, old.reemplazado_por) then
    raise exception 'qr_chapetas: cambio sin transición de estado'
      using errcode = 'check_violation', constraint = 'qr_chapetas_transicion_check';
  end if;

  return new;
end
$$;

alter function agx.fn_qr_chapetas_guard() owner to agx_owner;

create trigger qr_chapetas_guard
  before update on agx.qr_chapetas
  for each row execute function agx.fn_qr_chapetas_guard();

-- ---------------------------------------------------------------------
-- agx.qr_chapeta_tokens -- token CIFRADO para reimprimir el archivo del
-- proveedor. Formato v1: iv(12) || tag(16) || ciphertext(32) con
-- AES-256-GCM, clave AGX_QR_TOKEN_ENCRYPTION_KEY y AAD
-- 'agx-qr-token:v1:<codigo_visible>' (un cifrado no se puede mover a otra
-- chapeta). Solo agx_qr_admin; jamás agx_app.
-- ---------------------------------------------------------------------
create table agx.qr_chapeta_tokens (
  qr_id bigint primary key references agx.qr_chapetas (qr_id),
  token_cifrado bytea not null,
  clave_version smallint not null default 1,
  created_at timestamptz not null default now(),

  constraint qr_chapeta_tokens_formato_check check (octet_length(token_cifrado) = 60),
  constraint qr_chapeta_tokens_clave_version_check check (clave_version = 1)
);

comment on table agx.qr_chapeta_tokens is
  'Token QR cifrado AES-256-GCM (SPRINT-3D11.3), separado de qr_chapetas. Solo rol agx_qr_admin. Append-only.';

-- ---------------------------------------------------------------------
-- Historial (append-only).
-- ---------------------------------------------------------------------
create table agx.qr_chapeta_eventos (
  evento_id bigserial primary key,
  qr_id bigint not null references agx.qr_chapetas (qr_id),
  organizacion_id uuid,
  tipo_evento varchar(40) not null,
  metadata_json jsonb not null default '{}',
  actor_cuenta_id uuid not null,
  ocurrido_en timestamptz not null default now(),

  constraint qr_chapeta_eventos_tipo_check check (tipo_evento in (
    'ASIGNADA_ORGANIZACION', 'ASOCIADA_ANIMAL', 'REVOCADA', 'DANADA', 'REEMPLAZADA', 'ASOCIADA_POR_REEMPLAZO'
  )),
  constraint qr_chapeta_eventos_metadata_check check (jsonb_typeof(metadata_json) = 'object')
);

create index qr_chapeta_eventos_qr_idx on agx.qr_chapeta_eventos (qr_id, ocurrido_en);
create index qr_chapeta_eventos_organizacion_idx on agx.qr_chapeta_eventos (organizacion_id);

create table agx.qr_lote_eventos (
  evento_id bigserial primary key,
  lote_id bigint not null references agx.qr_lotes (lote_id),
  tipo_evento varchar(40) not null,
  metadata_json jsonb not null default '{}',
  actor_cuenta_id uuid not null,
  ocurrido_en timestamptz not null default now(),

  constraint qr_lote_eventos_tipo_check check (tipo_evento in (
    'GENERADO', 'IMPORTADO_LEGACY', 'ESTADO_CAMBIADO', 'ASIGNADO_ORGANIZACION'
  )),
  constraint qr_lote_eventos_metadata_check check (jsonb_typeof(metadata_json) = 'object')
);

create index qr_lote_eventos_lote_idx on agx.qr_lote_eventos (lote_id, ocurrido_en);

-- ---------------------------------------------------------------------
-- Owner, RLS FORCE, policies.
-- ---------------------------------------------------------------------
alter table agx.qr_lotes owner to agx_owner;
alter table agx.qr_asignaciones owner to agx_owner;
alter table agx.qr_chapetas owner to agx_owner;
alter table agx.qr_chapeta_tokens owner to agx_owner;
alter table agx.qr_chapeta_eventos owner to agx_owner;
alter table agx.qr_lote_eventos owner to agx_owner;

alter table agx.qr_lotes enable row level security;
alter table agx.qr_lotes force row level security;
alter table agx.qr_asignaciones enable row level security;
alter table agx.qr_asignaciones force row level security;
alter table agx.qr_chapetas enable row level security;
alter table agx.qr_chapetas force row level security;
alter table agx.qr_chapeta_tokens enable row level security;
alter table agx.qr_chapeta_tokens force row level security;
alter table agx.qr_chapeta_eventos enable row level security;
alter table agx.qr_chapeta_eventos force row level security;
alter table agx.qr_lote_eventos enable row level security;
alter table agx.qr_lote_eventos force row level security;

-- Rol administrativo: inventario completo.
create policy qr_lotes_admin on agx.qr_lotes
  for all to agx_qr_admin using (true) with check (true);
create policy qr_chapeta_tokens_admin on agx.qr_chapeta_tokens
  for all to agx_qr_admin using (true) with check (true);
create policy qr_lote_eventos_admin on agx.qr_lote_eventos
  for all to agx_qr_admin using (true) with check (true);
create policy qr_asignaciones_admin on agx.qr_asignaciones
  for all to agx_qr_admin using (true) with check (true);
create policy qr_chapetas_admin on agx.qr_chapetas
  for all to agx_qr_admin using (true) with check (true);
create policy qr_chapeta_eventos_admin on agx.qr_chapeta_eventos
  for all to agx_qr_admin using (true) with check (true);

-- Organización (agx_app): solo filas propias. WITH CHECK impide moverlas a
-- otra organización; agx_app no tiene INSERT sobre qr_chapetas.
create policy qr_asignaciones_tenant_read on agx.qr_asignaciones
  for select to agx_app
  using (organizacion_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
create policy qr_chapetas_tenant_read on agx.qr_chapetas
  for select to agx_app
  using (organizacion_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
create policy qr_chapetas_tenant_update on agx.qr_chapetas
  for update to agx_app
  using (organizacion_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  with check (organizacion_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
create policy qr_chapeta_eventos_tenant on agx.qr_chapeta_eventos
  for all to agx_app
  using (organizacion_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  with check (organizacion_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

-- ---------------------------------------------------------------------
-- Grants. Sin DELETE en ninguna tabla para ningún rol de aplicación.
-- ---------------------------------------------------------------------
-- agx_qr_admin: inventario completo.
grant select, insert on agx.qr_lotes, agx.qr_asignaciones, agx.qr_chapetas,
  agx.qr_chapeta_tokens, agx.qr_chapeta_eventos, agx.qr_lote_eventos to agx_qr_admin;
grant update (estado, proveedor, observaciones, updated_at) on agx.qr_lotes to agx_qr_admin;
grant update (
  estado, organizacion_id, asignacion_id, animal_id,
  asignado_organizacion_at, asignado_animal_at,
  revocado_at, revocado_por, motivo, reemplazado_por, updated_at
) on agx.qr_chapetas to agx_qr_admin;
grant usage, select on sequence agx.qr_lotes_lote_id_seq, agx.qr_asignaciones_asignacion_id_seq,
  agx.qr_chapetas_qr_id_seq, agx.qr_chapeta_eventos_evento_id_seq, agx.qr_lote_eventos_evento_id_seq,
  agx.animal_eventos_evento_id_seq to agx_qr_admin;
-- Animal de una chapeta asignada: solo bajo app.current_org_id de esa
-- chapeta (policies tenant de 0022). UPDATE(updated_at) existe solo para
-- poder bloquear la fila (SELECT ... FOR UPDATE) en un reemplazo; el
-- repositorio administrativo nunca la modifica.
grant select on agx.animales to agx_qr_admin;
grant update (updated_at) on agx.animales to agx_qr_admin;
grant select, insert on agx.animal_eventos to agx_qr_admin;
grant execute on function agx.fn_qr_codigo_control_ok(text) to agx_qr_admin;

-- agx_app: uso por la organización. Nada sobre lotes, tokens ni eventos de lote.
grant select on agx.qr_asignaciones to agx_app;
grant select on agx.qr_chapetas to agx_app;
grant update (
  estado, animal_id, asignado_animal_at,
  revocado_at, revocado_por, motivo, reemplazado_por, updated_at
) on agx.qr_chapetas to agx_app;
grant select, insert on agx.qr_chapeta_eventos to agx_app;
grant usage, select on sequence agx.qr_chapeta_eventos_evento_id_seq to agx_app;
grant execute on function agx.fn_qr_codigo_control_ok(text) to agx_app;

grant all privileges on agx.qr_lotes, agx.qr_asignaciones, agx.qr_chapetas,
  agx.qr_chapeta_tokens, agx.qr_chapeta_eventos, agx.qr_lote_eventos to agx_owner;

-- ---------------------------------------------------------------------
-- agx.animal_eventos: eventos QR del animal. metadata_json NUNCA guarda
-- el token (solo qr_id / código visible).
-- ---------------------------------------------------------------------
alter table agx.animal_eventos drop constraint animal_eventos_tipo_check;
alter table agx.animal_eventos add constraint animal_eventos_tipo_check
  check (tipo_evento in (
    'REGISTRADO', 'DATOS_CORREGIDOS', 'ANULADO',
    'QR_ASOCIADO', 'QR_REVOCADO', 'QR_REEMPLAZADO'
  ));
