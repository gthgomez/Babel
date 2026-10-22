#!/usr/bin/env node
/**
 * Windows-only acquisition timing experiment (diagnostic). Does not modify production
 * acquireEffectDirectoryAnchors semantics or the 15s operational deadline.
 */
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { prepareUnitShard } from '../run_ci_unit_shard.mjs'

const PRODUCTION_ACQUIRE_MS = 15_000
const DIAGNOSTIC_OBSERVE_MS = 60_000
const SEQUENTIAL_PHASE_COUNT = 10
const SHARD_PHASE_COUNT = 10
const VERSION_QUERY_TIMEOUT_MS = 10_000
const MATRIX_SCHEMA_VERSION = 2

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

function verifyShardTestConcurrency(packageRoot) {
  const selection = prepareUnitShard(packageRoot, 0, 4)
  const flag = selection.args.find(token => token.startsWith('--test-concurrency='))
  if (!flag) {
    return { value: null, verified: false, source: 'babel-cli/scripts/run_ci_unit_shard.mjs', detail: 'missing --test-concurrency in shard args' }
  }
  const value = Number(flag.slice('--test-concurrency='.length))
  return {
    value,
    verified: Number.isInteger(value) && value >= 1,
    source: 'babel-cli/scripts/run_ci_unit_shard.mjs',
    detail: { shardArgsFlag: flag, selectionHash: selection.selectionHash },
  }
}

function gitProvenance(packageRoot) {
  const run = (args) => {
    const result = spawnSync('git', args, { cwd: packageRoot, encoding: 'utf8', windowsHide: true })
    return { code: result.status, stdout: (result.stdout ?? '').trim(), stderr: (result.stderr ?? '').trim() }
  }
  const head = run(['rev-parse', 'HEAD'])
  const tree = run(['rev-parse', 'HEAD^{tree}'])
  const mergeShaEnv = process.env.GITHUB_SHA ?? null
  const headShaEnv = process.env.GITHUB_HEAD_SHA ?? process.env.GITHUB_EVENT_PULL_REQUEST_HEAD_SHA ?? null
  const checkedOutCommit = head.code === 0 ? head.stdout : null
  const isPullRequestMergeRef = Boolean(
    process.env.GITHUB_EVENT_NAME === 'pull_request'
    && mergeShaEnv
    && checkedOutCommit
    && mergeShaEnv !== checkedOutCommit,
  )
  return {
    checkedOutCommit,
    checkedOutTree: tree.code === 0 ? tree.stdout : null,
    githubEventName: process.env.GITHUB_EVENT_NAME ?? null,
    githubRef: process.env.GITHUB_REF ?? null,
    githubMergeShaEnv: mergeShaEnv,
    pullRequestHeadShaEnv: headShaEnv,
    checkoutKind: isPullRequestMergeRef ? 'pull_request_merge_ref' : (checkedOutCommit && headShaEnv && checkedOutCommit === headShaEnv ? 'head_ref' : 'unknown'),
    note: isPullRequestMergeRef
      ? 'GITHUB_SHA is the ephemeral PR merge commit; pullRequestHeadShaEnv is the branch head when provided.'
      : 'Compare checkedOutCommit to pullRequestHeadShaEnv and githubMergeShaEnv explicitly.',
  }
}

function queryRuntimeVersion(executable) {
  return new Promise(resolveVersion => {
    let settled = false
    const finish = payload => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveVersion(payload)
    }
    const child = spawn(executable, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let stderr = ''
    child.stdout.on('data', chunk => { out += chunk.toString('utf8') })
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(0, 2000) })
    child.on('error', error => finish({ ok: false, error: error.message, version: null, stderr }))
    child.on('close', code => finish({ ok: code === 0, code, version: out.trim() || null, stderr: stderr || null }))
    const timer = setTimeout(() => {
      if (!child.killed) child.kill()
      finish({ ok: false, timedOut: true, version: null, error: `version_query_timeout_${VERSION_QUERY_TIMEOUT_MS}ms` })
    }, VERSION_QUERY_TIMEOUT_MS)
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

function parseAddTypeMs(helperTimings) {
  const line = helperTimings.find(entry => entry.includes('mark=add_type'))
  if (!line) return null
  const match = line.match(/elapsed_ms=(\d+)/)
  if (!match) return null
  return Number(match[1])
}

function deriveProductionFailure({ ready, refused, protocolError, readyAcquisition_ms, productionDeadlineExceeded }) {
  if (refused || protocolError) {
    return { productionWouldFail: true, productionFailReason: refused ? 'refused' : 'protocol' }
  }
  if (!ready) {
    return { productionWouldFail: true, productionFailReason: productionDeadlineExceeded ? 'deadline_no_ready' : 'no_ready' }
  }
  if (readyAcquisition_ms === null || !Number.isFinite(readyAcquisition_ms)) {
    return { productionWouldFail: true, productionFailReason: 'ready_time_unknown' }
  }
  if (readyAcquisition_ms > PRODUCTION_ACQUIRE_MS) {
    return { productionWouldFail: true, productionFailReason: 'deadline_ready_latency' }
  }
  return { productionWouldFail: false, productionFailReason: null }
}

async function acquireSample({ executable, paths, sampleId, batchMode, firstHelperCompilation, liveHelpers }) {
  const { readyLine, encoded } = buildScript(paths)
  const args = ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(encoded, 'utf16le').toString('base64')]
  const events = []
  const helperTimings = []
  let stderr = ''
  let transcript = ''
  let pending = ''
  let ready = false
  let refused = false
  let protocolError = false
  let spawnAt
  let readyAcquisition_ms = null
  let productionDeadlineExceeded = false
  let productionFailAt_ms = null
  let child
  let childSpawnError = null
  let exitCode = null
  let stdoutEnded = false
  let stderrEnded = false
  let exited = false
  let killRequested = false
  let postReadyTimingSeen = false

  const record = (mark, extra = {}) => {
    events.push({ mark, t_ms: Math.round(performance.now() - spawnAt), ...extra })
  }

  const processLines = () => {
    while (true) {
      const { line, rest } = takeLine(pending)
      if (line === undefined) break
      pending = rest
      transcript += `${line}\n`
      if (line.startsWith('TIMING:')) {
        helperTimings.push(line)
        if (ready && line.includes('mark=ready')) postReadyTimingSeen = true
        continue
      }
      if (line.startsWith('STAGE:')) {
        record(`stage_${line.slice('STAGE:'.length)}`)
        continue
      }
      if (line === readyLine) {
        if (!ready) {
          ready = true
          readyAcquisition_ms = Math.round(performance.now() - spawnAt)
          record('ready')
        }
        continue
      }
      if (line.startsWith('ERROR:')) {
        refused = true
        record('error', { line })
        continue
      }
      if (line.length > 0) {
        protocolError = true
        record('protocol_line', { line })
      }
    }
  }

  const maybeRequestKillAfterDrain = () => {
    if (killRequested || !child || child.killed) return
    const drainComplete = stdoutEnded && stderrEnded
    if (ready && (postReadyTimingSeen || stdoutEnded)) {
      killRequested = true
      record('kill_after_drain')
      child.kill()
      return
    }
    if ((refused || protocolError) && drainComplete) {
      killRequested = true
      record('kill_after_drain')
      child.kill()
    }
  }

  const buildOutcome = (partial = false) => {
    const observeExit_ms = spawnAt === undefined ? null : Math.round(performance.now() - spawnAt)
    const failure = deriveProductionFailure({
      ready,
      refused,
      protocolError,
      readyAcquisition_ms,
      productionDeadlineExceeded,
    })
    return {
      sampleId,
      batchMode,
      firstHelperCompilation: Boolean(firstHelperCompilation),
      partial,
      executable,
      readyLine,
      ready,
      refused,
      protocolError,
      readyAcquisition_ms,
      observeExit_ms,
      productionWouldFail: failure.productionWouldFail,
      productionFailReason: failure.productionFailReason,
      productionFailAt_ms,
      productionDeadlineExceeded,
      childSpawnError,
      exitCode,
      streamsDrained: stdoutEnded && stderrEnded,
      events,
      helperTimings,
      add_type_ms: parseAddTypeMs(helperTimings),
      stderr,
      transcript,
      liveHelpersAtFinalize: liveHelpers.current,
    }
  }

  return await new Promise(resolveSample => {
    spawnAt = performance.now()
    try {
      child = spawn(executable, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (error) {
      childSpawnError = error.message
      liveHelpers.current -= 0
      resolveSample(buildOutcome(true))
      return
    }

    liveHelpers.current += 1
    liveHelpers.peak = Math.max(liveHelpers.peak, liveHelpers.current)
    record('spawn')

    const finalize = () => {
      clearTimeout(diagnosticTimer)
      clearTimeout(productionTimer)
      liveHelpers.current -= 1
      processLines()
      resolveSample(buildOutcome(false))
    }

    child.on('error', error => {
      childSpawnError = error.message
      record('child_error', { message: error.message })
      if (!child.killed) child.kill()
    })

    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(0, 4000) })
    child.stderr.on('end', () => {
      stderrEnded = true
      maybeRequestKillAfterDrain()
      if (exited && stdoutEnded && stderrEnded) finalize()
    })

    child.stdout.on('data', chunk => {
      pending += chunk.toString('utf8')
      processLines()
      maybeRequestKillAfterDrain()
    })
    child.stdout.on('end', () => {
      stdoutEnded = true
      processLines()
      maybeRequestKillAfterDrain()
      if (exited && stdoutEnded && stderrEnded) finalize()
    })

    const productionTimer = setTimeout(() => {
      productionFailAt_ms = Math.round(performance.now() - spawnAt)
      productionDeadlineExceeded = !ready && !refused
      record('production_deadline_15s', { exceeded: productionDeadlineExceeded })
    }, PRODUCTION_ACQUIRE_MS)

    const diagnosticTimer = setTimeout(() => {
      record('diagnostic_observe_60s')
      if (child && !child.killed) {
        killRequested = true
        child.kill()
      }
    }, DIAGNOSTIC_OBSERVE_MS)

    child.on('exit', code => {
      exitCode = code
      exited = true
      record('exit', { code })
      processLines()
      maybeRequestKillAfterDrain()
      if (stdoutEnded && stderrEnded) finalize()
    })
  })
}

async function runWithConcurrency(limit, tasks) {
  const results = new Array(tasks.length)
  let nextIndex = 0
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (nextIndex < tasks.length) {
      const current = nextIndex
      nextIndex += 1
      results[current] = await tasks[current]()
    }
  })
  await Promise.all(workers)
  return results
}

function summarize(samples) {
  const readyLatency = samples.map(s => s.readyAcquisition_ms).filter(v => v !== null && Number.isFinite(v))
  const exitLatency = samples.map(s => s.observeExit_ms).filter(v => v !== null && Number.isFinite(v))
  const addType = samples.map(s => s.add_type_ms).filter(v => v !== null && Number.isFinite(v))
  return {
    count: samples.length,
    productionWouldFail: samples.filter(s => s.productionWouldFail).length,
    ready: samples.filter(s => s.ready).length,
    refused: samples.filter(s => s.refused).length,
    protocolError: samples.filter(s => s.protocolError).length,
    readyAcquisition_ms: readyLatency.length
      ? { min: Math.min(...readyLatency), max: Math.max(...readyLatency), median: median(readyLatency) }
      : null,
    observeExit_ms: exitLatency.length
      ? { min: Math.min(...exitLatency), max: Math.max(...exitLatency), median: median(exitLatency) }
      : null,
    add_type_ms: addType.length
      ? { min: Math.min(...addType), max: Math.max(...addType), median: median(addType) }
      : null,
    add_type_ms_missing: samples.length - addType.length,
  }
}

function median(values) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}

function persistCheckpoint(report, paths) {
  writeFileSync(paths.reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
}

function appendSampleRecord(paths, sample) {
  appendFileSync(paths.samplesJsonlPath, `${JSON.stringify(sample)}\n`, 'utf8')
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

  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
  const outDir = values['output-dir']
    ? resolve(values['output-dir'])
    : join(packageRoot, 'artifacts', 'windows-anchor-diagnostic')
  mkdirSync(outDir, { recursive: true })
  const instance = values['runner-instance']
  const paths = {
    outDir,
    reportPath: join(outDir, `report-instance-${instance}.json`),
    samplesJsonlPath: join(outDir, `samples-instance-${instance}.jsonl`),
  }

  const bound = resolve(mkdtempSync(join(tmpdir(), 'babel-anchor-diag-')))
  const captureParent = resolve(mkdtempSync(join(tmpdir(), 'babel-anchor-diag-cap-')))
  const anchorPaths = [bound, captureParent]
  const shardConcurrency = verifyShardTestConcurrency(packageRoot)
  const runtimes = resolveRuntimes()

  const report = {
    schemaVersion: MATRIX_SCHEMA_VERSION,
    kind: 'windows_directory_anchor_acquire_diagnostic',
    matrixDesign: 'v2_sequential10_plus_shard_concurrency10',
    invalidPriorDesignEvidence: {
      note: 'Run 39729334133 @ b200bb91 used 21 samples/runtime (extra first + parallel_10 stress); not a valid qualification matrix.',
      preserveArtifacts: true,
    },
    productionAcquireDeadlineMs: PRODUCTION_ACQUIRE_MS,
    diagnosticObserveMs: DIAGNOSTIC_OBSERVE_MS,
    samplesPerRuntime: SEQUENTIAL_PHASE_COUNT + SHARD_PHASE_COUNT,
    expectedSamplesPerRunner: runtimes.length * (SEQUENTIAL_PHASE_COUNT + SHARD_PHASE_COUNT),
    shardTestConcurrency: shardConcurrency,
    runnerInstance: instance,
    github: {
      runId: process.env.GITHUB_RUN_ID ?? null,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    },
    git: gitProvenance(packageRoot),
    node: { version: process.version, pid: process.pid },
    boundDirectories: anchorPaths,
    runtimes: [],
    rawSamples: [],
    matrixComplete: false,
    distributions: null,
  }

  persistCheckpoint(report, paths)

  for (const runtime of runtimes) {
    const version = await queryRuntimeVersion(runtime.path)
    const liveHelpers = { current: 0, peak: 0 }
    const runtimeBlock = {
      id: runtime.id,
      executable: runtime.path,
      versionProbeBeforeFirstHelper: version,
      sequentialPhase: [],
      shardConcurrencyPhase: [],
      liveHelpersPeak: 0,
    }
    report.runtimes.push(runtimeBlock)
    persistCheckpoint(report, paths)

    for (let index = 0; index < SEQUENTIAL_PHASE_COUNT; index += 1) {
      const sample = await acquireSample({
        executable: runtime.path,
        paths: anchorPaths,
        sampleId: `${runtime.id}-seq-${String(index + 1).padStart(2, '0')}`,
        batchMode: index === 0 ? 'sequential_first_helper_compilation' : 'sequential',
        firstHelperCompilation: index === 0,
        liveHelpers,
      })
      runtimeBlock.sequentialPhase.push(sample)
      runtimeBlock.liveHelpersPeak = liveHelpers.peak
      report.rawSamples.push(sample)
      appendSampleRecord(paths, sample)
      persistCheckpoint(report, paths)
    }

    if (!shardConcurrency.verified || shardConcurrency.value === null) {
      report.matrixAborted = { reason: 'shard_concurrency_unverified', shardConcurrency }
      persistCheckpoint(report, paths)
      throw new Error('Shard test concurrency could not be verified; matrix aborted with partial samples preserved.')
    }

    const shardTasks = Array.from({ length: SHARD_PHASE_COUNT }, (_, index) => async () => acquireSample({
      executable: runtime.path,
      paths: anchorPaths,
      sampleId: `${runtime.id}-shard-c${shardConcurrency.value}-${String(index + 1).padStart(2, '0')}`,
      batchMode: `shard_test_concurrency_${shardConcurrency.value}`,
      firstHelperCompilation: false,
      liveHelpers,
    }))
    const shardSamples = await runWithConcurrency(shardConcurrency.value, shardTasks)
    for (const sample of shardSamples) {
      runtimeBlock.shardConcurrencyPhase.push(sample)
      report.rawSamples.push(sample)
      appendSampleRecord(paths, sample)
      runtimeBlock.liveHelpersPeak = liveHelpers.peak
      persistCheckpoint(report, paths)
    }
  }

  for (const runtimeBlock of report.runtimes) {
    const sequentialFirst = runtimeBlock.sequentialPhase.filter(s => s.firstHelperCompilation)
    const sequentialRest = runtimeBlock.sequentialPhase.filter(s => !s.firstHelperCompilation)
    runtimeBlock.distribution = {
      sequential_first_helper_compilation: summarize(sequentialFirst),
      sequential: summarize(sequentialRest),
      shard_test_concurrency: summarize(runtimeBlock.shardConcurrencyPhase),
      all: summarize([
        ...runtimeBlock.sequentialPhase,
        ...runtimeBlock.shardConcurrencyPhase,
      ]),
    }
  }

  report.matrixComplete = true
  report.distributions = report.runtimes.map(r => ({ id: r.id, distribution: r.distribution }))
  persistCheckpoint(report, paths)

  console.log(JSON.stringify({
    ok: true,
    outPath: paths.reportPath,
    samplesJsonl: paths.samplesJsonlPath,
    matrixComplete: report.matrixComplete,
    sampleCount: report.rawSamples.length,
    runtimes: report.distributions,
  }, null, 2))
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
