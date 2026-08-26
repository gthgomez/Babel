[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$contentScript = Join-Path $repoRoot 'tools/check-public-content-policy.ps1'
$contentPolicy = Join-Path $repoRoot 'tools/security/public-content-policy.json'
$commonModule = Join-Path $repoRoot 'tools/security/tracked-scan-common.psm1'
$pwshCandidate = 'C:\Program Files\PowerShell\7\pwsh.exe'
$pwsh = if (Test-Path -LiteralPath $pwshCandidate -PathType Leaf) { $pwshCandidate } else { (Get-Command pwsh -ErrorAction Stop).Source }
$gitCandidate = 'C:\Program Files\Git\cmd\git.exe'
$git = if (Test-Path -LiteralPath $gitCandidate -PathType Leaf) { $gitCandidate } else { (Get-Command git -ErrorAction Stop).Source }
$tempRoot = Join-Path $repoRoot (".codex-public-policy-runtime-{0}" -f [guid]::NewGuid().ToString('N'))

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw "ASSERTION FAILED: $Message" }
}
function Initialize-RuntimeFixture([string]$Name, [bool]$MalformedPolicy) {
  $root = Join-Path $tempRoot $Name
  New-Item -ItemType Directory -Path (Join-Path $root 'tools/security') -Force | Out-Null
  Copy-Item -LiteralPath $contentScript -Destination (Join-Path $root 'tools/check-public-content-policy.ps1')
  Copy-Item -LiteralPath $contentPolicy -Destination (Join-Path $root 'tools/security/public-content-policy.json')
  Copy-Item -LiteralPath $commonModule -Destination (Join-Path $root 'tools/security/tracked-scan-common.psm1')
  Set-Content -LiteralPath (Join-Path $root 'README.md') -Value "# Runtime fixture`n"
  Set-Content -LiteralPath (Join-Path $root 'sample.md') -Value "# Runtime sample`nMeasured evidence only.`n"
  if ($MalformedPolicy) { Set-Content -LiteralPath (Join-Path $root 'tools/security/public-content-policy.json') -Value '{' }
  $null = & $git -C $root init --quiet 2>$null
  $null = & $git -C $root config user.email 'fixture@example.invalid' 2>$null
  $null = & $git -C $root config user.name 'Fixture Runner' 2>$null
  $null = & $git -C $root add . 2>$null
  return $root
}

function Invoke-RuntimeProbe([string]$Name, [string]$Root, [bool]$ForceConstrainedLanguage) {
  $stdoutPath = Join-Path $Root '.runtime-stdout.json'
  $stderrPath = Join-Path $Root '.runtime-stderr.txt'
  $previousLockdown = $env:__PSLockdownPolicy
  try {
    if ($ForceConstrainedLanguage) { $env:__PSLockdownPolicy = '8' } else { Remove-Item Env:__PSLockdownPolicy -ErrorAction SilentlyContinue }
    $validatorLiteral = $contentScript.Replace("'", "''")
    $rootLiteral = $Root.Replace("'", "''")
    $stdoutLiteral = $stdoutPath.Replace("'", "''")
    $stderrLiteral = $stderrPath.Replace("'", "''")
    $probeCommand = @(
      '$ErrorActionPreference = ''Continue'''
      '$languageMode = [string]$ExecutionContext.SessionState.LanguageMode'
      'try {'
      "& '$validatorLiteral' -RepoRoot '$rootLiteral' -OutputFormat json 1> '$stdoutLiteral' 2> '$stderrLiteral'"
      '  $exitCode = $LASTEXITCODE'
      '} catch {'
      '  $exitCode = 1'
      "  Add-Content -LiteralPath '$stderrLiteral' -Value ([string]`$_)"
      '}'
      '[ordered]@{'
      '  host = $env:COMPUTERNAME'
      '  pwsh = $PSVersionTable.PSVersion.ToString()'
      '  languageMode = $languageMode'
      '  validatorExitCode = $exitCode'
      "  stdout = [string](Get-Content -Raw -LiteralPath '$stdoutLiteral')"
      "  stderr = [string](Get-Content -Raw -LiteralPath '$stderrLiteral')"
      '} | ConvertTo-Json -Depth 8'
    ) -join "`n"
    $output = @(& $pwsh -NoProfile -Command $probeCommand 2>&1)
    $outerExit = $LASTEXITCODE
  } finally {
    if ($null -eq $previousLockdown) { Remove-Item Env:__PSLockdownPolicy -ErrorAction SilentlyContinue } else { $env:__PSLockdownPolicy = $previousLockdown }
    Remove-Item -LiteralPath $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue
  }
  Assert-True ($outerExit -eq 0) "$Name probe process failed: $($output -join "`n")"
  $record = ConvertFrom-Json ($output -join "`n")
  $record | Add-Member -NotePropertyName probe -NotePropertyValue $Name
  $record | Add-Member -NotePropertyName forcedConstrainedLanguage -NotePropertyValue $ForceConstrainedLanguage
  return $record
}
try {
  New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null

  $valid = Initialize-RuntimeFixture 'valid' $false
  $current = Invoke-RuntimeProbe 'current' $valid $false
  Assert-True ($current.validatorExitCode -eq 0) "current runtime validator failed: $($current | ConvertTo-Json -Depth 8)"

  $constrained = Invoke-RuntimeProbe 'constrained' $valid $true
  if ($constrained.languageMode -eq 'ConstrainedLanguage') {
    Assert-True ($constrained.validatorExitCode -eq 0) "ConstrainedLanguage runtime validator failed: $($constrained | ConvertTo-Json -Depth 8)"
  }

  $malformed = Initialize-RuntimeFixture 'malformed-policy' $true
  $malformedResult = Invoke-RuntimeProbe 'malformed-policy' $malformed $false
  Assert-True ($malformedResult.validatorExitCode -ne 0) 'malformed policy unexpectedly passed'
  Assert-True (($malformedResult.stdout + $malformedResult.stderr).Length -gt 0) 'malformed policy produced no diagnostic output'

  [ordered]@{
    status = 'pass'
    runtime = @($current, $constrained, $malformedResult)
  } | ConvertTo-Json -Depth 8
} finally {
  try {
    if (Test-Path -LiteralPath $tempRoot) {
      Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
  } catch {}
}
