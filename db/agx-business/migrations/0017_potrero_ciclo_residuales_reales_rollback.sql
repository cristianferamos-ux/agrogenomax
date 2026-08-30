-- Rollback de 0017_potrero_ciclo_residuales_reales.sql.
--
-- Requiere que 0018 (si se aplicó) ya haya sido revertida antes -- esa
-- migración agrega una FK desde agx.potrero_recomendaciones_descanso hacia
-- agx.potrero_ciclo_residuales_reales_versiones, que bloquearía este DROP.

drop table if exists agx.potrero_ciclo_residual_real_invalidaciones;
drop table if exists agx.potrero_ciclo_residuales_reales_versiones;
