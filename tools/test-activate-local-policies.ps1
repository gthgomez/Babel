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

$generatorPath = Join-Path $Root "tools\generate-local-policy-candidates.ps1"
$activatorPath = Join-Path $Root "tools\activate-local-policies.ps1"
$resolverPath = Join-Path $Root "tools\resolve-local-stack.ps1"
$startScript = Join-Path $Root "tools\start-local-session.ps1"
$endScript = Join-Path $Root "tools\end-local-session.ps1"
$launchScript = Join-Path $Root "tools\launch-babel-local.ps1"
$normalizerPath = Join-Path $Root "tools\normalize-local-evidence.ps1"
$fixturePath = Join-Path $Root "tests\fixtures\activate-local-policies\normalized-events.fixture.jsonl"
$tempDir = Join-Path $Root "runs\local-learning-test\activate-local-policies"
$derivedDir = Join-Path $tempDir "derived"
$candidatePath = Join-Path $derivedDir "policy-candidates.json"
$auditPath = Join-Path $derivedDir "policy-audit.jsonl"
$normalizedSessionOutput = Join-Path $derivedDir "post-activation-normalized-events.jsonl"
$emptyRunsRoot = Join-Path $tempDir "empty-runs"
$activeLocalClientPath = Join-Path $tempDir "active\local-clients\codex_extension.codex.json"
$activeRepoPath = Join-Path $tempDir "active\repos\GPCGuard.json"

foreach ($requiredPath in @($generatorPath, $activatorPath, $resolverPath, $startScript, $endScript, $launchScript, $normalizerPath, $fixturePath)) {
    if (-not (Test-Path -LiteralPath $requiredPath)) {
        throw "Required test input not found: $requiredPath"
    }
}

if (Test-Path -LiteralPath $tempDir) {
    Remove-Item -LiteralPath $tempDir -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $derivedDir | Out-Null
New-Item -ItemType Directory -Force -Path $emptyRunsRoot | Out-Null

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

function Write-JsonFile {
    param([string]$Path, [AllowNull()][object]$Value)
    $dir = Split-Path -Path $Path -Parent
    if (-not [string]::IsNullOrWhiteSpace($dir)) {
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
    }
    $Value | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $Path -Encoding UTF8
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

function Invoke-PowershellJson {
    param([string]$ScriptPath, [string[]]$Arguments)
    $json = powershell -ExecutionPolicy Bypass -File $ScriptPath @Arguments | Out-String
    if ($LASTEXITCODE -ne 0) {
        throw "$ScriptPath exited with code $LASTEXITCODE"
    }
    return ($json | ConvertFrom-Json)
}

function New-SessionEvent {
    param(
        [string]$EventId,
        [string]$ObservedAtUtc,
        [string]$Result,
        [bool]$FollowUpNeeded,
        [string[]]$FailureTags = @(),
        [string]$PolicyVersionApplied = "",
        [string]$AuthoritativeSuccessLabel = "unconfirmed",
        [string]$Project = "GPCGuard",
        [string]$TaskCategory = "frontend",
        [string]$ClientSurface = "codex_extension",
        [string]$Model = "codex"
    )

    $selected = if ($Result -eq "success") {
        @("behavioral_core_v7","behavioral_guard_v7","domain_swe_frontend","adapter_codex_balanced","overlay_gpcguard","task_frontend_professionalism")
    } else {
        @("behavioral_core_v7","behavioral_guard_v7","domain_swe_frontend","adapter_codex","overlay_gpcguard")
    }
    $recommended = @("behavioral_core_v7","behavioral_guard_v7","domain_swe_frontend","adapter_codex_balanced","overlay_gpcguard","task_frontend_professionalism")
    $hardFailSignals = if ($AuthoritativeSuccessLabel -eq "failed") { @("session_result_failed") } else { @() }
    $positiveSignals = @()
    if ($Result -eq "success") { $positiveSignals += "session_result_success" }
    if ($Result -eq "partial") { $positiveSignals += "session_result_partial" }
    if (-not $FollowUpNeeded) { $positiveSignals += "no_follow_up_needed" }

    return [ordered]@{
        schema_version = 1
        event_id = $EventId
        observed_at_utc = $ObservedAtUtc
        source_type = "local_session"
        source_path = "fixture"
        run_id = ""
        session_id = $EventId
        project = $Project
        project_path = ("C:\\Fixtures\\" + $Project)
        task_category = $TaskCategory
        client_surface = $ClientSurface
        model = $Model
        pipeline_mode = "direct"
        selected_stack_ids = $selected
        recommended_stack_ids = $recommended
        recommended_task_overlay_ids = @("task_frontend_professionalism")
        repo_local_system_present = $true
        qa_verdict = "unknown"
        result = $Result
        failure_tags = $FailureTags
        files_touched = @()
        follow_up_needed = $FollowUpNeeded
        policy_version_applied = $PolicyVersionApplied
        hard_fail_signals = $hardFailSignals
        positive_signals = $positiveSignals
        authoritative_success_label = $AuthoritativeSuccessLabel
    }
}

function New-RepoVerificationPolicyContainer {
    param(
        [string]$RepoName,
        [string[]]$Checklist,
        [string[]]$AffectedTaskCategories,
        [string[]]$RationaleTags = @("fixture")
    )

    $repoToken = $RepoName.ToLowerInvariant()
    return [ordered]@{
        schema_version = 1
        generated_at_utc = "2026-03-08T00:00:00Z"
        scope_type = "repo"
        scope_key = $RepoName
        policies = @(
            [ordered]@{
                schema_version = 1
                policy_id = "repo:${repoToken}:verification_loop_hints:strict"
                policy_version = "active-v1"
                scope_type = "repo"
                scope_key = $RepoName
                target_surface = "verification_loop_hints"
                state = "active"
                created_at_utc = "2026-03-08T00:00:00Z"
                updated_at_utc = "2026-03-08T00:00:00Z"
                activated_at_utc = "2026-03-08T00:00:00Z"
                baseline_window = [ordered]@{}
                treatment_window = [ordered]@{}
                supporting_event_ids = @()
                hard_fail_event_ids = @()
                baseline_metrics = [ordered]@{
                    applicable_event_count = 10
                    success_rate = 0.4
                    failed_rate = 0.1
                    follow_up_rate = 0.6
                    stack_override_rate = 0.5
                    comparison_win_rate = 0.2
                }
                treatment_metrics = [ordered]@{
                    applicable_event_count = 5
                    success_rate = 0.8
                    failed_rate = 0
                    follow_up_rate = 0.2
                    stack_override_rate = 0.1
                    comparison_win_rate = 0.6
                }
                rollback_thresholds = [ordered]@{
                    hard_failures_in_first_5_applicable_runs = 2
                    trailing_window_size = 10
                    relative_regression_limit = 0.05
                }
                expiry_policy = [ordered]@{
                    reconfirm_after_days = 30
                    reconfirm_after_applicable_runs = 25
                }
                proposed_change = [ordered]@{
                    checklist = $Checklist
                    affected_task_categories = $AffectedTaskCategories
                    rationale_tags = $RationaleTags
                }
                reversible = $true
                requires_human_review = $false
                activation_mode = "measured"
            }
        )
    }
}

function New-GlobalVerificationCandidateSummary {
    param(
        [string]$Path,
        [string]$AuditPath,
        [string[]]$SupportingRepos,
        [string[]]$SourcePolicyIds,
        [string[]]$SupportingEventIds,
        [string[]]$Checklist = @("require_root_cause_line"),
        [string[]]$AffectedTaskCategories = @("backend"),
        [string[]]$RationaleTags = @("cross_repo_confirmation"),
        [string[]]$HardFailEventIds = @(),
        [string]$ConflictDetectionResult = "none",
        [string]$RegressionCheckResult = "pending_cross_repo_validation"
    )

    $checklistToken = (@($Checklist | ForEach-Object { [string]$_ }) -join ",")
    $categoryToken = (@($AffectedTaskCategories | ForEach-Object { [string]$_ }) -join ",")
    return [ordered]@{
        SchemaVersion = 1
        GeneratedAtUtc = "2026-03-08T00:00:00Z"
        InputPath = $Path
        OutputPath = $Path
        AuditOutputPath = $AuditPath
        CandidateCount = 1
        StateCounts = @()
        TargetSurfaceCounts = @()
        Candidates = @(
            [ordered]@{
                schema_version = 1
                policy_id = "global:verification_loop_hints:checklist:$checklistToken|categories:$categoryToken"
                policy_version = "candidate-v1"
                scope_type = "global"
                scope_key = "global"
                target_surface = "verification_loop_hints"
                state = "shadow"
                created_at_utc = "2026-03-08T00:00:00Z"
                updated_at_utc = "2026-03-08T00:00:00Z"
                baseline_window = [ordered]@{}
                treatment_window = $null
                supporting_event_ids = $SupportingEventIds
                hard_fail_event_ids = $HardFailEventIds
                supporting_repos = $SupportingRepos
                source_scoped_policy_ids = $SourcePolicyIds
                baseline_metrics = [ordered]@{
                    applicable_event_count = 30
                    success_rate = 0.45
                    failed_rate = 0.08
                    follow_up_rate = 0.55
                    stack_override_rate = 0.45
                    comparison_win_rate = 0.25
                }
                treatment_metrics = $null
                rollback_thresholds = [ordered]@{
                    hard_failures_in_first_5_applicable_runs = 2
                    trailing_window_size = 10
                    relative_regression_limit = 0.05
                }
                expiry_policy = [ordered]@{
                    reconfirm_after_days = 60
                    reconfirm_after_applicable_runs = 100
                }
                proposed_change = [ordered]@{
                    checklist = $Checklist
                    affected_task_categories = $AffectedTaskCategories
                    rationale_tags = $RationaleTags
                }
                reversible = $true
                requires_human_review = $false
                decision_reasons = @("fixture")
                shadow_decision = [ordered]@{
                    eligible = $true
                    likely_improvement_signals = @("cross_repo_confirmation")
                }
                conflict_detection_result = $ConflictDetectionResult
                regression_check_result = $RegressionCheckResult
            }
        )
    }
}

function New-KickoffCandidateSummary {
    param([string]$Path, [string]$AuditPath, [string]$State = "shadow")
    return [ordered]@{
        SchemaVersion = 1
        GeneratedAtUtc = "2026-03-08T00:00:00Z"
        InputPath = $Path
        OutputPath = $Path
        AuditOutputPath = $AuditPath
        CandidateCount = 1
        StateCounts = @()
        TargetSurfaceCounts = @()
        Candidates = @(
            [ordered]@{
                schema_version = 1
                policy_id = "local-client:codex_extension.codex:kickoff_prompt_preset:compact"
                policy_version = "candidate-v1"
                scope_type = "local_client"
                scope_key = "codex_extension|codex"
                target_surface = "kickoff_prompt_preset"
                state = $State
                created_at_utc = "2026-03-07T00:00:00Z"
                updated_at_utc = "2026-03-07T00:00:00Z"
                baseline_window = [ordered]@{}
                treatment_window = $null
                supporting_event_ids = @("session:activate-01","session:activate-02","session:activate-04")
                hard_fail_event_ids = @()
                baseline_metrics = [ordered]@{
                    applicable_event_count = 8
                    success_rate = 0
                    failed_rate = 0.125
                    follow_up_rate = 0.75
                    stack_override_rate = 0.75
                    comparison_win_rate = 0
                }
                treatment_metrics = $null
                rollback_thresholds = [ordered]@{
                    hard_failures_in_first_5_applicable_runs = 2
                    trailing_window_size = 10
                    relative_regression_limit = 0.05
                }
                expiry_policy = [ordered]@{
                    reconfirm_after_days = 30
                    reconfirm_after_applicable_runs = 25
                }
                proposed_change = [ordered]@{
                    preset_id = "compact"
                    affected_task_categories = @("frontend")
                    rationale_tags = @("prompt_too_long")
                }
                reversible = $true
                requires_human_review = $false
                decision_reasons = @("fixture")
                shadow_decision = [ordered]@{
                    eligible = ($State -eq "shadow")
                    would_change_stack_ranking = $false
                    would_change_kickoff_phrasing = $true
                    would_change_heuristics = $false
                    likely_improvement_signals = @("fixture")
                }
            }
        )
    }
}

$generationSummary = Invoke-PowershellJson -ScriptPath $generatorPath -Arguments @(
    "-Root", $Root, "-InputPath", $fixturePath, "-OutputPath", $candidatePath, "-AuditOutputPath", $auditPath, "-Format", "json"
)
Assert-True -Label "phase3 candidate generation count" -Condition ([int]$generationSummary.CandidateCount -ge 1)

$activationSummary = Invoke-PowershellJson -ScriptPath $activatorPath -Arguments @(
    "-Root", $Root, "-OutputRoot", $tempDir, "-CandidatePath", $candidatePath, "-NormalizedEventsPath", $fixturePath, "-CurrentTimeUtc", "2026-03-07T12:00:00Z", "-Format", "json"
)
Assert-Equal -Label "activated policy count" -Expected 1 -Actual $activationSummary.ActivatedCount
Assert-Equal -Label "bootstrap activation count" -Expected 0 -Actual $activationSummary.BootstrapActivatedCount
Assert-True -Label "active local-client policy file exists" -Condition (Test-Path -LiteralPath $activeLocalClientPath)

$activePolicyContainer = Get-Content -LiteralPath $activeLocalClientPath -Raw | ConvertFrom-Json
$activePolicy = @($activePolicyContainer.policies | Select-Object -First 1)
Assert-Equal -Label "active policy state" -Expected "active" -Actual $activePolicy.state
Assert-Equal -Label "active policy version" -Expected "active-v1" -Actual $activePolicy.policy_version

$resolveResult = Invoke-PowershellJson -ScriptPath $resolverPath -Arguments @(
    "-Root", $Root, "-LocalLearningRoot", $tempDir, "-Project", "GPCGuard", "-TaskCategory", "frontend", "-Model", "codex", "-ClientSurface", "codex_extension", "-Format", "json"
)
Assert-Equal -Label "resolver policy version applied" -Expected "local-client:codex_extension.codex:kickoff_prompt_preset:compact@active-v1" -Actual $resolveResult.PolicyVersionApplied

$launchResult = Invoke-PowershellJson -ScriptPath $launchScript -Arguments @(
    "-Root", $Root, "-OutputRoot", $tempDir, "-Project", "GPCGuard", "-TaskCategory", "frontend", "-Model", "codex", "-ClientSurface", "codex_extension", "-WorkMode", "plan", "-TaskPrompt", "Check compact kickoff prompt behavior.", "-SessionId", "phase3-launch-001", "-Format", "json"
)
Assert-True -Label "launch prompt suppresses duplicate surface starter" -Condition (-not ([string]$launchResult.LaunchPrompt).Contains("use Babel for this task, then plan and execute using the selected instruction stack"))

$sessionId = "phase3-activation-session-001"
$startRecord = Invoke-PowershellJson -ScriptPath $startScript -Arguments @(
    "-Root", $Root, "-OutputRoot", $tempDir, "-Project", "GPCGuard", "-TaskCategory", "frontend", "-Model", "codex", "-ClientSurface", "codex_extension", "-SessionId", $sessionId, "-Format", "json"
)
Assert-Equal -Label "session start policy version applied" -Expected "local-client:codex_extension.codex:kickoff_prompt_preset:compact@active-v1" -Actual $startRecord.PolicyVersionApplied
$null = Invoke-PowershellJson -ScriptPath $endScript -Arguments @(
    "-Root", $Root, "-OutputRoot", $tempDir, "-SessionId", $sessionId, "-Result", "success", "-FilesTouched", "src/app/dashboard/page.tsx", "-Format", "json"
)

$sessionLogPath = Join-Path $tempDir "session-log.jsonl"
$null = Invoke-PowershellJson -ScriptPath $normalizerPath -Arguments @(
    "-Root", $Root, "-RunBundlesRoot", $emptyRunsRoot, "-SessionLogPath", $sessionLogPath, "-OutputPath", $normalizedSessionOutput, "-Format", "json"
)
$normalizedSession = @(
    Get-Content -LiteralPath $normalizedSessionOutput |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
        ForEach-Object { $_ | ConvertFrom-Json } |
        Where-Object { $_.session_id -eq $sessionId } |
        Select-Object -First 1
)
Assert-Equal -Label "normalized session policy version applied" -Expected "local-client:codex_extension.codex:kickoff_prompt_preset:compact@active-v1" -Actual $normalizedSession.policy_version_applied

$repoPolicy = Copy-Item -PassThru $activeLocalClientPath $activeRepoPath -ErrorAction SilentlyContinue
$repoContainer = Get-Content -LiteralPath $activeLocalClientPath -Raw | ConvertFrom-Json
$repoContainer.scope_type = "repo"
$repoContainer.scope_key = "GPCGuard"
$repoContainer.policies[0].policy_id = "repo:gpcguard:verification_loop_hints:strict"
$repoContainer.policies[0].scope_type = "repo"
$repoContainer.policies[0].scope_key = "GPCGuard"
$repoContainer.policies[0].target_surface = "verification_loop_hints"
$repoContainer.policies[0].proposed_change = [ordered]@{ checklist = @("require_root_cause_line") }
Write-JsonFile -Path $activeRepoPath -Value $repoContainer

$multiResolveResult = Invoke-PowershellJson -ScriptPath $resolverPath -Arguments @(
    "-Root", $Root, "-LocalLearningRoot", $tempDir, "-Project", "GPCGuard", "-TaskCategory", "frontend", "-Model", "codex", "-ClientSurface", "codex_extension", "-Format", "json"
)
Assert-Equal -Label "multi-policy resolver signature" -Expected "repo:gpcguard:verification_loop_hints:strict@active-v1;local-client:codex_extension.codex:kickoff_prompt_preset:compact@active-v1" -Actual $multiResolveResult.PolicyVersionApplied

$multiRoot = Join-Path $tempDir "multi-policy"
$multiCandidatePath = Join-Path $multiRoot "derived\policy-candidates.json"
$multiAuditPath = Join-Path $multiRoot "derived\policy-audit.jsonl"
$multiEventsPath = Join-Path $multiRoot "derived\normalized-events.jsonl"
Write-JsonFile -Path $multiCandidatePath -Value (New-KickoffCandidateSummary -Path $multiEventsPath -AuditPath $multiAuditPath)
Write-JsonLines -Path $multiEventsPath -Items @(
    (New-SessionEvent -EventId "multi-01" -ObservedAtUtc "2026-03-01T08:00:00Z" -Result "partial" -FollowUpNeeded $true -FailureTags @("prompt_too_long")),
    (New-SessionEvent -EventId "multi-02" -ObservedAtUtc "2026-03-02T08:00:00Z" -Result "partial" -FollowUpNeeded $true -FailureTags @("instruction_overload")),
    (New-SessionEvent -EventId "multi-03" -ObservedAtUtc "2026-03-03T08:00:00Z" -Result "failed" -FollowUpNeeded $true -FailureTags @("tool_visibility_gap") -AuthoritativeSuccessLabel "failed"),
    (New-SessionEvent -EventId "multi-04" -ObservedAtUtc "2026-03-04T08:00:00Z" -Result "partial" -FollowUpNeeded $true -FailureTags @("prompt_too_long")),
    (New-SessionEvent -EventId "multi-05" -ObservedAtUtc "2026-03-05T08:00:00Z" -Result "partial" -FollowUpNeeded $true -FailureTags @("instruction_overload")),
    (New-SessionEvent -EventId "multi-06" -ObservedAtUtc "2026-03-06T08:00:00Z" -Result "partial" -FollowUpNeeded $true -FailureTags @("prompt_too_long")),
    (New-SessionEvent -EventId "multi-07" -ObservedAtUtc "2026-03-07T08:00:00Z" -Result "success" -FollowUpNeeded $false -PolicyVersionApplied "local-client:codex_extension.codex:kickoff_prompt_preset:compact;repo:gpcguard:verification_loop_hints:strict" -AuthoritativeSuccessLabel "success"),
    (New-SessionEvent -EventId "multi-08" -ObservedAtUtc "2026-03-08T08:00:00Z" -Result "success" -FollowUpNeeded $false -PolicyVersionApplied "local-client:codex_extension.codex:kickoff_prompt_preset:compact;repo:gpcguard:verification_loop_hints:strict" -AuthoritativeSuccessLabel "success")
)
$multiActivationSummary = Invoke-PowershellJson -ScriptPath $activatorPath -Arguments @(
    "-Root", $Root, "-OutputRoot", $multiRoot, "-CandidatePath", $multiCandidatePath, "-NormalizedEventsPath", $multiEventsPath, "-CurrentTimeUtc", "2026-03-08T12:00:00Z", "-Format", "json"
)
Assert-Equal -Label "multi-policy activation count" -Expected 1 -Actual $multiActivationSummary.ActivatedCount

$carryCandidatePath = Join-Path $derivedDir "carryforward-policy-candidates.json"
$carryAuditPath = Join-Path $derivedDir "carryforward-policy-audit.jsonl"
Write-JsonFile -Path $carryCandidatePath -Value (New-KickoffCandidateSummary -Path $fixturePath -AuditPath $carryAuditPath -State "candidate")
$carryforwardSummary = Invoke-PowershellJson -ScriptPath $activatorPath -Arguments @(
    "-Root", $Root, "-OutputRoot", $tempDir, "-CandidatePath", $carryCandidatePath, "-NormalizedEventsPath", $fixturePath, "-CurrentTimeUtc", "2026-03-08T12:00:00Z", "-Format", "json"
)
Assert-True -Label "carryforward preserved count positive" -Condition ([int]$carryforwardSummary.CarryForwardCount -ge 1)
Assert-True -Label "carryforward local-client policy preserved" -Condition (Test-Path -LiteralPath $activeLocalClientPath)

$rollbackEventsPath = Join-Path $derivedDir "rollback-events.jsonl"
$rollbackEvents = @(
    Get-Content -LiteralPath $fixturePath |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
        ForEach-Object { $_ | ConvertFrom-Json }
)
$rollbackEvents += @(
    (New-SessionEvent -EventId "rollback-01" -ObservedAtUtc "2026-03-07T14:00:00Z" -Result "failed" -FollowUpNeeded $true -FailureTags @("regression_detected") -PolicyVersionApplied "local-client:codex_extension.codex:kickoff_prompt_preset:compact@active-v1" -AuthoritativeSuccessLabel "failed"),
    (New-SessionEvent -EventId "rollback-02" -ObservedAtUtc "2026-03-07T15:00:00Z" -Result "failed" -FollowUpNeeded $true -FailureTags @("regression_detected") -PolicyVersionApplied "local-client:codex_extension.codex:kickoff_prompt_preset:compact@active-v1" -AuthoritativeSuccessLabel "failed")
)
Write-JsonLines -Path $rollbackEventsPath -Items $rollbackEvents
$rollbackSummary = Invoke-PowershellJson -ScriptPath $activatorPath -Arguments @(
    "-Root", $Root, "-OutputRoot", $tempDir, "-CandidatePath", $carryCandidatePath, "-NormalizedEventsPath", $rollbackEventsPath, "-CurrentTimeUtc", "2026-03-08T16:00:00Z", "-Format", "json"
)
Assert-Equal -Label "rollback count" -Expected 1 -Actual $rollbackSummary.RolledBackCount
Assert-True -Label "local-client file removed after rollback" -Condition (-not (Test-Path -LiteralPath $activeLocalClientPath))

$expiryRoot = Join-Path $tempDir "expiry"
$expiryPolicyPath = Join-Path $expiryRoot "active\local-clients\codex_extension.codex.json"
$expiryContainer = Get-Content -LiteralPath $activeRepoPath -Raw | ConvertFrom-Json
$expiryContainer.scope_type = "local_client"
$expiryContainer.scope_key = "codex_extension|codex"
$expiryContainer.policies[0].policy_id = "local-client:codex_extension.codex:kickoff_prompt_preset:compact"
$expiryContainer.policies[0].scope_type = "local_client"
$expiryContainer.policies[0].scope_key = "codex_extension|codex"
$expiryContainer.policies[0].target_surface = "kickoff_prompt_preset"
$expiryContainer.policies[0].activated_at_utc = "2026-03-01T00:00:00Z"
$expiryContainer.policies[0].updated_at_utc = "2026-03-01T00:00:00Z"
$expiryContainer.policies[0].expiry_policy = [ordered]@{ reconfirm_after_days = 30; reconfirm_after_applicable_runs = 25 }
Write-JsonFile -Path $expiryPolicyPath -Value $expiryContainer
$expiryEventsPath = Join-Path $derivedDir "expiry-events.jsonl"
Write-JsonLines -Path $expiryEventsPath -Items @(New-SessionEvent -EventId "expiry-01" -ObservedAtUtc "2026-03-10T08:00:00Z" -Result "success" -FollowUpNeeded $false -PolicyVersionApplied "local-client:codex_extension.codex:kickoff_prompt_preset:compact@active-v1" -AuthoritativeSuccessLabel "success")
$expiryCandidatePath = Join-Path $derivedDir "expiry-policy-candidates.json"
Write-JsonFile -Path $expiryCandidatePath -Value ([ordered]@{ SchemaVersion = 1; GeneratedAtUtc = "2026-04-15T00:00:00Z"; CandidateCount = 0; Candidates = @() })
$expirySummary = Invoke-PowershellJson -ScriptPath $activatorPath -Arguments @(
    "-Root", $Root, "-OutputRoot", $expiryRoot, "-CandidatePath", $expiryCandidatePath, "-NormalizedEventsPath", $expiryEventsPath, "-CurrentTimeUtc", "2026-04-15T00:00:00Z", "-Format", "json"
)
Assert-Equal -Label "expiry count" -Expected 1 -Actual $expirySummary.ExpiredCount
Assert-True -Label "expired policy file removed" -Condition (-not (Test-Path -LiteralPath $expiryPolicyPath))

$bootstrapRoot = Join-Path $tempDir "bootstrap"
$bootstrapCandidatePath = Join-Path $bootstrapRoot "derived\policy-candidates.json"
$bootstrapAuditPath = Join-Path $bootstrapRoot "derived\policy-audit.jsonl"
$bootstrapEventsPath = Join-Path $bootstrapRoot "derived\normalized-events.jsonl"
$bootstrapCandidateSummary = New-KickoffCandidateSummary -Path $bootstrapEventsPath -AuditPath $bootstrapAuditPath
$bootstrapCandidateSummary.Candidates[0].supporting_event_ids = @("bootstrap-01","bootstrap-02","bootstrap-03")
Write-JsonFile -Path $bootstrapCandidatePath -Value $bootstrapCandidateSummary
Write-JsonLines -Path $bootstrapEventsPath -Items @(
    (New-SessionEvent -EventId "bootstrap-01" -ObservedAtUtc "2026-03-01T08:00:00Z" -Result "partial" -FollowUpNeeded $true -FailureTags @("prompt_too_long")),
    (New-SessionEvent -EventId "bootstrap-02" -ObservedAtUtc "2026-03-02T08:00:00Z" -Result "partial" -FollowUpNeeded $true -FailureTags @("instruction_overload")),
    (New-SessionEvent -EventId "bootstrap-03" -ObservedAtUtc "2026-03-03T08:00:00Z" -Result "partial" -FollowUpNeeded $true -FailureTags @("prompt_too_long")),
    (New-SessionEvent -EventId "bootstrap-04" -ObservedAtUtc "2026-03-04T08:00:00Z" -Result "partial" -FollowUpNeeded $true -FailureTags @("instruction_overload")),
    (New-SessionEvent -EventId "bootstrap-05" -ObservedAtUtc "2026-03-05T08:00:00Z" -Result "partial" -FollowUpNeeded $true -FailureTags @("prompt_too_long")),
    (New-SessionEvent -EventId "bootstrap-06" -ObservedAtUtc "2026-03-06T08:00:00Z" -Result "partial" -FollowUpNeeded $true -FailureTags @("instruction_overload")),
    (New-SessionEvent -EventId "bootstrap-07" -ObservedAtUtc "2026-03-07T08:00:00Z" -Result "partial" -FollowUpNeeded $false -FailureTags @()),
    (New-SessionEvent -EventId "bootstrap-08" -ObservedAtUtc "2026-03-08T08:00:00Z" -Result "partial" -FollowUpNeeded $false -FailureTags @())
)
$bootstrapSummary = Invoke-PowershellJson -ScriptPath $activatorPath -Arguments @(
    "-Root", $Root, "-OutputRoot", $bootstrapRoot, "-CandidatePath", $bootstrapCandidatePath, "-NormalizedEventsPath", $bootstrapEventsPath, "-CurrentTimeUtc", "2026-03-08T18:00:00Z", "-Format", "json"
)
Assert-Equal -Label "bootstrap activated count" -Expected 1 -Actual $bootstrapSummary.ActivatedCount
Assert-Equal -Label "bootstrap activation mode count" -Expected 1 -Actual $bootstrapSummary.BootstrapActivatedCount

$guardRejectRoot = Join-Path $tempDir "guard-rejections"
$guardRejectCandidatePath = Join-Path $guardRejectRoot "derived\policy-candidates.json"
$guardRejectAuditPath = Join-Path $guardRejectRoot "derived\policy-audit.jsonl"
$globalCandidateSummary = New-GlobalVerificationCandidateSummary `
    -Path $fixturePath `
    -AuditPath $guardRejectAuditPath `
    -SupportingRepos @("GPCGuard", "Prismatix") `
    -SourcePolicyIds @("repo:gpcguard:verification_loop_hints:strict", "repo:prismatix:verification_loop_hints:strict") `
    -SupportingEventIds @("session:activate-01", "session:activate-02")
Write-JsonFile -Path $guardRejectCandidatePath -Value $globalCandidateSummary
$guardRejectSummary = Invoke-PowershellJson -ScriptPath $activatorPath -Arguments @(
    "-Root", $Root, "-OutputRoot", $guardRejectRoot, "-CandidatePath", $guardRejectCandidatePath, "-NormalizedEventsPath", $fixturePath, "-CurrentTimeUtc", "2026-03-08T19:00:00Z", "-Format", "json"
)
Assert-Equal -Label "global scope policy not activated" -Expected 0 -Actual $guardRejectSummary.ActivatedCount
$guardRejectAuditRecords = @(
    Get-Content -LiteralPath $guardRejectAuditPath |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
        ForEach-Object { $_ | ConvertFrom-Json }
)
$globalSkipRecord = @($guardRejectAuditRecords | Where-Object { [string]$_.scope_type -eq "global" } | Select-Object -First 1)
Assert-Equal -Label "global scope policy decision" -Expected "skipped" -Actual $globalSkipRecord.decision
Assert-True -Label "global scope rejection reason logged" -Condition (@($globalSkipRecord.reasons) -contains "insufficient_source_repos")
Assert-True -Label "global scope rejection audit includes supporting events" -Condition (@($globalSkipRecord.supporting_event_ids).Count -eq 2)

$allowlistRejectCandidatePath = Join-Path $guardRejectRoot "derived\non-allowlisted-policy-candidates.json"
$allowlistCandidateSummary = New-KickoffCandidateSummary -Path $fixturePath -AuditPath $guardRejectAuditPath
$allowlistCandidateSummary.Candidates[0].policy_id = "local-client:codex_extension.codex:prompt_markdown_edit:guard"
$allowlistCandidateSummary.Candidates[0].target_surface = "prompt_markdown_edit"
Write-JsonFile -Path $allowlistRejectCandidatePath -Value $allowlistCandidateSummary
$allowlistRejectSummary = Invoke-PowershellJson -ScriptPath $activatorPath -Arguments @(
    "-Root", $Root, "-OutputRoot", $guardRejectRoot, "-CandidatePath", $allowlistRejectCandidatePath, "-NormalizedEventsPath", $fixturePath, "-CurrentTimeUtc", "2026-03-08T19:30:00Z", "-Format", "json"
)
Assert-Equal -Label "non-allowlisted policy not activated" -Expected 0 -Actual $allowlistRejectSummary.ActivatedCount
$allowlistAuditRecords = @(
    Get-Content -LiteralPath $guardRejectAuditPath |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
        ForEach-Object { $_ | ConvertFrom-Json }
)
$allowlistSkipRecord = @($allowlistAuditRecords | Where-Object { [string]$_.policy_id -eq "local-client:codex_extension.codex:prompt_markdown_edit:guard" } | Select-Object -First 1)
Assert-Equal -Label "non-allowlisted policy decision" -Expected "skipped" -Actual $allowlistSkipRecord.decision
Assert-True -Label "non-allowlisted rejection reason logged" -Condition (@($allowlistSkipRecord.reasons) -contains "target_surface_not_allowlisted")

$globalRoot = Join-Path $tempDir "global-activation"
$globalCandidatePath = Join-Path $globalRoot "derived\policy-candidates.json"
$globalAuditPath = Join-Path $globalRoot "derived\policy-audit.jsonl"
$globalEventsPath = Join-Path $globalRoot "derived\normalized-events.jsonl"
$globalPolicyPath = Join-Path $globalRoot "active\global-policy.json"
$globalRepoRoot = Join-Path $globalRoot "active\repos"
Write-JsonFile -Path (Join-Path $globalRepoRoot "GPCGuard.json") -Value (New-RepoVerificationPolicyContainer -RepoName "GPCGuard" -Checklist @("require_root_cause_line") -AffectedTaskCategories @("backend") -RationaleTags @("cross_repo_confirmation"))
Write-JsonFile -Path (Join-Path $globalRepoRoot "Prismatix.json") -Value (New-RepoVerificationPolicyContainer -RepoName "Prismatix" -Checklist @("require_root_cause_line") -AffectedTaskCategories @("backend") -RationaleTags @("cross_repo_confirmation"))
Write-JsonFile -Path (Join-Path $globalRepoRoot "AuditGuard.json") -Value (New-RepoVerificationPolicyContainer -RepoName "AuditGuard" -Checklist @("require_root_cause_line") -AffectedTaskCategories @("backend") -RationaleTags @("cross_repo_confirmation"))
Write-JsonFile -Path $globalCandidatePath -Value (New-GlobalVerificationCandidateSummary `
    -Path $globalEventsPath `
    -AuditPath $globalAuditPath `
    -SupportingRepos @("GPCGuard", "Prismatix", "AuditGuard") `
    -SourcePolicyIds @(
        "repo:gpcguard:verification_loop_hints:strict",
        "repo:prismatix:verification_loop_hints:strict",
        "repo:auditguard:verification_loop_hints:strict"
    ) `
    -SupportingEventIds @("global-01", "global-02", "global-03"))
Write-JsonLines -Path $globalEventsPath -Items @(
    (New-SessionEvent -EventId "global-01" -ObservedAtUtc "2026-03-08T09:00:00Z" -Result "success" -FollowUpNeeded $false -AuthoritativeSuccessLabel "success" -Project "GPCGuard" -TaskCategory "backend"),
    (New-SessionEvent -EventId "global-02" -ObservedAtUtc "2026-03-08T09:30:00Z" -Result "success" -FollowUpNeeded $false -AuthoritativeSuccessLabel "success" -Project "Prismatix" -TaskCategory "backend"),
    (New-SessionEvent -EventId "global-03" -ObservedAtUtc "2026-03-08T10:00:00Z" -Result "success" -FollowUpNeeded $false -AuthoritativeSuccessLabel "success" -Project "AuditGuard" -TaskCategory "backend")
)
$globalActivationSummary = Invoke-PowershellJson -ScriptPath $activatorPath -Arguments @(
    "-Root", $Root, "-OutputRoot", $globalRoot, "-CandidatePath", $globalCandidatePath, "-NormalizedEventsPath", $globalEventsPath, "-CurrentTimeUtc", "2026-03-08T20:00:00Z", "-Format", "json"
)
Assert-Equal -Label "global activation count" -Expected 1 -Actual $globalActivationSummary.ActivatedCount
Assert-True -Label "active global policy file exists" -Condition (Test-Path -LiteralPath $globalPolicyPath)
$activeGlobalContainer = Get-Content -LiteralPath $globalPolicyPath -Raw | ConvertFrom-Json
$activeGlobalPolicy = @($activeGlobalContainer.policies | Select-Object -First 1)
Assert-Equal -Label "active global policy state" -Expected "active" -Actual $activeGlobalPolicy.state
Assert-Equal -Label "active global policy version" -Expected "active-v1" -Actual $activeGlobalPolicy.policy_version
Assert-Equal -Label "active global activation mode" -Expected "cross_repo_verified" -Actual $activeGlobalPolicy.activation_mode
Assert-Equal -Label "active global regression result" -Expected "verified_no_cross_repo_regression" -Actual $activeGlobalPolicy.regression_check_result

$globalFallbackRoot = Join-Path $tempDir "global-fallback"
$globalFallbackPolicyPath = Join-Path $globalFallbackRoot "active\global-policy.json"
Write-JsonFile -Path $globalFallbackPolicyPath -Value $activeGlobalContainer
$globalFallbackResolve = Invoke-PowershellJson -ScriptPath $resolverPath -Arguments @(
    "-Root", $Root, "-LocalLearningRoot", $globalFallbackRoot, "-Project", "GPCGuard", "-TaskCategory", "backend", "-Model", "codex", "-ClientSurface", "codex_extension", "-Format", "json"
)
Assert-Equal -Label "resolver applies global signature when no repo override exists" -Expected "global:verification_loop_hints:checklist:require_root_cause_line|categories:backend@active-v1" -Actual $globalFallbackResolve.PolicyVersionApplied
Assert-True -Label "resolver kickoff includes global verification hint" -Condition ([string]$globalFallbackResolve.KickoffPrompt).Contains("Include one explicit root-cause line before proposing the fix.")

$globalLocalClientPolicyPath = Join-Path $globalFallbackRoot "active\local-clients\codex_extension.codex.json"
$globalLocalClientContainer = New-KickoffCandidateSummary -Path $globalEventsPath -AuditPath $globalAuditPath
$globalLocalClientContainer.SchemaVersion = 1
$globalLocalClientContainer.GeneratedAtUtc = "2026-03-08T20:30:00Z"
$globalLocalClientContainer.scope_type = "local_client"
$globalLocalClientContainer.scope_key = "codex_extension|codex"
$globalLocalClientContainer.policies = @(
    [ordered]@{
        schema_version = 1
        policy_id = "local-client:codex_extension.codex:kickoff_prompt_preset:compact"
        policy_version = "active-v1"
        scope_type = "local_client"
        scope_key = "codex_extension|codex"
        target_surface = "kickoff_prompt_preset"
        state = "active"
        created_at_utc = "2026-03-08T20:30:00Z"
        updated_at_utc = "2026-03-08T20:30:00Z"
        activated_at_utc = "2026-03-08T20:30:00Z"
        baseline_window = [ordered]@{}
        treatment_window = [ordered]@{}
        supporting_event_ids = @()
        hard_fail_event_ids = @()
        baseline_metrics = [ordered]@{}
        treatment_metrics = [ordered]@{}
        rollback_thresholds = [ordered]@{
            hard_failures_in_first_5_applicable_runs = 2
            trailing_window_size = 10
            relative_regression_limit = 0.05
        }
        expiry_policy = [ordered]@{
            reconfirm_after_days = 30
            reconfirm_after_applicable_runs = 25
        }
        proposed_change = [ordered]@{
            preset_id = "compact"
            affected_task_categories = @("backend")
            rationale_tags = @("fixture")
        }
        reversible = $true
        requires_human_review = $false
        activation_mode = "measured"
    }
)
Write-JsonFile -Path $globalLocalClientPolicyPath -Value $globalLocalClientContainer
$globalLocalResolve = Invoke-PowershellJson -ScriptPath $resolverPath -Arguments @(
    "-Root", $Root, "-LocalLearningRoot", $globalFallbackRoot, "-Project", "GPCGuard", "-TaskCategory", "backend", "-Model", "codex", "-ClientSurface", "codex_extension", "-Format", "json"
)
Assert-Equal -Label "resolver orders local-client before global signature" -Expected "local-client:codex_extension.codex:kickoff_prompt_preset:compact@active-v1;global:verification_loop_hints:checklist:require_root_cause_line|categories:backend@active-v1" -Actual $globalLocalResolve.PolicyVersionApplied
$globalStartSessionId = "global-fallback-session-001"
$globalStartRecord = Invoke-PowershellJson -ScriptPath $startScript -Arguments @(
    "-Root", $Root, "-OutputRoot", $globalFallbackRoot, "-Project", "GPCGuard", "-TaskCategory", "backend", "-Model", "codex", "-ClientSurface", "codex_extension", "-SessionId", $globalStartSessionId, "-Format", "json"
)
Assert-Equal -Label "session start logs local-client then global signature" -Expected "local-client:codex_extension.codex:kickoff_prompt_preset:compact@active-v1;global:verification_loop_hints:checklist:require_root_cause_line|categories:backend@active-v1" -Actual $globalStartRecord.PolicyVersionApplied
$globalLaunchRecord = Invoke-PowershellJson -ScriptPath $launchScript -Arguments @(
    "-Root", $Root, "-OutputRoot", $globalFallbackRoot, "-Project", "GPCGuard", "-TaskCategory", "backend", "-Model", "codex", "-ClientSurface", "codex_extension", "-WorkMode", "plan", "-TaskPrompt", "Validate global fallback prompt logging.", "-SessionId", "global-launch-001", "-Format", "json"
)
Assert-Equal -Label "launch logs local-client then global signature" -Expected "local-client:codex_extension.codex:kickoff_prompt_preset:compact@active-v1;global:verification_loop_hints:checklist:require_root_cause_line|categories:backend@active-v1" -Actual $globalLaunchRecord.PolicyVersionApplied

$globalRepoOverrideRoot = Join-Path $tempDir "global-repo-override"
Write-JsonFile -Path (Join-Path $globalRepoOverrideRoot "active\global-policy.json") -Value $activeGlobalContainer
Write-JsonFile -Path (Join-Path $globalRepoOverrideRoot "active\repos\GPCGuard.json") -Value (New-RepoVerificationPolicyContainer -RepoName "GPCGuard" -Checklist @("require_test_plan") -AffectedTaskCategories @("backend") -RationaleTags @("repo_override"))
$globalRepoOverrideResolve = Invoke-PowershellJson -ScriptPath $resolverPath -Arguments @(
    "-Root", $Root, "-LocalLearningRoot", $globalRepoOverrideRoot, "-Project", "GPCGuard", "-TaskCategory", "backend", "-Model", "codex", "-ClientSurface", "codex_extension", "-Format", "json"
)
Assert-Equal -Label "resolver ignores global policy when repo policy conflicts" -Expected "repo:gpcguard:verification_loop_hints:strict@active-v1" -Actual $globalRepoOverrideResolve.PolicyVersionApplied
Assert-True -Label "repo override kickoff includes repo verification hint" -Condition ([string]$globalRepoOverrideResolve.KickoffPrompt).Contains("Include a concrete test plan before or alongside the implementation.")
Assert-True -Label "repo override kickoff omits global verification hint" -Condition (-not ([string]$globalRepoOverrideResolve.KickoffPrompt).Contains("Include one explicit root-cause line before proposing the fix."))

$globalRollbackRoot = Join-Path $tempDir "global-rollback"
Write-JsonFile -Path (Join-Path $globalRollbackRoot "active\global-policy.json") -Value $activeGlobalContainer
Write-JsonFile -Path (Join-Path $globalRollbackRoot "active\repos\GPCGuard.json") -Value (New-RepoVerificationPolicyContainer -RepoName "GPCGuard" -Checklist @("require_root_cause_line") -AffectedTaskCategories @("backend"))
Write-JsonFile -Path (Join-Path $globalRollbackRoot "active\repos\Prismatix.json") -Value (New-RepoVerificationPolicyContainer -RepoName "Prismatix" -Checklist @("require_root_cause_line") -AffectedTaskCategories @("backend"))
$globalRollbackEventsPath = Join-Path $globalRollbackRoot "derived\normalized-events.jsonl"
$globalRollbackCandidatePath = Join-Path $globalRollbackRoot "derived\policy-candidates.json"
Write-JsonFile -Path $globalRollbackCandidatePath -Value ([ordered]@{ SchemaVersion = 1; GeneratedAtUtc = "2026-03-09T00:00:00Z"; CandidateCount = 0; Candidates = @() })
Write-JsonLines -Path $globalRollbackEventsPath -Items @(
    (New-SessionEvent -EventId "global-rb-01" -ObservedAtUtc "2026-03-09T08:00:00Z" -Result "failed" -FollowUpNeeded $true -AuthoritativeSuccessLabel "failed" -PolicyVersionApplied "global:verification_loop_hints:checklist:require_root_cause_line|categories:backend@active-v1" -Project "GPCGuard" -TaskCategory "backend"),
    (New-SessionEvent -EventId "global-rb-02" -ObservedAtUtc "2026-03-09T09:00:00Z" -Result "failed" -FollowUpNeeded $true -AuthoritativeSuccessLabel "failed" -PolicyVersionApplied "global:verification_loop_hints:checklist:require_root_cause_line|categories:backend@active-v1" -Project "Prismatix" -TaskCategory "backend")
)
$globalRollbackSummary = Invoke-PowershellJson -ScriptPath $activatorPath -Arguments @(
    "-Root", $Root, "-OutputRoot", $globalRollbackRoot, "-CandidatePath", $globalRollbackCandidatePath, "-NormalizedEventsPath", $globalRollbackEventsPath, "-CurrentTimeUtc", "2026-03-09T10:00:00Z", "-Format", "json"
)
Assert-Equal -Label "global rollback count" -Expected 1 -Actual $globalRollbackSummary.RolledBackCount
Assert-True -Label "global policy removed after rollback" -Condition (-not (Test-Path -LiteralPath (Join-Path $globalRollbackRoot "active\global-policy.json")))
Assert-True -Label "repo policy preserved after global rollback" -Condition (Test-Path -LiteralPath (Join-Path $globalRollbackRoot "active\repos\GPCGuard.json"))

$globalExpiryRoot = Join-Path $tempDir "global-expiry"
$globalExpiryContainer = Get-Content -LiteralPath $globalPolicyPath -Raw | ConvertFrom-Json
$globalExpiryContainer.policies[0].activated_at_utc = "2026-03-01T00:00:00Z"
$globalExpiryContainer.policies[0].updated_at_utc = "2026-03-01T00:00:00Z"
$globalExpiryContainer.policies[0].expiry_policy = [ordered]@{ reconfirm_after_days = 60; reconfirm_after_applicable_runs = 100 }
Write-JsonFile -Path (Join-Path $globalExpiryRoot "active\global-policy.json") -Value $globalExpiryContainer
$freshRepoExpiryContainer = New-RepoVerificationPolicyContainer -RepoName "GPCGuard" -Checklist @("require_root_cause_line") -AffectedTaskCategories @("backend")
$freshRepoExpiryContainer.policies[0].activated_at_utc = "2026-05-01T00:00:00Z"
$freshRepoExpiryContainer.policies[0].updated_at_utc = "2026-05-01T00:00:00Z"
Write-JsonFile -Path (Join-Path $globalExpiryRoot "active\repos\GPCGuard.json") -Value $freshRepoExpiryContainer
$globalExpiryCandidatePath = Join-Path $globalExpiryRoot "derived\policy-candidates.json"
$globalExpiryEventsPath = Join-Path $globalExpiryRoot "derived\normalized-events.jsonl"
Write-JsonFile -Path $globalExpiryCandidatePath -Value ([ordered]@{ SchemaVersion = 1; GeneratedAtUtc = "2026-05-15T00:00:00Z"; CandidateCount = 0; Candidates = @() })
Write-JsonLines -Path $globalExpiryEventsPath -Items @(
    (New-SessionEvent -EventId "global-expiry-01" -ObservedAtUtc "2026-03-10T08:00:00Z" -Result "success" -FollowUpNeeded $false -PolicyVersionApplied "repo:gpcguard:verification_loop_hints:strict@active-v1" -AuthoritativeSuccessLabel "success" -Project "GPCGuard" -TaskCategory "backend")
)
$globalExpirySummary = Invoke-PowershellJson -ScriptPath $activatorPath -Arguments @(
    "-Root", $Root, "-OutputRoot", $globalExpiryRoot, "-CandidatePath", $globalExpiryCandidatePath, "-NormalizedEventsPath", $globalExpiryEventsPath, "-CurrentTimeUtc", "2026-05-15T00:00:00Z", "-Format", "json"
)
Assert-Equal -Label "global expiry count" -Expected 1 -Actual $globalExpirySummary.ExpiredCount
Assert-True -Label "global policy removed after expiry" -Condition (-not (Test-Path -LiteralPath (Join-Path $globalExpiryRoot "active\global-policy.json")))
Assert-True -Label "repo policy preserved after global expiry" -Condition (Test-Path -LiteralPath (Join-Path $globalExpiryRoot "active\repos\GPCGuard.json"))

Write-Host "activate-local-policies regression tests passed." -ForegroundColor Cyan
