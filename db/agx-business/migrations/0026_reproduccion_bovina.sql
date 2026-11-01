-- FASE 4A -- REPRODUCCIÓN BOVINA: historial de eventos reproductivos.
--
-- agx.reproduccion_eventos es la ÚNICA fuente de verdad del historial
-- reproductivo del animal. Ningún estado reproductivo se guarda en
-- agx.animales: el estado (SIN_ESTADO, CICLANDO, SERVIDA, PRENADA, VACIA,
-- POSPARTO) se DERIVA al leer, plegando los eventos ACTIVO en orden
-- (fecha_evento, evento_id) -- reproduccionEstado.js. Así anular un evento
-- recalcula el estado desde el historial válido, nunca "revierte" a un valor
-- fijo, y no hay proyección que pueda desincronizarse.
--
-- Tipos (8): CELO_OBSERVADO, SERVICIO_MONTA, INSEMINACION_ARTIFICIAL, IATF,
-- TRANSFERENCIA_EMBRION, DIAGNOSTICO_PRENEZ, ABORTO, PARTO. Todos se
-- registran sobre la HEMBRA (el toro de una monta/IA es un dato del evento,
-- toro_animal_id, nunca el sujeto).
--
-- UNA tabla con columnas TIPADAS por tipo (sin JSONB): cada tipo tiene pocos
-- campos propios y un CHECK por grupo de columnas garantiza que un campo solo
-- existe en los tipos donde tiene sentido (p.ej. embrion_* solo en
-- TRANSFERENCIA_EMBRION, parto_tipo/numero_crias obligatorios en PARTO). Ocho
-- tablas de detalle 1:1 solo añadirían joins. La genética queda como texto
-- (toro_externo, embrion_raza, embrion_donadora): suficiente para operar y
-- para integrarse después sin sobrediseñar.
--
-- Historial inmutable: agx_app tiene SELECT/INSERT y UPDATE SOLO de las
-- columnas de anulación; sin DELETE. El trigger
-- agx.fn_reproduccion_eventos_guard impone, también para conexiones distintas
-- de la app: solo ACTIVO -> ANULADO, ANULADO terminal, ninguna otra columna
-- cambia nunca y ningún DELETE físico.
--
-- Corrección = anular el evento erróneo + insertar el corregido con
-- corrige_evento_id (misma transacción). FK compuesta (corrige_evento_id,
-- animal_id, organizacion_id): la corrección pertenece al MISMO animal y
-- organización -- los eventos nunca se transfieren entre animales. Un evento
-- se corrige como máximo una vez.
--
-- Idempotencia (mismo patrón que 0021/0024/0025): client_operation_id NOT
-- NULL UNIQUE por organización + intent_hash v1 de la intención canónica
-- (reproduccionIntentHash.js); anulacion_client_operation_id UNIQUE parcial
-- por organización.
--
-- fecha_evento es fecha EFECTIVA de negocio (calendario America/Bogota);
-- registrado_at es el instante técnico. La cota "no futura" vive en la
-- aplicación (CURRENT_DATE no es inmutable ni independiente del TimeZone de
-- sesión), igual que 0022/0025.
--
-- Aditiva pura: no modifica ninguna tabla existente (solo referencia
-- agx.animales) ni datos. Requiere 0000-0025.
--
-- Secuencia de despliegue: aplicar ESTA migración ANTES del merge del código
-- que la usa (Railway despliega main automáticamente). El código anterior no
-- la lee ni la escribe.
--   psql -1 -v ON_ERROR_STOP=1 -f 0026_reproduccion_bovina.sql
-- Nunca ejecutar contra Railway sin autorización explícita separada.

create table agx.reproduccion_eventos (
  evento_id bigserial primary key,
  organizacion_id uuid not null,
  animal_id bigint not null,

  tipo_evento varchar(30) not null,
  fecha_evento date not null,
  hora_evento time(0),

  -- CELO_OBSERVADO
  intensidad_celo varchar(10),
  metodo_deteccion varchar(20),
  -- SERVICIO_MONTA
  tipo_servicio varchar(12),
  -- SERVICIO_MONTA / INSEMINACION_ARTIFICIAL / IATF: toro propio (opcional)
  toro_animal_id bigint,
  -- Servicios y TE: identificación externa del toro / genética / padre
  toro_externo varchar(120),
  -- INSEMINACION_ARTIFICIAL / IATF
  semen_codigo varchar(80),
  protocolo_iatf varchar(120),
  -- IA / IATF / TE / DIAGNOSTICO_PRENEZ
  tecnico varchar(120),
  -- TRANSFERENCIA_EMBRION
  embrion_codigo varchar(80),
  embrion_raza varchar(120),
  embrion_donadora varchar(120),
  embrion_estadio varchar(40),
  embrion_calidad varchar(40),
  embrion_conservacion varchar(10),
  -- DIAGNOSTICO_PRENEZ
  diagnostico_resultado varchar(10),
  diagnostico_metodo varchar(12),
  -- DIAGNOSTICO_PRENEZ (PRENADA) / ABORTO
  dias_gestacion smallint,
  -- ABORTO
  aborto_causa varchar(200),
  -- PARTO
  parto_tipo varchar(10),
  numero_crias smallint,

  observaciones text,

  corrige_evento_id bigint,

  registrado_por uuid not null,
  registrado_at timestamptz not null default now(),
  client_operation_id uuid not null,
  intent_hash varchar(80) not null,

  estado_registro varchar(10) not null default 'ACTIVO',
  anulado_por uuid,
  anulado_at timestamptz,
  motivo_anulacion text,
  anulacion_client_operation_id uuid,

  constraint reproduccion_eventos_animal_organizacion_fkey
    foreign key (animal_id, organizacion_id) references agx.animales (animal_id, organizacion_id),
  constraint reproduccion_eventos_toro_organizacion_fkey
    foreign key (toro_animal_id, organizacion_id) references agx.animales (animal_id, organizacion_id),
  constraint reproduccion_eventos_id_animal_organizacion_unique
    unique (evento_id, animal_id, organizacion_id),
  constraint reproduccion_eventos_corrige_fkey
    foreign key (corrige_evento_id, animal_id, organizacion_id)
    references agx.reproduccion_eventos (evento_id, animal_id, organizacion_id),
  constraint reproduccion_eventos_org_client_operation_key unique (organizacion_id, client_operation_id),

  constraint reproduccion_eventos_tipo_check
    check (tipo_evento in (
      'CELO_OBSERVADO', 'SERVICIO_MONTA', 'INSEMINACION_ARTIFICIAL', 'IATF',
      'TRANSFERENCIA_EMBRION', 'DIAGNOSTICO_PRENEZ', 'ABORTO', 'PARTO'
    )),
  constraint reproduccion_eventos_fecha_min_check check (fecha_evento >= date '1990-01-01'),

  -- Campos por tipo: solo existen donde tienen sentido.
  constraint reproduccion_eventos_celo_check
    check (tipo_evento = 'CELO_OBSERVADO' or (intensidad_celo is null and metodo_deteccion is null)),
  constraint reproduccion_eventos_intensidad_celo_check
    check (intensidad_celo is null or intensidad_celo in ('BAJA', 'MEDIA', 'ALTA')),
  constraint reproduccion_eventos_metodo_deteccion_check
    check (metodo_deteccion is null
      or metodo_deteccion in ('VISUAL', 'PARCHE_DETECTOR', 'PODOMETRO', 'TORO_CELADOR', 'OTRO')),
  constraint reproduccion_eventos_tipo_servicio_check
    check ((tipo_evento = 'SERVICIO_MONTA') = (tipo_servicio is not null)
      and (tipo_servicio is null or tipo_servicio in ('CONTROLADA', 'LIBRE'))),
  constraint reproduccion_eventos_toro_animal_check
    check (toro_animal_id is null
      or (tipo_evento in ('SERVICIO_MONTA', 'INSEMINACION_ARTIFICIAL', 'IATF') and toro_animal_id <> animal_id)),
  constraint reproduccion_eventos_toro_externo_check
    check (toro_externo is null
      or tipo_evento in ('SERVICIO_MONTA', 'INSEMINACION_ARTIFICIAL', 'IATF', 'TRANSFERENCIA_EMBRION')),
  constraint reproduccion_eventos_semen_check
    check (semen_codigo is null or tipo_evento in ('INSEMINACION_ARTIFICIAL', 'IATF')),
  constraint reproduccion_eventos_protocolo_iatf_check
    check (protocolo_iatf is null or tipo_evento = 'IATF'),
  constraint reproduccion_eventos_tecnico_check
    check (tecnico is null
      or tipo_evento in ('INSEMINACION_ARTIFICIAL', 'IATF', 'TRANSFERENCIA_EMBRION', 'DIAGNOSTICO_PRENEZ')),
  -- Obligatorios: `is not null` explícito (un IN sobre NULL da NULL y un CHECK
  -- NULL se considera satisfecho).
  constraint reproduccion_eventos_embrion_check
    check (
      (tipo_evento = 'TRANSFERENCIA_EMBRION'
        and embrion_conservacion is not null and embrion_conservacion in ('FRESCO', 'CONGELADO'))
      or (tipo_evento <> 'TRANSFERENCIA_EMBRION'
        and embrion_codigo is null and embrion_raza is null and embrion_donadora is null
        and embrion_estadio is null and embrion_calidad is null and embrion_conservacion is null)
    ),
  constraint reproduccion_eventos_diagnostico_check
    check (
      (tipo_evento = 'DIAGNOSTICO_PRENEZ'
        and diagnostico_resultado is not null and diagnostico_resultado in ('PRENADA', 'VACIA', 'DUDOSA')
        and diagnostico_metodo is not null and diagnostico_metodo in ('PALPACION', 'ECOGRAFIA', 'OTRO'))
      or (tipo_evento <> 'DIAGNOSTICO_PRENEZ' and diagnostico_resultado is null and diagnostico_metodo is null)
    ),
  constraint reproduccion_eventos_dias_gestacion_check
    check (dias_gestacion is null
      or (dias_gestacion between 1 and 300
        and (tipo_evento = 'ABORTO'
          or (tipo_evento = 'DIAGNOSTICO_PRENEZ' and diagnostico_resultado is not distinct from 'PRENADA')))),
  constraint reproduccion_eventos_aborto_check
    check (aborto_causa is null or tipo_evento = 'ABORTO'),
  constraint reproduccion_eventos_parto_check
    check (
      (tipo_evento = 'PARTO'
        and parto_tipo is not null and parto_tipo in ('NORMAL', 'ASISTIDO', 'CESAREA', 'OTRO')
        and numero_crias is not null and numero_crias between 1 and 4)
      or (tipo_evento <> 'PARTO' and parto_tipo is null and numero_crias is null)
    ),

  -- Textos: nunca vacíos (trim + espacios colapsados en la app).
  constraint reproduccion_eventos_textos_check
    check (
      (toro_externo is null or btrim(toro_externo) <> '')
      and (semen_codigo is null or btrim(semen_codigo) <> '')
      and (protocolo_iatf is null or btrim(protocolo_iatf) <> '')
      and (tecnico is null or btrim(tecnico) <> '')
      and (embrion_codigo is null or btrim(embrion_codigo) <> '')
      and (embrion_raza is null or btrim(embrion_raza) <> '')
      and (embrion_donadora is null or btrim(embrion_donadora) <> '')
      and (embrion_estadio is null or btrim(embrion_estadio) <> '')
      and (embrion_calidad is null or btrim(embrion_calidad) <> '')
      and (aborto_causa is null or btrim(aborto_causa) <> '')
    ),
  constraint reproduccion_eventos_observaciones_check
    check (observaciones is null or (btrim(observaciones) <> '' and char_length(observaciones) <= 500)),

  constraint reproduccion_eventos_corrige_check
    check (corrige_evento_id is null or corrige_evento_id <> evento_id),

  -- Idempotencia: hash canónico v1 de la intención ORIGINAL (inmutable).
  constraint reproduccion_eventos_intent_hash_check
    check (intent_hash ~ '^v1:[0-9a-f]{64}$'),

  -- Anulación administrativa auditable.
  constraint reproduccion_eventos_estado_registro_check
    check (estado_registro in ('ACTIVO', 'ANULADO')),
  constraint reproduccion_eventos_anulacion_consistency_check
    check (
      (estado_registro = 'ACTIVO'
        and anulado_por is null and anulado_at is null and motivo_anulacion is null
        and anulacion_client_operation_id is null)
      or (estado_registro = 'ANULADO'
        and anulado_por is not null and anulado_at is not null
        and anulacion_client_operation_id is not null
        and motivo_anulacion is not null and btrim(motivo_anulacion) <> ''
        and char_length(motivo_anulacion) <= 500)
    )
);

comment on table agx.reproduccion_eventos is
  'FASE 4A: historial de eventos reproductivos de la hembra -- fuente de verdad única; el estado reproductivo se DERIVA de los eventos ACTIVO (no se guarda). Inmutable: agx_app SELECT/INSERT + UPDATE solo de columnas de anulación (ACTIVO -> ANULADO, trigger reproduccion_eventos_guard); nunca DELETE. Corrección = anular + nuevo evento con corrige_evento_id.';
comment on column agx.reproduccion_eventos.organizacion_id is
  'Sin FK física -- agx.organizaciones vive en Postgres-AGX. Integridad por sesión+RLS (ver 0001).';
comment on column agx.reproduccion_eventos.fecha_evento is
  'Fecha EFECTIVA del evento (calendario de negocio, America/Bogota). No futura (validado en la aplicación). registrado_at es el instante técnico.';
comment on column agx.reproduccion_eventos.toro_animal_id is
  'Toro propio de la organización (MACHO, registro ACTIVO; validado en la aplicación). FK compuesta tenant-safe. NULL si el toro es externo o desconocido.';
comment on column agx.reproduccion_eventos.toro_externo is
  'Identificación externa del toro, genética o padre del embrión (texto declarado).';
comment on column agx.reproduccion_eventos.dias_gestacion is
  'Días de gestación estimados: diagnóstico PRENADA o aborto. Opcional.';
comment on column agx.reproduccion_eventos.corrige_evento_id is
  'Evento ANULADO que este evento corrige (mismo animal y organización). Como máximo una corrección por evento.';
comment on column agx.reproduccion_eventos.client_operation_id is
  'UUID de la intención de registro o corrección (idempotencia de reintentos). Nunca se expone al usuario.';
comment on column agx.reproduccion_eventos.intent_hash is
  'v1:<sha256> de la intención canónica ORIGINAL (reproduccionIntentHash.js). Fuente única del protocolo de reintento. Inmutable.';
comment on column agx.reproduccion_eventos.anulacion_client_operation_id is
  'UUID de la intención de anulación o corrección que anuló este evento. Nunca se expone al usuario.';

create unique index reproduccion_eventos_org_anulacion_client_operation_key
  on agx.reproduccion_eventos (organizacion_id, anulacion_client_operation_id)
  where anulacion_client_operation_id is not null;
create unique index reproduccion_eventos_una_correccion_idx
  on agx.reproduccion_eventos (corrige_evento_id) where corrige_evento_id is not null;
-- Historial / plegado del estado (animal_id es único en todo el sistema; RLS
-- añade organizacion_id).
create index reproduccion_eventos_animal_fecha_idx
  on agx.reproduccion_eventos (animal_id, fecha_evento, evento_id);
-- Consultas por organización / tipo / fecha (reportes y listados futuros).
create index reproduccion_eventos_org_tipo_fecha_idx
  on agx.reproduccion_eventos (organizacion_id, tipo_evento, fecha_evento);
create index reproduccion_eventos_toro_idx
  on agx.reproduccion_eventos (toro_animal_id) where toro_animal_id is not null;

alter table agx.reproduccion_eventos owner to agx_owner;
alter table agx.reproduccion_eventos enable row level security;
alter table agx.reproduccion_eventos force row level security;

create policy reproduccion_eventos_tenant_isolation on agx.reproduccion_eventos
  for all
  using (organizacion_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  with check (organizacion_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

-- Historial inmutable, también para conexiones distintas de la app: solo
-- ACTIVO -> ANULADO (con sus columnas de auditoría); el resto de columnas no
-- cambia nunca; ANULADO es terminal; ningún DELETE físico.
create or replace function agx.fn_reproduccion_eventos_guard() returns trigger
  language plpgsql
  as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'reproduccion_eventos: el historial reproductivo no admite DELETE'
      using errcode = 'check_violation';
  end if;
  if old.estado_registro = 'ANULADO' then
    raise exception 'reproduccion_eventos: un evento ANULADO es inmutable'
      using errcode = 'check_violation';
  end if;
  if new.estado_registro <> 'ANULADO' then
    raise exception 'reproduccion_eventos: solo se admite la transición ACTIVO -> ANULADO'
      using errcode = 'check_violation';
  end if;
  if row(new.evento_id, new.organizacion_id, new.animal_id, new.tipo_evento, new.fecha_evento, new.hora_evento,
         new.intensidad_celo, new.metodo_deteccion, new.tipo_servicio, new.toro_animal_id, new.toro_externo,
         new.semen_codigo, new.protocolo_iatf, new.tecnico, new.embrion_codigo, new.embrion_raza,
         new.embrion_donadora, new.embrion_estadio, new.embrion_calidad, new.embrion_conservacion,
         new.diagnostico_resultado, new.diagnostico_metodo, new.dias_gestacion, new.aborto_causa,
         new.parto_tipo, new.numero_crias, new.observaciones, new.corrige_evento_id, new.registrado_por,
         new.registrado_at, new.client_operation_id, new.intent_hash)
     is distinct from
     row(old.evento_id, old.organizacion_id, old.animal_id, old.tipo_evento, old.fecha_evento, old.hora_evento,
         old.intensidad_celo, old.metodo_deteccion, old.tipo_servicio, old.toro_animal_id, old.toro_externo,
         old.semen_codigo, old.protocolo_iatf, old.tecnico, old.embrion_codigo, old.embrion_raza,
         old.embrion_donadora, old.embrion_estadio, old.embrion_calidad, old.embrion_conservacion,
         old.diagnostico_resultado, old.diagnostico_metodo, old.dias_gestacion, old.aborto_causa,
         old.parto_tipo, old.numero_crias, old.observaciones, old.corrige_evento_id, old.registrado_por,
         old.registrado_at, old.client_operation_id, old.intent_hash) then
    raise exception 'reproduccion_eventos: el contenido del evento es inmutable (corregir = anular + nuevo evento)'
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;
alter function agx.fn_reproduccion_eventos_guard() owner to agx_owner;

create trigger reproduccion_eventos_guard
  before update or delete on agx.reproduccion_eventos
  for each row execute function agx.fn_reproduccion_eventos_guard();

-- Mínimo privilegio: sin DELETE; UPDATE solo de las columnas de anulación.
grant select, insert on agx.reproduccion_eventos to agx_app;
grant update (
  estado_registro, anulado_por, anulado_at, motivo_anulacion, anulacion_client_operation_id
) on agx.reproduccion_eventos to agx_app;
grant usage, select on sequence agx.reproduccion_eventos_evento_id_seq to agx_app;

grant all privileges on agx.reproduccion_eventos to agx_owner;
grant usage, select on sequence agx.reproduccion_eventos_evento_id_seq to agx_owner;
