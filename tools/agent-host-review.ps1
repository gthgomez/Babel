[CmdletBinding()]
param(
  [Parameter(Mandatory)][int]$PR,
  [Parameter(Mandatory)][string]$RepoRoot,
  [Parameter(Mandatory)][string]$TaskPath,
  [Parameter(Mandatory)][string]$BudgetLedgerPath,
  [Parameter(Mandatory)][ValidateRange(0.001, 1000000)][double]$BudgetUsd,
  [ValidateRange(0, 1000000)][double]$PriorReservedUsd = 0,
  [string]$Repository = 'gthgomez/Babel',
  [string]$BuilderIdentity = 'codex-implementation',
  [string[]]$Models = @('deepseek-v4-flash', 'mimo-v2.5'),
  [string]$ExternalExecutionModule = '',
  [switch]$Publish,
  [switch]$PreflightOnly
)
# Run from an owner-controlled, verified installation, not candidate code.
# GitHub authenticates publication; it does not perform or bill the AI review.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# Native stdin is JSON, not a text file: never prepend the host's UTF-8 BOM.
# Script scope preserves the caller's encoding after this command returns.
$OutputEncoding = [Text.UTF8Encoding]::new($false)
Import-Module (Join-Path $PSScriptRoot '../scripts/agent-pr-gate-common.psm1') -Force
$controllerRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$resolvedRepo = (Resolve-Path -LiteralPath $RepoRoot).Path
$resolvedTask = (Resolve-Path -LiteralPath $TaskPath).Path
if ($Repository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' -or $PR -lt 1 -or
    $Models.Count -notin @(1, 2) -or @($Models | Select-Object -Unique).Count -ne $Models.Count -or
    @($Models | Where-Object { $_ -cnotin @('deepseek-v4-flash', 'mimo-v2.5', 'longcat-2.0') }).Count -gt 0) { throw 'Invalid review target or exact model selection.' }
function Test-ExcludedReviewPath([string]$Path) {
  # Public configuration templates are intentionally reviewable source, not
  # credential stores. Real .env files remain excluded by the matcher below.
  if ($Path -match '(?i)(^|[\\/])\.env\.example$') { return $false }
  return $Path -match '(?i)(^|[\\/])(\.env([.]|$)|auth[.]json$|credentials([.]|$)|[.]credentials|id_rsa$|id_ed25519$)|[.](pem|p12|pfx|key)$|(^|[\\/])([.]npmrc|gradle[.]properties|local[.]properties)$'
}

function Get-HostReviewUsageUpperBound {
  param([Parameter(Mandatory)][string]$Model, [Parameter(Mandatory)][double]$InputTokens, [Parameter(Mandatory)][double]$OutputTokens)
  # Peak published OpenCode Go prices per 1M tokens, checked 2026-09-08.
  # Keep this independent from worker-provided values: the controller owns
  # reconciliation and never trusts a candidate or worker to price itself.
  $prices = @{
    'deepseek-v4-flash' = @{ input = 0.44; output = 1.32 }
    'mimo-v2.5' = @{ input = 0.14; output = 0.28 }
    'longcat-2.0' = @{ input = 0.30; output = 1.20 }
  }
  if (-not $prices.ContainsKey($Model)) { throw 'Unknown exact-model price; retain reservation.' }
  $price = $prices[$Model]
  return ($InputTokens * [double]$price.input + $OutputTokens * [double]$price.output) / 1000000
}
if (Test-ExcludedReviewPath $resolvedTask) { throw 'Secret-risk task source is excluded.' }
$ledgerPath = [IO.Path]::GetFullPath($BudgetLedgerPath)
if (Test-ExcludedReviewPath $ledgerPath) { throw 'Secret-risk ledger path is excluded.' }
New-Item -ItemType Directory -Path (Split-Path -Parent $ledgerPath) -Force | Out-Null
$stateDirectory = Get-Item -LiteralPath (Split-Path -Parent $ledgerPath)
for ($ancestor = $stateDirectory; $null -ne $ancestor; $ancestor = $ancestor.Parent) {
  if (($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint) -or (Test-Path -LiteralPath (Join-Path $ancestor.FullName '.git'))) {
    throw 'Controller state must be outside Git worktrees and reparse-point paths.'
  }
}
if ((Test-Path -LiteralPath $ledgerPath) -and ((Get-Item -LiteralPath $ledgerPath).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Controller ledger must not be a reparse point.' }
# Exclusive lock prevents parallel workers overspending one campaign ledger.
$lockPath = "$ledgerPath.lock"
$lock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::Write, [IO.FileShare]::None)
try {
  $ledger = if (Test-Path -LiteralPath $ledgerPath) { Get-Content -Raw -LiteralPath $ledgerPath | ConvertFrom-Json } else {
    [pscustomobject]@{ schema_version = 1; ceiling_usd = $BudgetUsd; reserved_usd = $PriorReservedUsd; executions = @() }
  }
  if ($ledger.schema_version -ne 1 -or [double]$ledger.ceiling_usd -ne $BudgetUsd -or [double]$ledger.reserved_usd -lt $PriorReservedUsd -or [double]$ledger.reserved_usd -lt 0) { throw 'Budget ledger mismatch; never silently reset spending.' }
  if ($null -ne $ledger.PSObject.Properties['accounting_breach'] -and $ledger.accounting_breach) { throw 'Prior accounting breach requires reconciliation before any further spend or publication.' }
  function Save-Ledger {
    $bytes = [Text.Encoding]::UTF8.GetBytes(($ledger | ConvertTo-Json -Depth 40))
    $temporary = "$ledgerPath.$([guid]::NewGuid().ToString('N')).tmp"
    $stream = [IO.File]::Open($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $stream.Write($bytes); $stream.Flush($true) } finally { $stream.Dispose() }
    # Same-volume atomic rename: an interrupted save leaves the previous ledger
    # intact. Never restore an older backup that could undercount spending.
    [IO.File]::Move($temporary, $ledgerPath, $true)
  }
  Save-Ledger
  $node = (Get-Command node -ErrorAction Stop).Source
  $gh = (Get-Command gh -ErrorAction Stop).Source
  $git = (Get-Command git -ErrorAction Stop).Source
  $scanner = (Get-Command gitleaks -ErrorAction Stop).Source
  $tsx = Join-Path $controllerRoot 'babel-cli/node_modules/tsx/dist/cli.mjs'
  $worker = Join-Path $PSScriptRoot 'host-review-worker.mts'
  if (-not (Test-Path -LiteralPath $tsx)) { throw 'Controller dependencies unavailable; install the verified controller dependencies.' }
  function Read-Pr {
    $value = & $gh pr view $PR --repo $Repository --json number,state,baseRefOid,headRefOid,headRefName,isCrossRepository | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or $value.number -ne $PR -or $value.state -ne 'OPEN' -or $value.isCrossRepository) { throw 'Open same-repository PR unavailable.' }
    return $value
  }
  $prState = Read-Pr
  $head = [string]$prState.headRefOid; $base = [string]$prState.baseRefOid
  $localHead = (& $git -C $resolvedRepo rev-parse HEAD).Trim()
  if ($LASTEXITCODE -ne 0 -or $localHead -cne $head -or $head -notmatch '^[0-9a-f]{40}$' -or $base -notmatch '^[0-9a-f]{40}$') { throw 'Candidate checkout must equal the live PR head.' }
  $slug = & $gh repo view $Repository --json nameWithOwner --jq .nameWithOwner
  if ($LASTEXITCODE -ne 0 -or $slug -cne $Repository) { throw 'Repository identity mismatch.' }
  $remote = (& $git -C $resolvedRepo remote get-url origin).Trim()
  if ($LASTEXITCODE -ne 0 -or $remote -notin @("https://github.com/$Repository.git", "git@github.com:$Repository.git")) { throw 'Candidate remote differs from review repository.' }
  $dirty = @(& $git -C $resolvedRepo status --porcelain=v1 --untracked-files=no)
  if ($LASTEXITCODE -ne 0 -or $dirty.Count -ne 0) { throw 'Commit candidate changes before exact-state review.' }
  & $git -C $resolvedRepo cat-file -e "$base^{commit}" 2>$null
  if ($LASTEXITCODE -ne 0) {
    & $git -C $resolvedRepo fetch --no-tags origin $base 2>$null
    if ($LASTEXITCODE -ne 0) { throw 'Exact base unavailable.' }
  }
  $scope = @(& $git -C $resolvedRepo -c core.quotepath=false diff --no-ext-diff --no-textconv --name-only "$base...$head")
  if ($LASTEXITCODE -ne 0 -or $scope.Count -eq 0 -or @($scope | Where-Object { Test-ExcludedReviewPath $_ }).Count -gt 0) { throw 'Empty diff or excluded secret-risk source.' }
  $numstat = @(& $git -C $resolvedRepo diff --no-ext-diff --no-textconv --numstat "$base...$head")
  if ($LASTEXITCODE -ne 0) { throw 'Exact diff statistics unavailable.' }
  $diff = @(& $git -C $resolvedRepo diff --no-ext-diff --no-textconv --no-color --no-renames "$base...$head") -join [char]10
  if ($LASTEXITCODE -ne 0) { throw 'Exact diff unavailable.' }
  $task = [IO.File]::ReadAllText($resolvedTask)
  $taskHash = ([Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($task)))).ToLowerInvariant()
  if ($null -ne $ledger.PSObject.Properties['repository'] -and $ledger.repository -cne $Repository) { throw 'Budget ledger belongs to another repository.' }
  if ($null -ne $ledger.PSObject.Properties['task_hash'] -and $ledger.task_hash -cne $taskHash) { throw 'Budget ledger belongs to another task; do not reset the existing campaign.' }
  if ($null -eq $ledger.PSObject.Properties['repository']) { $ledger | Add-Member repository $Repository }
  if ($null -eq $ledger.PSObject.Properties['task_hash']) { $ledger | Add-Member task_hash $taskHash }
  Save-Ledger
  $candidate = [ordered]@{ repository = $Repository; pr_number = $PR; base_sha = $base; head_sha = $head; task_id = $taskHash.Substring(0, 16); task_hash = $taskHash; builder_id = $BuilderIdentity; diff_numstat_digest = Get-AgentNumstatDigest $numstat; scope = @($scope) }
  $payload = [ordered]@{ candidate = $candidate; task_text = $task; diff_text = $diff; diff_numstat = @($numstat); scope = @($scope) } | ConvertTo-Json -Depth 15 -Compress
  $payload | & $scanner stdin --redact --no-banner 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Payload secret scan failed; nothing was sent.' }
  if ($ExternalExecutionModule) { Import-Module $ExternalExecutionModule -Force }
  # Checkpoint each completed model independently. A later timeout must not
  # discard its peer's verdict or spend. Only the exact input and fresh round
  # can resume; stale or changed candidates always get new executions.
  $payloadHash = ([Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($payload)))).ToLowerInvariant()
  $round = if ($null -ne $ledger.PSObject.Properties['round']) { $ledger.round } else { $null }
  if ($null -eq $round -or $round.payload_hash -cne $payloadHash -or
      ([DateTimeOffset]::UtcNow - [DateTimeOffset]::Parse($round.started_at)).TotalMinutes -ge 10) {
    $round = [pscustomobject]@{ id = [guid]::NewGuid().ToString(); payload_hash = $payloadHash; started_at = [DateTimeOffset]::UtcNow.ToString('o'); completed = @() }
    if ($null -eq $ledger.PSObject.Properties['round']) { $ledger | Add-Member round $round } else { $ledger.round = $round }
    Save-Ledger
  }
  $roundId = $round.id
  function Assert-ReviewResult($Result, [string]$ExpectedModel) {
    if ($Result.status -cne 'REVIEW_COMPLETED' -or $Result.provider -cne 'opencode-go' -or $Result.observed_model -cne $ExpectedModel -or $Result.handoff.controller_run_id -cne $roundId) { throw 'Review execution provenance mismatch.' }
    foreach ($field in @('repository', 'pr_number', 'base_sha', 'head_sha', 'task_id', 'task_hash')) {
      if ([string]$Result.handoff.$field -cne [string]$candidate[$field]) { throw 'Review handoff candidate mismatch.' }
    }
    if (@($Result.handoff.reviews).Count -ne 1) { throw 'Expected one independently launched model result.' }
    $review = $Result.handoff.reviews[0]
    # Controller-stamped provenance is host-private: the base gate derives
    # provenance from the authenticated comment transport and rejects the field,
    # so strip it before validating or publishing either model's evidence.
    if ($null -ne $review.PSObject.Properties['provenance']) { $review.PSObject.Properties.Remove('provenance') }
    $check = Test-AgentAutonomousReviewEvidence -Evidence $review -Repository $Repository -PR $PR -BaseSha $base -HeadSha $head -BuilderIdentity $BuilderIdentity -ExpectedNumstatDigest $candidate.diff_numstat_digest -TaskId $candidate.task_id -TaskHash $taskHash -ExpectedScope $scope
    # A valid BLOCK is useful evidence too; never convert it to an approval.
    $allowedErrors = if ($review.verdict -ceq 'BLOCK') { @('autonomous_evidence_verdict_mismatch', 'autonomous_evidence_has_blocking_findings') } else { @() }
    if (@($check.errors | Where-Object { $_ -cnotin $allowedErrors }).Count -gt 0 -or
        $review.reviewer_model -cne $ExpectedModel -or $review.review_provider -cne 'opencode-go' -or
        [DateTimeOffset]::Parse($review.reviewed_at) -lt [DateTimeOffset]::Parse($round.started_at).AddSeconds(-1)) { throw ('Review result is malformed, stale, or not bound to this round: ' + ($check.errors -join ',')) }
  }
  $reviews = @()
  foreach ($model in $Models) {
    $cached = @($round.completed | Where-Object { $_.observed_model -ceq $model })
    if (-not $PreflightOnly -and $cached.Count -eq 1) {
      Assert-ReviewResult $cached[0] $model
      $reviews += @($cached[0].handoff.reviews)
      continue
    }
    $prior = [double]$ledger.reserved_usd
    $workerArgs = @($tsx, $worker, "--model=$model", "--budget-usd=$BudgetUsd", "--prior-reserved-usd=$prior", "--controller-run-id=$roundId")
    $preflight = $payload | & $node @workerArgs --preflight=true | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or $preflight.status -ne 'PREFLIGHT_ONLY') { throw 'Worker preflight failed; no paid request.' }
    if ($PreflightOnly) { $preflight | ConvertTo-Json -Compress; continue }
    $reservation = [double]$preflight.reserved_upper_bound_usd
    $ledger.reserved_usd = $prior + $reservation
    $entry = [pscustomobject]@{ model = $model; head_sha = $head; status = 'RESERVED_OR_USAGE_UNKNOWN'; reserved_usd = $reservation }
    $ledger.executions = @($ledger.executions) + $entry
    Save-Ledger
    $resultHolder = @{ result = $null }
    $transport = {
      param($Provider, $Model, $ProtectedPayload)
      if ($Provider -cne 'opencode-go' -or $Model -cne $model -or $ProtectedPayload -cne $payload) { throw 'Source changed during payload protection; exact review cannot be certified.' }
      $response = $ProtectedPayload | & $node @workerArgs
      if ($LASTEXITCODE -ne 0) { throw 'Host review worker failed; reservation retained.' }
      $resultHolder.result = $response | ConvertFrom-Json -Depth 40
    }
    if ($ExternalExecutionModule) {
      $decision = Invoke-AuthorizedExternalExecution -ProviderAuthorized -RequestedProvider opencode-go -ActualProvider opencode-go -RequestedModel $model -ActualModel $model -SpendRemaining 1 -Payload $payload -PayloadProvenance source-derived -SourcePaths (@($scope | ForEach-Object { Join-Path $resolvedRepo $_ }) + @($resolvedTask)) -Transport $transport
      if (-not $decision.transmitted -or $null -eq $resultHolder.result) { throw 'External execution stopped; local repair remains authorized.' }
    } else { & $transport 'opencode-go' $model $payload }
    $result = $resultHolder.result
    Assert-ReviewResult $result $model
    $usageProperty = $result.PSObject.Properties['usage']
    $usage = if ($null -ne $usageProperty) { $usageProperty.Value } else { $null }
    $inputTokens = if ($null -ne $usage -and $null -ne $usage.PSObject.Properties['input_tokens']) { $usage.input_tokens } else { $null }
    $outputTokens = if ($null -ne $usage -and $null -ne $usage.PSObject.Properties['output_tokens']) { $usage.output_tokens } else { $null }
    if ($null -ne $inputTokens -and $null -ne $outputTokens -and $inputTokens -ge 0 -and $outputTokens -ge 0) {
      $observedUpper = Get-HostReviewUsageUpperBound -Model $model -InputTokens ([double]$inputTokens) -OutputTokens ([double]$outputTokens)
      if ($observedUpper -gt $reservation) {
        $ledger | Add-Member accounting_breach $true -Force
        Save-Ledger
        throw 'Provider usage exceeded reserved bound; stop all new paid calls.'
      }
      $ledger.reserved_usd = [double]$ledger.reserved_usd - $reservation + $observedUpper
      $entry.reserved_usd = $observedUpper
      $entry.status = 'OBSERVED_USAGE_UPPER_BOUND'
      Save-Ledger
    }
    $round.completed = @($round.completed) + $result
    Save-Ledger
    $reviews += @($result.handoff.reviews)
  }
  if ($PreflightOnly) { return }
  $fresh = Read-Pr
  if ($fresh.headRefOid -cne $head -or $fresh.baseRefOid -cne $base) { throw 'PR changed during review; recollect exact-state evidence.' }
  $handoff = [ordered]@{ schema_version = 2; kind = 'host_review_handoff_v2'; repository = $Repository; pr_number = $PR; base_sha = $base; head_sha = $head; task_id = $candidate.task_id; task_hash = $taskHash; controller_run_id = $roundId; reviews = @($reviews) }
  $outputPath = Join-Path (Split-Path -Parent $ledgerPath) "pr-$PR-$head-handoff.json"
  $handoff | ConvertTo-Json -Depth 40 | Set-Content -LiteralPath $outputPath -Encoding utf8NoBOM
  if ($Publish) {
    $owner = & $gh api "repos/$Repository" --jq .owner.id
    if ($LASTEXITCODE -ne 0) { throw 'Repository owner unavailable.' }
    $actor = & $gh api user --jq .id
    if ($LASTEXITCODE -ne 0 -or $actor -ne $owner) { throw 'Publication requires the existing owner-host GitHub identity.' }
    $body = '<!-- babel-controller-ai-reviews-v2 -->' + [Environment]::NewLine + ($handoff | ConvertTo-Json -Depth 40 -Compress)
    @{ body = $body } | ConvertTo-Json -Compress | & $gh api --method POST "repos/$Repository/issues/$PR/comments" --input - --jq .html_url
    if ($LASTEXITCODE -ne 0) { throw 'Handoff publication failed; inspect before retrying.' }
  }
  [pscustomobject]@{ status = 'HOST_REVIEW_COMPLETED'; head_sha = $head; evidence = $outputPath; reviews = $reviews.Count; blocking_reviews = @($reviews | Where-Object { $_.verdict -ne 'APPROVE' -or $_.blocking_findings.Count -gt 0 }).Count; campaign_reserved_upper_bound_usd = $ledger.reserved_usd } | ConvertTo-Json
} finally {
  $lock.Dispose()
  # Retain the empty lock inode; a crash cannot leave a held OS lock, and
  # unlinking after close could race a second controller acquiring it.
}
