/**
 * harnessAudit/findings.ts — canonical contract for harness trace-audit findings.
 *
 * The auditor is NOT a "find problems with Babel" critic. Every material
 * finding MUST distribute evidence weight across competing hypotheses
 * (H1 MODEL … H10 UNKNOWN) and MAY legitimately conclude "probably not Babel".
 *
 * Producers: offline trace auditor (W5/E). Consumers: bottleneck ledger,
 * clustering/reporting, future SearchEpisode lineage references.
 */

import { z } from 'zod';

export const AUDIT_FINDING_SCHEMA_VERSION = 1 as const;
export const AUDIT_FINDING_KIND = 'babel_harness_audit_finding' as const;

export const HYPOTHESIS_LABELS = [
  'MODEL',
  'TASK',
  'REPOSITORY',
  'HARNESS_CONTEXT',
  'HARNESS_TOOL',
  'HARNESS_ORCHESTRATION',
  'POLICY',
  'ENVIRONMENT',
  'INTERACTION',
  'UNKNOWN',
] as const;
export type HypothesisLabel = (typeof HYPOTHESIS_LABELS)[number];

/** Evidence pointer to a durable id — vague prose references are rejected. */
export const EvidenceRefSchema = z.object({
  source: z.enum([
    'episode_event',
    'session_event',
    'policy_event',
    'cell_evidence',
    'transcript',
    'verifier_receipt',
  ]),
  /** Durable event/receipt id, e.g. episode-stream eventId or receiptId. */
  id: z.string().min(1),
});
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

export const HypothesisWeightSchema = z.object({
  label: z.enum(HYPOTHESIS_LABELS),
  /** Relative evidence weight in (0,1]; weights across entries must sum to 1. */
  weight: z.number().positive().max(1),
  rationale: z.string().min(1),
});

export const FalsificationExperimentSchema = z.object({
  description: z.string().min(1),
  /** Pre-registered prediction that would support the primary attribution. */
  preregistered_prediction: z.string().min(1),
  /** Observable metric/condition the replay checks. */
  success_metric: z.string().min(1),
});

export const AuditFindingSchema = z.object({
  schema_version: z.literal(AUDIT_FINDING_SCHEMA_VERSION),
  kind: z.literal(AUDIT_FINDING_KIND),
  finding_id: z.string().min(1),
  produced_at: z.string().min(1),

  /** What ran: arm label plus resolved orthogonal identity. */
  task_id: z.string().min(1),
  arm: z.string().min(1),
  model: z.string().nullable(),
  attempt_id: z.string().nullable().default(null),
  campaign_id: z.string().nullable().default(null),
  episode_run_dir: z.string().nullable().default(null),

  stage: z.enum([
    'context',
    'planning',
    'tool_use',
    'mutation',
    'verification',
    'completion',
    'orchestration',
  ]),

  claim: z.string().min(20),
  expected_capability: z.string().min(1),
  observed_behavior: z.string().min(1),
  impact: z.string().min(1),

  evidence_refs: z.array(EvidenceRefSchema).min(1),

  /** Competing-hypothesis distribution — weights must sum to ~1. */
  hypotheses: z.array(HypothesisWeightSchema).min(1),

  confidence: z.number().min(0).max(1),

  counterfactual: z.string().min(1),
  falsification_experiment: FalsificationExperimentSchema,

  near_miss: z.boolean(),
  succeeded_despite_harness: z.boolean(),

  worker_friction_agreement: z.enum(['corroborates', 'contradicts', 'no_worker_report']),
});
export type AuditFinding = z.infer<typeof AuditFindingSchema>;

const WEIGHT_SUM_TOLERANCE = 0.005;

/**
 * Fail-closed validation beyond zod structure:
 *  - findings MUST carry competing hypotheses (>=2) so they cannot smuggle
 *    single-cause blame;
 *  - weights must sum to one.
 */
export function validateFindingSemantics(finding: AuditFinding): string[] {
  const problems: string[] = [];
  if (finding.hypotheses.length < 2) {
    problems.push(
      `at least 2 competing hypotheses required; got ${finding.hypotheses.length}`,
    );
  }
  const weightSum = finding.hypotheses.reduce((acc, h) => acc + h.weight, 0);
  if (Math.abs(weightSum - 1) > WEIGHT_SUM_TOLERANCE) {
    problems.push(
      `hypothesis weights must sum to 1 (±${WEIGHT_SUM_TOLERANCE}); got ${weightSum.toFixed(4)}`,
    );
  }
  const seen = new Set<string>();
  for (const h of finding.hypotheses) {
    if (seen.has(h.label)) problems.push(`duplicate hypothesis label: ${h.label}`);
    seen.add(h.label);
  }
  if (
    finding.succeeded_despite_harness &&
    finding.stage !== 'completion'
  ) {
    // Allowed but suspicious; surfaced for reviewer attention rather than rejected.
    problems.push('NOTE succeeded_despite_harness set outside completion stage');
  }
  return problems;
}

export function parseAuditFinding(input: unknown): {
  ok: true;
  finding: AuditFinding;
} | {
  ok: false;
  errors: string[];
} {
  const parsed = AuditFindingSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) };
  }
  const semanticProblems = validateFindingSemantics(parsed.data);
  if (semanticProblems.length > 0) {
    return { ok: false, errors: semanticProblems };
  }
  return { ok: true, finding: parsed.data };
}
