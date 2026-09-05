[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][int]$PR,
  [Parameter(Mandatory = $true)][string]$BaseSha,
  [Parameter(Mandatory = $true)][string]$RepoRoot,
  [Parameter(Mandatory = $true)][string]$ReviewedHeadSha,
  [string]$IndependentReviewReceiptPath = '',
  [string]$ReviewChallengeLedgerPath = '',
  [string]$AutonomousReviewEvidencePath = '',
  [string]$TrustRootUpgradeAuthorizationPath = '',
  [string]$BuilderIdentity = 'codex-implementation',
  [switch]$MergeAuthorized,
  [switch]$AuditOnly,
  [switch]$RequireIsolatedWorktree,
  [ValidateSet('json', 'text')][string]$OutputFormat = 'json'
)

# This launcher is the trusted entry point. It must be invoked from the
# immutable base commit (for example, by a pull_request_target workflow or an
# operator checkout), never from the candidate checkout. The candidate is
# treated only as data passed to the materialized gate.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$git = (Get-Command git -ErrorAction Stop).Source
$pwshCommand = Get-Command pwsh -ErrorAction Stop
$pwsh = $pwshCommand.Path
if ([string]::IsNullOrWhiteSpace($pwsh) -or -not (Test-Path -LiteralPath $pwsh -PathType Leaf)) { throw 'Trusted PowerShell runtime unavailable.' }
if ($BaseSha -notmatch '^[0-9a-fA-F]{40}$') { throw 'BaseSha must be an exact commit SHA.' }
$resolvedRepo = (Resolve-Path -LiteralPath $RepoRoot -ErrorAction Stop).Path
$materialized = Join-Path ([IO.Path]::GetTempPath()) ('babel-trusted-gate-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $materialized -Force | Out-Null
try {
  foreach ($relative in @('scripts/agent-pr-gate.ps1', 'scripts/agent-pr-gate-common.psm1', 'scripts/agent-git-common.psm1')) {
    $target = Join-Path $materialized ([IO.Path]::GetFileName($relative))
    $spec = '{0}:{1}' -f $BaseSha, $relative
    $content = & $git -C $resolvedRepo show $spec 2>$null
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace(($content -join "`n"))) {
      throw "Trusted gate component unavailable from base: $relative"
    }
    Set-Content -LiteralPath $target -Value ($content -join "`n") -Encoding utf8NoBOM
  }
  $args = @(
    '-NoProfile', '-NonInteractive', '-File', (Join-Path $materialized 'agent-pr-gate.ps1'),
    '-PR', $PR, '-RepoRoot', $resolvedRepo, '-ReviewedHeadSha', $ReviewedHeadSha,
    # The gate reads the protected trust-root inventory from this exact commit,
    # keeping the protection rules and the gate logic on one immutable base.
    '-BaseSha', $BaseSha,
    '-IndependentReviewReceiptPath', $IndependentReviewReceiptPath,
    '-ReviewChallengeLedgerPath', $ReviewChallengeLedgerPath,
    '-AutonomousReviewEvidencePath', $AutonomousReviewEvidencePath,
    '-TrustRootUpgradeAuthorizationPath', $TrustRootUpgradeAuthorizationPath,
    '-BuilderIdentity', $BuilderIdentity, '-OutputFormat', $OutputFormat
  )
  if ($MergeAuthorized) { $args += '-MergeAuthorized' }
  if ($AuditOnly) { $args += '-AuditOnly' }
  if ($RequireIsolatedWorktree) { $args += '-RequireIsolatedWorktree' }
  & $pwsh @args
  exit $LASTEXITCODE
} finally {
  try { Remove-Item -LiteralPath $materialized -Recurse -Force -ErrorAction Stop } catch { # best-effort cleanup; never mask the audit result
  }
}
