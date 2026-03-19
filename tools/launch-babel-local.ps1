[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("frontend", "backend", "compliance", "devops", "research")]
    [string]$TaskCategory,

    [ValidateSet("global", "GPCGuard", "Prismatix", "AuditGuard")]
    [string]$Project = "global",

    [string]$ProjectPath = "",

    [Parameter(Mandatory = $true)]
    [ValidateSet("codex", "claude", "gemini")]
    [string]$Model,

    [Parameter(Mandatory = $true)]
    [ValidateSet("plan", "act")]
    [string]$WorkMode,

    [Parameter(Mandatory = $true)]
    [string]$TaskPrompt,

    [ValidateSet("codex_extension", "claude_code", "gemini_cli", "other")]
    [string]$ClientSurface = "",

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

if (-not (Test-Path -LiteralPath (Join-Path $Root "prompt_catalog.yaml"))) {
    throw "Babel root does not contain prompt_catalog.yaml: $Root"
}

if ([string]::IsNullOrWhiteSpace($TaskPrompt)) {
    throw "TaskPrompt must be non-empty."
}

$startScriptPath = Join-Path $Root "tools\start-local-session.ps1"
if (-not (Test-Path -LiteralPath $startScriptPath)) {
    throw "start-local-session.ps1 not found at $startScriptPath"
}

if ([string]::IsNullOrWhiteSpace($OutputRoot)) {
    $OutputRoot = Join-Path $Root "runs\local-learning"
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

function Normalize-TaskPrompt {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Prompt
    )

    return ($Prompt.Replace("`r`n", "`n").Replace("`r", "`n")).Trim()
}

function Convert-ToPowerShellSingleQuotedLiteral {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Value
    )

    return "'" + $Value.Replace("'", "''") + "'"
}

function New-DeterministicSessionId {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RootPath,

        [Parameter(Mandatory = $true)]
        [string]$ProjectName,

        [Parameter(Mandatory = $true)]
        [AllowEmptyString()]
        [string]$ProjectPathValue,

        [Parameter(Mandatory = $true)]
        [string]$TaskKind,

        [Parameter(Mandatory = $true)]
        [string]$ModelName,

        [Parameter(Mandatory = $true)]
        [string]$Surface,

        [Parameter(Mandatory = $true)]
        [string]$Pipeline,

        [Parameter(Mandatory = $true)]
        [string]$CodexProfile,

        [Parameter(Mandatory = $true)]
        [string]$Mode,

        [Parameter(Mandatory = $true)]
        [bool]$DisableRecommended,

        [AllowNull()]
        [object[]]$OverlayIds,

        [Parameter(Mandatory = $true)]
        [string]$TaskPromptValue
    )

    $overlaySignature = @(
        Normalize-StringArray -Items $OverlayIds |
            Sort-Object
    ) -join ","

    $canonical = @(
        "v1"
        $RootPath.Trim().ToLowerInvariant()
        $ProjectName.Trim()
        $ProjectPathValue.Trim().ToLowerInvariant()
        $TaskKind.Trim()
        $ModelName.Trim()
        $Surface.Trim()
        $Pipeline.Trim()
        $CodexProfile.Trim()
        $Mode.Trim()
        [string]$DisableRecommended
        $overlaySignature
        (Normalize-TaskPrompt -Prompt $TaskPromptValue)
    ) -join "|"

    $hashAlgorithm = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($canonical)
        $hashBytes = $hashAlgorithm.ComputeHash($bytes)
        $hashHex = -join ($hashBytes | ForEach-Object { $_.ToString("x2") })
    } finally {
        $hashAlgorithm.Dispose()
    }

    return ("launch-{0}-{1}" -f $ModelName, $hashHex.Substring(0, 12))
}

function Get-ModeDirective {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Mode
    )

    $directive = switch ($Mode) {
        "plan" {
            "Start in PLAN mode. Do not implement code changes until I explicitly reply ACT."
        }
        "act" {
            "Proceed in ACT mode for this task. Keep changes minimal and verify with objective checks."
        }
    }
    return $directive
}

function Get-SurfaceStarterPhrase {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Surface
    )

    $phrase = switch ($Surface) {
        "codex_extension" {
            "Read BABEL_BIBLE.md, use Babel for this task, then plan and execute using the selected instruction stack."
        }
        "claude_code" {
            "Read BABEL_BIBLE.md and follow Babel before planning. Load the relevant Babel layers for this task, then proceed."
        }
        "gemini_cli" {
            "Read BABEL_BIBLE.md first and use Babel to assemble the correct instruction stack before analyzing or completing the task."
        }
        default {
            "Read BABEL_BIBLE.md first and use Babel to select the right instruction stack before doing this task."
        }
    }
    return $phrase
}

$normalizedTaskPrompt = Normalize-TaskPrompt -Prompt $TaskPrompt
$normalizedTaskOverlayIds = @(Normalize-StringArray -Items $TaskOverlayIds)

$resolvedClientSurface = if ([string]::IsNullOrWhiteSpace($ClientSurface)) {
    Resolve-DefaultClientSurface -ModelName $Model
} else {
    $ClientSurface
}

$resolvedSessionId = if ([string]::IsNullOrWhiteSpace($SessionId)) {
    New-DeterministicSessionId `
        -RootPath $Root `
        -ProjectName $Project `
        -ProjectPathValue $ProjectPath `
        -TaskKind $TaskCategory `
        -ModelName $Model `
        -Surface $resolvedClientSurface `
        -Pipeline $PipelineMode `
        -CodexProfile $CodexAdapter `
        -Mode $WorkMode `
        -DisableRecommended ([bool]$DisableRecommendedTaskOverlays) `
        -OverlayIds $normalizedTaskOverlayIds `
        -TaskPromptValue $normalizedTaskPrompt
} else {
    $SessionId.Trim()
}

$startParams = @{
    Root = $Root
    OutputRoot = $OutputRoot
    Project = $Project
    TaskCategory = $TaskCategory
    Model = $Model
    ClientSurface = $resolvedClientSurface
    PipelineMode = $PipelineMode
    CodexAdapter = $CodexAdapter
    SessionId = $resolvedSessionId
    Format = "json"
}

if (-not [string]::IsNullOrWhiteSpace($ProjectPath)) {
    $startParams.ProjectPath = $ProjectPath
}

if ($DisableRecommendedTaskOverlays) {
    $startParams.DisableRecommendedTaskOverlays = $true
}

if ($normalizedTaskOverlayIds.Count -gt 0) {
    $startParams.TaskOverlayIds = $normalizedTaskOverlayIds
}

$startJson = & $startScriptPath @startParams | Out-String
$startRecord = $startJson | ConvertFrom-Json

$modeDirective = Get-ModeDirective -Mode $WorkMode
$compactKickoffActive = @($startRecord.ActivePolicyIds | Where-Object { [string]$_ -like "*:kickoff_prompt_preset:compact@*" }).Count -gt 0
$surfaceStarterPhrase = if ($compactKickoffActive) {
    ""
} else {
    Get-SurfaceStarterPhrase -Surface $resolvedClientSurface
}

$promptLines = @(
    [string]$startRecord.KickoffPrompt
    $surfaceStarterPhrase
    $modeDirective
    "Task:"
    $normalizedTaskPrompt
)

$launchPrompt = ($promptLines | ForEach-Object { [string]$_ } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }) -join [Environment]::NewLine

$endSuccessCommand = "powershell -ExecutionPolicy Bypass -File .\tools\end-local-session.ps1 -SessionId $resolvedSessionId -Result success -Format json"
$endFailedCommand = "powershell -ExecutionPolicy Bypass -File .\tools\end-local-session.ps1 -SessionId $resolvedSessionId -Result failed -Format json"
$endAbandonedCommand = "powershell -ExecutionPolicy Bypass -File .\tools\end-local-session.ps1 -SessionId $resolvedSessionId -Result abandoned -Format json"
$rawBundleSessionEnvCommand = '$env:BABEL_SESSION_ID=' + (Convert-ToPowerShellSingleQuotedLiteral -Value $resolvedSessionId)
$rawBundleStartPathEnvCommand = '$env:BABEL_SESSION_START_PATH=' + (Convert-ToPowerShellSingleQuotedLiteral -Value ([string]$startRecord.SessionStartPath))
$rawBundleLocalRootEnvCommand = '$env:BABEL_LOCAL_LEARNING_ROOT=' + (Convert-ToPowerShellSingleQuotedLiteral -Value $OutputRoot)

$result = [PSCustomObject]@{
    SchemaVersion = 1
    Root = $Root
    Project = $Project
    TaskCategory = $TaskCategory
    Model = $Model
    ClientSurface = $resolvedClientSurface
    WorkMode = $WorkMode
    PipelineMode = $PipelineMode
    SessionId = $resolvedSessionId
    SelectedCodexAdapter = if ($startRecord.SelectedCodexAdapter) { [string]$startRecord.SelectedCodexAdapter } else { $null }
    RecommendedTaskOverlayIds = @($startRecord.RecommendedTaskOverlayIds)
    RecommendedStackIds = @($startRecord.RecommendedStackIds)
    RepoLocalSystemPresent = [bool]$startRecord.RepoLocalSystemPresent
    KickoffPrompt = [string]$startRecord.KickoffPrompt
    ActivePolicyIds = @($startRecord.ActivePolicyIds)
    PolicyVersionApplied = if ($startRecord.PolicyVersionApplied) { [string]$startRecord.PolicyVersionApplied } else { $null }
    WorkModeDirective = $modeDirective
    TaskPrompt = $normalizedTaskPrompt
    LaunchPrompt = $launchPrompt
    RawBundleEnvironment = [PSCustomObject]@{
        SessionId = $resolvedSessionId
        SessionStartPath = [string]$startRecord.SessionStartPath
        LocalLearningRoot = $OutputRoot
        PowerShellCommands = [PSCustomObject]@{
            SessionId = $rawBundleSessionEnvCommand
            SessionStartPath = $rawBundleStartPathEnvCommand
            LocalLearningRoot = $rawBundleLocalRootEnvCommand
        }
    }
    EndSessionCommands = [PSCustomObject]@{
        Success = $endSuccessCommand
        Failed = $endFailedCommand
        Abandoned = $endAbandonedCommand
    }
}

if ($Format -eq "json") {
    $result | ConvertTo-Json -Depth 8
    return
}

Write-Host ""
Write-Host "Babel Local launch prepared." -ForegroundColor Cyan
Write-Host "Model: $Model"
Write-Host "Client surface: $resolvedClientSurface"
Write-Host "Work mode: $WorkMode"
Write-Host "Session ID: $resolvedSessionId"
Write-Host ""
Write-Host "Launch prompt (copy/paste):" -ForegroundColor Yellow
Write-Host "-----BEGIN BABEL LAUNCH PROMPT-----"
Write-Host $launchPrompt
Write-Host "-----END BABEL LAUNCH PROMPT-----"
Write-Host ""
Write-Host "Raw bundle env for subsequent 'babel run' commands:" -ForegroundColor Yellow
Write-Host $rawBundleSessionEnvCommand
Write-Host $rawBundleStartPathEnvCommand
Write-Host $rawBundleLocalRootEnvCommand
Write-Host ""
Write-Host "End session commands (copy/paste):" -ForegroundColor Yellow
Write-Host "Success:   $endSuccessCommand"
Write-Host "Failed:    $endFailedCommand"
Write-Host "Abandoned: $endAbandonedCommand"
