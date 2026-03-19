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

$scorerPath = Join-Path $Root "tools\score-comparison-results.ps1"
$fixturePath = Join-Path $Root "tests\fixtures\comparison-workflow\comparison-cases.json"

foreach ($requiredPath in @($scorerPath, $fixturePath)) {
    if (-not (Test-Path -LiteralPath $requiredPath)) {
        throw "Required file not found: $requiredPath"
    }
}

$preferredShell = Get-Command pwsh -ErrorAction SilentlyContinue
$shellPath = if ($null -ne $preferredShell) {
    $preferredShell.Source
} else {
    (Get-Command powershell -ErrorAction Stop).Source
}

function Assert-Equal {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Label,

        [AllowNull()]
        [object]$Expected,

        [AllowNull()]
        [object]$Actual
    )

    if ([string]$Expected -ne [string]$Actual) {
        throw "$Label mismatch. Expected '$Expected' but got '$Actual'."
    }
}

function Assert-True {
    param(
        [Parameter(Mandatory = $true)]
        [bool]$Condition,

        [Parameter(Mandatory = $true)]
        [string]$Message
    )

    if (-not $Condition) {
        throw $Message
    }
}

function Invoke-Scorer {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ShellPath,

        [Parameter(Mandatory = $true)]
        [string]$ScriptPath,

        [Parameter(Mandatory = $true)]
        [string]$RepoRoot,

        [Parameter(Mandatory = $true)]
        [string]$CasePath
    )

    $stdoutPath = [System.IO.Path]::GetTempFileName()
    $stderrPath = [System.IO.Path]::GetTempFileName()

    try {
        $args = @(
            "-NoProfile",
            "-ExecutionPolicy", "Bypass",
            "-File", $ScriptPath,
            "-Root", $RepoRoot,
            "-InputPath", $CasePath,
            "-Format", "json",
            "-CheckExpected"
        )

        $process = Start-Process `
            -FilePath $ShellPath `
            -ArgumentList $args `
            -Wait `
            -PassThru `
            -NoNewWindow `
            -RedirectStandardOutput $stdoutPath `
            -RedirectStandardError $stderrPath

        return [PSCustomObject]@{
            ExitCode = $process.ExitCode
            Stdout = if (Test-Path -LiteralPath $stdoutPath) { Get-Content -LiteralPath $stdoutPath -Raw } else { "" }
            Stderr = if (Test-Path -LiteralPath $stderrPath) { Get-Content -LiteralPath $stderrPath -Raw } else { "" }
        }
    } finally {
        Remove-Item -Path $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue
    }
}

$invocation = Invoke-Scorer -ShellPath $shellPath -ScriptPath $scorerPath -RepoRoot $Root -CasePath $fixturePath
Assert-Equal -Label "score-comparison-results exit code" -Expected 0 -Actual $invocation.ExitCode

$summary = $invocation.Stdout | ConvertFrom-Json

Assert-Equal -Label "CaseCount" -Expected 2 -Actual $summary.CaseCount
Assert-Equal -Label "ExpectationMismatchCount" -Expected 0 -Actual $summary.ExpectationMismatchCount
Assert-Equal -Label "Results count" -Expected 2 -Actual @($summary.Results).Count

$case1 = @($summary.Results | Where-Object { $_.Id -eq "weighted_total_winner" } | Select-Object -First 1)
$case2 = @($summary.Results | Where-Object { $_.Id -eq "verification_tiebreak_winner" } | Select-Object -First 1)

Assert-True -Condition ($null -ne $case1) -Message "Fixture result for weighted_total_winner was not found."
Assert-True -Condition ($null -ne $case2) -Message "Fixture result for verification_tiebreak_winner was not found."

Assert-Equal -Label "Case1 winner" -Expected "candidate_b" -Actual $case1.WinnerId
Assert-Equal -Label "Case1 decision rule" -Expected "weighted_total" -Actual $case1.DecisionRule
Assert-Equal -Label "Case2 winner" -Expected "candidate_b" -Actual $case2.WinnerId
Assert-Equal -Label "Case2 decision rule" -Expected "verification_quality_score" -Actual $case2.DecisionRule

Assert-Equal -Label "Case1 candidate_a weighted total" -Expected 22 -Actual $case1.WeightedTotals.candidate_a
Assert-Equal -Label "Case1 candidate_b weighted total" -Expected 25 -Actual $case1.WeightedTotals.candidate_b
Assert-Equal -Label "Case2 candidate_a weighted total" -Expected 18 -Actual $case2.WeightedTotals.candidate_a
Assert-Equal -Label "Case2 candidate_b weighted total" -Expected 18 -Actual $case2.WeightedTotals.candidate_b

$topAdapter = @($summary.RecommendationSignals.TopWinningAdapters | Select-Object -First 1)
Assert-True -Condition ($null -ne $topAdapter) -Message "TopWinningAdapters is empty."
Assert-Equal -Label "Top winning adapter name" -Expected "adapter_codex_balanced" -Actual $topAdapter.Name
Assert-Equal -Label "Top winning adapter count" -Expected 1 -Actual $topAdapter.Count

Write-Host "comparison workflow regression tests passed." -ForegroundColor Cyan
