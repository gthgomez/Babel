[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][int]$PR,
  [string]$RepoRoot = (Join-Path $PSScriptRoot '..'),
  [string]$GitPath = (Join-Path $env:ProgramFiles 'Git\cmd\git.exe'),
  [string]$GhPath = '',
  [string]$ExpectedRemote = 'origin',
  [string]$ExpectedRepository = 'gthgomez/Babel',
  [string]$ExpectedBaseBranch = 'main',
  [string]$ReviewedHeadSha = '',
  [ValidateSet('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')][string]$RiskTier = 'HIGH',
  [string]$IndependentReviewReceiptPath = '',
  [string]$ReviewChallengeLedgerPath = '',
  [string]$BuilderIdentity = 'codex-implementation',
  [string]$TaskId = '',
  [string]$RunId = '',
  [string]$ContractHash = '',
  [switch]$MergeAuthorized,
  [switch]$AuditOnly,
  [switch]$BootstrapRepairAuthorized,
  [string[]]$RequiredCheck = @(),
  [string[]]$AllowedPath = @(),
  [switch]$RequireIsolatedWorktree,
  [ValidateSet('json', 'text')][string]$OutputFormat = 'json'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path $PSScriptRoot 'agent-git-common.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'agent-pr-gate-common.psm1') -Force

$resolvedRepoRoot = $null
$ghResolvedPath = $GhPath
$checks = [ordered]@{}
$blockers = @()
$warnings = @()
$localHead = $null
$originMain = $null
$prView = $null
$rulesetPolicy = $null
$checkRuns = @()

function Add-AgentCheck {
  param([Parameter(Mandatory = $true)][string]$Name, [Parameter(Mandatory = $true)][bool]$Passed, [string]$Blocker = '')
  $checks[$Name] = $Passed
  if (-not $Passed -and -not [string]::IsNullOrWhiteSpace($Blocker)) { $script:blockers += $Blocker }
}

function Get-AgentLocalValue {
  param([AllowNull()][object]$Object, [Parameter(Mandatory = $true)][string]$Name)
  if ($null -eq $Object -or $null -eq $Object.PSObject.Properties[$Name]) { return $null }
  return $Object.PSObject.Properties[$Name].Value
}

function Get-AgentJsonFromGh {
  param([Parameter(Mandatory = $true)][string[]]$Arguments)
  $result = Invoke-AgentGh -GhPath $ghResolvedPath -RepoRoot $resolvedRepoRoot -Arguments $Arguments
  if ($result.exitCode -ne 0) { return [pscustomobject]@{ available = $false; value = $null; error = ($result.text.Trim()) } }
  try { return [pscustomobject]@{ available = $true; value = ($result.text | ConvertFrom-Json); error = '' } }
  catch { return [pscustomobject]@{ available = $false; value = $null; error = 'github_json_malformed' } }
}

function Get-AgentRulesetPolicy {
  $listResult = Get-AgentJsonFromGh -Arguments @('api', "repos/$ExpectedRepository/rulesets?per_page=100")
  if (-not $listResult.available) { return [pscustomobject]@{ available = $false; error = 'active_ruleset_unreadable' } }
  $candidates = @($listResult.value | Where-Object { [string]$_.name -eq 'protect-main' -and [string]$_.enforcement -eq 'active' })
  if ($candidates.Count -ne 1 -or [string]::IsNullOrWhiteSpace([string]$candidates[0].id)) { return [pscustomobject]@{ available = $false; error = if ($candidates.Count -eq 0) { 'active_protect_main_ruleset_missing' } else { 'active_protect_main_ruleset_ambiguous' } } }
  $candidate = $candidates[0]
  $detailResult = Get-AgentJsonFromGh -Arguments @('api', "repos/$ExpectedRepository/rulesets/$($candidate.id)")
  if (-not $detailResult.available) { return [pscustomobject]@{ available = $false; error = 'active_ruleset_detail_unreadable'; id = [string]$candidate.id } }
  $detail = $detailResult.value
  $pullRules = @($detail.rules | Where-Object { [string]$_.type -eq 'pull_request' })
  $statusRules = @($detail.rules | Where-Object { [string]$_.type -eq 'required_status_checks' })
  if ($pullRules.Count -ne 1 -or $statusRules.Count -ne 1) { return [pscustomobject]@{ available = $false; error = 'active_ruleset_required_rules_ambiguous_or_missing'; id = [string]$candidate.id } }
  $pullRule = $pullRules[0]
  $statusRule = $statusRules[0]
  return [pscustomobject][ordered]@{
    available = $true; id = [int64]$detail.id; name = [string]$detail.name; enforcement = [string]$detail.enforcement
    required_approving_review_count = [int]$pullRule.parameters.required_approving_review_count
    required_review_thread_resolution = [bool]$pullRule.parameters.required_review_thread_resolution
    require_code_owner_review = [bool]$pullRule.parameters.require_code_owner_review
    allowed_merge_methods = @($pullRule.parameters.allowed_merge_methods | ForEach-Object { [string]$_ })
    strict_required_status_checks_policy = [bool]$statusRule.parameters.strict_required_status_checks_policy
    required_status_checks = @($statusRule.parameters.required_status_checks | ForEach-Object { [string]$_.context })
    bypass_actors = @($detail.bypass_actors)
  }
}

function Get-AgentWorkflowMetadata {
  param([Parameter(Mandatory = $true)][object]$CheckRun)
  $metadata = @{}
  foreach ($name in @('event', 'workflow_id', 'workflow_name', 'workflow_run_id', 'workflow_run_attempt')) {
    $value = Get-AgentLocalValue -Object $CheckRun -Name $name
    if ($null -ne $value -and -not [string]::IsNullOrWhiteSpace([string]$value)) { $metadata[$name] = [string]$value }
  }
  $detailsUrl = [string](Get-AgentLocalValue -Object $CheckRun -Name 'details_url')
  if (-not $metadata.ContainsKey('event') -and $detailsUrl -match '/runs/(?<runId>\d+)') {
    $runResult = Get-AgentJsonFromGh -Arguments @('api', "repos/$ExpectedRepository/actions/runs/$($Matches.runId)")
    if ($runResult.available) {
      $run = $runResult.value
      $metadata['event'] = [string]$run.event; $metadata['workflow_id'] = [string]$run.workflow_id
      $metadata['workflow_name'] = [string]$run.name; $metadata['workflow_run_id'] = [string]$run.id; $metadata['workflow_run_attempt'] = [string]$run.run_attempt
    }
  }
  return $metadata
}

function Get-AgentReviewThreadStatus {
  $parts = $ExpectedRepository.Split('/', 2)
  if ($parts.Count -ne 2) { return [pscustomobject]@{ available = $false; resolved = $false; count = 0; error = 'repository_slug_invalid' } }
  $after = $null
  $pages = @()
  do {
    if ($null -eq $after) {
      $query = 'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){nodes{isResolved} pageInfo{hasNextPage endCursor}}}}}'
      $arguments = @('api', 'graphql', '-f', "query=$query", '-F', "owner=$($parts[0])", '-F', "name=$($parts[1])", '-F', "number=$PR")
    } else {
      $query = 'query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$after){nodes{isResolved} pageInfo{hasNextPage endCursor}}}}}'
      $arguments = @('api', 'graphql', '-f', "query=$query", '-F', "owner=$($parts[0])", '-F', "name=$($parts[1])", '-F', "number=$PR", '-f', "after=$after")
    }
    $result = Invoke-AgentGh -GhPath $ghResolvedPath -RepoRoot $resolvedRepoRoot -Arguments $arguments
    if ($result.exitCode -ne 0) { return [pscustomobject]@{ available = $false; resolved = $false; count = $count; unresolved = $unresolved; error = 'review_threads_unreadable' } }
    try { $graph = $result.text | ConvertFrom-Json } catch { return [pscustomobject]@{ available = $false; resolved = $false; count = $count; unresolved = $unresolved; error = 'review_threads_malformed' } }
    $data = Get-AgentLocalValue -Object $graph -Name 'data'
    $repository = Get-AgentLocalValue -Object $data -Name 'repository'
    $pullRequest = Get-AgentLocalValue -Object $repository -Name 'pullRequest'
    $reviewThreads = Get-AgentLocalValue -Object $pullRequest -Name 'reviewThreads'
    if ($null -eq $reviewThreads) { return [pscustomobject]@{ available = $false; resolved = $false; count = 0; unresolved = 0; error = 'review_threads_shape_invalid' } }
    $pages += $reviewThreads
    $pageInfo = Get-AgentLocalValue -Object $reviewThreads -Name 'pageInfo'
    if ($null -eq $reviewThreads.PSObject.Properties['nodes'] -or $null -eq $pageInfo) { return [pscustomobject]@{ available = $false; resolved = $false; count = 0; unresolved = 0; error = 'review_threads_shape_invalid' } }
    $hasNext = [bool](Get-AgentLocalValue -Object $pageInfo -Name 'hasNextPage')
    $nextCursor = [string](Get-AgentLocalValue -Object $pageInfo -Name 'endCursor')
    if ($hasNext -and [string]::IsNullOrWhiteSpace($nextCursor)) { return [pscustomobject]@{ available = $false; resolved = $false; count = 0; unresolved = 0; error = 'review_threads_pagination_incomplete' } }
    $after = if ($hasNext) { $nextCursor } else { $null }
  } while ($null -ne $after)
  return Resolve-AgentReviewThreadPages -Pages $pages
}

function Get-AgentLatestApprovalCount {
  param([Parameter(Mandatory = $true)][object]$PRData)
  $latest = @{}
  $reviews = Get-AgentLocalValue -Object $PRData -Name 'reviews'
  foreach ($review in @($reviews)) {
    $author = [string](Get-AgentLocalValue -Object $review.author -Name 'login')
    if ([string]::IsNullOrWhiteSpace($author)) { continue }
    $submitted = [string](Get-AgentLocalValue -Object $review -Name 'submittedAt')
    if (-not $latest.ContainsKey($author) -or $submitted -gt [string]$latest[$author].submittedAt) { $latest[$author] = $review }
  }
  return @($latest.Values | Where-Object { [string]$_.state -eq 'APPROVED' }).Count
}

function Read-AgentIndependentReceipt {
  param([Parameter(Mandatory = $true)][string]$BaseSha, [Parameter(Mandatory = $true)][string]$HeadSha)
  $path = $IndependentReviewReceiptPath
  if ([string]::IsNullOrWhiteSpace($path)) { $path = Join-Path $resolvedRepoRoot ".babel/merge-reviews/pr-$PR.json" }
  if (-not [IO.Path]::IsPathRooted($path)) { $path = Join-Path $resolvedRepoRoot $path }
  $ledgerPath = $ReviewChallengeLedgerPath
  if ([string]::IsNullOrWhiteSpace($ledgerPath)) { $ledgerPath = Join-Path $resolvedRepoRoot '.babel/merge-reviews/review-challenge-ledger.json' }
  if (-not [IO.Path]::IsPathRooted($ledgerPath)) { $ledgerPath = Join-Path $resolvedRepoRoot $ledgerPath }
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return [pscustomobject]@{ path = $path; valid = $false; errors = @('independent_review_receipt_missing') } }
  try { $receipt = Get-Content -Raw -LiteralPath $path | ConvertFrom-Json } catch { return [pscustomobject]@{ path = $path; valid = $false; errors = @('independent_review_receipt_malformed') } }
  $validation = Test-AgentIndependentReviewReceipt -Receipt $receipt -Repository $ExpectedRepository -PR $PR -BaseSha $BaseSha -HeadSha $HeadSha -BuilderIdentity $BuilderIdentity -TaskId $TaskId -RunId $RunId -ContractHash $ContractHash
  $errors = @($validation.errors)
  if (-not [bool]$validation.valid) { return [pscustomobject]@{ path = $path; valid = $false; errors = $errors } }

  # The reviewer key registry is read from the immutable PR base, never from
  # the candidate head. A builder may add a public key-shaped file to its
  # branch, but that cannot authorize its own review lane.
  $keySpec = '{0}:config/independent-review-keys.json' -f $BaseSha
  $keyResult = Invoke-AgentGit -GitPath $GitPath -RepoRoot $resolvedRepoRoot -Arguments @('show', $keySpec)
  if ($keyResult.exitCode -ne 0 -or [string]::IsNullOrWhiteSpace($keyResult.text)) {
    $errors += 'review_key_registry_unavailable_from_base'
    return [pscustomobject]@{ path = $path; valid = $false; errors = $errors }
  }
  $keyPath = [IO.Path]::GetTempFileName()
  $supervisorKeyPath = [IO.Path]::GetTempFileName()
  try {
    Set-Content -LiteralPath $keyPath -Value $keyResult.text -Encoding utf8NoBOM
    $supervisorKeySpec = '{0}:config/trusted-supervisor-keys.json' -f $BaseSha
    $supervisorKeyResult = Invoke-AgentGit -GitPath $GitPath -RepoRoot $resolvedRepoRoot -Arguments @('show', $supervisorKeySpec)
    if ($supervisorKeyResult.exitCode -ne 0 -or [string]::IsNullOrWhiteSpace($supervisorKeyResult.text)) {
      $errors += 'supervisor_key_registry_unavailable_from_base'
      return [pscustomobject]@{ path = $path; valid = $false; errors = $errors }
    }
    Set-Content -LiteralPath $supervisorKeyPath -Value $supervisorKeyResult.text -Encoding utf8NoBOM
    $nodePath = ''
    try { $nodePath = Get-AgentCommandPath -Name 'node' } catch { $nodePath = '' }
    if ([string]::IsNullOrWhiteSpace($nodePath)) {
      $errors += 'node_executable_unavailable_for_review_signature'
      return [pscustomobject]@{ path = $path; valid = $false; errors = $errors }
    }
    # The verifier is trusted code. Materialize it from the immutable base
    # commit; never execute the candidate checkout's verifier implementation.
    $verifierPath = Join-Path ([IO.Path]::GetTempPath()) ('babel-trusted-review-verifier-{0}-{1}.mjs' -f $PID, ([guid]::NewGuid().ToString('N')))
    $verifierSpec = '{0}:scripts/verify-independent-review.mjs' -f $BaseSha
    $verifierResult = Invoke-AgentGit -GitPath $GitPath -RepoRoot $resolvedRepoRoot -Arguments @('show', $verifierSpec)
    if ($verifierResult.exitCode -ne 0 -or [string]::IsNullOrWhiteSpace($verifierResult.text)) {
      $errors += 'trusted_base_verifier_unavailable'
      return [pscustomobject]@{ path = $path; valid = $false; errors = $errors }
    }
    try {
      Set-Content -LiteralPath $verifierPath -Value $verifierResult.text -Encoding utf8NoBOM
      $verifyResult = Invoke-AgentProcess -FilePath $nodePath -WorkingDirectory ([IO.Path]::GetTempPath()) -Arguments @($verifierPath, '--receipt', $path, '--keys', $keyPath, '--ledger', $ledgerPath, '--supervisor-keys', $supervisorKeyPath)
      $signatureResult = $null
      try { $signatureResult = $verifyResult.text | ConvertFrom-Json } catch { $signatureResult = $null }
      if ($verifyResult.exitCode -ne 0 -or $null -eq $signatureResult -or -not [bool]$signatureResult.valid) {
        $errors += if ($null -ne $signatureResult -and $null -ne $signatureResult.errors) { @($signatureResult.errors) } else { 'review_signature_unverified' }
        return [pscustomobject]@{ path = $path; valid = $false; errors = $errors }
      }
    } finally {
      if (Test-Path -LiteralPath $verifierPath -PathType Leaf) { Remove-Item -LiteralPath $verifierPath -Force -ErrorAction SilentlyContinue }
    }
  } finally {
    if (Test-Path -LiteralPath $keyPath -PathType Leaf) { Remove-Item -LiteralPath $keyPath -Force -ErrorAction SilentlyContinue }
    if (Test-Path -LiteralPath $supervisorKeyPath -PathType Leaf) { Remove-Item -LiteralPath $supervisorKeyPath -Force -ErrorAction SilentlyContinue }
  }
  return [pscustomobject]@{ path = $path; valid = $true; errors = @() }
}

try {
  $resolvedRepoRoot = (Resolve-Path -LiteralPath $RepoRoot -ErrorAction Stop).Path
  $envState = Set-AgentNonInteractiveEnvironment
  if ([string]::IsNullOrWhiteSpace($ghResolvedPath)) { try { $ghResolvedPath = Get-AgentCommandPath -Name 'gh' } catch { $ghResolvedPath = '' } }
  $gitAvailable = Test-Path -LiteralPath $GitPath -PathType Leaf
  Add-AgentCheck -Name 'GIT_EXECUTABLE' -Passed $gitAvailable -Blocker 'git_executable_unavailable'
  if (-not $gitAvailable) { throw "Git executable not found: $GitPath" }
  $ghAvailable = -not [string]::IsNullOrWhiteSpace($ghResolvedPath) -and (Test-Path -LiteralPath $ghResolvedPath -PathType Leaf)
  Add-AgentCheck -Name 'GH_EXECUTABLE' -Passed $ghAvailable -Blocker 'gh_executable_unavailable'
  $authOk = $false
  if ($ghAvailable) { $authResult = Invoke-AgentGh -GhPath $ghResolvedPath -RepoRoot $resolvedRepoRoot -Arguments @('auth', 'status', '--hostname', 'github.com'); $authOk = $authResult.exitCode -eq 0 }
  Add-AgentCheck -Name 'AUTH_OK' -Passed $authOk -Blocker 'github_auth_failed'
  $remoteUrl = Get-AgentRemoteUrl -GitPath $GitPath -RepoRoot $resolvedRepoRoot -Remote $ExpectedRemote
  $remoteSlug = Get-AgentRemoteSlug -RemoteUrl $remoteUrl
  $remoteOk = [string]::Equals($remoteSlug, $ExpectedRepository, [StringComparison]::OrdinalIgnoreCase)
  Add-AgentCheck -Name 'REMOTE_OK' -Passed $remoteOk -Blocker 'unexpected_origin_repository'
  Add-AgentCheck -Name 'REMOTE_CREDENTIAL_FREE' -Passed (Test-AgentRemoteCredentialFree -RemoteUrl $remoteUrl) -Blocker 'token_bearing_remote_url'
  $fetchResult = if ($remoteOk) { Invoke-AgentGit -GitPath $GitPath -RepoRoot $resolvedRepoRoot -Arguments @('fetch', $ExpectedRemote, '--prune') } else { $null }
  Add-AgentCheck -Name 'FETCH_OK' -Passed ($null -ne $fetchResult -and $fetchResult.exitCode -eq 0) -Blocker 'fetch_failed'
  $localHead = Get-AgentGitText -GitPath $GitPath -RepoRoot $resolvedRepoRoot -Arguments @('rev-parse', 'HEAD')
  Add-AgentCheck -Name 'LOCAL_HEAD_KNOWN' -Passed (Test-AgentShaValue $localHead) -Blocker 'local_head_unknown'
  $branchResult = Invoke-AgentGit -GitPath $GitPath -RepoRoot $resolvedRepoRoot -Arguments @('symbolic-ref', '--quiet', '--short', 'HEAD')
  $localBranch = if ($branchResult.exitCode -eq 0) { $branchResult.text.Trim() } else { '' }
  Add-AgentCheck -Name 'ON_BRANCH' -Passed (-not [string]::IsNullOrWhiteSpace($localBranch)) -Blocker 'detached_head'
  $status = Get-AgentStatusSnapshot -GitPath $GitPath -RepoRoot $resolvedRepoRoot
  Add-AgentCheck -Name 'WORKTREE_CLEAN' -Passed ($status.commandOk -and $status.clean) -Blocker 'dirty_worktree'
  $topology = Get-AgentWorktreeTopology -GitPath $GitPath -RepoRoot $resolvedRepoRoot
  if ($RequireIsolatedWorktree) {
    Add-AgentCheck -Name 'WORKTREE_ISOLATED' -Passed ($topology.available -and $topology.isolated) -Blocker 'isolated_worktree_required'
  } else {
    Add-AgentCheck -Name 'WORKTREE_ISOLATED' -Passed $true
    if (-not ($topology.available -and $topology.isolated)) { $warnings += 'canonical_checkout_allowed_unless_require_isolated_worktree_is_set' }
  }
  $originMain = Get-AgentGitText -GitPath $GitPath -RepoRoot $resolvedRepoRoot -Arguments @('rev-parse', "$ExpectedRemote/$ExpectedBaseBranch")
  Add-AgentCheck -Name 'BASE_SHA_AVAILABLE' -Passed (Test-AgentShaValue $originMain) -Blocker 'base_sha_unavailable'

  $repoView = $null
  if ($ghAvailable -and $authOk) {
    $repoResult = Get-AgentJsonFromGh -Arguments @('repo', 'view', $ExpectedRepository, '--json', 'nameWithOwner,defaultBranchRef')
    if ($repoResult.available) { $repoView = $repoResult.value }
    Add-AgentCheck -Name 'EXPECTED_REPO' -Passed ($null -ne $repoView -and [string]::Equals([string]$repoView.nameWithOwner, $ExpectedRepository, [StringComparison]::OrdinalIgnoreCase)) -Blocker 'github_repository_metadata_mismatch'
    $prFields = 'number,url,state,isDraft,baseRefName,baseRefOid,headRefName,headRefOid,mergeable,mergeStateStatus,reviewDecision,reviews,isCrossRepository,headRepositoryOwner,headRepository'
    $prResult = Get-AgentJsonFromGh -Arguments @('pr', 'view', [string]$PR, '--repo', $ExpectedRepository, '--json', $prFields)
    if ($prResult.available) { $prView = $prResult.value }
  } else { Add-AgentCheck -Name 'EXPECTED_REPO' -Passed $false -Blocker 'github_repository_not_checked' }
  $prAvailable = $null -ne $prView
  Add-AgentCheck -Name 'PR_READABLE' -Passed $prAvailable -Blocker 'pull_request_not_readable'
  $prHead = if ($prAvailable) { [string]$prView.headRefOid } else { '' }
  $prBase = if ($prAvailable) { [string]$prView.baseRefOid } else { '' }
  $prHeadBranch = if ($prAvailable) { [string]$prView.headRefName } else { '' }
  $prBaseBranch = if ($prAvailable) { [string]$prView.baseRefName } else { '' }
  $reviewedHead = if ([string]::IsNullOrWhiteSpace($ReviewedHeadSha)) { $localHead } else { $ReviewedHeadSha }
  Add-AgentCheck -Name 'PR_HEAD_REVIEWED' -Passed ((Test-AgentShaValue $reviewedHead) -and [string]::Equals($reviewedHead, $prHead, [StringComparison]::OrdinalIgnoreCase)) -Blocker 'reviewed_head_does_not_match_pr_head'
  Add-AgentCheck -Name 'LOCAL_HEAD_MATCH' -Passed ((Test-AgentShaValue $localHead) -and [string]::Equals($localHead, $reviewedHead, [StringComparison]::OrdinalIgnoreCase)) -Blocker 'local_head_differs_from_reviewed_head'
  Add-AgentCheck -Name 'EXPECTED_BASE_BRANCH' -Passed ($prAvailable -and [string]::Equals($prBaseBranch, $ExpectedBaseBranch, [StringComparison]::OrdinalIgnoreCase)) -Blocker 'unexpected_pr_base_branch'
  Add-AgentCheck -Name 'BASE_NOT_INVALIDATED' -Passed ((Test-AgentShaValue $originMain) -and (Test-AgentShaValue $prBase) -and [string]::Equals($originMain, $prBase, [StringComparison]::OrdinalIgnoreCase)) -Blocker 'pr_base_sha_is_stale'
  Add-AgentCheck -Name 'NO_CROSS_REPO' -Passed ($prAvailable -and (-not [bool]$prView.isCrossRepository)) -Blocker 'cross_repository_pr'
  Add-AgentCheck -Name 'PR_OPEN' -Passed ($prAvailable -and [string]$prView.state -eq 'OPEN') -Blocker 'pr_not_open'
  Add-AgentCheck -Name 'NO_DRAFT' -Passed ($prAvailable -and -not [bool]$prView.isDraft) -Blocker 'pr_is_draft'
  Add-AgentCheck -Name 'MERGEABLE' -Passed ($prAvailable -and [string]$prView.mergeable -eq 'MERGEABLE') -Blocker 'pr_not_mergeable'
  Add-AgentCheck -Name 'MERGE_STATE_CLEAN' -Passed ($prAvailable -and [string]$prView.mergeStateStatus -eq 'CLEAN') -Blocker 'pr_merge_state_not_clean'

  $rulesetPolicy = if ($ghAvailable -and $authOk) { Get-AgentRulesetPolicy } else {
    [pscustomobject]@{ available = $false; error = 'active_ruleset_unreadable'; required_review_thread_resolution = $false; required_approving_review_count = -1; required_status_checks = @(); strict_required_status_checks_policy = $null; id = $null; name = $null; enforcement = $null }
  }
  Add-AgentCheck -Name 'ACTIVE_RULESET_READABLE' -Passed ([bool]$rulesetPolicy.available) -Blocker 'active_ruleset_unreadable'
  $requiredChecks = if ($rulesetPolicy.available) { @($rulesetPolicy.required_status_checks) } else { @() }
  if ($requiredChecks.Count -eq 0) { $blockers += 'required_status_checks_unreadable' }
  $githubApprovalCount = if ($rulesetPolicy.available) { [int]$rulesetPolicy.required_approving_review_count } else { -1 }
  $observedApprovalCount = if ($prAvailable) { Get-AgentLatestApprovalCount -PRData $prView } else { 0 }
  $threads = if ($rulesetPolicy.available -and $rulesetPolicy.required_review_thread_resolution) { Get-AgentReviewThreadStatus } else { [pscustomobject]@{ available = $true; resolved = $true; count = 0; unresolved = 0; error = '' } }
  Add-AgentCheck -Name 'REVIEW_THREADS_RESOLVED' -Passed ($threads.available -and $threads.resolved) -Blocker 'unresolved_or_unreadable_review_threads'
  $independentRequired = $RiskTier -in @('HIGH', 'CRITICAL')
  $receipt = if ($independentRequired -and $prAvailable) { Read-AgentIndependentReceipt -BaseSha $prBase -HeadSha $prHead } else { [pscustomobject]@{ path = ''; valid = $true; errors = @() } }
  Add-AgentCheck -Name 'INDEPENDENT_REVIEW_SATISFIED' -Passed ((-not $independentRequired) -or $receipt.valid) -Blocker 'independent_review_not_satisfied'
  $reviewPolicy = Get-AgentReviewPolicyVerdict -RequiredApprovalCount $githubApprovalCount -ObservedApprovalCount $observedApprovalCount -ThreadsRequired ([bool]$rulesetPolicy.required_review_thread_resolution) -ThreadsResolved ([bool]$threads.resolved) -IndependentRequired $independentRequired -IndependentSatisfied ([bool]$receipt.valid) -MergeAuthorized ([bool]($MergeAuthorized -or $AuditOnly))
  Add-AgentCheck -Name 'GITHUB_APPROVAL_SATISFIED' -Passed ($rulesetPolicy.available -and $reviewPolicy.github_approval_satisfied) -Blocker 'github_required_approval_not_satisfied'
  Add-AgentCheck -Name 'MERGE_AUTHORITY_SATISFIED' -Passed ([bool]($MergeAuthorized -or $AuditOnly)) -Blocker 'explicit_merge_authority_missing'

  $remotePrHead = ''
  if ($remoteOk -and -not [string]::IsNullOrWhiteSpace($prHeadBranch)) {
    $remotePrHeadResult = Invoke-AgentGit -GitPath $GitPath -RepoRoot $resolvedRepoRoot -Arguments @('ls-remote', $ExpectedRemote, "refs/heads/$prHeadBranch")
    if ($remotePrHeadResult.exitCode -eq 0) { $remotePrHead = (($remotePrHeadResult.text -split '\s+')[0]).Trim() }
  }
  Add-AgentCheck -Name 'REMOTE_HEAD_MATCH' -Passed ((Test-AgentShaValue $remotePrHead) -and [string]::Equals($remotePrHead, $prHead, [StringComparison]::OrdinalIgnoreCase)) -Blocker 'remote_branch_head_differs_from_pr_head'

  if ($ghAvailable -and $authOk -and (Test-AgentShaValue $prHead)) {
    $ciResult = Get-AgentJsonFromGh -Arguments @('api', "repos/$ExpectedRepository/commits/$prHead/check-runs?per_page=100")
    if ($ciResult.available) { $checkRuns = @($ciResult.value.check_runs) }
  }
  $normalizedRuns = @()
  foreach ($run in $checkRuns) {
    $metadata = Get-AgentWorkflowMetadata -CheckRun $run
    $checkSuite = Get-AgentLocalValue -Object $run -Name 'check_suite'
    $raw = [pscustomobject][ordered]@{
      name = [string]$run.name; head_sha = [string]$run.head_sha; status = [string]$run.status; conclusion = [string]$run.conclusion
      check_run_id = [string]$run.id; check_suite_id = [string](Get-AgentLocalValue -Object $checkSuite -Name 'id')
      started_at = [string]$run.started_at; completed_at = [string]$run.completed_at; details_url = [string](Get-AgentLocalValue -Object $run -Name 'details_url')
      event = [string](Get-AgentLocalValue -Object $run -Name 'event'); workflow_id = [string](Get-AgentLocalValue -Object $run -Name 'workflow_id')
      workflow_name = [string](Get-AgentLocalValue -Object $run -Name 'workflow_name'); workflow_run_id = [string](Get-AgentLocalValue -Object $run -Name 'workflow_run_id')
      workflow_run_attempt = [string](Get-AgentLocalValue -Object $run -Name 'workflow_run_attempt'); authority = [string](Get-AgentLocalValue -Object $run -Name 'authority')
    }
    $normalizedRuns += ConvertTo-AgentCheckObservation -Raw $raw -WorkflowMetadata $metadata
  }
  $requiredResults = @()
  $requiredChecksGreen = $true
  $ciHeadMatch = $true
  foreach ($required in $requiredChecks) {
    $event = if ([string]::Equals($required, 'public-pr-metadata', [StringComparison]::OrdinalIgnoreCase)) { 'pull_request_target' } else { 'pull_request' }
    $workflow = if ([string]::Equals($required, 'public-pr-metadata', [StringComparison]::OrdinalIgnoreCase)) { 'Public PR Metadata' } else { 'Public Release Gate' }
    $resolution = Resolve-AgentRequiredCheck -Observations $normalizedRuns -RequiredName $required -TargetSha $prHead -AuthorityEvent $event -AuthorityWorkflowName $workflow
    if ($resolution.status -ne 'PASS') { $requiredChecksGreen = $false; $ciHeadMatch = $false }
    $selected = Get-AgentLocalValue -Object $resolution -Name 'selected'
    $candidateIds = Get-AgentLocalValue -Object $resolution -Name 'candidates'
    $ignoredIds = Get-AgentLocalValue -Object $resolution -Name 'ignored'
    $candidateList = if ($null -eq $candidateIds) { @() } else { @($candidateIds) }
    $ignoredList = if ($null -eq $ignoredIds) { @() } else { @($ignoredIds) }
    $requiredResults += [ordered]@{ name = $required; status = [string]$resolution.status; reason = [string]$resolution.reason; selected = if ($null -ne $selected) { [string]$selected.check_run_id } else { $null }; candidates = $candidateList; ignored = $ignoredList }
  }
  Add-AgentCheck -Name 'CI_HEAD_MATCH' -Passed ($ciHeadMatch -and $requiredChecks.Count -gt 0) -Blocker 'ci_not_bound_to_pr_head'
  Add-AgentCheck -Name 'REQUIRED_CHECKS_GREEN' -Passed ($requiredChecksGreen -and $requiredChecks.Count -gt 0) -Blocker 'required_checks_not_green'

  $bootstrapException = [ordered]@{ requested = [bool]$BootstrapRepairAuthorized; active = $false; reason = $null; legacyMetadataObservation = $null }
  if ($BootstrapRepairAuthorized) {
    $metadataResult = @($requiredResults | Where-Object { $_.name -eq 'public-pr-metadata' })[0]
    $nonMetadataResultsPass = @($requiredResults | Where-Object { $_.name -ne 'public-pr-metadata' -and $_.status -eq 'PASS' }).Count -eq ($requiredResults.Count - 1)
    $legacyMetadata = @($normalizedRuns | Where-Object {
        [string]::Equals([string]$_.name, 'public-pr-metadata', [StringComparison]::OrdinalIgnoreCase) -and
        [string]::Equals([string]$_.head_sha, $prHead, [StringComparison]::OrdinalIgnoreCase) -and
        [string]::Equals([string]$_.event, 'pull_request_target', [StringComparison]::OrdinalIgnoreCase) -and
        [string]::Equals([string]$_.workflow_name, 'Public Release Gate', [StringComparison]::OrdinalIgnoreCase) -and
        [string]::Equals([string]$_.status, 'completed', [StringComparison]::OrdinalIgnoreCase) -and
        [string]::Equals([string]$_.conclusion, 'success', [StringComparison]::OrdinalIgnoreCase)
      } | Sort-Object @{ Expression = { Get-AgentObservationTimestamp -Observation $_ }; Descending = $true }, @{ Expression = { [string]$_.check_run_id }; Descending = $true })
    $onlyKnownBootstrapBlockers = @($blockers | Where-Object { $_ -notin @('ci_not_bound_to_pr_head', 'required_checks_not_green') }).Count -eq 0
    if ($null -ne $metadataResult -and $metadataResult.status -eq 'AMBIGUOUS' -and $metadataResult.reason -eq 'no_authoritative_workflow_observation' -and $nonMetadataResultsPass -and $legacyMetadata.Count -gt 0 -and $onlyKnownBootstrapBlockers) {
      $bootstrapException.active = $true
      $bootstrapException.reason = 'new_pull_request_target_workflow_requires_default_branch_bootstrap'
      $bootstrapException.legacyMetadataObservation = [string]$legacyMetadata[0].check_run_id
      $blockers = @($blockers | Where-Object { $_ -notin @('ci_not_bound_to_pr_head', 'required_checks_not_green') })
    }
  }

  $diffPaths = @()
  if ((Test-AgentShaValue $originMain) -and (Test-AgentShaValue $reviewedHead)) {
    $diffResult = Invoke-AgentGit -GitPath $GitPath -RepoRoot $resolvedRepoRoot -Arguments @('diff', '--name-only', "$originMain...$reviewedHead")
    if ($diffResult.exitCode -eq 0) { $diffPaths = @($diffResult.output | ForEach-Object { [string]$_ } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }) }
  }
  $noUnexpectedDiff = $status.commandOk -and $status.clean -and [string]::Equals($localHead, $reviewedHead, [StringComparison]::OrdinalIgnoreCase)
  if ($AllowedPath.Count -gt 0) {
    foreach ($path in $diffPaths) {
      $normalized = $path.Replace('\', '/'); $allowed = $false
      foreach ($prefixValue in $AllowedPath) { $prefix = $prefixValue.Replace('\', '/').TrimEnd('/'); if ([string]::Equals($normalized, $prefix, [StringComparison]::OrdinalIgnoreCase) -or $normalized.StartsWith("$prefix/", [StringComparison]::OrdinalIgnoreCase)) { $allowed = $true; break } }
      if (-not $allowed) { $noUnexpectedDiff = $false }
    }
  }
  $protectedTrustRootPaths = @('config/independent-review-keys.json', 'config/trusted-supervisor-keys.json', 'scripts/verify-independent-review.mjs', 'scripts/trusted-merge-gate.ps1', 'scripts/bootstrap-trust-root.ps1', 'scripts/agent-pr-gate.ps1', 'scripts/agent-pr-gate-common.psm1', 'scripts/agent-git-common.psm1')
  $trustRootChanged = @($diffPaths | Where-Object { $protectedTrustRootPaths -contains $_ }).Count -gt 0
  if ($trustRootChanged -and ($PR -ne 121 -or -not $BootstrapRepairAuthorized)) { $noUnexpectedDiff = $false; $blockers += 'protected_trust_root_modified' }
  Add-AgentCheck -Name 'NO_UNEXPECTED_DIFF' -Passed $noUnexpectedDiff -Blocker 'unexpected_diff_scope'
  $auditPassed = $blockers.Count -eq 0
  $mergeReady = $auditPassed -and [bool]$MergeAuthorized
  $result = [ordered]@{
    schemaVersion = 2; kind = 'babel_agent_pr_gate'; status = if ($mergeReady) { 'MERGE_READY' } else { 'BLOCKED' }; mergeReady = $mergeReady
    repository = $ExpectedRepository; remote = $ExpectedRemote; pr = [ordered]@{ number = $PR; url = if ($prAvailable) { [string]$prView.url } else { $null } }
    sha = [ordered]@{ reviewedHead = $reviewedHead; prHead = $prHead; remoteHead = $remotePrHead; ciHead = if ($ciHeadMatch) { $prHead } else { $null }; baseHead = $prBase; currentOriginMain = $originMain }
    branch = [ordered]@{ local = $localBranch; prHead = $prHeadBranch; prBase = $prBaseBranch }
    worktree = [ordered]@{ clean = $status.clean; dirtyPaths = @($status.dirtyPaths); isolated = $topology.isolated }
    repositoryPolicy = [ordered]@{ source = 'github_ruleset'; rulesetId = if ($rulesetPolicy.available) { $rulesetPolicy.id } else { $null }; name = if ($rulesetPolicy.available) { $rulesetPolicy.name } else { $null }; enforcement = if ($rulesetPolicy.available) { $rulesetPolicy.enforcement } else { $null }; githubRequiredApprovalCount = $githubApprovalCount; requiredReviewThreadResolution = if ($rulesetPolicy.available) { $rulesetPolicy.required_review_thread_resolution } else { $null }; requiredStatusChecks = @($requiredChecks); strictRequiredStatusChecksPolicy = if ($rulesetPolicy.available) { $rulesetPolicy.strict_required_status_checks_policy } else { $null } }
    reviewPolicy = [ordered]@{ riskTier = $RiskTier; githubApprovalSatisfied = [bool]$reviewPolicy.github_approval_satisfied; observedApprovalCount = $observedApprovalCount; reviewThreadsRequired = if ($rulesetPolicy.available) { [bool]$rulesetPolicy.required_review_thread_resolution } else { $null }; reviewThreadsSatisfied = [bool]$reviewPolicy.review_threads_satisfied; independentReviewRequired = $independentRequired; independentReviewSatisfied = [bool]$reviewPolicy.independent_review_satisfied; independentReviewReceipt = $receipt.path; mergeAuthorityRequired = $true; mergeAuthoritySatisfied = [bool]$MergeAuthorized; mergeAuthoritySource = if ($MergeAuthorized) { 'current_task_explicit_user_authorization' } else { $null }; auditOnly = [bool]$AuditOnly }
    checks = $checks; requiredChecks = @($requiredResults); bootstrapException = $bootstrapException; diff = [ordered]@{ scopeBasis = 'reviewed_head_exact'; paths = @($diffPaths) }; environment = $envState; blockers = @($blockers | Select-Object -Unique); warnings = @($warnings | Select-Object -Unique)
  }
  Write-AgentResult -Result $result -OutputFormat $OutputFormat
  if (-not $auditPassed) { exit 1 }
  if (-not $mergeReady -and -not $AuditOnly) { exit 1 }
  exit 0
} catch {
  $fallback = [ordered]@{ schemaVersion = 2; kind = 'babel_agent_pr_gate'; status = 'BLOCKED'; mergeReady = $false; repository = $ExpectedRepository; pr = [ordered]@{ number = $PR }; checks = $checks; blockers = @($blockers + 'pr_gate_exception' | Select-Object -Unique); warnings = @($warnings | Select-Object -Unique); errorType = $_.Exception.GetType().FullName; errorMessage = $_.Exception.Message }
  Write-AgentResult -Result $fallback -OutputFormat $OutputFormat
  exit 1
}
