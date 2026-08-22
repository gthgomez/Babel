/**
 * campaignExecutors.ts — ArmExecutor contract for causal-campaign live arms.
 *
 * Single seam between the SWE-Pro campaign live loop and whatever executes an
 * arm's agent: Babel's own CLI (chat-headless) or an external baseline CLI
 * (raw OpenCode). Executors own ONLY process launch/capture; workspace prep,
 * verifier overlays, fail-to-pass checks, and attempt lifecycle stay in the
 * campaign harness so every arm is measured identically.
 *
 * See docs/roadmaps/OX_ALPHA_EXPERIMENTAL_PROGRAM.md (W1).
 */

import type { CausalStage1Arm } from './causalCampaignContract.js';
import { runBabelCli } from './liteTrustDemo.js';

export const BABEL_CLI_CHAT_HEADLESS_EXECUTOR_ID = 'babel_cli_chat_headless' as const;
export const OPENCODE_CLI_RAW_EXECUTOR_ID = 'opencode_cli_raw' as const;

/** Everything an executor needs to launch one agent attempt. */
export interface ArmExecutionRequest {
  readonly arm: CausalStage1Arm;
  /** Prepared, isolated agent workspace (never the Babel repo itself). */
  readonly workspaceRoot: string;
  readonly prompt: string;
  /** Model id for the provider; null means executor/provider default. */
  readonly model: string | null;
  readonly provider: 'mock' | 'live';
  readonly env: Readonly<NodeJS.ProcessEnv>;
  readonly timeoutMs: number;
  /** Absolute path to the babel-cli entrypoint (babel arms only). */
  readonly cliEntry: string;
  /** Working directory for spawning the CLI process. */
  readonly spawnCwd: string;
}

export interface ArmExecutionResult {
  readonly executorId: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
  /** Process-launch failure (binary missing, spawn error) — null when launched. */
  readonly launchError: string | null;
}

export interface ExecutorReadiness {
  readonly ready: boolean;
  readonly reason?: string;
  readonly signature?: string;
  readonly missingCredentials?: readonly string[];
}

export interface ArmExecutor {
  readonly id: string;
  supports(arm: CausalStage1Arm): boolean;
  preflight?(request: ArmExecutionRequest): Promise<ExecutorReadiness> | ExecutorReadiness;
  execute(request: ArmExecutionRequest): Promise<ArmExecutionResult>;
}

/** Arms this program measures with Babel's own chat-headless CLI. */
const BABEL_ARMS: readonly CausalStage1Arm[] = [
  'babel_enforce',
  'babel_shadow',
  'babel_prompt_control',
];

export function isBabelCliArm(arm: CausalStage1Arm): boolean {
  return BABEL_ARMS.includes(arm);
}

/**
 * Babel-arm executor: same chat-headless invocation the campaign used before
 * the executor seam existed (arg order, env handling, and dist behavior are
 * preserved byte-for-byte so babel-arm measurements stay comparable).
 */
export function createBabelCliChatHeadlessArmExecutor(): ArmExecutor {
  const id = BABEL_CLI_CHAT_HEADLESS_EXECUTOR_ID;
  return {
    id,
    supports: isBabelCliArm,
    preflight(request) {
      if (!isBabelCliArm(request.arm)) {
        return {
          ready: false,
          reason: `executor does not support arm "${request.arm}"`,
          signature: 'infra:unsupported_arm',
        };
      }
      if (request.provider === 'live') {
        const hasKey = Boolean(
          request.env['DEEPSEEK_API_KEY']?.trim() ||
            request.env['DEEPINFRA_API_KEY']?.trim() ||
            request.env['OPENAI_API_KEY']?.trim() ||
            process.env['DEEPSEEK_API_KEY']?.trim() ||
            process.env['DEEPINFRA_API_KEY']?.trim() ||
            process.env['OPENAI_API_KEY']?.trim(),
        );
        if (!hasKey) {
          return {
            ready: false,
            reason: 'DEEPSEEK_API_KEY (or compatible) not set — refusing live cell',
            signature: 'infra:missing_api_key',
            missingCredentials: ['DEEPSEEK_API_KEY', 'DEEPINFRA_API_KEY', 'OPENAI_API_KEY'],
          };
        }
      }
      return { ready: true };
    },
    async execute(request) {
      if (!isBabelCliArm(request.arm)) {
        return unsupported(id, request.arm);
      }
      try {
        const cli = runBabelCli(
          [
            'run',
            '--mode',
            'chat-headless',
            ...(request.provider === 'live' && request.model
              ? (['--model', request.model] as const)
              : []),
            '--json',
            '--yes',
            '--project-root',
            request.workspaceRoot,
            request.prompt,
          ],
          {
            projectRoot: request.workspaceRoot,
            offlineDemo: request.provider !== 'live',
            cliEntry: request.cliEntry,
            cwd: request.spawnCwd,
            env: { ...request.env },
            timeoutMs: request.timeoutMs,
            ensureDist: false,
          },
        );
        return {
          executorId: id,
          exitCode: cli.exitCode,
          timedOut: cli.timedOut === true,
          stdout: cli.stdout ?? '',
          stderr: cli.stderr ?? '',
          launchError: null,
        };
      } catch (err) {
        return launchFailure(id, err);
      }
    },
  };
}

function unsupported(executorId: string, arm: CausalStage1Arm): ArmExecutionResult {
  return {
    executorId,
    exitCode: null,
    timedOut: false,
    stdout: '',
    stderr: '',
    launchError: `executor does not support arm "${arm}"`,
  };
}

function launchFailure(executorId: string, err: unknown): ArmExecutionResult {
  return {
    executorId,
    exitCode: null,
    timedOut: false,
    stdout: '',
    stderr: '',
    launchError: err instanceof Error ? err.message : String(err),
  };
}

/**
 * Default registry for the current Stage-1 arms. The OpenCode raw executor is
 * injected by the caller (campaign wiring) via `registerArmExecutor` so this
 * module stays free of child-process concerns for external CLIs.
 */
export function createArmRegistry(): {
  resolve(arm: CausalStage1Arm): ArmExecutor | null;
  register(executor: ArmExecutor): void;
} {
  const byArm = new Map<CausalStage1Arm, ArmExecutor>();
  return {
    resolve(arm) {
      return byArm.get(arm) ?? null;
    },
    register(executor) {
      for (const arm of BABEL_ARMS) {
        if (executor.supports(arm)) byArm.set(arm, executor);
      }
      if (executor.supports('raw_opencode')) byArm.set('raw_opencode', executor);
    },
  };
}
