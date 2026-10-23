// License: Apache-2.0 — see LICENSE
import { spawn, spawnSync } from 'node:child_process'
import { createWriteStream, existsSync, readFileSync } from 'node:fs'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

// On Windows the bootstrap waits for native Job Object assignment before it
// can create descendants. Reuse the existing containment owner rather than
// discovering descendants after their parent has already exited.
const windowsBootstrap = `
const {spawn}=require('node:child_process');
const hold=setInterval(()=>{},1000);
process.once('message', ({command,args})=>{
  const finish=(result)=>process.send({type:'producer-outcome',...result},()=>process.exit(result.status??1));
  const producer=spawn(command,args,{stdio:['ignore','inherit','inherit'],windowsHide:true});
  producer.once('error',()=>finish({status:null,signal:null,failed:true}));
  producer.once('exit',(status,signal)=>finish({status,signal}));
});`

/** Stream progress, retain both complete producer logs, and preserve the child outcome. */
export async function runLoggedTapChild(command, args, { cwd, env, tapPath, stdout = process.stdout, stderr = process.stderr, label = 'TAP', maxLogBytes = 64 * 1024 * 1024, signal }) {
  if (!Number.isSafeInteger(maxLogBytes) || maxLogBytes < 1) throw new Error('invalid TAP capture budget')
  const windows = process.platform === 'win32'
  const child = spawn(windows ? process.execPath : command, windows ? ['-e', windowsBootstrap] : args, {
    cwd, env, windowsHide: true, detached: !windows, stdio: windows ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'],
  })
  const started = performance.now()
  const heartbeat = setInterval(() => stderr.write(`# ${label} running elapsed_s=${Math.round((performance.now() - started) / 1000)}\n`), 10000)
  const log = createWriteStream(tapPath)
  const errorLog = createWriteStream(tapPath + '.stderr.log')
  let captureError, interrupted, containment, producerOutcome, closed = false, stopped = false, capturedBytes = 0
  child.on('message', value => {
    if (value?.type === 'producer-outcome' && (value.status === null || Number.isInteger(value.status))) {
      producerOutcome = { status: value.status, signal: value.signal, ...(value.failed ? { error: new Error('TAP producer could not start') } : {}) }
    }
  })
  function stopOwnedTree() {
    if (stopped || !child.pid || closed) return
    stopped = true
    containment?.release()
    if (windows && child.exitCode === null && child.signalCode === null) {
      const killed = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10000 })
      if (killed.error || killed.status !== 0) child.kill('SIGKILL')
    } else if (!windows) {
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
    const completed = new Promise(resolve => {
      child.once('error', error => resolve({ status: null, error, signal: null }))
      child.once('close', (status, signal) => { closed = true; resolve(producerOutcome ?? { status, signal }) })
      if (signal?.aborted) onAbort()
    })
    if (windows && !stopped) {
      try {
        const { tsImport } = await import('tsx/esm/api')
        const { attachWindowsReviewJobObject } = await tsImport('../src/services/reviewProcessContainment.ts', import.meta.url)
        containment = await attachWindowsReviewJobObject(child.pid, process.pid, signal)
        if (containment.kind !== 'windows_job_object') throw new Error('TAP native process containment unavailable')
        if (stopped || signal?.aborted) containment.release()
        else child.send({ command, args }, error => { if (error) { captureError ??= error; stopOwnedTree() } })
      } catch (error) { captureError ??= error; stopOwnedTree() }
    }
    const outcome = await completed
    await captured
    return { ...outcome, signal: interrupted ?? outcome.signal, error: outcome.error ?? captureError,
      stdout: captureError || !existsSync(tapPath) ? '' : readFileSync(tapPath, 'utf8'), stderr: '' }
  } finally {
    containment?.release()
    clearInterval(heartbeat)
    process.removeListener('SIGINT', onInterrupt); process.removeListener('SIGTERM', onTerminate)
    signal?.removeEventListener('abort', onAbort)
  }
}
