<# .SYNOPSIS
Pre-push architectural budget check — reports advisory file-size findings.

.DESCRIPTION
Reads the file-size budget baseline from config/architectural-budget/file-sizes.json
and compares each entry against the current source line counts. Files within a
configurable warning threshold (default 85% of budget) are flagged.

Quick mode scans only baseline entries. Use -Full for the complete file
inventory and the blocking cast, stdout and process-exit checks.

.PARAMETER ThresholdPercent
Percent of budget at which to warn. Default 85. Set to 100 to flag
entries at or over their budget.

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

$baselinePath = Join-Path $Root "config\architectural-budget\file-sizes.json"

# ── File-size check ────────────────────────────────────────────────────────
$budget = if (Test-Path -LiteralPath $baselinePath) {
    Get-Content -LiteralPath $baselinePath -Raw | ConvertFrom-Json -AsHashtable
} else {
    if (-not $Json) { Write-Warning "Budget baseline not found at: $baselinePath (quick scan skipped)." }
    @{}
}
$warnings = @()
$critical = @()
$ok = @()

foreach ($fileRel in $budget.Keys) {
    $maxLines = $budget[$fileRel]
    $filePath = Join-Path $Root $fileRel

    if (-not (Test-Path -LiteralPath $filePath)) {
        if (-not $Json) { Write-Warning "Budget entry for missing file: $fileRel" }
        continue
    }

    $currentLines = (Get-Content -LiteralPath $filePath | Measure-Object -Line).Lines
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

function Invoke-FullBudgetCheck {
    $fullScript = Join-Path $scriptDir "check-architectural-budget.ps1"
    if (-not (Test-Path -LiteralPath $fullScript -PathType Leaf)) {
        throw "Full architectural budget script not found: $fullScript"
    }

    # The quick JSON report is the only stdout record in JSON mode.
    $pwshPath = (Get-Process -Id $PID).Path
    if ($Json) {
        & $pwshPath -NoProfile -File $fullScript -CheckOnly |
            ForEach-Object { [Console]::Error.WriteLine($_) }
    } else {
        Write-Host "`nRunning full architectural budget check..." -ForegroundColor Cyan
        & $pwshPath -NoProfile -File $fullScript -CheckOnly | Out-Host
    }
    return $LASTEXITCODE
}

# ── Output ──────────────────────────────────────────────────────────────────
if ($Json) {
    [PSCustomObject]@{
        Status         = if ($critical.Count -gt 0 -or $warnings.Count -gt 0) { "YELLOW" } else { "GREEN" }
        ThresholdPct   = $ThresholdPercent
        Critical       = $critical
        Warnings       = $warnings
        Ok             = @($ok | Select-Object File, Percent)
        Recommendation = if ($critical.Count -gt 0) {
            "Advisory only: review over-budget files and plan extraction. Consider: npx madge --image deps.svg $($critical[0].File)"
        } elseif ($warnings.Count -gt 0) {
            "Files approaching budget. Plan extraction soon. Top candidate: $($warnings[0].File) at $($warnings[0].Percent)%"
        } else { "All files within budget threshold." }
        CheckedAt     = (Get-Date -Format "o")
    } | ConvertTo-Json -Depth 4
    if ($Full) { exit (Invoke-FullBudgetCheck) }
    exit 0
}

# ── Human-readable output ───────────────────────────────────────────────────
if ($critical.Count -eq 0 -and $warnings.Count -eq 0) {
    Write-Host "✓ All tracked files within ${ThresholdPercent}% of budget." -ForegroundColor Green
    Write-Host "  Tracked: $($ok.Count) files."
    if ($ok.Count -gt 0) {
        $worst = $ok | Sort-Object Percent -Descending | Select-Object -First 1
        Write-Host "  Worst: $($worst.File) at $($worst.Percent)%"
    }
} else {
    if ($critical.Count -gt 0) {
        Write-Host "`n⚠ OVER BUDGET — ADVISORY (does not block):" -ForegroundColor Yellow
        foreach ($c in $critical) {
            Write-Host "  $($c.File): $($c.CurrentLines) lines (budget: $($c.BudgetLines))" -ForegroundColor Yellow
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
    Write-Host "  3. Check that extraction reduces the original file and keeps new files under the threshold"
    Write-Host "  4. Run: pwsh tools/check-architectural-budget.ps1 -UpdateBaseline  (after extraction)"
}

# ── Optional full check ─────────────────────────────────────────────────────
if ($Full) { exit (Invoke-FullBudgetCheck) }
exit 0
