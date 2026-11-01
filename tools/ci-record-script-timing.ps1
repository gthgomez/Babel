[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$SidecarPath,
  [Parameter(Mandatory = $true)][string]$Script,
  [Parameter(Mandatory = $true)][string]$InvokeJson
)

Set-StrictMode -Version Latest

try {
  $Invoke = @($InvokeJson | ConvertFrom-Json)
} catch {
  Write-Error "ci-record-script-timing: InvokeJson is not valid JSON: $_"
  exit 1
}
if ($Invoke.Count -lt 1) {
  Write-Error 'ci-record-script-timing: InvokeJson must decode to a non-empty JSON array'
  exit 1
}

$parent = Split-Path -Parent $SidecarPath
if ($parent -and -not (Test-Path -LiteralPath $parent)) {
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
}

$sw = [System.Diagnostics.Stopwatch]::StartNew()
$childExit = 1
$sidecarExit = 0

try {
  try {
    if ($Invoke.Count -eq 1) {
      & $Invoke[0]
    } else {
      & $Invoke[0] @($Invoke[1..($Invoke.Count - 1)])
    }
    if (Test-Path -Path 'Variable:global:LASTEXITCODE') {
      $childExit = [int]$global:LASTEXITCODE
    } elseif ($?) {
      $childExit = 0
    } else {
      $childExit = 1
    }
  } catch {
    $childExit = 1
  }
} finally {
  $sw.Stop()
  $record = [ordered]@{
    schema             = 'babel-ci-script-timing-v1'
    measurementScope   = 'whole-script'
    script             = $Script
    elapsedSeconds     = [math]::Round($sw.Elapsed.TotalSeconds, 3)
    exitCode           = $childExit
    candidateHead      = $env:BABEL_CI_CANDIDATE_HEAD
    checkoutHead       = $env:BABEL_CI_CHECKOUT_HEAD
    runId              = $env:GITHUB_RUN_ID
    runAttempt         = $env:GITHUB_RUN_ATTEMPT
    os                 = if ($env:BABEL_CI_MATRIX_OS) { $env:BABEL_CI_MATRIX_OS } else { $env:RUNNER_OS }
    recordedAtUtc      = [DateTimeOffset]::UtcNow.ToString('o')
  }
  try {
    Add-Content -LiteralPath $SidecarPath -Encoding utf8 -Value ($record | ConvertTo-Json -Compress) -ErrorAction Stop
  } catch {
    $sidecarExit = 1
  }
}

if ($childExit -ne 0) { exit $childExit }
if ($sidecarExit -ne 0) { exit $sidecarExit }
exit 0
