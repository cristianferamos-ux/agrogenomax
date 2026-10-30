-- Rollback de 0025_animal_cierre_operativo.sql.
--
-- Solo seguro DESPUÉS de revertir el código que registra salidas/muertes
-- (FASE 2A); en caso contrario sus UPDATE/INSERT fallan (42703/23514).
-- Si ya existen eventos SALIDO/MUERTO, el restablecimiento del CHECK de
-- tipos de evento falla (23514) a propósito: NO se borran cierres reales.
-- Decidir antes, de forma explícita y autorizada, qué hacer con esos datos.
--   psql -1 -v ON_ERROR_STOP=1 -f 0025_animal_cierre_operativo_rollback.sql

drop index if exists agx.animal_eventos_un_cierre_idx;
alter table agx.animal_eventos drop constraint animal_eventos_tipo_check;
alter table agx.animal_eventos add constraint animal_eventos_tipo_check
  check (tipo_evento in (
    'REGISTRADO', 'DATOS_CORREGIDOS', 'ANULADO',
    'QR_ASOCIADO', 'QR_REVOCADO', 'QR_REEMPLAZADO'
  ));

revoke update (
  estado_operativo, cierre_fecha, cierre_causa, cierre_observaciones,
  cierre_at, cierre_por, cierre_client_operation_id
) on agx.animales from agx_app;

drop trigger if exists animales_cierre_guard on agx.animales;
drop function if exists agx.fn_animales_cierre_guard();
drop index if exists agx.animales_org_cierre_client_operation_key;

alter table agx.animales
  drop constraint if exists animales_cierre_observaciones_check,
  drop constraint if exists animales_cierre_fecha_orden_check,
  drop constraint if exists animales_cierre_fecha_min_check,
  drop constraint if exists animales_cierre_consistency_check,
  drop constraint if exists animales_estado_operativo_check;

alter table agx.animales
  drop column if exists cierre_client_operation_id,
  drop column if exists cierre_por,
  drop column if exists cierre_at,
  drop column if exists cierre_observaciones,
  drop column if exists cierre_causa,
  drop column if exists cierre_fecha,
  drop column if exists estado_operativo;
