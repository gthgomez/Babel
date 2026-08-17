/**
 * integrity.ts — policy integrity (V2 authority, MERGE_AND_FIX_P0).
 *
 * The agent must not be able to edit the policy that governs itself and then
 * benefit from the weakened rule (R8 C4, mission §22). Approach:
 *   - GOVERNANCE_PATHS: files, symlinks, and directories whose mutation is
 *     governance-sensitive.
 *   - Any agent-side mutation of a governance path → DENY_POLICY_SELF_MUTATION
 *     (apply_patch included — targets are extracted via the shared
 *     patchTargets utility, never the raw diff body).
 *   - Canonical baseline manifest: deterministic, type-aware entries
 *     (file content hash / symlink target / directory presence) captured ONCE
 *     at a trusted lifecycle boundary before agent mutation begins, then
 *     treated as immutable — never lazily recaptured after drift.
 *   - Drift is evaluated before privileged decisions; once detected the
 *     active lease is PERMANENTLY invalidated (DENY_POLICY_INTEGRITY_DRIFT),
 *     not merely denied for the one call.
 *
 * Symlink safety: directories are walked with lstat; symlinks are recorded
 * as entries (readlink target) and NEVER followed — the checker cannot be
 * used as a filesystem traversal vector outside the repository.
 *
 * Note: governance edits performed by the LEASE-ISSUING process (the user /
 * operator session) are out of band — this module only stops the agent's own
 * tool surface from mutating its own policy.
 */

import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { isAbsolute, join, relative, normalize, sep } from 'node:path';

/** Repo-relative governance-sensitive paths (globs not supported — exact + dir prefixes). */
export const GOVERNANCE_PATHS: readonly string[] = [
  'babel-cli/src/authority',
  'babel-cli/src/config/autonomyPolicy.ts',
  'babel-cli/src/config/autonomyPolicy.test.ts',
  'babel-cli/src/agent/policy.ts',
  'babel-cli/src/agent/toolExecutor.ts',
  'babel-cli/src/agent/governedMutations.ts',
  'babel-cli/src/agent/completionGatePolicy.ts',
  'babel-cli/src/agent/autonomyEnforcement.ts',
  'babel-cli/src/agent/chatApproval.ts',
  'babel-cli/src/agent/chatEngine.ts',
  'babel-cli/src/agent/chatEngineLiveSession.ts',
  'babel-cli/src/agent/chatEngineParityBridge.ts',
  'babel-cli/src/agent/approvalOperation.ts',
  'babel-cli/src/agent/approvalRequests.ts',
  'babel-cli/src/utils/envFlags.ts',
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
  if (isAuthorityStatePath(norm)) return true;
  return normalizedGovernance.some((g) => {
    if (g.endsWith('/')) return norm.startsWith(g) || norm === g.slice(0, -1);
    return norm === g || norm.startsWith(`${g}/`);
  });
}

/**
 * Persisted authority-session state is trusted security state, not ordinary
 * JSON the agent may rewrite. Match the filename anywhere and the canonical
 * chat-session persist prefix.
 */
export function isAuthorityStatePath(repoRelativePath: string): boolean {
  const norm = normalize(repoRelativePath).replace(/\\/g, '/');
  const base = norm.split('/').pop() ?? '';
  return base === 'authority-session.json' || norm.includes('/authority-session.json');
}

// ─── Canonical manifest ─────────────────────────────────────────────────────

export type ManifestEntryKind = 'file' | 'symlink' | 'dir' | 'missing';

export interface ManifestEntry {
  /** Repo-relative path (forward slashes). */
  path: string;
  kind: ManifestEntryKind;
  /** sha256 hex of content (file) · readlink target (symlink) · 'dir' · 'missing'. */
  value: string;
}

export interface BaselineManifest {
  schemaVersion: 1;
  /** Deterministically sorted (path ascending). */
  entries: ManifestEntry[];
  /** Captured when. */
  capturedAt: string;
}

export function hashFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * Build the canonical baseline manifest for governance paths under a repo
 * root. Deterministic: children are walked in sorted order and the final
 * entry list is sorted by path. Symlinks are recorded (target) and never
 * followed; missing governance paths are recorded as 'missing' so later
 * creation is detected. Non-file/dir/symlink entries (sockets, FIFOs) are
 * skipped — they are not hashed (readFileSync on a FIFO can block).
 */
export function buildBaseline(repoRoot: string): BaselineManifest {
  const entries: ManifestEntry[] = [];
  const seen = new Set<string>();

  const addEntry = (path: string, kind: ManifestEntryKind, value: string) => {
    const rel = normalize(path).replace(/\\/g, '/').replace(/^\.\//, '');
    if (seen.has(rel)) return;
    seen.add(rel);
    entries.push({ path: rel, kind, value });
  };

  const walkDir = (rel: string) => {
    const abs = join(repoRoot, rel);
    let dirents;
    try {
      dirents = readdirSync(abs, { withFileTypes: true });
    } catch {
      return; // vanished mid-walk — checkBaseline will report the change
    }
    dirents.sort((a, b) => a.name.localeCompare(b.name));
    for (const d of dirents) {
      const childRel = rel === '' ? d.name : `${rel}/${d.name}`;
      const childAbs = join(abs, d.name);
      if (d.isSymbolicLink()) {
        let target = '<unreadable>';
        try {
          target = readlinkSync(childAbs);
        } catch {
          /* recorded as unreadable — the link itself is the entry */
        }
        addEntry(childRel, 'symlink', target);
        // NEVER follow — traversal hazard outside the repository.
      } else if (d.isDirectory()) {
        addEntry(childRel, 'dir', 'dir');
        walkDir(childRel);
      } else if (d.isFile()) {
        try {
          addEntry(childRel, 'file', hashFile(childAbs));
        } catch {
          addEntry(childRel, 'file', '<unreadable>');
        }
      }
      // sockets/FIFOs/other: skipped (see header).
    }
  };

  for (const g of GOVERNANCE_PATHS) {
    const abs = join(repoRoot, g);
    let st;
    try {
      st = lstatSync(abs);
    } catch {
      addEntry(g, 'missing', 'missing');
      continue;
    }
    if (st.isSymbolicLink()) {
      let target = '<unreadable>';
      try {
        target = readlinkSync(abs);
      } catch {
        /* recorded as unreadable */
      }
      addEntry(g, 'symlink', target);
    } else if (st.isDirectory()) {
      addEntry(g, 'dir', 'dir');
      walkDir(g);
    } else if (st.isFile()) {
      try {
        addEntry(g, 'file', hashFile(abs));
      } catch {
        addEntry(g, 'file', '<unreadable>');
      }
    }
  }

  entries.sort((a, b) => a.path.localeCompare(b.path));
  return { schemaVersion: 1, entries, capturedAt: new Date().toISOString() };
}

export interface BaselineCheckResult {
  ok: boolean;
  /** Repo-relative paths that changed (added, removed, kind/value altered), sorted. */
  changed: string[];
  /** The freshly built current manifest (for diagnostics). */
  current: BaselineManifest;
}

/** Compare current governance state against the (immutable) baseline manifest. */
export function checkBaseline(repoRoot: string, manifest: BaselineManifest): BaselineCheckResult {
  const current = buildBaseline(repoRoot);
  const expected = new Map(manifest.entries.map((e) => [e.path, e]));
  const seen = new Set<string>();
  const changed = new Set<string>();

  for (const e of current.entries) {
    seen.add(e.path);
    const exp = expected.get(e.path);
    if (!exp || exp.kind !== e.kind || exp.value !== e.value) {
      changed.add(e.path);
    }
  }
  // Entries in the baseline but absent from the current state (deleted).
  for (const exp of manifest.entries) {
    if (!seen.has(exp.path)) changed.add(exp.path);
  }

  return { ok: changed.size === 0, changed: [...changed].sort(), current };
}

/** Resolve an action path against execution cwd, then make it repo-relative. */
export function repoRelativeFromCwd(cwd: string, repoRoot: string, path: string): string {
  const resolved = isAbsolute(path) ? path : join(cwd, path);
  return relative(repoRoot, resolved).split(sep).join('/');
}
