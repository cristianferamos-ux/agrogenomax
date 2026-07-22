# ADR-013: Clasificación de rutas y entregables de CatastroX

- **Estado**: Aceptada
- **Fecha**: 2026-07-18
- **Responsables**: Equipo técnico AgroGenomaX / CRH Soluciones Integrales S.A.S.

## Precedencia y estado vigente

ADR-013 continúa vigente como modelo objetivo de orders/payments/entitlements/artifacts. `full-result` continúa existiendo como ruta heredada en el código y debe deprecarse/retirarse conforme a este ADR. La implementación física de orders, entitlements, artifacts, tokens/cookies y generación server-side sigue pendiente. ADR-006 condiciona la migración de PostGIS. ADR-011 gobierna ECS. ADR-012 gobierna health y operación. ADR-014 gobierna demo/staging/producción. Demo no participa en orders, payments, entitlements ni artifacts reales. Staging usa Wompi sandbox y datos sintéticos o anonimizados.

## 1. Contexto

CatastroX es el módulo comercial público de AgroGenomaX: un usuario consulta un predio, recibe un diagnóstico gratuito limitado, y puede comprar uno de tres paquetes automáticos que generan entregables (PDF, KML, KMZ, SHP, DXF, coordenadas EPSG:9377) a partir de datos catastrales/geoespaciales servidos por PostgreSQL/PostGIS. ADR-005 estableció que CatastroX opera como "producto comercial público" y que la compra pública no requiere login, pero sí controles transaccionales (firma, límite de tasa, trazabilidad, no reutilización, validación server-side) — controles que ADR-005 dejó pendientes de diseño. ADR-007 identificó que `full-result` **hoy no verifica pago**, y dejó explícitamente abierto un conjunto de piezas candidatas (token de intercambio, entitlement, token temporal) para resolver en "un ADR de seguimiento específico de autorización transaccional de CatastroX" (ADR-007 §11.2/§20) — este documento es ese ADR de seguimiento, registrado como ADR-013 por ADR-011 (§Contexto).

Esta versión final corrige, sobre una ronda de corrección previa de este mismo documento, dos precisiones adicionales: (1) Regularización Predial CRH queda excluida por completo del catálogo transaccional (`product`/`price_snapshot`/`order_item`/`entitlement`/`artifact`) y se modela como servicio profesional de cotización, representado por una entidad de lead independiente; (2) el ciclo de generación de artifacts queda cerrado de forma inequívoca — la generación inicial de todos los formatos obligatorios de un paquete se dispara automáticamente al confirmar el pago y crear el entitlement, nunca por una llamada del navegador; `POST /orders/:id/artifacts` deja de ser el camino de primera generación y pasa a ser exclusivamente un mecanismo de regeneración/reintento controlado.

## 2. Problema

La investigación de código confirma que **todas las rutas de CatastroX son públicas hoy, sin excepción** — incluida `GET /api/catastrox/lookups/:lookupId/full-result`, que devuelve el resultado catastral completo sin verificar pago. El "derecho de descarga" que hoy desbloquea los generadores de PDF/KML/KMZ/SHP/DXF en el frontend es una entrada en `localStorage`, no un estado verificable en el servidor. Más grave aún: **incluso si se verificara el pago, el diseño original seguía siendo insuficiente**, porque el payload de `full-result` es universal — contiene todos los datos necesarios para generar los seis formatos, sin importar qué paquete se compró. Un usuario técnico con ese payload puede ejecutar directamente los generadores existentes de `catastroxDeliverables.js` y fabricar formatos de un paquete superior al que pagó; ninguna validación de frontend puede impedirlo después de haber entregado los insumos completos. Este ADR corrige ambos problemas: la ausencia de verificación de pago, y la entrega de un payload universal que hace irrelevante cualquier control posterior — y cierra, en esta versión final, cualquier ambigüedad sobre cuándo y cómo se generan los artifacts, y sobre qué es y qué no es un producto transaccional.

## 3. Estado actual verificado

*(Verificación de código realizada mediante lectura completa de los archivos citados.)*

### 3.1 Backend — `server/routes/catastrox.js` (lookup catastral, sin autenticación)

Router montado en `/api/catastrox` (`server/index.js:53`). Ninguna ruta tiene middleware de autenticación/autorización.

| Ruta | Qué hace | Fuente | Escribe datos |
|---|---|---|---|
| `POST /lookup` | Recibe `lat`/`lng`; consulta `gis.catastro_caqueta` (legacy), enriquece con `catastrox_clean.v_predios_enriquecidos`/`gis.municipios_colombia` (`catastrox.js:871-939`); fallback `findCleanPredioByPoint` sobre `catastrox_clean.predios` (`catastrox.js:635-685`); sin match, 404 clasificado (`resolveCoverageStatus`, `catastrox.js:511-594`) | PostGIS | No — solo `Map` en memoria (`lookupPreviewStore`, `catastrox.js:17,32-40`) |
| `POST /lookup-by-code` | Valida código predial, rate limit en memoria (30 req/10 min/IP, `catastrox.js:14-16,109-127`), consulta `catastrox_clean.predios` | PostGIS | No |
| `GET /lookups/:lookupId/preview-map` | SVG simplificado (TTL 30 min, `catastrox.js:14,53-61`) | Memoria + PostGIS | No |
| `GET /lookups/:lookupId/preview-geometry` | GeoJSON simplificado equivalente | Memoria + PostGIS | No |
| `GET /lookups/:lookupId/full-result` | **Resultado completo universal** (área, perímetro, geometría de precisión, construcciones) — `catastrox.js:1352-1661,1663-1681` | PostGIS | No |
| `GET /audit/lookups/:lookupId/full-result` | Gateada por `CATASTROX_AUDIT_DOWNLOADS=true` + `isLocalAuditRequest` (headers falsificables, `catastrox.js:76-81`) | PostGIS | No |
| `POST /advanced/lookup` | Gateada por `CATASTROX_ADVANCED_LOOKUP_ENABLED=true` + `isLocalAuditRequest` | PostGIS | No |
| `GET`/`DELETE /audit/resolver-shadow` | Telemetría de modo sombra, gateada por `isLocalSocketRequest` (IP de socket, robusta) | Memoria | No |

**No existe ninguna tabla de órdenes, pagos o entitlements.**

### 3.2 Backend — `server/routes/catastroxPayments.js` (pagos, sin autenticación)

- `POST /checkout` (`catastroxPayments.js:165-265`): `ALLOWED_PACKAGES` fijo en backend — `{basico: 3990000, plus: 4990000, profesional: 5990000}` centavos = **COP 39.900 / 49.900 / 59.900** (`catastroxPayments.js:12-16`). Monto/moneda no se aceptan del cliente. `reference` aleatoria por llamada (`catastroxPayments.js:52`), firma de integridad saliente SHA-256 (`catastroxPayments.js:60-63`).
- `GET /verify/:transactionId` (`catastroxPayments.js:118-163`): **hoy modelada como `GET`** — hallazgo que este ADR corrige (§14).
- **Webhook**: **NO EXISTE.**
- **Idempotencia**: **NO EXISTE.**
- **Ambiente**: hardcodeado a sandbox (`pub_test_...`, `catastroxPayments.js:216-222`); `WOMPI_ENV` documentada pero **no leída en ningún punto del código** (variable muerta); no existe llave de producción en el repositorio.

### 3.3 Frontend — dónde vive el "derecho de compra" hoy

`window.localStorage`, clave `catastrox_purchases_v2` (`catastroxPaymentService.js:3,133-147`) — **única fuente de "esta compra está pagada"**, sin contraparte en el servidor. `startPackageCheckout`/`CatastroXWompiReturnPage.jsx`/`CatastroXWompiVerifyPage.jsx` sí llaman `verifyWompiTransaction` (que golpea el backend, que golpea Wompi) antes de marcar pagado, pero el resultado de esa verificación no se persiste server-side. **`full-result` no verifica nada de esto** — es pública, y devuelve el payload universal descrito en §2, no un subconjunto autorizado por producto.

### 3.4 Generación de entregables — 100% client-side hoy, con payload universal como insumo

`src/modules/catastrox/utils/catastroxDeliverables.js` (4545 líneas): toda la generación ocurre en el navegador, sin librerías de terceros (PDF construido byte a byte, `catastroxDeliverables.js:865`); `downloadKml`/`downloadKmz`/`downloadShpZip`/`downloadDxf`/`downloadCoordinatesZip` (líneas 4439-4487) en JS puro. **Este archivo se conserva como activo técnico existente en esta ronda** — no se elimina ni se modifica como parte de este ADR; puede servir de referencia para portar su lógica a una frontera server-side, y puede permanecer disponible para demo o pruebas claramente marcadas como tales, pero **deja de ser, por decisión de este ADR, la frontera definitiva de generación productiva paga** (§11).

### 3.5 Cloudflare — relay con CORS reflejado

`functions/api/catastrox/[[path]].js` y `functions/api/catastrox/payments/[[path]].js` (idénticos): **`Access-Control-Allow-Origin` refleja automáticamente cualquier `Origin` entrante, o `'*'` si no viene Origin** (línea 11-12 de ambos) — sin whitelist. Hallazgo confirmado, corregido en §21.

### 3.6 Autenticación — ausente en todo CatastroX

Confirmado: sin middleware de autenticación real en `server/`; únicos controles son `isLocalAuditRequest` (débil) e `isLocalSocketRequest` (robusta, no aplicada a pagos ni a `full-result`).

### 3.7 Catálogo comercial transaccional — oficial y aprobado, sin contradicción pendiente

**El catálogo comercial transaccional oficial de CatastroX es el verificado en código**, y queda declarado aprobado en su totalidad — no existe ya una contradicción pendiente de resolver:

| packageId | Nombre | Precio COP | Formatos |
|---|---|---:|---|
| `basico` | Paquete Básico | 39.900 | `pdf` |
| `plus` | Paquete Plus | 49.900 | `pdf`, `kml`, `kmz` |
| `profesional` | Paquete Profesional | 59.900 | `pdf`, `kml`, `kmz`, `shp`, `dxf`, `coords9377` |

**Los precios COP 36.000 y COP 60.000 no están aprobados, no aparecen en ningún archivo del repositorio (confirmado por búsqueda exhaustiva de código), y no permanecen en este documento como catálogo alternativo, precio anterior activo, variante comercial, decisión pendiente ni referencia válida para implementación.** La fuente de esos valores fue información comercial suministrada en una ronda anterior de este mismo proceso de documentación, no el catálogo vigente en el código. **El paquete Profesional (COP 59.900, con SHP/DXF/coordenadas EPSG:9377) está comercialmente aprobado**, con checkout funcional ya operativo en código (`ALLOWED_PACKAGES.profesional`, `catastroxPayments.js:12-16`).

**Regularización Predial CRH — corregida en esta versión final, excluida del catálogo transaccional**: confirmado que no existe como paquete en `catastroxPackages.js`; `CatastroXRegularizationPage.jsx` es un formulario de lead sin checkout. Este hallazgo coincide exactamente con la decisión de esta versión: Regularización **no es, y no debe modelarse como, un `product` transaccional** (§10/§12) — es contenido comercial informativo con un formulario de contacto/cotización, fuera por completo del sistema de `packageId`/checkout/`price_snapshot`/`entitlement`/`artifact`.

### 3.8 Vista previa gratuita — confirmado, teaser real, no la geometría completa

`CatastroXMockMap.jsx` consume `predio.previewGeometryUrl` (`GET /lookups/:id/preview-geometry`) — geometría simplificada, no la de `full-result`.

### 3.9 Service Worker

`public/service-worker.js:51-54`: toda ruta bajo `/api/` se sirve **network-only**, sin caché.

**NO VERIFICADO**: contenido interno completo de `CatastroXMap.jsx` (mapa post-compra); si `priceCop` en código incluye IVA; comportamiento de Wompi con llave de producción (nunca configurada); volumen/patrón real de tráfico; si el `lookupId` actual tiene aleatoriedad suficiente para no ser adivinable; límites de tamaño/timeout exactos de Cloudflare Pages Functions; si `CATASTROX_AUDIT_DOWNLOADS`/`CATASTROX_ADVANCED_LOOKUP_ENABLED` están activos en producción hoy; ausencia total de concatenación SQL insegura en la totalidad de `catastrox.js`.

## 4. Requisitos obligatorios

1. CatastroX permanece independiente de Ganadería (ADR-001).
2. Las rutas de consulta pública permanecen públicas — ninguna decisión de este ADR exige login para buscar un predio o iniciar una compra.
3. La migración completa de los datos geoespaciales base permanece condicionada por ADR-006, sin relajarse (§24).
4. Cloudflare permanece como frontend estático y relay same-origin (ADR-009), con CORS restringido por allowlist, nunca reflejado (§21).
5. ECS Express Mode es la plataforma objetivo del backend (ADR-011); Railway permanece como rollback temporal.
6. PostgreSQL/PostGIS es la fuente geoespacial, condicionada por ADR-006.
7. Cognito y el patrón BFF (ADR-007/ADR-009) gobiernan cualquier sesión autenticada futura (historial de cuenta) — la compra sin cuenta usa su propio mecanismo de cookie de acceso temporal (§15/§16), no el patrón BFF de sesión permanente.
8. La autorización de negocio (órdenes, entitlements, artifacts) vive en `agx` — separada del pool geoespacial de CatastroX.
9. Las rutas públicas no reciben ni fabrican contexto de organización.
10. Toda ruta protegida por compra resuelve la autorización contra una orden interna verificada, nunca contra parámetros del navegador.
11. Ningún entregable pago se autoriza únicamente desde el frontend.
12. Wompi no es fuente de verdad del producto adquirido.
13. El navegador nunca recibe credenciales, secretos, llaves privadas ni acceso directo a PostgreSQL/PostGIS.
14. **El navegador nunca recibe un payload universal suficiente para generar formatos no adquiridos** — el backend entrega únicamente los campos autorizados para el producto y la vista solicitada (§11, §18).
15. La generación client-side actual (`catastroxDeliverables.js`) se conserva como activo técnico, pero **no constituye la frontera productiva definitiva** para entregables pagos (§11).
16. El catálogo comercial transaccional oficial es el de tres paquetes automáticos (`basico`/`plus`/`profesional`, §3.7/§10) — ningún `packageId` distinto se acepta en producción.
17. **Regularización Predial CRH nunca participa del catálogo transaccional** — no tiene `packageId`, no genera `order_item`/`price_snapshot`/`entitlement`/`artifact` (§10/§12).
18. **La generación inicial de todos los artifacts obligatorios de un paquete se dispara automáticamente al confirmar el pago y crear el entitlement — nunca por una decisión o llamada directa del navegador** (§11/§13).
19. Toda decisión de implementación futura se gobierna por ADR-003/ADR-010.
20. No se autoriza ninguna implementación durante esta tarea.
21. El *target group* del ALB no incorpora PostgreSQL/PostGIS (ADR-012).
22. ADR-014 ya resolvió el mecanismo técnico completo de separación demo/staging/producción; este documento respeta esas fronteras para CatastroX y no duplica su diseño.

## 5. Taxonomía de rutas

### Nivel 0 — Pública informativa
Landing, planes/precios (reflejo del catálogo transaccional server-side, §10), FAQ, contacto, explicación fiscal genérica, Regularización Predial como servicio profesional (contenido informativo + formulario de lead, sin checkout).

### Nivel 1 — Pública gratuita de consulta limitada
Localizar un predio; teaser cartográfico simplificado (§9); confirmar cobertura suficiente. Límites estrictos de campo, precisión, frecuencia (§8, §19).

### Nivel 2 — Pública transaccional
Creación de orden (`draft`), checkout, verificación de pago, emisión/intercambio/recuperación de acceso, consulta de estado de orden mediante credencial de acceso. **No equivale a autorización de entrega de artifacts.**

### Nivel 3 — Protegida por compra verificada
Resultado adaptado al producto adquirido, descarga/regeneración de artifacts (generados automáticamente al confirmarse el pago, §11/§13), historial de compra por credencial de acceso. Depende de una orden `paid`/`preparing`/`ready`, nunca de parámetros del navegador.

### Nivel 4 — Protegida por sesión de usuario
Cuenta futura: historial, pedidos, predios guardados, re-descargas, soporte. Conceptual, no implementado.

### Nivel 5 — Interna/administrativa
Conciliación, reprocesamiento, generación manual, inspección, métricas, reenvío, anulación/revocación, auditoría — incluida la gestión comercial de las solicitudes de Regularización Predial (`professional_service_lead`, §12). Nunca pública ni autorizada por URL secreta o headers falsificables — corrige `isLocalAuditRequest`.

## 6. Inventario de rutas actuales

*(Sin cambios respecto de lo verificado en código — la corrección de este ADR está en la clasificación y el diseño futuro, no en el estado actual del repositorio.)*

| Método | Path (Express) | Archivo | AuthN/AuthZ actual | Escribe | Estado |
|---|---|---|---|---|---|
| POST | `/api/catastrox/lookup` | `catastrox.js:866` | Ninguna | No | Real, producción |
| POST | `/api/catastrox/lookup-by-code` | `catastrox.js:1092` | Rate limit (memoria) | No | Real, producción |
| GET | `/api/catastrox/lookups/:id/preview-map` | `catastrox.js:1146` | Posesión débil de `lookupId` | No | Real, producción |
| GET | `/api/catastrox/lookups/:id/preview-geometry` | `catastrox.js:1239` | Igual | No | Real, producción |
| GET | `/api/catastrox/lookups/:id/full-result` | `catastrox.js:1663` | **Ninguna** | No | **Real, producción, ruta heredada crítica (§6.1)** |
| GET | `/api/catastrox/audit/lookups/:id/full-result` | `catastrox.js:1683` | Flags + headers falsificables | No | Gateada, NO VERIFICADO si activa en prod |
| POST | `/api/catastrox/advanced/lookup` | `catastrox.js:1714` | Igual | No | Igual |
| GET/DELETE | `/api/catastrox/audit/resolver-shadow` | `catastrox.js:1828/1848` | IP de socket (robusta) | No | Real |
| POST | `/api/catastrox/payments/checkout` | `catastroxPayments.js:165` | Ninguna | No | Real, producción |
| GET | `/api/catastrox/payments/verify/:transactionId` | `catastroxPayments.js:118` | Ninguna | No | **Real, producción — modelado como `GET`, corregido en §14** |
| — | Webhook Wompi | — | — | — | **NO EXISTE** |
| — | Órdenes/entitlements/artifacts/leads | — | — | — | **NO EXISTEN** |

### 6.1 `full-result` heredado — clasificación explícita

`GET /api/catastrox/lookups/:lookupId/full-result` se clasifica como **ruta heredada crítica**: debe dejar de ser pública, debe sustituirse por un resultado asociado a una orden autorizada (§7, `GET /api/catastrox/orders/:id/result`), debe **deprecarse formalmente**, y debe **retirarse** una vez identificados y migrados todos sus consumidores actuales. **No puede mantenerse indefinidamente como mecanismo de acceso permanente vía `lookupId`.**

## 7. Matriz definitiva de rutas

*Rutas conceptuales finales.*

| Método | Ruta conceptual | Nivel | Consumidor | AuthN | AuthZ | Fuente | Efecto |
|---|---|---:|---|---|---|---|---|
| GET | `/catastrox`, `/catastrox/planes`, `/catastrox/regularizacion` | 0 | Navegador | Ninguna | Ninguna | Catálogo transaccional server-side (§10) + contenido informativo de Regularización | Lectura |
| POST | `/api/catastrox/contact` | 0/2 | Navegador | Ninguna | Rate limit | `agx` (`professional_service_lead` u otro `service_type` de lead, §12) | Escritura de lead — **nunca crea `order_item`/`price_snapshot`/`entitlement`/`artifact`** |
| POST | `/api/catastrox/lookups` | 1 | Navegador | Ninguna | Rate limit + límites de campo (§8) | PostGIS | Lectura, sin persistencia |
| GET | `/api/catastrox/lookups/:id/preview` | 1 | Navegador | Ninguna | Posesión de `lookupId` + TTL corto | PostGIS (simplificado) | Lectura, teaser |
| POST | `/api/catastrox/orders` | 2 | Navegador | Ninguna | Rate limit; `packageId` ∈ {`basico`,`plus`,`profesional`}; establece credencial de acceso inicial (§15) | `agx` (`order` en `draft`, `order_item` con el `packageId` elegido) | Escritura de orden |
| POST | `/api/catastrox/orders/:id/checkout` | 2 | Navegador (con credencial de acceso) | Cookie de acceso de la orden | Orden pertenece al portador de la cookie | `agx` + Wompi (checkout) | `draft → pending_payment` |
| POST | `/api/catastrox/orders/:id/payment-verifications` | 2 | Navegador (retorno) | Cookie de acceso de la orden | Igual + validación server-to-server contra Wompi | Wompi (pull) + `agx` | `pending_payment → paid`, crea `entitlement`, dispara `paid → preparing` y la generación automática de todos los artifacts obligatorios (§13) |
| GET | `/api/catastrox/orders/:id` | 2 | Navegador (con cookie) | Cookie de acceso | Orden pertenece al portador | `agx` | Lectura de estado (`draft`…`ready`, etc.) |
| GET | `/api/catastrox/orders/:id/result` | 3 | Navegador (con cookie) | Cookie de acceso | Orden `paid`/`preparing`/`ready`, datos limitados al producto adquirido (§18) | `agx` + PostGIS (subconjunto autorizado) | Lectura adaptada al producto |
| POST | `/api/catastrox/orders/:id/artifacts` | 3 | Navegador (con cookie) | Cookie de acceso | **No es la vía de primera generación** — solo regenerar un artifact existente, reintentar uno `failed`, o reemplazar uno `expired`, dentro del mismo formato/entitlement ya concedido (§11/§13) | Generador server-side (§11) | Regeneración/reintento controlado de un artifact ya obligatorio del paquete — nunca crea un formato nuevo fuera del entitlement |
| GET | `/api/catastrox/orders/:id/artifacts/:artifactId` | 3 | Navegador (con cookie) | Cookie de acceso | Artifact pertenece a la orden, `ready`, no expirado/revocado | Artifact ya generado o streaming bajo demanda (§17) | Descarga |
| POST | `/api/catastrox/order-access/exchange` | 2 | Navegador (abre enlace) | Token de intercambio de un solo uso | Token válido, no usado, no expirado, ambiente correcto | `agx` | Consume token, crea cookie de acceso |
| POST | `/api/catastrox/order-access/recovery` | 2 | Navegador | Ninguna (email/celular verificado de la orden) | Rate limit | `agx` | Emite nuevo token de intercambio |
| POST | `/api/catastrox/account/orders` (histórico, Nivel 4) | 4 | Sesión Cognito/BFF | Sesión | `sub` vinculado a `customer.user_id` | `agx` | Lectura de historial |
| `*` | `/api/catastrox/admin/*` | 5 | Panel interno | Sesión Cognito + rol administrativo | Rol, acceso temporal/justificado/auditado (ADR-007 §8.1) | `agx` | Lectura/escritura administrativa, incluida la gestión comercial de `professional_service_lead` |
| GET | `/api/catastrox/audit/*` (heredadas) | 5 | Diagnóstico interno | **Migrar** a autenticación + rol administrativo | Igual | Memoria/PostGIS | Diagnóstico |

## 8. Información pública gratuita

*(Sin cambios de fondo.)* Se puede mostrar sin pago (Nivel 1): municipio, departamento, vereda/sector, identificador catastral, polígono **simplificado**, centroide aproximado, área aproximada (redondeada), condición fiscal/no fiscal general, mensaje de "predio identificado". No se muestra sin pago: nombre completo comercializable del predio, medidas/linderos exactos, avalúo, geometría de precisión, capas de restricciones detalladas, y **bajo ninguna circunstancia el propietario** salvo fundamento legal explícito y decisión expresa — inexistente en este documento.

## 9. Teaser cartográfico

*(Sin cambios de fondo.)* Geometría simplificada, nunca la completa; zoom limitado; sin botón de descarga; **todo dato enviado al navegador puede inspeccionarse** — la protección real es que el dato entregado ya sea, por diseño del backend, deliberadamente degradado, no ocultarlo en el DOM ni deshabilitar botones. Expiración de `lookupId`/preview: 30 minutos (verificado).

## 10. Productos y entregables

### Catálogo comercial transaccional oficial

**El catálogo transaccional contiene exclusivamente tres productos**: `basico`, `plus`, `profesional`. Regularización Predial CRH **no forma parte de este catálogo transaccional** (ver subsección dedicada más abajo).

**A. Paquete Básico** — `packageId: basico`, COP 39.900. Entregables: PDF (plano predial e información del predio). No incluye: KML, KMZ, SHP, DXF, coordenadas EPSG:9377.

**B. Paquete Plus** — `packageId: plus`, COP 49.900. Entregables: PDF, KML, KMZ. No incluye: SHP, DXF, coordenadas EPSG:9377.

**C. Paquete Profesional** — `packageId: profesional`, COP 59.900. Entregables: PDF, KML, KMZ, SHP, DXF, archivo/ZIP de coordenadas EPSG:9377.

| Producto (`packageId`) | Resultado en pantalla | PDF | KML | KMZ | SHP | DXF | Coords EPSG:9377 |
|---|---|---:|---:|---:|---:|---:|---:|
| `basico` | Diagnóstico adaptado al producto (§18) | Sí | No | No | No | No | No |
| `plus` | Diagnóstico adaptado, superior a Básico | Sí | Sí | Sí | No | No | No |
| `profesional` | Diagnóstico completo | Sí | Sí | Sí | Sí | Sí | Sí |

### Regularización Predial CRH — fuera del catálogo transaccional

Regularización Predial CRH **aparece comercialmente en el sitio** (Nivel 0, `/catastrox/regularizacion`), pero **fuera por completo del sistema automático de paquetes, pagos y artifacts**: no es un `product` transaccional; no tiene `packageId`; no participa en `checkout`; no crea `order_item`; no crea `price_snapshot` transaccional; no crea `entitlement`; no crea `artifact`. Se representa exclusivamente como: contenido informativo del servicio; un formulario de lead (`POST /api/catastrox/contact` con `service_type = regularizacion_predial`, §12); una solicitud de cotización gestionada comercialmente (Nivel 5, administración); y un eventual contrato o propuesta profesional posterior, **fuera del alcance de generación automática de entregables y fuera del alcance de este ADR**.

### Fuente de verdad del catálogo

**El catálogo transaccional vive server-side.** El frontend debe consumir o reflejar exactamente el catálogo server-side. `POST /orders`/`POST orders/:id/checkout` deben validar contra el catálogo server-side: `packageId` existe y está activo, precio coincide, moneda coincide, formatos coinciden, estado activo del producto. **Cualquier `packageId` distinto de `basico`/`plus`/`profesional` queda bloqueado en producción — incluido cualquier intento de tratar `regularizacion` como si fuera un `packageId` transaccional.**

## 11. Generación client-side y server-side

*Decisión corregida — frontera de control server-side para todo entregable productivo pago, con generación inicial automática al confirmarse el pago.*

### Problema con el modelo anterior

Un `full-result` universal entrega, en un solo payload, todos los datos necesarios para generar los seis formatos. Un usuario técnico con ese payload puede invocar directamente los generadores de `catastroxDeliverables.js` y fabricar SHP/DXF aunque solo haya pagado Básico. Un bloqueo visual o una validación de frontend **no puede impedirlo** después de entregar los insumos completos.

### Decisión

**A. Resultado en pantalla**: puede seguir renderizándose en el navegador. El backend entrega únicamente los campos autorizados para el producto adquirido (§18) — nunca un payload universal. El resultado gratuito permanece limitado y simplificado (§8/§9). El resultado pagado se adapta exactamente al producto y al entitlement.

**B. Entregables productivos diferenciados** (PDF, KML, KMZ, SHP, DXF, coordenadas EPSG:9377): se generan en una **frontera controlada por el backend**, y **su generación inicial es automática, no una decisión del navegador**: al confirmarse el pago (`pending_payment → paid`) y crearse el entitlement, el backend transiciona la orden a `preparing` y crea y genera, automáticamente, un `artifact` por cada formato obligatorio del paquete adquirido (§13). El navegador nunca decide "generar ahora" para la primera entrega — solo consulta el resultado de un proceso ya iniciado por el backend.

**C. `POST /api/catastrox/orders/:id/artifacts` no es el camino normal de primera generación.** Su función conceptual, exclusivamente, es: regenerar un artifact ya existente; reintentar un artifact en estado `failed`; reemplazar un artifact `expired`; reprocesamiento administrativo autorizado (Nivel 5); o una eventual generación extraordinaria permitida expresamente por el entitlement (por ejemplo, un formato adicional habilitado manualmente por soporte, fuera del alcance de diseño de este documento). **No debe permitir**: pedir un formato no incluido en el paquete adquirido; crear un artifact duplicado sin idempotencia (dos artifacts activos del mismo formato para la misma orden); cambiar de paquete; ampliar el entitlement; generar archivos para un predio distinto al de la orden.

**D. `catastroxDeliverables.js`**: se conserva como activo técnico existente. No se elimina ni se modifica en esta tarea. Puede servir como referencia directa para portar su lógica de construcción de PDF/KML/KMZ/SHP/DXF a la frontera server-side. Puede permanecer disponible para demo o pruebas claramente marcadas como tales. **No constituye la frontera definitiva de generación productiva paga.**

### Comparación por modelo

| | Client-side (limitado a demo/pantalla) | Server-side (frontera adoptada para entregables pagos) |
|---|---|---|
| Ventajas | Menor costo de backend, descarga inmediata, sin almacenamiento | Control central de qué datos recibe el navegador, autorización verificable antes de generar, auditoría, consistencia, hash/firma del artifact, regeneración controlada |
| Riesgos | El navegador recibe insumos completos si no se limita el payload — manipulable, sin garantía de autenticidad | Costo de cómputo adicional, complejidad de colas/streaming, tiempos de generación no instantáneos |

**Modelo seleccionado**: generación server-side automática (disparada internamente por el propio backend al confirmarse el pago, §13) para todo entregable productivo pago. El **resultado en pantalla** puede seguir renderizándose con librerías del navegador, siempre que los datos que lo alimentan ya vengan limitados por el backend según el producto (§18).

## 12. Fuente de verdad transaccional

*Entidades conceptuales — viven en `agx` (o esquema dedicado en la misma base), separadas del pool geoespacial `CATASTROX_DATABASE_URL`.*

### 12.1 Catálogo y comercio transaccional (exclusivamente `basico`/`plus`/`profesional`)

| Entidad | Propósito | Identificador | Relación | Estado | Retención |
|---|---|---|---|---|---|
| `customer` | Comprador, con o sin cuenta | UUID | 1—N `order` | activo/anónimo/vinculado | §26 |
| `product` | Catálogo transaccional server-side — **contiene exclusivamente `basico`, `plus`, `profesional`; Regularización Predial CRH nunca es un registro de esta entidad** | slug estable (`basico`/`plus`/`profesional`) | 1—N `price_snapshot` | activo/retirado | Indefinida (catálogo) |
| `price_snapshot` | Precio/alcance vigente de un `product` transaccional al crear una orden — **inmutable** | UUID | N—1 `product`; referenciado por `order_item` | vigente/histórico | Indefinida — contiene: producto, nombre, precio, moneda, IVA/tratamiento comercial aplicable, formatos incluidos, fecha, versión de catálogo |
| `order` | Fuente de verdad de "qué se compró y su estado" — **solo existe para compras de `product` transaccional, nunca para Regularización** | UUID no secuencial | 1—N `order_item`; 1—N `payment_attempt`; 1—N `entitlement`; 1—N `artifact` (vía `order_item`) | máquina de estados (§13) | §26 |
| `order_item` | Línea de orden (un `product` transaccional, un predio) | UUID | N—1 `order`; N—1 `price_snapshot`; N—1 `parcel_reference` | igual que la orden | igual |
| `payment_attempt` | Intento de pago asociado a una orden | UUID | N—1 `order` | pending/approved/declined/error | §26 |
| `payment_event` | Respuesta cruda relevante de Wompi (pull o futuro webhook) | UUID | N—1 `payment_attempt` | recibido/procesado | §26 |
| `entitlement` | Derecho de acceso a los formatos obligatorios de un `product` transaccional adquirido | UUID | N—1 `order_item` | activo/revocado/expirado | §26 |
| `artifact` | Archivo productivo real o generación autorizada de un formato obligatorio (§17) | `artifact_id` | N—1 `order`; N—1 `order_item`; N—1 `entitlement` | `pending`/`generating`/`ready`/`failed`/`expired`/`revoked` | §26 |
| `download_event` | Evento de descarga/regeneración | UUID | N—1 `artifact` | — | §26 |
| `order_access_exchange_token` | Token de intercambio de un solo uso (§15/§16) | hash (nunca el token en claro) | N—1 `order`; N—1 `customer` | emitido/consumido/expirado/revocado | Corta duración, §26 |
| `order_access_credential` | Credencial de acceso temporal representada por la cookie (§16) | hash/identificador de sesión de acceso | N—1 `order`; N—1 `customer` | activa/expirada/revocada | Corta-media duración, §26 |
| `user_id` (opcional en `customer`) | Vínculo con Cognito para historial (Nivel 4) | `sub` de Cognito | 1—1 `customer` | vinculado/no vinculado | Igual que la cuenta |
| `parcel_reference` | Referencia al predio consultado | conceptual, no necesariamente FK física a PostGIS | N—1 `order_item` | — | — |

### 12.2 Regularización Predial CRH — entidad separada, no transaccional

**`professional_service_lead`** (o una entidad `lead` genérica reutilizable con un campo `service_type`, sin diseñar en detalle un CRM en este documento):

- `lead_id`.
- `service_type` (por ejemplo, `regularizacion_predial` — deja el campo abierto a otros servicios profesionales futuros sin necesidad de una entidad nueva por cada uno).
- `customer`/`contact` (nombre, correo, celular — sin exigir cuenta, igual principio de minimización de §18).
- `mensaje` (contenido libre del formulario de contacto).
- `estado comercial` (por ejemplo: `recibido` / `en_cotizacion` / `propuesta_enviada` / `cerrado` / `descartado` — conceptual, gestionado por el equipo comercial, no por una máquina de estados de pago).
- `fecha`.
- `ambiente` (demo/staging/producción, mismo principio de separación de §23).
- Auditoría (creación, cambios de estado comercial, quién los realizó — Nivel 5).

**Esta entidad nunca genera, ni directa ni indirectamente, un `order_item`, un `price_snapshot` transaccional, un `entitlement` ni un `artifact`.** Un eventual contrato o propuesta profesional posterior derivado de una `professional_service_lead` es un proceso comercial fuera del alcance de generación automática de entregables y fuera del alcance de este ADR.

**Wompi no sustituye ninguna de las entidades de §12.1.**

### 12.3 Campos conceptuales de `artifact`

`artifact_id`; `order_id`; `order_item_id`; `entitlement_id`; formato (`pdf`/`kml`/`kmz`/`shp`/`dxf`/`coords9377`); estado (`pending`/`generating`/`ready`/`failed`/`expired`/`revoked`); `Content-Type`; nombre lógico; tamaño; hash/digest; fecha de creación; fecha de expiración; origen de los datos; ambiente; versión del generador; motivo de fallo, **clasificado y no sensible**.

## 13. Estados de orden

*Ciclo de generación cerrado de forma inequívoca en esta versión final.*

**Máquina de estados**:

```
draft ──(checkout emitido)──▶ pending_payment
draft ──(cancelación previa al pago)──▶ cancelled

pending_payment ──(verify: APPROVED, monto/producto/moneda coinciden)──▶ paid
pending_payment ──(verify: DECLINED/ERROR)──▶ payment_failed
pending_payment ──(expira sin verificación, temporizador backend)──▶ expired
pending_payment ──(cancelación previa al pago)──▶ cancelled

payment_failed ──(nuevo intento de pago)──▶ pending_payment

paid ──(entitlement creado; artifacts obligatorios creados y generación iniciada)──▶ preparing

preparing ──(todos los artifacts obligatorios en estado ready)──▶ ready
preparing ──(uno o más artifacts obligatorios fallan)──▶ delivery_failed
delivery_failed ──(reintento controlado)──▶ preparing

ready ──(reembolso procesado)──▶ refunded
ready ──(retiro de acceso por fraude/error/decisión administrativa)──▶ revoked
```

### Secuencia exacta tras una verificación de pago exitosa

1. `pending_payment → paid`.
2. El backend crea el `entitlement` correspondiente al `product`/`packageId` adquirido.
3. `paid → preparing`.
4. El backend crea automáticamente **un `artifact` por cada formato incluido en el producto adquirido** (§13.1, tabla de artifacts obligatorios) — nunca uno por cada formato existente en el sistema, solo los del paquete comprado.
5. El backend inicia la generación de todos esos artifacts obligatorios.
6. Cuando **todos** los artifacts obligatorios de la orden alcanzan `ready`: `preparing → ready`.
7. Si **uno o más** artifacts obligatorios fallan: `preparing → delivery_failed`.
8. Un reintento controlado (automático acotado o administrativo): `delivery_failed → preparing` — reintenta específicamente los artifacts fallidos, sin recrear los que ya estén `ready`.
9. `refunded` o `revoked` **invalidan el entitlement y todos los artifacts asociados** de forma inmediata, cualquiera sea su estado individual en ese momento.

### 13.1 Artifacts obligatorios por paquete

| `packageId` | Artifacts obligatorios |
|---|---|
| `basico` | `pdf` |
| `plus` | `pdf`, `kml`, `kmz` |
| `profesional` | `pdf`, `kml`, `kmz`, `shp`, `dxf`, `coords9377` |

### Definición de `ready`

**"La orden está pagada y todos los artifacts incluidos en el paquete adquirido están disponibles para descarga."** Ninguna orden se considera `ready` si algún artifact obligatorio de su paquete permanece en `pending`/`generating`/`failed` — en ese caso, la orden permanece en `preparing` o transiciona a `delivery_failed` según corresponda.

### Reglas por estado

- **`draft`**: orden creada, sin checkout definitivo emitido.
- **`pending_payment`**: checkout emitido, pago pendiente de verificación.
- **`payment_failed`**: intento rechazado o fallido; puede volver a `pending_payment` con un nuevo intento de pago sobre la misma orden.
- **`expired`**: orden no pagada que venció; estado terminal salvo creación de una orden nueva.
- **`cancelled`**: solo antes del pago (`draft`/`pending_payment`); **no sustituye un reembolso**.
- **`paid`**: pago confirmado; **todavía no significa que los artifacts estén listos** — es exactamente el estado transitorio que antecede a la creación automática del entitlement y el disparo de la generación (pasos 1-3 arriba).
- **`preparing`**: artifacts obligatorios en generación; su fin natural es `ready` (todos listos) o `delivery_failed` (alguno falló).
- **`ready`**: todos los artifacts obligatorios del paquete están disponibles para descarga (definición cerrada arriba).
- **`delivery_failed`**: fallo de generación de uno o más artifacts obligatorios; puede volver a `preparing` mediante reintento controlado (paso 8).
- **`refunded`**: pago reembolsado; entitlement y artifacts asociados se revocan como efecto directo de esta transición.
- **`revoked`**: acceso retirado por fraude, error o decisión administrativa; requiere justificación y auditoría (§25); no implica necesariamente un reembolso automático.

**Regla transversal, sin excepción**: ninguna transición puede originarse directamente del navegador. Toda transición se ejecuta en el backend, es idempotente, se valida contra el estado actual, y se registra en auditoría (§25).

## 14. Integración y verificación de pagos

*Corregida — la verificación deja de modelarse como `GET`.*

### Contrato conceptual

**`POST /api/catastrox/orders/:id/payment-verifications`**

- Exige acceso autorizado a la orden mediante la cookie de acceso de compra sin cuenta (§15/§16) o sesión futura (Nivel 4).
- Recibe `transactionId` (validado, no arbitrario).
- **No acepta precio ni estado desde el navegador** — ambos se resuelven contra `order`/`order_item`/`price_snapshot` internos.
- Consulta Wompi **server-to-server**.
- Verifica: referencia, monto, moneda, producto, ambiente.
- Asocia la transacción a la orden correcta.
- Registra `payment_attempt` y `payment_event`.
- Es **idempotente**: verificar el mismo `transactionId` más de una vez no crea un segundo `payment_attempt` exitoso ni un segundo `entitlement`.
- **Impide replay** e **impide doble entitlement**.
- Cambia el estado de la orden **únicamente desde el backend**, y — corrección cerrada en esta versión — al hacerlo (`pending_payment → paid`) **desencadena inmediatamente** la secuencia de creación de entitlement y generación automática de artifacts obligatorios (§13).

### Consulta segura posterior

**`GET /api/catastrox/orders/:id`** — de solo lectura, protegida por la misma cookie de acceso.

### Regla central, vinculante

- **El redirect del navegador no prueba pago.**
- **El frontend nunca decide que una orden está pagada.**
- **El backend verifica el evento con Wompi**, siempre server-to-server.
- **Monto, moneda, referencia y producto se comparan contra la orden interna.**
- **La verificación es idempotente.**

### Webhook — recomendado como complemento futuro, no como sustituto

**No se inventa que el webhook ya existe** — confirmado ausente (§3.2). Cualquier webhook futuro debe: validar la firma de Wompi; validar el ambiente; ser idempotente; resistir replay; comparar el evento contra la orden existente; **nunca marcar una orden `paid` por la sola recepción del evento**.

## 15. Compra sin cuenta

**Se permite**, mediante un patrón de **intercambio + cookie**, no un token reutilizable en URL.

### Flujo

1. `POST /api/catastrox/orders` crea la orden (`draft`) con `packageId` ∈ {`basico`,`plus`,`profesional`} y email/celular del comprador. El backend establece, para la sesión que acaba de crear la orden, una credencial de acceso inicial (sin exponer el token en la URL).
2. Al confirmar la orden, y siempre que el comprador necesite **reacceso** (otro dispositivo, cookie expirada), se emite un **token de intercambio**: opaco, criptográficamente aleatorio, de un solo uso, de corta duración, asociado a la orden, al `customer` y al ambiente; **almacenado únicamente como hash**; revocable; **nunca registrado en logs** (§25).
3. El comprador recibe un **enlace** (email/SMS) como mecanismo de acceso.
4. Al abrir el enlace, el navegador llama a **`POST /api/catastrox/order-access/exchange`**.
5. El backend: valida el token; comprueba vigencia; comprueba que no fue usado; **lo consume**; crea `order_access_credential`; establece la cookie de acceso (§16).
6. Tras el intercambio, se **redirige a una URL limpia sin token**: `/catastrox/orders/:id`.
7. **Reacceso**: `POST /api/catastrox/order-access/recovery`; se genera un nuevo token; **los anteriores quedan consumidos, expirados o revocados**; se envía solo al email/celular ya verificado; rate limiting (§19); se registra la operación (§25).

### Prohibiciones explícitas — nunca usar como credencial

`orderId`; `lookupId`; correo en URL; celular en URL; referencia de pago; `transactionId`; `purchaseKey` de frontend.

## 16. Autorización y entitlements

### Cookie de acceso

`HttpOnly`; `Secure`; `SameSite=Lax` o más restrictiva según el flujo final de checkout con Wompi; `Path` limitado al espacio de CatastroX; expiración explícita; no accesible a JavaScript; vinculada a la orden y/o al `customer`; revocable.

### Qué puede hacer el portador de la cookie

Ver estado de orden (`GET orders/:id`); una vez `paid`/`preparing`/`ready`, ver el resultado adaptado al producto (`GET orders/:id/result`); descargar artifacts ya generados automáticamente (`GET orders/:id/artifacts/:artifactId`); solicitar regeneración/reintento de un artifact existente (`POST orders/:id/artifacts`, §11), sujeto a los límites de §19 — **nunca solicitar la primera generación ni un formato fuera del entitlement**.

### Verificación obligatoria antes de servir resultado, generar (regeneración) o entregar un artifact

1. La orden existe y está en el estado correspondiente (§13).
2. El formato solicitado (para regeneración) o servido (para descarga) está entre los artifacts obligatorios del `entitlement` — nunca un formato de un paquete superior.
3. El predio referenciado coincide con el `parcel_reference` de la orden.
4. La cookie/credencial no ha expirado ni fue revocada.
5. El portador de la cookie corresponde efectivamente a esa orden.
6. El ambiente es coherente (§23).
7. El estado no es `refunded`/`revoked`/`cancelled`.

## 17. Descargas y artifacts

- **No se usan rutas públicas permanentes predecibles** — todo acceso pasa por `GET orders/:id/artifacts/:artifactId`, protegido por la cookie de acceso.
- **No existe S3 ni almacenamiento de objetos hoy** — no se asume implementado. La entrega puede realizarse mediante: streaming directo desde backend; archivo temporal con expiración corta; o almacenamiento de objetos futuro — decisión de diseño técnico posterior, condicionada al volumen real.
- `artifact.pending`/`generating` reflejan la generación automática iniciada al confirmarse el pago (§13); `ready` habilita la descarga; `failed` habilita el reintento (§11/§13); `expired`/`revoked` bloquean la descarga.
- **Cabeceras**: `Content-Type` correcto por formato; `Content-Disposition: attachment` con nombre lógico; `Cache-Control: no-store` siempre; hash/digest expuesto para verificación de integridad.
- **Límites de re-descarga/regeneración**: registrados vía `download_event`, límite razonable no fijado en este documento (§19/§34).
- **Trazabilidad**: cada generación (automática o de regeneración) y cada descarga se registra (§25).
- **Revocación**: administración puede revocar un `artifact`/`entitlement` en cualquier momento.
- **Regeneración controlada**: exclusivamente vía `POST orders/:id/artifacts` (§11), sin crear un nuevo `entitlement` ni ampliar el alcance del existente.
- **Validación del formato contra el entitlement**: obligatoria en cada solicitud, tanto de descarga como de regeneración.

## 18. Datos personales y geoespaciales

*(Sin cambios de fondo.)* No se entrega al navegador más dato del necesario para el producto y la vista solicitada. Se distinguen: teaser gratuito (Nivel 1); resultado Básico; resultado Plus; resultado Profesional; insumos internos del generador server-side (nunca serializados al navegador). No existe ya un `full-result` universal común a todos los niveles. Propietario/contacto: nunca en ninguna respuesta pública ni en ningún nivel de resultado por defecto. "Dato público" no equivale a "sin restricciones de tratamiento".

## 19. Rate limiting y abuso

*(Sin cambios de fondo; categorías ya cubren la generación automática y la regeneración por separado.)*

| Categoría | Dimensión | Mecanismo |
|---|---|---|
| Lookup público | IP | Mantener/extender el ya existente |
| Preview | IP + `lookupId` | Límite por `lookupId` además de por IP |
| Creación de orden | IP + `customer` declarado | Límite de creación por ventana |
| Checkout | Cookie de acceso de la orden | Límite de reintentos de checkout por orden |
| Verificación de pago | Cookie + `transactionId` | Límite de reintentos, combinado con idempotencia (§14) |
| Intercambio de token | IP + token | Límite de intentos de canje fallidos |
| Recuperación de acceso | IP + email/celular declarado | Rate limit estricto |
| Regeneración de artifacts | Cookie de acceso + `artifact`/orden | Límite de regeneraciones por orden y por artifact |
| Contacto/lead (incluida Regularización) | IP + email declarado | Rate limit + posible CAPTCHA |
| Administración | Sesión + rol | Auditoría exhaustiva |

**Ninguna cifra de esta sección es definitiva.**

## 20. Caché y Service Worker

*(Sin cambios de fondo.)* Landing/planes/precios: cacheables públicamente, sin datos personalizados. Lookup/preview: no cacheable entre usuarios. Órdenes, checkout, verificación, resultado, artifacts, exchange, recovery, historial, administración, leads de Regularización: `Cache-Control: no-store`. Service Worker: `/api/*` ya `network-only`, mantenido explícitamente. Invalidación explícita cuando cambie el catálogo transaccional server-side.

## 21. Cloudflare relay

*(Sin cambios de fondo.)* No reflejar cualquier `Origin` — usar allowlist explícita. Rutas same-origin no requieren CORS abierto. Rutas con cookies (Nivel 2/3/4) solo aceptan credenciales desde orígenes autorizados. Nunca `Access-Control-Allow-Origin: *` combinado con credenciales. Validar `Origin` también en el backend — Cloudflare no sustituye AuthN/AuthZ.

## 22. Seguridad de rutas

*(Sin cambios de fondo.)* AuthN progresiva por nivel; AuthZ cerrada mediante entitlement/cookie de acceso. Validación de entrada extendida a `orderId`, `format`, `artifactId`, token de intercambio. `format` validado contra la lista cerrada de artifacts obligatorios del entitlement (§13.1), nunca aceptado arbitrariamente, ni siquiera en la ruta de regeneración. Cada ruta con `:id` debe resistir IDOR/BOLA. Enumeración: `orderId`/`artifactId` deben ser UUID aleatorios no secuenciales. Mass assignment: `POST orders`/`checkout` restringidos al catálogo transaccional server-side. Administración: Nivel 5 requiere autenticación + rol administrativo real.

### Cookies y seguridad del enlace

Token de intercambio nunca en logs (§25); eliminar query string sensible antes de cargar analytics; `Referrer-Policy` restrictiva; el token nunca se guarda en `localStorage`; nunca se expone a JavaScript una vez canjeado; no se incluye en la URL después del intercambio.

## 23. Separación demo/producción

*(Sin cambios de fondo.)* Demo no usa pagos reales; demo no usa entitlements productivos; demo no genera artifacts productivos; tokens de intercambio y cookies de acceso demo no funcionan en producción; Wompi sandbox y producción separados; artifacts demo se marcan como muestra; CatastroX demo no se confunde con consulta comercial real. El mecanismo técnico completo permanece reservado a ADR-014.

## 24. Dependencia de ADR-006

*(Sin cambios de fondo.)* Mover el proceso Express a ECS no significa que CatastroX esté migrado. La fuente PostGIS definitiva solo cambia al cumplir ADR-006. El sistema de órdenes/entitlements/artifacts diseñado en este ADR-013 es independiente del lugar físico actual de PostGIS.

## 25. Observabilidad y auditoría

**Registrar, como mínimo**: creación de orden; emisión de token de intercambio; consumo de token de intercambio; creación de cookie/credencial de acceso; operación de recuperación de acceso; cada cambio de estado de orden (§13), incluida explícitamente la transición automática `paid → preparing`; creación de `entitlement`; **creación automática de los artifacts obligatorios al confirmarse el pago** (distinguida en el registro de cualquier regeneración/reintento posterior vía `POST orders/:id/artifacts`); inicio y resultado de cada generación; creación de `artifact`; descarga; expiración; revocación; acceso denegado (incluido un intento de regenerar/solicitar un formato fuera del entitlement); intento de enumeración; acción administrativa; creación y cambio de estado comercial de una `professional_service_lead` (Regularización u otro servicio profesional).

**Nunca registrar**: token de intercambio; cookie de acceso; secretos; llaves de Wompi; geometría completa; información de pago sensible.

## 26. Retención y expiración

*(Sin cambios de fondo.)* Orden, eventos de pago, artifacts (metadatos), logs, contacto/cotizaciones (incluidas las de Regularización): sujetos a revisión legal para plazos definitivos. Tokens de intercambio y cookies/credenciales de acceso: expiran en plazos cortos no fijados (§34). Archivos temporales de artifacts: expiran en un plazo corto tras la generación, si se opta por ese patrón de entrega.

## 27. Matriz de amenazas

| Amenaza | Vector | Impacto | Control | Riesgo residual |
|---|---|---|---|---|
| Manipular precio desde frontend | Interceptar/alterar `POST orders`/`checkout` | Pagar menos de lo debido | `packageId` validado contra catálogo transaccional server-side (§10) | Bajo |
| Cambiar `parcel_id`/predio tras pagar | Alterar parámetro en `artifacts` | Obtener entregable de un predio distinto | Verificación de `parcel_reference` contra la orden (§16, punto 3) | Bajo tras implementación |
| Reutilizar `transactionId` | Reenviar a `payment-verifications` | Doble entitlement sin doble pago | Idempotencia obligatoria (§14) | Bajo tras implementación |
| Replay de webhook (futuro) | Reenviar evento capturado | Reprocesar pago ya contabilizado | Idempotencia + comparación contra `payment_event`, firma validada | Medio, condicional a implementación futura |
| Fabricar un formato no comprado a partir de un payload universal | Recibir todos los datos y ejecutar los generadores existentes | Obtener SHP/DXF de Profesional habiendo pagado Básico | Segmentación de payload por producto (§18) + generación server-side automática (§11) | Bajo tras esta corrección |
| **Solicitar vía `POST orders/:id/artifacts` un formato no incluido en el paquete pagado** | Llamar la ruta de regeneración con un `format` fuera del entitlement | Obtener un formato de un paquete superior sin pagarlo | Validación de `format` contra los artifacts obligatorios del entitlement en cada llamada de regeneración (§11/§16/§22) | Bajo tras implementación |
| **Crear artifacts duplicados llamando repetidamente a la ruta de regeneración** | Llamadas repetidas sin control de idempotencia | Costo de cómputo, inconsistencia de cuál artifact es el vigente | Idempotencia de la regeneración — un artifact activo por formato/orden (§11) | Bajo tras implementación |
| Descargar un artifact de otra orden | Adivinar/enumerar `artifactId` | Acceso a un archivo pagado por otro | UUID no secuencial + cookie de acceso de la orden correcta | Bajo tras implementación |
| Enumerar órdenes | Iterar `orderId` | Ver órdenes/resultados ajenos | UUID no secuencial + cookie obligatoria | Bajo tras implementación |
| Robo/filtración del token de intercambio | Interceptar el enlace enviado por email/SMS, o encontrarlo en un log | Acceso no autorizado a la orden | Un solo uso, corta duración, nunca en logs, canal verificado | Medio, mitigado por diseño |
| Robo de cookie de acceso | XSS u otro vector de exfiltración | Acceso no autorizado mientras la cookie sea válida | `HttpOnly`, `Secure`, `SameSite`, expiración corta, revocable | Medio, mitigado no eliminado |
| Compartir el enlace de acceso con un tercero | El comprador reenvía su enlace | Acceso de terceros a su propia orden | Aceptado como riesgo residual de "compra sin cuenta sin fricción" | Medio, aceptado por diseño |
| Scraping masivo del lookup público | Automatizar `lookups` | Reconstrucción masiva de la base gratuita | Rate limiting, límites de campo, posible CAPTCHA | Medio-alto hasta reforzar |
| Extraer GeoJSON del teaser | Inspeccionar red del navegador | Obtener geometría simplificada masivamente | Aceptado — el teaser ya es deliberadamente degradado | Bajo, por diseño |
| **Tratar Regularización como `packageId` transaccional** | Enviar `packageId: regularizacion` a `POST orders` | Crear una orden/entitlement/artifact para un servicio que no debe tenerlos | Validación estricta contra el catálogo transaccional (`basico`/`plus`/`profesional` únicamente, §10) | Bajo tras implementación |
| Webhook falso (futuro) | Payload falsificado a un endpoint no protegido | Marcar orden pagada sin pago real | Validación de firma (si se implementa) | N/A hoy; alto si se implementa sin firma |
| Doble cobro | Reintentar checkout sin idempotencia | Cobrar dos veces | Idempotencia de checkout + verificación (§14) | Medio hasta reforzar en backend |
| Caché cruzada | Servir respuesta privada cacheada a otro usuario | Fuga de resultado/orden ajena | `no-store` en todas las rutas privadas, Service Worker `network-only` | Bajo |
| CORS abierto | `Origin` reflejado indiscriminadamente | Lectura de respuestas por un sitio malicioso si hay credenciales implícitas | Allowlist explícita (§21) | Alto hasta corregir |
| Path traversal | Parámetro de formato/artifact usado para acceder a filesystem | No aplica hoy | Validación de `format`/`artifactId` contra listas cerradas | Bajo |
| Administrador sin auditoría | Acción Nivel 5 sin registro | Anulación/revocación/reembolso no trazable, incluida gestión indebida de leads | Auditoría obligatoria de toda acción Nivel 5 (§25) | Alto hasta implementar junto con el propio Nivel 5 |

## 28. Consecuencias positivas

- Cierra el hallazgo crítico de forma completa: elimina tanto la ausencia de verificación de pago como la posibilidad técnica de fabricar formatos no comprados.
- El ciclo de generación queda cerrado sin ambigüedad: pago confirmado dispara automáticamente entitlement + artifacts obligatorios, sin depender de que el navegador "pida" la generación — elimina una superficie de manipulación adicional (nadie puede evitar o duplicar la generación inicial llamando o no a una ruta).
- Separar Regularización del catálogo transaccional evita contaminar el modelo de datos de pagos/entitlements con un flujo comercial que nunca debió tener esas garantías (no hay "pago" que verificar, no hay "formato" que autorizar).
- El patrón de intercambio + cookie es más resistente a filtración/reenvío accidental que un token reutilizable persistido en una URL.
- La verificación de pago como `POST` idempotente alinea el modelo con la realidad de lo que la operación hace.
- El catálogo comercial transaccional queda cerrado sin ambigüedad.

## 29. Consecuencias negativas

- Migrar la generación de artifacts pagos a una frontera server-side implica reescribir o portar una parte no trivial de `catastroxDeliverables.js`.
- El patrón de intercambio + cookie exige infraestructura de correo/SMS transaccional confiable.
- La generación automática de múltiples artifacts al confirmarse el pago exige orquestación (posible cola o proceso asíncrono) para no bloquear la respuesta de `payment-verifications` mientras se generan, por ejemplo, seis formatos del paquete Profesional.
- Requiere coordinar frontend y backend para dejar de depender de `localStorage` y del payload universal actual.

## 30. Riesgos

| Riesgo | Origen | Tratamiento propuesto |
|---|---|---|
| Payload universal y generación 100% client-side siguen siendo el estado real del código hasta implementar la corrección | Confirmado (§3.3/§3.4) | Acción requerida prioritaria (§31) |
| Ausencia de idempotencia en checkout/verificación | Confirmado (§3.2/§14) | Diseño de idempotencia obligatorio |
| CORS reflejado indiscriminadamente | Confirmado (§3.5/§21/§27) | Whitelist explícita |
| Guardas administrativas basadas en headers falsificables | Ya identificado por ADR-005 | Migrar a autenticación + rol administrativo real |
| Orquestación de generación de múltiples artifacts al confirmarse el pago no diseñada en detalle (síncrona vs. asíncrona/cola) | Nuevo, introducido por esta corrección | Decisión de diseño técnico posterior (§34) |
| Infraestructura de envío de enlaces (email/SMS) no diseñada | Nueva dependencia | Diseño técnico posterior |
| Ninguna llave de producción de Wompi existe | Confirmado (§3.2) | Acción de seguimiento |

## 31. Acciones requeridas

*(Ninguna se ejecuta como parte de este ADR.)*

- Diseñar e implementar las tablas `order`/`order_item`/`price_snapshot`/`payment_attempt`/`payment_event`/`entitlement`/`artifact`/`download_event`/`customer`/`order_access_exchange_token`/`order_access_credential` en `agx` (§12.1), y la entidad separada `professional_service_lead` (§12.2).
- Implementar la verificación de pago como `POST /orders/:id/payment-verifications`, idempotente, con comparación server-side de monto/producto/moneda, disparando automáticamente la creación de entitlement y artifacts obligatorios (§13/§14).
- Diseñar la orquestación de generación automática de artifacts (síncrona para paquetes de un solo formato como Básico; posible cola/asíncrono para Plus/Profesional) sin bloquear la respuesta de la verificación de pago.
- Portar o reescribir, del lado del servidor, la lógica de generación de PDF/KML/KMZ/SHP/DXF/coordenadas hoy en `catastroxDeliverables.js`.
- Diseñar e implementar el mecanismo de token de intercambio + cookie de acceso (§15/§16).
- Reemplazar `GET /lookups/:lookupId/full-result` por `GET /orders/:id/result`, identificando y migrando todos sus consumidores antes de retirarla (§6.1).
- Restringir el CORS reflejado en las funciones de Cloudflare de CatastroX a una whitelist explícita (§21).
- Migrar las guardas administrativas hacia autenticación + rol administrativo real.
- Implementar `POST /api/catastrox/contact` con `service_type`, creando `professional_service_lead` para Regularización sin ninguna ruta hacia `order`/`entitlement`/`artifact`.
- Medir tráfico real antes de fijar cifras definitivas de rate limiting y plazos de expiración.
- Confirmar el modelo de entrega de artifacts (streaming vs. archivo temporal vs. almacenamiento de objetos futuro).
- Evaluar la incorporación de un webhook de Wompi complementario.
- Revisar de forma dedicada `catastrox.js`/`catastroxPayments.js` en busca de SQL no parametrizada.
- Aprovisionar y probar credenciales de producción de Wompi antes de cualquier corte comercial real.

## 32. Criterios de aceptación

- Ningún endpoint entrega al navegador un payload suficiente para generar formatos fuera del producto adquirido.
- **La orden alcanza `ready` si y solo si todos los artifacts obligatorios de su paquete (§13.1) están en estado `ready`** — nunca antes, nunca por la sola confirmación de pago.
- La generación inicial de artifacts ocurre automáticamente al confirmarse el pago y crearse el entitlement — ninguna llamada del navegador es necesaria ni suficiente para disparar la primera generación.
- `POST orders/:id/artifacts` nunca acepta un formato fuera del entitlement, nunca crea un artifact duplicado activo del mismo formato, nunca cambia de paquete, nunca amplía el entitlement, nunca genera para un predio distinto.
- `GET full-result` queda deprecada y, tras migrar sus consumidores, retirada.
- La verificación de pago es un `POST` idempotente, que no acepta precio ni estado del navegador.
- El catálogo comercial transaccional contiene exclusivamente `basico`/`plus`/`profesional` — Regularización Predial CRH nunca crea `order_item`, `price_snapshot` transaccional, `entitlement` ni `artifact`, en ningún flujo del sistema.
- El acceso sin cuenta usa exclusivamente el patrón de intercambio de un solo uso + cookie `HttpOnly`/`Secure`.
- Ninguna transición de estado de orden se acepta si proviene directamente del navegador.
- El CORS del relay de Cloudflare para rutas de Nivel 2 en adelante usa whitelist explícita.
- Ningún dato personal aparece en respuestas públicas ni en el teaser.
- Toda acción administrativa, incluida la gestión comercial de leads de Regularización, queda registrada con autor, momento y justificación.

## 33. Elementos fuera de alcance

Implementación de código, migraciones, Terraform, workflows o recursos de AWS. Modificación de rutas Express, componentes React, funciones de Cloudflare, PostgreSQL/PostGIS o integración con Wompi. Conexión a servicios externos, builds o pruebas. Diseño de un CRM para la gestión comercial de `professional_service_lead` — solo se fija su existencia conceptual mínima (§12.2). Duplicación del mecanismo técnico de separación demo/staging/producción ya resuelto por ADR-014. Selección final del proveedor de autenticación. Cifras definitivas de rate limiting, expiración de tokens/cookies, o retención. Elección definitiva entre streaming/archivo temporal/almacenamiento de objetos. Diseño detallado de un eventual webhook de Wompi. Diseño de la orquestación técnica exacta (síncrona/cola) de la generación automática de artifacts.

## 34. Decisiones de seguimiento

**A. Plazos exactos** de expiración de token de intercambio, cookie de acceso, y límite de regeneraciones por orden.

**B. Proveedor y mecanismo exacto de envío de enlaces** (email/SMS).

**C. Modelo definitivo de entrega de artifacts**: streaming directo, archivo temporal, o almacenamiento de objetos futuro.

**D. Incorporación o no de un webhook de Wompi** complementario.

**E. Cifras definitivas de rate limiting** por categoría, tras medir tráfico real.

**F. Implementación operativa de la separación demo/staging/producción** — gobernada por ADR-014.

**G. Aprovisionamiento de credenciales de producción de Wompi.**

**H. Esquema físico exacto** donde vivirán las tablas transaccionales y la entidad de leads dentro de la misma base que `agx`.

**I. Alcance exacto del payload mínimo por producto** — requiere un análisis campo por campo de qué necesita cada generador de `catastroxDeliverables.js`.

**J. Orquestación técnica exacta de la generación automática de artifacts** (síncrona vs. cola/asíncrona) al confirmarse el pago, especialmente para el paquete Profesional (seis formatos obligatorios).

**K. Diseño mínimo de gestión comercial de `professional_service_lead`** (no un CRM completo, pero sí el flujo operativo mínimo de atención de las solicitudes de Regularización).

## 35. Relación con ADR anteriores

- **ADR-001**: CatastroX permanece módulo independiente, sin cambios de infraestructura.
- **ADR-004/ADR-014**: fronteras demo/staging/producción reforzadas para tokens/cookies/artifacts; mecanismo completo resuelto por ADR-014.
- **ADR-005**: este documento cierra la clasificación ruta por ruta y los controles transaccionales que ADR-005 dejó pendientes.
- **ADR-006**: dependencia geoespacial respetada íntegramente.
- **ADR-007**: este documento es el ADR de seguimiento de autorización transaccional de CatastroX anunciado en ADR-007 §11.2/§20.
- **ADR-008**: el modelo de organizaciones no aplica por defecto a `customer`.
- **ADR-009**: el patrón BFF gobierna el Nivel 4; la compra sin cuenta usa su propio mecanismo de cookie de acceso temporal.
- **ADR-010**: cualquier tabla/infraestructura derivada se gestiona vía Terraform + estado remoto.
- **ADR-011**: CatastroX permanece sobre ECS Express Mode, sin cambios de topología requeridos.
- **ADR-012**: el *target group* del ALB no evalúa PostgreSQL/PostGIS; ninguna ruta de CatastroX es consumida por el health check de plataforma.

---

## Anexo A. Diagrama de flujo consulta → compra → pago → entrega

```
Navegador
   │
   ▼
POST /api/catastrox/lookups (Nivel 1, gratuito)
   │  responde: teaser simplificado
   ▼
GET /api/catastrox/lookups/:id/preview (Nivel 1)
   │
   ▼
Usuario elige packageId (basico/plus/profesional) → /catastrox/planes (Nivel 0, catálogo transaccional server-side)
   │  (Regularización Predial CRH sigue un camino distinto, ver Anexo A.2)
   ▼
POST /api/catastrox/orders (Nivel 2)
   │  crea order(draft), order_item con packageId, price_snapshot inmutable, customer
   │  establece credencial de acceso inicial para la sesión actual
   ▼
POST /api/catastrox/orders/:id/checkout (Nivel 2)
   │  order: draft → pending_payment
   │  Wompi widget/redirect (fuera del control de AgroGenomaX)
   ▼
Navegador regresa (el redirect NO prueba pago)
   │
   ▼
POST /api/catastrox/orders/:id/payment-verifications (Nivel 2, POST idempotente)
   │  backend consulta Wompi server-to-server, compara contra la orden interna
   │  order: pending_payment → paid
   │  1) entitlement creado
   │  2) order: paid → preparing
   │  3) backend crea automáticamente un artifact por cada formato obligatorio del paquete (§13.1)
   │  4) backend inicia la generación de todos esos artifacts
   ▼
   ┌─── todos ready ───▶ order: preparing → ready
   │
   └─── alguno falla ──▶ order: preparing → delivery_failed ──(reintento controlado)──▶ preparing
   ▼
GET /api/catastrox/orders/:id (Nivel 2, consulta segura de estado)
   ▼
GET /api/catastrox/orders/:id/result (Nivel 3)
   │  backend entrega SOLO los campos autorizados para el producto adquirido
   ▼
GET /api/catastrox/orders/:id/artifacts/:artifactId (Nivel 3)
   │  descarga de un artifact ya generado automáticamente (streaming o archivo temporal, §17)
   ▼
download_event registrado (§17/§25)

--- Regeneración/reintento (excepcional, nunca la vía normal) ---
POST /api/catastrox/orders/:id/artifacts (Nivel 3)
   │  solo: regenerar un artifact existente / reintentar failed / reemplazar expired /
   │  reprocesamiento administrativo — nunca primera generación, nunca formato nuevo

--- Reacceso posterior (otro dispositivo, cookie expirada) ---
POST /api/catastrox/order-access/recovery ──▶ POST /api/catastrox/order-access/exchange
   │  valida, consume (un solo uso), crea cookie de acceso
   ▼
Redirige a /catastrox/orders/:id (URL limpia, sin token)
```

### Anexo A.2 — Regularización Predial CRH (fuera del flujo transaccional)

```
Navegador → /catastrox/regularizacion (Nivel 0, contenido informativo)
   │
   ▼
POST /api/catastrox/contact { service_type: "regularizacion_predial", ... } (Nivel 0/2)
   │  crea professional_service_lead — NUNCA order/order_item/price_snapshot/entitlement/artifact
   ▼
Gestión comercial (Nivel 5, administración) → cotización → contacto → eventual contrato/propuesta
   (fuera del alcance de generación automática de entregables y de este ADR)
```

## Anexo B. Matriz completa de rutas

*Ver §6 (inventario actual) y §7 (matriz definitiva conceptual) — reproducidas por referencia.*

## Anexo C. Matriz producto → entregable

| Producto (`packageId`) | PDF | KML | KMZ | SHP | DXF | Coords EPSG:9377 |
|---|---:|---:|---:|---:|---:|---:|
| `basico` (COP 39.900) | Sí | No | No | No | No | No |
| `plus` (COP 49.900) | Sí | Sí | Sí | No | No | No |
| `profesional` (COP 59.900) | Sí | Sí | Sí | Sí | Sí | Sí |

**Regularización Predial CRH no aparece en esta matriz** — no es un producto transaccional con entregables automáticos; es un servicio de cotización gestionado vía `professional_service_lead` (Anexo A.2).

## Anexo D. Máquina de estados de orden

```
draft ──▶ pending_payment ──▶ paid ──▶ preparing ──▶ ready
  │              │             │            │           │
  ▼              ▼             │            ▼           ▼
cancelled   payment_failed     │      delivery_failed  refunded
  │              │             │            │
  ▼              ▼             │            └──(reintento controlado)──▶ preparing
(terminal)  (retorna a         │
             pending_payment)  │
                                └─(1: entitlement creado; 2: paid→preparing;
                                   3: se crean N artifacts obligatorios del packageId;
                                   4: se inicia su generación)

ready ──▶ revoked (fraude/error/decisión administrativa, con auditoría — no implica reembolso automático)

ready:  "La orden está pagada y todos los artifacts incluidos en el paquete
         adquirido están disponibles para descarga."
```

## Anexo E. Modelo conceptual de entidades

*Ver §12 — reproducida por referencia.* Catálogo transaccional (§12.1): `customer`, `product` (exclusivamente `basico`/`plus`/`profesional`), `price_snapshot`, `order`, `order_item`, `payment_attempt`, `payment_event`, `entitlement`, `artifact`, `download_event`, `order_access_exchange_token`, `order_access_credential`, `parcel_reference`. Servicios profesionales no transaccionales (§12.2): `professional_service_lead` (`service_type = regularizacion_predial` u otros futuros) — entidad completamente separada del catálogo transaccional, sin relación de creación hacia `order`/`entitlement`/`artifact`.

## Anexo F. Matriz de autorización

| Nivel | Requiere | Verifica |
|---|---:|---|
| 0 | Nada | — |
| 1 | Rate limit | Frecuencia, formato de entrada |
| 2 | Rate limit + credencial de acceso de la orden (cookie) para `checkout`/`payment-verifications`/`GET orders/:id` | Orden pertenece al portador; monto/producto/moneda coherentes con la orden interna; `packageId` ∈ catálogo transaccional |
| 3 | Cookie de acceso de la orden | Orden `paid`/`preparing`/`ready`; para `POST orders/:id/artifacts`: formato ya obligatorio del entitlement, sin duplicar, sin cambiar de paquete, sin ampliar alcance, mismo predio |
| 4 | Sesión Cognito/BFF | `sub` vinculado a `customer.user_id` |
| 5 | Sesión + rol administrativo | Rol, acceso temporal/justificado/auditado; incluye gestión de `professional_service_lead` |

## Anexo G. Matriz de caché

*(Sin cambios respecto de la ronda anterior; todas las rutas de Nivel 2 en adelante son `no-store`, incluidas las de Regularización/leads.)*

## Anexo H. Matriz de amenazas

*Ver §27 — reproducida por referencia.*

## Anexo I. Matriz de trazabilidad ADR-001/003/004/005/006/007/008/009/010/011/012 → ADR-013

*Ver §35 — reproducida por referencia.*

---

## Cierre

### 1. Recomendación ejecutiva

Cerrar el hallazgo crítico heredado de ADR-005/ADR-007 mediante una fuente de verdad transaccional nueva (`order`/`entitlement`/`artifact`, viviendo en `agx`), un modelo de autorización por token de intercambio de un solo uso + cookie, verificación de pago como `POST` idempotente, y un ciclo de generación de artifacts que se dispara automáticamente al confirmarse el pago — nunca por decisión del navegador. Regularización Predial CRH queda excluida por completo del catálogo transaccional, representada como un lead de servicio profesional independiente. El catálogo comercial transaccional (Básico COP 39.900, Plus COP 49.900, Profesional COP 59.900) queda declarado oficial y aprobado en su totalidad.

### 2. Clasificación final de rutas

Seis niveles (0-5, §5/§7), con `POST orders/:id/artifacts` reclasificado exclusivamente como regeneración/reintento controlado, nunca como vía de primera generación.

### 3. Catálogo comercial oficial

`basico` (COP 39.900, PDF), `plus` (COP 49.900, PDF+KML+KMZ), `profesional` (COP 59.900, PDF+KML+KMZ+SHP+DXF+coords9377) — los tres, únicos productos transaccionales, aprobados. Regularización Predial CRH: servicio profesional de cotización, sin `packageId`, sin checkout, sin entitlement, sin artifact.

### 4. Matriz final producto → entregable

Ver Anexo C — Regularización explícitamente fuera de esta matriz.

### 5. Decisión de generación productiva de artifacts

Frontera server-side; **la generación inicial de todos los artifacts obligatorios de un paquete es automática, disparada por el propio backend al confirmar el pago y crear el entitlement** (`paid → preparing`); `ready` se alcanza únicamente cuando todos los artifacts obligatorios del paquete están disponibles.

### 6. Decisión de compra sin cuenta

Se permite, mediante `customer` (email/celular) + token de intercambio de un solo uso + cookie de acceso.

### 7. Decisión de token de intercambio y cookie

Token opaco, aleatorio, un solo uso, corta duración, hash almacenado, nunca en logs; cookie `HttpOnly`/`Secure`/`SameSite` acotado; redirección a URL limpia tras el intercambio; reacceso vía nuevo token.

### 8. Decisión de verificación de pago

`POST /orders/:id/payment-verifications`, idempotente, server-to-server contra Wompi; `GET /orders/:id` para consulta segura posterior; webhook futuro solo como complemento.

### 9. Decisión de autorización de resultado y artifacts

Verificación de siete condiciones antes de servir resultado, descargar o regenerar cualquier artifact; `POST orders/:id/artifacts` nunca permite pedir un formato no incluido, duplicar sin idempotencia, cambiar de paquete, ampliar el entitlement, ni generar para otro predio.

### 10. Máquina final de estados

`draft → pending_payment → paid → preparing → ready`, con `cancelled` (solo pre-pago), `payment_failed`↔`pending_payment`, `expired`, `delivery_failed`↔`preparing`, `refunded`, `revoked`. Definición cerrada de `ready`: "la orden está pagada y todos los artifacts incluidos en el paquete adquirido están disponibles para descarga."

### 11. Riesgos críticos

Frontera server-side de generación y su orquestación automática aún no implementadas; ausencia de idempotencia en checkout/verificación; CORS reflejado indiscriminadamente; guardas administrativas débiles; infraestructura de envío de enlaces no diseñada; orquestación técnica de generación múltiple (Profesional, 6 formatos) no diseñada en detalle.

### 12. Decisiones pendientes

Once decisiones de seguimiento (§34), incluidas las dos nuevas de esta versión: orquestación técnica exacta de la generación automática, y diseño mínimo de gestión comercial de `professional_service_lead`.

### 13. Información NO VERIFICADA

Contenido interno completo de `CatastroXMap.jsx`; si `priceCop` incluye IVA; comportamiento de Wompi con llave de producción; volumen/patrón real de tráfico; aleatoriedad del `lookupId` actual; límites de Cloudflare Pages Functions; estado real de flags de auditoría en producción; ausencia total de SQL no parametrizada en `catastrox.js`.

### 14. Archivos consultados

`server/routes/catastrox.js`, `server/routes/catastroxPayments.js`, `server/catastroxDb.js`, `server/index.js`, `functions/api/catastrox/[[path]].js` y su gemela de pagos, `public/service-worker.js`, `src/App.jsx`, `src/modules/catastrox/CatastroXApp.jsx`, servicios y páginas de `src/modules/catastrox/`, `catastroxPackages.js`, `catastroxDeliverables.js`, `CatastroXRegularizationPage.jsx`, `.env.example`, `server/.env.example`, `docs/adr/ADR-001` a `ADR-012`, `docs/architecture/AGROGENOMAX_TECHNICAL_ARCHITECTURE_HANDBOOK_V1.md`.

### 15. Contradicciones corregidas

Precios 36.000/60.000 vs. código: cerrada, catálogo oficial es el de código (§3.7/§10). Regularización mezclada conceptualmente con el catálogo transaccional en una ronda previa: corregida — queda excluida por completo, representada por `professional_service_lead` (§10/§12.2). Ambigüedad sobre cuándo se generan los artifacts y qué hace `POST orders/:id/artifacts`: corregida — generación inicial automática al pago, la ruta queda reservada a regeneración/reintento (§11/§13).

### 16. Confirmación de ausencia de modificaciones

No se modificó ningún archivo de código, ruta, frontend, backend, Cloudflare, PostgreSQL/PostGIS, Wompi, Terraform ni workflow. No se ejecutó ningún build, prueba, migración ni conexión externa. No se ejecutó `git add`, `git commit` ni `git push`. Únicamente se creó el archivo de este ADR.
