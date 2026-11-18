# License: Apache-2.0
# Missing, malformed or incomplete receipts never authorize uninstall.
function Get-PackagedCleanupState {
  param([Parameter(Mandatory = $true)][string]$ReportPath)
  try {
    if (-not (Test-Path -LiteralPath $ReportPath -PathType Leaf)) { return 'unknown' }
    $report = Get-Content -LiteralPath $ReportPath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    $state = [string]$report.journeys.cleanup.state
    if ($state -eq 'terminated') { return 'terminated' }
    if ($state -eq 'unresolved') { return 'unresolved' }
    return 'unknown'
  } catch { return 'unknown' }
}

function Test-PackagedCleanupAllowed {
  param([bool]$GuiAttempted, [Parameter(Mandatory = $true)][string]$ReportPath)
  if (-not $GuiAttempted) { return $true }
  return (Get-PackagedCleanupState -ReportPath $ReportPath) -eq 'terminated'
}
