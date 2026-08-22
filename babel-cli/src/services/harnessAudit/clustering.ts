/**
 * clustering.ts — deterministic analysis layer over harness audit findings
 * and Bottleneck Ledger entries (Workstream B,
 * docs/roadmaps/OX_ALPHA_EXPERIMENTAL_PROGRAM.md).
 *
 * Pure functions only: cluster AuditFinding[] into candidate bottleneck
 * groups, and build priority reports over folded ledger entries. The
 * hypothesis→subsystem mapping here is analysis-layer interpretation of the
 * canonical finding contract (findings.ts), which stays interpretation-free.
 *
 * Determinism: identical inputs always produce identically ordered output
 * (ties broken by id/key/label ascending). No I/O, no clocks unless an
 * explicit generated_at is supplied by the caller.
 */

import { type AuditFinding, type HypothesisLabel } from './findings.js';
import {
  BOTTLENECK_STATUSES,
  type BottleneckLedgerEntry,
  type BottleneckStatus,
} from './bottleneckLedger.js';

// ─── Subsystem mapping ───────────────────────────────────────────────────────

/**
 * Explicit hypothesis-label → suspected_subsystem map. Defaults are
 * documented per label; this is the ONLY place that interprets audit
 * hypotheses as subsystem names for ledger routing.
 */
export const HYPOTHESIS_TO_SUBSYSTEM: Readonly<Record<HypothesisLabel, string>> = {
  // Non-harness attributions keep their own passthrough keys so no evidence
  // silently disappears from clustering; they simply do not lead a cluster.
  MODEL: 'model',
  TASK: 'task',
  REPOSITORY: 'repository',
  ENVIRONMENT: 'environment',

  HARNESS_CONTEXT: 'context_assembly',
  HARNESS_TOOL: 'tool_mediation',
  HARNESS_ORCHESTRATION: 'orchestration',
  POLICY: 'mutation_governance',

  INTERACTION: 'interaction',
  UNKNOWN: 'unknown',
};

/** Labels that must NOT be selected as a cluster's leading attribution. */
export const NON_HARNESS_TOP_HYPOTHESES: ReadonlySet<HypothesisLabel> = new Set<
  HypothesisLabel
>(['MODEL', 'UNKNOWN', 'INTERACTION'] as const);

/** Fallback subsystem when every hypothesis is MODEL/UNKNOWN/INTERACTION. */
export const UNRESOLVED_SUBSYSTEM = 'attribution_unresolved' as const;

export interface SuspectedSubsystemDerivation {
  subsystem: string;
  /** Leading non-MODEL/UNKNOWN/INTERACTION hypothesis label, if any. */
  top_label: HypothesisLabel | null;
}

export interface WeightedHypothesis {
  label: HypothesisLabel;
  weight: number;
}

/**
 * Derive the suspected subsystem from the top-weight non-excluded hypothesis.
 * Ties on weight break by label ascending for determinism.
 */
export function deriveSuspectedSubsystem(
  hypotheses: readonly WeightedHypothesis[],
): SuspectedSubsystemDerivation {
  const sorted = [...hypotheses].sort(
    (a, b) => b.weight - a.weight || a.label.localeCompare(b.label),
  );
  const top = sorted.find((h) => !NON_HARNESS_TOP_HYPOTHESES.has(h.label));
  if (!top) {
    return { subsystem: UNRESOLVED_SUBSYSTEM, top_label: null };
  }
  return { subsystem: HYPOTHESIS_TO_SUBSYSTEM[top.label], top_label: top.label };
}

// ─── Finding clustering ──────────────────────────────────────────────────────

export interface AggregateHypothesisShare {
  label: HypothesisLabel;
  /** Confidence-weighted share of this label within the cluster, in [0,1]. */
  share: number;
}

export interface FindingCluster {
  /** `${suspected_subsystem}::${stage}` */
  key: string;
  suspected_subsystem: string;
  stage: AuditClusterStage;
  finding_ids: string[];
  /** Total confidence-weighted count (sum of member confidences). */
  total_confidence_weighted_count: number;
  suggested_ledger_claim: string;
  aggregate_hypotheses: AggregateHypothesisShare[];
}

type AuditClusterStage = AuditFinding['stage'];

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Group findings by (derived suspected_subsystem × stage). Clusters sort by
 * total confidence-weighted count descending, ties by key ascending. Every
 * finding lands in exactly one cluster — including model/task-only findings,
 * which cluster under their passthrough keys rather than being dropped.
 */
export function clusterFindings(findings: readonly AuditFinding[]): FindingCluster[] {
  const groups = new Map<string, { subsystem: string; stage: AuditClusterStage; members: AuditFinding[] }>();
  for (const finding of findings) {
    const { subsystem } = deriveSuspectedSubsystem(finding.hypotheses);
    const key = `${subsystem}::${finding.stage}`;
    let group = groups.get(key);
    if (!group) {
      group = { subsystem, stage: finding.stage, members: [] };
      groups.set(key, group);
    }
    group.members.push(finding);
  }

  const clusters: FindingCluster[] = [];
  for (const [key, group] of groups) {
    const members = [...group.members].sort((a, b) =>
      compareStrings(a.finding_id, b.finding_id),
    );
    const totalConfidence = members.reduce((acc, f) => acc + f.confidence, 0);

    const massByLabel = new Map<HypothesisLabel, number>();
    for (const f of members) {
      for (const h of f.hypotheses) {
        massByLabel.set(h.label, (massByLabel.get(h.label) ?? 0) + f.confidence * h.weight);
      }
    }
    const totalMass = [...massByLabel.values()].reduce((acc, m) => acc + m, 0);
    const aggregateHypotheses: AggregateHypothesisShare[] = [...massByLabel.entries()]
      .map(([label, mass]) => ({
        label,
        share: totalMass > 0 ? mass / totalMass : 0,
      }))
      .sort((a, b) => b.share - a.share || compareStrings(a.label, b.label));

    const leading =
      aggregateHypotheses.length > 0 ? aggregateHypotheses[0] : undefined;
    const leadingLabel = leading?.label ?? UNRESOLVED_SUBSYSTEM;
    const leadingPct = leading ? Math.round(leading.share * 100) : 0;

    clusters.push({
      key,
      suspected_subsystem: group.subsystem,
      stage: group.stage,
      finding_ids: members.map((f) => f.finding_id),
      total_confidence_weighted_count: totalConfidence,
      suggested_ledger_claim: `${members.length} audit finding(s) implicate ${group.subsystem} at stage '${group.stage}' with leading attribution ${leadingLabel} (${leadingPct}% confidence-weighted share)`,
      aggregate_hypotheses: aggregateHypotheses,
    });
  }

  return clusters.sort(
    (a, b) =>
      b.total_confidence_weighted_count - a.total_confidence_weighted_count ||
      compareStrings(a.key, b.key),
  );
}

// ─── Ledger report ───────────────────────────────────────────────────────────

export const BOTTLENECK_LEDGER_REPORT_KIND = 'babel_bottleneck_ledger_report' as const;
export const BOTTLENECK_LEDGER_REPORT_SCHEMA_VERSION = 1 as const;

export interface BottleneckLedgerReport {
  kind: typeof BOTTLENECK_LEDGER_REPORT_KIND;
  schema_version: typeof BOTTLENECK_LEDGER_REPORT_SCHEMA_VERSION;
  generated_at?: string;
  totals_by_status: Record<BottleneckStatus, number>;
  /**
   * OPEN entries sorted by evidence_strength (strong first), then
   * observed_across.attempt_count descending; ties break by id ascending.
   */
  open_priorities: BottleneckLedgerEntry[];
}

const STRENGTH_RANK: Record<string, number> = {
  weak: 0,
  moderate: 1,
  strong: 2,
};

export function buildLedgerReport(
  entries: readonly BottleneckLedgerEntry[],
  options?: { generatedAt?: string },
): BottleneckLedgerReport {
  const totals_by_status: Record<BottleneckStatus, number> = {
    OPEN: 0,
    INTERVENTION_SHIPPED: 0,
    CONFIRMED: 0,
    FALSIFIED: 0,
  };
  for (const status of BOTTLENECK_STATUSES) {
    totals_by_status[status] = totals_by_status[status] ?? 0;
  }
  for (const entry of entries) {
    totals_by_status[entry.status] += 1;
  }

  const openPriorities = entries
    .filter((e) => e.status === 'OPEN')
    .sort(
      (a, b) =>
        (STRENGTH_RANK[b.evidence_strength] ?? -1) - (STRENGTH_RANK[a.evidence_strength] ?? -1) ||
        b.observed_across.attempt_count - a.observed_across.attempt_count ||
        compareStrings(a.id, b.id),
    )
    .map((e) => structuredClone(e));

  return {
    kind: BOTTLENECK_LEDGER_REPORT_KIND,
    schema_version: BOTTLENECK_LEDGER_REPORT_SCHEMA_VERSION,
    ...(options?.generatedAt !== undefined ? { generated_at: options.generatedAt } : {}),
    totals_by_status,
    open_priorities: openPriorities,
  };
}
