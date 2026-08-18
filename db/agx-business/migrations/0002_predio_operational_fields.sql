-- SPRINT-3C2.5 §7/§13/§14: campos operativos del cliente sobre
-- agx.predios -- aditiva pura, NO modifica 0001 ya aplicado, NO toca
-- agx.predio_snapshots_catastrales (permanece inmutable/append-only).
--
-- §14: se decide NO renombrar físicamente `area_total_ha` -- ya era, por
-- diseño original (0001, comentario "dato operativo mutable"), el valor
-- que el CLIENTE declara/edita, nunca el área catastral oficial (esa vive
-- exclusivamente en predio_snapshots_catastrales.area_ha). La API la
-- expone como `areaDeclaradaHa`, nunca como `areaCatastralHa` -- este
-- comentario de columna deja esa semántica explícita en el propio
-- catálogo, para que no se reinterprete por error en el futuro.
comment on column agx.predios.area_total_ha is
  'Área DECLARADA por el cliente (operativa, editable) -- NUNCA el área catastral oficial. El área catastral oficial vive en agx.predio_snapshots_catastrales.area_ha (inmutable). La API expone esta columna como areaDeclaradaHa, nunca como areaCatastralHa.';

-- Único campo realmente nuevo: notas libres del cliente sobre su predio.
-- Nunca se deriva de CatastroX -- exclusivamente lo que el cliente
-- escriba al confirmar (modo catastrox) o al registrar manualmente.
alter table agx.predios add column if not exists observaciones text;

comment on column agx.predios.observaciones is
  'Notas libres del cliente sobre el predio -- nunca proviene de CatastroX, siempre opcional.';
