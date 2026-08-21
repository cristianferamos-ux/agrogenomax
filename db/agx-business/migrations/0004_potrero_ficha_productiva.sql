-- SPRINT-3D6-FICHA-PRODUCTIVA
--
-- Ficha productiva del potrero: aforo/biomasa histórico +
-- catálogo de pasturas (sistema y personalizado). Aditiva pura sobre
-- 0001/0002/0003 -- NO los modifica, NO toca agx.predios ni agx.potreros
-- salvo para anclar FKs compuestas de lectura (mismo patrón que 0003 sobre
-- 0001). NO calcula todavía capacidad animal recomendada, días de
-- ocupación, descanso ni rotación -- eso es SPRINT 3D7, fuera de alcance
-- explícito aquí.
--
-- REGLA DE DOMINIO: ORGANIZACIÓN -> PREDIO -> POTRERO -> FICHA PRODUCTIVA.
-- Una ficha productiva NUNCA existe desacoplada de un potrero real de la
-- MISMA organización -- FK compuesta (potrero_id, organizacion_id) contra
-- agx.potreros(potrero_id, organizacion_id) (ancla ya existente,
-- potreros_id_organizacion_unique de 0003), mismo criterio que
-- agx.potreros -> agx.predios en 0003.
--
-- MODELO DE HISTORIAL (§4 del sprint): deliberadamente SIN
-- UNIQUE(potrero_id) -- un potrero puede tener muchas fichas productivas a
-- lo largo del tiempo (especie/mezcla/aforo cambian). Cada POST crea una
-- fila NUEVA -- nunca se actualiza una fila existente. "Ficha actual" es
-- una noción de lectura (la más reciente por created_at), no una columna
-- ni una restricción física.
--
-- Requiere 0000/0001/0002/0003 ya aplicados (agx.potreros debe existir).
-- Nunca ejecutar contra Railway/producción sin autorización explícita
-- separada.

-- ---------------------------------------------------------------------
-- agx.catalogo_pasturas -- catálogo EXTENSIBLE de especies/mezclas de
-- pastura. Sistema (organizacion_id NULL, visible para todas las
-- organizaciones, solo agx_owner puede insertar/editar) vs personalizado
-- (organizacion_id = tenant dueño, visible únicamente para esa
-- organización). NUNCA un catálogo plano único -- ver §5/§6 del sprint.
-- ---------------------------------------------------------------------
create table agx.catalogo_pasturas (
  pastura_id bigserial primary key,

  -- NULL = catálogo de sistema (compartido, curado por agx_owner). Un
  -- valor real = catálogo personalizado de ESA organización -- nunca
  -- visible para otra (ver política de lectura más abajo).
  organizacion_id uuid,

  nombre_comun varchar(160) not null,
  nombre_cientifico varchar(200),
  genero varchar(120),
  especie varchar(120),
  cultivar varchar(120),

  tipo varchar(20) not null,

  activo boolean not null default true,

  -- Redundante con "organizacion_id is null" pero explícito a propósito
  -- (§6 del sprint: "sistema" vs "personalizado" es una decisión de
  -- negocio, no solo un efecto lateral de que la columna sea NULL) --
  -- mismo criterio de columna auto-descriptiva que agx.potreros.tieneGeometria
  -- en la API. Un CHECK (ver abajo) mantiene ambas columnas consistentes.
  alcance varchar(20) not null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint catalogo_pasturas_tipo_check
    check (tipo in ('graminea', 'leguminosa', 'mezcla', 'otra')),
  constraint catalogo_pasturas_alcance_check
    check (alcance in ('sistema', 'personalizado')),
  -- Consistencia dura entre alcance y organizacion_id -- nunca una fila
  -- "sistema" con organizacion_id poblado, ni "personalizado" sin dueño.
  constraint catalogo_pasturas_alcance_organizacion_check
    check (
      (alcance = 'sistema' and organizacion_id is null)
      or (alcance = 'personalizado' and organizacion_id is not null)
    )
);

comment on table agx.catalogo_pasturas is
  'Catálogo extensible de pasturas -- sistema (organizacion_id NULL, curado por agx_owner, visible para todas las organizaciones) vs personalizado (organizacion_id = tenant dueño, visible únicamente para esa organización). agx_app nunca puede insertar una fila de sistema -- ver política de escritura.';
comment on column agx.catalogo_pasturas.organizacion_id is
  'Sin FK física -- agx.organizaciones vive en Postgres-AGX (otra base). NULL = catálogo de sistema. Integridad garantizada por sesión+RLS, mismo criterio que agx.predios.organizacion_id (0001).';

create index catalogo_pasturas_organizacion_id_idx on agx.catalogo_pasturas (organizacion_id);
create index catalogo_pasturas_nombre_comun_idx on agx.catalogo_pasturas (nombre_comun);

alter table agx.catalogo_pasturas owner to agx_owner;

alter table agx.catalogo_pasturas enable row level security;
alter table agx.catalogo_pasturas force row level security;

-- Lectura: catálogo de sistema (organizacion_id NULL) + catálogo propio.
-- NUNCA el catálogo personalizado de otra organización (§6 del sprint).
create policy catalogo_pasturas_read on agx.catalogo_pasturas
  for select
  using (
    organizacion_id is null
    or organizacion_id = nullif(current_setting('app.current_org_id', true), '')::uuid
  );

-- Escritura: agx_app SOLO puede crear/editar catálogo PROPIO
-- (organizacion_id = su propia organización) -- jamás una fila de
-- sistema. Insertar/curar el catálogo de sistema es tarea de agx_owner
-- (seed de este mismo archivo, ejecutado como superusuario -- ver abajo),
-- nunca de la API en runtime.
create policy catalogo_pasturas_tenant_write on agx.catalogo_pasturas
  for insert
  with check (organizacion_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

create policy catalogo_pasturas_tenant_update on agx.catalogo_pasturas
  for update
  using (organizacion_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  with check (organizacion_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

-- Grants -- agx_app SOLO SELECT/INSERT/UPDATE (crear/desactivar su propio
-- catálogo personalizado). Sin DELETE: desactivar (activo=false) es el
-- mecanismo previsto, nunca borrar filas -- una pastura personalizada ya
-- referenciada por una ficha histórica no debe poder desaparecer.
grant select, insert, update on agx.catalogo_pasturas to agx_app;
grant usage, select on sequence agx.catalogo_pasturas_pastura_id_seq to agx_app;

grant all privileges on agx.catalogo_pasturas to agx_owner;
grant usage, select on sequence agx.catalogo_pasturas_pastura_id_seq to agx_owner;

-- ---------------------------------------------------------------------
-- agx.potrero_fichas_productivas -- histórico append-only de aforo/
-- biomasa por potrero (§2/§4 del sprint).
-- ---------------------------------------------------------------------
create table agx.potrero_fichas_productivas (
  ficha_id bigserial primary key,
  organizacion_id uuid not null,
  potrero_id bigint not null,

  tipo_cobertura varchar(20) not null,

  nombre_principal varchar(160) not null,
  nombre_personalizado varchar(160),

  -- Gramos de materia FRESCA por metro cuadrado -- nunca materia seca
  -- (§10/§11 del sprint). La UI debe rotular esto explícitamente como
  -- "AFORO PROMEDIO" / "g/m² de materia fresca".
  aforo_promedio_g_m2 numeric not null,

  -- Preparado para un futuro sprint (§11) -- NUNCA usado en este sprint
  -- para convertir biomasa fresca a seca con un porcentaje universal.
  -- Permanece NULL salvo que el cliente lo registre explícitamente en un
  -- sprint posterior que lo active en la UI/API.
  porcentaje_materia_seca numeric,

  numero_muestras integer,
  fecha_aforo date,
  observaciones text,

  -- Calculado SIEMPRE server-side (área autoritativa de agx.potreros.area_ha
  -- x aforo_promedio_g_m2) -- ver §14/§15 del sprint. NUNCA confiar en un
  -- valor enviado por el cliente.
  biomasa_total_kg numeric not null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint potrero_fichas_tipo_cobertura_check
    check (tipo_cobertura in ('pastura', 'mezcla', 'otra')),
  constraint potrero_fichas_aforo_check
    check (aforo_promedio_g_m2 > 0 and aforo_promedio_g_m2 <= 10000),
  constraint potrero_fichas_muestras_check
    check (numero_muestras is null or numero_muestras >= 1),
  constraint potrero_fichas_biomasa_check
    check (biomasa_total_kg >= 0),
  constraint potrero_fichas_materia_seca_check
    check (porcentaje_materia_seca is null or (porcentaje_materia_seca > 0 and porcentaje_materia_seca <= 100))
);

comment on column agx.potrero_fichas_productivas.aforo_promedio_g_m2 is
  'AFORO PROMEDIO -- gramos de materia FRESCA por metro cuadrado (nunca materia seca en este sprint). Máximo técnico 10000 g/m² -- ver informe SPRINT-3D6 §19.';
comment on column agx.potrero_fichas_productivas.biomasa_total_kg is
  'BIOMASA FRESCA ESTIMADA (nunca "forraje disponible"/"comida disponible") -- calculada server-side: area_ha(agx.potreros) * 10000 * aforo_promedio_g_m2 / 1000. Faltan rechazo/pisoteo/residual/utilización/materia seca/consumo animal -- eso es SPRINT 3D7.';
comment on column agx.potrero_fichas_productivas.fecha_aforo is
  'Fecha real del aforo en campo -- NUNCA sustituida por created_at (esa es la fecha de registro en el sistema, puede ser posterior).';

alter table agx.potrero_fichas_productivas
  add constraint potrero_fichas_potrero_organizacion_fkey
  foreign key (potrero_id, organizacion_id)
  references agx.potreros (potrero_id, organizacion_id);

-- Ancla para la FK compuesta de agx.potrero_ficha_pasturas más abajo --
-- mismo patrón que potreros_id_organizacion_unique (0003).
alter table agx.potrero_fichas_productivas
  add constraint potrero_fichas_id_organizacion_unique unique (ficha_id, organizacion_id);

-- Deliberadamente SIN unique(potrero_id) -- §4 del sprint: historial, no
-- "una ficha actual por potrero". Cada nuevo aforo es una fila nueva.

create index potrero_fichas_organizacion_id_idx on agx.potrero_fichas_productivas (organizacion_id);
create index potrero_fichas_potrero_id_idx on agx.potrero_fichas_productivas (potrero_id);
create index potrero_fichas_organizacion_potrero_idx
  on agx.potrero_fichas_productivas (organizacion_id, potrero_id);
-- Resuelve "última ficha por potrero" (ORDER BY created_at DESC LIMIT 1)
-- sin escanear todo el histórico.
create index potrero_fichas_potrero_created_idx
  on agx.potrero_fichas_productivas (potrero_id, created_at desc);

alter table agx.potrero_fichas_productivas owner to agx_owner;

alter table agx.potrero_fichas_productivas enable row level security;
alter table agx.potrero_fichas_productivas force row level security;

create policy potrero_fichas_tenant_isolation on agx.potrero_fichas_productivas
  for all
  using (organizacion_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  with check (organizacion_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

-- Grants -- histórico append-only para la aplicación: SELECT/INSERT
-- únicamente. Ninguna ruta de este sprint actualiza ni borra una ficha ya
-- guardada (§4 del sprint: corregir un aforo es registrar una ficha
-- nueva, no editar la anterior). Si un sprint futuro necesita
-- UPDATE/DELETE explícito, es una migración/decisión separada.
grant select, insert on agx.potrero_fichas_productivas to agx_app;
grant usage, select on sequence agx.potrero_fichas_productivas_ficha_id_seq to agx_app;

grant all privileges on agx.potrero_fichas_productivas to agx_owner;
grant usage, select on sequence agx.potrero_fichas_productivas_ficha_id_seq to agx_owner;

-- ---------------------------------------------------------------------
-- agx.potrero_ficha_pasturas -- especies/mezcla asociadas a una ficha
-- (§8 del sprint). organizacion_id denormalizado a propósito (mismo
-- criterio que agx.predio_snapshots_catastrales en 0001): permite una
-- policy RLS autocontenida y ancla la FK compuesta hacia
-- potrero_fichas_productivas, garantizando a nivel de integridad
-- referencial que esta fila nunca declara una organización distinta de
-- la de la ficha que referencia.
-- ---------------------------------------------------------------------
create table agx.potrero_ficha_pasturas (
  ficha_pastura_id bigserial primary key,
  organizacion_id uuid not null,
  ficha_id bigint not null,
  pastura_id bigint not null,

  -- Opcional -- §8 del sprint: "No exigir porcentaje".
  porcentaje_estimado numeric,

  -- Orden de captura -- decide cuál especie es "principal" para derivar
  -- nombre_principal en la ficha (posición 0). Nunca alfabético ni
  -- dependiente del orden físico de inserción (que Postgres no garantiza
  -- en SELECT sin ORDER BY).
  orden smallint not null default 0,

  created_at timestamptz not null default now(),

  constraint potrero_ficha_pasturas_porcentaje_check
    check (porcentaje_estimado is null or (porcentaje_estimado > 0 and porcentaje_estimado <= 100))
);

alter table agx.potrero_ficha_pasturas
  add constraint potrero_ficha_pasturas_ficha_organizacion_fkey
  foreign key (ficha_id, organizacion_id)
  references agx.potrero_fichas_productivas (ficha_id, organizacion_id);

-- Simple (no compuesta): agx.catalogo_pasturas admite organizacion_id
-- NULL (catálogo de sistema) -- una FK compuesta (pastura_id,
-- organizacion_id) exigiría que el catálogo de sistema también llevara la
-- organización de cada ficha, lo cual rompe su naturaleza compartida.
-- Postgres no permite expresar "NULL o igual a esta otra columna" dentro
-- de una FK -- por eso el invariante real (§ hardening de este sprint:
-- una ficha de la organización A NUNCA puede enlazar una pastura
-- personalizada de la organización B) se aplica con el trigger
-- BEFORE INSERT/UPDATE de abajo, no solo con esta FK simple.
--
-- IMPORTANTE (corrección post-review): la primera versión de este
-- archivo documentaba que RLS de agx.catalogo_pasturas era suficiente
-- para esta garantía -- FALSO, confirmado con Postgres real. RLS decide
-- qué filas ve una SELECT; un INSERT en potrero_ficha_pasturas nunca hace
-- JOIN contra catalogo_pasturas, así que un pastura_id de OTRA
-- organización pasaba esta FK simple sin problema (el valor existe, es
-- la única condición que una FK simple verifica). Sin el trigger de
-- abajo, un agx_app autenticado como organización A podía enlazar
-- físicamente una pastura personalizada de la organización B con solo
-- conocer/adivinar su pastura_id -- verificado con un INSERT directo
-- real antes de este fix.
alter table agx.potrero_ficha_pasturas
  add constraint potrero_ficha_pasturas_pastura_fkey
  foreign key (pastura_id) references agx.catalogo_pasturas (pastura_id);

-- Invariante físico (no solo RLS/repository): una fila de
-- potrero_ficha_pasturas solo puede referenciar una pastura de sistema
-- (catalogo_pasturas.organizacion_id IS NULL) o una pastura personalizada
-- de la MISMA organización que NEW.organizacion_id.
--
-- TRAMPA DESCUBIERTA EN PRIMERA IMPLEMENTACIÓN (documentada a propósito):
-- un trigger BEFORE INSERT/UPDATE que corre con los privilegios del rol
-- invocador (agx_app, sin SECURITY DEFINER) hace su propio SELECT contra
-- agx.catalogo_pasturas SUJETO A LA MISMA RLS que ya filtra esa tabla --
-- si la sesión activa es organización A, la fila personalizada de la
-- organización B es invisible también PARA EL TRIGGER, así que
-- `pastura_org` sale NULL y la condición `pastura_org is not null` nunca
-- se cumple: el trigger aprueba en silencio exactamente el caso que debía
-- bloquear. Verificado con un INSERT real antes de corregirlo. La FK
-- simple de arriba SÍ ve la fila (las verificaciones de integridad
-- referencial de Postgres son internas y nunca están sujetas a RLS) --
-- por eso la FK nunca detectó el problema: la fila EXISTE, que es lo
-- único que una FK simple exige.
--
-- SOLUCIÓN: rol dedicado NOLOGIN + BYPASSRLS, dueño de una función
-- SECURITY DEFINER que SÍ ve el organizacion_id real de cualquier fila de
-- catalogo_pasturas, sin importar la sesión que disparó el INSERT/UPDATE.
-- Deliberadamente NO se toca agx_owner (que sigue sin BYPASSRLS, sujeto a
-- FORCE ROW LEVEL SECURITY como defensa en profundidad sobre TODAS sus
-- tablas) -- este rol nuevo no posee ni administra ninguna tabla, existe
-- únicamente para acotar el alcance de BYPASSRLS a esta única
-- verificación. Es NOLOGIN: nadie puede conectarse como este rol
-- directamente, su privilegio solo se ejerce a través de esta función.
--
-- Por qué no una FK compuesta que evite el trigger por completo: una FK
-- (pastura_id, organizacion_id) exigiría que las pasturas de sistema
-- también llevaran una organización por fila -- imposible sin duplicar el
-- catálogo por tenant (prohibido explícitamente) o sin poder enumerar
-- "todas las organizaciones que existen" (agx.organizaciones vive en
-- Postgres-AGX, una base física distinta -- no hay tabla de
-- organizaciones aquí contra la cual construir esa relación).
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'agx_ficha_pastura_validator') then
    create role agx_ficha_pastura_validator nologin;
  end if;
end
$$;

-- BYPASSRLS deliberado y acotado -- ver justificación completa arriba.
-- Este rol no es dueño de ninguna tabla, no tiene login, y su único
-- privilegio de datos es el SELECT explícito de abajo.
alter role agx_ficha_pastura_validator bypassrls;

grant usage on schema agx to agx_ficha_pastura_validator;
grant select on agx.catalogo_pasturas to agx_ficha_pastura_validator;

-- search_path explícito y seguro (hardening post-review, §2): pg_catalog
-- PRIMERO -- todo operador/tipo builtin (uuid, is/is not, <>) se resuelve
-- contra pg_catalog antes que contra cualquier otro esquema, así que un
-- objeto con el mismo nombre creado en otro esquema nunca puede
-- interceptarlo. agx en segundo lugar -- referencia de respaldo, aunque
-- la única tabla que toca esta función (agx.catalogo_pasturas) ya está
-- completamente schema-qualified en el cuerpo, nunca depende de esta
-- resolución. pg_temp EXPLÍCITO al final -- Postgres antepone
-- implícitamente el esquema temporal de la sesión invocadora (pg_temp_N)
-- a CUALQUIER search_path que no lo mencione; listarlo aquí, al final,
-- es lo que anula ese comportamiento por defecto y evita que agx_app cree
-- una tabla/función temporal para interceptar una referencia sin
-- schema-qualify dentro de esta función SECURITY DEFINER.
create function agx.enforce_ficha_pastura_tenant_scope()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, agx, pg_temp
as $$
declare
  pastura_org uuid;
begin
  -- SECURITY DEFINER + BYPASSRLS (agx_ficha_pastura_validator): esta
  -- SELECT ve el organizacion_id REAL de cualquier fila, nunca filtrado
  -- por la policy catalogo_pasturas_read de la sesión que disparó el
  -- INSERT/UPDATE (ver nota arriba -- ese filtrado fue exactamente lo que
  -- dejaba pasar el caso cross-tenant en la primera implementación).
  select organizacion_id into pastura_org
    from agx.catalogo_pasturas
   where pastura_id = new.pastura_id;

  if pastura_org is not null and pastura_org <> new.organizacion_id then
    -- Mensaje deliberadamente genérico (§5 del hardening): nunca revela
    -- nombre, organización propietaria ni la existencia del catálogo
    -- ajeno -- misma semántica "no existe/no accesible" que ya usa la
    -- capa de aplicación (ESPECIE_NOT_FOUND).
    raise exception 'La pastura seleccionada no existe o no pertenece a tu organización.'
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

comment on function agx.enforce_ficha_pastura_tenant_scope() is
  'Invariante físico de aislamiento tenant para agx.potrero_ficha_pasturas -- bloquea, a nivel de trigger (no solo RLS), enlazar una ficha con una pastura personalizada de OTRA organización. SECURITY DEFINER, dueño agx_ficha_pastura_validator (NOLOGIN + BYPASSRLS acotado) -- sin esto, el propio trigger queda sujeto a la RLS que oculta la fila que necesita inspeccionar. search_path = pg_catalog, agx, pg_temp (hardening post-review, §2). PUBLIC EXECUTE revocado (§6) -- ningún rol distinto de agx_owner puede invocarla directamente; el mecanismo de disparo de un trigger en Postgres NO depende de que el rol que ejecuta el INSERT/UPDATE tenga privilegio EXECUTE sobre la función asociada (se resuelve vía pg_trigger al crear el trigger, no en cada disparo), así que agx_app sigue disparándola con normalidad aunque no pueda llamarla directamente. Ver corrección post-review en el comentario de potrero_ficha_pasturas_pastura_fkey arriba.';

alter function agx.enforce_ficha_pastura_tenant_scope() owner to agx_ficha_pastura_validator;

-- §6 del hardening: Postgres concede EXECUTE a PUBLIC por defecto en toda
-- función nueva. Revocado explícitamente -- nadie necesita invocar esta
-- función directamente, solo el motor de triggers la ejecuta (y eso no
-- requiere EXECUTE, ver comentario de la función arriba). Cierra la
-- superficie callable sin afectar el mecanismo real.
revoke execute on function agx.enforce_ficha_pastura_tenant_scope() from public;

create trigger potrero_ficha_pasturas_tenant_scope_trigger
  before insert or update on agx.potrero_ficha_pasturas
  for each row
  execute function agx.enforce_ficha_pastura_tenant_scope();

create index potrero_ficha_pasturas_organizacion_id_idx on agx.potrero_ficha_pasturas (organizacion_id);
create index potrero_ficha_pasturas_ficha_id_idx on agx.potrero_ficha_pasturas (ficha_id);
create index potrero_ficha_pasturas_pastura_id_idx on agx.potrero_ficha_pasturas (pastura_id);

alter table agx.potrero_ficha_pasturas owner to agx_owner;

alter table agx.potrero_ficha_pasturas enable row level security;
alter table agx.potrero_ficha_pasturas force row level security;

create policy potrero_ficha_pasturas_tenant_isolation on agx.potrero_ficha_pasturas
  for all
  using (organizacion_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  with check (organizacion_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

-- Append-only, igual que la ficha padre -- una especie mal capturada se
-- corrige registrando una ficha nueva, no editando/borrando la anterior.
grant select, insert on agx.potrero_ficha_pasturas to agx_app;
grant usage, select on sequence agx.potrero_ficha_pasturas_ficha_pastura_id_seq to agx_app;

grant all privileges on agx.potrero_ficha_pasturas to agx_owner;
grant usage, select on sequence agx.potrero_ficha_pasturas_ficha_pastura_id_seq to agx_owner;

-- ---------------------------------------------------------------------
-- SEED -- catálogo de sistema inicial, NO exhaustivo (§7 del sprint).
-- Ejecutado como superusuario/agx_owner (nunca agx_app) -- INSERT directo
-- de filas organizacion_id NULL / alcance='sistema', algo que la propia
-- policy catalogo_pasturas_tenant_write nunca permite a agx_app.
-- Idempotente: ON CONFLICT no aplica (sin unique sobre nombre_comun a
-- propósito -- nombres comunes se repiten legítimamente entre géneros),
-- así que se guarda con un WHERE NOT EXISTS explícito por fila.
-- ---------------------------------------------------------------------
insert into agx.catalogo_pasturas (nombre_comun, nombre_cientifico, genero, especie, cultivar, tipo, alcance)
select v.nombre_comun, v.nombre_cientifico, v.genero, v.especie, v.cultivar, v.tipo, 'sistema'
from (values
  ('Brachiaria brizantha', 'Urochloa brizantha', 'Urochloa', 'brizantha', null, 'graminea'),
  ('Brachiaria brizantha cv. Marandú', 'Urochloa brizantha', 'Urochloa', 'brizantha', 'Marandú', 'graminea'),
  ('Brachiaria brizantha cv. Toledo', 'Urochloa brizantha', 'Urochloa', 'brizantha', 'Toledo', 'graminea'),
  ('Brachiaria decumbens', 'Urochloa decumbens', 'Urochloa', 'decumbens', null, 'graminea'),
  ('Brachiaria humidicola', 'Urochloa humidicola', 'Urochloa', 'humidicola', null, 'graminea'),
  ('Brachiaria ruziziensis', 'Urochloa ruziziensis', 'Urochloa', 'ruziziensis', null, 'graminea'),
  ('Mombasa', 'Megathyrsus maximus', 'Megathyrsus', 'maximus', 'Mombasa', 'graminea'),
  ('Tanzania', 'Megathyrsus maximus', 'Megathyrsus', 'maximus', 'Tanzania', 'graminea'),
  ('Guinea (Colonião)', 'Megathyrsus maximus', 'Megathyrsus', 'maximus', null, 'graminea'),
  ('Estrella africana', 'Cynodon nlemfuensis', 'Cynodon', 'nlemfuensis', null, 'graminea'),
  ('Bermuda / Pata de gallina', 'Cynodon dactylon', 'Cynodon', 'dactylon', null, 'graminea'),
  ('King grass / Pasto elefante', 'Cenchrus purpureus', 'Cenchrus', 'purpureus', null, 'graminea'),
  ('Maní forrajero', 'Arachis pintoi', 'Arachis', 'pintoi', null, 'leguminosa'),
  ('Leucaena', 'Leucaena leucocephala', 'Leucaena', 'leucocephala', null, 'leguminosa')
) as v(nombre_comun, nombre_cientifico, genero, especie, cultivar, tipo)
where not exists (
  select 1 from agx.catalogo_pasturas existing
  where existing.alcance = 'sistema'
    and existing.nombre_comun = v.nombre_comun
    and existing.cultivar is not distinct from v.cultivar
);
