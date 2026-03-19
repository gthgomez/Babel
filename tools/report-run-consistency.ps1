[CmdletBinding()]
param(
    [string]$RunsRoot = "",

    [string]$LocalLearningRoot = "",

    [int]$Top = 20,

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

if ([string]::IsNullOrWhiteSpace($RunsRoot)) {
    $RunsRoot = Join-Path $Root "runs"
} elseif (-not [System.IO.Path]::IsPathRooted($RunsRoot)) {
    $RunsRoot = Join-Path $Root $RunsRoot
}

if ([string]::IsNullOrWhiteSpace($LocalLearningRoot)) {
    $LocalLearningRoot = Join-Path $RunsRoot "local-learning"
} elseif (-not [System.IO.Path]::IsPathRooted($LocalLearningRoot)) {
    $LocalLearningRoot = Join-Path $Root $LocalLearningRoot
}

if ($Top -lt 1) {
    throw "Top must be at least 1."
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

    if ($null -eq $Object) {
        return $DefaultValue
    }

    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) {
        return $DefaultValue
    }

    return $property.Value
}

function Read-JsonFile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    return (Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json)
}

function Get-RunDayUtc {
    param(
        [Parameter(Mandatory = $true)]
        [System.IO.DirectoryInfo]$RunDir
    )

    $match = [regex]::Match($RunDir.Name, '^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})')
    if ($match.Success) {
        return "{0}-{1}-{2}" -f $match.Groups[1].Value, $match.Groups[2].Value, $match.Groups[3].Value
    }

    return $RunDir.LastWriteTimeUtc.ToString("yyyy-MM-dd")
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

function Get-BundleStage {
    param(
        [bool]$HasManifest,
        [bool]$HasPlan,
        [bool]$HasQa,
        [bool]$HasExec,
        [string]$QaVerdict,
        [string]$ExecStatus
    )

    if (-not $HasManifest -and -not $HasQa -and -not $HasExec) {
        return "stub"
    }

    if ($HasExec) {
        if ($QaVerdict -eq "PASS" -and $ExecStatus -eq "EXECUTION_COMPLETE") {
            return "qa_pass_exec_complete"
        }

        if ($QaVerdict -eq "PASS" -and $ExecStatus -eq "EXECUTION_HALTED") {
            return "qa_pass_exec_halted"
        }

        if ($QaVerdict -eq "REJECT" -and $ExecStatus -eq "EXECUTION_COMPLETE") {
            return "qa_reject_exec_complete_violation"
        }

        if ($QaVerdict -eq "REJECT" -and $ExecStatus -eq "EXECUTION_HALTED") {
            return "qa_reject_exec_halted"
        }

        if (-not $HasQa) {
            return "exec_without_qa_violation"
        }

        return "exec_with_nonterminal_state"
    }

    if ($HasQa) {
        if ($QaVerdict -eq "PASS") {
            return "qa_pass_no_exec"
        }

        if ($QaVerdict -eq "REJECT") {
            return "qa_reject_no_exec"
        }

        return "qa_unknown_no_exec"
    }

    if ($HasPlan) {
        return "plan_only"
    }

    if ($HasManifest) {
        return "manifest_only"
    }

    return "unknown"
}

function Is-PartialArtifactStage {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Stage
    )

    return $Stage -in @(
        "manifest_only",
        "plan_only",
        "qa_pass_no_exec",
        "qa_reject_no_exec",
        "qa_unknown_no_exec"
    )
}

function New-CorrelationKey {
    param(
        [Parameter(Mandatory = $true)]
        [string]$DayUtc,

        [Parameter(Mandatory = $true)]
        [string]$Project,

        [Parameter(Mandatory = $true)]
        [string]$Model
    )

    return ("{0}|{1}|{2}" -f $DayUtc.Trim(), $Project.Trim().ToLowerInvariant(), $Model.Trim().ToLowerInvariant())
}

function Add-GroupCount {
    param(
        [Parameter(Mandatory = $true)]
        [hashtable]$Map,

        [Parameter(Mandatory = $true)]
        [string]$Key
    )

    if ($Map.ContainsKey($Key)) {
        $Map[$Key] = [int]$Map[$Key] + 1
    } else {
        $Map[$Key] = 1
    }
}

function Get-GroupCount {
    param(
        [Parameter(Mandatory = $true)]
        [hashtable]$Map,

        [Parameter(Mandatory = $true)]
        [string]$Key
    )

    if ($Map.ContainsKey($Key)) {
        return [int]$Map[$Key]
    }

    return 0
}

if (-not (Test-Path -LiteralPath $RunsRoot)) {
    throw "Runs root not found: $RunsRoot"
}

$startCounts = @{}
$endCounts = @{}
$logCounts = @{}

$sessionStartRoot = Join-Path $LocalLearningRoot "session-starts"
if (Test-Path -LiteralPath $sessionStartRoot) {
    foreach ($path in Get-ChildItem -Path $sessionStartRoot -Recurse -File -Filter *.json) {
        $record = Read-JsonFile -Path $path.FullName
        $dayUtc = [string](Get-PropertyValue -Object $record -Name "StartedAtUtc" -DefaultValue "")
        if ([string]::IsNullOrWhiteSpace($dayUtc)) {
            $dayUtc = Split-Path -Path $path.DirectoryName -Leaf
        } else {
            $dayUtc = ([datetime]$dayUtc).ToUniversalTime().ToString("yyyy-MM-dd")
        }

        $project = [string](Get-PropertyValue -Object $record -Name "Project" -DefaultValue "(unknown)")
        $model = [string](Get-PropertyValue -Object $record -Name "Model" -DefaultValue "(unknown)")
        Add-GroupCount -Map $startCounts -Key (New-CorrelationKey -DayUtc $dayUtc -Project $project -Model $model)
    }
}

$sessionEndRoot = Join-Path $LocalLearningRoot "session-ends"
if (Test-Path -LiteralPath $sessionEndRoot) {
    foreach ($path in Get-ChildItem -Path $sessionEndRoot -Recurse -File -Filter *.json) {
        $record = Read-JsonFile -Path $path.FullName
        $dayUtc = [string](Get-PropertyValue -Object $record -Name "EndedAtUtc" -DefaultValue "")
        if ([string]::IsNullOrWhiteSpace($dayUtc)) {
            $dayUtc = Split-Path -Path $path.DirectoryName -Leaf
        } else {
            $dayUtc = ([datetime]$dayUtc).ToUniversalTime().ToString("yyyy-MM-dd")
        }

        $sessionStartPath = [string](Get-PropertyValue -Object $record -Name "SessionStartPath" -DefaultValue "")
        $project = "(unknown)"
        $model = "(unknown)"
        if (-not [string]::IsNullOrWhiteSpace($sessionStartPath) -and (Test-Path -LiteralPath $sessionStartPath)) {
            $startRecord = Read-JsonFile -Path $sessionStartPath
            $project = [string](Get-PropertyValue -Object $startRecord -Name "Project" -DefaultValue "(unknown)")
            $model = [string](Get-PropertyValue -Object $startRecord -Name "Model" -DefaultValue "(unknown)")
        }

        Add-GroupCount -Map $endCounts -Key (New-CorrelationKey -DayUtc $dayUtc -Project $project -Model $model)
    }
}

$sessionLogPath = Join-Path $LocalLearningRoot "session-log.jsonl"
if (Test-Path -LiteralPath $sessionLogPath) {
    foreach ($line in Get-Content -LiteralPath $sessionLogPath) {
        if ([string]::IsNullOrWhiteSpace($line)) {
            continue
        }

        $record = $line | ConvertFrom-Json
        $loggedAtUtc = [string](Get-PropertyValue -Object $record -Name "LoggedAtUtc" -DefaultValue "")
        $dayUtc = if ([string]::IsNullOrWhiteSpace($loggedAtUtc)) {
            "(unknown)"
        } else {
            ([datetime]$loggedAtUtc).ToUniversalTime().ToString("yyyy-MM-dd")
        }

        $project = [string](Get-PropertyValue -Object $record -Name "Project" -DefaultValue "(unknown)")
        $model = [string](Get-PropertyValue -Object $record -Name "Model" -DefaultValue "(unknown)")
        Add-GroupCount -Map $logCounts -Key (New-CorrelationKey -DayUtc $dayUtc -Project $project -Model $model)
    }
}

$runRecords = New-Object System.Collections.Generic.List[object]

foreach ($runDir in Get-ChildItem -LiteralPath $RunsRoot -Directory | Where-Object { $_.Name -notlike "local-learning*" } | Sort-Object Name) {
    $manifestPath = Join-Path $runDir.FullName "01_manifest.json"
    $planPath = Join-Path $runDir.FullName "02_swe_plan_v1.json"
    $executionPath = Join-Path $runDir.FullName "04_execution_report.json"
    $qaVerdictFile = Get-LatestQaVerdictPath -RunDir $runDir.FullName

    $hasManifest = Test-Path -LiteralPath $manifestPath
    $hasPlan = Test-Path -LiteralPath $planPath
    $hasExec = Test-Path -LiteralPath $executionPath
    $hasQa = $null -ne $qaVerdictFile

    $manifest = if ($hasManifest) { Read-JsonFile -Path $manifestPath } else { $null }
    $analysis = Get-PropertyValue -Object $manifest -Name "analysis"
    $workerConfiguration = Get-PropertyValue -Object $manifest -Name "worker_configuration"
    $execution = if ($hasExec) { Read-JsonFile -Path $executionPath } else { $null }
    $qaVerdict = if ($hasQa) { Read-JsonFile -Path $qaVerdictFile.FullName } else { $null }

    $project = [string](Get-PropertyValue -Object $manifest -Name "target_project" -DefaultValue "(unknown)")
    if ([string]::IsNullOrWhiteSpace($project)) {
        $project = "(unknown)"
    }

    $model = [string](Get-PropertyValue -Object $workerConfiguration -Name "assigned_model" -DefaultValue "(unknown)")
    if ([string]::IsNullOrWhiteSpace($model)) {
        $model = "(unknown)"
    }

    $dayUtc = Get-RunDayUtc -RunDir $runDir
    $qaVerdictText = [string](Get-PropertyValue -Object $qaVerdict -Name "verdict" -DefaultValue "unknown")
    $execStatus = [string](Get-PropertyValue -Object $execution -Name "status" -DefaultValue "unknown")
    $stage = Get-BundleStage `
        -HasManifest $hasManifest `
        -HasPlan $hasPlan `
        -HasQa $hasQa `
        -HasExec $hasExec `
        -QaVerdict $qaVerdictText `
        -ExecStatus $execStatus

    $correlationKey = New-CorrelationKey -DayUtc $dayUtc -Project $project -Model $model

    $runRecords.Add([PSCustomObject]@{
        RunId = $runDir.Name
        RunDir = $runDir.FullName
        DayUtc = $dayUtc
        Project = $project
        Model = $model
        TaskCategory = [string](Get-PropertyValue -Object $analysis -Name "task_category" -DefaultValue "")
        PipelineMode = [string](Get-PropertyValue -Object $analysis -Name "pipeline_mode" -DefaultValue "")
        HasManifest = $hasManifest
        HasPlan = $hasPlan
        HasQa = $hasQa
        HasExec = $hasExec
        QaVerdict = $qaVerdictText
        ExecStatus = $execStatus
        BundleStage = $stage
        IsQualifying = ($hasManifest -or $hasQa -or $hasExec)
        IsPartialArtifact = (Is-PartialArtifactStage -Stage $stage)
        CorrelationKey = $correlationKey
    })
}

$runArray = @($runRecords.ToArray())
$qualifyingRuns = @($runArray | Where-Object { $_.IsQualifying })
$partialRuns = @($qualifyingRuns | Where-Object { $_.IsPartialArtifact })
$qaGateViolations = @($qualifyingRuns | Where-Object { $_.BundleStage -eq "qa_reject_exec_complete_violation" })
$execWithoutQaViolations = @($qualifyingRuns | Where-Object { $_.BundleStage -eq "exec_without_qa_violation" })

$groupMap = @{}
foreach ($record in $qualifyingRuns) {
    if (-not $groupMap.ContainsKey($record.CorrelationKey)) {
        $groupMap[$record.CorrelationKey] = [PSCustomObject]@{
            DayUtc = $record.DayUtc
            Project = $record.Project
            Model = $record.Model
            RawBundleCount = 0
            PartialBundleCount = 0
            QaGateViolationCount = 0
            ExecWithoutQaViolationCount = 0
            BundleStages = New-Object System.Collections.Generic.List[string]
        }
    }

    $group = $groupMap[$record.CorrelationKey]
    $group.RawBundleCount++
    if ($record.IsPartialArtifact) {
        $group.PartialBundleCount++
    }
    if ($record.BundleStage -eq "qa_reject_exec_complete_violation") {
        $group.QaGateViolationCount++
    }
    if ($record.BundleStage -eq "exec_without_qa_violation") {
        $group.ExecWithoutQaViolationCount++
    }
    $group.BundleStages.Add($record.BundleStage)
}

$groupRows = foreach ($key in $groupMap.Keys) {
    $group = $groupMap[$key]
    $startCount = Get-GroupCount -Map $startCounts -Key $key
    $endCount = Get-GroupCount -Map $endCounts -Key $key
    $logCount = Get-GroupCount -Map $logCounts -Key $key

    [PSCustomObject]@{
        DayUtc = $group.DayUtc
        Project = $group.Project
        Model = $group.Model
        RawBundleCount = $group.RawBundleCount
        PartialBundleCount = $group.PartialBundleCount
        QaGateViolationCount = $group.QaGateViolationCount
        ExecWithoutQaViolationCount = $group.ExecWithoutQaViolationCount
        SessionStartCount = $startCount
        SessionEndCount = $endCount
        SessionLogCount = $logCount
        MissingStartCoverage = [Math]::Max(0, $group.RawBundleCount - $startCount)
        MissingEndCoverage = [Math]::Max(0, $group.RawBundleCount - $endCount)
        MissingLogCoverage = [Math]::Max(0, $group.RawBundleCount - $logCount)
        BundleStages = @($group.BundleStages | Group-Object | Sort-Object Count -Descending | ForEach-Object {
            [PSCustomObject]@{
                Name = $_.Name
                Count = $_.Count
            }
        })
    }
}

$lifecycleGapGroups = @(
    $groupRows |
        Where-Object {
            $_.MissingStartCoverage -gt 0 -or
            $_.MissingEndCoverage -gt 0 -or
            $_.MissingLogCoverage -gt 0
        } |
        Sort-Object -Property DayUtc, Project, Model |
        Select-Object -First $Top
)

$orphanedPartialRunGroups = @(
    $groupRows |
        Where-Object {
            $_.PartialBundleCount -gt 0 -and (
                $_.MissingStartCoverage -gt 0 -or
                $_.MissingEndCoverage -gt 0 -or
                $_.MissingLogCoverage -gt 0
            )
        } |
        Sort-Object -Property DayUtc, Project, Model |
        Select-Object -First $Top
)

$summary = [PSCustomObject]@{
    TotalRunDirectories = $runArray.Count
    QualifyingRunBundles = $qualifyingRuns.Count
    PartialArtifactBundles = $partialRuns.Count
    QaGateViolations = $qaGateViolations.Count
    ExecWithoutQaViolations = $execWithoutQaViolations.Count
    LifecycleGapGroups = $lifecycleGapGroups.Count
    OrphanedPartialRunGroups = $orphanedPartialRunGroups.Count
    SessionStartArtifactCount = if (Test-Path -LiteralPath $sessionStartRoot) { @(Get-ChildItem -Path $sessionStartRoot -Recurse -File -Filter *.json).Count } else { 0 }
    SessionEndArtifactCount = if (Test-Path -LiteralPath $sessionEndRoot) { @(Get-ChildItem -Path $sessionEndRoot -Recurse -File -Filter *.json).Count } else { 0 }
    SessionLogPresent = (Test-Path -LiteralPath $sessionLogPath)
    CorrelationMethod = "UTC day + project + model fallback. Legacy bundles lack SessionId; newer bundles may carry SessionId via manifest."
}

$report = [PSCustomObject]@{
    SchemaVersion = 1
    GeneratedAtUtc = (Get-Date).ToUniversalTime().ToString("o")
    RunsRoot = $RunsRoot
    LocalLearningRoot = $LocalLearningRoot
    Summary = $summary
    ProtocolViolations = [PSCustomObject]@{
        QaRejectExecComplete = @($qaGateViolations | Select-Object RunId, DayUtc, Project, Model, PipelineMode, QaVerdict, ExecStatus)
        ExecWithoutQa = @($execWithoutQaViolations | Select-Object RunId, DayUtc, Project, Model, PipelineMode, QaVerdict, ExecStatus)
    }
    LifecycleGapGroups = @($lifecycleGapGroups)
    OrphanedPartialRunGroups = @($orphanedPartialRunGroups)
}

if ($Format -eq "json") {
    $report | ConvertTo-Json -Depth 8
    return
}

Write-Host ""
Write-Host "Babel run consistency report" -ForegroundColor Cyan
Write-Host "Correlation: $($summary.CorrelationMethod)"
Write-Host "Runs root: $RunsRoot"
Write-Host "Local learning root: $LocalLearningRoot"
Write-Host "Qualifying run bundles: $($summary.QualifyingRunBundles) / $($summary.TotalRunDirectories)"
Write-Host "Partial artifact bundles: $($summary.PartialArtifactBundles)"
Write-Host "QA gate violations: $($summary.QaGateViolations)"
Write-Host "Exec-without-QA violations: $($summary.ExecWithoutQaViolations)"
Write-Host "Session start artifacts: $($summary.SessionStartArtifactCount)"
Write-Host "Session end artifacts: $($summary.SessionEndArtifactCount)"
Write-Host "Session log present: $($summary.SessionLogPresent)"

if ($report.ProtocolViolations.QaRejectExecComplete.Count -gt 0) {
    Write-Host ""
    Write-Host "QA reject -> exec complete violations:" -ForegroundColor Yellow
    $report.ProtocolViolations.QaRejectExecComplete | Format-Table -AutoSize
}

if ($lifecycleGapGroups.Count -gt 0) {
    Write-Host ""
    Write-Host "Lifecycle gap groups:" -ForegroundColor Yellow
    $lifecycleGapGroups |
        Select-Object DayUtc, Project, Model, RawBundleCount, SessionStartCount, SessionEndCount, SessionLogCount, MissingStartCoverage, MissingEndCoverage, MissingLogCoverage |
        Format-Table -AutoSize
}

if ($orphanedPartialRunGroups.Count -gt 0) {
    Write-Host ""
    Write-Host "Orphaned partial run groups:" -ForegroundColor Yellow
    $orphanedPartialRunGroups |
        Select-Object DayUtc, Project, Model, RawBundleCount, PartialBundleCount, MissingStartCoverage, MissingEndCoverage, MissingLogCoverage |
        Format-Table -AutoSize
}
