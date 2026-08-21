-- Rollback de 0004_potrero_ficha_productiva.sql -- aditiva pura, así que
-- el rollback elimina únicamente los objetos creados por ella. NO afecta
-- agx.predios, agx.potreros, PostGIS, agx_owner/agx_app ni legacy/CatastroX.
--
-- SÍ elimina el rol agx_ficha_pastura_validator (creado en 0004 para el
-- invariante físico de tenant sobre potrero_ficha_pasturas, ver
-- comentario en la migración forward) -- ese rol no existía antes de
-- 0004 y no lo usa ningún otro objeto.
--
-- Orden inverso de dependencias: agx.potrero_ficha_pasturas (depende de
-- potrero_fichas_productivas y catalogo_pasturas) primero, luego
-- potrero_fichas_productivas, luego catalogo_pasturas (seed incluida --
-- DROP TABLE elimina también las filas insertadas por el seed). El rol
-- de validación se elimina DESPUÉS de soltar la función que posee (no se
-- puede DROP ROLE mientras sea dueño de un objeto).

drop policy if exists potrero_ficha_pasturas_tenant_isolation on agx.potrero_ficha_pasturas;
revoke select, insert on agx.potrero_ficha_pasturas from agx_app;
revoke usage, select on sequence agx.potrero_ficha_pasturas_ficha_pastura_id_seq from agx_app;
drop trigger if exists potrero_ficha_pasturas_tenant_scope_trigger on agx.potrero_ficha_pasturas;
drop function if exists agx.enforce_ficha_pastura_tenant_scope();
revoke select on agx.catalogo_pasturas from agx_ficha_pastura_validator;
revoke usage on schema agx from agx_ficha_pastura_validator;
drop role if exists agx_ficha_pastura_validator;
alter table if exists agx.potrero_ficha_pasturas
  drop constraint if exists potrero_ficha_pasturas_ficha_organizacion_fkey;
alter table if exists agx.potrero_ficha_pasturas
  drop constraint if exists potrero_ficha_pasturas_pastura_fkey;
drop table if exists agx.potrero_ficha_pasturas;

drop policy if exists potrero_fichas_tenant_isolation on agx.potrero_fichas_productivas;
revoke select, insert on agx.potrero_fichas_productivas from agx_app;
revoke usage, select on sequence agx.potrero_fichas_productivas_ficha_id_seq from agx_app;
alter table if exists agx.potrero_fichas_productivas
  drop constraint if exists potrero_fichas_potrero_organizacion_fkey;
drop table if exists agx.potrero_fichas_productivas;

drop policy if exists catalogo_pasturas_read on agx.catalogo_pasturas;
drop policy if exists catalogo_pasturas_tenant_write on agx.catalogo_pasturas;
drop policy if exists catalogo_pasturas_tenant_update on agx.catalogo_pasturas;
revoke select, insert, update on agx.catalogo_pasturas from agx_app;
revoke usage, select on sequence agx.catalogo_pasturas_pastura_id_seq from agx_app;
drop table if exists agx.catalogo_pasturas;
