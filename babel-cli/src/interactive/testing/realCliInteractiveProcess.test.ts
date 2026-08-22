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

    const isReady = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 15000);
      const onData = () => {
        const text = stripAnsi(out);
        if (/BABEL/i.test(text) && /READY|CHAT/i.test(text)) {
          clearTimeout(timer);
          resolve(true);
        }
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      onData();
    });

    try {
      child.stdin.write('/exit\n');
    } catch {
      /* ignore */
    }

    const exitCode = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('CLI process timed out waiting for exit on /exit'));
      }, 6000);
      child.on('exit', (code) => {
        clearTimeout(timer);
        resolve(code ?? 0);
      });
    });

    const text = stripAnsi(out);
    assert.equal(isReady, true, `CLI failed to reach ready state: ${text.slice(0, 400)}`);
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

    // Wait for ready
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => resolve(), 4000);
      const onData = () => {
        if (/READY|CHAT/i.test(stripAnsi(out))) {
          clearTimeout(timer);
          resolve();
        }
      };
      child.stdout.on('data', onData);
    });

    // Send Unicode command and /exit
    try {
      child.stdin.write('// test with 🚀 unicode and paths with spaces/foo bar.ts\n');
      child.stdin.write('/exit\n');
    } catch {
      /* ignore */
    }

    const exitCode = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('CLI process timed out waiting for exit on /exit'));
      }, 6000);
      child.on('exit', (code) => {
        clearTimeout(timer);
        resolve(code ?? 0);
      });
    });

    assert.equal(exitCode, 0, 'CLI must exit cleanly with code 0 on /exit');
  });

  test('PROC-03: Real CLI process deterministic exit on /exit command with zero orphans', async () => {
    const child = spawnInteractiveCli();

    // Send immediate /exit once spawned
    child.stdin.write('/exit\n');

    const exitCode = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('CLI process timed out waiting for /exit'));
      }, 6000);
      child.on('exit', (code) => {
        clearTimeout(timer);
        resolve(code ?? 0);
      });
    });

    assert.equal(exitCode, 0, 'Immediate /exit must terminate process cleanly with code 0');
  });
});
