[CmdletBinding()]
param(
  [string]$RepoRoot = (Split-Path -Parent $PSScriptRoot),
  [string]$PolicyPath = '',
  [AllowEmptyString()]
  [string]$Title = '',
  [AllowEmptyString()]
  [string]$Body = '',
  [string[]]$CommitMessages = @(),
  [string]$SupplementalPolicyBase64 = '',
  [switch]$RequireSupplementalPolicy,
  [ValidateSet('human', 'json')]
  [string]$OutputFormat = 'human'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path
if ([string]::IsNullOrWhiteSpace($PolicyPath)) {
  $PolicyPath = Join-Path $RepoRoot 'tools/security/public-pr-metadata-policy.json'
}
if (-not (Test-Path -LiteralPath $PolicyPath -PathType Leaf)) {
  throw 'Public PR metadata policy was not found.'
}
try {
  $policy = Get-Content -Raw -LiteralPath $PolicyPath | ConvertFrom-Json
} catch {
  throw 'Public PR metadata policy is malformed.'
}

function Add-RegexRules {
  param([object[]]$Rules, [string]$DefaultId, [string]$DefaultCategory, [Collections.Generic.List[object]]$Destination)
  foreach ($rule in @($Rules)) {
    $id = if ($rule -is [string]) { $DefaultId } else { [string]$rule.id }
    $category = if ($rule -is [string]) { $DefaultCategory } else { [string]$rule.category }
    $pattern = if ($rule -is [string]) { [string]$rule } else { [string]$rule.pattern }
    if ([string]::IsNullOrWhiteSpace($id) -or [string]::IsNullOrWhiteSpace($category) -or [string]::IsNullOrWhiteSpace($pattern)) {
      throw 'Public PR metadata policy contains an invalid rule.'
    }
    try {
      $regex = [regex]::new($pattern, [Text.RegularExpressions.RegexOptions]::CultureInvariant, [TimeSpan]::FromSeconds(2))
    } catch {
      throw 'Public PR metadata policy contains an invalid pattern.'
    }
    $Destination.Add([pscustomobject]@{ id = $id; category = $category; regex = $regex })
  }
}

function Get-SupplementalPolicy {
  param([string]$EncodedPolicy, [switch]$Required)
  if ([string]::IsNullOrWhiteSpace($EncodedPolicy)) {
    if ($Required) { throw 'A supplemental metadata policy is required but was not configured.' }
    return $null
  }
  try {
    $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($EncodedPolicy))
    $supplemental = $json | ConvertFrom-Json
  } catch {
    throw 'Configured supplemental metadata policy is malformed.'
  }
  $identifiers = @($supplemental.forbidden_private_identifiers)
  if ($Required -and $identifiers.Count -eq 0) {
    throw 'The required supplemental metadata policy contains no denylist entries.'
  }
  return $supplemental
}

function Get-PullRequestCommitUrl {
  param([object]$Event)
  $owner = [string]$Event.repository.owner.login
  $repository = [string]$Event.repository.name
  $number = [string]$Event.pull_request.number
  if ($owner -notmatch '^[A-Za-z0-9_.-]+$' -or $repository -notmatch '^[A-Za-z0-9_.-]+$' -or $number -notmatch '^[1-9][0-9]*$') {
    throw 'GitHub pull request event metadata is incomplete.'
  }
  return "https://api.github.com/repos/$owner/$repository/pulls/$number/commits?per_page=100"
}

function Get-PullRequestCommits {
  param([string]$Url, [string]$ExpectedPath)
  try {
    $uri = [Uri]$Url
    if ($uri.Scheme -ne 'https' -or $uri.Host -ne 'api.github.com' -or $uri.AbsolutePath -ne $ExpectedPath) { throw 'invalid endpoint' }
    if ([string]::IsNullOrWhiteSpace($env:GITHUB_TOKEN)) { throw 'missing token' }
    $commits = [Collections.Generic.List[object]]::new()
    $client = [Net.Http.HttpClient]::new()
    $client.DefaultRequestHeaders.Authorization = [Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer', $env:GITHUB_TOKEN)
    $client.DefaultRequestHeaders.Accept.Add([Net.Http.Headers.MediaTypeWithQualityHeaderValue]::new('application/vnd.github+json'))
    $client.DefaultRequestHeaders.Add('X-GitHub-Api-Version', '2022-11-28')
    $client.DefaultRequestHeaders.UserAgent.ParseAdd('Babel-public-metadata-check')
    try {
      while ($null -ne $uri) {
        $response = $client.GetAsync($uri.AbsoluteUri).GetAwaiter().GetResult()
        if (-not $response.IsSuccessStatusCode) { throw "HTTP $([int]$response.StatusCode)" }
        $content = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        foreach ($commit in @($content | ConvertFrom-Json)) {
          $commits.Add([pscustomobject]@{ sha = [string]$commit.sha; message = [string]$commit.commit.message })
        }
        $next = $null
        $linkHeader = ''
        if ($response.Headers.Contains('Link')) { $linkHeader = [string](@($response.Headers.GetValues('Link')) -join ', ') }
        if ($linkHeader -match '<([^>]+)>;\s*rel="next"') { $next = $Matches[1] }
        if ($next) {
          $nextUri = [Uri]$next
          if ($nextUri.Scheme -ne 'https' -or $nextUri.Host -ne 'api.github.com' -or $nextUri.AbsolutePath -ne $ExpectedPath) { throw 'invalid pagination endpoint' }
          $uri = $nextUri
        } else {
          $uri = $null
        }
        $response.Dispose()
      }
    } finally {
      $client.Dispose()
    }
    return @($commits)
  } catch {
    $statusCode = ''
    $responseProperty = $_.Exception.PSObject.Properties['Response']
    if ($null -ne $responseProperty -and $null -ne $responseProperty.Value) {
      $statusProperty = $responseProperty.Value.PSObject.Properties['StatusCode']
      if ($null -ne $statusProperty) {
        try { $statusCode = [string][int]$statusProperty.Value } catch { $statusCode = '' }
      }
    }
    if ($statusCode) { throw "Pull request commit metadata could not be read (HTTP $statusCode)." }
    $detail = [string]$_.Exception.Message
    if ($detail.Length -gt 160) { $detail = $detail.Substring(0, 160) }
    throw "Pull request commit metadata could not be read ($detail)."
  }
}

$phraseRules = [Collections.Generic.List[object]]::new()
Add-RegexRules -Rules @($policy.forbidden_phrases) -DefaultId 'PRMETA001' -DefaultCategory 'private-lineage-terminology' -Destination $phraseRules

if ([string]::IsNullOrWhiteSpace($SupplementalPolicyBase64)) {
  $SupplementalPolicyBase64 = [string]$env:BABEL_PRIVATE_METADATA_POLICY_B64
}
$supplemental = Get-SupplementalPolicy -EncodedPolicy $SupplementalPolicyBase64 -Required:$RequireSupplementalPolicy
if ($null -ne $supplemental) {
  Add-RegexRules -Rules @($supplemental.forbidden_private_identifiers) -DefaultId 'PRMETA002' -DefaultCategory 'private-identifier' -Destination $phraseRules
}

$commitApiUrl = ''
$commitApiPath = ''
if ($PSBoundParameters.ContainsKey('Title') -or $PSBoundParameters.ContainsKey('Body')) {
  # Explicit values are used by tests and local callers.
} elseif (-not [string]::IsNullOrWhiteSpace($env:GITHUB_EVENT_PATH) -and (Test-Path -LiteralPath $env:GITHUB_EVENT_PATH)) {
  try {
    $event = Get-Content -Raw -LiteralPath $env:GITHUB_EVENT_PATH | ConvertFrom-Json
    $Title = [string]$event.pull_request.title
    $Body = [string]$event.pull_request.body
    $commitApiUrl = Get-PullRequestCommitUrl -Event $event
    $commitApiPath = ([Uri]$commitApiUrl).AbsolutePath
  } catch {
    throw 'GitHub pull request event metadata could not be parsed.'
  }
}

if ($CommitMessages.Count -eq 0 -and -not [string]::IsNullOrWhiteSpace($commitApiUrl)) {
  $CommitMessages = @(Get-PullRequestCommits -Url $commitApiUrl -ExpectedPath $commitApiPath)
}

$findings = [Collections.Generic.List[object]]::new()
function Add-Finding {
  param([string]$Id, [string]$Category, [string]$Field)
  $findings.Add([pscustomobject]@{ id = $Id; category = $Category; field = $Field })
}
function Test-MetadataField {
  param([string]$Field, [AllowEmptyString()][string]$Value)
  foreach ($rule in $phraseRules) {
    try {
      if ($rule.regex.IsMatch($Value)) { Add-Finding -Id ([string]$rule.id) -Category ([string]$rule.category) -Field $Field }
    } catch [Text.RegularExpressions.RegexMatchTimeoutException] {
      throw 'Public PR metadata policy pattern timed out.'
    }
  }
}

Test-MetadataField -Field 'pull-request-title' -Value $Title
Test-MetadataField -Field 'pull-request-body' -Value $Body
foreach ($entry in @($CommitMessages)) {
  if ($entry -is [string]) {
    Test-MetadataField -Field 'commit-message' -Value $entry
  } else {
    $shortSha = if ([string]$entry.sha) { ([string]$entry.sha).Substring(0, [Math]::Min(12, ([string]$entry.sha).Length)) } else { 'unknown' }
    Test-MetadataField -Field ("commit:{0}" -f $shortSha) -Value ([string]$entry.message)
  }
}

$ordered = @($findings | Sort-Object id, category, field -Unique)
$result = [ordered]@{ status = if ($ordered.Count -eq 0) { 'pass' } else { 'fail' }; findings = $ordered }
if ($OutputFormat -eq 'json') {
  $result | ConvertTo-Json -Depth 5
} elseif ($ordered.Count -eq 0) {
  Write-Host 'Public PR metadata policy passed.' -ForegroundColor Green
} else {
  Write-Host 'Public PR metadata policy errors:' -ForegroundColor Red
  $ordered | ForEach-Object { Write-Host ("  {0} [{1}] {2}" -f $_.id, $_.category, $_.field) }
}

if ($ordered.Count -gt 0) { exit 1 }
