<# .SYNOPSIS
Pre-push architectural budget check — warns when files approach the CI ratchet
threshold so you can extract code BEFORE CI fails.

.DESCRIPTION
Reads the file-size budget baseline from config/architectural-budget/file-sizes.json
and compares each entry against the current source line counts. Files within a
configurable warning threshold (default 85% of budget) are flagged.

Also checks as-any counts and process.exit allowlist from the full budget suite,
mirroring the CI ratchet but as a fast local preflight.

.PARAMETER ThresholdPercent
Percent of budget at which to warn. Default 85. Set to 100 to only flag
files that would fail CI.

.PARAMETER Full
Run the full check-architectural-budget.ps1 (slower but exhaustive).

.PARAMETER Json
Output results as JSON for machine consumption (skill integration).

.EXAMPLE
pwsh tools/preflight-ratchet.ps1
# Quick check: warns on files at >=85% of line budget.

.EXAMPLE
pwsh tools/preflight-ratchet.ps1 -ThresholdPercent 90 -Full
# Full CI-equivalent check, warning at 90%.

.EXAMPLE
pwsh tools/preflight-ratchet.ps1 -Json
# Machine-readable output for skill consumption.
#>
[CmdletBinding()]
param(
    [int]$ThresholdPercent = 85,
    [switch]$Full,
    [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Path $PSCommandPath -Parent }
$Root = (Resolve-Path (Join-Path $scriptDir "..")).Path

$srcDir    = Join-Path $Root "babel-cli\src"
$baselinePath = Join-Path $Root "config\architectural-budget\file-sizes.json"

# ── File-size check ────────────────────────────────────────────────────────
if (-not (Test-Path $baselinePath)) {
    Write-Warning "Budget baseline not found at: $baselinePath"
    Write-Warning "Create one by running: pwsh tools/check-architectural-budget.ps1 -UpdateBaseline"
    Write-Warning "Skipping budget check (no baseline available)."
    exit 0
}

$budget = Get-Content $baselinePath -Raw | ConvertFrom-Json
$warnings = @()
$critical = @()
$ok = @()

foreach ($prop in $budget.PSObject.Properties) {
    $fileRel = $prop.Name
    $maxLines = $prop.Value
    $filePath = Join-Path $Root $fileRel

    if (-not (Test-Path $filePath)) {
        if (-not $Json) { Write-Warning "Budget entry for missing file: $fileRel" }
        continue
    }

    $currentLines = (Get-Content $filePath | Measure-Object -Line).Lines
    $pct = if ($maxLines -gt 0) { [math]::Round(($currentLines / $maxLines) * 100, 1) } else { 0 }

    $entry = [PSCustomObject]@{
        File         = $fileRel
        CurrentLines = $currentLines
        BudgetLines  = $maxLines
        Percent      = $pct
        Headroom     = $maxLines - $currentLines
    }

    if ($currentLines -gt $maxLines) {
        $critical += $entry
    } elseif ($pct -ge $ThresholdPercent) {
        $warnings += $entry
    } else {
        $ok += $entry
    }
}

# ── Output ──────────────────────────────────────────────────────────────────
if ($Json) {
    [PSCustomObject]@{
        Status         = if ($critical.Count -gt 0) { "RED" } elseif ($warnings.Count -gt 0) { "YELLOW" } else { "GREEN" }
        ThresholdPct   = $ThresholdPercent
        Critical       = $critical
        Warnings       = $warnings
        Ok             = @($ok | Select-Object File, Percent)
        Recommendation = if ($critical.Count -gt 0) {
            "Extract code from over-budget files before pushing. Consider: npx madge --image deps.svg $($critical[0].File)"
        } elseif ($warnings.Count -gt 0) {
            "Files approaching budget. Plan extraction soon. Top candidate: $($warnings[0].File) at $($warnings[0].Percent)%"
        } else { "All files within budget threshold." }
        CheckedAt     = (Get-Date -Format "o")
    } | ConvertTo-Json -Depth 4
    exit ($critical.Count)
}

# ── Human-readable output ───────────────────────────────────────────────────
if ($critical.Count -eq 0 -and $warnings.Count -eq 0) {
    Write-Host "✓ All tracked files within ${ThresholdPercent}% of budget." -ForegroundColor Green
    Write-Host "  Tracked: $($ok.Count) files. Worst: $(($ok | Sort-Object Percent -Descending)[0].File) at $(($ok | Sort-Object Percent -Descending)[0].Percent)%"
} else {
    if ($critical.Count -gt 0) {
        Write-Host "`n✗ OVER BUDGET — CI WILL FAIL:" -ForegroundColor Red
        foreach ($c in $critical) {
            Write-Host "  $($c.File): $($c.CurrentLines) lines (budget: $($c.BudgetLines))" -ForegroundColor Red
        }
    }
    if ($warnings.Count -gt 0) {
        Write-Host "`n⚠ APPROACHING BUDGET (>=${ThresholdPercent}%):" -ForegroundColor Yellow
        foreach ($w in ($warnings | Sort-Object Percent -Descending)) {
            Write-Host "  $($w.File): $($w.CurrentLines)/$($w.BudgetLines) ($($w.Percent)%) — $($w.Headroom) lines remaining" -ForegroundColor Yellow
        }
    }

    Write-Host "`nExtraction suggestions:" -ForegroundColor Cyan
    $worst = if ($critical.Count -gt 0) { $critical[0] } else { $warnings[0] }
    Write-Host "  1. Run: npx madge --image deps.svg $($worst.File)  (dependency graph)"
    Write-Host "  2. Find self-contained exports to extract into a new file under babel-cli/src/"
    Write-Host "  3. Update config/architectural-budget/file-sizes.json with new entry for extracted module"
    Write-Host "  4. Run: pwsh tools/check-architectural-budget.ps1 -UpdateBaseline  (after extraction)"
}

# ── Optional full check ─────────────────────────────────────────────────────
if ($Full) {
    Write-Host "`nRunning full architectural budget check..." -ForegroundColor Cyan
    $fullScript = Join-Path $scriptDir "check-architectural-budget.ps1"
    if (Test-Path $fullScript) {
        & pwsh -NoProfile -File $fullScript -CheckOnly
        if ($LASTEXITCODE -ne 0) {
            Write-Host "Full budget check FAILED." -ForegroundColor Red
            exit 1
        } else {
            Write-Host "Full budget check passed." -ForegroundColor Green
        }
    }
}

exit ($critical.Count)
