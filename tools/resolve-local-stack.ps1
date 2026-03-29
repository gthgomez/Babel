[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("frontend", "backend", "mobile", "compliance", "devops", "research")]
    [string]$TaskCategory,

    [ValidateSet("global", "example_saas_backend", "example_llm_router", "example_web_audit", "example_mobile_suite")]
    [string]$Project = "global",

    [ValidateSet("codex", "claude", "gemini")]
    [string]$Model = "codex",

    [ValidateSet("direct", "verified", "autonomous", "manual")]
    [string]$PipelineMode = "direct",

    [ValidateSet("auto", "balanced", "ultra")]
    [string]$CodexAdapter = "auto",

    [string[]]$SkillIds = @(),

    [string[]]$TaskOverlayIds = @(),

    [switch]$DisableRecommendedTaskOverlays,

    [switch]$AbsolutePaths,

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

$tsxPath = Join-Path $Root "babel-cli\node_modules\.bin\tsx.cmd"
if (-not (Test-Path -LiteralPath $tsxPath)) {
    throw "tsx was not found at $tsxPath. Run 'npm install' inside Babel-public\\babel-cli first."
}

$previewScriptPath = Join-Path $Root "babel-cli\scripts\preview_manifest.ts"
$previewScriptPath = (Resolve-Path $previewScriptPath).Path

$resolvedCodexAdapter = if ($CodexAdapter -eq "auto") { "balanced" } else { $CodexAdapter }
$args = @(
    $previewScriptPath,
    "--task-category", $TaskCategory,
    "--project", $Project,
    "--model", $Model,
    "--pipeline-mode", $PipelineMode,
    "--codex-adapter", $resolvedCodexAdapter,
    "--root", $Root
)

foreach ($skillId in $SkillIds) {
    if (-not [string]::IsNullOrWhiteSpace($skillId)) {
        $args += @("--skill-id", $skillId.Trim())
    }
}

foreach ($taskOverlayId in $TaskOverlayIds) {
    if (-not [string]::IsNullOrWhiteSpace($taskOverlayId)) {
        $args += @("--task-overlay-id", $taskOverlayId.Trim())
    }
}

if ($DisableRecommendedTaskOverlays) {
    $args += "--disable-recommended-task-overlays"
}

if ($AbsolutePaths) {
    $args += "--absolute-paths"
}

$outputLines = & $tsxPath @args 2>&1 | ForEach-Object { [string]$_ }
$exitCode = $LASTEXITCODE
$outputText = ($outputLines -join [Environment]::NewLine).Trim()

if ($exitCode -ne 0) {
    throw "Manifest preview failed with exit code $exitCode.`n$outputText"
}

if ($Format -eq "json") {
    Write-Output $outputText
    exit 0
}

$result = $outputText | ConvertFrom-Json

Write-Host ""
Write-Host "Babel Manifest Preview" -ForegroundColor Cyan
Write-Host "Project: $($result.selection.project)"
Write-Host "Task category: $($result.selection.task_category)"
Write-Host "Model: $($result.selection.model)"
Write-Host "Pipeline mode: $($result.selection.pipeline_mode)"
if ($result.selection.selected_codex_adapter) {
    Write-Host "Codex adapter: $($result.selection.selected_codex_adapter)"
}

Write-Host ""
Write-Host "Instruction stack:" -ForegroundColor Yellow
Write-Host "  Behavioral: $($result.instruction_stack.behavioral_ids -join ', ')"
Write-Host "  Domain: $($result.instruction_stack.domain_id)"
Write-Host "  Requested skills: $(if ($result.instruction_stack.skill_ids.Count -gt 0) { $result.instruction_stack.skill_ids -join ', ' } else { '(none)' })"
Write-Host "  Model adapter: $($result.instruction_stack.model_adapter_id)"
Write-Host "  Project overlay: $(if ($null -ne $result.instruction_stack.project_overlay_id) { $result.instruction_stack.project_overlay_id } else { '(none)' })"
Write-Host "  Task overlays: $(if ($result.instruction_stack.task_overlay_ids.Count -gt 0) { $result.instruction_stack.task_overlay_ids -join ', ' } else { '(none)' })"
Write-Host "  Pipeline stages: $(if ($result.instruction_stack.pipeline_stage_ids.Count -gt 0) { $result.instruction_stack.pipeline_stage_ids -join ', ' } else { '(none)' })"

Write-Host ""
Write-Host "Resolved entries:" -ForegroundColor Yellow
foreach ($entry in $result.ordered_entries) {
    Write-Host "  $($entry.order_index). [$($entry.layer)] $($entry.id) -> $($entry.relative_path)"
}

Write-Host ""
Write-Host "Budget summary:" -ForegroundColor Yellow
Write-Host "  Total token budget: $($result.compiled_artifacts.token_budget_total)"
Write-Host "  Missing token budgets: $(if ($result.compiled_artifacts.token_budget_missing.Count -gt 0) { $result.compiled_artifacts.token_budget_missing -join ', ' } else { '(none)' })"
if ($result.compiled_artifacts.warnings.Count -gt 0) {
    Write-Host "  Warnings:"
    foreach ($warning in $result.compiled_artifacts.warnings) {
        Write-Host "    - $warning"
    }
}
