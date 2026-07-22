# ADR-002: El dominio `agx` es la fuente canónica de Ganadería; `public`/Supabase queda legacy, retiro condicionado a validación

- Estado: Aceptada
- Fecha: 2026-07-17
- Responsables: Equipo técnico AgroGenomaX / CRH Soluciones Integrales S.A.S.

## Contexto

### Precedencia y alcance vigente

ADR-008 precisa y reemplaza la parte de ADR-002 relacionada con el modelo de datos monocliente: antes de producción, Ganadería debe incorporar organizaciones, membresías, `organizacion_id` directo en las tablas organizacionales, autorización centralizada y Row Level Security.

ADR-014 precisa y reemplaza la parte de ADR-002 relacionada con seeds y separación de ambientes: la demo no usa backend ni base de datos, staging usa datos sintéticos o previamente anonimizados, y producción no recibe datos demo.

Los archivos `server/sql/001_agx_core_schema.sql`, `server/sql/002_agx_seed_demo.sql` y `server/sql/003_agx_seed_demo_optional.sql` quedan clasificados como inventario histórico/propuesta del contrato monocliente actual. No son DDL definitivo ni base autorizada para crear RDS.

La vigencia restante de ADR-002 se limita a la elección del dominio/esquema lógico `agx`, consumido por `server/db.js` y `server/routes/*.js`, frente a `public`/Supabase como dominio canónico del backend de Ganadería, y a las condiciones de retiro seguro de Supabase.

La auditoría técnica confirmó la existencia de **dos esquemas de base de datos paralelos e incompatibles** para el dominio de Ganadería: `supabase/migrations/001_agrogenomax_core.sql` (esquema `public`, en inglés, PK `uuid`, 22 tablas, Row Level Security multi-tenant dependiente de `auth.uid()`/`auth.users`, y buckets de Supabase Storage) y `server/sql/001_agx_core_schema.sql` (esquema `agx`, en español, PK `bigserial`, 10 tablas, sin RLS ni concepto de organización). El propio archivo `server/sql/001_agx_core_schema.sql:1-13` se autodeclara como el esquema real derivado del contrato que usa el código (`server/db.js`, `server/routes/*.js`), y `server/db.js:9` confirma `PGSCHEMA || 'agx'` como default. Solo coincide el nombre de una tabla entre ambos esquemas (`qr_codes`), con columnas totalmente distintas — no es la misma tabla, es una colisión de nombre.

## Problema

Una migración a RDS no puede arrastrar dos fuentes de verdad simultáneas. Es necesario declarar formalmente cuál esquema es el oficial antes de definir el proceso de migración de Ganadería, sin arriesgar pérdida de datos en el esquema que se retira.

## Opciones consideradas

- **Adoptar `public`/Supabase como fuente de verdad**: descartada — requeriría reimplementar `auth.uid()`, Supabase Auth y Supabase Storage desde cero en el backend Express, que hoy no los usa en absoluto (confirmado: el backend se conecta directo a PostgreSQL vía `pg`, nunca pasa por la capa de Supabase).
- **Consolidar ambos esquemas en uno nuevo**: descartada por ahora — no hay evidencia de que `public` contenga datos reales de producción que deban preservarse; consolidar añadiría trabajo no justificado sin haber verificado primero si hay algo que preservar.
- **Adoptar el dominio lógico `agx` como fuente canónica** (elegida): es el dominio que el backend consume actualmente. Su adopción como dominio canónico no implica aprobar el DDL monocliente actual ni evita los cambios de esquema, autorización, consultas y RLS exigidos por ADR-008 y ADR-014.
- **Mantener ambos indefinidamente**: descartada — es la causa raíz del riesgo identificado, no una solución.

## Decisión

El dominio/esquema lógico **`agx`**, consumido por `server/db.js` y `server/routes/*.js`, es la **fuente canónica** para el backend de Ganadería frente a `public`/Supabase. Su DDL definitivo debe alinearse con ADR-008 y ADR-014 antes de usarse para crear ambientes RDS. El esquema **`public`/Supabase** (`supabase/migrations/001_agrogenomax_core.sql`) se clasifica como **legacy, pendiente de retiro** — pero **no se elimina ni desactiva hasta completar una validación formal previa** (ver Acciones requeridas y Criterios de aceptación).

## Justificación

- `agx` es el único esquema efectivamente consultado por el backend real (`server/routes/*.js` vía `server/db.js`), verificado directamente en el código, no por inferencia documental.
- `src/lib/supabaseClient.js` (capa de acceso a `public`) solo es importado por `src/components/LivestockPlatform.jsx` y su copia `.backup.jsx`, ninguno de los cuales está enrutado en `src/App.jsx` — es decir, hoy es código huérfano sin tráfico real, pero eso no descarta que existan datos, configuración de Auth o archivos en Storage que aún no se hayan verificado directamente en el proyecto Supabase real.
- Adoptar `agx` como dominio canónico formaliza qué modelo consume actualmente el backend; convertirlo en el modelo definitivo multicliente sí requiere cambios de esquema, middleware, consultas, transacciones y RLS conforme a ADR-008 y ADR-014.
- Retirar Supabase sin antes inventariar y respaldar su contenido sería irreversible e injustificado dado que la auditoría no tuvo acceso al proyecto Supabase real (fuera del repositorio).

## Consecuencias positivas

- Elimina la ambigüedad para el equipo de migración: existe un único dominio canónico (`agx`), mientras el DDL definitivo queda sujeto al diseño multicliente y a la separación formal de ambientes.
- Remueve del camino crítico la dependencia del modelo específico de Supabase (`auth.uid()`, Supabase Auth y Supabase Storage), sin eliminar el requisito de PostgreSQL RLS definido por ADR-008.
- Simplifica la dirección arquitectónica al mantener un único dominio canónico (`agx`), cuyas migraciones formales deberán diseñarse, versionarse, probarse y promoverse por ambiente.
- Un retiro validado (inventario + respaldo), en vez de un retiro inmediato, reduce significativamente el riesgo de pérdida de datos no detectados y conserva una vía verificable de recuperación.

## Consecuencias negativas

- Cualquier capacidad que hoy dependa conceptualmente de RLS multi-tenant o Supabase Storage (aunque no esté en uso real) deberá diseñarse desde cero si se necesita en el futuro — no hay equivalente implementado en `agx`.
- Requiere una fase de validación explícita (inventario, exportación, respaldo, verificación) antes de poder ejecutar el retiro de `LivestockPlatform.jsx`/`.backup.jsx` y `src/lib/supabaseClient.js`, lo que retrasa el cierre completo de esta decisión.

## Riesgos

- Riesgo de pérdida de información si existiera algún dato real capturado únicamente en el proyecto Supabase (fuera del repositorio, no verificable desde el código) que no tenga equivalente en `agx` — mitigado exclusivamente por completar la validación antes del retiro, no por esta decisión en sí misma.
- Riesgo de que algún consumidor no detectado por búsqueda de texto (import dinámico, script externo, uso directo del panel de Supabase) dependa todavía de `public`/Supabase — la auditoría lo marcó como NO VERIFICADO en ese punto específico.
- Mantener Supabase activo más tiempo del necesario mientras se completa la validación implica costo/superficie de mantenimiento adicional, pero es preferible al riesgo de pérdida de datos.

## Acciones requeridas

Como condición **previa a cualquier retiro** de Supabase/`public`, debe completarse:

- **Inventario**: listar exhaustivamente todas las tablas, funciones, triggers, políticas RLS, buckets de Storage y configuración de Auth existentes en el proyecto Supabase real (no solo lo versionado en `supabase/migrations/`).
- **Exportación**: extraer una copia completa y verificable de los datos actuales de `public` (incluyendo Storage, si contiene archivos) y de la configuración de Auth (usuarios, roles, políticas).
- **Respaldo**: conservar esa exportación en un lugar seguro y documentado, con fecha, antes de tocar el proyecto Supabase real.
- **Verificación**: confirmar explícitamente, tabla por tabla y con evidencia, si existe algún dato de producción real (no demo/placeholder) en `public`, Auth o Storage que no tenga equivalente en `agx`.

Adicionalmente:

- Documentar `agx` como esquema canónico en la documentación de arquitectura general del proyecto (`docs/SAAS_ARCHITECTURE.md` u otro documento equivalente).
- Planificar, en un ticket de trabajo separado, el retiro formal de `LivestockPlatform.jsx`, `LivestockPlatform.backup.jsx` y `src/lib/supabaseClient.js`, únicamente después de completar el inventario/exportación/respaldo/verificación anteriores.
- Diseñar migraciones formales de `agx` alineadas con ADR-008, incluyendo organizaciones, membresías, `organizacion_id` directo, autorización centralizada y RLS antes de producción.
- Separar catálogos globales de cualquier seed demo o dato de demostración.
- Retirar o archivar `server/sql/003_agx_seed_demo_optional.sql` como artefacto histórico no ejecutable.
- No aprovisionar RDS desde `server/sql/001_agx_core_schema.sql`, `002_agx_seed_demo.sql` ni `003_agx_seed_demo_optional.sql`.

## Criterios de aceptación

- La instancia RDS de staging para Ganadería usa un DDL multicliente formal alineado con ADR-008.
- Todas las tablas organizacionales incluyen `organizacion_id` directo y verificable.
- La demo no toca `agx`, backend ni base de datos, conforme a ADR-014.
- Los seeds de staging son sintéticos o previamente anonimizados, idempotentes y separados de producción.
- **Supabase/`public` no se elimina, desactiva ni deja de pagarse hasta que el inventario, la exportación, el respaldo y la verificación queden completos y documentados**, con evidencia revisable.
- Queda registrada por escrito la decisión final de retiro (con la validación ya completa) o de mantenimiento justificado de `public`/Supabase, con fecha.

## Elementos fuera de alcance

- Ejecución real del retiro de Supabase (esta ADR solo formaliza la clasificación y la condición de validación previa, no ejecuta la baja).
- Migración de cualquier dato que pudiera existir hoy en el proyecto Supabase real (se decide después de la verificación).
- Decisión sobre autenticación de usuarios (ver ADR-005) — el eventual retiro de Supabase no implica que su mecanismo de Auth sea reemplazado automáticamente por otro definido aquí.
