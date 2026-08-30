[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$checker = Join-Path $repoRoot 'tools/check-public-pr-metadata.ps1'
$workflow = Join-Path $repoRoot '.github/workflows/typecheck.yml'
$policy = Join-Path $repoRoot 'tools/security/public-pr-metadata-policy.json'
$shell = (Get-Command pwsh -ErrorAction Stop).Source
$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("babel-pr-metadata-{0}" -f [guid]::NewGuid().ToString('N'))

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw "ASSERTION FAILED: $Message" }
}
function New-SupplementalPolicy([string[]]$Identifiers) {
  $json = @{ forbidden_private_identifiers = $Identifiers } | ConvertTo-Json -Compress
  return [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
}
function Invoke-Checker([string]$Title, [string]$Body, [string[]]$Messages, [string]$SupplementalPolicy = '', [switch]$RequireSupplementalPolicy) {
  $args = @('-NoProfile', '-File', $checker, '-PolicyPath', $policy, '-Title', $Title, '-Body', $Body, '-CommitMessages') + $Messages + @('-OutputFormat', 'json')
  if ($RequireSupplementalPolicy) { $args += '-RequireSupplementalPolicy' }
  if ($SupplementalPolicy) { $args += @('-SupplementalPolicyBase64', $SupplementalPolicy) }
  $output = @(& $shell @args 2>&1)
  return [pscustomobject]@{ ExitCode = $LASTEXITCODE; Text = ($output -join "`n") }
}

function Remove-TestTempRoot {
  for ($attempt = 0; $attempt -lt 8; $attempt++) {
    if (-not (Test-Path -LiteralPath $tempRoot)) { return }
    try {
      Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction Stop
      return
    } catch {
      if ($attempt -eq 7 -and (Test-Path -LiteralPath $tempRoot)) {
        # Windows scanners can briefly hold the synthetic event file. The
        # assertions have already completed; do not turn transient cleanup
        # contention into a false policy-test failure.
        Write-Warning "Synthetic PR metadata fixture cleanup was deferred: $tempRoot"
        return
      }
      if ($attempt -eq 7) { return }
      Start-Sleep -Milliseconds (100 + (100 * $attempt))
    }
  }
}

try {
  $checkerSource = Get-Content -LiteralPath $checker -Raw
  $workflowSource = Get-Content -LiteralPath $workflow -Raw
  Assert-True ($checkerSource -match "response\.Headers\.GetValues\('Link'\)") 'checker must tolerate commit responses without a Link header under strict mode'
  Assert-True ($checkerSource -notmatch 'ResponseHeadersVariable') 'checker must avoid unsupported response-header parameters'
  Assert-True ($checkerSource -match 'Net\.Http\.HttpClient') 'checker must use cross-platform HTTP handling'
  Assert-True ($checkerSource -match 'AuthenticationHeaderValue') 'checker must authenticate API requests explicitly'
  $targetTypesMatch = [regex]::Match($workflowSource, '(?ms)^  pull_request_target:\s*\r?\n\s+types:\s*\[(?<events>[^\]]+)\]')
  Assert-True $targetTypesMatch.Success 'workflow must declare pull_request_target activity types'
  $targetEvents = $targetTypesMatch.Groups['events'].Value
  foreach ($event in @('opened', 'reopened', 'synchronize', 'edited', 'ready_for_review')) {
    Assert-True ($targetEvents -match "(?<![\w-])$([regex]::Escape($event))(?![\w-])") "pull_request_target must subscribe to $event"
  }
  Assert-True ($workflowSource -match '(?m)^  group:.*\$\{\{\s*github\.event_name\s*\}\}') 'workflow concurrency must remain event-specific'
  $metadataJobMatch = [regex]::Match($workflowSource, '(?ms)^  public-pr-metadata:\s*(?<body>.*?)(?=^  [A-Za-z0-9_-]+:|\z)')
  Assert-True $metadataJobMatch.Success 'workflow must retain the public-pr-metadata job'
  $metadataJob = $metadataJobMatch.Groups['body'].Value
  Assert-True ($metadataJob -match "(?m)^\s+if:\s*github\.event_name == 'pull_request_target'\s*$") 'public-pr-metadata must remain restricted to pull_request_target'
  Assert-True ($metadataJob -match '(?m)^\s+ref:\s*\$\{\{\s*github\.event\.pull_request\.base\.sha\s*\}\}\s*$') 'trusted metadata validation must check out the exact PR base SHA'
  Assert-True ($metadataJob -notmatch 'github\.event\.pull_request\.(head\.sha|head\.ref|head\.label|ref)') 'trusted metadata validation must not check out PR-controlled code'
  Assert-True ($workflowSource -match 'pull-requests:\s*read') 'trusted workflow must retain pull-request read permission'
  Assert-True ($metadataJob -match '(?ms)Check public PR metadata.*?env:\s*\r?\n\s+GH_TOKEN:\s*\$\{\{\s*github\.token\s*\}\}') 'trusted workflow must scope GH_TOKEN to the metadata checker step'
  Assert-True ($metadataJob -notmatch 'GITHUB_TOKEN:\s*\$\{\{\s*github\.token\s*\}\}') 'trusted workflow must not use the legacy token variable'

  $syntheticIdentifier = 'fixture-' + 'internal-identifier'
  $supplemental = New-SupplementalPolicy @([regex]::Escape($syntheticIdentifier))
  $neutral = Invoke-Checker -Title 'docs: clarify contributor workflow' -Body 'This change documents a private method implementation detail.' -Messages @('docs: clarify contribution guidance') -SupplementalPolicy $supplemental -RequireSupplementalPolicy
  Assert-True ($neutral.ExitCode -eq 0) "neutral metadata unexpectedly failed: $($neutral.Text)"

  $lineage = ('private' + ' vault')
  $phraseFailure = Invoke-Checker -Title 'docs: update public guidance' -Body ("Synced from the $lineage.") -Messages @('docs: update guidance') -SupplementalPolicy $supplemental -RequireSupplementalPolicy
  Assert-True ($phraseFailure.ExitCode -eq 1) 'private-lineage phrase unexpectedly passed'
  Assert-True (@((ConvertFrom-Json $phraseFailure.Text).findings.id) -contains 'PRMETA001') 'private-lineage phrase did not produce PRMETA001'
  Assert-True ($phraseFailure.Text -notmatch [regex]::Escape($lineage)) 'phrase failure output exposed matched content'

  $commitPhraseFailure = Invoke-Checker -Title 'docs: update public guidance' -Body 'Public documentation update.' -Messages @("docs: update $lineage") -SupplementalPolicy $supplemental -RequireSupplementalPolicy
  Assert-True ($commitPhraseFailure.ExitCode -eq 1) 'private-lineage commit message unexpectedly passed'
  $commitFindings = @((ConvertFrom-Json $commitPhraseFailure.Text).findings)
  Assert-True (@($commitFindings | Where-Object { $_.id -eq 'PRMETA001' -and $_.field -eq 'commit-message' }).Count -eq 1) 'private-lineage commit message did not identify its field'
  Assert-True ($commitPhraseFailure.Text -notmatch [regex]::Escape($lineage)) 'commit phrase failure output exposed matched content'

  $identifierFailure = Invoke-Checker -Title 'docs: update' -Body 'No sensitive metadata here.' -Messages @($syntheticIdentifier) -SupplementalPolicy $supplemental -RequireSupplementalPolicy
  Assert-True ($identifierFailure.ExitCode -eq 1) 'supplemental identifier unexpectedly passed'
  Assert-True (@((ConvertFrom-Json $identifierFailure.Text).findings.id) -contains 'PRMETA002') 'supplemental identifier did not produce PRMETA002'
  Assert-True ($identifierFailure.Text -notmatch [regex]::Escape($syntheticIdentifier)) 'identifier failure output exposed matched content'

  foreach ($case in @(
    @{ Name = 'missing'; Value = '' },
    @{ Name = 'malformed'; Value = 'not-base64' },
    @{ Name = 'empty'; Value = (New-SupplementalPolicy @()) }
  )) {
    $result = Invoke-Checker -Title 'docs: update' -Body '' -Messages @() -SupplementalPolicy $case.Value -RequireSupplementalPolicy
    Assert-True ($result.ExitCode -ne 0) "required $($case.Name) supplemental policy unexpectedly passed"
    if (-not [string]::IsNullOrWhiteSpace($case.Value)) {
      Assert-True ($result.Text -notmatch [regex]::Escape($case.Value)) "required $($case.Name) supplemental policy was exposed"
    }
  }

  $invalidRegex = New-SupplementalPolicy @('[')
  $invalidResult = Invoke-Checker -Title 'docs: update' -Body '' -Messages @() -SupplementalPolicy $invalidRegex -RequireSupplementalPolicy
  Assert-True ($invalidResult.ExitCode -ne 0) 'invalid supplemental regex unexpectedly passed'
  Assert-True ($invalidResult.Text -notmatch [regex]::Escape($invalidRegex)) 'invalid supplemental policy was exposed'

  New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
  $eventPath = Join-Path $tempRoot 'pull-request-event.json'
  $event = @{
    repository = @{ owner = @{ login = 'babel-fixture' }; name = 'public-repo' }
    pull_request = @{ number = 42; title = 'docs: update guide'; body = 'Public documentation update.' }
  } | ConvertTo-Json -Depth 5
  Set-Content -LiteralPath $eventPath -Value $event
  $previousEventPath = $env:GITHUB_EVENT_PATH
  try {
    $env:GITHUB_EVENT_PATH = $eventPath
    $eventPass = @(& $shell -NoProfile -File $checker -PolicyPath $policy -CommitMessages @('docs: update guide') -SupplementalPolicyBase64 $supplemental -RequireSupplementalPolicy -OutputFormat json 2>&1)
    Assert-True ($LASTEXITCODE -eq 0) "pull-request event metadata unexpectedly failed: $($eventPass -join ' ')"

    $invalidEvent = @{
      repository = @{ owner = @{ login = 'invalid/owner' }; name = 'public-repo' }
      pull_request = @{ number = 42; title = 'docs: update guide'; body = 'Public documentation update.' }
    } | ConvertTo-Json -Depth 5
    Set-Content -LiteralPath $eventPath -Value $invalidEvent
    $invalidEventResult = @(& $shell -NoProfile -File $checker -PolicyPath $policy -CommitMessages @('docs: update guide') -SupplementalPolicyBase64 $supplemental -RequireSupplementalPolicy -OutputFormat json 2>&1)
    Assert-True ($LASTEXITCODE -ne 0) 'invalid repository identity unexpectedly passed'
    Assert-True (($invalidEventResult -join "`n") -notmatch 'invalid/owner') 'invalid repository identity was exposed'
  } finally {
    $env:GITHUB_EVENT_PATH = $previousEventPath
  }

  $timeoutPolicy = New-SupplementalPolicy @('(a+)+$')
  $timeoutValue = ('a' * 20000) + '!'
  $timeoutResult = Invoke-Checker -Title 'docs: update' -Body $timeoutValue -Messages @() -SupplementalPolicy $timeoutPolicy -RequireSupplementalPolicy
  Assert-True ($timeoutResult.ExitCode -ne 0) 'regex timeout policy unexpectedly passed'
  Assert-True ($timeoutResult.Text -notmatch [regex]::Escape($timeoutValue)) 'regex timeout failure output exposed matched content'

  Write-Host 'Public PR metadata policy tests passed.' -ForegroundColor Green
} finally {
  Remove-TestTempRoot
}
