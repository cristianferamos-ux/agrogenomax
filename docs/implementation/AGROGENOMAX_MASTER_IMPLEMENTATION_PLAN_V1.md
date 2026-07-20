# AgroGenomaX Master Implementation Plan V1

- **Estado**: Aprobado para ejecución controlada
- **Fecha**: 2026-07-18
- **Responsables**: Equipo técnico AgroGenomaX / CRH Soluciones Integrales S.A.S.
- **Repositorio**: `agx-home-precomercial`
- **Rama base**: `feature/home-precomercial-v2-post-merge` (rama actual del working tree al momento de crear este plan — verificar antes de abrir cada lote que sigue siendo la rama base vigente, o la que el equipo designe formalmente como base de integración)
- **Commit de referencia**: `26ca461` (`fix(catastrox): remove silent mock fallback`) — HEAD del repositorio al momento de crear este plan; corresponde al Lote 1, ya ejecutado y aprobado, documentado en §22

## Estado vigente del plan

- Los ADR-001 a ADR-014 ya están aceptados y comprometidos.
- El TAH 1.1 y el plan AWS Fase 0 versión 1.1 están alineados con esa base normativa.
- Este plan sigue vigente como secuencia de implementación y registro operativo de ejecución.
- Algunos lotes iniciales ya fueron ejecutados antes de incorporar este archivo al repositorio.
- El registro de lotes y las secciones de estado vigente prevalecen sobre descripciones históricas redactadas antes de la ejecución de esos lotes.
- Commit documental ADR más reciente incorporado como referencia normativa: `99e9378 docs(adr): finalize platform health commerce and environment decisions`.

## 1. Objetivo

Transformar las decisiones ya aceptadas en ADR-001 a ADR-014 en una secuencia de **lotes de implementación pequeños, verificables, reversibles y ejecutables de forma aislada por Codex**, sustituyendo cualquier instrucción masiva ("implementar todos los ADR") por unidades de trabajo con alcance cerrado, precondiciones explícitas, criterios de aceptación verificables y un mecanismo de rollback documentado antes de que exista una sola línea de código nueva.

## 2. Alcance

Este documento es **exclusivamente un plan** — no implementa nada por sí mismo. Cubre la totalidad de las decisiones de ADR-001 a ADR-014 (arquitectura AWS inicial, fuente de verdad de Ganadería, IaC, separación demo/producción como principio, autenticación por niveles, migración geoespacial condicionada, mecanismo de autenticación, modelo multicliente, patrón de sesión BFF, estado remoto de Terraform, plataforma ECS Express Mode, health checks, clasificación de rutas y entregables de CatastroX, y el mecanismo técnico definitivo de separación demo/staging/producción), organizadas en 11 fases (Fase 0 a Fase 10) y descompuestas en lotes. Este plan no crea código, no ejecuta builds, no se conecta a servicios externos y no modifica ningún ADR — es la bisagra entre la documentación ya aceptada y el trabajo de implementación que Codex ejecutará lote por lote en tareas futuras, cada una fuera del alcance de esta tarea documental.

## 3. Principios de ejecución

1. **Ningún lote es masivo.** Cada uno tiene un objetivo cerrado, verificable en una sola sesión de revisión.
2. **Ningún lote avanza automáticamente al siguiente.** Cada transición de estado requiere los *gates* de §9, incluida aprobación explícita del usuario.
3. **Ningún lote toca archivos fuera de su lista explícita de "archivos permitidos".**
4. **Ningún commit usa `git add .` ni `git add -A`.** El *staging* es siempre selectivo, archivo por archivo, verificado con `git diff --cached` antes de commitear (§6/§ reglas de Git).
5. **Ningún lote se considera completo sin pruebas que lo respalden**, ejecutadas y revisadas — no solo escritas.
6. **Todo lote tiene un rollback documentado antes de implementarse**, no diseñado después de un incidente.
7. **Los cambios preexistentes del árbol de trabajo, ajenos a este plan, nunca se tocan, limpian, revierten ni se atribuyen a ningún lote** — se documentan como parte del *baseline* de Fase 0 y se dejan intactos.
8. **Ningún recurso de AWS productivo se crea antes de superar los *gates* de ADR-011/012/013/014** (Fase 10) — Fase 4 aprovisiona exclusivamente staging.
9. **Ninguna migración productiva se ejecuta desde un proceso o credencial de staging/demo** (ADR-014 §27).
10. **La secuencia de lotes respeta dependencias reales, no el orden temático de las fases** — un lote de una fase posterior puede ejecutarse antes que uno de una fase anterior si su dependencia técnica lo exige (documentado explícitamente en §5/§21 cuando ocurra).

## 4. Estado actual verificado

*(Registro documental vigente basado en los lotes y commits ya incorporados al historial. Las frases históricas anteriores a esos commits no deben leerse como estado actual.)*

### Correcciones ya implementadas

- **Fallback mock silencioso de CatastroX eliminado**: `26ca461 fix(catastrox): remove silent mock fallback`.
- **`APP_ENV` con validación *fail-fast***: `28fda51 feat(config): add APP_ENV fail-fast validation`.
- **Overrides de API parcialmente restringidos por ambiente**: `f3cb189 fix(config): restrict API overrides by environment`. La restricción principal por ambiente y hostname local está implementada; limpieza activa de valores persistidos en `localStorage` y telemetría/evento de seguridad siguen pendientes de verificación o implementación.
- **CORS y relays endurecidos**: `e857db5 fix(security): enforce CORS allowlists and secure relays`; `649c6d6 fix(security): remove wildcard CORS from static functions`.
- **Liveness backend**: `ddca06c feat(health): add backend liveness endpoint`.
- **Relay real de liveness**: `1868f72 feat(health): proxy backend liveness through Cloudflare`.
- **Readiness por dominio**: `902b4e0 feat(health): add domain readiness checks`. Readiness general y por dominio (Ganadería y CatastroX independientes) protegida mediante `HEALTH_MONITOR_TOKEN`; la ruta heredada `/api/health/db` quedó protegida por el mismo token pero aún no fue retirada; 377 de 377 pruebas backend aprobadas.
- **Graceful shutdown**: `783cddd feat(lifecycle): add graceful shutdown`.
- **Ganadería cuenta real/demo**: `81c647e feat(ganaderia): restore real account flow and enhance demo`.
- **Workflow limpio parcial de CatastroX para Caquetá**: `2a017e0 feat(catastrox): add clean Caqueta import workflow`.

### Pendientes reales

- Retiro de la ruta heredada `/api/health/db` (protegida por `HEALTH_MONITOR_TOKEN`, aún no retirada).
- Sanitización global de `error.message`.
- *Logging* estructurado.
- *Correlation ID*.
- `Dockerfile`/`.dockerignore`.
- Terraform, ECR, ECS y RDS de staging.
- Cognito/BFF/CSRF.
- DDL multicliente/RLS.
- CatastroX `orders`/`payments`/`entitlements`/`artifacts`.
- Despliegue independiente `demo.agrogenomax.com`.
- Implementación integral de las siete barreras de ADR-014.
- Migración geoespacial completa y gate ADR-006.

### Precisiones de estado

- Las afirmaciones históricas sobre `APP_ENV` no leído, overrides sin restricción, CORS abierto/reflejado como estado actual, health estático de Cloudflare, ausencia de liveness, ausencia de *readiness* por dominio y ausencia de `SIGTERM`/*graceful shutdown* quedaron superadas por los commits registrados arriba.
- Para ADR-006 ya existe un workflow limpio parcial/versionado para Caquetá; aún faltan import integral controlado, manifiestos, hashes, conteos, resolución formal de EPSG:9377 y validación reproducible en PostGIS destino. ADR-006 no está cerrado.
- **`ganaderiaMockData.js`** y las rutas reales de Ganadería requieren verificación específica antes de declarar completado LOTE-011 o LOTE-012.
- **Sin Terraform, sin estado remoto aplicado, sin recursos AWS desplegados** (ADR-003/ADR-010/ADR-011) — pendiente (Fase 4).
- **Sin Cognito implementado** — pendiente (Fase 5).
- **Sin tablas de órdenes/pagos/entitlements/artifacts** — pendiente (Fase 7).
- **Sin `demo.agrogenomax.com`** — pendiente (Fase 8).

## 5. Dependencias entre ADR

| ADR | Depende de | Habilita |
|---|---|---|
| ADR-001 | — | Todo lo demás (arquitectura base) |
| ADR-002 | ADR-001 | ADR-008 (RLS sobre `agx`) |
| ADR-003 | ADR-001 | ADR-010, toda infraestructura Terraform |
| ADR-004 | — (principio) | ADR-014 (mecanismo técnico) |
| ADR-005 | ADR-001 | ADR-007 (mecanismo concreto) |
| ADR-006 | — | Fase 9 (migración geoespacial); condiciona cuándo CatastroX puede declararse "migrado" |
| ADR-007 | ADR-005 | ADR-008, ADR-009 |
| ADR-008 | ADR-002, ADR-007 | Fase 6 (multicliente/RLS) |
| ADR-009 | ADR-007 | Fase 5 (BFF/cookies) |
| ADR-010 | ADR-003 | Fase 4 (Terraform aplicado) |
| ADR-011 | ADR-001, ADR-003, ADR-010 | Fase 3 (contenedorización), Fase 4 (staging AWS) |
| ADR-012 | ADR-011 | Lotes 5-10 (health/readiness/shutdown/observabilidad) |
| ADR-013 | ADR-007, ADR-008, ADR-009, ADR-011, ADR-012 | Fase 7 (CatastroX transaccional) |
| ADR-014 | ADR-004, ADR-008, ADR-011, ADR-012, ADR-013 | Fase 8 (separación de ambientes); es el ADR más dependiente de todos los anteriores |

**Consecuencia directa para la secuencia de lotes**: `APP_ENV`/configuración central (ADR-014 §13) es, en términos de dependencia técnica real, un prerrequisito de casi cualquier otro lote de corrección (incluida la restricción de `agx_api_url`, el CORS por ambiente, y cualquier trabajo de Fase 4 en adelante) — por eso este plan lo ejecuta como **Lote 2**, inmediatamente después del Lote 1 ya completado, aunque temáticamente pertenezca a la Fase 2 ("Configuración, errores y observabilidad"). Esta es la única inversión de orden fase-tema vs. orden de ejecución en los primeros 15 lotes, y queda documentada explícitamente aquí y en §21.

## 6. Estrategia de ramas y commits

- **Una rama por lote**: `lote/<id>-<slug-corto>` (por ejemplo, `lote/003-restriccion-agx-api-url`), creada desde la rama base vigente.
- **Un commit por lote como regla general**; si el lote requiere más de un commit por claridad de revisión, cada commit debe seguir siendo atómico y revisable de forma independiente — nunca un commit que mezcle el objetivo del lote con cambios no relacionados.
- **`git add` siempre selectivo, por ruta explícita** (`git add <archivo1> <archivo2>`) — **nunca `git add .` ni `git add -A`**, sin excepción, en ningún lote de este plan.
- **`git diff --cached` revisado antes de cada commit**, confirmando que el conjunto en *stage* coincide exactamente con la lista de "archivos permitidos" del lote — ningún archivo ajeno al lote entra al *staging area*.
- **`git status --short` revisado antes y después de cada operación**, para confirmar que los archivos preexistentes ajenos (documentados en el *baseline* de Fase 0, §10) permanecen exactamente en el mismo estado.
- **Mensaje de commit**: formato `tipo(ámbito): descripción corta`, coherente con el estilo ya usado en el historial (`fix(catastrox): ...`, `feat(catastrox): ...`), con el ID del lote referenciado en el cuerpo del mensaje.
- **Sin `push` sin aprobación explícita del usuario** — cada lote se detiene después del commit local hasta recibir esa aprobación (§9).
- **Sin `git reset`, `git restore`, `git checkout --`, `git clean` ni `git stash`** sobre archivos que no pertenezcan al propio lote en ejecución — y nunca sobre el *baseline* de cambios preexistentes ajenos.
- **Manejo de `index.lock`**: si un proceso anterior dejó `.git/index.lock` (por ejemplo, tras una interrupción), **no se elimina automáticamente** — se reporta al usuario y se espera confirmación de que ningún proceso Git sigue en ejecución antes de continuar.
- **Verificación de *staged* exacto**: antes de cada commit, `git diff --cached --name-only` debe devolver **exactamente** la lista de archivos del lote — ni uno más, ni uno menos.
- **Worktrees y permisos**: cada lote se ejecuta sobre el árbol de trabajo principal salvo que el equipo decida explícitamente usar un *worktree* aislado para un lote de alto riesgo (por ejemplo, Fase 9, migración geoespacial) — decisión caso por caso, no una regla general de este plan.
- ***Baseline* inicial y final**: cada lote registra el resultado de `git status --short` **antes** de empezar y **después** de terminar, adjuntado como evidencia (§ definición de lote), para poder demostrar que la única diferencia entre ambos *snapshots* es el propio trabajo del lote.

## 7. Estrategia de pruebas

- **Ningún lote se marca `Completado` sin pruebas ejecutadas y en estado *pass*.**
- **Suite de regresión ya existente** (`npm run catastrox:regression`, `npm run test:catastrox-semantic`, `npm run test:catastrox-geometry`, y cualquier prueba unitaria en `__tests__/` ya presente en `server/routes/`, `server/services/catastrox/`, `src/modules/catastrox/utils/`) **debe seguir pasando después de cada lote** que toque un archivo relacionado, incluso si el lote no las modifica directamente — regresión, no solo prueba nueva.
- **Cada lote agrega pruebas específicas de su propio objetivo**, nunca solo modifica código de producción sin cobertura — coherente con el estándar ya fijado por el Lote 1 (5 pruebas para el retiro del *fallback* mock).
- **Pruebas negativas obligatorias** en lotes de seguridad/aislamiento (por ejemplo, Fase 6 multicliente: un usuario de la organización A no debe poder leer datos de la organización B; Fase 8: una solicitud con `Origin: demo.agrogenomax.com` debe ser rechazada por el backend de producción).
- **Pruebas de *rollback*** en lotes que lo requieran por su riesgo (Fase 4 en adelante): confirmar que revertir el cambio deja el sistema en el estado anterior verificable, no solo que el *rollback* "corre sin error".
- **Ninguna prueba se ejecuta contra un ambiente productivo** — todas corren localmente o, a partir de Fase 4, contra staging.

## 8. Estrategia de rollback

- **Nivel código**: `git revert` del commit aislado del lote — posible precisamente porque cada lote es un commit atómico y autocontenible (§6).
- **Nivel configuración/infraestructura (Fase 4+)**: *rollback* por *digest* inmutable de la imagen de contenedor (ADR-011 §24), nunca por edición manual de un recurso ya desplegado.
- **Nivel base de datos (Fase 6/7/9)**: *rollback* de migración siguiendo el principio *expand-and-contract* ya fijado por ADR-012 §20/ADR-013 §20 — ninguna migración de contracción se aplica hasta confirmar que la fase expandida es segura de revertir.
- **Nivel demo/staging (Fase 8)**: dado que demo no tiene persistencia de servidor (ADR-014 §7), su "rollback" es trivial — revertir el *deployment* de Cloudflare Pages a la versión anterior.
- **Nivel producción (Fase 10)**: *rollback* de tráfico hacia Railway como plataforma de contingencia ya aprobada (ADR-011 §18/ADR-014 §25), nunca hacia un recurso etiquetado demo/staging (ADR-014 §25, regla absoluta).
- **Cada lote documenta su propio rollback en el campo correspondiente de su definición** (§ definición de lote) — no se diseña de forma genérica y se asume aplicable a todos, dado que el mecanismo correcto difiere según si el lote toca solo código de aplicación, configuración, infraestructura o datos.

## 9. Gates de aprobación

**Ninguna fase, y ningún lote dentro de una fase, avanza sin cumplir, en este orden**:

1. **Pruebas aprobadas** — ejecutadas, en estado *pass*, revisadas por el equipo (no solo "el CI está verde" sin revisión humana del contenido de las pruebas).
2. **Revisión del *diff*** — cada línea cambiada revisada contra el objetivo declarado del lote, confirmando que no hay cambios fuera de alcance.
3. **Staged selectivo confirmado** — `git diff --cached --name-only` coincide exactamente con la lista de archivos permitidos del lote.
4. **Commit aislado** — un commit (o una serie corta de commits atómicos) que representa únicamente el trabajo del lote.
5. **Rollback documentado** — no como una idea general, sino como el procedimiento específico aplicable a ese lote, ya escrito antes de que el lote se declare `Completado`.
6. **Confirmación de ausencia de archivos ajenos** — `git status --short` comparado contra el *baseline* de Fase 0 (§10), confirmando que ningún cambio preexistente fue tocado, limpiado o incluido.
7. **Aprobación del usuario** — explícita, por cada lote, antes de considerar el lote `Aprobado`/`Completado` y antes de cualquier `push`.

**No existe avance automático entre lotes** — el estado `Completado` de un lote no dispara, por sí mismo, el inicio del siguiente; cada lote requiere una instrucción explícita del usuario para comenzar.

## 10. Fase 0 — Baseline y control del repositorio

**Objetivo**: establecer, antes de tocar cualquier código, un inventario exacto y verificable del estado del repositorio, para que cualquier lote posterior pueda demostrarse aislado de lo que ya existía.

**Contenido de esta fase** (ejecutable como una revisión, no como un lote de código — no modifica archivos):

- **Inventario histórico del estado Git**: `git status --short` completo, capturado como evidencia de referencia al momento de crear el plan — ese listado es un *snapshot* histórico, no representa el estado Git vigente y no debe usarse como *baseline* actual. Incluía (sin limitarse a) modificaciones en `.env.example`, `docs/catastrox/CATASTROX_RESOLVER_SHADOW_MODE_V1.md`, `public/manifest.webmanifest`, `server/index.js`, pruebas de `catastroxResolverShadow`, `src/App.jsx`, múltiples archivos de `src/modules/ganaderia/`, y numerosos archivos sin seguimiento (`.agents/`, `.claude/`, `AGENTS.md`, `CLAUDE.md`, `docs/architecture/`, `docs/adr/` — este último ya contenía los ADR-001 a ADR-014 y este propio plan —, `server/sql/`, assets de `src/assets/`, entre otros).
- **Identificación de cambios preexistentes**: cada entrada del inventario anterior se clasifica como "ajena a este plan" — **ninguna acción de ningún lote la modifica, limpia, restaura, elimina ni le hace `reset`, `stash` o `checkout`**, salvo que un lote específico declare explícitamente esa ruta exacta como uno de sus "archivos permitidos" (por ejemplo, si un lote futuro decide finalmente completar el trabajo ya en curso sobre `src/modules/ganaderia/pages/GanaderiaDemo.jsx`, debe declararlo explícitamente y coordinarse con el estado ya modificado, nunca sobrescribirlo a ciegas).
- **Definición de ramas**: convención `lote/<id>-<slug>` (§6).
- **Commits selectivos**: regla ya fijada en §6, reiterada aquí como parte del control de Fase 0.
- **Prohibición de `git add .`**: regla absoluta, sin excepción, para todos los lotes de este plan.
- ***Baseline* de pruebas**: antes del primer lote de código (Lote 3 en adelante, dado que Lote 1 ya está completado y Lote 2 es predominantemente configuración), se registra qué *suites* de prueba existen y pasan hoy (`npm run catastrox:regression`, `npm run test:catastrox-semantic`, `npm run test:catastrox-geometry`) como línea base contra la cual comparar después de cada lote — **esta ejecución de *baseline* no se realiza como parte de esta tarea documental**, queda como la primera acción del primer lote de código.
- **Control de archivos temporales/*logs***: se identifican `backend-3002-runtime.log`, `frontend-5174-runtime.log`, `vite.5175.temp.config.mjs` (ya presentes, sin seguimiento) como candidatos a `.gitignore` — **no se modifican ni se añaden a `.gitignore` en esta tarea**, se registra como acción de un lote de higiene futuro (fuera de los primeros 15 lotes detallados, §24).
- **Archivos que deberían entrar a `.gitignore`** (identificados, no modificados en esta tarea): `*.log` en la raíz del proyecto (patrón para `backend-3002-runtime.log`/`frontend-5174-runtime.log`); archivos `vite.*.temp.config.mjs`; se recomienda evaluar, como decisión de seguimiento no ejecutada aquí, si `.env.production` (hoy trackeado sin secretos, ADR-014 §3.4) debería migrar a un patrón ignorado con un `.env.production.example` equivalente.
- **No limpiar cambios sin autorización**: regla absoluta — cualquier limpieza de los archivos ya modificados/sin seguimiento identificados en esta fase requiere una instrucción explícita y específica del usuario, nunca una inferencia de que "probablemente son basura de una sesión anterior".

## 11. Fase 1 — Correcciones críticas sin infraestructura

**Objetivo**: cerrar los hallazgos de seguridad/arquitectura ya identificados por ADR-013/ADR-014 que no requieren ninguna infraestructura nueva — solo cambios de código en el repositorio ya existente.

**Lotes completados de esta fase, documentados en §22**: LOTE-001 (`26ca461`) y LOTE-004 (`e857db5`, `649c6d6`). LOTE-003 queda reclasificado como PARCIAL.

**Lotes abiertos de esta fase**: LOTE-003 conserva remanentes no bloqueantes para readiness pero obligatorios antes de cerrar integralmente ADR-014; LOTE-011 requiere auditoría final; LOTE-012 queda pendiente de verificación. El módulo `APP_ENV` (LOTE-002), aunque temáticamente de Fase 2, ya fue ejecutado tempranamente por ser prerrequisito técnico de LOTE-003 (§5).

## 12. Fase 2 — Configuración, errores y observabilidad

**Objetivo**: construir el módulo central de configuración (`APP_ENV` y validación *fail-fast*), la clasificación de errores, el *correlation ID*, el *logging* estructurado, la disciplina `no-store`, y los primitivos de *health*/*readiness*/*liveness* que ADR-012 exige antes de que exista cualquier infraestructura real que los consuma (el *target group* del ALB de Fase 4 necesita `GET /api/health/live` ya implementado y probado).

**Estado vigente de lotes de esta fase**: LOTE-002, LOTE-005, LOTE-006, LOTE-007, LOTE-008 y LOTE-009 están completados; LOTE-010 sigue pendiente; LOTE-013 permanece pendiente como auditoría de seguridad.

## 13. Fase 3 — Contenedorización

**Objetivo**: producir un `Dockerfile` reproducible del backend, ejecutable localmente, con *health check* de contenedor evaluado (no adoptado como obligatorio salvo necesidad demostrada, ADR-012 §9), señales `SIGTERM` manejadas (dependiente del *graceful shutdown* de Lote 8), usuario no root, y una imagen identificable por *digest* — sin desplegar a ningún registro ni servicio en la nube todavía.

**Estado vigente**: Fase 3 está bloqueada hasta ejecutar LOTE-014 (LOTE-009 ya cerrado, commit `6ba3056`). El lote incluido en los primeros 15 es `Dockerfile` + `.dockerignore` (LOTE-014, pendiente).

**Lotes adicionales de esta fase, no detallados en los primeros 15** (registrados como pendientes, §24): ejecución local del contenedor con `docker run`/*compose* de desarrollo; validación de que el contenedor respeta las señales de parada; publicación reproducible del *digest* (sin subir a ECR todavía, dado que ECR es Fase 4).

## 14. Fase 4 — Terraform y staging AWS

**Objetivo**: aprovisionar **exclusivamente staging** — nunca producción en esta fase (ADR-014 §24.B) — con estado remoto de Terraform (ADR-010), OIDC (ADR-003), ECR, ECS Express Mode + ALB (ADR-011), **dos planos de datos separados** (`agx-staging` y `postgis-catastrox-staging`, ADR-014 §7/§8, nunca fusionados), Secrets Manager, CloudWatch, el dominio `staging.agrogenomax.com` (`noindex`, acceso restringido, ADR-014 §12), con revisión de costo y presupuesto en cada paso, y manteniendo Railway como rollback disponible durante toda la fase.

**Estado vigente**: Fase 4 no ha iniciado; no se ha ejecutado ningún `terraform apply` ni se ha creado ningún recurso AWS. El primer lote de esta fase incluido en los primeros 15 es la matriz de configuración de staging (LOTE-015), todavía pendiente.

**Lotes adicionales de esta fase, no detallados en los primeros 15** (registrados como pendientes, §24, cada uno requerirá su propia definición completa de lote antes de ejecutarse): módulo Terraform de estado remoto + *locking*; módulo de rol OIDC de CI/CD; módulo ECR; módulo ECS Express Mode + ALB de staging; módulo RDS `agx-staging`; módulo/instancia `postgis-catastrox-staging` (plano separado); módulo Secrets Manager de staging; configuración de CloudWatch de staging; configuración de dominio `staging.agrogenomax.com` en Cloudflare; validación del gate de staging ya exigido por ADR-011 §14.1/§19.1.

## 15. Fase 5 — Cognito, BFF y sesiones

**Objetivo**: aprovisionar el User Pool de Cognito de **staging** (nunca producción en esta fase), App Client con *Callback*/*Logout URLs* restringidas al dominio de staging, implementar el patrón BFF (ADR-009): cookies `HttpOnly`/`Secure`/`SameSite` apropiado, protección CSRF, sesiones referenciadas en el plano `agx-staging` (nunca en memoria del proceso), *logout*, recuperación de contraseña (flujo de fábrica de Cognito), evaluación de MFA, con pruebas de que una sesión de staging nunca es aceptada fuera de ese ambiente.

**Lotes de esta fase** (no detallados en los primeros 15, registrados como pendientes en §24): User Pool + App Client de staging; middleware BFF de sesión; emisión/validación de cookie de sesión; endpoint de *logout*; pruebas de aislamiento de sesión entre ambientes.

## 16. Fase 6 — Multicliente y RLS

**Objetivo**: implementar el modelo de organizaciones/membresías de ADR-008 sobre `agx-staging`: tablas de organización/membresía/rol, resolución de organización activa por solicitud, políticas RLS efectivas (con las condiciones vinculantes de aislamiento transaccional y de privilegios de rol de PostgreSQL ya exigidas por ADR-008 §14), usuarios de base de datos con privilegios mínimos, y pruebas negativas explícitas (cliente A nunca lee datos de cliente B).

**Lotes de esta fase** (no detallados en los primeros 15, pendientes en §24): esquema de organizaciones/membresías; políticas RLS; resolución de organización en middleware; auditoría de acceso interno temporal/justificado (ADR-007 §8.1); suite de pruebas negativas de aislamiento multicliente.

## 17. Fase 7 — CatastroX transaccional

**Objetivo**: implementar sobre `agx-staging` el sistema completo de ADR-013: catálogo *server-side* (`product`/`price_snapshot`, exclusivamente `basico`/`plus`/`profesional`), `customer`, `order`, `order_item`, `payment_attempt`, `payment_event`, `entitlement`, `artifact` (con generación automática de todos los formatos obligatorios al confirmarse el pago, ADR-013 §13), token de intercambio de un solo uso + cookie de acceso (ADR-013 §15/§16), verificación de pago como `POST` idempotente contra Wompi sandbox (ADR-013 §14), descarga autorizada de artifacts, Regularización Predial CRH como `professional_service_lead` fuera del catálogo transaccional (ADR-013 §12.2), y el retiro de `localStorage` como fuente de "derecho de compra" — sustituido por el entitlement verificado *server-side*.

**Lotes de esta fase** (no detallados en los primeros 15, pendientes en §24): esquema de entidades transaccionales; endpoint `POST /orders`; endpoint `POST /orders/:id/checkout`; endpoint `POST /orders/:id/payment-verifications`; generación automática de artifacts; endpoint `GET /orders/:id/result`; endpoint `GET /orders/:id/artifacts/:artifactId`; mecanismo de intercambio + cookie; migración del frontend para dejar de depender de `catastrox_purchases_v2`; deprecación y retiro de `GET /lookups/:lookupId/full-result` (ADR-013 §6.1); pruebas completas del flujo de extremo a extremo contra Wompi sandbox.

## 18. Fase 8 — Separación demo/staging/producción

**Objetivo**: implementar el mecanismo técnico completo de ADR-014: creación de `demo.agrogenomax.com` como *deployment* de Cloudflare Pages independiente; confirmación de que el *bundle* de demo no contiene clientes API productivos (Barrera 1); ausencia de relay `/api/*` en ese *deployment* (Barrera 2); CSP `connect-src 'self'` restrictiva (Barrera 3); migración del contenido de `/ganaderia/demo` hacia el nuevo origen, con redirecciones temporales; diseño (no obligatoriamente implementación completa en esta fase) de una demo explícita de CatastroX con fixtures, marcada "MUESTRA"; cookies separadas por ambiente; Cognito separado (ya cubierto por Fase 5, reafirmado aquí para demo = ninguno); `noindex` de staging; validación de que staging/producción rechazan el origen de demo (Barrera 4); y el control de CI de escaneo del *bundle* de demo (Barrera 6) como parte de esta fase, no como una promesa indefinida.

**Lotes de esta fase** (no detallados en los primeros 15, pendientes en §24): *deployment* `demo.agrogenomax.com`; extracción de `GanaderiaDemo.jsx`/`ganaderiaDemoData.js` hacia el *bundle* de demo; configuración de CSP de demo; configuración de CORS de staging/producción excluyendo demo; control de CI de escaneo del *bundle* (Barrera 6); redirecciones temporales de `/ganaderia/demo`; pruebas de aislamiento *cross-origin* (Barrera 4 verificada activamente, no solo documentada).

## 19. Fase 9 — Migración geoespacial

**Objetivo**: completar el gate ADR-006 antes de migrar CatastroX. Ya existe un workflow limpio parcial/versionado para Caquetá, pero esta fase no inicia como migración aprobada hasta validar el import integral controlado, manifiestos, *hashes*, conteos, resolución formal de EPSG:9377 y validación reproducible en PostGIS destino. Incluye comparación de resultados entre la fuente actual y la nueva antes de cualquier corte; y, solo al final, autorización explícita para que producción migre su fuente geoespacial — **nunca antes**.

**Lotes de esta fase** (no detallados en los primeros 15, pendientes en §24, cada uno bloqueado hasta que ADR-006 se declare satisfecho): DDL versionado; *scripts* de importación reproducibles; manifiesto y *hashes*; tratamiento de SRID; importación a staging; consultas de validación; comparación de resultados staging vs. fuente actual; documento de autorización para producción (Fase 10 lo consume, no lo ejecuta por sí mismo).

## 20. Fase 10 — Gate de producción

**Objetivo**: el único punto del plan donde se autoriza crear infraestructura **productiva** — condicionado a haber superado, de forma verificable y documentada, los *gates* de ADR-011 (§14.1/§19.1), ADR-012 (health/readiness reales en staging), ADR-013 (flujo transaccional completo en staging con Wompi sandbox) y ADR-014 (las siete barreras de demo operando, planos de datos separados verificados). Incluye: revisión de costos y aprobación explícita (no una formalidad, una decisión real del negocio); recursos productivos (RDS `agx-production`, `postgis-catastrox-production` solo si ADR-006 ya se cumplió, ECS/ALB de producción); Cognito de producción; Wompi productivo (llaves nuevas, hoy inexistentes); backups configurados; alarmas configuradas; pruebas de carga; pruebas de seguridad (incluida una revisión dedicada de inyección SQL en `catastrox.js`/`catastroxPayments.js`, ya señalada como acción de seguimiento en ADR-013 §22/§31); plan de *rollback* de producción verificado (hacia Railway-producción, nunca hacia demo/staging, ADR-014 §25); corte de tráfico gradual y observado; y, como acción final de todo el plan, el retiro planificado de Railway como plataforma de producción, una vez que ECS de producción esté validado de forma sostenida.

**Lotes de esta fase**: no detallados en los primeros 15 de este plan — su diseño detallado es, en sí mismo, una acción de seguimiento posterior a que Fases 4-9 estén completas y aprobadas, dado que su contenido exacto depende de lo que esas fases hayan producido realmente.

## 21. Matriz ADR → fase → lote

| ADR | Fase(s) principal(es) | Lotes de los primeros 15 que lo implementan |
|---|---|---|
| ADR-001 | Todas (base) | — (arquitectura ya vigente, ningún lote la crea desde cero) |
| ADR-002 | Fase 6 | — (fuente de verdad ya establecida en código; RLS se implementa en Fase 6) |
| ADR-003 | Fase 4 | — |
| ADR-004 | Fase 1, Fase 8 | Lote 1 (completado) |
| ADR-005 | Fase 1 | — (clasificación ya documentada; aplicación de niveles concreta en Fase 5/6) |
| ADR-006 | Fase 9 | — (bloqueada hasta cumplimiento) |
| ADR-007 | Fase 5 | — |
| ADR-008 | Fase 6 | — |
| ADR-009 | Fase 5 | — |
| ADR-010 | Fase 4 | — |
| ADR-011 | Fase 3, Fase 4 | Lote 14 (Dockerfile) |
| ADR-012 | Fase 2 | Lotes 5, 6, 7, 8 y 9 completados; Lote 10 pendiente |
| ADR-013 | Fase 7 | — (primeros 15 lotes son prerrequisitos de plataforma; Fase 7 en sí no está entre los primeros 15) |
| ADR-014 | Fase 1, Fase 8 | Lotes 2, 3, 4, 11, 12, 15 |

**Nota de lectura**: los primeros 15 lotes de este plan son deliberadamente **prerrequisitos de plataforma** (configuración, salud, seguridad de red, higiene de código, contenedorización) — ningún ADR que dependa de infraestructura desplegada (ADR-007/008/009/010/011-parcial/013 en su forma completa) puede tener un lote completamente ejecutado todavía; sus lotes de Fase 4 en adelante quedan diseñados a nivel de fase (§14-§20) y se detallarán lote por lote cuando corresponda avanzar a ellas, conforme al principio de "ningún avance automático" (§9).

## 22. Registro de lotes ejecutados

| Lote | Estado | Commit(s) | Observación |
|---|---|---|---|
| LOTE-001 | COMPLETADO | `26ca461` | Fallback mock silencioso de CatastroX eliminado. |
| LOTE-002 | COMPLETADO | `28fda51` | `APP_ENV` con validación *fail-fast*. |
| LOTE-003 | PARCIAL | `f3cb189` | Implementó la restricción del override por ambiente y hostname local; siguen pendientes limpieza activa de `localStorage` y telemetría/evento de seguridad fuera de `development`. |
| LOTE-004 | COMPLETADO | `e857db5`, `649c6d6` | CORS y relays endurecidos; wildcard CORS retirado de Functions estáticas. |
| LOTE-005 | COMPLETADO | `ddca06c` | Liveness backend implementado. |
| LOTE-006 | COMPLETADO | `1868f72` | Relay real de liveness vía Cloudflare. |
| LOTE-007 | COMPLETADO | `902b4e0` | Readiness protegida general y por dominio (Ganadería y CatastroX independientes) implementada con `HEALTH_MONITOR_TOKEN`; ruta heredada `/api/health/db` queda protegida por el mismo token pero aún no retirada; 377 de 377 pruebas backend aprobadas. |
| LOTE-008 | COMPLETADO | `783cddd` | Graceful shutdown implementado. |
| LOTE-009 | COMPLETADO | `6ba3056` | `Cache-Control: no-store` en `notFound` y en las respuestas de `errorHandler`; `status`/`statusCode` normalizado a enteros 400-599; mensajes controlados 4xx conservados; mensajes 5xx sanitizados a "Error interno del servidor"; log mínimo sin `error.message`, `stack`, `error.name`, SQL, tokens ni credenciales; `headersSent` delegado a `next`; 15/15 pruebas específicas y 392/392 pruebas backend. |
| LOTE-010 | PENDIENTE | — | *Logging* estructurado/*correlation ID*. |
| LOTE-011 | REQUIERE AUDITORÍA FINAL | `81c647e` | Restauró cuenta real/demo; todavía debe verificarse específicamente que ninguna ruta real muestre cifras de relleno. |
| LOTE-012 | PENDIENTE DE VERIFICACIÓN | — | No afirmar retiro de `ganaderiaMockData.js` sin comprobarlo. |
| LOTE-013 | PENDIENTE | — | Auditoría SQL/entropía de `lookupId`. |
| LOTE-014 | PENDIENTE | — | `Dockerfile`/`.dockerignore`. |
| LOTE-015 | PENDIENTE | — | Matriz documental de staging. |

## 23. Riesgos críticos

| Riesgo | Origen | Tratamiento |
|---|---|---|
| Ejecutar lotes fuera de orden de dependencia (por ejemplo, Lote 3 antes que Lote 2) rompería la restricción de `agx_api_url`, que depende de `APP_ENV` | Diseño de este plan (§5) | Respetar el orden de §21/§14 estrictamente; ningún lote se abre sin confirmar que sus dependencias declaradas ya están `Completado` |
| Confundir un cambio preexistente ajeno (por ejemplo, el trabajo ya en curso sobre `GanaderiaDemo.jsx`, visible en `git status --short`) con el alcance de un lote de este plan | Estado real del repositorio al momento de crear este plan (§4/§10) | Cada lote declara explícitamente sus "archivos permitidos"; si coincide con un archivo ya modificado, el lote debe coordinarse explícitamente con ese estado, nunca sobrescribirlo sin revisión |
| Avanzar a Fase 4 (staging AWS) sin que los lotes de Fase 2/3 (health, *readiness*, *graceful shutdown*, Dockerfile) estén completos, dejando un contenedor sin salud verificable desplegado en ECS | Dependencia técnica real entre ADR-012 y ADR-011 | Gate explícito: Fase 4 no inicia sin Lotes 5-10 y 14 completados |
| Crear infraestructura productiva antes de superar los *gates* de Fase 10 | Presión operativa/comercial | Prohibición absoluta ya fijada por ADR-014 §24.B, reiterada como regla de este plan (§3, punto 8) |
| Migrar la fuente geoespacial de producción antes de que ADR-006 esté formalmente satisfecho | Presión de "ya tenemos staging funcionando, migremos todo" | Fase 9 bloqueada explícitamente hasta cumplimiento verificado de ADR-006, sin excepción por conveniencia operativa |
| Ejecutar un lote sin sus pruebas correspondientes, marcándolo `Completado` por presión de tiempo | Riesgo humano/operativo | *Gate* 1 de §9 es innegociable — sin pruebas *pass*, no hay `Completado` |

## 24. Trabajo fuera de alcance

- Implementación real de nuevos lotes pendientes — este documento actualiza el registro, pero no autoriza ni ejecuta el siguiente lote.
- Diseño lote por lote de las Fases 4 a 10 más allá del primer lote de Fase 4 (Lote 15) — se detallarán cuando corresponda avanzar a ellas.
- Ejecución de la limpieza de `.gitignore`/archivos temporales identificados en Fase 0.
- Modificación de cualquiera de los commits ya registrados como completados.
- Modificación de cualquier ADR (ADR-001 a ADR-014).
- Cualquier conexión a AWS, Railway, Cloudflare, Wompi o Cognito.
- Cualquier `build`, prueba, instalación de dependencias o migración.

## 25. Criterios de cierre del plan

Este plan (como documento) se considera cerrado y vigente cuando:

- Ha sido aprobado explícitamente por el usuario en su forma actual.
- Cada lote nuevo que se ejecute en el futuro actualiza §22 (Registro de lotes ejecutados) con su resultado real.
- Ninguna fase avanza sin que sus *gates* (§9) se hayan cumplido y quede evidencia de ello.
- El plan mismo se revisa y se corrige (nunca se reescribe silenciosamente) cuando la implementación real revele que una dependencia, un riesgo o un orden de lote asumido aquí no correspondía con la realidad del código o de la infraestructura.

---

## Definición detallada de los primeros 15 lotes

*Cada lote se presenta con los 20 campos exigidos. Ningún lote de esta sección ha sido ejecutado en esta tarea — todos, salvo el Lote 1, están en estado `Pendiente`.*

### LOTE-001 — Eliminación del fallback mock silencioso de CatastroX

| Campo | Valor |
|---|---|
| ID | LOTE-001 |
| Nombre | Eliminación del fallback mock silencioso de CatastroX |
| Fase | Fase 1 |
| ADR que lo autoriza | ADR-004, ADR-013 §22/§27, ADR-014 §3.3/§21 |
| **Estado** | **Completado** |
| Estado vigente | COMPLETADO — commit `26ca461`. Implementado; no volver a ejecutar salvo corrección o regresión documentada. |
| Objetivo | Eliminar la activación silenciosa de datos mock ante errores de red/404 en `lookupPredioWithFallback()`/`resolveLookupForRoute()` |
| Precondiciones | Ninguna (primer lote del plan) |
| Archivos permitidos | `src/modules/catastrox/services/catastroxApi.js` y archivos de prueba asociados (según el propio commit) |
| Archivos prohibidos | Cualquier otro |
| Cambios exactos | Ver el *diff* real del commit `26ca461` (no reproducido aquí, fuera del alcance de esta tarea documental leerlo línea por línea) |
| Pruebas | 5 pruebas específicas, según el mensaje de commit |
| Criterio de aceptación | El *fallback* mock ya no se activa de forma silenciosa en el flujo comercial real |
| Rollback | `git revert 26ca461` (no ejecutado, ni recomendado sin razón — el commit está aprobado) |
| Riesgo | Bajo (ya validado y aceptado) |
| Tamaño | S |
| Dependencias | Ninguna |
| Tareas paralelizables | Ninguna |
| Commit esperado | `26ca461` |
| Mensaje recomendado del commit | `fix(catastrox): remove silent mock fallback` (ya usado) |
| Evidencia requerida | Commit ya existente en el historial de la rama base |

### LOTE-002 — Módulo `APP_ENV` y configuración central con fail-fast

| Campo | Valor |
|---|---|
| ID | LOTE-002 |
| Fase | Fase 2 (ejecutado tempranamente por dependencia técnica, §5) |
| ADR que lo autoriza | ADR-014 §13 |
| Estado | Completado |
| Estado vigente | COMPLETADO — commit `28fda51`. Implementado; no volver a ejecutar salvo corrección o regresión documentada. |
| Objetivo | Introducir un módulo de configuración server-side que lea `APP_ENV` (`development`/`demo`/`staging`/`production`), lo valide contra la configuración disponible (por ejemplo, que `DATABASE_URL` exista cuando corresponda), y detenga el arranque del proceso (*fail-fast*) si el ambiente no puede determinarse o la configuración es inconsistente |
| Precondiciones | Lote 1 completado |
| Archivos permitidos | Un nuevo módulo (por ejemplo `server/config/env.js`), `server/index.js` (solo el punto de arranque que lo invoca), `server/.env.example` (documentar la variable) |
| Archivos prohibidos | Cualquier ruta de negocio (`server/routes/*`), frontend, Cloudflare Functions |
| Cambios exactos | Definir el módulo de lectura/validación de `APP_ENV`; invocarlo al inicio de `server/index.js`; documentar la variable en `server/.env.example` |
| Pruebas | Prueba unitaria: arranque exitoso con `APP_ENV` válido; arranque fallido (proceso no sirve tráfico) con `APP_ENV` ausente o con valor no reconocido |
| Criterio de aceptación | El proceso no arranca (o no responde tráfico) sin `APP_ENV` válido; `NODE_ENV` confirmado como no determinante de ninguna decisión de negocio |
| Rollback | `git revert` del commit del lote — el backend vuelve a arrancar sin exigir `APP_ENV` |
| Riesgo | Medio — un error en la validación podría impedir arrancar el backend en desarrollo si no se documenta bien el valor esperado localmente |
| Tamaño | S |
| Dependencias | Lote 1 |
| Tareas paralelizables | Ninguna (bloquea Lote 3) |
| Commit esperado | `28fda51` |
| Mensaje recomendado del commit | `feat(config): add APP_ENV with fail-fast validation` |
| Evidencia requerida | Resultado de pruebas; captura de arranque fallido intencional para verificar el *fail-fast* |

### LOTE-003 — Restricción de `agx_api_url` a `development` local

| Campo | Valor |
|---|---|
| ID | LOTE-003 |
| Fase | Fase 1 |
| ADR que lo autoriza | ADR-014 §4 punto 17, §13, §21, §37 |
| Estado | Parcial |
| Estado vigente | PARCIAL — commit `f3cb189` implementó la restricción del override por ambiente y hostname local. Continúan pendientes de verificación o implementación la limpieza activa de valores persistidos en `localStorage` y la telemetría/evento de seguridad ante intentos fuera de `development`. |
| Objetivo | Restringir el *override* de URL de API (`agx_api_url`, `?agx_api_url=`, `?apiUrl=`) para que solo opere cuando `APP_ENV=development` y el *hostname* sea `localhost`/`127.0.0.1`; en cualquier otro ambiente, ignorarlo, limpiar activamente cualquier valor persistido en `localStorage`, y registrar un evento de telemetría/seguridad ante el intento |
| Precisión vigente | La restricción principal ya está implementada; la limpieza activa y la telemetría permanecen abiertas; no volver a implementar la restricción ya existente. |
| Precondiciones | Lote 2 completado (necesita `APP_ENV` disponible en el frontend, vía una variable de build equivalente o una señal expuesta por el backend) |
| Archivos permitidos | `src/modules/ganaderia/api/ganaderiaApi.js` (líneas del override, 27/33 según investigación previa), y un módulo de telemetría mínimo si no existe uno reutilizable |
| Archivos prohibidos | `catastroxApi.js` salvo que comparta el mismo mecanismo (evaluar en el propio lote si aplica extenderlo ahí; si es así, declararlo explícitamente antes de tocarlo) |
| Cambios exactos | Envolver la lectura del override en una condición que verifique ambiente + *hostname*; añadir limpieza activa de la clave de `localStorage` fuera de esa condición; añadir el evento de telemetría |
| Pruebas | Prueba unitaria: override activo en `development`+`localhost`; override ignorado y valor limpiado en cualquier otro caso simulado; evento de telemetría registrado en el intento |
| Criterio de aceptación | Ninguna URL de API proviene de *query string*/`localStorage` fuera de `development` local (ADR-014 §37) |
| Rollback | `git revert` — el override vuelve a su comportamiento sin restricción (documentado como riesgo aceptado solo durante el *rollback* de emergencia, nunca como estado deseado) |
| Riesgo | Bajo — cambio acotado a un archivo, con pruebas claras de ambas ramas de comportamiento |
| Tamaño | XS |
| Dependencias | Lote 2 |
| Tareas paralelizables | Puede prepararse en paralelo con Lote 4 (no comparten archivos) |
| Commit esperado | `f3cb189` |
| Mensaje recomendado del commit | `fix(config): restrict agx_api_url override to local development` |
| Evidencia requerida | Resultado de pruebas; *diff* acotado a los archivos declarados |

### LOTE-004 — CORS *allowlist* explícita, sin reflejo de `Origin`

| Campo | Valor |
|---|---|
| ID | LOTE-004 |
| Fase | Fase 1 |
| ADR que lo autoriza | ADR-013 §21, ADR-014 §7 Barrera 4, §12 |
| Estado | Completado |
| Estado vigente | COMPLETADO — commits `e857db5` y `649c6d6`. Implementado; no volver a ejecutar salvo corrección o regresión documentada. |
| Objetivo | Sustituir el reflejo automático de `Origin` en `functions/api/catastrox/[[path]].js` y su gemela de pagos por una *allowlist* explícita; reforzar que `server/index.js` mantiene su propia *allowlist* independiente (defensa en profundidad, ADR-014 §21) |
| Precondiciones | Lote 2 completado (para poder condicionar la *allowlist* por `APP_ENV` si se decide hacerlo configurable) |
| Archivos permitidos | `functions/api/catastrox/[[path]].js`, `functions/api/catastrox/payments/[[path]].js`, `server/index.js` (solo el bloque de CORS) |
| Archivos prohibidos | Rutas de negocio de `server/routes/catastrox.js`/`catastroxPayments.js` |
| Cambios exactos | Sustituir `request.headers.get('Origin') || '*'` por una comparación contra una lista explícita de orígenes permitidos por ambiente |
| Pruebas | Prueba de que un `Origin` no listado recibe una respuesta sin la cabecera `Access-Control-Allow-Origin` correspondiente; prueba de que un `Origin` listado sí la recibe |
| Criterio de aceptación | Ningún `Origin` arbitrario es reflejado; `demo.agrogenomax.com` explícitamente excluido de cualquier *allowlist* con credenciales (adelanto de ADR-014 §7 Barrera 4, aplicable ya en esta fase aunque el dominio de demo no exista todavía) |
| Rollback | `git revert` — vuelve al reflejo de `Origin` (riesgo ya documentado, no deseado como estado permanente) |
| Riesgo | Medio — un error en la lista podría bloquear tráfico legítimo de desarrollo/staging si no se prueba con cuidado |
| Tamaño | S |
| Dependencias | Lote 2 (opcional, puede ejecutarse con una lista estática si se prefiere no acoplarlo a `APP_ENV` todavía) |
| Tareas paralelizables | Paralelizable con Lote 3 |
| Commit esperado | `e857db5`, `649c6d6` |
| Mensaje recomendado del commit | `fix(security): replace reflected CORS Origin with explicit allowlist` |
| Evidencia requerida | Resultado de pruebas; confirmación de que las llamadas legítimas actuales (localhost, dominio de producción actual) siguen funcionando |

### LOTE-005 — `GET /api/health/live` (health de plataforma)

| Campo | Valor |
|---|---|
| ID | LOTE-005 |
| Fase | Fase 2 |
| ADR que lo autoriza | ADR-012 §5.1, §7, §8 |
| Estado | Completado |
| Estado vigente | COMPLETADO — commit `ddca06c`. Implementado; no volver a ejecutar salvo corrección o regresión documentada. |
| Objetivo | Implementar `GET /api/health/live`, sin evaluar PostgreSQL/PostGIS/Cognito/Wompi, respondiendo `200` únicamente si el proceso está vivo y no en medio de un cierre ordenado |
| Precondiciones | Lote 2 completado |
| Archivos permitidos | `server/routes/health.js`, `server/index.js` (montaje de la ruta si cambia) |
| Archivos prohibidos | `server/db.js`, `server/catastroxDb.js` (esta ruta no debe consultarlos) |
| Cambios exactos | Nueva ruta `GET /api/health/live` devolviendo `{status: "ok", timestamp}` sin dependencias externas |
| Pruebas | Prueba de que la ruta responde `200` en condiciones normales; prueba de que no ejecuta ninguna consulta a base de datos (verificable por *mock*/espía de los módulos de conexión) |
| Criterio de aceptación | Coincide exactamente con el contrato de ADR-012 §7 |
| Rollback | `git revert` — la ruta deja de existir, sin impacto en el resto del sistema (nada la consume todavía) |
| Riesgo | Bajo |
| Tamaño | XS |
| Dependencias | Lote 2 |
| Tareas paralelizables | Ninguna (bloquea Lotes 6, 7, 8) |
| Commit esperado | `ddca06c` |
| Mensaje recomendado del commit | `feat(health): add /api/health/live platform health endpoint` |
| Evidencia requerida | Resultado de pruebas |

### LOTE-006 — Relay de salud real (`functions/api/health.js`)

| Campo | Valor |
|---|---|
| ID | LOTE-006 |
| Fase | Fase 2 |
| ADR que lo autoriza | ADR-012 §17 |
| Estado | Completado |
| Estado vigente | COMPLETADO — commit `1868f72`. Implementado; no volver a ejecutar salvo corrección o regresión documentada. |
| Objetivo | Mantener el relay público `functions/api/health.js` como proxy real hacia el origen objetivo actual `GET /api/health/live`, sin *fallback* estático, con `Cache-Control: no-store` y validación del backend permitido. El diseño inicial contemplaba el contrato resumido `/api/health`, pero el commit `1868f72` implementó el relay hacia liveness. |
| Precondiciones | Lote 5 completado |
| Archivos permitidos | `functions/api/health.js` |
| Archivos prohibidos | `functions/_data/agxStatic.js` (no se elimina en este lote, salvo que quede huérfano tras el cambio — evaluar en el propio lote) |
| Cambios exactos | Reemplazar el `import`/uso de datos estáticos por un `fetch` real al backend permitido, apuntando a `GET /api/health/live`, con `Cache-Control: no-store` y sin respuesta fabricada |
| Pruebas | Prueba de que la función reenvía fielmente `200`/`503` del origen; prueba de que un fallo de alcance al origen responde `502`/`504`, nunca un `200` estático |
| Criterio de aceptación | El relay público de health refleja `GET /api/health/live` del origen permitido, nunca un valor estático indistinguible de una respuesta real (ADR-012 §33) |
| Rollback | `git revert` — vuelve al *fallback* estático (riesgo ya documentado como no deseado) |
| Riesgo | Bajo-medio — depende de que el origen (todavía sin desplegar en AWS) responda; en el ambiente actual (Railway) debe seguir funcionando igual |
| Tamaño | XS |
| Dependencias | Lote 5 |
| Tareas paralelizables | Paralelizable con Lote 7 |
| Commit esperado | `1868f72` |
| Mensaje recomendado del commit | `fix(health): make Cloudflare health relay a real proxy` |
| Evidencia requerida | Resultado de pruebas; verificación manual contra el backend real en un entorno de desarrollo |

### LOTE-007 — *Readiness* por dominio

| Campo | Valor |
|---|---|
| ID | LOTE-007 |
| Fase | Fase 2 |
| ADR que lo autoriza | ADR-012 §5.3, §7, §14, §35.A |
| Estado | Completado |
| Estado vigente | COMPLETADO — commit `902b4e0`. Readiness protegida general y por dominio (Ganadería y CatastroX independientes) implementada con `HEALTH_MONITOR_TOKEN`; la ruta heredada `/api/health/db` queda protegida por el mismo token pero aún no fue retirada; 377 de 377 pruebas backend aprobadas. |
| Objetivo | Implementar `GET /api/health/ready`, `GET /api/health/ready/ganaderia`, `GET /api/health/ready/catastrox` protegidas con autenticación `Bearer HEALTH_MONITOR_TOKEN`, con readiness general y por dominio independiente entre Ganadería y CatastroX; inspección previa del *pool* de PostgreSQL, consultas `SELECT` de solo lectura con *timeout* externo y `query_timeout` del driver, cero reintentos ante `pool_exhausted`, deduplicación de verificaciones concurrentes, caché interna breve, verificación parametrizada (`$1`) del esquema `agx`, y verificación de PostGIS más los esquemas `catastrox`, `catastrox_clean` y `gis`; causas clasificadas sin exponer detalle crudo |
| Precondiciones | Lote 5 completado |
| Archivos permitidos | `server/config/env.js`, `server/config/__tests__/env.test.js`, `server/index.js`, `server/routes/health.js`, `server/health/dbReadiness.js`, `server/health/ganaderiaReadiness.js`, `server/health/catastroxReadiness.js`, `server/health/monitorAuth.js`, `server/health/readiness.js`, `server/health/__tests__/dbReadiness.test.js`, `server/health/__tests__/domainReadiness.test.js`, `server/health/__tests__/healthRouter.test.js`, `server/health/__tests__/monitorAuth.test.js`, `server/health/__tests__/readiness.test.js` |
| Archivos prohibidos | Rutas de negocio; `functions/api/health.js`; `server/db.js`; `server/catastroxDb.js` |
| Cambios exactos | Autenticación `Bearer HEALTH_MONITOR_TOKEN` en tiempo constante (hash SHA-256 + `timingSafeEqual`) sobre las rutas de readiness y `/api/health/db`; readiness independiente por dominio sin dependencia entre Ganadería y CatastroX; `Cache-Control: no-store` en toda respuesta; errores sanitizados sin exponer `error.message` crudo del driver `pg` |
| Pruebas | Prueba de `200` con PostgreSQL disponible; prueba de `503` con `database_unreachable` simulado; prueba de que `pool_exhausted` no reintenta; prueba de autenticación `Bearer` (401 sin token o token inválido); prueba de independencia entre dominios (falla uno sin afectar al otro); prueba de `no-store` y de errores sanitizados sin detalle crudo |
| Criterio de aceptación | 377 de 377 pruebas backend aprobadas; ningún endpoint de *readiness* es consumido por el *target group* del ALB ni por el relay público (eso sigue siendo exclusivamente Lote 5) |
| Rollback | `git revert 902b4e0` |
| Riesgo | Medio — requiere simular condiciones de fallo de base de datos de forma controlada en las pruebas |
| Tamaño | M |
| Dependencias | Lote 5 |
| Tareas paralelizables | Paralelizable con Lote 6 |
| Commit esperado | `902b4e0` |
| Mensaje recomendado del commit | `feat(health): add domain readiness checks` |
| Evidencia requerida | 377/377 pruebas backend aprobadas |

### LOTE-008 — *Graceful shutdown*

| Campo | Valor |
|---|---|
| ID | LOTE-008 |
| Fase | Fase 2 |
| ADR que lo autoriza | ADR-012 §21 |
| Estado | Completado |
| Estado vigente | COMPLETADO — commit `783cddd`. Implementado; no volver a ejecutar salvo corrección o regresión documentada. |
| Objetivo | Manejar `SIGTERM`/`SIGINT` en `server/index.js`: bandera `shuttingDown` idempotente, `server.close()`, drenaje de solicitudes activas, cierre de pool `agx`, cierre de pool CatastroX, *timeout* interno menor que el `stopTimeout` que se configure en Fase 4, *logging* de inicio/éxito/error/cierre forzado |
| Precondiciones | Lote 5 completado (para que el health de plataforma pueda reflejar el estado `shuttingDown`) |
| Archivos permitidos | `server/index.js`, `server/db.js`, `server/catastroxDb.js` (solo exponer un método de cierre si no existe) |
| Archivos prohibidos | Rutas de negocio |
| Cambios exactos | Manejadores de señal, secuencia de cierre ordenado según ADR-012 §21 |
| Pruebas | Prueba de que, al enviar `SIGTERM` al proceso en un entorno de prueba controlado, el proceso cierra ambos *pools* y termina dentro de un *timeout* esperado; prueba de idempotencia del manejador |
| Criterio de aceptación | El proceso no pierde solicitudes en curso ante `SIGTERM`, y cierra ambos *pools* de forma explícita |
| Rollback | `git revert` |
| Riesgo | Medio — pruebas de señales de proceso requieren un entorno de ejecución real (no solo simulación de funciones) |
| Tamaño | S |
| Dependencias | Lote 5 |
| Tareas paralelizables | Ninguna (bloquea Lote 14, Dockerfile) |
| Commit esperado | `783cddd` |
| Mensaje recomendado del commit | `feat(server): add graceful shutdown on SIGTERM/SIGINT` |
| Evidencia requerida | Resultado de pruebas, incluida una prueba de proceso real si el marco de pruebas lo permite |

### LOTE-009 — `no-store` y errores seguros

| Campo | Valor |
|---|---|
| ID | LOTE-009 |
| Fase | Fase 2 |
| ADR que lo autoriza | ADR-012 §11, §23; ADR-013 §22 |
| Estado | Completado |
| Estado vigente | COMPLETADO — `Cache-Control: no-store` aplicado en `notFound` y en las respuestas de `errorHandler`; `status`/`statusCode` normalizado a enteros 400-599; mensajes controlados 4xx conservados; mensajes 5xx sanitizados a "Error interno del servidor"; log mínimo sin `error.message`, `stack`, `error.name`, SQL, tokens ni credenciales; `headersSent` delegado a `next`. |
| Objetivo | Añadir `Cache-Control: no-store` a todas las respuestas de *health*/API relevantes; corregir `server/middleware/errors.js` para que `errorHandler` nunca exponga `error.message` crudo del driver `pg` u otro detalle interno |
| Precondiciones | Lotes 5, 6, 7 completados (para aplicar la cabecera de forma consistente a todas las rutas nuevas) |
| Archivos permitidos | `server/middleware/errors.js`, `server/middleware/__tests__/errors.test.js` |
| Archivos prohibidos | Rutas de negocio no relacionadas con *health*/errores |
| Cambios exactos | `Cache-Control: no-store` en `notFound` y en las respuestas de `errorHandler`; `status`/`statusCode` normalizado a enteros 400-599; mensajes controlados 4xx conservados; mensajes 5xx sanitizados a "Error interno del servidor"; log mínimo sin `error.message`, `stack`, `error.name`, SQL, tokens ni credenciales; `headersSent` delegado a `next` |
| Pruebas | Prueba de que un error de base de datos simulado no expone la cadena cruda del driver en la respuesta HTTP; prueba de cabecera `Cache-Control` presente; 15/15 pruebas específicas de `errors.test.js` y 392/392 pruebas backend totales |
| Criterio de aceptación | Ninguna respuesta de *health* es cacheable; ningún error interno se filtra al cliente |
| Rollback | `git revert 6ba3056` |
| Riesgo | Bajo |
| Tamaño | S |
| Dependencias | Lotes 5, 6, 7 |
| Tareas paralelizables | Ninguna |
| Commit esperado | `6ba3056` |
| Mensaje recomendado del commit | `fix(security): enforce no-store and sanitize error responses` |
| Mensaje real del commit | `fix(security): enforce no-store and sanitize error responses` |
| Evidencia requerida | 15/15 pruebas específicas y 392/392 pruebas backend |

### LOTE-010 — *Logging* estructurado y *correlation ID*

| Campo | Valor |
|---|---|
| ID | LOTE-010 |
| Fase | Fase 2 |
| ADR que lo autoriza | ADR-012 §25 |
| Estado | Pendiente |
| Estado vigente | PENDIENTE — *logging* estructurado y *correlation ID*. |
| Objetivo | Introducir *logging* estructurado mínimo (formato JSON o equivalente) con *correlation ID* por solicitud, sin registrar secretos, cookies, tokens ni geometrías completas |
| Precondiciones | Lote 2 completado |
| Archivos permitidos | `server/index.js` (middleware de *logging*), un nuevo módulo de *logging* |
| Archivos prohibidos | Rutas de negocio (solo se instrumenta vía middleware transversal, no editando cada ruta individualmente) |
| Cambios exactos | Middleware que genera/propaga un *correlation ID* por solicitud y registra eventos mínimos (inicio/fin de solicitud, código de estado) |
| Pruebas | Prueba de que cada solicitud recibe un *correlation ID* único; prueba de que el *log* no contiene ningún patrón de secreto conocido (verificación negativa) |
| Criterio de aceptación | Coherente con ADR-012 §25 |
| Rollback | `git revert` |
| Riesgo | Bajo |
| Tamaño | S |
| Dependencias | Lote 2 |
| Tareas paralelizables | Paralelizable con Lotes 5-9 |
| Commit esperado | Uno, aislado |
| Mensaje recomendado del commit | `feat(observability): add structured logging with correlation ID` |
| Evidencia requerida | Resultado de pruebas |

### LOTE-011 — Estados vacíos reales de Ganadería

| Campo | Valor |
|---|---|
| ID | LOTE-011 |
| Fase | Fase 1 |
| ADR que lo autoriza | ADR-014 §11, §20 |
| Estado | Requiere auditoría final |
| Estado vigente | REQUIERE AUDITORÍA FINAL — `81c647e` restauró cuenta real/demo; todavía debe verificarse que ninguna ruta real muestre cifras de relleno. |
| Objetivo | Auditar `GanaderiaApp.jsx` y sus componentes de *tab* para confirmar (o corregir) que ninguno muestra datos de relleno no provenientes de `ganaderiaApi.js`; sustituir cualquier hallazgo por un estado vacío explícito |
| Precondiciones | Ninguna técnica — puede ejecutarse en paralelo con Lotes 2-10, aunque se recomienda después de Lote 2 para poder distinguir comportamiento por ambiente si aplica |
| Archivos permitidos | `src/modules/ganaderia/GanaderiaApp.jsx` y sus componentes de *tab* directamente auditados, sin tocar `GanaderiaDemo.jsx` |
| Archivos prohibidos | Cualquier archivo bajo la ruta demo (`GanaderiaDemo.jsx`, `ganaderiaDemoData.js`) |
| Cambios exactos | Depende del resultado de la auditoría — este lote es, en su primera mitad, una auditoría (sin cambios de código), y en la segunda, la corrección puntual de cualquier hallazgo |
| Pruebas | Prueba de que un componente de *tab* sin datos reales muestra un estado vacío explícito, no una cifra de relleno |
| Criterio de aceptación | ADR-014 §37: "Ningún dashboard de una cuenta real sin datos aún muestra cifras de relleno" |
| Rollback | `git revert` de la corrección puntual (la auditoría en sí no es reversible por no ser código) |
| Riesgo | Bajo-medio — depende de cuántos hallazgos reales produzca la auditoría, no cuantificable de antemano |
| Tamaño | M (por la naturaleza exploratoria de la auditoría) |
| Dependencias | Ninguna estricta |
| Tareas paralelizables | Sí, con casi cualquier otro lote de esta lista salvo los que tocan `server/` |
| Commit esperado | Uno o dos (auditoría documentada + corrección, si aplica) |
| Mensaje recomendado del commit | `fix(ganaderia): ensure empty states instead of placeholder data` |
| Evidencia requerida | Informe de auditoría (qué se revisó, qué se encontró) + resultado de pruebas de la corrección si hubo alguna |

### LOTE-012 — Retiro controlado de `ganaderiaMockData.js`

| Campo | Valor |
|---|---|
| ID | LOTE-012 |
| Fase | Fase 1 |
| ADR que lo autoriza | ADR-014 §20, §36 |
| Estado | Pendiente |
| Estado vigente | PENDIENTE DE VERIFICACIÓN — no afirmar retiro de `ganaderiaMockData.js` sin comprobarlo. |
| Objetivo | Confirmar de nuevo (verificación previa a la eliminación, no solo confiar en la investigación de una ronda anterior) que `ganaderiaMockData.js` no tiene importadores, y retirarlo del repositorio |
| Precondiciones | Ninguna |
| Archivos permitidos | `src/modules/ganaderia/data/ganaderiaMockData.js` (eliminación) |
| Archivos prohibidos | Cualquier otro — si la reverificación encuentra un importador inesperado, el lote se detiene y se reclasifica, no se fuerza la eliminación |
| Cambios exactos | `git rm src/modules/ganaderia/data/ganaderiaMockData.js` tras confirmar ausencia de importadores |
| Pruebas | Búsqueda exhaustiva (`grep`) de importadores como paso previo obligatorio, documentado como evidencia; *build* del frontend tras la eliminación confirmando ausencia de error de módulo no encontrado (ejecución de *build* fuera del alcance de esta tarea documental, pero **obligatoria** como parte de la ejecución real del lote) |
| Criterio de aceptación | El archivo no existe más en el árbol de trabajo; el *build* no falla por su ausencia |
| Rollback | `git revert` — restaura el archivo |
| Riesgo | Muy bajo, condicionado a que la reverificación confirme lo ya encontrado |
| Tamaño | XS |
| Dependencias | Ninguna |
| Tareas paralelizables | Sí |
| Commit esperado | Uno, aislado |
| Mensaje recomendado del commit | `chore(ganaderia): remove orphaned ganaderiaMockData.js` |
| Evidencia requerida | Resultado de la búsqueda de importadores; resultado del *build* |

### LOTE-013 — *Baseline* de pruebas de seguridad

| Campo | Valor |
|---|---|
| ID | LOTE-013 |
| Fase | Fase 2 |
| ADR que lo autoriza | ADR-013 §22, §31 |
| Estado | Pendiente |
| Estado vigente | PENDIENTE — auditoría SQL/entropía de `lookupId`. |
| Objetivo | Revisión dedicada de `server/routes/catastrox.js` y `server/routes/catastroxPayments.js` en busca de patrones de construcción de SQL no parametrizada, y verificación de que el `lookupId` actual tiene aleatoriedad suficiente para no ser adivinable (ADR-013 §22, acciones ya señaladas como pendientes) |
| Precondiciones | Ninguna técnica |
| Archivos permitidos | Ninguno de código en la primera mitad (es una auditoría); posible corrección puntual acotada en la segunda mitad, si se encuentra un hallazgo concreto |
| Archivos prohibidos | Cualquier cambio de comportamiento no directamente motivado por un hallazgo de la auditoría |
| Cambios exactos | Depende del resultado — este lote es predominantemente de análisis, con un informe como entregable principal |
| Pruebas | Si se encuentra y corrige un hallazgo, prueba específica de ese hallazgo (por ejemplo, un caso de entrada que antes hubiera sido vulnerable) |
| Criterio de aceptación | Informe de auditoría completo, sin patrones de SQL no parametrizada encontrados sin corregir, y confirmación explícita del nivel de aleatoriedad del `lookupId` |
| Rollback | `git revert` de cualquier corrección puntual aplicada |
| Riesgo | Bajo para el análisis en sí; depende del hallazgo para cualquier corrección |
| Tamaño | M |
| Dependencias | Ninguna |
| Tareas paralelizables | Sí |
| Commit esperado | Cero o uno (según si hay corrección) |
| Mensaje recomendado del commit | `security(catastrox): audit SQL parameterization and lookupId entropy` (si aplica corrección) |
| Evidencia requerida | Informe de auditoría |

### LOTE-014 — `Dockerfile` + `.dockerignore`

| Campo | Valor |
|---|---|
| ID | LOTE-014 |
| Fase | Fase 3 |
| ADR que lo autoriza | ADR-011 §10 |
| Estado | Pendiente |
| Estado vigente | PENDIENTE — `Dockerfile`/`.dockerignore`; LOTE-009 ya cerrado (commit `6ba3056`), precondición cumplida. |
| Objetivo | Crear un `Dockerfile` reproducible del backend Express, con usuario no *root*, manejo correcto de señales (heredado de Lote 8), y un `.dockerignore` que excluya `node_modules`, archivos de desarrollo y secretos locales |
| Precondiciones | Lotes 2, 5, 8, 9 completados |
| Archivos permitidos | `Dockerfile` (nuevo, en la raíz o en `server/`, a decidir en el propio lote), `.dockerignore` (nuevo) |
| Archivos prohibidos | Cualquier archivo de código de aplicación — este lote no modifica lógica, solo empaqueta lo ya existente |
| Cambios exactos | Definición de imagen base, copia de `server/`, instalación de dependencias de producción, usuario no *root*, `CMD`/`ENTRYPOINT` apuntando a `node index.js` |
| Pruebas | Construcción local de la imagen (`docker build`, fuera del alcance de esta tarea documental, pero obligatoria en la ejecución real del lote); ejecución local del contenedor confirmando que responde en `GET /api/health/live`; envío de `SIGTERM` al contenedor confirmando cierre ordenado (heredado de Lote 8) |
| Criterio de aceptación | Imagen construible de forma reproducible, contenedor que responde a *health* y a señales de parada |
| Rollback | `git revert` — elimina el `Dockerfile`, sin impacto en el resto del sistema (nada lo consume todavía fuera de pruebas locales) |
| Riesgo | Medio — primera vez que el proyecto se empaqueta como contenedor, puede revelar dependencias implícitas del entorno de desarrollo no capturadas |
| Tamaño | M |
| Dependencias | Lotes 2, 5, 8, 9 |
| Tareas paralelizables | Ninguna (depende de casi toda la Fase 2) |
| Commit esperado | Uno, aislado |
| Mensaje recomendado del commit | `build(docker): add reproducible backend Dockerfile` |
| Evidencia requerida | Resultado de `docker build`/`docker run` local; captura del *health check* respondiendo; captura del cierre ordenado ante `SIGTERM` |

### LOTE-015 — Matriz de configuración de staging (documental, sin desplegar)

| Campo | Valor |
|---|---|
| ID | LOTE-015 |
| Fase | Fase 4 (primer lote, sin aprovisionar infraestructura todavía) |
| ADR que lo autoriza | ADR-014 §13 |
| Estado | Pendiente |
| Estado vigente | PENDIENTE — matriz documental de staging; no autoriza `terraform apply` ni recursos AWS. |
| Objetivo | Documentar, sin desplegar, la matriz completa de variables de entorno de staging (`APP_ENV=staging`, `DATABASE_URL`/`CATASTROX_DATABASE_URL` de staging como *placeholders*, `WOMPI_ENV=test`, `COOKIE_DOMAIN=staging.agrogenomax.com`, etc.), como preparación para que Fase 4 tenga un contrato claro antes de aprovisionar cualquier recurso real |
| Precondiciones | Lote 2 completado |
| Archivos permitidos | Un nuevo archivo de ejemplo (`server/.env.staging.example` o equivalente), sin valores reales |
| Archivos prohibidos | Cualquier archivo `.env` real, cualquier credencial |
| Cambios exactos | Archivo de ejemplo documentando cada variable esperada para staging, con *placeholders*, sin valores reales |
| Pruebas | No aplica (documento de configuración, no código ejecutable) — revisión de que el archivo no contiene ningún valor real por accidente |
| Criterio de aceptación | Matriz completa y coherente con ADR-014 §13, lista para que Fase 4 la use al aprovisionar |
| Rollback | `git revert` — elimina el archivo de ejemplo, sin impacto operativo |
| Riesgo | Muy bajo |
| Tamaño | XS |
| Dependencias | Lote 2 |
| Tareas paralelizables | Sí, con casi cualquier otro lote |
| Commit esperado | Uno, aislado |
| Mensaje recomendado del commit | `docs(config): add staging environment variable matrix` |
| Evidencia requerida | Revisión visual de que no hay secretos reales en el archivo |

---

## Cierre

### 1. Ruta creada

`docs/implementation/AGROGENOMAX_MASTER_IMPLEMENTATION_PLAN_V1.md`

### 2. Fases definidas

11 (Fase 0 — Baseline y control del repositorio, a Fase 10 — Gate de producción).

### 3. Número total de lotes

15 lotes iniciales detallados: 8 lotes completados, 1 lote parcial (LOTE-003), 2 con auditoría/verificación específica (LOTE-011 y LOTE-012) y 4 pendientes, con las Fases 5-10 registradas a nivel de fase y pendientes de descomposición lote por lote en tareas futuras (§24).

### 4. Estado del Lote 1

Completado, commit `26ca461`, 5 pruebas *pass* / 0 *fail*. El registro vigente completo está en §22.

### 5. Siguiente lote recomendado

LOTE-009 completado (commit `6ba3056`). Siguiente lote recomendado: LOTE-010, *logging* estructurado y *correlation ID*.

Justificación: con LOTE-009 cerrado, Fase 4 exige completar los Lotes 5-10 y 14 antes de iniciar; el único lote de Fase 2 que sigue pendiente es LOTE-010. Esta recomendación no autoriza ejecución todavía.

### 6. Dependencias

Documentadas en §5 (ADR→ADR) y en el campo "Dependencias" de cada lote (§ definición detallada) — la cadena crítica vigente pendiente es: LOTE-010 → LOTE-014 → Fase 4 (LOTE-009 ya completado, commit `6ba3056`). LOTE-003 conserva remanentes no bloqueantes para readiness, pero obligatorios antes de cerrar integralmente ADR-014.

### 7. Gates

Siete, documentados en §9 — ninguno omitible, ninguno automático entre lotes.

### 8. Estrategia Git

Una rama por lote, *staging* siempre selectivo (nunca `git add .`/`-A`), commit aislado, sin *push* sin aprobación, sin `reset`/`restore`/`checkout`/`clean`/`stash` sobre cambios ajenos (§6).

### 9. Estrategia de pruebas

Ningún lote se cierra sin pruebas propias *pass*, más la suite de regresión existente sin romperse (§7).

### 10. Estrategia de rollback

`git revert` por lote como mecanismo primario; mecanismos específicos adicionales por tipo de cambio (infraestructura, base de datos, tráfico) documentados en §8 y en el campo "Rollback" de cada lote.

### 11. Riesgos

Seis riesgos críticos documentados en §23, encabezados por la ejecución fuera de orden de dependencia y la confusión entre cambios preexistentes ajenos y el alcance de un lote.

### 12. Elementos bloqueados

Fase 9 (migración geoespacial) bloqueada hasta cumplimiento verificado de ADR-006; Fase 10 (producción) bloqueada hasta superar los *gates* de ADR-011/012/013/014 y aprobación explícita de costo; LOTE-011 y LOTE-013 tienen alcance de corrección condicionado al resultado de su propia auditoría.

### 13. Información NO VERIFICADA

Contenido completo de `002_agx_seed_demo.sql`; verificación final de que ninguna ruta real de Ganadería muestra cifras de relleno (objeto remanente de LOTE-011); verificación específica de `ganaderiaMockData.js` antes de declarar LOTE-012 completado; volumen real de tráfico de las rutas públicas; estado de los *flags* `CATASTROX_AUDIT_DOWNLOADS`/`CATASTROX_ADVANCED_LOOKUP_ENABLED` en cualquier entorno desplegado hoy.

### 14. Único cambio atribuible

Actualización documental de `docs/implementation/AGROGENOMAX_MASTER_IMPLEMENTATION_PLAN_V1.md` como registro vigente de ejecución.

### 15. Confirmación de ausencia de git add, commit y push

No se ejecutó `git add`, `git commit`, `git push`, ni `git reset`/`restore`/`checkout`/`clean`/`stash`. No se modificó el commit `26ca461`, ningún ADR, código, tests, frontend, backend, Cloudflare, AWS, Railway, bases de datos, Terraform, *workflows*, `package.json` ni ningún archivo `.env`. Los cambios preexistentes del árbol de trabajo, ajenos a esta tarea, permanecen exactamente en el estado en que se encontraron.
