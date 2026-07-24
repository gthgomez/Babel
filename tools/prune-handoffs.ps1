<# .SYNOPSIS
Prune stale handoff files — keep the most recent N files, delete the rest.
Run manually or wire as a pre-session hook.

.DESCRIPTION
Scans handoff-*.md files in the repo root, sorts by date extracted from the
filename (handoff-YYYYMMDD-HHmmss.md), and removes all but the most recent N.

.PARAMETER Keep
Number of handoff files to keep. Default 3.

.PARAMETER MaxAgeHours
Additionally remove any handoff older than this many hours, even if within Keep.

.PARAMETER DryRun
Show what would be deleted without deleting.

.PARAMETER Json
Output results as JSON for hook integration.

.EXAMPLE
pwsh tools/prune-handoffs.ps1
# Keep the 3 most recent handoffs, delete older ones.

.EXAMPLE
pwsh tools/prune-handoffs.ps1 -Keep 5 -MaxAgeHours 48
# Keep up to 5 handoffs, but remove any older than 48 hours.

.EXAMPLE
pwsh tools/prune-handoffs.ps1 -DryRun
# Preview what would be pruned without actually deleting.
#>
[CmdletBinding()]
param(
    [int]$Keep = 3,
    [int]$MaxAgeHours = 0,
    [switch]$DryRun,
    [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Path $PSCommandPath -Parent }
$Root = (Resolve-Path (Join-Path $scriptDir "..")).Path

# ── Find handoff files ──────────────────────────────────────────────────────
$handoffs = Get-ChildItem (Join-Path $Root "handoff-*.md") -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending

if ($handoffs.Count -eq 0) {
    if ($Json) {
        @{ status = "clean"; count = 0; deleted = @() } | ConvertTo-Json
    } else {
        Write-Host "No handoff files found." -ForegroundColor Green
    }
    exit 0
}

# ── Classify ─────────────────────────────────────────────────────────────────
$toDelete = @()
$toKeep = @()

for ($i = 0; $i -lt $handoffs.Count; $i++) {
    $h = $handoffs[$i]
    $delete = $false

    # Older than N most recent
    if ($i -ge $Keep) {
        $delete = $true
    }

    # Older than MaxAgeHours
    if ($MaxAgeHours -gt 0) {
        $age = [math]::Round(((Get-Date) - $h.LastWriteTime).TotalHours, 1)
        if ($age -gt $MaxAgeHours) {
            $delete = $true
        }
    }

    if ($delete) {
        $toDelete += $h
    } else {
        $toKeep += $h
    }
}

# ── Execute ──────────────────────────────────────────────────────────────────
if ($toDelete.Count -eq 0) {
    if ($Json) {
        @{ status = "clean"; count = $handoffs.Count; kept = ($toKeep | ForEach-Object Name); deleted = @() } | ConvertTo-Json -Depth 2
    } else {
        Write-Host "$($handoffs.Count) handoff files, all within retention policy." -ForegroundColor Green
        foreach ($h in $toKeep) { Write-Host "  keep: $($h.Name) ($([math]::Round($h.Length/1KB, 1)) KB)" -ForegroundColor DarkGray }
    }
    exit 0
}

if ($DryRun) {
    Write-Host "[Dry-run] Would delete $($toDelete.Count) handoff(s):" -ForegroundColor Yellow
    foreach ($h in $toDelete) { Write-Host "  ✗ $($h.Name) ($([math]::Round($h.Length/1KB, 1)) KB)" -ForegroundColor Yellow }
    Write-Host "Would keep $($toKeep.Count):" -ForegroundColor Green
    foreach ($h in $toKeep) { Write-Host "  ✓ $($h.Name) ($([math]::Round($h.Length/1KB, 1)) KB)" -ForegroundColor Green }
} else {
    foreach ($h in $toDelete) {
        Remove-Item $h.FullName -Force
        Write-Host "  ✗ deleted: $($h.Name)" -ForegroundColor Yellow
    }
    Write-Host "Pruned $($toDelete.Count) handoff(s), kept $($toKeep.Count)." -ForegroundColor Green
}

if ($Json) {
    @{
        status  = "pruned"
        kept    = ($toKeep | ForEach-Object Name)
        deleted = ($toDelete | ForEach-Object Name)
        total   = $handoffs.Count
    } | ConvertTo-Json -Depth 2
}
