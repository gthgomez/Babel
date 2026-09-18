import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { runJsonService } from './reviewServiceTransport.js'
import {
  createReviewAuthoritySupervisor,
  followReviewAuthorityLifetime,
  type ReviewAuthorityCandidate,
} from './reviewSupervisor.js'

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

function forceCleanup(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid < 1 || !isAlive(pid)) return
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    return
  }
  try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
}

test('finite trusted service timeout contains a real descendant before rejecting', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-review-service-timeout-'))
  const state = join(root, 'descendant.json')
  const marker = join(root, 'late-write.txt')
  const grandchild = join(root, 'grandchild.cjs')
  const service = join(root, 'service.cjs')
  writeFileSync(grandchild, `const { writeFileSync } = require('node:fs');
setTimeout(() => writeFileSync(${JSON.stringify(marker)}, 'escaped'), 1000);
setInterval(() => {}, 100);
`)
  writeFileSync(service, `const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
process.stdin.resume();
const child = spawn(process.execPath, [${JSON.stringify(grandchild)}], { stdio: 'ignore', windowsHide: true });
writeFileSync(${JSON.stringify(state)}, JSON.stringify({ pid: child.pid }));
setInterval(() => {}, 100);
`)
  let descendantPid = 0
  try {
    await assert.rejects(
      runJsonService({ command: process.execPath, args: [service], cwd: root, timeoutMs: 250 }, { request: true }),
      /timed out/i,
    )
    descendantPid = Number(JSON.parse(readFileSync(state, 'utf8')).pid)
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_200))
    assert.equal(isAlive(descendantPid), false, 'service descendant must be dead when timeout is reported')
    assert.equal(existsSync(marker), false, 'service descendant must not escape timeout cleanup')
  } finally {
    forceCleanup(descendantPid)
    rmSync(root, { recursive: true, force: true })
  }
})

test('trusted service follows renewable authority instead of the former finite timeout', async () => {
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
