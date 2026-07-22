param(
  [string]$RepoRoot = (Split-Path -Parent $PSScriptRoot),
  [switch]$Strict,
  [string]$ReportPath = '',
  [string]$PolicyPath = ''
)

$ErrorActionPreference = 'Stop'
Set-Location $RepoRoot

$rgCommand = Get-Command rg -ErrorAction SilentlyContinue

if (-not $PolicyPath) {
  $livePolicy = Join-Path $RepoRoot 'tools/security/policy.json'
  $legacyPolicy = Join-Path $RepoRoot 'tools/public-export/sync_policy.json'
  if (Test-Path -LiteralPath $livePolicy) {
    $PolicyPath = $livePolicy
  } else {
    $PolicyPath = $legacyPolicy
  }
}
if (-not (Test-Path -LiteralPath $PolicyPath)) {
  throw "Missing security policy (expected tools/security/policy.json): $PolicyPath"
}

$syncPolicy = Get-Content -Raw -LiteralPath $PolicyPath | ConvertFrom-Json
$excludeDirectoryNames = @($syncPolicy.exclude_directory_names)
$excludeFileNames = @($syncPolicy.exclude_file_names)
$secretScanSkipFileNames = @($syncPolicy.secret_scan_skip_file_names)
$lockfileSafetyFileNames = @($syncPolicy.lockfile_safety_file_names)
$allowedPublicProjectNames = @()
if ($syncPolicy.PSObject.Properties.Name -contains 'allowed_public_project_names') {
  $allowedPublicProjectNames = @($syncPolicy.allowed_public_project_names)
}
$forbiddenPrivateIdentifiers = @()
if ($syncPolicy.PSObject.Properties.Name -contains 'forbidden_private_identifiers') {
  $forbiddenPrivateIdentifiers = @($syncPolicy.forbidden_private_identifiers)
}
$forbiddenDependencyFingerprints = @()
if ($syncPolicy.PSObject.Properties.Name -contains 'forbidden_dependency_fingerprints') {
  $forbiddenDependencyFingerprints = @($syncPolicy.forbidden_dependency_fingerprints)
}

function Get-PublicScrubFiles {
  Get-ChildItem -LiteralPath . -Recurse -Force -File | Where-Object {
    $relative = $_.FullName.Substring((Get-Location).Path.Length).TrimStart('\', '/')
    if (-not $relative) {
      return $false
    }
    if ($excludeFileNames -contains $_.Name) {
      return $false
    }
    $segments = $relative -split '[\\/]'
    if ($segments | Where-Object { $excludeDirectoryNames -contains $_ }) {
      return $false
    }
    return $true
  }
}

# Content leak patterns: private identifiers + paths. Allowed public project names
# (e.g. GPCGuard, Prismatix) may appear in docs/examples and are NOT in this list.
# They remain forbidden as dependency fingerprints via lockfile/package rules.
$legacyHardcodedPatterns = @(
  'Babel-private',
  'babel-private',
  'C:\\Users\\',
  'C:/Users/',
  'C:\\Workspace\\',
  'C:/Workspace/',
  '\.supabase\.co',
  'ExactUploadFixer',
  'PDFFixerPro',
  'PrivacyScrubber',
  'ScreenKeepAlive',
  'exact_upload_fixer_pro',
  'com\.exactuploadfixer',
  'com\.pdffixerpro',
  'com\.privacyscrubber',
  'com\.screenkeeper\.app',
  'AuditGuard',
  'Project_Android',
  'App-Test-Babel',
  'App-test-Babel',
  'app_test_babel',
  'MonteCarloLedger',
  'ProjectGames',
  'Openclaw',
  'openclaw',
  '\.openclaw',
  'scanners/gpcguard_monitor',
  'PlayBillingGateway'
)
if ($forbiddenPrivateIdentifiers.Count -gt 0) {
  $patterns = $forbiddenPrivateIdentifiers
} else {
  $patterns = $legacyHardcodedPatterns
}
# Never treat allowed public project names as content-leak findings.
if ($allowedPublicProjectNames.Count -gt 0) {
  $patterns = @($patterns | Where-Object {
    $p = $_
    -not ($allowedPublicProjectNames | Where-Object { $p -eq $_ -or $p -eq [regex]::Escape($_) })
  })
}

function Is-LegacyPlaceholderFinding {
  param([string]$RelativePath)

  $normalized = $RelativePath -replace '\\', '/'
  return $normalized -match '(^|/)docs/leak-fixture(\.|/|$)'
}

function Get-ShannonEntropy {
  param([string]$String)
  if ([string]::IsNullOrEmpty($String)) { return 0 }
  $length = $String.Length
  $charCounts = @{}
  foreach ($char in $String.ToCharArray()) {
    $charCounts[$char] = ($charCounts[$char] ?? 0) + 1
  }
  $entropy = 0.0
  foreach ($count in $charCounts.Values) {
    $p = $count / $length
    $entropy -= $p * [Math]::Log($p, 2)
  }
  return $entropy
}


$hardFindings = New-Object System.Collections.Generic.List[string]
$warningFindings = New-Object System.Collections.Generic.List[string]

function Write-ScrubReport {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Status,
    [string[]]$Findings = @(),
    [string[]]$Warnings = @()
  )

  if (-not $ReportPath) {
    return
  }

  $reportDirectory = Split-Path -Parent $ReportPath
  if ($reportDirectory -and -not (Test-Path -LiteralPath $reportDirectory)) {
    New-Item -ItemType Directory -Path $reportDirectory -Force | Out-Null
  }

  $report = @{
    status = $Status
    strict = [bool]$Strict
    findings = @($Findings)
    warnings = @($Warnings)
  }
  Set-Content -Path $ReportPath -Value (ConvertTo-Json -Depth 10 $report)
}

function Test-IsExcludedRelativePath {
  param([string]$RelativePath)

  $normalized = $RelativePath.Replace('\', '/').TrimStart('/')
  if (-not $normalized) {
    return $true
  }

  $leaf = Split-Path -Leaf $normalized
  if ($excludeFileNames -contains $leaf) {
    return $true
  }

  $segments = $normalized -split '/'
  if ($segments | Where-Object { $excludeDirectoryNames -contains $_ }) {
    return $true
  }

  return $false
}

function Test-IsSecretScanSkippedFile {
  param([string]$RelativePath)

  $leaf = Split-Path -Leaf $RelativePath
  return $secretScanSkipFileNames -contains $leaf
}

function Get-LeakSearchResults {
  if ($null -ne $rgCommand) {
    $joinedPattern = ($patterns -join '|')
    $args = @(
      '-n',
      '--ignore-case',
      '-e', $joinedPattern,
      '.'
    )
    foreach ($directoryName in $excludeDirectoryNames) {
      $args = @('--glob', "!$directoryName/**") + $args
      $args = @('--glob', "!**/$directoryName/**") + $args
    }
    foreach ($fileName in $excludeFileNames) {
      $args = @('--glob', "!$fileName") + $args
      $args = @('--glob', "!**/$fileName") + $args
    }
    $args = @('--glob', '!tools/check-public-scrub.ps1') + $args
    $args = @('--glob', '!tools/security/policy.json') + $args
    $args = @('--glob', '!tools/run-public-secret-scan.ps1') + $args

    $results = & $rgCommand.Source @args
    $exitCode = $LASTEXITCODE

    if ($exitCode -gt 1) {
      Write-Error "ripgrep failed with exit code $exitCode"
    }

    return @{
      Results = @($results)
      ExitCode = $exitCode
      Engine = 'rg'
    }
  }

  Write-Host 'ripgrep (rg) not found; falling back to Select-String for scrub scan.' -ForegroundColor Yellow
  $results = New-Object System.Collections.Generic.List[string]
  foreach ($file in Get-PublicScrubFiles) {
    $relative = $file.FullName.Substring((Get-Location).Path.Length).TrimStart('\', '/').Replace('\', '/')
    if ($relative -eq 'tools/check-public-scrub.ps1' -or
        $relative -eq 'tools/security/policy.json' -or
        $relative -eq 'tools/run-public-secret-scan.ps1') {
      continue
    }

    $matches = Select-String -LiteralPath $file.FullName -Pattern $patterns -AllMatches -CaseSensitive:$false -ErrorAction SilentlyContinue
    foreach ($match in $matches) {
      $results.Add((".\{0}:{1}:{2}" -f $relative, $match.LineNumber, $match.Line.Trim()))
    }
  }

  return @{
    Results = @($results)
    ExitCode = $(if ($results.Count -gt 0) { 0 } else { 1 })
    Engine = 'select-string'
  }
}
$leakScan = Get-LeakSearchResults
$results = $leakScan.Results
$exitCode = $leakScan.ExitCode

$forbiddenFiles = Get-PublicScrubFiles | Where-Object {
  $_.Name -match '^\.(env)(\..+)?$' -and $_.Name -ne '.env.example'
}
if ($forbiddenFiles) {
  foreach ($file in $forbiddenFiles) {
    $relative = $file.FullName.Substring((Get-Location).Path.Length).TrimStart('\', '/').Replace('\', '/')
    $hardFindings.Add($relative);
  }
  Write-Host 'Forbidden .env* files found in public export:' -ForegroundColor Yellow
  $forbiddenFiles | ForEach-Object {
    $relative = $_.FullName.Substring((Get-Location).Path.Length).TrimStart('\', '/').Replace('\', '/')
    Write-Host $relative
  }
}

$sensitiveEnvRules = @{
  'DEEPINFRA_API_KEY' = @('your_deepinfra_api_key_here')
  'GEMINI_API_KEY'    = @('your_gemini_api_key_here')
  'ANTHROPIC_API_KEY' = @('sk-ant-your_anthropic_api_key_here')
  'GROQ_API_KEY'      = @('your_groq_api_key_here')
  'OPENAI_API_KEY'    = @('sk-your_openai_api_key_here')
}

$keyPatternRules = @(
  @{ Label = 'Google API key'; Pattern = 'AIza[0-9A-Za-z\-_]{20,}' },
  @{ Label = 'Anthropic API key'; Pattern = 'sk-ant-(?!your_)[0-9A-Za-z\-_]{20,}' },
  @{ Label = 'Groq API key'; Pattern = 'gsk_[0-9A-Za-z]{20,}' },
  @{ Label = 'OpenAI API key'; Pattern = 'sk-(?!your_|ant-)(?:proj-)?[0-9A-Za-z\-_]{20,}' },
  @{ Label = 'GitHub token'; Pattern = 'gh[pousr]_[0-9A-Za-z_]{20,}' },
  @{ Label = 'Stripe key'; Pattern = '(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{20,}' },
  @{ Label = 'AWS access key id'; Pattern = '(?:A3T|AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA)[A-Z0-9]{16}' },
  @{ Label = 'JWT token'; Pattern = 'eyJ[0-9A-Za-z\-_]{10,}\.[0-9A-Za-z\-_]{10,}\.[0-9A-Za-z\-_]{10,}' }
)

$secretFindings = New-Object System.Collections.Generic.List[string]

$fingerprintAlternation = if ($forbiddenDependencyFingerprints.Count -gt 0) {
  ($forbiddenDependencyFingerprints | ForEach-Object { [regex]::Escape($_) }) -join '|'
} else {
  'Babel-private|GPCGuard|Prismatix|AuditGuard|ExactUploadFixer|PDFFixerPro|PrivacyScrubber|ScreenKeepAlive|Project_Android|App-Test-Babel|App-test-Babel|app_test_babel|MonteCarloLedger|ProjectGames|Openclaw'
}
$lockfileSafetyRules = @(
  @{ Label = 'local file dependency'; Pattern = '"(?:resolved|version)"\s*:\s*"file:' },
  @{ Label = 'local Windows path'; Pattern = '[A-Za-z]:[\\/](?:Users|Workspace|Projects)[\\/]' },
  @{ Label = 'local Unix path'; Pattern = '/(?:Users|home|workspace|projects)/[^"''\s]+' },
  @{ Label = 'private dependency fingerprint'; Pattern = "(?i)($fingerprintAlternation)" },
  @{ Label = 'private repository URL'; Pattern = "(?i)https?://[^`"'\s]*($fingerprintAlternation)[^`"'\s]*" }
)

foreach ($file in Get-PublicScrubFiles) {
  $relative = $file.FullName.Substring((Get-Location).Path.Length).TrimStart('\', '/').Replace('\', '/')
  if (-not ($lockfileSafetyFileNames -contains $file.Name)) {
    continue
  }

  $lineNumber = 0
  foreach ($line in Get-Content -LiteralPath $file.FullName) {
    $lineNumber++
    foreach ($rule in $lockfileSafetyRules) {
      if ($line -match $rule.Pattern) {
        $secretFindings.Add(("{0}:{1}: lockfile safety violation ({2})" -f $relative, $lineNumber, $rule.Label))
      }
    }
  }
}

foreach ($file in Get-PublicScrubFiles) {
  $relative = $file.FullName.Substring((Get-Location).Path.Length).TrimStart('\', '/').Replace('\', '/')
  if (Test-IsSecretScanSkippedFile $relative) {
    continue
  }
  $lineNumber = 0
  foreach ($line in Get-Content -LiteralPath $file.FullName) {
    $lineNumber++

    foreach ($entry in $sensitiveEnvRules.GetEnumerator()) {
      $escapedName = [regex]::Escape($entry.Key)
      if ($line -match "^\s*$escapedName\s*=\s*(.+?)\s*$") {
        $value = $Matches[1].Trim().Trim('"''')
        if ($value -and -not ($entry.Value -contains $value)) {
          $secretFindings.Add(("{0}:{1}: suspicious {2} assignment" -f $relative, $lineNumber, $entry.Key))
        }
      }
    }

    foreach ($rule in $keyPatternRules) {
      if ($line -match $rule.Pattern) {
        $secretFindings.Add(("{0}:{1}: {2} pattern" -f $relative, $lineNumber, $rule.Label))
      }
    }

    # Shannon Entropy scan for unpatterned secrets (e.g. AWS keys, database passwords, JWTs)
    # We skip entropy checking on test files to prevent test mock vectors from blocking validation
    if ($relative -match '(\btest\b|\.test\.)') {
      continue
    }

    $tokens = [regex]::Matches($line, '\b[A-Za-z0-9_\-]{24,120}\b')
    foreach ($match in $tokens) {
      $token = $match.Value
      if ($token -match '(your_|_key_here|example_|template_|Example-|ExampleGameProject|example-)') {
        continue
      }
      if ($token -match '^sha[0-9a-fA-F]') {
        continue
      }
      if ($token -match '^20[0-9]{6}_') {
        # Skip date-based task/run identifiers
        continue
      }
      if ($token -match '^[a-z\-]+$') {
        # Skip pure lowercase words with hyphens (e.g., descriptive slugs)
        continue
      }
      $entropy = Get-ShannonEntropy -String $token
      if ($entropy -gt 4.6) {
        $secretFindings.Add(("{0}:{1}: potential high-entropy secret detected (length: {2}, entropy: {3:N2})" -f $relative, $lineNumber, $token.Length, $entropy))
      }
    }
  }
}

foreach ($line in $results) {
  $cleanLine = $line -replace '^\./', ''
  if ($cleanLine -match '^([^:]+):') {
    $path = $Matches[1]
    if (Is-LegacyPlaceholderFinding $path) {
      $warningFindings.Add($cleanLine)
      continue;
    }
  }
  $hardFindings.Add($line)
}
if ($secretFindings.Count -gt 0) {
  $secretFindings | ForEach-Object { $hardFindings.Add($_) }
}

if ($Strict -and $warningFindings.Count -gt 0) {
  $warningFindings | ForEach-Object { $hardFindings.Add("strict mode promoted warning: $_") }
}

if ($hardFindings.Count -gt 0) {
  Write-Host 'Potential public-export leaks found:' -ForegroundColor Yellow
  $hardFindings | ForEach-Object { Write-Host $_ }
  Write-ScrubReport -Status 'fail' -Findings @($hardFindings) -Warnings @($warningFindings)
  exit 1
}

if ($warningFindings.Count -gt 0) {
  Write-Host 'Public scrub check passed with non-blocking warnings:' -ForegroundColor Yellow
  $warningFindings | ForEach-Object { Write-Host $_ }
  Write-ScrubReport -Status 'warn' -Findings @($warningFindings) -Warnings @($warningFindings)
  exit 0
}

if (($exitCode -eq 1) -or ($results.Count -eq 0 -and $secretFindings.Count -eq 0)) {
  Write-Host 'Public scrub check passed.' -ForegroundColor Green
  Write-ScrubReport -Status 'pass' -Findings @() -Warnings @()
  exit 0
}

if ($exitCode -eq 0) {
  Write-Host 'Potential public-export leaks found:' -ForegroundColor Yellow
  $results | ForEach-Object { Write-Host $_ }
  Write-ScrubReport -Status 'fail' -Findings @($results) -Warnings @($warningFindings)
  exit 1
}
