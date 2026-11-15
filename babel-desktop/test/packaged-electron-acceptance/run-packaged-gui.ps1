# License: Apache-2.0
param(
  [Parameter(Mandatory = $true)][string]$InstallRoot,
  [string]$SourceSha = '',
  [string]$ArtifactDir = '',
  [switch]$NativeProjectPicker
)

$ErrorActionPreference = 'Stop'
$desktop = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$acceptance = Join-Path $PSScriptRoot 'packaged_gui_acceptance.mjs'
if ($ArtifactDir) {
  New-Item -ItemType Directory -Path $ArtifactDir -Force | Out-Null
  $env:BABEL_DESKTOP_ACCEPTANCE_DIR = (Resolve-Path -LiteralPath $ArtifactDir).Path
} else {
  $defaultArtifacts = Join-Path $desktop 'artifacts/packaged-electron'
  New-Item -ItemType Directory -Path $defaultArtifacts -Force | Out-Null
  $env:BABEL_DESKTOP_ACCEPTANCE_DIR = (Resolve-Path -LiteralPath $defaultArtifacts).Path
}

function Write-PackagedPreflight([string]$Stage, [string]$Reason, [int]$Code) {
  $report = [ordered]@{passed=0; failure=@{stage=$Stage; reason=$Reason; exitCode=$Code};
    identity=@{requestedSourceSha=$SourceSha}; journeys=@{}; untestedJourneys=@('installed Desktop tasks')}
  $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $env:BABEL_DESKTOP_ACCEPTANCE_DIR 'packaged-electron-acceptance.json') -Encoding utf8
}
function Stop-PackagedPreflight([string]$Stage, [string]$Reason, [int]$Code) {
  Write-PackagedPreflight $Stage $Reason $Code
  exit $Code
}

try { $env:BABEL_DESKTOP_INSTALL_ROOT = (Resolve-Path -LiteralPath $InstallRoot -ErrorAction Stop).Path }
catch { Stop-PackagedPreflight 'artifact-preflight' 'Installed artifact directory is unavailable' 1 }
if ($SourceSha -cnotmatch '^[a-f0-9]{40}$') { Stop-PackagedPreflight 'artifact-preflight' 'Exact source SHA is required' 1 }
$env:BABEL_DESKTOP_SOURCE_SHA = $SourceSha
if (-not (Test-Path -LiteralPath $acceptance -PathType Leaf)) { Stop-PackagedPreflight 'harness-preflight' 'Packaged acceptance script is unavailable' 1 }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { Stop-PackagedPreflight 'dependency-preflight' 'npm is unavailable' 1 }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Stop-PackagedPreflight 'dependency-preflight' 'Node is unavailable' 1 }

Push-Location $desktop
try {
  npm exec -- playwright install chromium | Out-Null
  if ($LASTEXITCODE -ne 0) { Stop-PackagedPreflight 'dependency-preflight' 'Playwright setup failed' $LASTEXITCODE }
} catch {
  Stop-PackagedPreflight 'dependency-preflight' 'Playwright setup could not start' 1
} finally { Pop-Location }

try {
  node --test (Join-Path $PSScriptRoot 'scripted-provider.test.mjs') (Join-Path $PSScriptRoot 'owned-cleanup.test.mjs')
  if ($LASTEXITCODE -ne 0) { Stop-PackagedPreflight 'provider-preflight' 'Scripted provider checks failed' $LASTEXITCODE }
} catch { Stop-PackagedPreflight 'provider-preflight' 'Scripted provider checks could not start' 1 }

Write-PackagedPreflight 'harness-start' 'Acceptance process did not finish writing its receipt' 1
node $acceptance
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

if ($NativeProjectPicker) {
  node (Join-Path $PSScriptRoot 'native_project_picker.mjs')
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
