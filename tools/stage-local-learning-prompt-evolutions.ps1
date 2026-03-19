[CmdletBinding()]
param(
    [string]$Root = "",
    [string]$LocalLearningRoot = "",
    [string]$CandidatePath = "",
    [string]$AuditPath = "",
    [string]$NormalizedEventsPath = "",
    [string]$OutputPath = "",
    [ValidateSet("text", "json")]
    [string]$Format = "text"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($Root)) {
    $scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Path $PSCommandPath -Parent }
    $Root = (Resolve-Path (Join-Path $scriptDir "..")).Path
} else {
    $Root = (Resolve-Path $Root).Path
}

if ([string]::IsNullOrWhiteSpace($LocalLearningRoot)) {
    $LocalLearningRoot = Join-Path $Root "runs\local-learning"
} elseif (-not [System.IO.Path]::IsPathRooted($LocalLearningRoot)) {
    $LocalLearningRoot = Join-Path $Root $LocalLearningRoot
}

if ([string]::IsNullOrWhiteSpace($CandidatePath)) {
    $CandidatePath = Join-Path $LocalLearningRoot "derived\policy-candidates.json"
} elseif (-not [System.IO.Path]::IsPathRooted($CandidatePath)) {
    $CandidatePath = Join-Path $Root $CandidatePath
}

if ([string]::IsNullOrWhiteSpace($AuditPath)) {
    $AuditPath = Join-Path $LocalLearningRoot "derived\policy-audit.jsonl"
} elseif (-not [System.IO.Path]::IsPathRooted($AuditPath)) {
    $AuditPath = Join-Path $Root $AuditPath
}

if ([string]::IsNullOrWhiteSpace($NormalizedEventsPath)) {
    $NormalizedEventsPath = Join-Path $LocalLearningRoot "derived\normalized-events.jsonl"
} elseif (-not [System.IO.Path]::IsPathRooted($NormalizedEventsPath)) {
    $NormalizedEventsPath = Join-Path $Root $NormalizedEventsPath
}

if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    $OutputPath = Join-Path $Root "04_Meta_Tools\proposed_evolutions.json"
} elseif (-not [System.IO.Path]::IsPathRooted($OutputPath)) {
    $OutputPath = Join-Path $Root $OutputPath
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

    return @($values.ToArray())
}

function Read-JsonFileOrDefault {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,

        [Parameter(Mandatory = $true)]
        [object]$DefaultValue
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        return $DefaultValue
    }

    return (Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json)
}

function Read-JsonLines {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        return @()
    }

    return @(
        Get-Content -LiteralPath $Path |
            Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
            ForEach-Object { $_ | ConvertFrom-Json }
    )
}

function Get-EventMap {
    param([object[]]$Events)
    $map = @{}
    foreach ($event in @($Events)) {
        $eventId = [string]$event.event_id
        if (-not [string]::IsNullOrWhiteSpace($eventId)) {
            $map[$eventId] = $event
        }
    }
    return $map
}

function Resolve-TargetPromptAsset {
    param(
        [string[]]$RepoScopes,
        [string]$TaskCategory,
        [string]$Model
    )

    $normalizedRepoScopes = @(Normalize-StringArray -Items @($RepoScopes))
    $repoScope = if ($normalizedRepoScopes.Count -eq 1) { [string]$normalizedRepoScopes[0] } else { "" }
    switch ($repoScope) {
        "GPCGuard" {
            return [ordered]@{
                target_file = Join-Path $Root "05_Project_Overlays\GPCGuard-Context.md"
                target_layer = "project_overlay"
            }
        }
        "Prismatix" {
            return [ordered]@{
                target_file = Join-Path $Root "05_Project_Overlays\Prismatix-Context.md"
                target_layer = "project_overlay"
            }
        }
        "AuditGuard" {
            return [ordered]@{
                target_file = Join-Path $Root "05_Project_Overlays\AuditGuard-Context.md"
                target_layer = "project_overlay"
            }
        }
    }

    if ($TaskCategory -eq "frontend") {
        return [ordered]@{
            target_file = Join-Path $Root "06_Task_Overlays\Frontend-Professionalism-v1.0.md"
            target_layer = "task_overlay"
        }
    }

    switch ($Model) {
        "claude" {
            return [ordered]@{
                target_file = Join-Path $Root "03_Model_Adapters\Claude_AntiEager.md"
                target_layer = "model_adapter"
            }
        }
        "gemini" {
            return [ordered]@{
                target_file = Join-Path $Root "03_Model_Adapters\Gemini_LongContext.md"
                target_layer = "model_adapter"
            }
        }
        default {
            return [ordered]@{
                target_file = Join-Path $Root "03_Model_Adapters\Codex_Balanced.md"
                target_layer = "model_adapter"
            }
        }
    }
}

function Convert-ToProposalIdFragment {
    param([string]$Value)
    $fragment = ([string]$Value).ToLowerInvariant() -replace '[^a-z0-9]+', '-'
    return $fragment.Trim('-')
}

$defaultExistingReport = [ordered]@{
    generated_at = $null
    runs_dir = $null
    runs_scanned = 0
    reject_verdicts_found = 0
    architects_affected = 0
    proposals = @()
}

$candidateSummary = Read-JsonFileOrDefault -Path $CandidatePath -DefaultValue ([ordered]@{ Candidates = @() })
$auditRecords = Read-JsonLines -Path $AuditPath
$events = Read-JsonLines -Path $NormalizedEventsPath
$eventsById = Get-EventMap -Events $events
$existingReport = Read-JsonFileOrDefault -Path $OutputPath -DefaultValue $defaultExistingReport

$proposals = New-Object System.Collections.Generic.List[object]

$humanReviewCandidates = @(
    @($candidateSummary.Candidates) |
        Where-Object { [string]$_.state -eq "human_review" -or [bool]$_.requires_human_review }
)
$humanReviewGroups = $humanReviewCandidates | Group-Object { "{0}|{1}" -f ([string]$_.target_surface), ([string]$_.scope_type) }
foreach ($group in @($humanReviewGroups)) {
    $items = @($group.Group)
    if ($items.Count -lt 2) {
        continue
    }

    $sourcePolicyIds = Normalize-StringArray -Items @($items | ForEach-Object { [string]$_.policy_id })
    $sourceEventIds = Normalize-StringArray -Items @($items | ForEach-Object { @($_.supporting_event_ids) })
    $repoScopes = Normalize-StringArray -Items @($items | ForEach-Object { if ([string]$_.scope_type -eq "repo") { [string]$_.scope_key } })
    $sourceEvent = if ($sourceEventIds.Count -gt 0 -and $eventsById.ContainsKey($sourceEventIds[0])) { $eventsById[$sourceEventIds[0]] } else { $null }
    $taskCategory = if ($null -ne $sourceEvent) { [string]$sourceEvent.task_category } else { "frontend" }
    $model = if ($null -ne $sourceEvent) { [string]$sourceEvent.model } else { "codex" }
    $target = Resolve-TargetPromptAsset -RepoScopes $repoScopes -TaskCategory $taskCategory -Model $model
    $surface = [string]$items[0].target_surface

    $proposals.Add([ordered]@{
        generated_at_utc = [DateTimeOffset]::UtcNow.UtcDateTime.ToString("o")
        proposal_id = "ll-human-review-" + (Convert-ToProposalIdFragment -Value $group.Name)
        source_type = "repeated_human_review_pattern"
        source_policy_ids = $sourcePolicyIds
        source_event_ids = $sourceEventIds
        source_repo_scope = $repoScopes
        target_file = $target.target_file
        target_layer = $target.target_layer
        observed_problem = "Repeated human-review learning signals for target surface '$surface' indicate a prompt-layer gap."
        why_structured_runtime_policy_was_insufficient = "The learning loop repeatedly reached human review instead of a bounded runtime policy outcome."
        suggested_prompt_change_summary = "Add explicit guidance for '$surface' so the agent can satisfy the review expectation earlier and more consistently."
        human_review_checklist = @(
            "Confirm the observed pattern cannot be expressed safely as runtime policy data."
            "Check whether the proposed target layer is the narrowest allowed prompt asset."
            "Verify the change would not conflict with repo-specific invariants."
        )
        validation_steps_after_review = @(
            "Re-run the relevant Local Mode fixture or session path with the staged prompt change."
            "Compare follow-up-needed and verification quality against the prior baseline."
            "Confirm no protected prompt assets were edited automatically."
        )
    })
}

$nonAllowlistedRecords = @(
    $auditRecords |
        Where-Object { @($_.reasons) -contains "target_surface_not_allowlisted" }
)
$nonAllowlistedGroups = $nonAllowlistedRecords | Group-Object { [string]$_.target_surface }
foreach ($group in @($nonAllowlistedGroups)) {
    $items = @($group.Group)
    if ($items.Count -lt 2) {
        continue
    }

    $sourcePolicyIds = Normalize-StringArray -Items @($items | ForEach-Object { [string]$_.policy_id })
    $sourceEventIds = Normalize-StringArray -Items @($items | ForEach-Object { @($_.supporting_event_ids) + @($_.triggering_event_ids) })
    $repoScopes = Normalize-StringArray -Items @($items | ForEach-Object {
        if ([string]$_.scope_type -eq "repo") {
            [string]$_.scope_key
        }
    })
    $sourceEvent = if ($sourceEventIds.Count -gt 0 -and $eventsById.ContainsKey($sourceEventIds[0])) { $eventsById[$sourceEventIds[0]] } else { $null }
    $taskCategory = if ($null -ne $sourceEvent) { [string]$sourceEvent.task_category } else { "frontend" }
    $model = if ($null -ne $sourceEvent) { [string]$sourceEvent.model } else { "codex" }
    $target = Resolve-TargetPromptAsset -RepoScopes $repoScopes -TaskCategory $taskCategory -Model $model
    $surface = [string]$items[0].target_surface

    $proposals.Add([ordered]@{
        generated_at_utc = [DateTimeOffset]::UtcNow.UtcDateTime.ToString("o")
        proposal_id = "ll-non-allowlisted-" + (Convert-ToProposalIdFragment -Value $surface)
        source_type = "repeated_non_allowlisted_surface"
        source_policy_ids = $sourcePolicyIds
        source_event_ids = $sourceEventIds
        source_repo_scope = $repoScopes
        target_file = $target.target_file
        target_layer = $target.target_layer
        observed_problem = "Repeated non-allowlisted surface '$surface' signals indicate a prompt-layer rule gap."
        why_structured_runtime_policy_was_insufficient = "The desired behavior cannot be auto-applied safely because the runtime allowlist blocks this surface."
        suggested_prompt_change_summary = "Clarify the expected behavior for '$surface' in the selected prompt layer so the model handles it constitutionally instead of relying on runtime policy."
        human_review_checklist = @(
            "Confirm '$surface' should remain outside the runtime auto-apply allowlist."
            "Review whether a prompt-layer clarification is safer than expanding runtime policy scope."
            "Check for overlap with existing model adapter or project overlay guidance."
        )
        validation_steps_after_review = @(
            "Re-run the relevant local-learning fixture and confirm the surface no longer escalates to repeated non-allowlisted audits."
            "Verify no protected core files were edited."
            "Document whether the change reduced human-review load."
        )
    })
}

$existingReportObject = [ordered]@{}
foreach ($property in $existingReport.PSObject.Properties) {
    $existingReportObject[$property.Name] = $property.Value
}
if (-not $existingReportObject.Contains("proposals")) {
    $existingReportObject["proposals"] = @()
}
$existingReportObject["local_learning_generated_at_utc"] = [DateTimeOffset]::UtcNow.UtcDateTime.ToString("o")
$existingReportObject["local_learning_proposals"] = @($proposals.ToArray())

$outputDir = Split-Path -Path $OutputPath -Parent
if (-not [string]::IsNullOrWhiteSpace($outputDir)) {
    New-Item -ItemType Directory -Force -Path $outputDir | Out-Null
}
$existingReportObject | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $OutputPath -Encoding UTF8

$result = [ordered]@{
    schema_version = 1
    output_path = $OutputPath
    local_learning_proposal_count = $proposals.Count
    proposal_ids = @($proposals | ForEach-Object { [string]$_.proposal_id })
}

if ($Format -eq "json") {
    $result | ConvertTo-Json -Depth 8
    exit 0
}

Write-Host "Local-learning prompt evolution staging complete." -ForegroundColor Cyan
Write-Host "Proposal count: $($proposals.Count)"
Write-Host "Output: $OutputPath"
