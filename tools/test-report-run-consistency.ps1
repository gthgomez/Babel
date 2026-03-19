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

$reportScript = Join-Path $Root "tools\report-run-consistency.ps1"
if (-not (Test-Path -LiteralPath $reportScript)) {
    throw "Report script not found: $reportScript"
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

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("babel-run-consistency-" + [System.Guid]::NewGuid().ToString("N"))
$runsRoot = Join-Path $tempRoot "runs"
$localLearningRoot = Join-Path $runsRoot "local-learning"
New-Item -ItemType Directory -Force -Path $runsRoot | Out-Null

try {
    $gpcPassRun = Join-Path $runsRoot "20260309_080000_frontend-pass"
    New-Item -ItemType Directory -Force -Path $gpcPassRun | Out-Null
    Write-JsonFile -Path (Join-Path $gpcPassRun "01_manifest.json") -Value @{
        target_project = "GPCGuard"
        analysis = @{
            task_category = "Frontend"
            pipeline_mode = "direct"
        }
        worker_configuration = @{
            assigned_model = "Codex"
        }
    }
    Write-JsonFile -Path (Join-Path $gpcPassRun "03_qa_verdict_v1.json") -Value @{
        verdict = "PASS"
        overall_confidence = 5
    }
    Write-JsonFile -Path (Join-Path $gpcPassRun "04_execution_report.json") -Value @{
        status = "EXECUTION_COMPLETE"
    }

    $gpcPartialRun = Join-Path $runsRoot "20260309_090000_frontend-manifest-only"
    New-Item -ItemType Directory -Force -Path $gpcPartialRun | Out-Null
    Write-JsonFile -Path (Join-Path $gpcPartialRun "01_manifest.json") -Value @{
        target_project = "GPCGuard"
        analysis = @{
            task_category = "Frontend"
            pipeline_mode = "direct"
        }
        worker_configuration = @{
            assigned_model = "Codex"
        }
    }

    $prismatixViolationRun = Join-Path $runsRoot "20260309_100000_manual-reject-exec"
    New-Item -ItemType Directory -Force -Path $prismatixViolationRun | Out-Null
    Write-JsonFile -Path (Join-Path $prismatixViolationRun "01_manifest.json") -Value @{
        target_project = "Prismatix"
        analysis = @{
            task_category = "Frontend"
            pipeline_mode = "manual"
        }
        worker_configuration = @{
            assigned_model = "Claude"
        }
    }
    Write-JsonFile -Path (Join-Path $prismatixViolationRun "03_qa_verdict_v1.json") -Value @{
        verdict = "REJECT"
        failure_count = 1
        failures = @(@{ tag = "EVIDENCE-GATE"; condition = "missing evidence"; confidence = 3 })
        overall_confidence = 3
    }
    Write-JsonFile -Path (Join-Path $prismatixViolationRun "04_execution_report.json") -Value @{
        status = "EXECUTION_COMPLETE"
    }

    $stubRun = Join-Path $runsRoot "20260309_110000_stub"
    New-Item -ItemType Directory -Force -Path $stubRun | Out-Null

    Write-JsonFile -Path (Join-Path $localLearningRoot "session-starts\2026-03-09\gpcguard-session-001.json") -Value @{
        StartedAtUtc = "2026-03-09T08:00:00Z"
        SessionId = "gpcguard-session-001"
        Project = "GPCGuard"
        Model = "codex"
    }

    $sessionLogPath = Join-Path $localLearningRoot "session-log.jsonl"
    New-Item -ItemType Directory -Force -Path (Split-Path -Path $sessionLogPath -Parent) | Out-Null
    Add-Content -Path $sessionLogPath -Value (@{
        LoggedAtUtc = "2026-03-09T09:00:00Z"
        SessionId = "gpcguard-session-001"
        Project = "GPCGuard"
        Model = "codex"
        Result = "success"
    } | ConvertTo-Json -Compress)

    $reportJson = powershell -ExecutionPolicy Bypass -File $reportScript -RunsRoot $runsRoot -LocalLearningRoot $localLearningRoot -Format json -Top 10 -Root $Root | Out-String
    if ($LASTEXITCODE -ne 0) {
        throw "report-run-consistency.ps1 exited with code $LASTEXITCODE"
    }

    $report = $reportJson | ConvertFrom-Json
    Assert-Equal -Label "total run directories" -Expected 4 -Actual $report.Summary.TotalRunDirectories
    Assert-Equal -Label "qualifying run bundles" -Expected 3 -Actual $report.Summary.QualifyingRunBundles
    Assert-Equal -Label "partial artifact bundles" -Expected 1 -Actual $report.Summary.PartialArtifactBundles
    Assert-Equal -Label "QA gate violations" -Expected 1 -Actual $report.Summary.QaGateViolations
    Assert-Equal -Label "exec without QA violations" -Expected 0 -Actual $report.Summary.ExecWithoutQaViolations
    Assert-Equal -Label "session start artifact count" -Expected 1 -Actual $report.Summary.SessionStartArtifactCount
    Assert-Equal -Label "session end artifact count" -Expected 0 -Actual $report.Summary.SessionEndArtifactCount
    Assert-Equal -Label "session log present" -Expected "True" -Actual $report.Summary.SessionLogPresent

    $violation = @($report.ProtocolViolations.QaRejectExecComplete | Select-Object -First 1)
    Assert-True -Condition ($null -ne $violation) -Message "Expected QA reject -> exec complete violation."
    Assert-Equal -Label "violation run id" -Expected "20260309_100000_manual-reject-exec" -Actual $violation.RunId

    $gpcGroup = @(
        $report.OrphanedPartialRunGroups |
            Where-Object { $_.DayUtc -eq "2026-03-09" -and $_.Project -eq "GPCGuard" -and $_.Model -eq "Codex" } |
            Select-Object -First 1
    )
    Assert-True -Condition ($null -ne $gpcGroup) -Message "Expected GPCGuard orphaned partial group."
    Assert-Equal -Label "GPCGuard partial bundle count" -Expected 1 -Actual $gpcGroup.PartialBundleCount
    Assert-Equal -Label "GPCGuard missing end coverage" -Expected 2 -Actual $gpcGroup.MissingEndCoverage

    $prismatixGap = @(
        $report.LifecycleGapGroups |
            Where-Object { $_.DayUtc -eq "2026-03-09" -and $_.Project -eq "Prismatix" -and $_.Model -eq "Claude" } |
            Select-Object -First 1
    )
    Assert-True -Condition ($null -ne $prismatixGap) -Message "Expected Prismatix lifecycle gap group."
    Assert-Equal -Label "Prismatix missing start coverage" -Expected 1 -Actual $prismatixGap.MissingStartCoverage
    Assert-Equal -Label "Prismatix missing log coverage" -Expected 1 -Actual $prismatixGap.MissingLogCoverage

    Write-Host "report-run-consistency regression tests passed." -ForegroundColor Cyan
} finally {
    Remove-Item -Path $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
