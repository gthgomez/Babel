param(
  [string]$RepoRoot = (Split-Path -Parent $PSScriptRoot),
  [switch]$Strict,
  [switch]$RequireExternalScanner,
  [string]$ReportPath = ''
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $RepoRoot)) {
  throw "RepoRoot not found: $RepoRoot"
}

$scriptRoot = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $PSCommandPath }
$scrubScriptPath = Join-Path $scriptRoot 'check-public-scrub.ps1'
if (-not (Test-Path -LiteralPath $scrubScriptPath)) {
  $scrubScriptPath = Join-Path $RepoRoot 'tools/check-public-scrub.ps1'
}
if (-not (Test-Path -LiteralPath $scrubScriptPath)) {
  throw "check-public-scrub.ps1 not found for public secret scan."
}

$preferredShell = Get-Command pwsh -ErrorAction SilentlyContinue
if ($null -ne $preferredShell) {
  $shellPath = $preferredShell.Source
} else {
  $shellPath = (Get-Command powershell -ErrorAction Stop).Source
}

$policyPath = Join-Path $RepoRoot 'tools/security/policy.json'
if (-not (Test-Path -LiteralPath $policyPath)) {
  $policyPath = Join-Path $RepoRoot 'tools/public-export/sync_policy.json'
}
if (-not (Test-Path -LiteralPath $policyPath)) {
  $policyPath = Join-Path $scriptRoot 'public-export/sync_policy.json'
}
if (-not (Test-Path -LiteralPath $policyPath)) {
  $policyPath = Join-Path $scriptRoot 'security/policy.json'
}

$requiredScannerName = 'gitleaks'
$requiredScannerVersion = '8.30.1'
$fallbackScannerName = 'trufflehog'
if (Test-Path -LiteralPath $policyPath) {
  $syncPolicy = Get-Content -Raw -LiteralPath $policyPath | ConvertFrom-Json
  if ($syncPolicy.secret_scanner) {
    if ($syncPolicy.secret_scanner.required) {
      if ($syncPolicy.secret_scanner.required.name) {
        $requiredScannerName = [string]$syncPolicy.secret_scanner.required.name
      }
      if ($syncPolicy.secret_scanner.required.version) {
        $requiredScannerVersion = [string]$syncPolicy.secret_scanner.required.version
      }
    }
    if ($syncPolicy.secret_scanner.fallback -and $syncPolicy.secret_scanner.fallback.name) {
      $fallbackScannerName = [string]$syncPolicy.secret_scanner.fallback.name
    }
  }
}

function Write-SecretScanReport {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Status,
    [string]$Scanner = '',
    [string[]]$Messages = @()
  )

  if (-not $ReportPath) {
    return
  }

  $reportDirectory = Split-Path -Parent $ReportPath
  if ($reportDirectory -and -not (Test-Path -LiteralPath $reportDirectory)) {
    New-Item -ItemType Directory -Path $reportDirectory -Force | Out-Null
  }

  $report = @{
    status = $Status
    repo_root = $RepoRoot
    scanner = $Scanner
    strict = [bool]$Strict
    require_external_scanner = [bool]$RequireExternalScanner
    messages = @($Messages)
  }
  Set-Content -Path $ReportPath -Value (ConvertTo-Json -Depth 10 $report)
}

function Get-ScannerVersionText {
  param([System.Management.Automation.CommandInfo]$Command)

  $output = @(& $Command.Source version 2>&1)
  if ($LASTEXITCODE -ne 0) {
    return ''
  }
  return (@($output) -join ' ').Trim()
}

function Test-RequiredScannerVersion {
  param([System.Management.Automation.CommandInfo]$Command)

  $versionText = Get-ScannerVersionText -Command $Command
  return @{
    Matches = ($versionText -match [regex]::Escape($requiredScannerVersion))
    VersionText = $versionText
  }
}

function Invoke-GitleaksScan {
  param([System.Management.Automation.CommandInfo]$Command)

  & $Command.Source detect --no-git --redact --source $RepoRoot
  if ($LASTEXITCODE -ne 0) {
    Write-SecretScanReport -Status 'fail' -Scanner $requiredScannerName -Messages @("$requiredScannerName failed with exit code $LASTEXITCODE.")
    exit 1
  }
  Write-SecretScanReport -Status 'pass' -Scanner $requiredScannerName -Messages @("Local scrub and $requiredScannerName $requiredScannerVersion passed.")
  Write-Host "Public secret scan passed with $requiredScannerName $requiredScannerVersion." -ForegroundColor Green
  exit 0
}

$scrubArgs = @('-RepoRoot', $RepoRoot)
if ($Strict) {
  $scrubArgs += '-Strict'
}

& $shellPath -NoProfile -ExecutionPolicy Bypass -File $scrubScriptPath @scrubArgs
$scrubExitCode = $LASTEXITCODE
if ($scrubExitCode -ne 0) {
  Write-SecretScanReport -Status 'fail' -Scanner 'check-public-scrub' -Messages @('Local public scrub check failed.')
  exit 1
}

$gitleaks = Get-Command $requiredScannerName -ErrorAction SilentlyContinue
if ($null -ne $gitleaks) {
  $versionCheck = Test-RequiredScannerVersion -Command $gitleaks
  if ($versionCheck.Matches) {
    Invoke-GitleaksScan -Command $gitleaks
  }

  $versionMessage = "Required external scanner is $requiredScannerName $requiredScannerVersion, but found '$($versionCheck.VersionText)'."
  if ($RequireExternalScanner) {
    Write-Host $versionMessage -ForegroundColor Red
    Write-SecretScanReport -Status 'fail' -Scanner $requiredScannerName -Messages @($versionMessage)
    exit 1
  }
  Write-Host $versionMessage -ForegroundColor Yellow
} elseif ($RequireExternalScanner) {
  $message = "Required external scanner not found: $requiredScannerName $requiredScannerVersion. Install the pinned scanner before running the enforced public release security gate."
  Write-Host $message -ForegroundColor Red
  Write-SecretScanReport -Status 'fail' -Scanner $requiredScannerName -Messages @($message)
  exit 1
}

$trufflehog = Get-Command $fallbackScannerName -ErrorAction SilentlyContinue
if ($null -ne $trufflehog) {
  & $trufflehog.Source filesystem --no-update --fail $RepoRoot
  if ($LASTEXITCODE -ne 0) {
    Write-SecretScanReport -Status 'fail' -Scanner $fallbackScannerName -Messages @("$fallbackScannerName failed with exit code $LASTEXITCODE.")
    exit 1
  }
  Write-SecretScanReport -Status 'pass' -Scanner $fallbackScannerName -Messages @("Local scrub and fallback scanner $fallbackScannerName passed. Required release scanner remains $requiredScannerName $requiredScannerVersion.")
  Write-Host "Public secret scan passed with fallback scanner $fallbackScannerName. Required release scanner remains $requiredScannerName $requiredScannerVersion." -ForegroundColor Green
  exit 0
}

$message = "No matching external scanner found. Install $requiredScannerName $requiredScannerVersion for enforced public release security scanning; optional local fallback scanner is $fallbackScannerName."
Write-Host $message -ForegroundColor Yellow
Write-SecretScanReport -Status 'warn' -Scanner '' -Messages @($message)
exit 0
