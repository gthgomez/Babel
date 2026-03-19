[CmdletBinding()]
param(
    [string]$InputPath = "",

    [string]$OutputPath = "",

    [string]$AuditOutputPath = "",

    [ValidateSet("text", "json")]
    [string]$Format = "text",

    [int]$Top = 5,

    [string]$Root = "",

    [string]$ActivePoliciesRoot = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($Root)) {
    $scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Path $PSCommandPath -Parent }
    $Root = (Resolve-Path (Join-Path $scriptDir "..")).Path
} else {
    $Root = (Resolve-Path $Root).Path
}

if ([string]::IsNullOrWhiteSpace($InputPath)) {
    $InputPath = Join-Path $Root "runs\local-learning\derived\normalized-events.jsonl"
} elseif (-not [System.IO.Path]::IsPathRooted($InputPath)) {
    $InputPath = Join-Path $Root $InputPath
}

if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    $OutputPath = Join-Path $Root "runs\local-learning\derived\policy-candidates.json"
} elseif (-not [System.IO.Path]::IsPathRooted($OutputPath)) {
    $OutputPath = Join-Path $Root $OutputPath
}

if ([string]::IsNullOrWhiteSpace($AuditOutputPath)) {
    $AuditOutputPath = Join-Path $Root "runs\local-learning\derived\policy-audit.jsonl"
} elseif (-not [System.IO.Path]::IsPathRooted($AuditOutputPath)) {
    $AuditOutputPath = Join-Path $Root $AuditOutputPath
}

if ($Top -lt 1) {
    throw "Top must be at least 1."
}

if (-not (Test-Path -LiteralPath $InputPath)) {
    throw "Normalized events input not found: $InputPath"
}

function Normalize-KeyText {
    param(
        [AllowNull()]
        [object]$Value
    )

    $text = [string]$Value
    if ([string]::IsNullOrWhiteSpace($text)) {
        return ""
    }

    return $text.Trim().ToLowerInvariant()
}

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

function Get-TopCounts {
    param(
        [AllowNull()]
        [object[]]$Items,

        [int]$Take = 5
    )

    $counts = @{}

    foreach ($item in @($Items)) {
        if ($null -eq $item) {
            continue
        }

        $text = [string]$item
        if ([string]::IsNullOrWhiteSpace($text)) {
            continue
        }

        if ($counts.ContainsKey($text)) {
            $counts[$text]++
        } else {
            $counts[$text] = 1
        }
    }

    $rows = New-Object System.Collections.Generic.List[object]
    foreach ($key in $counts.Keys) {
        $rows.Add([PSCustomObject]@{
            Name = $key
            Count = [int]$counts[$key]
        })
    }

    return @(
        $rows |
            Sort-Object -Property Count, Name -Descending |
            Select-Object -First $Take
    )
}

function Get-EventArrayProperty {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Event,

        [Parameter(Mandatory = $true)]
        [string]$Name
    )

    return @(Normalize-StringArray -Items @($Event.$Name))
}

function Get-EventUtcDay {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Event
    )

    $timestamp = [string]$Event.observed_at_utc
    if ([string]::IsNullOrWhiteSpace($timestamp)) {
        return ""
    }

    return ([DateTimeOffset]::Parse($timestamp)).UtcDateTime.ToString("yyyy-MM-dd")
}

function Test-StackOverride {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Event
    )

    $selected = @(Get-EventArrayProperty -Event $Event -Name "selected_stack_ids")
    $recommended = @(Get-EventArrayProperty -Event $Event -Name "recommended_stack_ids")

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

function Test-EventHasAnyTag {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Event,

        [Parameter(Mandatory = $true)]
        [string[]]$Tags
    )

    $failureTags = @((Get-EventArrayProperty -Event $Event -Name "failure_tags") | ForEach-Object { Normalize-KeyText $_ })

    foreach ($tag in $Tags) {
        if ($failureTags -contains (Normalize-KeyText $tag)) {
            return $true
        }
    }

    return $false
}

function Get-Metrics {
    param(
        [AllowNull()]
        [object[]]$Events,

        [AllowNull()]
        [object[]]$SupportingEvents = @(),

        [AllowNull()]
        [object[]]$HardFailEvents = @()
    )

    $eventArray = @($Events)
    $supportArray = @($SupportingEvents)
    $hardFailArray = @($HardFailEvents)

    $successCount = 0
    $failedCount = 0
    $followUpCount = 0
    $overrideCount = 0
    $comparisonWinCount = 0
    $projects = New-Object System.Collections.Generic.List[string]
    $utcDays = New-Object System.Collections.Generic.List[string]

    foreach ($event in $eventArray) {
        $projects.Add([string]$event.project)
        $utcDays.Add((Get-EventUtcDay -Event $event))

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

        $signals = @(Get-EventArrayProperty -Event $event -Name "positive_signals")
        if ($signals -contains "comparison_winner") {
            $comparisonWinCount++
        }
    }

    $distinctProjects = @(Normalize-StringArray -Items $projects.ToArray() | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    $distinctDays = @(Normalize-StringArray -Items $utcDays.ToArray() | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })

    return [ordered]@{
        applicable_event_count = $eventArray.Count
        supporting_event_count = $supportArray.Count
        hard_fail_event_count = $hardFailArray.Count
        success_rate = Convert-ToRate -Numerator $successCount -Denominator $eventArray.Count
        failed_rate = Convert-ToRate -Numerator $failedCount -Denominator $eventArray.Count
        follow_up_rate = Convert-ToRate -Numerator $followUpCount -Denominator $eventArray.Count
        stack_override_rate = Convert-ToRate -Numerator $overrideCount -Denominator $eventArray.Count
        comparison_win_rate = Convert-ToRate -Numerator $comparisonWinCount -Denominator $eventArray.Count
        distinct_projects = @($distinctProjects)
        distinct_project_count = $distinctProjects.Count
        distinct_utc_days = @($distinctDays)
        distinct_utc_day_count = $distinctDays.Count
    }
}

function Get-BaselineWindow {
    param(
        [AllowNull()]
        [object[]]$Events
    )

    $eventArray = @($Events)
    $timestamps = @(
        $eventArray |
            Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_.observed_at_utc) } |
            ForEach-Object { [DateTimeOffset]::Parse([string]$_.observed_at_utc).UtcDateTime }
    )

    $firstObserved = $null
    $lastObserved = $null
    if ($timestamps.Count -gt 0) {
        $firstObserved = ($timestamps | Sort-Object | Select-Object -First 1).ToString("o")
        $lastObserved = ($timestamps | Sort-Object | Select-Object -Last 1).ToString("o")
    }

    return [ordered]@{
        first_observed_at_utc = $firstObserved
        last_observed_at_utc = $lastObserved
        event_count = $eventArray.Count
        distinct_utc_day_count = @(
            $eventArray |
                ForEach-Object { Get-EventUtcDay -Event $_ } |
                Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
                Select-Object -Unique
        ).Count
    }
}

function New-PolicyRecord {
    param(
        [Parameter(Mandatory = $true)]
        [string]$PolicyId,

        [Parameter(Mandatory = $true)]
        [string]$ScopeType,

        [Parameter(Mandatory = $true)]
        [string]$ScopeKey,

        [Parameter(Mandatory = $true)]
        [string]$TargetSurface,

        [Parameter(Mandatory = $true)]
        [string]$State,

        [Parameter(Mandatory = $true)]
        [string]$GeneratedAtUtc,

        [AllowNull()]
        [object]$BaselineWindow,

        [AllowNull()]
        [object]$TreatmentWindow = $null,

        [AllowNull()]
        [object[]]$SupportingEvents = @(),

        [AllowNull()]
        [object[]]$HardFailEvents = @(),

        [AllowNull()]
        [object]$BaselineMetrics,

        [AllowNull()]
        [object]$TreatmentMetrics = $null,

        [AllowNull()]
        [object]$ProposedChange,

        [AllowNull()]
        [string[]]$Reasons = @(),

        [AllowNull()]
        [object]$ShadowDecision = $null
    )

    $requiresHumanReview = ($State -eq "human_review")
    $expiryPolicy = if ($ScopeType -eq "global") {
        [ordered]@{
            reconfirm_after_days = 60
            reconfirm_after_applicable_runs = 100
        }
    } else {
        [ordered]@{
            reconfirm_after_days = 30
            reconfirm_after_applicable_runs = 25
        }
    }

    return [ordered]@{
        schema_version = 1
        policy_id = $PolicyId
        policy_version = "candidate-v1"
        scope_type = $ScopeType
        scope_key = $ScopeKey
        target_surface = $TargetSurface
        state = $State
        created_at_utc = $GeneratedAtUtc
        updated_at_utc = $GeneratedAtUtc
        baseline_window = $BaselineWindow
        treatment_window = $TreatmentWindow
        supporting_event_ids = @($SupportingEvents | ForEach-Object { [string]$_.event_id })
        hard_fail_event_ids = @($HardFailEvents | ForEach-Object { [string]$_.event_id })
        baseline_metrics = $BaselineMetrics
        treatment_metrics = $TreatmentMetrics
        rollback_thresholds = [ordered]@{
            hard_failures_in_first_5_applicable_runs = 2
            trailing_window_size = 10
            relative_regression_limit = 0.05
        }
        expiry_policy = $expiryPolicy
        proposed_change = $ProposedChange
        reversible = $true
        requires_human_review = $requiresHumanReview
        decision_reasons = @(Normalize-StringArray -Items $Reasons)
        shadow_decision = $ShadowDecision
    }
}

function New-AuditRecord {
    param(
        [Parameter(Mandatory = $true)]
        [string]$GeneratedAtUtc,

        [Parameter(Mandatory = $true)]
        [object]$Policy
    )

    $record = [ordered]@{
        schema_version = 1
        recorded_at_utc = $GeneratedAtUtc
        policy_id = [string]$Policy.policy_id
        scope_type = [string]$Policy.scope_type
        scope_key = [string]$Policy.scope_key
        target_surface = [string]$Policy.target_surface
        decision = [string]$Policy.state
        supporting_event_ids = @($Policy.supporting_event_ids)
        hard_fail_event_ids = @($Policy.hard_fail_event_ids)
        reasons = @($Policy.decision_reasons)
    }

    if ([string]$Policy.scope_type -eq "global") {
        if ($null -ne $Policy.source_scoped_policy_ids) {
            $record["source_scoped_policy_ids"] = @($Policy.source_scoped_policy_ids)
        }
        if ($null -ne $Policy.supporting_repos) {
            $record["supporting_repos"] = @($Policy.supporting_repos)
        }
        if ($null -ne $Policy.conflict_detection_result) {
            $record["conflict_detection_result"] = [string]$Policy.conflict_detection_result
        }
        if ($null -ne $Policy.regression_check_result) {
            $record["regression_check_result"] = [string]$Policy.regression_check_result
        }
    }

    return $record
}

function Get-KickoffPromptCandidates {
    param(
        [Parameter(Mandatory = $true)]
        [object[]]$Events,

        [Parameter(Mandatory = $true)]
        [string]$GeneratedAtUtc
    )

    $promptFrictionTags = @(
        "prompt_too_long",
        "instruction_overload",
        "tool_visibility_gap"
    )
    $contradictionTags = @(
        "missing_context",
        "needs_more_context",
        "not_enough_context",
        "too_little_context"
    )

    $groups = @{}
    foreach ($event in @($Events | Where-Object {
        $_.source_type -eq "local_session" -and
        -not [string]::IsNullOrWhiteSpace([string]$_.client_surface) -and
        -not [string]::IsNullOrWhiteSpace([string]$_.model)
    })) {
        $scopeKey = "{0}|{1}" -f (Normalize-KeyText $event.client_surface), (Normalize-KeyText $event.model)
        if (-not $groups.ContainsKey($scopeKey)) {
            $groups[$scopeKey] = New-Object System.Collections.Generic.List[object]
        }

        $groups[$scopeKey].Add($event)
    }

    $policies = New-Object System.Collections.Generic.List[object]

    foreach ($scopeKey in ($groups.Keys | Sort-Object)) {
        $applicableEvents = @($groups[$scopeKey].ToArray())
        $supportingEvents = @(
            $applicableEvents |
                Where-Object {
                    (Test-EventHasAnyTag -Event $_ -Tags $promptFrictionTags) -or
                    (Test-StackOverride -Event $_)
                }
        )

        if ($supportingEvents.Count -eq 0) {
            continue
        }

        $hardFailEvents = @(
            $applicableEvents |
                Where-Object { (Test-EventHasAnyTag -Event $_ -Tags $contradictionTags) }
        )

        $metrics = Get-Metrics -Events $applicableEvents -SupportingEvents $supportingEvents -HardFailEvents $hardFailEvents
        $reasons = New-Object System.Collections.Generic.List[string]

        if ($metrics.stack_override_rate -ge 0.25) {
            $reasons.Add("stack_override_rate_high")
        }

        if ($metrics.follow_up_rate -ge 0.25) {
            $reasons.Add("follow_up_rate_high")
        }

        $topFailureTags = @(
            Get-TopCounts -Items @(
                $supportingEvents |
                    ForEach-Object { Get-EventArrayProperty -Event $_ -Name "failure_tags" }
            ) -Take $Top
        )
        foreach ($item in $topFailureTags) {
            $reasons.Add("support_tag:$($item.Name)")
        }

        $state = if ($hardFailEvents.Count -gt 0) {
            "human_review"
        } elseif ($supportingEvents.Count -ge 3 -and $metrics.distinct_utc_day_count -ge 2) {
            "shadow"
        } else {
            "candidate"
        }

        $affectedTaskCategories = @(
            $applicableEvents |
                ForEach-Object { Normalize-KeyText $_.task_category } |
                Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
                Select-Object -Unique
        )

        $policy = New-PolicyRecord `
            -PolicyId ("local-client:{0}:kickoff_prompt_preset:compact" -f $scopeKey.Replace("|", ".")) `
            -ScopeType "local_client" `
            -ScopeKey $scopeKey `
            -TargetSurface "kickoff_prompt_preset" `
            -State $state `
            -GeneratedAtUtc $GeneratedAtUtc `
            -BaselineWindow (Get-BaselineWindow -Events $applicableEvents) `
            -SupportingEvents $supportingEvents `
            -HardFailEvents $hardFailEvents `
            -BaselineMetrics $metrics `
            -ProposedChange ([ordered]@{
                preset_id = "compact"
                affected_task_categories = @($affectedTaskCategories)
                rationale_tags = @($topFailureTags | ForEach-Object { $_.Name })
            }) `
            -Reasons $reasons.ToArray() `
            -ShadowDecision ([ordered]@{
                eligible = ($state -eq "shadow")
                would_change_stack_ranking = $false
                would_change_kickoff_phrasing = $true
                would_change_heuristics = $false
                likely_improvement_signals = @(Normalize-StringArray -Items $reasons.ToArray())
            })

        $policies.Add($policy)
    }

    return @($policies.ToArray())
}

function Get-VerificationHintCandidates {
    param(
        [Parameter(Mandatory = $true)]
        [object[]]$Events,

        [Parameter(Mandatory = $true)]
        [string]$GeneratedAtUtc
    )

    $verificationTags = @(
        "evidence-gate",
        "root-cause-missing",
        "insufficient_test_coverage",
        "test_coverage_failure",
        "verification_miss",
        "missing_tests"
    )

    $tagToHint = @{
        "evidence-gate" = "require_explicit_missing_evidence_statement"
        "root-cause-missing" = "require_root_cause_line"
        "insufficient_test_coverage" = "require_test_plan"
        "test_coverage_failure" = "require_test_plan"
        "verification_miss" = "require_verification_summary"
        "missing_tests" = "require_test_plan"
    }

    $groups = @{}
    foreach ($event in @($Events | Where-Object {
        -not [string]::IsNullOrWhiteSpace([string]$_.project) -and
        (Normalize-KeyText $_.project) -ne "global"
    })) {
        $scopeKey = [string]$event.project
        if (-not $groups.ContainsKey($scopeKey)) {
            $groups[$scopeKey] = New-Object System.Collections.Generic.List[object]
        }

        $groups[$scopeKey].Add($event)
    }

    $policies = New-Object System.Collections.Generic.List[object]

    foreach ($scopeKey in ($groups.Keys | Sort-Object)) {
        $applicableEvents = @($groups[$scopeKey].ToArray())
        $supportingEvents = @(
            $applicableEvents |
                Where-Object {
                    ([string]$_.qa_verdict -eq "reject") -or
                    (Test-EventHasAnyTag -Event $_ -Tags $verificationTags)
                }
        )

        if ($supportingEvents.Count -eq 0) {
            continue
        }

        $hardFailEvents = @()
        $metrics = Get-Metrics -Events $applicableEvents -SupportingEvents $supportingEvents -HardFailEvents $hardFailEvents
        $topFailureTags = @(
            Get-TopCounts -Items @(
                $supportingEvents |
                    ForEach-Object { Get-EventArrayProperty -Event $_ -Name "failure_tags" }
            ) -Take $Top
        )

        $checklist = New-Object System.Collections.Generic.List[string]
        foreach ($item in $topFailureTags) {
            $normalizedTag = Normalize-KeyText $item.Name
            if ($tagToHint.ContainsKey($normalizedTag)) {
                $checklist.Add([string]$tagToHint[$normalizedTag])
            }
        }

        if ($checklist.Count -eq 0) {
            if (@($supportingEvents | Where-Object { [string]$_.qa_verdict -eq "reject" }).Count -gt 0) {
                $checklist.Add("require_verification_summary")
            }
        }

        $state = if ($supportingEvents.Count -ge 3 -and $metrics.distinct_utc_day_count -ge 2) {
            "shadow"
        } else {
            "candidate"
        }

        $affectedTaskCategories = @(
            $supportingEvents |
                ForEach-Object { Normalize-KeyText $_.task_category } |
                Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
                Select-Object -Unique
        )

        $reasons = @(
            "verification_failures_recurring"
        ) + @($topFailureTags | ForEach-Object { "support_tag:$($_.Name)" })

        $policy = New-PolicyRecord `
            -PolicyId ("repo:{0}:verification_loop_hints:strict" -f (Normalize-KeyText $scopeKey)) `
            -ScopeType "repo" `
            -ScopeKey $scopeKey `
            -TargetSurface "verification_loop_hints" `
            -State $state `
            -GeneratedAtUtc $GeneratedAtUtc `
            -BaselineWindow (Get-BaselineWindow -Events $applicableEvents) `
            -SupportingEvents $supportingEvents `
            -HardFailEvents $hardFailEvents `
            -BaselineMetrics $metrics `
            -ProposedChange ([ordered]@{
                checklist = @(Normalize-StringArray -Items $checklist.ToArray())
                affected_task_categories = @($affectedTaskCategories)
                rationale_tags = @($topFailureTags | ForEach-Object { $_.Name })
            }) `
            -Reasons $reasons `
            -ShadowDecision ([ordered]@{
                eligible = ($state -eq "shadow")
                would_change_stack_ranking = $false
                would_change_kickoff_phrasing = $false
                would_change_heuristics = $true
                likely_improvement_signals = @("qa_reject_or_verification_failure_repeated")
            })

        $policies.Add($policy)
    }

    return @($policies.ToArray())
}

function Get-ResolverRankingCandidates {
    param(
        [Parameter(Mandatory = $true)]
        [object[]]$Events,

        [Parameter(Mandatory = $true)]
        [string]$GeneratedAtUtc
    )

    $groups = @{}
    foreach ($event in @($Events | Where-Object {
        -not [string]::IsNullOrWhiteSpace([string]$_.client_surface) -and
        -not [string]::IsNullOrWhiteSpace([string]$_.model) -and
        -not [string]::IsNullOrWhiteSpace([string]$_.task_category)
    })) {
        $scopeKey = "{0}|{1}" -f (Normalize-KeyText $event.client_surface), (Normalize-KeyText $event.model)
        $bucketKey = "{0}|{1}" -f $scopeKey, (Normalize-KeyText $event.task_category)
        if (-not $groups.ContainsKey($bucketKey)) {
            $groups[$bucketKey] = New-Object System.Collections.Generic.List[object]
        }

        $groups[$bucketKey].Add($event)
    }

    $policies = New-Object System.Collections.Generic.List[object]

    foreach ($bucketKey in ($groups.Keys | Sort-Object)) {
        $applicableEvents = @($groups[$bucketKey].ToArray())
        $parts = $bucketKey.Split("|")
        $scopeKey = "{0}|{1}" -f $parts[0], $parts[1]
        $taskCategory = $parts[2]

        $adapterCounts = @{}
        foreach ($event in $applicableEvents) {
            $positiveSignals = @(Get-EventArrayProperty -Event $event -Name "positive_signals")
            $isPositive = ($positiveSignals -contains "comparison_winner") -or ([string]$event.authoritative_success_label -eq "success")
            if (-not $isPositive) {
                continue
            }

            foreach ($stackId in @(Get-EventArrayProperty -Event $event -Name "selected_stack_ids")) {
                if ($stackId -notlike "adapter_*") {
                    continue
                }

                if ($adapterCounts.ContainsKey($stackId)) {
                    $adapterCounts[$stackId]++
                } else {
                    $adapterCounts[$stackId] = 1
                }
            }
        }

        if ($adapterCounts.Count -eq 0) {
            continue
        }

        $preferredAdapter = $adapterCounts.GetEnumerator() |
            Sort-Object -Property Value, Name -Descending |
            Select-Object -First 1

        if ($null -eq $preferredAdapter -or [int]$preferredAdapter.Value -lt 2) {
            continue
        }

        $supportingEvents = @(
            $applicableEvents |
                Where-Object {
                    ((Get-EventArrayProperty -Event $_ -Name "selected_stack_ids") -contains [string]$preferredAdapter.Name) -and
                    (
                        ((Get-EventArrayProperty -Event $_ -Name "positive_signals") -contains "comparison_winner") -or
                        ([string]$_.authoritative_success_label -eq "success")
                    )
                }
        )

        $hardFailEvents = @(
            $applicableEvents |
                Where-Object {
                    ((Get-EventArrayProperty -Event $_ -Name "selected_stack_ids") -contains [string]$preferredAdapter.Name) -and
                    ([string]$_.authoritative_success_label -eq "failed")
                }
        )

        $metrics = Get-Metrics -Events $applicableEvents -SupportingEvents $supportingEvents -HardFailEvents $hardFailEvents
        $state = if ($hardFailEvents.Count -gt 0) {
            "human_review"
        } elseif ($supportingEvents.Count -ge 3 -and $metrics.distinct_utc_day_count -ge 2) {
            "shadow"
        } else {
            "candidate"
        }

        $reasons = @(
            "comparison_or_success_pattern_detected",
            "preferred_adapter:$($preferredAdapter.Name)"
        )

        $policy = New-PolicyRecord `
            -PolicyId ("local-client:{0}:resolver_ranking:{1}" -f $scopeKey.Replace("|", "."), [string]$preferredAdapter.Name) `
            -ScopeType "local_client" `
            -ScopeKey $scopeKey `
            -TargetSurface "resolver_ranking" `
            -State $state `
            -GeneratedAtUtc $GeneratedAtUtc `
            -BaselineWindow (Get-BaselineWindow -Events $applicableEvents) `
            -SupportingEvents $supportingEvents `
            -HardFailEvents $hardFailEvents `
            -BaselineMetrics $metrics `
            -ProposedChange ([ordered]@{
                preferred_stack_ids = @([string]$preferredAdapter.Name)
                adjustment = "increase_rank"
                task_categories = @($taskCategory)
            }) `
            -Reasons $reasons `
            -ShadowDecision ([ordered]@{
                eligible = ($state -eq "shadow")
                would_change_stack_ranking = $true
                would_change_kickoff_phrasing = $false
                would_change_heuristics = $false
                likely_improvement_signals = @("comparison_wins_recur")
            })

        $policies.Add($policy)
    }

    return @($policies.ToArray())
}

function Get-ProposedChangeKey {
    param(
        [Parameter(Mandatory = $true)]
        [string]$TargetSurface,

        [AllowNull()]
        [object]$ProposedChange
    )

    if ($null -eq $ProposedChange) {
        return "none"
    }

    switch ($TargetSurface) {
        "kickoff_prompt_preset" {
            return "preset_id:{0}" -f [string]$ProposedChange.preset_id
        }
        "resolver_ranking" {
            $ids = @(
                $ProposedChange.preferred_stack_ids |
                    ForEach-Object { [string]$_ } |
                    Sort-Object
            )
            return "preferred:{0}" -f ($ids -join ",")
        }
        "verification_loop_hints" {
            # Equality key must include both checklist and affected_task_categories.
            # rationale_tags are informational only and excluded from the equality key.
            # This prevents silently merging policies that apply to different task scopes.
            $items = @(
                $ProposedChange.checklist |
                    ForEach-Object { [string]$_ } |
                    Sort-Object
            )
            $categories = @(
                $ProposedChange.affected_task_categories |
                    ForEach-Object { [string]$_ } |
                    Sort-Object
            )
            return "checklist:{0}|categories:{1}" -f ($items -join ","), ($categories -join ",")
        }
        default {
            return "surface:{0}" -f $TargetSurface
        }
    }
}

function Build-GlobalProposedChange {
    param(
        [Parameter(Mandatory = $true)]
        [string]$TargetSurface,

        [Parameter(Mandatory = $true)]
        [object[]]$GroupPolicies
    )

    switch ($TargetSurface) {
        "verification_loop_hints" {
            # All source policies in the group agree on checklist and affected_task_categories
            # (they are in the same group because they share the same changeKey).
            # Aggregate rationale_tags as a sorted union from all source policies.
            $agreedChecklist = @(
                $GroupPolicies[0].proposed_change.checklist |
                    ForEach-Object { [string]$_ } |
                    Sort-Object
            )
            $agreedCategories = @(
                $GroupPolicies[0].proposed_change.affected_task_categories |
                    ForEach-Object { [string]$_ } |
                    Sort-Object
            )
            $unionRationaleTags = @(
                $GroupPolicies |
                    ForEach-Object { @($_.proposed_change.rationale_tags) } |
                    ForEach-Object { [string]$_ } |
                    Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
                    Select-Object -Unique |
                    Sort-Object
            )
            return [ordered]@{
                checklist = $agreedChecklist
                affected_task_categories = $agreedCategories
                rationale_tags = $unionRationaleTags
            }
        }
        default {
            # For kickoff_prompt_preset and resolver_ranking the equality key already
            # captures all runtime-relevant fields; copying the first policy is safe.
            return $GroupPolicies[0].proposed_change
        }
    }
}

function Get-GlobalCandidates {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ActivePoliciesRoot,

        [Parameter(Mandatory = $true)]
        [string]$GeneratedAtUtc
    )

    $globalAllowlist = @(
        "kickoff_prompt_preset",
        "verification_loop_hints",
        "resolver_ranking"
    )

    $derivedCandidates = New-Object System.Collections.Generic.List[object]
    $extraAuditLines = New-Object System.Collections.Generic.List[string]

    # Load active repo policies only.
    # TODO (Slice 4B+): local-client active policies are intentionally excluded from the
    # global repo-count gate in Slice 4A. If cross-surface local-client evidence should
    # contribute to global promotion, it must be evaluated as a separate gate — not folded
    # into the distinct-repo threshold which is repo-specific by design.
    $activeRepoPolicies = New-Object System.Collections.Generic.List[object]
    $reposDir = Join-Path $ActivePoliciesRoot "repos"
    if (Test-Path -LiteralPath $reposDir) {
        foreach ($policyFile in @(Get-ChildItem -LiteralPath $reposDir -File)) {
            $container = Get-Content -LiteralPath $policyFile.FullName -Raw | ConvertFrom-Json
            foreach ($activePolicy in @($container.policies)) {
                if ([string]$activePolicy.state -eq "active") {
                    $activeRepoPolicies.Add($activePolicy)
                }
            }
        }
    }

    if ($activeRepoPolicies.Count -eq 0) {
        return [PSCustomObject]@{
            Candidates = @()
            ExtraAuditLines = @()
        }
    }

    # Build pattern groups (surface + changeKey) and surface-level repo sets in one pass.
    # The surface-level sets are used to distinguish contradictory patterns from
    # simply insufficient repo coverage.
    $groups = @{}
    $surfaceRepoSets = @{}

    foreach ($activePolicy in $activeRepoPolicies.ToArray()) {
        $surface = [string]$activePolicy.target_surface
        if ($globalAllowlist -notcontains $surface) {
            continue
        }
        $scopeKey = [string]$activePolicy.scope_key

        if (-not $surfaceRepoSets.ContainsKey($surface)) {
            $surfaceRepoSets[$surface] = New-Object System.Collections.Generic.HashSet[string]
        }
        $null = $surfaceRepoSets[$surface].Add($scopeKey)

        $changeKey = Get-ProposedChangeKey -TargetSurface $surface -ProposedChange $activePolicy.proposed_change
        $groupKey = "{0}|{1}" -f $surface, $changeKey
        if (-not $groups.ContainsKey($groupKey)) {
            $groups[$groupKey] = New-Object System.Collections.Generic.List[object]
        }
        $groups[$groupKey].Add($activePolicy)
    }

    foreach ($groupKey in ($groups.Keys | Sort-Object)) {
        $groupPolicies = @($groups[$groupKey].ToArray())
        $parts = $groupKey.Split("|", 2)
        $surface = $parts[0]
        $changeKey = if ($parts.Count -gt 1) { $parts[1] } else { "" }

        $distinctRepos = @(
            $groupPolicies |
                ForEach-Object { [string]$_.scope_key } |
                Select-Object -Unique |
                Sort-Object
        )

        $sourcePolicyIds = @($groupPolicies | ForEach-Object { [string]$_.policy_id })

        $aggregatedEventIds = @(
            $groupPolicies |
                ForEach-Object { @($_.supporting_event_ids) } |
                ForEach-Object { [string]$_ } |
                Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
                Select-Object -Unique
        )

        $aggregatedHardFailIds = @(
            $groupPolicies |
                ForEach-Object { @($_.hard_fail_event_ids) } |
                ForEach-Object { [string]$_ } |
                Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
                Select-Object -Unique
        )

        $policyId = "global:{0}:{1}" -f $surface, $changeKey

        if ($distinctRepos.Count -lt 3) {
            # If this surface has >=3 repos total but this specific pattern does not,
            # the repos have conflicting patterns -> contradictory.
            # If the surface itself has fewer than 3 repos, it is simply insufficient.
            $totalSurfaceRepos = if ($surfaceRepoSets.ContainsKey($surface)) {
                $surfaceRepoSets[$surface].Count
            } else { 0 }
            $rejectionReason = if ($totalSurfaceRepos -ge 3) {
                "contradictory_source_patterns"
            } else {
                "insufficient_source_repos"
            }

            $rejectionAudit = [ordered]@{
                schema_version = 1
                recorded_at_utc = $GeneratedAtUtc
                policy_id = $policyId
                scope_type = "global"
                scope_key = "global"
                target_surface = $surface
                decision = "rejected"
                reasons = @($rejectionReason)
                source_scoped_policy_ids = $sourcePolicyIds
                supporting_repos = $distinctRepos
                supporting_event_ids = $aggregatedEventIds
                conflict_detection_result = "none"
                regression_check_result = "pending_cross_repo_validation"
            }
            $extraAuditLines.Add(($rejectionAudit | ConvertTo-Json -Depth 6 -Compress))
            continue
        }

        $successRates = @($groupPolicies | ForEach-Object { [double]$_.baseline_metrics.success_rate })
        $followUpRates = @($groupPolicies | ForEach-Object { [double]$_.baseline_metrics.follow_up_rate })
        $avgSuccessRate = [Math]::Round(($successRates | Measure-Object -Average).Average, 4)
        $avgFollowUpRate = [Math]::Round(($followUpRates | Measure-Object -Average).Average, 4)

        $aggregatedMetrics = [ordered]@{
            applicable_event_count = $aggregatedEventIds.Count
            success_rate = $avgSuccessRate
            failed_rate = 0
            follow_up_rate = $avgFollowUpRate
            stack_override_rate = 0
            comparison_win_rate = 0
            distinct_source_repo_count = $distinctRepos.Count
        }

        $baselineWindow = [ordered]@{
            first_observed_at_utc = $null
            last_observed_at_utc = $null
            event_count = $aggregatedEventIds.Count
            distinct_source_repos = $distinctRepos.Count
        }

        $globalProposedChange = Build-GlobalProposedChange -TargetSurface $surface -GroupPolicies $groupPolicies

        $shadowDecision = [ordered]@{
            eligible = $true
            would_change_stack_ranking = $false
            would_change_kickoff_phrasing = $false
            would_change_heuristics = $true
            likely_improvement_signals = @(
                "cross_repo_pattern_confirmed_in_{0}_repos" -f $distinctRepos.Count
            )
        }

        $candidate = New-PolicyRecord `
            -PolicyId $policyId `
            -ScopeType "global" `
            -ScopeKey "global" `
            -TargetSurface $surface `
            -State "shadow" `
            -GeneratedAtUtc $GeneratedAtUtc `
            -BaselineWindow $baselineWindow `
            -SupportingEvents @() `
            -HardFailEvents @() `
            -BaselineMetrics $aggregatedMetrics `
            -ProposedChange $globalProposedChange `
            -Reasons @("cross_repo_pattern_confirmed") `
            -ShadowDecision $shadowDecision

        $candidate["supporting_event_ids"] = $aggregatedEventIds
        $candidate["hard_fail_event_ids"] = $aggregatedHardFailIds
        $candidate["source_scoped_policy_ids"] = $sourcePolicyIds
        $candidate["supporting_repos"] = $distinctRepos
        $candidate["conflict_detection_result"] = "none"
        $candidate["regression_check_result"] = "pending_cross_repo_validation"

        $derivedCandidates.Add($candidate)
    }

    return [PSCustomObject]@{
        Candidates = @($derivedCandidates.ToArray())
        ExtraAuditLines = @($extraAuditLines.ToArray())
    }
}

$events = @(
    Get-Content -LiteralPath $InputPath |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
        ForEach-Object { $_ | ConvertFrom-Json }
)

if ($events.Count -eq 0) {
    throw "Normalized events file is empty: $InputPath"
}

$generatedAtUtc = [DateTime]::UtcNow.ToString("o")
$policies = New-Object System.Collections.Generic.List[object]
$globalExtraAuditLines = New-Object System.Collections.Generic.List[string]

foreach ($policy in @(Get-KickoffPromptCandidates -Events $events -GeneratedAtUtc $generatedAtUtc)) {
    $policies.Add($policy)
}
foreach ($policy in @(Get-VerificationHintCandidates -Events $events -GeneratedAtUtc $generatedAtUtc)) {
    $policies.Add($policy)
}
foreach ($policy in @(Get-ResolverRankingCandidates -Events $events -GeneratedAtUtc $generatedAtUtc)) {
    $policies.Add($policy)
}

if (-not [string]::IsNullOrWhiteSpace($ActivePoliciesRoot)) {
    if (-not [System.IO.Path]::IsPathRooted($ActivePoliciesRoot)) {
        $ActivePoliciesRoot = Join-Path $Root $ActivePoliciesRoot
    }
    $globalResult = Get-GlobalCandidates -ActivePoliciesRoot $ActivePoliciesRoot -GeneratedAtUtc $generatedAtUtc
    foreach ($policy in $globalResult.Candidates) {
        $policies.Add($policy)
    }
    foreach ($line in $globalResult.ExtraAuditLines) {
        $globalExtraAuditLines.Add($line)
    }
}

$policyArray = @(
    $policies.ToArray() |
        Sort-Object -Property scope_type, scope_key, target_surface, policy_id
)

$stateCounts = @(
    Get-TopCounts -Items @($policyArray | ForEach-Object { $_.state }) -Take 10
)
$targetCounts = @(
    Get-TopCounts -Items @($policyArray | ForEach-Object { $_.target_surface }) -Take 10
)

$summary = [ordered]@{
    SchemaVersion = 1
    GeneratedAtUtc = $generatedAtUtc
    InputPath = (Resolve-Path -LiteralPath $InputPath).Path
    OutputPath = $OutputPath
    AuditOutputPath = $AuditOutputPath
    CandidateCount = $policyArray.Count
    StateCounts = $stateCounts
    TargetSurfaceCounts = $targetCounts
    Candidates = $policyArray
}

$outputDir = Split-Path -Path $OutputPath -Parent
if (-not [string]::IsNullOrWhiteSpace($outputDir)) {
    New-Item -ItemType Directory -Force -Path $outputDir | Out-Null
}

$auditDir = Split-Path -Path $AuditOutputPath -Parent
if (-not [string]::IsNullOrWhiteSpace($auditDir)) {
    New-Item -ItemType Directory -Force -Path $auditDir | Out-Null
}

$summary | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $OutputPath -Encoding UTF8

$auditLines = New-Object System.Collections.Generic.List[string]
foreach ($policy in $policyArray) {
    $auditLines.Add(((New-AuditRecord -GeneratedAtUtc $generatedAtUtc -Policy $policy) | ConvertTo-Json -Depth 6 -Compress))
}

foreach ($extraLine in $globalExtraAuditLines) {
    $auditLines.Add($extraLine)
}

if ($auditLines.Count -gt 0) {
    Add-Content -LiteralPath $AuditOutputPath -Value $auditLines -Encoding UTF8
}

if ($Format -eq "json") {
    $summary | ConvertTo-Json -Depth 8
    exit 0
}

Write-Host ""
Write-Host "Babel Local Policy Candidate Generation" -ForegroundColor Cyan
Write-Host "Input path: $($summary['InputPath'])"
Write-Host "Candidates: $($summary['CandidateCount'])"

Write-Host ""
Write-Host "States:" -ForegroundColor Yellow
if ($summary["StateCounts"].Count -eq 0) {
    Write-Host "  None."
} else {
    foreach ($item in $summary["StateCounts"]) {
        Write-Host "  - $($item.Name): $($item.Count)"
    }
}

Write-Host ""
Write-Host "Target surfaces:" -ForegroundColor Yellow
if ($summary["TargetSurfaceCounts"].Count -eq 0) {
    Write-Host "  None."
} else {
    foreach ($item in $summary["TargetSurfaceCounts"]) {
        Write-Host "  - $($item.Name): $($item.Count)"
    }
}

Write-Host ""
Write-Host "Outputs:" -ForegroundColor Yellow
Write-Host "  - $OutputPath"
Write-Host "  - $AuditOutputPath"
