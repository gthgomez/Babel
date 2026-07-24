<# .SYNOPSIS
Unified catalog/routing validation — runs the validation pair and reports
a single pass/fail with per-tool summaries.

.DESCRIPTION
Runs in order:
  1. validate-catalog.ps1       — prompt_catalog.yaml integrity
  2. audit-skill-disk-drift.ps1 — SKILL.md vs disk coherence

Produces a table of results and exits with the count of failed tools.
Designed to be invoked by the catalog-validate-all Claude Code skill,
or directly as a pre-commit check.

.PARAMETER Quiet
Suppress per-tool output; only print the summary table.

.EXAMPLE
pwsh tools/validate-all.ps1
# Runs both validations; exits 0 only if all pass.

.EXAMPLE
pwsh tools/validate-all.ps1 -Quiet
# Summary only, no per-tool noise.
#>
[CmdletBinding()]
param(
    [switch]$Quiet
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Continue"

$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Path $PSCommandPath -Parent }
$Root = (Resolve-Path (Join-Path $scriptDir "..")).Path

$tools = @(
    @{ Name = "validate-catalog";       Path = Join-Path $scriptDir "validate-catalog.ps1";       Desc = "prompt_catalog.yaml integrity" },
    @{ Name = "audit-skill-disk-drift"; Path = Join-Path $scriptDir "audit-skill-disk-drift.ps1";  Desc = "SKILL.md vs disk coherence" }
)

$results = @()
$totalStart = Get-Date

foreach ($tool in $tools) {
    $start = Get-Date
    $output = $null
    $exitCode = 0

    if (Test-Path $tool.Path) {
        if ($Quiet) {
            $output = & pwsh -NoProfile -File $tool.Path 2>&1
            $exitCode = $LASTEXITCODE
        } else {
            Write-Host "`n━━━ $($tool.Desc) ━━━" -ForegroundColor Cyan
            $output = & pwsh -NoProfile -File $tool.Path 2>&1
            $exitCode = $LASTEXITCODE
            if ($output) { $output | ForEach-Object { Write-Host "  $_" } }
        }
    } else {
        $output = "MISSING: $($tool.Path) not found"
        $exitCode = 2
        Write-Warning $output
    }

    $elapsed = [math]::Round(((Get-Date) - $start).TotalSeconds, 1)
    $results += [PSCustomObject]@{
        Tool    = $tool.Name
        Desc    = $tool.Desc
        Passed  = $exitCode -eq 0
        ExitCode = $exitCode
        Elapsed = "${elapsed}s"
    }
}

$totalElapsed = [math]::Round(((Get-Date) - $totalStart).TotalSeconds, 1)

# ── Summary table ──────────────────────────────────────────────────────────
Write-Host "`n━━━ Validation Summary ($totalElapsed s) ━━━" -ForegroundColor Cyan
$results | Format-Table Tool, Passed, ExitCode, Elapsed -AutoSize

$failures = ($results | Where-Object { -not $_.Passed }).Count

if ($failures -eq 0) {
    Write-Host "All $($results.Count) validations passed." -ForegroundColor Green
} else {
    Write-Host "$failures/$($results.Count) validations FAILED." -ForegroundColor Red
    foreach ($r in $results | Where-Object { -not $_.Passed }) {
        Write-Host "  ✗ $($r.Tool) — $($r.Desc) (exit $($r.ExitCode))" -ForegroundColor Red
    }
}

exit $failures
