# AWS Transition Plan — Fase 0: Staging

**Estado:** Aprobado, actualizado conforme a ADR-011 a ADR-014. Documento de planificación, sin creación real de recursos.
**Fecha:** 2026-07-19
**Versión:** 1.1
**Dependencias normativas:** ADR-001 a ADR-014 y `docs/architecture/AGROGENOMAX_TECHNICAL_ARCHITECTURE_HANDBOOK_V1.md` versión 1.1.
**Regla de precedencia:** los ADR aprobados prevalecen sobre este plan. Si este documento entra en conflicto con un ADR aceptado, se aplica el ADR.
**Presupuesto vigente:** máximo USD 25/mes como gate previo a cualquier `apply`.

Este documento define la Fase 0 para preparar y validar staging AWS de AgroGenomaX. No autoriza producción, no crea recursos AWS, no ejecuta Terraform y no cambia código.

## 1. Precedencias normativas

| Fuente | Decisión aplicable a Fase 0 |
|---|---|
| ADR-001 | AWS es la plataforma objetivo, con migración incremental y reversible. La plataforma App Runner quedó sustituida por ADR-011. |
| ADR-007 | Amazon Cognito es el proveedor aprobado de autenticación. |
| ADR-008 | Ganadería debe ser multicliente: organizaciones, membresías, `organizacion_id` directo, autorización centralizada y RLS obligatorio. |
| ADR-009 | Navegador-BFF usa cookie de sesión, CSRF y validación interna de `access_token`; nunca Bearer administrado por JavaScript. Bearer directo queda para integraciones externas autorizadas. |
| ADR-010 | Terraform usa backend S3, locking nativo `use_lockfile`, CMK dedicada y CI en dos etapas. |
| ADR-011 | Amazon ECS Express Mode sustituye App Runner. ECS + Fargate directo mediante Terraform es contingencia AWS. Railway permanece como rollback temporal. |
| ADR-012 | Define health, liveness, readiness, `Cache-Control: no-store`, graceful shutdown y cierre de pools. |
| ADR-013 | Define el modelo transaccional de CatastroX: customer, order, order_item, payment, entitlement, artifact, token de intercambio y cookie de acceso. |
| ADR-014 | Define separación demo/staging/producción. Demo no usa backend ni base de datos; staging usa datos sintéticos o anonimizados; producción nunca recibe datos demo. |

## 2. Estado actual verificado en código

Verificado de forma dirigida en el repositorio antes de actualizar este plan:

- `server/index.js` valida configuración de ambiente antes de aceptar tráfico, monta CORS con allowlist, expone `/api/health/live`, monta `/api/health`, maneja `SIGTERM`/`SIGINT` y cierra los pools de `server/db.js` y `server/catastroxDb.js`.
- `server/routes/health.js` existe como router de health de dominio, montado bajo `/api/health`.
- `server/middleware/errors.js` todavía responde `error.message` crudo en errores generales; debe corregirse antes del corte.
- `server/db.js` usa `DATABASE_URL` y `PGSCHEMA=agx`; el pool se crea de forma perezosa y tiene cierre explícito.
- `server/catastroxDb.js` usa `CATASTROX_DATABASE_URL` y `CATASTROX_PGSCHEMA`; el pool se crea de forma perezosa y tiene cierre explícito.
- `functions/api/health.js` ya no fabrica un health estático: actúa como relay real hacia `/api/health/live`, valida `API_BACKEND_URL` contra `API_BACKEND_ALLOWED_ORIGIN`, usa `Cache-Control: no-store` y no imprime la URL interna.
- `src/config/runtimeConfig.js` exige `VITE_APP_ENV`, limita overrides de API a development local y usa relay same-origin `/api` en staging/production.
- Existen funciones estáticas de animales/QR con fixtures; deben retirarse, convertirse en proxy real o quedar fuera del backend de staging según ADR-014.
- `server/package.json` mantiene dependencias en `latest`; deben fijarse antes de construir una imagen reproducible.

No se considera implementado todavía: Cognito/BFF, CSRF, RLS multicliente, DDL físico final de `agx`, readiness restringida general y por dominio, Terraform AWS, Dockerfile productivo, ECR ni ECS.

## 3. Arquitectura de staging

Arquitectura vigente de Fase 0:

- Cloudflare conserva frontend, DNS, CDN y relay same-origin.
- Staging usa un origen separado, conceptualmente `staging.agrogenomax.com`.
- Backend objetivo: Amazon ECS Express Mode.
- Contingencia AWS: ECS + Fargate directo mediante Terraform, solo si ECS Express Mode no resulta aplicable.
- ECR almacena imágenes de contenedor por digest inmutable.
- ALB/HTTPS se administra según el modelo definido por ADR-011.
- RDS PostgreSQL aloja `agx` staging.
- RDS PostgreSQL + PostGIS aloja CatastroX staging, condicionado por ADR-006.
- Secrets Manager almacena secretos de staging.
- CloudWatch Logs/Metrics concentra logs y métricas.
- Cognito staging se incorpora cuando se implemente el gate de autenticación.
- Railway permanece intacto como rollback temporal.
- No se usa Amplify Hosting en esta fase.
- No se cambia el frontend productivo ni DNS productivo.

Diagrama textual:

```text
Usuarios de prueba
        |
        v
Cloudflare staging (frontend, DNS/CDN, relay same-origin /api)
        |
        v
BFF / Backend Express en Amazon ECS Express Mode
        |                         |
        |                         +--> Cognito staging (objetivo ADR-007/ADR-009)
        |
        +--> RDS PostgreSQL agx staging (multicliente, RLS)
        |
        +--> RDS PostgreSQL + PostGIS CatastroX staging (condicionado por ADR-006)
        |
        +--> Secrets Manager / CloudWatch / ECR

Contingencia AWS: ECS + Fargate directo mediante Terraform.
Rollback temporal: relay Cloudflare vuelve a Railway.
```

## 4. Fases

### Fase 0A — Preparación documental y técnica sin recursos facturables

0A deja todo listo para una ventana de staging, sin crear recursos facturables ni ejecutar `terraform apply`.

- TAH 1.1 y ADR-001 a ADR-014 revisados.
- Terraform escrito y validado sin `apply`.
- Backend remoto de Terraform diseñado según ADR-010: S3, `use_lockfile`, CMK y bootstraps independientes.
- Roles IAM diseñados con mínimo privilegio.
- Dockerfile pendiente o preparado, con build reproducible.
- Definición de task/service para ECS Express Mode y contingencia ECS + Fargate directo.
- ECR planificado.
- Variables de entorno documentadas.
- DDL multicliente/RLS diseñado para `agx`, alineado con ADR-008.
- Procedimiento de anonimización documentado.
- Gates de cookies, red, health, canario, rollback y conexiones RDS preparados.
- Presupuesto actualizado con AWS Pricing Calculator antes de cualquier `apply`.
- Ventana de prueba definida con fecha/hora de inicio y finalización.
- Plan de desmontaje definido.
- Dataset sintético o copia previamente anonimizada preparada y validada localmente.

### Fase 0B — Staging temporal con apply explícitamente aprobado

0B solo puede ejecutarse después de aprobar 0A, recalcular costos y confirmar que la proyección no supera USD 25/mes.

- Bootstrap/state de staging creado según ADR-010.
- ECR creado para imágenes de staging.
- ECS Express Mode desplegado para backend staging.
- RDS `agx` staging creado con DDL multicliente/RLS formal.
- RDS/PostGIS staging creado solo si ADR-006 lo permite para el alcance de la prueba.
- Secrets Manager configurado con secretos de staging.
- CloudWatch Logs/Metrics habilitado.
- Cognito staging configurado cuando corresponda al gate de autenticación.
- Relay Cloudflare de staging configurado hacia el origen real.
- Pruebas ejecutadas dentro de la ventana aprobada.
- Desmontaje ejecutado y registrado.

0B no autoriza producción, recursos productivos, corte DNS productivo ni retiro definitivo de Railway.

## 5. Datos de staging

Reglas obligatorias:

- Staging usa datos sintéticos o previamente anonimizados.
- Ningún snapshot productivo se restaura directamente.
- Si se parte de una copia productiva, el procedimiento formal de anonimización se ejecuta antes de cargarla en staging.
- No se usan `server/sql/001_agx_core_schema.sql`, `server/sql/002_agx_seed_demo.sql` ni `server/sql/003_agx_seed_demo_optional.sql` como DDL final de RDS.
- Ganadería requiere DDL multicliente alineado con ADR-008.
- Demo no participa en staging y no usa backend ni base de datos.
- `agx` y PostGIS conservan pools, credenciales y recursos separados.
- Wompi usa únicamente sandbox.
- No se usan datos personales reales en pruebas.

## 6. Servicios AWS

| Servicio | Fase | Uso en staging | Nota |
|---|---|---|---|
| Amazon ECS Express Mode | 0B | Backend Express/BFF staging | Plataforma objetivo según ADR-011. |
| Amazon ECR | 0B | Repositorio de imágenes | Despliegue por digest inmutable; no `latest`. |
| Amazon RDS for PostgreSQL | 0B | `agx` transaccional staging | DDL multicliente/RLS formal. |
| Amazon RDS for PostgreSQL + PostGIS | 0B | CatastroX staging | Solo si ADR-006 lo permite para la prueba. |
| AWS Secrets Manager | 0B | Secretos de backend, RDS, Wompi sandbox, Cognito y cookies | Sin secretos en código ni variables productivas. |
| Amazon CloudWatch | 0B | Logs, métricas y alarmas | Retención definida antes del `apply`. |
| AWS IAM | 0A/0B | Roles de Terraform, ECS execution, ECS task e infrastructure | Mínimo privilegio y revisión humana. |
| Amazon Cognito | 0B cuando aplique | Autenticación staging | Según ADR-007/ADR-009. |
| Amazon S3 | 0A/0B | State de Terraform | Backend remoto ADR-010. |
| AWS KMS CMK | 0A/0B | Cifrado del state | CMK dedicada ADR-010. |
| VPC, subnets, security groups y ALB | 0B | Red y entrada HTTPS de staging | Según ADR-011 y gates de red/ALB. |

Aclaraciones:

- ECS + Fargate directo es contingencia, no un segundo despliegue simultáneo.
- Amplify Hosting no forma parte de esta fase; puede mencionarse solo como opción histórica no seleccionada.
- App Runner solo permanece como plataforma histórica sustituida por ADR-011.

## 7. Recursos y dimensionamiento

No hay tamaños definitivos aprobados en este documento.

- CPU, memoria, arquitectura de contenedor, autoscaling, tamaño de RDS y límites de conexiones quedan pendientes de validación.
- Se permiten valores mínimos provisionales como hipótesis de staging, nunca como aprobación productiva.
- Ningún despliegue usa `latest`; toda imagen se promueve por digest inmutable.
- El límite agregado de conexiones RDS debe calcularse antes de habilitar autoscaling.
- ALB, RDS, KMS, almacenamiento, Secrets Manager y CloudWatch pueden generar costos aunque no haya tráfico.
- Cualquier dimensión elegida para 0B debe quedar registrada junto con fecha de desmontaje.

## 8. Variables de entorno

### Backend staging

Variables mínimas a contemplar:

```text
APP_ENV=staging
PORT=<puerto del contenedor>
DATABASE_URL=<secreto de RDS agx staging>
PGSCHEMA=agx
CATASTROX_DATABASE_URL=<secreto de RDS/PostGIS CatastroX staging>
CATASTROX_PGSCHEMA=<schema CatastroX staging>
CORS_ORIGIN=<allowlist de origen staging o variable equivalente>
API_BACKEND_ALLOWED_ORIGIN=<origen permitido para relay cuando aplique>
WOMPI_ENV=sandbox
WOMPI_PUBLIC_KEY_TEST=<Secrets Manager>
WOMPI_INTEGRITY_SECRET_TEST=<Secrets Manager>
WOMPI_API_BASE_URL=<sandbox Wompi>
COGNITO_*=<variables de Cognito staging cuando se implemente>
SESSION_*=<variables de sesión/cookies cuando se implemente>
CSRF_*=<variables CSRF cuando se implemente>
```

Todos los secretos se cargan únicamente vía Secrets Manager.

### Frontend staging

```text
VITE_APP_ENV=staging
```

Reglas:

- La API usa same-origin mediante `/api`.
- No se configura `VITE_AGX_API_URL` apuntando directamente al ALB/ECS.
- No se empaquetan URLs absolutas de Railway, ALB o producción.
- No se usan variables productivas.

### Demo

- Sin variables backend.
- Sin relay.
- Sin Cognito.
- Sin Wompi.
- Sin clientes API productivos.

## 9. Costos

Las cifras heredadas de plataformas históricas no son vigentes para esta versión. Antes de cualquier `apply` se debe recalcular el costo con AWS Pricing Calculator.

Reglas:

- El presupuesto máximo de USD 25/mes continúa como gate.
- Ningún recurso se crea si la proyección supera ese límite.
- No se promete que una ventana de 1 a 3 días cueste una cifra concreta sin cálculo actualizado.
- Se distinguen costos persistentes y prorrateables.
- ALB, KMS CMK, almacenamiento, backups, Secrets Manager y CloudWatch pueden generar costos aunque las tareas estén detenidas.

Costos que deben estimarse antes de 0B:

- ECS/Fargate.
- ALB.
- ECR.
- RDS x2.
- Almacenamiento y backups.
- Secrets Manager.
- CloudWatch.
- KMS CMK.
- Cognito si aplica.
- Transferencia de datos.

## 10. Checklist Fase 0A

- [ ] ADR-001 a ADR-014 y TAH 1.1 revisados.
- [ ] Terraform sin `apply` validado.
- [ ] Backend/state/locking/KMS diseñados según ADR-010.
- [ ] Repositorio GitHub y OIDC confirmados.
- [ ] Dockerfile y build reproducible preparados.
- [ ] Estrategia de imagen sin `latest` definida.
- [ ] DDL multicliente/RLS revisado.
- [ ] Datasets sintéticos o anonimización preparada.
- [ ] Variables de staging documentadas.
- [ ] IAM mínimo diseñado.
- [ ] Límite RDS calculado.
- [ ] Checklist de cookies preparado.
- [ ] Checklist health preparado.
- [ ] Checklist red/ALB preparado.
- [ ] Rollback Railway preparado.
- [ ] Presupuesto recalculado.
- [ ] Fecha/hora de desmontaje definida.

## 11. Checklist Fase 0B

- [ ] `apply` manual aprobado.
- [ ] Recursos creados solo en staging.
- [ ] Imagen desplegada por digest.
- [ ] Roles ECS separados: execution, task e infrastructure.
- [ ] `APP_ENV=staging` y fail-fast validados.
- [ ] `/api/health/live` responde desde origen real.
- [ ] `/api/health` público no fabrica respuestas estáticas.
- [ ] Readiness restringida validada cuando esté implementada.
- [ ] Graceful shutdown probado.
- [ ] Ambos pools cierran.
- [ ] Para pruebas técnicas de infraestructura sin acceso privado: relay Cloudflare, CORS, health y origen real validados sin declarar funcionales los flujos autenticados.
- [ ] Antes de declarar funcional cualquier flujo privado de Ganadería: Cognito/BFF implementado, cookies host-only de staging, CSRF y gate Cloudflare/BFF ejecutados.
- [ ] CORS excluye demo y producción cruzada.
- [ ] RLS probado entre dos organizaciones.
- [ ] Ninguna conexión conserva contexto tenant entre solicitudes.
- [ ] Wompi sandbox.
- [ ] CatastroX no expone `full-result` como producto final cuando ADR-013 esté implementado.
- [ ] Prueba canaria ejecutada.
- [ ] Fallo de health check probado.
- [ ] Rollback automático/manual probado.
- [ ] Rollback a Railway probado.
- [ ] Límite de conexiones RDS validado.
- [ ] Logs CloudWatch revisados.
- [ ] Ningún dato real no anonimizado.
- [ ] Fecha/hora de desmontaje confirmada.

## 12. Health y operación

Contratos ADR-012 para staging:

- `/api/health` público mínimo.
- `/api/health/live` para ALB.
- Readiness restringida general y por dominio.
- `Cache-Control: no-store`.
- Target group no consulta PostgreSQL/PostGIS.
- Health público sin `error.message` crudo.
- Graceful shutdown dentro de `stopTimeout`.

Estado verificado:

- `/api/health/live` existe en Express.
- `functions/api/health.js` actúa como relay real hacia liveness.
- El shutdown cierra ambos pools.
- Readiness restringida y sanitización global de `error.message` siguen pendientes.

## 13. Rollback y desmontaje

### Rollback de despliegue

- Digest anterior conocido.
- Canario.
- Alarmas.
- Rollback manual aprobado y ensayado.

### Rollback de plataforma

- El relay Cloudflare vuelve temporalmente a Railway.
- Railway no se retira hasta aprobar gates de migración, health, cookies, datos, backups, observabilidad y rollback.

### Desmontaje de staging

- Tareas/servicio ECS.
- ALB según modelo de ciclo de vida aprobado.
- RDS `agx`.
- RDS/PostGIS CatastroX.
- Secretos de staging.
- Cognito staging si es desechable.
- Recursos de red no reutilizables.
- Imágenes ECR según política de retención.
- Logs según política.
- State Terraform conservado conforme a ADR-010; no se elimina informalmente.

No se elimina el rol/infra de Terraform sin considerar state, bootstrap, locking y trazabilidad.

## 14. Riesgos vigentes

| Riesgo | Mitigación |
|---|---|
| Sobrecosto por ALB/RDS/KMS/Secrets/CloudWatch | Recalcular antes de `apply`, definir ventana, alarmas y desmontaje. |
| Recursos olvidados | Etiquetas, responsable, fecha de eliminación y checklist de cierre. |
| Datos productivos sin anonimizar | Usar datos sintéticos o anonimización formal previa. |
| Credenciales cruzadas | Secrets Manager por ambiente y revisión manual antes de desplegar. |
| Tareas con IP pública | Gate de red y security groups antes del `apply`. |
| Security groups excesivos | Mínimo privilegio, puertos explícitos y revisión humana. |
| Imagen mutable | Despliegue por digest inmutable; prohibido `latest`. |
| Límite RDS insuficiente | Calcular conexiones agregadas antes de autoscaling. |
| Cookies/proxy Cloudflare | Gate Cloudflare/BFF y cookies host-only de staging. |
| CSRF incompleto | Gate ADR-009 antes de autenticación navegador-BFF. |
| RLS mal implementado | Pruebas entre dos organizaciones y rol sin `BYPASSRLS`. |
| Contexto tenant filtrado entre conexiones | Pruebas de transacciones, pool y limpieza de contexto por solicitud. |
| Health dependiente de RDS | Target group usa liveness sin dependencias externas. |
| Rollback no probado | Canario, digest anterior y rollback a Railway ensayados. |
| Railway retirado prematuramente | Mantenerlo como rollback hasta aprobar gates. |
| CatastroX sin cumplir ADR-006 | PostGIS staging solo dentro del alcance validado por ADR-006. |
| Artifacts ADR-013 no implementados | No presentar `full-result` como producto final. |
| Demo alcanzando backend por mala configuración | Demo sin relay, sin backend, sin Cognito y sin clientes API productivos. |

## 15. Fuera de alcance

- Producción.
- Corte DNS productivo.
- Retiro definitivo de Railway.
- Creación de recursos productivos.
- Implementación completa de CatastroX ADR-013 si no forma parte de esta fase.
- Ejecución de migración productiva.
- Creación de una demo productiva.
- Cambios de UI aprobada.
- Cambios de código.
- Ejecución de Terraform.

## 16. Tabla de prioridad

| Prioridad | Actividad | Fase | Condición de avance |
|---|---|---|---|
| 1 | Documentación y gates | 0A | ADR/TAH revisados y checklist completo. |
| 2 | Terraform sin `apply` | 0A | Backend/state/locking/KMS diseñados y validación estática. |
| 3 | Contenedor/ECR | 0A/0B | Dockerfile preparado e imagen por digest. |
| 4 | Datos sintéticos/anonimizados | 0A | Dataset o procedimiento listo antes de RDS. |
| 5 | `apply` manual de staging | 0B | Aprobación explícita y presupuesto recalculado. |
| 6 | ECS Express Mode | 0B | Backend responde liveness desde origen real. |
| 7 | RDS staging | 0B | DDL multicliente/RLS y conexiones calculadas. |
| 8 | Configuración Cloudflare staging | 0B | Relay same-origin y CORS validados. |
| 9 | Validaciones completas | 0B | Health, cookies, RLS, Wompi sandbox, CatastroX, logs y canario. |
| 10 | Rollback/desmontaje | 0B | Railway listo, recursos desmontados y state conservado. |

## 17. Tratamiento de términos obsoletos

- App Runner: solo se menciona como plataforma histórica sustituida por ADR-011.
- Amplify Hosting: solo se menciona como opción histórica no seleccionada para esta fase.
- URL directa del backend en `VITE_AGX_API_URL`: prohibida para staging; se usa `/api` same-origin.
- Dump productivo directo: prohibido; solo datos sintéticos o anonimizados.
- Seed demo: no participa en staging y no alimenta RDS.
- Costos heredados de plataformas históricas: reemplazados por recálculo obligatorio.
- Health solo `/api/health`: reemplazado por contrato ADR-012 con liveness y readiness.
- Ausencia de Cognito/BFF/RLS/ADR-014: ya no es decisión abierta; es implementación pendiente de decisiones aprobadas.
