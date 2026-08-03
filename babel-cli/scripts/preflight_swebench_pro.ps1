<#
.SYNOPSIS
  Measurement-plane preflight for SWE-Bench Pro campaigns (Gate 0 / skill).

.DESCRIPTION
  Writes a redacted preflight-receipt.json. Does not print secrets.
  Exit 0 when ok=true; exit 1 when blocking failures exist.
#>
param(
  [Parameter(Mandatory = $true)][string]$EvidenceDir,
  [string]$Dataset = '',
  [switch]$RequireDocker,
  [switch]$RequirePython311,
  [switch]$RequireLiveCredential
)

$ErrorActionPreference = 'Stop'
$evidencePath = [IO.Path]::GetFullPath($EvidenceDir)
New-Item -ItemType Directory -Force -Path $evidencePath | Out-Null

$failures = [System.Collections.Generic.List[string]]::new()
$warnings = [System.Collections.Generic.List[string]]::new()
$checks = [ordered]@{}

function Test-CommandAvailable([string]$Name) {
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

# Docker
$dockerOk = $false
$dockerVersion = $null
if (Test-CommandAvailable 'docker') {
  try {
    $dockerVersion = (& docker version --format '{{.Server.Version}}' 2>$null | Out-String).Trim()
    if ($LASTEXITCODE -eq 0 -and $dockerVersion) { $dockerOk = $true }
  } catch {
    $dockerOk = $false
  }
}
$checks['docker_available'] = $dockerOk
$checks['docker_server_version'] = $dockerVersion
if (-not $dockerOk) {
  if ($RequireDocker) { $failures.Add('docker_unavailable') }
  else { $warnings.Add('docker_unavailable') }
}

# Host Python
$hostPython = $null
$hostPythonVersion = $null
$hostRequiredOk = $false
foreach ($candidate in @('py', 'python', 'python3')) {
  if (-not (Test-CommandAvailable $candidate)) { continue }
  try {
    if ($candidate -eq 'py') {
      $ver = (& py -3 --version 2>$null | Out-String).Trim()
      $bin = 'py -3'
    } else {
      $ver = (& $candidate --version 2>$null | Out-String).Trim()
      $bin = $candidate
    }
    if ($ver -match 'Python\s+(\d+)\.(\d+)') {
      $hostPython = $bin
      $hostPythonVersion = $ver
      $major = [int]$Matches[1]
      $minor = [int]$Matches[2]
      if ($major -gt 3 -or ($major -eq 3 -and $minor -ge 11)) {
        # Probe typing.Required
        $probe = if ($candidate -eq 'py') {
          & py -3 -c "from typing import Required; print('ok')" 2>&1 | Out-String
        } else {
          & $candidate -c "from typing import Required; print('ok')" 2>&1 | Out-String
        }
        if ($probe -match 'ok') { $hostRequiredOk = $true }
      }
      break
    }
  } catch {
    continue
  }
}
$checks['host_python'] = $hostPython
$checks['host_python_version'] = $hostPythonVersion
$checks['host_typing_required_ok'] = $hostRequiredOk
if (-not $hostRequiredOk) {
  if ($RequirePython311) { $failures.Add('host_python_lt_311_or_no_Required') }
  else { $warnings.Add('host_python_lt_311_or_no_Required_use_docker_plane') }
}

# Docker Python 3.11 probe (optional, best-effort)
$dockerPythonOk = $false
$dockerPythonVersion = $null
if ($dockerOk) {
  try {
    $img = 'python:3.11-slim'
    $out = (& docker run --rm $img python -c "import sys; from typing import Required; print(sys.version.split()[0])" 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -eq 0 -and $out -match '^\d+\.\d+') {
      $dockerPythonOk = $true
      $dockerPythonVersion = ($out -split "`n" | Select-Object -Last 1).Trim()
    }
  } catch {
    $dockerPythonOk = $false
  }
}
$checks['docker_python311_ok'] = $dockerPythonOk
$checks['docker_python_version'] = $dockerPythonVersion
if ($RequireDocker -and -not $dockerPythonOk) {
  $failures.Add('docker_python311_probe_failed')
}

# Dataset
$datasetOk = $false
$datasetPath = $null
$datasetBytes = $null
if ($Dataset) {
  $datasetPath = [IO.Path]::GetFullPath($Dataset)
  if (Test-Path -LiteralPath $datasetPath -PathType Leaf) {
    $datasetOk = $true
    $datasetBytes = (Get-Item -LiteralPath $datasetPath).Length
  } else {
    $failures.Add('dataset_missing')
  }
} else {
  $warnings.Add('dataset_not_provided')
}
$checks['dataset_ok'] = $datasetOk
$checks['dataset_path_length'] = if ($datasetPath) { $datasetPath.Length } else { $null }
$checks['dataset_bytes'] = $datasetBytes
if ($datasetPath -and $datasetPath.Length -gt 180) {
  $warnings.Add('dataset_path_long_consider_short_evidence_root')
}

# Git
$gitOk = Test-CommandAvailable 'git'
$checks['git_available'] = $gitOk
if (-not $gitOk) { $failures.Add('git_unavailable') }

# Live credential presence (boolean only)
$liveKeyPresent = -not [string]::IsNullOrWhiteSpace($env:DEEPSEEK_API_KEY)
$checks['live_credential_present'] = $liveKeyPresent
if ($RequireLiveCredential -and -not $liveKeyPresent) {
  $failures.Add('DEEPSEEK_API_KEY_missing')
}

# Evidence path length
$checks['evidence_path_length'] = $evidencePath.Length
if ($evidencePath.Length -gt 160) {
  $warnings.Add('evidence_path_long_prefer_short_runs_root')
}

$ok = $failures.Count -eq 0
# Soft gate for measurement plane: warn if neither host nor docker python 3.11
if (-not $hostRequiredOk -and -not $dockerPythonOk) {
  $warnings.Add('no_python311_measurement_plane_yet')
}

$receipt = [ordered]@{
  schema_version = 1
  kind = 'babel_swe_pro_preflight'
  ok = $ok
  created_at = (Get-Date).ToUniversalTime().ToString('o')
  evidence_dir = $evidencePath
  checks = $checks
  failures = @($failures)
  warnings = @($warnings)
  notes = @(
    'Secrets are never included.',
    'Host Python 3.10 lacks typing.Required — prefer Docker python:3.11-slim plane.',
    'Use start_swebench_pro.ps1 for detached campaigns; never block multi-cell live in an agent tool.'
  )
}

$receiptPath = Join-Path $evidencePath 'preflight-receipt.json'
($receipt | ConvertTo-Json -Depth 6) | Set-Content -LiteralPath $receiptPath -Encoding UTF8

Write-Output "preflight ok=$ok receipt=$receiptPath"
if ($failures.Count -gt 0) {
  Write-Output ("failures: " + ($failures -join ', '))
}
if ($warnings.Count -gt 0) {
  Write-Output ("warnings: " + ($warnings -join ', '))
}

if (-not $ok) { exit 1 }
exit 0
