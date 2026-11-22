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
  const fixtureName = 'job-tree.cjs'
  const fixture = `
const { spawn } = require('node:child_process');
const { closeSync, existsSync, openSync, renameSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const role = process.argv[2];
if (!['leader', 'child', 'grandchild'].includes(role)) throw new Error('unsupported ownership fixture role');
const directory = process.cwd();
function publish(name, value) {
  const receipt = join(directory, name);
  writeFileSync(receipt + '.tmp', value);
  renameSync(receipt + '.tmp', receipt);
}
if (role !== 'grandchild') {
  const next = role === 'leader' ? 'child' : 'grandchild';
  const stderr = openSync(join(directory, next + '-stderr'), 'w');
  let child;
  try {
    child = spawn(process.execPath, [${JSON.stringify(fixtureName)}, next], {
      // Windows libuv puts non-detached children in the spawning Node
      // process's own kill-on-close job. Skip that extra job so a fixture can
      // outlive its parent. libuv does not set CREATE_BREAKAWAY_FROM_JOB.
      cwd: directory, stdio: ['ignore', 'ignore', stderr], windowsHide: true, detached: true,
    });
  } finally {
    closeSync(stderr);
  }
  child.once('error', error => {
    const code = error.code || 'UNKNOWN';
    publish(role + '-spawn-failure', /^[A-Z0-9_]+$/.test(code) ? code : 'UNKNOWN');
    process.exitCode = 1;
  });
  child.once('exit', code => {
    if (!existsSync(join(directory, 'release'))) publish(next + '-early-exit', String(code ?? 'SIGNALLED'));
  });
  if (role === 'leader') {
    // Drive the leader-exits-first case only after both nested processes
    // have entered their running loops. Windows child startup is asynchronous.
    const deadline = Date.now() + 8_000;
    const waitForTree = setInterval(() => {
      if (['child', 'grandchild'].every(name => existsSync(join(directory, name)))) {
        clearInterval(waitForTree);
        child.unref();
      } else if (child.exitCode !== null || child.signalCode !== null || Date.now() >= deadline) {
        clearInterval(waitForTree);
        publish('leader-readiness-failure', 'DESCENDANTS_DID_NOT_START');
        child.unref();
        process.exitCode = 1;
      }
    }, 15);
  } else {
    child.unref();
  }
}
publish(role, String(process.pid));
if (role !== 'leader') {
  const interval = setInterval(() => {
    if (existsSync(join(directory, 'release'))) clearInterval(interval);
  }, 25);
  setTimeout(() => clearInterval(interval), 45_000).unref();
}
`

  const unrelated = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 200000)'], {
    stdio: 'ignore', windowsHide: true,
  })
  try {
    const evidence = { batchControls }
    for (const mode of ['stop', 'timeout']) {
      const cwd = join(fixtureRoot, mode)
      mkdirSync(cwd)
      writeFileSync(join(cwd, fixtureName), fixture)
      const controller = new AbortController()
      const owner = `installed-windows-ownership-${mode}`
      const pending = spawnCommandAsync(process.execPath, [fixtureName, 'leader'], {
        cwd, env: process.env, timeoutMs: 15_000, signal: controller.signal, processContext: { sessionId: owner },
      })
      try {
        const roles = ['leader', 'child', 'grandchild']
        const deadline = Date.now() + 80_000
        let completed
        void pending.then(result => { completed = result })
        while (!roles.every(role => existsSync(join(cwd, role)))) {
          const failedRole = roles.find(role => existsSync(join(cwd, role + '-spawn-failure')))
          if (failedRole) {
            const value = readFileSync(join(cwd, failedRole + '-spawn-failure'), 'utf8')
            const code = /^[A-Z0-9_]{1,40}$/.test(value) ? value : 'UNKNOWN'
            assert.fail(`owned Windows ${mode} fixture ${failedRole} failed to launch its descendant (${code})`)
          }
          const exitedRole = roles.find(role => existsSync(join(cwd, role + '-early-exit')))
          if (exitedRole) {
            const value = readFileSync(join(cwd, exitedRole + '-early-exit'), 'utf8')
            const code = /^(?:-?\d{1,10}|SIGNALLED)$/.test(value) ? value : 'UNKNOWN'
            const stderr = readFileSync(join(cwd, exitedRole + '-stderr'), 'utf8')
            const cause = stderr.match(/ERR_[A-Z0-9_]+|MODULE_NOT_FOUND|EACCES|ENOENT|EPERM|SyntaxError|ReferenceError|TypeError/)?.[0]
            assert.fail(`owned Windows ${mode} fixture ${exitedRole} exited before readiness (${code}, ${cause ?? 'no classified error'})`)
          }
          if (completed || Date.now() >= deadline) {
            const ready = roles.filter(role => existsSync(join(cwd, role)))
            const stderr = completed?.stderr ?? ''
            // Preserve known failure discriminants without retaining host paths,
            // environments, or arbitrary subprocess output in CI diagnostics.
            const failureCode = stderr.match(/Win32 (\d+)/)?.[0] ??
              stderr.match(/ERR_[A-Z0-9_]+|MODULE_NOT_FOUND|EACCES|ENOENT|EPERM/)?.[0] ??
              (/job (input|compilation|launch handshake|job ownership or settlement) failed/.exec(stderr)?.[1]) ??
              (completed?.error ? 'unclassified supervisor failure' : 'no classified failure')
            assert.fail(`owned Windows ${mode} process tree must start: ${JSON.stringify({
              ready, failureCode, fixtureReadinessFailed: existsSync(join(cwd, 'leader-readiness-failure')),
              status: completed?.status, started: completed?.processStarted,
              timedOut: completed?.timedOut, completed: Boolean(completed),
            })}`)
          }
          await delay(25)
        }
        const [leader, child, grandchild] = roles.map(role => Number(readFileSync(join(cwd, role), 'utf8')))
        for (const pid of [leader, child, grandchild]) assert.ok(Number.isSafeInteger(pid) && pid > 0)
        while (isProcessAlive(leader)) {
          assert.ok(!completed && Date.now() < deadline, 'owned leader must exit before Stop or deadline')
          await delay(25)
        }
        assert.equal(completed, undefined, 'a direct exit cannot settle a live job')
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
