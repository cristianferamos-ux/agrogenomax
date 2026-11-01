-- Rollback de 0026_reproduccion_bovina.sql.
--
-- Solo seguro DESPUÉS de revertir el código de reproducción (FASE 4A); en
-- caso contrario sus SELECT/INSERT fallan (42P01).
-- Si ya existen eventos reproductivos, este rollback se NIEGA (23514) a
-- propósito: NO se borra historial reproductivo real. Decidir antes, de
-- forma explícita y autorizada, qué hacer con esos datos.
--   psql -1 -v ON_ERROR_STOP=1 -f 0026_reproduccion_bovina_rollback.sql

do $$
begin
  if exists (select 1 from agx.reproduccion_eventos) then
    raise exception 'rollback 0026: agx.reproduccion_eventos tiene datos; no se borra historial reproductivo'
      using errcode = 'check_violation';
  end if;
end
$$;

drop table if exists agx.reproduccion_eventos;
drop function if exists agx.fn_reproduccion_eventos_guard();
