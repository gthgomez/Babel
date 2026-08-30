[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][int]$PR,
  [string]$RepoRoot = (Join-Path $PSScriptRoot '..'),
  [string]$GitPath = '',
  [string]$GhPath = '',
  [string]$ExpectedRemote = 'origin',
  [string]$ExpectedRepository = 'gthgomez/Babel',
  [string]$ExpectedBaseBranch = 'main',
  [string]$ReviewedHeadSha = '',
  [string[]]$RequiredCheck = @('security', 'public-content-policy', 'linux-validation', 'public-pr-metadata', 'windows-portability'),
  [string[]]$AllowedPath = @(),
  [switch]$RequireIsolatedWorktree,
  [ValidateSet('json', 'text')][string]$OutputFormat = 'json'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path $PSScriptRoot 'agent-git-common.psm1') -Force

$resolvedRepoRoot = $null
$ghResolvedPath = $GhPath
$checks = [ordered]@{}
$blockers = @()
$warnings = @()
$localHead = $null
$originMain = $null
$prData = $null
$checkRuns = @()

function Add-AgentCheck {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][bool]$Passed,
    [string]$Blocker = ''
  )
  $checks[$Name] = $Passed
  if (-not $Passed -and -not [string]::IsNullOrWhiteSpace($Blocker)) { $script:blockers += $Blocker }
}

function Add-AgentWarning {
  param([Parameter(Mandatory = $true)][string]$Message)
  if ($script:warnings -notcontains $Message) { $script:warnings += $Message }
}

function Test-AgentCheckName {
  param([Parameter(Mandatory = $true)][string]$Actual, [Parameter(Mandatory = $true)][string]$Expected)
  return [string]::Equals($Actual, $Expected, [StringComparison]::OrdinalIgnoreCase) -or
    $Actual.StartsWith("$Expected /", [StringComparison]::OrdinalIgnoreCase) -or
    $Actual.StartsWith("${Expected}:", [StringComparison]::OrdinalIgnoreCase)
}

try {
  $resolvedRepoRoot = (Resolve-Path -LiteralPath $RepoRoot -ErrorAction Stop).Path
  $envState = Set-AgentNonInteractiveEnvironment
  if ([string]::IsNullOrWhiteSpace($GitPath)) {
    try { $GitPath = Get-AgentCommandPath -Name 'git' } catch { $GitPath = '' }
  }
  $gitAvailable = Test-Path -LiteralPath $GitPath -PathType Leaf
  Add-AgentCheck -Name 'GIT_EXECUTABLE' -Passed $gitAvailable -Blocker 'git_executable_unavailable'
  if (-not $gitAvailable) { throw "Git executable not found: $GitPath" }

  $root = Get-AgentGitText -GitPath $GitPath -RepoRoot $resolvedRepoRoot -Arguments @('rev-parse', '--show-toplevel')
  $rootMatches = $false
  if (-not [string]::IsNullOrWhiteSpace($root)) {
    $rootMatches = [string]::Equals(
      (ConvertTo-AgentAbsolutePath -BasePath $resolvedRepoRoot -Path $root),
      $resolvedRepoRoot,
      [StringComparison]::OrdinalIgnoreCase
    )
  }
  Add-AgentCheck -Name 'EXPECTED_REPOSITORY_ROOT' -Passed $rootMatches -Blocker 'wrong_repository_root'

  $remoteUrl = Get-AgentRemoteUrl -GitPath $GitPath -RepoRoot $resolvedRepoRoot -Remote $ExpectedRemote
  $remoteSlug = Get-AgentRemoteSlug -RemoteUrl $remoteUrl
  $remoteOk = [string]::Equals($remoteSlug, $ExpectedRepository, [StringComparison]::OrdinalIgnoreCase)
  Add-AgentCheck -Name 'REMOTE_OK' -Passed $remoteOk -Blocker 'unexpected_origin_repository'
  Add-AgentCheck -Name 'REMOTE_CREDENTIAL_FREE' -Passed (Test-AgentRemoteCredentialFree -RemoteUrl $remoteUrl) -Blocker 'token_bearing_remote_url'

  if ([string]::IsNullOrWhiteSpace($ghResolvedPath)) {
    try { $ghResolvedPath = Get-AgentCommandPath -Name 'gh' } catch { $ghResolvedPath = '' }
  }
  $ghAvailable = -not [string]::IsNullOrWhiteSpace($ghResolvedPath) -and (Test-Path -LiteralPath $ghResolvedPath -PathType Leaf)
  Add-AgentCheck -Name 'GH_EXECUTABLE' -Passed $ghAvailable -Blocker 'gh_executable_unavailable'

  $authOk = $false
  if ($ghAvailable) {
    $authResult = Invoke-AgentGh -GhPath $ghResolvedPath -RepoRoot $resolvedRepoRoot -Arguments @('auth', 'status', '--hostname', 'github.com')
    $authOk = (Get-AgentProperty -Object $authResult -Name 'exitCode' -Default 127) -eq 0
  }
  Add-AgentCheck -Name 'AUTH_OK' -Passed $authOk -Blocker 'github_auth_failed'

  $fetchResult = $null
  if ($remoteOk) {
    $fetchResult = Invoke-AgentGit -GitPath $GitPath -RepoRoot $resolvedRepoRoot -Arguments @('fetch', $ExpectedRemote, '--prune')
  }
  $fetchOk = $null -ne $fetchResult -and (Get-AgentProperty -Object $fetchResult -Name 'exitCode' -Default 127) -eq 0
  Add-AgentCheck -Name 'FETCH_OK' -Passed $fetchOk -Blocker 'fetch_failed'

  $localHead = Get-AgentGitText -GitPath $GitPath -RepoRoot $resolvedRepoRoot -Arguments @('rev-parse', 'HEAD')
  $localHeadKnown = Test-AgentSha -Value $localHead
  Add-AgentCheck -Name 'LOCAL_HEAD_KNOWN' -Passed $localHeadKnown -Blocker 'local_head_unknown'
  $branchResult = Invoke-AgentGit -GitPath $GitPath -RepoRoot $resolvedRepoRoot -Arguments @('symbolic-ref', '--quiet', '--short', 'HEAD')
  $localBranch = if ((Get-AgentProperty -Object $branchResult -Name 'exitCode' -Default 127) -eq 0) {
    ([string](Get-AgentProperty -Object $branchResult -Name 'text' -Default '')).Trim()
  } else { $null }
  Add-AgentCheck -Name 'ON_BRANCH' -Passed (-not [string]::IsNullOrWhiteSpace($localBranch)) -Blocker 'detached_head'

  $statusDirect = Invoke-AgentGit -GitPath $GitPath -RepoRoot $resolvedRepoRoot -Arguments @('status', '--porcelain=v2', '--branch', '--untracked-files=all')
  $statusLines = @((Get-AgentProperty -Object $statusDirect -Name 'output' -Default @()) | ForEach-Object { [string]$_ })
  $statusEntries = @($statusLines | Where-Object { -not $_.StartsWith('#') -and -not [string]::IsNullOrWhiteSpace($_) })
  $statusDirtyPaths = @()
  foreach ($statusLine in $statusEntries) {
    $statusPath = $null
    if ($statusLine.StartsWith('? ')) {
      $statusPath = $statusLine.Substring(2)
    } elseif ($statusLine.StartsWith('2 ') -and $statusLine.Contains("`t")) {
      $statusParts = $statusLine.Split("`t")[0] -split ' ', 10
      if ($statusParts.Count -ge 9) { $statusPath = $statusParts[8] }
    } else {
      $statusParts = $statusLine -split ' ', 10
      if ($statusParts.Count -ge 9 -and $statusParts[0] -in @('1', 'u')) { $statusPath = $statusParts[8] }
    }
    if (-not [string]::IsNullOrWhiteSpace($statusPath)) { $statusDirtyPaths += $statusPath }
  }
  $statusCommandOk = (Get-AgentProperty -Object $statusDirect -Name 'exitCode' -Default 127) -eq 0
  $statusClean = $statusCommandOk -and $statusEntries.Count -eq 0
  Add-AgentCheck -Name 'WORKTREE_CLEAN' -Passed ($statusCommandOk -and $statusClean) -Blocker 'dirty_worktree'
  $topology = Get-AgentWorktreeTopology -GitPath $GitPath -RepoRoot $resolvedRepoRoot
  $topologyAvailable = [bool](Get-AgentProperty -Object $topology -Name 'available' -Default $false)
  $topologyIsolated = [bool](Get-AgentProperty -Object $topology -Name 'isolated' -Default $false)
  if ($RequireIsolatedWorktree) {
    Add-AgentCheck -Name 'WORKTREE_ISOLATED' -Passed ($topologyAvailable -and $topologyIsolated) -Blocker 'isolated_worktree_required'
  } else {
    Add-AgentCheck -Name 'WORKTREE_ISOLATED' -Passed ($topologyAvailable -and $topologyIsolated)
    Add-AgentWarning -Message 'canonical_checkout_allowed_unless_require_isolated_worktree_is_set'
  }

  $originMain = Get-AgentGitText -GitPath $GitPath -RepoRoot $resolvedRepoRoot -Arguments @('rev-parse', "$ExpectedRemote/$ExpectedBaseBranch")
  Add-AgentCheck -Name 'BASE_SHA_AVAILABLE' -Passed (Test-AgentSha -Value $originMain) -Blocker 'base_sha_unavailable'

  $lsRemoteResult = $null
  if ($remoteOk) {
    $lsRemoteResult = Invoke-AgentGit -GitPath $GitPath -RepoRoot $resolvedRepoRoot -Arguments @('ls-remote', $ExpectedRemote, 'HEAD')
  }
  $remoteDefaultHead = $null
  if ($null -ne $lsRemoteResult -and (Get-AgentProperty -Object $lsRemoteResult -Name 'exitCode' -Default 127) -eq 0) {
    $remoteDefaultHead = (([string](Get-AgentProperty -Object $lsRemoteResult -Name 'text' -Default '') -split '\s+')[0]).Trim()
  }
  Add-AgentCheck -Name 'REMOTE_REACHABLE' -Passed ($null -ne $lsRemoteResult -and (Get-AgentProperty -Object $lsRemoteResult -Name 'exitCode' -Default 127) -eq 0 -and (Test-AgentSha -Value $remoteDefaultHead)) -Blocker 'remote_unreachable'

  $prView = $null
  $repoView = $null
  if ($ghAvailable -and $authOk) {
    $repoResult = Invoke-AgentGh -GhPath $ghResolvedPath -RepoRoot $resolvedRepoRoot -Arguments @('repo', 'view', $ExpectedRepository, '--json', 'nameWithOwner,defaultBranchRef')
    if ((Get-AgentProperty -Object $repoResult -Name 'exitCode' -Default 127) -eq 0) {
      try { $repoView = [string](Get-AgentProperty -Object $repoResult -Name 'text' -Default '') | ConvertFrom-Json } catch { $repoView = $null }
    }
    $repoNameOk = $null -ne $repoView -and [string]::Equals([string](Get-AgentProperty -Object $repoView -Name 'nameWithOwner' -Default ''), $ExpectedRepository, [StringComparison]::OrdinalIgnoreCase)
    Add-AgentCheck -Name 'EXPECTED_REPO' -Passed $repoNameOk -Blocker 'github_repository_metadata_mismatch'

    $prFields = 'number,url,state,isDraft,baseRefName,baseRefOid,headRefName,headRefOid,mergeable,mergeStateStatus,reviewDecision,isCrossRepository,headRepositoryOwner,headRepository'
    $prResult = Invoke-AgentGh -GhPath $ghResolvedPath -RepoRoot $resolvedRepoRoot -Arguments @('pr', 'view', [string]$PR, '--repo', $ExpectedRepository, '--json', $prFields)
    if ((Get-AgentProperty -Object $prResult -Name 'exitCode' -Default 127) -eq 0) {
      try { $prView = [string](Get-AgentProperty -Object $prResult -Name 'text' -Default '') | ConvertFrom-Json } catch { $prView = $null }
    }
  } else {
    Add-AgentCheck -Name 'EXPECTED_REPO' -Passed $false -Blocker 'github_repository_not_checked'
  }
  $prAvailable = $null -ne $prView
  Add-AgentCheck -Name 'PR_READABLE' -Passed $prAvailable -Blocker 'pull_request_not_readable'

  $prHead = if ($prAvailable) { [string](Get-AgentProperty -Object $prView -Name 'headRefOid' -Default '') } else { $null }
  $prBase = if ($prAvailable) { [string](Get-AgentProperty -Object $prView -Name 'baseRefOid' -Default '') } else { $null }
  $prHeadBranch = if ($prAvailable) { [string](Get-AgentProperty -Object $prView -Name 'headRefName' -Default '') } else { $null }
  $prBaseBranch = if ($prAvailable) { [string](Get-AgentProperty -Object $prView -Name 'baseRefName' -Default '') } else { $null }
  $reviewedHead = if ([string]::IsNullOrWhiteSpace($ReviewedHeadSha)) { $null } else { $ReviewedHeadSha.Trim() }
  if ([string]::IsNullOrWhiteSpace($ReviewedHeadSha)) {
    Add-AgentCheck -Name 'REVIEWED_HEAD_INPUT' -Passed $false -Blocker 'reviewed_head_sha_required'
    Add-AgentWarning -Message 'reviewed_head_sha_must_be_supplied_explicitly'
  } else {
    Add-AgentCheck -Name 'REVIEWED_HEAD_INPUT' -Passed (Test-AgentSha -Value $reviewedHead) -Blocker 'reviewed_head_sha_invalid'
  }
  Add-AgentCheck -Name 'PR_HEAD_REVIEWED' -Passed ((Test-AgentSha -Value $reviewedHead) -and [string]::Equals($reviewedHead, $prHead, [StringComparison]::OrdinalIgnoreCase)) -Blocker 'reviewed_head_does_not_match_pr_head'
  Add-AgentCheck -Name 'LOCAL_HEAD_MATCH' -Passed ((Test-AgentSha -Value $localHead) -and [string]::Equals($localHead, $reviewedHead, [StringComparison]::OrdinalIgnoreCase)) -Blocker 'local_head_differs_from_reviewed_head'
  Add-AgentCheck -Name 'EXPECTED_BASE_BRANCH' -Passed ($prAvailable -and [string]::Equals($prBaseBranch, $ExpectedBaseBranch, [StringComparison]::OrdinalIgnoreCase)) -Blocker 'unexpected_pr_base_branch'
  Add-AgentCheck -Name 'BASE_NOT_INVALIDATED' -Passed ((Test-AgentSha -Value $originMain) -and (Test-AgentSha -Value $prBase) -and [string]::Equals($originMain, $prBase, [StringComparison]::OrdinalIgnoreCase)) -Blocker 'pr_base_sha_is_stale'
  Add-AgentCheck -Name 'NO_CROSS_REPO' -Passed ($prAvailable -and (-not [bool](Get-AgentProperty -Object $prView -Name 'isCrossRepository' -Default $true))) -Blocker 'cross_repository_pr'
  Add-AgentCheck -Name 'PR_OPEN' -Passed ($prAvailable -and [string]::Equals([string](Get-AgentProperty -Object $prView -Name 'state' -Default ''), 'OPEN', [StringComparison]::OrdinalIgnoreCase)) -Blocker 'pr_not_open'
  Add-AgentCheck -Name 'NO_DRAFT' -Passed ($prAvailable -and (-not [bool](Get-AgentProperty -Object $prView -Name 'isDraft' -Default $true))) -Blocker 'pr_is_draft'
  Add-AgentCheck -Name 'MERGEABLE' -Passed ($prAvailable -and [string]::Equals([string](Get-AgentProperty -Object $prView -Name 'mergeable' -Default ''), 'MERGEABLE', [StringComparison]::OrdinalIgnoreCase)) -Blocker 'pr_not_mergeable'
  Add-AgentCheck -Name 'MERGE_STATE_CLEAN' -Passed ($prAvailable -and [string]::Equals([string](Get-AgentProperty -Object $prView -Name 'mergeStateStatus' -Default ''), 'CLEAN', [StringComparison]::OrdinalIgnoreCase)) -Blocker 'pr_merge_state_not_clean'
  Add-AgentCheck -Name 'NO_UNRESOLVED_REVIEWS' -Passed ($prAvailable -and [string]::Equals([string](Get-AgentProperty -Object $prView -Name 'reviewDecision' -Default ''), 'APPROVED', [StringComparison]::OrdinalIgnoreCase)) -Blocker 'reviews_not_approved'

  $remotePrHead = $null
  $remotePrHeadResult = $null
  if ($remoteOk -and -not [string]::IsNullOrWhiteSpace($prHeadBranch)) {
    $remotePrHeadResult = Invoke-AgentGit -GitPath $GitPath -RepoRoot $resolvedRepoRoot -Arguments @('ls-remote', $ExpectedRemote, "refs/heads/$prHeadBranch")
    if ((Get-AgentProperty -Object $remotePrHeadResult -Name 'exitCode' -Default 127) -eq 0 -and -not [string]::IsNullOrWhiteSpace([string](Get-AgentProperty -Object $remotePrHeadResult -Name 'text' -Default ''))) {
      $remotePrHead = (([string](Get-AgentProperty -Object $remotePrHeadResult -Name 'text' -Default '') -split '\s+')[0]).Trim()
    }
  }
  Add-AgentCheck -Name 'REMOTE_HEAD_MATCH' -Passed ((Test-AgentSha -Value $remotePrHead) -and [string]::Equals($remotePrHead, $prHead, [StringComparison]::OrdinalIgnoreCase)) -Blocker 'remote_branch_head_differs_from_pr_head'

  $ciApiResult = $null
  $ciApi = $null
  if ($ghAvailable -and $authOk -and (Test-AgentSha -Value $prHead)) {
    $ciApiResult = Invoke-AgentGh -GhPath $ghResolvedPath -RepoRoot $resolvedRepoRoot -Arguments @('api', "repos/$ExpectedRepository/commits/$prHead/check-runs?per_page=100")
    if ((Get-AgentProperty -Object $ciApiResult -Name 'exitCode' -Default 127) -eq 0) {
      try { $ciApi = [string](Get-AgentProperty -Object $ciApiResult -Name 'text' -Default '') | ConvertFrom-Json } catch { $ciApi = $null }
    }
  }
  $ciRunsValue = Get-AgentProperty -Object $ciApi -Name 'check_runs' -Default $null
  if ($null -ne $ciRunsValue) { $checkRuns = @($ciRunsValue) }
  $ciHeadMatch = $checkRuns.Count -gt 0
  $requiredResults = @()
  $requiredChecksGreen = $true
  foreach ($required in $RequiredCheck) {
    $candidate = $checkRuns |
      Where-Object { Test-AgentCheckName -Actual ([string](Get-AgentProperty -Object $_ -Name 'name' -Default '')) -Expected $required } |
      Sort-Object {
        $completedAt = [string](Get-AgentProperty -Object $_ -Name 'completed_at' -Default '')
        if ([string]::IsNullOrWhiteSpace($completedAt)) {
          [string](Get-AgentProperty -Object $_ -Name 'started_at' -Default '')
        } else {
          $completedAt
        }
      } -Descending |
      Select-Object -First 1
    $candidateHeadOk = $null -ne $candidate -and [string]::Equals([string](Get-AgentProperty -Object $candidate -Name 'head_sha' -Default ''), $prHead, [StringComparison]::OrdinalIgnoreCase)
    if ($null -eq $candidate -or -not $candidateHeadOk) { $ciHeadMatch = $false }
    $passed = $null -ne $candidate -and $candidateHeadOk -and [string]::Equals([string](Get-AgentProperty -Object $candidate -Name 'status' -Default ''), 'completed', [StringComparison]::OrdinalIgnoreCase) -and [string]::Equals([string](Get-AgentProperty -Object $candidate -Name 'conclusion' -Default ''), 'success', [StringComparison]::OrdinalIgnoreCase)
    if (-not $passed) { $requiredChecksGreen = $false }
    $requiredResults += [ordered]@{
      name = $required
      found = $null -ne $candidate
      status = if ($null -ne $candidate) { [string](Get-AgentProperty -Object $candidate -Name 'status' -Default '') } else { $null }
      conclusion = if ($null -ne $candidate) { [string](Get-AgentProperty -Object $candidate -Name 'conclusion' -Default '') } else { $null }
      headSha = if ($null -ne $candidate) { [string](Get-AgentProperty -Object $candidate -Name 'head_sha' -Default '') } else { $null }
      passed = $passed
    }
  }
  Add-AgentCheck -Name 'CI_HEAD_MATCH' -Passed $ciHeadMatch -Blocker 'ci_not_bound_to_pr_head'
  Add-AgentCheck -Name 'REQUIRED_CHECKS_GREEN' -Passed $requiredChecksGreen -Blocker 'required_checks_not_green'

  $diffPaths = @()
  if ((Test-AgentSha -Value $originMain) -and (Test-AgentSha -Value $reviewedHead)) {
    $diffResult = Invoke-AgentGit -GitPath $GitPath -RepoRoot $resolvedRepoRoot -Arguments @('diff', '--name-only', "$originMain...$reviewedHead")
    if ((Get-AgentProperty -Object $diffResult -Name 'exitCode' -Default 127) -eq 0) { $diffPaths = @((Get-AgentProperty -Object $diffResult -Name 'output' -Default @()) | ForEach-Object { [string]$_ } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }) }
  }
  $scopeBasis = 'reviewed_head_exact'
  $noUnexpectedDiff = $statusCommandOk -and $statusClean -and [string]::Equals($localHead, $reviewedHead, [StringComparison]::OrdinalIgnoreCase)
  if ($AllowedPath.Count -gt 0) {
    $scopeBasis = 'allowed_path_list'
    $noUnexpectedDiff = $true
    foreach ($path in $diffPaths) {
      $normalized = $path.Replace('\', '/')
      $allowed = $false
      foreach ($allowedPrefix in $AllowedPath) {
        $prefix = $allowedPrefix.Replace('\', '/').TrimEnd('/')
        if ([string]::Equals($normalized, $prefix, [StringComparison]::OrdinalIgnoreCase) -or $normalized.StartsWith("$prefix/", [StringComparison]::OrdinalIgnoreCase)) { $allowed = $true; break }
      }
      if (-not $allowed) { $noUnexpectedDiff = $false }
    }
  } else {
    Add-AgentWarning -Message 'path_allowlist_not_supplied_diff_scope_is_sha_based'
  }
  Add-AgentCheck -Name 'NO_UNEXPECTED_DIFF' -Passed $noUnexpectedDiff -Blocker 'unexpected_diff_scope'

  $checks['EXPECTED_BASE_SHA'] = $true
  $mergeReady = $blockers.Count -eq 0
  $result = [ordered]@{
    schemaVersion = 1
    kind = 'babel_agent_pr_gate'
    status = if ($mergeReady) { 'MERGE_READY' } else { 'BLOCKED' }
    mergeReady = $mergeReady
    repository = $ExpectedRepository
    remote = $ExpectedRemote
    pr = [ordered]@{ number = $PR; url = if ($prAvailable) { [string](Get-AgentProperty -Object $prView -Name 'url' -Default '') } else { $null } }
    sha = [ordered]@{
      reviewedHead = $reviewedHead
      prHead = $prHead
      remoteHead = $remotePrHead
      ciHead = if ($ciHeadMatch) { $prHead } else { $null }
      baseHead = $prBase
      currentOriginMain = $originMain
    }
    branch = [ordered]@{ local = $localBranch; prHead = $prHeadBranch; prBase = $prBaseBranch }
    worktree = [ordered]@{
      clean = $statusClean
      commandOk = $statusCommandOk
      dirtyPaths = @($statusDirtyPaths)
      rawEntryCount = $statusEntries.Count
      isolated = $topologyIsolated
    }
    checks = $checks
    requiredChecks = @($requiredResults)
    diff = [ordered]@{ scopeBasis = $scopeBasis; paths = @($diffPaths) }
    environment = $envState
    blockers = @($blockers | Select-Object -Unique)
    warnings = @($warnings | Select-Object -Unique)
  }
  Write-AgentResult -Result $result -OutputFormat $OutputFormat
  if (-not $mergeReady) { exit 1 }
  exit 0
} catch {
  $fallback = [ordered]@{
    schemaVersion = 1
    kind = 'babel_agent_pr_gate'
    status = 'BLOCKED'
    mergeReady = $false
    repository = $ExpectedRepository
    pr = [ordered]@{ number = $PR }
    checks = $checks
    blockers = @($blockers + 'pr_gate_exception' | Select-Object -Unique)
    warnings = @($warnings | Select-Object -Unique)
    errorType = $_.Exception.GetType().FullName
  }
  Write-AgentResult -Result $fallback -OutputFormat $OutputFormat
  exit 1
}
