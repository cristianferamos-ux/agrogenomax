-- Rollback de 0023_qr_inventario_chapetas.sql.
--
-- DESTRUCTIVO: elimina el inventario QR completo (lotes, chapetas, tokens
-- cifrados, asignaciones e historial), los eventos QR_* de
-- agx.animal_eventos (necesario para restaurar el CHECK de 0022) y los
-- privilegios del rol agx_qr_admin. El ROL no se elimina aquí (puede tener
-- conexiones activas): retirarlo aparte con DROP ROLE agx_qr_admin tras
-- quitar AGX_BUSINESS_QR_ADMIN_DATABASE_URL del servicio. Solo válido
-- mientras no existan chapetas fabricadas/entregadas. Revertir primero el
-- código.
--
-- agx_app no tiene DELETE y las tablas tienen RLS FORCE: ejecutar como
-- superusuario/admin (BYPASSRLS) y en una sola transacción
-- (psql -1 -v ON_ERROR_STOP=1).
drop table if exists agx.qr_lote_eventos;
drop table if exists agx.qr_chapeta_eventos;
drop table if exists agx.qr_chapeta_tokens;
drop table if exists agx.qr_chapetas;
drop table if exists agx.qr_asignaciones;
drop table if exists agx.qr_lotes;
drop function if exists agx.fn_qr_chapetas_guard();
drop function if exists agx.fn_qr_codigo_control_ok(text);

delete from agx.animal_eventos
 where tipo_evento in ('QR_ASOCIADO', 'QR_REVOCADO', 'QR_REEMPLAZADO');

alter table agx.animal_eventos drop constraint animal_eventos_tipo_check;
alter table agx.animal_eventos add constraint animal_eventos_tipo_check
  check (tipo_evento in ('REGISTRADO', 'DATOS_CORREGIDOS', 'ANULADO'));

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'agx_qr_admin') then
    revoke all on agx.animales, agx.animal_eventos from agx_qr_admin;
    revoke all on sequence agx.animal_eventos_evento_id_seq from agx_qr_admin;
    revoke usage on schema agx from agx_qr_admin;
    execute format('revoke connect on database %I from agx_qr_admin', current_database());
  end if;
end
$$;
