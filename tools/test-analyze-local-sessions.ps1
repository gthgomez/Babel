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

$analyzerPath = Join-Path $Root "tools\analyze-local-sessions.ps1"
$fixturePath = Join-Path $Root "tests\fixtures\local-learning\session-log.fixture.jsonl"

if (-not (Test-Path $analyzerPath)) {
    throw "Analyzer script not found at $analyzerPath"
}

if (-not (Test-Path $fixturePath)) {
    throw "Fixture log not found at $fixturePath"
}

$json = powershell -ExecutionPolicy Bypass -File $analyzerPath -Root $Root -InputPath $fixturePath -Format json | Out-String
if ($LASTEXITCODE -ne 0) {
    throw "analyze-local-sessions.ps1 exited with code $LASTEXITCODE"
}

$result = $json | ConvertFrom-Json

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

Assert-Equal -Label "SessionCount" -Expected 5 -Actual $result.SessionCount
Assert-Equal -Label "SuccessRate" -Expected 0.4 -Actual $result.SuccessRate
Assert-Equal -Label "FailureRate" -Expected 0.4 -Actual $result.FailureRate
Assert-Equal -Label "StackOverrideRate" -Expected 0.4 -Actual $result.StackOverrideRate
Assert-Equal -Label "FollowUpNeededRate" -Expected 0.4 -Actual $result.FollowUpNeededRate

$failedResult = Find-NamedCount -Items $result.ResultCounts -Name "failed"
Assert-Equal -Label "Failed result count" -Expected 2 -Actual $failedResult.Count

$topFailure = $result.TopFailureTags | Select-Object -First 1
Assert-Equal -Label "Top failure tag name" -Expected "tool_visibility_gap" -Actual $topFailure.Name
Assert-Equal -Label "Top failure tag count" -Expected 2 -Actual $topFailure.Count

$codexClient = Find-NamedCount -Items $result.ByClientSurface -Name "codex_extension"
Assert-Equal -Label "codex_extension session count" -Expected 2 -Actual $codexClient.SessionCount
Assert-Equal -Label "codex_extension override rate" -Expected 0.5 -Actual $codexClient.OverrideRate

$frontendTask = Find-NamedCount -Items $result.ByTaskCategory -Name "frontend"
Assert-Equal -Label "frontend session count" -Expected 3 -Actual $frontendTask.SessionCount

if (@($result.Recommendations).Count -lt 2) {
    throw "Expected at least 2 recommendations but got $(@($result.Recommendations).Count)."
}

Write-Host "analyze-local-sessions regression tests passed." -ForegroundColor Cyan
