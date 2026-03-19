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

$scriptPath = Join-Path $Root "tools\validate-global-policy-comparison.ps1"
$tempDir = Join-Path $Root "runs\local-learning-test\validate-global-policy-comparison"

if (Test-Path -LiteralPath $tempDir) {
    Remove-Item -LiteralPath $tempDir -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $tempDir | Out-Null

function Assert-Equal {
    param([string]$Label, [AllowNull()][object]$Expected, [AllowNull()][object]$Actual)
    if ([string]$Expected -ne [string]$Actual) {
        throw "$Label mismatch. Expected '$Expected' but got '$Actual'."
    }
}

function Assert-True {
    param([string]$Label, [bool]$Condition)
    if (-not $Condition) {
        throw "$Label was expected to be true."
    }
}

function Write-JsonLines {
    param([string]$Path, [object[]]$Items)
    $dir = Split-Path -Path $Path -Parent
    if (-not [string]::IsNullOrWhiteSpace($dir)) {
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
    }
    $lines = @($Items | ForEach-Object { $_ | ConvertTo-Json -Depth 12 -Compress })
    Set-Content -LiteralPath $Path -Value $lines -Encoding UTF8
}

function New-Event {
    param(
        [string]$EventId,
        [string]$PolicyVersionApplied,
        [string]$AuthoritativeSuccessLabel,
        [bool]$FollowUpNeeded,
        [string[]]$SelectedStackIds,
        [string[]]$RecommendedStackIds,
        [string]$QaVerdict = "unknown"
    )

    return [ordered]@{
        event_id = $EventId
        policy_version_applied = $PolicyVersionApplied
        authoritative_success_label = $AuthoritativeSuccessLabel
        follow_up_needed = $FollowUpNeeded
        selected_stack_ids = $SelectedStackIds
        recommended_stack_ids = $RecommendedStackIds
        qa_verdict = $QaVerdict
    }
}

$globalPolicyId = "global:verification_loop_hints:checklist:require_root_cause_line|categories:backend"
$passEventsPath = Join-Path $tempDir "pass-events.jsonl"
$passOutputPath = Join-Path $tempDir "pass-output.json"
Write-JsonLines -Path $passEventsPath -Items @(
    (New-Event -EventId "thin-01" -PolicyVersionApplied "" -AuthoritativeSuccessLabel "failed" -FollowUpNeeded $true -SelectedStackIds @("adapter_codex") -RecommendedStackIds @("adapter_codex_balanced")),
    (New-Event -EventId "thin-02" -PolicyVersionApplied "" -AuthoritativeSuccessLabel "success" -FollowUpNeeded $true -SelectedStackIds @("adapter_codex") -RecommendedStackIds @("adapter_codex_balanced")),
    (New-Event -EventId "babel-01" -PolicyVersionApplied "local-client:codex_extension.codex:kickoff_prompt_preset:compact@active-v1" -AuthoritativeSuccessLabel "success" -FollowUpNeeded $true -SelectedStackIds @("adapter_codex") -RecommendedStackIds @("adapter_codex_balanced")),
    (New-Event -EventId "babel-02" -PolicyVersionApplied "local-client:codex_extension.codex:kickoff_prompt_preset:compact@active-v1" -AuthoritativeSuccessLabel "failed" -FollowUpNeeded $true -SelectedStackIds @("adapter_codex") -RecommendedStackIds @("adapter_codex_balanced")),
    (New-Event -EventId "global-01" -PolicyVersionApplied "local-client:codex_extension.codex:kickoff_prompt_preset:compact@active-v1;$globalPolicyId@active-v1" -AuthoritativeSuccessLabel "success" -FollowUpNeeded $false -SelectedStackIds @("adapter_codex_balanced") -RecommendedStackIds @("adapter_codex_balanced") -QaVerdict "pass"),
    (New-Event -EventId "global-02" -PolicyVersionApplied "local-client:codex_extension.codex:kickoff_prompt_preset:compact@active-v1;$globalPolicyId@active-v1" -AuthoritativeSuccessLabel "success" -FollowUpNeeded $false -SelectedStackIds @("adapter_codex_balanced") -RecommendedStackIds @("adapter_codex_balanced") -QaVerdict "pass"),
    (New-Event -EventId "global-03" -PolicyVersionApplied "$globalPolicyId@active-v1" -AuthoritativeSuccessLabel "success" -FollowUpNeeded $false -SelectedStackIds @("adapter_codex_balanced") -RecommendedStackIds @("adapter_codex_balanced"))
)
$passResult = powershell -ExecutionPolicy Bypass -File $scriptPath -Root $Root -InputPath $passEventsPath -GlobalPolicyId $globalPolicyId -OutputPath $passOutputPath -Format json | Out-String | ConvertFrom-Json
Assert-Equal -Label "pass validation status" -Expected "pass" -Actual $passResult.validation_status
Assert-Equal -Label "pass with-global event count" -Expected 3 -Actual $passResult.buckets.with_global.applicable_event_count
Assert-True -Label "pass success rate improves over no-global" -Condition ([double]$passResult.buckets.with_global.success_rate -gt [double]$passResult.buckets.babel_without_global.success_rate)

$failEventsPath = Join-Path $tempDir "fail-events.jsonl"
$failOutputPath = Join-Path $tempDir "fail-output.json"
Write-JsonLines -Path $failEventsPath -Items @(
    (New-Event -EventId "base-01" -PolicyVersionApplied "local-client:codex_extension.codex:kickoff_prompt_preset:compact@active-v1" -AuthoritativeSuccessLabel "success" -FollowUpNeeded $false -SelectedStackIds @("adapter_codex_balanced") -RecommendedStackIds @("adapter_codex_balanced")),
    (New-Event -EventId "base-02" -PolicyVersionApplied "local-client:codex_extension.codex:kickoff_prompt_preset:compact@active-v1" -AuthoritativeSuccessLabel "success" -FollowUpNeeded $false -SelectedStackIds @("adapter_codex_balanced") -RecommendedStackIds @("adapter_codex_balanced")),
    (New-Event -EventId "global-fail-01" -PolicyVersionApplied "$globalPolicyId@active-v1" -AuthoritativeSuccessLabel "failed" -FollowUpNeeded $true -SelectedStackIds @("adapter_codex") -RecommendedStackIds @("adapter_codex_balanced"))
)
$failResult = powershell -ExecutionPolicy Bypass -File $scriptPath -Root $Root -InputPath $failEventsPath -GlobalPolicyId $globalPolicyId -OutputPath $failOutputPath -Format json | Out-String | ConvertFrom-Json
Assert-Equal -Label "fail validation status" -Expected "fail" -Actual $failResult.validation_status
Assert-True -Label "fail reasons include hard fail" -Condition (@($failResult.reasons) -contains "global_hard_fail_detected")

Write-Host "validate-global-policy-comparison regression tests passed." -ForegroundColor Cyan
