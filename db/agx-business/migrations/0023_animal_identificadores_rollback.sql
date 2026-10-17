-- Rollback de 0023_animal_identificadores.sql.
--
-- DESTRUCTIVO: elimina agx.animal_identificadores y sus datos, y los
-- eventos QR_* de agx.animal_eventos (necesario para restaurar el CHECK
-- original de 0022). Solo válido mientras no existan QR reales impresos
-- y entregados. Revertir primero el código que los usa.
--
-- agx_app no tiene DELETE sobre animal_eventos y la tabla tiene RLS FORCE:
-- ejecutar como superusuario/admin (BYPASSRLS) y en una sola transacción
-- (psql -1 -v ON_ERROR_STOP=1).
drop table if exists agx.animal_identificadores;

delete from agx.animal_eventos
 where tipo_evento in ('QR_ASIGNADO', 'QR_REVOCADO', 'QR_REEMPLAZADO');

alter table agx.animal_eventos drop constraint animal_eventos_tipo_check;
alter table agx.animal_eventos add constraint animal_eventos_tipo_check
  check (tipo_evento in ('REGISTRADO', 'DATOS_CORREGIDOS', 'ANULADO'));
