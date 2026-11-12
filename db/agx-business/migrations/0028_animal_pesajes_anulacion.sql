-- FASE 5A.1a -- anulación auditada de pesajes (agx.animal_pesajes).
-- Solo estructura: ningún código la usa hasta 5A.1b (backend). Aplicar en
-- producción únicamente desde main, con backup previo y autorización
-- explícita (bundle --version 28 del runner).
--
-- agx.animal_pesajes sigue siendo la ÚNICA fuente de verdad del historial de
-- peso. Un pesaje erróneo NUNCA se borra: se ANULA (quién, cuándo, por qué,
-- con qué operación) y, si hace falta, se registra uno nuevo. Los cálculos
-- productivos (último peso, GMD, ganancia acumulada, tendencia, alertas,
-- PDF) usan solo filas ACTIVO; el historial muestra ACTIVO y ANULADO.
-- No hay CORREGIR en 5A (anular + registrar nuevo).
--
-- Mismo patrón y mismos nombres que agx.reproduccion_eventos (0026):
--   estado_registro ACTIVO | ANULADO, anulado_por, anulado_at,
--   motivo_anulacion, anulacion_client_operation_id.
--
-- Actor: anulado_por es el uuid de la cuenta de la SESIÓN (Postgres-AGX,
-- otra base): sin FK, igual que actor_cuenta_id (0022) y
-- reproduccion_eventos.anulado_por (0026). Nunca viene del cliente.
--
-- Idempotencia: anulacion_client_operation_id UNIQUE parcial por
-- organización. La exclusividad entre client_operation_id (registro) y
-- anulacion_client_operation_id (anulación) la impone la aplicación bajo el
-- MISMO advisory lock por organización + operación (patrón 4E.2A).
--
-- Inmutabilidad, también para conexiones distintas de la app
-- (agx.fn_animal_pesajes_guard): todo pesaje nace ACTIVO; la única
-- transición es ACTIVO -> ANULADO; ANULADO es terminal; el contenido del
-- pesaje no cambia nunca; ningún DELETE físico. agx_app recibe UPDATE SOLO
-- de las columnas de anulación; sigue sin DELETE.
--
-- Aditiva y compatible con el código anterior: las filas existentes quedan
-- ACTIVO (DEFAULT constante, sin reescritura de tabla en PG 16); el código
-- actual no lee ni escribe las columnas nuevas y su INSERT sigue siendo
-- válido. Sin cambios de RLS/FORCE ni de la política tenant (FOR ALL cubre
-- UPDATE; WITH CHECK impide mover la fila de organización). Sin índices de
-- lectura nuevos: animal_pesajes_animal_fecha_idx sigue sirviendo historial
-- y último peso ACTIVO (pocas filas por animal).
--
-- FORWARD-ONLY EN PRODUCCIÓN. Una vez aplicada 0028 sobre producción con
-- datos, las correcciones se realizan mediante una migración posterior.
-- estado_registro es NOT NULL, así que la precondición del runner (columnas
-- a borrar en NULL) bloquea el rollback en cualquier base con pesajes, y el
-- propio _rollback aborta si la tabla tiene filas: solo sirve en bases
-- vacías o desechables.
--
-- TRUNCATE: agx_app no tiene el privilegio (0022) y 0028 no lo concede.
--
-- Secuencia: este archivo se mergea a main ANTES de aplicarse; luego backup
-- y bundle --version 28 por el runner. El backend que la usa (5A.1b) se
-- mergea solo después de aplicada.

alter table agx.animal_pesajes
  add column estado_registro varchar(10) not null default 'ACTIVO',
  add column anulado_por uuid,
  add column anulado_at timestamptz,
  add column motivo_anulacion text,
  add column anulacion_client_operation_id uuid;

alter table agx.animal_pesajes
  add constraint animal_pesajes_estado_registro_check
    check (estado_registro in ('ACTIVO', 'ANULADO')),
  add constraint animal_pesajes_anulacion_consistency_check
    check (
      (estado_registro = 'ACTIVO'
        and anulado_por is null and anulado_at is null and motivo_anulacion is null
        and anulacion_client_operation_id is null)
      or (estado_registro = 'ANULADO'
        and anulado_por is not null and anulado_at is not null
        and anulacion_client_operation_id is not null
        and motivo_anulacion is not null and btrim(motivo_anulacion) <> ''
        and char_length(motivo_anulacion) <= 500)
    );

create unique index animal_pesajes_org_anulacion_client_operation_key
  on agx.animal_pesajes (organizacion_id, anulacion_client_operation_id)
  where anulacion_client_operation_id is not null;

create function agx.fn_animal_pesajes_guard() returns trigger
  language plpgsql
  as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'animal_pesajes: el historial de pesajes no admite DELETE'
      using errcode = 'check_violation';
  end if;
  if tg_op = 'INSERT' then
    if new.estado_registro <> 'ACTIVO' then
      raise exception 'animal_pesajes: un pesaje se registra ACTIVO'
        using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if old.estado_registro = 'ANULADO' then
    raise exception 'animal_pesajes: un pesaje ANULADO es inmutable'
      using errcode = 'check_violation';
  end if;
  if new.estado_registro <> 'ANULADO' then
    raise exception 'animal_pesajes: solo se admite la transición ACTIVO -> ANULADO'
      using errcode = 'check_violation';
  end if;
  if row(new.pesaje_id, new.organizacion_id, new.animal_id, new.fecha, new.peso_kg, new.metodo,
         new.origen, new.actor_cuenta_id, new.created_at, new.client_operation_id, new.observaciones)
     is distinct from
     row(old.pesaje_id, old.organizacion_id, old.animal_id, old.fecha, old.peso_kg, old.metodo,
         old.origen, old.actor_cuenta_id, old.created_at, old.client_operation_id, old.observaciones) then
    raise exception 'animal_pesajes: el contenido del pesaje es inmutable (anular + registrar uno nuevo)'
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;

alter function agx.fn_animal_pesajes_guard() owner to agx_owner;

create trigger animal_pesajes_guard
  before insert or update or delete on agx.animal_pesajes
  for each row execute function agx.fn_animal_pesajes_guard();

grant update (estado_registro, anulado_por, anulado_at, motivo_anulacion, anulacion_client_operation_id)
  on agx.animal_pesajes to agx_app;

comment on table agx.animal_pesajes is
  'Pesajes del animal (0022, FASE 1A 0024, FASE 5A 0028) -- fuente de verdad del historial de peso. agx_app: SELECT/INSERT + UPDATE solo de columnas de anulación (ACTIVO -> ANULADO, trigger animal_pesajes_guard); nunca DELETE. Cálculos productivos solo con ACTIVO. origen REGISTRO_INICIAL (máximo uno por animal, NO es peso al nacimiento) o MANUAL (N por animal, idempotente por client_operation_id).';
comment on column agx.animal_pesajes.estado_registro is
  'ACTIVO (cuenta en cálculos) o ANULADO (solo historial). Única transición ACTIVO -> ANULADO.';
comment on column agx.animal_pesajes.anulado_por is
  'Cuenta (Postgres-AGX, sin FK) de la sesión que anuló el pesaje. Nunca viene del cliente.';
comment on column agx.animal_pesajes.anulado_at is
  'Instante técnico de la anulación.';
comment on column agx.animal_pesajes.motivo_anulacion is
  'Motivo de la anulación (obligatorio, máximo 500 caracteres).';
comment on column agx.animal_pesajes.anulacion_client_operation_id is
  'UUID de la intención de anulación. Idempotencia por organización; nunca coincide con un client_operation_id de registro (lo impone la aplicación bajo el mismo advisory lock). Nunca se expone al usuario.';
