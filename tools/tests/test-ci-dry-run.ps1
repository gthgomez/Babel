# License: Apache-2.0 — see LICENSE
# Deterministic boundary tests: fake Docker never installs or runs a container.
[CmdletBinding()]
param([string]$TempRoot = [System.IO.Path]::GetTempPath())
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$target = (Resolve-Path (Join-Path $PSScriptRoot '../ci-dry-run.ps1')).Path
$testRoot = Join-Path (Resolve-Path $TempRoot).Path ('ci-dry-run-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testRoot | Out-Null
$wrapper = Join-Path $testRoot 'invoke.ps1'
@'
function global:docker {
    $global:LASTEXITCODE = 0
    if ($args[0] -eq 'info') { return 'fake engine' }
    if ($args[0] -eq 'images') { return 'fake image' }
    if ($args[0] -ne 'run') { throw 'Unexpected Docker operation' }
    @($args) | ConvertTo-Json | Set-Content -LiteralPath $env:CI_DRY_TEST_ARGS
    $mount = @($args | Where-Object { $_ -like '*:/tmp/babel-ci-run.sh:ro' })[0]
    $scriptPath = $mount.Substring(0, $mount.Length - ':/tmp/babel-ci-run.sh:ro'.Length)
    Get-Content -LiteralPath $scriptPath -Raw | Set-Content -LiteralPath $env:CI_DRY_TEST_SCRIPT
    switch ($env:CI_DRY_TEST_CASE) {
        'red' { $global:LASTEXITCODE = 17; return 'primary docker failure' }
        'red-cleanup' { $global:LASTEXITCODE = 17; return 'primary docker failure' }
        'missing-marker' { return 'incomplete output' }
        'throws' { throw 'docker invocation threw' }
        default { return '=== PASS ===' }
    }
}
function global:Remove-Item {
    [CmdletBinding()]
    param([string]$LiteralPath, [switch]$Force)
    if ($env:CI_DRY_TEST_CASE -like '*cleanup') { throw [System.UnauthorizedAccessException]::new('simulated cleanup access denied') }
    Microsoft.PowerShell.Management\Remove-Item -LiteralPath $LiteralPath -Force:$Force -ErrorAction Stop
}
$switches = @{ Quick = $true }
if ($env:CI_DRY_TEST_CASE -eq 'keep') { $switches.KeepContainer = $true }
& $env:CI_DRY_TEST_TARGET @switches
exit $LASTEXITCODE
'@ | Set-Content -LiteralPath $wrapper
$envNames = @('TEMP', 'TMP', 'CI_DRY_TEST_TARGET', 'CI_DRY_TEST_CASE', 'CI_DRY_TEST_ARGS', 'CI_DRY_TEST_SCRIPT')
$saved = @{}
foreach ($name in $envNames) { $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
$results = @()
try {
    $env:TEMP = $testRoot
    $env:TMP = $testRoot
    $env:CI_DRY_TEST_TARGET = $target
    foreach ($case in @('green', 'red', 'green-cleanup', 'red-cleanup', 'missing-marker', 'throws', 'keep')) {
        $env:CI_DRY_TEST_CASE = $case
        $env:CI_DRY_TEST_ARGS = Join-Path $testRoot "$case.args.json"
        $env:CI_DRY_TEST_SCRIPT = Join-Path $testRoot "$case.sh"
        $lines = @(& pwsh -NoProfile -File $wrapper 2>&1)
        $actualExit = $LASTEXITCODE
        $output = $lines -join "`n"
        $jsonStart = $output.IndexOf("{`n")
        if ($jsonStart -lt 0) { $jsonStart = $output.IndexOf("{`r`n") }
        if ($jsonStart -lt 0) { throw "$case failed to emit JSON: $output" }
        $result = $output.Substring($jsonStart) | ConvertFrom-Json
        $expectedExit = switch ($case) { 'red' {17} 'red-cleanup' {17} 'missing-marker' {1} 'throws' {2} default {0} }
        if ($actualExit -ne $expectedExit -or $result.ExitCode -ne $expectedExit) { throw "$case exit mismatch: $actualExit, $($result.ExitCode)" }
        $expectedStatus = if ($expectedExit -eq 0) { 'GREEN' } else { 'RED' }
        if ($result.Status -ne $expectedStatus) { throw "$case status mismatch" }
        if ($case -like '*cleanup') {
            if ($result.CleanupStatus -ne 'FAILED' -or -not (Test-Path -LiteralPath $result.RetainedScript)) { throw "$case lost cleanup evidence" }
        } elseif ($result.CleanupStatus -ne 'REMOVED') { throw "$case did not clean unique script" }
        if ($case -like 'red*' -and $result.Output -ne 'primary docker failure') { throw "$case lost primary failure output" }
        $dockerArgs = Get-Content -LiteralPath $env:CI_DRY_TEST_ARGS -Raw | ConvertFrom-Json
        $repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path -replace '\\', '/'
        if ($dockerArgs -notcontains "${repoRoot}:/workspace") { throw 'Native Docker repository path changed' }
        if ($dockerArgs -notcontains '/workspace/babel-cli/node_modules') { throw 'Host dependencies not isolated' }
        if (($dockerArgs -contains '--rm') -eq ($case -eq 'keep')) { throw 'KeepContainer not honored' }
        $body = Get-Content -LiteralPath $env:CI_DRY_TEST_SCRIPT -Raw
        if ($body -notmatch 'npm run typecheck') { throw 'Promised typecheck absent' }
        $results += [pscustomobject]@{ Case = $case; ExitCode = $actualExit; Status = $result.Status; Cleanup = $result.CleanupStatus; Container = $result.Container }
    }
    if (@($results.Container | Select-Object -Unique).Count -ne $results.Count) { throw 'Run identities collided' }
    $results | ConvertTo-Json
    Write-Host "PASS: $($results.Count) fake-Docker cases; no containers or installs executed."
} finally {
    foreach ($name in $envNames) { [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process') }
    # This exact unique directory was created above; never touch the historical temp script.
    Remove-Item -LiteralPath $testRoot -Recurse -Force
}
