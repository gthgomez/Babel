/**
 * Clean-room IndependentVerifier — tree-copy + re-run outside the primary workspace.
 *
 * Default: **off** the Chat hot path (safe_repo / host-local profiles).
 * Enable via:
 * - BABEL_INDEPENDENT_VERIFIER=1 (env always wins when set), or
 * - high-assurance execution profiles with independentVerifierDefault: true
 *   (benchmark_container, babel_research, opencalw_manager) when env is unset.
 * Env explicit OFF (0/false/no/off) disables even for high-assurance profiles.
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  parseStructuredVerifierCommand,
  isAuthoritativeVerifierCommand,
} from '../agent/completionGatePolicy.js';
import {
  resolveExecutionProfile,
  type ExecutionProfile,
  type ExecutionProfileName,
} from '../config/executionProfiles.js';
import { RevisionManager, type RevisionBoundReceipt } from './revisionBoundReceipt.js';

/** Env flag for Chat/finalize clean-room verification (default off unless profile opts in). */
export const INDEPENDENT_VERIFIER_ENV = 'BABEL_INDEPENDENT_VERIFIER' as const;

/** Profile input accepted by IndependentVerifier opt-in resolution. */
export type IndependentVerifierProfileRef =
  | ExecutionProfile
  | ExecutionProfileName
  | string
  | null
  | undefined;

function isExecutionProfileObject(
  profile: IndependentVerifierProfileRef,
): profile is ExecutionProfile {
  return (
    profile != null &&
    typeof profile === 'object' &&
    typeof (profile as ExecutionProfile).name === 'string'
  );
}

/**
 * Resolve the profile used for IndependentVerifier defaults.
 * Explicit profile object/name wins; otherwise BABEL_EXECUTION_PROFILE from env.
 */
function resolveProfileForIndependentVerifier(
  env: NodeJS.ProcessEnv,
  profile?: IndependentVerifierProfileRef,
): ExecutionProfile {
  if (isExecutionProfileObject(profile)) {
    return profile;
  }
  if (typeof profile === 'string' && profile.trim().length > 0) {
    return resolveExecutionProfile(profile);
  }
  return resolveExecutionProfile(env['BABEL_EXECUTION_PROFILE']);
}

/**
 * True when clean-room IndependentVerifier should run.
 * Pure; no I/O.
 *
 * Resolution order:
 * 1. Env explicit OFF (`0`/`false`/`no`/`off`) → false always
 * 2. Env explicit ON (`1`/`true`/`yes`/`on`) → true always
 * 3. Else if profile (arg or BABEL_EXECUTION_PROFILE) has independentVerifierDefault → true
 * 4. Default false
 */
export function isIndependentVerifierOptIn(
  env: NodeJS.ProcessEnv = process.env,
  profile?: IndependentVerifierProfileRef,
): boolean {
  const raw = env[INDEPENDENT_VERIFIER_ENV];
  if (raw != null && String(raw).trim() !== '') {
    const v = String(raw).trim().toLowerCase();
    if (v === '0' || v === 'false' || v === 'no' || v === 'off') {
      return false;
    }
    if (v === '1' || v === 'true' || v === 'yes' || v === 'on') {
      return true;
    }
    // Unknown env tokens fall through to profile default.
  }

  const resolved = resolveProfileForIndependentVerifier(env, profile);
  return resolved.independentVerifierDefault === true;
}

function shouldCopyPath(src: string): boolean {
  const normalized = src.replace(/\\/g, '/').toLowerCase();
  const base = path.basename(normalized);
  return (
    !normalized.includes('/node_modules/') &&
    !normalized.includes('/.git/') &&
    !base.startsWith('.env') &&
    !base.endsWith('.pem') &&
    !base.endsWith('.key')
  );
}

function runVerifierInCopy(
  tempDir: string,
  command: string,
): { exitCode: number; authority: boolean } {
  const structured = parseStructuredVerifierCommand(command);
  const authority = isAuthoritativeVerifierCommand(command);
  if (!structured) {
    return { exitCode: 126, authority };
  }
  try {
    execFileSync(structured.executable, structured.args, {
      cwd: tempDir,
      stdio: 'ignore',
      timeout: 120_000,
      windowsHide: true,
    });
    return { exitCode: 0, authority };
  } catch (err: unknown) {
    const status =
      err && typeof err === 'object' && 'status' in err
        ? Number((err as { status?: number }).status)
        : 1;
    return { exitCode: Number.isFinite(status) && status !== 0 ? status : 1, authority };
  }
}

export class IndependentVerifier {
  /**
   * Async clean-room verify. Prefer {@link isIndependentVerifierOptIn} before calling
   * from product paths so the default hot path never pays tree-copy cost.
   */
  static async runIsolatedVerification(
    projectRoot: string,
    command: string,
    touchedFiles: string[],
  ): Promise<RevisionBoundReceipt> {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'babel-verify-'));

    try {
      await fsp.cp(projectRoot, tempDir, {
        recursive: true,
        filter: (src) => shouldCopyPath(src),
      });

      const boundRevision = await RevisionManager.computeRevision(projectRoot, touchedFiles);
      const { exitCode, authority } = runVerifierInCopy(tempDir, command);

      return {
        receiptId: `receipt-${Date.now()}`,
        command,
        exitCode,
        boundRevision,
        stale: false,
        authority,
        authoritySource: 'unknown',
      };
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * Sync clean-room verify for Chat finalize (streamDone/buildResult are sync).
   * Only call when {@link isIndependentVerifierOptIn} is true.
   */
  static runIsolatedVerificationSync(
    projectRoot: string,
    command: string,
    touchedFiles: string[],
  ): RevisionBoundReceipt {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'babel-verify-'));

    try {
      fs.cpSync(projectRoot, tempDir, {
        recursive: true,
        filter: (src) => shouldCopyPath(src),
      });

      const boundRevision = RevisionManager.computeRevisionSync(projectRoot, touchedFiles);
      const { exitCode, authority } = runVerifierInCopy(tempDir, command);

      return {
        receiptId: `receipt-${Date.now()}`,
        command,
        exitCode,
        boundRevision,
        stale: false,
        authority,
        authoritySource: 'unknown',
      };
    } finally {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  }
}

/**
 * When opt-in is enabled and a green primary receipt exists, re-run the verifier
 * in a clean-room copy. Returns proof errors (empty when disabled or pass).
 * Pure policy gate + optional I/O only when enabled.
 */
export function independentVerifierProofErrors(input: {
  projectRoot: string;
  command: string;
  exitCode: number;
  mutationPaths: readonly string[];
  env?: NodeJS.ProcessEnv;
  /**
   * Optional execution profile (object, name, or string). When omitted, opt-in
   * resolution uses BABEL_EXECUTION_PROFILE from env (see isIndependentVerifierOptIn).
   */
  profile?: IndependentVerifierProfileRef;
}): string[] {
  const env = input.env ?? process.env;
  if (!isIndependentVerifierOptIn(env, input.profile)) {
    return [];
  }
  if (input.exitCode !== 0) {
    return ['independent clean-room verifier skipped: primary receipt not green'];
  }
  try {
    const independent = IndependentVerifier.runIsolatedVerificationSync(
      input.projectRoot,
      input.command,
      [...input.mutationPaths],
    );
    if (independent.exitCode !== 0) {
      return [
        `independent clean-room verifier failed (exit ${independent.exitCode})`,
      ];
    }
    return [];
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return [`independent clean-room verifier unavailable: ${message}`];
  }
}
