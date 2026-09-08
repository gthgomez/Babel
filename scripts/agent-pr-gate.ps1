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
  [ValidateSet('GREEN', 'YELLOW', 'RED', 'BLACK', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL')][string]$RiskTier = 'GREEN',
  [string]$AutonomousReviewEvidencePath = '',
  [string]$BuilderIdentity = 'codex-implementation',
  [switch]$AuditOnly,
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
[object[]]$checkRuns = @()

function Add-AgentCheck {
  param([Parameter(Mandatory = $true)][string]$Name, [Parameter(Mandatory = $true)][bool]$Passed, [string]$Blocker = '')
  $checks[$Name] = $Passed
  if (-not $Passed -and -not [string]::IsNullOrWhiteSpace($Blocker)) { $script:blockers += $Blocker }
}

function Get-AgentLaneRank {
  param([Parameter(Mandatory = $true)][string]$Lane)
  switch ($Lane.ToUpperInvariant()) {
    'GREEN' { return 0 }; 'LOW' { return 0 }
    'YELLOW' { return 1 }; 'MEDIUM' { return 1 }
    'RED' { return 2 }; 'HIGH' { return 2 }; 'CRITICAL' { return 2 }
    'BLACK' { return 3 }
    default { throw "Unsupported risk lane: $Lane" }
  }
}

function ConvertTo-AgentRiskLane {
  param([Parameter(Mandatory = $true)][string]$Lane)
  switch ($Lane.ToUpperInvariant()) {
    'LOW' { return 'GREEN' }; 'MEDIUM' { return 'YELLOW' }
    'HIGH' { return 'RED' }; 'CRITICAL' { return 'RED' }
    default { return $Lane.ToUpperInvariant() }
  }
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
  $statusParameters = Get-AgentLocalValue -Object $statusRule -Name 'parameters'
  $statusEntries = Get-AgentLocalValue -Object $statusParameters -Name 'required_status_checks'
  $requiredStatusCheckPolicies = @($statusEntries | ForEach-Object {
      $context = Get-AgentLocalValue -Object $_ -Name 'context'
      $integrationValue = Get-AgentLocalValue -Object $_ -Name 'integration_id'
      $integrationId = $null
      if ($null -ne $integrationValue -and [string]$integrationValue -match '^\d+$') { $integrationId = [int64]$integrationValue }
      [pscustomobject][ordered]@{ context = [string]$context; integration_id = $integrationId }
    })
  return [pscustomobject][ordered]@{
    available = $true; id = [int64]$detail.id; name = [string]$detail.name; enforcement = [string]$detail.enforcement
    required_approving_review_count = [int]$pullRule.parameters.required_approving_review_count
    required_review_thread_resolution = [bool]$pullRule.parameters.required_review_thread_resolution
    require_code_owner_review = [bool]$pullRule.parameters.require_code_owner_review
    allowed_merge_methods = @($pullRule.parameters.allowed_merge_methods | ForEach-Object { [string]$_ })
    strict_required_status_checks_policy = [bool]$statusRule.parameters.strict_required_status_checks_policy
    required_status_checks = @($requiredStatusCheckPolicies | ForEach-Object { [string]$_.context })
    required_status_check_policies = @($requiredStatusCheckPolicies)
    # GitHub may omit bypass_actors for a token that can read the ruleset
    # definition but cannot enumerate its actor identities. Avoid strict-mode
    # property errors; the live ruleset remains independently captured and
    # verified by the release evidence checks.
    bypass_actors = if ($null -eq (Get-AgentLocalValue -Object $detail -Name 'bypass_actors')) { @() } else { @((Get-AgentLocalValue -Object $detail -Name 'bypass_actors')) }
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

function Wait-AgentRequiredChecksReady {
  param(
    [Parameter(Mandatory = $true)][string[]]$RequiredChecks,
    [Parameter(Mandatory = $true)][string]$TargetSha,
    # Linux/Windows validation is sequenced behind the public policy workflow;
    # the observed Windows certification can therefore start several minutes
    # after this gate. Keep polling exact-head runs with a bounded 30-minute
    # ceiling so the gate synchronizes with the required jobs without weakening
    # their terminal/conclusion/authority checks.
    [int]$MaxAttempts = 180,
    [int]$DelaySeconds = 10
  )
  $waitFor = @($RequiredChecks | Where-Object { -not [string]::Equals([string]$_, 'trusted-control-plane', [StringComparison]::OrdinalIgnoreCase) })
  if ($waitFor.Count -eq 0) { return [pscustomobject]@{ ready = $true; attempts = 0; reason = 'no_peer_checks_to_wait_for' } }
  for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
    $ciResult = Get-AgentJsonFromGh -Arguments @('api', "repos/$ExpectedRepository/commits/$TargetSha/check-runs?per_page=100")
    if ($ciResult.available) {
      [object[]]$runs = @($ciResult.value.check_runs)
      $allTerminal = $true
      foreach ($required in $waitFor) {
        $matching = @($runs | Where-Object {
            [string]$_.head_sha -eq $TargetSha -and
            (([string]$_.name) -eq $required -or ([string]$_.name).StartsWith("$required /", [StringComparison]::OrdinalIgnoreCase) -or ([string]$_.name).StartsWith("${required}:", [StringComparison]::OrdinalIgnoreCase))
          })
        if ($matching.Count -eq 0 -or @($matching | Where-Object { [string]$_.status -ne 'completed' }).Count -gt 0) {
          $allTerminal = $false
          break
        }
      }
      if ($allTerminal) { return [pscustomobject]@{ ready = $true; attempts = $attempt; reason = 'all_peer_required_checks_terminal' } }
    }
    if ($attempt -lt $MaxAttempts) { Start-Sleep -Seconds $DelaySeconds }
  }
  return [pscustomobject]@{ ready = $false; attempts = $MaxAttempts; reason = 'required_check_wait_timeout' }
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
    if ($result.exitCode -ne 0) { return [pscustomobject]@{ available = $false; resolved = $false; count = 0; error = 'review_threads_unreadable' } }
    try { $graph = $result.text | ConvertFrom-Json } catch { return [pscustomobject]@{ available = $false; resolved = $false; count = 0; error = 'review_threads_malformed' } }
    $data = Get-AgentLocalValue -Object $graph -Name 'data'
    $repository = Get-AgentLocalValue -Object $data -Name 'repository'
    $pullRequest = Get-AgentLocalValue -Object $repository -Name 'pullRequest'
    $reviewThreads = Get-AgentLocalValue -Object $pullRequest -Name 'reviewThreads'
    $pageInfo = if ($null -ne $reviewThreads) { Get-AgentLocalValue -Object $reviewThreads -Name 'pageInfo' } else { $null }
    $nodesProperty = if ($null -ne $reviewThreads) { $reviewThreads.PSObject.Properties['nodes'] } else { $null }
    if ($null -eq $nodesProperty -or $null -eq $pageInfo) { return [pscustomobject]@{ available = $false; resolved = $false; count = 0; error = 'review_threads_shape_invalid' } }
    $pages += $reviewThreads
    $hasNext = [bool](Get-AgentLocalValue -Object $pageInfo -Name 'hasNextPage')
    $nextCursor = [string](Get-AgentLocalValue -Object $pageInfo -Name 'endCursor')
    if ($hasNext -and [string]::IsNullOrWhiteSpace($nextCursor)) { return [pscustomobject]@{ available = $false; resolved = $false; count = 0; error = 'review_threads_pagination_incomplete' } }
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

function Read-AgentAutonomousReviewEvidence {
  param(
    [Parameter(Mandatory = $true)][string]$BaseSha,
    [Parameter(Mandatory = $true)][string]$HeadSha,
    [Parameter(Mandatory = $true)][int]$MinimumReviewCount
  )
  $path = $AutonomousReviewEvidencePath
  if ([string]::IsNullOrWhiteSpace($path)) { $path = Join-Path $resolvedRepoRoot ('.babel/merge-reviews/pr-{0}.ai-reviews.json' -f $PR) }
  if (-not [IO.Path]::IsPathRooted($path)) { $path = Join-Path $resolvedRepoRoot $path }
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return [pscustomobject]@{ path = $path; valid = $false; errors = @('autonomous_review_evidence_missing'); reviewCount = 0 } }
  try { $evidence = Get-Content -Raw -LiteralPath $path | ConvertFrom-Json } catch { return [pscustomobject]@{ path = $path; valid = $false; errors = @('autonomous_review_evidence_malformed'); reviewCount = 0 } }
  $transportError = Get-AgentEvidenceTransportError -Document $evidence
  if ($null -ne $transportError) { return [pscustomobject]@{ path = $path; valid = $false; errors = @($transportError); reviewCount = 0 } }
  $numstatResult = Invoke-AgentGit -GitPath $GitPath -RepoRoot $resolvedRepoRoot -Arguments @('diff', '--no-ext-diff', '--no-textconv', '--numstat', "$BaseSha...$HeadSha")
  if ($numstatResult.exitCode -ne 0) { return [pscustomobject]@{ path = $path; valid = $false; errors = @('autonomous_review_numstat_unavailable'); reviewCount = 0 } }
  $expectedDigest = Get-AgentNumstatDigest -NumstatLines @($numstatResult.output)
  # The file is only a cache. Reconstruct the latest round from live GitHub
  # metadata so a local builder cannot fabricate/choose an older envelope.
  try {
    $metadata = Get-AgentJsonFromGh -Arguments @('api', "repos/$ExpectedRepository")
    if (-not $metadata.available -or $metadata.value.full_name -ine $ExpectedRepository -or $metadata.value.owner.type -cne 'User' -or [string]$metadata.value.owner.id -notmatch '^[1-9][0-9]*$') { throw 'Owner identity unavailable.' }
    $publisherId = [string]$metadata.value.owner.id
    $comments = @(); $page = 1
    while ($true) {
      $response = Get-AgentJsonFromGh -Arguments @('api', "repos/$ExpectedRepository/issues/$PR/comments?per_page=100&page=$page")
      if (-not $response.available) { throw 'Comments unavailable.' }
      $comments += @($response.value)
      if (@($response.value).Count -lt 100) { break }
      $page++
    }
    $liveBundle = Select-AgentHostReviewBundle -Comments $comments -Repository $ExpectedRepository -PR $PR -BaseSha $BaseSha -HeadSha $HeadSha -PublisherId $publisherId
    if (($liveBundle | ConvertTo-Json -Depth 40 -Compress) -cne ($evidence | ConvertTo-Json -Depth 40 -Compress)) { throw 'Live handoff differs.' }
  } catch {
    return [pscustomobject]@{ path = $path; valid = $false; errors = @('controller_review_live_provenance_mismatch'); reviewCount = 0 }
  }
  $scopeResult = Invoke-AgentGit -GitPath $GitPath -RepoRoot $resolvedRepoRoot -Arguments @('-c', 'core.quotepath=false', 'diff', '--no-ext-diff', '--no-textconv', '--name-only', "$BaseSha...$HeadSha")
  if ($scopeResult.exitCode -ne 0) { return [pscustomobject]@{ path = $path; valid = $false; errors = @('autonomous_review_scope_unavailable'); reviewCount = 0 } }
  $validation = Test-AgentControllerReviewEvidenceBundle -Bundle $evidence -Repository $ExpectedRepository -PR $PR -BaseSha $BaseSha -HeadSha $HeadSha -BuilderIdentity $BuilderIdentity -ExpectedNumstatDigest $expectedDigest -MinimumReviewCount $MinimumReviewCount -PublisherId $publisherId -ExpectedScope @($scopeResult.output)
  return [pscustomobject]@{ path = $path; valid = [bool]$validation.valid; errors = @($validation.errors); reviewCount = [int]$validation.reviewCount }
}

try {
  $resolvedRepoRoot = (Resolve-Path -LiteralPath $RepoRoot -ErrorAction Stop).Path
  $envState = Set-AgentNonInteractiveEnvironment
  if ([string]::IsNullOrWhiteSpace($GitPath)) { $GitPath = Get-AgentCommandPath -Name 'git' }
  if ([string]::IsNullOrWhiteSpace($ghResolvedPath)) { try { $ghResolvedPath = Get-AgentCommandPath -Name 'gh' } catch { $ghResolvedPath = '' } }
  $gitAvailable = Test-Path -LiteralPath $GitPath -PathType Leaf
  Add-AgentCheck -Name 'GIT_EXECUTABLE' -Passed $gitAvailable -Blocker 'git_executable_unavailable'
  if (-not $gitAvailable) { throw "Git executable not found: $GitPath" }
  $ghAvailable = -not [string]::IsNullOrWhiteSpace($ghResolvedPath) -and (Test-Path -LiteralPath $ghResolvedPath -PathType Leaf)
  Add-AgentCheck -Name 'GH_EXECUTABLE' -Passed $ghAvailable -Blocker 'gh_executable_unavailable'
  $authOk = $false
  if ($ghAvailable) {
    # `gh auth status` reports local login state, which is not the same as
    # proving that the Actions token can perform the API read this gate needs.
    $authResult = Invoke-AgentGh -GhPath $ghResolvedPath -RepoRoot $resolvedRepoRoot -Arguments @('api', "repos/$ExpectedRepository", '--jq', '.full_name')
    $authOk = $authResult.exitCode -eq 0 -and [string]::Equals($authResult.text.Trim(), $ExpectedRepository, [StringComparison]::OrdinalIgnoreCase)
  }
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
  $topology = Get-AgentWorktreeTopology -GitPath $GitPath -RepoRoot $resolvedRepoRoot
  $reviewedHead = if ([string]::IsNullOrWhiteSpace($ReviewedHeadSha)) { $localHead } else { $ReviewedHeadSha }
  # The trusted workflow materializes the candidate as a detached, isolated
  # worktree on purpose. A detached head is only acceptable there, and only
  # when the materialized commit is the exact reviewed head; canonical
  # operator checkouts must still sit on a branch.
  $materializedCandidate = $RequireIsolatedWorktree -and $topology.available -and $topology.isolated -and
    (Test-AgentShaValue $localHead) -and (Test-AgentShaValue $reviewedHead) -and
    [string]::Equals($localHead, $reviewedHead, [StringComparison]::OrdinalIgnoreCase)
  $branchResult = Invoke-AgentGit -GitPath $GitPath -RepoRoot $resolvedRepoRoot -Arguments @('symbolic-ref', '--quiet', '--short', 'HEAD')
  $localBranch = if ($branchResult.exitCode -eq 0) { $branchResult.text.Trim() } else { '' }
  Add-AgentCheck -Name 'ON_BRANCH' -Passed ((-not [string]::IsNullOrWhiteSpace($localBranch)) -or $materializedCandidate) -Blocker 'detached_head'
  $status = Get-AgentStatusSnapshot -GitPath $GitPath -RepoRoot $resolvedRepoRoot
  Add-AgentCheck -Name 'WORKTREE_CLEAN' -Passed ($status.commandOk -and $status.clean) -Blocker 'dirty_worktree'
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
  Add-AgentCheck -Name 'PR_HEAD_REVIEWED' -Passed ((Test-AgentShaValue $reviewedHead) -and [string]::Equals($reviewedHead, $prHead, [StringComparison]::OrdinalIgnoreCase)) -Blocker 'reviewed_head_does_not_match_pr_head'
  Add-AgentCheck -Name 'LOCAL_HEAD_MATCH' -Passed ((Test-AgentShaValue $localHead) -and [string]::Equals($localHead, $reviewedHead, [StringComparison]::OrdinalIgnoreCase)) -Blocker 'local_head_differs_from_reviewed_head'
  Add-AgentCheck -Name 'EXPECTED_BASE_BRANCH' -Passed ($prAvailable -and [string]::Equals($prBaseBranch, $ExpectedBaseBranch, [StringComparison]::OrdinalIgnoreCase)) -Blocker 'unexpected_pr_base_branch'
  Add-AgentCheck -Name 'BASE_NOT_INVALIDATED' -Passed ((Test-AgentShaValue $originMain) -and (Test-AgentShaValue $prBase) -and [string]::Equals($originMain, $prBase, [StringComparison]::OrdinalIgnoreCase)) -Blocker 'pr_base_sha_is_stale'
  Add-AgentCheck -Name 'NO_CROSS_REPO' -Passed ($prAvailable -and (-not [bool]$prView.isCrossRepository)) -Blocker 'cross_repository_pr'
  Add-AgentCheck -Name 'PR_OPEN' -Passed ($prAvailable -and [string]$prView.state -eq 'OPEN') -Blocker 'pr_not_open'
  Add-AgentCheck -Name 'NO_DRAFT' -Passed ($prAvailable -and -not [bool]$prView.isDraft) -Blocker 'pr_is_draft'
  Add-AgentCheck -Name 'MERGEABLE' -Passed ($prAvailable -and [string]$prView.mergeable -eq 'MERGEABLE') -Blocker 'pr_not_mergeable'
  # While this job itself is the executing trusted-control-plane check, GitHub
  # reports the merge state as BLOCKED because this very check is pending.
  # Conflict detection remains enforced through MERGEABLE, draft state through
  # NO_DRAFT, and every peer required check through its own authoritative
  # resolution below.
  $runningTrustedControlPlane = [string]::Equals([string]$env:GITHUB_ACTIONS, 'true', [StringComparison]::OrdinalIgnoreCase) -and
    [string]::Equals([string]$env:GITHUB_EVENT_NAME, 'pull_request_target', [StringComparison]::OrdinalIgnoreCase) -and
    [string]::Equals([string]$env:GITHUB_WORKFLOW, 'Trusted Control Plane', [StringComparison]::OrdinalIgnoreCase) -and
    [string]::Equals([string]$env:GITHUB_JOB, 'trusted-control-plane', [StringComparison]::OrdinalIgnoreCase)
  $mergeStateAcceptable = ($prAvailable -and [string]$prView.mergeStateStatus -eq 'CLEAN') -or
    ($runningTrustedControlPlane -and $prAvailable -and [string]$prView.mergeable -eq 'MERGEABLE')
  Add-AgentCheck -Name 'MERGE_STATE_CLEAN' -Passed $mergeStateAcceptable -Blocker 'pr_merge_state_not_clean'

  $rulesetPolicy = if ($ghAvailable -and $authOk) { Get-AgentRulesetPolicy } else {
    [pscustomobject]@{ available = $false; error = 'active_ruleset_unreadable'; required_review_thread_resolution = $false; required_approving_review_count = -1; required_status_checks = @(); required_status_check_policies = @(); strict_required_status_checks_policy = $null; id = $null; name = $null; enforcement = $null }
  }
  Add-AgentCheck -Name 'ACTIVE_RULESET_READABLE' -Passed ([bool]$rulesetPolicy.available) -Blocker 'active_ruleset_unreadable'
  # Exact base/head evidence is only durable when GitHub refuses a merge after
  # main advances. This closes the interval after this base-rooted run exits.
  Add-AgentCheck -Name 'REQUIRED_STATUS_CHECKS_STRICT' -Passed ($rulesetPolicy.available -and [bool]$rulesetPolicy.strict_required_status_checks_policy) -Blocker 'required_status_checks_not_strict'
  # An empty @() emitted from an if-expression unrolls to $null on assignment,
  # so the fallback assignment is kept explicit to stay null-safe.
  $requiredChecks = @()
  if ($rulesetPolicy.available) { $requiredChecks = @($rulesetPolicy.required_status_checks) }
  if ($requiredChecks.Count -eq 0) { $blockers += 'required_status_checks_unreadable' }
  $requiredCheckPolicies = @()
  if ($rulesetPolicy.available) { $requiredCheckPolicies = @($rulesetPolicy.required_status_check_policies) }
  $producerBindingsComplete = $rulesetPolicy.available -and $requiredChecks.Count -gt 0 -and $requiredCheckPolicies.Count -eq $requiredChecks.Count
  if ($producerBindingsComplete) {
    foreach ($required in $requiredChecks) {
      $matchingPolicies = @($requiredCheckPolicies | Where-Object {
          [string]::Equals([string]$_.context, [string]$required, [StringComparison]::OrdinalIgnoreCase) -and
            $null -ne $_.integration_id -and [int64]$_.integration_id -gt 0
        })
      if ($matchingPolicies.Count -ne 1) { $producerBindingsComplete = $false; break }
    }
  }
  Add-AgentCheck -Name 'REQUIRED_CHECK_PRODUCERS_BOUND' -Passed $producerBindingsComplete -Blocker 'required_check_producer_binding_incomplete'
  $requiredChecksReady = if ($rulesetPolicy.available -and $authOk -and (Test-AgentShaValue $prHead)) { Wait-AgentRequiredChecksReady -RequiredChecks $requiredChecks -TargetSha $prHead } else { [pscustomobject]@{ ready = $false; attempts = 0; reason = 'required_check_wait_prerequisite_missing' } }
  Add-AgentCheck -Name 'REQUIRED_CHECKS_READY' -Passed ([bool]$requiredChecksReady.ready) -Blocker 'required_check_wait_timeout'
  $githubApprovalCount = if ($rulesetPolicy.available) { [int]$rulesetPolicy.required_approving_review_count } else { -1 }
  $observedApprovalCount = if ($prAvailable) { Get-AgentLatestApprovalCount -PRData $prView } else { 0 }
  $threads = if ($rulesetPolicy.available -and $rulesetPolicy.required_review_thread_resolution) { Get-AgentReviewThreadStatus } else { [pscustomobject]@{ available = $true; resolved = $true; count = 0; unresolved = 0; error = '' } }
  Add-AgentCheck -Name 'REVIEW_THREADS_RESOLVED' -Passed ($threads.available -and $threads.resolved) -Blocker 'unresolved_or_unreadable_review_threads'
  $diffPaths = @()
  $diffPathsAvailable = $false
  if ((Test-AgentShaValue $originMain) -and (Test-AgentShaValue $reviewedHead)) {
    $diffResult = Invoke-AgentGit -GitPath $GitPath -RepoRoot $resolvedRepoRoot -Arguments @('diff', '--name-only', "$originMain...$reviewedHead")
    if ($diffResult.exitCode -eq 0) {
      $diffPaths = @($diffResult.output | ForEach-Object { [string]$_ } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
      $diffPathsAvailable = $true
    }
  }
  Add-AgentCheck -Name 'DIFF_PATHS_AVAILABLE' -Passed $diffPathsAvailable -Blocker 'diff_paths_unavailable'
  $baseDerivedLane = Get-AgentRiskLane -ChangedPaths $diffPaths
  $requestedLane = ConvertTo-AgentRiskLane -Lane $RiskTier
  $effectiveLane = if ((Get-AgentLaneRank -Lane $requestedLane) -gt (Get-AgentLaneRank -Lane $baseDerivedLane)) { $requestedLane } else { $baseDerivedLane }
  $minimumReviewCount = switch ($effectiveLane) { 'YELLOW' { 1 }; 'RED' { 2 }; default { 0 } }
  $independentRequired = $minimumReviewCount -gt 0
  $autonomousEvidenceResult = [pscustomobject]@{ path = ''; valid = $true; errors = @(); reviewCount = 0 }
  if ($independentRequired -and $prAvailable) {
    $autonomousEvidenceResult = Read-AgentAutonomousReviewEvidence -BaseSha $prBase -HeadSha $prHead -MinimumReviewCount $minimumReviewCount
  }
  $independentReviewTier = if ($independentRequired) { 'CONTROLLER_OWNED_AI' } else { 'NOT_REQUIRED' }
  $independentReviewSatisfied = (-not $independentRequired) -or $autonomousEvidenceResult.valid
  Add-AgentCheck -Name 'INDEPENDENT_REVIEW_SATISFIED' -Passed $independentReviewSatisfied -Blocker 'independent_review_not_satisfied'
  Add-AgentCheck -Name 'RISK_LANE_NOT_BLACK' -Passed ($effectiveLane -ne 'BLACK') -Blocker 'black_scope_requires_owner_decision'
  $reviewPolicy = Get-AgentReviewPolicyVerdict -RequiredApprovalCount $githubApprovalCount -ObservedApprovalCount $observedApprovalCount -ThreadsRequired ([bool]$rulesetPolicy.required_review_thread_resolution) -ThreadsResolved ([bool]$threads.resolved) -IndependentRequired $independentRequired -IndependentSatisfied $independentReviewSatisfied
  Add-AgentCheck -Name 'GITHUB_APPROVAL_SATISFIED' -Passed ($rulesetPolicy.available -and $reviewPolicy.github_approval_satisfied) -Blocker 'github_required_approval_not_satisfied'

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
    $checkApp = Get-AgentLocalValue -Object $run -Name 'app'
    $raw = [pscustomobject][ordered]@{
      name = [string]$run.name; head_sha = [string]$run.head_sha; status = [string]$run.status; conclusion = [string]$run.conclusion
      check_run_id = [string]$run.id; check_suite_id = [string](Get-AgentLocalValue -Object $checkSuite -Name 'id')
      started_at = [string]$run.started_at; completed_at = [string]$run.completed_at; details_url = [string](Get-AgentLocalValue -Object $run -Name 'details_url')
      event = [string](Get-AgentLocalValue -Object $run -Name 'event'); workflow_id = [string](Get-AgentLocalValue -Object $run -Name 'workflow_id')
      workflow_name = [string](Get-AgentLocalValue -Object $run -Name 'workflow_name'); workflow_run_id = [string](Get-AgentLocalValue -Object $run -Name 'workflow_run_id')
      workflow_run_attempt = [string](Get-AgentLocalValue -Object $run -Name 'workflow_run_attempt'); authority = [string](Get-AgentLocalValue -Object $run -Name 'authority')
      app_id = [string](Get-AgentLocalValue -Object $checkApp -Name 'id'); app_slug = [string](Get-AgentLocalValue -Object $checkApp -Name 'slug'); app_name = [string](Get-AgentLocalValue -Object $checkApp -Name 'name')
    }
    $normalizedRuns += ConvertTo-AgentCheckObservation -Raw $raw -WorkflowMetadata $metadata
  }
  $requiredResults = @()
  $requiredChecksGreen = $true
  $ciHeadMatch = $true
  foreach ($required in $requiredChecks) {
    $isSelfCheck = [string]::Equals($required, 'trusted-control-plane', [StringComparison]::OrdinalIgnoreCase)
    if ($isSelfCheck -and $runningTrustedControlPlane) {
      # This job cannot observe its own completed check-run while executing.
      # GitHub records this check as successful only after this audit exits 0;
      # all peer checks remain resolved through the normal authoritative path.
      $resolution = [pscustomobject][ordered]@{ status = 'PASS'; reason = 'self_check_deferred_to_current_job_result'; required = $required; selected = $null; candidates = @(); ignored = @() }
    } else {
      $authority = Get-AgentRequiredCheckAuthority -RequiredName $required
      if (-not [bool]$authority.configured) {
        $resolution = [pscustomobject][ordered]@{ status = 'AMBIGUOUS'; reason = [string]$authority.reason; required = $required; selected = $null; candidates = @(); ignored = @() }
      } else {
        # The ruleset's GitHub Actions integration ID is part of the producer
        # binding. A missing binding is represented by an impossible ID so a
        # same-name check can never satisfy the requirement accidentally.
        [Nullable[int64]]$authorityAppId = 0
        $matchingPolicy = @($requiredCheckPolicies | Where-Object {
            [string]::Equals([string]$_.context, [string]$required, [StringComparison]::OrdinalIgnoreCase)
          })
        if ($matchingPolicy.Count -eq 1 -and $null -ne $matchingPolicy[0].integration_id -and [int64]$matchingPolicy[0].integration_id -gt 0) {
          $authorityAppId = [int64]$matchingPolicy[0].integration_id
        }
        $resolution = Resolve-AgentRequiredCheck -Observations $normalizedRuns -RequiredName $required -TargetSha $prHead -AuthorityEvent ([string]$authority.event) -AuthorityWorkflowName ([string]$authority.workflow_name) -AuthorityAppId $authorityAppId
      }
    }
    if ($resolution.status -ne 'PASS') { $requiredChecksGreen = $false; $ciHeadMatch = $false }
    $selected = Get-AgentLocalValue -Object $resolution -Name 'selected'
    $candidateIds = Get-AgentLocalValue -Object $resolution -Name 'candidates'
    $ignoredIds = Get-AgentLocalValue -Object $resolution -Name 'ignored'
    $candidateList = if ($null -eq $candidateIds) { @() } else { @($candidateIds) }
    $ignoredList = if ($null -eq $ignoredIds) { @() } else { @($ignoredIds) }
    $selectedProducer = if ($null -ne $selected) {
      [ordered]@{
        check_run_id = [string](Get-AgentLocalValue -Object $selected -Name 'check_run_id')
        event = [string](Get-AgentLocalValue -Object $selected -Name 'event')
        workflow_name = [string](Get-AgentLocalValue -Object $selected -Name 'workflow_name')
        workflow_id = [string](Get-AgentLocalValue -Object $selected -Name 'workflow_id')
        workflow_run_id = [string](Get-AgentLocalValue -Object $selected -Name 'workflow_run_id')
        app_id = [string](Get-AgentLocalValue -Object $selected -Name 'app_id')
        app_slug = [string](Get-AgentLocalValue -Object $selected -Name 'app_slug')
        app_name = [string](Get-AgentLocalValue -Object $selected -Name 'app_name')
      }
    } else { $null }
    $requiredResults += [ordered]@{ name = $required; status = [string]$resolution.status; reason = [string]$resolution.reason; selected = if ($null -ne $selected) { [string]$selected.check_run_id } else { $null }; producer = $selectedProducer; candidates = $candidateList; ignored = $ignoredList }
  }
  Add-AgentCheck -Name 'CI_HEAD_MATCH' -Passed ($ciHeadMatch -and $requiredChecks.Count -gt 0) -Blocker 'ci_not_bound_to_pr_head'
  Add-AgentCheck -Name 'REQUIRED_CHECKS_GREEN' -Passed ($requiredChecksGreen -and $requiredChecks.Count -gt 0) -Blocker 'required_checks_not_green'

  $noUnexpectedDiff = $status.commandOk -and $status.clean -and [string]::Equals($localHead, $reviewedHead, [StringComparison]::OrdinalIgnoreCase)
  if ($AllowedPath.Count -gt 0) {
    foreach ($path in $diffPaths) {
      $normalized = $path.Replace('\', '/'); $allowed = $false
      foreach ($prefixValue in $AllowedPath) {
        $prefix = $prefixValue.Replace('\', '/').TrimEnd('/')
        if ($normalized -ieq $prefix -or $normalized.StartsWith("$prefix/", [StringComparison]::OrdinalIgnoreCase)) { $allowed = $true; break }
      }
      if (-not $allowed) { $noUnexpectedDiff = $false }
    }
  }
  Add-AgentCheck -Name 'NO_UNEXPECTED_DIFF' -Passed $noUnexpectedDiff -Blocker 'unexpected_diff_scope'
  $auditPassed = $blockers.Count -eq 0
  $mergeReady = $auditPassed
  $result = [ordered]@{
    schemaVersion = 4; kind = 'babel_agent_pr_gate'; status = if ($mergeReady) { 'MERGE_READY' } else { 'BLOCKED' }; mergeReady = $mergeReady
    repository = $ExpectedRepository; remote = $ExpectedRemote; pr = [ordered]@{ number = $PR; url = if ($prAvailable) { [string]$prView.url } else { $null } }
    sha = [ordered]@{ reviewedHead = $reviewedHead; prHead = $prHead; remoteHead = $remotePrHead; ciHead = if ($ciHeadMatch) { $prHead } else { $null }; baseHead = $prBase; currentOriginMain = $originMain }
    branch = [ordered]@{ local = $localBranch; prHead = $prHeadBranch; prBase = $prBaseBranch }
    worktree = [ordered]@{ clean = $status.clean; dirtyPaths = @($status.dirtyPaths); isolated = $topology.isolated }
    repositoryPolicy = [ordered]@{ source = 'github_ruleset'; rulesetId = if ($rulesetPolicy.available) { $rulesetPolicy.id } else { $null }; name = if ($rulesetPolicy.available) { $rulesetPolicy.name } else { $null }; enforcement = if ($rulesetPolicy.available) { $rulesetPolicy.enforcement } else { $null }; githubRequiredApprovalCount = $githubApprovalCount; requiredReviewThreadResolution = if ($rulesetPolicy.available) { $rulesetPolicy.required_review_thread_resolution } else { $null }; requiredStatusChecks = @($requiredChecks); requiredStatusCheckProducers = @($requiredCheckPolicies); requiredStatusCheckProducersBound = [bool]$producerBindingsComplete; strictRequiredStatusChecksPolicy = if ($rulesetPolicy.available) { $rulesetPolicy.strict_required_status_checks_policy } else { $null } }
    reviewPolicy = [ordered]@{ requestedRiskLane = $requestedLane; baseDerivedRiskLane = $baseDerivedLane; effectiveRiskLane = $effectiveLane; githubApprovalSatisfied = [bool]$reviewPolicy.github_approval_satisfied; observedApprovalCount = $observedApprovalCount; reviewThreadsRequired = if ($rulesetPolicy.available) { [bool]$rulesetPolicy.required_review_thread_resolution } else { $null }; reviewThreadsSatisfied = [bool]$reviewPolicy.review_threads_satisfied; independentReviewRequired = $independentRequired; minimumIndependentReviewCount = $minimumReviewCount; independentReviewSatisfied = $independentReviewSatisfied; independentReviewTier = $independentReviewTier; independentReviewEvidence = $autonomousEvidenceResult.path; independentReviewEvidenceErrors = @($autonomousEvidenceResult.errors); observedIndependentReviewCount = $autonomousEvidenceResult.reviewCount; taskAuthorization = 'dispatch_scope'; auditOnly = [bool]$AuditOnly }
    checks = $checks; requiredChecks = @($requiredResults); diff = [ordered]@{ scopeBasis = 'reviewed_head_exact'; paths = @($diffPaths) }; environment = $envState; blockers = @($blockers | Select-Object -Unique); warnings = @($warnings | Select-Object -Unique)
  }
  Write-AgentResult -Result $result -OutputFormat $OutputFormat
  if (-not $auditPassed) { exit 1 }
  exit 0
} catch {
  $fallback = [ordered]@{ schemaVersion = 4; kind = 'babel_agent_pr_gate'; status = 'BLOCKED'; mergeReady = $false; repository = $ExpectedRepository; pr = [ordered]@{ number = $PR }; checks = $checks; blockers = @($blockers + 'pr_gate_exception' | Select-Object -Unique); warnings = @($warnings | Select-Object -Unique); errorType = $_.Exception.GetType().FullName; errorMessage = $_.Exception.Message; errorScriptStackTrace = $_.ScriptStackTrace }
  Write-AgentResult -Result $fallback -OutputFormat $OutputFormat
  exit 1
}
