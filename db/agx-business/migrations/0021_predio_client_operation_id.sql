-- SPRINT-3D10.7 -- idempotencia de la creación MANUAL de predios
-- (POST /api/ganaderia/predios, mode='manual').
--
-- Aditiva pura:
-- - client_operation_id es NULL-able, sin DEFAULT. Filas existentes quedan
--   NULL; NO se ejecuta ningún UPDATE/backfill.
-- - No toca codigo_predial, geometry, estado/archivo, snapshots
--   catastrales, RLS, políticas ni grants (los grants de agx_app son de
--   tabla y cubren la columna nueva).
-- - Índice UNIQUE parcial tenant-scoped: una operación del cliente crea a
--   lo sumo UN predio por organización. Filas NULL (históricas, CatastroX,
--   clientes legacy) quedan fuera del índice -- mismo patrón que
--   predios_org_codigo_predial_key (0001).
-- - No filtra por estado: un predio ARCHIVADO sigue reservando su operación.

alter table agx.predios
  add column if not exists client_operation_id uuid;

comment on column agx.predios.client_operation_id is
  'UUID generado por el frontend una vez por intención de creación MANUAL (SPRINT-3D10.7). Idempotencia de reintentos tras resultado incierto. NULL = fila histórica, CatastroX o cliente legacy. Nunca se expone al usuario.';

create unique index if not exists predios_org_client_operation_id_key
  on agx.predios (organizacion_id, client_operation_id)
  where client_operation_id is not null;
