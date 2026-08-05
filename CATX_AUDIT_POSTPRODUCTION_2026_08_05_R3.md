# CATX Audit Postproduction 2026-08-05 R3

Fecha: 2026-08-05  
Checkout auditado: `9b0e749da1b986bc48d93787279ea8f15ad208cc`  
Veredicto: **NO APROBADO**

## 1. Confirmacion del checkout

Comandos solicitados, sin `git fetch`, `git pull` ni `git ls-remote`:

- `git status --short --branch`: `## HEAD (no branch)`
- `git rev-parse HEAD`: `9b0e749da1b986bc48d93787279ea8f15ad208cc`
- `git rev-parse origin/main`: `9b0e749da1b986bc48d93787279ea8f15ad208cc`
- `git merge-base --is-ancestor a1f4925ae996e9ea9ec6350dbfb577b193072e35 HEAD`: exit code `0`

Ultimos commits relevantes:

```text
9b0e749 (HEAD, origin/main, origin/HEAD) Merge pull request #22 from cristianferamos-ux/fix/catx-canonical-deliverable-area-001
a1f4925 fix(catastrox): use canonical deliverable and consistent area source
d064b8c Merge pull request #21 from cristianferamos-ux/fix/catx-postpayment-ux-001
e77d2a8 fix(catastrox): sync postpayment status, format COP and align PDF points
aafb69e Merge pull request #20 from cristianferamos-ux/feat/catx-delivery-observability-001
34e2812 feat(catastrox): add delivery observability and tile retry resilience
```

Confirmacion adicional:

- PR #20 (`aafb69e`) contenido en HEAD: exit code `0`
- PR #21 (`d064b8c`) contenido en HEAD: exit code `0`
- PR #22 (`9b0e749`) contenido en HEAD: exit code `0`

## 2. Verificacion ejecutada

- `npm ci`: exit code `0`; npm reporto `3 vulnerabilities` (`1 moderate`, `2 high`). No se ejecuto `npm audit fix`.
- `npm test`: exit code `0`.
- `npm run build`: exit code `0`; Vite emitio warning de chunk mayor a 500 kB.

## 3. Hallazgos bloqueantes

### H1. `processDeliveryJob()` no esta protegido contra ejecucion concurrente

Archivo: `server/services/catastrox/deliveryJobService.js`

`processDeliveryJob(jobId)` hace `select * from public.catastrox_delivery_jobs where id = $1`, calcula `attemptNumber = job.attempt_count + 1`, inserta `catastrox_delivery_attempts` y luego genera/reusa PDF y envia correo. No encontre:

- `FOR UPDATE` / `SKIP LOCKED`.
- advisory lock por `jobId`.
- transicion atomica condicional tipo `update ... where id = $1 and status in (...) returning *`.
- guarda que impida procesar un job ya `SENDING`/`SENT` dentro del processor.

Impacto: dos invocaciones simultaneas de `processDeliveryJob(job.id)` pueden leer el mismo `attempt_count`, iniciar el mismo `attempt_number`, pasar a `SENDING` y ejecutar `sendDeliverableEmail()` dos veces. El `idempotencyKey` enviado al proveedor ayuda solo si el proveedor lo respeta de forma estricta; no sustituye una barrera local.

Estado: **bloqueante para produccion**.

### H2. Riesgo de doble envio por carrera entre webhook/verify/retry

Archivo: `server/routes/catastroxPayments.js`

`triggerPostApprovalWorkflows()` crea el job y dispara `processDeliveryJob(job.id)` sin `await`. Eso es correcto para no bloquear Wompi, pero exige que `processDeliveryJob()` sea idempotente bajo concurrencia real.

El endpoint manual `POST /orders/:orderToken/delivery/retry` valida `job.status === 'FAILED'` antes de llamar `retryDeliveryJob(job.id)`, pero esa validacion tampoco esta bajo lock. Dos requests concurrentes de retry sobre el mismo job `FAILED` pueden pasar la validacion y llegar al processor.

Estado: **bloqueante para produccion**.

### H3. Deliverables duplicados posibles

Archivo: `server/services/catastrox/deliveryJobService.js`  
Migraciones: `supabase/migrations/004_catastrox_commercial_model_n_purchases.sql`, `007_catastrox_deliverable_blobs.sql`

`generateAndStoreDeliverable()` inserta en `catastrox_deliverables` sin `ON CONFLICT` ni constraint unica por job/tipo. La tabla tiene PK en `id` e indice `idx_catastrox_deliverables_job`, pero no una unicidad como `(delivery_job_id, file_type)` o equivalente.

Impacto: si dos processors corren simultaneamente y ambos no encuentran un reusable deliverable todavia, ambos pueden insertar metadatos y blobs distintos para el mismo job. `fetchVerifiedDeliverableForOrder()` recupera el mas reciente via `findReusableDeliverable()`, pero eso no elimina la duplicacion ni sus efectos colaterales.

Estado: **bloqueante para produccion**.

### H4. Falta constraint unico para intentos por numero

Migracion: `supabase/migrations/008_catastrox_delivery_attempts.sql`

`catastrox_delivery_attempts` define `attempt_number > 0` e indice:

```sql
create index idx_catastrox_delivery_attempts_job
  on public.catastrox_delivery_attempts (delivery_job_id, attempt_number);
```

No es `unique`. En una carrera, dos intentos del mismo job pueden registrar el mismo `attempt_number`. Esto rompe la auditoria operacional que PR #20 intenta introducir.

Estado: **bloqueante para produccion**.

## 4. Observaciones no bloqueantes

### O1. `CatastroXPackagePage.jsx` conserva una dependencia faltante de `packageId`

Archivo: `src/modules/catastrox/pages/CatastroXPackagePage.jsx`

El `useEffect` que resuelve `deliverableOrderToken` usa:

```js
resolveDeliverableOrderTokenForPredio({ orders, codigoPredial, requiredPackageId: packageId })
```

pero su arreglo de dependencias es:

```js
[isPaid, isAuditUnlocked, predio.codigoPredial, predio.codigo]
```

Debe incluir `packageId` y probablemente limpiar `deliverableOrderToken` si no hay token compatible. Riesgo: token obsoleto al cambiar de paquete sin remontar el componente.

### O2. Pruebas del PDF oficial aun tienen una capa textual debil

Archivo: `src/modules/catastrox/pages/__tests__/catastroxOfficialPdfArchitecture.test.js`

La prueba de arquitectura lee fuentes con `fs.readFileSync()` y valida `includes()`/regex. Esto protege contra regresiones obvias, pero no prueba el comportamiento real de UI ni que el boton descargue efectivamente el endpoint oficial bajo estado real.

Hay pruebas PDF backend mucho mas fuertes en `server/services/catastrox/pdf/__tests__/catastroxPdfParity.test.js`, pero no sustituyen una prueba funcional del flujo oficial de descarga en `CatastroXPackagePage`.

### O3. Logs: no vi correo completo, pero si metadata derivada del email

Archivos: `server/services/catastrox/emailSender.js`, `server/services/catastrox/deliveryJobService.js`

No encontre logs de correo completo, nombre del comprador, OTP ni cuerpo completo del proveedor. `deliveryJobService` registra ids, checksum, byte size, provider_message_id y `order_token`.

Sin embargo, `emailSender.js` registra `toDomain`, que es metadata derivada del correo. Si la politica R3 exige cero metadata derivada del email, esto debe cambiarse a conteo/errorCode/proveedor sin dominio.

## 5. Controles que si quedaron bien

- PR #20, #21 y #22 estan contenidos en HEAD.
- `createDeliveryJobForOrder()` usa `ON CONFLICT (payment_order_id)` y la migracion 005 agrega `uq_catastrox_delivery_jobs_order`.
- La descarga oficial valida sesion/ownership antes de servir el PDF.
- El flujo de descarga re-verifica checksum antes de servir bytes.
- El PDF oficial se descarga desde blob/backend para compra real; el generador local queda reservado para auditoria.

## 6. Recomendacion minima antes de aprobar

1. Hacer `processDeliveryJob()` reclamable/serializado por job, idealmente con transaccion y lock de fila o advisory lock.
2. Agregar constraint unica a `catastrox_delivery_attempts (delivery_job_id, attempt_number)`.
3. Agregar constraint unica o upsert para `catastrox_deliverables` por job/tipo canonico.
4. Cubrir con prueba de carrera real: `Promise.all([processDeliveryJob(id), processDeliveryJob(id)])` debe producir un solo envio, un solo deliverable y numeracion consistente.
5. Corregir dependencias de `CatastroXPackagePage.jsx` para `packageId`.
6. Reemplazar la prueba textual del PDF oficial por una prueba funcional o complementarla con mock de `downloadDeliverablePdf`.

## Actualización de cierre — CATX-DELIVERY-CONCURRENCY-001

Los riesgos identificados de concurrencia en el procesamiento de delivery jobs fueron corregidos mediante:

- reclamo atómico del job;
- transiciones condicionales de estado;
- protección idempotente de jobs SENT;
- control de reintentos concurrentes;
- recuperación de estados activos vencidos;
- restricción única de intentos por delivery_job_id y attempt_number;
- restricción única de entregables por delivery_job_id y file_type.

La migración 009 fue aplicada y verificada en PostgreSQL de producción.

La prueba E2E posterior al despliegue obtuvo:

- pago APPROVED;
- entrega SENT;
- un intento;
- un entregable;
- un solo correo;
- un solo PDF;
- ausencia de duplicación.

Conclusión: riesgo mitigado y hallazgo cerrado.
