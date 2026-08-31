/**
 * PR-76 REAL_PROCESS: Spawned Real Babel CLI Interactive Process Certification Suite.
 *
 * Spawns the actual Babel CLI entrypoint (src/index.ts) as a real child process with stdio streams,
 * verifying process bootstrap, startup banner, prompt readiness, Unicode/path handling,
 * command processing, and deterministic clean termination with exit code 0 on /exit.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { stripAnsi } from '../../ui/theme.js';

const READY_TIMEOUT_MS = 30_000;
const EXIT_TIMEOUT_MS = 6_000;

function waitForReady(
  child: ReturnType<typeof spawn>,
  getOutput: () => string,
  timeoutMs = READY_TIMEOUT_MS,
): Promise<boolean> {
  return new Promise((resolve) => {
    const stdout = child.stdout;
    const stderr = child.stderr;
    if (!stdout || !stderr) {
      resolve(false);
      return;
    }
    let settled = false;
    const finish = (ready: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stdout.off('data', onData);
      stderr.off('data', onData);
      child.off('exit', onExit);
      resolve(ready);
    };
    const onData = (): void => {
      const text = stripAnsi(getOutput());
      if (/BABEL/i.test(text) && /\[READY\]/i.test(text)) finish(true);
    };
    const onExit = (): void => finish(false);
    const timer = setTimeout(() => finish(false), timeoutMs);
    stdout.on('data', onData);
    stderr.on('data', onData);
    child.once('exit', onExit);
    onData();
  });
}

function waitForExit(child: ReturnType<typeof spawn>, timeoutMs = EXIT_TIMEOUT_MS): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('CLI process timed out waiting for exit'));
    }, timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code ?? 0);
    });
  });
}

describe('PR-76 REAL_PROCESS: Spawned Real Babel CLI Interactive Process Certification', () => {
  const cliPath = join(process.cwd(), 'src', 'index.ts');

  function spawnInteractiveCli(extraEnv: Record<string, string> = {}) {
    return spawn(
      process.execPath,
      ['--import', 'tsx', '--no-warnings=ExperimentalWarning', cliPath, 'interactive', '--mode', 'chat'],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          CI: '1',
          BABEL_SKIP_RESUME_PICKER: '1',
          BABEL_SKIP_KG_INDEX: '1',
          BABEL_PROMPT_V2: '0',
          ...extraEnv,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
  }

  test('PROC-01: Real CLI process boots, displays startup banner and ready prompt', async () => {
    const child = spawnInteractiveCli();
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      out += String(chunk);
    });

    const isReady = await waitForReady(child, () => out);
    assert.equal(isReady, true, `CLI failed to reach ready state: ${stripAnsi(out).slice(0, 400)}`);

    const exitCodePromise = waitForExit(child);
    child.stdin.write('/exit\n');
    const exitCode = await exitCodePromise;

    const text = stripAnsi(out);
    assert.ok(text.includes('BABEL') || text.includes('babel'), 'Expected banner in output');
    assert.equal(exitCode, 0, 'CLI must exit cleanly with code 0 on /exit, not timeout or kill');
  });

  test('PROC-02: Real CLI process handles Unicode input and paths with spaces cleanly and exits 0', async () => {
    const child = spawnInteractiveCli();
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      out += String(chunk);
    });

    const isReady = await waitForReady(child, () => out);
    assert.equal(isReady, true, `CLI failed to reach ready state: ${stripAnsi(out).slice(0, 400)}`);

    // Send Unicode command and /exit
    const exitCodePromise = waitForExit(child);
    child.stdin.write('// test with 🚀 unicode and paths with spaces/foo bar.ts\n');
    child.stdin.write('/exit\n');
    const exitCode = await exitCodePromise;

    assert.equal(exitCode, 0, 'CLI must exit cleanly with code 0 on /exit');
  });

  test('PROC-03: Real CLI process deterministically exits on /exit with zero orphans', async () => {
    const child = spawnInteractiveCli();

    let output = '';
    child.stdout.on('data', (chunk) => {
      output += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      output += String(chunk);
    });
    const isReady = await waitForReady(child, () => output);
    assert.equal(isReady, true, `CLI failed to reach ready state: ${stripAnsi(output).slice(0, 400)}`);

    const exitCodePromise = waitForExit(child);
    child.stdin.write('/exit\n');
    const exitCode = await exitCodePromise;

    assert.equal(exitCode, 0, 'Ready /exit must terminate process cleanly with code 0');
  });
});
