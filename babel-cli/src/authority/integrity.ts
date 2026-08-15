/**
 * integrity.ts — policy integrity (V2 authority).
 *
 * The agent must not be able to edit the policy that governs itself and then
 * benefit from the weakened rule (R8 C4, mission §22). Approach:
 *   - GOVERNANCE_PATHS: files whose mutation is governance-sensitive.
 *   - Any agent-side mutation of a governance path → DENY_POLICY_SELF_MUTATION.
 *   - Baseline manifest: SHA-256 of governance files captured at session start
 *     (or supplied via env); a drift check at decision time invalidates the
 *     lease (fail-closed).
 *
 * Note: governance edits performed by the LEASE-ISSUING process (the user /
 * operator session) are out of band — this module only stops the agent's own
 * tool surface from mutating its own policy.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, relative, normalize, sep } from 'node:path';

/** Repo-relative governance-sensitive paths (globs not supported — exact + dir prefixes). */
export const GOVERNANCE_PATHS: readonly string[] = [
  'babel-cli/src/authority',
  'babel-cli/src/config/autonomyPolicy.ts',
  'babel-cli/src/config/autonomyPolicy.test.ts',
  'babel-cli/src/agent/policy.ts',
  'babel-cli/src/agent/toolExecutor.ts',
  'babel-cli/src/agent/completionGatePolicy.ts',
  '.claude/settings.json',
  '.claude/settings.local.json',
  '.claude/hooks',
  '.agents/rules',
  'AGENTS.md',
  'CLAUDE.md',
  'GEMINI.md',
  '.gitignore',
  '.gitattributes',
  '.github/workflows',
];

const normalizedGovernance = GOVERNANCE_PATHS.map((p) => normalize(p).replace(/\\/g, '/'));

/** Is this repo-relative path governance-sensitive? */
export function isGovernancePath(repoRelativePath: string): boolean {
  const norm = normalize(repoRelativePath).replace(/\\/g, '/');
  return normalizedGovernance.some((g) => {
    if (g.endsWith('/')) return norm.startsWith(g) || norm === g.slice(0, -1);
    return norm === g || norm.startsWith(`${g}/`);
  });
}

export interface BaselineManifest {
  /** path → sha256 hex */
  entries: Record<string, string>;
  /** captured when */
  capturedAt: string;
}

export function hashFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * Build a baseline manifest for governance paths under a repo root.
 * Missing files are recorded with the sentinel '<missing>'.
 */
export function buildBaseline(repoRoot: string): BaselineManifest {
  const entries: Record<string, string> = {};
  for (const g of GOVERNANCE_PATHS) {
    const abs = join(repoRoot, g);
    try {
      entries[g] = hashFile(abs);
    } catch {
      entries[g] = '<missing>';
    }
  }
  return { entries, capturedAt: new Date().toISOString() };
}

export interface BaselineCheckResult {
  ok: boolean;
  changed: string[];
}

/** Compare current governance-file hashes against the manifest. */
export function checkBaseline(repoRoot: string, manifest: BaselineManifest): BaselineCheckResult {
  const changed: string[] = [];
  for (const [g, expected] of Object.entries(manifest.entries)) {
    const abs = join(repoRoot, g);
    let actual: string;
    try {
      actual = hashFile(abs);
    } catch {
      actual = '<missing>';
    }
    if (actual !== expected) changed.push(g);
  }
  return { ok: changed.length === 0, changed };
}

/** Path normalization helper used by callers for agent tool paths. */
export function repoRelativeFromCwd(cwd: string, repoRoot: string, path: string): string {
  const rel = relative(repoRoot, path).split(sep).join('/');
  return rel.startsWith('..') ? path : rel;
}
