# STAGING_READINESS_001 — Auditoría y preparación de configuración de staging (CatastroX)

Rama: `chore/catastrox-staging-readiness` (base `174881a`, merge de PR #10).
Alcance de este documento: **auditar y preparar** la configuración de staging.
No se desplegó nada, no se ejecutó ninguna migración contra ninguna base de
datos real, y no se tocó producción. No se documentan aquí secretos reales
— todos los valores de ejemplo son sintéticos o placeholders explícitos
(`REEMPLAZAR`).

## 1. Resumen de hallazgos

| # | Hallazgo | Severidad | Estado tras este lote |
|---|---|---|---|
| 1 | `server/config/env.js` no exigía `WOMPI_PUBLIC_KEY_TEST`/`WOMPI_INTEGRITY_SECRET_TEST`/`WOMPI_EVENTS_SECRET_TEST`/`CATASTROX_FRONTEND_URL` en staging (solo se validaba su formato si estaban presentes) | Alta | Corregido — ahora son obligatorias en `staging` (ver §4) |
| 2 | `WOMPI_PUBLIC_KEY_TEST` solo se validaba (`pub_test_...`, sin placeholders) en tiempo de request dentro de `POST /checkout` | Media | Corregido — ahora también falla-rápido al arrancar (`getConfig()`) |
| 3 | `API_BACKEND_URL` (relays de Cloudflare) y `CATASTROX_FRONTEND_URL` (backend Express) no rechazaban explícitamente `http://` ni `localhost`/`127.0.0.1` en staging/production | Alta | Corregido — nuevo `resolvePublicOriginForEnvironment()` compartido (ver §4) |
| 4 | `server/services/catastrox/emailSender.js` es un stub sin proveedor real conectado (`delivered:false, mode:'stub'` siempre) | **Crítica — bloquea staging** | No corregido en este lote (fuera de alcance: requiere contratar/conectar un proveedor real). Documentado en §8/§9 |
| 5 | Cookie de recuperación (`server/security/recoveryCookie.js`), CORS (`shared/security/corsPolicy.js`), separación de endpoints de readiness (`server/health/readiness.js`) | — | Ya correctos, sin cambios de código — solo se documentan aquí |
| 6 | Migraciones 002, 003, 004 y 005 (4 migraciones) | — | Presentes, commiteadas, sin cambios — ver §5 para la precisión sobre qué eliminan/no eliminan |
| 7 *(revisión final)* | `resolvePublicOriginForEnvironment()` no rechazaba loopback IPv6 (`::1`, `[::]`), `0.0.0.0` ni hosts con wildcard (`https://*.agrogenomax.com` — el parser WHATWG URL no trata `*` como carácter prohibido de host) | Alta | Corregido — hostname comparado exacto contra una lista de loopback/local, y `normalizeOrigin()` rechaza cualquier hostname con `*` (cierra el hueco también para la allowlist de CORS) |
| 8 *(revisión final)* | El placeholder documentado en `.env.example`/`server/.env.example` para `CATASTROX_PII_HASH_SECRET` (49 caracteres) pasaba el check de longitud mínima (≥32) sin ser detectado como placeholder | **Crítica** | Corregido — se agregó rechazo de patrón placeholder (`WOMPI_PLACEHOLDER_PATTERN`), igual que ya existía para `WOMPI_PUBLIC_KEY_TEST` |
| 9 *(revisión final)* | `WOMPI_INTEGRITY_SECRET_TEST` no tenía ninguna validación de formato (ni espacios, ni placeholder) — a diferencia de todos los demás secretos de este módulo | Alta | Corregido — se agregó rechazo de espacios y de patrón placeholder (sin longitud mínima, por no existir una garantía documentada del formato real emitido por Wompi) |
| 10 *(revisión final)* | `functions/api/health.js` (relay de liveness, **tercer relay**, distinto de los dos de CatastroX) usaba `normalizeOrigin()` puro (no `resolvePublicOriginForEnvironment()`) para `API_BACKEND_URL`/`API_BACKEND_ALLOWED_ORIGIN`: no exigía `https`, y su propio filtro `isLocalBackendOrigin()` solo reconocía `http://localhost`/`127.0.0.1` — nada impedía configurar ambas variables con el mismo valor inseguro (p. ej. `http://` o `https://localhost`) y que el relay lo aceptara igual | Media (mitigada por el *pinning* positivo, pero real) | **Corregido en el cierre final (§13)** — Opción A: `resolvePublicOriginForEnvironment()` aplicada a ambas variables, manteniendo intacto el mecanismo de *pinning* positivo y el filtro `isBackendOriginAllowedForEnv()` existentes como capas adicionales |
| 11 *(cierre final)* | Este documento afirmaba "5 archivos" de migración y "todas son aditivas" sin precisar que la migración 004 retira un índice único global (cambio de comportamiento, no solo aditivo) | Media (documental) | Corregido — ver §5 |

*Hallazgos 7-10 se agregaron en la revisión final solicitada después de la entrega inicial de STAGING_READINESS_001 (ver §12); hallazgo 10 se corrigió y el 11 se agregó en el cierre final solicitado después de esa revisión (ver §13).*

## 2. Inventario completo de variables

### 2.1 Backend Express (`server/.env.example`, consumidas por `server/config/env.js`)

| Variable | Requerida en staging | Origen/consumidor | Uso |
|---|---|---|---|
| `APP_ENV` | Sí (siempre, todos los ambientes) | `server/config/env.js` (`loadEnv`) | Única fuente de verdad del ambiente funcional; sin ella el backend no arranca |
| `PORT` | No (default implícito del framework) | `server/index.js` | Puerto HTTP del proceso Express |
| `DATABASE_URL` | **Sí** | `server/db.js` | Pool de Postgres principal (`agx`) |
| `PGSCHEMA` | No | `server/db.js` | Esquema por defecto del pool principal |
| `CATASTROX_DATABASE_URL` | **Sí** | `server/catastroxDb.js` | Pool de Postgres PostGIS (`catastrox`) |
| `CATASTROX_PGSCHEMA` | No | `server/catastroxDb.js` | Esquema por defecto del pool CatastroX |
| `CORS_ALLOWED_ORIGINS` | No (opcional, CSV) | `shared/security/corsPolicy.js` vía `resolveCorsAllowedOrigins()` | Amplía —nunca sustituye— la allowlist obligatoria (`https://staging.agrogenomax.com` en staging) |
| `HEALTH_MONITOR_TOKEN` | **Sí** (mín. 32 caracteres, sin espacios) | `server/health/monitorAuth.js` | Autentica `GET /api/health/ready*` y `/api/health/db` |
| `WOMPI_ENV` | No (default de facto `test`) | `server/routes/catastroxPayments.js`, `env.js` | Debe ser `test` en staging — `production` está prohibido por `validateEnv()` |
| `WOMPI_PUBLIC_KEY_TEST` | **Sí (nuevo en este lote)** — debe iniciar con `pub_test_`, sin placeholders | `server/routes/catastroxPayments.js` (widget Wompi), `env.js` (boot-time) | Llave pública Sandbox enviada al frontend para abrir el widget de Wompi |
| `WOMPI_INTEGRITY_SECRET_TEST` | **Sí (nuevo en este lote)** — sin espacios iniciales/finales, sin placeholders (revisión final) | `server/routes/catastroxPayments.js` | Firma de integridad de la transacción Sandbox |
| `WOMPI_EVENTS_SECRET_TEST` | **Sí (nuevo en este lote)** — mín. 32 caracteres, sin placeholders (revisión final) | `server/routes/catastroxPayments.js` (webhook) | Autentica `POST /api/catastrox/payments/wompi/events` |
| `WOMPI_API_BASE_URL` | No (default `https://sandbox.wompi.co/v1`) | `server/routes/catastroxPayments.js` | Base URL de la API de Wompi Sandbox |
| `CATASTROX_FRONTEND_URL` | **Sí (nuevo en este lote)** — debe ser `https://`, nunca localhost/127.0.0.1/loopback IPv6/`0.0.0.0`/wildcard | `server/routes/catastroxPayments.js`, `env.js` (boot-time) | URL pública del frontend usada para construir el enlace de retorno de Wompi |
| `TRUST_PROXY_HOPS` | No (default `0`, entero 0-5) | `server/middleware/rateLimit.js` | Saltos de proxy confiables para resolver la IP real (Cloudflare/ALB) |
| `CATASTROX_PII_ENCRYPTION_KEY` | **Sí** — 32 bytes exactos en base64 | `server/services/catastrox/piiCrypto.js` | Clave AES-256-GCM para cifrar PII en reposo |
| `CATASTROX_PII_HASH_SECRET` | **Sí** — mín. 32 caracteres, sin placeholders (revisión final — el placeholder de `.env.example` tiene 49 caracteres y antes pasaba solo el check de longitud) | `server/services/catastrox/piiCrypto.js` | Secreto HMAC-SHA256 (con separación de dominio) para `document_number_hash`/`email_hash` |
| `CATASTROX_DATASET_VERSION` | No (default `2026-01`) | `server/routes/catastrox.js` | Etiqueta del dataset catastral servido |
| `CATASTROX_BACKFILL_TRANSACTION_ID` | No (solo para ejecución manual local del script de backfill) | `scripts/catastrox/backfill-known-approved-order.mjs` | Nunca se usa en el backend real ni en CI |
| `SHUTDOWN_TIMEOUT_MS` | No (default `15000`) | `server/lifecycle/gracefulShutdown.js` | Límite del apagado ordenado ante SIGTERM/SIGINT |

### 2.2 Frontend / build (`.env.example`, variables `VITE_*` resueltas en tiempo de build por Vite)

| Variable | Requerida en staging | Consumidor | Uso |
|---|---|---|---|
| `VITE_APP_ENV` | Sí | `src/config/runtimeConfig.js` | Ambiente funcional del frontend; gatea el panel "modo desarrollo" del OTP (junto con `!import.meta.env.PROD`) |
| `VITE_AGX_API_URL` | Sí | `src/config/runtimeConfig.js` | URL base de la API consumida por el frontend (debe apuntar al relay `/api` del dominio de staging, no a un backend directo) |
| `VITE_AGX_PUBLIC_APP_URL` | Sí | Enlaces compartibles/QR | URL pública canónica de la app |
| `VITE_MAPBOX_TOKEN` | Sí (si el mapa se usa en staging) | `src/components/GisMap.jsx` | Token público de Mapbox |
| `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` | Depende de si Ganadería/Supabase está activo en staging (fuera del alcance de CatastroX; **decisión pendiente**, ver §7) | Módulo Ganadería | Cliente Supabase del frontend |
| `VITE_CATASTROX_AUDIT_DOWNLOADS` | No | Frontend CatastroX | Espejo de `CATASTROX_AUDIT_DOWNLOADS` para el build |

### 2.3 Relay Cloudflare Pages Functions (configuradas en el panel de Cloudflare, **no** en archivos `.env`)

| Variable | Requerida en staging | Consumidor | Uso |
|---|---|---|---|
| `APP_ENV` | Sí | `functions/api/catastrox/[[path]].js` y su gemela `payments/[[path]].js` | Sin ella, el relay responde 503 |
| `API_BACKEND_URL` | Sí — **debe ser `https://`, nunca localhost/127.0.0.1/loopback IPv6/`0.0.0.0`/wildcard en staging/production (endurecido en este lote)** | Ambos relays de CatastroX | Origen puro del backend Express real; sin ella o inválida, 503, nunca cae a ningún default |
| `CORS_ALLOWED_ORIGINS` | No (opcional, CSV) | Ambos relays de CatastroX (y también `functions/api/health.js`, mismo nombre de variable, mismo mecanismo) | Misma semántica que la variable homónima del backend Express |

**Tercer relay** (`functions/api/health.js`, exclusivo de `GET /api/health/live`) — desde el cierre final (§13) usa el mismo endurecimiento que los otros dos:

| Variable | Requerida en staging | Consumidor | Uso |
|---|---|---|---|
| `API_BACKEND_URL` | Sí — validada con `resolvePublicOriginForEnvironment()` (mismo endurecimiento HTTPS/no-local que los relays de CatastroX, desde §13) | `functions/api/health.js` | Origen del backend consultado para el proxy de liveness |
| `API_BACKEND_ALLOWED_ORIGIN` | **Sí, obligatoria en staging/producción** (opcional en development/test) — también validada con `resolvePublicOriginForEnvironment()` desde §13 | `functions/api/health.js` | Mecanismo de *pinning* positivo: debe coincidir EXACTAMENTE con `API_BACKEND_URL` normalizada, o el relay responde 503 sin revelar ninguno de los dos valores |

## 3. Deploy order (staging)

1. Aprovisionar Postgres de staging (ambos: base `agx` y base PostGIS `catastrox`), con conectividad de red desde el backend.
2. **Tomar un respaldo/snapshot de la base PostGIS de staging** inmediatamente antes de migrar (aunque la base recién se aprovisione y esté vacía — establece el hábito operativo desde el primer despliegue).
3. Ejecutar migraciones **002 → 003 → 004 → 005** en orden estricto contra la base `catastrox` de staging (ver §5 — **no ejecutado en este lote**). **No** ejecutar ningún script de `scripts/catastrox/backfill-*.mjs` como parte de este paso — los backfills son una decisión operativa separada (ver §5).
4. Verificar que las 4 migraciones se aplicaron correctamente (confirmar que las tablas/columnas nuevas existen — p. ej. `select column_name from information_schema.columns where table_name='catastrox_customers'`) antes de continuar.
5. Generar y almacenar en el gestor de secretos de staging: `CATASTROX_PII_ENCRYPTION_KEY` (32 bytes base64 nuevos, nunca reutilizados de development), `CATASTROX_PII_HASH_SECRET`, `HEALTH_MONITOR_TOKEN`, `WOMPI_EVENTS_SECRET_TEST`.
6. Configurar en Wompi Sandbox las llaves/secretos de staging (`WOMPI_PUBLIC_KEY_TEST`, `WOMPI_INTEGRITY_SECRET_TEST`, `WOMPI_EVENTS_SECRET_TEST`) y registrar la URL del webhook de staging en el dashboard de Wompi.
7. Desplegar el backend Express (`server/`) con `APP_ENV=staging` y todas las variables de §2.1.
8. Verificar `GET /api/health/live` (sin auth, ya relayado públicamente por `functions/api/health.js`) y `GET /api/health/ready` (con `HEALTH_MONITOR_TOKEN`, **solo alcanzable con acceso directo/interno al backend — no hay relay público para `/ready*`/`/db`, ver §7**) antes de exponer tráfico real.
9. Desplegar el frontend (Cloudflare Pages) con `VITE_APP_ENV=staging` y las variables de §2.2.
10. Configurar los relays de Cloudflare Pages Functions con las variables de §2.3, apuntando `API_BACKEND_URL` (y, para `functions/api/health.js`, también `API_BACKEND_ALLOWED_ORIGIN`) al backend recién desplegado.
11. Smoke test manual: `GET /api/health/live` a través del dominio público de staging, un lookup de predio, y **detenerse antes de invocar `/customers`** (bloqueado por el hallazgo #4, §8).

## 4. Nuevas validaciones de configuración agregadas en este lote

Todas viven en `server/config/env.js` (`validateEnv()`) y en `shared/security/corsPolicy.js` (`resolvePublicOriginForEnvironment()`, reutilizado por ambos relays de Cloudflare). Fallan-rápido en `getConfig()`/boot — nunca degradan silenciosamente.

1. **Variables obligatorias nuevas en `staging`** (no en `production`, ver residual risk §8): `WOMPI_PUBLIC_KEY_TEST`, `WOMPI_INTEGRITY_SECRET_TEST`, `WOMPI_EVENTS_SECRET_TEST`, `CATASTROX_FRONTEND_URL`.
2. **`WOMPI_PUBLIC_KEY_TEST`, `WOMPI_EVENTS_SECRET_TEST` y `CATASTROX_PII_HASH_SECRET` no pueden ser un placeholder** (`TU_`, `REEMPLAZAR`, `PLACEHOLDER`, `XXX`, `DEMO`) — validado dondequiera que la variable esté presente, no solo en staging. *(Revisión final: extendido a `WOMPI_EVENTS_SECRET_TEST` y `CATASTROX_PII_HASH_SECRET` — el placeholder documentado de este último, 49 caracteres, pasaba el check de longitud sin ser detectado.)*
3. **`WOMPI_INTEGRITY_SECRET_TEST` ahora valida formato** (sin espacios, sin placeholder) — antes no tenía ninguna validación. *(Revisión final.)*
4. **`WOMPI_PUBLIC_KEY_TEST` debe iniciar con `pub_test_`** — rechaza por diseño una llave de producción (`pub_prod_...`) configurada por error en staging; antes solo se comprobaba en tiempo de request dentro de `POST /checkout`, ahora también al arrancar.
5. **`CATASTROX_FRONTEND_URL` debe ser `https://` y nunca `localhost`/`127.0.0.1`/loopback IPv6 (`::1`, `[::]`)/`0.0.0.0`/host con wildcard** en `staging`/`production` (vía `resolvePublicOriginForEnvironment`); sigue permitiendo `http://127.0.0.1:5173` en `development`/`test`. *(Revisión final: se cerró el hueco de IPv6/wildcard/`0.0.0.0`, y una regresión propia detectada y corregida en el mismo pase — `localhost.localdomain`, alias real de loopback en Linux, había dejado de rechazarse.)*
6. **`API_BACKEND_URL` (los tres relays de Cloudflare)** — misma regla aplicada en `functions/api/catastrox/[[path]].js`, `functions/api/catastrox/payments/[[path]].js` y, desde el cierre final (§13), también en `functions/api/health.js` (incluyendo su variable de *pinning* `API_BACKEND_ALLOWED_ORIGIN`).
7. `HEALTH_MONITOR_TOKEN` (mín. 32 caracteres) — validación preexistente, sin cambios, ya cubría este lote.
8. `CATASTROX_PII_ENCRYPTION_KEY`/`CATASTROX_PII_HASH_SECRET` — validaciones preexistentes (32 bytes base64 / mín. 32 caracteres), ya obligatorias en staging; `CATASTROX_PII_HASH_SECRET` ganó además el check de placeholder del punto 2.
9. **`normalizeOrigin()` rechaza hostnames con wildcard** (`*`) — el parser WHATWG URL no trata `*` como carácter prohibido de host, así que `https://*.agrogenomax.com` se parseaba sin error; cierra el hueco tanto para `CATASTROX_FRONTEND_URL`/`API_BACKEND_URL` como para la allowlist de `CORS_ALLOWED_ORIGINS` (fuente única). *(Revisión final.)*
10. **CORS explícito**: ya se satisface por diseño desde antes de este lote — `resolveAllowedOriginsForEnvironment('staging', ...)` siempre incluye `https://staging.agrogenomax.com` de forma obligatoria y nunca refleja ni acepta un wildcard; `CORS_ALLOWED_ORIGINS` solo puede *ampliar*, nunca sustituir, esa allowlist. No se agregó una variable "requerida" adicional para esto porque ya es un invariante estructural, no una configuración opcional que pueda faltar.
11. **Cookies `Secure`**: ya correcto desde antes de este lote — `server/security/recoveryCookie.js` aplica `Secure` automáticamente cuando `appEnv==='staging'||appEnv==='production'` (`shouldUseSecureCookie()`); no requirió cambio de código, solo esta documentación.
12. **Fallar al arrancar si falta una variable crítica**: ya era el comportamiento de `getConfig()`/`validateEnv()` desde el LOTE-002 original — este lote solo amplía la lista de variables cubiertas por ese mecanismo existente (puntos 1-6 arriba).

## 5. Migraciones (orden 002 → 005)

| Migración | Contenido | Estado |
|---|---|---|
| `002_catastrox_payment_orders.sql` | Tabla de órdenes de pago, referencia/transacción/token únicos | Commiteada, no ejecutada contra staging |
| `003_catastrox_payment_recovery_and_webhook_state.sql` | Token de recuperación, `canonical_predio_id`, estado transaccional del webhook | Commiteada, no ejecutada contra staging |
| `004_catastrox_commercial_model_n_purchases.sql` | Modelo comercial N-compras: `customers`, `billing_profiles`, `recovery_sessions`, `delivery_jobs`, `invoice_jobs`, `email_verifications`; retira el índice único global de "un derecho por predio" | Commiteada, no ejecutada contra staging |
| `005_catastrox_pii_hardening_and_idempotency.sql` | Columnas cifradas (`*_encrypted`)/hash (`*_hash`) de PII; `UNIQUE(payment_order_id)` en `delivery_jobs`/`invoice_jobs` | Commiteada, no ejecutada contra staging |

**Las migraciones no eliminan tablas ni columnas. Sin embargo, la migración 004 retira deliberadamente el índice único global que impedía múltiples compras del mismo predio y paquete. Por ello deben aplicarse con backup previo y validación posterior de índices, restricciones y datos.** Las columnas en texto plano de PII (endurecidas en la migración 005) quedan deprecadas pero presentes — su retiro está diferido a una migración futura, después de backfill+verificación en staging real, y tampoco es una simple operación aditiva sin riesgo.

**Este lote no ejecutó ninguna migración contra ninguna base de datos** — se limitó a confirmar que las 4 migraciones (002, 003, 004, 005) existen como archivos, están commiteadas y su orden es consistente.

**Antes de ejecutar**: tomar un respaldo/snapshot de la base (§3, paso 2). **Después de ejecutar**: verificar explícitamente que el esquema resultante es el esperado (§3, paso 4) antes de desplegar el backend contra esa base.

**Backfills — decisión operativa separada, nunca automática.** `scripts/catastrox/backfill-known-approved-order.mjs` y `scripts/catastrox/backfill-rehash-domain-separated-pii.mjs` **no forman parte del proceso de despliegue** y este documento no sugiere ejecutarlos como paso de rutina. Cada ejecución es una decisión manual, deliberada, tomada caso por caso por quien opera staging (p. ej. para respaldar una transacción Sandbox específica ya aprobada, o para re-hashear PII después de rotar `CATASTROX_PII_HASH_SECRET`) — nunca un script que corra solo, en cron, ni como parte de un pipeline de CI/CD.

## 6. Checklist pre-despliegue

- [ ] Generar `CATASTROX_PII_ENCRYPTION_KEY`/`CATASTROX_PII_HASH_SECRET`/`HEALTH_MONITOR_TOKEN`/`WOMPI_EVENTS_SECRET_TEST` **nuevos** para staging (nunca reutilizar los de development/production).
- [ ] Confirmar `WOMPI_PUBLIC_KEY_TEST`/`WOMPI_INTEGRITY_SECRET_TEST`/`WOMPI_EVENTS_SECRET_TEST` provienen del dashboard de Wompi Sandbox de staging (no de development, no de producción).
- [ ] Confirmar `CATASTROX_FRONTEND_URL`/`VITE_AGX_PUBLIC_APP_URL` apuntan al dominio real de staging (`https://staging.agrogenomax.com`), no a un valor de ejemplo.
- [ ] Confirmar `API_BACKEND_URL` (y, para `functions/api/health.js`, también `API_BACKEND_ALLOWED_ORIGIN`) apunta al backend de staging real por HTTPS.
- [ ] Tomar un respaldo/snapshot de la base PostGIS de staging inmediatamente antes de migrar.
- [ ] Ejecutar migraciones 002→005 contra la base PostGIS de staging, en ese orden, una sola vez, y verificar el esquema resultante antes de continuar.
- [ ] **No** ejecutar ningún script de `scripts/catastrox/backfill-*.mjs` como parte del despliegue de rutina — solo bajo una decisión operativa explícita y separada (ver §5).
- [ ] Decidir y documentar la respuesta a la pregunta bloqueante del hallazgo #4 (proveedor de correo) antes de anunciar staging como "operativo para pruebas de comprador" (ver §8).
- [ ] Correr `npm run test:all`, `npm run build`, `npm audit` localmente contra la rama a desplegar (ver §9 de este lote).

## 7. Checklist post-despliegue

- [ ] `GET /api/health/live` responde 200 sin autenticación **a través del dominio público de staging** (relayado por `functions/api/health.js`) — esta es la única señal de salud reachable públicamente; nunca implementa ni sustituye a readiness.
- [ ] `GET /api/health/ready`, `/ready/ganaderia`, `/ready/catastrox`, `/api/health/db` responden 200 únicamente con `HEALTH_MONITOR_TOKEN` correcto, y 401/403 sin él — **verificar esto con acceso directo/interno al backend** (VPN, red interna, port-forward), nunca a través del dominio público: estas rutas **no** están expuestas por ningún relay de Cloudflare (`server/routes/health.js` lo declara explícitamente en su comentario de cabecera). Ninguna de ellas valida correo, Wompi ni generación de entregables — `/ready/catastrox` únicamente confirma PostGIS + esquemas críticos (`server/health/catastroxReadiness.js` excluye Wompi explícitamente, por ser "error funcional de negocio, no de disponibilidad de instancia").
- [ ] Un lookup de predio real (`GET /api/catastrox/lookup-by-code/...`) responde correctamente a través del dominio público de staging (confirma que el relay de CatastroX llega al backend).
- [ ] El preflight CORS desde `https://staging.agrogenomax.com` se acepta; desde cualquier otro origen (incluyendo `https://agrogenomax.com`) se rechaza.
- [ ] El cookie `catastrox_recovery_session` emitido en staging trae `Secure; HttpOnly; SameSite=Lax; Path=/api/catastrox/payments`.
- [ ] **No** intentar un flujo de compra completo (`POST /customers`) hasta resolver el hallazgo #4 — fallará con 503 `EMAIL_DELIVERY_UNAVAILABLE` por diseño.

## 8. Riesgos residuales / qué NO está listo para producción

1. **Bloqueante — sin proveedor de correo real.** `server/services/catastrox/emailSender.js` es un stub (`{delivered:false, providerMessageId:null, mode:'stub'}` siempre). Desde el endurecimiento del Turno D de este proyecto, `POST /customers` responde `503 EMAIL_DELIVERY_UNAVAILABLE` en cualquier ambiente que no sea `development`/`test`. **Consecuencia directa: en staging, el flujo de comprador (registro → OTP → compra) no puede completarse de extremo a extremo hasta conectar un proveedor real** (SMTP/SES/Resend/etc., no incluido en este repo). Cualquier prueba de staging debe limitarse a health/lookup/CORS hasta resolver esto.
2. **Wompi en modo producción no está implementado.** `REQUIRED_VARIABLES_BY_ENV.production` en `server/config/env.js` no incluye `WOMPI_PUBLIC_KEY_TEST`/`WOMPI_INTEGRITY_SECRET_TEST`/`WOMPI_EVENTS_SECRET_TEST` a propósito — no existen aún variables equivalentes de producción (`WOMPI_PUBLIC_KEY_PRODUCTION`, etc.) en el código. `validateEnv()` sí impide que `WOMPI_ENV=production` en staging o que `WOMPI_ENV=test` en producción, pero el soporte completo de cobros reales queda fuera del alcance de este repo tal como está hoy.
3. **Ningún proveedor de facturación electrónica conectado.** `server/services/catastrox/invoiceJobService.js` expone la interfaz (`createElectronicInvoiceForOrder`) pero sin proveedor real — los jobs de factura quedan en `NOT_REQUESTED`/`FAILED` con `last_error_code` explícito, nunca simulan una factura emitida.
4. **Sin generación real de entregables PDF server-side.** `deliveryJobService.js` expone `generateDeliverablesForOrder`/`sendDeliveryEmail`, ambos con postura "falla explícito, nunca finge éxito" — documentado desde el plan original de este módulo.
5. **Rotación de secretos no automatizada.** No existe gestor de secretos externo en este repo; `CATASTROX_PII_ENCRYPTION_KEY`/`CATASTROX_PII_HASH_SECRET` requieren rotación manual coordinada con backfill si alguna vez cambian.
6. **`VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` para staging** — decisión pendiente, ver §9 (si el módulo Ganadería debe estar activo en el mismo despliegue de staging que CatastroX).
7. **Retiro de columnas PII en texto plano** (migración 005 las deja deprecadas pero presentes) — pendiente de una migración futura, después de correr y verificar el backfill de cifrado/rehash contra datos reales de staging.

## 9. Decisiones que requieren definición antes del despliegue real

1. **Proveedor de email transaccional para staging/producción** — quién lo elige, con qué remitente (`from`) y con qué límites de envío (bloqueante para probar el flujo de comprador end-to-end, hallazgo #4).
2. **Si Ganadería/Supabase debe desplegarse en el mismo entorno de staging que CatastroX**, o si staging de CatastroX se levanta de forma aislada sin esas variables.
3. **Quién genera y custodia** `CATASTROX_PII_ENCRYPTION_KEY`/`CATASTROX_PII_HASH_SECRET`/`HEALTH_MONITOR_TOKEN`/`WOMPI_EVENTS_SECRET_TEST` de staging (gestor de secretos, proceso de rotación, quién tiene acceso).
4. **Cuándo y quién ejecuta las migraciones 002→005** contra la base PostGIS de staging, y quién verifica el resultado antes de dar por completo el despliegue.
5. **Cuándo se implementa el soporte de Wompi en modo producción** (llaves/secretos `_PRODUCTION`, validaciones equivalentes en `env.js`) — actualmente fuera de alcance de este repo.
6. **Criterio de "listo para anunciar staging"**: ¿basta con health/CORS/lookup funcionando, o se exige que el flujo de comprador complete de extremo a extremo (lo cual depende del punto 1)?

## 10. Criterios de rollback

Revertir el despliegue de staging (volver a la versión previa del backend/frontend/relay) si, después de desplegar, se observa cualquiera de estas condiciones:

- `GET /api/health/live` o `/api/health/ready` no responden 200 de forma sostenida (más de un par de reintentos con backoff razonable).
- El backend falla al arrancar por `ConfigurationError` (`getConfig()` lanzando en el boot) — indica una variable crítica faltante o mal formada; nunca se debe "parchear en caliente" el proceso ya corriendo, se revierte y se corrige la configuración antes de reintentar.
- El relay de Cloudflare responde 503 de forma sostenida para tráfico legítimo desde `https://staging.agrogenomax.com` (indica `API_BACKEND_URL` mal configurada o backend caído).
- Se detecta que `CORS_ALLOWED_ORIGINS` o `API_BACKEND_URL` quedaron apuntando, por error, a un dominio de producción o a un valor con credenciales embebidas.
- Cualquier log o respuesta expone un valor de `CATASTROX_PII_ENCRYPTION_KEY`, `CATASTROX_PII_HASH_SECRET`, `HEALTH_MONITOR_TOKEN` o cualquier secreto de Wompi.
- Una migración contra la base de staging falla a mitad de camino — no se reintenta a ciegas; se restaura desde el backup previo a la migración y se investiga antes de reintentar.

## 11. Validación ejecutada en este lote

Ver informe de entrega en el mensaje de chat correspondiente a esta rama para el resultado exacto y verbatim de `npm run test:all`, `npm run build`, `npm audit`, `git diff --check` y `git status --short`. Resumen: todos los cambios de este lote son de configuración/validación/documentación — no se tocó lógica de negocio de pagos, PII o entrega ya endurecida en lotes anteriores.

## 12. Revisión final (segunda pasada de auditoría)

Después de la entrega inicial de este documento se ejecutó una revisión final dirigida, punto por punto, contra el código real (no solo contra lo documentado). Esa revisión encontró y corrigió 3 defectos reales adicionales (hallazgos #7, #8, #9 en §1) y documentó, sin corregir por estar fuera del alcance explícito del pedido, una inconsistencia en un tercer relay de Cloudflare no cubierto por el endurecimiento original (hallazgo #10). Ningún hallazgo de esta segunda pasada afecta datos ya almacenados ni requiere backfill — todos son validaciones de configuración que solo se ejecutan al arrancar el proceso o al procesar una request del relay, nunca contra datos persistidos. Ver el informe de entrega de esa revisión (mensaje de chat correspondiente) para el resultado exacto de la segunda corrida de `npm run test:all`/`npm run build`/`npm audit`/`git diff --check`/`git status --short`.

## 13. Cierre final

Tercera pasada, de cierre, sobre dos pendientes explícitos dejados por la revisión final (§12):

1. **Precisión documental sobre migraciones (hallazgo #11)**: se corrigió la referencia a "5 archivos" (son 4 migraciones: 002, 003, 004, 005 — el "5" contaba erróneamente algo que no correspondía a un conteo de migraciones) y se reemplazó la afirmación genérica "todas son aditivas" por una formulación exacta: las migraciones no eliminan tablas ni columnas, pero la migración 004 retira deliberadamente el índice único global que impedía múltiples compras del mismo predio y paquete — un cambio de comportamiento real, no una operación puramente aditiva sin riesgo. Ver §5.
2. **Inconsistencia del tercer relay (hallazgo #10), Opción A implementada**: `functions/api/health.js` ahora usa `resolvePublicOriginForEnvironment()` (el mismo helper compartido que ya usaban los dos relays de CatastroX y `server/config/env.js`) para validar tanto `API_BACKEND_URL` como `API_BACKEND_ALLOWED_ORIGIN`, en vez de `normalizeOrigin()` puro. Se eligió la Opción A sobre la B porque: (a) el helper ya existe, ya está probado y ya es la fuente única de verdad para esta regla en el resto del código — duplicarla con una Opción B habría significado mantener dos implementaciones de la misma regla; (b) el análisis confirmó que la Opción B (mantener `normalizeOrigin()` y solo demostrar con pruebas que el *pinning* positivo compensa) no era en realidad segura: `isBackendOriginAllowedForEnv()` nunca validó el protocolo, por lo que nada impedía configurar `API_BACKEND_URL` y `API_BACKEND_ALLOWED_ORIGIN` con el mismo valor `http://` (o `https://localhost`) y que el relay lo aceptara — la Opción B habría dejado un hueco real, no solo teórico. El mecanismo de *pinning* positivo (igualdad exacta) y el filtro adicional `isBackendOriginAllowedForEnv()` se conservaron sin cambios, como capas de defensa adicionales.
