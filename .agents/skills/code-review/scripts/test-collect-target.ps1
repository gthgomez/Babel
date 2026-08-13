# Fixture: scratch-repo contract tests for collect-target.ps1
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$collector = Join-Path $here 'collect-target.ps1'
$failed = 0
function Assert-True([bool]$Cond, [string]$Name) {
    if ($Cond) { Write-Output "PASS $Name" } else { Write-Output "FAIL $Name"; $script:failed++ }
}
function Remove-ScratchRepo([string]$Root) {
    if (-not $Root -or -not (Test-Path -LiteralPath $Root)) { return }
    try {
        Get-ChildItem -LiteralPath $Root -Force -Recurse -ErrorAction SilentlyContinue |
            ForEach-Object { $_.Attributes = 'Normal' }
        Remove-Item -LiteralPath $Root -Recurse -Force -ErrorAction SilentlyContinue
    } catch {}
}
function New-ScratchRepo {
    $root = Join-Path ([System.IO.Path]::GetTempPath()) ("cr-fixture-" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $root | Out-Null
    Push-Location $root
    git init -q; git checkout -q -b main
    git config user.email 'fixture@example.test'; git config user.name 'Fixture'
    Set-Content -LiteralPath (Join-Path $root 'README.md') -Value "# fixture`n" -NoNewline
    git add README.md; git commit -q -m 'init'
    Pop-Location
    return $root
}
function Invoke-Collect([string]$Root, [string[]]$ExtraArgs = @()) {
    & pwsh -NoProfile -File $collector -RepoRoot $Root @ExtraArgs 2>&1 | Out-String
}
function Get-Field([string]$Report, [string]$Name) {
    if ($Report -match "(?m)^${Name}:\s*(.+)$") { return $Matches[1].Trim() }
    return ''
}
function Get-List([string]$Report, [string]$Header) {
    $items = @(); $in = $false
    foreach ($line in ($Report -split "`r?`n")) {
        if ($line -eq "$Header`:") { $in = $true; continue }
        if ($in) {
            if ($line -match '^[A-Z0-9_]+:') { break }
            if ($line -match '^-\s+(.+)$') { $items += $Matches[1].Trim() }
        }
    }
    return $items
}

$r1 = New-ScratchRepo
try {
    $rep = Invoke-Collect $r1
    Assert-True ((Get-Field $rep 'STATUS') -eq 'EMPTY') 'clean-tree STATUS=EMPTY'
    Assert-True ((Get-Field $rep 'MESSAGE') -eq 'No changes to review.') 'clean-tree exact empty message'
} finally { Remove-ScratchRepo $r1 }

$r2 = New-ScratchRepo
try {
    Set-Content -LiteralPath (Join-Path $r2 'dirty.txt') -Value "hello`n"
    Set-Content -LiteralPath (Join-Path $r2 'README.md') -Value "# fixture`nchanged`n"
    $rep = Invoke-Collect $r2
    $files = @(Get-List $rep 'FILES')
    $lenses = @(Get-List $rep 'LENSES')
    Assert-True ((Get-Field $rep 'STATUS') -eq 'OK') 'unstaged STATUS=OK'
    Assert-True ($files -contains 'README.md' -and $files -contains 'dirty.txt') 'unstaged lists dirty+untracked'
    Assert-True ($lenses -notcontains 'security' -and $lenses -notcontains 'control-plane') 'readme stays bugs-only'
} finally { Remove-ScratchRepo $r2 }

$r3 = New-ScratchRepo
try {
    Push-Location $r3
    git checkout -q -b feat/review-target
    Set-Content -LiteralPath (Join-Path $r3 'committed.txt') -Value "on branch`n"
    git add committed.txt; git commit -q -m 'feat'
    Set-Content -LiteralPath (Join-Path $r3 'wip.txt') -Value "dirty`n"
    Pop-Location
    $rep = Invoke-Collect $r3
    $files = @(Get-List $rep 'FILES')
    Assert-True ((Get-Field $rep 'MODE') -eq 'feature-union') 'feature MODE'
    Assert-True ($files -contains 'committed.txt' -and $files -contains 'wip.txt') 'feature union'
} finally { Remove-ScratchRepo $r3 }

$r4 = New-ScratchRepo
try {
    Set-Content -LiteralPath (Join-Path $r4 'leak.env') -Value "API_KEY=sk-test-not-real-12345`n"
    $rep = Invoke-Collect $r4
    Assert-True ((@(Get-List $rep 'SECRET_HINTS') -contains 'leak.env')) 'secret hint'
    Assert-True ((@(Get-List $rep 'LENSES') -contains 'security')) 'security lens'
} finally { Remove-ScratchRepo $r4 }

$skill = Join-Path (Split-Path $here) 'SKILL.md'
$skillText = Get-Content -LiteralPath $skill -Raw
Assert-True ($skillText -match 'No changes to review\.') 'empty sentence inlined'
Assert-True ($skillText -match '<skill-dir>/scripts/collect-target.ps1') 'skill-dir relative collector'
Assert-True ($skillText -match '/review --pr') 'Grok /review kept'
Assert-True ($skillText -match 'capability_mode: read-only') 'read-only spawn'
Assert-True (Test-Path (Join-Path (Split-Path $here) 'agents\openai.yaml')) 'openai.yaml'

$skillsRoot = Split-Path (Split-Path $here)
foreach ($n in @('code-review-security','code-review-control','code-review-structure')) {
    Assert-True (Test-Path (Join-Path $skillsRoot "$n\SKILL.md")) "$n exists"
}

if ($failed -gt 0) { Write-Output "FAILED $failed"; exit 1 }
Write-Output "ALL PASS"
exit 0
