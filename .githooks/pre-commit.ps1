<#
.SYNOPSIS
Babel pre-commit hook (PowerShell) — fast local leak scan.
Called by .githooks/pre-commit (bash wrapper).
CI is authoritative; hooks are optional. Use --no-verify to bypass.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repoRoot = (git rev-parse --show-toplevel)
$exitCode = 0

function Write-Finding([string]$Label, [string]$Detail) {
    Write-Host "BLOCKED: $Label" -ForegroundColor Red
    if ($Detail) { Write-Host "  $Detail" -ForegroundColor Yellow }
}

# ── 1. Block staged .env files (except .env.example) ──
$staged = @(git -C $repoRoot diff --cached --name-only --diff-filter=ACM)
$badEnv = $staged | Where-Object {
    $name = Split-Path $_ -Leaf
    ($name -eq '.env') -or ($name -match '^\.env\.' -and $name -ne '.env.example')
}
if ($badEnv) {
    Write-Host 'Staged .env file(s):' -ForegroundColor Red
    $badEnv | ForEach-Object { Write-Host "  $_" -ForegroundColor Yellow }
    $exitCode = 1
}

# ── 2. Run gitleaks on staged changes (if available) ──
$gitleaks = Get-Command gitleaks -ErrorAction SilentlyContinue
if ($gitleaks) {
    Push-Location $repoRoot
    try {
        $gitleaksResult = & gitleaks git --pre-commit --staged --redact --no-banner 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Host ($gitleaksResult -join "`n")
            Write-Finding 'gitleaks found secrets in staged changes'
            $exitCode = 1
        }
    } finally {
        Pop-Location
    }
} else {
    Write-Host 'gitleaks not found - skipping secret scan (install: scoop install gitleaks)' -ForegroundColor Yellow
}

# ── 3. Scan added lines for machine paths ──
$addedLines = git -C $repoRoot diff --cached -U0 --diff-filter=AM |
    Select-String '^\+[^+]' | ForEach-Object { $_.Line.TrimStart('+') } |
    Where-Object { $_.Trim() }
$machinePathPatterns = @(
    @{ Label = 'Windows machine path'; Pattern = '[A-Za-z]:[\\/](Users|Workspace|Projects)[\\/]' },
    @{ Label = 'Unix home path'; Pattern = '/(home|Users)/[a-zA-Z0-9._-]{2,}/' }
)
foreach ($line in $addedLines) {
    foreach ($mp in $machinePathPatterns) {
        if ($line -match $mp.Pattern) {
            Write-Finding $mp.Label $line
            $exitCode = 1
        }
    }
}

# ── 4. Scan added lines for common secret patterns ──
$secretPatterns = @(
    @{ Label = 'GitHub token'; Pattern = 'gh[pousr]_[0-9A-Za-z_]{20,}' },
    @{ Label = 'Stripe secret key'; Pattern = '(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{20,}' },
    @{ Label = 'OpenAI API key'; Pattern = 'sk-(?:proj-)?[0-9A-Za-z]{20,}' },
    @{ Label = 'Generic key assignment'; Pattern = '(?:api_key|apikey|secret_key|access_key|private_key)\s*[=:]\s*[''""][A-Za-z0-9_\-]{24,}[''""]' }
)
foreach ($line in $addedLines) {
    foreach ($sp in $secretPatterns) {
        if ($line -match $sp.Pattern) {
            Write-Finding $sp.Label $line
            $exitCode = 1
        }
    }
}

# ── 5. Scan staged lockfiles for forbidden dependency fingerprints ──
$policyPath = Join-Path $repoRoot 'tools/security/policy.json'
$fingerprints = @()
if (Test-Path $policyPath) {
    try {
        $policy = Get-Content -Raw -LiteralPath $policyPath | ConvertFrom-Json
        $fingerprints = @($policy.forbidden_dependency_fingerprints)
    } catch {
        Write-Host 'Warning: could not read policy.json - skipping fingerprint scan' -ForegroundColor Yellow
    }
}

$lockfileNameSet = @('package-lock.json', 'package.json')
$stagedLocks = $staged | Where-Object { $lockfileNameSet -contains (Split-Path $_ -Leaf) }
if ($stagedLocks -and $fingerprints.Count -gt 0) {
    $fingerprintPattern = ($fingerprints | ForEach-Object { [regex]::Escape($_) }) -join '|'
    foreach ($lockFile in $stagedLocks) {
        $fullPath = Join-Path $repoRoot $lockFile
        if (-not (Test-Path $fullPath)) { continue }
        $lockLines = git -C $repoRoot diff --cached -U0 -- $lockFile |
            Select-String '^\+[^+]' | ForEach-Object { $_.Line.TrimStart('+') } |
            Where-Object { $_.Trim() }
        foreach ($line in $lockLines) {
            if ($line -match "(?i)($fingerprintPattern)") {
                Write-Finding "forbidden dependency fingerprint in $lockFile" $line
                $exitCode = 1
            }
        }
    }
}

if ($exitCode -ne 0) {
    Write-Host ''
    Write-Host 'CI is the authoritative gate. Hooks are optional - use --no-verify to bypass.' -ForegroundColor Gray
}

exit $exitCode
