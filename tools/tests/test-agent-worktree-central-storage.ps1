[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$fixtureRoot = Join-Path $repoRoot ('.tmp-agent-worktree-central-' + [Guid]::NewGuid().ToString('N'))
$publicRoot = Join-Path $fixtureRoot 'public'
$fixture = Join-Path $publicRoot 'Babel-public-live'
$storage = Join-Path $fixtureRoot 'agent-data'
$configDirectory = Join-Path $fixtureRoot 'config'
$config = Join-Path $configDirectory 'agent-storage.json'
$helper = Join-Path $repoRoot 'scripts\agent-worktree.ps1'
$git = (Get-Command git.exe -ErrorAction Stop).Source

function Assert-CentralStorageTest {
  param([Parameter(Mandatory = $true)][bool]$Condition, [Parameter(Mandatory = $true)][string]$Message)
  if (-not $Condition) { throw "ASSERTION FAILED: $Message" }
}

function Invoke-TestGit {
  param([Parameter(Mandatory = $true)][string[]]$Arguments)
  $output = @(& $git @Arguments 2>&1 | ForEach-Object { [string]$_ })
  if ($LASTEXITCODE -ne 0) { throw "git failed [$($Arguments -join ' ')]: $($output -join ' ')" }
  return (($output -join "`n").Trim())
}

function Invoke-Helper {
  param([Parameter(Mandatory = $true)][string[]]$Arguments)
  $output = @(& pwsh -NoLogo -NoProfile -File $helper @Arguments 2>&1 | ForEach-Object { [string]$_ })
  return [pscustomobject]@{ exitCode = $LASTEXITCODE; text = ($output -join "`n") }
}

function Remove-FixtureWorktree {
  param([Parameter(Mandatory = $true)][string]$Path)
  if (Test-Path -LiteralPath $Path -PathType Container) {
    Invoke-TestGit @('-C', $fixture, 'worktree', 'remove', '--', $Path) | Out-Null
  }
}

try {
  New-Item -ItemType Directory -Path $fixture -Force | Out-Null
  New-Item -ItemType Directory -Path $configDirectory -Force | Out-Null
  Invoke-TestGit @('-C', $fixture, 'init', '--initial-branch=main') | Out-Null
  Invoke-TestGit @('-C', $fixture, 'config', 'user.name', 'Babel Worktree Storage Test') | Out-Null
  Invoke-TestGit @('-C', $fixture, 'config', 'user.email', 'babel-worktree-storage@example.invalid') | Out-Null
  Set-Content -LiteralPath (Join-Path $fixture 'README.md') -Value '# fixture' -Encoding utf8
  Invoke-TestGit @('-C', $fixture, 'add', 'README.md') | Out-Null
  Invoke-TestGit @('-C', $fixture, 'commit', '-m', 'fixture base') | Out-Null
  Invoke-TestGit @('-C', $fixture, 'remote', 'add', 'origin', 'https://github.com/gthgomez/Babel.git') | Out-Null

  @{ schemaVersion = 1; canonicalWorkspace = $publicRoot; storageRoot = $storage; categories = @{ worktrees = 'worktrees'; evidence = 'evidence'; backups = 'backups'; quarantine = 'quarantine'; tmp = 'tmp' } } |
    ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $config -Encoding utf8

  $central = Invoke-Helper @('-Action', 'create', '-RepoRoot', $fixture, '-GitPath', $git, '-ExpectedRepository', 'gthgomez/Babel', '-StorageConfig', $config, '-Base', 'HEAD', '-Name', 'central', '-NoFetch')
  Assert-CentralStorageTest ($central.exitCode -eq 0) "central config create failed: $($central.text)"
  $centralRecord = $central.text | ConvertFrom-Json
  $centralExpected = Join-Path (Join-Path $storage 'worktrees') (Join-Path 'Babel-public-live' 'central')
  Assert-CentralStorageTest ([IO.Path]::GetFullPath($centralRecord.path) -eq [IO.Path]::GetFullPath($centralExpected)) 'central config path was not selected'
  Assert-CentralStorageTest ($centralRecord.branch -eq 'agent/central') 'default branch changed unexpectedly'
  Assert-CentralStorageTest ([bool]$centralRecord.isolated) 'central worktree is not isolated'
  Remove-FixtureWorktree -Path $centralRecord.path

  $overrideRoot = Join-Path $fixtureRoot 'explicit-worktrees'
  $override = Invoke-Helper @('-Action', 'create', '-RepoRoot', $fixture, '-GitPath', $git, '-ExpectedRepository', 'gthgomez/Babel', '-StorageConfig', $config, '-WorktreeRoot', $overrideRoot, '-Base', 'HEAD', '-Name', 'override', '-NoFetch')
  Assert-CentralStorageTest ($override.exitCode -eq 0) "explicit WorktreeRoot create failed: $($override.text)"
  $overrideRecord = $override.text | ConvertFrom-Json
  $overrideExpected = Join-Path $overrideRoot 'override'
  Assert-CentralStorageTest ([IO.Path]::GetFullPath($overrideRecord.path) -eq [IO.Path]::GetFullPath($overrideExpected)) 'explicit WorktreeRoot was not honored'
  Remove-FixtureWorktree -Path $overrideRecord.path

  $missingConfig = Join-Path $fixtureRoot 'missing-agent-storage.json'
  $fallback = Invoke-Helper @('-Action', 'create', '-RepoRoot', $fixture, '-GitPath', $git, '-ExpectedRepository', 'gthgomez/Babel', '-StorageConfig', $missingConfig, '-Base', 'HEAD', '-Name', 'fallback', '-NoFetch')
  Assert-CentralStorageTest ($fallback.exitCode -eq 0) "public-clone fallback create failed: $($fallback.text)"
  $fallbackRecord = $fallback.text | ConvertFrom-Json
  $fallbackExpected = Join-Path (Join-Path $fixtureRoot 'worktrees') (Join-Path 'Babel' 'fallback')
  Assert-CentralStorageTest ([IO.Path]::GetFullPath($fallbackRecord.path) -eq [IO.Path]::GetFullPath($fallbackExpected)) 'safe public-clone fallback was not selected'
  Remove-FixtureWorktree -Path $fallbackRecord.path

  $overlapOverride = Invoke-Helper @('-Action', 'create', '-RepoRoot', $fixture, '-GitPath', $git, '-ExpectedRepository', 'gthgomez/Babel', '-StorageConfig', $config, '-WorktreeRoot', (Join-Path $fixture 'inside'), '-Base', 'HEAD', '-Name', 'unsafe-override', '-NoFetch')
  Assert-CentralStorageTest ($overlapOverride.exitCode -ne 0) 'WorktreeRoot overlapping RepoRoot was accepted'

  $overlapConfig = Join-Path $fixtureRoot 'overlap-agent-storage.json'
  @{ schemaVersion = 1; canonicalWorkspace = $publicRoot; storageRoot = (Join-Path $publicRoot 'agent-data'); categories = @{ worktrees = 'worktrees'; evidence = 'evidence'; backups = 'backups'; quarantine = 'quarantine'; tmp = 'tmp' } } |
    ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $overlapConfig -Encoding utf8
  $overlap = Invoke-Helper @('-Action', 'create', '-RepoRoot', $fixture, '-GitPath', $git, '-ExpectedRepository', 'gthgomez/Babel', '-StorageConfig', $overlapConfig, '-Base', 'HEAD', '-Name', 'overlap', '-NoFetch')
  Assert-CentralStorageTest ($overlap.exitCode -ne 0) 'overlapping storage configuration was accepted'

  Write-Output 'PASS agent-worktree central storage and no-fetch checks'
} finally {
  if (Test-Path -LiteralPath $fixture -PathType Container) {
    & $git -C $fixture worktree prune 2>$null | Out-Null
  }
  $fixtureLeaf = Split-Path -Leaf $fixtureRoot
  $repoPrefix = [IO.Path]::GetFullPath($repoRoot).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
  $fixtureFull = [IO.Path]::GetFullPath($fixtureRoot).TrimEnd('\', '/')
  $ownsFixture = $fixtureLeaf -match '^\.tmp-agent-worktree-central-[0-9a-fA-F]{32}$' -and $fixtureFull.StartsWith($repoPrefix, [StringComparison]::OrdinalIgnoreCase)
  if ($ownsFixture -and (Test-Path -LiteralPath $fixtureRoot)) { Remove-Item -LiteralPath $fixtureRoot -Recurse -Force }
}
