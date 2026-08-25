-- SPRINT-3D7.1-AGROCLIMA
--
-- Primera versión del motor agroclimático territorial: histórico
-- append-only de snapshots de contexto agroclimático por potrero,
-- obtenidos automáticamente de ERA5-Land (primaria) e IDEAM
-- (complementaria) a partir de la geometry ya registrada del potrero --
-- nunca de coordenadas aportadas por el cliente. Aditiva pura sobre
-- 0001/0002/0003/0004/0005 -- NO los modifica.
--
-- NO calcula todavía (§25 del sprint): animales recomendados, peso
-- objetivo, días de ocupación automáticos, descanso, fecha de reentrada,
-- rotación, IA generativa. Este sprint produce INPUTS confiables para el
-- motor posterior -- no toca 3D7 (capacidad de pastoreo).
--
-- REGLA DE DOMINIO: ORGANIZACIÓN -> PREDIO -> POTRERO -> CONTEXTO
-- AGROCLIMÁTICO. Un snapshot NUNCA existe desacoplado del potrero real
-- (de ESE predio, de ESA organización) sobre el que se apoya.
--
-- MODELO HISTÓRICO (§9 del sprint): cada refresh crea una fila NUEVA --
-- nunca se actualiza ni sobrescribe un snapshot existente. Un refresh
-- fallido/parcial (COMPLETE/PARTIAL/UNAVAILABLE, ver §15 del sprint) no
-- se persiste como fila (ver potreroContextoAgroclimaticoRepository.js) --
-- solo snapshots con al menos un dato usable llegan a esta tabla.
--
-- Requiere 0000/0001/0002/0003/0004/0005 ya aplicados.
-- Nunca ejecutar contra Railway/producción sin autorización explícita
-- separada.

create table agx.potrero_contextos_agroclimaticos (
  contexto_id bigserial primary key,
  organizacion_id uuid not null,
  predio_id bigint not null,
  potrero_id bigint not null,

  -- Fecha en la que se generó este snapshot (server-side, now()::date en
  -- el momento del refresh) -- NO la fecha del dato más reciente de la
  -- fuente (eso es source_observed_until, casi siempre anterior por el
  -- rezago de ERA5-Land, §4 del sprint).
  fecha_referencia date not null,

  precipitacion_24h_mm numeric,
  precipitacion_7d_mm numeric,
  precipitacion_15d_mm numeric,
  precipitacion_30d_mm numeric,

  temperatura_media_c numeric,
  temperatura_min_c numeric,
  temperatura_max_c numeric,

  humedad_relativa_media_pct numeric,

  -- m³/m³ (ERA5-Land layer1 0-7cm / layer2 7-28cm) -- EXCLUSIVAMENTE de
  -- ERA5-Land (§22 del sprint: IDEAM reporta % de humedad de suelo a
  -- 30/50cm, magnitud física distinta, nunca mezclada aquí sin
  -- conversión válida -- ver agroClimateOrchestrator.js).
  humedad_suelo_superficial numeric,
  humedad_suelo_subsuperficial numeric,

  -- W/m² (promedio horario de la ventana de 24h) -- ver metadata en
  -- fuentes_json para el detalle de unidad exacto.
  radiacion_solar numeric,
  viento_medio_ms numeric,

  -- Último timestamp con dato real de la fuente principal (§4 del
  -- sprint) -- NUNCA se presenta este snapshot como "clima de hoy" si
  -- esta columna es anterior a fecha_referencia. NULL si ninguna fuente
  -- entregó dato (UNAVAILABLE -- aunque, ver arriba, ese caso no llega a
  -- persistirse como fila).
  source_observed_until timestamptz,

  -- 'ERA5_LAND' | 'IDEAM' -- cuál fuente ganó los campos de este snapshot
  -- (política de fusión, ver agroClimateOrchestrator.js). varchar(40)
  -- deja margen para un futuro proveedor (§2 del sprint: NASA POWER
  -- queda preparado como interfaz, no implementado todavía).
  fuente_principal varchar(40) not null,

  -- 'reanalysis' (ERA5-Land) | 'raw_observed' (IDEAM) -- ver §7 del
  -- sprint: IDEAM advierte datos crudos/no validados, nunca al mismo
  -- nivel de confianza que el reanálisis.
  calidad varchar(40),

  -- Trazabilidad completa (§11 del sprint) -- qué proveedor respondió
  -- qué, distancia de estación IDEAM, grid ERA5-Land, o el motivo de
  -- fallo de un proveedor que no contribuyó. NUNCA contiene secretos/API
  -- keys (§11 del sprint, reforzado por el propio código del
  -- orquestador -- ningún proveedor incluye credenciales en su metadata).
  fuentes_json jsonb not null default '[]',

  created_at timestamptz not null default now(),

  constraint potrero_contextos_fuente_principal_check
    check (fuente_principal in ('ERA5_LAND', 'IDEAM')),
  constraint potrero_contextos_calidad_check
    check (calidad is null or calidad in ('reanalysis', 'raw_observed')),
  constraint potrero_contextos_humedad_relativa_check
    check (humedad_relativa_media_pct is null or (humedad_relativa_media_pct >= 0 and humedad_relativa_media_pct <= 100)),
  constraint potrero_contextos_precipitacion_24h_check
    check (precipitacion_24h_mm is null or precipitacion_24h_mm >= 0),
  constraint potrero_contextos_precipitacion_7d_check
    check (precipitacion_7d_mm is null or precipitacion_7d_mm >= 0),
  constraint potrero_contextos_precipitacion_15d_check
    check (precipitacion_15d_mm is null or precipitacion_15d_mm >= 0),
  constraint potrero_contextos_precipitacion_30d_check
    check (precipitacion_30d_mm is null or precipitacion_30d_mm >= 0)
);

comment on table agx.potrero_contextos_agroclimaticos is
  'Histórico append-only de snapshots de contexto agroclimático por potrero (SPRINT-3D7.1). NUNCA se actualiza/sobrescribe una fila existente -- un nuevo refresh siempre inserta un snapshot nuevo. Fuente autoritativa del punto: ST_PointOnSurface(agx.potreros.geometry), resuelto server-side -- nunca lat/lng del cliente.';
comment on column agx.potrero_contextos_agroclimaticos.source_observed_until is
  'Último timestamp con dato REAL de la fuente principal -- ERA5-Land tiene rezago operativo de varios días (§4 del sprint). El frontend debe mostrar "Datos disponibles hasta: <esta fecha>", nunca presentar el snapshot como clima de hoy.';
comment on column agx.potrero_contextos_agroclimaticos.humedad_suelo_superficial is
  'm³/m³, EXCLUSIVAMENTE de ERA5-Land (layer1, 0-7cm). NULL si ERA5-Land no estuvo disponible en este refresh -- IDEAM nunca rellena este campo (unidad física distinta, ver comentario de tabla).';
comment on column agx.potrero_contextos_agroclimaticos.fuentes_json is
  'Trazabilidad completa por proveedor consultado en este refresh (§11 del sprint) -- incluye proveedores que fallaron, con su motivo, no solo los que contribuyeron datos. Nunca contiene secretos/API keys.';

-- FK compuesta hacia el potrero -- ancla física (organización -> predio ->
-- potrero -> contexto), mismo patrón que 0004/0005.
alter table agx.potrero_contextos_agroclimaticos
  add constraint potrero_contextos_potrero_organizacion_fkey
  foreign key (potrero_id, organizacion_id)
  references agx.potreros (potrero_id, organizacion_id);

-- FK compuesta hacia el predio -- refuerzo físico independiente, mismo
-- patrón que 0005.
alter table agx.potrero_contextos_agroclimaticos
  add constraint potrero_contextos_predio_organizacion_fkey
  foreign key (predio_id, organizacion_id)
  references agx.predios (predio_id, organizacion_id);

create index potrero_contextos_organizacion_id_idx on agx.potrero_contextos_agroclimaticos (organizacion_id);
create index potrero_contextos_potrero_id_idx on agx.potrero_contextos_agroclimaticos (potrero_id);
-- Resuelve "snapshot más reciente por potrero" (ORDER BY created_at DESC
-- LIMIT 1) sin escanear todo el histórico -- mismo patrón que
-- potrero_calculos_potrero_created_idx (0005).
create index potrero_contextos_potrero_created_idx
  on agx.potrero_contextos_agroclimaticos (potrero_id, created_at desc);

alter table agx.potrero_contextos_agroclimaticos owner to agx_owner;

alter table agx.potrero_contextos_agroclimaticos enable row level security;
alter table agx.potrero_contextos_agroclimaticos force row level security;

create policy potrero_contextos_tenant_isolation on agx.potrero_contextos_agroclimaticos
  for all
  using (organizacion_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  with check (organizacion_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

-- Grants -- histórico append-only para la aplicación: SELECT/INSERT
-- únicamente (§10 del sprint: "NO UPDATE/DELETE para runtime"). Ninguna
-- ruta de este sprint actualiza ni borra un snapshot ya guardado.
grant select, insert on agx.potrero_contextos_agroclimaticos to agx_app;
grant usage, select on sequence agx.potrero_contextos_agroclimaticos_contexto_id_seq to agx_app;

grant all privileges on agx.potrero_contextos_agroclimaticos to agx_owner;
grant usage, select on sequence agx.potrero_contextos_agroclimaticos_contexto_id_seq to agx_owner;
