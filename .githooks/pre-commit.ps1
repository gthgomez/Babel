<#
.SYNOPSIS
Babel pre-commit hook (PowerShell) — fast local leak scan.
Called by .githooks/pre-commit (bash wrapper).
Local checks complement the authoritative current-candidate merge checks.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
# Git may report a POSIX-style root (e.g. /c/Workspace/...) under Git Bash hooks.
# Normalize so PowerShell Push-Location and path APIs work on Windows.
$repoRoot = (git rev-parse --show-toplevel)
if ($LASTEXITCODE -ne 0) { Write-Host 'BLOCKED: repository unavailable'; exit 1 }
if ($repoRoot -match '^/([A-Za-z])/(.*)$') {
    $repoRoot = ('{0}:\{1}' -f $Matches[1].ToUpperInvariant(), ($Matches[2] -replace '/', '\'))
} elseif ($repoRoot -match '^([A-Za-z]):/') {
    $repoRoot = $repoRoot -replace '/', '\'
}
$exitCode = 0

function Write-Finding([string]$Label, [string]$Detail) {
    Write-Host "BLOCKED: $Label" -ForegroundColor Red
    if ($Detail) { Write-Host "  $Detail" -ForegroundColor Yellow }
}

# ── 1. Block staged .env files (except .env.example) ──
$stagedOutput = @(git -C $repoRoot -c core.quotepath=false diff --cached --name-only -z --diff-filter=ACMR)
if ($LASTEXITCODE -ne 0) { Write-Host 'BLOCKED: staged path inventory unavailable'; exit 1 }
$staged = @(($stagedOutput -join "`n").Split([char]0, [StringSplitOptions]::RemoveEmptyEntries))
Import-Module (Join-Path $repoRoot 'tools/security/tracked-scan-common.psm1') -Force
$badEnv = $staged | Where-Object { Test-CredentialClassPath $_ }
if ($badEnv) {
    Write-Host 'Staged credential-class file(s):' -ForegroundColor Red
    $badEnv | ForEach-Object { Write-Host "  $_" -ForegroundColor Yellow }
    # Reject by name before reading a prohibited credential file's diff.
    exit 1
}

# ── 2. Run gitleaks on staged changes (if available) ──
$gitleaks = Get-Command gitleaks -ErrorAction SilentlyContinue
if ($gitleaks) {
    Push-Location $repoRoot
    try {
        $gitleaksResult = & gitleaks git --pre-commit --staged --redact --no-banner 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Finding 'gitleaks rejected staged changes (scanner output withheld)'
            $exitCode = 1
        }
    } finally {
        Pop-Location
    }
} else {
    Write-Host 'gitleaks not found - skipping secret scan (install: scoop install gitleaks)' -ForegroundColor Yellow
}

# ── 3. Scan added lines for machine paths ──
# Retain only safe location metadata in diagnostics, even for scanner errors.
$addedLines = [Collections.Generic.List[object]]::new()
$stagedSet = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
foreach ($path in $staged) { [void]$stagedSet.Add($path) }
$diff = @(git -C $repoRoot -c core.quotepath=false diff --cached -U0 --no-ext-diff --no-textconv --no-renames)
if ($LASTEXITCODE -ne 0) { Write-Finding 'staged diff unavailable'; exit 1 }
$path = $null; $lineNumber = 0; $inHunk = $false
foreach ($entry in $diff) {
        if ($entry.StartsWith('diff --git ')) { $path = $null; $inHunk = $false }
        elseif (-not $inHunk -and $entry.StartsWith('+++ ')) {
            # Git appends a tab separator to unquoted headers with spaces.
            $header = $entry.Substring(4).TrimEnd([char]9)
            if ($header -eq '/dev/null') { continue }
            if ($header.StartsWith('"')) {
                try { $header = $header | ConvertFrom-Json } catch { Write-Finding 'staged path framing unavailable'; exit 1 }
            }
            if (-not $header.StartsWith('b/') -or -not $stagedSet.Contains($header.Substring(2))) { Write-Finding 'staged path framing unavailable'; exit 1 }
            $path = $header.Substring(2)
        } elseif ($entry -match '^@@ .* \+(\d+)(?:,\d+)? @@') {
            $inHunk = $true
            $lineNumber = [int]$Matches[1]
        } elseif ($inHunk -and $entry.StartsWith('+')) {
            if (-not $path) { Write-Finding 'staged path framing unavailable'; exit 1 }
            $addedLines.Add(@{ Text = $entry.Substring(1); Path = $path; Line = $lineNumber })
            $lineNumber++
        } elseif ($entry.StartsWith(' ')) { $lineNumber++ }
}
$machinePathPatterns = @(
    @{ Label = 'Windows machine path'; Pattern = '[A-Za-z]:[\\/](Users|Workspace|Projects)[\\/]' },
    @{ Label = 'Unix home path'; Pattern = '/(home|Users)/[a-zA-Z0-9._-]{2,}/' }
)
foreach ($line in $addedLines) {
    foreach ($mp in $machinePathPatterns) {
        if ($line.Text -match $mp.Pattern) {
            Write-Finding $mp.Label "$($line.Path):$($line.Line)"
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
        if ($line.Text -match $sp.Pattern) {
            Write-Finding $sp.Label "$($line.Path):$($line.Line)"
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
        foreach ($line in @($addedLines | Where-Object { $_.Path -eq $lockFile })) {
            if ($line.Text -match "(?i)($fingerprintPattern)") {
                Write-Finding 'forbidden dependency fingerprint' "$($line.Path):$($line.Line)"
                $exitCode = 1
            }
        }
    }
}

if ($exitCode -ne 0) {
    Write-Host ''
    Write-Host 'Repair the reported staged inputs before committing.' -ForegroundColor Gray
}

exit $exitCode
