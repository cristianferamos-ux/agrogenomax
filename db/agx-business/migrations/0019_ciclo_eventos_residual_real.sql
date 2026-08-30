-- SPRINT-3D9.4 -- RESIDUAL REAL POST-PASTOREO: nuevos tipos de evento en
-- agx.potrero_ciclo_eventos (log append-only, sin cambios de grants --
-- sigue SELECT/INSERT exclusivamente). Mismo patrón exacto que 0011
-- (drop + recreate del CHECK, Postgres no admite ALTER de un CHECK
-- existente).
--
-- Amplía además tipo_evento de varchar(30) a varchar(50) --
-- 'RESIDUAL_REAL_COMPARATIVO_ACTUALIZADO' (37) y
-- 'DESCANSO_ACTUALIZADO_CON_RESIDUAL_REAL' (38) exceden el límite
-- anterior.
--
-- Requiere 0000-0018 ya aplicados.

alter table agx.potrero_ciclo_eventos alter column tipo_evento type varchar(50);

alter table agx.potrero_ciclo_eventos drop constraint potrero_ciclo_eventos_tipo_check;
alter table agx.potrero_ciclo_eventos
  add constraint potrero_ciclo_eventos_tipo_check
  check (tipo_evento in (
    'PASTOREO_INICIADO', 'PASTOREO_FINALIZADO', 'PASTOREO_CANCELADO',
    'PASTOREO_ANULADO', 'PASTOREO_CORREGIDO',
    'RESIDUAL_REAL_REGISTRADO', 'RESIDUAL_REAL_COMPARATIVO_ACTUALIZADO',
    'RESIDUAL_REAL_CORREGIDO', 'RESIDUAL_REAL_ANULADO', 'DESCANSO_ACTUALIZADO_CON_RESIDUAL_REAL'
  ));

comment on column agx.potrero_ciclo_eventos.payload_json is
  'PASTOREO_INICIADO: {categoriaId, numeroAnimalesReal, pesoPromedioRealKg}. PASTOREO_CANCELADO: {motivo}. PASTOREO_FINALIZADO: {fechaSalidaReal}. PASTOREO_ANULADO: {motivo, estadoAnterior}. PASTOREO_CORREGIDO: {motivo, cambios: [{campo, valorAnterior, valorNuevo}, ...]}. SPRINT-3D9.4 -- RESIDUAL_REAL_REGISTRADO: {residualId, version}. RESIDUAL_REAL_COMPARATIVO_ACTUALIZADO: {residualId, version, residualAnteriorId}. RESIDUAL_REAL_CORREGIDO: {residualId, version, residualAnteriorId, cambios}. RESIDUAL_REAL_ANULADO: {residualId, motivo}. DESCANSO_ACTUALIZADO_CON_RESIDUAL_REAL: {residualId, descansoEstimadoOrigenId, descansoId}.';
