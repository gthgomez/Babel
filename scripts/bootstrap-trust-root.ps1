[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][int]$PR,
  [Parameter(Mandatory = $true)][string]$BaseSha,
  [Parameter(Mandatory = $true)][string]$ApprovedHeadSha,
  [Parameter(Mandatory = $true)][string]$RepoRoot,
  [Parameter(Mandatory = $true)][switch]$BootstrapAuthorization
)

# This is an operator-controlled, one-time transition. The approved head is
# supplied out of band and must be the exact head being merged. It is not a
# general-purpose bypass and it cannot be used for ordinary pull requests.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (-not $BootstrapAuthorization) { throw 'Explicit bootstrap authorization is required.' }
if ($PR -ne 121) { throw 'Bootstrap authorization is restricted to PR #121.' }
if ($BaseSha -notmatch '^[0-9a-fA-F]{40}$' -or $ApprovedHeadSha -notmatch '^[0-9a-fA-F]{40}$') { throw 'Bootstrap requires exact commit SHAs.' }
$root = (Resolve-Path -LiteralPath $RepoRoot -ErrorAction Stop).Path
$git = (Get-Command git -ErrorAction Stop).Source
$current = (& $git -C $root rev-parse HEAD).Trim()
if (-not [string]::Equals($current, $ApprovedHeadSha, [StringComparison]::OrdinalIgnoreCase)) { throw 'Bootstrap head is not the approved exact head.' }
$existing = @('config/independent-review-keys.json', 'config/trusted-supervisor-keys.json', 'scripts/verify-independent-review.mjs', 'scripts/trusted-merge-gate.ps1', 'scripts/bootstrap-trust-root.ps1')
foreach ($path in $existing) {
  & $git -C $root cat-file -e (('{0}:{1}' -f $BaseSha, $path)) 2>$null
  if ($LASTEXITCODE -eq 0) { throw "Bootstrap is only valid before trust root exists: $path" }
}
$allowed = @(
  '.github/workflows/trusted-control-plane.yml',
  'config/independent-review-keys.json',
  'config/trusted-supervisor-keys.json',
  'docs/architecture/TRUST_ROOT_BOOTSTRAP.md',
  'scripts/agent-git-common.psm1',
  'scripts/agent-pr-gate-common.psm1',
  'scripts/agent-pr-gate.ps1',
  'scripts/bootstrap-trust-root.ps1',
  'scripts/trusted-merge-gate.ps1',
  'scripts/verify-independent-review.mjs',
  'tools/tests/test-trust-root-boundaries.ps1'
)
$paths = @(& $git -C $root diff --name-only ("{0}...{1}" -f $BaseSha, $ApprovedHeadSha))
if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect bootstrap diff.' }
$unexpected = @($paths | Where-Object { $_ -and ($allowed -notcontains $_) })
if ($unexpected.Count -gt 0) { throw "Bootstrap changed an unauthorized path: $($unexpected -join ', ')" }
if ($paths.Count -eq 0) { throw 'Bootstrap diff is empty.' }
Write-Output 'TRUST_ROOT_BOOTSTRAP_AUTHORIZED'
