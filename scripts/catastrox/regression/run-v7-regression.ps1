[CmdletBinding()]
param(
  [switch]$AllowPdfError,
  [switch]$WriteArtifacts,
  [int]$Port = 4175,
  [string]$BindHost = '127.0.0.1',
  [string]$CdpVersionUrl = 'http://127.0.0.1:9222/json/version'
)

$ErrorActionPreference = 'Stop'

function Test-HttpOk {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Url
  )

  try {
    $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 5
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 400
  } catch {
    return $false
  }
}

function Wait-UntilAvailable {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Url,
    [int]$Attempts = 30,
    [int]$DelayMilliseconds = 500
  )

  for ($attempt = 0; $attempt -lt $Attempts; $attempt += 1) {
    if (Test-HttpOk -Url $Url) {
      return $true
    }
    Start-Sleep -Milliseconds $DelayMilliseconds
  }

  return $false
}

$scriptDir = Split-Path -Parent $PSCommandPath
$workspaceRoot = (& git -C $scriptDir rev-parse --show-toplevel).Trim()
$harnessUrl = "http://$BindHost`:$Port/scripts/catastrox/regression/browser-harness.html"
$tempOut = Join-Path $env:TEMP 'catastrox-v7-regression-server.out.log'
$tempErr = Join-Path $env:TEMP 'catastrox-v7-regression-server.err.log'
$startedServer = $null
$originalLocation = Get-Location
$originalAllowPdfError = $env:CATASTROX_ALLOW_PDF_ERROR
$originalWriteArtifacts = $env:CATASTROX_WRITE_ARTIFACTS
$originalRegressionUrl = $env:CATASTROX_REGRESSION_URL
$originalCdpUrl = $env:CATASTROX_CDP_URL

try {
  if (-not $workspaceRoot) {
    throw 'No fue posible resolver la raíz del workspace con git.'
  }

  if (-not (Test-HttpOk -Url $harnessUrl)) {
    $pythonCommand = Get-Command python -ErrorAction SilentlyContinue
    if (-not $pythonCommand) {
      throw "No se encontró 'python' en PATH para levantar el servidor local de regresión."
    }

    Remove-Item -LiteralPath $tempOut, $tempErr -Force -ErrorAction SilentlyContinue
    $startedServer = Start-Process `
      -FilePath $pythonCommand.Source `
      -ArgumentList '-m', 'http.server', $Port, '--bind', $BindHost `
      -WorkingDirectory $workspaceRoot `
      -WindowStyle Hidden `
      -RedirectStandardOutput $tempOut `
      -RedirectStandardError $tempErr `
      -PassThru

    if (-not (Wait-UntilAvailable -Url $harnessUrl)) {
      throw "No fue posible levantar el servidor local de regresión en $harnessUrl."
    }
  }

  if (-not (Test-HttpOk -Url $CdpVersionUrl)) {
    Write-Error @"
CDP no está disponible en $CdpVersionUrl.

Abre Chrome o Chromium con depuración remota, por ejemplo en PowerShell:
chrome.exe --remote-debugging-port=9222 --user-data-dir="$env:TEMP\catastrox-cdp-profile"
"@
    exit 1
  }

  if ($AllowPdfError) {
    $env:CATASTROX_ALLOW_PDF_ERROR = '1'
  } else {
    Remove-Item Env:CATASTROX_ALLOW_PDF_ERROR -ErrorAction SilentlyContinue
  }

  if ($WriteArtifacts) {
    $env:CATASTROX_WRITE_ARTIFACTS = '1'
  } else {
    Remove-Item Env:CATASTROX_WRITE_ARTIFACTS -ErrorAction SilentlyContinue
  }

  $env:CATASTROX_REGRESSION_URL = $harnessUrl
  $env:CATASTROX_CDP_URL = $CdpVersionUrl
  Set-Location -LiteralPath $workspaceRoot
  npm.cmd run catastrox:regression
  exit $LASTEXITCODE
} finally {
  Set-Location -LiteralPath $originalLocation

  if ($null -ne $startedServer -and -not $startedServer.HasExited) {
    Stop-Process -Id $startedServer.Id -ErrorAction SilentlyContinue
  }

  if ($null -eq $originalAllowPdfError) {
    Remove-Item Env:CATASTROX_ALLOW_PDF_ERROR -ErrorAction SilentlyContinue
  } else {
    $env:CATASTROX_ALLOW_PDF_ERROR = $originalAllowPdfError
  }

  if ($null -eq $originalWriteArtifacts) {
    Remove-Item Env:CATASTROX_WRITE_ARTIFACTS -ErrorAction SilentlyContinue
  } else {
    $env:CATASTROX_WRITE_ARTIFACTS = $originalWriteArtifacts
  }

  if ($null -eq $originalRegressionUrl) {
    Remove-Item Env:CATASTROX_REGRESSION_URL -ErrorAction SilentlyContinue
  } else {
    $env:CATASTROX_REGRESSION_URL = $originalRegressionUrl
  }

  if ($null -eq $originalCdpUrl) {
    Remove-Item Env:CATASTROX_CDP_URL -ErrorAction SilentlyContinue
  } else {
    $env:CATASTROX_CDP_URL = $originalCdpUrl
  }

  Remove-Item -LiteralPath $tempOut, $tempErr -Force -ErrorAction SilentlyContinue
}
