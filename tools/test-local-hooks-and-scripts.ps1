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

$startScript = Join-Path $Root "tools\start-local-session.ps1"
$endScript = Join-Path $Root "tools\end-local-session.ps1"
$hookStartScript = Join-Path $Root "tools\claude-hook-session-start.ps1"
$hookEndScript = Join-Path $Root "tools\claude-hook-session-end.ps1"
$startFixture = Join-Path $Root "tests\fixtures\local-hooks\claude-session-start.payload.json"
$endFixture = Join-Path $Root "tests\fixtures\local-hooks\claude-session-end.payload.json"

foreach ($requiredPath in @($startScript, $endScript, $hookStartScript, $hookEndScript, $startFixture, $endFixture)) {
    if (-not (Test-Path $requiredPath)) {
        throw "Required file not found: $requiredPath"
    }
}

$preferredShell = Get-Command pwsh -ErrorAction SilentlyContinue
$shellPath = if ($null -ne $preferredShell) {
    $preferredShell.Source
} else {
    (Get-Command powershell -ErrorAction Stop).Source
}

function Invoke-Script {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ShellPath,

        [Parameter(Mandatory = $true)]
        [string]$ScriptPath,

        [AllowEmptyCollection()]
        [string[]]$Arguments = @(),

        [string]$StdinPath = ""
    )

    $stdoutPath = [System.IO.Path]::GetTempFileName()
    $stderrPath = [System.IO.Path]::GetTempFileName()

    try {
        $argList = @(
            "-NoProfile",
            "-ExecutionPolicy", "Bypass",
            "-File", $ScriptPath
        ) + @($Arguments)

        $processParams = @{
            FilePath = $ShellPath
            ArgumentList = $argList
            Wait = $true
            PassThru = $true
            NoNewWindow = $true
            RedirectStandardOutput = $stdoutPath
            RedirectStandardError = $stderrPath
        }

        if (-not [string]::IsNullOrWhiteSpace($StdinPath)) {
            $processParams.RedirectStandardInput = $StdinPath
        }

        $process = Start-Process @processParams

        return [PSCustomObject]@{
            ExitCode = $process.ExitCode
            Stdout = if (Test-Path $stdoutPath) { Get-Content -Path $stdoutPath -Raw } else { "" }
            Stderr = if (Test-Path $stderrPath) { Get-Content -Path $stderrPath -Raw } else { "" }
        }
    } finally {
        Remove-Item -Path $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue
    }
}

function Assert-True {
    param(
        [Parameter(Mandatory = $true)]
        [bool]$Condition,

        [Parameter(Mandatory = $true)]
        [string]$Message
    )

    if (-not $Condition) {
        throw $Message
    }
}

function Assert-Equal {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Label,

        [AllowNull()]
        [object]$Expected,

        [AllowNull()]
        [object]$Actual
    )

    if ([string]$Expected -ne [string]$Actual) {
        throw "$Label mismatch. Expected '$Expected' but got '$Actual'."
    }
}

function Get-ArrayCount {
    param(
        [AllowNull()]
        [object]$Record,

        [Parameter(Mandatory = $true)]
        [string]$PropertyName
    )

    if ($null -eq $Record) {
        return 0
    }

    $property = $Record.PSObject.Properties[$PropertyName]
    if ($null -eq $property) {
        return 0
    }

    return @($property.Value).Count
}

$outputRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("babel-local-hooks-test-" + [System.Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null

try {
    $manualSessionId = "manual-local-session-001"
    $geminiSessionId = "gemini-local-session-001"

    $startResult = Invoke-Script `
        -ShellPath $shellPath `
        -ScriptPath $startScript `
        -Arguments @(
            "-Root", $Root,
            "-OutputRoot", $outputRoot,
            "-Project", "global",
            "-TaskCategory", "devops",
            "-Model", "claude",
            "-ClientSurface", "claude_code",
            "-SessionId", $manualSessionId,
            "-Format", "json"
        )

    Assert-Equal -Label "start-local-session exit code" -Expected 0 -Actual $startResult.ExitCode
    $startJson = $startResult.Stdout | ConvertFrom-Json
    Assert-Equal -Label "start-local-session SessionId" -Expected $manualSessionId -Actual $startJson.SessionId
    Assert-Equal -Label "start-local-session Model" -Expected "claude" -Actual $startJson.Model
    Assert-Equal -Label "start-local-session TaskCategory" -Expected "devops" -Actual $startJson.TaskCategory
    Assert-True -Condition (Test-Path $startJson.SessionStartPath) -Message "Session start record was not created."

    $endResult = Invoke-Script `
        -ShellPath $shellPath `
        -ScriptPath $endScript `
        -Arguments @(
            "-Root", $Root,
            "-OutputRoot", $outputRoot,
            "-SessionId", $manualSessionId,
            "-Result", "success",
            "-FilesTouched", "tools/start-local-session.ps1",
            "-Format", "json"
        )

    Assert-Equal -Label "end-local-session exit code" -Expected 0 -Actual $endResult.ExitCode
    $endJson = $endResult.Stdout | ConvertFrom-Json
    Assert-Equal -Label "end-local-session SessionId" -Expected $manualSessionId -Actual $endJson.SessionId
    Assert-Equal -Label "end-local-session Result" -Expected "success" -Actual $endJson.Result
    Assert-True -Condition (Test-Path $endJson.SessionEndPath) -Message "Session end record was not created."
    Assert-True -Condition (Test-Path $endJson.SessionLogPath) -Message "Session log file was not created."

    $hookStartResult = Invoke-Script `
        -ShellPath $shellPath `
        -ScriptPath $hookStartScript `
        -Arguments @(
            "-Root", $Root,
            "-OutputRoot", $outputRoot,
            "-TaskCategory", "devops",
            "-Project", "global",
            "-PipelineMode", "direct"
        ) `
        -StdinPath $startFixture

    Assert-Equal -Label "claude-hook-session-start exit code" -Expected 0 -Actual $hookStartResult.ExitCode
    $hookStartJson = $hookStartResult.Stdout | ConvertFrom-Json
    Assert-Equal -Label "hook start event name" -Expected "SessionStart" -Actual $hookStartJson.hookSpecificOutput.hookEventName
    Assert-True `
        -Condition ([string]$hookStartJson.hookSpecificOutput.additionalContext).Contains("claude-hook-session-001") `
        -Message "Hook start additionalContext did not include the expected session ID."

    $hookSessionStartPath = @(
        Get-ChildItem -Path (Join-Path $outputRoot "session-starts") -Recurse -File -Filter "claude-hook-session-001.json"
    ) | Select-Object -First 1
    Assert-True -Condition ($null -ne $hookSessionStartPath) -Message "Hook-based session start record was not created."

    $hookEndResult = Invoke-Script `
        -ShellPath $shellPath `
        -ScriptPath $hookEndScript `
        -Arguments @(
            "-Root", $Root,
            "-OutputRoot", $outputRoot,
            "-Result", "partial"
        ) `
        -StdinPath $endFixture

    Assert-Equal -Label "claude-hook-session-end exit code" -Expected 0 -Actual $hookEndResult.ExitCode

    $hookFinalizeResult = Invoke-Script `
        -ShellPath $shellPath `
        -ScriptPath $endScript `
        -Arguments @(
            "-Root", $Root,
            "-OutputRoot", $outputRoot,
            "-SessionId", "claude-hook-session-001",
            "-Result", "success",
            "-Format", "json"
        )

    Assert-Equal -Label "hook session explicit finalize exit code" -Expected 0 -Actual $hookFinalizeResult.ExitCode

    $successHookSessionId = "claude-hook-session-success-001"
    $null = Invoke-Script `
        -ShellPath $shellPath `
        -ScriptPath $startScript `
        -Arguments @(
            "-Root", $Root,
            "-OutputRoot", $outputRoot,
            "-Project", "global",
            "-TaskCategory", "devops",
            "-Model", "claude",
            "-ClientSurface", "claude_code",
            "-SessionId", $successHookSessionId,
            "-Format", "json"
        )

    $successHookPayloadPath = Join-Path $outputRoot "claude-session-end-success.payload.json"
    Set-Content -Path $successHookPayloadPath -Value '{"hook_event_name":"SessionEnd","session_id":"claude-hook-session-success-001","reason":"clear"}'

    $successHookEndResult = Invoke-Script `
        -ShellPath $shellPath `
        -ScriptPath $hookEndScript `
        -Arguments @(
            "-Root", $Root,
            "-OutputRoot", $outputRoot,
            "-Result", "success"
        ) `
        -StdinPath $successHookPayloadPath

    Assert-Equal -Label "claude-hook-session-end success exit code" -Expected 0 -Actual $successHookEndResult.ExitCode

    $geminiStartResult = Invoke-Script `
        -ShellPath $shellPath `
        -ScriptPath $startScript `
        -Arguments @(
            "-Root", $Root,
            "-OutputRoot", $outputRoot,
            "-Project", "global",
            "-TaskCategory", "research",
            "-Model", "gemini",
            "-ClientSurface", "gemini_cli",
            "-SessionId", $geminiSessionId,
            "-Format", "json"
        )

    Assert-Equal -Label "gemini start exit code" -Expected 0 -Actual $geminiStartResult.ExitCode

    $geminiEndResult = Invoke-Script `
        -ShellPath $shellPath `
        -ScriptPath $endScript `
        -Arguments @(
            "-Root", $Root,
            "-OutputRoot", $outputRoot,
            "-SessionId", $geminiSessionId,
            "-Result", "success",
            "-Format", "json"
        )

    Assert-Equal -Label "gemini end exit code" -Expected 0 -Actual $geminiEndResult.ExitCode

    $sessionLogPath = Join-Path $outputRoot "session-log.jsonl"
    $logLines = Get-Content -Path $sessionLogPath
    Assert-Equal -Label "session log line count" -Expected 4 -Actual $logLines.Count

    $logRecords = @($logLines | ForEach-Object { $_ | ConvertFrom-Json })

    $hookSessionRecord = @(
        $logRecords |
            Where-Object { $_.SessionId -eq "claude-hook-session-001" } |
            Select-Object -First 1
    )
    Assert-True -Condition ($null -ne $hookSessionRecord) -Message "Hook session log entry was not found."
    Assert-Equal -Label "hook session reconciled result" -Expected "success" -Actual $hookSessionRecord.Result
    Assert-Equal -Label "hook session client surface" -Expected "claude_code" -Actual $hookSessionRecord.ClientSurface
    Assert-Equal -Label "hook session reconciled failure tag count" -Expected 0 -Actual (Get-ArrayCount -Record $hookSessionRecord -PropertyName "FailureTags")

    $successHookRecord = @(
        $logRecords |
            Where-Object { $_.SessionId -eq $successHookSessionId } |
            Select-Object -First 1
    )
    Assert-True -Condition ($null -ne $successHookRecord) -Message "Success hook session log entry was not found."
    Assert-Equal -Label "success hook result" -Expected "success" -Actual $successHookRecord.Result
    Assert-Equal -Label "success hook failure tag count" -Expected 0 -Actual (Get-ArrayCount -Record $successHookRecord -PropertyName "FailureTags")

    $geminiRecord = @(
        $logRecords |
            Where-Object { $_.SessionId -eq $geminiSessionId } |
            Select-Object -First 1
    )
    Assert-True -Condition ($null -ne $geminiRecord) -Message "Gemini session log entry was not found."
    Assert-Equal -Label "gemini client surface" -Expected "gemini_cli" -Actual $geminiRecord.ClientSurface
    Assert-Equal -Label "gemini result" -Expected "success" -Actual $geminiRecord.Result

    Write-Host "local hooks and scripts regression tests passed." -ForegroundColor Cyan
} finally {
    Remove-Item -Path $outputRoot -Recurse -Force -ErrorAction SilentlyContinue
}
