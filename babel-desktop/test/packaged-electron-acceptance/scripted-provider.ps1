# License: Apache-2.0
# Test-only local provider. ExclusiveAddressUse is set before bind on Windows.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$listener = $null
$utf8 = [System.Text.UTF8Encoding]::new($false)

function Publish([object]$value) {
  try {
    [Console]::Out.WriteLine(($value | ConvertTo-Json -Compress -Depth 12))
    [Console]::Out.Flush()
  } catch { } # Keep the fixture bound if its controller must retain it for cleanup.
}
function Find-HeaderEnd([byte[]]$bytes) {
  for ($i = 0; $i -le $bytes.Length - 4; $i++) {
    if ($bytes[$i] -eq 13 -and $bytes[$i + 1] -eq 10 -and $bytes[$i + 2] -eq 13 -and $bytes[$i + 3] -eq 10) { return $i }
  }
  return -1
}
function Write-Http($stream, [int]$status, [string]$type, [string]$body) {
  $bodyBytes = $utf8.GetBytes($body)
  $reason = if ($status -eq 200) { 'OK' } else { 'Bad Request' }
  $headers = "HTTP/1.1 $status $reason`r`nContent-Type: $type`r`nContent-Length: $($bodyBytes.Length)`r`nConnection: close`r`n`r`n"
  $headerBytes = [System.Text.Encoding]::ASCII.GetBytes($headers)
  $stream.Write($headerBytes, 0, $headerBytes.Length)
  $stream.Write($bodyBytes, 0, $bodyBytes.Length)
  $stream.Flush()
}

try {
  $config = [Console]::In.ReadLine() | ConvertFrom-Json
  if ($null -eq $config -or $config.port -lt 0 -or $config.port -gt 65535 -or @($config.steps).Count -eq 0 -or
      $config.shutdownNonce -notmatch '^[a-f0-9]{64}$') { throw 'invalid fixture configuration' }
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, [int]$config.port)
  $listener.ExclusiveAddressUse = $true
  $listener.Start()
  Publish @{event='ready'; port=([System.Net.IPEndPoint]$listener.LocalEndpoint).Port}
  $index = 0
  while ($true) {
    $client = $listener.AcceptTcpClient()
    $stream = $null
    $received = $null
    try {
      $client.ReceiveTimeout = 30000
      $client.SendTimeout = 30000
      $stream = $client.GetStream()
      $buffer = [byte[]]::new(8192)
      $received = [System.IO.MemoryStream]::new()
      $headerEnd = -1
      $contentLength = -1
      while ($true) {
        $count = $stream.Read($buffer, 0, $buffer.Length)
        if ($count -le 0) { throw 'incomplete request' }
        $received.Write($buffer, 0, $count)
        if ($received.Length -gt 4259840) { throw 'request too large' }
        $bytes = $received.ToArray()
        if ($headerEnd -lt 0) {
          $headerEnd = Find-HeaderEnd $bytes
          if ($headerEnd -lt 0) {
            if ($received.Length -gt 65536) { throw 'headers too large' }
            continue
          }
          $headerText = [System.Text.Encoding]::ASCII.GetString($bytes, 0, $headerEnd)
          $isShutdown = $headerText -match '^POST /__fixture__/shutdown HTTP/1\.[01]\r?\n'
          $isInference = $headerText -match '^POST /v1/chat/completions HTTP/1\.[01]\r?\n'
          if ((-not $isShutdown -and -not $isInference) -or
              $headerText -match '(?im)^authorization\s*:' -or
              $headerText -notmatch '(?im)^content-length:\s*(\d+)\s*$') { throw 'invalid request headers' }
          $contentLength = [int]$Matches[1]
          if ($contentLength -gt 4194304) { throw 'request too large' }
        }
        if ($bytes.Length -ge ($headerEnd + 4 + $contentLength)) { break }
      }
      $payload = $utf8.GetString($bytes, $headerEnd + 4, $contentLength) | ConvertFrom-Json
      if ($isShutdown) {
        if ($payload.nonce -cne $config.shutdownNonce) { throw 'invalid fixture shutdown' }
        Write-Http $stream 200 'application/json' '{"stopped":true}'
        break
      }
      if ($payload.model -ne 'local-fixture' -or $index -ge @($config.steps).Count) { throw 'invalid model or exhausted script' }
      $content = [string]$config.steps[$index]
      $index++
      Publish @{event='request'; accepted=$true}
      if ($payload.PSObject.Properties['stream'] -and $payload.stream -eq $true) {
        $frame = @{model='local-fixture'; choices=@(@{delta=@{content=$content}; finish_reason='stop'})} | ConvertTo-Json -Compress -Depth 8
        Write-Http $stream 200 'text/event-stream' "data: $frame`n`ndata: [DONE]`n`n"
      } else {
        $body = @{model='local-fixture'; choices=@(@{message=@{role='assistant'; content=$content}; finish_reason='stop'})} | ConvertTo-Json -Compress -Depth 8
        Write-Http $stream 200 'application/json' $body
      }
    } catch {
      Publish @{event='request'; accepted=$false}
      try { if ($stream) { Write-Http $stream 400 'text/plain' 'Invalid fixture request' } } catch { }
    } finally {
      if ($received) { $received.Dispose() }
      $client.Dispose()
    }
  }
} catch {
  Publish @{event='error'; code='fixture_listener_failed'}
  exit 1
} finally {
  if ($listener) { $listener.Stop() }
}
