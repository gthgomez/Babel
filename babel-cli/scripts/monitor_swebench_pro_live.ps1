param(
  [Parameter(Mandatory = $true)][string]$EvidenceDir,
  [int]$GraceMs = 15000
)

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$evidencePath = [IO.Path]::GetFullPath($EvidenceDir)
$pidPath = Join-Path $evidencePath 'process.json'
$heartbeatPath = Join-Path $evidencePath 'heartbeat.json'
$reportPath = Join-Path $evidencePath 'campaign-report.json'
$manifestPath = Join-Path $evidencePath 'campaign-manifest.json'
$reconcilePath = Join-Path $evidencePath 'reconcile-report.json'

$processInfo = if (Test-Path -LiteralPath $pidPath) {
  Get-Content -Raw -LiteralPath $pidPath | ConvertFrom-Json
} else { $null }
$process = if ($processInfo) { Get-Process -Id ([int]$processInfo.pid) -ErrorAction SilentlyContinue } else { $null }
$heartbeat = if (Test-Path -LiteralPath $heartbeatPath) {
  Get-Content -Raw -LiteralPath $heartbeatPath | ConvertFrom-Json
} else { $null }
$report = if (Test-Path -LiteralPath $reportPath) {
  Get-Content -Raw -LiteralPath $reportPath | ConvertFrom-Json
} else { $null }
$manifestPresent = Test-Path -LiteralPath $manifestPath -PathType Leaf

# External reconcile when a frozen manifest exists (idempotent; no kill).
$reconcile = $null
if ($manifestPresent) {
  try {
    $reconScript = Join-Path $scriptDir 'reconcile_swebench_pro.ps1'
    if (Test-Path -LiteralPath $reconScript) {
      & $reconScript -EvidenceDir $evidencePath -GraceMs $GraceMs -Json 2>$null | Out-Null
    }
  } catch {
    # Monitor must still report status even if reconcile fails (e.g. tsx missing).
  }
  if (Test-Path -LiteralPath $reconcilePath -PathType Leaf) {
    try {
      $reconcile = Get-Content -Raw -LiteralPath $reconcilePath | ConvertFrom-Json
    } catch {
      $reconcile = $null
    }
  }
}

$status = if ($report) {
  'complete'
} elseif ($process) {
  'running'
} elseif ($reconcile -and $reconcile.campaign_complete) {
  'reconciled_complete'
} elseif ($processInfo) {
  'exited_without_report'
} else {
  'not_started'
}

[pscustomobject]@{
  evidence_dir = $evidencePath
  pid = if ($processInfo) { [int]$processInfo.pid } else { $null }
  process_alive = [bool]$process
  campaign_report_present = [bool]$report
  campaign_manifest_present = [bool]$manifestPresent
  phase = if ($heartbeat) { $heartbeat.phase } else { 'unknown' }
  current_instance_id = if ($heartbeat) { $heartbeat.current_instance_id } else { $null }
  completed_cells = if ($heartbeat) { $heartbeat.completed_cells } else { 0 }
  total_cells = if ($heartbeat) { $heartbeat.total_cells } else { $null }
  last_progress_at = if ($heartbeat) { $heartbeat.last_progress_at } else { $null }
  last_error_class = if ($heartbeat) { $heartbeat.last_error_class } else { $null }
  stdout_bytes = if (Test-Path -LiteralPath (Join-Path $evidencePath 'campaign.stdout.log')) { (Get-Item (Join-Path $evidencePath 'campaign.stdout.log')).Length } else { 0 }
  stderr_bytes = if (Test-Path -LiteralPath (Join-Path $evidencePath 'campaign.stderr.log')) { (Get-Item (Join-Path $evidencePath 'campaign.stderr.log')).Length } else { 0 }
  status = $status
  reconcile_campaign_complete = if ($reconcile) { [bool]$reconcile.campaign_complete } else { $null }
  reconcile_conservation_ok = if ($reconcile) { [bool]$reconcile.conservation_ok } else { $null }
  reconcile_orphaned_count = if ($reconcile -and $reconcile.orphaned_attempt_ids) { @($reconcile.orphaned_attempt_ids).Count } else { 0 }
  reconcile_by_lifecycle = if ($reconcile) { $reconcile.by_lifecycle } else { $null }
} | ConvertTo-Json -Depth 6
