param(
  [Parameter(Mandatory = $true)][string]$EvidenceDir
)

$ErrorActionPreference = 'Stop'
$evidencePath = [IO.Path]::GetFullPath($EvidenceDir)
$pidPath = Join-Path $evidencePath 'process.json'
$heartbeatPath = Join-Path $evidencePath 'heartbeat.json'
$reportPath = Join-Path $evidencePath 'campaign-report.json'

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

[pscustomobject]@{
  evidence_dir = $evidencePath
  pid = if ($processInfo) { [int]$processInfo.pid } else { $null }
  process_alive = [bool]$process
  campaign_report_present = [bool]$report
  phase = if ($heartbeat) { $heartbeat.phase } else { 'unknown' }
  current_instance_id = if ($heartbeat) { $heartbeat.current_instance_id } else { $null }
  completed_cells = if ($heartbeat) { $heartbeat.completed_cells } else { 0 }
  total_cells = if ($heartbeat) { $heartbeat.total_cells } else { $null }
  last_progress_at = if ($heartbeat) { $heartbeat.last_progress_at } else { $null }
  last_error_class = if ($heartbeat) { $heartbeat.last_error_class } else { $null }
  stdout_bytes = if (Test-Path -LiteralPath (Join-Path $evidencePath 'campaign.stdout.log')) { (Get-Item (Join-Path $evidencePath 'campaign.stdout.log')).Length } else { 0 }
  stderr_bytes = if (Test-Path -LiteralPath (Join-Path $evidencePath 'campaign.stderr.log')) { (Get-Item (Join-Path $evidencePath 'campaign.stderr.log')).Length } else { 0 }
  status = if ($report) { 'complete' } elseif ($process) { 'running' } elseif ($processInfo) { 'exited_without_report' } else { 'not_started' }
} | ConvertTo-Json -Depth 4
