-- FASE 1A -- pesajes posteriores (MANUAL) sobre agx.animal_pesajes.
--
-- agx.animal_pesajes (0022) sigue siendo la ÚNICA fuente de verdad del
-- historial de peso: no se crea otra tabla, no se guarda peso actual, GMD,
-- diferencias ni ganancias en agx.animales (todo se deriva al leer).
--
-- Aditiva pura y compatible con el código anterior:
-- - origen admite 'REGISTRO_INICIAL' (alta del animal) y 'MANUAL' (pesajes
--   posteriores). OFFLINE NO es un origen: es un mecanismo de transporte.
--   Se mantiene animal_pesajes_un_registro_inicial_idx (máximo un
--   REGISTRO_INICIAL por animal); MANUAL admite N por animal y varios el
--   mismo día.
-- - client_operation_id uuid NULL-able, sin DEFAULT ni backfill: las filas
--   REGISTRO_INICIAL (la idempotencia del alta vive en agx.animales) quedan
--   NULL. OBLIGATORIO para MANUAL (CHECK). Índice UNIQUE parcial
--   tenant-scoped, mismo patrón que predios (0021): una operación del
--   cliente crea a lo sumo UN pesaje por organización.
-- - observaciones text NULL-able, máximo 500 caracteres, nunca vacía.
-- - Sin cambios de RLS/FORCE, políticas ni grants: agx_app conserva solo
--   SELECT/INSERT (append-only: sin UPDATE ni DELETE); los grants de tabla
--   cubren las columnas nuevas.
-- - Índices: animal_pesajes_animal_fecha_idx (animal_id, fecha desc,
--   pesaje_id desc) ya sirve historial, último peso y resumen (animal_id es
--   único en todo el sistema y RLS añade organizacion_id); no se añaden
--   índices redundantes.
--
-- Secuencia de despliegue: aplicar ESTA migración ANTES del merge del código
-- que inserta MANUAL (Railway despliega main automáticamente). El código
-- anterior sigue funcionando con la tabla ampliada.

alter table agx.animal_pesajes
  drop constraint animal_pesajes_origen_check;

alter table agx.animal_pesajes
  add constraint animal_pesajes_origen_check
    check (origen in ('REGISTRO_INICIAL', 'MANUAL'));

alter table agx.animal_pesajes
  add column if not exists client_operation_id uuid,
  add column if not exists observaciones text;

alter table agx.animal_pesajes
  add constraint animal_pesajes_manual_client_operation_check
    check (origen <> 'MANUAL' or client_operation_id is not null);

alter table agx.animal_pesajes
  add constraint animal_pesajes_observaciones_check
    check (observaciones is null or (btrim(observaciones) <> '' and char_length(observaciones) <= 500));

comment on column agx.animal_pesajes.client_operation_id is
  'UUID de la intención de registro MANUAL (FASE 1A). Idempotencia de reintentos (incluidos futuros reintentos offline). NULL = REGISTRO_INICIAL (su idempotencia vive en agx.animales). Nunca se expone al usuario.';
comment on column agx.animal_pesajes.observaciones is
  'Nota libre del pesaje (máximo 500 caracteres). Inmutable (append-only).';

create unique index if not exists animal_pesajes_org_client_operation_key
  on agx.animal_pesajes (organizacion_id, client_operation_id)
  where client_operation_id is not null;

comment on table agx.animal_pesajes is
  'Pesajes del animal (0022, FASE 1A 0024) -- fuente de verdad del historial de peso; append-only para agx_app (SELECT/INSERT). origen REGISTRO_INICIAL (máximo uno por animal, NO es peso al nacimiento) o MANUAL (N por animal, idempotente por client_operation_id). metodo distingue báscula de estimación.';
