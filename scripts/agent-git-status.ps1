[CmdletBinding()]
param(
  [string]$RepoRoot = (Join-Path $PSScriptRoot '..'),
  [string]$GitPath = (Join-Path $env:ProgramFiles 'Git\cmd\git.exe'),
  [string]$ExpectedRemote = 'origin',
  [string]$ExpectedRepository = 'gthgomez/Babel',
  [ValidateSet('json', 'text')][string]$OutputFormat = 'json'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path $PSScriptRoot 'agent-git-common.psm1') -Force

$resolvedRepoRoot = $null
$blockers = @()

try {
  $resolvedRepoRoot = (Resolve-Path -LiteralPath $RepoRoot -ErrorAction Stop).Path
  $envState = Set-AgentNonInteractiveEnvironment
  if (-not (Test-Path -LiteralPath $GitPath -PathType Leaf)) {
    $blockers += 'git_executable_unavailable'
    throw "Git executable not found: $GitPath"
  }

  $root = Get-AgentGitText -GitPath $GitPath -RepoRoot $resolvedRepoRoot -Arguments @('rev-parse', '--show-toplevel')
  $rootMatches = $false
  if (-not [string]::IsNullOrWhiteSpace($root)) {
    $rootMatches = [string]::Equals(
      (ConvertTo-AgentAbsolutePath -BasePath $resolvedRepoRoot -Path $root),
      $resolvedRepoRoot,
      [StringComparison]::OrdinalIgnoreCase
    )
  }
  if (-not $rootMatches) { $blockers += 'wrong_repository_root' }

  $status = Get-AgentStatusSnapshot -GitPath $GitPath -RepoRoot $resolvedRepoRoot
  if (-not $status.commandOk) { $blockers += 'git_status_failed' }
  $head = Get-AgentGitText -GitPath $GitPath -RepoRoot $resolvedRepoRoot -Arguments @('rev-parse', 'HEAD')
  $branchResult = Invoke-AgentGit -GitPath $GitPath -RepoRoot $resolvedRepoRoot -Arguments @('symbolic-ref', '--quiet', '--short', 'HEAD')
  $branch = if ($branchResult.exitCode -eq 0) { $branchResult.text.Trim() } else { $null }
  $remoteUrl = Get-AgentRemoteUrl -GitPath $GitPath -RepoRoot $resolvedRepoRoot -Remote $ExpectedRemote
  $remoteSlug = Get-AgentRemoteSlug -RemoteUrl $remoteUrl
  if (-not [string]::Equals($remoteSlug, $ExpectedRepository, [StringComparison]::OrdinalIgnoreCase)) {
    $blockers += 'unexpected_origin_repository'
  }
  if (-not (Test-AgentRemoteCredentialFree -RemoteUrl $remoteUrl)) { $blockers += 'token_bearing_remote_url' }

  $upstream = Get-AgentGitText -GitPath $GitPath -RepoRoot $resolvedRepoRoot -Arguments @('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}')
  $ahead = $null
  $behind = $null
  if (-not [string]::IsNullOrWhiteSpace($upstream)) {
    $counts = Get-AgentGitText -GitPath $GitPath -RepoRoot $resolvedRepoRoot -Arguments @('rev-list', '--left-right', '--count', "HEAD...$upstream")
    if ($counts -match '^\s*(\d+)\s+(\d+)\s*$') {
      $ahead = [int]$Matches[1]
      $behind = [int]$Matches[2]
    }
  }

  $credential = Get-AgentCredentialIsolation -GitPath $GitPath -RepoRoot $resolvedRepoRoot
  $topology = Get-AgentWorktreeTopology -GitPath $GitPath -RepoRoot $resolvedRepoRoot
  $gitVersionResult = Invoke-AgentGit -GitPath $GitPath -RepoRoot $resolvedRepoRoot -Arguments @('--version')
  $gitVersion = if ($gitVersionResult.exitCode -eq 0) { $gitVersionResult.text.Trim() } else { $null }
  $ok = $blockers.Count -eq 0
  $result = [ordered]@{
    schemaVersion = 1
    kind = 'babel_agent_git_status'
    ok = $ok
    repoRoot = $resolvedRepoRoot
    repository = $ExpectedRepository
    remote = $ExpectedRemote
    branch = $branch
    detached = $status.detached
    head = $head
    upstream = $upstream
    ahead = $ahead
    behind = $behind
    git = [ordered]@{ path = $GitPath; version = $gitVersion }
    environment = $envState
    credential = $credential
    worktree = [ordered]@{
      clean = $status.clean
      dirtyPaths = @($status.dirtyPaths)
      stagedCount = $status.stagedCount
      unstagedCount = $status.unstagedCount
      isolated = $topology.isolated
    }
    blockers = @($blockers | Select-Object -Unique)
  }
  Write-AgentResult -Result $result -OutputFormat $OutputFormat
  if (-not $ok) { exit 1 }
  exit 0
} catch {
  $fallback = [ordered]@{
    schemaVersion = 1
    kind = 'babel_agent_git_status'
    ok = $false
    repoRoot = $resolvedRepoRoot
    repository = $ExpectedRepository
    blockers = @($blockers + 'status_exception' | Select-Object -Unique)
    errorType = $_.Exception.GetType().FullName
  }
  Write-AgentResult -Result $fallback -OutputFormat $OutputFormat
  exit 1
}
