[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidateSet('create', 'list')][string]$Action,
  [string]$RepoRoot = (Join-Path $PSScriptRoot '..'),
  [string]$GitPath = (Join-Path $env:ProgramFiles 'Git\cmd\git.exe'),
  [string]$ExpectedRemote = 'origin',
  [string]$ExpectedRepository = 'gthgomez/Babel',
  [string]$WorktreeRoot = (Join-Path (Join-Path $PSScriptRoot '..') '..\worktrees\Babel'),
  [string]$Name = '',
  [string]$Branch = '',
  [string]$Base = 'origin/main',
  [ValidateSet('json', 'text')][string]$OutputFormat = 'json'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'agent-git-common.ps1')

$resolvedRepoRoot = $null
$blockers = [System.Collections.Generic.List[string]]::new()

function Get-AgentWorktreeList {
  param([Parameter(Mandatory = $true)][string]$GitPath, [Parameter(Mandatory = $true)][string]$RepoRoot)
  $result = Invoke-AgentGit -GitPath $GitPath -RepoRoot $RepoRoot -Arguments @('worktree', 'list', '--porcelain')
  if ($result.exitCode -ne 0) { throw 'git worktree list failed' }
  $items = [System.Collections.Generic.List[object]]::new()
  $current = $null
  foreach ($line in @($result.output | ForEach-Object { [string]$_ })) {
    if ($line.StartsWith('worktree ')) {
      if ($null -ne $current) { $items.Add($current) }
      $current = [ordered]@{ path = $line.Substring(9); head = $null; branch = $null }
    } elseif ($null -ne $current -and $line.StartsWith('HEAD ')) {
      $current.head = $line.Substring(5)
    } elseif ($null -ne $current -and $line.StartsWith('branch ')) {
      $current.branch = $line.Substring(7) -replace '^refs/heads/', ''
    }
  }
  if ($null -ne $current) { $items.Add($current) }
  return @($items)
}

try {
  $resolvedRepoRoot = (Resolve-Path -LiteralPath $RepoRoot -ErrorAction Stop).Path
  $envState = Set-AgentNonInteractiveEnvironment
  if (-not (Test-Path -LiteralPath $GitPath -PathType Leaf)) {
    $blockers.Add('git_executable_unavailable')
    throw "Git executable not found: $GitPath"
  }

  $remoteUrl = Get-AgentRemoteUrl -GitPath $GitPath -RepoRoot $resolvedRepoRoot -Remote $ExpectedRemote
  $remoteSlug = Get-AgentRemoteSlug -RemoteUrl $remoteUrl
  if (-not [string]::Equals($remoteSlug, $ExpectedRepository, [StringComparison]::OrdinalIgnoreCase)) {
    $blockers.Add('unexpected_origin_repository')
    throw 'The configured origin is not the expected public repository'
  }
  if (-not (Test-AgentRemoteCredentialFree -RemoteUrl $remoteUrl)) {
    $blockers.Add('token_bearing_remote_url')
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

  if ([string]::IsNullOrWhiteSpace($Name)) { $blockers.Add('worktree_name_required'); throw 'Name is required for create' }
  if ($Name -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') { $blockers.Add('unsafe_worktree_name'); throw 'Name contains unsupported path characters' }
  if ([string]::IsNullOrWhiteSpace($Branch)) { $Branch = "agent/$Name" }
  if ($Branch -notmatch '^[A-Za-z0-9][A-Za-z0-9._/-]*$' -or $Branch.Contains('..')) {
    $blockers.Add('unsafe_branch_name')
    throw 'Branch contains unsupported characters'
  }

  $fetchResult = Invoke-AgentGit -GitPath $GitPath -RepoRoot $resolvedRepoRoot -Arguments @('fetch', $ExpectedRemote, '--prune')
  if ($fetchResult.exitCode -ne 0) { $blockers.Add('fetch_failed'); throw 'fetch failed' }
  $baseSha = Get-AgentGitText -GitPath $GitPath -RepoRoot $resolvedRepoRoot -Arguments @('rev-parse', $Base)
  if (-not (Test-AgentSha -Value $baseSha)) { $blockers.Add('base_sha_unavailable'); throw 'Base revision is unavailable' }

  $root = ConvertTo-AgentAbsolutePath -BasePath $resolvedRepoRoot -Path $WorktreeRoot
  $target = ConvertTo-AgentAbsolutePath -BasePath $root -Path $Name
  $rootWithSeparator = $root.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
  if (-not $target.StartsWith($rootWithSeparator, [StringComparison]::OrdinalIgnoreCase)) {
    $blockers.Add('worktree_path_outside_root')
    throw 'Resolved worktree path is outside WorktreeRoot'
  }
  if (Test-Path -LiteralPath $target) { $blockers.Add('worktree_path_exists'); throw 'Worktree target already exists' }
  if (-not (Test-Path -LiteralPath $root)) { New-Item -ItemType Directory -Path $root -Force | Out-Null }

  $branchCheck = Invoke-AgentGit -GitPath $GitPath -RepoRoot $resolvedRepoRoot -Arguments @('show-ref', '--verify', '--quiet', "refs/heads/$Branch")
  if ($branchCheck.exitCode -eq 0) {
    $addResult = Invoke-AgentGit -GitPath $GitPath -RepoRoot $resolvedRepoRoot -Arguments @('worktree', 'add', $target, $Branch)
  } else {
    $addResult = Invoke-AgentGit -GitPath $GitPath -RepoRoot $resolvedRepoRoot -Arguments @('worktree', 'add', '-b', $Branch, $target, $baseSha)
  }
  if ($addResult.exitCode -ne 0) { $blockers.Add('worktree_create_failed'); throw 'git worktree add failed' }

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
