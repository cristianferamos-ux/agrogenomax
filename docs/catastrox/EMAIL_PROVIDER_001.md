# EMAIL_PROVIDER_001 — Auditoría y diseño de integración del proveedor de correo transaccional (CatastroX)

Rama: `feat/catastrox-staging-email-provider` (base `2da668d`, merge de PR #11).
Alcance original de este documento (EMAIL_PROVIDER_001): **auditar el sistema
actual y diseñar** la integración de un proveedor transaccional real para
staging, sin conectar nada todavía.

**Estado actual: decisión confirmada e implementada (EMAIL_PROVIDER_002, ver
§12).** Resend es el proveedor de staging — confirmado, no solo recomendado.
Producción sigue evaluándose por separado y Resend **no** está habilitado ahí
(ver §9/§12). No hay secretos reales en este documento — solo nombres de
variables y valores de ejemplo explícitamente marcados como placeholder o
sintéticos.

## 1. Auditoría del sistema actual

### 1.1 `server/services/catastrox/emailSender.js`
Interfaz de un solo archivo, sin proveedor conectado. `sendEmail({ to, subject })`
registra el intento (`console.info`, solo el dominio del correo — nunca el
correo completo, nunca el asunto con datos variables más allá del literal fijo
`subject`) y devuelve siempre `{ delivered: false, providerMessageId: null,
mode: 'stub' }`. Nunca finge éxito. El contrato de retorno ya es honesto por
diseño — el defecto real es que no existe ninguna implementación `mode:
'provider'` detrás de él.

### 1.2 `server/routes/catastroxPayments.js` — `POST /customers`
Flujo actual (líneas ~325-389):
1. Valida el body (`validateCustomerInput`).
2. `customers.upsertCustomer(validated)` — cifra/hashea PII, transaccional.
3. `customers.createEmailVerification(customer.id)` — genera un código de 6
   dígitos (`crypto.randomInt`, nunca `Math.random`), lo hashea (`hashPii`,
   HMAC-SHA256) y lo persiste con `expires_at = now() + 10min`. El código en
   claro solo vive en la variable local `code` de esta request — nunca se
   guarda en texto plano.
4. Descifra el correo del comprador en memoria (`decryptCustomerPii`) — la
   única razón de descifrarlo es poder transportarlo a `sendEmail()`.
5. Llama `sendEmail({ to, subject })`.
6. Si `!emailResult.delivered && appEnv no es development/test` → `503
   EMAIL_DELIVERY_UNAVAILABLE`, sin exponer el código ni fingir éxito.
7. Si es `development`/`test` → la respuesta incluye `devOtpCode: code` como
   único mecanismo de prueba, ya que no hay proveedor real conectado.

Ningún otro archivo del backend llama a `sendEmail()` — es un punto de
integración único, lo que simplifica el diseño de esta fase (un solo lugar
que reemplazar).

### 1.3 `server/config/env.js`
No existe hoy ninguna variable relacionada con proveedor de correo en
`REQUIRED_VARIABLES_BY_ENV` ni en ningún bloque de validación de formato —
`emailSender.js` no lee ninguna variable de entorno todavía. Confirmado
leyendo el archivo completo: cero referencias a `EMAIL`/`RESEND`/`SES`/
`POSTMARK`/`SMTP`.

### 1.4 `server/.env.example`
Mismo resultado: ninguna variable de correo documentada hoy. El bloque de
`CATASTROX_BACKFILL_TRANSACTION_ID` es la entrada más reciente; no hay
sección de email.

### 1.5 Pruebas de OTP y clientes
`server/routes/__tests__/catastroxCustomerOtpAndHistory.test.js` cubre hoy:
correo verificado/no verificado, código incorrecto, código consumido no
reutilizable, `devOtpCode` presente en `development`/`test` y **ausente** en
`production` (caso 13), y `EMAIL_DELIVERY_UNAVAILABLE` con `503` cuando
`appEnv` no es dev/test (caso ~14, línea 248). Estas pruebas **no mockean
ninguna llamada HTTP saliente** porque hoy no existe ninguna — `sendEmail()`
nunca hace red. Esto es una implicación directa para la fase de conexión: en
cuanto exista una llamada `fetch()` real a un proveedor, estas pruebas
(y las nuevas) deberán interceptar `globalThis.fetch`, con el mismo patrón ya
usado en `functions/api/__tests__/healthRelay.test.js`/`corsRelay.test.js`
(sustituir `globalThis.fetch` en cada prueba, restaurar en `afterEach`).

No existe hoy ningún archivo `emailSender.test.js` — es una pieza nueva que
se creará en la fase de conexión (ver §10).

### 1.6 Manejo de errores y logs
- `console.info` en el stub actual: solo `toDomain` (parte después del `@`) y
  el `subject` literal fijo — nunca el correo completo, nunca el código.
- `console.error` en la ruta: solo `error.message` de excepciones internas
  (persistencia, verificación) — nunca el body de una respuesta de terceros,
  nunca PII.
- Mismo patrón que el resto del módulo de pagos (`fetchWompiTransaction`,
  los tres relays de Cloudflare): errores saneados, nunca se registra el
  valor de un secreto ni el contenido completo de una respuesta upstream.
- **Gap identificado, a evitar en el nuevo diseño**: `fetchWithSingleTransportRetry()`
  (la función equivalente para Wompi, mismo archivo, línea ~123) reintenta
  una vez ante un error de transporte pero **no tiene ningún timeout
  explícito** — un `fetch()` colgado no se corta nunca. El diseño de
  `sendVerificationEmail()` (§4) corrige esto explícitamente con
  `AbortController`, en vez de replicar el gap.

### 1.7 Comportamiento actual por ambiente

| Ambiente | `sendEmail()` | `POST /customers` si `!delivered` | OTP visible al cliente |
|---|---|---|---|
| `development` | Stub, `delivered:false` | Continúa (200), no bloquea | `devOtpCode` en la respuesta JSON |
| `test` | Stub, `delivered:false` | Continúa (200), no bloquea | `devOtpCode` en la respuesta JSON |
| `staging` | Stub, `delivered:false` | **503 `EMAIL_DELIVERY_UNAVAILABLE`** | Nunca — el flujo de comprador no puede completarse hoy en staging (documentado como bloqueante en `docs/catastrox/STAGING_READINESS_001.md`, hallazgo #4) |
| `production` | Stub, `delivered:false` | **503 `EMAIL_DELIVERY_UNAVAILABLE`** | Nunca |

`!import.meta.env.PROD` (frontend, `CatastroXOtpVerification.jsx`) más el
gate `isDevOrTest` (backend) garantizan doblemente que `devOtpCode` nunca
sobrevive a un build de producción ni a una respuesta fuera de dev/test —
confirmado en `src/modules/catastrox/utils/__tests__/prodBuildOtpLeak.test.js`.
Este lote no toca ninguno de esos dos gates.

## 2. Comparación técnica de proveedores

| Criterio | **Resend** | **Amazon SES** | **Postmark** |
|---|---|---|---|
| Integración con Node.js | REST simple (`POST /emails`, `Authorization: Bearer`), un solo `fetch()` — mismo patrón que `fetchWompiTransaction()`, sin SDK | Requiere SDK de AWS (`@aws-sdk/client-sesv2`) para una integración razonable, o firmar SigV4 a mano contra la API REST — no encaja con el patrón "fetch nativo, cero dependencias" ya establecido | REST simple (`POST /email`, header `X-Postmark-Server-Token`), un solo `fetch()`, mismo patrón que Resend |
| Dominio/remitente verificado | Verificación por DNS (SPF/DKIM/DMARC), rápida con DNS ya gestionado en Cloudflare; existe un dominio de pruebas compartido para arrancar sin verificar dominio propio | Verificación de dominio o de dirección individual por DNS/correo; **cuentas nuevas arrancan en "sandbox"**, solo pueden enviar a destinatarios pre-verificados hasta pedir "production access" a soporte de AWS (aprobación manual, 1-2 días hábiles típicamente) | Verificación por *Sender Signature* (correo individual) o dominio completo (DKIM + Return-Path CNAME) — proceso similar a Resend |
| Costo | Nivel gratuito generoso (miles de correos/mes) suficiente para todo el ciclo de staging sin tarjeta de crédito | El más barato a escala real (fracciones de centavo por correo) — pero sin nivel gratuito perpetuo fuera de EC2 | Sin nivel gratuito perpetuo — solo un lote de prueba pequeño, luego planes de pago desde un nivel de entrada bajo |
| Límites de staging | El nivel gratuito cubre cómodamente ciclos de QA de staging de forma indefinida | El modo sandbox por defecto es *más* restrictivo que necesario para staging (requiere pre-verificar cada destinatario de prueba, o pedir salida de sandbox) | El lote de prueba es pequeño — se agota rápido en ciclos de QA repetidos, forzando pasar a un plan pago antes de lo ideal solo para seguir probando en staging |
| Reputación/entregabilidad | Empresa más nueva (desde ~2023), buena reputación técnica, pool de reputación de remitente más joven que las otras dos | Muy establecido (desde 2011), gran escala, reputación sólida mezclada con la variabilidad de un pool de IPs compartidas (mitigable con IP dedicada, costo adicional) | Reputación específicamente **excelente** para correo transaccional puro — política estricta de contenido (prohíbe marketing en el mismo *stream*) precisamente para proteger la entregabilidad; referencia frecuente como la mejor en esta categoría |
| Soporte para Colombia | Sin restricción regional — correo es global | Sin restricción regional (elegir cualquier región de AWS soportada, p. ej. `us-east-1`) | Sin restricción regional |
| Webhooks/bounces | Webhooks directos (basados en Svix) para entregado/rebotado/quejas/abierto — configuración simple en el panel | Requiere SNS (Simple Notification Service) como intermediario entre SES y el endpoint propio — una pieza de infraestructura adicional que este repo no tiene hoy | Webhooks directos, sin intermediario — sistema maduro y bien documentado, orientado específicamente a *bounce handling* transaccional |
| Gestión de secretos | Un solo secreto (API key) | Dos-tres secretos (access key, secret key, región) o un rol IAM si se corriera dentro de AWS (no es el caso hoy) | Un solo secreto (*Server Token*) |
| *Lock-in* | Bajo — la llamada es un `fetch()` plano; migrar solo toca `emailSender.js` | Medio-alto si se usa el SDK (acopla a la forma de autenticación de AWS); bajo si se firma a mano (pero eso añade complejidad propia) | Bajo — mismo motivo que Resend |
| Complejidad operativa | Baja — sin cuenta AWS, sin proceso de aprobación, sin intermediario de webhooks | Alta — IAM, posible solicitud de salida de sandbox, SNS para webhooks, selección de región | Baja-media — proceso de verificación de dominio similar a Resend, pero sin la fricción del nivel gratuito pequeño salvo por el costo del plan |

## 3. Recomendación para staging: **Resend**

**Para staging específicamente** (no necesariamente la decisión final de
producción, ver residual risk §9): Resend, por estas razones concretas,
en orden de peso:

1. **Cero fricción de arranque.** SES fuerza una espera de aprobación manual
   de AWS (fuera del control de este equipo) antes de poder enviar a
   destinatarios de prueba arbitrarios; Postmark agota su lote de prueba
   rápido en un ciclo de QA normal. El nivel gratuito de Resend cubre todo
   el ciclo de staging sin bloqueos externos ni tarjeta de crédito.
2. **Encaja exactamente con el patrón ya establecido en este repo.** La
   integración con Wompi (`fetchWompiTransaction`) es un `fetch()` simple con
   un `Authorization: Bearer <key>` — Resend es la única de las tres opciones
   que replica esa forma exacta sin necesitar un SDK nuevo (evita la
   dependencia pesada del SDK de AWS) ni una librería de firma manual.
3. **Un solo secreto que gestionar**, coherente con el patrón ya usado para
   `WOMPI_EVENTS_SECRET_TEST`/`CATASTROX_PII_HASH_SECRET` en
   `server/config/env.js` (una variable, formato validado, nunca registrada).
4. **DNS ya gestionado en Cloudflare** (mismo proveedor que ya opera el
   dominio y los relays de Pages Functions) — verificar un subdominio de
   envío (p. ej. `mail.staging.agrogenomax.com`) es una tarea del mismo
   equipo con las mismas herramientas, sin aprender una consola nueva solo
   para esto.
5. **Webhooks sin intermediario** — no añade una pieza de infraestructura
   nueva (SNS) solo para recibir eventos de rebote/queja.

**Riesgo residual reconocido, no descartado**: Resend es la más joven de las
tres compañías. Postmark tiene el mejor historial de entregabilidad
específicamente para correo transaccional puro (que es exactamente lo que es
un OTP), y SES es la opción de menor costo por correo a escala real. Ninguna
decisión de *producción* debe darse por tomada a partir de esta
recomendación de *staging* — ver §9, decisión pendiente #1.

## 4. Contrato final de `emailSender.js` (diseño, no implementado en este lote)

```js
/**
 * @param {{
 *   to: string,
 *   verificationCode: string,
 *   expiresAt: Date,
 *   customerName: string | null,
 * }} input
 * @returns {Promise<{
 *   delivered: boolean,
 *   provider: 'stub' | 'resend' | 'ses' | 'postmark',
 *   providerMessageId: string | null,
 *   errorCode: string | null,
 * }>}
 */
export async function sendVerificationEmail({ to, verificationCode, expiresAt, customerName }) { ... }
```

Diferencias deliberadas frente al contrato actual `sendEmail({to, subject})`:
- **Nombre explícito de propósito** (`sendVerificationEmail`, no un `sendEmail`
  genérico) — este archivo tiene un único llamador y un único propósito hoy;
  nombrarlo así evita que un futuro llamador distinto (p. ej. un correo de
  factura) reutilice esta función asumiendo que acepta contenido arbitrario.
- **La función arma el contenido del correo internamente** (asunto, cuerpo,
  plantilla) a partir de `verificationCode`/`expiresAt`/`customerName` — el
  llamador (la ruta) ya NO decide `subject` como string libre. Esto cierra
  por diseño cualquier posibilidad de inyección de contenido arbitrario en el
  correo desde una capa que maneja input HTTP.
- **`provider` siempre presente en la respuesta** (incluso en el stub, que
  devuelve `provider: 'stub'`) — permite observabilidad uniforme sin importar
  el modo.
- **`errorCode` reemplaza cualquier mensaje de error libre** — closed set,
  nunca el texto/cuerpo crudo de la respuesta del proveedor:

| `errorCode` | Significado |
|---|---|
| `null` | Solo cuando `delivered: true` |
| `PROVIDER_NOT_CONFIGURED` | `CATASTROX_EMAIL_PROVIDER` ausente/inválida, o falta el secreto del proveedor elegido |
| `PROVIDER_TIMEOUT` | La solicitud al proveedor no respondió dentro del timeout explícito |
| `PROVIDER_TRANSPORT_ERROR` | Error de red/DNS/socket antes de obtener cualquier respuesta HTTP (mismo criterio que `isWompiTransportError`) |
| `PROVIDER_AUTH_ERROR` | El proveedor rechazó las credenciales (401/403) |
| `PROVIDER_RATE_LIMITED` | El proveedor respondió 429 |
| `PROVIDER_REJECTED` | El proveedor devolvió una respuesta HTTP válida pero rechazó el envío (p. ej. destinatario inválido, dominio no verificado) |
| `PROVIDER_UNKNOWN_ERROR` | Cualquier otra respuesta no-2xx no cubierta arriba — nunca se reenvía el cuerpo original |

### Reglas obligatorias aplicadas en el diseño

- **Nunca registrar correo completo ni OTP**: los logs (`console.info`/
  `console.error`/telemetría futura) solo incluyen el dominio del
  destinatario (mismo patrón que hoy, `toDomain`) y `provider`/`errorCode` —
  nunca `to` completo, nunca `verificationCode`, nunca el cuerpo de la
  respuesta del proveedor.
- **Nunca devolver el OTP en staging/producción**: esta función ni siquiera
  recibe el código para "devolverlo" — lo recibe para incluirlo en el cuerpo
  del correo que arma internamente. El único lugar que decide si expone
  `devOtpCode` sigue siendo la ruta (`isDevOrTest`), sin cambios — este
  diseño no toca ni debilita ese gate existente.
- **Timeout explícito**: `AbortController` con un límite configurable
  (`CATASTROX_EMAIL_TIMEOUT_MS`, default propuesto 5000ms) envolviendo la
  llamada `fetch()` al proveedor — corrige el gap identificado en §1.6 (Wompi
  no tiene timeout hoy; este diseño no lo replica).
- **Reintentos limitados**: mismo criterio que `fetchWithSingleTransportRetry`
  — **un solo reintento**, y únicamente ante error de transporte (DNS/socket,
  nunca una respuesta HTTP ya recibida). Un 429/5xx del proveedor **no** se
  reintenta automáticamente dentro de esta función — se devuelve
  `PROVIDER_RATE_LIMITED`/`PROVIDER_UNKNOWN_ERROR` y es la ruta quien decide
  si el comprador debe reintentar manualmente (reenviando `POST /customers`,
  ya protegido por `customerLimiter`).
- **Errores saneados**: ver tabla de `errorCode` arriba — ningún cuerpo de
  respuesta de terceros ni excepción cruda llega a un log o a una respuesta
  HTTP.
- **Fail-closed**: `delivered` nace `false` y solo se marca `true` si el
  proveedor confirma la aceptación (2xx + `providerMessageId` presente en la
  respuesta) — igual que el comentario ya existente en el stub actual, ahora
  aplicado a una implementación real.
- **Idempotencia/deduplicación**: `createEmailVerification()` ya genera una
  fila nueva por intento — el riesgo real de duplicado es un *reenvío* del
  mismo `POST /customers` (doble clic del frontend) disparando dos llamadas
  de envío para el mismo código. Diseño propuesto para la fase de conexión:
  pasar un `Idempotency-Key` derivado de `sha256(customerId + codeHash)` si
  el proveedor elegido lo soporta nativamente (Resend lo soporta vía header
  `Idempotency-Key`); como respaldo independiente del proveedor, un guardado
  corto en memoria/DB (p. ej. no reenviar si ya se envió para el mismo
  `email_verifications.id` en los últimos N segundos) — **la implementación
  exacta de este respaldo es una decisión a cerrar en la fase de conexión**,
  no en esta.
- **Proveedor configurable por variable de entorno**: `CATASTROX_EMAIL_PROVIDER`
  (ver §5) selecciona la implementación en tiempo de arranque — nunca
  hardcodeado.
- **`development`/`test` conservan el stub seguro**: cuando
  `CATASTROX_EMAIL_PROVIDER` es `stub` (o está ausente, comportamiento
  por defecto fuera de staging/producción), la función sigue el
  comportamiento actual exacto: registra solo el dominio, devuelve
  `{ delivered: false, provider: 'stub', providerMessageId: null,
  errorCode: null }` — sin ninguna llamada de red.

## 5. Variables de entorno (definidas, sin secretos reales, no agregadas al código en este lote)

Estas variables se documentan aquí como parte del diseño (pedido explícito,
punto 6). **No se agregaron a `server/config/env.js` ni a
`server/.env.example` en este lote** — hacerlo antes de confirmar el
proveedor definitivo (§9, decisión #1) crearía una validación obligatoria
prematura para un valor que todavía puede cambiar.

| Variable | Requerida (cuando se conecte) | Ejemplo/formato (placeholder) | Uso |
|---|---|---|---|
| `CATASTROX_EMAIL_PROVIDER` | Sí en staging/producción una vez conectado; `stub` por defecto en development/test | `stub` \| `resend` \| `ses` \| `postmark` | Selecciona la implementación activa |
| `CATASTROX_EMAIL_FROM_ADDRESS` | Sí, junto con el proveedor | `no-reply@staging.agrogenomax.com` | Remitente verificado ante el proveedor elegido |
| `CATASTROX_EMAIL_FROM_NAME` | No (default `"AgroGenomaX CatastroX"`) | `AgroGenomaX CatastroX` | Nombre visible del remitente |
| `CATASTROX_EMAIL_TIMEOUT_MS` | No (default `5000`) | `5000` | Límite del `AbortController` alrededor de la llamada al proveedor |
| `RESEND_API_KEY` | Sí, solo si `CATASTROX_EMAIL_PROVIDER=resend` | `re_REEMPLAZAR` | Autenticación Bearer contra la API de Resend |
| `POSTMARK_SERVER_TOKEN` | Sí, solo si `CATASTROX_EMAIL_PROVIDER=postmark` | `REEMPLAZAR` | Header `X-Postmark-Server-Token` |
| `AWS_SES_ACCESS_KEY_ID` / `AWS_SES_SECRET_ACCESS_KEY` / `AWS_SES_REGION` | Sí, solo si `CATASTROX_EMAIL_PROVIDER=ses` | `REEMPLAZAR` / `REEMPLAZAR` / `us-east-1` | Credenciales IAM dedicadas para envío (nunca compartidas con otro uso de AWS) |
| `CATASTROX_EMAIL_WEBHOOK_SECRET` | No en esta fase (sin receptor de webhooks todavía) | `REEMPLAZAR` | Reservada para una fase futura que verifique la firma de webhooks de rebote/queja |

Todas seguirían el mismo patrón de validación ya establecido en
`server/config/env.js` (formato mínimo, sin espacios, rechazo de
placeholders vía el patrón ya existente `TU_|REEMPLAZAR|PLACEHOLDER|XXX|DEMO`,
nunca expuestas en un mensaje de error) — a implementar en la fase de
conexión, no en esta.

## 6. Flujo OTP con proveedor real (diseño)

1. `POST /customers` valida el body y hace *upsert* del comprador (sin
   cambios respecto a hoy).
2. `createEmailVerification(customer.id)` genera y persiste el código
   hasheado (sin cambios).
3. La ruta llama `sendVerificationEmail({ to: decryptedCustomer.email,
   verificationCode: code, expiresAt, customerName })` en vez de
   `sendEmail({to, subject})`.
4. Si `delivered === true` → `200 { ok:true, customerId,
   emailVerificationRequired:true }` (sin `devOtpCode` fuera de dev/test,
   igual que hoy).
5. Si `delivered === false`:
   - En `development`/`test`: el comportamiento no cambia — se sigue
     devolviendo `devOtpCode` para no depender de un proveedor real en
     pruebas locales/CI.
   - En `staging`/`producción`: `503`, con un `code` derivado de
     `errorCode` (p. ej. `EMAIL_DELIVERY_UNAVAILABLE` para
     `PROVIDER_TIMEOUT`/`PROVIDER_TRANSPORT_ERROR`/`PROVIDER_UNKNOWN_ERROR`;
     un código específico `EMAIL_PROVIDER_MISCONFIGURED` para
     `PROVIDER_NOT_CONFIGURED`/`PROVIDER_AUTH_ERROR`, útil para monitoreo
     interno sin exponer detalle al comprador) — el mensaje público al
     comprador permanece genérico en ambos casos.
6. `POST /customers/:customerId/verify-email` no cambia — sigue comparando
   el hash del código enviado por el comprador contra `code_hash`, sin
   ninguna dependencia del proveedor de correo.

## 7. Manejo de errores (resumen operativo)

| Escenario | `errorCode` | Respuesta HTTP en staging/producción | Respuesta HTTP en dev/test |
|---|---|---|---|
| Proveedor no configurado (falta variable/secreto) | `PROVIDER_NOT_CONFIGURED` | 503, código interno distinto para alertar mala configuración | No aplica (usa stub) |
| Timeout del proveedor | `PROVIDER_TIMEOUT` | 503 `EMAIL_DELIVERY_UNAVAILABLE` | `devOtpCode` (stub no llama red) |
| Error de transporte (tras 1 reintento) | `PROVIDER_TRANSPORT_ERROR` | 503 `EMAIL_DELIVERY_UNAVAILABLE` | ídem |
| Credenciales rechazadas | `PROVIDER_AUTH_ERROR` | 503, alerta de configuración | ídem |
| Rate limit del proveedor | `PROVIDER_RATE_LIMITED` | 503 `EMAIL_DELIVERY_UNAVAILABLE` | ídem |
| Proveedor rechaza el envío (destinatario/dominio inválido) | `PROVIDER_REJECTED` | 503 `EMAIL_DELIVERY_UNAVAILABLE` | ídem |
| Cualquier otro no-2xx | `PROVIDER_UNKNOWN_ERROR` | 503 `EMAIL_DELIVERY_UNAVAILABLE` | ídem |

En ningún caso el mensaje público expone `errorCode`, el proveedor
configurado, ni ningún detalle de la respuesta upstream — esos detalles solo
existen en logs internos saneados (dominio del destinatario + `errorCode` +
`provider`, nunca más).

## 8. Observabilidad (diseño)

- Reutilizar el patrón ya usado en los relays de Cloudflare
  (`reportHealthRelayEvent` en `functions/api/health.js`): un punto único de
  emisión de eventos, con un *hook* de inyección para pruebas
  (`context.reporter`/equivalente) y `console.warn`/`console.error` como
  *fallback* real.
- Eventos mínimos a emitir: `email_send_attempted` (dominio, `provider`),
  `email_send_succeeded` (dominio, `provider`, `providerMessageId`),
  `email_send_failed` (dominio, `provider`, `errorCode` — nunca el mensaje
  crudo del proveedor).
- Métrica operativa recomendada para monitoreo de staging/producción: tasa de
  `PROVIDER_NOT_CONFIGURED`/`PROVIDER_AUTH_ERROR` (indica un problema de
  configuración, debería ser siempre 0 después del arranque) separada de la
  tasa de `PROVIDER_TIMEOUT`/`PROVIDER_RATE_LIMITED` (indica salud del
  proveedor externo, no del propio backend).
- Webhooks de rebote/queja (Resend/Postmark: HTTP directo; SES: vía SNS) son
  una fase **posterior** a esta — no se diseña su receptor aquí, solo se deja
  reservada `CATASTROX_EMAIL_WEBHOOK_SECRET` para cuando corresponda.

## 9. Rollout (diseño)

1. Confirmar la decisión de proveedor definitivo para staging (recomendado:
   Resend, §3) — **requiere confirmación explícita antes de escribir código**
   (ver decisión pendiente #1).
2. Verificar el dominio/subdominio de envío ante el proveedor elegido (DNS en
   Cloudflare) — sin tocar el dominio de producción.
3. Implementar `sendVerificationEmail()` con el contrato de §4, cubierta por
   pruebas que interceptan `fetch` (mismo patrón que
   `functions/api/__tests__/healthRelay.test.js`) — **fase separada de este
   lote**.
4. Agregar las variables de §5 a `server/config/env.js`
   (`REQUIRED_VARIABLES_BY_ENV.staging`, con formato/placeholder validado
   igual que `WOMPI_*`) y a `server/.env.example` — **fase separada**.
5. Desplegar a staging con el secreto real solo en el gestor de secretos de
   staging (nunca en Git) y probar el flujo completo de comprador con un
   correo de prueba propio, sin datos de un comprador real.
6. Solo después de una validación exitosa en staging, evaluar si el mismo
   proveedor (o uno distinto, ver §3) se usa en producción — decisión
   separada, no cubierta por este documento.

## 10. Rollback (diseño)

- Revertir `CATASTROX_EMAIL_PROVIDER` a `stub` (o eliminar la variable si el
  default queda en `stub`) es reversible de forma inmediata y sin
  desplegar código — vuelve exactamente al comportamiento actual (`503`
  fuera de dev/test, honesto, sin fingir envío).
- Si el proveedor elegido presenta una tasa sostenida de
  `PROVIDER_TIMEOUT`/`PROVIDER_UNKNOWN_ERROR` en staging, revertir a `stub`
  mientras se investiga, en vez de dejar el flujo de comprador fallando de
  forma intermitente y confusa.
- Ningún rollback de este componente requiere tocar la base de datos —
  `catastrox_customers`/`catastrox_email_verifications` no tienen ninguna
  columna nueva propuesta en este diseño.

## 11. Pruebas requeridas (para la fase de conexión, no escritas en este lote)

1. `sendVerificationEmail()` con proveedor `stub`: nunca llama `fetch`,
   siempre `delivered:false`, `provider:'stub'`, `errorCode:null`.
2. Éxito con proveedor real (fetch mockeado, 2xx + `id`): `delivered:true`,
   `providerMessageId` presente, `errorCode:null`.
3. Timeout: fetch que nunca resuelve dentro de `CATASTROX_EMAIL_TIMEOUT_MS`
   → `PROVIDER_TIMEOUT`, `delivered:false`.
4. Error de transporte con reintento exitoso: primera llamada rechaza
   (`TypeError`/"fetch failed"), segunda succeeds → `delivered:true` (mismo
   criterio que `isWompiTransportError`).
5. Error de transporte persistente (ambos intentos fallan) →
   `PROVIDER_TRANSPORT_ERROR`.
6. 401/403 del proveedor → `PROVIDER_AUTH_ERROR`, nunca reintenta.
7. 429 del proveedor → `PROVIDER_RATE_LIMITED`, nunca reintenta.
8. 4xx de validación (destinatario/dominio inválido) → `PROVIDER_REJECTED`.
9. Cualquier otro no-2xx → `PROVIDER_UNKNOWN_ERROR`, cuerpo de la respuesta
   del proveedor nunca aparece en el error devuelto ni en ningún log
   capturado por la prueba.
10. `CATASTROX_EMAIL_PROVIDER` ausente/inválida → `PROVIDER_NOT_CONFIGURED`,
    sin intentar red.
11. Ningún log generado durante ninguna de las pruebas anteriores contiene el
    correo completo del destinatario ni el `verificationCode`.
12. `POST /customers` (integración, mock de `sendVerificationEmail`):
    `delivered:true` → 200 sin `devOtpCode` fuera de dev/test;
    `delivered:false` → 503, mismo código público `EMAIL_DELIVERY_UNAVAILABLE`
    para todos los `errorCode` salvo el caso de mala configuración (ver §7).
13. `development`/`test` con `CATASTROX_EMAIL_PROVIDER=resend` configurado
    por error: confirmar que el gate de ambiente sigue controlando
    `devOtpCode` de forma independiente del proveedor configurado (no debe
    ser posible filtrar el OTP real solo por tener un proveedor real
    configurado en dev/test).
14. Idempotencia: dos llamadas a `sendVerificationEmail()` con el mismo
    `customerId`/código en una ventana corta no deben generar dos correos
    reales — prueba exacta depende de qué mecanismo de deduplicación se
    implemente (ver §4, "Idempotencia/deduplicación" — decisión abierta).

## Decisiones que requerían confirmación antes de escribir código (estado tras EMAIL_PROVIDER_002)

1. ~~Confirmar Resend como proveedor de staging~~ — **Confirmado** (Resend, integración implementada en §12).
2. ~~Mecanismo exacto de deduplicación de envío~~ — **Resuelto**: `Idempotency-Key` nativo de Resend, derivado del `id` de la fila de `catastrox_email_verifications` recién creada (`catastrox-otp-<id>`) — estable dentro de un mismo intento de verificación (incluyendo el único reintento interno), distinto en cada reenvío real. Ver §12.
3. **Dominio/subdominio de envío real para staging** (`mail.staging.agrogenomax.com`, confirmado como remitente previsto) — **pendiente**: quién lo registra/verifica en Cloudflare/Resend. No se tocó DNS en este lote (prohibido explícitamente).
4. **Si la decisión de proveedor de staging debe ser también la de producción** — **Confirmado que NO**: producción se evalúa por separado (instrucción explícita); `emailSender.js` no habilita Resend en `appEnv==='production'` bajo ninguna configuración (ver §12).
5. **Presupuesto/aprobación** para el plan pago de Resend si el volumen de staging supera el nivel gratuito — **pendiente**, sin cambios.
6. *(Nueva, surgida en la implementación)* **Quién crea la API key de Resend real** y en qué gestor de secretos de staging queda guardada — ninguna API key real se usó ni se generó en este lote.

## 12. EMAIL_PROVIDER_002 — Implementación real (Resend)

Rama: `feat/catastrox-staging-email-provider`. Decisiones confirmadas de
partida: proveedor Resend para staging; producción evaluada por separado;
subdominio previsto `mail.staging.agrogenomax.com`; remitente previsto
`CatastroX <no-reply@mail.staging.agrogenomax.com>`; integración por
HTTP/fetch; `Idempotency-Key` estable por intento; timeout explícito; máximo
un reintento. **No se usó ninguna API key real, no se envió ningún correo
real, no se configuró DNS, no se modificó producción.**

### 12.1 Contrato implementado

`server/services/catastrox/emailSender.js` expone:

```js
sendVerificationEmail({ to, verificationCode, expiresAt, customerName, idempotencyKey })
// -> { delivered: boolean, provider: 'resend' | 'stub', providerMessageId: string | null, errorCode: string | null }
```

El contenido del correo (asunto/HTML/texto) se arma internamente a partir de
`verificationCode`/`expiresAt`/`customerName` — el llamador nunca pasa texto
libre. `customerName` se escapa siempre antes de insertarse en el HTML
(`escapeHtml()`); el texto plano no requiere escapado. Sin enlaces de
autenticación ni ningún otro enlace. Sin PII adicional (predio, documento,
teléfono, dirección) en ningún campo del payload enviado a Resend.

### 12.2 Comportamiento por ambiente (implementado, verificado con pruebas)

| Ambiente | Llama a Resend | `provider` devuelto | Notas |
|---|---|---|---|
| `development` | **Nunca**, sin importar `EMAIL_PROVIDER` | `'stub'` | Gate incondicional por `APP_ENV`, defensa en profundidad |
| `test` | **Nunca**, sin importar `EMAIL_PROVIDER` | `'stub'` | Ídem |
| `staging` | Sí, si `EMAIL_PROVIDER=resend` (obligatorio) | `'resend'` | `devOtpCode` nunca aparece en la respuesta de `POST /customers`, delivered o no |
| `production` | **No, en este lote** | `'stub'` o `'resend'` según `EMAIL_PROVIDER`, siempre `errorCode:'EMAIL_PROVIDER_NOT_CONFIGURED'` | Exige una decisión/configuración separada, todavía no implementada — nunca se asume Resend como proveedor productivo |

### 12.3 Variables de entorno (implementadas)

Agregadas a `REQUIRED_VARIABLES_BY_ENV.staging` en `server/config/env.js` (NO
a `production`, por diseño — ver tabla arriba) y documentadas con
placeholders en `server/.env.example`:

| Variable | Validación en `env.js` |
|---|---|
| `EMAIL_PROVIDER` | Obligatoria en staging; debe ser `'stub'` o `'resend'` dondequiera que esté presente; en staging específicamente debe ser exactamente `'resend'` |
| `RESEND_API_KEY` | Obligatoria en staging; sin espacios iniciales/finales; rechaza placeholders (mismo patrón `TU_\|REEMPLAZAR\|PLACEHOLDER\|XXX\|DEMO` que `WOMPI_PUBLIC_KEY_TEST`) |
| `EMAIL_FROM` | Obligatoria en staging; formato `Nombre <correo@dominio>` o `correo@dominio` (`parseEmailFromHeader()`); en staging/producción el dominio debe ser público — rechaza `localhost`/`127.0.0.1`/loopback IPv6/`0.0.0.0`/TLD reservado (`.local`/`.internal`/`.test`/`.example`/`.invalid`/`.localdomain`)/hostname de una sola etiqueta |
| `EMAIL_SEND_TIMEOUT_MS` | Opcional; entero 1000-15000; default 5000 si ausente o fuera de rango |

`parseEmailFromHeader()`/`isEmailFromValidForEnvironment()` viven en
`emailSender.js` y se **reutilizan** desde `env.js` (import directo, sin
duplicar la regla) — mismo patrón que
`resolvePublicOriginForEnvironment()`/`shared/security/corsPolicy.js` para
`CATASTROX_FRONTEND_URL`/`API_BACKEND_URL`.

### 12.4 Payload real enviado a Resend

```
POST https://api.resend.com/emails
Authorization: Bearer <RESEND_API_KEY>
Content-Type: application/json
Idempotency-Key: catastrox-otp-<id de catastrox_email_verifications>

{ "from": "<EMAIL_FROM>", "to": ["<destinatario>"], "subject": "...", "html": "...", "text": "..." }
```

Solo estas 5 claves — verificado con una prueba dedicada
(`emailSender.test.js`, caso 22) que compara `Object.keys(body)` contra el
set exacto `['from','html','subject','text','to']`.

### 12.5 Política de timeout/reintento (implementada)

- `AbortController` con `EMAIL_SEND_TIMEOUT_MS` (default 5000ms) alrededor de
  cada llamada `fetch()`.
- **Máximo un reintento**, con una espera fija de 200ms entre intentos.
- Reintenta únicamente: timeout (`AbortError`), error de transporte
  (DNS/socket, antes de obtener cualquier respuesta HTTP), HTTP 429, HTTP
  500-599.
- **Nunca** reintenta: 400, 401, 403, 422, ni ningún otro no-2xx no cubierto
  arriba (se trata como rechazo definitivo).
- El `Idempotency-Key` es idéntico en el intento original y en el reintento
  (mismo valor, calculado una sola vez por invocación) — verificado
  explícitamente (`emailSender.test.js`, caso 17).

### 12.6 `errorCode` (implementados exactamente como se pidió)

`EMAIL_PROVIDER_NOT_CONFIGURED`, `EMAIL_PROVIDER_UNSUPPORTED`,
`EMAIL_API_KEY_MISSING`, `EMAIL_FROM_INVALID`, `EMAIL_TIMEOUT`,
`EMAIL_TRANSPORT_ERROR`, `EMAIL_RATE_LIMITED`, `EMAIL_PROVIDER_REJECTED`
(400/401/403/422 y cualquier otro no-2xx no cubierto), `EMAIL_PROVIDER_UNAVAILABLE`
(500-599), `EMAIL_RESPONSE_INVALID` (2xx sin `id` en el cuerpo, o cuerpo no
parseable como JSON). Ninguno de estos códigos, en ningún caso, incluye el
cuerpo crudo de la respuesta del proveedor.

### 12.7 Integración con `POST /customers`

- `createEmailVerification()` (`customerRepository.js`) ahora también
  devuelve `id` (vía `returning id`) — se usa para derivar el
  `Idempotency-Key`. Cambio aditivo, no rompe ningún llamador existente
  (todos destructuran solo los campos que necesitan).
- La ruta llama `sendVerificationEmail({ to, verificationCode: code,
  expiresAt, customerName: buildCustomerDisplayNameForEmail(decryptedCustomer),
  idempotencyKey: buildEmailIdempotencyKey(verificationId) })`.
- Si `delivered !== true` fuera de development/test → `503
  EMAIL_DELIVERY_UNAVAILABLE`, sin importar cuál `errorCode` específico haya
  causado el fallo — el mensaje público sigue siendo genérico.
- **No se borra ni revierte** el comprador ni la verificación si el envío
  falla — ambos ya quedaron persistidos de forma idempotente antes de
  intentar el envío, exactamente como exigía el pedido (permite reenvío sin
  duplicar el comprador).
- `devOtpCode` sigue condicionado únicamente a `isDevOrTest`, sin ninguna
  relación con `provider`/`delivered` — verificado con dos pruebas de
  integración nuevas: éxito de Resend sin `devOtpCode`, y fallo de Resend sin
  `devOtpCode` (ver §12.9).

### 12.8 Auditoría del "reenvío" (punto 9 del pedido)

No existe un endpoint dedicado de reenvío. El frontend
(`CatastroXPackagePage.jsx`, `handleResendOtp`) reenvía llamando de nuevo a
`POST /customers` con los mismos datos del comprador — `upsertCustomer()` es
idempotente (actualiza la misma fila por hash de documento) y
`createEmailVerification()` inserta una fila **nueva** en
`catastrox_email_verifications` en cada llamada. Esto ya cumple exactamente
lo pedido sin necesitar un endpoint nuevo: **mismo sender**
(`sendVerificationEmail`, sin cambios entre la emisión original y el
reenvío) y **una `idempotencyKey` nueva por cada reenvío real** (deriva del
`id` de la fila nueva), mientras permanece **estable durante el único
reintento interno de una misma llamada** a `sendVerificationEmail()`.

### 12.9 Archivos modificados/creados

- **Reescrito:** `server/services/catastrox/emailSender.js` — contrato
  `sendVerificationEmail()`, plantilla OTP, `parseEmailFromHeader()`/
  `isEmailFromValidForEnvironment()` (exportadas, reutilizadas por `env.js`).
- **Modificado:** `server/config/env.js` — `EMAIL_PROVIDER`/`RESEND_API_KEY`/
  `EMAIL_FROM` agregadas a `REQUIRED_VARIABLES_BY_ENV.staging`; validaciones
  de formato para las 4 variables nuevas.
- **Modificado:** `server/.env.example` — documentación de las 4 variables,
  sin secretos reales.
- **Modificado:** `server/services/catastrox/customerRepository.js` —
  `createEmailVerification()` también devuelve `id`.
- **Modificado:** `server/routes/catastroxPayments.js` — `POST /customers`
  usa el nuevo contrato; nuevos helpers `buildCustomerDisplayNameForEmail()`/
  `buildEmailIdempotencyKey()`.
- **Nuevo:** `server/services/catastrox/__tests__/emailSender.test.js` — 42
  pruebas unitarias con `fetch` mockeado.
- **Modificado:** `server/config/__tests__/env.test.js` — 18 pruebas nuevas
  para las validaciones de `EMAIL_PROVIDER`/`RESEND_API_KEY`/`EMAIL_FROM`/
  `EMAIL_SEND_TIMEOUT_MS`.
- **Modificado:** `server/routes/__tests__/catastroxCustomerOtpAndHistory.test.js`
  — 2 pruebas de integración nuevas (Postgres real, Resend mockeado):
  `POST /customers` en staging con Resend fallando (503, sin `devOtpCode`) y
  con Resend entregando (200, sin `devOtpCode`).
- **Modificado:** este documento (`docs/catastrox/EMAIL_PROVIDER_001.md`).

### 12.10 Pendientes operativos (sin cambios de código, fuera de este repo)

1. Registrar y verificar `mail.staging.agrogenomax.com` en Cloudflare DNS
   (SPF/DKIM/DMARC según lo que pida Resend) — no se tocó DNS en este lote.
2. Crear la cuenta/API key real de Resend y guardarla en el gestor de
   secretos de staging (nunca en Git) — no se creó ni se usó ninguna key
   real en este lote.
3. Decidir el proveedor de producción por separado (Resend no queda
   habilitado ahí de ninguna forma en este lote).
4. Presupuesto/aprobación si el volumen de staging supera el nivel gratuito
   de Resend.

## 13. Revisión y cierre del flujo de reenvío OTP

El informe de EMAIL_PROVIDER_002 (§12) afirmaba que el reenvío ya cumplía lo
pedido "sin necesitar un endpoint nuevo" (§12.8), pero no lo demostraba con
pruebas dedicadas ni auditaba la política transaccional del propio reenvío.
Esta revisión lo hizo, encontró **dos defectos reales** (uno ya insinuado en
§12.8, uno nuevo y más grave) y los corrigió.

### 13.1 Ruta real de reenvío

**No existe un endpoint dedicado.** Confirmado de nuevo, con más detalle:

- **Frontend**: `src/modules/catastrox/pages/CatastroXPackagePage.jsx`,
  función `handleResendOtp()` — vuelve a llamar `createCustomer(buyerInput)`
  (mismos datos del formulario ya capturados), que internamente hace
  `POST /customers` (`src/modules/catastrox/services/catastroxPaymentService.js`).
  `CatastroXOtpVerification.jsx` expone el botón "Reenviar código" con un
  *cooldown* de 30s puramente de UI (`RESEND_COOLDOWN_SECONDS`), sin
  contraparte en el backend.
- **Backend**: `router.post('/customers', customerLimiter, ...)` en
  `server/routes/catastroxPayments.js` — el mismo handler que el registro
  inicial. No hay bifurcación de código entre "primera vez" y "reenvío": el
  handler no sabe cuál de los dos casos está atendiendo.
- **Repositorio**: `server/services/catastrox/customerRepository.js` —
  `upsertCustomer()` (por `document_number_hash`, `ON CONFLICT DO UPDATE`) +
  `generatePendingEmailVerification()`/`persistEmailVerification()` (ver
  §13.3 — reemplazan a `createEmailVerification()` en este flujo).
- **Política de expiración/consumo anterior a esta revisión**:
  `catastrox_email_verifications` sin `TTL` de base de datos activo —
  `verifyEmailCode()` filtra por `expires_at > now()` (10 minutos,
  `EMAIL_VERIFICATION_TTL_MS`) y siempre against la fila **más reciente**
  no consumida (`order by created_at desc limit 1`). Esta política de
  "la más reciente gana" es la raíz de ambos defectos de abajo.

### 13.2 Defecto #1 (el que motivó la revisión): la fila de verificación se creaba antes de confirmar la entrega

Con la implementación original de EMAIL_PROVIDER_002,
`createEmailVerification()` insertaba la fila **antes** de llamar a
`sendVerificationEmail()`. Como `verifyEmailCode()` siempre valida contra la
fila más reciente, un reenvío cuyo envío a Resend **fallara** dejaba, de
todos modos, una fila "activa" en la base con un código que el comprador
**nunca recibió** — ensombreciendo (*shadowing*) cualquier código anterior
que sí le hubiera llegado. Resultado: un fallo transitorio de Resend podía
dejar al comprador sin ningún código utilizable, aunque tuviera en su bandeja
de entrada uno perfectamente válido de un intento anterior.

### 13.3 Corrección del defecto #1: política transaccional (Opción recomendada, implementada)

`server/services/catastrox/customerRepository.js` ahora separa generación de
persistencia:

- `generatePendingEmailVerification()` — genera `{id, code, codeHash,
  expiresAt}` **en memoria, sin tocar la base de datos**. `id` es un
  `crypto.randomUUID()` de aplicación (no el `default` de la columna) —
  es la misma clave que `server/routes/catastroxPayments.js` usa para
  derivar el `Idempotency-Key`, exista o no exista finalmente la fila.
- `persistEmailVerification({id, customerId, codeHash, expiresAt})` —
  inserta la fila, con el `id` ya generado, explícito.
- La ruta llama `sendVerificationEmail()` **antes** de decidir si persiste:
  - Si `delivered === true` → persiste (queda activa; el comprador la usa
    para verificar).
  - Si `delivered === false` **y** el ambiente es `development`/`test` →
    persiste igual (no hay entrega real que confirmar ahí; `devOtpCode`
    sigue siendo el mecanismo de prueba ya autorizado, y sin persistir la
    fila `verify-email` no tendría contra qué validar).
  - Si `delivered === false` **y** el ambiente es `staging`/`production` →
    **no persiste nada**. No queda ninguna fila nueva, utilizable o no. El
    comprador conserva cualquier código anterior todavía vigente, y puede
    reintentar el reenvío de inmediato.
- `createEmailVerification()` (la función original, inserción inmediata) se
  **conserva sin cambios** para el único otro llamador que existía
  (`customerEmailChangeAndJobConcurrency.test.js`, pruebas de invalidación
  por cambio de correo) — no se tocó su comportamiento porque ese caso no
  pasa por `sendVerificationEmail()`.

Este es exactamente el diseño "Opción recomendada" del pedido: crear en
estado pendiente, intentar el envío, persistir solo si se confirma, nunca
dejar utilizable un código no enviado, nunca bloquear permanentemente al
comprador.

### 13.4 Defecto #2 (hallado durante la auditoría, más grave): `upsertCustomer()` invalidaba el código anterior en CADA reenvío, sin importar si el correo cambió

Independiente del defecto #1, `upsertCustomer()` ya tenía una invalidación
explícita de códigos activos "cuando el correo cambia" (revisión de
seguridad de un lote anterior). La condición real en código era:

```js
if (customer.email_verified_at === null) { /* invalida todos los OTP activos */ }
```

`email_verified_at` es `null` tanto si el correo **acaba de cambiar** (el
caso que la invalidación pretende cubrir) **como si el comprador
simplemente todavía no se ha verificado** — que es el estado normal durante
*cualquier número de reenvíos* del **mismo** correo, antes de la primera
verificación exitosa. En la práctica: **todo reenvío, exitoso o no,
invalidaba el código anterior como efecto colateral de `upsertCustomer()`**,
independientemente de la corrección del defecto #1 — el código anterior
quedaba marcado `consumed_at = now()` antes incluso de intentar el envío
nuevo. Detectado con una prueba de extremo a extremo (§13.6) que reprodujo
exactamente el escenario: registro exitoso → reenvío que falla en Resend →
el código original, ya entregado, dejaba de verificar (`CODE_EXPIRED`).

**Corrección**: se lee el `email_hash` ya guardado para el documento **antes**
del `UPSERT` (misma transacción), y la invalidación ahora depende de
`emailChangedInThisWrite` (`previousEmailHash !== null && previousEmailHash
!== emailHash`) — verdadero únicamente cuando el correo realmente cambió en
esta escritura, nunca solo porque el comprador no se ha verificado todavía.
Verificado explícitamente que la invalidación por cambio real de correo
sigue funcionando (`customerEmailChangeAndJobConcurrency.test.js`, casos
2/3, sin cambios y en verde).

**Nota sobre concurrencia**: la versión anterior de este código usaba una
expresión `CASE` atómica dentro del propio `UPSERT` (sin *race condition*
posible) precisamente para evitar depender de una lectura previa. La
corrección introduce una lectura (`select email_hash ... where
document_number_hash = $1`) antes del `UPSERT`, dentro de la misma
transacción — existe una ventana teórica y estrecha en la que dos escrituras
*verdaderamente* concurrentes del mismo documento, con correos distintos,
podrían leer el mismo valor "anterior". No es una vía de *bypass* de
seguridad (verificar sigue exigiendo el código correcto, hasheado); en el
peor caso, un código viejo quedaría activo un instante de más, en un
escenario ya de por sí extremadamente inusual (dos envíos simultáneos del
mismo formulario con correos distintos). Aceptado como *trade-off*
documentado, no como una regresión silenciosa.

### 13.5 Confirmación de la lista de requisitos del pedido (punto 2)

| Requisito | Estado |
|---|---|
| Usa `sendVerificationEmail()` | ✔ (siempre fue así desde §12; sin cambios en este punto) |
| No usa directamente el stub anterior | ✔ (el stub original ya no existe — reescrito en §12) |
| Crea una nueva verificación OTP | ✔ — ahora vía `generatePendingEmailVerification()`, persistida solo si corresponde (§13.3) |
| Nueva `idempotencyKey` basada en el nuevo `verificationId` | ✔ (`pending.id`, generado antes de persistir) |
| Misma `idempotencyKey` en el intento inicial y el único *retry* de Resend | ✔ — verificado con prueba dedicada (§13.6) |
| Nunca devuelve `devOtpCode` en staging/producción | ✔ — verificado con prueba dedicada, éxito y fallo (§13.6) |
| development/test conserva el mecanismo *dev* seguro | ✔ — verificado con prueba dedicada (§13.6) |
| Responde 503 `EMAIL_DELIVERY_UNAVAILABLE` cuando `delivered:false` | ✔ (sin cambios respecto a §12) |
| No afirma "código enviado" si Resend no entregó | ✔ (la respuesta de éxito nunca incluye ese texto; sin cambios) |
| Respeta *rate limit*/*cooldown* existentes | ✔ estructural (mismo `customerLimiter`, mismo *endpoint*, sin *bypass* posible) — verificado con prueba dedicada que compara `RateLimit-Remaining` entre el envío inicial y el reenvío (§13.6) |

### 13.6 Pruebas agregadas (todas en `server/routes/__tests__/catastroxCustomerOtpAndHistory.test.js`, integración con Postgres real + Resend mockeado)

1. Reenvío en `development` — ni el registro inicial ni el reenvío llaman a
   Resend; ambos devuelven `devOtpCode` (códigos distintos entre sí).
2. Reenvío en `staging` exitoso — llama a Resend exactamente una vez más,
   crea una fila de verificación nueva, y usa una `Idempotency-Key` distinta
   de la del envío inicial.
3. El único *retry* interno de un reenvío (500 → éxito) conserva la **misma**
   `Idempotency-Key` entre ambos intentos HTTP.
4. Fallo de Resend en el reenvío: responde 503
   `EMAIL_DELIVERY_UNAVAILABLE`, **no** crea una fila nueva
   (`count(*)` sin cambios), y el código anterior —ya entregado— **sigue
   siendo válido** (`verify-email` con ese código responde 200). También
   confirma que ni el correo completo, ni el OTP, ni la API key aparecen en
   ningún log capturado durante el intento fallido.
5. Tras un fallo, un reenvío posterior puede tener éxito (no hay bloqueo
   permanente) y sí crea la fila nueva esperada.
6. El reenvío consume el mismo contador de *rate limit* (`RateLimit-Remaining`)
   que el registro inicial — mismo `customerLimiter`, mismo *endpoint*, sin
   vía paralela sin límite.

Total: **6 pruebas nuevas** (14 en el archivo, antes 8). Todas verdes, junto
con las 2 pruebas preexistentes de éxito/fallo de Resend en staging (§12) y
las 12 de `customerEmailChangeAndJobConcurrency.test.js` (sin cambios,
confirmando que la invalidación por cambio real de correo sigue intacta).

### 13.7 Archivos modificados en esta revisión

- **Modificado:** `server/services/catastrox/customerRepository.js` —
  `generatePendingEmailVerification()`/`persistEmailVerification()` nuevas;
  `upsertCustomer()` corregido (`emailChangedInThisWrite` reemplaza a
  `customer.email_verified_at === null` como condición de invalidación).
- **Modificado:** `server/routes/catastroxPayments.js` — `POST /customers`
  usa el flujo generar→enviar→persistir-condicional en vez de
  crear→enviar.
- **Modificado:** `server/routes/__tests__/catastroxCustomerOtpAndHistory.test.js`
  — 6 pruebas nuevas (§13.6).
- **Modificado:** este documento.

## 14. Cierre de protección backend: cooldown de emisión de OTP

Hallazgo confirmado que motivó este cierre: el frontend
(`CatastroXOtpVerification.jsx`, `RESEND_COOLDOWN_SECONDS = 30`) aplica un
cooldown de 30s entre reenvíos, pero **`POST /customers` no tenía ninguna
protección de backend equivalente** — un cliente que llamara al endpoint
directamente (sin pasar por esa UI) podía disparar tantos envíos reales a
Resend como el rate limit general por IP lo permitiera, sin ningún límite
por comprador/correo.

### 14.1 Auditoría del rate limiting actual de `POST /customers`

| Aspecto | Estado |
|---|---|
| Middleware | `customerLimiter` (`server/middleware/rateLimit.js`, `express-rate-limit`) |
| Llave | `req.ip` (vía `ipKeyGenerator`, normaliza IPv6 a bloque /64) — **nunca** `customerId`, documento ni correo |
| Ventana | 5 minutos |
| Límite | 15 solicitudes por ventana |
| Distingue por comprador | **No** — puramente por IP; 15 compradores distintos desde la misma IP consumen el mismo contador que 15 intentos para el mismo comprador |
| Comportamiento multi-instancia | Store en memoria del proceso (`express-rate-limit` por defecto) — **riesgo residual ya documentado** en el propio archivo: cada instancia lleva su propio contador, el límite efectivo se multiplica por el número de instancias corriendo en paralelo. No migrado a un store compartido (Redis) en este lote — fuera de alcance. |

Confirmado: `customerLimiter` es una defensa de **abuso distribuido por
IP**, no de **spam dirigido a un comprador específico** — ambas protecciones
son necesarias y complementarias, no sustitutas una de la otra (§14.4).

### 14.2 Diseño del cooldown backend

**Fuente de verdad: PostgreSQL, nunca memoria del proceso** — staging puede
reiniciar o correr múltiples instancias; un contador en memoria no
sobreviviría ni se compartiría entre ellas (mismo motivo por el que
`customerLimiter` ya tiene ese riesgo residual documentado — el cooldown no
debía repetir el mismo error).

Tabla nueva (migración `006_catastrox_email_verification_cooldown.sql`):

```sql
create table public.catastrox_customer_otp_state (
  customer_id uuid primary key references public.catastrox_customers(id),
  last_delivered_at timestamptz,
  reserved_at timestamptz
);
```

Deliberadamente **separada** de `catastrox_email_verifications`: esa tabla
solo debe contener códigos REALMENTE entregados (política de §13) —
mezclar ahí un estado de "reserva breve" habría reabierto el mismo riesgo
que esa revisión cerró. `catastrox_customer_otp_state` nunca contiene un
código ni nada verificable, solo dos marcas de tiempo por comprador.

- **`last_delivered_at`**: se actualiza únicamente cuando un envío se
  confirma entregado (o `development`/`test`, que ya trata la ausencia de
  entrega real como "última emisión" a efectos del `devOtpCode`, igual que
  decide la persistencia en §13). **Nunca** se actualiza tras un fallo — un
  intento fallido no reinicia el cooldown de 30s.
- **`reserved_at`**: se marca justo antes de intentar el envío real y se
  libera (`NULL`) apenas se conoce el resultado, sin importar cuál — nunca
  queda "colgada" más allá de ese intento concreto (y aunque algo lo
  impidiera, expira sola por TTL, ver 14.3).

Funciones nuevas en `server/services/catastrox/customerRepository.js`:

- **`reserveEmailVerificationSend(customerId)`** — dentro de una
  transacción corta: `INSERT ... ON CONFLICT DO NOTHING` (garantiza que la
  fila exista) → `SELECT ... FOR UPDATE` (calcula `in_cooldown`/
  `reservation_active` y sus segundos restantes, con el reloj de Postgres,
  no el del proceso) → si cualquiera de las dos condiciones es verdadera,
  la transacción termina sin escribir nada y devuelve `{allowed:false,
  retryAfterSeconds}`; si no, marca `reserved_at = now()` y hace `COMMIT`.
- **`releaseEmailVerificationSend(customerId, {delivered})`** — se llama
  siempre, dentro de un `finally` que envuelve la llamada a
  `sendVerificationEmail()` en la ruta (§14.3): si `delivered` es verdadero,
  marca `last_delivered_at = now()` y libera `reserved_at`; si no, **solo**
  libera `reserved_at` — el cooldown de 30s nunca se activa por un intento
  que no entregó nada.

`POST /customers` llama `reserveEmailVerificationSend()` **antes** de
generar el código o llamar a Resend. Si no está permitido, responde de
inmediato:

```json
{ "ok": false, "code": "EMAIL_VERIFICATION_COOLDOWN", "retryAfterSeconds": 17,
  "message": "Ya se envió un código recientemente. Espera unos segundos antes de solicitar uno nuevo." }
```

Nunca genera código, nunca llama a Resend, nunca persiste nada, nunca
incluye correo/documento/OTP/hashes — solo el código de error y el número
de segundos a esperar.

### 14.3 Estrategia de concurrencia (dos requests simultáneas)

**Nunca se mantiene un lock de base de datos mientras se llama a Resend.**
`reserveEmailVerificationSend()` es una transacción corta y propia
(`withCustomerTransaction`, `BEGIN`/`SELECT...FOR UPDATE`/`COMMIT`) que
termina — liberando el lock de fila — **antes** de que la ruta llame a
`sendVerificationEmail()`. La llamada HTTP externa ocurre completamente
fuera de cualquier transacción.

El mecanismo de exclusión es el propio `SELECT ... FOR UPDATE` de Postgres
sobre la fila de `catastrox_customer_otp_state` del comprador: dos
solicitudes concurrentes para el **mismo** `customer_id` se serializan de
forma nativa — la segunda transacción simplemente espera a que la primera
haga `COMMIT`/`ROLLBACK` antes de poder leer la fila, sin necesidad de
`pg_advisory_lock` ni de coordinación a nivel de aplicación. Verificado con
una prueba dedicada que dispara dos `POST /customers` idénticas con
`Promise.all()`: exactamente una recibe `200` (y Resend se llama
exactamente una vez), la otra recibe `429 EMAIL_VERIFICATION_COOLDOWN` (ver
§14.6, prueba 10).

**Estado de reserva breve** (`reserved_at`) — la respuesta al requisito de
"no realizar una llamada HTTP a Resend mientras se mantiene un lock de base
de datos durante un tiempo indefinido": el lock de fila dura milisegundos
(el tiempo de un `SELECT`/`UPDATE`); lo que efectivamente bloquea a una
segunda solicitud durante todo el envío es la marca `reserved_at`, leída
(no bajo lock prolongado) por la solicitud siguiente. Su ventana de validez
se calcula dinámicamente:

```
worstCaseMs = EMAIL_SEND_TIMEOUT_MS * 2 + 1000   // intento inicial + único reintento + margen
ttlSeconds  = min(29, max(10, ceil(worstCaseMs / 1000)))
```

Con el timeout por defecto (5000ms) da **11s** — cómodo margen sobre el
peor caso real (~10.2s), y muy por debajo del cooldown de 30s (satisface
"no debe bloquear al usuario durante 30s completos"). **Riesgo residual
documentado**: en la configuración más extrema permitida
(`EMAIL_SEND_TIMEOUT_MS=15000`), el peor caso real (~30.2s) puede superar
levemente el techo de 29s aplicado aquí — en ese único escenario extremo,
una segunda solicitud podría no ser bloqueada en el último instante. Nunca
es un problema de seguridad (verificar sigue exigiendo el código correcto);
en el peor caso, se enviaría un correo adicional en una configuración de
timeout muy alejada del valor por defecto recomendado.

### 14.4 Cooldown por comprador vs. rate limit general por IP

Dos protecciones distintas, complementarias, **ninguna sustituye a la
otra**:

| | `customerLimiter` (existente, sin cambios) | Cooldown backend (nuevo) |
|---|---|---|
| Fuente de verdad | Memoria del proceso (`express-rate-limit`) | PostgreSQL (`catastrox_customer_otp_state`) |
| Llave | IP del cliente | `customer_id` (mismo comprador, identificado por documento) |
| Ventana/límite | 15 solicitudes / 5 min | 1 emisión real entregada / 30s |
| Protege contra | Abuso distribuido — muchas IPs o muchos correos distintos desde una misma IP | Spam dirigido a un comprador específico — incluso desde IPs distintas, o sin pasar por el rate limit general todavía |
| Multi-instancia | Riesgo residual conocido (contador no compartido) | Correcto — Postgres es la única fuente de verdad, compartida entre instancias |

Verificado con una prueba dedicada que agota el límite de 15 solicitudes de
`customerLimiter` con 15 compradores **distintos** (para que el cooldown
por comprador nunca intervenga) y confirma que la 16ª solicitud se bloquea
con el código del rate limit general (`RATE_LIMITED_CUSTOMER`), no con
`EMAIL_VERIFICATION_COOLDOWN` (§14.6, prueba 12) — ninguno de los dos
mecanismos reemplaza al otro.

### 14.5 Comportamiento tras un fallo del proveedor

1. Primer intento (o cualquier intento posterior a 30+s del último
   realmente entregado) falla en Resend → `reserveEmailVerificationSend()`
   ya había marcado `reserved_at`; al fallar, `releaseEmailVerificationSend()`
   libera esa marca **sin** tocar `last_delivered_at` → no queda ningún
   cooldown activo por ese intento fallido → un reintento **inmediato**
   (sin esperar nada) puede tener éxito.
2. Si el intento fallido ocurre **dentro** de un cooldown ya activo (por un
   envío anterior sí entregado, hace menos de 30s), esa situación ni
   siquiera llega a intentarse: el cooldown por sí solo ya habría devuelto
   `429` antes de tocar Resend.
3. En ningún caso un fallo deja una fila de `catastrox_email_verifications`
   utilizable (política ya establecida en §13, sin cambios) — el cooldown
   es una capa adicional, antes de siquiera generar el código.

### 14.6 Pruebas agregadas (todas en `catastroxCustomerOtpAndHistory.test.js`, integración con Postgres real + Resend mockeado)

1. Segundo request antes de 30s → `429`.
2. `code: EMAIL_VERIFICATION_COOLDOWN` presente.
3. `retryAfterSeconds` entero, acotado entre 1 y 30.
4. No llama a Resend durante el cooldown.
5. No crea una fila nueva durante el cooldown.
6. El código anterior (ya entregado) sigue siendo válido tras el 429.
7. Pasados los 30s (simulados vía manipulación directa de
   `last_delivered_at` en la prueba), permite una nueva emisión real.
8. Un fallo en el primer intento no deja ningún OTP persistido.
9. Ese mismo fallo permite un reintento inmediato y seguro (sin cooldown
   activo, sin esperar).
10. Dos solicitudes concurrentes (`Promise.all`) para el mismo comprador:
    exactamente una llamada real a Resend, la otra recibe `429`.
11. `development`/`test` también respetan el cooldown backend (no depende
    de si se llegaría a llamar a un proveedor real).
12. El rate limit general por IP (`customerLimiter`) sigue activo,
    independiente del cooldown por comprador, con su propio código.
13. Ninguna prueba de esta sección expone correo completo, documento, OTP,
    ni la API key en logs ni en la respuesta HTTP (verificado explícitamente
    en la prueba 1, que también cubre el caso de fallo del apartado
    anterior en §13.6).

Total: **7 pruebas nuevas** de cooldown/concurrencia (20 en el archivo,
antes 14) — todas verdes, junto con el resto de `npm run test:node`
(937/937, ver informe de entrega de este cierre) sin regresiones.

### 14.7 Esquema/migración

`supabase/migrations/006_catastrox_email_verification_cooldown.sql` —
aditiva, una tabla nueva (`catastrox_customer_otp_state`), sin tocar ninguna
tabla existente. **Aplicada manualmente a la base de datos de desarrollo
local** (mismo patrón que las migraciones 002-005, sin *runner* automático)
para poder ejecutar las pruebas de integración de este lote — **no
ejecutada contra staging ni producción**.

### 14.8 Archivos modificados en este cierre

- **Nuevo:** `supabase/migrations/006_catastrox_email_verification_cooldown.sql`.
- **Modificado:** `server/services/catastrox/customerRepository.js` —
  `reserveEmailVerificationSend()`/`releaseEmailVerificationSend()` nuevas.
- **Modificado:** `server/routes/catastroxPayments.js` — `POST /customers`
  reserva antes de generar/enviar, libera en un `finally`.
- **Modificado:** `server/routes/__tests__/catastroxCustomerOtpAndHistory.test.js`
  — 7 pruebas nuevas (§14.6) + `bypassOtpCooldown()` para las pruebas de
  reenvío existentes que no prueban el cooldown en sí.
- **Modificado:** `server/routes/__tests__/catastroxPaymentOrders.test.js`,
  `server/routes/__tests__/catastroxPaymentWebhook.test.js`,
  `server/services/catastrox/__tests__/customerEmailChangeAndJobConcurrency.test.js`,
  `scripts/catastrox/__tests__/backfillRehashIdempotency.test.js` — limpieza
  de pruebas actualizada para borrar `catastrox_customer_otp_state` antes de
  borrar el comprador (nueva restricción de llave foránea).
- **Modificado:** este documento.
