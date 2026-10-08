import assert from 'node:assert/strict'
import { spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'

import {
  WINDOWS_JOB_COMPILE_TIMEOUT_MS,
  WINDOWS_JOB_HELPER_TIMEOUT_MS,
} from './reviewProcessContainment.js'
import { runJsonService } from './reviewServiceTransport.js'
import {
  createReviewAuthoritySupervisor,
  followReviewAuthorityLifetime,
  type ReviewAuthorityCandidate,
  type ReviewAuthorityMonitor,
} from './reviewSupervisor.js'

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    // A terminated owned Linux process can retain a PID until its parent reaps it.
    // Zombies and dead tasks cannot execute the fixture's delayed write.
    const state = ownedLinuxProcessState(pid)
    return state !== 'Z' && state !== 'X'
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

function ownedLinuxProcessState(pid: number): string {
  if (process.platform !== 'linux') return 'not-linux'
  try {
    // Read only this fixture's validated descendant state; never its command line.
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] ?? 'unknown'
  } catch { return 'unavailable' }
}

function forceCleanup(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid < 1 || !isAlive(pid)) return
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 1_500 })
    return
  }
  try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
}

// Keep fixture polling, containment admission and cleanup watchdogs on the real clock.
const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout
const pause = (ms: number): Promise<void> => new Promise(resolve => realSetTimeout(resolve, ms))

async function bounded<T>(running: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      running,
      new Promise<never>((_, reject) => { timer = realSetTimeout(() => reject(new Error(message)), timeoutMs) }),
    ])
  } finally {
    if (timer) realClearTimeout(timer)
  }
}

function captureNextChildSpawn(afterCapture?: () => void): {
  child: ChildProcess | undefined
  closed: Promise<void>
  hasClosed(): boolean
  restore(): void
} {
  const childProcess = createRequire(import.meta.url)('node:child_process') as {
    spawn: typeof import('node:child_process').spawn
  }
  const originalSpawn = childProcess.spawn
  let child: ChildProcess | undefined
  let closedObserved = false
  let resolveClosed!: () => void
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; })
  childProcess.spawn = ((...args: Parameters<typeof originalSpawn>) => {
    const spawned = Reflect.apply(originalSpawn, childProcess, args) as ChildProcess
    if (!child) {
      child = spawned
      child.once('close', () => {
        closedObserved = true
        resolveClosed()
      })
      afterCapture?.()
    }
    return spawned
  }) as typeof originalSpawn
  syncBuiltinESMExports()
  return {
    get child() { return child },
    closed,
    hasClosed: () => closedObserved,
    restore(): void {
      childProcess.spawn = originalSpawn
      syncBuiltinESMExports()
    },
  }
}

function fixturePid(record: Record<string, unknown>): number {
  assert.ok(typeof record.pid === 'number' && Number.isSafeInteger(record.pid) && record.pid > 0,
    'fixture must publish its own positive integer PID')
  return record.pid
}

type ServiceOutcome = { ok: true } | { ok: false; error: unknown }
const windowsContainmentSetupAllowanceMs = process.platform === 'win32'
  ? WINDOWS_JOB_COMPILE_TIMEOUT_MS + WINDOWS_JOB_HELPER_TIMEOUT_MS
  : 0

async function waitForReady(path: string, running: Promise<ServiceOutcome>, timeoutMs = 10_000): Promise<number> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    // Race the real run even when publication is already visible; early exit is a failure.
    await Promise.race([
      pause(20),
      running.then(outcome => { throw new Error(`Service ended before fixture readiness: ${outcome.ok ? 'resolved' : String(outcome.error)}`) }),
    ])
    if (existsSync(path)) {
      const record = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
      assert.equal(record.ready, true, 'fixture readiness must be explicit')
      return fixturePid(record)
    }
  }
  throw new Error('Fixture readiness not achieved within its real-clock bound.')
}

async function waitUntilDead(pid: number): Promise<boolean> {
  const started = Date.now()
  while (isAlive(pid) && Date.now() - started < 5_000) await pause(25)
  return !isAlive(pid)
}

function controlFiniteTimer(t: TestContext) {
  let registered = 0
  let fired = 0
  let cleared = false
  let handle: ReturnType<typeof setTimeout> | undefined
  let deliver: (() => void) | undefined
  let elapsed = 0
  t.mock.method(globalThis, 'setTimeout', (callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    const caller = new Error().stack ?? ''
    if (!/reviewServiceTransport\.ts:\d/.test(caller) || !callback.toString().includes('finite_timeout')) {
      return realSetTimeout(callback, ms, ...args)
    }
    assert.equal(ms, 250, 'capture the actual production finite deadline unchanged')
    assert.equal(++registered, 1, 'production must register exactly one finite timer')
    assert.equal(args.length, 0)
    // A native handle preserves unref/clearTimeout semantics; only delivery is controlled.
    handle = realSetTimeout(() => {}, 2_147_483_647)
    deliver = () => callback()
    return handle
  })
  t.mock.method(globalThis, 'clearTimeout', (timer: ReturnType<typeof setTimeout>) => {
    if (timer === handle) cleared = true
    realClearTimeout(timer)
  })
  return {
    advance(ms: number): void {
      assert.equal(registered, 1, 'finite timer must be registered before advancement')
      assert.ok(ms >= elapsed)
      elapsed = ms
      if (ms >= 250 && fired === 0) {
        assert.equal(cleared, false, 'finite timer must still be pending')
        realClearTimeout(handle)
        fired++
        deliver!()
      }
    },
    counts: () => ({ registered, fired, cleared }),
  }
}

test('finite trusted service rejects at its real 250 ms deadline', { timeout: 15_000 + windowsContainmentSetupAllowanceMs }, async () => {
  const abort = new AbortController()
  const running = runJsonService({
    command: process.execPath,
    args: ['--eval', 'process.stdin.resume(); setInterval(() => {}, 100);'],
    timeoutMs: 250,
    abortSignal: abort.signal,
  }, { request: true })
  const rejection = assert.rejects(running, { message: 'Trusted review service timed out.' })
  try {
    // Windows containment has its own bounded helper-compile and assignment stages.
    // This allowance covers setup; the production service deadline stays at 250 ms.
    await bounded(rejection, 12_000 + windowsContainmentSetupAllowanceMs,
      'Real finite timeout did not complete after bounded containment setup and cleanup.')
  } finally {
    abort.abort()
    await running.catch(() => {})
  }
})

test('abort during containment attachment keeps the gated service from starting', { timeout: 10_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-review-service-abort-'))
  const started = join(root, 'service-started')
  const service = join(root, 'service.cjs')
  writeFileSync(service, `const { writeFileSync } = require('node:fs');
writeFileSync(${JSON.stringify(started)}, 'started');
process.stdout.write(JSON.stringify({ started: true }));
`)
  const abort = new AbortController()
  const captured = captureNextChildSpawn()
  try {
    const running = runJsonService({
      command: process.execPath,
      args: [service],
      cwd: root,
      abortSignal: abort.signal,
    }, { request: true })
    abort.abort()
    await assert.rejects(running, { message: 'Trusted review service aborted.' })
    assert.ok(captured.child, 'transport must spawn its gated controller')
    assert.equal(captured.hasClosed(), true, 'abort must await the gated controller close before rejection')
    assert.equal(existsSync(started), false, 'an aborted service must not pass the start gate')
  } finally {
    captured.restore()
    if (captured.child && captured.child.signalCode === null && captured.child.exitCode === null) {
      captured.child.kill('SIGKILL')
      await bounded(captured.closed, 2_000, 'Test recovery could not close the gated controller.')
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('containment attachment failure terminates and closes the gated child before rejection', { timeout: 10_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-review-service-attach-failure-'))
  const started = join(root, 'service-started')
  const service = join(root, 'service.cjs')
  writeFileSync(service, `const { writeFileSync } = require('node:fs');
writeFileSync(${JSON.stringify(started)}, 'started');
process.stdout.write(JSON.stringify({ started: true }));
`)
  const originalExecPath = process.execPath
  const originalSystemRoot = process.env['SystemRoot']
  const originalSystemRootUpper = process.env['SYSTEMROOT']
  const captured = captureNextChildSpawn(() => {
    process.execPath = join(root, 'missing-node-executable')
    if (process.platform === 'win32') {
      process.env['SystemRoot'] = 'invalid-system-root'
      process.env['SYSTEMROOT'] = 'invalid-system-root'
    }
  })
  try {
    await assert.rejects(runJsonService({
      command: originalExecPath,
      args: [service],
      cwd: root,
    }, { request: true }), process.platform === 'win32'
      ? /WINDOWS_JOB_SYSTEM_ROOT_INVALID/
      : /POSIX review containment watchdog could not start/)
    assert.ok(captured.child, 'transport must spawn its gated controller')
    assert.equal(captured.hasClosed(), true, 'startup failure must await the gated controller close before rejection')
    assert.equal(existsSync(started), false, 'a failed containment attach must not open the service gate')
  } finally {
    process.execPath = originalExecPath
    if (originalSystemRoot === undefined) delete process.env['SystemRoot']
    else process.env['SystemRoot'] = originalSystemRoot
    if (originalSystemRootUpper === undefined) delete process.env['SYSTEMROOT']
    else process.env['SYSTEMROOT'] = originalSystemRootUpper
    captured.restore()
    if (captured.child && !captured.hasClosed()) {
      captured.child.kill('SIGKILL')
      await bounded(captured.closed, 2_000, 'Test recovery could not close the gated controller.')
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('authority lost during containment attachment keeps the gated service from starting', { timeout: 10_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-review-service-authority-loss-'))
  const started = join(root, 'service-started')
  const service = join(root, 'service.cjs')
  writeFileSync(service, `const { writeFileSync } = require('node:fs');
writeFileSync(${JSON.stringify(started)}, 'started');
process.stdout.write(JSON.stringify({ started: true }));
`)
  const candidate: ReviewAuthorityCandidate = {
    repository: 'gthgomez/Babel',
    prNumber: 201,
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    candidateDigest: 'c'.repeat(64),
  }
  const now = Date.now()
  const issued = createReviewAuthoritySupervisor({
    statePath: join(root, 'authority.json'),
    candidate,
    allowance: {
      allowanceId: 'transport-allowance',
      taskId: 'transport-task',
      executionId: 'transport-execution',
      startedAt: new Date(now).toISOString(),
      elapsedLimitMs: 25,
      evidenceLineage: ['transport-test'],
    },
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 5_000).toISOString(),
    now: () => now,
  })
  let inspections = 0
  const authority: ReviewAuthorityMonitor = {
    inspect: exactCandidate => {
      inspections++
      return inspections === 1
        ? issued.monitor.inspect(exactCandidate)
        : { admitted: false, cause: 'candidate_changed' }
    },
    snapshot: () => issued.monitor.snapshot(),
    recordTerminal: cause => issued.monitor.recordTerminal(cause),
  }
  try {
    await assert.rejects(runJsonService({
      command: process.execPath,
      args: [service],
      cwd: root,
      hostLifetime: followReviewAuthorityLifetime({ pollIntervalMs: 20, cleanupTimeoutMs: 1_000 }),
      authority,
      candidate,
    }, { request: true }), { message: 'Trusted review service authority ended: candidate_changed.' })
    assert.equal(inspections, 2, 'authority must be rechecked after containment attaches')
    assert.equal(existsSync(started), false, 'a changed candidate must not pass the start gate')
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('authority recheck failure closes the gated child before rejection', { timeout: 10_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-review-service-authority-error-'))
  const started = join(root, 'service-started')
  const service = join(root, 'service.cjs')
  writeFileSync(service, `const { writeFileSync } = require('node:fs');
writeFileSync(${JSON.stringify(started)}, 'started');
process.stdout.write(JSON.stringify({ started: true }));
`)
  const candidate: ReviewAuthorityCandidate = {
    repository: 'gthgomez/Babel',
    prNumber: 201,
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    candidateDigest: 'c'.repeat(64),
  }
  const now = Date.now()
  const issued = createReviewAuthoritySupervisor({
    statePath: join(root, 'authority.json'),
    candidate,
    allowance: {
      allowanceId: 'transport-allowance',
      taskId: 'transport-task',
      executionId: 'transport-execution',
      startedAt: new Date(now).toISOString(),
      elapsedLimitMs: 25,
      evidenceLineage: ['transport-test'],
    },
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 5_000).toISOString(),
    now: () => now,
  })
  let inspections = 0
  const authority: ReviewAuthorityMonitor = {
    inspect: exactCandidate => {
      inspections++
      if (inspections > 1) throw new Error('Synthetic authority checkpoint write failed.')
      return issued.monitor.inspect(exactCandidate)
    },
    snapshot: () => issued.monitor.snapshot(),
    recordTerminal: cause => issued.monitor.recordTerminal(cause),
  }
  const captured = captureNextChildSpawn()
  try {
    await assert.rejects(runJsonService({
      command: process.execPath,
      args: [service],
      cwd: root,
      hostLifetime: followReviewAuthorityLifetime({ pollIntervalMs: 20, cleanupTimeoutMs: 1_000 }),
      authority,
      candidate,
    }, { request: true }), { message: 'Synthetic authority checkpoint write failed.' })
    assert.equal(inspections, 2)
    assert.ok(captured.child, 'transport must spawn its gated controller')
    assert.equal(captured.hasClosed(), true, 'authority inspection failure must await controller close')
    assert.equal(existsSync(started), false, 'failed authority inspection must not open the service gate')
  } finally {
    captured.restore()
    if (captured.child && !captured.hasClosed()) {
      captured.child.kill('SIGKILL')
      await bounded(captured.closed, 2_000, 'Test recovery could not close the gated controller.')
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('finite trusted service timeout contains a ready real descendant at controlled 250 ms delivery', {
  timeout: 30_000 + windowsContainmentSetupAllowanceMs,
}, async t => {
  const root = mkdtempSync(join(tmpdir(), 'babel-review-service-timeout-'))
  const state = join(root, 'descendant.json')
  const serviceState = join(root, 'service.json')
  const descendantIdentity = join(root, 'descendant-pid.json')
  const arm = join(root, 'arm')
  const armed = join(root, 'armed.json')
  const marker = join(root, 'late-write.txt')
  const grandchild = join(root, 'grandchild.cjs')
  const service = join(root, 'service.cjs')
  writeFileSync(grandchild, `const { existsSync, writeFileSync, renameSync } = require('node:fs');
const publish = (path, record) => { writeFileSync(path + '.tmp', JSON.stringify(record)); renameSync(path + '.tmp', path); };
if (!Number.isSafeInteger(process.pid) || process.pid < 1) process.exit(64);
publish(${JSON.stringify(descendantIdentity)}, { pid: process.pid });
publish(${JSON.stringify(state)}, { pid: process.pid, ready: true });
const gate = setInterval(() => {
  if (!existsSync(${JSON.stringify(arm)})) return;
  clearInterval(gate);
  setTimeout(() => writeFileSync(${JSON.stringify(marker)}, 'escaped'), 1000);
  publish(${JSON.stringify(armed)}, { pid: process.pid, ready: true });
}, 10);
setInterval(() => {}, 100);
`)
  writeFileSync(service, `const { spawn } = require('node:child_process');
const { writeFileSync, renameSync } = require('node:fs');
process.stdin.resume();
if (!Number.isSafeInteger(process.pid) || process.pid < 1) process.exit(64);
writeFileSync(${JSON.stringify(serviceState + '.tmp')}, JSON.stringify({ pid: process.pid }));
renameSync(${JSON.stringify(serviceState + '.tmp')}, ${JSON.stringify(serviceState)});
spawn(process.execPath, [${JSON.stringify(grandchild)}], { stdio: 'ignore', windowsHide: true });
setInterval(() => {}, 100);
`)
  const clock = controlFiniteTimer(t)
  const abort = new AbortController()
  let settled = false
  const running = runJsonService({ command: process.execPath, args: [service], cwd: root, timeoutMs: 250, abortSignal: abort.signal }, { request: true })
  // Attach both branches immediately so readiness failures cannot leave an unhandled rejection.
  const observed: Promise<ServiceOutcome> = running.then(
    () => { settled = true; return { ok: true } },
    error => { settled = true; return { ok: false, error } },
  )
  const tracked = new Set<number>()
  let primaryError: unknown
  try {
    const descendantPid = await waitForReady(state, observed, 10_000 + windowsContainmentSetupAllowanceMs)
    tracked.add(descendantPid)
    assert.equal(isAlive(descendantPid), true, 'ready descendant must be alive before the deadline')
    assert.equal(settled, false)
    assert.equal(existsSync(marker), false)
    writeFileSync(arm, 'arm\n')
    assert.equal(
      await waitForReady(armed, observed, 10_000 + windowsContainmentSetupAllowanceMs),
      descendantPid,
      'the ready descendant must acknowledge arming',
    )
    clock.advance(249)
    await pause(20)
    assert.equal(settled, false, 'service must remain pending at logical 249 ms')
    assert.equal(isAlive(descendantPid), true, 'descendant must remain alive at logical 249 ms')
    assert.equal(clock.counts().fired, 0)
    clock.advance(250)
    clock.advance(250)
    const outcome = await bounded(observed, 10_000, 'Finite stop did not complete its real cleanup.')
    assert.equal(outcome.ok, false, 'finite timeout must reject')
    if (outcome.ok) assert.fail('Finite timeout unexpectedly resolved.')
    assert.ok(outcome.error instanceof Error)
    assert.equal(outcome.error.message, 'Trusted review service timed out.')
    const servicePid = fixturePid(JSON.parse(readFileSync(serviceState, 'utf8')) as Record<string, unknown>)
    tracked.add(servicePid)
    assert.equal(isAlive(servicePid), false,
      `service process must be dead when timeout is reported; owned Linux state=${ownedLinuxProcessState(servicePid)}`)
    assert.equal(isAlive(descendantPid), false, `service descendant must be dead when timeout is reported; owned Linux state=${ownedLinuxProcessState(descendantPid)}`)
    assert.deepEqual(clock.counts(), { registered: 1, fired: 1, cleared: true })
    await pause(1_200)
    assert.equal(existsSync(marker), false, 'service descendant must not escape timeout cleanup')
  } catch (error) {
    primaryError = error
  } finally {
    abort.abort()
    let recoveryError: unknown
    try {
      await bounded(observed, 10_000, `Service cleanup failed; preserve fixture evidence at ${root}`)
    } catch (error) {
      recoveryError = error
    }
    // Recover validated own-PID publications even when readiness is absent or malformed.
    for (const path of [serviceState, descendantIdentity]) {
      try {
        if (existsSync(path)) tracked.add(fixturePid(JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>))
      } catch (error) {
        recoveryError ??= error
      }
    }
    for (const pid of tracked) forceCleanup(pid)
    const deaths = await Promise.all([...tracked].map(async pid => ({ pid, dead: await waitUntilDead(pid) })))
    for (const { pid, dead } of deaths) {
      try {
        assert.equal(dead, true, `Fixture PID ${pid} must die before deleting ${root}`)
      } catch (error) {
        recoveryError ??= error
      }
    }
    // Emergency PID recovery must still await the actual transport, never replace it.
    if (!settled) {
      try {
        await bounded(observed, 10_000, `Service remained pending after recovery; preserve ${root}`)
      } catch (error) {
        recoveryError ??= error
      }
    }
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    } catch (error) {
      recoveryError ??= error
    }
    if (recoveryError && primaryError) {
      throw new AggregateError([primaryError, recoveryError], 'Finite timeout assertion and fixture cleanup both failed.')
    }
    if (recoveryError) throw recoveryError
  }
  if (primaryError) throw primaryError
})

test('trusted service follows renewable authority instead of the former finite timeout', { timeout: 15_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-review-service-authority-'))
  const service = join(root, 'service.cjs')
  const candidate: ReviewAuthorityCandidate = {
    repository: 'gthgomez/Babel',
    prNumber: 201,
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    candidateDigest: 'c'.repeat(64),
  }
  writeFileSync(service, `let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => setTimeout(() => process.stdout.write(JSON.stringify({ accepted: JSON.parse(input).request })), 180));
`)
  const now = Date.now()
  const authority = createReviewAuthoritySupervisor({
    statePath: join(root, 'authority.json'),
    candidate,
    allowance: {
      allowanceId: 'transport-allowance',
      taskId: 'transport-task',
      executionId: 'transport-execution',
      startedAt: new Date(now).toISOString(),
      elapsedLimitMs: 25,
      evidenceLineage: ['transport-test'],
    },
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 5_000).toISOString(),
    now: () => now,
  })
  try {
    const result = await runJsonService<{ accepted: boolean }>({
      command: process.execPath,
      args: [service],
      cwd: root,
      timeoutMs: 50,
      hostLifetime: followReviewAuthorityLifetime({ pollIntervalMs: 20, cleanupTimeoutMs: 1_000 }),
      authority: authority.monitor,
      candidate,
    }, { request: true })
    assert.deepEqual(result, { accepted: true })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
