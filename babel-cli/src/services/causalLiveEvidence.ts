/**
 * Slice 7 — Live causal evidence harness (offline analysis + canary plan freeze).
 *
 * Goal: produce **valuable improvement data** for chat-headless — not vanity pass%.
 * Small-N paired counts only; no generalized suppression rate.
 *
 * Pure analysis is network-free: loads campaign artifacts + live cells + policy events.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { computeHarnessBoundaryCounters } from '../agent/chatEngineObservability.js';
import { CAUSAL_SCORER_VERSION } from './causalCampaignContract.js';

// ─── Predeclared analysis plan ───────────────────────────────────────────────

/**
 * Frozen canary design for the first live spend gate.
 * Product arm only (babel_enforce) for cost control.
 */
export const LIVE_CANARY_PLAN = {
  n_tasks: 1,
  model: 'deepseek-v4-flash',
  mode: 'chat-headless',
  arms_live: ['babel_enforce'] as const,
  replicates: 1,
  early_stop: 5,
  agent_timeout_ms: 1_500_000,
  stopping_rules: 'single_task_one_replicate; stop after cell terminal or harness timeout',
  metrics: [
    'execution_terminal',
    'patch_bytes',
    'host_fail_to_pass_class',
    'effort_requested_sent_observed',
    'effort_aliased',
    'boundary_force_mutate_*',
    'turns_to_first_write',
    'successful_write_tool_count',
    'budget_signature',
    'derived_eligibility',
  ],
  note: 'Small-N paired counts only; no generalized suppression rate. Official evaluator optional.',
} as const;

export type LiveCanaryPlanDefaults = typeof LIVE_CANARY_PLAN;

export const LIVE_CANARY_PLAN_KIND = 'babel_live_canary_plan' as const;
export const IMPROVEMENT_LEDGER_KIND = 'babel_live_improvement_ledger' as const;
export const LIVE_EVIDENCE_SCORER_VERSION = 'live-evidence-scorer-v1' as const;
export const LIVE_SPEND_AUTHORIZE_FLAG = '--i-authorize-live-spend' as const;

export const LIVE_CANARY_PLAN_FILENAME = 'live-canary-plan.json';
export const IMPROVEMENT_LEDGER_FILENAME = 'improvement-ledger.json';
export const IMPROVEMENT_LEDGER_MD_FILENAME = 'improvement-ledger.md';

// ─── Plan freeze ─────────────────────────────────────────────────────────────

export type LiveCanaryPlanOverrides = Partial<{
  n_tasks: number;
  model: string;
  mode: string;
  arms_live: readonly string[];
  replicates: number;
  early_stop: number;
  agent_timeout_ms: number;
  stopping_rules: string;
  metrics: readonly string[];
  note: string;
  frozen_at: string;
}>;

export type LiveCanaryPlanFrozen = {
  schema_version: 1;
  kind: typeof LIVE_CANARY_PLAN_KIND;
  frozen_at: string;
  plan: {
    n_tasks: number;
    model: string;
    mode: string;
    arms_live: string[];
    replicates: number;
    early_stop: number;
    agent_timeout_ms: number;
    stopping_rules: string;
    metrics: string[];
    note: string;
  };
  overrides_applied: string[];
};

/**
 * Freeze the predeclared canary plan (optionally with operator overrides).
 * Written to evidence dir as `live-canary-plan.json` before spend.
 */
export function buildLiveCanaryPlan(overrides?: LiveCanaryPlanOverrides): LiveCanaryPlanFrozen {
  const overrides_applied: string[] = [];
  const base = LIVE_CANARY_PLAN;
  const pick = <K extends keyof LiveCanaryPlanOverrides>(
    key: K,
    fallback: NonNullable<LiveCanaryPlanOverrides[K]>,
  ): NonNullable<LiveCanaryPlanOverrides[K]> => {
    if (overrides && overrides[key] !== undefined) {
      overrides_applied.push(String(key));
      return overrides[key] as NonNullable<LiveCanaryPlanOverrides[K]>;
    }
    return fallback;
  };

  return {
    schema_version: 1,
    kind: LIVE_CANARY_PLAN_KIND,
    frozen_at: overrides?.frozen_at ?? new Date().toISOString(),
    plan: {
      n_tasks: pick('n_tasks', base.n_tasks) as number,
      model: pick('model', base.model) as string,
      mode: pick('mode', base.mode) as string,
      arms_live: [...(pick('arms_live', base.arms_live) as readonly string[])],
      replicates: pick('replicates', base.replicates) as number,
      early_stop: pick('early_stop', base.early_stop) as number,
      agent_timeout_ms: pick('agent_timeout_ms', base.agent_timeout_ms) as number,
      stopping_rules: pick('stopping_rules', base.stopping_rules) as string,
      metrics: [...(pick('metrics', base.metrics) as readonly string[])],
      note: pick('note', base.note) as string,
    },
    overrides_applied,
  };
}

/** Persist frozen plan under evidence dir. Returns absolute path written. */
export function writeLiveCanaryPlan(evidenceDir: string, plan: LiveCanaryPlanFrozen): string {
  mkdirSync(evidenceDir, { recursive: true });
  const path = join(evidenceDir, LIVE_CANARY_PLAN_FILENAME);
  writeFileSync(path, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
  return path;
}

// ─── Live spend gate ─────────────────────────────────────────────────────────

/** True when argv contains the explicit live-spend authorization flag. */
export function hasLiveSpendAuthorization(argv: readonly string[]): boolean {
  return argv.includes(LIVE_SPEND_AUTHORIZE_FLAG);
}

/**
 * CLI-level check: refuse live without authorize.
 * Returns null when authorized; otherwise a redacted refusal message (no keys).
 */
export function checkLiveSpendAuthorization(argv: readonly string[]): string | null {
  if (hasLiveSpendAuthorization(argv)) return null;
  return (
    `Refusing live causal canary: missing ${LIVE_SPEND_AUTHORIZE_FLAG}. ` +
    'This run spends API budget on a live model. Pass the flag explicitly after reviewing cost risk.'
  );
}

// ─── Ledger types ────────────────────────────────────────────────────────────

export type HypothesisSeverity = 'high' | 'medium' | 'low';

export interface ImprovementHypothesis {
  rank: number;
  id: string;
  summary: string;
  severity: HypothesisSeverity;
  /** Instance ids / signatures / source files supporting this hypothesis. */
  evidence_refs: string[];
  /** Small-N count only — not a rate claim. */
  supporting_cell_count: number;
}

export interface LiveCellSummary {
  instance_id: string;
  phase: string;
  status: string | null;
  signature: string | null;
  patch_bytes: number;
  fail_to_pass_class: string | null;
  fail_to_pass_ok: boolean | null;
  /** Gold multi-file PR similarity — diagnostic only, never sole capability. */
  gold_diff_ok: boolean | null;
  force_mutate_count: number;
  force_mutate_shadow_count: number;
  zero_write_shadow_count: number;
  zero_write_hard_stop_count: number;
  successful_write_tool_count: number;
  turns_to_first_write: number | null;
  effort_aliased: boolean | null;
  effort_requested: string | null;
  effort_sent: string | null;
  effort_observed: string | null;
  budget_signature: string | null;
  source: string;
}

export interface ImprovementLedger {
  schema_version: 1;
  kind: typeof IMPROVEMENT_LEDGER_KIND;
  scorer_version: string;
  /** Cross-link to Stage 1 causal scorer when derived eligibility was loaded. */
  causal_scorer_version: string;
  n: number;
  uncertainty_note: string;
  generated_at: string;
  evidence_dir: string;
  sources_present: {
    campaign_manifest: boolean;
    campaign_report: boolean;
    campaign_derived: boolean;
    reconcile_report: boolean;
    live_cells: number;
    policy_events_jsonl: boolean;
    live_canary_plan: boolean;
  };
  signatures_histogram: Record<string, number>;
  patch_bytes: {
    total: number;
    live_cells: number;
    zero_patch_cells: number;
    zero_patch_rate: number | null;
  };
  host_fail_to_pass_classes: Record<string, number>;
  force_mutate_signals: {
    force_mutate_total: number;
    force_mutate_shadow_total: number;
    zero_write_shadow_total: number;
    zero_write_hard_stop_total: number;
    cells_with_force_mutate_shadow: number;
    cells_zero_patch_and_force_mutate_shadow: number;
  };
  effort: {
    cells_with_effort_telemetry: number;
    cells_effort_aliased: number;
    requested_sent_observed: Array<{
      instance_id: string;
      requested: string | null;
      sent: string | null;
      observed: string | null;
      aliased: boolean | null;
    }>;
  };
  boundary_aggregate: {
    successful_write_tool_count: number;
    turns_to_first_write_min: number | null;
    turns_to_first_write_samples: number[];
  };
  budget_signatures: Record<string, number>;
  derived_eligibility: {
    artifact_valid: boolean | null;
    campaign_complete: boolean | null;
    reliability_eligible: boolean | null;
    promotion_eligible: boolean | null;
    capability_score_valid: boolean | null;
    notes: string[];
  } | null;
  cell_summaries: LiveCellSummary[];
  hypotheses: ImprovementHypothesis[];
  metrics_plan: string[];
}

// ─── Internal loaders ────────────────────────────────────────────────────────

type LooseCell = {
  instance_id?: string;
  phase?: string;
  status?: string;
  signature?: string;
  patch_bytes?: number;
  gold_diff_ok?: boolean | null;
  fail_to_pass_ok?: boolean | null;
  fail_to_pass_class?: string | null;
  notes?: string[];
  policy_events?: Array<{ kind?: string; at_turn?: number; detail?: string }>;
  telemetry?: {
    effort?: {
      effort_aliased?: boolean;
      requested_reasoning_effort?: string | null;
      sent_reasoning_effort?: string | null;
      observed_reasoning_effort?: string | null;
    };
    boundary?: {
      force_mutate_count?: number;
      force_mutate_shadow_count?: number;
      zero_write_shadow_count?: number;
      zero_write_hard_stop_count?: number;
      successful_write_tool_count?: number;
      turns_to_first_applied_write?: number | null;
    };
  };
  status_text?: string | null;
  cli_payload?: Record<string, unknown>;
};

function safeReadJson(path: string): unknown | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

function loadPolicyEventsJsonl(path: string): Array<{ kind?: string; at_turn?: number; detail?: string }> {
  if (!existsSync(path)) return [];
  const out: Array<{ kind?: string; at_turn?: number; detail?: string }> = [];
  try {
    const text = readFileSync(path, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t) as { kind?: string; at_turn?: number; detail?: string });
      } catch {
        /* skip corrupt line */
      }
    }
  } catch {
    /* ignore */
  }
  return out;
}

function isLivePhase(phase: string | undefined): boolean {
  return phase === 'live' || phase === undefined || phase === '';
}

function loadLiveCells(evidenceDir: string): Array<LooseCell & { _source: string }> {
  const byKey = new Map<string, LooseCell & { _source: string }>();

  const reportPath = join(evidenceDir, 'campaign-report.json');
  const report = safeReadJson(reportPath) as { cells?: LooseCell[] } | null;
  if (report?.cells && Array.isArray(report.cells)) {
    for (const c of report.cells) {
      if (!c.instance_id) continue;
      if (!isLivePhase(c.phase) && c.phase !== 'live') continue;
      if (c.phase !== 'live') continue;
      byKey.set(c.instance_id, { ...c, _source: 'campaign-report.json' });
    }
  }

  const liveDir = join(evidenceDir, 'live');
  if (existsSync(liveDir)) {
    for (const name of readdirSync(liveDir)) {
      if (!name.endsWith('.json')) continue;
      if (name.endsWith('.failure-capsule.json')) continue;
      if (name.endsWith('.policy-events.jsonl')) continue;
      const path = join(liveDir, name);
      const raw = safeReadJson(path) as LooseCell | null;
      if (!raw?.instance_id) continue;
      // Prefer richer live cell files over report row when both exist
      const prev = byKey.get(raw.instance_id);
      const hasTelemetry = Boolean(raw.telemetry);
      const prevHasTelemetry = Boolean(prev?.telemetry);
      if (!prev || (hasTelemetry && !prevHasTelemetry) || (raw.policy_events?.length ?? 0) > (prev.policy_events?.length ?? 0)) {
        byKey.set(raw.instance_id, { ...raw, phase: raw.phase ?? 'live', _source: `live/${name}` });
      }
    }
  }

  return [...byKey.values()];
}

function noteValue(notes: string[] | undefined, key: string): string | null {
  if (!notes) return null;
  const prefix = `${key}=`;
  for (const n of notes) {
    if (n.startsWith(prefix)) return n.slice(prefix.length);
  }
  return null;
}

function resolvePolicyEvents(
  cell: LooseCell,
  evidenceDir: string,
  rootPolicyEvents: Array<{ kind?: string; at_turn?: number; detail?: string }>,
): Array<{ kind?: string; at_turn?: number; detail?: string }> {
  if (Array.isArray(cell.policy_events) && cell.policy_events.length > 0) {
    return cell.policy_events;
  }
  if (cell.instance_id) {
    const perCell = join(evidenceDir, 'live', `${cell.instance_id}.policy-events.jsonl`);
    const fromFile = loadPolicyEventsJsonl(perCell);
    if (fromFile.length > 0) return fromFile;
  }
  // Fall back to root policy-events only when single live cell (avoid mixing multi-task)
  return rootPolicyEvents;
}

function budgetSignatureFromCell(cell: LooseCell, signature: string | null): string | null {
  if (signature && /budget/i.test(signature)) return signature;
  const status = cell.status_text ?? noteValue(cell.notes, 'status');
  if (status && /budget/i.test(status)) return `status:${status}`;
  const terminal = noteValue(cell.notes, 'terminal_outcome');
  if (terminal && /budget/i.test(terminal)) return `terminal:${terminal}`;
  return signature && /budget|timeout|exhausted/i.test(signature) ? signature : null;
}

function summarizeCell(
  cell: LooseCell & { _source: string },
  evidenceDir: string,
  rootPolicyEvents: Array<{ kind?: string; at_turn?: number; detail?: string }>,
): LiveCellSummary {
  const events = resolvePolicyEvents(cell, evidenceDir, rootPolicyEvents);
  const boundaryFromTelemetry = cell.telemetry?.boundary;
  const cellToolCalls = (cell as unknown as { toolCalls?: unknown }).toolCalls;
  const payloadToolCalls = cell.cli_payload?.['toolCalls'];
  const toolCalls: Array<{ tool?: string; error?: string; exit_code?: number; index?: number }> =
    Array.isArray(cellToolCalls)
      ? (cellToolCalls as Array<{ tool?: string; error?: string; exit_code?: number; index?: number }>)
      : Array.isArray(payloadToolCalls)
        ? (payloadToolCalls as Array<{ tool?: string; error?: string; exit_code?: number; index?: number }>)
        : [];
  const recomputed = computeHarnessBoundaryCounters({
    policyEvents: events,
    toolCalls,
  });

  const force_mutate_count =
    boundaryFromTelemetry?.force_mutate_count ?? recomputed.force_mutate_count;
  const force_mutate_shadow_count =
    boundaryFromTelemetry?.force_mutate_shadow_count ?? recomputed.force_mutate_shadow_count;
  const zero_write_shadow_count =
    boundaryFromTelemetry?.zero_write_shadow_count ?? recomputed.zero_write_shadow_count;
  const zero_write_hard_stop_count =
    boundaryFromTelemetry?.zero_write_hard_stop_count ?? recomputed.zero_write_hard_stop_count;
  const successful_write_tool_count =
    boundaryFromTelemetry?.successful_write_tool_count ?? recomputed.successful_write_tool_count;
  const turns_to_first_write =
    boundaryFromTelemetry?.turns_to_first_applied_write ?? recomputed.turns_to_first_applied_write;

  const effort = cell.telemetry?.effort;
  let effort_aliased: boolean | null = effort?.effort_aliased ?? null;
  if (effort_aliased == null) {
    const note = noteValue(cell.notes, 'effort_aliased');
    if (note === 'true') effort_aliased = true;
    else if (note === 'false') effort_aliased = false;
  }

  const signature = cell.signature ?? null;
  return {
    instance_id: cell.instance_id ?? 'unknown',
    phase: cell.phase ?? 'live',
    status: cell.status ?? null,
    signature,
    patch_bytes: typeof cell.patch_bytes === 'number' ? cell.patch_bytes : 0,
    fail_to_pass_class: cell.fail_to_pass_class ?? noteValue(cell.notes, 'fail_to_pass_class'),
    fail_to_pass_ok:
      typeof cell.fail_to_pass_ok === 'boolean'
        ? cell.fail_to_pass_ok
        : noteValue(cell.notes, 'fail_to_pass_ok') === 'true'
          ? true
          : noteValue(cell.notes, 'fail_to_pass_ok') === 'false'
            ? false
            : null,
    gold_diff_ok:
      typeof cell.gold_diff_ok === 'boolean'
        ? cell.gold_diff_ok
        : noteValue(cell.notes, 'gold_diff') === 'true'
          ? true
          : noteValue(cell.notes, 'gold_diff') === 'false'
            ? false
            : null,
    force_mutate_count,
    force_mutate_shadow_count,
    zero_write_shadow_count,
    zero_write_hard_stop_count,
    successful_write_tool_count,
    turns_to_first_write,
    effort_aliased,
    effort_requested: effort?.requested_reasoning_effort ?? null,
    effort_sent: effort?.sent_reasoning_effort ?? null,
    effort_observed: effort?.observed_reasoning_effort ?? null,
    budget_signature: budgetSignatureFromCell(cell, signature),
    source: cell._source,
  };
}

function increment(hist: Record<string, number>, key: string): void {
  hist[key] = (hist[key] ?? 0) + 1;
}

/**
 * Rank concrete next-fix hypotheses from small-N cell evidence.
 * Counts only — never claims a generalized suppression rate.
 */
export function rankImprovementHypotheses(cells: LiveCellSummary[]): ImprovementHypothesis[] {
  const out: ImprovementHypothesis[] = [];

  const zeroPatchShadow = cells.filter(
    (c) => c.patch_bytes === 0 && c.force_mutate_shadow_count > 0,
  );
  if (zeroPatchShadow.length > 0) {
    out.push({
      rank: 0,
      id: 'zero_patch_force_mutate_shadow_thrash',
      summary:
        'zero patch + force_mutate_shadow present → progress/prompt thrash ' +
        '(mutate nudges fired in shadow/live but no durable git patch)',
      severity: 'high',
      evidence_refs: zeroPatchShadow.map((c) => `${c.instance_id}:${c.signature ?? 'nosig'}`),
      supporting_cell_count: zeroPatchShadow.length,
    });
  }

  const zeroPatchManyForce = cells.filter(
    (c) => c.patch_bytes === 0 && c.force_mutate_count >= 3 && c.force_mutate_shadow_count === 0,
  );
  if (zeroPatchManyForce.length > 0) {
    out.push({
      rank: 0,
      id: 'zero_patch_force_mutate_loop',
      summary:
        'zero patch + repeated force_mutate (≥3) without shadow → policy thrash loop; ' +
        'investigate write-tool success vs model ignore of mutate prompts',
      severity: 'high',
      evidence_refs: zeroPatchManyForce.map((c) => `${c.instance_id}:force_mutate×${c.force_mutate_count}`),
      supporting_cell_count: zeroPatchManyForce.length,
    });
  }

  const zeroWriteShadow = cells.filter(
    (c) => c.patch_bytes === 0 && c.zero_write_shadow_count > 0,
  );
  if (zeroWriteShadow.length > 0) {
    out.push({
      rank: 0,
      id: 'zero_write_shadow_without_patch',
      summary:
        'zero_write_shadow fired with empty patch → hard-stop shadow threshold reached; ' +
        'check whether live hard-stop should arm earlier or mutate tools are broken',
      severity: 'high',
      evidence_refs: zeroWriteShadow.map((c) => `${c.instance_id}:zero_write_shadow`),
      supporting_cell_count: zeroWriteShadow.length,
    });
  }

  const budgetZero = cells.filter(
    (c) => c.patch_bytes === 0 && c.budget_signature != null,
  );
  if (budgetZero.length > 0) {
    out.push({
      rank: 0,
      id: 'budget_exhausted_zero_patch',
      summary:
        'budget/timeout terminal with zero patch → spend bought exploration only; ' +
        'raise TTF-write priority or tighten investigate budget for general_swe',
      severity: 'high',
      evidence_refs: budgetZero.map((c) => `${c.instance_id}:${c.budget_signature}`),
      supporting_cell_count: budgetZero.length,
    });
  }

  const writesNoPatch = cells.filter(
    (c) => c.patch_bytes === 0 && c.successful_write_tool_count > 0,
  );
  if (writesNoPatch.length > 0) {
    out.push({
      rank: 0,
      id: 'writes_without_git_patch',
      summary:
        'successful_write_tool_count > 0 but patch_bytes=0 → workspace/git capture gap ' +
        'or writes outside tracked tree; verify patch capture + worktree isolation',
      severity: 'medium',
      evidence_refs: writesNoPatch.map(
        (c) => `${c.instance_id}:writes=${c.successful_write_tool_count}`,
      ),
      supporting_cell_count: writesNoPatch.length,
    });
  }

  const assertFailWithPatch = cells.filter(
    (c) => c.patch_bytes > 0 && c.fail_to_pass_class === 'assert_fail',
  );
  if (assertFailWithPatch.length > 0) {
    out.push({
      rank: 0,
      id: 'patch_present_assert_fail',
      summary:
        'non-zero patch + host assert_fail → localization/fix quality issue (not harness thrash); ' +
        'pair with gold diagnostic and verifier logs',
      severity: 'medium',
      evidence_refs: assertFailWithPatch.map((c) => `${c.instance_id}:patch=${c.patch_bytes}`),
      supporting_cell_count: assertFailWithPatch.length,
    });
  }

  // Gold multi-file PR mismatch while host FTP passes is expected product signal, not thrash.
  const goldFtpGap = cells.filter(
    (c) =>
      c.patch_bytes > 0 &&
      c.fail_to_pass_class === 'pass' &&
      (c.gold_diff_ok === false || c.gold_diff_ok === null),
  );
  if (goldFtpGap.length > 0) {
    out.push({
      rank: 0,
      id: 'gold_ftp_gap_diagnostic',
      summary:
        'host fail_to_pass pass with gold_diff false/null → product capability primary is host FTP; ' +
        'gold is multi-file PR diagnostic only (do not treat gold miss as thrash or capability fail)',
      severity: 'low',
      evidence_refs: goldFtpGap.map(
        (c) => `${c.instance_id}:ftp=pass gold=${String(c.gold_diff_ok)} patch=${c.patch_bytes}`,
      ),
      supporting_cell_count: goldFtpGap.length,
    });
  }

  const envish = cells.filter((c) =>
    ['collect_error', 'env_error', 'timeout', 'skipped'].includes(c.fail_to_pass_class ?? ''),
  );
  if (envish.length > 0) {
    out.push({
      rank: 0,
      id: 'host_ftp_environment_class',
      summary:
        'host fail_to_pass class is collect/env/timeout/skipped → environment or verifier setup, ' +
        'not model capability; fix deps/overlays before causal rate claims',
      severity: 'medium',
      evidence_refs: envish.map((c) => `${c.instance_id}:${c.fail_to_pass_class}`),
      supporting_cell_count: envish.length,
    });
  }

  const aliased = cells.filter((c) => c.effort_aliased === true);
  if (aliased.length > 0) {
    out.push({
      rank: 0,
      id: 'effort_aliased_routing',
      summary:
        'effort_aliased=true (requested ≠ sent) → confirm intentional effort routing vs silent downgrade; ' +
        'log requested/sent/observed in next cell rollups',
      severity: 'low',
      evidence_refs: aliased.map(
        (c) =>
          `${c.instance_id}:req=${c.effort_requested ?? '?'}→sent=${c.effort_sent ?? '?'}`,
      ),
      supporting_cell_count: aliased.length,
    });
  }

  const lateWrite = cells.filter(
    (c) => c.turns_to_first_write != null && c.turns_to_first_write >= 8,
  );
  if (lateWrite.length > 0) {
    out.push({
      rank: 0,
      id: 'late_first_write',
      summary:
        'turns_to_first_write ≥ 8 → investigate budget / read thrash before mutate; ' +
        'compare force_mutate arm timing vs product prompt',
      severity: 'medium',
      evidence_refs: lateWrite.map((c) => `${c.instance_id}:ttf_write=${c.turns_to_first_write}`),
      supporting_cell_count: lateWrite.length,
    });
  }

  // Stable ranking: severity → explicit fix-priority → supporting count → id
  const severityOrder: Record<HypothesisSeverity, number> = { high: 0, medium: 1, low: 2 };
  const idPriority: Record<string, number> = {
    zero_patch_force_mutate_shadow_thrash: 0,
    zero_patch_force_mutate_loop: 1,
    zero_write_shadow_without_patch: 2,
    budget_exhausted_zero_patch: 3,
    writes_without_git_patch: 4,
    late_first_write: 5,
    patch_present_assert_fail: 6,
    host_ftp_environment_class: 7,
    gold_ftp_gap_diagnostic: 8,
    effort_aliased_routing: 9,
  };
  out.sort((a, b) => {
    const s = severityOrder[a.severity] - severityOrder[b.severity];
    if (s !== 0) return s;
    const pa = idPriority[a.id] ?? 50;
    const pb = idPriority[b.id] ?? 50;
    if (pa !== pb) return pa - pb;
    if (b.supporting_cell_count !== a.supporting_cell_count) {
      return b.supporting_cell_count - a.supporting_cell_count;
    }
    return a.id.localeCompare(b.id);
  });
  return out.map((h, i) => ({ ...h, rank: i + 1 }));
}

// ─── Public analysis API ─────────────────────────────────────────────────────

/**
 * Offline analysis of a campaign evidence directory.
 * No network. Tolerates partial artifacts (gate0-canary without campaign-manifest).
 */
export function analyzeLiveEvidenceDir(evidenceDir: string): ImprovementLedger {
  const abs = evidenceDir;
  const sources_present = {
    campaign_manifest: existsSync(join(abs, 'campaign-manifest.json')),
    campaign_report: existsSync(join(abs, 'campaign-report.json')),
    campaign_derived: existsSync(join(abs, 'campaign-derived.json')),
    reconcile_report: existsSync(join(abs, 'reconcile-report.json')),
    live_cells: 0,
    policy_events_jsonl: existsSync(join(abs, 'policy-events.jsonl')),
    live_canary_plan: existsSync(join(abs, LIVE_CANARY_PLAN_FILENAME)),
  };

  const rootPolicyEvents = loadPolicyEventsJsonl(join(abs, 'policy-events.jsonl'));
  const liveCells = loadLiveCells(abs);
  sources_present.live_cells = liveCells.length;

  const cell_summaries = liveCells.map((c) => summarizeCell(c, abs, rootPolicyEvents));

  const signatures_histogram: Record<string, number> = {};
  const host_fail_to_pass_classes: Record<string, number> = {};
  const budget_signatures: Record<string, number> = {};
  let patchTotal = 0;
  let zeroPatch = 0;
  let forceMutateTotal = 0;
  let forceMutateShadowTotal = 0;
  let zeroWriteShadowTotal = 0;
  let zeroWriteHardStopTotal = 0;
  let cellsWithShadow = 0;
  let cellsZeroAndShadow = 0;
  let writeTools = 0;
  const ttfSamples: number[] = [];
  let cellsWithEffort = 0;
  let cellsAliased = 0;
  const effortSamples: ImprovementLedger['effort']['requested_sent_observed'] = [];

  for (const c of cell_summaries) {
    increment(signatures_histogram, c.signature ?? 'null');
    if (c.fail_to_pass_class) increment(host_fail_to_pass_classes, c.fail_to_pass_class);
    if (c.budget_signature) increment(budget_signatures, c.budget_signature);
    patchTotal += c.patch_bytes;
    if (c.patch_bytes === 0) zeroPatch += 1;
    forceMutateTotal += c.force_mutate_count;
    forceMutateShadowTotal += c.force_mutate_shadow_count;
    zeroWriteShadowTotal += c.zero_write_shadow_count;
    zeroWriteHardStopTotal += c.zero_write_hard_stop_count;
    if (c.force_mutate_shadow_count > 0) cellsWithShadow += 1;
    if (c.patch_bytes === 0 && c.force_mutate_shadow_count > 0) cellsZeroAndShadow += 1;
    writeTools += c.successful_write_tool_count;
    if (c.turns_to_first_write != null) ttfSamples.push(c.turns_to_first_write);
    if (
      c.effort_aliased != null ||
      c.effort_requested != null ||
      c.effort_sent != null ||
      c.effort_observed != null
    ) {
      cellsWithEffort += 1;
      effortSamples.push({
        instance_id: c.instance_id,
        requested: c.effort_requested,
        sent: c.effort_sent,
        observed: c.effort_observed,
        aliased: c.effort_aliased,
      });
    }
    if (c.effort_aliased === true) cellsAliased += 1;
  }

  const n = cell_summaries.length;
  let derived_eligibility: ImprovementLedger['derived_eligibility'] = null;
  const derivedRaw = safeReadJson(join(abs, 'campaign-derived.json')) as {
    eligibility?: {
      artifact_valid?: boolean;
      campaign_complete?: boolean;
      reliability_eligible?: boolean;
      promotion_eligible?: boolean;
      capability_score_valid?: boolean;
    };
    notes?: string[];
    scorer_version?: string;
  } | null;
  if (derivedRaw?.eligibility) {
    derived_eligibility = {
      artifact_valid: derivedRaw.eligibility.artifact_valid ?? null,
      campaign_complete: derivedRaw.eligibility.campaign_complete ?? null,
      reliability_eligible: derivedRaw.eligibility.reliability_eligible ?? null,
      promotion_eligible: derivedRaw.eligibility.promotion_eligible ?? null,
      capability_score_valid: derivedRaw.eligibility.capability_score_valid ?? null,
      notes: Array.isArray(derivedRaw.notes) ? derivedRaw.notes : [],
    };
  }

  // Also surface reconcile presence in notes path (loaded for completeness)
  const reconcile = safeReadJson(join(abs, 'reconcile-report.json'));
  if (reconcile && derived_eligibility) {
    derived_eligibility.notes = [
      ...derived_eligibility.notes,
      'reconcile-report.json present',
    ];
  } else if (reconcile && !derived_eligibility) {
    derived_eligibility = {
      artifact_valid: null,
      campaign_complete: null,
      reliability_eligible: null,
      promotion_eligible: null,
      capability_score_valid: null,
      notes: ['reconcile-report.json present; campaign-derived.json absent'],
    };
  }

  const hypotheses = rankImprovementHypotheses(cell_summaries);

  const uncertainty_note =
    n < 5
      ? `Small-N (n=${n}): counts and ranked hypotheses only — do not generalize pass% or suppression rates.`
      : `n=${n}: still treat rates as provisional until multi-arm Stage 1 eligibility gates pass.`;

  return {
    schema_version: 1,
    kind: IMPROVEMENT_LEDGER_KIND,
    scorer_version: LIVE_EVIDENCE_SCORER_VERSION,
    causal_scorer_version: CAUSAL_SCORER_VERSION,
    n,
    uncertainty_note,
    generated_at: new Date().toISOString(),
    evidence_dir: abs,
    sources_present,
    signatures_histogram,
    patch_bytes: {
      total: patchTotal,
      live_cells: n,
      zero_patch_cells: zeroPatch,
      zero_patch_rate: n > 0 ? zeroPatch / n : null,
    },
    host_fail_to_pass_classes,
    force_mutate_signals: {
      force_mutate_total: forceMutateTotal,
      force_mutate_shadow_total: forceMutateShadowTotal,
      zero_write_shadow_total: zeroWriteShadowTotal,
      zero_write_hard_stop_total: zeroWriteHardStopTotal,
      cells_with_force_mutate_shadow: cellsWithShadow,
      cells_zero_patch_and_force_mutate_shadow: cellsZeroAndShadow,
    },
    effort: {
      cells_with_effort_telemetry: cellsWithEffort,
      cells_effort_aliased: cellsAliased,
      requested_sent_observed: effortSamples,
    },
    boundary_aggregate: {
      successful_write_tool_count: writeTools,
      turns_to_first_write_min: ttfSamples.length > 0 ? Math.min(...ttfSamples) : null,
      turns_to_first_write_samples: ttfSamples,
    },
    budget_signatures,
    derived_eligibility,
    cell_summaries,
    hypotheses,
    metrics_plan: [...LIVE_CANARY_PLAN.metrics],
  };
}

/**
 * Format a redacted markdown summary (no keys, no raw prompts).
 */
export function formatImprovementLedgerMarkdown(ledger: ImprovementLedger): string {
  const lines: string[] = [
    '# Live causal improvement ledger',
    '',
    `- scorer: \`${ledger.scorer_version}\` (schema ${ledger.schema_version})`,
    `- n live cells: **${ledger.n}**`,
    `- uncertainty: ${ledger.uncertainty_note}`,
    `- evidence_dir: \`${ledger.evidence_dir}\``,
    '',
    '## Sources present',
    '',
    '```',
    JSON.stringify(ledger.sources_present, null, 2),
    '```',
    '',
    '## Signatures histogram',
    '',
  ];

  for (const [sig, count] of Object.entries(ledger.signatures_histogram).sort((a, b) => b[1] - a[1])) {
    lines.push(`- \`${sig}\`: ${count}`);
  }
  if (Object.keys(ledger.signatures_histogram).length === 0) {
    lines.push('- _(none)_');
  }

  lines.push(
    '',
    '## Patch bytes',
    '',
    `- total: ${ledger.patch_bytes.total}`,
    `- zero-patch cells: ${ledger.patch_bytes.zero_patch_cells} / ${ledger.patch_bytes.live_cells}`,
    `- zero-patch rate (small-N): ${ledger.patch_bytes.zero_patch_rate ?? 'n/a'}`,
    '',
    '## Force-mutate / zero-write signals',
    '',
    `- force_mutate total: ${ledger.force_mutate_signals.force_mutate_total}`,
    `- force_mutate_shadow total: ${ledger.force_mutate_signals.force_mutate_shadow_total}`,
    `- zero_write_shadow total: ${ledger.force_mutate_signals.zero_write_shadow_total}`,
    `- cells zero-patch ∧ force_mutate_shadow: ${ledger.force_mutate_signals.cells_zero_patch_and_force_mutate_shadow}`,
    '',
    '## Host fail_to_pass classes',
    '',
  );
  for (const [cls, count] of Object.entries(ledger.host_fail_to_pass_classes)) {
    lines.push(`- \`${cls}\`: ${count}`);
  }
  if (Object.keys(ledger.host_fail_to_pass_classes).length === 0) {
    lines.push('- _(none)_');
  }

  lines.push('', '## Effort (requested / sent / observed)', '');
  lines.push(
    `- cells with effort telemetry: ${ledger.effort.cells_with_effort_telemetry}`,
    `- cells effort_aliased: ${ledger.effort.cells_effort_aliased}`,
  );
  for (const e of ledger.effort.requested_sent_observed) {
    lines.push(
      `- \`${e.instance_id}\`: req=${e.requested ?? 'null'} sent=${e.sent ?? 'null'} obs=${e.observed ?? 'null'} aliased=${e.aliased}`,
    );
  }

  lines.push(
    '',
    '## Boundary aggregate',
    '',
    `- successful_write_tool_count: ${ledger.boundary_aggregate.successful_write_tool_count}`,
    `- turns_to_first_write min: ${ledger.boundary_aggregate.turns_to_first_write_min ?? 'null'}`,
    '',
    '## Budget signatures',
    '',
  );
  for (const [sig, count] of Object.entries(ledger.budget_signatures)) {
    lines.push(`- \`${sig}\`: ${count}`);
  }
  if (Object.keys(ledger.budget_signatures).length === 0) {
    lines.push('- _(none)_');
  }

  lines.push('', '## Derived eligibility', '');
  if (ledger.derived_eligibility) {
    lines.push('```', JSON.stringify(ledger.derived_eligibility, null, 2), '```');
  } else {
    lines.push('_campaign-derived.json not present — eligibility flags unavailable_');
  }

  lines.push('', '## Ranked next-fix hypotheses', '');
  if (ledger.hypotheses.length === 0) {
    lines.push('_No high-signal thrash hypotheses from available cells._');
  } else {
    for (const h of ledger.hypotheses) {
      lines.push(
        `### ${h.rank}. [${h.severity}] \`${h.id}\``,
        '',
        h.summary,
        '',
        `- supporting cells: ${h.supporting_cell_count}`,
        `- refs: ${h.evidence_refs.join(', ')}`,
        '',
      );
    }
  }

  lines.push(
    '## Cell summaries (redacted)',
    '',
    '| instance | signature | patch_bytes | ftp_class | force_mutate | force_mutate_shadow | writes | ttf_write |',
    '|---|---|---:|---|---:|---:|---:|---:|',
  );
  for (const c of ledger.cell_summaries) {
    const shortId =
      c.instance_id.length > 48 ? `${c.instance_id.slice(0, 24)}…${c.instance_id.slice(-12)}` : c.instance_id;
    lines.push(
      `| ${shortId} | ${c.signature ?? ''} | ${c.patch_bytes} | ${c.fail_to_pass_class ?? ''} | ${c.force_mutate_count} | ${c.force_mutate_shadow_count} | ${c.successful_write_tool_count} | ${c.turns_to_first_write ?? ''} |`,
    );
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * Write `improvement-ledger.json` + `improvement-ledger.md` under evidence dir.
 * Returns paths and the markdown string (for CLI stdout).
 */
export function writeImprovementLedger(
  evidenceDir: string,
  ledger: ImprovementLedger,
): { jsonPath: string; markdownPath: string; markdown: string } {
  mkdirSync(evidenceDir, { recursive: true });
  const jsonPath = join(evidenceDir, IMPROVEMENT_LEDGER_FILENAME);
  const markdownPath = join(evidenceDir, IMPROVEMENT_LEDGER_MD_FILENAME);
  const markdown = formatImprovementLedgerMarkdown(ledger);
  writeFileSync(jsonPath, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
  writeFileSync(markdownPath, markdown, 'utf8');
  return { jsonPath, markdownPath, markdown };
}
