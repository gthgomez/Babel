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

$scriptPath = Join-Path $Root "tools\stage-local-learning-prompt-evolutions.ps1"
$tempDir = Join-Path $Root "runs\local-learning-test\stage-local-learning-prompt-evolutions"

if (Test-Path -LiteralPath $tempDir) {
    Remove-Item -LiteralPath $tempDir -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $tempDir | Out-Null

function Assert-Equal {
    param([string]$Label, [AllowNull()][object]$Expected, [AllowNull()][object]$Actual)
    if ([string]$Expected -ne [string]$Actual) {
        throw "$Label mismatch. Expected '$Expected' but got '$Actual'."
    }
}

function Assert-True {
    param([string]$Label, [bool]$Condition)
    if (-not $Condition) {
        throw "$Label was expected to be true."
    }
}

function Write-JsonFile {
    param([string]$Path, [AllowNull()][object]$Value)
    $dir = Split-Path -Path $Path -Parent
    if (-not [string]::IsNullOrWhiteSpace($dir)) {
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
    }
    $Value | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $Path -Encoding UTF8
}

function Write-JsonLines {
    param([string]$Path, [object[]]$Items)
    $dir = Split-Path -Path $Path -Parent
    if (-not [string]::IsNullOrWhiteSpace($dir)) {
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
    }
    $lines = @($Items | ForEach-Object { $_ | ConvertTo-Json -Depth 12 -Compress })
    Set-Content -LiteralPath $Path -Value $lines -Encoding UTF8
}

$candidatePath = Join-Path $tempDir "derived\policy-candidates.json"
$auditPath = Join-Path $tempDir "derived\policy-audit.jsonl"
$eventsPath = Join-Path $tempDir "derived\normalized-events.jsonl"
$outputPath = Join-Path $tempDir "04_Meta_Tools\proposed_evolutions.json"

$targetFile = Join-Path $Root "03_Model_Adapters\Codex_Balanced.md"
$targetFileHashBefore = (Get-FileHash -LiteralPath $targetFile -Algorithm SHA256).Hash

Write-JsonFile -Path $candidatePath -Value ([ordered]@{
    SchemaVersion = 1
    CandidateCount = 3
    Candidates = @(
        [ordered]@{
            policy_id = "local-client:codex_extension.codex:prompt_markdown_edit:rule-a"
            scope_type = "local_client"
            scope_key = "codex_extension|codex"
            target_surface = "prompt_markdown_edit"
            state = "human_review"
            requires_human_review = $true
            supporting_event_ids = @("hr-01")
        },
        [ordered]@{
            policy_id = "local-client:codex_extension.codex:prompt_markdown_edit:rule-b"
            scope_type = "local_client"
            scope_key = "codex_extension|codex"
            target_surface = "prompt_markdown_edit"
            state = "human_review"
            requires_human_review = $true
            supporting_event_ids = @("hr-02")
        },
        [ordered]@{
            policy_id = "repo:gpcguard:verification_loop_hints:contradiction"
            scope_type = "repo"
            scope_key = "GPCGuard"
            target_surface = "verification_loop_hints"
            state = "candidate"
            requires_human_review = $false
            supporting_event_ids = @("noise-01")
        }
    )
})

Write-JsonLines -Path $auditPath -Items @(
    [ordered]@{
        policy_id = "local-client:codex_extension.codex:prompt_markdown_edit:rule-a"
        scope_type = "local_client"
        scope_key = "codex_extension|codex"
        target_surface = "prompt_markdown_edit"
        reasons = @("target_surface_not_allowlisted")
        supporting_event_ids = @("allow-01")
        triggering_event_ids = @()
    },
    [ordered]@{
        policy_id = "local-client:codex_extension.codex:prompt_markdown_edit:rule-b"
        scope_type = "local_client"
        scope_key = "codex_extension|codex"
        target_surface = "prompt_markdown_edit"
        reasons = @("target_surface_not_allowlisted")
        supporting_event_ids = @("allow-02")
        triggering_event_ids = @()
    },
    [ordered]@{
        policy_id = "repo:gpcguard:verification_loop_hints:contradiction"
        scope_type = "repo"
        scope_key = "GPCGuard"
        target_surface = "verification_loop_hints"
        reasons = @("contradictory_source_patterns")
        supporting_event_ids = @("noise-01")
        triggering_event_ids = @()
    }
)

Write-JsonLines -Path $eventsPath -Items @(
    [ordered]@{ event_id = "hr-01"; task_category = "frontend"; model = "codex"; project = "GPCGuard" },
    [ordered]@{ event_id = "hr-02"; task_category = "frontend"; model = "codex"; project = "GPCGuard" },
    [ordered]@{ event_id = "allow-01"; task_category = "frontend"; model = "codex"; project = "GPCGuard" },
    [ordered]@{ event_id = "allow-02"; task_category = "frontend"; model = "codex"; project = "GPCGuard" },
    [ordered]@{ event_id = "noise-01"; task_category = "backend"; model = "codex"; project = "GPCGuard" }
)

Write-JsonFile -Path $outputPath -Value ([ordered]@{
    generated_at = "2026-03-01T00:00:00Z"
    runs_dir = "runs"
    runs_scanned = 0
    reject_verdicts_found = 0
    architects_affected = 0
    proposals = @()
})

$result = powershell -ExecutionPolicy Bypass -File $scriptPath -Root $Root -LocalLearningRoot $tempDir -CandidatePath $candidatePath -AuditPath $auditPath -NormalizedEventsPath $eventsPath -OutputPath $outputPath -Format json | Out-String | ConvertFrom-Json
Assert-Equal -Label "local learning proposal count" -Expected 2 -Actual $result.local_learning_proposal_count

$report = Get-Content -LiteralPath $outputPath -Raw | ConvertFrom-Json
Assert-Equal -Label "existing proposal array preserved" -Expected 0 -Actual @($report.proposals).Count
Assert-Equal -Label "local learning proposals merged" -Expected 2 -Actual @($report.local_learning_proposals).Count
Assert-True -Label "human review proposal staged" -Condition (@($report.local_learning_proposals | Where-Object { [string]$_.source_type -eq "repeated_human_review_pattern" }).Count -eq 1)
Assert-True -Label "non-allowlisted proposal staged" -Condition (@($report.local_learning_proposals | Where-Object { [string]$_.source_type -eq "repeated_non_allowlisted_surface" }).Count -eq 1)
Assert-True -Label "contradictory noise does not stage proposal" -Condition (@($report.local_learning_proposals | Where-Object { [string]$_.proposal_id -like "*contradiction*" }).Count -eq 0)

$targetFileHashAfter = (Get-FileHash -LiteralPath $targetFile -Algorithm SHA256).Hash
Assert-Equal -Label "target prompt file unchanged" -Expected $targetFileHashBefore -Actual $targetFileHashAfter

Write-Host "stage-local-learning-prompt-evolutions regression tests passed." -ForegroundColor Cyan
