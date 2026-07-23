param(
  [string]$EvidenceDir = "C:\Workspace\Babel\runs\agent-benchmark-live-deepseek-v6",
  [int]$IntervalMinutes = 15,
  [int]$BenchmarkPid = 0
)

$logPath = Join-Path $EvidenceDir "monitor.log"
$ErrorActionPreference = "Continue"

function Write-MonitorLog([string]$Message) {
  $line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $Message"
  Add-Content -Path $logPath -Value $line
  Write-Output $line
}

function Get-BenchmarkSnapshot {
  $babel = @(Get-ChildItem $EvidenceDir -Filter "*-babel.json" -ErrorAction SilentlyContinue)
  $harness = @(Get-ChildItem $EvidenceDir -Filter "*-harness.json" -ErrorAction SilentlyContinue)
  $report = Get-ChildItem $EvidenceDir -Filter "agent-benchmark-report-*.json" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  $latest = Get-ChildItem $EvidenceDir -Filter "*.json" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  $workspace = Get-ChildItem (Join-Path $EvidenceDir "workspaces") -Directory -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1

  $errors = @()
  foreach ($file in ($babel + $harness)) {
    try {
      $raw = Get-Content $file.FullName -Raw
      if ($raw -match 'Maximum call stack size exceeded') { $errors += "$($file.Name): stack_overflow" }
      if ($raw -match 'HTTP 402|positive balance') { $errors += "$($file.Name): billing_402" }
      if ($raw -match '"cli_exit_code":\s*[^0]') {
        $j = $raw | ConvertFrom-Json
        if ($null -ne $j.cli_exit_code -and $j.cli_exit_code -ne 0) {
          $errors += "$($file.Name): exit_code=$($j.cli_exit_code)"
        }
      }
    } catch {
      $errors += "$($file.Name): parse_error"
    }
  }

  $runner = $null
  if ($BenchmarkPid -gt 0) {
    $runner = Get-Process -Id $BenchmarkPid -ErrorAction SilentlyContinue
  }
  if (-not $runner) {
    $runner = Get-CimInstance Win32_Process |
      Where-Object { $_.CommandLine -match 'run_agent_benchmark\.ts' } |
      Select-Object -First 1
  }

  $babelProc = Get-CimInstance Win32_Process |
    Where-Object { $_.CommandLine -match 'dist\\index\.js run --mode chat' -and $_.CommandLine -match 'agent-benchmark-live-deepseek-v6|benchmark-live-deepseek' } |
    Select-Object -First 1

  [PSCustomObject]@{
    CompletedTasks = $babel.Count + $harness.Count
    LatestFile     = if ($latest) { $latest.Name } else { 'none' }
    LatestAt       = if ($latest) { $latest.LastWriteTime.ToString('HH:mm:ss') } else { 'n/a' }
    ActiveWorkspace = if ($workspace) { $workspace.Name } else { 'none' }
    ReportReady    = [bool]$report
    ReportPath     = if ($report) { $report.FullName } else { $null }
    RunnerAlive    = [bool]$runner
    BabelChatAlive = [bool]$babelProc
    Errors         = $errors
  }
}

Write-MonitorLog "Monitor started (interval=${IntervalMinutes}m, evidence=$EvidenceDir, pid=$BenchmarkPid)"

while ($true) {
  $snap = Get-BenchmarkSnapshot
  $errText = if ($snap.Errors.Count -gt 0) { $snap.Errors -join '; ' } else { 'none' }
  Write-MonitorLog (
    "progress=$($snap.CompletedTasks)/32 latest=$($snap.LatestFile)@$($snap.LatestAt) " +
    "workspace=$($snap.ActiveWorkspace) runner=$($snap.RunnerAlive) chat=$($snap.BabelChatAlive) " +
    "report=$($snap.ReportReady) errors=$errText"
  )

  if ($snap.ReportReady) {
    Write-MonitorLog "FINISHED report=$($snap.ReportPath)"
    break
  }

  if (-not $snap.RunnerAlive -and $snap.CompletedTasks -lt 32) {
    Write-MonitorLog "ALERT benchmark runner process not found but suite incomplete"
  }

  Start-Sleep -Seconds ($IntervalMinutes * 60)
}
