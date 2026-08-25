-- SPRINT-3D7.2-RECOMENDACION-PASTOREO-AUTO
--
-- Motor automático de recomendación de pastoreo: el cliente selecciona una
-- categoría productiva (novillos de ceba, vacas de cría, etc.) y AgroGenomaX
-- calcula automáticamente materia seca/utilización/consumo %PV para ESA
-- categoría -- el cliente ya NO diligencia esos tres parámetros a mano como
-- flujo principal (eso sigue existiendo como "Modo técnico", 3D7,
-- 0005_potrero_capacidad_pastoreo.sql, intacto).
--
-- Dos tablas nuevas, aditivas puras sobre 0001-0006 -- NO las modifica,
-- salvo para anclar una UNIQUE compuesta adicional sobre
-- agx.potrero_contextos_agroclimaticos (mismo patrón que la ancla de 0005
-- sobre agx.potrero_fichas_productivas, ver más abajo).
--
-- REGLA DE DOMINIO: ORGANIZACIÓN -> PREDIO -> POTRERO -> FICHA PRODUCTIVA
-- (+ CONTEXTO AGROCLIMÁTICO opcional) -> CATEGORÍA PRODUCTIVA ->
-- RECOMENDACIÓN DE PASTOREO. Una recomendación NUNCA existe desacoplada de
-- la ficha productiva real sobre la que se apoya.
--
-- MODELO HISTÓRICO: cada POST create crea una fila NUEVA en
-- agx.potrero_recomendaciones_pastoreo -- nunca se actualiza ni sobrescribe
-- una recomendación existente (mismo criterio que 0005/0006).
--
-- Requiere 0000/0001/0002/0003/0004/0005/0006 ya aplicados.
-- Nunca ejecutar contra Railway/producción sin autorización explícita
-- separada.

-- =======================================================================
-- agx.catalogo_categorias_productivas -- catálogo técnico de categorías
-- de bovinos (cría/levante/ceba/leche/reproducción) con parámetros de
-- consumo de materia seca como % del peso vivo, documentados a partir de
-- NRC (2000) Nutrient Requirements of Beef Cattle (Update of the 7th
-- Revised Edition), NASEM (2016) Nutrient Requirements of Beef Cattle (8th
-- Revised Edition), NASEM (2021) Nutrient Requirements of Dairy Cattle
-- (8th Revised Edition), y guías de pastoreo tropical FAO/AGROSAVIA (ver
-- server/services/ganaderia/motorPastoreoAuto/fuentesTecnicas.js para las
-- citas exactas por código y
-- server/services/ganaderia/motorPastoreoAuto/REFERENCIAS_TECNICAS.md para
-- el detalle completo por categoría, incluyendo si el valor es ADAPTED
-- (ecuación NASEM/NRC simplificada a %PV de campo) o FALLBACK (sin tabla
-- específica -- ver categorías receptoras). NUNCA valores inventados -- si
-- una categoría no tiene evidencia suficiente, no se agrega (§4 del
-- sprint). NUNCA "NASEM 2016" para lácteos -- esa edición es Beef Cattle;
-- Dairy Cattle es NASEM 2021 (corregido en hardening SPRINT-3D7.2).
--
-- Mismo patrón sistema/personalizado que agx.catalogo_pasturas (0004):
-- organizacion_id NULL = catálogo de sistema. v1 SOLO implementa catálogo
-- de sistema (§3 del sprint: "diseñar sin bloquearlo, pero NO implementar
-- custom todavía") -- por eso agx_app recibe únicamente SELECT, sin
-- políticas de escritura todavía (a diferencia de catalogo_pasturas, que
-- sí permite personalizado). Agregar custom en un sprint futuro es
-- aditivo: nuevas políticas + grants de INSERT/UPDATE, sin tocar esta
-- migración.
-- =======================================================================
create table agx.catalogo_categorias_productivas (
  categoria_id bigserial primary key,

  -- NULL = catálogo de sistema (único soportado en v1). Columna presente
  -- desde ya para no bloquear un catálogo personalizado futuro (§3).
  organizacion_id uuid,

  codigo varchar(60) not null unique,
  nombre varchar(160) not null,

  -- Primer nivel del selector jerárquico (§2 del sprint). NO es la única
  -- fuente de verdad del agrupamiento visual -- una categoría puede
  -- aparecer bajo más de un grupo en la UI (p.ej. "Vacas secas" en Cría Y
  -- en Leche, "Toros reproductores" en Cría Y en Reproducción) sin
  -- duplicarse en este catálogo (§2: "No duplicar categorías internamente
  -- aunque aparezcan en más de un grupo visual") -- ver
  -- categoriasProductivasSelector.js en el frontend para el mapeo
  -- grupo-visual -> codigo, que es independiente de esta columna.
  grupo_productivo varchar(20) not null,

  descripcion text,
  activo boolean not null default true,

  -- Consumo de materia seca como % del peso vivo (§6 del sprint) -- rango
  -- documentado por categoría. "tipico" es el valor aplicado por el motor
  -- automático (§7); min/max quedan disponibles para referencia y para un
  -- futuro ajuste fino, no se usan todavía en el cálculo automático v1.
  consumo_ms_pct_pv_min numeric not null,
  consumo_ms_pct_pv_tipico numeric not null,
  consumo_ms_pct_pv_max numeric not null,

  -- Rango de peso de referencia (kg) -- solo informativo/validación laxa
  -- en la UI (§11 del sprint: sin fundamento para bandas inventadas, así
  -- que esto NUNCA genera una banda de peso en el resultado -- el
  -- resultado siempre muestra el peso promedio exacto ingresado).
  peso_min_referencia_kg numeric,
  peso_max_referencia_kg numeric,

  -- Campos condicionales del formulario (§6 del sprint) -- controlan qué
  -- inputs adicionales pide la UI para esta categoría. Ninguno de los tres
  -- modifica hoy la fórmula de consumo_ms_pct_pv_tipico (§5: capacidad
  -- física, no suficiencia nutricional) -- se capturan por trazabilidad y
  -- para las advertencias obligatorias de leche (§20), no como
  -- multiplicador oculto.
  requiere_produccion_leche boolean not null default false,
  requiere_ternero_al_pie boolean not null default false,
  requiere_estado_fisiologico boolean not null default false,

  -- Trazabilidad de fuente técnica por categoría (§4/§14 del sprint) --
  -- código(s) de referencia, nunca secretos. Ver REFERENCIAS_TECNICAS.md.
  metadata_tecnica jsonb not null default '{}',

  created_at timestamptz not null default now(),

  constraint catalogo_categorias_grupo_check
    check (grupo_productivo in ('cria', 'levante', 'ceba', 'leche', 'reproduccion', 'otro')),
  constraint catalogo_categorias_consumo_min_check
    check (consumo_ms_pct_pv_min > 0 and consumo_ms_pct_pv_min <= 10),
  constraint catalogo_categorias_consumo_max_check
    check (consumo_ms_pct_pv_max > 0 and consumo_ms_pct_pv_max <= 10),
  constraint catalogo_categorias_consumo_tipico_check
    check (
      consumo_ms_pct_pv_tipico >= consumo_ms_pct_pv_min
      and consumo_ms_pct_pv_tipico <= consumo_ms_pct_pv_max
    ),
  constraint catalogo_categorias_peso_referencia_check
    check (
      (peso_min_referencia_kg is null and peso_max_referencia_kg is null)
      or (
        peso_min_referencia_kg is not null and peso_max_referencia_kg is not null
        and peso_min_referencia_kg > 0 and peso_max_referencia_kg > peso_min_referencia_kg
      )
    )
);

comment on table agx.catalogo_categorias_productivas is
  'Catálogo técnico de categorías productivas bovinas (SPRINT-3D7.2) -- consumo de materia seca %PV documentado por categoría (NRC 2000 Beef / NASEM 2016 Beef / NASEM 2021 Dairy / FAO-AGROSAVIA, ver fuentesTecnicas.js y REFERENCIAS_TECNICAS.md). metadata_tecnica.fuente_tipo indica ADAPTED (ecuación NASEM/NRC simplificada a %PV) o FALLBACK (sin tabla específica de la categoría). v1: SOLO catálogo de sistema (organizacion_id NULL) -- agx_app tiene únicamente SELECT.';
comment on column agx.catalogo_categorias_productivas.consumo_ms_pct_pv_tipico is
  'PARÁMETRO TÉCNICO documentado -- valor aplicado por el motor automático v1. Nunca aportado ni sobrescrito por el cliente.';

create unique index catalogo_categorias_codigo_idx on agx.catalogo_categorias_productivas (codigo);
create index catalogo_categorias_grupo_idx on agx.catalogo_categorias_productivas (grupo_productivo);
create index catalogo_categorias_organizacion_id_idx on agx.catalogo_categorias_productivas (organizacion_id);

alter table agx.catalogo_categorias_productivas owner to agx_owner;

alter table agx.catalogo_categorias_productivas enable row level security;
alter table agx.catalogo_categorias_productivas force row level security;

-- Lectura: catálogo de sistema (organizacion_id NULL) -- mismo criterio de
-- policy que catalogo_pasturas_read, preparado para un futuro catálogo
-- personalizado sin requerir cambios de policy.
create policy catalogo_categorias_read on agx.catalogo_categorias_productivas
  for select
  using (
    organizacion_id is null
    or organizacion_id = nullif(current_setting('app.current_org_id', true), '')::uuid
  );

-- Grants -- v1 SOLO lectura para agx_app (§3 del sprint: custom no
-- implementado todavía). Curar el catálogo de sistema es tarea de
-- agx_owner (seed más abajo), nunca de la API en runtime.
grant select on agx.catalogo_categorias_productivas to agx_app;
grant usage, select on sequence agx.catalogo_categorias_productivas_categoria_id_seq to agx_app;

grant all privileges on agx.catalogo_categorias_productivas to agx_owner;
grant usage, select on sequence agx.catalogo_categorias_productivas_categoria_id_seq to agx_owner;

-- -----------------------------------------------------------------------
-- Seed del catálogo de sistema (§4/§3 del sprint) -- 13 categorías con
-- evidencia técnica documentada. "Lote mixto"/"Otro" (§19 del sprint) NO
-- se agregan aquí -- no tienen un consumo_ms_pct_pv de una sola categoría;
-- la UI los maneja como "próximamente" sin llamar al motor automático.
-- -----------------------------------------------------------------------
-- Cada fila documenta en metadata_tecnica: fuente (código de
-- fuentesTecnicas.js), fuente_tipo (ADAPTED: ecuación NASEM/NRC
-- simplificada a %PV de campo -- NUNCA una tabla plana literal; o
-- FALLBACK: sin tabla NASEM/NRC específica de la categoría, valor
-- prestado de la categoría fisiológica más cercana), fuente_edicion
-- (edición/año exacto), y nota. Ninguna fila es "DIRECT" -- NASEM/NRC
-- publican ecuaciones multivariable (peso, ganancia diaria, semana de
-- lactancia, etc.), no tablas planas de %PV; todo valor aquí es una
-- simplificación de campo derivada de esas ecuaciones (§1 hardening).
insert into agx.catalogo_categorias_productivas
  (codigo, nombre, grupo_productivo, descripcion,
   consumo_ms_pct_pv_min, consumo_ms_pct_pv_tipico, consumo_ms_pct_pv_max,
   peso_min_referencia_kg, peso_max_referencia_kg,
   requiere_produccion_leche, requiere_ternero_al_pie, requiere_estado_fisiologico,
   metadata_tecnica)
values
  ('vaca_cria_con_ternero', 'Vacas de cría con ternero', 'cria',
   'Vaca de cría en lactancia con ternero al pie -- mayor demanda energética que una vaca seca. La demanda adicional del ternero se modela por separado (ver ternero_al_pie en el motor), NO está incluida en este %PV.',
   2.0, 2.3, 2.6, 380, 550, false, true, false,
   '{"fuente": "NASEM_2016_BEEF", "fuente_tipo": "ADAPTED", "fuente_edicion": "NASEM 2016, 8th Revised Edition", "nota": "Vaca lactante con cría al pie, condición corporal media. %PV cubre SOLO a la vaca -- el consumo de forraje del ternero se suma aparte."}'),

  ('vaca_seca', 'Vacas secas', 'cria',
   'Vaca no lactante (gestante o vacía) -- consumo de mantenimiento.',
   1.8, 2.0, 2.2, 380, 550, false, false, false,
   '{"fuente": "NASEM_2016_BEEF", "fuente_tipo": "ADAPTED", "fuente_edicion": "NASEM 2016, 8th Revised Edition", "nota": "Nivel de mantenimiento, sin lactancia."}'),

  ('toro_reproductor', 'Toros reproductores', 'cria',
   'Toro adulto en mantenimiento/monta -- consumo similar a vaca seca, ajustado por peso mayor.',
   1.8, 2.0, 2.3, 550, 900, false, false, false,
   '{"fuente": "NASEM_2016_BEEF", "fuente_tipo": "ADAPTED", "fuente_edicion": "NASEM 2016, 8th Revised Edition", "nota": "Mantenimiento con actividad reproductiva moderada."}'),

  ('ternera_levante', 'Terneras de levante', 'levante',
   'Hembra en levante post-destete -- alto consumo relativo al peso vivo por crecimiento activo.',
   2.5, 2.8, 3.2, 120, 200, false, false, false,
   '{"fuente": "NASEM_2016_BEEF", "fuente_tipo": "ADAPTED", "fuente_edicion": "NASEM 2016, 8th Revised Edition", "nota": "Animal joven en crecimiento activo, alta tasa metabólica relativa."}'),

  ('ternero_levante', 'Terneros de levante', 'levante',
   'Macho en levante post-destete -- alto consumo relativo al peso vivo por crecimiento activo.',
   2.5, 2.8, 3.2, 120, 200, false, false, false,
   '{"fuente": "NASEM_2016_BEEF", "fuente_tipo": "ADAPTED", "fuente_edicion": "NASEM 2016, 8th Revised Edition", "nota": "Animal joven en crecimiento activo, alta tasa metabólica relativa."}'),

  ('novilla_levante', 'Novillas de levante', 'levante',
   'Hembra en levante intermedio, previa a ceba o reemplazo.',
   2.3, 2.6, 3.0, 200, 320, false, false, false,
   '{"fuente": "NASEM_2016_BEEF", "fuente_tipo": "ADAPTED", "fuente_edicion": "NASEM 2016, 8th Revised Edition", "nota": "Crecimiento moderado-alto, peso intermedio."}'),

  ('novillo_levante', 'Novillos de levante', 'levante',
   'Macho en levante intermedio, previo a ceba.',
   2.3, 2.6, 3.0, 200, 320, false, false, false,
   '{"fuente": "NASEM_2016_BEEF", "fuente_tipo": "ADAPTED", "fuente_edicion": "NASEM 2016, 8th Revised Edition", "nota": "Crecimiento moderado-alto, peso intermedio."}'),

  ('ternero_emposte', 'Terneros de emposte', 'ceba',
   'Animal joven en preceba/emposte, ganancia de peso acelerada.',
   2.4, 2.7, 3.0, 200, 280, false, false, false,
   '{"fuente": "NASEM_2016_BEEF", "fuente_tipo": "ADAPTED", "fuente_edicion": "NASEM 2016, 8th Revised Edition", "nota": "Fase de preceba, plano nutricional alto."}'),

  ('novillo_ceba', 'Novillos de ceba', 'ceba',
   'Animal en fase final de ceba/engorde -- consumo relativo desciende al aumentar peso.',
   2.0, 2.4, 2.8, 320, 500, false, false, false,
   '{"fuente": "NASEM_2016_BEEF", "fuente_tipo": "ADAPTED", "fuente_edicion": "NASEM 2016, 8th Revised Edition", "nota": "Ceba/finalización, menor consumo relativo por mayor peso vivo."}'),

  -- Hardening ronda 3 §1/§3: consumo_ms_pct_pv_* de ESTA fila ya NO se usa
  -- para calcular la demanda de vacas en producción -- el motor aplica
  -- literalmente la ecuación NRC (2001) de DMI de vacas lactantes (peso +
  -- litros/día + días en leche), ver recomendacionPastoreoFormulas.js
  -- computeDemandaIndividualLecheNrc2001 y fuentesTecnicas.js
  -- NRC_2001_DAIRY_DMI. Los tres valores aquí quedan SOLO como rango de
  -- referencia informativo (nunca aplicado), por eso metadata_tecnica
  -- declara fuente_tipo "ADAPTED" apuntando a NRC_2001_DAIRY_DMI, no a un
  -- %PV fijo.
  ('vaca_leche_produccion', 'Vacas en producción de leche', 'leche',
   'Vaca lactante en producción -- si el productor conoce el %grasa de la leche, la demanda se calcula con la ecuación NRC (2001) completa (peso vivo + FCM real + días en leche); si no lo conoce, se usa este %PV como perfil genérico (nunca se inventa un %grasa). Ver advertencia de suficiencia nutricional obligatoria (§20).',
   1.8, 3.0, 5.0, 400, 650, true, false, false,
   '{"fuente": "NRC_2001_DAIRY_DMI", "fuente_tipo": "ADAPTED", "fuente_edicion": "NRC 2001, 7th Revised Edition (Dairy Cattle) -- ecuación Rayburn & Fox (1993) / Fox et al. (1999), FCM = Gaines & Davidson (1923)", "nota": "consumo_ms_pct_pv_* de esta fila se USA como perfil genérico (GENERIC_LACTATING_PROFILE) SOLO cuando el productor no aporta %grasa de la leche -- en ese caso la confianza queda topada en MEDIA. Con %grasa real, la demanda usa la ecuación NRC (2001) completa con FCM correcto (0.4×leche_kg + 15×grasa_kg, ver GAINES_1923_FCM), sourceType DIRECT. Se evaluó NASEM (2021) Eq. 2-1 como preferencia -- requiere condición corporal, paridad y energía neta de la leche, no capturadas en v1 (ver NASEM_2021_DAIRY_REFERENCE_ONLY). Estimación de capacidad física de consumo -- NO sustituye balance energético/proteico de la ración."}'),

  ('novilla_reemplazo', 'Novillas de reemplazo', 'leche',
   'Hembra de levante destinada a reemplazo lechero.',
   2.4, 2.7, 3.0, 200, 400, false, false, false,
   '{"fuente": "NASEM_2021_DAIRY_GENERAL", "fuente_tipo": "ADAPTED", "fuente_edicion": "NASEM 2021, 8th Revised Edition (Dairy Cattle)", "nota": "Crecimiento pre-primer parto, sin producción de leche todavía -- no usa la ecuación de DMI de lactancia."}'),

  ('vaca_receptora', 'Vacas receptoras', 'reproduccion',
   'Vaca receptora de embriones -- consumo similar a vaca seca/mantenimiento.',
   2.0, 2.2, 2.5, 380, 550, false, false, false,
   '{"fuente": "NASEM_2016_BEEF", "fuente_tipo": "FALLBACK", "fuente_edicion": "NASEM 2016, 8th Revised Edition", "nota": "Sin tabla NASEM/NRC específica para estado receptora -- se usa el valor de mantenimiento de vaca seca como sustituto conservador. Estado reproductivo no ajusta el consumo físico en v1 (§6 del sprint 3D7.2)."}'),

  ('novilla_receptora', 'Novillas receptoras', 'reproduccion',
   'Novilla receptora de embriones -- consumo intermedio entre levante y mantenimiento adulto.',
   2.2, 2.5, 2.8, 280, 420, false, false, false,
   '{"fuente": "NASEM_2016_BEEF", "fuente_tipo": "FALLBACK", "fuente_edicion": "NASEM 2016, 8th Revised Edition", "nota": "Sin tabla NASEM/NRC específica para estado receptora -- se interpola entre levante y mantenimiento adulto como sustituto conservador. Estado reproductivo no ajusta el consumo físico en v1 (§6 del sprint 3D7.2)."}');

-- =======================================================================
-- Ancla adicional sobre agx.potrero_contextos_agroclimaticos -- mismo
-- criterio que la UNIQUE (ficha_id, potrero_id, organizacion_id) agregada
-- en 0005 sobre agx.potrero_fichas_productivas: permite que la FK
-- compuesta opcional de agx.potrero_recomendaciones_pastoreo hacia esta
-- tabla verifique a nivel de integridad referencial que contexto_id
-- realmente pertenece al potrero_id/organizacion_id declarados.
-- =======================================================================
alter table agx.potrero_contextos_agroclimaticos
  add constraint potrero_contextos_id_potrero_organizacion_unique
  unique (contexto_id, potrero_id, organizacion_id);

-- =======================================================================
-- agx.potrero_recomendaciones_pastoreo -- histórico append-only de
-- recomendaciones automáticas de pastoreo por potrero (§13 del sprint).
-- =======================================================================
create table agx.potrero_recomendaciones_pastoreo (
  recomendacion_id bigserial primary key,
  organizacion_id uuid not null,
  predio_id bigint not null,
  potrero_id bigint not null,
  ficha_id bigint not null,
  contexto_id bigint,
  categoria_id bigint not null,

  numero_animales integer not null,
  peso_promedio_kg numeric not null,
  produccion_leche_l_dia numeric,
  -- Hardening ronda 3 §1/§3: días en leche (DIM) -- input requerido por la
  -- ecuación NRC (2001) de DMI de vacas lactantes (WOL = dias_en_leche/7).
  -- NULL para cualquier categoría que no requiera producción de leche.
  dias_en_leche numeric,
  -- Hardening ronda 4 §1/§3/§4: %grasa de la leche -- OPCIONAL. Si el
  -- productor lo aporta, alimenta la fórmula FCM real (Gaines 1923, ver
  -- GAINES_1923_FCM) y la ecuación NRC (2001) corre completa (DIRECT). Si
  -- es NULL, el motor usa el perfil %PV genérico -- NUNCA se asume un
  -- %grasa (ver GENERIC_LACTATING_PROFILE en fuentesTecnicas.js).
  grasa_leche_pct numeric,

  -- PARÁMETROS APLICADOS (§7/§13 del sprint) -- siempre resueltos
  -- server-side (categoría + motor pastura/clima determinístico), nunca
  -- aceptados del cliente como valores autoritativos.
  materia_seca_pct_aplicada numeric not null,
  utilizacion_pct_aplicada numeric not null,
  consumo_pct_pv_aplicado numeric not null,

  materia_seca_total_kg numeric not null,
  materia_seca_utilizable_kg numeric not null,
  demanda_diaria_lote_kg_ms numeric not null,
  dias_ocupacion_estimados numeric not null,

  nivel_confianza varchar(10) not null,

  -- Trazabilidad completa (§14 del sprint): categoría (código/nombre/
  -- fuente técnica), pastura (tipo/fuente del ajuste), ficha_id/
  -- contexto_id ya están como columnas, pero aquí queda el detalle legible
  -- + reglas de confianza aplicadas + campos condicionales capturados
  -- (ternero al pie, litros/vaca/día ya están en columnas propias) + la
  -- versión del motor (redundante con motor_version, a propósito, para
  -- que un consumidor de este JSON no dependa de la columna). NUNCA
  -- contiene secretos.
  parametros_fuente_json jsonb not null default '{}',

  -- SPRINT §15 del sprint: cada fila histórica sabe con qué versión del
  -- motor fue calculada -- una recomendación antigua NUNCA se reinterpreta
  -- silenciosamente bajo reglas nuevas.
  motor_version varchar(40) not null,

  created_at timestamptz not null default now(),

  constraint potrero_recomendaciones_confianza_check
    check (nivel_confianza in ('ALTA', 'MEDIA', 'BAJA')),
  constraint potrero_recomendaciones_numero_animales_check
    check (numero_animales >= 1 and numero_animales <= 100000),
  constraint potrero_recomendaciones_peso_promedio_check
    check (peso_promedio_kg > 0 and peso_promedio_kg <= 2000),
  -- Hardening ronda 3: tope realista de 60 L/día (antes 100, sin
  -- justificación) -- combinado con el rango peso_min/max_referencia_kg de
  -- la categoría (ahora una cota DURA de validación, ver repositorio),
  -- mantiene el %PV equivalente derivado de la ecuación NRC (2001) dentro
  -- del CHECK de consumo_pct_pv_aplicado (<=10) para cualquier combinación
  -- válida de peso+litros.
  constraint potrero_recomendaciones_produccion_leche_check
    check (produccion_leche_l_dia is null or (produccion_leche_l_dia >= 0 and produccion_leche_l_dia <= 60)),
  constraint potrero_recomendaciones_dias_en_leche_check
    check (dias_en_leche is null or (dias_en_leche >= 0 and dias_en_leche <= 500)),
  -- Rango típico de grasa de leche bovina 2-7%; tope de 10% deja margen
  -- para razas/sistemas atípicos sin aceptar errores de digitación obvios.
  constraint potrero_recomendaciones_grasa_leche_check
    check (grasa_leche_pct is null or (grasa_leche_pct > 0 and grasa_leche_pct <= 10)),
  constraint potrero_recomendaciones_materia_seca_pct_check
    check (materia_seca_pct_aplicada > 0 and materia_seca_pct_aplicada <= 100),
  constraint potrero_recomendaciones_utilizacion_pct_check
    check (utilizacion_pct_aplicada > 0 and utilizacion_pct_aplicada <= 100),
  constraint potrero_recomendaciones_consumo_pct_check
    check (consumo_pct_pv_aplicado > 0 and consumo_pct_pv_aplicado <= 10),
  constraint potrero_recomendaciones_materia_seca_total_check
    check (materia_seca_total_kg >= 0),
  constraint potrero_recomendaciones_materia_seca_utilizable_check
    check (materia_seca_utilizable_kg >= 0),
  constraint potrero_recomendaciones_demanda_diaria_check
    check (demanda_diaria_lote_kg_ms >= 0),
  constraint potrero_recomendaciones_dias_ocupacion_check
    check (dias_ocupacion_estimados >= 0)
);

comment on table agx.potrero_recomendaciones_pastoreo is
  'Histórico append-only de recomendaciones automáticas de pastoreo (SPRINT-3D7.2) -- cada fila preserva exactamente los parámetros aplicados y resultados calculados en ese momento. NUNCA se actualiza/sobrescribe una fila existente.';
comment on column agx.potrero_recomendaciones_pastoreo.motor_version is
  'Versión del motor de recomendación automática que produjo esta fila (§15 del sprint) -- p.ej. "pastoreo-auto-v1". Permite distinguir histórico calculado con reglas distintas en el futuro.';
comment on column agx.potrero_recomendaciones_pastoreo.parametros_fuente_json is
  'Trazabilidad completa (§14 del sprint): categoría, fuente técnica de consumo, pastura, fuente técnica de pastura, reglas de confianza aplicadas, versión del motor. Nunca contiene secretos.';

-- FK compuesta hacia la ficha productiva (mismo patrón que 0005).
alter table agx.potrero_recomendaciones_pastoreo
  add constraint potrero_recomendaciones_ficha_potrero_organizacion_fkey
  foreign key (ficha_id, potrero_id, organizacion_id)
  references agx.potrero_fichas_productivas (ficha_id, potrero_id, organizacion_id);

-- FK compuesta OPCIONAL hacia el contexto agroclimático -- contexto_id
-- nullable: sin fila coincidente en ninguna columna, MATCH SIMPLE (default
-- de Postgres) no exige que la FK se satisfaga (§17 del sprint: modo
-- degradado sin contexto sigue siendo válido).
alter table agx.potrero_recomendaciones_pastoreo
  add constraint potrero_recomendaciones_contexto_potrero_organizacion_fkey
  foreign key (contexto_id, potrero_id, organizacion_id)
  references agx.potrero_contextos_agroclimaticos (contexto_id, potrero_id, organizacion_id);

-- FK simple hacia el catálogo de categorías -- catálogo de sistema
-- compartido entre organizaciones, sin componente de organizacion_id.
alter table agx.potrero_recomendaciones_pastoreo
  add constraint potrero_recomendaciones_categoria_fkey
  foreign key (categoria_id)
  references agx.catalogo_categorias_productivas (categoria_id);

-- FK compuesta hacia el potrero y hacia el predio (mismo patrón que 0005/0006).
alter table agx.potrero_recomendaciones_pastoreo
  add constraint potrero_recomendaciones_potrero_organizacion_fkey
  foreign key (potrero_id, organizacion_id)
  references agx.potreros (potrero_id, organizacion_id);

alter table agx.potrero_recomendaciones_pastoreo
  add constraint potrero_recomendaciones_predio_organizacion_fkey
  foreign key (predio_id, organizacion_id)
  references agx.predios (predio_id, organizacion_id);

create index potrero_recomendaciones_organizacion_id_idx on agx.potrero_recomendaciones_pastoreo (organizacion_id);
create index potrero_recomendaciones_potrero_id_idx on agx.potrero_recomendaciones_pastoreo (potrero_id);
create index potrero_recomendaciones_organizacion_potrero_idx
  on agx.potrero_recomendaciones_pastoreo (organizacion_id, potrero_id);
create index potrero_recomendaciones_potrero_created_idx
  on agx.potrero_recomendaciones_pastoreo (potrero_id, created_at desc);
create index potrero_recomendaciones_ficha_id_idx on agx.potrero_recomendaciones_pastoreo (ficha_id);
create index potrero_recomendaciones_categoria_id_idx on agx.potrero_recomendaciones_pastoreo (categoria_id);

alter table agx.potrero_recomendaciones_pastoreo owner to agx_owner;

alter table agx.potrero_recomendaciones_pastoreo enable row level security;
alter table agx.potrero_recomendaciones_pastoreo force row level security;

create policy potrero_recomendaciones_tenant_isolation on agx.potrero_recomendaciones_pastoreo
  for all
  using (organizacion_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  with check (organizacion_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

-- Grants -- histórico append-only para la aplicación: SELECT/INSERT
-- únicamente (§13 del sprint: "No permitir UPDATE/DELETE a agx_app").
grant select, insert on agx.potrero_recomendaciones_pastoreo to agx_app;
grant usage, select on sequence agx.potrero_recomendaciones_pastoreo_recomendacion_id_seq to agx_app;

grant all privileges on agx.potrero_recomendaciones_pastoreo to agx_owner;
grant usage, select on sequence agx.potrero_recomendaciones_pastoreo_recomendacion_id_seq to agx_owner;
