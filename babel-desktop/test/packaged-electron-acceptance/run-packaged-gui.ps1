# License: Apache-2.0
param(
  [Parameter(Mandatory = $true)][string]$InstallRoot,
  [string]$SourceSha = '',
  [string]$ArtifactDir = ''
)

$ErrorActionPreference = 'Stop'
$desktop = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$acceptance = Join-Path $PSScriptRoot 'packaged_gui_acceptance.mjs'
if (-not (Test-Path -LiteralPath $acceptance -PathType Leaf)) { throw "Missing acceptance script: $acceptance" }

Push-Location $desktop
try {
  npm exec -- playwright install chromium | Out-Null
} finally { Pop-Location }

$env:BABEL_DESKTOP_INSTALL_ROOT = (Resolve-Path -LiteralPath $InstallRoot).Path
if ($SourceSha) { $env:BABEL_DESKTOP_SOURCE_SHA = $SourceSha }
if ($ArtifactDir) {
  $env:BABEL_DESKTOP_ACCEPTANCE_DIR = (Resolve-Path -LiteralPath $ArtifactDir -ErrorAction SilentlyContinue)
  if (-not $env:BABEL_DESKTOP_ACCEPTANCE_DIR) {
    New-Item -ItemType Directory -Path $ArtifactDir -Force | Out-Null
    $env:BABEL_DESKTOP_ACCEPTANCE_DIR = (Resolve-Path -LiteralPath $ArtifactDir).Path
  }
} else {
  $defaultArtifacts = Join-Path $desktop 'artifacts/packaged-electron'
  New-Item -ItemType Directory -Path $defaultArtifacts -Force | Out-Null
  $env:BABEL_DESKTOP_ACCEPTANCE_DIR = (Resolve-Path -LiteralPath $defaultArtifacts).Path
}

node $acceptance
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
