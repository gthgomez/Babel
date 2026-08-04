/**
 * Clean-room IndependentVerifier — tree-copy + re-run outside the primary workspace.
 *
 * Default: **off** the Chat hot path. Enable with BABEL_INDEPENDENT_VERIFIER=1.
 * When disabled, callers must not run isolated verification (no temp copy cost).
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
import { RevisionManager, type RevisionBoundReceipt } from './revisionBoundReceipt.js';

/** Env flag for Chat/finalize clean-room verification (default off). */
export const INDEPENDENT_VERIFIER_ENV = 'BABEL_INDEPENDENT_VERIFIER' as const;

/**
 * True when operators explicitly opt into clean-room IndependentVerifier.
 * Pure; no I/O. Default false.
 */
export function isIndependentVerifierOptIn(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env[INDEPENDENT_VERIFIER_ENV];
  if (raw == null) return false;
  const v = String(raw).trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
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
}): string[] {
  if (!isIndependentVerifierOptIn(input.env ?? process.env)) {
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
