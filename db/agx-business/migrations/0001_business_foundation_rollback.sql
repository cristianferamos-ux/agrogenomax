-- Rollback de 0001_business_foundation.sql (incluye el hardening
-- SPRINT-3B1.1: FK compuesta + grants de inmutabilidad del snapshot). NO
-- afecta 0000_bootstrap_roles.sql (los roles se conservan -- eliminarlos
-- es una decisión separada, fuera de alcance de un rollback de esquema).
-- NO afecta PostGIS (extensión compartida a nivel de base; eliminarla
-- podría romper otras verticales futuras en la misma base).
--
-- Orden inverso de dependencias: primero las políticas RLS (dependen de
-- las tablas), luego los grants (revocar antes de tocar estructura evita
-- errores de "grant depende de columna" en algunos casos), luego la FK
-- compuesta de snapshots (debe caer ANTES que la tabla predios, porque
-- referencia su UNIQUE compuesta), luego las tablas en orden hijo->padre
-- (snapshots antes que predios, por la FK), y por último la UNIQUE
-- compuesta de predios queda implícitamente eliminada al hacer DROP TABLE.

drop policy if exists predio_snapshots_catastrales_tenant_isolation on agx.predio_snapshots_catastrales;
drop policy if exists predios_tenant_isolation on agx.predios;

revoke select, insert on agx.predio_snapshots_catastrales from agx_app;
revoke select, insert, update, delete on agx.predios from agx_app;
revoke usage, select on sequence agx.predios_predio_id_seq from agx_app;

alter table if exists agx.predio_snapshots_catastrales
  drop constraint if exists predio_snapshots_predio_organizacion_fkey;

drop table if exists agx.predio_snapshots_catastrales;

alter table if exists agx.predios
  drop constraint if exists predios_id_organizacion_unique;

drop table if exists agx.predios;
