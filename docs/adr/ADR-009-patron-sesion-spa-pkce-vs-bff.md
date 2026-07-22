# ADR-009: Patrón de sesión para AgroGenomaX

- Estado: Aceptada
- Fecha: 2026-07-17
- Responsables: Equipo técnico AgroGenomaX / CRH Soluciones Integrales S.A.S.

## Precedencia y estado vigente

ADR-009 mantiene su decisión central: BFF Express, sesión referenciada, cookie opaca y CSRF para el canal navegador-BFF. Decisiones posteriores y relacionadas precisan su entorno:

- ADR-011 sustituyó App Runner por ECS Express Mode.
- El BFF sigue siendo Express.
- Cloudflare conserva relay same-origin.
- Railway es rollback temporal.
- ADR-012 gobierna health/shutdown.
- ADR-014 gobierna separación de ambientes y cookies host-only por ambiente.
- El gate Cloudflare/cookies sigue siendo obligatorio antes de declarar funcional el flujo privado.

No se declara implementado Cognito, BFF, cookies, CSRF, tablas de sesión, gate de Cloudflare ni callback OAuth; siguen pendientes técnicos la prueba real de `Set-Cookie` único y múltiple, redirects, callback OAuth, limpieza de cookies, Android/tablets, DDL de sesiones, algoritmo de hash, CSRF y coordinación RLS.

## 1. Contexto

ADR-007 (Aceptada) estableció Amazon Cognito como proveedor de identidad y que el backend acepta **exclusivamente access tokens de Cognito como Bearer** para autorizar la API, dejando pendiente el patrón de sesión. ADR-008 (Aceptada) estableció que `agx` es la fuente única de autorización de negocio, con `organizacion_id` directo y RLS obligatorio antes de producción. Este ADR-009 resuelve el patrón de sesión pendiente — Backend for Frontend (BFF) en Express en ECS Express Mode, sesión referenciada en PostgreSQL, cookie opaca `HttpOnly`/`Secure`/`SameSite`, proxy same-origin mediante Cloudflare — y, en esta versión final, **declara expresamente su relación de precedencia frente a ADR-007 para el canal navegador–BFF**: ADR-009 **precisa y reemplaza, únicamente para ese canal**, la formulación general de ADR-007 que exigía Bearer `access_token` en toda ruta autenticada, sin alterar el principio sustantivo de ADR-007 de que el `access_token` de Cognito es la única credencial que autoriza el acceso a la API — ADR-009 solo aclara **cómo** ese token llega a validarse cuando el origen de la solicitud es el navegador a través del BFF, en vez de un consumidor externo que llama directamente con Bearer.

## 2. Problema

Sin esta precisión, coexistían dos lecturas posibles de ADR-007: (a) que toda ruta, sin excepción, debía recibir literalmente un `Authorization: Bearer` — lo cual haría inviable cualquier cookie de sesión BFF; o (b) que el requisito de ADR-007 se refería al mecanismo de autorización final ante la API, no al transporte desde el navegador — lo cual permite una cookie de sesión siempre que, internamente, el `access_token` siga siendo la única credencial validada. Este ADR resuelve esa ambigüedad de forma inequívoca (corrección 1). Además, la decisión de BFF depende de una premisa técnica no verificada — que el proxy de Cloudflare Pages Functions preserva correctamente la semántica de cookies (`Set-Cookie`, atributos, redirects) — que debe confirmarse antes de construir sobre ella (corrección 2), la estrategia CSRF debía resolver con precisión la interacción entre `Origin` y `Referer` sin caer en contradicciones de aceptación implícita (corrección 3), y el modelo de sesión requería una separación explícita de privilegios de PostgreSQL por plano, no solo una separación conceptual de tablas (corrección 4).

## 3. Estado actual verificado

*(Confirmado por lectura directa del código — sin nueva verificación de código en esta ronda de correcciones, que es de precisión arquitectónica sobre el modelo ya aprobado.)*

**Arquitectura real frontend/backend**: frontend React 19 + Vite 7 en Cloudflare Pages; backend Express 5 hoy en Railway, objetivo vigente ECS Express Mode (ADR-011), con Railway como rollback temporal.

**Dominio de producción confirmado**: `agrogenomax.com` (`.env.example`). Sin subdominios `app.`/`api.` configurados.

**Proxy frontend→backend**: `functions/api/catastrox/[[path]].js` y `functions/api/catastrox/payments/[[path]].js` son proxies reales hacia el backend — evidencia concreta de que el patrón de proxy same-origin ya existe en este repositorio. **Su comportamiento frente a `Set-Cookie` (una o múltiples cabeceras) no fue verificado** — no hay cookies que reenviar hoy, por lo que este código nunca ejercitó ese camino.

**CORS actual — hallazgo relevante**: el proxy existente refleja cualquier `Origin` (`request.headers.get('Origin') || '*'`), sin `Access-Control-Allow-Credentials`.

**Cookies, sesiones, almacenamiento de tokens, SDK OIDC/Cognito/Amplify, middleware CSRF, Helmet, CSP**: todos ausentes hoy.

**`dangerouslySetInnerHTML`**: cero ocurrencias en `src/`.

**Llamadas `fetch` de `catastroxApi.js`/`ganaderiaApi.js`**: sin `credentials`, por lo que hoy no envían cookies cross-origin.

**NO VERIFICADO**: origen/backend ECS/ALB bajo dominio controlado; manejo exacto de `Set-Cookie` (único y múltiple) por Cloudflare Pages Functions; preservación de atributos `HttpOnly`/`Secure`/`SameSite`/`Path`/expiración al hacer proxy; comportamiento del proxy frente a redirects y al callback OAuth; comportamiento de limpieza de cookies a través del proxy; volumen de usuarios/sesiones concurrentes; comportamiento de cookies en dispositivos Android/tablets de campo.

## 4. Requisitos obligatorios

1. `agx` es la fuente única de autorización de negocio; Cognito no lo es.
2. **El `access_token` de Cognito sigue siendo la única credencial que autoriza el acceso a la API — ADR-009 precisa el canal de transporte para el navegador (cookie → pipeline interno de validación), sin sustituir ni debilitar ese principio de ADR-007** (corrección 1).
3. Todo el CRUD ganadero requiere autenticación.
4. CatastroX conserva sus flujos públicos sin login obligatorio.
5. El modelo multicliente usa `organizacion_id` directo con RLS obligatorio antes de producción (ADR-008).
6. El contexto de organización se establece dentro de la transacción de negocio, nunca antes de conocerla, y nunca persiste entre conexiones del pool.
7. La tabla de sesión pertenece al plano de identidad y seguridad, no al plano organizacional de ADR-008 — no se protege con el mismo RLS basado en `organizacion_id`.
8. La cookie de sesión contiene un secreto aleatorio de alta entropía; PostgreSQL almacena únicamente un hash criptográfico de ese secreto.
9. El flujo OAuth se protege mediante una transacción de autenticación pendiente, temporal, de un solo uso, validada antes de crear cualquier sesión definitiva.
10. La estrategia CSRF exige un token ligado criptográficamente a la sesión; las rutas autenticadas same-origin no requieren CORS.
11. **No se implementa ninguna sesión BFF sobre el proxy de Cloudflare Pages Functions sin antes superar el gate técnico de verificación de semántica de cookies** (corrección 2).
12. **`Origin` se valida de forma estricta; `Referer` solo actúa como respaldo en un escenario técnicamente legítimo y documentado; la ausencia de ambos rechaza la solicitud mutante, nunca la acepta por defecto** (corrección 3).
13. **El acceso a PostgreSQL se separa conceptualmente en tres planos de privilegio — seguridad (sesión), negocio (`agx`/RLS) y migración/administración — sin que exista una única credencial con la suma de todos los privilegios** (corrección 4).
14. Usuarios internos de CRH solo acceden a datos mediante Concesión de acceso interno, sujeta a RLS igual que cualquier otra consulta.
15. No se aprueba impersonación.
16. "Ruta congelada" no impide modificar la implementación interna para incorporar seguridad.
17. No se asume Redis, CloudFront ni API Gateway; ALB/origen AWS queda sujeto a ADR-011 y al gate de topología.
18. No se escribe DDL definitivo ni se ejecuta ninguna implementación.

## 5. Alternativas consideradas

### 5.1 SPA con Authorization Code + PKCE

Descartada — sin cambios respecto de la ronda anterior. PKCE protege el intercambio del `authorization code`, no los tokens ya emitidos frente a XSS. Concentra la custodia de tokens en el contexto de mayor exposición (el navegador).

### 5.2 Backend for Frontend

**Decisión central ya aprobada**, con las cuatro precisiones de esta ronda: (1) relación de precedencia explícita frente a ADR-007 para el canal navegador–BFF; (2) gate técnico de verificación de cookies antes de implementar, con contingencia definida; (3) política CSRF de `Origin`/`Referer` sin contradicción; (4) separación de privilegios de PostgreSQL por plano.

### 5.3 Estrategia híbrida

Descartada — sin cambios.

## 6. Matriz comparativa

*Sin cambios sustanciales respecto de la ronda anterior.*

| Criterio | SPA + PKCE | BFF (recomendado, con las cuatro precisiones) |
|---|---|---|
| Seguridad frente a XSS | Alta exposición | Baja — tokens nunca llegan al navegador; secreto de sesión hasheado en servidor |
| Seguridad frente a CSRF | Bajo riesgo intrínseco | Mitigado con token ligado a sesión + `SameSite` + `Origin`/`Referer` sin contradicción (corrección 3) |
| Relación con ADR-007 | Bearer directo, sin ambigüedad de canal | **Precisada explícitamente**: cookie solo para el canal navegador–BFF; Bearer se mantiene intacto para consumidores externos (corrección 1) |
| Dependencia de la plataforma de proxy (Cloudflare) | Ninguna | Alta — sujeta a un gate técnico de verificación de cookies, con contingencia si no se cumple (corrección 2) |
| Separación de privilegios de base de datos | No aplica (sin sesión de servidor) | Tres planos de privilegio explícitos: seguridad, negocio, migración (corrección 4) |
| Complejidad frontend | Alta | Baja |
| Complejidad backend | Baja | Media-alta, en capas bien definidas |
| Infraestructura adicional | Ninguna | Ninguna nueva (PostgreSQL ya aprobado, sin Redis) — condicionada a superar el gate de la corrección 2 |
| Revocación | Limitación estructural de ADR-007 | Casi instantánea vía invalidación de sesión |
| Adecuación al equipo actual | Menor | Mayor |

## 7. Decisión recomendada

**Se mantiene, sin cambios, la decisión central ya aprobada**: patrón Backend for Frontend, implementado en el propio Express en ECS Express Mode, sesión referenciada en PostgreSQL, cookie opaca `HttpOnly`/`Secure`/`SameSite`, proxy same-origin mediante Cloudflare, CatastroX público fuera de la sesión obligatoria. Se incorporan, como parte integral de la decisión, las cuatro precisiones de esta ronda final:

1. **Precedencia frente a ADR-007 (corrección 1)**: ADR-009 precisa y reemplaza, **exclusivamente para el canal navegador–BFF**, la formulación general de ADR-007 que exigía Bearer `access_token` en toda ruta autenticada. Regla definitiva:
   - **Navegador → BFF**: el navegador envía únicamente la **cookie de sesión** y, cuando aplique, el **token CSRF** — **nunca un Bearer administrado por JavaScript**.
   - **BFF → pipeline interno**: el BFF **recupera y valida obligatoriamente el `access_token` de Cognito** asociado a la sesión (ADR-007, sección 9.1), construye el **contexto interno inmutable** de identidad, y **solo después** ejecuta la autorización contra `agx` y el controlador de negocio correspondiente.
   - **Consumidor externo servidor-a-servidor autorizado**: usa exclusivamente **Bearer `access_token`**, conforme a ADR-007, sin cambios — este ADR no introduce ninguna alternativa a ese mecanismo para integraciones externas.
   - **La cookie no se acepta, bajo ninguna circunstancia, como sustituto general del Bearer en APIs externas** — es exclusiva del canal navegador–BFF.
   - **Ninguna ruta ofrece simultáneamente cookie y Bearer como mecanismos alternativos intercambiables sin una clasificación expresa** de a cuál canal pertenece cada ruta (navegador–BFF vs. servidor-a-servidor).
2. **Gate técnico y contingencia de topología (corrección 2)**: no se implementa ninguna sesión sobre el proxy de Cloudflare Pages Functions sin antes verificar que preserva correctamente la semántica de cookies (sección 8).
3. **CSRF con `Origin`/`Referer` sin contradicción (corrección 3)**: política estricta y sin ambigüedad (sección 11).
4. **Separación de privilegios de PostgreSQL por plano (corrección 4)**: tres roles/conexiones conceptualmente distintos — seguridad, negocio, migración (sección 9/15).

## 8. Topología de dominios

Se mantiene como topología principal el Escenario 2/3 ya evaluado: frontend en Cloudflare Pages, relay same-origin en Cloudflare Pages Functions (extendiendo el patrón ya existente para CatastroX), BFF real (Express) en ECS Express Mode.

### Gate técnico obligatorio, previo a implementar cualquier sesión (corrección 2)

Antes de construir el modelo de sesión de este ADR sobre el relay de Cloudflare, debe **verificarse explícitamente**, como condición bloqueante:

1. **Reenvío de `Cookie`**: que el relay reenvía correctamente la cabecera `Cookie` de la solicitud entrante hacia el backend.
2. **`Set-Cookie` único y múltiple**: que el relay reenvía correctamente **una** cabecera `Set-Cookie` de la respuesta del backend hacia el navegador, **y** que preserva correctamente el caso de **múltiples** cabeceras `Set-Cookie` simultáneas (por ejemplo, al fijar la cookie de sesión y la cookie de transacción OAuth pendiente en la misma respuesta) — un punto de fallo conocido en general en entornos de ejecución tipo Workers/Functions, no verificado específicamente contra este código (sección 3).
3. **Atributos de cookie**: que `HttpOnly`, `Secure`, `SameSite`, `Path` y la expiración declarados por el backend llegan intactos al navegador, sin alteración ni pérdida por el relay.
4. **Redirects y callback OAuth**: que el relay preserva correctamente las respuestas de redirección (3xx) y las cabeceras asociadas durante el flujo de login/callback (sección 9.3/16), incluida la cookie temporal de transacción pendiente.
5. **Limpieza de cookies**: que una instrucción de expiración/borrado de cookie emitida por el backend (logout, sección 16) se refleja correctamente en el navegador a través del relay.

### Contingencia si el gate no se supera

- **Si Cloudflare Pages Functions no conserva correctamente la semántica de cookies** (cualquiera de los cinco puntos anteriores), **no se implementa el BFF sobre ese relay**.
- La alternativa es **adoptar un origen/backend ECS/ALB bajo dominio controlado y el mismo sitio registrable** (por ejemplo, un subdominio de `agrogenomax.com` con `Domain` de cookie compartido, si se aprueba) **o un proxy alternativo que garantice la semántica completa de cookies** verificada por el mismo gate.
- **No se cambia silenciosamente a cookies cross-site con `SameSite=None`** como solución de conveniencia ante un fallo del gate — esa vía reintroduce el riesgo de CSRF cross-site que este patrón busca evitar y **no está autorizada** como respuesta automática a un fallo de verificación.
- **Cualquier cambio de topología resultante de esta contingencia debe conservar las garantías de cookie first-party/same-site ya exigidas, y requiere revisión documental explícita** (una actualización de este ADR o un ADR de seguimiento dedicado) antes de implementarse — no es una decisión que el equipo de implementación pueda tomar unilateralmente durante la construcción.

### Cabeceras CORS (sin cambios respecto de la ronda anterior)

En la topología same-origin recomendada, las rutas autenticadas del navegador no necesitan CORS en absoluto — eliminarlo es preferible a mantener una allowlist. CORS con allowlist estricto, nunca reflejando `Origin`, se reserva exclusivamente para consumidores cross-origin expresamente aprobados.

## 9. Modelo de sesión

### 9.1 Sesión BFF referenciada en PostgreSQL, con identificador hasheado

Sin cambios respecto de la ronda anterior: la cookie contiene un secreto de alta entropía; PostgreSQL almacena únicamente su hash criptográfico; cada solicitud recalcula el hash para localizar la sesión; una filtración de la tabla no entrega cookies reutilizables; la rotación genera nuevo secreto y nuevo hash; logs y auditoría nunca incluyen el secreto completo; los índices se construyen sobre el hash.

### 9.2 Plano de seguridad de la tabla de sesiones — separado del RLS organizacional de ADR-008, y ahora con separación explícita de privilegios (corrección 4)

- La tabla de sesión (y la de transacciones de autenticación pendientes, sección 9.3) pertenecen al **plano de identidad y seguridad**, no al plano de datos organizacionales de ADR-008 — no se protegen con el mismo RLS basado en `organizacion_id`.
- **Separación conceptual de privilegios de PostgreSQL en tres planos** (corrección 4), sin decidir todavía si se implementan como dos *pools* físicos de conexión o una abstracción equivalente:
  - **A. Rol/conexión del plano de seguridad**: acceso mínimo, limitado a las tablas de sesión y de transacciones OAuth pendientes — **sin acceso general a las tablas de negocio ganadero** (`predios`, `animales`, etc.) y **sin privilegios administrativos** de ningún tipo. Es el único rol que el pipeline interno de la sección 7 usa para resolver `cookie → hash → sesión`.
  - **B. Rol/conexión del plano de negocio**: acceso a las tablas organizacionales de `agx`, **sujeto en todo momento a las políticas de RLS** de ADR-008 — **sin acceso libre a los secretos de sesión ni a los `refresh_token` almacenados** en la tabla de sesión del plano de seguridad. Es el rol que ejecuta la transacción de negocio de la sección 9.2/15, una vez resuelto el contexto por el plano de seguridad.
  - **C. Rol de migración/administración**: separado de los dos anteriores, **nunca utilizado por solicitudes normales del runtime web**, y **no compartido con el proceso que atiende tráfico de usuarios** — reservado exclusivamente para la ejecución de migraciones y tareas administrativas fuera del ciclo de solicitud-respuesta.
- **Se prohíbe explícitamente una única credencial de PostgreSQL que acumule la suma de todos estos privilegios** (acceso a sesión + acceso a negocio + privilegios administrativos) — cualquier diseño técnico posterior debe preservar esta separación de planos, sin que sea necesario decidir en este documento la implementación física exacta (dos *pools* de conexión distintos, dos roles de base de datos con un único *pool* que alterna, u otra abstracción equivalente).
- **La tabla de sesión no usa RLS organizacional (ADR-008), pero tampoco queda accesible al rol general de negocio (plano B)** — su protección es la separación de privilegios de esta sección, no una política de RLS basada en `organizacion_id`, que no aplicaría conceptualmente a una tabla que se resuelve antes de conocer la organización.
- Solo el BFF, bajo el rol del plano de seguridad, puede consultar, crear o invalidar filas de sesión o de transacción OAuth pendiente. Los controladores de negocio no acceden directamente a esas tablas.

**Secuencia obligatoria de resolución** (sin cambios de fondo, ahora explícitamente asociada al cambio de plano de privilegio en el paso correspondiente):

```
cookie → hash → sesión (plano de seguridad, rol A)
      → validación del access_token de Cognito asociado (ADR-007, sección 9.1)
      → sub
      → resolución de membresía o Concesión en agx (plano de negocio, rol B)
      → organización validada
      → apertura de transacción de negocio (rol B, sujeta a RLS)
      → establecimiento del contexto de RLS dentro de esa transacción (ADR-008, sección 14)
      → consulta de negocio
      → COMMIT/ROLLBACK
```

### 9.3 Transacción de autenticación OAuth pendiente

Sin cambios de fondo respecto de la ronda anterior (entidad conceptual temporal: `state`, `code_verifier`, `nonce`, `return URL` validada contra allowlist, creación, expiración corta, estado consumido/no consumido), con las siguientes precisiones complementarias de esta ronda:

- **Cuando la cookie temporal contiene un secreto opaco localizador** (el valor que el navegador presenta para que el BFF encuentre la transacción pendiente correcta), **PostgreSQL almacena únicamente su hash** — mismo principio que la sección 9.1, aplicado también aquí.
- **El valor del secreto localizador nunca se registra** en logs ni en auditoría.
- **Consumo único**: reafirmado — un segundo uso del mismo `state`/secreto localizador, aun dentro de la ventana de expiración, se rechaza.
- **Invalidación/eliminación al completar**: la transacción pendiente se invalida o elimina inmediatamente al completarse exitosamente (creación de la sesión definitiva) — no permanece disponible para reutilización posterior.
- **Limpieza de la cookie temporal, tanto en éxito como en error terminal**: si el callback se completa exitosamente, la cookie temporal se limpia al fijar la cookie de sesión definitiva; **si el flujo termina en un error irrecuperable** (`state` inválido, expiración, reutilización detectada), **la cookie temporal también se limpia** en la respuesta de error — nunca queda una cookie temporal "colgada" en el navegador tras un intento fallido.

## 10. Modelo de cookies

Sin cambios respecto de la ronda anterior en la matriz de dos cookies (sesión y transacción OAuth pendiente) — ver Anexo D, actualizado con las precisiones de la sección 9.3 (hash del secreto localizador, limpieza en error terminal).

## 11. Protección CSRF

### 11.1 Política de `Origin`/`Referer` sin contradicción (corrección 3)

Se reemplaza cualquier formulación previa ambigua por la siguiente política estricta, aplicada en este orden, sin excepción, para toda solicitud mutante (`POST`, `PUT`, `PATCH`, `DELETE`) contra rutas autenticadas de negocio:

1. **Si la cabecera `Origin` está presente, debe coincidir exactamente** con el origen permitido (el origen del frontend en la topología same-origin recomendada) — cualquier discrepancia rechaza la solicitud de inmediato.
2. **Si `Origin` está ausente, se valida `Referer` únicamente en un escenario técnicamente legítimo y documentado** (por ejemplo, un cliente o configuración de red intermedia conocida que omite `Origin` en solicitudes same-origin por razones ya identificadas y registradas como excepción — el catálogo exacto de esos escenarios es una decisión de diseño técnico posterior, sección 26, no una vía abierta a cualquier ausencia no explicada).
3. **Si ninguno de los dos (`Origin` ni `Referer`) resulta válido, la solicitud mutante se rechaza.**
4. **No se acepta una solicitud mutante únicamente porque ambas cabeceras estén ausentes** — la ausencia no equivale a una validación implícita exitosa; el comportamiento por defecto ante la ausencia de evidencia de origen es el rechazo, nunca la aceptación.
5. **Los callbacks OAuth no se rigen por esta política de CSRF de negocio** — se protegen exclusivamente mediante el mecanismo de `state`/transacción de autenticación pendiente (sección 9.3), que es su control específico y suficiente para ese flujo distinto.
6. Se mantienen, sin cambios, los demás controles ya definidos: **token CSRF ligado criptográficamente a la sesión** (no un double-submit simple), **header personalizado obligatorio**, **`SameSite`** como capa adicional, y **restricción explícita de los `Content-Type` permitidos** en rutas mutantes.

### 11.2 Entrega del token CSRF al cliente (corrección complementaria 2)

- El token CSRF se entrega al navegador mediante un **mecanismo same-origin controlado** (por ejemplo, expuesto en una respuesta del propio backend tras establecer la sesión, o mediante una cookie no-`HttpOnly` de menor sensibilidad dedicada exclusivamente a este propósito) — no se especifica el mecanismo exacto de transporte en este documento (decisión de diseño técnico posterior, sección 26), pero **nunca incluye ni deriva de forma reversible el secreto de sesión** en su representación entregada al cliente.
- Toda respuesta que entregue o renueve el token CSRF incluye **`Cache-Control: no-store`** — nunca debe quedar cacheada por el navegador, por un proxy intermedio, ni por Cloudflare (sección 17).
- **El token CSRF se regenera cuando la sesión rota** (sección 9.1) — un token emitido para una sesión anterior deja de ser válido tras la rotación.
- **Un token CSRF válido para una sesión no funciona con otra sesión distinta** — su vínculo criptográfico con el identificador de sesión (sección 11.1) hace que un token robado sin la cookie de sesión correspondiente sea inútil, y viceversa.
- **El token CSRF no se guarda en `localStorage`** — su gestión permanece dentro del ciclo de vida de la sesión, consistente con la prohibición general de persistir credenciales de sesión en almacenamiento del navegador accesible por JavaScript de forma persistente.

## 12. Protección XSS y CSP

Sin cambios respecto de la ronda anterior: `HttpOnly` no elimina el riesgo de XSS durante su ejecución activa; CSP no es una protección absoluta; se recomienda diseñar CSP (vía `public/_headers` de Cloudflare Pages) y adoptar Helmet en Express.

## 13. Renovación, expiración y revocación

Sin cambios respecto de la ronda anterior: granularidad de revocación por membresía (suspensión global invalida todas las sesiones; suspensión de una membresía bloquea solo esa organización); ningún permiso cacheado en la sesión como fuente de verdad.

## 14. Integración con Cognito

Reforzada por la corrección 1:

- El BFF es el único componente que interactúa directamente con los endpoints OAuth2/OIDC de Cognito.
- El intercambio del `authorization code` ocurre únicamente tras validar la transacción de autenticación pendiente (sección 9.3).
- **Al recibir el `access_token`, el BFF ejecuta el pipeline interno definido por la corrección 1 (sección 7)**: recupera y valida obligatoriamente ese `access_token` (ADR-007, sección 9.1) usando el rol del plano de seguridad para resolver la sesión y el rol del plano de negocio para lo que corresponda después (sección 9.2), construye el contexto interno inmutable, y solo entonces permite la ejecución del controlador — **sin llamada HTTP interna del BFF hacia sí mismo**.
- **Esta validación del `access_token` no es opcional ni se sustituye por la sola existencia de una cookie de sesión válida** — la cookie identifica la sesión; el `access_token` recuperado de esa sesión es el que efectivamente se valida en cada solicitud, conforme a ADR-007, sin excepción.
- El `id_token`, si se recibe, se usa exclusivamente para poblar identidad inicial y validar el `nonce` de la transacción pendiente — nunca se reenvía como Bearer.
- El `authorization code` nunca se registra en logs.
- Ningún dominio de callback ni configuración de App Client de Cognito se crea ni se modifica como parte de este ADR.

## 15. Integración con `agx`, organizaciones y RLS

Reforzada por las correcciones 1 y 4: la resolución de identidad (plano de seguridad, rol A) y la resolución de autorización organizacional (plano de negocio, rol B, sujeto a RLS de ADR-008) son etapas distintas, secuenciales, ejecutadas bajo roles de PostgreSQL distintos — nunca fusionadas en la misma conexión con privilegios acumulados.

- Tras el pipeline de la sección 7/14 (sesión → validación Cognito → `sub`), el backend, ya bajo el rol del plano de negocio, resuelve la membresía activa de ese `sub` contra `agx` — como máximo una por organización, con exactamente un rol.
- La organización activa no se confía al frontend, no se almacena como autorización permanente en Cognito, se valida contra `agx`, se establece dentro de la misma transacción de negocio, y no persiste entre conexiones del pool.
- **Concesión de acceso interno**: sujeta a las mismas seis etapas de ADR-008 (sección 15 de ADR-008), ejecutadas bajo el rol del plano de negocio, después de la resolución de sesión del plano de seguridad.
- Permisos: derivados del rol de la membresía o de la Concesión, resueltos contra `agx` en cada solicitud — nunca cacheados en la sesión.

## 16. Flujos de autenticación

Sin cambios de fondo respecto de la ronda anterior en la estructura de los flujos (inicio de sesión, renovación, cierre de sesión, recuperación de contraseña, usuario suspendido, cambio de organización activa, acceso interno CRH, CatastroX público) — se refuerza explícitamente, en **Inicio de sesión**, que el navegador **nunca recibe el `access_token`** en ningún punto de la redirección de vuelta (paso final de la sección 9.3/16 de la ronda anterior): el navegador solo recibe la cookie de sesión definitiva, consistente con la regla de precedencia de la corrección 1 (sección 7).

## 17. PWA y dispositivos móviles

Se mantienen las reglas de la ronda anterior (Service Worker no cachea tráfico autenticado ni las rutas de login/callback/renovación/logout; `Cache-Control: no-store`; sin tokens ni cookies gestionados por el Service Worker; modo offline autenticado fuera de alcance), con la precisión complementaria 3 de esta ronda:

- **Toda respuesta autenticada del backend incluye `Cache-Control: no-store`**, sin excepción.
- **Estas respuestas se excluyen explícitamente tanto del Service Worker como de cualquier caché compartida** (incluida la propia caché de borde de Cloudflare frente al frontend estático, en la medida en que Cloudflare participe en el camino de esas respuestas).
- **Cloudflare no debe cachear respuestas autenticadas ni la cabecera `Set-Cookie`** — el relay same-origin (sección 8) debe configurarse para no permitir que el borde de Cloudflare almacene en caché ninguna respuesta que contenga `Set-Cookie` o que provenga de una ruta autenticada, consistente con el gate técnico de la sección 8.
- **`Pragma: no-cache` se incluye cuando sea necesario por compatibilidad** con clientes o intermediarios que no interpreten `Cache-Control` de forma completa.

## 18. CatastroX público

Sin cambios — este ADR no convierte ningún flujo público de CatastroX en un flujo autenticado obligatorio; su protección sigue siendo la ya exigida por ADR-005/007.

## 19. Observabilidad y auditoría

Sin cambios respecto de la ronda anterior — eventos mínimos de sesión, creación/validación/consumo de la transacción de autenticación pendiente, prohibición de registrar secretos completos, tokens completos, `authorization code`, `code_verifier`, `state`/`nonce` completos o valores completos de cookie.

## 20. Consecuencias positivas

- Resuelve de forma inequívoca la relación entre ADR-009 y ADR-007, eliminando cualquier lectura contradictoria sobre el mecanismo de autorización de API (corrección 1).
- Evita construir una topología de sesión sobre una premisa técnica no verificada, mediante un gate explícito con contingencia definida (corrección 2).
- Cierra la ambigüedad de aceptación implícita de solicitudes mutantes sin `Origin` ni `Referer` válidos (corrección 3).
- Reduce el radio de impacto de un eventual compromiso del proceso que atiende tráfico web, al impedir que una única credencial de base de datos acumule acceso a sesiones, a datos de negocio y a privilegios administrativos (corrección 4).

## 21. Consecuencias negativas

- El gate técnico de la sección 8 introduce una dependencia de verificación previa que puede retrasar la implementación si Cloudflare Pages Functions no supera alguna de sus cinco condiciones.
- La separación de privilegios en tres planos (corrección 4) añade complejidad de configuración de roles/conexiones de PostgreSQL, sin que se haya decidido todavía su implementación física exacta.
- La política estricta de `Origin`/`Referer` (corrección 3) puede rechazar solicitudes legítimas si el catálogo de "escenarios técnicamente legítimos" para depender de `Referer` no se define con suficiente precisión en el diseño técnico posterior.

## 22. Riesgos

| Riesgo | Origen | Tratamiento propuesto |
|---|---|---|
| Lectura de ADR-007 que exige Bearer literal en toda ruta, incompatible con cualquier cookie | Ambigüedad de la formulación general de ADR-007 | Declaración explícita de precedencia y precisión de esta ronda (sección 1/7) |
| Cookie aceptada por error como sustituto del Bearer en una integración externa | Riesgo de implementación si no se clasifica expresamente cada ruta por canal | Prohibición explícita (sección 7); clasificación obligatoria de cada ruta |
| Implementar sesiones sobre un relay de Cloudflare que no preserva `Set-Cookie` múltiple o atributos de cookie | Premisa técnica no verificada | Gate técnico bloqueante antes de implementar (sección 8) |
| Cambio silencioso a `SameSite=None` como solución rápida ante un fallo del gate | Riesgo de desviación durante la implementación | Prohibición explícita; contingencia definida con revisión documental obligatoria (sección 8) |
| Aceptar una solicitud mutante sin `Origin` ni `Referer` válidos, por defecto | Riesgo de implementación laxa | Rechazo explícito por defecto ante ausencia de evidencia de origen (sección 11.1) |
| Una única credencial de PostgreSQL con privilegios de sesión + negocio + administración | Riesgo de diseño técnico posterior | Prohibición explícita de credencial única; tres planos de privilegio (sección 9.2) |
| Rol del plano de negocio con acceso libre a `refresh_token` almacenados | Riesgo de diseño si no se separan los planos | Separación de privilegios (sección 9.2) — el plano de negocio no tiene acceso a los secretos de sesión |
| Cookie temporal de transacción OAuth pendiente almacenada en claro en la base de datos | Riesgo de diseño si no se aplica el mismo principio de hash que la sesión definitiva | Hash del secreto localizador (sección 9.3) |
| Cookie temporal "colgada" en el navegador tras un intento de login fallido | Riesgo de higiene de sesión | Limpieza obligatoria en éxito y en error terminal (sección 9.3) |
| Token CSRF cacheado por el navegador, un proxy o Cloudflare | Riesgo si la respuesta que lo entrega no excluye caché | `Cache-Control: no-store` obligatorio en su entrega (sección 11.2) |
| Cloudflare cacheando una respuesta con `Set-Cookie` o de una ruta autenticada | Riesgo de configuración de borde | Exclusión explícita del borde de Cloudflare para esas respuestas (sección 17) |

## 23. Acciones requeridas

*(Ninguna se ejecuta como parte de este ADR.)*

- Ejecutar el gate técnico de verificación de cookies contra el proxy de Cloudflare Pages Functions (sección 8) antes de iniciar la implementación de sesión.
- Diseñar la contingencia de topología (dominio personalizado o proxy alternativo) si el gate no se supera, con su propia revisión documental.
- Clasificar explícitamente cada ruta existente y futura según su canal (navegador–BFF con cookie, o servidor-a-servidor con Bearer) — ninguna ruta queda sin clasificar.
- Diseñar el pipeline interno de validación obligatoria del `access_token` recuperado de la sesión, sin excepción, para toda solicitud del canal navegador–BFF.
- Diseñar los tres roles/conexiones de PostgreSQL (seguridad, negocio, migración) y su mecanismo de aplicación (pools físicos separados u otra abstracción), garantizando que ninguna credencial única acumule los tres niveles de privilegio.
- Diseñar el catálogo de "escenarios técnicamente legítimos" en los que se acepta validar `Referer` en ausencia de `Origin`.
- Diseñar el mecanismo exacto de entrega del token CSRF al cliente, su regeneración en rotación de sesión, y su exclusión de caché.
- Configurar el borde de Cloudflare para no cachear respuestas con `Set-Cookie` ni de rutas autenticadas.
- Diseñar el hash del secreto localizador de la transacción OAuth pendiente y su limpieza garantizada en éxito y error terminal.

## 24. Criterios de aceptación

- Ninguna ruta del canal navegador–BFF acepta un `Authorization: Bearer` administrado por JavaScript como alternativa a la cookie de sesión; ninguna ruta externa servidor-a-servidor acepta la cookie como sustituto del Bearer — verificable por clasificación explícita y prueba automatizada.
- Toda solicitud del canal navegador–BFF, sin excepción, dispara la validación obligatoria del `access_token` recuperado de la sesión antes de ejecutar cualquier controlador de negocio.
- El gate técnico de la sección 8 se ejecuta y documenta su resultado antes de que exista cualquier sesión en producción; si falla, se documenta la contingencia adoptada.
- Ninguna solicitud mutante se acepta con `Origin` ausente y `Referer` ausente o inválido; ninguna solicitud mutante se acepta con `Origin` presente pero no coincidente.
- Los callbacks OAuth se validan exclusivamente por `state`/transacción pendiente, nunca por la política CSRF de negocio de la sección 11.1.
- Ninguna credencial única de PostgreSQL usada por el runtime web tiene simultáneamente acceso a la tabla de sesión, acceso general a `agx`, y privilegios administrativos — verificable por inspección de la configuración de roles.
- El rol de migración/administración nunca aparece en la configuración de conexión del proceso que atiende tráfico de usuarios.
- El token CSRF se entrega con `Cache-Control: no-store`, se invalida al rotar la sesión, y no es válido para una sesión distinta de la que lo emitió.
- Ninguna respuesta con `Set-Cookie` ni ninguna respuesta de una ruta autenticada queda cacheada en el borde de Cloudflare, en el Service Worker, ni en ninguna caché compartida.

## 25. Elementos fuera de alcance

Sin cambios respecto de la ronda anterior: implementación de código; DDL definitivo; creación de recursos de AWS/Cognito/Cloudflare; modo offline autenticado; selección final de `SameSite` exacto por ruta; algoritmo exacto de hash y de derivación del token CSRF; esquema exacto de cifrado del `refresh_token`; implementación física exacta de los tres planos de privilegio de PostgreSQL (pools separados vs. otra abstracción); catálogo exacto de escenarios legítimos para depender de `Referer`; implementación operativa de ADR-014; aprobación de impersonación; cambios visuales a interfaces congeladas.

## 26. Decisiones de seguimiento

1. Resultado documentado del gate técnico de verificación de cookies contra Cloudflare Pages Functions, y la contingencia de topología si aplica (sección 8).
2. Diseño técnico exacto de la tabla de sesión y de la transacción de autenticación pendiente (DDL, algoritmo de hash).
3. Implementación física exacta de los tres planos de privilegio de PostgreSQL (pools separados u otra abstracción equivalente).
4. Catálogo exacto de escenarios técnicamente legítimos para validar `Referer` en ausencia de `Origin`.
5. Mecanismo exacto de entrega y regeneración del token CSRF.
6. Configuración exacta de exclusión de caché en el borde de Cloudflare para respuestas con `Set-Cookie` o autenticadas.
7. Clasificación exhaustiva de cada ruta existente por canal (navegador–BFF vs. servidor-a-servidor).
8. Esquema exacto de cifrado del `refresh_token` almacenado y gestión de su clave vía Secrets Manager.
9. Mecanismo exacto de invalidación granular de sesión por membresía vs. invalidación global.
10. Verificación empírica del comportamiento de cookies en dispositivos Android/tablets de campo.
11. Decisión sobre origen/backend ECS/ALB o proxy alternativo bajo dominio controlado, si el gate técnico de la sección 8 lo requiere como contingencia.
12. Coordinación con el diseño técnico exacto de RLS que ADR-008 dejó pendiente.

## 27. Relación con ADR anteriores

- **ADR-001**: topología same-origin sin infraestructura nueva, condicionada al gate técnico de la sección 8.
- **ADR-005**: CatastroX público permanece sin cambios; el nivel "autenticada" queda respaldado por el pipeline de sesión precisado.
- **ADR-007**: **ADR-009 precisa y reemplaza, exclusivamente para el canal navegador–BFF, la formulación general de ADR-007 que exigía Bearer `access_token` en toda ruta autenticada** (corrección 1) — el principio sustantivo de ADR-007 (el `access_token` es la única credencial que autoriza el acceso a la API) permanece intacto y se valida obligatoriamente dentro del pipeline interno del BFF; para consumidores externos servidor-a-servidor, ADR-007 se aplica sin ninguna modificación, con Bearer directo.
- **ADR-008**: la separación de planos de privilegio de PostgreSQL (corrección 4) refuerza, sin modificarla, la condición de ADR-008 de que el rol de aplicación de negocio esté sujeto a RLS y no acumule privilegios administrativos — ahora explícitamente distinguido también del rol del plano de seguridad de la sesión.

---

## Anexo A. Diagrama de flujo SPA + PKCE (alternativa evaluada, no seleccionada)

*Sin cambios respecto de la ronda anterior.*

```
Navegador                          Cognito                       Express/BFF (ECS Express Mode)
   │──1. Redirige a Cognito──────────▶│                                  │
   │◀─2. Login + redirect con code────│                                  │
   │──3. Intercambia code+verifier───▶│                                  │
   │◀─4. access_token, id_token,──────│                                  │
   │     refresh_token (en contexto JS)                                  │
   │──5. Bearer access_token─────────────────────────────────────────────▶│
   │◀─────────────────────────────────────────────────────6. Respuesta────│

Riesgo central: el paso 4 expone los tokens al contexto de JavaScript
del navegador durante toda la sesión.
```

## Anexo B. Diagrama de flujo BFF (recomendado, con las cuatro precisiones finales)

```
Navegador              Express/BFF (ECS Express Mode)               Cognito
   │                          │  [rol PostgreSQL plano seguridad = A]   │
   │──1. Inicia login────────▶│                                         │
   │                          │──2. Crea transacción OAuth pendiente    │
   │                          │    (state, code_verifier, nonce,        │
   │                          │    return URL contra allowlist) —       │
   │                          │    almacena HASH del secreto localizador│
   │◀─3. Set-Cookie temporal──│    (rol A, sección 9.3)                 │
   │                          │──4. Redirige a Cognito──────────────────▶│
   │◀───────────5. Redirect a Cognito (vía el BFF)───────────────────────│
   │──6. Login en Cognito────────────────────────────────────────────────▶│
   │◀─7. Redirect con code + state────────────────────────────────────────│
   │──8. Callback (code, state,                                         │
   │     + cookie temporal)──▶│                                         │
   │                          │──9. Localiza transacción por hash del   │
   │                          │    secreto localizador (rol A); valida  │
   │                          │    state/expiración/uso único; consume  │
   │                          │──10. Intercambia code + code_verifier───▶│
   │                          │◀─11. access_token, id_token,─────────────│
   │                          │      refresh_token (solo en el servidor)│
   │                          │──12. Valida nonce; VALIDA access_token   │
   │                          │      obligatoriamente (ADR-007 9.1) —   │
   │                          │      pipeline interno, sin llamada HTTP │
   │                          │      a sí mismo (corrección 1)          │
   │                          │──13. Crea sesión: secreto de alta       │
   │                          │      entropía → HASH almacenado (rol A) │
   │◀─14. Set-Cookie sesión───│    Limpia cookie temporal (éxito)       │
   │     + redirect a la      │                                         │
   │     return URL validada  │                                         │
   │                          │                                         │
   │──15. Solicitud mutante──▶│  (cookie sesión + token CSRF ligado a   │
   │                          │   sesión + header + Origin válido, o    │
   │                          │   Referer solo en escenario documentado │
   │                          │   — sección 11.1)                       │
   │                          │──16. Hash del secreto → sesión (rol A)  │
   │                          │──17. Recupera y VALIDA access_token     │
   │                          │      asociado (obligatorio, sin excep-  │
   │                          │      ción — corrección 1)               │
   │                          │──18. [cambia a rol PostgreSQL plano     │
   │                          │      negocio = B] Resuelve sub →        │
   │                          │      membresía/Concesión en agx →       │
   │                          │      organización validada              │
   │                          │──19. Abre transacción de negocio (rol B,│
   │                          │      sujeto a RLS), fija contexto RLS,  │
   │                          │      ejecuta consulta, COMMIT/ROLLBACK  │
   │◀─────20. Respuesta (Cache-Control: no-store si autenticada)────────│

Los tokens de Cognito nunca cruzan hacia el navegador.
Rol A (seguridad) nunca accede a tablas de agx; rol B (negocio) nunca
accede a los secretos de sesión ni a refresh_token almacenados.
Un consumidor externo servidor-a-servidor omite los pasos 1-14 y llama
directamente con Bearer access_token, conforme a ADR-007 sin cambios.
```

## Anexo C. Matriz de amenazas XSS / CSRF / token theft / session fixation / replay / open redirect

*Actualizada con la política de `Origin`/`Referer` de la corrección 3.*

| Amenaza | Mitigación en el BFF corregido |
|---|---|
| XSS — robo de token para reutilización posterior | Bajo — `HttpOnly` impide leer la cookie; tokens de Cognito nunca llegan al navegador |
| XSS — "session riding" durante ejecución activa | Persiste como riesgo residual — mitigado por CSP/Helmet, no por `HttpOnly` |
| CSRF sobre rutas mutantes de negocio, con `Origin` ausente y `Referer` ausente/inválido | **Rechazado por defecto — nunca aceptado por ausencia de evidencia** (corrección 3, sección 11.1) |
| CSRF sobre rutas mutantes de negocio, con `Origin` presente pero no coincidente | Rechazado de inmediato (sección 11.1) |
| CSRF sobre el propio callback OAuth | Mitigado por `state`/transacción pendiente — explícitamente **fuera** de la política CSRF de negocio (sección 11.1, punto 5) |
| Open redirect vía `return URL` manipulada | Mitigado por allowlist explícito |
| Session fixation | Mitigado — el secreto de sesión se genera solo tras completar el pipeline completo |
| Replay del secreto de sesión robado | Mitigado por revocación casi instantánea; una filtración de la base de datos no genera secretos reutilizables (hash) |
| **Confusión de canal: cookie aceptada como Bearer, o Bearer aceptado sin clasificación en una ruta de cookie** | **Mitigado por la clasificación expresa de cada ruta por canal** (corrección 1) — ninguna ruta acepta ambos mecanismos como alternativas intercambiables |
| **Compromiso de la conexión de negocio exponiendo secretos de sesión, o compromiso de la conexión de sesión exponiendo datos de otra organización** | **Mitigado por la separación de planos de privilegio de PostgreSQL** (corrección 4) — ninguna conexión acumula ambos accesos |
| Token CSRF cacheado y reutilizado desde una copia cacheada | Mitigado por `Cache-Control: no-store` en su entrega (complementaria 2) |

## Anexo D. Matriz de cookies y atributos

*Actualizada con la precisión de hash del secreto localizador y limpieza en error terminal (sección 9.3).*

| Atributo | Cookie de sesión (9.1) | Cookie de transacción OAuth pendiente (9.3) |
|---|---|---|
| Contenido | Secreto de sesión de alta entropía (servidor almacena solo el hash) | Secreto opaco localizador (servidor almacena solo su hash — precisión de esta ronda) |
| `HttpOnly` | Sí | Sí |
| `Secure` | Sí | Sí |
| `SameSite` | `Lax` (base) / `Strict` a evaluar por ruta | `Lax` |
| Prefijo `__Host-` | Sí, cuando la topología lo permita | A evaluar |
| `Path` | `/` | Acotado al flujo de callback, si resulta viable |
| `Domain` | No fijado (omitido) | No fijado (omitido) |
| Duración | Acotada, alineada con la sesión | Muy corta (minutos) |
| Limpieza | Al cerrar sesión (sección 16) | **En éxito y en error terminal del flujo de login, sin excepción** (precisión de esta ronda) |
| Registro en logs | Nunca el secreto completo | Nunca el valor del secreto localizador |

## Anexo E. Matriz de endpoints por tipo de sesión

*Actualizada con la clasificación explícita por canal exigida por la corrección 1.*

| Grupo de endpoints | Canal | Credencial aceptada | CSRF | CORS |
|---|---|---|---|---|
| CRUD ganadero (mutantes) | Navegador–BFF | Cookie de sesión únicamente | Sí, política de la sección 11.1 | Ninguno (same-origin) |
| CRUD ganadero (lectura) | Navegador–BFF | Cookie de sesión únicamente | No aplica a `GET` | Ninguno (same-origin) |
| Rutas administrativas | Navegador–BFF | Cookie de sesión + Concesión activa | Sí | Ninguno (same-origin) |
| Inicio de login / callback OAuth | Navegador–BFF (previo a sesión) | Cookie temporal de transacción pendiente | `state`/transacción pendiente, no la política de 11.1 | Ninguno (same-origin) |
| **Consumidor externo servidor-a-servidor (futuro, si se aprueba)** | **Servidor-a-servidor** | **Bearer `access_token` exclusivamente (ADR-007), nunca cookie** | No aplica (no hay cookie ni CSRF de navegador) | Allowlist estricto, sin reflejar `Origin`, si el consumidor es cross-origin |
| CatastroX público | Público, sin sesión | Ninguna (mecanismo distinto, ADR-005/007) | No aplica | Según se decida, con allowlist si aplica |
| `GET /api/health` | Público | Ninguna | No | Mínimo o ninguno |

## Anexo F. Matriz de trazabilidad ADR-001/005/007/008 → ADR-009

| ADR | Relación con ADR-009 (versión final) |
|---|---|
| ADR-001 | Topología same-origin condicionada al gate técnico de la sección 8, sin infraestructura nueva |
| ADR-005 | CatastroX público permanece sin cambios; el nivel "autenticada" queda respaldado por el pipeline de sesión |
| ADR-007 | **ADR-009 declara expresamente su relación de precedencia**: precisa y reemplaza la formulación general de Bearer literal para el canal navegador–BFF, preservando intacto el principio de validación exclusiva del `access_token` y el uso de Bearer directo para consumidores externos |
| ADR-008 | La separación de planos de privilegio de PostgreSQL (corrección 4) refuerza la condición de RLS obligatorio del plano de negocio, ahora explícitamente distinguida del plano de seguridad de sesión |
