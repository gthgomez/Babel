<#
.SYNOPSIS
Install Babel pre-commit hooks as optional local convenience.
CI is the authoritative gate — hooks are never mandatory.

.DESCRIPTION
Configures git core.hooksPath to .githooks/ so commits automatically
run a fast local scan for .env files, secrets, machine paths, and
forbidden dependency fingerprints.

To remove: git config --unset core.hooksPath

.PARAMETER Global
Set core.hooksPath globally (all repos) instead of just this repo.
#>
[CmdletBinding()]
param(
    [switch]$Global
)

$ErrorActionPreference = 'Stop'

$repoRoot = (git rev-parse --show-toplevel)
$hooksDir = Join-Path $repoRoot '.githooks'

if (-not (Test-Path (Join-Path $hooksDir 'pre-commit'))) {
    Write-Error ".githooks/pre-commit not found at $hooksDir. Run from the repository root."
    exit 1
}

if ($Global) {
    git config --global core.hooksPath '.githooks'
    Write-Host 'Hooks installed globally. All repos with a .githooks/ directory are active.' -ForegroundColor Green
} else {
    git -C $repoRoot config core.hooksPath '.githooks'
    Write-Host 'Hooks installed for this repository only.' -ForegroundColor Green
}

Write-Host ''
Write-Host 'Pre-commit checks: .env files, gitleaks (if installed), machine paths, secrets, dependency fingerprints.' -ForegroundColor Cyan
Write-Host 'CI is the authoritative gate. Hooks are optional — use --no-verify to bypass.' -ForegroundColor Gray
Write-Host ''
Write-Host 'Remove with: git config --unset core.hooksPath' -ForegroundColor Gray
