-- SPRINT-3D11.3 (R1) -- IDENTIFICADORES QR DEL ANIMAL
--
-- Crea agx.animal_identificadores (identificadores físicos/lógicos del
-- animal: QR AGX nuevo y, en el futuro, QR legacy migrado) y amplía el
-- CHECK de tipo_evento de agx.animal_eventos con QR_ASIGNADO,
-- QR_REVOCADO y QR_REEMPLAZADO. No toca datos existentes.
--
-- QR_AGX: valor = token aleatorio criptográfico (24 bytes, base64url sin
-- padding = 32 caracteres, 192 bits). Nunca contiene animal_id, secuencias
-- ni datos del animal/productor. Único globalmente para siempre (un token
-- revocado nunca se reutiliza).
-- QR_LEGACY: solo modelo. Esta migración NO inserta códigos legacy
-- (AGX-000001, ...); su migración requiere sprint y autorización propios.
--
-- Requiere 0000-0022 ya aplicados. Nunca ejecutar contra Railway sin
-- autorización explícita separada.

create table agx.animal_identificadores (
  identificador_id bigserial primary key,
  organizacion_id uuid not null,
  animal_id bigint not null,
  tipo varchar(20) not null,
  valor varchar(128) not null,
  estado varchar(20) not null default 'ACTIVO',
  asignado_at timestamptz not null default now(),
  asignado_por uuid not null,
  revocado_at timestamptz,
  revocado_por uuid,
  motivo text,
  reemplaza_a bigint,
  client_operation_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint animal_identificadores_id_organizacion_unique unique (identificador_id, organizacion_id),
  constraint animal_identificadores_animal_organizacion_fkey
    foreign key (animal_id, organizacion_id) references agx.animales (animal_id, organizacion_id),
  constraint animal_identificadores_reemplaza_a_fkey
    foreign key (reemplaza_a, organizacion_id)
    references agx.animal_identificadores (identificador_id, organizacion_id),
  constraint animal_identificadores_tipo_check check (tipo in ('QR_AGX', 'QR_LEGACY')),
  constraint animal_identificadores_estado_check check (estado in ('ACTIVO', 'REVOCADO', 'REEMPLAZADO')),
  constraint animal_identificadores_valor_formato_check check (
    (tipo = 'QR_AGX' and valor ~ '^[A-Za-z0-9_-]{32}$')
    or (tipo = 'QR_LEGACY' and valor ~ '^AGX-[0-9]{1,12}$')
  ),
  constraint animal_identificadores_estado_consistencia_check check (
    (estado = 'ACTIVO' and revocado_at is null and revocado_por is null and motivo is null)
    or (estado in ('REVOCADO', 'REEMPLAZADO')
        and revocado_at is not null and revocado_por is not null
        and motivo is not null and length(btrim(motivo)) between 1 and 500)
  ),
  constraint animal_identificadores_reemplaza_a_self_check
    check (reemplaza_a is null or reemplaza_a <> identificador_id)
);

comment on table agx.animal_identificadores is
  'Identificadores QR del animal (SPRINT-3D11.3). Máximo un ACTIVO por animal; valor QR_AGX único global para siempre. Nunca DELETE: revocar/reemplazar conserva historial. UPDATE de agx_app solo sobre estado/revocación.';

-- Máximo un identificador ACTIVO por animal.
create unique index animal_identificadores_un_activo_por_animal_idx
  on agx.animal_identificadores (animal_id) where estado = 'ACTIVO';
-- Valor único entre identificadores activos (resolución inequívoca).
create unique index animal_identificadores_valor_activo_idx
  on agx.animal_identificadores (tipo, valor) where estado = 'ACTIVO';
-- Un token QR_AGX nunca se reutiliza, ni siquiera tras revocarse.
create unique index animal_identificadores_qr_agx_valor_key
  on agx.animal_identificadores (valor) where tipo = 'QR_AGX';
-- Idempotencia de reemplazo por (organización, operación de cliente).
create unique index animal_identificadores_org_client_operation_key
  on agx.animal_identificadores (organizacion_id, client_operation_id)
  where client_operation_id is not null;
create index animal_identificadores_organizacion_id_idx on agx.animal_identificadores (organizacion_id);
create index animal_identificadores_animal_asignado_idx on agx.animal_identificadores (animal_id, asignado_at desc);
create index animal_identificadores_valor_idx on agx.animal_identificadores (valor);

alter table agx.animal_identificadores owner to agx_owner;
alter table agx.animal_identificadores enable row level security;
alter table agx.animal_identificadores force row level security;

create policy animal_identificadores_tenant_isolation on agx.animal_identificadores
  for all
  using (organizacion_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  with check (organizacion_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

-- Sin DELETE. UPDATE solo sobre la transición de estado -- nunca valor,
-- tipo, animal_id, organizacion_id, reemplaza_a ni client_operation_id.
grant select, insert on agx.animal_identificadores to agx_app;
grant update (estado, revocado_at, revocado_por, motivo, updated_at)
  on agx.animal_identificadores to agx_app;
grant usage, select on sequence agx.animal_identificadores_identificador_id_seq to agx_app;

grant all privileges on agx.animal_identificadores to agx_owner;
grant usage, select on sequence agx.animal_identificadores_identificador_id_seq to agx_owner;

-- ---------------------------------------------------------------------
-- agx.animal_eventos: nuevos tipos de evento QR. metadata_json de estos
-- eventos NUNCA contiene el token (solo ids internos).
-- ---------------------------------------------------------------------
alter table agx.animal_eventos drop constraint animal_eventos_tipo_check;
alter table agx.animal_eventos add constraint animal_eventos_tipo_check
  check (tipo_evento in (
    'REGISTRADO', 'DATOS_CORREGIDOS', 'ANULADO',
    'QR_ASIGNADO', 'QR_REVOCADO', 'QR_REEMPLAZADO'
  ));
