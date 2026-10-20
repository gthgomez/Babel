[CmdletBinding()]
param([string]$RepoRoot = (Join-Path $PSScriptRoot '..\..'))
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$workflowPath = Join-Path $RepoRoot '.github/workflows/trusted-control-plane.yml'
$workflow = Get-Content -Raw -LiteralPath $workflowPath
if ($workflow -match [regex]::Escape('resolve-workflow-run-merge-audit-pr.ps1')) {
  throw 'Workflow must not invoke external resolver scripts before checkout.'
}

function Get-WorkflowRunResolveScriptText {
  param([string]$WorkflowText)
  $stepStart = $WorkflowText.IndexOf('      - name: Resolve pull request for completed release gate', [StringComparison]::Ordinal)
  if ($stepStart -lt 0) { throw 'Resolve pull request step marker missing.' }
  $runStart = $WorkflowText.IndexOf('        run: |', $stepStart, [StringComparison]::Ordinal)
  if ($runStart -lt 0) { throw 'Resolve pull request run block missing.' }
  $checkoutStart = $WorkflowText.IndexOf('      - name: Checkout immutable base', $runStart, [StringComparison]::Ordinal)
  if ($checkoutStart -lt 0) { throw 'Checkout immutable base marker missing.' }
  $bodyStart = $WorkflowText.IndexOf("`n", $runStart) + 1
  $body = $WorkflowText.Substring($bodyStart, $checkoutStart - $bodyStart)
  $scriptLines = @()
  foreach ($line in ($body -split "`r?`n")) {
    if ($line -match '^      - ') { break }
    if ($line -match '^          ') {
      $scriptLines += $line.Substring(10)
    }
  }
  if ($scriptLines.Count -lt 5) { throw 'Resolve pull request inline script too short after extraction.' }
  return ($scriptLines -join "`n")
}

$resolveScript = [scriptblock]::Create((Get-WorkflowRunResolveScriptText -WorkflowText $workflow))

$head399 = 'd4352794f09c14c834b4ce1f6284d10f70d9a894'
$head398 = 'ff3f8f98f78ec7204028b2be6f8b1b1b705c9589'
$repo = 'gthgomez/Babel'

function New-PullStub {
  param([int]$Number, [string]$CommitHeadSha, [string]$HeadRepo = $repo, [string]$State = 'open', [bool]$Draft = $false)
  [pscustomobject]@{
    number = $Number
    state = $State
    draft = $Draft
    base = [pscustomobject]@{ ref = 'main'; sha = '6dc83a2e6b006d03532bb0460d2e06a9fb075d5c' }
    head = [pscustomobject]@{ ref = "branch-$Number"; sha = $CommitHeadSha; repo = [pscustomobject]@{ full_name = $HeadRepo } }
  }
}

function Invoke-InlineResolve {
  param(
    [object[]]$Pulls,
    [string]$HeadSha = $head399,
    [string]$Repository = $repo,
    [string]$ExpectedError = '',
    [int]$ExpectedNumber = 0
  )

  $priorRepo = $env:GITHUB_REPOSITORY
  $priorHead = $env:HEAD_SHA
  $tempRoot = if ([string]::IsNullOrWhiteSpace($env:TEMP)) { '/tmp' } else { $env:TEMP }
  $outputPath = Join-Path $tempRoot "merge-audit-resolve-$([Guid]::NewGuid().ToString('n')).txt"
  $env:GITHUB_REPOSITORY = $Repository
  $env:HEAD_SHA = $HeadSha
  $env:GITHUB_OUTPUT = $outputPath

  function gh {
    param([Parameter(ValueFromRemainingArguments)][string[]]$Arguments)
    $global:LASTEXITCODE = 0
    $uri = $Arguments[-1]
    if ($uri -notlike "repos/$Repository/commits/$HeadSha/pulls") { throw "Unexpected gh endpoint: $uri" }
    return @($Pulls) | ConvertTo-Json -Depth 10 -Compress
  }

  $failure = ''
  try {
    . $resolveScript
  } catch {
    $failure = $_.Exception.Message
  }

  $env:GITHUB_REPOSITORY = $priorRepo
  $env:HEAD_SHA = $priorHead
  Remove-Item Env:GITHUB_OUTPUT -ErrorAction SilentlyContinue

  if ($ExpectedError) {
    if (-not $failure.Contains($ExpectedError)) { throw "Expected error containing '$ExpectedError' but got '$failure'." }
    return
  }
  if ($failure) { throw "Unexpected resolver failure: $failure" }
  $lines = Get-Content -LiteralPath $outputPath
  Remove-Item -LiteralPath $outputPath -Force -ErrorAction SilentlyContinue
  $numberLine = @($lines | Where-Object { $_ -like 'number=*' } | Select-Object -First 1)
  if ($numberLine.Count -ne 1) {
    throw "Unexpected resolver output: $($lines -join '; ')"
  }
  if ($numberLine[0] -ne "number=$ExpectedNumber") {
    throw "Unexpected resolver number line: $($numberLine[0])"
  }
}

Invoke-InlineResolve -Pulls @(
  (New-PullStub -Number 398 -CommitHeadSha $head398),
  (New-PullStub -Number 399 -CommitHeadSha $head399)
) -ExpectedNumber 399

Invoke-InlineResolve -Pulls @(
  (New-PullStub -Number 398 -CommitHeadSha $head399),
  (New-PullStub -Number 399 -CommitHeadSha $head399)
) -ExpectedError 'ambiguous'

Invoke-InlineResolve -Pulls @(
  (New-PullStub -Number 501 -CommitHeadSha $head399 -HeadRepo 'evil/fork')
) -ExpectedError 'No exact-head'

Invoke-InlineResolve -Pulls @(
  (New-PullStub -Number 398 -CommitHeadSha $head398)
) -ExpectedError 'No exact-head'

Invoke-InlineResolve -Pulls @(
  (New-PullStub -Number 399 -CommitHeadSha $head399 -Draft $true)
) -ExpectedError 'Draft pull requests'

Write-Output 'RESOLVE_WORKFLOW_RUN_MERGE_AUDIT_INLINE_TEST_PASS'
