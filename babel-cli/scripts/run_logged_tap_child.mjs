// License: Apache-2.0 — see LICENSE
import { spawn } from 'node:child_process'
import { createWriteStream, existsSync, readFileSync, statSync } from 'node:fs'
import { pipeline } from 'node:stream/promises'

/** Stream progress, retain both complete producer logs, and preserve the child outcome. */
export async function runLoggedTapChild(command, args, { cwd, env, tapPath, stdout = process.stdout, stderr = process.stderr, label = 'TAP' }) {
  const child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const started = performance.now()
  const heartbeat = setInterval(() => stderr.write(`# ${label} running elapsed_s=${Math.round((performance.now() - started) / 1000)}\n`), 10000)
  const log = createWriteStream(tapPath)
  const errorLog = createWriteStream(tapPath + '.stderr.log')
  let captureError
  child.stdout.pipe(stdout, { end: false })
  child.stderr.pipe(stderr, { end: false })
  const captured = Promise.all([
    pipeline(child.stdout, log).catch(error => { captureError = error }),
    pipeline(child.stderr, errorLog).catch(error => { captureError = error }),
  ])
  try {
    const outcome = await new Promise(resolve => {
      child.once('error', error => resolve({ status: null, error, signal: null }))
      child.once('close', (status, signal) => resolve({ status, signal }))
    })
    await captured
    if (existsSync(tapPath) && statSync(tapPath).size > 64 * 1024 * 1024) captureError = new Error('TAP analysis limit exceeded; full log retained')
    return { ...outcome, error: outcome.error ?? captureError,
      stdout: captureError || !existsSync(tapPath) ? '' : readFileSync(tapPath, 'utf8'), stderr: '' }
  } finally { clearInterval(heartbeat) }
}
