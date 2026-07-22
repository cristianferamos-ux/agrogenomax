# ADR-011: Plataforma de ejecución AWS para AgroGenomaX tras el cierre de App Runner

- Estado: Aceptada
- Fecha: 2026-07-18
- Responsables: Equipo técnico AgroGenomaX / CRH Soluciones Integrales S.A.S.

## Precedencia y estado vigente

ADR-011 continúa vigente como decisión de plataforma: Amazon ECS Express Mode es la plataforma objetivo, ECS + Fargate directo mediante Terraform es la contingencia AWS y Railway permanece como rollback temporal. ADR-012 ya existe y gobierna health/liveness/readiness/graceful shutdown. ADR-013 ya existe y gobierna rutas y entregables CatastroX. ADR-014 ya existe y gobierna separación demo/staging/producción. El TAH 1.1 y el plan AWS Fase 0 versión 1.1 ya incorporan estas decisiones.

## 1. Contexto

ADR-001 (Aceptada) seleccionó AWS App Runner como destino del backend Express de AgroGenomaX. Esa decisión conserva valor histórico, pero su elección concreta de plataforma de ejecución debe sustituirse: AWS cerró App Runner a nuevas cuentas (30 de abril de 2026, verificado contra documentación oficial) antes de que AgroGenomaX llegara a desplegar ningún recurso sobre él. Este ADR-011 selecciona la plataforma de ejecución que reemplaza esa decisión, con cinco precisiones finales sobre dominio/TLS, identidad/secretos, red por fases, ciclo de vida del balanceador, y despliegue/rollback verificables.

**Reorganización documental**: este documento es **ADR-011 (plataforma de ejecución)**; health checks/readiness/liveness quedaron aceptados en **ADR-012**; la clasificación de rutas y entregables de CatastroX quedó aceptada en **ADR-013**; la separación demo/staging/producción quedó aceptada en **ADR-014**.

## 2. Problema

AgroGenomaX no puede continuar planificando su despliegue sobre una plataforma que ya no acepta su cuenta como cliente nuevo. Se requiere una sustitución que preserve la gestión simplificada que motivó la elección original, sea compatible con Terraform/RDS privada/Secrets Manager/sesión BFF ya definidos, y mantenga el presupuesto de staging como una condición real — sin dar por sentado, sin verificación previa, cómo se resuelve el dominio público, qué permisos exactos necesita cada identidad de ejecución, si las tareas deben tener IP pública en producción, si el balanceador debe destruirse en cada ventana de staging, ni cómo se garantiza que un rollback realmente revierte a una versión conocida como buena.

## 3. Cambio de disponibilidad de App Runner

Sin cambios respecto de la versión previa: AWS App Runner dejó de aceptar nuevos clientes a partir del 30 de abril de 2026 (verificado); los clientes existentes pueden continuar; App Runner pasa a modo de mantenimiento (actualización de disponibilidad de AWS, 31 de marzo de 2026); el reemplazo recomendado explícitamente por AWS es Amazon ECS Express Mode (lanzado el 21 de noviembre de 2025). La cuenta de AWS de AgroGenomaX fue creada recientemente y el repositorio no contiene evidencia de uso previo de App Runner. **App Runner deja de ser una plataforma candidata viable, salvo evidencia documental extraordinaria en contrario.** No se ejecuta ningún intento de creación facturable para comprobarlo.

## 4. Estado actual verificado

Contexto histórico original: no existían `Dockerfile`, `docker-compose*` ni `.dockerignore`; no existían ECS/ECR/Terraform; `server/package.json` arrancaba con `node index.js`; no había graceful shutdown, liveness ni plan AWS actualizado. Estado actual verificado: `server/index.js` maneja `SIGTERM` y `SIGINT`, existe graceful shutdown, se cierran los pools de `server/db.js` y `server/catastroxDb.js`, existe `/api/health/live`, `functions/api/health.js` es relay real hacia liveness y `docs/AWS_TRANSITION_PLAN_PHASE_0_STAGING.md` ya fue actualizado a versión 1.1. Siguen pendientes `Dockerfile`, Terraform, ECR, ECS, readiness restringida y sanitización global de `error.message`.

**NO VERIFICADO**: si la cuenta de AWS de AgroGenomaX ya tiene algún recurso creado; región de despliegue; si existe ya una VPC definida; volumen de tráfico esperado; **soporte exacto de dominio personalizado y asociación de certificado ACM propio en ECS Express Mode** (corrección 1, no confirmado contra documentación en esta sesión); comportamiento exacto de rotación de secretos inyectados en tareas Fargate ya en ejecución (corrección 2); comportamiento verificado de rollback/canary de Express Mode en la práctica (corrección 5, solo documentado, no probado).

## 5. Requisitos obligatorios

1. Compatible con Terraform como única herramienta de IaC (ADR-003/010).
2. Conexión privada a RDS, sin exposición pública de la base de datos.
3. Integración con Secrets Manager, sin `tfvars` versionados con secretos (ADR-010).
4. Compatible con el patrón de sesión BFF de ADR-009 (sesión en PostgreSQL, sin afinidad de sesión entre tareas).
5. *Health check* único, HTTP, configurable, compatible con el diseño de "health de plataforma" de ADR-012.
6. Compatible con GitHub Actions vía OIDC, sin Access Keys permanentes.
7. Respeta el presupuesto de USD 25/mes para staging, sin asumir que cubre producción.
8. **No se afirma todavía que el certificado ACM automático cubre un dominio personalizado, ni que ese dominio puede asociarse al ALB sin restricciones — la topología inicial mantiene el navegador same-origin vía el relay de Cloudflare, sin exponer directamente ningún dominio de AWS** (corrección 1).
9. **Los roles de ejecución de tarea, de tarea, y de infraestructura se mantienen separados, con permisos mínimos distintos cada uno; ningún secreto se registra en logs, se incluye en la imagen, ni se declara como variable Terraform en texto plano** (corrección 2).
10. **Las tareas con IP pública se limitan inicialmente a staging; producción requiere superar un gate formal de evaluación de red antes del primer `apply` productivo** (corrección 3).
11. **El ALB no se destruye automáticamente en cada ventana de staging por decisión de este documento — su ciclo de vida se decide únicamente tras validar empíricamente creación, destrucción, estado `DRAINING` y costo residual** (corrección 4).
12. **Todo despliegue y rollback se referencia por *digest* inmutable de imagen, nunca por `latest`; ningún comportamiento de rollback se afirma como verificado sin haberse probado en staging** (corrección 5).
13. Railway se conserva como plataforma temporal durante la transición, sin apagarse antes de validar AWS.
14. No se autoriza ninguna implementación, conexión a AWS, creación de recursos, `Dockerfile`, Terraform ni *workflow* como parte de esta tarea.
15. ADR-001 a ADR-010 no se modifican; este documento registra qué decisión de ADR-001 sustituye.
16. La migración de CatastroX permanece condicionada por ADR-006.

## 6. Alternativas evaluadas

### 6.1 ECS Express Mode

Sin cambios respecto de la versión previa: lanzado el 21 de noviembre de 2025, disponible en todas las regiones, sin cargo adicional por la capacidad en sí. Crea automáticamente: clúster ECS con Fargate, definición de tarea, servicio con despliegue canario y autoescalado, **ALB con listener HTTPS y certificado ACM**, grupos de seguridad mínimos, roles vinculados al servicio, grupo de logs de CloudWatch, alarma de despliegues defectuosos. Soporta definiciones de tarea personalizadas y despliegue vía Terraform. **Riesgo de madurez explícito**: ~8 meses de antigüedad al momento de esta decisión.

**Precisión de esta corrección (corrección 1)**: el certificado ACM y el *endpoint* HTTPS que Express Mode crea automáticamente **corresponden, por defecto, al ALB y su nombre DNS generado por AWS** — no está verificado en esta sesión que ese certificado cubra, ni que el listener permita asociar sin restricciones adicionales, un dominio personalizado de AgroGenomaX (por ejemplo, un subdominio de `agrogenomax.com`). Este ADR no afirma esa capacidad como disponible; la topología inicial (sección 9) no depende de ella.

### 6.2 Amazon ECS con Fargate administrado directamente

Sin cambios respecto de la versión previa — contingencia documentada, mismos recursos subyacentes que 6.1, con control total y mayor complejidad operativa.

### 6.3 AWS Elastic Beanstalk

Sin cambios respecto de la versión previa — activamente mantenido, no descartado por inmadurez, pero no es el reemplazo posicionado explícitamente por AWS para App Runner.

### 6.4 AWS Lambda + API Gateway o Function URL

Sin cambios respecto de la versión previa — técnicamente viable vía AWS Lambda Web Adapter (proyecto oficial), no seleccionada por el riesgo de conexiones a PostgreSQL no acotadas en un modelo de ejecución efímera de alta concurrencia, y por la menor compatibilidad con el modelo de graceful shutdown de larga duración.

### 6.5 Mantener Railway temporalmente

Sin cambios — Railway ya es la plataforma real de producción hoy; se conserva como rollback durante toda la transición, sin apagarse prematuramente.

### 6.6 Otras alternativas

Sin cambios — descartadas por falta de justificación técnica frente a las alternativas ya analizadas.

## 7. Matriz comparativa

Sin cambios de fondo respecto de la versión previa (ver Anexo B) — se añade una fila de "Dominio personalizado verificado" marcada como NO VERIFICADO para todas las alternativas de AWS, y una fila de "Rollback verificado empíricamente" marcada como pendiente de prueba en staging para ECS Express Mode/ECS+Fargate (corrección 5).

## 8. Decisión de plataforma

Se mantiene, sin cambios, la decisión central ya aprobada: **Amazon ECS Express Mode** como plataforma de ejecución objetivo, **ECS + Fargate configurado directamente vía Terraform** como contingencia documentada explícita, y **Railway como plataforma temporal durante toda la transición**. Se incorporan, como parte integral de la decisión, las cinco precisiones de esta ronda: (1) dominio y TLS sin suposiciones, manteniendo al navegador same-origin vía Cloudflare sin exponer un dominio de AWS; (2) roles IAM de ECS separados con precisión (ejecución/tarea/infraestructura) y rotación de secretos explícitamente no automática; (3) red por fases — IP pública de tareas limitada a staging, con gate formal antes de producción; (4) ciclo de vida del ALB decidido tras validación empírica, no por un criterio absoluto de destrucción en cada ventana; (5) despliegue y rollback referenciados siempre por *digest* inmutable, con un gate de staging obligatorio que pruebe canario, fallo de *health check*, rollback por alarma y rollback manual antes de considerar el comportamiento verificado.

## 9. Arquitectura de red

*Corrección obligatoria 1 y 3 — reemplaza la topología de dominio de la ronda anterior y limita las tareas públicas a staging.*

### 9.1 Topología inicial de dominio y TLS (corrección 1)

**Topología aprobada, sin suponer soporte de dominio personalizado**:

```
Navegador ──▶ Cloudflare Pages Function (relay same-origin, ADR-009)
                    │
                    ▼
      Endpoint HTTPS generado automáticamente por ECS Express Mode
      (nombre DNS del ALB, certificado ACM automático — NO un
       dominio personalizado de AgroGenomaX)
                    │
                    ▼
                  ALB ──▶ Tarea Fargate
```

- **El navegador permanece same-origin respecto de AgroGenomaX** en todo momento: solo interactúa con Cloudflare, exactamente como hoy con CatastroX/Railway. El relay de Cloudflare (variable de entorno `API_BACKEND_URL` o equivalente, mismo patrón ya verificado en `functions/api/catastrox/[[path]].js`) apunta internamente al *endpoint* HTTPS que Express Mode genera automáticamente.
- **No se necesita, en esta fase inicial, exponer un dominio personalizado de AWS directamente al navegador** — el TLS entre el navegador y AgroGenomaX sigue siendo enteramente gestionado por Cloudflare (como hoy); el TLS entre Cloudflare y AWS usa el certificado ACM automático del ALB, sobre el nombre DNS que AWS asigna, sin que el navegador lo vea jamás.
- **No se afirma** que este certificado automático cubra ni pueda cubrir un dominio como `api.agrogenomax.com`, ni que el listener del ALB permita asociar un certificado propio sin restricciones — ninguna de estas capacidades está verificada en esta sesión.

**Decisiones de seguimiento registradas explícitamente (no resueltas en este documento)**:

- Soporte exacto de *custom domain* en ECS Express Mode (si existe un mecanismo dedicado, o si requiere gestionarlo fuera de Express Mode, directamente sobre el ALB subyacente).
- Asociación de un certificado ACM propio de AgroGenomaX al listener HTTPS.
- Mutabilidad del listener del ALB después de creado (la documentación ya revisada en la ronda anterior indica que "la configuración de balanceador de carga no puede actualizarse" en un servicio Express Mode — relevante y a confirmar específicamente para el listener/certificado).
- Validación DNS del certificado en Cloudflare (registro CNAME de validación).
- Renovación del certificado (automática si es gestionado por ACM, a confirmar si aplica igual a un certificado personalizado).
- Si conviene, en el futuro, colocar el proxy de Cloudflare directamente delante del ALB con un dominio propio, en vez de mantener la resolución interna del *endpoint* generado por AWS.
- Impacto de cualquiera de estas decisiones sobre el *path*/certificado que el *health check* del grupo de destino evalúa.

### 9.2 Red por fases (corrección 3)

**Staging (vigente para la fase inicial de este ADR)**:

- ALB de cara a internet (*internet-facing*).
- Tareas Fargate en subredes públicas, con `assignPublicIP` habilitado (comportamiento por defecto de Express Mode al usar subredes públicas).
- **El grupo de seguridad de la tarea acepta ingreso únicamente desde el grupo de seguridad del ALB** — ningún puerto de la tarea queda abierto directamente a internet, pese a que la tarea tenga IP pública (la IP pública es para su propia salida vía Internet Gateway, no para recibir conexiones entrantes no autorizadas).
- RDS en subredes privadas, sin acceso público, con su grupo de seguridad restringido al grupo de seguridad de la tarea.
- Sin NAT Gateway (evita su costo permanente, ~USD 32/mes fijo más cargo por GB, ya calculado en la ronda anterior).
- TLS y registro de logs obligatorios, sin excepción.

**Gate obligatorio antes de producción — bloqueante, no ejecutado en este ADR**:

1. Evaluar formalmente tareas públicas (con IP pública, sin NAT) frente a tareas privadas (sin IP pública, requiriendo NAT o VPC endpoints para salida).
2. Considerar NAT Gateway **por zona de disponibilidad** si se opta por subredes privadas (para no introducir latencia/costo de tráfico entre zonas, TAH v1.0/ADR-010 misma disciplina de costos).
3. Considerar VPC endpoints para Secrets Manager/CloudWatch/ECR como alternativa parcial a NAT.
4. Considerar específicamente la salida hacia Wompi y Cognito (servicios públicos externos que, hasta donde se verificó, no tienen un mecanismo de *endpoint* privado equivalente confirmado en esta sesión).
5. Estimar el costo real de cada opción con tarifario oficial vigente al momento de la decisión.
6. Revisar requisitos de cumplimiento y seguridad aplicables a producción (no identificados hoy en ningún ADR previo, pero no descartados).
7. **Documentar la decisión final antes del primer `apply` productivo** — no se autoriza un corte a producción sin esta documentación explícita.

**Regla explícita de esta corrección**: **no se aprueba, en este ADR, que las tareas con IP pública sean la topología productiva definitiva** — es la topología de staging aprobada para esta fase inicial, sujeta a revisión formal en el gate anterior antes de heredarse (o no) a producción.

## 10. Contenedores y ECR

*Reforzado por la corrección 5 y el ajuste complementario A.*

- **Sin `Dockerfile` hoy** (confirmado, sección 4) — su creación es acción requerida (sección 28).
- **Definición de tarea (ajuste complementario A)**: versión de Node fijada explícitamente (hoy no fijada en ningún `package.json` del backend); **usuario no root** dentro del contenedor; CPU/memoria explícitos (no los valores por defecto de Express Mode sin revisión); variable `PORT` coherente con lo que `server/index.js` ya usa (`process.env.PORT || 3000`); configuración de *logging* explícita; `stopTimeout` ajustado al presupuesto de *graceful shutdown* de ADR-012 (Express Mode usa 30 segundos por defecto, a confirmar si es suficiente); **sistema de archivos de solo lectura cuando sea viable** (el backend no escribe archivos en disco, confirmado en auditorías previas de este proceso; ADR-013 exige generación inicial server-side para artifacts pagados, por lo que la estrategia de archivos temporales/streaming/almacenamiento debe validarse antes de fijar solo lectura); arquitectura x86_64 o ARM64 **probada explícitamente** antes de fijarse (ARM/Graviton es más económico, sección 21, pero requiere confirmar compatibilidad de todas las dependencias nativas, si las hubiera); secretos referenciados por ARN, nunca embebidos; **rol de ejecución y rol de tarea separados** (sección 13).
- **Versionado de imágenes**: cada *build* de CI produce una imagen etiquetada con un *tag* y, de forma obligatoria, se referencia por su **digest** inmutable (`sha256:...`) en el despliegue — nunca por `latest` ni por un *tag* mutable reutilizado (sección 24).
- **ECR**: costo marginal de almacenamiento por GB de imágenes.

## 11. Integración con RDS

*Reforzado por el ajuste complementario C.*

Sin cambios de fondo en la decisión de RDS privada, sin acceso público, TLS pendiente de implementación (ADR-001). **Dimensionamiento del pool de conexiones (corrección complementaria C)**: el límite agregado de conexiones que las tareas de AgroGenomaX pueden abrir contra RDS se calcula como **pool máximo configurado por tarea × número máximo de tareas permitido por el autoescalado** (sección 15) — no como un valor fijo pensado para una sola tarea. Este cálculo debe **reservar margen explícito** para: conexiones administrativas/de diagnóstico, la ejecución de migraciones, las propias consultas de *health check* (con las salvaguardas ya diseñadas en el futuro ADR-012: inspección de pool sin red, deduplicación, caché interna breve), y escenarios de recuperación tras un incidente (por ejemplo, una ráfaga de reconexión). **No se aprueba ninguna configuración de autoescalado de tareas en este documento sin haber validado, explícitamente, que el límite agregado de conexiones resultante no excede el máximo de conexiones que la instancia de RDS permite** — esta validación es una acción requerida (sección 28), no resuelta aquí.

## 12. Integración con Cloudflare

*Reforzado por el ajuste complementario B.*

Sin cambios de fondo en el patrón de relay same-origin ya aprobado (ADR-009), ahora apuntando al *endpoint* de Express Mode conforme a la topología de la sección 9.1 (sin dominio personalizado en esta fase). **Se exige repetir, íntegramente, el gate técnico de verificación de cookies ya definido por ADR-009** (sección 8 de ADR-009), esta vez contra el *endpoint* real de ECS Express Mode, no asumiendo que el comportamiento verificado (o pendiente de verificar) contra Railway o contra una suposición genérica de "un proxy cualquiera" se traslada automáticamente:

- Reenvío correcto de la cabecera `Cookie` desde el navegador hacia el backend a través del relay.
- Reenvío correcto de **una y de múltiples** cabeceras `Set-Cookie` en la respuesta.
- Preservación de los *redirects* del flujo OAuth (ADR-009, transacción de autenticación pendiente) a través del relay y del ALB.
- Preservación de los atributos `Secure`, `SameSite`, y de la expiración de cada cookie.
- Preservación de `Cache-Control: no-store` en las respuestas correspondientes, sin que ningún componente intermedio (Cloudflare, el ALB) las cachee.

**Ninguna sesión BFF se considera funcional sobre esta plataforma hasta que este gate se repita y se supere explícitamente** contra el *endpoint* real de ECS Express Mode — no se hereda automáticamente del diseño teórico de ADR-009.

## 13. Identidad, secretos y Cognito

*Corrección obligatoria 2 — separación explícita de roles y precisión sobre rotación.*

### 13.1 Roles IAM de ECS, separados con precisión

- **A. Rol de ejecución de tarea (*task execution role*)**: usado por la infraestructura de ECS/Fargate para operar la tarea, **no por el código de la aplicación**. Permisos: extracción (*pull*) de la imagen desde ECR; escritura de logs en CloudWatch; **lectura de los secretos referenciados en la definición de tarea** (para poder inyectarlos como variables de entorno al arrancar el contenedor); `kms:Decrypt` cuando el secreto esté cifrado con una clave KMS que lo requiera. **Nunca** permisos de negocio ni acceso directo a RDS/Cognito por parte de este rol.
- **B. Rol de tarea (*task role*)**: el que queda disponible **para el código dentro del contenedor**, **solo si la aplicación necesita invocar directamente alguna API de AWS** (por ejemplo, si en el futuro el backend necesitara llamar a Secrets Manager en tiempo de ejecución más allá de la inyección inicial, o a algún otro servicio de AWS) — hoy, dado que `server/index.js` no invoca ninguna API de AWS directamente (confirmado en auditorías previas: sin SDK de AWS en `package.json`/`server/package.json`), este rol puede definirse con el mínimo privilegio posible, potencialmente vacío de permisos adicionales hasta que exista una necesidad concreta. **Separado, sin excepción, del rol de ejecución** — un compromiso del código de la aplicación (por ejemplo, una vulnerabilidad de inyección) queda acotado a los permisos de este rol, nunca a los de extracción de imagen/lectura de secretos del rol de ejecución.
- **C. Rol de infraestructura (*infrastructure role*)**: usado exclusivamente por Express Mode para aprovisionar y administrar la infraestructura asociada al servicio (ALB, grupos de seguridad, autoescalado) — no se usa en tiempo de ejecución del contenedor, y no debe otorgarse ni al rol de ejecución ni al rol de tarea.

### 13.2 Rotación de secretos — precisión obligatoria

- **Los secretos inyectados como variables de entorno en el arranque de una tarea Fargate no se actualizan automáticamente si el secreto rota en Secrets Manager mientras la tarea sigue en ejecución** — la inyección ocurre una única vez, en el momento en que la tarea arranca; una tarea ya en ejecución sigue usando el valor que tenía en su propio arranque.
- **Una rotación efectiva requiere que se cree una nueva tarea** (por ejemplo, mediante un `force new deployment` del servicio, o cualquier evento que provoque el reemplazo de las tareas en ejecución) — no ocurre de forma pasiva ni automática.
- **No se registran secretos en ningún log**, en ningún punto del ciclo de vida (arranque, ejecución, error).
- **Ningún secreto se incluye en la imagen de contenedor** — ni como archivo, ni como valor por defecto embebido en el código, ni en ninguna capa de la imagen.
- **Ningún secreto se declara como variable de Terraform en texto plano** — coherente con ADR-010 (los `tfvars` con secretos nunca se versionan); las referencias a secretos en la definición de tarea apuntan a su ARN en Secrets Manager, resuelto en tiempo de despliegue por el rol de ejecución, nunca a un valor literal en el código de Terraform.

## 14. Despliegue y GitHub Actions

*Reforzado por las correcciones 1, 2 y 5.*

- **Origen del código**: repositorio ya confirmado en GitHub (ADR-010).
- **Construcción de imagen**: un *workflow* construye la imagen a partir del commit correspondiente.
- **ECR con *tag* y *digest***: la imagen se publica en ECR con un *tag* inmutable, y **el despliegue se realiza referenciando el *digest* exacto de esa imagen** (`sha256:...`), nunca un *tag* mutable como `latest` — el plan de Terraform debe identificar de forma explícita e inequívoca cuál *digest* se está desplegando.
- **GitHub Actions con OIDC en dos etapas** (ADR-010): validación estática sin AWS sobre cualquier PR; construcción/publicación de imagen y `plan`/`apply` de Terraform solo tras la barrera de confianza, con roles OIDC separados por función y ambiente.
- **Sin exponer un dominio personalizado en esta fase** (sección 9.1) — el despliegue no incluye, todavía, ninguna configuración de certificado ACM propio ni registro DNS personalizado en Cloudflare más allá de lo que la topología de la sección 9.1 requiere (ninguno, en esta fase).
- **Rollback verificable (corrección 5)**: un rollback consiste en **crear una nueva revisión de la tarea usando el *digest* anterior conocido como bueno** — nunca "volver" a un estado impreciso ni depender de que `latest` todavía apunte a la versión correcta.
- **Misma imagen/mismo *digest* se promueve de staging a producción** — la promoción cambia únicamente la definición de tarea/ambiente de destino en Terraform, **nunca reconstruye una imagen distinta para producción**.

### 14.1 Gate de staging obligatorio antes de considerar el despliegue verificado (corrección 5)

**Ninguno de los siguientes comportamientos se afirma como verificado hasta ejecutar esta prueba explícitamente en staging** — no se ejecuta como parte de este ADR:

1. Probar el comportamiento de **despliegue canario** por defecto de Express Mode con una imagen nueva.
2. Probar el comportamiento ante un **fallo del *health check*** durante un despliegue (¿el canario se detiene? ¿se revierte automáticamente?).
3. Probar si existe y cómo se dispara un **rollback por alarma** (Express Mode crea una alarma de métrica para detectar despliegues defectuosos, según la documentación ya revisada — su efecto exacto sobre el tráfico no está verificado empíricamente).
4. Probar el **rollback manual** explícito (desplegar el *digest* anterior).
5. Verificar que las **revisiones anteriores de la tarea se conservan** el tiempo suficiente para permitir un rollback.
6. Verificar los **tiempos** reales de cada una de estas operaciones (no asumidos de la documentación, medidos en la práctica).
7. Verificar el comportamiento de **conexiones activas y el *deregistration delay*** del grupo de destino durante un reemplazo de tarea (relevante para el *graceful shutdown* del futuro ADR-012).

## 15. Escalado y capacidad

Sin cambios de fondo respecto de la versión previa — reforzado por la sección 11: ningún autoescalado se aprueba sin validar el límite agregado de conexiones a RDS que el máximo de tareas configurado podría generar.

## 16. Health checks y graceful shutdown

Sin cambios de fondo respecto de la versión previa — remitido a ADR-012; el *health check* del grupo de destino de ALB evalúa exclusivamente el "health de plataforma", nunca PostgreSQL/Cognito/Wompi/GIS. El comportamiento real de *deregistration delay* se verifica explícitamente en el gate de la sección 14.1, no se asume de la documentación sin prueba.

## 17. Observabilidad

Sin cambios de fondo respecto de la versión previa.

## 18. Separación Ganadería/CatastroX

Sin cambios de fondo respecto de la versión previa — viable a futuro (hasta 25 servicios Express Mode pueden compartir un ALB), no decidido en este documento.

## 19. Staging

*Corrección obligatoria 4 — elimina el criterio absoluto de destrucción del ALB en cada ventana.*

**Se elimina, respecto de la versión previa, la afirmación de que el ALB siempre se destruye junto con cada ventana de staging.** Esa era una simplificación no validada empíricamente. En su lugar:

### 19.1 Validación obligatoria antes de decidir el modelo de infraestructura efímera

**Ninguna de las siguientes pruebas se ejecuta como parte de este ADR** — deben realizarse antes de comprometerse a un modelo operativo de staging:

1. Creación de un servicio Express Mode completo (medir tiempo y verificar éxito).
2. Destrucción completa del mismo servicio (medir tiempo, verificar limpieza completa de recursos).
3. Comportamiento de un **ALB compartido** entre más de un servicio Express Mode en la misma VPC (sección 18).
4. **Eliminación automática del ALB al desaparecer el último servicio** que lo usa (comportamiento documentado por AWS — "Express Mode también deprovisiona balanceadores no usados a medida que se reduce el número de servicios" — **a confirmar empíricamente**, no solo por documentación).
5. Comportamiento del *endpoint* y del DNS generado tras una destrucción y una nueva creación (¿cambia el nombre DNS? ¿rompe el relay de Cloudflare si no se actualiza la variable de entorno del proxy?).
6. Comportamiento de los certificados ACM automáticos ante la destrucción y recreación del ALB (¿se recrea el certificado? ¿queda un certificado huérfano facturando o pendiente de limpieza?).
7. **Comportamiento del estado `DRAINING`** durante una destrucción — si una tarea o un grupo de destino queda atascado en `DRAINING`, qué lo causa y cómo se resuelve.
8. **Costo residual** real observado tras una destrucción (¿queda algo facturando que no debería?).
9. **Orden de eliminación de roles y políticas IAM** — advertencia registrada explícitamente en esta corrección: el propio *provider* de Terraform para AWS advierte que las **políticas IAM asociadas no deben destruirse antes que el servicio que las usa**; el diseño técnico posterior debe usar **dependencias explícitas** (`depends_on` o equivalente) en el código de Terraform para evitar que un `destroy` intente eliminar una política todavía en uso, lo cual puede dejar el servicio, el grupo de destino, o la propia destrucción atascada en un estado inconsistente (coherente con el punto 7).

### 19.2 Modelos posibles, a decidir tras la validación

**Después de ejecutar la validación de la sección 19.1**, se elegirá entre:

- **Entorno completamente efímero**: todo (ALB incluido) se crea y se destruye en cada ventana de staging.
- **ALB compartido persistente**: el ALB permanece creado de forma continua (aceptando su costo fijo, ~USD 16-17/mes de base), mientras que las tareas Fargate sí se escalan a cero o se destruyen entre ventanas.
- **Entorno mínimo persistente**: un subconjunto reducido de recursos (por ejemplo, el ALB y la VPC, pero no las tareas) se mantiene siempre activo, minimizando el tiempo de creación de cada ventana a cambio de un costo fijo menor pero no nulo.
- **ECS/Fargate directo** (contingencia, sección 6.2), si la validación de Express Mode revela comportamientos problemáticos (por ejemplo, el ALB atascado en `DRAINING` de forma recurrente, o el costo residual no controlable).

**Ninguna de estas cuatro opciones se selecciona en este documento** — la decisión depende de los resultados de la validación (sección 31, decisión de seguimiento).

## 20. Producción

Sin cambios de fondo respecto de la versión previa — reforzado por el gate de la sección 9.2: la topología de red de producción no hereda automáticamente el modelo de tareas públicas de staging; requiere su propia evaluación formal documentada antes del primer `apply` productivo. Gate de validación en staging (madurez de la plataforma, sección 6.1) y estimación de costo con tarifario oficial vigente, sin cambios.

## 21. Costos

*Ajustado por la corrección 4 (el ALB ya no se asume siempre destruido).*

Sin cambios de fondo en las cifras de referencia ya obtenidas de fuentes oficiales en la ronda anterior (Fargate ~USD 0,000011244/vCPU-segundo y ~USD 0,000001235/GB-segundo en us-east-1; ALB ~USD 0,0225/hora más LCU; NAT Gateway ~USD 0,045/hora más por GB, evitado por diseño en staging). **Corrección explícita**: la compatibilidad del staging con el presupuesto de USD 25/mes **ya no se presenta como garantizada por la sola destrucción del ALB en cada ventana** — depende del modelo que se seleccione tras la validación de la sección 19.1: un modelo de "ALB compartido persistente" o "entorno mínimo persistente" tendría un costo fijo mensual del orden del costo del ALB (~USD 16-17/mes) **incluso sin tareas activas**, que debe sumarse al costo variable de las ventanas de cómputo real y compararse explícitamente contra el presupuesto aprobado antes de adoptarse.

## 22. Seguridad

Reforzado por la corrección 2: separación estricta de los tres roles IAM (sección 13.1); prohibición absoluta de secretos en logs, en la imagen, o en `tfvars`; grupos de seguridad restrictivos (sección 9.2); TLS obligatorio en toda la cadena hasta el ALB (sin dominio personalizado todavía, sección 9.1).

## 23. Migración desde Railway

Sin cambios de fondo — ver Anexo G.

## 24. Rollback

*Reforzado por la corrección 5.*

- **A nivel de imagen**: crear una nueva revisión de la tarea que referencia el *digest* anterior conocido como bueno — nunca depender de que un *tag* mutable como `latest` siga apuntando a la versión correcta.
- **No se afirma ningún comportamiento de rollback automático (por alarma o por fallo de *health check*) como verificado** — su existencia y su efecto real se confirman exclusivamente mediante el gate de la sección 14.1, ejecutado en staging antes de considerarlo parte del procedimiento operativo estándar.
- **A nivel de plataforma**: mientras Railway permanezca disponible, el rollback máximo es volver a apuntar el relay de Cloudflare hacia Railway.
- **A nivel de infraestructura (Terraform)**: régimen ya definido por ADR-010.

## 25. Consecuencias positivas

Sin cambios de fondo, reforzadas por esta corrección: se evita comprometerse a una topología de dominio, un modelo de roles IAM, una arquitectura de red productiva, un ciclo de vida de ALB, y un comportamiento de rollback, ninguno de los cuales estaba realmente verificado en la versión previa de este documento — esta corrección reemplaza suposiciones razonables pero no confirmadas por un conjunto explícito de validaciones obligatorias antes de operar en producción.

## 26. Consecuencias negativas

Se añade, respecto de la versión previa: mayor cantidad de validaciones empíricas requeridas antes de considerar la plataforma lista para producción (secciones 9.2, 14.1, 19.1) — más trabajo de verificación antes de poder cerrar este ADR como completamente implementado; incertidumbre temporal sobre el costo exacto de staging hasta que se decida el modelo de ciclo de vida del ALB (sección 19.2).

## 27. Riesgos

*Tabla ampliada respecto de la versión previa con los riesgos de esta corrección.*

| Riesgo | Origen | Tratamiento propuesto |
|---|---|---|
| Asumir que un dominio personalizado y su certificado ACM propio ya son compatibles con Express Mode sin verificarlo | Corrección 1 | Topología inicial sin dominio personalizado (sección 9.1); decisión de seguimiento explícita |
| Rol de tarea (código de la aplicación) con permisos excesivos, mezclados con los del rol de ejecución | Corrección 2 | Separación estricta de los tres roles (sección 13.1) |
| Asumir que un secreto rotado se refleja automáticamente en una tarea ya en ejecución | Corrección 2 | Precisión explícita: requiere nueva tarea o `force new deployment` (sección 13.2) |
| Tareas con IP pública heredadas como topología de producción sin evaluación formal | Corrección 3 | Gate obligatorio antes de producción (sección 9.2) |
| ALB destruido y recreado en cada ventana sin haber validado el comportamiento de DNS/certificado/costo residual | Corrección 4 | Validación empírica obligatoria antes de decidir el modelo (sección 19.1) |
| Política IAM destruida antes que el servicio que la usa, dejando el `destroy` atascado | Corrección 4 — advertencia del *provider* de Terraform | Dependencias explícitas en el código de Terraform (sección 19.1, punto 9) |
| Despliegue o rollback referenciado por `latest`, con riesgo de desplegar una versión no revisada | Corrección 5 | *Digest* inmutable obligatorio, nunca `latest` (sección 14) |
| Afirmar que el rollback automático por alarma funciona sin haberlo probado | Corrección 5 | Gate de staging obligatorio (sección 14.1) |
| Autoescalado aprobado sin validar el límite agregado de conexiones a RDS | Ajuste complementario C | Cálculo obligatorio de pool máximo × tareas máximas, con margen de reserva (sección 11) |
| Gate de cookies de ADR-009 no repetido contra el *endpoint* real de Express Mode | Ajuste complementario B | Repetición obligatoria del gate completo (sección 12) |

## 28. Acciones requeridas

*(Ninguna se ejecuta como parte de este ADR.)*

- Crear el `Dockerfile` del backend, con usuario no root, versión de Node fijada, y sistema de archivos de solo lectura evaluado.
- Diseñar la definición de tarea personalizada con los tres roles IAM separados (sección 13.1).
- Ejecutar la validación de red de la sección 9.2 (staging) y preparar el gate formal de producción.
- Ejecutar la validación de ciclo de vida del ALB de la sección 19.1 antes de decidir el modelo de staging.
- Ejecutar el gate de despliegue/rollback de la sección 14.1 en staging.
- Repetir el gate completo de cookies de ADR-009 contra el *endpoint* real de Express Mode (sección 12).
- Calcular el límite agregado de conexiones a RDS (pool × tareas máximas, con margen de reserva) antes de aprobar cualquier configuración de autoescalado (sección 11).
- Investigar el soporte exacto de dominio personalizado y certificado ACM propio en Express Mode (sección 9.1).
- Mantener alineado `docs/AWS_TRANSITION_PLAN_PHASE_0_STAGING.md`, ya actualizado a versión 1.1, ante cualquier cambio posterior de plataforma.

## 29. Criterios de aceptación

- Ningún despliegue se realiza referenciando `latest`; todo despliegue y rollback identifica el *digest* exacto de la imagen.
- El rol de ejecución, el rol de tarea y el rol de infraestructura son tres identidades IAM distintas, verificable por inspección de configuración.
- Ninguna rotación de secreto se considera efectiva sin haber provocado explícitamente el reemplazo de las tareas en ejecución.
- Ninguna tarea de producción tiene IP pública sin que el gate formal de la sección 9.2 se haya documentado y aprobado explícitamente.
- El modelo de ciclo de vida del ALB en staging (efímero, compartido persistente, o mínimo persistente) queda documentado solo después de ejecutar la validación de la sección 19.1, nunca antes.
- El comportamiento de canario, fallo de *health check*, rollback por alarma y rollback manual está probado en staging antes de asumirse como parte del procedimiento operativo.
- El gate completo de cookies de ADR-009 se repite y se supera contra el *endpoint* real de Express Mode antes de considerar la sesión BFF funcional sobre esta plataforma.
- Ninguna configuración de autoescalado se aprueba sin verificar el límite agregado de conexiones a RDS.

## 30. Elementos fuera de alcance

Sin cambios de fondo respecto de la versión previa, ampliados: soporte exacto de dominio personalizado (se registra como decisión de seguimiento, no se resuelve); modelo definitivo de ciclo de vida del ALB (depende de la validación de la sección 19.1); comportamiento verificado de rollback automático (depende del gate de la sección 14.1); decisión formal de red de producción (depende del gate de la sección 9.2).

## 31. Decisiones de seguimiento

1. Soporte exacto de *custom domain* y certificado ACM propio en ECS Express Mode; mutabilidad del listener.
2. Resultado de la validación de ciclo de vida del ALB (sección 19.1) y selección del modelo correspondiente (sección 19.2).
3. Resultado del gate de despliegue/rollback en staging (sección 14.1).
4. Resultado del gate formal de red antes de producción (sección 9.2).
5. Diseño técnico exacto de la definición de tarea (CPU/memoria definitivos, arquitectura x86_64 vs. ARM64 confirmada).
6. Duración exacta del período de validación en staging antes de comprometer la plataforma a producción.
7. Cálculo definitivo del límite agregado de conexiones a RDS y su relación con los límites de autoescalado.
8. Decisión sobre separar Ganadería y CatastroX en servicios Express Mode distintos.
9. Fecha o condición exacta de apagado de Railway.
10. Actualización de `docs/AWS_TRANSITION_PLAN_PHASE_0_STAGING.md`.

## 32. Relación con ADR anteriores

Sin cambios de fondo respecto de la versión previa — ADR-001 sustituido únicamente en su decisión de plataforma de ejecución; ADR-003/010 aplicados sin cambios a los nuevos recursos; ADR-006/007/008/009 compatibles, con el gate de cookies de ADR-009 ahora explícitamente repetido contra el nuevo *endpoint* (sección 12).

## 33. ADR sustituidos o precisados

- **ADR-001**: sustituido en su decisión de plataforma de ejecución (App Runner → Amazon ECS Express Mode, con contingencia ECS+Fargate directo). Conserva valor histórico; el resto de sus decisiones permanece vigente.
- Ningún otro ADR previo requiere sustitución.

---

## Anexo A. Diagrama de arquitectura

```
Navegador ──▶ Cloudflare Pages (frontend estático)
                    │
                    ▼
         Cloudflare Pages Function (relay same-origin, ADR-009)
         [apunta al endpoint HTTPS AUTOGENERADO por Express Mode —
          SIN dominio personalizado en esta fase, sección 9.1]
                    │
                    ▼
      ALB (creado por ECS Express Mode, certificado ACM automático)
                    │
┌─────────────────────────────────────────────────────────────┐
│ VPC — STAGING (fase inicial, sección 9.2)                     │
│  Subredes PÚBLICAS, sin NAT Gateway                            │
│   ┌──────────────┐         ┌────────────────────────────┐    │
│   │     ALB      │────────▶│  Tarea(s) Fargate            │    │
│   │ internet-    │  SG:    │  assignPublicIP=true         │    │
│   │ facing       │  solo   │  SG de tarea: ingreso SOLO    │    │
│   │              │  ALB→SVC│  desde SG del ALB             │    │
│   └──────────────┘         │  Roles separados:              │    │
│                             │   - ejecución (ECR/logs/       │    │
│                             │     secretos/KMS)              │    │
│                             │   - tarea (código app, mínimo)  │    │
│                             └───────────┬────────────────┘    │
│                                         │ (tráfico interno VPC) │
│                             Subredes PRIVADAS                  │
│                                         ▼                       │
│                             RDS PostgreSQL (agx), sin acceso    │
│                             público                             │
└─────────────────────────────────────────────────────────────┘
                    │
                    ▼ (vía Internet Gateway, sin NAT)
        Cognito · Wompi · Secrets Manager (o VPC Endpoint) · ECR · CloudWatch

PRODUCCIÓN: topología de red pendiente del gate formal de la sección 9.2 —
no heredada automáticamente de staging.

Rol de infraestructura (Express Mode) — administra ALB/SG/autoescalado,
separado de los roles de ejecución/tarea.

Railway (rollback temporal) — conservado hasta validar AWS de forma estable.
```

## Anexo B. Matriz comparativa completa

*Ver sección 7 — sin cambios de fondo respecto de la ronda anterior, con las filas de "Dominio personalizado verificado" y "Rollback verificado empíricamente" añadidas como NO VERIFICADO/pendiente para todas las alternativas de AWS.*

## Anexo C. Matriz de costos conceptuales

| Componente | Costo fijo (si persiste 24/7) | Costo variable | Ciclo de vida en staging |
|---|---|---|---|
| Tarea Fargate (1 vCPU/2GB, referencia) | ~USD 35/mes si continua | Proporcional a horas reales | Escalable a cero entre ventanas, en cualquier modelo |
| ALB | ~USD 16-17/mes fijo (base horaria) | LCU según tráfico | **Depende del modelo elegido tras la validación de la sección 19.1 — ya no se asume destruido en cada ventana** |
| NAT Gateway | ~USD 32/mes fijo, si se adoptara | Por GB procesado | Evitado en staging (sección 9.2) |
| ECR | Marginal | Por GB almacenado | Persistente |
| CloudWatch Logs | Marginal a bajo volumen | Por ingesta/almacenamiento | Persistente |
| Secrets Manager | Fijo pequeño por secreto | Por llamada a la API | Persistente |
| Certificado ACM (automático) | Sin cargo adicional documentado | — | Ciclo de vida ligado al del ALB, a confirmar (sección 19.1, punto 6) |

## Anexo D. Flujo de despliegue

```
Commit revisado y aprobado (ADR-010, Etapa 2)
        │
        ▼
Construcción de imagen de contenedor (GitHub Actions, rol OIDC de build)
        │
        ▼
Publicación en ECR con tag inmutable + registro del DIGEST exacto
        │
        ▼
terraform plan (definición de tarea referencia el DIGEST, nunca "latest")
        │
        ▼ (aprobación humana, ADR-003/010)
terraform apply → ECS Express Mode actualiza el servicio
        │
        ▼
Despliegue canario (comportamiento a VERIFICAR en el gate de staging,
sección 14.1 — no asumido sin prueba)
        │
        ▼
Health check del grupo de destino confirma la nueva tarea
        │
        ▼
Promoción completa, o ROLLBACK creando una nueva revisión con el
DIGEST anterior conocido como bueno (comportamiento automático por
alarma solo si el gate de staging lo confirma; si no, rollback manual)
```

## Anexo E. Topología de red

*Corrección 1 y 3 — ver secciones 9.1 y 9.2 para el detalle completo. Resumen: staging con tareas públicas sin NAT, dominio sin exponer directamente al navegador (Cloudflare permanece el único origen visible), producción pendiente de gate formal antes de heredar cualquier decisión de staging.*

## Anexo F. Matriz de identidad y permisos

| Identidad | Función | Permisos | Separación |
|---|---|---|---|
| **Rol de ejecución de tarea** | Infraestructura de ECS/Fargate, no el código de la app | *Pull* de ECR; escritura en CloudWatch Logs; lectura de secretos referenciados; `kms:Decrypt` cuando corresponda | Nunca acceso a RDS/Cognito de negocio |
| **Rol de tarea** | Código de la aplicación, solo si invoca APIs de AWS directamente | Mínimo, hoy potencialmente vacío (sin SDK de AWS en el código actual) | Separado del rol de ejecución, sin excepción |
| **Rol de infraestructura (Express Mode)** | Aprovisionamiento de ALB/SG/autoescalado | Gestión de los recursos que Express Mode crea | No usado en tiempo de ejecución del contenedor |
| Rol OIDC de build (GitHub Actions) | Construcción/publicación de imagen en ECR | Por ambiente | Sin permisos de `apply` de Terraform |
| Rol OIDC de plan/apply (ADR-010) | Gestión de infraestructura vía Terraform | Separado por función y ambiente | Conforme ADR-010 |
| Identidad administrativa humana | Bootstrap, decisiones de producción | Sin cambios respecto de ADR-010 | — |

## Anexo G. Plan de transición Railway→AWS

Sin cambios de fondo respecto de la ronda anterior, con dos precisiones: (1) la validación de staging incluye ahora explícitamente el gate de despliegue/rollback (sección 14.1) y el gate de ciclo de vida del ALB (sección 19.1) antes de considerar el corte hacia AWS; (2) el corte del frontend hacia el nuevo backend solo ocurre una vez que el gate de cookies de ADR-009 (sección 12) se haya repetido y superado contra el *endpoint* real de Express Mode.

## Anexo H. Matriz de trazabilidad ADR-001/003/005/006/007/008/009/010 → ADR-011

Sin cambios de fondo respecto de la ronda anterior — se refuerza la fila de ADR-009: el patrón de sesión BFF requiere, en esta corrección, la repetición explícita de su gate de cookies contra el *endpoint* real de la nueva plataforma, no solo su compatibilidad teórica.
