import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { it } from 'node:test'

it('stops the real auto-spawned daemon when the REPL exits', { timeout: 20000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-repl-exit-'))
  let pid: number | undefined
  try {
    const script = `
      const { pingDaemon } = await import('./src/daemon/client.ts');
      const { exitRepl } = await import('./src/interactive/repl/replLifecycle.ts');
      const { warmReplRuntime } = await import('./src/interactive/replWarmup.ts');
      warmReplRuntime();
      const deadline = Date.now() + 10000;
      while (true) {
        try { await pingDaemon(); break; } catch (err) {
          if (Date.now() > deadline) throw err;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
      console.log('OWNED_PID=' + (await pingDaemon()).pid);
      exitRepl();
    `
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: root, USERPROFILE: root, TMPDIR: root, TMP: root,
      BABEL_RUNS_DIR: join(root, 'runs'), NODE_ENV: 'production', BABEL_DAEMON_WARM: '1' }
    delete env.BABEL_TEST
    const { stdout } = await promisify(execFile)(process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', script], { env, timeout: 15000 })
    pid = Number(stdout.match(/Auto-spawned daemon ready\. PID: (\d+)/)?.[1])
    assert.ok(pid > 0, stdout)
    assert.match(stdout, /Babel session ended/)
    assert.throws(() => process.kill(pid!, 0), /ESRCH/)
  } finally {
    if (pid) { try { process.kill(pid, 'SIGTERM') } catch {} }
    rmSync(root, { recursive: true, force: true })
  }
})
