#Requires -Version 5.1
# Junction this family into Claude, Codex, Grok, Cursor, and Gemini user skill homes.
[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$familyRoot = Split-Path (Split-Path $here)

$FamilyNames = @(
    "code-review",
    "code-review-security",
    "code-review-control",
    "code-review-structure"
)

$DestRoots = @(
    (Join-Path $env:USERPROFILE ".claude\skills"),
    (Join-Path $env:USERPROFILE ".codex\skills"),
    (Join-Path $env:USERPROFILE ".grok\skills"),
    (Join-Path $env:USERPROFILE ".cursor\skills"),
    (Join-Path $env:USERPROFILE ".gemini\config\skills")
)

function Test-IsJunction([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return $false }
    $item = Get-Item -LiteralPath $Path -Force
    return [bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint)
}

$created = 0
$skipped = 0
$failed = 0

foreach ($name in $FamilyNames) {
    $source = Join-Path $familyRoot $name
    if (-not (Test-Path -LiteralPath (Join-Path $source "SKILL.md"))) {
        Write-Error "SOURCE missing: $source"
        exit 1
    }

    foreach ($destRoot in $DestRoots) {
        $dest = Join-Path $destRoot $name
        $exists = Test-Path -LiteralPath $dest
        $isLink = $exists -and (Test-IsJunction $dest)

        if ($exists -and $isLink -and -not $Force) {
            $cur = (Get-Item -LiteralPath $dest -Force).Target
            if ($cur -eq $source) {
                Write-Host "OK (junction exists): $dest"
                $skipped++
                continue
            }
        }

        if ($exists -and -not $isLink -and -not $Force) {
            Write-Host "REFUSED (real directory, pass -Force): $dest"
            $failed++
            continue
        }

        if ($DryRun) {
            Write-Host "WOULD JUNCTION $dest -> $source"
            $created++
            continue
        }

        if (-not (Test-Path -LiteralPath $destRoot)) {
            New-Item -ItemType Directory -Force -Path $destRoot | Out-Null
        }
        if ($exists) {
            cmd /c "rmdir `"$dest`"" 2>$null | Out-Null
            if (Test-Path -LiteralPath $dest) {
                if (Test-IsJunction $dest) { cmd /c "rmdir `"$dest`"" | Out-Null }
                else { Remove-Item -LiteralPath $dest -Recurse -Force }
            }
        }
        New-Item -ItemType Junction -Path $dest -Target $source | Out-Null
        Write-Host "JUNCTION $dest -> $source"
        $created++
    }
}

Write-Host ("created={0} skipped={1} refused={2}" -f $created, $skipped, $failed)
if ($failed -gt 0) { exit 1 }
exit 0
