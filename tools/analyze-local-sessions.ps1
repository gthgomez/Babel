[CmdletBinding()]
param(
    [string]$InputPath = "",

    [ValidateSet("text", "json")]
    [string]$Format = "text",

    [int]$Top = 5,

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

if ([string]::IsNullOrWhiteSpace($InputPath)) {
    $InputPath = Join-Path $Root "runs\local-learning\session-log.jsonl"
} elseif (-not [System.IO.Path]::IsPathRooted($InputPath)) {
    $InputPath = Join-Path $Root $InputPath
}

if ($Top -lt 1) {
    throw "Top must be at least 1."
}

if (-not (Test-Path -LiteralPath $InputPath)) {
    throw "Session log not found: $InputPath"
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

function Get-UniqueValues {
    param(
        [AllowNull()]
        [object[]]$Items
    )

    $seen = @{}
    $values = New-Object System.Collections.Generic.List[string]

    foreach ($item in @($Items)) {
        if ($null -eq $item) {
            continue
        }

        $text = [string]$item
        if ([string]::IsNullOrWhiteSpace($text)) {
            continue
        }

        if (-not $seen.ContainsKey($text)) {
            $seen[$text] = $true
            $values.Add($text)
        }
    }

    return @($values | Sort-Object)
}

function Get-RateBreakdown {
    param(
        [AllowNull()]
        [object[]]$Sessions,

        [Parameter(Mandatory = $true)]
        [string]$GroupProperty,

        [int]$Take = 5
    )

    $groups = @{}

    foreach ($session in @($Sessions)) {
        $key = [string]$session.$GroupProperty
        if ([string]::IsNullOrWhiteSpace($key)) {
            $key = "(unknown)"
        }

        if (-not $groups.ContainsKey($key)) {
            $groups[$key] = New-Object System.Collections.Generic.List[object]
        }

        $groups[$key].Add($session)
    }

    $rows = New-Object System.Collections.Generic.List[object]

    foreach ($key in $groups.Keys) {
        $items = $groups[$key].ToArray()
        $sessionCount = $items.Count
        $successCount = 0
        $failedLikeCount = 0
        $overrideCount = 0
        $followUpCount = 0
        $failureTags = New-Object System.Collections.Generic.List[string]

        foreach ($item in $items) {
            if ($item.Result -eq "success") {
                $successCount++
            }

            if ($item.Result -eq "failed" -or $item.Result -eq "abandoned") {
                $failedLikeCount++
            }

            if ($item.StackOverrideDetected -eq $true) {
                $overrideCount++
            }

            if ($item.FollowUpNeeded -eq $true) {
                $followUpCount++
            }

            foreach ($tag in @($item.FailureTags)) {
                if (-not [string]::IsNullOrWhiteSpace([string]$tag)) {
                    $failureTags.Add([string]$tag)
                }
            }
        }

        $rows.Add([PSCustomObject]@{
            Name = $key
            SessionCount = $sessionCount
            SuccessRate = Convert-ToRate -Numerator $successCount -Denominator $sessionCount
            FailureRate = Convert-ToRate -Numerator $failedLikeCount -Denominator $sessionCount
            OverrideRate = Convert-ToRate -Numerator $overrideCount -Denominator $sessionCount
            FollowUpRate = Convert-ToRate -Numerator $followUpCount -Denominator $sessionCount
            TopFailureTags = @(Get-TopCounts -Items @($failureTags) -Take 3)
        })
    }

    return @(
        $rows |
            Sort-Object -Property SessionCount, Name -Descending |
            Select-Object -First $Take
    )
}

$sessions = New-Object System.Collections.Generic.List[object]
foreach ($line in Get-Content -Path $InputPath) {
    if ([string]::IsNullOrWhiteSpace($line)) {
        continue
    }

    $sessions.Add(($line | ConvertFrom-Json))
}

if ($sessions.Count -eq 0) {
    throw "Session log is empty: $InputPath"
}

$sessionArray = $sessions.ToArray()
$sessionCount = $sessionArray.Count
$overrideCount = 0
$followUpCount = 0
$successCount = 0
$failedLikeCount = 0

$allFailureTags = New-Object System.Collections.Generic.List[string]
$allFilesTouched = New-Object System.Collections.Generic.List[string]
$allActualStackIds = New-Object System.Collections.Generic.List[string]
$allProjects = New-Object System.Collections.Generic.List[string]
$allClientSurfaces = New-Object System.Collections.Generic.List[string]
$allModels = New-Object System.Collections.Generic.List[string]
$resultBuckets = @{}

foreach ($session in $sessionArray) {
    $allProjects.Add([string]$session.Project)
    $allClientSurfaces.Add([string]$session.ClientSurface)
    $allModels.Add([string]$session.Model)

    if ($session.Result -eq "success") {
        $successCount++
    }

    if ($session.Result -eq "failed" -or $session.Result -eq "abandoned") {
        $failedLikeCount++
    }

    if ($session.StackOverrideDetected -eq $true) {
        $overrideCount++
    }

    if ($session.FollowUpNeeded -eq $true) {
        $followUpCount++
    }

    $resultKey = [string]$session.Result
    if ($resultBuckets.ContainsKey($resultKey)) {
        $resultBuckets[$resultKey]++
    } else {
        $resultBuckets[$resultKey] = 1
    }

    foreach ($tag in @($session.FailureTags)) {
        if (-not [string]::IsNullOrWhiteSpace([string]$tag)) {
            $allFailureTags.Add([string]$tag)
        }
    }

    foreach ($filePath in @($session.FilesTouched)) {
        if (-not [string]::IsNullOrWhiteSpace([string]$filePath)) {
            $allFilesTouched.Add([string]$filePath)
        }
    }

    foreach ($stackId in @($session.ActualSelectedStackIds)) {
        if (-not [string]::IsNullOrWhiteSpace([string]$stackId)) {
            $allActualStackIds.Add([string]$stackId)
        }
    }
}

$resultCounts = New-Object System.Collections.Generic.List[object]
foreach ($key in ($resultBuckets.Keys | Sort-Object)) {
    $resultCounts.Add([PSCustomObject]@{
        Name = $key
        Count = [int]$resultBuckets[$key]
    })
}

$topFailureTags = @(Get-TopCounts -Items $allFailureTags.ToArray() -Take $Top)
$recommendations = New-Object System.Collections.Generic.List[string]

if ((Convert-ToRate -Numerator $overrideCount -Denominator $sessionCount) -ge 0.25) {
    $recommendations.Add("Stack override rate is high. Review resolver defaults, kickoff prompt length, and task-overlay recommendations.")
}

if ((Convert-ToRate -Numerator $followUpCount -Denominator $sessionCount) -ge 0.25) {
    $recommendations.Add("Follow-up-needed rate is high. Tighten tool profiles and repo-local handoff guidance.")
}

if ($topFailureTags.Count -gt 0) {
    $topFailure = $topFailureTags | Select-Object -First 1
    if ($null -ne $topFailure -and $topFailure.Count -ge 2) {
        $recommendations.Add("Failure tag '$($topFailure.Name)' is recurring. Treat it as the next optimization target.")
    }
}

$uniqueProjects = @(Get-UniqueValues -Items $allProjects.ToArray())
$uniqueClientSurfaces = @(Get-UniqueValues -Items $allClientSurfaces.ToArray())
$uniqueModels = @(Get-UniqueValues -Items $allModels.ToArray())
$topFilesTouched = @(Get-TopCounts -Items $allFilesTouched.ToArray() -Take $Top)
$topActualStackIds = @(Get-TopCounts -Items $allActualStackIds.ToArray() -Take $Top)
$byClientSurface = @(Get-RateBreakdown -Sessions $sessionArray -GroupProperty "ClientSurface" -Take $Top)
$byTaskCategory = @(Get-RateBreakdown -Sessions $sessionArray -GroupProperty "TaskCategory" -Take $Top)
$byModel = @(Get-RateBreakdown -Sessions $sessionArray -GroupProperty "Model" -Take $Top)

$summary = [ordered]@{}
$summary["SchemaVersion"] = 1
$summary["InputPath"] = (Resolve-Path $InputPath).Path
$summary["SessionCount"] = $sessionCount
$summary["UniqueProjects"] = $uniqueProjects
$summary["UniqueClientSurfaces"] = $uniqueClientSurfaces
$summary["UniqueModels"] = $uniqueModels
$summary["ResultCounts"] = $resultCounts.ToArray()
$summary["SuccessRate"] = Convert-ToRate -Numerator $successCount -Denominator $sessionCount
$summary["FailureRate"] = Convert-ToRate -Numerator $failedLikeCount -Denominator $sessionCount
$summary["StackOverrideCount"] = $overrideCount
$summary["StackOverrideRate"] = Convert-ToRate -Numerator $overrideCount -Denominator $sessionCount
$summary["FollowUpNeededCount"] = $followUpCount
$summary["FollowUpNeededRate"] = Convert-ToRate -Numerator $followUpCount -Denominator $sessionCount
$summary["TopFailureTags"] = $topFailureTags
$summary["TopFilesTouched"] = $topFilesTouched
$summary["TopActualStackIds"] = $topActualStackIds
$summary["ByClientSurface"] = $byClientSurface
$summary["ByTaskCategory"] = $byTaskCategory
$summary["ByModel"] = $byModel
$summary["Recommendations"] = $recommendations.ToArray()

if ($Format -eq "json") {
    $summary | ConvertTo-Json -Depth 8
    exit 0
}

Write-Host ""
Write-Host "Babel Local Session Analysis" -ForegroundColor Cyan
Write-Host "Input path: $($summary['InputPath'])"
Write-Host "Sessions: $($summary['SessionCount'])"
Write-Host "Success rate: $($summary['SuccessRate'])"
Write-Host "Failure rate: $($summary['FailureRate'])"
Write-Host "Stack override rate: $($summary['StackOverrideRate'])"
Write-Host "Follow-up-needed rate: $($summary['FollowUpNeededRate'])"

Write-Host ""
Write-Host "Top failure tags:" -ForegroundColor Yellow
if ($summary["TopFailureTags"].Count -eq 0) {
    Write-Host "  None."
} else {
    foreach ($item in $summary["TopFailureTags"]) {
        Write-Host "  - $($item.Name): $($item.Count)"
    }
}

Write-Host ""
Write-Host "By client surface:" -ForegroundColor Yellow
foreach ($item in $summary["ByClientSurface"]) {
    Write-Host "  - $($item.Name): sessions=$($item.SessionCount) success=$($item.SuccessRate) override=$($item.OverrideRate) follow_up=$($item.FollowUpRate)"
}

Write-Host ""
Write-Host "Recommendations:" -ForegroundColor Yellow
if ($summary["Recommendations"].Count -eq 0) {
    Write-Host "  None."
} else {
    foreach ($item in $summary["Recommendations"]) {
        Write-Host "  - $item"
    }
}
