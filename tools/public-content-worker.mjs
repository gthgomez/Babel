// License: Apache-2.0 — see LICENSE
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

/** One host-owned scan process and volatile cache per push. No candidate scripts execute. */
export function createPublicContentWorker(root) {
  const child = spawn('pwsh', ['-NoProfile', '-File', fileURLToPath(new URL('./security/public-content-worker.ps1', import.meta.url)), '-SourceRepository', root], { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const lines = createInterface({ input: child.stdout })
  let pending = null, stopped = false
  const stop = () => {
    stopped = true
    if (pending) { pending.reject(new Error('public content worker unavailable')); pending = null }
  }
  child.on('error', stop)
  child.on('close', stop)
  child.stdin.on('error', stop)
  child.stderr.resume()
  lines.on('line', line => {
    if (!pending) { child.kill(); return }
    const request = pending
    pending = null
    try {
      if (line.length > 2 * 1024 * 1024) throw new Error('response limit')
      const value = JSON.parse(line)
      if (!Number.isInteger(value.exitCode) || !['pass', 'warn', 'fail'].includes(value.result?.status) || !Array.isArray(value.result.findings)) throw new Error('invalid response')
      request.resolve(value)
    } catch { request.reject(new Error('public content worker response invalid')); child.kill() }
  })
  return {
    check(snapshot, sha) {
      if (stopped || pending) return Promise.reject(new Error('public content worker unavailable'))
      return new Promise((resolve, reject) => {
        pending = { resolve, reject }
        child.stdin.write(JSON.stringify({ snapshot, sha }) + '\n')
      })
    },
    close() { lines.close(); child.stdin.end(); child.kill() },
  }
}
