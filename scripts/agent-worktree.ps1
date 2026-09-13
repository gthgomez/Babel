<#
.SYNOPSIS
Creates or lists registered worktrees for the public Babel clone.

.DESCRIPTION
When the shared workspace config exists, create uses its worktrees category
under storageRoot and the canonical clone directory name. A supplied WorktreeRoot is
an explicit override. Clones without the shared config use a clone-local
public fallback. Use NoFetch for offline/local-base operation.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidateSet('create', 'list')][string]$Action,
  [string]$RepoRoot = (Join-Path $PSScriptRoot '..'),
  [string]$GitPath = (Join-Path $env:ProgramFiles 'Git\cmd\git.exe'),
  [string]$ExpectedRemote = 'origin',
  [string]$ExpectedRepository = 'gthgomez/Babel',
  [string]$WorktreeRoot = '',
  [string]$StorageConfig = (Join-Path $PSScriptRoot '..\..\config\agent-storage.json'),
  [string]$Name = '',
  [string]$Branch = '',
  [string]$Base = 'origin/main',
  [switch]$NoFetch,
  [ValidateSet('json', 'text')][string]$OutputFormat = 'json'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path $PSScriptRoot 'agent-git-common.psm1') -Force

$resolvedRepoRoot = $null
$blockers = @()

function Test-AgentPathUnder {
  param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Root)
  $pathFull = [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
  $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
  return [string]::Equals($pathFull, $rootFull, [StringComparison]::OrdinalIgnoreCase) -or
    $pathFull.StartsWith($rootFull + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
}

function Assert-AgentNoReparsePath {
  param([Parameter(Mandatory = $true)][string]$Path)
  $full = [IO.Path]::GetFullPath($Path)
  $pathRoot = [IO.Path]::GetPathRoot($full)
  $current = $pathRoot
  $relative = $full.Substring($pathRoot.Length).TrimStart('\', '/')
  foreach ($part in ($relative -split '[\\/]')) {
    if ([string]::IsNullOrEmpty($part)) { continue }
    $current = Join-Path $current $part
    if (-not (Test-Path -LiteralPath $current)) { break }
    $item = Get-Item -LiteralPath $current -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Reparse point in path: $current"
    }
  }
}

function Assert-AgentSafeSegment {
  param([Parameter(Mandatory = $true)][string]$Value, [Parameter(Mandatory = $true)][string]$Label)
  if ([string]::IsNullOrWhiteSpace($Value) -or $Value -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' -or $Value.Contains('..')) {
    throw "$Label contains unsupported path characters"
  }
}

function Resolve-AgentWorktreeRoot {
  param(
    [Parameter(Mandatory = $true)][string]$RepoRoot,
    [Parameter(Mandatory = $true)][string]$ConfigPath,
    [Parameter(Mandatory = $true)][string]$RepositorySlug,
    [Parameter(Mandatory = $true)][AllowEmptyString()][string]$ExplicitRoot
  )

  if (-not [string]::IsNullOrWhiteSpace($ExplicitRoot)) {
    return ConvertTo-AgentAbsolutePath -BasePath $RepoRoot -Path $ExplicitRoot
  }

  if (Test-Path -LiteralPath $ConfigPath -PathType Leaf) {
    Assert-AgentNoReparsePath -Path $ConfigPath
    $config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
    if ($config.schemaVersion -ne 1) { throw 'Storage config schemaVersion must be 1' }
    $canonicalWorkspace = [string]$config.canonicalWorkspace
    $storageRootValue = [string]$config.storageRoot
    if ([string]::IsNullOrWhiteSpace($canonicalWorkspace) -or [string]::IsNullOrWhiteSpace($storageRootValue)) {
      throw 'Storage config must define canonicalWorkspace and storageRoot'
    }
    if (-not [IO.Path]::IsPathFullyQualified($storageRootValue)) { throw 'Storage config storageRoot must be absolute' }
    $canonicalFull = (Resolve-Path -LiteralPath $canonicalWorkspace -ErrorAction Stop).Path.TrimEnd('\', '/')
    $storageFull = [IO.Path]::GetFullPath($storageRootValue).TrimEnd('\', '/')
    $storageDriveRoot = [IO.Path]::GetPathRoot($storageFull).TrimEnd('\', '/')
    if ([string]::Equals($storageFull, $storageDriveRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Storage config storageRoot must not be a drive root' }
    Assert-AgentNoReparsePath -Path $canonicalFull
    Assert-AgentNoReparsePath -Path $storageFull
    if (-not (Test-AgentPathUnder -Path $RepoRoot -Root $canonicalFull)) { throw 'RepoRoot is outside configured canonicalWorkspace' }
    if ((Test-AgentPathUnder -Path $storageFull -Root $canonicalFull) -or (Test-AgentPathUnder -Path $canonicalFull -Root $storageFull)) {
      throw 'Storage config canonicalWorkspace and storageRoot overlap'
    }
    $worktreesCategory = [string]$config.categories.worktrees
    Assert-AgentSafeSegment -Value $worktreesCategory -Label 'worktrees category'
    $root = Join-Path (Join-Path $storageFull $worktreesCategory) $RepositorySlug
    if (-not (Test-AgentPathUnder -Path $root -Root $storageFull)) { throw 'Configured worktree root escapes storageRoot' }
    Assert-AgentNoReparsePath -Path $root
    return $root
  }

  # A clone without the shared workspace config uses the historical, clone-local
  # public fallback. It never discovers or depends on a private parent tree.
  return ConvertTo-AgentAbsolutePath -BasePath $RepoRoot -Path '..\..\worktrees\Babel'
}

function Get-AgentWorktreeList {
  param([Parameter(Mandatory = $true)][string]$GitPath, [Parameter(Mandatory = $true)][string]$RepoRoot)
  $result = Invoke-AgentGit -GitPath $GitPath -RepoRoot $RepoRoot -Arguments @('worktree', 'list', '--porcelain')
  if ($result.exitCode -ne 0) { throw 'git worktree list failed' }
  $items = @()
  $current = $null
  foreach ($line in @($result.output | ForEach-Object { [string]$_ })) {
    if ($line.StartsWith('worktree ')) {
      if ($null -ne $current) { $items += $current }
      $current = [ordered]@{ path = $line.Substring(9); head = $null; branch = $null }
    } elseif ($null -ne $current -and $line.StartsWith('HEAD ')) {
      $current.head = $line.Substring(5)
    } elseif ($null -ne $current -and $line.StartsWith('branch ')) {
      $current.branch = $line.Substring(7) -replace '^refs/heads/', ''
    }
  }
  if ($null -ne $current) { $items += $current }
  return @($items)
}

try {
  $resolvedRepoRoot = (Resolve-Path -LiteralPath $RepoRoot -ErrorAction Stop).Path
  Assert-AgentNoReparsePath -Path $resolvedRepoRoot
  $envState = Set-AgentNonInteractiveEnvironment
  if (-not (Test-Path -LiteralPath $GitPath -PathType Leaf)) {
    $blockers += 'git_executable_unavailable'
    throw "Git executable not found: $GitPath"
  }

  $remoteUrl = Get-AgentRemoteUrl -GitPath $GitPath -RepoRoot $resolvedRepoRoot -Remote $ExpectedRemote
  $remoteSlug = Get-AgentRemoteSlug -RemoteUrl $remoteUrl
  if (-not [string]::Equals($remoteSlug, $ExpectedRepository, [StringComparison]::OrdinalIgnoreCase)) {
    $blockers += 'unexpected_origin_repository'
    throw 'The configured origin is not the expected public repository'
  }
  if (-not (Test-AgentRemoteCredentialFree -RemoteUrl $remoteUrl)) {
    $blockers += 'token_bearing_remote_url'
    throw 'The configured origin contains HTTP(S) credentials'
  }

  if ($Action -eq 'list') {
    $items = Get-AgentWorktreeList -GitPath $GitPath -RepoRoot $resolvedRepoRoot
    $result = [ordered]@{
      schemaVersion = 1
      kind = 'babel_agent_worktree'
      action = 'list'
      ok = $true
      repository = $ExpectedRepository
      worktrees = $items
      environment = $envState
      blockers = @()
    }
    Write-AgentResult -Result $result -OutputFormat $OutputFormat
    exit 0
  }

  if ([string]::IsNullOrWhiteSpace($Name)) { $blockers += 'worktree_name_required'; throw 'Name is required for create' }
  try { Assert-AgentSafeSegment -Value $Name -Label 'Name' } catch { $blockers += 'unsafe_worktree_name'; throw }
  if ([string]::IsNullOrWhiteSpace($Branch)) { $Branch = "agent/$Name" }
  if ($Branch -notmatch '^[A-Za-z0-9][A-Za-z0-9._/-]*$' -or $Branch.Contains('..')) {
    $blockers += 'unsafe_branch_name'
    throw 'Branch contains unsupported characters'
  }

  if (-not $NoFetch) {
    $fetchResult = Invoke-AgentGit -GitPath $GitPath -RepoRoot $resolvedRepoRoot -Arguments @('fetch', $ExpectedRemote, '--prune')
    if ($fetchResult.exitCode -ne 0) { $blockers += 'fetch_failed'; throw 'fetch failed' }
  }
  $baseSha = Get-AgentGitText -GitPath $GitPath -RepoRoot $resolvedRepoRoot -Arguments @('rev-parse', $Base)
  if (-not (Test-AgentSha -Value $baseSha)) { $blockers += 'base_sha_unavailable'; throw 'Base revision is unavailable' }

  $repositorySlug = Split-Path -Leaf $resolvedRepoRoot
  try { Assert-AgentSafeSegment -Value $repositorySlug -Label 'Repository name' } catch { $blockers += 'unsafe_repository_name'; throw }
  try { $root = Resolve-AgentWorktreeRoot -RepoRoot $resolvedRepoRoot -ConfigPath $StorageConfig -RepositorySlug $repositorySlug -ExplicitRoot $WorktreeRoot } catch { $blockers += 'storage_configuration_invalid'; throw }
  $rootFull = [IO.Path]::GetFullPath($root).TrimEnd('\', '/')
  $rootDrive = [IO.Path]::GetPathRoot($rootFull).TrimEnd('\', '/')
  if ([string]::Equals($rootFull, $rootDrive, [StringComparison]::OrdinalIgnoreCase)) {
    $blockers += 'worktree_root_is_drive_root'
    throw 'WorktreeRoot must not be a drive root'
  }
  if ((Test-AgentPathUnder -Path $rootFull -Root $resolvedRepoRoot) -or (Test-AgentPathUnder -Path $resolvedRepoRoot -Root $rootFull)) {
    $blockers += 'worktree_root_overlaps_repo'
    throw 'WorktreeRoot must not overlap RepoRoot'
  }
  Assert-AgentNoReparsePath -Path $root
  $target = ConvertTo-AgentAbsolutePath -BasePath $root -Path $Name
  if (-not (Test-AgentPathUnder -Path $target -Root $root)) {
    $blockers += 'worktree_path_outside_root'
    throw 'Resolved worktree path is outside WorktreeRoot'
  }
  if (Test-Path -LiteralPath $target) { $blockers += 'worktree_path_exists'; throw 'Worktree target already exists' }
  if (-not (Test-Path -LiteralPath $root)) { New-Item -ItemType Directory -Path $root -Force | Out-Null }
  Assert-AgentNoReparsePath -Path $root
  if (Test-Path -LiteralPath $target) { $blockers += 'worktree_path_exists'; throw 'Worktree target appeared during validation' }

  $branchCheck = Invoke-AgentGit -GitPath $GitPath -RepoRoot $resolvedRepoRoot -Arguments @('show-ref', '--verify', '--quiet', "refs/heads/$Branch")
  if ($branchCheck.exitCode -eq 0) {
    $addResult = Invoke-AgentGit -GitPath $GitPath -RepoRoot $resolvedRepoRoot -Arguments @('worktree', 'add', $target, $Branch)
  } else {
    $addResult = Invoke-AgentGit -GitPath $GitPath -RepoRoot $resolvedRepoRoot -Arguments @('worktree', 'add', '-b', $Branch, $target, $baseSha)
  }
  if ($addResult.exitCode -ne 0) { $blockers += 'worktree_create_failed'; throw 'git worktree add failed' }

  $createdHead = Get-AgentGitText -GitPath $GitPath -RepoRoot $target -Arguments @('rev-parse', 'HEAD')
  $createdTopology = Get-AgentWorktreeTopology -GitPath $GitPath -RepoRoot $target
  $result = [ordered]@{
    schemaVersion = 1
    kind = 'babel_agent_worktree'
    action = 'create'
    ok = $true
    repository = $ExpectedRepository
    path = $target
    branch = $Branch
    base = $Base
    baseSha = $baseSha
    head = $createdHead
    isolated = $createdTopology.isolated
    environment = $envState
    blockers = @()
  }
  Write-AgentResult -Result $result -OutputFormat $OutputFormat
  exit 0
} catch {
  $fallback = [ordered]@{
    schemaVersion = 1
    kind = 'babel_agent_worktree'
    action = $Action
    ok = $false
    repository = $ExpectedRepository
    blockers = @($blockers + 'worktree_exception' | Select-Object -Unique)
    errorType = $_.Exception.GetType().FullName
  }
  Write-AgentResult -Result $fallback -OutputFormat $OutputFormat
  exit 1
}
