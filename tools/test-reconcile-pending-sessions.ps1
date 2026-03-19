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

$reconcileScript = Join-Path $Root "tools\reconcile-pending-sessions.ps1"
if (-not (Test-Path -LiteralPath $reconcileScript)) {
    throw "Reconcile script not found: $reconcileScript"
}

function Assert-Equal {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Label,

        [AllowNull()]
        [object]$Expected,

        [AllowNull()]
        [object]$Actual
    )

    if ([string]$Expected -ne [string]$Actual) {
        throw "$Label mismatch. Expected '$Expected' but got '$Actual'."
    }
}

function Assert-True {
    param(
        [Parameter(Mandatory = $true)]
        [bool]$Condition,

        [Parameter(Mandatory = $true)]
        [string]$Message
    )

    if (-not $Condition) {
        throw $Message
    }
}

function Write-JsonFile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,

        [Parameter(Mandatory = $true)]
        [AllowNull()]
        [object]$Value
    )

    $parent = Split-Path -Path $Path -Parent
    if (-not [string]::IsNullOrWhiteSpace($parent)) {
        New-Item -ItemType Directory -Force -Path $parent | Out-Null
    }

    Set-Content -Path $Path -Value ($Value | ConvertTo-Json -Depth 8)
}

function Add-JsonLine {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,

        [Parameter(Mandatory = $true)]
        [AllowNull()]
        [object]$Value
    )

    $parent = Split-Path -Path $Path -Parent
    if (-not [string]::IsNullOrWhiteSpace($parent)) {
        New-Item -ItemType Directory -Force -Path $parent | Out-Null
    }

    Add-Content -Path $Path -Value ($Value | ConvertTo-Json -Depth 8 -Compress)
}

function Invoke-Reconcile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ScriptPath,

        [Parameter(Mandatory = $true)]
        [string]$RunsRoot,

        [Parameter(Mandatory = $true)]
        [string]$LocalLearningRoot,

        [Parameter(Mandatory = $true)]
        [string]$RepoRoot
    )

    $json = powershell -ExecutionPolicy Bypass -File $ScriptPath -RunsRoot $RunsRoot -LocalLearningRoot $LocalLearningRoot -TimeoutMinutes 60 -Format json -Root $RepoRoot | Out-String
    if ($LASTEXITCODE -ne 0) {
        throw "reconcile-pending-sessions.ps1 exited with code $LASTEXITCODE"
    }

    return ($json | ConvertFrom-Json)
}

function Get-LatestStatuses {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ProtocolLogPath
    )

    $map = @{}
    foreach ($line in Get-Content -Path $ProtocolLogPath) {
        if ([string]::IsNullOrWhiteSpace($line)) {
            continue
        }

        $record = $line | ConvertFrom-Json
        $map[[string]$record.ViolationId] = [string]$record.Status
    }

    return $map
}

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("babel-reconcile-" + [System.Guid]::NewGuid().ToString("N"))
$runsRoot = Join-Path $tempRoot "runs"
$localLearningRoot = Join-Path $runsRoot "local-learning"
$protocolLogPath = Join-Path $localLearningRoot "protocol-violations.jsonl"
New-Item -ItemType Directory -Force -Path $runsRoot | Out-Null

try {
    $sessionStart1Path = Join-Path $localLearningRoot "session-starts\2025-01-01\session-001.json"
    Write-JsonFile -Path $sessionStart1Path -Value @{
        StartedAtUtc = "2025-01-01T00:00:00Z"
        SessionId = "session-001"
        Project = "GPCGuard"
        Model = "codex"
        SessionStartPath = $sessionStart1Path
    }

    $run1 = Join-Path $runsRoot "20250101_000100_manifest-only-session-001"
    New-Item -ItemType Directory -Force -Path $run1 | Out-Null
    Write-JsonFile -Path (Join-Path $run1 "01_manifest.json") -Value @{
        target_project = "GPCGuard"
        session_id = "session-001"
        session_start_path = $sessionStart1Path
        worker_configuration = @{
            assigned_model = "Codex"
        }
    }

    $missingSessionStartPath = Join-Path $localLearningRoot "session-starts\2025-01-01\session-002.json"
    $run2 = Join-Path $runsRoot "20250101_000200_manifest-only-session-002"
    New-Item -ItemType Directory -Force -Path $run2 | Out-Null
    Write-JsonFile -Path (Join-Path $run2 "01_manifest.json") -Value @{
        target_project = "Prismatix"
        session_id = "session-002"
        session_start_path = $missingSessionStartPath
        worker_configuration = @{
            assigned_model = "Claude"
        }
    }

    $run3 = Join-Path $runsRoot "20250101_000300_reject-exec-session-001"
    New-Item -ItemType Directory -Force -Path $run3 | Out-Null
    Write-JsonFile -Path (Join-Path $run3 "01_manifest.json") -Value @{
        target_project = "GPCGuard"
        session_id = "session-001"
        session_start_path = $sessionStart1Path
        worker_configuration = @{
            assigned_model = "Codex"
        }
    }
    Write-JsonFile -Path (Join-Path $run3 "03_qa_verdict_v1.json") -Value @{
        verdict = "REJECT"
    }
    Write-JsonFile -Path (Join-Path $run3 "04_execution_report.json") -Value @{
        status = "EXECUTION_COMPLETE"
    }

    $first = Invoke-Reconcile -ScriptPath $reconcileScript -RunsRoot $runsRoot -LocalLearningRoot $localLearningRoot -RepoRoot $Root
    Assert-Equal -Label "first pass opened count" -Expected 6 -Actual $first.Summary.OpenedViolationCount
    Assert-Equal -Label "first pass resolved count" -Expected 0 -Actual $first.Summary.ResolvedViolationCount
    Assert-Equal -Label "first pass current open count" -Expected 6 -Actual $first.Summary.CurrentOpenViolationCount
    Assert-True -Condition (Test-Path -LiteralPath $protocolLogPath) -Message "Protocol violation log was not created."
    Assert-Equal -Label "first pass protocol log line count" -Expected 6 -Actual @((Get-Content -Path $protocolLogPath)).Count

    $firstIds = @($first.CurrentOpenViolations | ForEach-Object { [string]$_.ViolationId })
    foreach ($expectedId in @(
        "session:session-001:missing_session_end",
        "session:session-001:missing_session_log",
        "run:20250101_000100_manifest-only-session-001:partial_bundle_timeout",
        "run:20250101_000200_manifest-only-session-002:partial_bundle_timeout",
        "run:20250101_000200_manifest-only-session-002:missing_session_start",
        "run:20250101_000300_reject-exec-session-001:qa_reject_exec_complete"
    )) {
        Assert-True -Condition ($firstIds -contains $expectedId) -Message "Missing expected first-pass violation: $expectedId"
    }

    $sessionEnd1Path = Join-Path $localLearningRoot "session-ends\2025-01-01\session-001.json"
    Write-JsonFile -Path $sessionEnd1Path -Value @{
        EndedAtUtc = "2025-01-01T01:00:00Z"
        SessionId = "session-001"
        SessionStartPath = $sessionStart1Path
        SessionLogPath = (Join-Path $localLearningRoot "session-log.jsonl")
    }
    Add-JsonLine -Path (Join-Path $localLearningRoot "session-log.jsonl") -Value @{
        LoggedAtUtc = "2025-01-01T01:05:00Z"
        SessionId = "session-001"
        Project = "GPCGuard"
        Model = "codex"
        Result = "success"
    }

    Write-JsonFile -Path (Join-Path $run1 "03_qa_verdict_v1.json") -Value @{
        verdict = "PASS"
    }
    Write-JsonFile -Path (Join-Path $run1 "04_execution_report.json") -Value @{
        status = "EXECUTION_COMPLETE"
    }

    Write-JsonFile -Path $missingSessionStartPath -Value @{
        StartedAtUtc = "2025-01-01T00:10:00Z"
        SessionId = "session-002"
        Project = "Prismatix"
        Model = "claude"
        SessionStartPath = $missingSessionStartPath
    }
    Write-JsonFile -Path (Join-Path $localLearningRoot "session-ends\2025-01-01\session-002.json") -Value @{
        EndedAtUtc = "2025-01-01T00:40:00Z"
        SessionId = "session-002"
        SessionStartPath = $missingSessionStartPath
        SessionLogPath = (Join-Path $localLearningRoot "session-log.jsonl")
    }
    Add-JsonLine -Path (Join-Path $localLearningRoot "session-log.jsonl") -Value @{
        LoggedAtUtc = "2025-01-01T00:45:00Z"
        SessionId = "session-002"
        Project = "Prismatix"
        Model = "claude"
        Result = "success"
    }
    Write-JsonFile -Path (Join-Path $run2 "03_qa_verdict_v1.json") -Value @{
        verdict = "PASS"
    }
    Write-JsonFile -Path (Join-Path $run2 "04_execution_report.json") -Value @{
        status = "EXECUTION_COMPLETE"
    }

    $second = Invoke-Reconcile -ScriptPath $reconcileScript -RunsRoot $runsRoot -LocalLearningRoot $localLearningRoot -RepoRoot $Root
    Assert-Equal -Label "second pass opened count" -Expected 0 -Actual $second.Summary.OpenedViolationCount
    Assert-Equal -Label "second pass resolved count" -Expected 5 -Actual $second.Summary.ResolvedViolationCount
    Assert-Equal -Label "second pass current open count" -Expected 1 -Actual $second.Summary.CurrentOpenViolationCount
    Assert-Equal -Label "second pass protocol log line count" -Expected 11 -Actual @((Get-Content -Path $protocolLogPath)).Count
    Assert-Equal -Label "second pass remaining violation" -Expected "run:20250101_000300_reject-exec-session-001:qa_reject_exec_complete" -Actual $second.CurrentOpenViolations[0].ViolationId

    Write-JsonFile -Path (Join-Path $run3 "04_execution_report.json") -Value @{
        status = "EXECUTION_HALTED"
    }

    $third = Invoke-Reconcile -ScriptPath $reconcileScript -RunsRoot $runsRoot -LocalLearningRoot $localLearningRoot -RepoRoot $Root
    Assert-Equal -Label "third pass opened count" -Expected 0 -Actual $third.Summary.OpenedViolationCount
    Assert-Equal -Label "third pass resolved count" -Expected 1 -Actual $third.Summary.ResolvedViolationCount
    Assert-Equal -Label "third pass current open count" -Expected 0 -Actual $third.Summary.CurrentOpenViolationCount
    Assert-Equal -Label "third pass protocol log line count" -Expected 12 -Actual @((Get-Content -Path $protocolLogPath)).Count

    $latestStatuses = Get-LatestStatuses -ProtocolLogPath $protocolLogPath
    foreach ($violationId in $latestStatuses.Keys) {
        Assert-Equal -Label "final status for $violationId" -Expected "resolved" -Actual $latestStatuses[$violationId]
    }

    Write-Host "reconcile-pending-sessions regression tests passed." -ForegroundColor Cyan
} finally {
    Remove-Item -Path $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
