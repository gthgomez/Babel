[CmdletBinding()]
param(
    [string]$Root = "",

    [string]$ConfigPath = "",

    [switch]$Check
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Resolve-BabelRoot {
    param(
        [AllowNull()]
        [string]$InputPath
    )

    if (-not [string]::IsNullOrWhiteSpace($InputPath)) {
        if (-not (Test-Path $InputPath)) {
            throw "Provided root path does not exist: $InputPath"
        }

        return (Resolve-Path $InputPath).Path
    }

    $scriptDir = if ($PSScriptRoot) {
        $PSScriptRoot
    } else {
        Split-Path -Path $PSCommandPath -Parent
    }

    return (Resolve-Path (Join-Path $scriptDir "..")).Path
}

function Resolve-PathFromRoot {
    param(
        [Parameter(Mandatory = $true)]
        [string]$BaseRoot,

        [Parameter(Mandatory = $true)]
        [string]$RelativePath
    )

    return Join-Path $BaseRoot ($RelativePath.Replace("/", "\"))
}

function Get-FileSha256 {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    if (-not (Test-Path $Path)) {
        throw "Hash input file not found: $Path"
    }

    return (Get-FileHash -Path $Path -Algorithm SHA256).Hash.ToUpperInvariant()
}

$resolvedRoot = Resolve-BabelRoot -InputPath $Root

if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
    $ConfigPath = Join-Path $resolvedRoot "tools\model-manifest-sources.json"
} elseif (-not (Test-Path $ConfigPath)) {
    throw "Config path not found: $ConfigPath"
}

$resolvedConfigPath = (Resolve-Path $ConfigPath).Path
$resolverPath = Join-Path $resolvedRoot "tools\resolve-control-plane.ps1"
if (-not (Test-Path $resolverPath)) {
    throw "Resolver script not found: $resolverPath"
}

$config = Get-Content -Path $resolvedConfigPath -Raw | ConvertFrom-Json
if ($null -eq $config) {
    throw "Failed to parse manifest source config: $resolvedConfigPath"
}

$sharedInputs = @($config.shared_inputs | ForEach-Object { [string]$_ })
$modelSpecs = @($config.models)

if ($sharedInputs.Count -eq 0) {
    throw "Config must define at least one shared input."
}

if ($modelSpecs.Count -eq 0) {
    throw "Config must define at least one model mapping."
}

# --- Report-only output directory ---
$reportDir = Join-Path $resolvedRoot "tools\reports"
if (-not (Test-Path $reportDir)) {
    New-Item -ItemType Directory -Path $reportDir -Force | Out-Null
}

# --- Log excluded models ---
if ($config.PSObject.Properties.Name -contains 'excluded_models') {
    foreach ($excluded in $config.excluded_models) {
        Write-Host "[$($excluded.model)] $($excluded.manifest_file): SKIPPED ($($excluded.reason))" -ForegroundColor DarkGray
    }
}

$staleFiles = New-Object System.Collections.Generic.List[string]
$checkedFiles = New-Object System.Collections.Generic.List[string]
$reportLines = New-Object System.Collections.Generic.List[string]

$reportLines.Add("# Babel Manifest Sync Report")
$reportLines.Add("")
$reportLines.Add("Generated UTC: $([DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ'))")
$reportLines.Add("Mode: $(if ($Check) { 'Check only' } else { 'Report-only (no direct writes)' })")
$reportLines.Add("")

foreach ($modelSpec in $modelSpecs) {
    $model = [string]$modelSpec.model
    $manifestFile = [string]$modelSpec.manifest_file
    $modelRulesRelativePath = [string]$modelSpec.model_rules_path

    if ([string]::IsNullOrWhiteSpace($model) -or [string]::IsNullOrWhiteSpace($manifestFile) -or [string]::IsNullOrWhiteSpace($modelRulesRelativePath)) {
        throw "Each model config entry must include model, manifest_file, and model_rules_path."
    }

    $planDecision = (& $resolverPath `
        -RepoPath $resolvedRoot `
        -Model $model `
        -TaskMode "planning" `
        -ToolCanWriteFiles:$false `
        -ApprovalMode "default" `
        -OutputFormat "json") | ConvertFrom-Json

    $execDecision = (& $resolverPath `
        -RepoPath $resolvedRoot `
        -Model $model `
        -TaskMode "implement" `
        -ToolCanWriteFiles:$true `
        -ApprovalMode "auto_edit" `
        -OutputFormat "json") | ConvertFrom-Json

    $contractPath = [string]$planDecision.contract_path
    $readmePath = Resolve-PathFromRoot -BaseRoot $resolvedRoot -RelativePath "LLM_COLLABORATION_SYSTEM/README_FOR_HUMANS_AND_LLMS.md"
    $sharedRulesPath = [string]$planDecision.shared_path
    $corePath = [string]$planDecision.core_path
    $adapterPath = [string]$planDecision.adapter_path
    $guardPath = [string]$planDecision.guard_path
    $overlayPath = [string]$planDecision.overlay_path
    $contextPath = [string]$planDecision.context_path
    $modelRulesPath = Resolve-PathFromRoot -BaseRoot $resolvedRoot -RelativePath $modelRulesRelativePath

    $canonicalRelativePaths = New-Object System.Collections.Generic.List[string]
    foreach ($relativePath in $sharedInputs) {
        $canonicalRelativePaths.Add($relativePath)
    }
    $canonicalRelativePaths.Add($modelRulesRelativePath)

    $canonicalSourceRows = New-Object System.Collections.Generic.List[object]
    foreach ($relativePath in ($canonicalRelativePaths | Select-Object -Unique | Sort-Object)) {
        $fullPath = Resolve-PathFromRoot -BaseRoot $resolvedRoot -RelativePath $relativePath
        if (-not (Test-Path $fullPath)) {
            throw "Canonical source file missing for $model manifest: $fullPath"
        }

        $canonicalSourceRows.Add([PSCustomObject]@{
            RelativePath = $relativePath
            FullPath = $fullPath
            Hash = Get-FileSha256 -Path $fullPath
        })
    }

    foreach ($requiredPath in @($contractPath, $readmePath, $sharedRulesPath, $corePath, $adapterPath, $guardPath, $overlayPath, $contextPath, $modelRulesPath)) {
        if (-not (Test-Path $requiredPath)) {
            throw "Required manifest input not found: $requiredPath"
        }
    }

    $readmeText = Get-Content -Path $readmePath -Raw
    $coreText = Get-Content -Path $corePath -Raw
    $adapterText = Get-Content -Path $adapterPath -Raw
    $guardText = Get-Content -Path $guardPath -Raw
    $modelText = Get-Content -Path $modelRulesPath -Raw
    $sharedText = Get-Content -Path $sharedRulesPath -Raw
    $repoName = Split-Path -Path $resolvedRoot -Leaf

    $contractHash = Get-FileSha256 -Path $contractPath
    $coreHash = Get-FileSha256 -Path $corePath
    $adapterHash = Get-FileSha256 -Path $adapterPath
    $guardHash = Get-FileSha256 -Path $guardPath
    $modelHash = Get-FileSha256 -Path $modelRulesPath
    $sharedHash = Get-FileSha256 -Path $sharedRulesPath

    $canonicalSourceText = @($canonicalSourceRows | ForEach-Object {
        "- $($_.RelativePath) [SHA256: $($_.Hash)]"
    }) -join "`n"

    $planEffectiveFiles = @($planDecision.effective_load_files) | ForEach-Object { "  - $_" } | Out-String
    $planEffectiveFiles = $planEffectiveFiles.TrimEnd("`r", "`n")

    $execEffectiveFiles = @($execDecision.effective_load_files) | ForEach-Object { "  - $_" } | Out-String
    $execEffectiveFiles = $execEffectiveFiles.TrimEnd("`r", "`n")

    $manifestText = @"
# $manifestFile

Generated file. Do not edit manually.
Generated by: tools/sync-model-manifests.ps1
Repository: $repoName
Model: $model
Resolver: tools/resolve-control-plane.ps1
Manifest Sources Config: tools/model-manifest-sources.json
Manifest Spec Version: 2
Activation Contract SHA256: $contractHash
Core Rules SHA256: $coreHash
Adapter Rules SHA256: $adapterHash
Guard Rules SHA256: $guardHash
Model Rules SHA256: $modelHash
Shared Aggregate SHA256: $sharedHash

## Canonical Source Inputs

$canonicalSourceText

## Required First Read (In Order)

1. PROJECT_CONTEXT.md
2. LLM_COLLABORATION_SYSTEM/README_FOR_HUMANS_AND_LLMS.md
3. This file

## Control Plane Load Decision

Planning profile (default non-execution):
- task_mode: planning
- tool_can_write_files: false
- approval_mode: default
- guard_loaded: $($planDecision.guard_loaded)
- effective_load_files:
$planEffectiveFiles

Execution profile (write-capable):
- task_mode: implement
- tool_can_write_files: true
- approval_mode: auto_edit
- guard_loaded: $($execDecision.guard_loaded)
- effective_load_files:
$execEffectiveFiles

## Collaboration System Readme

$readmeText

## Core Rules (Always Loaded)

$coreText

## Adapter Rules (Always Loaded)

$adapterText

## Guard Rules (Conditionally Loaded)

$guardText

## Model Overlay ($model)

$modelText

## Shared Aggregate (Compatibility)

$sharedText

## Handoff and Web References

- LLM_COLLABORATION_SYSTEM/MODEL_SWITCH_HANDOFF_TEMPLATE.md
- LLM_COLLABORATION_SYSTEM/WEB_UPLOAD_GUIDE.md
"@

    $outputPath = Resolve-PathFromRoot -BaseRoot $resolvedRoot -RelativePath $manifestFile
    $checkedFiles.Add($manifestFile)

    $existing = if (Test-Path $outputPath) { [System.IO.File]::ReadAllText($outputPath) } else { $null }
    $isDrift = ($existing -ne $manifestText)

    if ($isDrift) {
        $staleFiles.Add($manifestFile)

        # Stage proposed content to report directory (never overwrite directly)
        $proposedPath = Join-Path $reportDir "${repoName}_${model}_proposed.md"
        $encoding = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($proposedPath, $manifestText, $encoding)

        $reportLines.Add("### $manifestFile ($model)")
        $reportLines.Add("- Status: **DRIFT DETECTED**")
        $reportLines.Add("- Proposed content staged at: ``$proposedPath``")
        $reportLines.Add("- Action: Review and manually apply if approved")
        $reportLines.Add("")

        Write-Host "[$model] $manifestFile : DRIFT DETECTED - proposed content staged at $proposedPath" -ForegroundColor Yellow
    } else {
        $reportLines.Add("### $manifestFile ($model)")
        $reportLines.Add("- Status: **IN SYNC**")
        $reportLines.Add("")

        Write-Host "[$model] $manifestFile : IN SYNC" -ForegroundColor Green
    }
}

# --- Write report ---
$timestamp = Get-Date -Format 'yyyy-MM-dd_HHmmss'
$reportPath = Join-Path $reportDir "babel-manifest-sync-report-${timestamp}.md"
($reportLines -join "`n") | Set-Content -Path $reportPath -Encoding UTF8

if ($Check) {
    if ($staleFiles.Count -gt 0) {
        throw "Model manifests are stale. Review proposals in tools/reports/.`nStale files: $([string]::Join(', ', $staleFiles))"
    }

    Write-Host "Manifest check passed. All model manifests are up to date." -ForegroundColor Cyan
    exit 0
}

Write-Host ""
Write-Host "Report written to: $reportPath"
if ($staleFiles.Count -gt 0) {
    Write-Host "DRIFT DETECTED in $($staleFiles.Count) file(s). Review staged proposals in tools/reports/ before applying." -ForegroundColor Yellow
    Write-Host "To apply: Copy-Item tools/reports/Babel_<MODEL>_proposed.md <manifest_file>" -ForegroundColor Yellow
} else {
    Write-Host "All manifests in sync. No action required." -ForegroundColor Green
}
