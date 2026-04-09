[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("frontend", "backend", "compliance", "devops", "research", "mobile")]
    [string]$TaskCategory,

    [ValidateSet("global", "example_saas_backend", "example_llm_router", "example_web_audit", "example_mobile_suite", "Antigavity_Projects")]
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

    [string]$TaskPrompt = "",

    [ValidateSet("execution", "verification", "learning", "exploration", "audit")]
    [string]$PurposeMode = "",

    [switch]$DisableRecommendedTaskOverlays,

    [Alias("OutputFormat")]
    [ValidateSet("text", "json")]
    [string]$Format = "text",

    [switch]$Json,

    [string]$LocalLearningRoot = "",

    [string]$Root = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$Model = $Model.Trim().ToLowerInvariant()
if ($Json) {
    $Format = "json"
}

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
    $defaultSkillIds = $null

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
                Tags = @()
                DefaultSkillIds = @()
                LoadPosition = $null
                Status = $null
            }

            $defaultSkillIds = $null
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

        if ($line -match '^\s+tags:\s+\[(.*)\]\s*$') {
            $rawTags = $matches[1].Trim()
            if ([string]::IsNullOrWhiteSpace($rawTags)) {
                $current.Tags = @()
            } else {
                $current.Tags = @(
                    $rawTags.Split(',') |
                        ForEach-Object { $_.Trim().Trim('"') } |
                        Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
                )
            }
            continue
        }

        if ($line -match '^\s+default_skill_ids:\s*$') {
            $defaultSkillIds = New-Object System.Collections.Generic.List[string]
            continue
        }

        if ($line -match '^\s{6,}-\s+(.+)$') {
            if ($null -ne $defaultSkillIds) {
                $defaultSkillIds.Add($matches[1].Trim())
                $current.DefaultSkillIds = @($defaultSkillIds)
                continue
            }
        } else {
            $defaultSkillIds = $null
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

function Get-WorkspaceRoot {
    param(
        [Parameter(Mandatory = $true)]
        [string]$BabelRoot
    )

    return (Split-Path -Path $BabelRoot -Parent)
}

function Get-RepoMapPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$BabelRoot
    )

    if (-not [string]::IsNullOrWhiteSpace($env:BABEL_REPO_MAP_PATH)) {
        return $env:BABEL_REPO_MAP_PATH
    }

    $workspaceRoot = Get-WorkspaceRoot -BabelRoot $BabelRoot
    return (Join-Path $workspaceRoot "config\repo-map.json")
}

function Get-RepoMap {
    param(
        [Parameter(Mandatory = $true)]
        [string]$BabelRoot
    )

    $repoMapPath = Get-RepoMapPath -BabelRoot $BabelRoot
    if (-not (Test-Path -LiteralPath $repoMapPath)) {
        return $null
    }

    try {
        return (Read-JsonFile -Path $repoMapPath)
    } catch {
        return $null
    }
}

function Get-RepoMapValue {
    param(
        [AllowNull()]
        [object]$RepoMap,

        [Parameter(Mandatory = $true)]
        [string]$Key
    )

    if ($null -eq $RepoMap -or $null -eq $RepoMap.repos) {
        return $null
    }

    $property = $RepoMap.repos.PSObject.Properties[$Key]
    if ($null -eq $property) {
        return $null
    }

    return [string]$property.Value
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

function Get-AlwaysLoadBehavioralEntries {
    param(
        [Parameter(Mandatory = $true)]
        [PSCustomObject[]]$Entries
    )

    return @(
        $Entries |
            Where-Object {
                $_.Layer -eq "behavioral_os" -and
                $_.Status -eq "active" -and
                @($_.Tags) -contains "always_load"
            } |
            Sort-Object `
                @{ Expression = { if ($null -eq $_.LoadPosition) { [int]::MaxValue } else { [int]$_.LoadPosition } } }, `
                @{ Expression = { [string]$_.Id } }
    )
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

function Get-LayerRank {
    param(
        [AllowNull()]
        [string]$Layer
    )

    switch ($Layer) {
        "behavioral_os" { return 1 }
        "domain_architect" { return 2 }
        "skill" { return 3 }
        "model_adapter" { return 4 }
        "project_overlay" { return 5 }
        "task_overlay" { return 6 }
        "pipeline_stage" { return 7 }
        default { return 999 }
    }
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

function Normalize-TaskPrompt {
    param(
        [AllowNull()]
        [string]$Prompt
    )

    if ($null -eq $Prompt) {
        return ""
    }

    return ($Prompt.Replace("`r`n", "`n").Replace("`r", "`n")).Trim()
}

function Test-RegexAny {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Text,

        [Parameter(Mandatory = $true)]
        [string[]]$Patterns
    )

    foreach ($pattern in $Patterns) {
        if ($Text -match $pattern) {
            return $true
        }
    }

    return $false
}

function Get-InferredPurposeModeFromPrompt {
    param(
        [Parameter(Mandatory = $true)]
        [string]$TaskCategoryValue,

        [AllowNull()]
        [string]$TaskPromptValue
    )

    $normalizedPrompt = Normalize-TaskPrompt -Prompt $TaskPromptValue
    if ([string]::IsNullOrWhiteSpace($normalizedPrompt)) {
        return "execution"
    }

    $prompt = $normalizedPrompt.ToLowerInvariant()

    $adaptiveDepthPositivePatterns = @(
        '\bteach( me)?\b',
        '\bwalk me through\b',
        '\bwalk through\b',
        '\bhelp me understand\b',
        '\bdemystify\b',
        '\bbreak (this|it|that) down\b',
        '\bbreak down\b',
        '\bfrom first principles\b',
        '\bfirst principles\b',
        '\bnew to this\b',
        '\bbeginner\b',
        '\bnever touched (this|the) codebase\b',
        '\bi (am|''m) (pretty )?(lost|confused)\b',
        '\bi keep getting lost\b',
        '\bwhat matters first\b',
        '\bonboard me\b'
    )

    $adaptiveDepthShortFormPatterns = @(
        '\bone sentence\b',
        '\bkeep it brief\b',
        '\bbriefly\b',
        '\bbrief\b',
        '\bshort answer\b',
        '\bquick overview\b'
    )

    $epistemicPositivePatterns = @(
        '\bfact[- ]?check\b',
        '\bis this true\b',
        '\bverify (whether|if)\b',
        '\bsanity[- ]check\b',
        '\bis this right\b',
        '\bam i missing\b',
        '\bmissing something\b',
        '\bstill match\b',
        '\bstill line up\b',
        '\bhow sure\b',
        '\buncertain\b',
        '\buncertainty\b',
        '\bcurrent status\b',
        '\blatest status\b',
        '\bdoes .* still .* today\b',
        '\bis (this|that|the .+?) safe\b',
        '\bconfidence\b.*\b(evidence|uncertain|uncertainty|incomplete|verify|verification|truth)\b',
        '\b(evidence|uncertain|uncertainty|incomplete|verify|verification|truth)\b.*\bconfidence\b'
    )

    $epistemicNegativePatterns = @(
        '\bconfidence\b.*\b(color|colour|token|design token|css variable|theme|palette)\b',
        '\b(color|colour|token|design token|css variable|theme|palette)\b.*\bconfidence\b'
    )

    $explorationPositivePatterns = @(
        '\bbrainstorm\b',
        '\bwhat if\b',
        '\balternatives?\b',
        '\btrade[- ]offs?\b',
        '\bcompare\b.*\b(approach|approaches|option|options|path|paths|strategy|strategies|alternative|alternatives)\b',
        '\b(approach|approaches|option|options|path|paths|strategy|strategies|alternative|alternatives)\b.*\bcompare\b',
        '\bwhich path\b',
        '\bless risky\b',
        '\bneed a direction\b',
        '\bdirection for\b',
        '\bshould we\b.*\bor\b',
        '\bkeep\b.*\bor move\b'
    )

    $explorationNegativePatterns = @(
        '\bcompare\b.*\b(json|file|files|array|arrays|object|objects|schema|schemas|diff|changed keys|indexes)\b',
        '\buse the .* strategy\b.*\bapply\b',
        '\blearn the current schema\b.*\badd\b'
    )

    $shouldTriggerAdaptiveDepth = Test-RegexAny -Text $prompt -Patterns $adaptiveDepthPositivePatterns
    if ($shouldTriggerAdaptiveDepth -and (Test-RegexAny -Text $prompt -Patterns $adaptiveDepthShortFormPatterns)) {
        if (-not (Test-RegexAny -Text $prompt -Patterns @('\bnew to this\b', '\bbeginner\b', '\bnever touched (this|the) codebase\b', '\bi (am|''m) (pretty )?(lost|confused)\b', '\bi keep getting lost\b'))) {
            $shouldTriggerAdaptiveDepth = $false
        }
    }

    $shouldTriggerEpistemic = (Test-RegexAny -Text $prompt -Patterns $epistemicPositivePatterns) -and -not (Test-RegexAny -Text $prompt -Patterns $epistemicNegativePatterns)
    $shouldTriggerExploration = (Test-RegexAny -Text $prompt -Patterns $explorationPositivePatterns) -and -not (Test-RegexAny -Text $prompt -Patterns $explorationNegativePatterns)

    if ($shouldTriggerEpistemic) {
        return "verification"
    }

    if ($shouldTriggerExploration) {
        return "exploration"
    }

    if ($shouldTriggerAdaptiveDepth) {
        return "learning"
    }

    return "execution"
}

function Get-PurposeSeedSkillId {
    param(
        [AllowNull()]
        [string]$PurposeModeValue,

        [Parameter(Mandatory = $true)]
        [psobject]$PurposeModeSeedMap
    )

    if ([string]::IsNullOrWhiteSpace($PurposeModeValue)) {
        return $null
    }

    $property = $PurposeModeSeedMap.PSObject.Properties[[string]$PurposeModeValue]
    if ($null -eq $property) {
        return $null
    }

    if ($null -eq $property.Value -or [string]::IsNullOrWhiteSpace([string]$property.Value)) {
        return $null
    }

    return [string]$property.Value
}

function Get-PurposeDiagnostics {
    param(
        [Parameter(Mandatory = $true)]
        [string]$PurposeModeValue,

        [Parameter(Mandatory = $true)]
        [string]$DomainIdValue,

        [Parameter(Mandatory = $true)]
        [string]$PipelineModeValue,

        [Parameter(Mandatory = $true)]
        [psobject]$PurposeModeSeedMap
    )

    $seedSkillId = Get-PurposeSeedSkillId -PurposeModeValue $PurposeModeValue -PurposeModeSeedMap $PurposeModeSeedMap
    if ($null -eq $seedSkillId) {
        return [PSCustomObject]@{
            PurposeSeedSkillId = $null
            PurposeSuppressionReason = if ($PurposeModeValue -eq "audit") { "no_seed_audit" } else { "no_seed_execution" }
        }
    }

    if ($PipelineModeValue -eq "autonomous" -and ($PurposeModeValue -eq "learning" -or $PurposeModeValue -eq "exploration")) {
        return [PSCustomObject]@{
            PurposeSeedSkillId = $null
            PurposeSuppressionReason = "suppressed_by_autonomous_context"
        }
    }

    if ($DomainIdValue -eq "domain_research") {
        return [PSCustomObject]@{
            PurposeSeedSkillId = $null
            PurposeSuppressionReason = "suppressed_by_domain_research"
        }
    }

    if ($DomainIdValue -eq "domain_product_audit") {
        return [PSCustomObject]@{
            PurposeSeedSkillId = $null
            PurposeSuppressionReason = "suppressed_by_domain_product_audit"
        }
    }

    return [PSCustomObject]@{
        PurposeSeedSkillId = $seedSkillId
        PurposeSuppressionReason = "typed_seeded"
    }
}

function Get-ProvisionalPurposeSelection {
    param(
        [AllowNull()]
        [string]$ExplicitPurposeMode,

        [Parameter(Mandatory = $true)]
        [string]$InferredPurposeMode
    )

    if (-not [string]::IsNullOrWhiteSpace($ExplicitPurposeMode)) {
        return [PSCustomObject]@{
            Mode = $ExplicitPurposeMode
            Source = "provisional_local_explicit"
            Confidence = 0.95
            Canonical = $false
        }
    }

    if ($InferredPurposeMode -ne "execution") {
        return [PSCustomObject]@{
            Mode = $InferredPurposeMode
            Source = "provisional_local_inference"
            Confidence = 0.55
            Canonical = $false
        }
    }

    return [PSCustomObject]@{
        Mode = "execution"
        Source = "provisional_local_default"
        Confidence = 0.3
        Canonical = $false
    }
}

function Get-DomainDefaultSkillEntries {
    param(
        [Parameter(Mandatory = $true)]
        [PSCustomObject[]]$Entries,

        [Parameter(Mandatory = $true)]
        [string]$DomainId
    )

    $domainEntry = Get-EntryById -Entries $Entries -Id $DomainId
    $defaultEntries = New-Object System.Collections.Generic.List[object]

    foreach ($skillId in @($domainEntry.DefaultSkillIds)) {
        if ([string]::IsNullOrWhiteSpace([string]$skillId)) {
            continue
        }

        $defaultEntries.Add((Get-EntryById -Entries $Entries -Id ([string]$skillId)))
    }

    return @($defaultEntries.ToArray())
}

function Read-JsonFile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    return (Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json)
}

function Get-PurposeModeSeedMap {
    param(
        [Parameter(Mandatory = $true)]
        [string]$BabelRoot
    )

    $mappingPath = Join-Path $BabelRoot "config\purpose-mode-seeds.json"
    if (-not (Test-Path -LiteralPath $mappingPath)) {
        throw "Purpose mapping file not found: $mappingPath"
    }

    return (Read-JsonFile -Path $mappingPath)
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
    mobile     = "domain_android_kotlin"
}

$projectOverlayIdMap = @{
    example_saas_backend           = "overlay_example_saas_backend"
    example_llm_router          = "overlay_example_llm_router"
    example_web_audit         = "overlay_example_web_audit"
    example_mobile_suite    = "overlay_example_mobile_suite"
}

$projectRepoKeyMap = @{
    example_saas_backend            = "example_saas_backend"
    example_llm_router           = "example_llm_router"
    example_web_audit          = "example_web_audit"
    example_mobile_suite     = "example_mobile_suite"
    Antigavity_Projects = "antigavity_projects"
}

$taskOverlayAliasMap = @{
    "frontend-professionalism"           = "task_frontend_professionalism"
    "example_saas_backend-frontend-professionalism"  = "task_example_saas_backend_frontend_professionalism"
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

$purposeModeSeedMap = Get-PurposeModeSeedMap -BabelRoot $Root
$resolvedDomainId = $domainIdMap[$TaskCategory]
$inferredPurposeMode = Get-InferredPurposeModeFromPrompt -TaskCategoryValue $TaskCategory -TaskPromptValue $TaskPrompt
$provisionalPurpose = Get-ProvisionalPurposeSelection -ExplicitPurposeMode $PurposeMode -InferredPurposeMode $inferredPurposeMode
$purposeDiagnostics = Get-PurposeDiagnostics `
    -PurposeModeValue ([string]$provisionalPurpose.Mode) `
    -DomainIdValue $resolvedDomainId `
    -PipelineModeValue $PipelineMode `
    -PurposeModeSeedMap $purposeModeSeedMap

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

    if ($Project -eq "example_saas_backend" -and $TaskCategory -eq "frontend") {
        $selectedTaskOverlayIds.Add("task_example_saas_backend_frontend_professionalism")
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

$selectedCognitionSkillIds = @(
    if (-not [string]::IsNullOrWhiteSpace([string]$purposeDiagnostics.PurposeSeedSkillId)) {
        [string]$purposeDiagnostics.PurposeSeedSkillId
    }
)

$selectedEntries = New-Object System.Collections.Generic.List[object]
$order = 0

$baseEntries = @(
    @(Get-AlwaysLoadBehavioralEntries -Entries $entries) +
    @(
        Get-EntryById -Entries $entries -Id $domainIdMap[$TaskCategory]
    ) +
    @(
        foreach ($skillId in $selectedCognitionSkillIds) {
            Get-EntryById -Entries $entries -Id $skillId
        }
    ) +
    @(
        Get-DomainDefaultSkillEntries -Entries $entries -DomainId $domainIdMap[$TaskCategory]
    ) +
    @(
        Get-EntryById -Entries $entries -Id $selectedAdapterId
    )
)

foreach ($entry in $baseEntries) {
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
    Sort-Object `
        @{ Expression = { Get-LayerRank -Layer ([string]$_.Layer) } }, `
        @{ Expression = { if ($null -eq $_.LoadPosition) { [int]::MaxValue } else { [int]$_.LoadPosition } } }, `
        @{ Expression = { [int]$_.OrderIndex } }

$workspaceRoot = Get-WorkspaceRoot -BabelRoot $Root
$repoMap = Get-RepoMap -BabelRoot $Root
$resolvedProjectPath = $null

if (-not [string]::IsNullOrWhiteSpace($ProjectPath)) {
    if (Test-Path $ProjectPath) {
        $resolvedProjectPath = (Resolve-Path $ProjectPath).Path
    } else {
        Write-Error "Provided project path does not exist: $ProjectPath"
        exit 1
    }
} elseif ($Project -ne "global") {
    $repoMapKey = $projectRepoKeyMap[$Project]
    $mappedProjectPath = if ([string]::IsNullOrWhiteSpace($repoMapKey)) {
        $null
    } else {
        Get-RepoMapValue -RepoMap $repoMap -Key $repoMapKey
    }

    if (-not [string]::IsNullOrWhiteSpace($mappedProjectPath) -and (Test-Path -LiteralPath $mappedProjectPath)) {
        $resolvedProjectPath = (Resolve-Path $mappedProjectPath).Path
    } else {
        $legacyFamilyMap = @{
            example_saas_backend            = "Project_SaaS"
            example_llm_router           = "Project_SaaS"
            example_web_audit          = "Project_SaaS"
            example_mobile_suite     = ""
            Antigavity_Projects = ""
        }

        $family = $legacyFamilyMap[$Project]
        $inferredProjectPath = if ([string]::IsNullOrWhiteSpace($family)) {
            Join-Path $workspaceRoot $Project
        } else {
            Join-Path (Join-Path $workspaceRoot $family) $Project
        }

        if (Test-Path $inferredProjectPath) {
            $resolvedProjectPath = (Resolve-Path $inferredProjectPath).Path
        }
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
        "Read C:\Workspace\Babel-private\BABEL_BIBLE.md, then this repo's PROJECT_CONTEXT.md and LLM_COLLABORATION_SYSTEM before planning or coding."
    } elseif ($repoContextFiles.Count -gt 0) {
        "Read C:\Workspace\Babel-private\BABEL_BIBLE.md, then this repo's PROJECT_CONTEXT.md before planning or coding."
    } else {
        "Read C:\Workspace\Babel-private\BABEL_BIBLE.md before planning or coding."
    }
} elseif ($repoLocalSystemPresent) {
    "Read Babel's C:\Workspace\Babel-private\BABEL_BIBLE.md first, use Babel to select the right instruction stack for this task, then read this repo's PROJECT_CONTEXT.md and LLM_COLLABORATION_SYSTEM/README_FOR_HUMANS_AND_LLMS.md before planning or coding."
} elseif ($repoContextFiles.Count -gt 0) {
    "Read Babel's C:\Workspace\Babel-private\BABEL_BIBLE.md first, use Babel to select the right instruction stack for this task, then read this repo's PROJECT_CONTEXT.md before planning or coding."
} else {
    "Read Babel's C:\Workspace\Babel-private\BABEL_BIBLE.md first and use Babel to select the right instruction stack for this task before planning or coding."
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
    PurposeResolutionMode = "provisional"
    ProvisionalPurposeMode = [string]$provisionalPurpose.Mode
    ProvisionalPurposeSource = [string]$provisionalPurpose.Source
    ProvisionalPurposeConfidence = [double]$provisionalPurpose.Confidence
    PurposeModeCanonical = [bool]$provisionalPurpose.Canonical
    PurposeSeedSkillId = if ($purposeDiagnostics.PurposeSeedSkillId) { [string]$purposeDiagnostics.PurposeSeedSkillId } else { $null }
    PurposeSuppressionReason = [string]$purposeDiagnostics.PurposeSuppressionReason
    SelectedCodexAdapter = if ($Model -eq "codex") { $selectedCodexAdapterName } else { $null }
    RecommendedTaskOverlayIds = @($selectedTaskOverlayIds)
    RecommendedSkillIds = @($selectedCognitionSkillIds)
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
