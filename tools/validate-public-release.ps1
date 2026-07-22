[CmdletBinding()]
param(
  [string]$Root = '',
  [switch]$Strict,
  [string]$SupplementalPolicyPath = '',
  [switch]$RequireSupplementalPolicy
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($Root)) {
  $scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Path $PSCommandPath -Parent }
  $Root = (Resolve-Path (Join-Path $scriptDir '..')).Path
} else {
  $Root = (Resolve-Path $Root).Path
}

$cliRoot = Join-Path $Root 'babel-cli'
$validateCatalogScriptPath = Join-Path $Root 'tools\validate-catalog.ps1'
$checkPublicScrubScriptPath = Join-Path $Root 'tools\check-public-scrub.ps1'
$checkPublicContentPolicyScriptPath = Join-Path $Root 'tools\check-public-content-policy.ps1'
$checkCanonicalIndependenceScriptPath = Join-Path $Root 'tools\check-canonical-independence.ps1'
$resolveLocalStackScriptPath = Join-Path $Root 'tools\resolve-local-stack.ps1'

$preferredShell = Get-Command pwsh -ErrorAction SilentlyContinue
if ($null -ne $preferredShell) {
  $shellPath = $preferredShell.Source
} else {
  $shellPath = (Get-Command powershell -ErrorAction Stop).Source
}

function Invoke-Step {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Label,

    [Parameter(Mandatory = $true)]
    [scriptblock]$Body
  )

  Write-Host ''
  Write-Host "==> $Label" -ForegroundColor Cyan
  & $Body
  if ($LASTEXITCODE -ne 0) {
    throw "$Label failed with exit code $LASTEXITCODE"
  }
}

if (-not (Test-Path -LiteralPath $cliRoot)) {
  throw "babel-cli directory not found at $cliRoot"
}
if (-not (Test-Path -LiteralPath $validateCatalogScriptPath)) {
  throw "Catalog validation script not found at $validateCatalogScriptPath"
}
if (-not (Test-Path -LiteralPath $checkPublicScrubScriptPath)) {
  throw "Public scrub script not found at $checkPublicScrubScriptPath"
}
if (-not (Test-Path -LiteralPath $checkPublicContentPolicyScriptPath)) {
  throw "Public content policy script not found at $checkPublicContentPolicyScriptPath"
}
if (-not (Test-Path -LiteralPath $checkCanonicalIndependenceScriptPath)) {
  throw "Canonical independence script not found at $checkCanonicalIndependenceScriptPath"
}

Invoke-Step -Label 'Catalog validation' -Body {
  & $shellPath -NoProfile -ExecutionPolicy Bypass -File $validateCatalogScriptPath
}

Invoke-Step -Label 'Public scrub check' -Body {
$scrubArgs = @('-RepoRoot', $Root)
if ($Strict) {
  $scrubArgs += '-Strict'
}
if (-not [string]::IsNullOrWhiteSpace($SupplementalPolicyPath)) {
  $scrubArgs += @('-SupplementalPolicyPath', $SupplementalPolicyPath)
}
if ($RequireSupplementalPolicy) { $scrubArgs += '-RequireSupplementalPolicy' }
  & $shellPath -NoProfile -ExecutionPolicy Bypass -File $checkPublicScrubScriptPath @scrubArgs
}

Invoke-Step -Label 'Public content policy' -Body {
  & $shellPath -NoProfile -ExecutionPolicy Bypass -File $checkPublicContentPolicyScriptPath -RepoRoot $Root
}

Invoke-Step -Label 'Canonical repository independence' -Body {
  & $shellPath -NoProfile -ExecutionPolicy Bypass -File $checkCanonicalIndependenceScriptPath -RepoRoot $Root
}

if (-not (Test-Path -LiteralPath (Join-Path $cliRoot 'node_modules'))) {
  Invoke-Step -Label 'Install babel-cli dependencies' -Body {
    Push-Location -LiteralPath $cliRoot
    try {
      npm ci
    } finally {
      Pop-Location
    }
  }
}

Invoke-Step -Label 'TypeScript typecheck' -Body {
  Push-Location -LiteralPath $cliRoot
  try {
    npm run typecheck
  } finally {
    Pop-Location
  }
}

Invoke-Step -Label 'Resolver smoke test' -Body {
  & $shellPath -NoProfile -ExecutionPolicy Bypass -File $resolveLocalStackScriptPath -TaskCategory backend -Project example_saas_backend -Model codex -PipelineMode verified -Format json | Out-Null
}

Invoke-Step -Label 'Mobile resolver smoke test' -Body {
  & $shellPath -NoProfile -ExecutionPolicy Bypass -File $resolveLocalStackScriptPath -TaskCategory mobile -Project example_mobile_suite -Model codex -Format json | Out-Null
}

Write-Host ''
Write-Host 'Public release validation passed.' -ForegroundColor Green
