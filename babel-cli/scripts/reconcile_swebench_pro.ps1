<#
.SYNOPSIS
  External reconcile for SWE-Pro causal campaign attempt lifecycle.

.DESCRIPTION
  Invokes the TypeScript reconcile entrypoint. Safe to call from monitor/harvest.
  Does not kill processes. Writes reconcile-report.json under the evidence dir.
#>
param(
  [Parameter(Mandatory = $true)][string]$EvidenceDir,
  [int]$GraceMs = 15000,
  [switch]$Json
)

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$packageRoot = Split-Path -Parent $scriptDir
$evidencePath = [IO.Path]::GetFullPath($EvidenceDir)

$argsList = @(
  '--no-warnings=ExperimentalWarning'
  (Join-Path $scriptDir 'reconcile_swebench_pro.ts')
  '--evidence-dir'
  $evidencePath
  '--grace-ms'
  "$GraceMs"
)
if ($Json) { $argsList += '--json' }

Push-Location $packageRoot
try {
  & npx --yes tsx @argsList
  exit $LASTEXITCODE
} finally {
  Pop-Location
}
