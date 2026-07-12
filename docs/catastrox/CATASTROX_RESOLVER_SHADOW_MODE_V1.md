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
  resolutionStatus,             // salida de catastroxResolutionPolicy, o null si hubo error
  candidateSelectionStatus,
  policySelectedTechnicalKey,   // "source::sourceRecordId" del representante elegido por la politica, o null
  comparisonStatus,             // ver tabla abajo
  reasonCodes,                  // reason codes de la politica para ese codigo
  evaluationMs,                 // duracion de la evaluacion
  errorCode,                    // null, o el codigo de error aislado
}
```

### Valores de `comparisonStatus`

| Valor | Significado |
|---|---|
| `MATCH` | La política V1 (resuelta contra candidatos `clean`) elige el mismo representante técnico que ya devolvió `/lookup`. |
| `DIFFERENT_TECHNICAL_REPRESENTATIVE` | La política resuelve `AUTO_RESOLVED` con `currentSource='clean'`, pero elige un representante técnico distinto al que `/lookup` ya devolvió. |
| `SOURCE_NOT_COMPARABLE` | `/lookup` sirvió el resultado desde la fuente `legacy`; la matriz y los candidatos de la política son exclusivamente de `clean`, por lo que no hay una comparación técnica válida (nunca se mezclan candidatos legacy y clean). |
| `PENDING_POLICY` | La política V1 no tiene todavía un criterio aprobado para ese código (`resolutionStatus = PENDING_POLICY`); no hay representante que comparar. |
| `CURRENT_FLOW_WOULD_BE_BLOCKED` | La política bloquearía este código (`BLOCKED_REVIEW` o `BLOCKED_CRITICAL`) aunque `/lookup` sí devolvió un resultado — la señal de observación más importante de esta fase. |
| `EVALUATION_ERROR` | La evaluación falló (error contractual del resolver o error del proveedor de candidatos); el error quedó aislado dentro del modo sombra y nunca llegó a `/lookup`. |

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
  consulta a PostGIS ocurre a través de `candidateProvider`, una dependencia
  inyectada por quien lo instancia — en producción, `server/routes/catastrox.js`).

Este contrato está verificado por pruebas automatizadas (ver
`server/services/catastrox/__tests__/catastroxResolverShadow.test.js`, casos
12, 13, 23 y 24), que revisan tanto la forma exacta de cada registro de
telemetría como el código fuente del propio módulo.

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
