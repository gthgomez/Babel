[CmdletBinding()]
param(
    [string]$Root = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($Root)) {
    $scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Path $PSCommandPath -Parent }
    $Root = (Resolve-Path (Join-Path $scriptDir "..")).Path
}

$normalizerPath = Join-Path $Root "tools\normalize-local-evidence.ps1"
$runFixtureRoot = Join-Path $Root "tests\fixtures\normalize-local-evidence\runs"
$sessionFixturePath = Join-Path $Root "tests\fixtures\local-learning\session-log.fixture.jsonl"
$comparisonFixturePath = Join-Path $Root "tests\fixtures\comparison-workflow\comparison-cases.json"
$tempDir = Join-Path $Root "runs\local-learning-test\normalize-local-evidence"
$outputPath = Join-Path $tempDir "normalized-events.jsonl"

foreach ($requiredPath in @($normalizerPath, $runFixtureRoot, $sessionFixturePath, $comparisonFixturePath)) {
    if (-not (Test-Path -LiteralPath $requiredPath)) {
        throw "Required test input not found: $requiredPath"
    }
}

if (Test-Path -LiteralPath $tempDir) {
    Remove-Item -LiteralPath $tempDir -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $tempDir | Out-Null

$json = powershell -ExecutionPolicy Bypass -File $normalizerPath `
    -Root $Root `
    -RunBundlesRoot $runFixtureRoot `
    -SessionLogPath $sessionFixturePath `
    -ComparisonInputPath $comparisonFixturePath `
    -OutputPath $outputPath `
    -Format json | Out-String

if ($LASTEXITCODE -ne 0) {
    throw "normalize-local-evidence.ps1 exited with code $LASTEXITCODE"
}

$summary = $json | ConvertFrom-Json

function Assert-Equal {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Label,

        [Parameter(Mandatory = $true)]
        [AllowNull()]
        [object]$Expected,

        [Parameter(Mandatory = $true)]
        [AllowNull()]
        [object]$Actual
    )

    if ([string]$Expected -ne [string]$Actual) {
        throw "$Label mismatch. Expected '$Expected' but got '$Actual'."
    }
}

function Find-NamedCount {
    param(
        [Parameter(Mandatory = $true)]
        [object[]]$Items,

        [Parameter(Mandatory = $true)]
        [string]$Name
    )

    return @($Items | Where-Object { $_.Name -eq $Name } | Select-Object -First 1)
}

function Find-Event {
    param(
        [Parameter(Mandatory = $true)]
        [object[]]$Events,

        [Parameter(Mandatory = $true)]
        [string]$EventId
    )

    return @($Events | Where-Object { $_.event_id -eq $EventId } | Select-Object -First 1)
}

Assert-Equal -Label "EventCount" -Expected 9 -Actual $summary.EventCount

$localSessionCount = Find-NamedCount -Items $summary.SourceCounts -Name "local_session"
Assert-Equal -Label "local_session count" -Expected 5 -Actual $localSessionCount.Count

$bundleCount = Find-NamedCount -Items $summary.SourceCounts -Name "evidence_bundle"
Assert-Equal -Label "evidence_bundle count" -Expected 2 -Actual $bundleCount.Count

$comparisonCount = Find-NamedCount -Items $summary.SourceCounts -Name "comparison_result"
Assert-Equal -Label "comparison_result count" -Expected 2 -Actual $comparisonCount.Count

$successCount = Find-NamedCount -Items $summary.AuthoritativeSuccessLabelCounts -Name "success"
Assert-Equal -Label "success label count" -Expected 5 -Actual $successCount.Count

$failedCount = Find-NamedCount -Items $summary.AuthoritativeSuccessLabelCounts -Name "failed"
Assert-Equal -Label "failed label count" -Expected 3 -Actual $failedCount.Count

$unconfirmedCount = Find-NamedCount -Items $summary.AuthoritativeSuccessLabelCounts -Name "unconfirmed"
Assert-Equal -Label "unconfirmed label count" -Expected 1 -Actual $unconfirmedCount.Count

if (-not (Test-Path -LiteralPath $outputPath)) {
    throw "Expected normalized output file at $outputPath"
}

$events = @(
    Get-Content -LiteralPath $outputPath |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
        ForEach-Object { $_ | ConvertFrom-Json }
)

Assert-Equal -Label "normalized output line count" -Expected 9 -Actual $events.Count

$rejectBundle = Find-Event -Events $events -EventId "bundle:20260308_100000_prismatix-reject"
Assert-Equal -Label "reject bundle label" -Expected "failed" -Actual $rejectBundle.authoritative_success_label
Assert-Equal -Label "reject bundle qa verdict" -Expected "reject" -Actual $rejectBundle.qa_verdict
Assert-Equal -Label "reject bundle hard fail signal" -Expected "qa_reject" -Actual ($rejectBundle.hard_fail_signals | Select-Object -First 1)

$passBundle = Find-Event -Events $events -EventId "bundle:20260308_101000_gpcguard-pass"
Assert-Equal -Label "pass bundle label" -Expected "success" -Actual $passBundle.authoritative_success_label
Assert-Equal -Label "pass bundle qa verdict" -Expected "pass" -Actual $passBundle.qa_verdict

$sessionSuccess = Find-Event -Events $events -EventId "session:fixture-01"
Assert-Equal -Label "session success label" -Expected "success" -Actual $sessionSuccess.authoritative_success_label
Assert-Equal -Label "session success positive signal" -Expected "session_result_success" -Actual ($sessionSuccess.positive_signals | Where-Object { $_ -eq "session_result_success" } | Select-Object -First 1)

$sessionFailure = Find-Event -Events $events -EventId "session:fixture-03"
Assert-Equal -Label "session failure label" -Expected "failed" -Actual $sessionFailure.authoritative_success_label
Assert-Equal -Label "session failure hard fail signal" -Expected "session_result_failed" -Actual ($sessionFailure.hard_fail_signals | Select-Object -First 1)

$comparisonWinner = Find-Event -Events $events -EventId "comparison:weighted_total_winner"
Assert-Equal -Label "comparison winner label" -Expected "success" -Actual $comparisonWinner.authoritative_success_label
Assert-Equal -Label "comparison winner client surface" -Expected "claude_code" -Actual $comparisonWinner.client_surface
Assert-Equal -Label "comparison winner selected stack contains adapter" -Expected "adapter_claude" -Actual (($comparisonWinner.selected_stack_ids | Where-Object { $_ -eq "adapter_claude" } | Select-Object -First 1))

Write-Host "normalize-local-evidence regression tests passed." -ForegroundColor Cyan
