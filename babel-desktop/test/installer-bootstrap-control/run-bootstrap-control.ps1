# License: Apache-2.0
# Compiles and runs NSIS bootstrap control-flow probes (fault injection).
# Requires makensis.exe on Windows. The legacy-offset probe is a negative control:
# it must yield silent exit 0 when the bootstrap stub exits 7 (false success).
param(
  [Parameter(Mandatory = $true)][string]$MakensisPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not $IsWindows) {
  throw 'Bootstrap control probes require Windows (compiled NSIS runtime).'
}
if (-not (Test-Path -LiteralPath $MakensisPath -PathType Leaf)) {
  throw "makensis.exe not found: $MakensisPath"
}

$desktop = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$workRoot = Join-Path ([IO.Path]::GetTempPath()) ("babel-bootstrap-probes-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $workRoot -Force | Out-Null

try {
  node (Join-Path $PSScriptRoot 'build-probes.mjs') $workRoot | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "build-probes.mjs failed with exit $LASTEXITCODE" }
  $manifest = Get-Content -LiteralPath (Join-Path $workRoot 'manifest.json') -Raw | ConvertFrom-Json

  foreach ($probe in $manifest) {
    Write-Host "Compiling probe $($probe.id)"
    & $MakensisPath -V2 $probe.nsiPath
    if ($LASTEXITCODE -ne 0) { throw "makensis failed for $($probe.id)" }
    if (-not (Test-Path -LiteralPath $probe.outFile -PathType Leaf)) {
      throw "Probe executable missing: $($probe.outFile)"
    }
  }

  function Invoke-SilentProbe {
    param([Parameter(Mandatory = $true)][string]$ExePath)
    $proc = Start-Process -FilePath $ExePath -ArgumentList '/S' -Wait -PassThru
    return [int]$proc.ExitCode
  }

  $fixedSuccess = Invoke-SilentProbe -ExePath (Join-Path $workRoot 'fixed-success.exe')
  if ($fixedSuccess -ne 0) { throw "fixed-success: expected silent exit 0, got $fixedSuccess" }

  $fixedExit7 = Invoke-SilentProbe -ExePath (Join-Path $workRoot 'fixed-exit7.exe')
  if ($fixedExit7 -ne 7) { throw "fixed-exit7: expected silent exit 7, got $fixedExit7" }

  $fixedLaunch = Invoke-SilentProbe -ExePath (Join-Path $workRoot 'fixed-launch-fail.exe')
  if ($fixedLaunch -ne 98) { throw "fixed-launch-fail: expected silent exit 98, got $fixedLaunch" }

  $legacyExit7 = Invoke-SilentProbe -ExePath (Join-Path $workRoot 'legacy-exit7-negative.exe')
  if ($legacyExit7 -ne 0) {
    throw @"
Negative control failed: legacy IfErrors 0 +3 must yield silent exit 0 when bootstrap exits 7 (false success), got $legacyExit7.
If this probe now returns 7, the negative control was accidentally 'fixed' and no longer documents the bug.
"@
  }

  Push-Location $desktop
  try {
    node --input-type=module -e @"
import { renderNsis } from './scripts/package-windows-setup.mjs';
const nsi = renderNsis({
  version: '0.0.0',
  stagedPayload: 'C:/stage/payload.zip',
  stagedSha: 'C:/stage/sha',
  stagedInstall: 'C:/stage/install.ps1',
  stagedUninstall: 'C:/stage/uninstall.ps1',
  stagedBootstrap: 'C:/stage/run-install.cmd',
  outFile: 'C:/out/setup.exe',
});
if (/IfErrors 0 \+/.test(nsi)) process.exit(2);
if (!/IfErrors launch_failed/.test(nsi)) process.exit(3);
process.exit(0);
"@
    if ($LASTEXITCODE -ne 0) { throw "production renderNsis must not embed legacy IfErrors offsets (exit $LASTEXITCODE)" }
  } finally {
    Pop-Location
  }

  Write-Host 'Bootstrap control probes passed (compiled NSIS runtime).'
  Write-Host 'Interactive MessageBox paths are present in generated NSIS but not exercised in silent /S probes.'
} finally {
  if (Test-Path -LiteralPath $workRoot) {
    Remove-Item -LiteralPath $workRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
