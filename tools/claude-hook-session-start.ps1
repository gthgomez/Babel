[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("frontend", "backend", "compliance", "devops", "research")]
    [string]$TaskCategory,

    [ValidateSet("global", "GPCGuard", "Prismatix", "AuditGuard")]
    [string]$Project = "global",

    [string]$ProjectPath = "",

    [ValidateSet("direct", "verified", "autonomous")]
    [string]$PipelineMode = "direct",

    [ValidateSet("auto", "balanced", "ultra")]
    [string]$CodexAdapter = "auto",

    [string[]]$TaskOverlayIds = @(),

    [switch]$DisableRecommendedTaskOverlays,

    [string]$OutputRoot = "",

    [string]$Root = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

try {
    if ([string]::IsNullOrWhiteSpace($Root)) {
        $scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Path $PSCommandPath -Parent }
        $Root = (Resolve-Path (Join-Path $scriptDir "..")).Path
    } else {
        $Root = (Resolve-Path $Root).Path
    }

    $startScriptPath = Join-Path $Root "tools\start-local-session.ps1"
    if (-not (Test-Path $startScriptPath)) {
        throw "start-local-session.ps1 not found at $startScriptPath"
    }

    $stdinText = [Console]::In.ReadToEnd()
    if ([string]::IsNullOrWhiteSpace($stdinText)) {
        throw "Claude hook payload was empty."
    }

    $hookPayload = $stdinText | ConvertFrom-Json
    $hookEventName = [string]$hookPayload.hook_event_name
    if ($hookEventName -ne "SessionStart") {
        throw "Expected SessionStart event but received '$hookEventName'."
    }

    $sessionId = [string]$hookPayload.session_id
    if ([string]::IsNullOrWhiteSpace($sessionId)) {
        $sessionId = "{0}-{1}" -f (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssfffZ"), ([System.Guid]::NewGuid().ToString("N").Substring(0, 8))
    }

    $startParams = @{
        Root = $Root
        Project = $Project
        TaskCategory = $TaskCategory
        Model = "claude"
        ClientSurface = "claude_code"
        PipelineMode = $PipelineMode
        CodexAdapter = $CodexAdapter
        SessionId = $sessionId
        Format = "json"
    }

    if (-not [string]::IsNullOrWhiteSpace($ProjectPath)) {
        $startParams.ProjectPath = $ProjectPath
    }

    if (-not [string]::IsNullOrWhiteSpace($OutputRoot)) {
        $startParams.OutputRoot = $OutputRoot
    }

    if ($DisableRecommendedTaskOverlays) {
        $startParams.DisableRecommendedTaskOverlays = $true
    }

    if (@($TaskOverlayIds).Count -gt 0) {
        $startParams.TaskOverlayIds = $TaskOverlayIds
    }

    $startJson = & $startScriptPath @startParams | Out-String
    $startRecord = $startJson | ConvertFrom-Json
    $kickoffPrompt = [string]$startRecord.KickoffPrompt
    $context = "Babel session '$($startRecord.SessionId)' initialized. $kickoffPrompt"

    [PSCustomObject]@{
        hookSpecificOutput = @{
            hookEventName = "SessionStart"
            additionalContext = $context
        }
    } | ConvertTo-Json -Depth 4 -Compress

    exit 0
} catch {
    [Console]::Error.WriteLine("claude-hook-session-start.ps1: $($_.Exception.Message)")
    exit 1
}
