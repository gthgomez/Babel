// License: Apache-2.0
// This bounded control owns only its synthetic listener; it never starts Desktop.
import {spawn} from 'node:child_process';
import {appendFileSync} from 'node:fs';
import {join} from 'node:path';
import {captureSanitizedStderr, sanitizeSignal, sanitizeSpawnCode} from './sanitized-stderr.mjs';

const root = process.env.BABEL_CONTROL_ROOT;
if (!root) throw new Error('control root is required');
const receiptPath = join(root, 'events.jsonl');
const emit = event => appendFileSync(receiptPath, JSON.stringify(event) + '\n', {mode: 0o600});
const script = String.raw`
$ErrorActionPreference = 'Stop'
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
try {
  $listener.ExclusiveAddressUse = $true
  $listener.Start()
  [Console]::Out.WriteLine("READY $PID $($listener.LocalEndpoint.Port)")
  [Console]::Out.Flush()
  $deadline = [DateTime]::UtcNow.AddSeconds(18)
  $reason = 'deadline'
  while ($true) {
    if ([DateTime]::UtcNow -ge $deadline) { break }
    if (Test-Path -LiteralPath $env:BABEL_CONTROL_STOP) {
      if ([DateTime]::UtcNow -lt $deadline) { $reason = 'requested' }
      break
    }
    if ($listener.Pending()) {
      $client = $listener.AcceptTcpClient()
      try { $stream = $client.GetStream(); $stream.WriteByte(42); $stream.Flush() }
      finally { $client.Dispose() }
    }
    Start-Sleep -Milliseconds 25
  }
  [Console]::Out.WriteLine("STOPPED $reason")
  [Console]::Out.Flush()
} finally { $listener.Stop() }
`;
const child = spawn('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], {
  env: {...process.env, BABEL_CONTROL_STOP: join(root, 'stop')},
  windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
});
const stderrReceipt = captureSanitizedStderr(child.stderr);
let ready = false, pending = '', spawnCode = null, timedOut = false, stopReason = 'unknown';
const timer = setTimeout(() => { timedOut = true; child.kill(); }, 20_000);
child.on('error', error => {
  spawnCode = sanitizeSpawnCode(error.code ?? 'other');
});
child.stdout.on('data', chunk => {
  pending += String(chunk);
  if (pending.length > 4096) { child.kill(); return; }
  let newline;
  while ((newline = pending.indexOf('\n')) !== -1) {
    const line = pending.slice(0, newline).trim(); pending = pending.slice(newline + 1);
    const match = /^READY (\d+) (\d+)$/.exec(line);
    if (!ready && match && Number(match[1]) === child.pid && Number(match[2]) > 0 && Number(match[2]) <= 65535) {
      ready = true;
      emit({event: 'ready', supervisorPid: process.pid, providerPid: child.pid, port: Number(match[2])});
    }
    if (ready && line === 'STOPPED requested') stopReason = 'requested';
    else if (ready && line === 'STOPPED deadline') stopReason = 'deadline';
  }
});
child.once('close', (code, signal) => {
  clearTimeout(timer);
  emit({event: 'exit', phase: ready ? 'after-ready' : 'provider-start', supervisorPid: process.pid,
    providerPid: child.pid ?? null, exitCode: Number.isInteger(code) ? code : null,
    signal: sanitizeSignal(signal), spawnCode, timedOut, stopReason, stderr: stderrReceipt()});
});
