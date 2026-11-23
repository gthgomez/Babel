[CmdletBinding()]
param(
  [string]$RepoRoot = (Join-Path $PSScriptRoot '..'),
  [string]$GitPath = '',
  [string]$GhPath = '',
  [string]$ExpectedRemote = 'origin',
  [string]$ExpectedRepository = 'gthgomez/Babel',
  [string]$ExpectedBaseBranch = 'main',
  [string]$ExpectedBaseSha = '',
  [string]$ExpectedBranch = '',
  [string]$ExpectedHeadSha = '',
  [switch]$AllowDirtyWorktree,
  [switch]$RequireIsolatedWorktree,
  [switch]$CheckSupplementalScrubPolicyPath,
  [ValidateSet('json', 'text')][string]$OutputFormat = 'json'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path $PSScriptRoot 'agent-git-common.psm1') -Force

$resolvedRepoRoot = $null
$checks = [ordered]@{}
$blockers = @()
$warnings = @()
$statusSnapshot = $null
$topology = $null
$credential = $null
$repository = $ExpectedRepository
$branch = $null
$head = $null
$originMain = $null
$remoteHead = $null
$gitVersion = $null
$ghVersion = $null
$ghResolvedPath = $GhPath
$gitPathWasExplicit = $PSBoundParameters.ContainsKey('GitPath')
$gitResolvedPath = $GitPath

function Add-AgentCheck {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][bool]$Passed,
    [string]$Blocker = ''
  )
  $checks[$Name] = $Passed
  if (-not $Passed -and -not [string]::IsNullOrWhiteSpace($Blocker)) {
    $script:blockers += $Blocker
  }
}

function Add-AgentWarning {
  param([Parameter(Mandatory = $true)][string]$Message)
  if ($script:warnings -notcontains $Message) { $script:warnings += $Message }
}

function Get-PreflightGithubCapabilities {
  param(
    [string]$AuthCapability = 'unproven_preflight_incomplete',
    [string]$ReadCapability = 'unproven_preflight_incomplete'
  )
  return [ordered]@{
    nonInteractiveAuthentication = $AuthCapability
    repositoryRead = $ReadCapability
    branchWrite = 'unproven_not_probed'
    pullRequestCreation = 'unproven_not_probed'
    note = 'Read-only preflight does not attempt a branch write or create a pull request; never treat auth or repository-read success as write authority.'
  }
}

try {
  $resolvedRepoRoot = (Resolve-Path -LiteralPath $RepoRoot -ErrorAction Stop).Path
  $envState = Set-AgentNonInteractiveEnvironment

  # Prefer Windows Git when available; otherwise resolve Git from PATH. An
  # explicit -GitPath remains authoritative and is never silently replaced.
  if (-not $gitPathWasExplicit -and -not [string]::IsNullOrWhiteSpace($env:ProgramFiles)) {
    $gitResolvedPath = Join-Path $env:ProgramFiles 'Git\cmd\git.exe'
  }
  if (-not $gitPathWasExplicit -and -not (Test-Path -LiteralPath $gitResolvedPath -PathType Leaf)) {
    try { $gitResolvedPath = Get-AgentCommandPath -Name 'git' } catch { $gitResolvedPath = '' }
  }
  $gitAvailable = -not [string]::IsNullOrWhiteSpace($gitResolvedPath) -and (Test-Path -LiteralPath $gitResolvedPath -PathType Leaf)
  Add-AgentCheck -Name 'GIT_EXECUTABLE' -Passed $gitAvailable -Blocker 'git_executable_unavailable'
  if (-not $gitAvailable) { throw "Git executable not found: $gitResolvedPath" }

  $gitVersionResult = Invoke-AgentGit -GitPath $gitResolvedPath -RepoRoot $resolvedRepoRoot -Arguments @('--version')
  if ($gitVersionResult.exitCode -eq 0) { $gitVersion = $gitVersionResult.text.Trim() }
  Add-AgentCheck -Name 'GIT_VERSION' -Passed ($gitVersionResult.exitCode -eq 0) -Blocker 'git_version_failed'

  $rootResult = Invoke-AgentGit -GitPath $gitResolvedPath -RepoRoot $resolvedRepoRoot -Arguments @('rev-parse', '--show-toplevel')
  $reportedRoot = if ($rootResult.exitCode -eq 0) { $rootResult.text.Trim() } else { $null }
  $rootMatches = $rootResult.exitCode -eq 0 -and [string]::Equals(
    (ConvertTo-AgentAbsolutePath -BasePath $resolvedRepoRoot -Path $reportedRoot),
    $resolvedRepoRoot,
    [StringComparison]::OrdinalIgnoreCase
  )
  Add-AgentCheck -Name 'EXPECTED_REPOSITORY_ROOT' -Passed $rootMatches -Blocker 'wrong_repository_root'

  $remoteUrl = Get-AgentRemoteUrl -GitPath $gitResolvedPath -RepoRoot $resolvedRepoRoot -Remote $ExpectedRemote
  $remoteSlug = Get-AgentRemoteSlug -RemoteUrl $remoteUrl
  $remoteMatches = [string]::Equals($remoteSlug, $ExpectedRepository, [StringComparison]::OrdinalIgnoreCase)
  Add-AgentCheck -Name 'REMOTE_OK' -Passed $remoteMatches -Blocker 'unexpected_origin_repository'
  Add-AgentCheck -Name 'REMOTE_CREDENTIAL_FREE' -Passed (Test-AgentRemoteCredentialFree -RemoteUrl $remoteUrl) -Blocker 'token_bearing_remote_url'

  $credential = Get-AgentCredentialIsolation -GitPath $gitResolvedPath -RepoRoot $resolvedRepoRoot
  $credentialOk = $credential.localGhHelper -and $credential.resetInheritedHelpers
  Add-AgentCheck -Name 'CREDENTIAL_PROVIDER_GH' -Passed $credentialOk -Blocker 'repo_local_gh_credential_helper_missing'

  if ([string]::IsNullOrWhiteSpace($ghResolvedPath)) {
    try { $ghResolvedPath = Get-AgentCommandPath -Name 'gh' } catch { $ghResolvedPath = '' }
  }
  $ghAvailable = -not [string]::IsNullOrWhiteSpace($ghResolvedPath) -and (Test-Path -LiteralPath $ghResolvedPath -PathType Leaf)
  Add-AgentCheck -Name 'GH_EXECUTABLE' -Passed $ghAvailable -Blocker 'gh_executable_unavailable'

  $ghAuthOk = $false
  $ghRepoOk = $false
  $repoView = $null
  if ($ghAvailable) {
    $ghVersionResult = Invoke-AgentGh -GhPath $ghResolvedPath -RepoRoot $resolvedRepoRoot -Arguments @('--version')
    if ($ghVersionResult.exitCode -eq 0) { $ghVersion = $ghVersionResult.text.Trim() }
    Add-AgentCheck -Name 'GH_VERSION' -Passed ($ghVersionResult.exitCode -eq 0) -Blocker 'gh_version_failed'

    $authResult = Invoke-AgentGh -GhPath $ghResolvedPath -RepoRoot $resolvedRepoRoot -Arguments @('auth', 'status', '--hostname', 'github.com')
    $ghAuthOk = $authResult.exitCode -eq 0
    Add-AgentCheck -Name 'AUTH_OK' -Passed $ghAuthOk -Blocker 'github_auth_failed'

    $repoResult = Invoke-AgentGh -GhPath $ghResolvedPath -RepoRoot $resolvedRepoRoot -Arguments @('repo', 'view', $ExpectedRepository, '--json', 'nameWithOwner,defaultBranchRef')
    if ($repoResult.exitCode -eq 0) {
      try { $repoView = $repoResult.text | ConvertFrom-Json } catch { $repoView = $null }
    }
    $repoNameMatches = $null -ne $repoView -and [string]::Equals($repoView.nameWithOwner, $ExpectedRepository, [StringComparison]::OrdinalIgnoreCase)
    $defaultBranchMatches = $repoNameMatches -and [string]::Equals($repoView.defaultBranchRef.name, $ExpectedBaseBranch, [StringComparison]::OrdinalIgnoreCase)
    $ghRepoOk = $repoResult.exitCode -eq 0 -and $repoNameMatches
    Add-AgentCheck -Name 'EXPECTED_REPO' -Passed $ghRepoOk -Blocker 'github_repository_metadata_mismatch'
    Add-AgentCheck -Name 'EXPECTED_BASE_BRANCH' -Passed $defaultBranchMatches -Blocker 'unexpected_default_branch'
  } else {
    Add-AgentCheck -Name 'AUTH_OK' -Passed $false -Blocker 'github_auth_not_checked'
    Add-AgentCheck -Name 'EXPECTED_REPO' -Passed $false -Blocker 'github_repository_not_checked'
    Add-AgentCheck -Name 'EXPECTED_BASE_BRANCH' -Passed $false -Blocker 'default_branch_not_checked'
  }

  $head = Get-AgentGitText -GitPath $gitResolvedPath -RepoRoot $resolvedRepoRoot -Arguments @('rev-parse', 'HEAD')
  $headKnown = Test-AgentSha -Value $head
  Add-AgentCheck -Name 'LOCAL_HEAD_KNOWN' -Passed $headKnown -Blocker 'local_head_unknown'

  $branchResult = Invoke-AgentGit -GitPath $gitResolvedPath -RepoRoot $resolvedRepoRoot -Arguments @('symbolic-ref', '--quiet', '--short', 'HEAD')
  if ($branchResult.exitCode -eq 0) { $branch = $branchResult.text.Trim() }
  $branchKnown = -not [string]::IsNullOrWhiteSpace($branch)
  Add-AgentCheck -Name 'ON_BRANCH' -Passed $branchKnown -Blocker 'detached_head'

  $originMain = Get-AgentGitText -GitPath $gitResolvedPath -RepoRoot $resolvedRepoRoot -Arguments @('rev-parse', "$ExpectedRemote/$ExpectedBaseBranch")
  $baseKnown = Test-AgentSha -Value $originMain
  Add-AgentCheck -Name 'EXPECTED_BASE_SHA_AVAILABLE' -Passed $baseKnown -Blocker 'expected_base_sha_unavailable'

  $lsRemoteResult = Invoke-AgentGit -GitPath $gitResolvedPath -RepoRoot $resolvedRepoRoot -Arguments @('ls-remote', $ExpectedRemote, 'HEAD', "refs/heads/$ExpectedBaseBranch")
  $remoteBase = ''
  if ($lsRemoteResult.exitCode -eq 0) {
    foreach ($row in ($lsRemoteResult.text -split '\r?\n')) {
      if ($row -match '^([a-f0-9]{40})\s+(.+)$') {
        if ($Matches[2] -eq 'HEAD') { $remoteHead = $Matches[1] }
        if ($Matches[2] -eq "refs/heads/$ExpectedBaseBranch") { $remoteBase = $Matches[1] }
      }
    }
  }
  $remoteReachable = $lsRemoteResult.exitCode -eq 0 -and (Test-AgentSha -Value $remoteHead)
  Add-AgentCheck -Name 'REMOTE_REACHABLE' -Passed $remoteReachable -Blocker 'remote_unreachable'
  Add-AgentCheck -Name 'REMOTE_BASE_CURRENT' -Passed ($baseKnown -and $remoteBase -eq $originMain) -Blocker 'remote_base_stale_fetch_required'

  $statusSnapshot = Get-AgentStatusSnapshot -GitPath $gitResolvedPath -RepoRoot $resolvedRepoRoot
  Add-AgentCheck -Name 'STATUS_READABLE' -Passed $statusSnapshot.commandOk -Blocker 'git_status_failed'
  $worktreeClean = $statusSnapshot.commandOk -and $statusSnapshot.clean
  if (-not $worktreeClean -and $AllowDirtyWorktree) {
    Add-AgentCheck -Name 'WORKTREE_CLEAN' -Passed $false
    Add-AgentWarning -Message 'worktree_dirty_allowed_for_inspection_only'
  } else {
    Add-AgentCheck -Name 'WORKTREE_CLEAN' -Passed $worktreeClean -Blocker 'unexpected_dirty_worktree'
  }

  $topology = Get-AgentWorktreeTopology -GitPath $gitResolvedPath -RepoRoot $resolvedRepoRoot
  if ($RequireIsolatedWorktree) {
    Add-AgentCheck -Name 'WORKTREE_ISOLATED' -Passed ($topology.available -and $topology.isolated) -Blocker 'isolated_worktree_required'
  } else {
    Add-AgentCheck -Name 'WORKTREE_ISOLATED' -Passed ($topology.available -and $topology.isolated)
    Add-AgentWarning -Message 'canonical_checkout_allowed_unless_require_isolated_worktree_is_set'
  }

  if (-not [string]::IsNullOrWhiteSpace($ExpectedBaseSha)) {
    Add-AgentCheck -Name 'EXPECTED_BASE_SHA' -Passed ([string]::Equals($originMain, $ExpectedBaseSha, [StringComparison]::OrdinalIgnoreCase)) -Blocker 'base_sha_mismatch'
  } else {
    $checks['EXPECTED_BASE_SHA'] = $true
  }
  if (-not [string]::IsNullOrWhiteSpace($ExpectedBranch)) {
    Add-AgentCheck -Name 'EXPECTED_BRANCH' -Passed ([string]::Equals($branch, $ExpectedBranch, [StringComparison]::Ordinal)) -Blocker 'branch_mismatch'
  }
  if (-not [string]::IsNullOrWhiteSpace($ExpectedHeadSha)) {
    Add-AgentCheck -Name 'EXPECTED_HEAD_SHA' -Passed ([string]::Equals($head, $ExpectedHeadSha, [StringComparison]::OrdinalIgnoreCase)) -Blocker 'head_sha_mismatch'
  }

  $supplementalScrubDiagnostic = $null
  if ($CheckSupplementalScrubPolicyPath) {
    $policyPath = [string]$env:BABEL_PRIVATE_SCRUB_POLICY_PATH
    $policyConfigured = -not [string]::IsNullOrWhiteSpace($policyPath)
    Add-AgentCheck -Name 'SUPPLEMENTAL_SCRUB_POLICY_CONFIGURED' -Passed $policyConfigured -Blocker 'supplemental_scrub_policy_not_configured'

    $policyPresent = $false
    $policyReadable = $false
    if ($policyConfigured) {
      if (-not (Test-Path -LiteralPath $policyPath)) {
        Add-AgentCheck -Name 'SUPPLEMENTAL_SCRUB_POLICY_PRESENT' -Passed $false -Blocker 'supplemental_scrub_policy_missing'
      } elseif (-not (Test-Path -LiteralPath $policyPath -PathType Leaf)) {
        Add-AgentCheck -Name 'SUPPLEMENTAL_SCRUB_POLICY_PRESENT' -Passed $false -Blocker 'supplemental_scrub_policy_not_a_file'
      } else {
        $policyPresent = $true
        Add-AgentCheck -Name 'SUPPLEMENTAL_SCRUB_POLICY_PRESENT' -Passed $true
        try {
          $stream = [IO.File]::Open($policyPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
          $stream.Dispose()
          $policyReadable = $true
        } catch {
          $policyReadable = $false
        }
        Add-AgentCheck -Name 'SUPPLEMENTAL_SCRUB_POLICY_READABLE' -Passed $policyReadable -Blocker 'supplemental_scrub_policy_unreadable'
      }
    } else {
      $checks['SUPPLEMENTAL_SCRUB_POLICY_PRESENT'] = $false
      $checks['SUPPLEMENTAL_SCRUB_POLICY_READABLE'] = $false
    }

    $supplementalScrubDiagnostic = [ordered]@{
      requested = $true
      contentValidated = $false
      schemaValidated = $false
      validator = 'tools/check-public-scrub.ps1 -RequireSupplementalPolicy'
      note = 'Path presence/readability only; use check-public-scrub for policy content and schema.'
    }
  }

  $ok = $blockers.Count -eq 0
  $pushReady = $ok -and $worktreeClean -and $branchKnown -and $headKnown -and $baseKnown -and $remoteReachable
  $authCapability = if ($ghAuthOk) { 'verified' } else { 'failed_or_unavailable' }
  $readCapability = if ($ghRepoOk) { 'verified' } else { 'failed_or_unavailable' }
  $result = [ordered]@{
    schemaVersion = 1
    kind = 'babel_agent_preflight'
    ok = $ok
    mutationReady = $ok -and $worktreeClean
    pushReady = $pushReady
    repoRole = 'public_canonical'
    repoRoot = $resolvedRepoRoot
    repository = $repository
    remote = $ExpectedRemote
    branch = $branch
    head = $head
    originMain = $originMain
    remoteHead = $remoteHead
    git = [ordered]@{ path = $gitResolvedPath; version = $gitVersion }
    gh = [ordered]@{ path = $ghResolvedPath; version = $ghVersion }
    githubCapabilities = Get-PreflightGithubCapabilities -AuthCapability $authCapability -ReadCapability $readCapability
    nextSteps = @(
      'Resolve GitHub authentication or repository-read blockers before dependent remote work; do not change credentials or global Git configuration automatically.',
      'Branch-write and pull-request-creation capability are not tested by this read-only preflight. Establish them only through an authorized normal push or PR-creation operation, then record the observed result.',
      'If a push is rejected, fetch and freeze the remote branch tip, identify ownership and divergence, then reconcile safely; do not automatically rebase or force-push.'
    )
    environment = $envState
    credential = $credential
    worktree = [ordered]@{
      clean = $worktreeClean
      dirtyPaths = @($statusSnapshot.dirtyPaths)
      stagedCount = $statusSnapshot.stagedCount
      unstagedCount = $statusSnapshot.unstagedCount
      isolated = $topology.isolated
    }
    checks = $checks
    blockers = @($blockers | Select-Object -Unique)
    warnings = @($warnings | Select-Object -Unique)
  }
  if ($null -ne $supplementalScrubDiagnostic) {
    $result['supplementalScrubDiagnostic'] = $supplementalScrubDiagnostic
  }
  Write-AgentResult -Result $result -OutputFormat $OutputFormat
  if (-not $ok) { exit 1 }
  exit 0
} catch {
  $fallback = [ordered]@{
    schemaVersion = 1
    kind = 'babel_agent_preflight'
    ok = $false
    mutationReady = $false
    pushReady = $false
    repoRole = 'public_canonical'
    repoRoot = $resolvedRepoRoot
    repository = $repository
    remote = $ExpectedRemote
    githubCapabilities = Get-PreflightGithubCapabilities
    checks = $checks
    blockers = @($blockers + 'preflight_exception' | Select-Object -Unique)
    warnings = @($warnings | Select-Object -Unique)
    errorType = $_.Exception.GetType().FullName
  }
  Write-AgentResult -Result $fallback -OutputFormat $OutputFormat
  exit 1
}
