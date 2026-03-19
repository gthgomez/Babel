[CmdletBinding()]
param(
    [string]$Root = "",
    [string]$InputPath = "",
    [string]$GlobalPolicyId = "",
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

if ([string]::IsNullOrWhiteSpace($InputPath)) {
    $InputPath = Join-Path $Root "runs\local-learning\derived\normalized-events.jsonl"
} elseif (-not [System.IO.Path]::IsPathRooted($InputPath)) {
    $InputPath = Join-Path $Root $InputPath
}

if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    $OutputPath = Join-Path $Root "runs\local-learning\derived\phase4-global-validation.json"
} elseif (-not [System.IO.Path]::IsPathRooted($OutputPath)) {
    $OutputPath = Join-Path $Root $OutputPath
}

if (-not (Test-Path -LiteralPath $InputPath)) {
    throw "Normalized events file not found: $InputPath"
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

function Test-GlobalPolicyApplied {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Event,

        [Parameter(Mandatory = $true)]
        [string]$PolicyId
    )

    if ([string]::IsNullOrWhiteSpace($PolicyId)) {
        return $false
    }

    foreach ($token in @(Get-PolicyAppliedTokens -Event $Event)) {
        if ($token -eq $PolicyId -or $token.StartsWith($PolicyId + "@")) {
            return $true
        }
    }

    return $false
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

function Get-Metrics {
    param(
        [AllowNull()]
        [object[]]$Events
    )

    $eventArray = @($Events)
    $successCount = @($eventArray | Where-Object { [string]$_.authoritative_success_label -eq "success" }).Count
    $failedCount = @($eventArray | Where-Object { [string]$_.authoritative_success_label -eq "failed" }).Count
    $followUpCount = @($eventArray | Where-Object { [bool]$_.follow_up_needed }).Count
    $overrideCount = @(
        $eventArray |
            Where-Object {
                $selected = @(Normalize-StringArray -Items @($_.selected_stack_ids))
                $recommended = @(Normalize-StringArray -Items @($_.recommended_stack_ids))
                if ($selected.Count -eq 0 -or $recommended.Count -eq 0) {
                    return $false
                }

                return (($selected -join ";") -ne ($recommended -join ";"))
            }
    ).Count
    $comparisonWinCount = @($eventArray | Where-Object { [string]$_.qa_verdict -eq "pass" }).Count

    return [ordered]@{
        applicable_event_count = $eventArray.Count
        success_rate = Convert-ToRate -Numerator $successCount -Denominator $eventArray.Count
        failed_rate = Convert-ToRate -Numerator $failedCount -Denominator $eventArray.Count
        follow_up_rate = Convert-ToRate -Numerator $followUpCount -Denominator $eventArray.Count
        stack_override_rate = Convert-ToRate -Numerator $overrideCount -Denominator $eventArray.Count
        comparison_win_rate = Convert-ToRate -Numerator $comparisonWinCount -Denominator $eventArray.Count
        hard_fail_count = $failedCount
    }
}

$events = @(
    Get-Content -LiteralPath $InputPath |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
        ForEach-Object { $_ | ConvertFrom-Json }
)

$withGlobal = @($events | Where-Object { Test-GlobalPolicyApplied -Event $_ -PolicyId $GlobalPolicyId })
$withoutGlobal = @(
    $events |
        Where-Object {
            (-not (Test-GlobalPolicyApplied -Event $_ -PolicyId $GlobalPolicyId)) -and
            (-not [string]::IsNullOrWhiteSpace([string]$_.policy_version_applied))
        }
)
$thinBaseline = @($events | Where-Object { [string]::IsNullOrWhiteSpace([string]$_.policy_version_applied) })

$withGlobalMetrics = Get-Metrics -Events $withGlobal
$withoutGlobalMetrics = Get-Metrics -Events $withoutGlobal
$thinBaselineMetrics = Get-Metrics -Events $thinBaseline

$reasons = New-Object System.Collections.Generic.List[string]
if ($withGlobalMetrics.applicable_event_count -eq 0) {
    $reasons.Add("no_global_events_observed")
}
if ($withGlobalMetrics.hard_fail_count -gt 0) {
    $reasons.Add("global_hard_fail_detected")
}

foreach ($baseline in @(
    [PSCustomObject]@{ Name = "babel_without_global"; Metrics = $withoutGlobalMetrics },
    [PSCustomObject]@{ Name = "thin_baseline"; Metrics = $thinBaselineMetrics }
)) {
    if ([int]$baseline.Metrics.applicable_event_count -le 0) {
        continue
    }

    if ([double]$withGlobalMetrics.success_rate -lt [double]$baseline.Metrics.success_rate) {
        $reasons.Add("$($baseline.Name)_success_rate_regressed")
    }
    if ([double]$withGlobalMetrics.follow_up_rate -gt [double]$baseline.Metrics.follow_up_rate) {
        $reasons.Add("$($baseline.Name)_follow_up_rate_regressed")
    }
    if ([double]$withGlobalMetrics.stack_override_rate -gt [double]$baseline.Metrics.stack_override_rate) {
        $reasons.Add("$($baseline.Name)_stack_override_rate_regressed")
    }
}

$status = if ($reasons.Count -eq 0 -and $withGlobalMetrics.applicable_event_count -gt 0) {
    "pass"
} else {
    "fail"
}

$result = [ordered]@{
    schema_version = 1
    generated_at_utc = [DateTimeOffset]::UtcNow.UtcDateTime.ToString("o")
    input_path = $InputPath
    global_policy_id = $GlobalPolicyId
    validation_status = $status
    reasons = @($reasons.ToArray())
    buckets = [ordered]@{
        with_global = $withGlobalMetrics
        babel_without_global = $withoutGlobalMetrics
        thin_baseline = $thinBaselineMetrics
    }
}

$outputDir = Split-Path -Path $OutputPath -Parent
if (-not [string]::IsNullOrWhiteSpace($outputDir)) {
    New-Item -ItemType Directory -Force -Path $outputDir | Out-Null
}
$result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $OutputPath -Encoding UTF8

if ($Format -eq "json") {
    $result | ConvertTo-Json -Depth 8
    exit 0
}

Write-Host "Phase 4 global comparison validation" -ForegroundColor Cyan
Write-Host "Status: $status"
Write-Host "Reasons: $((@($reasons.ToArray())) -join ', ')"
Write-Host "Output: $OutputPath"
