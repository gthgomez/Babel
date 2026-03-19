[CmdletBinding()]
param(
    [string]$CandidatePath = "",

    [string]$NormalizedEventsPath = "",

    [string]$OutputRoot = "",

    [string]$CurrentTimeUtc = "",

    [ValidateSet("text", "json")]
    [string]$Format = "text",

    [string]$Root = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($Root)) {
    $scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Path $PSCommandPath -Parent }
    $Root = (Resolve-Path (Join-Path $scriptDir "..")).Path
} else {
    $Root = (Resolve-Path $Root).Path
}

if ([string]::IsNullOrWhiteSpace($OutputRoot)) {
    $OutputRoot = Join-Path $Root "runs\local-learning"
} elseif (-not [System.IO.Path]::IsPathRooted($OutputRoot)) {
    $OutputRoot = Join-Path $Root $OutputRoot
}

if ([string]::IsNullOrWhiteSpace($CandidatePath)) {
    $CandidatePath = Join-Path $OutputRoot "derived\policy-candidates.json"
} elseif (-not [System.IO.Path]::IsPathRooted($CandidatePath)) {
    $CandidatePath = Join-Path $Root $CandidatePath
}

if ([string]::IsNullOrWhiteSpace($NormalizedEventsPath)) {
    $NormalizedEventsPath = Join-Path $OutputRoot "derived\normalized-events.jsonl"
} elseif (-not [System.IO.Path]::IsPathRooted($NormalizedEventsPath)) {
    $NormalizedEventsPath = Join-Path $Root $NormalizedEventsPath
}

if (-not (Test-Path -LiteralPath $CandidatePath)) {
    throw "Policy candidate file not found: $CandidatePath"
}

if (-not (Test-Path -LiteralPath $NormalizedEventsPath)) {
    throw "Normalized events file not found: $NormalizedEventsPath"
}

$evaluationTime = if ([string]::IsNullOrWhiteSpace($CurrentTimeUtc)) {
    [DateTimeOffset]::UtcNow
} else {
    [DateTimeOffset]::Parse($CurrentTimeUtc)
}
$generatedAtUtc = $evaluationTime.UtcDateTime.ToString("o")

function Normalize-StringArray {
    param(
        [AllowNull()]
        [object[]]$Items
    )

    $values = New-Object System.Collections.Generic.List[string]
    $seen = @{}

    foreach ($item in @($Items)) {
        if ($null -eq $item) {
            continue
        }

        $text = [string]$item
        if ([string]::IsNullOrWhiteSpace($text)) {
            continue
        }

        $normalized = $text.Trim()
        if (-not $seen.ContainsKey($normalized)) {
            $seen[$normalized] = $true
            $values.Add($normalized)
        }
    }

    return @($values)
}

function Read-JsonFile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    return (Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json)
}

function Get-NormalizedPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    return [System.IO.Path]::GetFullPath($Path)
}

function Convert-ToRate {
    param(
        [int]$Numerator,
        [int]$Denominator
    )

    if ($Denominator -le 0) {
        return 0
    }

    return [Math]::Round(($Numerator / $Denominator), 4)
}

function Get-PolicySignature {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Policy
    )

    $policyId = [string]$Policy.policy_id
    $policyVersion = [string]$Policy.policy_version
    if ([string]::IsNullOrWhiteSpace($policyVersion)) {
        return $policyId
    }

    return "{0}@{1}" -f $policyId, $policyVersion
}

function Get-EventObservedAt {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Event
    )

    return [DateTimeOffset]::Parse([string]$Event.observed_at_utc)
}

function Get-PolicyScopeEvents {
    param(
        [Parameter(Mandatory = $true)]
        [object[]]$Events,

        [Parameter(Mandatory = $true)]
        [object]$Policy
    )

    $scopeType = [string]$Policy.scope_type
    $scopeKey = [string]$Policy.scope_key

    switch ($scopeType) {
        "local_client" {
            $parts = $scopeKey.Split("|")
            $clientSurface = if ($parts.Count -gt 0) { $parts[0] } else { "" }
            $model = if ($parts.Count -gt 1) { $parts[1] } else { "" }
            return @(
                $Events |
                    Where-Object {
                        ([string]$_.client_surface).ToLowerInvariant() -eq $clientSurface.ToLowerInvariant() -and
                        ([string]$_.model).ToLowerInvariant() -eq $model.ToLowerInvariant()
                    }
            )
        }
        "repo" {
            return @(
                $Events |
                    Where-Object { ([string]$_.project).ToLowerInvariant() -eq $scopeKey.ToLowerInvariant() }
            )
        }
        "global" {
            $supportingRepos = if ($null -ne $Policy.PSObject.Properties["supporting_repos"]) {
                @(Normalize-StringArray -Items @($Policy.supporting_repos))
            } else {
                @()
            }
            $policyId = [string]$Policy.policy_id
            $policySignature = Get-PolicySignature -Policy $Policy
            return @(
                $Events |
                    Where-Object {
                        $project = [string]$_.project
                        $projectMatched = (@($supportingRepos) -contains $project)
                        $appliedTokens = @(Get-PolicyAppliedTokens -Event $_)
                        $policyMatched = $false
                        foreach ($token in $appliedTokens) {
                            if ($token -eq $policyId -or $token -eq $policySignature -or $token.StartsWith($policyId + "@")) {
                                $policyMatched = $true
                                break
                            }
                        }
                        return ($projectMatched -or $policyMatched)
                    }
            )
        }
        default {
            return @()
        }
    }
}

function Test-StackOverride {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Event
    )

    $selected = @(Normalize-StringArray -Items @($Event.selected_stack_ids))
    $recommended = @(Normalize-StringArray -Items @($Event.recommended_stack_ids))

    if ($selected.Count -eq 0 -or $recommended.Count -eq 0) {
        return $false
    }

    if ($selected.Count -ne $recommended.Count) {
        return $true
    }

    foreach ($item in $selected) {
        if ($recommended -notcontains $item) {
            return $true
        }
    }

    return $false
}

function Get-Metrics {
    param(
        [AllowNull()]
        [object[]]$Events
    )

    $eventArray = @($Events)
    $successCount = 0
    $failedCount = 0
    $followUpCount = 0
    $overrideCount = 0
    $comparisonWinCount = 0

    foreach ($event in $eventArray) {
        if ([string]$event.authoritative_success_label -eq "success") {
            $successCount++
        }

        if ([string]$event.authoritative_success_label -eq "failed") {
            $failedCount++
        }

        if ($event.follow_up_needed -eq $true) {
            $followUpCount++
        }

        if (Test-StackOverride -Event $event) {
            $overrideCount++
        }

        if (@($event.positive_signals) -contains "comparison_winner") {
            $comparisonWinCount++
        }
    }

    return [ordered]@{
        applicable_event_count = $eventArray.Count
        success_rate = Convert-ToRate -Numerator $successCount -Denominator $eventArray.Count
        failed_rate = Convert-ToRate -Numerator $failedCount -Denominator $eventArray.Count
        follow_up_rate = Convert-ToRate -Numerator $followUpCount -Denominator $eventArray.Count
        stack_override_rate = Convert-ToRate -Numerator $overrideCount -Denominator $eventArray.Count
        comparison_win_rate = Convert-ToRate -Numerator $comparisonWinCount -Denominator $eventArray.Count
    }
}

function Get-PolicyAppliedTokens {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Event
    )

    $applied = [string]$Event.policy_version_applied
    if ([string]::IsNullOrWhiteSpace($applied)) {
        return @()
    }

    return @(
        Normalize-StringArray -Items @(
            $applied.Split(";", [System.StringSplitOptions]::RemoveEmptyEntries) |
                ForEach-Object { [string]$_ }
        )
    )
}

function Test-PolicyMatch {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Event,

        [Parameter(Mandatory = $true)]
        [object]$Policy
    )

    $policyId = [string]$Policy.policy_id
    $policySignature = Get-PolicySignature -Policy $Policy

    foreach ($token in @(Get-PolicyAppliedTokens -Event $Event)) {
        if ($token -eq $policyId -or $token -eq $policySignature -or $token.StartsWith($policyId + "@")) {
            return $true
        }
    }

    return $false
}

function New-AuditRecord {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RecordedAtUtc,

        [Parameter(Mandatory = $true)]
        [object]$Policy,

        [Parameter(Mandatory = $true)]
        [string]$Decision,

        [AllowNull()]
        [string[]]$Reasons = @(),

        [AllowNull()]
        [string[]]$TriggeringEventIds = @()
    )

    $record = [ordered]@{
        schema_version = 1
        recorded_at_utc = $RecordedAtUtc
        policy_id = [string]$Policy.policy_id
        policy_version = [string]$Policy.policy_version
        scope_type = [string]$Policy.scope_type
        scope_key = [string]$Policy.scope_key
        target_surface = [string]$Policy.target_surface
        decision = $Decision
        reasons = @(Normalize-StringArray -Items $Reasons)
        triggering_event_ids = @(Normalize-StringArray -Items $TriggeringEventIds)
    }

    if ([string]$Policy.scope_type -eq "global") {
        if ($null -ne $Policy.PSObject.Properties["source_scoped_policy_ids"]) {
            $record["source_scoped_policy_ids"] = @(Normalize-StringArray -Items @($Policy.source_scoped_policy_ids))
        }
        if ($null -ne $Policy.PSObject.Properties["supporting_repos"]) {
            $record["supporting_repos"] = @(Normalize-StringArray -Items @($Policy.supporting_repos))
        }
        if ($null -ne $Policy.PSObject.Properties["supporting_event_ids"]) {
            $record["supporting_event_ids"] = @(Normalize-StringArray -Items @($Policy.supporting_event_ids))
        }
        if ($null -ne $Policy.PSObject.Properties["conflict_detection_result"]) {
            $record["conflict_detection_result"] = [string]$Policy.conflict_detection_result
        }
        if ($null -ne $Policy.PSObject.Properties["regression_check_result"]) {
            $record["regression_check_result"] = [string]$Policy.regression_check_result
        }
    }

    return $record
}

function Get-ScopeFilePath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RootPath,

        [Parameter(Mandatory = $true)]
        [string]$ScopeType,

        [Parameter(Mandatory = $true)]
        [string]$ScopeKey
    )

    switch ($ScopeType) {
        "local_client" {
            $parts = $ScopeKey.Split("|")
            return Join-Path $RootPath ("active\local-clients\" + $parts[0] + "." + $parts[1] + ".json")
        }
        "repo" {
            return Join-Path $RootPath ("active\repos\" + $ScopeKey + ".json")
        }
        "global" {
            return Join-Path $RootPath "active\global-policy.json"
        }
        default {
            throw "Unsupported scope type for file path: $ScopeType"
        }
    }
}

function Add-PolicyToScopeMap {
    param(
        [Parameter(Mandatory = $true)]
        [hashtable]$Map,

        [Parameter(Mandatory = $true)]
        [object]$Policy
    )

    $scopeKey = [string]$Policy.scope_key
    if (-not $Map.ContainsKey($scopeKey)) {
        $Map[$scopeKey] = New-Object System.Collections.Generic.List[object]
    }

    $Map[$scopeKey].Add($Policy)
    return $Map
}

function Copy-Policy {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Policy
    )

    return (($Policy | ConvertTo-Json -Depth 12) | ConvertFrom-Json)
}

function Get-ExistingActivePolicies {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RootPath
    )

    $policies = New-Object System.Collections.Generic.List[object]
    $containerFiles = New-Object System.Collections.Generic.List[string]

    foreach ($path in @(
        Join-Path $RootPath "active\local-clients"
        Join-Path $RootPath "active\repos"
    )) {
        if (-not (Test-Path -LiteralPath $path)) {
            continue
        }

        foreach ($file in @(Get-ChildItem -LiteralPath $path -File)) {
            $containerFiles.Add($file.FullName)
        }
    }

    $globalPolicyPath = Join-Path $RootPath "active\global-policy.json"
    if (Test-Path -LiteralPath $globalPolicyPath) {
        $containerFiles.Add($globalPolicyPath)
    }

    foreach ($containerPath in @($containerFiles.ToArray())) {
        $container = Read-JsonFile -Path $containerPath
        foreach ($policy in @($container.policies)) {
            if ([string]$policy.state -eq "active") {
                $policies.Add($policy)
            }
        }
    }

    return @($policies.ToArray())
}

function Test-PolicyExpired {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Policy,

        [Parameter(Mandatory = $true)]
        [object[]]$ScopeEvents,

        [Parameter(Mandatory = $true)]
        [DateTimeOffset]$Now
    )

    $appliedEvents = @(
        $ScopeEvents |
            Where-Object { Test-PolicyMatch -Event $_ -Policy $Policy } |
            Sort-Object { Get-EventObservedAt -Event $_ }
    )

    $expiryDays = 30
    $expiryRuns = 25
    if ($null -ne $Policy.expiry_policy) {
        if ($null -ne $Policy.expiry_policy.reconfirm_after_days) {
            $expiryDays = [int]$Policy.expiry_policy.reconfirm_after_days
        }
        if ($null -ne $Policy.expiry_policy.reconfirm_after_applicable_runs) {
            $expiryRuns = [int]$Policy.expiry_policy.reconfirm_after_applicable_runs
        }
    }

    $activatedAtText = [string]$Policy.activated_at_utc
    if ([string]::IsNullOrWhiteSpace($activatedAtText)) {
        $activatedAtText = [string]$Policy.updated_at_utc
    }

    $expiredReasons = New-Object System.Collections.Generic.List[string]
    if (-not [string]::IsNullOrWhiteSpace($activatedAtText)) {
        $activatedAt = [DateTimeOffset]::Parse($activatedAtText)
        if (($Now - $activatedAt).TotalDays -ge $expiryDays) {
            $expiredReasons.Add("expiry_days_elapsed")
        }
    }

    if ($appliedEvents.Count -ge $expiryRuns) {
        $expiredReasons.Add("expiry_applicable_run_limit")
    }

    return [PSCustomObject]@{
        ShouldExpire = ($expiredReasons.Count -gt 0)
        Reasons = @($expiredReasons.ToArray())
        AppliedEventIds = @($appliedEvents | ForEach-Object { [string]$_.event_id })
    }
}

function Test-PolicyRollback {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Policy,

        [Parameter(Mandatory = $true)]
        [object[]]$ScopeEvents
    )

    $appliedEvents = @(
        $ScopeEvents |
            Where-Object { Test-PolicyMatch -Event $_ -Policy $Policy } |
            Sort-Object { Get-EventObservedAt -Event $_ }
    )

    $rollbackReasons = New-Object System.Collections.Generic.List[string]
    $triggeringEventIds = New-Object System.Collections.Generic.List[string]

    $firstFive = @($appliedEvents | Select-Object -First 5)
    $firstFiveHardFails = @($firstFive | Where-Object { [string]$_.authoritative_success_label -eq "failed" })
    if ($firstFiveHardFails.Count -ge 2) {
        $rollbackReasons.Add("rollback_first_five_hard_failures")
        foreach ($event in $firstFiveHardFails) {
            $triggeringEventIds.Add([string]$event.event_id)
        }
    }

    $lastTen = @($appliedEvents | Select-Object -Last 10)
    if ($lastTen.Count -ge 10) {
        $baselineMetrics = $Policy.baseline_metrics
        $trailingMetrics = Get-Metrics -Events $lastTen

        if (($baselineMetrics.success_rate - $trailingMetrics.success_rate) -gt 0.05) {
            $rollbackReasons.Add("rollback_success_rate_regressed")
        }
        if (($trailingMetrics.follow_up_rate - $baselineMetrics.follow_up_rate) -gt 0.05) {
            $rollbackReasons.Add("rollback_follow_up_rate_regressed")
        }
        if (($trailingMetrics.stack_override_rate - $baselineMetrics.stack_override_rate) -gt 0.05) {
            $rollbackReasons.Add("rollback_stack_override_rate_regressed")
        }
        if (($baselineMetrics.comparison_win_rate - $trailingMetrics.comparison_win_rate) -gt 0.05) {
            $rollbackReasons.Add("rollback_comparison_win_rate_regressed")
        }

        if ($rollbackReasons.Count -gt 0 -and $triggeringEventIds.Count -eq 0) {
            foreach ($event in $lastTen) {
                $triggeringEventIds.Add([string]$event.event_id)
            }
        }
    }

    return [PSCustomObject]@{
        ShouldRollback = ($rollbackReasons.Count -gt 0)
        Reasons = @($rollbackReasons.ToArray())
        TriggeringEventIds = @(Normalize-StringArray -Items $triggeringEventIds.ToArray())
    }
}

function Test-BootstrapActivation {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Policy,

        [Parameter(Mandatory = $true)]
        [object[]]$ScopeEvents
    )

    $supportingEventIds = @(Normalize-StringArray -Items @($Policy.supporting_event_ids))
    if ($supportingEventIds.Count -lt 3) {
        return $false
    }

    $supportingEvents = @(
        $ScopeEvents |
            Where-Object { $supportingEventIds -contains [string]$_.event_id } |
            Sort-Object { Get-EventObservedAt -Event $_ }
    )
    $supportingDays = @(
        $supportingEvents |
            ForEach-Object { (Get-EventObservedAt -Event $_).UtcDateTime.ToString("yyyy-MM-dd") } |
            Select-Object -Unique
    )
    if ($supportingDays.Count -lt 2) {
        return $false
    }

    $recentApplicableEvents = @(
        $ScopeEvents |
            Sort-Object { Get-EventObservedAt -Event $_ } -Descending |
            Select-Object -First 5
    )
    $hardFailCount = @($recentApplicableEvents | Where-Object { [string]$_.authoritative_success_label -eq "failed" }).Count
    if ($hardFailCount -gt 0) {
        return $false
    }

    return $true
}

function Test-GlobalCandidateActivation {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Policy,

        [Parameter(Mandatory = $true)]
        [object[]]$Events,

        [Parameter(Mandatory = $true)]
        [hashtable]$ExistingById
    )

    $reasons = New-Object System.Collections.Generic.List[string]
    $supportingRepos = if ($null -ne $Policy.PSObject.Properties["supporting_repos"]) {
        @(Normalize-StringArray -Items @($Policy.supporting_repos))
    } else {
        @()
    }
    $sourcePolicyIds = if ($null -ne $Policy.PSObject.Properties["source_scoped_policy_ids"]) {
        @(Normalize-StringArray -Items @($Policy.source_scoped_policy_ids))
    } else {
        @()
    }
    $supportingEventIds = if ($null -ne $Policy.PSObject.Properties["supporting_event_ids"]) {
        @(Normalize-StringArray -Items @($Policy.supporting_event_ids))
    } else {
        @()
    }
    $hardFailEventIds = if ($null -ne $Policy.PSObject.Properties["hard_fail_event_ids"]) {
        @(Normalize-StringArray -Items @($Policy.hard_fail_event_ids))
    } else {
        @()
    }

    if (@($supportingRepos).Count -lt 3) {
        $reasons.Add("insufficient_source_repos")
    }

    if (@($sourcePolicyIds).Count -lt 3) {
        $reasons.Add("insufficient_source_scoped_policies")
    }

    $sourcePolicies = @(
        $sourcePolicyIds |
            ForEach-Object {
                if ($ExistingById.ContainsKey($_)) {
                    $ExistingById[$_]
                }
            } |
            Where-Object { $null -ne $_ -and [string]$_.state -eq "active" }
    )

    $distinctSourceRepos = @(
        $sourcePolicies |
            Where-Object { [string]$_.scope_type -eq "repo" } |
            ForEach-Object { [string]$_.scope_key } |
            Select-Object -Unique |
            Sort-Object
    )

    if (@($distinctSourceRepos).Count -lt 3) {
        $reasons.Add("source_repo_verification_missing")
    }

    $supportingEvents = @(
        $Events |
            Where-Object { $supportingEventIds -contains [string]$_.event_id }
    )

    $distinctSupportingProjects = @(
        $supportingEvents |
            ForEach-Object { [string]$_.project } |
            Where-Object { -not [string]::IsNullOrWhiteSpace($_) -and $_ -ne "global" } |
            Select-Object -Unique |
            Sort-Object
    )

    if (@($distinctSupportingProjects).Count -lt 3) {
        $reasons.Add("cross_repo_support_not_verified")
    }

    if (@($supportingEvents | Where-Object { [string]$_.authoritative_success_label -eq "failed" }).Count -gt 0) {
        $reasons.Add("cross_repo_regression_detected")
    }

    if (@($hardFailEventIds).Count -gt 0) {
        $reasons.Add("cross_repo_regression_detected")
    }

    $existingRegressionResult = if ($null -ne $Policy.PSObject.Properties["regression_check_result"]) {
        [string]$Policy.regression_check_result
    } else {
        ""
    }
    if ($existingRegressionResult -like "*regression*" -and $existingRegressionResult -notlike "pending*") {
        $reasons.Add("cross_repo_regression_detected")
    }

    $conflictResult = if ($null -ne $Policy.PSObject.Properties["conflict_detection_result"]) {
        [string]$Policy.conflict_detection_result
    } else {
        ""
    }
    if (-not [string]::IsNullOrWhiteSpace($conflictResult) -and $conflictResult -ne "none") {
        $reasons.Add("repo_policy_conflict_detected")
    }

    if ([bool]$Policy.requires_human_review) {
        $reasons.Add("candidate_requires_human_review")
    }

    $verificationMetrics = Get-Metrics -Events $supportingEvents
    $regressionCheckResult = if (@($reasons.ToArray()) -contains "cross_repo_regression_detected") {
        "cross_repo_regression_detected"
    } else {
        "verified_no_cross_repo_regression"
    }

    return [PSCustomObject]@{
        CanActivate = ($reasons.Count -eq 0)
        Reasons = @($reasons.ToArray() | Select-Object -Unique)
        SupportingEvents = $supportingEvents
        VerificationMetrics = $verificationMetrics
        RegressionCheckResult = $regressionCheckResult
    }
}

function Convert-CandidateToActivePolicy {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Policy,

        [Parameter(Mandatory = $true)]
        [string]$GeneratedAtUtc,

        [Parameter(Mandatory = $true)]
        [object]$BaselineMetrics,

        [Parameter(Mandatory = $true)]
        [object]$TreatmentMetrics,

        [AllowNull()]
        [AllowEmptyCollection()]
        [object[]]$TreatmentEvents = @(),

        [Parameter(Mandatory = $true)]
        [string]$ActivationMode
    )

    $activePolicy = [ordered]@{}
    foreach ($property in $Policy.PSObject.Properties) {
        $activePolicy[$property.Name] = $property.Value
    }

    $activePolicy["state"] = "active"
    $activePolicy["policy_version"] = "active-v1"
    $activePolicy["updated_at_utc"] = $GeneratedAtUtc
    $activePolicy["activated_at_utc"] = $GeneratedAtUtc
    $activePolicy["baseline_metrics"] = $BaselineMetrics
    $activePolicy["treatment_metrics"] = $TreatmentMetrics
    $activePolicy["activation_mode"] = $ActivationMode
    $treatmentEventArray = @($TreatmentEvents)
    $treatmentEventCount = @($treatmentEventArray | Measure-Object)[0].Count
    $treatmentEventIds = @(
        $treatmentEventArray |
            Where-Object { $null -ne $_ -and $null -ne $_.PSObject.Properties["event_id"] } |
            ForEach-Object { [string]$_.event_id }
    )
    $activePolicy["treatment_window"] = [ordered]@{
        activated_at_utc = $GeneratedAtUtc
        treatment_event_count = $treatmentEventCount
        event_ids = $treatmentEventIds
    }

    return ([PSCustomObject]$activePolicy)
}

$allowlist = @(
    "resolver_ranking",
    "kickoff_prompt_preset",
    "overlay_recommendation_order",
    "retry_heuristics",
    "verification_loop_hints",
    "client_surface_defaults"
)

$summaryObject = Read-JsonFile -Path $CandidatePath
$candidates = @($summaryObject.Candidates)
$candidateById = @{}
foreach ($candidate in $candidates) {
    $candidateById[[string]$candidate.policy_id] = $candidate
}

$events = @(
    Get-Content -LiteralPath $NormalizedEventsPath |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
        ForEach-Object { $_ | ConvertFrom-Json }
)

$existingActivePolicies = @(Get-ExistingActivePolicies -RootPath $OutputRoot)
$existingById = @{}
foreach ($policy in $existingActivePolicies) {
    $existingById[[string]$policy.policy_id] = $policy
}

$nextLocalClient = @{}
$nextRepos = @{}
$nextGlobalPolicies = New-Object System.Collections.Generic.List[object]
$evaluatedPolicyIds = New-Object System.Collections.Generic.HashSet[string]
$auditLines = New-Object System.Collections.Generic.List[string]
$activated = New-Object System.Collections.Generic.List[object]
$carriedForward = New-Object System.Collections.Generic.List[object]
$rolledBack = New-Object System.Collections.Generic.List[object]
$expired = New-Object System.Collections.Generic.List[object]
$bootstrapActivated = New-Object System.Collections.Generic.List[object]

foreach ($policy in $candidates) {
    $policyId = [string]$policy.policy_id
    $null = $evaluatedPolicyIds.Add($policyId)
    $reasons = New-Object System.Collections.Generic.List[string]
    $existingPolicy = if ($existingById.ContainsKey($policyId)) { $existingById[$policyId] } else { $null }
    $canActivate = $true

    if (@("local_client", "repo", "global") -notcontains [string]$policy.scope_type) {
        $reasons.Add("scope_not_supported_for_phase3")
        $canActivate = $false
    }

    if ($allowlist -notcontains [string]$policy.target_surface) {
        $reasons.Add("target_surface_not_allowlisted")
        $canActivate = $false
    }

    if (-not $canActivate) {
        if ($null -ne $existingPolicy) {
            $carriedForward.Add($existingPolicy)
            switch ([string]$existingPolicy.scope_type) {
                "local_client" {
                    $nextLocalClient = Add-PolicyToScopeMap -Map $nextLocalClient -Policy $existingPolicy
                }
                "repo" {
                    $nextRepos = Add-PolicyToScopeMap -Map $nextRepos -Policy $existingPolicy
                }
                "global" {
                    $nextGlobalPolicies.Add($existingPolicy)
                }
                default {
                    throw "Unsupported carried-forward policy scope type: $([string]$existingPolicy.scope_type)"
                }
            }
            $auditLines.Add(((New-AuditRecord -RecordedAtUtc $generatedAtUtc -Policy $existingPolicy -Decision "carried_forward" -Reasons $reasons.ToArray()) | ConvertTo-Json -Depth 8 -Compress))
        } else {
            $auditLines.Add(((New-AuditRecord -RecordedAtUtc $generatedAtUtc -Policy $policy -Decision "skipped" -Reasons $reasons.ToArray()) | ConvertTo-Json -Depth 8 -Compress))
        }
        continue
    }

    $scopeEvents = @(Get-PolicyScopeEvents -Events $events -Policy $policy)
    $matchedEvents = @($scopeEvents | Where-Object { Test-PolicyMatch -Event $_ -Policy $policy })
    $baselineEvents = @($scopeEvents | Where-Object { -not (Test-PolicyMatch -Event $_ -Policy $policy) })
    $treatmentEvents = @($matchedEvents)
    $baselineMetrics = Get-Metrics -Events $baselineEvents
    $treatmentMetrics = Get-Metrics -Events $treatmentEvents

    $rollbackDecision = if ($null -ne $existingPolicy) {
        Test-PolicyRollback -Policy $existingPolicy -ScopeEvents $scopeEvents
    } else {
        [PSCustomObject]@{ ShouldRollback = $false; Reasons = @(); TriggeringEventIds = @() }
    }
    if ($rollbackDecision.ShouldRollback) {
        $rolledBack.Add($existingPolicy)
        $auditLines.Add(((New-AuditRecord -RecordedAtUtc $generatedAtUtc -Policy $existingPolicy -Decision "rollback" -Reasons $rollbackDecision.Reasons -TriggeringEventIds $rollbackDecision.TriggeringEventIds) | ConvertTo-Json -Depth 8 -Compress))
        continue
    }

    $expiryDecision = if ($null -ne $existingPolicy) {
        Test-PolicyExpired -Policy $existingPolicy -ScopeEvents $scopeEvents -Now $evaluationTime
    } else {
        [PSCustomObject]@{ ShouldExpire = $false; Reasons = @(); AppliedEventIds = @() }
    }
    if ($expiryDecision.ShouldExpire) {
        $expired.Add($existingPolicy)
        $auditLines.Add(((New-AuditRecord -RecordedAtUtc $generatedAtUtc -Policy $existingPolicy -Decision "expired" -Reasons $expiryDecision.Reasons -TriggeringEventIds $expiryDecision.AppliedEventIds) | ConvertTo-Json -Depth 8 -Compress))
        continue
    }

    if ([string]$policy.state -ne "shadow") {
        $reasons.Add("candidate_not_in_shadow")
        $canActivate = $false
    }

    if ([string]$policy.scope_type -eq "global") {
        $globalActivation = Test-GlobalCandidateActivation -Policy $policy -Events $events -ExistingById $existingById
        foreach ($reason in @($globalActivation.Reasons)) {
            $reasons.Add([string]$reason)
        }
        $canActivate = ($canActivate -and $globalActivation.CanActivate)

        if ($canActivate) {
            $activePolicy = Convert-CandidateToActivePolicy `
                -Policy $policy `
                -GeneratedAtUtc $generatedAtUtc `
                -BaselineMetrics $policy.baseline_metrics `
                -TreatmentMetrics $globalActivation.VerificationMetrics `
                -TreatmentEvents @($globalActivation.SupportingEvents) `
                -ActivationMode "cross_repo_verified"

            if ($null -ne $activePolicy.PSObject.Properties["regression_check_result"]) {
                $activePolicy.regression_check_result = $globalActivation.RegressionCheckResult
            } else {
                $activePolicy | Add-Member -NotePropertyName "regression_check_result" -NotePropertyValue $globalActivation.RegressionCheckResult
            }
            $activated.Add($activePolicy)

            switch ([string]$activePolicy.scope_type) {
                "global" {
                    $nextGlobalPolicies.Add($activePolicy)
                }
                default {
                    throw "Unsupported activated policy scope type: $([string]$activePolicy.scope_type)"
                }
            }

            $auditLines.Add(((New-AuditRecord -RecordedAtUtc $generatedAtUtc -Policy $activePolicy -Decision "active" -Reasons @("activation_gate_passed", "cross_repo_verified") -TriggeringEventIds @($globalActivation.SupportingEvents | ForEach-Object { [string]$_.event_id })) | ConvertTo-Json -Depth 8 -Compress))
            continue
        }

        if ($null -ne $existingPolicy) {
            $carriedForward.Add($existingPolicy)
            switch ([string]$existingPolicy.scope_type) {
                "global" {
                    $nextGlobalPolicies.Add($existingPolicy)
                }
                default {
                    throw "Unsupported carried-forward policy scope type: $([string]$existingPolicy.scope_type)"
                }
            }
            $auditLines.Add(((New-AuditRecord -RecordedAtUtc $generatedAtUtc -Policy $existingPolicy -Decision "carried_forward" -Reasons $(if ($reasons.Count -gt 0) { $reasons.ToArray() } else { @("existing_active_policy_preserved") })) | ConvertTo-Json -Depth 8 -Compress))
        } else {
            $auditLines.Add(((New-AuditRecord -RecordedAtUtc $generatedAtUtc -Policy $policy -Decision "skipped" -Reasons $reasons.ToArray()) | ConvertTo-Json -Depth 8 -Compress))
        }
        continue
    }

    if ($scopeEvents.Count -lt 8) {
        $reasons.Add("not_enough_applicable_events")
        $canActivate = $false
    }

    $treatmentHardFails = @($treatmentEvents | Where-Object { [string]$_.authoritative_success_label -eq "failed" })
    if ($treatmentHardFails.Count -gt 0) {
        $reasons.Add("hard_fail_in_treatment_window")
        $canActivate = $false
    }

    $successImproved = ([double]$treatmentMetrics.success_rate -gt [double]$baselineMetrics.success_rate)
    $followUpImproved = ([double]$treatmentMetrics.follow_up_rate -lt [double]$baselineMetrics.follow_up_rate)
    $overrideImproved = ([double]$treatmentMetrics.stack_override_rate -lt [double]$baselineMetrics.stack_override_rate)
    $comparisonImproved = ([double]$treatmentMetrics.comparison_win_rate -gt [double]$baselineMetrics.comparison_win_rate)

    $regressed = $false
    if (([double]$baselineMetrics.success_rate - [double]$treatmentMetrics.success_rate) -gt 0.05) {
        $reasons.Add("success_rate_regressed")
        $regressed = $true
    }
    if (([double]$treatmentMetrics.follow_up_rate - [double]$baselineMetrics.follow_up_rate) -gt 0.05) {
        $reasons.Add("follow_up_rate_regressed")
        $regressed = $true
    }
    if (([double]$treatmentMetrics.stack_override_rate - [double]$baselineMetrics.stack_override_rate) -gt 0.05) {
        $reasons.Add("stack_override_rate_regressed")
        $regressed = $true
    }
    if (([double]$baselineMetrics.comparison_win_rate - [double]$treatmentMetrics.comparison_win_rate) -gt 0.05) {
        $reasons.Add("comparison_win_rate_regressed")
        $regressed = $true
    }
    if ($regressed) {
        $canActivate = $false
    }

    $activationMode = ""
    if ($treatmentEvents.Count -ge 2) {
        if (-not ($successImproved -or $followUpImproved -or $overrideImproved -or $comparisonImproved)) {
            $reasons.Add("no_measurable_improvement")
            $canActivate = $false
        } else {
            $activationMode = "measured"
        }
    } else {
        $canActivate = $false
        if ($null -eq $existingPolicy -and (Test-BootstrapActivation -Policy $policy -ScopeEvents $scopeEvents)) {
            $activationMode = "bootstrap"
            $canActivate = $true
            $reasons.Add("bootstrap_from_shadow")
        } else {
            $reasons.Add("not_enough_treatment_runs")
        }
    }

    if ($canActivate) {
        $treatmentMetricsForActivation = if ($activationMode -eq "bootstrap") {
            [ordered]@{
                applicable_event_count = 0
                success_rate = 0
                failed_rate = 0
                follow_up_rate = 0
                stack_override_rate = 0
                comparison_win_rate = 0
            }
        } else {
            $treatmentMetrics
        }
        $activationTreatmentEvents = if ($activationMode -eq "bootstrap") {
            [object[]]@()
        } else {
            [object[]]@($treatmentEvents)
        }

        $activePolicy = Convert-CandidateToActivePolicy `
            -Policy $policy `
            -GeneratedAtUtc $generatedAtUtc `
            -BaselineMetrics $baselineMetrics `
            -TreatmentMetrics $treatmentMetricsForActivation `
            -TreatmentEvents $activationTreatmentEvents `
            -ActivationMode $activationMode

        $activated.Add($activePolicy)
        if ($activationMode -eq "bootstrap") {
            $bootstrapActivated.Add($activePolicy)
        }
        switch ([string]$activePolicy.scope_type) {
            "local_client" {
                $nextLocalClient = Add-PolicyToScopeMap -Map $nextLocalClient -Policy $activePolicy
            }
            "repo" {
                $nextRepos = Add-PolicyToScopeMap -Map $nextRepos -Policy $activePolicy
            }
            "global" {
                $nextGlobalPolicies.Add($activePolicy)
            }
            default {
                throw "Unsupported activated policy scope type: $([string]$activePolicy.scope_type)"
            }
        }
        $auditLines.Add(((New-AuditRecord -RecordedAtUtc $generatedAtUtc -Policy $activePolicy -Decision "active" -Reasons $(if ($activationMode -eq "bootstrap") { @("activation_gate_passed", "bootstrap_from_shadow") } else { @("activation_gate_passed") }) -TriggeringEventIds @($treatmentEvents | ForEach-Object { [string]$_.event_id })) | ConvertTo-Json -Depth 8 -Compress))
        continue
    }

    if ($null -ne $existingPolicy) {
        $carriedForward.Add($existingPolicy)
        switch ([string]$existingPolicy.scope_type) {
            "local_client" {
                $nextLocalClient = Add-PolicyToScopeMap -Map $nextLocalClient -Policy $existingPolicy
            }
            "repo" {
                $nextRepos = Add-PolicyToScopeMap -Map $nextRepos -Policy $existingPolicy
            }
            "global" {
                $nextGlobalPolicies.Add($existingPolicy)
            }
            default {
                throw "Unsupported carried-forward policy scope type: $([string]$existingPolicy.scope_type)"
            }
        }
        $auditLines.Add(((New-AuditRecord -RecordedAtUtc $generatedAtUtc -Policy $existingPolicy -Decision "carried_forward" -Reasons $(if ($reasons.Count -gt 0) { $reasons.ToArray() } else { @("existing_active_policy_preserved") })) | ConvertTo-Json -Depth 8 -Compress))
    } else {
        $auditLines.Add(((New-AuditRecord -RecordedAtUtc $generatedAtUtc -Policy $policy -Decision "skipped" -Reasons $reasons.ToArray()) | ConvertTo-Json -Depth 8 -Compress))
    }
}

foreach ($existingPolicy in $existingActivePolicies) {
    $policyId = [string]$existingPolicy.policy_id
    if ($evaluatedPolicyIds.Contains($policyId)) {
        continue
    }

    $scopeEvents = @(Get-PolicyScopeEvents -Events $events -Policy $existingPolicy)
    $rollbackDecision = Test-PolicyRollback -Policy $existingPolicy -ScopeEvents $scopeEvents
    if ($rollbackDecision.ShouldRollback) {
        $rolledBack.Add($existingPolicy)
        $auditLines.Add(((New-AuditRecord -RecordedAtUtc $generatedAtUtc -Policy $existingPolicy -Decision "rollback" -Reasons $rollbackDecision.Reasons -TriggeringEventIds $rollbackDecision.TriggeringEventIds) | ConvertTo-Json -Depth 8 -Compress))
        continue
    }

    $expiryDecision = Test-PolicyExpired -Policy $existingPolicy -ScopeEvents $scopeEvents -Now $evaluationTime
    if ($expiryDecision.ShouldExpire) {
        $expired.Add($existingPolicy)
        $auditLines.Add(((New-AuditRecord -RecordedAtUtc $generatedAtUtc -Policy $existingPolicy -Decision "expired" -Reasons $expiryDecision.Reasons -TriggeringEventIds $expiryDecision.AppliedEventIds) | ConvertTo-Json -Depth 8 -Compress))
        continue
    }

    $carriedForward.Add($existingPolicy)
    switch ([string]$existingPolicy.scope_type) {
        "local_client" {
            $nextLocalClient = Add-PolicyToScopeMap -Map $nextLocalClient -Policy $existingPolicy
        }
        "repo" {
            $nextRepos = Add-PolicyToScopeMap -Map $nextRepos -Policy $existingPolicy
        }
        "global" {
            $nextGlobalPolicies.Add($existingPolicy)
        }
        default {
            throw "Unsupported active policy scope type: $([string]$existingPolicy.scope_type)"
        }
    }
    $auditLines.Add(((New-AuditRecord -RecordedAtUtc $generatedAtUtc -Policy $existingPolicy -Decision "carried_forward" -Reasons @("active_policy_not_re_evaluated") ) | ConvertTo-Json -Depth 8 -Compress))
}

$finalPolicies = @(@($activated.ToArray()) + @($carriedForward.ToArray()))
$finalLocalClientPolicies = @($finalPolicies | Where-Object { [string]$_.scope_type -eq "local_client" })
$finalRepoPolicies = @($finalPolicies | Where-Object { [string]$_.scope_type -eq "repo" })
$finalGlobalPolicies = @($finalPolicies | Where-Object { [string]$_.scope_type -eq "global" })

$activeRoot = Join-Path $OutputRoot "active"
$localClientRoot = Join-Path $activeRoot "local-clients"
$repoRoot = Join-Path $activeRoot "repos"
$globalPolicyPath = Join-Path $activeRoot "global-policy.json"
New-Item -ItemType Directory -Force -Path $localClientRoot | Out-Null
New-Item -ItemType Directory -Force -Path $repoRoot | Out-Null

$writtenPaths = New-Object System.Collections.Generic.HashSet[string]

foreach ($policyGroup in @($finalLocalClientPolicies | Group-Object { [string]$_.scope_key })) {
    $scopeKey = [string]$policyGroup.Name
    $filePath = Get-ScopeFilePath -RootPath $OutputRoot -ScopeType "local_client" -ScopeKey $scopeKey
    $container = [ordered]@{
        schema_version = 1
        generated_at_utc = $generatedAtUtc
        scope_type = "local_client"
        scope_key = $scopeKey
        policies = @($policyGroup.Group)
    }
    $container | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $filePath -Encoding UTF8
    $null = $writtenPaths.Add((Get-NormalizedPath -Path $filePath))
}

foreach ($policyGroup in @($finalRepoPolicies | Group-Object { [string]$_.scope_key })) {
    $scopeKey = [string]$policyGroup.Name
    $filePath = Get-ScopeFilePath -RootPath $OutputRoot -ScopeType "repo" -ScopeKey $scopeKey
    $container = [ordered]@{
        schema_version = 1
        generated_at_utc = $generatedAtUtc
        scope_type = "repo"
        scope_key = $scopeKey
        policies = @($policyGroup.Group)
    }
    $container | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $filePath -Encoding UTF8
    $null = $writtenPaths.Add((Get-NormalizedPath -Path $filePath))
}

if ($finalGlobalPolicies.Count -gt 0) {
    $container = [ordered]@{
        schema_version = 1
        generated_at_utc = $generatedAtUtc
        scope_type = "global"
        scope_key = "global"
        policies = @($finalGlobalPolicies)
    }
    $container | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $globalPolicyPath -Encoding UTF8
    $null = $writtenPaths.Add((Get-NormalizedPath -Path $globalPolicyPath))
}

foreach ($existingPath in @(
    Get-ChildItem -LiteralPath $localClientRoot -File -ErrorAction SilentlyContinue |
        ForEach-Object { $_.FullName }
    Get-ChildItem -LiteralPath $repoRoot -File -ErrorAction SilentlyContinue |
        ForEach-Object { $_.FullName }
    if (Test-Path -LiteralPath $globalPolicyPath) { $globalPolicyPath }
)) {
    if (-not $writtenPaths.Contains((Get-NormalizedPath -Path ([string]$existingPath)))) {
        Remove-Item -LiteralPath $existingPath -Force -ErrorAction SilentlyContinue
    }
}

$auditPath = Join-Path $OutputRoot "derived\policy-audit.jsonl"
New-Item -ItemType Directory -Force -Path (Split-Path -Path $auditPath -Parent) | Out-Null
if ($auditLines.Count -gt 0) {
    Add-Content -LiteralPath $auditPath -Value $auditLines -Encoding UTF8
}

$summary = [ordered]@{
    SchemaVersion = 1
    GeneratedAtUtc = $generatedAtUtc
    CandidatePath = (Resolve-Path -LiteralPath $CandidatePath).Path
    NormalizedEventsPath = (Resolve-Path -LiteralPath $NormalizedEventsPath).Path
    OutputRoot = $OutputRoot
    ActivatedCount = $activated.Count
    BootstrapActivatedCount = $bootstrapActivated.Count
    CarryForwardCount = $carriedForward.Count
    RolledBackCount = $rolledBack.Count
    ExpiredCount = $expired.Count
    ActivatedPolicyIds = @($activated | ForEach-Object { [string]$_.policy_id })
    CarryForwardPolicyIds = @($carriedForward | ForEach-Object { [string]$_.policy_id })
    RolledBackPolicyIds = @($rolledBack | ForEach-Object { [string]$_.policy_id })
    ExpiredPolicyIds = @($expired | ForEach-Object { [string]$_.policy_id })
    LocalClientPolicyFiles = @(
        Get-ChildItem -LiteralPath $localClientRoot -File -ErrorAction SilentlyContinue |
            ForEach-Object { $_.FullName }
    )
    RepoPolicyFiles = @(
        Get-ChildItem -LiteralPath $repoRoot -File -ErrorAction SilentlyContinue |
            ForEach-Object { $_.FullName }
    )
    GlobalPolicyFiles = @(
        if (Test-Path -LiteralPath $globalPolicyPath) {
            $globalPolicyPath
        }
    )
}

if ($Format -eq "json") {
    $summary | ConvertTo-Json -Depth 8
    exit 0
}

Write-Host ""
Write-Host "Babel Local Policy Activation" -ForegroundColor Cyan
Write-Host "Activated policies: $($summary['ActivatedCount'])"
Write-Host "Bootstrap activations: $($summary['BootstrapActivatedCount'])"
Write-Host "Carried forward: $($summary['CarryForwardCount'])"
Write-Host "Rolled back: $($summary['RolledBackCount'])"
Write-Host "Expired: $($summary['ExpiredCount'])"
