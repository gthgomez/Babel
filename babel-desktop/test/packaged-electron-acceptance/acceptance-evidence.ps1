# License: Apache-2.0
# A process exit is not acceptance. The receipt must name this source, readiness,
# the read-only no-mutation control, and the independent repair diff.
function Test-PackagedAcceptanceEvidence {
  param(
    [Parameter(Mandatory = $true)][string]$ReportPath,
    [Parameter(Mandatory = $true)][string]$ExpectedSourceSha
  )
  if ($ExpectedSourceSha -notmatch '^[a-f0-9]{40}$') { return $false }
  if (-not (Test-Path -LiteralPath $ReportPath -PathType Leaf)) { return $false }
  try {
    $report = Get-Content -LiteralPath $ReportPath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    $diff = $report.journeys.repair.independent.diff
    return ($report.passed -ge 1) -and
      ($null -eq $report.failure) -and
      ($report.identity.executablePresent -eq $true) -and
      ([string]$report.identity.build.sourceSha -eq $ExpectedSourceSha) -and
      ($report.identity.ipc.engineReadinessReady -eq $true) -and
      ($report.identity.ipc.executionReady -eq $true) -and
      ($report.journeys.readOnlyTask.status -eq 'executed') -and
      ($report.journeys.readOnlyTask.deniedEdit -eq $true) -and
      ($report.journeys.readOnlyTask.baseline.clean -eq $true) -and
      ($report.journeys.repair.status -eq 'executed') -and
      ($report.journeys.repair.independent.testExit -eq 0) -and
      ($diff.path -eq 'parser.mjs') -and
      ($diff.additions -eq 1) -and
      ($diff.deletions -eq 1) -and
      ([string]$report.journeys.cleanup.state -eq 'terminated')
  } catch { return $false }
}
