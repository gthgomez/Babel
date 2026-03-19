[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$SessionId,

    [ValidateSet("success", "partial", "failed", "abandoned")]
    [string]$Result = "partial",

    [string[]]$FailureTags = @(),

    [string]$UserOverrideReason = "",

    [switch]$FollowUpNeeded,

    [int]$DurationMinutes = 0,

    [string[]]$FilesTouched = @(),

    [string]$Notes = "",

    [string[]]$ActualSelectedStackIds = @(),

    [string]$SessionStartPath = "",

    [string]$OutputRoot = "",

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

if (-not (Test-Path (Join-Path $Root "prompt_catalog.yaml"))) {
    throw "Babel root does not contain prompt_catalog.yaml: $Root"
}

if ([string]::IsNullOrWhiteSpace($OutputRoot)) {
    $OutputRoot = Join-Path $Root "runs\local-learning"
}

$logScriptPath = Join-Path $Root "tools\log-local-session.ps1"
if (-not (Test-Path $logScriptPath)) {
    throw "Session logger not found at $logScriptPath"
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

function Resolve-SessionStartPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RootOutput,

        [Parameter(Mandatory = $true)]
        [string]$Id,

        [string]$ExplicitPath = ""
    )

    if (-not [string]::IsNullOrWhiteSpace($ExplicitPath)) {
        if (-not (Test-Path $ExplicitPath)) {
            throw "Provided session start path does not exist: $ExplicitPath"
        }

        return (Resolve-Path $ExplicitPath).Path
    }

    $searchRoot = Join-Path $RootOutput "session-starts"
    if (-not (Test-Path $searchRoot)) {
        throw "Session start directory not found: $searchRoot"
    }

    $matches = @(
        Get-ChildItem -Path $searchRoot -Recurse -File -Filter ($Id + ".json") |
            Sort-Object -Property LastWriteTimeUtc -Descending
    )

    if ($matches.Count -eq 0) {
        throw "No session start record found for session ID '$Id' under $searchRoot."
    }

    return $matches[0].FullName
}

function Resolve-LoggedSessionPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RootOutput,

        [Parameter(Mandatory = $true)]
        [string]$Id
    )

    $searchRoot = Join-Path $RootOutput "sessions"
    if (-not (Test-Path $searchRoot)) {
        return $null
    }

    $matches = @(
        Get-ChildItem -Path $searchRoot -Recurse -File -Filter ($Id + ".json") |
            Sort-Object -Property LastWriteTimeUtc -Descending
    )

    if ($matches.Count -eq 0) {
        return $null
    }

    return $matches[0].FullName
}

function Merge-SessionLogById {
    param(
        [Parameter(Mandatory = $true)]
        [string]$LogPath,

        [Parameter(Mandatory = $true)]
        [string]$Id
    )

    if (-not (Test-Path $LogPath)) {
        return
    }

    $records = New-Object System.Collections.Generic.List[object]
    foreach ($line in Get-Content -Path $LogPath) {
        if ([string]::IsNullOrWhiteSpace($line)) {
            continue
        }

        $records.Add(($line | ConvertFrom-Json))
    }

    if ($records.Count -eq 0) {
        return
    }

    $latestBySession = @{}
    $sessionOrder = New-Object System.Collections.Generic.List[string]
    foreach ($record in $records) {
        $recordId = [string]$record.SessionId
        if ([string]::IsNullOrWhiteSpace($recordId)) {
            continue
        }

        if ($latestBySession.ContainsKey($recordId)) {
            $null = $sessionOrder.Remove($recordId)
        }
        $sessionOrder.Add($recordId)
        $latestBySession[$recordId] = $record
    }

    $dedupedLines = foreach ($recordId in $sessionOrder) {
        $latestBySession[$recordId] | ConvertTo-Json -Depth 8 -Compress
    }

    Set-Content -Path $LogPath -Value $dedupedLines
}

$resolvedSessionStartPath = Resolve-SessionStartPath -RootOutput $OutputRoot -Id $SessionId -ExplicitPath $SessionStartPath
$previousLoggedSessionPath = Resolve-LoggedSessionPath -RootOutput $OutputRoot -Id $SessionId
$sessionStart = Get-Content -Path $resolvedSessionStartPath -Raw | ConvertFrom-Json

if ([string]::IsNullOrWhiteSpace([string]$sessionStart.TaskCategory)) {
    throw "Session start record is missing TaskCategory: $resolvedSessionStartPath"
}

if ([string]::IsNullOrWhiteSpace([string]$sessionStart.Model)) {
    throw "Session start record is missing Model: $resolvedSessionStartPath"
}

$project = if ([string]::IsNullOrWhiteSpace([string]$sessionStart.Project)) { "global" } else { [string]$sessionStart.Project }
$clientSurface = if ([string]::IsNullOrWhiteSpace([string]$sessionStart.ClientSurface)) { "other" } else { [string]$sessionStart.ClientSurface }
$pipelineMode = if ([string]::IsNullOrWhiteSpace([string]$sessionStart.PipelineMode)) { "direct" } else { [string]$sessionStart.PipelineMode }
$codexAdapter = if ([string]::IsNullOrWhiteSpace([string]$sessionStart.CodexAdapterRequested)) { "auto" } else { [string]$sessionStart.CodexAdapterRequested }

$logParams = @{
    Root = $Root
    OutputRoot = $OutputRoot
    SessionId = $SessionId
    Project = $project
    TaskCategory = [string]$sessionStart.TaskCategory
    Model = [string]$sessionStart.Model
    ClientSurface = $clientSurface
    PipelineMode = $pipelineMode
    CodexAdapter = $codexAdapter
    Result = $Result
    FailureTags = @(Normalize-StringArray -Items $FailureTags)
    UserOverrideReason = $UserOverrideReason
    FollowUpNeeded = [bool]$FollowUpNeeded
    DurationMinutes = $DurationMinutes
    FilesTouched = @(Normalize-StringArray -Items $FilesTouched)
    Notes = $Notes
    PolicyVersionApplied = if ($sessionStart.PolicyVersionApplied) { [string]$sessionStart.PolicyVersionApplied } else { "" }
}

$taskOverlayIdsRequested = @(Normalize-StringArray -Items @($sessionStart.TaskOverlayIdsRequested))
if ($taskOverlayIdsRequested.Count -gt 0) {
    $logParams.TaskOverlayIds = $taskOverlayIdsRequested
}

if ([bool]$sessionStart.DisableRecommendedTaskOverlays) {
    $logParams.DisableRecommendedTaskOverlays = $true
}

$actualStackIds = @(Normalize-StringArray -Items $ActualSelectedStackIds)
if ($actualStackIds.Count -gt 0) {
    $logParams.SelectedStackIds = $actualStackIds
}

$projectPathFromStart = [string]$sessionStart.ProjectPath
if (-not [string]::IsNullOrWhiteSpace($projectPathFromStart) -and (Test-Path $projectPathFromStart)) {
    $logParams.ProjectPath = (Resolve-Path $projectPathFromStart).Path
}

$null = & $logScriptPath @logParams 6>$null

$loggedSessionPath = Resolve-LoggedSessionPath -RootOutput $OutputRoot -Id $SessionId
$sessionLogPath = Join-Path $OutputRoot "session-log.jsonl"
Merge-SessionLogById -LogPath $sessionLogPath -Id $SessionId

if (
    -not [string]::IsNullOrWhiteSpace([string]$previousLoggedSessionPath) -and
    -not [string]::IsNullOrWhiteSpace([string]$loggedSessionPath) -and
    ($previousLoggedSessionPath -ne $loggedSessionPath) -and
    (Test-Path $previousLoggedSessionPath)
) {
    Remove-Item -Path $previousLoggedSessionPath -Force -ErrorAction SilentlyContinue
}

$endedAtUtc = (Get-Date).ToUniversalTime()
$sessionEndDir = Join-Path $OutputRoot ("session-ends\" + $endedAtUtc.ToString("yyyy-MM-dd"))
$sessionEndPath = Join-Path $sessionEndDir ($SessionId + ".json")
New-Item -ItemType Directory -Force -Path $sessionEndDir | Out-Null

$record = [PSCustomObject]@{
    SchemaVersion = 1
    EndedAtUtc = $endedAtUtc.ToString("o")
    SessionId = $SessionId
    Result = $Result
    FailureTags = @(Normalize-StringArray -Items $FailureTags)
    FollowUpNeeded = [bool]$FollowUpNeeded
    DurationMinutes = if ($DurationMinutes -gt 0) { $DurationMinutes } else { $null }
    SessionStartPath = $resolvedSessionStartPath
    LoggedSessionPath = $loggedSessionPath
    SessionLogPath = $sessionLogPath
    SessionEndPath = $sessionEndPath
}

Set-Content -Path $sessionEndPath -Value ($record | ConvertTo-Json -Depth 6)

if ($Format -eq "json") {
    $record | ConvertTo-Json -Depth 6
    return
}

Write-Host ""
Write-Host "Babel Local session ended." -ForegroundColor Cyan
Write-Host "Session ID: $SessionId"
Write-Host "Session start record: $resolvedSessionStartPath"
Write-Host "Session end record: $sessionEndPath"
if (-not [string]::IsNullOrWhiteSpace([string]$loggedSessionPath)) {
    Write-Host "Logged session record: $loggedSessionPath"
}
Write-Host "Session log file: $sessionLogPath"
