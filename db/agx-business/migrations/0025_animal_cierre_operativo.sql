-- FASE 2A -- CIERRE OPERATIVO DEL ANIMAL: SALIDA y MUERTE.
--
-- Dos ejes INDEPENDIENTES en agx.animales:
--   estado            ACTIVO | ANULADO   (0022, sin cambios) -- validez del
--                     REGISTRO. ANULADO = corrección administrativa: el
--                     registro era erróneo. NUNCA significa salida ni muerte.
--   estado_operativo  EN_HATO | SALIDO | MUERTO (nuevo) -- situación REAL del
--                     animal. SALIDO = dejó el hato de la organización por una
--                     causa operativa; MUERTO = falleció.
--
-- Un solo cierre por animal (SALIDO y MUERTO son excluyentes y terminales en
-- esta fase: sin reapertura ni SALIDO -> MUERTO). Por eso el cierre vive en
-- columnas cierre_* del propio animal (sin tabla de cierres: sería 1:1) y la
-- auditoría en agx.animal_eventos (SALIDO / MUERTO), igual que ANULADO.
--
-- Catálogos (semántica):
--   SALIDA: VENTA, TRASLADO (a un destino EXTERNO a la organización; los
--           movimientos entre predios propios NO son salida), DONACION,
--           INTERCAMBIO, DEVOLUCION, OTRA.
--   MUERTE: MUERTE_NATURAL, ENFERMEDAD, ACCIDENTE, SACRIFICIO (el animal
--           falleció: es una muerte, no una salida), DEPREDACION,
--           DESCONOCIDA, OTRA.
--
-- cierre_fecha es la fecha EFECTIVA de negocio (date, calendario
-- America/Bogota); cierre_at es el instante técnico del registro. Nunca se
-- convierte una en la otra.
--
-- Idempotencia: cierre_client_operation_id (UNIQUE parcial por organización,
-- mismo patrón que animal_pesajes 0024 / predios 0021).
--
-- Inmutabilidad: trigger agx.fn_animales_cierre_guard -- solo EN_HATO ->
-- SALIDO|MUERTO; una vez cerrado, estado_operativo y cierre_* no cambian
-- (anular sigue permitido: es otro eje).
--
-- Aditiva y compatible con el código anterior: estado_operativo NOT NULL
-- DEFAULT 'EN_HATO' (constante: sin reescritura de tabla en PG >= 11); el
-- código previo no lee ni escribe las columnas nuevas.
--
-- Secuencia de despliegue: aplicar ESTA migración ANTES del merge del código
-- que la usa (Railway despliega main automáticamente).
--   psql -1 -v ON_ERROR_STOP=1 -f 0025_animal_cierre_operativo.sql
-- Nunca ejecutar contra Railway sin autorización explícita separada.

alter table agx.animales
  add column estado_operativo varchar(12) not null default 'EN_HATO',
  add column cierre_fecha date,
  add column cierre_causa varchar(20),
  add column cierre_observaciones text,
  add column cierre_at timestamptz,
  add column cierre_por uuid,
  add column cierre_client_operation_id uuid;

alter table agx.animales
  add constraint animales_estado_operativo_check
    check (estado_operativo in ('EN_HATO', 'SALIDO', 'MUERTO')),
  add constraint animales_cierre_consistency_check
    check (
      (estado_operativo = 'EN_HATO'
        and cierre_fecha is null and cierre_causa is null and cierre_observaciones is null
        and cierre_at is null and cierre_por is null and cierre_client_operation_id is null)
      or (estado_operativo = 'SALIDO'
        and cierre_fecha is not null and cierre_at is not null and cierre_por is not null
        and cierre_client_operation_id is not null
        and cierre_causa in ('VENTA', 'TRASLADO', 'DONACION', 'INTERCAMBIO', 'DEVOLUCION', 'OTRA'))
      or (estado_operativo = 'MUERTO'
        and cierre_fecha is not null and cierre_at is not null and cierre_por is not null
        and cierre_client_operation_id is not null
        and cierre_causa in ('MUERTE_NATURAL', 'ENFERMEDAD', 'ACCIDENTE', 'SACRIFICIO', 'DEPREDACION', 'DESCONOCIDA', 'OTRA'))
    ),
  add constraint animales_cierre_fecha_min_check
    check (cierre_fecha is null or cierre_fecha >= date '1990-01-01'),
  add constraint animales_cierre_fecha_orden_check
    check (cierre_fecha is null
      or ((fecha_nacimiento is null or cierre_fecha >= fecha_nacimiento)
        and (fecha_ingreso is null or cierre_fecha >= fecha_ingreso))),
  add constraint animales_cierre_observaciones_check
    check (cierre_observaciones is null
      or (btrim(cierre_observaciones) <> '' and char_length(cierre_observaciones) <= 500));

comment on column agx.animales.estado_operativo is
  'FASE 2A: situación real del animal (EN_HATO | SALIDO | MUERTO). Independiente de estado (validez del registro: ACTIVO | ANULADO). Terminal una vez cerrado (trigger animales_cierre_guard).';
comment on column agx.animales.cierre_fecha is
  'Fecha EFECTIVA (calendario de negocio, America/Bogota) de la salida o la muerte. No es un instante: cierre_at es el registro técnico.';
comment on column agx.animales.cierre_causa is
  'Motivo de salida (VENTA, TRASLADO, DONACION, INTERCAMBIO, DEVOLUCION, OTRA) o causa de muerte (MUERTE_NATURAL, ENFERMEDAD, ACCIDENTE, SACRIFICIO, DEPREDACION, DESCONOCIDA, OTRA) según estado_operativo.';
comment on column agx.animales.cierre_client_operation_id is
  'UUID de la intención de cierre (idempotencia de reintentos). Nunca se expone al usuario.';

create unique index animales_org_cierre_client_operation_key
  on agx.animales (organizacion_id, cierre_client_operation_id)
  where cierre_client_operation_id is not null;

-- Cierre terminal e inmutable, también para conexiones distintas de la app.
create or replace function agx.fn_animales_cierre_guard() returns trigger
  language plpgsql
  as $$
begin
  if new.estado_operativo is distinct from old.estado_operativo then
    if not (old.estado_operativo = 'EN_HATO' and new.estado_operativo in ('SALIDO', 'MUERTO')) then
      raise exception 'animales: transición operativa % -> % no permitida', old.estado_operativo, new.estado_operativo
        using errcode = 'check_violation';
    end if;
  elsif old.estado_operativo <> 'EN_HATO'
    and row(new.cierre_fecha, new.cierre_causa, new.cierre_observaciones, new.cierre_at, new.cierre_por,
            new.cierre_client_operation_id)
        is distinct from
        row(old.cierre_fecha, old.cierre_causa, old.cierre_observaciones, old.cierre_at, old.cierre_por,
            old.cierre_client_operation_id) then
    raise exception 'animales: el cierre operativo es inmutable'
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;
alter function agx.fn_animales_cierre_guard() owner to agx_owner;

create trigger animales_cierre_guard
  before update on agx.animales
  for each row execute function agx.fn_animales_cierre_guard();

-- agx_app escribe el cierre (grant por columna, mismo criterio que 0022).
grant update (
  estado_operativo, cierre_fecha, cierre_causa, cierre_observaciones,
  cierre_at, cierre_por, cierre_client_operation_id
) on agx.animales to agx_app;

-- Auditoría: eventos SALIDO / MUERTO (como mucho UNO de los dos por animal).
alter table agx.animal_eventos drop constraint animal_eventos_tipo_check;
alter table agx.animal_eventos add constraint animal_eventos_tipo_check
  check (tipo_evento in (
    'REGISTRADO', 'DATOS_CORREGIDOS', 'ANULADO',
    'QR_ASOCIADO', 'QR_REVOCADO', 'QR_REEMPLAZADO',
    'SALIDO', 'MUERTO'
  ));

create unique index animal_eventos_un_cierre_idx
  on agx.animal_eventos (animal_id) where tipo_evento in ('SALIDO', 'MUERTO');
