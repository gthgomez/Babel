/**
 * campaignExecutors.opencode.ts — raw OpenCode CLI arm executor (W1).
 *
 * The `raw_opencode` arm is the external baseline for paired capability-
 * transfer measurement: the OpenCode CLI runs UNMEDIATED by design — this
 * executor only launches `opencode run --model <id> <prompt>` inside the
 * prepared workspace and captures stdout/stderr/exit/timeouts. Workspace
 * isolation, verifier overlays, fail-to-pass checks, readiness receipts, and
 * attempt lifecycle remain harness-side (swebenchProCampaign.ts) so every arm
 * is measured identically.
 *
 * Honesty rules: mock provider never fabricates a baseline result; a missing
 * OPENCODE_API_KEY refuses to launch; the key value itself is never copied
 * into any result field.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

import {
  OPENCODE_CLI_RAW_EXECUTOR_ID,
  type ArmExecutionRequest,
  type ArmExecutionResult,
  type ArmExecutor,
} from './campaignExecutors.js';
import type { CausalStage1Arm } from './causalCampaignContract.js';

/** Default model when the request carries none (program roadmap default). */
export const DEFAULT_OPENCODE_MODEL = 'x-preview-f-free';

/** Grace between SIGTERM and SIGKILL escalation after the timeout fires. */
const KILL_ESCALATION_MS = 5000;

function resultWith(
  executorId: string,
  partial: Pick<ArmExecutionResult, 'exitCode' | 'timedOut' | 'launchError'> & {
    stdout?: string;
    stderr?: string;
  },
): ArmExecutionResult {
  return {
    executorId,
    exitCode: partial.exitCode,
    timedOut: partial.timedOut,
    stdout: partial.stdout ?? '',
    stderr: partial.stderr ?? '',
    launchError: partial.launchError,
  };
}

/**
 * Raw-arm executor over the external OpenCode CLI. Deterministic and offline
 * testable: inject `spawnImpl` to fake the child process.
 */
export function createOpenCodeCliArmExecutor(options?: {
  binaryPath?: string;
  spawnImpl?: typeof import('node:child_process').spawn;
}): ArmExecutor {
  const id = OPENCODE_CLI_RAW_EXECUTOR_ID;
  const spawnImpl = options?.spawnImpl ?? nodeSpawn;
  const supports = (arm: CausalStage1Arm): boolean => arm === 'raw_opencode';
  return {
    id,
    supports,
    async execute(request: ArmExecutionRequest): Promise<ArmExecutionResult> {
      if (!supports(request.arm)) {
        return resultWith(id, {
          exitCode: null,
          timedOut: false,
          launchError: `executor does not support arm "${request.arm}"`,
        });
      }
      if (request.provider !== 'live') {
        // No synthetic baseline: a mock run of the raw arm produces nothing.
        return resultWith(id, {
          exitCode: null,
          timedOut: false,
          launchError: 'raw_opencode requires live provider (mock produces no genuine baseline)',
        });
      }
      const apiKey = request.env['OPENCODE_API_KEY']?.trim() ?? '';
      if (!apiKey) {
        return resultWith(id, {
          exitCode: null,
          timedOut: false,
          launchError:
            'OPENCODE_API_KEY missing or empty — refusing raw_opencode launch (key value is never logged)',
        });
      }
      const model = request.model ?? DEFAULT_OPENCODE_MODEL;

      let child: ChildProcess;
      try {
        child = spawnImpl(
          options?.binaryPath ?? 'opencode',
          ['run', '--model', model, request.prompt],
          {
            cwd: request.workspaceRoot,
            env: { ...process.env, ...request.env },
            windowsHide: true,
          },
        );
      } catch (err) {
        return resultWith(id, {
          exitCode: null,
          timedOut: false,
          launchError: err instanceof Error ? err.message : String(err),
        });
      }

      return new Promise<ArmExecutionResult>((resolveRun) => {
        let stdout = '';
        let stderr = '';
        let settled = false;
        let timedOut = false;
        let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
        let escalationTimer: ReturnType<typeof setTimeout> | null = null;

        const finish = (r: ArmExecutionResult) => {
          if (settled) return;
          settled = true;
          if (timeoutTimer) clearTimeout(timeoutTimer);
          if (escalationTimer) clearTimeout(escalationTimer);
          resolveRun(r);
        };

        child.stdout?.on('data', (chunk: string | Buffer) => {
          stdout += typeof chunk === 'string' ? chunk : String(chunk);
        });
        child.stderr?.on('data', (chunk: string | Buffer) => {
          stderr += typeof chunk === 'string' ? chunk : String(chunk);
        });

        // Spawn failure (ENOENT, permissions). Node may still emit 'close'
        // afterwards; the settled guard keeps the first outcome authoritative.
        child.on('error', (err: Error) => {
          finish(
            resultWith(id, {
              exitCode: null,
              timedOut,
              launchError: err.message,
              stdout,
              stderr,
            }),
          );
        });

        child.on('close', (code: number | null) => {
          finish(
            resultWith(id, {
              // Timeout policy wins: no half-truth exit code after enforcement.
              exitCode: timedOut ? null : code,
              timedOut,
              launchError: null,
              stdout,
              stderr,
            }),
          );
        });

        if (request.timeoutMs > 0) {
          timeoutTimer = setTimeout(() => {
            timedOut = true;
            try {
              child.kill();
            } catch {
              /* already dead */
            }
            escalationTimer = setTimeout(() => {
              const alive = child.exitCode == null && child.signalCode == null && !settled;
              if (!alive) return;
              try {
                child.kill('SIGKILL');
              } catch {
                /* ignore */
              }
            }, KILL_ESCALATION_MS);
            escalationTimer.unref?.();
          }, request.timeoutMs);
          timeoutTimer.unref?.();
        }
      });
    },
  };
}
