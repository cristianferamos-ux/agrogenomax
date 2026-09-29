-- Rollback de 0021_predio_client_operation_id.sql.
--
-- Solo seguro DESPUÉS de revertir el código que usa la columna (PR 1 de
-- SPRINT-3D10.7); en caso contrario el INSERT idempotente falla (42703).
-- Pierde únicamente los client_operation_id (sin impacto en predios).

drop index if exists agx.predios_org_client_operation_id_key;

alter table agx.predios
  drop column if exists client_operation_id;
