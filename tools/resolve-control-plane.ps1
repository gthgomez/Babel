[CmdletBinding()]
param(
    [string]$RepoPath = "",

    [ValidateSet("CODEX", "CLAUDE", "GEMINI")]
    [string]$Model = "CODEX",

    [string]$TaskMode = "planning",

    [object]$ToolCanWriteFiles = $false,

    [string]$ApprovalMode = "default",

    [ValidateSet("text", "json")]
    [string]$OutputFormat = "text"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Parse-YamlListBlock {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Text,

        [Parameter(Mandatory = $true)]
        [string]$SectionRegex
    )

    $match = [regex]::Match(
        $Text,
        $SectionRegex,
        [System.Text.RegularExpressions.RegexOptions]::Singleline
    )

    if (-not $match.Success) {
        return @()
    }

    $items = New-Object System.Collections.Generic.List[string]
    foreach ($line in ($match.Groups["block"].Value -split "`r?`n")) {
        $trimmed = $line.Trim()
        if ($trimmed -match "^-\s*(.+)$") {
            $items.Add($matches[1].Trim())
        }
    }

    return @($items)
}

function Get-ModelOverlayFileName {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ModelName
    )

    switch ($ModelName) {
        "CODEX" { return "RULES_MODEL_CODEX.md" }
        "CLAUDE" { return "RULES_MODEL_CLAUDE.md" }
        "GEMINI" { return "RULES_MODEL_GEMINI.md" }
        default { throw "Unsupported model: $ModelName" }
    }
}

function Convert-ToBool {
    param(
        [AllowNull()]
        [object]$Value
    )

    if ($Value -is [bool]) {
        return [bool]$Value
    }

    $text = [string]$Value
    if ([string]::IsNullOrWhiteSpace($text)) {
        return $false
    }

    switch ($text.Trim().ToLowerInvariant()) {
        "true" { return $true }
        "false" { return $false }
        "1" { return $true }
        "0" { return $false }
        default { throw "Cannot convert ToolCanWriteFiles value '$Value' to bool." }
    }
}

if ([string]::IsNullOrWhiteSpace($RepoPath)) {
    $scriptDir = if ($PSScriptRoot) {
        $PSScriptRoot
    } else {
        Split-Path -Path $PSCommandPath -Parent
    }
    $RepoPath = (Resolve-Path (Join-Path $scriptDir "..")).Path
}

if (-not (Test-Path $RepoPath)) {
    throw "Repo path not found: $RepoPath"
}

$resolvedRepoPath = (Resolve-Path $RepoPath).Path
$repoName = Split-Path -Path $resolvedRepoPath -Leaf
$systemDir = Join-Path $resolvedRepoPath "LLM_COLLABORATION_SYSTEM"
$contractPath = Join-Path $systemDir "ACTIVATION_CONTRACT.yaml"

if (-not (Test-Path $contractPath)) {
    throw "Activation contract not found: $contractPath"
}

$contractText = Get-Content -Path $contractPath -Raw

$alwaysLoadRules = Parse-YamlListBlock `
    -Text $contractText `
    -SectionRegex "always_load:\s*(?<block>(?:\s*-\s*[^\r\n]+\s*)+)"

if ($alwaysLoadRules.Count -eq 0) {
    $alwaysLoadRules = Parse-YamlListBlock `
        -Text $contractText `
        -SectionRegex "fallback_if_signal_missing:[\s\S]*?load:\s*(?<block>(?:\s*-\s*[^\r\n]+\s*)+)"
}

if ($alwaysLoadRules.Count -eq 0) {
    throw "Unable to resolve always-load files from activation contract: $contractPath"
}

$approvalTriggerModes = Parse-YamlListBlock `
    -Text $contractText `
    -SectionRegex "approval_mode_in:\s*(?<block>(?:\s*-\s*[^\r\n]+\s*)+)"
if ($approvalTriggerModes.Count -eq 0) {
    $approvalTriggerModes = @("auto_edit", "yolo")
}

$conditionalTaskModes = Parse-YamlListBlock `
    -Text $contractText `
    -SectionRegex "conditional_load:[\s\S]*?task_mode_in:\s*(?<block>(?:\s*-\s*[^\r\n]+\s*)+)"
if ($conditionalTaskModes.Count -eq 0) {
    $conditionalTaskModes = @("implement", "migrate", "deploy", "hotfix")
}

$guardSuppressionModes = Parse-YamlListBlock `
    -Text $contractText `
    -SectionRegex "do_not_load_guard_when:\s*task_mode_in:\s*(?<block>(?:\s*-\s*[^\r\n]+\s*)+)"
if ($guardSuppressionModes.Count -eq 0) {
    $guardSuppressionModes = @("research", "brainstorm", "architecture", "planning")
}

$taskModeNormalized = $TaskMode.Trim().ToLowerInvariant()
$approvalModeNormalized = $ApprovalMode.Trim().ToLowerInvariant()
$toolCanWrite = Convert-ToBool -Value $ToolCanWriteFiles

$guardRequested = $false
$guardReasons = New-Object System.Collections.Generic.List[string]

if ($toolCanWrite) {
    $guardRequested = $true
    $guardReasons.Add("tool_can_write_files=true")
}

if ($approvalTriggerModes -contains $approvalModeNormalized) {
    $guardRequested = $true
    $guardReasons.Add("approval_mode=$approvalModeNormalized")
}

if ($conditionalTaskModes -contains $taskModeNormalized) {
    $guardRequested = $true
    $guardReasons.Add("task_mode=$taskModeNormalized")
}

$guardSuppressed = $guardSuppressionModes -contains $taskModeNormalized
$guardLoaded = $guardRequested -and (-not $guardSuppressed)

$alwaysLoadFiles = New-Object System.Collections.Generic.List[string]
foreach ($ruleFile in $alwaysLoadRules) {
    $fullPath = Join-Path $systemDir $ruleFile
    $alwaysLoadFiles.Add($fullPath)
}

$corePath = @($alwaysLoadFiles | Where-Object { $_ -match "RULES_CORE\.md$" }) | Select-Object -First 1
$adapterPath = @($alwaysLoadFiles | Where-Object { $_ -match "ADAPTER_.*\.md$" }) | Select-Object -First 1
$guardPath = Join-Path $systemDir "RULES_GUARD.md"
$overlayPath = Join-Path $systemDir (Get-ModelOverlayFileName -ModelName $Model)
$sharedPath = Join-Path $systemDir "RULES_SHARED_ALL_MODELS.md"
$contextPath = Join-Path $resolvedRepoPath "PROJECT_CONTEXT.md"

foreach ($requiredPath in @($corePath, $adapterPath, $guardPath, $overlayPath, $sharedPath, $contextPath)) {
    if ([string]::IsNullOrWhiteSpace([string]$requiredPath)) {
        throw "Resolver produced an empty required file path."
    }

    if (-not (Test-Path $requiredPath)) {
        throw "Required control-plane file not found: $requiredPath"
    }
}

$effectiveLoadFiles = New-Object System.Collections.Generic.List[string]
foreach ($filePath in $alwaysLoadFiles) {
    $effectiveLoadFiles.Add($filePath)
}
if ($guardLoaded) {
    $effectiveLoadFiles.Add($guardPath)
}
$effectiveLoadFiles.Add($overlayPath)
$effectiveLoadFiles.Add($contextPath)

$result = [PSCustomObject]@{
    repository = $repoName
    repo_path = $resolvedRepoPath
    model = $Model
    task_mode = $taskModeNormalized
    tool_can_write_files = $toolCanWrite
    approval_mode = $approvalModeNormalized
    contract_path = $contractPath
    guard_requested = $guardRequested
    guard_suppressed = $guardSuppressed
    guard_loaded = $guardLoaded
    guard_reasons = @($guardReasons)
    always_load_files = @($alwaysLoadFiles)
    core_path = $corePath
    adapter_path = $adapterPath
    guard_path = $guardPath
    overlay_path = $overlayPath
    shared_path = $sharedPath
    context_path = $contextPath
    effective_load_files = @($effectiveLoadFiles)
}

if ($OutputFormat -eq "json") {
    $result | ConvertTo-Json -Depth 6
    exit 0
}

Write-Host "Repository: $($result.repository)"
Write-Host "Model: $($result.model)"
Write-Host "Task mode: $($result.task_mode)"
Write-Host "Tool can write files: $($result.tool_can_write_files)"
Write-Host "Approval mode: $($result.approval_mode)"
Write-Host "Guard requested: $($result.guard_requested)"
Write-Host "Guard suppressed: $($result.guard_suppressed)"
Write-Host "Guard loaded: $($result.guard_loaded)"
Write-Host "Guard reasons: $([string]::Join(', ', $result.guard_reasons))"
Write-Host "Effective files:"
foreach ($filePath in $result.effective_load_files) {
    Write-Host "- $filePath"
}
