# CatastroX — Motor de decisión del resolver (v1)

## Estado

Módulo aislado, probado, **no conectado** a `/lookup`, `audit/full-result`, PostGIS,
generación de PDF, ni a KML/KMZ/SHP/DXF. Este documento describe únicamente el
contrato y la lógica interna del módulo puro; no describe integración.

## Propósito

`server/services/catastrox/catastroxResolutionPolicy.js` convierte una
clasificación geométrica y de atributos —ya calculada aguas arriba, típicamente por
consultas PostGIS de solo lectura— en una **decisión de resolución** para un grupo
de filas duplicadas que comparten `codigo_predial`. Es una función pura:

- No ejecuta SQL ni abre conexiones de base de datos.
- No lee archivos ni depende de `audit_outputs/`.
- No importa Express ni conoce rutas HTTP.
- No mantiene estado mutable entre llamadas.
- No muta su argumento de entrada, ni superficial ni profundamente (clonación
  defensiva de todo dato anidado que sale del módulo — ver
  [Inmutabilidad](#inmutabilidad-real)).
- La misma entrada produce siempre la misma salida.

## Entradas

```js
{
  codigoPredial: string,        // obligatorio
  geometryStatus: 'EXACT' | 'MINIMAL_VARIATION' | 'MATERIAL_CONFLICT' | 'SEPARATE',
  attributeStatus: 'NONE' | 'COMPLEMENTARY' | 'COMMERCIAL_SENSITIVE'
                  | 'TERRITORIAL_CRITICAL' | 'NORMALIZATION_SUSPECT',
  candidates: [{ source: string, sourceRecordId: string, ... }],  // opcional
  reasonCodes: [string],        // opcional — reason codes calculados aguas arriba
  evidence: object,              // opcional — contexto libre, no interpretado
}
```

`NORMALIZATION_SUSPECT` es un `attributeStatus` adicional a los definidos por el
diseño original del resolver (`resolver_decision_table.md` /
`resolver_contract.md`). Se usa cuando la causa más probable de una diferencia de
atributos es un error de normalización de datos (no una contradicción real), pero
la diferencia **aún no ha sido confirmada** y por tanto sigue requiriendo revisión
manual antes de cualquier entregable.

## Salidas

```js
{
  codigoPredial: string,
  resolutionStatus: 'AUTO_RESOLVED' | 'PENDING_POLICY' | 'RESOLVED_WITH_WARNING'
                   | 'BLOCKED_REVIEW' | 'BLOCKED_CRITICAL',
  candidateSelectionStatus: 'NOT_REQUIRED' | 'SELECTED_EQUIVALENT'
                           | 'PENDING_POLICY' | 'BLOCKED',
  selectedCandidate: object | null,
  equivalentCandidates: object[],
  geometryStatus: string,
  attributeStatus: string,
  reasonCodes: string[],
  warnings: string[],
  manualReviewRequired: boolean,
  criticalReview: boolean,
  traceabilityRequired: boolean,
  deliverablesAllowed: { pdf, kml, kmz, shp, dxf }: boolean,
}
```

El objeto de salida está **congelado de forma profunda** (ver
[Inmutabilidad](#inmutabilidad-real)): `deliverablesAllowed`, `reasonCodes`,
`warnings`, `equivalentCandidates` (y cada candidato dentro de ese arreglo), y
`selectedCandidate`, quedan todos congelados recursivamente, no solo en su
primer nivel.

### Los cinco valores de `resolutionStatus`

| Valor | ¿Se usa en V1? | Significado |
|---|---|---|
| `AUTO_RESOLVED` | Sí | Duplicados exactos y sin conflicto de atributos; se elige un representante técnico y todos los entregables quedan permitidos. |
| `PENDING_POLICY` | Sí | Hay una variación geométrica mínima, un atributo complementario, o una sospecha de normalización, sin conflicto mayor — pero no existe todavía una política de negocio aprobada para elegir representante. `selectedCandidate = null`, sin entregables. |
| `RESOLVED_WITH_WARNING` | **No — reservado** | Pensado para una fase futura en la que exista esa política aprobada: se elegiría un candidato con advertencia visible y podrían habilitarse entregables bajo aceptación explícita. Ninguna regla de esta versión produce este valor todavía. |
| `BLOCKED_REVIEW` | Sí | Conflicto geométrico material, geometrías separadas, o atributo comercialmente sensible; requiere revisión manual antes de cualquier entregable. |
| `BLOCKED_CRITICAL` | Sí | Contradicción territorial crítica; máxima precedencia, revisión crítica obligatoria. |

`PENDING_POLICY` y `RESOLVED_WITH_WARNING` no son sinónimos ni intercambiables:
`PENDING_POLICY` describe honestamente el estado actual (sin política, sin
selección, sin entregables); `RESOLVED_WITH_WARNING` describirá, cuando exista
esa política, un estado distinto donde sí hay selección y sí puede haber
entregables condicionados a una advertencia aceptada. Mientras esa política no
exista, usar `RESOLVED_WITH_WARNING` sería una afirmación falsa de resolución.

## Precedencia implementada

Se evalúa en este orden exacto; la primera regla que aplica decide el resultado:

| # | Condición | resolutionStatus | candidateSelectionStatus | Entregables |
|---|---|---|---|---|
| 1 | `attributeStatus = TERRITORIAL_CRITICAL` | `BLOCKED_CRITICAL` | `BLOCKED` | Ninguno |
| 2 | `geometryStatus = MATERIAL_CONFLICT` o `SEPARATE` | `BLOCKED_REVIEW` | `BLOCKED` | Ninguno |
| 3 | `attributeStatus = COMMERCIAL_SENSITIVE` | `BLOCKED_REVIEW` | `BLOCKED` | Ninguno |
| 4 | `geometryStatus = MINIMAL_VARIATION` o `attributeStatus = COMPLEMENTARY` o `NORMALIZATION_SUSPECT` | `PENDING_POLICY` | `PENDING_POLICY` | Ninguno |
| 5 | `geometryStatus = EXACT` y `attributeStatus = NONE` | `AUTO_RESOLVED` | `NOT_REQUIRED` / `SELECTED_EQUIVALENT` | Todos |

Puntos importantes de esta tabla:

- La regla 1 tiene precedencia absoluta: un conflicto territorial crítico bloquea
  el resultado sin importar cuán "limpia" sea la geometría.
- La regla 2 **no se relaja** cuando `attributeStatus = NORMALIZATION_SUSPECT`. La
  sospecha de normalización se añade como reason code adicional, pero el
  resultado sigue siendo `BLOCKED_REVIEW` por causa de la geometría. Esto es
  deliberado: una sospecha de error de normalización no es una confirmación, y el
  conflicto geométrico material es en sí mismo motivo suficiente de bloqueo.
- La regla 4 es la que cubre `NORMALIZATION_SUSPECT` cuando no hay conflicto
  geométrico/comercial/territorial que la preceda: el caso queda en
  `PENDING_POLICY` (no en bloqueo), pero **tampoco se resuelve
  automáticamente** — sigue sin existir un criterio de negocio aprobado para
  elegir representante, por lo que `selectedCandidate` es siempre `null` y no
  se habilita ningún entregable en este estado.

## Equivalencia técnica vs. vigencia oficial

Este módulo **nunca determina cuál fila es la "vigente"** (oficialmente válida).
Cuando `geometryStatus = EXACT` y `attributeStatus = NONE`, los candidatos se
consideran técnicamente equivalentes entre sí, y el módulo puede elegir uno como
**representante técnico** de esa clase de equivalencia — únicamente para fines de
reproducibilidad (p. ej. mostrar un único registro en un listado). Esa elección:

- No implica que las demás filas sean incorrectas, obsoletas o inválidas.
- No se basa en ningún campo de significado catastral.
- Se conserva junto con **todos** los candidatos equivalentes en
  `equivalentCandidates`, para que la trazabilidad completa nunca se pierda.

## Selección de duplicados exactos

La selección determinista sólo ocurre dentro de la regla 5 (`EXACT + NONE`), y
únicamente sobre candidatos ya clasificados como equivalentes. La clave de orden
es:

```
${candidate.source}::${candidate.sourceRecordId}
```

ordenada con `localeCompare`. Esta clave usa **exclusivamente campos de
trazabilidad no catastrales** suministrados por quien invoca el módulo (p. ej.
`source = 'clean' | 'legacy'`, `sourceRecordId` = identificador propio de esa
fuente). El módulo **nunca lee ni usa** `fid`, `ctid`, área (mínima o máxima), ni
orden físico de filas en base de datos — esos campos ni siquiera forman parte del
contrato de entrada de un candidato.

**La selección no representa vigencia oficial; los candidatos son equivalentes
según la clasificación recibida.**

### Blindaje contractual de la rama `EXACT + NONE`

Como una selección automática solo tiene sentido si cada candidato es
identificable de forma inequívoca, el módulo exige, exclusivamente dentro de
esta rama:

- Al menos un candidato. `EXACT + NONE` con `candidates` ausente o vacío se
  considera una entrada incoherente — no existe nada que declarar
  automáticamente resuelto — y el módulo **lanza
  `CatastroxResolverContractError`** en vez de degradar silenciosamente a
  `BLOCKED_REVIEW` o a un `AUTO_RESOLVED` sin candidato.
- `source` no vacío en cada candidato (si falta o es una cadena vacía/solo
  espacios, se lanza `CatastroxResolverContractError`).
- `sourceRecordId` no vacío en cada candidato (misma regla).
- Claves técnicas (`source::sourceRecordId`) únicas entre los candidatos
  suministrados; una clave repetida indica que el llamador envió el mismo
  registro dos veces o una identidad de trazabilidad ambigua, y también se
  rechaza con `CatastroxResolverContractError`.

Esta validación es exclusiva de `EXACT + NONE`: las demás ramas (bloqueadas o
pendientes de política) siguen aceptando `candidates` ausente o vacío sin
lanzar error, porque en esas ramas nunca se ejecuta una selección automática.

## ¿Por qué los 47 casos pendientes de política siguen sin entregables?

En el diseño previo del resolver (`resolver_decision_table.md`), 47 códigos
prediales caían en lo que ese diseño llamaba `RESOLVED_WITH_WARNING`
(`MINIMAL_VARIATION` o `COMPLEMENTARY`, sin conflicto mayor). Este módulo los
clasifica como `resolutionStatus = PENDING_POLICY` — no `RESOLVED_WITH_WARNING`
— precisamente porque nada se ha resuelto todavía. Aunque estos casos no están
bloqueados por un conflicto grave, **tampoco existe todavía un criterio de
negocio aprobado** para decidir automáticamente qué geometría o qué combinación
de atributos debe representar al predio en un entregable oficial (PDF, KML,
KMZ, SHP, DXF). Generar un entregable con una selección arbitraria del módulo
equivaldría a afirmar una vigencia que nadie ha confirmado. Por eso
`candidateSelectionStatus = PENDING_POLICY`, `selectedCandidate = null`, y
`deliverablesAllowed` permanece en `false` para las cinco salidas hasta que
exista y se implemente esa política — momento en el cual estos casos podrían
migrar a `RESOLVED_WITH_WARNING` en una versión futura de este módulo.

## Reason codes

Definidos como constantes en `REASON_CODE` (nunca se construyen por
concatenación dispersa de cadenas; cada mensaje humano en `warnings` se deriva de
una tabla fija `REASON_CODE_MESSAGES` indexada por el código):

- `EXACT_EQUIVALENT_DUPLICATES`
- `MINIMAL_GEOMETRY_VARIATION`
- `MATERIAL_GEOMETRY_CONFLICT`
- `SEPARATE_GEOMETRIES`
- `COMPLEMENTARY_ATTRIBUTE`
- `COMMERCIAL_ATTRIBUTE_CONFLICT`
- `TERRITORIAL_ATTRIBUTE_CONFLICT`
- `NORMALIZATION_SUSPECT`
- `ZONE_NORMALIZATION_SUSPECT`
- `MANZANA_ZERO_SENTINEL`
- `CANDIDATE_SELECTION_POLICY_PENDING`
- `MANUAL_REVIEW_REQUIRED`

`reasonCodes` en la salida es un conjunto deduplicado (sin orden significativo):
fusiona los reason codes que el módulo agrega según la regla aplicada, con
cualquier `reasonCodes` que el llamador haya suministrado en la entrada
(típicamente calculados aguas arriba por el proceso de clasificación).

### Family fallback de sospecha de normalización

Cuando `attributeStatus = NORMALIZATION_SUSPECT`, el módulo agregaría por
defecto el reason code genérico `NORMALIZATION_SUSPECT`. Sin embargo, si quien
invoca el módulo ya aportó en `input.reasonCodes` un código más específico de la
misma familia (`ZONE_NORMALIZATION_SUSPECT` o `MANZANA_ZERO_SENTINEL`), el
módulo **no** agrega el genérico — evita redundancia y conserva el reason code
más informativo. Esto es lo que hace que los dos casos validados (más abajo)
produzcan exactamente los reason codes esperados, sin duplicar la explicación de
sospecha de normalización con un código genérico adicional.

## Casos especiales validados

### Zona rural/urbano — `180940003000000080005000000000`

Entrada:

```js
{
  codigoPredial: '180940003000000080005000000000',
  geometryStatus: 'MATERIAL_CONFLICT',
  attributeStatus: 'NORMALIZATION_SUSPECT',
  reasonCodes: ['ZONE_NORMALIZATION_SUSPECT'],
}
```

Salida:

- `resolutionStatus = 'BLOCKED_REVIEW'`
- `criticalReview = false`
- `deliverablesAllowed` = `false` en las cinco categorías
- `reasonCodes` = `{ MATERIAL_GEOMETRY_CONFLICT, ZONE_NORMALIZATION_SUSPECT, MANUAL_REVIEW_REQUIRED }`

Este caso fue previamente reclasificado (fuera del alcance de este módulo, en
`audit_outputs/catastrox/resolver_design/critical_cases_validation.md`) de
`TERRITORIAL_CRITICAL` a `COMPLEMENTARY`/sospecha de normalización, porque la
evidencia indica que una de las dos filas (`zona = URBANO`) es, con alta
probabilidad, un error de normalización y no una contradicción territorial real.
Aun así, el conflicto geométrico material asociado (`MATERIAL_CONFLICT`) es
suficiente por sí solo para mantener el caso bloqueado para revisión manual.

### Manzana con ceros — `182470100000001380012000000000`

Entrada:

```js
{
  codigoPredial: '182470100000001380012000000000',
  geometryStatus: 'MATERIAL_CONFLICT',
  attributeStatus: 'COMPLEMENTARY',
  reasonCodes: ['MANZANA_ZERO_SENTINEL'],
}
```

Salida:

- `resolutionStatus = 'BLOCKED_REVIEW'`
- `criticalReview = false`
- `deliverablesAllowed` = `false` en las cinco categorías
- `reasonCodes` = `{ MATERIAL_GEOMETRY_CONFLICT, MANZANA_ZERO_SENTINEL, MANUAL_REVIEW_REQUIRED }`

El código de manzana compuesto únicamente por ceros
(`manzana_codigo = '00000000000000000'`) es **una inferencia estructural de alta
confianza, no una definición oficial confirmada**: todo indica que representa
ausencia de información (valor centinela) más que un valor catastral real, pero
esa inferencia no reemplaza una confirmación oficial. Por eso el caso conserva
revisión manual obligatoria y ningún entregable habilitado, en lugar de
resolverse automáticamente a partir de la inferencia.

## Inmutabilidad real

`Object.freeze` de un solo nivel es superficial: congela las propiedades
directas de un objeto, pero no impide mutar objetos o arreglos anidados dentro
de él (por ejemplo, `Object.freeze(result)` no evita
`result.equivalentCandidates.push(...)`, porque `equivalentCandidates` sigue
siendo un arreglo mutable). La versión inicial de este módulo tenía exactamente
ese defecto.

Esta revisión corrige el problema con dos mecanismos aplicados en el único
punto de salida del módulo (`buildResult`):

1. **Clonación defensiva profunda** (`deepClone`, vía `structuredClone`): antes
   de exponer cualquier dato, se clona de forma profunda — nunca se devuelve
   una referencia compartida con `input.candidates` ni con ninguna estructura
   interna. Esto aplica a `selectedCandidate` y a cada elemento de
   `equivalentCandidates`.
2. **Congelamiento profundo real** (`deepFreeze`): recorre recursivamente el
   objeto de salida completo y congela cada nivel — el objeto raíz,
   `deliverablesAllowed`, `reasonCodes`, `warnings`, `equivalentCandidates` (y
   cada candidato dentro de ese arreglo), y `selectedCandidate`.

El resultado: intentar `result.reasonCodes.push(...)`,
`result.deliverablesAllowed.pdf = true`,
`result.equivalentCandidates[0].source = 'x'`, o cualquier mutación equivalente
sobre cualquier nivel del objeto devuelto, lanza `TypeError` en modo estricto.
El objeto de entrada (`input`) tampoco se congela ni se muta nunca: sigue
siendo perfectamente mutable después de la llamada, porque este módulo no tiene
autoridad sobre datos que no le pertenecen — solo garantiza que sus propias
salidas sean confiables.

`evidence` no forma parte del contrato de salida (ver [Salidas](#salidas)): se
acepta como entrada de solo lectura pero nunca se copia ni se expone en el
resultado, por lo que no participa de esta clonación ni de este congelamiento.

## Restricciones explícitas de este módulo

- No conoce ni decide sobre `/lookup`, `audit/full-result`, PostGIS, generación
  de PDF, ni KML/KMZ/SHP/DXF — todo eso es responsabilidad de una integración
  futura, fuera del alcance de este módulo.
- No usa `fid`, `ctid`, área mínima/máxima, ni orden físico de fila como criterio
  de selección o de vigencia, bajo ninguna circunstancia.
- No mantiene la precedencia legacy/clean existente en `server/routes/catastrox.js`
  — esa lógica de fuente de datos es independiente de este módulo y no fue
  modificada.
- No incluye datos personales ni listados completos de predios; los únicos
  `codigoPredial` mencionados en este documento son los dos casos ya validados y
  documentados en fases anteriores de auditoría.
- No confunde errores de forma con errores de contrato de negocio: `TypeError`
  y `RangeError` señalan una entrada mal formada o con valores desconocidos;
  `CatastroxResolverContractError` (exportado por el módulo) señala una entrada
  bien formada pero contractualmente incoherente para la decisión solicitada
  (ver [Blindaje contractual de la rama `EXACT + NONE`](#blindaje-contractual-de-la-rama-exact--none)).
