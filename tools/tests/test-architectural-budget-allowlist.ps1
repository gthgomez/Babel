[CmdletBinding()]
param([string]$RepoRoot = (Join-Path $PSScriptRoot '../..'))

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$registry = Join-Path (Resolve-Path $RepoRoot).Path 'config/architectural-budget/process-boundaries.json'
$policy = Get-Content -LiteralPath $registry -Raw | ConvertFrom-Json
$seen = @{}
$duplicates = @()

foreach ($entry in @($policy.exits)) {
    $path = [string]$entry.path
    if ($seen.ContainsKey($path)) { $duplicates += $path }
    else { $seen[$path] = $true }
}

if ($policy.schemaVersion -ne 1 -or @($policy.exits).Count -eq 0) { throw 'Process boundary registry is missing or invalid.' }
if ($duplicates.Count -gt 0) { throw "Duplicate processExitAllowlist paths: $($duplicates -join ', ')" }
Write-Output 'Architectural process-exit allowlist has unique paths.'
