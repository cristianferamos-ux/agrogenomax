-- Rollback de 0001_organizaciones_membresias_auth.sql
--
-- Solo seguro mientras agx.organizaciones/agx.membresias permanezcan sin
-- filas reales (Sprint 1A no inserta datos) y ninguna sesión tenga
-- organizacion_id distinto de NULL. Verificar ambas condiciones con
-- SELECT count(*) antes de ejecutar este rollback -- si alguna cuenta
-- cliente ya llegó a tener una membresía y una sesión con organización
-- activa, este rollback destruiría esa relación real; en ese caso no
-- ejecutar sin una decisión explícita y separada.

revoke execute on function agx.fn_resolver_autorizacion_sesion(text) from agx_auth;
revoke select on agx.membresias from agx_auth;
revoke select on agx.organizaciones from agx_auth;

drop trigger if exists trg_sesiones_valida_membresia_activa on agx.sesiones;
drop trigger if exists trg_organizaciones_revoca_sesiones on agx.organizaciones;
drop trigger if exists trg_membresias_revoca_sesiones on agx.membresias;

drop function if exists agx.fn_sesiones_valida_membresia_activa();
drop function if exists agx.fn_revocar_sesiones_por_organizacion_suspendida();
drop function if exists agx.fn_revocar_sesiones_por_membresia();
drop function if exists agx.fn_resolver_autorizacion_sesion(text);

drop index if exists agx.idx_sesiones_organizacion_activa;
alter table agx.sesiones drop constraint if exists sesiones_organizacion_requiere_membresia;
alter table agx.sesiones drop constraint if exists sesiones_organizacion_id_fkey;

drop table if exists agx.membresias;
drop table if exists agx.organizaciones;
