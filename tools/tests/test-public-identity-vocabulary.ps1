[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$identityScript = Join-Path $repoRoot 'tools/check-public-identity.ps1'
$shell = (Get-Command pwsh -ErrorAction Stop).Source

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw "ASSERTION FAILED: $Message" }
}

$positive = & $shell -NoProfile -File $identityScript -RepoRoot $repoRoot
Assert-True ($LASTEXITCODE -eq 0) "repo identity check failed: $positive"

$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("babel-identity-{0}" -f [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tempRoot | Out-Null
try {
  foreach ($relative in @(
      'README.md', 'START_HERE.md', 'AGENTS.md', 'PROJECT_CONTEXT.md',
      'INTEGRATION.md', 'CONTRIBUTING.md', 'docs/README.md',
      'docs/CLI_QUICKSTART.md', 'docs/CHAT_MODE.md', 'docs/VISION.md',
      'docs/BABEL_USER_SHAPED_CLI_GUIDE.md', 'babel-cli/README.md'
    )) {
    $source = Join-Path $repoRoot $relative
    $dest = Join-Path $tempRoot $relative
    $destDir = Split-Path -Parent $dest
    if (-not (Test-Path -LiteralPath $destDir)) {
      New-Item -ItemType Directory -Path $destDir | Out-Null
    }
    Copy-Item -LiteralPath $source -Destination $dest
  }
  Add-Content -LiteralPath (Join-Path $tempRoot 'README.md') -Value "`nBabel is a prompt operating system.`n"
  & $shell -NoProfile -File $identityScript -RepoRoot $tempRoot | Out-Null
  Assert-True ($LASTEXITCODE -eq 1) 'stale identity fixture unexpectedly passed'
}
finally {
  try { Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue } catch { }
}

Write-Host 'test-public-identity-vocabulary: pass'
