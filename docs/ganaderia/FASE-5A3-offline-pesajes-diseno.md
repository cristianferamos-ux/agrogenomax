# FASE 5A.3 — Pesajes offline (diseño)

Estado: diseño aprobado con ajustes (2026-11-18). Base: `main` = `7a7ee4d`.
Rollout aprobado en tres PRs: **5A.3a** backend sync → **5A.3b** motor offline/IndexedDB/outbox → **5A.3c** UI offline.

Prerrequisitos en producción: 0028 aplicada, 5A.1b (backend anulación + `identidadEsperada` en ambos POST) y 5A.2 (UI online) desplegados.

---

## 1. Arquitectura offline actual (observada en el repo)

- **Outbox** (`src/modules/ganaderia/offline/outbox.js`): genérico; estados PENDIENTE / SINCRONIZANDO / ERROR_REINTENTABLE /
  CONFLICTO / RECHAZADO / BLOQUEADA_POR_IDENTIDAD; campos 4E.1 `claveOrden`, `origen`, `posibleEnServidor`, `runtimeNoSoporta`.
- **syncEngine**: PUSH y luego PULL (`/sync/pull` + `/sync/reproduccion`, cursores independientes). Solo las operaciones con
  `claveOrden` tienen FIFO estricto, reclamo atómico (`transicionarOperacion`), `posibleEnServidor=true` persistido antes del
  POST y verificación `GET /auth/session` antes de cada envío.
- **Backoff** (semántica aprobada): status 0 → red, sin backoff exponencial; 408/429/5xx → backoff; 404/409/410 → CONFLICTO;
  400/403 → RECHAZADO; `estaLista` impide que un sync forzado ("Sincronizar ahora") salte un backoff HTTP.
- **Web Locks**: lock por organización (`createNavigatorLock`) compartido entre pestañas y Service Worker.
- **Service Worker**: `swSyncEntry.js` → `dist/agx-offline-sync.js` (importScripts); mismo motor y handlers. `CACHE_VERSION` v21.
- **autoSync**: `online`, `visibilitychange→visible`, Background Sync, cambios del repo (debounce).

### Flujo actual de `PESAJE_CREAR`

`HatoPesajesPanel` (sin red) → `repo.registrarPesajeLocal` (solo `animalId` del servidor; dedupe por `clientOperationId`) →
`newOperation` **sin `claveOrden`, sin `origen`, sin `posibleEnServidor`**, `localUuid` propio → handler
`POST /animales/:id/pesajes` (`cuerpoPesaje`, **sin `identidadEsperada`**) → 201 / 200 `yaExistia` →
`confirmarPesajeCreado` elimina la operación → el panel detecta la desaparición y recarga el GET online.

## 2. Huecos

| # | Hueco |
|---|---|
| H1 | `PESAJE_CREAR` sin cadena FIFO, sin `origen`/identidad, sin `posibleEnServidor`. Otra cuenta podría enviar operaciones ajenas. |
| H2 | Los pesajes confirmados no están en IndexedDB: sin red no hay historial. |
| H3 | Último peso local siempre obsoleto: `/sync/pull` filtra por `animales.updated_at` y crear/anular pesaje no lo toca (sin trigger). Afecta también a CREATE. |
| H4 | No hay cancelación segura de un CREATE pendiente nunca enviado (`descartarPesajePendiente` solo CONFLICTO/RECHAZADO). |
| H5 | Operaciones legacy sin `posibleEnServidor`; un fallo de red no incrementa `intentos`. |
| H6 | `registrarPesajeLocal` no valida `puedeEncolar` (solo la UI). |
| H7 | El GET público no expone `clientOperationId` / `anulacionClientOperationId` (correcto; no debe cambiar). |

## 3. Modelo `PESAJE_ANULAR`

- payload `{ animalId, pesajeId, motivo }` (motivo con `normalizarMotivo`, misma normalización que el servidor).
- Metadatos fuera del payload: `operationId`, `clientOperationId`, `claveOrden`, `origen`, `posibleEnServidor`, `estado`,
  `intentos`, `siguienteIntentoAt`, `ultimoError`, `createdAt`, `deviceId`, `runtimeNoSoporta`.
- **Sin actor del cliente**: `anulado_por` y `anulado_at` los decide el backend.
- Clave determinista del outbox `pesaje-anular:<pesajeId>` creada con `storage.mutate` atómico → una anulación pendiente por
  pesaje, también entre pestañas.
- Request `POST /animales/:a/pesajes/:p/anular` con `{ motivo, clientOperationId, identidadEsperada: origen }`; solo con
  `animalId` y `pesajeId` del servidor (si no, `request()` → `null`).
- RBAC: `CAPACIDAD_OPERACION_OFFLINE.PESAJE_ANULAR = 'anularPesaje'`, validado también en el repo.

## 4. FIFO

- Cadena única `pesaje:animal:<animalId>` para PESAJE_CREAR v2 y PESAJE_ANULAR (independiente de `repro:animal:`).
- Animales distintos sincronizan independientes; mismo animal FIFO estricto (`cadenasDetenidas`). CONFLICTO/RECHAZADO detienen la
  cadena (igual que 4E.2). `instanteEnCadena` protege contra relojes que retroceden.

## 5. CREATE pendiente + ANULAR

**Caso A — CREATE seguro no enviado** (`origen` presente, `posibleEnServidor === false`, estado ≠ SINCRONIZANDO): nuevo
`cancelarPesajePendiente` (mutate atómico, misma cuenta). Se trata como operación **nunca materializada**: se elimina del outbox sin
evidencia en stores de negocio (el servidor nunca la vio; el `clientOperationId` es un UUID que no se reutiliza). 0 POST.

**Caso B — CREATE con `posibleEnServidor = true`**: nunca se cancela localmente. ANULAR **diferido** en la misma cadena:
`payload { animalId, pesajeRef: { clientOperationId }, motivo }`; `request()` → `null` hasta resolver `pesajeId` desde el store
local `pesajes` (índice `clientOperationId`, alimentado por la confirmación del CREATE o por `/sync/pesajes`). El FIFO garantiza
que el CREATE se reconcilia primero. Si el CREATE acaba en RECHAZADO definitivo (400), el pesaje no existe y el ANULAR diferido,
que nunca salió, puede cancelarse.

### Ajuste obligatorio — CREATE legacy

Un `PESAJE_CREAR` legacy **sin `origen` ni `posibleEnServidor` es INCIERTO**, siempre:

- nunca se cancela como "seguro" ni se asume que no llegó;
- nunca se le inventa identidad (`origen`);
- `intentos = 0` **no** es evidencia suficiente (un fallo de red no incrementa `intentos`);
- si una anulación futura depende de ese CREATE, primero debe confirmarse el pesaje en el servidor / store local (ANULAR diferido
  con `pesajeRef`, o bloqueo en UI "podrás anularlo cuando se confirme").

Las operaciones legacy siguen el camino actual sin cadena (siguen sincronizando).

## 6. Pesaje confirmado + ANULAR offline

| Estado visible | Condición |
|---|---|
| ACTIVO | confirmado sin operación pendiente |
| ANULACION_PENDIENTE | ACTIVO confirmado + `PESAJE_ANULAR` en curso → "Anulación pendiente de sincronizar." |
| ANULACION_BLOQUEADA | ANULAR en CONFLICTO / RECHAZADO / BLOQUEADA_POR_IDENTIDAD (con motivo) |
| ANULADO | solo cuando el servidor lo confirma (respuesta del POST o pull) |

## 7. Reconciliación exacta

- Principal: reenvío con el mismo `clientOperationId` → 200 `yaExistia` solo si coinciden `pesaje_id`, `animal_id` y
  `motivo_anulacion` (backend `anularPesajeIdempotente`); si no, 409 `CLIENT_OPERATION_ID_REUSED`.
- `onSuccess` defensivo: `pesaje.pesajeId === payload.pesajeId`, `estadoRegistro === 'ANULADO'`, `anulacion.motivo === payload.motivo`;
  si no → CONFLICTO.
- Secundaria: `/sync/pesajes` expone `clientOperationId` y `anulacionClientOperationId` (solo ahí). Una operación incierta se cierra
  sin POST si `anulacionClientOperationId` es exactamente el suyo, con `pesajeId`, `animalId`, `estadoRegistro = ANULADO` y motivo
  coincidentes, y las mismas condiciones de identidad que `reproduccionConciliacionAdmin`. Una anulación hecha por **otra**
  operación nunca cierra una pendiente distinta (→ el POST dará 409 `PESAJE_YA_ANULADO` → CONFLICTO).
- `CODIGOS_SIN_REINTENTO` += `PESAJE_YA_ANULADO`, `PESAJE_NOT_FOUND`.

## 8. Identidad

CREATE v2 y ANULAR llevan `origen` y viajan con `identidadEsperada`. El motor reutiliza la verificación 4E (sesión ≠ origen →
BLOQUEADA_POR_IDENTIDAD sin POST; 409 `IDENTIDAD_NO_COINCIDE` igual). Cancelar / reintentar: solo la cuenta de origen.

## 9. Backoff

Sin código nuevo: misma ruta `push`. Solo mensajes de pesaje para 409 `PESAJE_YA_ANULADO` / `PESAJE_NOT_FOUND` / identidad.

## 10. Multitab

Web Lock por organización + reclamo atómico. Dos fichas del mismo animal: clave determinista `pesaje-anular:<id>` + dedupe por
`clientOperationId`. El outbox persiste en IndexedDB (cerrar/reabrir).

## 11. Último peso local

Derivado del store `pesajes`: ACTIVO confirmados menos los que tienen ANULAR pendiente, orden `fecha desc, pesaje_id desc`
(mismo que el `lateral` de `animalesRepository`), reutilizando `shared/ganaderia/engine/pesajes.js`. Los CREATE pendientes se
muestran aparte con etiqueta "pendiente"; KPIs, GMD, alertas y PDF siguen solo con confirmados. Ejemplo 205 + 200 ACTIVO, ANULAR
205 offline → último local = 200 (incluye anulación pendiente). Respaldo: `animal.ultimoPeso` si el animal aún no tiene copia
completa. No se toca `animales.updated_at`. Corrige H3 también para CREATE.

## 12. IndexedDB (5A.3b)

`ORG_DB_VERSION` 3, aditivo: store `pesajes` (keyPath `pesajeId`; índices `animalId`, `clientOperationId`,
`anulacionClientOperationId`); `meta` += `pesajesCursor`, `pesajesSyncAt`, `pesajesListaAt`, `pesajesUltimoError`. Mismo nombre de
base (outbox v2 intacto). Pestaña antigua → `VersionError` (`esBaseMasNueva`). Purga con la base de la organización.

## 13. UI offline (5A.3c)

Online: flujo 5A.2. Offline: historial desde el store local; owner/admin pueden anular si hay copia. "Anulación pendiente de
sincronizar." ≠ "Anulado". "Cancelar anulación" solo si `posibleEnServidor = false` y no SINCRONIZANDO.

## 14. PDF

Server-side, requiere conexión (botón deshabilitado offline). Nunca se genera desde estado local pendiente.

## 15. Endpoint `GET /api/ganaderia/sync/pesajes` (5A.3a)

Solo lectura, sin migración. Mismo patrón que `/sync/reproduccion` (sesión + CSRF middleware, RLS FORCE, `Cache-Control: no-store`).

### Ajuste obligatorio — cursor con orden total

- `marcaCambio = coalesce(anulado_at, created_at)` (la fila solo se crea o pasa ACTIVO → ANULADO; nunca se borra).
- Orden y paginación por el par **(marcaCambio, pesaje_id)**: `ORDER BY marcaCambio ASC, pesaje_id ASC`; la página siguiente
  empieza estrictamente después del último par entregado (`(marca, id) > (m, i)`).
- Varias filas con exactamente el mismo instante no se pierden (probado).
- El solape de 5 min se conserva solo como defensa adicional entre recorridos; el cliente deduplica por `pesajeId`.
- Cursor opaco, versionado (`v`), con ámbito (`s='pesajes'`) y ligado a la organización de la sesión (`o`); cualquier
  inconsistencia → 400 `INVALID_CURSOR` determinista.

El contrato y el formato exactos se documentan en el código (`server/services/ganaderia/pesajesSyncRepository.js`).

### Performance medida (5A.3a, Postgres/PostGIS 16 desechable, `agx_app` + RLS, página 501)

| Pesajes en la organización | Página inicial | Continuación | Incremental (0 filas) | Totales | Plan |
|---|---|---|---|---|---|
| 1k | ~3 ms | ~2 ms | ~0,5 ms | ~0,6 ms | Seq Scan |
| 10k | ~6 ms | ~6 ms | ~1 ms | ~2 ms | Index Scan `organizacion_id` |
| 50k | ~35 ms | ~31 ms | ~25 ms | ~31 ms | Seq Scan |

Decisión: **sin índice nuevo y sin 0029** en 5A.3a. Punto abierto: volver a medir con volumen real de producción; si aparece
coste relevante, evaluar un índice de expresión `(organizacion_id, coalesce(anulado_at, created_at), pesaje_id)` en una
migración propia, con evidencia.

## 16. E2E (5A.3b / 5A.3c)

A CREATE offline → 1 POST. B ANULAR confirmado offline → 0 POST sin red, 1 al reconectar → ANULADO. C CREATE nunca enviado + ANULAR
→ cancelación local, 0 POST. D CREATE `posibleEnServidor` + ANULAR → reconciliar CREATE y luego ANULAR. E doble clic → una intención.
F dos pestañas → un POST. G 408/429/5xx → backoff. H manual durante backoff → 0 burst. I 400 → RECHAZADO. J 409 → CONFLICTO
determinista. K identidad distinta → bloqueada. L cerrar/reabrir → persiste. M último peso recalculado con anulación pendiente.
N reconexión con pestaña oculta (documentado: `online` dispara aunque esté oculta; Background Sync en Chromium; lock = un motor).
O `visibilitychange` → sync correcto. Extra: CREATE legacy sigue sincronizando; runtime antiguo conserva `PESAJE_ANULAR`.

## 17. Service Worker

Cambia `agx-offline-sync.js` (handlers) → `CACHE_VERSION` v22 en 5A.3b. Runtime antiguo: `PESAJE_ANULAR` → `runtimeNoSoporta`
conservado; CREATE v2 sale sin `identidadEsperada` (válido) y la verificación de identidad del motor es genérica.

## 18. Rollout / PRs

1. **5A.3a** — `/sync/pesajes` + tests auth/integración Postgres. Sin migración: seguro con auto-deploy. Primero.
2. **5A.3b** — IndexedDB v3, store `pesajes`, `pullPesajes`, CREATE v2, ANULAR (handler + repo), conciliación, `puedeEncolar`,
   derivación de último peso, SW v22. Sin UI nueva que encole ANULAR.
3. **5A.3c** — UI offline, estados, último peso en ficha/lista, E2E Chrome real.

## 19. Riesgos

- Volumen de `/sync/pesajes` en organizaciones grandes (medido en 5A.3a; índice solo con evidencia, nunca en 5A.3a).
- Operación legacy mal clasificada como segura → duplicado (mitigado: legacy siempre incierta).
- Upgrade v3 bloqueado por pestaña antigua (mitigado con `onversionchange`).
- Complejidad del ANULAR diferido (alternativa: bloquear en UI hasta confirmación).
- Divergencia del último peso entre vistas: una única función derivada.
- QA productiva solo sobre "QA 5A2 TEMP" con pesaje temporal autorizado; **nunca AGX-000001**.
