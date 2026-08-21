-- SPRINT-3D7-CAPACIDAD-PASTOREO
--
-- Primera capa de decisión ganadera del potrero: a partir de una ficha
-- productiva ya registrada (area_ha + aforo + biomasa fresca, 0004),
-- calcula materia seca total/utilizable, demanda diaria del lote, días
-- de ocupación estimados y/o capacidad de animales para un período
-- objetivo. Aditiva pura sobre 0001/0002/0003/0004 -- NO los modifica,
-- salvo para anclar una UNIQUE compuesta de lectura adicional sobre
-- agx.potrero_fichas_productivas (mismo patrón que 0003/0004 sobre sus
-- respectivos padres, ver comentario más abajo).
--
-- NO calcula todavía: descanso recomendado, fecha de reentrada,
-- rotación, semáforo de disponibilidad, crecimiento diario de pastura,
-- predicción climática -- eso queda fuera de alcance explícito de este
-- sprint (ver informe SPRINT-3D7 §38).
--
-- REGLA DE DOMINIO: ORGANIZACIÓN -> PREDIO -> POTRERO -> FICHA
-- PRODUCTIVA -> CÁLCULO DE CAPACIDAD DE PASTOREO. Un cálculo NUNCA
-- existe desacoplado de la ficha productiva real (de ESE potrero, de
-- ESA organización) sobre la que se apoya.
--
-- MODELO HISTÓRICO (§3/§5 del sprint): cada POST crea una fila NUEVA en
-- agx.potrero_calculos_pastoreo -- nunca se actualiza ni sobrescribe un
-- cálculo existente. Los RESULTADOS y los PARÁMETROS TÉCNICOS usados se
-- persisten siempre (preservan el histórico exacto de lo que
-- AgroGenomaX calculó en ese momento, aunque el usuario cambie después
-- los parámetros técnicos por defecto de una nueva ejecución). La
-- biomasa fresca NO se copia -- se resuelve siempre vía ficha_id (§5).
--
-- Requiere 0000/0001/0002/0003/0004 ya aplicados.
-- Nunca ejecutar contra Railway/producción sin autorización explícita
-- separada.

-- ---------------------------------------------------------------------
-- Ancla adicional sobre agx.potrero_fichas_productivas (mismo patrón que
-- potrero_fichas_id_organizacion_unique de 0004, que a su vez sigue el
-- patrón de potreros_id_organizacion_unique de 0003): una UNIQUE
-- compuesta (ficha_id, potrero_id, organizacion_id) permite que la FK
-- compuesta de agx.potrero_calculos_pastoreo hacia esta tabla verifique,
-- a nivel de integridad referencial (no solo con un SELECT del
-- repositorio), que la ficha_id realmente pertenece al potrero_id
-- declarado -- no solo a la misma organización. Sin esto, sería posible
-- (a nivel de esquema) declarar un cálculo con un ficha_id válido de la
-- organización correcta pero perteneciente a OTRO potrero de esa misma
-- organización; el repositorio ya lo evita con su propia consulta, pero
-- esta ancla lo vuelve un invariante físico, mismo criterio que el resto
-- de FKs compuestas de este esquema.
alter table agx.potrero_fichas_productivas
  add constraint potrero_fichas_id_potrero_organizacion_unique
  unique (ficha_id, potrero_id, organizacion_id);

-- ---------------------------------------------------------------------
-- agx.potrero_calculos_pastoreo -- histórico append-only de cálculos de
-- capacidad de pastoreo por potrero (§3/§5/§27 del sprint).
-- ---------------------------------------------------------------------
create table agx.potrero_calculos_pastoreo (
  calculo_id bigserial primary key,
  organizacion_id uuid not null,
  predio_id bigint not null,
  potrero_id bigint not null,
  ficha_id bigint not null,

  -- Modo de cálculo (§18 del sprint: dos modos mutuamente excluyentes en
  -- la UI). No forma parte del listado de "campos mínimos" del sprint,
  -- pero es necesaria para reconstruir el historial (§27: "Modo" es una
  -- de las columnas exigidas en la vista de historial) sin depender de
  -- una inferencia frágil sobre qué columnas resultaron NULL.
  modo varchar(20) not null,

  -- DATOS DE ENTRADA (§13/§12 del sprint) -- NULL según el modo (ver
  -- CHECK de consistencia más abajo).
  numero_animales integer,
  peso_vivo_promedio_kg numeric,
  periodo_objetivo_dias numeric,

  -- PARÁMETROS TÉCNICOS (§2 del sprint: nunca presentados como si
  -- hubieran sido medidos) -- siempre capturados, en ambos modos.
  porcentaje_materia_seca numeric not null,
  porcentaje_utilizacion numeric not null,
  consumo_pct_peso_vivo numeric not null,

  -- RESULTADOS CALCULADOS (§2/§8/§10/§15/§16/§17 del sprint) -- siempre
  -- server-side, nunca aceptados del cliente como valores autoritativos
  -- (§22 del sprint).
  materia_seca_total_kg numeric not null,
  materia_seca_utilizable_kg numeric not null,
  demanda_diaria_lote_kg_ms numeric,
  dias_ocupacion_estimados numeric,
  capacidad_animales_periodo integer,

  observaciones text,

  created_at timestamptz not null default now(),

  constraint potrero_calculos_modo_check
    check (modo in ('dias_ocupacion', 'capacidad_animales')),

  -- Consistencia física entre modo y los campos que ese modo realmente
  -- produce/consume (§18 del sprint: los dos modos son mutuamente
  -- excluyentes, nunca un formulario con todos los campos activos a la
  -- vez) -- refuerza a nivel de esquema lo que el router ya valida.
  constraint potrero_calculos_modo_consistency_check
    check (
      (
        modo = 'dias_ocupacion'
        and numero_animales is not null
        and periodo_objetivo_dias is null
        and dias_ocupacion_estimados is not null
        and capacidad_animales_periodo is null
      )
      or (
        modo = 'capacidad_animales'
        and periodo_objetivo_dias is not null
        and numero_animales is null
        and capacidad_animales_periodo is not null
        and dias_ocupacion_estimados is null
      )
    ),

  constraint potrero_calculos_numero_animales_check
    check (numero_animales is null or (numero_animales >= 1 and numero_animales <= 100000)),
  constraint potrero_calculos_peso_vivo_check
    check (peso_vivo_promedio_kg is null or (peso_vivo_promedio_kg > 0 and peso_vivo_promedio_kg <= 2000)),
  constraint potrero_calculos_periodo_objetivo_check
    check (periodo_objetivo_dias is null or (periodo_objetivo_dias > 0 and periodo_objetivo_dias <= 365)),
  constraint potrero_calculos_materia_seca_check
    check (porcentaje_materia_seca > 0 and porcentaje_materia_seca <= 100),
  constraint potrero_calculos_utilizacion_check
    check (porcentaje_utilizacion > 0 and porcentaje_utilizacion <= 100),
  constraint potrero_calculos_consumo_check
    check (consumo_pct_peso_vivo > 0 and consumo_pct_peso_vivo <= 10),
  constraint potrero_calculos_materia_seca_total_check
    check (materia_seca_total_kg >= 0),
  constraint potrero_calculos_materia_seca_utilizable_check
    check (materia_seca_utilizable_kg >= 0),
  constraint potrero_calculos_demanda_diaria_check
    check (demanda_diaria_lote_kg_ms is null or demanda_diaria_lote_kg_ms >= 0),
  constraint potrero_calculos_dias_ocupacion_check
    check (dias_ocupacion_estimados is null or dias_ocupacion_estimados >= 0),
  constraint potrero_calculos_capacidad_animales_check
    check (capacidad_animales_periodo is null or capacidad_animales_periodo >= 0)
);

comment on table agx.potrero_calculos_pastoreo is
  'Histórico append-only de cálculos de capacidad de pastoreo -- cada fila preserva exactamente los parámetros técnicos usados y los resultados calculados en ese momento (SPRINT-3D7). NUNCA se actualiza/sobrescribe una fila existente -- corregir un cálculo es registrar uno nuevo.';
comment on column agx.potrero_calculos_pastoreo.porcentaje_materia_seca is
  'PARÁMETRO TÉCNICO introducido por el usuario/técnico -- NUNCA un valor universal asumido por el sistema (§6/§7 del sprint). No confundir con un dato medido.';
comment on column agx.potrero_calculos_pastoreo.porcentaje_utilizacion is
  'PARÁMETRO TÉCNICO -- fracción de la materia seca total que se planea aprovechar, dejando el remanente necesario en el potrero (§9 del sprint). No es una "eficiencia universal".';
comment on column agx.potrero_calculos_pastoreo.consumo_pct_peso_vivo is
  'PARÁMETRO TÉCNICO -- consumo diario estimado de materia seca como % del peso vivo, elegido por el usuario/técnico (§11 del sprint). Guardrail técnico de captura: máximo 10%, nunca un valor universal (2%/2.5%/3%) asumido automáticamente.';
comment on column agx.potrero_calculos_pastoreo.materia_seca_total_kg is
  'RESULTADO CALCULADO server-side = biomasa_fresca_kg (resuelta vía ficha_id, agx.potrero_fichas_productivas) * (porcentaje_materia_seca / 100). Nunca aceptado del cliente como valor autoritativo (§22 del sprint).';

-- FK compuesta hacia la ficha productiva -- garantiza, a nivel de
-- integridad referencial, que ficha_id/potrero_id/organizacion_id son
-- consistentes entre sí (ver la UNIQUE ancla agregada arriba).
alter table agx.potrero_calculos_pastoreo
  add constraint potrero_calculos_ficha_potrero_organizacion_fkey
  foreign key (ficha_id, potrero_id, organizacion_id)
  references agx.potrero_fichas_productivas (ficha_id, potrero_id, organizacion_id);

-- FK compuesta hacia el potrero (mismo patrón que 0004 sobre 0003) --
-- refuerzo físico independiente de la FK de arriba, útil incluso si en
-- el futuro se necesitara relajar la de ficha_id.
alter table agx.potrero_calculos_pastoreo
  add constraint potrero_calculos_potrero_organizacion_fkey
  foreign key (potrero_id, organizacion_id)
  references agx.potreros (potrero_id, organizacion_id);

-- FK compuesta hacia el predio -- ancla física completa
-- organización -> predio -> potrero (§4 del sprint: "La fila debe
-- quedar físicamente ligada a: organización -> predio -> potrero ->
-- ficha productiva").
alter table agx.potrero_calculos_pastoreo
  add constraint potrero_calculos_predio_organizacion_fkey
  foreign key (predio_id, organizacion_id)
  references agx.predios (predio_id, organizacion_id);

create index potrero_calculos_organizacion_id_idx on agx.potrero_calculos_pastoreo (organizacion_id);
create index potrero_calculos_potrero_id_idx on agx.potrero_calculos_pastoreo (potrero_id);
create index potrero_calculos_organizacion_potrero_idx
  on agx.potrero_calculos_pastoreo (organizacion_id, potrero_id);
-- Resuelve "cálculo más reciente por potrero" (ORDER BY created_at DESC
-- LIMIT 1) sin escanear todo el histórico -- mismo patrón que
-- potrero_fichas_potrero_created_idx (0004).
create index potrero_calculos_potrero_created_idx
  on agx.potrero_calculos_pastoreo (potrero_id, created_at desc);
create index potrero_calculos_ficha_id_idx on agx.potrero_calculos_pastoreo (ficha_id);

alter table agx.potrero_calculos_pastoreo owner to agx_owner;

alter table agx.potrero_calculos_pastoreo enable row level security;
alter table agx.potrero_calculos_pastoreo force row level security;

create policy potrero_calculos_tenant_isolation on agx.potrero_calculos_pastoreo
  for all
  using (organizacion_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  with check (organizacion_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

-- Grants -- histórico append-only para la aplicación: SELECT/INSERT
-- únicamente (§3 del sprint: "Modelo HISTÓRICO. No sobrescribir cálculos
-- previos"). Ninguna ruta de este sprint actualiza ni borra un cálculo
-- ya guardado.
grant select, insert on agx.potrero_calculos_pastoreo to agx_app;
grant usage, select on sequence agx.potrero_calculos_pastoreo_calculo_id_seq to agx_app;

grant all privileges on agx.potrero_calculos_pastoreo to agx_owner;
grant usage, select on sequence agx.potrero_calculos_pastoreo_calculo_id_seq to agx_owner;
