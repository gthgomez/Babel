[CmdletBinding()]
param([string]$RepoRoot = (Join-Path $PSScriptRoot '..\..'))
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$launcher = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot 'scripts/trusted-merge-gate.ps1')
$bootstrap = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot 'scripts/bootstrap-trust-root.ps1')
if ($launcher -notmatch '-C \$resolvedRepo show') { throw 'Trusted launcher does not materialize from git objects.' }
foreach ($component in @('scripts/agent-pr-gate.ps1', 'scripts/agent-pr-gate-common.psm1', 'scripts/agent-git-common.psm1')) {
  if ($launcher -notmatch [regex]::Escape($component)) { throw "Trusted launcher omits $component" }
}
if ($launcher -notmatch 'agent-pr-gate\.ps1') { throw 'Trusted launcher does not invoke the base-rooted gate.' }
foreach ($unsupported in @('-TaskId', '-RunId', '-ContractHash')) {
  if ($launcher -match [regex]::Escape($unsupported)) { throw "Trusted launcher forwards unsupported gate parameter: $unsupported" }
}
$gate = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot 'scripts/agent-pr-gate.ps1')
if (-not $gate.Contains("[string]`$GitPath = ''")) { throw 'Base-rooted gate uses a platform-specific Git default.' }
foreach ($required in @('reviewThreads\(first:100,after:\$after\)', 'pageInfo\{hasNextPage endCursor\}', 'review_threads_pagination_incomplete')) {
  if ($gate -notmatch $required) { throw "Base-rooted gate is missing full review-thread pagination: $required" }
}
if ($launcher -match 'BootstrapRepairAuthorized') { throw 'Generic trusted gate exposes bootstrap bypass.' }
foreach ($required in @('PR -ne 121', 'ApprovedHeadSha', 'BaseSha', 'unauthorized path', 'trust root exists')) {
  if ($bootstrap -notmatch [regex]::Escape($required)) { throw "Bootstrap boundary check missing: $required" }
}
Write-Output 'TRUST_ROOT_BOUNDARY_TEST_PASS'
