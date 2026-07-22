# LOTE-013 — Security Baseline: CatastroX (segunda mitad)

Estado: **COMPLETADO / VALIDADO**. Este cierre corresponde exclusivamente al alcance de LOTE-013 (segunda mitad): auditoría SQL de `server/routes/catastrox.js` y `server/routes/catastroxPayments.js`, corrección de la entropía de `lookupId` y las correcciones puntuales descritas en §4. Todos los riesgos residuales listados en §6 permanecen abiertos como seguimientos separados y no se declaran resueltos por este cierre. Este documento describe cambios realizados en código fuente. Ninguna consulta SQL contra base de datos real, AWS, Terraform ni despliegue fue ejecutado como parte de esta tarea.

## 1. Alcance y metodología

Alcance: `server/routes/catastrox.js` (rutas y consultas SQL de CatastroX) y `server/routes/catastroxPayments.js`, conforme al Plan Maestro y ADR-013 §22 (identificadores de posesión) y §31 (higiene SQL).

Metodología:
- Revisión estática línea por línea del archivo `server/routes/catastrox.js`.
- Revisión estática de `server/routes/catastroxPayments.js` para confirmar si construye o ejecuta SQL.
- `server/catastroxDb.js` se consultó únicamente como apoyo para entender el wrapper de `query` usado por `catastrox.js`, cuando correspondió; no forma parte del alcance auditado de este documento.
- Inventario de cada llamada a `catastroxQuery`/`query` con su texto SQL y su arreglo de parámetros.
- Clasificación de cada consulta según si concatena/interpola valores derivados de entrada de cliente dentro del texto SQL, o si usa exclusivamente parámetros posicionales (`$1`, `$2`, ...).
- Revisión del ciclo de vida de `lookupId` (generación, lectura, escritura, endpoints que lo aceptan) por ser la clave de posesión que protege `preview-map`, `preview-geometry` y `full-result`.
- No se ejecutó ninguna consulta contra base de datos real ni se levantó el servidor.

## 2. Inventario de consultas SQL auditadas

| Consulta | Ubicación (función/ruta) | Entrada de cliente involucrada | Clasificación |
|---|---|---|---|
| `findMunicipioByPoint` (directMatch) | helper interno | lat/lng | Parametrizada ($1,$2) — segura |
| `findMunicipioByPoint` (nearestMatch) | helper interno | lat/lng | Parametrizada ($1,$2) — segura |
| `findCleanPredioByPoint` | helper interno | lat/lng | Parametrizada ($1,$2,$3) — segura |
| `cleanCandidateProvider` | modo sombra (candidateProvider) | codigoPredial (derivado de fila DB, no de body) | Parametrizada ($1) — segura |
| `crossSourceCleanProbe` | modo sombra (crossSourceProbe) | lat/lng | Parametrizada ($1,$2,$3). `LIMIT` interpolado, pero con constante numérica fija `CROSS_SOURCE_PROBE_QUERY_LIMIT = 200`, no derivada de cliente — segura |
| Query principal `POST /lookup` | `router.post('/lookup')` | lat/lng | Parametrizada ($1,$2) — segura |
| `buildLookupByCodeQuery` | `findPredioByCadastralCode` / `POST /lookup-by-code` | `codigo` (normalizado y validado a 20/30 dígitos) | `column` interpolado en texto SQL, pero proviene de una allowlist cerrada de dos identificadores fijos (`codigo_anterior`, `codigo_predial`) seleccionados por longitud del código ya validado — no es un valor SQL arbitrario del cliente. Valor del código va como `$1`. Clasificado como **seguro por diseño (allowlist cerrada)**. No modificado en este lote, conforme a instrucción explícita. |
| `CLEAN_FULL_RESULT_QUERY` | `buildLookupFullResultPayload` | `preview.codigoPredial` (derivado de estado server-side, no de body directo) | Parametrizada ($1,$2) — segura |
| `CLEAN_FULL_RESULT_BY_POINT_QUERY` | `buildLookupFullResultPayload` | `preview.queryPoint` / `row.query_lat/lng` (derivados de estado server-side) | **Corregida en este lote**: antes interpolaba `CATASTROX_ORIGEN_NACIONAL_PROJ` como literal de texto dentro del SQL; ahora usa parámetro posicional `$3`. Ver §4. |
| `LEGACY_FULL_RESULT_QUERY` | `buildLookupFullResultPayload` | `preview.predioId` (derivado de estado server-side) | Parametrizada ($1) — segura |
| Queries de `preview-map` (clean/legacy) | `GET /lookups/:lookupId/preview-map` | `preview.codigoPredial` / `preview.predioId` (server-side) | Parametrizadas ($1,$2 / $1) — seguras |
| Queries de `preview-geometry` (clean/legacy) | `GET /lookups/:lookupId/preview-geometry` | `preview.codigoPredial` / `preview.predioId` (server-side) | Parametrizadas ($1,$2 / $1) — seguras |
| Query `POST /advanced/lookup` | `router.post('/advanced/lookup')` | lat/lng | Parametrizada ($1,$2,$3) — segura |
| `server/routes/catastroxPayments.js` (archivo completo) | rutas de pagos (Wompi) | N/A | No construye ni ejecuta consultas SQL; no aplica parametrización. Su integración HTTP con Wompi no fue auditada integralmente en este documento, cuyo alcance es exclusivamente SQL. |

`LIMIT 1` fijo presente en varias consultas (`findMunicipioByPoint`, `findCleanPredioByPoint`, query principal de `/lookup`, `buildLookupByCodeQuery` vía filas resultantes, `advanced/lookup`, etc.) es una constante literal en el texto SQL, no derivada de entrada de cliente. No requiere parametrización.

## 3. Conclusión

LOTE-013 cumple su criterio de aceptación. No existe SQL no parametrizada explotable por el cliente en ninguno de los dos archivos auditados: `server/routes/catastrox.js` y `server/routes/catastroxPayments.js`. `lookupId` usa ahora 122 bits aleatorios de UUID v4 mediante CSPRNG (`crypto.randomUUID()`); `POST /advanced/lookup` genera el identificador exclusivamente server-side; y la constante `CATASTROX_ORIGEN_NACIONAL_PROJ` en `CLEAN_FULL_RESULT_BY_POINT_QUERY` usa el parámetro posicional `$3`. En `catastrox.js`, tras las correcciones de este lote, los dos únicos puntos donde el texto SQL contiene interpolación de valores no puramente literales son:

- `column` en `buildLookupByCodeQuery`: protegido por allowlist cerrada de dos identificadores fijos derivados de la longitud del código ya validado (20 → `codigo_anterior`, 30 → `codigo_predial`). No es alcanzable por el cliente como cadena arbitraria.
- `LIMIT` en `crossSourceCleanProbe`: constante numérica fija (`CROSS_SOURCE_PROBE_QUERY_LIMIT = 200`), no derivada de entrada de cliente.

Ambos casos quedan documentados y sin modificar, conforme a instrucción explícita del lote. `catastroxPayments.js` no construye ni ejecuta SQL, por lo que no aplica clasificación de parametrización.

## 4. Hallazgo original y correcciones aplicadas

### 4.1 Hallazgo: generación no criptográfica de `lookupId`

`lookupId` es la clave de posesión que protege el acceso a `preview-map`, `preview-geometry` y `full-result` (ADR-013 §22). La implementación previa generaba el identificador combinando `Date.now().toString(36)` y `Math.random().toString(36)`. `Math.random()` no es un generador criptográficamente seguro y su salida es, en distintos entornos, predecible o de espacio de búsqueda reducido cuando se combina con un timestamp de baja entropía. Esto exponía el identificador de posesión a un riesgo teórico de adivinación/enumeración por parte de un cliente no autorizado.

En términos de espacio de búsqueda: un fragmento de 6 caracteres en base36 tiene una cota máxima teórica de 36^6 ≈ 2.176.782.336 combinaciones, equivalente a aproximadamente 31 bits, y esa cota es un techo, no una garantía de distribución uniforme sobre el rango completo. `Date.now()` no aporta entropía secreta al identificador, porque el momento de generación es observable o acotable por un atacante (por ejemplo, a partir de la respuesta HTTP u otra señal de temporización), reduciendo aún más el espacio efectivo de búsqueda. Esta cota no depende de una implementación concreta del motor JavaScript (V8 u otro); es una propiedad del formato de codificación en sí. En contraste, un UUID v4 generado con `crypto.randomUUID()` aporta 122 bits aleatorios (los 6 bits restantes de los 128 totales están fijados por la versión y variante del UUID) y proviene de un generador criptográficamente seguro (CSPRNG) provisto por `node:crypto`.

Adicionalmente, la ruta `POST /advanced/lookup` permitía que el cliente enviara `lookup_id` o `routeId` en el body y, si estaban presentes, la ruta los usaba directamente como clave de posesión en lugar de generarla en el servidor. Esto permitía que un cliente fijara, sobrescribiera o reutilizara la clave de posesión a voluntad, socavando cualquier garantía de que `lookupId` identifica de forma única y no manipulable una consulta servida por el backend.

### 4.2 Correcciones aplicadas

1. **CSPRNG para `lookupId`**: `buildLookupId` ahora usa `randomUUID()` de `node:crypto` y devuelve exactamente `cx-${randomUUID()}`. Se eliminó todo uso de `Date.now()` y `Math.random()` en la generación. `buildLookupId` se exporta como función nombrada para permitir su prueba directa.
2. **Generación server-side obligatoria en `advanced/lookup`**: se eliminó la lectura de `req.body.lookup_id` / `req.body.routeId` para escoger el identificador. La ruta ahora usa siempre `const lookupId = buildLookupId();`. El cliente ya no puede fijar, sobrescribir ni reutilizar la clave de posesión, y su valor enviado (si lo hubiera) no se lee ni se refleja.
3. **Parametrización de `CATASTROX_ORIGEN_NACIONAL_PROJ` en `CLEAN_FULL_RESULT_BY_POINT_QUERY`**: se reemplazó la interpolación literal del string de proyección PROJ dentro del texto SQL por el parámetro posicional `$3`. El tercer valor ya existente en los arreglos de parámetros de las dos llamadas a esta consulta se conserva sin cambios de semántica.

## 5. Pruebas creadas

Archivo: `server/routes/__tests__/catastroxLookupId.test.js` (usa exclusivamente `node:test` y `node:assert`; sin servidor real, sin base de datos, sin red).

- Formato del identificador: `cx-` + UUID v4 válido.
- Unicidad sobre una muestra de 10.000 generaciones de `buildLookupId`.
- Compatibilidad segura con `encodeURIComponent` (idempotente) y uso como clave de `Map`.
- Regresión por inspección estática acotada del código fuente de `buildLookupId`: ausencia de `Date.now` y `Math.random`, presencia de `randomUUID`.
- Regresión por inspección estática acotada de la ruta `/advanced/lookup`: ausencia de lectura de `req.body.lookup_id` / `req.body.routeId` / `requestedLookupId`, presencia de `const lookupId = buildLookupId();`.
- Regresión por inspección estática acotada de `CLEAN_FULL_RESULT_BY_POINT_QUERY`: presencia de `$3` y ausencia de interpolación literal `${CATASTROX_ORIGEN_NACIONAL_PROJ}` en el texto SQL.

**Estas pruebas fueron ejecutadas y validadas.** Ver §7 para la evidencia de ejecución.

## 6. Riesgos residuales (seguimiento separado, no cerrados en este lote)

- **Ausencia de rate limiting específico en endpoints de consumo**: `POST /lookup`, `GET /lookups/:lookupId/preview-map`, `GET /lookups/:lookupId/preview-geometry` y `GET /lookups/:lookupId/full-result` no tienen límite de tasa propio (a diferencia de `POST /lookup-by-code`, que sí lo tiene vía `enforceLookupByCodeRateLimit`).
- **`lookupPreviewStore` es un `Map` en memoria sin límite de tamaño ni barrido activo**: las entradas expiran de forma pasiva (TTL de 30 minutos verificado solo al leer con `resolveLookupPreview`), pero no hay una tarea periódica que las purgue proactivamente ni un límite máximo de entradas, a diferencia del buffer del modo sombra (`maxEntries: 200`).
- **Estado no compartido entre múltiples instancias del proceso/tarea**: al ser un `Map` en memoria de un solo proceso, un `lookupId` generado en una instancia no es resoluble desde otra instancia en un despliegue con más de una réplica/tarea.
- **`full-result` (y su variante `audit/full-result`) deprecados, pendientes de migración a un modelo de `orders`/`entitlements`**: el acceso a los datos completos del predio depende únicamente de la posesión del `lookupId` (mitigada en este lote al hacerlo impredecible y no fijable por el cliente), no de una verificación real de compra/orden asociada.

Estos riesgos se documentan como seguimiento independiente y no se abordan en LOTE-013 (segunda mitad), conforme a las restricciones de alcance del lote (no rate limiting, no rediseño de `lookupPreviewStore`).

## 7. Resultado de validación y aceptación

### 7.1 Prueba específica: `catastroxLookupId.test.js`

Comando ejecutado:

```
node --test server/routes/__tests__/catastroxLookupId.test.js
```

Resultado: 6 tests, 6 pass, 0 fail, 0 skipped/cancelled/todo. Duración total: 457.4041 ms.

### 7.2 Suite backend completa

El comando `node --test server` no constituyó una ejecución válida de la suite: Node interpretó la carpeta/entrypoint y `server/index.js` aplicó correctamente el fail-fast `APP_ENV_MISSING`. Este resultado no fue una regresión del código; fue un uso incorrecto del comando `node --test` sobre un directorio. Quedó sustituido por la enumeración explícita de los archivos de prueba mediante el siguiente comando, que sí constituye una ejecución válida de la suite completa:

```powershell
$tests = Get-ChildItem "server" -Recurse -File -Filter "*.test.js" | Where-Object { $_.FullName -notlike "*\server\sql\*" } | Select-Object -ExpandProperty FullName; node --test $tests
```

Resultado: 411 tests, 29 suites, 411 pass, 0 fail, 0 skipped/cancelled/todo. Duración total: 1018.3164 ms. Ninguna conexión a base de datos real ni consulta SQL fue ejecutada por estas pruebas.

### 7.3 Conclusión de aceptación

LOTE-013 cumple su criterio de aceptación con base en la evidencia anterior. Los riesgos residuales listados en §6 no fueron resueltos por este cierre y quedan como seguimientos separados.
