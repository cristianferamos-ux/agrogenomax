# CatastroX - Blindaje del motor cartografico

Este documento protege las reglas del motor cartografico de CatastroX antes de importar nuevas fuentes GPKG/PostGIS. Su objetivo es evitar que una carga de datos mas densa rompa el PDF Plus, los planos y los entregables pagados.

## Archivos del motor

- `src/modules/catastrox/utils/GeometryCore.js`
- `src/modules/catastrox/utils/ProjectionEngine.js`
- `src/modules/catastrox/utils/DistanceEngine.js`
- `src/modules/catastrox/utils/LabelPlacementEngine.js`
- `src/modules/catastrox/utils/VisibleReferencePointEngine.js`
- `src/modules/catastrox/utils/CartographicPresentationEngine.js`
- `src/modules/catastrox/utils/catastroxDeliverables.js`

## Conceptos protegidos

### Ring tecnico

`ring` es la geometria tecnica normalizada del predio. Sale de `normalizePredioForDeliverables()` y se construye con `normalizeRing(firstRing(geometry))`.

Debe conservarse como base para:

- calculos de distancia entre puntos visibles;
- KML;
- KMZ;
- SHP;
- DXF futuro;
- validaciones tecnicas internas.

Regla central: el area y el perimetro reportados nunca deben calcularse desde `displayRing`. El area y el perimetro deben venir de la fuente tecnica o de calculos hechos sobre geometria tecnica completa.

### geometryParts

`geometryParts` es la representacion normalizada de la geometria completa del predio para entregables.

Cada parte tiene:

- `partIndex`
- `outerRing`
- `innerRings`
- `bounds`
- `vertexCount`
- `displayRing`
- `displayVertices`
- `displayRingReport`

Para `Polygon`, hay una parte con anillo exterior y posibles anillos interiores.

Para `MultiPolygon`, cada poligono se conserva como una parte independiente.

`firstRing()` queda como compatibilidad para flujos antiguos, pero no debe usarse como geometria completa.

### displayRing

`displayRing` es una geometria cartografica simplificada para representacion visual. Se crea con `buildDisplayRingFromOriginalRing(ring)`.

Sirve para:

- limpiar vertices duplicados o casi duplicados;
- reducir vertices colineales;
- conservar extremos cardinales;
- conservar quiebres de direccion;
- conservar representantes de curvas;
- dibujar planos mas legibles en PDF.

No debe usarse para:

- area reportada;
- perimetro reportado;
- KML/KMZ pagados;
- SHP;
- DXF;
- decisiones tecnicas oficiales.

### referencePoints

`referencePoints` son puntos visibles seleccionados para lectura humana del plano. Se obtienen desde `selectVisibleReferencePoints()` y luego se reducen con `reducePointsForVisualClarity()`.

No representan todos los vertices reales del predio. Representan puntos relevantes para numeracion, tablas y segmentos visibles.

### Distancias entre puntos visibles

`buildReferenceSegments(fullRing, referencePoints)` recibe `predio.ring`, no `displayRing`.

Esto es intencional: aunque los puntos visibles sean pocos, la distancia del segmento se calcula recorriendo el anillo tecnico completo entre un punto visible y el siguiente.

## Flujo protegido del PDF Plus

1. Entrada GeoJSON del predio.
2. `normalizePredioForDeliverables()`.
3. `geometryParts`: geometria completa por partes.
4. `ring`: primera parte tecnica para compatibilidad y layout primario.
5. `displayRing`: primera parte visual simplificada para compatibilidad.
6. `mapRing`: anillo de encuadre global de todas las partes.
7. `buildLayoutData()` por parte cuando hay anexos tecnicos.
8. `selectVisibleReferencePoints(displayRing)` por parte.
9. `reducePointsForVisualClarity()` por parte.
10. recuperacion de tramos largos si la silueta pierde informacion.
11. `referencePoints` por parte.
12. `buildReferenceSegments(part.outerRing, referencePoints)`.
13. proyeccion con `ProjectionEngine`.
14. rotulado con `LabelPlacementEngine`.
15. dibujo de poligonos, puntos, cotas y tablas.

## Reglas PDF

- La portada y paginas comerciales no deben saturarse con puntos.
- El plano principal debe ser limpio, legible y comercial.
- La portada debe dibujar todas las partes del predio.
- El encuadre de portada debe usar bounds global de todas las partes.
- Los anexos tecnicos pueden mostrar puntos visibles y longitudes.
- Los anexos tecnicos deben organizar puntos y longitudes por parte.
- No se deben mostrar todos los vertices de una geometria densa.
- Los puntos visibles deben limitarse por complejidad, escala y legibilidad.
- Las etiquetas deben evitar solapes con puntos, poligono, escala y otras etiquetas.
- Si una etiqueta no puede ubicarse sin contaminar el plano, puede desplazarse, usar linea guia u omitirse en el plano.

## Reglas KML/KMZ

- KML y KMZ deben usar geometria tecnica completa.
- No deben usar `displayRing`.
- Deben conservar el poligono real pagado.
- Para multipoligonos deben exportar todas las partes como `MultiGeometry`.
- Para anillos interiores deben usar `innerBoundaryIs`.
- Deben incluir solo datos habilitados por el paquete correspondiente.

## Reglas SHP/DXF

- SHP debe usar geometria completa y CRS correcto.
- El writer actual puede escribir un record `Polygon` con multiples partes.
- SHP debe incluir atributos claros y consistentes.
- DXF queda pendiente hasta resolver proyeccion metrica.
- DXF debe dibujar todas las partes, pero no debe venderse como CAD robusto mientras use coordenadas lat/lng sin proyeccion metrica.
- El paquete Profesional sigue congelado hasta validar SHP/DXF con datos GPKG limpios.

## Regresion recomendada

Existe harness de regresion en `scripts/catastrox/regression/`.

Uso recomendado:

```powershell
npm run catastrox:regression:local
```

El README del harness tambien permite:

```powershell
npm run catastrox:regression
```

Para escribir artefactos locales temporales:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/catastrox/regression/run-v7-regression.ps1 -WriteArtifacts
```

Los artefactos temporales bajo `tmp/` o carpetas de auditoria no deben commitearse.

## Reglas de cambio

Antes de importar o conectar el GPKG limpio:

- no reemplazar `ring` por `displayRing`;
- no reemplazar `geometryParts` por `firstRing`;
- no recalcular area/perimetro con geometria visual;
- no eliminar `buildDisplayRingFromOriginalRing`;
- no eliminar `selectVisibleReferencePoints`;
- no eliminar `LabelPlacementEngine`;
- no simplificar KML/KMZ/SHP/DXF con reglas de PDF;
- no activar paquete Profesional hasta cerrar soporte SHP/DXF.
