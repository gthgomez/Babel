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
import type { BoundChatVerifierReceipt } from '../evidence/chatRevisionBinding.js';
import type { AcceptanceRequirementV1 } from './taskContract.js';
import { commandsMatchForExecutableBinding } from './taskAcceptanceExecutableBinding.js';

function normalizeCommandToken(command: string): string {
  return command.trim().replace(/\s+/g, ' ');
}

function commandHintFromDescription(description: string): string | null {
  const match = description.match(/`([^`]+)`\s+must\s+pass/i);
  return match?.[1] ? normalizeCommandToken(match[1]) : null;
}

function declaredAcceptanceCommand(item: AcceptanceRequirementV1): string | null {
  const verification = item.verification;
  if (!verification) return null;
  if (verification.executable_id === 'npm') {
    const argv = verification.argv ?? [];
    if (argv.length === 1 && argv[0] === 'test') return 'npm test';
    if (argv.length >= 2 && argv[0] === 'run') return normalizeCommandToken(`npm run ${argv[1]}`);
    return 'npm test';
  }
  if (Array.isArray(verification.argv) && verification.argv.length > 0) {
    return normalizeCommandToken(verification.argv.join(' '));
  }
  return commandHintFromDescription(item.description);
}

function isMeaningBoundAcceptance(item: AcceptanceRequirementV1): boolean {
  if (commandHintFromDescription(item.description)) return false;
  return item.verification_strategy === 'meaning'
    || (item.type === 'custom' && item.verification?.kind === 'custom');
}

function isCommandBoundAcceptance(item: AcceptanceRequirementV1): boolean {
  return !isMeaningBoundAcceptance(item)
    && (item.verification?.kind === 'command'
      || item.verification?.kind === 'unit_test'
      || item.type === 'unit_test'
      || item.type === 'integration_test'
      || commandHintFromDescription(item.description) !== null
      || declaredAcceptanceCommand(item) !== null);
}

/** Canonical executed-command identity — no substring or prefix weakening. */
function executedCommandMatchesDeclared(declared: string, observed: string): boolean {
  return commandsMatchForExecutableBinding(declared, observed);
}

function toolCallCoversAcceptanceItem(entry: GateToolLogEntry, item: AcceptanceRequirementV1): boolean {
  if (entry.tool !== 'run_command' && entry.tool !== 'test_run') return false;
  if ((entry.exit_code ?? 1) !== 0) return false;
  if (entry.effect_status === 'indeterminate') return false;
  const declared = declaredAcceptanceCommand(item);
  if (!declared) return false;
  return executedCommandMatchesDeclared(declared, normalizeCommandToken(entry.target));
}

function receiptCoversAcceptanceItem(
  receipt: BoundChatVerifierReceipt,
  item: AcceptanceRequirementV1,
): boolean {
  const exit = receipt.exit_code ?? receipt.exitCode ?? 1;
  if (exit !== 0 || receipt.stale) return false;
  const declared = declaredAcceptanceCommand(item);
  if (declared && executedCommandMatchesDeclared(declared, normalizeCommandToken(receipt.command))) {
    return true;
  }
  const boundVerifier = item.verification?.verifier_id;
  const receiptVerifier = receipt.verifierId ?? receipt.verifier_id;
  return Boolean(boundVerifier && receiptVerifier && boundVerifier === receiptVerifier);
}

function evidenceCoversAcceptanceItem(
  item: AcceptanceRequirementV1,
  receipts: readonly BoundChatVerifierReceipt[],
  toolCallLog: readonly GateToolLogEntry[],
): boolean {
  return receipts.some((receipt) => receiptCoversAcceptanceItem(receipt, item))
    || toolCallLog.some((entry) => toolCallCoversAcceptanceItem(entry, item));
}

function requiredCriterionStillOpen(input: {
  request: CriterionCompletionRequestV1;
  item: AcceptanceRequirementV1;
  missingRequired: readonly string[];
  unsatisfiedRequired: readonly { requirement_id: string; status: string }[];
  receipts: readonly BoundChatVerifierReceipt[];
  toolCallLog: readonly GateToolLogEntry[];
}): boolean {
  const advisoryOpen = input.unsatisfiedRequired.some(
    (row) => row.requirement_id === input.item.id && row.status !== 'satisfied',
  );
  const listedMissing = input.missingRequired.includes(input.item.id);

  if (isMeaningBoundAcceptance(input.item)) {
    if (advisoryOpen || listedMissing) return true;
    return false;
  }

  if (isCommandBoundAcceptance(input.item)) {
    if (!(advisoryOpen || listedMissing)) return false;
    return !evidenceCoversAcceptanceItem(input.item, input.receipts, input.toolCallLog);
  }

  return advisoryOpen || listedMissing;
}

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
    if (evaluation.verified || evaluation.status === 'VERIFIED') return false;

    const receipts = (refresh.criterionChatReceipts ?? []) as BoundChatVerifierReceipt[];
    const requiredItems = request.contract.acceptance.filter((item) => item.required);
    const requiredIds = new Set(requiredItems.map((item) => item.id));
    const advisory = input.criterionCompletion.reportAdvisoryEvidence();
    const unsatisfiedRequired = advisory.filter(
      (row) => requiredIds.has(row.requirement_id) && row.status !== 'satisfied',
    );
    const missingRequired = (evaluation.missing_requirements ?? []).filter((id) => requiredIds.has(id));

    const anyStillOpen = requiredItems.some((item) => requiredCriterionStillOpen({
      request,
      item,
      missingRequired,
      unsatisfiedRequired,
      receipts,
      toolCallLog: input.toolCallLog,
    }));

    if (!refresh.has_mutation && !anyStillOpen) return false;
    return true;
  } catch (error) {
    if (process.env['BABEL_MUTATING_NOCHANGE_DEBUG'] === '1') {
      console.error('[mutatingInspectionLeavesRequiredCriteriaUnmet]', error);
    }
    return true;
  }
}
