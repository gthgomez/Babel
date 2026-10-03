/**
 * research/analysis/applicability.ts — local applicability analysis
 *
 * Runs only after external patterns are source-confirmed. Compares a
 * Pattern Card against the user's target project using Babel's existing
 * local search surface (grep-based occurrence scan in V1; SemanticIndexer
 * integration slots in behind the same interface later) and grounds the
 * comparison in local evidence: what currently solves the problem, where
 * the pattern could attach, what is actually missing, and what conflicts.
 *
 * The applicability conclusion is bound to the target project's HEAD
 * SHA. If HEAD later changes materially, the conclusion is stale
 * (REVALIDATION_REQUIRED) — an external pinned SHA never keeps a local
 * conclusion "current".
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { PatternCardV1, ResearchMissionV1 } from '../contracts.js';
import { createHash } from 'node:crypto';

export interface LocalEvidenceRef {
  /** Referenceable id for the Pattern Card's local_evidence_refs. */
  local_ref_id: string;
  path: string;
  start_line: number;
  end_line: number;
  content_hash: string;
}

export interface ApplicabilityFinding {
  /** Where the pattern could attach in the target project. */
  attach_points: LocalEvidenceRef[];
  /** Target code that already addresses the problem. */
  existing_mechanisms: LocalEvidenceRef[];
  /** Capabilities present in the pattern but absent locally. */
  gaps: string[];
  /** Architectural or authority conflicts with the target project. */
  conflicts: string[];
  /** Smallest meaningful experiment, as a falsifiable statement. */
  smallest_experiment: string;
  head_sha: string | null;
}

export interface ApplicabilityOptions {
  now?: Date;
  /** Extra directory/file names to treat as attachment candidates. */
  attachHints?: string[];
  /** Reader-report text (problem_match, observation claims) used to ground gap detection. */
  reportText?: string;
}

const MECHANISM_FILE_HINTS = [
  /journal/i, /checkpoint/i, /resume/i, /retry/i, /recover/i, /session/i,
  /state/i, /queue/i, /worker/i, /crash/i, /persist/i,
];

function gitHeadSha(projectRoot: string): string | null {
  if (!existsSync(join(projectRoot, '.git'))) return null;
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

interface Occurrence {
  path: string;
  line: number;
  text: string;
}

/**
 * Deterministic local scan. Purely read-only over text files under the
 * project root (source/doc extensions, size-capped), skipping node_modules
 * and .git. V1 ships grep-style scanning; swapping in SemanticIndexer/FTS5
 * later changes only this function.
 */
export function scanTargetProject(projectRoot: string, terms: string[], maxOccurrences = 40): Occurrence[] {
  const occurrences: Occurrence[] = [];
  const skip = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.aic-worktrees', 'runs']);
  // Skip timestamped Babel run directories (own research artifacts are not target evidence).
  const runDirLike = /^\d{4}-\d{2}-/;
  const textExtensions = /\.(ts|tsx|js|jsx|mjs|cjs|md|json|py|rs|go|java|rb|sh|yml|yaml|toml)$/i;

  const walk = (dir: string, depth: number): void => {
    if (depth > 6 || occurrences.length >= maxOccurrences) return;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (occurrences.length >= maxOccurrences) return;
      if (skip.has(entry) || runDirLike.test(entry)) continue;
      const full = join(dir, entry);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (!textExtensions.test(entry) || stat.size > 1_000_000) continue;
      let content: string;
      try {
        content = readFileSync(full, 'utf8');
      } catch {
        continue;
      }
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const lower = lines[i]!.toLowerCase();
        if (terms.some((term) => lower.includes(term))) {
          occurrences.push({ path: full, line: i + 1, text: lines[i]!.trim().slice(0, 200) });
          if (occurrences.length >= maxOccurrences) return;
        }
      }
    }
  };
  walk(projectRoot, 0);
  return occurrences;
}

function toLocalRef(root: string, occurrence: Occurrence): LocalEvidenceRef {
  return {
    local_ref_id: `loc_${hashText(`${occurrence.path}:${occurrence.line}`).slice(0, 12)}`,
    path: occurrence.path.startsWith(root) ? occurrence.path.slice(root.length + 1) : occurrence.path,
    start_line: occurrence.line,
    end_line: occurrence.line,
    content_hash: hashText(occurrence.text),
  };
}

const GAP_SIGNATURES: Array<[RegExp, string]> = [
  [/\bjournal\b/i, 'append-only journaling of state transitions'],
  [/\bcheckpoint\b/i, 'explicit checkpointing of long-running work'],
  [/\bidempotent/i, 'idempotent re-execution guards'],
  [/\breplay\b/i, 'deterministic replay of interrupted work'],
  [/\bresume\b/i, 'resume-from-persisted-state semantics'],
];

const CONFLICT_SIGNATURES: Array<[RegExp, string]> = [
  [/\bapproval/i, 'pattern assumes autonomous mutation; target gates mutations behind approvals'],
  [/\bcredential|secret|token/i, 'pattern touches credentials; target keeps credentials host-owned'],
];

export function analyzeApplicability(
  mission: ResearchMissionV1,
  card: PatternCardV1,
  options: ApplicabilityOptions = {},
): ApplicabilityFinding {
  const root = mission.target.project_root;
  const headSha = gitHeadSha(root);
  const terms = [
    ...new Set([
      ...card.title.toLowerCase().split(/\W+/).filter((w) => w.length > 3),
      ...card.mechanism.toLowerCase().split(/\W+/).filter((w) => w.length > 3),
      ...card.problem.toLowerCase().split(/\W+/).filter((w) => w.length > 3),
      // Pattern cards from the keyword strategy carry repo-derived titles;
      // the mission's problem terms keep the local scan on-target.
      ...mission.problem.statement.toLowerCase().split(/\W+/).filter((w) => w.length > 3),
    ]),
  ].slice(0, 14);

  const occurrences = scanTargetProject(root, terms);
  const attach = occurrences.filter((o) => MECHANISM_FILE_HINTS.some((re) => re.test(o.path)));
  const existing = occurrences.filter((o) => !attach.includes(o));

  const haystack = [
    card.mechanism,
    card.problem,
    card.title,
    options.reportText ?? '',
    // The mission's problem statement describes the mechanism class the
    // user is hunting for; the reader report grounds it in observed files.
    mission.problem.statement,
  ].join('\n');
  // A gap is a mechanism the pattern relies on (per its signature) that the
  // target project's scanned text does not already mention.
  const localText = occurrences.map((o) => o.text.toLowerCase()).join('\n');
  const gaps = GAP_SIGNATURES.filter(([re, label]) => re.test(haystack) && !localText.includes(label)).map(
    ([, label]) => label,
  );
  const conflicts = CONFLICT_SIGNATURES.filter(([re]) => re.test(haystack)).map(([, label]) => label);

  return {
    attach_points: attach.slice(0, 5).map((o) => toLocalRef(root, o)),
    existing_mechanisms: existing.slice(0, 5).map((o) => toLocalRef(root, o)),
    gaps,
    conflicts,
    smallest_experiment: buildSmallestExperiment(card, gaps),
    head_sha: headSha,
  };
}

function buildSmallestExperiment(card: PatternCardV1, gaps: string[]): string {
  const focus = gaps[0] ?? card.problem;
  return (
    `Prototype ${card.title} behind a feature flag covering one affected flow; ` +
    `measure whether ${focus} improves against the current baseline without regressions.`
  );
}

/** Staleness check: an applicability conclusion is stale once target HEAD moves. */
export function isApplicabilityStale(finding: ApplicabilityFinding, currentHeadSha: string | null): boolean {
  if (!finding.head_sha || !currentHeadSha) return finding.head_sha !== currentHeadSha;
  return finding.head_sha !== currentHeadSha;
}
