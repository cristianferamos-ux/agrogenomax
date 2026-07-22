# CatastroX — Modo sombra del resolver (v1)

## Propósito

El modo sombra ejecuta la política de resolución de duplicados
([catastroxResolutionPolicy.js](../../server/services/catastrox/catastroxResolutionPolicy.js))
en paralelo al flujo real de `POST /api/catastrox/lookup`, exclusivamente para
**observar** qué decidiría la política V1 sobre consultas reales — sin
otorgarle ninguna autoridad sobre lo que el usuario recibe. Es el primer paso
hacia una eventual integración real: antes de dejar que el resolver decida
nada, se necesita evidencia de cómo se comporta contra tráfico real.

## Limitaciones (lo que el modo sombra explícitamente NO hace)

- No decide, filtra ni modifica la respuesta de `/lookup`.
- No cambia la precedencia actual `legacy primero → clean fallback`.
- No influye en la selección de fuente (`source: 'legacy' | 'clean'`).
- No afecta PDF, KML, KMZ, SHP ni DXF.
- No afecta la interfaz ni ningún componente de React.
- No afecta pagos ni compras.
- No escribe en la base de datos ni en disco.
- No es persistente: toda la telemetría vive en memoria de proceso y se pierde
  al reiniciar el servidor.

## Feature flag

```
CATASTROX_RESOLVER_SHADOW_ENABLED=true
```

- **Valor por defecto: `false`** (desactivado). Si la variable no está
  definida, o tiene cualquier valor distinto de `"true"` (case-insensitive),
  el modo sombra permanece apagado.
- No se modificó `.env` ni `.env.example` — esta variable no existe todavía en
  ningún archivo de entorno versionado ni real; se activa exclusivamente
  exportándola en la shell antes de levantar el servidor.
- Con el flag desactivado, `evaluateLookupInShadow(...)` devuelve `NO_OP` de
  forma síncrona, **sin invocar `candidateProvider` ni el resolver** — cero
  consultas adicionales a PostGIS.

### Cómo activarlo localmente

```bash
# PowerShell
$env:CATASTROX_RESOLVER_SHADOW_ENABLED = "true"
node server/index.js
```

```bash
# bash
CATASTROX_RESOLVER_SHADOW_ENABLED=true node server/index.js
```

### Cómo desactivarlo

Basta con no definir la variable, definirla en `false`, o detener el proceso.
No hay ningún estado persistente que limpiar: al reiniciar el servidor sin la
variable, el modo sombra vuelve a su estado por defecto (apagado) y el búfer
de telemetría en memoria desaparece con el proceso anterior.

## Matriz estática V1

`server/data/catastrox/catastroxDuplicateResolutionMatrix.v1.json` es una
**fotografía versionada** de la clasificación geométrica/atributiva de los 549
códigos prediales duplicados detectados en `catastrox_clean.predios`, generada
a partir de la auditoría previa (commit de origen: `sourceCommit` dentro del
propio archivo). Contiene únicamente:

```json
{
  "version": "1.0.0",
  "sourceCommit": "...",
  "classificationSource": "catastrox_clean.predios",
  "counts": { "AUTO_RESOLVED": 351, "PENDING_POLICY": 47, "BLOCKED_REVIEW": 151, "BLOCKED_CRITICAL": 0, "total": 549 },
  "entries": { "<codigoPredial>": { "geometryStatus": "...", "attributeStatus": "...", "reasonCodes": [] } }
}
```

Puntos importantes:

- El archivo productivo **no depende de `audit_outputs/` en tiempo de
  ejecución**: `audit_outputs/` es una carpeta de scratch, ignorada por git, que
  se usó únicamente para *generar* este archivo una vez; el servicio de sombra
  solo lee `server/data/catastrox/catastroxDuplicateResolutionMatrix.v1.json`.
- Es una **fotografía de clasificación**, no una fuente de vigencia oficial:
  no reemplaza ninguna consulta en vivo, no se actualiza automáticamente si
  cambian los datos subyacentes, y no debe interpretarse como "estado actual
  garantizado" de esos 549 códigos.
- Los dos casos previamente investigados por sospecha de contradicción
  territorial (zona rural/urbano y manzana compuesta por ceros) quedan en la
  matriz como `geometryStatus: MATERIAL_CONFLICT` con `attributeStatus`
  distinto de `TERRITORIAL_CRITICAL` (`NORMALIZATION_SUSPECT` y
  `COMPLEMENTARY` respectivamente) — **nunca críticos** — consistente con la
  validación documentada en `audit_outputs/catastrox/resolver_design/critical_cases_validation.md`.
- 47 códigos quedan en `PENDING_POLICY`: la política V1 aún no tiene un
  criterio aprobado para elegir representante en esos casos (ver
  [CATASTROX_RESOLUTION_POLICY_V1.md](CATASTROX_RESOLUTION_POLICY_V1.md)).

### Degradación segura ante una matriz inválida

Al importarse, el módulo carga y valida la matriz una única vez
(`loadResolutionMatrixFromFile` + `validateResolutionMatrixShape`): verifica
que exista `version`, que haya exactamente 549 entradas con códigos únicos y
no vacíos, que cada `geometryStatus`/`attributeStatus` sea uno de los valores
conocidos, que ninguna entrada tenga campos fuera de
`geometryStatus`/`attributeStatus`/`reasonCodes` (blindaje adicional contra
una futura fuga accidental de coordenadas u otro dato en el archivo de la
matriz), y que los `counts` declarados coincidan exactamente con lo que las
propias entradas implican.

Si cualquiera de esas verificaciones falla —archivo ausente, JSON mal
formado, forma incoherente—, la carga **nunca lanza una excepción hacia el
resto de la aplicación**. En su lugar:

- El módulo de sombra queda forzosamente **desactivado**
  (`enabled: false` en `getShadowSummary()`), sin importar el valor del flag
  `CATASTROX_RESOLVER_SHADOW_ENABLED`.
- `evaluateLookupInShadow` se comporta como si el flag estuviera apagado:
  `NO_OP` inmediato, cero llamadas a `candidateProvider`, cero telemetría.
- El fallo queda disponible únicamente como un estado técnico resumido:
  `getShadowSummary().matrixError = { code: 'MATRIX_LOAD_ERROR', message: '...' }`,
  con un mensaje corto y genérico — **nunca** se registra ni se expone la
  matriz completa, el contenido del archivo, ni ningún dato de predios.
- `server/routes/catastrox.js`, `/lookup`, y el resto de la API **siguen
  arrancando y funcionando con normalidad**: la instanciación de
  `createCatastroxResolverShadow(...)` nunca lanza, incluso con una matriz
  inválida.

Esta tolerancia es exclusiva de la carga y validación de este archivo de
datos — nunca oculta errores de sintaxis genuinos en el código productivo del
resto del módulo o de la ruta.

## Información registrada

Cada evaluación exitosa o fallida agrega **como máximo** un registro a un
búfer circular en memoria (máximo 200 registros; el más antiguo se descarta
primero):

```js
{
  timestamp,                  // instante de la evaluacion (epoch ms)
  matrixVersion,               // version de la matriz usada
  lookupId,                    // el lookup_id de ESTA solicitud especifica (el mismo que recibio el cliente en ESA respuesta; no es comparable entre solicitudes distintas)
  codigoPredial,
  currentSource,                // 'legacy' | 'clean' (lo que /lookup ya eligio)
  currentSourceRecordId,        // identificador tecnico interno de esa fila
  resolutionStatus,             // salida de catastroxResolutionPolicy, o null si hubo error o divergencia
  candidateSelectionStatus,
  policySelectedTechnicalKey,   // "source::sourceRecordId" del representante elegido por la politica, o null
  comparisonStatus,             // ver tabla abajo
  reasonCodes,                  // reason codes de la politica o del sondeo cruzado, segun el caso
  evaluationMs,                 // duracion de la evaluacion
  errorCode,                    // null, o el codigo de error aislado
  alternateSource,               // V1.1 — 'clean', o null si no hubo sondeo cruzado
  alternateCodeCount,             // V1.1 — cantidad REAL de codigos clean distintos (anterior al limite de la consulta SQL), aunque el arreglo de abajo este truncado
  alternateRecordCount,           // V1.1 — cantidad REAL de filas fisicas clean encontradas (suma de todos los sourceRecordIds de todos los codigos), anterior al limite de la consulta SQL
  alternateCandidates,             // V1.1 — arreglo [{codigoPredial, sourceRecordIds:[...]}] POR CODIGO, nunca un candidato "elegido" unico ni un unico fid
  alternateCandidatesTruncated,    // V1.1 — true si alternateCodeCount > MAX_ALTERNATE_CANDIDATES (10): truncamiento de TELEMETRIA
  crossSourceProbeTruncated,       // V1.1 — true si la propia consulta SQL ya alcanzo su limite operativo (200 codigos): truncamiento de CONSULTA
  relationStatus,                 // V1.1 — resultado (posiblemente corregido) del sondeo cruzado, o null si no se ejecuto
}
```

Todo registro —incluidos los de la política V1 original— siempre incluye estos
siete campos de V1.1, en `null`/`0`/`[]`/`false` cuando no hubo sondeo cruzado.
La forma del registro es fija y completa desde su construcción (`baseRecord`
en `catastroxResolverShadow.js`) — nunca se compone parcialmente ni por mezcla
del objeto de entrada, precisamente para que las coordenadas efímeras del
input (ver V1.1 más abajo) no puedan filtrarse accidentalmente a ningún campo
persistido.

**`alternateCandidates` es un contrato POR CÓDIGO, no por fila, y nunca un
campo singular.** Cada elemento de `alternateCandidates` representa **un
código `clean` observado espacialmente en el mismo punto** —no un "predio
equivalente" ni una afirmación de identidad con el predio legacy— y agrupa
**todos** los identificadores técnicos (`fid`) encontrados para ese código en
`sourceRecordIds`, un arreglo, nunca un único valor elegido. Dos versiones
previas de este contrato fueron corregidas hasta llegar a esta forma:

1. La primera versión exponía `alternateCodigoPredial`/`alternateSourceRecordId`
   como campos **singulares**, ambiguos cuando había más de un código.
2. La segunda versión introdujo `alternateCandidates` como arreglo, pero cada
   candidato todavía tenía un único `sourceRecordId` — lo que obligaba a
   elegir un `fid` representativo (aunque fuera solo el primero encontrado)
   cuando un mismo código tenía varias filas físicas.

La versión definitiva (`sourceRecordIds: string[]`) elimina esa última
selección implícita: **ningún `fid` representa vigencia oficial**, todos los
identificadores encontrados para un código quedan expuestos por igual.
`sourceRecordIds` es exclusivamente trazabilidad técnica para poder rastrear,
si hiciera falta, de qué filas físicas de `catastrox_clean.predios` proviene
la observación — nunca un criterio de selección.

### Valores de `comparisonStatus`

| Valor | Significado |
|---|---|
| `MATCH` | La política V1 (resuelta contra candidatos `clean`) elige el mismo representante técnico que ya devolvió `/lookup`. |
| `DIFFERENT_TECHNICAL_REPRESENTATIVE` | La política resuelve `AUTO_RESOLVED` con `currentSource='clean'`, pero elige un representante técnico distinto al que `/lookup` ya devolvió. |
| `SOURCE_NOT_COMPARABLE` | `/lookup` sirvió el resultado desde la fuente `legacy`; la matriz y los candidatos de la política son exclusivamente de `clean`, por lo que no hay una comparación técnica válida (nunca se mezclan candidatos legacy y clean). |
| `PENDING_POLICY` | La política V1 no tiene todavía un criterio aprobado para ese código (`resolutionStatus = PENDING_POLICY`); no hay representante que comparar. |
| `CURRENT_FLOW_WOULD_BE_BLOCKED` | La política bloquearía este código (`BLOCKED_REVIEW` o `BLOCKED_CRITICAL`) aunque `/lookup` sí devolvió un resultado — la señal de observación más importante de esta fase. |
| `EVALUATION_ERROR` | La evaluación falló (error contractual del resolver, error del proveedor de candidatos, o error del sondeo cruzado); el error quedó aislado dentro del modo sombra y nunca llegó a `/lookup`. |
| `SOURCE_CODE_DIVERGENCE` | **(V1.1)** `/lookup` sirvió un código `legacy` no clasificado, y el sondeo cruzado encontró uno o más códigos `clean` distintos cubriendo el mismo punto. La política **nunca** se ejecuta en este estado. |

## Información expresamente prohibida

El servicio de sombra **nunca** almacena, ni siquiera transitoriamente:

- Coordenadas (`lat`/`lng`) ni ningún dato geográfico.
- Geometría, GeoJSON, ni ninguna forma derivada de ella.
- Dirección, barrio, nombre de predio, nombre de propietario, ni ningún otro
  dato personal o identificable más allá del código predial y del identificador
  técnico de trazabilidad (`fid` de `catastrox_clean.predios`, o el `id` interno
  de `gis.catastro_caqueta`).
- El cuerpo completo de la respuesta HTTP que recibió el cliente.
- Sentencias SQL (el módulo de sombra nunca ejecuta SQL directamente; toda
  consulta a PostGIS ocurre a través de `candidateProvider` y, desde V1.1,
  `crossSourceProbe` — ambas dependencias inyectadas por quien instancia el
  servicio — en producción, `server/routes/catastrox.js`).

Este contrato está verificado por pruebas automatizadas (ver
`server/services/catastrox/__tests__/catastroxResolverShadow.test.js`), que
revisan tanto la forma exacta de cada registro de telemetría (incluidos los de
divergencia) como el código fuente del propio módulo.

## V1.1 — Observación de divergencia legacy/clean

### Causa técnica

`gis.catastro_caqueta` (fuente `legacy`) y `catastrox_clean.predios` (fuente
`clean`) mantienen espacios de `codigo_predial` completamente independientes,
sin ningún campo de equivalencia documentado en el esquema actual. Cuando un
punto de `/lookup` cae dentro de un predio `legacy` cuyo `codigo` no forma
parte de los 549 duplicados auditados (todos ellos exclusivamente `clean`),
la versión V1 del modo sombra respondía `NOT_APPLICABLE` sin más contexto —
indistinguible de un código genuinamente no duplicado. Una investigación
forense (`audit_outputs/catastrox/resolver_shadow_missing_evaluations/root_cause.md`)
confirmó, con evidencia real, que en varios de esos casos el punto
efectivamente coincide con uno o más predios `clean` de código distinto — es
decir, existe una **divergencia de identificador entre fuentes para el mismo
punto geográfico**, no un error del sistema.

### Contrato de `crossSourceProbe`

Dependencia inyectada (nunca implementada dentro del módulo puro), con la
firma:

```js
crossSourceProbe({ lat, lng, currentSource, currentCodigoPredial })
  => Promise<{
       found: boolean,
       alternateSource: 'clean' | null,
       alternateCandidates: Array<{ codigoPredial: string, sourceRecordIds: string[] }>,
       totalCodeCount?: number,      // conteo REAL de codigos, anterior al limite SQL
       totalRecordCount?: number,    // conteo REAL de filas, anterior al limite SQL
       queryResultTruncated?: boolean,
       relationStatus: 'SAME_CODE' | 'DIFFERENT_CODE' | 'NO_CLEAN_MATCH'
                      | 'MULTIPLE_CLEAN_CODES' | 'PROBE_ERROR',
     }>
```

`alternateCandidates` es **siempre un arreglo** (posiblemente vacío) — nunca
un campo singular, y cada elemento agrupa **todos** los `sourceRecordIds` de
ese código, nunca uno solo. `catastroxResolverShadow.js` nunca confía
ciegamente en lo que la implementación inyectada devuelva: antes de almacenar
cualquier candidato en el búfer, `normalizeAlternateCandidates` (interna al
módulo):

1. Descarta entradas sin `codigoPredial` válido.
2. **Fusiona por código**: si el mismo `codigoPredial` aparece en más de una
   entrada de entrada, sus `sourceRecordIds` se combinan en un único grupo.
3. **Elimina identificadores técnicos duplicados** dentro de cada grupo — el
   mismo `fid` repetido para un código nunca produce dos entradas en
   `sourceRecordIds`.
4. **Ordena deterministamente**: los identificadores de cada grupo,
   numéricamente cuando son válidos como número (caso normal de un `fid`);
   los propios códigos, alfabéticamente. Nunca por área, `ctid` ni orden
   físico de llegada. El mismo conjunto de candidatos, en cualquier orden de
   entrada, produce siempre la misma telemetría (verificado por prueba
   automatizada).
5. **Nunca elige un candidato ni un identificador "principal"**: el resultado
   es siempre la lista completa de códigos (hasta el límite operativo), cada
   uno con la lista completa de sus identificadores — jamás reducidos a un
   único ganador.
6. Trunca a `MAX_ALTERNATE_CANDIDATES` (**10 códigos**, no 10 filas) para el
   registro almacenado (`alternateCandidatesTruncated = true` cuando aplica),
   pero `alternateCodeCount`/`alternateRecordCount` siempre reflejan el
   conteo real — preferentemente el que reporta el propio `crossSourceProbe`
   (`totalCodeCount`/`totalRecordCount`, calculado antes de su límite SQL);
   solo si el probe no los suministra, se usa un cálculo local de respaldo
   (que entonces solo puede reflejar lo que el probe ya decidió devolver).

**Diferencia entre truncamiento de consulta y truncamiento de telemetría**:
son dos límites independientes, con dos banderas independientes.

| Bandera | Capa | Significado |
|---|---|---|
| `crossSourceProbeTruncated` | Consulta SQL | La propia consulta ya alcanzó su límite operativo (`CROSS_SOURCE_PROBE_QUERY_LIMIT = 200` códigos) antes de que este módulo viera el resultado. |
| `alternateCandidatesTruncated` | Telemetría | Este módulo recibió más de `MAX_ALTERNATE_CANDIDATES` (10) códigos y truncó el arreglo almacenado — independientemente de si la consulta SQL ya estaba truncada o no. |

Si `crossSourceProbeTruncated = true`, es matemáticamente imposible que exista
un único código (el truncamiento en sí mismo demuestra que hay al menos dos),
por lo que `catastroxResolverShadow.js` **fuerza** `relationStatus =
MULTIPLE_CLEAN_CODES` sin importar lo que el `crossSourceProbe` haya
autoreportado — salvo que el propio probe reporte `PROBE_ERROR`, que nunca se
reinterpreta como divergencia.

La implementación real (`crossSourceCleanProbe` en `server/routes/catastrox.js`)
consulta, de solo lectura, qué código(s) de `catastrox_clean.predios` cubren
el mismo punto que ya usó `/lookup`. Usa `array_agg(fid order by fid)` para
agrupar **todos** los `fid` de cada `codigo_predial` (nunca `MIN(fid)` ni
`MAX(fid)` ni ninguna otra selección arbitraria de un único identificador), y
calcula `totalCodeCount`/`totalRecordCount` con funciones de ventana
(`count(*) over ()`, `sum(...) over ()`) evaluadas sobre el conjunto ya
agrupado por código — **antes** de que la cláusula `LIMIT` final recorte las
filas devueltas, por lo que reflejan el universo real, no solo lo que la
consulta decide devolver. El límite operativo de la consulta es de **200
códigos** (`CROSS_SOURCE_PROBE_QUERY_LIMIT`) — una salvaguarda de rendimiento,
muy por encima del límite de exhibición de 10 códigos que aplica
`catastroxResolverShadow.js` sobre el resultado. Nunca ejecuta una escritura
ni modifica ningún dato.

### Regla `SOURCE_CODE_DIVERGENCE`

Se activa **exclusivamente** cuando: (1) `/lookup` sirvió un código `legacy`;
(2) ese código no está en la matriz; (3) el sondeo cruzado encuentra código(s)
`clean` en el mismo punto; (4) esos códigos son distintos entre sí (o la
propia consulta ya estaba truncada, lo cual implica lo mismo). Ante esa
divergencia:

- `comparisonStatus = SOURCE_CODE_DIVERGENCE`.
- `resolutionStatus`, `candidateSelectionStatus` y `policySelectedTechnicalKey`
  quedan en `null` — **la política nunca se ejecuta** sobre ningún código
  alternativo, aunque la consulta esté truncada.
- `codigoPredial` conserva siempre el código `legacy` original, servido
  realmente por `/lookup`. **Nunca se sustituye** por ninguno de los
  candidatos de `alternateCandidates`, ni por ninguno de sus
  `sourceRecordIds` (verificado por prueba automatizada). Un "candidato
  alternativo" en este contrato significa **un código observado
  espacialmente en el mismo punto** — nunca una afirmación de que ese predio
  sea equivalente u oficialmente correspondiente al legacy servido.
- Cuando el sondeo encuentra un único código clean distinto
  (`relationStatus=DIFFERENT_CODE`), `reasonCodes = ['SOURCE_CODE_DIVERGENCE']`
  y `alternateCandidates` contiene exactamente una entrada
  (`alternateCodeCount = 1`, con todos los `sourceRecordIds` de ese código).
- Cuando el sondeo encuentra más de un código clean en el mismo punto
  (`relationStatus=MULTIPLE_CLEAN_CODES` — el caso real de los tres códigos
  del diagnóstico forense, confirmado con 2 y 3 candidatos respectivamente),
  `reasonCodes = ['MULTIPLE_CLEAN_CODES_AT_LOOKUP_POINT']` y
  `alternateCandidates` contiene todos los códigos encontrados
  (`alternateCodeCount >= 2`): ante ambigüedad genuina, el sistema **nunca
  elige** uno de los candidatos por su cuenta — expone la lista completa.
- Si el sondeo no encuentra ningún código clean (`NO_CLEAN_MATCH`), o el
  código clean encontrado coincide con el legacy ya confirmado no clasificado
  (`SAME_CODE`), el resultado sigue siendo `NOT_APPLICABLE` — sin registro
  nuevo de telemetría.
- Si el sondeo falla (lanza una excepción, o devuelve
  `relationStatus=PROBE_ERROR`), el resultado es `comparisonStatus =
  EVALUATION_ERROR` con `errorCode = CROSS_SOURCE_PROBE_ERROR`, aislado igual
  que cualquier otro error del modo sombra — nunca llega a `/lookup`.

### Coordenadas efímeras

`evaluateLookupInShadow(input)` acepta opcionalmente `lat`/`lng` en el objeto
de entrada, **únicamente** para poder invocar `crossSourceProbe` cuando
corresponde. Esas coordenadas:

- nunca se escriben en el búfer de telemetría (`baseRecord` no las acepta
  como parámetro; el registro se construye siempre por campos nombrados,
  nunca por composición o `spread` del input);
- nunca se devuelven en ningún endpoint (`getShadowEvaluations()` expone
  exactamente los mismos campos que el búfer interno);
- nunca se escriben en logs (el módulo no usa `console.log` en ningún punto,
  verificado por prueba automatizada);
- nunca se incorporan a `reasonCodes` (que son siempre constantes fijas);
- no se persisten de ninguna forma — se descartan al retornar de
  `evaluateLookupInShadow`.

`server/routes/catastrox.js` reutiliza las mismas variables `lat`/`lng` ya
parseadas al inicio de `/lookup` para la consulta real — nunca vuelve a leer
`req.body` dentro del disparador asíncrono (`scheduleResolverShadowEvaluation`).

## Endpoints locales

```
GET    /api/catastrox/audit/resolver-shadow
DELETE /api/catastrox/audit/resolver-shadow
```

- `GET` devuelve `{ enabled, matrixVersion, matrixCounts, summary, evaluations }`.
  Funciona incluso con el flag desactivado (`enabled: false`, `evaluations: []`),
  para poder confirmar localmente que el modo sombra está apagado.
- `DELETE` únicamente vacía el búfer en memoria (`{ cleared: true }`); no borra
  ni toca ningún archivo ni tabla.

### Guarda de acceso: conexión real, no encabezados

A diferencia de `/audit/lookups/:lookupId/full-result` y `/advanced/lookup`
(que usan `isLocalAuditRequest`, basada en el header `Host`), estos dos
endpoints usan una guarda dedicada, **`isLocalSocketRequest`**, que valida la
**conexión TCP real** en vez de encabezados HTTP:

```js
req.socket.remoteAddress // no req.hostname, req.headers.host, X-Forwarded-*, Origin ni Referer
```

Direcciones aceptadas exactamente: `127.0.0.1`, `::1`, `::ffff:127.0.0.1`
(representación IPv4 mapeada en IPv6, común quando Node escucha en `::`).
Cualquier otro valor de `remoteAddress` es rechazado, sin importar qué
encabezados envíe la solicitud — un atacante que controle `Host`,
`X-Forwarded-For`, `X-Forwarded-Host`, `Origin` o `Referer` no puede hacerse
pasar por una conexión local, porque esos encabezados nunca se consultan en
esta guarda. Esto no modifica la configuración global de `trust proxy` de
Express: lee el socket subyacente directamente.

Fuera de una conexión local real, ambos endpoints devuelven `404` con
`status: 'RESOLVER_SHADOW_AUDIT_DISABLED'` — idéntico si el flag del modo
sombra está activado o no, de modo que la existencia del endpoint no revela
por sí sola si el modo sombra está en uso — y la guarda se evalúa **antes**
de tocar cualquier función de telemetría (`getShadowSummary`,
`getShadowEvaluations`, `clearShadowEvaluations`): una solicitud rechazada
nunca llega a leer ni limpiar el búfer.

## Metodología de comparación activo/inactivo

Para verificar que el modo sombra no altera la respuesta de `/lookup`, **no**
es correcto (ni esperable) comparar el `lookup_id` de dos solicitudes
independientes: cada solicitud a `/lookup` genera su propio `lookup_id` nuevo
mediante `buildLookupId()`, con o sin el modo sombra activado — eso es
comportamiento normal, no una discrepancia introducida por la sombra.

La afirmación correcta y verificable es:

> El modo sombra no modifica el mecanismo de generación, tipo, formato ni
> ubicación del `lookupId` dentro de la respuesta.

Para comparar dos respuestas de `/lookup` a la misma coordenada (una con el
flag activado, otra con el flag desactivado) hay que construir una
representación canónica de cada respuesta que excluya únicamente los campos
naturalmente variables entre solicitudes independientes:

- `lookup_id` y `routeId`.
- Cualquier URL derivada del `lookup_id` (`previewMapUrl`, `previewGeometryUrl`
  dentro de `predio`).
- Marcas de tiempo, si las hubiera.

Todos los demás campos —incluyendo `status`, el código HTTP, `found`,
`canPurchase`, `municipio`, `departamento`, `gestor`, `coverage` y la fuente
efectivamente servida (legacy o clean)— deben coincidir exactamente entre
ambas respuestas. Esta es la comparación que efectivamente se ejecutó en la
validación real (ver FASE 10 de la implementación y FASE 8 de este blindaje):
7 coordenadas reales, respuesta canónica idéntica con el flag activado y
desactivado.

## Diferencia entre observación y autoridad

El modo sombra **observa**: calcula qué decidiría la política V1 y lo compara
contra lo que el flujo real ya decidió, pero ese cálculo ocurre **después** de
que `/lookup` ya construyó y envió su respuesta. La política nunca participa en
la construcción de esa respuesta, nunca puede retrasarla, y un error dentro del
motor de decisión (por ejemplo, un error contractual de
`catastroxResolutionPolicy.js`, o una consulta fallida del `candidateProvider`)
queda completamente aislado dentro de `evaluateLookupInShadow`, sin propagarse
jamás hacia el middleware de errores de Express ni hacia el cliente.

Tener **autoridad** significaría que la política pudiera cambiar el `source`
elegido, bloquear un `canPurchase`, alterar un `lookup_id`, o impedir un
entregable. Nada de eso ocurre en V1: la integración es deliberadamente
unidireccional (el flujo real informa al modo sombra; el modo sombra nunca
informa de vuelta al flujo real).

## Por qué no modifica `/lookup`

1. La matriz V1 es una fotografía de clasificación, no una fuente de vigencia
   oficial — no hay base para que una fotografía estática decida qué predio
   entregarle a un usuario que paga por un entregable.
2. 47 de los 549 códigos quedan en `PENDING_POLICY`: no existe todavía un
   criterio de negocio aprobado para elegir representante en esos casos. Dejar
   que el resolver decidiera silenciosamente introduciría una selección
   arbitraria disfrazada de resolución automática.
3. La observación con tráfico real es el único método fiable para detectar
   discrepancias entre lo que el flujo actual ya hace bien (o mal) y lo que la
   política nueva propondría, **antes** de arriesgar una regresión visible para
   usuarios reales.
4. `/lookup` es el endpoint público que sostiene la venta de entregables; el
   costo de una regresión ahí es alto y directamente comercial. El modo sombra
   permite acumular evidencia con costo cero para el usuario.

## Procedimiento para desactivar

Basta con no exportar `CATASTROX_RESOLVER_SHADOW_ENABLED=true` (o exportarla en
`false`) antes de iniciar el proceso del servidor. No requiere ningún cambio de
código, migración, ni limpieza adicional: al quedar desactivado,
`evaluateLookupInShadow` vuelve a ser `NO_OP` inmediato y el búfer en memoria
simplemente deja de crecer (el que ya existía se descarta al reiniciar el
proceso, dado que no hay persistencia).

## Deuda futura

- **Clasificador dinámico**: la matriz V1 es estática y fue generada una sola
  vez a partir de una auditoría puntual. Una versión futura necesitaría
  recalcular la clasificación geométrica/atributiva a partir del estado actual
  de `catastrox_clean.predios` (o de un proceso de reclasificación periódico),
  en lugar de depender de un archivo congelado en el tiempo.
- **Vigencia catastral**: ni este módulo ni `catastroxResolutionPolicy.js`
  determinan cuál fila es la oficialmente vigente — solo identifican
  equivalencia técnica. Introducir una noción real de vigencia catastral
  requeriría una fuente de verdad externa (IGAC, gestor catastral) que hoy no
  existe en el esquema de datos disponible.
- **Política de selección para `PENDING_POLICY`**: antes de que estos 47 casos
  puedan avanzar a `RESOLVED_WITH_WARNING` (ver
  [CATASTROX_RESOLUTION_POLICY_V1.md](CATASTROX_RESOLUTION_POLICY_V1.md)), se
  necesita una decisión de negocio explícita sobre cómo elegir representante
  cuando hay variación geométrica mínima o atributos complementarios.
