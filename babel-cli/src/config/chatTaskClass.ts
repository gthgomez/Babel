/**
 * Chat task-class tunes — general-purpose policies for different work shapes.
 *
 * Design goals:
 * - Tune by **task kind** (quick fix, multi-file SWE, investigate, governance),
 *   not by benchmark cell IDs (no SWE-A09 / GOV-D03 special cases).
 * - Benchmarks may set BABEL_CHAT_TASK_CLASS to a general class; they must not
 *   invent cell-specific knobs.
 * - Explicit env always wins; auto-classification from task text is optional.
 */

import type { ChatEngineLimits } from './chatEngineLimits.js';

/** Supported chat task classes (product-facing). */
export type ChatTaskClass =
  | 'default'
  | 'quick_inspect'
  | 'quick_fix'
  | 'general_swe'
  | 'investigate'
  | 'governance';

export const CHAT_TASK_CLASSES: readonly ChatTaskClass[] = [
  'default',
  'quick_inspect',
  'quick_fix',
  'general_swe',
  'investigate',
  'governance',
] as const;

/**
 * Verification policy for execute completions.
 *
 * - none:     No verification expected (read-only / investigate tasks).
 * - required: Agent must attempt verification (verifier receipt or log entry).
 *             Non-zero exit warns but still allows completion — the user sees
 *             the result and decides. Appropriate for interactive / default use.
 * - strict:   Verifier must exit 0 before completion is allowed. Never
 *             soft-allows through a missing or red verifier. Appropriate for
 *             multi-file SWE and governance-sensitive work.
 */
export type VerificationPolicy = 'none' | 'required' | 'strict';

/**
 * Policy knobs that differ by task class (beyond pure numeric budgets).
 */
export interface ChatTaskTune {
  class: ChatTaskClass;
  /** Partial limit overrides layered under DEFAULT_CHAT_ENGINE_LIMITS. */
  limits: Partial<ChatEngineLimits>;
  /**
   * Two-tier critic (flash→pro), higher pass confidence, fail-closed pro infra.
   * Appropriate for multi-file SWE and governance-sensitive work.
   */
  strictCritic: boolean;
  /** Turns with zero writes before force-mutate (execute intent). */
  forceMutateTurns: number;
  /**
   * Default for phase-gated tools when BABEL_PHASE_GATED_TOOLS is unset.
   * Explicit env 0/1 still wins.
   */
  phaseGatedToolsDefault: boolean;
  /**
   * Execute completion verification policy.
   *
   * - none:     skip verification gate
   * - required: must have verifier receipt; non-zero exit warns but allows
   * - strict:   exit 0 required; never soft-allow missing/red
   *
   * Supersedes the legacy requireGreenVerifier boolean.
   */
  verificationPolicy: VerificationPolicy;
  /**
   * Consecutive read-only tool calls (no mutation) before read-thrash fuse.
   * Resets on successful file mutation.
   */
  readThrashToolBudget: number;
  /**
   * Implementor W1: consecutive non-mutating shell/test tools before soft nudge.
   * 0 = disabled. Resets on successful file mutation.
   */
  shellSoftBudget: number;
  /**
   * Implementor W1: total tool calls without a write before investigate-budget nudge.
   * 0 = disabled. Soft only — never a hard kill.
   */
  investigateToolBudget: number;
  /**
   * Hard stop: tools without a successful mutation → terminal thrash stop.
   * 0 = disabled. When omitted/undefined at runtime, defaults to 2× soft budget.
   * general_swe uses an explicit cap so explore thrash cannot burn full cost.
   */
  investigateToolHardCap: number;
  /**
   * Max full-file reads of the same path before hard skip (use read_range / edit).
   */
  maxFullReadsPerFile: number;
  /**
   * Completed turns with zero successful mutations before hard BLOCKED.
   * 0 = disabled. Prevents shell-only thrash from burning full turn/cost caps.
   * Override with BABEL_CHAT_ZERO_WRITE_HARD_STOP_TURNS.
   */
  zeroWriteHardStopTurns: number;
  /**
   * Whether policy fuses (force-mutate, read-thrash, cumulative exploration)
   * should actually restrict the tool set on the next turn.
   *
   * When false: soft nudge only — the user message fires but tools are NOT
   * restricted. The model keeps full tool access to read/explore if needed.
   * This matches Claude Code / Grok CLI behavior: trust the model to sequence
   * its own tools, with the hard-stop as the safety net.
   *
   * When true: tools restricted to mutate_only or act_or_verify (legacy
   * behavior, retained for governance-class tasks).
   */
  restrictToolsOnPolicyFire: boolean;
  /**
   * When true, stall terminal (kill) actions run in shadow mode — the kill
   * intervention is downgraded to a nudge and logged via policyEventLog,
   * but the agent is never terminated by the stall detector.
   *
   * State tracking (intervention level, history) still advances normally
   * so the shadow report reflects what WOULD have happened.
   */
  stallShadowMode: boolean;
  /** Human-readable one-liner for logs / docs. */
  description: string;
}

/**
 * Legacy accessor: true when verificationPolicy is 'strict'.
 * Used by callers that only need the binary green-verifier gate
 * (diffCritic, chatEngineCriticBudget).
 */
export function isStrictVerification(policy: VerificationPolicy): boolean {
  return policy === 'strict';
}

const TUNES: Record<ChatTaskClass, ChatTaskTune> = {
  default: {
    class: 'default',
    limits: {},
    strictCritic: false,
    forceMutateTurns: 5,
    phaseGatedToolsDefault: false,
    verificationPolicy: 'required',
    readThrashToolBudget: 24,
    shellSoftBudget: 4,
    investigateToolBudget: 14,
    investigateToolHardCap: 28, // 2× soft
    maxFullReadsPerFile: 3,
    zeroWriteHardStopTurns: 12,
    restrictToolsOnPolicyFire: false,
    stallShadowMode: true,
    description: 'General interactive / execute work with balanced budgets.',
  },
  quick_inspect: {
    class: 'quick_inspect',
    limits: {
      maxWallMs: 10 * 1000, // 10s fast initial target
      maxTurns: 12,
      maxCostUsd: 0.15,
      stallTurns: 4,
    },
    strictCritic: false,
    forceMutateTurns: 99, // no mutation pressure
    phaseGatedToolsDefault: true,
    verificationPolicy: 'none',
    readThrashToolBudget: 6, // bounded read budget
    shellSoftBudget: 2,
    investigateToolBudget: 4, // initial fast budget ~4 tool calls
    investigateToolHardCap: 8,
    maxFullReadsPerFile: 2,
    zeroWriteHardStopTurns: 0,
    restrictToolsOnPolicyFire: false,
    stallShadowMode: false,
    description: 'Lightweight read-only fact queries and directory/repo counts with bounded budgets.',
  },
  quick_fix: {
    class: 'quick_fix',
    limits: {
      maxWallMs: 8 * 60 * 1000, // 8 min
      maxTurns: 80,
      maxCostUsd: 1.5,
      stallTurns: 10,
    },
    strictCritic: false,
    forceMutateTurns: 5,
    phaseGatedToolsDefault: false,
    verificationPolicy: 'required',
    readThrashToolBudget: 20,
    shellSoftBudget: 3,
    investigateToolBudget: 10,
    investigateToolHardCap: 20,
    maxFullReadsPerFile: 3,
    zeroWriteHardStopTurns: 8,
    restrictToolsOnPolicyFire: false,
    stallShadowMode: true,
    description: 'Small localized fixes — shorter wall, soft-nudge policies.',
  },
  general_swe: {
    class: 'general_swe',
    limits: {
      maxWallMs: 10 * 60 * 1000, // 600s
      maxTurns: 250,
      maxCostUsd: 3.0,
      stallTurns: 25,
      maxTokensPerRound: 200_000,
    },
    strictCritic: true,
    forceMutateTurns: 3,
    phaseGatedToolsDefault: false,
    verificationPolicy: 'required',
    readThrashToolBudget: 16,
    shellSoftBudget: 4,
    // Soft nudge earlier; hard terminal before wall thrash (Wave A: soft spam to
    // tools_without_write=13 then wall kill — hard cap 16 never fired).
    investigateToolBudget: 8,
    investigateToolHardCap: 12,
    maxFullReadsPerFile: 3,
    zeroWriteHardStopTurns: 0, // disabled — stall shadow mode handles thrash
    restrictToolsOnPolicyFire: false,
    stallShadowMode: true,
    description:
      'Multi-file / hard software engineering — long wall, strict critic, soft-nudge policies.',
  },
  investigate: {
    class: 'investigate',
    limits: {
      maxWallMs: 12 * 60 * 1000,
      maxTurns: 120,
      maxCostUsd: 2.0,
      stallTurns: 15,
    },
    strictCritic: false,
    forceMutateTurns: 99, // effectively no force-mutate on pure research
    phaseGatedToolsDefault: true, // block accidental writes while exploring
    verificationPolicy: 'none',
    readThrashToolBudget: 40,
    shellSoftBudget: 0, // disabled — research may use shell freely
    investigateToolBudget: 0, // disabled — research is explore-first
    investigateToolHardCap: 0, // disabled
    maxFullReadsPerFile: 4,
    zeroWriteHardStopTurns: 0, // disabled — research may not mutate
    restrictToolsOnPolicyFire: false,
    stallShadowMode: false,
    description: 'Read-heavy analysis — phase-gated writes, no mutate pressure.',
  },
  governance: {
    class: 'governance',
    limits: {
      maxWallMs: 12 * 60 * 1000,
      maxTurns: 100,
      maxCostUsd: 2.0,
      stallTurns: 12,
    },
    strictCritic: true,
    forceMutateTurns: 5,
    phaseGatedToolsDefault: true,
    verificationPolicy: 'strict',
    readThrashToolBudget: 16,
    shellSoftBudget: 3,
    investigateToolBudget: 12,
    investigateToolHardCap: 24,
    maxFullReadsPerFile: 2,
    zeroWriteHardStopTurns: 10,
    restrictToolsOnPolicyFire: true,
    stallShadowMode: false,
    description:
      'Policy / injection-sensitive work — strict critic + green verifier + phase gates.',
  },
};

/** Alias map: env strings → product classes (includes legacy names). */
const CLASS_ALIASES: Record<string, ChatTaskClass> = {
  default: 'default',
  general: 'default',
  chat: 'default',
  normal: 'default',
  quick_inspect: 'quick_inspect',
  inspect: 'quick_inspect',
  fast_inspect: 'quick_inspect',
  fast: 'quick_inspect',
  read_only: 'quick_inspect',
  quick_fix: 'quick_fix',
  quick: 'quick_fix',
  small_fix: 'quick_fix',
  single_file: 'quick_fix',
  general_swe: 'general_swe',
  swe: 'general_swe',
  swebench: 'general_swe',
  requires_dataset: 'general_swe',
  hard_fix: 'general_swe',
  investigate: 'investigate',
  research: 'investigate',
  explain: 'investigate',
  analysis: 'investigate',
  governance: 'governance',
  gov: 'governance',
  security: 'governance',
  injection: 'governance',
};

export function normalizeChatTaskClass(raw: string | undefined | null): ChatTaskClass | null {
  if (raw === undefined || raw === null) return null;
  const key = raw.trim().toLowerCase();
  if (!key) return null;
  return CLASS_ALIASES[key] ?? null;
}

export function getChatTaskTune(taskClass: ChatTaskClass): ChatTaskTune {
  return TUNES[taskClass];
}

export type TaskOperation = 'READ_ONLY' | 'MUTATING' | 'HYBRID';
export type TaskComplexity = 'TRIVIAL' | 'BOUNDED' | 'OPEN_ENDED';

export interface TaskShape {
  operation: TaskOperation;
  complexity: TaskComplexity;
}

/**
 * Lightweight multi-dimensional task-shape analysis.
 * Analyzes operation kind (READ_ONLY vs MUTATING vs HYBRID) and complexity (TRIVIAL vs BOUNDED vs OPEN_ENDED).
 */
export function analyzeTaskShape(taskText: string): TaskShape {
  const t = taskText.trim().toLowerCase();
  if (!t) {
    return { operation: 'READ_ONLY', complexity: 'TRIVIAL' };
  }

  // 1. Explicit read-only constraints
  const hasReadOnlyDirective =
    /\b(without (any )?(editing|modifying|changing|writing)|read-?only|(?:do\s*not|don't)\s+(?:edit|modify|change|write|delete|remove)|dry-?run)\b/i.test(
      t,
    );

  // 2. Explicit mutation keywords across the entire prompt (multi-intent safety)
  const hasMutation =
    /\b(clean\s*up\s+and\s+delete|fix|implement|patch|repair|create|write|refactor|apply|modify|update|edit|add|replace|rename)\b/i.test(t) ||
    (!hasReadOnlyDirective && /\b(delete|remove|rm|drop|erase|unlink)\b/i.test(t));

  // 3. Exploratory keywords (find, scan, list, check, explain, analyze, review, compare)
  const hasExploratory =
    /\b(find|search|list|check|inspect|discover|locate|scan|show|inventory|explain|analyze|review|compare|diagnose)\b/i.test(t);

  // 4. Sequenced mutation override (e.g. "review without changing anything, then fix the issue")
  const hasSequencedMutationOverride =
    /\b(?:then|afterwards|and\s+then)\s+(?:fix|implement|repair|modify|update|apply|patch|change|edit)\b/i.test(
      t,
    );

  let operation: TaskOperation;
  if (hasReadOnlyDirective && !hasSequencedMutationOverride) {
    operation = 'READ_ONLY';
  } else if (hasMutation && (hasExploratory || hasReadOnlyDirective)) {
    operation = 'HYBRID';
  } else if (hasMutation) {
    operation = 'MUTATING';
  } else {
    operation = 'READ_ONLY';
  }

  // 4. Complexity determination
  // Deep/open-ended signals (architecture, root cause, trace, multi-file, race condition)
  const isMultiFileSWE =
    /\b(multi[- ]?file|across (the )?(codebase|repo|modules)|failing (test )?suite|regression|deadlock|race condition|production bug|segfault|entire (module|package|feature)|large refactor|migrate)\b/i.test(
      t,
    );
  const isDeepAnalysis =
    /\b(architecture|root\s*cause|deep\s*dive|risk|vulnerabilit|trace|data\s*flow|design\s*pattern|compare\s+and\s+contrast|walk\s*me\s*through\s+the\s+entire|in\s*depth)\b/i.test(
      t,
    ) || /^(explain|describe|analyze)\b/i.test(t);

  const isOpenEnded = isMultiFileSWE || isDeepAnalysis;

  // Trivial signals: quick queries like how many, count, list, is there, where is, what version, simple inventory (for read-only)
  // or typo / single-line / rename only (for mutating)
  const isTrivialFact =
    operation === 'READ_ONLY' &&
    /\b(how\s*many|count|inventory|is\s*there|which\s*folder|what\s*version|where\s*is|status\s*of|what\s*is|who\s*is|trivial)\b/i.test(
      t,
    );
  const isTrivialMutation =
    (operation === 'MUTATING' || operation === 'HYBRID') &&
    /\b(typo|one[- ]liner|single (file|function|line)|rename only|just (change|fix|update) .{0,40}\b(line|function|variable))\b/i.test(
      t,
    );

  let complexity: TaskComplexity;
  if (isOpenEnded) {
    complexity = 'OPEN_ENDED';
  } else if (isTrivialFact || isTrivialMutation) {
    complexity = 'TRIVIAL';
  } else {
    complexity = 'BOUNDED';
  }

  return { operation, complexity };
}

/**
 * Map task shape into product task class.
 */
export function mapTaskShapeToClass(shape: TaskShape, taskText: string): ChatTaskClass {
  const t = taskText.trim().toLowerCase();

  // Governance / untrusted input (general patterns, not GOV-D*)
  if (
    /\b(ignore (all )?(previous|prior) (instructions|prompts)|system prompt|prompt injection|jailbreak)\b/.test(
      t,
    ) ||
    /\b(untrusted|exfiltrat|secret exfil|override (your|the) (rules|policy))\b/.test(t)
  ) {
    return 'governance';
  }

  // Multi-file / hard SWE signals (general language — not swebench).
  const isMultiFileSWE =
    /\b(multi[- ]?file|across (the )?(codebase|repo|modules)|failing (test )?suite|regression|deadlock|race condition|production bug|segfault|entire (module|package|feature)|large refactor|migrate)\b/i.test(
      t,
    );
  if (isMultiFileSWE) {
    return 'general_swe';
  }

  if (shape.operation === 'READ_ONLY') {
    if (shape.complexity === 'TRIVIAL') {
      return 'quick_inspect';
    }
    return 'investigate';
  }

  // MUTATING or HYBRID
  if (shape.complexity === 'TRIVIAL') {
    return 'quick_fix';
  }

  // Default execute-ish tasks ("fix the bug", "clean up and delete unused folders") stay balanced default
  return 'default';
}

/**
 * Classify task text into a general work shape.
 * Multi-dimensional analysis: checks mutation intent, scope, and complexity.
 */
export function classifyChatTaskClassFromText(taskText: string): ChatTaskClass {
  const shape = analyzeTaskShape(taskText);
  return mapTaskShapeToClass(shape, taskText);
}

export function resolveChatTaskClass(opts?: {
  env?: NodeJS.ProcessEnv;
  taskText?: string;
  /**
   * When env does not set a class, classify from taskText.
   * Default true so interactive chat gets a useful tune without knobs.
   */
  autoClassify?: boolean;
}): ChatTaskClass {
  const env = opts?.env ?? process.env;
  const auto = opts?.autoClassify !== false;

  // Legacy SWE profile flag → general_swe
  const sweProfile = env['BABEL_CHAT_SWE_PROFILE']?.trim().toLowerCase();
  if (sweProfile === '1' || sweProfile === 'true' || sweProfile === 'on') {
    return 'general_swe';
  }

  const fromEnv = normalizeChatTaskClass(env['BABEL_CHAT_TASK_CLASS']);
  if (fromEnv) return fromEnv;

  if (auto && opts?.taskText && opts.taskText.trim()) {
    return classifyChatTaskClassFromText(opts.taskText);
  }

  return 'default';
}

export function resolveChatTaskTune(opts?: {
  env?: NodeJS.ProcessEnv;
  taskText?: string;
  autoClassify?: boolean;
}): ChatTaskTune {
  return getChatTaskTune(resolveChatTaskClass(opts));
}

/**
 * Whether this class (or env) enables SWE-class budgets / strict critic.
 * Back-compat name used across chatEngine / critic; means general_swe tune.
 */
export function isGeneralSweTaskClass(
  env: NodeJS.ProcessEnv = process.env,
  taskText?: string,
): boolean {
  return (
    resolveChatTaskClass({
      env,
      ...(taskText !== undefined ? { taskText } : {}),
      autoClassify: Boolean(taskText),
    }) === 'general_swe'
  );
}

/**
 * Coding profile summary — one row per task class, exposing the key knobs
 * operators and docs care about. Useful for runtime introspection and
 * cross-checking the guide table.
 */
export interface CodingProfileSummary {
  class: ChatTaskClass;
  description: string;
  zeroWriteHardStopTurns: number;
  forceMutateTurns: number;
  strictCritic: boolean;
  phaseGatedToolsDefault: boolean;
  verificationPolicy: VerificationPolicy;
  readThrashToolBudget: number;
  maxFullReadsPerFile: number;
  maxWallMs: number | null;
  maxTurns: number | null;
  maxCostUsd: number | null;
  stallTurns: number | null;
}

/**
 * One-line human-readable description of the interactive coding profile for a
 * given task class. Exposes the key knobs operators and docs care about:
 * soft fuses vs hard restrict, phase-gate, verification policy, hard-stop turns.
 *
 * Used by REPL status display and chat task-start diagnostic logs.
 */
export function describeInteractiveCodingProfile(taskClass?: ChatTaskClass): string {
  const cls = taskClass ?? 'default';
  const tune = TUNES[cls];
  const flags: string[] = [];

  // Phase gate status — only mentioned when ON (the default for execute is off)
  if (tune.phaseGatedToolsDefault) {
    flags.push('phase-gate ON');
  }

  // Tool restriction posture
  if (tune.restrictToolsOnPolicyFire) {
    flags.push('hard restrict');
  } else {
    flags.push('soft fuses');
  }

  // Verification policy
  flags.push(`verify:${tune.verificationPolicy}`);

  // Zero-write hard stop (only mention when enabled)
  if (tune.zeroWriteHardStopTurns > 0) {
    flags.push(`HS:${tune.zeroWriteHardStopTurns}t`);
  }

  return `${cls} (${flags.join(', ')})`;
}

/** Return one summary row per configured task class. */
export function listCodingProfileSummaries(): CodingProfileSummary[] {
  return CHAT_TASK_CLASSES.map((cls) => {
    const tune = TUNES[cls];
    return {
      class: tune.class,
      description: tune.description,
      zeroWriteHardStopTurns: tune.zeroWriteHardStopTurns,
      forceMutateTurns: tune.forceMutateTurns,
      strictCritic: tune.strictCritic,
      phaseGatedToolsDefault: tune.phaseGatedToolsDefault,
      verificationPolicy: tune.verificationPolicy,
      readThrashToolBudget: tune.readThrashToolBudget,
      maxFullReadsPerFile: tune.maxFullReadsPerFile,
      maxWallMs: tune.limits.maxWallMs ?? null,
      maxTurns: tune.limits.maxTurns ?? null,
      maxCostUsd: tune.limits.maxCostUsd ?? null,
      stallTurns: tune.limits.stallTurns ?? null,
    };
  });
}
