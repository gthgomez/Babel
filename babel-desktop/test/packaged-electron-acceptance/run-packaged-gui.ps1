# License: Apache-2.0
param(
  [Parameter(Mandatory = $true)][string]$InstallRoot,
  [string]$SourceSha = ''
)

$ErrorActionPreference = 'Stop'
$scriptDir = $PSScriptRoot
$acceptance = Join-Path $scriptDir 'packaged_gui_acceptance.py'
if (-not (Test-Path -LiteralPath $acceptance -PathType Leaf)) { throw "Missing acceptance script: $acceptance" }

$python = (Get-Command python -ErrorAction Stop).Source
& $python -m pip install --disable-pip-version-check -q playwright | Out-Null
& $python -m playwright install chromium | Out-Null

$env:BABEL_DESKTOP_INSTALL_ROOT = (Resolve-Path -LiteralPath $InstallRoot).Path
if ($SourceSha) { $env:BABEL_DESKTOP_SOURCE_SHA = $SourceSha }
& $python $acceptance
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
