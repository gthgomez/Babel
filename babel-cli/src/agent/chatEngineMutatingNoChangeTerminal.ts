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
import { canonicalJson } from '../acceptance/canonical.js';
import { parseCommandArgv } from '../utils/commandArgv.js';
import {
  canonicalCommandFromFrozenVerification,
  commandsMatchForExecutableBinding,
} from './taskAcceptanceExecutableBinding.js';

/** Trim framing whitespace only — never collapse spaces inside quoted argv. */
function trimCommandForComparison(command: string): string {
  return command.trim();
}

function commandHintFromDescription(description: string): string | null {
  const match = description.match(/`([^`]+)`\s+must\s+pass/i);
  return match?.[1] ? trimCommandForComparison(match[1]) : null;
}

function declaredAcceptanceCommand(item: AcceptanceRequirementV1): string | null {
  const verification = item.verification;
  if (!verification) return null;
  const fromFrozen = canonicalCommandFromFrozenVerification(verification);
  if (fromFrozen) return fromFrozen;
  return commandHintFromDescription(item.description);
}

function frozenReceiptArgvExpected(
  verification: AcceptanceRequirementV1['verification'],
): string[] | null {
  if (!verification?.executable_id || !verification.argv?.length) return null;
  return [verification.executable_id, ...verification.argv];
}

function receiptStructuredArgvConsistent(receipt: BoundChatVerifierReceipt): boolean {
  if (!receipt.argv?.length) return true;
  try {
    return canonicalJson(parseCommandArgv(trimCommandForComparison(receipt.command)))
      === canonicalJson(receipt.argv);
  } catch {
    return false;
  }
}

const MEANING_INSPECTION_FILE_RE =
  /\b([\w./-]+\.(?:txt|ts|tsx|js|mjs|cjs|json|csv|md|ya?ml))\b/i;

/** Conservative: a grounded read of the task-named file shows the "so …" / "include …" clause. */
function inspectionSubstantiatesMeaningCriterion(
  item: AcceptanceRequirementV1,
  toolCallLog: readonly GateToolLogEntry[],
): boolean {
  const description = item.description.trim();
  const fileMatch = description.match(MEANING_INSPECTION_FILE_RE);
  if (!fileMatch?.[1]) return false;
  const file = fileMatch[1];
  const read = toolCallLog.find((entry) => (
    (entry.tool === 'read_file' || entry.tool === 'read_range')
    && (entry.exit_code ?? 1) === 0
    && !entry.error
    && (Boolean(entry.detail?.trim()) || Boolean(entry.stdout?.trim()))
    && (entry.target === file || entry.target?.replace(/\\/g, '/').endsWith(`/${file}`))
  ));
  if (!read) return false;
  const rawContent = (
    typeof read.stdout === 'string' && read.stdout.trim().length > 0
      ? read.stdout
      : read.detail
  );
  if (!rawContent?.trim()) return false;
  const detail = rawContent.toLowerCase();
  const soMatch = description.match(/\bso\s+(.+?)(?:\.|$)/is);
  if (soMatch?.[1]) {
    const tokens = soMatch[1].toLowerCase().split(/[^a-z0-9_=]+/).filter((t) => t.length >= 3);
    return tokens.length > 0 && tokens.every((token) => detail.includes(token));
  }
  const includeMatch = description.match(/\binclude\s+(.+?)(?:\.|$)/is);
  if (includeMatch?.[1]) {
    const tokens = includeMatch[1].toLowerCase().split(/[^a-z0-9_=]+/).filter((t) => t.length >= 3);
    return tokens.length > 0 && tokens.every((token) => detail.includes(token));
  }
  return false;
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
  return executedCommandMatchesDeclared(declared, trimCommandForComparison(entry.target));
}

function receiptCoversAcceptanceItem(
  receipt: BoundChatVerifierReceipt,
  item: AcceptanceRequirementV1,
): boolean {
  const exit = receipt.exit_code ?? receipt.exitCode ?? 1;
  if (exit !== 0 || receipt.stale) return false;

  if (!isCommandBoundAcceptance(item)) {
    const boundVerifier = item.verification?.verifier_id;
    const receiptVerifier = receipt.verifierId ?? receipt.verifier_id;
    return Boolean(boundVerifier && receiptVerifier && boundVerifier === receiptVerifier);
  }

  const declared = declaredAcceptanceCommand(item);
  if (!declared) return false;
  const observed = trimCommandForComparison(receipt.command);
  if (!executedCommandMatchesDeclared(declared, observed)) return false;

  const expectedArgv = frozenReceiptArgvExpected(item.verification);
  if (expectedArgv) {
    if (receipt.argv && canonicalJson(receipt.argv) !== canonicalJson(expectedArgv)) return false;
    if (!receiptStructuredArgvConsistent(receipt)) return false;
  }

  return true;
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
    if (!(advisoryOpen || listedMissing)) return false;
    if (inspectionSubstantiatesMeaningCriterion(input.item, input.toolCallLog)) return false;
    return true;
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
