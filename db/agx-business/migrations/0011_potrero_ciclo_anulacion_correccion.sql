-- SPRINT-3D9.2 -- ANULACIÓN Y CORRECCIÓN DE CICLO REAL DE PASTOREO
--
-- Agrega el estado terminal ANULADO (ciclo histórico -- FINALIZADO o
-- CANCELADO -- que nunca debió contar, distinto de CANCELADO que es
-- "EN_CURSO creado por error"), y amplía el grant columnar de UPDATE
-- (hoy solo estado/fecha_salida_real/motivo_cancelacion) para soportar
-- corrección auditable de datos reales capturados incorrectamente.
-- Ningún UPDATE crudo del cliente -- toda mutación pasa siempre por
-- server/services/ganaderia/potreroCicloPastoreoRepository.js.
--
-- Aditiva pura salvo el reemplazo explícito de dos CHECK constraints (el
-- de estado/consistencia de agx.potrero_ciclos_pastoreo y el de
-- tipo_evento de agx.potrero_ciclo_eventos) -- Postgres no admite ALTER
-- CHECK, se DROP+ADD el mismo constraint ampliado. Requiere 0000-0010 ya
-- aplicados.

-- =======================================================================
-- agx.potrero_ciclos_pastoreo -- estado ANULADO + motivo_anulacion.
-- =======================================================================
alter table agx.potrero_ciclos_pastoreo add column if not exists motivo_anulacion text;

comment on column agx.potrero_ciclos_pastoreo.motivo_anulacion is
  'SPRINT-3D9.2: obligatorio cuando estado=ANULADO. Un ciclo ANULADO fue FINALIZADO o CANCELADO -- nunca EN_CURSO (para eso existe Cancelar) -- que se determina, después del hecho, que nunca debió contar (registro erróneo/duplicado/potrero equivocado). Las fechas/motivo_cancelacion previos NUNCA se alteran ni se nulifican -- se preservan como hecho histórico; solo cambia la vigencia operativa.';

alter table agx.potrero_ciclos_pastoreo drop constraint potrero_ciclos_pastoreo_estado_check;
alter table agx.potrero_ciclos_pastoreo
  add constraint potrero_ciclos_pastoreo_estado_check
  check (estado in ('EN_CURSO', 'FINALIZADO', 'CANCELADO', 'ANULADO'));

-- Exhaustivo y mutuamente excluyente -- misma disciplina de 0009,
-- extendida con la cuarta rama. motivo_anulacion es NULL en las tres
-- ramas no-ANULADO (nunca "medio anulado"); en ANULADO puede haber
-- venido de FINALIZADO (fecha_salida_real no nula, motivo_cancelacion
-- nulo) o de CANCELADO (fecha_salida_real nula, motivo_cancelacion no
-- nulo) -- ambas sub-ramas válidas, nunca una tercera combinación.
alter table agx.potrero_ciclos_pastoreo drop constraint potrero_ciclos_pastoreo_estado_consistency_check;
alter table agx.potrero_ciclos_pastoreo
  add constraint potrero_ciclos_pastoreo_estado_consistency_check
  check (
    (estado = 'EN_CURSO'
      and fecha_ingreso_real is not null
      and fecha_salida_real is null
      and motivo_cancelacion is null
      and motivo_anulacion is null)
    or
    (estado = 'FINALIZADO'
      and fecha_ingreso_real is not null
      and fecha_salida_real is not null
      and fecha_salida_real >= fecha_ingreso_real
      and motivo_cancelacion is null
      and motivo_anulacion is null)
    or
    (estado = 'CANCELADO'
      and fecha_ingreso_real is not null
      and fecha_salida_real is null
      and motivo_cancelacion is not null
      and btrim(motivo_cancelacion) <> ''
      and motivo_anulacion is null)
    or
    (estado = 'ANULADO'
      and fecha_ingreso_real is not null
      and motivo_anulacion is not null
      and btrim(motivo_anulacion) <> ''
      and (
        (fecha_salida_real is not null and motivo_cancelacion is null)
        or
        (fecha_salida_real is null and motivo_cancelacion is not null and btrim(motivo_cancelacion) <> '')
      ))
  );

-- Grant columnar ampliado -- cada columna nueva justificada en el diseño
-- 3D9.2 (corrección de dato real capturado incorrectamente, nunca un
-- campo derivado server-side como organizacion_id/potrero_id/predio_id/
-- recomendacion_pastoreo_id/created_at, que siguen inmutables a nivel de
-- GRANT). Se reemplaza el grant anterior (no se acumula) para que quede
-- una única fuente de verdad de qué columnas son mutables.
revoke update on agx.potrero_ciclos_pastoreo from agx_app;
grant update (
  estado,
  fecha_salida_real,
  motivo_cancelacion,
  fecha_ingreso_real,
  categoria_id,
  numero_animales_real,
  peso_promedio_real_kg,
  motivo_anulacion
) on agx.potrero_ciclos_pastoreo to agx_app;

-- =======================================================================
-- agx.potrero_ciclo_eventos -- nuevos tipos de evento (log append-only,
-- sin cambios de grants -- sigue SELECT/INSERT exclusivamente).
-- =======================================================================
alter table agx.potrero_ciclo_eventos drop constraint potrero_ciclo_eventos_tipo_check;
alter table agx.potrero_ciclo_eventos
  add constraint potrero_ciclo_eventos_tipo_check
  check (tipo_evento in (
    'PASTOREO_INICIADO', 'PASTOREO_FINALIZADO', 'PASTOREO_CANCELADO',
    'PASTOREO_ANULADO', 'PASTOREO_CORREGIDO'
  ));

comment on column agx.potrero_ciclo_eventos.payload_json is
  'PASTOREO_INICIADO: {categoriaId, numeroAnimalesReal, pesoPromedioRealKg}. PASTOREO_CANCELADO: {motivo}. PASTOREO_FINALIZADO: {fechaSalidaReal}. SPRINT-3D9.2 -- PASTOREO_ANULADO: {motivo, estadoAnterior}. PASTOREO_CORREGIDO: {motivo, cambios: [{campo, valorAnterior, valorNuevo}, ...]} -- un evento por acción de corrección, agrupando todos los campos cambiados en esa acción.';
