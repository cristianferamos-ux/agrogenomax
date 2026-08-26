# Referencias técnicas -- Motor de Descanso y Reentrada (SPRINT-3D8, hardening dinámico)

Este documento respalda el baseline fisiológico/regional de
`pasturaDescansoBaselineEngine.js` y las reglas de
`agroClimateAssessment.js`/`agroClimateFreshness.js`/`descansoFormulas.js`.
Las citas bibliográficas exactas viven en `fuentesTecnicasDescanso.js` --
este documento las referencia por código, nunca las repite de forma
ambigua.

**Regla dura**: ningún número de días/altura se atribuye a una fuente que
no lo documenta literalmente.

**Principio central del hardening dinámico**: la literatura es un
GUARDRAIL (baseline fisiológico + límites razonables + condiciones de
entrada/salida), NUNCA la respuesta final. La recomendación de descanso
real es:

```
PASTURE PHYSIOLOGICAL BASELINE
+ CURRENT/RECENT AGROCLIMATE CONDITIONS (agroClimateAssessment.js)
+ GRAZING PRESSURE / RESIDUAL (guardrail de presión)
= DYNAMIC REST WINDOW
```

El baseline SIEMPRE atraviesa el ajuste dinámico -- nunca se devuelve tal
cual (`computeRangoDescansoDias` nunca es un passthrough).

## Baseline PASTURE_SPECIFIC_REGIONAL: Urochloa/Brachiaria humidicola (fixture POTRERO 1)

| Parámetro | Valor | Fuente | Tipo |
|---|---|---|---|
| Días de descanso (min/típico/max) | 25 / 30 / 35 | `RINCON_2018_HUMIDICOLA_LLANERO` -- Rincón, Flórez, Ballesteros y León (2018), *Tropical Grasslands-Forrajes Tropicales* 6(3):158-168. Documenta una pastura de Brachiaria humidicola cv. Llanero (Piedemonte de los Llanos Orientales de Colombia) manejada bajo pastoreo rotacional con 30 días de descanso. | `PASTURE_SPECIFIC_REGIONAL` -- 30 días es el punto medio documentado; 25-35 es el margen de incertidumbre explícito del sprint, nunca un segundo experimento real con esos extremos exactos. **Conservado como evidencia CONTEXTUAL/REGIONAL, nunca como recomendación directa universal** -- el motor SIEMPRE aplica el ajuste dinámico agroclimático antes de producir un resultado. |
| Altura de entrada (referencia, no umbral exacto) | ~30 cm | `CIAT_2025_MANEJO_HUMIDICOLA` -- Bastidas et al. (2025), *Manejo estratégico de Urochloa humidicola...* Manual Técnico Vol. 2, CIAT/Alianza Bioversity-CIAT. Tabla 2 (score 2.5 = 30 cm, cerca del límite superior del rango "ideal" de manejo, Tabla 3). | `PASTURE_SPECIFIC_REGIONAL` (cultivar Tully/CIAT 679, no necesariamente el mismo cultivar que el catálogo de sistema registra) |
| Altura de salida/residual (referencia) | ~15 cm | Misma fuente, Tabla 2 (score 1.5 = 15 cm). | `PASTURE_SPECIFIC_REGIONAL` |

**Metadata obligatoria del hardening** (§3): `region`, `sistemaProductivo`,
`cultivar`, `fuente`, `limitaciones` -- explícitamente "NO universalizable
a todo Colombia ni a otras condiciones edafoclimáticas" (ver
`pasturaDescansoBaselineEngine.js`).

Verificación técnica: WebSearch/WebFetch, 2026-08-25. AGROSAVIA
("Manejo de pastoreo en el Piedemonte llanero para sistemas intensivos")
documenta independientemente el mismo rango (25-35 días) para sistemas
intensivos de la misma región -- coincidencia real entre dos fuentes
institucionales distintas, usada como evidencia CORROBORANTE (nunca como
fallback universal, ver corrección abajo).

## §4 del hardening: NO existe fallback universal inventado

Corrección explícita respecto a la primera iteración de este motor: se
eliminó `AGROSAVIA_PIEDEMONTE_LLANERO_PASTOREO` como baseline aplicable a
"cualquier gramínea sin dato específico". `resolvePasturaDescansoBaseline`
devuelve `null` cuando no existe un perfil regional real -- el
repositorio traduce eso en el estado `NO_PASTURE_PROFILE` (bloquea el
cálculo con un error semántico 404, nunca inventa un rango genérico).
"Preferir no recomendar automáticamente antes que inventar un descanso
universal" (§4).

Agregar un segundo perfil `PASTURE_SPECIFIC_REGIONAL` (otra especie/
región) en un sprint futuro es aditivo -- nueva entrada en
`PASTURA_DESCANSO_ESPECIFICA`, sin tocar el resto del motor.

## Clasificador agroclimático (`agroClimateAssessment.js`)

Reglas explícitas y nombradas (nunca suma de puntos opaca, §13):

| Señal | Regla | Umbral | Fuente del umbral |
|---|---|---|---|
| Precipitación 7d | `RULE_DROUGHT_PERSISTENT`, `RULE_RECENT_DRY_NOT_SEVERE`, `RULE_RECENT_RAIN_AFTER_DRY_PERIOD`, `RULE_SUSTAINED_MOISTURE` | 10 mm | `PRECIPITACION_7D_UMBRAL_DEFICIT_MM` -- MISMO umbral ya vigente y citado en `pastureClimateEngine.js` (FAO/AGROSAVIA pastoreo racional), reutilizado, nunca un segundo número para "lo mismo". |
| Precipitación 15d | idem | 20 mm | Extensión proporcional del umbral de 7d (10×15/7≈21.4, redondeado a 20) -- regla de ingeniería propia. |
| Precipitación 30d | idem | 40 mm | Extensión proporcional del umbral de 7d (10×30/7≈42.9, redondeado a 40) -- regla de ingeniería propia (`MOTOR_DESCANSO_AJUSTE_DEFICIT_30D`). |
| Humedad de suelo (0-7cm / 7-28cm, ERA5-Land) | `RULE_SOIL_MOISTURE_LOW`, `RULE_SOIL_MOISTURE_ADEQUATE` -- **prioridad ALTA** (§9): nunca favorable si el suelo está seco, aunque haya llovido. | 0.15 m³/m³ | Heurística conservadora propia -- NO atribuida a ERA5-Land/FAO como cifra publicada para esta región específica. |
| Temperatura | `RULE_HIGH_HEAT`, `RULE_TEMPERATURE_BELOW_COMPATIBLE`, `RULE_TEMPERATURE_COMPATIBLE` -- modula (extiende/degrada confianza), NUNCA acorta. | 15-35 °C | Rango conservador propio para gramíneas C4 tropicales -- no una curva fisiológica de la especie. |
| Radiación / humedad relativa | Capturadas y auditables (`RULE_RADIATION_RECORDED`/`RULE_HUMIDITY_RECORDED`), NUNCA mueven el status en v1. | -- | Sin regla técnica defendible documentada todavía -- arquitectura preparada. |

Prioridad de clasificación (§7): déficit persistente + suelo bajo ->
`SEVERELY_RESTRICTIVE`; cualquier señal restrictiva individual ->
`RESTRICTIVE`; sin ningún dato usable -> `INSUFFICIENT_DATA`;
precipitación sostenida + suelo adecuado + temperatura compatible ->
`FAVORABLE`; cualquier otro caso -> `NORMAL`.

## Frescura del contexto (`agroClimateFreshness.js`)

Ventanas documentadas como regla de ingeniería propia: `FRESH` ≤10 días
(mismo orden de magnitud del rezago operativo de ERA5-Land ya documentado
en `0006_potrero_contexto_agroclimatico.sql`), `AGING` ≤30 días (mismo
orden que la ventana de precipitación de 30 días), `STALE` >30 días.
Prioriza `source_observed_until` (dato real de la fuente) sobre
`created_at` (fecha de registro del snapshot).

## Ajuste dinámico del rango (`descansoFormulas.js`)

- `NORMAL`/`INSUFFICIENT_DATA`: mantiene el baseline (sin evidencia
  suficiente para desviarse).
- `FAVORABLE`: min/max quedan en el baseline -- el recomendado se orienta
  al punto medio entre min y typical (nunca por debajo del mínimo).
- `RESTRICTIVE`: +5 días al rango completo (desplazamiento uniforme).
- `SEVERELY_RESTRICTIVE`: +10 días al rango completo.

Ambos valores (+5/+10) son reglas de ingeniería propias, conservadoras,
testeadas -- nunca atribuidas a una fuente externa.

## Guardrail de presión de pastoreo

Arquitectura preparada -- en v1, con el motor de pastoreo (3D7.2)
respetado, `remanenteProyectadoKg` siempre `>= remanenteObjetivoKg` por
construcción matemática de `computeRemnantDerivatives`. Cubierto por
tests unitarios que fuerzan la rama sintéticamente -- no debería
dispararse hoy desde el flujo real.

## HARDENING TERRITORIAL -- corrección de umbrales absolutos universales

Corrección explícita respecto a la primera versión del clasificador
agroclimático: los umbrales de la tabla de `agroClimateAssessment.js`
(precipitación 7d/15d/30d, humedad de suelo 0.15 m³/m³) **YA NO son la
señal principal**. Se re-etiquetaron como `RULE_ABSOLUTE_GUARDRAIL_*` --
un guardrail auxiliar que SOLO se activa cuando el potrero todavía no
tiene climatología local calculada (`INSUFFICIENT_LOCAL_CLIMATOLOGY`), y
que degrada la confianza SIEMPRE (nunca ALTA) cuando se usa.

La señal principal ahora es **percentil LOCAL**: `climatologyStatistics.js`
calcula breakpoints P10/P25/P50/P75/P90 por mes calendario y por potrero
a partir de series históricas reales (`era5HistoricalClimatologyProvider.js`
-- MISMO mecanismo Open-Meteo/ERA5-Land/ERA5 ya verificado en
`era5LandProvider.js`, extendido a un rango de años en vez de una ventana
de 33 días). El mismo valor absoluto (p. ej. 0.20 m³/m³) se clasifica de
forma DISTINTA según la distribución histórica local de cada
potrero/época del año -- verificado con test de territorialidad end-to-end
contra Postgres real (`potreroDescansoRepositoryIntegration.test.js`).

**Periodo climatológico**: 1991-2020 para precipitación/temperatura --
normal climatológica ESTÁNDAR de la OMM/WMO (30 años), plenamente cubierta
por ERA5/ERA5-Land. Humedad de suelo: ventana más corta (5 años completos
más recientes) -- limitación DOCUMENTADA de v1 (payload/tiempo de
respuesta acotados por petición), nunca presentada como limitación de la
fuente.

**Temperatura -- única excepción deliberada**: el guardrail de 15-35°C
se conserva como `SPECIES_PHYSIOLOGICAL_LIMIT` (legítimo con o sin
climatología local -- es un límite de la ESPECIE, no del territorio),
distinto de `RULE_LOCAL_TEMPERATURE_ANOMALY_RECORDED` (percentil,
puramente informativo, nunca decide el status por sí solo).

**Frescura source-aware**: `agroClimateFreshness.js` distingue ventanas
por fuente (`fuente_principal` del snapshot) -- ERA5-Land (rezago
documentado ~6 días, FRESH≤10d/AGING≤30d) vs. IDEAM (observación de
estación, FRESH≤3d/AGING≤10d). Sin fuente conocida, se aplica siempre la
ventana MÁS conservadora (ERA5-Land), nunca la más laxa por defecto.

## HARDENING OPERACIONAL -- 4 correcciones verificadas empíricamente

**1. Humedad de suelo -- periodo unificado (corrección real, no cosmética)**.
La primera versión de este motor usaba 5 años para humedad de suelo
alegando "limitación de payload". Auditoría empírica real (2026-08-25,
`curl` directo contra `archive-api.open-meteo.com`, `models=era5_land`,
punto real de POTRERO 1: lat 1.2499, lng -75.8848) confirmó **100% de
horas con dato** para `soil_moisture_0_to_7cm`, `soil_moisture_7_to_28cm`
y `temperature_2m` en 1991, 2000, 2010 y 2020 (muestras de 3 días cada
una). No existe limitación real de la fuente -- corregido: humedad de
suelo usa el MISMO periodo 1991-2020 que precipitación/temperatura
(`fetchPotreroLocalClimatologySource` ya no acepta `soilMoistureYears`).

**2. Like-for-like verificado**. `extractClimatologiaMensual` (en
`potreroDescansoRepository.js`) y `assessPrecipitacionTerritorial` (en
`agroClimateAssessment.js`) YA comparaban cada ventana contra su propia
distribución (`precipitacion7dMm` actual vs. climatología
`precipitacion7dMm`, nunca contra `precipitacion30dMm`) -- verificado con
test dedicado (`§2 like-for-like` en `agroClimateAssessment.test.js`) que
prueba explícitamente que un valor típico de la distribución de 30 días
jamás se clasifica como "alto" si llega etiquetado como 7 días.

**3. FAVORABLE exige evidencia multivariable -- bug real corregido**. La
rama territorial etiquetaba precipitación NORMAL (P25-P75, "7d y 30d
ambos normales") como `FAVORABLE` en la primera versión -- una
normalidad simple NUNCA es evidencia de "favorable". Corregido:
`assessPrecipitacionTerritorial`/`assessSueloTerritorial` ahora devuelven
un `level` (5 niveles: `VERY_LOW/LOW/NORMAL/HIGH/VERY_HIGH`,
`climatologyStatistics.js`) sin decidir FAVORABLE por sí solos -- el
combinador exige **al menos una variable HIGH/VERY_HIGH (percentil ≥P75)
Y la otra variable determinada y no en conflicto**. Un P55 (o cualquier
lectura NORMAL) nunca dispara FAVORABLE por sí sola ni en combinación con
otra variable meramente normal.

**4. Completitud mínima (`MIN_COVERAGE_PCT = 0.7`)**. Una variable con
cobertura histórica por debajo del 70% de los años solicitados (demasiados
años fallidos) NUNCA se persiste como climatología utilizable -- queda
ausente de `monthly_statistics_json`, degradando honestamente a
`INSUFFICIENT_LOCAL_CLIMATOLOGY` para esa variable en vez de fabricar un
percentil de baja confianza. Verificado con test de integración real
(`potreroClimatologiaRepositoryIntegration.test.js`).

## HARDENING OPERACIONAL (round 5) -- climatología automática en el flujo real

`refreshPotreroClimatologia` existía desde el hardening territorial pero
ningún flujo real la invocaba -- el motor de descanso podía enviarse sin
que la climatología local se generara nunca. Cerrado: `preview` y `create`
(`potreroDescansoRepository.js#getOrGenerateClimatologia`) ahora consultan
la caché y, si está ausente o inválida (`isClimatologyCacheValid`:
potrero + `method_version` + periodo), generan y persisten
`refreshPotreroClimatologiaCore` **dentro de la MISMA transacción** --
nunca una transacción anidada, nunca un paso extra del cliente. `GET`
(`getDescansoReentradaByPotrero`) no pasa por `resolveDescanso` y por lo
tanto NUNCA dispara generación -- sigue siendo estrictamente read-only.

**Duración real medida (smoke con `fetchImpl` inyectado, sin red real)**:
un intento de generación con el proveedor completamente caído (503 en las
4 variables) toma ~2.5s (retries con backoff de `fetchJsonWithRetry`
antes de agotar cada año) -- muy por debajo del `deadlineMs` de 25s por
variable. Una generación exitosa (4 variables en paralelo, lotes de 6
años) toma ~0.8-0.9s en el smoke mockeado. Con esta evidencia se decidió
NO construir un job asíncrono (§6 del sprint: "medir primero") -- la
respuesta síncrona es viable.

**Cobertura cero -> nunca cachea una fila vacía (bug real corregido en
esta ronda)**. `refreshPotreroClimatologiaCore` lanza
`INSUFFICIENT_LOCAL_CLIMATOLOGY` si NINGUNA variable alcanza
`MIN_COVERAGE_PCT` -- antes de esta corrección se persistía una fila con
`monthly_statistics_json = {}` que `isClimatologyCacheValid` habría
tratado como válida para siempre, congelando el potrero en modo
degradado sin reintentar jamás. `getOrGenerateClimatologia` atrapa ese
error y degrada a "sin climatología" (mismo tratamiento que cualquier
otro fallo del proveedor).

**Concurrencia (§7)**: dos transacciones simultáneas para el mismo
potrero sin caché usan `pg_advisory_xact_lock($potreroId)` -- lock
transaccional (se libera solo al COMMIT/ROLLBACK), sin infraestructura
nueva. La segunda transacción bloquea hasta que la primera confirme,
luego relee la caché (double-check) y la reutiliza en vez de generar de
nuevo. Verificado con test de integración real disparando dos `preview`
en paralelo (`Promise.all`) -- exactamente una climatología persistida.
Riesgo aceptado documentado: mientras una transacción genera, la conexión
de la segunda queda ociosa-en-transacción esperando el lock (hasta ~25s
en el peor caso real); v1 no libera esa conexión antes.

Tests: `potreroDescansoRepositoryIntegration.test.js` (bloque "§11: tests
A-H" + test de concurrencia), `potreroClimatologiaRepositoryIntegration.test.js`
(test de cobertura cero).

## SEMANTIC FINAL FIX -- consistencia QA visual (post round 5)

El QA visual del round 5 reveló tres inconsistencias -- las tres, en
auditoría, resultaron ser datos ilustrativos del harness temporal
(hardcodeados a mano, nunca verificados contra el motor real), NO
defectos del cálculo determinístico. Aun así, la auditoría encontró DOS
gaps arquitectónicos reales que se corrigieron:

**1. `climatologyGenerated`/cacheHit nunca participan en confidence
(confirmado, no era un bug real)**. `resolveNivelConfianzaDescanso`
(`descansoFormulas.js`) nunca recibió ni leyó esos flags -- son estados
operacionales/UX, la confianza depende solo de evidencia (freshness,
`agroClimateConfidenceImpact`, antigüedad de la recomendación, guardrail
de presión). Verificado con test PURO (misma entrada +
`climatologyGenerated: true` vs `false` -> idéntico resultado) y test de
INTEGRACIÓN real (climatología recién generada vs. la misma climatología
leída de caché -> idéntico `nivelConfianza`, `potreroDescansoRepositoryIntegration.test.js`).

**2. `precipitacion15dMm` era un parámetro MUERTO -- bug real
corregido**. `assessAgroClimate` lo recibía y lo destructuraba, pero
`assessPrecipitacionTerritorial` nunca lo usaba -- "persistente" se
decidía solo con 7d+30d. Corregido: PERSISTENTE ahora es
`7d BAJO Y (15d BAJO O 30d BAJO)`; si 7d está bajo pero NI 15d NI 30d
lo están, es `RULE_LOCAL_RECENT_PRECIP_DEFICIT` (renombrada de
`RULE_LOCAL_RECENT_DRY_NOT_SEVERE` para reflejar la distinción explícita
reciente-vs-persistente). `localAnomalies.precipitacion15dNivel` ahora
viaja en la respuesta y se muestra en el detalle técnico junto a 7d/30d.

**3. `RULE_LOCAL_ABOVE_NORMAL_MOISTURE` compartido entre precipitación y
suelo -- bug real corregido**. Ambas ramas (`assessPrecipitacionTerritorial`
y `assessSueloTerritorial`) reusaban el mismo nombre de regla para "alto",
mapeado en el frontend a un bullet de SUELO -- si la evidencia FAVORABLE
provenía de precipitación, el "por qué" mostraba una razón de suelo
incorrecta. Corregido: precipitación usa `RULE_LOCAL_ABOVE_NORMAL_PRECIP`
(nombre propio), suelo conserva `RULE_LOCAL_ABOVE_NORMAL_MOISTURE`.

**4. Generador de "por qué" -- VARIABLE SIGNAL vs OVERALL ASSESSMENT**.
`resolveWhyBullets` (`PotreroDescansoReentradaPanel.jsx`) ahora recibe
`status` además de `appliedRules`: antepone una frase introductoria por
status (`RESTRICTIVE`/`SEVERELY_RESTRICTIVE`) antes de las razones
específicas, nunca duplica texto de regla cruda; para `NORMAL` sin
ninguna señal secundaria muestra una reassurance explícita en vez de una
sección vacía; las reglas "recent"/"recovery" (`RULE_LOCAL_RECENT_PRECIP_DEFICIT`,
`RULE_RECENT_RAIN_AFTER_LOCAL_DROUGHT`) ya son autoexplicativas
("condiciones generales... aunque/pero...") y nunca se presentan como si
fueran la conclusión general.

Tests: `descansoFormulas.test.js` (confidence vs cache, prueba pura),
`agroClimateAssessment.test.js` (persistente vs reciente, nombres de
regla propios por variable), `potreroDescansoRepositoryIntegration.test.js`
(confidence vs cache, integración real), `potreroDescansoReentradaArchitecture.test.js`
(copy del generador de "por qué", detalle técnico con 15d).

## HOTFIX 3D8.1 -- AUTOMATIC GRAZING START (fechaInicioPastoreo server-side)

El smoke real reveló fricción de producto: pedirle al productor una
"fecha prevista de ingreso" para calcular el descanso es innecesario --
AgroGenomaX ya conoce todo lo demás; cuando el productor pulsa "Calcular
descanso", el pastoreo empieza HOY.

**Fecha resuelta server-side (`businessTimezone.js`)**. `resolveFechaHoyNegocio(now)`
usa `Intl.DateTimeFormat(...).formatToParts` con timezone `America/Bogota`
(UTC-5 todo el año, sin horario de verano) -- NUNCA `toISOString().slice(0,10)`
directo, que se adelanta un día completo entre las 19:00 y las 23:59 hora
Bogotá (verificado con test: un instante UTC de madrugada resuelve el día
Bogotá anterior). `now` es un parámetro de inyección SOLO para tests
(default `new Date()` real) -- el cliente nunca lo aporta.

**Contrato preview/create simplificado**. `fechaInicioPastoreo` desaparece
de `ALLOWED_KEYS` en ambas rutas -- un cliente que lo envíe recibe
`FORBIDDEN_FIELDS` (rechazo explícito, nunca "ignorado en silencio"). El
único input opcional restante:
- `anclarAFechaExistente` (boolean, preview y create): modo "Actualizar
  estimación" -- ancla `fechaInicioPastoreo` a la de la recomendación de
  descanso YA GUARDADA en vez de hoy. Un refresh climático NUNCA mueve la
  fecha de ingreso/salida original (verificado: crear con `now=díaA`,
  luego "actualizar" con `now=díaB` muy posterior conserva
  `fechaInicioPastoreo`/`fechaSalidaEstimada` idénticas, solo cambia
  descanso/reentrada/confianza).
- `confirmedFechaInicioPastoreo` (create únicamente): eco OPCIONAL de la
  fecha vista en el último preview -- NUNCA fija el cálculo. Si el día
  cambió entre el preview y el guardado, `create` rechaza con
  `STALE_PREVIEW_DATE_CHANGED` (409) en vez de persistir silenciosamente
  bajo una fecha distinta a la que el usuario confirmó ver; el frontend
  recalcula automáticamente y muestra el preview nuevo.

**Reporte integrado ("Plan de pastoreo AgroGenomaX")**. `buildResponsePayload`/
`buildParametrosFuenteJson` ahora incluyen `lote` (categoría, número de
animales, peso promedio -- de la recomendación de pastoreo YA GUARDADA,
vía JOIN a `catalogo_categorias_productivas`) y `disponibilidad` (MS
utilizable, consumo proyectado, remanente proyectado/objetivo, de
`computeRemnantDerivatives`). El frontend (`PlanPastoreoReport`) combina
lote + pastoreo + descanso + reentrada + condiciones + por qué + condición
de reingreso en una sola lectura -- reutilizado tanto para un preview
recién calculado como para `actual` (recomendación ya guardada).

Tests: `businessTimezone.test.js` (timezone, incluida la franja
madrugada UTC/Bogotá), `ganaderiaPotreroDescansoReentradaValidation.test.js`
(fechaInicioPastoreo rechazada, anclarAFechaExistente/confirmedFechaInicioPastoreo),
`potreroDescansoRepositoryIntegration.test.js` (bloque "HOTFIX 3D8.1 tests
A-I": timezone, sin input, anti-spoof, autosuficiencia, día-cambiado,
ancla-preserva-fechas, reporte integrado), `potreroDescansoReentradaArchitecture.test.js`
(sin selector de fecha, reporte integrado, STALE_PREVIEW_DATE_CHANGED).

## HOTFIX 3D8.2 -- SINGLE CLICK REST CALCULATION

El smoke real de producción reportó que el PRIMER cálculo de descanso
necesitaba DOS clics en "Calcular descanso". Auditoría de
`previewDescansoReentrada`/`resolveDescanso`/`getOrGenerateClimatologia`/
`refreshPotreroClimatologia` -- **ningún early-return, ninguna doble
llamada al proveedor histórico, ningún `climatologyGenerated:true` con
`resultado` incompleto** (confirmado con tests dedicados de "una sola
llamada", sin cache y con cache, ambos con plan completo en la misma
respuesta). El backend ya era correcto desde el hotfix 3D8.1.

**Causa raíz real -- frontend, wiring del botón inicial**.
`PotreroDescansoReentradaPanel.jsx`: el botón "Calcular descanso" del
estado COLAPSADO estaba conectado a `handleAbrir`, que solo expandía el
panel y ejecutaba un GET (`loadDescanso`) para ver si ya existía una
recomendación -- si no existía ninguna (el caso típico de un primer
cálculo), el usuario veía un SEGUNDO botón "Calcular descanso" (dentro
del panel ya expandido) que recién ahí disparaba el `POST /preview` real.
Dos clics para lo que el usuario percibía como una sola acción.

**Corrección**: `loadDescanso({ autoCalcularSiVacio })` encadena
`calcularPreview(false)` automáticamente, dentro de la MISMA promesa,
cuando el GET confirma que no existe ninguna recomendación previa --
`handleAbrir` pasa `autoCalcularSiVacio: true`. El refresh posterior a un
guardado exitoso (`handleGuardar`) NUNCA pasa ese flag -- ahí solo
queremos mostrar el plan recién guardado, no disparar otro cálculo.

Tests: `potreroDescansoReentradaArchitecture.test.js` (wiring exacto de
`handleAbrir`/`loadDescanso`, ausencia de un segundo punto de llamada a
`previewDescansoReentrada`, botón deshabilitado durante toda la request),
`potreroDescansoRepositoryIntegration.test.js` (bloque "HOTFIX 3D8.2":
una sola llamada sin caché persiste climatología y devuelve plan
completo; una sola llamada con caché -- proveedor histórico cero
llamadas, mismo resultado científico).
