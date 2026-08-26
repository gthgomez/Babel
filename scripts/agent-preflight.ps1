[CmdletBinding()]
param(
  [string]$RepoRoot = (Join-Path $PSScriptRoot '..'),
  [string]$GitPath = (Join-Path $env:ProgramFiles 'Git\cmd\git.exe'),
  [string]$GhPath = '',
  [string]$ExpectedRemote = 'origin',
  [string]$ExpectedRepository = 'gthgomez/Babel',
  [string]$ExpectedBaseBranch = 'main',
  [string]$ExpectedBaseSha = '',
  [string]$ExpectedBranch = '',
  [string]$ExpectedHeadSha = '',
  [switch]$AllowDirtyWorktree,
  [switch]$RequireIsolatedWorktree,
  [ValidateSet('json', 'text')][string]$OutputFormat = 'json'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'agent-git-common.ps1')

$resolvedRepoRoot = $null
$checks = [ordered]@{}
$blockers = [System.Collections.Generic.List[string]]::new()
$warnings = [System.Collections.Generic.List[string]]::new()
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

function Add-AgentCheck {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][bool]$Passed,
    [string]$Blocker = ''
  )
  $checks[$Name] = $Passed
  if (-not $Passed -and -not [string]::IsNullOrWhiteSpace($Blocker)) {
    $blockers.Add($Blocker)
  }
}

function Add-AgentWarning {
  param([Parameter(Mandatory = $true)][string]$Message)
  if (-not $warnings.Contains($Message)) { $warnings.Add($Message) }
}

try {
  $resolvedRepoRoot = (Resolve-Path -LiteralPath $RepoRoot -ErrorAction Stop).Path
  $envState = Set-AgentNonInteractiveEnvironment

  $gitAvailable = Test-Path -LiteralPath $GitPath -PathType Leaf
  Add-AgentCheck -Name 'GIT_EXECUTABLE' -Passed $gitAvailable -Blocker 'git_executable_unavailable'
  if (-not $gitAvailable) { throw "Git executable not found: $GitPath" }

  $gitVersionResult = Invoke-AgentGit -GitPath $GitPath -RepoRoot $resolvedRepoRoot -Arguments @('--version')
  if ($gitVersionResult.exitCode -eq 0) { $gitVersion = $gitVersionResult.text.Trim() }
  Add-AgentCheck -Name 'GIT_VERSION' -Passed ($gitVersionResult.exitCode -eq 0) -Blocker 'git_version_failed'

  $rootResult = Invoke-AgentGit -GitPath $GitPath -RepoRoot $resolvedRepoRoot -Arguments @('rev-parse', '--show-toplevel')
  $reportedRoot = if ($rootResult.exitCode -eq 0) { $rootResult.text.Trim() } else { $null }
  $rootMatches = $rootResult.exitCode -eq 0 -and [string]::Equals(
    (ConvertTo-AgentAbsolutePath -BasePath $resolvedRepoRoot -Path $reportedRoot),
    $resolvedRepoRoot,
    [StringComparison]::OrdinalIgnoreCase
  )
  Add-AgentCheck -Name 'EXPECTED_REPOSITORY_ROOT' -Passed $rootMatches -Blocker 'wrong_repository_root'

  $remoteUrl = Get-AgentRemoteUrl -GitPath $GitPath -RepoRoot $resolvedRepoRoot -Remote $ExpectedRemote
  $remoteSlug = Get-AgentRemoteSlug -RemoteUrl $remoteUrl
  $remoteMatches = [string]::Equals($remoteSlug, $ExpectedRepository, [StringComparison]::OrdinalIgnoreCase)
  Add-AgentCheck -Name 'REMOTE_OK' -Passed $remoteMatches -Blocker 'unexpected_origin_repository'
  Add-AgentCheck -Name 'REMOTE_CREDENTIAL_FREE' -Passed (Test-AgentRemoteCredentialFree -RemoteUrl $remoteUrl) -Blocker 'token_bearing_remote_url'

  $credential = Get-AgentCredentialIsolation -GitPath $GitPath -RepoRoot $resolvedRepoRoot
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

  $fetchResult = Invoke-AgentGit -GitPath $GitPath -RepoRoot $resolvedRepoRoot -Arguments @('fetch', $ExpectedRemote, '--prune')
  $fetchOk = $fetchResult.exitCode -eq 0
  Add-AgentCheck -Name 'FETCH_OK' -Passed $fetchOk -Blocker 'fetch_failed'

  $head = Get-AgentGitText -GitPath $GitPath -RepoRoot $resolvedRepoRoot -Arguments @('rev-parse', 'HEAD')
  $headKnown = Test-AgentSha -Value $head
  Add-AgentCheck -Name 'LOCAL_HEAD_KNOWN' -Passed $headKnown -Blocker 'local_head_unknown'

  $branchResult = Invoke-AgentGit -GitPath $GitPath -RepoRoot $resolvedRepoRoot -Arguments @('symbolic-ref', '--quiet', '--short', 'HEAD')
  if ($branchResult.exitCode -eq 0) { $branch = $branchResult.text.Trim() }
  $branchKnown = -not [string]::IsNullOrWhiteSpace($branch)
  Add-AgentCheck -Name 'ON_BRANCH' -Passed $branchKnown -Blocker 'detached_head'

  $originMain = Get-AgentGitText -GitPath $GitPath -RepoRoot $resolvedRepoRoot -Arguments @('rev-parse', "$ExpectedRemote/$ExpectedBaseBranch")
  $baseKnown = Test-AgentSha -Value $originMain
  Add-AgentCheck -Name 'EXPECTED_BASE_SHA_AVAILABLE' -Passed $baseKnown -Blocker 'expected_base_sha_unavailable'

  $lsRemoteResult = Invoke-AgentGit -GitPath $GitPath -RepoRoot $resolvedRepoRoot -Arguments @('ls-remote', $ExpectedRemote, 'HEAD')
  if ($lsRemoteResult.exitCode -eq 0) {
    $remoteHead = (($lsRemoteResult.text -split '\s+')[0]).Trim()
  }
  $remoteReachable = $lsRemoteResult.exitCode -eq 0 -and (Test-AgentSha -Value $remoteHead)
  Add-AgentCheck -Name 'REMOTE_REACHABLE' -Passed $remoteReachable -Blocker 'remote_unreachable'

  $statusSnapshot = Get-AgentStatusSnapshot -GitPath $GitPath -RepoRoot $resolvedRepoRoot
  Add-AgentCheck -Name 'STATUS_READABLE' -Passed $statusSnapshot.commandOk -Blocker 'git_status_failed'
  $worktreeClean = $statusSnapshot.commandOk -and $statusSnapshot.clean
  if (-not $worktreeClean -and $AllowDirtyWorktree) {
    Add-AgentCheck -Name 'WORKTREE_CLEAN' -Passed $false
    Add-AgentWarning -Message 'worktree_dirty_allowed_for_inspection_only'
  } else {
    Add-AgentCheck -Name 'WORKTREE_CLEAN' -Passed $worktreeClean -Blocker 'unexpected_dirty_worktree'
  }

  $topology = Get-AgentWorktreeTopology -GitPath $GitPath -RepoRoot $resolvedRepoRoot
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

  $ok = $blockers.Count -eq 0
  $pushReady = $ok -and $worktreeClean -and $branchKnown -and $headKnown -and $baseKnown -and $remoteReachable
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
    git = [ordered]@{ path = $GitPath; version = $gitVersion }
    gh = [ordered]@{ path = $ghResolvedPath; version = $ghVersion }
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
    checks = $checks
    blockers = @($blockers + 'preflight_exception' | Select-Object -Unique)
    warnings = @($warnings | Select-Object -Unique)
    errorType = $_.Exception.GetType().FullName
  }
  Write-AgentResult -Result $fallback -OutputFormat $OutputFormat
  exit 1
}
