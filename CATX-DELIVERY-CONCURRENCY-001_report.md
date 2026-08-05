# CATX-DELIVERY-CONCURRENCY-001 Report

Fecha: 2026-08-05  
Base local confirmada: `9b0e749da1b986bc48d93787279ea8f15ad208cc`

## 1. Causa raiz

`processDeliveryJob(jobId)` leia el job sin lock, calculaba `attempt_count + 1` fuera de una seccion critica y luego generaba PDF/enviaba correo. Dos ejecuciones podian crear intentos y deliverables duplicados y llamar dos veces a Resend.

## 2. Estrategia de locking/claim

Se eligio claim atomico corto con `UPDATE ... WHERE status IN ('QUEUED','FAILED') RETURNING *`.

Motivo: no mantiene transacciones abiertas durante PDF, teselas, storage ni correo. La ejecucion que no recibe fila no crea intento, no genera PDF y no envia correo; devuelve el estado actual (`already_processing`, `already_sent`, `not_found`, `not_claimable` via log).

No se agrego `PROCESSING` porque el enum vigente no lo contiene. Se usa `GENERATING` como estado reclamado/activo compatible con la maquina existente.

## 3. Maquina de estados

Flujo normal:

`QUEUED|FAILED -> GENERATING -> READY -> SENDING -> SENT`

Fallos:

`GENERATING|READY|SENDING -> FAILED`

Idempotencia:

- `SENT`/`DELIVERED`: no-op, devuelve estado actual.
- `GENERATING`/`READY`/`SENDING`: no-op si no vencio timeout.
- estados activos vencidos: reclamables despues de 30 minutos si `provider_message_id is null`.

## 4. Constraints nuevos

Migracion nueva:

`supabase/migrations/009_catastrox_delivery_concurrency.sql`

Agrega:

- `uq_catastrox_delivery_attempts_job_attempt`: `UNIQUE (delivery_job_id, attempt_number)`.
- `uq_catastrox_deliverables_job_file_type`: `UNIQUE (delivery_job_id, file_type)`.

Incluye diagnosticos previos y falla con `RAISE EXCEPTION` si ya existen duplicados. No borra datos, no usa `DROP`, no usa `CASCADE`.

Nota: el archivo pedido `supabase/migrations/005_catastrox_customer_otp_history.sql` no existe en este checkout; la migracion local equivalente auditada es `005_catastrox_pii_hardening_and_idempotency.sql`.

## 5. Tratamiento de intentos

`attempt_number` ahora proviene del `attempt_count` devuelto por el `UPDATE` atomico de claim.

Invariante:

`attempt.attempt_number === delivery_job.attempt_count`

Ya no se calcula con una lectura no bloqueada. `markDeliveryJobFailed()` y `SENT` ya no incrementan `attempt_count`; el contador crece solo al reclamar un intento.

## 6. Tratamiento de deliverables

El PDF canonico es unico por `(delivery_job_id, file_type)`.

`generateAndStoreDeliverable()`:

1. genera buffer y checksum;
2. reserva metadata;
3. si hay conflicto unique, intenta reutilizar el deliverable existente verificado;
4. almacena blob;
5. confirma `storage_key`;
6. si falla storage, elimina solo la metadata incompleta con `storage_key is null`.

`findReusableDeliverable()` ignora filas sin `storage_key`.

## 7. Prevencion de doble correo

Antes de Resend hay transicion condicional:

`READY -> SENDING`

Solo quien consigue esa transicion llama `sendDeliverableEmail()`. Despues del proveedor:

`SENDING -> SENT`

tambien es condicional por `attempt_count`.

La proteccion principal es local; `Idempotency-Key` de Resend queda como defensa secundaria.

## 8. Retry manual

`retryDeliveryJob()` delega en `processDeliveryJob()`, por lo que usa el mismo claim atomico.

`POST /orders/:orderToken/delivery/retry`:

- `SENT`/`DELIVERED`: responde OK idempotente.
- `GENERATING`/`READY`/`SENDING`: responde `409 DELIVERY_ALREADY_PROCESSING`.
- `FAILED`: intenta procesar; dos clicks simultaneos producen un solo claim.

No se toco Wompi ni estado de pago.

## 9. Recuperacion de SENDING

Estados activos (`GENERATING`, `READY`, `SENDING`) con `provider_message_id is null` y `last_attempt_at < now() - interval '30 minutes'` pueden reclamarse de nuevo.

Esto evita bloqueo permanente. Si el proceso murio en `SENDING`, el reenvio solo ocurre con criterio temporal explicito, no por una carrera inmediata.

## 10. Pruebas concurrentes

Agregadas en `server/routes/__tests__/catastroxDeliveryLifecycle.test.js`:

- doble `Promise.all(processDeliveryJob(jobId), processDeliveryJob(jobId))`;
- doble retry simultaneo sobre `FAILED`;
- doble ejecucion sobre `SENT`;
- conflicto unique de intento;
- recuperacion de estado activo vencido;
- verificacion de un solo deliverable y un solo blob.

La suite de integracion PostgreSQL se auto-omite en este entorno porque no hay DB local disponible.

## 11. Frontend packageId

`src/modules/catastrox/pages/CatastroXPackagePage.jsx`:

- el efecto de `deliverableOrderToken` ahora depende de `packageId`;
- limpia `deliverableOrderToken` anterior;
- limpia `pdfDownloadState`;
- resuelve nuevamente orden compatible.

## 12. Prueba funcional del PDF oficial

`src/modules/catastrox/utils/catastroxDeliverableDownload.js` ahora expone `executeCatastroxPackageDownloadDecision()`.

`catastroxOfficialPdfArchitecture.test.js` agrega prueba conductual:

- ordenes mock aprobadas;
- token compatible por paquete;
- `officialDownload` llamado una vez;
- `localDownload`/`downloadPlanPdf` nunca llamado para compra real.

La prueba textual queda como defensa secundaria.

## 13. Logs

`server/services/catastrox/emailSender.js` ya no registra `toDomain`.

Se conserva:

- `provider`;
- `errorCode`;
- etapa textual.

No se registra email, dominio, OTP, API key, body del proveedor, recovery token ni orderToken en logs de email.

## 14. Archivos modificados

- `server/services/catastrox/deliveryJobService.js`
- `server/routes/catastroxPayments.js`
- `server/services/catastrox/emailSender.js`
- `server/routes/__tests__/catastroxDeliveryLifecycle.test.js`
- `server/services/catastrox/__tests__/emailSender.test.js`
- `src/modules/catastrox/pages/CatastroXPackagePage.jsx`
- `src/modules/catastrox/pages/__tests__/catastroxOfficialPdfArchitecture.test.js`
- `src/modules/catastrox/utils/catastroxDeliverableDownload.js`
- `supabase/migrations/009_catastrox_delivery_concurrency.sql`
- `CATX-DELIVERY-CONCURRENCY-001_report.md`

No se modificaron Wompi, cobro, webhook signature, facturacion Alegra, PDF visual, area canonica ni polling postpago.

## 15. Migracion 009

No aplicada en produccion.

No pude aplicarla localmente porque este entorno no tiene PostgreSQL local disponible para la suite de integracion.

## 16. Resultado de npm test

Intento completo con `cmd.exe /c npm test`:

- `test:node`: paso.
- Resumen visible: `1122` tests, `1098` pass, `24` skipped.
- Luego `test:catastrox-semantic` fallo por permisos del sandbox al resolver `vite.config.js`:
  - `Cannot read directory "../../../..": Access is denied.`
  - `Could not resolve ".../vite.config.js"`.

Pruebas dirigidas:

- `node --test server/routes/__tests__/catastroxDeliveryLifecycle.test.js server/services/catastrox/__tests__/emailSender.test.js src/modules/catastrox/pages/__tests__/catastroxOfficialPdfArchitecture.test.js`
- Resultado: `61` tests, `60` pass, `1` skipped, `0` fail.

Subtest geometrico:

- `node src/modules/catastrox/utils/tests/runGeometryTests.mjs`
- Resultado: `86` tests, `86` pass.

Subtest semantico directo:

- Bloqueado por el mismo permiso del sandbox sobre `vite.config.js`.

## 17. Resultado de build

`npm run build`: exit code `0`.

Warning existente:

- chunks mayores a 500 kB despues de minificacion.

## 18. Riesgos

- La migracion 009 puede fallar si existen duplicados historicos; eso es intencional y exige auditoria manual.
- La recuperacion de `SENDING` vencido puede reenviar despues de 30 minutos si el proveedor acepto el correo pero el proceso murio antes de guardar `provider_message_id`. Es el criterio explicito de recuperacion para no bloquear permanentemente.
- Las pruebas PostgreSQL concurrentes quedaron escritas, pero omitidas localmente por ausencia de DB.

## 19. Rollback

Codigo:

- revertir cambios en los archivos listados.

DB:

- si la migracion 009 ya fue aplicada y se requiere rollback, eliminar manualmente los constraints:
  - `uq_catastrox_delivery_attempts_job_attempt`
  - `uq_catastrox_deliverables_job_file_type`

No hay cambios destructivos de datos.

## 20. Lista exacta para commit

Incluir:

- `server/services/catastrox/deliveryJobService.js`
- `server/routes/catastroxPayments.js`
- `server/services/catastrox/emailSender.js`
- `server/routes/__tests__/catastroxDeliveryLifecycle.test.js`
- `server/services/catastrox/__tests__/emailSender.test.js`
- `src/modules/catastrox/pages/CatastroXPackagePage.jsx`
- `src/modules/catastrox/pages/__tests__/catastroxOfficialPdfArchitecture.test.js`
- `src/modules/catastrox/utils/catastroxDeliverableDownload.js`
- `supabase/migrations/009_catastrox_delivery_concurrency.sql`
- `CATX-DELIVERY-CONCURRENCY-001_report.md`

No incluir salvo decision expresa:

- `CATX_AUDIT_POSTPRODUCTION_2026_08_05_R3.md` (no rastreado previo, ajeno a este cambio).

## Bloqueos operativos

- `git fetch origin`: fallo por permiso al escribir `FETCH_HEAD` del worktree real.
- `git switch -c fix/catx-delivery-concurrency-001 origin/main`: fallo por permiso al crear `index.lock`.
- El checkout quedo en `HEAD (no branch)` por ese bloqueo de permisos.

## Cierre en producción

- Pull Request: #23.
- Rama fusionada: fix/catx-delivery-concurrency-001.
- Commit funcional: 77a91ea.
- Commit de merge en main: ac9acea.
- Despliegue backend Railway: exitoso.
- Despliegue frontend Cloudflare Pages: exitoso.
- Migración aplicada: 009_catastrox_delivery_concurrency.sql.
- Constraint uq_catastrox_delivery_attempts_job_attempt: verificado.
- Constraint uq_catastrox_deliverables_job_file_type: verificado.
- Prueba E2E en producción:
  - payment_status: APPROVED.
  - delivery_status: SENT.
  - attempt_count: 1.
  - attempts: 1.
  - deliverables: 1.
- Correo recibido correctamente con un solo PDF adjunto.
- PDF descargado desde las diferentes vías: idéntico.
- No se identificaron entregas, intentos ni correos duplicados.
- Rama local eliminada.
- Rama remota eliminada.
- Base temporal agrogenomax_concurrency_test eliminada.
- Variables temporales sensibles eliminadas.

## Resultado

El riesgo de procesamiento concurrente y generación duplicada de entregables quedó mitigado y validado en producción.

Estado final: CERRADO.

