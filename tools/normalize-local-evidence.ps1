[CmdletBinding()]
param(
    [string]$RunBundlesRoot = "",

    [string]$SessionLogPath = "",

    [string]$ComparisonInputPath = "",

    [string]$OutputPath = "",

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

if ([string]::IsNullOrWhiteSpace($RunBundlesRoot)) {
    $RunBundlesRoot = Join-Path $Root "runs"
} elseif (-not [System.IO.Path]::IsPathRooted($RunBundlesRoot)) {
    $RunBundlesRoot = Join-Path $Root $RunBundlesRoot
}

if ([string]::IsNullOrWhiteSpace($SessionLogPath)) {
    $SessionLogPath = Join-Path $Root "runs\local-learning\session-log.jsonl"
} elseif (-not [System.IO.Path]::IsPathRooted($SessionLogPath)) {
    $SessionLogPath = Join-Path $Root $SessionLogPath
}

if (-not [string]::IsNullOrWhiteSpace($ComparisonInputPath) -and -not [System.IO.Path]::IsPathRooted($ComparisonInputPath)) {
    $ComparisonInputPath = Join-Path $Root $ComparisonInputPath
}

if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    $OutputPath = Join-Path $Root "runs\local-learning\derived\normalized-events.jsonl"
} elseif (-not [System.IO.Path]::IsPathRooted($OutputPath)) {
    $OutputPath = Join-Path $Root $OutputPath
}

$scoreComparisonPath = Join-Path $Root "tools\score-comparison-results.ps1"
if (-not (Test-Path -LiteralPath $scoreComparisonPath)) {
    throw "Comparison scorer not found: $scoreComparisonPath"
}

function Test-HasProperty {
    param(
        [AllowNull()]
        [object]$Object,

        [Parameter(Mandatory = $true)]
        [string]$Name
    )

    if ($null -eq $Object) {
        return $false
    }

    return $null -ne $Object.PSObject.Properties[$Name]
}

function Get-PropertyValue {
    param(
        [AllowNull()]
        [object]$Object,

        [Parameter(Mandatory = $true)]
        [string]$Name,

        [AllowNull()]
        [object]$DefaultValue = $null
    )

    if (-not (Test-HasProperty -Object $Object -Name $Name)) {
        return $DefaultValue
    }

    return $Object.PSObject.Properties[$Name].Value
}

function Normalize-StringArray {
    param(
        [AllowNull()]
        [object[]]$Items
    )

    $normalized = New-Object System.Collections.Generic.List[string]

    foreach ($item in @($Items)) {
        if ($null -eq $item) {
            continue
        }

        $text = [string]$item
        if ([string]::IsNullOrWhiteSpace($text)) {
            continue
        }

        $normalized.Add($text.Trim())
    }

    return @($normalized | Select-Object -Unique)
}

function Get-TopCounts {
    param(
        [AllowNull()]
        [object[]]$Items,

        [int]$Take = 10
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

function Read-JsonFile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    return (Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json)
}

function Get-ExecutionFilesTouched {
    param(
        [AllowNull()]
        [object]$ExecutionReport
    )

    $targets = @()

    foreach ($item in @(Get-PropertyValue -Object $ExecutionReport -Name "tool_call_log" -DefaultValue @())) {
        $tool = [string](Get-PropertyValue -Object $item -Name "tool" -DefaultValue "")
        $target = [string](Get-PropertyValue -Object $item -Name "target" -DefaultValue "")

        if ([string]::IsNullOrWhiteSpace($target)) {
            continue
        }

        if ($tool -like "file_*") {
            $targets += $target
        }
    }

    return @(Normalize-StringArray -Items $targets)
}

function New-NormalizedEvent {
    param(
        [Parameter(Mandatory = $true)]
        [string]$EventId,

        [Parameter(Mandatory = $true)]
        [string]$ObservedAtUtc,

        [Parameter(Mandatory = $true)]
        [string]$SourceType,

        [Parameter(Mandatory = $true)]
        [string]$SourcePath,

        [AllowNull()]
        [string]$RunId = $null,

        [AllowNull()]
        [string]$SessionId = $null,

        [AllowNull()]
        [string]$Project = $null,

        [AllowNull()]
        [string]$ProjectPath = $null,

        [AllowNull()]
        [string]$TaskCategory = $null,

        [AllowNull()]
        [string]$ClientSurface = $null,

        [AllowNull()]
        [string]$Model = $null,

        [AllowNull()]
        [string]$PipelineMode = $null,

        [AllowNull()]
        [object[]]$SelectedStackIds = @(),

        [AllowNull()]
        [object[]]$RecommendedStackIds = @(),

        [AllowNull()]
        [object[]]$RecommendedTaskOverlayIds = @(),

        [AllowNull()]
        [object]$RepoLocalSystemPresent = $null,

        [AllowNull()]
        [string]$QaVerdict = "unknown",

        [AllowNull()]
        [string]$Result = "unknown",

        [AllowNull()]
        [object[]]$FailureTags = @(),

        [AllowNull()]
        [object[]]$FilesTouched = @(),

        [AllowNull()]
        [object]$FollowUpNeeded = $null,

        [AllowNull()]
        [string]$PolicyVersionApplied = $null,

        [AllowNull()]
        [object[]]$HardFailSignals = @(),

        [AllowNull()]
        [object[]]$PositiveSignals = @(),

        [Parameter(Mandatory = $true)]
        [string]$AuthoritativeSuccessLabel
    )

    return [PSCustomObject]@{
        schema_version = 1
        event_id = $EventId
        observed_at_utc = $ObservedAtUtc
        source_type = $SourceType
        source_path = $SourcePath
        run_id = $RunId
        session_id = $SessionId
        project = $Project
        project_path = $ProjectPath
        task_category = $TaskCategory
        client_surface = $ClientSurface
        model = $Model
        pipeline_mode = $PipelineMode
        selected_stack_ids = @(Normalize-StringArray -Items $SelectedStackIds)
        recommended_stack_ids = @(Normalize-StringArray -Items $RecommendedStackIds)
        recommended_task_overlay_ids = @(Normalize-StringArray -Items $RecommendedTaskOverlayIds)
        repo_local_system_present = $RepoLocalSystemPresent
        qa_verdict = if ([string]::IsNullOrWhiteSpace($QaVerdict)) { "unknown" } else { $QaVerdict.ToLowerInvariant() }
        result = if ([string]::IsNullOrWhiteSpace($Result)) { "unknown" } else { $Result.ToLowerInvariant() }
        failure_tags = @(Normalize-StringArray -Items $FailureTags)
        files_touched = @(Normalize-StringArray -Items $FilesTouched)
        follow_up_needed = $FollowUpNeeded
        policy_version_applied = $PolicyVersionApplied
        hard_fail_signals = @(Normalize-StringArray -Items $HardFailSignals)
        positive_signals = @(Normalize-StringArray -Items $PositiveSignals)
        authoritative_success_label = $AuthoritativeSuccessLabel
    }
}

function Normalize-SessionEvents {
    param(
        [Parameter(Mandatory = $true)]
        [string]$InputPath
    )

    $events = @()

    if (-not (Test-Path -LiteralPath $InputPath)) {
        return @()
    }

    foreach ($line in Get-Content -LiteralPath $InputPath) {
        if ([string]::IsNullOrWhiteSpace($line)) {
            continue
        }

        $record = $line | ConvertFrom-Json
        $result = [string](Get-PropertyValue -Object $record -Name "Result" -DefaultValue "unknown")
        $hardFailSignals = @()
        $positiveSignals = @()
        $followUpNeeded = if (Test-HasProperty -Object $record -Name "FollowUpNeeded") { [bool](Get-PropertyValue -Object $record -Name "FollowUpNeeded") } else { $null }
        $failureTags = @((Get-PropertyValue -Object $record -Name "FailureTags" -DefaultValue @()))

        switch ($result) {
            "failed" {
                $hardFailSignals += "session_result_failed"
            }
            "abandoned" {
                $hardFailSignals += "session_result_abandoned"
            }
            "success" {
                $positiveSignals += "session_result_success"
            }
            "partial" {
                $positiveSignals += "session_result_partial"
            }
        }

        if ($followUpNeeded -eq $false) {
            $positiveSignals += "no_follow_up_needed"
        }

        $objectiveChecksPass = (
            $followUpNeeded -eq $false -and
            @($failureTags | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) }).Count -eq 0
        )
        $authoritativeLabel = if ($hardFailSignals.Count -gt 0) {
            "failed"
        } elseif ($result -eq "success" -and $objectiveChecksPass) {
            "success"
        } else {
            "unconfirmed"
        }

        $events += (New-NormalizedEvent `
            -EventId ("session:" + [string](Get-PropertyValue -Object $record -Name "SessionId")) `
            -ObservedAtUtc ([string](Get-PropertyValue -Object $record -Name "LoggedAtUtc" -DefaultValue (Get-Date).ToUniversalTime().ToString("o"))) `
            -SourceType "local_session" `
            -SourcePath $InputPath `
            -SessionId ([string](Get-PropertyValue -Object $record -Name "SessionId")) `
            -Project ([string](Get-PropertyValue -Object $record -Name "Project")) `
            -ProjectPath ([string](Get-PropertyValue -Object $record -Name "ProjectPath")) `
            -TaskCategory ([string](Get-PropertyValue -Object $record -Name "TaskCategory")) `
            -ClientSurface ([string](Get-PropertyValue -Object $record -Name "ClientSurface")) `
            -Model ([string](Get-PropertyValue -Object $record -Name "Model")) `
            -PipelineMode ([string](Get-PropertyValue -Object $record -Name "PipelineMode")) `
            -SelectedStackIds @((Get-PropertyValue -Object $record -Name "ActualSelectedStackIds" -DefaultValue @())) `
            -RecommendedStackIds @((Get-PropertyValue -Object $record -Name "RecommendedStackIds" -DefaultValue @())) `
            -RecommendedTaskOverlayIds @((Get-PropertyValue -Object $record -Name "RecommendedTaskOverlayIds" -DefaultValue @())) `
            -RepoLocalSystemPresent (Get-PropertyValue -Object $record -Name "RepoLocalSystemPresent") `
            -QaVerdict "unknown" `
            -Result $result `
            -FailureTags $failureTags `
            -FilesTouched @((Get-PropertyValue -Object $record -Name "FilesTouched" -DefaultValue @())) `
            -FollowUpNeeded $followUpNeeded `
            -PolicyVersionApplied ([string](Get-PropertyValue -Object $record -Name "PolicyVersionApplied")) `
            -HardFailSignals $hardFailSignals `
            -PositiveSignals $positiveSignals `
            -AuthoritativeSuccessLabel $authoritativeLabel)
    }

    return $events
}

function Get-LatestQaVerdictPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RunDir
    )

    $pattern = '^03_qa_verdict_v(\d+)\.json$'
    $candidates = @(
        Get-ChildItem -LiteralPath $RunDir -Filter "03_qa_verdict_v*.json" -File |
            Where-Object { $_.Name -match $pattern } |
            Sort-Object { [int]([regex]::Match($_.Name, $pattern).Groups[1].Value) } -Descending
    )

    return @($candidates | Select-Object -First 1)
}

function Normalize-RunBundleEvents {
    param(
        [Parameter(Mandatory = $true)]
        [string]$BundlesRoot
    )

    $events = @()

    if (-not (Test-Path -LiteralPath $BundlesRoot)) {
        return @()
    }

    $runDirs = @(
        Get-ChildItem -LiteralPath $BundlesRoot -Directory |
            Where-Object { $_.Name -notlike "local-learning*" } |
            Sort-Object Name
    )

    foreach ($runDir in $runDirs) {
        $manifestPath = Join-Path $runDir.FullName "01_manifest.json"
        $executionPath = Join-Path $runDir.FullName "04_execution_report.json"
        $qaVerdictFile = Get-LatestQaVerdictPath -RunDir $runDir.FullName

        if (-not (Test-Path -LiteralPath $manifestPath) -and $null -eq $qaVerdictFile -and -not (Test-Path -LiteralPath $executionPath)) {
            continue
        }

        $manifest = if (Test-Path -LiteralPath $manifestPath) { Read-JsonFile -Path $manifestPath } else { $null }
        $execution = if (Test-Path -LiteralPath $executionPath) { Read-JsonFile -Path $executionPath } else { $null }
        $qaVerdict = if ($null -ne $qaVerdictFile) { Read-JsonFile -Path $qaVerdictFile.FullName } else { $null }

        $verdictText = [string](Get-PropertyValue -Object $qaVerdict -Name "verdict" -DefaultValue "unknown")
        $executionStatus = [string](Get-PropertyValue -Object $execution -Name "status" -DefaultValue "unknown")
        $hardFailSignals = @()
        $positiveSignals = @()

        if ($verdictText -eq "REJECT") {
            $hardFailSignals += "qa_reject"
        }
        if ($verdictText -eq "PASS") {
            $positiveSignals += "qa_pass"
        }
        if ($executionStatus -eq "EXECUTION_COMPLETE") {
            $positiveSignals += "execution_complete"
        }

        $authoritativeLabel = if ($hardFailSignals.Count -gt 0) {
            "failed"
        } elseif ($verdictText -eq "PASS" -and $executionStatus -eq "EXECUTION_COMPLETE") {
            "success"
        } else {
            "unconfirmed"
        }
        $normalizedResult = if ($executionStatus -eq "EXECUTION_COMPLETE") { "success" } else { "unknown" }

        $analysis = Get-PropertyValue -Object $manifest -Name "analysis"
        $workerConfig = Get-PropertyValue -Object $manifest -Name "worker_configuration"

        $events += (New-NormalizedEvent `
            -EventId ("bundle:" + $runDir.Name) `
            -ObservedAtUtc ($runDir.LastWriteTimeUtc.ToString("o")) `
            -SourceType "evidence_bundle" `
            -SourcePath $runDir.FullName `
            -RunId $runDir.Name `
            -Project ([string](Get-PropertyValue -Object $manifest -Name "target_project")) `
            -ProjectPath ([string](Get-PropertyValue -Object $manifest -Name "target_project_path")) `
            -TaskCategory ([string](Get-PropertyValue -Object $analysis -Name "task_category")) `
            -Model ([string](Get-PropertyValue -Object $workerConfig -Name "assigned_model")) `
            -PipelineMode ([string](Get-PropertyValue -Object $analysis -Name "pipeline_mode")) `
            -SelectedStackIds @() `
            -RecommendedStackIds @() `
            -RecommendedTaskOverlayIds @() `
            -RepoLocalSystemPresent $null `
            -QaVerdict $verdictText `
            -Result $normalizedResult `
            -FailureTags @((Get-PropertyValue -Object $qaVerdict -Name "failures" -DefaultValue @()) | ForEach-Object { Get-PropertyValue -Object $_ -Name "tag" }) `
            -FilesTouched @(Get-ExecutionFilesTouched -ExecutionReport $execution) `
            -FollowUpNeeded $null `
            -PolicyVersionApplied $null `
            -HardFailSignals $hardFailSignals `
            -PositiveSignals $positiveSignals `
            -AuthoritativeSuccessLabel $authoritativeLabel)
    }

    return $events
}

function Normalize-ComparisonEvents {
    param(
        [Parameter(Mandatory = $true)]
        [string]$CasesPath,

        [Parameter(Mandatory = $true)]
        [string]$RootPath
    )

    if (-not (Test-Path -LiteralPath $CasesPath)) {
        return @()
    }

    $comparisonJson = powershell -ExecutionPolicy Bypass -File $scoreComparisonPath -InputPath $CasesPath -Format json -Root $RootPath | Out-String
    if ($LASTEXITCODE -ne 0) {
        throw "score-comparison-results.ps1 exited with code $LASTEXITCODE"
    }

    $summary = $comparisonJson | ConvertFrom-Json
    $events = @()
    $observedAtUtc = (Get-Item -LiteralPath $CasesPath).LastWriteTimeUtc.ToString("o")

    foreach ($result in @($summary.Results)) {
        $winnerCandidate = @($result.RankedCandidates | Where-Object { $_.CandidateId -eq $result.WinnerId } | Select-Object -First 1)
        if ($winnerCandidate.Count -eq 0) {
            continue
        }

        $winner = $winnerCandidate[0]
        $positiveSignals = @(
            "comparison_winner",
            ("decision_rule:" + [string]$result.DecisionRule)
        )

        $events += (New-NormalizedEvent `
            -EventId ("comparison:" + [string]$result.Id) `
            -ObservedAtUtc $observedAtUtc `
            -SourceType "comparison_result" `
            -SourcePath $CasesPath `
            -SessionId ([string]$winner.SessionId) `
            -Project ([string]$result.Project) `
            -TaskCategory ([string]$result.TaskCategory) `
            -ClientSurface ([string]$winner.ClientSurface) `
            -Model ([string]$winner.Model) `
            -SelectedStackIds @($winner.SelectedStackIds) `
            -RecommendedStackIds @() `
            -RecommendedTaskOverlayIds @() `
            -RepoLocalSystemPresent $null `
            -QaVerdict "unknown" `
            -Result "success" `
            -FailureTags @() `
            -FilesTouched @() `
            -FollowUpNeeded $false `
            -PolicyVersionApplied $null `
            -HardFailSignals @() `
            -PositiveSignals $positiveSignals `
            -AuthoritativeSuccessLabel "success")
    }

    return $events
}

$events = @()
foreach ($event in @(Normalize-SessionEvents -InputPath $SessionLogPath)) {
    $events += $event
}
foreach ($event in @(Normalize-RunBundleEvents -BundlesRoot $RunBundlesRoot)) {
    $events += $event
}
if (-not [string]::IsNullOrWhiteSpace($ComparisonInputPath)) {
    foreach ($event in @(Normalize-ComparisonEvents -CasesPath $ComparisonInputPath -RootPath $Root)) {
        $events += $event
    }
}

$outputDir = Split-Path -Path $OutputPath -Parent
if (-not [string]::IsNullOrWhiteSpace($outputDir)) {
    New-Item -ItemType Directory -Force -Path $outputDir | Out-Null
}

$jsonLines = @($events | ForEach-Object { $_ | ConvertTo-Json -Depth 8 -Compress })
Set-Content -LiteralPath $OutputPath -Value $jsonLines

$sourceCounts = @(Get-TopCounts -Items @($events | ForEach-Object { $_.source_type }))
$labelCounts = @(Get-TopCounts -Items @($events | ForEach-Object { $_.authoritative_success_label }))

$summary = [PSCustomObject]@{
    SchemaVersion = 1
    OutputPath = $OutputPath
    EventCount = $events.Count
    SourceCounts = $sourceCounts
    AuthoritativeSuccessLabelCounts = $labelCounts
}

if ($Format -eq "json") {
    $summary | ConvertTo-Json -Depth 8
    exit 0
}

Write-Host ""
Write-Host "Local evidence normalization complete." -ForegroundColor Cyan
Write-Host "Output path: $OutputPath"
Write-Host "Normalized events: $($summary.EventCount)"
Write-Host "Source counts:" -ForegroundColor Yellow
foreach ($item in $summary.SourceCounts) {
    Write-Host "  - $($item.Name): $($item.Count)"
}
Write-Host "Authoritative success labels:" -ForegroundColor Yellow
foreach ($item in $summary.AuthoritativeSuccessLabelCounts) {
    Write-Host "  - $($item.Name): $($item.Count)"
}
