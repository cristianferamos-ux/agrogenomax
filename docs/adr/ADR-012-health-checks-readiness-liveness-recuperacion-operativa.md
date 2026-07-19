# ADR-012: Health checks, readiness, liveness y recuperación operativa

- **Estado**: Aceptada
- **Fecha**: 2026-07-18
- **Responsables**: Equipo técnico AgroGenomaX / CRH Soluciones Integrales S.A.S.

## Precedencia y estado vigente

Correcciones ya implementadas y verificadas: `server/index.js` expone `/api/health/live`; `functions/api/health.js` dejó de fabricar respuesta estática y hace relay real; el relay usa `Cache-Control: no-store`; el relay valida origen backend permitido; existe graceful shutdown para `SIGTERM`/`SIGINT`; se cierran ambos pools; `APP_ENV` tiene validación fail-fast antes de aceptar tráfico.

Pendientes: `/api/health` público mínimo conforme al contrato final ADR-012; readiness general y por dominio restringida; timeouts completos de pools/dependencias; sanitización global de `error.message`; métricas, alarmas, correlation ID y observabilidad completa; configuración real de ALB/target group; medición de duración de solicitudes; prueba de Service Worker frente a `/api/health*`.

## 1. Contexto

ADR-011 (Aceptada) seleccionó Amazon ECS Express Mode como plataforma de ejecución objetivo del backend Express, con ECS+Fargate directo como contingencia y Railway como rollback temporal durante la transición. Ninguno de los ADR previos define cómo AgroGenomaX distingue "proceso vivo" de "listo para tráfico útil", qué debe consumir el *target group* del ALB para decidir si una tarea recibe tráfico o se reemplaza, ni cómo se coordina el cierre ordenado de una tarea Fargate con el drenaje del propio ALB. Este ADR-012 resuelve esa brecha sobre una plataforma concreta y con la secuencia de ciclo de vida de tarea/target verificada contra documentación oficial de AWS.

## 2. Problema

Contexto histórico original: existían rutas "health" incompatibles entre sí, un fallback estático de Cloudflare que no llegaba al backend real, ausencia de *readiness*, *liveness*, manejo de `SIGTERM`/`SIGINT` y *graceful shutdown*, además de una filtración confirmada de `error.message` crudo. Estado actual: liveness, relay real de Cloudflare hacia liveness, `Cache-Control: no-store`, validación de origen backend, fail-fast de `APP_ENV`, graceful shutdown y cierre de pools ya están implementados. Siguen abiertas readiness, timeouts, sanitización global de errores, observabilidad y ALB/ECS físico. Sobre la plataforma seleccionada por ADR-011 se resuelven, en esta versión, la secuencia real de orquestación entre el desregistro del *target* y el envío de señales de parada de ECS, y el tratamiento normativo de `functions/api/health.js` en Cloudflare.

## 3. Estado actual verificado

*(Confirmado por lectura directa del código en sesiones previas de este mismo proceso.)*

**Endpoints existentes**: `GET /api/health/live` existe en Express como liveness sin dependencias externas. `GET /api/health` existe como router público mínimo, pero aún requiere alineación completa con el contrato final de este ADR. `GET /api/health/db` existe como ruta heredada; en fallo puede delegar al `errorHandler` global (`server/middleware/errors.js`), el cual **responde `error.status || 500` con `error.message` sin sanitizar** — filtración confirmada del mensaje crudo.

**Express/Cloudflare**: corregido — `functions/api/health.js` ya no fabrica un health estático; hace relay real hacia `/api/health/live`, valida el origen backend permitido y usa `Cache-Control: no-store`.

**Brechas aún abiertas**: sin readiness restringida general ni por dominio; sin *timeouts* completos en pools/dependencias; sanitización global de `error.message` pendiente; sin métricas, alarmas, logs estructurados ni *correlation ID* completos; sin ALB/ECS físico configurado.

**Configuración de red del backend en desarrollo**: `vite.config.js` confirma que, en desarrollo local, el frontend hace *proxy* de `/api` hacia `http://localhost:3001` — no aporta información sobre el puerto real en producción (ECS), que se rige por la variable de entorno que consuma `server/index.js`.

**Service Worker**: `public/service-worker.js` usa estrategia *network-first* para `/api/*` — **no se verificó específicamente** si excluye `/api/health*` de cualquier *fallback* de caché ante fallo de red.

**Ausencia de `Dockerfile`/ECS/ALB configurados**: CONFIRMADA, sin cambios respecto de ADR-011 — cero archivos de contenedor o de infraestructura en el repositorio.

**Configuración de Railway**: no existe en el repositorio; vive, si existe, en el panel de Railway. **NO VERIFICADO** cualquier mecanismo de *health check* que Railway tenga configurado hoy.

**Verificado contra documentación oficial de AWS (ciclo de vida de tarea/target, corrección de esta ronda)**:

- **Secuencia conceptual oficial de parada de una tarea de servicio con un *target group* asociado**, verificada contra `docs.aws.amazon.com/AmazonECS/latest/developerguide/deployment-type-ecs.html` y la documentación de ciclo de vida de tareas de ECS:
  1. La tarea entra en estado `DEACTIVATING`.
  2. ECS desregistra el *target* del *load balancer* durante `DEACTIVATING`.
  3. El *target* entra en estado `draining` en el *target group*.
  4. El ALB deja de enviar solicitudes **nuevas** hacia ese *target* y permite que las solicitudes **activas** se completen dentro del `deregistration delay`.
  5. El *target* progresa hacia el estado `unused` una vez completado el drenaje (o al expirar el `deregistration delay`, lo que ocurra primero).
  6. La tarea entra en estado `STOPPING`.
  7. ECS envía la señal de parada al contenedor — **`SIGTERM` por defecto**.
  8. ECS espera hasta `stopTimeout`.
  9. ECS envía `SIGKILL` **únicamente** si el proceso no terminó por sí mismo dentro de ese plazo.
- **Esta secuencia confirma que el desregistro del *target* (pasos 1-5) es anterior, y no simultáneo, al envío de `SIGTERM` (paso 7)** — corrige la incertidumbre de la ronda anterior de este documento: no existe una "carrera" entre ambos relojes partiendo del mismo instante; son fases secuenciales de un mismo ciclo de parada de tarea.
- **`stopTimeout`** (Fargate): valor por defecto **30 segundos**; **rango válido 2-120 segundos** (corrige el rango `0-120` de la ronda anterior de este documento, que era impreciso).
- **`deregistration delay`** del *target group* del ALB: valor por defecto **300 segundos**, rango válido **0-3600 segundos** (verificado, sin cambios respecto de la ronda anterior).
- **`healthCheckGracePeriodSeconds`**: parámetro **distinto** de `stopTimeout` — aplica durante el **arranque** de una tarea, no durante su parada; ECS ignora temporalmente los resultados `unhealthy` del *health check* del *target group* para efectos de reemplazo de tarea durante ese período, dando margen a que el proceso complete su inicialización. Valor por defecto de Express Mode verificado en ADR-011: 300 segundos.
- **`startTimeout`**: parámetro **distinto** de los anteriores — gobierna cuánto tiempo espera ECS a que el contenedor complete su propio arranque (incluye `dependsOn` de otros contenedores de la misma definición de tarea) antes de considerar que la tarea falló al iniciar; no se confunde con `healthCheckGracePeriodSeconds` (que rige la tolerancia del *scheduler* a resultados `unhealthy` del *target group*, no el arranque del contenedor en sí) ni con el `startPeriod` del *container health check* (que aplica dentro del propio mecanismo de `healthCheck` de la definición de contenedor, sección 9).
- **Despliegue rolling de ECS**: sin cambios respecto de la ronda anterior — controlado por `minimumHealthyPercent`/`maximumPercent`, con coexistencia temporal verificada de tareas de la revisión anterior y de la nueva revisión.
- ***Circuit breaker* de despliegue de ECS**: sin cambios respecto de la ronda anterior — soporta *rollback* automático a la revisión anterior, combinable con alarmas de CloudWatch.
- **Resolución de imagen por *digest* y `forceNewDeployment`**: sin cambios respecto de la ronda anterior.
- ***Container health check* de ECS**: parámetro `healthCheck` de la definición de contenedor — rangos verificados en esta ronda: `interval` 5-300 segundos, `timeout` 2-60 segundos, `retries` 1-10, `startPeriod` 0-300 segundos.

**NO VERIFICADO**: disponibilidad efectiva de App Runner (ya cerrada, ADR-011, no reevaluada aquí); configuración de health check de Railway; duración real de las solicitudes de negocio de AgroGenomaX (dato pendiente de medición, no de verificación documental); comportamiento exacto del Service Worker frente a `/api/health*`; puerto exacto en el que escuchará Express en producción sobre ECS.

## 4. Requisitos obligatorios

1. Liveness/health de plataforma nunca depende de PostgreSQL, Cognito, Wompi ni PostGIS.
2. El *target group* del ALB evalúa exclusivamente "health de plataforma" (`GET /api/health/live`) — nunca PostgreSQL ni PostGIS.
3. Readiness funcional se separa por dominio (Ganadería, CatastroX), sin que la caída de uno declare al otro no disponible.
4. Ningún health check ejecuta migraciones ni operaciones mutantes.
5. Ningún endpoint de health expone información sensible, `error.message` crudo, versión, entorno ni infraestructura interna en su variante pública.
6. `Cache-Control: no-store` en toda respuesta HTTP de health, sin excepción, en todas las capas (origen, relay de Cloudflare).
7. El check de PostgreSQL inspecciona el pool antes de consultar, aplica *timeout* estricto, cero reintentos ante `pool_exhausted`, deduplica verificaciones concurrentes y permite una caché interna muy breve — nunca caché HTTP.
8. Cognito/JWKS permanece fuera del camino síncrono de cualquier health check automático.
9. Las sesiones BFF viven en PostgreSQL (ADR-009), no en memoria de la tarea — sobreviven al reemplazo de tarea.
10. El contexto de RLS se establece únicamente dentro de solicitudes de negocio (ADR-008), nunca en un health check.
11. Readiness funcional `503` es una señal de diagnóstico/alerta — no un mecanismo que por sí solo retire una tarea del ALB; el retiro de tráfico del ALB depende exclusivamente del resultado de `GET /api/health/live` en el *target group*.
12. `stopTimeout` y *deregistration delay* son fases distintas y secuenciales del ciclo de parada de una tarea (sección 3), no parámetros equivalentes ni simultáneos — ambos se configuran según la duración real de las solicitudes de negocio.
13. Ningún *container health check* de ECS se adopta como obligatorio sin comparar sus alternativas (sección 9); ninguno consulta PostgreSQL, Cognito, Wompi ni PostGIS.
14. Toda coexistencia de tareas antiguas y nuevas durante un despliegue se considera en el dimensionamiento del pool de PostgreSQL.
15. No se atribuye a Express Mode ningún comportamiento no verificado contra su documentación oficial.
16. App Runner no se reutiliza como plataforma vigente en ningún punto de este documento.
17. No se autoriza ninguna implementación, conexión a AWS, ni creación de recursos como parte de esta tarea.
18. Terraform y los despliegues se gobiernan por ADR-003/010, sin excepción.
19. La migración de CatastroX permanece condicionada por ADR-006.
20. Ningún ADR anterior se modifica.
21. `GET /api/health` público es un proxy real hacia el origen, nunca un valor estático indistinguible de una respuesta real (sección 17).
22. No se crea `GET /api/health/startup` en esta fase — el arranque se representa mediante señales ya existentes de ECS/ALB (sección 5.4).

## 5. Taxonomía operativa

### 5.1 Health de plataforma

Responde exclusivamente si la tarea: tiene el proceso Node vivo; terminó su inicialización esencial; escucha en el puerto esperado (coherente con el puerto configurado en la definición de tarea, ADR-011 sección 10); puede responder dentro del presupuesto temporal (sección 12); no está actualmente en medio de un cierre ordenado (sección 21); no está en un estado fatal interno (por ejemplo, un *event loop* bloqueado de forma evidente). **Nunca consulta** PostgreSQL, Cognito, Wompi, PostGIS ni ninguna API GIS externa. **Es el único endpoint que el *target group* del ALB consume** (sección 8).

### 5.2 Liveness

Health de plataforma y liveness son el mismo contrato, no dos endpoints distintos: `GET /api/health/live` es la única implementación de ambos conceptos. No se crea una duplicidad sin utilidad operacional — el único consumidor real identificado (el *target group* del ALB) solo puede apuntar a un *path*, y ningún otro consumidor concreto de un contrato "liveness" separado se identificó en este documento.

### 5.3 Readiness funcional

Responde a: **¿esta instancia puede servir tráfico útil de un dominio específico ahora mismo?** Separada explícitamente por dominio — general/resumen, Ganadería, CatastroX (sección 7) — evaluando las dependencias críticas de cada uno (sección 6), **sin afectar el health del *target group*** (sección 5.1/8). Un `503` de readiness funcional es una señal de diagnóstico/alerta (sección 26), no un mecanismo que por sí solo retire tráfico del ALB.

### 5.4 Startup — sin endpoint dedicado

**Decisión de esta corrección**: **no se crea `GET /api/health/startup`.** El arranque de una tarea se representa completamente mediante señales ya existentes en la plataforma, sin necesidad de un endpoint adicional sin consumidor identificado:

- **Estado de la tarea en ECS** (`PROVISIONING` → `PENDING` → `ACTIVATING` → `RUNNING`), consultable vía la propia API/consola de ECS.
- **Registro de la tarea en el *target group*** del ALB — el momento en que el *target* pasa a estar registrado y comienza a recibir evaluaciones de *health check*.
- **`healthCheckGracePeriodSeconds`** (sección 3) — el margen durante el cual ECS tolera resultados `unhealthy` del *target group* sin penalizar a la tarea, cubriendo conceptualmente la ventana de arranque.
- **Primera respuesta exitosa (`200`) de `GET /api/health/live`** — el evento concreto que marca el fin del arranque desde la perspectiva de la aplicación.
- **Tiempo hasta el primer *target* `healthy`**, medible como métrica de observabilidad (sección 25).

Estas señales, combinadas, cubren la necesidad operacional de distinguir "tarea arrancando" de "tarea operativa" sin requerir un contrato HTTP adicional. **Solo se creará un endpoint de *startup* dedicado en el futuro si aparece un consumidor operacional concreto** que no pueda resolverse con las señales anteriores — no se anticipa este endpoint sin esa necesidad demostrada.

### 5.5 Estado degradado

El proceso está sano (health de plataforma `200`), pero uno o más dominios están limitados: **health de plataforma permanece `200`**; **readiness del dominio afectado responde `503`**; **se dispara una alerta obligatoria** (sección 26) — nunca se mezclan estos tres conceptos en un único código de respuesta.

## 6. Clasificación de dependencias

Sin cambios de fondo respecto de la ronda anterior — reforzada por la plataforma concreta de ADR-011:

| Dependencia | Crítica / No crítica | Dominio | Impacto en health de plataforma | Impacto en readiness |
|---|---|---|---|---|
| Proceso Node/tarea Fargate | Crítica (es health de plataforma en sí) | Todo | Es el sujeto evaluado | N/A |
| PostgreSQL `agx` | Crítica | Ganadería | Ninguno | `503` en `ready/ganaderia` |
| PostGIS/`catastrox`/`catastrox_clean`/`gis` | Crítica | CatastroX | Ninguno | `503` en `ready/catastrox` |
| Cognito (futuro) | Crítica solo para login/renovación | Ambos, vía sesión BFF | Ninguno | No debe bloquear readiness general por interrupciones breves (sección 16) |
| JWKS de Cognito | No crítica en estado estable (gestionada por caché) | Ambos | Ninguno | No |
| Wompi | No crítica del servicio completo | CatastroX (checkout) | Ninguno | No — error funcional del flujo de pago, no de disponibilidad de instancia |
| Entregables (PDF/KML/KMZ/SHP/DXF) | Históricamente client-side; ADR-013 exige generación inicial server-side para artifacts pagados | CatastroX | Ninguno para liveness | Duración futura a medir según implementación ADR-013 |
| Cloudflare (relay) | No es dependencia del backend en sí | Todo | No aplica | No aplica directamente (sección 17) |
| Railway (transición) | No es dependencia del código | Todo, temporalmente | No aplica | No aplica |

## 7. Contratos de endpoints

*Contratos finales de esta corrección — sustituyen íntegramente la tabla de la ronda anterior.*

| # | Endpoint | Consumidor | Evalúa | Autenticación / acceso | Exposición |
|---|---|---|---|---|---|
| 1 | `GET /api/health` | Público, vía Cloudflare | Proxy real hacia el origen (sección 17) | Ninguna | Pública, payload mínimo resumido: `{status: "ok"\|"degraded"\|"unavailable", timestamp}` |
| 2 | `GET /api/health/live` | El *target group* del ALB | Nada — sin dependencias externas (health de plataforma = liveness) | Ninguna (necesidad técnica: el ALB no se autentica) | Alcanzable por el ALB; payload mínimo |
| 3 | `GET /api/health/ready` | Monitoreo autorizado | Resumen funcional por dominio | Monitoreo autorizado (sección 35.A) — **no expuesto por el relay público general** | Diagnóstico, acceso restringido |
| 4 | `GET /api/health/ready/ganaderia` | Monitoreo autorizado | Pool/esquema `agx`, PostgreSQL | Monitoreo autorizado | Diagnóstico, acceso restringido |
| 5 | `GET /api/health/ready/catastrox` | Monitoreo autorizado | PostGIS, esquemas de CatastroX | Monitoreo autorizado | Diagnóstico, acceso restringido |
| 6 | `GET /api/health/db` | Heredado, temporal | PostgreSQL `agx` (funcionalidad equivalente a `ready/ganaderia`) | Debe protegerse igual que el punto 4 mientras exista | Ruta heredada — su función se migra a `ready/ganaderia`; se retira tras verificar que no queda ningún consumidor dependiendo de ella |

Adicionalmente, conceptual y fuera del contrato del backend Express: `GET /api/edge-health` en Cloudflare, como señal explícita del borde (sección 17), no del origen.

Reglas transversales: `Cache-Control: no-store` en todos, en todas las capas; *timeout* acotado (sección 12); caché interna del resultado de una dependencia permitida solo en los endpoints 3-6 (readiness por dominio), nunca en el endpoint 2 (health de plataforma, que al no evaluar dependencias no tiene nada que cachear) ni en el endpoint 1 (proxy real, sin caché intermedia).

## 8. ALB y target groups

- **Endpoint que consume el *target group***: `GET /api/health/live` — **nunca** `/api/health/ready` ni sus variantes por dominio.
- **Protocolo**: HTTP (terminación TLS en el ALB, tráfico interno HTTP hacia el *target*, consistente con la configuración por defecto de Express Mode verificada).
- **Puerto**: el puerto de contenedor configurado en la definición de tarea (ADR-011, sección 10) — por defecto de Express Mode, `80`; a alinear explícitamente con el puerto real que Express escucha en producción (dato **no verificado** en esta sesión, sección 3, acción requerida en sección 32).
- **Path**: `GET /api/health/live` (corrige el `"/"` por defecto de Express Mode, que evaluaría la raíz de la aplicación, no un endpoint de salud dedicado).
- ***Matcher* HTTP**: `200` como único código de éxito — ningún otro código se interpreta como saludable.
- **Interval/timeout/umbrales**: valores por defecto verificados de Express Mode (intervalo 30 s, *timeout* 5 s, umbral saludable 5 consecutivos, umbral no saludable 2 consecutivos) como punto de partida — ajustables sin rediseño arquitectónico, sujetos a la jerarquía temporal de la sección 12.
- **Período de gracia de salud** (`healthCheckGracePeriodSeconds`, 300 s por defecto, distinto de `stopTimeout` y de `startTimeout`, sección 3): cubre el arranque inicial de una tarea nueva, coherente con la taxonomía de *startup* (sección 5.4) — durante este período, ECS **ignora temporalmente** los resultados `unhealthy` del *target group* para efectos de reemplazo de tarea; **el *target group* conserva, en todo momento, su propia evaluación de salud independiente** — el período de gracia afecta la reacción del *scheduler* de ECS, no el resultado que el *target group* reporta.
- **Comportamiento durante despliegue**: rolling, con `minimumHealthyPercent`/`maximumPercent` controlando cuántas tareas antiguas y nuevas coexisten (verificado, sección 3) — relevante directamente para el dimensionamiento del pool de PostgreSQL (sección 15).
- **`target healthy` con dominio funcional no disponible**: una tarea marcada saludable por el *target group* mientras una o más dependencias críticas de un dominio específico (por ejemplo, PostgreSQL para Ganadería) están caídas. **Esto no se denomina "falso positivo"** — son dos señales deliberadamente independientes, evaluando preguntas distintas por diseño (sección 5.5, corrección terminológica de la sección 35.C): la tarea sigue siendo apta para servir tráfico en general (incluido, potencialmente, tráfico del dominio no afectado), y la readiness del dominio afectado refleja con precisión su propio estado, sin que ninguna de las dos señales sea "incorrecta".
- **Falso negativo** (este término sí se mantiene, dado que describe un error real de calibración, no una independencia deliberada de señales): una tarea sana marcada no saludable por un *timeout* demasiado agresivo o por incluir, por error de implementación, alguna dependencia externa en el *path* de health de plataforma — mitigado por la separación estricta de la sección 5.1/6.

**Justificación explícita de por qué el *target group* no debe consumir readiness con PostgreSQL/PostGIS incluidos**: una caída compartida de RDS afecta a **todas** las tareas por igual; si el *target group* dependiera de PostgreSQL, todas fallarían su *health check* simultáneamente y, al superar el `unhealthy-threshold-count` (2 consecutivos por defecto, verificado), el planificador de ECS las reemplazaría en masa. **Reemplazar tareas sanas no repara RDS** — es una acción sin efecto sobre la causa real, con el costo operativo de destruir y recrear tareas innecesariamente, y con el riesgo adicional de una ráfaga de reconexión simultánea al recuperarse RDS, justo cuando la base de datos está estabilizándose.

## 9. Container health check

*Comparación con rangos oficiales verificados en esta corrección.*

| Alternativa | Valor adicional | Riesgo de duplicidad |
|---|---|---|
| 1. Solo *target group* del ALB | Ya cubre la señal principal que el orquestador necesita para enrutar/reemplazar tráfico | Ninguno — es la línea base |
| 2. ALB + *container health check* de ECS | Detecta un proceso interno que responde a nivel de socket TCP pero está internamente bloqueado de una forma que el *target group* (que solo prueba HTTP desde fuera del contenedor) podría no captar igual de rápido; también permite a ECS marcar la tarea como `UNHEALTHY` sin depender exclusivamente del ciclo del ALB | Real — dos mecanismos evaluando esencialmente lo mismo (si el proceso responde), con la posibilidad de que ambos den resultados momentáneamente distintos durante una transición |
| 3. Solo *container health check*, sin ALB | No aplica — el *target group* del ALB es indispensable para que el tráfico llegue a la tarea en absoluto; no es una alternativa real, es una combinación incompleta |

**Rangos oficiales verificados del parámetro `healthCheck` de la definición de contenedor**: `interval` 5-300 segundos, `timeout` 2-60 segundos, `retries` 1-10, `startPeriod` 0-300 segundos — este último **distinto** de `healthCheckGracePeriodSeconds` (sección 3): `startPeriod` es interno al propio mecanismo de `healthCheck` del contenedor (determina cuándo empiezan a contar los `retries` fallidos), mientras que `healthCheckGracePeriodSeconds` gobierna la tolerancia del *scheduler* de ECS a resultados `unhealthy` del *target group* del ALB — son dos "períodos de gracia" de arranque, pero de dos mecanismos distintos.

**Análisis adicional**: un *container health check* de ECS se define como un comando ejecutado **dentro** del propio contenedor — consume CPU/memoria de la propia tarea en cada ejecución, con su propio `interval`/`timeout`/`retries`/`startPeriod` (rangos ahora verificados arriba), y requeriría una herramienta de comprobación HTTP local en la imagen (por ejemplo `curl`/`wget`), no verificada como presente dado que hoy no existe ningún `Dockerfile`.

**Decisión (mantenida)**: **no se adopta un *container health check* de ECS en esta fase inicial.** Justificación: el *target group* del ALB ya cubre la señal esencial con un mecanismo ya verificado y suficiente para el caso de uso actual de AgroGenomaX; añadir un segundo mecanismo introduce complejidad de coordinación y una dependencia adicional en la imagen de contenedor sin un beneficio claro identificado para el perfil de riesgo actual. **Se registra como decisión de seguimiento** reevaluar su adopción si, en producción, se observa un patrón de fallo que el *target group* del ALB no detecta con suficiente rapidez. **Sin excepción**: si en el futuro se adopta, **nunca** consultará PostgreSQL, Cognito, Wompi ni PostGIS — la misma regla de la sección 5.1 aplica igualmente a cualquier *container health check*.

## 10. Códigos HTTP

Sin cambios de fondo respecto de la ronda anterior: `200` para health de plataforma sano/readiness lista/proxy exitoso; `503` para readiness no lista por dependencia crítica caída, mantenimiento, o migración incompatible del dominio afectado, y también como valor propagado fielmente por `GET /api/health` cuando el origen reporta `unavailable` (sección 17); `500` reservado a un fallo verdaderamente inesperado del propio *handler*, nunca para una causa de dependencia ya clasificada; `502`/`504` los genera Cloudflare o el ALB específicamente cuando **no alcanzan** el origen en absoluto (distinto de un `503` controlado emitido por el propio backend).

## 11. Payload y exposición de información

Sin cambios de fondo respecto de la ronda anterior: payload público mínimo (`GET /api/health`: `{status, timestamp}` con `status` en `"ok"|"degraded"|"unavailable"`; `GET /api/health/live`: `{status, timestamp}`), sin `version`/`environment`/*commit SHA*/nombres de dependencias/causas detalladas en ninguno de los dos endpoints públicos; diagnóstico detallado (desglose por dependencia, causa clasificada) reservado a los endpoints de readiness por dominio (3-6 de la sección 7), con acceso restringido a monitoreo autorizado (sección 35.A), **nunca expuesto a través del relay público general de Cloudflare**; prohibición absoluta de exponer cadenas de conexión, credenciales, tokens, *stack traces*, SQL, estructura de tablas, o `error.message` crudo del driver `pg`.

## 12. Timeouts y presupuestos temporales

*Jerarquía coherente entre capas — sin fijar cifras exactas sin medir primero las solicitudes reales.*

**Relación conceptual que debe cumplirse**, de la capa más interna a la más externa:

```
timeout de la consulta a PostgreSQL (más corto)
   <  timeout total del endpoint de readiness por dominio
      <  timeout del health check del target group del ALB
         <  interval del health check del target group
            <  timeout del relay de Cloudflare hacia el origen
```

- **Health de plataforma** (`/api/health/live`) no depende de ninguna dependencia externa (sección 5.1) — su presupuesto de tiempo es, por diseño, el más bajo y predecible de todos.
- **Readiness por dominio**: su presupuesto debe ser sustancialmente menor que una solicitud de negocio ordinaria.
- **`stopTimeout`** (fase de parada, sección 3) y **`deregistration delay`** (fase de drenaje, sección 22): ambos deben configurarse según la duración real máxima de las solicitudes de negocio que AgroGenomaX sirve hoy (CRUD ganadero, búsqueda catastral) — dato **no verificado** en este documento, acción requerida (sección 32).
- **No se permite que el endpoint de salud tarde tanto como una solicitud ordinaria de negocio**.

## 13. Reintentos y circuit breakers

Sin cambios de fondo respecto de la ronda anterior: reintentos de health check finitos, sin *backoff* agresivo, nunca indefinidos; **cero reintentos ante `pool_exhausted`** específicamente (sección 14); diferenciación entre reintentos de health check y reintentos de operaciones de negocio (fuera de alcance de este ADR). *Circuit breakers* evaluados por dependencia, no adoptados automáticamente para todas:

| Dependencia | Estado |
|---|---|
| PostgreSQL (`agx`/CatastroX) | **Pendiente** — se prioriza primero timeouts correctos + dimensionamiento de pool (sección 15) antes de considerar un *circuit breaker* adicional |
| Cognito/JWKS | **Pendiente**, recomendable a futuro — mitigado en esta fase mediante caché de JWKS (sección 16) |
| Wompi | **Descartado de este ADR** — no crítico para la instancia (sección 6) |
| APIs GIS externas | **No aplica** — no se identificó ninguna dependencia externa real distinta de PostGIS interno |

## 14. PostgreSQL y RDS

Sin cambios de fondo respecto de la ronda anterior:

- **Inspección previa del estado interno del pool, sin red**: antes de intentar una consulta, se consultan las métricas ya expuestas de forma síncrona por el objeto `Pool` de `pg` (conexiones totales, ociosas, en espera); si ya indican saturación evidente, se reporta `pool_exhausted` sin ejecutar una consulta adicional.
- **`SELECT 1` con *timeout* estricto**, solo cuando la inspección previa no descarta ya la saturación.
- **Consulta deduplicada** entre consumidores concurrentes dentro de la misma instancia.
- **Caché interna muy breve** del resultado — **nunca** una caché HTTP.
- **Cero reintentos ante `pool_exhausted`**.
- **Sin consultas costosas ni sobre tablas de negocio**.
- **Clasificación de causas**, sin exponer los códigos internos al público (solo en diagnóstico protegido, sección 11):
  - `database_unreachable` — host inalcanzable.
  - `pool_exhausted` — sin conexiones disponibles dentro del *timeout* de adquisición.
  - `query_timeout` — la consulta no respondió a tiempo.
  - `auth_failed` — credenciales inválidas (nunca se expone el mensaje crudo del driver).
  - `schema_missing` — el esquema/tablas esperadas no existen.
  - `schema_incompatible` — el esquema existe pero no satisface lo que el código desplegado requiere.
  - `migration_in_progress` — una migración detectada en curso.
  - `migration_pending_compatible` — existe una migración no aplicada, pero compatible con el código desplegado (sección 20).

## 15. Multi-tarea y pool PostgreSQL

- **El límite agregado de conexiones a RDS se calcula como pool máximo configurado por tarea × número máximo de tareas del autoescalado** — nunca dimensionado solo sobre el *steady state* de una única tarea.
- **Margen explícito reservado** para: conexiones administrativas/de diagnóstico; ejecución de migraciones; las propias consultas de health check; escenarios de recuperación.
- **Escalado canario y coexistencia de tareas antiguas y nuevas durante un despliegue**: el modelo rolling de ECS mantiene tareas de la revisión anterior y de la nueva revisión activas simultáneamente durante el reemplazo — **el dimensionamiento del pool debe contemplar el pico transitorio de conexiones que esta coexistencia genera**.
- **No se aprueba ninguna configuración de autoescalado en este documento** sin haber validado explícitamente que el límite agregado resultante no excede el máximo de conexiones que la instancia de RDS permite — acción requerida (sección 32), heredada de ADR-011 (sección 11).

## 16. Cognito y JWKS

Sin cambios de fondo respecto de la ronda anterior — Cognito no implementado hoy; **fuera del camino síncrono de cualquier health check automático**; caché de JWKS con TTL, con actualización forzada ante un `kid` desconocido; chequeo sintético separado del ciclo de readiness; **una interrupción breve de Cognito no debe traducirse en `503` sostenido de readiness general, ni en el reinicio de tareas sanas**, dado que el *target group* del ALB no evalúa Cognito en absoluto por diseño. **Las sesiones BFF ya existentes, referenciadas en PostgreSQL, permanecen potencialmente operativas** durante una interrupción de Cognito.

## 17. Cloudflare y relay

*Decisión definitiva de esta corrección — sustituye las dos alternativas equivalentes de la ronda anterior.*

**Señales distintas, nunca fusionadas**:

- **Health del *edge*** (Cloudflare Pages sirviendo el frontend estático).
- **Health del relay** (la Cloudflare Pages Function que reenvía tráfico).
- **Health del origen** (la tarea Fargate real, vía el *endpoint* de ECS Express Mode, ADR-011 sección 9.1).
- **Health de plataforma** (sección 5.1): la señal específica que el *target group* del ALB consume.
- **Readiness de dominios** (sección 5.3): evaluada por el propio backend, nunca por Cloudflare.

**Decisión adoptada**:

- **A. `functions/api/health.js` se convierte en un proxy real** hacia `GET /api/health` del backend AWS, siguiendo el mismo patrón ya verificado en `functions/api/catastrox/[[path]].js` (sección 3): reenvío fiel de la solicitud hacia el origen, sin intervención de datos estáticos.
- **B. `GET /api/health` público refleja el estado real resumido del origen**, con el contrato:
  ```json
  { "status": "ok" | "degraded" | "unavailable", "timestamp": "..." }
  ```
  donde `"ok"` corresponde a health de plataforma sano y sin degradación funcional conocida, `"degraded"` a health de plataforma sano con al menos un dominio en readiness `503`, y `"unavailable"` a la imposibilidad de alcanzar el origen o a health de plataforma no sano.
- **C. `functions/api/health.js` nunca devuelve el *fallback* estático `pages-static-fallback`** como si fuera salud del backend — ese comportamiento actual queda explícitamente descartado por esta decisión.
- **D. Un eventual health del *edge* usará una ruta explícita distinta**, conceptualmente `GET /api/edge-health`, identificada con un campo `component: "edge"` en su respuesta — **no sustituye** al health del origen ni a `GET /api/health`; es una señal adicional y claramente distinguible, a implementar solo si se identifica una necesidad operacional concreta de monitorear el borde de forma independiente del origen.
- **E. Reglas de Cloudflare sobre el relay de health, sin excepción**:
  - Propaga fielmente `200`/`503` recibidos del origen, sin reinterpretarlos.
  - Trata `502`/`504` como fallo de alcance al origen (el relay no pudo contactar al backend), distinto de un `503` controlado emitido por el propio backend.
  - **Nunca convierte un error en `200`** — ni un fallo de alcance ni un `503` real del origen se transforman en una respuesta exitosa.
  - Usa `Cache-Control: no-store` en la respuesta del relay.
  - **No sirve un resultado exitoso cacheado ante una caída real del origen** — ninguna capa de caché de Cloudflare (Cache API, CDN edge cache) se aplica a esta ruta.

**Esta selección queda cerrada** — no se mantiene como decisión pendiente (sección 35 no la incluye).

## 18. Railway durante transición

- **El health actual de Railway es NO VERIFICADO** — no existe ningún archivo de configuración de Railway en el repositorio.
- **Comparación Railway vs. ECS en staging**: se recomienda, durante el período de validación ya exigido por ADR-011, ejecutar pruebas en paralelo contra ambas plataformas con el mismo tráfico sintético, con monitoreo separado y distinguible por plataforma de origen.
- **Railway no se apaga antes de validar ECS** — principio ya establecido por ADR-011, reafirmado aquí para el aspecto de salud/observabilidad.
- **El health de Railway no sustituye el health de ECS**, ni viceversa.
- **Rollback del relay de Cloudflare**: si ECS presenta un comportamiento de salud inaceptable, el relay puede volver a apuntar hacia Railway (ADR-011, sección 24) — mecanismo exacto no diseñado en este documento.

## 19. CatastroX

Sin cambios de fondo: `GET /api/health/ready/catastrox` evalúa PostGIS y los esquemas `catastrox`/`catastrox_clean`/`gis` — **su resultado no afecta** `ready/ganaderia`. Wompi: no crítica del servicio completo, tratada como error funcional de negocio, no de disponibilidad de instancia. Históricamente los entregables se generaban client-side; ADR-013 exige generación inicial server-side para artifacts pagados, implementación que sigue pendiente. Por tanto, la duración real futura de solicitudes/jobs debe medirse y no inferirse solo desde el CRUD actual. Esta sección no adelanta ni modifica la condición de migración de CatastroX, gobernada exclusivamente por ADR-006.

## 20. Migraciones y compatibilidad de esquema

Sin cambios de fondo: principio **expand-and-contract** recomendado explícitamente — migración aditiva compatible con el código actual y el nuevo, coexistiendo durante un despliegue rolling (sección 15), antes de una migración de contracción posterior. **Ningún health check ejecuta ninguna migración.** `schema_incompatible` hace fallar **la readiness del dominio afectado**, mientras que **el health de plataforma permanece sano** (`200`).

## 21. Graceful shutdown

*Secuencia reformulada conforme a la Corrección 1 y al Ajuste complementario D.*

**Secuencia obligatoria**, alineada con el ciclo de vida de tarea/target verificado en la sección 3:

1. La tarea entra en `DEACTIVATING`; ECS desregistra el *target* del ALB.
2. El *target* entra en `draining`: el ALB deja de enviarle solicitudes **nuevas**, permitiendo que las solicitudes **activas** se completen dentro del `deregistration delay`.
3. **En paralelo a ese drenaje a nivel de ALB**, cuando la tarea llega a `STOPPING`, ECS envía `SIGTERM` al contenedor (por defecto).
4. **Manejador de `SIGTERM` idempotente**: seguro de invocar más de una vez sin reiniciar el proceso de cierre ni causar comportamiento inesperado.
5. Marcar una **bandera interna `shuttingDown`**, consultada por el resto de la lógica de la aplicación.
6. **`server.close()`**: dejar de aceptar conexiones nuevas, sin cerrar las ya activas.
7. **Drenar solicitudes activas**: permitir que las solicitudes ya en curso terminen normalmente.
8. **Cerrar el pool de PostgreSQL `agx`** de forma explícita y controlada.
9. **Cerrar el pool de PostgreSQL de CatastroX** (`catastroxDb.js`) de forma explícita y controlada.
10. Todo lo anterior debe completarse dentro de un **timeout interno de la aplicación estrictamente menor que `stopTimeout`** (30 segundos por defecto, rango 2-120 segundos, sección 3) — el margen entre ambos permite que el registro de cierre (paso 11) y cualquier limpieza final ocurran antes del límite duro de ECS.
11. **Registro (logging) obligatorio** de: inicio del *shutdown*; éxito del *shutdown*; error durante el *shutdown* (si ocurre); y, si aplica, cierre forzado (evidenciado indirectamente si el proceso no llegó a registrar su propio cierre exitoso antes de terminar).
12. ECS envía `SIGKILL` únicamente si el proceso no terminó dentro de `stopTimeout`.

**Señales manejadas**:

- **`SIGTERM`**: señal operativa — la que ECS envía en producción; es la que dispara la secuencia anterior.
- **`SIGINT`**: manejada de forma equivalente, para uso en desarrollo/entorno local (interrupción manual del proceso, `Ctrl+C`), no para el ciclo de vida de ECS en sí.

**Análisis adicional**:

- **Orden entre readiness/health y `server.close()`**: el servidor deja de aceptar conexiones nuevas (paso 6) tan pronto como se recibe `SIGTERM` (paso 3-4), lo cual ya ocurre **después** de que el ALB inició el drenaje del *target* (pasos 1-2, según la secuencia verificada) — no antes, y no de forma desincronizada: el `server.close()` refuerza, a nivel de aplicación, algo que el ALB ya empezó a nivel de red.
- ***Keep-alive***: las conexiones HTTP persistentes existentes deben permitirse completar su solicitud en curso.
- **Conexiones WebSocket**: no existen hoy en el código verificado — no se diseña un tratamiento específico.
- **Solicitudes largas**: cualquier solicitud cuya duración esperada se acerque a `stopTimeout` es un riesgo de corte abrupto — dato de duración real de solicitudes no verificado (sección 3), acción requerida (sección 32).
- **Errores durante el cierre**: un error al cerrar un pool no debe impedir que el resto de la secuencia continúe ni que el proceso finalice dentro del plazo — se registra como error (paso 11) sin bloquear el resto de la secuencia.

**Sesiones BFF**: sobreviven al reemplazo de tarea porque están referenciadas en PostgreSQL, no en memoria de la tarea (ADR-009).

## 22. Deregistration delay y stopTimeout

*Relación reformulada conforme a la Corrección 1 — fases distintas y secuenciales, no una carrera.*

- **`deregistration delay`**: gobierna exclusivamente la fase de **drenaje del *target*** en el ALB — desde que la tarea entra en `DEACTIVATING`/el *target* en `draining`, hasta que el *target* pasa a `unused` (sección 3, pasos 1-5). Valor por defecto verificado: **300 segundos**, rango **0-3600 segundos**.
- **`stopTimeout`**: gobierna exclusivamente la fase de **parada del contenedor** — desde que la tarea entra en `STOPPING` y ECS envía `SIGTERM`, hasta que envía `SIGKILL` si el proceso no terminó por sí mismo (sección 3, pasos 6-9). Valor por defecto verificado: **30 segundos**, rango **2-120 segundos**.
- **No son parámetros equivalentes ni simultáneos**: son fases distintas del mismo ciclo de parada de tarea, verificadas como secuenciales (el drenaje del *target* es anterior al envío de `SIGTERM`, sección 3) — la diferencia numérica entre sus valores por defecto (300 s vs. 30 s) **no representa una carrera entre dos relojes que arrancan al mismo tiempo**; representa dos presupuestos de tiempo distintos para dos etapas distintas.
- **Relevancia práctica de ambos, igualmente**: ambos deben configurarse según la duración real máxima de las solicitudes de negocio de AgroGenomaX — el `deregistration delay` para que ninguna solicitud activa al momento de iniciar el drenaje se corte antes de completarse; el `stopTimeout` para que el propio proceso tenga margen suficiente de completar su secuencia de cierre ordenado (sección 21, pasos 4-11) antes de recibir `SIGKILL`.
- **Dato pendiente de medición**: la duración real de las solicitudes de negocio de AgroGenomaX no está medida (sección 3). Históricamente los entregables de CatastroX se generaban client-side, pero ADR-013 exige generación inicial server-side para artifacts pagados; por tanto, la duración futura de solicitudes/jobs debe medirse y esta anticipación **no sustituye la medición real**, acción requerida (sección 32).
- **Verificación empírica obligatoria en staging**: el gate de staging ya exigido por ADR-011 (sección 14.1) debe incluir explícitamente la observación del comportamiento real de ambas fases (conexiones activas durante el drenaje; tiempo real que toma la secuencia de cierre ordenado de la aplicación) antes de fijar valores definitivos distintos de los valores por defecto verificados en este documento.
- **Comportamiento durante un despliegue canario**: cada tarea reemplazada durante un despliegue rolling atraviesa este mismo ciclo de dos fases — un `deregistration delay` excesivamente largo ralentiza el propio despliegue; uno excesivamente corto arriesga cortar solicitudes activas.

## 23. Caché y Service Worker

Sin cambios de fondo: `Cache-Control: no-store` obligatorio en toda respuesta HTTP de health, en todas las capas (origen, relay de Cloudflare, sección 17.E); distinción explícita entre esta prohibición de caché HTTP y la caché interna muy breve de resultados de dependencia (sección 14); **verificación pendiente** de que el Service Worker excluye explícitamente `/api/health*` de cualquier estrategia de caché o *fallback* — acción requerida (sección 32).

## 24. Mantenimiento

Sin cambios de fondo: activación manual/controlada; readiness del dominio en `503`; health de plataforma en `200` mientras el proceso siga vivo; **no se asume que un `503` funcional de readiness retira, por sí solo, la tarea del ALB** — si se requiere retirar tráfico total de una tarea o de todo el servicio por mantenimiento, debe usarse una operación explícitamente gobernada (reducción controlada del `desiredCount`, desregistro explícito del *target*, un despliegue con el nuevo estado, conforme a ADR-003/010). El modo mantenimiento no se usa para ocultar un incidente no investigado.

## 25. Observabilidad

**Métricas mínimas**:

- *Target health* del ALB (agregado y por *target group*).
- ECS: tareas deseadas/en ejecución/pendientes; reinicios de tarea; fallos de despliegue.
- CPU/memoria por tarea.
- Tiempo de respuesta (del *target* y agregado).
- `HTTP 5xx` y `HTTP 503` desglosados por dominio (Ganadería/CatastroX).
- Tiempo de respuesta del *target* en el *health check* del ALB.
- Eventos de desregistro y su duración real observada (fase de `deregistration delay`, sección 22).
- Duración real de la secuencia de cierre ordenado de la aplicación (fase de `stopTimeout`, sección 21).
- Instancias de `stopTimeout` alcanzado (cierre forzado con `SIGKILL`) — señal de que el presupuesto de cierre ordenado fue insuficiente.
- **Tiempo hasta el primer *target* `healthy`** tras el arranque de una tarea (sección 5.4).
- Pool de PostgreSQL: conexiones totales, activas, ociosas, en espera — por tarea y agregadas.
- *Timeouts* de base de datos, desglosados por causa (sección 14).
- Incompatibilidad de esquema detectada.
- Errores `502`/`504` originados en Cloudflare, distintos de `503` propios del backend (sección 17.E).
- Comparación Railway vs. ECS durante la transición (sección 18).

**Logs mínimos, sin secretos**: inicio y cierre del proceso (con éxito/error explícitos, sección 21 paso 11); señal recibida (`SIGTERM`/`SIGINT`); cambios de estado de *target health*; cambios de estado de readiness por dominio; fallo y recuperación de una dependencia; incompatibilidad de migración detectada; revisión de despliegue asociada; identificador de tarea; *correlation ID*. **Nunca** secretos, credenciales, tokens, ni `error.message` crudo del driver `pg`.

## 26. Alertas

| Condición | Severidad | Umbral/ventana |
|---|---|---|
| Cero *targets* saludables | **Crítica** | Inmediata |
| *Targets* `unhealthy` repetidos | Alta | Persistencia más allá de una ventana corta |
| `desiredCount` ≠ `runningCount` de forma sostenida | Alta | Ventana |
| Despliegue fallido (circuit breaker o alarma de CloudWatch) | Alta | Inmediata al confirmarse |
| *Rollback* disparado | Media, informativa | Registro obligatorio |
| Tareas reiniciándose repetidamente | Alta | Umbral de N reinicios en una ventana |
| `ready/ganaderia` en `503` sostenido | **Crítica** para Ganadería, sin afectar CatastroX | Ventana |
| `ready/catastrox` en `503` sostenido | **Crítica** para CatastroX, sin afectar Ganadería | Ventana |
| RDS caído | **Crítica** | Múltiples tareas reportando `database_unreachable` en la misma ventana |
| Pool agotado | Alta | Antes de indisponibilidad total |
| Cognito caído | Media, no crítica automáticamente | Solo crítica si es sostenida y prolongada |
| Cloudflare no alcanza el origen (`502`/`504`) | Alta | Distinto de `503` controlado |
| Railway/ECS divergentes durante la transición | Media, de seguimiento | Comparación explícita |
| `stopTimeout` alcanzado (cierre forzado) | Alta | Cada ocurrencia registrada; alerta si es recurrente |
| Latencia elevada | Media | Ventana |

Ninguna alerta se dispara por un evento aislado sin ventana ni umbral.

## 27. Recuperación operativa

*Runbooks conceptuales — ninguno se ejecuta como parte de este ADR.*

| Incidente | Detección | Confirmación | Qué no hacer | Mitigación | Recuperación | Verificación |
|---|---|---|---|---|---|---|
| Proceso Node no responde | Health de plataforma sin respuesta | Logs de la tarea | No reiniciar en bucle sin investigar | El *target group* marca la tarea no saludable | Investigar causa raíz | Confirmar health de plataforma estable tras el reemplazo |
| Tarea ECS `unhealthy` | Métrica de *target health* | Revisar logs/métricas de la tarea | No asumir un problema de PostgreSQL (el *target group* no lo evalúa) | Esperar el reemplazo automático de ECS si corresponde | Confirmar readiness de ambos dominios | Revisar si el fallo fue de proceso o de configuración |
| *Target* en `draining` excesivo | Métrica de duración de desregistro anómala | Verificar si hay solicitudes realmente activas o un cierre colgado | No forzar la terminación sin verificar | Investigar si `stopTimeout` se alcanzó | Ajustar `deregistration delay`/`stopTimeout`/lógica de cierre según lo observado (sección 22) | Confirmar que futuros ciclos terminan dentro del plazo esperado |
| Despliegue defectuoso | *Circuit breaker* o alarma de CloudWatch | Comparar revisión nueva vs. anterior | No forzar tráfico hacia la revisión nueva | Rollback (automático o manual) | Corregir el defecto, redesplegar por el flujo gobernado | Confirmar *target health* estable antes de cerrar el incidente |
| PostgreSQL caído | Readiness `503` con `database_unreachable` en múltiples tareas | Verificar RDS directamente | No reintentar agresivamente | Escalar al proveedor/administrador de RDS | Restaurar RDS; confirmar recuperación | Revisar el pool tras la recuperación |
| Pool agotado | `pool_exhausted` | Confirmar volumen de tráfico o fuga de conexiones | No aumentar el pool sin verificar el límite de RDS | Escalar horizontalmente solo si RDS tiene margen | Ajustar dimensionamiento (sección 15) | Monitorear conexiones tras el ajuste |
| Esquema incompatible | `schema_incompatible` | Confirmar versión real de esquema | No migrar de emergencia sin revisión (ADR-003/010) | Revertir a código compatible si es más rápido | Migrar por el proceso gobernado, *expand-and-contract* | Confirmar readiness del dominio tras la migración/rollback |
| Cognito caído | Métrica de fallos elevada | Confirmar estado de Cognito de forma independiente | No convertir en `503` de readiness general | Ninguna acción posible sobre Cognito en sí | Esperar recuperación | Confirmar login funcional tras la recuperación |
| Cloudflare no alcanza el origen | `502`/`504` sin que el backend reporte problemas | Confirmar estado del origen directamente | No asumir el backend caído solo por el error del relay | Verificar configuración de red entre Cloudflare y ECS | Corregir configuración del relay | Confirmar acceso exitoso tras la corrección |
| Railway requerido como rollback | Comportamiento inaceptable de ECS | Confirmar con métricas comparativas (sección 18) | No apagar Railway antes de esta decisión | Apuntar el relay de Cloudflare hacia Railway | Investigar la causa en ECS antes de reintentar | Confirmar estabilidad antes de reintentar |
| Cero *targets* saludables | Alerta crítica | Verificar si es fallo de proceso o dependencia mal incluida en el *health check* | No escalar horizontalmente sin diagnóstico | Depende de la causa raíz | Depende de la causa | Confirmar *target health* recuperado |
| `target healthy` con dominio no disponible mal diagnosticado como incidente de plataforma | Reporte de negocio sin que el *target health* lo refleje (comportamiento esperado, sección 8) | Revisar readiness del dominio específico, no el *target health* | No ampliar el *target group* para incluir la dependencia (violaría la sección 8) | Corregir la cobertura del endpoint de readiness si el dominio no la reportaba | Verificar que readiness ahora sí refleja el escenario | Añadir el caso a pruebas de verificación |

## 28. Matriz de estados

| Estado | Health plataforma (`/live`) | Ready Ganadería | Ready CatastroX | ALB | Acción |
|---|---:|---:|---:|---|---|
| Iniciando | Sin respuesta hasta escuchar, luego `200` dentro del `healthCheckGracePeriodSeconds` | `503` | `503` | No enruta hasta el primer `200` sostenido (umbral saludable) | Esperar arranque (señales de la sección 5.4) |
| Operativo | `200` | `200` | `200` | Enruta | Normal |
| RDS caída | `200` | `503` (`database_unreachable`) | `200` si independiente | Sigue enrutando (el *target group* no evalúa PostgreSQL) | Alertar (crítica); recuperar RDS; ninguna acción automática de reemplazo de tarea |
| PostGIS caída | `200` | `200` | `503` | Sigue enrutando | Alertar (crítica para CatastroX); recuperar |
| Proceso muerto/*deadlock* | Fallo (sin respuesta) | Irrelevante | Irrelevante | *Target* marcado `unhealthy`, reemplazo tras superar el umbral | ECS reemplaza la tarea |
| `DEACTIVATING`/`draining` | `200` mientras el proceso viva | Ya no recibe tráfico **nuevo** vía ALB | Igual | Desregistrando; ALB no envía tráfico nuevo, drena el existente (sección 22) | Esperar el drenaje dentro del `deregistration delay` |
| `STOPPING` | Refleja el `shuttingDown` interno (sección 21) tras `SIGTERM` | Ya sin tráfico nuevo | Igual | Ya en `unused`/completando drenaje | Completar la secuencia de cierre antes de `stopTimeout` |
| Migración incompatible (un dominio) | `200` | `503` (`schema_incompatible`) si afecta a Ganadería | `200` si CatastroX no está afectado | Sigue enrutando | Bloquear la funcionalidad afectada a nivel de aplicación/alerta |
| Mantenimiento | `200` mientras el proceso viva | `503` | `503`, según el alcance declarado | Depende de la operación gobernada elegida (sección 24) | Drenar mediante mecanismo explícito |

## 29. Consecuencias positivas

- Resuelve, con la secuencia oficial de ciclo de vida de tarea/target ahora verificada, la relación entre `deregistration delay` y `stopTimeout`, sin presentarla como una carrera entre relojes desalineados.
- Corrige el rango de `stopTimeout` (2-120 s) y distingue con precisión cuatro parámetros de arranque/parada que antes podían confundirse (`stopTimeout`, `startTimeout`, `healthCheckGracePeriodSeconds`, `startPeriod` de container health check).
- Cierra definitivamente el tratamiento de `functions/api/health.js`, eliminando el *fallback* estático que nunca reflejaba el estado real del backend.
- Evita crear un endpoint de *startup* sin consumidor identificado, apoyándose en señales ya existentes de ECS/ALB.
- Una vez implementada la sanitización global pendiente, elimina la filtración confirmada de `error.message` crudo.
- Separa con precisión la señal que el *target group* del ALB consume de la readiness funcional por dominio.

## 30. Consecuencias negativas

- Introduce trabajo de implementación y validación no trivial: diferenciación de causas de PostgreSQL, readiness restringida, timeouts, sanitización global de errores y coordinación empírica del graceful shutdown ya existente con `stopTimeout`, `deregistration delay` y ECS/ALB real.
- Requiere validar empíricamente, en staging, el comportamiento observado de ambas fases del ciclo de parada (drenaje y cierre de aplicación) antes de fijar valores definitivos distintos de los valores por defecto.
- La decisión de no adoptar un *container health check* deja al *target group* del ALB como único mecanismo de detección — revisable si surge un patrón de fallo no cubierto.
- Convertir `functions/api/health.js` en un proxy real añade una dependencia de disponibilidad del origen para que el propio endpoint de health público responda con información útil (mitigado por el propio contrato `"unavailable"`, que sigue siendo una respuesta válida y útil incluso cuando el origen no responde).

## 31. Riesgos

| Riesgo | Origen | Tratamiento propuesto |
|---|---|---|
| `deregistration delay` y `stopTimeout` configurados sin medir la duración real de las solicitudes | Pendiente de medición (sección 22) | Medición obligatoria antes de fijar valores definitivos; validación empírica en el gate de staging de ADR-011 |
| *Target group* consumiendo, por error de implementación futura, un endpoint que sí evalúa PostgreSQL | Riesgo de desviación durante la implementación | Regla explícita y reiterada (sección 8) |
| `GET /api/health` público deja de reflejar el backend real si la implementación del proxy se degrada a un valor estático en el futuro | Riesgo de regresión | Criterio de aceptación dedicado (sección 33) |
| `error.message` crudo expuesto | Confirmado | Clasificación de causas sin exponer el mensaje crudo (sección 14) |
| Autoescalado aprobado sin validar el pico transitorio de conexiones durante despliegues rolling | Riesgo de dimensionamiento | Cálculo explícito que incluya la coexistencia de tareas antiguas y nuevas (sección 15) |
| Adoptar un *container health check* que consulte PostgreSQL por error | Riesgo de implementación futura | Prohibición explícita, aplicable incluso si se adopta en el futuro (sección 9) |
| Comparación Railway/ECS omitida, apagando Railway prematuramente | Riesgo operativo | Comparación explícita obligatoria durante la transición (sección 18) |
| Confusión entre `stopTimeout`, `startTimeout`, `healthCheckGracePeriodSeconds` y `startPeriod` durante la implementación | Riesgo de diseño | Distinción explícita mantenida en la sección 3 y reiterada en las secciones 8/9/21/22 |

## 32. Acciones requeridas

*(Ninguna se ejecuta como parte de este ADR.)*

- Medir la duración real de las solicitudes de negocio (Ganadería y CatastroX) antes de fijar valores definitivos de `deregistration delay`/`stopTimeout`/*timeouts* de health check.
- Completar `GET /api/health` público mínimo y diseñar/implementar `GET /api/health/ready` (+ variantes por dominio), con la clasificación de causas de la sección 14.
- Mantener y probar el *graceful shutdown* conforme a la secuencia de la sección 21 en ECS/ALB real.
- Mantener `functions/api/health.js` como relay real conforme a la sección 17, sin reintroducir fallback estático.
- Corregir el `errorHandler` para no exponer `error.message` crudo del driver `pg`.
- Verificar explícitamente el comportamiento del Service Worker frente a `/api/health*`.
- Calcular el dimensionamiento del pool de PostgreSQL considerando el pico transitorio de despliegues rolling (sección 15).
- Diseñar y aplicar el mecanismo de restricción de acceso (red o identidad técnica) para los endpoints de readiness por dominio y `GET /api/health/db` (sección 35.A).
- Migrar la función de `GET /api/health/db` hacia `ready/ganaderia` y, tras verificar la ausencia de consumidores restantes, retirar la ruta heredada.
- Diseñar el monitoreo comparativo Railway/ECS durante la transición.
- Alinear el puerto del contenedor configurado en la definición de tarea con el puerto real que Express escucha.

## 33. Criterios de aceptación

- El *target group* del ALB consume exclusivamente `GET /api/health/live`, sin ninguna dependencia externa evaluada.
- `stopTimeout` configurado dentro del rango 2-120 segundos; ningún valor 0 o fuera de rango.
- `GET /api/health` público es, verificablemente, un proxy real hacia el origen — nunca devuelve `pages-static-fallback` ni un valor estático indistinguible de una respuesta real.
- Ningún endpoint de health expone `error.message` crudo, versión, entorno, ni infraestructura interna en su variante pública.
- `Cache-Control: no-store` en toda respuesta HTTP de health, en todas las capas.
- Readiness de Ganadería y de CatastroX son independientes, verificable por prueba.
- Los endpoints de readiness por dominio y `GET /api/health/db` no son alcanzables por el relay público general de Cloudflare.
- Ningún *container health check* de ECS, si se adopta en el futuro, consulta PostgreSQL/Cognito/Wompi/PostGIS.
- El *graceful shutdown* cierra ambos pools de PostgreSQL, respeta `stopTimeout`, y registra inicio/éxito/error/cierre forzado.
- Ningún autoescalado se aprueba sin validar el límite agregado de conexiones a RDS, incluido el pico transitorio de despliegues.
- No existe ningún endpoint `GET /api/health/startup` implementado sin que exista un consumidor operacional concreto documentado.

## 34. Elementos fuera de alcance

- Implementación de código de cualquier tipo.
- Creación de `Dockerfile`, Terraform, *workflows*, alarmas, *dashboards* o cualquier recurso de AWS.
- Modificación de Express, rutas, Cloudflare Pages Functions, ECS, ALB o *target groups*.
- Ejecución de *builds*, pruebas, migraciones, o conexiones a AWS.
- Fijación de valores numéricos definitivos de *timeout*/`deregistration delay`/`stopTimeout` (se establecen los principios y los valores por defecto verificados, no cifras finales de producción).
- Decisión final sobre adoptar un *container health check* de ECS (se descarta para esta fase inicial, no se cierra la puerta a reevaluarlo).
- Resolución de la migración de CatastroX (ADR-006).
- Implementación de `GET /api/edge-health` (queda documentado conceptualmente, no implementado).
- Modificación de cualquier ADR anterior.

## 35. Decisiones de seguimiento

**A. Readiness protegida — mecanismo de acceso**: los endpoints de readiness por dominio (`ready`, `ready/ganaderia`, `ready/catastrox`) y `GET /api/health/db` se restringen a monitoreo autorizado mediante **restricción de red o identidad técnica** (por ejemplo, *security group*/regla de red que limite el origen de la solicitud, o un mecanismo de autenticación de servicio a servicio) — **no se depende de "URL no publicada" como medida de seguridad**, y en ningún caso se exponen a través del relay público general de Cloudflare. El mecanismo exacto (red vs. identidad técnica) queda como decisión de diseño técnico posterior.

**B. Reevaluación de *container health check***: si el *target group* del ALB resulta insuficiente en la práctica para detectar un patrón de fallo real.

**C. Diseño exacto del sistema de versionado/compatibilidad de migraciones de esquema.**

**D. Diseño exacto del monitoreo comparativo Railway/ECS durante la transición.**

**E. Alineación exacta del puerto de contenedor con el puerto real de Express.**

**F. Implementación futura de `GET /api/edge-health`**, solo si se identifica una necesidad operacional concreta de monitorear el borde de Cloudflare de forma independiente del origen.

**G. Umbral exacto para clasificar reinicios repetidos y latencia elevada como alerta.**

**H. Momento y condiciones para retirar definitivamente `GET /api/health/db`** tras confirmar la ausencia de consumidores restantes.

## 36. Relación con ADR anteriores

- **ADR-001**: implementa, sobre la plataforma ya sustituida por ADR-011, el requisito de un endpoint de salud real que ADR-001 ya anticipó.
- **ADR-006**: los checks de CatastroX no adelantan ni modifican su condición de migración.
- **ADR-007**: la validación de `access_token` permanece ajena a los health checks; la caché de JWKS es coherente con sus reglas.
- **ADR-008**: el contexto de RLS/organización nunca se establece dentro de un health check.
- **ADR-009**: la sesión BFF en PostgreSQL permite que el reemplazo de tareas no interrumpa sesiones activas — reforzado en la sección 21.
- **ADR-010**: cualquier infraestructura derivada se crearía vía Terraform bajo la gobernanza ya establecida.
- **ADR-011**: este ADR-012 implementa directamente el diseño de "health de plataforma" ya previsto por ADR-011, ahora con la secuencia de ciclo de vida de tarea/target y los rangos de `stopTimeout`/container health check verificados con precisión.

---

## Anexo A. Diagrama de health checks

```
Navegador ──▶ Cloudflare Pages (frontend estático)
                    │
                    ▼
   functions/api/health.js — PROXY REAL hacia GET /api/health del origen
   (decisión cerrada, sección 17) — nunca fallback estático
                    │
                    ▼
   Endpoint HTTPS de ECS Express Mode (ADR-011, sección 9.1)
                    │
                    ▼
                   ALB
                    │  Target group: GET /api/health/live
                    │  (HTTP, matcher 200, interval 30s*, timeout 5s*,
                    │   healthy=5*, unhealthy=2*,
                    │   healthCheckGracePeriodSeconds 300s*)
                    │  *valores por defecto de Express Mode, verificados
                    ▼
         Tarea(s) Fargate — health de plataforma = liveness
         (proceso vivo, sin dependencias externas)
                    │
        ┌───────────┼─────────────────────────────┐
        ▼           ▼                             ▼
  /api/health   /api/health/live          /api/health/ready(+/ganaderia,
  (proxy real,  (= health de               /catastrox), /api/health/db
   status:       plataforma,               (monitoreo autorizado —
   ok/degraded/  consumido por ALB)         NO expuesto por el relay
   unavailable)                             público general)
                                                  │
                          ┌───────────────────────┼───────────────────┐
                          ▼                       ▼                   ▼
                  PostgreSQL (agx)         Cognito/JWKS         PostGIS/CatastroX
                  select 1, timeout        caché con TTL,       (independiente
                  estricto, causas         NUNCA bloqueante      de Ganadería)
                  clasificadas

(Opcional, solo si surge necesidad concreta)
Cloudflare: GET /api/edge-health — component: "edge" — NO sustituye al origen
```

## Anexo B. Matriz de dependencias críticas

*Ver sección 6 — reproducida por referencia.*

## Anexo C. Contratos JSON conceptuales

**`GET /api/health` (público, proxy real)**:
```json
{ "status": "ok", "timestamp": "..." }
```
```json
{ "status": "degraded", "timestamp": "..." }
```
```json
{ "status": "unavailable", "timestamp": "..." }
```

**`GET /api/health/live` (health de plataforma = liveness, consumido por el target group)**:
```json
{ "status": "ok", "timestamp": "..." }
```

**`GET /api/health/ready` (monitoreo autorizado)**:
```json
{ "status": "ok", "domains": { "ganaderia": "ok", "catastrox": "ok" } }
```

**`GET /api/health/ready/ganaderia`**:
```json
{ "status": "ok", "checks": { "database": "ok" }, "duration_ms": 0 }
```

**`GET /api/health/ready/catastrox`**:
```json
{ "status": "ok", "checks": { "postgis": "ok" }, "duration_ms": 0 }
```

*(sin versión, entorno, commit, ni causa detallada en los contratos públicos — reservado a diagnóstico protegido/logs/métricas, sección 11)*

## Anexo D. Matriz ALB/ECS/health funcional

| Componente | Evalúa | Consumido por |
|---|---|---|
| Target group del ALB | Health de plataforma / liveness (`/api/health/live`) | ECS (enrutamiento y reemplazo de tareas) |
| Readiness general/por dominio | Dependencias críticas por dominio | Monitoreo autorizado |
| *Container health check* (no adoptado en esta fase) | N/A | N/A — decisión de seguimiento |
| `/api/health` público | Estado resumido real del origen (proxy) | Humanos, monitoreo externo |
| `/api/edge-health` (conceptual, no implementado) | Health del borde de Cloudflare | Monitoreo del borde, si se implementa |

## Anexo E. Ciclo de vida de tarea/target y graceful shutdown

```
Tarea DEACTIVATING
        │
        ▼
ECS desregistra el target del ALB
        │
        ▼
Target entra en draining
   (ALB deja de enviar solicitudes nuevas;
    permite completar las activas dentro del
    deregistration delay: 300s por defecto, 0-3600s)
        │
        ▼
Target progresa a unused
        │
        ▼
Tarea entra en STOPPING
        │
        ▼
ECS envía SIGTERM (señal de parada por defecto)
        │
        ▼
Aplicación: handler SIGTERM idempotente
        │
        ▼
Marcar bandera interna shuttingDown
        │
        ▼
server.close() — dejar de aceptar conexiones nuevas
        │
        ▼
Drenar solicitudes activas
        │
        ▼
Cerrar pool PostgreSQL agx
        │
        ▼
Cerrar pool PostgreSQL CatastroX
        │
        ▼
Registrar cierre exitoso
   (todo lo anterior dentro de un timeout interno
    estrictamente menor que stopTimeout)
        │
        ▼
ECS espera stopTimeout (30s por defecto, rango 2-120s)
        │
        ▼ (solo si el proceso no terminó)
ECS envía SIGKILL — se registra como cierre forzado
```

## Anexo F. Relación deregistration delay/stopTimeout

| Parámetro | Fase que gobierna | Valor por defecto (verificado) | Rango válido (verificado) |
|---|---|---|---|
| `deregistration delay` (ALB) | Drenaje del target (`DEACTIVATING` → `draining` → `unused`) | 300 s | 0-3600 s |
| `stopTimeout` (ECS/Fargate) | Parada del contenedor (`STOPPING`, `SIGTERM` → `SIGKILL`) | 30 s | **2-120 s** |
| `healthCheckGracePeriodSeconds` (ECS) | Tolerancia del *scheduler* a `unhealthy` durante el arranque | 300 s (Express Mode) | — |
| `startTimeout` (ECS/Fargate) | Arranque del contenedor (incluye `dependsOn`) | No fijado en este documento | — |
| `startPeriod` (container health check) | Arranque, interno al mecanismo `healthCheck` del contenedor | No adoptado en esta fase (sección 9) | 0-300 s |

**Relación**: fases secuenciales y distintas de un mismo ciclo de parada (drenaje primero, parada de contenedor después, según la secuencia verificada del Anexo E) — no una carrera de dos relojes simultáneos. Ambos valores se ajustan según la duración real medida de las solicitudes de negocio (acción requerida, sección 32), validados empíricamente en el gate de staging de ADR-011.

## Anexo G. Runbooks de recuperación

*Ver sección 27 — reproducidos por referencia.*

## Anexo H. Matriz de alertas

*Ver sección 26 — reproducida por referencia.*

## Anexo I. Matriz de trazabilidad ADR-001/003/005/006/007/008/009/010/011 → ADR-012

| ADR | Relación con ADR-012 |
|---|---|
| ADR-001 | Implementa el endpoint de salud real ya anticipado, sobre la plataforma ya sustituida por ADR-011 |
| ADR-003/010 | Gobernanza de Terraform aplicada a cualquier recurso derivado |
| ADR-005 | Los tres niveles de ruta no se alteran |
| ADR-006 | Los checks de CatastroX no adelantan su migración |
| ADR-007 | Validación de `access_token` ajena a los health checks; caché de JWKS coherente |
| ADR-008 | RLS nunca se establece en un health check |
| ADR-009 | Sesión BFF en PostgreSQL, clave para que el reemplazo de tareas no pierda sesiones |
| ADR-011 | Este ADR-012 implementa directamente el diseño de "health de plataforma" ya previsto, con la secuencia de ciclo de vida de tarea/target y los rangos de `stopTimeout`/container health check ahora verificados con precisión |
