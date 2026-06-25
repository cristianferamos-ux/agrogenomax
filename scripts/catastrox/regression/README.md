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

## Uso recomendado

El runner local automatiza el servidor temporal y ejecuta la regresión completa:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/catastrox/regression/run-v7-regression.ps1
```

También puedes usar el script npm:

```powershell
npm run catastrox:regression:local
```

## Comando normal

```powershell
npm run catastrox:regression
```

Este comando falla por defecto si la generación PDF reporta error.

## Fuentes PDF

Si faltan `/fonts/catastrox/arial.ttf` o `/fonts/catastrox/arialbd.ttf`, CatastroX usa un fallback seguro del entorno (`Arial, sans-serif`) y deja una advertencia diagnóstica en consola. Ese caso ya no requiere `CATASTROX_ALLOW_PDF_ERROR=1`.

`CATASTROX_ALLOW_PDF_ERROR=1` queda reservado para depuración cuando exista otro `pdfError` que quieras tolerar explícitamente:

```powershell
$env:CATASTROX_ALLOW_PDF_ERROR="1"
npm run catastrox:regression
Remove-Item Env:CATASTROX_ALLOW_PDF_ERROR -ErrorAction SilentlyContinue
```

Con el runner local:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/catastrox/regression/run-v7-regression.ps1 -AllowPdfError
```

## Escribir artefactos

Para guardar artefactos bajo `tmp/pdfs`:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/catastrox/regression/run-v7-regression.ps1 -WriteArtifacts
```

## Si CDP no está activo

Si `http://127.0.0.1:9222/json/version` no responde, abre Chrome o Chromium con depuración remota. Ejemplo en PowerShell:

```powershell
chrome.exe --remote-debugging-port=9222 --user-data-dir="$env:TEMP\catastrox-cdp-profile"
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
- logs temporales del runner local

No deben commitearse.
