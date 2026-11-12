# FASE 5A — Integridad de pesajes (DISEÑO)

Rama: `feature/ganaderia-pesajes-5a-integridad` (desde main `69d976a`).
Business prod: ledger 0000–0027. Nueva migración: **0028**, por el runner endurecido.

## Estado y alcance vigentes (leer primero)

- **Aprobado**: la sección REVISIÓN 2 prevalece sobre §1–§18 donde difieran. §1–§18 se conservan como registro del análisis inicial.
- **Sin umbrales productivos**: NO hay 5 % ni 14 días; NO hay `PESAJE_VARIACION_ATIPICA`, `GMD_FUERA_DE_RANGO` ni `INTERVALO_CORTO`.
  GMD con 0 días = no calculable; entre días distintos = cálculo normal.
- **`PESAJE_MISMO_DIA` es solo informativa** (INFO, objetiva).
- **Anular + registrar nuevo**; no existe CORREGIR en 5A.
- **Anular: solo owner/admin**; operador no anula en 5A.
- **0028 es FORWARD-ONLY en producción**: una vez aplicada 0028 sobre producción con datos, las correcciones se realizan mediante una migración posterior.
- **5A.1a = solo 0028 + rollback + tests de migración/runner + este documento.** Backend (5A.1b), frontend (5A.2) y offline (5A.3) NO forman parte de 5A.1a.

### Evidencia 5A.1a (local, Docker desechable; 0028 NO aplicada en ningún entorno real)
- Checksum (LF) `0028_animal_pesajes_anulacion.sql` = `d08c36077f1c7df1e058b5839d3ac41ce9562b85469960cce7c6c874046f6dc4`;
  rollback = `6aba97c2577cf5be32cbe33362f1a602488da661b451d2e42c1fee669df4dcb9`.
- Tests nuevos de 0028: 35 PASS (4 de política + 31 de integración). `test:test-runners` 81/81;
  `test:agx-migrations-integration` 57/57; `test:agx-dr` 40/40 (ledger restaurado 0000–0028); `test:node` 4554 PASS (27 skipped);
  integración reproducción 150/150 y animales sobre esquema 0000–0028; `build` PASS; `git diff --check` limpio.
- Integración animales global: 143/144. El único fallo es el **flaky conocido** `animalPesajesIntegration` "28-30"
  (cuenta filas globales de `agx.qr_chapetas` con otros archivos en paralelo): **no es regresión de 0028**; el archivo aislado
  pasa 14/14 sobre 0000–0028. No se corrige en 5A.1a.

### Evidencia previa: auditoría read-only de producción (2026-11-11, autorizada)
Transacción `READ ONLY` + `ROLLBACK`, solo agregados, sin datos personales. No se repite salvo cambio material de main o producción.
3 pesajes (todos MANUAL, del animal QA), 1 organización, 1 animal; 0 duplicados de `client_operation_id`; 0 nulls incoherentes;
1 grupo mismo día (355/360); 0 pesajes antes de nacimiento/ingreso, después de cierre o futuros; 0 inconsistencias tenant;
0 objetos de 0028 preexistentes; RLS ENABLE+FORCE; `agx_app` = INSERT, SELECT.

---

## REVISIÓN 2 — decisiones cerradas (prevalece sobre §1–§18 donde difiera)

### R2.1 Umbrales
Sin umbrales productivos en 5A. **Se retiran** `PESAJE_VARIACION_ATIPICA`, `GMD_FUERA_DE_RANGO`, `calidadGmd`/`INTERVALO_CORTO`, 5 % y 14 días.
El motor puede aceptar en el futuro un objeto de configuración, pero 5A no define ningún valor ni comportamiento dependiente de él.
GMD: intervalo 0 días = no calculable (`null`); entre días distintos = cálculo normal, sin rótulo.

### R2.2 Mismo día (aprobado)
- N ACTIVOS por fecha válidos; el historial conserva todos.
- Serie diaria = último ACTIVO de cada fecha, orden intradía por `pesaje_id` (no hay hora fiable).
- `PESAJE_MISMO_DIA` (INFO, objetiva): fecha más reciente con ≥ 2 ACTIVOS; datos = nº de mediciones, primera y última ACTIVA del día, diferencia firmada (una pérdida intradía se ve con signo −).
- Historial: cada fila intradía muestra su diferencia con la ACTIVA anterior del mismo día, días 0, GMD "no calculable".
- QA AGX-000001: serie 350 → 360, +10 kg, 1 día, **GMD 10 kg/día**, acompañada de `PESAJE_MISMO_DIA` (2 mediciones, 355 → 360, +5 kg). Sin etiqueta de implausible.

### R2.3 Anulación (aprobado)
ANULAR + registrar nuevo; sin CORREGIR. ACTIVO/ANULADO, sin DELETE. Rol: **owner/admin** (`ROLES_ADMINISTRACION`); operador NO anula en 5A
(evolución futura: anular su propio registro con reglas adicionales).

### R2.4 Identidad del actor (mismo patrón que Reproducción, verificado)
| Dato | Reproducción (0026) | Pesajes (0022/0028) |
|---|---|---|
| Actor de creación | `registrado_por uuid NOT NULL` | `actor_cuenta_id uuid NOT NULL` (existente, no se renombra) |
| Actor de anulación | `anulado_por uuid` | `anulado_por uuid` |
| Fuente | `req.ganaderiaAuth.cuentaId` (sesión, Postgres-AGX) | ídem |
| FK | ninguna (Auth vive en otra base) | ninguna |
| `identidadEsperada` | `{cuentaId, organizacionId}` opcional, middleware: rol → identidad → ids → validación; 409 `IDENTIDAD_NO_COINCIDE` antes de cualquier lectura idempotente/escritura; 400 `INVALID_IDENTIDAD_ESPERADA`; nunca se escribe ni entra en la intención | se reutiliza el mismo middleware en POST pesaje y POST anular |
| Exposición API | `anulacion: { anuladoEn, motivo }`, sin actor | ídem: `anulacion: { anuladoEn, motivo }` |

Tenant: el UPDATE corre en `withOrganizacionTransaction` (RLS FORCE + `WITH CHECK`), el trigger impide cambiar `organizacion_id`.
Timeline 5B: hoy el timeline **nunca expone actor** (política en `timelineModelo.js`); mostrar "quién" exigirá resolver uuid → nombre contra
Postgres-AGX server-side (lote, misma organización, membresía vigente) en 5B. 5A solo persiste el uuid.

### R2.5 Idempotencia cross-type (decisión)
Patrón 4E.2A. **Advisory lock + comprobación en aplicación; sin tabla nueva; sin trigger de cruce.**
- Lock común `pg_advisory_xact_lock(hashtext('ganaderia_pesaje_create:<org>:<op>'))` para CREAR y ANULAR. Se **reutiliza la clave actual**
  (no renombrar): durante un deploy con instancias viejas (solo CREAR) y nuevas, ambas serializan sobre la misma clave.
- CREAR: lock → op en `client_operation_id`? (misma intención → 200 `yaExistia`; distinta → 409) → op en `anulacion_client_operation_id`? → 409 `CLIENT_OPERATION_ID_REUSED` → insertar.
- ANULAR: lock → op en `anulacion_client_operation_id`? (mismo pesaje + animal + motivo → 200 `yaExistia`; si no → 409) → op en `client_operation_id`? → 409 → animal `FOR SHARE` (404/409 `ANIMAL_ANULADO`) → pesaje `FOR UPDATE` (404 `PESAJE_NOT_FOUND`, 409 `PESAJE_YA_ANULADO`) → UPDATE.
- Retry legítimo siempre se resuelve antes que cualquier regla de negocio. Respaldo físico: los dos UNIQUE parciales por org (mismo tipo); 23505 → 409.
- Una tabla de operaciones o un trigger de cruce se descartan: duplican lo que el lock ya garantiza y Reproducción no los tiene. Riesgo residual: escritura manual fuera de la app (fuera de contrato).

### R2.6 `fechaIngreso` (decisión)
Evidencia: `fecha_ingreso` pertenece al grupo **Origen** (`origen_tipo` COMPRADO/RECIBIDO/OTRO + `procedencia` "Finca vecina, subasta");
prohibida para `NACIDO_EN_PREDIO`; CHECK `ingreso >= nacimiento`; opcional; la UI la pide como "Fecha de ingreso". El alta en sistema es
`created_at` (y `REGISTRO_INICIAL` usa `hoy` del alta). El cierre (2A) ya la usa como límite inferior y declara que `created_at` NO lo es.
→ Representa el **ingreso físico/adquisición al hato**, no el registro administrativo. **Se usa como límite de negocio** (no biológico):
`fechaPesaje >= max(1990-01-01, fechaNacimiento?, fechaIngreso?)`. El peso de compra se registra con `fecha = fechaIngreso` (igualdad válida).
Corregir el animal: nacimiento o ingreso nuevos > primer pesaje ACTIVO → 409 `HISTORIAL_PESAJES_FECHA_INCOMPATIBLE` (solo si el campo cambia; ANULADOS no restringen).
Prod hoy: 0 animales con `fecha_ingreso` o `fecha_nacimiento` → sin impacto en datos.

### R2.7 Contrato GET (decisión: mismo endpoint, campo nuevo)
`GET /api/ganaderia/animales/:id/pesajes` →
`{ ok, animalId, orden, resumen /*ACTIVOS, serie diaria*/, pesajes /*ACTIVOS enriquecidos: mismo significado*/, historial /*ACTIVOS+ANULADOS*/ }`.
Filas de `historial`: `pesajeId, fecha, pesoKg, metodo, origen, observaciones, createdAt, estadoRegistro, mismoDia, diferenciaKg, diasDesdeAnterior, gmdKgDia (null si ANULADO o intradía), anulacion {anuladoEn, motivo} | null`.
Por qué no endpoint separado: una sola transacción (lista y resumen consistentes), un solo request offline/online, y PDF/timeline siguen usando
un único builder. Un cliente viejo (Pages en caché o SW) sigue leyendo `pesajes` sin ver anulados; los campos nuevos se ignoran.
Cambio visible inevitable para clientes viejos: `resumen.pesoAnteriorKg/diferencia/días/gmd` pasan a calcularse sobre la serie diaria (QA: anterior 355 → 350).
`resumen.totalPesajes` = ACTIVOS; nuevo `resumen.totalAnulados`.
Otros lectores que deben filtrar ACTIVO en 5A.1b (hallazgo): `animalesRepository` (último peso del listado/ficha, `lateral ... limit 1`) y
`cierreRepository` (`max(fecha)` como límite de cierre). Timeline: usa `historial` (no pierde pesajes anulados).

### R2.8 PDF
Resumen/KPIs, gráficas y tabla GMD: solo ACTIVOS (serie diaria). Historial: ACTIVOS + ANULADOS, columna "Estado"; un ANULADO muestra
estado, motivo y fecha de anulación, sin diferencia/días/GMD, sin IDs internos. Nota: "Los pesajes anulados se conservan como registro y no intervienen en los cálculos."

### R2.9 0028 (implementada en 5A.1a, NO aplicada en producción)
`db/agx-business/migrations/0028_animal_pesajes_anulacion.sql` + `_rollback.sql`. Tests: `.tools/__tests__/agxBusiness0028Policy.test.mjs`
(política SQL puro, sin DB) y `.tools/integration/agxBusiness0028Integration.test.mjs` (Docker desechable propio, dentro de
`npm run test:agx-migrations-integration`). El rollback aborta además si `agx.animal_pesajes` tiene cualquier fila, también fuera del runner.
Trigger `BEFORE INSERT OR UPDATE OR DELETE`: INSERT solo ACTIVO;
UPDATE solo ACTIVO → ANULADO con contenido idéntico (pesaje_id, organizacion_id, animal_id, fecha, peso_kg, metodo, origen, actor_cuenta_id,
created_at, client_operation_id, observaciones); ANULADO terminal; DELETE prohibido. Grant UPDATE por columna (5 columnas de anulación).
**Rollback = forward-only en producción**: la precondición del runner exige columnas a borrar en NULL; `estado_registro` NOT NULL lo bloquea
siempre que haya pesajes (verificado). El `_rollback` solo sirve en bases desechables.

### R2.10 Rollout (orden obligatorio)
5A.1a: 0028 + tests + runner → PR → CI → merge a main (sin efecto: nadie usa las columnas). Después: backup prod → bundle `--version 28`
**construido desde main** → aplicar con runner → validar ledger (29 filas, 0028 con checksum de main).
5A.1b: backend (solo con 0028 aplicada) → merge/deploy. 5A.2: frontend online. 5A.3: offline. Nunca aplicar una migración que no esté en main.

---

## 1. Modelo actual (observado en el repo)

### 1.1 `agx.animal_pesajes` (0022 + 0024)

| Columna | Tipo | Notas |
|---|---|---|
| `pesaje_id` | bigserial PK | |
| `organizacion_id` | uuid NOT NULL | |
| `animal_id` | bigint NOT NULL | FK compuesta `(animal_id, organizacion_id)` → `agx.animales` (tenant-safe) |
| `fecha` | date NOT NULL | CHECK `>= 1990-01-01`; "no futura" solo en la app (`hoy` America/Bogota) |
| `peso_kg` | numeric NOT NULL | CHECK `> 0`, `<= 2000`, 1 decimal |
| `metodo` | varchar(12) | CHECK `BASCULA` \| `ESTIMADO` |
| `origen` | varchar(20) | CHECK `REGISTRO_INICIAL` \| `MANUAL` |
| `actor_cuenta_id` | uuid NOT NULL | creador |
| `created_at` | timestamptz default now() | |
| `client_operation_id` | uuid NULL | CHECK obligatorio si `MANUAL`; NULL en `REGISTRO_INICIAL` |
| `observaciones` | text NULL | CHECK no vacía, ≤ 500 |

Índices: `animal_pesajes_un_registro_inicial_idx` (UNIQUE parcial, 1 REGISTRO_INICIAL/animal);
`animal_pesajes_animal_fecha_idx (animal_id, fecha desc, pesaje_id desc)`;
`animal_pesajes_organizacion_id_idx`; `animal_pesajes_org_client_operation_key` UNIQUE
`(organizacion_id, client_operation_id) where not null`.

RLS ENABLE + FORCE; política `animal_pesajes_tenant_isolation` FOR ALL, `app.current_org_id`.
Grants: `agx_app` = **SELECT, INSERT** (+ secuencia). Sin UPDATE, sin DELETE. Sin trigger guard.
No hay estado de registro: **todo pesaje es definitivo y cuenta para cálculos**.

### 1.2 Backend

- `pesajeValidation.validateCreatePesajeBody`: claves permitidas `fecha, pesoKg, metodo, observaciones, clientOperationId`
  (cualquier otra → 400 `FORBIDDEN_FIELDS`, incluida `identidadEsperada`). Fecha: no futura, ≥ 1990. **No compara con nacimiento/ingreso.**
- `pesajesRepository.registrarPesajeIdempotente`: advisory lock `ganaderia_pesaje_create:<org>:<op>`;
  op existente + misma intención (animal, fecha, peso, método, obs) → `yaExistia`; distinta → 409 `CLIENT_OPERATION_ID_REUSED`;
  animal `FOR SHARE`, 404 `ANIMAL_NOT_FOUND`, 409 `ANIMAL_ANULADO`, 409 por cierre (`errorAnimalCerrado`).
- `listPesajesEnTx`: todas las filas ASC `(fecha, pesaje_id)`; la reutiliza timeline.
- `pesajesService.construirHistorialPesajes`: `enriquecerPesajes` + `calcularGananciaAcumulada` → `resumen` + `pesajes`.
- Ruta `/api/ganaderia/animales/:animalId/pesajes`: GET (lectura), POST (`ROLES_OPERACION`: owner/admin/operador), CSRF, tenant de sesión.
- Alta de animal: `REGISTRO_INICIAL` con `fecha = hoy` (fecha de alta).
- `corregirAnimal`: valida nacimiento/ingreso vs `cierre_fecha` y vs reproducción
  (`HISTORIAL_REPRODUCTIVO_FECHA_INCOMPATIBLE`), **no vs pesajes**.

### 1.3 Motor (`shared/ganaderia/engine/`, copia byte a byte en `server/services/ganaderia/engine/`, test de paridad)

- `ordenarPesajes`: por fecha y `pesajeId`.
- `enriquecerPesajes`: cada fila vs la fila anterior (aunque sea el mismo día). `calcularGMD` → null si días ≤ 0.
- `calcularGananciaAcumulada`: primera vs última fila.
- `calcularTendenciaGMD`: últimos 2 periodos con GMD finita.
- `alertasPesajes`: `PESAJE_SIN_REGISTROS`, `PESAJE_ATRASADO` (30/60 provisional), `PERDIDA_DE_PESO` solo si días > 0 y GMD < 0.

### 1.4 Consumidores

- PDF (`reporteProductivoModelo`): resumen del `resumen` API; historial = todas las filas; gráfica peso = todas; tabla GMD = filas con GMD finita; alertas = motor.
- Timeline (`timelineService`): `construirHistorialPesajes().pesajes` → evento `PESAJE_REGISTRADO` por fila.
- Frontend: `HatoPesajesPanel` y compañía consumen `resumen/pesajes` del servidor; `pesajesModel` solo formatea/gráficas.

### 1.5 Offline

- `PESAJE_CREAR`: solo animales ya confirmados (`animalId` numérico); mismo `clientOperationId` siempre;
  **sin `claveOrden` (sin cadena FIFO), sin `origen`/`identidadEsperada`, sin `posibleEnServidor`**.
- Pendientes se muestran aparte; nunca en KPIs/gráficas/alertas/PDF. `descartarPesajePendiente` solo para rechazados.
- **Los pesajes confirmados NO se guardan en IndexedDB** (`ORG_STORES` no tiene store de pesajes). El historial offline no existe.
- Reproducción (4E) ya tiene el patrón completo: `claveOrden` `repro:animal:<id>`, `origen`, `identidadEsperada`,
  `posibleEnServidor`, operaciones administrativas solo sobre eventos confirmados, una por evento (clave outbox), backoff 408/429/5xx, 409→CONFLICTO, 400/403→RECHAZADO.

---

## 2. Problemas confirmados

| Id | Problema | Evidencia |
|---|---|---|
| P1-1 | No hay anulación ni corrección: un pesaje erróneo contamina para siempre último peso, GMD, acumulada, alertas y PDF. | 0022/0024: solo SELECT/INSERT, sin estado. |
| P1-2a | Mismo día: la fila 2 se compara con la 1 (días 0, GMD null) y el **resumen** queda con "peso anterior" del mismo día y GMD null. | `enriquecerPesajes` fila a fila. |
| P1-2b | **Pérdida oculta**: 355 → 340 el mismo día no genera alerta (exige días > 0). | `alertasPesajes` L.~125. |
| P1-2c | GMD implausible: 350 (19/10) → 360 (20/10) da GMD acumulada 10 kg/día sin advertencia. | `calcularGananciaAcumulada`. |
| P1-3 | Fecha no validada contra nacimiento/ingreso, y corregir el animal puede dejar pesajes antes del nacimiento/ingreso. | `pesajeValidation`, `corregirAnimal`. |
| Adicional | Datos existentes pueden ya violar P1-3 (no hubo validación). Requiere auditoría read-only antes de rollout. | — |
| Adicional | `PESAJE_CREAR` sin FIFO/identidad: no puede encadenarse con un ANULAR. | `operationHandlers`, `localRepo`. |

QA PROD AGX-000001 (350 19/10, 355 20/10, 360 20/10) hoy: último 360, anterior **355**, diferencia +5, días 0, GMD **null**;
acumulada 350→360, 1 día, GMD **10 kg/día**; tendencia SIN_DATOS; sin alertas de calidad.

---

## 3. Decisión: anular vs corregir

| Criterio | A. CORREGIR (anula + nuevo enlazado, atómico) | B. ANULAR + registrar nuevo |
|---|---|---|
| Complejidad | Endpoint extra, intent hash, FK `corrige_pesaje_id`, índice 1 corrección, cruce de client ops | Un endpoint; el registro reusa POST actual |
| UX | Un paso "Corregir" | Dos pasos; la UI puede ofrecer "Anular y registrar el correcto" encadenando ambas |
| Offline | CORREGIR pendiente + CREATE pendiente + edición: muchas combinaciones | ANULAR y CREATE en la misma cadena FIFO; combinaciones simples |
| Auditabilidad | Vínculo explícito original→nuevo | Anulación con motivo + nuevo pesaje; sin vínculo formal |
| Reportes | Igual (solo ACTIVOS) | Igual |
| Riesgo | Mayor superficie | Ventana breve sin el peso correcto (derivado, sin máquina de estados) |

En Reproducción CORREGIR existe porque un registro nuevo con fecha retroactiva lo bloquean `FECHA_ANTERIOR_A_HISTORIAL` y
las reglas de transición; **pesajes no tiene esas reglas**: un pesaje nuevo con cualquier fecha válida ya se acepta.

**Recomendación: B en 5A.** La UI guía "Anular y registrar el correcto" (dos operaciones, misma cadena FIFO).
Si 5B exige "Pesaje corregido" con vínculo original/nuevo, se agrega de forma aditiva (0029: `corrige_pesaje_id` + endpoint); 0028 no lo bloquea.

---

## 4. Regla de mismo día

Casos: error de digitación (corrige con anulación), repetición de báscula (dos lecturas, una sobra o ambas válidas),
mañana/tarde (ambas reales; variación por llenado digestivo), duplicado offline (lo evita el `clientOperationId`;
una doble captura humana con ids distintos es un duplicado real), cambio imposible (p.ej. −15 kg en horas), hora no registrada (no hay hora: el orden intra-día es el de registro, `pesaje_id`).

| Opción | Valoración |
|---|---|
| A. múltiples, usar el último | Base correcta para cálculo, pero oculta discrepancias |
| B. permitir + advertir | Necesaria: hace visible el problema |
| C. consolidar (promedio) | Rechazada: produce un peso nunca medido |
| D. exigir motivo | Fricción; offline no puede saber qué hay en el servidor |
| E. bloquear salvo corrección | Rompe mañana/tarde y convierte colas offline en 409 tardíos |

**Política recomendada = A + B, sin bloqueo en servidor:**
1. Se admiten N pesajes ACTIVOS por día (como hoy).
2. **Para cálculos** cada fecha se representa con su **último pesaje ACTIVO registrado** (mayor `pesaje_id`): "serie diaria".
3. Si una fecha tiene ≥ 2 ACTIVOS → alerta `PESAJE_MISMO_DIA` (ver §6) con la diferencia intra-día firmada.
4. UX (no bloqueante): al registrar, si el historial visible ya tiene un ACTIVO en esa fecha, el formulario avisa y sugiere anular el erróneo.
5. El POST puede devolver `advertencias[]` (informativas) calculadas tras el INSERT; nunca 4xx por esto.

## 5. Regla de GMD

- GMD por periodo = entre **días distintos consecutivos** de la serie diaria. Intra-día: diferencia visible, días 0, GMD "—" (nunca 0, nunca ∞).
- Resumen: `ultimoPesoKg` = último ACTIVO; `pesoAnteriorKg` = representante del **día distinto anterior**; diferencia/días/GMD sobre ese periodo.
- Ganancia acumulada = primer día distinto vs último día distinto (representantes). Con un único día → `null` (hoy daba 355→360 con 0 días).
- Calidad del intervalo: `calidadGmd: 'CONCLUYENTE' | 'INTERVALO_CORTO'` si `dias < diasMinimosGmd` (configurable, ver §6).
  El número se conserva (compatibilidad) pero la UI/PDF lo rotula "no concluyente"; la **tendencia solo usa periodos CONCLUYENTES**.
- `PERDIDA_DE_PESO` se evalúa sobre el último periodo de la serie diaria (días > 0), sin cambios de regla.

Pruebas (ids crecientes en orden de registro):

| Caso | Serie diaria | Resultado |
|---|---|---|
| 355 → 360 mismo día (sin previos) | [360] | último 360; anterior null; GMD null; acumulada null; `PESAJE_MISMO_DIA` +5 kg (+1,4 %) INFO |
| 355 → 340 mismo día | [340] | último 340; GMD null; `PESAJE_MISMO_DIA` −15 kg (−4,2 %); si supera umbral → ATENCION "variación atípica" (hoy: oculta) |
| 350 (d1) → 355 (d2) → 360 (d2) | [350, 360] | anterior 350; +10 kg en 1 día; GMD 10 **INTERVALO_CORTO**; acumulada +10/1 día no concluyente; `PESAJE_MISMO_DIA` +5 kg; tendencia SIN_DATOS |

## 6. Plausibilidad

**Validación bloqueante (400)** — solo lo físicamente imposible o fuera de dominio: peso ≤ 0, > 2000, > 1 decimal; fecha futura, < 1990,
< nacimiento/ingreso (§7); método fuera de catálogo. Nada más.

**Alertas de plausibilidad (nunca bloquean)**:

| Código | Disparo | Severidad | Umbral |
|---|---|---|---|
| `PESAJE_MISMO_DIA` | ≥ 2 ACTIVOS en la última fecha | INFO; ATENCION si `|Δ| / peso ≥ pctVariacionIntervaloCorto` | — |
| `PESAJE_VARIACION_ATIPICA` | último periodo con `dias < diasMinimosGmd` y `|Δ|/pesoAnterior ≥ pctVariacionIntervaloCorto` | ATENCION | provisional 5 % |
| `GMD_FUERA_DE_RANGO` | periodo CONCLUYENTE con GMD > `gmdMaxKgDia` o < −`perdidaMaxKgDia` | ATENCION | **desactivado (null)** hasta configuración oficial |

Justificación: un umbral absoluto en kg no escala (ternero 40 kg vs toro 700 kg) → se descarta. En intervalos cortos la variación
por llenado digestivo/merma domina (del orden de pocos % del peso vivo, a validar con el asesor técnico), por eso porcentaje del peso.
kg/día solo tiene sentido en intervalos largos, y no hay umbral oficial → configurable y apagado.
`diasMinimosGmd`: provisional **14** días, **decisión del negocio pendiente** (alternativa: solo rotular sin umbral).
Todos en `CONFIGURACION_PLAUSIBILIDAD_PESAJE` (frozen, motor compartido, mismo patrón que `CONFIGURACION_ALERTAS_PESAJE`); configuración por organización = fase futura, sin tabla en 0028.
Las alertas se evalúan sobre el estado actual (último día/periodo); las filas del historial llevan flags (`mismoDia`, `calidadGmd`) para pintar.

## 7. Validación de fechas

Límite inferior efectivo = `max(1990-01-01, fecha_nacimiento?, fecha_ingreso?)`.
- La DB ya garantiza `fecha_ingreso >= fecha_nacimiento`, así que con ambos prevalece **ingreso**: un pesaje antes de entrar al predio no es de esta operación.
  El peso de compra en origen se registra con `fecha = fecha_ingreso` (igualdad permitida).
- `NACIDO_EN_PREDIO` (ingreso null) → nacimiento. Edad aproximada (sin `fecha_nacimiento`) → solo ingreso/1990.
- Aplica a POST de pesaje (MANUAL). `REGISTRO_INICIAL` ya usa `hoy` (≥ ambas).

| Caso | HTTP | code |
|---|---|---|
| fecha futura / < 1990 / formato | 400 | `INVALID_FECHA` (existente) |
| fecha < nacimiento | 400 | `FECHA_ANTERIOR_A_NACIMIENTO` |
| fecha < ingreso | 400 | `FECHA_ANTERIOR_A_INGRESO` |
| corregir animal: nacimiento nuevo > primer pesaje ACTIVO | 409 | `HISTORIAL_PESAJES_FECHA_INCOMPATIBLE` |
| corregir animal: ingreso nuevo > primer pesaje ACTIVO | 409 | `HISTORIAL_PESAJES_FECHA_INCOMPATIBLE` |

- Fecha vs animal se valida dentro de la transacción con el animal `FOR SHARE` (ya existe), serializado con `corregirAnimal` (`FOR UPDATE`).
- `corregirAnimal`: nuevo `assertCorreccionCompatibleConPesajesEnTx` (gemelo del de reproducción), solo si cambia el campo; `min(fecha)` de ACTIVOS (incluye REGISTRO_INICIAL). Los ANULADOS no restringen.
- Datos existentes que ya violan la regla no se tocan ni bloquean otras ediciones; se cuantifican antes del rollout (§15).
- Offline: 400 → RECHAZADO definitivo (el usuario descarta y registra con fecha válida).

## 8. Migración 0028 (borrador; NO aplicar)

`0028_animal_pesajes_anulacion.sql` — SQL puro, sin `\`, sin metacomandos, sin BEGIN/COMMIT (el runner envuelve), sin variables psql.

```sql
alter table agx.animal_pesajes
  add column estado_registro varchar(10) not null default 'ACTIVO',
  add column anulado_por uuid,
  add column anulado_at timestamptz,
  add column motivo_anulacion text,
  add column anulacion_client_operation_id uuid;

alter table agx.animal_pesajes
  add constraint animal_pesajes_estado_registro_check
    check (estado_registro in ('ACTIVO', 'ANULADO')),
  add constraint animal_pesajes_anulacion_consistency_check check (
    (estado_registro = 'ACTIVO'
      and anulado_por is null and anulado_at is null and motivo_anulacion is null
      and anulacion_client_operation_id is null)
    or (estado_registro = 'ANULADO'
      and anulado_por is not null and anulado_at is not null
      and anulacion_client_operation_id is not null
      and motivo_anulacion is not null and btrim(motivo_anulacion) <> ''
      and char_length(motivo_anulacion) <= 500));

create unique index animal_pesajes_org_anulacion_client_operation_key
  on agx.animal_pesajes (organizacion_id, anulacion_client_operation_id)
  where anulacion_client_operation_id is not null;

-- Guard: sin DELETE; solo ACTIVO -> ANULADO; contenido inmutable; ANULADO terminal.
create or replace function agx.fn_animal_pesajes_guard() returns trigger
  language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'animal_pesajes: el historial de pesajes no admite DELETE' using errcode = 'check_violation';
  end if;
  if old.estado_registro = 'ANULADO' then
    raise exception 'animal_pesajes: un pesaje ANULADO es inmutable' using errcode = 'check_violation';
  end if;
  if new.estado_registro <> 'ANULADO' then
    raise exception 'animal_pesajes: solo se admite ACTIVO -> ANULADO' using errcode = 'check_violation';
  end if;
  if row(new.pesaje_id, new.organizacion_id, new.animal_id, new.fecha, new.peso_kg, new.metodo, new.origen,
         new.actor_cuenta_id, new.created_at, new.client_operation_id, new.observaciones)
     is distinct from
     row(old.pesaje_id, old.organizacion_id, old.animal_id, old.fecha, old.peso_kg, old.metodo, old.origen,
         old.actor_cuenta_id, old.created_at, old.client_operation_id, old.observaciones) then
    raise exception 'animal_pesajes: el contenido del pesaje es inmutable (anular + nuevo pesaje)' using errcode = 'check_violation';
  end if;
  return new;
end
$$;
alter function agx.fn_animal_pesajes_guard() owner to agx_owner;
create trigger animal_pesajes_guard
  before update or delete on agx.animal_pesajes
  for each row execute function agx.fn_animal_pesajes_guard();

grant update (estado_registro, anulado_por, anulado_at, motivo_anulacion, anulacion_client_operation_id)
  on agx.animal_pesajes to agx_app;
-- + comments de tabla/columnas.
```

- Nombres = **los de Reproducción** (0026), no los sugeridos `anulado_por_cuenta_id`/`anulacion_motivo`: mismo patrón de código, tests y trigger.
- Backwards-compatible: `ADD COLUMN ... DEFAULT` constante sin reescritura (PG ≥ 11); filas existentes = ACTIVO; código actual no escribe las columnas nuevas; INSERT actual válido.
- RLS/FORCE y política FOR ALL sin cambios (cubren UPDATE; `WITH CHECK` impide cambiar de org; el trigger también).
- FK tenant-safe: no hay FK nueva (`anulado_por` es cuenta de Postgres-AGX, otra DB, igual que `actor_cuenta_id`).
- Índices de lectura: no se añaden; el historial lee todas las filas del animal por el índice existente y el motor filtra.
- Exclusividad entre `client_operation_id` y `anulacion_client_operation_id`: en la app, bajo el **mismo advisory lock** (se reutiliza la clave actual `ganaderia_pesaje_create:<org>:<op>`, para no cambiarla en un deploy con instancias mezcladas).
- Rollback `0028_..._rollback.sql`: bloque `DO` que aborta si existe algún `ANULADO` (deshacer resucitaría pesajes anulados); luego drop trigger/función, revoke update, drop índice/constraints/columnas.
- Antes del PR: correr el runner (`agx-migrate` audit) sobre el borrador para confirmar que el cuerpo `$$` y `end`/`begin` de plpgsql no disparan `TX_CONTROL` (el lexer quita cuerpos dollar-quoted; 0026 ya lo hace, pero 0026 es histórica).

## 9. API

**GET** `/api/ganaderia/animales/:id/pesajes` (compatible):
```
{ ok, animalId, orden:'ASCENDENTE',
  resumen: { ...igual, calculado SOLO con ACTIVOS y serie diaria,
             calidadGmd, totalPesajes (ACTIVOS), totalAnulados },
  pesajes:   [ ACTIVOS enriquecidos ]            // mismo significado para clientes viejos
  historial: [ ACTIVOS + ANULADOS, ASC, con estadoRegistro, mismoDia, calidadGmd,
               anulacion: { anuladoAt, motivo, anuladoPor } | null ],   // nuevo
  alertasCalidad?: no — las alertas se siguen derivando con el motor en cliente/PDF }
```
Mantener `pesajes` = solo ACTIVOS evita que un frontend en caché (Pages/SW) grafique anulados. `anuladoPor` (uuid de cuenta) se expone solo si 5B lo necesita resuelto a nombre; por defecto se omite.

**POST** `/api/ganaderia/animales/:id/pesajes` — añade `identidadEsperada` opcional (comparada con sesión, 409 `IDENTIDAD_NO_COINCIDE`, como reproducción) y la validación de §7. Respuesta añade `advertencias[]`.

**POST** `/api/ganaderia/animales/:id/pesajes/:pesajeId/anular` — `ROLES_ADMINISTRACION` (owner/admin), CSRF.
Body `{ motivo, clientOperationId, identidadEsperada? }`. Orden: rol → identidad → ids → validación → transacción.

| Situación | Respuesta |
|---|---|
| Nueva anulación | 200 `{ ok, yaExistia:false, pesaje, resumen }` |
| Mismo op + mismo pesaje + mismo motivo | 200 `{ yaExistia:true, ... }` |
| Mismo op con otro pesaje/motivo, u op usado por un CREATE | 409 `CLIENT_OPERATION_ID_REUSED` |
| Pesaje ya ANULADO por otra operación | 409 `PESAJE_YA_ANULADO` |
| Pesaje inexistente / de otro animal / otra org | 404 `PESAJE_NOT_FOUND` |
| Animal inexistente/otra org | 404 `ANIMAL_NOT_FOUND` |
| Animal ANULADO | 409 `ANIMAL_ANULADO` |
| Animal SALIDO/MUERTO | **permitido** (corrección de historia, como reproducción) |
| motivo vacío/> 500 | 400 `INVALID_MOTIVO` |
| rol operador/lector | 403 `ROLE_FORBIDDEN` |

`REGISTRO_INICIAL` también es anulable. Decisión de negocio a confirmar: anulación solo owner/admin (recomendado por la matriz RBAC 3A) vs permitir al operador anular su propio pesaje reciente.

## 10. Offline

Cadena FIFO nueva `pesaje:animal:<animalId>` (independiente de `repro:animal:`), animales distintos independientes.

- **PESAJE_CREAR v2**: las operaciones nuevas llevan `claveOrden`, `origen`, `posibleEnServidor` e `identidadEsperada` (requiere backend 5A.1 desplegado). Las ya encoladas sin esos campos siguen el camino actual (compatibles).
- **PESAJE_ANULAR**: `POST .../pesajes/:pesajeId/anular`, solo con `animalId` y `pesajeId` del servidor; clave outbox determinista por pesaje (una anulación pendiente por pesaje, atómica entre pestañas); rol local `owner/admin` (UX; autoridad = servidor).
  Como los pesajes confirmados no están en IndexedDB, el encolado solo ocurre (a) sobre el historial ya cargado en pantalla cuando se pierde la red, o (b) tras un intento online sin resultado (`fallo` + `posibleEnServidor`, mismo id), igual que reproducción 4E.2B. Cachear pesajes confirmados = fuera de alcance (posible 5A.4).
- Clasificación (motor existente): red/408/429/5xx → reintentable con backoff, corta la cadena; 200 (nuevo o `yaExistia`) → confirmado; 409 `PESAJE_YA_ANULADO`/`CLIENT_OPERATION_ID_REUSED`, 404 → CONFLICTO (se conserva); 409 `IDENTIDAD_NO_COINCIDE` → bloqueada por identidad; 400 → RECHAZADO; 403 → RECHAZADO conservando `posibleEnServidor`. Un envío por cadena a la vez (sin bursts).
- Reconciliación exacta: el reintento con el mismo `clientOperationId` devuelve 200 `yaExistia` (respuesta perdida / carrera); un 409 `PESAJE_YA_ANULADO` solo aparece si anuló **otra** operación → conflicto real.
- **CREATE offline → ANULAR antes de sincronizar**: no existe ANULAR sobre algo sin `pesajeId`. Si el CREATE no tiene `posibleEnServidor` → **cancelar pendiente** (nuevo `cancelarPesajePendiente`, misma cuenta, se elimina del outbox, nada llega al servidor). Si tiene `posibleEnServidor` → no se cancela: "pudo registrarse; podrás anularlo cuando se confirme". Operaciones antiguas sin el campo y con `intentos > 0` se tratan como inciertas.
- **CREATE offline → CORREGIR antes de sincronizar**: sin CORREGIR (decisión §3). Editar el pendiente = cancelar + nuevo con `clientOperationId` nuevo, solo si no `posibleEnServidor`.
- "Anular y registrar el correcto" offline: ANULAR + CREATE en la misma cadena; si ANULAR queda en CONFLICTO, la cadena se detiene y el CREATE no sale hasta resolver.

## 11. Motor (una sola implementación)

En `shared/ganaderia/engine/pesajes.js` (+ copia byte a byte, paridad):
- `separarPesajes(rows)` → `{ activos, anulados }` (fila sin `estadoRegistro` = ACTIVO: compatibilidad).
- `serieDiaria(activos)` → último ACTIVO por fecha.
- `enriquecerHistorial(rows)` → todas las filas; ACTIVOS con derivaciones vs ACTIVO anterior (intra-día: `mismoDia:true`, días 0, GMD null); ANULADOS sin derivaciones.
- `resumenPesajes(rows, conf)` → resumen desde serie diaria (§5), `calidadGmd`.
- `calcularGananciaAcumulada` / `calcularTendenciaGMD` sobre serie diaria; tendencia solo CONCLUYENTE.
- `alertasPesajes`: recibe el resumen/serie (nunca filas ANULADAS) + nuevos códigos §6.
`pesajesService.construirHistorialPesajes` solo orquesta; PDF, timeline y UI consumen su salida. Ninguna derivación fuera del motor.

## 12. PDF

- Resumen, gráfica de peso, tabla GMD y alertas: solo ACTIVOS / serie diaria; GMD de intervalo corto rotulada "no concluyente".
- Historial: todas las filas; ANULADAS con columna "Estado" = ANULADO, motivo y fecha de anulación, sin diferencia/días/GMD; nota al pie: "Los pesajes anulados se conservan como registro y no intervienen en los cálculos."
- `detalleAlerta` del PDF para `PESAJE_MISMO_DIA` y `PESAJE_VARIACION_ATIPICA`.

## 13. Escenarios QA (AGX-000001: 350 19/10, 355 20/10, 360 20/10 — solo simulación, NO modificar)

| Escenario | Último | Anterior | Δ / días | GMD | Acumulada | Alertas |
|---|---|---|---|---|---|---|
| Actual (código hoy) | 360 | 355 | +5 / 0 | null | +10 / 1 d, 10 kg/d | ninguna de calidad |
| 5A, ambos activos | 360 | 350 | +10 / 1 | 10 INTERVALO_CORTO | +10 / 1 d, no concluyente | `PESAJE_MISMO_DIA` +5 kg (1,4 %) INFO |
| Anular 355 | 360 | 350 | +10 / 1 | 10 INTERVALO_CORTO | ídem | — |
| Anular 360 | 355 | 350 | +5 / 1 | 5 INTERVALO_CORTO | +5 / 1 d | — |
| Anular 360 + registrar 357 (20/10) | 357 | 350 | +7 / 1 | 7 INTERVALO_CORTO | +7 / 1 d | `PESAJE_MISMO_DIA` (355 y 357 activos) → muestra que si 355 también sobra, hay que anularlo |

Ninguna variación supera 5 % del peso → sin `PESAJE_VARIACION_ATIPICA`; la absurdidad está en la GMD, que queda rotulada.

## 14. Tests mínimos

Unit (motor, `test:node`): serie diaria; mismo día positivo/pérdida; 350→355→360; ANULADO excluido de último/GMD/acumulada/tendencia/alertas; fila sin `estadoRegistro` = ACTIVO; calidad GMD; umbrales configurables y desactivados; paridad shared↔server.
Validación/ruta (auth tests): anular sin rol 403; CSRF; `organizacionId` en body 400; `identidadEsperada` distinta 409 sin escribir; motivo inválido 400; fecha < nacimiento / < ingreso 400.
Integración Business DB (desechable): anulación idempotente (mismo op 200 yaExistia); mismo op otro motivo/pesaje 409; doble anulación otra op 409 `PESAJE_YA_ANULADO`; op cruzado CREATE↔ANULAR 409; cross-tenant 404 y RLS (UPDATE de otra org afecta 0 filas); trigger: DELETE, re-UPDATE de ANULADO, cambio de `peso_kg` → error también como `agx_owner`; `agx_app` sin UPDATE de otras columnas (grant por columna); corregir animal con nacimiento/ingreso > primer ACTIVO 409; mismo caso con el pesaje ANULADO → permitido; concurrencia anular vs anular (advisory lock), corregirAnimal vs POST pesaje.
PDF: resumen sin anulado; historial con fila ANULADO y nota.
Timeline: el pesaje anulado sigue apareciendo (sin pérdida de auditoría) y las derivaciones de los activos son las del motor.
Offline (`offline/__tests__`): CREATE+ANULAR FIFO; animales distintos independientes; cancelar pendiente sin/con `posibleEnServidor`; retries 408/429/5xx con backoff; respuesta perdida → 200 yaExistia → confirmado; 409 → CONFLICTO detiene cadena; 400/403 definitivos; op legado sin `claveOrden` sigue sincronizando.
Migración: runner audit de 0028 y rollback (sin `\`, sin metacomandos, sin TX control); 0028 sobre DB con datos 0027 → filas ACTIVO; rollback aborta con ANULADO.

## 15. Rollout

Restricción: merge a main despliega Railway y Pages a la vez, sin ventana garantizada.

0. **Auditoría read-only en prod** (autorización aparte): conteos agregados, sin datos personales — grupos mismo día, pesajes < nacimiento, < ingreso, periodos < 14 días.
1. **5A.1 DB + backend**: aplicar 0028 en prod por el runner **antes** del merge (el código viejo ignora columnas; INSERT sigue válido). Luego merge del backend: GET compatible (`pesajes` = ACTIVOS, `historial` nuevo), endpoint anular, validación de fechas, guard en `corregirAnimal`, motor nuevo (cambia el `resumen` mostrado por la UI vieja: corrección esperada), `identidadEsperada` opcional aceptada. Verificar en prod con QA sin tocar AGX-000001 hasta autorización.
2. **5A.2 frontend online**: historial con ANULADO, acción "Anular" (owner/admin), "Anular y registrar el correcto", avisos mismo día/calidad GMD, nuevas alertas, mapeo de errores. Solo tras 5A.1 desplegado.
3. **5A.3 offline**: PESAJE_CREAR v2 (cadena, identidad), PESAJE_ANULAR, cancelar pendiente. Solo tras 5A.1 (si no, `identidadEsperada` → 400 `FORBIDDEN_FIELDS` = RECHAZADO definitivo de pesajes reales).
4. 5B: timeline "Pesaje anulado" (datos ya disponibles en `historial`).

## 16. Riesgos

- `identidadEsperada` enviada antes de que el backend la acepte → rechazos definitivos. Mitigación: orden 5A.1 → 5A.3 estricto.
- Cambio de valores en resumen/PDF (peso anterior, acumulada) percibido como "dato distinto". Mitigación: nota de versión; es la corrección de P1-2.
- Datos históricos que violan §7: no se bloquean, pero quedan visibles como incoherentes; requiere decisión (anular manualmente con autorización).
- Umbrales provisionales (5 %, 14 días) sin validación agronómica. Mitigación: configurables, solo advertencia, GMD fuera de rango apagado.
- Trigger también aplica a `agx_owner`: un mantenimiento futuro necesita deshabilitarlo explícitamente (intencional).
- Rollback de 0028 imposible tras la primera anulación (bloqueado por diseño).
- Sin store de pesajes en IndexedDB, la anulación offline es limitada; documentarlo en la UI.
- Integración Business DB no corre en CI: evidencia manual con DB desechable obligatoria.
- Timeline: si se filtra a ACTIVOS por error, se pierde auditoría visible; test explícito.

## 17. PRs propuestos

1. **PR 5A.1a — 0028 + rollback + tests de esquema/runner** (sin código de app). Ningún código la usa todavía, así que se puede mergear y aplicar en prod antes de 5A.1b sin riesgo (el auto-deploy no cambia comportamiento).
2. **PR 5A.1b — backend**: motor (shared + copia), servicio, repositorio anular, ruta, validación de fechas, `corregirAnimal`, PDF, timeline compatible, tests unit/auth/integración. Merge solo con 0028 aplicada en prod.
3. **PR 5A.2 — frontend online**.
4. **PR 5A.3 — offline** (PESAJE_CREAR v2, PESAJE_ANULAR, cancelar pendiente).

## 18. Veredicto del diseño

**GO con WARN** para iniciar 5A.1. WARN por: umbrales provisionales (§6) y rol de anulación (§9) pendientes de decisión de negocio, auditoría read-only de datos prod (§15.0) pendiente de autorización, y validación del runner sobre el borrador 0028.
