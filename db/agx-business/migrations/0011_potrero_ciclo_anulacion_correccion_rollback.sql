-- Rollback de 0011_potrero_ciclo_anulacion_correccion.sql -- restaura
-- exactamente el estado de 0009 (estado_check sin ANULADO, consistency
-- check de 3 ramas, grant columnar original de 3 columnas, tipo_evento
-- sin PASTOREO_ANULADO/PASTOREO_CORREGIDO).
--
-- Requiere que ningún ciclo esté actualmente en estado ANULADO ni ningún
-- evento sea PASTOREO_ANULADO/PASTOREO_CORREGIDO -- si los hay, este
-- rollback fallará al reinstalar los CHECK originales (comportamiento
-- deseado: nunca perder silenciosamente el registro de una anulación ya
-- ocurrida).

alter table agx.potrero_ciclo_eventos drop constraint potrero_ciclo_eventos_tipo_check;
alter table agx.potrero_ciclo_eventos
  add constraint potrero_ciclo_eventos_tipo_check
  check (tipo_evento in ('PASTOREO_INICIADO', 'PASTOREO_FINALIZADO', 'PASTOREO_CANCELADO'));

revoke update on agx.potrero_ciclos_pastoreo from agx_app;
grant update (estado, fecha_salida_real, motivo_cancelacion) on agx.potrero_ciclos_pastoreo to agx_app;

alter table agx.potrero_ciclos_pastoreo drop constraint potrero_ciclos_pastoreo_estado_consistency_check;
alter table agx.potrero_ciclos_pastoreo
  add constraint potrero_ciclos_pastoreo_estado_consistency_check
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
  );

alter table agx.potrero_ciclos_pastoreo drop constraint potrero_ciclos_pastoreo_estado_check;
alter table agx.potrero_ciclos_pastoreo
  add constraint potrero_ciclos_pastoreo_estado_check
  check (estado in ('EN_CURSO', 'FINALIZADO', 'CANCELADO'));

alter table agx.potrero_ciclos_pastoreo drop column if exists motivo_anulacion;
