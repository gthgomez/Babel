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

$existingHooksPath = if ($Global) { git config --global --get core.hooksPath } else { git -C $repoRoot config --get core.hooksPath }
if ($existingHooksPath -and $existingHooksPath -ne '.githooks') {
    Write-Error 'An existing hooks dispatcher is configured. Preserve it and run the explicit committed-tree validators from docs/guides/REVIEW_MARKERS.md.'
    exit 1
}

if ($Global) {
    git config --global core.hooksPath '.githooks'
} else {
    git -C $repoRoot config core.hooksPath '.githooks'
}
if ($LASTEXITCODE -ne 0) { throw 'Git hooksPath configuration failed.' }

if ($IsWindows) {
    Write-Host 'hooksPath configured. Hook execution is unverified on this platform; run the explicit committed-tree validators in docs/guides/REVIEW_MARKERS.md.' -ForegroundColor Yellow
} else {
    foreach ($hookName in @('pre-commit', 'pre-push')) {
        $hookPath = Join-Path $hooksDir $hookName
        & test -x $hookPath
        if ($LASTEXITCODE -ne 0) {
            throw "$hookName is not executable. Hook activation is unverified; run the explicit committed-tree validators in docs/guides/REVIEW_MARKERS.md."
        }
    }
    Write-Host 'hooksPath configured and both POSIX hook entrypoints are executable. Command prerequisites and actual checks run at hook invocation.' -ForegroundColor Green
}

Write-Host ''
Write-Host 'Pre-commit checks: .env files, gitleaks (if installed), machine paths, secrets, dependency fingerprints.' -ForegroundColor Cyan
Write-Host 'Run the explicit validators in docs/guides/REVIEW_MARKERS.md when hook execution is unverified. Required publication checks still apply.' -ForegroundColor Gray
Write-Host ''
Write-Host 'Remove with: git config --unset core.hooksPath' -ForegroundColor Gray
