-- SPRINT-3D11.2 -- REGISTRO MANUAL DE ANIMALES (fundación del dominio Animal)
--
-- Aditiva pura: crea agx.catalogo_razas (catálogo de sistema + seed),
-- agx.animales (entidad operativa, mutable de forma controlada por
-- columnas), agx.animal_pesajes (append-only) y agx.animal_eventos
-- (append-only). No modifica ninguna tabla existente -- solo las
-- referencia (agx.predios, agx.catalogo_categorias_productivas).
--
-- Fuera de alcance deliberado: QR AGX, DIN/RFID (identificadores), lotes,
-- movimientos entre predios, fotos, genética, reproducción, sanidad y el
-- módulo de pesajes manuales. NUNCA se relaciona con el Postgres legacy
-- (agx.animales/qr_codes de server/db.js): base física distinta.
--
-- Requiere 0000-0021 ya aplicados. Nunca ejecutar contra Railway/producción
-- sin autorización explícita separada.

-- ---------------------------------------------------------------------
-- agx.catalogo_razas -- catálogo de SISTEMA (organizacion_id NULL), mismo
-- patrón que agx.catalogo_categorias_productivas (0007): agx_app solo
-- SELECT. Una raza conocida ausente del catálogo se registra como texto
-- (agx.animales.raza_otro_nombre), nunca como "desconocida" ni con una
-- raza ficticia OTRA/NO_DEFINIDA.
-- ---------------------------------------------------------------------
create table agx.catalogo_razas (
  raza_id bigserial primary key,
  organizacion_id uuid,
  codigo varchar(60) not null,
  nombre varchar(120) not null,
  tipo_productivo varchar(20) not null,
  activo boolean not null default true,
  created_at timestamptz not null default now(),

  constraint catalogo_razas_codigo_key unique (codigo),
  constraint catalogo_razas_tipo_productivo_check
    check (tipo_productivo in ('carne', 'leche', 'doble_proposito')),
  constraint catalogo_razas_nombre_check check (btrim(nombre) <> '')
);

comment on table agx.catalogo_razas is
  'Catálogo de razas bovinas (SPRINT-3D11.2). v1: SOLO catálogo de sistema (organizacion_id NULL) -- agx_app tiene únicamente SELECT. tipo_productivo solo agrupa el selector de la UI.';

create index catalogo_razas_organizacion_id_idx on agx.catalogo_razas (organizacion_id);

insert into agx.catalogo_razas (codigo, nombre, tipo_productivo) values
  ('brahman', 'Brahman', 'carne'),
  ('nelore', 'Nelore', 'carne'),
  ('angus', 'Angus', 'carne'),
  ('brangus', 'Brangus', 'carne'),
  ('senepol', 'Senepol', 'carne'),
  ('romosinuano', 'Romosinuano', 'carne'),
  ('gyr', 'Gyr', 'leche'),
  ('holstein', 'Holstein', 'leche'),
  ('jersey', 'Jersey', 'leche'),
  ('girolando', 'Girolando', 'leche'),
  ('guzera', 'Guzerá', 'doble_proposito'),
  ('simmental', 'Simmental', 'doble_proposito'),
  ('normando', 'Normando', 'doble_proposito'),
  ('pardo_suizo', 'Pardo Suizo', 'doble_proposito'),
  ('blanco_orejinegro', 'Blanco Orejinegro (BON)', 'doble_proposito');

alter table agx.catalogo_razas owner to agx_owner;
alter table agx.catalogo_razas enable row level security;
alter table agx.catalogo_razas force row level security;

create policy catalogo_razas_read on agx.catalogo_razas
  for select
  using (
    organizacion_id is null
    or organizacion_id = nullif(current_setting('app.current_org_id', true), '')::uuid
  );

grant select on agx.catalogo_razas to agx_app;
grant all privileges on agx.catalogo_razas to agx_owner;
grant usage, select on sequence agx.catalogo_razas_raza_id_seq to agx_owner;

-- ---------------------------------------------------------------------
-- agx.animales -- identidad operativa del animal. Predio ACTUAL
-- (inmutable en 3D11.2: sin historial de movimientos todavía), sin
-- potrero_id ni lote_id (ubicaciones temporales, modeladas después).
-- Nunca DELETE: un registro erróneo pasa a ANULADO.
-- ---------------------------------------------------------------------
create table agx.animales (
  animal_id bigserial primary key,
  organizacion_id uuid not null,
  predio_id bigint not null,

  numero_visual varchar(40),
  nombre varchar(120),

  sexo varchar(10) not null,

  nacimiento_tipo varchar(12) not null default 'DESCONOCIDA',
  fecha_nacimiento date,
  edad_aproximada_meses integer,
  -- Fecha de NEGOCIO (America/Bogota) en que se declaró la edad aproximada
  -- -- siempre fijada por el servidor, nunca por el cliente.
  edad_referencia_fecha date,

  raza_tipo varchar(12) not null default 'DESCONOCIDA',
  raza_principal_id bigint,
  raza_otro_nombre varchar(120),
  cruce_descripcion varchar(200),

  categoria_productiva_id bigint,

  origen_tipo varchar(20),
  procedencia varchar(200),
  fecha_ingreso date,

  observaciones text,

  estado varchar(12) not null default 'ACTIVO',
  estado_at timestamptz,
  estado_por uuid,
  estado_motivo text,

  client_operation_id uuid not null,
  creation_intent_hash varchar(80) not null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint animales_predio_organizacion_fkey
    foreign key (predio_id, organizacion_id) references agx.predios (predio_id, organizacion_id),
  constraint animales_raza_principal_fkey
    foreign key (raza_principal_id) references agx.catalogo_razas (raza_id),
  constraint animales_categoria_productiva_fkey
    foreign key (categoria_productiva_id) references agx.catalogo_categorias_productivas (categoria_id),

  constraint animales_id_organizacion_unique unique (animal_id, organizacion_id),
  constraint animales_org_client_operation_key unique (organizacion_id, client_operation_id),

  -- Identidad visible
  constraint animales_identidad_check check (numero_visual is not null or nombre is not null),
  constraint animales_numero_visual_formato_check
    check (numero_visual is null
      or (numero_visual <> '' and numero_visual = btrim(regexp_replace(numero_visual, '\s+', ' ', 'g')))),
  constraint animales_nombre_formato_check
    check (nombre is null
      or (nombre <> '' and nombre = btrim(regexp_replace(nombre, '\s+', ' ', 'g')))),

  constraint animales_sexo_check check (sexo in ('MACHO', 'HEMBRA')),

  -- Nacimiento: nunca se fabrica una fecha a partir de una edad aproximada.
  constraint animales_nacimiento_tipo_check
    check (nacimiento_tipo in ('EXACTA', 'APROXIMADA', 'DESCONOCIDA')),
  constraint animales_nacimiento_consistency_check
    check (
      (nacimiento_tipo = 'EXACTA'
        and fecha_nacimiento is not null and edad_aproximada_meses is null and edad_referencia_fecha is null)
      or (nacimiento_tipo = 'APROXIMADA'
        and fecha_nacimiento is null and edad_aproximada_meses is not null and edad_referencia_fecha is not null)
      or (nacimiento_tipo = 'DESCONOCIDA'
        and fecha_nacimiento is null and edad_aproximada_meses is null and edad_referencia_fecha is null)
    ),
  constraint animales_edad_aproximada_check
    check (edad_aproximada_meses is null or edad_aproximada_meses between 0 and 300),
  constraint animales_fecha_nacimiento_min_check
    check (fecha_nacimiento is null or fecha_nacimiento >= date '1990-01-01'),
  constraint animales_fecha_ingreso_min_check
    check (fecha_ingreso is null or fecha_ingreso >= date '1990-01-01'),
  constraint animales_fechas_orden_check
    check (fecha_ingreso is null or fecha_nacimiento is null or fecha_ingreso >= fecha_nacimiento),

  -- Raza: PURA = catálogo XOR texto; CRUCE = predominante y/o descripción
  -- (nunca obliga a adivinar una predominante); DESCONOCIDA = nada.
  constraint animales_raza_tipo_check check (raza_tipo in ('PURA', 'CRUCE', 'DESCONOCIDA')),
  constraint animales_raza_consistency_check
    check (
      (raza_tipo = 'PURA'
        and num_nonnulls(raza_principal_id, raza_otro_nombre) = 1 and cruce_descripcion is null)
      or (raza_tipo = 'CRUCE'
        and raza_otro_nombre is null and (raza_principal_id is not null or cruce_descripcion is not null))
      or (raza_tipo = 'DESCONOCIDA'
        and raza_principal_id is null and raza_otro_nombre is null and cruce_descripcion is null)
    ),
  constraint animales_raza_otro_nombre_formato_check
    check (raza_otro_nombre is null
      or (raza_otro_nombre <> '' and raza_otro_nombre = btrim(regexp_replace(raza_otro_nombre, '\s+', ' ', 'g')))),
  constraint animales_cruce_descripcion_formato_check
    check (cruce_descripcion is null
      or (cruce_descripcion <> '' and cruce_descripcion = btrim(regexp_replace(cruce_descripcion, '\s+', ' ', 'g')))),

  -- Origen
  constraint animales_origen_tipo_check
    check (origen_tipo is null or origen_tipo in ('NACIDO_EN_PREDIO', 'COMPRADO', 'RECIBIDO', 'OTRO')),
  constraint animales_origen_consistency_check
    check (origen_tipo is distinct from 'NACIDO_EN_PREDIO' or (procedencia is null and fecha_ingreso is null)),
  constraint animales_procedencia_check
    check (procedencia is null
      or (origen_tipo is not null and procedencia <> ''
        and procedencia = btrim(regexp_replace(procedencia, '\s+', ' ', 'g')))),

  constraint animales_observaciones_check
    check (observaciones is null or (btrim(observaciones) <> '' and char_length(observaciones) <= 2000)),

  -- Estado (3D11.2: solo ACTIVO/ANULADO -- VENDIDO/MUERTO/BAJA llegan con
  -- su propio sprint y su propia semántica).
  constraint animales_estado_check check (estado in ('ACTIVO', 'ANULADO')),
  constraint animales_estado_consistency_check
    check (
      (estado = 'ACTIVO'
        and estado_at is null and estado_por is null and estado_motivo is null)
      or (estado = 'ANULADO'
        and estado_at is not null and estado_por is not null
        and estado_motivo is not null and btrim(estado_motivo) <> '')
    ),

  -- Idempotencia de creación: hash canónico de la intención ORIGINAL
  -- (inmutable -- sin grant UPDATE para agx_app). Solo v1; una versión
  -- futura del hash llega con su propia migración.
  constraint animales_creation_intent_hash_check
    check (creation_intent_hash ~ '^v1:[0-9a-f]{64}$')
);

comment on table agx.animales is
  'Animal (SPRINT-3D11.2) -- identidad operativa AgroGenomaX. Mutable solo por columnas corregibles (grant column-level); nunca DELETE (registro erróneo -> ANULADO). predio_id = predio actual, inmutable en 3D11.2. Sin potrero_id/lote_id.';
comment on column agx.animales.organizacion_id is
  'Sin FK física -- agx.organizaciones vive en Postgres-AGX. Integridad por sesión+RLS (ver 0001).';
comment on column agx.animales.numero_visual is
  'Número de chapeta visible (opcional). Normalizado server-side (trim + espacios colapsados). Único sin distinguir mayúsculas entre animales ACTIVO de la organización. NO es identificación oficial (DIN/RFID).';
comment on column agx.animales.raza_otro_nombre is
  'Raza pura conocida ausente del catálogo (texto declarado). PURA exige exactamente uno de raza_principal_id / raza_otro_nombre.';
comment on column agx.animales.client_operation_id is
  'UUID de la intención de registro (idempotencia de transporte). Inmutable.';
comment on column agx.animales.creation_intent_hash is
  'v1:<sha256> de la intención canónica ORIGINAL de creación. Fuente única del protocolo de reintento (nunca animal_eventos.metadata_json). Inmutable.';
comment on column agx.animales.updated_at is
  'Gestionado por la aplicación (sin trigger, mismo criterio que 0003). Usado como precondición de concurrencia optimista al corregir.';

create unique index animales_org_numero_visual_activo_key
  on agx.animales (organizacion_id, lower(numero_visual))
  where estado = 'ACTIVO' and numero_visual is not null;
create index animales_org_estado_created_idx
  on agx.animales (organizacion_id, estado, created_at desc, animal_id desc);
create index animales_org_predio_estado_idx on agx.animales (organizacion_id, predio_id, estado);

alter table agx.animales owner to agx_owner;
alter table agx.animales enable row level security;
alter table agx.animales force row level security;

create policy animales_tenant_isolation on agx.animales
  for all
  using (organizacion_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  with check (organizacion_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

-- Sin DELETE. UPDATE solo sobre columnas corregibles/estado -- nunca
-- organizacion_id, predio_id, client_operation_id, creation_intent_hash,
-- created_at ni animal_id.
grant select, insert on agx.animales to agx_app;
grant update (
  numero_visual, nombre, sexo,
  nacimiento_tipo, fecha_nacimiento, edad_aproximada_meses, edad_referencia_fecha,
  raza_tipo, raza_principal_id, raza_otro_nombre, cruce_descripcion,
  categoria_productiva_id,
  origen_tipo, procedencia, fecha_ingreso,
  observaciones,
  estado, estado_at, estado_por, estado_motivo,
  updated_at
) on agx.animales to agx_app;
grant usage, select on sequence agx.animales_animal_id_seq to agx_app;

grant all privileges on agx.animales to agx_owner;
grant usage, select on sequence agx.animales_animal_id_seq to agx_owner;

-- ---------------------------------------------------------------------
-- agx.animal_pesajes -- append-only. 3D11.2 solo escribe el peso inicial
-- (origen REGISTRO_INICIAL) en la misma transacción del alta. El módulo
-- de pesajes manuales (3D12) ampliará origen con su propia semántica.
-- ---------------------------------------------------------------------
create table agx.animal_pesajes (
  pesaje_id bigserial primary key,
  organizacion_id uuid not null,
  animal_id bigint not null,
  fecha date not null,
  peso_kg numeric not null,
  metodo varchar(12) not null,
  origen varchar(20) not null,
  actor_cuenta_id uuid not null,
  created_at timestamptz not null default now(),

  constraint animal_pesajes_animal_organizacion_fkey
    foreign key (animal_id, organizacion_id) references agx.animales (animal_id, organizacion_id),
  constraint animal_pesajes_peso_check
    check (peso_kg > 0 and peso_kg <= 2000 and peso_kg = round(peso_kg, 1)),
  constraint animal_pesajes_metodo_check check (metodo in ('BASCULA', 'ESTIMADO')),
  constraint animal_pesajes_origen_check check (origen in ('REGISTRO_INICIAL')),
  constraint animal_pesajes_fecha_min_check check (fecha >= date '1990-01-01')
);

comment on table agx.animal_pesajes is
  'Pesajes del animal (SPRINT-3D11.2) -- append-only para agx_app (SELECT/INSERT). metodo distingue báscula de estimación. Máximo un REGISTRO_INICIAL por animal.';

create unique index animal_pesajes_un_registro_inicial_idx
  on agx.animal_pesajes (animal_id) where origen = 'REGISTRO_INICIAL';
create index animal_pesajes_animal_fecha_idx on agx.animal_pesajes (animal_id, fecha desc, pesaje_id desc);
create index animal_pesajes_organizacion_id_idx on agx.animal_pesajes (organizacion_id);

alter table agx.animal_pesajes owner to agx_owner;
alter table agx.animal_pesajes enable row level security;
alter table agx.animal_pesajes force row level security;

create policy animal_pesajes_tenant_isolation on agx.animal_pesajes
  for all
  using (organizacion_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  with check (organizacion_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

grant select, insert on agx.animal_pesajes to agx_app;
grant usage, select on sequence agx.animal_pesajes_pesaje_id_seq to agx_app;

grant all privileges on agx.animal_pesajes to agx_owner;
grant usage, select on sequence agx.animal_pesajes_pesaje_id_seq to agx_owner;

-- ---------------------------------------------------------------------
-- agx.animal_eventos -- log append-only de auditoría (mismo criterio que
-- predio_archivo_eventos/potrero_ciclo_eventos). metadata_json es SOLO
-- auditoría: ninguna regla de negocio (p.ej. idempotencia) depende de él.
-- ---------------------------------------------------------------------
create table agx.animal_eventos (
  evento_id bigserial primary key,
  organizacion_id uuid not null,
  animal_id bigint not null,
  tipo_evento varchar(30) not null,
  metadata_json jsonb not null default '{}',
  actor_cuenta_id uuid not null,
  ocurrido_en timestamptz not null default now(),

  constraint animal_eventos_animal_organizacion_fkey
    foreign key (animal_id, organizacion_id) references agx.animales (animal_id, organizacion_id),
  constraint animal_eventos_tipo_check
    check (tipo_evento in ('REGISTRADO', 'DATOS_CORREGIDOS', 'ANULADO')),
  constraint animal_eventos_metadata_check check (jsonb_typeof(metadata_json) = 'object')
);

comment on table agx.animal_eventos is
  'Log append-only de eventos del animal (SPRINT-3D11.2) -- SELECT/INSERT para agx_app, nunca UPDATE/DELETE. Exactamente un REGISTRADO y como máximo un ANULADO por animal (índices únicos parciales).';

create unique index animal_eventos_un_registrado_idx
  on agx.animal_eventos (animal_id) where tipo_evento = 'REGISTRADO';
create unique index animal_eventos_un_anulado_idx
  on agx.animal_eventos (animal_id) where tipo_evento = 'ANULADO';
create index animal_eventos_animal_ocurrido_idx on agx.animal_eventos (animal_id, ocurrido_en);
create index animal_eventos_organizacion_id_idx on agx.animal_eventos (organizacion_id);

alter table agx.animal_eventos owner to agx_owner;
alter table agx.animal_eventos enable row level security;
alter table agx.animal_eventos force row level security;

create policy animal_eventos_tenant_isolation on agx.animal_eventos
  for all
  using (organizacion_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  with check (organizacion_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

grant select, insert on agx.animal_eventos to agx_app;
grant usage, select on sequence agx.animal_eventos_evento_id_seq to agx_app;

grant all privileges on agx.animal_eventos to agx_owner;
grant usage, select on sequence agx.animal_eventos_evento_id_seq to agx_owner;
