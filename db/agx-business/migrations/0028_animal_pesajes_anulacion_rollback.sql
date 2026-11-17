-- Rollback de 0028 (FASE 5A.1a).
--
-- 0028 es FORWARD-ONLY en producción: una vez aplicada sobre producción con
-- datos, las correcciones se realizan mediante una migración posterior.
-- Este rollback solo es válido en una base vacía o desechable:
--   * el runner lo bloquea antes de ejecutarlo si alguna columna que borra
--     tiene valores (estado_registro es NOT NULL: basta un pesaje);
--   * además aborta aquí si agx.animal_pesajes tiene cualquier fila, también
--     si se ejecutara fuera del runner (perdería el estado de anulación y,
--     con pesajes ANULADO, los resucitaría como válidos).

do $$
begin
  if exists (select 1 from agx.animal_pesajes) then
    raise exception 'rollback 0028: agx.animal_pesajes tiene filas; 0028 es forward-only (corregir con una migración posterior)';
  end if;
end
$$;

revoke update (estado_registro, anulado_por, anulado_at, motivo_anulacion, anulacion_client_operation_id)
  on agx.animal_pesajes from agx_app;

drop trigger animal_pesajes_guard on agx.animal_pesajes;
drop function agx.fn_animal_pesajes_guard();

drop index agx.animal_pesajes_org_anulacion_client_operation_key;

alter table agx.animal_pesajes
  drop constraint animal_pesajes_anulacion_consistency_check,
  drop constraint animal_pesajes_estado_registro_check;

alter table agx.animal_pesajes
  drop column anulacion_client_operation_id,
  drop column motivo_anulacion,
  drop column anulado_at,
  drop column anulado_por,
  drop column estado_registro;

comment on table agx.animal_pesajes is
  'Pesajes del animal (0022, FASE 1A 0024) -- fuente de verdad del historial de peso; append-only para agx_app (SELECT/INSERT). origen REGISTRO_INICIAL (máximo uno por animal, NO es peso al nacimiento) o MANUAL (N por animal, idempotente por client_operation_id). metodo distingue báscula de estimación.';
