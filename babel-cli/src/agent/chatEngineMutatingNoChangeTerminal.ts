/**
 * Mutating / hybrid inspection-only terminal authority. Extracted from ChatEngine
 * to keep chatEngine.ts under the architecture line budget.
 */
import {
  evaluateCriterionCompletionV1,
  type CriterionCompletionRequestV1,
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
    if (input.effectiveOperation === 'HYBRID') {
      return true;
    }
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
    if (evaluation.verified) return false;
    if (inspectionContradictsFrozenBehavioralGoals(request, input.toolCallLog)) {
      return true;
    }
    const missing = evaluation.missing_requirements ?? [];
    if (missing.length === 0) return evaluation.status !== 'VERIFIED';
    const missingItems = missing
      .map((id) => request.contract.acceptance.find((entry) => entry.id === id))
      .filter((item): item is NonNullable<typeof item> => Boolean(item?.required));
    if (missingItems.length === 0) return false;
    const meaningOnly = missingItems.every(
      (item) => item.verification.verifier_id.startsWith('meaning:'),
    );
    const hasExecutableFrozenChecks = request.contract.acceptance.some(
      (item) => item.required && !item.verification.verifier_id.startsWith('meaning:'),
    );
    const allowsInspectionOnlyMeaningSatisfaction =
      meaningOnly
      && !hasExecutableFrozenChecks
      && hasInspectedNoChangeEvidence(input.toolCallLog)
      && !missingItems.some((item) => /\bvalue\s*(?:is|=)\s*\d+\b/i.test(item.description));
    if (allowsInspectionOnlyMeaningSatisfaction) {
      return false;
    }
    return true;
  } catch {
    return true;
  }
}

function inspectionContradictsFrozenBehavioralGoals(
  request: CriterionCompletionRequestV1,
  log: GateToolLogEntry[],
): boolean {
  const readDetails = log
    .filter((entry) => entry.tool === 'read_file' && !entry.error && (entry.exit_code === undefined || entry.exit_code === 0))
    .map((entry) => entry.detail ?? '')
    .filter((detail) => detail.trim().length > 0);
  if (readDetails.length === 0) return false;
  const corpus = readDetails.join('\n');
  for (const item of request.contract.acceptance) {
    if (!item.required || !item.verification.verifier_id.startsWith('meaning:')) continue;
    const goalNumber = item.description.match(/\bvalue\s*(?:is|=)\s*(\d+)\b/i)?.[1];
    if (!goalNumber) continue;
    const observed = corpus.match(/\bvalue\s*=\s*(\d+)\b/gi) ?? [];
    if (
      observed.some((match) => {
        const actual = match.match(/(\d+)/)?.[1];
        return actual !== undefined && actual !== goalNumber;
      })
    ) {
      return true;
    }
  }
  return false;
}
