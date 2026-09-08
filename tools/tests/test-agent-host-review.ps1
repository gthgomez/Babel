[CmdletBinding()]
param()

# Windows-only command contract test. It runs the host-review command against a
# throwaway Git repository and .cmd process shims; no provider or GitHub call is
# possible from this test.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-HostReviewCommand {
  param([Parameter(Mandatory)][bool]$Condition, [Parameter(Mandatory)][string]$Message)
  if (-not $Condition) { throw "ASSERTION FAILED: $Message" }
}

function Read-JsonFile {
  param([Parameter(Mandatory)][string]$Path)
  return (Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json)
}

function Get-TextHash {
  param([Parameter(Mandatory)][string]$Text)
  return ([Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($Text)))).ToLowerInvariant()
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$command = Join-Path $repoRoot 'tools\agent-host-review.ps1'
$pwsh = (Get-Command pwsh -ErrorAction Stop).Source
$git = (Get-Command git -ErrorAction Stop).Source
$env:HOST_REVIEW_REAL_NODE = (Get-Command node -ErrorAction Stop).Source
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('babel-host-review-' + [guid]::NewGuid().ToString('N'))
$repo = Join-Path $testRoot 'candidate'
$shim = Join-Path $testRoot 'shim'
$log = Join-Path $testRoot 'shim.log'

function Write-Shims {
  param([Parameter(Mandatory)][string]$Directory)
  New-Item -ItemType Directory -Path $Directory -Force | Out-Null

  @'
$argv = @($args)
$ErrorActionPreference = 'Stop'
$joined = $argv -join ' '
if ($argv.Count -ge 1 -and $argv[0] -eq 'api' -and $joined -like '*issues/*/comments*') {
  # This path receives the review body through stdin. Keep it side-effect free
  # so Windows PowerShell's native-pipeline handle does not affect the shim.
  Write-Output 'https://github.example/review-comment'
  exit 0
}
if ($argv.Count -ge 2 -and $argv[0] -eq 'pr' -and $argv[1] -eq 'view') {
  $countPath = $env:HOST_REVIEW_PR_COUNT
  $count = if (Test-Path -LiteralPath $countPath) { [int](Get-Content -Raw -LiteralPath $countPath) } else { 0 }
  $count += 1
  Set-Content -LiteralPath $countPath -Value $count -NoNewline
  $head = $env:HOST_REVIEW_HEAD
  if ($env:HOST_REVIEW_MODE -eq 'head-change' -and $count -ge 2) { $head = $env:HOST_REVIEW_CHANGED_HEAD }
  [ordered]@{ number = [int]$env:HOST_REVIEW_PR; state = 'OPEN'; baseRefOid = $env:HOST_REVIEW_BASE; headRefOid = $head; headRefName = 'codex/review'; isCrossRepository = $false } | ConvertTo-Json -Compress
  exit 0
}
if ($argv.Count -ge 2 -and $argv[0] -eq 'repo' -and $argv[1] -eq 'view') {
  Write-Output $env:HOST_REVIEW_REPOSITORY
  exit 0
}
if ($argv.Count -ge 1 -and $argv[0] -eq 'api') {
  if ($joined -match 'repos/.+ --jq .owner.id') { Write-Output '91163862'; exit 0 }
  if ($joined -match '^api user ') { Write-Output '91163862'; exit 0 }
}
Write-Error 'unexpected gh invocation'
exit 9
'@ | Set-Content -LiteralPath (Join-Path $Directory 'gh-shim.ps1') -Encoding utf8NoBOM

  @'
$argv = @($args)
$ErrorActionPreference = 'Stop'
$joined = $argv -join ' '
Add-Content -LiteralPath $env:HOST_REVIEW_TEST_LOG -Value ("NODE " + $joined)
$stdin = [Console]::In.ReadToEnd()
$modelArg = @($argv | Where-Object { $_ -like '--model=*' })[0]
$model = $modelArg.Substring('--model='.Length)
$budgetArg = @($argv | Where-Object { $_ -like '--budget-usd=*' })[0]
$priorArg = @($argv | Where-Object { $_ -like '--prior-reserved-usd=*' })[0]
$budget = [double]$budgetArg.Substring('--budget-usd='.Length)
$prior = [double]$priorArg.Substring('--prior-reserved-usd='.Length)
$reservation = 0.05
if ($argv -contains '--preflight=true') {
  if ($prior + $reservation -gt $budget) { Write-Error 'BUDGET_LIMIT'; exit 23 }
  [ordered]@{ status = 'PREFLIGHT_ONLY'; reserved_upper_bound_usd = $reservation } | ConvertTo-Json -Compress
  exit 0
}
if ($env:HOST_REVIEW_MODE -eq 'worker-failure') { Write-Error 'synthetic worker failure'; exit 24 }
if ($env:HOST_REVIEW_LEDGER -and (Test-Path -LiteralPath $env:HOST_REVIEW_LEDGER)) {
  $ledger = Get-Content -Raw -LiteralPath $env:HOST_REVIEW_LEDGER | ConvertFrom-Json
  Add-Content -LiteralPath $env:HOST_REVIEW_TEST_LOG -Value ("ACTUAL_RESERVED=" + $ledger.reserved_usd)
}
$stdin | Set-Content -LiteralPath $env:HOST_REVIEW_PAYLOAD -NoNewline
$runArg = @($argv | Where-Object { $_ -like '--controller-run-id=*' })[0]
$runId = $runArg.Substring('--controller-run-id='.Length)
$verdict = if ($env:HOST_REVIEW_MODE -eq 'block') { 'BLOCK' } else { 'APPROVE' }
$review = [ordered]@{ verdict = $verdict; blocking_findings = if ($verdict -eq 'BLOCK') { @('synthetic blocking finding') } else { @() }; findings = @('synthetic review') }
$review.blocking_findings = @()
if ($verdict -eq 'BLOCK') { $review.blocking_findings = @('synthetic blocking finding') }
$candidate = ($stdin | ConvertFrom-Json).candidate
foreach ($property in $candidate.PSObject.Properties) { $review[$property.Name] = $property.Value }
$review.schema_version = 2; $review.kind = 'autonomous_review_evidence_v2'
$review.reviewer_id = 'fixture-independent'; $review.reviewer_class = 'independent_readonly_ai'
$review.execution_id = [guid]::NewGuid().ToString(); $review.review_provider = 'opencode-go'
$review.reviewer_model = $model; $review.review_mode = 'exact_diff'; $review.reviewed_at = [DateTimeOffset]::UtcNow.ToString('o')
$review.isolation = @{ mode = 'text_only_no_tools'; candidate_write = $false; github_mutation = $false; merge = $false; controller_state_access = $false }
$actualModel = if ($env:HOST_REVIEW_MODE -eq 'model-mismatch') { 'longcat-2.0' } else { $model }
$result = [ordered]@{ status = 'REVIEW_COMPLETED'; provider = 'opencode-go'; observed_model = $actualModel; handoff = [ordered]@{ controller_run_id = $runId; reviews = @($review) } }
foreach ($field in @('repository', 'pr_number', 'base_sha', 'head_sha', 'task_id', 'task_hash')) { $result.handoff[$field] = $candidate.$field }
if ($env:HOST_REVIEW_MODE -ne 'missing-usage') { $result.usage = [ordered]@{ input_tokens = 10; output_tokens = 10 } }
if ($env:HOST_REVIEW_MODE -eq 'usage-overrun') { $result.usage.input_tokens = 1000000 }
$result | ConvertTo-Json -Compress -Depth 10
'@ | Set-Content -LiteralPath (Join-Path $Directory 'node-shim.ps1') -Encoding utf8NoBOM

  @'
Add-Content -LiteralPath $env:HOST_REVIEW_TEST_LOG -Value 'GITLEAKS'
[Console]::In.ReadToEnd() | Out-Null
exit 0
'@ | Set-Content -LiteralPath (Join-Path $Directory 'gitleaks-shim.ps1') -Encoding utf8NoBOM

  foreach ($name in @('gh', 'node', 'gitleaks')) {
    $target = "$name-shim.ps1"
    "@echo off`r`n`"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`" -NoProfile -ExecutionPolicy Bypass -File `"%~dp0$target`" %*" |
      Set-Content -LiteralPath (Join-Path $Directory "$name.cmd") -Encoding ascii
  }
  # Windows PowerShell's `-File` wrapper cannot reliably consume the host
  # command's piped `gh api --input -` body. Keep that shim branch in cmd.
  @'
@echo off
echo %* | findstr /I /C:"issues/" >nul
if not errorlevel 1 (
  echo https://github.example/review-comment
  exit /b 0
)
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0gh-shim.ps1" %*
'@ | Set-Content -LiteralPath (Join-Path $Directory 'gh.cmd') -Encoding ascii
  @'
@echo off
if "%HOST_REVIEW_MODE%"=="real-preflight" (
  "%HOST_REVIEW_REAL_NODE%" %*
  exit /b
)
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -File "%~dp0node-shim.ps1" %*
'@ | Set-Content -LiteralPath (Join-Path $Directory 'node.cmd') -Encoding ascii
}

function Invoke-HostReviewCommand {
  param(
    [Parameter(Mandatory)][string]$Task,
    [Parameter(Mandatory)][string]$Ledger,
    [Parameter(Mandatory)][string]$Mode,
    [double]$Budget = 1,
    [switch]$Publish,
    [switch]$PreflightOnly
  )
  $previousPath = $env:PATH
  $env:PATH = "$shim;$previousPath"
  $env:HOST_REVIEW_TEST_LOG = $log
  $env:HOST_REVIEW_MODE = $Mode
  $env:HOST_REVIEW_LEDGER = $Ledger
  $env:HOST_REVIEW_PAYLOAD = (Join-Path $testRoot ("payload-" + [guid]::NewGuid().ToString('N') + '.json'))
  $env:HOST_REVIEW_PUBLISH_BODY = (Join-Path $testRoot ("publish-" + [guid]::NewGuid().ToString('N') + '.json'))
  $env:HOST_REVIEW_PR_COUNT = (Join-Path $testRoot ("pr-count-" + [guid]::NewGuid().ToString('N') + '.txt'))
  try {
    $arguments = @('-NoProfile', '-File', $command, '-PR', '77', '-RepoRoot', $repo, '-TaskPath', $Task,
      '-BudgetLedgerPath', $Ledger, '-BudgetUsd', $Budget, '-Repository', 'gthgomez/Babel',
      '-Models', 'deepseek-v4-flash')
    if ($Mode -eq 'real-preflight') {
      $wrapper = Join-Path $testRoot 'bom-parent.ps1'
      @'
$OutputEncoding = [Text.UTF8Encoding]::new($true)
& $env:HOST_REVIEW_COMMAND @args
'@ | Set-Content -LiteralPath $wrapper -Encoding utf8NoBOM
      $env:HOST_REVIEW_COMMAND = $command
      $arguments[2] = $wrapper
    }
    if ($Publish) { $arguments += '-Publish' }
    if ($PreflightOnly) { $arguments += '-PreflightOnly' }
    $output = @(& $pwsh @arguments 2>&1)
    return [pscustomobject]@{ exit_code = $LASTEXITCODE; output = $output; payload = $env:HOST_REVIEW_PAYLOAD; publish_count = @($output | Where-Object { $_ -match 'github[.]example/review-comment' }).Count }
  } finally {
    $env:PATH = $previousPath
  }
}

try {
  New-Item -ItemType Directory -Path $repo -Force | Out-Null
  & $git -C $repo init -q
  & $git -C $repo config user.email 'host-review-test@example.invalid'
  & $git -C $repo config user.name 'Host Review Test'
  Set-Content -LiteralPath (Join-Path $repo 'base.txt') -Value 'base' -NoNewline
  & $git -C $repo add base.txt
  & $git -C $repo commit -qm 'base'
  $base = (& $git -C $repo rev-parse HEAD).Trim()
  Set-Content -LiteralPath (Join-Path $repo 'feature.txt') -Value 'candidate change' -NoNewline
  & $git -C $repo add feature.txt
  & $git -C $repo commit -qm 'feature'
  $head = (& $git -C $repo rev-parse HEAD).Trim()
  & $git -C $repo remote add origin 'https://github.com/gthgomez/Babel.git'
  Write-Shims -Directory $shim
  $env:HOST_REVIEW_BASE = $base
  $env:HOST_REVIEW_HEAD = $head
  $env:HOST_REVIEW_CHANGED_HEAD = ('f' * 40)
  $env:HOST_REVIEW_PR = '77'
  $env:HOST_REVIEW_REPOSITORY = 'gthgomez/Babel'
  Set-Content -LiteralPath $log -Value '' -NoNewline

  $task = Join-Path $testRoot 'task-a.txt'
  $taskText = 'Review the candidate feature change.'
  Set-Content -LiteralPath $task -Value $taskText -NoNewline
  $ledger = Join-Path $testRoot 'ledger-success.json'
  # Exercise the actual Node JSON parser, not the permissive PowerShell shim.
  # Native stdin must remain valid even when the parent shell emits a UTF-8 BOM.
  $realLedger = Join-Path $testRoot 'ledger-real-preflight.json'
  $candidateLedger = Invoke-HostReviewCommand -Task $task -Ledger (Join-Path $repo 'host-ledger.json') -Mode 'missing-usage'
  Assert-HostReviewCommand ($candidateLedger.exit_code -ne 0) 'candidate-controlled ledger must be rejected before a worker call'
  $real = Invoke-HostReviewCommand -Task $task -Ledger $realLedger -Mode 'real-preflight' -PreflightOnly
  Assert-HostReviewCommand ($real.exit_code -eq 0 -and ($real.output -join "`n") -match 'PREFLIGHT_ONLY') 'real Node preflight must parse host-generated JSON without a BOM'
  Assert-HostReviewCommand ([double](Read-JsonFile $realLedger).reserved_usd -eq 0) 'preflight-only must not reserve or spend credits'
  Assert-HostReviewCommand ($real.publish_count -eq 0) 'preflight-only must not publish review evidence'
  $success = Invoke-HostReviewCommand -Task $task -Ledger $ledger -Mode 'missing-usage' -Budget 1 -Publish
  Assert-HostReviewCommand ($success.exit_code -eq 0) ("missing optional usage must retain its reservation without invalidating an exact semantic review: " + ($success.output -join "`n"))
  $sent = Read-JsonFile -Path $success.payload
  Assert-HostReviewCommand ($sent.candidate.base_sha -eq $base -and $sent.candidate.head_sha -eq $head) 'worker payload must use the exact live base/head tuple'
  Assert-HostReviewCommand ($sent.candidate.scope.Count -eq 1 -and $sent.candidate.scope[0] -eq 'feature.txt') 'worker payload must be source-derived from the exact diff'
  Assert-HostReviewCommand ($sent.task_text -eq $taskText -and $sent.candidate.task_hash -eq (Get-TextHash $taskText)) 'worker payload must bind the exact task text and hash'
  Assert-HostReviewCommand ((Get-Content -Raw -LiteralPath $log) -match 'ACTUAL_RESERVED=0.05') 'reservation must be persisted before the paid worker callback'
  $successLedger = Read-JsonFile -Path $ledger
  Assert-HostReviewCommand ([double]$successLedger.reserved_usd -eq 0.05) 'missing usage must retain the full pre-call reservation'
  Assert-HostReviewCommand ($successLedger.repository -eq 'gthgomez/Babel' -and $successLedger.task_hash -eq (Get-TextHash $taskText)) 'ledger must bind its repository and trusted task hash'
  Assert-HostReviewCommand ($success.publish_count -eq 1) 'approval evidence must be published only after exact-state recheck'

  $callsBeforeResume = @(Get-Content -LiteralPath $log | Where-Object { $_ -match '^ACTUAL_RESERVED=' }).Count
  $resumed = Invoke-HostReviewCommand -Task $task -Ledger $ledger -Mode 'worker-failure' -Budget 1 -Publish
  Assert-HostReviewCommand ($resumed.exit_code -eq 0 -and $resumed.publish_count -eq 1) 'fresh exact completed review must survive and resume even when a new worker would fail'
  $callsAfterResume = @(Get-Content -LiteralPath $log | Where-Object { $_ -match '^ACTUAL_RESERVED=' }).Count
  Assert-HostReviewCommand ($callsBeforeResume -eq $callsAfterResume) 'resume must not repeat the completed paid execution'
  Assert-HostReviewCommand (@((Read-JsonFile $ledger).round.completed).Count -eq 1) 'review result must be durably checkpointed'

  $poisonPath = Join-Path $testRoot 'ledger-poison.json'
  $poison = Read-JsonFile $ledger
  $poison.round.completed[0].handoff.reviews[0].head_sha = ('e' * 40)
  $poison | ConvertTo-Json -Depth 40 | Set-Content -LiteralPath $poisonPath -Encoding utf8NoBOM
  $poisonResult = Invoke-HostReviewCommand -Task $task -Ledger $poisonPath -Mode 'missing-usage' -Publish
  Assert-HostReviewCommand ($poisonResult.exit_code -ne 0 -and $poisonResult.publish_count -eq 0) 'cached candidate mismatch must fail closed'

  $overrunPath = Join-Path $testRoot 'ledger-overrun.json'
  $overrun = Invoke-HostReviewCommand -Task $task -Ledger $overrunPath -Mode 'usage-overrun' -Publish
  Assert-HostReviewCommand ($overrun.exit_code -ne 0 -and $overrun.publish_count -eq 0) 'usage above reservation must stop publication'
  $overrunRetry = Invoke-HostReviewCommand -Task $task -Ledger $overrunPath -Mode 'missing-usage' -Publish
  Assert-HostReviewCommand ($overrunRetry.exit_code -ne 0 -and $overrunRetry.publish_count -eq 0) 'accounting breach must survive retry'

  $second = Invoke-HostReviewCommand -Task $task -Ledger $ledger -Mode 'missing-usage' -Budget 0.05
  Assert-HostReviewCommand ($second.exit_code -ne 0) 'a second run must not reset or overspend an existing ledger'

  $otherTask = Join-Path $testRoot 'task-b.txt'
  Set-Content -LiteralPath $otherTask -Value 'A different trusted task.' -NoNewline
  $taskMismatch = Invoke-HostReviewCommand -Task $otherTask -Ledger $ledger -Mode 'missing-usage' -Budget 1
  Assert-HostReviewCommand ($taskMismatch.exit_code -ne 0) 'a ledger must reject a different task hash before new spend'

  $failureLedger = Join-Path $testRoot 'ledger-failure.json'
  $failure = Invoke-HostReviewCommand -Task $task -Ledger $failureLedger -Mode 'worker-failure' -Budget 1 -Publish
  Assert-HostReviewCommand ($failure.exit_code -ne 0) 'worker failure must fail the command'
  Assert-HostReviewCommand ([double](Read-JsonFile -Path $failureLedger).reserved_usd -eq 0.05) 'worker failure must retain its pre-call reservation'
  Assert-HostReviewCommand ($failure.publish_count -eq 0) 'worker failure must not publish evidence'

  $mismatchLedger = Join-Path $testRoot 'ledger-model-mismatch.json'
  $mismatch = Invoke-HostReviewCommand -Task $task -Ledger $mismatchLedger -Mode 'model-mismatch' -Budget 1 -Publish
  Assert-HostReviewCommand ($mismatch.exit_code -ne 0) 'mismatched observed model must deny review evidence'
  Assert-HostReviewCommand ($mismatch.publish_count -eq 0) 'mismatched model must not publish evidence'

  $headLedger = Join-Path $testRoot 'ledger-head-change.json'
  $headChange = Invoke-HostReviewCommand -Task $task -Ledger $headLedger -Mode 'head-change' -Budget 1 -Publish
  Assert-HostReviewCommand ($headChange.exit_code -ne 0) 'a PR head change after review must deny publication'
  Assert-HostReviewCommand ($headChange.publish_count -eq 0) 'changed PR head must not publish stale evidence'

  $blockLedger = Join-Path $testRoot 'ledger-block.json'
  $block = Invoke-HostReviewCommand -Task $task -Ledger $blockLedger -Mode 'block' -Budget 1 -Publish
  Assert-HostReviewCommand ($block.exit_code -eq 0) 'a completed BLOCK review may be published as truthful evidence'
  $blockEvidence = Get-ChildItem -LiteralPath $testRoot -Filter 'pr-77-*-handoff.json' | Select-Object -Last 1
  Assert-HostReviewCommand ($block.publish_count -eq 1 -and (Get-Content -Raw -LiteralPath $blockEvidence.FullName) -match '"verdict": "BLOCK"') 'a non-APPROVE review must never be rewritten as approval'

  $lockLedger = Join-Path $testRoot 'ledger-lock.json'
  $heldLock = [IO.File]::Open("$lockLedger.lock", [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try {
    $locked = Invoke-HostReviewCommand -Task $task -Ledger $lockLedger -Mode 'missing-usage' -Budget 1
    Assert-HostReviewCommand ($locked.exit_code -ne 0) 'a concurrently held ledger lock must deny a second controller'
    Assert-HostReviewCommand (-not (Test-Path -LiteralPath $locked.payload)) 'locked controller must not reach the worker'
  } finally {
    $heldLock.Dispose()
  }
  $afterLock = Invoke-HostReviewCommand -Task $task -Ledger $lockLedger -Mode 'missing-usage' -Budget 1
  Assert-HostReviewCommand ($afterLock.exit_code -eq 0) 'persistent lock inode must be acquirable after the prior handle closes'

  Write-Output 'agent-host-review: PASS'
  exit 0
} catch {
  Write-Error $_
  exit 1
} finally {
  # A failed child process can briefly retain a Windows handle. Do not let that
  # cleanup race hide the assertion or command failure that this test is meant
  # to report; the next run uses a fresh GUID directory.
  if (Test-Path -LiteralPath $testRoot) {
    try { Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction Stop } catch { Write-Warning "temporary fixture retained: $testRoot" }
  }
}
