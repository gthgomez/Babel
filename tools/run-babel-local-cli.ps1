[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("frontend", "backend", "mobile", "compliance", "devops", "research")]
    [string]$TaskCategory,

    [ValidateSet("global", "example_saas_backend", "example_llm_router", "example_web_audit", "example_mobile_suite", "example_autonomous_agent")]
    [string]$Project = "global",

    [Parameter(Mandatory = $true)]
    [ValidateSet("codex", "claude", "gemini")]
    [string]$Model,

    [ValidateSet("direct", "verified", "autonomous", "manual")]
    [string]$Mode = "verified",

    [Parameter(Mandatory = $true)]
    [string]$TaskPrompt,

    [ValidateSet("v8", "v9")]
    [string]$Orchestrator = "v9",

    [string]$SessionId = "",

    [ValidateSet("text", "json")]
    [string]$Format = "text",

    [string]$CliEntryPath = "",

    [string]$EnvFilePath = "",

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

$cliRoot = Join-Path $Root "babel-cli"
if (-not (Test-Path -LiteralPath $cliRoot)) {
    throw "babel-cli directory not found at $cliRoot"
}

if ([string]::IsNullOrWhiteSpace($CliEntryPath)) {
    $CliEntryPath = Join-Path $cliRoot "dist\index.js"
}

if ([string]::IsNullOrWhiteSpace($EnvFilePath)) {
    $EnvFilePath = Join-Path $cliRoot ".env"
}

$tsxPath = Join-Path $cliRoot "node_modules\.bin\tsx.cmd"
$tsxEntryPath = Join-Path $cliRoot "src\index.ts"
$runner = $null
$runnerArgs = @()

if (Test-Path -LiteralPath $CliEntryPath) {
    $runner = "node"
    if (Test-Path -LiteralPath $EnvFilePath) {
        $runnerArgs += "--env-file=$EnvFilePath"
    }
    $runnerArgs += $CliEntryPath
} elseif (Test-Path -LiteralPath $tsxPath) {
    $runner = $tsxPath
    if (Test-Path -LiteralPath $EnvFilePath) {
        $runnerArgs += "--env-file=$EnvFilePath"
    }
    $runnerArgs += (Resolve-Path $tsxEntryPath).Path
} else {
    throw "No runnable babel-cli entrypoint was found. Run 'npm install' in Babel-public\\babel-cli, and optionally 'npm run build' if you want the compiled dist entrypoint."
}

$resolvedCliModel = (Get-Culture).TextInfo.ToTitleCase($Model.Trim().ToLowerInvariant())
$cliArgs = @(
    "run",
    $TaskPrompt,
    "--mode", $Mode,
    "--model", $resolvedCliModel,
    "--orchestrator", $Orchestrator
)

if ($Project -ne "global") {
    $cliArgs += @("--project", $Project)
}

if (-not [string]::IsNullOrWhiteSpace($SessionId)) {
    $cliArgs += @("--session-id", $SessionId.Trim())
}

$allArgs = @($runnerArgs + $cliArgs)
$outputLines = & $runner @allArgs 2>&1 | ForEach-Object { [string]$_ }
$exitCode = $LASTEXITCODE
$outputText = ($outputLines -join [Environment]::NewLine).Trim()

$result = [PSCustomObject]@{
    SchemaVersion = 1
    Root = $Root
    CliRoot = $cliRoot
    TaskCategory = $TaskCategory
    Project = $Project
    Model = $Model
    Mode = $Mode
    Orchestrator = $Orchestrator
    Runner = $runner
    EntryPoint = if ($runner -eq "node") { $CliEntryPath } else { (Resolve-Path $tsxEntryPath).Path }
    EnvFileUsed = if (Test-Path -LiteralPath $EnvFilePath) { $EnvFilePath } else { $null }
    ExitCode = $exitCode
    CliOutput = if ([string]::IsNullOrWhiteSpace($outputText)) { $null } else { $outputText }
}

if ($Format -eq "json") {
    $result | ConvertTo-Json -Depth 6
} else {
    Write-Host ""
    Write-Host "Babel CLI wrapper run completed." -ForegroundColor Cyan
    Write-Host "Project: $Project"
    Write-Host "Task category: $TaskCategory"
    Write-Host "Model: $Model"
    Write-Host "Mode: $Mode"
    Write-Host "Orchestrator: $Orchestrator"
    Write-Host "Runner: $runner"
    Write-Host "Exit code: $exitCode"
    if (-not [string]::IsNullOrWhiteSpace($outputText)) {
        Write-Host ""
        Write-Host "babel-cli output:" -ForegroundColor Yellow
        Write-Host $outputText
    }
}

exit $exitCode
