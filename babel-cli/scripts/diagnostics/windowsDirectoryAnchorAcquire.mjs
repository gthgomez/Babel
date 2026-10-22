#!/usr/bin/env node
/**
 * Windows-only acquisition timing experiment (diagnostic). Does not modify production
 * acquireEffectDirectoryAnchors semantics or the 15s operational deadline.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const PRODUCTION_ACQUIRE_MS = 15_000
const DIAGNOSTIC_OBSERVE_MS = 60_000
const SEQUENTIAL_COUNT = 10
const PARALLEL_COUNT = 10
const SHARD_TEST_CONCURRENCY = 1

const WINDOWS_DIAGNOSTIC_LOCK_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$sw = [System.Diagnostics.Stopwatch]::StartNew()
[Console]::Out.WriteLine('STAGE:boot')
[Console]::Out.WriteLine(('TIMING:mark=boot elapsed_ms=' + [int]$sw.ElapsedMilliseconds))
[Console]::Out.Flush()
$addTypeStartMs = [int]$sw.ElapsedMilliseconds
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class BabelDirectoryGuard {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  public static SafeFileHandle OpenDirectory(string name, out int error) {
    var handle = CreateFile(name, 129, 3, IntPtr.Zero, 3, 33554432, IntPtr.Zero);
    error = Marshal.GetLastWin32Error();
    return handle;
  }
}
'@
[Console]::Out.WriteLine('STAGE:typed')
[Console]::Out.WriteLine(('TIMING:mark=add_type elapsed_ms=' + ([int]$sw.ElapsedMilliseconds - $addTypeStartMs)))
[Console]::Out.WriteLine(('TIMING:mark=typed elapsed_ms=' + [int]$sw.ElapsedMilliseconds))
[Console]::Out.Flush()
$handles = New-Object 'System.Collections.Generic.List[Microsoft.Win32.SafeHandles.SafeFileHandle]'
try {
  $request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__BABEL_PATHS__')) | ConvertFrom-Json
  [Console]::Out.WriteLine('STAGE:open')
  [Console]::Out.WriteLine(('TIMING:mark=open elapsed_ms=' + [int]$sw.ElapsedMilliseconds))
  [Console]::Out.Flush()
  foreach ($path in $request.paths) {
    [int]$nativeError = 0
    $handle = [BabelDirectoryGuard]::OpenDirectory($path, [ref]$nativeError)
    if ($handle.IsInvalid) { [Console]::Out.WriteLine('ERROR:' + $handles.Count + ':' + $nativeError); exit 1 }
    $handles.Add($handle)
  }
  [Console]::Out.WriteLine('READY:' + $handles.Count)
  [Console]::Out.WriteLine(('TIMING:mark=ready elapsed_ms=' + [int]$sw.ElapsedMilliseconds))
  [Console]::Out.Flush()
  [Diagnostics.Process]::GetProcessById(__BABEL_PARENT_PID__).WaitForExit()
} catch { [Console]::Out.WriteLine('ERROR:directory-handle'); exit 1 }
finally { foreach ($handle in $handles) { $handle.Dispose() } }
`

function ancestors(path) {
  const result = []
  let current = resolve(path)
  while (true) {
    result.push(current)
    const parent = dirname(current)
    if (parent === current) return result
    current = parent
  }
}

function resolveRuntimes() {
  const powerShell7 = join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe')
  const fallback = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const runtimes = []
  if (existsSync(powerShell7)) runtimes.push({ id: 'pwsh7', path: powerShell7 })
  if (existsSync(fallback)) runtimes.push({ id: 'powershell_fallback', path: fallback })
  return runtimes
}

function queryRuntimeVersion(executable) {
  return new Promise(resolveVersion => {
    const child = spawn(executable, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', chunk => { out += chunk.toString('utf8') })
    child.on('close', code => resolveVersion({ code, version: out.trim() }))
  })
}

function buildScript(paths) {
  const directories = [...new Set(paths.flatMap(ancestors))].sort((a, b) => a.length - b.length)
  return {
    directories,
    readyLine: `READY:${directories.length}`,
    encoded: WINDOWS_DIAGNOSTIC_LOCK_SCRIPT
      .replace('__BABEL_PATHS__', Buffer.from(JSON.stringify({ paths: directories }), 'utf8').toString('base64'))
      .replace('__BABEL_PARENT_PID__', String(process.pid)),
  }
}

function takeLine(buffer) {
  const newline = buffer.indexOf('\n')
  if (newline < 0) return { rest: buffer }
  const line = buffer.slice(0, newline).replace(/\r$/, '')
  return { line, rest: buffer.slice(newline + 1) }
}

async function acquireSample({ executable, paths, sampleId, batchMode, liveHelpers }) {
  const { readyLine, encoded } = buildScript(paths)
  const args = ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(encoded, 'utf16le').toString('base64')]
  const events = []
  const helperTimings = []
  let stderr = ''
  let transcript = ''
  let pending = ''
  let ready = false
  let refused = false
  let spawnAt
  let productionFailAt
  let child

  const record = (mark, extra = {}) => {
    events.push({ mark, t_ms: Math.round(performance.now() - spawnAt), ...extra })
  }

  return await new Promise(resolveSample => {
    spawnAt = performance.now()
    child = spawn(executable, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    liveHelpers.current += 1
    liveHelpers.peak = Math.max(liveHelpers.peak, liveHelpers.current)
    record('spawn')

    const finish = outcome => {
      clearTimeout(diagnosticTimer)
      if (productionTimer) clearTimeout(productionTimer)
      liveHelpers.current -= 1
      resolveSample(outcome)
    }

    const processLines = () => {
      while (true) {
        const { line, rest } = takeLine(pending)
        if (line === undefined) break
        pending = rest
        transcript += `${line}\n`
        if (line.startsWith('TIMING:')) {
          helperTimings.push(line)
          continue
        }
        if (line.startsWith('STAGE:')) {
          record(`stage_${line.slice('STAGE:'.length)}`)
          continue
        }
        if (line === readyLine) {
          ready = true
          record('ready')
          if (!child.killed) child.kill()
          continue
        }
        if (line.startsWith('ERROR:')) {
          refused = true
          record('error', { line })
          if (!child.killed) child.kill()
        }
      }
    }

    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(0, 4000) })
    child.stdout.on('data', chunk => {
      pending += chunk.toString('utf8')
      processLines()
    })

    const productionTimer = setTimeout(() => {
      productionFailAt = Math.round(performance.now() - spawnAt)
      record('production_deadline_15s', { exceeded: !ready && !refused })
    }, PRODUCTION_ACQUIRE_MS)

    const diagnosticTimer = setTimeout(() => {
      record('diagnostic_observe_60s')
      if (!child.killed) child.kill()
    }, DIAGNOSTIC_OBSERVE_MS)

    child.on('exit', code => {
      record('exit', { code })
      const observe_ms = Math.round(performance.now() - spawnAt)
      finish({
        sampleId,
        batchMode,
        executable,
        readyLine,
        productionWouldFail: !ready || observe_ms > PRODUCTION_ACQUIRE_MS,
        productionFailAt_ms: productionFailAt ?? null,
        ready,
        refused,
        observe_ms,
        events,
        helperTimings,
        stderr,
        transcript,
        liveHelpersAtExit: liveHelpers.current,
      })
    })
  })
}

async function runSequential(runtime, paths, liveHelpers, prefix) {
  const samples = []
  for (let index = 0; index < SEQUENTIAL_COUNT; index += 1) {
    samples.push(await acquireSample({
      executable: runtime.path,
      paths,
      sampleId: `${prefix}-seq-${String(index + 1).padStart(2, '0')}`,
      batchMode: 'sequential',
      liveHelpers,
    }))
  }
  return samples
}

async function runParallel(runtime, paths, liveHelpers, prefix) {
  const ids = Array.from({ length: PARALLEL_COUNT }, (_, index) => `${prefix}-par-${String(index + 1).padStart(2, '0')}`)
  return await Promise.all(ids.map(sampleId => acquireSample({
    executable: runtime.path,
    paths,
    sampleId,
    batchMode: `parallel_${PARALLEL_COUNT}`,
    liveHelpers,
  })))
}

function summarize(samples) {
  const observe = samples.map(s => s.observe_ms)
  const addType = samples.flatMap(s => s.helperTimings
    .filter(line => line.includes('mark=add_type'))
    .map(line => Number(line.match(/elapsed_ms=(\d+)/)?.[1] ?? NaN))
    .filter(Number.isFinite))
  return {
    count: samples.length,
    productionWouldFail: samples.filter(s => s.productionWouldFail).length,
    ready: samples.filter(s => s.ready).length,
    refused: samples.filter(s => s.refused).length,
    observe_ms: { min: Math.min(...observe), max: Math.max(...observe), median: median(observe) },
    add_type_ms: addType.length ? { min: Math.min(...addType), max: Math.max(...addType), median: median(addType) } : null,
  }
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}

async function main() {
  if (process.platform !== 'win32') {
    console.log(JSON.stringify({ skipped: true, reason: 'windows_only', platform: process.platform }, null, 2))
    return
  }

  const { values } = parseArgs({
    options: {
      'runner-instance': { type: 'string', default: '0' },
      'output-dir': { type: 'string' },
    },
  })

  const bound = resolve(mkdtempSync(join(tmpdir(), 'babel-anchor-diag-')))
  const captureParent = resolve(mkdtempSync(join(tmpdir(), 'babel-anchor-diag-cap-')))
  const paths = [bound, captureParent]
  const runtimes = resolveRuntimes()
  const report = {
    schemaVersion: 1,
    kind: 'windows_directory_anchor_acquire_diagnostic',
    productionAcquireDeadlineMs: PRODUCTION_ACQUIRE_MS,
    diagnosticObserveMs: DIAGNOSTIC_OBSERVE_MS,
    shardTestConcurrencyReference: SHARD_TEST_CONCURRENCY,
    parallelBatchSize: PARALLEL_COUNT,
    sequentialCount: SEQUENTIAL_COUNT,
    runnerInstance: values['runner-instance'],
    github: {
      runId: process.env.GITHUB_RUN_ID ?? null,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
      sha: process.env.GITHUB_SHA ?? null,
      ref: process.env.GITHUB_REF ?? null,
    },
    node: { version: process.version, pid: process.pid },
    boundDirectories: paths,
    runtimes: [],
    rawSamples: [],
  }

  for (const runtime of runtimes) {
    const version = await queryRuntimeVersion(runtime.path)
    const liveHelpers = { current: 0, peak: 0 }
    const runtimeBlock = {
      id: runtime.id,
      executable: runtime.path,
      version,
      firstInvocation: await acquireSample({
        executable: runtime.path,
        paths,
        sampleId: `${runtime.id}-first`,
        batchMode: 'first_invocation',
        liveHelpers,
      }),
      sequential: await runSequential(runtime, paths, liveHelpers, runtime.id),
      parallel: await runParallel(runtime, paths, liveHelpers, runtime.id),
      liveHelpersPeak: liveHelpers.peak,
    }
    runtimeBlock.distribution = {
      firstInvocation: summarize([runtimeBlock.firstInvocation]),
      sequential: summarize(runtimeBlock.sequential),
      parallel: summarize(runtimeBlock.parallel),
      all: summarize([
        runtimeBlock.firstInvocation,
        ...runtimeBlock.sequential,
        ...runtimeBlock.parallel,
      ]),
    }
    report.runtimes.push(runtimeBlock)
    report.rawSamples.push(
      runtimeBlock.firstInvocation,
      ...runtimeBlock.sequential,
      ...runtimeBlock.parallel,
    )
  }

  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
  const outDir = values['output-dir']
    ? resolve(values['output-dir'])
    : join(packageRoot, 'artifacts', 'windows-anchor-diagnostic')
  mkdirSync(outDir, { recursive: true })
  const outPath = join(outDir, `report-instance-${values['runner-instance']}.json`)
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(JSON.stringify({ ok: true, outPath, runtimes: report.runtimes.map(r => ({ id: r.id, distribution: r.distribution })) }, null, 2))
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
