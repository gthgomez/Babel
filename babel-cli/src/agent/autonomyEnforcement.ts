/**
 * autonomyEnforcement.ts — live enforcement helpers for the autonomy policy (P0-A/B/C).
 *
 * Bridges the canonical Class A–D taxonomy (config/autonomyPolicy.ts) and the
 * command-semantic layer (agent/commandSemantics.ts) into the runtime tool
 * dispatch boundary (toolExecutor.executeActionWithPolicy) and the chat engine's
 * permission-preset selection.
 *
 * Pure module: no V9-lane imports, no I/O.
 */

import type { AgentAction } from './actions.js';
import type { AutonomyClass } from '../config/autonomyPolicy.js';
import type { PermissionPreset } from './policy.js';

export { isCredentialTargetPath } from '../authority/protectedPath.js';

// ─── Preset resolution (P0-A) ────────────────────────────────────────────────

/**
 * Resolve the permission preset for an execution profile + autonomy class.
 *
 * The class contract (autonomyPolicy.ts AUTONOMY_PROFILES):
 *   D → read_only (mutations deterministically denied)
 *   C → workspace_write (privileged ops still require lease membership)
 *   A/B/unset → workspace_write (mutations auto-execute under verification)
 * Plan mode is always read_only (plan is a read-only surface).
 */
export function resolveAutonomyPreset(
  executionProfile: string | undefined,
  autonomyClass: AutonomyClass | null,
): PermissionPreset {
  if (executionProfile === 'plan') return 'read_only';
  if (autonomyClass === 'D') return 'read_only';
  return 'workspace_write';
}

// ─── Benchmark-mode gate (P0-4) ──────────────────────────────────────────────

/**
 * True when BABEL_BENCHMARK_AUTO_APPROVE is honored (P0-4 contract).
 *
 * Benchmark auto-approve is valid ONLY when both BABEL_BENCHMARK_AUTO_APPROVE=1
 * AND BABEL_BENCHMARK_MODE=1 are set. Headless/CI NEVER establishes benchmark
 * authority, and an interactive TTY without BABEL_BENCHMARK_MODE fails closed —
 * the env var alone must not weaken interactive authority.
 */
export function benchmarkAutoApproveEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env['BABEL_BENCHMARK_AUTO_APPROVE'] !== '1') return false;
  return env['BABEL_BENCHMARK_MODE'] === '1';
}

export type ClassCGateResolution = 'allow' | 'ask' | 'deny' | 'authority';

/**
 * Privileged-mutation resolution. TTY/CI/headless are not authority.
 * Interactive and headless callers receive the same decision.
 *
 * `allow` is only the explicit benchmark pair. Everything else defers to
 * the lease/PDP (`authority`) except plan mode (`deny`).
 */
export function resolveClassCGateDecision(input: {
  executionProfile: string;
  env?: NodeJS.ProcessEnv;
  /** @deprecated TTY is presentation context, not authority. Ignored. */
  isTTY?: boolean;
}): ClassCGateResolution {
  if (input.executionProfile === 'plan') return 'deny';
  const env = input.env ?? process.env;
  if (benchmarkAutoApproveEnabled(env)) return 'allow';
  return 'authority';
}

// ─── Command text extraction ─────────────────────────────────────────────────

/**
 * Extract shell command text from an agent action for command-semantic
 * classification. Returns null for non-command actions.
 */
export function commandTextForAction(action: AgentAction): string | null {
  if (action.type === 'run_command' || action.type === 'test_run') {
    return action.command;
  }
  return null;
}
