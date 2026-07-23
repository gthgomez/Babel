/**
 * W2.3 — Review-on-diff agent
 *
 * Reviews an implement **diff only** (paths + unified patch text).
 * Does not re-explore the repo. Produces structured comments/critique.
 *
 * Offline-first: pure heuristics on patch text (no LLM required for unit tests).
 * Optional later: plug flash critic model via DiffCritic-style call.
 */

export type ReviewOnDiffSeverity = 'info' | 'warning' | 'error';

export interface ReviewOnDiffComment {
  path?: string;
  severity: ReviewOnDiffSeverity;
  message: string;
  /** Optional hunk/line hint from unified diff. */
  line?: number;
  category:
    | 'scope'
    | 'risk'
    | 'test'
    | 'style'
    | 'correctness'
    | 'missing_context'
    | 'summary';
}

export interface ReviewOnDiffInput {
  /** Original task / implement intent. */
  task: string;
  /** Unified diff text (git diff style). */
  patch: string;
  /** Changed file paths (optional; derived from patch when omitted). */
  changedFiles?: string[];
  /** Optional write_scope the implement agent was allowed. */
  writeScope?: string[];
  agentId?: string;
  now?: Date;
}

export interface ReviewOnDiffResult {
  agentId: string;
  success: boolean;
  verdict: 'approve' | 'request_changes' | 'comment';
  summary: string;
  comments: ReviewOnDiffComment[];
  changedFiles: string[];
  /** Always true — review is read-only. */
  readOnly: true;
  /** Always 0 — review must never mutate. */
  write_count: 0;
  created_at: string;
  diagnostics: Array<{ code: string; message: string }>;
  error: string | null;
}

const DIFF_FILE_RE = /^\+\+\+ b\/(.+)$/gm;
const HUNK_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/gm;

/** Extract changed paths from a unified diff. */
export function extractPathsFromUnifiedDiff(patch: string): string[] {
  const paths: string[] = [];
  for (const m of patch.matchAll(DIFF_FILE_RE)) {
    const p = (m[1] ?? '').trim().replace(/\\/g, '/');
    if (p && p !== '/dev/null' && !paths.includes(p)) paths.push(p);
  }
  // Fallback: --- a/ paths
  for (const m of patch.matchAll(/^--- a\/(.+)$/gm)) {
    const p = (m[1] ?? '').trim().replace(/\\/g, '/');
    if (p && p !== '/dev/null' && !paths.includes(p)) paths.push(p);
  }
  return paths;
}

function pathInWriteScope(path: string, writeScope: string[]): boolean {
  const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '');
  return writeScope.some((scope) => {
    const s = scope.replace(/\\/g, '/').replace(/\/$/, '');
    return normalized === s || normalized.startsWith(`${s}/`);
  });
}

/**
 * Heuristic review of a patch without filesystem exploration.
 */
export function reviewDiffHeuristically(input: {
  task: string;
  patch: string;
  changedFiles: string[];
  writeScope?: string[];
}): ReviewOnDiffComment[] {
  const comments: ReviewOnDiffComment[] = [];
  const patch = input.patch ?? '';
  const files = input.changedFiles;
  const taskLower = input.task.toLowerCase();

  if (!patch.trim() && files.length === 0) {
    comments.push({
      severity: 'error',
      category: 'missing_context',
      message: 'No diff or changed files provided — nothing to review.',
    });
    return comments;
  }

  if (files.length === 0 && patch.trim()) {
    comments.push({
      severity: 'warning',
      category: 'missing_context',
      message: 'Patch present but no file paths extracted — verify unified-diff format.',
    });
  }

  // Scope check
  if (input.writeScope && input.writeScope.length > 0) {
    for (const f of files) {
      if (!pathInWriteScope(f, input.writeScope)) {
        comments.push({
          path: f,
          severity: 'error',
          category: 'scope',
          message: `Changed path is outside write_scope (${input.writeScope.join(', ')}).`,
        });
      }
    }
  }

  // Large patch risk
  const addedLines = (patch.match(/^\+[^+]/gm) ?? []).length;
  const removedLines = (patch.match(/^-[^-]/gm) ?? []).length;
  if (addedLines + removedLines > 400) {
    comments.push({
      severity: 'warning',
      category: 'risk',
      message: `Large diff (~${addedLines}+ / ${removedLines}- lines). Consider splitting for safer review.`,
    });
  }

  // Secret-ish patterns
  if (
    /(?:api[_-]?key|secret|password|BEGIN (?:RSA |OPENSSH )?PRIVATE KEY)\s*[:=]/i.test(patch) ||
    /^\+.*(?:sk-[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{20,})/m.test(patch)
  ) {
    comments.push({
      severity: 'error',
      category: 'risk',
      message: 'Possible secret or credential material in the diff — do not merge until redacted.',
    });
  }

  // Delete-heavy without tests
  if (removedLines > addedLines * 2 && removedLines > 20) {
    comments.push({
      severity: 'warning',
      category: 'risk',
      message: 'Delete-heavy patch — confirm intentional removals and callers still compile.',
    });
  }

  // Test expectation: task mentions test/fix but no test file touched
  const taskWantsTests =
    /\b(test|spec|verify|regression)\b/i.test(input.task) || taskLower.includes('unit test');
  const touchesTest = files.some((f) =>
    /\.(test|spec)\.[cm]?[jt]sx?$|_test\.py|test_.*\.py$/.test(f),
  );
  if (taskWantsTests && !touchesTest && files.length > 0) {
    comments.push({
      severity: 'warning',
      category: 'test',
      message:
        'Task mentions testing/verification but no test file appears in the diff — add or run a targeted test.',
    });
  }

  // console.log / debugger noise
  if (/^\+\s*(?:console\.(?:log|debug|info)|debugger)\b/m.test(patch)) {
    comments.push({
      severity: 'info',
      category: 'style',
      message: 'Debug logging (console.log/debugger) added — confirm it should ship.',
    });
  }

  // TODO/FIXME left in added lines
  if (/^\+.*\b(?:TODO|FIXME|HACK)\b/m.test(patch)) {
    comments.push({
      severity: 'info',
      category: 'style',
      message: 'TODO/FIXME markers introduced in the patch.',
    });
  }

  // Empty catch / swallow errors
  if (/^\+\s*catch\s*\([^)]*\)\s*\{\s*\}/m.test(patch) || /^\+\s*catch\s*\{\s*\}/m.test(patch)) {
    comments.push({
      severity: 'warning',
      category: 'correctness',
      message: 'Empty catch block added — errors may be swallowed silently.',
    });
  }

  // Hunk line hints for first error-shaped addition
  if (/^\+.*\bthrow new Error\(['\"]not implemented/im.test(patch)) {
    let line: number | undefined;
    HUNK_RE.lastIndex = 0;
    const hunk = HUNK_RE.exec(patch);
    if (hunk) line = Number(hunk[1]);
    comments.push({
      severity: 'error',
      category: 'correctness',
      message: 'Patch introduces a not-implemented throw — incomplete implement?',
      ...(line !== undefined ? { line } : {}),
    });
  }

  // Summary comment
  comments.push({
    severity: 'info',
    category: 'summary',
    message: `Reviewed ${files.length} file(s), ~${addedLines} addition(s) / ${removedLines} deletion(s). No repo re-exploration performed.`,
  });

  return comments;
}

function verdictFromComments(comments: ReviewOnDiffComment[]): ReviewOnDiffResult['verdict'] {
  if (comments.some((c) => c.severity === 'error')) return 'request_changes';
  if (comments.some((c) => c.severity === 'warning')) return 'comment';
  return 'approve';
}

/**
 * Run review-on-diff agent (offline heuristic path).
 * Acceptance (W2.3): critique without re-exploring repo; write_count always 0.
 */
export function runReviewOnDiffAgent(input: ReviewOnDiffInput): ReviewOnDiffResult {
  const agentId = input.agentId ?? 'review-on-diff';
  const diagnostics: Array<{ code: string; message: string }> = [];

  if (!input.task?.trim()) {
    diagnostics.push({ code: 'task_required', message: 'task is required' });
  }

  const fromPatch = extractPathsFromUnifiedDiff(input.patch ?? '');
  const changedFiles = [
    ...new Set([...(input.changedFiles ?? []).map((p) => p.replace(/\\/g, '/')), ...fromPatch]),
  ];

  if (diagnostics.length > 0) {
    return {
      agentId,
      success: false,
      verdict: 'request_changes',
      summary: diagnostics.map((d) => d.message).join('; '),
      comments: [],
      changedFiles,
      readOnly: true,
      write_count: 0,
      created_at: (input.now ?? new Date()).toISOString(),
      diagnostics,
      error: diagnostics.map((d) => d.message).join('; '),
    };
  }

  const comments = reviewDiffHeuristically({
    task: input.task,
    patch: input.patch ?? '',
    changedFiles,
    ...(input.writeScope ? { writeScope: input.writeScope } : {}),
  });

  const verdict = verdictFromComments(comments);
  const errors = comments.filter((c) => c.severity === 'error').length;
  const warnings = comments.filter((c) => c.severity === 'warning').length;

  return {
    agentId,
    success: true,
    verdict,
    summary: `Review-on-diff ${verdict}: ${errors} error(s), ${warnings} warning(s), ${changedFiles.length} file(s).`,
    comments,
    changedFiles,
    readOnly: true,
    write_count: 0,
    created_at: (input.now ?? new Date()).toISOString(),
    diagnostics,
    error: null,
  };
}

/** Format review result as operator-facing markdown. */
export function formatReviewOnDiffMarkdown(result: ReviewOnDiffResult): string {
  const lines = [
    `# Review-on-diff — ${result.verdict}`,
    '',
    result.summary,
    '',
    `Files: ${result.changedFiles.length ? result.changedFiles.join(', ') : '(none)'}`,
    '',
    '## Comments',
  ];
  for (const c of result.comments) {
    const loc = c.path
      ? `${c.path}${c.line !== undefined ? `:${c.line}` : ''}`
      : '(general)';
    lines.push(`- **${c.severity}** [${c.category}] ${loc}: ${c.message}`);
  }
  lines.push('', '_Read-only review; write_count=0._');
  return lines.join('\n');
}
