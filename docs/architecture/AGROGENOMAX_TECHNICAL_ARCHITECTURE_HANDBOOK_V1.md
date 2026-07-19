# AGROGENOMAX TECHNICAL ARCHITECTURE HANDBOOK

## Control documental

| Campo | Valor |
|---|---|
| Versión | 1.1 |
| Fecha | 2026-07-19 |
| Estado | Aprobado |
| Propietario | CRH Soluciones Integrales S.A.S. - Arquitectura AgroGenomaX |
| Responsables | Equipo técnico AgroGenomaX / CRH Soluciones Integrales S.A.S. |
| Ciclo de revisión | Revisión obligatoria ante cualquier ADR nuevo o modificado, cambio de infraestructura productiva o cierre de gates de seguridad, red, cookies, health, rollback, CatastroX o datos |
| Documentos relacionados | `docs/adr/ADR-001-arquitectura-aws-inicial.md` a `docs/adr/ADR-014-mecanismo-tecnico-separacion-demo-staging-produccion.md`; `docs/AWS_TRANSITION_PLAN_PHASE_0_STAGING.md`; `CLAUDE.md`; `AGENTS.md`; documentación CatastroX vigente en `docs/catastrox/`; `docs/SAAS_ARCHITECTURE.md` |

Los ADR aprobados prevalecen sobre este Technical Architecture Handbook (TAH). Cuando un ADR posterior precisa o sustituye una parte de un ADR anterior, este TAH debe leerse según la precedencia indicada en la sección 2.

---

## 1. Propósito y alcance

Este TAH es el handbook oficial y vivo de arquitectura técnica de AgroGenomaX. Consolida tres planos que no deben mezclarse:

- **Estado actual implementado y verificable en código**: lo que el repositorio ejecuta hoy.
- **Arquitectura objetivo aprobada por ADR**: decisiones normativas ya cerradas, aunque no estén implementadas.
- **Decisiones de seguimiento abiertas**: aspectos que los ADR vigentes dejan pendientes de diseño, implementación o validación.

Este documento cubre frontend, backend, datos, seguridad, CatastroX, Ganadería, health, infraestructura objetivo AWS, CI/CD, migración, riesgos y anexos de rutas/datos/ADR. No crea infraestructura, no cambia código y no reemplaza los ADR.

Quedan cerradas por ADR y no se tratan como pendientes: proveedor de autenticación (Cognito), patrón navegador-BFF, mecanismo técnico demo/staging/producción, locking de Terraform, sustitución de la plataforma histórica de ADR-001, paths generales de health/liveness/readiness, rutas y entregables comerciales CatastroX, y separación de ambientes.

## 2. Precedencia normativa

| ADR | Decisión vigente |
|---|---|
| ADR-001 | Arquitectura AWS inicial: Cloudflare conserva frontend/DNS/CDN, Railway queda como rollback temporal y AWS es destino. Su plataforma de backend fue sustituida por ADR-011. |
| ADR-002 | `agx` es el dominio/esquema lógico canónico de Ganadería frente a `public`/Supabase. Los SQL monocliente actuales son inventario histórico/propuesta, no DDL definitivo. |
| ADR-003 | Terraform e IaC, sin apply automático y sin credenciales largas. El locking fue precisado por ADR-010. |
| ADR-004 | Separación demo/producción como principio. ADR-014 cierra el mecanismo técnico. |
| ADR-005 | Clasificación general de rutas y necesidad de autenticación/autorización. ADR-007, ADR-009 y ADR-013 precisan mecanismos. |
| ADR-006 | CatastroX migra a RDS/PostGIS solo cuando el flujo geoespacial sea reproducible. |
| ADR-007 | Amazon Cognito es el mecanismo aprobado de autenticación. |
| ADR-008 | Multicliente: organizaciones, membresías, `organizacion_id` directo, autorización centralizada y RLS obligatorio. |
| ADR-009 | Para navegador-BFF: cookie de sesión opaca HttpOnly/Secure/SameSite + CSRF; nunca Bearer administrado por JavaScript. El BFF recupera y valida el access_token. Bearer queda para integraciones externas autorizadas. |
| ADR-010 | Backend Terraform: S3, locking nativo `use_lockfile`, KMS CMK, CI en dos etapas y bootstraps independientes. |
| ADR-011 | Sustituye solo la plataforma App Runner definida en ADR-001: objetivo Amazon ECS Express Mode; contingencia ECS + Fargate directo mediante Terraform; Railway rollback temporal. |
| ADR-012 | Health, liveness, readiness y graceful shutdown. |
| ADR-013 | Rutas, autorización transaccional y entregables comerciales de CatastroX. |
| ADR-014 | Demo, staging y producción quedan separados definitivamente. |

## 3. Vision de AgroGenomaX

AgroGenomaX es una plataforma de CRH Soluciones Integrales S.A.S. para inteligencia territorial y ganadera en Colombia. Sus módulos activos son:

- **Ganadería Inteligente**: gestión de predios, potreros, animales, QR, ficha animal, pesajes, vacunaciones, tratamientos, reproducción y genética.
- **CatastroX**: consulta pública de información catastral procesada, venta de paquetes, entregables y rutas comerciales.
- **AGX Territorio**: módulo estratégico, aún sin implementación funcional principal.

La infraestructura objetivo es AWS, con migración incremental y reversible desde el estado actual Cloudflare Pages + Railway.

## 4. Principios arquitectonicos

- Seguridad por diseño y mínimo privilegio.
- Separación estructural demo/staging/producción.
- Datos reales y datos demo imposibles de mezclar por diseño.
- Infraestructura reproducible con Terraform y gates humanos.
- Cloudflare permanece como frontend, DNS, CDN y relay same-origin.
- Backend objetivo en ECS Express Mode, con ECS + Fargate directo como contingencia.
- Railway permanece solo como rollback temporal hasta retiro aprobado.
- CatastroX no migra completamente sin cumplir ADR-006.
- Los ADR aprobados son la norma; este TAH los consolida.

## 5. Estado actual verificado en código

Verificacion realizada sobre:

- `server/index.js`
- `server/routes/health.js`
- `server/middleware/errors.js`
- `server/db.js`
- `server/catastroxDb.js`
- `server/config/env.js`
- `server/security/corsPolicy.js`
- `server/health/liveness.js`
- `server/lifecycle/gracefulShutdown.js`
- `functions/api/health.js`
- `functions/api/animales/[id].js`
- `functions/api/animales/[id]/razas.js`
- `functions/api/qr/[codigo].js`
- `functions/api/catastrox/[[path]].js`
- `functions/api/catastrox/payments/[[path]].js`
- `functions/_data/agxStatic.js`
- `shared/security/corsPolicy.js`
- `src/config/runtimeConfig.js`
- `src/modules/catastrox/services/catastroxApi.js`
- `src/modules/ganaderia/GanaderiaApp.jsx`
- `src/modules/ganaderia/pages/GanaderiaAccess.jsx`
- `src/modules/ganaderia/pages/GanaderiaDashboard.jsx`
- `src/modules/ganaderia/pages/GanaderiaDemo.jsx`
- `src/modules/ganaderia/api/ganaderiaApi.js`
- `package.json`
- `server/package.json`

### 5.1 Infraestructura actual

| Componente | Estado actual |
|---|---|
| Frontend | React 19 + Vite 7, SPA servida estaticamente. |
| Borde | Cloudflare Pages + Pages Functions. |
| Backend | Express 5 en Railway, con rutas bajo `/api/*`. |
| Ganadería DB | PostgreSQL por `DATABASE_URL`, dominio lógico `agx`, pool perezoso. |
| CatastroX DB | PostgreSQL/PostGIS por `CATASTROX_DATABASE_URL`, pool perezoso independiente. |
| Supabase | Legacy `public`, no consumido por backend real; retiro condicionado a inventario/respaldo. |
| AWS | No hay recursos AWS creados por este TAH; AWS es objetivo. |

### 5.2 Cambios implementados relevantes

- `APP_ENV` es obligatorio para el backend real: `server/index.js` llama `getConfig()` antes de abrir puerto y sale con error si falla.
- Los pools de `server/db.js` y `server/catastroxDb.js` se crean de forma perezosa y exigen configuración validada.
- CORS en Express usa allowlist por `APP_ENV` desde `shared/security/corsPolicy.js`; no usa comodin ni reflejo indiscriminado.
- Los relays de Cloudflare para CatastroX y pagos ya no tienen fallback hardcodeado a Railway ni wildcard CORS.
- `functions/api/health.js` ya no fabrica un health estático; proxy real hacia `/api/health/live` del backend, valida `API_BACKEND_URL` contra `API_BACKEND_ALLOWED_ORIGIN`, usa `Cache-Control: no-store` y no revela URLs internas.
- Existe `GET /api/health/live` en Express, sin dependencias externas ni apertura de pools.
- Existe graceful shutdown con `SIGTERM`/`SIGINT`, cierre de servidor HTTP y cierre de ambos pools.
- Las funciones estáticas de animales/QR en Cloudflare siguen sirviendo fixtures (`AGX-000003` / RADAMANTIS), pero ya usan política CORS compartida y no wildcard.
- `src/config/runtimeConfig.js` restringe overrides de API a development local; staging/production usan relay same-origin `/api`; demo no tiene API válida.
- CatastroX eliminó el fallback mock silencioso para lookup productivo: fuera de development local, la API resuelve vía relay same-origin y los errores se comunican como mensajes seguros de dominio.
- Ganadería tiene acceso real habilitado en `/ganaderia/dashboard`; la demo usa `loadDemoData()`/`resetDemoData()` y fixtures locales, no `ganaderiaApi`.

### 5.3 Brechas implementadas aún abiertas

- `server/middleware/errors.js` todavía responde `error.message` crudo en errores generales. El health público está sanitizado, pero el handler global no.
- Readiness general y readiness por dominio no están implementadas en Express.
- No existe autenticación Cognito/BFF implementada.
- No existe RLS multicliente implementado en `agx`.
- No existe Dockerfile/Terraform ECS en el repo verificado.
- `server/package.json` mantiene dependencias en `latest`.
- Functions estáticas de animales/QR deben retirarse, aislarse a demo o convertirse en proxy según el corte de arquitectura.

## 6. Arquitectura objetivo aprobada

### 6.1 Diagrama objetivo

```
Usuario navegador
  |
  v
Cloudflare (DNS + CDN + frontend + relay same-origin)
  |
  | /api/*
  v
BFF / Backend Express en Amazon ECS Express Mode
  |                         |
  |                         +--> Cognito: validación interna de tokens
  |
  +--> RDS PostgreSQL agx (transaccional, multicliente, RLS)
  |
  +--> RDS PostgreSQL + PostGIS CatastroX
  |
  +--> Wompi / servicios externos autorizados

Contingencia: ECS + Fargate directo mediante Terraform.
Rollback temporal: Railway hasta retiro aprobado.
```

ADR-011 sustituyó App Runner, la plataforma histórica de backend mencionada en ADR-001; cualquier referencia anterior a esa plataforma queda como estado histórico sustituido, no como objetivo vigente.

### 6.2 Cloudflare

Cloudflare conserva frontend, DNS, CDN y relay same-origin. En staging/producción el navegador no debe depender de URLs absolutas de backend inyectadas en build. En demo, no hay relay `/api/*` funcional.

### 6.3 Backend AWS

Objetivo: Amazon ECS Express Mode. Contingencia: ECS + Fargate directo mediante Terraform. Railway se conserva solo como rollback temporal durante gates de migración y debe tener fecha/política de retiro.

## 7. Ganadería

### 7.1 Estado actual

El backend actual consume `agx` por `server/db.js` y rutas `server/routes/*.js`. El frontend usa `ganaderiaApi` para cuenta real y `GanaderiaDemo.jsx` para demo local. El dashboard real consulta animales, predios y potreros.

### 7.2 Norma vigente

`agx` es el dominio/esquema lógico canónico de Ganadería. Esto no aprueba el DDL monocliente actual como definitivo.

`server/sql/001_agx_core_schema.sql`, `server/sql/002_agx_seed_demo.sql` y `server/sql/003_agx_seed_demo_optional.sql` quedan clasificados como inventario histórico/propuesta monocliente no autorizada para crear RDS.

ADR-008 exige:

- organizaciones;
- membresías;
- `organizacion_id` directo en todas las tablas organizacionales;
- autorización centralizada;
- RLS obligatorio;
- rol de aplicación sin `BYPASSRLS`, sin propiedad de tablas y sin privilegios administrativos.

La demo no usa esos SQL, no toca backend y no toca base de datos.

## 8. Demo, staging y producción

### 8.1 Demo objetivo

Demo objetivo: `demo.agrogenomax.com`.

La demo debe operar:

- sin backend;
- sin base de datos;
- sin Cognito;
- sin cookies de servidor;
- sin relay `/api/*`;
- sin variables ni clientes API productivos;
- con fixtures sintéticas empaquetadas;
- con estado interactivo local o `sessionStorage`;
- con entregables marcados como `MUESTRA`.

`003_agx_seed_demo_optional.sql` no es mecanismo demo vigente.

### 8.2 Staging

Staging usa credenciales y recursos separados. Solo puede usar datos sintéticos o previamente anonimizados. Ningún snapshot productivo puede restaurarse directamente sin anonimizar. Cookies host-only separadas.

### 8.3 Producción

Producción nunca recibe seeds demo. Usa recursos, credenciales, cookies y datos separados. Debe pasar gates de seguridad, health, cookies, backups, observabilidad, red, ALB, rollback y CatastroX aplicables.

### 8.4 APP_ENV

`APP_ENV` es obligatorio y fail-fast en backend actual. En frontend, `VITE_APP_ENV` guía la resolución runtime: demo bloquea API, staging/producción usan `/api`, development local admite overrides controlados.

## 9. Autenticación y autorización

### 9.1 Decisión vigente

Cognito es el proveedor aprobado. `agx` es la fuente de autorización de negocio.

### 9.2 Navegador-BFF

Para navegador:

- cookie de sesión opaca HttpOnly/Secure/SameSite;
- CSRF obligatorio;
- nunca Bearer administrado por JavaScript;
- el BFF recupera y valida internamente el `access_token` en cada solicitud autenticada.

Bearer directo queda reservado para integraciones externas autorizadas.

### 9.3 Planos PostgreSQL

Se distinguen tres planos:

- **Seguridad/sesión**: datos de sesión, vinculación Cognito y control BFF.
- **Negocio sujeto a RLS**: tablas organizacionales de `agx` y datos de cliente.
- **Migración/administración**: roles de migración y break-glass, separados del rol de aplicación.

## 10. CatastroX

### 10.1 Estado actual

CatastroX mantiene consulta pública y compra sin login obligatorio. El frontend usa `catastroxApi.js`, relay same-origin y rutas Express. Existen flujos actuales basados en `lookupId` y endpoints `full-result`; estos son estado actual/de transición, no frontera objetivo definitiva.

`catastroxDeliverables.js` se conserva como activo técnico, demo y referencia de portabilidad. No es la frontera productiva definitiva para entregables pagos.

### 10.2 Norma ADR-013

Modelo objetivo:

- `customer`;
- `order`;
- `order_item`;
- `payment`;
- `entitlement`;
- `artifact`;
- token de intercambio;
- cookie de acceso.

`GET full-result` queda obsoleto y destinado a retiro después de migrar consumidores. La primera generación de entregables pagos debe ser server-side y automática tras pago + entitlement. Regularización Predial es lead comercial, no una orden transaccional automática.

No se debe afirmar que todos los entregables futuros permanecen client-side.

### 10.3 Datos geoespaciales

CatastroX conserva condición ADR-006: no migra completamente a RDS/PostGIS sin flujo reproducible de datos geoespaciales. La documentación vigente de `docs/catastrox/` define importaciones limpias, EPSG:9377 pendiente y catálogos semánticos.

## 11. Health y operación

### 11.1 Contratos ADR-012

- `GET /api/health`: público, mínimo, sin datos internos y `Cache-Control: no-store`.
- `GET /api/health/live`: liveness para ALB, sin dependencias externas, sin PostgreSQL/PostGIS.
- Readiness general y readiness por dominio: restringidas.
- Readiness Ganadería y CatastroX: independientes.
- Target group no consulta PostgreSQL/PostGIS.
- Graceful shutdown y cierre de ambos pools.

### 11.2 Estado implementado

Implementado:

- `GET /api/health/live` en Express.
- relay real de `functions/api/health.js` hacia backend liveness.
- `Cache-Control: no-store` en relay health.
- graceful shutdown.
- cierre de pools `agx` y CatastroX.

Pendiente:

- readiness general restringida.
- readiness de Ganadería.
- readiness de CatastroX.
- sanitizar globalmente respuestas de error fuera de health.

## 12. Terraform y CI/CD

ADR-010 define:

- backend remoto S3;
- locking nativo `use_lockfile`;
- KMS CMK dedicada;
- roles separados;
- bootstraps independientes;
- staging y producción independientes;
- validación estática sin AWS en pull request;
- plan/apply privilegiado solo después de gate humano;
- ningún pull request de fork con OIDC o secrets;
- ningún apply automático.

El repositorio en GitHub está confirmado. No queda pendiente confirmar GitHub ni el mecanismo general de lock.

## 13. Migración objetivo

Secuencia vigente:

1. Documentación y ADR.
2. Seguridad, autenticación y modelo de datos.
3. Terraform sin apply.
4. AWS staging.
5. Contenedor/backend en ECS Express Mode.
6. Ganadería multicliente en RDS staging.
7. Gates de health, cookies, despliegue y rollback.
8. CatastroX condicionado por ADR-006.
9. Railway como rollback temporal.
10. Corte productivo solo tras seguridad, backups, observabilidad y validación integral.

## 14. Observabilidad, backups, costos y calidad

### 14.1 Observabilidad

Objetivo: logs estructurados, métricas de errores/latencia, eventos de CORS/health/shutdown seguros, alarmas por dominio, trazabilidad de órdenes CatastroX y monitoreo de conexiones RDS.

### 14.2 Backups y recuperación

Pendiente definir RPO/RTO formal. Producción requiere backups antes de corte. Staging no puede recibir snapshots productivos sin anonimizar.

### 14.3 Costos

El presupuesto de staging no es presupuesto productivo. Todo recurso AWS requiere responsable, propósito y política de apagado/retiro cuando aplique.

### 14.4 Calidad técnica

Antes de contenedor productivo se deben fijar versiones en `server/package.json`, consolidar pruebas, validar rutas críticas y eliminar dependencias en comportamiento estático no productivo.

## 15. Riesgos arquitectonicos

| ID | Riesgo | Estado | Mitigacion vigente |
|---|---|---|---|
| R-01 | DDL multicliente/RLS de `agx` no implementado. | Abierto | Migraciones formales ADR-008, roles separados, pruebas RLS. |
| R-02 | Cognito/BFF/cookies/CSRF no implementados. | Abierto | Implementar ADR-007/ADR-009 antes de rutas privadas. |
| R-03 | Handler global expone `error.message`. | Abierto | Sanitizar respuestas globales; conservar detalle solo en logs seguros. |
| R-04 | Readiness por dominio no implementada. | Abierto | Implementar ADR-012 con rutas restringidas. |
| R-05 | Dependencias `server/package.json` en `latest`. | Abierto | Pin de versiones antes de imagen. |
| R-06 | Functions estáticas animales/QR pueden confundirse con datos reales. | Abierto | Retirar o convertir a proxy real antes del corte productivo; si sus fixtures se reutilizan en demo, deben trasladarse exclusivamente al bundle local standalone de `demo.agrogenomax.com`, sin Function, endpoint backend ni relay `/api/*`. |
| R-07 | Roles IAM para ECS/RDS/Secrets/KMS no definidos físicamente. | Abierto | Terraform con mínimo privilegio y revisión humana. |
| R-08 | Imagen de contenedor sin digest inmutable. | Abierto | Publicar y desplegar por digest, no por tag mutable. |
| R-09 | Límites de conexiones RDS no dimensionados. | Abierto | Pool sizing, parámetros RDS, pruebas de carga. |
| R-10 | Red productiva ECS/ALB/RDS no validada. | Abierto | Gates de red, SG, subnets y egress. |
| R-11 | Ciclo de vida ALB/target groups no probado. | Abierto | Validar liveness, deregistration delay y despliegue canario. |
| R-12 | Gate de cookies no ejecutado. | Abierto | Validar host-only, Secure, SameSite, CSRF y dominios por ambiente. |
| R-13 | Rollback a Railway no verificado. | Abierto | Runbook y prueba de rollback antes de corte. |
| R-14 | Barreras ADR-014 parcialmente implementadas. | Abierto | Completar demo standalone, staging sintético y producción sin demo. |
| R-15 | CatastroX artifacts productivos no migrados al modelo ADR-013. | Abierto | Entitlements, artifacts server-side, token de intercambio y cookie de acceso. |
| R-16 | EPSG:9377 y reproducibilidad PostGIS aún pendientes de cierre final. | Abierto | Completar documentación/import reproducible y validación ADR-006. |
| R-17 | Supabase `public` podria contener datos no inventariados. | Abierto | Inventario, exportacion, respaldo y verificacion antes de retiro. |

Correcciones verificadas en el código actual: eliminación del fallback mock silencioso de CatastroX fuera de development local; eliminación de wildcard CORS en los relays revisados de CatastroX y health; sustitución del health estático fabricado en `functions/api/health.js` por relay real; incorporación de liveness; graceful shutdown y cierre de ambos pools. Estas correcciones no sustituyen los gates de validación integral en staging exigidos por ADR-011, ADR-012 y ADR-014.

## 16. Decisiones de seguimiento abiertas

- DDL físico final multicliente y RLS.
- Procedimiento break-glass.
- Mecanismo de acceso temporal interno.
- Implementación física de pools/roles PostgreSQL.
- Resultado del gate de cookies.
- Resultado de gates de red, ALB, canario y rollback.
- CPU/memoria/arquitectura de contenedor.
- Límite de conexiones RDS.
- Modelo definitivo de almacenamiento/streaming de artifacts.
- Webhook Wompi.
- TTL/rate limiting de órdenes, tokens y artifacts.
- Procedimiento de anonimización.
- Migración de `/ganaderia/demo` a `demo.agrogenomax.com`.
- Política RPO/RTO.
- EPSG:9377.
- Fecha de retiro de Railway.
- Presupuesto productivo.

## 17. Roadmap técnico

1. Consolidar documentación normativa: ADR-001 a ADR-014 y TAH 1.1.
2. Diseñar la migración formal de `agx` multicliente y RLS.
3. Implementar Cognito + BFF + cookies + CSRF.
4. Completar barreras ADR-014: demo standalone, staging sintético, producción sin demo.
5. Preparar Terraform ADR-010 sin apply.
6. Crear AWS staging con gates humanos.
7. Construir contenedor backend y desplegar ECS Express Mode.
8. Implementar health/readiness completo ADR-012.
9. Migrar Ganadería a RDS staging con RLS.
10. Implementar modelo CatastroX ADR-013.
11. Completar condicion CatastroX ADR-006.
12. Ejecutar gates de cookies, red, ALB, canario, rollback, backups y observabilidad.
13. Cortar producción.
14. Retirar Railway y Supabase solo cuando sus condiciones queden cumplidas.

## 18. Gobierno arquitectonico

- Todo cambio normativo requiere ADR o actualizacion explicita de este TAH.
- Todo cierre de decisión abierta debe referenciar evidencia.
- Ningún recurso AWS productivo se crea sin gate humano.
- Ningún dato demo entra a producción.
- Ningún DDL histórico se usa para crear RDS sin migración formal aprobada.

## 19. Glosario

| Término | Definición |
|---|---|
| BFF | Backend for Frontend; capa que mantiene sesión, valida tokens y protege al navegador de Bearer gestionado por JavaScript. |
| Demo | Experiencia standalone sin backend ni base de datos. |
| Entitlement | Derecho transaccional a acceder/generar/descargar un artifact CatastroX. |
| Liveness | Indica si el proceso está vivo; no consulta dependencias externas. |
| Readiness | Indica si un dominio puede atender tráfico; puede validar dependencias y debe ser restringida. |
| RLS | Row Level Security de PostgreSQL. |

## 20. Referencias

- `docs/adr/ADR-001-arquitectura-aws-inicial.md`
- `docs/adr/ADR-002-fuente-de-verdad-base-ganaderia.md`
- `docs/adr/ADR-003-estrategia-infraestructura-como-codigo.md`
- `docs/adr/ADR-004-separacion-demo-produccion.md`
- `docs/adr/ADR-005-autenticacion-y-autorizacion.md`
- `docs/adr/ADR-006-migracion-datos-geoespaciales.md`
- `docs/adr/ADR-007-mecanismo-autenticacion-autorizacion.md`
- `docs/adr/ADR-008-modelo-multicliente-organizaciones-membresias-aislamiento-datos.md`
- `docs/adr/ADR-009-patron-sesion-spa-pkce-vs-bff.md`
- `docs/adr/ADR-010-estado-remoto-bloqueo-terraform.md`
- `docs/adr/ADR-011-plataforma-ejecucion-aws-sustitucion-app-runner.md`
- `docs/adr/ADR-012-health-checks-readiness-liveness-recuperacion-operativa.md`
- `docs/adr/ADR-013-clasificacion-rutas-entregables-catastrox.md`
- `docs/adr/ADR-014-mecanismo-tecnico-separacion-demo-staging-produccion.md`
- `docs/AWS_TRANSITION_PLAN_PHASE_0_STAGING.md`
- `CLAUDE.md`
- `AGENTS.md`
- `docs/catastrox/`

ADR-001 sigue vigente como decisión histórica inicial salvo en la plataforma de backend sustituida por ADR-011.

## Anexo A. Inventario de tecnologias

| Capa | Actual | Objetivo |
|---|---|---|
| Frontend | React/Vite en Cloudflare Pages | Igual, con demo separada |
| Relay | Cloudflare Pages Functions | Same-origin por ambiente |
| Backend | Express en Railway | ECS Express Mode |
| Rollback transitorio | Railway | Retiro después de completar y aprobar los gates de migración |
| Contingencia AWS | No aplica al estado actual | ECS + Fargate directo mediante Terraform si ECS Express Mode no resulta aplicable |
| Ganadería DB | PostgreSQL `agx` monocliente actual | RDS PostgreSQL `agx` multicliente/RLS |
| CatastroX DB | PostgreSQL/PostGIS | RDS PostgreSQL/PostGIS tras ADR-006 |
| Auth | No implementado | Cognito + BFF |
| IaC | No aplicado | Terraform S3 + `use_lockfile` + CMK |

## Anexo B. Inventario de rutas

| Área | Rutas actuales relevantes | Estado |
|---|---|---|
| Health | `/api/health`, `/api/health/db`, `/api/health/live` | Liveness implementado; readiness pendiente. |
| Ganadería | `/api/predios`, `/api/potreros`, `/api/qr`, `/api/animales`, `/api/razas`, subrutas por animal | Sin auth/RLS implementado. |
| CatastroX | `/api/catastrox/*`, `/api/catastrox/payments/*` | Público/transaccional en transición a ADR-013. |
| Functions static | `/api/animales/:id`, `/api/animales/:id/razas`, `/api/qr/:codigo` | Fixtures con CORS compartido; no objetivo productivo. |

## Anexo C. Inventario de bases de datos y esquemas

| Base/schema | Clasificación vigente |
|---|---|
| `agx` | Dominio canónico Ganadería; DDL definitivo pendiente de migración multicliente formal. |
| `server/sql/001_agx_core_schema.sql` | Inventario histórico/propuesta monocliente; no ejecutable para crear RDS objetivo. |
| `server/sql/002_agx_seed_demo.sql` | Inventario histórico/seed demo; no producción. |
| `server/sql/003_agx_seed_demo_optional.sql` | Artefacto histórico no ejecutable; no mecanismo demo vigente. |
| Supabase `public` | Legacy, retiro condicionado a inventario, exportación, respaldo y verificación. |
| CatastroX PostGIS | Mantener estado real; migración condicionada por ADR-006. |

## Anexo D. Matriz de rutas y autorización

| Tipo | Ejemplos | Autorización objetivo |
|---|---|---|
| Públicas | Home, landing, consulta pública CatastroX, planes, health mínimo | Sin login; sin datos internos. |
| Orden CatastroX | Acceso a orden, artifact, token de intercambio | Cookie de acceso y entitlement; no `lookupId` como llave final. |
| Autenticadas Cognito/BFF | Ganadería real, cuenta cliente, CRUD organizacional | Cookie BFF + CSRF + validación interna access_token + RLS. |
| Administrativas | Readiness restringida, auditorías, operaciones internas | Acceso administrativo separado, no público. |
| Deprecadas/transición | `GET /api/catastrox/lookups/:lookupId/full-result` | Retiro tras migrar consumidores a ADR-013. |

## Anexo E. Matriz de trazabilidad ADR -> TAH

| ADR | Aplicación en TAH | Precedencia |
|---|---|---|
| ADR-001 | AWS inicial, Cloudflare, Railway rollback | Plataforma backend sustituida por ADR-011. |
| ADR-002 | `agx` canónico, Supabase legacy | DDL monocliente precisado por ADR-008 y ADR-014. |
| ADR-003 | Terraform, no apply automático | Lock cerrado por ADR-010. |
| ADR-004 | Separación demo/producción | Seguimiento cerrado por ADR-014. |
| ADR-005 | Clasificación de rutas | Precisada por ADR-007, ADR-009 y ADR-013. |
| ADR-006 | CatastroX PostGIS reproducible | Sigue condicionando migración CatastroX. |
| ADR-007 | Cognito | ADR-009 precisa navegador-BFF. |
| ADR-008 | Multicliente/RLS | Precisa y sustituye la parte monocliente del modelo físico anterior; ADR-002 conserva vigente la elección de `agx` como dominio canónico y las condiciones de retiro de Supabase. |
| ADR-009 | Cookie BFF/CSRF y Bearer externo | Precisa ADR-007. |
| ADR-010 | S3 backend, `use_lockfile`, CMK, CI dos etapas | Cierra locking pendiente de ADR-003. |
| ADR-011 | ECS Express Mode | Sustituye App Runner como plataforma de backend de ADR-001. |
| ADR-012 | Health/liveness/readiness/shutdown | Cierra paths generales de health. |
| ADR-013 | CatastroX customer/order/entitlement/artifact | Cierra autorización transaccional pendiente de CatastroX. |
| ADR-014 | Demo/staging/producción | Cierra seguimiento de ADR-004. |
