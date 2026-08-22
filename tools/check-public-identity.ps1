[CmdletBinding()]
param(
  [string]$RepoRoot = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
  $scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Path $PSCommandPath -Parent }
  $RepoRoot = (Resolve-Path (Join-Path $scriptDir '..')).Path
} else {
  $RepoRoot = (Resolve-Path $RepoRoot).Path
}

# Front-door / canonical user-facing docs only. Architecture and history
# documents are out of scope.
$frontDoor = @(
  'README.md',
  'START_HERE.md',
  'AGENTS.md',
  'PROJECT_CONTEXT.md',
  'INTEGRATION.md',
  'CONTRIBUTING.md',
  'docs/README.md',
  'docs/CLI_QUICKSTART.md',
  'docs/CHAT_MODE.md',
  'docs/VISION.md',
  'docs/BABEL_USER_SHAPED_CLI_GUIDE.md',
  'docs/CLI_COMMAND_CONTRACT.md',
  'babel-cli/README.md'
)

$stalePatterns = @(
  @{ Id = 'ID001'; Pattern = '(?i)Babel is a (layered )?prompt operating system'; Why = 'primary identity must be coding-agent harness' },
  @{ Id = 'ID002'; Pattern = '(?i)\bbl ask\b'; Why = 'removed compatibility shim; do not teach' },
  @{ Id = 'ID003'; Pattern = '(?i)babel-lite ask'; Why = 'removed compatibility shim; do not teach' },
  @{ Id = 'ID004'; Pattern = '(?i)--mode[= ]autonomous\b'; Why = 'legacy mode; use deep' },
  @{ Id = 'ID005'; Pattern = '(?i)-PipelineMode[= ]verified\b'; Why = 'legacy mode; use deep' },
  @{ Id = 'ID006'; Pattern = '(?i)-PipelineMode[= ]direct\b'; Why = 'legacy mode; use chat' }
)

$allowPattern = '(?i)legacy|maps to|compatibility|historical|was removed|deprecated|no longer|do not (use|teach)|not the current product'

$findings = [System.Collections.Generic.List[string]]::new()

foreach ($relative in $frontDoor) {
  $path = Join-Path $RepoRoot $relative
  if (-not (Test-Path -LiteralPath $path)) {
    $findings.Add("MISSING  $relative")
    continue
  }
  $lines = Get-Content -LiteralPath $path
  for ($i = 0; $i -lt $lines.Count; $i++) {
    $line = $lines[$i]
    if ($line -match $allowPattern) { continue }
    foreach ($rule in $stalePatterns) {
      if ($line -match $rule.Pattern) {
        $findings.Add(("{0}  {1}:{2}  {3}" -f $rule.Id, $relative, ($i + 1), $rule.Why))
      }
    }
  }
}

if ($findings.Count -gt 0) {
  Write-Host 'Public identity vocabulary check failed:' -ForegroundColor Red
  foreach ($finding in $findings) {
    Write-Host ("  {0}" -f $finding)
  }
  exit 1
}

Write-Host 'Public identity vocabulary check passed.'
exit 0
