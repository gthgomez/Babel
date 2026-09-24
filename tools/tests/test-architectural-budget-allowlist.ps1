[CmdletBinding()]
param([string]$RepoRoot = (Join-Path $PSScriptRoot '../..'))

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$checker = Join-Path (Resolve-Path $RepoRoot).Path 'tools/check-architectural-budget.ps1'
$lines = @(Get-Content -LiteralPath $checker)
$insideProcessExitAllowlist = $false
$foundProcessExitAllowlist = $false
$seen = @{}
$duplicates = @()

foreach ($line in $lines) {
  if ($line -match '^\s*\$processExitAllowlist\s*=\s*@\(') {
    $insideProcessExitAllowlist = $true
    $foundProcessExitAllowlist = $true
    continue
  }
  if (-not $insideProcessExitAllowlist) { continue }
  if ($line -match '^\s*\)\s*$') { break }
  if ($line -match '^\s*"([^"]+)"') {
    $path = $Matches[1]
    if ($seen.ContainsKey($path)) { $duplicates += $path }
    else { $seen[$path] = $true }
  }
}

if (-not $foundProcessExitAllowlist) { throw 'processExitAllowlist was not found in architectural budget checker.' }
if ($duplicates.Count -gt 0) { throw "Duplicate processExitAllowlist paths: $($duplicates -join ', ')" }
Write-Output 'Architectural process-exit allowlist has unique paths.'
