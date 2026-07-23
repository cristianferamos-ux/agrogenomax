# CatastroX Real-World Diagnostic

Esta herramienta permite probar el motor real de entregables CatastroX con un predio cargado desde un JSON local, sin construir todavía la UI cliente.

## Qué valida

- Generación de:
  - PDF plano
  - PDF diagnóstico
  - KML
  - KMZ
  - SHP ZIP
- Métricas técnicas del plano:
  - vértices oficiales
  - puntos visibles
  - etiquetas solicitadas, colocadas y ocultas
  - `guideLinesSuggested`
  - `guideLinesRendered`
  - `labelOverlapCount`
  - `labelsInsidePolygonCount`
  - `labelsOverPointCount`

## Contrato mínimo de entrada

```json
{
  "id": "string",
  "codigoPredial": "string",
  "codigoAnterior": "string",
  "municipio": "string",
  "departamento": "string",
  "areaHa": 0,
  "areaM2": 0,
  "perimetroM": 0,
  "polygonGeoJson": { "type": "Feature", "geometry": { "type": "Polygon", "coordinates": [] } },
  "geometry": { "type": "Polygon", "coordinates": [] },
  "queryPoint": { "lat": 0, "lng": 0 },
  "referencePoint": { "lat": 0, "lng": 0 }
}
```

También acepta:
- un objeto raíz con forma `{ "predio": { ... } }`
- un GeoJSON `Feature`, `Polygon` o `MultiPolygon`, aunque en ese caso faltarán atributos descriptivos si no los incluyes

## Ejemplo seguro

- [sample-predio.example.json](./sample-predio.example.json)

## Requisitos previos

- Chrome o Chromium con CDP disponible en `http://127.0.0.1:9222/json/version`

Ejemplo en PowerShell:

```powershell
chrome.exe --remote-debugging-port=9222 --user-data-dir="$env:TEMP\catastrox-cdp-profile"
```

## Ejecución

Con el ejemplo seguro:

```powershell
npm run catastrox:real-predio -- scripts/catastrox/real-world/sample-predio.example.json
```

Con un JSON local externo:

```powershell
node scripts/catastrox/real-world/validate-real-predio.mjs C:\ruta\local\mi-predio.json
```

## Artefactos

Los artefactos se escriben únicamente bajo:

```text
tmp/catastrox-real-world/
```

El runner guarda:
- `input.json`
- `summary.json`
- `*_plano.pdf`
- `*.pdf`
- `*.kml`
- `*.kmz`
- `*.zip`

## Qué no debe commitearse

- JSON reales del cliente
- PDFs generados
- KML, KMZ, SHP o ZIP generados
- cualquier contenido bajo `tmp/catastrox-real-world/`

Usa rutas externas o `tmp/` para datos reales. No subas bases catastrales pesadas al repo.

## Cómo interpretar métricas

- `ringVertices`: vértices oficiales de la geometría de entrada
- `totalVisiblePoints`: puntos Pn visibles en el plano técnico
- `totalRequested`: etiquetas de distancia pedidas por el motor
- `totalPlaced`: etiquetas colocadas
- `totalHidden`: etiquetas ocultas
- `guideLinesSuggested`: guías sugeridas por el placement
- `guideLinesRendered`: guías efectivamente renderizadas
- `labelOverlapCount`: solapes entre etiquetas
- `labelsInsidePolygonCount`: etiquetas dentro del polígono
- `labelsOverPointCount`: etiquetas tapando puntos visibles
- `pdfBytes`, `kmlBytes`, `kmzBytes`, `shpZipBytes`: tamaño de los artefactos generados
