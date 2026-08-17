-- FIX/GANADERIA-SPRINT-1A-ORG-MEMBRESIA-AUTH
--
-- Objetivo: habilitar en Postgres-AGX (producción, plano de identidad y
-- autorización -- ADR-002/ADR-007/ADR-009) la capa mínima
-- CUENTA -> MEMBRESÍA -> ORGANIZACIÓN -> SESIÓN AUTORIZADA descrita en
-- ADR-008. NO migra ninguna tabla de negocio ganadero (predios, potreros,
-- animales, pesajes, vacunaciones, tratamientos, reproduccion, qr_codes),
-- ningún plan/suscripción, ningún lote QR. Esas 34+ tablas existen hoy en
-- Postgres-3myV (staging) con `organizacion_id` directo y RLS -- fuera de
-- alcance de este archivo, documentadas únicamente en el informe de
-- Sprint 1A.
--
-- Extraído de Postgres-3myV (staging, PostgreSQL 18.4), diseño ya validado
-- en ACCESO-001 y referenciado explícitamente por
-- server/security/ganaderiaSession.js (resolveTenantAuthorization,
-- listOrganizacionesDisponibles, isMembresiaActivaParaOrganizacion,
-- resolveInternalRole) y server/routes/ganaderiaAuth.js (GET /session,
-- POST /organizacion) -- código ya desplegado en producción que hoy falla
-- (relation does not exist) en cuanto exista la primera cuenta cliente no
---staff, porque agx.organizaciones/agx.membresias todavía no existen.
--
-- No incluye: agx.qr_codes, rol agx_app/agx_internal/agx_qr_public(_definer),
-- las tablas de negocio, RLS (ADR-008 §13-14 la reserva exclusivamente a
-- las tablas de negocio con organizacion_id directo -- confirmado por
-- auditoría: agx.organizaciones/membresias/sesiones/cuentas NO tienen RLS
-- en staging), planes/suscripciones, datos semilla, cuentas u
-- organizaciones reales.
--
-- Aditiva pura: ningún DROP, ningún ALTER destructivo, ninguna fila
-- existente de agx.cuentas/agx.sesiones/agx.staff_crh se modifica. Debe
-- ejecutarse con un rol administrador (agx_owner o equivalente), nunca con
-- agx_auth (ADR-008 §14: el rol de aplicación nunca es el rol de
-- migraciones). Idempotente: puede re-ejecutarse sin error ni duplicar
-- objetos.

-- ---------------------------------------------------------------------
-- 1. agx.organizaciones
-- ---------------------------------------------------------------------

create table if not exists agx.organizaciones (
  organizacion_id      uuid primary key default gen_random_uuid(),
  nombre               text not null,
  identificador_fiscal text,
  estado               text not null default 'activa'
                          check (estado in ('activa', 'suspendida')),
  fecha_creacion       timestamptz not null default now(),
  fecha_actualizacion  timestamptz not null default now()
);

alter table agx.organizaciones owner to agx_owner;

-- ---------------------------------------------------------------------
-- 2. agx.membresias
--
-- Restricción de unicidad tal como está probada en staging: UNIQUE simple
-- sobre (cuenta_id, organizacion_id), SIN filtrar por estado. Nota de
-- diseño (ver informe Sprint 1A, sección N -- riesgo MEDIO): esto es más
-- estricto que la intención conceptual de ADR-008 §10 ("una membresía
-- revocada no cuenta como vigente, permite crear una nueva para el mismo
-- par") -- en el diseño real ya validado, revocar y volver a dar acceso al
-- mismo par (cuenta, organización) requiere reactivar la fila existente
-- (UPDATE estado), no insertar una segunda fila. Se replica el diseño
-- REAL y probado, no una versión corregida no probada -- consistente con
-- la instrucción de extraer de staging únicamente lo ya probado.
-- ---------------------------------------------------------------------

create table if not exists agx.membresias (
  membresia_id         uuid primary key default gen_random_uuid(),
  cuenta_id            uuid not null references agx.cuentas (cuenta_id),
  organizacion_id      uuid not null references agx.organizaciones (organizacion_id),
  rol                  text not null
                          check (rol in ('owner', 'admin', 'operador', 'lector')),
  estado               text not null default 'activa'
                          check (estado in ('activa', 'revocada')),
  fecha_creacion       timestamptz not null default now(),
  fecha_actualizacion  timestamptz not null default now(),
  constraint membresias_cuenta_organizacion_key unique (cuenta_id, organizacion_id)
);

alter table agx.membresias owner to agx_owner;

create index if not exists idx_membresias_cuenta_activa
  on agx.membresias using btree (cuenta_id)
  where (estado = 'activa');

create index if not exists idx_membresias_organizacion_activa
  on agx.membresias using btree (organizacion_id)
  where (estado = 'activa');

-- ---------------------------------------------------------------------
-- 3. agx.sesiones -- ajustes aditivos
--
-- La columna sesiones.organizacion_id (uuid, nullable) YA EXISTE en
-- producción desde AGX-SUPERADMIN-AUTH-005 (Arquitectura B: identidad !=
-- tenant resuelto; createSession() siempre la inserta NULL). Lo que falta
-- es exclusivamente: (a) la FK hacia agx.organizaciones, ahora que la
-- tabla existe; (b) la FK compuesta hacia agx.membresias, que impide a
-- nivel de base de datos fijar una organización de sesión sin una
-- membresía real para ese mismo par (cuenta, organización); (c) el índice
-- parcial simétrico al ya existente idx_sesiones_cuenta_activa.
-- ---------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'agx.sesiones'::regclass
       and conname = 'sesiones_organizacion_id_fkey'
  ) then
    alter table agx.sesiones
      add constraint sesiones_organizacion_id_fkey
      foreign key (organizacion_id) references agx.organizaciones (organizacion_id);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'agx.sesiones'::regclass
       and conname = 'sesiones_organizacion_requiere_membresia'
  ) then
    alter table agx.sesiones
      add constraint sesiones_organizacion_requiere_membresia
      foreign key (cuenta_id, organizacion_id) references agx.membresias (cuenta_id, organizacion_id);
  end if;
end $$;

create index if not exists idx_sesiones_organizacion_activa
  on agx.sesiones using btree (organizacion_id)
  where (fecha_revocacion is null);

-- ---------------------------------------------------------------------
-- 4. Funciones
--
-- Únicamente las 4 estrictamente necesarias para que el código YA
-- desplegado de server/security/ganaderiaSession.js funcione: 3 son
-- invocadas directa o indirectamente por rutas reales
-- (resolveTenantAuthorization -> fn_resolver_autorizacion_sesion) o
-- forman parte indivisible del mismo mecanismo de revocación (Modelo 1,
-- comentado explícitamente en ese archivo) que involucra a
-- organizaciones/membresias. fn_revocar_sesiones_por_cuenta_inactiva
-- (trigger sobre agx.cuentas, sin dependencia de organizaciones ni
-- membresias) se documenta como NO incluida -- ver informe, sección F.
-- ---------------------------------------------------------------------

create or replace function agx.fn_resolver_autorizacion_sesion(p_token_hash text)
returns table(sesion_id uuid, cuenta_id uuid, organizacion_id uuid, rol text)
language sql
stable
set search_path to 'pg_catalog', 'agx'
as $function$
  select s.sesion_id, s.cuenta_id, s.organizacion_id, m.rol
  from agx.sesiones s
  join agx.cuentas c
    on c.cuenta_id = s.cuenta_id
   and c.estado = 'activa'
  join agx.membresias m
    on m.cuenta_id = s.cuenta_id
   and m.organizacion_id = s.organizacion_id
   and m.estado = 'activa'
  join agx.organizaciones o
    on o.organizacion_id = s.organizacion_id
   and o.estado = 'activa'
  where s.token_hash = p_token_hash
    and s.fecha_revocacion is null
    and s.fecha_expiracion > now();
$function$;

alter function agx.fn_resolver_autorizacion_sesion(text) owner to agx_owner;

create or replace function agx.fn_revocar_sesiones_por_membresia()
returns trigger
language plpgsql
set search_path to 'pg_catalog', 'agx'
as $function$
begin
  if new.estado = 'revocada' and old.estado is distinct from 'revocada' then
    update agx.sesiones
       set fecha_revocacion = now()
     where cuenta_id = new.cuenta_id
       and organizacion_id = new.organizacion_id
       and fecha_revocacion is null;
  end if;
  return new;
end;
$function$;

alter function agx.fn_revocar_sesiones_por_membresia() owner to agx_owner;

create or replace function agx.fn_revocar_sesiones_por_organizacion_suspendida()
returns trigger
language plpgsql
set search_path to 'pg_catalog', 'agx'
as $function$
begin
  if new.estado = 'suspendida' and old.estado is distinct from 'suspendida' then
    update agx.sesiones
       set fecha_revocacion = now()
     where organizacion_id = new.organizacion_id
       and fecha_revocacion is null;
  end if;
  return new;
end;
$function$;

alter function agx.fn_revocar_sesiones_por_organizacion_suspendida() owner to agx_owner;

-- DESVIACIÓN DELIBERADA respecto de staging, encontrada por prueba
-- funcional en PostgreSQL 18 desechable (ver informe Sprint 1A, sección
-- K): la versión de staging valida la membresía en TODO UPDATE de
-- agx.sesiones con organizacion_id no nulo, sin comprobar si esa columna
-- realmente cambió. Esto crea un interbloqueo lógico real con
-- fn_revocar_sesiones_por_membresia: al revocar una membresía, ese
-- trigger intenta UPDATE agx.sesiones SET fecha_revocacion = now() (sin
-- tocar organizacion_id) -- pero como la membresía ya quedó 'revocada' en
-- la misma transacción, la revalidación de este trigger la rechaza con
-- 23514, BLOQUEANDO la propia revocación que Modelo 1 requiere. Se agrega
-- el guard "solo revalidar si organizacion_id realmente cambió" -- mismo
-- patrón ya usado en staging por fn_animales_qr_id_inmutable
-- ("if old.qr_id is null or new.qr_id is not distinct from old.qr_id then
-- return new"), aplicado aquí donde staging no lo tenía. Verificado con
-- prueba funcional: revocar membresía SÍ revoca la sesión tras este
-- ajuste (ver E.D de tests). Reportado como hallazgo -- staging conserva
-- el bug original, no se modifica staging en este sprint.
create or replace function agx.fn_sesiones_valida_membresia_activa()
returns trigger
language plpgsql
set search_path to 'pg_catalog', 'agx'
as $function$
begin
  if new.organizacion_id is null then
    return new;
  end if;

  if TG_OP = 'UPDATE' and new.organizacion_id is not distinct from old.organizacion_id then
    return new;
  end if;

  if not exists (
    select 1 from agx.membresias m
    where m.cuenta_id = new.cuenta_id
      and m.organizacion_id = new.organizacion_id
      and m.estado = 'activa'
  ) then
    raise exception
      'La cuenta % no tiene una membresía ACTIVA en la organización % -- no se puede fijar como organización de sesión.',
      new.cuenta_id, new.organizacion_id
      using errcode = '23514';
  end if;

  return new;
end;
$function$;

alter function agx.fn_sesiones_valida_membresia_activa() owner to agx_owner;

-- ---------------------------------------------------------------------
-- 5. Triggers
-- ---------------------------------------------------------------------

drop trigger if exists trg_membresias_revoca_sesiones on agx.membresias;
create trigger trg_membresias_revoca_sesiones
  after update on agx.membresias
  for each row
  execute function agx.fn_revocar_sesiones_por_membresia();

drop trigger if exists trg_organizaciones_revoca_sesiones on agx.organizaciones;
create trigger trg_organizaciones_revoca_sesiones
  after update on agx.organizaciones
  for each row
  execute function agx.fn_revocar_sesiones_por_organizacion_suspendida();

drop trigger if exists trg_sesiones_valida_membresia_activa on agx.sesiones;
create trigger trg_sesiones_valida_membresia_activa
  before insert or update on agx.sesiones
  for each row
  execute function agx.fn_sesiones_valida_membresia_activa();

-- ---------------------------------------------------------------------
-- 6. Grants -- mínimos, NO calcados de staging
--
-- Staging otorga a agx_auth también INSERT/UPDATE sobre agx.membresias;
-- se audita y confirma que NINGÚN código hoy desplegado escribe
-- agx.organizaciones ni agx.membresias (server/security/ganaderiaSession.js
-- solo las consulta) -- ese grant adicional de staging NO se copia aquí
-- (ver informe, sección G, hallazgo de grant excesivo). Si un sprint
-- posterior añade un flujo de escritura real (alta de organización,
-- aceptación de invitación), ese sprint debe ampliar el grant
-- explícitamente, con su propia auditoría.
-- ---------------------------------------------------------------------

grant select on agx.organizaciones to agx_auth;
grant select on agx.membresias to agx_auth;
grant execute on function agx.fn_resolver_autorizacion_sesion(text) to agx_auth;
