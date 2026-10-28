[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-Forwarding {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { throw "ASSERTION FAILED: $Message" }
}

$launcher = Join-Path $PSScriptRoot '../../scripts/trusted-merge-gate.ps1'
$pwsh = (Get-Command pwsh -ErrorAction Stop).Source
$git = (Get-Command git -ErrorAction Stop).Source
$root = Join-Path ([IO.Path]::GetTempPath()) ('babel-trusted-forwarding-' + [guid]::NewGuid().ToString('N'))
$repo = Join-Path $root 'repo'
$log = Join-Path $root 'inner.log'
$priorLog = [Environment]::GetEnvironmentVariable('BABEL_GATE_FORWARDING_TEST_LOG', 'Process')
$head = 'a' * 40
$stub = @'
[CmdletBinding()]
param(
  [string]$ExpectedExecutionBaseSha, [int]$PR, [string]$RepoRoot,
  [string]$ReviewedHeadSha, [string]$RiskTier, [string]$AutonomousReviewEvidencePath,
  [string]$BuilderIdentity, [string]$OutputFormat,
  [ValidateRange(0, 1800)][int]$CheckWaitSeconds = 0,
  [switch]$AuditOnly, [switch]$RequireIsolatedWorktree
)
$ErrorActionPreference = 'Stop'
# This stub proves transport and trusted-source selection, not merge readiness.
$base = (& git -C $RepoRoot rev-list --max-parents=0 HEAD).Trim()
if ($ExpectedExecutionBaseSha -ne $base) { throw 'wrong immutable execution base' }
@{ wait = $CheckWaitSeconds; head = $ReviewedHeadSha; base = $ExpectedExecutionBaseSha;
  audit = [bool]$AuditOnly; isolated = [bool]$RequireIsolatedWorktree } |
  ConvertTo-Json -Compress | Set-Content -LiteralPath $env:BABEL_GATE_FORWARDING_TEST_LOG
Write-Output 'BASE_GATE_EXECUTED'
'@

function Invoke-Forwarding {
  param([int]$Wait = 0, [switch]$ExplicitWait)
  Remove-Item -LiteralPath $log -Force -ErrorAction SilentlyContinue
  $arguments = @('-NoProfile', '-NonInteractive', '-File', $launcher, '-PR', '42', '-BaseSha', $script:base,
    '-RepoRoot', $repo, '-ReviewedHeadSha', $head, '-AuditOnly', '-RequireIsolatedWorktree')
  if ($ExplicitWait) { $arguments += @('-CheckWaitSeconds', [string]$Wait) }
  $output = & $pwsh @arguments 2>&1
  $exitCode = $LASTEXITCODE
  $inner = if (Test-Path -LiteralPath $log) { Get-Content -Raw -LiteralPath $log | ConvertFrom-Json } else { $null }
  [pscustomobject]@{ exitCode = $exitCode; inner = $inner; text = (@($output) -join "`n") }
}

try {
  New-Item -ItemType Directory -Path (Join-Path $repo 'scripts') -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $repo 'config') -Force | Out-Null
  & $git -C $repo init --quiet
  & $git -C $repo config user.name 'Babel test'
  & $git -C $repo config user.email 'babel-test@example.invalid'
  Set-Content -LiteralPath (Join-Path $repo 'scripts/agent-pr-gate.ps1') -Value $stub -Encoding utf8NoBOM
  foreach ($path in @('scripts/agent-pr-gate-common.psm1', 'scripts/agent-pr-gate-evidence.psm1', 'scripts/agent-git-common.psm1', 'scripts/agent-review-evidence.ps1', 'config/review-risk-policy.json')) {
    Set-Content -LiteralPath (Join-Path $repo $path) -Value '# owned fixture dependency' -Encoding utf8NoBOM
  }
  & $git -C $repo add scripts config
  & $git -C $repo commit --quiet -m 'trusted forwarding fixture'
  $script:base = (& $git -C $repo rev-parse HEAD).Trim()
  Set-Content -LiteralPath (Join-Path $repo 'scripts/agent-pr-gate.ps1') -Value "throw 'CANDIDATE_GATE_MUST_NOT_EXECUTE'" -Encoding utf8NoBOM
  $env:BABEL_GATE_FORWARDING_TEST_LOG = $log

  $default = Invoke-Forwarding
  Assert-Forwarding ($default.exitCode -eq 0 -and $default.inner.wait -eq 0) "default zero must reach immutable base gate: $($default.text)"
  foreach ($wait in @(180, 1800)) {
    $run = Invoke-Forwarding -ExplicitWait -Wait $wait
    Assert-Forwarding ($run.exitCode -eq 0 -and $run.inner.wait -eq $wait) "explicit $wait must reach immutable base gate: $($run.text)"
    Assert-Forwarding ($run.inner.head -eq $head -and $run.inner.base -eq $script:base -and $run.inner.audit -and $run.inner.isolated) 'forwarding must preserve head/base and narrowing switches'
  }
  foreach ($wait in @(-1, 1801)) {
    $run = Invoke-Forwarding -ExplicitWait -Wait $wait
    Assert-Forwarding ($run.exitCode -ne 0 -and $null -eq $run.inner) 'invalid wait must reject before the inner gate runs'
  }
  Write-Output 'PASS: trusted merge launcher forwards bounded wait and retains immutable gate bindings'
} finally {
  if ($null -eq $priorLog) { Remove-Item Env:BABEL_GATE_FORWARDING_TEST_LOG -ErrorAction SilentlyContinue }
  else { $env:BABEL_GATE_FORWARDING_TEST_LOG = $priorLog }
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
