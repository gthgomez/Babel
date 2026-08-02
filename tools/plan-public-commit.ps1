<#
.SYNOPSIS
  Build a deterministic, read-only release map for a dirty public checkout.

.DESCRIPTION
  Inventories Git-visible paths without reading file contents, classifies each
  path into a public batch or an explicit exclusion, and reports review-size
  budgets. It never stages, commits, pushes, or deletes files.
#>
[CmdletBinding()]
param(
  [string]$RepoRoot = (Get-Location).Path,
  [string]$BaseRef = 'origin/main',
  [int]$MaxFiles = 30,
  [int]$MaxChangedLines = 1500,
  [switch]$Json,
  [string]$OutFile = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Invoke-GitLines {
  param([string[]]$Arguments)
  $output = & git -C $RepoRoot @Arguments 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "git $($Arguments -join ' ') failed: $($output -join [Environment]::NewLine)"
  }
  return @($output | ForEach-Object { [string]$_ })
}

function Normalize-Path {
  param([string]$Path)
  return ($Path -replace '\\', '/')
}

function Get-Disposition {
  param([string]$Path)
  $normalized = Normalize-Path $Path

  if ($normalized -match '(^|/)docs/(archive|audit|critiques|plans|research|status)(/|$)' -or
      $normalized -match '(^|/)docs/OSS_DOCS_CRITIQUE_.*\.md$' -or
      $normalized -match '(^|/)docs/guides/PARITY_BENCHMARK\.md$') {
    return 'vault'
  }

  if ($normalized -match '(^|/)\.claude(/|$)' -or
      $normalized -eq 'babel-cli/scratch.cjs' -or
      $normalized -match '^benchmarks/datasets/swe-bench-pro/(hf-cache-sample|phase2-).*\.jsonl$') {
    return 'exclude'
  }

  if ($normalized -match '^\.agents/(rules/05-github-workflow\.md|skills/(branch-stack|bv|catalog-validate-all|ci-dry-run|ci-triage|ratchet-preflight|ship|task-helper)/)') {
    return 'ship'
  }

  if ($normalized -match '^babel-cli/src/runners/' -or $normalized -match '^babel-cli/src/execute\.ts$') {
    return 'ship'
  }
  if ($normalized -match '^babel-cli/src/(agent|evidence|executor|services|ui|pipeline)/') {
    return 'ship'
  }
  if ($normalized -match '^babel-cli/src/(protocol|daemon)/') {
    return 'ship'
  }
  if ($normalized -match '^(README\.md|START_HERE\.md|docs/(CHAT_MODE|README|VISION)\.md)$') {
    return 'ship'
  }
  if ($normalized -match '^tools/') {
    return 'ship'
  }
  if ($normalized -eq '.gitignore') {
    return 'ship'
  }

  return 'investigate'
}

function Get-Batch {
  param([string]$Path)
  $normalized = Normalize-Path $Path
  $disposition = Get-Disposition $normalized
  if ($disposition -in @('vault', 'exclude')) { return $disposition }
  if ($normalized -match '^babel-cli/src/runners/|^babel-cli/src/execute\.ts$') { return 'provider' }
  if ($normalized -match '^babel-cli/src/(agent|evidence|executor|services|ui|pipeline)/') { return 'executor' }
  if ($normalized -match '^babel-cli/src/(protocol|daemon)/') { return 'protocol' }
  if ($normalized -match '^\.agents/|^tools/') { return 'workflow' }
  if ($normalized -eq '.gitignore') { return 'workflow' }
  if ($normalized -match '^(README\.md|START_HERE\.md|docs/)') { return 'public-docs' }
  return 'investigate'
}

function Get-NumStatMap {
  param([string[]]$Arguments)
  $map = @{}
  foreach ($line in (Invoke-GitLines $Arguments)) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    $parts = $line -split "`t", 3
    if ($parts.Count -lt 3) { continue }
    $add = 0
    $del = 0
    [void][int]::TryParse($parts[0], [ref]$add)
    [void][int]::TryParse($parts[1], [ref]$del)
    $map[(Normalize-Path $parts[2])] = [pscustomobject]@{ additions = $add; deletions = $del }
  }
  return $map
}

$resolvedRoot = (Resolve-Path -LiteralPath $RepoRoot).Path
$statusLines = Invoke-GitLines @('status', '--porcelain=v1', '-uall')
$unstagedStats = Get-NumStatMap @('diff', '--numstat')
$stagedStats = Get-NumStatMap @('diff', '--cached', '--numstat')
$records = @()

foreach ($line in $statusLines) {
  if ($line.Length -lt 4) { continue }
  $code = $line.Substring(0, 2)
  $rawPath = $line.Substring(3)
  if ($rawPath -match ' -> ') { $rawPath = ($rawPath -split ' -> ')[-1] }
  $path = Normalize-Path $rawPath
  $unstaged = $unstagedStats[$path]
  $staged = $stagedStats[$path]
  $additions = 0
  $deletions = 0
  if ($null -ne $unstaged) { $additions += $unstaged.additions; $deletions += $unstaged.deletions }
  if ($null -ne $staged) { $additions += $staged.additions; $deletions += $staged.deletions }
  $records += [pscustomobject]@{
    path = $path
    status = $code
    disposition = Get-Disposition $path
    batch = Get-Batch $path
    additions = $additions
    deletions = $deletions
    changedLines = $additions + $deletions
  }
}

$batches = @($records | Group-Object batch | ForEach-Object {
  $items = @($_.Group)
  [pscustomobject]@{
    name = $_.Name
    files = $items.Count
    changedLines = [int](($items | Measure-Object -Property changedLines -Sum).Sum)
    dispositions = @($items | Group-Object disposition | ForEach-Object { $_.Name })
    paths = @($items | ForEach-Object { $_.path })
    withinBudget = ($items.Count -le $MaxFiles -and [int](($items | Measure-Object -Property changedLines -Sum).Sum) -le $MaxChangedLines)
  }
})

$result = [pscustomobject]@{
  schemaVersion = 'public-commit-plan-v1'
  repoRoot = $resolvedRoot
  baseRef = $BaseRef
  budgets = [pscustomobject]@{ maxFiles = $MaxFiles; maxChangedLines = $MaxChangedLines }
  safeToStage = (@($records | Where-Object { $_.disposition -in @('investigate', 'vault') }).Count -eq 0)
  records = @($records)
  batches = @($batches)
  nextAction = if (@($records | Where-Object { $_.disposition -eq 'investigate' }).Count -gt 0) { 'classify investigate paths before staging' } elseif (@($records).Count -eq 0) { 'nothing to ship' } else { 'select exactly one batch and stage explicit paths' }
}

$jsonText = $result | ConvertTo-Json -Depth 8
if (-not [string]::IsNullOrWhiteSpace($OutFile)) {
  $parent = Split-Path -Parent $OutFile
  if (-not [string]::IsNullOrWhiteSpace($parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
  Set-Content -LiteralPath $OutFile -Value $jsonText -Encoding UTF8
}

if ($Json) {
  Write-Output $jsonText
} else {
  Write-Output "Public commit plan: $($records.Count) visible paths"
  Write-Output "Base: $BaseRef"
  Write-Output "Safe to stage: $($result.safeToStage)"
  foreach ($batch in $batches) {
    $budget = if ($batch.withinBudget) { 'within budget' } else { 'SPLIT REQUIRED' }
    Write-Output ("- {0}: {1} files, {2} changed lines ({3})" -f $batch.name, $batch.files, $batch.changedLines, $budget)
  }
  foreach ($record in ($records | Sort-Object disposition, path)) {
    Write-Output ("  [{0}] {1} -> {2} ({3})" -f $record.disposition, $record.path, $record.batch, $record.status)
  }
  Write-Output "Next: $($result.nextAction)"
}
