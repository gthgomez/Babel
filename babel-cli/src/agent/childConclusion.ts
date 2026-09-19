/**
 * S02/#212 — bounded read-only child conclusion handoff.
 *
 * A read-only child can finish with a useful `finish.summary`, but the parent
 * handoff historically omitted it: `formatReadOnlyObservations` skips the
 * `finish`/`blocked` phases, and `formatSubAgentFindings` only received
 * observations + step count + degraded flag.
 *
 * This module builds a bounded, structured child result from the loop result.
 * It is deliberately pure and does not import ChatEngine (or any loop) so both
 * the native tool path and the text-tools path can consume it without a cycle.
 *
 * Authority rule: a child's own assertion is never completion/verifier
 * authority. `provenance.authority` is hard-coded to
 * `child_assertion_not_verified`; no caller-supplied text can change it.
 */

export const READONLY_CHILD_CONCLUSION_MAX_CHARS = 2000;
export const READONLY_CHILD_EVIDENCE_MAX_REFS = 12;
export const READONLY_CHILD_ERROR_MAX_CHARS = 500;

/** Distinct child execution states. `policy_denied` covers ask_approval. */
export type ReadOnlyChildCompletion =
  | 'completed'
  | 'empty_conclusion'
  | 'partial'
  | 'policy_denied'
  | 'cancelled'
  | 'budget_exhausted'
  | 'provider_error'
  | 'failed';

export interface ReadOnlyChildEvidenceRef {
  tool: string;
  target: string;
  exitCode: number;
  verified: boolean;
}

export interface ReadOnlyChildResult {
  schema: 'babel.readonly_child_result.v1';
  /** Child-reported conclusion. Proposal only; never completion authority. */
  conclusion: string;
  conclusionTruncated: boolean;
  completion: ReadOnlyChildCompletion;
  /**
   * Un-collapsed signals so co-occurring states are not lost (e.g. a
   * cancellation during a partial round still reports both).
   */
  flags: {
    policyDenied: boolean;
    cancelled: boolean;
    providerError: boolean;
    roundExhausted: boolean;
    inheritedBudgetExceeded: boolean;
  };
  error?: string;
  limits: {
    roundsExecuted: number | null;
    maxRounds: number | null;
    stepsExecuted: number;
  };
  degraded: boolean;
  evidence: ReadOnlyChildEvidenceRef[];
  evidenceTruncated: boolean;
  rawObservationChars: number;
  provenance: {
    childId: string;
    lane: string;
    authority: 'child_assertion_not_verified';
  };
}

/**
 * Structural input: accepts the real `ReadOnlyAgentLoopResult` without importing
 * it, so this module stays a leaf (no ChatEngine / lane import cycle).
 */
export interface ReadOnlyChildResultInput {
  steps: ReadonlyArray<{
    phase: string;
    action: { type: string; summary?: string };
  }>;
  toolCallLog: ReadonlyArray<{
    tool: string;
    target: string;
    exit_code: number;
    verified: boolean;
  }>;
  observations?: string;
  stepsExecuted: number;
  degraded: boolean;
  completed: boolean;
  roundExhausted: boolean;
  policyBlocked: boolean;
  needsApproval?: boolean;
  providerError?: string | null;
  inheritedBudgetExceeded?: boolean;
  blockedReason?: string | null;
  roundsExecuted?: number;
  lane: string;
  childId: string;
  maxRounds: number;
  /** Parent passes the child controller's aborted flag. */
  cancelled: boolean;
}

function clip(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  const omitted = text.length - maxChars;
  return {
    text: text.slice(0, maxChars) + `\n… [child conclusion truncated: ${omitted} chars omitted]`,
    truncated: true,
  };
}

export function buildReadOnlyChildResult(input: ReadOnlyChildResultInput): ReadOnlyChildResult {
  const finish = [...input.steps]
    .reverse()
    .find((step) => step.phase === 'finish' && step.action.type === 'finish');
  const rawConclusion = (finish?.action.summary ?? '').trim();

  const flags = {
    policyDenied: input.policyBlocked === true || input.needsApproval === true,
    cancelled: input.cancelled === true,
    providerError: Boolean(input.providerError),
    roundExhausted: input.roundExhausted === true,
    inheritedBudgetExceeded: input.inheritedBudgetExceeded === true,
  };

  // Precedence is deliberate and stable: budget/provider/policy/cancel describe
  // *why* the child stopped and outrank a conclusion the child may already have
  // produced before the stop.
  let completion: ReadOnlyChildCompletion;
  if (flags.inheritedBudgetExceeded) completion = 'budget_exhausted';
  else if (flags.providerError) completion = 'provider_error';
  else if (flags.policyDenied) completion = 'policy_denied';
  else if (flags.cancelled) completion = 'cancelled';
  else if (flags.roundExhausted) completion = 'partial';
  else if (input.completed && rawConclusion) completion = 'completed';
  else if (input.completed) completion = 'empty_conclusion';
  else completion = 'failed';

  const { text: conclusion, truncated: conclusionTruncated } = clip(
    rawConclusion,
    READONLY_CHILD_CONCLUSION_MAX_CHARS,
  );

  const evidenceSource = input.toolCallLog.slice(0, READONLY_CHILD_EVIDENCE_MAX_REFS);
  const evidence: ReadOnlyChildEvidenceRef[] = evidenceSource.map((entry) => ({
    tool: entry.tool,
    target: entry.target,
    exitCode: entry.exit_code,
    verified: entry.verified,
  }));

  const rawError = input.providerError ?? input.blockedReason ?? undefined;
  const error =
    rawError && rawError.trim().length > 0
      ? rawError.slice(0, READONLY_CHILD_ERROR_MAX_CHARS)
      : undefined;

  return {
    schema: 'babel.readonly_child_result.v1',
    conclusion,
    conclusionTruncated,
    completion,
    flags,
    ...(error !== undefined ? { error } : {}),
    limits: {
      roundsExecuted: input.roundsExecuted ?? null,
      maxRounds: input.maxRounds,
      stepsExecuted: input.stepsExecuted,
    },
    degraded: input.degraded === true,
    evidence,
    evidenceTruncated: input.toolCallLog.length > READONLY_CHILD_EVIDENCE_MAX_REFS,
    rawObservationChars: input.observations?.length ?? 0,
    provenance: {
      childId: input.childId,
      lane: input.lane,
      authority: 'child_assertion_not_verified',
    },
  };
}

/**
 * Render the bounded child section. Shared by the parent formatter so the
 * native and text-tools paths emit byte-identical structured content.
 * The `(child-reported; NOT verified)` label is part of the rendered contract.
 */
export function renderReadOnlyChildResultSection(result: ReadOnlyChildResult): string {
  const f = result.flags;
  const lines: string[] = [
    '## Child conclusion (child-reported; NOT verified)',
    result.conclusion || '(no conclusion reported)',
    '## Child execution state',
    `completion: ${result.completion}`,
    `flags: policy_denied=${f.policyDenied} cancelled=${f.cancelled} provider_error=${f.providerError} round_exhausted=${f.roundExhausted} budget_exhausted=${f.inheritedBudgetExceeded}`,
    `rounds: ${result.limits.roundsExecuted ?? 'unknown'}/${result.limits.maxRounds ?? 'unknown'}   steps: ${result.limits.stepsExecuted}   degraded: ${result.degraded}`,
  ];
  if (result.error !== undefined) {
    lines.push(`error: ${result.error}`);
  }
  lines.push('## Child evidence references (raw observations below)');
  if (result.evidence.length === 0) {
    lines.push('(no evidence references)');
  } else {
    for (const ref of result.evidence) {
      lines.push(`- ${ref.tool} ${ref.target} (exit ${ref.exitCode}, verified=${ref.verified})`);
    }
  }
  if (result.evidenceTruncated) {
    lines.push('… [evidence list truncated: additional refs omitted]');
  }
  lines.push(
    '## Child provenance',
    `child_id: ${result.provenance.childId}   lane: ${result.provenance.lane}   authority: ${result.provenance.authority}`,
  );
  return lines.join('\n');
}
