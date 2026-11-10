/**
 * Mutating / hybrid inspection-only terminal authority. Extracted from ChatEngine
 * to keep chatEngine.ts under the architecture line budget.
 */
import {
  evaluateCriterionCompletionV1,
  type CriterionCompletionServiceV1,
  type CriterionPrivateEvidenceRefreshV1,
} from '../authority/criterionCompletion.js';
import { hasInspectedNoChangeEvidence, type GateToolLogEntry } from './completionGatePolicy.js';
import type { TaskOperation } from '../config/chatTaskClass.js';

export type MutatingNoChangeRefreshInput = Omit<CriterionPrivateEvidenceRefreshV1, 'proof' | 'allowPartialEvidence'> & {
  criterionChatReceipts: CriterionPrivateEvidenceRefreshV1['receipts'];
  candidate_sha: string | null;
};

export function resolveAcceptedReadOnlyTerminal(input: {
  effectiveOperation: TaskOperation | undefined;
  ambientReadOnly: boolean;
  hasAnyWrites: boolean;
  toolCallLog: GateToolLogEntry[];
  criterionCompletion: CriterionCompletionServiceV1 | undefined;
  buildCriterionRefresh: () => MutatingNoChangeRefreshInput | null;
}): boolean {
  if (input.effectiveOperation === 'READ_ONLY' || input.ambientReadOnly) {
    return true;
  }
  if (
    !input.hasAnyWrites
    && hasInspectedNoChangeEvidence(input.toolCallLog)
    && (input.effectiveOperation === 'HYBRID' || input.effectiveOperation === 'MUTATING')
  ) {
    return !mutatingInspectionLeavesRequiredCriteriaUnmet({
      criterionCompletion: input.criterionCompletion,
      toolCallLog: input.toolCallLog,
      buildCriterionRefresh: input.buildCriterionRefresh,
    });
  }
  return false;
}

/** True when frozen acceptance still blocks an inspection-only mutating terminal. */
export function mutatingInspectionLeavesRequiredCriteriaUnmet(input: {
  criterionCompletion: CriterionCompletionServiceV1 | undefined;
  toolCallLog: GateToolLogEntry[];
  buildCriterionRefresh: () => MutatingNoChangeRefreshInput | null;
}): boolean {
  if (!input.criterionCompletion) return true;
  try {
    const request = input.criterionCompletion.currentRequest();
    if (!request) return true;
    const refresh = input.buildCriterionRefresh();
    if (!refresh) return true;
    input.criterionCompletion.refreshPrivateEvidence({
      proof: { compliant: true },
      allowPartialEvidence: true,
      ...(refresh.criterionChatReceipts !== undefined
        ? { receipts: refresh.criterionChatReceipts }
        : {}),
      candidate_sha: refresh.candidate_sha,
      has_mutation: false,
    });
    const evaluation = evaluateCriterionCompletionV1(request);
    const receipts = refresh.criterionChatReceipts ?? [];
    const hasGreenReceipt = receipts.length > 0 && receipts.every((r) => (r.exit_code ?? 1) === 0);
    if (evaluation.verified) return false;

    const requiredIds = new Set(
      request.contract.acceptance.filter((item) => item.required).map((item) => item.id),
    );
    const advisory = input.criterionCompletion.reportAdvisoryEvidence();
    const unsatisfiedRequired = advisory.filter(
      (row) => requiredIds.has(row.requirement_id) && row.status !== 'satisfied',
    );
    if (unsatisfiedRequired.length > 0 && (!hasGreenReceipt || refresh.has_mutation)) return true;

    const missing = evaluation.missing_requirements ?? [];
    if (missing.length === 0) {
      if (evaluation.status === 'VERIFIED') return false;
      if (!refresh.has_mutation && hasGreenReceipt) return false;
      return true;
    }
    const missingItems = missing
      .map((id) => request.contract.acceptance.find((entry) => entry.id === id))
      .filter((item): item is NonNullable<typeof item> => Boolean(item?.required));
    if (missingItems.length === 0) return false;
    if (hasGreenReceipt && !refresh.has_mutation) return false;
    return true;
  } catch {
    return true;
  }
}
