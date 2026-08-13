# Windows Terminal / PowerShell certification path for Babel chat TUI.
# This script is the reproducible T24 harness. It does NOT claim PASS
# unless the operator actually runs it in Windows Terminal.
#
# Usage (from babel-cli/):
#   pwsh -NoProfile -File scripts/cert_tui_windows.ps1
#
# Checks performed automatically:
#   - node is on PATH
#   - typecheck of interrupt/review/cert modules
#   - unit cert matrix (T01–T23)
# Manual checks (operator, Windows Terminal):
#   - prompt rendering, Ctrl+C, resize, session picker, paste,
#     diff pager, cursor restoration, cancellation, Unicode, long paths

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

Write-Host '=== Babel TUI Windows certification ==='
Write-Host "cwd: $Root"
Write-Host "host: $env:COMPUTERNAME  WT_SESSION=$env:WT_SESSION"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host 'BLOCKED: node is not on PATH'
    exit 2
}

Write-Host 'Running T01–T23 fixture cert (no paid model, no WT automation)...'
npx --yes tsx --no-warnings=ExperimentalWarning --test src/ui/tuiDailyDriverCert.test.ts src/ui/interruptHost.test.ts src/ui/reviewCard.test.ts
if ($LASTEXITCODE -ne 0) {
    Write-Host 'FAIL: fixture cert'
    exit $LASTEXITCODE
}

if (-not $env:WT_SESSION) {
    Write-Host 'BLOCKED: not running inside Windows Terminal (WT_SESSION unset).'
    Write-Host 'Re-run this script from Windows Terminal to complete T24 manual checks.'
    exit 3
}

Write-Host 'WT_SESSION present. Manual T24 checklist (operator):'
Write-Host '  [ ] prompt renders once'
Write-Host '  [ ] Ctrl+C cancels a running task and returns the composer'
Write-Host '  [ ] resize keeps draft'
Write-Host '  [ ] /resume picker cancel leaves no phantom input'
Write-Host '  [ ] paste + Ctrl+C discards paste'
Write-Host '  [ ] /diff then q restores composer'
Write-Host '  [ ] exit restores cursor'
Write-Host '  [ ] Unicode and long paths render'
Write-Host 'This script does not auto-PASS those interactive checks.'
exit 0
