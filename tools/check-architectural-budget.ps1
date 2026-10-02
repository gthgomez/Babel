<# .SYNOPSIS
Architectural budget CI ratchet — fails on regression against committed baselines.
This is the cross-cutting gate from §10 of the post-OSS architectural audit.

.DESCRIPTION
Enforces four non-regression rules:
  1. Max file length: no src/**/*.ts file may grow past its current line count
     if already >2,000 lines; hard cap 2,000 for new files.
  2. Cast ratchet: `as any` count per file may only decrease.
  3. Output-path allowlist: `process.stdout.write` in src/ui/ only in the
     documented emergency-restore allowlist.
  4. Exit allowlist: `process.exit` only within reviewed, count-bounded host boundaries.

.PARAMETER Root
Repo root. Defaults to parent of this script's directory.

.PARAMETER UpdateBaseline
Update the committed baseline files to current counts. Use when intentionally
changing counts (refactors that reduce debt) — never to paper over regressions.

.PARAMETER CheckOnly
Only check; do not update baselines (default behavior).

.EXAMPLE
pwsh tools/check-architectural-budget.ps1
# Checks all budgets against committed baselines; exits 1 on any regression.

.EXAMPLE
pwsh tools/check-architectural-budget.ps1 -UpdateBaseline
# Updates baseline files to current counts. Commit the changed JSON files.
#>
[CmdletBinding()]
param(
    [string]$Root = "",
    [switch]$UpdateBaseline,
    [switch]$CheckOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ─── Paths ────────────────────────────────────────────────────────────────────

if ([string]::IsNullOrWhiteSpace($Root)) {
    $scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Path $PSCommandPath -Parent }
    $Root = (Resolve-Path (Join-Path $scriptDir "..")).Path
} else {
    $Root = (Resolve-Path $Root).Path
}

# Resolve Windows 8.3 aliases before deriving paths from Get-ChildItem.FullName.
# Resolve-Path can retain RUNNER~1 while enumeration expands it to runneradmin.
$canonicalRoot = & node -e 'process.stdout.write(require("node:fs").realpathSync.native(process.argv[1]))' $Root
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($canonicalRoot)) {
    throw 'Cannot canonicalize architectural budget root; no clearance granted.'
}
$Root = $canonicalRoot.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)

$srcDir    = Join-Path $Root "babel-cli\src"
$baselineDir = Join-Path $Root "config\architectural-budget"

# ─── Baseline files ───────────────────────────────────────────────────────────

$fileSizeBaselinePath  = Join-Path $baselineDir "file-sizes.json"
$castBaselinePath      = Join-Path $baselineDir "as-any-counts.json"

# Process boundary grants live only in process-boundaries.json.
$boundaryScanner = Join-Path $PSScriptRoot "architectural-boundaries.mjs"
$boundaryOutput = & node $boundaryScanner $Root
if ($LASTEXITCODE -ne 0) { throw "Architectural boundary scan failed; no clearance granted." }
$boundaries = ($boundaryOutput -join "`n") | ConvertFrom-Json

# ─── Helpers ──────────────────────────────────────────────────────────────────

function Write-ErrorSummary {
    param([System.Collections.Generic.List[string]]$Errors)
    if ($Errors.Count -gt 0) {
        Write-Host "`nArchitectural budget regressions:" -ForegroundColor Red
        foreach ($msg in $Errors) {
            Write-Host "  FAIL: $msg" -ForegroundColor Red
        }
        Write-Host ""
    }
}

# ─── 1. File Size Ratchet ─────────────────────────────────────────────────────

Write-Host "`n=== File Size Ratchet ===" -ForegroundColor Cyan

$fileSizeBaseline = @{}
if (Test-Path $fileSizeBaselinePath) {
    $fileSizeBaseline = Get-Content $fileSizeBaselinePath -Raw | ConvertFrom-Json -AsHashtable
}

$currentFileSizes = @{}
$sizeErrors = New-Object System.Collections.Generic.List[string]

# Collect all .ts files in src/ (excluding test files for size tracking)
$allSourceFiles = Get-ChildItem -Path $srcDir -Recurse -Filter "*.ts" -File |
    Where-Object { $_.FullName -notmatch '\\test\\' -and $_.FullName -notmatch '\\tests\\' -and $_.Name -notmatch '\.test\.ts$' } |
    Sort-Object FullName

foreach ($file in $allSourceFiles) {
    $relativePath = [IO.Path]::GetRelativePath($Root, $file.FullName).Replace('\', '/')
    $lineCount = (Get-Content $file.FullName | Measure-Object -Line).Lines
    $currentFileSizes[$relativePath] = $lineCount

    # Hard cap: new files must not exceed 2,000 lines
    if (-not $fileSizeBaseline.ContainsKey($relativePath)) {
        if ($lineCount -gt 2000) {
            $sizeErrors.Add("UNBASELINED $relativePath = $lineCount lines (hard cap: 2000)")
        }
        continue
    }

    $baseline = [int]$fileSizeBaseline[$relativePath]
    if ($baseline -le 2000) {
        # File was under threshold — only flag if it crosses 2,000
        if ($lineCount -gt 2000) {
            $sizeErrors.Add("$relativePath grew from $baseline to $lineCount (crossed 2,000-line threshold)")
        }
    } else {
        # File was over threshold — may not grow
        if ($lineCount -gt $baseline) {
            $sizeErrors.Add("$relativePath grew from $baseline to $lineCount lines (ratchet violation: >2,000-line files may not grow)")
        }
    }
}

Write-Host "  Tracked files: $($currentFileSizes.Count)"
Write-Host "  Files >2,000 lines: $(@($currentFileSizes.GetEnumerator() | Where-Object { $_.Value -gt 2000 }).Count)"

if ($sizeErrors.Count -gt 0) {
    Write-Host "  File size errors: $($sizeErrors.Count)" -ForegroundColor Red
} else {
    Write-Host "  File size ratchet: PASS" -ForegroundColor Green
}

# ─── 2. Cast Ratchet ──────────────────────────────────────────────────────────

Write-Host "`n=== Cast Ratchet (``as any``) ===" -ForegroundColor Cyan

$castBaseline = @{}
if (Test-Path $castBaselinePath) {
    $castBaseline = Get-Content $castBaselinePath -Raw | ConvertFrom-Json -AsHashtable
}

$currentCasts = @{}
$castErrors = New-Object System.Collections.Generic.List[string]

foreach ($file in $allSourceFiles) {
    $relativePath = [IO.Path]::GetRelativePath($Root, $file.FullName).Replace('\', '/')
    $count = (Select-String -Path $file.FullName -Pattern 'as any' -SimpleMatch | Measure-Object).Count
    if ($count -gt 0) {
        $currentCasts[$relativePath] = $count
    }
}

foreach ($path in $currentCasts.Keys) {
    $current = [int]$currentCasts[$path]
    if (-not $castBaseline.ContainsKey($path)) {
        # New file with as any — warn but don't fail
        continue
    }
    $baseline = [int]$castBaseline[$path]
    if ($current -gt $baseline) {
        $castErrors.Add("$path `"as any`" grew from $baseline to $current")
    }
}

# Also check that baseline entries which disappeared are noted as improvements
$disappeared = @($castBaseline.Keys | Where-Object { -not $currentCasts.ContainsKey($_) })
if ($disappeared.Count -gt 0) {
    Write-Host "  `"as any`" eliminated in $($disappeared.Count) file(s):" -ForegroundColor Green
    foreach ($path in $disappeared) {
        Write-Host "    $path (was $($castBaseline[$path]))" -ForegroundColor Green
    }
}

$totalAsAnyBaseline = ($castBaseline.Values | Measure-Object -Sum).Sum
$totalAsAnyCurrent = ($currentCasts.Values | Measure-Object -Sum).Sum
Write-Host "  Total `"as any`" count: $totalAsAnyCurrent (baseline: $totalAsAnyBaseline)"

if ($castErrors.Count -gt 0) {
    Write-Host "  Cast errors: $($castErrors.Count)" -ForegroundColor Red
} else {
    Write-Host "  Cast ratchet: PASS" -ForegroundColor Green
}

# ─── 3. Output-Path Allowlist ─────────────────────────────────────────────────

Write-Host "`n=== Output-Path Allowlist ===" -ForegroundColor Cyan

$stdoutErrors = New-Object System.Collections.Generic.List[string]

foreach ($failure in @($boundaries.failures.stdout)) { $stdoutErrors.Add([string]$failure) }

if ($stdoutErrors.Count -gt 0) {
    Write-Host "  stdout write errors: $($stdoutErrors.Count)" -ForegroundColor Red
} else {
    Write-Host "  Output-path allowlist: PASS" -ForegroundColor Green
}

# ─── 4. Exit Allowlist ────────────────────────────────────────────────────────

Write-Host "`n=== Exit Allowlist ===" -ForegroundColor Cyan

$exitErrors = New-Object System.Collections.Generic.List[string]
foreach ($failure in @($boundaries.failures.exits)) { $exitErrors.Add([string]$failure) }

if ($exitErrors.Count -gt 0) {
    Write-Host "  exit errors: $($exitErrors.Count)" -ForegroundColor Red
} else {
    Write-Host "  Exit allowlist: PASS" -ForegroundColor Green
}

# ─── Baseline Update Mode ─────────────────────────────────────────────────────

if ($UpdateBaseline) {
    foreach ($path in $currentCasts.Keys) {
        if (-not $castBaseline.ContainsKey($path)) { throw "Cannot adopt unbaselined type casts: $path" }
    }
    if ($sizeErrors.Count -gt 0 -or $castErrors.Count -gt 0 -or $stdoutErrors.Count -gt 0 -or $exitErrors.Count -gt 0) {
        throw "Baseline updates may only record verified reductions; repair regressions first."
    }
    Write-Host "`n=== Updating Baselines ===" -ForegroundColor Yellow

    if (-not (Test-Path $baselineDir)) {
        New-Item -ItemType Directory -Force -Path $baselineDir | Out-Null
    }

    # File sizes: only store files >2,000 lines to keep the baseline manageable
    $oversizedFiles = @{}
    foreach ($kv in $currentFileSizes.GetEnumerator()) {
        if ([int]$kv.Value -gt 2000) {
            $oversizedFiles[$kv.Key] = [int]$kv.Value
        }
    }
    $oversizedFiles | ConvertTo-Json | Set-Content $fileSizeBaselinePath -Encoding UTF8
    Write-Host "  File size baseline: $($oversizedFiles.Count) files >2,000 lines -> $fileSizeBaselinePath"

    # Cast counts: only store files with at least one as any
    # Retain zero ceilings so an eliminated cast cannot be reintroduced later.
    $reducedCasts = @{}
    foreach ($path in $castBaseline.Keys) {
        $reducedCasts[$path] = if ($currentCasts.ContainsKey($path)) { $currentCasts[$path] } else { 0 }
    }
    $reducedCasts | ConvertTo-Json | Set-Content $castBaselinePath -Encoding UTF8
    Write-Host "  Cast baseline: $($currentCasts.Count) files -> $castBaselinePath"

    # The reviewed process boundary registry is never rewritten by this helper.
    Write-Host "  Baseline update complete. Commit the changed files in config/architectural-budget/."
}

# ─── Final Verdict ────────────────────────────────────────────────────────────

$totalErrors = $sizeErrors.Count + $castErrors.Count + $stdoutErrors.Count + $exitErrors.Count

Write-ErrorSummary -Errors $sizeErrors
Write-ErrorSummary -Errors $castErrors
Write-ErrorSummary -Errors $stdoutErrors
Write-ErrorSummary -Errors $exitErrors

Write-Host "=== Architectural Budget Summary ===" -ForegroundColor Cyan
Write-Host "  File size ratchet:   $(if ($sizeErrors.Count -eq 0) { 'PASS' } else { 'FAIL' })" -ForegroundColor $(if ($sizeErrors.Count -eq 0) { 'Green' } else { 'Red' })
Write-Host "  Cast ratchet:        $(if ($castErrors.Count -eq 0) { 'PASS' } else { 'FAIL' })" -ForegroundColor $(if ($castErrors.Count -eq 0) { 'Green' } else { 'Red' })
Write-Host "  Output allowlist:    $(if ($stdoutErrors.Count -eq 0) { 'PASS' } else { 'FAIL' })" -ForegroundColor $(if ($stdoutErrors.Count -eq 0) { 'Green' } else { 'Red' })
Write-Host "  Exit allowlist:      $(if ($exitErrors.Count -eq 0) { 'PASS' } else { 'FAIL' })" -ForegroundColor $(if ($exitErrors.Count -eq 0) { 'Green' } else { 'Red' })
Write-Host ""

if ($totalErrors -gt 0) {
    Write-Host "Architectural budget FAILED ($totalErrors regression(s))." -ForegroundColor Red
    Write-Host "Repair violations first. -UpdateBaseline records reductions only." -ForegroundColor Yellow
    exit 1
}

Write-Host "Architectural budget PASSED." -ForegroundColor Green
exit 0
