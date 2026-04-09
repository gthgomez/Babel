param(
  [string]$RepoRoot = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'
Set-Location $RepoRoot

$rgCommand = Get-Command rg -ErrorAction SilentlyContinue

$excludeDirectoryNames = @('.git', 'node_modules', 'runs', 'dist', 'coverage', 'artifacts')

function Get-PublicScrubFiles {
  Get-ChildItem -LiteralPath . -Recurse -Force -File | Where-Object {
    $relative = $_.FullName.Substring((Get-Location).Path.Length).TrimStart('\', '/')
    if (-not $relative) {
      return $false
    }
    $segments = $relative -split '[\\/]'
    if ($segments | Where-Object { $excludeDirectoryNames -contains $_ }) {
      return $false
    }
    return $true
  }
}

# Run this in Babel-public before release. It is expected to fail in Babel-private.
$patterns = @(
  'C:\\Users\\',
  'C:/Users/',
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
  'GPCGuard',
  'Prismatix',
  'AuditGuard',
  'Project_Android',
  'Openclaw',
  'openclaw',
  '\.openclaw',
  'scanners/gpcguard_monitor',
  'PlayBillingGateway'
)

function Get-LeakSearchResults {
  if ($null -ne $rgCommand) {
    $joinedPattern = ($patterns -join '|')
    $args = @(
      '--glob', '!.git/**',
      '--glob', '!node_modules/**',
      '--glob', '!runs/**',
      '--glob', '!tools/check-public-scrub.ps1',
      '-n',
      '--ignore-case',
      '-e', $joinedPattern,
      '.'
    )

    $results = & $rgCommand.Source @args
    $exitCode = $LASTEXITCODE

    if ($exitCode -gt 1) {
      Write-Error "ripgrep failed with exit code $exitCode"
    }

    return [PSCustomObject]@{
      Results = @($results)
      ExitCode = $exitCode
      Engine = 'rg'
    }
  }

  Write-Host 'ripgrep (rg) not found; falling back to Select-String for scrub scan.' -ForegroundColor Yellow
  $results = New-Object System.Collections.Generic.List[string]
  foreach ($file in Get-PublicScrubFiles) {
    $relative = $file.FullName.Substring((Get-Location).Path.Length).TrimStart('\', '/').Replace('\', '/')
    if ($relative -eq 'tools/check-public-scrub.ps1') {
      continue
    }

    $matches = Select-String -LiteralPath $file.FullName -Pattern $patterns -AllMatches -CaseSensitive:$false -ErrorAction SilentlyContinue
    foreach ($match in $matches) {
      $results.Add((".\{0}:{1}:{2}" -f $relative, $match.LineNumber, $match.Line.Trim()))
    }
  }

  return [PSCustomObject]@{
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
  Write-Host 'Forbidden .env* files found in public export:' -ForegroundColor Yellow
  $forbiddenFiles | ForEach-Object {
    $relative = $_.FullName.Substring((Get-Location).Path.Length).TrimStart('\', '/').Replace('\', '/')
    Write-Host $relative
  }
  exit 1
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
  @{ Label = 'Groq API key'; Pattern = 'gsk_[0-9A-Za-z]{20,}' }
)

$secretFindings = New-Object System.Collections.Generic.List[string]

foreach ($file in Get-PublicScrubFiles) {
  $relative = $file.FullName.Substring((Get-Location).Path.Length).TrimStart('\', '/').Replace('\', '/')
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
  }
}

if ($secretFindings.Count -gt 0) {
  Write-Host 'Potential secret material found in public export:' -ForegroundColor Yellow
  $secretFindings | ForEach-Object { Write-Host $_ }
  exit 1
}

if ($exitCode -eq 0) {
  Write-Host 'Potential public-export leaks found:' -ForegroundColor Yellow
  $results | ForEach-Object { Write-Host $_ }
  exit 1
}

if ($exitCode -eq 1) {
  Write-Host 'Public scrub check passed.' -ForegroundColor Green
  exit 0
}
