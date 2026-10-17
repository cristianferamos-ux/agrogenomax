-- Rollback de 0022_animales_foundation.sql.
--
-- DESTRUCTIVO: elimina las 4 tablas del dominio Animal y sus datos. Solo
-- válido mientras no existan datos reales de clientes (p.ej. si el
-- despliegue se revierte antes de abrir el registro de animales). Revertir
-- primero el código que las usa.
--
-- Orden inverso de dependencias: eventos/pesajes -> animales -> catálogo.
drop table if exists agx.animal_eventos;
drop table if exists agx.animal_pesajes;
drop table if exists agx.animales;
drop table if exists agx.catalogo_razas;
