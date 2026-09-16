/**
 * Shared mutation / verifier tool identity for the chat harness.
 *
 * `str_replace` is a first-class edit primitive and must count as a write
 * everywhere governance and evidence inspect tool logs (gate, stall, changed_files,
 * benchmark write counts). Historically only write_file / file_write / apply_patch
 * were recognized, so preferred-edit sessions could look write-less.
 *
 * Chat tools primarily log verifiers as `run_command`; the completion gate
 * must accept that name alongside shell_exec / test_run.
 */

/** Direct file-mutation tools (not sub_agent — that uses detail-string parsing). */
export const DIRECT_MUTATION_TOOLS = [
  'write_file',
  'file_write',
  'apply_patch',
  'str_replace',
  'file_delete',
] as const;

export type DirectMutationTool = (typeof DIRECT_MUTATION_TOOLS)[number];

/** Effect state proven by executor receipts, independent of process exit status. */
export type MutationEffectStatus =
  | 'confirmed_change'
  | 'confirmed_no_change'
  | 'indeterminate'
  | 'not_applicable';

export interface MutationEffectAssessment {
  status: MutationEffectStatus;
  reason: string;
}

interface MutationReceiptEvidence {
  changedBytes?: number | null;
  status?: string;
  preImageHashes?: Readonly<Record<string, string>>;
  postImageHashes?: Readonly<Record<string, string>>;
}

interface EffectTransactionEvidence {
  status?: string;
  rollback_result?: string;
  pre_revision?: { compositeTreeHash?: string };
  post_revision?: { compositeTreeHash?: string };
}

const SHELL_MUTATION_TOOLS = new Set(['run_command', 'test_run', 'shell_exec']);

function hashMapsEqual(
  left: Readonly<Record<string, string>> | undefined,
  right: Readonly<Record<string, string>> | undefined,
): boolean | undefined {
  if (!left || !right) return undefined;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length || leftKeys.some((key, index) => key !== rightKeys[index])) {
    return false;
  }
  return leftKeys.every((key) => left[key] === right[key]);
}

/**
 * Classify a mutation attempt from authoritative receipt evidence.
 * Missing receipt data never upgrades a successful process exit into a write.
 */
export function assessMutationEffect(input: {
  tool: string;
  error?: string | null | undefined;
  exitCode?: number | null | undefined;
  policyBlocked?: boolean | undefined;
  mutationPaths?: readonly string[] | undefined;
  mutationReceipt?: MutationReceiptEvidence | undefined;
  effectTransaction?: EffectTransactionEvidence | undefined;
}): MutationEffectAssessment {
  const mutationCandidate = isDirectMutationTool(input.tool) || SHELL_MUTATION_TOOLS.has(input.tool);
  if (!mutationCandidate) {
    return { status: 'not_applicable', reason: 'tool is not a mutation candidate' };
  }
  if (input.policyBlocked || input.error === 'blocked') {
    return { status: 'not_applicable', reason: 'mutation was denied by policy' };
  }

  const transaction = input.effectTransaction;
  if (transaction?.status === 'reconcile_needed' || transaction?.status === 'rollback_failed') {
    return { status: 'indeterminate', reason: `effect transaction requires reconciliation (${transaction.status})` };
  }
  if (transaction?.status === 'rollback' && transaction.rollback_result === 'success') {
    return { status: 'confirmed_no_change', reason: 'effect was rolled back and verified' };
  }

  if (input.exitCode !== undefined && input.exitCode !== null && input.exitCode !== 0) {
    return { status: 'indeterminate', reason: 'mutation attempt failed before a committed effect was proven' };
  }

  const receipt = input.mutationReceipt;
  let receiptEffect: MutationEffectStatus | undefined;
  if (receipt) {
    if (receipt.status !== undefined && receipt.status !== 'committed') {
      return { status: 'indeterminate', reason: `mutation receipt is not committed (${receipt.status})` };
    }
    const hashesEqual = hashMapsEqual(receipt.preImageHashes, receipt.postImageHashes);
    const changedBytes = receipt.changedBytes;
    const hasChangedBytes = changedBytes !== undefined && changedBytes !== null;
    if (
      hashesEqual !== undefined &&
      hasChangedBytes &&
      ((hashesEqual && changedBytes! > 0) || (!hashesEqual && changedBytes === 0))
    ) {
      return { status: 'indeterminate', reason: 'committed receipt contains conflicting change evidence' };
    }
    if (hashesEqual === true || changedBytes === 0) receiptEffect = 'confirmed_no_change';
    if (hashesEqual === false || (hasChangedBytes && changedBytes! > 0)) receiptEffect = 'confirmed_change';
  }

  const preRevision = transaction?.pre_revision?.compositeTreeHash;
  const postRevision = transaction?.post_revision?.compositeTreeHash;
  let transactionEffect: MutationEffectStatus | undefined;
  if (transaction?.status === 'commit' && preRevision && postRevision) {
    transactionEffect = preRevision === postRevision ? 'confirmed_no_change' : 'confirmed_change';
  }
  if (receiptEffect && transactionEffect && receiptEffect !== transactionEffect) {
    return { status: 'indeterminate', reason: 'receipt and transaction revisions disagree' };
  }
  if (receiptEffect === 'confirmed_no_change' || transactionEffect === 'confirmed_no_change') {
    return { status: 'confirmed_no_change', reason: 'committed evidence proves identical post-state' };
  }
  if (receiptEffect === 'confirmed_change' || transactionEffect === 'confirmed_change') {
    return { status: 'confirmed_change', reason: 'committed evidence proves changed post-state' };
  }

  return { status: 'indeterminate', reason: 'committed effect receipt is missing or incomplete' };
}

/** Tools that count as a verifier attempt for completion-gate Rule 2. */
export const VERIFIER_ATTEMPT_TOOLS = [
  'shell_exec',
  'test_run',
  'run_command',
] as const;

export function isDirectMutationTool(tool: string): boolean {
  return (DIRECT_MUTATION_TOOLS as readonly string[]).includes(tool);
}

/**
 * Successful direct mutation: recognized write tool with no error.
 *
 * - Policy deny sets `error: 'blocked'`.
 * - Failed str_replace sets e.g. `error: 'str_replace: old_str not found'`.
 * Either must NOT satisfy the completion gate or populate changed_files.
 */
export function isSuccessfulDirectMutation(
  tool: string,
  error?: string | null,
  exitCode?: number | null,
): boolean {
  return (
    isDirectMutationTool(tool) &&
    (error == null || error === '') &&
    (exitCode == null || exitCode === 0)
  );
}

/** True only when a direct mutation is transport-successful and effect-confirmed. */
export function isConfirmedDirectMutation(
  tool: string,
  error?: string | null,
  effectStatus?: MutationEffectStatus,
): boolean {
  return (
    isSuccessfulDirectMutation(tool, error) &&
    (effectStatus === undefined || effectStatus === 'confirmed_change')
  );
}

/** Return every executor-reported path for a confirmed mutation. */
export function confirmedMutationPaths(input: {
  tool: string;
  target?: string | null | undefined;
  error?: string | null | undefined;
  effectStatus?: MutationEffectStatus | undefined;
  mutationPaths?: readonly string[] | undefined;
}): string[] {
  if (!isConfirmedDirectMutation(input.tool, input.error, input.effectStatus)) return [];
  if (input.mutationPaths && input.mutationPaths.length > 0) {
    return input.mutationPaths.filter((path) => typeof path === 'string' && path.length > 0);
  }
  return input.target ? [input.target] : [];
}

export function isVerifierAttemptTool(tool: string): boolean {
  return (VERIFIER_ATTEMPT_TOOLS as readonly string[]).includes(tool);
}
