-- SPRINT-3D9.2 -- EVALUACIÓN DE REINGRESO (APTO/NO_APTO)
--
-- El sistema NUNCA decide automáticamente si un potrero está listo para
-- reingresar -- fecha_reingreso_min es una ESTIMACIÓN, nunca evidencia
-- fisiológica. Esta tabla REGISTRA el juicio humano informado (siempre
-- respaldado por un aforo NUEVO, posterior a la apertura de la ventana),
-- nunca calcula un umbral de biomasa/altura por su cuenta.
--
-- Append-only puro. Múltiples NO_APTO permitidos (cada intento de
-- evaluación es una fila nueva); como máximo UN APTO por descanso
-- (índice único parcial) -- una vez alcanzado, ese descanso queda
-- resuelto. Aditiva pura. Requiere 0000-0012 ya aplicados.

create table agx.potrero_evaluaciones_reingreso (
  evaluacion_id bigserial primary key,
  organizacion_id uuid not null,
  potrero_id bigint not null,
  ciclo_origen_id bigint not null,
  descanso_id bigint not null,

  -- El aforo NUEVO que sirve de evidencia -- obligatorio, nunca una
  -- evaluación sin un dato de campo real detrás.
  ficha_id bigint not null,

  resultado varchar(10) not null,

  -- Libre -- qué se observó/comparó (aforo medido, referencia regional
  -- consultada, etc.). Nunca una fórmula/umbral universal codificado
  -- aquí -- el juicio APTO/NO_APTO lo emite el actor humano.
  criterios_json jsonb not null default '{}',

  observacion text,

  actor_cuenta_id uuid,
  created_at timestamptz not null default now(),

  constraint potrero_evaluaciones_reingreso_resultado_check
    check (resultado in ('APTO', 'NO_APTO')),
  -- NO_APTO exige explicar por qué -- mismo criterio que
  -- motivo_cancelacion/motivo_anulacion. APTO puede llevar observación
  -- opcional.
  constraint potrero_evaluaciones_reingreso_observacion_check
    check (resultado = 'APTO' or (observacion is not null and btrim(observacion) <> ''))
);

comment on table agx.potrero_evaluaciones_reingreso is
  'SPRINT-3D9.2: registro append-only del juicio humano sobre si un potrero está APTO para reingresar tras su descanso post-real -- SIEMPRE respaldado por un aforo (ficha_id) posterior a fecha_reingreso_min. El sistema nunca decide automáticamente -- solo registra. SELECT/INSERT únicamente -- NUNCA UPDATE/DELETE.';

alter table agx.potrero_evaluaciones_reingreso
  add constraint potrero_evaluaciones_reingreso_potrero_organizacion_fkey
  foreign key (potrero_id, organizacion_id)
  references agx.potreros (potrero_id, organizacion_id);

alter table agx.potrero_evaluaciones_reingreso
  add constraint potrero_evaluaciones_reingreso_ciclo_fkey
  foreign key (ciclo_origen_id, potrero_id, organizacion_id)
  references agx.potrero_ciclos_pastoreo (ciclo_id, potrero_id, organizacion_id);

-- FK de 4 columnas (mismo anchor de 0012) -- garantiza en integridad
-- referencial que descanso_id y ciclo_origen_id realmente corresponden a
-- la misma fila de descanso, nunca una combinación inventada.
alter table agx.potrero_evaluaciones_reingreso
  add constraint potrero_evaluaciones_reingreso_descanso_ciclo_fkey
  foreign key (descanso_id, ciclo_origen_id, potrero_id, organizacion_id)
  references agx.potrero_recomendaciones_descanso (descanso_id, ciclo_pastoreo_id, potrero_id, organizacion_id);

alter table agx.potrero_evaluaciones_reingreso
  add constraint potrero_evaluaciones_reingreso_ficha_fkey
  foreign key (ficha_id, potrero_id, organizacion_id)
  references agx.potrero_fichas_productivas (ficha_id, potrero_id, organizacion_id);

-- Como máximo UN APTO por descanso -- múltiples NO_APTO nunca están
-- limitados (cada intento de evaluación es una fila nueva, ninguna se
-- borra ni se actualiza).
create unique index potrero_evaluaciones_reingreso_un_apto_idx
  on agx.potrero_evaluaciones_reingreso (descanso_id)
  where resultado = 'APTO';

create index potrero_evaluaciones_reingreso_organizacion_id_idx on agx.potrero_evaluaciones_reingreso (organizacion_id);
create index potrero_evaluaciones_reingreso_potrero_id_idx on agx.potrero_evaluaciones_reingreso (potrero_id);
create index potrero_evaluaciones_reingreso_descanso_id_idx on agx.potrero_evaluaciones_reingreso (descanso_id, created_at desc);

alter table agx.potrero_evaluaciones_reingreso owner to agx_owner;
alter table agx.potrero_evaluaciones_reingreso enable row level security;
alter table agx.potrero_evaluaciones_reingreso force row level security;

create policy potrero_evaluaciones_reingreso_tenant_isolation on agx.potrero_evaluaciones_reingreso
  for all
  using (organizacion_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  with check (organizacion_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

grant select, insert on agx.potrero_evaluaciones_reingreso to agx_app;
grant usage, select on sequence agx.potrero_evaluaciones_reingreso_evaluacion_id_seq to agx_app;

grant all privileges on agx.potrero_evaluaciones_reingreso to agx_owner;
grant usage, select on sequence agx.potrero_evaluaciones_reingreso_evaluacion_id_seq to agx_owner;
