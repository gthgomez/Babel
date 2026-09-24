Set-StrictMode -Version Latest

function Get-PullRequestCommitPaths {
  param([Parameter(Mandatory = $true)]$Event)

  $owner = [string]$Event.repository.owner.login
  $repository = [string]$Event.repository.name
  $repositoryId = [string]$Event.repository.id
  $number = [string]$Event.pull_request.number
  if ($owner -notmatch '^[A-Za-z0-9_.-]+$' -or
      $repository -notmatch '^[A-Za-z0-9_.-]+$' -or
      $repositoryId -notmatch '^[1-9][0-9]*$' -or
      $number -notmatch '^[1-9][0-9]*$') {
    throw 'GitHub pull request event metadata is incomplete.'
  }

  return @(
    "/repos/$owner/$repository/pulls/$number/commits",
    "/repositories/$repositoryId/pulls/$number/commits"
  )
}

function Test-PullRequestCommitPageUri {
  param(
    [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Url,
    [Parameter(Mandatory = $true)][string[]]$AllowedPaths
  )

  $uri = $null
  if (-not [Uri]::TryCreate($Url, [UriKind]::Absolute, [ref]$uri)) { return $false }
  if ($uri.Scheme -cne 'https' -or
      -not [string]::Equals($uri.Host, 'api.github.com', [StringComparison]::OrdinalIgnoreCase) -or
      -not $uri.IsDefaultPort -or
      -not [string]::IsNullOrEmpty($uri.UserInfo) -or
      -not [string]::IsNullOrEmpty($uri.Fragment)) {
    return $false
  }

  foreach ($path in $AllowedPaths) {
    if ([string]::Equals($uri.AbsolutePath, $path, [StringComparison]::Ordinal)) { return $true }
  }
  return $false
}

Export-ModuleMember -Function Get-PullRequestCommitPaths, Test-PullRequestCommitPageUri
