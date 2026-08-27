-- SPRINT-3D9.1 -- CICLO REAL DE PASTOREO
--
-- Separa estrictamente PLANIFICACIÓN (0007 agx.potrero_recomendaciones_pastoreo,
-- 0008 agx.potrero_recomendaciones_descanso) de EJECUCIÓN REAL. Una
-- recomendación nunca demuestra que un pastoreo ocurrió -- este archivo
-- introduce el registro de lo que REALMENTE pasó: ingreso real, salida
-- real, lote real.
--
-- MODELO HÍBRIDO (DESIGN REVISION 1, aprobado):
--   A) agx.potrero_ciclos_pastoreo -- entidad operacional/current-state,
--      MUTABLE de forma controlada (única tabla de este dominio con
--      permiso de UPDATE, column-level, nunca DELETE).
--   B) agx.potrero_ciclo_eventos -- log append-only (SELECT/INSERT
--      únicamente para agx_app, igual que el resto del esquema desde 0004).
--
-- El ciclo NO tiene estado PLANIFICADO -- la planificación ya vive en
-- 0007/0008. Nace únicamente vía la acción explícita "Iniciar pastoreo",
-- estado inicial EN_CURSO. Estados terminales: FINALIZADO, CANCELADO.
--
-- Requiere 0000-0008 ya aplicados. Nunca ejecutar contra Railway/
-- producción sin autorización explícita separada.

-- =======================================================================
-- GUARDRAIL 1 (auditoría previa a este DDL): agx.potreros tiene PK
-- (potrero_id) + UNIQUE (potrero_id, organizacion_id) [0003], pero NINGUNA
-- tabla existente en 0004-0008 verifica a nivel de integridad referencial
-- que un potrero_id declarado realmente pertenece al predio_id declarado
-- -- cada una de esas tablas usa DOS FKs compuestas SEPARADAS,
-- (potrero_id, organizacion_id) y (predio_id, organizacion_id), que NUNCA
-- se cruzan entre sí. Confirmado auditando 0007 línea por línea: el mismo
-- patrón se repite en TODA tabla previa con ambas columnas. Es un gap
-- preexistente (no introducido aquí), fuera de alcance corregir
-- retroactivamente en tablas ya en producción.
--
-- Para agx.potrero_ciclos_pastoreo SÍ se cierra desde el origen: se añade
-- una UNIQUE de 3 columnas sobre agx.potreros -- aditiva y 100% segura
-- contra datos existentes, porque potrero_id YA es único globalmente
-- (PK), por lo que (potrero_id, predio_id, organizacion_id) es trivialmente
-- único para cualquier fila ya existente (no puede fallar el ALTER). Con
-- este anchor, la FK compuesta de 3 columnas desde
-- potrero_ciclos_pastoreo verifica en una sola sentencia que el potrero
-- realmente pertenece al predio declarado, dentro de la organización
-- declarada -- nunca "el potrero existe" + "el predio existe" por
-- separado sin cruzarlos.
-- =======================================================================
alter table agx.potreros
  add constraint potreros_id_predio_organizacion_unique
  unique (potrero_id, predio_id, organizacion_id);

-- =======================================================================
-- agx.potrero_ciclos_pastoreo -- entidad operacional (current-state).
-- =======================================================================
create table agx.potrero_ciclos_pastoreo (
  ciclo_id bigserial primary key,
  organizacion_id uuid not null,
  predio_id bigint not null,
  potrero_id bigint not null,

  -- Plan de pastoreo del cual se origina este ciclo real -- NUNCA nulo:
  -- el sistema nunca permite "iniciar pastoreo" sin una base técnica
  -- considerada (mismo principio anti-improvisación de todo el motor).
  recomendacion_pastoreo_id bigint not null,

  -- SPRINT-3D9.1 DESIGN REVISION 1 (corrección 3): representa
  -- EXCLUSIVAMENTE la recomendación de descanso PLANIFICADA que existía
  -- al momento de iniciar este ciclo -- se fija una sola vez, nunca se
  -- reescribe. El descanso generado DESPUÉS de la salida real NUNCA se
  -- guarda aquí -- vive en la relación inversa
  -- potrero_recomendaciones_descanso.ciclo_pastoreo_id (más abajo).
  -- Nullable: puede no existir todavía si nunca se calculó un descanso
  -- antes de iniciar (caso degradado, no debe bloquear el ciclo).
  recomendacion_descanso_plan_id bigint,

  -- Snapshot REAL del lote al ingreso (§4 de las decisiones 3D9.1) --
  -- nombres DELIBERADAMENTE distintos a numero_animales/peso_promedio_kg
  -- de agx.potrero_recomendaciones_pastoreo para que nunca puedan
  -- confundirse planificación con ejecución, ni siquiera por accidente en
  -- una consulta SQL cruda.
  categoria_id bigint not null,
  numero_animales_real integer not null,
  peso_promedio_real_kg numeric not null,

  -- PLAN vs REAL (decisión 5 del diseño aprobado): estos dos campos son
  -- la ÚNICA fuente de verdad de "cuándo pasó realmente" -- nunca se
  -- reinterpreta una fecha planificada (fecha_inicio_pastoreo/
  -- fecha_salida_estimada de 0008) como si fuera una de estas.
  fecha_ingreso_real date not null,
  fecha_salida_real date,

  estado varchar(20) not null default 'EN_CURSO',

  -- Obligatorio SOLO en CANCELADO (CHECK exhaustivo más abajo) --
  -- auditable, nunca un DELETE.
  motivo_cancelacion text,

  -- Trazabilidad del contexto agroclimático vigente al ingreso (opcional).
  contexto_id bigint,

  created_at timestamptz not null default now(),

  constraint potrero_ciclos_pastoreo_estado_check
    check (estado in ('EN_CURSO', 'FINALIZADO', 'CANCELADO')),

  -- SPRINT-3D9.1 DESIGN REVISION 1 (corrección 4): invariantes EXHAUSTIVAS
  -- y MUTUAMENTE EXCLUYENTES por estado -- ninguna combinación fuera de su
  -- rama es posible, no solo por disciplina de aplicación.
  constraint potrero_ciclos_pastoreo_estado_consistency_check
    check (
      (estado = 'EN_CURSO'
        and fecha_ingreso_real is not null
        and fecha_salida_real is null
        and motivo_cancelacion is null)
      or
      (estado = 'FINALIZADO'
        and fecha_ingreso_real is not null
        and fecha_salida_real is not null
        and fecha_salida_real >= fecha_ingreso_real
        and motivo_cancelacion is null)
      or
      (estado = 'CANCELADO'
        and fecha_ingreso_real is not null
        and fecha_salida_real is null
        and motivo_cancelacion is not null
        and btrim(motivo_cancelacion) <> '')
    ),

  -- Mismos rangos que agx.potrero_recomendaciones_pastoreo (0007) para el
  -- lote real -- consistencia de validación entre plan y ejecución.
  constraint potrero_ciclos_pastoreo_numero_animales_check
    check (numero_animales_real >= 1 and numero_animales_real <= 100000),
  constraint potrero_ciclos_pastoreo_peso_promedio_check
    check (peso_promedio_real_kg > 0 and peso_promedio_real_kg <= 2000)
);

comment on table agx.potrero_ciclos_pastoreo is
  'Ciclo REAL de pastoreo (SPRINT-3D9.1) -- entidad operacional mutable de forma controlada (única tabla de este dominio con UPDATE permitido, column-level, nunca DELETE). Nace vía "Iniciar pastoreo" (estado inicial EN_CURSO, nunca PLANIFICADO -- eso ya vive en potrero_recomendaciones_pastoreo/descanso). Estados terminales: FINALIZADO, CANCELADO.';
comment on column agx.potrero_ciclos_pastoreo.recomendacion_descanso_plan_id is
  'SPRINT-3D9.1 DESIGN REVISION 1: la recomendación de descanso PLANIFICADA vigente al iniciar este ciclo -- fijada una sola vez, nunca reescrita. El descanso generado tras la salida real se referencia en la dirección INVERSA (potrero_recomendaciones_descanso.ciclo_pastoreo_id), nunca sobrescribiendo este campo.';
comment on column agx.potrero_ciclos_pastoreo.fecha_ingreso_real is
  'Fecha REAL de ingreso confirmada por el usuario al ejecutar "Iniciar pastoreo" -- NUNCA la fecha planificada/estimada de agx.potrero_recomendaciones_descanso.';
comment on column agx.potrero_ciclos_pastoreo.fecha_salida_real is
  'Fecha REAL de salida confirmada al ejecutar "Finalizar pastoreo" -- se convierte en el ancla del siguiente cálculo de descanso (ver potrero_recomendaciones_descanso.ciclo_pastoreo_id). NULL mientras el ciclo está EN_CURSO.';

-- Anchor compuesto (potrero + predio + organización, GUARDRAIL 1) --
-- ÚNICA FK necesaria hacia potrero/predio: verifica en una sola sentencia
-- que este potrero_id realmente pertenece a este predio_id, dentro de
-- esta organización -- nunca dos FKs separadas que nunca se cruzan.
alter table agx.potrero_ciclos_pastoreo
  add constraint potrero_ciclos_pastoreo_potrero_predio_organizacion_fkey
  foreign key (potrero_id, predio_id, organizacion_id)
  references agx.potreros (potrero_id, predio_id, organizacion_id);

-- Anchor propio -- permite que agx.potrero_ciclo_eventos y la extensión de
-- agx.potrero_recomendaciones_descanso (más abajo) referencien este ciclo
-- de forma tenant-safe.
alter table agx.potrero_ciclos_pastoreo
  add constraint potrero_ciclos_id_potrero_organizacion_unique
  unique (ciclo_id, potrero_id, organizacion_id);

alter table agx.potrero_ciclos_pastoreo
  add constraint potrero_ciclos_pastoreo_recomendacion_pastoreo_fkey
  foreign key (recomendacion_pastoreo_id, potrero_id, organizacion_id)
  references agx.potrero_recomendaciones_pastoreo (recomendacion_id, potrero_id, organizacion_id);

alter table agx.potrero_ciclos_pastoreo
  add constraint potrero_ciclos_pastoreo_recomendacion_descanso_plan_fkey
  foreign key (recomendacion_descanso_plan_id, potrero_id, organizacion_id)
  references agx.potrero_recomendaciones_descanso (descanso_id, potrero_id, organizacion_id);

alter table agx.potrero_ciclos_pastoreo
  add constraint potrero_ciclos_pastoreo_contexto_fkey
  foreign key (contexto_id, potrero_id, organizacion_id)
  references agx.potrero_contextos_agroclimaticos (contexto_id, potrero_id, organizacion_id);

alter table agx.potrero_ciclos_pastoreo
  add constraint potrero_ciclos_pastoreo_categoria_fkey
  foreign key (categoria_id)
  references agx.catalogo_categorias_productivas (categoria_id);

-- GARANTÍA CRÍTICA (punto 8 del diseño aprobado): máximo UN ciclo EN_CURSO
-- por organización+potrero, garantizado por el motor de base de datos --
-- nunca solo por el frontend/aplicación. Índice PARCIAL: solo restringe
-- filas con estado='EN_CURSO', nunca limita cuántos ciclos históricos
-- (FINALIZADO/CANCELADO) puede acumular un potrero.
create unique index potrero_ciclos_pastoreo_un_en_curso_idx
  on agx.potrero_ciclos_pastoreo (organizacion_id, potrero_id)
  where estado = 'EN_CURSO';

create index potrero_ciclos_pastoreo_organizacion_id_idx on agx.potrero_ciclos_pastoreo (organizacion_id);
create index potrero_ciclos_pastoreo_potrero_id_idx on agx.potrero_ciclos_pastoreo (potrero_id);
create index potrero_ciclos_pastoreo_organizacion_potrero_idx
  on agx.potrero_ciclos_pastoreo (organizacion_id, potrero_id);
create index potrero_ciclos_pastoreo_potrero_created_idx
  on agx.potrero_ciclos_pastoreo (potrero_id, created_at desc);

alter table agx.potrero_ciclos_pastoreo owner to agx_owner;

alter table agx.potrero_ciclos_pastoreo enable row level security;
alter table agx.potrero_ciclos_pastoreo force row level security;

create policy potrero_ciclos_pastoreo_tenant_isolation on agx.potrero_ciclos_pastoreo
  for all
  using (organizacion_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  with check (organizacion_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

-- Grants -- ÚNICA tabla de todo este dominio con UPDATE permitido, y
-- deliberadamente column-level: agx_app JAMÁS puede reescribir
-- organizacion_id/potrero_id/fecha_ingreso_real/numero_animales_real/
-- peso_promedio_real_kg/categoria_id/las FKs de origen -- esos campos
-- quedan INMUTABLES tras la creación a nivel de GRANT, no solo de
-- disciplina de aplicación. NUNCA DELETE.
grant select, insert on agx.potrero_ciclos_pastoreo to agx_app;
grant update (estado, fecha_salida_real, motivo_cancelacion) on agx.potrero_ciclos_pastoreo to agx_app;
grant usage, select on sequence agx.potrero_ciclos_pastoreo_ciclo_id_seq to agx_app;

grant all privileges on agx.potrero_ciclos_pastoreo to agx_owner;
grant usage, select on sequence agx.potrero_ciclos_pastoreo_ciclo_id_seq to agx_owner;

-- =======================================================================
-- agx.potrero_ciclo_eventos -- log append-only (auditoría inmutable,
-- independiente del estado ACTUAL de la fila mutable de arriba).
--
-- DECISIÓN DOCUMENTADA (Guardrail 2, "predio_id redundante"): esta tabla
-- NO tiene columna predio_id -- es 100% derivable vía JOIN a
-- potrero_ciclos_pastoreo (ciclo_id), y mantenerlo aquí exigiría una
-- tercera FK cruzada solo para mantenerlo consistente con el ciclo,
-- reintroduciendo el mismo tipo de acoplamiento redundante que el
-- Guardrail 1 corrigió arriba. Se conserva organizacion_id (necesario
-- para RLS evaluable sin JOIN) y potrero_id (consultas directas por
-- potrero sin JOIN) -- mínimo modelo consistente.
-- =======================================================================
create table agx.potrero_ciclo_eventos (
  evento_id bigserial primary key,
  organizacion_id uuid not null,
  potrero_id bigint not null,
  ciclo_id bigint not null,

  tipo_evento varchar(30) not null,

  -- Instante PRECISO del evento -- separado deliberadamente de la fecha
  -- de NEGOCIO (America/Bogota) que vive en potrero_ciclos_pastoreo,
  -- consistente con la separación ya usada en todo el esquema entre
  -- "fecha calendario" (date) y "auditoría de fila" (timestamptz).
  ocurrido_en timestamptz not null default now(),

  -- SPRINT-3D9.1: actor real -- reutiliza req.ganaderiaAuth.cuentaId, ya
  -- disponible en toda request autenticada (server/security/ganaderiaSession.js).
  -- Sin FK: cuentaId vive en Postgres-AGX (base de identidad), una base
  -- física distinta de Postgres-AGX-Business -- mismo criterio ya usado
  -- para organizacion_id en todo este esquema (sin FK cruzada entre bases).
  actor_cuenta_id uuid,

  -- Hecho específico del evento -- auto-suficiente para auditoría incluso
  -- si la fila mutable de potrero_ciclos_pastoreo llegara a corregirse en
  -- el futuro. Ver comentarios por tipo_evento más abajo.
  payload_json jsonb not null default '{}',

  constraint potrero_ciclo_eventos_tipo_check
    check (tipo_evento in ('PASTOREO_INICIADO', 'PASTOREO_FINALIZADO', 'PASTOREO_CANCELADO'))
);

comment on table agx.potrero_ciclo_eventos is
  'Log append-only de eventos de ciclo real de pastoreo (SPRINT-3D9.1) -- fuente de auditoría independiente del estado ACTUAL (mutable) de agx.potrero_ciclos_pastoreo. SELECT/INSERT únicamente para agx_app -- NUNCA UPDATE/DELETE.';
comment on column agx.potrero_ciclo_eventos.payload_json is
  'PASTOREO_INICIADO: {categoriaId, numeroAnimalesReal, pesoPromedioRealKg} (snapshot del lote). PASTOREO_CANCELADO: {motivo}. PASTOREO_FINALIZADO: {fechaSalidaReal} -- deliberadamente SIN referencia a la recomendación de descanso resultante (puede no existir todavía al insertar este evento, y el evento es append-only -- nunca se reescribe después; la relación se deriva de potrero_recomendaciones_descanso.ciclo_pastoreo_id, fuente suficiente, ver Design Revision 1 sección D).';

alter table agx.potrero_ciclo_eventos
  add constraint potrero_ciclo_eventos_ciclo_potrero_organizacion_fkey
  foreign key (ciclo_id, potrero_id, organizacion_id)
  references agx.potrero_ciclos_pastoreo (ciclo_id, potrero_id, organizacion_id);

alter table agx.potrero_ciclo_eventos
  add constraint potrero_ciclo_eventos_potrero_organizacion_fkey
  foreign key (potrero_id, organizacion_id)
  references agx.potreros (potrero_id, organizacion_id);

create index potrero_ciclo_eventos_organizacion_id_idx on agx.potrero_ciclo_eventos (organizacion_id);
create index potrero_ciclo_eventos_ciclo_id_idx on agx.potrero_ciclo_eventos (ciclo_id, ocurrido_en);
create index potrero_ciclo_eventos_potrero_organizacion_idx
  on agx.potrero_ciclo_eventos (organizacion_id, potrero_id);

alter table agx.potrero_ciclo_eventos owner to agx_owner;

alter table agx.potrero_ciclo_eventos enable row level security;
alter table agx.potrero_ciclo_eventos force row level security;

create policy potrero_ciclo_eventos_tenant_isolation on agx.potrero_ciclo_eventos
  for all
  using (organizacion_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  with check (organizacion_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

-- Grants -- append-only PURO. NUNCA UPDATE/DELETE, ni siquiera column-level.
grant select, insert on agx.potrero_ciclo_eventos to agx_app;
grant usage, select on sequence agx.potrero_ciclo_eventos_evento_id_seq to agx_app;

grant all privileges on agx.potrero_ciclo_eventos to agx_owner;
grant usage, select on sequence agx.potrero_ciclo_eventos_evento_id_seq to agx_owner;

-- =======================================================================
-- Extensión de agx.potrero_recomendaciones_descanso (0008) -- ancla
-- explícita hacia el ciclo real que originó un descanso POST-salida-real
-- (SPRINT-3D9.1 DESIGN REVISION 1, corrección 2). Nullable: los descansos
-- PLANIFICADOS (calculados antes de cualquier ingreso real, o vía
-- "Actualizar estimación") NUNCA tienen ciclo asociado.
-- =======================================================================
alter table agx.potrero_recomendaciones_descanso
  add column ciclo_pastoreo_id bigint;

alter table agx.potrero_recomendaciones_descanso
  add constraint potrero_descansos_ciclo_pastoreo_fkey
  foreign key (ciclo_pastoreo_id, potrero_id, organizacion_id)
  references agx.potrero_ciclos_pastoreo (ciclo_id, potrero_id, organizacion_id);

-- IDEMPOTENCIA ESTRUCTURAL (objetivo explícito de la corrección 2): un
-- ciclo real produce COMO MÁXIMO una recomendación de descanso generada
-- desde su salida real. Índice PARCIAL: nunca limita la cantidad de
-- descansos PLANIFICADOS (ciclo_pastoreo_id IS NULL). Garantiza que un
-- retry concurrente de FASE B (ver potreroCicloPastoreoRepository.js)
-- nunca produzca dos filas para el mismo ciclo -- el segundo INSERT
-- falla con 23505 y el perdedor relee la fila ganadora.
create unique index potrero_recomendaciones_descanso_un_ciclo_idx
  on agx.potrero_recomendaciones_descanso (ciclo_pastoreo_id)
  where ciclo_pastoreo_id is not null;

comment on column agx.potrero_recomendaciones_descanso.ciclo_pastoreo_id is
  'SPRINT-3D9.1: ciclo real de pastoreo cuya salida REAL ancló este cálculo de descanso (FASE B de "Finalizar pastoreo") -- NULL para descansos PLANIFICADOS (calculados antes de cualquier ingreso real). Relación INVERSA de potrero_ciclos_pastoreo.recomendacion_descanso_plan_id -- nunca el mismo campo, nunca conflación planificación/ejecución.';
