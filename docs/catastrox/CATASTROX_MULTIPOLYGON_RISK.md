# CatastroX - Riesgo multipoligono pre-GPKG

Este reporte documenta el riesgo actual de multipoligonos antes de importar el GPKG limpio de Caqueta o reemplazar la fuente PostGIS actual.

## Hallazgo original

El flujo anterior de entregables trabajaba con un solo anillo principal.

En `src/modules/catastrox/utils/catastroxDeliverables.js`:

```js
function firstRing(geometry) {
  const geo = geometryToGeoJson(geometry);
  if (!geo) return [];
  if (geo.type === 'Polygon') return geo.coordinates?.[0] || [];
  if (geo.type === 'MultiPolygon') return geo.coordinates?.[0]?.[0] || [];
  return [];
}
```

Eso implicaba:

- para `Polygon`, se toma solo el anillo exterior `coordinates[0]`;
- para `MultiPolygon`, se toma solo el primer poligono y su primer anillo `coordinates[0][0]`;
- no se procesan poligonos secundarios;
- no se procesan huecos/interiores;
- no se preserva toda la geometria si la fuente trae predios multipartes.

## Donde se usa firstRing

`firstRing()` se usa en `normalizePredioForDeliverables()`:

```js
const ring = normalizeRing(firstRing(geometry));
const displayGeometry = buildDisplayRingFromOriginalRing(ring);
```

El flujo corregido conserva `firstRing()` como fallback de compatibilidad, pero `normalizePredioForDeliverables()` ahora crea `geometryParts` con todas las partes y anillos interiores.

Desde `geometryParts` se derivan:

- render multiparte en portada PDF;
- anexos tecnicos por parte;
- KML/KMZ con todas las partes;
- SHP multiparte;
- DXF con todas las polilineas.

El `ring` legacy sigue existiendo como primera parte para compatibilidad con motores de layout existentes.

Antes de la correccion, desde `firstRing()` se derivaban:

- `ring`;
- `displayRing`;
- `displayVertices`;
- `displayRingReport`;
- PDF;
- KML;
- KMZ;
- SHP;
- DXF.

## Funciones que aceptan un solo anillo

Estas funciones trabajan actualmente con un array de puntos tipo anillo:

- `normalizeRing(ring)`
- `getRingBounds(ring)`
- `projectRingToLocalMeters(openRing)`
- `simplifyRingIndices(points, tolerance)`
- `buildDisplayRingFromOriginalRing(originalRing)`
- `selectVisibleReferencePoints(ring, options)`
- `reducePointsForVisualClarity(referenceCandidates, ring, mapState, zone, options)`
- `buildReferenceSegments(fullRing, referencePoints)`
- `projectRingToViewport(ring, mapState, width, height)`
- `drawPolygonOverlay(context, points, options)`
- `buildKmlText(source)`
- `buildShpZipBytes(source)`
- `buildDxfText(source)`

## Impacto en PDF

Si se volviera a usar `firstRing()` como fuente completa en PDF:

- el PDF podria dibujar solo la primera parte;
- el area/perimetro mostrado puede venir de la fuente completa, pero el plano visual mostraria solo una parte;
- los puntos visibles pueden pertenecer solo al primer poligono;
- las tablas de puntos y longitudes pueden quedar incompletas;
- el cliente podria recibir un plano visual inconsistente frente a los datos tecnicos.

Estado corregido:

- la portada PDF dibuja todas las partes;
- el encuadre usa geometria global;
- los anexos tecnicos se generan por parte;
- las distancias de cada anexo usan el anillo tecnico de esa parte.

## Impacto en KML/KMZ

Riesgo alto si se vuelve a usar `firstRing()`:

- KML/KMZ podrian exportar solo el primer poligono;
- se perderian partes separadas del predio;
- Google Earth mostraria una geometria incompleta;
- el valor pagado del paquete Plus quedaria comprometido.

Estado corregido:

- KML usa `MultiGeometry` cuando hay varias partes;
- KML conserva `innerBoundaryIs` cuando hay anillos interiores;
- KMZ empaqueta el KML completo.

## Impacto en SHP/DXF

Riesgo alto para el paquete Profesional si no se valida con GPKG real:

- SHP podria quedar incompleto si solo se usa el primer anillo;
- DXF podria dibujar una sola parte;
- huecos, islas o predios multipartes no quedarian representados;
- la validacion GIS/CAD podria fallar comercialmente.

Estado actual:

- SHP escribe un record `Polygon` con multiples partes.
- DXF dibuja todas las partes como polilineas separadas.
- DXF sigue pendiente por proyeccion metrica antes de venta Profesional.

## Recomendacion para GPKG limpio

Antes de importar o activar entregables desde el GPKG limpio:

1. Auditar cuantas geometria son `MultiPolygon`.
2. Auditar cuantos `Polygon` tienen anillos interiores.
3. Usar modelo interno:
   - `geometryParts`: partes tecnicas completas.
   - `displayRing` por parte para PDF comercial.
   - `mapRing`: encuadre global.
4. Mantener area/perimetro desde fuente tecnica o geometria completa.
5. Adaptar KML/KMZ para exportar todos los poligonos.
6. Adaptar SHP/DXF solo cuando Profesional se reactive.
7. Mantener `displayRing` solo como representacion visual, no como verdad tecnica.

## Adaptacion sugerida sin romper motor

No reemplazar todo el motor. Evolucionarlo por capas:

- conservar funciones de un anillo para el caso simple;
- agregar extractor de geometria completa, por ejemplo `extractPolygonParts(geometry)`;
- crear una seleccion de parte principal para portada;
- crear `displayParts` para multipoligonos;
- permitir que KML/KMZ recorran todas las partes;
- mantener `buildReferenceSegments()` sobre el anillo tecnico de la parte que se este rotulando;
- si hay varias partes, crear anexos por parte o resumen visual por parte.

## Riesgo operativo

El riesgo no esta en el motor cartografico actual, sino en asumir que toda fuente futura sera un solo poligono simple.

El GPKG limpio puede traer geometria mas rica que el motor actual. Por eso el blindaje recomendado es:

- no importar directamente al flujo de PDF sin conteo previo;
- no probar solo con un predio simple;
- validar al menos predios simples, irregulares, grandes, con muchos vertices y multipartes;
- ejecutar regresion cartografica antes y despues de conectar la nueva fuente.

## Estado recomendado

- PDF Plus: protegido para poligonos simples e irregulares de un solo anillo.
- KML/KMZ: vender solo si el predio probado no es multiparte hasta adaptar exportacion completa.
- SHP/DXF: mantener congelado.
- GPKG limpio: importar primero a staging/auditoria, no directo a flujo comercial.
