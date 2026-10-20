import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

import type { SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';

export type SpawnExitRecord =
  | { state: 'exited'; code: number | null; signal: NodeJS.Signals | null }
  | { state: 'timeout' }
  | { state: 'missing' };

export interface ClaudeSpawnExitFence {
  readonly sessionKey: string;
  waitForExit(timeoutMs: number): Promise<SpawnExitRecord>;
}

function childToSpawnedProcess(child: ChildProcess): SpawnedProcess {
  return {
    stdin: child.stdin as Writable,
    stdout: child.stdout as Readable,
    killed: child.killed,
    exitCode: child.exitCode,
    signalCode: child.signalCode,
    kill: (signal) => child.kill(signal),
    on: (event, listener) => {
      if (event === 'exit') child.on('exit', listener);
      else child.on('error', listener as (error: Error) => void);
    },
    once: (event, listener) => {
      if (event === 'exit') child.once('exit', listener);
      else child.once('error', listener as (error: Error) => void);
    },
    off: (event, listener) => {
      if (event === 'exit') child.off('exit', listener);
      else child.off('error', listener as (error: Error) => void);
    },
  };
}

/**
 * Documented SDK spawn hook: track real child exit for teardown fencing.
 * A wait timeout quarantines (returns timeout) — it does not synthesize exit.
 */
export function createClaudeCodeSpawnFenceFactory(
  fences: Map<string, ClaudeSpawnExitFence>,
): (sessionKey: string) => (options: SpawnOptions) => SpawnedProcess {
  return (sessionKey) => (options) => {
    const child = nodeSpawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env as NodeJS.ProcessEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      signal: options.signal,
      windowsHide: true,
    });

    let settled = false;
    let exitRecord: SpawnExitRecord = { state: 'missing' };
    const exitPromise = new Promise<SpawnExitRecord>((resolve) => {
      const finish = (record: SpawnExitRecord) => {
        if (settled) return;
        settled = true;
        exitRecord = record;
        resolve(record);
      };
      child.once('exit', (code, signal) => {
        finish({ state: 'exited', code, signal });
      });
      child.once('error', () => {
        finish({ state: 'exited', code: child.exitCode, signal: child.signalCode });
      });
      options.signal.addEventListener(
        'abort',
        () => {
          if (!settled && child.exitCode === null && !child.killed) {
            // Exit event still authoritative; abort only requests shutdown.
          }
        },
        { once: true },
      );
    });

    fences.set(sessionKey, {
      sessionKey,
      waitForExit: async (timeoutMs) => {
        if (settled) return exitRecord;
        const raced = await Promise.race([
          exitPromise,
          new Promise<SpawnExitRecord>((resolve) =>
            setTimeout(() => resolve({ state: 'timeout' }), timeoutMs),
          ),
        ]);
        return raced;
      },
    });

    return childToSpawnedProcess(child);
  };
}
