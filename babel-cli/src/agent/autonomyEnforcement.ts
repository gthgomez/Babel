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
import { isBabelHeadlessEnv } from '../utils/envFlags.js';
import type { AutonomyClass } from '../config/autonomyPolicy.js';
import type { PermissionPreset } from './policy.js';

// ─── Credential-path protection (P0-C) ───────────────────────────────────────

/**
 * Normalize a path for credential matching (posix-style, lowercase).
 */
function normalizePathForCredentialMatch(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase();
}

/**
 * True when a path is a live credential store per rule 09. Synthetic-test
 * friendly: pure path inspection, never reads contents.
 *
 * Covers: .env / .env.* (excluding .env.example), private keys, certificate
 * stores, cloud credential stores, SSH keys, credential configs, secrets dirs.
 */
export function isCredentialTargetPath(path: string): boolean {
  const norm = normalizePathForCredentialMatch(path);
  const segments = norm.split('/');
  const basename = segments[segments.length - 1] ?? '';

  if (/^\.env(?:\.[a-z0-9_-]+)?$/.test(basename) && !basename.startsWith('.env.example')) {
    return true;
  }
  if (/^(id_rsa|id_ed25519|id_dsa|id_ecdsa)$/.test(basename)) return true;
  if (/\.(pem|p12|pfx|key)$/.test(basename)) return true;
  if (basename === 'credentials.json' || basename === '.git-credentials' || basename === '.npmrc') {
    return true;
  }
  if (segments.includes('.ssh')) return true;
  if (segments.includes('secrets')) return true;
  if (segments.includes('.aws') && basename === 'credentials') return true;
  return false;
}

// ─── Preset resolution (P0-A) ────────────────────────────────────────────────

/**
 * Resolve the permission preset for an execution profile + autonomy class.
 *
 * The class contract (autonomyPolicy.ts AUTONOMY_PROFILES):
 *   D → read_only (mutations deterministically denied)
 *   C → ask_before_mutation (mutations hit the approval boundary)
 *   A/B/unset → workspace_write (mutations auto-execute under verification)
 * Plan mode is always read_only (plan is a read-only surface).
 */
export function resolveAutonomyPreset(
  executionProfile: string | undefined,
  autonomyClass: AutonomyClass | null,
): PermissionPreset {
  if (executionProfile === 'plan') return 'read_only';
  if (autonomyClass === 'D') return 'read_only';
  if (autonomyClass === 'C') return 'ask_before_mutation';
  return 'workspace_write';
}

// ─── Benchmark-mode gate (P0-B) ──────────────────────────────────────────────

/**
 * True when BABEL_BENCHMARK_AUTO_APPROVE is honored.
 *
 * The env var alone must NOT weaken interactive authority (P0-B): it is valid
 * only inside an explicitly recognized benchmark/test execution mode —
 * headless/CI (where no human can approve anyway) or an explicit
 * BABEL_BENCHMARK_MODE=1 benchmark run. In an interactive TTY without
 * BABEL_BENCHMARK_MODE, setting the env var is a no-op (fail closed).
 */
export function benchmarkAutoApproveEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env['BABEL_BENCHMARK_AUTO_APPROVE'] !== '1') return false;
  return isBabelHeadlessEnv(env) || env['BABEL_BENCHMARK_MODE'] === '1';
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
