# CatastroX V7 Regression

Este harness valida la regresión funcional de CatastroX V7 para los casos `simple` e `irregular` sin relajar las métricas esperadas del motor productivo.

## Qué valida

- `simple`
  - `totalRequested: 4`
  - `totalPlaced: 4`
  - `totalHidden: 0`
  - `guideLinesSuggested: 0`
  - `guideLinesRendered: 0`
- `irregular`
  - `totalRequested: 20`
  - `totalPlaced: 20`
  - `totalHidden: 0`
  - `guideLinesSuggested: 3`
  - `guideLinesRendered: 3`
  - `guideLineReasons: { "edge-angular-fallback-short-displaced": 3 }`
  - `recoveredLongVisibleVertices: 7`
  - `recoveredLongVisibleSpans: 1`
  - `P3-P4` recuperado
  - `P13` a `P20` presentes

También valida ausencia de:

- solapes entre etiquetas
- etiquetas dentro del polígono
- etiquetas tapando puntos visibles

## Requisitos previos

- Servidor local del proyecto sirviendo el worktree actual en `http://127.0.0.1:4175`
- Navegador Chromium/Chrome con CDP en `http://127.0.0.1:9222`

## Comando normal

```powershell
npm run catastrox:regression
```

Este comando falla por defecto si la generación PDF reporta error.

## Si falta la fuente PDF

Si el único problema es la ausencia de `/fonts/catastrox/arial.ttf` o fuentes relacionadas, en PowerShell puedes permitir ese error explícitamente:

```powershell
$env:CATASTROX_ALLOW_PDF_ERROR="1"
npm run catastrox:regression
Remove-Item Env:CATASTROX_ALLOW_PDF_ERROR -ErrorAction SilentlyContinue
```

## Variables disponibles

- `CATASTROX_REGRESSION_URL`
  - URL completa del harness HTML
- `CATASTROX_CDP_URL`
  - endpoint `json/version` del navegador con CDP
- `CATASTROX_ALLOW_PDF_ERROR`
  - si vale `1`, permite `pdfError` y lo reporta explícitamente
- `CATASTROX_WRITE_ARTIFACTS`
  - si vale `1`, escribe artefactos bajo `tmp/pdfs`

## Artefactos temporales

- `tmp/`
- PDFs generados
- resúmenes JSON de regresión

No deben commitearse.
