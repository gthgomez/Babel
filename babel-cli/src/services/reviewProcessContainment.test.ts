import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

async function waitForJson(path: string, timeoutMs = 10_000): Promise<Record<string, unknown>> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (existsSync(path)) {
      try {
        return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
      } catch {
        // Retry a partial fixture write.
      }
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25))
  }
  throw new Error(`Timed out waiting for ${path}`)
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

async function waitUntilDead(pid: number, timeoutMs = 5_000): Promise<boolean> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (!isAlive(pid)) return true
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25))
  }
  return !isAlive(pid)
}

function forceCleanup(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid < 1 || !isAlive(pid)) return
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/pid', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    })
    return
  }
  try { process.kill(-pid, 'SIGKILL') } catch { /* already gone */ }
  try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
}

test('abrupt controller death independently contains the real worker descendant tree', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-review-controller-death-'))
  const state = join(root, 'worker.json')
  const containmentState = join(root, 'containment.json')
  const gate = join(root, 'start.gate')
  const marker = join(root, 'late-write.txt')
  const grandchild = join(root, 'grandchild.cjs')
  const worker = join(root, 'worker.cjs')
  const controllerFixture = join(root, 'controller.mts')
  const containmentModule = pathToFileURL(resolve(fileURLToPath(new URL('.', import.meta.url)), 'reviewProcessContainment.ts')).href
  const loader = pathToFileURL(resolve(fileURLToPath(new URL('../..', import.meta.url)), 'node_modules/tsx/dist/loader.mjs')).href

  writeFileSync(grandchild, `const { writeFileSync } = require('node:fs');
setTimeout(() => writeFileSync(${JSON.stringify(marker)}, 'escaped'), 1500);
setInterval(() => {}, 100);
`)
  writeFileSync(worker, `const { spawn } = require('node:child_process');
const { existsSync, writeFileSync } = require('node:fs');
const gate = ${JSON.stringify(gate)};
const wait = setInterval(() => {
  if (!existsSync(gate)) return;
  clearInterval(wait);
  const child = spawn(process.execPath, [${JSON.stringify(grandchild)}], { stdio: 'ignore', windowsHide: true });
  writeFileSync(${JSON.stringify(state)}, JSON.stringify({ workerPid: process.pid, grandchildPid: child.pid }));
  setInterval(() => {}, 100);
}, 10);
`)
  writeFileSync(controllerFixture, `import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { attachReviewProcessContainment } from ${JSON.stringify(containmentModule)};
const worker = spawn(process.execPath, [${JSON.stringify(worker)}], {
  detached: process.platform !== 'win32',
  stdio: 'ignore',
  windowsHide: true,
});
if (!worker.pid) throw new Error('fixture worker pid missing');
const containment = await attachReviewProcessContainment(worker.pid, process.pid);
writeFileSync(${JSON.stringify(containmentState)}, JSON.stringify({ kind: containment.kind, error: containment.error }));
writeFileSync(${JSON.stringify(gate)}, 'ready');
setInterval(() => {}, 100);
`)

  const controller = spawn(process.execPath, ['--import', loader, controllerFixture], {
    cwd: root,
    stdio: 'ignore',
    windowsHide: true,
  })
  let workerPid = 0
  let grandchildPid = 0
  try {
    const started = await waitForJson(state)
    const containment = await waitForJson(containmentState)
    workerPid = Number(started['workerPid'])
    grandchildPid = Number(started['grandchildPid'])
    assert.ok(workerPid > 0 && grandchildPid > 0)
    assert.equal(
      containment['kind'],
      process.platform === 'win32' ? 'windows_job_object' : 'posix_process_group',
      String(containment['error'] ?? ''),
    )

    controller.kill('SIGKILL')
    assert.equal(await waitUntilDead(workerPid), true, 'worker must die after its controller process dies')
    assert.equal(await waitUntilDead(grandchildPid), true, 'grandchild must die after its controller process dies')
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_700))
    assert.equal(existsSync(marker), false, 'contained descendant must not perform a delayed write')
  } finally {
    forceCleanup(workerPid)
    forceCleanup(grandchildPid)
    if (isAlive(controller.pid ?? 0)) controller.kill('SIGKILL')
    rmSync(root, { recursive: true, force: true })
  }
})
