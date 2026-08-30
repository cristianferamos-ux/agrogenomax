-- Rollback de 0019_ciclo_eventos_residual_real.sql.
--
-- Revertir requiere que ninguna fila use los tipos de evento nuevos (o el
-- DROP+ADD del CHECK fallaría) -- responsabilidad del operador, mismo
-- criterio que cualquier rollback de esta serie.

alter table agx.potrero_ciclo_eventos drop constraint potrero_ciclo_eventos_tipo_check;
alter table agx.potrero_ciclo_eventos
  add constraint potrero_ciclo_eventos_tipo_check
  check (tipo_evento in (
    'PASTOREO_INICIADO', 'PASTOREO_FINALIZADO', 'PASTOREO_CANCELADO',
    'PASTOREO_ANULADO', 'PASTOREO_CORREGIDO'
  ));
alter table agx.potrero_ciclo_eventos alter column tipo_evento type varchar(30);
