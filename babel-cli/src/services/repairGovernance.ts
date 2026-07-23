import { existsSync, readFileSync } from 'node:fs';

export const DEFAULT_AUTONOMOUS_REPAIR_ATTEMPTS = 3;
export const DEFAULT_REPAIR_RUN_ATTEMPTS = 5;

export const REPAIR_FAILURE_CODES = [
  'EXACT_INSTRUCTION_DRIFT',
  'TEST_FAILED',
  'BUILD_FAILED',
  'TYPECHECK_FAILED',
  'PROVIDER_SCHEMA_INVALID',
  'PROVIDER_UNAVAILABLE',
  'NO_EFFECTS_DETECTED',
  'AMBIGUOUS_LITERAL_BINDING',
  'TOOL_PERMISSION_BLOCKED',
  'QA_REJECTED',
  'VERIFIER_FAILED',
] as const;

export type RepairFailureCode = (typeof REPAIR_FAILURE_CODES)[number];

export type ExactInvariantAttemptStatus = 'pass' | 'fail' | 'unknown';

export interface FailureCapsule {
  schema_version: 1;
  attempt: number;
  failure_code: RepairFailureCode;
  failed_command: string | null;
  concise_failure_summary: string;
  changed_files: string[];
  exact_invariant_status: ExactInvariantAttemptStatus;
  next_repair_hypothesis: string;
  retryable: boolean;
}

export interface FailureClassificationInput {
  pipelineStatus?: string | null;
  verifierStatus?: string | null;
  failedCommand?: string | null;
  stdout?: string | null;
  stderr?: string | null;
  error?: string | null;
  changedFiles?: readonly string[];
  exactInvariantStatus?: ExactInvariantAttemptStatus;
}

export interface FailureCapsuleInput extends FailureClassificationInput {
  attempt: number;
}

export function maxAttemptsForRepairMode(mode: 'deep' | 'repair-run'): number {
  return mode === 'repair-run' ? DEFAULT_REPAIR_RUN_ATTEMPTS : DEFAULT_AUTONOMOUS_REPAIR_ATTEMPTS;
}

export function classifyRepairFailure(input: FailureClassificationInput): RepairFailureCode {
  const pipelineStatus = normalize(input.pipelineStatus);
  const verifierStatus = normalize(input.verifierStatus);
  const command = normalize(input.failedCommand);
  const evidence = normalize(
    [
      input.pipelineStatus,
      input.verifierStatus,
      input.failedCommand,
      input.stdout,
      input.stderr,
      input.error,
    ]
      .filter((value): value is string => typeof value === 'string')
      .join('\n'),
  );

  if (
    pipelineStatus.includes('ambiguous_literal_binding') ||
    evidence.includes('ambiguous_literal_binding')
  ) {
    return 'AMBIGUOUS_LITERAL_BINDING';
  }
  if (
    evidence.includes('zod validation failed') ||
    evidence.includes('invalid json') ||
    evidence.includes('failed to parse api response as json') ||
    evidence.includes('schema validation')
  ) {
    return 'PROVIDER_SCHEMA_INVALID';
  }
  if (
    evidence.includes('network error') ||
    evidence.includes('request timeout') ||
    evidence.includes('fetch failed') ||
    evidence.includes('all runner') ||
    evidence.includes('waterfall failed')
  ) {
    return 'PROVIDER_UNAVAILABLE';
  }
  if (
    pipelineStatus.includes('exact_instruction_drift') ||
    evidence.includes('exact_instruction_drift')
  ) {
    return 'EXACT_INSTRUCTION_DRIFT';
  }
  if (pipelineStatus.includes('qa_rejected') || evidence.includes('qa rejected')) {
    return 'QA_REJECTED';
  }
  if (
    pipelineStatus.includes('permission') ||
    evidence.includes('permission') ||
    evidence.includes('allowed_tools') ||
    evidence.includes('disallowed') ||
    evidence.includes('denied') ||
    evidence.includes('not allowed')
  ) {
    return 'TOOL_PERMISSION_BLOCKED';
  }
  if ((input.changedFiles?.length ?? 0) === 0 && pipelineStatus.includes('complete')) {
    return 'NO_EFFECTS_DETECTED';
  }
  if (command.includes('typecheck') || command.includes('tsc ') || evidence.includes('typecheck')) {
    return 'TYPECHECK_FAILED';
  }
  if (command.includes('build') || evidence.includes('build failed')) {
    return 'BUILD_FAILED';
  }
  if (
    command.includes('test') ||
    command.includes('pytest') ||
    command.includes('vitest') ||
    evidence.includes('test failed')
  ) {
    return 'TEST_FAILED';
  }
  if (
    verifierStatus.includes('fail') ||
    verifierStatus.includes('error') ||
    evidence.includes('verifier')
  ) {
    return 'VERIFIER_FAILED';
  }
  if ((input.changedFiles?.length ?? 0) === 0) {
    return 'NO_EFFECTS_DETECTED';
  }
  return 'VERIFIER_FAILED';
}

export function isRetryableRepairFailure(input: {
  code: RepairFailureCode;
  changedFiles?: readonly string[];
  failedCommand?: string | null;
  summary?: string | null;
}): boolean {
  if (
    input.code === 'AMBIGUOUS_LITERAL_BINDING' ||
    input.code === 'TOOL_PERMISSION_BLOCKED' ||
    input.code === 'NO_EFFECTS_DETECTED'
  ) {
    return false;
  }

  const hasActionableEvidence =
    (input.failedCommand?.trim().length ?? 0) > 0 || (input.summary?.trim().length ?? 0) > 0;
  if (!hasActionableEvidence) {
    return false;
  }

  if (input.code === 'PROVIDER_SCHEMA_INVALID' || input.code === 'PROVIDER_UNAVAILABLE') {
    return true;
  }

  if (input.code === 'QA_REJECTED') {
    return true;
  }

  return (
    (input.changedFiles?.length ?? 0) > 0 ||
    input.code === 'EXACT_INSTRUCTION_DRIFT' ||
    input.code === 'TEST_FAILED' ||
    input.code === 'BUILD_FAILED' ||
    input.code === 'TYPECHECK_FAILED' ||
    input.code === 'VERIFIER_FAILED'
  );
}

export function buildFailureCapsule(input: FailureCapsuleInput): FailureCapsule {
  const changedFiles = [
    ...new Set((input.changedFiles ?? []).map(normalizePath).filter(Boolean)),
  ].sort();
  const failureCode = classifyRepairFailure({ ...input, changedFiles });
  const summary = summarizeFailure(input, failureCode);
  const failedCommand = emptyToNull(input.failedCommand);
  const retryable = isRetryableRepairFailure({
    code: failureCode,
    changedFiles,
    failedCommand,
    summary,
  });

  return {
    schema_version: 1,
    attempt: input.attempt,
    failure_code: failureCode,
    failed_command: failedCommand,
    concise_failure_summary: summary,
    changed_files: changedFiles,
    exact_invariant_status: input.exactInvariantStatus ?? inferExactInvariantStatus(input),
    next_repair_hypothesis: buildRepairHypothesis(failureCode, summary),
    retryable,
  };
}

export function formatFailureCapsuleForPrompt(capsule: FailureCapsule): string {
  return JSON.stringify(capsule, null, 2);
}

function buildRepairHypothesis(code: RepairFailureCode, summary: string): string {
  switch (code) {
    case 'EXACT_INSTRUCTION_DRIFT':
      return 'Patch only the files needed to restore the exact requested literals, filenames, flags, or values before rerunning verification.';
    case 'TEST_FAILED':
      return 'Use the failing test output to make the smallest source patch, then rerun the same test command before advancing.';
    case 'BUILD_FAILED':
      return 'Patch the compile/build error at its source, then rerun the same build command.';
    case 'TYPECHECK_FAILED':
      return 'Patch the reported type error without widening scope, then rerun the same typecheck command.';
    case 'PROVIDER_SCHEMA_INVALID':
      return 'Retry the same task after the structured-output retry path reinforces the missing schema fields; inspect waterfall telemetry if it repeats.';
    case 'PROVIDER_UNAVAILABLE':
      return 'Retry the same task when the provider/network is available, or select another configured model tier.';
    case 'VERIFIER_FAILED':
      return 'Patch the artifact or source path named by the verifier, preserving already-passing postconditions.';
    case 'QA_REJECTED':
      return 'Revise the plan to address the QA rejection directly before attempting execution again.';
    case 'AMBIGUOUS_LITERAL_BINDING':
      return 'Stop and ask for an explicit one-to-one file/literal mapping; guessing would violate the task contract.';
    case 'TOOL_PERMISSION_BLOCKED':
      return 'Stop or request a scoped permission/tool change; retrying the same blocked tool is not useful.';
    case 'NO_EFFECTS_DETECTED':
      return 'Stop and inspect why no bounded side effects were produced; do not loop without a concrete patch target.';
  }
}

function summarizeFailure(input: FailureClassificationInput, code: RepairFailureCode): string {
  const excerpts = [input.error, input.stderr, input.stdout]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.trim().replace(/\s+/g, ' '))
    .filter(Boolean);
  const excerpt = excerpts[0]?.slice(0, 700);
  if (excerpt) {
    return `${code}: ${excerpt}`;
  }
  if (input.pipelineStatus) {
    return `${code}: pipeline status ${input.pipelineStatus}`;
  }
  if (input.verifierStatus) {
    return `${code}: verifier status ${input.verifierStatus}`;
  }
  return `${code}: no further failure detail was recorded.`;
}

function inferExactInvariantStatus(input: FailureClassificationInput): ExactInvariantAttemptStatus {
  const evidence = normalize(
    [input.pipelineStatus, input.stdout, input.stderr, input.error]
      .filter((value): value is string => typeof value === 'string')
      .join('\n'),
  );
  if (
    evidence.includes('exact_instruction_drift') ||
    evidence.includes('ambiguous_literal_binding')
  ) {
    return 'fail';
  }
  return 'unknown';
}

function normalize(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase();
}

function normalizePath(value: string): string {
  return value.trim().replace(/\\/g, '/');
}

function emptyToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

// ─── Capsule chain validation ──────────────────────────────────────────────────

export interface CapsuleChainCheck {
  ok: boolean;
  reason: string | null;
}

/**
 * Validates that the failure capsule from the previous repair attempt exists
 * and is readable before starting the next attempt. A broken capsule chain
 * (missing or unreadable capsule) causes the "retry consumed capsule" and
 * "same verifier rerun" checks to fail in the reliability matrix.
 *
 * Call this before launching repair attempt N (N > 1).
 */
export function validateRepairCapsuleChain(input: {
  attemptNumber: number;
  previousCapsulePath: string | null;
  expectedVerifierCommand?: string | null;
}): CapsuleChainCheck {
  if (input.attemptNumber <= 1) {
    return { ok: true, reason: null };
  }

  if (!input.previousCapsulePath || input.previousCapsulePath.trim().length === 0) {
    return {
      ok: false,
      reason: `Cannot start repair attempt ${input.attemptNumber}: no failure capsule path from attempt ${input.attemptNumber - 1}. The capsule chain is broken — the retry will have no context about what failed.`,
    };
  }

  if (!existsSync(input.previousCapsulePath)) {
    return {
      ok: false,
      reason: `Cannot start repair attempt ${input.attemptNumber}: failure capsule from attempt ${input.attemptNumber - 1} not found at "${input.previousCapsulePath}". The capsule was either not written, deleted, or moved.`,
    };
  }

  try {
    const raw = readFileSync(input.previousCapsulePath, 'utf8');
    JSON.parse(raw); // verify it's valid JSON
  } catch {
    return {
      ok: false,
      reason: `Cannot start repair attempt ${input.attemptNumber}: failure capsule at "${input.previousCapsulePath}" exists but is not valid JSON.`,
    };
  }

  return { ok: true, reason: null };
}
