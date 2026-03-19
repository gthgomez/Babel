[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("frontend", "backend", "compliance", "devops", "research")]
    [string]$TaskCategory,

    [ValidateSet("global", "GPCGuard", "Prismatix", "AuditGuard")]
    [string]$Project = "global",

    [string]$ProjectPath = "",

    [ValidateSet("codex", "claude", "gemini")]
    [string]$Model = "codex",

    [ValidateSet("codex_extension", "claude_code", "gemini_cli", "chatgpt_web", "claude_web", "gemini_web", "vscode_chat", "other")]
    [string]$ClientSurface = "",

    [ValidateSet("direct", "verified", "autonomous")]
    [string]$PipelineMode = "direct",

    [ValidateSet("auto", "balanced", "ultra")]
    [string]$CodexAdapter = "auto",

    [string[]]$TaskOverlayIds = @(),

    [switch]$DisableRecommendedTaskOverlays,

    [ValidateSet("text", "json")]
    [string]$Format = "text",

    [string]$LocalLearningRoot = "",

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

$catalogPath = Join-Path $Root "prompt_catalog.yaml"
if (-not (Test-Path $catalogPath)) {
    Write-Error "prompt_catalog.yaml not found at $catalogPath"
    exit 1
}

if ([string]::IsNullOrWhiteSpace($LocalLearningRoot)) {
    $LocalLearningRoot = Join-Path $Root "runs\local-learning"
} elseif (-not [System.IO.Path]::IsPathRooted($LocalLearningRoot)) {
    $LocalLearningRoot = Join-Path $Root $LocalLearningRoot
}

function Get-BabelCatalogEntries {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    $entries = @()
    $current = $null

    foreach ($line in Get-Content -Path $Path) {
        if ($line -match '^\s*-\s+id:\s+(.+)$') {
            if ($null -ne $current) {
                $entries += [PSCustomObject]$current
            }

            $current = [ordered]@{
                Id = $matches[1].Trim()
                Layer = $null
                Path = $null
                Project = $null
                LoadPosition = $null
                Status = $null
            }

            continue
        }

        if ($null -eq $current) {
            continue
        }

        if ($line -match '^\s+layer:\s+(.+)$') {
            $current.Layer = $matches[1].Trim()
            continue
        }

        if ($line -match '^\s+path:\s+(.+)$') {
            $current.Path = $matches[1].Trim().Trim('"')
            continue
        }

        if ($line -match '^\s+project:\s+(.+)$') {
            $current.Project = $matches[1].Trim()
            continue
        }

        if ($line -match '^\s+load_position:\s+(.+)$') {
            $current.LoadPosition = [int]$matches[1].Trim()
            continue
        }

        if ($line -match '^\s+status:\s+(.+)$') {
            $current.Status = $matches[1].Trim()
            continue
        }
    }

    if ($null -ne $current) {
        $entries += [PSCustomObject]$current
    }

    return $entries
}

function Get-EntryById {
    param(
        [Parameter(Mandatory = $true)]
        [PSCustomObject[]]$Entries,

        [Parameter(Mandatory = $true)]
        [string]$Id
    )

    $entry = $Entries | Where-Object { $_.Id -eq $Id } | Select-Object -First 1
    if ($null -eq $entry) {
        throw "Catalog entry '$Id' not found."
    }

    return $entry
}

function Resolve-DefaultClientSurface {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ModelName
    )

    $resolved = switch ($ModelName) {
        "codex" { "codex_extension" }
        "claude" { "claude_code" }
        "gemini" { "gemini_cli" }
    }
    return $resolved
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

function Read-JsonFile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    return (Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json)
}

function Get-ActivePolicyContainer {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        return $null
    }

    return (Read-JsonFile -Path $Path)
}

function Convert-ChecklistToHintText {
    param(
        [AllowNull()]
        [object[]]$Checklist
    )

    $hints = New-Object System.Collections.Generic.List[string]
    foreach ($item in @(Normalize-StringArray -Items $Checklist)) {
        switch ([string]$item) {
            "require_explicit_missing_evidence_statement" {
                $hints.Add("State any missing evidence explicitly before acting.")
            }
            "require_root_cause_line" {
                $hints.Add("Include one explicit root-cause line before proposing the fix.")
            }
            "require_test_plan" {
                $hints.Add("Include a concrete test plan before or alongside the implementation.")
            }
            "require_verification_summary" {
                $hints.Add("End with a short verification summary tied to objective checks.")
            }
        }
    }

    return @($hints)
}

function Get-PolicySignature {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Policy
    )

    $policyId = [string]$Policy.policy_id
    $policyVersion = [string]$Policy.policy_version
    if ([string]::IsNullOrWhiteSpace($policyVersion)) {
        return $policyId
    }

    return "{0}@{1}" -f $policyId, $policyVersion
}

$entries = Get-BabelCatalogEntries -Path $catalogPath

$resolvedClientSurface = if ([string]::IsNullOrWhiteSpace($ClientSurface)) {
    Resolve-DefaultClientSurface -ModelName $Model
} else {
    $ClientSurface
}

$domainIdMap = @{
    frontend   = "domain_swe_frontend"
    backend    = "domain_swe_backend"
    compliance = "domain_compliance_gpc"
    devops     = "domain_devops"
    research   = "domain_research"
}

$projectOverlayIdMap = @{
    GPCGuard  = "overlay_gpcguard"
    Prismatix = "overlay_prismatix"
    AuditGuard = "overlay_auditguard"
}

$taskOverlayAliasMap = @{
    "frontend-professionalism"           = "task_frontend_professionalism"
    "gpcguard-frontend-professionalism"  = "task_gpcguard_frontend_professionalism"
}

$selectedCodexAdapterName = switch ($CodexAdapter) {
    "balanced" { "balanced" }
    "ultra"    { "ultra" }
    default    { "balanced" }
}

$selectedAdapterId = switch ($Model) {
    "codex"  {
        if ($selectedCodexAdapterName -eq "ultra") {
            "adapter_codex"
        } else {
            "adapter_codex_balanced"
        }
    }
    "claude" { "adapter_claude" }
    "gemini" { "adapter_gemini" }
}

$activeRepoPolicies = @()
$activeLocalClientPolicies = @()
$activeGlobalPolicies = @()

if ($Project -ne "global") {
    $repoPolicyPath = Join-Path $LocalLearningRoot ("active\repos\" + $Project + ".json")
    $repoPolicyContainer = Get-ActivePolicyContainer -Path $repoPolicyPath
    if ($null -ne $repoPolicyContainer) {
        $activeRepoPolicies = @($repoPolicyContainer.policies | Where-Object { [string]$_.state -eq "active" })
    }
}

$localClientPolicyPath = Join-Path $LocalLearningRoot ("active\local-clients\" + $resolvedClientSurface + "." + $Model + ".json")
$localClientPolicyContainer = Get-ActivePolicyContainer -Path $localClientPolicyPath
if ($null -ne $localClientPolicyContainer) {
    $activeLocalClientPolicies = @($localClientPolicyContainer.policies | Where-Object { [string]$_.state -eq "active" })
}

$globalPolicyPath = Join-Path $LocalLearningRoot "active\global-policy.json"
$globalPolicyContainer = Get-ActivePolicyContainer -Path $globalPolicyPath
if ($null -ne $globalPolicyContainer) {
    $activeGlobalPolicies = @($globalPolicyContainer.policies | Where-Object { [string]$_.state -eq "active" })
}

$appliedPolicies = New-Object System.Collections.Generic.List[object]
$appliedPoliciesBySurface = @{}

foreach ($policy in @($activeRepoPolicies)) {
    $surface = [string]$policy.target_surface
    if (-not [string]::IsNullOrWhiteSpace($surface) -and -not $appliedPoliciesBySurface.ContainsKey($surface)) {
        $appliedPoliciesBySurface[$surface] = $policy
        $appliedPolicies.Add($policy)
    }
}

foreach ($policy in @($activeLocalClientPolicies)) {
    $surface = [string]$policy.target_surface
    if (-not [string]::IsNullOrWhiteSpace($surface) -and -not $appliedPoliciesBySurface.ContainsKey($surface)) {
        $appliedPoliciesBySurface[$surface] = $policy
        $appliedPolicies.Add($policy)
    }
}

foreach ($policy in @($activeGlobalPolicies)) {
    $surface = [string]$policy.target_surface
    if (-not [string]::IsNullOrWhiteSpace($surface) -and -not $appliedPoliciesBySurface.ContainsKey($surface)) {
        $appliedPoliciesBySurface[$surface] = $policy
        $appliedPolicies.Add($policy)
    }
}

$activePolicyIds = New-Object System.Collections.Generic.List[string]
$activeVerificationHints = New-Object System.Collections.Generic.List[string]

foreach ($policy in $appliedPolicies.ToArray()) {
    $activePolicyIds.Add((Get-PolicySignature -Policy $policy))

    if ([string]$policy.target_surface -eq "verification_loop_hints") {
        foreach ($hint in @(Convert-ChecklistToHintText -Checklist @($policy.proposed_change.checklist))) {
            $activeVerificationHints.Add($hint)
        }
    }
}

$resolverRankingPolicy = if ($appliedPoliciesBySurface.ContainsKey("resolver_ranking")) {
    $appliedPoliciesBySurface["resolver_ranking"]
} else {
    $null
}

if ($null -ne $resolverRankingPolicy -and $Model -eq "codex") {
    $preferredStackIds = @(Normalize-StringArray -Items @($resolverRankingPolicy.proposed_change.preferred_stack_ids))
    if ($preferredStackIds -contains "adapter_codex") {
        $selectedCodexAdapterName = "ultra"
        $selectedAdapterId = "adapter_codex"
    } elseif ($preferredStackIds -contains "adapter_codex_balanced") {
        $selectedCodexAdapterName = "balanced"
        $selectedAdapterId = "adapter_codex_balanced"
    }
}

$selectedTaskOverlayIds = New-Object System.Collections.Generic.List[string]

if (-not $DisableRecommendedTaskOverlays) {
    if ($TaskCategory -eq "frontend") {
        $selectedTaskOverlayIds.Add("task_frontend_professionalism")
    }

    if ($Project -eq "GPCGuard" -and $TaskCategory -eq "frontend") {
        $selectedTaskOverlayIds.Add("task_gpcguard_frontend_professionalism")
    }
}

foreach ($overlayId in $TaskOverlayIds) {
    if ([string]::IsNullOrWhiteSpace($overlayId)) {
        continue
    }

    $normalized = $overlayId.Trim()
    if ($taskOverlayAliasMap.ContainsKey($normalized)) {
        $normalized = $taskOverlayAliasMap[$normalized]
    }

    $selectedTaskOverlayIds.Add($normalized)
}

$selectedTaskOverlayIds = $selectedTaskOverlayIds |
    Select-Object -Unique

$selectedEntries = New-Object System.Collections.Generic.List[object]
$order = 0

foreach ($id in @(
    "behavioral_core_v7",
    "behavioral_guard_v7",
    $domainIdMap[$TaskCategory],
    $selectedAdapterId
)) {
    $entry = Get-EntryById -Entries $entries -Id $id
    $selectedEntries.Add([PSCustomObject]@{
        Id = $entry.Id
        Layer = $entry.Layer
        LoadPosition = $entry.LoadPosition
        RelativePath = $entry.Path
        FullPath = Join-Path $Root $entry.Path
        OrderIndex = $order++
    })
}

if ($Project -ne "global") {
    $projectOverlayId = $projectOverlayIdMap[$Project]
    if ($projectOverlayId) {
        $entry = Get-EntryById -Entries $entries -Id $projectOverlayId
        $selectedEntries.Add([PSCustomObject]@{
            Id = $entry.Id
            Layer = $entry.Layer
            LoadPosition = $entry.LoadPosition
            RelativePath = $entry.Path
            FullPath = Join-Path $Root $entry.Path
            OrderIndex = $order++
        })
    }
}

foreach ($overlayId in $selectedTaskOverlayIds) {
    $entry = Get-EntryById -Entries $entries -Id $overlayId

    if ($entry.Project -and $Project -ne $entry.Project) {
        Write-Error "Task overlay '$overlayId' is scoped to project '$($entry.Project)' and cannot be used for project '$Project'."
        exit 1
    }

    $selectedEntries.Add([PSCustomObject]@{
        Id = $entry.Id
        Layer = $entry.Layer
        LoadPosition = $entry.LoadPosition
        RelativePath = $entry.Path
        FullPath = Join-Path $Root $entry.Path
        OrderIndex = $order++
    })
}

switch ($PipelineMode) {
    "verified" {
        $entry = Get-EntryById -Entries $entries -Id "pipeline_qa_reviewer"
        $selectedEntries.Add([PSCustomObject]@{
            Id = $entry.Id
            Layer = $entry.Layer
            LoadPosition = $entry.LoadPosition
            RelativePath = $entry.Path
            FullPath = Join-Path $Root $entry.Path
            OrderIndex = $order++
        })
    }
    "autonomous" {
        foreach ($id in @("pipeline_qa_reviewer", "pipeline_cli_executor")) {
            $entry = Get-EntryById -Entries $entries -Id $id
            $selectedEntries.Add([PSCustomObject]@{
                Id = $entry.Id
                Layer = $entry.Layer
                LoadPosition = $entry.LoadPosition
                RelativePath = $entry.Path
                FullPath = Join-Path $Root $entry.Path
                OrderIndex = $order++
            })
        }
    }
}

$selectedEntries = $selectedEntries |
    Sort-Object LoadPosition, OrderIndex

$projectSaaSRoot = Split-Path -Path $Root -Parent
$resolvedProjectPath = $null

if (-not [string]::IsNullOrWhiteSpace($ProjectPath)) {
    if (Test-Path $ProjectPath) {
        $resolvedProjectPath = (Resolve-Path $ProjectPath).Path
    } else {
        Write-Error "Provided project path does not exist: $ProjectPath"
        exit 1
    }
} elseif ($Project -ne "global") {
    $inferredProjectPath = Join-Path $projectSaaSRoot $Project
    if (Test-Path $inferredProjectPath) {
        $resolvedProjectPath = (Resolve-Path $inferredProjectPath).Path
    }
}

$repoContextFiles = New-Object System.Collections.Generic.List[string]
$repoLocalSystemPresent = $false

if ($resolvedProjectPath) {
    $projectContextPath = Join-Path $resolvedProjectPath "PROJECT_CONTEXT.md"
    if (Test-Path $projectContextPath) {
        $repoContextFiles.Add($projectContextPath)
    }

    $localSystemReadme = Join-Path $resolvedProjectPath "LLM_COLLABORATION_SYSTEM\README_FOR_HUMANS_AND_LLMS.md"
    if (Test-Path $localSystemReadme) {
        $repoContextFiles.Add($localSystemReadme)
        $repoLocalSystemPresent = $true
    }
}

$kickoffPolicy = if ($appliedPoliciesBySurface.ContainsKey("kickoff_prompt_preset")) {
    $appliedPoliciesBySurface["kickoff_prompt_preset"]
} else {
    $null
}
$compactKickoffActive = (
    $null -ne $kickoffPolicy -and
    [string]$kickoffPolicy.proposed_change.preset_id -eq "compact"
)

$kickoffPrompt = if ($compactKickoffActive) {
    if ($repoLocalSystemPresent) {
        "Read BABEL_BIBLE.md, then this repo's PROJECT_CONTEXT.md and LLM_COLLABORATION_SYSTEM before planning or coding."
    } elseif ($repoContextFiles.Count -gt 0) {
        "Read BABEL_BIBLE.md, then this repo's PROJECT_CONTEXT.md before planning or coding."
    } else {
        "Read BABEL_BIBLE.md before planning or coding."
    }
} elseif ($repoLocalSystemPresent) {
    "Read Babel's BABEL_BIBLE.md first, use Babel to select the right instruction stack for this task, then read this repo's PROJECT_CONTEXT.md and LLM_COLLABORATION_SYSTEM/README_FOR_HUMANS_AND_LLMS.md before planning or coding."
} elseif ($repoContextFiles.Count -gt 0) {
    "Read Babel's BABEL_BIBLE.md first, use Babel to select the right instruction stack for this task, then read this repo's PROJECT_CONTEXT.md before planning or coding."
} else {
    "Read Babel's BABEL_BIBLE.md first and use Babel to select the right instruction stack for this task before planning or coding."
}

$verificationHints = @(Normalize-StringArray -Items $activeVerificationHints.ToArray())
if ($verificationHints.Count -gt 0) {
    $kickoffPrompt = $kickoffPrompt + " " + (($verificationHints | ForEach-Object { [string]$_ }) -join " ")
}

$result = [PSCustomObject]@{
    BabelRoot = $Root
    LocalLearningRoot = $LocalLearningRoot
    Project = $Project
    ProjectPath = $resolvedProjectPath
    TaskCategory = $TaskCategory
    Model = $Model
    ClientSurface = $resolvedClientSurface
    PipelineMode = $PipelineMode
    SelectedCodexAdapter = if ($Model -eq "codex") { $selectedCodexAdapterName } else { $null }
    RecommendedTaskOverlayIds = @($selectedTaskOverlayIds)
    BabelEntrypoint = Join-Path $Root "BABEL_BIBLE.md"
    BabelReferenceFiles = @(
        Join-Path $Root "PROJECT_CONTEXT.md"
        Join-Path $Root "prompt_catalog.yaml"
    )
    SelectedStack = $selectedEntries
    RepoContextFiles = $repoContextFiles
    RepoLocalSystemPresent = $repoLocalSystemPresent
    PrecedenceRules = @(
        "Babel chooses the cross-project stack and operating mode."
        "The repo-local collaboration system defines repo-specific invariants and startup rules."
        "Repo-local invariants win for repo-specific conflicts."
    )
    KickoffPrompt = $kickoffPrompt
    ActivePolicyIds = @(Normalize-StringArray -Items $activePolicyIds.ToArray())
    PolicyVersionApplied = (@(Normalize-StringArray -Items $activePolicyIds.ToArray()) -join ";")
}

if ($Format -eq "json") {
    $result | ConvertTo-Json -Depth 6
    exit 0
}

Write-Host ""
Write-Host "Babel Local Stack Resolution" -ForegroundColor Cyan
Write-Host "Project: $Project"
Write-Host "Task category: $TaskCategory"
Write-Host "Model: $Model"
Write-Host "Client surface: $resolvedClientSurface"
Write-Host "Pipeline mode: $PipelineMode"
if ($Model -eq "codex") {
    Write-Host "Codex adapter: $selectedCodexAdapterName"
}

Write-Host ""
Write-Host "Babel entrypoint:" -ForegroundColor Yellow
Write-Host "  1. $($result.BabelEntrypoint)"

Write-Host ""
Write-Host "Babel reference files:" -ForegroundColor Yellow
$refIndex = 2
foreach ($path in $result.BabelReferenceFiles) {
    Write-Host "  $refIndex. $path"
    $refIndex++
}

Write-Host ""
Write-Host "Selected Babel stack:" -ForegroundColor Yellow
$stackIndex = 1
foreach ($item in $result.SelectedStack) {
    Write-Host "  $stackIndex. [$($item.Layer)] $($item.FullPath)"
    $stackIndex++
}

Write-Host ""
Write-Host "Repo-local context:" -ForegroundColor Yellow
if ($result.RepoContextFiles.Count -eq 0) {
    Write-Host "  None detected."
} else {
    $repoIndex = 1
    foreach ($path in $result.RepoContextFiles) {
        Write-Host "  $repoIndex. $path"
        $repoIndex++
    }
}

Write-Host ""
Write-Host "Precedence:" -ForegroundColor Yellow
foreach ($rule in $result.PrecedenceRules) {
    Write-Host "  - $rule"
}

Write-Host ""
Write-Host "Recommended kickoff prompt:" -ForegroundColor Yellow
Write-Host "  $($result.KickoffPrompt)"
