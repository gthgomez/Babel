[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][int]$PR,
  [Parameter(Mandatory = $true)][string]$ReviewedHeadSha,
  [Parameter(Mandatory = $true)][string]$RepoRoot,
  [string]$BaseSha = '',
  [string]$MergeMethod = 'squash',
  [string]$RiskTier = 'GREEN',
  [string]$AutonomousReviewEvidencePath = '',
  [string]$BuilderIdentity = '',
  [ValidateRange(0, 1800)][int]$CheckWaitSeconds = 0
)

# Bounded exact-head merge executor. It never decides merge readiness itself:
# the base-rooted trusted gate is the sole authority. This wrapper only performs
# the merge when the gate certifies the exact reviewed head and the live PR state
# still agrees, binding the merge with --match-head-commit. Every deviation fails
# closed with a BLOCKED JSON result and a non-zero exit; a failed merge is never
# retried with a different SHA.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ghCommand = (Get-Command gh -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source

function Get-BabelJsonProperty {
  param([AllowNull()][object]$Object, [Parameter(Mandatory = $true)][string]$Name)
  if ($null -eq $Object) { return $null }
  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property) { return $null }
  return $property.Value
}

# Return the text of the last complete top-level JSON object in $Text, so a gate
# that emits progress lines before its result is still parsed correctly.
function Get-BabelLastJsonObject {
  param([AllowNull()][string]$Text)
  if ([string]::IsNullOrWhiteSpace($Text)) { return $null }
  $depth = 0
  $start = -1
  $inString = $false
  $escaped = $false
  $last = $null
  for ($index = 0; $index -lt $Text.Length; $index++) {
    $character = $Text[$index]
    if ($inString) {
      if ($escaped) { $escaped = $false }
      elseif ($character -eq '\') { $escaped = $true }
      elseif ($character -eq '"') { $inString = $false }
      continue
    }
    if ($character -eq '"') { $inString = $true; continue }
    if ($character -eq '{') {
      if ($depth -eq 0) { $start = $index }
      $depth++
    } elseif ($character -eq '}') {
      if ($depth -gt 0) {
        $depth--
        if ($depth -eq 0 -and $start -ge 0) {
          $candidate = $Text.Substring($start, $index - $start + 1)
          try { $null = $candidate | ConvertFrom-Json -ErrorAction Stop; $last = $candidate } catch { # incomplete JSON fragment: keep scanning for the next balanced object
          }
          $start = -1
        }
      }
    }
  }
  return $last
}

function Get-BabelLastExitCode {
  $variable = Get-Variable -Name LASTEXITCODE -Scope Global -ErrorAction SilentlyContinue
  if ($null -eq $variable) { return 0 }
  return [int]$variable.Value
}

# Read the live strict-freshness flag from GitHub at merge time. The gate's
# snapshot proves what the gate evaluated; only the live value may decide
# whether a stale base is tolerated at the moment of merge. Any ambiguity
# (unreadable ruleset, missing or duplicate protect-main, missing flag) fails
# closed to strict, which can only block a merge, never wrongly allow one.
function Get-BabelStrictFreshness {
  param([Parameter(Mandatory = $true)][string]$Repository)
  $listExit = 0
  $listText = ''
  try {
    $listCaptured = & $ghCommand api "repos/$Repository/rulesets?per_page=100" 2>&1
    $listExit = Get-BabelLastExitCode
    $listText = (@($listCaptured) | ForEach-Object { [string]$_ }) -join "`n"
  } catch { return $true }
  if ($listExit -ne 0) { return $true }
  $list = $null
  try { $list = $listText | ConvertFrom-Json -ErrorAction Stop } catch { return $true }
  $candidates = @(@($list) | Where-Object { [string](Get-BabelJsonProperty -Object $_ -Name 'name') -eq 'protect-main' -and [string](Get-BabelJsonProperty -Object $_ -Name 'enforcement') -eq 'active' })
  if ($candidates.Count -ne 1) { return $true }
  $rulesetId = [string](Get-BabelJsonProperty -Object $candidates[0] -Name 'id')
  if ([string]::IsNullOrWhiteSpace($rulesetId)) { return $true }
  $detailExit = 0
  $detailText = ''
  try {
    $detailCaptured = & $ghCommand api "repos/$Repository/rulesets/$rulesetId" 2>&1
    $detailExit = Get-BabelLastExitCode
    $detailText = (@($detailCaptured) | ForEach-Object { [string]$_ }) -join "`n"
  } catch { return $true }
  if ($detailExit -ne 0) { return $true }
  $detail = $null
  try { $detail = $detailText | ConvertFrom-Json -ErrorAction Stop } catch { return $true }
  $allRules = @((Get-BabelJsonProperty -Object $detail -Name 'rules') | ForEach-Object { $_ })
  $statusRules = @($allRules | Where-Object { [string](Get-BabelJsonProperty -Object $_ -Name 'type') -eq 'required_status_checks' })
  if ($statusRules.Count -ne 1) { return $true }
  $parameters = Get-BabelJsonProperty -Object $statusRules[0] -Name 'parameters'
  $strictValue = Get-BabelJsonProperty -Object $parameters -Name 'strict_required_status_checks_policy'
  if ($null -eq $strictValue) { return $true }
  return [bool]$strictValue
}

function Write-BabelBlocked {
  param([Parameter(Mandatory = $true)][AllowEmptyCollection()][string[]]$Blockers)
  $unique = @($Blockers | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique)
  $payload = [ordered]@{ status = 'BLOCKED'; blockers = @($unique) }
  Write-Output ($payload | ConvertTo-Json -Compress -Depth 6)
  exit 1
}

function Get-BabelLiveTarget {
  # Resolve only the authenticated target repository/ref; never a candidate SHA.
  $captured = & $ghCommand api 'repos/gthgomez/Babel/git/ref/heads/main' 2>&1
  if ((Get-BabelLastExitCode) -ne 0) { Write-BabelBlocked @('base_source_unavailable') }
  $json = Get-BabelLastJsonObject -Text ((@($captured) | ForEach-Object { [string]$_ }) -join "`n")
  $target = $null
  try { $target = $json | ConvertFrom-Json -ErrorAction Stop } catch { Write-BabelBlocked @('base_source_unavailable') }
  $object = Get-BabelJsonProperty -Object $target -Name 'object'
  $sha = Get-BabelJsonProperty -Object $object -Name 'sha'
  if ((Get-BabelJsonProperty -Object $target -Name 'ref') -cne 'refs/heads/main' -or
      (Get-BabelJsonProperty -Object $target -Name 'url') -cne 'https://api.github.com/repos/gthgomez/Babel/git/refs/heads/main' -or
      (Get-BabelJsonProperty -Object $object -Name 'type') -cne 'commit' -or
      $sha -isnot [string] -or $sha -cnotmatch '^[a-f0-9]{40}$') { Write-BabelBlocked @('base_source_unavailable') }
  return $sha
}

$priorNoReplaceObjects = [Environment]::GetEnvironmentVariable('GIT_NO_REPLACE_OBJECTS', 'Process')
try {
  # The base launcher uses git show internally. Keep local replace refs out of
  # every nested Git invocation, including previously trusted base scripts.
  $env:GIT_NO_REPLACE_OBJECTS = '1'
  if ($MergeMethod -notin @('merge', 'squash', 'rebase')) { Write-BabelBlocked @('merge_method_invalid') }
  if ($ReviewedHeadSha -notmatch '^[0-9a-fA-F]{40}$') { Write-BabelBlocked @('reviewed_head_sha_invalid') }

  $resolvedRepo = $null
  try { $resolvedRepo = (Resolve-Path -LiteralPath $RepoRoot -ErrorAction Stop).Path } catch { Write-BabelBlocked @('repo_root_invalid') }

  # R is recorded provenance; B is the authenticated target; P is frozen to B.
  # A caller-selected candidate SHA can never select the evaluator source.
  if (-not [string]::IsNullOrWhiteSpace($BaseSha) -and $BaseSha -notmatch '^[0-9a-fA-F]{40}$') { Write-BabelBlocked @('merge_base_sha_invalid') }
  $resolvedBaseSha = ''
    $baseViewText = ''
    $baseViewExit = 0
    try {
      $baseViewCaptured = & $ghCommand pr view ([string]$PR) --repo 'gthgomez/Babel' --json 'baseRefOid,baseRefName' 2>&1
      $baseViewExit = Get-BabelLastExitCode
      $baseViewText = (@($baseViewCaptured) | ForEach-Object { [string]$_ }) -join "`n"
    } catch {
      Write-BabelBlocked @('merge_base_sha_unavailable')
    }
    if ($baseViewExit -ne 0) { Write-BabelBlocked @('merge_base_sha_unavailable') }
    $baseViewJsonText = Get-BabelLastJsonObject -Text $baseViewText
    if ([string]::IsNullOrWhiteSpace($baseViewJsonText)) { Write-BabelBlocked @('merge_base_sha_unavailable') }
    $baseView = $null
    try { $baseView = $baseViewJsonText | ConvertFrom-Json -ErrorAction Stop } catch { Write-BabelBlocked @('merge_base_sha_unavailable') }
    $recordedBaseSha = [string](Get-BabelJsonProperty -Object $baseView -Name 'baseRefOid')
    if ($recordedBaseSha -notmatch '^[0-9a-fA-F]{40}$') { Write-BabelBlocked @('merge_base_sha_unavailable') }
    if ((Get-BabelJsonProperty -Object $baseView -Name 'baseRefName') -cne 'main') { Write-BabelBlocked @('unexpected_pr_base_branch') }
  $resolvedBaseSha = Get-BabelLiveTarget
  if (-not [string]::IsNullOrWhiteSpace($BaseSha) -and -not [string]::Equals($BaseSha, $resolvedBaseSha, [StringComparison]::OrdinalIgnoreCase)) { Write-BabelBlocked @('merge_base_sha_mismatch') }

  # The launcher itself must come from the authenticated trusted target. Never run
  # a candidate checkout's launcher or a caller-selected script.
  $gitPath = (Get-Command git -ErrorAction Stop).Source
  $trustedLauncher = Join-Path ([IO.Path]::GetTempPath()) ('babel-merge-launcher-' + [guid]::NewGuid().ToString('N') + '.ps1')
  try {
    $baseType = & $gitPath -C $resolvedRepo --no-replace-objects cat-file -t $resolvedBaseSha 2>$null
    if ($LASTEXITCODE -ne 0 -or [string]($baseType -join "`n").Trim() -cne 'commit') {
      & $gitPath -C $resolvedRepo fetch --no-tags origin $resolvedBaseSha 2>$null | Out-Null
      if ($LASTEXITCODE -ne 0) { Write-BabelBlocked @('trusted_merge_base_unavailable') }
      $baseType = & $gitPath -C $resolvedRepo --no-replace-objects cat-file -t $resolvedBaseSha 2>$null
      if ($LASTEXITCODE -ne 0 -or [string]($baseType -join "`n").Trim() -cne 'commit') { Write-BabelBlocked @('trusted_merge_base_unavailable') }
    }
    $launcherContent = & $gitPath -C $resolvedRepo --no-replace-objects show ("{0}:scripts/trusted-merge-gate.ps1" -f $resolvedBaseSha) 2>$null
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace(($launcherContent -join "`n"))) { Write-BabelBlocked @('trusted_merge_launcher_unavailable') }
    Set-Content -LiteralPath $trustedLauncher -Value ($launcherContent -join "`n") -Encoding utf8NoBOM
  } catch { Write-BabelBlocked @('trusted_merge_launcher_unavailable') }

  $gateParameters = @{
    PR                          = [int]$PR
    BaseSha                     = $resolvedBaseSha
    RepoRoot                    = $resolvedRepo
    ReviewedHeadSha             = $ReviewedHeadSha
    RiskTier                    = $RiskTier
    AutonomousReviewEvidencePath = $AutonomousReviewEvidencePath
    BuilderIdentity             = $BuilderIdentity
    OutputFormat                = 'json'
  }
  # Zero preserves the legacy immutable launcher's documented default. A
  # requested nonzero wait must be supported by that trusted base or fail closed.
  if ($CheckWaitSeconds -ne 0) { $gateParameters.CheckWaitSeconds = $CheckWaitSeconds }
  $gateOutput = ''
  $gateExit = 0
  try {
    $captured = & $trustedLauncher @gateParameters 2>&1
    $gateExit = Get-BabelLastExitCode
    $gateOutput = (@($captured) | ForEach-Object { [string]$_ }) -join "`n"
  } catch {
    Write-BabelBlocked @('merge_gate_invocation_failed')
  }

  $gateJsonText = Get-BabelLastJsonObject -Text $gateOutput
  if ([string]::IsNullOrWhiteSpace($gateJsonText)) { Write-BabelBlocked @('merge_gate_output_unreadable') }
  $gate = $null
  try { $gate = $gateJsonText | ConvertFrom-Json -ErrorAction Stop } catch { Write-BabelBlocked @('merge_gate_output_unreadable') }
  if ($null -eq $gate) { Write-BabelBlocked @('merge_gate_output_unreadable') }

  $gateStatus = [string](Get-BabelJsonProperty -Object $gate -Name 'status')
  $gateMergeReady = Get-BabelJsonProperty -Object $gate -Name 'mergeReady'
  $sha = Get-BabelJsonProperty -Object $gate -Name 'sha'
  $gateBlockers = @()
  if ($gateExit -ne 0) { $gateBlockers += 'merge_gate_failed' }
  if ($gateStatus -ne 'MERGE_READY') { $gateBlockers += 'merge_gate_not_ready' }
  if ($gateMergeReady -ne $true) { $gateBlockers += 'merge_gate_not_ready' }
  if (-not [string]::Equals([string](Get-BabelJsonProperty -Object $gate -Name 'repository'), 'gthgomez/Babel', [StringComparison]::OrdinalIgnoreCase)) { $gateBlockers += 'merge_gate_repository_mismatch' }
  $gatePr = Get-BabelJsonProperty -Object $gate -Name 'pr'
  if ([string](Get-BabelJsonProperty -Object $gatePr -Name 'number') -ne [string]$PR) { $gateBlockers += 'merge_gate_pr_mismatch' }
  # Strict freshness is read live, not from the gate's snapshot: a ruleset
  # flip between gate run and merge must be honored at the moment of merge.
  # The gate's own repositoryPolicy remains in the evidence JSON for audit.
  $strictFreshness = Get-BabelStrictFreshness -Repository 'gthgomez/Babel'
  if (-not [string]::Equals([string](Get-BabelJsonProperty -Object $sha -Name 'baseHead'), $recordedBaseSha, [StringComparison]::OrdinalIgnoreCase)) { $gateBlockers += 'merge_gate_base_mismatch' }
  foreach ($binding in @('liveTargetHead', 'fetchedTargetHead', 'trustedPolicySha')) {
    if ([string](Get-BabelJsonProperty -Object $sha -Name $binding) -cne $resolvedBaseSha) { $gateBlockers += 'merge_gate_base_mismatch' }
  }
  $gatePolicy = Get-BabelJsonProperty -Object $gate -Name 'repositoryPolicy'
  if ($strictFreshness -and (Get-BabelJsonProperty -Object $gatePolicy -Name 'strictRequiredStatusChecksPolicy') -ne $true) { $gateBlockers += 'merge_gate_freshness_policy_changed' }
  foreach ($gateSha in @(
      (Get-BabelJsonProperty -Object $sha -Name 'reviewedHead'),
      (Get-BabelJsonProperty -Object $sha -Name 'prHead'),
      (Get-BabelJsonProperty -Object $sha -Name 'remoteHead'),
      (Get-BabelJsonProperty -Object $sha -Name 'ciHead')
    )) {
    if (-not [string]::Equals([string]$gateSha, [string]$ReviewedHeadSha, [StringComparison]::OrdinalIgnoreCase)) {
      $gateBlockers += 'merge_gate_sha_mismatch'
      break
    }
  }
  if ($gateBlockers.Count -gt 0) { Write-BabelBlocked @($gateBlockers | Select-Object -Unique) }

  # Re-read live state so a PR that changed after the gate ran can never be
  # merged on the strength of stale certification.
  $viewExit = 0
  $viewText = ''
  try {
    $viewCaptured = & $ghCommand pr view ([string]$PR) --repo 'gthgomez/Babel' --json 'state,headRefOid,baseRefOid,baseRefName,isDraft,mergeable,mergeStateStatus' 2>&1
    $viewExit = Get-BabelLastExitCode
    $viewText = (@($viewCaptured) | ForEach-Object { [string]$_ }) -join "`n"
  } catch {
    Write-BabelBlocked @('pr_view_failed')
  }
  if ($viewExit -ne 0) { Write-BabelBlocked @('pr_view_failed') }
  $viewJsonText = Get-BabelLastJsonObject -Text $viewText
  if ([string]::IsNullOrWhiteSpace($viewJsonText)) { Write-BabelBlocked @('pr_view_unreadable') }
  $view = $null
  try { $view = $viewJsonText | ConvertFrom-Json -ErrorAction Stop } catch { Write-BabelBlocked @('pr_view_unreadable') }
  $viewBlockers = @()
  $liveHead = [string](Get-BabelJsonProperty -Object $view -Name 'headRefOid')
  $liveState = [string](Get-BabelJsonProperty -Object $view -Name 'state')
  $isDraft = Get-BabelJsonProperty -Object $view -Name 'isDraft'
  $mergeable = [string](Get-BabelJsonProperty -Object $view -Name 'mergeable')
  $mergeState = [string](Get-BabelJsonProperty -Object $view -Name 'mergeStateStatus')
  if ($liveState -ne 'OPEN') { $viewBlockers += 'pr_not_open' }
  if (-not [string]::Equals($liveHead, [string]$ReviewedHeadSha, [StringComparison]::OrdinalIgnoreCase)) { $viewBlockers += 'pr_head_mismatch' }
  if (-not [string]::Equals([string](Get-BabelJsonProperty -Object $view -Name 'baseRefOid'), $recordedBaseSha, [StringComparison]::OrdinalIgnoreCase)) { $viewBlockers += 'pr_base_mismatch' }
  if ((Get-BabelJsonProperty -Object $view -Name 'baseRefName') -cne 'main') { $viewBlockers += 'unexpected_pr_base_branch' }
  if ($isDraft -ne $false) { $viewBlockers += 'pr_is_draft' }
  if ($mergeable -ne 'MERGEABLE') { $viewBlockers += 'pr_not_mergeable' }
  if ($mergeState -ne 'CLEAN') { $viewBlockers += 'pr_merge_state_not_clean' }
  if ($viewBlockers.Count -gt 0) { Write-BabelBlocked @($viewBlockers | Select-Object -Unique) }
  # Requalify any target movement, including nonstrict/disjoint merges. GitHub
  # provides a head CAS but no target CAS here: a residual race remains between
  # this final authenticated read and the merge request; post-merge CI is required.
  if ((Get-BabelLiveTarget) -cne $resolvedBaseSha) { Write-BabelBlocked @('live_target_changed') }

  $mergeExit = 0
  try {
    & $ghCommand pr merge ([string]$PR) --repo 'gthgomez/Babel' --match-head-commit $ReviewedHeadSha "--$MergeMethod" | Out-Null
    $mergeExit = Get-BabelLastExitCode
  } catch {
    Write-BabelBlocked @('merge_failed')
  }
  if ($mergeExit -ne 0) { Write-BabelBlocked @('merge_failed') }

  $result = [ordered]@{ status = 'MERGED'; pr = [int]$PR; head_sha = $ReviewedHeadSha }
  Write-Output ($result | ConvertTo-Json -Compress -Depth 6)
  exit 0
} catch {
  Write-BabelBlocked @('merge_executor_exception')
} finally {
  [Environment]::SetEnvironmentVariable('GIT_NO_REPLACE_OBJECTS', $priorNoReplaceObjects, 'Process')
  if ($null -ne (Get-Variable -Name trustedLauncher -ErrorAction SilentlyContinue)) {
    # Cleanup cannot replace the already determined merge result or encourage
    # a duplicate merge. Keep the failure visible without changing permissions.
    try {
      Remove-Item -LiteralPath $trustedLauncher -Force -ErrorAction Stop
    } catch {
      Write-Warning 'merge_executor_cleanup_failed: temporary trusted launcher could not be removed; merge outcome is unchanged.' -WarningAction Continue
    }
  }
}
