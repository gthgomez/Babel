/**
 * C1: Natural-language intent compiler — pre-loop intent expansion for execute tasks.
 *
 * Produces an IntentPlan from task text via heuristic extraction.
 * Designed to be called once at session start (chatCore.ts) and injected as a
 * structured user message so the model sees the expanded intent before its
 * first tool turn.
 *
 * Future: IntentPlanCompletionHook for model-generated JSON plans (C2+).
 */

import { isFalsyEnvFlag } from '../utils/envFlags.js';

/** Structured intent plan produced by the compiler. */
export interface IntentPlan {
  /** One-sentence summary of what needs to be done. */
  goal: string;
  /** Observable conditions that signal success. */
  success_criteria: string[];
  /** File paths likely involved (hints, not exhaustive). */
  likely_files: string[];
  /** Test command when discoverable from the task or harness dataset. */
  test_command?: string;
  /** Guardrails for the execution (single file, minimal patch, etc.). */
  constraints: string[];
  /** 0–1 confidence in the plan quality (heuristic ≈ 0.3–0.5). */
  confidence: number;
}

/**
 * Parse a model-generated JSON string into an IntentPlan.
 * Handles markdown-fenced JSON (` ```json ... ``` `).
 * Returns null on any parse or shape failure — callers fall back to heuristic.
 */
export function parseIntentPlanJson(json: string): IntentPlan | null {
  let cleaned = json.trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) cleaned = fenceMatch[1]!.trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;

  if (typeof obj.goal !== 'string' || !obj.goal.trim()) return null;

  const testCmd =
    typeof obj.test_command === 'string' && obj.test_command.trim()
      ? obj.test_command.trim()
      : undefined;
  return {
    goal: obj.goal.trim(),
    success_criteria: filterStrings(obj.success_criteria),
    likely_files: filterStrings(obj.likely_files),
    ...(testCmd !== undefined ? { test_command: testCmd } : {}),
    constraints: filterStrings(obj.constraints),
    confidence:
      typeof obj.confidence === 'number'
        ? clamp(obj.confidence, 0, 1)
        : 0.5,
  };
}

/**
 * Derive an IntentPlan from task text using pure heuristics — no LLM call.
 * Always returns a valid plan with non-empty goal + constraints.
 */
export function heuristicIntentPlan(task: string): IntentPlan {
  const t = task.trim();

  // ── goal ──────────────────────────────────────────────────────────────
  const firstSentence = t.split(/[.!?]\s+/)[0] ?? t;
  const goal =
    firstSentence.length > 140
      ? firstSentence.slice(0, 137) + '...'
      : firstSentence;

  // ── likely_files ──────────────────────────────────────────────────────
  const backtickFiles = [
    ...t.matchAll(
      /`([^`]+\.(?:tsx?|jsx?|py|go|rs|java|rb|css|html|json|ya?ml|md|txt))`/g,
    ),
  ].map((m) => m[1]!);
  const pathRefs = [
    ...t.matchAll(
      /\b(?:in|at|file|path|from|under)\s+['"]?([^\s'",]+\.(?:tsx?|jsx?|py|go|rs|java|rb|css|html))['"]?/gi,
    ),
  ].map((m) => m[1]!);
  const likely_files = [...new Set([...backtickFiles, ...pathRefs])].slice(0, 5);

  // ── test_command ─────────────────────────────────────────────────────
  let test_command: string | undefined;
  const testCmdMatch = t.match(
    /(?:run|execute)\s+(?:tests?\s+(?:with|using)\s+)?[`']?(npx\s+vitest|pytest|npm\s+test|npx\s+tsx\s+--test|go\s+test|cargo\s+test|jest)[`']?\s*([^\s,;]*)?/i,
  );
  if (testCmdMatch) {
    test_command = testCmdMatch[0].replace(/\s+/g, ' ').trim();
  }

  // ── constraints ──────────────────────────────────────────────────────
  const constraints: string[] = [];
  if (
    /\b(only|just|single|one)\s+(file|change|line|function|module)\b/i.test(t)
  ) {
    constraints.push('Single file change only');
  }
  if (/\bminimal\s+(patch|change|diff|edit)\b/i.test(t)) {
    constraints.push('Minimal patch');
  }
  if (
    /\bdon'?t\s+(break|change|modify|touch)\s+(tests?|existing|other|unrelated)\b/i.test(
      t,
    )
  ) {
    constraints.push('Do not break existing tests');
  }
  if (constraints.length === 0) {
    constraints.push('Make minimal, focused changes');
  }

  // ── success_criteria ─────────────────────────────────────────────────
  const success_criteria: string[] = [];
  if (test_command) {
    success_criteria.push(`Tests pass: ${test_command}`);
  }
  if (/\btest(s)?\s+(pass|green|succeed)\b/i.test(t)) {
    success_criteria.push('All tests pass');
  }
  if (/\b(compile|build|typecheck|tsc)\s+(pass|clean|green|succeed)\b/i.test(t)) {
    success_criteria.push('Code compiles without errors');
  }
  if (success_criteria.length === 0) {
    success_criteria.push('The described issue is resolved');
    success_criteria.push('No regressions introduced');
  }

  // ── confidence ───────────────────────────────────────────────────────
  const confidence = likely_files.length > 0 ? 0.4 : 0.3;

  return {
    goal,
    success_criteria,
    likely_files,
    ...(test_command !== undefined ? { test_command } : {}),
    constraints,
    confidence,
  };
}

/**
 * Check whether the intent compiler should be skipped for this task.
 *
 * Skip when:
 * - taskClass is 'investigate' (read-only, no intent to execute)
 * - Dataset provides explicit test paths (SWE harness — use dataset fields)
 * - Task text already contains FAIL_TO_PASS / PASS_TO_PASS (SWE harness)
 * - Task text has explicit pytest file paths (like SWE benchmark issues)
 */
export function shouldSkipIntentCompiler(
  task: string,
  opts?: { hasDatasetTestPath?: boolean; taskClass?: string },
): boolean {
  if (opts?.taskClass === 'investigate') return true;
  if (opts?.hasDatasetTestPath) return true;

  if (/\bFAIL_TO_PASS\b/i.test(task)) return true;
  if (/\bPASS_TO_PASS\b/i.test(task)) return true;

  // Explicit pytest file paths → dataset provides test info
  if (/(?:^|\s)tests?\/[^\s]+\.[a-z]{2,4}::test_\w+/i.test(task)) return true;

  return false;
}

/**
 * Resolve whether the intent compiler is enabled for this context.
 *
 * BABEL_CHAT_INTENT_COMPILER env:
 * - unset / empty → default ON for interactive execute
 * - "0" / "false" / "off" → disabled
 * - any other value → enabled
 */
export function isIntentCompilerEnabled(env?: NodeJS.ProcessEnv): boolean {
  const e = env ?? process.env;
  const raw = e['BABEL_CHAT_INTENT_COMPILER'];
  // Default ON when unset or empty.
  if (raw === undefined || raw.trim() === '') return true;
  // Use shared falsy check: 0 / false / off / no → disabled.
  if (isFalsyEnvFlag(raw)) return false;
  // Any other value → enabled.
  return true;
}

/**
 * Main entry point: compile an intent plan for a task.
 * Returns null when the compiler is disabled, should be skipped, or the
 * task is empty — callers skip injection when null.
 */
export function compileIntentPlan(
  task: string,
  opts?: {
    env?: NodeJS.ProcessEnv;
    hasDatasetTestPath?: boolean;
    taskClass?: string;
  },
): IntentPlan | null {
  if (!isIntentCompilerEnabled(opts?.env)) return null;
  if (!task.trim()) return null;
  if (shouldSkipIntentCompiler(task, opts)) return null;

  return heuristicIntentPlan(task);
}

/**
 * Format an IntentPlan as a structured markdown user message for injection
 * into the conversation. The model sees this as context before its first
 * tool turn.
 */
export function formatIntentPlanUserMessage(plan: IntentPlan): string {
  const lines: string[] = [
    '## Intent Plan',
    '',
    `**Goal**: ${plan.goal}`,
    '',
    '**Success criteria**:',
    ...plan.success_criteria.map((c) => `- ${c}`),
  ];

  if (plan.likely_files.length > 0) {
    lines.push('', '**Likely files**:', ...plan.likely_files.map((f) => `- \`${f}\``));
  }

  if (plan.test_command) {
    lines.push('', `**Test command**: \`${plan.test_command}\``);
  }

  if (plan.constraints.length > 0) {
    lines.push('', '**Constraints**:', ...plan.constraints.map((c) => `- ${c}`));
  }

  lines.push(
    '',
    `**Confidence**: ${Math.round(plan.confidence * 100)}% (heuristic — verify before acting)`,
  );

  return lines.join('\n');
}

/**
 * Pre-loop planning instruction injected before the first tool turn.
 *
 * Tells the model to think about its approach before reaching for tools —
 * compensates for DeepSeek's inability to use thinking+tool_choice together.
 * Zero-cost: no extra LLM call, just a directive in the user message.
 *
 * Gated by BABEL_CHAT_PRELOOP_PLAN (default: on for execute-task classes).
 */
export function buildPreLoopPlanningInstruction(opts?: {
  /** When true, add stronger language about mutate-before-env-pytest. */
  enforceMutateFirst?: boolean;
}): string {
  const mutateRule = opts?.enforceMutateFirst
    ? [
        '',
        '**CRITICAL**: Do NOT run pytest or broad test suites before patching.',
        'If the test environment is broken (missing deps, wrong Python version),',
        'apply the fix with str_replace and report the patch — do NOT try to fix the environment.',
      ].join('\n')
    : '';

  return [
    '## Before You Start',
    '',
    'Read the intent plan above. Before using ANY tools:',
    '',
    '1. **Identify the fix location** — which file and function need to change',
    '2. **Describe your fix** in 1–2 sentences',
    '3. **Then** use grep or read_file to localize, followed by str_replace',
    '',
    'Your first tools should be **grep** or **read_file** — not shell commands.',
    'Aim for: localize (≤4 reads) → ONE str_replace → targeted verify.',
    mutateRule,
  ]
    .filter(Boolean)
    .join('\n');
}

// ── helpers ────────────────────────────────────────────────────────────────

function filterStrings(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
