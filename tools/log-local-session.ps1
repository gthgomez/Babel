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

    [Parameter(Mandatory = $true)]
    [ValidateSet("codex_extension", "claude_code", "gemini_cli", "chatgpt_web", "claude_web", "gemini_web", "vscode_chat", "other")]
    [string]$ClientSurface,

    [ValidateSet("direct", "verified", "autonomous")]
    [string]$PipelineMode = "direct",

    [ValidateSet("auto", "balanced", "ultra")]
    [string]$CodexAdapter = "auto",

    [string[]]$TaskOverlayIds = @(),

    [switch]$DisableRecommendedTaskOverlays,

    [string[]]$SelectedStackIds = @(),

    [Parameter(Mandatory = $true)]
    [ValidateSet("success", "partial", "failed", "abandoned")]
    [string]$Result,

    [string[]]$FailureTags = @(),

    [string]$UserOverrideReason = "",

    [switch]$FollowUpNeeded,

    [int]$DurationMinutes = 0,

    [string[]]$FilesTouched = @(),

    [string]$Notes = "",

    [string]$PolicyVersionApplied = "",

    [string]$SessionId = "",

    [string]$OutputRoot = "",

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
} elseif (-not [System.IO.Path]::IsPathRooted($OutputRoot)) {
    $OutputRoot = Join-Path $Root $OutputRoot
}

$preferredShell = Get-Command pwsh -ErrorAction SilentlyContinue
$shellPath = if ($null -ne $preferredShell) {
    $preferredShell.Source
} else {
    (Get-Command powershell -ErrorAction Stop).Source
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

function Invoke-BabelResolver {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ShellPath,

        [Parameter(Mandatory = $true)]
        [string]$ResolverPath,

        [Parameter(Mandatory = $true)]
        [string]$BabelRoot,

        [Parameter(Mandatory = $true)]
        [string]$ProjectName,

        [Parameter(Mandatory = $true)]
        [string]$TaskKind,

        [Parameter(Mandatory = $true)]
        [string]$ModelName,

        [Parameter(Mandatory = $true)]
        [string]$ClientSurface,

        [Parameter(Mandatory = $true)]
        [string]$Pipeline,

        [Parameter(Mandatory = $true)]
        [string]$CodexProfile,

        [AllowEmptyCollection()]
        [Parameter(Mandatory = $true)]
        [string[]]$OverlayIds,

        [Parameter(Mandatory = $true)]
        [bool]$DisableRecommended,

        [string]$ResolvedProjectPath = "",

        [Parameter(Mandatory = $true)]
        [string]$LocalLearningRoot
    )

    $stdoutPath = [System.IO.Path]::GetTempFileName()
    $stderrPath = [System.IO.Path]::GetTempFileName()

    try {
        $args = @(
            "-NoProfile",
            "-ExecutionPolicy", "Bypass",
            "-File", $ResolverPath,
            "-Root", $BabelRoot,
            "-Project", $ProjectName,
            "-TaskCategory", $TaskKind,
            "-Model", $ModelName,
            "-ClientSurface", $ClientSurface,
            "-PipelineMode", $Pipeline,
            "-CodexAdapter", $CodexProfile,
            "-LocalLearningRoot", $LocalLearningRoot,
            "-Format", "json"
        )

        if (-not [string]::IsNullOrWhiteSpace($ResolvedProjectPath)) {
            $args += @("-ProjectPath", $ResolvedProjectPath)
        }

        if ($DisableRecommended) {
            $args += "-DisableRecommendedTaskOverlays"
        }

        $overlayIds = @(Normalize-StringArray -Items $OverlayIds)
        if ($overlayIds.Count -gt 0) {
            $args += "-TaskOverlayIds"
            $args += $overlayIds
        }

        $process = Start-Process `
            -FilePath $ShellPath `
            -ArgumentList $args `
            -Wait `
            -PassThru `
            -NoNewWindow `
            -RedirectStandardOutput $stdoutPath `
            -RedirectStandardError $stderrPath

        $stdout = if (Test-Path $stdoutPath) { Get-Content -Path $stdoutPath -Raw } else { "" }
        $stderr = if (Test-Path $stderrPath) { Get-Content -Path $stderrPath -Raw } else { "" }

        if ($process.ExitCode -ne 0) {
            $message = if ([string]::IsNullOrWhiteSpace($stderr)) { "(no stderr)" } else { $stderr.Trim() }
            throw "resolve-local-stack.ps1 failed with exit code $($process.ExitCode): $message"
        }

        return ($stdout | ConvertFrom-Json)
    } finally {
        Remove-Item -Path $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue
    }
}

$resolverPath = Join-Path $Root "tools\resolve-local-stack.ps1"
if (-not (Test-Path $resolverPath)) {
    throw "Resolver script not found at $resolverPath"
}

$resolvedProjectPath = ""
if (-not [string]::IsNullOrWhiteSpace($ProjectPath)) {
    $resolvedProjectPath = (Resolve-Path $ProjectPath).Path
}

$resolverResult = Invoke-BabelResolver `
    -ShellPath $shellPath `
    -ResolverPath $resolverPath `
    -BabelRoot $Root `
    -ProjectName $Project `
    -TaskKind $TaskCategory `
    -ModelName $Model `
    -ClientSurface $ClientSurface `
    -Pipeline $PipelineMode `
    -CodexProfile $CodexAdapter `
    -OverlayIds $TaskOverlayIds `
    -DisableRecommended ([bool]$DisableRecommendedTaskOverlays) `
    -ResolvedProjectPath $resolvedProjectPath `
    -LocalLearningRoot $OutputRoot

$recommendedStackIds = @(Normalize-StringArray -Items @($resolverResult.SelectedStack | ForEach-Object { $_.Id }))
$actualSelectedStackIds = if (@($SelectedStackIds).Count -gt 0) {
    @(Normalize-StringArray -Items $SelectedStackIds)
} else {
    $recommendedStackIds
}

$normalizedFailureTags = @(Normalize-StringArray -Items $FailureTags)
$normalizedFilesTouched = @(Normalize-StringArray -Items $FilesTouched)

$stackOverrideDetected = (($recommendedStackIds -join " || ") -ne ($actualSelectedStackIds -join " || "))
if (-not [string]::IsNullOrWhiteSpace($UserOverrideReason)) {
    $stackOverrideDetected = $true
}

if ([string]::IsNullOrWhiteSpace($SessionId)) {
    $SessionId = "{0}-{1}" -f (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssfffZ"), ([System.Guid]::NewGuid().ToString("N").Substring(0, 8))
}

$loggedAtUtc = (Get-Date).ToUniversalTime().ToString("o")
$sessionDate = (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd")
$sessionsDir = Join-Path $OutputRoot ("sessions\" + $sessionDate)
$sessionFilePath = Join-Path $sessionsDir ($SessionId + ".json")
$sessionLogPath = Join-Path $OutputRoot "session-log.jsonl"

New-Item -ItemType Directory -Force -Path $sessionsDir | Out-Null

$record = [PSCustomObject]@{
    SchemaVersion = 1
    LoggedAtUtc = $loggedAtUtc
    SessionId = $SessionId
    Project = $Project
    ProjectPath = if ($resolverResult.ProjectPath) { $resolverResult.ProjectPath } else { $resolvedProjectPath }
    TaskCategory = $TaskCategory
    Model = $Model
    ClientSurface = $ClientSurface
    PipelineMode = $PipelineMode
    CodexAdapterRequested = if ($Model -eq "codex") { $CodexAdapter } else { $null }
    SelectedCodexAdapter = $resolverResult.SelectedCodexAdapter
    RecommendedTaskOverlayIds = @($resolverResult.RecommendedTaskOverlayIds)
    RecommendedStackIds = @($recommendedStackIds)
    ActualSelectedStackIds = @($actualSelectedStackIds)
    StackOverrideDetected = $stackOverrideDetected
    UserOverrideReason = if ([string]::IsNullOrWhiteSpace($UserOverrideReason)) { $null } else { $UserOverrideReason.Trim() }
    Result = $Result
    FailureTags = @($normalizedFailureTags)
    FollowUpNeeded = [bool]$FollowUpNeeded
    DurationMinutes = if ($DurationMinutes -gt 0) { $DurationMinutes } else { $null }
    FilesTouched = @($normalizedFilesTouched)
    RepoLocalSystemPresent = [bool]$resolverResult.RepoLocalSystemPresent
    RepoContextFiles = @($resolverResult.RepoContextFiles)
    KickoffPrompt = $resolverResult.KickoffPrompt
    ActivePolicyIds = @($resolverResult.ActivePolicyIds)
    PolicyVersionApplied = if ([string]::IsNullOrWhiteSpace($PolicyVersionApplied)) {
        if ($resolverResult.PolicyVersionApplied) { [string]$resolverResult.PolicyVersionApplied } else { $null }
    } else {
        $PolicyVersionApplied.Trim()
    }
    Notes = if ([string]::IsNullOrWhiteSpace($Notes)) { $null } else { $Notes.Trim() }
}

$prettyJson = $record | ConvertTo-Json -Depth 8
$compactJson = $record | ConvertTo-Json -Depth 8 -Compress

Set-Content -Path $sessionFilePath -Value $prettyJson
Add-Content -Path $sessionLogPath -Value $compactJson

Write-Host ""
Write-Host "Babel Local session logged." -ForegroundColor Cyan
Write-Host "Session ID: $SessionId"
Write-Host "Session file: $sessionFilePath"
Write-Host "Session log: $sessionLogPath"
Write-Host "Recommended stack IDs: $($recommendedStackIds -join ', ')"
Write-Host "Actual stack IDs: $($actualSelectedStackIds -join ', ')"
Write-Host "Stack override detected: $stackOverrideDetected"
