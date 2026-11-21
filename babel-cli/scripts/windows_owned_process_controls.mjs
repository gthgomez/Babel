// License: Apache-2.0 — see LICENSE
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'

/** Exercise the installed foreground owner and its Stop completion barrier on native Windows. */
export async function runInstalledWindowsOwnership(packageRoot, fixtureRoot) {
  assert.equal(process.platform, 'win32')
  const load = path => import(pathToFileURL(join(packageRoot, 'dist', path)).href)
  const { spawnCommandAsync } = await load('sandboxSpawnCommandAsync.js')
  const { awaitPendingProcessTerminations } = await load('sandboxProcessTermination.js')
  const { isProcessAlive } = await load('processTree.js')
  const batchControls = await Promise.all(['cmd', 'bat'].map(async extension => {
    const shellFixture = join(fixtureRoot, `argument shim.${extension}`)
    writeFileSync(shellFixture, '@echo off\r\necho %~1\r\necho %~2 1>&2\r\nexit /b 7\r\n')
    const result = await spawnCommandAsync(shellFixture, ['first argument', 'second argument'], {
      cwd: fixtureRoot, env: process.env, timeoutMs: 15_000,
    })
    assert.ifError(result.error)
    assert.equal(result.processStarted, true)
    assert.equal(result.status, 7)
    assert.equal(result.stdout.trim(), 'first argument')
    assert.equal(result.stderr.trim(), 'second argument')
    return extension
  }))
  const fixture = join(fixtureRoot, 'job-tree.cjs')
  writeFileSync(fixture, `
const { spawn } = require('node:child_process');
const { existsSync, renameSync, writeFileSync } = require('node:fs');
const [role, directory] = process.argv.slice(2);
const path = require('node:path');
if (role !== 'grandchild') {
  const child = spawn(process.execPath, [__filename, role === 'leader' ? 'child' : 'grandchild', directory], {
    stdio: 'ignore', windowsHide: true,
  });
  child.unref();
}
const receipt = path.join(directory, role);
writeFileSync(receipt + '.tmp', String(process.pid));
renameSync(receipt + '.tmp', receipt);
if (role !== 'leader') {
  const interval = setInterval(() => {
    if (existsSync(path.join(directory, 'release'))) clearInterval(interval);
  }, 25);
  setTimeout(() => clearInterval(interval), 45_000).unref();
}
`)

  const unrelated = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], {
    stdio: 'ignore', windowsHide: true,
  })
  try {
    const evidence = { batchControls }
    for (const mode of ['stop', 'timeout']) {
      const cwd = join(fixtureRoot, mode)
      mkdirSync(cwd)
      const controller = new AbortController()
      const owner = `installed-windows-ownership-${mode}`
      const pending = spawnCommandAsync(process.execPath, [fixture, 'leader', cwd], {
        cwd, env: process.env, timeoutMs: 15_000, signal: controller.signal, processContext: { sessionId: owner },
      })
      try {
        const roles = ['leader', 'child', 'grandchild']
        const deadline = Date.now() + 80_000
        let completed = false
        void pending.then(() => { completed = true })
        while (!roles.every(role => existsSync(join(cwd, role)))) {
          assert.ok(!completed && Date.now() < deadline, 'owned process tree must start')
          await delay(25)
        }
        const [leader, child, grandchild] = roles.map(role => Number(readFileSync(join(cwd, role), 'utf8')))
        for (const pid of [leader, child, grandchild]) assert.ok(Number.isSafeInteger(pid) && pid > 0)
        while (isProcessAlive(leader)) {
          assert.ok(!completed && Date.now() < deadline, 'owned leader must exit before Stop or deadline')
          await delay(25)
        }
        assert.equal(completed, false, 'a direct exit cannot settle a live job')
        assert.ok(isProcessAlive(child) && isProcessAlive(grandchild), 'both owned descendants must be alive before settlement')
        assert.ok(unrelated.pid && isProcessAlive(unrelated.pid), 'independent control must be alive')
        if (mode === 'stop') controller.abort()
        const result = await pending
        assert.equal(result.processStarted, true)
        assert.equal(mode === 'stop' ? result.aborted : result.timedOut, true)
        assert.notEqual(result.status, 0)
        await awaitPendingProcessTerminations(owner)
        assert.equal(isProcessAlive(child), false, 'owned child survived completed settlement')
        assert.equal(isProcessAlive(grandchild), false, 'owned grandchild survived completed settlement')
        assert.ok(isProcessAlive(unrelated.pid), 'settling the job killed unrelated work')
        evidence[mode] = { leaderExitedFirst: true, childSettled: true, grandchildSettled: true, unrelatedSurvived: true }
      } finally {
        // Release only this synthetic fixture if an assertion fails. Never kill
        // a process by PID from an on-disk marker.
        writeFileSync(join(cwd, 'release'), '')
        if (!controller.signal.aborted) controller.abort()
        await pending
        try { await awaitPendingProcessTerminations(owner) } catch { /* observed on the assertion path */ }
      }
    }
    return evidence
  } finally {
    unrelated.kill()
  }
}
