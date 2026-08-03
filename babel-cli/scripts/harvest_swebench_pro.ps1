<#
.SYNOPSIS
  Max-data harvest for a SWE-Pro evidence directory.

.DESCRIPTION
  Inventories required artifacts and writes harvest-summary.md + harvest-summary.json.
  Does not print secrets or full provider payloads.
#>
param(
  [Parameter(Mandatory = $true)][string]$EvidenceDir
)

$ErrorActionPreference = 'Stop'
$evidencePath = [IO.Path]::GetFullPath($EvidenceDir)
if (-not (Test-Path -LiteralPath $evidencePath -PathType Container)) {
  throw "Evidence dir not found: $evidencePath"
}

function Count-Files([string]$Sub) {
  $p = Join-Path $evidencePath $Sub
  if (-not (Test-Path -LiteralPath $p)) { return 0 }
  return @(Get-ChildItem -LiteralPath $p -File -ErrorAction SilentlyContinue).Count
}

function Read-JsonOrNull([string]$Rel) {
  $p = Join-Path $evidencePath $Rel
  if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { return $null }
  try {
    return Get-Content -Raw -LiteralPath $p | ConvertFrom-Json
  } catch {
    return $null
  }
}

# External reconcile before harvest so orphaned attempts are materialized.
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$reconScript = Join-Path $scriptDir 'reconcile_swebench_pro.ps1'
if ((Test-Path -LiteralPath (Join-Path $evidencePath 'campaign-manifest.json')) -and (Test-Path -LiteralPath $reconScript)) {
  try {
    & $reconScript -EvidenceDir $evidencePath -Json 2>$null | Out-Null
  } catch {
    # Continue harvest even if reconcile tooling is unavailable.
  }
}

$report = Read-JsonOrNull 'campaign-report.json'
$heartbeat = Read-JsonOrNull 'heartbeat.json'
$processInfo = Read-JsonOrNull 'process.json'
$profile = Read-JsonOrNull 'profile.json'
$preflight = Read-JsonOrNull 'preflight-receipt.json'
$manifest = Read-JsonOrNull 'campaign-manifest.json'
$reconcile = Read-JsonOrNull 'reconcile-report.json'
$derived = Read-JsonOrNull 'campaign-derived.json'

$infraCount = Count-Files 'infra'
$liveCount = Count-Files 'live'
$policyPath = Join-Path $evidencePath 'policy-events.jsonl'
$policyBytes = if (Test-Path -LiteralPath $policyPath) { (Get-Item -LiteralPath $policyPath).Length } else { 0 }

$cells = @()
if ($report -and $report.cells) {
  foreach ($c in $report.cells) {
    $cells += [ordered]@{
      instance_id = $c.instance_id
      phase = $c.phase
      status = $c.status
      signature = $c.signature
      gold_diff_ok = $c.gold_diff_ok
      fail_to_pass_ok = $c.fail_to_pass_ok
      fail_to_pass_class = $c.fail_to_pass_class
      patch_bytes = $c.patch_bytes
      notes_preview = if ($c.notes) { @($c.notes | Select-Object -First 12) } else { @() }
    }
  }
}

$histogram = @{}
foreach ($c in $cells) {
  $key = if ($c.signature) { [string]$c.signature } else { [string]$c.status }
  if (-not $histogram.ContainsKey($key)) { $histogram[$key] = 0 }
  $histogram[$key] = $histogram[$key] + 1
}

$pack = [ordered]@{
  campaign_report = [bool]$report
  campaign_manifest = [bool]$manifest
  reconcile_report = [bool]$reconcile
  heartbeat = [bool]$heartbeat
  process = [bool]$processInfo
  profile = [bool]$profile
  preflight_receipt = [bool]$preflight
  policy_events_jsonl = $policyBytes -gt 0
  infra_cell_files = $infraCount
  live_cell_files = $liveCount
  dual_scoreboard_fields = $cells | Where-Object { $null -ne $_.gold_diff_ok -or $null -ne $_.fail_to_pass_ok } | Measure-Object | Select-Object -ExpandProperty Count
  causal_stage1_complete_design = if ($manifest) { $manifest.causal_stage1_complete_design } else { $null }
  campaign_derived = [bool]$derived
  reconcile_campaign_complete = if ($reconcile) { $reconcile.campaign_complete } else { $null }
  reconcile_conservation_ok = if ($reconcile) { $reconcile.conservation_ok } else { $null }
  reconcile_by_lifecycle = if ($reconcile) { $reconcile.by_lifecycle } else { $null }
  expected_attempts = if ($manifest -and $manifest.expected_attempts) { @($manifest.expected_attempts).Count } else { $null }
  # Slice 3: prefer validator-derived eligibility over raw writer booleans
  derived_artifact_valid = if ($derived -and $derived.eligibility) { $derived.eligibility.artifact_valid } else { $null }
  derived_campaign_complete = if ($derived -and $derived.eligibility) { $derived.eligibility.campaign_complete } else { $null }
  derived_reliability_eligible = if ($derived -and $derived.eligibility) { $derived.eligibility.reliability_eligible } else { $null }
  derived_promotion_eligible = if ($derived -and $derived.eligibility) { $derived.eligibility.promotion_eligible } else { $null }
  derived_capability_score_valid = if ($derived -and $derived.eligibility) { $derived.eligibility.capability_score_valid } else { $null }
  itt_capability = if ($derived -and $derived.intent_to_treat_capability) {
    "$($derived.intent_to_treat_capability.numerator)/$($derived.intent_to_treat_capability.denominator)"
  } else { $null }
  cond_capability = if ($derived -and $derived.conditional_capability) {
    "$($derived.conditional_capability.numerator)/$($derived.conditional_capability.denominator)"
  } else { $null }
  exclusion_counts = if ($derived) { $derived.exclusion_counts } else { $null }
  scorer_version = if ($derived) { $derived.scorer_version } else { $null }
}

$missing = @()
if (-not $pack.campaign_report) { $missing += 'campaign-report.json' }
if (-not $pack.heartbeat) { $missing += 'heartbeat.json' }
if (-not $pack.process) { $missing += 'process.json' }
if (-not $pack.policy_events_jsonl) { $missing += 'policy-events.jsonl' }

$status = if ($report) {
  'complete'
} elseif ($processInfo) {
  $proc = $null
  try { $proc = Get-Process -Id ([int]$processInfo.pid) -ErrorAction SilentlyContinue } catch { $proc = $null }
  if ($proc) { 'running' } else { 'exited_without_report' }
} else {
  'not_started'
}

$summary = [ordered]@{
  schema_version = 1
  kind = 'babel_swe_pro_harvest'
  harvested_at = (Get-Date).ToUniversalTime().ToString('o')
  evidence_dir = $evidencePath
  status = $status
  profile = if ($profile) { $profile.profile } elseif ($processInfo -and $processInfo.profile) { $processInfo.profile } else { $null }
  campaign_id = if ($report) { $report.campaign_id } elseif ($heartbeat) { $heartbeat.campaign_id } else { $null }
  pack = $pack
  missing_required = @($missing)
  signature_histogram = $histogram
  cells = $cells
  monitor = [ordered]@{
    phase = if ($heartbeat) { $heartbeat.phase } else { $null }
    completed_cells = if ($heartbeat) { $heartbeat.completed_cells } else { $null }
    total_cells = if ($heartbeat) { $heartbeat.total_cells } else { $null }
    last_error_class = if ($heartbeat) { $heartbeat.last_error_class } else { $null }
  }
  triage_hints = @(
    'ENV/dep/python signatures → environment, not model',
    'agent:harness_timeout → cell budget, not capability score',
    'BLOCKED_* with patch_bytes=0 → arbitration/honesty, not solve',
    'false complete → harness bug (highest severity)'
  )
}

$jsonPath = Join-Path $evidencePath 'harvest-summary.json'
$mdPath = Join-Path $evidencePath 'harvest-summary.md'
($summary | ConvertTo-Json -Depth 8) | Set-Content -LiteralPath $jsonPath -Encoding UTF8

$md = @()
$md += "# SWE-Pro harvest summary"
$md += ""
$md += "- **Status:** $status"
$md += "- **Evidence:** ``$evidencePath``"
$md += "- **Profile:** $($summary.profile)"
$md += "- **Campaign id:** $($summary.campaign_id)"
$md += "- **Harvested at:** $($summary.harvested_at)"
$md += ""
$md += "## Pack completeness"
$md += ""
$md += "| Artifact | Present |"
$md += "|----------|---------|"
$md += "| campaign-report.json | $($pack.campaign_report) |"
$md += "| heartbeat.json | $($pack.heartbeat) |"
$md += "| process.json | $($pack.process) |"
$md += "| profile.json | $($pack.profile) |"
$md += "| preflight-receipt.json | $($pack.preflight_receipt) |"
$md += "| policy-events.jsonl | $($pack.policy_events_jsonl) |"
$md += "| infra cell files | $($pack.infra_cell_files) |"
$md += "| live cell files | $($pack.live_cell_files) |"
$md += "| campaign-manifest.json | $($pack.campaign_manifest) |"
$md += "| campaign-derived.json | $($pack.campaign_derived) |"
$md += ""
$md += "## Derived eligibility (validator — not writer pass_mode)"
$md += ""
$md += "- **scorer_version:** $($pack.scorer_version)"
$md += "- **artifact_valid:** $($pack.derived_artifact_valid)"
$md += "- **campaign_complete:** $($pack.derived_campaign_complete)"
$md += "- **reliability_eligible:** $($pack.derived_reliability_eligible)"
$md += "- **promotion_eligible:** $($pack.derived_promotion_eligible)"
$md += "- **capability_score_valid:** $($pack.derived_capability_score_valid)"
$md += "- **ITT capability:** $($pack.itt_capability)"
$md += "- **Conditional capability:** $($pack.cond_capability)"
$md += ""
if ($missing.Count -gt 0) {
  $md += "## Missing required"
  $md += ""
  foreach ($m in $missing) { $md += "- $m" }
  $md += ""
}
$md += "## Signature histogram"
$md += ""
if ($histogram.Count -eq 0) {
  $md += "_No cells in report yet._"
  $md += ""
} else {
  foreach ($k in ($histogram.Keys | Sort-Object)) {
    $md += "- ``$k``: $($histogram[$k])"
  }
  $md += ""
}
$md += "## Cells"
$md += ""
if ($cells.Count -eq 0) {
  $md += "_None._"
} else {
  $md += "| instance | phase | status | signature | gold | ftp | ftp_class | patch_bytes |"
  $md += "|----------|-------|--------|-----------|------|-----|-----------|-------------|"
  foreach ($c in $cells) {
    $md += "| $($c.instance_id) | $($c.phase) | $($c.status) | $($c.signature) | $($c.gold_diff_ok) | $($c.fail_to_pass_ok) | $($c.fail_to_pass_class) | $($c.patch_bytes) |"
  }
}
$md += ""
$md += "## Triage hints"
$md += ""
foreach ($h in $summary.triage_hints) { $md += "- $h" }
$md += ""

$md -join "`n" | Set-Content -LiteralPath $mdPath -Encoding UTF8

Write-Output "harvest status=$status summary=$mdPath"
Write-Output "json=$jsonPath"
if ($missing.Count -gt 0) {
  Write-Output ("missing: " + ($missing -join ', '))
  if ($status -ne 'running') { exit 2 }
}
exit 0
