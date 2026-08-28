-- Rollback de 0015_potrero_ciclo_lote_real_versiones.sql.
--
-- Requiere que 0016 (si se aplicó) ya haya sido revertida antes -- esa
-- migración agrega una FK desde agx.potrero_recomendaciones_descanso
-- hacia agx.potrero_ciclo_lote_real_versiones, que bloquearía este DROP.

drop table if exists agx.potrero_ciclo_lote_real_invalidaciones;
drop table if exists agx.potrero_ciclo_lote_real_versiones;
