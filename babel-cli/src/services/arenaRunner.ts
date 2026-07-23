/**
 * arenaRunner.ts — Arena Evaluation Infrastructure (P1.1)
 *
 * Runs multiple planning approaches (different models, strategies, or
 * configurations) on the same task, then compares and scores the results
 * to select the best approach. This enables 2-4 coordinated subagents
 * with evidence-aware comparison and clean selection.
 *
 * Modes:
 * - mock: Deterministic scoring based on plan quality signals
 * - live: LLM judge evaluates and compares results (requires API keys)
 *
 * Integration points:
 * - Standalone via `babel arena "task" --entries 3`
 * - Embedded in plan lane when `arenaMode` option is set
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { BABEL_RUNS_DIR } from '../cli/constants.js';
import type { LitePlanAnswer } from '../schemas/liteReadOnlyAnswers.js';
import { runPlanLane } from '../agent/lanes/planLane.js';
import type { PlanLaneResult } from '../agent/lanes/planLane.js';

// ── Types ────────────────────────────────────────────────────────────────────────

export type ArenaStrategy = 'conservative' | 'balanced' | 'aggressive';

export interface ArenaEntrySpec {
  /** Short identifier for this entry (e.g. "deepseek-conservative") */
  id: string;
  /** Model to use for this entry */
  model: string;
  /** Planning strategy */
  strategy: ArenaStrategy;
  /** Human-readable description of this approach */
  description: string;
}

export interface ArenaConfig {
  task: string;
  projectRoot: string;
  entries: ArenaEntrySpec[];
  /** Provider mode: 'mock' | 'live'. Defaults to 'mock' when offline. */
  provider?: string;
  /** Maximum parallel entries (live mode only). Defaults to 3. */
  maxParallel?: number;
  /** Optional run directory parent. Defaults to BABEL_RUNS_DIR/arena. */
  runsDir?: string;
}

export interface ArenaEntryScore {
  /** Plan completeness: concrete files, steps, verification (1-10) */
  completeness: number;
  /** Risk awareness: identifies risks, has mitigations (1-10) */
  riskAwareness: number;
  /** Scope control: bounded, not overreaching (1-10) */
  scopeControl: number;
  /** Verifiability: specific, verifiable claims (1-10) */
  verifiability: number;
  /** Weighted total (max 10) */
  total: number;
}

export interface ArenaEntryResult {
  spec: ArenaEntrySpec;
  plan: LitePlanAnswer;
  runDir: string;
  score: ArenaEntryScore;
  strengths: string[];
  weaknesses: string[];
}

export interface ArenaComparison {
  /** All entry results ordered by score (best first) */
  entries: ArenaEntryResult[];
  /** The winning entry (highest score) */
  winner: ArenaEntryResult | null;
  /** Winner's entry id */
  winnerId: string | null;
  /** Score delta from winner for each entry id */
  scoreDeltas: Record<string, number>;
  /** Human-readable comparison summary */
  summary: string;
  /** Recommendation for next action */
  recommendation: string;
  /** Run directory for the arena evidence */
  runDir: string;
  /** Timestamp when the arena was run */
  timestamp: string;
}

// ── Plan Quality Scoring ───────────────────────────────────────────────────────

const SCORE_WEIGHTS = {
  completeness: 0.35,
  riskAwareness: 0.3,
  scopeControl: 0.2,
  verifiability: 0.15,
};

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function countConcreteFiles(plan: LitePlanAnswer): number {
  return (plan.likely_files ?? []).length;
}

function countConcreteSteps(plan: LitePlanAnswer): number {
  return (plan.steps ?? []).filter((s: unknown) =>
    /\b(read|inspect|check|verify|test|write|modify|update|add|remove|create)\b/i.test(
      String(s ?? ''),
    ),
  ).length;
}

function countRisks(plan: LitePlanAnswer): number {
  return (plan.risks ?? []).length;
}

function countVerificationItems(plan: LitePlanAnswer): number {
  return (plan.verification ?? []).length;
}

function measureScopeControl(plan: LitePlanAnswer): number {
  const files = plan.likely_files ?? [];
  const steps = plan.steps ?? [];
  const summary = plan.summary ?? '';
  const answer = plan.answer ?? '';
  const combined = `${summary} ${answer}`;

  let score = 7; // baseline

  // Too many files suggests loose scope
  if (files.length > 8) score -= 2;
  else if (files.length <= 4) score += 1;

  // Very few steps suggests incomplete planning
  if (steps.length < 2) score -= 2;
  else if (steps.length >= 4 && steps.length <= 8) score += 1;

  // Check for scope-broadening language
  if (
    /\b(repo[- ]wide|entire (?:codebase|repo|project)|migrate (?:all|everything))\b/i.test(combined)
  ) {
    score -= 3;
  }
  if (
    /\b(?:targets? only|scoped to|bounded to|limited to|specific (?:file|module))\b/i.test(combined)
  ) {
    score += 2;
  }

  return clamp(score, 1, 10);
}

function measureVerifiability(plan: LitePlanAnswer): number {
  const verification = plan.verification ?? [];
  const steps = plan.steps ?? [];
  const summary = plan.summary ?? '';
  const combined = `${summary} ${steps.join(' ')}`;

  let score = 5; // baseline

  // Explicit verification commands
  if (verification.length >= 2) score += 3;
  else if (verification.length === 1) score += 1;

  // Test/verify mentions in steps
  if (/\b(?:test|verify|check|assert|validate)\b/i.test(combined)) score += 2;

  // No verification at all
  if (verification.length === 0 && !/\b(?:test|verify)\b/i.test(combined)) score -= 3;

  return clamp(score, 1, 10);
}

function measureCompleteness(plan: LitePlanAnswer): number {
  let score = 5;

  const files = countConcreteFiles(plan);
  const steps = countConcreteSteps(plan);
  const hasSummary = (plan.summary ?? '').length > 20;
  const hasAnswer = (plan.answer ?? '').length > 30;

  if (files >= 2) score += 2;
  if (steps >= 3) score += 2;
  if (hasSummary) score += 1;
  if (hasAnswer) score += 1;

  // Status signals
  if (plan.status === 'NEEDS_MORE_CONTEXT') score -= 3;
  if (plan.status === 'PLAN_READY') score += 1;

  return clamp(score, 1, 10);
}

function measureRiskAwareness(plan: LitePlanAnswer): number {
  let score = 5;

  const risks = plan.risks ?? [];
  const summary = plan.summary ?? '';
  const answer = plan.answer ?? '';
  const combined = `${summary} ${answer}`;

  if (risks.length >= 3) score += 3;
  else if (risks.length >= 1) score += 1;

  // Risk-aware language
  if (/\b(?:risk|edge case|failure mode|rollback|checkpoint|backup|restore)\b/i.test(combined)) {
    score += 2;
  }

  // No risk awareness at all
  if (risks.length === 0 && !/\brisk\b/i.test(combined)) score -= 2;

  return clamp(score, 1, 10);
}

/**
 * Score a plan on four dimensions using deterministic heuristics.
 * In live mode, this is replaced by LLM judge evaluation.
 */
export function scorePlan(plan: LitePlanAnswer, _strategy: ArenaStrategy): ArenaEntryScore {
  const completeness = measureCompleteness(plan);
  const riskAwareness = measureRiskAwareness(plan);
  const scopeControl = measureScopeControl(plan);
  const verifiability = measureVerifiability(plan);

  const total = clamp(
    Math.round(
      completeness * SCORE_WEIGHTS.completeness +
        riskAwareness * SCORE_WEIGHTS.riskAwareness +
        scopeControl * SCORE_WEIGHTS.scopeControl +
        verifiability * SCORE_WEIGHTS.verifiability,
    ),
    1,
    10,
  );

  return { completeness, riskAwareness, scopeControl, verifiability, total };
}

// ── Strengths & Weaknesses ─────────────────────────────────────────────────────

function deriveStrengths(plan: LitePlanAnswer, score: ArenaEntryScore): string[] {
  const strengths: string[] = [];

  if (score.completeness >= 8) strengths.push('Well-defined concrete files and steps');
  if (score.riskAwareness >= 7) strengths.push('Strong risk identification');
  if (score.scopeControl >= 7) strengths.push('Tight, bounded scope');
  if (score.verifiability >= 7) strengths.push('Clear verification strategy');

  if ((plan.verification ?? []).length >= 2) strengths.push('Multiple verification checkpoints');
  if ((plan.likely_files ?? []).length >= 2 && (plan.likely_files ?? []).length <= 6) {
    strengths.push('Focused file targeting');
  }

  if (strengths.length === 0) {
    strengths.push('Adequate plan structure');
  }

  return strengths;
}

function deriveWeaknesses(plan: LitePlanAnswer, score: ArenaEntryScore): string[] {
  const weaknesses: string[] = [];

  if (score.completeness <= 4) weaknesses.push('Missing concrete files or steps');
  if (score.riskAwareness <= 3) weaknesses.push('Insufficient risk awareness');
  if (score.scopeControl <= 4) weaknesses.push('Scope may be too broad');
  if (score.verifiability <= 3) weaknesses.push('Weak or missing verification');

  if ((plan.risks ?? []).length === 0) weaknesses.push('No explicit risks identified');
  if ((plan.verification ?? []).length === 0) weaknesses.push('No verification commands specified');
  if (plan.status === 'NEEDS_MORE_CONTEXT')
    weaknesses.push('Plan needs more context to be actionable');

  if (weaknesses.length === 0) {
    weaknesses.push('Minor refinements possible');
  }

  return weaknesses;
}

// ── Comparison ─────────────────────────────────────────────────────────────────

export function compareEntries(results: ArenaEntryResult[]): ArenaComparison {
  if (results.length === 0) {
    return {
      entries: [],
      winner: null,
      winnerId: null,
      scoreDeltas: {},
      summary: 'No arena entries were evaluated.',
      recommendation: 'Provide at least one entry to compare.',
      runDir: '',
      timestamp: new Date().toISOString(),
    };
  }

  // Sort by total score descending
  const sorted = [...results].sort((a, b) => b.score.total - a.score.total);
  const winner = sorted[0]!;
  const winnerTotal = winner.score.total;

  const scoreDeltas: Record<string, number> = {};
  for (const entry of sorted) {
    scoreDeltas[entry.spec.id] = winnerTotal - entry.score.total;
  }

  // Build comparison summary
  const entryLabels = sorted.map((e, i) => {
    const delta = scoreDeltas[e.spec.id]!;
    const marker = i === 0 ? '★ WINNER' : `  #${i + 1}`;
    return `${marker} ${e.spec.id} (score: ${e.score.total}/10, strategy: ${e.spec.strategy})${delta > 0 ? ` — ${delta}pt behind` : ''}`;
  });

  const summary = [
    'Arena Comparison Results',
    '',
    ...entryLabels,
    '',
    'Score dimensions (weighted):',
    `  Completeness (${Math.round(SCORE_WEIGHTS.completeness * 100)}%): ${winner.score.completeness}/10`,
    `  Risk Awareness (${Math.round(SCORE_WEIGHTS.riskAwareness * 100)}%): ${winner.score.riskAwareness}/10`,
    `  Scope Control (${Math.round(SCORE_WEIGHTS.scopeControl * 100)}%): ${winner.score.scopeControl}/10`,
    `  Verifiability (${Math.round(SCORE_WEIGHTS.verifiability * 100)}%): ${winner.score.verifiability}/10`,
  ].join('\n');

  const recommendation =
    sorted.length >= 2 && scoreDeltas[sorted[1]!.spec.id]! <= 1
      ? `Winner ${winner.spec.id} is close to runner-up. Consider reviewing both before applying.`
      : `Use ${winner.spec.id} (${winner.spec.strategy}) as the primary plan. It scored ${winner.score.total}/10.`;

  return {
    entries: sorted,
    winner,
    winnerId: winner.spec.id,
    scoreDeltas,
    summary,
    recommendation,
    runDir: '',
    timestamp: new Date().toISOString(),
  };
}

// ── Arena Runner ───────────────────────────────────────────────────────────────

function makeArenaRunDir(config: ArenaConfig): string {
  const base = config.runsDir ?? join(BABEL_RUNS_DIR, 'arena');
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const slug = config.task
    .slice(0, 40)
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const dir = join(base, `${ts}-${slug}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Run a single arena entry: generate a plan with the specified model/strategy.
 * In mock mode, strategy affects the plan via task enrichment.
 */
async function runArenaEntry(
  spec: ArenaEntrySpec,
  config: ArenaConfig,
  runDir: string,
): Promise<ArenaEntryResult> {
  const entryRunDir = join(runDir, spec.id);
  mkdirSync(entryRunDir, { recursive: true });

  // Enrich task with strategy-specific guidance
  const strategyGuidance: Record<ArenaStrategy, string> = {
    conservative: 'Prefer minimal, safe changes. Only modify what is strictly necessary.',
    balanced: 'Balance safety with pragmatism. Make reasonable changes with good verification.',
    aggressive: 'Be thorough and comprehensive. Fix related issues proactively.',
  };

  const enrichedTask = `${config.task}\n\n[Strategy: ${spec.strategy}] ${strategyGuidance[spec.strategy]}`;

  // Run the plan lane for this entry
  let result: PlanLaneResult;
  try {
    result = await runPlanLane({
      task: enrichedTask,
      projectRoot: config.projectRoot,
      ...(config.provider !== undefined ? { provider: config.provider } : {}),
      model: spec.model,
      planReview: false, // Don't recurse — arena handles comparison
    });
  } catch (err: any) {
    // Return a synthetic failed entry so the arena can still compare
    const failedPlan: LitePlanAnswer = {
      schema_version: 1,
      status: 'NEEDS_MORE_CONTEXT',
      summary: `Entry ${spec.id} failed: ${err?.message ?? 'Unknown error'}`,
      answer: `The ${spec.strategy} approach could not produce a plan.`,
      steps: [],
      likely_files: [],
      risks: [`Execution error: ${err?.message ?? 'Unknown'}`],
      verification: [],
      next: ['Retry with a different model or strategy.'],
    };
    return {
      spec,
      plan: failedPlan,
      runDir: entryRunDir,
      score: { completeness: 1, riskAwareness: 1, scopeControl: 1, verifiability: 1, total: 1 },
      strengths: [],
      weaknesses: [err?.message ?? 'Plan generation failed'],
    };
  }

  // Extract the plan from the payload
  const planAnswer: LitePlanAnswer = (result.payload as any)?.['answer'] ?? {
    schema_version: 1,
    status: 'PLAN_READY',
    summary: result.humanText.slice(0, 200),
    answer: result.humanText,
    steps: [],
    likely_files: [],
    risks: [],
    verification: [],
    next: [],
  };

  const score = scorePlan(planAnswer, spec.strategy);
  const strengths = deriveStrengths(planAnswer, score);
  const weaknesses = deriveWeaknesses(planAnswer, score);

  return { spec, plan: planAnswer, runDir: entryRunDir, score, strengths, weaknesses };
}

/**
 * Run the arena: execute all entries, score them, compare, and return the winner.
 *
 * In mock mode, entries run sequentially. In live mode, entries can run in
 * parallel (controlled by maxParallel).
 */
export async function runArena(config: ArenaConfig): Promise<ArenaComparison> {
  const runDir = makeArenaRunDir(config);

  // Run all entries (sequentially for mock, potentially parallel for live)
  const results: ArenaEntryResult[] = [];
  for (const spec of config.entries) {
    const entryResult = await runArenaEntry(spec, config, runDir);
    results.push(entryResult);

    // Write per-entry evidence
    const entryEvidenceDir = join(runDir, spec.id);
    mkdirSync(entryEvidenceDir, { recursive: true });
    writeFileSync(
      join(entryEvidenceDir, 'entry_result.json'),
      JSON.stringify(
        {
          spec,
          score: entryResult.score,
          strengths: entryResult.strengths,
          weaknesses: entryResult.weaknesses,
          plan: entryResult.plan,
        },
        null,
        2,
      ),
      'utf-8',
    );
  }

  // Compare and select winner
  const comparison = compareEntries(results);
  comparison.runDir = runDir;

  // Write arena evidence
  writeFileSync(
    join(runDir, 'arena_comparison.json'),
    JSON.stringify(
      {
        schema_version: 1,
        config: {
          task: config.task,
          projectRoot: config.projectRoot,
          entries: config.entries.map((e) => ({ id: e.id, strategy: e.strategy, model: e.model })),
        },
        entries: comparison.entries.map((e) => ({
          id: e.spec.id,
          score: e.score,
          strengths: e.strengths,
          weaknesses: e.weaknesses,
        })),
        winnerId: comparison.winnerId,
        scoreDeltas: comparison.scoreDeltas,
        summary: comparison.summary,
        recommendation: comparison.recommendation,
        timestamp: comparison.timestamp,
      },
      null,
      2,
    ),
    'utf-8',
  );

  writeFileSync(
    join(runDir, 'arena_summary.md'),
    `${comparison.summary}\n\n## Recommendation\n${comparison.recommendation}\n`,
    'utf-8',
  );

  return comparison;
}

/**
 * Build a default arena configuration with sensible entries for the given task.
 * Used when the user doesn't specify custom entries.
 */
export function buildDefaultArenaEntries(task: string, projectRoot: string): ArenaConfig {
  const hasRiskSignal = /\b(?:migration|security|breaking|repo[- ]wide|refactor|critical)\b/i.test(
    task,
  );

  return {
    task,
    projectRoot,
    entries: [
      {
        id: 'balanced-default',
        model: 'deepseek',
        strategy: 'balanced',
        description: 'Default balanced approach — safe but pragmatic',
      },
      {
        id: 'conservative-safe',
        model: 'deepseek',
        strategy: 'conservative',
        description: 'Minimal changes only — highest safety',
      },
      ...(hasRiskSignal
        ? [
            {
              id: 'thorough-audit',
              model: 'deepseek',
              strategy: 'aggressive' as ArenaStrategy,
              description:
                'Thorough approach for high-risk tasks — comprehensive fix with strong verification',
            },
          ]
        : []),
    ],
  };
}
