<#
.SYNOPSIS
  Detached SWE-Bench Pro campaign starter with named profiles.

.DESCRIPTION
  Launches npm benchmark:agent:swe-pro in the background, writes process.json
  and heartbeat path. Returns immediately — never waits for campaign completion.
#>
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('gate0-mock', 'gate0-canary', 'remeasure-3', 'waveA-20', 'infra-only')]
  [string]$Profile,

  [Parameter(Mandatory = $true)][string]$Dataset,
  [Parameter(Mandatory = $true)][string]$EvidenceDir,

  [string]$Model = '',
  [Nullable[int]]$Limit = $null,
  [Nullable[int]]$EarlyStop = $null,
  [Nullable[int]]$AgentTimeoutMs = $null,
  [Nullable[int]]$FailToPassTimeoutMs = $null
)

$ErrorActionPreference = 'Stop'
$packageRoot = Split-Path -Parent $PSScriptRoot
$repoRoot = Split-Path -Parent $packageRoot
$datasetPath = [IO.Path]::GetFullPath($Dataset)
$evidencePath = [IO.Path]::GetFullPath($EvidenceDir)

if (-not (Test-Path -LiteralPath $datasetPath -PathType Leaf)) {
  throw "Dataset not found: $datasetPath"
}
New-Item -ItemType Directory -Force -Path $evidencePath | Out-Null

# Profile defaults (see .agents/skills/swe-pro-campaign/references/profiles.md)
$provider = 'mock'
$infraOnly = $false
$defaultModel = 'deepseek-v4-flash'
$defaultLimit = 3
$defaultEarlyStop = 5
$defaultAgentTimeoutMs = 1500000
$defaultFailToPassTimeoutMs = 900000

switch ($Profile) {
  'gate0-mock' {
    $provider = 'mock'
    $defaultLimit = 3
    $defaultAgentTimeoutMs = 1500000
  }
  'gate0-canary' {
    $provider = 'live'
    $defaultLimit = 1
    $defaultAgentTimeoutMs = 1500000
  }
  'remeasure-3' {
    $provider = 'live'
    $defaultLimit = 3
    $defaultAgentTimeoutMs = 0
  }
  'waveA-20' {
    $provider = 'live'
    $defaultLimit = 20
    $defaultAgentTimeoutMs = 0
  }
  'infra-only' {
    $provider = 'mock'
    $infraOnly = $true
    $defaultLimit = 3
  }
}

if ($Model) { $defaultModel = $Model }
if ($null -ne $Limit) { $defaultLimit = [int]$Limit }
if ($null -ne $EarlyStop) { $defaultEarlyStop = [int]$EarlyStop }
if ($null -ne $AgentTimeoutMs) { $defaultAgentTimeoutMs = [int]$AgentTimeoutMs }
if ($null -ne $FailToPassTimeoutMs) { $defaultFailToPassTimeoutMs = [int]$FailToPassTimeoutMs }

if ($provider -eq 'live' -and [string]::IsNullOrWhiteSpace($env:DEEPSEEK_API_KEY)) {
  throw "Profile $Profile requires DEEPSEEK_API_KEY in the environment (value not logged)."
}

# Honesty dual scoreboard for all skill-started campaigns
if (-not $env:BABEL_SWE_PRO_PASS_MODE) {
  $env:BABEL_SWE_PRO_PASS_MODE = 'both'
}

$stdoutPath = Join-Path $evidencePath 'campaign.stdout.log'
$stderrPath = Join-Path $evidencePath 'campaign.stderr.log'
$heartbeatPath = Join-Path $evidencePath 'heartbeat.json'
$pidPath = Join-Path $evidencePath 'process.json'
$profilePath = Join-Path $evidencePath 'profile.json'
$launcherPath = Join-Path $evidencePath 'launch.cmd'

# Build npm args. Use cmd.exe redirection (not Start-Process -Redirect*) so the
# process tree is not tied to the launching PowerShell pipes/job lifetime.
$npmArgs = [System.Collections.Generic.List[string]]::new()
$npmArgs.Add('run') | Out-Null
$npmArgs.Add('benchmark:agent:swe-pro') | Out-Null
$npmArgs.Add('--') | Out-Null
if ($infraOnly) {
  $npmArgs.Add('--infra-only') | Out-Null
} else {
  $npmArgs.Add('--provider') | Out-Null
  $npmArgs.Add($provider) | Out-Null
  if ($provider -eq 'live') {
    $npmArgs.Add('--model') | Out-Null
    $npmArgs.Add($defaultModel) | Out-Null
  }
  $npmArgs.Add('--agent-timeout-ms') | Out-Null
  $npmArgs.Add([string]$defaultAgentTimeoutMs) | Out-Null
  $npmArgs.Add('--fail-to-pass-timeout-ms') | Out-Null
  $npmArgs.Add([string]$defaultFailToPassTimeoutMs) | Out-Null
}
$npmArgs.Add('--limit') | Out-Null
$npmArgs.Add([string]$defaultLimit) | Out-Null
$npmArgs.Add('--early-stop') | Out-Null
$npmArgs.Add([string]$defaultEarlyStop) | Out-Null
$npmArgs.Add('--dataset') | Out-Null
$npmArgs.Add("`"$datasetPath`"") | Out-Null
$npmArgs.Add('--evidence-dir') | Out-Null
$npmArgs.Add("`"$evidencePath`"") | Out-Null
$npmArgs.Add('--heartbeat-file') | Out-Null
$npmArgs.Add("`"$heartbeatPath`"") | Out-Null
$npmArgs.Add('--json') | Out-Null

# launch.cmd keeps a durable process identity for monitor (cmd stays alive for full campaign).
$launchBody = @(
  '@echo off'
  "cd /d `"$packageRoot`""
  "call npm.cmd $($npmArgs -join ' ') > `"$stdoutPath`" 2> `"$stderrPath`""
  "echo EXIT_CODE=%ERRORLEVEL%>> `"$stderrPath`""
)
$launchBody -join "`r`n" | Set-Content -LiteralPath $launcherPath -Encoding ASCII

# Escape the agent/shell Job Object: Start-Process children are often killed when
# the launching tool completes. Win32_Process.Create starts outside that job.
$commandLine = "cmd.exe /c `"$launcherPath`""
$created = $null
try {
  $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine = $commandLine
    CurrentDirectory = $packageRoot
  }
} catch {
  $created = $null
}
$pidValue = $null
$launchMethod = 'win32_process'
if ($created -and [int]$created.ReturnValue -eq 0 -and $created.ProcessId) {
  $pidValue = [int]$created.ProcessId
} else {
  # Fallback: nested start may break away from some job objects.
  $launchMethod = 'cmd_start'
  $fallback = Start-Process -FilePath 'cmd.exe' `
    -ArgumentList @('/c', "start `"babel-swe-pro`" /MIN cmd.exe /c `"$launcherPath`"") `
    -WorkingDirectory $packageRoot -WindowStyle Hidden -PassThru
  $pidValue = $fallback.Id
}

$meta = [ordered]@{
  schema_version = 1
  profile = $Profile
  pid = $pidValue
  launch_method = $launchMethod
  started_at = (Get-Date).ToUniversalTime().ToString('o')
  evidence_dir = $evidencePath
  dataset = $datasetPath
  provider = $provider
  infra_only = $infraOnly
  model = if ($provider -eq 'live') { $defaultModel } else { $null }
  limit = $defaultLimit
  early_stop = $defaultEarlyStop
  agent_timeout_ms = $defaultAgentTimeoutMs
  fail_to_pass_timeout_ms = $defaultFailToPassTimeoutMs
  pass_mode = $env:BABEL_SWE_PRO_PASS_MODE
  stdout_log = $stdoutPath
  stderr_log = $stderrPath
  heartbeat_file = $heartbeatPath
  launcher = $launcherPath
  repo_root = $repoRoot
  package_root = $packageRoot
}

($meta | ConvertTo-Json -Depth 4) | Set-Content -LiteralPath $pidPath -Encoding UTF8
($meta | ConvertTo-Json -Depth 4) | Set-Content -LiteralPath $profilePath -Encoding UTF8

Write-Output "Started SWE-Pro profile=$Profile PID=$pidValue method=$launchMethod"
Write-Output "Evidence: $evidencePath"
Write-Output "Monitor: pwsh -File babel-cli/scripts/monitor_swebench_pro_live.ps1 -EvidenceDir `"$evidencePath`""
