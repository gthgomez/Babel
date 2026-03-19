[CmdletBinding()]
param(
    [ValidateSet("global", "GPCGuard", "Prismatix", "AuditGuard")]
    [string]$Project = "global",

    [string]$ProjectPath = "",

    [Parameter(Mandatory = $true)]
    [ValidateSet("frontend", "backend", "compliance", "devops", "research")]
    [string]$TaskCategory,

    [Parameter(Mandatory = $true)]
    [ValidateSet("codex", "claude", "gemini")]
    [string]$Model,

    [ValidateSet("codex_extension", "claude_code", "gemini_cli", "chatgpt_web", "claude_web", "gemini_web", "vscode_chat", "other")]
    [string]$ClientSurface = "other",

    [ValidateSet("direct", "verified", "autonomous")]
    [string]$PipelineMode = "direct",

    [ValidateSet("auto", "balanced", "ultra")]
    [string]$CodexAdapter = "auto",

    [string[]]$TaskOverlayIds = @(),

    [switch]$DisableRecommendedTaskOverlays,

    [string]$SessionId = "",

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

if (-not [string]::IsNullOrWhiteSpace($ProjectPath) -and -not (Test-Path $ProjectPath)) {
    throw "Provided project path does not exist: $ProjectPath"
}

if ([string]::IsNullOrWhiteSpace($OutputRoot)) {
    $OutputRoot = Join-Path $Root "runs\local-learning"
}

$resolverPath = Join-Path $Root "tools\resolve-local-stack.ps1"
if (-not (Test-Path $resolverPath)) {
    throw "Resolver script not found at $resolverPath"
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

$normalizedTaskOverlayIds = @(Normalize-StringArray -Items $TaskOverlayIds)

$resolverParams = @{
    Root = $Root
    LocalLearningRoot = $OutputRoot
    Project = $Project
    TaskCategory = $TaskCategory
    Model = $Model
    ClientSurface = $ClientSurface
    PipelineMode = $PipelineMode
    CodexAdapter = $CodexAdapter
    Format = "json"
}

if (-not [string]::IsNullOrWhiteSpace($ProjectPath)) {
    $resolverParams.ProjectPath = (Resolve-Path $ProjectPath).Path
}

if ($DisableRecommendedTaskOverlays) {
    $resolverParams.DisableRecommendedTaskOverlays = $true
}

if ($normalizedTaskOverlayIds.Count -gt 0) {
    $resolverParams.TaskOverlayIds = $normalizedTaskOverlayIds
}

$resolverJson = & $resolverPath @resolverParams | Out-String
$resolverResult = $resolverJson | ConvertFrom-Json

if ([string]::IsNullOrWhiteSpace($SessionId)) {
    $SessionId = "{0}-{1}" -f (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssfffZ"), ([System.Guid]::NewGuid().ToString("N").Substring(0, 8))
}

$startedAtUtc = (Get-Date).ToUniversalTime()
$sessionDate = $startedAtUtc.ToString("yyyy-MM-dd")
$sessionStartDir = Join-Path $OutputRoot ("session-starts\" + $sessionDate)
$sessionStartPath = Join-Path $sessionStartDir ($SessionId + ".json")

New-Item -ItemType Directory -Force -Path $sessionStartDir | Out-Null

$record = [PSCustomObject]@{
    SchemaVersion = 1
    StartedAtUtc = $startedAtUtc.ToString("o")
    SessionId = $SessionId
    Project = $Project
    ProjectPath = if ($resolverResult.ProjectPath) { [string]$resolverResult.ProjectPath } else { $null }
    TaskCategory = $TaskCategory
    Model = $Model
    ClientSurface = $ClientSurface
    PipelineMode = $PipelineMode
    CodexAdapterRequested = if ($Model -eq "codex") { $CodexAdapter } else { $null }
    SelectedCodexAdapter = if ($resolverResult.SelectedCodexAdapter) { [string]$resolverResult.SelectedCodexAdapter } else { $null }
    TaskOverlayIdsRequested = @($normalizedTaskOverlayIds)
    DisableRecommendedTaskOverlays = [bool]$DisableRecommendedTaskOverlays
    RecommendedTaskOverlayIds = @($resolverResult.RecommendedTaskOverlayIds)
    RecommendedStackIds = @($resolverResult.SelectedStack | ForEach-Object { [string]$_.Id })
    RecommendedStack = @($resolverResult.SelectedStack)
    BabelEntrypoint = [string]$resolverResult.BabelEntrypoint
    BabelReferenceFiles = @($resolverResult.BabelReferenceFiles)
    RepoContextFiles = @($resolverResult.RepoContextFiles)
    RepoLocalSystemPresent = [bool]$resolverResult.RepoLocalSystemPresent
    KickoffPrompt = [string]$resolverResult.KickoffPrompt
    ActivePolicyIds = @($resolverResult.ActivePolicyIds)
    PolicyVersionApplied = if ($resolverResult.PolicyVersionApplied) { [string]$resolverResult.PolicyVersionApplied } else { $null }
    SessionStartPath = $sessionStartPath
}

Set-Content -Path $sessionStartPath -Value ($record | ConvertTo-Json -Depth 8)

if ($Format -eq "json") {
    $record | ConvertTo-Json -Depth 8
    return
}

Write-Host ""
Write-Host "Babel Local session started." -ForegroundColor Cyan
Write-Host "Session ID: $($record.SessionId)"
Write-Host "Session start record: $sessionStartPath"
Write-Host "Kickoff prompt: $($record.KickoffPrompt)"
