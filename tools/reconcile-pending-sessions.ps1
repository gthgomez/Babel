[CmdletBinding()]
param(
    [string]$RunsRoot = "",

    [string]$LocalLearningRoot = "",

    [int]$TimeoutMinutes = 60,

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

if ($TimeoutMinutes -lt 1) {
    throw "TimeoutMinutes must be at least 1."
}

if (-not (Test-Path -LiteralPath $RunsRoot)) {
    throw "Runs root not found: $RunsRoot"
}

New-Item -ItemType Directory -Force -Path $LocalLearningRoot | Out-Null

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

function Read-JsonLines {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    $records = New-Object System.Collections.Generic.List[object]
    if (-not (Test-Path -LiteralPath $Path)) {
        return @()
    }

    foreach ($line in Get-Content -LiteralPath $Path) {
        if ([string]::IsNullOrWhiteSpace($line)) {
            continue
        }

        $records.Add(($line | ConvertFrom-Json))
    }

    return @($records.ToArray())
}

function Append-JsonLine {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,

        [Parameter(Mandatory = $true)]
        [object]$Record
    )

    $parent = Split-Path -Path $Path -Parent
    if (-not [string]::IsNullOrWhiteSpace($parent)) {
        New-Item -ItemType Directory -Force -Path $parent | Out-Null
    }

    Add-Content -Path $Path -Value ($Record | ConvertTo-Json -Depth 8 -Compress)
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

function Resolve-UtcTimestamp {
    param(
        [Parameter(Mandatory = $true)]
        [AllowNull()]
        [object]$Value,

        [AllowNull()]
        [object]$Fallback = $null
    )

    if ($null -eq $Value -or [string]::IsNullOrWhiteSpace([string]$Value)) {
        return $Fallback
    }

    return ([datetime]$Value).ToUniversalTime()
}

function Get-ObservedAgeMinutes {
    param(
        [Parameter(Mandatory = $true)]
        [datetime]$ObservedAtUtc,

        [Parameter(Mandatory = $true)]
        [datetime]$NowUtc
    )

    return [int][Math]::Floor(($NowUtc - $ObservedAtUtc).TotalMinutes)
}

function Get-RunObservedAtUtc {
    param(
        [Parameter(Mandatory = $true)]
        [System.IO.DirectoryInfo]$RunDir
    )

    $match = [regex]::Match($RunDir.Name, '^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})')
    if ($match.Success) {
        return [datetime]::SpecifyKind(
            [datetime]::ParseExact(
                ($match.Groups[1].Value + $match.Groups[2].Value + $match.Groups[3].Value + $match.Groups[4].Value + $match.Groups[5].Value + $match.Groups[6].Value),
                'yyyyMMddHHmmss',
                [System.Globalization.CultureInfo]::InvariantCulture
            ),
            [System.DateTimeKind]::Utc
        )
    }

    return $RunDir.LastWriteTimeUtc
}

function Get-LatestQaVerdictPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RunDir
    )

    $pattern = '^03_qa_verdict_v(\d+)\.json$'
    $matches = @(
        Get-ChildItem -LiteralPath $RunDir -File -Filter "03_qa_verdict_v*.json" |
            Where-Object { $_.Name -match $pattern } |
            Sort-Object { [int]([regex]::Match($_.Name, $pattern).Groups[1].Value) } -Descending
    )

    return @($matches | Select-Object -First 1)
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

function Is-TimeoutEligibleBundleStage {
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

function New-ViolationRecord {
    param(
        [Parameter(Mandatory = $true)]
        [string]$EventType,

        [Parameter(Mandatory = $true)]
        [string]$Status,

        [Parameter(Mandatory = $true)]
        [string]$ViolationId,

        [Parameter(Mandatory = $true)]
        [string]$ViolationType,

        [Parameter(Mandatory = $true)]
        [string]$ScopeType,

        [Parameter(Mandatory = $true)]
        [string]$Severity,

        [Parameter(Mandatory = $true)]
        [string]$Condition,

        [Parameter(Mandatory = $true)]
        [datetime]$RecordedAtUtc,

        [AllowNull()]
        [hashtable]$Fields = @{}
    )

    $record = [ordered]@{
        SchemaVersion = 1
        RecordedAtUtc = $RecordedAtUtc.ToString("o")
        EventType = $EventType
        Status = $Status
        ObservedBy = "tools/reconcile-pending-sessions.ps1"
        ViolationId = $ViolationId
        ViolationType = $ViolationType
        ScopeType = $ScopeType
        Severity = $Severity
        Condition = $Condition
    }

    foreach ($key in $Fields.Keys) {
        $record[$key] = $Fields[$key]
    }

    return [PSCustomObject]$record
}

function Get-SeverityRank {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Severity
    )

    $rank = switch ($Severity) {
        "high" { 3 }
        "medium" { 2 }
        "low" { 1 }
        default { 0 }
    }

    return $rank
}

$nowUtc = (Get-Date).ToUniversalTime()
$protocolViolationsPath = Join-Path $LocalLearningRoot "protocol-violations.jsonl"

$sessionStartsById = @{}
$sessionStartRoot = Join-Path $LocalLearningRoot "session-starts"
if (Test-Path -LiteralPath $sessionStartRoot) {
    foreach ($path in Get-ChildItem -Path $sessionStartRoot -Recurse -File -Filter *.json) {
        $record = Read-JsonFile -Path $path.FullName
        $sessionId = [string](Get-PropertyValue -Object $record -Name "SessionId" -DefaultValue "")
        if ([string]::IsNullOrWhiteSpace($sessionId)) {
            continue
        }

        $sessionStartsById[$sessionId] = [PSCustomObject]@{
            SessionId = $sessionId
            Path = $path.FullName
            StartedAtUtc = Resolve-UtcTimestamp -Value (Get-PropertyValue -Object $record -Name "StartedAtUtc")
            Project = [string](Get-PropertyValue -Object $record -Name "Project" -DefaultValue "global")
            Model = [string](Get-PropertyValue -Object $record -Name "Model" -DefaultValue "(unknown)")
        }
    }
}

$sessionEndsById = @{}
$sessionEndRoot = Join-Path $LocalLearningRoot "session-ends"
if (Test-Path -LiteralPath $sessionEndRoot) {
    foreach ($path in Get-ChildItem -Path $sessionEndRoot -Recurse -File -Filter *.json) {
        $record = Read-JsonFile -Path $path.FullName
        $sessionId = [string](Get-PropertyValue -Object $record -Name "SessionId" -DefaultValue "")
        if ([string]::IsNullOrWhiteSpace($sessionId)) {
            continue
        }

        $sessionEndsById[$sessionId] = [PSCustomObject]@{
            SessionId = $sessionId
            Path = $path.FullName
            EndedAtUtc = Resolve-UtcTimestamp -Value (Get-PropertyValue -Object $record -Name "EndedAtUtc")
        }
    }
}

$sessionLogsById = @{}
$sessionLogPath = Join-Path $LocalLearningRoot "session-log.jsonl"
foreach ($record in Read-JsonLines -Path $sessionLogPath) {
    $sessionId = [string](Get-PropertyValue -Object $record -Name "SessionId" -DefaultValue "")
    if ([string]::IsNullOrWhiteSpace($sessionId)) {
        continue
    }

    $sessionLogsById[$sessionId] = [PSCustomObject]@{
        SessionId = $sessionId
        LoggedAtUtc = Resolve-UtcTimestamp -Value (Get-PropertyValue -Object $record -Name "LoggedAtUtc")
        Result = [string](Get-PropertyValue -Object $record -Name "Result" -DefaultValue "")
        Project = [string](Get-PropertyValue -Object $record -Name "Project" -DefaultValue "global")
        Model = [string](Get-PropertyValue -Object $record -Name "Model" -DefaultValue "(unknown)")
        SessionLogPath = $sessionLogPath
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

    if (-not ($hasManifest -or $hasQa -or $hasExec)) {
        continue
    }

    $manifest = if ($hasManifest) { Read-JsonFile -Path $manifestPath } else { $null }
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

    $qaVerdictText = [string](Get-PropertyValue -Object $qaVerdict -Name "verdict" -DefaultValue "unknown")
    $execStatus = [string](Get-PropertyValue -Object $execution -Name "status" -DefaultValue "unknown")
    $bundleStage = Get-BundleStage `
        -HasManifest $hasManifest `
        -HasPlan $hasPlan `
        -HasQa $hasQa `
        -HasExec $hasExec `
        -QaVerdict $qaVerdictText `
        -ExecStatus $execStatus

    $observedAtUtc = Get-RunObservedAtUtc -RunDir $runDir
    $ageMinutes = Get-ObservedAgeMinutes -ObservedAtUtc $observedAtUtc -NowUtc $nowUtc
    $sessionId = [string](Get-PropertyValue -Object $manifest -Name "session_id" -DefaultValue "")
    $manifestSessionStartPath = [string](Get-PropertyValue -Object $manifest -Name "session_start_path" -DefaultValue "")

    $runRecords.Add([PSCustomObject]@{
        RunId = $runDir.Name
        RunDir = $runDir.FullName
        ManifestPath = if ($hasManifest) { $manifestPath } else { $null }
        PlanPath = if ($hasPlan) { $planPath } else { $null }
        QaVerdictPath = if ($hasQa) { $qaVerdictFile.FullName } else { $null }
        ExecutionPath = if ($hasExec) { $executionPath } else { $null }
        SessionId = if ([string]::IsNullOrWhiteSpace($sessionId)) { $null } else { $sessionId }
        ManifestSessionStartPath = if ([string]::IsNullOrWhiteSpace($manifestSessionStartPath)) { $null } else { $manifestSessionStartPath }
        Project = $project
        Model = $model
        BundleStage = $bundleStage
        QaVerdict = $qaVerdictText
        ExecStatus = $execStatus
        ObservedAtUtc = $observedAtUtc.ToString("o")
        ObservedAgeMinutes = $ageMinutes
    })
}

$currentCandidates = @{}

foreach ($entry in $sessionStartsById.GetEnumerator()) {
    $start = $entry.Value
    if ($null -eq $start.StartedAtUtc) {
        continue
    }

    $ageMinutes = Get-ObservedAgeMinutes -ObservedAtUtc $start.StartedAtUtc -NowUtc $nowUtc
    if ($ageMinutes -lt $TimeoutMinutes) {
        continue
    }

    $sessionId = [string]$start.SessionId
    $sessionEnd = if ($sessionEndsById.ContainsKey($sessionId)) { $sessionEndsById[$sessionId] } else { $null }
    $sessionLog = if ($sessionLogsById.ContainsKey($sessionId)) { $sessionLogsById[$sessionId] } else { $null }

    if ($null -eq $sessionEnd) {
        $violationId = "session:${sessionId}:missing_session_end"
        $currentCandidates[$violationId] = New-ViolationRecord `
            -EventType "opened" `
            -Status "open" `
            -ViolationId $violationId `
            -ViolationType "missing_session_end" `
            -ScopeType "session" `
            -Severity "medium" `
            -Condition "Session start record exceeded timeout without a matching session-end artifact." `
            -RecordedAtUtc $nowUtc `
            -Fields @{
                SessionId = $sessionId
                Project = $start.Project
                Model = $start.Model
                SessionStartPath = $start.Path
                SessionEndPath = $null
                SessionLogPath = $sessionLogPath
                ObservedAgeMinutes = $ageMinutes
                TimeoutMinutes = $TimeoutMinutes
                EvidencePaths = @(Normalize-StringArray -Items @($start.Path, $sessionLogPath))
            }
    }

    if ($null -eq $sessionLog) {
        $missingLogEvidencePaths = @($start.Path, $sessionLogPath)
        if ($null -ne $sessionEnd) {
            $missingLogEvidencePaths += $sessionEnd.Path
        }

        $violationId = "session:${sessionId}:missing_session_log"
        $currentCandidates[$violationId] = New-ViolationRecord `
            -EventType "opened" `
            -Status "open" `
            -ViolationId $violationId `
            -ViolationType "missing_session_log" `
            -ScopeType "session" `
            -Severity "medium" `
            -Condition "Session start record exceeded timeout without a canonical session-log entry." `
            -RecordedAtUtc $nowUtc `
            -Fields @{
                SessionId = $sessionId
                Project = $start.Project
                Model = $start.Model
                SessionStartPath = $start.Path
                SessionEndPath = if ($null -ne $sessionEnd) { $sessionEnd.Path } else { $null }
                SessionLogPath = $sessionLogPath
                ObservedAgeMinutes = $ageMinutes
                TimeoutMinutes = $TimeoutMinutes
                EvidencePaths = @(Normalize-StringArray -Items $missingLogEvidencePaths)
            }
    }
}

foreach ($run in @($runRecords.ToArray())) {
    $evidencePaths = @(Normalize-StringArray -Items @($run.ManifestPath, $run.PlanPath, $run.QaVerdictPath, $run.ExecutionPath, $run.ManifestSessionStartPath))

    if ($run.BundleStage -eq "qa_reject_exec_complete_violation") {
        $violationId = "run:$($run.RunId):qa_reject_exec_complete"
        $currentCandidates[$violationId] = New-ViolationRecord `
            -EventType "opened" `
            -Status "open" `
            -ViolationId $violationId `
            -ViolationType "qa_reject_exec_complete" `
            -ScopeType "run_bundle" `
            -Severity "high" `
            -Condition "Run reached EXECUTION_COMPLETE after QA returned REJECT." `
            -RecordedAtUtc $nowUtc `
            -Fields @{
                RunId = $run.RunId
                RunDir = $run.RunDir
                SessionId = $run.SessionId
                Project = $run.Project
                Model = $run.Model
                BundleStage = $run.BundleStage
                ObservedAgeMinutes = $run.ObservedAgeMinutes
                TimeoutMinutes = $TimeoutMinutes
                EvidencePaths = $evidencePaths
            }
    }

    if ($run.BundleStage -eq "exec_without_qa_violation") {
        $violationId = "run:$($run.RunId):exec_without_qa"
        $currentCandidates[$violationId] = New-ViolationRecord `
            -EventType "opened" `
            -Status "open" `
            -ViolationId $violationId `
            -ViolationType "exec_without_qa" `
            -ScopeType "run_bundle" `
            -Severity "high" `
            -Condition "Run wrote an execution report without any QA verdict artifact." `
            -RecordedAtUtc $nowUtc `
            -Fields @{
                RunId = $run.RunId
                RunDir = $run.RunDir
                SessionId = $run.SessionId
                Project = $run.Project
                Model = $run.Model
                BundleStage = $run.BundleStage
                ObservedAgeMinutes = $run.ObservedAgeMinutes
                TimeoutMinutes = $TimeoutMinutes
                EvidencePaths = $evidencePaths
            }
    }

    if ((Is-TimeoutEligibleBundleStage -Stage $run.BundleStage) -and $run.ObservedAgeMinutes -ge $TimeoutMinutes) {
        $violationId = "run:$($run.RunId):partial_bundle_timeout"
        $currentCandidates[$violationId] = New-ViolationRecord `
            -EventType "opened" `
            -Status "open" `
            -ViolationId $violationId `
            -ViolationType "partial_bundle_timeout" `
            -ScopeType "run_bundle" `
            -Severity "medium" `
            -Condition "Raw bundle remained incomplete past the reconciliation timeout." `
            -RecordedAtUtc $nowUtc `
            -Fields @{
                RunId = $run.RunId
                RunDir = $run.RunDir
                SessionId = $run.SessionId
                Project = $run.Project
                Model = $run.Model
                BundleStage = $run.BundleStage
                ObservedAgeMinutes = $run.ObservedAgeMinutes
                TimeoutMinutes = $TimeoutMinutes
                EvidencePaths = $evidencePaths
            }
    }

    if (-not [string]::IsNullOrWhiteSpace([string]$run.SessionId) -and -not $sessionStartsById.ContainsKey([string]$run.SessionId)) {
        $violationId = "run:$($run.RunId):missing_session_start"
        $currentCandidates[$violationId] = New-ViolationRecord `
            -EventType "opened" `
            -Status "open" `
            -ViolationId $violationId `
            -ViolationType "missing_session_start" `
            -ScopeType "run_bundle" `
            -Severity "high" `
            -Condition "Raw bundle declares a SessionId but no matching session-start artifact exists." `
            -RecordedAtUtc $nowUtc `
            -Fields @{
                RunId = $run.RunId
                RunDir = $run.RunDir
                SessionId = $run.SessionId
                Project = $run.Project
                Model = $run.Model
                BundleStage = $run.BundleStage
                ManifestSessionStartPath = $run.ManifestSessionStartPath
                ObservedAgeMinutes = $run.ObservedAgeMinutes
                TimeoutMinutes = $TimeoutMinutes
                EvidencePaths = $evidencePaths
            }
    }
}

$latestByViolationId = @{}
foreach ($event in Read-JsonLines -Path $protocolViolationsPath) {
    $violationId = [string](Get-PropertyValue -Object $event -Name "ViolationId" -DefaultValue "")
    if ([string]::IsNullOrWhiteSpace($violationId)) {
        continue
    }

    $latestByViolationId[$violationId] = $event
}

$openedEvents = New-Object System.Collections.Generic.List[object]
$resolvedEvents = New-Object System.Collections.Generic.List[object]

foreach ($entry in $currentCandidates.GetEnumerator()) {
    $violationId = [string]$entry.Key
    $candidate = $entry.Value
    $latest = if ($latestByViolationId.ContainsKey($violationId)) { $latestByViolationId[$violationId] } else { $null }
    $latestStatus = [string](Get-PropertyValue -Object $latest -Name "Status" -DefaultValue "")

    if ($latestStatus -ne "open") {
        Append-JsonLine -Path $protocolViolationsPath -Record $candidate
        $openedEvents.Add($candidate)
        $latestByViolationId[$violationId] = $candidate
    }
}

foreach ($entry in @($latestByViolationId.GetEnumerator())) {
    $violationId = [string]$entry.Key
    $latest = $entry.Value
    $latestStatus = [string](Get-PropertyValue -Object $latest -Name "Status" -DefaultValue "")
    if ($latestStatus -ne "open") {
        continue
    }

    if ($currentCandidates.ContainsKey($violationId)) {
        continue
    }

    $resolved = New-ViolationRecord `
        -EventType "resolved" `
        -Status "resolved" `
        -ViolationId $violationId `
        -ViolationType ([string](Get-PropertyValue -Object $latest -Name "ViolationType" -DefaultValue "unknown")) `
        -ScopeType ([string](Get-PropertyValue -Object $latest -Name "ScopeType" -DefaultValue "unknown")) `
        -Severity ([string](Get-PropertyValue -Object $latest -Name "Severity" -DefaultValue "medium")) `
        -Condition ([string](Get-PropertyValue -Object $latest -Name "Condition" -DefaultValue "Violation no longer observed during reconciliation.")) `
        -RecordedAtUtc $nowUtc `
        -Fields @{
            SessionId = Get-PropertyValue -Object $latest -Name "SessionId"
            RunId = Get-PropertyValue -Object $latest -Name "RunId"
            RunDir = Get-PropertyValue -Object $latest -Name "RunDir"
            Project = Get-PropertyValue -Object $latest -Name "Project"
            Model = Get-PropertyValue -Object $latest -Name "Model"
            BundleStage = Get-PropertyValue -Object $latest -Name "BundleStage"
            SessionStartPath = Get-PropertyValue -Object $latest -Name "SessionStartPath"
            SessionEndPath = Get-PropertyValue -Object $latest -Name "SessionEndPath"
            SessionLogPath = Get-PropertyValue -Object $latest -Name "SessionLogPath"
            ManifestSessionStartPath = Get-PropertyValue -Object $latest -Name "ManifestSessionStartPath"
            ObservedAgeMinutes = Get-PropertyValue -Object $latest -Name "ObservedAgeMinutes"
            TimeoutMinutes = Get-PropertyValue -Object $latest -Name "TimeoutMinutes"
            EvidencePaths = @(Normalize-StringArray -Items @(Get-PropertyValue -Object $latest -Name "EvidencePaths" -DefaultValue @()))
        }

    Append-JsonLine -Path $protocolViolationsPath -Record $resolved
    $resolvedEvents.Add($resolved)
    $latestByViolationId[$violationId] = $resolved
}

$currentOpenViolations = @(
    $latestByViolationId.Values |
        Where-Object { [string](Get-PropertyValue -Object $_ -Name "Status" -DefaultValue "") -eq "open" } |
        Sort-Object `
            @{ Expression = { Get-SeverityRank -Severity ([string](Get-PropertyValue -Object $_ -Name "Severity" -DefaultValue "")) }; Descending = $true }, `
            @{ Expression = { [string](Get-PropertyValue -Object $_ -Name "ViolationId" -DefaultValue "") }; Descending = $false }
)

$summary = [PSCustomObject]@{
    ProtocolViolationLogPath = $protocolViolationsPath
    TimeoutMinutes = $TimeoutMinutes
    SessionStartArtifactCount = $sessionStartsById.Count
    SessionEndArtifactCount = $sessionEndsById.Count
    SessionLogEntryCount = $sessionLogsById.Count
    RunBundleCount = @($runRecords.ToArray()).Count
    OpenedViolationCount = @($openedEvents.ToArray()).Count
    ResolvedViolationCount = @($resolvedEvents.ToArray()).Count
    CurrentOpenViolationCount = @($currentOpenViolations).Count
}

$result = [PSCustomObject]@{
    Summary = $summary
    OpenedViolations = @($openedEvents.ToArray())
    ResolvedViolations = @($resolvedEvents.ToArray())
    CurrentOpenViolations = @($currentOpenViolations)
}

if ($Format -eq "json") {
    $result | ConvertTo-Json -Depth 8
    return
}

Write-Host ""
Write-Host "Pending-session reconciliation complete." -ForegroundColor Cyan
Write-Host "Protocol violation log: $protocolViolationsPath"
Write-Host "Opened violations: $($summary.OpenedViolationCount)"
Write-Host "Resolved violations: $($summary.ResolvedViolationCount)"
Write-Host "Current open violations: $($summary.CurrentOpenViolationCount)"
foreach ($violation in $currentOpenViolations) {
    $scope = [string](Get-PropertyValue -Object $violation -Name "ScopeType" -DefaultValue "unknown")
    $id = [string](Get-PropertyValue -Object $violation -Name "ViolationId" -DefaultValue "(unknown)")
    $condition = [string](Get-PropertyValue -Object $violation -Name "Condition" -DefaultValue "")
    Write-Host ("- [{0}] {1} :: {2}" -f $scope, $id, $condition)
}
