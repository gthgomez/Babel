[CmdletBinding()]
param(
    [ValidateSet("success", "partial", "failed", "abandoned")]
    [string]$Result = "partial",

    [switch]$FollowUpNeeded,

    [int]$DurationMinutes = 0,

    [string]$NotesPrefix = "Claude Code SessionEnd hook",

    [string]$OutputRoot = "",

    [string]$Root = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Convert-ToTagToken {
    param(
        [AllowNull()]
        [string]$Text
    )

    if ([string]::IsNullOrWhiteSpace($Text)) {
        return "unknown"
    }

    $token = $Text.ToLowerInvariant() -replace "[^a-z0-9]+", "_"
    $token = $token.Trim("_")
    if ([string]::IsNullOrWhiteSpace($token)) {
        return "unknown"
    }

    return $token
}

try {
    if ([string]::IsNullOrWhiteSpace($Root)) {
        $scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Path $PSCommandPath -Parent }
        $Root = (Resolve-Path (Join-Path $scriptDir "..")).Path
    } else {
        $Root = (Resolve-Path $Root).Path
    }

    $endScriptPath = Join-Path $Root "tools\end-local-session.ps1"
    if (-not (Test-Path $endScriptPath)) {
        throw "end-local-session.ps1 not found at $endScriptPath"
    }

    $stdinText = [Console]::In.ReadToEnd()
    if ([string]::IsNullOrWhiteSpace($stdinText)) {
        throw "Claude hook payload was empty."
    }

    $hookPayload = $stdinText | ConvertFrom-Json
    $hookEventName = [string]$hookPayload.hook_event_name
    if ($hookEventName -ne "SessionEnd") {
        throw "Expected SessionEnd event but received '$hookEventName'."
    }

    $sessionId = [string]$hookPayload.session_id
    if ([string]::IsNullOrWhiteSpace($sessionId)) {
        throw "SessionEnd hook payload is missing session_id."
    }

    $reason = [string]$hookPayload.reason
    $reasonTag = Convert-ToTagToken -Text $reason
    $failureTags = if ($Result -eq "success") {
        @()
    } else {
        @("hook_session_end", "hook_reason_$reasonTag")
    }
    $notes = "$NotesPrefix. reason=$reason; reason_tag=$reasonTag"
    $needsFollowUp = [bool]$FollowUpNeeded -or ($Result -ne "success")

    $endParams = @{
        Root = $Root
        SessionId = $sessionId
        Result = $Result
        FailureTags = $failureTags
        DurationMinutes = $DurationMinutes
        Notes = $notes
        Format = "json"
    }

    if ($needsFollowUp) {
        $endParams.FollowUpNeeded = $true
    }

    if (-not [string]::IsNullOrWhiteSpace($OutputRoot)) {
        $endParams.OutputRoot = $OutputRoot
    }

    $null = & $endScriptPath @endParams | Out-String
    exit 0
} catch {
    [Console]::Error.WriteLine("claude-hook-session-end.ps1: $($_.Exception.Message)")
    exit 1
}
