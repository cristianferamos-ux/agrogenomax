-- Rollback de 0023_qr_inventario_chapetas.sql.
--
-- DESTRUCTIVO: elimina el inventario QR completo (lotes, chapetas, tokens,
-- asignaciones e historial) y los eventos QR_* de agx.animal_eventos
-- (necesario para restaurar el CHECK de 0022). Solo válido mientras no
-- existan chapetas fabricadas/entregadas. Revertir primero el código.
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
drop function if exists agx.qr_admin_context();

delete from agx.animal_eventos
 where tipo_evento in ('QR_ASOCIADO', 'QR_REVOCADO', 'QR_REEMPLAZADO');

alter table agx.animal_eventos drop constraint animal_eventos_tipo_check;
alter table agx.animal_eventos add constraint animal_eventos_tipo_check
  check (tipo_evento in ('REGISTRADO', 'DATOS_CORREGIDOS', 'ANULADO'));
