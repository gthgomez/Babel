/**
 * P07 — completion explanations (ADR-007).
 *
 * A pure, read-only projection that explains an existing outcome: who produced
 * the evidence (producer scope), what oracle/contract it was checked against
 * (oracle scope), how complete the revision coverage is, and the three distinct
 * ADR-007 artifacts — execution receipt, verification receipt, completion
 * decision.
 *
 * It NEVER mints authority. Only the executor kernel promotes verified
 * completion; this module copies the P04 authoritative classification and the
 * kernel decision, and disables its own read API when the two are inconsistent
 * (e.g. a verified decision without authoritative projection or without an
 * available receipt). Unverified output stays unverified, and legacy evidence
 * stays inspectable with explicit unknown coverage.
 */

import type { TerminalOutcome } from '../schemas/agentContracts.js';
import type { CompletionDecision } from '../executor/contracts.js';
import type { EvidenceProducerRole } from '../evidence/evidenceGraph.js';
import {
  isTrustedExecutionReadPort,
  type AuthorizeTrustedProducerInputV1,
  type TrustedExecutionReadPortV1,
} from '../evidence/trustedExecutionIdentity.js';
import {
  RevisionManager,
  validateRevisionBoundReceipt,
  type WorkspaceRevision,
} from '../evidence/revisionBoundReceipt.js';
import {
  coverageIsWholeWorkspace,
  coverageWarnings,
  unknownCoverageManifest,
  validateCoverageManifest,
  type CoverageManifestV1,
} from '../evidence/coverage.js';
import type { ReceiptIndex, ReceiptLookupResult } from '../evidence/receiptIndex.js';
import type { RuntimeFactV1 } from './events.js';
import { projectTask, type TaskProjection } from './projection.js';

export const COMPLETION_EXPLANATION_SCHEMA_VERSION = 1 as const;
export const COMPLETION_EXPLANATION_KIND = 'completion_explanation_v1' as const;

/** Where the outcome came from; never stronger than the P04 projection. */
export type ExplanationOutcomeSource =
  | 'completion.decided'
  | 'run.settled'
  | 'none';

export type VerificationState =
  | 'available'
  | 'not_recorded'
  | 'stale'
  /** A receipt with no revision binding cannot be freshness-checked. */
  | 'unbound'
  /** A required freshness re-check failed; freshness is unknown, not fresh. */
  | 'freshness_unknown'
  | 'malformed'
  | 'wrong_contract'
  | 'untrusted_producer';

export type TrustedProducerQueryV1 = AuthorizeTrustedProducerInputV1;

export interface ProducerDeclarationV1 {
  kind: 'agent_endpoint' | 'execution_identity';
  endpoint_id: string;
  role: EvidenceProducerRole;
  execution_domain: string;
}

export interface ProducerScopeV1 {
  kind: 'trusted_execution' | 'agent_endpoint' | 'unknown';
  endpoint_id: string | null;
  role: EvidenceProducerRole | null;
  execution_domain: string | null;
  /** True only when the branded trusted-execution port authorizes it. */
  trusted: boolean;
  reason: string;
}

export interface OracleDeclarationV1 {
  kind: 'acceptance_contract' | 'verifier_command' | 'unknown';
  contract_hash?: string;
  verifier_id?: string;
  command_hash?: string;
  requirement_ids?: string[];
}

export interface OracleScopeV1 {
  kind: 'acceptance_contract' | 'verifier_command' | 'unknown';
  contract_hash: string | null;
  verifier_id: string | null;
  command_hash: string | null;
  requirement_ids: string[];
  matches_expected: boolean;
  reason: string;
}

export interface CoverageExplanationV1 {
  manifest: CoverageManifestV1;
  digest: string;
  complete: boolean;
  warnings: string[];
  reason: string;
}

export interface ExecutionReceiptRefV1 {
  receipt_id: string;
  operation_id: string | null;
  status: string | null;
  exit_code: number | null;
  state: 'available' | 'unavailable';
}

export interface ExecutionReceiptInputV1 {
  receipt_id: string;
  operation_id?: string;
  status?: string;
  exit_code?: number;
}

export interface VerificationReceiptInputV1 {
  receipt_id: string;
  command?: string;
  verifier_id?: string;
  authority_source?: string;
  authority?: boolean;
  exit_code?: number;
  scope?: string;
  stale?: boolean;
  stale_reason?: string;
  bound_revision?: WorkspaceRevision;
}

export interface VerificationReceiptRefV1 {
  receipt_id: string;
  verifier_id: string | null;
  authority_source: string | null;
  scope: string | null;
  exit_code: number | null;
  authority: boolean;
  stale: boolean;
  stale_reason: string | null;
  state: VerificationState;
  issues: string[];
}

export interface CompletionDecisionRefV1 {
  requested_outcome: string;
  final_outcome: string;
  allowed: boolean;
  reason: string;
  policy_version: string;
  evidence_refs: string[];
  state: 'decided' | 'not_decided';
}

export interface CompletionExplanationV1 {
  schema_version: typeof COMPLETION_EXPLANATION_SCHEMA_VERSION;
  kind: typeof COMPLETION_EXPLANATION_KIND;
  thread_id: string;
  task_id: string;
  outcome: {
    value: string;
    /** Copied from the P04 projection; never upgraded here. */
    authoritative: boolean;
    source: ExplanationOutcomeSource;
    reason: string | null;
  };
  execution: ExecutionReceiptRefV1;
  verification: VerificationReceiptRefV1;
  completion: CompletionDecisionRefV1;
  producer: ProducerScopeV1;
  oracle: OracleScopeV1;
  coverage: CoverageExplanationV1;
  authority: {
    promoter: 'executor_kernel' | 'none';
    /** Mirrors `decision.allowed && finalOutcome === VERIFIED_COMPLETE`. */
    promoted_by_kernel: boolean;
    /** Mirrors the P04 projection's `outcome.authoritative`. */
    effective_outcome_authoritative: boolean;
    /** True only when kernel promotion and available evidence all agree. */
    effective_verified: boolean;
    read_only: true;
    inconsistent: boolean;
    reasons: string[];
  };
  /** True when this explanation may be served by the read API. */
  read_enabled: boolean;
  explanation: string;
}

export interface ProjectCompletionExplanationInput {
  projection: TaskProjection;
  decision?: CompletionDecision | null;
  execution_receipt?: ExecutionReceiptInputV1 | null;
  verification_receipt?: VerificationReceiptInputV1 | null;
  coverage?: CoverageManifestV1 | null;
  oracle?: OracleDeclarationV1 | null;
  expected_oracle?: OracleDeclarationV1 | null;
  producer?: ProducerDeclarationV1 | null;
  /** Existing authority mechanism; only a branded port can establish trust. */
  trusted_execution?: TrustedExecutionReadPortV1 | null;
  /** Binding query authorized against the trusted-execution read port. */
  trusted_producer?: TrustedProducerQueryV1 | null;
  /** When set, staleness is re-checked through the existing revision authority. */
  project_root?: string;
  /** Explicit source of the projection outcome, when the caller knows it. */
  outcome_source?: Exclude<ExplanationOutcomeSource, 'none'>;
}

function resolveProducer(input: {
  trusted_execution?: TrustedExecutionReadPortV1 | null | undefined;
  query?: TrustedProducerQueryV1 | null;
  declaration?: ProducerDeclarationV1 | null;
}): ProducerScopeV1 {
  const declared: ProducerScopeV1 = input.declaration
    ? {
        kind: 'agent_endpoint',
        endpoint_id: input.declaration.endpoint_id,
        role: input.declaration.role,
        execution_domain: input.declaration.execution_domain,
        trusted: false,
        reason: 'declared producer is not a trusted-execution assignment',
      }
    : {
        kind: 'unknown',
        endpoint_id: null,
        role: null,
        execution_domain: null,
        trusted: false,
        reason: 'no producer identity supplied',
      };

  if (!input.trusted_execution) return declared;
  if (!isTrustedExecutionReadPort(input.trusted_execution)) {
    return {
      kind: 'unknown',
      endpoint_id: declared.endpoint_id,
      role: declared.role,
      execution_domain: declared.execution_domain,
      trusted: false,
      reason: 'read port is unbranded or caller-fabricated',
    };
  }
  if (!input.query) {
    return {
      ...declared,
      reason: 'trusted read port supplied without a producer binding query',
    };
  }
  const result = input.trusted_execution.authorize(input.query);
  if (!result.authorized) {
    return {
      kind: declared.kind === 'unknown' ? 'unknown' : declared.kind,
      endpoint_id: input.query.endpoint_id,
      role: input.query.role,
      execution_domain: input.query.execution_domain,
      trusted: false,
      reason: result.error ?? 'trusted execution refused the producer',
    };
  }
  return {
    kind: 'trusted_execution',
    endpoint_id: result.assignment?.endpoint_id ?? input.query.endpoint_id,
    role: result.assignment?.role ?? input.query.role,
    execution_domain:
      result.assignment?.execution_domain ?? input.query.execution_domain,
    trusted: true,
    reason: 'trusted execution assignment is active and binding-matched',
  };
}

function resolveOracle(input: {
  oracle?: OracleDeclarationV1 | null | undefined;
  expected?: OracleDeclarationV1 | null | undefined;
}): OracleScopeV1 {
  const oracle = input.oracle ?? null;
  const expected = input.expected ?? null;
  const base = oracle ?? expected;
  let matchesExpected = true;
  let reason = 'oracle_not_compared';
  if (oracle && expected) {
    const mismatches: string[] = [];
    // Oracle identity includes its kind; a different kind is a different oracle.
    if (oracle.kind !== expected.kind) mismatches.push('kind');
    for (const key of ['contract_hash', 'verifier_id', 'command_hash'] as const) {
      const actual = oracle[key];
      const wanted = expected[key];
      // A field declared on exactly one side is an unverifiable claim, not a match.
      if (actual === undefined && wanted === undefined) continue;
      if (actual === undefined || wanted === undefined) {
        mismatches.push(`${key}_missing`);
        continue;
      }
      if (actual !== wanted) mismatches.push(key);
    }
    if (mismatches.length > 0) {
      matchesExpected = false;
      reason = `oracle_mismatch:${mismatches.join(',')}`;
    } else {
      reason = 'oracle_matches_expected';
    }
  }
  return {
    kind: base?.kind ?? 'unknown',
    contract_hash: base?.contract_hash ?? null,
    verifier_id: base?.verifier_id ?? null,
    command_hash: base?.command_hash ?? null,
    requirement_ids: [...(base?.requirement_ids ?? [])],
    matches_expected: matchesExpected,
    reason,
  };
}

function resolveStaleness(input: {
  receipt: VerificationReceiptInputV1;
  projectRoot?: string | undefined;
}): {
  stale: boolean;
  reason: string | null;
  /** True when the required re-check could not establish freshness. */
  freshnessUnknown: boolean;
  issue?: string;
} {
  const receipt = input.receipt;
  if (receipt.stale === true)
    return {
      stale: true,
      reason: receipt.stale_reason ?? 'declared stale',
      freshnessUnknown: false,
    };
  if (!input.projectRoot || !receipt.bound_revision)
    return { stale: false, reason: null, freshnessUnknown: false };
  try {
    const result = RevisionManager.isReceiptStaleSync(
      {
        receiptId: receipt.receipt_id,
        command: receipt.command ?? '',
        exitCode: receipt.exit_code ?? 1,
        boundRevision: receipt.bound_revision,
        stale: false,
        ...(receipt.stale_reason !== undefined
          ? { staleReason: receipt.stale_reason }
          : {}),
      },
      input.projectRoot,
    );
    return result.stale
      ? {
          stale: true,
          reason: result.reason ?? 'revision moved',
          freshnessUnknown: false,
        }
      : { stale: false, reason: null, freshnessUnknown: false };
  } catch (error) {
    // A failure to establish freshness is not freshness: fail closed.
    return {
      stale: false,
      reason: receipt.stale_reason ?? null,
      freshnessUnknown: true,
      issue: `staleness_recheck_failed:${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

function resolveVerification(input: {
  receipt?: VerificationReceiptInputV1 | null | undefined;
  projectRoot?: string | undefined;
  oracle: OracleScopeV1;
  producer: ProducerScopeV1;
  producerEvaluated: boolean;
}): VerificationReceiptRefV1 {
  const receipt = input.receipt ?? null;
  if (!receipt) {
    return {
      receipt_id: '',
      verifier_id: null,
      authority_source: null,
      scope: null,
      exit_code: null,
      authority: false,
      stale: false,
      stale_reason: null,
      state: 'not_recorded',
      issues: [],
    };
  }
  const issues: string[] = [];
  const staleness = resolveStaleness({
    receipt,
    ...(input.projectRoot !== undefined
      ? { projectRoot: input.projectRoot }
      : {}),
  });
  if (staleness.issue) issues.push(staleness.issue);

  if (receipt.bound_revision) {
    const validationErrors = validateRevisionBoundReceipt({
      receiptId: receipt.receipt_id,
      command: receipt.command ?? '',
      exitCode: receipt.exit_code ?? 1,
      boundRevision: receipt.bound_revision,
      stale: staleness.stale,
      ...(receipt.authority !== undefined
        ? { authority: receipt.authority }
        : {}),
      ...(receipt.authority_source !== undefined
        ? { authoritySource: receipt.authority_source }
        : {}),
      ...(staleness.reason !== null ? { staleReason: staleness.reason } : {}),
    });
    if (validationErrors.length > 0)
      issues.push(`malformed_receipt:${validationErrors.join(',')}`);
  } else {
    issues.push('missing_revision_binding');
  }
  if (!input.oracle.matches_expected)
    issues.push('oracle_contract_mismatch');

  const authority = receipt.authority === true;
  if (input.producerEvaluated && authority && !input.producer.trusted)
    issues.push('authority_claimed_by_untrusted_producer');

  let state: VerificationState;
  if (issues.some((issue) => issue.startsWith('malformed_receipt:')))
    state = 'malformed';
  else if (!input.oracle.matches_expected) state = 'wrong_contract';
  else if (issues.includes('authority_claimed_by_untrusted_producer'))
    state = 'untrusted_producer';
  else if (staleness.freshnessUnknown) state = 'freshness_unknown';
  else if (!receipt.bound_revision) state = 'unbound';
  else if (staleness.stale) state = 'stale';
  else state = 'available';

  return {
    receipt_id: receipt.receipt_id,
    verifier_id: receipt.verifier_id ?? null,
    authority_source: receipt.authority_source ?? null,
    scope: receipt.scope ?? null,
    exit_code: receipt.exit_code ?? null,
    authority,
    stale: staleness.stale,
    stale_reason: staleness.reason,
    state,
    issues,
  };
}

function resolveExecution(
  receipt: ExecutionReceiptInputV1 | null | undefined,
): ExecutionReceiptRefV1 {
  if (!receipt)
    return {
      receipt_id: '',
      operation_id: null,
      status: null,
      exit_code: null,
      state: 'unavailable',
    };
  return {
    receipt_id: receipt.receipt_id,
    operation_id: receipt.operation_id ?? null,
    status: receipt.status ?? null,
    exit_code: receipt.exit_code ?? null,
    state: 'available',
  };
}

function resolveCompletion(
  decision: CompletionDecision | null | undefined,
): CompletionDecisionRefV1 {
  if (!decision)
    return {
      requested_outcome: 'UNKNOWN',
      final_outcome: 'UNKNOWN',
      allowed: false,
      reason: 'no_completion_decision',
      policy_version: '',
      evidence_refs: [],
      state: 'not_decided',
    };
  return {
    requested_outcome: decision.requestedOutcome,
    final_outcome: decision.finalOutcome,
    allowed: decision.allowed === true,
    reason: decision.reason,
    policy_version: decision.policyVersion,
    evidence_refs: [...(decision.evidenceRefs ?? [])],
    state: 'decided',
  };
}

function buildExplanationString(input: {
  outcome: CompletionExplanationV1['outcome'];
  verification: VerificationReceiptRefV1;
  execution: ExecutionReceiptRefV1;
  producer: ProducerScopeV1;
  oracle: OracleScopeV1;
  coverage: CoverageExplanationV1;
  authority: CompletionExplanationV1['authority'];
  readEnabled: boolean;
}): string {
  return [
    `outcome=${input.outcome.value} authoritative=${input.outcome.authoritative}`,
    `execution=${input.execution.state}`,
    `verification=${input.verification.state}`,
    `producer=${input.producer.kind} trusted=${input.producer.trusted}`,
    `oracle=${input.oracle.kind} matches=${input.oracle.matches_expected}`,
    `coverage=${input.coverage.manifest.completeness} whole=${input.coverage.complete}`,
    `kernel_promoted=${input.authority.promoted_by_kernel}`,
    `effective_verified=${input.authority.effective_verified}`,
    `read_enabled=${input.readEnabled}`,
  ].join(' | ');
}

/**
 * Produce a read-only completion explanation from existing facts and receipts.
 * Pure: no clock beyond caller-supplied/receipt data, no filesystem writes, no
 * mutation of the inputs, and no created completion/verification facts.
 */
export function projectCompletionExplanation(
  input: ProjectCompletionExplanationInput,
): CompletionExplanationV1 {
  const projection = input.projection;
  const projectionOutcome = projection.outcome ?? null;
  const decisionRef = resolveCompletion(input.decision);
  const producerEvaluated =
    input.trusted_execution != null || input.producer != null;
  const producer = resolveProducer({
    trusted_execution: input.trusted_execution ?? null,
    query: input.trusted_producer ?? null,
    declaration: input.producer ?? null,
  });
  const oracle = resolveOracle({
    oracle: input.oracle ?? null,
    expected: input.expected_oracle ?? null,
  });
  const verification = resolveVerification({
    receipt: input.verification_receipt ?? null,
    ...(input.project_root !== undefined
      ? { projectRoot: input.project_root }
      : {}),
    oracle,
    producer,
    producerEvaluated,
  });
  const execution = resolveExecution(input.execution_receipt ?? null);

  const suppliedCoverage = input.coverage ?? null;
  const coverageErrors = suppliedCoverage
    ? validateCoverageManifest(suppliedCoverage)
    : [];
  const coverageInvalid = suppliedCoverage !== null && coverageErrors.length > 0;
  const manifest = coverageInvalid
    ? unknownCoverageManifest('coverage_invalid')
    : (suppliedCoverage ?? unknownCoverageManifest());
  const coverageWarningsList = coverageWarnings(manifest);
  const coverageComplete = coverageIsWholeWorkspace(manifest);
  const coverageReason = coverageInvalid
    ? 'coverage_invalid'
    : coverageComplete
      ? 'whole_workspace_scope'
      : manifest.scope.kind === 'unknown'
        ? 'coverage_unknown'
        : coverageWarningsList.join(',') || 'scoped_claim';

  const outcomeAuthoritative = projectionOutcome?.authoritative === true;
  const source: ExplanationOutcomeSource = input.outcome_source
    ? input.outcome_source
    : projectionOutcome
      ? outcomeAuthoritative
        ? 'completion.decided'
        : 'run.settled'
      : 'none';
  const outcome = {
    value:
      projectionOutcome?.outcome ??
      (decisionRef.state === 'decided' ? decisionRef.final_outcome : 'UNKNOWN'),
    authoritative: outcomeAuthoritative,
    source,
    reason: projectionOutcome?.reason ?? null,
  };

  const promotedByKernel =
    decisionRef.state === 'decided' &&
    decisionRef.allowed &&
    decisionRef.final_outcome === 'VERIFIED_COMPLETE';
  const verificationAvailable = verification.state === 'available';
  const projectionDecisionMismatch =
    projectionOutcome !== null &&
    decisionRef.state === 'decided' &&
    projectionOutcome.outcome !== decisionRef.final_outcome;
  const reasons: string[] = [];
  if (promotedByKernel && !outcomeAuthoritative)
    reasons.push('verified_decision_without_authoritative_projection');
  if (promotedByKernel && !verificationAvailable)
    reasons.push(
      `verified_decision_without_available_receipt:${verification.state}`,
    );
  if (promotedByKernel && !verification.authority)
    reasons.push('verified_decision_without_authoritative_receipt');
  if (promotedByKernel && verification.exit_code !== 0)
    reasons.push('verified_decision_without_successful_receipt');
  if (promotedByKernel && verification.stale)
    reasons.push('verified_decision_with_stale_receipt');
  if (projectionDecisionMismatch)
    reasons.push('projection_outcome_mismatches_completion_decision');
  if (decisionRef.state === 'decided' && outcomeAuthoritative && !promotedByKernel)
    reasons.push('authoritative_projection_without_kernel_promotion');
  if (coverageInvalid) reasons.push('coverage_invalid');
  reasons.sort();

  const effectiveVerified =
    promotedByKernel &&
    outcomeAuthoritative &&
    verificationAvailable &&
    !verification.stale &&
    verification.authority &&
    verification.exit_code === 0 &&
    !projectionDecisionMismatch &&
    !coverageInvalid;

  const authority: CompletionExplanationV1['authority'] = {
    promoter: decisionRef.state === 'decided' ? 'executor_kernel' : 'none',
    promoted_by_kernel: promotedByKernel,
    effective_outcome_authoritative: outcomeAuthoritative,
    effective_verified: effectiveVerified,
    read_only: true,
    inconsistent: reasons.length > 0,
    reasons,
  };
  const readEnabled = reasons.length === 0;
  const coverage: CoverageExplanationV1 = {
    manifest,
    digest: manifest.coverage_digest,
    complete: coverageComplete,
    warnings: coverageWarningsList,
    reason: coverageReason,
  };

  return {
    schema_version: COMPLETION_EXPLANATION_SCHEMA_VERSION,
    kind: COMPLETION_EXPLANATION_KIND,
    thread_id: projection.threadId,
    task_id: projection.taskId,
    outcome,
    execution,
    verification,
    completion: decisionRef,
    producer,
    oracle,
    coverage,
    authority,
    read_enabled: readEnabled,
    explanation: buildExplanationString({
      outcome,
      verification,
      execution,
      producer,
      oracle,
      coverage,
      authority,
      readEnabled,
    }),
  };
}

/** Pure convenience: project facts and explain them in one step. */
export function projectCompletionExplanationFromFacts(
  facts: Iterable<RuntimeFactV1>,
  input: Omit<ProjectCompletionExplanationInput, 'projection'>,
): CompletionExplanationV1 {
  return projectCompletionExplanation({ ...input, projection: projectTask(facts) });
}

/** Terminal outcomes the compatibility adapter will pass through. */
const KNOWN_TERMINAL_OUTCOMES: ReadonlySet<string> = new Set([
  'VERIFIED_COMPLETE',
  'UNVERIFIED_PATCH',
  'BLOCKED_EXTERNAL',
  'BLOCKED_POLICY',
  'BUDGET_EXHAUSTED',
  'CANCELLED',
  'INFRA_FAILURE',
  'AGENT_FAILURE',
  'NO_CHANGE_REQUIRED',
  'INVALID_TASK',
  'NEEDS_HUMAN_DECISION',
  'PLAN_COMPLETE',
  'UNKNOWN',
]);

/**
 * Compatibility adapter (ADR-007): derive a `TerminalOutcome` from an
 * explanation without strengthening it. The value is only ever copied from the
 * P04 projection or the kernel decision; an unrecognized value degrades to
 * `UNKNOWN` rather than passing through an unchecked cast.
 */
export function terminalOutcomeFromExplanation(
  explanation: CompletionExplanationV1,
): TerminalOutcome | 'PLAN_COMPLETE' | 'UNKNOWN' {
  const value = explanation.outcome.value;
  return KNOWN_TERMINAL_OUTCOMES.has(value)
    ? (value as TerminalOutcome | 'PLAN_COMPLETE' | 'UNKNOWN')
    : 'UNKNOWN';
}

export type CompletionExplanationReadResult = {
  /** False when the explanation is internally inconsistent; do not serve it. */
  enabled: boolean;
  explanation: CompletionExplanationV1;
};

/** Durable, read-only evidence read API over existing authority mechanisms. */
export interface EvidenceReadApiV1 {
  readonly read_only: true;
  lookupReceipt(receipt_id: string): ReceiptLookupResult;
  explainCompletion(
    input: ProjectCompletionExplanationInput,
  ): CompletionExplanationReadResult;
}

export function createEvidenceReadApi(input: {
  receiptIndex: ReceiptIndex;
}): EvidenceReadApiV1 {
  return Object.freeze({
    read_only: true as const,
    lookupReceipt(receipt_id: string) {
      return input.receiptIndex.lookup(receipt_id);
    },
    explainCompletion(explainInput: ProjectCompletionExplanationInput) {
      const explanation = projectCompletionExplanation(explainInput);
      return { enabled: explanation.read_enabled, explanation };
    },
  });
}
