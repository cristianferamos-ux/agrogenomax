# Referencias técnicas -- Motor Automático de Recomendación de Pastoreo (SPRINT-3D7.2)

Este documento respalda los valores de `agx.catalogo_categorias_productivas`
(migración `0007_potrero_recomendacion_pastoreo.sql`) y las reglas del motor
pastura+clima (`pastureClimateEngine.js`) y del motor leche/ternero
(`recomendacionPastoreoFormulas.js`). Las citas bibliográficas exactas viven
en `fuentesTecnicas.js` -- este documento las referencia por código, nunca
las repite de forma ambigua.

**Regla dura de todas las rondas de hardening**: ningún coeficiente se
atribuye a una institución/publicación que no lo respalda literalmente. Si
una ecuación completa no es honestamente implementable con los datos que el
cliente puede entregar, se documenta la limitación explícitamente -- nunca
se inventa un sustituto y se le pone una etiqueta NASEM/NRC.

## Ediciones exactas

| Código | Cita completa | Nota |
|---|---|---|
| `NASEM_2016_BEEF` | NASEM (2016). *Nutrient Requirements of Beef Cattle*, 8th Revised Edition. | Beef, no dairy. |
| `NRC_2000_BEEF` | NRC (2000). *Nutrient Requirements of Beef Cattle*, Update of the 7th Revised Edition. | Referencia histórica/complementaria de la misma familia de modelos que NASEM (2016). |
| `NASEM_2021_DAIRY_GENERAL` | NASEM (2021). *Nutrient Requirements of Dairy Cattle*, 8th Revised Edition. | Consenso general de crecimiento de novillas de reemplazo -- NO la ecuación de DMI de lactancia. |
| `NASEM_2021_DAIRY_REFERENCE_ONLY` | NASEM (2021), Eq. 2-1, capítulo 2 "Dry Matter Intake". | **Nunca usada para calcular** -- documentada solo para justificar por qué se usa NRC (2001) en su lugar (ver abajo). |
| `NRC_2001_DAIRY_DMI` | NRC (2001). *Nutrient Requirements of Dairy Cattle*, 7th Revised Edition -- ecuación de Rayburn & Fox (1993), modificada por Fox et al. (1999). | **Ecuación REALMENTE implementada** para vacas en producción, SOLO cuando el cliente aporta %grasa real. |
| `GAINES_1923_FCM` | Gaines, W.L., and F.A. Davidson. 1923. *Relation between percentage fat content and yield of milk*. Illinois Agricultural Experiment Station Bulletin 245. Refinado en Gaines (1928). | FCM = 0.4×leche(kg/d) + 15×grasa(kg/d) -- **corrige un bug real de la ronda 3** (ver hardening ronda 4 abajo). |
| `GENERIC_LACTATING_PROFILE` | Sin ecuación externa -- reutiliza `consumo_ms_pct_pv_tipico` del catálogo. | Perfil aplicado cuando el cliente NO conoce el %grasa -- nunca se inventa una grasa asumida. |
| `FEEDIPEDIA_BRACHIARIA_HUMIDICOLA` | Feedipedia (INRAE, CIRAD, AFZ, FAO), "Koronivia grass (Brachiaria humidicola), aerial part, fresh". | %MS real verificado, no una cifra sin cita. |

## Auditoría hardening ronda 4 §1/§3/§6: corrección del bug de FCM (CRÍTICO)

**Problema real encontrado en la ronda 3**: `computeDemandaIndividualLecheNrc2001`
calculaba `fcmKg = litrosPromedioVacaDia × 1.03` -- es decir, usaba el
**volumen de leche crudo** (convertido a kg) directamente como si fuera
`FCM` (leche corregida al 4% de grasa). Esto es incorrecto: FCM y el
volumen de leche crudo son magnitudes distintas, y la ecuación NRC (2001)
exige literalmente FCM, no litros/kg de leche sin corregir.

**Corrección** (verificada, WebSearch 2026-08-25): FCM (4% fat-corrected
milk) se calcula con la fórmula publicada de **Gaines & Davidson (1923)**,
refinada por Gaines (1928) -- estándar de la industria láctea:

```
FCM (kg/d) = 0.4 × leche(kg/d) + 15 × grasa(kg/d)
grasa(kg/d) = leche(kg/d) × %grasa / 100
```

Esta fórmula **requiere el %grasa real de la leche**, dato que el productor
puede no conocer. Por eso `grasaLechePct` es un input **SIEMPRE OPCIONAL**
(§4/§8 del hardening -- "no obligar al pequeño productor a conocerla"):

- **Si el cliente aporta %grasa**: se calcula FCM real (Gaines) y se
  ejecuta la ecuación NRC (2001) COMPLETA y correcta.
  `dmiModel = 'NRC_2001_DAIRY_DMI'`, `dmiModelSourceType = 'DIRECT'`.
  `diasEnLeche` se vuelve obligatorio en este caso (ambos alimentan la
  ecuación junto con el peso).
- **Si NO la aporta**: el motor NUNCA inventa un %grasa ni ejecuta una
  ecuación FCM falsa -- usa el mismo perfil %PV genérico que cualquier
  otra categoría (`consumo_ms_pct_pv_tipico` del catálogo).
  `dmiModel = 'GENERIC_LACTATING_PROFILE'`, `fuente_tipo = 'ADAPTED'`,
  limitación explícita `LECHE_SIN_GRASA_PERFIL_GENERICO`, y la **confianza
  queda topada en MEDIA** (nunca ALTA sin FCM real). `diasEnLeche` no se
  exige en este caso -- no alimenta ningún cálculo sin %grasa.

**Litros → kg**: conversión física documentada (densidad estándar de la
leche bovina, 1.03 kg/L, código `DENSIDAD_ESTANDAR_1.03_KG_L` en
provenance) -- nunca usada como sustituto de FCM, solo como paso intermedio
para obtener `milkKgDayUsed` antes de aplicar Gaines.

**Auditoría completa persistida** (§7 del hardening, en
`parametros_fuente_json.ecuacionLeche` cuando la ecuación real corrió):
`milkInputLitersDay`, `milkKgDayUsed`, `milkDensityOrConversionSource`,
`milkFatPct`, `milkFatKgDay`, `fcmKgDay`, `daysInMilk`, `weeksOfLactation`,
`bwKg`, `predictedDmiKgDay`, `equationSource`, `dmiModelSourceType`.

## Auditoría hardening ronda 3 §1: por qué NRC (2001) y no NASEM (2021) para vacas en producción

**Verificación realizada** (WebSearch + WebFetch, 2026-08-25) contra
ScienceDirect, NCBI y el propio libro NASEM (2021) hospedado en NCBI
Bookshelf (`https://www.ncbi.nlm.nih.gov/books/NBK600610/`):

NASEM (2021), 8th Revised Edition, capítulo 2, publica DOS ecuaciones
explícitas de DMI para vacas lactantes:

- **Eq. 2-1**: `DMI = [(3.7 + Paridad×5.7) + 0.305×MilkE(Mcal/d) + 0.022×BW(kg) + (−0.689 − 1.87×Paridad)×BCS] × [1 − (0.212 + Paridad×0.136)×e^(−0.053×DIM)]`
  -- requiere **energía neta de la leche** (Mcal/d, derivada de %grasa/
  %proteína reales), **condición corporal** (BCS, escala 1-5) y **paridad**.
- **Eq. 2-2**: función de NDF/ADF/digestibilidad del forraje + producción
  -- requiere **análisis bromatológico del forraje** (laboratorio).

**Ninguna de las dos es implementable honestamente en v1**: BCS y paridad
no se capturan (agregar condición corporal exige entrenamiento del usuario
o una foto+IA, fuera de alcance de este sprint), la energía neta de la
leche exige %grasa/%proteína reales, y el análisis bromatológico es
explícitamente futuro (§7 -- "no implementar laboratorio todavía").

**Decisión**: se usa la ecuación de **NRC (2001)**, misma familia de
modelos, verificada con coeficientes exactos y reproducibles, que requiere
SOLO peso vivo + FCM (litros/día + %grasa real) + días en leche -- datos
que el cliente puede entregar sin instrumentación de laboratorio. Esto es
exactamente la "versión simplificada científicamente publicada" que el
hardening pidió buscar.

```
DMI (kg/d) = (0.372 × FCM + 0.0968 × BW^0.75) × [1 − e^(−0.192 × (WOL + 3.67))]
```
donde `FCM` = leche corregida a 4% de grasa (kg/d, ver Gaines arriba --
NUNCA el volumen de leche crudo), `BW` = peso vivo (kg), `WOL` = semana de
lactancia = días en leche ÷ 7.

**Inputs en la UI** (§2 del hardening -- solo lo que la ecuación exige,
nada decorativo): peso promedio, número de animales, litros promedio/vaca/
día (siempre obligatorio), **%grasa de la leche** (opcional, ronda 4) y
**días en leche** (obligatorio solo si se aportó %grasa). NO se agregó
condición corporal -- la ecuación NRC (2001) elegida no la requiere.

## Auditoría hardening ronda 3 §4: por qué el ternero al pie NO suma demanda

**Investigación realizada**: se buscó una tabla NRC/NASEM de consumo de
forraje de terneros nursing por grupo de edad (0-3m/3-6m/>6m). El único
dato encontrado (un reporte de la Universidad de Nebraska, citado en
literatura de extensión) es una cifra aislada (~2.4 kg MS/día para un
ternero de ~130 kg) sin desglose por edad/peso ni tabla completa
verificable -- **evidencia insuficiente para construir un coeficiente
confiable por grupo de edad**.

**Decisión** (siguiendo la alternativa explícitamente autorizada por el
hardening): el motor **NO suma demanda individual del ternero** en v1.
En su lugar:
- Degrada el nivel de confianza un nivel (`terneroAlPie === true` en
  `resolveNivelConfianza`).
- Expone una limitación explícita:
  `TERNERO_AL_PIE_DEMANDA_NO_CUANTIFICADA` -- "El consumo de forraje del
  ternero al pie NO está incluido en este cálculo... puede subestimar la
  demanda real del sistema vaca+ternero."

`terneroAlPie` sigue siendo un input capturado (informativo + dispara la
limitación/degradación) -- nunca decorativo, pero tampoco pretende una
precisión que no existe. Se eliminó la constante "+1.0 kg MS/día" de la
ronda anterior.

## Matriz de 13 categorías (consumo de materia seca)

| Categoría | Grupo | %PV min/típico/max | Fuente | Tipo |
|---|---|---|---|---|
| Vacas de cría con ternero | cría | 2.0 / 2.3 / 2.6 | NASEM_2016_BEEF | ADAPTED |
| Vacas secas | cría/leche | 1.8 / 2.0 / 2.2 | NASEM_2016_BEEF | ADAPTED |
| Toros reproductores | cría/reproducción | 1.8 / 2.0 / 2.3 | NASEM_2016_BEEF | ADAPTED |
| Terneras/Terneros de levante | levante | 2.5 / 2.8 / 3.2 | NASEM_2016_BEEF | ADAPTED |
| Novillas/Novillos de levante | levante | 2.3 / 2.6 / 3.0 | NASEM_2016_BEEF | ADAPTED |
| Terneros de emposte | ceba | 2.4 / 2.7 / 3.0 | NASEM_2016_BEEF | ADAPTED |
| Novillos de ceba | ceba | 2.0 / 2.4 / 2.8 | NASEM_2016_BEEF | ADAPTED |
| **Vacas en producción de leche** | leche | 1.8 / 3.0 / 5.0 (**referencia informativa -- NO aplicada**) | NRC_2001_DAIRY_DMI | ADAPTED |
| Novillas de reemplazo | leche | 2.4 / 2.7 / 3.0 | NASEM_2021_DAIRY_GENERAL | ADAPTED |
| Vacas receptoras | reproducción | 2.0 / 2.2 / 2.5 | NASEM_2016_BEEF | **FALLBACK** |
| Novillas receptoras | reproducción | 2.2 / 2.5 / 2.8 | NASEM_2016_BEEF | **FALLBACK** |

Para **vacas en producción de leche**, `consumo_ms_pct_pv_*` se usa de dos
formas mutuamente excluyentes, según si el cliente aportó %grasa real
(hardening ronda 4 §1/§5):
- **Con %grasa**: es SOLO referencia informativa -- la demanda real usa la
  ecuación NRC (2001) completa (ver arriba). El `consumo_pct_pv_aplicado`
  persistido es el **%PV equivalente derivado** del resultado real
  (honestidad de "aplicado": nunca se guarda un valor que no fue el que
  realmente produjo el cálculo).
- **Sin %grasa**: `consumo_ms_pct_pv_tipico` SÍ se aplica literalmente
  (perfil `GENERIC_LACTATING_PROFILE`) -- misma mecánica que cualquier
  categoría no lactante, confianza topada en MEDIA.

Categorías **no incluidas** en v1: "Lote mixto"/"Otro" (§19) -- sin
consumo %PV de una sola categoría aplicable automáticamente.

## Materia seca (%) y utilización (%) por pastura -- `dryMatterSource`

Taxonomía de incertidumbre (hardening §6) -- nunca falsa precisión:

```
MEASURED > PASTURE_SPECIFIC_BASELINE > BOTANICAL_TYPE > FALLBACK
```

- **MEASURED**: %MS medido en campo/laboratorio. Arquitectura preparada
  (`resolvePastureClimateParams` acepta `materiaSecaMedidaPct`) pero
  **inalcanzable en v1** -- ningún input de la app lo popula todavía (§7:
  "dejar preparada la arquitectura", "no implementar laboratorio
  todavía").
- **PASTURE_SPECIFIC_BASELINE**: especie/cultivar identificado contra un
  dato específico documentado. Único entry v1: *Brachiaria humidicola* /
  *Urochloa humidicola* -- ver abajo.
- **BOTANICAL_TYPE**: tipo botánico general (gramínea 20%, leguminosa 22%,
  mezcla 21% -- `FAO_AGROSAVIA_PASTURA_TROPICAL`, consenso de campo).
- **FALLBACK**: pastura "otra" (sin tipo reconocido) -- degrada confianza.

`utilizacionFuenteTipo` es **siempre FALLBACK** (`FAO_AGROSAVIA_PASTOREO_RACIONAL`,
take-half-leave-half) -- ninguna fuente consultada documenta un % de
utilización específico de especie/cultivar, ni siquiera para humidicola
(ver abajo). Único ajuste determinístico: déficit hídrico reciente
(precipitación 7 días < 10 mm) reduce la utilización aplicada en 5 puntos
porcentuales -- nunca se incrementa por clima favorable.

## *Brachiaria humidicola* / *Urochloa humidicola* -- PASTURE_SPECIFIC_BASELINE

**Auditoría hardening ronda 3 §5**: el 22% de la ronda anterior no tenía
cita verificable -- se reemplazó por un dato REAL (WebFetch, 2026-08-25,
Feedipedia -- INRAE/CIRAD/AFZ, base de datos internacional de composición
de alimentos con revisión por pares):

> "Koronivia grass (Brachiaria humidicola), aerial part, fresh" -- materia
> seca: **26.0% ± 3.2** (rango observado 22.1-29.8%, **n=4 muestras**).

Metadata expuesta honestamente (§5 -- nunca "Urochloa humidicola tiene 22%
MS" como hecho universal):
- **Cultivar/especie**: Brachiaria humidicola (sin. Urochloa humidicola).
- **Región/contexto**: base internacional Feedipedia, sin desglose por
  región en esta muestra.
- **Edad de rebrote**: NO reportada por esta fuente para el dato de %MS
  (otra literatura -- estudios de rebrote en Ecuador -- sugiere ventana de
  manejo óptima a 40-60 días, sin %MS específico asociado a esa ventana;
  se documenta como contexto, no se mezcla con el dato de Feedipedia).
- **Época**: no reportada.
- **Limitación**: n=4 muestras -- rango amplio refleja esa variabilidad.
  Se usa el punto medio (26.0%) como baseline, nunca como valor medido de
  un potrero específico real.
- **% de utilización**: FALLBACK genérico -- ninguna fuente consultada
  documenta un % de utilización o guía de residual específica de
  humidicola con suficiente rigor para citar.

## Nivel de confianza

Reglas documentadas en `recomendacionPastoreoFormulas.js` -- ALTA por
defecto, degrada un nivel (piso BAJA) por cada condición: sin contexto
agroclimático, ficha con más de 60 días de antigüedad, `dryMatterSource
=== 'FALLBACK'`, `categoriaFuenteTipo === 'FALLBACK'` (receptoras), o
`terneroAlPie === true` (demanda no cuantificada, hardening ronda 3 §4).
`PASTURE_SPECIFIC_BASELINE` y `MEASURED` NO degradan (evidencia igual o
mejor que `BOTANICAL_TYPE`). No es scoring opaco -- cada regla es una
condición booleana explícita y documentada.

## Futuro (§7 del hardening -- NO implementado en v1)

La arquitectura queda preparada para que el productor/técnico registre un
**%MS medido** (aforo de laboratorio o análisis bromatológico), con
prioridad automática sobre cualquier estimación (`dryMatterSource =
MEASURED` ya definido y con prioridad máxima en el código). Implementar
la captura de ese dato (formulario, tabla, endpoint) queda fuera de
alcance de este sprint -- evita ampliarlo innecesariamente.

## Limitaciones explícitas (vigentes desde el sprint original)

Este motor calcula **capacidad física de pastoreo** (kg MS utilizable ÷ kg
MS requeridos por animal/día) -- NUNCA afirma suficiencia de proteína,
energía, minerales ni requerimientos de alta producción. Para vacas
lecheras, el resultado incluye siempre una advertencia explícita de que la
disponibilidad de biomasa no equivale a suficiencia nutricional completa,
incluso usando la ecuación NRC (2001) real -- esa ecuación estima
**capacidad de consumo**, no un balance energético/proteico completo (eso
exigiría la Eq. 2-1/2-2 de NASEM 2021 con BCS/paridad/composición real de
la leche, explícitamente fuera de alcance en v1).
