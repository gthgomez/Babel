# License: Apache-2.0 — see LICENSE
[CmdletBinding()]
param([Parameter(Mandatory)][string]$SourceRepository)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$validator = Join-Path $PSScriptRoot '../check-public-content-policy.ps1'
$cache = @{}
while ($null -ne ($requestLine = [Console]::ReadLine())) {
  try {
    $request = $requestLine | ConvertFrom-Json
    if ($request.sha -notmatch '^[a-f0-9]{40}$' -or -not [IO.Path]::IsPathFullyQualified([string]$request.snapshot)) { throw 'invalid request' }
    if ($cache.Count -gt 10000) { $cache.Clear() }
    $LASTEXITCODE = 0
    $output = @(& $validator -RepoRoot $request.snapshot -PolicyPath (Join-Path $PSScriptRoot 'public-content-policy.json') -SourceRepository $SourceRepository -SourceCommit $request.sha -OutputFormat json -FileCache $cache)
    $code = $LASTEXITCODE
    $result = ($output -join "`n") | ConvertFrom-Json
    [Console]::WriteLine((@{ exitCode = $code; result = @{ status = $result.status; findings = @($result.findings | Select-Object -First 20) } } | ConvertTo-Json -Depth 8 -Compress))
  } catch {
    # Exceptions and rejected source are never copied into diagnostics.
    [Console]::WriteLine('{"exitCode":1,"result":{"status":"fail","findings":[]}}')
  }
}
