Set-StrictMode -Version Latest

function Set-AgentNonInteractiveEnvironment {
  $env:GIT_TERMINAL_PROMPT = '0'
  $env:GIT_EDITOR = 'true'
  $env:GH_PROMPT_DISABLED = '1'
  return [ordered]@{
    gitTerminalPrompt = $env:GIT_TERMINAL_PROMPT
    gitEditor = $env:GIT_EDITOR
    ghPromptDisabled = $env:GH_PROMPT_DISABLED
  }
}

function Invoke-AgentProcess {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [string[]]$Arguments = @(),
    [Parameter(Mandatory = $true)][string]$WorkingDirectory
  )

  $output = @()
  $exitCode = 127
  try {
    Push-Location -LiteralPath $WorkingDirectory
    try {
      foreach ($line in @(& $FilePath @Arguments 2>&1)) {
        $output += [string]$line
      }
      $exitCode = $LASTEXITCODE
    } finally {
      Pop-Location
    }
  } catch {
    $output += $_.Exception.Message
  }
  return [pscustomobject]@{
    exitCode = $exitCode
    output = @($output)
    text = ($output -join "`n")
  }
}

function Get-AgentCommandPath {
  param([Parameter(Mandatory = $true)][string]$Name)
  $command = Get-Command -Name $Name -ErrorAction Stop | Select-Object -First 1
  if ([string]::IsNullOrWhiteSpace($command.Source) -and [string]::IsNullOrWhiteSpace($command.Path)) {
    throw "Executable path unavailable for $Name"
  }
  if (-not [string]::IsNullOrWhiteSpace($command.Source)) { return $command.Source }
  return $command.Path
}

function Get-AgentGitText {
  param(
    [Parameter(Mandatory = $true)][string]$GitPath,
    [Parameter(Mandatory = $true)][string]$RepoRoot,
    [Parameter(Mandatory = $true)][string[]]$Arguments
  )
  $result = Invoke-AgentProcess -FilePath $GitPath -Arguments $Arguments -WorkingDirectory $RepoRoot
  if ($result.exitCode -ne 0) { return $null }
  return $result.text.Trim()
}

function Invoke-AgentGit {
  param(
    [Parameter(Mandatory = $true)][string]$GitPath,
    [Parameter(Mandatory = $true)][string]$RepoRoot,
    [Parameter(Mandatory = $true)][string[]]$Arguments
  )
  return Invoke-AgentProcess -FilePath $GitPath -Arguments $Arguments -WorkingDirectory $RepoRoot
}

function Invoke-AgentGh {
  param(
    [Parameter(Mandatory = $true)][string]$GhPath,
    [Parameter(Mandatory = $true)][string]$RepoRoot,
    [Parameter(Mandatory = $true)][string[]]$Arguments
  )
  return Invoke-AgentProcess -FilePath $GhPath -Arguments $Arguments -WorkingDirectory $RepoRoot
}

function Get-AgentRemoteUrl {
  param(
    [Parameter(Mandatory = $true)][string]$GitPath,
    [Parameter(Mandatory = $true)][string]$RepoRoot,
    [Parameter(Mandatory = $true)][string]$Remote
  )
  $declared = Get-AgentGitText -GitPath $GitPath -RepoRoot $RepoRoot -Arguments @('config', '--local', '--get', "remote.$Remote.url")
  if (-not [string]::IsNullOrWhiteSpace($declared)) { return $declared }
  return Get-AgentGitText -GitPath $GitPath -RepoRoot $RepoRoot -Arguments @('remote', 'get-url', $Remote)
}

function ConvertTo-AgentAbsolutePath {
  param(
    [Parameter(Mandatory = $true)][string]$BasePath,
    [Parameter(Mandatory = $true)][string]$Path
  )
  if ([IO.Path]::IsPathRooted($Path)) { return [IO.Path]::GetFullPath($Path) }
  return [IO.Path]::GetFullPath((Join-Path $BasePath $Path))
}

function Get-AgentRemoteSlug {
  param([AllowNull()][string]$RemoteUrl)
  if ([string]::IsNullOrWhiteSpace($RemoteUrl)) { return $null }
  $value = $RemoteUrl.Trim()
  if ($value -notmatch '(?i)github\.com[:/]') { return $null }
  $slug = ($value -replace '(?i)^.*github\.com[:/]', '').TrimEnd('/')
  if ($slug.EndsWith('.git')) { $slug = $slug.Substring(0, $slug.Length - 4) }
  if ($slug -notmatch '^[^/\s]+/[^/\s]+$') { return $null }
  return $slug
}

function Test-AgentRemoteCredentialFree {
  param([AllowNull()][string]$RemoteUrl)
  if ([string]::IsNullOrWhiteSpace($RemoteUrl)) { return $false }
  return $RemoteUrl -notmatch '(?i)^https?://[^/\s@]+@'
}

function Test-AgentSha {
  param([AllowNull()][string]$Value)
  return (-not [string]::IsNullOrWhiteSpace($Value)) -and ($Value -match '^[0-9a-fA-F]{40}$')
}

function Get-AgentStatusSnapshot {
  param(
    [Parameter(Mandatory = $true)][string]$GitPath,
    [Parameter(Mandatory = $true)][string]$RepoRoot
  )
  $result = Invoke-AgentGit -GitPath $GitPath -RepoRoot $RepoRoot -Arguments @('status', '--porcelain=v2', '--branch', '--untracked-files=all')
  $lines = @($result.output | ForEach-Object { [string]$_ })
  $entries = @($lines | Where-Object { -not $_.StartsWith('#') -and -not [string]::IsNullOrWhiteSpace($_) })
  $dirtyPaths = @()
  $stagedCount = 0
  $unstagedCount = 0

  foreach ($line in $entries) {
    $path = $null
    if ($line.StartsWith('? ')) {
      $path = $line.Substring(2)
      $unstagedCount++
    } elseif ($line.StartsWith('2 ') -and $line.Contains("`t")) {
      $beforeTab = $line.Split("`t")[0]
      $parts = $beforeTab -split ' ', 10
      if ($parts.Count -ge 9) { $path = $parts[8] }
      if ($parts.Count -ge 2 -and $parts[1][0] -ne '.') { $stagedCount++ }
      if ($parts.Count -ge 2 -and $parts[1][1] -ne '.') { $unstagedCount++ }
    } else {
      $parts = $line -split ' ', 10
      if ($parts.Count -ge 2 -and $parts[0] -in @('1', 'u')) {
        $xy = $parts[1]
        if ($parts.Count -ge 9) { $path = $parts[8] }
        if ($xy.Length -ge 1 -and $xy[0] -ne '.') { $stagedCount++ }
        if ($xy.Length -ge 2 -and $xy[1] -ne '.') { $unstagedCount++ }
      }
    }
    if (-not [string]::IsNullOrWhiteSpace($path)) { $dirtyPaths += $path }
  }

  $branch = ($lines | Where-Object { $_.StartsWith('# branch.head ') } | Select-Object -First 1)
  if ($branch) { $branch = $branch.Substring('# branch.head '.Length) }
  if ($branch -eq '(detached)') { $branch = $null }
  return [ordered]@{
    commandOk = ($result.exitCode -eq 0)
    branch = $branch
    detached = [string]::IsNullOrWhiteSpace($branch)
    clean = ($entries.Count -eq 0)
    stagedCount = $stagedCount
    unstagedCount = $unstagedCount
    dirtyPaths = @($dirtyPaths | Select-Object -Unique)
    rawEntryCount = $entries.Count
  }
}

function Get-AgentWorktreeTopology {
  param(
    [Parameter(Mandatory = $true)][string]$GitPath,
    [Parameter(Mandatory = $true)][string]$RepoRoot
  )
  $gitDir = Get-AgentGitText -GitPath $GitPath -RepoRoot $RepoRoot -Arguments @('rev-parse', '--git-dir')
  $commonDir = Get-AgentGitText -GitPath $GitPath -RepoRoot $RepoRoot -Arguments @('rev-parse', '--git-common-dir')
  if ($null -eq $gitDir -or $null -eq $commonDir) {
    return [ordered]@{ available = $false; isolated = $false; gitDir = $null; commonDir = $null }
  }
  $gitDirAbsolute = ConvertTo-AgentAbsolutePath -BasePath $RepoRoot -Path $gitDir
  $commonDirAbsolute = ConvertTo-AgentAbsolutePath -BasePath $RepoRoot -Path $commonDir
  return [ordered]@{
    available = $true
    isolated = (-not [string]::Equals($gitDirAbsolute, $commonDirAbsolute, [StringComparison]::OrdinalIgnoreCase))
    gitDir = $gitDirAbsolute
    commonDir = $commonDirAbsolute
  }
}

function Get-AgentCredentialIsolation {
  param(
    [Parameter(Mandatory = $true)][string]$GitPath,
    [Parameter(Mandatory = $true)][string]$RepoRoot
  )
  $helpersResult = Invoke-AgentGit -GitPath $GitPath -RepoRoot $RepoRoot -Arguments @('config', '--local', '--get-all', 'credential.helper')
  $helpers = @($helpersResult.output | ForEach-Object { [string]$_ } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
  $topology = Get-AgentWorktreeTopology -GitPath $GitPath -RepoRoot $RepoRoot
  $configPath = $null
  $configText = ''
  if ($topology.available) {
    $configCandidates = @(
      (Join-Path $topology.gitDir 'config'),
      (Join-Path $topology.commonDir 'config')
    )
    foreach ($candidate in $configCandidates) {
      if (Test-Path -LiteralPath $candidate -PathType Leaf) {
        $configPath = $candidate
        $configText = Get-Content -LiteralPath $candidate -Raw
        break
      }
    }
  }
  $hasReset = $configText -match '(?ms)^\[credential\]\s*\r?\n(?:(?!^\[).)*?^\s*helper\s*=\s*\r?$'
  $hasGh = @($helpers | Where-Object { $_ -match '(?i)gh(?:\.exe)?\s+auth\s+git-credential' }).Count -gt 0
  return [ordered]@{
    provider = if ($hasGh -and $hasReset) { 'gh' } elseif ($hasGh) { 'gh_with_inherited_helpers' } else { 'unknown' }
    localGhHelper = $hasGh
    resetInheritedHelpers = $hasReset
    localHelperCount = $helpers.Count
    configPathObserved = ($null -ne $configPath)
  }
}

function Write-AgentResult {
  param(
    [Parameter(Mandatory = $true)][object]$Result,
    [ValidateSet('json', 'text')][string]$OutputFormat = 'json'
  )
  if ($OutputFormat -eq 'text') {
    $isDictionary = $Result -is [System.Collections.IDictionary]
    $kind = if ($isDictionary -and $Result.Contains('kind')) { $Result['kind'] } elseif ($Result.PSObject.Properties.Name -contains 'kind') { $Result.kind } else { 'agent_result' }
    $status = if ($isDictionary -and $Result.Contains('status')) { $Result['status'] } elseif ($isDictionary -and $Result.Contains('ok')) { $Result['ok'] } elseif ($Result.PSObject.Properties.Name -contains 'status') { $Result.status } elseif ($Result.PSObject.Properties.Name -contains 'ok') { $Result.ok } else { 'unknown' }
    Write-Output "kind=$kind status=$status"
    return
  }
  Write-Output ($Result | ConvertTo-Json -Depth 20)
}

Export-ModuleMember -Function @(
  'Set-AgentNonInteractiveEnvironment',
  'Invoke-AgentProcess',
  'Get-AgentCommandPath',
  'Get-AgentGitText',
  'Invoke-AgentGit',
  'Invoke-AgentGh',
  'Get-AgentRemoteUrl',
  'ConvertTo-AgentAbsolutePath',
  'Get-AgentRemoteSlug',
  'Test-AgentRemoteCredentialFree',
  'Test-AgentSha',
  'Get-AgentStatusSnapshot',
  'Get-AgentWorktreeTopology',
  'Get-AgentCredentialIsolation',
  'Write-AgentResult'
)
