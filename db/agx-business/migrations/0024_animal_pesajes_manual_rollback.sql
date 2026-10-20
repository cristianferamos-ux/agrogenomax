-- Rollback de 0024_animal_pesajes_manual.sql.
--
-- Solo seguro DESPUÉS de revertir el código que registra pesajes MANUAL
-- (FASE 1A); en caso contrario los INSERT fallan (23514/42703).
-- Si ya existen filas MANUAL, el restablecimiento del CHECK de origen falla
-- (23514) a propósito: NO se borran pesajes reales. Decidir antes, de forma
-- explícita y autorizada, qué hacer con esos datos.

drop index if exists agx.animal_pesajes_org_client_operation_key;

alter table agx.animal_pesajes
  drop constraint if exists animal_pesajes_observaciones_check,
  drop constraint if exists animal_pesajes_manual_client_operation_check;

alter table agx.animal_pesajes
  drop column if exists observaciones,
  drop column if exists client_operation_id;

alter table agx.animal_pesajes
  drop constraint animal_pesajes_origen_check;

alter table agx.animal_pesajes
  add constraint animal_pesajes_origen_check
    check (origen = 'REGISTRO_INICIAL');

comment on table agx.animal_pesajes is
  'Pesajes del animal (SPRINT-3D11.2) -- append-only para agx_app (SELECT/INSERT). metodo distingue báscula de estimación. Máximo un REGISTRO_INICIAL por animal.';
