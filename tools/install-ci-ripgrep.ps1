param([Parameter(Mandatory = $true)][string]$Destination)
$ErrorActionPreference = 'Stop'
$version = '15.1.0'
$windows = $IsWindows
$asset = if ($windows) { "ripgrep-$version-x86_64-pc-windows-msvc.zip" } else { "ripgrep-$version-x86_64-unknown-linux-musl.tar.gz" }
$expected = if ($windows) { '124510b94b6baa3380d051fdf4650eaa80a302c876d611e9dba0b2e18d87493a' } else { '1c9297be4a084eea7ecaedf93eb03d058d6faae29bbc57ecdaf5063921491599' }
$root = [IO.Path]::GetFullPath($Destination)
New-Item -ItemType Directory -Force $root | Out-Null
$archive = Join-Path $root $asset
Invoke-WebRequest "https://github.com/BurntSushi/ripgrep/releases/download/$version/$asset" -OutFile $archive -TimeoutSec 60
if ((Get-FileHash -Algorithm SHA256 $archive).Hash.ToLowerInvariant() -ne $expected) { throw 'Pinned ripgrep archive digest mismatch' }
if ($windows) { Expand-Archive -LiteralPath $archive -DestinationPath $root -Force }
else { tar -xzf $archive -C $root; if ($LASTEXITCODE -ne 0) { throw 'ripgrep extraction failed' } }
$directory = Join-Path $root ($asset -replace '\.zip$|\.tar\.gz$', '')
$binary = Join-Path $directory $(if ($windows) { 'rg.exe' } else { 'rg' })
if (-not (Test-Path -LiteralPath $binary -PathType Leaf)) { throw 'Pinned native ripgrep executable missing' }
& $binary --version
if ($LASTEXITCODE -ne 0) { throw 'Pinned native ripgrep setup failed' }
if ($env:GITHUB_PATH) { Add-Content -LiteralPath $env:GITHUB_PATH -Value $directory }
Write-Output "Installed pinned ripgrep $version"
