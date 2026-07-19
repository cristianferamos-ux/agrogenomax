# ADR-014: Mecanismo técnico de separación demo, staging y producción

- **Estado**: Aceptada
- **Fecha**: 2026-07-18
- **Responsables**: Equipo técnico AgroGenomaX / CRH Soluciones Integrales S.A.S.

## Precedencia y estado vigente

ADR-014 continúa vigente como mecanismo técnico definitivo de separación demo, staging y producción. ADR-004 fue cerrado arquitectónicamente por este documento. ADR-011, ADR-012 y ADR-013 ya están aceptados. TAH 1.1 y plan AWS Fase 0 versión 1.1 ya incorporan ADR-014.

Correcciones ya implementadas: commit `26ca461` eliminó fallback mock silencioso de CatastroX; `VITE_APP_ENV`/`APP_ENV` tienen validación fail-fast; overrides de API quedan restringidos a development local; CORS allowlists fueron endurecidas en los relays revisados; health relay real reemplazó la respuesta estática; graceful shutdown y cierre de pools existen.

Pendientes: despliegue independiente `demo.agrogenomax.com`, bundle demo separado, eliminación de relay `/api/*` en demo, CSP específica de demo, validación automatizada del bundle, migración/redirección de `/ganaderia/demo`, cookies host-only por ambiente, Cognito/BFF/CSRF, separación física completa de credenciales y recursos, anonimización automatizada, telemetría de CSP e implementación total de las siete barreras.

## 1. Contexto

ADR-004 estableció, como principio arquitectónico vinculante, que las cuentas demo y las cuentas reales deben tener datos totalmente separados, que una columna `is_demo` no es suficiente por sí sola, y que el fallback mock de CatastroX no puede activarse de forma silenciosa en producción — dejando explícitamente la selección del mecanismo técnico concreto para "un ADR de seguimiento dedicado". Este documento es ese ADR de seguimiento; ADR-011 y ADR-013 lo registraban históricamente como pendiente, y ADR-014 ya cerró esa brecha. Sobre la plataforma ya definida por ADR-011 (ECS Express Mode, ALB, staging-only en fase inicial), el modelo de autenticación de ADR-007/ADR-009 (Cognito + BFF), el modelo multicliente de ADR-008 (organizaciones/membresías/RLS), la fuente de verdad de Ganadería de ADR-002, la condición de migración geoespacial de ADR-006, y el sistema transaccional de CatastroX de ADR-013 (órdenes/entitlements/artifacts), este ADR-014 cierra el mecanismo técnico definitivo que impide que demo, staging y producción compartan o confundan datos, credenciales, cookies, tokens, pagos o cualquier otro recurso.

Esta versión final incorpora, sobre las cuatro correcciones ya aprobadas conceptualmente en la ronda anterior de este mismo documento (demo en origen separado `demo.agrogenomax.com`; planos de datos diferenciados `agx`/PostGIS-CatastroX; prohibición vinculante del override de URL de API; anonimización previa al ingreso a staging), una **precisión técnica final sobre el alcance real de la Same-Origin Policy**: el origen independiente de demo garantiza, por sí solo, el aislamiento de almacenamiento y de estado del navegador (cookies, `localStorage`, `sessionStorage`, Cache Storage, Service Worker), pero **no impide por sí solo que el navegador intente enviar una solicitud de red hacia otro origen** — la ausencia efectiva de contacto con los backends de staging y producción requiere, además del origen separado, un conjunto explícito de barreras combinadas (ausencia de clientes API productivos en el bundle de demo, ausencia de relay `/api/*`, ausencia de variables de backend, CSP restrictiva, *allowlists* CORS que excluyen demo, y controles server-side de autenticación/autorización/CSRF en staging y producción). Esta corrección se aplica de forma transversal en §7, §10, §12, §13, §14, §21, §22, §24, §26, §30, §32, §36, §37 y los anexos correspondientes.

Coexiste con este documento un commit ya aplicado al repositorio, `26ca461 fix(catastrox): remove silent mock fallback`, que elimina el *fallback* mock silencioso del flujo comercial real de CatastroX identificado en la investigación de esta serie de ADRs — ese commit no se modifica, no se revierte y no forma parte del alcance de esta tarea documental; se referencia únicamente como contexto ya resuelto en código para los hallazgos de §3.3/§21.

## 2. Problema

La investigación histórica de código confirmó que **no existía ningún mecanismo explícito de selección de ambiente** (ni `NODE_ENV`, ni `APP_ENV`, ni ninguna variable equivalente leída por el backend), que la única separación real entre "demo" y "producción" para Ganadería era una separación **estructural por ruta y componente dentro del mismo origen web** (compartiendo, por tanto, Service Worker, Cache Storage, `localStorage` y CSP con la aplicación real), y que CatastroX tenía un **fallback accidental** hacia datos mock ante errores de red. Estado vigente: APP_ENV/VITE_APP_ENV ya fueron incorporados con fail-fast, el override de API quedó restringido a development local y el fallback mock silencioso fue corregido por el commit `26ca461`; todavía falta completar la separación física, el pipeline demo y las barreras integrales. Este ADR cierra, sin fabricar mecanismos inexistentes y sin sobreestimar las garantías que un origen web separado provee por sí solo, cómo se construyen demo, staging y producción como tres ambientes real y verificablemente aislados.

## 3. Estado actual verificado

*(Verificación de código realizada mediante lectura completa de los archivos citados en rondas previas de este proceso documental — sin nueva exploración de código en esta ronda de cierre, salvo la confirmación de existencia del commit `26ca461` referenciado en el contexto de esta tarea.)*

### 3.1 Selección de ambiente — contexto histórico y estado vigente

Contexto histórico: la búsqueda inicial de `NODE_ENV`/`APP_ENV`/`import.meta.env.MODE`/`import.meta.env.PROD` en `src/`, `server/`, `functions/` no encontró una selección explícita de ambiente; la única bifurcación verificada era por **hostname**. Estado vigente: `APP_ENV`/`VITE_APP_ENV` ya fueron incorporados con fail-fast y overrides de API restringidos a development local. Todavía falta completar la separación física y los controles del pipeline demo.

### 3.2 Ganadería demo — aislamiento estructural, pero dentro del mismo origen que producción

`src/modules/ganaderia/pages/GanaderiaDemo.jsx` (ruta `/ganaderia/demo`, `src/App.jsx:267`): verificado como 100% local, sin llamadas `fetch`, usando `ganaderiaDemoData.js` (motor de cálculo real sobre dos casos fijos, persistidos en `sessionStorage` bajo `agx_ganaderia_demo_v2`), con `GanaderiaDemoNotice.jsx` (aviso obligatorio) y un PDF de reporte marcado como muestra. Botón "Reiniciar demo" ya implementado.

**Hallazgo que motiva la Corrección 1 (ronda anterior) y esta precisión de SOP**: aunque `GanaderiaDemo.jsx` no hace *fetch* y su árbol de componentes está separado de `GanaderiaApp.jsx`, la ruta demo se servía bajo el mismo origen web (`agrogenomax.com`) que la aplicación real — compartiendo, por construcción del navegador, Service Worker, Cache Storage, `localStorage` de origen, CSP y superficie de *analytics*/errores de enrutamiento. **Precisión de esta ronda**: ese mismo origen compartido, si además el bundle de demo hubiera importado (aunque fuera indirectamente, por un `import` transitivo no intencional) los clientes reales de API (`ganaderiaApi.js`, `catastroxApi.js`), **habría permitido al navegador intentar una solicitud de red hacia el backend real** — el navegador no impide por sí solo iniciar una solicitud *cross-origin*; lo que la Same-Origin Policy restringe es la **lectura** de la respuesta sin CORS explícito, no el **envío** de la solicitud. Este matiz es la razón técnica exacta por la que el aislamiento de demo no puede depender solo del origen separado (§7).

`GanaderiaDashboard.jsx:80` (`PRIVATE_ACCESS_ENABLED = false`) y `GanaderiaAccess.jsx:68`: confirmado, sin cambios.

### 3.3 CatastroX — fallback mock, ya corregido en código por el commit `26ca461`

La investigación de rondas previas confirmó `lookupPredioWithFallback()` (`catastroxApi.js:884-897`) activándose ante `API_UNAVAILABLE`/`ENDPOINT_NOT_FOUND` sin ningún aviso visual verificado — exactamente el patrón que ADR-004 ya prohibió. **El commit `26ca461 fix(catastrox): remove silent mock fallback`, ya aplicado al repositorio fuera de esta tarea documental, elimina ese fallback silencioso del flujo comercial real y agrega pruebas específicas** — este ADR-014 no modifica, no revierte y no re-verifica en detalle ese commit; lo registra como el cierre en código del hallazgo de §3.3/§21 de rondas previas, y mantiene la arquitectura de fondo (§21) como la razón por la que ese patrón nunca debe reintroducirse, en ningún ambiente.

### 3.4 Variables de entorno documentadas

Contexto histórico: `.env.example`/`server/.env.example` no incluían `APP_ENV`/`NODE_ENV`; `WOMPI_ENV=test` estaba documentada pero no leída; `.env.production` estaba trackeado en git, sin secretos. Estado vigente: `APP_ENV`/`VITE_APP_ENV` ya existen con validación fail-fast; quedan pendientes separación física completa de credenciales/recursos y controles de pipeline demo.

### 3.5 Railway y Cloudflare — sin distinción staging/producción

Sin cambios: único *fallback* hardcodeado en las funciones de Cloudflare es `https://agrogenomax-production.up.railway.app`; sin `wrangler.toml`/`railway.json`/`railway.toml` en el repositorio.

### 3.6 Cognito — no implementado

Sin cambios: cero código real, solo documentación de ADRs.

### 3.7 CORS — sin distinción de ambiente

Sin cambios: `server/index.js:26-44`, whitelist de dos orígenes localhost + `CORS_ORIGIN` única, sin sufijo de ambiente, **y sin ninguna lógica que excluya explícitamente un origen de demo** — relevante directamente para la Barrera 4 de esta precisión (§7/§32).

### 3.8 `localStorage`/`sessionStorage` — override de API sin restricción, decisión vinculante

`agx_api_url` (`localStorage`, `ganaderiaApi.js:27,33`): override runtime de la URL base del API, activable vía *query param* `?agx_api_url=` o `?apiUrl=`, sin ninguna restricción de ambiente ni de hostname en el código verificado en rondas previas. Confirmado que este mecanismo, tal como existía al momento de la investigación, permitiría a cualquier usuario — en cualquier ambiente — redirigir las llamadas de `ganaderiaApi.js` hacia un origen arbitrario, con el riesgo de que cualquier credencial/cookie/dato autenticado que el navegador adjunte se envíe a un destino no controlado. **Cerrado como prohibición vinculante, no como evaluación futura** (§4, §13, §21, §36, §37).

### 3.9 Código huérfano relevante — modelo Supabase multi-tenant no conectado

Sin cambios: `LivestockPlatform.jsx` no enrutado en `src/App.jsx`, esquema Supabase RLS multi-tenant desconectado del backend real activo.

### 3.10 Service Worker

Sin cambios en el hallazgo base: `CACHE_VERSION` hardcodeado sin ambiente, *network-only* para `/api/*`. El aislamiento por origen (§7/§22) elimina, para el par `demo.agrogenomax.com` vs. `agrogenomax.com`/`staging.agrogenomax.com`, cualquier posibilidad de que el Service Worker o el Cache Storage de un origen interactúen con los del otro — esta parte de la garantía es real y estructural, y se mantiene sin matiz (§ precisión SOP más abajo distingue esto de la garantía de red, que sí requiere barreras adicionales).

### 3.11 Seeds

`server/sql/003_agx_seed_demo_optional.sql` queda clasificado como artefacto histórico no ejecutable para staging o producción, conforme ADR-002/ADR-014. La existencia histórica de una advertencia en el SQL no sustituye las barreras de ambiente.

**NO VERIFICADO**: contenido completo de `002_agx_seed_demo.sql`; ausencia total de datos de relleno en `GanaderiaApp.jsx` (no auditado línea por línea); si algún proceso operativo fuera del repositorio ya distingue Railway staging de producción; volumen real de uso histórico del override `agx_api_url`; alcance exacto de los cambios y de la cobertura de pruebas introducidos por el commit `26ca461` (no leído línea por línea en esta ronda, por estar fuera del alcance de esta tarea documental — se referencia por su mensaje de commit y su fecha, no se reproduce su diff).

## 4. Requisitos obligatorios

1. Existen tres ambientes: demo, staging, producción — Railway no es un cuarto ambiente funcional.
2. Demo no es producción con una bandera visual.
3. Demo nunca escribe datos productivos, nunca lee datos privados de clientes, nunca usa credenciales productivas, nunca acepta pagos reales, nunca crea órdenes/entitlements/artifacts productivos, nunca usa cookies o tokens válidos en producción.
4. Staging es un ambiente técnico de validación con infraestructura y credenciales propias, datos sintéticos/anonimizados, Wompi sandbox.
5. Producción contiene clientes reales, datos reales, pagos reales, artifacts reales, credenciales productivas, auditoría completa.
6. La cuenta demo y "Ingresar a mi cuenta" son rutas completamente distintas, servidas desde **orígenes web distintos** (§7/§12).
7. No existe fallback silencioso desde producción hacia datos demo/mock — ya corregido en código por el commit `26ca461` para CatastroX, y sostenido como principio arquitectónico permanente por este ADR para cualquier módulo futuro.
8. Si el backend real falla, producción muestra un error controlado — nunca sustituye la respuesta con datos simulados ni aparenta éxito.
9. Cloudflare permanece como frontend y relay same-origin (ADR-009) **para staging y producción exclusivamente**; ECS Express Mode es la plataforma objetivo del backend (ADR-011); Railway permanece como rollback temporal.
10. Cognito/BFF gobierna las sesiones autenticadas; las sesiones y cookies están separadas por ambiente y, para demo, no existen cookies de servidor en absoluto.
11. El modelo multicliente de ADR-008 aplica dentro de producción, como control ortogonal al aislamiento por ambiente.
12. CatastroX respeta ADR-013 en su totalidad, con tokens/cookies/órdenes/entitlements/artifacts que nunca cruzan ambientes.
13. Ganadería demo puede contener datos de muestra; producción inicia limpia por cliente.
14. La base transaccional `agx` y la base geoespacial PostGIS de CatastroX permanecen como dos planos de datos y de credenciales físicamente diferenciados, en cada ambiente — este ADR no autoriza su consolidación (§7/§8).
15. La migración geoespacial permanece condicionada por ADR-006; hasta que se cumpla, CatastroX en producción sigue usando su fuente geoespacial actual.
16. El *target group* del ALB no evalúa PostgreSQL/PostGIS (ADR-012).
17. El override de URL de API por `localStorage`/*query string* solo puede operar cuando `APP_ENV=development` y el hostname es `localhost`/`127.0.0.1` — en demo, staging y producción queda prohibido, ignorado y auditado si se intenta (§13/§21/§36/§37).
18. Staging nunca se puebla restaurando un snapshot de producción para anonimizarlo después — cualquier muestra derivada de producción se anonimiza/sintetiza fuera de staging y antes de su ingreso (§8/§28).
19. La arquitectura objetivo (staging y producción con recursos separados) y la fase inmediata de aprovisionamiento (staging primero, sin infraestructura productiva anticipada) son decisiones distintas, ambas cerradas en este documento (§24).
20. **El origen web independiente de demo (`demo.agrogenomax.com`) garantiza, por sí solo, el aislamiento de almacenamiento y estado del navegador — pero la ausencia efectiva de contacto de red con los backends de staging/producción requiere, de forma obligatoria y combinada, las siete barreras descritas en §7** (bundle sin clientes API productivos, ausencia de relay, ausencia de variables de backend, CSP restrictiva, rechazo desde staging/producción, cookies host-only, y validación automatizada del bundle).
21. No se autoriza ninguna implementación durante esta tarea.

## 5. Definición de ambientes

### Demo

**Objetivo**: demostración comercial, exploración del producto, interacción por visitantes anónimos, datos simulados/sintéticos, persistencia temporal y controlada. **No es**: staging, producción, un entorno de QA, una cuenta real, un cliente real. **Se sirve desde un origen web propio, `demo.agrogenomax.com`** (§7/§12) — un origen del navegador completamente distinto, sin backend, sin base de datos (ningún plano), sin Cognito, sin cookies de servidor, sin pagos, sin credenciales, con fixtures sintéticas empaquetadas y estado interactivo en `sessionStorage` de ese origen. El aislamiento de este origen se logra mediante la combinación de barreras de §7, no solo por la separación de dominio.

### Staging

**Objetivo**: validación técnica, pruebas integrales, ensayos de despliegue/migraciones/rollback, Wompi sandbox, pruebas de Cognito, comparación Railway/ECS. **No es**: demo pública, producción, ambiente para clientes reales. Opera sobre **dos planos de datos separados**: `agx` de staging y PostGIS-CatastroX de staging (§7/§8), cada uno con credenciales propias.

### Producción

**Objetivo**: operación comercial real. Opera igualmente sobre **dos planos de datos separados**: `agx` de producción y PostGIS-CatastroX de producción (esta última solo activa cuando ADR-006 se cumpla).

## 6. Estrategias evaluadas

*Comparación de las seis estrategias de aislamiento de datos, aplicada de forma independiente a cada uno de los dos planos (transaccional `agx` y geoespacial PostGIS-CatastroX) — nunca como una decisión única que los fusione.*

| Estrategia | Aislamiento | Complejidad | Costo | Riesgo de error humano | Riesgo de fuga | Backup/restauración | Migraciones | Observabilidad |
|---|---|---|---|---|---|---|---|---|
| 1. Misma base, columna `environment` | Bajo | Baja | Mínimo | **Alto** | Alto | Compartido | Alto riesgo cruzado | Difícil de separar |
| 2. Misma base, esquemas separados | Medio | Media | Bajo-medio | Medio | Medio | Separable por esquema | Riesgo de esquema equivocado | Parcial |
| 3. Bases separadas, misma instancia | Alto | Media | Bajo-medio | Bajo-medio | Bajo-medio | Por base, recursos físicos compartidos | Independientes, incidente de instancia afecta a ambas | Parcial |
| 4. Instancias separadas | **Alto** | Media-alta | Medio | **Bajo** | **Bajo** | Totalmente independiente | Validables en staging sin riesgo físico sobre producción | Totalmente separable |
| 5. Cuentas AWS separadas | Máximo | Alta | Alto | Bajo, complejidad de identidades cruzadas | Muy bajo | Totalmente independiente | Totalmente independiente | Requiere *tooling* cross-cuenta |
| 6. Combinación por ambiente y criticidad | Ajustable | Ajustable | Ajustable | Ajustable | Ajustable | Ajustable | Ajustable | Ajustable |

**Selección**: **Opción 6, combinación**, cerrada así para cada uno de los dos planos, en cada ambiente:

- **Plano transaccional `agx`** — staging: instancia/base propia (`agx-staging`), credenciales propias. Producción: instancia/base propia (`agx-production`), credenciales propias. `agx-staging` nunca comparte credenciales con `agx-production`.
- **Plano geoespacial PostGIS-CatastroX** — staging: instancia/base propia (`postgis-catastrox-staging`), credenciales propias, poblada conforme al proceso reproducible de ADR-006 o mediante muestra anonimizada previa a su ingreso (§8/§28). Producción: hasta que ADR-006 se cumpla, sigue usando la fuente geoespacial actual de CatastroX, sin cambio alguno por este ADR; una vez ADR-006 se cumpla, instancia/base propia de producción, credenciales propias. `postgis-staging` nunca comparte credenciales con `postgis-production`.
- **Demo**: sin instancia de ningún plano (§7).
- **Cuenta AWS**: una sola cuenta en esta etapa, con la precisión de aprovisionamiento de §24.

**Ninguna frase de este documento debe interpretarse como "una instancia RDS PostgreSQL/PostGIS con `agx` y PostGIS" ni como "una instancia por ambiente para todo"** — donde ambos planos se mencionen juntos por brevedad, se aclara siempre que son planos, bases, *pools* de conexión y credenciales diferenciados, nunca un único recurso consolidado. `DATABASE_URL` nunca equivale a `CATASTROX_DATABASE_URL`.

## 7. Decisión de aislamiento

### Planos de datos

**Por cada ambiente técnico (staging, producción) existen dos planos lógicos y de credenciales completamente diferenciados**:

1. **`agx` (transaccional)**: `customers`, usuarios, organizaciones, membresías, Ganadería, sesiones, órdenes, pagos, entitlements, artifacts, auditoría transaccional.
2. **PostGIS-CatastroX (geoespacial)**: predios, geometrías, capas, vistas, consultas espaciales, datos reproducibles o anonimizados autorizados.

**Reglas cerradas, sin excepción**: `agx-staging` nunca comparte credenciales con `agx-production`; `postgis-staging` nunca comparte credenciales con `postgis-production`; `DATABASE_URL` nunca equivale a `CATASTROX_DATABASE_URL`; los dos *pools* de conexión (`server/db.js`/`server/catastroxDb.js`, ya así en el código verificado) son independientes en el propio proceso backend; PostGIS nunca se convierte en fuente de verdad transaccional; órdenes/pagos/entitlements/artifacts viven únicamente en `agx`; este ADR-014 no autoriza fusionar físicamente `agx` y PostGIS; antes de cumplir ADR-006, CatastroX producción continúa usando su fuente geoespacial actual, sin declararse migrada, sin fusionarse con `agx`, sin que este ADR-014 cambie esa fuente. Este ADR-014 no cambia la topología de datos ya definida por ADR-002, ADR-006, ADR-011 y ADR-013 — solo exige que esa misma topología (dos *pools*, dos esquemas/bases lógicamente distintos) se replique de forma consistente por ambiente, con credenciales exclusivas por ambiente y por plano.

### Origen web de demo

**Demo se sirve desde un origen web independiente: `demo.agrogenomax.com`.** Razón vinculante: aunque `GanaderiaDemo.jsx` está correctamente separado por árbol de componentes y no realiza ninguna llamada de red hoy, alojarlo bajo `agrogenomax.com` comparte origen con producción en el sentido estricto del navegador, y por tanto comparte Service Worker, Cache Storage, `localStorage` de origen, CSP y superficie de errores de enrutamiento con la aplicación real.

Demo mantiene, sin excepción: sin *backend*, sin base de datos (ningún plano), sin Cognito, sin cookies de servidor, sin pagos reales, sin órdenes reales, sin entitlements reales, sin artifacts productivos, sin credenciales, sin relay `/api/*` — con fixtures sintéticas empaquetadas en el propio despliegue de ese origen y estado interactivo en `sessionStorage` de ese origen, con entregables marcados "MUESTRA".

### Precisión técnica final — alcance real de la Same-Origin Policy

**Formulación corregida, vinculante para todo el documento**: *el origen independiente separa estructuralmente cookies, almacenamiento, Service Worker, caché y políticas del navegador. La ausencia efectiva de contacto con los backends de staging y producción se garantiza además mediante un bundle demo sin clientes API productivos, ausencia de relay `/api/*`, ausencia de variables de backend, CSP `connect-src` restrictiva, *allowlists* CORS que excluyen demo, y controles server-side de autenticación, autorización y CSRF.*

**Se corrige explícitamente cualquier afirmación equivalente a**: "el origen del navegador impide que demo alcance producción"; "Same-Origin Policy bloquea cualquier *request* *cross-origin*"; "un error de código en demo no podría enviar tráfico a producción"; "el origen separado es suficiente por sí solo para impedir todo contacto". **Estas formulaciones son técnicamente incorrectas** — la Same-Origin Policy del navegador restringe que un script de un origen **lea** la respuesta de una solicitud hacia otro origen sin que ese otro origen la autorice explícitamente vía CORS; **no impide que el navegador emita la solicitud en primer lugar**. Un `fetch()` disparado por código de `demo.agrogenomax.com` hacia el ALB de producción, o hacia el relay de Cloudflare de producción, se **envía igualmente** por la red — la solicitud puede llegar al servidor, y si ese servidor ejecuta una operación mutativa (por ejemplo, un `POST` que no dependa de leer la respuesta para tener efecto) antes de aplicar sus propios controles de autenticación/autorización/CORS/CSRF, el daño ya habría ocurrido independientemente de que el navegador de origen le niegue después la lectura de la respuesta al script que la inició. Por esta razón, el aislamiento de demo **no puede depender únicamente del origen separado** — depende de la combinación obligatoria de las siguientes siete barreras:

**Barrera 1 — Bundle demo sin clientes API productivos.** El *build* de `demo.agrogenomax.com` no incluye `ganaderiaApi.js` productivo como dependencia activa, no incluye `catastroxApi.js` productivo, no incluye `catastroxPaymentService.js` productivo, no incluye ningún servicio de *checkout* real, no incluye clientes Cognito productivos, no incluye lógica real de órdenes/pagos/entitlements/artifacts, no incluye el *fallback* de Railway, no incluye ninguna URL de ALB, no incluye ningún relay hacia staging o producción. Puede reutilizar: motores de cálculo puros (el mismo usado hoy por `ganaderiaDemoData.js`), componentes visuales, generadores locales (equivalentes de `catastroxDeliverables.js` operando solo sobre fixtures), fixtures, utilidades sin red, lógica de reportes marcada "MUESTRA". Esta barrera es la más importante: si el código que podría iniciar la solicitud de red simplemente no existe en el bundle de demo, no hay ningún `fetch()` que un error de configuración pudiera activar.

**Barrera 2 — Demo sin relay.** `demo.agrogenomax.com` no despliega Cloudflare Pages Functions bajo `/api/*`, no configura `API_BACKEND_URL`, no configura `VITE_API_URL`, no configura `VITE_AGX_API_URL`, no configura `DATABASE_URL`, no configura `CATASTROX_DATABASE_URL`, no configura Cognito, no configura Wompi, no contiene credenciales, no contiene URLs internas de *backend*. Toda solicitud a `/api/*` dentro del origen demo debe responder `404`/`410` o quedar bloqueada por configuración — **nunca** proxyear hacia staging, producción, Railway, ALB, RDS o PostGIS.

**Barrera 3 — CSP restrictiva de demo.** Política conceptual: `Content-Security-Policy: default-src 'self'; connect-src 'self';`. Las excepciones a `connect-src` deben ser explícitas, documentadas, limitadas a servicios públicos indispensables (por ejemplo, un proveedor de teselas de mapas si la demo reutiliza el mismo componente visual de mapa que la app real, §9), mínimas, y **nunca** deben incluir APIs de staging, APIs de producción, Railway o el ALB, ni usar comodines amplios (`*.agrogenomax.com` está explícitamente prohibido como valor de `connect-src`, dado que incluiría a `staging.agrogenomax.com` y a `agrogenomax.com`). Servicios como analítica, mapas o fuentes externas solo se añaden tras revisión explícita.

**Barrera 4 — Rechazo desde staging y producción.** Los *backends* y *relays* de staging/producción no incluyen `demo.agrogenomax.com` en su *allowlist* CORS, no aceptan demo como origen autorizado con credenciales, no reflejan libremente `Origin` (corrige el hallazgo ya confirmado de `functions/api/catastrox/[[path]].js:11-12`, extendido aquí como regla general para cualquier función de relay), no confían en CORS como mecanismo de autenticación, mantienen autenticación y autorización *server-side* independientes de qué origen declare el encabezado `Origin`, mantienen protección CSRF en operaciones basadas en cookies, y no ejecutan ninguna operación mutativa por el solo hecho de recibir una solicitud desde un navegador — siempre exigen la credencial/token/cookie válida y verificada.

**Barrera 5 — Cookies host-only.** Producción usa cookies host-only para `agrogenomax.com`; staging usa cookies host-only para `staging.agrogenomax.com`; demo no emite cookies de servidor; ninguna cookie usa `Domain=.agrogenomax.com`. **Se aclara explícitamente que esta barrera, por sí sola, no sustituye** autenticación, autorización, protección CSRF, validación de sesión, ni un CORS restrictivo — es una capa más dentro de la combinación, no un sustituto de ninguna de las demás.

**Barrera 6 — Validación automatizada del *build* demo (acción futura, no implementada en esta tarea).** Queda como acción requerida (§36) y criterio de aceptación futuro (§37) un control de CI que falle el *build* si el *bundle* de demo contiene, como cadena literal o como dependencia resuelta: `agrogenomax-production.up.railway.app`; `agrogenomax.com/api`; `staging.agrogenomax.com/api`; cualquier dominio de ALB; `API_BACKEND_URL`; `VITE_API_URL`; `VITE_AGX_API_URL`; `DATABASE_URL`; `CATASTROX_DATABASE_URL`; cualquier prefijo `WOMPI_`; cualquier prefijo `COGNITO_`; secretos; tokens; *endpoints* internos; o cualquier cliente productivo de API como dependencia activa (`ganaderiaApi.js`, `catastroxApi.js`, `catastroxPaymentService.js` reales, no sus fixtures). **No se implementa este control durante esta tarea documental.**

**Barrera 7 — Telemetría de violaciones (cuando sea técnicamente posible).** Registrar: violaciones de CSP reportadas por el navegador (`report-to`/`report-uri` si se configura); intentos inesperados de acceder a `/api/*` desde el origen demo; referencias a *endpoints* no permitidos detectadas en tiempo de ejecución; intentos de usar `agx_api_url` fuera de `development` (§21). **Nunca registrar**: datos personales, cookies, tokens, secretos, *payloads* sensibles.

## 8. Bases de datos y esquemas

### Producción

**Plano `agx`**: instancia/base `agx-production` propia, credenciales exclusivas, RLS aplicado (ADR-008), backups y auditoría completos, sin ninguna ruta de acceso desde demo ni desde staging.

**Plano PostGIS-CatastroX**: antes de que ADR-006 se cumpla, producción continúa usando exactamente la fuente geoespacial actual de CatastroX (la instancia/servicio existente referenciado hoy por `CATASTROX_DATABASE_URL`) — no se declara migrada, no se fusiona con `agx-production`, y este ADR-014 no cambia esa fuente. Una vez ADR-006 se cumpla, producción usa una instancia/base `postgis-catastrox-production` propia, con credenciales exclusivas.

### Staging

**Plano `agx`**: instancia/base `agx-staging` propia, separada de `agx-production`, credenciales exclusivas, poblada con datos sintéticos/fixtures de prueba (§28) — nunca con una restauración directa de un *snapshot* de `agx-production` sin el proceso de anonimización previo.

**Plano PostGIS-CatastroX**: instancia/base `postgis-catastrox-staging` propia, separada de la fuente geoespacial de producción, poblada mediante el proceso reproducible que ADR-006 exige (preferido) o mediante una muestra derivada de producción, anonimizada/sintetizada **antes** de su ingreso (§28) — nunca una restauración directa sin ese proceso previo.

### Demo

Sin base de datos propia en ningún plano (§7).

## 9. Datos demo y tenants temporales

- **Origen del dato**: plantilla versionada empaquetada en el despliegue de `demo.agrogenomax.com`.
- **Generación**: determinística, reutilizando el mismo motor de cálculo que la cuenta real.
- **Reset/TTL**: botón "Reiniciar demo" ya implementado; TTL implícito por `sessionStorage` del origen `demo.agrogenomax.com`.
- **Datos permitidos/prohibidos, marcas visuales, trazabilidad, propiedad, limpieza, concurrencia**: cada visitante obtiene su propia copia de plantilla en su propio navegador, sin *dataset* compartido escribible.
- **Decisión sobre el modelo de tenant demo**: combinación de contenido de solo lectura (marketing/informativo) y copia de plantilla en sesión efímera del navegador para la interacción — un "tenant temporal" implementado del lado del cliente, sin ningún punto compartido de escritura entre visitantes.

## 10. Cuenta demo

- **Autenticación**: ninguna — acceso anónimo, sin Cognito, sin cookies de servidor.
- **Origen**: `demo.agrogenomax.com` — no `agrogenomax.com/ganaderia/demo`.
- **Identidad temporal / tenant demo / duración / permisos / operaciones / restablecimiento / cierre de sesión / expiración / limitación de abuso**: mismo diseño ya establecido — ejecutado enteramente dentro del origen `demo.agrogenomax.com`, protegido por las siete barreras de §7, no solo por el origen en sí.

### Garantías exigidas — cómo se cumplen

- **Un visitante no ve las modificaciones temporales de otro**: garantizado por `sessionStorage` propio.
- **Ninguna modificación llega a producción**: garantizada por la combinación de las siete barreras de §7 — no solo por el origen separado (precisión de esta ronda), sino específicamente porque el *bundle* de demo no contiene código capaz de emitir la solicitud (Barrera 1), no hay relay que la reciba (Barrera 2), la CSP la bloquearía si el código existiera igualmente (Barrera 3), y, como última línea de defensa, el propio backend de producción rechazaría el origen y exigiría credenciales válidas (Barrera 4).
- **El visitante no puede convertir la cuenta demo en cuenta real sin flujo explícito**: exige navegar deliberadamente hacia `agrogenomax.com`.
- **Los documentos demo muestran marca "MUESTRA"**: mantenido.
- **QR demo no funciona en producción**: reforzado por la ausencia de cualquier base de datos accesible desde `demo.agrogenomax.com`.
- **Links y tokens demo no funcionan en producción**: no aplica — demo no emite tokens de servidor.

### Rutas actuales — transición

`/ganaderia/demo` (y cualquier futura `/catastrox/demo`) pueden mantenerse temporalmente como redirecciones explícitas hacia `https://demo.agrogenomax.com/ganaderia` y `https://demo.agrogenomax.com/catastrox` respectivamente — **nunca como la ubicación canónica definitiva**.

## 11. Cuentas reales y multicliente

"Ingresar a mi cuenta" (hoy deshabilitado en código): el cliente se autentica vía Cognito + BFF, el backend resuelve su organización/membresía contra el plano `agx` de producción, ve únicamente sus propios módulos y datos filtrados por RLS, inicia vacío si no ha registrado datos, registra animales/predios/potreros/QR/actividades reales, nunca recibe `mockData` ni fallback demo ni hereda datos de la sesión demo (estructuralmente imposible, orígenes distintos y sin relay compartido), nunca comparte datos con otro cliente.

## 12. Dominios, rutas y DNS

- **Producción**: `agrogenomax.com` (apex).
- **Staging**: `staging.agrogenomax.com` — protegido, no indexado.
- **Demo**: **`demo.agrogenomax.com`** — origen independiente, con su propio despliegue de Cloudflare Pages (distinto proyecto/ambiente al de producción y staging).

### Requisitos técnicos de `demo.agrogenomax.com`

- Cloudflare Pages/*deployment* independiente.
- Service Worker independiente, `CACHE_VERSION` propio (§22).
- Nombre de caché propio (Cache Storage).
- **CSP propia y restrictiva** (`default-src 'self'; connect-src 'self';` más excepciones mínimas explícitas, Barrera 3, §7).
- Sin acceso a cookies de producción — host-only, orígenes distintos.
- **Ninguna `API_BACKEND_URL` configurada en el despliegue de demo** (Barrera 2, §7).
- **Ninguna variable ni credencial de backend** presente en el despliegue de demo (Barrera 1/2, §7).
- **Sin relay `/api/*` desplegado en absoluto** (Barrera 2, §7) — cualquier solicitud a `/api/*` dentro de este origen responde `404`/`410` o queda bloqueada por configuración, nunca proxyeada.

### Resto de la decisión de dominios

*Same-origin* relay mantenido exclusivamente para staging/producción, con `API_BACKEND_URL` configurada por ambiente de Cloudflare Pages; cookies host-only por dominio; **CORS por *allowlist* explícita que excluye `demo.agrogenomax.com` de cualquier permiso con credenciales** (Barrera 4, §7); `staging.agrogenomax.com` con `X-Robots-Tag: noindex, nofollow`; sin redirecciones automáticas entre ambientes salvo las explícitas y temporales de §10; enlaces compartidos siempre construidos con el dominio del ambiente que los emite.

## 13. Variables de entorno y configuración

`APP_ENV` (`development`/`demo`/`staging`/`production`) es la fuente explícita y obligatoria del ambiente funcional, con arranque *fail-fast* si no puede determinarse o si la configuración no corresponde al ambiente declarado.

| Variable | Demo | Staging | Producción | Secreta | Fuente |
|---|---|---|---|---|---|
| `APP_ENV` | `demo` (relevante principalmente para el propio *pipeline* de build, dado que no hay proceso backend) | `staging` | `production` | No | Configuración de despliegue |
| `API_BACKEND_URL` (Cloudflare Function) | **No aplica — el despliegue de demo no incluye ninguna Function de relay (Barrera 2)** | ALB/ECS de staging | ALB/ECS de producción | No | Configuración de ambiente de Cloudflare Pages, exclusivamente |
| `VITE_API_URL`/`VITE_AGX_API_URL` | **No presentes en el bundle de demo (Barrera 1/2/6)** | Configuradas para staging | Configuradas para producción | No | Build por ambiente |
| `DATABASE_URL` (`agx`) | No aplica | `agx-staging`, instancia/base propia | `agx-production`, instancia/base propia | **Sí** | Secrets Manager |
| `CATASTROX_DATABASE_URL` (PostGIS) | No aplica | `postgis-catastrox-staging`, instancia/base propia | Fuente actual (pre ADR-006) / `postgis-catastrox-production` (post) | **Sí** | Secrets Manager |
| `COGNITO_USER_POOL_ID`/`COGNITO_CLIENT_ID` | **No aplica (Barrera 1/2)** | Pool de staging | Pool de producción | Parcial | Secrets Manager / configuración |
| `COOKIE_DOMAIN`/`COOKIE_NAME_*` | No aplica | `staging.agrogenomax.com` | `agrogenomax.com` | No | Configuración de ambiente |
| `WOMPI_*` | **No aplica (Barrera 1/2)** | `WOMPI_*_TEST` | `WOMPI_*_PROD` (a aprovisionar) | **Sí** | Secrets Manager |
| `WOMPI_ENV` (corregida para ser leída realmente) | — | `test` | `production` | No | Configuración de ambiente |
| **Override de URL de API (`agx_api_url`/`?apiUrl=`)** | **Prohibido — ignorado por diseño** | **Prohibido — ignorado por diseño** | **Prohibido — ignorado por diseño** | No | **Solo habilitado cuando `APP_ENV=development` y hostname ∈ {`localhost`,`127.0.0.1`}** |
| Feature flags CatastroX (`CATASTROX_AUDIT_DOWNLOADS`, `CATASTROX_ADVANCED_LOOKUP_ENABLED`) | No aplica | Permitidas activas | Desactivadas por defecto | No | Configuración de ambiente |

**Regla reforzada en esta corrección**: la ausencia de `API_BACKEND_URL`/`VITE_API_URL`/`VITE_AGX_API_URL`/`DATABASE_URL`/`CATASTROX_DATABASE_URL`/`WOMPI_*`/`COGNITO_*` en el despliegue de demo **no es una configuración vacía dejada por omisión** — es una condición activamente verificada (Barrera 6, control de CI futuro, §36/§37) de que ninguna de esas variables exista en absoluto en el *bundle* ni en el entorno de ejecución de `demo.agrogenomax.com`.

## 14. Secretos, credenciales e IAM

Secrets Manager como almacén único; secretos por ambiente y por plano (`agx/staging/database-url` y `postgis-catastrox/staging/database-url` como dos secretos distintos); roles IAM por ambiente; nunca compartir credenciales entre ambientes ni entre planos; rotación vía `forceNewDeployment`; acceso humano y de CI/CD auditados y separados por ambiente vía OIDC; *break-glass* como decisión de seguimiento; prohibición absoluta de secretos en frontend y en Git; prohibición explícita de credenciales productivas en demo/staging; prohibición explícita de que el *pool* de `agx` use la credencial del *pool* de PostGIS o viceversa.

**Precisión de esta ronda**: dado que el despliegue de `demo.agrogenomax.com` no configura ningún secreto de ningún tipo (§7 Barrera 1/2, §13), **no existe ninguna superficie de Secrets Manager asociada a demo** — la ausencia de secretos en demo no es una política de acceso restringido sobre un almacén que sí existe, es la ausencia total de cualquier secreto o credencial en ese ambiente.

## 15. Cognito, identidad y sesiones

**User Pools completamente separados por ambiente** (staging, producción) — no un mismo pool con atributo de ambiente. App Clients propios por pool, con Callback/Logout URLs restringidas exclusivamente al dominio de ese ambiente. `issuer`/`audience` distintos por pool, verificados criptográficamente en cada validación de JWT. JWKS por pool, cacheado con TTL. Usuarios de prueba exclusivamente en staging; usuarios reales exclusivamente en producción. Roles resueltos contra el plano `agx` del ambiente correspondiente. **Demo no tiene pool** — sin identidad, sin cliente Cognito de ningún tipo en su *bundle* (Barrera 1, §7). Una sesión de staging nunca es válida en producción, garantizado estructuralmente por `issuer`/`aud` distintos, cookies host-only en dominios distintos, y la sesión BFF referenciada en el plano `agx` de staging, inalcanzable desde el backend de producción.

## 16. Cookies

| Cookie | Ambiente | `Domain` | Notas |
|---|---|---|---|
| Sesión BFF | Producción | Host-only (`agrogenomax.com`) | `__Host-` recomendado cuando sea compatible |
| Sesión BFF | Staging | Host-only (`staging.agrogenomax.com`) | — |
| Acceso de orden CatastroX | Producción / Staging | Host-only por ambiente | ADR-013 §16 |
| Cualquier cookie | **Demo** | **No aplica — demo no emite cookies de servidor** | Reforzado por el origen propio `demo.agrogenomax.com` |
| Administración (Nivel 5) | Producción / Staging | Host-only por ambiente | — |

**Reglas transversales**: ninguna cookie usa `Domain=.agrogenomax.com`; producción usa cookies host-only para `agrogenomax.com`; staging usa cookies host-only para `staging.agrogenomax.com`; demo no emite cookies de servidor; prefijo `__Host-` cuando sea compatible (exige `Secure`+`Path=/`+ausencia de `Domain`); `HttpOnly`, `Secure` y `SameSite` apropiado en todos los casos; **protección CSRF obligatoria para toda operación basada en cookies cuando corresponda** (por ejemplo, `checkout`/`payment-verifications` de CatastroX, ADR-013), como parte de la Barrera 4/5 de §7 — las cookies host-only **no sustituyen** por sí solas la necesidad de un token CSRF o de una validación equivalente en operaciones mutativas.

## 17. Tokens y audiencias

Cada token opaco (intercambio de orden, descarga, recuperación, ADR-013 §17) resuelve contra un registro *server-side* que vive exclusivamente en el plano `agx` del ambiente que lo emitió — nunca en PostGIS. Los JWT de Cognito se separan por `iss`/`aud` de pool (§15). Demo no emite tokens de servidor. Ningún token se distingue solo por el nombre de la URL que lo transporta.

## 18. Wompi y pagos

- **Demo**: sin *checkout* real; cualquier simulación de compra, si se construye, es un flujo visualmente marcado como simulación, sin invocar ninguna ruta real de `POST /orders`/`checkout`, sin crear `order`/`payment_attempt`, sin generar `artifact` productivo — coherente con que el *bundle* de demo no contiene `catastroxPaymentService.js` productivo (Barrera 1, §7).
- **Staging**: Wompi sandbox, llaves `WOMPI_*_TEST`, órdenes/entitlements/artifacts viviendo exclusivamente en `agx-staging`.
- **Producción**: Wompi producción (llaves a aprovisionar), órdenes reales en `agx-production`, auditoría completa.
- **Ninguna llave `_TEST` válida en producción** — validación en el arranque (*fail-fast*, §13).
- `order`/`payment_attempt`/`payment_event` incluyen `environment`, **poblado exclusivamente server-side, nunca aceptado del cliente**.
- Referencias con prefijo distinguible por ambiente; webhook por ambiente si se implementa, validando firma/ambiente/idempotencia/no-replay.

## 19. CatastroX por ambiente

Catálogo oficial de ADR-013 (Básico COP 39.900 — PDF; Plus COP 49.900 — PDF+KML+KMZ; Profesional COP 59.900 — PDF+KML+KMZ+SHP+DXF+coordenadas EPSG:9377); Regularización Predial CRH fuera del catálogo transaccional, representada por `professional_service_lead` en el plano `agx` (ADR-013 §12.2). Catálogo/órdenes/pagos/entitlements/artifacts/tokens/cookies viven exclusivamente en el plano `agx` de cada ambiente. Datos geoespaciales/lookup viven exclusivamente en el plano PostGIS-CatastroX de cada ambiente. Generación de artifacts *server-side* (ADR-013 §11), disparada automáticamente al confirmarse el pago (ADR-013 §13), consultando el plano PostGIS de ese mismo ambiente y registrando el estado en el plano `agx` de ese mismo ambiente — dos *pools* de conexión distintos dentro del mismo proceso. **Demo**: sin checkout real, fixtures sintéticas empaquetadas en `demo.agrogenomax.com` (sin ningún cliente de pago productivo, Barrera 1), artifacts marcados "MUESTRA", sin ningún plano de base de datos involucrado. No se comparte `artifact_id` ni `order_id` entre ambientes ni entre planos como autorización suficiente.

## 20. Ganadería por ambiente

### Demo

Animales, predios, potreros, QR ficticios, pesajes, vacunaciones, reproducción, genética, tratamientos de muestra — servidos desde `demo.agrogenomax.com`, con el patrón ya verificado (`sessionStorage` del origen demo, motor de cálculo real, sin ningún plano de base de datos, sin `ganaderiaApi.js` productivo en el *bundle*, Barrera 1).

### Producción

Cuenta vacía por cliente; datos reales solo tras registro explícito; QR únicos productivos resueltos exclusivamente contra el plano `agx-production`; organización y RLS (ADR-008); sin `mockData`; sin fallback demo.

### Clasificación de `mockData`

`ganaderiaMockData.js`: código huérfano, sin importadores confirmado en la investigación de rondas previas — recomendado retirar (§36). `ganaderiaDemoData.js`: permitido exclusivamente en demo, servido desde `demo.agrogenomax.com`. Dashboards/métricas de la ruta real: bloqueado cualquier dato ficticio — estado vacío explícito si no hay datos aún; auditoría dedicada de `GanaderiaApp.jsx` recomendada como acción de seguimiento (§36) para confirmar ausencia total de datos de relleno.

## 21. Fallbacks y errores

**Regla central**: ningún fallo de API en producción puede provocar automáticamente datos mock, datos demo, respuesta estática simulada, compra simulada, resultado catastral inventado, *health* falso, o un *dashboard* con cifras ficticias — comportamiento exigido: error controlado, mensaje honesto al usuario, *retry*, *logging*, *correlation ID*, métricas, alertas, nunca *fallback* silencioso.

**Estado del fallback mock de CatastroX**: el hallazgo de rondas previas (`lookupPredioWithFallback()`/`resolveLookupForRoute()` activando datos simulados sin aviso visual) **ya fue corregido en código por el commit `26ca461 fix(catastrox): remove silent mock fallback`**, aplicado fuera del alcance de esta tarea documental — este ADR-014 no revierte ni modifica ese commit; registra su existencia como el cierre práctico del hallazgo, y **mantiene como principio arquitectónico permanente** que ningún módulo, presente o futuro, debe reintroducir un patrón equivalente (una condición de error de red degradando silenciosamente hacia datos simulados).

### Control de amenaza — override de URL de API (decisión vinculante, no evaluación futura)

El *override* de URL del *backend* (`agx_api_url` vía `localStorage`, `?agx_api_url=`, `?apiUrl=`) **solo puede funcionar cuando `APP_ENV=development` y el hostname es `localhost` o `127.0.0.1`.**

**En demo, staging y producción**: debe **ignorarse**; el código debe **eliminar activamente cualquier valor previamente persistido** en `localStorage` bajo esa clave al detectar que el ambiente no es `development`; debe **registrarse un evento de seguridad/telemetría** ante cualquier intento de uso fuera de `development` (Barrera 7, §7); el tráfico usa exclusivamente el relay *same-origin* configurado para el ambiente (inexistente en demo, §7/§12).

**En staging y producción, adicionalmente**: ninguna URL de API puede provenir de *query string*; ninguna URL de API puede provenir de `localStorage`; ninguna cookie, token o dato autenticado puede enviarse a un origen seleccionado por el usuario; `API_BACKEND_URL` se configura únicamente en el relay de Cloudflare del ambiente correspondiente.

### Control de amenaza — solicitudes cross-origin no autorizadas desde demo (precisión de esta ronda)

Incluso con el origen `demo.agrogenomax.com` completamente aislado en almacenamiento y estado, **staging y producción deben tratar cualquier solicitud entrante, sin importar su `Origin` declarado, bajo el mismo estándar de autenticación/autorización/CSRF que aplicarían a cualquier otro origen no confiable** (Barrera 4, §7) — este control server-side es la última línea de defensa, independiente de que las Barreras 1-3 (bundle sin clientes, sin relay, CSP restrictiva) ya deban impedir que la solicitud se origine en primer lugar.

## 22. Service Worker y caché

- **Nombre de caché por ambiente**: `CACHE_VERSION` incorpora el ambiente (`agrogenomax-pwa-production-v<N>`, `agrogenomax-pwa-staging-v<N>`, `agrogenomax-demo-v<N>`).
- **Aislamiento de almacenamiento**: al vivir `demo.agrogenomax.com`, `staging.agrogenomax.com` y `agrogenomax.com` en orígenes distintos, el límite de origen del navegador garantiza que cada Service Worker, cada Cache Storage y cada `localStorage` son inalcanzables entre sí — **esta garantía específica (almacenamiento y *scope* del Service Worker) es real y estructural, y no requiere las siete barreras de §7**, que aplican a la garantía distinta de ausencia de contacto de red.
- **`network-only` para `/api/*`**: mantenido para staging y producción; **no aplica a `demo.agrogenomax.com`, que no tiene ningún `/api/*` desplegado en absoluto** (Barrera 2, §7).
- **No cachear órdenes/sesiones/artifacts privados**: mantenido, `no-store` en las respuestas de staging/producción.
- **No servir demo en producción / no servir staging en producción**: garantizado por el aislamiento de origen para el contenido servido — **no elimina, por sí solo, la necesidad de las Barreras 1-4 de §7 para la ausencia de contacto de red**, que es una propiedad distinta.

## 23. Artifacts y almacenamiento

Namespace/*bucket*/prefijo por ambiente, cifrado KMS por ambiente, *lifecycle*/retención por ambiente, URLs no predecibles, auditoría/*hashes* por ambiente. Los artifacts de CatastroX se generan a partir de datos del plano PostGIS y se autorizan/registran en el plano `agx` (§19). Demo no genera artifacts productivos ni usa ningún almacenamiento real (§7).

## 24. Infraestructura AWS

### A. Arquitectura objetivo

Staging y producción con recursos completamente aislados: dos planos de datos (`agx`, PostGIS-CatastroX) por ambiente, Cognito, roles IAM y secretos separados, ECS/ALB separados, dentro de una sola cuenta AWS en esta etapa, con nomenclatura consistente (`agx-<env>-<plano>-<recurso>`). **Demo no tiene ningún recurso de cómputo o base de datos en AWS** — es exclusivamente un despliegue de Cloudflare Pages con contenido estático/*bundle* de frontend (Barrera 1/2, §7).

### B. Fase inmediata de aprovisionamiento

Se implementa **staging primero**. No se aprovisiona infraestructura productiva de forma simultánea ni anticipada. Producción solo se crea después de superar los *gates* ya exigidos por ADR-011 (§14.1/§19.1), ADR-012 (verificación de *health*/*readiness* en staging), ADR-013 (flujo transaccional completo probado en staging con Wompi sandbox) y este propio ADR-014 (separación de ambientes, incluidas las siete barreras de demo, verificadas operando correctamente). Toda creación de recursos AWS requiere revisión de costo y aprobación explícita. Se respeta el presupuesto AWS vigente. No se crean RDS, ALB, Cognito User Pools ni ningún otro recurso productivo por anticipado "para dejarlos preparados".

### Separación por recurso, cuando cada recurso se aprovisione conforme a B

| Recurso | Demo | Staging | Producción |
|---|---|---|---|
| Cloudflare Pages | Proyecto/ambiente `demo`, **sin Functions bajo `/api/*`** | Proyecto/ambiente `staging`, con Functions de relay | Proyecto/ambiente `production`, con Functions de relay |
| ECS service/cluster | **No aplica** | `agx-staging-*` | `agx-production-*` (solo tras *gates*) |
| RDS `agx` | No aplica | `agx-staging`, instancia propia | `agx-production`, instancia propia (solo tras *gates*) |
| RDS/PostGIS CatastroX | No aplica | `postgis-catastrox-staging`, instancia propia | Fuente actual (pre ADR-006) / instancia propia (post) |
| Cognito User Pool | **No aplica** | Pool staging | Pool producción (solo tras *gates*) |
| Secrets Manager | **No aplica** | Rutas `staging/agx/*`, `staging/postgis/*` | Rutas `production/agx/*`, `production/postgis/*` |
| CloudWatch | Analítica de frontend estándar, sin *log group* de servidor | *Log groups*/métricas staging | *Log groups*/métricas producción |

## 25. Railway durante la transición

Railway no es un ambiente adicional. Cada despliegue lleva `APP_ENV` explícito. Railway staging y Railway producción no comparten base ni secretos en ningún plano. El *rollback* de Cloudflare conserva el mismo ambiente. Nunca *rollback* de producción hacia un *backend* demo/staging.

## 26. CI/CD y promoción

*Backend*: imagen inmutable promovida por *digest*, configuración/secretos en *runtime* por ambiente y por plano. *Frontend*: construido por ambiente. **Tres *pipelines* diferenciados: demo, staging, producción** — el *pipeline* de demo es estructuralmente distinto de los otros dos: no produce ninguna imagen de contenedor de *backend* (no hay *backend* que construir), su único artefacto es el *bundle* estático de frontend, sujeto a la Barrera 6 de §7 (validación automatizada de ausencia de clientes API productivos/variables de *backend*/secretos antes de publicarse). Ningún secreto se compila dentro del frontend en ningún *pipeline*. No se promueve entre ambientes: datos, cookies, usuarios, órdenes, artifacts, secretos, IDs ni bases.

## 27. Migraciones

Orden: staging → producción, aplicado de forma independiente a cada plano (`agx`, PostGIS-CatastroX) — demo queda fuera del *pipeline* en ambos planos (sin persistencia). *Expand-and-contract*; *backups*; *rollback*; *locks* independientes por instancia. Prohibición explícita: nunca se ejecutan migraciones productivas desde un proceso/credencial etiquetado como demo o staging. Credenciales de migración separadas de *runtime*, aplicable a cada plano por separado.

## 28. Seeds, fixtures y anonimización

### Fuente ordinaria de staging

Datos sintéticos generados deliberadamente para pruebas; fixtures versionadas; seeds de prueba idempotentes; importaciones geoespaciales reproducibles conforme a ADR-006 — vía preferida para poblar `postgis-catastrox-staging` sin tocar datos de producción.

### Proceso excepcional — muestra derivada de producción

**Prohibido restaurar directamente un snapshot productivo en staging y anonimizarlo después.** Cuando excepcionalmente se requiera una muestra derivada de producción, el proceso obligatorio es:

1. Autorizar expresamente la extracción.
2. Exportar únicamente el subconjunto mínimo necesario.
3. Anonimizar o sintetizar la muestra **fuera de staging y antes de su ingreso**, en un entorno de procesamiento aislado, distinto de producción y de staging.
4. Eliminar o transformar de forma irreversible: nombres; correos electrónicos; celulares; documentos de identidad; direcciones; identificadores de clientes; identificadores de organizaciones; IDs de órdenes; referencias de pago; tokens; cualquier otro dato sensible.
5. Generar identificadores sintéticos nuevos.
6. Validar que la muestra resultante no permita reidentificación razonable.
7. Importar únicamente el resultado sanitizado a staging.
8. Auditar el proceso completo — autor, subconjunto exportado, transformación aplicada, momento de importación, confirmación de que ningún dato intermedio permaneció accesible fuera del entorno de procesamiento aislado.

### Prohibido, sin excepción

Restaurar un *snapshot* completo de producción en staging; cargar PII real en staging temporalmente con la intención de borrarla después; conectar staging directamente a producción para consultar datos; copiar usuarios, órdenes, pagos, artifacts, tokens o secretos de producción hacia staging.

## 29. Observabilidad

Separación de *logs*/métricas/trazas/alarmas/*dashboards* por ambiente, con etiqueta adicional de **plano de datos** (`agx`/`postgis-catastrox`) cuando aplique. Cada evento indica `environment`, `service`, `version`, `deployment`, `organization` cuando corresponda, `task`, *correlation ID*. `demo.agrogenomax.com`, al no tener *backend*, se observa únicamente con analítica de frontend estándar y con la telemetría de violaciones de la Barrera 7 (§7) — sin ningún *log group* de servidor propio.

## 30. Limpieza y reset de demo

Sin persistencia *server-side* — no existe ningún job de limpieza que ejecutar contra ningún recurso de producción. El reset es el comportamiento del propio navegador (`sessionStorage`) más el botón "Reiniciar demo", ejecutado enteramente dentro de `demo.agrogenomax.com`. **La defensa técnica exigida (que sea imposible ejecutar el reset demo contra producción) queda garantizada por la combinación de**: ausencia de *backend* de demo (Barrera 1/2), ausencia de credenciales de ningún tipo en el despliegue de demo (Barrera 1/2), y aislamiento de origen web para cualquier estado que pudiera confundirse (§22) — **no por el origen separado en solitario**, precisión aplicable también a esta sección.

## 31. Promoción entre ambientes

Se promueve: código; imagen del *backend* por *digest*; definiciones de Terraform (por plano); migraciciones de esquema de `agx` y de PostGIS (probadas en staging); catálogo de CatastroX como configuración versionada; configuración no secreta. No se promueve, sin excepción: datos de ningún plano; cookies; tokens; usuarios; órdenes; artifacts; secretos de ningún plano; *logs*; IDs; bases de datos de ningún plano.

## 32. Matriz de amenazas

| Amenaza | Vector | Impacto | Control preventivo | Control detectivo | Riesgo residual |
|---|---|---|---|---|---|
| Demo escribiendo en producción | Componente demo hace una llamada de red al backend real | Contaminación de datos productivos | **Combinación de Barreras 1-4 (§7): bundle sin clientes API productivos, sin relay, CSP `connect-src` restrictiva, y rechazo server-side desde producción incluso si la solicitud llegara** | Auditoría de despliegue del proyecto `demo.agrogenomax.com`; Barrera 6 (CI, acción futura); Barrera 7 (telemetría de CSP) | Bajo — múltiples barreras independientes, ninguna suficiente por sí sola pero la combinación cierra el vector |
| **Solicitud cross-origin desde demo alcanzando la red de staging/producción, aunque la lectura de la respuesta esté bloqueada por CORS** (amenaza precisada en esta ronda — corrige la sobreestimación de la garantía de origen en la ronda anterior) | Un `fetch()` u otra solicitud disparada por código de `demo.agrogenomax.com`, si existiera por error, se envía igualmente por la red antes de que el navegador aplique cualquier restricción de lectura | Una operación mutativa en el servidor podría ejecutarse antes de que el navegador de origen bloquee la lectura de la respuesta al script que la inició | **Barrera 1 (el código capaz de emitirla no existe en el bundle) es la defensa primaria; Barrera 4 (rechazo server-side, autenticación/autorización/CSRF independientes del `Origin`) es la defensa de última línea** | Barrera 7 (telemetría de intentos de acceso a `/api/*` no permitidos, si se detectan) | Bajo tras implementar Barreras 1 y 4 combinadas — **no aceptable depender solo del origen separado** |
| Fuga de Service Worker/Cache Storage/`localStorage` entre demo y producción | Ambos servidos bajo el mismo origen web (diseño anterior a la Corrección 1) | Confusión de estado entre demo y producción | Orígenes web completamente distintos — el límite de origen del navegador lo impide por construcción **para esta garantía específica de almacenamiento** | No requiere monitoreo activo | Muy bajo |
| Staging leyendo producción, en cualquiera de los dos planos | Credencial mal configurada apuntando a la instancia equivocada | Exposición de datos reales | Credenciales e instancias separadas por ambiente y por plano; `APP_ENV` validado en el arranque | Alarma de conexión cruzada | Bajo tras implementación |
| Fusión accidental de `agx` y PostGIS en una sola instancia durante la implementación futura | Interpretación laxa de "una instancia por ambiente" | Pérdida de la separación de planos | Prohibición explícita (§4, §6, §7) | Revisión de arquitectura antes de aprovisionar cada plano | Bajo |
| Cookie de staging válida en producción | `Domain` mal configurado | Sesión de prueba aceptada en producción | Cookies host-only; demo sin cookies de servidor | Revisión de configuración | Bajo tras implementación |
| Override de URL de API usado para exfiltrar datos autenticados | Manipulación de `agx_api_url`/`?apiUrl=` en staging o producción | Cookies/tokens/datos autenticados enviados a un origen no controlado | Prohibición vinculante fuera de `development`+`localhost`; limpieza activa de `localStorage`; ignorar el parámetro | Registro de evento de seguridad/telemetría ante cualquier intento | Bajo tras implementación |
| Wompi test marcando orden productiva como pagada | Llave de prueba usada por error en producción | Entitlement/artifact otorgado sin pago real | Prohibición de variables `_TEST` en producción, *fail-fast* | Auditoría de configuración; alarma si `environment` no coincide | Medio hasta validación de coincidencia implementada |
| Rollback de producción hacia backend staging | Decisión operativa apresurada | Producción sirviendo con datos/credenciales de staging | Prohibición explícita | Runbook de incidentes con destinos válidos documentados | Medio — depende de disciplina operativa |
| Fallback mock silencioso | Confirmado en rondas previas, **ya corregido en código por el commit `26ca461`** | Resultado catastral inventado sin aviso | Corregido en código; principio arquitectónico mantenido para no reintroducirlo | Métrica de `source: mock` en producción, debe ser siempre cero | Bajo, condicionado a no reintroducir el patrón en módulos futuros |
| Restaurar snapshot productivo en staging "temporalmente" y anonimizar después | Atajo operativo bajo presión de tiempo | PII real expuesta en un ambiente de menor control | Proceso obligatorio de 8 pasos, anonimización fuera de staging y antes del ingreso | Auditoría del proceso (paso 8) | Medio — mitigable con autorización explícita previa (paso 1) |
| Seed ejecutado en producción | Ejecución manual contra `DATABASE_URL` de producción | Datos ficticios mezclados con reales | Credenciales de migración separadas por ambiente y plano | Auditoría de ejecución de *scripts* | Medio |
| Reset demo ejecutado contra producción | Comando invocado con parámetros equivocados | Pérdida/alteración de datos productivos | No existe ningún recurso productivo alcanzable desde el mecanismo de reset demo | No aplica | Muy bajo |
| QR demo usado en producción | Escaneo contra el endpoint real | Fallo de resolución (esperado) | QR demo no existe en ningún plano de producción | Métrica de resoluciones fallidas | Bajo |
| Artifact demo compartido como real | Confusión comercial | Fraude/confusión del cliente | Marca "MUESTRA" obligatoria | Revisión de producto | Bajo |
| Usuario real viendo datos demo | Error de enrutamiento/estado compartido | Confusión del cliente | Árboles de componentes separados y orígenes web separados | Pruebas de regresión de UI | Muy bajo |
| Cliente A viendo datos de cliente B | Falla de RLS (ADR-008) | Filtración entre clientes reales | RLS + condiciones de ADR-008 §14 — control ortogonal | Auditoría de acceso por organización | Fuera del alcance directo de esta ADR-014 |
| Secreto productivo expuesto en frontend | Variable `VITE_*` con valor sensible por error | Compromiso de credenciales | Prohibición absoluta; demo, sin ninguna variable de backend, elimina esta superficie por completo | Escaneo de secretos en el bundle (Barrera 6, recomendado) | Medio hasta escaneo automatizado |
| Logs mezclados | *Log groups* no separados | Dificulta auditoría | *Log groups* separados por ambiente y etiquetados por plano | Revisión periódica de etiquetado | Bajo tras implementación |
| Alarma demo tratada como incidente productivo | No aplica a demo (sin backend); aplicable a staging | Escalamiento innecesario | Alarmas separadas por ambiente | Revisión de configuración | Bajo |
| Restauración de backup en ambiente equivocado | Snapshot restaurado sobre la instancia equivocada | Exposición o pérdida de datos reales | Instancias físicamente separadas por ambiente y por plano; nomenclatura clara | Verificación manual obligatoria antes de cualquier restauración | Medio, mitigable con nomenclatura estricta |

## 33. Consecuencias positivas

Cierra la brecha que ADR-004 dejó abierta, con un mecanismo técnico concreto y ahora correctamente fundamentado en el comportamiento real del navegador (no en una sobreestimación de la Same-Origin Policy). Elimina el fallback mock silencioso de CatastroX (ya corregido en código, commit `26ca461`). La separación explícita de dos planos de datos evita la fusión accidental de `agx` y PostGIS. La prohibición vinculante del override de URL de API cierra una superficie de exfiltración de credenciales. El proceso de anonimización obligatoria antes del ingreso a staging elimina la ventana de riesgo de PII real temporalmente presente. La precisión sobre Same-Origin Policy evita que el equipo de implementación confíe en una garantía de aislamiento de red que el navegador no provee, dirigiendo el esfuerzo de implementación hacia controles que sí cierran el riesgo real (bundle sin clientes, ausencia de relay, CSP, controles server-side).

## 34. Consecuencias negativas

Un origen web adicional (`demo.agrogenomax.com`) implica un tercer *pipeline* de *build*/despliegue a mantener. La combinación obligatoria de siete barreras para el aislamiento de demo es más compleja de verificar que confiar únicamente en la separación de origen — requiere disciplina de mantenimiento continuo del *bundle* de demo (evitar que un futuro `import` reintroduzca un cliente API productivo) y, eventualmente, el control de CI de la Barrera 6 para no depender solo de revisión humana. Mantener dos planos de datos por ambiente duplica la cantidad de secretos, roles y *pools* de conexión a gestionar. El proceso de anonimización de 8 pasos es más costoso operativamente que una restauración directa. Provisionar staging primero y diferir producción retrasa la disponibilidad de un ambiente productivo completo.

## 35. Riesgos

| Riesgo | Origen | Tratamiento propuesto |
|---|---|---|
| Implementación integral de las siete barreras todavía no completada | Mecanismo diseñado por este ADR, implementación parcial verificada | Completar acciones requeridas (§36), manteniendo lo ya implementado: APP_ENV/VITE_APP_ENV fail-fast, override development-only, CORS endurecido, health relay real, graceful shutdown y cierre de pools |
| Separación física completa de ambientes aún pendiente | Recursos/credenciales/pipeline demo no completados | Acción requerida |
| Migración del contenido demo hacia `demo.agrogenomax.com` no ejecutada todavía | Confirmado | Acción requerida, con redirecciones temporales mientras tanto |
| Control de CI de la Barrera 6 no implementado — hasta entonces, la ausencia de clientes API productivos en el bundle de demo depende de revisión humana | Nuevo | Acción requerida, no bloqueante para el resto del diseño |
| Ninguna llave de producción de Wompi existe | Confirmado | Aprovisionamiento coordinado con el negocio |
| `GanaderiaApp.jsx` no auditado línea por línea | NO VERIFICADO | Auditoría dedicada recomendada |

## 36. Acciones requeridas

*(Ninguna se ejecuta como parte de este ADR.)*

- Mantener `APP_ENV`/`VITE_APP_ENV` como variables leídas y validadas (*fail-fast*) por backend/frontend.
- Mantener la restricción del override `agx_api_url` a `APP_ENV=development` + hostname local; completar limpieza activa de cualquier valor persistido en `localStorage` fuera de esa condición y registrar telemetría/evento de seguridad ante cualquier intento fuera de `development`.
- Crear el despliegue `demo.agrogenomax.com` como proyecto de Cloudflare Pages independiente.
- Migrar el contenido de Ganadería demo (`GanaderiaDemo.jsx`, `ganaderiaDemoData.js`, componentes asociados) al nuevo origen, dejando redirecciones temporales explícitas en `/ganaderia/demo`.
- Configurar la CSP restrictiva de demo (`default-src 'self'; connect-src 'self';` + excepciones mínimas documentadas).
- **Eliminar cualquier cliente API productivo (`ganaderiaApi.js`, `catastroxApi.js`, `catastroxPaymentService.js` reales) del bundle de `demo.agrogenomax.com`**, confirmando que la demo solo reutiliza motores de cálculo puros, componentes visuales y fixtures.
- **Eliminar/omitir cualquier relay `/api/*` del despliegue de demo** (sin Cloudflare Pages Functions bajo esa ruta).
- Crear el control de CI que valide la ausencia de dominios/variables/secretos de backend en el bundle de demo (Barrera 6) — no implementado en esta tarea documental.
- Crear el dominio `staging.agrogenomax.com` con `noindex` y acceso restringido.
- Aprovisionar, en la fase inmediata, primero `agx-staging` como recurso independiente.
- Aprovisionar `postgis-catastrox-staging` como plano separado de `agx-staging`.
- Aprovisionar el User Pool de Cognito de staging.
- Corregir `WOMPI_ENV` para que sea efectivamente leída.
- Auditar `GanaderiaApp.jsx` para confirmar ausencia total de datos de relleno en la ruta real.
- Retirar `ganaderiaMockData.js` si se confirma huérfano en una auditoría de código dedicada.
- Diseñar, si se decide construirla, una demo explícita de CatastroX con fixtures estáticas.
- Documentar como procedimiento operativo el proceso de anonimización de 8 pasos (§28).
- Diseñar el procedimiento de *break-glass* de acceso de emergencia a producción.
- Aprovisionar producción (RDS de ambos planos, Cognito, ECS/ALB) únicamente después de superar los *gates* de ADR-011/012/013/014 en staging y de obtener aprobación explícita de costo.

## 37. Criterios de aceptación

- Ningún fallo de API en producción resulta en una respuesta que aparente ser exitosa con datos simulados.
- `APP_ENV` es obligatoria; el backend no arranca si no puede determinar su propio ambiente o si su configuración no corresponde al ambiente declarado.
- **`demo.agrogenomax.com` es un origen web verificablemente distinto de `agrogenomax.com` y `staging.agrogenomax.com`.**
- **Demo no comparte cookies, `localStorage`, `sessionStorage`, Cache Storage ni Service Worker con ningún otro ambiente.**
- **Demo no tiene ningún relay `/api/*` desplegado.**
- **Demo no contiene ninguna variable de backend (`API_BACKEND_URL`, `VITE_API_URL`, `VITE_AGX_API_URL`, `DATABASE_URL`, `CATASTROX_DATABASE_URL`, `WOMPI_*`, `COGNITO_*`) en su despliegue.**
- **Demo no contiene, como dependencia activa de su bundle, ningún cliente API productivo (`ganaderiaApi.js`, `catastroxApi.js`, `catastroxPaymentService.js` reales).**
- **La CSP de `demo.agrogenomax.com` limita `connect-src` a `'self'` más excepciones mínimas explícitamente documentadas, nunca incluyendo dominios de staging/producción/Railway/ALB ni comodines amplios.**
- **Staging y producción rechazan `demo.agrogenomax.com` como origen autorizado con credenciales en su configuración CORS.**
- **Ninguna solicitud cross-origin puede ejecutar una operación mutativa sin pasar por autenticación, autorización y protección CSRF server-side, independientemente del `Origin` declarado.**
- **El bundle de demo pasa el escaneo de CI de la Barrera 6 (control futuro, no implementado en esta tarea) sin encontrar dominios/variables/secretos de backend prohibidos.**
- El override de URL de API no tiene ningún efecto fuera de `APP_ENV=development` en `localhost`/`127.0.0.1`.
- La demo no realiza ninguna llamada de red legítima hacia ningún backend real, en ningún flujo de uso normal.
- Ningún snapshot productivo es restaurado directamente en staging sin el proceso de anonimización de 8 pasos.
- `agx` y PostGIS permanecen como planos físicamente separados, con credenciales exclusivas, en cada ambiente.
- Ningún recurso productivo (RDS, ALB, Cognito) se crea antes de que staging haya superado los *gates* exigidos.
- Todo entregable generado en demo lleva marca "MUESTRA".
- Ningún dashboard de una cuenta real sin datos aún muestra cifras de relleno.

## 38. Elementos fuera de alcance

Implementación de código, infraestructura, bases de datos, esquemas, usuarios, credenciales, Terraform, *workflows* o recursos de AWS. Conexión a AWS, Railway, Cloudflare, Wompi o cualquier servicio externo. Ejecución de *builds*, pruebas, migraciones. Implementación del control de CI de la Barrera 6. Diseño detallado del procedimiento de *break-glass*. Diseño completo de una eventual demo de CatastroX con fixtures. Cifras definitivas de retención, TTL o frecuencia de limpieza. Decisión de evolución a cuentas AWS separadas. Migración efectiva del contenido de `/ganaderia/demo` hacia `demo.agrogenomax.com`. Modificación del commit `26ca461` o de cualquier otro código existente. Modificación de cualquier ADR anterior.

## 39. Decisiones de seguimiento

**A.** Diseño detallado del procedimiento de *break-glass*.

**B.** Diseño detallado del proceso de anonimización de 8 pasos como procedimiento operativo documentado (§28).

**C.** Diseño, si se aprueba construirla, de una demo explícita de CatastroX con fixtures estáticas.

**D.** Selección de la herramienta y disciplina exacta de migraciones.

**E.** Cifras definitivas de retención/TTL/frecuencia de limpieza de staging.

**F.** Evaluación de cuentas AWS separadas como evolución futura.

**G.** Diseño exacto de la separación de prefijos de QR entre demo y producción.

**H.** Evaluación de migrar `.env.production` fuera de git.

**I.** Plan concreto de migración de `/ganaderia/demo` hacia `demo.agrogenomax.com`, incluyendo la duración de las redirecciones temporales.

**J.** Diseño técnico exacto del control de CI de la Barrera 6 (herramienta de escaneo, momento de ejecución en el pipeline, umbral de bloqueo).

**K.** Diseño exacto del mecanismo de telemetría de violaciones (Barrera 7): endpoint de recepción de reportes CSP, formato de los eventos, retención.

## 40. Relación con ADR anteriores

- **ADR-001/ADR-003/ADR-005/ADR-007/ADR-009/ADR-010/ADR-011/ADR-012**: sin cambios respecto de la relación ya establecida en rondas previas de este documento.
- **ADR-002**: `agx` como fuente de verdad de Ganadería se mantiene igual en cada instancia del plano `agx` por ambiente.
- **ADR-004**: este documento es el ADR de seguimiento dedicado que ADR-004 anunció, con el aislamiento de origen web de demo y la precisión sobre Same-Origin Policy como sus correcciones más fundamentales frente a la propuesta inicial.
- **ADR-006**: la migración geoespacial permanece condicionada exactamente igual — este ADR-014 refuerza que producción sigue usando la fuente actual hasta que ADR-006 se cumpla, sin fusionar esa condición con el plano `agx`.
- **ADR-008**: el modelo multicliente opera dentro del plano `agx` de cada ambiente de producción/staging.
- **ADR-013**: el sistema transaccional de CatastroX vive exclusivamente en el plano `agx` de cada ambiente; el commit `26ca461` cierra en código el hallazgo de fallback silencioso que ADR-013 también identificó, sin que este ADR-014 lo modifique.

---

## Anexo A. Diagrama demo/staging/production

```
┌───────────────────────────┐  ┌──────────────────────────────┐  ┌───────────────────────────────┐
│           DEMO             │  │            STAGING            │  │           PRODUCCIÓN            │
│  demo.agrogenomax.com      │  │   staging.agrogenomax.com     │  │        agrogenomax.com          │
│  (ORIGEN WEB INDEPENDIENTE)│  │   (noindex, acceso restringido)│  │                                  │
│                             │  │                                │  │                                  │
│  Cloudflare Pages —         │  │  Cloudflare Pages — ambiente   │  │  Cloudflare Pages — ambiente     │
│  proyecto/deployment propio│  │  "staging"                     │  │  "production"                   │
│                             │  │        │                       │  │        │                         │
│  SIN Functions bajo /api/*  │  │        ▼ same-origin relay     │  │        ▼ same-origin relay       │
│  (Barrera 2)                │  │  ALB staging (ECS Express Mode)│  │  ALB producción                 │
│                             │  │        │                       │  │        │                         │
│  SIN ganaderiaApi.js,       │  │        ▼                       │  │        ▼                         │
│  catastroxApi.js,           │  │  ┌──────────┐  ┌────────────┐ │  │  ┌──────────┐  ┌───────────────┐│
│  catastroxPaymentService.js │  │  │agx-staging│  │postgis-    │ │  │  │agx-      │  │Fuente actual   ││
│  productivos (Barrera 1)    │  │  │(plano     │  │catastrox-  │ │  │  │production│  │CatastroX (pre  ││
│                             │  │  │transacc.) │  │staging     │ │  │  │(plano    │  │ADR-006) /      ││
│  SIN cookies de servidor     │  │  │credenciales│  │(plano geo) │ │  │  │transacc.)│  │postgis-        ││
│  SIN Cognito                │  │  │propias     │  │credenciales│ │  │  │credencia-│  │production      ││
│  SIN credenciales            │  │  └──────────┘  │propias      │ │  │  │les propias│ │(post ADR-006)  ││
│  SIN ningún plano de BD      │  │                 └────────────┘ │  │  └──────────┘  └───────────────┘│
│                             │  │  Cognito User Pool STAGING     │  │  Cognito User Pool PRODUCCIÓN    │
│  CSP: default-src 'self';   │  │  Wompi SANDBOX                 │  │  Wompi PRODUCCIÓN                │
│  connect-src 'self';        │  │                                │  │                                  │
│  (Barrera 3)                │  │  CORS: excluye demo.*           │  │  CORS: excluye demo.*            │
│                             │  │  (Barrera 4)                   │  │  (Barrera 4)                     │
│  sessionStorage: fixtures    │  │                                │  │                                  │
│  sintéticas + motor de       │  │                                │  │                                  │
│  cálculo real (sin fetch)    │  │                                │  │                                  │
└───────────────────────────┘  └──────────────────────────────┘  └───────────────────────────────┘

PRECISIÓN: el origen separado garantiza por sí solo el aislamiento de
cookies/almacenamiento/Service Worker/Cache Storage/CSP (flechas verticales
internas de cada caja). La AUSENCIA DE CONTACTO DE RED (flechas horizontales
que NO existen entre cajas) depende de la combinación de Barreras 1-4:
sin cliente API en el bundle demo (1) + sin relay que reciba la solicitud (2)
+ CSP que impediría el fetch si el código existiera (3) + rechazo server-side
en staging/producción como última línea de defensa (4).

Railway: plataforma de alojamiento temporal, NO un ambiente propio.

Rutas actuales /ganaderia/demo y /catastrox/demo: redirección temporal
explícita hacia demo.agrogenomax.com/ganaderia y /catastrox — no la
ubicación canónica definitiva.

Fase inmediata de aprovisionamiento (§24.B): STAGING se implementa primero;
PRODUCCIÓN (RDS de ambos planos, Cognito, ECS/ALB) solo se crea después de
superar los gates de ADR-011/012/013/014 en staging.
```

## Anexo B. Matriz ambiente → recursos

| Recurso | Demo | Staging | Producción |
|---|---|---|---|
| Origen web | `demo.agrogenomax.com` (independiente) | `staging.agrogenomax.com` | `agrogenomax.com` |
| Cloudflare Pages Function (relay `/api/*`) | **Ninguna (Barrera 2)** | Sí, apunta a ALB staging | Sí, apunta a ALB producción |
| Clientes API productivos en el bundle | **Ninguno (Barrera 1)** | Sí | Sí |
| CSP `connect-src` | `'self'` + excepciones mínimas (Barrera 3) | Según necesidad, incluye el propio origen | Según necesidad, incluye el propio origen |
| ECS service/cluster | No aplica | `agx-staging-*` | `agx-production-*` (solo tras *gates*) |
| RDS — plano `agx` | No aplica | `agx-staging` | `agx-production` (solo tras *gates*) |
| RDS/servicio — plano PostGIS-CatastroX | No aplica | `postgis-catastrox-staging` | Fuente actual (pre ADR-006) / `postgis-catastrox-production` (post) |
| Cognito User Pool | No aplica | Pool staging | Pool producción (solo tras *gates*) |
| Secrets Manager | **No aplica** | `staging/agx/*`, `staging/postgis/*` | `production/agx/*`, `production/postgis/*` |
| Service Worker | Propio, origen `demo.agrogenomax.com`, sin `/api/*` que cachear | Propio, origen staging, `network-only` para `/api/*` | Propio, origen producción, `network-only` para `/api/*` |
| Control de CI de bundle (Barrera 6, futuro) | Aplica exclusivamente al pipeline de demo | No aplica | No aplica |

## Anexo C. Matriz ambiente → datos

*(Sin cambios respecto de la ronda anterior — ver §8/§28.)*

## Anexo D. Matriz ambiente → credenciales

*(Sin cambios respecto de la ronda anterior — ver §7/§14.)*

## Anexo E. Matriz dominios/cookies/tokens

| | Demo | Staging | Producción |
|---|---|---|---|
| Dominio | `demo.agrogenomax.com` (origen independiente) | `staging.agrogenomax.com` | `agrogenomax.com` |
| Indexación | Indexable (superficie de marketing, decisión comercial) | `noindex` | Indexable |
| Cookies de sesión | **Ninguna — sin backend, sin servidor de cookies** | Host-only, dominio staging | Host-only, dominio producción |
| CSRF | No aplica (sin cookies, sin operaciones mutativas server-side) | Obligatoria en operaciones con cookies | Obligatoria en operaciones con cookies |
| Tokens de intercambio/orden | Ninguno | Resueltos solo contra `agx-staging` | Resueltos solo contra `agx-production` |
| JWT (Cognito) | No aplica | `iss`/`aud` de pool staging | `iss`/`aud` de pool producción |
| Relay `/api/*` | **No existe (Barrera 2)** | Sí, hacia ALB staging | Sí, hacia ALB producción |
| CORS allowlist | No aplica (sin backend) | Excluye `demo.agrogenomax.com` (Barrera 4) | Excluye `demo.agrogenomax.com` (Barrera 4) |

## Anexo F. Matriz Wompi por ambiente

*(Sin cambios respecto de la ronda anterior — ver §18.)*

## Anexo G. Matriz CatastroX por ambiente

*(Sin cambios respecto de la ronda anterior — ver §19.)*

## Anexo H. Matriz Ganadería por ambiente

*(Sin cambios respecto de la ronda anterior — ver §20.)*

## Anexo I. Flujo de reset demo

```
Visitante entra a demo.agrogenomax.com/ganaderia
        │
        ▼
Carga plantilla versionada (empaquetada en el despliegue de demo)
   → sessionStorage DEL ORIGEN demo.agrogenomax.com
        │
        ▼
Visitante interactúa — cambios solo en su propio sessionStorage,
en un origen SIN backend (Barrera 1/2), SIN cookies, SIN ningún plano
de base de datos, SIN clientes API productivos capaces de emitir una
solicitud de red hacia staging/producción
        │
        ▼
Botón "Reiniciar demo" → recarga la plantilla desde cero (idempotente)
        │
        ▼
Cierre de pestaña/navegador → sessionStorage se descarta (TTL implícito)

La defensa contra un reset demo alcanzando producción NO depende solo del
origen separado — depende de que el bundle de demo no contenga ningún
código capaz de emitir esa solicitud (Barrera 1) y de que no exista ningún
relay que la recibiera aunque se emitiera (Barrera 2).
```

## Anexo J. Flujo de anonimización previa al ingreso a staging

*(Sin cambios respecto de la ronda anterior — ver §28.)*

## Anexo K. Matriz de amenazas

*Ver §32 — reproducida por referencia.*

## Anexo L. Matriz de trazabilidad ADR-001 a ADR-013 → ADR-014

| ADR | Relación con ADR-014 |
|---|---|
| ADR-001 | Topología de red/ejecución base, duplicada por ambiente |
| ADR-002 | `agx` como fuente de verdad de Ganadería, replicada por instancia |
| ADR-003 | Gobernanza de Terraform/OIDC aplicada a toda la infraestructura de este documento |
| ADR-004 | Este ADR-014 es el ADR de seguimiento dedicado que ADR-004 anunció |
| ADR-005 | Clasificación de rutas por nivel, ortogonal a la dimensión de ambiente |
| ADR-006 | Migración geoespacial sin cambios en su condición; PostGIS staging/producción separados cuando exista |
| ADR-007 | Cognito + `agx` como autorización, duplicados por ambiente |
| ADR-008 | Multicliente/RLS, control complementario dentro de cada ambiente de producción/staging |
| ADR-009 | Patrón BFF/cookie, cookies host-only exclusivas por dominio de ambiente |
| ADR-010 | Estado remoto de Terraform separado por ambiente |
| ADR-011 | ECS Express Mode/ALB/Railway, duplicado y clarificado por ambiente |
| ADR-012 | Health checks/Service Worker, reforzados por ambiente |
| ADR-013 | Sistema transaccional de CatastroX, duplicado íntegramente por ambiente; el commit `26ca461` cierra en código uno de sus hallazgos, sin que este ADR-014 lo modifique |

---

## Cierre

### 1. Recomendación ejecutiva

Demo se sirve desde un origen web completamente independiente, `demo.agrogenomax.com`, sin *backend* ni base de datos. Staging y producción mantienen dos planos de datos y credenciales completamente diferenciados (`agx` transaccional, PostGIS-CatastroX geoespacial), nunca consolidados. El *override* de URL de API queda prohibido de forma vinculante fuera de `development`+`localhost`. Staging nunca se puebla restaurando un *snapshot* de producción sin anonimizar antes. Se implementa staging primero, sin infraestructura productiva anticipada. **Precisión técnica final**: el origen independiente de demo garantiza, por sí solo, el aislamiento de cookies, almacenamiento, Service Worker, caché y políticas del navegador — pero la ausencia efectiva de contacto de red con los *backends* de staging/producción requiere, de forma obligatoria y combinada, un *bundle* de demo sin clientes API productivos, ausencia de relay `/api/*`, ausencia de variables de *backend*, CSP `connect-src` restrictiva, *allowlists* CORS que excluyen demo, y controles *server-side* de autenticación/autorización/CSRF en staging y producción — nunca la afirmación de que el origen separado, por sí solo, "bloquea" cualquier contacto.

### 2. Arquitectura final de ambientes

Demo (`demo.agrogenomax.com`, origen propio, sin backend) / Staging (`staging.agrogenomax.com`, dos planos de datos propios) / Producción (`agrogenomax.com`, dos planos de datos propios, aprovisionada solo tras los *gates*).

### 3. Decisión de dominio demo

`demo.agrogenomax.com`, *deployment* de Cloudflare Pages independiente; `/ganaderia/demo` y una futura `/catastrox/demo` quedan como redirecciones temporales, no como ubicación canónica.

### 4. Decisión de bases y planos de datos

Dos planos por ambiente (`agx`, PostGIS-CatastroX), nunca fusionados; credenciales exclusivas cada una; PostGIS nunca es fuente de verdad transaccional; antes de ADR-006, CatastroX en producción sigue usando su fuente actual.

### 5. Decisión de tenant demo

Copia de plantilla versionada en `sessionStorage` del origen `demo.agrogenomax.com`, por visitante.

### 6. Decisión de usuario real

Resuelve Cognito + plano `agx-production`/RLS, inicia vacío, nunca `mockData` ni hereda estado de la demo.

### 7. Decisión de Cognito

User Pools completamente separados por ambiente, App Clients propios, Callback/Logout URLs propias, `issuer`/`audience` distintos; demo sin pool; usuarios de prueba solo en staging, usuarios reales solo en producción.

### 8. Decisión de cookies y tokens

Cookies host-only exclusivas de `agrogenomax.com`/`staging.agrogenomax.com`, con `HttpOnly`/`Secure`/`SameSite` apropiado y protección CSRF en operaciones mutativas; demo sin cookies de servidor; tokens opacos resueltos exclusivamente contra el plano `agx` del ambiente que los emitió.

### 9. Decisión Wompi

Sandbox exclusivo en staging, productivo exclusivo en producción (a aprovisionar); ninguna llave `_TEST` válida en producción; `environment` poblado exclusivamente server-side.

### 10. Decisión CatastroX

Catálogo oficial de ADR-013 (Básico 39.900/Plus 49.900/Profesional 59.900), Regularización fuera del catálogo transaccional; sistema transaccional completo en el plano `agx`; lookup/geometría en el plano PostGIS; demo sin checkout real.

### 11. Decisión de Ganadería

Demo 100% *client-side* en `demo.agrogenomax.com` con QR/documentos "MUESTRA"; producción inicia vacía por cliente, nunca `mockData` ni fallback demo.

### 12. Decisión de eliminación del override de API

Prohibido de forma vinculante fuera de `development`+`localhost`; ignorado, limpiado activamente de `localStorage`, y auditado si se intenta.

### 13. Decisión de datos y anonimización en staging

Fuente ordinaria sintética/fixtures/seeds/importación reproducible; muestra excepcional de producción vía proceso obligatorio de 8 pasos, anonimizada antes de ingresar — prohibida la restauración directa.

### 14. Decisión sobre fallbacks

Ningún fallback silencioso a datos simulados en producción — el hallazgo de CatastroX ya fue corregido en código por el commit `26ca461`, sostenido aquí como principio arquitectónico permanente.

### 15. Decisión AWS

Una sola cuenta AWS en esta etapa, con recursos/roles/secretos separados por ambiente y por plano de datos; demo sin ningún recurso de cómputo o base de datos.

### 16. Distinción entre arquitectura objetivo y aprovisionamiento inmediato

Staging se implementa primero; producción solo tras superar los *gates* de ADR-011/012/013/014 y aprobación explícita de costo; ningún recurso productivo se crea anticipadamente.

### 17. Decisión Railway

No es un ambiente propio; cada despliegue con `APP_ENV` explícito; sin compartir base ni secretos entre Railway staging y producción; rollback de producción nunca hacia demo/staging.

### 18. Decisión CI/CD

Backend por imagen inmutable promovida por digest; frontend construido por ambiente (tres pipelines: demo, staging, producción); el pipeline de demo, estructuralmente distinto, produce solo un bundle estático sujeto a la validación futura de la Barrera 6.

### 19. Decisión de migraciones

Orden staging → producción, aplicado independientemente a cada plano; demo fuera del pipeline; credenciales de migración separadas de runtime.

### 20. Decisión de reset demo

Sin job server-side; defensa técnica por ausencia estructural de backend, credenciales y relay en el origen `demo.agrogenomax.com`.

### 21. Riesgos críticos

Implementación parcial verificada de las siete barreras: APP_ENV/VITE_APP_ENV fail-fast, override development-only, CORS endurecido en relays revisados, health relay real, graceful shutdown y cierre de pools. El mecanismo integral todavía no está completado: faltan despliegue `demo.agrogenomax.com`, bundle demo separado, eliminación de relay `/api/*` en demo, CSP específica, validación automatizada del bundle, migración de `/ganaderia/demo`, cookies host-only, Cognito/BFF/CSRF, separación física completa, anonimización automatizada y telemetría de CSP.

### 22. Decisiones pendientes

Once decisiones de seguimiento (§39): *break-glass*, procedimiento operativo de anonimización, demo de CatastroX, herramienta de migraciones, cifras de retención/TTL, evolución a cuentas AWS separadas, prefijos de QR, `.env.production` fuera de git, plan de migración de `/ganaderia/demo`, diseño técnico del control de CI (Barrera 6), diseño del mecanismo de telemetría (Barrera 7).

### 23. Información NO VERIFICADA

Contenido completo de `002_agx_seed_demo.sql`; ausencia total de datos de relleno en `GanaderiaApp.jsx`; procesos operativos fuera del repositorio que ya distingan Railway staging de producción; volumen real histórico de uso del override `agx_api_url`; alcance exacto del diff y de la cobertura de pruebas del commit `26ca461` (no leído línea por línea en esta tarea, por estar fuera de su alcance).

### 24. Archivos consultados

`.env.example`, `server/.env.example`, `.env.production`, `.gitignore`, `src/App.jsx`, `src/registerServiceWorker.js`, archivos de Ganadería/CatastroX ya citados en rondas previas de este proceso, `server/index.js`, `server/sql/003_agx_seed_demo_optional.sql`, funciones de Cloudflare, `public/service-worker.js`, `vite.config.js`, `package.json`, `server/package.json`, `docs/adr/ADR-001` a `ADR-013`, `docs/architecture/AGROGENOMAX_TECHNICAL_ARCHITECTURE_HANDBOOK_V1.md`, `docs/AWS_TRANSITION_PLAN_PHASE_0_STAGING.md`; referencia (sin lectura de diff) al commit `26ca461`.

### 25. Contradicciones corregidas

La ronda anterior de este documento, al establecer el origen independiente de demo, podía leerse como si esa separación de origen fuera suficiente por sí sola para impedir todo contacto de red con producción — **corregido explícitamente en esta ronda**: el origen separado garantiza el aislamiento de almacenamiento y estado del navegador, pero la ausencia de contacto de red requiere la combinación obligatoria de las siete barreras descritas en §7.

### 26. Confirmación de ausencia de modificaciones

No se modificó ningún archivo de código, ruta, frontend, backend, Cloudflare, Railway, AWS, PostgreSQL/PostGIS, Cognito, Wompi, Terraform, workflow, `package.json`, `vite.config.js`, `.env`, ni el commit `26ca461`. No se ejecutó ningún build, prueba, `npm install`, migración ni conexión externa. No se ejecutó `git add`, `git commit`, `git push`, `git reset`, `git restore`, `git checkout`, `git clean` ni `git stash`. Únicamente se creó el archivo de este ADR.
