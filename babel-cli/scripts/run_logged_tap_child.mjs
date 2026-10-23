// License: Apache-2.0 — see LICENSE
import { spawn, spawnSync } from 'node:child_process'
import { createWriteStream, existsSync, readFileSync } from 'node:fs'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/** Stream progress, retain both complete producer logs, and preserve the child outcome. */
export async function runLoggedTapChild(command, args, { cwd, env, tapPath, stdout = process.stdout, stderr = process.stderr, label = 'TAP', maxLogBytes = 64 * 1024 * 1024, signal }) {
  if (!Number.isSafeInteger(maxLogBytes) || maxLogBytes < 1) throw new Error('invalid TAP capture budget')
  const child = spawn(command, args, { cwd, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
  const started = performance.now()
  const heartbeat = setInterval(() => stderr.write(`# ${label} running elapsed_s=${Math.round((performance.now() - started) / 1000)}\n`), 10000)
  const log = createWriteStream(tapPath)
  const errorLog = createWriteStream(tapPath + '.stderr.log')
  let captureError, interrupted, stopped = false, capturedBytes = 0
  function stopOwnedTree() {
    if (stopped || !child.pid || child.exitCode !== null || child.signalCode !== null) return
    stopped = true
    if (process.platform === 'win32') {
      const killed = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10000 })
      if (killed.error || killed.status !== 0) child.kill('SIGKILL')
    } else {
      try { process.kill(-child.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') child.kill('SIGKILL') }
    }
  }
  function cancel(reason) { interrupted = reason; captureError ??= new Error('TAP producer interrupted'); stopOwnedTree() }
  const onInterrupt = () => cancel('SIGINT'), onTerminate = () => cancel('SIGTERM'), onAbort = () => cancel('SIGTERM')
  process.once('SIGINT', onInterrupt); process.once('SIGTERM', onTerminate)
  signal?.addEventListener('abort', onAbort, { once: true })
  function boundedStream(destination) {
    const bounded = new Transform({ transform(chunk, _encoding, callback) {
      const remaining = Math.max(0, maxLogBytes - capturedBytes)
      const retained = chunk.subarray(0, remaining)
      capturedBytes += retained.length
      if (chunk.length > remaining) {
        captureError ??= new Error('TAP output limit exceeded; bounded logs retained')
        stopOwnedTree()
      }
      callback(null, retained.length ? retained : undefined)
    } })
    bounded.pipe(destination, { end: false })
    return bounded
  }
  const captured = Promise.all([
    pipeline(child.stdout, boundedStream(stdout), log).catch(error => { captureError ??= error; stopOwnedTree() }),
    pipeline(child.stderr, boundedStream(stderr), errorLog).catch(error => { captureError ??= error; stopOwnedTree() }),
  ])
  try {
    const outcome = await new Promise(resolve => {
      child.once('error', error => resolve({ status: null, error, signal: null }))
      child.once('close', (status, signal) => resolve({ status, signal }))
      if (signal?.aborted) onAbort()
    })
    await captured
    return { ...outcome, signal: interrupted ?? outcome.signal, error: outcome.error ?? captureError,
      stdout: captureError || !existsSync(tapPath) ? '' : readFileSync(tapPath, 'utf8'), stderr: '' }
  } finally {
    clearInterval(heartbeat)
    process.removeListener('SIGINT', onInterrupt); process.removeListener('SIGTERM', onTerminate)
    signal?.removeEventListener('abort', onAbort)
  }
}
