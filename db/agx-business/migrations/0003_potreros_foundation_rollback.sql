-- Rollback de 0003_potreros_foundation.sql -- aditiva pura, así que el
-- rollback elimina únicamente los objetos creados por ella. NO afecta
-- agx.predios, agx.predio_snapshots_catastrales, PostGIS, roles
-- (0000_bootstrap_roles.sql), legacy ni CatastroX.
--
-- Orden inverso de dependencias: política RLS primero (depende de la
-- tabla), luego grants, luego la FK compuesta (por prolijidad explícita,
-- aunque DROP TABLE la eliminaría igual), y por último la tabla -- la
-- UNIQUE compuesta potreros_id_organizacion_unique y el resto de
-- constraints quedan implícitamente eliminados al hacer DROP TABLE.

drop policy if exists potreros_tenant_isolation on agx.potreros;

revoke select, insert, update, delete on agx.potreros from agx_app;
revoke usage, select on sequence agx.potreros_potrero_id_seq from agx_app;

alter table if exists agx.potreros
  drop constraint if exists potreros_predio_organizacion_fkey;

drop table if exists agx.potreros;
